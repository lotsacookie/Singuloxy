import * as network from "../network.mjs";
import { convert_url } from "../context.mjs";

const url_regex = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s'"]*))\s*\)/gi;

const import_regex = /@import\s+(?:url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s'"]*))\s*\)|"([^"]*)"|'([^']*)')\s*([^;{}]*);?/gi;

const MAX_IMPORT_DEPTH = 5;

function should_skip(url) {
  if (!url) return true;
  return /^(data:|blob:|about:|#)/i.test(url);
}

function is_legacy_font(url) {
  return /\.eot(?:[?#]|$)/i.test(url);
}

async function fetch_ok(absolute_url) {
  try {
    let response = await network.fetch(absolute_url);
    if (response.ok === false) return null;
    return response;
  }
  catch (e) {
    console.error("sandstone: css fetch failed", absolute_url, e);
    return null;
  }
}

async function inline_imports(css_str, css_url, depth) {
  let matches = [...css_str.matchAll(import_regex)];
  if (!matches.length) return css_str;

  let blob_urls = await Promise.all(matches.map(async (m) => {
    let url = (m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5] ?? "").trim();
    if (should_skip(url)) return null;

    let absolute_url = convert_url(url, css_url);
    let response = await fetch_ok(absolute_url);
    if (!response) return null;

    let text = await response.text();
    let inner = await parse_css(text, response.url || absolute_url, depth + 1);
    let blob = new Blob([inner], {type: "text/css"});
    return network.create_blob_url(blob, absolute_url);
  }));

  let i = 0;
  return css_str.replace(import_regex, (match, ...groups) => {
    let blob_url = blob_urls[i++];
    if (!blob_url) return match;
    let tail = (groups[5] || "").trim();
    return `@import url("${blob_url}")${tail ? " " + tail : ""};`;
  });
}

async function replace_urls(css_str, css_url) {
  let matches = [...css_str.matchAll(url_regex)];
  if (!matches.length) return css_str;

  let requests = new Map();
  for (let m of matches) {
    let url = (m[1] ?? m[2] ?? m[3] ?? "").trim();
    if (should_skip(url) || is_legacy_font(url) || requests.has(url)) continue;

    requests.set(url, (async () => {
      let absolute_url = convert_url(url, css_url).split("#")[0];
      let response = await fetch_ok(absolute_url);
      if (!response) return null;
      return network.create_blob_url(await response.blob(), absolute_url);
    })());
  }
  if (!requests.size) return css_str;

  let keys = [...requests.keys()];
  let values = await Promise.all(requests.values());
  let blob_map = new Map(keys.map((key, i) => [key, values[i]]));

  return css_str.replace(url_regex, (match, a, b, c) => {
    let url = (a ?? b ?? c ?? "").trim();
    let blob_url = blob_map.get(url);
    return blob_url ? `url("${blob_url}")` : match;
  });
}

export function parse_css(css_str, css_url, depth = 0) {
  let has_import = /@import/i.test(css_str);
  let has_url = /url\(/i.test(css_str);
  if (!has_import && !has_url) return css_str;

  return (async () => {
    let result = css_str;
    if (has_import && depth < MAX_IMPORT_DEPTH) {
      result = await inline_imports(result, css_url, depth);
    }
    return await replace_urls(result, css_url);
  })();
}

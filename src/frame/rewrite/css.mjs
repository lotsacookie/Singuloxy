import * as network from "../network.mjs";
import { convert_url } from "../context.mjs";

const url_regex = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s'"]*))\s*\)/gi;

const import_regex = /@import\s+(?:url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s'"]*))\s*\)|"([^"]*)"|'([^']*)')\s*([^;{}]*);?/gi;

const MAX_IMPORT_DEPTH = 5;
const ASSET_TIMEOUT_MS = 20 * 1000;
const BODY_TIMEOUT_MS = 60 * 1000;

function should_skip(url) {
  if (!url) return true;
  return /^(data:|blob:|about:|#)/i.test(url);
}

function is_legacy_font(url) {
  return /\.eot(?:[?#]|$)/i.test(url);
}

function safe_absolute(url, base) {
  try {
    return convert_url(url, base);
  }
  catch {
    return url;
  }
}

export function with_deadline(promise, ms) {
  let timer;
  let deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("timed out after " + ms + "ms")), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

async function cancel_body(response) {
  try {
    await response?.body?.cancel();
  }
  catch {}
}

async function fetch_ok(absolute_url) {
  let response = null;
  try {
    response = await with_deadline(network.fetch(absolute_url), ASSET_TIMEOUT_MS);
    if (response.ok === false) {
      await cancel_body(response);
      return null;
    }
    return response;
  }
  catch (e) {
    console.error("sandstone: css fetch failed", absolute_url, e);
    await cancel_body(response);
    return null;
  }
}

async function inline_imports(css_str, css_url, depth) {
  let matches = [...css_str.matchAll(import_regex)];
  if (!matches.length) return css_str;

  let results = await Promise.all(matches.map(async (m) => {
    let url = (m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5] ?? "").trim();
    if (should_skip(url)) return null;

    let absolute_url = safe_absolute(url, css_url);
    let response = await fetch_ok(absolute_url);
    if (!response) return {blob_url: null, absolute_url: absolute_url};

    try {
      let text = await with_deadline(response.text(), BODY_TIMEOUT_MS);
      let inner = await parse_css(text, response.url || absolute_url, depth + 1);
      let blob = new Blob([inner], {type: "text/css"});
      return {blob_url: network.create_blob_url(blob, absolute_url), absolute_url: absolute_url};
    }
    catch (e) {
      console.error("sandstone: css import failed", absolute_url, e);
      await cancel_body(response);
      return {blob_url: null, absolute_url: absolute_url};
    }
  }));

  let i = 0;
  return css_str.replace(import_regex, (match, ...groups) => {
    let result = results[i++];
    if (!result) return match;
    let tail = (groups[5] || "").trim();
    let target = result.blob_url || result.absolute_url;
    return `@import url("${target}")${tail ? " " + tail : ""};`;
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
      let absolute_url = safe_absolute(url, css_url);
      let fetch_url = absolute_url.split("#")[0];
      let response = await fetch_ok(fetch_url);
      if (!response) return absolute_url;
      try {
        let blob = await with_deadline(response.blob(), BODY_TIMEOUT_MS);
        return network.create_blob_url(blob, fetch_url);
      }
      catch (e) {
        console.error("sandstone: css asset download failed", fetch_url, e);
        await cancel_body(response);
        return absolute_url;
      }
    })());
  }
  if (!requests.size) return css_str;

  let keys = [...requests.keys()];
  let values = await Promise.all(requests.values());
  let blob_map = new Map(keys.map((key, i) => [key, values[i]]));

  return css_str.replace(url_regex, (match, a, b, c) => {
    let url = (a ?? b ?? c ?? "").trim();
    let replacement = blob_map.get(url);
    return replacement ? `url("${replacement}")` : match;
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

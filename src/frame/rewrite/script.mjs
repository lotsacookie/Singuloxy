import * as network from "../network.mjs";
import * as loader from "../loader.mjs";
import * as parser from "../parser.mjs";

import { ctx, convert_url, intercept_property } from "../context.mjs";

export const pending_scripts = [];
let script_num = 0;

const javascript_types = new Set([
  "",
  "application/javascript",
  "text/javascript",
  "application/x-javascript",
  "text/x-javascript",
  "application/ecmascript",
  "text/ecmascript",
  "text/jscript",
  "text/livescript"
]);

export function should_load(element) {
  if (!loader.site_settings.allow_js)
    return false;
  let type = (element.getAttribute("type") || "").split(";")[0].trim().toLowerCase();
  return javascript_types.has(type);
}

export async function rewrite_script(script_element) {
  if (!should_load(script_element)) {
    return;
  }
  let num = script_num ++;

  let script_text = script_element.textContent; 
  let script_url = script_element.getAttribute("src") || "";
  intercept_property(script_element, "src", {
    get: () => {
      if (!script_url) return "";
      try {
        return convert_url(script_url, ctx.location.href);
      }
      catch {
        return script_url;
      }
    },
    set: async (value) => {
      script_url = value;
      await download_src();
    }
  });
  script_element.removeAttribute("src");

  async function download_src() {
    script_element.setAttribute("__src", script_url);
    let src_url = convert_url(script_url, ctx.location.href);
    try {
      let response = await network.fetch(src_url);
      if (response.ok === false) {
        throw new Error("status " + response.status);
      }
      script_text = await response.text();
    }
    catch (e) {
      console.error("sandstone: failed to load script", src_url, e);
      script_text = "";
      script_element.dispatchEvent(new Event("error"));
      return;
    }

    if (loader.is_loaded) {
      run_script();
    }
  }

  function run_script() {
    let rewritten_js = parser.rewrite_js(script_text);
    script_element.innerHTML = rewritten_js;
    script_element.dispatchEvent(new Event("load"));
  }

  if (script_url) {
    await download_src();
  }
  if (!script_text)
    return;

  if (!loader.is_loaded) {
    pending_scripts.push([num, script_element, script_text]);
  }
}

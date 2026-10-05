import * as network from "../network.mjs";
import * as loader from "../loader.mjs";
import * as parser from "../parser.mjs";

import { ctx, convert_url, intercept_property, proxy_function } from "../context.mjs";

export const pending_scripts = [];

export const script_state = { phase: "parsing" };

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

export function execute_script(script_element, script_text) {
  let previous = ctx.document.currentScript;
  ctx.document.currentScript = script_element;
  let script = document.createElement("script");
  script.__rewritten__ = true;
  try {
    script.textContent = parser.rewrite_js(script_text);
    (document.body || document.documentElement).append(script);
  }
  catch (e) {
    console.error("sandstone: script execution failed", e);
  }
  script.remove();
  ctx.document.currentScript = previous;
}

export async function rewrite_script(script_element) {
  if (!should_load(script_element)) {
    return;
  }
  let num = script_num ++;
  let is_dynamic = script_state.phase !== "parsing";

  let script_text = script_element.textContent; 
  let script_url = script_element.getAttribute("src") || "";
  let has_src = script_url !== "";

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
      if (await download_src()) {
        execute_script(script_element, script_text);
        script_element.dispatchEvent(new Event("load"));
      }
    }
  });
  script_element.removeAttribute("src");

  if (has_src) {
    proxy_function(script_element, "getAttribute", (target, this_arg, args) => {
      if (script_url && typeof args[0] === "string" && args[0].toLowerCase() === "src")
        return script_url;
      return Reflect.apply(target, this_arg, args);
    });
  }

  async function download_src() {
    script_element.setAttribute("__src", script_url);
    let src_url = convert_url(script_url, ctx.location.href);
    try {
      let response = await network.fetch(src_url);
      if (response.ok === false) {
        throw new Error("status " + response.status);
      }
      script_text = await response.text();
      return true;
    }
    catch (e) {
      console.error("sandstone: failed to load script", src_url, e);
      script_text = "";
      script_element.dispatchEvent(new Event("error"));
      return false;
    }
  }

  if (!has_src) {
    if (script_text && !is_dynamic)
      pending_scripts.push([num, script_element, script_text]);
    return;
  }

  if (!(await download_src()))
    return;

  if (is_dynamic) {
    execute_script(script_element, script_text);
    script_element.dispatchEvent(new Event("load"));
  }
  else if (script_text) {
    pending_scripts.push([num, script_element, script_text]);
  }
}

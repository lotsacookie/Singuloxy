import * as network from "../network.mjs";
import * as loader from "../loader.mjs";
import * as parser from "../parser.mjs";

import { ctx, convert_url, intercept_property, proxy_function } from "../context.mjs";

export const pending_scripts = [];

export const script_state = { phase: "parsing" };

const SCRIPT_DOWNLOAD_ATTEMPTS = 3;
const SIZE_TOLERANCE_BYTES = 3;
const GARBLED_SAMPLE_CHARS = 2000;
const GARBLED_RATIO = 0.02;

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
    let label = script_element.getAttribute("__src") || "";
    script.textContent = parser.rewrite_js(script_text, false, label);
    (document.body || document.documentElement).append(script);
  }
  catch (e) {
    console.error("sandstone: script execution failed", e);
  }
  script.remove();
  ctx.document.currentScript = previous;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function looks_garbled(text) {
  let sample = text.length > GARBLED_SAMPLE_CHARS ? text.slice(0, GARBLED_SAMPLE_CHARS) : text;
  if (sample.length === 0) return false;
  let bad = 0;
  for (let i = 0; i < sample.length; i++) {
    let code = sample.charCodeAt(i);
    if (code === 0xFFFD || (code < 32 && code !== 9 && code !== 10 && code !== 13)) bad++;
  }
  return bad / sample.length > GARBLED_RATIO;
}

function size_problem(response, text) {
  let encoding = (response.headers?.get("content-encoding") || "").toLowerCase();
  if (encoding !== "" && encoding !== "identity") return null;
  let expected = Number(response.headers?.get("content-length"));
  if (!Number.isFinite(expected) || expected <= 0) return null;
  let actual = new TextEncoder().encode(text).length;
  if (Math.abs(actual - expected) <= SIZE_TOLERANCE_BYTES) return null;
  return `size mismatch: server said ${expected} bytes, received ${actual}`;
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
    let last_error = null;

    for (let attempt = 1; attempt <= SCRIPT_DOWNLOAD_ATTEMPTS; attempt++) {
      let final_attempt = attempt === SCRIPT_DOWNLOAD_ATTEMPTS;
      try {
        let response = await network.fetch(src_url);
        if (response.ok === false) {
          last_error = new Error("status " + response.status);
          break;
        }
        let text = await response.text();
        let garbled = looks_garbled(text);
        let problem = garbled ? "response does not look like JavaScript text" : size_problem(response, text);
        if (problem && !final_attempt) {
          console.warn(`sandstone: script download looks wrong (${problem}), retrying (${attempt}/${SCRIPT_DOWNLOAD_ATTEMPTS - 1}):`, src_url);
          last_error = new Error(problem);
          await sleep(300 * attempt);
          continue;
        }
        if (problem && garbled) {
          last_error = new Error(problem);
          break;
        }
        if (problem) {
          console.warn(`sandstone: script download still looks wrong (${problem}), using it anyway:`, src_url);
        }
        script_text = text;
        return true;
      }
      catch (e) {
        last_error = e;
        if (!final_attempt) await sleep(300 * attempt);
      }
    }

    console.error("sandstone: failed to load script", src_url, last_error);
    script_text = "";
    script_element.dispatchEvent(new Event("error"));
    return false;
  }

  if (!has_src) {
    if (!script_text) return;
    if (!is_dynamic) {
      pending_scripts.push([num, script_element, script_text]);
      return;
    }
    script_element.textContent = parser.rewrite_js(script_text, false, "(dynamic inline script)");
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

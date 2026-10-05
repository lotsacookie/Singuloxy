import * as rpc from "../rpc.mjs";
import * as rewrite from "./rewrite/index.mjs";
import * as network from "./network.mjs";
import * as parser from "./parser.mjs";

import { update_ctx, run_script, run_script_safe, ctx, convert_url, get_cookie_jar } from "./context.mjs";
import { pending_scripts } from "./rewrite/script.mjs";
import { pending_modules } from "./rewrite/module.mjs";
import { install_form_handler } from "./rewrite/form.mjs";

export const navigate = rpc.create_rpc_wrapper(rpc.host, "navigate");
export const local_storage = rpc.create_rpc_wrapper(rpc.host, "local_storage");
export const cookies = rpc.create_rpc_wrapper(rpc.host, "cookies");

export const runtime_src = self.document?.currentScript?.innerHTML;
export let url;
export let frame_id;
export let frame_html;
export let version;
export let is_loaded = false;
export let is_iframe = false;
export let site_settings = {};
export let default_settings = {};

const MODULE_TIMEOUT_MS = 15000;

function eval_script(script_element, script_text) {
  ctx.document.currentScript = script_element;
  let script = document.createElement("script");
  script.__rewritten__ = true;
  try {
    let rewritten_js = parser.rewrite_js(script_text);
    script.innerHTML = rewritten_js;
    document.body.append(script);
  }
  catch (e) {
    console.error(e);
  }
  script.remove();
  ctx.document.currentScript = null;
  script_element.dispatchEvent(new Event("load"));
}

function evaluate_scripts() {
  pending_scripts.sort((a, b) => a[0] - b[0]);
  let deferred = [];
  for (let [num, script_element, script_text] of pending_scripts) {
    if (script_element.defer || script_element.async) {
      deferred.push([script_element, script_text])
    }
    else {
      eval_script(script_element, script_text);
    }
  }
  pending_scripts.length = 0;

  for (let [script_element, script_text] of deferred) {
    eval_script(script_element, script_text);
  }
}

function eval_module(script_element, blob_url) {
  return new Promise((resolve) => {
    let script = document.createElement("script");
    script.__rewritten__ = true;
    script.type = "module";
    let done = false;
    let finish = (event_name) => {
      if (done) return;
      done = true;
      script.remove();
      script_element.dispatchEvent(new Event(event_name));
      resolve();
    };
    script.addEventListener("load", () => finish("load"));
    script.addEventListener("error", () => finish("error"));
    setTimeout(() => finish("error"), MODULE_TIMEOUT_MS);
    script.src = blob_url;
    document.body.append(script);
  });
}

async function evaluate_modules() {
  pending_modules.sort((a, b) => a[0] - b[0]);
  let modules = [...pending_modules];
  pending_modules.length = 0;
  for (let [order, script_element, blob_url] of modules) {
    await eval_module(script_element, blob_url);
  }
}

export function set_frame_id(id) {
  frame_id = id;
}
export function set_url(_url) {
  url = _url;
}

function get_frame_html() {
  let html = document.documentElement.outerHTML;
  let doctype = new XMLSerializer().serializeToString(document.doctype);
  frame_html = doctype + html;
}

function handle_click(event) {
  if (event.defaultPrevented) return;

  let element = event.target;
  while (element && !(element instanceof HTMLAnchorElement)) {
    element = element.parentElement;
  }
  if (!element || !element.hasAttribute("href")) return;

  let href = element.getAttribute("href").trim();

  if (href.toLowerCase().startsWith("javascript:")) {
    event.preventDefault();
    event.stopImmediatePropagation();
    let original_js = href.substring("javascript:".length);
    try {
      original_js = decodeURIComponent(original_js);
    }
    catch {}
    run_script_safe(original_js);
    return;
  }

  let current_url;
  let target_url;
  try {
    current_url = new URL(ctx.location.href);
    if (href.startsWith("#"))
      target_url = new URL(href, current_url);
    else if (/^https?:/i.test(element.href))
      target_url = new URL(element.href);
    else
      target_url = new URL(href, current_url);
  }
  catch {
    return;
  }

  if (target_url.protocol !== "http:" && target_url.protocol !== "https:") return;

  event.preventDefault();
  event.stopImmediatePropagation();

  let same_document = (
    target_url.origin === current_url.origin &&
    target_url.pathname === current_url.pathname &&
    target_url.search === current_url.search
  );

  if (same_document && href.includes("#")) {
    if (target_url.hash === "" || target_url.hash === "#")
      window.scrollTo(0, 0);
    ctx.location.assign(target_url.href);
    return;
  }

  navigate(frame_id, target_url.href);
}

function install_click_handler() {
  globalThis.addEventListener("click", handle_click);
}

async function load_html(options) {
  version = options.version;
  is_iframe = options.is_iframe || false;
  default_settings = options.default_settings;
  site_settings = {...default_settings, ...options.settings};
  network.known_urls[location.href] = options.url;
  network.enable_network();

  set_url(options.url);
  set_frame_id(options.frame_id);
  get_frame_html();
  update_ctx();

  globalThis.__dynamic_import__ = rewrite.module_dynamic_import;

  if (options.error) {
    document.getElementById("loading_text").style.display = "none";
    document.getElementById("error_div").style.display = "initial";
    document.getElementById("error_msg").innerText = options.error;
    document.getElementById("version_text").innerText = `Sandstone v${version.ver} (${version.hash})`;
    return;
  }

  if (options.local_storage) {
    for (let [key, value] of options.local_storage) {
      ctx.localStorage.setItem(key, value);
    }
  }

  if (options.cookies) {
    get_cookie_jar().load(options.cookies);
  }

  let parser = new DOMParser();
  let html = parser.parseFromString(options.html, "text/html");  
  
  await rewrite.element(html.documentElement);

  let id_elements = html.querySelectorAll("*[id]");
  let ctx_proto = Object.getPrototypeOf(ctx);
  for (let i = 0; i < id_elements.length; i++) {
    let element = id_elements[i];
    if (ctx_proto.hasOwnProperty(element.id)) continue;
    ctx[element.id] = element;
  }

  console.log("done downloading page");
  document.documentElement.replaceWith(html.documentElement);
  if (site_settings.allow_js) {
    evaluate_scripts();
    await evaluate_modules();
  }

  is_loaded = true;
  ctx.document.dispatchEvent(new Event("DOMContentLoaded"));
  ctx.document.dispatchEvent(new Event("readystatechange"));
  ctx.document.dispatchEvent(new Event("load"));
  ctx.window.dispatchEvent(new Event("load"));

  install_click_handler();
  install_form_handler();
}

async function get_favicon() {
  var favicon_url = "/favicon.ico";
  var link_elements = document.getElementsByTagName("link");
  for (var i = 0; i < link_elements.length; i++) {
    let link = link_elements[i];
    if (link.getAttribute("rel") === "icon") 
      favicon_url = link.getAttribute("href");
    if (link.getAttribute("rel") === "shortcut icon") 
      favicon_url = link.getAttribute("href");
  }

  let full_url = new URL(favicon_url, ctx.location.href);
  return full_url.href;
}

function external_eval(js) {
  return run_script(js);
}

rpc.rpc_handlers["html"] = load_html;
rpc.rpc_handlers["favicon"] = get_favicon;
rpc.rpc_handlers["eval"] = external_eval;

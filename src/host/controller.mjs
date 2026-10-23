import * as rpc from "../rpc.mjs";
import * as util from "../util.mjs";
import * as network from "./network.mjs";

import { version } from "./index.mjs";

import { libcurl } from "libcurl.js/bundled";

//frame_js is a string, which is imported using webpack
import frame_js from "../../dist/sandstone_frame.js";

const frame_urls = {};

const LOGO_SVG = `<svg class="ld-logo" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><defs><g id="ld-arm" fill="none" stroke-linecap="butt" stroke-linejoin="miter" stroke-miterlimit="10"><path pathLength="1" d="M50 3 L83 13 L92 43 L75 69 L49 73 L35 57" stroke-width="5.5"/><path pathLength="1" d="M50 13 L76 22 L82 44 L70 62 L52 65" stroke-width="2.2" opacity="0.7"/></g></defs><g class="ld-arms" stroke="currentColor"><use href="#ld-arm"/><use href="#ld-arm" transform="rotate(120 50 50)"/><use href="#ld-arm" transform="rotate(240 50 50)"/></g><g class="ld-core" fill="currentColor"><path d="M50.0 29.0 L51.7 45.8 L58.5 41.5 L54.2 48.3 L71.0 50.0 L54.2 51.7 L58.5 58.5 L51.7 54.2 L50.0 71.0 L48.3 54.2 L41.5 58.5 L45.8 51.7 L29.0 50.0 L45.8 48.3 L41.5 41.5 L48.3 45.8 Z"/></g></svg>`;

function safe_css(value, fallback) {
  if (typeof value !== "string") return fallback;
  value = value.trim();
  if (!value || value.length > 120 || !/^[#a-zA-Z0-9(),.%\/ -]+$/.test(value)) return fallback;
  return value;
}

function build_frame_html(theme) {
  let bg = safe_css(theme?.bg, "#000000");
  let text = safe_css(theme?.text, "#ffffff");
  return `
  <!DOCTYPE html>
  <head>
    <meta charset="utf-8">
    <script>${frame_js}</script>
    <style>
      :root {
        --bg-color: ${bg};
        --text-color: ${text};
      }
      html {
        background-color: ${bg};
        font-family: sans-serif;
      }
      * {
        color: ${text};
      }
      body {
        margin: 0;
      }
      #loading_text {
        position: fixed;
        inset: 0;
        display: flex;
        flex-direction: column;
        justify-content: center;
        align-items: center;
        gap: 1.1rem;
        margin: 0;
      }
      .ld-logo {
        width: 5.5rem;
        height: 5.5rem;
        overflow: visible;
        filter: drop-shadow(0 0 8px color-mix(in srgb, ${text} 50%, transparent));
      }
      .ld-arms {
        opacity: .8;
        transform-origin: 50px 50px;
        stroke-dasharray: 1;
        animation: ld-draw 1.2s cubic-bezier(.3,.7,.2,1) both, ld-spin 14s linear 1.2s infinite;
      }
      .ld-core {
        transform-origin: 50px 50px;
        animation: ld-pulse 2.8s ease-in-out infinite;
      }
      .ld-word {
        font-size: 1.15rem;
        font-weight: 900;
        letter-spacing: .06em;
      }
      .ld-bar {
        width: min(200px, 60vw);
        height: 3px;
        border-radius: 3px;
        overflow: hidden;
        background: color-mix(in srgb, ${text} 14%, transparent);
      }
      .ld-fill {
        position: relative;
        width: 100%;
        height: 100%;
        background: ${text};
        transform-origin: left;
        animation: ld-grow 8s cubic-bezier(.22,1,.36,1) forwards;
        transform: scaleX(0);
      }
      .ld-fill::after {
        content: "";
        position: absolute;
        inset: 0;
        background: linear-gradient(90deg, transparent, color-mix(in srgb, ${bg} 55%, transparent), transparent);
        animation: ld-sheen 1.5s ease-in-out infinite;
      }
      @keyframes ld-draw { from { stroke-dashoffset: 1 } to { stroke-dashoffset: 0 } }
      @keyframes ld-spin { to { transform: rotate(360deg) } }
      @keyframes ld-pulse { 0%, 100% { transform: scale(1) } 50% { transform: scale(1.12) } }
      @keyframes ld-sheen { from { transform: translateX(-100%) } to { transform: translateX(100%) } }
      @keyframes ld-grow { from { transform: scaleX(0) } to { transform: scaleX(.92) } }
      @media (prefers-reduced-motion: reduce) {
        .ld-logo, .ld-arms, .ld-core, .ld-fill::after { animation: none }
        .ld-arms { stroke-dashoffset: 0 }
      }
      #error_div {
        display: none;
      }
      #version_text {
        font-size: 14px;
      }
    </style>
  </head>
  <body>
    <div id="loading_text">
      ${LOGO_SVG}
      <div class="ld-word">Singularity</div>
      <div class="ld-bar"><div class="ld-fill"></div></div>
    </div>

    <div id="error_div">
      <h2>An unexpected error has occurred</h2>
      <pre id="error_msg">
      </pre>
      <p><i>
        <span id="version_text"></span>
      </p></i>
    </div>
  </body>
`;
}

function get_frame_bundle(theme) {
  let key = safe_css(theme?.bg, "#000000") + "|" + safe_css(theme?.text, "#ffffff");
  if (!frame_urls[key]) {
    let frame_blob = new Blob([build_frame_html(theme)], {type: "text/html"});
    frame_urls[key] = URL.createObjectURL(frame_blob);
  }
  return frame_urls[key];
}

export const iframes = {};
export const persist_storage_key = "proxy_local_storage";
export let local_storage = {};
export const persist_cookie_key = "proxy_cookie_storage";
export let cookie_storage = {};
try {
  cookie_storage = JSON.parse(localStorage.getItem(persist_cookie_key)) || {};
}
catch {}
try {
  local_storage = JSON.parse(localStorage.getItem(persist_storage_key)) || {};
}
catch {}

function navigation_headers(target, referrer, is_post) {
  let headers = {
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
  };
  if (typeof navigator !== "undefined" && navigator.userAgent) {
    headers["User-Agent"] = navigator.userAgent;
  }
  if (!referrer) return headers;

  let from;
  try {
    from = new URL(referrer);
  }
  catch {
    return headers;
  }
  if (from.protocol !== "http:" && from.protocol !== "https:") return headers;
  if (from.protocol === "https:" && target.protocol === "http:") return headers;

  let from_origin = from.origin;
  if (from_origin === target.origin) {
    from.hash = "";
    from.username = "";
    from.password = "";
    headers["Referer"] = from.href;
  }
  else {
    headers["Referer"] = from_origin + "/";
  }
  if (is_post) headers["Origin"] = from_origin;
  return headers;
}

function extract_set_cookies(response) {
  let cookies = [];
  let raw = response?.raw_headers;
  if (!Array.isArray(raw)) return cookies;
  for (let pair of raw) {
    if (Array.isArray(pair) && String(pair[0]).toLowerCase() === "set-cookie") {
      cookies.push(String(pair[1]));
    }
  }
  return cookies;
}

export class ProxyFrame {
  constructor() {
    this.url = null;
    this.id = Math.random() + "";
    this.iframe = document.createElement("iframe");
    this.iframe.sandbox = "allow-scripts allow-forms allow-modals allow-pointer-lock";
    this.iframe.allowFullscreen = true;
    this.iframe.allow = "encrypted-media; autoplay; picture-in-picture; clipboard-write; web-share; gamepad; accelerometer; gyroscope; magnetometer";    this.iframe.setAttribute("frame-id", this.id);

    iframes[this.id] = this;
    this.rpc_target = new rpc.RPCTarget();
    this.rpc_target.onmessage = rpc.message_listener;
    this.send_page = rpc.create_rpc_wrapper(this.rpc_target, "html");
    this.get_favicon = rpc.create_rpc_wrapper(this.rpc_target, "favicon");
    this.eval_js = rpc.create_rpc_wrapper(this.rpc_target, "eval");

    this.on_navigate = () => {};
    this.on_load = () => {};
    this.on_url_change = () => {};
    this.on_info = () => {};
    this.theme = null;
    this.title = "";
    this.icon = null;
    this.icon_source = null;

    this.special_pages = {};
    this.site_settings = [];
    this.default_settings = {
      allow_js: true
    };
    this.session_storage = {};
  }

  async refresh_icon() {
    try {
      let source = await this.get_favicon();
      if (!source) return;
      if (source === this.icon_source && this.icon) return;
      let response = await network.fetch_page(source, {});
      let blob = await response.blob();
      if (!blob || !blob.size || blob.size > 512 * 1024) return;
      let data = await new Promise((resolve, reject) => {
        let reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
      if (typeof data !== "string" || !/^data:image\//i.test(data)) return;
      this.icon_source = source;
      this.icon = data;
      this.emit_info();
    }
    catch {}
  }

  emit_info() {
    try {
      this.on_info({
        url: this.url ? this.url.href : "",
        title: this.title || "",
        icon: this.icon
      });
    }
    catch {}
  }

  async wait_for_libcurl() {
    if (libcurl.ready) return;
    await libcurl.load_wasm();
  }

  async navigate_to(url, form_data=null, referrer=null) {
    await this.wait_for_libcurl();
    if (!util.is_valid_url(url)) {
      throw TypeError("Invalid URL");
    }

    console.log("navigating to", url);
    this.url = new URL(url);
    
    this.iframe.style.backgroundColor = safe_css(this.theme?.bg, "#000000");
    this.on_navigate();

    let old_ports = [this.rpc_target.target, ...this.rpc_target.extra_targets].filter(Boolean);
    network.end_streams_for(old_ports);

    this.iframe.src = get_frame_bundle(this.theme);
    network.clean_ws_connections(this.id);

    let html = null;
    let error = false;
    let set_cookies = [];

    if (typeof this.special_pages[url] === "string") {
      html = this.special_pages[url];
    }
    else {
      try {
        let options = {};
        if (form_data) {
          console.log("placing post request:", form_data);
          let body = form_data.body;

          if (form_data.enctype === "multipart/form-data" && Array.isArray(body)) {
            let rebuilt = new FormData();
            for (let [key, value] of body) rebuilt.append(key, value);
            body = rebuilt;
          }

          options = { method: "POST", body };
          if (!(body instanceof FormData)) {
            options.headers = {"Content-Type": form_data.enctype};
          }
        }
        options.headers = {
          ...navigation_headers(new URL(url), referrer, !!form_data),
          ...(options.headers || {})
        };
        let response = await network.fetch_page(url, options);
        html = await response.text();
        set_cookies = extract_set_cookies(response);
        url = response.url;
      }
      catch (e) {
        error = util.format_error(e);
      }  
    }
    this.url = new URL(url);
    
    let settings = this.site_settings.find((item) => {
      return item.hostname.test(this.url.hostname);
    }) || {};
    settings = {...this.default_settings, ...settings};
    console.log("site settings:", settings);

    await rpc.wait_on_frame(this.iframe);
    let msg_channel = new MessageChannel();
    this.rpc_target.set_target(msg_channel.port1);
    msg_channel.port1.start();
    await rpc.set_host(this.iframe, msg_channel.port2);

    try {
      await this.send_page({
        url: this.url.href,
        html: html, 
        frame_id: this.id,
        error: error,
        settings: settings,
        default_settings: this.default_settings,
        local_storage: local_storage[this.url.origin],
        session_storage: this.session_storage[this.url.origin],
        cookies: cookie_storage[this.url.origin],
        set_cookies: set_cookies,
        version: version
      });
    }
    catch (e) {
      let error_msg = util.format_error(e);
      await this.send_page({
        url: this.url.href,
        html: html, 
        frame_id: this.id,
        error: error_msg,
        settings: settings,
        default_settings: this.default_settings,
        local_storage: undefined,
        session_storage: undefined,
        cookies: undefined,
        set_cookies: undefined,
        version: version
      });
    }
    this.iframe.style.backgroundColor = "unset";
    this.on_load();
    this.emit_info();
    this.refresh_icon();
  }
}

rpc.rpc_handlers["navigate"] = async (frame_id, url, reload=true, form_data=null) => {
  let frame = iframes[frame_id];
  if (!frame) return;

  if (reload) {
    let referrer = frame.url ? frame.url.href : null;
    await frame.navigate_to(url, form_data, referrer);
  }
  else {
    frame.url = new URL(url);
    frame.on_url_change();
    frame.emit_info();
  }
}

rpc.rpc_handlers["page_info"] = async (frame_id, title) => {
  let frame = iframes[frame_id];
  if (!frame) return;
  title = typeof title === "string" ? title.slice(0, 300) : "";
  if (title === frame.title) return;
  frame.title = title;
  frame.emit_info();
}

rpc.rpc_handlers["local_storage"] = async (frame_id, entries) => {
  let frame = iframes[frame_id];
  if (!frame) return;
  local_storage[frame.url.origin] = entries;
  if (window.origin) {
    localStorage.setItem(persist_storage_key, JSON.stringify(local_storage));
  }
}

rpc.rpc_handlers["session_storage"] = async (frame_id, entries) => {
  let frame = iframes[frame_id];
  if (!frame || !frame.url) return;
  frame.session_storage[frame.url.origin] = entries;
}

rpc.rpc_handlers["cookies"] = async (frame_id, entries) => {
  let frame = iframes[frame_id];
  if (!frame) return;
  cookie_storage[frame.url.origin] = entries;
  if (window.origin) {
    localStorage.setItem(persist_cookie_key, JSON.stringify(cookie_storage));
  }
}

//this is for getting navigation events from form submission handlers
window.addEventListener("message", rpc.message_listener);

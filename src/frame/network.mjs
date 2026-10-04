import * as rpc from "../rpc.mjs";
import * as loader from "./loader.mjs";
import * as util from "../util.mjs";
import { ctx, get_cookie_jar } from "./context.mjs";

export const rpc_fetch = rpc.create_rpc_wrapper(rpc.host, "fetch");
export const rpc_fetch_read = rpc.create_rpc_wrapper(rpc.host, "fetch_read");
export const rpc_fetch_cancel = rpc.create_rpc_wrapper(rpc.host, "fetch_cancel");
export const rpc_ws_new = rpc.create_rpc_wrapper(rpc.host, "ws_new");
export const rpc_ws_event = rpc.create_rpc_wrapper(rpc.host, "ws_event");
export const rpc_ws_send = rpc.create_rpc_wrapper(rpc.host, "ws_send");
export const rpc_ws_close = rpc.create_rpc_wrapper(rpc.host, "ws_close");

export const known_urls = {};
export const resource_cache = {};
export let requests_allowed = false;

export function enable_network(allowed=true) {
  requests_allowed = allowed;
}

export function cache_put(url, data) {
  resource_cache[url] = data;
}

function page_origin() {
  try {
    return ctx.location?.origin || new URL(loader.url).origin;
  }
  catch {
    return null;
  }
}

function is_page_origin(url_obj) {
  let origin = page_origin();
  if (!origin) return false;
  return url_obj.origin === origin;
}

function store_response_cookies(url_obj, fetch_data) {
  try {
    if (!is_page_origin(url_obj)) return;
    let jar = get_cookie_jar();
    if (!jar) return;
    let pairs = fetch_data.items?.raw_headers || fetch_data.headers || [];
    for (let [key, value] of pairs) {
      if (String(key).toLowerCase() === "set-cookie") {
        jar.set(String(value), true);
      }
    }
  }
  catch (e) {
    console.error("sandstone: could not store response cookies", e);
  }
}

function create_body_stream(stream_id, href) {
  return new ReadableStream({
    async pull(controller) {
      try {
        let chunk = await rpc_fetch_read(stream_id);
        if (chunk === null || chunk === undefined) {
          controller.close();
        }
        else {
          controller.enqueue(chunk);
        }
      }
      catch (e) {
        let reason = e?.message ?? String(e);
        console.error("sandstone: download failed mid-transfer:", href, reason);
        controller.error(new TypeError("Failed to fetch " + href + " (" + reason + ")"));
      }
    },
    cancel() {
      rpc_fetch_cancel(stream_id).catch(() => {});
    }
  }, new CountQueuingStrategy({highWaterMark: 2}));
}

export async function fetch(url, options) {
  if (!requests_allowed) throw "Network request blocked";

  let base_url = ctx.location?.href || loader.url;
  url = new URL(url, base_url);
  if (url.protocol === "data:" || url.protocol === "blob:") {
    return await globalThis.fetch(url.href, options);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw TypeError("Invalid URL");
  }

  let fetch_data;
  try {
    fetch_data = await rpc_fetch(url.href, options);
  }
  catch (e) {
    let reason = e?.message ?? String(e);
    console.error("sandstone: proxied fetch failed:", url.href, reason);
    throw new TypeError("Failed to fetch " + url.href + " (" + reason + ")");
  }

  let body = null;
  if (fetch_data.stream_id !== null && fetch_data.stream_id !== undefined) {
    body = create_body_stream(fetch_data.stream_id, url.href);
  }
  let response_init = {};
  if (fetch_data.mime_type) {
    response_init.headers = {"Content-Type": fetch_data.mime_type};
  }
  let response = new Response(body, response_init);
  for (let key in fetch_data.items) {
    Object.defineProperty(response, key, {
      value: fetch_data.items[key]
    });
  }

  let headers = new Headers();
  for (let [key, value] of fetch_data.headers) {
    headers.append(key, value);
  }
  Object.defineProperty(response, "headers", {
    value: headers
  });
  store_response_cookies(url, fetch_data);

  return response;
};

export function create_blob_url(blob, target_url = null) {
  let url = URL.createObjectURL(blob);
  if (target_url)
    known_urls[url] = target_url;
  return url;
}

function to_bytes(data) {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return new Uint8Array(data);
}

export class WebSocket extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  #ws_id;
  #close_requested;

  constructor(url, protocols=[]) {
    super();

    let url_obj = new URL(url, ctx.location.href);
    url_obj.protocol = url_obj.protocol.replace("http", "ws");
    this.url = url_obj.href;

    let protocol_list = protocols === undefined || protocols === null ? [] : protocols;
    protocol_list = Array.isArray(protocol_list) ? protocol_list : [protocol_list];
    this.protocols = protocol_list.map(String).filter((item) => item.length > 0);

    this.protocol = "";
    this.extensions = "";
    this.binaryType = "blob";
    this.bufferedAmount = 0;

    this.onopen = () => {};
    this.onerror = () => {};
    this.onmessage = () => {};
    this.onclose = () => {};

    this.CONNECTING = 0;
    this.OPEN = 1;
    this.CLOSING = 2;
    this.CLOSED = 3;
    this.readyState = this.CONNECTING;

    this.#ws_id = null;
    this.#close_requested = false;
    this.#connect();
  }

  async #connect() {
    let headers = {
      "Origin": ctx.location.origin,
      "User-Agent": navigator.userAgent,
    };

    let ws_id;
    try {
      ws_id = await rpc_ws_new(loader.frame_id, this.url, this.protocols, {
        headers: headers
      });
    }
    catch (e) {
      console.error("sandstone: websocket connect failed", this.url, e?.message ?? e);
      this.#forward_event("error", null);
      this.#forward_event("close", 1006);
      return;
    }

    this.#ws_id = ws_id;
    if (this.#close_requested) {
      rpc_ws_close(loader.frame_id, this.#ws_id).catch(() => {});
    }
    this.#event_loop();
  }

  async #event_loop() {
    while (true) {
      let events;
      try {
        events = await rpc_ws_event(loader.frame_id, this.#ws_id);
      }
      catch (e) {
        this.#forward_event("error", null);
        break;
      }
      if (!events) break;

      let closed = false;
      for (let [event_name, data] of events) {
        this.#forward_event(event_name, data);
        if (event_name === "close") closed = true;
      }
      if (closed) break;
    }

    this.#forward_event("close", 1006);
  }

  #forward_event(event_name, data) {
    if (event_name === "open") {
      if (this.readyState !== this.CONNECTING) return;
      this.readyState = this.OPEN;
      this.#dispatch_event(new Event("open"));
    }
    else if (event_name === "close") {
      if (this.readyState === this.CLOSED) return;
      this.readyState = this.CLOSED;
      let code = Number.isInteger(data) && data >= 1000 && data < 5000 ? data : 1006;
      this.#dispatch_event(new CloseEvent("close", {code: code, wasClean: code === 1000}));
    }
    else if (event_name === "message") {
      if (this.readyState === this.CLOSED) return;
      let converted;
      if (typeof data === "string") {
        converted = data;
      }
      else {
        let bytes = to_bytes(data);
        if (this.binaryType === "arraybuffer")
          converted = bytes.slice().buffer;
        else
          converted = new Blob([bytes]);
      }
      this.#dispatch_event(new MessageEvent("message", {data: converted}));
    }
    else if (event_name === "error") {
      if (this.readyState === this.CLOSED) return;
      this.#dispatch_event(new Event("error"));
    }
  }

  #dispatch_event(event) {
    let handler = this["on" + event.type];
    if (typeof handler === "function") {
      try {
        handler.call(this, event);
      }
      catch (e) {
        console.error(e);
      }
    }
    this.dispatchEvent(event);
  }

  send(data) {
    if (this.readyState === this.CONNECTING) {
      throw new DOMException("Websocket not ready yet.", "InvalidStateError");
    }
    if (this.readyState !== this.OPEN) {
      return;
    }

    if (data instanceof Blob) {
      (async () => {
        let array_buffer = await data.arrayBuffer();
        this.send(new Uint8Array(array_buffer));
      })();
    }
    else if (typeof data === "string") {
      rpc_ws_send(loader.frame_id, this.#ws_id, data).catch(() => {});
    }
    else {
      let converted = util.data_to_array(data);
      rpc_ws_send(loader.frame_id, this.#ws_id, converted).catch(() => {});
    }
  }

  close() {
    if (this.readyState === this.CLOSING || this.readyState === this.CLOSED) return;
    this.readyState = this.CLOSING;
    this.#close_requested = true;
    if (this.#ws_id !== null) {
      rpc_ws_close(loader.frame_id, this.#ws_id).catch(() => {});
    }
  }
}

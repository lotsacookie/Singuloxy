import * as network from "../network.mjs";
import { ctx } from "../context.mjs";

const PROGRESS_INTERVAL_MS = 50;
const MAX_PREALLOCATE_BYTES = 1024 * 1024 * 1024;

export class FakeXMLHttpRequest extends EventTarget {
  static UNSENT = 0;
  static OPENED = 1;
  static HEADERS_RECEIVED = 2;
  static LOADING = 3;
  static DONE = 4;

  UNSENT = 0;
  OPENED = 1;
  HEADERS_RECEIVED = 2;
  LOADING = 3;
  DONE = 4;

  #ready_state;
  #response;
  #response_data;
  #mime_type;
  #upload;
  #req_url;
  #req_options;
  #aborted;
  #reader;

  constructor() {
    super();
    this.#init_internal();
    this.#mime_type = null;

    this.timeout = 0;
    this.responseType = "";
    this.withCredentials = false;
    
    this.#setup_listeners(["abort", "error", "load", "loadend", "loadstart", "progress", "readystatechange", "timeout"], this);
    this.#setup_listeners(["abort", "error", "load", "loadend", "loadstart", "progress", "timeout"], this.upload);
  }

  #setup_listeners(event_names, target) {
    for (let event_name of event_names) {
      target["on" + event_name] = null;
    }
  }

  #init_internal() {
    this.#ready_state = 0;
    this.#response = null;
    this.#response_data = null;
    this.#req_url = null;
    this.#req_options = {};
    this.#aborted = false;
    this.#upload = new EventTarget();
    this.#reader = null;
  }

  #emit_event(event, target) {
    if (!target) {
      this.#emit_event(event, this);
      if (event.type !== "readystatechange")
        this.#emit_event(new ProgressEvent(event.type), this.#upload);
      return;
    }
    target.dispatchEvent(event);
    try {
      if (typeof target["on" + event.type] === "function")
        target["on" + event.type](event);  
    }
    catch (e) {
      console.error(e);
    }
  } 

  abort() {
    this.#aborted = true;
    try {
      this.#reader?.cancel().catch(() => {});
    }
    catch {}
    this.readyState = this.UNSENT;
    this.#response = null;
    this.#emit_event(new ProgressEvent("abort"));
  }

  getAllResponseHeaders() {
    if (!this.#response) return "";
    let result = "";
    for (let [key, value] of this.#response.headers) {
      result += `${key}: ${value}\r\n`;
    }
    return result;
  }

  getResponseHeader(header_name) {
    if (!this.#response) return null;
    return this.#response.headers.get(header_name);
  }

  open(method, url, async, user, password) {
    if (async === false)
      throw new DOMException("InvalidAccessError") 
    
    this.#init_internal();
    this.readyState = this.OPENED;
    this.#req_url = new URL(url, ctx.location.href);
    if (user) {
      this.#req_url.username = user;
      this.#req_url.password = password || "";
    }
    this.#req_options.headers = {};
    this.#req_options.method = method.toUpperCase();
  }

  overrideMimeType(mime_type) {
    this.#mime_type = mime_type;
  }

  async #encode_body(options, body) {
    if (options.method === "GET" || options.method === "HEAD" || body === undefined || body === null) {
      delete options.body;
      return;
    }
    let request = new Request("http://127.0.0.1/", {method: "POST", body: body});
    let buffer = await request.arrayBuffer();
    let content_type = request.headers.get("content-type");
    let has_content_type = Object.keys(options.headers).some((name) => name.toLowerCase() === "content-type");
    if (content_type && !has_content_type) {
      options.headers["Content-Type"] = content_type;
    }
    options.body = buffer.byteLength ? buffer : undefined;
  }

  async #read_body() {
    let response = this.#response;
    let reader = response.body && typeof response.body.getReader === "function" ? response.body.getReader() : null;
    if (!reader) {
      this.#response_data = await response.arrayBuffer();
      return;
    }
    this.#reader = reader;

    let encoding = (response.headers.get("content-encoding") || "").toLowerCase();
    let length_header = Number(response.headers.get("content-length"));
    let identity = encoding === "" || encoding === "identity";
    let total = identity && Number.isFinite(length_header) && length_header > 0 ? length_header : 0;
    let computable = total > 0;

    let buffer = computable && total <= MAX_PREALLOCATE_BYTES ? new Uint8Array(total) : null;
    let parts = [];
    let loaded = 0;
    let last_emit = 0;

    while (true) {
      let result = await reader.read();
      if (this.#aborted) return;
      if (result.done) break;

      let chunk = result.value;
      if (buffer && loaded + chunk.byteLength <= buffer.byteLength) {
        buffer.set(chunk, loaded);
      }
      else {
        if (buffer) {
          parts.push(buffer.subarray(0, loaded));
          buffer = null;
        }
        parts.push(chunk);
      }
      loaded += chunk.byteLength;

      let now = performance.now();
      if (now - last_emit >= PROGRESS_INTERVAL_MS) {
        last_emit = now;
        this.#emit_event(new ProgressEvent("progress", {
          lengthComputable: computable,
          loaded: loaded,
          total: computable ? total : 0
        }));
      }
    }

    if (buffer) {
      this.#response_data = loaded === buffer.byteLength ? buffer.buffer : buffer.buffer.slice(0, loaded);
    }
    else {
      let merged = new Uint8Array(loaded);
      let offset = 0;
      for (let part of parts) {
        merged.set(part, offset);
        offset += part.byteLength;
      }
      this.#response_data = merged.buffer;
    }
  }

  send(body) {
    let options = {...this.#req_options, headers: {...this.#req_options.headers}};
    let timed_out = false;
    let timer = null;

    this.#emit_event(new ProgressEvent("loadstart"));

    if (this.timeout) {
      timer = setTimeout(() => {
        if (this.readyState === this.DONE || this.#aborted) return;
        timed_out = true;
        this.#aborted = true;
        try {
          this.#reader?.cancel().catch(() => {});
        }
        catch {}
        this.readyState = this.DONE;
        this.#emit_event(new ProgressEvent("timeout"));
        this.#emit_event(new ProgressEvent("loadend"));
      }, this.timeout);
    }

    (async () => {
      try {
        await this.#encode_body(options, body);
        this.#response = await network.fetch(this.#req_url, options);
        if (this.#aborted) return;
        this.readyState = this.HEADERS_RECEIVED;
        this.readyState = this.LOADING;
  
        await this.#read_body();
        if (this.#aborted) return;
        let size = this.#response_data.byteLength;
        this.#emit_event(new ProgressEvent("progress", {lengthComputable: true, loaded: size, total: size}));
        this.readyState = this.DONE;
        this.#emit_event(new ProgressEvent("load", {lengthComputable: true, loaded: size, total: size}));
      }
      catch (e) {
        if (this.#aborted) return;
        console.error("sandstone: xhr failed", this.#req_url?.href, e);
        this.readyState = this.DONE;
        this.#emit_event(new ProgressEvent("error"));
      }
      finally {
        if (timer) clearTimeout(timer);
      }
      if (!timed_out && !this.#aborted)
        this.#emit_event(new ProgressEvent("loadend"));  
    })();
  }

  setRequestHeader(header, value) {
    if (!this.#req_options.headers) this.#req_options.headers = {};
    this.#req_options.headers[header] = value;
  }

  set readyState(value) {
    if (value !== this.#ready_state) {
      this.#ready_state = value;
      this.#emit_event(new Event("readystatechange"))  
    }
  }

  get readyState() {
    return this.#ready_state;
  }

  get response() {
    if (this.#response_data === null) 
      return this.responseType === "" || this.responseType === "text" ? "" : null;
    if (this.responseType === "blob") 
      return new Blob([this.#response_data], {type: this.#response.headers.get("content-type") || ""});
    else if (this.responseType === "arraybuffer")
      return this.#response_data;
    else if (this.responseType === "json") {
      try {
        return JSON.parse(this.responseText);
      }
      catch {
        return null;
      }
    }
    else if (this.responseType === "document") {
      return new DOMParser().parseFromString(this.responseText, this.#mime_type || "text/html");
    }
    else
      return this.responseText;
  }

  get responseText() {
    if (!this.#response_data) return "";
    return new TextDecoder().decode(this.#response_data);
  }

  get responseURL() {
    if (!this.#response) return "";
    return this.#response.url;
  }

  get responseXML() {
    if (this.responseType !== "document" && this.responseType !== "")
      throw new DOMException("InvalidStateError");
    if (this.#response === null)
      return null;
    if (this.#response_data === null) 
      throw new DOMException("InvalidStateError");
    return new DOMParser().parseFromString(this.responseText, this.#mime_type || "text/html");
  }

  get status() {
    if (!this.#response) return 0;
    return this.#response.status;
  }

  get statusText() {
    if (!this.#response) return "";
    return this.#response.statusText;
  }

  get upload() {
    return this.#upload;
  }
}

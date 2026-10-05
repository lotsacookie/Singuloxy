import { iframes } from "./controller.mjs";
import { rpc_handlers } from "../rpc.mjs";
import { libcurl } from "libcurl.js/bundled";

export const ws_connections = {};
export let session = null;

const MAX_CONCURRENT_REQUESTS = 16;
const MAX_RETRIES = 3;
const MAX_RESUMES = 5;
const REQUEST_TIMEOUT_MS = 45 * 1000;
const COALESCE_BYTES = 2 * 1024 * 1024;
const COALESCE_WAIT_MS = 8;
const STREAM_IDLE_MS = 2 * 60 * 1000;
const MAX_OPEN_STREAMS = 48;
const RECOVER_AFTER_FAILURES = 6;
const RECOVER_MIN_GAP_MS = 15 * 1000;
const TRANSIENT_ERRORS = /error code (7|28|35|52|55|56)\b/;
const TLS_ERROR = /error code 35\b/;
const TIMEOUT = Symbol("timeout");

const streams = {};

let active_requests = 0;
const request_queue = [];

let tls_failure_streak = 0;
let last_recovery = 0;
let recovering = null;
let ws_url = null;

let session_ready_resolve;
const session_ready = new Promise((resolve) => {
  session_ready_resolve = resolve;
});

let tracker_blocking = true;
export function set_tracker_blocking(enabled) {
  tracker_blocking = !!enabled;
}

const BLOCKED_HOSTS = [
  "googletagmanager.com",
  "google-analytics.com",
  "doubleclick.net",
  "googlesyndication.com",
  "googleadservices.com",
  "cloudflareinsights.com",
  "amazon-adsystem.com",
  "crwdcntrl.net",
  "eyeota.net",
  "optable.co",
  "confiant-integrations.net",
  "html-load.cc",
  "githack.com"
];

const BLOCKED_URL_PATTERNS = [
  /^https:\/\/cdn\.jsdelivr\.net\/gh\/ad-shield\//i,
  /^https:\/\/raw\.githubusercontent\.com\/easylist\//i,
  /^https:\/\/[a-z0-9]+-\d+-\d+-\d+-\d+\.roblox\.com\/_\/_\/1px\.gif/i,
  /^https:\/\/sc0(ak)?\.rbxcdn\.com\/test-50kb\.png/i,
  /^https:\/\/lms-[a-z0-9-]+\.roblox\.com\/1x1\.png/i
];

const GIF_1X1 = Uint8Array.from(
  atob("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"),
  (c) => c.charCodeAt(0)
);

function is_blocked(url) {
  if (BLOCKED_URL_PATTERNS.some((pattern) => pattern.test(url))) return true;
  try {
    let host = new URL(url).hostname.toLowerCase();
    return BLOCKED_HOSTS.some((blocked) => host === blocked || host.endsWith("." + blocked));
  }
  catch {
    return false;
  }
}

function blocked_payload(url) {
  let path = "";
  try {
    path = new URL(url).pathname.toLowerCase();
  }
  catch {}
  let is_script = path.endsWith(".js");
  let mime = is_script ? "application/javascript" : "image/gif";
  let body = is_script ? null : GIF_1X1;

  return {
    headers: [["content-type", mime]],
    items: {
      ok: true,
      redirected: false,
      status: 200,
      statusText: "OK",
      type: "basic",
      url: url,
      raw_headers: []
    },
    mime_type: mime,
    stream_id: body ? register_buffer_stream(body, url) : null
  };
}

try {
  const original_set_websocket = libcurl.set_websocket.bind(libcurl);
  libcurl.set_websocket = (url) => {
    ws_url = url;
    return original_set_websocket(url);
  };
}
catch (e) {
  console.warn("sandstone host: could not wrap set_websocket:", String(e?.message ?? e));
}

export function set_websocket(url) {
  libcurl.set_websocket(url);
}

function make_session() {
  try {
    return new libcurl.HTTPSession({enable_cookies: true});
  }
  catch (e) {
    console.warn("sandstone host: cookie-enabled session failed, using a plain session:", error_message(e));
    return new libcurl.HTTPSession();
  }
}

function recover_session() {
  if (recovering) return recovering;
  if (Date.now() - last_recovery < RECOVER_MIN_GAP_MS) return null;
  last_recovery = Date.now();
  tls_failure_streak = 0;

  recovering = (async () => {
    console.warn("sandstone host: repeated TLS failures, resetting wisp connection and libcurl session");
    try {
      if (ws_url) libcurl.set_websocket(ws_url);
    }
    catch (e) {
      console.warn("sandstone host: reconnect failed:", error_message(e));
    }
    await sleep(500);
    session = make_session();
  })().catch((e) => {
    console.error("sandstone host: session recovery failed:", error_message(e));
  }).finally(() => {
    recovering = null;
  });
  return recovering;
}

function note_success() {
  tls_failure_streak = 0;
}

function note_failure(error) {
  if (!TLS_ERROR.test(error_message(error))) return;
  tls_failure_streak++;
  if (tls_failure_streak >= RECOVER_AFTER_FAILURES) recover_session();
}

function acquire_slot() {
  if (active_requests < MAX_CONCURRENT_REQUESTS) {
    active_requests++;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    request_queue.push(resolve);
  });
}

function release_slot() {
  let next = request_queue.shift();
  if (next) next();
  else active_requests--;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function error_message(error) {
  return String(error?.message ?? error);
}

function is_transient(error) {
  return TRANSIENT_ERRORS.test(error_message(error));
}

function with_timeout(promise, ms, url) {
  let timer;
  let timed_out = false;

  promise.then((response) => {
    if (!timed_out) return;
    try {
      response?.body?.cancel?.().catch?.(() => {});
    }
    catch {}
  }, () => {});

  let timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      timed_out = true;
      reject(new Error(`Request "${url}" failed with error code 28: timed out`));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function fetch_with_retry(url, options) {
  let method = String(options?.method || "GET").toUpperCase();
  let can_retry = method === "GET" || method === "HEAD";
  let attempt = 0;

  while (true) {
    if (recovering) await recovering;
    try {
      let response = await with_timeout(
        session.fetch(url, options ? {...options} : undefined),
        REQUEST_TIMEOUT_MS,
        url
      );
      note_success();
      return response;
    }
    catch (e) {
      note_failure(e);
      if (!can_retry || attempt >= MAX_RETRIES || !is_transient(e)) throw e;
      attempt++;
      await sleep(400 * attempt + Math.random() * 300);
    }
  }
}

function has_header(headers, name) {
  if (!headers) return false;
  return Object.keys(headers).some((key) => key.toLowerCase() === name);
}

function merge_chunks(parts, size) {
  if (parts.length === 1) return parts[0];
  let merged = new Uint8Array(size);
  let offset = 0;
  for (let part of parts) {
    merged.set(part, offset);
    offset += part.byteLength;
  }
  return merged;
}

function end_stream(stream_id) {
  let stream = streams[stream_id];
  if (!stream) return;
  delete streams[stream_id];
  try {
    stream.reader.cancel().catch(() => {});
  }
  catch {}
}

function enforce_stream_cap() {
  let ids = Object.keys(streams);
  if (ids.length <= MAX_OPEN_STREAMS) return;
  let now = Date.now();
  let candidates = ids
    .filter((id) => now - streams[id].touched > 10 * 1000)
    .sort((a, b) => streams[a].touched - streams[b].touched);
  for (let id of candidates) {
    if (Object.keys(streams).length <= MAX_OPEN_STREAMS) break;
    end_stream(id);
  }
}

function register_buffer_stream(buffer, url) {
  let stream_id = Math.random() + "";
  let delivered = false;
  streams[stream_id] = {
    reader: {
      read: async () => {
        if (delivered) return {done: true, value: undefined};
        delivered = true;
        return {done: false, value: buffer};
      },
      cancel: async () => {}
    },
    pending: null,
    finished: false,
    error: null,
    received: 0,
    resumes: 0,
    url: url,
    options: undefined,
    touched: Date.now(),
    can_resume: false
  };
  return stream_id;
}

async function read_with_timeout(stream, wait_ms) {
  if (!stream.pending) stream.pending = stream.reader.read();
  let pending = stream.pending;
  let outcome;

  try {
    if (wait_ms === null) {
      outcome = await pending;
    }
    else {
      let timer;
      let timeout = new Promise((resolve) => {
        timer = setTimeout(() => resolve(TIMEOUT), wait_ms);
      });
      try {
        outcome = await Promise.race([pending, timeout]);
      }
      finally {
        clearTimeout(timer);
      }
    }
  }
  catch (e) {
    stream.pending = null;
    throw e;
  }

  if (outcome !== TIMEOUT) stream.pending = null;
  return outcome;
}

async function recover_stream(stream_id, stream, error) {
  if (!stream.can_resume || stream.resumes >= MAX_RESUMES) {
    end_stream(stream_id);
    throw new Error(error_message(error));
  }
  stream.resumes++;
  console.warn("sandstone host: resuming download at byte", stream.received, stream.url, error_message(error));

  try {
    stream.reader.cancel().catch(() => {});
  }
  catch {}
  stream.pending = null;

  try {
    let headers = {...stream.options?.headers, Range: `bytes=${stream.received}-`};
    let response = await fetch_with_retry(stream.url, {...stream.options, headers: headers});
    if (response.status !== 206 || !response.body) {
      throw new Error("server did not honor the range request");
    }
    stream.reader = response.body.getReader();
  }
  catch (e) {
    end_stream(stream_id);
    throw new Error(error_message(e));
  }
}

function get_ws(frame_id, ws_id) {
  let frame_websockets = ws_connections[frame_id];
  if (!frame_websockets) return;
  return frame_websockets[ws_id];
}

function push_ws_event(ws_info, event_name, data) {
  ws_info.events.push([event_name, data]);
  ws_info.callback?.();
}

function safe_close(ws_info) {
  try {
    ws_info.ws.close();
  }
  catch (e) {
    console.warn("sandstone host: websocket close failed:", error_message(e));
  }
}

rpc_handlers["fetch"] = async function(url, options) {
  if (tracker_blocking && is_blocked(url)) return blocked_payload(url);

  if (!session) await session_ready;
  await acquire_slot();

  try {
    let response;
    try {
      response = await fetch_with_retry(url, options);
    }
    catch (e) {
      console.error("sandstone host: libcurl fetch failed:", url, e);
      throw new Error(error_message(e));
    }

    let keys = ["ok", "redirected", "status", "statusText", "type", "url", "raw_headers"];
    let payload = {
      headers: [],
      items: {},
      mime_type: "",
      stream_id: null
    };
    for (let key of keys) {
      payload.items[key] = response[key];
    }
    for (let pair of response.headers.entries()) {
      payload.headers.push(pair);
    }
    payload.mime_type = (response.headers.get("content-type") || "").split(";")[0].trim();

    let method = String(options?.method || "GET").toUpperCase();
    let encoding = (response.headers.get("content-encoding") || "").toLowerCase();
    let ranges = (response.headers.get("accept-ranges") || "").toLowerCase();

    let bodyless = (
      method === "HEAD" ||
      response.status === 204 ||
      response.status === 205 ||
      response.status === 304 ||
      response.headers.get("content-length") === "0"
    );
    if (bodyless) {
      try {
        response.body?.cancel?.().catch?.(() => {});
      }
      catch {}
      return payload;
    }

    if (typeof response.body?.getReader === "function") {
      let stream_id = Math.random() + "";
      streams[stream_id] = {
        reader: response.body.getReader(),
        pending: null,
        finished: false,
        error: null,
        received: 0,
        resumes: 0,
        url: url,
        options: options ? {...options} : undefined,
        touched: Date.now(),
        can_resume: (
          method === "GET" &&
          response.status === 200 &&
          ranges.includes("bytes") &&
          (encoding === "" || encoding === "identity") &&
          !has_header(options?.headers, "range")
        )
      };
      payload.stream_id = stream_id;
    }
    else {
      let blob = await response.blob();
      let buffer = new Uint8Array(await blob.arrayBuffer());
      payload.stream_id = register_buffer_stream(buffer, url);
    }

    enforce_stream_cap();
    return payload;
  }
  finally {
    release_slot();
  }
}

rpc_handlers["fetch_read"] = async function(stream_id) {
  let stream = streams[stream_id];
  if (!stream) return null;
  stream.touched = Date.now();

  if (stream.error) {
    let error = stream.error;
    stream.error = null;
    await recover_stream(stream_id, stream, error);
  }
  if (stream.finished) {
    end_stream(stream_id);
    return null;
  }

  let parts = [];
  let size = 0;

  while (true) {
    let result;
    try {
      result = await read_with_timeout(stream, parts.length > 0 ? COALESCE_WAIT_MS : null);
    }
    catch (e) {
      if (parts.length > 0) {
        stream.error = e;
        break;
      }
      await recover_stream(stream_id, stream, e);
      continue;
    }

    if (result === TIMEOUT) break;
    if (result.done) {
      stream.finished = true;
      break;
    }

    parts.push(result.value);
    size += result.value.byteLength;
    stream.received += result.value.byteLength;
    if (size >= COALESCE_BYTES) break;
  }

  if (parts.length === 0) {
    end_stream(stream_id);
    return null;
  }

  return merge_chunks(parts, size);
}

rpc_handlers["fetch_cancel"] = function(stream_id) {
  end_stream(stream_id);
}

setInterval(() => {
  let now = Date.now();
  for (let [stream_id, stream] of Object.entries(streams)) {
    if (now - stream.touched > STREAM_IDLE_MS) end_stream(stream_id);
  }
}, 15000);

rpc_handlers["ws_new"] = function (frame_id, url, protocols, options) {
  let ws_id = Math.random() + "";
  let ws;

  try {
    ws = new libcurl.CurlWebSocket(url, protocols, options);
  }
  catch (e) {
    console.error("sandstone host: websocket creation failed:", url, e);
    throw new Error(error_message(e));
  }

  if (!ws_connections[frame_id]) ws_connections[frame_id] = {};
  let ws_info = {
    ws: ws,
    events: [],
    callback: null,
    closing: false,
    closed: false
  };
  ws_connections[frame_id][ws_id] = ws_info;

  ws.onopen = (data) => {
    push_ws_event(ws_info, "open", data);
  };
  ws.onmessage = (data) => {
    if (ws_info.closed) return;
    push_ws_event(ws_info, "message", data);
  };
  ws.onerror = (data) => {
    if (ws_info.closed) return;
    push_ws_event(ws_info, "error", data);
  };
  ws.onclose = (reason) => {
    if (ws_info.closed) return;
    ws_info.closed = true;
    push_ws_event(ws_info, "close", reason);
    if (!ws_info.closing) {
      ws_info.closing = true;
      safe_close(ws_info);
    }
  };

  return ws_id;
}

rpc_handlers["ws_event"] = function (frame_id, ws_id) {
  let ws_info = get_ws(frame_id, ws_id);
  if (!ws_info) return null;

  let take_events = () => {
    let events = ws_info.events;
    ws_info.events = [];
    if (events.some(([name]) => name === "close")) {
      delete ws_connections[frame_id]?.[ws_id];
    }
    return events;
  };

  if (ws_info.events.length > 0) {
    return take_events();
  }

  return new Promise((resolve) => {
    ws_info.callback = () => {
      ws_info.callback = null;
      resolve(take_events());
    };
  });
}

rpc_handlers["ws_send"] = function (frame_id, ws_id, data) {
  let ws_info = get_ws(frame_id, ws_id);
  if (!ws_info || ws_info.closed || ws_info.closing) return;
  try {
    ws_info.ws.send(data);
  }
  catch (e) {
    console.warn("sandstone host: websocket send failed:", error_message(e));
  }
}

rpc_handlers["ws_close"] = function (frame_id, ws_id) {
  let ws_info = get_ws(frame_id, ws_id);
  if (!ws_info || ws_info.closing) return;
  ws_info.closing = true;
  safe_close(ws_info);

  setTimeout(() => {
    if (ws_info.closed) return;
    ws_info.closed = true;
    push_ws_event(ws_info, "close", 1000);
  }, 1500);
}

export function clean_ws_connections(id_to_clean) {
  let frame_ids = Object.keys(iframes);

  for (let [frame_id, frame_websockets] of Object.entries(ws_connections)) {
    if (frame_ids.includes(frame_id) && frame_id !== id_to_clean) continue;

    for (let [ws_id, ws_info] of Object.entries(frame_websockets)) {
      delete ws_connections[frame_id][ws_id];
      ws_info.closed = true;
      ws_info.closing = true;
      safe_close(ws_info);
      ws_info.callback?.();
    }

    delete ws_connections[frame_id];
  }
}

libcurl.events.addEventListener("libcurl_load", () => {
  console.log(`libcurl.js v${libcurl.version.lib} loaded`);
  session = make_session();
  session_ready_resolve();
});

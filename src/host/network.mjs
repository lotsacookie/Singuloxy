import { iframes } from "./controller.mjs";
import { rpc_handlers } from "../rpc.mjs";
import { libcurl } from "libcurl.js/bundled";

export const ws_connections = {};
export let session = null;

const MAX_CONCURRENT_REQUESTS = 6;
const MAX_RETRIES = 2;
const MAX_RESUMES = 5;
const COALESCE_BYTES = 2 * 1024 * 1024;
const COALESCE_WAIT_MS = 8;
const STREAM_IDLE_MS = 5 * 60 * 1000;
const TRANSIENT_ERRORS = /error code (7|28|35|52|55|56)\b/;
const TIMEOUT = Symbol("timeout");

const streams = {};

let active_requests = 0;
const request_queue = [];

let session_ready_resolve;
const session_ready = new Promise((resolve) => {
  session_ready_resolve = resolve;
});

export function set_websocket(url) {
  libcurl.set_websocket(url);
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

async function fetch_with_retry(url, options) {
  let method = String(options?.method || "GET").toUpperCase();
  let can_retry = method === "GET" || method === "HEAD";
  let attempt = 0;

  while (true) {
    try {
      return await session.fetch(url, options ? {...options} : undefined);
    }
    catch (e) {
      if (!can_retry || attempt >= MAX_RETRIES || !is_transient(e)) throw e;
      attempt++;
      await sleep(300 * attempt);
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
      payload.stream_id = stream_id;
    }

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
}, 30000);

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
  try {
    session = new libcurl.HTTPSession({enable_cookies: true});
  }
  catch (e) {
    console.warn("sandstone host: cookie-enabled session failed, using a plain session:", error_message(e));
    session = new libcurl.HTTPSession();
  }
  session_ready_resolve();
});

import { iframes } from "./controller.mjs";
import { rpc_handlers } from "../rpc.mjs";
import { libcurl } from "libcurl.js/bundled";

export const ws_connections = {};
export let session = null;

const MAX_CONCURRENT_REQUESTS = 6;
const MAX_RETRIES = 2;
const TRANSIENT_ERRORS = /error code (7|28|35|52|55|56)\b/;

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
      body: await response.blob(),
      headers: [],
      items: {}
    };
    if (payload.body.type.includes(";")) {
      let mime_type = payload.body.type.split(";")[0].trim();
      payload.body = new Blob([payload.body], {type: mime_type});
    }
    for (let key of keys) {
      payload.items[key] = response[key];
    }
    for (let pair of response.headers.entries()) {
      payload.headers.push(pair);
    }

    return payload;
  }
  finally {
    release_slot();
  }
}

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

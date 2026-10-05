import { iframes } from "./controller.mjs";
import { rpc_handlers } from "../rpc.mjs";
import { libcurl } from "libcurl.js/bundled";

export const ws_connections = {};
export let session = null;

const MAX_CONCURRENT_REQUESTS = 16;
const MIN_CONCURRENT_REQUESTS = 2;
const GROW_AFTER_SUCCESSES = 10;
const COOLDOWN_MS = 1500;
const MAX_RETRIES = 3;
const MAX_TLS_RETRIES = 6;
const MAX_PER_HOST = 6;
const MAX_RESUMES = 5;
const REQUEST_TIMEOUT_MS = 45 * 1000;
const COALESCE_BYTES = 2 * 1024 * 1024;
const COALESCE_WAIT_MS = 8;
const STREAM_IDLE_MS = 2 * 60 * 1000;
const MAX_OPEN_STREAMS = 48;
const TRANSIENT_ERRORS = /error code (7|28|35|52|55|56)\b/;
const TLS_ERROR = /error code 35\b/;
const CONNECTION_ERRORS = /error code (7|35)\b/;
const PRE_REQUEST_ERRORS = /error code (7|35)\b/;
const PARTIAL_ERRORS = /error code (18|56)\b/;
const TIMEOUT = Symbol("timeout");

const SEGMENT_BYTES = 4 * 1024 * 1024;
const SEGMENT_PARALLEL = 4;
const SEGMENT_LOOKAHEAD = 5;
const SEGMENT_RETRIES = 4;
const SEGMENT_TIMEOUT_MS = 60 * 1000;
const MAX_SEGMENT_REQUESTS = 12;
const LARGE_FILE_PATTERN = /\.(zip|7z|rar|tar|pk3|pak|pck|wasm|data|bin|iso|mp4|webm|mkv|unityweb)([?#]|$)|\.part\d{2,}([?#]|$)/i;

const streams = {};
const segmented_hosts = new Set();

let active_requests = 0;
let concurrency_limit = MAX_CONCURRENT_REQUESTS;
let successes_since_shrink = 0;
let cooldown_until = 0;
let last_shrink_log = 0;
const request_queue = [];

let wisp_pool = [];
let ws_url = null;

let session_ready_resolve;
const session_ready = new Promise((resolve) => {
  session_ready_resolve = resolve;
});

class Semaphore {
  constructor(limit) {
    this.limit = limit;
    this.active = 0;
    this.waiters = [];
  }

  acquire() {
    if (this.active < this.limit) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }

  release() {
    let next = this.waiters.shift();
    if (next) next();
    else this.active--;
  }
}

const segment_semaphore = new Semaphore(MAX_SEGMENT_REQUESTS);

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

function blocked_payload(url, owner) {
  let path = "";
  try {
    path = new URL(url).pathname.toLowerCase();
  }
  catch {}
  let is_script = path.endsWith(".js");
  let mime = is_script ? "application/javascript" : "image/gif";
  let body = is_script ? null : GIF_1X1.slice();

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
    stream_id: body ? register_buffer_stream(body, url, owner) : null
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

export function set_wisp_pool(urls) {
  wisp_pool = (Array.isArray(urls) ? urls : []).filter((url) => typeof url === "string" && url);
}

export function get_connection_info() {
  return {
    websocket: ws_url,
    wisp_pool: [...wisp_pool],
    concurrency_limit: concurrency_limit,
    active_requests: active_requests,
    queued_requests: request_queue.length,
    open_streams: Object.keys(streams).length
  };
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

function drain_requests() {
  while (request_queue.length > 0 && active_requests < concurrency_limit) {
    active_requests++;
    request_queue.shift()();
  }
}

function acquire_slot() {
  if (active_requests < concurrency_limit && request_queue.length === 0) {
    active_requests++;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    request_queue.push(resolve);
  });
}

function release_slot() {
  active_requests--;
  drain_requests();
}

function shrink_concurrency() {
  let previous = concurrency_limit;
  concurrency_limit = Math.max(MIN_CONCURRENT_REQUESTS, Math.floor(concurrency_limit / 2));
  successes_since_shrink = 0;
  cooldown_until = Date.now() + COOLDOWN_MS;
  if (concurrency_limit !== previous && Date.now() - last_shrink_log > 5000) {
    last_shrink_log = Date.now();
    console.warn(`sandstone host: connection errors, lowering concurrent requests from ${previous} to ${concurrency_limit}`);
  }
}

function grow_concurrency() {
  successes_since_shrink++;
  if (successes_since_shrink < GROW_AFTER_SUCCESSES) return;
  successes_since_shrink = 0;
  if (concurrency_limit >= MAX_CONCURRENT_REQUESTS) return;
  concurrency_limit++;
  drain_requests();
}

function note_success() {
  grow_concurrency();
}

function note_failure(error) {
  if (CONNECTION_ERRORS.test(error_message(error))) shrink_concurrency();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function wait_for_cooldown() {
  let remaining = cooldown_until - Date.now();
  if (remaining > 0) await sleep(remaining + Math.random() * 300);
}

const host_active = new Map();
const host_queues = new Map();

function host_of(url) {
  try {
    return new URL(url).host;
  }
  catch {
    return "";
  }
}

function acquire_host_slot(host) {
  let active = host_active.get(host) || 0;
  if (active < MAX_PER_HOST) {
    host_active.set(host, active + 1);
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let queue = host_queues.get(host);
    if (!queue) {
      queue = [];
      host_queues.set(host, queue);
    }
    queue.push(resolve);
  });
}

function release_host_slot(host) {
  let queue = host_queues.get(host);
  let next = queue && queue.shift();
  if (queue && queue.length === 0) host_queues.delete(host);
  if (next) {
    next();
    return;
  }
  let active = (host_active.get(host) || 1) - 1;
  if (active <= 0) host_active.delete(host);
  else host_active.set(host, active);
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
    await wait_for_cooldown();
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
      let message = error_message(e);
      let retryable = can_retry ? is_transient(e) : PRE_REQUEST_ERRORS.test(message);
      let tls = TLS_ERROR.test(message);
      let limit = tls ? MAX_TLS_RETRIES : MAX_RETRIES;
      if (!retryable || attempt >= limit) throw e;
      attempt++;
      let base = tls ? 800 : 400;
      let cap = tls ? 8000 : 4000;
      await sleep(Math.min(base * 2 ** (attempt - 1), cap) + Math.random() * 400);
    }
  }
}

export async function fetch_page(url, options) {
  if (!session) await session_ready;
  let attempt = 0;

  while (true) {
    try {
      return await fetch_with_retry(url, options);
    }
    catch (e) {
      if (attempt >= 2 || !CONNECTION_ERRORS.test(error_message(e))) throw e;
      attempt++;
      console.warn("sandstone host: page request failed, retrying:", url, error_message(e));
      await sleep(2000 * attempt);
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

function discard_response(response) {
  try {
    response?.body?.cancel?.().catch?.(() => {});
  }
  catch {}
}

function ranged(options, start, end) {
  return {
    ...(options || {}),
    headers: {...(options?.headers || {}), Range: `bytes=${start}-${end}`}
  };
}

function content_range_total(response) {
  let match = /\/(\d+)\s*$/.exec(response.headers.get("content-range") || "");
  return match ? Number(match[1]) : null;
}

function is_identity(response) {
  let encoding = (response.headers.get("content-encoding") || "").toLowerCase();
  return encoding === "" || encoding === "identity";
}

function usable_segmented(response) {
  return response.status === 206 && content_range_total(response) !== null && is_identity(response);
}

async function download_segment(url, options, host, start, end, seed) {
  let expected = end - start + 1;
  let response = seed;
  let last_error;

  await segment_semaphore.acquire();
  try {
    for (let attempt = 0; attempt <= SEGMENT_RETRIES; attempt++) {
      try {
        if (!response) {
          await acquire_host_slot(host);
          await acquire_slot();
          try {
            response = await fetch_with_retry(url, ranged(options, start, end));
          }
          finally {
            release_slot();
            release_host_slot(host);
          }
          if (response.status !== 206) {
            let status = response.status;
            discard_response(response);
            response = null;
            throw new Error(`Request failed with error code 22: server did not honor the range request (status ${status})`);
          }
        }

        let current = response;
        response = null;
        let bytes;
        try {
          bytes = new Uint8Array(await with_timeout(current.arrayBuffer(), SEGMENT_TIMEOUT_MS, url));
        }
        catch (e) {
          discard_response(current);
          throw e;
        }
        if (bytes.byteLength !== expected) {
          throw new Error(`Request failed with error code 18: segment returned ${bytes.byteLength} of ${expected} bytes`);
        }
        return bytes;
      }
      catch (e) {
        last_error = e;
        if (attempt >= SEGMENT_RETRIES) break;
        await sleep(Math.min(300 * 2 ** attempt, 3000) + Math.random() * 250);
      }
    }
  }
  finally {
    segment_semaphore.release();
  }

  throw new Error(error_message(last_error));
}

function create_segmented_reader(url, options, host, total, first_response) {
  let segment_count = Math.ceil(total / SEGMENT_BYTES);
  let segments = new Map();
  let next_start = 0;
  let next_deliver = 0;
  let in_flight = 0;
  let cancelled = false;
  let initial = first_response;

  let launch = () => {
    while (
      !cancelled &&
      next_start < segment_count &&
      in_flight < SEGMENT_PARALLEL &&
      next_start - next_deliver < SEGMENT_LOOKAHEAD
    ) {
      let index = next_start++;
      let start = index * SEGMENT_BYTES;
      let end = Math.min(start + SEGMENT_BYTES, total) - 1;
      let seed = null;
      if (index === 0) {
        seed = initial;
        initial = null;
      }
      in_flight++;
      let promise = download_segment(url, options, host, start, end, seed).finally(() => {
        in_flight--;
        launch();
      });
      promise.catch(() => {});
      segments.set(index, promise);
    }
  };

  return {
    read: async () => {
      if (cancelled || next_deliver >= segment_count) {
        return {done: true, value: undefined};
      }
      launch();
      let index = next_deliver;
      let promise = segments.get(index);
      if (!promise) throw new Error("segment scheduling stalled");

      let bytes;
      try {
        bytes = await promise;
      }
      catch (e) {
        cancelled = true;
        segments.clear();
        throw e;
      }
      segments.delete(index);
      next_deliver++;
      launch();
      return {done: false, value: bytes};
    },
    cancel: async () => {
      cancelled = true;
      segments.clear();
      if (initial) {
        discard_response(initial);
        initial = null;
      }
    }
  };
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

export function end_streams_for(owners) {
  if (!Array.isArray(owners) || owners.length === 0) return;
  for (let [stream_id, stream] of Object.entries(streams)) {
    if (stream.owner && owners.includes(stream.owner)) end_stream(stream_id);
  }
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

function register_buffer_stream(buffer, url, owner = null) {
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
    owner: owner,
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
  let owner = this?.source ?? null;

  if (tracker_blocking && is_blocked(url)) return blocked_payload(url, owner);

  if (!session) await session_ready;
  let host = host_of(url);
  await acquire_host_slot(host);
  await acquire_slot();

  try {
    let method = String(options?.method || "GET").toUpperCase();
    let can_segment = (
      method === "GET" &&
      !options?.body &&
      !has_header(options?.headers, "range")
    );
    let response = null;
    let segmented = false;

    if (can_segment && (segmented_hosts.has(host) || LARGE_FILE_PATTERN.test(url))) {
      try {
        let attempt = await fetch_with_retry(url, ranged(options, 0, SEGMENT_BYTES - 1));
        if (attempt.status === 206) {
          if (usable_segmented(attempt)) {
            response = attempt;
            segmented = true;
          }
          else {
            discard_response(attempt);
          }
        }
        else if (attempt.status === 416) {
          discard_response(attempt);
        }
        else {
          response = attempt;
        }
      }
      catch (e) {
        console.warn("sandstone host: ranged start failed, using a normal request:", url, error_message(e));
      }
    }

    if (!response) {
      try {
        response = await fetch_with_retry(url, options);
      }
      catch (e) {
        let recovered = false;
        if (can_segment && PARTIAL_ERRORS.test(error_message(e))) {
          segmented_hosts.add(host);
          console.warn("sandstone host: transfer cut off, switching to segmented download:", url, error_message(e));
          try {
            let attempt = await fetch_with_retry(url, ranged(options, 0, SEGMENT_BYTES - 1));
            if (usable_segmented(attempt)) {
              response = attempt;
              segmented = true;
              recovered = true;
            }
            else if (attempt.status === 200) {
              response = attempt;
              recovered = true;
            }
            else {
              discard_response(attempt);
            }
          }
          catch {}
        }
        if (!recovered) {
          console.error("sandstone host: libcurl fetch failed:", url, e);
          throw new Error(error_message(e));
        }
      }
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

    if (segmented) {
      let total = content_range_total(response);
      payload.items.ok = true;
      payload.items.status = 200;
      payload.items.statusText = "OK";
      payload.headers = payload.headers.filter(([key]) => {
        let name = String(key).toLowerCase();
        return name !== "content-range" && name !== "content-length";
      });
      payload.headers.push(["content-length", String(total)]);

      let stream_id = Math.random() + "";
      streams[stream_id] = {
        reader: create_segmented_reader(url, options ? {...options} : undefined, host, total, response),
        owner: owner,
        pending: null,
        finished: false,
        error: null,
        received: 0,
        resumes: 0,
        url: url,
        options: options ? {...options} : undefined,
        touched: Date.now(),
        can_resume: false
      };
      payload.stream_id = stream_id;
      enforce_stream_cap();
      return payload;
    }

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
        owner: owner,
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
      payload.stream_id = register_buffer_stream(buffer, url, owner);
    }

    enforce_stream_cap();
    return payload;
  }
  finally {
    release_slot();
    release_host_slot(host);
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

import { ctx } from "../context.mjs";
import * as network from "../network.mjs";

function abort_error(signal) {
  if (signal && signal.reason !== undefined) return signal.reason;
  return new DOMException("The user aborted a request.", "AbortError");
}

function has_content_type(headers) {
  return Object.keys(headers).some((name) => name.toLowerCase() === "content-type");
}

export async function fetch(resource, init={}) {
  let params = {...init};
  let url = resource;
  let signal = params.signal || null;
  if (resource instanceof Request) {
    url = resource.url;
    if (!signal) signal = resource.signal;
    params.body = params.body || await resource.blob();
    params.headers = params.headers || Object.fromEntries(resource.headers);
    params.method = params.method || resource.method;

    if (params.body && params.body.size === 0) {
      delete params.body;
    }
  }
  if (signal && signal.aborted) throw abort_error(signal);
  if (params.headers instanceof Headers) {
    params.headers = Object.fromEntries(params.headers);
  }
  else if (Array.isArray(params.headers)) {
    params.headers = Object.fromEntries(params.headers);
  }
  url = (new URL(url, ctx.location.href)).href;
  if (params.body instanceof ReadableStream) {
    params.duplex = "half";
  }
  if (params.signal)
    delete params.signal;

  let request_obj = new Request("http://127.0.0.1/", params);
  let array_buffer = await request_obj.arrayBuffer();
  let content_type = request_obj.headers.get("content-type");
  params.body = array_buffer.byteLength ? array_buffer : undefined;

  if (params.body && content_type) {
    let headers = {...(params.headers || {})};
    if (!has_content_type(headers)) {
      headers["Content-Type"] = content_type;
    }
    params.headers = headers;
  }

  let request = network.fetch(url, params);
  if (!signal || typeof signal.addEventListener !== "function") return await request;

  return await new Promise((resolve, reject) => {
    let on_abort = () => reject(abort_error(signal));
    signal.addEventListener("abort", on_abort, {once: true});
    request.then(resolve, reject).finally(() => signal.removeEventListener("abort", on_abort));
  });
}

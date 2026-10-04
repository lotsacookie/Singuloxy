import { ctx } from "../context.mjs";
import * as network from "../network.mjs";

export async function fetch(resource, init={}) {
  let params = {...init};
  let url = resource;
  if (resource instanceof Request) {
    url = resource.url;
    params.body = params.body || await resource.blob();
    params.headers = params.headers || Object.fromEntries(resource.headers);
    params.method = params.method || resource.method;

    if (params.body && params.body.size === 0) {
      delete params.body;
    }
  }
  if (params.headers instanceof Headers) {
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
  params.body = array_buffer.byteLength ? array_buffer : undefined;

  return await network.fetch(url, params);
}

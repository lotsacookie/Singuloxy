import { ctx, convert_url, intercept_property, proxy_function } from "../context.mjs";
import * as network from "../network.mjs";

function resolve_http_url(value) {
  if (!value) return null;
  let text = String(value);
  if (/^(data|blob|javascript|about):/i.test(text)) return null;
  try {
    let resolved = convert_url(text, ctx.location.href);
    if (/^https?:/i.test(resolved)) return resolved;
  }
  catch {}
  return null;
}

function pick_srcset(srcset) {
  let candidates = [];
  for (let part of srcset.split(",")) {
    let pieces = part.trim().split(/\s+/);
    if (!pieces[0]) continue;
    let descriptor = pieces[1] || "1x";
    let unit = descriptor.slice(-1);
    let weight = parseFloat(descriptor);
    if (!Number.isFinite(weight)) {
      weight = 1;
      unit = "x";
    }
    candidates.push({url: pieces[0], weight: weight, unit: unit});
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.weight - b.weight);
  let limit = candidates[0].unit === "w" ? 1200 : 2;
  let fitting = candidates.filter((candidate) => candidate.weight <= limit);
  let best = fitting.length ? fitting[fitting.length - 1] : candidates[0];
  return best.url;
}

export function rewrite_media(media_element) {
  let media_src = media_element.getAttribute("src") || media_element.src;
  
  if (media_element instanceof HTMLVideoElement) {
    let source = media_element.querySelector("source[src]");
    while (media_element.lastChild !== source) 
      media_element.lastChild.remove();
  }

  let media_url = "";
  let latest_request = 0;
  let allow_error = false;

  let fetch_src = async (value) => {
    let request_id = ++latest_request;
    media_element.setAttribute("__src", value);
    try {
      media_url = convert_url(value, ctx.location.href);
      let response = await network.fetch(media_url);
      if (response.ok === false) {
        throw new Error("status " + response.status);
      }
      let media_blob = await response.blob();
      if (request_id !== latest_request) return;
      let blob_url = URL.createObjectURL(media_blob);
      media_element.src = blob_url;
    }
    catch (e) {
      console.error("sandstone: failed to load media", media_url, e);
      if (request_id !== latest_request) return;
      allow_error = true;
      media_element.dispatchEvent(new Event("error"));
      allow_error = false;
      return;
    }

    if (media_element instanceof HTMLSourceElement) {
      let parent = media_element.parentNode;
      while (parent && !(parent instanceof HTMLVideoElement))
        parent = parent.parentNode;
      if (!parent) 
        return;

      parent.load();
      if (!parent.autoplay) return
      parent.play();
    }
  };
  let src_descriptor = intercept_property(media_element, "src", {
    get() {
      return media_url || src_descriptor.get.call(media_element);
    },
    set(value) {
      if (!resolve_http_url(value))
        src_descriptor.set.call(media_element, value);
      else {
        media_element.src = "";
        fetch_src(value);
      }
    }
  });

  media_element.addEventListener("error", (event) =>  {
    if (allow_error) return;
    if (!src_descriptor || src_descriptor.get.call(media_element) === "") {
      event.stopImmediatePropagation();
    }
  }, true);

  proxy_function(media_element, "setAttribute", (target, this_arg, args) => {
    if (args[0] === "src")  {
      media_element.src = args[1];
      return;
    }
    return Reflect.apply(target, this_arg, args);
  })
  
  let srcset = media_element.getAttribute("srcset");
  if (srcset) {
    media_element.setAttribute("srcset", "");
    if (media_element instanceof HTMLImageElement && !media_src) {
      let best = pick_srcset(srcset);
      if (best) media_src = best;
    }
  }

  if (!media_src || media_src.startsWith("data:") || media_src.startsWith("blob:")) {
    return;
  }
  
  media_element.src = media_src;
}

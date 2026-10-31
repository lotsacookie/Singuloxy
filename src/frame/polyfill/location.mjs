import * as loader from "../loader.mjs";

export let internal = null;

let fragment_hook = null;
let trace_count = 0;
const TRACE_LIMIT = 60;

export function set_fragment_hook(hook) {
  fragment_hook = hook;
}

export function trace_nav(kind, detail) {
  if (trace_count >= TRACE_LIMIT) return;
  trace_count++;
  let stack = "";
  try {
    stack = String(new Error().stack || "")
      .split("\n")
      .slice(3, 7)
      .map((line) => line.trim().slice(0, 150))
      .join(" | ");
  }
  catch {}
  try {
    console.log(`[nav-trace ${trace_count}] ${kind} ${detail} <= ${stack}`);
  }
  catch {}
}

const BOUNCE_WINDOW_MS = 2000;
const BOUNCE_PIN_MS = 5000;
const ROOT_HASHES = new Set(["", "#", "#!", "#!/", "#/"]);
let arrived_at = 0;
let pinned_until = 0;
let bounce_blocked = 0;

function is_root_url(href) {
  try {
    let url = new URL(href);
    return url.pathname === "/" || ROOT_HASHES.has(url.hash);
  }
  catch {
    return false;
  }
}

export function allow_url_change(from, to) {
  let now = Date.now();
  let from_root = is_root_url(from);
  let to_root = is_root_url(to);
  if (!to_root) {
    if (from_root) arrived_at = now;
    return true;
  }
  if (from_root) return true;
  if (now < pinned_until || now - arrived_at < BOUNCE_WINDOW_MS) {
    pinned_until = now + BOUNCE_PIN_MS;
    bounce_blocked++;
    if (bounce_blocked <= 3 || bounce_blocked % 50 === 0) {
      try {
        console.log(`[nav-guard] blocked bounce back to ${to} (staying on ${from}), total blocked: ${bounce_blocked}`);
      }
      catch {}
    }
    return false;
  }
  return true;
}

function without_hash(url) {
  let copy = new URL(url.href);
  copy.hash = "";
  return copy.href;
}

function navigate_fragment(target, replace = false) {
  let old_href = internal.href;
  if (old_href === target.href) return;
  if (!allow_url_change(old_href, target.href)) return;
  trace_nav(replace ? "fragment-replace" : "fragment", `${old_href} -> ${target.href}`);
  internal = target;
  loader.navigate(loader.frame_id, target.href, false);
  try {
    fragment_hook?.(target.href, replace);
  }
  catch {}

  if (target.hash.length > 1) {
    try {
      let element = document.getElementById(decodeURIComponent(target.hash.substring(1)));
      if (element) element.scrollIntoView();
    }
    catch {}
  }

  setTimeout(() => {
    globalThis.dispatchEvent(new PopStateEvent("popstate", { state: null }));
    globalThis.dispatchEvent(new HashChangeEvent("hashchange", {
      oldURL: old_href,
      newURL: target.href
    }));
  }, 0);
}

export class FakeLocation {
  constructor() {
    internal = new URL(loader.worker_url || loader.url);
    
    for (let key in internal) {
      if (key === "toString") continue;
      Object.defineProperty(this, key, {
        configurable: true,
        enumerable: true,
        get: () => {
          return internal[key];
        },
        set: (value) => {
          if (key === "href") {
            this.assign(value);
            return;
          }
          let next = new URL(internal.href);
          try {
            next[key] = value;
          }
          catch {
            return;
          }
          if (key === "hash") {
            navigate_fragment(next);
            return;
          }
          this.assign(next.href);
        }
      })
    }
  }

  assign(url, replace = false) {
    let target = new URL(url, internal);
    let has_fragment = String(url).includes("#") || target.hash !== "";
    if (has_fragment && without_hash(target) === without_hash(internal)) {
      navigate_fragment(target, replace);
      return;
    }
    trace_nav(replace ? "replace" : "assign", `${internal.href} -> ${target.href}`);
    internal = target;
    loader.navigate(loader.frame_id, internal.href);
  }
  replace(url) {
    this.assign(url, true);
  }
  reload() {
    trace_nav("reload", internal.href);
    loader.navigate(loader.frame_id, internal.href);
  }
  toString() {
    return this.href;
  }
}

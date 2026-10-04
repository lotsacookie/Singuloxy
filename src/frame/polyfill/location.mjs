import * as loader from "../loader.mjs";

export let internal = null;

function without_hash(url) {
  let copy = new URL(url.href);
  copy.hash = "";
  return copy.href;
}

function navigate_fragment(target) {
  let old_href = internal.href;
  if (old_href === target.href) return;
  internal = target;
  loader.navigate(loader.frame_id, target.href, false);

  if (target.hash.length > 1) {
    try {
      let element = document.getElementById(decodeURIComponent(target.hash.substring(1)));
      if (element) element.scrollIntoView();
    }
    catch {}
  }

  setTimeout(() => {
    globalThis.dispatchEvent(new HashChangeEvent("hashchange", {
      oldURL: old_href,
      newURL: target.href
    }));
  }, 0);
}

export class FakeLocation {
  constructor() {
    internal = new URL(loader.url);
    
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

  assign(url) {
    let target = new URL(url, internal);
    let has_fragment = String(url).includes("#") || target.hash !== "";
    if (has_fragment && without_hash(target) === without_hash(internal)) {
      navigate_fragment(target);
      return;
    }
    internal = target;
    loader.navigate(loader.frame_id, internal.href);
  }
  replace(url) {
    this.assign(url);
  }
  reload() {
    loader.navigate(loader.frame_id, internal.href);
  }
  toString() {
    return this.href;
  }
}

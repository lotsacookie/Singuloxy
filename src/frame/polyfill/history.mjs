import * as loader from "../loader.mjs";
import { ctx, convert_url } from "../context.mjs";
import { internal } from "./location.mjs";

export class FakeHistory {
  #entries;
  #index;
  scrollRestoration = "auto";

  constructor() {
    this.#entries = [{ state: null, url: internal ? internal.href : null }];
    this.#index = 0;
  }

  get length() {return this.#entries.length}
  get state() {return this.#entries[this.#index].state}

  #resolve(url) {
    if (url === undefined || url === null) return internal.href;
    let full_url = convert_url(String(url), ctx.location.href);
    if (new URL(full_url).origin !== internal.origin) {
      throw new DOMException("The history state cannot be changed to a different origin.", "SecurityError");
    }
    return full_url;
  }

  #sync_url(full_url) {
    if (internal.href === full_url) return;
    internal.href = full_url;
    loader.navigate(loader.frame_id, full_url, false);
  }

  pushState(state, unused, url) {
    let full_url = this.#resolve(url);
    this.#entries = this.#entries.slice(0, this.#index + 1);
    this.#entries.push({ state: state === undefined ? null : state, url: full_url });
    this.#index = this.#entries.length - 1;
    this.#sync_url(full_url);
  }

  replaceState(state, unused, url) {
    let full_url = this.#resolve(url);
    this.#entries[this.#index] = { state: state === undefined ? null : state, url: full_url };
    this.#sync_url(full_url);
  }

  go(delta = 0) {
    let amount = Number(delta) || 0;
    if (amount === 0) return;
    let target = this.#index + amount;
    if (target < 0 || target >= this.#entries.length) return;
    this.#index = target;
    let entry = this.#entries[target];
    if (entry.url) this.#sync_url(entry.url);
    setTimeout(() => {
      globalThis.dispatchEvent(new PopStateEvent("popstate", { state: entry.state }));
    }, 0);
  }

  back() {
    this.go(-1);
  }

  forward() {
    this.go(1);
  }
}

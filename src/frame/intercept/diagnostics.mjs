import { recent_misses, recent_misses_detailed } from "../context.mjs";

const reported = new Set();

if (typeof document !== "undefined" && typeof globalThis.addEventListener === "function") {
  globalThis.addEventListener("error", (event) => {
    let element = event.target;
    if (!element || element === globalThis || !element.tagName) return;

    let source = "";
    try {
      source = element.currentSrc || element.src || element.href || element.getAttribute("__src") || element.getAttribute("src") || element.getAttribute("href") || "";
    }
    catch {}

    let key = element.tagName + "|" + source;
    if (reported.has(key)) return;
    reported.add(key);

    let html = "";
    try {
      html = element.outerHTML.slice(0, 240);
    }
    catch {}

    console.warn("sandstone: resource failed to load:", element.tagName.toLowerCase(), source, html);
  }, true);
}

let reported_calls = new Set();
export function report_call(message, stack) {
    let text = String(message || "");
    if (!/is not a function/.test(text) || reported_calls.has(text) || reported_calls.size > 20) return;
    reported_calls.add(text);
    let trimmed = String(stack || "").split("\n").slice(0, 6).map((line) => line.trim().slice(0, 160)).join(" | ");
    console.warn("sandstone: " + text + " | recent undefined lookups: " + recent_misses().slice(-15).join(", "));
    console.warn("sandstone: deep trace for '" + text + "' | misses with call sites: " + recent_misses_detailed(25).join(" ;; "));
    if (trimmed) console.warn("sandstone: stack head: " + trimmed);
    try {
      let nav = globalThis.navigator;
      let probe = {
        webdriver: nav && nav.webdriver,
        languages: nav && nav.languages && nav.languages.length,
        plugins: nav && nav.plugins && nav.plugins.length,
        userAgentData: !!(nav && nav.userAgentData),
        cookieEnabled: nav && nav.cookieEnabled,
        crypto_subtle: !!(globalThis.crypto && globalThis.crypto.subtle),
        isSecureContext: globalThis.isSecureContext,
        crossOriginIsolated: globalThis.crossOriginIsolated,
        trustedTypes: typeof globalThis.trustedTypes,
        requestIdleCallback: typeof globalThis.requestIdleCallback,
        queueMicrotask: typeof globalThis.queueMicrotask,
        structuredClone: typeof globalThis.structuredClone,
        TextEncoder: typeof globalThis.TextEncoder,
        indexedDB: typeof globalThis.indexedDB,
        PerformanceObserver: typeof globalThis.PerformanceObserver,
        ServiceWorkerContainer: typeof globalThis.ServiceWorkerContainer
      };
      console.warn("sandstone: env probe " + JSON.stringify(probe));
    }
    catch {}
  }

if (typeof globalThis.addEventListener === "function") {
  globalThis.addEventListener("unhandledrejection", (event) => {
    let reason = event && event.reason;
    report_call(reason && reason.message ? reason.message : reason, reason && reason.stack);
  });
  globalThis.addEventListener("error", (event) => {
    report_call(event && event.message, event && event.error && event.error.stack);
  });
}

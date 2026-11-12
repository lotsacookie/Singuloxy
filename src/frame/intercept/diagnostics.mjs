import { recent_misses } from "../context.mjs";

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

if (typeof globalThis.addEventListener === "function") {
  let reported_calls = new Set();
  let report_call = (message) => {
    let text = String(message || "");
    if (!/is not a function/.test(text) || reported_calls.has(text)) return;
    reported_calls.add(text);
    console.warn("sandstone: " + text + " | recent undefined lookups: " + recent_misses().slice(-15).join(", "));
  };
  globalThis.addEventListener("unhandledrejection", (event) => {
    let reason = event && event.reason;
    report_call(reason && reason.message ? reason.message : reason);
  });
  globalThis.addEventListener("error", (event) => {
    report_call(event && event.message);
  });
}

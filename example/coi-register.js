// Registers coi-sw.js and reloads once so the page becomes crossOriginIsolated.
(() => {
  if (window.crossOriginIsolated || !("serviceWorker" in navigator) || !window.isSecureContext) return;
  if (sessionStorage.getItem("coi-reloaded")) return; // avoid reload loops
  navigator.serviceWorker.register(new URL("coi-sw.js", document.currentScript.src).href).then((reg) => {
    const reload = () => { sessionStorage.setItem("coi-reloaded", "1"); location.reload(); };
    if (reg.active && !navigator.serviceWorker.controller) reload();
    else reg.addEventListener("updatefound", () => {
      reg.installing?.addEventListener("statechange", (e) => { if (e.target.state === "activated") reload(); });
    });
  }).catch((e) => console.warn("coi: service worker registration failed", e));
})();

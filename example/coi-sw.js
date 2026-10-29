// Cross-origin isolation shim for hosts that cannot set COOP/COEP headers
// (GitHub Pages, static hosts). Serve this file from the SAME ORIGIN and
// scope as the page that loads sandstone, and register it before sandstone.
// Needed so SharedArrayBuffer / pthreads work for Emscripten wasm clients.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.cache === "only-if-cached" && req.mode !== "same-origin") return;

  // credentialless COEP: cross-origin no-cors subresources must not send credentials
  const r = (req.mode === "no-cors" && new URL(req.url).origin !== self.location.origin)
    ? new Request(req, { credentials: "omit" })
    : req;

  event.respondWith(
    fetch(r).then((res) => {
      if (res.status === 0) return res; // opaque, leave untouched
      const headers = new Headers(res.headers);
      headers.set("Cross-Origin-Opener-Policy", "same-origin");
      headers.set("Cross-Origin-Embedder-Policy", "credentialless");
      headers.set("Cross-Origin-Resource-Policy", "cross-origin");
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
    }).catch((err) => { console.error("coi-sw fetch failed", err); return Response.error(); })
  );
});

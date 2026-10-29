# Cross-origin isolation (Roblox web client, Unity threads, any pthread wasm)

Sandstone has no service worker, so it cannot add headers itself. Emscripten pthreads need
`SharedArrayBuffer`/shared `WebAssembly.Memory` posted to workers, which browsers only allow when
`self.crossOriginIsolated === true`. That is decided by the TOP-LEVEL page, so the page you load
sandstone on (and every page between it and the proxy iframes, e.g. an embed iframe) must send:

    Cross-Origin-Opener-Policy: same-origin
    Cross-Origin-Embedder-Policy: credentialless

and any embedding iframe needs `allow="cross-origin-isolated"`. Sandstone's own frames already set it
and inherit the policy because they are blob/srcdoc documents.

Check in the console: `crossOriginIsolated` must be `true` on the top page AND inside the embed.

## Setting the headers (pick what your host is)

- Cloudflare (any host proxied by it): Rules > Transform Rules > Modify Response Header > set both headers above.
- Cloudflare Pages / Netlify: add a `_headers` file at the site root:

      /*
        Cross-Origin-Opener-Policy: same-origin
        Cross-Origin-Embedder-Policy: credentialless

- Vercel `vercel.json`:

      {"headers":[{"source":"/(.*)","headers":[
        {"key":"Cross-Origin-Opener-Policy","value":"same-origin"},
        {"key":"Cross-Origin-Embedder-Policy","value":"credentialless"}]}]}

- nginx: `add_header Cross-Origin-Opener-Policy same-origin always; add_header Cross-Origin-Embedder-Policy credentialless always;`
- GitHub Pages cannot set headers; put Cloudflare in front or move the host.

`credentialless` needs Chromium (Chrome/Edge). Cross-origin popups/OAuth logins on the top page lose `window.opener` under COOP.

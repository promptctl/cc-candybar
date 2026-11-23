# Feeds, transport and security for a browser surface

An inventory read from the code, plus the requirements any browser listener has to meet. Verify a claim against the code before building on it. Decisions live in the design docs, which override anything here.

## What exists

- **One feed per session.** `FrameFeeds` in `src/daemon/frame-feed.ts` keeps one feed for each session, and a feed draws one frame at one width.
- **Session discovery.** `src/bar-pane/index.ts` receives a pane id and asks the daemon for the session in that pane on a tick (`trySessionInPane`), because a `/clear` changes the session id in the pane. `src/daemon/pane-visibility.ts` is how the daemon knows a pane is on screen.
- **Backpressure.** `src/utils/newest-wins.ts` takes any `Writable`, holds one pending chunk, and writes it on `drain`.
- **No listener in `src/`.** The only listener is the unix socket, whose parent directory is owned, mode 0700, and not a symlink.
- **A dev harness.** `scripts/bar-web/server.ts` serves one bar over `node:http`, with a page (`scripts/bar-web/index.html`) and a font (`scripts/bar-web/rich-powerline.woff2`, with its `FONT-LICENSE`). It checks `Host` and takes JSON-only requests, and it is not meant to ship.
- **The site.** `site/build.mjs` bundles the daemon's own modules for a browser, with Node modules shimmed (`site/shims/`).
- **Node.** `engines` in `package.json` is `^20.19.0 || >=22.12.0`. `WebSocket` there is a client global, and no WebSocket server is built in, so one needs a dependency or hand-written framing. The package has no runtime `dependencies`: everything is bundled.

## What a loopback listener has to meet

Loopback TCP has neither the unix socket's directory protection nor its file mode. Any local process and any browser page can reach it, so every data route needs a token. A page that can read frames can fire clicks, because frames carry session ids and signed `run` and `repo-config` links, and any web page can open a `cc-candybar://` link (`src/click/link-signer.ts`). Frame-read auth has to be as strong as click auth.

- **Bind** `127.0.0.1` only.
- **Token:** 32 random bytes in a 0600 file.
- **Delivery:** a one-time code in the URL fragment, because `open`'s argv is visible to other processes. The page exchanges it for the token, keeps it in `sessionStorage`, and strips it with `history.replaceState`.
- **Host:** exact match on `127.0.0.1:<port>` on every request, including the upgrade. Answer anything else with 421, which stops DNS rebinding.
- **Origin:** exact match on the upgrade and on any POST, because a WebSocket has no CORS.
- **WebSocket auth:** the token in the first message, with a short deadline.
- **Headers:** no CORS headers. A strict CSP (`default-src 'none'`, `connect-src` set to self, `frame-ancestors 'none'`), no CDN, and `no-store`.
- **Rendering:** page text through `textContent` only, because frames carry branch names and paths. A link never goes into `<a href>`.
- **Clicks:** the page never opens a link. It sends a link id, and the host resolves it against the frame it last drew for that surface, so a stale click finds nothing and no signed URL reaches the page.
- **Logging:** never log the token.
- **Tests:** an isolated test daemon must not fight the real one for a port, and a listener's `EADDRINUSE` must never reach the socket's exit path.

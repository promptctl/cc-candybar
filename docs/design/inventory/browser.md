# Feeds, lanes, transport, security, packaging

A subagent's read-only inventory of the code at commit 10f26ceb, kept verbatim so the investigation isn't repeated. Verify a claim against the code before building on it. Decisions live in the design docs, which override anything here.

---

**`/tmp/ccb-probe/findings-browser.md` was not written.** This agent runs read-only and is barred from creating any file, including in `/tmp` and including findings `.md` files. The complete findings are below instead of the path and summary you asked for; the parent can save them.

Summary:
1. Keep one feed per session; a second width needs per-width draw memory, and depth is never per-subscriber.
2. Make `browser` a lane with `handsOff: false`, using a daemon-owned loopback WebSocket listener, a token, and a Host and Origin gate.
3. The biggest conflict: today's rows of styled runs are decoded from ANSI inside the daemon (`src/band/frames.ts`).

All paths are relative to `/Users/bmf/code/cc-candybar/.claude/worktrees/synthetic-zooming-wind`. Claims come from code I read, except where marked as outside the repo.

## Three findings that change the design

**A. The structured frames are decoded from ANSI.**
- `bandFrame` in `src/band/frames.ts` runs `new AnsiDecoder().decode(ansi)` on the composed output. `src/tmux-status/frames.ts` does the same.
- Reusing `bandResponse` means the page decodes nothing, but ANSI is still decoded in the daemon.
- If the owner's rule covers the whole path, a new tap is needed. `draw()` in `src/render/strip.ts` holds rich-js `segments` and immediately calls `segmentsToString`.
- `DrawnRow`, `DrawnFrame.text`, `DrawnBar.body`, `viewerRows`, `handoffRows` and `planOutcome` are all strings, so every one of those joins would have to carry structure too.
- **The owner must say which reading applies.** I read it as the stricter one: the whole path.

**B. A second width cannot simply be a second draw on the same view.** See Q1. `FrameMemory` and `SessionEffects` each hold one last frame per view or session.

**C. A page that can read frames can fire clicks.** Frames carry session ids and signed `run` and `repo-config` URLs. Any web page can open a `cc-candybar://` link (`src/click/link-signer.ts`), so frame-read auth must be as strong as click auth.

## 1. Feed, width, rows, depth

**Is there one feed?** Yes. `FrameFeeds` in `src/daemon/frame-feed.ts` keeps `feeds = Map<sessionId, Feed>`. A feed has one timer (`Phase`), and `deps.render(sessionId, fps, at)` takes no width, rows or depth.

**How each value is chosen:**
- **Width:** `drawRender` in `src/daemon/server.ts` reads `view.facts().hints`, then calls `renderWidth(hints)`. That is `applyClaudeCodeReserve(hints.termCols ?? DEFAULT_TERMINAL_WIDTH)`, which is 120 less 2 (`src/daemon/render-payload.ts`, `src/render/strip.ts`, `src/utils/terminal-width.ts`). So the width comes from the request the view is declared with.
- **Rows:** no row count is passed. The row count is whatever the draw produces at that width. The only cap is the diagnostics viewer: `viewerRowCap(hints.termRows, surfaceRows)`, capped at `MAX_VIEWER_ROWS` = 20. For a feed, it also applies each switched-on lane's `LANES[lane].rows`, and tmuxStatus has 5. `src/daemon/tmux-status.ts` then slices rows further.
- **Depth:** `effective.colorCompatibility`, a config setting (`renderOptionsOf`). It is not a client hint. The comment in `src/daemon/protocol.ts` calls client-aware `auto` "documented-but-unbuilt". The view's parts read the depth from the payload (`src/dsl/parts.ts`).

**The quoted phrase** is in `.claude/memory/rendering.md`, not `frames-and-lanes.md`. It sits in the viewer's bounds, and the matching code comment is in `src/daemon/server.ts`. It means one drawn frame, at one geometry, goes to every lane, so the viewer pages within the shortest surface that shows it. Each frame has two answers, `bar` and `statusline` (`FeedFrame`, `answerOf`).

**State keyed by `drawing.by`:**
- `renderWarnings` holds one record per session and renderer, because the two draw "at their own widths and roots" (`src/daemon/render-warnings.ts`).
- `RenderCache.copies` is written by `delivered`, read by `drawnCopy`, and retired by `stopDrawing` when a feed closes (`src/daemon/cache/render.ts`).
- `collectDiagnostics` and `viewerRows` take it. `copy-diagnostic` links carry it, and `requireDrawer` allows only `request` and `feed` (`src/daemon/verbs/index.ts`).
- `clickErrorAt` decides whether a click error is still owed (`src/daemon/click-error.ts`).
- The rate cell in `src/config/settings-menu.ts` reads it.

**What is not keyed by `by`, and blocks a second width:**
- `FrameMemory` holds one `last` per view, and `from(source)` returns nothing when `source.width` differs (`src/render/frame-memory.ts`).
- `SessionEffects` holds one set of placements, passages and anchor per session (`src/render/effect.ts`).
- Alternating two widths on one view would make each draw find no comparable last frame. Appearing and leaving fades stop, and held loading cells are lost.
- `bindPayload` does override `term.cols` from `opts.width` (`src/dsl/render.ts`), so a draw at another width is possible by parameter. Its effect on keyed sources and on the view's wake reaction is **unknown**; I did not trace it.

**Rejected options:**
- **Feed per (session, width, depth):** a second feed collides on `by: "feed"`, and closing either one calls `stopDrawing` for both. It also adds timers and draws, against the daemon's stated budget of 24 sessions at 30 fps on one thread (`src/daemon/pane-visibility.ts`).
- **The browser sending a render request with its own `termCols`:** that declares the view for every other subscriber, so it should not be done.

**Recommendation:**
- Keep one feed per session.
- First version: the page draws the session's frame at the session's width and scales or scrolls it.
- If reflow is required, add a per-width "surface" inside the one feed with one clock. Key `FrameMemory` and `SessionEffects` by width, and add a third `Drawing` arm so `copies` and warnings stay separate.
- Depth never varies per subscriber. The page draws whatever the session draws, and it needs a palette for the sixteen named colours (`runColor`).

## 2. Adding `browser`: lane or subscriber

**Compile-enforced tables (Record over `Lane`):**
- `LANES` in `src/config/lanes.ts`
- `LANE_FRAMES` in `src/daemon/lane-frames.ts`
- `LANE_SETUP` in `src/daemon/lane-setup.ts`
- `LANE_HELP` in `src/help-text.ts`

**Derived automatically from `LANES`, `perLane` or `LANE_NAMES`:**
- `LANE_ROWS` in `src/config/globals-fields.ts`
- Menu rows and `laneReadout` in `src/config/settings-menu.ts`
- `feeds.<lane>.*` in `src/config/payload-inputs.ts`
- `laneSwitches` in `src/config/effective-globals.ts`
- `laneOffReason` in `src/config/menu-places.ts`
- `feedsFact`, `feedsOf` and `UNFOLLOWED_FEEDS`
- `handedOffTo`
- The render event's `lanes` fact
- `geometry.rows` in `src/daemon/server.ts`
- `parseLane`, and subscribe's error text
- The `frames --lane` check in `src/frames-cli.ts`
- The hint in `src/doctor/checks.ts`

**Manual, not compiler-checked:**
- `LANE_NAMES: [&str; 4]` and the test strings in `rust-client/src/follow.rs`, policed by `scripts/check-protocol.mjs`
- `schema/cc-candybar.schema.json` via `gen:schema`
- The settable-keys list in `docs/interaction-authoring.md`
- A new arm on the `Response` union in `src/daemon/protocol.ts`
- `SubscribeRequest`'s `lane` type follows `Lane` automatically
- `scripts/vendor-cc-extra.mjs` also matched my lane search; I did not read why.

**What a switch implies:**
- A setting, a menu row and a readout, plus the subscribe gate. A lane switched off mid-stream is ended with `SWITCHED_OFF` in `push`.
- Setup runs only for the session's own click that moved the switch (`LaneSetups.clicked`). The plan is whatever `LANE_SETUP` says.
- Claude Code relaunches only for `statusline`, and that is that lane's own plan, not a general rule.
- The handoff row appears only when `handsOff` is true, the lane is on, and it is followed.

**Costs:**

| | Lane | Subscriber kind |
|---|---|---|
| Fit | "A lane is a subscriber" (`src/config/lanes.ts`) | `Subscriber.lane` is required, so `rates`, `feedsOf`, `answerOf` and `feedsFact` all need a parallel path |
| Gets for free | Compile totality, rate readout, feed facts, gate | Nothing |
| Costs | Rust mirror and a schema key; a switch is per config while a listener is per daemon | Browser becomes invisible to `feeds=` and the readout unless that is duplicated |
| Setup | Needs a plan, though it can be trivial | None |

**Recommendation:**
- Make it a lane with `handsOff: false`, so closing a tab never touches Claude Code's bar.
- Use `inTmux: false` and a `browser` setting, without the 🧪 label if it is fully supported.
- Setup does no relaunch. `on` reports the URL. `off` is "nothing to stop", and subscribers are refused.
- Listener lifetime stays separate from the switch (see Q5).

## 3. Session discovery

**Today:** `drawBarPane` in `src/bar-pane/index.ts` receives a pane id and polls `trySessionInPane(socket, pane)` every 500 ms. The `pane-session` request answers with `frameFeeds.newestWhere(...)`. It re-asks because `/clear` changes the session id in the pane. The band mod gets the id from `$.session.id()`.

**What exists:**
- `FrameFeeds.requests` holds the latest request per session (at most 256, private). `newestWhere`, `latest` and `watched` read it. It holds hook data and hints.
- `stats.clients` from `RenderSightings` gives session id, `ago`, role, `termCols`, `projectDir`, transcript, `claudeConfigDir` and client, capped at 64. It holds no tmux hint.
- `watched()` covers followed sessions only.

**What is missing:**
- A public list of sessions.
- Liveness. Entries only age, and nothing marks a session ended. `SessionState` persists and is never pruned, so it cannot serve as a list.
- Display labels. The tmux hint is not in sightings.
- Any listing that survives a restart, since both stores are in memory and rebuild on the next render.

**Recommendation:**
- Add `FrameFeeds.sessions()` returning the latest request per session.
- Add a listing that checks each candidate's pane with `tmux list-panes`, off the frame path.
- Address a page by (tmux socket, pane), not session id, and resolve through `newestWhere`, as the bar pane does, so `/clear` is followed.
- A menu button or CLI command can name its own session directly.

## 4. Rate and backpressure

- **`newestWins`** (`src/utils/newest-wins.ts`) takes any `Writable`, holds one pending chunk, and writes it on `drain`. It works on a raw socket and should work on `http.ServerResponse`. I did not test the latter.
- **Dedupe and rates:** unchanged bytes are not pushed. A feed's ceiling is 30 fps while shown and 1 fps while not (`spacingOf`, `schedule`).
- **Encoding cost:** `LANE_FRAMES[lane]` runs per subscriber in `stream` (`src/daemon/server.ts`), so a decoding encoder costs one pass per tab per frame.
- **Visibility:** `deps.shown(req)` is `paneVisibility.shown(hints.tmux)`, a session-wide answer from a 1 s tmux poll that runs only while a feed exists.
- **The gap:** if the tmux pane is hidden and the browser tab is visible, the page gets 1 fps. `drawing()` does not cover this, because it feeds `following` and so handoff.

**Recommendation:**
- Add a `seen(): boolean` on `Subscriber`. `FrameFeeds.shown` becomes `deps.shown(req) || any follower seen`.
- The page reports `visibilitychange` over its connection. The daemon stores it per subscriber and calls `wake(sessionId, "visibility")`.
- A dropped connection clears it through unsubscribe.
- Unknown: whether `document.hidden` reports an occluded window on macOS. This repo cannot answer that.

## 5. Transport

- **No server in `src/`.** The only listener is the unix socket in `runDaemon`. `node:https` is used as a client in `src/segments/pricing.ts`.
- **`scripts/bar-web/server.ts`** is a dev harness: `node:http`, importing `test/helpers/drive-bar`, one bar, serial POSTs, assets read from disk. It shows Host checking (421) and JSON-only requests, but it must not ship.
- **Node:** `engines` is `^20.19.0 || >=22.12.0`. This machine runs v26.7.0, where `WebSocket` is a client global, and there is no `WebSocketServer`, no `EventSource`, and no WebSocket builtin module. So no WebSocket server exists without a dependency or hand-written framing.
- **A mismatch to flag:** `tsdown.config.ts` targets `node18`, below `engines`.
- **Dependency rule:** I found no written rule (CLAUDE.md has no such text). What I found in practice:
  - `package.json` has no `dependencies` at all, and everything is a devDependency bundled by `noExternal: [/./]`, so the standalone URL handler needs no `node_modules`.
  - There are no lifecycle scripts.
  - `dist/index.mjs` is about 1.17 MB.

**Daemon lifecycle:**
- `runDaemon` registers signal and crash funnels, parses limits, runs the fork-bomb breaker and creates the state directory.
- It then runs `ensureSocketParentSafe`, loads storage, and binds in `bindOrAttachAndExit`.
- Post-bind work runs in `onListening`: lease, chmod 0600, then arming the watches.
- `shutdown` has a sync `teardown` array plus an unref-free 500 ms SIGKILL backstop. Nothing unlinks the socket.

**Where the listener belongs:**
- New module `src/daemon/browser-listener.ts`, with dependencies injected as `FrameFeeds` does.
- Start it in `onListening`, so only the daemon that won the socket binds.
- Add one `teardown` row.
- Its `error` handler must log and continue. An `EADDRINUSE` here must never reach the socket's exit path.
- An isolated test daemon must not fight the real one for a port.
- Daemons restart routinely, so an open tab needs the same port back. Persist `{port, token}` in a 0600 state file, following the `src/daemon/link-key.ts` create pattern. The file's presence means the listener is wanted, so non-users bind nothing.
- `site/build.mjs` aliases `http` to a shim, and `site/shims/unavailable.ts` defines `createServer` as a throwing stub, so the site build should survive as long as the listener is never started there. I did not run it.

**Transport recommendation:** a small in-repo WebSocket on `node:http`'s `upgrade` event, with no dependency.
- `upgrade` yields a `net.Socket`, so `newestWins(sock)` works as it does on the unix socket.
- Clicks and visibility share the connection.
- SSE plus POST is simpler, but browsers cap HTTP/1.1 connections per origin at about 6 (knowledge from outside this repo, not verified here). With one tab per session, across two dozen sessions, streams would starve and clicks would queue.
- If one page always multiplexes all sessions, SSE becomes viable.

## 6. Security

**Today's model:**
- The link signer assumes any web page can open `cc-candybar://`. Only `run` and `repo-config` carry MACs.
- The unix socket's trust is the filesystem: parent `ensureOwnedPrivateDir` (owned, 0700, no symlink), plus socket 0600.
- Loopback TCP has neither protection. Any local process, under any uid, and any browser page can reach it. So every data route needs a token.

**Page requirements:**
- **Bind:** `127.0.0.1` only, with the literal in the URL.
- **Token:** 32 random bytes in a 0600 file.
- **Delivery:** the CLI or a verb runs `/usr/bin/open` with a one-time code in the URL fragment. The page exchanges it for the token, stores it in `sessionStorage`, and strips it with `history.replaceState`. Use a one-time code because `open`'s argv is visible in `ps`. Fragments stay out of server logs and Referer (browser behaviour, from outside this repo).
- **Host:** exact match on `127.0.0.1:<port>` on every request, including `GET /` and the upgrade. Answer anything else with 421, as `scripts/bar-web/server.ts` does. This stops DNS rebinding.
- **Origin:** exact match on the upgrade and on any POST. WebSocket has no CORS, so this check is mandatory.
- **WebSocket auth:** token in the first message, with a short deadline.
- **Headers:** no CORS headers ever. A strict CSP with `default-src 'none'`, `connect-src` set to self, `frame-ancestors 'none'`, and no CDN. `no-store` on responses.
- **Rendering:** page text through `textContent` only, because frames carry branch names and paths. Hrefs never go into `<a href>`.
- **Logging:** never log the token.

**Recommendation:** adopt this list as the listener's only gate, one enforcer in the new module.

## 7. Clicks from a page

**Today:**
- `site/transport.ts` calls `replyTo` with `kind: "render"` and `kind: "click"` directly.
- `scripts/bar-web` posts `/render`, `/click` and `/restart`, and clicks through `bar.follow(url)`, which refuses a link no longer drawn (409).

**Link kinds:**
- `cc-candybar://dispatch/e=…`
- Direct `cc-candybar://<verb>/…`
- Bare `cc-candybar://<value>`, which means copy (`parseHandlerUrl`)
- Others: `mod/types` names `https:` and `file:` targets. Anything not ours is "the terminal's to open" (`isBarLink`).
- Internal only: `tmux-status-click`.

**`HOST_VERBS`** (`src/click/read.ts`) lists copy, copy-diagnostic, open-vscode, apply-update and run. It is not a daemon gate. It is a filter that driven bars apply themselves, because they are not real sessions. A real page sits beside a real session, so the filter should not apply. The daemon runs `pbcopy`, `open` and so on, on the same Mac, so the page needs no `navigator.clipboard` or user-gesture handling.

**Recommendation: one path.**
- The page never opens a link. It sends a link id.
- The daemon resolves that id against the frame it last drew for that surface, as `tmuxStatusLines.linkAt` and `rangeOf` do. A stale click finds nothing.
- `cc-candybar://` goes to `handleClick`. Anything else goes to `clickLaunch` with `/usr/bin/open`, as in `statusLineClick`.
- This also keeps signed URLs out of the page.
- Add `via: "browser"` to `ClickArrival` (`src/doctor/sightings.ts`), and to the `VERB_FACT` table in `src/daemon/server.ts`. Do not route through `replyTo`'s click path unchanged: `clickOutcome` stamps `via: "link"`, which would tell the doctor a URL-handler or terminal link worked when it never ran.

## 8. Packaging

**Site:** `site/build.mjs` uses esbuild to bundle the daemon's own modules for the browser. Node modules are shimmed (`site/shims/`), fs and child_process are simulated, and `transport.js` is about 2.97 MB. xterm 5.3.0 and two addons load from the jsDelivr CDN, with SRI on the stylesheet tag I read (I did not read past the first script tag's attributes). None of this belongs in a real renderer: it needs internet and decodes ANSI in xterm.

**What a real renderer needs:** a page, a small script, `rich-powerline.woff2` (20,916 bytes, covering U+E0A0–E0D7 only) and `FONT-LICENSE`. Nerd Font glyphs outside that range are not covered.

**Install:** `runStageRuntime` in `src/install/index.ts` stages `dist/index.mjs`, `dist/cc-extra`, `dist/attach-preload.cjs` and the render entry, each with an existence check. `package.json` `files` already includes `dist`, so anything in `dist` ships in the npm package. Disk assets would need a new stage row and check, and a torn stage is possible because the bundle is copied first.

**Recommendation:** embed the assets in the bundle.
- Page, script and font become strings. Page version then always equals daemon version, and the binary watch handles upgrades.
- tsdown 0.21.10 exposes a `loader` option, but I did not test text or base64 use.
- `FONT-LICENSE` must still ship, so copy it to `dist` or serve it.
- Put page source under `src/`, so `sourceDigest` covers it.
- `tsconfig.json` has `lib: ["ESNext"]` with no DOM lib, so page code needs its own typing, as `site/transport.ts` does for `navigator`.

## 9. Doctor

Checks are data in `CHECKS` (`src/doctor/checks.ts`), run by one fold over facts from two edges: the menu click and the CLI. Probes are pure, must not block the loop, and the CLI reads through the daemon.

**A new surface must add:**
- A `browser` check with `takesMark: false`, covering:
  - whether the lane or listener is wanted
  - whether it is bound
  - whether the state file is 0600
  - whether the listener's own Host and Origin refusals hold
  - whether a browser subscriber was recently seen
- New `DoctorFacts`, gathered in `src/doctor/edge.ts` and `src/doctor/cli.ts`.
- New stats fields in `src/daemon/stats.ts`, and strict parsing in `src/doctor/daemon-answer.ts`.
- Event fields in `src/doctor/report.ts`.
- Handling of `via: "browser"` in `clickArrived` and the `links` check. As `.claude/memory/frames-and-lanes.md` says of tmux clicks, a browser click proves nothing about the URL handler or terminal links.
- The self-probe must be asynchronous at the edge.
- Terminal checks (Nerd Font, `tmux truecolor`, UTF-8) do not apply to a page and must not read as passing for it.

**Recommendation:** one `browser` check, plus the `via` arm, shipped in the same change as the listener. A browser subscriber sends no render request, so `RenderSightings` will never see it, and the fact has to come from `frameFeeds` stats.

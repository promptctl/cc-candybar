# Browser surface

Status: design, nothing built. [The Frame](areas/frame.md) it depends on is built. Tickets: `candybar-browser-surface-97sw`.

## Goal

The browser is a fully supported render target for any user with the prerequisites: an Apple Silicon Mac, tmux and Claude Code. iTerm2 is not a prerequisite, so nothing below depends on it.

## Shape

```
renderer ──Frame──▶ browser encoder ──WebSocket──▶ page
page ──link id──▶ renderer's event queue
```

The browser is one more surface. The page is a Frame painter with no renderer of its own, so there's still one render path. It paints rows of runs as elements and decodes nothing.

## Decisions

### A surface, not a new kind of subscriber

`Subscriber.lane` is required, and rates, `feedsOf`, `answerOf` and `feedsFact` all key on it. A surface gets compile-time totality, the rate readout and feed facts for free. A separate subscriber kind would need parallel paths for each, and it would be invisible to `feeds=`.

`browser` is a `LANES` entry with `handsOff: false`, so closing a tab never touches Claude Code's bar, and `inTmux: false`. Its setup does no relaunch: turning it on reports the URL.

Adding a surface touches `LANES`, `LANE_FRAMES`, `LANE_SETUP` and `LANE_HELP`, which the compiler enforces, and these by hand: `LANE_NAMES` in `rust-client/src/follow.rs` (policed by `check-protocol`), the schema, and `docs/interaction-authoring.md`.

### One feed, the session's width and depth

`FrameFeeds` keeps one feed per session with one timer. Width comes from the session's latest request, and depth is a config setting.

**The first version draws at the session's width and the page scales it.** A second width isn't a parameter: `FrameMemory` and `SessionEffects` each hold one last frame, and alternating widths would stop fades and lose held cells. Sending the browser's own width as a render request would redeclare the view for every other subscriber, so that's ruled out.

If reflow is wanted, it becomes a per-width surface inside the one feed, with those stores keyed by width and a third `Drawing` arm. A feed per width collides on `by: "feed"` and adds timers against a budget of 24 sessions at 30 fps on one thread.

All modern browsers are truecolor. A Frame is drawn for one depth, so a browser surface wants truecolor frames even for a session configured lower. That makes depth, like width, a per-surface draw input, which this document hasn't worked through.

### Transport: a small WebSocket on `node:http`

Node has no WebSocket server, and `package.json` has no runtime dependencies, because everything is bundled so the URL handler runs without `node_modules`. So this is an in-repo implementation on the `upgrade` event, text frames only.

| | SSE plus POST | In-repo WebSocket |
|---|---|---|
| Measured at 30 fps, real sparkle frames | 29.6 fps, 0.23 ms DOM, 186 KB/s | 30 fps, 0.22 ms DOM, 201 KB/s |
| Click round trip | 1.6 ms | 0.3 ms |
| Clicks and visibility | A second connection, unordered | The same connection, ordered |
| Connections per origin | Limited to about six over HTTP/1.1, which one tab per session would hit | One each |
| Code | Less | About 40 lines of framing, parsed by hand |

WebSocket wins on ordering and on the connection cap. `upgrade` yields a `net.Socket`, so `newestWins` works as it does on the unix socket. The hand-written parser is an attack surface, so it takes only short masked text frames from an authenticated client, and everything else closes the connection.

### Listener

`src/daemon/browser-listener.ts`, started in `onListening`, so only the renderer that won the socket binds. One `teardown` row. Its `error` handler logs and continues, because an `EADDRINUSE` must never reach the socket's exit path.

Renderers restart routinely, so an open tab needs the same port back. `{port, token}` persists in a 0600 state file, using the `link-key.ts` create pattern. The file's presence means the listener is wanted, so a user who never asks for a browser binds nothing. An isolated test renderer must not contend for a port.

### Security

Loopback TCP has none of the unix socket's protection: any local process and any browser page can reach it. Frames also carry session ids, paths and branch names. This list is the listener's one gate:

- Bind `127.0.0.1` only, with the literal in the URL.
- A 32-byte token. The CLI or a verb opens the page with a one-time code in the URL fragment, because `open`'s argv is visible in `ps`. The page exchanges it, keeps the token in `sessionStorage`, and strips the fragment.
- Exact `Host` match on every request, including `GET /`, answering 421. This stops DNS rebinding.
- Exact `Origin` match on the upgrade. WebSocket has no CORS, so this is mandatory. The probe dropped a foreign Origin.
- The token is the first WebSocket message, with a short deadline.
- No CORS headers. CSP `default-src 'none'` with `connect-src` self and `frame-ancestors 'none'`. No CDN. `no-store`.
- Page text goes through `textContent` only. Links never become `<a href>`.
- The token is never logged.

### Clicks

There's one path, and the page never sees a signed URL. The browser encoder replaces each link with an id, and the page sends that id back. The renderer resolves it against the frame it last drew for that surface, as `tmuxStatusLines.linkAt` does, so a stale click finds nothing.

- `cc-candybar://` goes to `handleClick`.
- Anything else goes to `clickLaunch` with `/usr/bin/open`, as `statusLineClick` does.
- A new `via: "browser"` in `ClickArrival` and `VERB_FACT`. It must not use `replyTo`'s click path unchanged, which stamps `via: "link"` and would tell the doctor the URL handler worked when it never ran.

The renderer runs `pbcopy` and `open` on the same Mac, so the page needs no clipboard API. `HOST_VERBS` isn't a gate; it's a filter for driven bars, and a real page sits beside a real session.

**Read the link at `pointerdown`, not on `click`.** Elements are replaced on every frame, so a press and release at 30 fps land on different nodes, and the browser then fires `click` on their common ancestor. This is expected browser behaviour; I didn't reproduce it with a real mouse. Keeping unchanged nodes across frames would also address it, but press-time reading needs no diffing.

### Which session a page shows

A page is addressed by tmux socket and pane, not session id, so `/clear` can't strand it. It's told its pane's session the way a bar pane is, per [tmux events](areas/tmux-events.md).

Missing today:

- A public list of sessions. `FrameFeeds.requests` holds it privately, so add `sessions()`.
- Liveness. Entries only age, so the listing checks each pane with `tmux list-panes`, off the frame path.
- Labels. The tmux hint isn't in sightings.

A menu button or CLI command opens a page for its own session directly.

### Rate

`shown` comes from tmux pane visibility, so a hidden pane gives a visible tab the off-screen rate. `Subscriber` gains `isVisible()`, and `FrameFeeds.shown` becomes `deps.shown(req) || any follower isVisible`. Only the browser needs this: tmux surfaces get their visibility from [the control connection](areas/tmux-events.md). The page reports `visibilitychange` over its connection, and a dropped connection clears it. The probe confirmed the message arrives. Whether `document.hidden` reports an occluded window on macOS is unknown.

### Packaging

The page, its script and `rich-powerline.woff2` are embedded in the bundle, so the page's version always equals the renderer's and nothing new needs staging. `FONT-LICENSE` must still ship. The source lives under `src/` so `sourceDigest` covers it, with its own typing, since `tsconfig.json` has no DOM lib. tsdown's `loader` option for embedding is untested.

The font covers U+E0A0–E0D7 only, so other Nerd Font glyphs need a decision when the page is built. `site/` isn't a starting point: it bundles the whole daemon with shims and loads xterm from a CDN.

### Doctor

One `browser` check with `takesMark: false`: is the listener wanted, is it bound, is the state file 0600, do its own Host and Origin refusals hold, was a subscriber seen recently. `RenderSightings` never sees a browser, so that fact comes from `frameFeeds` stats. Terminal checks don't apply to a page and must not read as passing for it. As with tmux, a browser click proves nothing about the URL handler. This ships with the listener.

## Where the window lives

The renderer is a page, so any browser can show it. Two ways to put it beside Claude Code came out of this session. Neither is required.

**A floating borderless panel.** A small Swift WebKit panel worked and you liked it; the source is [probes/float.swift](probes/float.swift). It covered the input box, because nothing ties it to a terminal window. Following a window needs the Accessibility API or a terminal's own API, because macOS only attaches windows within one app. Untried.

**An iTerm2 browser pane.** It requires iTerm2, so it can only ever be an option, and it needs the browser plugin. Through the Python API: split with `profile_customizations` `set_use_custom_command("Browser")`. The URL given at split time is ignored while the welcome page shows, so call `session.async_load_url` after the split. Height responds to `preferred_size` plus `tab.async_update_layout`, in fake units. Hiding the toolbar is refused by iTerm2 3.7.6.

## Evidence

Scripts are in [probes/](probes/README.md).

| Claim | Check | Result |
|---|---|---|
| A page keeps up | Real sparkle frames, 30 fps, 10 s, elements rebuilt each frame | About 30 fps, 0.22 ms per frame, p99 gap 42 ms |
| Links survive the wire | Runs carried link strings | 17 links per frame; a click delivered its URL |
| Dependency-free WebSocket works | `upgrade`, hand framing, newest-wins | 20 of 20 clicks, 0.3 ms median |
| `Origin` gate | Upgrade from a foreign Origin | Connection dropped |

Limits: recorded frames were replayed, so this measures the page and transport, not a live feed. One tab. The page painted runs without scaling. The token exchange, `Host` check, reconnect across a renderer restart and `newestWins` under a stalled tab weren't exercised.

## Build order

The wire format comes first.

1. `browser` surface and its encoder, with link ids.
2. Listener, its gate, and the WebSocket. *Done when a test proves every refusal in the Security list.*
3. The page, embedded. *Done when a real session's bar paints in a browser and matches its Frame.*
4. Clicks and `via: "browser"`. *Done when every link kind works from a page, and a stale click finds nothing.*
5. Session listing and `isVisible()`. *Done when a page follows `/clear`, and a visible tab holds 30 fps with its pane hidden.*
6. Doctor check, docs and install wording.

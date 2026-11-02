# Rendered text: consumers, non-draw output, link minting, rich-js

A subagent's read-only inventory of the code at commit 10f26ceb, kept verbatim so the investigation isn't repeated. Verify a claim against the code before building on it. Decisions live in the design docs, which override anything here.

---

**`/tmp/ccb-probe/findings-frames.md` was not written.** My instructions for this session forbid creating files, `/tmp` and findings `.md` files included, so the full report is below instead of a path and summary. To save it, paste this message into the file. No repo file was edited.

**Summary**
- There are 15 ANSI decoders to remove: 2 in `src/` lanes, 1 reader module, 3 script and site callers, 6 test helpers, the SGR-to-hex parser, and 2 width or row readers. Five of the callers read out-of-process, so the Frame has to cross the socket.
- A Frame is not depth-independent, and it must keep segment boundaries and store drawn colours, or bytes change and blends throw.
- One minter can own the prefix for every drawn `dispatch` link. It cannot cover the tmux binding, doctor probes or config-authored `{{ link }}` strings. Signing fields do not include the URL, so the prefix must not be signed.

Scanned at `10f26ceb`. Root for everything below: `/Users/bmf/code/cc-candybar/.claude/worktrees/synthetic-zooming-wind`.

---

# Task A: Consumers of rendered text

## (b) Decoders that must move to the Frame

**In `src/` (runs in the daemon or in-process)**
- `src/band/frames.ts`: `bandFrame` decodes with `new AnsiDecoder()`, reading `line.plain` and `line.spans`, to build `BandRun`s. `bandResponse` gets its ANSI from `planOutcome(renderOutcomeOf(resp)).output`. It must take Frame rows. Called from `lane-frames.ts`; asserted by `test/band-frames.test.ts`.
- `src/tmux-status/frames.ts`: `tmuxStatusFrame` does the same decode to build `#[...]` directives and the range-to-link map. Called from `src/daemon/tmux-status.ts` (`entry.frame = tmuxStatusResponse(resp)`) and `lane-frames.ts`; asserted by `test/tmux-status-frames.test.ts`.
- `src/click/read.ts`: `links()` uses `osc8Sequences`, `drawnLinks()` builds on it, and `stripAnsi` uses `INVISIBLE`. The non-ANSI half (`effectsOf`, `describeLink`, `isBarLink`, `HOST_VERBS`) stays.
- `src/render/diagnostic-style.ts`: `hexOfSgr` regexes the hex out of SGR literals. It is a small decoder and should be inverted, so colours are the source and SGR is derived. `scripts/check-protocol.mjs` diffs these literals against Rust, so it must change too.

**Out-of-process callers (they hold only `Response.output`)**
- `scripts/bar-web/server.ts`: `view()` runs `drawnLinks(ansi)` for the page's link table.
- `scripts/drive-bar.ts`: `drawnLinks(out)` for `--links`.
- `scripts/bench/suites/wire.ts`: `drawnLinks(shown)` finds the `▶` link.
- `test/helpers/drive-bar.ts`: `drawnLinks(last)` in `click` and `follow`, with `render` going over a socket.
- `test/helpers/daemon-e2e.ts`: `linkUrls(rendered)` finds click URLs; `stripAnsi(run.stdout)` tests for an empty run.

**In-process, but via `Response`**
- `site/transport.ts`: `render()` runs `drawnLinks(ansi)` on `replyTo`'s `resp.output`. `Reply` must carry the Frame or links.

**Test helpers**
- `test/helpers/ansi.ts`: `withoutLinks`, `linkUrls`, `linkCloseCount` (via `osc8Sequences`), `boldUrls` (via `decodeAnsi`), plus re-exports.
- `test/helpers/seams.ts`: `drawnChars` is a hand-written SGR state machine over `INVISIBLE` plus an SGR regex. It is the worst decoder here, and its output is read by `seams()`.
- `test/helpers/door-close.ts`: `doorClose` uses `decodeAnsi` to read ink and ground.
- `test/helpers/diagnostics-viewer.ts`: uses `links`, `stripAnsi` and a header regex on stripped text.
- `test/helpers/seam-sweep.ts`: consumes `seams.ts`. Its comment names `test/seam-sweep.test.ts`, which does not exist. Only `audits/seam-sweep.audit.ts` and `audits/theme-identity.audit.ts` import it.

## (c) Needs only width, rows or plain text
- `src/render/fill.ts`: `drawnCols` strips `INVISIBLE` and calls `cellLen`; `resolveFill` splits `renderStripCells` output on `\n`. It needs the row count and row cell width from a measured draw. This is a regex over escapes on the hot path.
- `src/render/ansi.ts`: `INVISIBLE` itself. Delete it once its readers are gone.
- `src/render/strip.ts`:
  - `stripGeometry` measures `.text` drawn at `colorSystem: null`.
  - `stripPrivateGlyphs` reads `.text` the same way, and `src/doctor/edge.ts` consumes it.
  - Both need plain text only.
- `src/render/diagnostics.ts`: `header.split("\n").length` and `.split("\n")` in `channelRows` take row structure from the bytes. They need Frame rows.
- `test/helpers/drive-bar.ts`: `printable` uses `stripAnsi` and `cellLen`.
- `scripts/bench/suites/wire.ts`: `output.split("\n").length` counts rows; `tick.output !== before` is a change test. Neither decodes.

## (a) Final byte sinks and relays (legitimately ANSI)
- `src/index.ts`: writes `plan.output` to stdout.
- `src/bar-pane/index.ts` and `src/bar-pane/paint.ts`: `paint()` splits lines and positions the cursor. Terminal.
- `rust-client/src/main.rs`: `interpret_response` reads `output`, writes stdout, and caches last-render bytes.
- `rust-client/src/follow.rs`: relays JSON lines opaquely.
- `src/frames-cli.ts`: relays the response as JSON.
- `src/daemon/lane-frames.ts`: the `statusline` and `pane` entries pass JSON through.
- `src/daemon/frame-feed.ts`: `sentOf` uses `JSON.stringify(resp)`, and dedupe compares those bytes. See the prefix warning in Task C.
- `src/daemon/client.ts`: `projectOutput` checks the type only.
- `src/check.ts`: `renderEffective` reads `drawDsl(...).text`, and `--render` prints it.
- `src/demo/gallery.ts` and `src/demo/dsl.ts`: print rows with a prefix, splitting on `\n`.
- `src/daemon/client-debug.ts`: prints `lastRender`, fed by `serializeSegmentCells` in `src/daemon/server.ts`.
- `scripts/bar-web/index.html`: xterm `term.write`, a real terminal emulator. `site/build.mjs` copies this file to `site/dist`. Its `view.links` come from the decoders above.
- `vendor/cc-extra/src/statusline-push.js`: outside your listed dirs, but it reads `resp.output` and trims lines before pushing to Claude Code.

## Producers on the same path
- `src/dsl/render.ts`: `DrawnFrame.text` joins `DrawnRow.text` with `\n`. `renderDsl` returns `.text`.
- `src/daemon/server.ts`: `drawRender` copies `frame.text` into `body`, `composeBar` appends `\n`, and `statuslineOf` selects the answer. The `.text` fields of `DrawnRow` and `DrawnFrame` are read only here and in the callers listed above.

## Test dependency counts
These are word matches across the 301 test files. `links(` is a heuristic, and the escape-literal list includes some non-bar files (for example `claude-input`) that I did not inspect individually.

| Dependency | Test files |
|---|---|
| imports `helpers/ansi` directly | 80 |
| imports `helpers/click` (re-exports `boldUrls`) | 61 |
| imports `helpers/daemon-e2e` (re-exports `linkUrls`, `stripAnsi`) | 32 |
| imports `helpers/diagnostics-viewer` | 8 |
| imports `helpers/drive-bar` | 2 (`plugins`, `drive-bar`) |
| imports `helpers/seams` | 1 (`colour-256`) |
| imports `helpers/door-close` | 1 (`palette-identity`) |
| `stripAnsi` | 88 |
| `linkUrls` | 46 |
| `links(` | 15 |
| `boldUrls` | 5 |
| `decodeAnsi` | 5 |
| `INVISIBLE` | 4 |
| `withoutLinks` | 2 |
| `linkCloseCount` | 1 |
| `osc8Sequences` | 1 (`osc8-closure`) |
| `drawnLinks` | 1 |
| `AnsiDecoder` | 0 |
| escape literal | 23 |
| `renderDsl` | 85 |
| `renderStripCells` | 7 |
| `drawDsl` | 5 |
| `buildLineStrip` | 2 |
| `drawStripCells` | 0 |
| `.output` | 7 |
| `bandFrame` / `bandResponse` | 1 |
| `tmuxStatusFrame` / `tmuxStatusResponse` | 1 |
| `planOutcome` | 2 |
| `formatPermanentGlyph` | 1 |

`test/default-menu-bytes.test.ts` pins exact bytes through the ANSI helpers. It is the guard for keeping the encoder byte-identical.

---

# Task B: Bar output that does not come from `drawDsl`

- `src/render/error-glyph.ts`: `formatPermanentGlyph` concatenates raw SGR, prefix, sanitized message and reset.
  - In the daemon it is reached through `planOutcome`, then decoded by band and tmux.
  - **Frame need:** a `Frame` constructor taking text and diagnostic colours.
  - **Catch:** the glyph writes `BG` then `FG` as two sequences, but rich-js writes fg then bg in one SGR. An encoded Frame cannot match today's glyph bytes, so either the glyph bytes change on both runtimes or terminals keep the literal.
- `rust-client/src/error_glyph.rs`: a byte mirror of the above. It is a client-side terminal sink with no Frame available, so it can stay bytes. It stays held to TS by `scripts/check-protocol.mjs` and paired fixtures.
- `src/render/outcome-plan.ts`: `planOutcome` produces three outputs: `outcome.value`, a literal `"\n"` for transient, and the glyph for permanent.
  - It is a shared seam for the terminal client (`src/index.ts`, `src/bar-pane/index.ts`) and for band and tmux.
  - **Frame need:** daemon lanes stop calling it and build from a Frame or a failure. Clients keep it.
  - Every `Response` that reaches lanes decides ok or permanent, except `TIMEOUT`, which `interpretResponse` treats as a kick-and-blank path. I read that arm only up to its comment.
- `src/band/frames.ts` and `src/tmux-status/frames.ts`, `catch` arms: when a bar can't be drawn (blink in band, `blink2` in tmux), they build `DIAGNOSTIC_ERROR_BG + FG + "⚠ cc-candybar ..." + ANSI_RESET` and decode it. This is a literal decode of self-made ANSI. **Frame need:** the same error-Frame constructor.
- `src/render/diagnostics.ts`, `viewerRows`: replaces `frame.text` in `drawRender` when the viewer is open.
  - It goes through `renderStripCells`, never `drawDsl`, and it has no `nextChange` of its own.
  - **Frame need:** return Frame rows through the shared strip draw.
  - `messageRows` has no caller in `src` or `test/helpers`, so check it is dead before migrating it.
- `src/render/diagnostics.ts`, `handoffRows`, with `src/daemon/lane-handoff.ts`: strip-drawn rows, chosen in `statuslineOf` after the draw. **Frame need:** a second Frame in the `Reply`, because a feed sends `resp` (bar) and `statusline` separately. Statusline-role clients and the statusline lane receive this one.
- `src/daemon/server.ts`:
  - `renderFailed`, `refusedRender` and `refuse` are `ok: false` responses with no bytes, turned into the glyph client-side.
  - `serializeSegmentCells` makes per-segment ANSI for debug, a `DEBUG_RENDER_OPTS` infinite-width path that can use the Frame encoder directly.
  - Click and shutdown replies are `output: ""`, not bar output.
- `src/bar-pane/index.ts`: paints `resp.error`, `fault` and `status` as unstyled text into the pane. No Frame needed unless the pane moves to one.
- `rust-client/src/main.rs`: on a transient failure, prints stale `last-render/<sid>` bytes or `"\n"`. It must stay ANSI, because a client with no daemon can only replay bytes.
- `src/daemon/tmux-status.ts`: `draw` writes `frame.rows` into `status-format`, and restore paths write user values back. It only needs its input fixed, in `tmuxStatusResponse`. An absent frame is `rows: []`.
- `mod/hooks/register.tsx`: shows its own failure `<Text>`, not bar output, and needs nothing.

**Sanitizers (keep them, moved to text input)**
- `src/render/diagnostic-text.ts`: `sanitizeText` and `sanitizeAndTruncate`.
- `diagnosticSpan` in `src/render/diagnostics.ts`.
- `src/render/picker.ts`: `sanitizeText` on authored text.
- rich-js `stripOscTerminators` runs in `osc8Open`, so a Frame carries unsanitized URLs until encoding unless a Frame builder cleans them.
- `escaped()` in `src/tmux-status/frames.ts` is encoder-side and stays.

**Not an output path:** `src/daemon/closing-view.ts` only wraps session-state writes. It draws nothing. The closing flash is drawn inside `drawDsl`.

`candybar-lite.mjs` showed no hits for output handling, but I did not read it.

---

# Task C: Link minting

**Through `effectsUrl` (`src/click/wire.ts`)**
- `src/render/action.ts`: `renderAction`. Its `realize` also builds `run` effects with the mac.
- `src/render/menu.ts`: the trigger.
- `src/render/disclosure-close.ts`: `disclosureCloseFragment`.
- `src/render/picker.ts`: `pageUrl`, `optionUrl`, ✕, steps.
- `src/render/carousel.ts`: two sites.
- `src/render/diagnostics.ts`: `copyLink`, `viewerLink`.
- `src/daemon/update-notice.ts`: three sites.
- `src/daemon/repo-configs.ts`: `repoQuestions`, signed.
- `src/daemon/lane-handoff.ts`: `laneHandoff`.
- Click drivers only: `scripts/load-gate.ts` and `scripts/bench/suites/wire.ts`. 21 test files also call it.

**Not through it**
- `src/daemon/tmux-status.ts`: `CLICK_URL` spells `cc-candybar://` by hand and is bound into tmux's root key table for the server's lifetime. `isClickBinding` matches on it, and another daemon can adopt the binding.
- `src/doctor/handler-probe.ts`: the probe URL `.../doctor-probe/<nonce>`, and `.../probe` in `OPENER_SCRIPT`.
- `src/install/index.ts`: the printed `hello-world` test URL, which relies on bare-copy parsing.
- Config-authored links via `{{ link url text }}` become `new Style({ link: url })` in rich-js `dist/template-bindings/style-funcs.js`. Sources:
  - `src/config/default-dsl-config.ts`: `.git.prUrl`.
  - `src/config/quick-actions.ts`: `.git.repoUrl`.
  - `examples/demo-actions.json5`, among others: literal `cc-candybar://open-vscode/...` and `load-config/...`.

**Readers that spell or parse the scheme (they break on `to/<draw-id>/`)**
- `parseHandlerUrl` in `src/install/index.ts`: treats the first path segment as the verb.
- `statusLineClick` in `src/daemon/server.ts`: hand-spelled `startsWith`.
- `isBarLink` in `src/click/read.ts`.
- `follow()` in `scripts/bar-web/index.html`: hand-spelled.
- `rangeOf` in `src/tmux-status/frames.ts`: digests the whole URL, so the prefix changes range ids.
- `wire.ts` documents that old direct URLs stay accepted, so the parser must take both forms.

**Can one function own the prefix?** Yes, for every link the bar draws from effects. `linkFragment`, `linkOver` and `withLink` receive URL strings, so `effectsUrl` is the one mint.

It must become a value bound to the Draw, because it has no Draw today. Diagnostics, repo questions and update notices are also built before `drawDsl` from only a `sessionId`, and `laneHandoff` after it, so all of them need the minter passed in.

**What cannot go through it**
1. `CLICK_URL`: a server-lifetime binding, not per-Draw. The daemon holds the link and looks it up by range.
2. Doctor probes: there is no Draw.
3. `{{ link }}` strings: author-written, and `https` targets must not be prefixed.
4. The install test URL.

Config-authored `cc-candybar://` links can only be addressed by rewriting `Style.link` at Frame construction, or by leaving them unaddressed and legacy. That is an owner decision.

**Two hazards**
- **Dedupe:** `frame-feed.ts` dedupes on bytes, and `renderFrame`'s neighbouring comment warns that a per-render value in the frame defeats that dedupe. A per-frame id would change every frame.
- **Caching:** `src/dsl/parts.ts` keeps answers until something read changes, so a per-frame id would also go stale in cached cells. I inferred the cell caching from comments and did not trace it.

The draw-id must therefore be stable per view or session, not per frame.

**Signed fields (`src/click/link-signer.ts`)**
`sessionId`, `action`, `declaration` and `evaluated`, as an HMAC-SHA256 over the JSON array. The URL itself is not signed, and verification rebuilds the fields from args and config. There are two users:
- **`run`:** action name, `runDeclaration`, and the evaluated JSON.
- **`repo-config`:** `action = VERB_REPO_CONFIG`, `declaration = dir`, `evaluated = answer`.

**Must the prefix be signed?** No. A changed prefix cannot alter what runs, since a forged prefix leaves session, action, declaration and evaluation as verified, and a daemon with another key fails verification. Unsigned verbs such as `set-state` carry no mac at all. Sign it only if the owner wants a link bound to one Draw, which would also invalidate those links across draws.

---

# Task D: rich-js types and depth

All in `node_modules/@promptctl/rich-js/dist/core/` (`segment.d.ts`, `style.d.ts`, `anchor.d.ts`, `color.d.ts`, plus `render.js`, `color.js`, `style.js`, `osc8.js`, `strip.js`).

**What they carry**
- **`Segment`:** `text`, `style?`, `control?`.
- **`Style`:**
  - `color` and `bgcolor` (`ColorSpec`).
  - 13 attributes, each true, false or unset.
  - `link`, `meta`, `anchor`, `hold`.
- **`Anchor`:** `owner` (an object compared by identity), `row`, `col`, `inner`. It is not serializable.

**Needed for exact ANSI (`segmentToString`)**
- **Segment boundaries.** Every segment is written alone (`SGR text reset`, inside its own OSC 8 pair). Adjacent equal styles are two runs, so merging runs changes bytes.
- **Per segment:**
  - The text.
  - True attributes in `ATTRIBUTE_NAMES` order.
  - Drawn fg, then bg.
  - The link. The `id=` is `fnv1a` of the cleaned URL.
- **Bare and empty cases.** Empty text or an undefined style writes bare text. Empty codes omit the SGR. Control segments write nothing.
- **Destination.** Depth, `hyperlinks` (true for an explicit spec), and `reducedMotion` (not passed by `draw`, so false).
- **Not needed for bytes:** `meta`, `anchor`, `hold`. The trailing `\n` comes off in `drawStripCells`, and one `DrawnRow` can hold several lines from FlexStrip wrap, so Frame rows must split at newline segments.

`AnsiDecoder` merges equal-style cells today, and `test/band-frames.test.ts` asserts that shape. So band and tmux must merge runs by look, while the ANSI encoder keeps boundaries. Anchors make `equals` false, so compare looks.

**Does `ColorSpec.name` round-trip?** It does for colour identity in every kind reachable here, with caveats:

| Kind | Name | Round-trips? |
|---|---|---|
| default | `default` | Yes |
| named | name | Yes |
| `#hex` | hex | Yes; alpha is quantized to one byte by `hex` |
| `rgb()` | as written | Yes |
| `color(N)` | `color(N)` | Yes for STANDARD and EIGHT_BIT; type WINDOWS parses back as STANDARD, unreachable since `COLOR_COMPATIBILITIES` has four values |
| blend | `blend(a,b,t)` | Yes, via `blendTerm` |

`parse` lowercases. `Style.toString` does not round-trip `meta`, `anchor` or `hold`, and `link` is one space-delimited token, so a URL with a space breaks.

**Blends are the trap.** `ColorBlend.fixedValue` is undefined and its type is TRUECOLOR. Handed one directly, `runColor` in band and `tmuxColor` in tmux would both throw. They work today only because the decoder sees an RGB value. A Frame must store the drawn value (`.value`), not the spec.

**Where depth is applied**
- `resolveDestination` only names depth and link facts. It downgrades nothing.
- Downgrade and alpha flattening happen at encoding: `segmentsToString`, then `toSgrCodes`, then `drawnColors`.
- `colorSystem === null` (`none`) empties SGR and keeps links. `drawnDepth("none")` is `ColorDepth.DEFAULT`.

Depth is also read during the draw, so colour values are chosen for it:
- `src/render/strip.ts`: `draw` passes `colorSystem` into `render`.
- rich-js `core/strip.js`: `standOff` moves ink at that depth.
- rich-js `renderables/effect.js`: `looks` and `measured` use depth, and `null` disables the effect.
- rich-js `core/protocol.js`: `groundedStyle`.
- `src/dsl/parts.ts`: `drawnAt: () => drawnDepth(this.colorCompatibility())`.
- `src/themes/decor.ts`: `textOn` and `legibleOn` floor via `ensureContrast(..., drawnAt)`. Shade windows use `drawnColour(..., drawnAt)`.
- `src/render/segment-color.ts`: `keptOn`.
- `src/render/band-style.ts`, `src/template-engine/colors.ts`, `menu.ts`, `picker.ts`, `carousel.ts`, `swatches.ts`, `theme-preview.ts`, `layout-preview.ts`, and the flash text in `src/dsl/render.ts`.

**Conclusion: a Frame is not depth-independent.** It is drawn for one depth and cannot be re-encoded at another with the floors intact.

Store `style.drawnColors(depth)` resolved to concrete values, plus the depth, and no colours at `none`. That matches what lanes decode today: band and tmux see downgraded colours, including `color(n)` slots at `ansi`. Re-encoding drawn colours is safe, because a downgrade to the same type returns `this`, and an opaque flatten returns the same spec.

**Placement id.** `src/dsl/render.ts` pairs each `owner` with its `placement`, and `core/strip.js` stamps item cells with the item and seams with `JOIN` or `JoinedCell`. So a run maps to a placement by anchor owner, and seam cells have no direct placement.

Unverified:
- That FlexStrip stamps identically.
- That anchors survive `motion.wrap`.
- Whether any row emits control segments.

---

# Decisions the plan must make
1. **Wire.** `drive-bar`, `bar-web`, bench, `daemon-e2e` and 32 test files hold only `Response.output`. Either the Frame or link list crosses the socket, or those decoders cannot be deleted. Adding it touches `src/daemon/protocol.ts`, `scripts/check-protocol.mjs`, and Rust, which reads only `output`.
2. **Glyph bytes.** Keep the literal client-side, or change both runtimes.
3. **Config-authored links.** Rewrite at Frame construction, or leave unaddressed.
4. **Draw-id lifetime.** It must be stable per view or session, not per frame.

# Deletion checklist
Remove these once their callers are migrated:
- `AnsiDecoder` in both lanes, and `osc8Sequences`, `links`, `drawnLinks` and `stripAnsi` in `src/click/read.ts`.
- `INVISIBLE` and `src/render/ansi.ts`.
- `hexOfSgr`, the `catch` arm SGR literals in both frame files, and the `planOutcome` call in both frame files.
- All `test/helpers/ansi.ts` readers, `drawnChars` in `seams.ts`, `doorClose`'s `decodeAnsi`, and `diagnostics-viewer`'s link and strip use.

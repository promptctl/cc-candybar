# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

<!-- BEGIN LIT INTEGRATION -->
## lit Agent-Native Workflow

This repository uses `lit` for agent-native issue tracking.

Start by running `lit quickstart` to load the workflow instructions. It prints how tickets are found, created, updated, and closed here, so running it first means the rest of your work follows the conventions this repo expects. It's a quick, read-only command — no need to check in before running it.

<!-- END LIT INTEGRATION -->

## Package manager

`pnpm` is canonical (lockfile is `pnpm-lock.yaml`, README/install paths use `pnpm dlx`). Don't introduce npm or yarn lockfiles.

## Common commands

| Task | Command |
|------|---------|
| Build (TS bundle to `dist/`) | `pnpm build` |
| Watch-build during dev | `pnpm dev` |
| Type-check only | `pnpm typecheck` |
| Lint / autofix | `pnpm lint` / `pnpm lint:fix` |
| Run all tests | `pnpm test` |
| Run a single test file | `pnpm test -- test/daemon-render-cache.test.ts` |
| Filter tests by name | `pnpm test -- -t "cache key"` |
| Watch tests | `pnpm test:watch` |
| Build the native (Rust) render-path client | `just install-rust` |
| TUI demo (no Claude Code needed) | `just demo` (or `pnpm demo`) |
| Verify TS↔Rust wire-protocol version match | `pnpm check:protocol` |

`prepublishOnly` runs lint → typecheck → check:protocol → build, in that order. Any of those failing blocks publish — fix the root cause; never bypass.

Jest is configured for ESM via `ts-jest` (see `jest.config.js`), with explicit `transformIgnorePatterns` allow-listing `rich-js` and width helpers under both `node_modules/<pkg>` and pnpm's `.pnpm/` shadow path. If you add an ESM dep that ships untranspiled, extend that allow-list.

## Architecture: the big picture

CCCandybar is a Claude Code statusline renderer with a **two-process model**: a per-render-tick client and a long-lived daemon.

```
Claude Code  ──spawn──►  cc-candybar (client)  ──unix socket──►  cc-candybar daemon
                          (Rust hot path,        4-byte BE len +    (single instance,
                           Node fallback)        JSON, v=2)          caches everything)
```

### Client (`bin/cc-candybar`, `src/index.ts`)

The shipped `bin/cc-candybar` is the **Rust** render-path client (`rust-client/src/main.rs`). It does only one thing fast: connect to the daemon, send the hook JSON, print the response. Any subcommand (`install`, `daemon`, `daemon-stats`, `url-handle`, `install-url-handler`, `--help`) transparently exec's the Node fallback at `dist/index.mjs`. On daemon miss the client spawns a detached daemon and emits `\n` so the next status-line refresh hits a warm daemon.

The Node entry (`src/index.ts`) is **not** a parallel renderer — it's a dumb relay (`tryRenderViaDaemon`). There is intentionally no inline render path; the daemon is the single renderer (`[LAW:one-source-of-truth]`).

Wire format lives in `src/daemon/protocol.ts`. The Rust client mirrors the wire contract as literal consts — protocol version, frame cap and header, timeout budgets, the error-code vocabulary, and the diagnostic glyph styling. `scripts/check-protocol.mjs` diffs every mirrored constant TS↔Rust (anchor missing counts as drift) — change any of them in **both** runtimes in lockstep or `prepublishOnly` fails. Adding a new mirrored constant means adding a row to the script's `CHECKS` table in the same commit.

### Daemon (`src/daemon/server.ts`)

- One instance per user, mutex'd via `$XDG_STATE_HOME/cc-candybar/pid`, listening on `/tmp/cc-candybar-$UID/socket` (UID-derived path, immutable kernel identity — see `src/daemon/paths.ts:socketPath()`). The socket is **not** under `$XDG_STATE_HOME`; overriding `XDG_STATE_HOME` does not isolate the socket. The `CC_CANDYBAR_SOCKET` env var is the explicit override for test/dev isolation.
- No idle or age shutdown (both removed — they interrupted active sessions). The sole hard limit in `src/daemon/limits.ts` is an RSS backstop: default 512 MB (override via `CC_CANDYBAR_RSS_LIMIT_MB`), on breach it writes a heap snapshot (keeps the newest 3) then exits. Restarts are normal — every cache is rebuilt cold.
- Parent-death watchdog (`src/daemon/parent-watchdog.ts`): a daemon spawned with `CC_CANDYBAR_PARENT_PID` set polls that pid and shuts down (through the same `shutdown(code)` funnel) when it dies. The production daemon is spawned detached and never sees the var, so it outlives its spawner as designed. Test daemons inherit the var from the Jest worker (armed once in `test/setup.ts`), so a SIGKILLed/crashed/timed-out Jest cannot orphan a daemon to PID 1 — this closes the test-daemon leak.
- Update notice (`src/daemon/build-currency.ts` + `src/daemon/update-notice.ts`, brandon-build-notice-5d6): "something newer exists than the code rendering this bar." Two facts feed one notice. **Source** — on the same one-minute cadence as the binary-mtime self-restart, the daemon compares the bundle's *identity* to the `src/` beside it: `pnpm build` (the plugin in `tsdown.config.ts`) bakes `sourceDigest(src/)` (`src/source-digest.ts`, sha256 over every source file's path+bytes, `.dotfiles`/`~` backups excluded, symlinks hashed by link text) into the bundle as `__SOURCE_DIGEST__`, and the daemon recomputes the same function on the clock. Mtimes were the previous design and cried wolf on every `git checkout` (a branch switch rewrites mtimes on unchanged bytes). The verdict is the typed `BuildCurrency` — `current` | `stale` (both `SourceStamp`s: version + digest) | `not-source-checkout` (no `src/` beside `dist/`: the published-install shape, never a warning) | `unchecked` (bundle carries no digest, tree unreadable — logged, never a throw out of a timer). **Release** — polled only under `not-source-checkout`, every 6 h, from `CC_CANDYBAR_REGISTRY_URL ?? REGISTRY_URL` (tests point it at a closed port in `test/setup.ts`). `updateOf(build, release)` folds both into one `Update` (`source{root,newer,running}` | `release{newer,running}`), and the pure `updateNotice(update, actState, ctx)` renders it as one `DiagnosticChannel` at `UPDATE_SEVERITY`: the sentence `⬆ Newer source: 1.48.0 [abc1234]. You're on 1.47.0 [def5678].` (the sentence copies itself, like every diagnostic row) followed by three OSC-8 affordances — `[rebuild]`/`[upgrade]` → the `apply-update` verb (runs `pnpm build` in the checkout root, or `pnpm dlx @promptctl/cc-candybar@<v> install`; one child at a time, shown as `[rebuilding…]` while it runs, a failure adds a second line `rebuild failed: <last line>` for the identity it failed on — the next attempt, or a newer build, clears it; a successful rebuild changes the bundle's mtime and the binary watch's `checkNow` restarts the daemon), `[dismiss]` → `set-state update.dismissed=<identity>` (this session only, and only for THIS newer identity — the next newer build shows again; the allow-list is re-registered whenever the identity changes), `[disable]` → `set-config updateNotice=false` (the config file, durably). `globals.updateNotice` is **config-only** (default `true`, no SessionState half — the per-session knob is the dismissal). The strip's `↳` trailer row is conditional: it exists only when the row cap elided rows or a config file failed to load, so a bare update notice is one row with nothing to open beneath it.
- Caches owned by the daemon process (one each, not per-session):
  - `src/daemon/cache/git.ts` — git state, keyed by **repo root** (not cwd, not session), invalidated by fs watchers on `.git/HEAD` and `.git/index` mtimes. The forge **PR/MR lookup** (`showPullRequest` option → `GitInfo.pullRequest`) lives here too but in a **separate cache with its own TTL** (`PR_TTL_OK_MS` / shorter `PR_TTL_FAIL_MS`), keyed `repoRoot|branch` — a network resource (`gh`/`glab`) gets a longer, independent lifecycle than fs-watched local state, so the per-render git fetch stays all-local. The lookup itself (`GitService.resolvePullRequest`: remote→forge detect→CLI→three-state `Outcome<PullRequest>`) is in `src/segments/git.ts`; `failed` is surfaced as a **visible** `git.prError` (distinct from no-PR), never collapsed to a missing key.
  - `src/daemon/cache/session-usage-store.ts` — the daemon's single owner of per-session usage records, keyed by transcript mtime. Both the `session` projection (whole-session totals) and the `today` projection (cross-session sum of per-day buckets) are **folds** over this one store — there is no per-render whole-tree scan. The whole transcript tree is read **exactly once**, lazily (a per-day seed), to backfill sessions that did work before the daemon saw them; every render after that is a single sync `statSync` on the active session's transcript plus an in-memory fold. The fold itself is **incremental and append-only** (brandon-daemon-perf-bb9): a record holds a per-file `FileFold` — a byte **cursor** plus running cost/token/day sums for the main transcript and each agent sidechain — so when an active session's transcript grows, only the **appended bytes** are read (`readAppendedEntries` → gated `readAppended` in `src/utils/transcript-fs.ts`) and folded in, never a whole-file re-parse. Per-render cost is **O(bytes appended since last render)**, not O(transcript length); a rewrite — detected by an **inode change** (a rename-based `/compact` or log rotation) **or the file shrinking below the cursor** (in-place truncation) — is the `reset` case that re-folds that file from zero. `src/segments/metrics.ts` folds the same reader the same way (`messageCount` + a recent-entry ring) so it doesn't re-inherit the whole-file parse the store dropped (`[LAW:dataflow-not-control-flow]` — `session`/`today`/metrics are all derived state maintained incrementally, not recompute-if-stale).
  - `src/daemon/cache/render.ts` — per `(projectDir, cwd)` tuple, holds the live DSL state: parsed `DslConfig`, `VariableStore`, `SourceRegistry` (with timers/watchers/git-subscriptions), `CompiledSegments`, and resolved `basePalette`. LRU-capped at 256. Each entry watches every candidate config-file location (so creating one later triggers reload). `reloadInto` builds the new state into a local first and only swaps + disposes the old `SourceRegistry` on success, so a broken-config reload preserves last-known-good (`[LAW:single-enforcer]` — the registry owns async handles; dispose-before-swap is the contract). An entry's `state` is never null: it is **seeded with the bundled default's state at creation** (candybar-settings-ui-0gz), so a config that fails its very first load still renders a bar — the default, settings menu included, through the same synthesis — under the red strip, whose trailer row carries a plain `file://` OSC-8 link to the failing file — and, when the row cap elided rows, to the complete error text (no `cc-candybar://` handler in the recovery path; see "Errors are loud" below).
  - `src/daemon/session-state.ts` — per-session key/value store for click-driven state (currently active theme, toolbar-expanded, etc.).
- Stats snapshot at `cc-candybar daemon-stats --json` — uptime, RSS, cache hit rates, watcher count, request totals.

### Config resolution (`src/config/dsl-loader.ts`)

`resolveDslConfig(projectDir, cwd, configFile)` picks the first existing path from this order:

1. `$CC_CANDYBAR_CONFIG` — read by the **client** (`src/config-hint.ts`, mirrored in the Rust client) and sent as the `configEnv` client hint, composed at the request boundary in `server.ts` as the lowest of three (a session's load-config pick > `--config` > the hint); the daemon consults no env of its own for it (it is detached, so its env is whichever shell spawned it — brandon-config-5g8). Resolution is the typed `ConfigResolution` (`file` | `default` | `missing` | `unreadable`), the product of one fold over the candidate list whose presence probe is three-state (`present` | `absent` | `Unchecked{path,error}` — only ENOENT is absence). `file`/`default` carry `unchecked`: chain locations a stat could not see past (an unsearchable directory, a symlink loop), each rendered as a `Config location could not be checked: <path> — <error>` line while the search went on to the next verified candidate, never halting on a guess. An explicit path that names no file is `missing` (`Config file not found: <path>`), and one stat could not see is `unreadable` carrying the errno (`Config file could not be read: <path> — <error>`); both render the bundled default under that warning (liveness: the watcher loads the file when it can be read), never the silent `default`. `configResolutionNotice` is the one spelling of all three, rendered by `RenderCache` and by `cc-candybar check` alike.
2. `<projectDir>/.cc-candybar.json5` (then `.json` at the same location)
3. `<cwd>/.cc-candybar.json5` (then `.json`)
4. `$XDG_CONFIG_HOME/cc-candybar/config.json5` (then `.json`; defaults to `~/.config/cc-candybar/config.json5`)

Both `.json5` and `.json` are accepted (JSON ⊂ JSON5, same parser) — `.json5` wins when both exist at the same location, and `detectConfigCollisions` surfaces the shadowed sibling as a warning so the user removes the duplicate. If none exist, `RenderCache.reloadInto` falls back to `DEFAULT_DSL_CONFIG` (`src/config/default-dsl-config.ts`) — the bundled standard library, covering every built-in segment. **User files merge on top of the bundled default** (`mergeWithDefault` in `src/config/loader/merge.ts`): `globals` shallow-merge per field; `variables`, `segments`, `actions`, and `helpers` merge by name with user winning per name; and `root` merges per named row (`{ rows: { identity, status } }` in the bundled default): a `{ rows }` fragment merges by name, a whole tree replaces every row. The authoring surface for `root` is the **Option A shape grammar**: a bare string names a segment (`"segname"`); `{ seg, when? }` is a gated segment ref; `{ h: [...], when? }` / `{ v: [...], when? }` spell horizontal and vertical containers recursively; `{ kind: "group", … }` is group sugar. The older flat `layout` row sugar and `cells` nodes have been removed (2de.19) — configs still using them get migration-pointing errors. So a user only needs to declare what differs — overriding one segment, one variable, or one row, without restating the rest. JSON5 supports inline comments.

### Renderer (`src/dsl/render.ts`)

`registerDslConfig(config, registry, opts)` is the one-shot setup: declares every variable into the `SourceRegistry`, pre-parses every segment's `when` / `template` / `bg` / `fg` strings, and pre-resolves per-segment palette specs. Returns `CompiledSegments`.

`renderDsl(config, compiled, store, registry, payload, basePalette, opts)` is the per-render hot path: pushes payload into input boxes (`registry.applyInput`), walks `config.root` (a `LayoutNode` tree — containers stack/zip their children; segments are the leaves), evaluates each segment's compiled templates, builds `RichText` cells with per-segment palette colors, and serializes each composed line through the powerline `Joiner`; rows (vertical container children) are joined with `\n`. `FlexStrip`'s width-based auto-wrap (bzh.10) still applies *within* each row as a soft overflow safety net — configurable via `globals.autoWrap` (default on; `false` renders each row as one unbounded line while the finite width still feeds the picker's pagination via `term.cols`). Intra-cell padding (the spaces each side of a segment cell, inside the bg fill) is **structural**, not authored: templates emit content only, and the resolved `globals.padding` (integer 0–16, default 1 — the legacy `display.padding`) is applied via `RichText.pad` at exactly two converged sites threading one `BuildLineOptions.padding` value — `toCell` (legacy segment shape) and `applySegmentLayout` (DSL path, pad-before-sizing so padding sits inside a declared segment `width:`). Dropped menu bands pad uniformly with inline rows; the picker reserves `2×padding` beside the joiner chrome at its pagination seam (published per render on `ActionRuntime`, like `stripStyle`), so pages fit at any padding. The joiner glyph vocabulary is `globals.charset` (`"unicode"` default | `"ascii"` — the legacy `display.charset`): style picks the joiner *class* in `pickJoiner`, charset indexes the glyph *options* fed to it (`>` powerline, `(`/`)` capsule caps; plain's separator is already user data), orthogonal by construction. The ascii glyphs are deliberately single-column so `stripChromeCols` stays total over `StripStyle` alone — the picker's reserve is charset-invariant, pinned by the measured-chrome test over the style × charset product. The color depth is `globals.colorCompatibility` (`"truecolor"` default | `"256"` | `"ansi"` | `"none"` — the legacy `display.colorCompatibility`, minus its `"auto"` member): the enum `COLOR_COMPATIBILITIES` lives in `themes/policy.ts` beside `CHARSETS`, `satisfies`-tied to rich-js `ColorSystemSpec`, and flows as `BuildLineOptions.colorCompatibility` into rich-js's `colorSystem` downsampling. `"auto"` is deliberately unrepresentable — the daemon is detached, so env detection would read the daemon's terminal, not the client's; the loader rejects it with a migration-pointing error (true client-aware auto needs a wire capability hint, the `termCols` pattern).

Both functions are called verbatim by the daemon — no parallel render path, no inline computation that diverges. The demo at `src/demo/dsl.ts` calls the same two functions.

Segment data providers live in `src/segments/` (`git`, `session`, `context`, `metrics`, `tmux`, `pricing`). These produce structured data — `GitInfo`, `UsageInfo`, etc. The `session`/`today` cost aggregates are served by `src/daemon/cache/session-usage-store.ts` (folds over per-session records), and `block`/`weekly` read straight from `hookData.rate_limits` in `buildRenderPayload` — neither scans transcripts per render. The daemon's `buildRenderPayload` (`src/daemon/render-payload.ts`) composes them into one augmented payload that the DSL's `kind: "input"` declarations read.

Add a new built-in segment by:

1. Adding the data provider under `src/segments/` (if it needs daemon-side fetching). Project its shape into `RenderPayload` (`src/daemon/render-payload.ts`).
2. Declaring the relevant input variables in `DEFAULT_DSL_CONFIG.variables` (`src/config/default-dsl-config.ts`), with `path` strings matching the payload shape.
3. Declaring the segment in `DEFAULT_DSL_CONFIG.segments` with a `template`, `bg`/`fg` palette spec names, and (optionally) `when` for visibility gating.
4. Optionally adding the segment name to `DEFAULT_DSL_CONFIG.root` if it should render by default (the default `root` is a vertical container of two horizontal rows — an identity row `directory · gitaculous` over a status row `model · context · cacheTimer · block · weekly` — so add the segment to the `children` array of whichever row it belongs in).

### Themes (`src/themes/`)

All color math (palette hydration, reference resolution, darken/lighten/mix/contrast, **OKLCH** transposition) lives in **rich-js** — cc-candybar's `src/themes/` keeps no color arithmetic of its own, only name/string policy (`src/themes/policy.ts`: `resolvePaletteName`, `effectiveThemeName`, `listResolvablePaletteNames`, `STRIP_STYLES`/`effectiveStripStyle`, …) and memoized palette construction (`src/themes/palette-resolvers.ts`: `paletteForThemeName(name)` — the single name→`Palette` enforcer — and `transposedPalette(base, key)`, a memoized wrapper over rich-js `transposePalette` taking a full `ThemeKey`, its cache keyed on all four axes). The DSL config picks a palette via `globals.palette`, but the **effective** rendered theme is resolved per render from `effectiveThemeName(sessionState.theme, globals.palette)` (session choice over config default), so a theme click recolors the whole bar live; a per-segment `palette:` is an explicit override that ignores the session theme (frozen at registration in `registerDslConfig`).

**Decorative colour by address** (`src/themes/decor.ts`, epic candybar-render-ai7): `decorFor(palette, address)` is the pure function that replaces what `hue.step` was for (colour variety across segments; the stepper knob itself is deleted with no successor) — a node's tree address selects one entry of the theme's own `DECOR_BASES × DECOR_HUES × DECOR_AMTS` vocabulary and blends it with rich-js `blendRgb`; `error`/`success`/`warning` are excluded from the vocabulary at the type level. An `Address` is a list of `AddressStep`s `{ index, count, distribution }` — every step carries the distribution its PARENT places by, so there is no separate distribution parameter anywhere in the module. That distribution is authored (ai7.8): the `distribution` field on any container node or `kind: "group"` (the group's BODY), on `root` (a whole tree places its ROWS; a `{ rows }` fragment carries it per field like `when`), and in a `{{ menu }}`'s options dict — five names from `DISTRIBUTION_NAMES` (`van-der-corput` default, `golden-angle`, `ends-interleaved`, `monotonic`, `uniform`), resolved once at compile by `placedBy`; `van-der-corput`/`golden-angle`/`uniform` never read the sibling count, `monotonic`/`ends-interleaved` do (a trade the author spends for an ordered ramp over a closed set). Rationale and measurements: `design-docs/COLOUR-FROM-THEME-VOCABULARY.md`. The **state region** (ai7.2) sits beside it in the same module: `stateFor(palette, hue)` is an open disclosure's trigger colour — the hue's pure form `blendRgb(surface, hue, 0.92)` pushed toward `foreground` in twelfths (reaching `foreground` itself) until it clears `STATE_FLOOR` (2.2) against the max-amount vocabulary entry of that hue on EVERY base, measured through the same `decorEntryColour` the tint cells render with; a hue that cannot clear even at the pole throws naming palette and hue. `textOn(palette, bg)` picks the theme pole (`background`/`foreground`) that reads better on a state cell.

**Disclosure bands** (ai7.3, same module): a `Disclosure = { hue, depth }` names the band a trigger opens — the vocabulary hue its cell was dealt plus how many disclosure bodies enclose it; a band is a *plane hung under a trigger*, not a tree position, so no address enters. `bandFor(palette, disclosure) → { state, plane }` (memoised per palette in a `WeakMap`) is the one expression for every depth: `state = stateFor(hueAtDepth(hue, depth))` (depth advances the hue, wrapping over `DECOR_HUES`), `plane = blendRgb(state, background, recession)` with `recession = min(BAND_RECESSION.cap, base + perDepth × depth)` (`{ base .42, perDepth .14, cap .75 }`). **A trigger wears `bandFor(…).state`** — it is coloured by what it OPENS, not where it sits, and there is no separate trigger function, so trigger and band cannot disagree about their hue. `bandItemFor(palette, disclosure, address)` places each item along the plane→state axis inside `BAND_WINDOW` (`{ floor .12, span .8 }` — an item is never the plane and never its own trigger) by folding its band-relative `Address` (`bandAxis`: the same decayed per-level fold `vocabularyIndex` runs, taken modulo 1, so one step lands exactly at that step's placement) — the SAME `f(index, count)` shape the bar addresses the vocabulary with, one placement mechanism at every level; a picker option is one step (its index over the WHOLE option domain, not the visible page, so paging never recolours an item), a disclosure body's cells are the steps since that body's root. `src/render/band-style.ts` is the seam that lifts those colours into `Style`s: `stateCell(palette, colour)` (bg + `textOn` text) and `bandItemStyle(active, step)` (the menu completes the picker's `Position` with its own authored `distribution` — the picker knows positions, the instance knows how it places them). The walk threads a node's `Region` (ai7.9, `src/themes/decor.ts`: `{ kind: "bar", address }` | `{ kind: "band", band: Disclosure, address }`, a band address being the steps since the body's root) through `renderChild(node, parentVisible, step)` (`descend`) and `renderBody(body, open, band)` (`bandRoot`); `enterSegment(name, palette, region, bg, fg)` returns `SegmentStyles { closed, trigger, band, disclosure }`, a segment renders `trigger` exactly when something hangs open under it — a dropped `{{ menu }}` body or its own open disclosure body — and a dropped menu line sits on `band`, the plane; `renderPicker` takes an `itemStyle: (position) => Style` from `menu.ts`/`pickerFuncs`. `focusTint` is deleted with no successor. **A disclosure body is a node fact** (ai7.9): `SegmentNode.opens?: { ref: DisclosureRef; body: ContainerNode }` hangs the body ON its trigger — `disclosureNode(name, ref, body, when?)` in `src/config/disclosure.ts` is THE one lowering (group sugar, the settings menu's ☰ and ⚙, every `(?)`); the body carries no `when` (its openness is `disclosureGate(ref)`, parsed once at compile from the same ref the trigger's cycle writes), the trigger's own `when` gates both, and `opens` is unauthorable (`SEGMENT_NODE_SCHEMA` omits it). Depth is never stored: a body renders at `bandRoot(disclosure)` where `disclosure` is what `decorationFor` dealt its trigger, and on a band `decorationFor` deals `{ hue: band.hue, depth: band.depth + 1 }` — a count of enclosing bodies, never subtraction — so the bundled ☰ → ⚙ → picker chain is depths 0/1/2 and an authored `{ h, when }` container adds nothing (`test/disclosure-depth.test.ts`). A body could not be coloured from a stamp on a sibling container: its hue IS its trigger's vocabulary entry, which only the trigger's address selects, so a sibling body would need walk order to reach it. Measured floors live in `test/decor.test.ts` (ΔE in OKLab, since a contrast ratio cannot see two hues at one lightness): trigger/plane ≥ .10, adjacent planes ≥ .035 over depths 0–2 (depth 3 is the limit — the cap leaves .05 of recession while the hue has wrapped, 20 of 69 lineages fall below the floor, and nothing shipped reaches it; the design doc states the limit), nested trigger/enclosing plane ≥ .08, band text ≥ 2.15.

**Tint (ai7.4, `src/dsl/render.ts` + `src/template-engine/colors.ts`)**: `decorationFor(palette, region)` reads ONE thing for a node's region and projects it three ways — on the bar, the vocabulary entry its address selects (`decorEntryFor`): `tint` = `decorEntryColour(palette, entry)`, the colour the CLOSED cell wears, `text` = the terminal's own (a constant `undefined`, whatever the background), `disclosure` = `{ hue: entry.hue, depth: 0 }`, the band the segment opens; on a band, `tint` = `bandItemFor` of its band-relative address, `text` = `textOn(palette, ·)` over the background the cell resolves to — the tint, or an authored `bg:` that paints over it (text on a band cell is chosen: a fixed `foreground` measures as low as 1.1 : 1 on the pale bands of atom-one-dark, catppuccin-frappe and solarized-dark), `disclosure` = the band's hue one depth deeper — one selection, so a cell and the band it drops cannot disagree about their hue (`[LAW:one-source-of-truth]`). `enterSegment` hands the tint and text to `resolveSegmentColors(ref, segName, palette, disclosure, tint, text, bg, fg, scope)`: the segment's background is the authored `bg:` spec when one exists, else the tint; its foreground the authored `fg:`, else `text` of that background, so a `Style` always has a `bgcolor` and `{{ bgOf }}` reads the effective background — tint included — when no `bg:` is authored. The discriminator is the `bg?:` optionality already in the segment type (`[LAW:types-are-the-program]` — the existing optional field, no new flag): an authored `bg:` states MEANING and paints over the tint (a threshold's `error`, a context's `surface-active` are untouched); an absent `bg:` means decorated; no segment is asked whether it "looks decorative". The look transposes the base palette ONCE per render (`transposedPalette(basePalette, look)`), `NodeRenderCtx` carries that one `palette` (no `basePalette` + `look` pair), and a segment renders with `segCompiled.palette ?? ctx.palette` — there is no per-segment hue term any more: `hue.step` / `HUE_STEP_VAR`, the pre-order hue cursor and `nextHueShift`, are deleted with no successor. candybar-render-ai7.5 deleted every decorative `bg:` from the bundled default (`src/config/default-dsl-config.ts`) — directory, model, sessionId, version, tmux, git, gitaculous, gitPr, toolbar, session, today, speed, tokenSparkline, cacheTimer, metrics, and the three `settingsDrawer` controls author no `bg:` and wear the vocabulary tint — so the `bg:` that remain are meaning: `host` (`warning`, a hue-anchored alert) and the threshold templates on context/block/weekly/burnrate, whose calm arm names `panel`/`surface-active` as the threshold's own data. The synthesized settings menu (`src/config/settings-menu.ts`) and help cells (`src/config/help.ts`) author no `bg:` either, and only the `☰` door authors an `fg:` (`DOOR_TEXT`), so the door is tinted like its bar siblings and every body cell wears its band's item with chosen text. Pinned by `test/decor-wiring.test.ts`, expectations computed from `decorFor` over `addressOf` of the compiled tree: no-bg → tint; authored `error` wins; `bgOf` reads the tint; hiding a sibling recolours nobody; a row-2 first cell is the same colour whether row 1 has 1 or 3 leaves; the look reaches the tint; and, from ai7.5, every authored `bg:` in `DEFAULT_DSL_CONFIG.segments` is a template or an alert role (keyed as `Record<SemanticRole, true>`, so a new role is a compile error), the threshold/alert cells paint `error`/`warning` over the tint under a hot payload, and directory/model/gitaculous/toolbar/`settings.menu` wear `decorFor` of their address.

### Colors are values (`{{ color }}` / `{{ fg }}` / `{{ bgOf }}`)

A colour crosses the template seam as a `#RRGGBB` **string**, so it can be named in a `$var`, passed between operations, and composed by nesting. There is exactly one shape, and the simple case is a literal prefix of the composed case — an author adds an adjustment by *wrapping* working code, never by rewriting it into a different form:

```
{{ fg (color "primary") .git.branch }}
{{ fg (darken (color "primary") 2) .git.branch }}
{{ $muted := mix (color "foreground") (bgOf) 60 }}{{ fg $muted .git.repoName }}
{{ ramp .context.contextLeft "step" 0 "error" 21 "warning" 41 "surface-active" }}
```

- **`color "name-or-hex"` → colour.** One of the two palette-dependent functions (the other is `ramp`, below), and it reads the palette of the segment *currently rendering* (published by the walk through `src/render/active-segment.ts`), so a template body and its segment's `bg:`/`fg:` always agree. It is idempotent on hex, so `bg: "surface-active"` and `bg: '{{ darken (color "surface-active") 1 }}'` take one code path with no name-vs-literal branch.
- **`ramp <value> <easing> <position> <colour> [<position> <colour> …]` → colour.** A *number* mapped onto a colour through ordered stops; returns `#RRGGBB` like `color`, so it composes with `fg`/`bg` and every colour-math function, and the threshold decision transposes instead of living in an `if ge …` chain. `"linear"` interpolates between neighbouring stops in OKLCH (`Oklch.mix`); `"step"` holds the left stop's colour until the next position — a `≥ threshold → next colour` cascade as data, one word away from the gradient. Positions are REQUIRED (no even-spacing default — like `readableOn`'s ratio, the threshold is the decision) and must ASCEND: the ramp refuses to sort (`warning 80, error 50` sorted would silently be a different ramp), so a descending pair is a loud evaluation error; equal positions are a hard edge (the later colour takes over exactly there). The value clamps at both ends; a value on a stop returns that stop's colour byte-exact (no OKLCH round-trip). Stops are palette names or hex through the SAME resolution `color` uses, against the segment currently rendering, so a ramp over names follows a theme click and a look exactly as `color` does (registered beside `color` in rich-js `paletteFuncs`, not `colorFuncs`). A position may be a numeric var ref, so a user-overridable threshold rides in a position slot, as in the bundled default's every threshold cascade — block bg `{{ ramp (round .block.nativeUtilization) "step" 0 "panel" 50 "warning" .block.budget.warningThreshold "error" }}` (`round` keeps the colour in agreement with the displayed integer).
- **Pure colour math, from rich-js `colorFuncs()`:** `darken`/`lighten` (HSL levels), `mix a b pct`, `contrastOn bg`, `readableOn fg bg ratio` (ratio required — the WCAG threshold is the decision, and 4.5-vs-3 is a real intent difference), and one function per `ThemeKey` OKLCH axis (`shiftHue`, `scaleChroma`, `scaleLightness`, `shiftLightness`). Chaining more than two OKLCH ops quantizes; reach for `transposePalette` when a whole palette needs adapting.
- **`fg <colour> child` / `bg <colour> child`** are the only two sinks. They accept the full `ColorSpec.parse` vocabulary — hex from the math, or symbolic `"red"`/`"color(42)"` where the *terminal* should decide. Colour math takes hex only, because darkening a symbolic colour is meaningless.
- **`bgOf`** (cc-candybar-only) is the current segment's resolved background — what to blend *toward* for de-emphasis. Available in a segment's `fg:` and body, and loudly unavailable inside its `bg:` (the background is what that template computes).

Prefer **making quiet the default over wrapping each token**: set a segment's `fg:` to a computed colour and let only the operative facts name one. The bundled `git`/`gitaculous` segments do this (`GIT_QUIET_FG`), which is why their templates carry no de-emphasis markup at all — and it reaches tokens a wrapper never could, such as the output of a top-level `{{ template "…" }}` action.

There is deliberately **no** colour-spec mini-language. The old `"primary-darken-3 50%"` grammar, the `palette`/`paletteOver`/`auto` functions, the per-ANSI-name appliers, and the generated per-palette-variable appliers (`{{ primary x }}`, …) were all deleted: a themed palette carries ~150 variables of which ~14 are legal template identifiers, so a name family could never cover its own domain, and composition inside a *string* is function application spelled as punctuation that grows a production per operation.

**Looks** (brandon-themes-07p) are named theme *adaptations*: the top-level `looks:` block maps a name to a full rich-js `ThemeKey` (config spelling mirrors the field names verbatim — `hueShift`/`chromaScale`/`lightnessScale`/`lightnessShift`, all optional, absent = identity, normalized at parse in `src/config/loader/looks.ts`). A look is a transform, not a palette, so it composes with every theme; selection reuses the standard seam (session key `look`, an action `{ set: "look", from: "looks" }`, a `{{ menu }}`), resolved per render as `effectiveLookName(sessionState.look, globals.look, looks)` — session over config default over the `"none"` identity floor, stale names collapsing to the floor — then `lookKeyByName` → the ThemeKey `renderDsl` applies in ONE `transposePalette` call per render (never chained: chaining double-pays OKLCH quantization and collides the transpose memo). Per-segment `palette:` pins ignore the look. The bundled stdlib (`none`/`vivid`/`muted`/`dim`/`bright`/`inverted`) merges by name under user looks, so `"none"` exists in every merged config; `look.effective` rides the payload beside `theme.effective`. The "looks" option domain is per-config, so its names thread as data into both `optionDomain` (render) and `optionValuesFor` (validator derivation) — themes/styles stay registry-static.

### Variable system (`src/var-system/`)

MobX-backed store of named variables: `box` nodes for externally-driven values (input JSON, fs watchers, TTLs) and `computed` nodes for derivations (templates). MobX auto-tracks dependencies; the invalidation graph builds itself. **Don't add a parallel cache** — the store is the single source of truth (`[LAW:one-source-of-truth]`). The DSL template engine reads through this store.

Source kinds (`SourceRegistry.declare*`): `literal`, `input`, `env`, `file`, `shell`, `template`, `time`, `git`, `state`. New kinds require a new union arm in `src/config/dsl-types.ts`, a loader case in `src/config/dsl-loader.ts`, a `declareOne` arm in `src/dsl/render.ts`, and the runtime implementation here.

A `shell`/`file` source is ONE pipeline, read → parse → publish (`declareSource` in `src/var-system/sources.ts`; brandon-custom-segments-g5z.1): shell and file are two readers through it, and the authored `parse: { text: true } | { regex: "…" } | { json: true }` (a present-key union like `cache:`; absent = text; the old top-level `regex:` is a migration-pointing load error) is the parser VALUE flowing through it as the runtime `SourceParse` (`src/var-system/parse.ts`). `readMode` stays a file-reader fact, orthogonal to `parse`. The text/regex arms publish a string box; the json arm publishes a **document** — a `DocumentNode` holding `Outcome<JsonValue>` (absent until the first scan, failed with its reason, ok with the parsed null-prototype document or the declared `default`) — whose fields templates read by dotted path (`.budget.spent`) through the scope proxy (`src/template-engine/scope.ts`), which is the one place a non-ok document becomes an error naming the variable (the segment renders ⚠, `cc-candybar check` fails). `default` lives in the parser's output domain (string vs document); `sourceDefaultSpec` in the loader is its single enforcer. `store.read()`/`getType()` throw on a document by name; `changeKey(name)` is the total, structural change measure a `depends_on` reaction compares. `registry.settled(withinMs)` is the explicit "every shell/file source's current run completed" state `check` awaits (the names still in flight at the deadline are a warning); a git subscription's first delivery is not a run it waits for.

### Interactive actions (`src/config/action.ts`, top-level `actions:` block)

**Authoring a config?** Read `docs/interaction-authoring.md` first — the agent-facing reference for actions/`{{ menu }}`/groups, with one canonical example per intent, the mistakes paired with the loader's real error text, and the `cc-candybar check` verification loop. Every snippet in it is CI-tested against the live loader (`test/doc-snippets.test.ts`), so it is always current; this section is the architecture view, that doc is the authoring view.

Interaction is **decoupled by name**. The clickable *representation* (a region of a segment template) and the *behavior* (what the click does) are separate declarations joined by an action name. There is no widget type and no component kind (`[LAW:one-type-per-behavior]`) — there is one Segment, and whether it shows text, state-driven display, clickable regions, or all three falls out of what its template contains. The author binds a region to a named action, never to a validator or a hand-built URL. Re-glyph a button without touching behavior; re-target an action without touching the template (`[LAW:locality-or-seam]` — the name is the seam).

- **Action** (`ActionDecl` in `src/config/action.ts`) — the click effect, discriminated by which key is present, and for `set` by its value *source*:
  - `{ set: key, to: value }` — write a literal → allow-list `{to}`
  - `{ set: key, from: domain }` — write the option the template binds at render → allow-list `{options}`. `domain` is either a NAME resolved through `src/config/option-domain.ts`'s open registry (`themes`/`styles` are registry-backed static lists; `looks` is the one PER-CONFIG domain, the merged `looks` block's names, threaded in as data rather than globally registered — a render cache holds multiple configs with different `looks` blocks at once) or an INLINE literal array (`from: ["a","b"]`), which is its own domain and needs no registration at all. Adding a new registry-backed domain is one `registerOptionDomain(name, () => values)` call — no closed union to edit (candybar-config-engine-71o.1 deleted the old `OptionSource = "themes" | "styles" | "looks"` union). `render/action.ts` and `daemon/verbs/state-validators.ts` both resolve `from` through the SAME `resolveOptionDomain`, so rendered options and the derived gate cannot diverge.
  - `{ set: key, min, max, by }` — write `wrap(current ± by)` (a stepper affordance) → range `[min,max]`
  - `{ set: key, int: true }` — write any integer the render binds (a paged cursor: −1 closed / 0..N) → unbounded int gate
  - `{ set: key, cycle: [v0, v1, …] }` — write the *successor* of the current value, wrapping; a current value outside the domain counts as the first member (order members default-state-first). The bounded stepper's enumerated sibling: toggles, N-state cyclers, accordion names → allow-list `{members}`
  - `{ set: key, persist: field, persistWhen: selectorKey, <value source> }` — the **dual** arm (candybar-settings-ui-aok.3): ONE control writing *either* store, the destination chosen at click time by the boolean value of `selectorKey` (`parseSessionBoolean`, the one spelling of a boolean in SessionState). It carries both destination keys because they differ where history made them differ (session `theme` over globals `palette`), and one shared value source — `to`/`from`/`min-max-by`/`cycle`, i.e. every source both destinations have; `int` and the structural edits have no dual form. `actionDestinations` (`src/config/action.ts`) explodes one dual into exactly the two single-destination decls it is equivalent to, and BOTH validator derivations fold over that explosion → the gate is the union of the two halves' gates, derived by the code that always derived them. At render, `activeDestination` (`src/render/action.ts`) resolves the pair to one half for DISPLAY selection and for the picker's grid, while `realize` is handed the declaration itself: a **durable** click emits its `persist` effect carrying ONE MORE SEGMENT — the session key to RELEASE (`[sessionId, key, value, releaseKey?]` on `set-config`, `[sessionId, key, by, releaseKey?]` on `step-config`) — which `releaseSessionKey` (`src/daemon/verbs/index.ts`) clears only AFTER that handler's own write succeeded, gated by key membership in the state registry exactly as `reset-config` is over the config keyspace. The release is not optional — a session pick outranks a durable default, so without it a commit would set a default its own session could never see and the control would go dead for that session (the "try it, then tick persist? to commit" workflow, broken). It rides the write rather than sitting beside it as a second effect because `dispatch` runs every effect in a click by design: a pair would let a REJECTED write still wipe the user's pick, a lost update. Ordering that matters lives inside one handler, never in a hope about the dispatcher (`[LAW:no-ambient-temporal-coupling]`). The picker builds each option's URL by calling the SAME `realize`, so a dual picked from a `{{ menu }}` carries the clear too and there is no second projection of "what does this option write".
  - `{ copy: tmpl }` / `{ open: tmpl }` — copy / open a Go-template string evaluated at render → no gate

  Only `set` writes SessionState, so only `set` derives a validator; `copy`/`open` derive nothing. The vocabulary grows by arms, not by validator plumbing.
- **`{{ action "name" display… }}`** (`src/render/action.ts`) — binds one clickable region (an OSC-8 span) to the named action and realizes it against live state via one total fold over the compiled-action union: a `set-literal` writes its fixed value (active when the key already holds it); a `set-option` writes `boundValue ?? display` (the common picker form `{{ action "applyTheme" . }}`); a `set-int` writes the bound integer; a `set-bounded` writes the wrapped step; a `set-cycle` writes the successor of the current value and takes one display *per member* (positionally matched; the current member's display renders — `{{ action "toggle" "▸ x" "▾ x" }}`) or one static display; `copy`/`open` evaluate their pre-parsed template. Non-cycle kinds take `display [boundValue]`; wrong arity is a loud render error. Returns ONE `RichText` carrying one OSC-8 URL — `{{ action … }}` is one expression, so it emits one fragment. Note `set-cycle` writes the *absolute* successor computed at render (the glyph names the current state, so the click delivers the transition the glyph promised), unlike `set-bounded`'s relative nudge (rapid stepper clicks must accumulate).
- **`{{ menu "applyAction" display… [(dict …)] }}`** (`src/render/menu.ts`) — a disclosure whose body is a `{{ picker }}` dropped below the enclosing row. Its trigger's TEXT is authored, never emitted: a menu's disclosure IS a two-member `[closed, member]` cycle, so it binds displays through the SAME `pickCycleDisplay` (`src/config/disclosure.ts`) a cycle `{{ action }}` uses — one per state (`"▸" "▾"`) or one static display shown in both (`"+"`). Binding none is a LOAD error, not a defaulted glyph. Before candybar-settings-ui-aok.4 the runtime appended ▸/▾ itself while group sugar spliced the same constants into the template it synthesized — two policies for one fact, which is why edit mode's `+` rendered `+▸`; the constants stay (`src/help-text.ts` imports one so the CLI's instructions cannot drift from the bar), only their emission point moved to the call sites (`[LAW:one-source-of-truth]`).
- **`{{ picker "applyAction" "pageAction" closeOnPick paged }}`** (`src/render/picker.ts`) — a width-fit grid of option cells over `applyAction`'s resolved option domain, with ✕/←/→ affordances driven by `pageAction` (a `set-int` cursor). A pure render helper: it owns no state and declares no new gate, only references two already-declared, already-gated actions by name. `closeOnPick` folds a page-reset into the option's set-state write (one atomic apply+close). `paged` selects the available width passed to pagination — finite (term cols) ⇒ sliced pages with arrows; `Infinity` ⇒ one page the strip wraps — one value, not a mode (`[LAW:dataflow-not-control-flow]`).
- **Validator derivation** (`deriveActionValidators` in `src/daemon/verbs/state-validators.ts`) — the **sole** gate authority. Because every `set` carries its value source as literal data, the set of writable `(key, spec)` pairs is statically enumerable: literal/option → allow-list, bounded → range, `int` → unbounded int. A template references a name; it cannot smuggle an un-gated write — the rendered click and the wire gate share one source. Same-key contributions merge (allow-lists union; an `int` cursor subsumes a literal page-open like `{to:"0"}`; a kind clash throws), feeding the daemon-global `STATE_VALIDATORS` registry's multi-entry lifecycle (merge / ref-count / dispose-before-swap) unchanged from the widget era — only the derivation *source* changed.

`registerDslConfig` builds a **per-config** engine and injects the `action`/`picker` FuncMap entries as data (`[LAW:one-way-deps]` — the generic engine never imports the feature). The compiled actions and the FuncMap close over one `ActionRuntime` holding the live `VariableStore`, so a click reads `session.id` and the current value from the same source the rest of the render does. `renderDsl` is unchanged.

Example (a user config — the bundled default declares no actions; illustrative only, the maintainer's live config declares just `applyTheme`):

```json5
actions: {
  openMenu:   { set: "theme-page", to: "0" },        // open the menu at page 0
  themePage:  { set: "theme-page", int: true },       // the picker's page cursor
  applyTheme: { set: "theme", from: "themes" },        // picker binds each option here
},
segments: {
  trigger: {
    template: '🎨 {{ .theme }} {{ action "openMenu" "▸" }}',
    fg: "foreground",
  },
  pickerMenu: {
    template: '{{ picker "applyTheme" "themePage" true true }}',  // closeOnPick, paged
    fg: "foreground",
  },
},
root: { v: [
  { h: ["directory", "git", "model", "context"] },
  "trigger",
  { seg: "pickerMenu", when: "{{ ge (int .themePage) 0 }}" },  // row exists only when open
] },
```

### Group sugar (`kind: "group"` in the `root` grammar)

A **group** is a collapsible chunk of layout — an *input-only* node kind (`[LAW:one-type-per-behavior]` — arranging + gating are behaviors `container` already has, so "group" is only a spelling). The loader (`src/config/loader/layout.ts`) lowers `{ kind: "group", name, label, open?, direction?, key?, bg?, fg?, when?, children }` to canonical container/segment nodes and **synthesizes** the artifacts the one declaration implies, under the reserved `groups.` namespace in all three sections (`[LAW:one-source-of-truth]` — a user name under that prefix is a load error): a `state` var + a `cycle` action (`{ set: key, cycle: ["closed", name] }`) + a toggle segment (`▸/▾ label`) that carries the body in `opens` (`disclosureNode`, the one lowering every disclosure takes — see "Disclosure bands"); the body's openness derives from the same ref the toggle's cycle writes, so there is no `when` on the body to drift from it.

- **Independent toggle**: omit `key` — the group toggles its own derived key (`groups.<name>`).
- **Accordion**: sibling groups declaring the same `key` — one key holds one open name, so opening a sibling auto-closes the rest. Not a mode; just a shared value (`[LAW:dataflow-not-control-flow]`). The gate is the union of the sibling cycles via the existing same-key merge.
- **Nested disclosure**: nest groups with *distinct* keys — a closed parent's `when` hides the whole subtree (child open-state persists invisibly). An ancestor and descendant sharing a key is a load error (one key cannot represent "both open").
- Group names are identifiers (they splice into `.groups.<name>` template paths) and never `"closed"`. `label` is a plain string (escaped at synthesis); dynamic labels are raw-grammar territory. At most one group per shared key declares `open: true`.

### The global settings menu (`settings.menu`)

`synthesizeSettingsMenu` (`src/config/settings-menu.ts`) puts an always-present door in every preset root: one disclosure (`☰ ▸`, opening onto the `persist?` selector, preset switching, edit mode, and a `⚙ config` sub-disclosure holding one control per display setting) spliced into **every** preset root, minted once under the reserved `settings.` namespace and merely *referenced* per preset — which is what makes it idempotent across N presets, unlike a `kind: "group"` node, where a second reference would be a second declaration. It runs from `validateConfig` (it needs the merged tree, like edit chrome) and **before** `synthesizeEditChrome`, so edit chrome walks the final content tree and treats `settings.` as chrome-exempt — the door back into edit mode has no `-` beside it. It also guarantees `edit.toggle`, which is exactly what edit chrome's own demand gate reads — so edit mode's `[LAW:carrying-cost]` demand gate, while unchanged, now has a **permanent demander**: the menu's `settings.edit` entry references `edit.toggle`, so edit mode is live for essentially every config (as it already was in production, where the bundled default's `toolbar` referenced it). The gate's real edge is the menu's own precondition: `canHostSessionState` — a config declaring no `session.id` variable gets no menu, and therefore no edit mode, which is precisely the static non-interactive bar the gate protects. That predicate is exported and read by `cross-ref.ts` too, so an authored `settings.menu` anchor in such a config is a load error naming the missing variable rather than a reference the synthesis silently declines to satisfy. Placement is a **position**, not a mode (`[LAW:dataflow-not-control-flow]`): `withAnchor` returns a tree that provably contains the anchor — the author's own placement of the reserved `settings.menu` segment name, or the default position appended to the bar's first row — and one splice expands that leaf. A second placement is a load error (one key holds one open state); `cross-ref.ts` is where both the acceptance of the undeclared anchor name and that rejection live.

### The config menu and `persist?` (candybar-settings-ui-aok.3)

The menu's body is two rows: `☐ persist? · ▦ preset · ⚙ config · 🧰 tools · ✎ edit`, and — behind the `⚙ config` disclosure — `🎨 theme · ◐ look · ✦ style · wrap · padding`. Every one of those settings is ONE control bound to one **dual** action (see the action vocabulary above), and the `persist?` checkbox is the `persistWhen` selector they all name: unchecked (the floor — an unwritten key parses as false) each click is a session `set`; checked, the same click is a durable `persist`. `charset`/`colorCompatibility` are deliberately excluded — terminal capability facts with no session half, so a selector above them would be a control that does nothing for those rows; they stay in the bundled `settingsDrawer` (relabelled `⚙ terminal`) alongside the segment-palette pin.

**`🧰 tools › 🩺 doctor` (brandon-doctor-b6a)** is `⚙ config`'s sibling disclosure with a VERTICAL body: the `🩺 doctor` button (`{ doctor: "run" }`) and one row per entry of `CHECKS` (`src/doctor/checks.ts`), each gated on its verdict having left the unrun default and carrying a `[fix]` (`{ doctor: "fix", check }`) when the verdict does. A check is DATA — `{ name, label, probe: (DoctorFacts) => Verdict }` — and the doctor is `runDoctor`, the one fold both the click and `cc-candybar doctor` run (`[LAW:single-enforcer]`); probes are pure, and every effect (the `tmux display -p '#{client_termfeatures}'` query, the settings.json read and splice) sits behind the `DoctorEdge` record in `src/doctor/edge.ts`. The facts a check needs are ones only the statusline CLIENT can observe (it inherits Claude Code's exact env; the daemon is detached), so the client reports a `tmux` hint (`src/tmux-hint.ts`, mirrored in the Rust client; three wire states — absent = client too old, `null` = not in tmux, object = the facts — never collapsed) and the daemon records the stamped `ClientHints` per session under `SESSION_CLIENT_HINTS_KEY` (`"client-hints"`, beside the render-origin record) so a click, which carries no hints, reasons over the session's last render. The report is SessionState, keyed through `doctorReportKeys` in `src/doctor/report.ts` — the one spelling the menu's `state` variables and the verbs' `setBatch` share. The fix splices `~/.claude/settings.json` through the same span-tracking editor as the config file, in its `JSON_DIALECT` (quoted keys, no trailing commas — Claude Code parses that file strictly), and a `[fix]` click re-probes before it writes, refusing loudly when nothing is left to fix.

The four picker controls are DATA (`PICKER_CONTROLS`), each a `(name, sessionKey, configKey, effectiveVar, glyph, domain)` record the synthesis folds over, so a fifth settable field is one row, not a hand-written segment. Every control labels itself from its `.effective` projection — the value the daemon actually rendered with — and `compileDual` makes the SESSION half read back through that same var, so a cycle's glyph and its successor write agree whatever produced the current value. `SETTINGS_WRITTEN_KEYS` exports the plain (non-`settings.`-prefixed) keys this pass writes, because `theme`/`padding`/… are ordinary words a config can own; `test/helpers/ambient-chrome.ts` pairs it with an authorship check rather than re-spelling the list.

**The config file IS the durable store (candybar-config-dqe).** candybar-settings-ui-aok.3 deliberately did not decide where a durable write lands; dqe did. The daemon-owned overrides layer (`config-overrides.json`) is gone — a `persist`/`reset`/`+`/`-`/undo/redo click edits the user's config file in place through `src/daemon/config-file-store.ts` (span-tracking JSON5 splicing, `src/config/json5-edit.ts`: one value span replaced, every other byte preserved), and the daemon reloads it through the same watcher a hand edit trips. Precedence is bundled default < config file < active preset < session pick < edit mode. No application distinguishes "written by the settings menu" from "hand-edited", and neither does this one: `.preset.customized` now means "the config FILE authors a root at the active preset's root path", whichever of the two wrote it. The file written is the one the session's recorded render inputs resolve to at click time (`durableConfigPath` in `src/config/loader/discovery.ts` — the file the NEXT reload reads, never a snapshot of the last render's path), else `$XDG_CONFIG_HOME/cc-candybar/config.json5` is created; undo/redo step whole-file snapshots in `$XDG_STATE_HOME/cc-candybar/config-edit-history.json` (one stack per config file, depth 50 — a session steps the stack of the file its render resolved) and refuse loudly if the file changed since. Because `segments`/`presets` merge by name wholesale, the first write under a BUNDLED name materializes the whole bundled declaration into the file before setting the one field (per-field merge there is a follow-up ticket); root rows merge by name, so a structural edit on an inherited row materializes only `root.rows.<row>`. The menu needed no change for any of this: a dual names a destination PAIR (session / durable), and what "durable" physically means stayed the `persist` verb's business — moving it was a change in the daemon's verb handlers that the synthesis never saw.

### Click actions and the URL handler

Hyperlinks in segment output emit `cc-candybar://<verb>/<value>` OSC-8 links. On macOS, `cc-candybar install` builds `~/Applications/CCCandybarURLHandler.app`, copies the runtime to `~/Library/Application Support/CCCandybar/url-handler.mjs` (stable path independent of pnpm cache), and registers the URL scheme via Launch Services. Click → URL handler app → `cc-candybar url-handle <url>` → daemon click protocol. Verbs are dispatched in `handleClick` (`src/daemon/server.ts`).

## Distribution model

The npm package ships `dist/` (Node bundle) and a **committed** `bin/cc-candybar` node shim (dynamic `import()` of the adjacent bundle — valid from either module system; no lifecycle scripts at all, so the package works the moment any package manager lays the tarball on disk). Per-platform packages (`@promptctl/cc-candybar-darwin-arm64`, etc., declared as `optionalDependencies`) ship the prebuilt Rust binary. The native fast path is a **deploy-time** concern: `cc-candybar install` stages the runtime — the matching platform package's native binary, or the node shim where none exists (announced, never silent) — beside `dist/index.mjs` at a stable per-platform path (`~/Library/Application Support/CCCandybar` on macOS, `$XDG_DATA_HOME/cc-candybar` on Linux) and writes that staged path as the statusline command. **In a source checkout the native binary stages at `bin/cc-candybar-native`** (gitignored; `just install-rust`, or `just deploy` = build + stage), so the committed shim and the native artifact never fight over one path. pnpm settings live in `pnpm-workspace.yaml` (pnpm 11 no longer reads the `package.json` `pnpm` field).

`rust-client/Cargo.toml` is deliberately pinned to `version = "0.0.0"` — the npm package version is the source of truth, and CI overrides Cargo.toml at build time. Don't bump it manually.

## Architectural laws

The codebase cites laws inline (`[LAW:one-source-of-truth]`, `[LAW:dataflow-not-control-flow]`, `[LAW:single-enforcer]`, `[LAW:no-defensive-null-guards]`, `[LAW:no-silent-fallbacks]`, `[LAW:locality-or-seam]`, `[LAW:one-type-per-behavior]`). These are not decoration — they document load-bearing invariants and are the grammar reviewers use. When changing relevant code, cite the law you're acting under (`// [LAW:<token>] reason`) or the violation (`// [LAW:<token>] exception: reason`). Do not silently delete law markers.

Recurring patterns enforced by these laws in this repo:

- **One render path: `renderDsl`.** The daemon calls it verbatim; the demo calls it verbatim; tests call it verbatim. No parallel renderer, no "fallback" computation.
- **One config shape: `DslConfig`.** No alternate input format. `loadConfig` merges the user file on top of `DEFAULT_DSL_CONFIG` (`mergeWithDefault`): `globals` shallow-merge per field; `variables`/`segments`/`actions`/`helpers` merge by name (user wins per name); `root.rows` merge by name (a whole tree at `root` replaces every row). Authoring surface is the **Option A shape grammar** (`{ h/v: [...], when? }`, bare string segment refs, `{ kind: "group", … }` sugar). The flat `layout` row sugar and `kind: "cells"` nodes were deleted in 2de.19 — configs using them get migration-pointing errors — so a user file only needs to declare what differs from the bundled default.
- **Variability lives in data, not control flow.** The augmented payload (`src/daemon/render-payload.ts`) carries every value the templates can read; segments hide/show via `when` predicates on values, not branches in code.
- **Errors are loud.** Bad config doesn't silently degrade — `composeWithDiagnostics` (`src/render/diagnostic-strip.ts`) renders a red/amber strip above the bar for both fatal errors and advisory warnings (the `.json5` vs `.json` collision detector emits a warning, for example). The strip is ordinary render data (candybar-diagnostics-avi): every diagnostic line becomes word cells that flow through the same `renderStripCells` the bar's rows use, so it word-wraps at the client's real width by the one `cellLength` measure (a word wider than a row folds at cell boundaries via rich-js `chopCells`); the strip is capped at `min(20, termRows)` rows — `diagnosticRowCap`, the one resolution, over the `termRows` client hint that rides beside `termCols`/`ssh` in both runtimes — and closes with a `↳` trailer row exactly when it has something to open: the elided-row count with a plain `file://` OSC-8 link to the complete text (when the cap dropped rows; a refused dump write is stated in the row instead) and, when the diagnostic is a load error, a link to the failing config file. A strip whose rows all fit and names no failing file has no trailer — the update notice is one such row. The complete text lives in `$XDG_STATE_HOME/cc-candybar/diagnostics/<session>.txt`, owned by `src/daemon/diagnostic-dump.ts`: the file exists iff the session's last render carried a diagnostic, is rewritten only when the text changes, and the directory is wiped on daemon start. `file://` is chosen precisely because it needs no `cc-candybar://` handler — the escape hatch must not share a dependency with the thing that may be broken. Don't add silent `|| defaults` that hide a broken state.

## Testing notes

Tests live in `test/`. Useful starting points by area:

- Daemon internals: `test/daemon-git-cache.test.ts`, `test/daemon-watchers.test.ts`, `test/daemon-limits.test.ts`, `test/daemon-stats.test.ts`, `test/daemon-click.test.ts`.
- DSL spine: `test/dsl-spine.test.ts` (integration), `test/default-dsl-config.test.ts` (bundled default), `test/dsl-loader.test.ts` (validation).
- Template engine: `test/template-engine.test.ts`.
- Variables: `test/var-sources.test.ts`, `test/var-store.test.ts`.

Test timeout is 30 s (some tests touch real fs / timing); prefer faking time and fs over real waits when adding new tests.

## @promptctl/go-template-js API reference

Local source: `~/code/go-template-js`. Published as `@promptctl/go-template-js`.

### Core API

```ts
import { createEngine, sprigStrings, sprigDefaults, … } from "@promptctl/go-template-js";

const engine = createEngine<T>({
  fromString: (s: string) => T,        // required — lift text literals to T
  toString?: (v: T) => string,         // optional — flatten T to string for "stringifiable" slots
  funcs?: FuncMap,                     // optional — registered template functions
  random?: () => number,               // optional — pass to sprigRandom()
  clock?: () => Date,                  // optional — pass to sprigDatetime()
});

const tpl: Template<T> = engine.parse(source);     // parse once
const frags: T[] = tpl.evaluate(scope);            // evaluate many times
// or:
const fn = engine.compile(source);                 // returns (scope) => T[]
```

**`evaluate(scope)`** — the scope object becomes `.` (dot). `$` is the root scope. Field access `.foo.bar` walks JS object properties, `Map.get()`. Missing fields throw `MissingFieldError`.

**Parse once, evaluate many** — `engine.parse()` is expensive; `evaluate()` is cheap.

**`Engine<T>` methods:** `parse(source) → Template<T>`, `compile(source) → (scope) → T[]`, `evaluate(template, scope) → T[]`

### FuncMap composition

```ts
const funcs: FuncMap = {
  ...sprigDefaults(),
  ...sprigStrings(),
  myFunc: {
    fn: (s: string) => …,
    argTypes: ["string"],        // one ArgType per positional param
    returnType: "T",             // optional
  },
};
```

Go built-ins (`and`, `or`, `not`, `eq`, `ne`, `lt`, `le`, `gt`, `ge`, `len`, `index`, `slice`, `print`, `println`, `printf`, `call`) are always registered; consumer entries override on collision.

### ArgType quick reference

| ArgType | Accepts |
|---|---|
| `"string"` | JS string only — refuses typed T |
| `"number"` | number or bigint |
| `"bool"` | boolean |
| `"T"` | opaque caller-defined T (anything non-string) |
| `"ordered"` | string\|number\|bigint\|boolean; all slots must share a kind |
| `"comparable"` | JSON-shaped values; deep-equal across multiple slots |
| `"liftable"` | T or string (lifted to T via fromString before func body) |
| `"stringifiable"` | string or anything engine.toString can flatten |
| `"truthy"` | anything (truthiness context) |
| `"reflective"` | anything (type-inspection context) |
| `"value"` | anything (genuinely heterogeneous) |
| `"serializable"` | anything JSON.stringify-encodable |
| `"list"` | Array only (not string) |
| `"dict"` | plain object only |
| `"sized"` | string\|array\|Map\|Set\|plain object |
| `"collection"` | string\|array\|Map\|plain object (for `index`) |
| `"index-key"` | string\|number\|bigint |
| `"sliceable"` | string\|array |
| `"callable"` | function |

Variadic trailing slot repeats by default. `argTypePattern: "alternating"` cycles through argTypes (used by `dict` for key/value alternation).

### Sprig subset

| Factory | Key functions |
|---|---|
| `sprigDefaults()` | `default`, `empty`, `coalesce`, `ternary`, `fromJson`, `toJson` |
| `sprigStrings()` | `trim`, `trimPrefix`, `trimSuffix`, `upper`, `lower`, `title`, `repeat`, `substr`, `trunc`, `contains`, `hasPrefix`, `hasSuffix`, `replace`, `split`, `splitList`, `join`, `cat`, `indent`, `nospace`, `snakecase`, `camelcase`, `kebabcase`, `abbrev`, `plural` |
| `sprigMath()` | `add`, `sub`, `mul`, `div`, `mod`, `min`, `max`, `floor`, `ceil`, `round`, `seq`, `until` |
| `sprigLists()` | `list`, `first`, `last`, `rest`, `reverse`, `uniq`, `without`, `has`, `compact`, `concat`, `prepend`, `append`, `sortAlpha`, `all`, `any` |
| `sprigDicts()` | `dict`, `get`, `set`, `unset`, `keys`, `values`, `pick`, `omit`, `hasKey`, `merge` |
| `sprigRegex()` | `regexMatch`, `regexFind`, `regexFindAll`, `regexReplaceAll`, `regexSplit` (ECMAScript, not RE2) |
| `sprigTypes()` | `kindOf`, `kindIs`, `typeOf`, `typeIs`, `deepEqual`, `deepCopy` |
| `sprigConversions()` | `atoi`, `int`, `int64`, `float64`, `toString`, `toStrings` |
| `sprigHash()` | `b64enc`, `b64dec`, `sha256sum`, `uuidv4` |
| `sprigSemver()` | `semver`, `semverCompare` |
| `sprigFlow()` | `fail` (throws FailError) |
| `sprigRandom(rng?)` | `randInt`, `randAlpha`, `randAlphaNum`, `shuffle` |
| `sprigDatetime(clock?)` | `now`, `date`, `dateInZone`, `dateModify`, `ago`, `unixEpoch` (Go reference-time format) |

### Error types

All extend `TemplateError { kind: ErrorKind; pos: Pos; source?: string }`:

- `ParseError` — `{ expected?, found? }` — bad syntax
- `FuncNotFoundError` — `{ funcName, suggestions[] }` — unknown function at eval time
- `TypeMismatchError` — `{ funcName, argIndex (1-based), expected, receivedSummary }`
- `MissingFieldError` — `{ path: string[] }` — dotted field not found on scope
- `FailError` — thrown by `fail` builtin

`ErrorKind` discriminator: `"ParseError" | "EvalError" | "FuncNotFoundError" | "TypeMismatchError" | "MissingFieldError" | "FailError"`

### Variable scoping in templates

- `:=` declares a new variable in current frame: `{{ $x := .foo }}`
- `=` reassigns in the declaring frame: `{{ $x = newValue }}`
- `range`, `with`, `if/else` each push a new scope frame

### cc-candybar integration notes

- `T = StyledFragment[]` (from rich-js) — `fromString` lifts text literals; `toString` flattens fragments back to string for sprig string ops.
- Style functions (`bold`, `fg`, `bg`, `link`) and the color-value math (`color`, `darken`, `mix`, …) are registered by rich-js's binding module, **not** here.
- Variable resolver: dotted access `.session.id` → `store.read('session.id')` (pass a scope object built from `VariableStore.read`).
- Cast bindings (`int`, `string`, `bool` in templates) should call `toNumber`, `toString`, `toBool` from `src/var-system/types.ts`.
- Template module lives at `src/template-engine/` (new, chunk 2 work).

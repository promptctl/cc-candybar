# Rust Port

**Status: PROPOSED.** Not scheduled; begins after the TypeScript daemon is feature complete. Companion skill: `.claude/skills/rust-port/SKILL.md`.

## Summary

The daemon will be ported to Rust with no change in observable behaviour: the same socket path, wire format and protocol version, the same config files, the same rendered bytes for the same payload. The reason is memory: the TypeScript daemon carries an RSS backstop, a heap cap, and a heap-snapshot-on-breach path, all of which exist because a garbage-collected runtime cannot be told how much resident memory to use. The port depends on three libraries that do not exist in Rust in the form we need and that the maintainer has already written once in TypeScript: styled text and colour (rich-js), Go `text/template` with a Sprig subset (go-template-js), and the MobX subset the variable system uses. The existing Rust render-path client becomes the client half of one workspace. One thing happens before any of it is scheduled: the two post-fix RSS breaches (2026-09-04 and 2026-09-06) get diagnosed, because if the resident memory at breach is not V8's, a port reproduces the problem in a language with no collector to blame.

## Why rewrite

The September investigation (`docs/daemon-memory-2026-09.md`) found the daemon's heap was duplicated helper ASTs, not transcripts: each of the ~287 templates a bundled-default config parses carried its own copy of the helpers' parse tree, 29.4 MB per registered config, multiplied by ~20 open sessions in the render cache. The fix (go-template-js 0.8.0 plus PR #198) took heap per config to 1.1 MB and live RSS on the same machine from 878 MB to 186 MB. The same week exposed an unrelated failure: the spawner's 400 MB V8 heap cap sat below the 512 MB RSS backstop, so V8 aborted silently before the backstop ever polled (PR #197 derives the cap from the budget, `HEAP_CAP_OVER_RSS = 2` in `src/daemon/limits.ts`, mirrored in `rust-client/src/launch.rs`). That doc records the budget being raised to 2048 MB during the investigation; the live daemon boots with `heapCap=1120MB rssLimit=512MB`, so 512 MB is current and 2048 MB is historical.

The backstop kept firing after the fix. It writes a heap snapshot on every breach, and three exist under `$XDG_STATE_HOME/cc-candybar/`:

| Breach | Snapshot size | Nodes | Edges | Cause |
|---|---|---|---|---|
| 2026-09-03 | 909 MB | 12,460,522 | 45,269,239 | Helper-AST duplication; fixed by go-template-js 0.8.0 + PR #198 |
| 2026-09-04 | 52.6 MB | 654,861 | 2,725,980 | Post-fix; unexplained |
| 2026-09-06 | 70.8 MB | 883,791 | 3,672,269 | Post-fix; unexplained |

The first snapshot has nineteen times the nodes of the second. The two post-fix snapshots are small by comparison, and the live daemon shows the same proportions (pid 29102, v1.60.0, 450 s uptime): 212 MB RSS against 63 MB of used heap, 121 MB heap total, 3.8 MB external, 0.9 MB array buffers; 25 render-cache entries, 25 git-cache entries, 50 active watchers, 200 subprocesses in the last minute (all `git`, p50 6 ms), and a usage cache of size 0.

The hypothesis, not yet verified, is that the post-fix breaches happened with roughly 50–70 MB of JavaScript heap while RSS crossed 512 MB, so most resident memory at breach was not JavaScript objects. The candidates are V8 pages reserved but not returned to the OS, external buffers from transcript reads, subprocess churn at 200 `git` spawns a minute, `fs.watch` handles, and macOS RSS accounting. A `vmmap` of the live daemon together with `v8.getHeapStatistics()` and `process.memoryUsage()` sampled over time would decide between them.

That diagnosis precedes the rewrite, and it is the one gate this document insists on. If the resident memory is V8's, a language without a collector fixes it by construction. If it is file-backed pages, subprocess churn, or kernel accounting, a Rust daemon that reads the same files, spawns the same 200 `git` processes a minute, and holds the same 50 watchers breaches the same backstop, and the port has cost its months for nothing on the axis it was justified by. It may still be worth doing for the reasons in the next section, but it should be decided on those, not on an unmeasured memory claim.

## Why Rust

Each reason is paired with what it changes in this codebase; a reason with no concrete effect here was left out.

**Deterministic memory.** Without a collector, the RSS backstop, the spawner's heap cap, the `HEAP_CAP_OVER_RSS` mirror in two runtimes, and the heap-snapshot-on-breach path stop existing as concepts. `src/daemon/limits.ts` and the `launch.rs` mirror are deleted, not ported. Memory is what the data structures hold.

**Sum types with exhaustive matching.** The daemon is built on discriminated unions, and the compiler checks their totality only where a `switch` happens to be written as one total projection. In Rust each becomes an enum the compiler refuses to `match` with an arm missing: `Outcome` (absent / failed / ok), `Presence` (present / absent / Unchecked), `ConfigResolution` (file / default / missing / unreadable), `BuildCurrency` (current / stale / not-source-checkout / unchecked), `Region` (bar / band), the `ActionDecl` union (`src/config/action.ts` is the source of its arm list: `set` and `persist` each with their value sources, the structural `persist` edits, `copy`, `open`, `reset`, `undo`, `redo`, `doctor`, and the dual form), and `LayoutNode` (container / segment). `[LAW:types-are-the-program]` is what the codebase already claims; the port makes the compiler enforce it.

**Ownership and `Drop`.** The render cache's contract, "the `SourceRegistry` owns the async handles; dispose before swap" (`reloadInto` in `src/daemon/cache/render.ts`), is a discipline the code follows. In Rust the registry's watchers, timers, and git subscriptions are fields whose `Drop` runs when the old registry is dropped, so a swap that forgot to dispose cannot be written. `[LAW:single-enforcer]` becomes structural rather than reviewed.

**One crate for client and daemon.** The Rust client mirrors the wire protocol as literal consts, and `scripts/check-protocol.mjs` diffs every one against the TypeScript source so `prepublishOnly` fails on drift. With both halves in one workspace sharing one `protocol` module, the script, its `CHECKS` table, and the lockstep rule in CLAUDE.md are deleted. `[LAW:one-source-of-truth]` is satisfied by having one source.

**The release pipeline already builds Rust.** `.github/workflows/release.yml` cross-compiles all four targets (x86_64 and aarch64 for linux-gnu and apple-darwin) from Linux with `cargo zigbuild`, no macOS runners, and publishes them as per-platform npm packages (`@promptctl/cc-candybar-darwin-arm64` and siblings, as `optionalDependencies`). A Rust daemon is one more binary through a path that exists.

**Crates for the arithmetic.** `palette` for OKLCH and OKLab, `unicode-width`, and `unicode-segmentation` are the crates the port would lean on for colour math and cell measurement. Their versions and current state are from training, not verified today; verifying and pinning them is part of phase 1's exit criterion.

### Where Go would have been easier

Four things are acknowledged so the choice is made with them in view. Goroutines fit the daemon's shape of watchers, timers, and subprocesses more naturally than an async runtime chosen after the fact. `pprof` is a better profiler out of the box than anything the port will have on day one. Go compiles and iterates faster. And a mutable reactive graph, which the variable system is, is easier to write without a borrow checker over every edge. The template layer is not a factor either way: the maintainer has said porting go-template-js again is not a blocker for either language.

## What the landscape shows

Ten Claude Code statusline projects were surveyed. None takes input from the bar: no click routes back into the tool (ccstatusline's OSC-8 link widget opens external URLs only). None has a template language; the closest are claude-powerline's `{segment.part}` placeholders and a Go project's `$model` substitution. Two have a persistent daemon: `claude-code-usage-bar` (Python and Go, 372 stars, v3.42.0 on 2026-09-05), whose client is a `cat` of a pre-rendered file with a 5 s staleness fallback rather than a socket RPC, and `ersinkoc/claude-statusline` (Python, 78 stars, inactive). The largest by stars is `claude-hud` at ~27.9k, followed by `ccstatusline` at ~12.8k, both per-render; `CCometixLine` (3.5k) is a Rust single binary stale since 2026-03-14.

What the survey says for this document is what the port must not lose. The interaction loop (a click on the bar writes session state the next render reads) and the config DSL are the two things nothing else in the space has. A port that simplified either away to make the Rust easier would ship a faster copy of a project that already exists ten times over.

## What the port preserves

The port changes no observable behaviour. Same socket path, same wire format and protocol version, same config files read and written, same rendered bytes for the same payload. Each invariant below is load-bearing and is cited in the codebase by the law it serves.

**Wire protocol and process model**

- One per-render client talks to one daemon over `/tmp/cc-candybar-$UID/socket`, 4-byte big-endian length plus JSON, protocol v3 as live today.
- One daemon instance per user, mutex'd via `$XDG_STATE_HOME/cc-candybar/pid`.
- On daemon miss the client spawns a detached daemon and prints `\n`.

**Config shape and merge**

- One config shape, `DslConfig`; the user file merges over the bundled default, per field for `globals`, by name for `variables`/`segments`/`actions`/`helpers`, by named row for `root`.
- The Option A shape grammar for `root`; the flat `layout` and `cells` forms stay rejected with migration-pointing errors.
- A disclosure body hangs on its trigger (`SegmentNode.opens`); there is no `when` on a body.

**Renderer and colour**

- One renderer, `renderDsl`, called verbatim by the daemon, the demo, and the tests; no parallel render path `[LAW:one-source-of-truth]`.
- Decorative colour by tree address (`decorFor`), bands by disclosure (`bandFor`), state colour by hue; OKLCH and every other colour operation live in the styled-text library, never in the daemon.

**Variable system and sources**

- `box` and `computed` nodes in one store; no parallel cache.
- Source kinds literal / input / env / file / shell / template / time / git / state; shell and file are one pipeline, read → parse → publish.
- `parse: json` publishes a document holding `Outcome<JsonValue>`, read by dotted path, failing loudly by variable name.

**Actions and derived validators**

- The action vocabulary is the `ActionDecl` union in `src/config/action.ts`, the source of its arm list; the file wins if this summary diverges. Read today: `set` (to / from / min-max-by / int / cycle), `persist` (to / from / min-max-by / cycle, plus the structural removeSegment / insertSegment / insertSegmentFrom edits), `copy`, `open`, `reset`, `undo`, `redo`, `doctor` (run / fix), and the dual set+persist form, a separate declaration sharing one of the value sources both destinations have.
- Validators are derived from the action declarations (`deriveActionValidators`), the sole gate authority `[LAW:single-enforcer]`; a template can reference an action but cannot smuggle an un-gated write.
- Click → URL handler → `url-handle` → daemon verbs, unchanged.

**Caches**

- Git state keyed by repo root, invalidated by fs watchers on `.git/HEAD` and `.git/index`; the PR lookup in its own cache with its own TTL.
- The session usage store's byte-cursor incremental append fold; an inode change or a shrink below the cursor resets that file.
- The render cache per `(projectDir, cwd)`, LRU 256, dispose-before-swap, seeded with the default's state so a broken first load still renders.
- Session state per session.

**Loud errors**

- The diagnostic strip is render data, word-wrapped by the same cell measure as the bar `[LAW:no-silent-fallbacks]`.
- The recovery path's `file://` links never depend on the `cc-candybar://` handler.
- Duplicate keys surface as warnings; `cc-candybar check` fails on a ⚠ segment.
- The update notice compares the baked source digest to `src/` beside the bundle, and polls the registry only for published installs (how the digest is baked without a JS bundle is an open question below).

**Durable config editing**

- The config file is the durable store; a persist, reset, structural edit, undo, or redo is a span-tracking JSON5 splice that replaces one value span and preserves every other byte.
- Undo and redo step whole-file snapshots and refuse if the file changed since.
- `durableConfigPath` is resolved at click time from the session's recorded render inputs, never from a snapshot of the last render's path.

## Component map

The TypeScript daemon is 39,534 lines of `src/` and 47,711 lines of `test/`. The two supporting libraries are larger than the daemon that uses them.

| TypeScript module or library | Lines | Rust crate or module | Notes |
|---|---|---|---|
| `rust-client/` | 1,848 | `cc-candybar` crate (exists; `rust-client/Cargo.toml`) | Becomes the client half of one workspace; its mirrored protocol consts are replaced by the shared `protocol` module |
| rich-js (styled text, colour) | 22,775 | `cc-rich` crate, own port | Ported from rich-js's own test suite; `palette` for OKLCH/OKLab, `unicode-width` for cells (versions not verified) |
| go-template-js (`text/template` + Sprig) | 16,907 | `cc-gotmpl` crate, own port | Named apart from the published `gotmpl`, which Template engine below evaluates and rejects |
| MobX subset (`src/var-system/store.ts`, `sources.ts`, `src/daemon/session-state.ts`) | — | Reactive runtime | `reactive_graph` or an own runtime; see Reactive runtime below |
| `src/daemon/server.ts`, `protocol.ts`, `paths.ts`, `limits.ts`, `parent-watchdog.ts` | — | `daemon` module | Socket, framing, pid mutex, parent-death watchdog; `limits.ts` is deleted, not ported |
| `src/daemon/cache/git.ts`, `src/daemon/cache/session-usage-store.ts`, `src/daemon/cache/render.ts`, `src/daemon/session-state.ts` | — | `cache` module | Git watchers, PR TTL cache, byte-cursor usage fold, render LRU with `Drop`-driven dispose |
| `src/var-system/` | — | `var_system` module | Boxes, computeds, the nine source kinds, `SourceParse`, documents |
| `src/dsl/render.ts`, `src/render/`, `src/themes/` | — | `render` module | `registerDslConfig` + `renderDsl`, decor and bands, actions, picker, diagnostic strip |
| `src/config/` (loader, merge, schema emitter, `json5-edit.ts`) | — | `config` module | Validation with the same error text; the span-tracking JSON5 editor; the JSON schema emitter stays one source with the validator |
| `src/doctor/` | — | `doctor` module | `CHECKS` as data, `runDoctor` as the one fold, effects behind `DoctorEdge` |
| `src/install/`, `src/click/`, URL handler | — | Unchanged unless verified | The macOS URL handler app and Launch Services registration are deploy-time artifacts; whether they and `cc-candybar install` stay in Node is an open question |

Line counts for individual daemon modules were not measured; the 39,534 total covers them all.

## Reactive runtime

The variable system uses a small, exact subset of MobX. Three files import it (`src/var-system/store.ts`, `src/var-system/sources.ts`, `src/daemon/session-state.ts`) and nothing else does. The subset is:

- `observable.box(initial, { deep: false })` for `BoxNode` and `DocumentCell` in `store.ts`.
- `computed(fn, { keepAlive: true })` for `ComputedNode`. The comment in the source explains the flag: without `keepAlive`, MobX treats an unobserved computed as uncached and re-runs it on every read, and the render path is pull-only, with no `autorun`.
- `reaction(expr, effect)` at two sites in `sources.ts`: the `key` cache policy, where a parsed key template is evaluated inside the tracked expression and the source re-runs when its rendered string changes, and `depends_on`, which tracks the joined `changeKey` of named variables. Both push an `IReactionDisposer` onto a cleanups list. A MobX `reaction` runs its effect only when the expression's result changes, not on every tracked write.
- `runInAction` in `store.ts` (`set`, `setDocument`, `runInAction`) and in `sources.ts`, one per delivery, so a multi-write delivery invalidates dependents once.
- `createAtom` with `reportObserved()` and `reportChanged()` in `session-state.ts`, so a render that reads session state registers a dependency and a click that writes it fires once per batch.

Not used: deep observables, proxies, decorators or `makeObservable`, observable arrays or maps, `autorun` in the render path.

The subset is ported rather than replaced with a static, AST-derived dependency graph, because the `key` reaction discovers its dependencies by evaluating a template through the scope. The set of variables a key template reads is only known by running it, so a graph computed from the AST would either over-approximate (every variable the template could name) or miss reads that go through helpers and dotted document paths. Porting the observer model keeps every pinned test's semantics.

Five primitives are needed: a signal, a lazily cached memo, a disposable effect, a batch, and a data-less atom. The crates surveyed, every licence read verbatim from the crates.io licence field:

| Crate | Version (date) | Licence | Standalone | Signal | Lazy cached memo | Disposable effect | Batch | Atom |
|---|---|---|---|---|---|---|---|---|
| `reactive_graph` | 0.2.14; 0.3.0-beta2 (2026-07-18) | `MIT` | yes | yes (`RwSignal`, `ArcRwSignal`) | yes (`Memo`, lazy per docs; zero-observer caching not stated) | yes (`ImmediateEffect` stops on drop; `Effect::stop()`) | partial (`batch` covers `ImmediateEffect` only) | yes (`Trigger`: `track()` / `notify()`) |
| `sycamore-reactive` | 0.9.3 (2026-08-31) | `MIT` | yes (`create_root`) | yes | no (`create_memo` is eager) | no (`create_effect` returns `()`, scope disposal only) | yes | no (idiom: `create_signal(())` + `track()`) |
| `dioxus-signals` | 0.7.10 (2026-07-30) | `MIT OR Apache-2.0` | no (`Runtime::new` is `pub(crate)`, panics without a VirtualDom) | yes | not verified | not verified | no | not verified |
| `futures-signals` | 0.3.34 (2024-07-26) | `MIT` | yes | yes | no (not auto-tracking; explicit `map`, lossy) | not verified | no | no |
| `reaktiv` | 0.1.1 (2025-12-19) | `MIT OR Apache-2.0` | yes | yes (bare `Signal::emit` / `track_dependency`) | yes (`Computed::lazy`) | yes (drop-disposed) | yes (`Transaction::run`) | yes (a `Signal` is data-less by design) |
| `observe` | 2.0.0 (2026-01-20) | `MIT` | partial (hard tokio dependency) | yes (`Var`) | yes (`Computed`) | partial (`Reaction`; "Reactions must be triggered inside a batch()") | yes | not verified |

Adoption, from crates.io downloads: `reactive_graph` 2,541,837 total / 1,081,737 recent, repository last commit 2026-09-03; `sycamore-reactive` 298,929 / 19,646; `dioxus-signals` 2,738,871 / 1,102,856; `futures-signals` 1,024,630 / 101,374; `reaktiv` 48 lifetime downloads, 13 stars; `observe` 6,421 downloads with 11% documentation coverage. `floem_reactive`, `leptos_reactive`, and `reactive-signals` are outside the 18-month window and were not evaluated.

`reactive_graph` is the only crate that covers all five primitives standalone, under a permissive licence, with real adoption, with two of the five still open per its own row: batch semantics and zero-observer memo caching are confirmed by the phase-1 spike (Translation points 3 and 4 below). It is runtime-agnostic by its own README (browser, tokio, GTK), its Cargo dependencies contain no leptos crates (`any_spawner`, `slotmap`, `futures`), and every doctest bootstraps it with an `Owner` and an executor. `reaktiv` covers the five too and is the closest to MobX of anything surveyed (a bare atom, a lazy computed, a transaction, drop-disposed effects), but at 48 downloads it is a reference implementation to read, not a dependency to take.

The alternative is writing the runtime, roughly 1–2k lines: a thread-local observer stack; a slotmap arena holding every node, with `Copy` handles; interior mutability confined to the arena; three-state dirtiness (clean / possibly-stale / stale) so a recompute that produces an equal value does not cascade; lazy memos that recompute on read; effects queued until batch end. A runtime confined to one thread matches the daemon, which renders one request at a time.

### Translation points

If `reactive_graph` is adopted, four things do not map one-to-one and must be settled in the phase-1 spike:

1. MobX `reaction` fires only when the expression's value changes. The equivalent is a `Memo` (whose `PartialEq` gates propagation) feeding an `ImmediateEffect`, not a bare effect over the expression.
2. Effect closures must be `Fn + Send + Sync`. That constraint reaches into how the store is shared, since the closures at the two `reaction` sites hold the source they re-run; whether this fits a single-threaded store or forces `Arc<Mutex<…>>` is an open question below.
3. `batch` defers `ImmediateEffect`s only. The `runInAction` sites rely on dependents invalidating once per delivery; the port must confirm that memos read after a batch see one recompute, not one per write.
4. `Memo` is documented as lazy and as running once per change however often it is read, but caching with zero observers, the `keepAlive` semantics `ComputedNode` depends on, is not stated in the docs. The hypothesis is that the value persists as long as the handle does; it is verified by a test before any code relies on it.

The licence constraint is the maintainer's, stated in conversation: permissive only (MIT, Apache-2.0, BSD, Zlib, MIT/Apache dual); GPL, LGPL, MPL, AGPL, and unlicensed code are disqualified. Every licence in the table above was read from the crates.io licence field, and each candidate in the table clears the constraint; the decision between them is on primitives and adoption, not licence.

## Template engine

No existing Rust crate fits, for one structural reason: the engine's values must carry an opaque styled-text type through typed function slots, and every Go-syntax crate closes its value type.

In the TypeScript engine, `T = StyledFragment[]`: a text literal is lifted through `fromString`, a style function takes a `"liftable"` slot and returns `T`, and a colour crosses the seam as a `#RRGGBB` string so it can be named in a `$var` and composed by nesting. The argument-type vocabulary (`"string"` refusing typed `T`, `"liftable"` accepting either, `"stringifiable"` flattening through `toString`) is what lets `{{ fg (darken (color "primary") 2) .git.branch }}` type-check at the function boundary. An engine whose `Value` is a closed enum has nowhere to put `T`.

- `gtmpl` 0.7.1: last commit 2021-08-06, six open issues including "Unimplemented syntax `=`" (variable reassignment, part of the template vocabulary the engine must cover). `gtmpl_value::Value` is a closed enum (NoValue, Nil, Bool, String, Object, Map, Array, Function, Number) and functions are `fn(&[Value]) -> Result<Value, FuncError>`; there is no variant for a user type.
- `gotmpl` 0.6.1 (2026-07-13): created 2026-04-20, two stars, MIT, `forbid(unsafe)`, no_std. It covers the syntax (pipelines, `:=` and `=`, if/else, range with break and continue, with, define/template/block, trim markers, custom delimiters, printf) but its `Value` enum is closed (Nil, Bool, Int, Uint, Float, String, List, Map, Function) with no struct field access and no method calls.
- No full Sprig port exists: `sprig` 0.3.0 is from 2021, built on `gtmpl`, dormant with 13 open issues; `lithos-sprig` 0.1.0 (2025-11-01) is a curated subset.

Two escapes were considered and rejected. Switching syntax to `minijinja` 2.24.0, which does have an opaque-value mechanism (`trait Object`, `Value::from_object`, `downcast_object_ref::<T>()`, typed `ArgType` arguments), would break every user config and every snippet in the agent-facing authoring docs; the template language is user-visible surface, not an implementation detail. Embedding a JavaScript engine to keep running go-template-js as-is (`rquickjs` 0.13.0 on QuickJS-NG is the mature option; `boa_engine` 0.22.0 is experimental; `deno_core` was archived into the deno monorepo on 2026-04-02) would keep a second runtime, a second allocator, and a second memory story inside the process the port exists to simplify.

The decision is an own port of go-template-js, as the maintainer already did once in TypeScript: the same parser, argument-type vocabulary, and Sprig subset, with `T` as a generic parameter and functions as typed Rust closures. For the record, the Go route would have been stdlib `text/template` plus `Masterminds/sprig/v3` 3.3.0, where any Go type flows through pipelines by reflection; that is the one place Go had a library answer and Rust does not.

## Sequencing

Each phase has an exit criterion. The TypeScript daemon keeps shipping and receiving fixes until phase 4; nothing below stalls it.

**Phase 0: memory diagnosis.** Sample `vmmap`, `v8.getHeapStatistics()`, and `process.memoryUsage()` on the live daemon over a working day, and read the two post-fix heap snapshots. Exit: a written finding, appended to `docs/daemon-memory-2026-09.md`, stating what the resident memory at breach was made of and whether a port removes it, and one sentence in Why rewrite above replacing the hypothesis with the measurement. If the answer is "not V8's", the port's justification is rewritten around the reasons in Why Rust before phase 1 starts.

**Phase 1: the three libraries as crates.** `cc-rich`, `cc-gotmpl`, and the reactive runtime (a spike deciding `reactive_graph` against an own runtime, on the four translation points), each in its own crate with its own tests ported from the TypeScript libraries' suites. Exit: every ported test passes; the crate versions of `palette`, `unicode-width`, and `unicode-segmentation` are verified and pinned; the memo-with-zero-observers behaviour is pinned by a test.

**Phase 2: daemon core.** Protocol and framing, socket, pid mutex, the parent-death watchdog, the four caches, the variable system with its nine source kinds, config loading and merge, `registerDslConfig` and `renderDsl`. Exit, the parity gate: for every existing test payload, a request over the socket to the Rust daemon returns byte-identical output to the TypeScript daemon, diagnostics strip included. The gate is a test that runs both daemons on isolated sockets and diffs; it stays in the suite until phase 4 deletes one side.

**Phase 3: verbs and the loop.** The click verbs, session state, the durable config editing path (span editor, undo/redo, `durableConfigPath` at click time), the doctor, the update notice, `daemon-stats`. Exit: the click-path tests pass against the Rust daemon; a live session drives the settings menu end to end through the real URL handler.

**Phase 4: cutover.** `cc-candybar install` stages the Rust daemon at the per-platform data path. The TypeScript daemon is deleted, not kept as a fallback: one renderer is the rule (`[LAW:one-source-of-truth]`), and a fallback path is a second renderer that will drift the moment nobody is watching it. `scripts/check-protocol.mjs`, `src/daemon/limits.ts`, and the heap-cap mirror go with it. Exit: a release whose npm package ships no `dist/` daemon and whose `daemon-stats` reports no heap, and every test that pinned daemon behaviour has a Rust counterpart or a recorded reason it does not.

## Open questions

- **Is the post-fix RSS V8-owned?** This decides whether the rewrite fixes memory at all. Phase 0 answers it; nothing else is scheduled until it does.
- **`reactive_graph` or an own runtime?** A phase-1 spike decides, on the four translation points. The crate wins if `Memo` + `ImmediateEffect` reproduces `reaction`'s change-gated firing and `batch` covers the `runInAction` sites; the own runtime wins if either needs a workaround.
- **Do `Send + Sync` effect closures fit a single-threaded store?** The daemon renders one request at a time. If `reactive_graph`'s closure bounds force `Arc<Mutex<…>>` around the store, the lock is paid on every variable read for a property the daemon never uses, which is a point for the own runtime.
- **How does the source digest map without a bundle?** The update notice compares `__SOURCE_DIGEST__`, baked into the JS bundle at build, to `sourceDigest(src/)` recomputed on a timer. A Rust binary has no bundle; the digest would be baked at compile time by a build script, and whether `src/` beside the binary still means what it means today for a source checkout is not settled.
- **Do the URL handler and installer stay in Node?** `cc-candybar install` builds the macOS URL handler app and registers the scheme with Launch Services; `url-handle` relays the click. Both are deploy-time and could stay in the Node package, or move to the Rust binary so the package ships no JavaScript. Unchanged unless verified.
- **Which async runtime, if any?** Watchers, timers, and subprocesses could be tokio, a poll loop over `kqueue`/`inotify`, or threads. Not decided; it interacts with the `Send + Sync` question.

## Sources

**Memory (Why rewrite).** `docs/daemon-memory-2026-09.md` in this checkout. Live stats: `node dist/index.mjs daemon-stats --json` on 2026-09-10 (pid 29102, v1.60.0). Boot budget: the `daemon up:` line in `~/.local/state/cc-candybar/daemon.log`. Snapshot node and edge counts: read from the `.heapsnapshot` file headers under `$XDG_STATE_HOME/cc-candybar/` on 2026-09-10.

**Sizing (Component map).** `wc -l` over `src/**/*.ts`, `test/**/*.ts`, `rust-client/src/*.rs`, `~/code/go-template-js/src` (0.9.0), and `~/code/rich-js/src`, 2026-09-10.

**MobX subset (Reactive runtime).** `grep` of `src/` for `mobx` imports and call sites, 2026-09-10.

**Reactive crates (Reactive runtime).** Licences from the crates.io licence field, 2026-09-10.
- https://crates.io/crates/reactive_graph
- https://docs.rs/reactive_graph/0.2.14/reactive_graph/signal/
- https://docs.rs/reactive_graph/0.2.14/reactive_graph/computed/struct.Memo.html
- https://docs.rs/reactive_graph/0.2.14/reactive_graph/effect/struct.Effect.html
- https://docs.rs/reactive_graph/0.2.14/reactive_graph/effect/struct.ImmediateEffect.html
- https://docs.rs/reactive_graph/0.2.14/reactive_graph/effect/fn.batch.html
- https://docs.rs/reactive_graph/0.2.14/reactive_graph/signal/struct.ArcTrigger.html
- https://crates.io/crates/sycamore-reactive
- https://docs.rs/sycamore-reactive/0.9.3/sycamore_reactive/
- https://crates.io/crates/dioxus-signals
- https://docs.rs/dioxus-signals/0.7.10/dioxus_signals/struct.Signal.html
- https://docs.rs/futures-signals/0.3.34/futures_signals/tutorial/index.html
- https://docs.rs/reaktiv/0.1.1/reaktiv/
- https://github.com/s-panferov/observe

**Template engines (Template engine).**
- https://crates.io/api/v1/crates/gtmpl
- https://github.com/fiji-flo/gtmpl-rust
- https://docs.rs/gtmpl_value/latest/gtmpl_value/enum.Value.html
- https://crates.io/api/v1/crates/gotmpl
- https://docs.rs/gotmpl/latest/gotmpl/
- https://github.com/phsym/gotmpl-rs
- https://crates.io/api/v1/crates/sprig
- https://crates.io/api/v1/crates/lithos-sprig
- https://crates.io/api/v1/crates/minijinja
- https://docs.rs/minijinja/latest/minijinja/value/trait.Object.html
- https://crates.io/api/v1/crates/rquickjs
- https://crates.io/api/v1/crates/boa_engine
- https://crates.io/api/v1/crates/deno_core
- https://pkg.go.dev/text/template
- https://pkg.go.dev/github.com/Masterminds/sprig/v3

**Statusline landscape (What the landscape shows).** The ten projects' GitHub READMEs and the GitHub REST API, 2026-09-10.

**Existing Rust and CI assets (Why Rust).** `rust-client/Cargo.toml`, `scripts/check-protocol.mjs`, `.github/workflows/release.yml`, and `CLAUDE.md` in this checkout.

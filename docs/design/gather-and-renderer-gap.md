# Proposal 1 against the code and the backlog

The ticket list below is superseded by the epic `candybar-gather-renderer-76bb`; the code and backlog mapping stands.

Short version: the backlog already contains most of Proposal 1 under another name. The testing epic (`candybar-testing-ihvy`) is cutting `createDaemon` into ports and pieces so tests can reach them alone, and its Sources and Watchdogs pieces are Gather, its Drawing, Sessions, Feeds, Actions and Requests pieces are the Renderer, and its "recorded case set" ticket is the recording primitive. The URL-handler epic has already replaced the AppleScript applet with a resident Swift forwarder, which is the one piece of the click path the proposal needed changed. What the backlog does not have is the seam itself: a total `SessionFacts` type that crosses between the two groups of pieces, a renderer home as one value, name-addressed links, the versioned Gather socket, and the deletions. Those are about eight new tickets and a handful of edits to existing ones, and no existing ticket needs closing.

The gap is listed per proposal section: what the code does today, what the backlog already carries, and what has to change. Code pointers are files, not lines. Ticket ids are live as of this reading of `lit`.

## §1 Facts are total — the seam

**Code today.** The payload is composed in `src/daemon/render-payload.ts` (`payloadOf`) from providers built once per process in `src/daemon/payload-providers.ts` (git, usage, context, metrics, activity, tmux, host, auto-compact, cache expiry, managed storage) and read per view through `src/daemon/session-source.ts`. The config decides which providers run: `wantsOf`, `buildNeededPrefixes`, `neededInputPaths`, `sourcesRead` and `gitOptionsFromClosure`, all in `render-payload.ts`, with the closure threaded into `src/daemon/cache/render.ts`, `src/daemon/draw-bar.ts` and `src/demo/dsl.ts`. A not-yet-known fact has two shapes: the source-level `Reading`/`Waiting` in `src/utils/reading.ts`, checked by structure, and the payload-level `PENDING` singleton from `src/utils/outcome.ts`, compared by identity in `src/var-system/sources.ts`, `src/var-system/store.ts`, `render-payload.ts` and `draw-bar.ts`. A JSON copy of `PENDING` would fail those checks and draw a default with a `last_error` where a loading cell belongs, silently. There is no document type that holds a session's facts; the payload is a MobX computed in each view's store (`session-source.ts`), read lazily during the draw. `today` and the PR both sit in the first-render wait (`waitsOf` and `refreshPayload`), and the forge has no concurrency cap: `src/proc/launch.ts` names a `"forge"` category with no rate limit, and `src/daemon/cache/git.ts` retries on a fixed period.

**Backlog today.** `candybar-testing-ihvy.cbz` (Sources piece: payload providers, `RefreshLedger`, `WatcherRegistry`, `FileEventDelivery`) and `.uf1` (Watchdogs: `updateWatch`, `binaryWatch`, `limits`) move exactly the state Proposal 1 sends to Gather into pieces with fake ports. Their blockers are the port tickets `.5t2` (launcher), `.y10` (watched store), `.31f` (git), `.xp7` (forge), `.dcv` (tmux), `.89p` (pricing, release, usage). Of the plan's ports only the clock (`Timekeeper`, `src/time.ts`, with a fake and a contract) and the launcher seam (`src/proc/launch.ts`, injected but without fake or contract) exist; `fs` is imported directly in about 23 daemon files and `fs.watch` in `WatcherRegistry`; git is a concrete class built inside `payload-providers.ts`; tmux is `runTmuxAsync` direct. None of the piece tickets defines the output shape the Sources piece hands to Drawing; Drawing (`.ncz`) still "reads the payload providers" directly.

**Change.**
- New ticket, under `candybar-isolated-daemon-bfab`: *A session's facts are one total document.* Define `SessionFacts` with `pending` as a value; `payloadOf` composes from it; the wants closure and its five functions are deleted; `gitOptionsFromClosure` becomes a constant. Done when every built-in is in every payload and the bar is byte-identical for a config that read everything before. Depends on the two unblocking tickets below.
- New ticket: *`today` and the PR fact stop blocking the first bar.* `today` leaves `waitsOf` and lands through its reaction; PR leaves the first-request wait and gains a forge concurrency cap and backoff. This is in the gather draft and nowhere in the backlog.
- Edit `.cbz`: its constructor's output is `SessionFacts` per session, pushed on change, so the Sources piece and Gather are the same thing. Edit `.ncz`: Drawing takes `SessionFacts`, not the providers. That turns a dependency edge the plan already draws into the seam.
- The `.ghb` vocabulary ticket (standard graphics terms) should add "built-in source" for what the code calls a lane in the payload, since `SessionFacts.builtins` is where that word lands.

## §2 Gather does only facts; links address a renderer by name

**Code today.** One minter, `effectsUrl` in `src/click/wire.ts`, emits the signed `dispatch` form; `parseHandlerUrl` in the same file still accepts two more grammars, direct `cc-candybar://<verb>/<tail>` resolving through `VERBS`, and a bare value read as `copy`. Four places build URLs outside the minter: the doctor probe (`src/doctor/handler-probe.ts`), the tmux `CLICK_URL` binding (`src/daemon/tmux-status.ts`), the install test `cc-candybar://hello-world` (`src/install/index.ts`), and config-authored `{{ link }}` with literal `load-config` and `open-vscode` links in `examples/`. The URL handler is a resident Swift app (`url-handler/main.swift`) that writes one `{"kind":"url"}` frame to the uid default socket, hardcoded and pinned by `check-protocol`; it cannot reach an isolated daemon, and the doctor reports the handler "unprobed" whenever `CC_CANDYBAR_SOCKET` differs from the default. The `url-handle` subcommand survives only as the tmux route: the status row's binding runs it, it sends a `click` request to `socketPath(host)`, and the daemon resolves the range id (`sha256` of the URL, 12 hex digits) against the frame it last drew.

**Backlog today.** `candybar-url-handler-uy01`: `.co4` closed (the forwarder), `candybar-daemon-health-ajx0.c3x` in progress (a macOS notification when the forwarder cannot write, with "nothing listening on the socket" as the text), `.05x` open (measure the whole click). The proposal's "a click on a dead renderer shows a notification" is `.c3x`, already being built.

**Change.**
- New ticket: *A link names the renderer that drew it.* Minter writes `cc-candybar://to/<name>/…`; `wire.ts` parses the address; the forwarder parses the name only, computes the socket from it (`<name>.sock` beside today's default socket, which stays the main renderer's) and writes the whole URL through as it does now. Direct verb URLs and bare-value copy links are removed in the same change, so the grammar has one form. The tmux range id becomes `ccb` plus a per-renderer counter, the renderer's name goes on the tmux session as a user option beside the status options `tmux-status.ts` already sets, and the one `MouseDown1Status` binding becomes constant text reading both through tmux formats, as the binding reads `mouse_status_range` today. Depends on `.c3x`.
- Edit `.c3x` (or its follow-up): the notification names the renderer the link addressed once names exist. Small wording change; worth a comment on the ticket now so the text field is not hardcoded to one socket.
- The `scripts/check-protocol.mjs` mirror gains the socket-path-from-name rule, since Swift, Rust and TypeScript all compute it.

## §3 Gather is addressed by protocol version

**Code today.** There is one socket, `defaultSocketPath`, and `CC_CANDYBAR_SOCKET` overrides it. The lease and spawn lock derive from the socket path (`leasePathFor`). The fork-bomb breaker's registry ignores the override on purpose so every daemon on the machine is counted together.

**Backlog today.** Nothing. `candybar-testing-ihvy.97v` (Lifetime piece: lease, boot refusal, parent watchdog, shutdown order) is the piece a Gather lifetime would reuse.

**Change.**
- New ticket: *Gather listens at a versioned socket and a renderer starts it on a miss.* `gather.v<N>.sock` beside the default socket; the facts protocol major in one constant, mirrored into `check-protocol`; the renderer dials, and spawns Gather from its own bundle under the existing lease and lock. Gather ends when its bundle changes, as the daemon does. The fork-bomb breaker counts Gathers in the same registry. Depends on `.97v` and the §1 ticket. This is the one place where the risk the proposal names (a worktree's Gather serving the main bar) is accepted in writing on the ticket.

## §4 Facts flow one way; the hook stays in the renderer

**Code today.** Hook data arrives per request and is spread into the payload (`RenderPayloadOf<P> extends ClaudeHookData`). Hints (tmux, terminal, config dir) arrive as client hints. There is no notion of a locator distinct from the hook.

**Backlog today.** `candybar-testing-ihvy.go6` extends the recorded case set to "requests, replies, errors, versioning and the three-state hint rule". `.5em` puts the client connection behind a port.

**Change.**
- Fold into the §1 ticket: `follow { session, locator }` and `declare { session, sources }` as the two renderer-to-Gather messages, with the locator typed as the hint subset Gather reads. No separate ticket; it is the input side of the same seam.
- The shell/file source identity digest (kind, command or path, cwd, parse, normalised policy, key value) is a small ticket of its own against `src/var-system/sources.ts`. Today dedupe is by scope: a source lives in the directory registry for its `(projectDir, cwd)` render-cache entry unless its key reads a view value, in which case each session runs its own. That rule is the renderer's and cannot be shared across processes; the digest replaces it. The same ticket gives `shellReader` the timeout it lacks, since one slow command would otherwise hold its identity for every renderer sharing it. The `declareEnv` read of the daemon's own `host.env` is the `env` source the proposal removes.

## §5 Events → Apply → Draw

**Code today.** Every verb handler is in `src/daemon/verbs/index.ts` (there are no per-verb files) and acts directly on state and disk. `journaled` opens a history journal and a navigation journal, measures the session's lane switches before the handler and after the commit, and hands the difference to `LaneSetups.clicked`; that measurement is the surface inference the proposal replaces with an event. `set-config` writes through `writeValues` and reloads; undo, redo and rewind write config text through `writeConfigText`; `doctor-run` writes a doctor store to disk outside the journal. Writers outside any handler: the render path itself writes `client-hints` and `render-origin` into session state; `MenuIdle`'s timer; `Runs.ended` and `LaneSetups.sync` holding click errors asynchronously; `updateWatch.act` launching builds; `limits` writing heap snapshots; `tmuxStatusLines` writing tmux options and bindings; `managedStorage`. The only queues are `JournalTurns` (per-session arrival, one daemon-wide turn, one gather lane) and `LaneSetups`' per-session serial queue; everything else lands as its own callback on the event loop, and a click's reply and the feed's next frame go out on different connections with nothing ordering them, as the comment in `daemon.ts` says outright. One more impurity the proposal's "Draw writes nothing" has to take: `FrameMemory` (`src/render/frame-memory.ts`) is written by the draw and is the basis of fades.

**Backlog today.** `candybar-testing-ihvy.2rl` (Actions: verbs, `Runs`, `closeIdleMenus`, `lanesAt`, `laneClicked`; "`verbCtx` splits by verb, each taking only what it uses"), `.th2` (Sessions: `SessionState`, `SettingsHistory`, `NavigationHistory`, `JournalTurns`, `MenuIdle`), `.cd0` (Requests: `handleRequest`, `replyTo`, the order of a render). These cut the same code into pieces but keep verbs as direct writers.

**Change.**
- Edit `.2rl`: the Actions piece is the reducer. Its constructor takes an `Event` and returns state plus effect descriptions; the effect performer is the piece's one adapter. The ticket's "each verb taking only what it uses" becomes "each verb a reducer arm". `journaled` is deleted and `surface-requested` is the event that replaces its inference. This is the largest single edit to an existing ticket and should be made before anyone pulls it.
- Edit `.cd0`: Requests puts a `request` event on the queue rather than calling into Drawing directly; "the order of a render" becomes the queue's order.
- New ticket: *Every source of change is an event.* Timers and watchers (idle close, menu idle, update act, config watcher) produce events; the `Event` union is closed. Depends on `.2rl`. Its done-when is the events draft's: no writer exists outside Apply.
- The deletions (`load-config`, the `env` source, direct verb URLs, the install test URL) each remove a verb or source and belong on the ticket whose piece owns the code, named explicitly so they are not lost: `load-config` and the install URL on the §2 ticket, `env` on the §1 ticket.

## §6 Isolation is one value: the home

**Code today.** `src/daemon/paths.ts` derives state and cache dirs from XDG variables and the socket from `/tmp/cc-candybar-<uid>/socket` or `CC_CANDYBAR_SOCKET`; the config dir comes from discovery in `src/config/loader/discovery.ts`; the lease derives from the socket. Add `XDG_CACHE_HOME` for the usage cache and `CC_CANDYBAR_DAEMON_REGISTRY_DIR` for the fork-bomb registry, and one daemon's identity is spread over five environment variables plus the uid default. A spawned daemon inherits its first spawner's whole environment, so its identity is whatever shell happened to start it. Absolute paths stored today: `render-origin` (`projectDir`, `cwd`, `configFile`), `config-override` (the `loadConfig` verb requires a leading `/`), `client-hints` (`claudeConfigDir`, `tmux.socket`, `client.bundle`), every `kind:"file"` change in `settings-history.json` with its whole-file snapshots, `repo-configs.json` keyed by absolute project directory, the lease's `binPath`, the tmux binding's `{owner: socket}` record and `run-shell` command, the bar-pane command's `CC_CANDYBAR_SOCKET=<abs>`, and drawn `repo-config` links carrying an absolute `dir`. Tests isolate with `prepareIsolatedDaemonEnv`, which sets all of the variables and checks the socket fits `SUN_PATH_MAX`. The Rust client mirrors the layout in `rust-client/src/main.rs` and spawns `current_exe()/../dist/index.mjs`.

**Backlog today.** `candybar-testing-ihvy.y10` (one watched store with narrow ports per family: session, history, config, transcripts) and `.5zt` (Config piece: a load resolves and parses to a value). Plan ticket 9 ("configuration is parsed once at the root and passed down as a value"; environment read only at entry points) is closed into `createDaemon`'s inputs. `.65c` (acquire and install decide in pure code) touches the spawn path.

**Change.**
- New ticket: *A renderer has one home.* `RendererHome = { name, root }` with path functions for socket, state, config, link key and log; two constructors (today's XDG layout for the main renderer, a directory for any other); `paths.ts` and the Rust client compute from it; `prepareIsolatedDaemonEnv` collapses to one value. Depends on `.y10`, because the watched store's families are where the paths are read.
- New ticket: *No stored path is absolute.* Settings history, `render-origin`, `config-override`, doctor stores and repo-config books hold paths relative to the home's root; the undo path cannot name a file outside it. The isolation draft's survey of every `configDir()`, `stateDir()`, `homedir()` and `XDG_*` read is this ticket's first step. The bundle path in the lease and in the tmux and bar-pane commands is the one absolute path left, because it names the running code and not a home file (spec §17). Depends on the home ticket.
- Edit `.65c`: acquire's decision takes the home, not the socket, so a client spawning the bundle beside it spawns it for the right home.

## §7 A session reaches a renderer by starting with its values

**Code today.** A client dials one socket and spawns the bundle beside it on a miss; `CC_CANDYBAR_SOCKET` is the override. That is already the proposal's mechanism. Nothing to add, and the ruling is that nothing is added: a restart of Claude Code is the price of pointing a session at a renderer, and no route table or splice is built to avoid it.

## §8 Recording

**Code today.** No recording or replay of inputs exists. The demo (`src/demo/dsl.ts`) drives the real providers with a faked hook and live data; `cc-candybar check` binds a hand-built `checkPayload` through `fixedSource` and never passes through `payloadOf`, so it is a second payload shape to retire when `SessionFacts` exists. `frame-follow-cases.json` and `diagnostic-text-cases.json` cover the client wire, not facts. `test/frame-bytes.test.ts` is the nearest thing to recorded-input-to-bytes, drawn through `drawPayload` with no daemon, on the real clock. `site/scenario.ts` is a scripted replay into the real `createDaemon` over simulated `fs` and `child_process` shims swapped at bundle time; it proves the idea works and is the wrong mechanism, because its isolation is a build trick rather than a port. The process counter exists (`LaunchStatsHandle` in `src/proc/stats-handle.ts`); a disk counter does not, though `test/unit-setup.ts`'s refusal guard already wraps every Node route into `fs`, `child_process`, `net` and timers and could record instead of refuse.

**Backlog today.** `candybar-testing-ihvy.go6`: "the TypeScript client, the Rust client and the daemon each test against one recorded case set, and none needs another running", extending the two JSON case files to requests, replies, errors and versioning. That is the right ticket, pointed at the wrong layer for this purpose: it records the client wire, not the facts stream.

**Change.**
- New ticket, or a second half of `.go6`: *A facts recording replays into a renderer with zero I/O.* The facts source is a union `gather | recording`; a CLI records a session's facts stream with timestamps; the replay drives Drawing through the same seam Gather would; the disk and process counters from `docs/render-path-subprocess-accounting.md` are armed and must read zero. This is the acceptance test for §1 and should be filed with it, not after.
- Edit `.ncz` (Drawing) so `src/check.ts` and `src/demo/dsl.ts` take a facts source too; the plan already has them assemble Drawing "instead of their own rigs", and a recording is the rig.

## §9 Observability and memory

**Code today.** One logfmt line per request (`requestEvent`, `src/daemon/request-event.ts`): the render arm carries `queued`, `waited`, `drew`, `lanes`, `refreshed` and more; the click arm carries `via`, `verb`, `gather`, `turnWait`, `took` and `outcome`, but not the effects that ran, what they wrote, or the resulting revision. Nothing correlates a request with the facts it waited on or the frame it produced. There is no idle shutdown of the daemon (`MenuIdle` closes menus), which matters because Proposal 1 gives Gather an idle grace. Memory is governed by `src/daemon/limits.ts` and the render cache's budget, both assuming one process.

**Backlog today.** `.cd0` moves `RuntimeStats` into Requests and has "each lower piece take only the counters it writes". `candybar-daemon-health-ajx0.djg` and `.r2i` make a dead or starved daemon visible on the bar.

**Change.**
- Edit `.cd0`: the request event carries the correlation id that the facts push and the applied events reuse, so one wide event per unit of work exists before the process split, not after.

## What the backlog already has that the proposal keeps

- `candybar-isolated-daemon-bfab`: the Frame and the ANSI decoder removal are done (`.abb`, `.agt`, `.2nq`, `.dnr`, `.bzq`, `.pe6`). The three open children (`.dzi`, `.1gq`, `.ghb`) are wire-format and vocabulary work that proceeds unchanged. The epic's description ("run a session's renderer off a worktree as an isolated daemon, with no duplicated data gathering, on a structured wire format") is Proposal 1's sentence, so the new tickets above belong under it.
- `candybar-tmux-events-y457`: the control connection and visibility-from-events are Gather's tmux fact. Nothing changes except that `.8es`'s output is a field of `SessionFacts` once §1 lands; a one-line note on `.8es` now saves a reshuffle later.
- `candybar-url-handler-uy01` and `candybar-daemon-health-ajx0`: proceed as is; §2 depends on `.c3x`.
- `candybar-testing-ihvy`: every port ticket (`.5t2`, `.y10`, `.31f`, `.xp7`, `.dcv`, `.5em`, `.89p`, `.hr8`) is a prerequisite for the split and needs no change. The piece tickets need the edits named above (`.cbz`, `.ncz`, `.2rl`, `.cd0`, `.65c`, `.go6`).

## What to do to the backlog

Eight new tickets, in dependency order, all under `candybar-isolated-daemon-bfab` unless named otherwise:

1. `today` and PR stop blocking the first bar.
2. A session's facts are one total document (`SessionFacts`; wants closure deleted; `env` removed; `follow` and `declare` as the input side).
3. A facts recording replays into a renderer with zero I/O (acceptance for 2; or fold into `.go6`).
4. Shell and file sources have one identity digest.
5. A renderer has one home.
6. No stored path is absolute.
7. A link names the renderer that drew it (direct URLs, bare copy links, `load-config`, the install URL removed; the doctor probe, the tmux `CLICK_URL` and config-authored links go through the minter or a typed address).
8. Gather listens at a versioned socket and a renderer starts it on a miss, and ends after an idle grace, which no process has today (plus the memory-budget ticket beside it).

Six edits to existing tickets: `.cbz` outputs `SessionFacts`; `.ncz` takes `SessionFacts` and a facts source, and moves `FrameMemory`'s write out of the draw into Apply's state so Draw writes nothing; `.2rl` is the reducer and deletes `journaled`; `.cd0` enqueues requests and carries the correlation id; `.65c` takes the home; `.go6` names the facts recording or hands it to ticket 3. One note each on `.c3x` and `.8es`.

No ticket closes. The tmux, URL-handler and daemon-health epics are unaffected in content. The order above interleaves with the testing epic's own order: 1 and 2 can start once `.cbz`'s ports exist; 5 and 6 once `.y10` lands; 7 once `.c3x` closes; 8 after `.97v`.

## Where the code is further from the proposal than the backlog suggests

Three honest warnings for whoever pulls this.

- `src/daemon/verbs/index.ts` is one file of over two thousand lines in which `journaled`, the effect dispatch and every verb's writes are interleaved. Turning it into a reducer is the bulk of the Events work and is not a mechanical move; `.2rl`'s "split `verbCtx` by verb" undersells it.
- The wants closure is threaded through the render cache's view declaration (`declareLanes`, `settledLanes` in `render-payload.ts`), so deleting it touches how a view is held and when it refreshes, not only what the payload contains. The §1 ticket should expect to touch `src/daemon/cache/render.ts` and `src/dsl/` and should be planned with that file's memory (`.claude/memory/daemon-memory.md`) read first.
- The Rust client and the Swift forwarder both carry the socket layout as literals checked by `scripts/check-protocol.mjs`. Homes (§6) and names (§2) change that layout in three languages at once; the check is the thing that makes it safe, and it must grow in the same commit.

## Ownership and vocabulary: the testing epic bends to this

Ruling: `candybar-isolated-daemon-bfab` owns the cut. The testing epic arrived at the same joints from the other side, which says both are right about where the joints are, but the design here is the developed one, so its words and its dependency direction win. Nothing in the testing epic is wasted; each piece becomes a part of Gather or of a renderer and is renamed to say which.

**What each testing piece is, in this design.**

| Testing ticket | Piece | Is, in Proposal 1 | Becomes |
|---|---|---|---|
| `.cbz` | Sources | Gather's built-in sources and declared sources, publishing `SessionFacts` | *Gather publishes a session's facts* |
| `.uf1` | Watchdogs | Splits: `updateWatch` reads the network, so it is a Gather fact; `binaryWatch` and `limits` are one-per-process | *Gather carries the update fact; every process watches its bundle and its memory* |
| `.cnn` | Feeds | Renderer surfaces and their feeds; `PaneVisibility` is a Gather fact | *A renderer's surfaces*, and visibility moves to `.cbz` |
| `.th2` | Sessions | Apply's state | *A renderer's state* |
| `.5zt` | Config | A renderer's config load as a value | *A renderer loads config as a value* |
| `.ncz` | Drawing | Draw, plus the compile and views that stay per renderer | *Draw is pure over facts, state and config* |
| `.2rl` | Actions | Apply | *Apply is the one writer* |
| `.cd0` | Requests | The request event and the client edge | *A request is an event* |
| `.ct7` | Doctor | A renderer's doctor | unchanged in substance, renamed |
| `.97v` | Lifetime | Shared by both process kinds | *A process starts, leases and ends*, used by Gather and renderers alike |
| `.go6` | Recorded case set | The recording primitive, widened from the client wire to facts | *A recording replays into a renderer* |
| `.0zw` | Tests stop waiting | What the recording and the held clock give for free | folds into `.go6` |

**Ports** (`.5t2` launcher, `.y10` watched store, `.31f` git, `.xp7` forge, `.dcv` tmux, `.89p` remote data, `.5em` client connection, `.hr8` log) stay where they are: they are the test infrastructure beneath both process kinds. The six that only Gather reads (launcher, watched store, git, forge, tmux, remote data) are named on the Gather tickets as prerequisites; the clock, log and connection ports are named on both.

**Dependency direction.** Today the piece tickets are children of `candybar-testing-ihvy.izc` and the Drawing-to-Lifetime chain is a lane in the testing epic. Under the ruling: the seam tickets (1 to 8 above) live under `bfab`; the piece tickets re-parent under `bfab`, each as the part named in the table, and the testing epic keeps the ports, the tiers, the ratchet, the five end-to-end tests and the checkpoint. The testing epic's "the daemon is cut into pieces tests can reach alone" then reads as a consequence: the daemon is split into Gather and renderers, and the tests reach each alone because of it. `.ghb` (vocabulary) widens from "lane" to the whole table above and lands first, since every renamed ticket depends on the words existing.

**Vocabulary substitutions,** applied to the testing tickets, `docs/layered-test-plan.md` and `.claude/memory/testing.md` as they are touched: "piece" → the part's name; "cut `createDaemon`" → "split the daemon into Gather and renderers"; "payload providers" → "built-in sources" and their output "`SessionFacts`"; "the daemon" → "a renderer" or "Gather", whichever is meant; "lane" → "surface" or "built-in source"; "recorded case set" → "recording". The test plan's "Cutting the daemon" table is replaced by a pointer to `docs/design/architecture.md` and the table above, so the cut has one description. `docs/design/` is the design's home and the plan cites it, never the reverse.

**What this changes in the eight new tickets.** Nothing in substance. Ticket 2 (`SessionFacts`) is the parent of `.cbz` rather than a sibling; ticket 3 (recording) absorbs `.go6` instead of standing beside it; the six edits to piece tickets become their re-parenting and renaming, done in one grooming pass before anyone pulls them.

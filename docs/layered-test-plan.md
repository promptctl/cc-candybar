# Plan: the layered test suite

The epic is `candybar-testing-ihvy`. Its tickets are filed from this document once it has merged. The strategy is the `laws:testing` skill and the laws cited are in `laws:code`. Every count was measured on `main` at 62b28e2b (1.178.0) on 2026-11-01, unless it names an older run. Counts read from source are grep counts, so they locate the work and do not prove it; ticket 1 replaces them with live ones.

## Goal

Almost everything is proven in process against small pieces of the daemon, each dependency is tested once at its adapter, and five end-to-end tests prove the product is wired.

The daemon is the problem to solve. It can only be reached whole today, so every test of its behaviour has to boot all of it. Cutting it into pieces with fakes at their inputs is the main body of this plan, and most of the test moves follow from that cut. A plan that moved tests between tiers and left `createDaemon` whole would fail its goal, however good the numbers looked.

| Measure | Budget |
|---|---|
| End-to-end tests | 5 |
| Assertions in each end-to-end test | 1, and any more need Brandon's sign-off |
| Unit layer, total | Under 1 minute |
| Pre-merge, unit and contract, wall time | Under 5 minutes |
| Integration layer, wall time | Under 15 minutes |
| End-to-end, wall time | Under 10 minutes |
| Share of tests in the unit layer | Above 80% by count |
| Flaky tests in quarantine | None older than 7 days |

**Checkpoint.** On a machine with the network off and no `dist/`, a person runs unit and contract and watches them finish inside budget. The breaks below are scripted as a job, and the person runs them once as acceptance, one at a time:

1. Change a rule in pure code. One unit test fails and names the input.
2. Change how an adapter parses its dependency's output. The adapter's contract fails on the real side and passes on the fake, which says which side moved.
3. Mis-wire one port in production assembly, such as a wrong path. An end-to-end test fails, and typecheck and everything below it pass. A port left out altogether fails `tsc`, because assembly takes a record type.
4. Call `Date.now()` in `src` outside the clock adapter. Lint fails. Lint guards `src`.
5. Reach the real clock from a unit test. The unit project refuses it and names the call. The refusal guards tests.
6. Add a sixth end-to-end test, then a second assertion to an existing one. CI fails each, and an agent's edit to the sign-off file is refused.
7. Search `test/` for `createDaemon`. It appears only under `test/e2e/`.

They then read a CI run's shape report and see the pyramid hold by count and by time.

## Where the suite stands

CI's latest full run (41336423169) ran 6,486 tests in about 8 minutes: 377 s of jest wall before the build, 44 s after it. 22 of the last 100 Release runs on `main` failed. The newest failure, at 0f7fe274, is `draw-reserve`'s p99, a wall-clock assertion on a shared runner, and it held that release back.

| Layer under this plan, by what each file touches | Files | Cases | Share of cases |
|---|---:|---:|---:|
| Boots the daemon, so end-to-end | 45 | 292 | 6% |
| Real process or socket | 39 | 684 | 15% |
| Real filesystem, git or `fs.watch` | 73 | 1,410 | 30% |
| In process, an upper bound | 175 | 2,281 | 49% |

The 45 files are 31 that use the in-worker harness and 14 in the process tier. Of their 292 cases, about 170 reach a boot; the rest share a file with one. `plugins.test.ts` shows the difference: 101 cases, 3 of which boot. Ticket 2 replaces this estimate with an exact count.

What shapes the plan:

- **`createDaemon` is one knot.** It is 545 lines that build every owner the daemon has, then hand them out in `verbCtx` (24 fields) and `DaemonParts` (27 fields), so a verb can reach anything. Seven values close over something built after them: `frameFeeds` over `parts` and `renderCache`, `menuIdle` over `verbCtx`, `binaryWatch` over `updateWatch`. Those are dependency cycles written as closures. [LAW:one-way-deps]
- **Construction is still hidden.** `createDaemon` calls `createLauncher`, `fileStores`, `productionEdge` and the other edges itself. It reads `socketPath()` and `stateDir()` from the environment, and reads the link key from disk. The comment on `DaemonInputs` defends paths staying out of its inputs because half the daemon reads `paths.ts` at write time. That comment describes the obstacle. Ticket 8 removes it.
- **The harness hides the missing seams.** `test/helpers/in-worker-daemon.ts` made daemon tests cheap, and that was worth doing. They still need the whole daemon, so it is a stepping stone and it gets deleted.
- **Time and load have different causes.** The largest costs are CPU-heavy in-process files: `palette-identity` 97 s, `default-dsl-config` 54 s, `plugins` 52 s, `decor` 46 s. Real daemons mainly cost machine load and flakes.
- **Most rigs pay for the same compile.** `.claude/memory/testing.md` records parse plus compile of the bundled default as what most rigs pay once per test.
- **Tests wait on the real world.** `until` appears at 192 sites, `untilHeard` at 24, `renderUntil` at 14, and `sleep` or `setTimeout` at 167. Time and background work have no port. [LAW:no-ambient-temporal-coupling]
- **Stand-ins are per-file.** `jest.fn` appears in 6 files, so mocking is not the problem. The problem is many hand-made fakes: `buildRuntime` 29 times, sockets in 9 files, PATH stubs in 13, none checked against the real thing. No port contract exists yet, so no fake here has earned trust.

## The layers in this repo

| Layer | What it means here | How it assembles |
|---|---|---|
| Unit | Behaviour in process, on pure code or on one or more pieces, with fakes at their inputs. No daemon | The pieces under test and fake ports |
| Integration | One adapter against one real dependency: git, tmux, the filesystem, `fs.watch`, a unix socket, a child process | That adapter alone |
| Contract | One suite per port, run on the fake and on the real adapter. One wire contract for the clients and the request piece | The suite takes either implementation |
| End-to-end | Any test that boots the daemon, whether in a real process or in a jest worker. Five tests, on the packed artifact | The production root |

## The five end-to-end tests

Each crosses a boundary no lower test exercises, and each makes one assertion:

1. A packed install with the native client draws a bar.
2. A click runs its action.
3. A config edit changes the next bar.
4. After the daemon is killed, the next client tick draws a bar.
5. The tmux status line shows a pushed frame.

Only Brandon raises the cap or allows another assertion. Both live in one sign-off file, and a project hook of its own refuses agent edits to it, the way the release pin's hook guards the pin. The assertion limit is checked at run time: an `afterEach` in the end-to-end project reads `expect.getState().assertionCalls`, so an assertion inside a helper or a loop counts too.

## Cutting the daemon

`createDaemon` ends as wiring with no logic, no test calls it, and the harness is gone. The pieces follow capabilities, and each one takes narrow inputs, so a test builds it alone. Dependencies run one way: a piece uses only the pieces above it in this table. Where a lower piece has to start something higher, it takes a callback the root wires, so no arrow points up. The link signer is an input that the root builds from the key, because both Drawing and Actions use it.

| Piece | What moves into it | Its inputs, faked in tests | Boot tests that move down |
|---|---|---|---|
| Sessions | `SessionState`, `SettingsHistory`, `NavigationHistory`, `JournalTurns`, `MenuIdle` | Session store, clock, a callback for an idle close | `daemon-prompt-count-e2e`, `daemon-session-globals-e2e` |
| Sources | Payload providers, `RefreshLedger`, `WatcherRegistry`, `FileEventDelivery` | Launcher, watched store, git, forge, tmux, remote data | `daemon-plugin-sources-e2e`, `daemon-plugin-fit-e2e`, `daemon-pr-state-e2e`, 3 cases of `plugins` |
| Config | Load, reload and the config state now held in `RenderCache` entries | Watched store | `daemon-broken-config-e2e`, `repo-configs-e2e`, `daemon-config-env-e2e`, `daemon-config-persistence-e2e`, `daemon-settings-menu-e2e`, `daemon-theme-rule-e2e`, `daemon-segment-palette-persistence-e2e` |
| Watchdogs | `updateWatch`, `binaryWatch`, `limits` | Launcher, clock, a file stat, the release port, the exit funnel | `daemon-build-currency-e2e` |
| Drawing | `RenderCache`, `sessionSource`, `draw-bar`, `RenderWarningRecords`, `EffectSessions` | Sessions, sources, config, the update notice from Watchdogs, the link signer, feed facts as a value | `daemon-render-event-e2e`, `daemon-render-warnings-e2e`, `daemon-render-encoding-e2e`, `daemon-effect-e2e`, `daemon-render-instant-e2e`, `daemon-frame-reads-only-e2e`, `bar-web`, `drive-bar` |
| Feeds | `FrameFeeds`, `PaneVisibility`, `TmuxStatusLines`, `LaneSetups` | Drawing's draw function, sessions, tmux, clock | `daemon-frame-feed-e2e`, `daemon-lane-setup-e2e`, `daemon-tmux-restore` |
| Doctor | Doctor edge, stores, `ProbeArrivals`, `RenderSightings` | Launcher, Config's reader | `daemon-doctor-e2e` |
| Actions | Verbs, `Runs`, `closeIdleMenus`, Claude input | Launcher, the link signer, sessions, config, drawing, Feeds' lanes, Doctor, Watchdogs | `click-does`, `daemon-restart-launch` |
| Requests | `handleRequest`, `replyTo`, `handleConnection` | The interfaces of the pieces above | `daemon-connection`, `session-id`, `daemon-request-limits` |
| Lifetime | Socket lease, boot refusal, parent watchdog, shutdown order | Requests, clock, a process table | `daemon-value`, `daemon-socket-lease`, `daemon-boot-refusal`, `daemon-parent-watchdog`, `daemon-shutdown`, `daemon-fork-bomb-ceiling`, `daemon-launch-lifeline-e2e`, `daemon-acquire`, `spawn-isolated-daemon`, `in-worker-daemon` |

The hardest knot is Drawing and Feeds, which call each other today: a feed calls the draw, and the draw reads `frameFeeds` and tells `laneSetups` and `tmuxStatusLines` what it drew. After the cut, the caller passes feed facts into the draw as a value. The draw returns the lanes it drew, which it already computes, and the caller tells Feeds. That is the document's "return commands instead of performing them".

Every piece ticket delivers the same things in one change:

- One constructor whose purpose fits one sentence, taking typed inputs and importing no other piece's class.
- A fake of the piece's own interface where a piece above would otherwise pull in real ports, kept in `src` with a contract suite like any port's.
- Its boot tests moved onto the piece and its fakes. Each behaviour they protected still fails a test when deliberately broken.
- The closures that reached past it replaced by a value or an event that flows one way.
- The ratchet from ticket 2 lowered by what moved, in the same change.

Lifetime's real-process behaviour is tested against a small child program that is not the daemon: lease, watchdog and shutdown decisions are pure, and one adapter test proves signals and sockets behave as the adapter says.

## Dependencies

Each row is tested once, at its adapter.

| Dependency | Today | Ticket | Real side |
|---|---|---|---|
| Time and timers | `Date.now` 88, timers 38, `DaemonClock` in the daemon, `RuntimeStats` keeps its own | 11 | Real clock |
| Child processes | `src/proc/launch.ts`, imported directly | 12 | Real child process |
| Files and file change events | `fs` at 173 sites, `DaemonStorage` for two families, `fs.watch` direct | 14 | Temp directory, real `fs.watch` |
| git | Concrete `GitService`, `fakeGit`, `StubGitService` | 15 | Real repository |
| gh and glab | Same class, `stubPr`, PATH script | 16 | Recordings, refreshed on schedule |
| tmux | `runTmuxAsync` direct, `fakeTmux`, PATH stubs | 17 | Real tmux server |
| Client connection | `memoryConnection` in the harness, `net.Socket` in 9 files | 18 | Real unix socket |
| Remote data | `fetchImpl` on the update watch, pricing has no seam, `fakeUsage` shared | 19 | Recordings, and `pricing.json` is pricing's |

## The tickets

`candybar-testing-0x6u` nests inside this epic while it is open. `candybar-launch-q7o7` stays its own epic and comes first, because ticket 12 builds on its `Launcher`.

### Stage 1: measure, freeze and stop the bleeding

**1. Every CI run stores one record per test file.** A record holds file, layer, count, duration and outcome, and is kept as a run artifact. The shape report, the flake rate and the budget checks are all views over it, so each fact has one home. Every file in a project emits a record, so a file that ran zero tests and a file that never ran read differently. The report also tracks time-to-diagnose, from a red run to the ticket naming its cause. [LAW:nothing-unseen] [LAW:one-source-of-truth]
Done when a CI run shows count and time per layer, covering every file, plus pre-merge wall time.

**2. Every test that boots the daemon is counted, and the count only falls.** The ledger behind `judgeDaemonStarts` gains a harness route and records the test that booted, so it counts tests, which is what the cap is about. `HELPER_START_CEILING` becomes a transitional ratchet over this count, set to today's number, and `judgeDaemonStarts` stops suggesting a raise. A CI step compares the number with `main` and fails any rise. It counts the tests still being moved, a different fact from the cap in ticket 3, and ticket 35 deletes it. This lands first because it stops new boots while the cutting runs. [LAW:single-enforcer]
Done when a new test that boots through the harness fails CI, a raised ratchet fails CI, and every later ticket lowers the number.

**3. The cap and the assertion limit are enforced.** Creates `test/e2e/`, the sign-off file and the run-time assertion check from "The five end-to-end tests". The cap counts the tests in `test/e2e/`. The refusal is a new hook of its own, because `.claude/hooks/release-pin.mjs` says every refusal is about the 1.x pin. Hooks are wired in `.claude/settings.json`, which that pin refuses agents, so Brandon adds that one entry.
Done when break 6 of the checkpoint fails as written.

**4. Each layer is a directory, and each tier is its own jest run.** A file's layer is one fact, read from where it lives. `test/unit`, `test/integration`, `test/contract` and `test/e2e` are the layers. The 45 booting files move to `test/daemon-boots/`, the judge reads that directory in place of the `*.process.test.ts` suffix, and the suffix goes. Everything else stays at the `test/` root, a transitional location that must be empty when the epic ends, so nothing has to pretend to a layer it does not fit.
The unit project refuses disk, sockets, child processes, watchers and the real clock at the call, not at import, because many files reach `src/proc/launch.ts` without calling it. Reading a file the package itself ships is allowed, since it is the same data on every run. A file enters `test/unit` by passing the refusal, so the unit count is always true. Each tier stays a separate jest invocation, as `test:worker` and `test:process` are now, because `maxWorkers` is global to a run: unit runs on all cores and only the booting tier keeps the cap of 4. [LAW:single-enforcer]
Done when a unit file touching disk fails with the call and the test named, and ticket 1's layers come from the directories.

**5. Question: which of the failed Release runs were flakes?** For each of the last 100 runs that failed, record the test, flake or real, and the cause: timing, shared state or a real external. Builds nothing. Feeds tickets 7 and 22.

**6. Question: where does the unit layer's time go?** For the slowest 10% of files, split the time between parse and compile, rendering, and test bodies, and name which tests render everything to assert a decision one pure function makes. Builds nothing. Feeds tickets 10 and 31.

**7. Flakes are quarantined within a day and resolved within a week.** One list holds each quarantined test with its date and ticket, and each line naming its ticket keeps lit the source. A listed test leaves the gate and keeps running and recording. An entry older than 7 days fails CI. There are no automatic retries. `draw-reserve` is not listed: `candybar-launch-q7o7.qjw` owns that failure, and its cause comes first.
Done when a test can be quarantined by one line and an expired line fails CI. `l1mh`, `cbyb`, `6s6a`, `ek6z`, `5lkd`, `na7i` and `8c9u` move here as its first entries, and each is fixed or deleted by the same rule.

### Stage 2: the composition root

**8. `createDaemon` takes every adapter and every path as an input.** `DaemonInputs` gains a paths value and the adapters it builds today: launcher, stores, edges, the logger, the link key, `fetch` and the file stat. Entry points read `paths.ts` once and pass the value down. That settles the conflict with the comment on `DaemonInputs`, which goes. `site/transport.ts` is the other caller and supplies the same inputs. It keeps the real adapters, because its `node:fs` and `node:child_process` are already the simulated machine under `site/`. [LAW:effects-at-boundaries] [LAW:escape-local-minima]
Done when nothing under `src/daemon` constructs its own adapter or reads `paths.ts`, fake ports leave the real state directory untouched, and `pnpm site:build` still passes.

**9. Configuration is parsed once at the root and passed down as a value.** `src` reads the environment only at entry points (45 reads today), and tests stop writing `process.env` (187 writes today). Daemon-side facts about a session keep arriving as hints from the client. Depends on 8.
Done when no test writes `process.env` and a lint rule keeps env reads at entry points.

**10. Test rigs assemble through builders that default every field.** The parse of the bundled default is shared per worker as frozen data. Anything holding a subscription stays per test: `daemon-memory.md` records that a compile holds MobX subscriptions, so sharing it would be a shared mutable fixture that ticket 34's random order turns into failures nobody can localize. Depends on 6 and 8.
Done when `buildRuntime`'s 29 copies and `colour-256`'s 370-line preamble are gone, and rig cost shows as a drop in ticket 1's record.

### Stage 3: ports

Every port ticket delivers the same things in one change:

- A narrow port in this project's vocabulary, not the dependency's.
- One real adapter that translates the dependency's errors and types at the edge.
- One in-memory fake with real semantics and inspection hooks, in its own file beside the port. Only the fake assembly and tests import it, so tsdown leaves it out of the bundle.
- One contract suite, run on the fake in the unit project and on the adapter in the integration project.
- Tests moved down to the fake, and every per-file stand-in for that dependency deleted.
- A new entry in the ESLint rule that today keeps `child_process` inside `src/proc/launch.ts`, so nothing can reach around the port.

Ticket 11 builds the contract pattern and the rest reuse it. Order follows how many tests each port frees, and tickets 1 and 2 may reorder 13 to 19.

**11. The daemon reads time and schedules work through one clock.** `DaemonClock` already carries `after`, so it grows into the port. `RuntimeStats` gives up its own wall clock, and the shared poll helper waits through `after`, so it is not the one real sleep the refusal has to exempt. Depends on 8.
Done when `Date.now` and timers appear only in the clock adapter, and the fake runs due timers when advanced.

**12. Sources spawn through an injected launcher.** Depends on `candybar-launch-q7o7`. The fake launcher serves shell sources and the launcher's own contract only. git, forge and tmux logic use their own fakes, because canned stdout beside a git fake is a second route to faking git.
Done when `pending-draw`'s real `/bin/sh` and the other child-spawning files either use the fake or test the adapter.

**13. Question: which of the 73 filesystem, git and watcher test files are testing logic?** Class each as logic that only needs storage or as adapter behaviour. Builds nothing. Sets the scope of 14.

**14. Stored state and its file events go through one watched store.** Files and their change events are one territory, a directory's contents, so a separate fake store and fake watch could disagree in ways neither contract catches. A write to the store emits the events a watch would. One real adapter sits over `fs` and `fs.watch` and carries watch readiness as state, which removes most of the re-applied-write advice in `testing.md`. Narrow ports sit over it, one per family: session, history, config, transcripts. Split per family as ticket 13 finds. [LAW:one-source-of-truth]
Done when those tests run in the unit project, and the 23 files that reach a watcher split into logic on the fake and one adapter test.

**15. git goes through a port.** A port shaped like `git(args)` would fail this ticket.
Done when `StubGitService` is gone and `GitService` is the adapter.

**16. The forge goes through its own port.** `git.ts` already calls this the forge CLI, and it handles gh and glab, so both are adapters of one port. The contract runs on recordings, refreshed on schedule.
Done when `stubPr` and the PATH script are gone and neither CLI is reached outside the port.

**17. tmux goes through a port.** Real side is a real tmux server started once per worker.
Done when the PATH stubs are gone.

**18. The client connection goes through a port.** The fake is the in-process stream `memoryConnection` already provides and the real side a unix socket. This proves the TypeScript client; the Rust side is ticket 32 and the first end-to-end test.
Done when the 9 hand-rolled socket files are gone.

**19. Pricing, the latest release and usage are three domain ports with recorded contracts.** The HTTP client stays inside their adapters, so no port takes `fetchImpl: typeof fetch`. Pricing's recording is the `pricing.json` that `pricing.yml` already refreshes, and no second one is made. No test reaches a production API.
Done when the refusal from ticket 4 stays quiet with the network off.

**20. Tests stop waiting on the real world.** Each fake settles synchronously or exposes that it has settled, which is the concurrency half of Principle 5 that a clock alone does not cover. Depends on 11, 12, 14 and 18.
Done when literal sleeps are gone and `until`, `renderUntil`, `untilHeard` and log waits appear only in integration and end-to-end.

### Stage 4: the pieces

Tickets 21 to 30 are the ten pieces, each with the deliverables above, in the order that lowers the boot count fastest and needs the fewest ports first. A piece takes its neighbours' interfaces as inputs, so the cut can start at the top of the graph.

**21. Feeds.** The most booting cases of any piece: `daemon-frame-feed-e2e` alone has 27. Undoes the cycle with Drawing described above. Depends on 11 and 17.

**22. Drawing.** `src/check.ts` and `src/demo/dsl.ts` assemble this piece instead of their own rigs, which keeps one render path. `daemon-render-event-e2e` caused 8 of the 23 failed runs counted at 8da9964e, which ticket 5 recounts: name the logic it protects, unit-test it, and delete the file. Depends on 8.

**23. Config.** Reload stops being a method of the render cache. Depends on 14.

**24. Sources.** Depends on 12, 14, 15, 16, 17 and 19.

**25. Actions.** `verbCtx` splits by verb, each taking only what it uses. Depends on 12, 22, 23, 26 and 27.

**26. Doctor.** Depends on 12.

**27. Watchdogs.** Depends on 11, 12 and 19.

**28. Sessions.** Depends on 11 and 14.

**29. Requests.** `DaemonParts` goes. The wire contract in ticket 32 runs here, with no daemon booted. Depends on 21 to 28.

**30. Lifetime.** `daemon-fork-bomb-ceiling`'s wiring proof moves to the boot gate in a small child program. Depends on 29.

### Stage 5: decisions move down

**31. Each decision is proven once, exhaustively, at its pure function, and render sweeps shrink to representatives.** Absorbs `j0bh`. The cases come from ticket 6. A cheaper sweep may not prove less: for each sweep reduced, breaking the decision must still fail a test, and the exhaustive test on the pure function is the record of that. [LAW:behavior-not-structure]
Done when the unit layer's time in ticket 1 is inside budget.

**32. The TypeScript client, the Rust client and the daemon each test against one recorded case set, and none needs another running.** Extends `frame-follow-cases.json` and `diagnostic-text-cases.json` to requests, replies, errors, versioning and the three-state hint rule (absent, null, value). Acquire's decisions join it, because the shipped client is Rust and has its own daemon-miss path. `check:protocol` stays beside it, because mirrored constants such as timeouts never appear in an interaction.
Done when a change to one side's reading of the wire fails that side's own suite.

**33. Acquire and install each decide in pure code and act in a thin shell.** `src/daemon/acquire.ts` and `src/install/index.ts` take what they observed and return what to do. `spawn?: () => boolean`, labelled a test hook, goes with the port, and a sweep finds any other test-only path. The state directory is shared by the daemon, the client's acquire path, the update job and the lifeline, so each of its files gets one typed owner that the others read through. [LAW:effects-at-boundaries] [LAW:no-mode-explosion]
Done when the decisions have unit tests with no process, and the shell has no branch worth testing.

### Stage 6: tiers and guardrails

**34. Tests run in random order.** An order-dependent failure is a bug in the test.
Done when random order is the default in CI and the suite passes on repeated seeds.

**35. The five end-to-end tests run on the packed artifact.** Each runs from `pnpm pack` installed into a temp prefix, with the native binary from `release.yml`'s `build-rust` job. `test/helpers/in-worker-daemon.ts`, `test/daemon-boots/` and every file left in it are gone. The ratchet reaches zero and is deleted, which leaves the sign-off cap as the only number. Depends on 21 to 30 and 36.
Done when ticket 2's count reads 5, all of them in `test/e2e/`, and break 7 holds.

**36. Measurements stop booting the daemon where they can.** `draw-reserve` measures the drawing piece in a small process of its own, and moves to the scheduled tier. Takes `tl8u`, and depends on `candybar-launch-q7o7.qjw` and 22. The Load gate and the Feed criterion are measured on the built daemon by their nature, and they are covered under Decisions.
Done when no jest test outside `test/e2e/` boots the daemon.

**37. CI runs four tiers.** Fast loop: unit and contract. Integration: adapters. End-to-end: the five, in the release job before `semantic-release`. Scheduled: performance, soak and recording refreshes, non-blocking.
Done when each tier is its own job, a merge needs the first two, and a publish needs the third.

**38. Budgets are checks, and a lasting breach becomes design work.** Each budget reads ticket 1's record and fails when breached. A breach lasting more than one release opens an architecture ticket, whose fix is a seam, a port or a boundary.
Done when a deliberately slow unit test fails the check.

**39. A change maps to the tests it touches.** Safe only with the dependency rule in place, so it depends on 11 to 19.
Done when pre-merge selection misses nothing that a full scheduled run catches.

**40. `.claude/memory/testing.md` points at the standard and holds only this repo's facts.** One pointer to `laws:testing`, then which directory is which layer, which fakes exist, and the traps left. The ports should let the file shrink.
Done when the file is shorter and the hand-faking advice is gone.

**41. The epic's checkpoint is run.** The scripted breaks pass, the `test/` root holds no test file, and a person performs the checkpoint end to end and records the result on the epic.

## Moved in from Unfiled

- `j0bh` into ticket 31.
- `l1mh`, `cbyb`, `6s6a`, `ek6z`, `5lkd`, `na7i` and `8c9u` into ticket 7.
- `tl8u` into ticket 36.

## Order

The epic ranks directly below `candybar-launch-q7o7`. Tickets 1, 2, 3, 4 and 7 are ready at once, and 5 and 6 once the records exist. Stage 2 comes before any port, because a port with no root to plug into frees no test. Stage 3 and Stage 4 interleave by the dependencies named on each piece, and Stage 5 can run beside them. Stage 6 comes last.

## Decisions

- **Five end-to-end tests, one assertion each.** This is stricter than the document's 10 to 30. An end-to-end test exists to prove wiring, so five product paths cover it, and a single assertion keeps a red test saying one thing.
- **Booting the daemon makes a test end-to-end, in process or not.** The document lets a unit test drive a whole use case in process. Here that is what hid the missing seams: a test that needs all of the daemon to reach one behaviour shows the seam is missing, wherever it runs.
- **The cut goes further than the process boundary.** The document puts seams only at the process boundary and warns against interface noise. Pieces here are capabilities, as its Principle 6 asks, and a piece's fake exists only where the piece above would otherwise pull real ports.
- **Agents do not hold the cap.** Only Brandon can change it or the assertion limit, so a deadline cannot erode it. While tests are moving, agents can only lower the ratchet.
- **End-to-end runs in the release job, before publishing.** A merge publishes automatically and there is no staging, so a test after that cannot stop a bad release. This is also what ships: the tarball and the native binary.
- **The Load gate and the Feed criterion stay required, and they need Brandon's sign-off.** A loop-blocking regression ships to every statusline on the next tick, and no lower test catches it; the launch epic exists because of one. They boot the built daemon, so by the rule above they are end-to-end and sit outside the five. They stay as they are until Brandon rules on an entry in the sign-off file. Nothing before ticket 37 depends on the answer.
- **The refusal lands early, on a transitional location.** The document adds the dependency rule after the pattern exists. Here it applies only inside `test/unit`, and the `test/` root holds what has no seam yet, so the rule never has to lie about a file. The epic does not close until that root is empty.
- **The layer lives in the directory.** It replaces the `*.process.test.ts` suffix in one change, so there is one spelling of the fact and one judge.
- **The port rule grows with each port.** Adding it per port leaves no window in which new code can reach around a finished port.
- **Sweeps sit outside the document's migration order.** The document does not cover CPU-heavy in-process files, and they are the largest time cost here.
- **Time and child processes come before files.** The document usually starts with the database. Here the criterion is tests freed.
- **gh, glab and remote data use recordings.** The suite stays hermetic and never calls a production API.
- **Randomness and identity need no port.** `src` has no `Math.random`. `randomBytes` is only in `src/daemon/link-key.ts`, whose key ticket 8 makes an input. Session identity already arrives as hints.

## Coverage of the document

| Document | Tickets |
|---|---|
| Principle 1, decision apart from effect | 21 to 30, 33 |
| Principle 2, ports | 11 to 19 |
| Principle 3, fakes | 11 to 19, 21 to 30 |
| Principle 4, composition root | 8, 10 |
| Principle 5, time, concurrency, config, filesystem | 9, 11, 14, 20 |
| Principle 5, randomness and identity | 8, and Decisions |
| Principle 6, module boundaries | 21 to 30, 32, 33 |
| Variants belong lower | 31 |
| Integration layer | 11 to 19, 37 |
| Port contracts | 11 to 19 |
| Service contracts | 32 |
| End-to-end | 2, 3, 35 |
| Isolation and ordering | 4, 34 |
| Test data | 10 |
| Tiers | 37 |
| Flakiness policy | 7 |
| Selective execution | 39 |
| Measuring shape | 1, 4 |
| Budgets and escalation | 38 |
| Review questions | 3, 40 |

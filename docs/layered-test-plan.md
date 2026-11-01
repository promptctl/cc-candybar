# Plan: the layered test suite

The strategy is `/Users/bmf/code/promptctl_laws/plugins/laws/skills/testing/SKILL.md`. The laws cited are in `/Users/bmf/code/promptctl_laws/plugins/laws/skills/code/SKILL.md`. Nothing here has been filed in lit. This document is the proposal for one epic and its tickets.

## Goal

A fast suite where almost everything is proven in process, each dependency is tested once, and only a few end-to-end tests remain.

| Measure | Budget |
|---|---|
| Unit layer, total | Under 1 minute |
| Pre-merge, unit and contract, wall time | Under 5 minutes |
| Integration layer, wall time | Under 15 minutes |
| Smoke cases | At most 30 |
| Smoke, wall time | Under 10 minutes |
| Share of tests in the unit layer | Above 80% by count |
| Flaky tests in quarantine | None older than 7 days |

**Checkpoint.** On a machine with the network off and no `dist/`, a person runs unit and contract and watches them finish inside budget. They then make four breaks, one at a time:

1. Change a rule in pure code. One unit test fails and names the input.
2. Change how an adapter parses its dependency's output. The adapter's contract fails on the real side and passes on the fake, which says which side moved.
3. Leave one port out of production assembly. Smoke fails and nothing below it does.
4. Call `Date.now()` in code outside the clock adapter. The lint rule fails, and a unit test reaching the real clock is refused with the call named.

They then read a CI run's shape report and see the pyramid hold by count and by time.

## Where the suite stands

Measured on CI run 41174223431 at 8da9964e: 304 files, 6,100 tests, 418 s jest wall, about 8 minutes for the Test job. 23 of the last 100 Release runs failed. Cases below are counted from source, so they total less than the 6,100 that run.

| Layer, by what each file touches | Files | Cases | Share of cases | Worker-seconds* |
|---|---:|---:|---:|---:|
| In-process, an upper bound | 160 | 1,962 | 46% | 555 |
| Real filesystem | 65 | 1,163 | 27% | 216 |
| Real git or `fs.watch` | 20 | 428 | 10% | 77 |
| Real process or socket | 59 | 731 | 17% | 468 |

*Only files over 5 s, the only ones CI logs: 77 files, 1,316 worker-seconds.

These numbers predate most of `candybar-testing-0x6u`, which `lit backlog` now shows at 8 of 9 tickets done. Ticket 1 replaces this table with a live one.

What shapes the plan:

- **Time and load have different causes.** The largest costs are CPU-heavy in-process files: `palette-identity` 138 s, `plugins` 56 s, `default-dsl-config` 55 s, `decor` 47 s. Real daemons mainly cost machine load and flakes. Both need design work, and neither is fixed by the runner.
- **Most rigs pay for the same compile.** `.claude/memory/testing.md` records that parse plus compile of the bundled default is what most rigs pay once per test. That is a composition problem: the unit layer is rebuilding a value it could share.
- **The missing seams are in the daemon.** 58 files across render, template-engine, dsl, themes, click, claude-input, band and tmux-status have no hidden dependencies. The worst files are `daemon/acquire.ts`, `proc/launch.ts`, `daemon/server.ts` and `install/index.ts`.
- **Tests wait on the real world.** 85 literal sleeps, plus `until` at 149 sites, log waits at 37, `untilHeard` at 18 and `renderUntil` at 12. Each is a test betting on timing because time and background work have no port. [LAW:no-ambient-temporal-coupling]
- **Stand-ins are per-file, not mocks.** `jest.fn` appears in 3 files, so mocking is not the problem. The problem is many hand-made fakes: `buildRuntime` 24 times, sockets hand-rolled in 9 files, PATH stubs for gh and tmux, none checked against the real thing.
- **No port contract exists,** so no fake here has earned trust yet.

## The layers in this repo

| Layer | What it means here | How it assembles |
|---|---|---|
| Unit | Any behaviour in process, including a whole daemon driven through an in-process stream | The root with fake ports |
| Integration | One adapter against one real dependency: git, tmux, the filesystem, `fs.watch`, a unix socket, a child process. Daemon lifetime tests belong here, because the process is the dependency | That adapter alone |
| Contract | One suite per port, run on the fake and on the real adapter. One wire contract for the clients and the daemon | The suite takes either implementation |
| Smoke | The built bundle, a real client and a real daemon, happy paths only | The production root |

## Dependencies

Each row is tested once, at its adapter.

| Dependency | Today | Ticket | Real side |
|---|---|---|---|
| Time and timers | `Date.now` 87, timers 34, no daemon-wide clock | 13 | Real clock |
| Files | 219 direct uses, tests use real files | 14, 15 | Temp directory |
| File change events | `fs.watch` direct | 16 | Real `fs.watch` |
| Child processes | `src/proc/launch.ts`, imported directly | 17 | Real child process |
| git | Concrete `GitService`, `fakeGit`, `StubGitService` | 18 | Real repository |
| gh | Same class, `stubPr`, PATH script | 19 | Recordings, refreshed on schedule |
| tmux | `runTmux` direct, `fakeTmux`, PATH stubs | 20 | Real tmux server |
| Client connection | `net.Socket`, 9 hand-rolled files | 21 | Real unix socket |
| Remote data | Registry has `fetchImpl`, pricing has no seam, `fakeUsage` shared | 22 | Recordings, refreshed on schedule |

## The epic

**Title:** A fast suite where almost everything is proven in process, each dependency is tested once, and only a few end-to-end tests remain.

`candybar-testing-0x6u` nests inside it while it is open, and tickets 6 onward build on what it lands.

### Stage 1: measure, and stop the bleeding

**1. Every CI run stores one record per test file.** A record holds file, layer, count, duration and outcome, and is kept as a run artifact. The shape report, the flake rate and the budget checks are all views over it, so each fact has one home. [LAW:nothing-unseen] [LAW:one-source-of-truth]
Done when a CI run shows count and time per layer, covering every file, plus pre-merge wall time. Second consumers: tickets 5 and 26.

**2. Each layer is a jest project, and the unit project refuses the outside world.** A file's layer is one fact, read from where the file lives, and the project it lands in is what enforces it. A separate declaration would be a second clock that drifts from what the file touches. The refusal covers disk, sockets, child processes, watchers and the real clock, and it fires at the call rather than at import, because 220 files reach `src/proc/launch.ts` without all of them calling it. A file enters the unit layer by passing the refusal, so running this is also what produces the true unit count. It also answers whether any test reaches pricing's HTTPS. [LAW:single-enforcer]
Done when a unit file touching disk fails with the call and the test named, and ticket 1's layers come from the projects.

**3. Question: which of the 23 failed Release runs were flakes?** For each failed run, record the test, flake or real, and the cause: timing, shared state or a real external. Builds nothing. Feeds tickets 5 and 10.

**4. Question: where does the unit layer's time go?** For the slowest 10% of files, split the time between parse and compile, rendering, and test bodies, and name which tests render everything to assert a decision one pure function makes. Builds nothing. Feeds tickets 7 and 9.

**5. Flakes are quarantined within a day and resolved within a week.** One list holds each quarantined test with its date and ticket. A listed test leaves the gate and keeps running and recording. An entry older than 7 days fails CI. There are no automatic retries. This ranks early because noise from flakes taxes every later ticket.
Done when a test can be quarantined by one line and an expired line fails CI. `tl8u`, `l1mh`, `cbyb`, `a5k3`, `2ywj`, `6s6a`, `ek6z`, `5lkd` and `na7i` move under this ticket as its first entries, and each is fixed or deleted by the same rule.

### Stage 2: composition root

**6. The daemon is assembled by one function that takes its ports as a value.** Three functions: assembly from ports, production ports from config, fake ports with the handles tests need. `src/daemon/server.ts`'s module-level instances move into assembly, and `src/demo/dsl.ts` composes through it. At the start the fake set may wrap what exists, which is enough to unlock every port ticket. [LAW:no-shared-mutable-globals] [LAW:effects-at-boundaries]
Done when nothing under `src/daemon` constructs its own adapter, and a test gets a working daemon in memory from the fake ports. Consumers: tickets 7, 13 to 22, and 24.

**7. Test rigs assemble through the root, with builders that default every field.** The compiled bundled default is built once per worker and shared as an immutable value, which is the document's "start it once, never per test" applied to a compile. Depends on 4 and 6.
Done when `buildRuntime`'s 24 copies are gone, `colour-256`'s 364-line preamble is gone, and rig cost shows as a drop in ticket 1's record.

**8. Configuration is parsed once at the root and passed down as a value.** `src` reads the environment only at entry points, and tests stop writing `process.env`, which happens 181 times today. Daemon-side facts about a session keep arriving as hints from the client.
Done when no test writes `process.env` and the lint rule keeps env reads at entry points.

### Stage 3: the sweeps

**9. Each decision is proven once, exhaustively, at its pure function, and render sweeps shrink to representatives.** Absorbs `j0bh`. The cases come from ticket 4. A cheaper sweep may not prove less: for each sweep reduced, a deliberately broken decision must still fail a test. [LAW:behavior-not-structure]
Done when the unit layer's time in ticket 1 is inside budget, with the broken-decision check recorded per sweep.

### Stage 4: logic moves down

**10. `daemon-render-event-e2e` is reduced to the wiring it protects.** It caused 8 of the 23 failed runs, so it is the first painful test. Name the logic it protects, extract it to pure code, cover it with unit tests, then delete the test or reduce it to a wiring check. Use characterization tests only while extracting, and delete them after.
Done when its logic has unit tests and the file is gone or a single wiring case.

**11. Acquiring the daemon decides in pure code and acts in a thin shell.** `src/daemon/acquire.ts` has 31 hidden-dependency sites, the most in the repo. The core takes what it observed and returns what to do. [LAW:effects-at-boundaries]
Done when the decisions have unit tests with no process, and the shell has no branch worth testing.

**12. Install decides in pure code and acts in a thin shell.** Same shape for `src/install/index.ts`, with 20 sites.
Done on the same test.

### Stage 5: ports

Every port ticket delivers the same things in one change:

- A narrow port in this project's vocabulary, not the dependency's.
- One real adapter that translates the dependency's errors and types at the edge.
- One in-memory fake with real semantics and inspection hooks, kept beside the port in `src`.
- One contract suite, run on the fake in the unit project and on the adapter in the integration project.
- Tests moved down to the fake, and every per-file stand-in for that dependency deleted.
- A new entry in the ESLint rule that today keeps `child_process` inside `src/proc/launch.ts`, so nothing can reach around the port.

Writing the fake and the contract together is what makes the fake trustworthy. Adding the rule entry in the same change means no port is ever left open. Ports sit at the process boundary only. Ticket 13 builds the contract pattern and the rest reuse it.

Order follows how many tests each port frees, and tickets 1 and 2 may reorder 16 to 22.

**13. The daemon reads time and schedules work through one clock.** The fake sets and advances time and runs due timers. Done when the 85 literal sleeps are gone and `until`, `renderUntil`, `untilHeard` and log waits appear only in integration and smoke. Depends on 6.

**14. Question: which of the 65 filesystem test files are testing logic?** Class each as logic that only needs storage or as adapter behaviour. Builds nothing. Sets the scope of 15.

**15. Stored state goes through a storage port.** Scope from 14. Covers session state, config and transcripts as the question finds them. Done when those tests run in the unit project.

**16. File change events go through a port.** Logic above it gets a fake that fires events, and real `fs.watch` behaviour is tested once at the adapter. Done when the 10 watcher files split that way.

**17. Sources spawn through an injected launcher.** `SourceRegistry` imports launch directly today. Done when `pending-draw`'s real `/bin/sh` and the 19 other child-spawning files either use the fake or test the adapter.

**18. git goes through a port.** Done when `StubGitService` is gone and `GitService` is the adapter. A port shaped like `git(args)` would fail this ticket.

**19. gh goes through its own port.** It is a different dependency from git, so it is cut from `GitService`. The contract runs on recordings, refreshed on schedule. Done when `stubPr` and the PATH script are gone.

**20. tmux goes through a port.** Real side is a real tmux server started once per worker. Done when the PATH stubs are gone.

**21. The client connection goes through a port.** The fake is an in-process stream and the real side a unix socket. Builds on the connection work in `candybar-testing-0x6u`. Done when the 9 hand-rolled socket files are gone.

**22. Pricing, the registry and usage each sit behind a port with recorded contracts.** Pricing gains the seam the registry already has. No test reaches a production API. Done when the refusal from ticket 2 stays quiet with the network off.

### Stage 6: the wire

**23. The TypeScript client, the Rust client and the daemon each test against one recorded case set, and none needs another running.** Extends `frame-follow-cases.json` and `diagnostic-sanitize-cases.json` to requests, replies, errors and versioning. Absorbs `1izo`. The existing protocol check keeps guarding mirrored constants.
Done when a change to one side's reading of the wire fails that side's own suite.

### Stage 7: tiers and guardrails

**24. A capped smoke tier on the built bundle.** At most 30 cases, happy paths only, each crossing a boundary no lower test exercises: a fresh install renders a bar, the client starts a daemon, a click runs an action, a config edit reloads, the native client talks to the daemon. Every other real-daemon test moves down or becomes integration.
Done when a case over the cap fails CI and the count is frozen. A new case replaces an old one or states which lower test could not be written.

**25. CI runs four tiers.** Fast loop: unit and contract. Integration: adapters. Smoke: the built bundle. Scheduled: performance, soak and recording refreshes, non-blocking. Wall-clock tests like `draw-reserve` move to scheduled.
Done when each tier is its own job and a merge needs the first three.

**26. Budgets are checks, and a lasting breach becomes design work.** Each budget reads ticket 1's record and fails when breached. A breach lasting more than one release opens an architecture ticket, whose fix is a seam, a port or a boundary.
Done when a deliberately slow unit test fails the check.

**27. Tests run in random order.** An order-dependent failure is a bug in the test.
Done when random order is the default in CI and the suite passes on repeated seeds.

**28. A change maps to the tests it touches.** Safe only with the dependency rule in place, so it depends on 13 to 22.
Done when pre-merge selection misses nothing that a full scheduled run catches.

**29. `.claude/memory/testing.md` says where a test belongs.** It carries the document's four placement questions and its review questions, for anyone adding a test.
Done when the file is updated and the old advice to fake time and the filesystem by hand is replaced by the ports.

**30. The epic's checkpoint is run.** A person performs it end to end and records the result on the epic.

## Moved in from Unfiled

- `j0bh` into ticket 9.
- `tl8u`, `l1mh`, `cbyb`, `a5k3`, `2ywj`, `6s6a`, `ek6z`, `5lkd` and `na7i` into ticket 5.
- `1izo` into ticket 23.

## Order

Stage 1 ranks at the top of the backlog. Tickets 1, 2 and 5 are ready at once. Tickets 3 and 4 are ready once the records exist. Stage 2 follows the document in coming before any port, because a port with no root to plug into frees no test. Stages 3 to 6 can run side by side once ticket 6 lands. Stage 7 comes last, except that ticket 24's cap can freeze the count as soon as the tier exists.

## Decisions

- **Smoke runs before publishing.** The document runs smoke post-deploy, but here a merge publishes automatically, so a smoke test after that can't stop a bad release. Smoke therefore runs on the built bundle as the last gate.
- **The Load gate stays required.** It is a deliberate project check, so it does not move to the scheduled tier.
- **The layer lives in the file's location, not a label.** See ticket 2.
- **The rule grows with each port.** The document adds it after the pattern exists. Adding it per port gets the same result without a window in which new code can reach around a finished port.
- **Fakes live in `src` beside their ports,** as the document says, so port, adapter, fake and contract change together.
- **gh and recorded services use recordings.** The suite stays hermetic and never calls a production API.

## Coverage of the document

| Document | Tickets |
|---|---|
| Principle 1, decision apart from effect | 9, 10, 11, 12 |
| Principle 2, ports | 13 to 22 |
| Principle 3, fakes | 13 to 22 |
| Principle 4, composition root | 6, 7 |
| Principle 5, time, concurrency, config, filesystem | 8, 13, 15 |
| Principle 6, module boundaries | 6, 10, 11, 12 |
| Integration layer | 13 to 22, 25 |
| Port contracts | 13 to 22 |
| Service contracts | 23 |
| Smoke | 24 |
| Isolation and ordering | 2, 27 |
| Test data | 7 |
| Tiers | 25 |
| Flakiness policy | 5 |
| Selective execution | 28 |
| Measuring shape | 1, 2 |
| Budgets and escalation | 26 |
| Review questions | 24, 29 |

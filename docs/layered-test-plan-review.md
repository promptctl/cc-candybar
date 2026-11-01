I have what I need. The findings below are grounded in the plan, the two standards, and the repo as it stands on `origin/main` (which is 35 commits ahead of the plan's branch, and that matters).

# Review: `docs/layered-test-plan.md`

**Scope.** The plan against `laws:testing` (Q1) and against `laws:code` (Q2). Nothing else.

**One fact that colours everything.** The plan's branch sits at 1.170.1; `origin/main` is at 1.174.7 and has landed most of `candybar-testing-0x6u`: `src/daemon/daemon.ts` (the daemon as a value, with `DaemonInputs { bundle, storage, memoryLimitBytes, registryUrl, clock: DaemonClock, exit }`), the in-worker harness (`test/helpers/in-worker-daemon.ts`, `memory-connection.ts`), and a named process tier (`*.process.test.ts`, enforced by a daemon-start ledger in `test/helpers/process-tier.cjs` with `HELPER_START_CEILING = 30`). The plan says its numbers predate this work, but several tickets' premises and done-criteria were written against the older tree. Where that changes a verdict I say so.

---

## Q1. Does the plan carry what `laws:testing` says?

### Thesis and cost model

Carried. The Goal restates the thesis, the budget table matches the document's budgets row for row, and "What shapes the plan" locates the fix in the code rather than the runner. The plan adds one true observation the document doesn't make, that CPU-heavy in-process files dominate wall time, and answers it with Stage 3. That is a legitimate addition, but it is a step outside the document's migration order and belongs under Decisions, where it is not recorded.

Missing from the metrics the document asks for: time-to-diagnose. Soft; one line in ticket 1 would carry it.

### The four layers

**Unit.** Carried, including the document's point that a unit test may drive a whole use case in process.

**Integration.** Mis-applied in one place. The Layers table says "Daemon lifetime tests belong here, because the process is the dependency." The document's integration layer is one adapter against one real dependency, with "the rest of the application" in the may-not-touch column, and it says outright that starting more than one piece of infrastructure means it is not an integration test. A daemon lifetime test boots the whole application as a process, with its sockets, files, children and watchers. By the document's definitions it is end-to-end. The plan relabels the repo's existing process tier as integration without recording the departure, and the relabel has a cost: ticket 24 says "every other real-daemon test moves down or becomes integration", which opens a door the document closes. Any real-daemon test that doesn't fit the 30-case smoke cap can be filed as "integration: daemon lifetime" and escapes the growth rule ("which lower test would have caught this?"). Resolution: name the process tier as what it is (the repo already does), state under Decisions that its cases count against the end-to-end cap or carry their own fixed cap, and apply the replacement rule to it.

**Contract and smoke.** Carried in shape. See the per-ticket notes on 23 and 24 for two gaps.

### Principle 1, decision apart from effect

Carried for `acquire.ts`, `install/index.ts` and the render-event e2e (10, 11, 12). The Coverage table also lists ticket 9 here, and 9 is not a Principle 1 ticket: shrinking sweeps to representatives is the document's "variants belong lower" placement rule, not a decision/effect split. Misfiled.

Partially covered as a whole. The daemon's request path (`reply.ts`, `verbs/`, click handlers that launch processes and write config) is where the most decisions and effects mix, and no ticket names it. Two files and one test is a start, not the principle. Either narrow the Coverage claim to "applied where the hidden-dependency count is highest" or add the ticket.

### Principle 2, ports

Carried well: application vocabulary, narrow, two implementations, rule enforced, translate at the edge, seam at the process boundary only. Ticket 18's "a port shaped like `git(args)` would fail this ticket" is exactly the document's leaky-port guard.

One structural gap. Tickets 18, 19 and 20 (git, gh, tmux) are adapters that themselves run through ticket 17's launcher. So there are two tiers of port, and the plan should say which fake serves which test: a unit test of git logic uses the git fake and never a fake launcher returning canned `git` stdout. Otherwise there are two routes to fake git, and the canned-stdout route is the "leaky port" anti-pattern wearing the launcher's clothes. See Q2, ticket 17.

### Principle 3, fakes

Carried: real semantics, inspection hooks, beside the port in `src`, contract suite written with the fake. Recordings for gh and remote data as the "real side" is permitted by the document ("recorded interactions, refresh on a schedule"). Ticket 22 should not create a second recording for pricing: `.github/workflows/pricing.yml` already fetches and commits `pricing.json` on a schedule. That file is the recording.

### Principle 4, composition root

Carried in target; stale in premise. Ticket 6 says "`src/daemon/server.ts`'s module-level instances move into assembly". On main that has happened: `server.ts` holds four `let`s and `serving: Daemon | null`, and `daemon.ts` is the value. What remains, and what the ticket should say, is that `createDaemon` still constructs its own adapters inside: `createLauncher(...)`, `runTmux`/`runTmuxAsync` imported directly, `createPayloadProviders`, `fileStores`, `productionEdge`, `productionClaudeInputEdge`, `productionLaneEdge`. The done-criterion ("nothing under `src/daemon` constructs its own adapter") is still right. The description is not.

A direct conflict the plan does not see. `DaemonInputs` on main says, in a comment, that paths are deliberately not inputs because half the daemon reads `src/daemon/paths.ts` at write time, so "the environment is the one source". Ticket 8 says `src` reads the environment only at entry points. Both cannot stand. Under the document (Principle 4: no hidden construction; Principle 5: config enters as a value), ticket 8 is right and the comment on main describes the obstacle, not a design. Ticket 8 must name `paths.ts` as the thing it dismantles.

Also unnamed: `src/check.ts`. CLAUDE.md says the check command draws through the same functions as the daemon; ticket 6 routes `src/demo/dsl.ts` through the root and says nothing about check.

### Principle 5, time, randomness, identity, concurrency, config

Time (13), config (8), filesystem (15) carried. The Coverage row itself omits randomness and identity, and the plan says nothing about either. Identity is probably already explicit here (session facts arrive as hints, per CLAUDE.md); randomness (session ids, link signer, temp names) is not addressed. One sentence stating that the daemon has no randomness in its core, or a ticket, closes it.

Concurrency is thinner than claimed. The document's fix is a Scheduler/Executor port with a synchronous fake and separating "decide to enqueue" from "run". Ticket 13 folds timers into the clock, which covers `setTimeout` work but not work that completes after I/O: a refresh after a child exits, a watch event, a connection's reply. Ticket 13's done-criterion ("`until`, `renderUntil`, `untilHeard` and log waits appear only in integration and smoke") can only be met once tickets 16, 17 and 21 deliver fakes that settle synchronously or expose a settle. Ticket 13 lists only 6 as a dependency. Either the criterion moves to a later ticket or 13 gains the dependencies.

### Principle 6, module boundaries

Claimed, not carried. The Coverage row cites 6, 10, 11, 12; none of them re-slices a module by capability, writes a per-module acceptance criterion, or addresses "share data by contract, not by database". In this repo Principle 6 bites in two places: the TypeScript/Rust/daemon wire (ticket 23 covers it) and the state directory, which the daemon, the client's acquire path (lock, cooldown, backoff files), the update job and the lifeline all read and write as shared files. That is sharing by database, and no ticket touches it. Either cut the row to "23" or add the state-directory ticket.

### Integration layer mechanics

Carried: once per worker (tmux, compile), isolation by namespace, real dependency, hermetic via recordings, business rules pushed out (ticket 14 asks exactly the document's question). Nothing missing.

### Contract tests

Port contracts: carried by the Stage 5 bullets. Service contract: ticket 23. Two notes. First, `check:protocol` (a textual compare of mirrored constants) remains beside the recorded case set; the document's contract is "a declared or recorded interaction", one artifact. Ticket 23 should say why both remain (constants such as timeouts never appear in an interaction) or fold one into the other. Second, the three-state hint rule (absent, null, value, per `architecture.md`) is the wire fact most likely to be mis-read by one side; the case set should name it.

### Smoke

Carried: cap, happy path, boundary criterion, replacement rule, wall budget. Two gaps. "A fresh install renders a bar" should run from the packed artifact (`pnpm pack`, then install into a temp prefix), not from `dist/`; the document's "uses the production composition root and configuration shape, so it tests what actually ships" means the tarball plus platform package. And "the native client talks to the daemon" needs the Rust binary, which `release.yml` builds in a separate matrix job; the smoke job must take that artifact or build locally, and the plan should say which.

### Where tests belong, and ticket 29

The four placement questions are carried via ticket 29, but ticket 29 copies the document into `.claude/memory/testing.md`. That is a second copy of the standard, and the repo's own CLAUDE.md forbids it ("a paragraph that restates the code is a second clock"; a memory line earns its place by holding what the code can't show). The memory should hold one pointer to the `laws:testing` skill and the repo-specific facts: which directory is which layer, which fakes exist, the traps. See Q2.

### Suite mechanics

Isolation and ordering: 27 (random order), parallel already true. One opportunity the plan misses: `jest.config.js` caps `maxWorkers: 4` because of daemon subprocess pressure; once ticket 2's unit project refuses processes, the unit project can run on all cores and only the process and integration projects need the cap. Per-project `maxWorkers` is exactly what jest projects give.

Test data: ticket 7. Flakiness: ticket 5 matches the document (quarantined tests keep running and recording, no retries, 7-day expiry). Tiers: 25. Selective execution: 28, correctly gated on the dependency rule.

### Migration order

The document: measure, root, extract one painful test, port with fake and contract together starting with the most-needed dependency, move tests down, add the dependency rule once the pattern exists, cap end-to-end.

Three order findings.

1. **Ticket 2 enforces before the seams exist.** The runtime refusal in Stage 1 means that on day one the unit project is only what already passes; the 65 filesystem files, the 20 watcher files and the 59 process files are refused from unit and are not adapters, so they fit no row of the Layers table. The plan's "the layer lives in the file's location" has three values and the territory has a fourth, "not yet seamed". Either the refusal lands with Stage 5 (the document's step 6) or Stage 1 names the fourth location with a deletion date. See Q2, ticket 2.

2. **The cap exists today and the plan defers it.** The document says freeze the count now, convert later. `process-tier.cjs` on main already pins daemon starts at 30. Ticket 24 ("the cap can freeze the count as soon as the tier exists") describes a tier that exists; the ticket is a conversion of that ceiling into the smoke cap, not a new one.

3. **The in-progress launch epic is not in the plan.** `candybar-launch-q7o7` (the daemon's loop runs no subprocess synchronously; `Launcher` loses `launchSync`) is in progress at the top of the backlog and edits the same seam as ticket 17 and touches ticket 11's territory. The plan nests `0x6u` and ignores `q7o7`. Ticket 17 must depend on it or absorb it.

Time before files (13 before 14/15) departs from the document's "usually the database first"; the plan states its criterion (tests freed) and that holds.

### Metrics and governance

Carried: count and duration per layer (1), budgets as checks with escalation to design work (26), flake rate (1 + 5), cap (24). Review questions: 24 carries the e2e one; 29 carries the rest with the one-source problem above.

### Anti-patterns

Addressed: inverted pyramid, container-per-test (7, 20), shared staging (recordings), leaky ports (18), god fixture (7's 364-line preamble), retry-until-green (5), testing through the renderer (9). Not addressed: **test-only code paths**. `src/daemon/acquire.ts` carries `spawn?: () => boolean` labelled "Test hook: replace the actual spawn call". Ticket 11 should delete it in favour of the port and the plan should sweep for others.

### Checklist

Every box has a ticket except: randomness and identity as values (not named), modules sliced by capability (not carried), and "every test passes alone" (27 covers order; "alone" is the quarantine list's and ticket 2's job, implied).

### Decisions, one by one

| Decision | Holds? | Why |
|---|---|---|
| Smoke runs before publishing | Yes | A merge publishes; there is no staging. Sharpen: run it on the packed artifact in the release job, before `semantic-release`. |
| The Load gate stays required | Reason missing | "A deliberate project check" is why it exists, not why it is pre-merge. The document moves performance tests to scheduled, and ticket 25 moves `draw-reserve` there for the same reason (`testing.md` records that both are judged on CI's runner). The reason that holds: a loop-blocking regression ships to every statusline on the next tick, and no lower test catches it (the launch epic exists because of one). Write that, or the decision is an exception without a reason. |
| The layer lives in the file's location | Yes against the document; conflicts with the repo | `main` already spells layer membership as a filename suffix (`*.process.test.ts`) with its own enforcer. Two spellings of one fact. Ticket 2 must absorb that convention in the same change. |
| The rule grows with each port | Yes | Stronger than the document; no window. |
| Fakes live in `src` beside their ports | Yes | Add the trap: a fake in its own file, imported only by the fake root and tests, so tsdown drops it from the bundle. |
| gh and recorded services use recordings | Yes | Pricing's recording already exists (`pricing.yml`); use it. |

**Departures not recorded:** daemon lifetime tests as "integration" (see Layers); Stage 3 as a step outside the migration order; enforcing the unit refusal (ticket 2) before the ports exist.

---

## Q2. Does the design obey `laws:code`?

Per ticket, judging what it would build. Tickets not listed (3, 4, 10, 12, 14, 18, 20, 25 in part, 26, 27, 28) are lawful as cut.

**Epic-level.** The plan's premises are stale against `main` in tickets 2, 6, 13, 21 and 24. `[LAW:one-source-of-truth]`: filing tickets whose descriptions name state that no longer exists puts a second, wrong map of the daemon into lit. Rebase the facts before filing.

**Checkpoint break 3** ("leave one port out of production assembly; smoke fails"). `[LAW:types-are-the-program]`: if `build_production_ports(config): Ports` returns a record type, leaving a port out fails `tsc`, not smoke. The break as written expects a weaker shape than the plan should build. Rewrite it as "mis-wire one port (wrong path or config); smoke fails and typecheck passes", which is what smoke is for.

**Checkpoint break 4** (lint fails and the unit refusal fires for `Date.now()`). `[LAW:single-enforcer]`: two checkpoints for one rule. Lint catches the call in `src` directly (`no-restricted-properties`); the runtime refusal is for tests. Say which guards which or there are two rulebooks that will drift.

**Ticket 1.** Lawful. Add under `[LAW:nothing-unseen]`: a file that ran zero tests and a file that never ran must be distinct records, so every file in a project emits a record even when skipped.

**Ticket 2.**
- `[LAW:single-enforcer]`, `[LAW:one-source-of-truth]`: `main` already has an enforcer for "only here may a real daemon start" (the ledger and `judgeDaemonStarts`) keyed on a filename suffix. Ticket 2 adds a directory-keyed enforcer for the same invariant. Concrete failure: a `foo.process.test.ts` placed under the unit directory passes one check and fails the other, and nobody knows which is law. The ticket must retire the suffix and move the ledger judge to read the project, in one change.
- `[LAW:types-are-the-program]`, `[LAW:no-mode-explosion]`: the layer type has three values; on day one there are roughly 140 files that fit none. A stronger-than-true theorem forces the code to lie (files parked in "integration" that test logic through files) or break (the refusal fires on everything). Either the refusal lands after the ports, or a fourth location exists with a documented deletion date.
- Open question the ticket must answer: which reads of the package's own files (the bundled default, theme data, `pricing.json`) count as "disk" to the refusal. If the bundled default is read from disk rather than imported, every config test is refused.

**Ticket 5.** Lawful. The list is a second home for "which tests are flaky" beside lit, justified because CI cannot read lit; each line carries its ticket, so the derivation is visible.

**Ticket 6.** Target lawful (`[LAW:no-shared-mutable-globals]`, `[LAW:effects-at-boundaries]`), premise stale. `[LAW:escape-local-minima]`: the comment on `DaemonInputs` ("paths are not among them ... half the daemon reads `paths.ts`") is a local minimum defended as the design. Ticket 6 or 8 must make paths a value the storage adapters take; otherwise the "fake ports" root still writes to the real state directory through `paths.ts` and the unit refusal in ticket 2 fires on it.

**Ticket 7.** `[LAW:no-shared-mutable-globals]`: "the compiled bundled default is built once per worker and shared as an immutable value". `daemon-memory.md` records that a compile holds MobX subscriptions and that render cache entries share one compile. If any part of the compile is observable or mutable, the shared value is a shared mutable fixture, and ticket 27's random order will surface it as order-dependent failures nobody can localize. The ticket must say what is shared (the parse, which is data) and what is per-test (anything with a subscription), and how immutability is enforced.

**Ticket 8.** Lawful (`[LAW:effects-at-boundaries]`), with the `paths.ts` conflict above. The lint rule for env reads is the right single enforcer.

**Ticket 9.** Lawful (`[LAW:behavior-not-structure]`). "The broken-decision check recorded per sweep": a record outside code drifts (`[FRAMING:representation]`). The durable proof is the exhaustive unit test on the pure function; let its existence be the record.

**Ticket 11.**
- `[LAW:no-mode-explosion]`: delete `spawn?: () => boolean` ("Test hook") with the port. A test-only path in production is a mode with no owner.
- `[LAW:one-source-of-truth]`: acquire runs in the Node client, and the shipped client is Rust, which has its own daemon-miss-then-spawn path. Extracting acquire's decisions to a pure core tests one of two implementations. The core's cases should become a recorded case set both runtimes assert, as `frame-follow-cases.json` does, under ticket 23.

**Ticket 13.**
- `[LAW:one-source-of-truth]`: `main` already has two clocks by design: `DaemonClock` and `RuntimeStats`' own wall clock (the comment says so). Ticket 13's "one clock" and checkpoint break 4 are impossible while stats keeps its own. The ticket closes that exception or records why it stays.
- `[LAW:no-ambient-temporal-coupling]`: `testing.md` records that the shared poll helper budgets by a real sleep so it survives fake timers. Under ticket 13 the unit project has no real timers, so the helper's wait must go through the clock's `after` (which `DaemonClock` already carries). Say so, or the helper becomes the one real sleep the refusal has to exempt.

**Tickets 15 and 16.** `[LAW:one-source-of-truth]`: files and file-change events are two representations of one territory, a directory's contents. Two ports with two fakes can disagree: a unit test writes to the fake store and the fake watch never fires, so the test hand-fires an event in a shape the real adapter would never produce, and neither contract suite can catch it because they run separately. Make it one port: a store whose writes emit the events a watch would, one real adapter over `fs` and `fs.watch`, one fake. Then the adapter can also carry watch readiness as state (`[LAW:no-ambient-temporal-coupling]`), which deletes most of the re-applied-write folklore `testing.md` carries today.

**Ticket 15 alone.** `[LAW:decomposition]`: "a storage port" covering session state, config and transcripts is one port for several families. `main` already has `DaemonStorage { session, history }`. The document's "keep ports narrow" and the law agree: one port per family, each with its fake.

**Ticket 17.**
- `[LAW:locality-or-seam]`: `candybar-launch-q7o7` is editing `Launcher` now (removing `launchSync`). Two epics on one seam at once ripple into each other. Depend on or absorb it.
- `[LAW:one-source-of-truth]`: state that the fake launcher serves shell sources and the launcher's own contract only; git, gh and tmux logic use their own fakes (18, 19, 20). Otherwise canned-stdout fakes of git appear beside the git fake.

**Ticket 19.** `[LAW:domain-language]`, `[LAW:one-type-per-behavior]`: `git.ts` already calls the thing a *forge CLI* and handles gh and glab. The port is the forge port with gh and glab as adapters (or one adapter with config), not "gh's own port". Concrete failure: glab reaches the launcher directly, outside the rule entry, and the port the ticket builds covers one of the two forges.

**Ticket 21.** Lawful. Note that the TS adapter's socket test proves the TS client only; the Rust client's side is tickets 23 and 24.

**Ticket 22.**
- Leaky port: "pricing gains the seam the registry already has" copies `fetchImpl: typeof fetch`, which is the dependency's type, the document's leaky-port anti-pattern. Three domain ports (pricing table, latest release, usage) with the HTTP client inside their adapters.
- `[LAW:one-source-of-truth]`: `pricing.yml` already produces the scheduled recording. Do not add a second.

**Ticket 23.** Lawful. State why `check:protocol` stays beside the case set.

**Ticket 24.** `[LAW:single-enforcer]`: `HELPER_START_CEILING = 30` is already the cap on real-daemon starts. Convert it; do not add a second number that can disagree with it.

**Ticket 25 vs the first Decision.** `[LAW:one-source-of-truth]` inside the plan: ticket 25 says "a merge needs the first three" tiers (smoke pre-merge); the Decision says smoke "runs on the built bundle as the last gate" before publishing (post-merge, in the release job). Those are different builds: the PR's and main's after the version stamp. Pick one. The document's intent (test what ships) points at the release job, before `semantic-release`.

**Ticket 29.** `[LAW:one-source-of-truth]`: copying the document's questions into memory is a second clock for the standard, and CLAUDE.md's memory rules forbid it on their own terms. One pointer to `laws:testing`, plus the repo-specific facts (which location is which layer, which fakes exist, the one or two traps). Also `[LAW:polishing-by-subtraction]`: the ticket as written grows the memory file; the ports should let it shrink (the hand-faking advice goes, and most of the watch paragraph goes with a readiness-carrying adapter).

**Ticket 30.** `[LAW:verifiable-goals]`: breaks 1, 2 and 4 are machine-checkable (introduce the break on a branch, run the suite, assert the named failure). Script them as a job; keep the human run as acceptance, not as the only check.

---

## Summary of what to change before filing

1. Rebase every ticket's premise on `origin/main`: 2, 6, 13, 21, 24.
2. Record the three unrecorded departures under Decisions (process tier's layer, Stage 3, ticket 2's timing), and fix the Load-gate decision's reason.
3. Ticket 2: absorb the `*.process.test.ts` enforcer; either move the refusal after Stage 5 or name the transitional location with an exit date.
4. Merge 15 and 16 into one watched-store port; split 15's families.
5. Ticket 17 depends on `candybar-launch-q7o7`; ticket 19 is the forge port; ticket 22 uses domain ports and the existing pricing recording.
6. Resolve the `paths.ts` stance between `DaemonInputs` and ticket 8.
7. Cut the Principle 6 coverage claim or add the state-directory ticket; move ticket 9 out of Principle 1; name randomness and identity.
8. Ticket 24 converts the existing ceiling; ticket 25 and the first Decision agree on where smoke runs.
9. Ticket 29 points at the skill instead of copying it.

Files read for this review: `/Users/bmf/code/cc-candybar/docs/layered-test-plan.md`, `/Users/bmf/code/cc-candybar/CLAUDE.md`, `/Users/bmf/code/cc-candybar/.claude/memory/testing.md`, `/Users/bmf/code/cc-candybar/.claude/memory/architecture.md`, `/Users/bmf/code/cc-candybar/jest.config.js`, `/Users/bmf/code/cc-candybar/eslint.config.mjs`, `/Users/bmf/code/cc-candybar/.github/workflows/release.yml`, `/Users/bmf/code/cc-candybar/src/daemon/acquire.ts`, and on `origin/main`: `src/daemon/daemon.ts`, `src/daemon/server.ts`, `src/proc/launch.ts`, `test/helpers/process-tier.cjs`.

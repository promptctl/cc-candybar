# Coalescing in flight: drop the duplicate, keep the last good value

Verdict: **adapt, and lift from ourselves.** asyncgit's answer to "what happens to a request
that arrives while one is in flight" is not one mechanism but two, chosen by whether anything
will ask again. The queueing half of that pair already exists in cc-candybar — at
`src/daemon/cache/git.ts:530-568` — and `runSource` is the one site that never got it. The rest
of asyncgit's shape (a params-hash request identity, a generation counter that replaces a TTL) is
either already better handled here or actively wrong for a detached daemon rendering several
times a second.

## The mechanism

asyncgit (gitui's git layer) runs every expensive git call on a rayon thread pool and keeps three
separate fields per async facade — `AsyncStatus`, `AsyncDiff`, `AsyncBlame`, and friends all
repeat the same three. They are not wrapped in an abstraction; each module spells them out.

**`current: Arc<Mutex<Request<u64, T>>>` is the dedupe.** `Request` is a two-tuple of a `u64` and
an `Option<T>`: a request identity and, once the worker finishes, its answer. The identity is
`hash(&params)` over the whole parameter struct — for `AsyncDiff` that is
`DiffParams { path, diff_type, options }`, for `AsyncStatus` it is `StatusParams { status_type,
config }` paired with a generation number. On entry, `fetch`/`request` hashes the params and
compares against the slot. A match returns the slot's `Option<T>` and starts nothing: `Some(v)`
when the answer is already there, `None` when the same request is still running. A miss
overwrites the slot's hash, clears its value to `None`, and spawns the worker. So "I already
asked this" and "I already answered this" are the same test, and the test is over the *request*,
not over a key string a caller had to invent.

**`last` is the last-known-good, and it carries its params.** `AsyncDiff` holds
`Arc<Mutex<Option<LastResult<DiffParams, FileDiff>>>>` — a struct of exactly `{ params, result }`.
The worker writes it unconditionally, at the end of every completed run, and nothing ever
invalidates or clears it. `AsyncStatus` holds the degenerate version, `Arc<Mutex<Status>>`
defaulted to an empty item list. The UI renders from `last()` whenever `is_pending()` is true, so
a refetch never blanks the pane. Pairing the params with the value is what makes that safe:
`src/tabs/status.rs` compares `params == diff_params` before showing the cached diff, and requests
a fresh one when they differ, so the consumer asks "does the value I'm holding answer the question
I'm asking now?" instead of trusting whatever `last` happens to hold.

**A superseded result is written to `last` but not to `current`.** The worker re-locks `current`
and only stores its result if `current.0` is still its own hash. If a newer request replaced the
identity while this one was out, its result lands in `last` alone — it is history, never the
answer to the newer question. `AsyncDiff` derives its notification from the same test: a
superseded diff sends `AsyncGitNotification::FinishUnchanged` rather than `Diff`, so the UI does
not redraw for a result nobody asked for.

**Forced refetch has two spellings, one per module.** `AsyncDiff::refresh()` reads the params out
of `last`, calls `clear_current()` — which zeroes the hash and nulls the value — and re-requests
those same params. Zeroing the hash is the whole trick: the identity test is now guaranteed to
miss, so the same question is asked again. `AsyncStatus` instead carries
`generation: Arc<AtomicU64>` and folds it into the identity as `hash(&(params, generation))`; the
worker increments it *after* the fetch completes. Identical params therefore hash differently
before and after a completed fetch, which means the next poll always refetches and a poll during
a fetch never does. That generation counter is a *replacement* for a clock: until commit
`49555ce` (gitui #2824), `StatusParams` carried a `tick: u128` of `SystemTime::now()` millis, so
every UI tick minted a new identity, the one-slot cache never hit, and a million-file repo took
five minutes to load.

**The drop-versus-queue decision is made twice, and differently.** `AsyncStatus::fetch` drops:
its first statement is `if self.is_pending() { return Ok(None); }`. That is safe only because
gitui's `Status` tab calls `update()` on every event-loop tick and the generation counter
guarantees the next call refetches — a dropped request costs one tick, nothing more. Where nothing
re-polls, asyncgit queues instead, through `AsyncSingleJob<J: AsyncJob>` in
`asyncgit/src/asyncjob/mod.rs`: a one-slot `next: Arc<Mutex<Option<J>>>` that later `spawn`s
overwrite rather than append to, plus a `pending: Arc<Mutex<()>>` probed with `try_lock`. `spawn`
always calls `schedule_next(task)` and then `check_for_job()`; `check_for_job` returns early if
pending, otherwise takes `next` and spawns it. The drain is one line at the end of `run_job`,
outside the pending scope: `self.check_for_job()`. So N requests arriving during a run collapse to
exactly one more run — the last one — and none of them is lost. Eight fields across six modules
hold one (`revlog`'s commit-filter and local/remote-branch jobs, `syntax_text`, `revision_files`,
`blame_file`, `fetch`, `taglist`), every one of them triggered by a keypress or a selection change
rather than by a clock.

That is the shape worth naming: **the drop is only correct where something will ask again.**

## Evidence

Paths are relative to `/tmp/peer3/asyncgit-coalescing` (gitui at `b1db21e`). Excerpts are copied
from the cited lines with leading tabs rendered as spaces.

| Fact | Path | Lines | Excerpt |
|---|---|---|---|
| A request arriving while one is pending is dropped outright | `asyncgit/src/status.rs` | 88-91 | `if self.is_pending() {` / `log::trace!("request blocked, still pending");` / `return Ok(None);` / `}` |
| Request identity is a hash of the params plus the generation | `asyncgit/src/status.rs` | 93-94 | `let generation = self.generation.load(Ordering::Relaxed);` / `let hash_request = hash(&(params, generation));` |
| A matching identity returns the one-slot value and starts no work | `asyncgit/src/status.rs` | 106-108 | `if current.0 == hash_request {` / `return Ok(current.1.clone());` / `}` |
| The generation counter is documented as advancing per completed fetch | `asyncgit/src/status.rs` | 52-53 | `/// Counter that increments after each completed fetch.` / `generation: Arc<AtomicU64>,` |
| The worker advances it after the fetch, to force the next request to miss | `asyncgit/src/status.rs` | 137-138 | `// Increment generation to invalidate cache for next request` / `arc_generation.fetch_add(1, Ordering::Relaxed);` |
| A superseded result is not written into `current` | `asyncgit/src/status.rs` | 164-167 | `let mut current = arc_current.lock()?;` / `if current.0 == hash_request {` / `current.1 = Some(res.clone());` / `}` |
| `last` is written unconditionally on every completed fetch | `asyncgit/src/status.rs` | 171-172 | `let mut last = arc_last.lock()?;` / `*last = res;` |
| The last-known-good is a params/result pair, not a bare value | `asyncgit/src/diff.rs` | 46-49 | `struct LastResult<P, R> {` / `params: P,` / `result: R,` / `}` |
| Forced refetch = re-request the last params after clearing the identity | `asyncgit/src/diff.rs` | 83-87 | `pub fn refresh(&self) -> Result<()> {` / `if let Ok(Some(param)) = self.get_last_param() {` / `self.clear_current()?;` / `self.request(param)?;` / `}` |
| Clearing the identity is zeroing the hash | `asyncgit/src/diff.rs` | 217-218 | `current.0 = 0;` / `current.1 = None;` |
| The notification distinguishes a wanted result from a superseded one | `asyncgit/src/diff.rs` | 144-148 | `.send(if notify {` / `AsyncGitNotification::Diff` / `} else {` / `AsyncGitNotification::FinishUnchanged` / `})` |
| The consumer checks the cached value's params against the current question | `src/tabs/status.rs` | 503-505 | `if let Some((params, last)) = self.git_diff.last()? {` / `if params == diff_params {` / `// all params match, so we might need to update` |
| The queueing alternative is a one-slot queue, overwritten until taken | `asyncgit/src/asyncjob/mod.rs` | 66-67 | ``/// Abstraction for a FIFO task queue that will only queue up **one** `next` job.`` / `/// It keeps overwriting the next job until it is actually taken to be processed` |
| Every spawn schedules, then tries to start | `asyncgit/src/asyncjob/mod.rs` | 114-117 | `pub fn spawn(&self, task: J) -> bool {` / `self.schedule_next(task);` / `self.check_for_job()` / `}` |
| Scheduling overwrites rather than appends | `asyncgit/src/asyncjob/mod.rs` | 166-168 | `if let Ok(mut next) = self.next.lock() {` / `*next = Some(task);` / `}` |
| The drain is one re-check after the pending scope closes | `asyncgit/src/asyncjob/mod.rs` | 160 | `self.check_for_job();` |
| The generation counter replaced a time-based invalidation | `CHANGELOG.md` | 32 | `* fix extremely slow status loading in large repositories by replacing time-based cache invalidation with generation counter` |
| The clock it replaced was a millisecond tick inside the identity | `asyncgit/src/status.rs` at `49555ce^` | 19-23, 34 | `fn current_tick() -> u128 {` / `SystemTime::now()` / `.duration_since(UNIX_EPOCH)` … `tick: u128,` |
| What the clock-in-identity cost | `asyncgit/src/status.rs` at `49555ce` | commit message | `causing the cache to invalidate on every UI tick. For large repos with millions of files, this led to repeated index loading and 5+ minute load times.` |

## What cc-candybar does today

**The queueing shape is already here, at one site.** `src/daemon/cache/git.ts` holds
`refreshing: Set<string>` and `refreshAgain: Set<string>` (lines 183-184), and
`refreshSubscribers` (line 530) sets the trailing flag and returns when a refresh for that repoRoot
is already running. `doRefreshLoop` (line 541) wraps its body in `do { this.refreshAgain.delete(
repoRoot); … } while (this.refreshAgain.has(repoRoot))` and clears both sets in a `finally`. That
is `AsyncSingleJob` — one slot, overwritten, drained after the run — written in TypeScript, cited
under `[LAW:single-enforcer]`, with its own reasoning in the comment at line 176: "back-to-back
invalidations (rapid commits, rebase) would fan back out into parallel `git status` calls". It
already gets the hard part right, including the part asyncgit's `AsyncSingleJob` does not have to
think about: re-reading `subscribersByRepo` after every await, and checking `current.callbacks.has(
cb)` per callback at call time rather than snapshotting the set (lines 553-560).

**The concurrent-caller coalescer is also already here, and it is a different behaviour.**
`src/utils/single-flight.ts` is `SingleFlight.run(key, factory)`: the second caller for a live key
receives the *first* call's promise, so N awaiting callers get one computation and one value. Its
header comment is explicit that it is "a coalescer, never a cache" — the entry is deleted on
settle, so nothing stale is retained. Two fields hold one, both on awaiting-a-value paths:
`src/daemon/cache/session-usage-store.ts:301` (`flight`, keyed on session plus observed mtime) and
`:319` (`speedFlight`, keyed `${sessionId}:${mtime}`), with the day-seed memo at `:306`
deliberately *not* using it because that one wants retention.
`src/daemon/cache/git.ts` has the same shape twice more, inline: `fetchInFlight` (line 165) and
`prFetchInFlight` (lines 172-175).

**The forge PR path is correct and should be left alone.** `GitService.resolvePullRequest`
(`src/segments/git.ts:1020`) does the forge detect and CLI spawn and returns
`Outcome<PullRequest>` — the three-state `ok | absent | failed` from `src/utils/outcome.ts:12`,
with `absent` when `detectForge` recognises no host and `failed` classified from the CLI's own
output. It caches nothing; `GitDataProvider.getPullRequestCached`
(`src/daemon/cache/git.ts:360`) owns the lifecycle, keyed `${repoRoot}|${branch}|${remoteUrl}` with
an outcome-dependent TTL — `PR_TTL_OK_MS = 5 * 60_000`, `PR_TTL_FAIL_MS = 45_000` (lines 55-56) —
and coalesces concurrent misses through `prFetchInFlight` (line 385). Reading the remote *before*
building the key, so a re-pointed origin is a fresh key rather than a stale hit, is a correctness
detail asyncgit's params-hash gets for free and this code had to do by hand.

**The gap is `runSource`, and only for three of its five trigger kinds.**
`SourceRegistry.runSource` (`src/var-system/sources.ts:783`) opens with
`if (this.inFlight.has(name)) return;` (line 788) and registers the run in
`inFlight: Map<string, Promise<void>>` (line 583), deleted in a `.finally`. The comment above that
map (lines 578-582) states the behaviour as intended: "one run per source at a time (a refresh that
fires while the previous run is still out is dropped)". For `CachePolicy.kind === "ttl"` that is
asyncgit's status case exactly — `this.ttlMgr.subscribe(policy.durationMs, update)` (line 1059)
re-polls, so a dropped refresh costs one interval. For the other three triggers nothing re-polls.
`depends_on` (line 1092) installs a MobX `reaction` over
`policy.varNames.map((n) => this.store.changeKey(n)).join(",")`, `key` (line 1070) a reaction over
a rendered template, `watch_file` (line 1064) an fs watcher. Each fires once per change. A change
that arrives while the previous run is out is gone — not deferred, gone — until some *later*,
unrelated change happens to fire the same reaction again. The comment at lines 1093-1096 claims the
opposite: "the update always runs when the joined snapshot changes". At the daemon's load —
roughly 200 git subprocesses a minute — a shell source with `depends_on: ["git.branch"]` and a
command slower than the gap between two branch switches renders the wrong branch's data
indefinitely.

**Last-known-good across a failure is not kept.** `scalarPublisher`
(`src/var-system/sources.ts:745`) publishes `this.store.setBox(name, orElse(outcome, fallback))`,
and `orElse` (`src/utils/outcome.ts:31`) collapses both non-`ok` arms to the fallback — which is
the *declared default*, not the previous good value. A transient shell failure therefore replaces
a good value with `""`. That is deliberate, not an oversight: `noteOutcome` records the failure and
the diagnostic strip says so, under `[LAW:no-silent-failure]`.

## The change

Three files, one new, and it deletes more than it adds.

**New: `src/utils/trailing-edge.ts`.** A keyed one-slot trailing queue, the TypeScript spelling of
`AsyncSingleJob`'s `next`/`pending`/`check_for_job` triple:

- `run(key, job: () => Promise<void>): void` — if `key` is running, mark it again and return;
  otherwise start the drain loop for `key`.
- The drain is `do { clearAgain(key); await job(); } while (again.has(key))`, with both sets
  cleared in a `finally`, exactly as `doRefreshLoop` does it today.
- `idle(): Promise<void>[]` or a `pending(): readonly string[]` view, so `settled()` has something
  to await (see below).

It does **not** grow out of `single-flight.ts`, and does not replace it. `SingleFlight.run` hands
the second caller the *first* run's result; a trailing queue causes a *second* run. Those are two
behaviours, and folding them into one class with a flag is the `[LAW:one-type-per-behavior]`
violation the existing file's own comment argues against. Two small modules, one each.

**`src/daemon/cache/git.ts`:** delete `refreshing` and `refreshAgain` (lines 183-184) and the
`do…while` in `doRefreshLoop` (lines 543-563); `refreshSubscribers` becomes one
`this.trailing.run(repoRoot, () => this.refreshOnce(repoRoot))` call, where `refreshOnce` is the
current loop body — including the per-callback `has()` check at line 560, which is a fact about
subscribers and does not move. This is the `[LAW:single-enforcer]` half of the change: the
mechanism stops being a local idiom in one cache and becomes one owner two callers name.

**`src/var-system/sources.ts`:** delete the drop at line 788 and route `runSource` through the same
owner. `inFlight` (line 583) goes with it — the trailing-edge module now holds the per-name
promise, and it must resolve when the name is *idle* (nothing running, nothing queued), not when
the current run settles, or `settled()` (line 809) would report a source complete with a queued run
still outstanding. That widens `settled()`'s contract from "every run in flight has completed" to
"every source is idle", which is what `cc-candybar check` has always wanted; its deadline already
bounds the wait. Then fix two comments that currently document the bug as intent: lines 578-582
("…is dropped") and lines 1093-1096 ("the update always runs when the joined snapshot changes"),
which becomes true for the first time.

**Observable difference.** A `depends_on` / `key` / `watch_file` source whose command outlives the
interval between two triggers now publishes the value for the *latest* trigger instead of pinning
the value from the one before it. N triggers during one run collapse to one further run, so the
worst case per burst goes from one subprocess to two, never to N. Nothing changes for `ttl` or
`never`. A regression test is cheap and the shape is already known here: make the dependency the
slow side, mutate it during the run, assert the published value reflects the second mutation.

**What should not be lifted.**

*The generation counter.* Its effect is "refetch once per completed fetch, as fast as the work
allows". For the forge PR call that is a `gh` subprocess per render — the `PR_TTL_OK_MS` /
`PR_TTL_FAIL_MS` pair is the right answer for a network resource, and gitui's own reasoning
agrees: #2824 was a fix for refetching *too often*, and the counter is only tolerable there
because `git status` on a warm index is local and cheap. Leave the PR TTL alone.

*Last-known-good across a failure.* Holding the previous value instead of reverting to `""` is a
real improvement in what the bar shows, but it is a `[LAW:no-silent-failure]` argument in both
directions — a stale value plus a red strip row versus an honest empty plus a red strip row — and
it is a change to `scalarPublisher`/`documentPublisher`, not to the trigger path. It wants its own
ticket. If it is taken, take asyncgit's whole shape and not half of it: `last` there is a
`(params, result)` pair precisely so the consumer can tell whether the retained value answers the
current question, and cc-candybar's equivalent of "params" is the `changeKey` snapshot the
`depends_on` reaction already computes.

*The params-hash request identity.* `runSource` has no request parameters — the reader is fixed at
declaration, and the trigger carries no arguments — so there is nothing to hash and no cache slot
to key. Adding one would be inventing an identity to hold a mechanism that needs none.

**One unsolicited flag, from #2824.** A clock inside the request identity is what cost gitui five
minutes of load time. cc-candybar cannot hit that in the `ttl` arm — the clock drives *when*
`update()` is called, not what the identity is, and `MIN_SHELL_TTL_MS = 500`
(`src/var-system/sources.ts:58`) floors it. But `clampShellCache` returns unchanged for every
non-`ttl` policy (line 67), and a `key:` template is an arbitrary expression: an author who writes
a time-varying value into a `key:` gets a source that re-runs on every store change with no floor
at all. Today the drop at line 788 accidentally limits the damage to one run at a time; after this
change it would not. That is the one place I would want a measurement before merging, and the
likely answer is a minimum inter-run gap per source — a fact about the source, applied in one
place, rather than a floor that only one policy kind sees.

## Cost and risk

**Build cost is small and mostly deletion.** The new module is roughly forty lines including its
law comments, and it is a transcription of code already in the repo and already reviewed. `git.ts`
loses two fields and a loop and gains one call. `sources.ts` loses a guard and a map. The one
genuinely new piece of design is `settled()`'s idle promise, and it is a handful of lines.

**What it breaks.** Any test asserting that a second trigger during a run produces no second run.
`test/var-sources.test.ts` is the place to look, and per the repo's own note on this bug ("make the
dependency the slow one in chained tests") at least one test is already written around the drop.
`settled()`'s widened contract also changes `cc-candybar check` timing under a burst: a source whose
trigger keeps firing now keeps the registry non-idle until the deadline, where before it settled
after one run. That is more honest and slower, and the deadline already caps it.

**Subprocess budget.** The worst case per trigger burst doubles, from one run to two, per source —
bounded, and only on the three arms that burst. The unbounded case is the `key:` hole above, which
the drop currently masks. Shipping the queue without a floor for non-`ttl` policies moves a latent
misconfiguration from "silently stale" to "spawns back-to-back subprocesses forever", which is a
worse failure at 512 MB RSS and 200 subprocesses a minute. The two changes belong in the same PR.

**What it makes harder to change later.** Two things. First, the trailing-edge module becomes a
third coalescing primitive alongside `SingleFlight` and the inline `fetchInFlight`/`prFetchInFlight`
maps, and "which of these do I want" is a real question a future author has to answer — the
mitigation is that each one's header comment names the behaviour it owns and names the other, so
the choice is documented at both ends rather than in a wiki. Second, once `runSource` queues,
"every trigger is eventually observed" becomes a property authors can rely on, and taking it back
later would be a silent behaviour regression in user configs. That is the intended direction, but
it is a one-way door.

## Licence verdict

The checkout's own `LICENSE.md` carries no `SPDX-License-Identifier:` line; its first line is
`MIT License` and the body is the verbatim Expat text ("Permission is hereby granted, free of
charge, to any person obtaining a copy…"), copyright `2025 gitui-org`. The SPDX identifier is
asserted in the manifests instead: `license = "MIT"` at `Cargo.toml:12` and
`asyncgit/Cargo.toml:10`. So: **MIT**, which the maintainer's rule allows, and code may be copied
as well as the idea reused — with attribution retained. In practice nothing needs copying here:
the Rust does not translate, and the TypeScript being proposed is a move of cc-candybar's own
`doRefreshLoop` into a shared module, so only the *shape* crosses over and the licence question
never binds.

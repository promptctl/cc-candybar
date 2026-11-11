# Per-directory sharing of shell and file sources, once the host runs them

**What this document answers**

- Why ticket candybar-host-renderer-x96a.8e9 (the host runs a renderer's sources from its subscriptions) puts per-directory sharing at risk.
- Which constraints any answer must hold to: the spec, the laws, and the load we serve.
- The options, and what each buys and costs.
- Where the work stands, and what the next session does.

## The requirement

The daemon serves about 30 Claude Code sessions across 8 to 10 projects at once. Sessions that render from one directory must not each pay for what that directory already knows. Today that means one node and one run per shell or file source per directory, and a value the directory holds is drawn on a session's first bar. Worktrees narrow how many sessions share an exact directory, but they don't remove the case.

## How sharing works today

- **Scope.** src/dsl/variable-scope.ts puts each variable in a directory's store or in a session's view. A `shell` or `file` source is the directory's unless its cache policy (`key`, `depends_on`) reads a view value. Then each session runs its own, keyed by its own values.
- **The directory's store is a render-cache entry.** The entry is keyed by project directory, working directory and config file (src/daemon/cache/render.ts). Every session drawing from that triple reads the entry's one registry. A view reads through to it.
- **Holds live with the entry.** The entry's registry holds its sources' runs from the build to the entry's disposal. An entry outlives its last view, and goes only when the cache evicts it for its byte budget or its count. So a directory nobody draws keeps its `ttl` sources spawning until eviction. That is a cost today's design pays.
- **Runs are shared by digest beneath that.** `SourceRuns` (src/var-system/source-runs.ts) keys each run by a digest of what it reads (the command and its working directory, or the file's absolute path), its parser and its refresh. Every holder of one digest reads one run.
  - A shell source's digest contains the entry's working directory, so it is shared exactly by the sessions of one directory.
  - A file source's digest has no directory in it, so one file read is shared by every directory that declares it.
  - `SourceRuns` keeps no unheld entry: the last release ends the run, its period and its watch.
- **Built-ins are not part of this.** Git, the PR lookup, tmux names and the rest are already host-side keyed sources, held per session by the collector at the keys the session's request names. Git is keyed by repository root. 8e9 doesn't touch them.

So per-directory sharing today is two things stacked: a directory-scoped node in the renderer, and digest-keyed runs beneath it.

## Why 8e9 breaks it

8e9 moves the runs out of the renderer. Each renderer output names what its state needs read, in `subscriptions`, whole, per session. The host's collector holds and runs those sources and hands each reading back in that session's world state. No renderer-side code holds a run (docs/design/host-and-renderer.md §7, the ticket's confirmation).

A directory's node has no session. It sits under every session of its directory, and readings now arrive only in per-session documents. So the node has nowhere to read from, and the plan on the ticket (v2) makes shell and file sources view-scoped. Run sharing survives that, because the host still keys runs by digest. What the directory-scoped node bought does not:

1. **A second session's first bar.** Today it draws the directory's value at once. Under v2 its view's node is new, and the session's first world state carries no reading. Its subscription leaves with that turn's output, so the bar draws pending for one statusline tick, though the host already holds the answer.
2. **Respawn on view churn.** Under v2, a view that closes (the session retired, or its entry evicted) drops its subscriptions with the next output. If it was the last holder, `SourceRuns` ends the run. A view reopening runs the command again and draws pending for a tick.
3. **A node per view.** Every open view carries its own node and its own key-policy reactions for each source. That memory is held against the per-view cost the cache accounts (`VIEW_BYTES`), which test/render-cache-sharing.test.ts measures.

## Constraints any answer must hold to

- **The spec.** One host owns the world; a renderer answers from world state and events. A renderer's output carries its subscriptions whole, and the host diffs them. Readings reach a renderer from the host, per session, in world state (§6, §7). A request is answered by a `present` in its own turn's output; a turn whose output has none is answered with a failure (§7).
- **Subscriptions leave only in outputs.** The host learns what a turn needs read when the turn answers. Nothing in the turn can wait for a reading its own subscription asks for.
- **`[LAW:one-source-of-truth]`.** One map per fact. A renderer-side copy of a host fact, or a second document carrying host facts beside world state, is a second clock.
- **`[LAW:one-type-per-behavior]`.** No second store doing what `WorldStates` does.
- **The project's "one store" rule** (CLAUDE.md): no cache beside the variable store.
- **Load is judged by engineering, not by stress runs** (CLAUDE.md): count what each tick, render and event does.

## The options

### A. View-scoped sources, runs shared by digest in the host (the ticket's plan v2)

Shell and file sources become view-scoped. The host holds each session's runs and stamps their readings into that session's world state. Runs stay shared by digest, so the sessions of one directory still cost one run per shell source, and every directory costs one read per file source.

- **Buys:** the spec as written, with no new channel and no renderer cache. The scope rule gets simpler: the policy-reads fixpoint goes. It also lines up with the spec's step 4, where a shell identity includes the session's environment and so is a session's in any case.
- **Costs:** all three losses above. That is a first-bar tick for every new view, a respawn and a tick on view churn, and a node per source per view.

### A+. Option A, and the host keeps unheld runs the way its other keyed sources do

As A, and `SourceRuns` keeps unheld entries under a count bound instead of `maxEntries: 0`. That is how tmux names, plugin session files and usage scans already behave (src/utils/keyed-source.ts). An unheld entry runs no period, because a period runs only while its entry is held, so a kept `ttl` entry spawns nothing. A hold that returns finds the kept value at once and starts its next read.

- **Buys:** loss 2 goes. A reopened view's run doesn't respawn, and the first world state after its output carries the kept value. It also removes today's idle cost: a directory nobody draws holds nothing, so its `ttl` sources stop spawning when its last session lets go, rather than at eviction. The spec is untouched.
- **Costs:**
  - Loss 1 stays, as one tick per newly opened view, whether its session is new or returning. The kept value lands in the world state after the turn, not in the turn.
  - Loss 3 stays.
  - A kept entry keeps its watch open until it is dropped (src/utils/keyed-source.ts), so the bound also bounds the open watches of kept `watch_file` runs. Unconfirmed: whether a change heard while the entry is unheld reads at once or waits for the hold to return.
  - The bound is one more number to set.

### B. Directory-scoped nodes reading a renderer-wide run document (tried as plan v3, withdrawn)

The host hands the renderer one document of every held run's reading, keyed by digest, and the directory's node reads it.

- **Buys:** all three losses go.
- **Costs:** it breaks the spec. Readings would reach the renderer outside world state, and the renderer would keep a directory node as a cache of a host fact. It also breaks the laws: a second document of host facts with its own sequence beside world state (`one-source-of-truth`), and a second store doing what `WorldStates` does (`one-type-per-behavior`).
  - A variant has the directory node read "the newest of its sessions' world states". That is the same second clock, and it answers by which document landed last.
  - Rejected.

### C. A request is presented by a later turn, before its deadline (a spec change)

A request's turn may return its subscriptions and no `present`. The router keeps the request open until its client's deadline. The renderer presents the frame for that request from the first turn whose world state carries the readings it waits on, or from a `due` it scheduled at the deadline. This is the spec's own mailbox idea, moved to after the subscription.

- **Buys:** loss 1 goes for every source kind, not only shell and file. A source first evaluated in a turn, a key the turn moved, and a plugin source a newly opened view subscribes all draw their value on the first bar, whenever it lands before the deadline. Today plugin sources draw pending on a view's first bar for this same reason (.claude/memory/data-sources.md). With A+ it also gives a returning view its kept value on the first bar.
- **Costs:**
  - It amends §7, which says a turn without a `present` is answered with a failure.
  - The renderer's state machine holds open requests, and an open request must end in exactly one `present` or the deadline's failure.
  - It overlaps candybar-skeleton-wj0c.zhh ("a request waits on its world state"). That ticket's wait covers only fields a world state already carries, so this is a different wait, and the two tickets would have to be cut together.
  - It does not touch loss 3.

### D. The host seeds a new session's runs from a sibling session (needs plan step 3)

Once config discovery is the host's (plan step 3, `ConfigSnapshot`), the host knows which sessions share a config chain and a directory. On a new session's first request, it could hold the runs a live sibling with the same snapshot and directory holds. The first world state would then carry their readings, and the session's first output would replace the guess.

- **Buys:** loss 1 goes for a second session in a directory, which is the case the requirement names.
- **Costs:**
  - The host acts on a guess about what a renderer will subscribe, built from another session's output. That is a second rule for what is held beside "subscriptions whole in every output".
  - It can't be built before step 3.
  - It does nothing for a moved key or a first source.
  - It is listed for completeness; I would not build it.

## What each option does to the three losses

| | 1. First bar of a new view | 2. Respawn on view churn | 3. Node per view | Spec |
|---|---|---|---|---|
| A | one tick pending | respawns | yes | holds |
| A+ | one tick pending | no respawn | yes | holds |
| B | none | no respawn | no | breaks, rejected |
| C (with A+) | none | no respawn | yes | amends §7 |
| D (with A+) | none, for a sibling only | no respawn | yes | holds, adds a guess |

Loss 3 is renderer memory per view. With the views a daemon holds at this load, that is about 30, and the per-view heap test says whether it fits.

## Where things stand

- **Branch:** `candybar-host-renderer-x96a.8e9`, cut from origin/main at 7921fb6e7, in the worktree .claude/worktrees/host-and-renderer. This note is its only commit. No code has changed.
- **Ticket:** candybar-host-renderer-x96a.8e9, phase `plan`. Its plan is v2 (option A), restored after plan v3 (option B) was withdrawn.
  - Plan v1 failed law review on `single-enforcer` (comment cmt-9db87bd3): the loader and the collector were both judging the same rules. v2 answers that with the collector as the one judge.
  - v2 has not been reviewed: its review was stopped when per-directory sharing came up.
- **Owner's position:** per-directory sharing stays a requirement, and option B is rejected because it breaks the spec and the laws.

## Recommendation (mine)

Build A+ in 8e9. It holds the spec, removes the respawn, ends today's idle spawning, and leaves the first-bar tick as the one cost. Then file C as its own ticket, cut together with zhh, because it removes the tick for every source kind, plugin sources included, and the tick is a property of subscriptions leaving in outputs, not of shell or file sources.

Before building A+, measure loss 3 with the per-view heap test. If one node per source per view does not fit at about 30 views, that is evidence against A and A+ that I have not seen, and the choice opens again.

## What the next session does

1. Read this note and the ticket (`lit show candybar-host-renderer-x96a.8e9`).
2. Ask Brandon once, with this note and the recommendation: A+ alone, A+ now with C filed, or another option. The lane's next tickets (8se onward) wait on 8e9, so the answer gates the lane. Measure loss 3 while waiting.
3. Revise the plan to the decision. For A+, add the count bound on unheld runs to `SourceRuns` and say why it is the same rule the other keyed sources follow. Then send the plan to law review (`lit quickstart review`).
4. Implement once the review passes.

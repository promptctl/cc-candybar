# Gather

Status: design, nothing built.

## Owns

The Gather process, `SessionFacts`, and everything that reads the outside world for a session: built-in sources, `shell`, `file` and plugin sources, watchers, and the run table. The messages in [../contracts.md](../contracts.md).

## Why

One process does the disk reads, watches and scans, however many renderers exist. That's what prevents duplicate I/O and resource use. A renderer's rebuild also leaves its caches warm, and a slow first compile can't stall another session's data.

## Design

### Total facts

Every built-in source always runs, so `session`, `metrics` and `activity` always exist. They never travelled outside the payload: `wantsOf` skips any built-in source the config doesn't read, so those fields simply weren't there.

Measured on one session and a 2 MB transcript (`probes/p5.mts`):

| With every built-in source on | Result |
|---|---|
| Bar | Byte-identical |
| Payload | 2,584 → 2,734 bytes |
| `session`, `metrics`, `activity`, `context`, `cache`, `speed` refresh | About 1 ms each; 113 ms first load in all |
| `today` | 1.7 s first scan, then 1 ms |

The closure gating is deleted: `wantsOf`, `buildNeededPrefixes`, `sourcesRead`, `neededInputPaths`, the `closure` parameters, `prFactOf`'s `readsPr`, and `openView`'s preset reaction. `gitOptionsFromClosure` becomes one constant set. `doctor/data-needs.ts` keeps its own config walk.

Two changes must land first, or every built-in source joins the first bar's wait:

- **`today` stops blocking.** It leaves `waitsOf` and the `refreshPayload` list, then draws pending and lands through its reaction.
- **PR leaves `waitsOf`.** Otherwise every first bar and branch move spends the budget on a network call. It also needs a `forge` concurrency cap and backoff on repeated identical failures, or an unauthenticated `gh` becomes 80 failed spawns an hour per repo.

Deleting the gating adds work that was skipped: a tmux name spawn per view, `committedAt` and remotes spawns, three transcript folds per first request, and `today`'s 60 s rescan held by every view.

### A render

A client's request reaches a renderer. The renderer forwards the hook data, and Gather's refresh lands as facts. In steady state the renderer can draw from what it holds; a request that must wait for its own refresh takes a round trip. The wait lives in the renderer, inside the existing budget, roughly 110 ms from the client's clock.

### Sources

`shell` and `file` are the bar's primary expansion points, so they're first-class here.

**Who does what.** A renderer's config declares its sources. The renderer evaluates `key` and `depends_on`, which are pure functions of its store, and may read values only it has, such as `.theme.effective`. The loader refuses clock reads in them (`checkPolicyInstant`). Gather runs read and parse, because dedupe, torn-write settling and failure text all need the parsed outcome. The renderer folds `default` and `default_empty_value`.

| Policy | Gather | Renderer |
|---|---|---|
| `ttl`, `watch_file`, `never` | Timers, watches, floors | Declares once |
| `key`, `depends_on` | Runs on a new value | Evaluates, sends `key` |

**Identity.** `digest(kind, command | (path, readMode), cwd, parse, normalised policy, keyValueHash | "")`. `default` and the key template stay out, so two renderers differing only in a default share one run.

Carrying values in place of running them drew byte-identically with nothing run by the renderer. A second renderer running sources today ran `shell` twice.

**Traps, each needing a test:**

- Entering a key triggers one re-read, not another holder's answer. `key` is an edge detector with no period, so a held answer can be any age.
- During a key move the old value stands until the new run lands. `newKeyOut` carries that, and a new id must not read as empty.
- A chain (B keyed on A) relies on B being marked before A's run ends. Across a wire, A's landing clears Gather's wait before the new key arrives, which is why the request's wait lives in the renderer.
- Scalars have no pending state, so the renderer maps pending to the fallback. Otherwise scalar sources gain loading cells they've never had.
- `validateNoCycles` sees one config. Two renderers can form a loop neither loader sees, so Gather needs a per-id run floor.
- `shellReader` has no timeout today. One slow command holds its identity for every renderer sharing it.

**Repo gate.** The gate stays in the one resolve, in the renderer's load. Gather rechecks by re-running `gateRepos` over the layers a `declare` names, and re-validates absolute paths, regex captures and the shell floor with the loader's own specs. This is a consistency guard, not security: a same-UID process can already run anything through `--config`, and the gate defends against a cloned repository's contents.

### `env`

`declareEnv` reads `process.env` once. That's the spawning shell's for a detached daemon, which `CLAUDE.md` calls wrong for session facts. It's a removal candidate: `file` and `shell` are the expansion points, and an honest `env` needs per-session client work (option D in [../inventory/sources.md](../inventory/sources.md)). If it stays, a renderer started for a session has that session's environment, but the main renderer still doesn't.

### Diagnostics

Gather's share crosses in `SessionFacts`. A renderer merges it through the pure `collectDiagnostics`, so its `⚠` shows Gather's faults. Load errors, questions, update notices and render warnings are the renderer's own. A failed scalar source doesn't reach the indicator today, and `SourceReading` would allow that.

The full survey is in [../inventory/sources.md](../inventory/sources.md).

## To survey

Not done. A future session should have a subagent list every request type the daemon answers and mark which goes to a renderer and which to Gather, replacing the state table in [../architecture.md](../architecture.md) where they differ.

## To probe

- **Forwarding hook data.** A renderer passing each request's hook data up to Gather as a fact is unbuilt, including what hints travel with it.
- **Render cost.** Time a real request through a renderer with Gather in another process, cold and warm, against the budget. Only a click has been measured across this seam: 0.5 ms median.
- **`declare` and `key`.** Designed from reading the code, never run. Prove it across all five cache policies.
- **Per-session cost.** Every built-in source always on across a realistic session count.
- **PR at scale.** Measure real `gh` cost and GitHub quota; the probe here was inconclusive.
- **`SessionFacts` volume.** How often facts move during an active turn, and the bytes per second to several renderers.

## Done when

A renderer given recorded `SessionFacts` draws identical bytes with no filesystem or process access, and two renderers sharing a declaration make one run, across every cache policy.

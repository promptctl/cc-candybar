# Render-path subprocess accounting

**Recorded:** 2026-05-27 23:23 MDT (2026-05-28T05:23Z)
**Daemon version at recording:** PROTOCOL_VERSION = 3
**Companion doc:** `docs/process-spawning-audit.md` (the May 2026 daemon-corpses incident)

## Question this answers

> Do we minimize external process calls in the render-every-time path? Are they accounted for?

Premise: the daemon may serve 50-100 render requests per second per session. Subprocess spawns at that rate would be catastrophic (each spawn is ~5-10ms on darwin). Per-render spawn count must be effectively zero in steady state.

## Answer: yes, accounted

### Single enforcer

Every subprocess spawn in the Node runtime flows through `src/proc/launch.ts`. There is no `child_process` import anywhere else in `src/`. This is enforced by convention (codified in the file's `[LAW:single-enforcer]` comments) and verifiable with `grep -r "child_process\|spawn\|exec(" src/`.

### Closed category list

`src/proc/launch.ts` exports `LAUNCH_CATEGORIES` as a `const` array. Every spawn site must declare its category. Adding a new category requires editing this file, which surfaces in code review.

Current categories (13):
- `git`, `user-shell`, `tmux` — render-related (cache-policy-driven)
- `forge` — the gh/glab PR lookup, network-bound, metered apart from `git`
- `click.pbcopy`, `click.open` — user-initiated (rate-limited at 1/sec each)
- `install.plutil`, `install.osacompile`, `install.lsregister`, `install.pbcopy`, `install.open` — install-time only
- `daemon-spawn` — bootstrap
- `process-fingerprint` — `ps -o lstart=` for socket-lease liveness, at daemon start and EADDRINUSE arbitration only

### renderDsl itself does not spawn

`src/dsl/render.ts:renderDsl` is pure CPU: reads from MobX store, evaluates pre-compiled templates, builds strip cells, assembles ANSI. It does not import `launch` and does not transitively call any subprocess-spawning code.

The render-hot-path call chain (daemon side, per request):
```
handleRequest (server.ts)
  └─ renderCache.getOrCreate(...)        — cache HIT in steady state, no work
  └─ buildRenderPayload(...)             — reads provider snapshots, no spawn
  └─ renderDsl(...)                  — pure CPU
  └─ diagnosticDump.sync(...)            — the one synchronous fs write, taken only when the diagnostic text changed
  └─ composeWithDiagnostics(...)         — string assembly
```

### Where subprocess work actually happens

Spawns originate from cache-policy callbacks registered against the MobX store at config-load time:

| Source kind | Cache trigger | When it spawns |
|---|---|---|
| `kind: "shell"` | `ttl` | TTL timer fires (interval-driven; clamped to ≥500ms by `MIN_SHELL_TTL_MS`) |
| `kind: "shell"` | `watch_file` | fs.watch event on the named path |
| `kind: "shell"` | `depends_on` | MobX reaction: any listed var changes |
| `kind: "shell"` | `key` | MobX reaction: rendered key template changes |
| `kind: "shell"` | `never` | once, at declaration |
| `kind: "git"` | (same set) | same — `src/segments/git.ts` |
| `kind: "tmux"` | (provider-internal cache) | `src/segments/tmux.ts` provider TTL |

None of these run inside the render request lifecycle. They fire asynchronously on their own clocks/events and write into the store; the render request reads whatever value is already there.

### Metering

Every `launch()` call increments `stats.launchStats` (wired by `setLaunchStats(stats.launchStats)` in `src/daemon/server.ts`). Surfaced via:

```
cc-candybar daemon-stats
```

Output as of recording:
```
subprocesses
  total         27790
  inFlight      0
  lastMinute    126
  git           27790  (p50 6ms · p99 12ms)
```

126 spawns/min ≈ 2/sec. Against ~50-100 renders/sec that's roughly 25-50 render hits absorbed per spawn — the cache is doing its job.

### Rate limits

`src/proc/launch.ts:RATE_LIMITS` caps click verbs at 1 spawn/sec each. No other categories have per-spawn floors at the launch layer; `kind: "shell"` with `cache: { ttl: ... }` is clamped to 500ms inside the var-system (`MIN_SHELL_TTL_MS`).

## Known gaps (not regressions, just things the type system doesn't enforce)

1. **`types-are-the-program` only partial here.** The type system enforces "every spawn appears in metering" via the single enforcer. It does NOT statically guarantee "no spawn is reachable transitively from `renderDsl`." That invariant is enforced by architecture (the cache layer's existence + the render path's purity), not by a brand or phantom type. Strengthening this would require branding the render path as no-launch-reachable, which is expensive in TS for marginal gain given the architectural locality.

2. **`depends_on` and `key` cache policies have no per-spawn floor.** A user config with `kind: "shell", cache: { depends_on: ["cwd"] }` re-spawns whenever the `cwd` input changes between renders. The cache policy is the user's authoring choice; the system trusts it is sound. A misauthored config could drive 1 spawn per render if its dependency churns at render frequency. Mitigation today is the metering — daemon-stats surfaces the rate; future tightening could add a per-config-key spawn-rate guard.

3. **One enforcer per runtime, not per process tree.** The Rust client in `rust-client/src/launch.rs` is a parallel enforcer for the Rust binary. Two enforcers, one invariant. They cannot drift silently because the Rust client only spawns the daemon (one category) and the launch surfaces are unit-tested.

## How to verify (anytime)

```
# 1. Single enforcer
grep -rn "child_process\|spawn(\|exec(\|execSync\|execFile" src/ \
  | grep -v "// \|proc/launch.ts"
# Expected: empty.

# 2. Render hot path is pure
grep -n "launch\|child_process" src/dsl/render.ts
# Expected: empty.

# 3. Live spawn rate
cc-candybar daemon-stats | grep -A1 "lastMinute"
# Expected: well under (renders/sec × cache-hit-ratio × 60).
```

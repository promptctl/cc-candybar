# Process spawning audit

> **Point-in-time incident artifact.** This audit was recorded during the
> investigation of the May 2026 "452 daemon corpses" incident. It is a
> snapshot of what was found, not a living spec — file paths and concept
> names remain useful as orientation hints, but specific line numbers have
> been intentionally stripped because they would otherwise rot the moment
> the kz8.5 fixes (and any subsequent refactor) land. To pin the artifact
> to the exact tree it was written against, see the original audit commit
> in `git log -- docs/process-spawning-audit.md`. The structural findings
> (F1-F8) and the root-cause narrative are the load-bearing content; treat
> path-level references as starting points for a fresh `grep`, not as
> authoritative locators.

`★ Insight ─────────────────────────────────────`
This codebase has a deliberately small spawn surface: every subprocess in the
Node runtime flows through one boundary (`src/proc/launch.ts`), and every
subprocess in the Rust runtime flows through `rust-client/src/launch.rs`. The
total inventory of spawn sites is small (10 categories), each gated by a typed
`LaunchCategory`. That part is healthy. The pathology you're seeing is **not**
runaway spawning per render — it is the **daemon-singleton invariant
breaking** under a protocol-version mismatch, producing one orphaned Node
process per render tick that fails to actually exit on `process.exit(0)`.
`─────────────────────────────────────────────────`

## TL;DR — root cause of your "hundreds of node processes"

A live measurement at audit time:

```
$ ps aux | grep "node.*dist/index.mjs.*daemon" | wc -l
103

$ tail ~/.local/state/cc-candybar/daemon.log
… daemon up: pid=42882 v=3
… version mismatch: client=2 daemon=3; shutting down
… daemon up: pid=42885 v=3
… version mismatch: client=2 daemon=3; shutting down
… (repeating ~20 cycles / sec)
```

Two faults compounding:

1. **Stale Rust client binary**. `bin/cc-candybar` was built **May 11**, when
   the wire protocol was `PROTOCOL_VERSION = 2`. Commit `3d04efc` (kz8.4)
   bumped it to `3`. Every render from the stale Rust client sends `v=2`; the
   daemon (`src/daemon/server.ts`) treats mismatch as "binary upgrade,
   die so the next client respawns from current binary" and schedules
   `setTimeout(() => shutdown(0), 50)`.
2. **`shutdown()` does not actually terminate the process.** `process.exit(0)`
   in `src/daemon/server.ts` does not exit; the SIGKILL backstop on the
   prior line (`kill.unref()`) is rendered impotent by the `unref()` call —
   it cannot fire because nothing keeps the loop alive long enough to schedule
   it. Result: each "shut down" daemon stays alive as a sleeping Node process
   holding open the original `listen()` socket fd (visible in `lsof`).

Immediate user-level fix: `just install-rust` to rebuild the Rust binary
against `v=3`, then `pkill -9 -f "dist/index.mjs daemon"` to clear the
orphans. The structural fix is detailed in **Findings → F2** below.

---

## Spawn inventory — Node runtime

All Node-side spawns go through `src/proc/launch.ts`. This is enforced by
having `node:child_process` imported in exactly one source file (verified by
grep: `import.*from "node:child_process"` matches only `src/proc/launch.ts`
and the unrelated `scripts/release.mjs`).

### The launch primitive — `src/proc/launch.ts`

| Function | Behavior | When to use |
|---|---|---|
| `launch(opts)` | async pipe stdio, capture stdout/stderr, optional timeout | Default — anything that produces output you need to read. |
| `launchSync(opts)` | sync via `spawnSync`, same shape as `launch` | Only when caller genuinely cannot be async (e.g. install path, sync click handlers in daemon). |
| `launchDetachedSync(opts)` | sync `spawn({detached:true, stdio:"ignore"})` + `unref()`, returns spawn-success-or-failure | Fire-and-forget daemon kicks. The synchronous typed return distinguishes "ENOENT" from "spawned" — replaces an earlier `void launch({detached:true})` form that discarded failure. |

`LAUNCH_CATEGORIES` (closed list, `src/proc/launch.ts`):

```
git, user-shell, tmux,
click.pbcopy, click.open,
install.plutil, install.osacompile, install.lsregister, install.pbcopy, install.open,
daemon-spawn
```

Every launch site must declare its category; the metering layer in
`src/daemon/stats.ts` reads it off the request, not off the call site
(`[LAW:dataflow-not-control-flow]`). Adding a new spawn site requires adding
a new category here — that forces code review of the pattern.

### Node spawn call sites

| Site | Category | Sync/Async | Detached? | Notes |
|---|---|---|---|---|
| `src/segments/git.ts` (`execGitAsync`) | `git` | async | no | Single helper used by every `git` segment query — branch, status, sha, tag, stash, upstream, repo-name, ahead/behind, fallback-branch, rev-list. Per-call timeout is 2000ms (but see **F4**). |
| `src/segments/tmux.ts` (`getSessionId`) | `tmux` | async | no | `tmux display-message -p '#S'`. Skipped when `TMUX_PANE` is unset. 1000ms timeout. |
| `src/var-system/sources.ts` (`execShell`) | `user-shell` | async | no | `/bin/sh -c <user-command>` for `declareShell` variables. **No timeout.** Currently unused at runtime (see **F6**). |
| `src/daemon/server.ts` (`clickCopy`) | `click.pbcopy` | sync | no | Click verb `copy`: `/usr/bin/pbcopy <stdin>`. |
| `src/daemon/server.ts` (`clickOpenVscode`) | `click.open` | sync | no | Click verb `open-vscode`: `/usr/bin/open -a "Visual Studio Code" <path>`. |
| `src/install/index.ts` | `install.osacompile` | sync | no | `osacompile` builds the URL-handler `.app`. One-shot during `cc-candybar install`. |
| `src/install/index.ts` | `install.plutil` | sync | no | `plutil -remove <key>` (pre-clear). |
| `src/install/index.ts` | `install.plutil` | sync | no | `plutil -insert <key> -xml <xml>` (per Info.plist key). |
| `src/install/index.ts` | `install.lsregister` | sync | no | `lsregister -f <bundle>` to register `cc-candybar://`. |
| `src/install/index.ts` | `install.pbcopy` | sync | no | URL-handler-side `copy` verb (daemon-down fallback). |
| `src/install/index.ts` | `install.open` | sync | no | URL-handler-side `open-vscode` verb (daemon-down fallback). |
| `src/daemon/acquire.ts` (`spawnDaemonDetachedReal`) | `daemon-spawn` | sync | **yes** | The one place a daemon process is born. `node --max-old-space-size=400 <script> daemon`, `detached:true`, `stdio:"ignore"`. |

### Daemon-launch script (`src/daemon/acquire.ts`)

This module owns the "obtain a daemon" verb. Three previously-independent
spawn sites (CLI render-miss, install path, Rust-client fallback) collapse
onto one path. Two surfaces:

| Function | Use | Behavior |
|---|---|---|
| `obtainDaemon(opts)` (async) | Caller wants a daemon **now**, will wait | Tries connect → tries spawn-lock → spawns + polls socket until `spawnReadyTimeoutMs` (1500ms) or until total `totalTimeoutMs` (2000ms). Returns `{kind: "attached" | "started" | "failed"}`. |
| `obtainDaemonKick()` (sync) | Fire-and-forget; we already lost this render | Tries spawn-lock once, spawns once, exits. Must be sync because `src/index.ts` and `src/install/index.ts` call it immediately before `process.exit()` — an async variant would never resume. |

The **spawn lock** (`$XDG_STATE_HOME/cc-candybar/spawn.lock`) is an
existence-as-lock file: `open(O_CREAT | O_EXCL)`. Held only for the spawn
window (typically <10ms for `kick`; up to `spawnReadyTimeoutMs` for the wait
path). Staleness reclaim at 10s. **Crucially, this is an optimization, not
the singleton invariant**: the kernel's atomic `bind(socketPath)` is the load-
bearing exclusion (`src/daemon/server.ts`).

### Daemon-side timers (not spawns, but adjacent)

These are timers that can drive subprocess work over time:

| Site | Cadence | What it does |
|---|---|---|
| `src/daemon/server.ts:armBinaryWatch` (`BIN_CHECK_INTERVAL_MS = 60s`) | every 60s | `statSync` the daemon binary; if mtime changed → `shutdown(0)`. No spawn directly; but a rebuild that changes the bundle triggers the dies-and-respawns cycle. |
| `src/daemon/limits.ts:arm` (`DEFAULT_CHECK_INTERVAL = 60s`) | every 60s | Sample RSS; if > 512MB (default; override via `CC_CANDYBAR_RSS_LIMIT_MB`) → heap snapshot + `shutdown(0)`. |
| `src/daemon/cache/git.ts:runSanityCheck` (`SANITY_INTERVAL_MS = 5min`) | every 5min | mtime walk of cached `gitDir`s; invalidates entries where the watcher missed a change. Drives a refresh that may spawn `git` per active subscriber. |
| `src/var-system/sources.ts` (TTL bucket) | per-bucket | One `setInterval` per unique TTL duration, shared across variables. Drives `declareShell` / `declareTime` / `declareFile` refreshes. **No `unref()`** — see **F8**. |

---

## Spawn inventory — Rust runtime

Owned by `rust-client/src/launch.rs`. Two functions, by design (`[LAW:one-type-per-behavior]`):

| Function | Behavior | When |
|---|---|---|
| `exec_node_replace(script, args)` | `execvp(2)` — replaces the current process image with `node <script> <args>` | Any subcommand in `SUBCOMMANDS` (`install`, `install-url-handler`, `url-handle`, `daemon`, `daemon-stats`) or `--help`. Not on the render hot path. |
| `spawn_node_detached_daemon(script)` | `fork(2)` + `setsid(2)` detached child running `node --max-old-space-size=400 <script> daemon`, fds 0/1/2 routed to `/dev/null`. Returns spawn-success bool. | Render-miss → `obtain_daemon_kick()` → here. |

The Rust client itself is invoked **once per Claude Code statusline tick** by
the `statusLine.command` in `~/.claude/settings.json`. It is short-lived and
single-frame: connect, send hook JSON, print response, exit. No daemon
mode, no event loop, no subprocess fan-out beyond the daemon kick.

The Rust binary mirrors the Node `obtainDaemonKick` exactly: same spawn-lock
file, same existence-as-lock semantics, same fallback to "let `bind()` in the
daemon arbitrate duplicates." A Rust kick and a Node kick are
mutually-recognizable.

---

## Per-render process fan-out — what does one statusline refresh actually spawn?

### Happy path (Rust client, warm daemon, render-cache hit)

1. Claude Code invokes `bin/cc-candybar` → **1 Rust process** (short, ~5ms).
2. Rust opens unix socket, sends framed JSON, reads framed JSON, prints, exits.
3. **0 daemon-side subprocesses** (everything from in-memory caches).

Total: 1 process per tick.

### Render-cache miss, git-cache hit

Same as above; daemon serves from `GitDataProvider`'s cached snapshot. Still 1 process.

### Render-cache miss, git-cache cold

1. Rust client (1 process).
2. Daemon receives request → `GitDataProvider.doFetch` per repo → `GitService.computeGitInfo` runs **N concurrent `git`** subprocesses depending on enabled segment options. With current defaults (`--show git=workingTree,upstream,timeSinceCommit`), the per-cold-fetch fan-out is roughly:
   - `git status --porcelain -b` (always)
   - `git rev-list --count @{u}..HEAD` + `git rev-list --count HEAD..@{u}` (parallel, for ahead/behind)
   - `git rev-parse --short=7 HEAD` (showSha, on the subscribe path)
   - `git describe --tags --abbrev=0` (showTag)
   - `git log -1 --format=%ct` (showTimeSinceCommit)
   - `git stash list` (showStashCount)
   - `git rev-parse --abbrev-ref @{u}` (showUpstream)
   - `git config --get remote.origin.url` (showRepoName, when enabled)

  That's **up to ~8 `git` subprocesses** for a fully-decorated cold render of one repo. **All have a 2000ms timeout**, but the daemon's per-request budget (`REQUEST_TIMEOUT_MS = 200ms`, `src/daemon/server.ts`) is much tighter — see **F4**.

3. If `tmux` segment is enabled and `TMUX_PANE` is set: 1 `tmux display-message` (1s timeout).

Total cold fan-out, fully-decorated: 1 Rust + ~8 `git` + ~1 `tmux` ≈ **10 processes for one tick**, then warm cache for ~30s (`DEFAULT_TTL_MS`).

### Daemon-miss path

1. Rust client (1 process).
2. Rust can't connect → `obtain_daemon_kick()` → `fork`+`setsid`+`exec node` (1 Node process, daemon).
3. Rust prints last-render stale frame (or `\n`), exits.
4. New daemon process loads modules (~50-100ms), binds socket, serves the **next** tick.

Total: 1 Rust + 1 Node daemon = 2 processes; subsequent ticks return to the happy path.

---

## Findings (ranked by current impact)

### F1 — **Critical / live.** Stale Rust client → version-mismatch spawn loop

**Where:** `bin/cc-candybar` (built May 11, protocol `v=2`) vs.
`src/daemon/protocol.ts` (current `PROTOCOL_VERSION = 3`, bumped in commit
`3d04efc`).

**Effect:** Every render sends `v=2`; daemon detects mismatch, schedules
`shutdown(0)` 50ms later, replies `VERSION_MISMATCH`. The next render
finds no daemon, spawns a new one. Loop at the natural Claude Code refresh
cadence × number of active sessions. Compounded by **F2**: the "shut down"
daemons don't actually terminate, they accumulate as sleeping processes.

**Fix:** `just install-rust` after every protocol bump. Verify with
`./bin/cc-candybar --help` (Node fallback prints help, ignore that; the wire
test is starting one render and checking `daemon.log` for absence of "version
mismatch"). Add `pnpm check:protocol` to a pre-commit hook so protocol
divergence is caught at the source.

### F2 — **Critical / structural.** `shutdown()` does not actually exit

**Where:** `src/daemon/server.ts`.

```ts
function shutdown(code: number): void {
  // … close handles …
  const kill = setTimeout(() => process.kill(process.pid, "SIGKILL"), 500);
  kill.unref();
  process.exit(code);
}
```

**Effect:** When `process.exit(code)` fails to terminate (the comment in the
file documents that this has been observed in `uv__io_poll`), the SIGKILL
backstop is supposed to catch it. But `kill.unref()` defeats the backstop
in the very case it was designed for: an unref'd timer cannot keep the loop
alive itself; if `process.exit` partially shuts down the loop, the timer
never fires. The listening unix socket (`server.listen` in
`bindOrAttachAndExit`) is never explicitly closed (`server.close()` is never
called in `shutdown()`), so each shut-down daemon stays alive holding fd 14
on the original socket inode (verified via `lsof -p <pid>`).

**Evidence:** 103 sleeping `node ... daemon` processes; oldest is 28+ minutes
old; each holds an `unix` fd on the (now-unlinked) socket path.

**Fix:**
1. Remove `.unref()` on the SIGKILL timer — it's a 500ms backstop, not a
   long-running handle; keeping it ref'd guarantees it fires.
2. Add `server.close()` before `process.exit()` so the listening fd is
   actually released and the event loop has a chance to drain naturally.
3. Consider replacing the backstop with `process.kill(process.pid, "SIGTERM")`
   first, then SIGKILL at 1000ms — gives signal handlers a clean cycle.

### F3 — **High / structural.** No idle / age shutdown; documentation drift

**Where:** `src/daemon/limits.ts` ("Only the RSS trigger remains — idle
and age limits were removed because they interrupted active sessions").

**Effect:** The daemon lives forever modulo a 512MB RSS hit. `CLAUDE.md`
still claims "Idle-shutdown after 30 min; hard limits in
`src/daemon/limits.ts` (200 MB RSS → heap snapshot then exit; 24 h age → exit)"
(`CLAUDE.md` "Daemon" section). All three numbers are wrong:

- Idle shutdown: removed.
- RSS: now 512MB, not 200MB.
- 24h age: removed.

When combined with **F2**, a daemon that ever fails to die from a normal
shutdown trigger sticks around indefinitely.

**Fix:** Either restore an idle shutdown (with a long enough idle window
that it cannot interrupt an active session — e.g. 4h since last render) or
update the docs. The structural argument for an idle shutdown is **F2**:
even a perfectly-functioning daemon will accumulate orphans if shutdown is
ever bypassed, and an idle limit puts an upper bound on the orphan count.

### F4 — **Medium / structural.** Per-request budget < per-subprocess timeout

**Where:** `src/daemon/server.ts` (`REQUEST_TIMEOUT_MS = 200ms`) vs.
`src/segments/git.ts` (per-`git`-call timeout `2000ms`).

**Effect:** When the daemon hits a cold git-cache for a slow repo (large
working tree, slow filesystem, NFS, etc.), the request budget fires first
and the client receives a timeout response. **The in-flight `git`
subprocesses keep running** to their own 2s timeout. Under heavy refresh
(e.g. the F1 spawn loop, or a tight tool-use sequence in Claude Code), this
can stack git subprocesses faster than they complete.

The `fetchInFlight` map in `GitDataProvider` (`src/daemon/cache/git.ts`)
coalesces concurrent misses **on the same cache key**, but two slightly
different cache keys (e.g. different `options` for different segments in the
same render) still each spawn their own fan-out. The dedupe is per-key, not
per-repo.

**Fix:** Tighten the per-`git`-call timeout to something closer to the
request budget (e.g. 500ms). On timeout, return the last cached value rather
than re-spawning. Consider repo-level (not key-level) coalescing for the
cold-fetch path — one `git status` per repo per cold window regardless of
which options the various callers asked for.

### F5 — **Medium / structural.** Backstop SIGKILL unref vs intent

Already covered in **F2** but worth calling out independently: the
`kill.unref()` pattern appears in `src/daemon/server.ts` and is wrong
for *every* `setTimeout` that is a backstop rather than a normal scheduled
work item. Audit other `setTimeout(...).unref()` call sites to confirm none
of them are similarly load-bearing.

### F6 — **Low / dead-code surface.** `SourceRegistry` shell-source is unwired

**Where:** `src/var-system/sources.ts` (`SourceRegistry` class with
`declareShell` / `declareFile` / `declareTime` / `declareGit`).

**Status:** Defined and unit-tested but **not currently consumed by the
daemon or any segment renderer** (grep for `new SourceRegistry` returns only
the package internals). When this is wired up — and it will be, given the
existing template-engine integration — the `declareShell` path will spawn
`/bin/sh -c <user-cmd>` per TTL tick with **no timeout** (`execShell` in
`sources.ts`). At the documented cadence (default `ttlMs: 1000` for
time-source, configurable for shell) and with no `inFlight` bound across
different variables, this is a future spawn-storm waiting to be enabled.

**Fix (preemptive):** Add a hard per-call timeout in `execShell`
(`launch({timeoutMs: 2000})`). Add a global semaphore across shell-source
refreshes so concurrent updates are bounded.

### F7 — **Low / sharp edge.** `pnpm dlx` in default install path

**Where:** `src/install/index.ts` (`buildStatusLineCommand`).

**Effect:** The default `cc-candybar install` writes
`pnpm dlx @promptctl/cc-candybar@<pinned> …` into `~/.claude/settings.json`.
Per-tick, this involves at minimum:

1. The shell parses the command.
2. `pnpm dlx` boots — a Node process to read `~/.local/share/pnpm/store` and
   resolve the cached package.
3. The resolved binary runs (Rust on platforms with a built binary, Node
   fallback otherwise).

For local dev users, `pnpm dlx` per tick is wasted Node startup — the
user's actual `~/.claude/settings.json` (verified) bypasses `pnpm dlx` and
runs `/Users/bmf/code/cc-candybar/bin/cc-candybar` directly. End-users on
`@latest` pay the `pnpm dlx` overhead on every tick. This is fine **only as
long as pnpm's cache resolves locally** — a stale cache or network blip
turns into an extra ~100-300ms per render.

**Recommendation:** Document the direct-binary-path option as the preferred
install for performance; reserve `pnpm dlx` for the first install where the
binary path isn't yet known. Or have `install` write the resolved path of
the just-installed binary directly into `settings.json`.

### F8 — **Low.** Several `setInterval`s not `unref()`'d in `var-system`

**Where:** `src/var-system/sources.ts` (TTL bucket), and possibly
others.

**Effect:** Currently unobservable because `SourceRegistry` isn't wired (**F6**).
When wired, the daemon process will not exit naturally if it has any
TTL-source variable, because at least one ref'd `setInterval` will keep the
event loop alive.

**Fix:** `.unref()` on the timer; rely on `dispose()` for explicit teardown.

---

## Defensive checklist

When changing anything that adds, removes, or modifies a spawn site:

- [ ] Does the call go through `src/proc/launch.ts` (Node) or
      `rust-client/src/launch.rs` (Rust)? If not, **stop and refactor first.**
- [ ] Did you add a new `LaunchCategory` if this is a new kind of work?
      `LAUNCH_CATEGORIES` is the closed list at `src/proc/launch.ts`.
- [ ] Did you pass a `timeoutMs`? If not, justify in a comment with a
      `[LAW:no-silent-fallbacks]` exception marker.
- [ ] If detached: are you using `launchDetachedSync` (typed return) and not
      `void launch({detached:true})` (discards spawn outcome)?
- [ ] If the new call is on the render hot path: have you measured the
      per-render fan-out and confirmed it stays below ~10 processes?
- [ ] If you bumped the wire protocol: `pnpm check:protocol` passes, and you
      ran `just install-rust` to rebuild `bin/cc-candybar` from the new
      version. (See **F1**.)

---

## Quick verification commands

```bash
# How many daemons are alive right now?
ps -ax | grep -c "node.*dist/index\.mjs.*daemon"

# Are they all stale (status Ss, no work)? Or actively serving?
ps -axo pid,stat,etime,command | grep "dist/index\.mjs.*daemon" | head

# What's the daemon log saying?
tail -100 ~/.local/state/cc-candybar/daemon.log

# Who currently owns the socket?
lsof ~/.local/state/cc-candybar/socket 2>/dev/null

# What does the pidfile claim (diagnostic only — see paths.ts comment)?
cat ~/.local/state/cc-candybar/pid

# Are stale Rust clients at an old protocol version?
file bin/cc-candybar
stat bin/cc-candybar          # compare mtime to git log of src/daemon/protocol.ts
grep PROTOCOL_VERSION src/daemon/protocol.ts rust-client/src/main.rs

# Clear orphans and start fresh (after fixing F1):
pkill -9 -f "dist/index\.mjs.*daemon"
rm -f ~/.local/state/cc-candybar/socket ~/.local/state/cc-candybar/spawn.lock
```

## File-by-file index of every `child_process` import (Node) and `Command::new` (Rust)

```
src/proc/launch.ts              import { spawn, spawnSync } from "node:child_process";
scripts/release.mjs              import { execFileSync } from "node:child_process";  (build script, not runtime)
rust-client/src/launch.rs       use std::process::{Command, Stdio};
```

Three. Anywhere else in the repo that needs to start a subprocess is
required to go through one of those two boundary files. That invariant is the
load-bearing reason the spawn inventory above is exhaustive.

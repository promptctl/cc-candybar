# Candidates — the performance substrate

Stage-one survey of projects whose reason to exist is making a repeated computation cheap enough to run every prompt / tick / keystroke. Every star, commit and push date below came from `gh api` on 2026-09-10; nothing is from memory. Ordered most interesting to cc-candybar first, not most popular first.

## gitstatusd (romkatv/gitstatus)
- **URL:** https://github.com/romkatv/gitstatus
- **Stats:** C++ · 1,835 stars · 1,430 commits · last push 2026-09-06
- **What it is:** A long-lived daemon that answers "what is the state of this repo" for shell prompts, driven over a pipe with a NUL-delimited request/response protocol. It is the engine behind Powerlevel10k's git segment, but ships standalone with Bash and Zsh bindings.
- **Interesting because:** Its README benchmarks the same query at 30.9 ms hot for `git`, 1310 ms for libgit2's `git_diff_index_to_workdir`, and a fraction of that for gitstatusd, and then explains exactly where the win comes from — raw `getdents64` instead of readdir wrappers, an untracked-directory cache keyed on mtime so unchanged subtrees are never rescanned, and a thread pool across all cores. The client half is the other half of the lesson: `gitstatus_query -t <timeout>` takes a millisecond budget and returns "no answer yet" rather than blocking, so a slow repo degrades the git segment instead of the prompt.

## Watchman (facebook/watchman)
- **URL:** https://github.com/facebook/watchman
- **Stats:** C++ · 13,700 stars · 14,111 commits · last push 2026-09-10
- **What it is:** A file-watching service that watches whole trees on behalf of many client processes, exposed over a socket with a JSON/BSER protocol, and used as the fsmonitor backend for Git, Mercurial, Sapling and jj.
- **Interesting because:** The **clockspec + `since` query** is the mechanism: a client hands back the opaque clock token from its last query and gets only what changed since, which turns "what happened while my daemon was dead" into one round trip rather than a cold rescan — precisely cc-candybar's cold-start problem, where every cache is rebuilt from zero on restart. It also models the honest failure: when the OS drops events Watchman declares a **recrawl** and tells clients their clock is no longer trustworthy, instead of silently serving stale state.

## Vector (vectordotdev/vector)
- **URL:** https://github.com/vectordotdev/vector
- **Stats:** Rust · 22,538 stars · 14,198 commits · last push 2026-09-11
- **What it is:** An observability data pipeline whose `file` source tails thousands of append-only log files concurrently and ships only the bytes that arrived since last read.
- **Interesting because:** Its file identity is a **CRC fingerprint over the first N bytes of the file, not the inode** — which survives inode reuse and rename-based rotation, both of which cc-candybar currently detects by inode change plus shrink-below-cursor. It also persists `(file id → byte offset)` checkpoints to disk with atomic temp-file-plus-rename, so a restart resumes the fold mid-file, and detects copytruncate rotation by noticing offset > size.

## Salsa (salsa-rs/salsa)
- **URL:** https://github.com/salsa-rs/salsa
- **Stats:** Rust · 2,959 stars · 2,360 commits · last push 2026-09-07
- **What it is:** The incremental-recomputation framework extracted from rust-analyzer: you declare inputs and pure tracked queries, and it rebuilds only the queries whose inputs actually moved.
- **Interesting because:** Two mechanisms that a MobX-backed variable store does not have. **Backdating** — if a query is re-executed and produces a value equal to last revision's, dependents are *not* invalidated, so a git index touch that yields the same branch name costs nothing downstream. And **durability levels**, where an input declared HIGH durability (a config file, a palette) lets whole dependency subtrees skip their validation walk entirely on a revision bump.

## gitoxide (GitoxideLabs/gitoxide)
- **URL:** https://github.com/GitoxideLabs/gitoxide
- **Stats:** Rust · 11,931 stars · 16,580 commits · last push 2026-09-10
- **What it is:** A pure-Rust implementation of Git — object database, index, refs, status — usable as the `gix` library or the `gix`/`ein` binaries, with no libgit2 and no `git` subprocess.
- **Interesting because:** `gix-status` and `gix-dir` implement the working-tree walk as an explicitly **parallel dirwalk** with pluggable thread counts, and the crate split lets you pay only for what you read — resolving HEAD and the current branch touches `gix-ref` and never opens the index at all, which is the 90% case for a status bar. The repo publishes per-crate benchmarks and a documented performance section rather than a slogan.

## Powerline (powerline/powerline)
- **URL:** https://github.com/powerline/powerline
- **Stats:** Python · 14,813 stars · 2,867 commits · last push 2026-03-11
- **What it is:** The original segment-based statusline framework, rendering prompts and bars from a JSON-configured segment tree. Its architecture is cc-candybar's closest ancestor: a Python renderer that is too slow to start per repaint, fronted by `powerline-daemon` on a unix socket with a tiny compiled C client (`client/powerline.c`).
- **Interesting because:** `ThreadedSegment` / `KwThreadedSegment` is the pattern worth stealing — a segment declares an `interval`, its expensive `update()` runs on a background thread on that cadence, and `render()` returns the **last computed value immediately**, so no segment can ever block a repaint. That is a per-segment refresh budget expressed as data in the config, which is a different shape from cc-candybar's per-source TTLs.

## @parcel/watcher (parcel-bundler/watcher)
- **URL:** https://github.com/parcel-bundler/watcher
- **Stats:** C++ · 838 stars · 201 commits · last push 2026-08-04
- **What it is:** A native Node file watcher with a C++ addon per platform — FSEvents on macOS, Watchman when installed, brute-force `fts`/`FindFirstFile` otherwise — written for bundlers that watch very large trees from Node.
- **Interesting because:** It exposes `writeSnapshot(dir, snapshotPath)` and `getEventsSince(dir, snapshotPath)`, so a process that was **not running** can ask what changed while it was down and reconcile without a rescan. For a Node daemon that already watches `.git/HEAD` and every candidate config path per render-cache entry, this is both a drop-in replacement for `fs.watch` and the missing answer to the restart-goes-cold problem. The README states the perf gap bluntly: FSEvents/Watchman return in milliseconds where the brute-force backends take seconds on large trees.

## sccache (mozilla/sccache)
- **URL:** https://github.com/mozilla/sccache
- **Stats:** Rust · 7,668 stars · 2,379 commits · last push 2026-09-10
- **What it is:** A compiler cache that wraps `cc`/`rustc` invocations. Every invocation is a thin client process that talks to a long-lived local server over a unix socket (named pipe on Windows) holding the in-memory index and the storage backends.
- **Interesting because:** This is the exact client-daemon contract cc-candybar implements, done by a project that has debugged it for a decade: the client probes for the server, **starts it itself on a miss and then retries the connect** rather than failing the invocation, and the server shuts itself down after `SCCACHE_IDLE_TIMEOUT` (default 600 s) so a stale build of the server cannot linger forever. Worth reading for the startup race handling and `sccache --stop-server`/`--show-stats` as the operational seam.

## direnv (direnv/direnv)
- **URL:** https://github.com/direnv/direnv
- **Stats:** Go · 15,434 stars · 1,315 commits · last push 2026-03-31
- **What it is:** A shell hook that loads and unloads environment variables per directory by evaluating an `.envrc`, running on **every prompt** in every shell.
- **Interesting because:** The **watch list**. Evaluating an `.envrc` records every file it read (via `watch_file`, and automatically for the `.envrc` itself and any `source_env` target) as a path+mtime list, base64-encoded into `DIRENV_WATCHES`; the per-prompt hook only compares that list and re-evaluates when one entry actually moved. That turns "when do I re-run this shell source" from a TTL guess into a dependency fact, which is directly transplantable to cc-candybar's `shell:` and `file:` variable sources.

## Sapling / EdenFS (facebook/sapling)
- **URL:** https://github.com/facebook/sapling
- **Stats:** Rust · 7,010 stars · 108,349 commits (monorepo import) · last push 2026-09-10
- **What it is:** Meta's source control system plus EdenFS, a virtual filesystem that serves a repo's working copy lazily so operations scale with the number of files a developer touched, not the repo's size.
- **Interesting because:** The **Journal** — EdenFS records recent modifying filesystem I/O in an in-process log and exposes `getFilesChangedSince()`, which is what Watchman calls to answer subscriptions and what makes `sl status` O(changed files) instead of O(total files). The docs under `eden/fs/docs/` (Overview.md, Glossary.md, Process_State.md) are an unusually complete written account of how a long-lived FS-state daemon keeps its state coherent.

## bash-cache (dimo414/bash-cache)
- **URL:** https://github.com/dimo414/bash-cache
- **Stats:** Shell · 88 stars · 84 commits · last push 2023-01-05 — low star count and dormant, included for the mechanism
- **What it is:** A transparent memoization layer for Bash functions, written specifically for functions invoked from a prompt. `bc::cache FUNCTION TTL REFRESH [ENV_VARS...]` rewrites the function in place so callers are unchanged.
- **Interesting because:** It separates **TTL from refresh deadline**, which most caches conflate. Past the refresh deadline the cached value is still returned immediately and an asynchronous update is kicked off; only past the TTL is the entry evicted. The README's recommended prompt setting is `1m` TTL with `10s` refresh — a written, defensible stale-while-revalidate budget for a bar, and the `ENV_VARS` argument makes the cache key explicitly include the environment the function actually reads.

## gitui / asyncgit (gitui-org/gitui)
- **URL:** https://github.com/gitui-org/gitui
- **Stats:** Rust · 22,477 stars · 2,630 commits · last push 2026-08-04
- **What it is:** A terminal Git UI built on libgit2, whose whole git layer is factored into a separate `asyncgit` crate that runs every status/diff/blame/log call off the UI thread and notifies via a crossbeam channel.
- **Interesting because:** Read `asyncgit/src/status.rs`. `AsyncStatus` hashes `(params, generation)` into a request key, **returns the previous result and drops the request entirely if one is already in flight** (`is_pending()` → `Ok(None)`), keeps `last` as the always-renderable value, and bumps a `generation` counter to force a real refetch. That is request coalescing, last-known-good rendering, and repaint suppression in about eighty lines — the shape cc-candybar wants around every `gh`/`glab` shell-out.

## Jujutsu (jj-vcs/jj)
- **URL:** https://github.com/jj-vcs/jj
- **Stats:** Rust · 31,506 stars · 11,699 commits · last push 2026-09-10
- **What it is:** A Git-compatible VCS that snapshots the working copy automatically before every command, which makes "detect what changed in the working tree" a cost paid constantly rather than occasionally.
- **Interesting because:** Because it snapshots so often, it built a real fsmonitor abstraction (`lib/src/fsmonitor.rs`) with a Watchman backend, plus `fsmonitor.watchman.register-snapshot-trigger` — an option that registers a Watchman **trigger** so the watcher pushes rather than jj polling, and `jj debug watchman` as a first-class way to inspect what the watcher believes. It is the cleanest small example of making the file-watching backend a swappable, debuggable seam rather than a hardcoded `fs.watch` call.

## notify (notify-rs/notify)
- **URL:** https://github.com/notify-rs/notify
- **Stats:** Rust · 3,451 stars · 1,087 commits · last push 2026-09-08
- **What it is:** The Rust cross-platform filesystem notification library (inotify / FSEvents / kqueue / ReadDirectoryChangesW) underneath watchexec, cargo-watch and much of the Rust tooling ecosystem.
- **Interesting because:** It ships an explicit **`PollWatcher` fallback with a configurable interval and optional content hashing**, selected by `RecommendedWatcher` when the OS watcher is unavailable — the network-filesystem and watch-limit cases where `fs.watch` silently does nothing. The companion `notify-debouncer-full` crate is the other half: it coalesces bursts and **correlates rename-from/rename-to pairs into single events**, which is the exact noise a `.git/index` rewrite produces.

## jemalloc (jemalloc/jemalloc)
- **URL:** https://github.com/jemalloc/jemalloc
- **Stats:** C · 11,096 stars · 3,838 commits · last push 2026-09-10
- **What it is:** A general-purpose malloc implementation built for long-running multithreaded servers, with per-arena statistics and explicit control over when freed pages go back to the OS.
- **Interesting because:** It names and gives knobs for the exact symptom cc-candybar has — resident memory far above live heap in a long-lived process. `dirty_decay_ms` / `muzzy_decay_ms` control how aggressively dirty pages are purged back to the kernel (a nonzero default is why RSS plateaus above the true working set), `background_thread:true` does that purging off the hot path, and `mallctl`/`malloc_stats_print` expose per-arena retained-vs-allocated bytes so the gap can be *measured* rather than guessed at from a heap snapshot. Relevant even for a Node daemon, which can be run against it via `LD_PRELOAD`/`DYLD_INSERT_LIBRARIES`. (mimalloc, https://github.com/microsoft/mimalloc — C · 13,361 stars · 4,402 commits · last push 2026-09-10 — is the direct alternative, with `mi_option_purge_delay` and `mi_collect()` as its equivalents.)

## libgit2 (libgit2/libgit2)
- **URL:** https://github.com/libgit2/libgit2
- **Stats:** C · 10,589 stars · 16,450 commits · last push 2026-08-15
- **What it is:** The portable C reimplementation of Git core methods as a linkable library, with bindings in nearly every language including Node (`nodegit`, `@napi-rs/simple-git`) — the mainstream way to stop spawning `git` subprocesses.
- **Interesting because:** It is the realistic in-process option for a Node daemon, *and* the documented cautionary tale: gitstatusd's benchmark measures `git_diff_index_to_workdir` as the slowest of the three implementations tested, so adopting it is a real decision with a real number attached rather than an obvious win. The parts most worth lifting are the cheap ones — `git_repository_head`, the ref and index readers, and `GIT_OPT_SET_CACHE_MAX_SIZE` / `git_libgit2_opts` for bounding a daemon's object cache.

## ghx (brunoborges/ghx)
- **URL:** https://github.com/brunoborges/ghx
- **Stats:** Go · 107 stars · 108 commits · last push 2026-09-04 — young and small, included because the problem is identical
- **What it is:** A caching proxy for the GitHub CLI. `ghx` is a thin client that resolves repo/branch/auth context and forwards to a `ghxd` daemon over a unix socket, which caches GitHub API responses so repeated `gh` calls are instant and do not burn rate limit.
- **Interesting because:** cc-candybar shells out to `gh`/`glab` for PR lookups and carries its own `PR_TTL_OK_MS`/`PR_TTL_FAIL_MS` cache to survive it; ghx is the same cache, one layer lower and reusable, keyed on the resolved repo+branch+auth context rather than on the command string. Worth reading for its cache-key derivation and for whether the right answer is to delegate the whole forge lookup to it.

## sysinfo (GuillaumeGomez/sysinfo)
- **URL:** https://github.com/GuillaumeGomez/sysinfo
- **Stats:** Rust · 2,740 stars · 3,014 commits · last push 2026-09-10
- **What it is:** The cross-platform Rust crate for process, memory, CPU, disk and network statistics — the one every Rust system monitor is built on, with no `lsof`/`ps` shell-outs anywhere.
- **Interesting because:** `RefreshKind` and `ProcessRefreshKind` make **what you pay for an explicit argument**: refreshing only `memory()` for one known PID skips the whole process-table walk that a naive `System::new_all()` does every tick. For cc-candybar this is both the way to poll the parent-death watchdog and the RSS backstop without spawning anything, and a design pattern — the refresh request is data describing the fields the caller will read, so an unread field costs nothing.

## Scalar (microsoft/scalar)
- **URL:** https://github.com/microsoft/scalar
- **Stats:** C# · 1,527 stars · 2,933 commits · last push 2026-08-28 — largely superseded, its features now live in core `git`
- **What it is:** Microsoft's tooling for running very large monorepos on stock Git without a virtualization layer — the successor to GVFS, and the origin of several features since upstreamed into `git` itself (`scalar` ships in Git today).
- **Interesting because:** Its thesis is that the way to make a foreground command fast is to **move the work to a background schedule**: `scalar register` turns on fsmonitor, the commit-graph, the multi-pack-index and sparse-checkout cone mode, then installs a recurring `git maintenance` job that prefetches and repacks so `git status` never pays for it. The transplantable idea is a daemon that warms its own caches on a cadence, instead of only ever populating them on a render miss.

## zsh-bench (romkatv/zsh-bench)
- **URL:** https://github.com/romkatv/zsh-bench
- **Stats:** Shell · 1,032 stars · 228 commits · last push 2026-04-27
- **What it is:** A benchmark harness for interactive shell latency, from the author of gitstatusd. It drives a real interactive shell through a pty and measures what a human actually waits on.
- **Interesting because:** It defines the **latency vocabulary a status bar is missing** — `first_prompt_lag_ms`, `first_command_lag_ms`, `input_lag_ms`, `command_lag_ms` — and publishes a comparison table of real configurations against those numbers, including the finding that asynchronous prompt segments trade `first_prompt_lag` for correctness of the first frame. A bar that wants a defensible p50/p99 budget per render tick should copy this measurement shape rather than timing a synthetic in-process render.

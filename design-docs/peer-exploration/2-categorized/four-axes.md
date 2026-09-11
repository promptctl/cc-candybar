# Stage 2: the 44 candidates on four axes

Every project from stage 1, judged on four questions:

1. **Primitives** — does it contain a powerful primitive or concept?
2. **UX** — is its user experience especially good?
3. **Unique** — does it have a feature nothing else here has?
4. **Build** — polished or hacky?

Axes 1 to 3 are judgement calls read off the stage-1 surveys. Axis 4 is not: it comes
from signals measured against the GitHub API on 2026-09-11, listed for every project so
the verdict is checkable rather than a vibe.

## How Build was decided

| Verdict | Means |
|---|---|
| **Polished** | CI, releases, a licence, and either tests or many contributors. Someone maintains this on purpose. |
| **Solid** | CI and releases, with a gap: no tests, few contributors, or a licence question. |
| **Rough** | Thin history or missing CI, but the code is structured and released. |
| **Hacky** | No CI, no tests, few commits, one or two contributors. Fine to read, not to depend on. |

Dormancy is stated separately, because a finished small tool and an abandoned one look
alike in a commit graph.

## Licence risk

Checked because permissive-only is a standing constraint here. This matters for
vendoring or porting code, not for reading ideas.

| Project | Licence | Note |
|---|---|---|
| gitstatusd | GPL-3.0 | Copyleft. Read the technique, do not lift the code. |
| bash-cache | GPL-3.0 | Copyleft. |
| Sapling / EdenFS | GPL-2.0 | Copyleft. |
| Vector | MPL-2.0 | Weak copyleft, file-level. Usable with care. |
| **CCometixLine** | **none** | No licence file at all, so default is all rights reserved. |
| notify | none detected | Actually dual MIT/Apache upstream; GitHub fails to detect it. Verify before use. |
| ccusage, claudia-statusline, Powerline, jemalloc, libgit2 | NOASSERTION | GitHub could not classify. Read the file before depending on it. |

Everything else is MIT, Apache-2.0, BSD-3-Clause, or GPL-free.

---

# Claude Code statuslines

## Scan table

| Project | Primitives | UX | Unique | Build |
|---|---|---|---|---|
| claude-powerline | strong | strong | yes | Polished |
| ccstatusline | strong | strong | yes | Polished |
| claude-code-usage-bar | strong | — | yes | Polished |
| Yet Another Statusline (YAS!) | strong | — | yes | Solid |
| claudia-statusline | strong | — | yes | Solid |
| coralline | yes | strong | yes | Solid |
| claude-statusline (TheoBrigitte) | strong | — | yes | Rough |
| claude-dashboard | strong | yes | yes | Solid |
| Claude HUD | strong | yes | yes | Polished |
| cship | yes | strong | yes | Polished |
| claude-code-statusline (rz1989s) | strong | poor | yes | Polished |
| claude-statusline-powerline | yes | strong | — | Rough |
| Token Tracker (tt) | yes | strong | yes | Solid |
| claude-code-statusline (kcchien) | strong | — | — | Hacky |
| claude-carbon | yes | yes | yes | Solid |
| arcade-statusline | yes | — | yes | Rough |
| claude-code-tamagotchi | strong | — | yes | Hacky, dormant |
| claude-statusline (m5d215, jq-jit) | — | — | yes | Hacky |
| claude-pace | yes | — | yes | Solid |
| which-claude-code | yes | — | yes | Hacky |
| claude-statusline (ersinkoc) | yes | strong | — | Rough |
| ccusage | yes | — | yes | Polished |
| cc-statusline (chongdashu) | yes | yes | yes | Solid, stale |
| CCometixLine | — | yes | yes | Solid, unlicensed |

## Detail

### claude-powerline
- **Primitives:** A CSS-Grid layout engine for a terminal bar: breakpoints, fractional units (`1fr`, `2fr`), column spanning, and dot-notation addressing of *sub*segments (`context.bar`), with automatic culling of empty segments **and their orphaned dividers**. This is the strongest layout primitive in the niche and the only one that treats a divider as dependent on its neighbours.
- **UX:** A hosted visual configurator that exports the JSON, so discovery is a page you click rather than docs you read.
- **Unique:** A cache-timer segment that auto-detects whether the prompt cache window is the five-minute or one-hour variant, rather than asking the user.
- **Build:** Polished. 411 commits, 132 releases, 17 contributors, CI, tests, MIT.

### ccstatusline
- **Primitives:** One shared JSONL stream feeding every transcript-backed metric instead of one scan per widget. A git cache keyed on `.git/HEAD` and `.git/index` mtimes, plus `--no-optional-locks` on every git call to dodge `index.lock` races.
- **UX:** The best config experience in the territory: a React/Ink terminal app with live preview, fuzzy and initialism widget search, and a colour editor spanning 16, 256 and truecolor.
- **Unique:** Sixty-plus widgets, unlimited lines, and gradients applied per widget or across a whole line.
- **Build:** Polished. 378 commits, 95 contributors, 14 releases, CI, MIT. No test directory, which is the one gap.

### claude-code-usage-bar
- **Primitives:** Three, all directly comparable to cc-candybar's: transcript reads that reuse the unchanged snapshot and parse only appended bytes with a bounded rebuild after replacement; a git cache shared per worktree with single-refresh serialization; two persistent render workers behind bounded background queues.
- **UX:** A plain `cs config set` CLI. Functional, unremarkable.
- **Unique:** A five-minute account-scoped cache over Anthropic's undocumented OAuth usage endpoint, and a client that is a file read with a five-second staleness fallback that re-spawns the daemon lazily.
- **Build:** Polished. 391 commits, 91 releases, CI, tests, docs, MIT.

### Yet Another Statusline (YAS!)
- **Primitives:** A `UserPromptSubmit` hook writes per-session prompt timestamps, so subagent rows are turn-scoped instead of guessed from a time window. Separately, a config precedence rule where specificity outranks the source chain: a per-model limit beats the global value from *any* source.
- **UX:** —
- **Unique:** Four glyph modes plus a `single_width` knob that folds double-width CJK and emoji, so column geometry survives a change in glyph fidelity. Nothing else here treats width as a property the user can flatten.
- **Build:** Solid. 598 commits, 11 contributors, CI, tests, BSD-3-Clause. Only 4 releases.

### claudia-statusline
- **Primitives:** Compaction is detected from the `PreCompact` and `SessionStart[compact]` hook *events* rather than inferred from token counts. Token rates use different window lengths for input and output, so the number is responsive without being noisy.
- **UX:** —
- **Unique:** It renders a spinner during compaction instead of a stale percentage, and persists per-session stats to SQLite in a way designed for several concurrent instances.
- **Build:** Solid. 217 commits, 39 releases, CI, tests, docs. Licence is unclassified and needs a read.

### coralline
- **Primitives:** Its bootstrap resolves a mutable ref to a commit SHA before downloading executable code, which is supply-chain hygiene most installers here skip.
- **UX:** The most interesting UX idea in the territory and the one worth arguing about: installation is a playbook you paste into Claude Code, so the agent routes by environment and asks before changing your preferences. Configuration by LLM as the primary interface.
- **Unique:** Cache thresholds that are *inverted* (yellow at 50%, red at 25%, `cold` once expired), and it states plainly that the countdown is the value at last render rather than a live clock.
- **Build:** Solid. 227 commits, 11 contributors, 27 releases, CI, tests, MIT.

### claude-statusline (TheoBrigitte)
- **Primitives:** The closest thing here to a real template language: free-form line templates into which modules are placed as `$token` placeholders, each module carrying its own `{value}`/`{symbol}` format. Visibility is a **width predicate** (`min_term_width`/`max_term_width`) rather than a boolean toggle.
- **UX:** —
- **Unique:** Terminal width is read from `/dev/tty`, so it still works when stdin is a pipe. Publishes a sub-millisecond render benchmark.
- **Build:** Rough. 27 commits and 8 stars, but with CI, tests and MIT. Punches far above its weight.

### claude-dashboard
- **Primitives:** Widgets decompose into addressable sub-widgets, so a user recomposes the same data at a different granularity without anyone writing a new widget.
- **UX:** Three display modes from one line to six.
- **Unique:** It auto-detects and folds in usage for Codex, Gemini, Antigravity and z.ai, hiding each widget when that tool is absent. It also documents a widget that went permanently null when Anthropic merged a rate-limit bucket, which is honest in a way this genre usually is not.
- **Build:** Solid. 459 commits, 51 releases, CI, MIT. No tests.

### Claude HUD
- **Primitives:** It reconstructs in-flight state the hook payload does not carry by reading the transcript alongside it: which tool is running on which file, which subagent is active with its model and elapsed time, and todo progress.
- **UX:** Distributes as a plugin with a setup command that writes the `statusLine` block, because plugins cannot contribute one directly.
- **Unique:** Live tool-activity, subagent and todo rows.
- **Build:** Polished. 771 commits, 106 contributors, 18 releases, CI, tests, MIT.

### cship
- **Primitives:** Threshold pairs as data rather than a colour branch: every module takes warn and critical thresholds each with its own style.
- **UX:** Configured exactly like Starship, so anyone who already knows Starship has nothing to learn.
- **Unique:** Starship module *passthrough*. Format strings mix native tokens with `$git_branch` and `$python`, which makes another tool's whole module ecosystem available inside a Claude Code bar. Nothing else here borrows an ecosystem instead of rebuilding one.
- **Build:** Polished. 336 commits, 14 contributors, CI, tests, docs, Apache-2.0.

### claude-code-statusline (rz1989s)
- **Primitives:** Caching tiered by data volatility inside one scheme, from session-lifetime for binary probes through seconds for git, minutes for server lists and hours for versions, with SHA-256 integrity validation and explicit multi-instance race protection.
- **UX:** Poor, and instructively so. One TOML file with 227 settings is the opposite of discoverable, and it is the clearest argument in this list for a settings surface over a config file.
- **Unique:** Monitors MCP server health, and ships prayer times, which is the existence proof that a segment can be an arbitrary networked widget with an offline fallback chain.
- **Build:** Polished. 918 commits, 76 releases, CI, tests, docs, MIT. Shell, but seriously maintained shell.

### claude-statusline-powerline
- **Primitives:** The separator glyph is an independent axis with nine named styles, orthogonal to the colour theme.
- **UX:** It publishes a JSON Schema for its config, so the editor supplies autocomplete, validation and hover docs while you type. Configuration discoverability through the editor instead of a TUI, which is cheap and underused.
- **Unique:** —
- **Build:** Rough. 140 commits but no CI, no tests, 2 contributors.

### Token Tracker (tt)
- **Primitives:** Where a host exposes no statusline API it injects a pseudo-statusline through a hook, manufacturing the surface the host declines to provide.
- **UX:** A narrow always-on sidebar listing every active session with a status light and its latest prompt, where clicking a session jumps to its iTerm2 or tmux pane.
- **Unique:** One theme setting colours the CLI reports and every agent's statusline from a single source.
- **Build:** Solid. 384 commits, CI, tests, MIT.

### claude-code-statusline (kcchien)
- **Primitives:** Two policies stated as rules rather than code paths. A three-tier rendering ladder from 24-bit gradient to ANSI 256 to ASCII, selected per terminal. And "smart hiding", where zero-valued facts disappear entirely while a zero cost stays but dims, and the context-window size renders only when the model name does not already imply it.
- **UX:** —
- **Unique:** —
- **Build:** Hacky. 7 commits, no CI, no tests. The ideas are better than the repository.

### claude-carbon
- **Primitives:** Derives a second unit from data everyone already has, mapping tokens to grams of CO₂ against a sourced factor table. Persists to SQLite specifically to survive the 30-day transcript purge, and backfills from existing transcripts on install.
- **UX:** Slash commands for a text report, a PNG card and the footprint of a pull request.
- **Unique:** The CO₂ segment, and a burn indicator that fires only after a fifteen-minute grace window and above 15% usage, which is an explicit guard against early-window false alarms.
- **Build:** Solid. 191 commits, CI, tests, docs, MIT.

### arcade-statusline
- **Primitives:** Turns refresh ticks into animation frames, and maps every datum to a spatial position rather than a number. The Pikmin theme buckets time into fifteen-minute slots and plants a mark per slot, so the bar is a scrolling history rather than an instantaneous reading.
- **UX:** —
- **Unique:** The only animated game-as-bar. The auto-compact threshold is a cherry on the track and a rate limit is literally game over.
- **Build:** Rough. 22 commits, no tests, but CI and MIT.

### claude-code-tamagotchi
- **Primitives:** The only project here where the statusline is both an output of enforcement and an input to it. A monitor can block a tool call that violates your stated instructions, and the pet's expression is how the violation surfaces.
- **UX:** —
- **Unique:** Writes back into the session rather than only reporting on it.
- **Build:** Hacky and dormant. 18 commits, no CI, no tests, last pushed October 2025.

### claude-statusline (m5d215, jq-jit)
- **Primitives:** — The one-jq-program construction is a curiosity, not a transferable idea.
- **UX:** —
- **Unique:** It ships a **subagent panel renderer** with a documented per-row grammar and a label fallback chain. That is a second render surface every other project in this survey ignores, and it is the single most interesting thing in this file for someone who already owns a bar.
- **Build:** Hacky. Zero stars, 29 commits, the whole renderer is one jq program. Has CI and releases regardless.

### claude-pace
- **Primitives:** Renders a derived two-variable comparison in one glyph. An up arrow with 15% means you are burning quota 15% faster than the window can sustain, which folds consumption and time-remaining into a single readable fact.
- **UX:** —
- **Unique:** The pace delta itself. Every other project here shows usage and leaves the arithmetic to the reader.
- **Build:** Solid. 128 commits, CI, tests, docs, MIT, for what is essentially one bash script.

### which-claude-code
- **Primitives:** A colour hashed deterministically from the session ID, so a session keeps one colour forever and siblings stay distinguishable. Also documents honest rounding: because the host pre-rounds a percentage to an integer, real usage below half a percent arrives as zero and is rendered as "under 1%" rather than "0%".
- **UX:** —
- **Unique:** An LLM-generated segment. A background Haiku call distils your intent into a three-to-six word session title, refreshed by a prompt hook.
- **Build:** Hacky. 17 commits, no CI.

### claude-statusline (ersinkoc)
- **Primitives:** Theme as widget grouping. A hundred themes differ by which related widgets sit in which pill, which makes a theme a layout decision rather than a palette.
- **UX:** An interactive picker with live preview and search, plus a custom theme builder that saves back.
- **Unique:** —
- **Build:** Rough. 37 commits, no CI, 2 contributors.

### ccusage
- **Primitives:** Offline by default, reading bundled pricing rather than the network, with an explicit opt-in flag. A cost-source switch chooses between the provider's reported cost and its own recomputation, which is a real modelling decision exposed as a flag.
- **UX:** Flags only, no config file.
- **Unique:** Being everyone's upstream. Most projects in this file shell out to it, which is itself the lesson: the cost model is the part nobody wants to reimplement.
- **Build:** Polished. 1,825 commits, 77 contributors, 134 releases, CI, docs. Licence unclassified.

### cc-statusline (chongdashu)
- **Primitives:** The distributed artifact is generated source, not a runtime. The generator exists only at install time and what lands in your config is a self-contained script with no dependency on it.
- **UX:** A three-question init wizard that also writes the settings wiring.
- **Unique:** Enumerated degradation. The README lists exactly which features vanish when `jq` is missing, rather than dropping them silently.
- **Build:** Solid but stale. CI, tests, docs, MIT, yet only 38 commits and 2 contributors, last pushed February 2026.

### CCometixLine
- **Primitives:** —
- **UX:** TOML plus an interactive configurator.
- **Unique:** It patches the Claude Code install itself to suppress the built-in context-low warning and force verbose mode, with backups and a patch strategy meant to survive host version bumps. A statusline that treats the host app as a modifiable surface.
- **Build:** Solid engineering, but **no licence file** and last pushed March 2026. The licence absence is disqualifying for anything but reading.

---

# Performance substrate

These are not peers and were never judged as such. They are kept because cc-candybar has
three open problems with known answers elsewhere: a high git-subprocess rate, a gap
between JavaScript heap and resident memory, and every cache rebuilding cold on restart.

## Scan table

| Project | Primitives | UX | Unique | Build |
|---|---|---|---|---|
| Watchman | strong | — | yes | Polished |
| Salsa | strong | — | yes | Polished |
| @parcel/watcher | strong | — | yes | Polished |
| Vector | strong | — | yes | Polished |
| direnv | strong | yes | yes | Polished |
| gitui / asyncgit | strong | — | yes | Polished |
| Powerline | strong | — | yes | Solid, stale |
| jemalloc | strong | — | yes | Polished |
| gitstatusd | strong | — | yes | Solid, copyleft |
| sccache | strong | yes | — | Polished |
| Jujutsu | strong | strong | yes | Polished |
| notify | strong | — | yes | Polished |
| sysinfo | strong | — | — | Polished |
| Sapling / EdenFS | strong | — | yes | Polished, copyleft |
| gitoxide | yes | — | yes | Polished |
| bash-cache | strong | — | — | Hacky, dormant |
| zsh-bench | strong | — | yes | Rough |
| Scalar | yes | — | — | Solid, superseded |
| ghx | yes | — | yes | Rough |
| libgit2 | yes | — | — | Polished |

## Detail

### Watchman
- **Primitives:** The clockspec. A client hands back the opaque clock token from its last query and receives only what changed since, which turns "what happened while I was dead" into one round trip instead of a cold rescan.
- **UX:** —
- **Unique:** It models honest failure. When the OS drops events it declares a recrawl and tells clients their clock is untrustworthy, rather than silently serving stale state.
- **Build:** Polished. 14,111 commits, 322 contributors, 303 releases, CI, MIT.

### Salsa
- **Primitives:** Two that a MobX store does not have. **Backdating**: a re-executed query producing a value equal to last revision's does not invalidate its dependents, so an index touch that yields the same branch name costs nothing downstream. **Durability levels**: an input declared high-durability lets whole dependency subtrees skip validation on a revision bump.
- **UX:** —
- **Unique:** It is the incremental engine extracted from rust-analyzer, so the design is proven at editor latency.
- **Build:** Polished. 2,360 commits, 91 contributors, 60 releases, CI, tests, Apache-2.0.

### @parcel/watcher
- **Primitives:** `writeSnapshot` and `getEventsSince`. A process that was **not running** can ask what changed while it was down and reconcile without a rescan. This is the direct answer to caches rebuilding cold on daemon restart.
- **UX:** —
- **Unique:** A native addon per platform with an explicit backend ladder, using Watchman when installed and brute force only as a last resort.
- **Build:** Polished. 201 commits, 27 contributors, CI, tests, MIT.

### Vector
- **Primitives:** File identity as a CRC fingerprint over the first N bytes rather than an inode, which survives both inode reuse and rename-based rotation. Checkpoints of file-id to byte-offset persisted with atomic temp-file-plus-rename, so a restart resumes mid-file. Copytruncate detected by noticing offset exceeds size.
- **UX:** —
- **Unique:** It tails thousands of append-only files concurrently in production, so the failure modes are all already found.
- **Build:** Polished. 14,198 commits, 410 contributors, 108 releases. MPL-2.0, weak copyleft.

### direnv
- **Primitives:** The watch list. Evaluating a script records every file it read as a path-and-mtime list, and the per-prompt hook re-evaluates only when one entry actually moved. That converts "when do I re-run this" from a TTL guess into a dependency fact, and transplants directly onto shell and file variable sources.
- **UX:** Its whole interface is one hook plus an explicit allow step, which is a good model for a tool that runs on every prompt and must never surprise you.
- **Unique:** The dependency list is base64-encoded into an environment variable, so the state travels with the shell rather than living in a cache.
- **Build:** Polished. 1,315 commits, 237 contributors, 64 releases, CI, tests, MIT.

### gitui / asyncgit
- **Primitives:** Request coalescing in about eighty lines. It hashes parameters and a generation counter into a request key, returns the previous result and **drops the request entirely** when one is already in flight, keeps a last-known-good value that is always renderable, and bumps the generation to force a real refetch.
- **UX:** —
- **Unique:** The git layer is factored into a separate crate specifically so it can be read and reused apart from the UI.
- **Build:** Polished. 2,630 commits, 142 contributors, 67 releases, CI, MIT.

### Powerline
- **Primitives:** The threaded segment. A segment declares an interval, its expensive update runs on a background thread on that cadence, and render returns the last computed value immediately, so no segment can block a repaint. A per-segment refresh budget expressed as config data rather than engine code.
- **UX:** —
- **Unique:** It is the original of this architecture: a slow renderer fronted by a daemon on a unix socket with a tiny compiled C client and a shell fallback client. The same split cc-candybar uses.
- **Build:** Solid but stale. 2,867 commits, 130 contributors, last pushed March 2026, licence unclassified.

### jemalloc
- **Primitives:** It names and gives knobs for exactly the symptom cc-candybar has, resident memory far above live heap in a long-lived process. Decay settings control how aggressively dirty pages return to the kernel, a background thread does that purging off the hot path, and the stats interface exposes per-arena retained-versus-allocated bytes so the gap can be **measured** rather than guessed from a heap snapshot.
- **UX:** —
- **Unique:** It is usable against a Node daemon through library preloading, so the diagnosis does not require the Rust port first.
- **Build:** Polished. 3,838 commits, 178 contributors, CI, tests. Licence unclassified, actually BSD-family.

### gitstatusd
- **Primitives:** Where the speed comes from, stated explicitly: raw directory reads instead of wrapper calls, an untracked-directory cache keyed on mtime so unchanged subtrees are never rescanned, and a thread pool across all cores. The client half matters as much: a query takes a millisecond budget and returns "no answer yet" instead of blocking, so a slow repo degrades one segment rather than the whole bar.
- **UX:** —
- **Unique:** It publishes a three-way benchmark of the same query against git and libgit2 with real numbers, which is rare and makes the libgit2 decision a measured one.
- **Build:** Solid. 1,430 commits, 24 releases, but no CI and **GPL-3.0**, so the technique is readable and the code is not liftable.

### sccache
- **Primitives:** The client-daemon contract, debugged over a decade. The client probes for the server, **starts it itself on a miss and then retries the connect** rather than failing the call, and the server shuts down after an idle timeout so a stale build cannot linger.
- **UX:** Stop-server and show-stats subcommands as the operational seam, which is the shape a daemon's diagnostics should take.
- **Unique:** —
- **Build:** Polished. 2,379 commits, 264 contributors, 57 releases, CI, tests, Apache-2.0.

### Jujutsu
- **Primitives:** A real file-monitor abstraction rather than a hardcoded watch call, with a swappable backend and an option that registers a **trigger** so the watcher pushes instead of the tool polling.
- **UX:** A debug subcommand that reports what the watcher currently believes, which is the diagnostic a watch-based cache always needs and rarely has.
- **Unique:** It snapshots the working copy before every command, so detecting working-tree change is a cost paid constantly and therefore taken seriously.
- **Build:** Polished. 11,699 commits, 370 contributors, 53 releases, CI, Apache-2.0.

### notify
- **Primitives:** An explicit polling fallback with a configurable interval and optional content hashing, selected automatically when the OS watcher is unavailable. That is the network-filesystem and watch-limit case where a naive watch silently does nothing. The companion debouncer correlates rename-from and rename-to into single events, which is exactly the noise a git index rewrite produces.
- **UX:** —
- **Unique:** It is the substrate under most of the Rust watching ecosystem, so the edge cases are already catalogued.
- **Build:** Polished. 1,087 commits, 131 contributors, 43 releases, CI. Licence not detected by GitHub; verify.

### sysinfo
- **Primitives:** The refresh request is **data naming the fields the caller will read**, so an unread field costs nothing and refreshing one process's memory skips the whole process-table walk. Both a mechanism and a design pattern.
- **UX:** —
- **Unique:** —
- **Build:** Polished. 3,014 commits, 192 contributors, CI, tests, MIT.

### Sapling / EdenFS
- **Primitives:** The journal. Recent modifying filesystem operations are recorded in an in-process log exposed as a changed-files-since query, which makes status proportional to files changed rather than repository size.
- **UX:** —
- **Unique:** Its docs directory is an unusually complete written account of how a long-lived filesystem-state daemon keeps its state coherent, which is the hardest part of owning a daemon and the least documented anywhere.
- **Build:** Polished but **GPL-2.0**, so read the docs and not the code.

### gitoxide
- **Primitives:** A crate split that lets you pay only for what you read. Resolving HEAD and the current branch never opens the index at all, which is the ninety-percent case for a status bar.
- **UX:** —
- **Unique:** The working-tree walk is an explicitly parallel dirwalk with a configurable thread count, and the repo publishes per-crate benchmarks rather than a slogan.
- **Build:** Polished. 16,580 commits, 207 contributors, and three thousand releases, CI, tests, Apache-2.0.

### bash-cache
- **Primitives:** It separates **TTL from refresh deadline**, which most caches conflate. Past the refresh deadline the cached value is still returned immediately and an async update starts; only past the TTL is the entry evicted. The cache key explicitly includes the environment variables the function reads.
- **UX:** —
- **Unique:** —
- **Build:** Hacky and dormant. 84 commits, last pushed January 2023, GPL-3.0. The one-minute TTL with ten-second refresh recommendation is the takeaway, not the code.

### zsh-bench
- **Primitives:** The latency vocabulary a status bar is missing: first-prompt lag, first-command lag, input lag and command lag, measured by driving a real interactive shell through a pty rather than timing a synthetic render.
- **UX:** —
- **Unique:** It publishes a comparison table of real configurations against those numbers, including the finding that asynchronous segments trade first-prompt lag for correctness of the first frame.
- **Build:** Rough. 228 commits, no CI, no tests, MIT. Measurement shape is the product.

### Scalar
- **Primitives:** The thesis that the way to make a foreground command fast is to move the work to a background schedule, with a recurring maintenance job that prefetches and repacks so status never pays for it. Transplantable as a daemon that warms its own caches on a cadence instead of only on a render miss.
- **UX:** —
- **Unique:** —
- **Build:** Solid but superseded, its features now upstreamed into git itself. No CI or tests in the repo, MIT.

### ghx
- **Primitives:** A caching proxy for the GitHub CLI, keyed on resolved repository, branch and auth context rather than on the command string. That is a better cache key than cc-candybar's current one.
- **UX:** —
- **Unique:** It raises a real question rather than just a technique: whether the forge lookup should be delegated wholesale instead of cached in-process.
- **Build:** Rough. 108 commits, 2 contributors, but CI, tests, docs, MIT.

### libgit2
- **Primitives:** The cheap parts are the liftable ones: head resolution, the ref and index readers, and an option to bound a long-lived process's object cache.
- **UX:** —
- **Unique:** —
- **Build:** Polished, 16,450 commits, 398 contributors. Two caveats: the licence is unclassified and carries a linking exception that needs reading, and gitstatusd's published benchmark measures its diff call as the slowest of three implementations, so adopting it is a decision with a number attached rather than an obvious win.

# Candidates — Claude Code statuslines and status bars

Territory: tools Claude Code invokes via the `statusLine` setting, plus usage trackers with a statusline mode, HUD plugins, and anything rendering Claude Code session state into a bar. Stats from `gh api` on 2026-09-10 (stars · commit count from the `Link: rel="last"` page number · last push). Ordered most interesting first, not most popular first.

## ccstatusline
- **URL:** https://github.com/sirmalloc/ccstatusline
- **Stats:** TypeScript · 12,827 stars · 378 commits · last push 2026-09-07
- **What it is:** The most-installed configurable Claude Code statusline: 60+ widgets across session, context, usage, git and system categories, arranged into multiple powerline lines through an interactive terminal configurator.
- **Interesting because:** The config UX is a React/Ink TUI with live preview, fuzzy/initialism widget search, and a colour editor spanning 16/256/truecolor — and it has real per-source caching: a git cache under `~/.cache/ccstatusline/git-cache` keyed by mtime, `--no-optional-locks` on every git call to dodge `index.lock` races, a single shared JSONL stream feeding all transcript-backed metrics instead of one scan per widget, and a 5-hour-invalidated block-timer cache.

## claude-powerline
- **URL:** https://github.com/Owloops/claude-powerline
- **Stats:** TypeScript · 1,165 stars · 411 commits · last push 2026-09-06
- **What it is:** A vim-style powerline bar with 25+ independently toggleable segments (directory, git, model, session, today, context, block, weekly, metrics, agent, thinking, cacheTimer, tmux), configured by cascading JSON at project / user / XDG paths.
- **Interesting because:** It has a CSS-Grid-inspired TUI grid engine — breakpoints, fractional units (`1fr`, `2fr`), column spanning, and dot-notation placement of *sub*segments (`context.bar`) with automatic culling of empty segments and orphaned dividers — plus a `cacheTimer` segment that auto-detects whether the prompt cache window is the 5-minute or 1-hour variant, and a hosted visual configurator at powerline.owloops.com that exports the JSON.

## claude-code-usage-bar
- **URL:** https://github.com/leeguooooo/claude-code-usage-bar
- **Stats:** Python · 372 stars · 391 commits · last push 2026-09-05
- **What it is:** A three-line usage-focused bar (5h/7d rate-limit gauges with end-of-window projections, prompt-cache countdown, model/context, git/project, session mode) with a "daemon fast-mode" backed by a native Go cache reader.
- **Interesting because:** It is the closest architectural sibling to cc-candybar and the per-source refresh policy is spelled out: two persistent render workers plus bounded background queues, transcript reads that reuse the unchanged snapshot and parse only *appended bytes* with a bounded rebuild after replacement, a 30-second git cache shared per worktree with single-refresh serialization, config reload on metadata change, and a 5-minute account-scoped cache over Anthropic's undocumented OAuth usage endpoint.

## CCometixLine
- **URL:** https://github.com/Haleclipse/CCometixLine
- **Stats:** Rust · 3,459 stars · 81 commits · last push 2026-03-14
- **What it is:** A Rust statusline binary shipped through npm as `@cometix/ccline`, rendering model / directory / git / context with Nerd Font glyphs and an interactive TUI for theme and segment configuration.
- **Interesting because:** Beyond the bar it ships a "robust patcher" that edits the Claude Code install itself to suppress the built-in "Context low" warning and force verbose mode, with automatic backups and a patch strategy designed to survive Claude Code version bumps — a statusline that treats the host app as a modifiable surface, not just a JSON source.

## Yet Another Statusline (YAS!)
- **URL:** https://github.com/tmck-code/yet-another-statusline
- **Stats:** Python · 242 stars · 598 commits · last push 2026-09-10
- **What it is:** A btop-aesthetic multi-row statusline showing loaded plugins and skills, a context gauge with morphing state words (Smart → Coasting → Foggy → Cooked → Dumb), per-tool invocation tallies, subagent rows and a tokens-over-time sparkline.
- **Interesting because:** Three mechanisms worth stealing — a `UserPromptSubmit` hook writes per-session prompt timestamps so subagent rows are turn-scoped instead of guessed from a time window; four glyph modes (`nerdfont`/`ascii`/`unicode`/`github`) plus a `single_width` knob that folds double-width CJK and emoji so column geometry survives fidelity changes; and a config precedence rule where a per-model `soft_limit` override beats the global value *from any source*, i.e. specificity outranks the CLI→env→toml→default chain.

## claude-code-statusline (rz1989s)
- **URL:** https://github.com/rz1989s/claude-code-statusline
- **Stats:** Shell · 478 stars · 918 commits · last push 2026-08-01
- **What it is:** A bash statusline driven by one 227-setting `Config.toml`, rendering 1–9 configurable lines where each line names an array of atomic components (repo_info, commits, submodules, model_info, cost_repo, mcp_status, prayer times).
- **Interesting because:** Its caching is tiered by data volatility inside a single scheme — session-lifetime for `command -v` probes, seconds for git status, minutes for MCP server lists, hours for version info — stored in an XDG cache with SHA-256 integrity validation and explicit multi-instance race protection; it also monitors MCP server health as connected/total with per-server indicators, and its prayer-times component is the clearest existence proof in this territory that a statusline segment can be an arbitrary networked widget with an offline fallback chain.

## cship
- **URL:** https://github.com/stephenleo/cship
- **Stats:** Rust · 421 stars · 336 commits · last push 2026-09-06
- **What it is:** A Rust statusline configured exactly like Starship: a `lines` array of format strings, per-module TOML sections with `symbol`/`style`/`format`, and Nerd Font glyphs.
- **Interesting because:** Format strings mix native `$cship.<module>` tokens with *Starship module passthrough* tokens (`$git_branch`, `$python`), so the whole Starship module ecosystem becomes available inside a Claude Code bar; and every module takes `warn_threshold`/`warn_style` plus `critical_threshold`/`critical_style` pairs, which is threshold-as-data rather than a colour branch, with a `ttl` knob on `usage_limits` for concurrent sessions.

## claude-statusline (TheoBrigitte)
- **URL:** https://github.com/TheoBrigitte/claude-statusline
- **Stats:** Go · 8 stars · 27 commits · last push 2026-09-07 — few stars, but the closest thing here to a real template language plus published sub-millisecond benchmarks
- **What it is:** A static Go binary rendering model, context bar/tokens/percentage, cost, duration, Claude API health and rate limits, all driven by a TOML file.
- **Interesting because:** Line layouts are free-form template strings into which modules are placed as `$token` placeholders, each module having its own `format` with `{value}`/`{symbol}`/`{reset}` substitutions; modules carry `min_term_width`/`max_term_width` so visibility is a width predicate rather than a toggle; terminal width is read from `/dev/tty` so it still works with piped stdin; and the API-status module caches `status.claude.com` to a file for 10 minutes. Claimed render time is <0.019 ms.

## claudia-statusline
- **URL:** https://github.com/hagan/claudia-statusline
- **Stats:** Rust · 36 stars · 217 commits · last push 2026-06-15 — few stars, unusually deep persistence design
- **What it is:** A Rust statusline with TOML config that persists per-session cost and line-change stats to SQLite at `~/.local/share/claudia-statusline/stats.db`, designed to be safe with several Claude instances running at once.
- **Interesting because:** It detects context compaction from Claude Code's `PreCompact` and `SessionStart[compact]` hook *events* rather than by inferring it from token counts — claimed ~600× faster detection — and renders a spinner during compaction instead of a stale percentage; token rates use a rolling window where input rate is a session average and output rate a shorter window, so the number is responsive without being noisy.

## Claude HUD
- **URL:** https://github.com/jarrodwatts/claude-hud
- **Stats:** JavaScript · 27,905 stars · 771 commits · last push 2026-09-05
- **What it is:** The most-starred project in the territory: a Claude Code *plugin* (installed via `/plugin marketplace add`) whose statusline shows model and provider label, project path, git branch, context and usage bars, plus optional rows for live tool activity, running subagents and todo progress.
- **Interesting because:** It reads the transcript JSONL alongside the stdin hook payload to reconstruct in-flight state the hook JSON does not carry — which tool is running on which file (`◐ Edit: auth.ts | ✓ Read ×3`), which subagent is active with its model and elapsed time, and todo completion — and it distributes as a plugin with a `/claude-hud:setup` command that writes the `statusLine` block, since plugins cannot contribute one directly.

## claude-dashboard
- **URL:** https://github.com/uppinote20/claude-dashboard
- **Stats:** TypeScript · 566 stars · 459 commits · last push 2026-08-23
- **What it is:** A plugin-distributed statusline with three display modes (compact 1-line / normal 2-line / detailed 6-line) over a modular widget catalogue covering context, cost, rate limits, session, activity and analytics.
- **Interesting because:** Widgets decompose into addressable *sub-widgets* (`context` splits into `contextBar`, `contextPercentage`, `contextUsage`) so a user recomposes the same data at a different granularity without a new widget; `projectInfo` emits an OSC-8 clickable git-branch link; and it auto-detects and folds in usage for Codex, Gemini, Antigravity and z.ai CLIs, hiding each widget when that CLI is absent — including a documented widget that went permanently null when Anthropic merged the 7-day Sonnet bucket.

## coralline
- **URL:** https://github.com/Nanako0129/coralline
- **Stats:** PowerShell · 540 stars · 227 commits · last push 2026-09-07
- **What it is:** A Powerlevel10k-inspired statusline with parallel native Bash and Windows PowerShell 5.1 renderers, 18 segments, three styles (pill/lean/classic) and ten themes.
- **Interesting because:** Two things — the install path is an `INSTALL.md` "playbook" you paste into Claude Code so the agent routes by environment and asks before changing preferences (config-by-LLM as the primary UX), with a bootstrap that resolves a mutable ref to a commit SHA before downloading executable code; and the `cache` segment reads the `prompt_cache` statusline payload field to show hit ratio with *inverted* thresholds (yellow at 50%, red at 25%, `cold` once expired) and is explicit that the countdown is the value at last render, not a live clock.

## claude-statusline (m5d215, jq-jit)
- **URL:** https://github.com/m5d215/claude-statusline
- **Stats:** Shell · 0 stars · 29 commits · last push 2026-08-13 — zero stars, included purely for the implementation substrate
- **What it is:** A powerline statusline and a separate subagent-panel renderer, each written as a single jq program running under jq-jit (a jq interpreter with `exec`/`execv` builtins), installed via Homebrew.
- **Interesting because:** The entire renderer is one jq program — the hook JSON never leaves jq, and shelling out for git happens through jq-jit's `exec` builtin — and it ships a **subagent statusline** renderer for Claude Code's subagent panel with a documented per-row grammar (`{icon} {label} [· {description}] · {tokens} [· {elapsed}]`) and a label fallback chain, which is a second render surface most projects here ignore entirely.

## arcade-statusline
- **URL:** https://github.com/sorosora/arcade-statusline
- **Stats:** Rust · 81 stars · 22 commits · last push 2026-04-21 — few commits, but the only animated game-as-bar in the territory
- **What it is:** A statusline that renders as a retro game: a Pac-Man theme where context usage drives the character's position along the board and rate limits drive chasing ghosts, and a Pikmin theme where a flower trail scrolls behind a walking squad.
- **Interesting because:** It turns refresh ticks into animation frames — the chomp toggles `ᗧ`/`●` and the two ghosts alternate legs in opposite phase on each refresh — and maps every datum to a spatial position rather than a number: the 95% auto-compact threshold is a cherry on the track, the 7-day ghost stays caged in a walled room until usage passes 50%, and hitting a rate limit is literally GAME OVER. The Pikmin theme buckets time into 15-minute slots and plants a flower or a dot per slot, so the bar is a scrolling history rather than an instantaneous reading.

## claude-statusline (ersinkoc)
- **URL:** https://github.com/ersinkoc/claude-statusline
- **Stats:** Python · 78 stars · 37 commits · last push 2026-02-07
- **What it is:** A pip-installed Python statusline with a background monitoring daemon, a rebuildable session database, 100 powerline themes and a large analytics CLI (heatmaps, cost forecasting, budget alerts).
- **Interesting because:** The theme system is the widget grouping — 100 themes differ by which related widgets sit in which pill, browsed through an interactive picker with live preview and search plus a custom theme builder that saves back; and the same binary that renders the bar also owns `daemon --start`, `rebuild` (reconstruct the database from logs) and forecasting/budget commands, so the bar is the front end of a persistent store rather than a per-tick script.

## ccusage
- **URL:** https://github.com/ryoppippi/ccusage
- **Stats:** Rust · 18,481 stars · 1,825 commits · last push 2026-09-10
- **What it is:** The dominant Claude Code cost/usage analyzer, which ships a `ccusage statusline` subcommand rendering model + effort, session/today/block cost, burn rate and context percentage in one line — and which most other projects in this list shell out to.
- **Interesting because:** The statusline path is *offline by default*, reading bundled pricing rather than hitting LiteLLM (`--no-offline` opts into the network), and its thresholds and rendering are flags rather than a config file — `--context-low-threshold`, `--context-medium-threshold`, `--visual-burn-rate` (off/emoji/text/emoji-text) and `--cost-source` (auto/ccusage/cc/both), the last of which chooses between Claude's own reported cost and ccusage's recomputation. Being everyone's upstream is itself the lesson: the cost model is the part people do not want to reimplement.

## cc-statusline (chongdashu)
- **URL:** https://github.com/chongdashu/cc-statusline
- **Stats:** TypeScript · 635 stars · 38 commits · last push 2026-02-16
- **What it is:** A one-command generator — `npx @chongdashu/cc-statusline@latest init` asks three questions and writes a standalone bash statusline script plus the `settings.json` wiring, globally or per project.
- **Interesting because:** The distributed artifact is *generated source*, not a runtime: the Node CLI exists only at install time and what ships into the user's `.claude` is a self-contained bash script with no dependency on the generator, which is also why it degrades explicitly — the README enumerates exactly which features (context percentage, token stats, session timer) vanish when `jq` is missing rather than silently dropping them.

## claude-statusline-powerline
- **URL:** https://github.com/spences10/claude-statusline-powerline
- **Stats:** TypeScript · 34 stars · 140 commits · last push 2026-09-10
- **What it is:** A powerline statusline with six segments (model, directory, git with superscript status symbols, session, aggregated usage from a local database, context cache stats) across 12 colour themes.
- **Interesting because:** It publishes a JSON Schema for its config so editors give autocomplete, validation and hover docs while you edit the settings file — configuration discoverability via the editor rather than a TUI — and it treats the separator glyph as an independent axis with nine named styles (`thick`, `thin`, `curvy`, `angly`, `angly2`, `flame`, `wave`, `lightning`, `none`) orthogonal to the colour theme.

## claude-code-statusline (kcchien)
- **URL:** https://github.com/kcchien/claude-code-statusline
- **Stats:** Shell · 181 stars · 7 commits · last push 2026-03-24 — only 7 commits; included for its degradation ladder and hiding rules
- **What it is:** A dense single-line bash statusline with a true-colour gradient context bar, cost, duration, git branch, rate limits and an agent/worktree indicator.
- **Interesting because:** Two policies stated as rules rather than code paths — a three-tier rendering ladder (24-bit gradient → ANSI 256 → ASCII) selected automatically per terminal, and "smart hiding" where zero-valued facts disappear entirely (`+0/-0`, `0m0s`, absent rate limits) while `$0.00` stays but dims, and the context-window size renders only when it is not already implied by the model name. Whole thing is one `jq` call plus a 5-second git cache, targeting <50 ms.

## claude-code-tamagotchi
- **URL:** https://github.com/Ido-Levi/claude-code-tamagotchi
- **Stats:** TypeScript · 435 stars · 18 commits · last push 2025-10-20 — dormant for nearly a year, and only 18 commits, but nothing else here writes back into the session
- **What it is:** A virtual pet living in the statusline whose hunger/energy/happiness respond to session length and events, fronting an experimental behavioural monitor that watches Claude's tool calls against your stated instructions.
- **Interesting because:** It is the only project in this territory where the statusline is an *output of enforcement and an input to it* — the monitor can block a tool call that violates the user's instructions, and the pet's expression and thought bubble are how the violation is surfaced. The statusline becomes a channel for agent-accountability state, not just telemetry.

## claude-carbon
- **URL:** https://github.com/gwittebolle/claude-carbon
- **Stats:** Shell · 193 stars · 191 commits · last push 2026-09-10
- **What it is:** A plugin that adds a live CO₂ estimate to the statusline beside session cost, computed locally from token usage, with slash commands for a text report, a PNG card, and the footprint of a pull request.
- **Interesting because:** It invents a segment nobody else has by deriving a second unit from data everyone already has — tokens → grams of CO₂ against a published, sourced factor table — and it persists each session to local SQLite specifically to survive Claude Code's 30-day transcript purge, backfilling from existing `~/.claude` transcripts on install. Its burn indicator fires only after a 15-minute grace window and once usage passes 15%, an explicit guard against early-window false alarms.

## Token Tracker (tt)
- **URL:** https://github.com/stormzhang/token-tracker
- **Stats:** Python · 510 stars · 384 commits · last push 2026-09-09
- **What it is:** A local token/cost tracker across Claude Code, Codex and Kimi Code, with a four-line Claude Code statusline, a CLI dashboard with GitHub-style heatmaps, and a persistent sidebar pane.
- **Interesting because:** Where Codex exposes no statusline API it *injects* a two-line truecolor pseudo-statusline through a hook, manufacturing the surface the host does not provide; `tt sidebar` is a narrow always-on pane listing every active session with a status light and its latest prompt, where clicking a session jumps to its iTerm2 or tmux pane; and one theme setting (6 themes) colours the CLI reports and every agent's statusline from a single source.

## claude-pace
- **URL:** https://github.com/Astro-Han/claude-pace
- **Stats:** Shell · 229 stars · 128 commits · last push 2026-07-28
- **What it is:** A single-file bash+jq statusline whose whole thesis is quota pacing: 5h and 7d usage, reset countdowns, git diff stats, and a pace delta.
- **Interesting because:** It renders a *derived* number instead of a raw one — `⇡15%` means you are burning 15% faster than the window can sustain, `⇣15%` means that much headroom — by comparing consumption against time remaining, on the argument that "60% used" is meaningless without knowing whether 30 minutes or 4 hours are left. One glyph carries a two-variable comparison that every other project leaves to the reader.

## which-claude-code
- **URL:** https://github.com/jbarbier/which-claude-code
- **Stats:** Shell · 33 stars · 17 commits · last push 2026-04-24 — few commits; the identity mechanism is the reason it is here
- **What it is:** A plugin that puts an auto-generated 3–6 word title for the current session in the statusline, alongside context and 5h/7d usage, so parallel terminals are tellable apart.
- **Interesting because:** After every prompt a background Haiku call distills your intent into the title — an LLM-generated segment refreshed by a `UserPromptSubmit` hook — and the leading dot is tinted with a colour hashed deterministically from the session ID, so a session keeps one colour forever and sibling sessions are distinguishable at a glance. It also documents the honest-rounding case: Claude Code pre-rounds `used_percentage` to an integer, so real usage under 0.5% arrives as 0 and is rendered `<1%` rather than `0%`.

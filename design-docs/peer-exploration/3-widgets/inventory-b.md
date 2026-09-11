# Widget inventory B — dashboards, HUDs and usage trackers

This inventory covers nine peer projects — Claude HUD, claude-dashboard, coralline, m5d215's claude-statusline, arcade-statusline, ersinkoc's claude-statusline, ccusage, cc-statusline, and claude-statusline-powerline — and records every distinct thing each one puts on screen, how it is rendered, and where that rendering lives in the checkout. It is raw material for a later pass that folds all three lanes into one widget catalogue.

## Claude HUD

- **Repo:** https://github.com/jarrodwatts/claude-hud
- **Read:** src/render/lines/identity.ts, src/render/colors.ts, src/render/lines/usage.ts, src/render/lines/cost.ts, src/render/lines/session-time.ts, src/render/lines/session-tokens.ts, src/render/lines/prompt-cache.ts, src/render/lines/memory.ts, src/render/todos-line.ts, src/render/tools-line.ts, src/render/skills-mcp-line.ts, src/render/lines/advisor.ts, src/render/lines/compactions.ts, src/render/lines/added-dirs.ts, src/render/lines/environment.ts, src/render/lines/project.ts, src/render/vcs-status.ts, src/render/model-display.ts, src/render/lines/label-align.ts, src/render/width.ts, src/render/index.ts, src/utils/hyperlinks.ts, README.md

### What it displays

| Element | What it shows | How it is rendered | Defined at |
|---|---|---|---|
| Context bar | Context-window fill | Block-glyph bar (`█`/`░`, adaptive width), green above the warning threshold, yellow at 70%, red at 85% (both configurable); value shown as percent or raw tokens per `contextValue` config | `src/render/colors.ts` (`coloredBar`, `getContextColor`), `src/render/lines/identity.ts` |
| Token breakdown on high context | Input vs cache tokens once context is critical | Appended `(in: X, cache: Y)` suffix, shown only once percent ≥ the critical threshold (default 85%) | `src/render/lines/identity.ts` |
| Usage (rate-limit) bar | 5h/7d/scoped window utilization | Same block-glyph bar family, color thresholds at 75% (magenta warning) and 90% (red critical); reset time as relative or absolute clock per config | `src/render/colors.ts` (`quotaBar`, `getQuotaColor`), `src/render/lines/usage.ts` |
| Cost line | Session cost, optionally today's total | Plain `$X.XX` figures; label switches between "Cost" and "Estimated cost" depending on whether Claude Code's native cost field was usable | `src/render/lines/cost.ts` |
| Prompt-cache countdown | Time until the prompt cache TTL expires | Stopwatch glyph + countdown to a wall-clock expiry time (not a live countdown — only updates on repaint); three colors: active (context-color), warning (yellow, inside the last ⅕ of the TTL), expired (dim); shows `cold` once past expiry | `src/render/lines/prompt-cache.ts` |
| Memory line | Approximate RAM used by the session | Block-glyph bar + `used / total` bytes + percent, same warning/critical thresholds as the usage bar; only shown in `expanded` layout | `src/render/lines/memory.ts`, `src/render/colors.ts` |
| Todos | Current in-progress todo, or completion state | `▸ <task text> (n/total)` while one is in progress; `✓ All todos complete (n/total)` once done; hidden otherwise | `src/render/todos-line.ts` |
| Tool activity | Running and recently-completed tool calls | `◐` (yellow) for up to 2 running tools with their target file, `✓` (green) with a `×count` for completed tools grouped by name, `+N more` overflow | `src/render/tools-line.ts` |
| Skills / MCP list | Active skills or MCP servers | `✓ Skills (n): name, name, +N more`, comma-joined, capped at 4 named entries | `src/render/skills-mcp-line.ts` |
| Advisor model | The reasoning-advisor model in play | Prettified id, e.g. `claude-opus-4-7` → `Opus 4.7`; falls back to the raw string when unrecognized | `src/render/lines/advisor.ts` |
| Added directories | Extra workspace directories | Clickable (OSC-8, `file://`) dimmed basenames, `+N more` overflow past 5 | `src/render/lines/added-dirs.ts`, `src/utils/hyperlinks.ts` |
| Environment counts / MCP errors | CLAUDE.md, rules, MCP, hook counts; failing MCP servers | Plain counts joined by `\|`; failing servers rendered in red as `⚠ name1, name2 +N` | `src/render/lines/environment.ts` |
| Git / jj status | Branch, dirty flag, ahead/behind | Colored branch name with a trailing `*` when dirty; jj and git each gate their own optional fields (ahead/behind and file stats are git-only) so the two version-control systems never silently share settings | `src/render/vcs-status.ts`, `src/render/lines/project.ts` |
| Model + effort + fast mode | Active model, reasoning effort, fast-mode flag | `[Model]` badge; effort as a symbol, text, or both (`H`, `high`, or `H high`); Opus fast mode adds a `↯` suffix | `src/render/model-display.ts` |
| Agents line | Running and recently-finished subagents | Up to 3 running agents shown first (never evicted by history), plus up to 2 completed agents retained for 60 seconds after finishing | `src/render/agents-line.ts` |

### Layout and density

Two named layouts: `compact` (one line, everything joined by `|`) and `expanded` (default; one line per concern — identity, project, tools, agents, todos, usage, memory). Every optional line can be toggled independently in config; there is no automatic drop-first-N behavior — a line either renders in full or is entirely absent. Width-sensitive label alignment right-pads progress-bar labels (Context/Usage/Weekly/RAM) to the widest label in the active locale so stacked bars line up; CJK/emoji-aware grapheme width measurement backs this.

### Interaction

Clicking an added-directory name or the project path opens a `file://` OSC-8 link to that path (only `https:`/`file:` protocols are allowed through the link helper). Nothing else in the rendered bar is clickable. Configuration itself is interactive via the `/claude-hud:configure` slash command (a guided flow with presets), covered under Config below rather than as bar interaction.

### Config and setup UX

A slash-command wizard (`/claude-hud:configure`) offers three presets (Full/Essential/Minimal) then lets the user toggle individual elements, with a live preview before saving. Advanced settings (custom colors, thresholds, per-language labels) are hand-edited in `~/.claude/plugins/claude-hud/config.json`; a secondary `$CLAUDE_CONFIG_DIR/claude-hud.json` layers per-profile overrides on top of a config shared across multiple Claude config directories.

### The one thing here nobody else does

The prompt-cache countdown renders the cache's expiry as a fixed wall-clock time rather than a live countdown, specifically because the bar only repaints on Claude Code events — a ticking countdown would visibly freeze between repaints and lie about elapsed time.

## claude-dashboard

- **Repo:** https://github.com/uppinote20/claude-dashboard
- **Read:** scripts/widgets/*.ts (32 widget files), scripts/utils/colors.ts, scripts/utils/progress-bar.ts, scripts/utils/formatters.ts, website/src/content/docs/guides/display-modes.md, website/src/content/docs/guides/presets.md, commands/setup.md

### What it displays

| Element | What it shows | How it is rendered | Defined at |
|---|---|---|---|
| Model | Model name, effort badge, fast-mode flag | `◆ Opus(X)` — effort badge `MAX/X/H/M/L` shown for Opus/Sonnet/Fable only, `↯` suffix for Opus fast mode; icon swaps to an orange circle under the z.ai provider | `scripts/widgets/model.ts` |
| Context | Context-window fill | Composable bar+percentage+token-count widget (`renderProgressBar`, 10-cell `█`/`░`), colored green ≤50%, yellow ≤80%, red above, via the active theme's `safe`/`warning`/`danger` roles | `scripts/widgets/context.ts`, `scripts/utils/progress-bar.ts`, `scripts/utils/colors.ts` |
| Rate limits (5h / 7d / 7d-Sonnet / 7d-Fable) | Anthropic usage-window utilization | `label: XX%` colored by the same 50/80 thresholds, `(time remaining)` suffix; hidden entirely under z.ai (replaced by `zaiUsage`) | `scripts/widgets/rate-limit.ts` |
| Burn rate | Tokens consumed per minute | `🔥 <formatted>/min` (no color) | `scripts/widgets/burn-rate.ts` |
| Depletion time | Projected time until the 5h limit is exhausted at the current burn rate | `⏳ ~<duration> to limit 5h`, warning-colored; hidden below a 0.01%/min utilization rate or beyond a 24h horizon | `scripts/widgets/depletion-time.ts` |
| Cost forecast | Session cost and hourly-rate projection | `📈 $current → ~$hourly/h`, hourly figure colored green/yellow/red at $5 and $10/h | `scripts/widgets/forecast.ts` |
| Peak hours | Whether the session is inside Anthropic's weekday 5–11am Pacific peak window | Colored `Peak`/`Off-Peak` label with a `(countdown to transition)` suffix, computed against Pacific local time via `Intl.DateTimeFormat` | `scripts/widgets/peak-hours.ts` |
| Token speed | Output tokens per second | `⚡ N tok/s`, accent-colored, from `total_output_tokens / total_api_duration_ms` | `scripts/widgets/token-speed.ts` |
| Lines changed | Uncommitted diff size (including untracked files) | `+N` (green) `-N` (red), from `git diff --shortstat` plus a manual untracked-line count | `scripts/widgets/lines-changed.ts` |
| Cache hit rate | Share of input tokens served from cache | `📦 XX%`, color logic inverted from the usual scale (high = green) since a high hit rate is the good outcome | `scripts/widgets/cache-hit.ts` |
| Performance badge | Composite score (60% cache hit + 40% output ratio) | Traffic-light circle emoji (🟢/🟡/🔴) at 70/40 thresholds plus the numeric `XX%` | `scripts/widgets/performance.ts` |
| Tag status | Commits ahead of the nearest matching git tag(s) | `🏷 v1.2.3+5` per matched tag pattern, `+N` only shown when nonzero | `scripts/widgets/tag-status.ts` |
| Agent mode | Whether this session is a named custom agent or a dispatched subagent | `👤 name` and/or `🤖 type`, joined by `·` | `scripts/widgets/agent-mode.ts` |
| Vim mode | Current vim input mode | Bare `NORMAL`/`INSERT` text, colored (INSERT = safe color, NORMAL = dim) | `scripts/widgets/vim-mode.ts` |
| Token breakdown | Input/output/cache-write/cache-read split | `📊 In X · Out Y · W Z · R W`, each label individually colored, only nonzero parts shown | `scripts/widgets/token-breakdown.ts` |
| Session ID | Short (8-char) or full session UUID | `🔑 <id>`, secondary color | `scripts/widgets/session-id.ts` |
| Budget | Daily spend vs a configured daily budget | `<icon> $spent / $budget (pct%)`, icon+color escalate banknote→warning→alarm at 80%/95% utilization | `scripts/widgets/budget.ts` |
| Slash command | The slash command that opened the current turn | `🎯 /command-name`, warning-colored, cleared on a plain-text message | `scripts/widgets/slash-command.ts` |
| Config counts | CLAUDE.md, AGENTS.md, rules, MCP servers, hooks, added dirs | Comma-joined `Label: N` pairs, secondary color | `scripts/widgets/config-counts.ts` |
| API duration | Share of session wall time spent waiting on the API | `<label> XX%`, dim below 70%, warning-colored above | `scripts/widgets/api-duration.ts` |
| Session name | Custom `/rename` label | `» <name>` truncated to 20 chars | `scripts/widgets/session-name.ts` |
| Todo progress | Current task and completion count | `✓ <task> [n/total]` while a task is active; `label: n/total` otherwise, color inverted (fewer done = redder) | `scripts/widgets/todo-progress.ts` |
| Tool / agent activity | Running tools/subagents and completion counts | `⚙ tool(target), tool2 +N (M done)` while running; `label: N done` once idle | `scripts/widgets/tool-activity.ts`, `scripts/widgets/agent-status.ts` |

### Layout and density

Three named presets stacked additively (compact = 1 line, normal = 2, detailed = 6), plus a fully custom mode addressed by a pipe-delimited widget list per line (`"model,context,cost\|projectInfo,todoProgress"`), and a single-character preset shorthand (e.g. `"MC$R\|BDO"`) mapping one letter per widget across up to ~40 widgets. No automatic wrapping or priority drop — line membership is entirely explicit, chosen at setup time.

### Interaction

The git branch in `projectInfo` is a clickable OSC-8 link to the repo's remote URL. Nothing else in the rendered bar is clickable; widget selection and layout changes happen through the setup command, not by interacting with the bar itself.

### Config and setup UX

A slash command (`/claude-dashboard:setup`) takes positional or interactive (AskUserQuestion) arguments for display mode, language, plan, and — in custom mode — the exact widget/line layout string. Nine built-in color themes and four separator styles (pipe/space/dot/arrow) are config fields, not interactive pickers. The single-character preset shorthand is a compact, hand-editable alternative to the full custom-mode syntax.

### The one thing here nobody else does

The single-character preset shorthand (`"preset": "MC$R\|BDO"`) — an entire multi-line widget layout expressed as one short string, each letter mapped to a specific widget via a fixed lookup table.

## coralline

- **Repo:** https://github.com/Nanako0129/coralline
- **Read:** statusline.sh, configure.sh, README.md

### What it displays

| Element | What it shows | How it is rendered | Defined at |
|---|---|---|---|
| Directory | Current working directory | `~`-collapsed, deep paths folded to `first/second/…/last` beyond a configurable depth | `seg_dir` in `statusline.sh` |
| Project | Repository root name, stable across worktrees | Falls back to the directory segment outside a repo; hidden when `dir` is already shown | `seg_project` in `statusline.sh` |
| Git | Branch, dirty marks, ahead/behind | `⎇ branch+!?  ⇡N ⇣N`, pill background flips color when dirty | `seg_git`, `read_git` in `statusline.sh` |
| Model | Active Claude model | `◆ Model` | `seg_model` in `statusline.sh` |
| Context gauge | Context-window usage plus token breakdown | `▰▰▰▱▱`-style 5-wide filled/empty block bar + `NN%` + `↑in ↓out cr:X cw:Y` token counts; bar colors green/yellow/red at 50%/75% | `seg_ctx`, `make_bar`, `pct_fg` in `statusline.sh` |
| Prompt cache | Cache hit ratio and expiry | `NN%` (inverted thresholds — high hit ratio reads green) plus `↺<countdown>` or `cold`; countdown carries seconds under an hour | `seg_cache` in `statusline.sh` |
| Rate limits (5h / 7d) | Window utilization | Same block-bar gauge as context, plus a `↺<countdown>` to reset; can borrow the highest reading any session recorded for the still-open window via an optional cross-session store | `seg_limit`, `seg_limit5h`, `seg_limit7d` in `statusline.sh` |
| Burn-rate ETA | Projected time until the binding 5h/7d limit reaches 100% at the recent rate | Three states: dim `✓` when idle (no burning), dim `…` when warming up (no samples yet), or a colored `⇢ <ETA>` countdown once actively burning — hot/warn/ok color set by how close the ETA is to the limit's reset time | `seg_burn` in `statusline.sh` |
| Cost | Session cost in USD | Plain `$X.XX` | `seg_cost` in `statusline.sh` |
| Clock | Current time | 12h or 24h, optional seconds | `seg_clock` in `statusline.sh` |
| Lines changed | Session diff size | Added/removed line counts | `seg_lines` in `statusline.sh` |
| Duration | Session wall-clock length | Elapsed-time string | `seg_duration` in `statusline.sh` |
| Effort | Reasoning effort level | Glyph + level text | `seg_effort` in `statusline.sh` |
| Stash count | Git stash entries | Plain count | `seg_stash` in `statusline.sh` |
| Node / Python runtime | Active language runtime version | Detected from a pin file, or from `PATH` when opted into an extra probe; silent when undetected | `seg_node`, `seg_python` in `statusline.sh` |
| Subagent panel | Per-task rows for Claude Code's subagent panel | A whole separate multi-row panel, themed like the main bar: identity+label colored by status (running/completed/failed/unknown), model badge, a bare context gauge without a window size, elapsed time | `subseg_name`, `subseg_model`, `subseg_ctx`, `subseg_elapsed` in `statusline.sh` |

### Layout and density

Three fixed segment rows (`VL_SEGMENTS`/`2`/`3`) by default, or an `auto` layout that greedily wraps one segment list across up to `VL_MAX_LINES` rows measured against the real terminal column count (with a right-hand margin reserved so wrapped lines never touch the edge). Width measurement is grapheme- and CJK-aware, implemented fork-free in pure bash. Three visual styles change how segments join: `pill` (powerline pills with per-segment backgrounds), `lean` (flat text on one uniform background with optional separators and end caps), and `classic` (a one-word preset for a Powerlevel10k-style uniform dark bar).

### Interaction

None in the rendered bar. An optional "float readout" writes a plain-text line to a file on every render as an integration seam for external displays (an unsupported iTerm2 example is included); coralline itself draws no such display.

### Config and setup UX

A dedicated interactive wizard (`configure.sh`) walks theme, style (pill/lean/classic), and per-segment layout choices with a live rendered preview at each step, including paging through bundled themes (`Theme N/10`) and importing color/style values from an existing Powerlevel10k (`~/.p10k.zsh`) config. Runtime config is a sourced shell file (`~/.claude/coralline.conf`) of `VL_*` variables (bar width/glyphs, color thresholds, per-segment background/foreground colors, ASCII fallback mode).

### The one thing here nobody else does

The burn-rate segment's three-state idle/warming/active model deliberately distinguishes "burning at zero because you're not using tokens" (a reassuring dim ✓) from "burning at zero because no samples exist yet" (a dim `…`) — a fresh install and a genuinely idle session would otherwise render identically.

## claude-statusline (m5d215, the jq implementation)

- **Repo:** https://github.com/m5d215/claude-statusline
- **Read:** statusline.sh, subagent-statusline.sh, catalog.sh, README.md

### What it displays

| Element | What it shows | How it is rendered | Defined at |
|---|---|---|---|
| Model + effort pill | Model name (with context-window size folded in) and reasoning effort | One rounded powerline pill; effort omitted for models that don't support it | `model_parts`, `pill` defs in `statusline.sh` |
| Directory | Current working directory | `~` under `$HOME`; `~/src/github.com/…` and `~/src/gitlab.com/…` paths get a GitHub/GitLab nerd-font icon in place of the literal path prefix | `shorten_dir` def in `statusline.sh` |
| Git branch | Current branch | `<branch-icon> name`, hidden outside a repo | `git_branch` def in `statusline.sh` |
| Profile | Which `$CLAUDE_CONFIG_DIR` is active | Basename of the config dir; hidden when unset or the default `~/.claude` | `profile_label` def in `statusline.sh` |
| Meters pill | Context-window usage plus 5h/7d rate limits | One pill with three independently-colored parts (green→yellow→red per part); a rate-limit part's reset time is shown only once that window itself is at 50%+ usage; missing rate-limit data hides just that part | `meter_parts`, `context_color`, `rate_limit_color` defs in `statusline.sh` |
| Subagent panel rows | Per-task status in Claude Code's subagent panel | `{icon} {label} [· {description}] · {tokens} [· {elapsed}]`; icon/color is `…` green running, `✓` cyan completed, `✗` red failed, `○` gray other; tokens formatted `234`/`61.4k`/`234k`/`1.2M` | `subagent-statusline.sh` |

### Layout and density

Always one line of pills, joined by a space; segments with no content (no branch, no profile, empty meters) are simply omitted from the join, so there is no separate "compact mode" — the same fixed pipeline just produces fewer pills. No width-awareness or wrapping.

### Interaction

None — a print-once script.

### Config and setup UX

No wizard. `CLAUDE_STATUSLINE_HIDE` is a comma-separated env var naming segments or individual meter parts to hide (case-insensitive, unknown names ignored); everything else is fixed.

### The one thing here nobody else does

Directory shortening recognizes the shape of a GitHub/GitLab clone path specifically (`~/src/github.com/org/repo`) and swaps the literal `github.com`/`gitlab.com` segment for a forge icon, rather than doing generic path abbreviation.

## arcade-statusline

- **Repo:** https://github.com/sorosora/arcade-statusline
- **Read:** src/themes/pacman.rs, src/themes/pikmin.rs, src/helpers.rs, src/settings.rs, README.md, install.sh

### What it displays

| Element | What it shows | How it is rendered | Defined at |
|---|---|---|---|
| Pac-Man chase game | Context-window usage and both rate-limit windows, all at once | A bordered maze-corridor line: the Pac-Man glyph's horizontal position maps to context-window usage; a red ghost chases proportionally to 5h usage and a purple ghost to 7d usage; the 7d ghost stays caged in a walled 3-cell room while 7d usage is under 50%; a cherry glyph (`ᐝ`) marks the 95% auto-compact threshold; mouth-open/closed and ghost-leg glyphs alternate every render (state persisted to a temp file) to animate; a rate limit hitting 100% turns the catching ghost into the character's position and prints `GAME OVER` | `src/themes/pacman.rs` |
| Pikmin Bloom flower trail | A rolling timeline of 15-minute activity slots plus both rate-limit windows | A scrolling trail of flower/dot glyphs, one per 15-min slot over roughly the last 9 hours: a flower if tokens were consumed in that slot, a dot if idle, with every 8th slot ("big" slots, ~2h apart) getting a distinct big-flower glyph once bloomed or a seedling (🌱) while unconsumed; a marching 3-emoji Pikmin squad (🔴🟡🔵) sits between trail and future slots and alternates order each render; upcoming rate-limit reset times appear as fruit glyphs in the future slots; decorative sky (blue `█`) and grass (green `▀`) rows bracket the trail; footer reads `✨Bloom!⏹️` normally or `Ha! ▶️` once a limit is hit | `src/themes/pikmin.rs` |
| Header (both themes) | Model name, context-window size, version, remaining context percent | Plain text row above the game/trail, white/yellow/red colored by remaining-percent thresholds (20%/50%) | `src/themes/pacman.rs`, `src/themes/pikmin.rs`, `colour_remain` in `src/helpers.rs` |
| Effort badge (both themes) | Reasoning effort level from `~/.claude/settings.json` | Plain dim text appended to the footer; hidden during a Pac-Man GAME OVER or a Pikmin rate-limit hit | `src/settings.rs`, both theme files |

### Layout and density

Each theme is a fixed multi-line ASCII/emoji block (Pac-Man: header + top border + game row + bottom border + optional limit-reset footer row; Pikmin: header + sky + trail + grass + footer, with an optional blank-padding mode for buddy widgets). Width is measured from the rendered content itself and clamped between a minimum and a terminal-driven maximum (Pac-Man) or derived directly from the trail's actual glyph count (Pikmin); there is no priority-drop behavior — the whole block always renders, or the theme isn't in use.

### Interaction

None — a static per-render Rust binary. Theme choice is made once, at install time.

### Config and setup UX

`install.sh --theme pacman|pikmin` renders a sample statusline against both themes side by side before the user picks one; the theme can be changed later by re-running the installer or editing the `--theme` flag in the statusline command directly. No further per-widget configuration exists.

### The one thing here nobody else does

Both themes turn the statusline into a literal, continuously-animating arcade game whose game state IS the usage data — position, chase distance, and game-over are usage numbers, not a separate decoration layered on top of them.

## claude-statusline (ersinkoc)

- **Repo:** https://github.com/ersinkoc/claude-statusline
- **Read:** claude_statusline/statusline.py, claude_statusline/unified_powerline_system.py, claude_statusline/activity_heatmap.py, claude_statusline/simple_theme_selector.py, claude_statusline/budget_manager.py, README.md

### What it displays

| Element | What it shows | How it is rendered | Defined at |
|---|---|---|---|
| Powerline first line | Model, session elapsed, cost, message/token counts, git branch, folder, and other widgets, per the active theme | True-color (24-bit RGB) powerline pills joined by a nerd-font powerline triangle glyph (U+E0B0); each of 100 generated themes picks a soft RGB color and a nerd-font/Unicode icon per widget slot | `render_theme`, `_generate_100_themes` in `claude_statusline/unified_powerline_system.py` |
| Session progress bar (second line) | How far the current 5-hour billing window has elapsed | `[◼◼◼◻◻…] ❱ NN%` block bar flanked by elapsed/remaining time pills, bar color green under ⅓ through the window, yellow under ⅔, orange/red beyond | `_render_progress_bar`, `_calculate_session_progress` in `claude_statusline/unified_powerline_system.py` |
| Legacy plain-text line | Status, session number, model, time remaining, message/token stats, cost | `<status-emoji> #N \| icon Model \| Xh Ym left \| N msgs \| $cost`; status emoji is 🟢 LIVE / 🔵 NEW / 🔄 DB / 🔴 EXPIRED depending on data freshness and source | `_format_legacy_display`, `_get_status_indicator` in `claude_statusline/statusline.py` |
| Weekly activity heatmap | Message volume by day-of-week × hour-of-day | 7×24 text grid, 4-level shading (`·` none, `░` low, `▒` medium, `▓` high, `█` very high) normalized against the grid's own maximum | `generate_weekly_heatmap` in `claude_statusline/activity_heatmap.py` |
| Monthly calendar | Daily message/cost totals for a month | Calendar-grid text report (separate `heatmap`/report CLI command, not the statusline itself) | `generate_monthly_calendar` in `claude_statusline/activity_heatmap.py` |
| Budget status | Spend vs a configured limit, per period | `<icon> Period: $spent / $limit (NN%)`, icon escalates ✅→⚠️→❌ at 80%/95% utilization; a separate daily-spend report renders one inline bar per day | `claude_statusline/budget_manager.py` |

### Layout and density

Two lines always: the powerline widget row, then the session-progress bar row. A `render_simple_theme` fallback collapses to one `|`-joined plain-text line (first 6 widgets only) for terminals that can't render nerd-font glyphs. Several individual widget values (`context_percentage`, `cpu_usage`, `memory_usage`) are hardcoded placeholders in the current code rather than live-computed — worth recording since it affects what "displays" actually means here.

### Interaction

None in the rendered bar. A separate interactive CLI theme browser exists as its own command (see below).

### Config and setup UX

`claude-statusline theme` opens a paged interactive browser over all 100 themes, each rendered with real session data for preview; commands are single letters (`n`/`j` next, `p`/`k` previous, `r` random, `g <n>` jump, `+10`/`-10` page-jump, `/` search, `b` theme builder, Enter to apply). A large separate analytics CLI (`analytics`, `sessions`, `costs`, `trends`, `health`, `budget`, `heatmap`, …) ships alongside the statusline itself.

### The one thing here nobody else does

100 procedurally-generated powerline themes, each a random combination from a shared palette-and-icon pool rather than 100 hand-authored designs — browsed with a live-rendered, keyboard-driven paged gallery.

## ccusage

- **Repo:** https://github.com/ryoppippi/ccusage
- **Read:** docs/guide/statusline.md, docs/guide/blocks-reports.md, docs/guide/live-monitoring.md, docs/guide/daily-reports.md

### What it displays

| Element | What it shows | How it is rendered | Defined at |
|---|---|---|---|
| Statusline line | Model+effort, session/today/block cost, burn rate, context usage | Single emoji-prefixed line: `🤖 Model (effort) \| 💰 $session session / $today today / $block block (time left) \| 🔥 $/hr \| 🧠 tokens (pct%)`; burn rate text colored green/yellow/red at 2,000/5,000 tokens-per-min, with an optional visual indicator (🟢/⚠️/🚨 emoji, parenthesized text status, or both); context usage colored by configurable low/medium percent thresholds (default 50/80) | `docs/guide/statusline.md` |
| Dual cost-source display | Claude Code's own cost calc alongside ccusage's independent one | `💰 ($0.25 cc / $0.23 ccusage) session`, opt-in via `--cost-source both` | `docs/guide/statusline.md` |
| Model label alias | A long/opaque model id (e.g. a Bedrock ARN) replaced with a short label | Exact-match substitution against a user-configured `modelLabelAliases` map | `docs/guide/statusline.md` |
| Blocks report | Cost/token usage grouped into 5-hour billing windows | Boxed ASCII table; the active block's row additionally carries `⏰ Active (time remaining)`, `🔥 Rate: X/min`, and `📊 Projected: Y` sub-lines; completed blocks show `✅ Completed (duration)`; gaps show `⌛ Gap`; a configured token limit adds `⚠️` warning rows as usage approaches it | `docs/guide/blocks-reports.md` |
| Live monitoring dashboard (removed in v18, present in v17.x) | Real-time session progress, burn rate, time remaining, cost projection | Full-screen terminal dashboard refreshing every second (configurable interval): a visual progress bar for block completion, tokens/min burn rate, remaining time in the active 5h block, projected final cost, and color-coded quota warnings against a token limit | `docs/guide/live-monitoring.md` |
| Daily/session/monthly reports | Token/cost totals aggregated by date, session, or source CLI | Boxed ASCII tables, one row per period, a bulleted `• model-name` list where multiple models contributed | `docs/guide/daily-reports.md` |

### Layout and density

The statusline output is one fixed unconditional line — no wrapping, no compact mode, no width-awareness described. The tabular reports are each their own full-width boxed table rendered fresh per invocation, not a live-refreshing bar (with the single exception of the now-removed `blocks --live` dashboard, which refreshed in place and reflowed on terminal resize).

### Interaction

None for the statusline line itself. The removed live-monitoring dashboard accepted `Ctrl+C` to exit and reflowed automatically on terminal resize while it existed (v17.x only).

### Config and setup UX

Statusline behavior is set entirely via CLI flags baked into the `command` string in `settings.json` (`--visual-burn-rate`, `--cost-source`, `--context-low-threshold`/`--context-medium-threshold`, `--no-offline`) or the equivalent keys in a config file; no wizard or interactive picker for the statusline itself.

### The one thing here nobody else does

The `--cost-source both` mode deliberately renders two independently-computed cost figures side by side in the same line, as a debugging/trust-verification affordance rather than picking one authoritative number.

## cc-statusline (chongdashu)

- **Repo:** https://github.com/chongdashu/cc-statusline
- **Read:** src/cli/prompts.ts, src/generators/bash-generator.ts, src/features/usage.ts, src/features/colors.ts, src/cli/preview.ts, README.md

### What it displays

| Element | What it shows | How it is rendered | Defined at |
|---|---|---|---|
| Directory / git / model / CC version / output style (line 1) | Working directory, branch, model name+version, Claude Code version, active output style | Emoji-prefixed plain-color segments (`📁`/`🌿`/`🤖`/`📟`/`🎨`) joined by two spaces on one line | `generateDisplaySection` in `src/generators/bash-generator.ts` |
| Context bar (line 2) | Context-window remaining | ASCII progress bar using `=` for filled and `-` for empty cells (10-wide default), remaining-percent colored mint-green/peach/coral-red at >40%/>20%/else via 256-color codes | `generateContextBashCode` in `src/generators/bash-generator.ts` |
| Session countdown bar (line 2) | Time until the usage-limit window resets, sourced from `ccusage blocks --json` | Same `=`/`-` ASCII bar plus `Xh Ym until reset at HH:MM (pct%)`, colored by remaining-percent tiers | `src/features/usage.ts` |
| Cost + burn rate (line 3) | Session cost and $/hour burn rate | `💰 $X.XX ($Y.YY/h)`, gold/bright-gold coloring | `generateDisplaySection`, `src/features/usage.ts` |
| Token count + tokens/min (line 3) | Total session tokens and burn rate in tokens/min | `📊 <tokens> tok (<tpm> tpm)`, lavender coloring | `generateDisplaySection`, `src/features/usage.ts` |

### Layout and density

A fixed 3-line layout (identity / context+session / cost+tokens) is generated once at setup time as a literal bash script; which lines appear depends on which features were selected in the wizard, but there is no runtime wrapping or width-awareness — a `\n`-joined script that always prints the same shape it was generated with. A `compact` theme drops line 3 and the session bar rather than reflowing anything.

### Interaction

None — a generated, static bash script.

### Config and setup UX

An interactive checkbox wizard (`inquirer`) with all 8 features pre-checked lets the user arrow/space/enter through feature selection, a colors+emoji toggle, a debug-logging toggle, and a global-vs-project install-location choice; a summary is printed before writing the script. A separate `preview` command loads an already-generated script, synthesizes mock Claude Code JSON, and runs the script against it to show exactly what it would render before installing.

### The one thing here nobody else does

`cc-statusline preview` round-trips an already-installed script through a synthetic Claude Code payload and prints both the mock input and the rendered result, specifically to let a user verify a generated script works before wiring it into `settings.json`.

## claude-statusline-powerline (spences10)

- **Repo:** https://github.com/spences10/claude-statusline-powerline
- **Read:** src/segments/context.ts, src/segments/directory.ts, src/segments/git.ts, src/segments/model.ts, src/segments/session.ts, src/segments/usage.ts, src/separators/styles.ts, README.md

### What it displays

| Element | What it shows | How it is rendered | Defined at |
|---|---|---|---|
| Model segment | Active model name | `⚡ Claude Sonnet 4`-style icon+name pill | `src/segments/model.ts` |
| Directory segment | Current directory basename | `📁 my-project` | `src/segments/directory.ts` |
| Git segment | Branch and detailed working-tree status | `🌿 branch` plus superscript-glyph status counts: `⇡N`/`⇣N` ahead/behind, `⚠️` conflicts, `⁺N`/`⁻N` staged add/delete, `˜N` unstaged, `ᵘN` untracked (falls back to a bare clean/dirty glyph when none apply); pill background and separator color both flip between a clean and a dirty theme | `src/segments/git.ts` |
| Session segment | This session's token usage, cost, and context headroom, from a local SQLite usage database | `💰 <tokens> • $cost <context-tail>`, where the context tail is `!XX%` once ≥90% of the model's context window, `XX%` once ≥75%, else `Nk left` | `src/segments/session.ts` |
| Usage segment | 7-day aggregate usage across all sessions, from the same local database | `📊 <tokens> • $cost 7d`; renders a distinct `⚠ DB Error` fallback segment on a database read failure rather than hiding | `src/segments/usage.ts` |
| Context segment | Prompt-cache performance for the current session — NOT context-window fill, despite the name | `🧠 Cold` when cache-read tokens are below a warmth threshold, else `🧠 <total-cached> cached (NN% reused)` | `src/segments/context.ts` |

### Layout and density

Segment-to-row assignment is fully explicit via a `lines` array in config (each line lists which segment types appear on it, in property order); segments not listed anywhere are hidden. No automatic wrapping or width-based reflow — the configured line layout is what renders, always. Six powerline separator glyph sets (thick/thin/curvy/angly/angly2/double_chevron) are selectable and applied at segment boundaries.

### Interaction

None described — a static per-render script driven entirely by its config file.

### Config and setup UX

A JSON config file with a published JSON Schema (`statusline.schema.json`) drives autocomplete, validation, and hover documentation in editors that support JSON schema association — configuration itself happens in a text editor with IntelliSense rather than through any wizard or picker in this project. Eleven named color themes and per-segment icon/separator/truncation-length overrides are config fields.

### The one thing here nobody else does

The segment literally named `context` does not show context-window usage at all — it shows prompt-cache hit rate and warm/cold state, while context-window headroom is folded into the `session` segment instead. Among all nine projects this is the only place "context" means cache performance rather than window fill.

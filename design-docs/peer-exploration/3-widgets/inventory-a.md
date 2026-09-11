# Widget inventory A — the established statuslines

This inventory covers nine independent Claude Code statusline projects — ccstatusline, claude-powerline, claude-code-usage-bar, CCometixLine, Yet Another Statusline (YAS!), claude-code-statusline (rz1989s), cship, claude-statusline (TheoBrigitte), and claudia-statusline — and records every distinct thing each one puts on the bar, and the specific visual form it takes, as raw material for a later pass that folds all the lanes into one catalogue of widget ideas.

## ccstatusline

- **Repo:** https://github.com/sirmalloc/ccstatusline
- **Read:** src/types/Widget.ts, src/widgets/ContextBar.ts, src/widgets/ContextLength.ts, src/widgets/ContextPercentage.ts, src/widgets/shared/usage-display.ts, src/widgets/shared/progress-bar.ts, src/widgets/BlockTimer.ts, src/widgets/ThinkingEffort.ts, src/widgets/VimMode.ts, src/widgets/VoiceStatus.ts, src/widgets/SandboxStatus.ts, src/widgets/RemoteControlStatus.ts, src/widgets/ClaudeStatus.ts, src/widgets/GitPr.ts, src/widgets/GitCiStatus.ts, src/widgets/CompactionCounter.ts, src/widgets/FreeMemory.ts, src/widgets/Version.ts, src/widgets/SessionClock.ts, src/widgets/index.ts (widget list), src/types/FlexMode.ts, src/utils/renderer.ts, README.md

### What it displays

| Element | What it shows | How it is rendered | Defined at |
|---|---|---|---|
| Context Bar | Tokens used vs. context window, cycling through 4 display modes | `█`/`░` progress bar in `progress` (32-wide) or `progress-short` (16-wide, default) mode; `▓`/`░` slider bar (10-wide) in `slider`/`slider-only` mode; a `│` marks a time-cursor position when enabled; press `p` to cycle modes | `src/widgets/ContextBar.ts` |
| Context Length | Raw current context size in tokens | `Ctx: 18.6k` — bare abbreviated number, no colour threshold | `src/widgets/ContextLength.ts` |
| Context % | Percentage of context window used or remaining | Plain `NN%` text, or routed through the same slider-bar/time-cursor mechanism as Context Bar; press `u` to flip used/remaining | `src/widgets/ContextPercentage.ts` |
| Block Timer | Elapsed time within the current 5-hour billing block | `[████░░░░] 42%` bracketed bar (via `makeTimerProgressBar`, `█`/`░`) or a bare `3hr 45m` in time mode; a `│` cursor glyph can mark a point in the bar | `src/widgets/BlockTimer.ts`, `src/widgets/shared/progress-bar.ts` |
| Thinking Effort | Claude Code's current thinking-effort level | Plain text (`Thinking: high`); unrecognised levels get a trailing `?` (e.g. `super-max?`); Claude Code's "Ultracode" reports as `xhigh` with no separate glyph | `src/widgets/ThinkingEffort.ts` |
| Vim Mode | Current vim editor mode (NORMAL/INSERT/etc.) | 5 selectable formats cycled with `f`: `v-N` (icon-dash-letter), `v N`, bare icon, bare letter, or the full word; icon is `v` in plain mode or a Nerd Font glyph (``) toggled with `n` | `src/widgets/VimMode.ts` |
| Voice Status | Whether Claude Code voice input is enabled | A 🎤 emoji (or Nerd Font icon) plus a filled/hollow state dot (`●`/`○`); 4 selectable text formats | `src/widgets/VoiceStatus.ts` |
| Sandbox Status | Whether the session is running in a sandbox | Filled/hollow state dot (`●`/`○`), colour green by default | `src/widgets/SandboxStatus.ts` |
| Remote Control Status | Whether Claude Code remote control is attached | State dot (`●`/`○`) or a `✓`/`✗` check/cross mark, selectable across 6 text formats | `src/widgets/RemoteControlStatus.ts` |
| Claude Status | status.claude.com service indicator, with an optional 48-hour incident-history strip | Plain `Claude: ok/minor/major/critical` text coloured per severity; when history is on, an 8-cell strip of `▮` glyphs follows, each bucket individually coloured by its own incident severity — a miniature coloured sparkline of the last 48 hours | `src/widgets/ClaudeStatus.ts` |
| Git PR/MR | PR/MR status and title for the current branch, clickable | Clickable OSC-8 link; label auto-picks `PR` vs `MR` by host (GitHub vs GitLab-family) | `src/widgets/GitPr.ts` |
| Git CI Status | CI check status for the current branch's PR (GitHub only) | One glyph per state: `✓` success/passing, `✗` failing, `●` pending; colour green by default | `src/widgets/GitCiStatus.ts` |
| Compaction Counter | Count of context-compaction events this session, parsed from `compact_boundary` transcript markers | `↻ N` (icon-space-number, default) or `Compactions: N` or bare `N`; optional trigger-split suffix `(1 auto, 1 manual)` and optional reclaimed-tokens suffix `↓120K`; can hide entirely when count is 0 | `src/widgets/CompactionCounter.ts` |
| Memory Usage | System free/used memory | `NG`/`NM`/`NK`/`NB` magnitude-abbreviated bytes, unit picked automatically by size | `src/widgets/FreeMemory.ts` |
| Version | Claude Code CLI version | Bare version string, grey | `src/widgets/Version.ts` |
| Session Clock | Elapsed time since the session started | `<1m`, `Nm`, `Nhr`, or `Nhr Nm` — coarsening duration format | `src/widgets/SessionClock.ts` |
| Git branch/status family (Branch, Ahead/Behind, Changes, Clean Status, Conflicts, Deletions, Insertions, Staged/Unstaged/Untracked Files, SHA, Root Dir, Worktree ×5, Origin/Upstream Owner/Repo ×6) | ~25 separate widgets, each one fact about the repository's git state | Each is a bare coloured number, short code, or path fragment (no bars/gauges); several are hideable when zero via a shared "hideable state" mechanism | `src/widgets/Git*.ts` |
| Jujutsu (jj) family (Bookmarks, Changes, Deletions, Insertions, Description, Revision, Root Dir, Workspace) | Equivalent VCS facts for the Jujutsu version-control system | Same bare-text treatment as the git family, a parallel widget set for a different VCS | `src/widgets/Jj*.ts` |
| Token/speed family (Tokens Cached/Input/Output/Total, Input/Output/Total Speed) | Token counts and generation speed | Bare numbers/rates through a shared `speed-widget` renderer; supports raw or labelled display | `src/widgets/Tokens*.ts`, `src/widgets/*Speed.ts`, `src/widgets/shared/speed-widget.tsx` |
| Usage/weekly family (Session Usage, Weekly Usage, Weekly Opus/Sonnet Usage, Extra Usage Remaining/Used/Utilization, Fable Weekly Usage) | Billing-window usage figures across several time horizons and sub-models | All route through the same 5-mode display cycle as Context Bar/Percentage: time / progress (32-wide `█`/`░`) / progress-short (16-wide) / slider (10-wide `▓`/`░`) / slider-only | `src/widgets/*Usage.ts`, `src/widgets/shared/usage-display.ts` |
| Custom Command / Link / Custom Symbol / Custom Text | User-authored shell command output, a clickable link, an arbitrary symbol, or literal text | Custom Command can run in `preserveColors` mode so it emits its own raw ANSI untouched by the theme | `src/widgets/CustomCommand.tsx`, `src/widgets/Link.tsx`, `src/widgets/CustomSymbol.tsx`, `src/widgets/CustomText.tsx` |

### Layout and density

Up to 9 widget "lines," each an ordered list of widgets rendered with a configurable separator; three rendering styles (default text row, Powerline arrows, capsule). Width handling is a deliberate `flexMode` choice — `full` (fill terminal minus a 6-col margin), `full-minus-40` (always reserve 40 cols), or `full-until-compact` (reserve nothing until context usage crosses a `compactThreshold`, default 60%, then reserve 40) — plus an independent Powerline-only `autoAlign` mode that pads each widget to the same column width across multiple lines so segments line up vertically like a table, with a per-widget `excludeFromAutoAlign` escape hatch. There is no drop-priority; overflow is handled by the flex/align mechanisms, not by omitting widgets.

### Interaction

A full React/Ink terminal TUI (`ccstatusline` with no args) is the primary surface: a searchable, ranked widget picker; a per-widget editor with widget-specific single-key toggles (`p` progress mode, `u` used/remaining, `f` format cycle, `n` nerd font, `g` gradient colour picker, `x` selective-align exclusion, `k` clone widget); a colour picker supporting named colours, 256-colour, truecolor hex, and per-widget or whole-line gradients with named presets; live preview as edits are made.

### Config and setup UX

TUI-first (`npx ccstatusline` / `bunx ccstatusline`, no install required), backed by a JSON config file; also supports portable export/import with a replace-or-merge preview dialog, and an automatic Powerline-font installer that asks for consent before touching the system.

### The one thing here nobody else does

The widget count and surface area: ~90 distinct widgets (a near-complete git AND jujutsu VCS pair, 5 parallel usage-window widgets all sharing one 5-mode gauge system, per-widget/whole-line colour gradients) governed by one uniform display-mode/hideable-state/custom-keybind framework, plus a 48-hour incident-history sparkline on the Claude service-status widget that no other project's status indicator carries.

## claude-powerline

- **Repo:** https://github.com/Owloops/claude-powerline
- **Read:** src/segments/renderer.ts, src/segments/context.ts, src/segments/git.ts, src/segments/today.ts, src/utils/constants.ts, README.md

### What it displays

| Element | What it shows | How it is rendered | Defined at |
|---|---|---|---|
| Directory/branch/model/session-cost/session-id leading icons | Static per-segment icon prefix | One of two full icon sets selected wholesale — a Nerd Font/emoji set (`⎇` branch, `✱` model, `§` session cost, `◱` block cost, `◔` context, `◑` weekly cost) or a plain-ASCII fallback set (`~`, `M`, `S`, `B`, `C`, `W`) — never mixed per-segment | `src/utils/constants.ts` |
| Git segment | Branch name and clean/dirty/conflict state | Branch text plus one status icon: `✓` clean, `●` dirty, `⚠` conflicts | `src/segments/renderer.ts`, `src/segments/git.ts` |
| Context segment | Tokens used vs. model context limit, with an autocompact-buffer-aware "usable" percentage | A 10-cell bar selectable from **9 named bar styles**: `blocks` (`█`/`░`), `blocks-line` (`█`/`─`), `ball` (`─` track with a moving `●` marker), `capped` (`━`/`┄` with a `╸` end-cap), `dots` (`●`/`○`), `filled` (`■`/`□`), `geometric` (`▰`/`▱`), `line` (`━`/`┄`), `squares` (`◼`/`◻`); background/foreground escalate to a warning colour at ≤40% context remaining and critical at ≤20% remaining | `src/segments/context.ts`, `src/segments/renderer.ts` |
| Block / Today (weekly) cost segments | Session-block and rolling 24h/7d cost or token totals, with an optional user-set budget | Same 10-cell bar-style system as Context, plus a `{bar} {pct}%` compact form; budget-relative colour escalation (warning/critical) mirrors the context thresholds | `src/segments/renderer.ts`, `src/segments/block.ts`, `src/segments/today.ts` |
| Cache Timer | Time since the prompt cache was last refreshed, or time remaining until it expires (mode-selectable) | `elapsed` mode escalates to warning at ≥180s and critical at ≥300s; `remaining` mode escalates to warning under 300s and critical under 60s — same colour tokens as context/block, applied on the opposite side of the countdown | `src/segments/renderer.ts` (`renderCacheTimer`) |
| Metrics segment | Last-response time, average response time, session duration, message count, lines added/removed | Icon-prefixed space-joined parts (e.g. `⏱ 4.2s`, `# 12`), each part optional per config; falls back to a bare `new`/`active` word when no metrics are available yet | `src/segments/renderer.ts` (`renderMetrics`) |
| Thinking segment | Whether extended thinking is enabled and its effort level | `On`/`Off` and the effort word joined with `·`, e.g. `On · high` | `src/segments/renderer.ts` (`renderThinking`) |
| Tmux segment | Current tmux session name | Bare `tmux:<name>` or `tmux:none` | `src/segments/renderer.ts` (`renderTmux`) |
| Version segment | Claude Code CLI version | `v<version>` with icon prefix | `src/segments/renderer.ts` (`renderVersion`) |
| Env / Agent / Output-style segments | An arbitrary environment variable's value; the active subagent's name; the active output-style name | Bare `prefix: value` text, each independently hideable | `src/segments/renderer.ts` |

### Layout and density

Four style modes: `minimal` (default, plain text), `powerline` (arrow-separator segments, background-colour blocks), `capsule` (rounded pill segments), and a fourth style, `tui`, that is not a status line at all — it renders a full **bordered, multi-row/column panel** via a CSS-Grid-inspired layout engine: `display.tui.breakpoints` defines complete ASCII-art `grid-template-areas`-style layouts (e.g. `"git.head git.head context.bar context.bar block.time"`) that activate at different panel widths, with a title bar, footer, custom box-drawing characters, and a `fitContent`/`widthReserve`/`minWidth`/`maxWidth` sizing model — a fundamentally different rendering target from the single/few-line strip every other project in this survey produces.

### Interaction

None from the statusline process itself (prints once per hook call). Configuration interaction is external: a hosted web app, **Powerline Studio** (powerline.owloops.com), is a live visual configurator — click segments in a rendered preview to toggle options, switch styles/themes, and reorder, then copy or paste the resulting JSON directly into the config file. A local `--theme`/`--style`/`--charset` CLI flag set and a "Setup Wizard" slash command exist alongside it.

### Config and setup UX

A setup wizard (interactive, run inside Claude Code) walks theme/style/font/segment/budget selection; manual JSON config is also supported and documented with a schema; the external Powerline Studio site is the polish layer for anyone who'd rather configure visually than hand-edit JSON.

### The one thing here nobody else does

The `tui` style: an entirely separate CSS-Grid-like panel layout engine (named grid areas, responsive breakpoints, box-drawn borders/title/footer) that turns the statusline into a small dashboard rather than a line of text — no other project in this survey renders a bordered multi-row/column panel with responsive template areas.

## claude-code-usage-bar

- **Repo:** https://github.com/leeguooooo/claude-code-usage-bar
- **Read:** docs/segments.md, src/claude_statusbar/progress.py, src/claude_statusbar/styles.py, src/claude_statusbar/activity.py, src/claude_statusbar/themes.py, src/claude_statusbar/config.py, src/claude_statusbar/_display.py, src/claude_statusbar/core.py, commands/statusbar-preview.md, commands/statusbar-theme.md

### What it displays

| Element | What it shows | How it is rendered | Defined at |
|---|---|---|---|
| 5h/7d rate-limit battery bar | Current % used of the rolling 5-hour and 7-day quota windows | A 10-cell filled/empty battery bar (`█` fill / `░` empty) with the percent centered as text overlaid on the fill; fill colour green→yellow→red at 30%/70% (configurable) when no projection exists, or projected-severity colour (see next row) when one does; fill gradient darkens toward the tip by blending 35% toward black, anchored at exact severity colour on the leftmost cell | `src/claude_statusbar/progress.py` (`build_battery_bar`, `_build_dimension`) |
| Rate-limit projection chip (`→42%`) | Forecast end-of-window usage from a blended recent-pace/whole-window/day-night-weekend-bucket model | `→NN%` chip, muted below 70%, yellow ≥70%, red ≥85% — a distinct, higher threshold pair than the raw-usage bar, since it judges where usage is *headed* | `src/claude_statusbar/progress.py` |
| At-risk forecast chip (`⚠~18m`) | Imminent cap warning — shown only when projected to hit 100% within 1h and no projection chip is already shown | `⚠` + countdown, red if ≤10 min or in bare seconds, yellow otherwise | `src/claude_statusbar/progress.py` |
| Twinkling star-field bar background | Decorative fill for empty battery-bar cells (opt-in) | A static sparse field of `⋆` glyphs (deterministic per-cell hash, never adjacent, own per-bar seed) that occasionally flares to a brighter `✦`/`✧` in place | `src/claude_statusbar/progress.py` |
| Relay balance fuel gauge | Remaining $ on a third-party relay/API-key account (no-quota mode) | Same 10-cell battery-bar widget, inverted semantics — green when *full*, red when nearly *empty* (≤10% remaining), yellow ≤25%; falls back to plain `bal $809.97` text when the relay can't report a limit | `src/claude_statusbar/progress.py` |
| Countdown reset time + escalating emoji | Minutes until the 5h/7d window resets | `⏰1h28m` text with a trailing emoji that escalates as reset nears: none >30min, `⚡` ≤30min, `✨` ≤10min, 🎉 ≤1min | `src/claude_statusbar/progress.py` |
| Model + context usage | Model name and current context tokens used vs. limit | `Opus 4.8(350.0k/1.0M)` — parens muted grey, model name/numbers coloured by context-fill severity (green/yellow/red at 70%/85%) | `src/claude_statusbar/progress.py` |
| Prompt-cache countdown | Time left before the prompt cache expires (TTL auto-detected: 5min API-key / 1h subscription) | `cache 4m23s` text or `cache COLD`; green comfortable, yellow under 1 minute, red at `COLD` | `src/claude_statusbar/styles.py` |
| Session cost | Session cost in USD | Bare `$ 1.42`, neutral colour, opt-in | `src/claude_statusbar/progress.py` |
| Worktree/project/branch identity line | Git worktree name, project, branch, dirty marker, ahead/behind | `⑂ <worktree>` prefix (violet) only in a linked worktree, collapsed when it would repeat the branch; main checkout shows dimmed `⑂ trunk (N)` (N = linked-worktree count, shown even at 0); branch suffixed with `●` dirty marker and optional `↑2↓1` | `docs/segments.md`, `src/claude_statusbar/styles.py` |
| Session diff/duration stats | Lines changed and session elapsed time | `+182 -47` (green/red) and `⏱ 12m`, both opt-in | `src/claude_statusbar/styles.py` |
| Activity line (todo/tool) | The in-progress todo and the actively running tool, live-parsed from the transcript | `▸ <task> (3/7)` for the in-progress todo; `◐ <tool> <target>` (yellow) for the active tool; optional `✓ name×N` rollup of recently completed tools | `src/claude_statusbar/styles.py` |
| Subagent lines | One line per running background subagent | `◐ explore[haiku] <task> 2m15s`, off by default | `src/claude_statusbar/styles.py` |
| Session-mode line | Effort/thinking/fast-mode/output-style for the turn | `⚙ effort:high · think:on · fast:off · style:default`; the entire line is swept in a static two-colour gradient chosen by effort tier (7 named gradients, dusty teal→blue at `low` up to dusty magenta→pink at `ultracode`) | `src/claude_statusbar/styles.py` |
| AgentParty bridge block | Local multi-agent coordination status | Header with a signal-lamp glyph for listener state (`◉` watching/serving, `⊘` down, `◌` not listening), `⬡`/`⬢` agent/human icon, `N unread` chip; message line prefixed `●`/`○` unread/read plus `@` when mentioned | `src/claude_statusbar/styles.py` |
| IELTS language-coach progress | Per-language band score + trend (external plugin data) | `📚 EN:6.0↑ JA:5.0→` — two-letter code, numeric band, trend arrow | `src/claude_statusbar/progress.py` |
| Bypass-permissions flag | Session running with permission checks bypassed | Bold red `⚠️BYPASS` appended at line end | `src/claude_statusbar/progress.py` |
| Stale-quota fallback | Cached 5h/7d data gone stale | Replaces both bars with `⟳ 5h/7d stale·restart` (yellow) | `src/claude_statusbar/progress.py` |
| Version + update nudge | Installed version with an update hint | Faint dim `· v3.12.0`; amber `↑<newver>` appended when a newer release is cached | `src/claude_statusbar/styles.py` |

### Layout and density

Three swappable layout renderers — `classic` (pipe-separated single line), `capsule` (rounded background pill per segment), `hairline` (compact `┊`-separated 4-level micro-bars using `▁▃▆█` instead of the 10-cell battery bar) — selected by config. Width handling is a hard auto-compact: below a configurable width threshold the renderer force-switches to `hairline` rather than wrapping or dropping segments individually; a shared ANSI-safe `clip_line`/`clip_lines` truncates with an ellipsis as a backstop.

### Interaction

None at render time (pure print-once CLI). Configuration interaction happens through Claude Code slash commands that shell out to the CLI: `/statusbar-preview` renders all 3-style × 7-theme combinations against the user's real cached data; `/statusbar-theme <name>` and `/statusbar-style <name>` set and immediately re-preview from cached stdin; `/statusbar-doctor` diagnoses a broken/displaced installation.

### Config and setup UX

A single `cs config set <key> <value>` CLI (no schema/wizard) plus slash commands that wrap it and add a live-preview step from the last cached stdin payload.

### The one thing here nobody else does

The rate-limit bar's colour is driven by a learned *projection* of where usage will land at window-end (blended recent-pace/whole-window-average/day-night-weekend-bucket models), not by current usage — a bar can read green at 60% used if the model says it won't hit the cap, feeding a separate `→NN%` forecast chip and a near-cap `⚠~18m` countdown from the same projection.

## CCometixLine

- **Repo:** https://github.com/Haleclipse/CCometixLine
- **Read:** README.md, src/core/segments/context_window.rs, src/core/segments/git.rs, src/core/segments/usage.rs, src/core/segments/cost.rs, src/core/segments/update.rs, src/core/statusline.rs, src/ui/themes/theme_default.rs, src/ui/themes/presets.rs, src/ui/events.rs, src/updater.rs

### What it displays

| Element | What it shows | How it is rendered | Defined at |
|---|---|---|---|
| Model segment | Simplified Claude model name | Icon (🤖 or Nerd Font ``) + text, cyan | `src/ui/themes/theme_default.rs` |
| Directory segment | Current workspace directory | 📁/`b` icon in yellow, text in green | `src/ui/themes/theme_default.rs` |
| Git segment | Branch, clean/dirty/conflict state, ahead/behind, optional short SHA | Branch text; status glyph `✓` clean, `●` dirty, `⚠` conflict (via `UU`/`AA`/`DD` porcelain markers); `↑N`/`↓N` ahead/behind when nonzero | `src/core/segments/git.rs` |
| Context-window segment | Tokens used vs. model context limit | `NN% · N.Nk tokens`, conditional decimal precision, no colour-threshold logic in the segment itself | `src/core/segments/context_window.rs` |
| Usage segment (opt-in) | Billing-API utilization of the 5-hour and 7-day windows, plus reset time | Icon is itself the gauge — 8 discrete Nerd Font `circle_slice_1`…`circle_slice_8` codepoints selected by utilization percent in ~12.5%-wide bands, so the icon fills up like a clock face; reset time as `M-D-H` | `src/core/segments/usage.rs` |
| Cost segment (opt-in) | Session total cost in USD | `$0` under a cent, else `$N.NN`; 💰/`` icon in yellow, no thresholds | `src/core/segments/cost.rs` |
| Session/duration segment (opt-in) | Session elapsed time | ⏱️/`b` icon in green | `src/ui/themes/theme_default.rs` |
| Output-style segment (opt-in) | Active Claude Code output style | 🎯/`5` icon in cyan | `src/ui/themes/theme_default.rs` |
| Update-available notice | A newer CCometixLine release exists | `0 v<version>`; renders nothing until an update is actually ready | `src/updater.rs` |
| Powerline arrow separators | Visual transition between adjacent segment backgrounds | Nerd Font arrowhead `` recoloured per-pair (fg = previous bg, bg = next bg) | `src/core/statusline.rs` |
| Theme presets | Whole-bar colour/icon/style bundles | 9 built-in named themes (`cometix`, `default`, `minimal`, `gruvbox`, `nord`, `powerline-dark`, `powerline-light`, `powerline-rose-pine`, `powerline-tokyo-night`), loadable/overridable from user TOML files | `src/ui/themes/presets.rs` |

### Layout and density

Fixed segment order (Model, Directory, Git, Context, Usage, Cost, Session, Output-style), each individually enable/disable-able per theme; three separator/style modes (Plain, NerdFont, Powerline). The real CLI output for Claude Code is one unconditional line with no width awareness; the only width-aware behavior found is in the TUI's *live-preview* renderer, which hard-wraps to a new line when a segment or its separator would exceed the measured width, rather than truncating or dropping segments.

### Interaction

A full ratatui-based terminal TUI (`ccline -c`, or auto-launched with no piped input): arrow keys to move between segments, Enter to edit, Space to toggle a segment on/off, Tab to switch panels, `c` opens a colour picker, `i` opens an icon selector, `s` saves, `q` quits — with a live preview pane.

### Config and setup UX

The TUI is the primary configuration surface (menu → segment list → per-segment colour/icon editors, theme selector), backing a TOML config file (`~/.claude/ccline/themes/<name>.toml`) that a `cs config init/check/edit` CLI trio can also manipulate directly.

### The one thing here nobody else does

The opt-in usage segment's icon is itself the gauge — eight discrete pie-slice Nerd Font glyphs that fill progressively with utilization percent, so the icon (not a separate bar) is the visual meter.

## Yet Another Statusline (YAS!)

- **Repo:** https://github.com/tmck-code/yet-another-statusline
- **Read:** README.md, claude/yas/render/pill.py, claude/yas/constants.py, claude/yas/layout.py, claude/yas/info/subagents.py, claude/yas/render/tasks_view.py

### What it displays

| Element | What it shows | How it is rendered | Defined at |
|---|---|---|---|
| Context bar + state word | Context-window fill ratio against the compaction soft-limit | A `█`/`░` fill bar plus, when `context_state` is enabled, a morphing word (`Smart → Coasting → Foggy → Cooked → Dumb`) tinted the same threshold colour as the bar, at 4 configurable ascending thresholds (default 25/50/70/90%); the word sheds first when the box narrows | `claude/yas/context_state.py`, `claude/yas/constants.py` |
| Model "pill" border highlight | The active model/thinking-effort identity | A rounded-corner bulge cut INTO the box's own top/bottom border around the model field, drawn with block-quadrant glyphs (`▗`/`▄`/`▖` top, `▝`/`▀`/`▘` bottom) and filled with a colour gradient (anchor/shift RGB pair keyed to the model) swept across the pill's width by percent — the box frame itself changes shape to highlight one field | `claude/yas/render/pill.py`, `claude/yas/layout.py` |
| Tokens-over-time row (opt-in, wide layout only) | Live token throughput rate and its recent history | `t/m` rate plus an 8-level block-density sparkline ramp (`▁▂▃▄▅▆▇█`) with the in-flight (currently open) bucket dimmed | `claude/yas/constants.py` (`SPARK_RAMP`) |
| Subagent tree | Running/completed/killed/failed/resumed subagents, nested by parent | A file-tree-style layout with branch/elbow glyphs, each row marked by state: `✓` completed, `✗` killed/stopped ("ended early by intent"), `!` failed (ended by error), `↺` resumed-running | `claude/yas/info/subagents.py`, `claude/yas/constants.py` |
| Task-plan checkboxes | Task-list items and their status | 3-state glyph per row: pending (Nerd Font circle-outline, or `◌`/`○` in fallback charsets), active (a right-pointing arrow, `▸` in fallback), done (a filled check-circle, `◉` in fallback) | `claude/yas/constants.py` |
| Subagent-list header icon | The subagent/tasks section marker | `☰` (tasks list) in unicode mode, `⫶` (triple colon, "stacked list") in the GitHub-paste-safe charset | `claude/yas/constants.py` |
| Git info row | Directory path, branch name, and dirty-file counts | Path + branch text, followed only when dirty by glyph-prefixed counts: `•N` untracked (bullet, U+2022), `*N` modified, `-N` deleted, a file-move glyph `N` renamed — each term omitted entirely when its count is 0; a `path_git_compact`/branch-only fallback drops path and dirty detail in turn when the line doesn't fit | `claude/yas/renderer.py` (`path_git`), `claude/yas/constants.py` (`GLYPH_UNTRACKED`, `GLYPH_RENAMED`) |
| Skills + plugins trailing field | Loaded skills and plugins for the session | Fixed trailing column of the tokens/cost row, shown by default (this is literally the screenshot the README leads with) | README |
| Render-time annotation (opt-in) | Wall-clock time the previous render took | Woven directly into the bottom-right border, e.g. `…47.2ms──╯` — the timing number is spliced into the box's own border line rather than a separate field | README |
| Config-rejection warning row | One or more `yas.toml` values that failed validation | A single compact `⚠ yas.toml: N values ignored (...)` row appended at the bottom of the box, naming the rejected keys | README |

### Layout and density

A bordered, multi-row box (not a bare line) whose width responds to three explicit modes named by width band — "wide," "medium" (≤80 cols), "narrow" (≤55 cols) — each a genuinely different layout, not just truncation of the wide one (the README shows three distinct screenshots). Most extra rows (tool-use counts, tokens-over-time, day-stats) are opt-in and only appear in the wide layout; the context-state word is the one element documented to shed first under narrowing. A `full_width` flag makes the box fill the terminal instead of capping at `max_width`.

### Interaction

None described beyond the one-shot render; configuration is via `/yas:config`, a wizard-style slash command that re-runs setup against the already-installed plugin (theme/glyph mode/labels/soft-limit/Python version) without touching the plugin registration.

### Config and setup UX

A `yas.toml` file (not auto-created; absence means all-defaults) with a fully-commented example template, plus a strict env-var/CLI-flag override chain (`CLI flag → canonical env var → legacy alias → yas.toml → built-in default`); malformed config never crashes the render — invalid values silently drop to default and surface as the warning row described above. Four `glyph_mode`s (`nerdfont`, `ascii`, `unicode`, `github`) all preserve column geometry, letting the same layout survive a GitHub markdown paste, a bare terminal, or a full Nerd Font setup.

### The one thing here nobody else does

The "pill" mechanism: the box's own border is locally reshaped (bulged outward with quadrant-block glyphs) around one field to both highlight it and carry a colour gradient, rather than colouring or boxing the field's background — no other project in this survey treats its frame as a mutable, per-field highlight surface.

## claude-code-statusline (rz1989s)

- **Repo:** https://github.com/rz1989s/claude-code-statusline
- **Read:** docs/segments equivalent via source: lib/components/prayer_times.sh, lib/components/context_alert.sh, lib/components/burn_rate.sh, lib/components/code_productivity.sh, lib/components/wellness.sh, lib/components/context_window.sh, lib/prayer/display.sh, lib/wellness.sh, README.md

### What it displays

| Element | What it shows | How it is rendered | Defined at |
|---|---|---|---|
| Context window | Context tokens used vs. limit | `🧠 45% (90K/200K)`; green 0–50%, yellow 50–75%, red 75%+ with a trailing `⚠️` warning icon | `lib/components/context_window.sh` |
| Context alert (v2.1.50+) | Whether the session has exceeded a fixed 200K-token threshold | A bold red `>200K` label, present only when exceeded — a hard token-count trip-wire independent of the context-window percentage | `lib/components/context_alert.sh` |
| Burn rate | Cost accrual speed in the active billing block | `🔥$0.42/hr`, orange | `lib/components/burn_rate.sh` |
| Block projection | Estimated cost/tokens at the current block's end | `Est: $1.23 (45.2K)`, magenta | `lib/components/block_projection.sh` |
| Cache efficiency | % of block tokens served from cache | `Cache: 78% hit`, block-wide (falls back to current-turn efficiency when no active block) | `lib/components/cache_efficiency.sh` |
| Code productivity | Lines added/removed this session, from native hook fields | `+156/-23`, green/red, hideable when both are zero | `lib/components/code_productivity.sh` |
| Wellness / focus timer | Continuous coding time, with an optional Pomodoro-style focus session | `☕ Coding 20m/45m` base; when a focus session is active, ` │ FOCUS 23m/50m` appended, becoming ` │ FOCUS 23m ✓` on completion or `[FOCUS]` while abandoned-timeout tracking is armed | `lib/components/wellness.sh`, `lib/wellness.sh`, `lib/focus.sh` |
| Islamic prayer times | Time to the next of the 5 daily prayers, by calculated location | `<hijri-icon> <prayer-name> <time> (<remaining>)`; a completion-count form `🕌 3/5 completed`; colour changes for the imminent-next prayer | `lib/prayer/display.sh`, `lib/components/prayer_times.sh` |
| Hijri (Islamic lunar) date + moon phase | The Islamic calendar date alongside the prayer times | A moon-phase emoji selected by day-of-month (🌑 day 1, 🌒 days 2–7, 🌓 day 8, 🌔 days 9–14, 🌕 days 15–16, 🌖 days 17–22, 🌗 day 23, 🌘 days 24–30) — a full 8-phase lunar cycle mapped onto the Hijri month | `lib/prayer/display.sh` |
| Agent display (v2.1.50+) | Active subagent name when running with `--agent` | `Agent: <name>`, purple | `lib/components/agent_display.sh` |
| GitHub rate-limit warning | Remaining GitHub API calls when running low | `⚠️ GH:<remaining>@<reset-time>` | `lib/github.sh` |
| Bedrock model / MCP status/servers/native/plugins, repo info, commits, submodules, session mode, token usage, reset timer, version — ~18 more component modules | Additional facts (repository path/git status, MCP server health, Claude Code version, session cost tiers at daily/weekly/monthly granularity, vim mode) | Bare text/emoji per component, consistent with the style above; not independently re-verified per component | `lib/components/*.sh` |

### Layout and density

A fully modular 1–9 line display: each line is declared in TOML as an ordered list of component names (`display.line1.components = ["repo_info", "commits", "submodules"]`), so any component can go on any line in any order — there is no fixed row assignment. 18+ independently toggleable component modules, each with a standardized `collect_data()`/`render()`/`get_config()` interface; a legacy fixed 5-line layout remains as a fallback.

### Interaction

None described — this is a print-once shell/Node CLI hook script; all customization happens by editing the TOML config or running installer/CLI subcommands, not by interacting with the rendered bar itself.

### Config and setup UX

A hand-edited TOML file (`Config.toml`) is canonical, with an install script, shell completions (bash/zsh), and a documented multi-tier caching system; no visual/TUI configurator.

### The one thing here nobody else does

Islamic prayer times with a full Hijri lunar-calendar moon-phase indicator, and a wellness/focus break-reminder timer (Pomodoro-style) — a statusline that tracks the user's *life*, not just their session, alongside features (burn rate, block projection, cache efficiency, context alert) no other project in this survey names as distinctly.

## cship

- **Repo:** https://github.com/stephenleo/cship
- **Read:** src/modules/context_bar.rs, src/modules/context_window.rs, src/modules/usage_limits.rs, src/modules/cost.rs (via grep), src/modules/agent.rs, src/modules/vim.rs, src/explain.rs, src/passthrough.rs

### What it displays

| Element | What it shows | How it is rendered | Defined at |
|---|---|---|---|
| Context bar | Context-window usage, with generic threshold styling | `{bar} {pct:.0}%`, e.g. `███░░░░░░░ 35%`; `█`/`░` fill by default, both characters independently configurable | `src/modules/context_bar.rs` |
| Context window sub-fields (used %, remaining %, used/total tokens, size, input/output/cache tokens, `>200k` exceeded flag) | Nine independently renderable facts about context usage | Each routes through one shared threshold-styling function; a per-field `invert_threshold` flag lets "remaining %" fire its warn/critical styles on *low* values instead of high ones, without inheriting the parent's (used-%-oriented) thresholds by accident | `src/modules/context_window.rs` |
| Usage limits (5h/7d) | Rate-limit window utilization, per-period or per-model breakdown | A configurable-width `█`/`░` bar (`render_bar`); a `{pace}` token reports a signed % ahead/behind linear consumption (e.g. `+20%`, `-15%`, `?` when unmeasurable) | `src/modules/usage_limits.rs` |
| Extra-usage "active" indicator | Whether the account is currently rate-limited / burning extra usage | `⚡` when 5h or 7d utilization is at 100% (Pro/Max) or exceeds a configured threshold (Enterprise); `💤` otherwise | `src/modules/usage_limits.rs` |
| Agent name | Active subagent's name | `<symbol><name>`, symbol/style fully user-defined (e.g. `🤖 `) | `src/modules/agent.rs` |
| Vim mode | Current vim editor mode | `<symbol><raw mode string>`, symbol/style user-defined (e.g. `✏ INSERT`) | `src/modules/vim.rs` |
| Account, effort, peak-usage, session, workspace, model, cost modules | Account identity, thinking-effort level, historical peak usage, session facts, workspace path, model name, cost figures | Each follows the same generic `symbol + content`, optional `{value}`/`{symbol}` format-string substitution, and shared threshold-style resolution described above | `src/modules/*.rs` |
| Passthrough modules | Any of Starship's ~100 prompt modules (language versions, cloud provider, battery, etc.) not natively implemented by cship | Delegates verbatim to `starship module <name>` as a subprocess (5s file-cached, with `CSHIP_*` env injected in), rendering whatever ANSI Starship itself produces | `src/passthrough.rs` |

### Layout and density

A starship-style TOML config where segments are arranged freely into rows (tests confirm at least a `two_rows.toml` fixture); no bar-specific width-adaptive behavior was found in the modules read — width handling, if any, is inherited from the same model Starship itself uses via the passthrough path.

### Interaction

None at render time. A dedicated `cship explain` CLI subcommand is a configuration-introspection tool, not a live interaction: it prints a table of every native module's currently-rendered value alongside the exact config key/section controlling it, computed against either real stdin or a bundled sample context.

### Config and setup UX

A single `cship.toml`, deliberately styled after `starship.toml` (a `docs/examples/sample-starship.toml` fixture exists specifically to show the parallel), plus install scripts for POSIX (`install.sh`) and Windows (`install.ps1`); `cship explain` doubles as the discovery tool for "what can I configure and where."

### The one thing here nobody else does

Starship passthrough: any prompt module from the entire Starship ecosystem (not just Claude-specific data) can appear in a cship statusline by name, rendered by invoking the real `starship` binary as a subprocess — no other project in this survey can host a foreign prompt framework's modules verbatim.

## claude-statusline (TheoBrigitte)

- **Repo:** https://github.com/TheoBrigitte/claude-statusline
- **Read:** main.go, pkg/layout/layout.go, pkg/status/status.go, README.md

### What it displays

| Element | What it shows | How it is rendered | Defined at |
|---|---|---|---|
| `$model` | Model display name | `<symbol><name>`, symbol/style/format all user-configurable | `main.go` |
| `$context_bar` | Context-window usage as a bar | `<symbol>` + `#`/`-` fill bar (both characters configurable), width defaulting to one-quarter of terminal width (minimum 10 cols) when not fixed; colour escalates via generic warn/critical thresholds | `main.go` |
| `$context_tokens` | Raw current/window-size token counts | `<used SI>/<total SI> tokens`, SI-abbreviated | `main.go` |
| `$context_pct` | Context percentage used | Bare `NN` with symbol/format | `main.go` |
| `$cost` | Session cost | Generic threshold-styled value | `main.go` |
| `$duration` | Session duration | Generic-formatted value | `main.go` |
| `$status` | Claude API operational status | A single traffic-light emoji: 🟢 operational, 🟡 degraded, 🔴 error/unreachable (with the error text appended for 🔴); file-cached 10 minutes against status.claude.com | `pkg/status/status.go` |
| `$rate_5h` / `$rate_7d` | 5-hour/7-day rate-limit usage with reset countdown | `<pct>% (~<reset>)`-shaped via a `{value}`/`{symbol}`/`{reset}` format string; the `{reset}` placeholder and any immediately preceding non-space text (e.g. a `~`) self-remove when no reset time is available, so the template never dangles a stray `~` | `main.go` (`applyRateLimitFormat`) |

### Layout and density

Config declares one or more line templates as `$token`-delimited strings joined by a configurable separator (also the wrap breakpoint); segments pack left-to-right and auto-wrap onto a new line when the running width would exceed `termWidth - padding`, using the separator as the break point (a bin-packing wrap, not a hard truncate). Independently, **each module** can declare `min_term_width`/`max_term_width` in columns, so a module disappears entirely outside its width band — e.g. `$model` defaults to hiding under 80 columns — letting different modules drop out at different breakpoints rather than the whole line switching mode at once. The context bar additionally auto-sizes to one-quarter of terminal width when no fixed width is set.

### Interaction

None — a pure stdin-JSON-in, ANSI-text-out CLI with no live/clickable surface.

### Config and setup UX

A hand-edited TOML config file with documented global settings, per-module tables, and named style strings; five worked example configs in the README (Minimal, Two-Row Dashboard, Cost Monitoring, Tokyo Night, Compact Percentage Only) serve as the effective "how do I configure this" reference rather than a wizard or schema tool.

### The one thing here nobody else does

Per-module, independent min/max terminal-width visibility bounds — every other width-adaptive project in this survey switches the whole line's density or style at once; here each of the nine modules can have its own width band in which it exists at all, so different modules vanish at different points as the terminal narrows.

## claudia-statusline

- **Repo:** https://github.com/hagan/claudia-statusline
- **Read:** src/templates/default.tmpl, src/display.rs, src/gsd/mod.rs, src/theme.rs, src/layout/presets.rs, README.md (via directory listing/screenshot reference)

### What it displays

| Element | What it shows | How it is rendered | Defined at |
|---|---|---|---|
| Context bar (3-state, compaction-aware) | Context-window usage, tracking the compaction lifecycle rather than just a percentage | Three distinct renderings by state: **InProgress** → static text `Compacting...` (no bar — the tool acknowledges the bar can't animate fast enough to be worth drawing); **RecentlyCompleted** → `NN% [====>----] ✓` — the usual bar plus a green checkmark instead of a warning, to mark the compaction that just happened; **Normal** → `NN% [====>----]` with an `⚠` (orange) appended only when approaching the auto-compact threshold. The bar itself is ASCII: `=` fill, one `>` cursor glyph at the filled/empty boundary, `-` empty | `src/display.rs` (`format_context_bar`) |
| GSD (Get Shit Done) project-roadmap widget | Current project phase, task, and update status, read from an external `.planning/` directory (a third-party project-management convention, not Claude session data) | `<gsd_icon><phase>: <name> · <task>` style composition; the icon is a single fixed Nerd Font glyph (clipboard-check) whose **colour** encodes state: green = active task in progress, yellow = update available with no active task, red = stale (no activity beyond a configured hour threshold) — one glyph, three meanings carried entirely by colour | `src/gsd/mod.rs` |
| Git segment | Branch and working-tree status | `+N` added (green), `~N` modified, `-N` deleted, `?N` untracked — a 4-symbol diffstat-style summary rather than a single dirty marker | `src/display.rs` |
| Cost | Session cost, colour-escalated | `$N.NN` in a colour chosen by `cost_color(cost)` (threshold-based) | `src/display.rs` |
| Rate limits (5h/7d) | Window usage percentage with optional reset countdown | `<label>:<pct>% (<countdown>)`, countdown compacted to `NdNh`/`NhNm`/`Nm` by magnitude | `src/display.rs` (`format_reset_countdown`, `rate_limit_piece`) |
| Token rates | Live input/output token throughput | Selectable per-unit display (`tok/s`/`tok/min`/`tok/hr`) and mode: `detailed` shows `In:5.2K Out:8.7K tok/hr` (input rate folds in cache-read rate so it isn't near-zero on long sessions), with `output_only`/`input_only` variants; values ≥1000 auto-abbreviate to `N.NK` | `src/display.rs` (`format_token_rates`) |
| Themes | Whole-bar colour palette | 10 built-in named themes (dark, light, gruvbox, nord, dracula, monokai, catppuccin, solarized, one-dark, tokyo-night, high-contrast), loaded from embedded or user TOML | `src/theme.rs`, `themes/*.toml` |
| Layout presets | Whole-line composition | 3 named presets — `compact`, `detailed`, `minimal` — selectable independent of theme, backed by a full template mini-language (`{if x}...{endif}`, `{sep}`) rather than fixed field lists | `src/layout/presets.rs`, `src/templates/default.tmpl` |

### Layout and density

One line, composed from an `{if field}...{sep}...{endif}` conditional template language (`default.tmpl`: directory → git → GSD block → context → model → cost, each section skipped cleanly when its data is absent) rather than a fixed field order; no terminal-width-adaptive behavior was found in the files read — width handling was not evidenced beyond a fixed `progress_bar_width` config value for the context bar.

### Interaction

None from the bar itself. A rich supporting CLI does exist (health checks, database maintenance, sync, migration subcommands) but these operate on the tool's SQLite-backed usage-history store, not on the rendered statusline as a UI.

### Config and setup UX

A hand-edited TOML config plus a template-string layout language for custom compositions; a SQLite database (with an optional Turso cloud-sync backend) persists usage history across sessions for the daily/monthly aggregation and token-rate features, which is a materially heavier persistence layer than any other project in this survey — most others recompute everything per render or use a flat file cache.

### The one thing here nobody else does

The context bar's three-state compaction awareness (`Compacting...` / a green-checkmarked "just compacted" state / the normal warning bar) — every other project's context bar is a stateless function of the current percentage; this one also renders the *transition* around a compaction event. The GSD external-roadmap widget (reading a `.planning/` directory that isn't Claude Code's own state at all) is a second, independent claim to novelty.

# Widget inventory C — the oddities, plus the two ancestors

This lane covers six small single-purpose statuslines (claude-code-statusline, claude-code-tamagotchi,
claude-carbon, Token Tracker, claude-pace, which-claude-code), the Powerline framework that most
segment-bar vocabularies in this whole survey descend from, and gitui's git-state displays. The
inventory is raw material for a later pass that folds every lane into one catalogue of widget ideas —
every row below is a thing observed, not a recommendation.

## claude-code-statusline (kcchien)

- **Repo:** https://github.com/kcchien/claude-code-statusline
- **Read:** `statusline.sh`, `README.md`

### What it displays

| Element | What it shows | How it is rendered | Defined at |
|---|---|---|---|
| Context gauge | `context_window.used_percentage` | 10-cell block bar; in true-color mode each of the 10 cells is individually painted along a fixed green→yellow→orange→red RGB gradient array (`GRAD_R`/`GRAD_G`/`GRAD_B`), so a half-full bar is visibly two-toned rather than one flat color; falls back to one flat ANSI color (green/yellow/red by the same 70/90 thresholds) when truecolor isn't available, and to `#`/`-` ASCII glyphs under `CLAUDE_STATUSLINE_ASCII=1` | `statusline.sh:151-197` |
| Context percentage | same field | integer percent text colored green/yellow/red at the 70/90 thresholds, with a warning glyph (`⚠`) appended only at ≥90% | `statusline.sh:199-206` |
| Context window size hint | `context_window.context_window_size` | dimmed literal `1M` or `200k` suffix, shown only when the model's display name doesn't already say "context" (a duplication guard) | `statusline.sh:209-216` |
| Session cost | `cost.total_cost_usd` | `$X.XX`, color escalates gray (exactly $0.00) → yellow (any nonzero) → red (≥$10) | `statusline.sh:220-227` |
| Elapsed duration | `cost.total_duration_ms` | `Nm Ns`, the whole segment is omitted entirely when the formatted value would be `0m0s` ("smart hiding") | `statusline.sh:231-241` |
| Git branch + dirty | branch name via cache, working-tree diff/staged-diff check | branch name suffixed with a bare `*` when dirty; no color coding | `statusline.sh:243-282` |
| Lines changed | `cost.total_lines_added/removed` | `+N/-M` in green/red, the whole segment hidden when both are zero | `statusline.sh:286-291` |
| Rate limits | `rate_limits.five_hour/seven_day.used_percentage` | `5h:N% 7d:N%`, dim gray normally, switches to red only at ≥80%, the whole segment omitted when both are absent | `statusline.sh:295-309` |
| Agent/worktree tag | `agent.name` or `worktree.name` | yellow `⚙ name` or `⚙ worktree:name`, shown only in non-primary sessions | `statusline.sh:352-357` |
| Prompt-glyph color | context percentage | a `❯` prompt glyph (unused in the final 2-line output but computed) whose color tracks the same 70/90 thresholds as the bar, so every context-linked element in the script shares one threshold table | `statusline.sh:311-315` |

### Layout and density

Fixed two-line output, unconditional order, no wrapping or width awareness at all — every segment
is string-concatenated and printed regardless of terminal width. Density is controlled entirely by
"smart hiding": zero-valued segments (duration, line changes, rate limits) are dropped from the
line rather than shown as `0`, which is the script's only concession to keeping the bar short.

### Interaction

None. It is a stateless render-and-exit script invoked once per hook tick; nothing in it responds
to a click or keypress.

### Config and setup UX

Environment variables only (`CLAUDE_STATUSLINE_ASCII`, `_NERDFONT`, `_POWERLINE`, plus the ambient
`COLORTERM`), set by hand in a shell rc file. No schema, no validation, no wizard — a bad value is
silently ignored by the `if`/`elif` chain that reads it.

### The one thing here nobody else does

Per-cell truecolor gradient painting inside a single progress bar (ten independently colored
block characters along a fixed RGB ramp) rather than one flat color chosen by the overall
percentage.

## claude-code-tamagotchi

- **Repo:** https://github.com/Ido-Levi/claude-code-tamagotchi
- **Read:** `src/index.ts`, `src/animations/index.ts`, `src/engine/PetEngine.ts`,
  `src/engine/DecaySystem.ts`, `src/engine/ActivitySystem.ts` (referenced), `src/utils/config.ts`,
  `claude-commands/pet-feed.md`, `claude-commands/pet-play.md`, `README.md`

### What it displays

| Element | What it shows | How it is rendered | Defined at |
|---|---|---|---|
| Pet sprite | the pet's current animation state (idle, blink, happy, eating, sleeping, walking, playing, sad, love, tired, sick, bathing, celebrating) | multi-frame kaomoji ASCII-art animation, e.g. idle cycles `(◕ᴥ◕)` → `(◕ᴗ◕)` → `(◔ᴥ◔)` → … across up to 15 frames, one frame advanced per statusline refresh; some animations loop, others (eating, playing, bathing, celebrating, love) play once and stop | `src/animations/index.ts:11-230` |
| Pet name | user-assigned name | plain text after the sprite | `src/engine/PetEngine.ts:291` |
| Action-in-progress icon | `pendingAction.type` and `.item` | an item-specific emoji appended to the sprite — a lookup table of 8 food emoji (🍪🍕🍣🍎🥕🥩🐟🍬) and 5 toy emoji (🎾🥏🔴🧶🧩), falling back to a generic action emoji for sleeping (😴) or bathing (🛁) | `src/engine/PetEngine.ts:296-325` |
| Mood glyph | derived from `happiness`, `isAsleep`, `isSick` | a single emoji chosen by a fixed threshold ladder: 😴 asleep, 🤒 sick, 😊 >80 happiness, 🙂 >50, 😐 >30, else 😢 — shown only when no action is pending | `src/engine/PetEngine.ts:349-359` |
| Session-length badge | `sessionUpdateCount` (number of statusline refreshes this session) | milestone emoji appended once thresholds are crossed: 🔥 past 200 updates, 💪 past 100, ✨ at exactly 50/100/150 | `src/engine/PetEngine.ts:334-341` |
| Need alerts | `hunger`, `energy` below 20 | 🍖 appended when hungry, 💤 appended when sleepy — both can appear simultaneously alongside the mood glyph | `src/engine/PetEngine.ts:343-347` |
| Stat readout | `hunger`, `energy`, `cleanliness`, `happiness`, each 0-100 and decaying over real time | four `emoji N%` pairs (🍖 ⚡ 🧼 ❤️); the first three append a ⚠️ when under 30%, happiness never gets the warning glyph | `src/engine/PetEngine.ts:371-397` |
| System message | a transient event notice (e.g. "leveled up") | plain text prefixed 💬, auto-expires 10 seconds after being set | `src/engine/PetEngine.ts:411-423` |
| Thought bubble | either a stats/mood-derived "thought" or an LLM-generated observation about the current conversation | plain text prefixed with a feedback-specific icon if one exists, else 💭; conversation-relevant thoughts appear with probability `conversationThoughtRatio` instead of the generic mood thought, and expire after 30 seconds | `src/engine/PetEngine.ts:425-451` |
| Directory / model tags | `cwd`, `model.display_name` | `📁 dirname` (truncated to 17 chars + `...`) and `🤖 ModelName`, each independently toggleable via env var | `src/index.ts:77-88` |

### Layout and density

One unconditional line: `pet | stats | 📁 dir | 🤖 model | message-or-thought`. Directory and
model segments can be individually disabled via env vars (`PET_SHOW_DIRECTORY`, `PET_SHOW_MODEL`),
and the message/thought slot is a single priority stack (system message beats conversational
thought beats mood thought) rather than showing more than one at a time. No width awareness, no
wrapping, no compact mode — the line is exactly as long as whichever segments are enabled.

### Interaction

Ten dedicated slash commands (`/pet-feed`, `/pet-play`, `/pet-clean`, `/pet-sleep`, `/pet-wake`,
`/pet-pet`, `/pet-name`, `/pet-reset`, `/pet-stats`, `/pet-help`) that shell out to the same CLI
binary the statusline itself runs, each mutating persisted pet state that the next render reflects.
The bar is also driven passively: it detects keywords in the user's own prompts
(`activitySystem.detectKeywords`) to react to what the user is doing, and it degrades stats on a
real-time decay clock even between sessions.

### Config and setup UX

Environment variables (`.env.example`) plus a `setup.sh` installer; behavior toggles include
`enableWeatherEffects`, `enableEvolution`, `enableLogging`/`debugMode`, and a fixed `weather` value
(`sunny`/`rainy`/`snowy`/`cloudy`) that nudges the decay rates of energy/happiness/cleanliness. No
schema validation — bad env values fall through to hardcoded defaults.

### The one thing here nobody else does

A full virtual-pet simulation (hunger/energy/cleanliness/happiness/health stats that decay in real
time, sicken, evolve, and are fed/played-with through slash commands) rendered as an animated
kaomoji sprite in the statusline — nothing else in this survey treats the bar as a game rather than
a readout.

## claude-carbon

- **Repo:** https://github.com/gwittebolle/claude-carbon
- **Read:** `scripts/statusline.sh`, `scripts/equiv-lib.sh`, `scripts/generate-badge.sh`,
  `skills/carbon-card/SKILL.md`, `templates/report-summary.html`, `data/factors.json`, `README.md`

### What it displays

| Element | What it shows | How it is rendered | Defined at |
|---|---|---|---|
| Context gauge | `context_window.used_percentage` | 10-block bar (`▓`/`░`) plus a colored dot: 🟢 under 60%, 🟡 60-79%, 🔴 ≥80% — at ≥80% the percentage text itself is replaced with the literal word `COMPACT!` instead of a number | `scripts/statusline.sh:99-116` |
| CO2 estimate | cumulative session emissions | grams or, above 1000g, `X.Xkg`, suffixed `CO₂`; sourced from a SQLite row written by a Stop hook when available (session-cumulative, includes cache/subagent tokens) and falls back to a snapshot estimate from the live context window otherwise — the fallback is explicitly a different, smaller quantity than the DB figure | `scripts/statusline.sh:60-79` |
| Cost | `cost.total_cost_usd` | plain `$X.XX` | `scripts/statusline.sh:82` |
| 5-hour quota | `rate_limits.five_hour` (stdin) or a cached OAuth `/api/oauth/usage` call (60s TTL) | `Use N%` with a reset-time suffix `↻HH:MM`; a 🔥 prefix appears only when projected burn rate — usage percent scaled by elapsed-vs-total window time — would exceed 100% before reset, gated by a 15-minute grace period and a 15% usage floor to ignore bursty starts | `scripts/statusline.sh:129-206` |
| Git branch | current branch | ` ⌥ branch`, no color, omitted on detached HEAD | `scripts/statusline.sh:209-213` |
| Update nudge | a background version-check flag file | `⬆ vX.Y.Z /carbon-update`, shown only while the flag is fresh (7-day self-expiry) so an abandoned background checker goes silent on its own | `scripts/statusline.sh:216-231` |
| Install-drift warning | byte/value comparison between this install's factor/price data files and the newest cached plugin-marketplace copy | `≠ install drift`, appears only when the two JSON files disagree after stripping `_`-prefixed documentation keys (so a comment-only edit doesn't false-positive) | `scripts/statusline.sh:233-266` |
| Monthly share nudge | first–10th of each month, until a card has been generated for that month | `📊 August wrapped · /carbon-card` | `scripts/statusline.sh:268-286` |
| Shareable report card (not the bar itself) | monthly CO2 history | a PNG card built from an HTML template with a CSS bar chart (`.bar-row`/`.bar-track`/`.bar-fill`) and equivalence conversions (e.g. "= 3.5 km driven") drawn from locale-specific factor tables (`fr`/`us`/`world`) auto-selected from `LANG`/`LC_ALL`/OS locale | `templates/report-summary.html:119-166`, `data/factors.json`, `scripts/equiv-lib.sh` |
| Shields.io badge (not the bar itself) | all-time CO2 total | a static badge URL/markdown snippet, e.g. `claude-carbon-1.2kg CO2e-2f6f4f` | `scripts/generate-badge.sh` |

### Layout and density

One unconditional line built by string concatenation (`project branch | dot model bar pct | $cost · CO2 usage-segment update-segment drift-segment card-segment`); several trailing segments are conditionally appended or omitted (update nudge, drift warning, card nudge), so line length varies session to session, but nothing reacts to terminal width — a long line simply wraps at the terminal's discretion.

### Interaction

None in the bar itself (print-once script). Slash commands (`/carbon-card`, `/carbon-badge`,
`/carbon-report`, `/carbon-update`) invoked separately generate the report/badge/card artifacts and
open them in the OS file manager; these are full side executions, not bar clicks.

### Config and setup UX

`setup.sh` installer plus `configure-settings.sh`; runtime behavior is env-var gated (opt-outs like
`CLAUDE_CARBON_NO_UPDATE_NOTIFIER`, `CLAUDE_CARBON_NO_DRIFT_CHECK`, `CLAUDE_CARBON_NO_CARD_NUDGE`,
a locale override `CLAUDE_CARBON_LOCALE`). No interactive wizard for the statusline itself; the
`--segment` flag lets another statusline embed just the cost+CO2 pair as a sub-widget.

### The one thing here nobody else does

Converting a technical quantity into human-legible equivalence units (km driven, smartphone
charges, steaks) via a locale-detected conversion table, and projecting quota burn rate forward
against a reset countdown to decide whether to show a fire emoji before the limit is actually hit.

## Token Tracker (tt)

- **Repo:** https://github.com/stormzhang/token-tracker
- **Read:** `src/token_tracker/templates/claude_statusline.py`, `src/token_tracker/ui/heatmap.py`,
  `src/token_tracker/ui/theme.py`, `src/token_tracker/ui/sidebar.py`,
  `src/token_tracker/ui/sidebar_app.py`, `README.md`

### What it displays

| Element | What it shows | How it is rendered | Defined at |
|---|---|---|---|
| Project + git | project dir name, branch, diff stats | `[name]` bold, then `(branch +A -D ?U)` where `+`/`-` are tracked added/deleted line counts (green/red) and `?` is an untracked-file count | `src/token_tracker/templates/claude_statusline.py:223-236` |
| Session total tokens | live re-parse of the session transcript, deduped by `message_id:requestId` | `Total: fmt_tokens(in+out+cache)` with `k`/`M` suffixing | `src/token_tracker/templates/claude_statusline.py:239-244`, `src/token_tracker/templates/claude_statusline.py:189-215` |
| Cost | `cost.total_cost_usd` | `Cost: $X.XX` | `src/token_tracker/templates/claude_statusline.py:247-249` |
| Code changed | `cost.total_lines_added/removed` | `Code: +N -M`, colors match line 1's git +/- | `src/token_tracker/templates/claude_statusline.py:252-257` |
| Rate-limit gauges | `rate_limits.five_hour/seven_day` | an 8-cell (narrower at small width) block-gauge per window via a shared `progress_bar()` helper: fill color green<50%/yellow<80%/red≥80%, empty cells tinted the same color rather than left neutral gray, percent text appended, reset countdown dimmed alongside | `src/token_tracker/templates/claude_statusline.py:61-73`, `src/token_tracker/templates/claude_statusline.py:263-278` |
| Context gauge | `context_window.used_percentage` | same shared block-gauge/threshold function as the rate-limit gauges, labeled with the window size (`fmt_tokens(size)`) | `src/token_tracker/templates/claude_statusline.py:279-286` |
| Token breakdown | context-window in/out/cache token counts | `Tokens: in X, out Y, cache Z` | `src/token_tracker/templates/claude_statusline.py:293-300` |
| Output speed | tokens/sec, computed as a delta over successive renders (min 500ms / 20 tokens to update, else holds the previous value rather than flashing a spurious near-zero) | `Out TPS: N tokens/s` | `src/token_tracker/templates/claude_statusline.py:178-188`, `src/token_tracker/templates/claude_statusline.py:301-303` |
| Model/effort/duration/remote | model name, effort level, duration, remote repo host | `Model: Name/effort/fast-or-nofast`, `Duration: …`, `Remote: host` | `src/token_tracker/templates/claude_statusline.py:307-324` |
| Daily contribution heatmap (separate `tt daily` view, not the bar) | a year of daily token usage | GitHub-contribution-graph style: 7 rows (weekdays) × 53 columns (weeks) of colored `■` cells at 5 intensity levels, forced 24-bit color, month-header row, and a summary panel above it (12-month / this-month / this-week metrics plus peak-day and current/longest streak) | `src/token_tracker/ui/heatmap.py:1-90` |
| Interactive session sidebar (separate `tt sidebar` app, not the bar) | live per-session token/cost stats across all open terminals | a Textual TUI panel: a running star-shaped spinner and a live-updating multi-timezone clock row in the header, click-to-jump on a session row (resolves the session's terminal via iTerm2/tmux pane IDs and focuses it), mouse-drag text selection with auto-copy to clipboard | `src/token_tracker/ui/sidebar_app.py:424-470`, `src/token_tracker/ui/sidebar.py:189-243` |
| Theme picker (separate `tt themes` view) | available color themes | live preview via a temporary theme override context manager before committing | `src/token_tracker/ui/theme.py:35-44` |

### Layout and density

Four fixed lines (project/totals, rate-limit+context gauges, token breakdown+speed, model/duration),
each independently width-checked against the terminal's real column count: every line drops its
trailing segments one at a time (`while vlen(...) > W: pop()`) until it fits, and the block-gauge
width itself steps down (8 → 6 → 4 cells) as available width shrinks. The rate-limit/context row
additionally tries three fallback renderings per window — full text, gauge without countdown,
bare percent — before dropping to the shortest that fits.

### Interaction

The statusline itself is print-once, but the same install ships a live sidebar TUI (`tt sidebar`)
that click-jumps to the originating terminal window/pane, a `tt daily`/`tt weekly`/`tt monthly`
heatmap/table view, and a `tt themes` picker with live preview — all separate commands from the
statusline hook, not affordances inside the bar.

### Config and setup UX

A `wizard.py`-driven interactive setup plus a themes picker; per-theme palettes are declared data
resolved once per process and cached (`_SLOTS_CACHE`), with truecolor/256-color detection gated on
`COLORTERM`.

### The one thing here nobody else does

The GitHub-contribution-style calendar heatmap for a year of daily usage, and a companion live TUI
sidebar that lets a click jump focus to the actual terminal pane a session is running in.

## claude-pace

- **Repo:** https://github.com/Astro-Han/claude-pace
- **Read:** `claude-pace.sh`, `README.md`

### What it displays

| Element | What it shows | How it is rendered | Defined at |
|---|---|---|---|
| Model + effort | `model.display_name`, `effort.level` | `Model (ContextLabel) effort`, truncated with `…` past 28 characters (sized to fit the longest effort word) | `claude-pace.sh:143-153` |
| Context progress bar | `context_window.used_percentage`, or usage against `CLAUDE_CODE_AUTO_COMPACT_WINDOW` when that env var is set | 10-cell `█`/`░` bar colored green/yellow/red at 70/90% thresholds; when the auto-compact env var is set, the percentage is recomputed against the compaction threshold instead of the full context window, and the context-size label switches to match, so the bar measures "distance to compaction" rather than "distance to full" | `claude-pace.sh:157-198` |
| Git branch + diff | branch, file count, added/deleted lines | `project (branch) Nf +A -D`, cached 5 seconds keyed by directory hash so concurrent sessions in different repos don't collide | `claude-pace.sh:112-125`, `claude-pace.sh:220-238` |
| Worktree identity | `.claude/worktrees/<name>` path pattern | falls back to `repo/worktree-name` display when on a detached HEAD inside a worktree, so identity survives even without a branch name | `claude-pace.sh:242-249` |
| Rate-limit usage + pace delta | `rate_limits.five_hour/seven_day.used_percentage` and `.resets_at` | `N%` colored green/yellow/red at 70/90%, followed by a burn-rate delta glyph: `⇡N%` in red when usage is running ahead of the window's elapsed-time pace (overspending), `⇣N%` in green when running behind (headroom) — computed as `used% − (elapsed/window)×100` — then a dimmed countdown (`Nd`/`Nh`/`Nm`) to reset | `claude-pace.sh:255-278` |
| Session cost | `cost.total_cost_usd` | `$X.XX`, shown only when rate-limit data is unavailable in stdin (so cost and quota-pace are presented as alternatives, never both) | `claude-pace.sh:283-285` |

### Layout and density

Two fixed lines, but the two lines are re-padded on every render so their `|` separators land in
the same column regardless of how long the left-hand content of each line is (`W1`/`W2` measured
on the plain-text length, then the shorter side gets space-padded) — a vertical-alignment effect
distinct from anything else in this lane, done purely to make the two-line block look like one
aligned table rather than two independent strings. No width-vs-terminal awareness otherwise; both
lines are emitted unconditionally.

### Interaction

None; print-once script, installed as a Claude Code plugin or a bare file.

### Config and setup UX

A `/claude-pace:setup` slash command drives the plugin install; runtime behavior otherwise reads
only ambient env vars (`CLAUDE_CODE_AUTO_COMPACT_WINDOW`) and Claude Code's own `settings.json`
(`effortLevel` fallback) — no dedicated config file or schema of its own.

### The one thing here nobody else does

The pace-delta glyph: comparing quota-used percentage against elapsed-percentage-of-window to show
whether the user is currently burning faster or slower than a linear pace toward the reset, as a
signed percentage rather than a raw usage number.

## which-claude-code

- **Repo:** https://github.com/jbarbier/which-claude-code
- **Read:** `bin/statusline.sh`, `bin/update-session-title.sh`, `README.md`

### What it displays

| Element | What it shows | How it is rendered | Defined at |
|---|---|---|---|
| Session identity dot | nothing data-driven — a fixed marker | a bare `●` glyph at the start of the line, in the session's deterministic color (see below) | `bin/statusline.sh:98` |
| Session title | an LLM-generated 3-6 word summary of the session's topic | plain bold text in the session's deterministic color; generated asynchronously in the background by a `claude -p --model haiku` call triggered on `UserPromptSubmit` and read from a per-session file; shows a `·  ·  ·` placeholder until the first generation completes | `bin/statusline.sh:47-53`, `bin/update-session-title.sh:1-9` |
| Session color | `session_id` | one of 20 fixed 256-color codes, selected by `cksum session_id % 20` — deterministic per session, so two parallel Claude Code panes never coincidentally share a color and the same session always re-renders the same color across restarts | `bin/statusline.sh:33-40` |
| Model / dir / branch | `model.display_name`, abbreviated cwd, git branch | dimmed `model short-cwd (branch)`; cwd is collapsed to `~` for home and truncated to its last two path segments | `bin/statusline.sh:9,22-30,62-66` |
| Usage suffix | `context_window.used_percentage`, `rate_limits.five_hour/seven_day.used_percentage` | `ctx:N% · 5h:N% · 7d:N%`, each segment shown only when its field is present; a rounded value that would display as `0%` is instead rendered `<1%` so a fresh window doesn't read as broken/zero | `bin/statusline.sh:68-98` |

### Layout and density

One unconditional line, no width awareness, no wrapping. Segments beyond the fixed dot/title are
conditionally included only insofar as their source fields are present in the hook payload — there
is no priority-drop or truncation behavior.

### Interaction

None in the bar. The title-generation pipeline is itself a small piece of interaction machinery:
a `UserPromptSubmit` hook shells out to a background `claude -p` call, guarded by six independent
defenses (an inherited env flag, content-based self-recursion detection, a per-session lock, a
cooldown, a bounded/self-owned prompt history, and a hard timeout with silent failure) to prevent
that background call's own hook events from recursively spawning more background calls.

### Config and setup UX

A `/setup` slash command installs the hook and statusline command; no user-facing configuration
surface beyond that — behavior is fixed.

### The one thing here nobody else does

A deterministic per-session color (hashed from the session ID into a fixed palette) so that
multiple simultaneous Claude Code panes are visually distinguishable at a glance, paired with an
LLM-generated live session title instead of any literal field from the hook payload.

## Powerline

- **Repo:** https://github.com/powerline/powerline
- **Read:** `powerline/segments/common/bat.py`, `powerline/segments/common/sys.py`,
  `powerline/segments/common/net.py`, `powerline/segments/common/wthr.py`,
  `powerline/segments/common/mail.py`, `powerline/segments/common/time.py`,
  `powerline/segments/common/env.py`, `powerline/segments/common/vcs.py`,
  `powerline/segments/common/players.py`, `powerline/segments/i3wm.py`,
  `powerline/segments/vim/__init__.py`, `powerline/colorscheme.py`, `powerline/renderer.py`,
  `powerline/config_files/colorschemes/vim/default.json`,
  `powerline/config_files/themes/powerline_unicode7.json`, `docs/source/configuration/listers.rst`

### What it displays

| Element | What it shows | How it is rendered | Defined at |
|---|---|---|---|
| Gradient color system | any segment that opts in by emitting a `gradient_level` (0-100) alongside its content | a named gradient is a *list* of colors (e.g. cterm and truecolor pairs); `pick_gradient_value` maps the 0-100 level onto that list by nearest-index rounding, so a segment's own numeric fact (load average, battery %, temperature) drives a continuous color pick instead of a hand-written threshold `if` chain — this is the mechanism nearly every other segment below reuses | `powerline/colorscheme.py:27-32,62-64` |
| Highlight-group fallback chains | every segment's color | each segment declares an ordered list of highlight-group names (e.g. `['battery_full', 'battery_gradient', 'battery']`); the colorscheme resolves the first one the active theme actually defines, so a theme can override as little as `battery_full` and inherit everything else from the generic `battery` group | `powerline/segments/common/bat.py:277,283,290,297` |
| Battery gauge | battery charge %, AC state | two mutually exclusive renderings selectable by the `gamify` flag: plain `{ac_state} {capacity:3.0%}` text, or a "hearts" gauge of `full_heart`/`empty_heart` glyph runs (default `O`/`O`, commonly overridden to `♥`) sized to a configurable step count, with charge level driving `battery_gradient` (least-alert at 0, most-alert at 100 — explicitly the inverse of most gauges, called out in the code) | `powerline/segments/common/bat.py:230-300` |
| System load | `os.getloadavg()` normalized by CPU count | plain number per load-average window, `gradient_level` computed as a linear interpolation between a configurable "good" and "bad" normalized-load threshold (0 below good, 100 above bad, proportional between) | `powerline/segments/common/sys.py:16-66` |
| CPU load percent | live CPU percent | plain `N%`, `gradient_level` set directly to the percent value | `powerline/segments/common/sys.py:94-95` |
| Uptime | system uptime | `Nd Nh Nm` with each unit's format string independently omittable | `powerline/segments/common/sys.py:151` |
| Network load | bytes/sec on an interface (auto-detected as the busiest non-loopback interface, or explicit) | `DL {value:>8}` / `UL {value:>8}` with human-scaled byte units (binary or SI prefix selectable); gradient only applied when a `*_max` threshold kwarg is configured, letting the same segment run gradient-less by default | `powerline/segments/common/net.py:194-282` |
| Weather | current condition + temperature (OpenWeatherMap) | a condition code is mapped through a lookup table to one of a small vocabulary (`stormy`/`rainy`/`snowy`/etc.), each with a default ASCII word (`STORM`) that a user config commonly overrides with a single unicode glyph (e.g. `❆`); temperature gradient interpolates between configurable coldest/hottest bounds | `powerline/segments/common/wthr.py:20-90,158-198` |
| Unread mail count | IMAP unread message count | plain count, `gradient_level` scaled against a configurable `max_msgs` so the alert color ramps up as the inbox fills rather than switching at one hard cutoff | `powerline/segments/common/mail.py:58-64` |
| Fuzzy time | wall clock time | natural-language phrasing instead of digits — "quarter past six", "twenty-five to nine", with special-cased strings for exact midnight/noon and the two minutes around midnight ("round about midnight"); the hour word list and minute-phrase table are both user-overridable | `powerline/segments/common/time.py:46-110` |
| Working directory breadcrumb | cwd, optionally with `~` substitution | not one string — each path component becomes its *own* powerline segment/cell with its own divider, so the directory renders as a chain of chevron-separated cells; supports shortening every parent component to N characters and/or collapsing depth beyond N levels behind an ellipsis cell | `powerline/segments/common/env.py:43-107` |
| Media player | now-playing track/artist/state, from any of 9 supported backends (cmus, MPD, dbus/MPRIS, Spotify via dbus or AppleScript, Clementine, Rhythmbox, RDIO, iTunes, MOC) | state-specific highlight group (`player_playing`/`player_paused`/`player_stopped`/`player_fallback`) so the whole segment recolors by playback state, independent of any gradient | `powerline/segments/common/players.py:39-56` |
| VCS branch | current branch, optionally dirty-state | plain branch name, with an opt-in `status_colors` flag that swaps in `branch_dirty`/`branch_clean` highlight groups ahead of the generic `branch` group in the fallback chain, and an `ignore_statuses` list so e.g. untracked-only dirt doesn't count as dirty | `powerline/segments/common/vcs.py:9-56` |
| VCS stash count | number of stash entries | plain count, segment simply absent (not zero) when there are none | `powerline/segments/common/vcs.py:59-81` |
| Vim mode indicator | vim's current mode (`normal`/`insert`/`visual`/…) | mode-name text through a translatable label table; critically, the *entire remaining bar's palette* can shift per mode via `mode_translations` in the colorscheme file — insert mode's JSON block remaps a dozen base colors to a blue family and overrides specific highlight groups, so the whole status line visibly changes temperature when entering insert mode, not just the mode segment itself | `powerline/segments/vim/__init__.py:92-114`, `powerline/config_files/colorschemes/vim/default.json` |
| Vim file-position | cursor line as % through file, or Top/Bottom/All | plain text or gradient-colored percent when `gradient=True` is set | `powerline/segments/vim/__init__.py:394-447` |
| Vim CSV column | for a detected CSV buffer, which column the cursor sits in | column index plus, when a header row is present, the column's header name | `powerline/segments/vim/__init__.py:759-786` |
| i3wm workspace list | every open window-manager workspace, one segment per workspace via a "lister" (see below) | per-workspace highlight group escalates `workspace` → `w_visible`/`workspace:visible` → `w_focused`/`workspace:focused` → `w_urgent`/`workspace:urgent`, so an urgent (demanding-attention) workspace is visually distinct from a merely-focused one | `powerline/segments/i3wm.py:11-24,66-177` |
| Repeated-per-entity segments ("listers") | any segment multiplied across a list of runtime entities — vim tabs, i3 workspaces, pdb frames | not a widget itself but a structural mechanism: a lister supplies a list of entities and the theme's segment group is instantiated once per entity, so "one cell per open tab" is data-driven rather than hand-authored per tab | `docs/source/configuration/listers.rst:1-17` |
| Divider glyphs | segment/group boundaries | two independent glyph pairs from the Powerline private-use-area font: "hard" dividers (U+E0B0 left-pointing chevron, mirrored as U+E0B2 for right-aligned sections) mark a background-color change, "soft" dividers (U+E0B1, mirrored as U+E0B3 — a thinner chevron) mark same-background segment boundaries within one group | `powerline/config_files/themes/powerline_unicode7.json` |
| Width-priority truncation | overall bar vs. available terminal width | every segment carries a numeric `priority`; when the bar doesn't fit, segments are dropped lowest-priority-first (segments with no priority are never dropped), and only after dropping is exhausted does per-segment `truncate` content-shortening kick in | `powerline/renderer.py:257-384` |

### Layout and density

Multiple independent bar instances per host application (vim status line, vim tabline, tmux status,
shell prompt, i3 bar, ipython prompt, pdb prompt) each with their own theme/segment configuration,
composed left-aligned and right-aligned sections. Density is explicitly managed: a numeric
per-segment `priority` drives ordered segment-dropping when content exceeds the available width,
falling back to per-segment content truncation only after priority-dropping is exhausted — this is
the most fully worked-out width-adaptive layout system in this whole lane.

### Interaction

None baked into the renderer itself for a passive statusline — Powerline is a rendering library, not
an interactive shell. The vim/i3/tmux bindings it ships do respond to the host application's own
state changes (mode switches, workspace focus) live, but that's the host driving re-render, not a
click/hover affordance on the bar.

### Config and setup UX

Hand-edited JSON configuration across several layered files: `colors.json` (named palette),
per-context `colorschemes/*.json` (which highlight groups map to which named colors, plus the
mode-translation overrides), and per-context `themes/*.json` (which segments appear, in what order,
with what glyphs/dividers/args). No wizard; documented entirely via `docs/source/configuration/`
reference pages and segment docstrings that are compiled into the same docs. A `powerline-lint`
command validates a config file's structure.

### The one thing here nobody else does

The gradient-level abstraction: a segment emits a single 0-100 number, and the theme (not the
segment) owns the entire color-list and thresholds that number maps through — decoupling "what
value is alarming" from "what color alarm should look like" more completely than any threshold-`if`
chain in the rest of this survey. The mode-driven whole-palette shift (`mode_translations`) is the
second distinctive idea, and the priority-then-truncate width algorithm is the third.

## gitui

- **Repo:** https://github.com/gitui-org/gitui
- **Read:** `src/components/commitlist.rs`, `src/components/status_tree.rs`,
  `src/components/diff.rs`, `src/popups/blame_file.rs`, `src/tabs/status.rs`, `src/ui/style.rs`

### What it displays

| Element | What it shows | How it is rendered | Defined at |
|---|---|---|---|
| File status glyph | a changed file's status | a single character per `StatusItemType`: `M` modified, `+` new, `-` deleted, `R` renamed, `!` conflicted, ` ` (blank) type-change — each colored by its own theme entry (`theme.item(status, selected)`) | `src/components/status_tree.rs:141-149`, `src/ui/style.rs:111-128` |
| File tree fold state | whether a directory node in the changed-files tree is expanded | `▸` collapsed / `▾` expanded glyph prefix, with 2-space indent per nesting depth | `src/components/status_tree.rs:198-203` |
| Ahead/behind counter | commits ahead/behind the branch's upstream | `↑N ↓M {branch-name}`, right-aligned in the panel corner | `src/tabs/status.rs:211-225` |
| Commit list row | one commit: hash, relative time, author, tags, local/remote branch refs, message | a fixed left-to-right column layout (short hash, time, author truncated to a width computed from panel width, tags, branch refs, then message filling remaining width) with a distinct color per column (`commit_hash`/`commit_time`/`commit_author`/`tags`/`branch` theme entries); non-matching rows during an active text filter/search are dimmed via a separate `commit_unhighlighted` style rather than hidden | `src/components/commitlist.rs:452-565` |
| Diff hunk gutter | which lines belong to the currently-hunk under the cursor, and where a hunk begins/ends | a vertical box-drawing bar (`│`) running down the left edge of every line in a hunk, switching to a top-left corner glyph on the hunk's header line and a bottom-left corner glyph on its last line — so a hunk reads as one bracketed block rather than a run of independently-marked lines | `src/components/diff.rs:426-475` |
| Diff line coloring | added/removed/context line | background/foreground pair per `DiffLineType` from the theme's `diff_line` lookup; a binary file's diff instead shows `size: X -> Y (+delta)` with the delta itself colored add/delete | `src/components/diff.rs:395-422` |
| Blame gutter | which commit last touched each line | per-line metadata columns (short commit hash, author truncated/padded to a fixed width, relative time) — but only printed on the *first* line of a run of consecutive lines from the same commit; repeated lines from that same hunk show blank metadata cells, so a large single-commit block reads as one labeled span instead of N repeated labels | `src/popups/blame_file.rs:610-680` |

### Layout and density

A full multi-pane TUI (tabs for status/log/stashing/files, popups for diff/blame/branches/etc.),
not a single line — width adaptation happens per-pane: the commit-author column width and blame
author-column width are both computed from the available panel width at render time, and long
values are truncated/padded to that computed width rather than wrapped.

### Interaction

Full keyboard-driven TUI: navigate commits/files/hunks, stage/unstage/reset at the hunk or line
level, fold/unfold tree directories, open blame/diff/branch-list/stash popups, a fuzzy-finder popup,
and a command bar showing available keybindings for the current context — none of it click/OSC-8
based, all keypress-driven.

### Config and setup UX

A theme is a hand-edited config file (colors per highlight group, referenced via `SharedTheme` /
`Theme` in `src/ui/style.rs`); most day-to-day behavior is discovered via the in-app keybinding
command bar rather than a setup wizard.

### The one thing here nobody else does

The blame gutter's run-length collapsing: identical per-line metadata (same commit/author/time) is
shown once at the top of its contiguous span and left blank for the rest of that span, rather than
repeating the same three columns on every line.

## terryso/ccpet
https://github.com/terryso/ccpet, 64 stars. Statusline pet (emoji expression + energy bar) with token/cost/context lines.
1. Fixed per item, user-overridable. `src/core/config.ts:45-58` defaults: petExpression `#FFFF00:bright:bold`, petName `#00FFFF:bright`, energyBar `#00FF00`, energyValue `#00FFFF`, accumulatedTokens `#778899`, lifetimeTokens `#FF00FF`, sessionInput `#00FF00`, sessionOutput `#FFFF00`, sessionCached `#F4A460`, sessionTotal `#FFFFFF`, contextLength `#00DDFF`, contextPercentage `#0099DD`, contextPercentageUsable `#90EE90`, cost `#FFD700`. `StatusBar.ts:106-208` builds a `{value,color}` record per item and wraps each in `${color}${text}${RESET}`. No threshold colouring: the context percentage is always `#0099DD` whatever the value. No position-based colour.
2. No bundled named themes. One colour map (item key -> hex string) in the user config (`userConfig.colors.*`, `config.ts:45`); users can override any key. Not semantic roles.
3. Hex spec with modifiers `"hex:bright:bold"` (`src/utils/colors.ts:186-201`). Truecolor if COLORTERM is truecolor/24bit, TERM contains iterm/alacritty/kitty/wezterm or `256color`, or WT_SESSION is set (`colors.ts:14-50`). Otherwise nearest of the 256 palette by Euclidean RGB distance over the 16 + 216-cube + 24 greys (`colors.ts:70-146`); `bright` on an index under 8 emits `1;3N`. NO_COLOR: not present in files read.
4. Foreground only, text on the terminal's own background (only `38;2`/`38;5` and `1` are emitted).
5. Plain space between items (`parts.join(' ')`, `StatusBar.ts:99,240`). No glyph separators.
6. Different hue per item only; neighbours differ by fixed hex choice (cyan/green/magenta/grey). No algorithm.
7. Not present. Fixed hexes assume a dark terminal (`#FFFFFF`, `#FFFF00` are unreadable on light backgrounds).
8. Emoji: pet expressions and a `💖` lifetime-token prefix (`StatusBar.ts:132`), energy bar from `FILLED_BAR_CHAR`/`EMPTY_BAR_CHAR`. No Nerd Font or ASCII mode seen.
9. Animated expression: `formatPetDisplay(state, animatedExpression)` takes a frame-animated emoji (`StatusBar.ts:18`). Line items are configurable (`line1/2/3.items`, `maxLines`).
10. JSON config via `ConfigService` (`src/commands/ConfigCommand.ts`): `display.line1/2/3.items`, `display.maxLines`, `colors.*`. CLI subcommands (config, reset, sync, leaderboard).

## aiedwardyi/claude-usage-monitor
https://github.com/aiedwardyi/claude-usage-monitor, 58 stars. Two-line statusline: model/project/branch, then context gauge + 5h/7d quota.
1. By threshold plus fixed. `statusline.py:97-103` `color_pct`: used >= 90 red, >= 70 yellow, else green; applied to the context gauge (`:482`) and each quota bar and number (`:239-249`). Fixed: model line is cyan (`:466`, `C="\033[36m"`), email/cost/duration/`no token` are dim (`D`, `:475,522-534`). Branch/project text is uncoloured. Pace delta is green `+N%` / red `-N%` (`:269-271`).
2. Not present. No themes; the ANSI constants are hard-coded at `statusline.py:82-87`.
3. Named ANSI 16 only (`\033[36m`, `[32m`, `[33m`, `[31m`, `[2m`). No depth detection. NO_COLOR: not present.
4. Foreground only.
5. Plain ` │ ` (U+2502) between line-1 parts (`SEP`, `:450`); line 2 uses the same `SEP`. Not coloured separately.
6. Separators and the hue of the text (only the model is coloured). Little neighbour distinction.
7. Not present. Dim (`\033[2m`) is the only de-emphasis; no contrast logic.
8. `◆` diamond before the model (`:451`), `▰▱` five-cell gauge (`:244-245`), `↑ ↓` token arrows. No emoji, no Nerd Font, no ASCII mode.
9. Width-priority truncation: segments carry a priority and the highest-numbered are dropped until the line fits `MAX_WIDTH` (`:480-555`). Bar fill is quantised so 10% remaining never shows empty (`gauge_blocks`, `:225-231`).
10. Environment variables only: `CQB_CONTEXT_SIZE, CQB_TOKENS, CQB_PACE, CQB_RESET, CQB_DURATION, CQB_BRANCH, CQB_COST, CQB_REMAINING, CQB_BAR, CQB_EMAIL, CQB_MAX_WIDTH` (`:43-60`). Installers: `install.py/sh/ps1`.

## loadbalance-sudachi-kun/claude-code-statusline
https://github.com/loadbalance-sudachi-kun/claude-code-statusline, 56 stars. Three-line bash statusline. Read `statusline-command.sh`; the `-with-usage` variant was not read.
1. By threshold plus fixed. `statusline-command.sh:25-40` `color_for_pct`: >= 80 RED, >= 50 YELLOW, else GREEN, GRAY when null; applied to the context % cell (`:131`) and the context bar line (`:142-145`). Fixed: `+N/-M` lines and cost are GREEN (`:134,153`); token detail is dim (`:147`); model and branch are uncoloured (`:131,138`).
2. Not present. Palette is hard-coded at `:17-22`.
3. Truecolor foreground only: GREEN `38;2;151;201;195` (a teal), YELLOW `229;192;123`, RED `224;108;117`, GRAY `74;88;92` (a One Dark-like set). No depth detection. NO_COLOR: not present.
4. Foreground only.
5. ` │ ` in GRAY (`SEP`, `:126`).
6. Separator only; emoji prefixes (🤖 📊 ✏️ 🔀 📐 💰) tell fields apart.
7. Not present. GRAY `#4A585C` is very low contrast on a dark terminal.
8. Emoji per field, `▰▱` ten-cell bar (`:43-57`). No ASCII mode.
9. Written to be ToS-safe: stdin data only, no OAuth (`:2-9`).
10. None; edit the script.

## vfmatzkin/claude-statusline
https://github.com/vfmatzkin/claude-statusline, 56 stars. One-line bash statusline with usage/budget tracking.
1. Mixed: fixed, by state, by threshold, by hash. `statusline-command.sh`: model blue by default, amber if name matches `*Opus*`, cyan if `*Haiku*` (`:236-239`); effort low=dim, medium=cyan, high=orange, xhigh/max=red (`:243-252`); branch magenta with a dim `⎇` (`:260`); git counts staged green `+N`, modified yellow `~N`, untracked dim `?N`, ahead orange `⇡`, behind cyan `⇣`, clean = green dim `✓` (`:263-275`); wakeup yellow (`:292`); context cyan < 50, orange >= 50, red >= 80 (`:302-304`); 5h/week cyan/yellow/red at 50/80 (`:313-315`); cache hit green >= 80, cyan >= 50, else orange (`:349-351`); budget cyan/yellow/red (`:401-403`); time-left ratio green/orange/red (`:103-107`). The profile badge takes a colour from a 6-colour palette indexed by `cksum(profile) % 6` (`:229-232`), so each profile gets a stable colour.
2. Not present. Eight truecolor constants at `:60-67`: blue `97;175;239`, amber `229;192;123`, cyan `86;182;194`, green `80;200;120`, orange `255;176;85`, yellow `230;200;0`, red `235;87;87`, magenta `198;120;221`.
3. Truecolor foreground (`38;2`) plus `2` dim. No depth detection, no NO_COLOR.
4. Foreground only.
5. Dim `│` with a space each side (`sep`, `:71`).
6. Mostly by hue: per-segment fixed hue (blue/magenta/cyan), thresholds shift to orange/red.
7. Not present.
8. Unicode symbols `⎇ ✓ ⇡ ⇣ ⏰` and `↑ → ↓` pace arrows; no emoji set, no Nerd Font, no ASCII mode.
9. Colour is derived from the profile name by hash (`:227-233`), the closest thing to per-identity colour in the batch. Pace arrow projects usage to the window end (`:88-114`).
10. Subcommands `budget`, `usage`, `sync`, `fetch-refresh`; settings in `$CLAUDE_USAGE_DIR/.config` (`:6-54`). No colour config.

## congmnguyen/claude-code-wsl2-setup
https://github.com/congmnguyen/claude-code-wsl2-setup, 55 stars. A WSL2 setup repo; its statusline is `bin/statusline-command.sh` (78 lines).
1. By threshold plus plain. `pct_color` (`:34-39`): < 70 green `\033[32m`, < 90 yellow `[33m`, else red `[31m`. Applied to the context bar+percent (`:66`) and the `5h:` and `W:` rate-limit cells (`add_pct`, `:42-46`). Project dir and branch have no colour.
2. Not present.
3. Named ANSI 16 (`32/33/31/90`). No depth detection, no NO_COLOR.
4. Foreground only.
5. Plain ` | ` (`:76`), uncoloured.
6. Not distinguished: separator only, with emoji prefixes 📁 🌿.
7. Not present.
8. Emoji (📁 🌿), `█` filled and `·` empty bar, brackets `[…]`, empty cells in bright black `\033[90m` (`:66`). No ASCII mode.
9. Nothing else styling-related.
10. None.

## fredrikaverpil/claudeline
https://github.com/fredrikaverpil/claudeline, 55 stars. Go single-line statusline.
1. Fixed per segment plus thresholds. `internal/render/render.go`: login type and model cyan (`:283`), cwd yellow (`:180`), branch magenta (`:185`), update arrow green (`:325`), service-status fire icon orange (`:389-393`), cost uncoloured (`:405`), extra-usage red once >= 80% of limit (`:416`). Context bar `ContextColorFunc(warnPct)` (`:252-265`): green <= 40, yellow 41-60, orange 61..warnPct, red >= warnPct; warnPct derives from the compact window (80% of it by default, `:224-230`). Quota bars `QuotaColor` (`:268-277`): bright blue < 75, bright magenta 75-89, red >= 90.
2. Not present. Constants at `:18-29` (ANSI 16, one `38;5;208` orange).
3. Named ANSI 16 (including bright `94`, `95`) plus one 256 index (208). No detection, no NO_COLOR.
4. Foreground only.
5. Dim ` │ ` (`:176,293`); sub-quota separator dim ` · `. Spaces become NBSP so the terminal does not collapse them (`:197`).
6. By hue and the dim separator; bars share the `█`/dim `░` shape and differ only in colour.
7. Not present; leading reset clears stale ANSI state (`:195`).
8. Emoji (🔥 with `▂▄▆` severity bars, 🥊 cache miss), `█░` bars, `⟳`-style reset icon. OSC 8 hyperlinks on the update arrow and status icon (`:400-402`).
9. Context colour zones are named as model quality zones (smart/dumb/danger/near compaction, `:247-251`).
10. CLI flags/env in `main.go` not read; the render layer takes `ShowCwd`, `ShowBranch`, `ShowCost`, `CwdMaxLen`, `BranchMaxLen` params.

## joshsymonds/steward
https://github.com/joshsymonds/steward, 51 stars. Go statusline plus hooks. Strongest styling in this batch: powerline chips on Catppuccin Mocha.
1. Fixed per segment, plus state or environment. `internal/statusline/render.go`: directory chip lavender (`:208-217`), model chip sky (`:226`), devspace mauve (`:353`), hostname rosewater (`:359`), git chip sky (`:415`) with an inline PR glyph coloured by review state: approved green, changes_requested red, draft overlay grey, else yellow (`:422-433`). Cloud chips colour by environment (`env_color.go:32-79`): AWS prod red / dev green / staging+unknown peach; gcloud prod pink / staging mauve / dev sapphire / unknown lavender; k8s prod maroon / staging yellow / dev+unknown teal. Context chip by threshold (`render.go:1198-1210`): teal < 60, yellow < 80, red >= 80, with a muted "LightBG" variant for the bar's empty fill (`:1222-1231`). Rate-limit and cost chips sapphire (`:788,836`), alarms red (`:862,876`).
2. One bundled palette, Catppuccin Mocha, 12 backgrounds + 12 foregrounds (`colors.go:3-85`); `CatppuccinMocha` is a struct instantiated in `statusline.go:285`. Role is a colour name string (`colorRed`, `colorSky`, …, `env_color.go:7-26`). No user-defined themes seen.
3. Truecolor: `48;2`/`38;2` (`colors.go`), lipgloss hex for the CLI (`internal/shared/colors.go`). No depth detection or NO_COLOR in files read.
4. Background-filled chips with dark text: chip text is always `BaseFG` `#1e1e2e` on a pastel background (`render.go:213,227`).
5. Powerline: Nerd Font curves and chevrons (`LeftCurve`, `RightCurve`, `LeftChevron`, `RightChevron`, `internal/shared/colors.go:66-71`). The chevron's fg is the previous chip's colour and its bg the next chip's (`render.go:478-489`), so the arrow blends both. `narrowChevronColors` (`render_narrow.go:276-305`) handles equal-colour neighbours, where the glyph would vanish.
6. By distinct hue plus an explicit adjacency invariant: `env_color.go:3-6,47-49` ("adjacency invariant (R9)") says a colour may repeat only where the neighbours differ; staging shares peach with unknown because the text distinguishes them.
7. Fixed dark base text on pastel fills; no light/dark adaptation.
8. Nerd Font icons (`icons.go`: `GitIcon`, `PRIcon`, `AwsIcon`, `K8sIcon`, …), emoji in places, quintile block characters for the context chip (`render_narrow.go:23`). Progress bar uses Nerd Font left/mid/right full/empty glyphs.
9. Width-adaptive wide and narrow chip chains (`render_narrow.go`: chips drop in priority order env -> branch -> dir shortening -> context -> cost). Subagent statusline (`internal/subagentstatusline/`). Chip colours are looked up by name through `getColorBG`/`getColorFG` (`statusline.go:615-672`).
10. Aliases resolver for AWS/gcloud/k8s names -> label + environment (`internal/aliases`); otherwise colours are not user-configurable in the files read.

## v4l3r10/emobar
https://github.com/v4l3r10/emobar, 51 stars. Shows a model-reported emotional state (stress, valence, calm, etc.) in the statusline; styling is incidental.
1. By state or threshold. `src/display.ts:11-40`: GREEN=35, YELLOW=221, RED=196, GRAY=240 (256 indices); `stressColor` (<= 3 green, <= 6 yellow, else red), `valenceColor` (>= 2 green, >= -1 yellow), `invertedColor` for calm/connection (>= 7 green, >= 4 yellow), `directColor` for load. Alarm tags `[MIN:n] [UNC] [sup] [fat]` red or yellow by score (`:210-324`). Each value is coloured by its own scale, not by segment identity.
2. Not present.
3. 256-colour foreground (`38;5;N`) plus bold/dim. No detection, no NO_COLOR.
4. Foreground only.
5. Dim `│` (U+2502, `:169,220,284`) and dim `→`.
6. Hue by value range; separators otherwise.
7. Not present for the bar. `src/color.ts` converts a hex colour that the model reports into HSL lightness (`hexToLightness`) and the display uses it as a stress signal (`display.ts:70-72,267`); that is data, not styling.
8. Emoji and Unicode (`█░`, `◐ ● ○ ⬈ ⬊ ⟩⟨`). No Nerd Font or ASCII mode.
9. Three layouts: `formatMinimal`, `formatCompact`, `formatState` (full, 3 lines) (`:153,179,231`).
10. CLI (`src/cli.ts`, `setup.ts`); no colour settings.

## ai-younggle-man/claude-ultimate-hud
https://github.com/ai-younggle-man/claude-ultimate-hud, 49 stars. A TypeScript HUD in the claude-hud mould (multi-line).
1. Fixed per segment plus threshold. `src/render/session-line.ts:13`: model cyan; context bar and percent via `getColorForPercent` (`src/utils/colors.ts:43-47`): <= 50 green, <= 80 yellow, else red (`src/constants.ts:5-8`); cost cyan (`:76`); limits via the same threshold (`:80,98,114,120`); unknown limits yellow `🔑 ?` (`:92`). Project line: project yellow, `git:(` `)` magenta, branch cyan (`project-line.ts:12-21`). Activity lines: running tool `◐` yellow + name cyan, done `✓` green, agent type magenta, model dim, todo `▸` yellow (`activity-lines.ts:24-104`).
2. Not present. `COLORS` object at `colors.ts:1-9` (cyan, green, yellow, red, magenta, dim).
3. Named ANSI 16 only. No detection, no NO_COLOR in files read.
4. Foreground only.
5. Dim ` │ ` (`SEP`, `session-line.ts:7`, `project-line.ts:5`).
6. Hue by role (yellow = project, cyan = model/tool, magenta = agent/git punctuation) and dim separator.
7. Not present.
8. Emoji (🤖 📁 💰 ⏱️ 🔑), `█░` ten-cell bar, `◐ ✓ ▸`. i18n labels (`src/utils/i18n.ts`). No ASCII mode seen.
9. Multi-line (session, project, stats, activity, context warning) renderers in `src/render/`.
10. Config object with `display.showTokenBreakdown` and `plan` (`session-line.ts:45,70,107`); a `dist/index.js` build. Colours not configurable.

## emson/claudoro
https://github.com/emson/claudoro, 48 stars. A Pomodoro timer; the statusline segment is `src/render/segment.js`.
1. By state. `phaseColor` (`segment.js:29-33`): focus tomato `38;5;203`, long break teal `73`, short break amber (`coffee 178`, via `seg.amber`). Bar fill `barColor` (`:41-45`): red while focusing, amber while paused, grass `71` while resting; track and frame dim (`:77-81`). Cycle dots and label uncoloured ("colour is reserved as an accent on the icon and bar fill", `:138-139`).
2. Not present.
3. 256 index plus ANSI 16 (`src/output.js:54-65`). Honours NO_COLOR and `CLAUDORO_COLOR=auto|always|never` (`output.js:29-46`). A separate `segmentColorMode()` ignores TTY (status-line stdout is piped) but honours NO_COLOR and `TERM=dumb`.
4. Foreground only.
5. Single spaces between parts (`segment.js:155`); frame glyphs `▕ ▏` around the bar.
6. Not applicable (one cluster of parts per phase).
7. Not present; one palette. Text left at normal intensity "to match the prompt line's brightness".
8. Emoji-capable icons (`ICONS`, `output.js`), 1/8-block partial cells `▏▎▍▌▋▊▉█` for sub-cell progress (`segment.js:52`), dots `●○`. Width tiers: bar at >= 40 columns, dots at >= 52, label at >= 70 (`:136-153`).
9. Bar advances only about every 15 s, never animates per tick (D-006, `:47-49`). Separate dashboard/HTML renderers (`dashboard.js`, `guide-html.js`) share the palette.
10. `prefs.view` minimal/classic/full; environment `CLAUDORO_COLOR`, `NO_COLOR`; CLI in `src/cli.js`.

## slima4/claude-tui
https://github.com/slima4/claude-tui, 45 stars. A suite (statusline, monitor, session tools); styling read from `claude-code-statusline/`, `claude_tui_components/`.
1. By threshold plus fixed. Palette in `claude_tui_components/colors.py:3-30`. Statusline: model bold magenta (`render.py:53`), cost yellow (`:57`), cwd green (`:89`), duration white, compaction count chip cyan, session id gray (`:65`), alert `COMPACT SOON` red / `compact soon` orange (`:42-43`). Thresholds via `threshold_color` (`formatters.py:10-15`): turns green <= 20, yellow <= 60, else orange (`render.py:94`); cache hit green/yellow/orange at 85/60 (`:102`); thinking ratio (`:106`); compaction prediction red <= 5, orange <= 15, yellow <= 30, else green (`calculations.py:122-129`); efficiency green/yellow/orange/red at 90/70/50 (`:173-180`). Chips: `chip(label, value, color=GRAY)` gives a gray label then value (`formatters.py:18-20`).
2. Not present. Hard-coded constants.
3. ANSI bright 16 (`92 93 96 95 97 90`), one 256 index (208 orange, 46 logo), and truecolor for gradients (`widgets.py:6-18`). No detection, no NO_COLOR in files read.
4. Foreground only.
5. Gray `⋮` between parts in compact mode (`render.py:148`); `→` gray between tool-trail items (`formatters.py:60`).
6. Hue by field; gray labels and bright values.
7. Not present. Truecolor tail colours "tuned for legibility in dark terminals" (`widgets.py:48`).
8. Unicode blocks (`▮▯`, partial `▏…▉`, sparkline `▁…█`, `┆` threshold tick, `▏▕` frame). No emoji or Nerd Font needed; `ds.bar` widgets include `hex`, `matrix`, `bars`, `progress` animation widgets (`widgets/`).
9. Gradient along the bar: `build_progress_bar` interpolates 5 Catppuccin-like stops (166,227,161 -> 148,226,213 -> 249,226,175 -> 250,179,135 -> 243,139,168) by cell position with `_lerp_rgb` (`widgets.py:76-96`), empty cells `#373B50`, a bright head cell, a threshold tick. Sparkline colour by ratio buckets with a recency fade (`widgets.py:46-65`). Vertical meter widget by ratio (`widgets/progress.py:28-35`).
10. JSON `~/.claude/claudeui.json` with per-line/per-component `is_visible(line, component)` (`settings.py`); a configurator (screenshot `assets/configurator.png`); install/uninstall scripts.

## thinca/config
https://github.com/thinca/config, 44 stars. A personal dotfiles repo; the statusline is `dotfiles/dot.config/claude/config/statusline.sh`.
1. By threshold plus fixed. `pct_color` (`:141-150`): >= 80 red, >= 50 yellow, else green, for context and 5h/7d. Activity indicator `*` green when running else dim `-` (`:167-171`); `sub:`/`bg:` counts and the session name cyan (`:174-179`); effort, branch and reset times dim (`:178,181,186`); model, directory uncoloured.
2. Not present.
3. Named ANSI 16 (`\033[31m/32/33/36/2`). No detection, no NO_COLOR.
4. Foreground only.
5. Dim ` | ` ASCII pipe (`sep`, `:156`).
6. Separator only.
7. Not present.
8. ASCII only (`*`, `-`); no emoji or Nerd Font.
9. Side effects: renames the tmux window, tracks cross-session usage cache; not styling.
10. None; edit the script. A wrapper can append text through `_extra` in the JSON (`:191-194`).

## khoi/cc-statusline-rs
https://github.com/khoi/cc-statusline-rs, 42 stars. Rust single-line statusline.
1. Fixed per segment plus thresholds. `src/lib.rs`: model icon bright cyan `38;5;14`, model name orange `38;5;208` (`:30`); effort gray (`:26`); context icon `38;5;13` magenta, bar gray `90`, percent coloured by value: >= 90 red, >= 70 orange, >= 50 yellow, else gray (`:66-82`); cost icon `38;5;3`, amount green < $5, yellow < $20, else red (`:129-138`); directory cyan, branch icon `38;5;12` blue + name green, `+N` green `-N` red (`:116,170-184`).
2. Not present.
3. Named ANSI 16 plus 256 indices (3, 12, 13, 14, 208). No detection, no NO_COLOR.
4. Foreground only.
5. Gray ` • ` (`:162-163`).
6. Hue by segment; the gray bullet separates.
7. Not present.
8. Nerd Font glyphs: `\u{e26d}`, `\u{f49b}`, `\u{f155}`, `\u{f02a2}`, `\u{f071}`; ten-cell `█░` bar (`:79`). No ASCII mode.
9. Fish-style path shortening (`fish_shorten_path`, `:319`), middle truncation of branches.
10. None found; `main.rs` reads stdin only.

## professionalcrastinationco/METRICC
https://github.com/professionalcrastinationco/METRICC, 42 stars. Node statusline with a column layout.
1. By threshold plus fixed. `metricc-cc-statusbar.mjs`: `colorForPercent(pct, warnAt=70, critAt=85)` (`:651-655`) with green/yellow/red; 5h/7d use 60/80 (`:702,715`); cost red >= $1, yellow >= $0.25, else green (`:777`); cache green >= 50, yellow >= 20, else slate (`:800`); todos green if all done else yellow; agents cyan, agent name magenta (`:848-860`). Stale usage cache dims the same colour (`dimIfStale`, `:693`). Labels are bold slate-700 `#334155` (`:72-75`), data values slate-500 `#64748b`.
2. Not present.
3. Truecolor Tailwind constants: emerald-600 `#059669`, amber-600 `#d97706`, red-600 `#dc2626`, slate-500, slate-700 (`:60-75`), plus ANSI cyan/blue/magenta/white/gray. No detection, no NO_COLOR.
4. Foreground only.
5. Slate `│` with spaces (`pipe`, `:690`).
6. Columns: labels on one row, values on the next (vertical layout `:833-840`) or `label value` cells (horizontal layout `:827-830`) joined by `│`.
7. Not present; slate-700 `#334155` labels are close to invisible on a dark terminal, readable on light (a fixed choice).
8. `█░` bar in brackets `[██░░]pct%` (`:661`). No emoji or Nerd Font.
9. Dimmed-when-stale colour; zero-width space blank line (`:824`).
10. `~/.claude/hud/config.jsonc` (comments allowed): per-column booleans (`SECTION_DEFAULTS`, `:89-96`), `layout: "vertical"|"horizontal"`, usage retry tunables (`:98-106`).

## canack/claude-usage-line
https://github.com/canack/claude-usage-line, 40 stars. TypeScript, quota bars.
1. By threshold over a per-bar base colour. `src/statusline.ts:94-109`: context bar base magenta, 5h cyan, 7d green, org bucket user-chosen; `colorByThreshold(pct, base)` (`src/ansi.ts:33-37`): >= 80 red, >= 50 yellow, else the base colour. Fixed: additions green, deletions red, cost yellow, duration dim blue (`:68-74`), cwd blue, branch green (`:137-141`), model magenta (`:147`).
2. Org-bar colour presets `ORG_COLORS` (`ansi.ts:10-21`): purple 98, teal 37, steel 67, gold 178, coral 168 (256 indices), blue, magenta, cyan, yellow, green; default purple. Bar styles in `src/styles.ts:3-11`: classic, dot, braille, block, ascii, square, pipe (glyph sets, not colour themes).
3. ANSI 16 plus 256 indices. No detection, no NO_COLOR.
4. Foreground only.
5. Dim separator glyph from the style: `•`, `|` for ascii, `┃` for pipe; `--sep` overrides (`styles.ts`, `cli.ts:129`).
6. Each bar has its own base hue so neighbouring bars differ; separator between.
7. Not present.
8. Glyph styles including an `ascii` mode (`#`/`-`, `|`, `~`) (`styles.ts:8`), braille `⣿⣀`, `⟳ ↻ ~` reset icons.
9. Org-colour option and style option exposed as CLI flags.
10. CLI flags `--style`, `--hide`, `--sep`, `--org-color`, `--json` (`src/cli.ts:119-137`); `setup.ts` installer.

## medhatdawoud/cconeline
https://github.com/medhatdawoud/cconeline, 36 stars. A bash installer that writes `~/.claude/statusline.sh`.
1. Fixed per segment plus a context threshold. Heredoc script in `bin/cconeline`: directory cyan (`:401`), branch `🌿` green + name white (`:59`), `+N` green `-N` red (`:52-55`), dirty `*` yellow (`:275`), tokens yellow and cost green (`:272`), context % magenta (`:281`), context bar red >= 80, yellow >= 50, else green with the empty part gray (`:136-144`), RTK savings green (`:291`), session time and memory white (`:308,327`), model bright cyan `96` (`:332`), today/month cost green/yellow (`:344,391`).
2. Not present.
3. Named ANSI 16 (`31 32 33 35 36 37 90 96`). No detection, no NO_COLOR.
4. Foreground only.
5. Gray ` | ` and ` / ` for the directory/branch (`:59,272`).
6. Hue by segment plus gray separators.
7. Not present.
8. Emoji heavy (🌿 🌲 🔸 💰 ✂️ ⏱️ 🔋 🧠), `━` filled and `─` empty bar (`:134-135`). No ASCII mode.
9. Interactive installer previews each segment (`:485-494`).
10. `$CLAUDE_DIR/statusline.conf` is sourced; `STATUSLINE_GIT`, `_DIR`, `_SESSION`, `_CONTEXT`, `_RTK`, `_SESSION_TIME`, `_MEM`, `_MODEL`, `_TODAY`, `_MONTH` toggle segments (`:41,485-494`). Installer flags `-y`, `-u`.

## Fanfulla/Lupin
https://github.com/Fanfulla/Lupin, 35 stars. An LLM routing harness; the styling is the example `examples/statusline.sh`, plus an `.ps1` variant (not read).
1. By threshold plus fixed. `pct_color` (`:23-29`): >= 90 red, >= 70 orange `38;5;208`, >= 50 yellow, else green; applied to the context percent and 5h/7d. Fixed: model cyan, routing segment pink `38;5;213` (red `⇄ Lupin OFFLINE`), folder magenta with a gray `@` and blue branch, effort yellow (`:37,60,65,72-74,89`). The `(free)` tier note is gray.
2. Not present.
3. Named ANSI 16 plus two 256 indices (208, 213). No detection, no NO_COLOR.
4. Foreground only.
5. Gray ` | ` (`SEP`, `:18`).
6. Hue per segment.
7. Not present.
8. `⇄` glyph; otherwise ASCII labels (`ctx:`, `effort:`).
9. The routing segment (only shown when `ANTHROPIC_BASE_URL` is a local 127.0.0.1 proxy) shows which backend actually serves the model.
10. None; the example script is copied by the user.

## mttmcknn/prism
https://github.com/mttmcknn/prism, 35 stars. Go statusline with plugin support.
1. Fixed per built-in plus plugin-chosen. `internal/statusline/statusline.go`: directory cyan (`:205-209`), a worktree `⎇` cyan, model magenta (`:344`), lines added green and removed red (`:512`), cost gray (`:595`); context bar uncoloured below 70%, yellow >= 70, red >= 90 (`:467-477`), whole bar one colour. Git and other sections are plugins that receive `Colors: sl.getColorMap()` (`:648`) and return their own coloured text.
2. Not present as themes. `internal/colors/colors.go` defines about 90 named colours (ANSI 16, bright, then 256-index groups for reds, oranges, yellows, greens, teals, blues, purples, browns, greys; one truecolor, `supabase_green` `38;2;62;207;142`) exported to plugins as `ColorMap()` (`:114-221`).
3. ANSI 16, 256 indices, one truecolor. No detection, no NO_COLOR in files read.
4. Foreground only.
5. Dim `·` between sections (`colors.Separator()`, `:230-232`).
6. Separator only; hue differs per built-in section.
7. Not present.
8. `█░▒` bar (`▒` marks the autocompact buffer, `statusline.go:486-493`), `⎇`. Plugins pick their own icons.
9. A `prism colors` command prints every named colour with a rainbow summary line (`cmd/prism/main.go`). Plugins (bash or native Go) are sections named in config.
10. JSON config `sections` as a flat list or `[][]string` for lines (`internal/config/config.go:16,29-36,190-220`); plugin config per plugin.

## AndyShaman/claude-statusline
https://github.com/AndyShaman/claude-statusline, 34 stars. One bash script.
1. By threshold only. Context colour (`statusline.sh:104-110`): used < 50 green, < 80 yellow, else red. Limit colour keyed on remaining % (`:186-195`): > 50 green, > 20 yellow, else red. Everything else (model, project, branch, `MCPs`, time) is uncoloured.
2. Not present.
3. Named ANSI 16, emitted via `printf '%b'` (`:271`). No detection, no NO_COLOR.
4. Foreground only.
5. Plain ` | ` (`:267`) between parts; ` · ` inside the limits part (`:234`).
6. Separator only.
7. Not present.
8. `━` used for both filled and empty cells in the same colour (`:112-113`), so the six-cell bar never shows fill; the percentage carries the information. `↻` and `⏱`. No emoji.
9. Quota fetched from the Anthropic OAuth usage API with a 2-minute cache (`:116-184`), including scoped weekly limits per model.
10. None.

## jbarbier/which-claude-code
https://github.com/jbarbier/which-claude-code, 33 stars. Names parallel sessions with a Haiku-written title; the colour is the point.
1. By identity hash. `bin/statusline.sh:33-41`: `cksum(session_id) % 20` indexes a 20-entry 256-colour palette `(39 45 51 82 118 147 159 171 183 203 208 214 220 135 213 48 75 105 165 198)`; the title (bold) is drawn in that colour (`:55,101-102`). Everything else dim or plain; usage percentages `ctx:`/`5h:`/`7d:` are dim labels with uncoloured values (`:84-92`). No thresholds.
2. Not present; the palette is one array.
3. 256-colour foreground (`38;5;N`), bold, dim. No detection, no NO_COLOR.
4. Foreground only.
5. Dim `·` (`:87,96,103`).
6. Per-session colour distinguishes sessions across terminals, not neighbouring segments.
7. Not present. The palette mixes light (183, 159, 220) and mid tones; none is adjusted to the terminal.
8. `●` marker, ASCII otherwise; a `·  ·  ·` placeholder title until the title lands.
9. The one project whose colour answers "which window is this", stable per session id.
10. State dir env `WHICH_CLAUDE_CODE_STATE_DIR`; scripts `setup.sh`, `uninstall.sh`, `update-session-title.sh`.

## ronitgupta138/BurnRate
https://github.com/ronitgupta138/BurnRate, 33 stars. not a Claude statusline: a Rust proxy and budget guard for AI coding agents whose `src/hud.rs` prints a boxed HUD to stderr (spend coloured green/yellow(>65%)/red(>90%) with the `colored` crate, status badge red/green(cache > 70)/cyan); no `statusLine` reference found in the repo.

## bhutano/claude-usage-bar
https://github.com/bhutano/claude-usage-bar, 32 stars. Python-in-bash statusline for rate limits and context.
1. By threshold. `statusline-usage.sh:108-124`: rate limits red >= 90, orange >= 80, else green; context red > 80, orange >= 70, else green. Bold labels (`5h:`, `7d:`, `ctx:`), cyan reset-time text (`time_until`, `:126-139`), green `reset now`, dim for N/A. The bar and percent share the one colour.
2. Not present.
3. Named ANSI 16 plus 256 index 208 for orange and bright green `92` defined (`:86-94`). No detection, no NO_COLOR.
4. Foreground only.
5. Dim two-space-padded `|` (`:195`).
6. Separator and bold labels.
7. Not present.
8. `█░` eight-cell bar (`:96-106`). Translation table for labels (`t['5h']`, `:48`), language read from config (`:15`).
9. Nothing else styling-related.
10. Language config file; `install.sh/ps1`. No colour options.

## anandgupta42/aireceipts
https://github.com/anandgupta42/aireceipts, 31 stars. A receipt tool; the statusline part is `src/cli/commands/statusline.ts`, `statuslineSegments.ts`, `statuslineConfig.ts`.
1. No colour. The statusline emits plain text segments joined by ` · ` (`statuslineSegments.ts:277,279`); no escape sequences in `statuslineSegments.ts` or `statusline.ts`. The receipt renderer (`src/receipt/color.ts:22-31`) uses only dim and bold, "dim rules/perforations, bold the TOTAL line — nothing else".
2. Not present.
3. Receipt: `colorEnabled` (`color.ts:5-13`) NO_COLOR (non-empty) always wins, then FORCE_COLOR, then TTY. Statusline: not applicable (no colour).
4. Neither fill nor foreground colour; plain terminal text.
5. ` · ` plain; when the first segment is the brand it is followed by a space then the rest joined by ` · ` (`:277`).
6. Separator only.
7. Not present (colour-free by design, so it needs no adaptation).
8. Not present; a segment named `brand` is text. A "samosa" glyph exists for receipts (`src/receipt/samosa-glyph.ts`).
9. The scanner's `hex_colors` come from the docs site CSS, not the statusline.
10. `~/.aireceipts/statusline.json` with `{ "items": [...] }` over `brand, model, cost, burn, tokens, context, waste, quota5h, quota7d, quotaEta` (`statuslineConfig.ts:20-45`, `statuslineSegments.ts:22`); a `--format` spec parsed by `parseFormat`; `AIRECEIPTS_HOME`.

## dvwinck/capybara-toolbox
https://github.com/dvwinck/capybara-toolbox, 31 stars. A bundle of five plugins; the statusline is the `header-footer` plugin (`plugins/header-footer/skills/header-footer/scripts/header_footer.py`). The bulk of the scanner's hex counts are the board UIs, not the statusline.
1. By state or threshold. Footer fields (`header_footer.py:731-775`): `state` yellow `● running <elapsed>` / orange `◐ waiting` (`38;5;208`) / dim `○ idle` (`:595-607`); `context` and `limits` via `pct_color` (`:625-632`): < 50 green, < 75 yellow, < 90 orange, else red; model, dir uncoloured; branch, tokens, cost, clock, reset-in dim.
2. Not present.
3. Named ANSI 16 plus 256 index 208. NO_COLOR: not present in files read.
4. Foreground only.
5. Configurable separator string, dimmed (`footer['separator']`, `:795`).
6. Separator; per-field config chooses which appear.
7. Not present for the footer (colour counts for light/dark relate to the other tools in the repo).
8. Unicode status glyphs `● ◐ ○ ⎇ ↑ ↓`; ASCII fallback not seen.
9. Fields are an ordered list including `gsd` (a block rendered by another tool) and `clock`.
10. Config `footer.fields` and `footer.separator` loaded by `load_config()`; installed through settings.json wiring (`:798`).

## SnowWarri0r/cc-buddy-bridge
https://github.com/SnowWarri0r/cc-buddy-bridge, 31 stars. Statusline for a BLE hardware companion ("buddy"); `src/cc_buddy_bridge/hud.py`.
1. By state or threshold. Battery bar red <= 15, yellow <= 40, else green (`:38-43`); update nudge yellow `↑ <version>` (`:161`); everything else uncoloured. A pending permission replaces the line with `🐾 ⚠ approve: <tool>` (uncoloured, `:116-122`).
2. Not present.
3. Named ANSI 16 (`31/33/32`). No detection, no NO_COLOR.
4. Foreground only.
5. Single spaces between parts (`" ".join(parts)`, `:165`).
6. Not distinguished; emoji carry meaning (🔋 🪫 🔒 ⚠UNSEC).
7. Not present.
8. Emoji by default; `--ascii` switches to `buddy:` text, `[====----]` bar and no colour (`:25,60-62,102`).
9. Nothing else.
10. `--ascii` flag; socket path option (`hud.py:168`).

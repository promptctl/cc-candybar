## oh-my-claude
https://github.com/npow/oh-my-claude , stars 4
1. Fixed per plugin via a style string in the theme JSON, plus thresholds. `themes/default.json`: model-name `bold cyan`, directory `white`, git-branch `green`, git-status `yellow`, lines-changed/session-timer/git-last-commit/activity `dim`. `context-bar` is state-driven: `warnAt` 60 -> `styleWarn` `bold yellow`, `criticalAt` 80 -> `bold red`, otherwise `styleOk` `green`. `session-cost` has `warnAt`/`styleWarn`/`styleCritical`. `vim-mode` has `styleNormal` `bold green` / `styleInsert` `bold blue` (`themes/powerline.json`).
2. Themes are bundled as JSON files: analytics, boss-battle, coworker, danger-zone, default, devops, minimal, narrator, powerline, productivity, rpg, tamagotchi. A theme is a layout (`lines[].left/right` plugin names) plus per-plugin config overrides (including `style`), not a palette. It fully replaces the default. Users can add their own theme JSON (`docs/theme-format.md`) and override per plugin in `~/.claude/oh-my-claude/config.json`; resolution is `meta.defaultConfig < theme.plugins < user config`.
3. Named ANSI 16 only (`red green yellow blue magenta cyan white gray`) plus `orange` = 256 index 208 (`src/color.js` FG_COLORS / BG_COLORS). No truecolor, no depth detection, no NO_COLOR handling found in `src/color.js` or `src/runner.js`.
4. Foreground-only in every bundled theme. `src/color.js` supports `bg:COLOR` tokens in the style grammar, but `default.json` and `powerline.json` never use one.
5. The `powerline` theme has a `separator-arrow` plugin with `char` U+E0B0, style `dim`. It is a dim glyph between groups and does not take the neighbouring cells' colours. Other themes use a plain `separator` string (default " ").
6. Neighbours are told apart by different foreground hues per plugin (cyan model, white or blue directory, green branch, yellow status), plus the separator. No lightness steps, no alternation.
7. Not present. The colours are fixed ANSI names, so they follow the terminal's palette, but nothing picks text colour against a background.
8. `icon: true/false` per plugin; `default.json` says "No special fonts required", `powerline.json` says it requires a Nerd Font. Emoji appear in the rpg/tamagotchi themes. `src/color.js stringWidth` counts emoji and Nerd Font icons as 2 columns.
9. Themed gimmick layouts (rpg, tamagotchi, boss-battle). No gradients or animation found in the styling code.
10. JSON theme files, user `config.json`, `--theme` flag on `src/runner.js`, `omc theme list`, `npm run validate`.

## clepso
https://github.com/obileonardo/clepso , stars 4
not a Claude statusline: a macOS (Swift 6) menu bar app that shows Claude Code and Codex usage limits. The files the scanner read are design tokens, app icon assets and test fixtures. It has no statusLine renderer of its own.

## harness-kit
https://github.com/Pierry/harness-kit , stars 4
1. One colour for the whole line, i.e. no colour. `.claude/hooks/status-line.sh` prints plain text such as `<slug> [stages] · <stage> <state> · next <cmd>` (built by `render_line` in `.claude/scripts/pipeline.py`, which has no escape codes). Only the activity suffix is coloured: `CYAN=\033[36m`, applied by `append_activity` when a sensor/eval/guide is active.
2. Not present for the statusline. (`demo/src/theme.ts` and `tui/src/theme.ts` style the Remotion demo and a TUI, not the statusline.)
3. ANSI 16 cyan only; no depth detection, no NO_COLOR handling.
4. Foreground-only.
5. Plain ` · ` text separators.
6. Not distinguished; everything is the same colour except the cyan activity suffix.
7. Not present.
8. No icons; ASCII text.
9. Content is pipeline stage state (prd/prp/plan/dev/test/pr, drafting/approved/pending), not usage metrics.
10. No user styling surface; the shell script and `pipeline.py` are edited by hand.

## claude-usage-meter
https://github.com/ryukidong/claude-usage-meter , stars 4
1. The statusline hook is uncoloured. `statusline-hook.py` prints `5h:NN% 7d:NN% ctx:NN%` with no escape codes. Colour exists only in the separate Rich dashboard (`dashboard.py make_bar`, line 105): under 50% green, under 75% yellow, under 90% `rgb(255,165,0)`, otherwise `red bold`. The sparkline uses the same thresholds.
2. Not present.
3. Statusline: none. Dashboard: Rich named colours plus an `rgb()` orange; Rich handles depth downsampling itself.
4. Statusline: plain text. Dashboard: foreground colours, with panel borders.
5. Spaces between segments in the statusline.
6. Labels (`5h:`, `7d:`, `ctx:`) only.
7. Not present.
8. ASCII only in the statusline; dashboard uses `█`/`░` and sparkline block characters.
9. A separate `dashboard.py` (Rich layout, 2 s refresh) with an usage history sparkline.
10. `--interval` flag on the dashboard, `CLAUDE_USAGE_DATA_DIR` env var. No style configuration.

## claude-code-statusline (seungho-jeong)
https://github.com/seungho-jeong/claude-code-statusline , stars 4
1. Mix of fixed per segment and threshold. `statusline.js` `C` table (256 index, foreground): cwd basename bold cyan(80) with a muted(246) parent path; git branch yellow(179); clean status green(114); dirty count red(203) with `+n` green and `−n` red; model pink(218); worktree and tenancy lavender(147); org blue(111). Thresholds via `colorByPct`: context, 5h and week percent are green under `CTX_WARN` 50, yellow under `CTX_CRIT` 80, else red. Cost: green under $2, yellow under $5, red with ` !` above (`CCSL_COST_WARN`/`CCSL_COST_CRIT`).
2. Not present: no themes. The palette is a hard-coded `C` object.
3. 256-colour indices (`\x1b[38;5;Nm`). No depth detection, no NO_COLOR handling found.
4. Foreground-only.
5. `SEP` = two spaces, dim grey(242) `·`, two spaces. No powerline.
6. Four lines grouped by axis (filesystem, git, AI, resources), a different hue per element, separated by the dim dot.
7. Not present. A fixed dark-terminal palette; the "dim" bar track uses grey 238.
8. Emoji-free Unicode symbols (`✦ ⎇ ⌥ ✓ ± ❯ ▰▱`). The same file also ships `statusline.sh` and `install.ps1`.
9. `▰`/`▱` bars: filled in the default text colour, empty in dim 238, while the percentage is coloured by threshold. A ` !` marker when context is at or above 90% (`CCSL_FIRE_THRESHOLD`).
10. `CCSL_*` environment variables (bar width, thresholds, git timeout); no config file.

## claude-code-plugin-hud (sj817)
https://github.com/sj817/claude-code-plugin-hud , stars 4
1. Two styles in `src/theme.rs`. Default "ribbon" (`src/ribbon.rs`): the model is the only filled cell (bg `MODEL_BG` rgb(160,172,245), text `MODEL_TEXT` rgb(21,28,49)); everything else is a fixed or threshold foreground. Context: `ribbon::context_color` gives rgb(0,195,255) under 25%, (48,222,115) under 50, (255,212,0) under 70, (255,145,0) under 90, (255,66,85) from 90. Quota (5h/7d/$): `quota_color` teal(94,234,212) under 50, yellow under 75, orange under 90, red from 90. Fixed: branch rgb(0,191,255), cache label 256-pink 212, cold tag rgb(251,113,133), track rgb(75,89,116), cost yellow(33). `classic` style (`CLAUDE_HUD_STYLE=classic`) uses 16-colour roles: model cyan 36, branch blue 34, effort/cost yellow 33, folder 256-gold 179, add green, del red.
2. Not present as user themes. `theme.rs` documents the classic palette as "standard 16-color ANSI (so it follows the user's terminal theme instead of fighting it)", with a few deliberate 256-colour exceptions. Two built-in styles (ribbon, classic).
3. Mix of ANSI 16, 256 (178/208/212/80) and truecolor (ribbon). No depth detection found. No NO_COLOR handling found in `main.rs` or `render.rs`.
4. Both. Ribbon: one background-filled model cell, all other text foreground-only. Classic: foreground-only.
5. Ribbon: after a filled segment, `▶` (or `>` in ASCII mode) drawn with fg = the cell's bg, and bg = the next filled cell's bg if there is one (`paint`). Between unfilled segments a dim ` │ ` (` | ` in ASCII mode) or a per-segment ` · `.
6. Mostly by different foreground colours; only the model has a fill. Related fields use a coordinated palette ("so related fields read as related", `render.rs` header).
7. Text colour on the model chip is a fixed dark navy. Classic deliberately keeps terminal-default text and "no bold, no saturated shades". No luminance logic found.
8. Emoji in classic (`render.rs`: 💰 ⏱ 🌿 📁 🎉Cache), box-drawing ticks `━` in ribbon, `CLAUDE_HUD_ASCII` switches to ASCII (`-`, `>`, `|`).
9. Priority-based dropping of segments when too narrow (`fit`), OSC 8 hyperlink on a segment (`hyperlink`), a "(cold)" cache marker.
10. Env vars: `CLAUDE_HUD_STYLE`, `CLAUDE_HUD_ASCII`, `CLAUDE_HUD_ONELINE`, `CLAUDE_HUD_MARGIN`. No config file found.

## pimp-my-statusline
https://github.com/smokills/pimp-my-statusline , stars 4
1. The user chooses a colour per element in a browser builder. Each element's style is a `ColorSpec` union (`src/model/types.ts`): `fixed` (xterm-256 index), `ansi16`, or `threshold` (stops `{at, code, ansi16}`). Default preset (`src/model/presets/defaultPreset.ts`): directory bold blue(34), git branch bold green(32), model bold white(37), effort dim white, labels Session cyan(36) / Week magenta(35); context, session and week values use `threshold` (`DEFAULT_THRESHOLD_STOPS` in `src/model/segments.ts`: >=90 red 31, >=70 yellow 33, else green 32).
2. Presets rather than themes (`src/model/presets/`); the default preset is the one the author's own script produced. No theme format. Users build and persist their own config in localStorage.
3. ANSI 16 and xterm-256 (`38;5;N`, `src/generators/fragments.ts`). No truecolor. The output of `renderToAnsi.ts` is the exact bytes the exported script prints. No depth detection, no NO_COLOR found in the generator.
4. Foreground-only (bold/dim attributes). `TextStyle` carries colour, bold, dim; no background field was found in `types.ts` (grep for `kind:` only shows the three colour kinds).
5. Plain text joiners between elements, set per row (`Row.joiner`, default two spaces) with a per-segment override (`types.ts` line ~103). A `separator` segment type exists. No powerline.
6. Whatever the user picks; default distinguishes by hue.
7. Not present.
8. Optional emoji per element (`emojiDefault`, `seg.emoji`); reactive ASCII pets (cactus, cat, dog, owl, robot, fish).
9. A web configurator (the product): drag and drop rows, 256-colour picker (`src/ui/Color256Picker.tsx`) with recents, live preview, scrubbable mock session, exports Bash, Python or Node script that embeds its config for re-import.
10. Config in the browser, exports `~/.claude/statusline.{sh,py,js}`; hand-editable output; `refreshInterval: 10` snippet when time data is shown.

## claude-code-hero-journey
https://github.com/soulrocha/Claude-code-hero-journey , stars 4
not a Claude statusline: a Claude Code mod (RPG-style HUD) that draws a one-line band above the prompt and a side pane, using Clawd art classes coloured by "rarity"; targets the desktop app. Styling not read in depth.

## clawmeter
https://github.com/tnunamak/clawmeter , stars 4
1. The `clawmeter statusline` command prints no colour. `internal/cli/status.go statusLine()` returns plain text such as `CM Opus est. 83% reset 2h` with a state prefix: `CM` normal, `CM~` when the forecast is at or above 90% or stale, `CM!` when at or above 100% or out now. The colour work is in the table output (`colorLines`/`colorBar`: usage past an even pace is red, the gap short of it green, with `\033[31m/32m/1m/2m`) and in the tray icons (`internal/tray/icons`).
2. Not present for the statusline (tray icon themes exist in `icontheme_*.go`).
3. Statusline: none. Table: ANSI red/green/bold/dim.
4. Foreground-only text.
5. Spaces only.
6. The `CM`/`CM~`/`CM!` prefix is the only state signal.
7. Not present for the statusline.
8. ASCII only in the statusline.
9. It is mainly a tray app and CLI quota forecaster; the statusline is its cache-only integration (`clawmeter setup --claude-statusline`).
10. CLI subcommands (`statusline`, `status --agent`, `setup`); no styling config.

## cute-claude-hooks
https://github.com/UF-gzj/cute-claude-hooks , stars 4
1. No colour. `monitor/statusline.js buildStatusText` returns one uncoloured string: `Claude 监控: 调用次数 N | 使用模型 X | 输入Token … | 输出Token … | 费用 $… | 上下文 N%`. The file has no escape sequences.
2. Not present.
3. Not present in the statusline (`bin/install.js` has a magenta `\x1b[38;5;206m` for installer output only).
4. Plain text.
5. Plain ` | `.
6. Labels only.
7. Not present (it does truncate by display width, assuming CJK is 2 columns: `getDisplayWidth`).
8. Chinese labels, no icons.
9. The repo's main content is localisation and tool tips; the statusline is minor.
10. None found for styling.

## ccdrawu
https://github.com/vulcanshen/ccdrawu , stars 4
1. By state or threshold, one fixed palette. `hooks/items.ts` `C` (Catppuccin Mocha hex): text #cdd6f4, blue #89b4fa labels, lavender #b4befe model, surface #45475a separator, green #a6e3a1, red #f38ba8, peach #fab387. `hooks/format.ts usageColor`: green under 50, yellow #f9e2af under 70, peach under 90, red from 90 (context, session, weekly). `effortColor`: low green, medium yellow, high peach, xhigh maroon #eba0ac, max red, other sky #89dceb. Git added green; version "newer available" peach; service status green/peach/red. Label and value are coloured separately per item (labels all blue).
2. One fixed theme, Catppuccin Mocha; README says "cannot be changed yet". It does write a Claude Code custom theme (`internal/claude/theme.go`, `~/.claude/themes/ccdrawu.json`, base one of dark, light, dark-daltonized, light-daltonized, dark-ansi, light-ansi) to set the side pane's background (`composerSidebarBackground`).
3. Truecolor only (`internal/statusline/statusline.go paint` emits `38;2;r;g;b`). No downsampling; the README advises `CLAUDE_CODE_TMUX_TRUECOLOR=1` inside tmux. No NO_COLOR handling found.
4. Foreground-only in the statusline; the pane background comes from the Claude Code theme.
5. ` | ` (configurable, `cfg.Statusline.Separator`) painted in surface #45475a.
6. Label colour (blue) versus value colour; separators dim. No alternation.
7. README: "colors are made for a dark background... on a light terminal the text is hard to read". Config `Statusline.Color = "dimmed"` strips all ANSI and lets Claude Code dim it.
8. Optional Nerd Font bar glyphs, with a `line` bar fallback ("Without a Nerd Font, set Bar to line"); a pixel-art pet.
9. Two surfaces from one data source: a docked sidebar mod and a statusline command; `Statusline.When` narrow-only mode.
10. TUI (`ccdrawu`) preferences with a config file; per-item toggles, label format (`value`/`short`/full), colour mode (`highlighted`/`dimmed`), separator.

## cc-poor-mans-statusline
https://github.com/alexfazio/cc-poor-mans-statusline , stars 3
1. Fixed per segment role, by background fill, in `statusline.sh` "Color definitions (256-color palette)": model magenta(5) on white text, project yellow(3), branch green(2) (black text on both), usage limits cyan(6) on black, reset times blue(4) on white, Opus magenta(5), Sonnet blue(4), context grey(8). The colour is attached to the information type, not to position. The one threshold function `format_percentage` (<=50 green, <=80 yellow, else red, bold) colours percentages outside the powerline rows.
2. Not present; the palette is hard-coded.
3. 256 index with ANSI-16 values 0-15 (`48;5;N` / `38;5;N`). No detection, no NO_COLOR.
4. Background-filled powerline cells with explicit text colour per cell (white on dark, black on light).
5. Powerline arrows (`PL_ARROW`, U+E0B0). `pl_segment bg fg text next_bg` prints the arrow with fg = this cell's bg and bg = the next cell's bg; `pl_segment_end` closes with an arrow on the terminal's own background.
6. Adjacent cells are distinct hues (magenta -> yellow -> green; cyan -> blue; magenta -> blue -> grey). Alternating cyan/blue is used for label and value pairs.
7. Black or white text hand-chosen per cell; no automatic contrast calculation.
8. Powerline glyph requires a Nerd Font/Powerline font; `⚠️` emoji for the warning.
9. Three rows (model/project/branch; limits with reset times; model limits and context).
10. Edit the script; no config.

## superline
https://github.com/alxhill/superline , stars 3
1. Theme role mapped to modules, with states. A `ClaudeCodeScheme` trait in `src/modules/claude_code.rs` gives each Claude module its own `fg`/`bg` (model, context, cost, duration, cache, vim, agent, session) and `DefaultColors` provides fallbacks (default, secondary, alert). Rainbow theme (`themes/rainbow.json`): model fg black on 256-173, context white on mid_grey with `threshold_bg` `warning_red` once the optional `threshold` percentage is reached, cost black on 150, duration mid_grey on dark_grey, cache white on `turquoise_blue` (warm) or `dark_blue` (cold), vim white on blue/forest_green/nice_purple for normal/insert/visual, agent white on nice_purple, session light_grey on mid_grey. In shell prompt modules the `cwd` cycles through `bg_colors` by path-segment position (rainbow: red, orange, yellow, green, blue, nice_purple). Git and PR cells colour by state (clean/dirty/staged/conflicted; draft/open/merged/closed).
2. Three bundled themes: rainbow, simple, gruvbox (`BUNDLED_THEMES` in `src/themes.rs`). Format: JSON with `defaults {fg,bg}` and per-module keys (`bg`, `fg`, `*_bg`, `*_fg`, `bg_colors`, bold/italic/underline attributes). Users write their own theme file, edit it in the built-in TUI, and `c` duplicates one.
3. 256-colour palette indices plus a `none` value meaning the terminal's own colour (SGR 39/49) (`src/colors.rs ColorCode`). Named colours map to indices (`black`=0 ... `dark_grey`=234 etc.). No truecolor, no NO_COLOR handling found in `colors.rs` or `powerline.rs`.
4. Background-filled cells with a per-module foreground; a `none` bg lets the terminal show through.
5. Powerline glyphs, three shapes: chevron (E0B0/E0B2, default), round (E0B4/E0B6), none (`Separator` in `src/powerline.rs`). Stateful per side. `Style::simple` sets the separator foreground to the cell's background (`sep_fg = BgColor::from(bg).transpose()`), so the arrow takes the cell's colour. Thin glyphs (E0B1/E0B5) are used between two cells sharing the terminal background.
6. Different background colours per module; the cwd path segments cycle through a list.
7. Each module's fg is chosen by the theme author (e.g. black on light orange, white on dark red). No automatic contrast.
8. Nerd Font required (README); a TUI glyph browser; the editor's colour picker previews as you move.
9. A full-screen TUI editor (`superline config`) with a live preview, 256-colour picker and swatches, undo, theme picker; a website with screenshots; async cached background modules for usage (Claude and Codex).
10. `config.json` (rows with `left`/`right` module arrays, per-module options, `padding`), theme JSON file, `superline config` TUI, `superline install <shell>`; also drives Claude Code's statusline with the same widgets and themes.

## claude-statusline (Andrewvlad)
https://github.com/Andrewvlad/claude-statusline , stars 3
1. State-driven only, foreground, ANSI 16. `statusline-command.sh`: git staged `+n` green, modified `~n` yellow, untracked `?n` red; rate-limit bar+percent green under 70, yellow 70-89, red from 90 (`format_rl`); pace delta red `⇡n%` when ahead of the window, green `⇣n%` when behind; `>200k` warning red; lines added green, removed red. Everything else (model, dir, branch, labels) is the terminal default colour.
2. Not present.
3. ANSI 16 only (`\033[31m/32m/33m`). No depth detection, no NO_COLOR handling.
4. Foreground-only.
5. Plain ` | ` between segments.
6. Labels and position only.
7. Not present, apart from relying on the terminal's own ANSI palette.
8. Emoji (📁 🌳 🌿 🕐 🗘) and block bars `█░`. When `TERMINAL_EMULATOR` is JetBrains-JediTerm it switches to ASCII (`#`, `-`, `+`) because wide glyphs break redraw.
9. Pace delta versus the 5h window.
10. Edit the script; no config.

## claude-code-effort-cycle
https://github.com/Anerco/claude-code-effort-cycle , stars 3
not a Claude statusline: a Claude Code mod that adds an effort meter to the footer and tasks list (`Opus 5.5 ▰▰▰▱▱ high`). Its colours are theme keys by level, `hooks/register.tsx` `HEAT`: low `inactive`, medium `success`, high `warning`, xhigh `claude`, max `error` (cool to hot, following the user's theme); for tasks-list rows it converts them to ANSI (gray 90, green 32, yellow 33, orange 38;5;208, red 31).

## claude-code-statusline (AsafSaar)
https://github.com/AsafSaar/claude-code-statusline , stars 3
1. Fixed per segment plus thresholds, ANSI 16 foreground (`statusline.sh`): cwd white(37), git branch cyan(36), dirty yellow(33), ahead/behind yellow, model 256-lavender(147), node green(32), cost magenta(35), duration blue(34), stash yellow, TS errors red. Thresholds: context green under 50, yellow under 80, red from 80; rate limits same; last-commit age green/yellow(30 min)/red(2 h); effort low green, medium cyan, high yellow, xhigh magenta, max red; lines `+` green / `-` red.
2. Not present.
3. ANSI 16 with two 256 indices (147, and `38;5;...` only for model). No detection, no NO_COLOR.
4. Foreground-only.
5. Dim grey `|` (`SEP=' \033[90m|\033[0m '`).
6. Different hue per segment type plus the separator.
7. Not present.
8. Emoji icons set at the top of the file (📂 🧠 🔋 💰 ⏱ ✏ ⚠ ⏰ 📦 🎚 ⏳) and a Nerd Font branch glyph (U+E0A0). Icons are editable constants.
9. None; a `ENABLED_SEGMENTS` array to toggle segments; example minimal and git-focused variants (`examples/`).
10. Edit constants in the script (`ENABLED_SEGMENTS`, `ICON_*`); PowerShell port.

## brif
https://github.com/balgaly/brif , stars 3
1. Fixed per segment plus thresholds, ANSI 16 foreground (`statusline.sh`): model bold cyan, branch bold magenta, agent name and subagent badge cyan, vim mode yellow, worktree magenta, staged green, modified yellow, untracked red, cost green, lines +green/-red. Context bar colour by percentage: green under 70, yellow 70-89, red from 90. Status badges: APPROVE yellow, BLOCKED red.
2. Not present as themes; only `CFG_STYLE` (`banner` or `classic`) and `CFG_ACCENT_COLOR`.
3. ANSI 16 for segments; truecolor (`38;2;r;g;b`) for the accent line. No depth detection, no NO_COLOR handling.
4. Foreground-only.
5. `CFG_SEPARATOR` = `"  |  "` plain text.
6. Hue per segment type. The banner style adds a full-width rule line on top.
7. Not present.
8. `CFG_PREFIX` text; emoji minimal; `━` accent line; bar glyphs for context.
9. The accent line (banner style): a `━` row across the terminal width, an interpolated gradient indigo #6366f1 -> magenta #ff44cc -> cyan #00d4ff (or a solid `CFG_ACCENT_COLOR` hex).
10. `CFG_*` variables at the top of the script; PowerShell versions; a separate `brif-pane.sh` pane.

## claude-statusline (Benniphx)
https://github.com/Benniphx/claude-statusline , stars 3
1. By state, one threshold function. `adapter/render/ansi.go ColorForPercent`: green under 50, yellow under 80, red from 80. Used for the model name (`cmd/statusline/main.go`: "Model name (colored by context %)"), the context bar and percentage, rate-limit values and the progress bar (`progressbar.go MakeBar`). Everything else is dim: separators, duration, agent count. Lines added are green, removed red.
2. Not present.
3. ANSI 16 (`\033[31m/32m/33m/36m/34m/35m`, dim). `BgBlue`/`BgRed` for the split bar only. No depth detection, no NO_COLOR handling found.
4. Mostly foreground-only. The rate-limit split bar paints a red background behind `▇` where usage and elapsed time overlap (`MakeSplitBarStyled`).
5. Dim `│` between sections.
6. Neighbours share the threshold colour; they differ in glyphs and the dim separators.
7. Not present.
8. Emoji and box/bar glyphs (`█░▇▁`); Go port with a Bash original in `scripts/statusline.sh`.
9. Split bar with a time-elapsed overlay, burn rate, pace.
10. Environment variables and a settings file in `adapter/config`; no style options.

## ezbar
https://github.com/birdayz/ezbar , stars 3
not a Claude statusline: a GPU-rendered (iced, Wayland layer-shell) status bar for Sway with themes and presets (catppuccin, gruvbox, nord, tokyo-night, a lilac-islands default); a live Claude-usage widget is one of its built-in widgets.

## claude-code-plan-statusline
https://github.com/blazemalan/claude-code-plan-statusline , stars 3
1. Four tiers by usage, colour set per theme. `statusline.sh` (lines 466-468) maps a value to `TIER_URGENT` (>=90), `TIER_HOT` (>=70), `TIER_WARN` (>=50), else `TIER_CALM`. Each theme assigns the four tier SGR strings, the model-name colour (`NAME_SGR`), the separator colour and a `META` style. `default`: 32 / 33 / 38;5;208 / 31, bold name. Several themes leave CALM and WARN empty ("silent") so only HOT and URGENT show colour. Circle glyph and label can take the tier colour (`@tier` sentinel). At 100% an "easter egg" message flashes between two colours.
2. Twelve bundled themes selected by `theme=` in `~/.claude/plan-statusline.conf`: default, hearth, glow, scrubs, harbor, atomic, slime, rainbow, plus Dracula, Nord, Gruvbox and Catppuccin Mocha (copied from Oh My Posh themes, truecolor, e.g. dracula `TIER_CALM='38;2;80;250;123'`, name `1;38;2;189;147;249`). Format: shell function per theme assigning variables. Users cannot add one without editing the script; a missing or invalid theme falls back to default.
3. ANSI 16, 256 and truecolor mixed per theme. Honours `NO_COLOR` (non-empty suppresses all colour and style; layout unchanged). No depth detection.
4. Foreground-only.
5. Plain separators set per theme: ` │ ` (default), ` · ` coloured by `SEP_COLOR`; atomic uses starburst glyphs; a theme can animate the separator through `SEP_ANIM` frames.
6. Not by hue between neighbours: one model-name colour, the same tier colour on the circle and label, separators in a muted colour.
7. Not present. Themes are built for dark terminals.
8. Five-step fill circles `○◔◑◕●`, emoji (💀), box characters; no ASCII fallback beyond NO_COLOR.
9. The `rainbow` theme: a per-character rainbow gradient that drifts a hue step each repaint (`rainbow_next`, `RAINBOW_SPEED` via `rainbow_speed=N`), and the `slime` drip theme, neither of which is a static colour. A PowerShell port is kept byte-compatible with the bash version.
10. `~/.claude/plan-statusline.conf` keys (`theme`, `rainbow_speed`, `model_weekly`), `NO_COLOR` env var, `PLAN_SL_NOW` test hook.

## claude-statusline (Brainmetrix)
https://github.com/Brainmetrix/claude-statusline , stars 3
1. Two surfaces. (a) A VS Code status bar item (`src/extension.ts`): `colorThreshold` returns `$(error)` at >=80, `$(warning)` at >=50, otherwise nothing (VS Code theme icons); the item's background becomes `statusBarItem.errorBackground` when context >= 80 (a VS Code theme colour key). (b) The extension writes a bash statusline script (generated by the `a(...)` lines near the top): model magenta, context bar and rate limits coloured by `rate_color`/ctx thresholds (green under 50, yellow 50-79, red from 80), separator dim `│`.
2. Not present for the script. The VS Code item follows the editor's theme through theme colour keys.
3. ANSI 16 in the generated script (`\033[31m/32m/33m/35m/36m`). No detection, no NO_COLOR found.
4. Script: foreground-only. VS Code item: background fill for the error state only.
5. Dim ` │ ` in the script.
6. Segment type and separator.
7. VS Code theme colour keys adapt to light and dark themes; the bash script does not.
8. `█░` bars in the script, `·` empty in the VS Code bar; 🟢 emoji in the hover table.
9. Hover tooltip table with usage details.
10. VS Code settings (`showContextBar` etc.); the script is overwritten on activation ("Do not edit manually").

## claude-cli-status-bar (bsmr / ccsb)
https://github.com/bsmr/claude-cli-status-bar , stars 3
1. Configurable per segment, with a palette by position and per-segment thresholds. Default config (`internal/pkg/render/render.go defaultConfig`): a powerline with round end caps and solid chevrons; each row fills its background from a shared `Palette` of nine greys (`232`..`240`), rotating one palette slot per visible segment (`Row.Palette`, overridden by `Segment.BG`), and each output row starts `PaletteStride` (default 2) slots further along, so every row starts "two shades brighter than the previous one". Segment foregrounds: model bold 33 (blue), git_branch 33, context/limit_5h/limit_7d/lines/cwd/version 245 (grey); context and limits switch foreground at 70% to 136 (yellow-brown) and 90% to 160 (red) (`Thresholds` with `ThresholdTarget: "pct"`); `schema_health` alarm is 160 on bg 52; update notice yellow 136 -> orange 208 -> red 160 by how far behind.
2. No named themes. The look is one JSON config (`Config`: `powerline`, `powerline_style`, `cap_style`, `palette`, `palette_stride`, rows/segments with `fg`, `bg`, `bold`, `bar_fg`, `bar_thresholds`, `label_fg`, `label_thresholds`). Users define their own.
3. ANSI 256 index only (`fg256`/`bg256` in `ansi.go`, strictly validated 0-255 to block escape injection from a config). Honours `NO_COLOR` (`statusline.Options.NoColor`, `style` returns plain text when colour is disabled). No truecolor, no downsampling.
4. Both: powerline mode fills the row's background; non-powerline mode is foreground-only. A row can opt out to plain text (`Align`-right/plain rows).
5. Powerline glyphs: thin chevron U+E0B1 (default) or solid U+E0B0 (`powerline_style`); end caps round (E0B6/E0B4), square, or slant (E0BC/E0BA) via `cap_style`; plain ` | ` when powerline is off. Reversed chevron for right alignment.
6. Alternation by lightness: neighbouring cells step through the greys (one step per visible segment, hidden segments take no slot), and each row starts two steps lighter than the previous. Thin chevrons separate them.
7. Not present as automatic contrast; the grey backgrounds are very dark (232-240) with grey 245 text.
8. Nerd Font powerline glyphs by default, a skull marker for schema health, emoji in some segments; there is a plain ASCII fallback with `|` (powerline off).
9. Margin and full-width background fill to the terminal's right edge, schema drift indicator, update-notice colouring, tmux/terminal size detection from `COLUMNS`/`LINES`.
10. JSON config file (rows, segments, palette, caps, margin), `NO_COLOR` env var, CLI `ccsb`.

## dotclaude
https://github.com/CarloArnone/dotclaude , stars 3
not a Claude statusline: a Claude Code mod that adds a Workspace pane (vitals rail, approval gate, plan review, notes). Styling is in the mod's `hooks/ui/tokens.ts`; not read in depth.

## claudio-rasta
https://github.com/casaroli/claudio-rasta , stars 3
1. Fixed per segment, 256 index foreground (`statusline/claudio-rasta.sh`, inline Python): rasta flag `▰▰▰` red 160 / gold 220 / green 34, cwd leaf 🌿 in 70 (leaf), branch `☘` sun 214 when clean or `✦` fyah orange 202 when dirty, model 🦁 amber 178, a random "blessing" phrase dim cream 230. The pipe before each part takes its own colour: gold 220 before the branch, green 34 before the model, red 160 before the blessing; a black/gold/green "Jamaica" flag ends the line.
2. One palette in code. The repo also ships matching terminal themes for Alacritty, WezTerm, Ghostty, iTerm2 and kitty (`themes/`), not a statusline theme system.
3. 256 index only (`38;5;N`, `48;5;N` helpers defined). No detection or NO_COLOR.
4. Foreground-only.
5. Coloured `│` pipes, each in a different palette colour (gold, green, red).
6. Different hue per segment; the coloured pipe also acts as the divider.
7. Not present; the terminal themes are supplied for the same palette.
8. Emoji (🌿 🦁) and Unicode (`▰ ✦ ☘ │`).
9. The tricolour flag motif, a random phrase per refresh.
10. Edit the script; no config.

## lumira
https://github.com/cativo23/lumira , stars 3
1. Two renderers. Classic (`src/render/line1.ts`): fixed colour names per widget (model cyan, branch magenta, repo and directory brightBlue, active task yellow, worktree and agent gray, duration/memory/tok-s/version dim, lines `+` green `-` red, extra directories dim or orange at 5+), and state colours: context `getContextColor` (green under 50, yellow, orange from the warning threshold 65 by default, blinking red from critical 78), quota `getQuotaColor` (50/70/critical), pace delta, cache-hit tier (<40% blinkRed, <70 orange, <90 yellow, >=90 hidden), API latency tier. Powerline (`powerline-line1.ts`): backgrounds by role from the theme's `powerline` palette: `modelBg`, `dirBg` (also repo, worktree, custom commands), `branchCleanBg` (also duration, speed, time-based items), `branchDirtyBg` (branch swaps to this when dirty), `taskBg` (tasks, extra-dir count >= 5, agents), `versionBg` (version, extra dirs). So colour follows a semantic role per widget, with the branch changing role by git state.
2. Seven bundled themes (`src/themes/`: dracula, nord, tokyo-night, catppuccin, monokai, gruvbox, solarized), each a `ThemePalette`: eight foreground slots (cyan, magenta, yellow, green, orange, red, brightBlue, gray) plus a `powerline` palette of six background slots and a `fg`. A theme without one gets a derived palette: `derivePowerlinePalette` darkens its hues by 55% (cyan -> model, brightBlue -> dir, magenta -> clean branch, red -> dirty branch, yellow -> task, gray -> version). WCAG AA (4.5:1) against the white foreground is enforced in CI. A theme is a source file plus a registry line (CONTRIBUTING); no user-supplied theme file was found.
3. Three colour modes (`src/render/colors.ts`): `named` (ANSI 16, default, with orange as 256-208), `256`, `truecolor`, auto-detected by `detectColorMode` from `COLORTERM`, `TERM` ending in `-256color`, `TERM_PROGRAM` (iTerm.app, Hyper). A theme applies in 256 by projecting RGB with `rgbTo256Index`; in `named` mode themes are ignored. `NO_COLOR` and `--no-color` are documented for the `lumira stats` command; for the statusline renderer `unverified (README only)`.
4. Both: classic is foreground-only, powerline fills each segment's background with a fixed white foreground.
5. Powerline styles (`POWERLINE_STYLES` in `powerline.ts`): arrow, flame, slant, round (caps), diamond (isolated pills with a gap), compatible (`▶`), plain; `auto` picks arrow with a Nerd Font and `▶` otherwise. Separator fg = the cell's bg and bg = the next cell's bg ("all common implementations agree"). Classic uses a plain separator.
6. Powerline: different background per role; but adjacent cells can share a role colour (e.g. branch-clean, duration and speed all use `branchCleanBg`), so it relies on the arrow. Classic: different foreground colours.
7. Contrast is by construction: dark-enough backgrounds checked against white text (WCAG AA test in CI); named mode follows the terminal's palette. No light/dark switching. Theme metadata has a `mode` field (dark).
8. Three icon sets: `nerd` (default, Material Design glyphs; battery glyphs by 10% bucket), `emoji`, `none` (empty strings). Powerline `auto` falls back to `▶` without a Nerd Font.
9. `lumira themes preview <name> [--powerline] [--style=flame]` and `--all` gallery CLI; priority-based eviction of powerline segments when narrow (`applyPriorityEviction`); blinking red (`\x1b[5;31m`) for critical states; screenshots gallery of all themes in both modes; `subagentStatusLine` rows in the same theme.
10. `~/.config/lumira/config.json` (preset, theme, icons, style, layout, per-widget `display.*`, context thresholds, `refreshInterval`), an install wizard, CLI flags, `lumira themes`/`stats`/`subagent` commands.

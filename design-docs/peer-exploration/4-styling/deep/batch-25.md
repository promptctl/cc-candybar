## pilot
https://github.com/P1tak4s/pilot — 1 star
Not a conventional statusline: a Claude Code mod (band above the prompt + panels, `hooks/*.tsx`) whose "one quiet line" shows effort/model/context. Styling read from `hooks/theme.ts` and `hooks/register.tsx`.
1. Fixed per element, plus state: the effort label in the footer is written in `ACCENT = accent()` (`register.tsx:28`), or `EMBER` when Save mode is on (`register.tsx:4531`). Alert cards are fixed hues by kind: `ICE #7cc4ff` (cache cold), `BOG #a7c98f` (reread), `EMBER #f08a3c` (running hot), `SLATE #b4b8c4` (judge down) (`register.tsx:91-104`). Progress phases map to a colour triple `{color,bg,edge}` (`progress.tsx` `LOOKS`: planning/working violet `#a79cf7`, paused `#7d76a8`, asking `#e0a33a`, done `#6fcf8e`).
2. Three accent themes `violet|orange|rose` (`theme.ts:6`). Not a palette-role format: every `#rrggbb` in the violet hue band (h 235-300, chroma and saturation gates, `theme.ts:tintHex`) is rotated to a target hue (orange 15, rose 340) while neutrals and green/yellow/red/blue are left alone. User chooses via `config.theme`; no user-defined theme format.
3. Truecolor hex everywhere (modded Ink `<Text color="#...">`). No ANSI-16/256 or NO_COLOR handling found.
4. Both: panels have `backgroundColor`+`borderColor` (`BRAND_BG #15121f`, `BRAND_EDGE #4a3f80`, `register.tsx:33-35`); the line text is fg-only.
5. Not present (no separators; rounded borders `borderStyle="round"` on cards).
6. Neighbouring cards distinguished by hue family (ICE/EMBER/BOG/SLATE each with its own bg and edge colour).
7. Light mode: `setLight`/`lightHex(hex, role)` (`theme.ts`) converts every dark-panel colour for a light app: surfaces go pale, text darkened by a loop until contrast against the palest surface is at least 4.6:1 (`PALE_REF`, luminance function in the same file). Role is `text|surface|art`.
8. SVG art and emoji; no Nerd Font or ASCII modes.
9. Animated SVG sparkles/embers, petals falling for rose theme (`theme.ts:petals`); a thin moving line whose speed follows effort (README); hover backgrounds `HOVER_BOX`.
10. Settings UI inside the mod (`config.theme`); no config file format documented in the files read.

## p2k0/claude-status-line
https://github.com/P2K0/claude-status-line — 1 star
A web configurator (Vite/React/Tailwind) that generates a bash statusline script (`src/utils/builder.ts` `generateScript`). Styling is in `src/constants.ts` and the generated script.
1. By element and by threshold. Generated script defines `MODEL_COLOR`, `DIR_COLOR`(=`low`), `GIT_COLOR`(=`model`), `GIT_CLEAN`(=`low`), `GIT_DIRTY`(=`high`), `TOKEN_COLOR`, `PROGRESS_BAR` (`builder.ts` var block). Progress bar colour has three modes (`barColorMode`, `constants.ts:barColorModes`): `static` (theme bar colour), `dynamic` (<50 low/green role, <80 mid, else high), `gradient` (truecolor interpolation, `(128+p*127/100, 128-p*64/100, 255-p*200/100)`, cold blue to warm red).
2. Bundled colour presets in `constants.ts:colorPresets`: dracula, tokyo-night, catppuccin, gruvbox, nord, one-dark, everforest, rose-pine, monokai-pro, ayu-dark, material-ocean, palenight, horizon (dark) plus github-light, solarized-light, mono-light and mono-dark (type `light`). Format is a six-role semantic palette per preset: `model, low, mid, high, token, bar`, each with a hex and an `ansi` 256-index twin. No user-defined theme beyond picking in the UI.
3. Emits 256-colour only: `\033[38;5;<n>m` from the preset's `ansi` indices (`builder.ts`); the hex is only for the web preview. One exception: the `gradient` bar mode emits `38;2` truecolor. No detection, no NO_COLOR.
4. Foreground only.
5. Plain-text separators chosen in the UI (`constants.ts:separators`): space, pipe ` │ `, dot ` · `, angle ` › `, "powerline" soft arrow, "powerline-solid" hard arrow (Nerd glyphs), pixel ` ░ `. All use the single `SEP` string, uncoloured (the powerline entries are just glyph separators with no bg, so no colour handoff).
6. Separator only; hues differ by role (model vs dir vs git vs token) per preset.
7. Preview toggle `previewMode` dark/light and light presets (`type: 'light'`) with darker ANSI indices; nothing detects the terminal. No contrast computation.
8. Eleven dir-prefix glyph options and seven git-prefix options (emoji, `λ`, `$`, Nerd folder/branch) in `constants.ts`; progress styles include emoji (🟢/⚪, ❤️/🖤, moon phases), braille, stars, diamonds.
9. Live web preview of the output; Chinese/English i18n; layout single or double line.
10. Web GUI exporting a bash script; no file config or env vars at runtime.

## pablobfonseca/claude-session-manager
https://github.com/pablobfonseca/claude-session-manager — 1 star
not a Claude statusline: a tmux + fzf popup that lists panes running `claude` and their status (active/approval/idle). Only styling: truecolor status icons in `src/tmux_integration.sh:99-104` (active green `38;2;0;255;65`, approval yellow `255;255;0`, idle grey `139;147;166`).

## pcritchfield/claude-gauges
https://github.com/PCritchfield/claude-gauges — 1 star
Statusline (`statusline.sh`) paired with a mod (`mod/`) that shares session files.
1. By element and by state. Model: Opus gold 220, Sonnet lilac 183, Haiku copper 172, other cobble 240 (`statusline.sh:233-238`). Dir cobble, branch river 31, staged green 70, modified flame 202, untracked cobble, "(clean)"/"(no git)" dim (`:244-254`). Context bar by threshold: ≥90 DANGER 196, ≥75 FLAME 202, ≥50 GOLD 220, else GREEN 70 (`:268-276`). 5h/7d/spend limits coloured by pace not raw percent: level 0 green, 1 flame, 2 danger (`:289-296`, level computed in jq from projected usage vs elapsed window). Cost gold; "other sessions" line cobble/green/flame.
2. Not present. One fixed palette of eight names (GOLD, COPPER, COBBLE, RIVER, FLAME, DANGER, GREEN, LILAC) at `:70-77`.
3. 256-index (`38;5;n`) plus bold/dim. Honours NO_COLOR (`:64`, blanks every variable). No depth detection.
4. Foreground only.
5. Plain text, default ` · ` between segments (`seg` function `:93`), two spaces after dir.
6. Separators only plus hue per segment.
7. Not present beyond dim for secondary info.
8. `⎇` branch glyph, `▓/░` 12-cell bar, `…` truncation; no icon mode switch. Fits every line to `$COLUMNS`, dropping segments that do not fit.
9. Pace-based colouring (projection of usage over remaining window) is the distinctive bit; strips control/bidi chars from every string.
10. Env `GAUGES_CONTEXT_HINT`; thresholds are shell variables in the script; no config file.

## pedrolarosa/claude-code
https://github.com/PedroLaRosa/claude-code — 1 star
Personal setup repo: one statusline script (`statusline-command/statusline-command.js`, read in full) plus several mods (`mods/*`).
1. By state/threshold. Context bar: ≥90 RED, ≥70 YELLOW, else GREEN (`:95`). Each rate-limit gauge picks level colour from `used` and pace (used minus elapsed): hot (≥90 or pace >15) RED, ≥75 or pace >5 YELLOW, else GREEN (`limitPart`, `:63-69`). Fixed elements: cache icon CYAN, cache countdown YELLOW under 10 min else GREY, expired RED, 5h pie icon GREEN, 7d icon MAGENTA, cost YELLOW.
2. Not present.
3. ANSI 16 names only (`\x1b[31m`...`[36m`, `[90m` grey) at `:5-12`. No NO_COLOR in this script (the `NO_COLOR`/`FORCE_COLOR` hits are in the mods).
4. Foreground only.
5. Plain ` | ` between parts, uncoloured.
6. Separators only; a pie glyph progression `○◔◑◕●` for 5h.
7. Not present.
8. Emoji 🌿 ⏱️, `ϟ`, `▦`, `↻`; gauge uses `━` solid, `╍` dashed (gap between usage and elapsed time), see `gauge()` `:39-46`.
9. The dashed segment of the gauge is coloured by level only when usage runs ahead of the clock, grey otherwise. The sibling mod `mods/token-weather-usage/hooks/register.tsx:26-41` shows the same data as coloured pills with a fixed hex per metric (`five_hour #3fb97f`, `seven_day #a07cf0`, `cost #e0b040`, `agents #ec6fa7`) and weather icons by usage band (☀ ☁ ☂ ↯).
10. Edit the JS file; no config.

## pipicraft/claude-code-status
https://github.com/PipiCraft/claude-code-status — 1 star
1. Fixed per segment, plus threshold for context/rate. Model GREEN (`lib/renderers.js:62`), project CYAN (`:324`), git MAGENTA (`:352`), MCP CYAN (`:363`), cost GREEN, +/- lines GREEN/RED, effort and output style DIM. Context bar: ≥danger(90) RED, ≥warn(80) YELLOW, ≥50 CYAN, else GREEN (`:123-131`, thresholds configurable `warningThreshold`/`dangerThreshold`). Cache hit rate GREEN ≥70, CYAN ≥40, else DIM (`:153`). Rate limit RED/YELLOW/DIM (`:263`).
2. Four themes (`lib/utils.js:6-41` `THEMES`): default (ANSI 16), catppuccin, nord, tokyo (truecolor). Format is six semantic names (DIM, CYAN, GREEN, YELLOW, RED, MAGENTA) remapped to hex, so segment-to-colour mapping is shared and only the palette changes. Selected via `config.theme`; no user-defined themes.
3. Default theme uses `\x1b[3Xm`; other themes `38;2;r;g;b`. NO_COLOR honoured in `bin/statusline.js:157` together with config `colors:true/false`. No depth detection.
4. Foreground only.
5. Configurable delimiter string (default `|`), plain text, uncoloured (`lib/config.js:20`).
6. Separators only.
7. Not present.
8. `icons: "none" | "unicode"` (`lib/config.js:21`, no Nerd Font required); presets include a no-colour mode and a 2-line mode (`config.js:73-88`).
9. Interactive install CLI offers presets.
10. JSON config file, CLI (`bin/cli.js`).

## pizzimenti/ccgauge
https://github.com/pizzimenti/ccgauge — 1 star
1. Deliberately minimal colour. Cwd blue 34, model dim, branch yellow, context bar by threshold (≥90 red, ≥70 yellow, else green) in `statusline.sh:113-117`; usage bars in `usage.py` do NOT use severity colours: bar is the terminal default foreground (`BAR_BASE = "\033[39m"`, `usage.py:1170`) with four zones separated by luminance (full block, half-tint, faint) and orange `38;5;208` as the only colour, marking overspend (`OVER_TINT`, `:1172`). README "Why the bar is calm" (`README.md:~403-425`) gives the rationale.
2. Not present.
3. ANSI 16 plus one fixed 256 index (208), chosen because 16-colour bright codes depend on the user's theme (Solarized remaps bright red to orange), whereas 208 is a fixed point. `status plain` mode drops escapes (`usage.py:1327`); `isatty` check at `:1400`. NO_COLOR not found.
4. Foreground only.
5. Plain text.
6. Not present (single bar glyph ramp).
7. Adapts by NOT choosing colours: uses terminal default foreground and dim, so it follows light/dark automatically. Each coloured span closes with an absolute SGR reset so fragments stay self-contained.
8. Block glyphs `█ ▒`; ASCII-ish.
9. Pace shadow marker on the bar (README) is never severity-coloured.
10. Subcommands `usage.py bar|line|status plain`; no config file noted.

## pleonlopes/polaris-marketplace
https://github.com/PLeonLopes/polaris-marketplace — 1 star
Statusline script (`plugins/monitor/scripts/statusline.sh`) plus a desktop monitor window (`window/themes.json`, `window.ps1`).
1. Statusline: threshold only. Bar colour by percent: ≥95 red `31`, ≥80 yellow `33`, else green `32` (`:85-97`); same for 5h, 7d and ctx segments. Text uncoloured.
2. Statusline: not present. Monitor window has four themes in `themes.json`: Dark, Light, Midnight, High contrast. Format is a semantic role map: `card, text, muted, faint, accent, divider, track, bar, barWarning, barCritical, working, finished, question, permission`, hex (some with 8-digit alpha).
3. ANSI 16 for the statusline. NO_COLOR honoured (`:16,87`) by returning an empty colour. Window uses hex (ARGB).
4. Foreground only in statusline; the window is a filled card.
5. ` · ` plain text (`:128`).
6. Separators only.
7. Window has a light theme and a high-contrast theme; statusline relies on terminal.
8. `█/░` bar, 10 cells; no icons.
9. Desktop monitor window with theme picker, beep sounds.
10. Env `NO_COLOR`, `POLARIS_MONITOR_CONTEXT=off`; theme chosen in the window.

## pradeeppeddineni/claude-statusline
https://github.com/pradeeppeddineni/claude-statusline — 1 star
1. Fixed per widget by theme role: each theme's `colors` has keys `model, project, git, version, mcp, context, tokens, cost, time, separator, wellness, joke, quote` (`src/statusline.js:60-160`). Segment-to-colour is therefore fixed per widget and the theme changes the hex. Context percent is not threshold-coloured (always `colors.context`). Git branch always `colors.git`; model is bold.
2. Nine bundled themes (`:58-160`): catppuccin-mocha (default), dracula, nord, tokyo-night, star-wars, batman, marvel, matrix, cyberpunk. Each carries colours, per-widget emoji icons and its own quotes list. Selected by `appearance.theme`; user config deep-merges but a custom theme object is not described.
3. Truecolor only: `\x1b[38;2;r;g;b` via `hexToAnsi` (`:217-223`). No detection, no NO_COLOR.
4. Foreground only.
5. Configurable separator string (default `│`) coloured with `colors.separator`, padded with spaces (`:427`; config `appearance.separator`, `separatorColor`).
6. Different hue per widget plus coloured separator.
7. Not present.
8. Emoji icons per widget and per theme (`icons` map; star-wars uses ⚔️ 🌟 🚀). No ASCII mode.
9. A second line rotating wellness reminders, jokes and themed quotes, with `BLINK` (`\x1b[5m`) for wellness reminders (`:35-36` of the output block), and a stock ticker widget with up/down colours (`colorUp`/`colorDown`).
10. JSON config file via install script; widget on/off per entry.

## prafulsrivastava/claudeextensions
https://github.com/PrafulSrivastava/ClaudeExtensions — 1 star
Small bash hook `hooks/statusline.sh`.
1. Threshold only for the context bar: ≥80 red `31`, ≥50 yellow `33`, else green `32` (`:43-46`). Everything else plain: `[model] bar pct (tokens/size) | branch*`.
2. Not present.
3. ANSI 16, no NO_COLOR.
4. Foreground only.
5. Plain ` | `, uncoloured.
6. Separators only.
7. Not present.
8. `█/░` 10-cell bar; no icons.
9. Nothing else.
10. None (edit script).

## qucooln/wezterm-claude-status
https://github.com/qucooln/wezterm-claude-status — 1 star
not a Claude statusline: a WezTerm (Windows+WSL) config that shows Claude Code state lights (spinner, amber dot waiting, green dot done) in tab titles and the WezTerm status bar, driven by hooks writing per-pane state files; also themes WezTerm (Noctis Minimus).

## radioheavy/status-chat
https://github.com/radioheavy/status-chat — 1 star
Code-Line Messenger: team-chat daemon whose Claude statusline (`.claude/scripts/statusline.js`, read in full) is a two-line display.
1. By element/state: `[model]` CYAN, project name uncoloured, context percent / session name / active count GRAY, room code YELLOW. Line 2 label by event priority: high RED, low CYAN, default GREEN (`priorityColor`, `:21-31`); message timestamps GRAY.
2. Not present.
3. ANSI 16 + `90` grey. No NO_COLOR.
4. Foreground only.
5. Plain spaces and ` | `.
6. Hue per element.
7. Not present.
8. ASCII labels `[BLOCKER] [HANDOFF] [TEAM]`.
9. A scrolling marquee for the web/TUI (`src/useMarquee.ts`), unrelated to the statusline colours.
10. None for the statusline.

## raghnallp-hub/claude-code-statusline
https://github.com/raghnallp-hub/claude-code-statusline — 1 star
1. Threshold. Context percent only: 30-44 YELLOW `33`, 45-49 ORANGE `38;5;208`, 50-54 PURPLE `35`, ≥55 RED `31`, below 30 uncoloured (`statusline-command.py:183-195`; unusually low cut-offs, matched to a "context rot" belief). 5h rate limit: green <70, yellow 70-89, red ≥90 (`:43-62`). Git staged `+n` green, modified `~n` yellow (`:115-117`). Everything else uncoloured.
2. Not present.
3. ANSI 16 plus one 256 index (208). No NO_COLOR or detection.
4. Foreground only.
5. Plain ` | `, uncoloured.
6. Separators plus an emoji prefix per segment.
7. Not present.
8. Emoji per field (🤖 💪 🧠 💰 ⏱️ 📍 🌿 🌳 🎙️); no fallback.
9. Nothing.
10. Edit script; both .py and .sh variants.

## rainday/claude-statusline-rust
https://github.com/rainday/claude-statusline-rust — 1 star
1. Fixed per segment on line 1 via ANSI-16 indices (`src/config/theme.rs:25-34`, "matching CCometixLine cometix theme"): directory icon bright yellow 11, dir text bright green 10, git bright blue 12, model bright cyan 14 (bold), context % bright magenta 13 (bold), thinking-on 10, thinking-off 7, effort dim 7, separator 7. Context % is not threshold-coloured by `ctx_ansi` (the `ctx_green/yellow/orange/red` hex fields exist as "legacy"). Lines 2-3 usage bars: hex fills (`usage_current_fill #7BA58A`, `usage_weekly_fill #D4B896`, `usage_empty #4A4A4A`, reset time `#8B8B8B`, tasks `#A0B9C6`).
2. One bundled theme, "morandi" (muted pastel hex, `ResolvedTheme::morandi()` `:44-76`); the config `theme.name` is ignored (`from_config(_name, overrides)`), but `theme.colors` overrides any of 17 named fields (`ThemeColors`, `:4-21`) per user. Format is per-segment colour map.
3. Mixed: ANSI 16 (via `30+n`/`90+n` SGR, `src/engine/renderer.rs:23-40`) for line 1, truecolor `38;2` for bars (`rgb_fg_code`, `:43`). No detection or NO_COLOR.
4. Foreground only.
5. Plain-text separator joined with `ansi_fg(separator, separator_ansi)` (`:54-62`); no powerline.
6. Hue per segment; separators.
7. Using ANSI 16 on line 1 inherits the user's terminal theme (stated intent in comment); no contrast logic.
8. Box/dot glyphs `●○` bars; Nerd Font glyphs appear twice in source (icons for dir/git).
9. Usage bar with `●` fill/`○` empty and a gradient hint in the extractor counts (one occurrence).
10. TOML config (`src/config/*`), CLI (`src/cli.rs`).

## rainnn-w/cc-quota-line
https://github.com/rainnn-w/cc-quota-line — 1 star
1. By threshold on remaining percent (`src/core/status/theme.js:makeTheme`): `colorFor(leftPercent)` ≥60 ok, ≥20 warn, else danger (`lowThreshold` 60, `warnThreshold` 20, configurable); `moneyColor` for balances (<=0 danger, <5 warn, else ok); `info` colour when no number.
2. Themes `dark`, `light`, `morandi`, `mono`, `custom` (`:7-40`). Format is four semantic roles `ok/warn/danger/info`. `custom` takes `color-ok/warn/danger/info` config keys, empty slots inherit dark. `mono` returns empty strings for all colours and bold/dim/reset.
3. Named colours, `#RRGGBB` truecolor, or `ansi256:N` (`src/shared/utils.js:28-44` `parseColor`). No detection. NO_COLOR not found (the `mono` theme is the switch).
4. Foreground only.
5. Not looked at in depth (plain text, `src/core/status`).
6. Not present beyond value colouring.
7. "light" theme is a hand-picked darker palette for light terminals; "morandi" claims it works on both (`theme.js` comment). No automatic adaptation.
8. `█/░` bars (`src/shared/bar.js`).
9. Interactive TUI configurator with its own palette (`src/shared/ansi.js` `getTuiColors`).
10. Config via CLI (`configCommand.js`), TUI, JSON config; thresholds and colours settable.

## ridjex/claude-code-statusline
https://github.com/ridjex/claude-code-statusline — 1 star
Four engines (bash, python, rust, go) producing the same output; bash read in full.
1. Fixed per segment plus threshold. Model cyan 36 (`engines/bash/statusline.sh:431`), git branch magenta 35, dirty yellow 33, git extras cyan, `+n/-n` lines green/red (`:239`). Context bar ▓/░ coloured by threshold: ≥90 red, ≥70 yellow (with ⚠), else green (`:114-126`). Speed tok/s green/yellow/red (`:276-280`). Per-model token breakdown letters: O magenta, S cyan, H green (`:462-470`). Separator `│` dim (`:427`).
2. Not present (single palette; "catppuccin" hit is in a docs SVG converter script, not the renderer).
3. ANSI 16 only. NO_COLOR and `STATUSLINE_NO_COLOR` env or `--no-color` flag strip all SGR (`:26,81-83,483-499`).
4. Foreground only.
5. Dim `│` between sections (`S` var, `:427`).
6. Separators; hue per field.
7. Not present.
8. Emoji and block glyphs; no mode switch.
9. Model-mix bars with one bar per model in magenta/cyan/green, dim `·` when absent.
10. Env vars `STATUSLINE_SHOW_*` and `--no-*` flags (`:14-27`), per segment toggles.

## rm0nroe/coach-claw
https://github.com/rm0nroe/coach-claw — 1 star
Gamified coaching plugin; its statusline is `coach/bin/default_statusline.py` (read in full) plus `statusline_variants.py`.
1. Fixed brand palette, not state: model label and percent ICE_SILVER `38;2;200;214;229`, separators `┃` DEEP_COBALT `30;144;255`, empty bar cells DIM_STEEL `58;58;74` (`default_statusline.py:38-40`). Context bar 20 cells whose filled segments are a position gradient white to cobalt (`_render_bar`, `:57-76`, `r=255-(225*i/(n-1))`, etc.). No threshold colouring. Coach segment: rank-tier sigil colours `bronze/silver/gold/platinum/diamond` (`statusline_variants.py:31-36`), gain in GAIN_EMERALD, muted steel.
2. Not colour themes. `themes.py` holds 12 level-name ladders (craft, forge, cosmic, ocean, skyrim, marvel, dc, finalfantasy, military, lotr, starwars, hacker) of 50 names each; `banner_themes.py` shapes celebration banners for 5 of them.
3. Truecolor `38;2` only. No detection; `render_env.py` handles glyph capability, no NO_COLOR found.
4. Foreground only.
5. `┃` plain heavy bar in cobalt.
6. Separators.
7. Not present (fixed palette for dark terminals).
8. Glyph negotiation for wide characters (e.g. skyrim ⚔ fallback, `banner_themes.py:48`); Roman numerals Ⅰ-Ⅹ for levels.
9. Four statusline variants (crystal, pips, slash, forge) selected from `statusline_variants.py`.
10. `~/.claude/coach/.user_config.json` (theme, variant).

## robhurring/tmux-claude-usage
https://github.com/robhurring/tmux-claude-usage — 1 star
not a Claude statusline in the usual sense: a tmux plugin that wraps the statusline command to cache its JSON and exposes `#{claude_*}` format tokens for tmux status-right. Colour: `#{claude_5h_color}` etc. emit `#[fg=<colour>]` by threshold (`scripts/helpers.sh:106-129`): ≥80 `colour1`, ≥50 `colour3`, else `colour2`, all overridable by `@claude_usage_color_low/mid/high` and `@claude_usage_threshold_mid/high`. tmux 256-index (`colourN`) or any tmux colour name; separators and layout are the user's tmux format string; README examples use `colour208` and `colour242`.

## rubbish0-a/ccline-zh
https://github.com/Rubbish0-A/ccline-zh — 1 star
1. Per-widget colour from config plus state. Defaults (`statusline.config.example.json`): session gray, model cyan, dir yellow, git magenta, bigContext magenta, tokens blue, cost green, duration gray, etc. Effort level colours per level: xhigh green, high yellow, max magenta, medium/low red. Context and rate-limit widgets colour by remaining percent: `colorByRemaining` (`src/colors.js:41-46`): < danger(20) red, < warn(50) yellow, else green; context also takes the more dangerous of the relative threshold and an absolute token line (300K yellow, 400K red, `tokensWarn`/`tokensDanger`).
2. Not present (per-widget colours only).
3. ANSI 16 names plus `90` gray (`src/colors.js:9-20`): cyan, green, yellow, red, blue, magenta, white, gray. NO_COLOR and `CCLINE_NO_COLOR` honoured (`colorEnabled`, `:27-31`). Colour defaults to on despite stdout not being a TTY, with the reason documented there.
4. Foreground only.
5. Configurable separator string (default ` │ `) and `separatorColor` (default gray).
6. Separators; hue per widget.
7. Not present.
8. Chinese labels, emoji, `⎇`; labels settable per widget.
9. Hot-reloaded config (no restart).
10. JSON config `~/.claude/ccline-zh.config.json`; widgets array order = display order; env vars.

## rubenglez/harness
https://github.com/RubenGlez/harness — 1 star
Dev-environment bootstrap; its statusline is `scripts/statusline.sh` (77 lines, read in full). The huge box-character count is documentation, not styling.
1. Mixed. Branch cyan 36 with `⎇`, model magenta 35 (`:22,27`). Context `ctx:N%` threshold: ≥80 red, ≥50 yellow, else green (`:32-40`). 5h and 7d `limit_color` same thresholds (`:44-48`).
2. Not present.
3. ANSI 16, no NO_COLOR.
4. Foreground only.
5. Grey `90` `|` between parts (`:73`).
6. Separators.
7. Not present.
8. `⎇` only.
9. Nothing.
10. Edit script.

## ryan-dia/festatusline
https://github.com/Ryan-Dia/festatusline — 1 star
1. Per-widget colour from config `cfg.color`, else theme `accent` (`src/render/line.ts:14`). Bars: usage bar in the widget's colour, filled `■` full colour, empty `■` the same colour dimmed to 35% (`src/utils/bar.ts:buildBar`). Alert: context and the 5-hour bar plus percent switch to fixed `#ff5555` at ≥80% (`ALERT_COLOR`, `ALERT_PERCENT`); a fixed red rather than `theme.danger`, because the default theme's pink danger read too close to another bar (comment in `bar.ts`). Fixed widget colours seen: `#ffd93d`, `#6bcb77` (`widgets/RateLimit.ts`).
2. Five bundled themes (`src/theme/themes.ts`): default (Catppuccin-ish), dracula, nord, gruvbox, tokyo-night. Format is semantic: `fg, bg, accent, warn, danger, muted, separator`. Selected via settings and a TUI `ThemeMenu`; no user-defined themes. `bg`, `warn`, `danger`, `fg` are mostly unused by the line renderer (only `accent`, `muted`, and `danger` for the update notice are read in the files seen).
3. Truecolor hex via chalk (`chalk.hex`), which downsamples to the terminal's level automatically. NO_COLOR via chalk.
4. Foreground only.
5. Configurable separator string from settings, coloured `theme.muted` (`line.ts:18`). Theme `separator` field is not read there.
6. Separators; a colour per widget.
7. Not present.
8. `■` bars; minimal emoji.
9. Ink-based TUI to pick theme and widgets; i18n; multi-column aligned bar rows.
10. Settings file plus Ink TUI; install/doctor commands.

## ryanweera/crab-progress
https://github.com/RyanWeera/crab-progress — 1 star
not a Claude statusline: a Claude Code mod with a mascot, progress bar above the prompt and subagent panel. Facts: light palette in `hooks/to/src/palette.ts` (`skin #d97757`, `ink #1f1e1d`, `bad #d6453d`, `cold #4f8fd0`), SVG art that follows the app's dark mode, many animations.

## ryx2/slopshopper
https://github.com/ryx2/slopshopper — 1 star
not a Claude statusline: a scraper/directory site for Claude Code mods (the files read are scraped mod sources under `data/mods/`). Its own mod `burn-rate` is a fuel gauge above the prompt; styling not read.

## samiabi/fold-statusline
https://github.com/SamiAbi/fold-statusline — 1 star
1. Fixed per row role and by threshold (`statusline.mjs:36-48`): email cyan `#7dcfff`, name `#c8c8d4`, model purple `#bb9af7`, effort orange `#ff9e64`, 1M badge teal `#2ac3de`, labels `#6a6a80`, frame `#3a3a4c`; meters ok `#9ece6a` under 50%, warn `#e0af68` to 80%, hot `#f7768e` above (README "Colour rules"); a hot meter also tints its icon. Bold only on the numbers.
2. Not present (one palette, "Fold's design system, Tokyo-Night-adjacent").
3. Truecolor only (`fg(hex)` -> `38;2`, `:31-35`); README requires a truecolor terminal. No NO_COLOR found.
4. Foreground only.
5. Rounded box frame and rule rows; `STATUS_SEP=rule|blank|none`, `STATUS_BORDER=on|off`. Blank separator uses U+2800 because Claude Code trims whitespace-only lines (README).
6. Rows and column alignment rather than colour; each role has a distinct hue.
7. Not present; dim greys for quiet parts.
8. Two icon sets: Fold Icons (custom font, U+E900-E913, built from SVG design files with COLR layers) inside the Fold IDE, Nerd Font glyphs elsewhere; auto-detected, `STATUS_ICONS=fold|nerd` overrides. Four graded bolt glyphs for effort low to max; database icon becomes fire at ≥80%.
9. Custom icon font pipeline (`font/*`), SVG README previews rendered from the real script, 1col/2col layouts.
10. Environment variables only: `STATUS_LAYOUT`, `STATUS_BORDER`, `STATUS_SEP`, `STATUS_ALIGN`, `STATUS_BAR`, `STATUS_ICONS`; install CLI.

## sanlee-ys/telltale
https://github.com/sanlee-ys/telltale — 1 star
Go statusline (also Cursor/Antigravity adapters) plus a TUI HUD that share thresholds in `internal/theme/theme.go`.
1. Hue has exactly one meaning each (`theme.go:75-85` comment): cyan = identity (model name), green/yellow/red = severity, dim = de-emphasis; nothing else gets a colour. Severity: green <60, yellow ≥60, red ≥85 (`WarnPct`, `CritPct`). Applied by `pct()` to ctx and window percentages (`statusline/render.go:234-246`). Cache hit ratio deliberately has NO threshold colour (high is good, so severity colouring would invert), explained in the `cacheSegment` comment. Reset countdown is dim.
2. Not present (one semantic palette of indices in `theme.go`, shared by statusline and HUD).
3. ANSI 4-bit codes only (`render.go:26-31`), chosen so the bar inherits the user's terminal theme, including light schemes. `NO_COLOR` read in `cmd/telltale/main.go:234` and passed as `Options.NoColor`; also an `--ascii` switch independent of colour. HUD uses lipgloss with colour profile downsampling.
4. Foreground only.
5. ` │ ` with the bar dim (`render.go:34`).
6. Separators; segments differ by content, not hue.
7. HUD only: `NewStyles(isDark)` takes the terminal's OSC background query answer and picks gauge track colour 7 vs 8 via `lipgloss.LightDark` (`hud/style.go:35-50`), default dark if unanswered. Statusline relies on 16-colour inheritance.
8. `↻` with a space after (ambiguous-width note), `│`; ASCII mode flag.
9. Floors percentages instead of rounding (never overstate usage) in `theme.Percent`.
10. CLI flags and `NO_COLOR` env; no colour config file.

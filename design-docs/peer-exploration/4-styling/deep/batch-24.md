## maestro-context-bar
https://github.com/mbanderas/maestro-context-bar — stars 1
1. Colour by state, one segment only. `statusline/context-bar.sh` (and identical `context-bar.mjs` line ~169): bar fill and the `NN%` text share one colour picked by pct: `<60` green `[32m`, `<85` yellow `[33m`, else red `[31m`. Empty cells, token counts and the `·` are dim grey `[90m`. Folder name is uncoloured.
2. Themes: not present. Only `~/.claude/context-bar.json` keys `enabled/width/style/showFolder/showTokens` (all validated in `context-bar.sh`).
3. Plain ANSI 16 only (`[32m/[33m/[31m/[90m`). No depth detection. NO_COLOR: not present (no reference in `context-bar.sh` or `.mjs`).
4. Foreground only on the terminal's own background.
5. Separator: a dim `·` before the folder, a space elsewhere. Not coloured per neighbour.
6. Neighbours: not distinguished except dim vs. normal text.
7. Light/dark: none. Relies on the terminal's own ANSI palette (that is the only adaptation).
8. Glyphs: `█`/`░` default; `style: "ascii"` in config switches to `#`/`-` (`context-bar.sh` glyph_full/glyph_empty). No Nerd Font, no emoji.
9. Other: three interchangeable renderers (node/pwsh/bash) that produce identical output; `.context-bar-disabled` flag file to toggle.
10. Config: optional JSON file `context-bar.json` (width 4-60, style, toggles); slash commands `/maestro-context-bar:install|toggle`; installer flags `--renderer --dry-run --force`.

## agent-hud
https://github.com/meatcar/agent-hud — stars 1
1. Mixed. Fixed per segment in `src/fields.ts`: model id `colors.cyan`, effort `dim`, vim `N` green / `I` dim, worktree `[branch]` dim, clock icon dim + time `colors.yellow` (`powerline.ts` renderClockGroup). State/threshold in `src/powerline.ts`: context bar fill `ctxFillTone(pct)` = GREEN, YELLOW at `CTX_WARN_USED` 60, RED at `CTX_CRIT_USED` 80 (`constants.ts`); cache-miss % `missColor` green/yellow(20)/red(50) with leaf emoji 🌿/🍂/🔥; rate limits default tone LIGHTBLUE (5h) / BLUE (7d), overridden to YELLOW/RED by `limitFillTone` when burn ETA is under the reset time (RED when under half of it).
2. Themes: not present in code read. Scanner saw "catppuccin" (probably in docs/screenshot scripts), `unverified (README only)`. No theme file or role map in `src/`.
3. Plain ANSI 16 names via a vendored tinyrainbow (`src/colors.ts`: `black…white`, `gray`, `*Bright`, `bg*`, bold/dim/inverse). Depth: no detection; `NO_COLOR` and `--no-color` disable, `FORCE_COLOR`/`--color` force on, and colour defaults ON when piped (`isSupported()` in `colors.ts`).
4. Both: the context and rate-limit bars are background-filled cells (`Tone.bg` applied to label text, `bold(whiteBright)` text) with 1/8-block `EIGHTHS` partial cells; everything else is foreground-only.
5. Separators: none drawn; sections joined by a single space (`renderLayoutLine` in `fields.ts`). Bars use a `│` tick as marker (`MARKER_TICK`) for the 200k point on 1M models.
6. Neighbours: just spacing; bars are distinct by shape.
7. Text contrast: bar label text is fixed `bold whiteBright` on a coloured bg; empty track uses `colors.inverse` (terminal fg as bar bg) with `dim` fill (`GREY` Tone). No explicit light/dark logic; inverse follows the terminal.
8. Glyphs: Nerd Font icons `ICON_MISS` (󰌪), `ICON_CLOCK` (), emoji leaves 🌿🍂🔥🥀. Labels `5h`/`7d` are text. No ASCII fallback mode seen.
9. Other: bars lay out their percentage and ETA labels inside the bar cells (`label-layout.ts`, `layoutLabelsAround`); a leading-edge sub-bar shows cache-miss share; custom shell commands via `cmd:<id>` are "never colored" (README).
10. Config: TOML at `$AGENT_HUD_CONFIG` or `$XDG_CONFIG_HOME/agent-hud/config.toml` (`config.ts`): `[layout] lines = [[sections…]]`, sections `model, context, rate-limits, clock, vcs`, plus `[commands]`. CLI section args (`parseSectionArgs`). Env: `NO_COLOR`, `FORCE_COLOR`, `FORCE_TTY`. No per-colour config.

## agent-statusline (Memnoc)
https://github.com/Memnoc/agent-statusline — stars 1
1. Fixed per segment by palette role, plus state for two. `statusline-command.sh`: directory `C_FOAM`+bold, git branch `C_IRIS`, git flags `C_ROSE`, model `C_PINE`, cache bar `C_IRIS`, cost `C_GOLD`, `+N` lines `C_FOAM` / `-N` `C_ROSE`, durations and separators `C_MUTED`. State: context colour steps by `used_int` (<30 FOAM, <60 GOLD, <80 ROSE, else LOVE) with emoji 🧠💭🔥💀; rate limit (<40 FOAM, <70 GOLD, <90 ROSE, else LOVE) with ⚡🌡️⚠️🚫.
2. Themes: 9 bundled via `case "$THEME"`: `dawn` (default), `moon`, `main` (Rosé Pine variants), `catppuccin-latte`, `catppuccin-mocha`, `nord`, `gruvbox`, `tokyo-night`, `solarized`. Format: 7 semantic roles named after Rosé Pine (`C_FOAM, C_PINE, C_IRIS, C_MUTED, C_ROSE, C_LOVE, C_GOLD`) each mapped to a 256 index. User-defined themes: not present (only a `case` in the script; `THEME`/`SIZE`/`STYLE` set in `statusline.conf`).
3. ANSI 256 only (`\033[38;5;Nm`). No depth detection, no NO_COLOR.
4. Foreground only (comment in script: "None of them paint a background").
5. Separators: plain text from `STYLE`: `quiet` `·`, `plain`/`glyph` `|`, `labelled` none; separator coloured `C_MUTED`. Style `glyph` brackets the dir as `[ dir ]`.
6. Neighbours: different palette roles per segment type plus the muted separator. `labelled` style prints a second row of muted caps headers (DIR/GIT/MODEL/CONTEXT…) with columns padded to the wider of header/value.
7. Light/dark: `catppuccin-latte` and `dawn` act as light-ish palettes, chosen manually. No contrast calculation.
8. Glyphs: `ICON_MODE` emoji (plain) / text glyph (`⎇`, `⏱`→`↻`) (glyph) / none; bar glyphs `█░` or thin `▰▱`. No Nerd Font.
9. Other: width-responsive layout (`tput cols` ≥100 one line, ≥50 two lines); `SIZE` minimal/small/full; per-segment `SEG_*=off` toggles.
10. Config: shell-sourced `statusline.conf` (`THEME`, `SIZE`, `STYLE`, `SEG_*`) at `$XDG_CONFIG_HOME/agent-statusline/` or `~/.claude/`. No TUI.

## opendoor-statusline
https://github.com/MengFanLu1/opendoor-statusline — stars 1 (fork lineage: CCometixLine / ByeByeCode, per README)
1. Fixed per segment, per theme file. Each `src/ui/themes/theme_*.rs` defines one `SegmentConfig` per segment with `colors {icon, text, background}`. In `theme_powerline_dark.rs`: model bg rgb(45,45,45), directory bg rgb(139,69,19), git bg rgb(64,64,64), context_window bg rgb(55,…), all with white/grey text. Threshold exception: `opendoor_usage.rs` `get_status_color(pct)` = 256-colour 114 green / 179 yellow / 167 red (<50 / 50-80 / >80 per README).
2. Themes: 9 bundled (`presets.rs`): `cometix, default, minimal, gruvbox, nord, powerline-dark, powerline-light, powerline-rose-pine, powerline-tokyo-night`. Format: full per-segment colour map (not semantic roles). Users can save/load their own as TOML in `~/.claude/opendoor-statusline/themes/<name>.toml` (`save_theme`, `load_theme_from_file`, `list_available_themes`).
3. Three specs via `AnsiColor` enum: 16-index (`c16`, emits 30-37/90-97), 256 (`c256`), RGB. TUI colour picker has three modes (`ColorPickerMode::Basic16, Extended256, RgbInput`). No depth detection/downsampling; no NO_COLOR.
4. Both: themes with `background: Some(..)` give filled cells (`render_segment` wraps ` icon text ` in `48;…`); themes with `background: None` (nord’s usage segments, cometix) are foreground-only.
5. Separators: if `style.separator == "\u{e0b0}"` powerline arrows are drawn by `create_powerline_arrow`: arrow fg = previous segment's bg, arrow bg = next segment's bg (handles None on either side). Otherwise a white `\x1b[37m` separator string (e.g. `" | "`).
6. Neighbours: different background hue per segment in powerline themes; separators in the others.
7. Light/dark: `powerline-light` vs `powerline-dark` are separate hand-made themes. No automatic adaptation or contrast maths (`lightdark.words` hits are theme names).
8. Glyphs: `StyleMode` Plain (emoji) / NerdFont / Powerline; each segment holds `icon {plain, nerd_font}` (e.g. model "🤖" vs `\u{e26d}`).
9. Other: ratatui TUI configurator (`src/ui/components/theme_selector.rs`, `color_picker.rs`, `icon_selector.rs`, `segment_list.rs`) with live preview; auto line-wrap by terminal width (`calc_auto_break_positions`, COLUMNS/ioctl) at segment boundaries; progress bar `▓░` for balance.
10. Config: TOML `~/.claude/opendoor-statusline/config.toml` (`--init` writes it and patches settings.json), interactive TUI, theme TOML files.

## claude-metre
https://github.com/mgh12453/claude-metre — stars 1
1. By state/value on a gradient. Gauge cells are coloured by position along a gradient (`grad(pos, theme)` in `statusline.js`); other stats use `threshColor(v, good, warn)`: GREEN `rgb(86,196,129)` / AMBER `rgb(224,190,90)` / RED `rgb(240,74,68)` — cost (1/5 USD), context % (60/85), 5h/7d limits (60/85). Fixed: `+N` green, `-N` red, model/labels `DIM`, separators `GREY`. Speed readout and spinner use `accentOf(theme)` = the gradient's middle stop.
2. Themes: 4 bundled gradients in `THEMES`: `coral, ice, matrix, fire`, each a list of `[position, [r,g,b]]` stops. Format: gradient stops only (no roles). Custom themes: not present (config validates theme name against `THEMES`, falls back to coral).
3. Truecolor only (`\x1b[38;2;r;g;bm`), one `\x1b[90m` grey and `\x1b[2m` dim. No depth detection, no NO_COLOR.
4. Foreground only.
5. Separators: `   │   ` in GREY between gauge and stats; `·` between stats; gauge brackets `⟨ ⟩` / `▐…│▮`.
6. Neighbours: separators and dim vs. coloured values.
7. Light/dark: none.
8. Glyphs: braille spinner `⠋⠙⠹…`, `█ ▪ · ▰ ▱ ╹ ┿ ┈`. No Nerd Font; no emoji.
9. Other: animated needle (EMA-eased tokens/sec, "sweep" cell) driven by `refreshInterval` 1s; three gauge styles `bar|ruler|segmented`; four modes `full|speedo|minimal|stats`; a localhost web dashboard (`dashboard.js`) fed by snapshot JSON.
10. Config: JSON `~/.config/claude-metre/config.json` (mode, theme, gauge, redline, width, per-field toggles), managed by a `/metre` slash command; legacy env `METRICS_HUD_REDLINE/WIDTH`.

## cc-status
https://github.com/michaelChe956/cc-status — stars 1
1. By position (cycling) with state affecting text colour. `src/cc_status/render/powerline.py` `_create_segments`: background = `color_cycle[i % len]` of theme roles, default `["primary","info","success","warning","accent"]`; presets give per-line cycles (e.g. standard: line 1 `[primary, info]`, line 2 `[success, warning]`, line 3 `[accent, primary]`). Text colour: `text`, or `error`/`warning` role when the module status is ERROR/WARNING. Non-powerline TUI renderer (`terminal_renderer.py`) colours by status class (`statusline.success/warning/error/dim`) and fixed icon roles (mcp→primary, time→accent, git→warning).
2. Themes: bundled in `theme/builtins.py` and `themes/*.yaml`: `modern` (default), `minimal`, `cyberpunk`, `catppuccin`, `dracula`, `gruvbox`, `monokai`, `nord`. Format: semantic palette `colors {primary, success, warning, error, info, text, background, dim, accent}` + `icons` + `styles` + `fonts`. Users: YAML files in `./themes/` or `~/.claude/themes/` (`theme/loader.py` `_get_default_paths`, `_apply_defaults`).
3. Hex in themes; powerline output converts hex → 256 index via `_hex_to_ansi` (grey ramp 232-255 or 6x6x6 cube using `//51`), also accepts a 16 named-colour map. Always emits `48;5;N`/`38;5;N`. No depth detection; NO_COLOR: not present in files read.
4. Both: powerline mode is background cells (`\033[48;5;..m\033[38;5;..m text`); TUI toolbar renderer is fg on a themed background.
5. Separators: powerline set in `PowerlineRenderer.SEPARATORS`: arrow ``, round ``, slant ``, curve ``, thin variants, none. Colour: sep fg = current segment bg, sep bg = next segment bg (`render_line`). Non-powerline uses theme `separator` ` │ `.
6. Neighbours: cycling background hues from the cycle list.
7. Light/dark: none (themes are all dark-oriented; fixed `text` per theme).
8. Glyphs: heavy emoji icons per theme (`icons` map; minimal theme uses ASCII letters `M T G S` and `●×!`), Nerd/powerline separators.
9. Other: 3 layout presets minimal/standard/full (1/3/4 lines); live TUI with a theme toggle key (`toggle_theme` in `terminal_renderer.py`).
10. Config: YAML themes, Python CLI (`cc_status.cli`), installer that edits Claude settings; slash/CLI options for theme and style (arrow/round/slant/curve/none) in `PowerlineRenderer.__init__`.

## claudecodecli-minimax-usage
https://github.com/mikhailfur/claudecodecli-minimax-usage — stars 1
1. By state for bars; fixed otherwise. `usage.sh` `bar()`: fill colour by used%: ≥80 red, ≥50 yellow, else green; empty cells `C_DIM`. Time-to-reset `C_CYAN`, model name bold, header box `C_BOLD C_MAGENTA`. Statusline mode is `usage.sh --statusline` (README) with the same bar function.
2. Themes: not present.
3. ANSI 16 (`\033[31m/32m/33m/34m/35m/36m`, bold, dim). Colours switched off only when stdout is not a TTY (`[[ -t 1 ]]`); README lists `NO_COLOR=1` as an env to disable ANSI (`unverified (README only)`; I did not find it in the part of `usage.sh` I read).
4. Foreground only.
5. Separators: spaces / `·`; double-line box drawing for the slash-command header (`╔═…╗`).
6. Neighbours: not distinguished beyond dim labels.
7. Light/dark: none.
8. Glyphs: `▰▱` bar, box drawing, emoji (README colour key 🟢🟡🔴), `✗ ⚠ •`.
9. Other: mainly a `/usage-minimax` slash command and plugin; the statusline is a compact one-liner (`statusline` flag).
10. Config: env vars (`MINIMAX_API_BASE`, `CURL_TIMEOUT`, `NO_COLOR`), no config file.

## claude-quota
https://github.com/mmdemirbas/claude-quota — stars 1
1. By state/threshold, with a few fixed text roles. `src/render.ts`: context bar `ctxColor` (≥85 red, ≥70 yellow, else green); quota bars `quotaColor` (≥90 red, ≥75 bright magenta `[95m`, else bright blue `[94m`); money `moneyBarColor/moneyValueColor` (green at $0, yellow above, red ≥80% of limit); projection `projectedColor` (dim <80, yellow ≥80, red >100); pace arrow ↘ green / → dim / ↗ yellow-red. Fixed: model name `c(CYAN, modelText)`, project name YELLOW, `git:(` `)` MAGENTA with branch CYAN, labels dim, dashboard link bold bright cyan. The bar itself has layers: dim-fill up to pace, bright fill for over-pace, projected `░`, grey `38;5;250` for wasted quota.
2. Themes: not present.
3. ANSI 16 + one 256 colour (`BAR_WASTE` `38;5;250`), plus `dim` used as a "darker variant" (`darken()` = DIM+colour). No depth detection; NO_COLOR: not present in `render.ts`. README ships a light and dark screenshot.
4. Foreground only.
5. Separators: dim `│` (`SEP`) between fields; no per-neighbour colour.
6. Neighbours: dim vs. bright, field slots with fixed widths (padded columns) so fields don't shift.
7. Light/dark: none in code; README `prefers-color-scheme` swaps screenshots only.
8. Glyphs: `█░`, `│`, `⟳ ⚠ ● ○ ◔◑◕`, OSC 8 hyperlink to the dashboard (`hyperlink()` in `ansi.ts`). No Nerd Font.
9. Other: pace modelling (projected consumption shown inside the bar), an HTML dashboard (`src/dashboard.ts`), width tiers that drop git then fields (`render.ts` "Line-1 git degradation").
10. Config: via env/CLI of the `ctl` script and npm package; no colour config seen.

## claude-monitor-cli
https://github.com/Mohit-Singh2003/claude-monitor-cli — stars 1
1. Statusline: by state + fixed. `src/claude_monitor_tool/statusline.py`: gauge colour `_color_pct` (≥90 red, ≥70 yellow, else green) for context, 5h, 7d; model line `_CYAN` with `◆`; project, durations, cost `_DIM`. The same file's header says it mirrors a "Repo 2 pattern".
2. Themes: only for the Textual TUI (`tui/theme.py`), not the statusline. Contains a fixed "Claude-native" palette: brand violet `#A78BFA`, orange `#F59E0B`, semantic green/yellow/red/cyan, slate neutrals, `bar_color(pct)` (<50 green, 50-79 amber, 80-89 orange, ≥90 red) and `model_color` (opus violet / sonnet cyan / haiku green). Not user-switchable.
3. Statusline: ANSI 16 only (`\033[36m…`). TUI: hex. No depth detection; no NO_COLOR.
4. Foreground only (statusline).
5. Separators: plain `|` between fields.
6. Neighbours: not distinguished beyond dim text.
7. Light/dark: none.
8. Glyphs: `▰▱` 5-cell gauge, `◆`, `↑ ↓`.
9. Other: primarily a Textual dashboard; statusline is a secondary 2-line output that also fetches quota from an API client.
10. Config: none for colour; CLI subcommands.

## claude-statusline (moldabekov)
https://github.com/moldabekov/claude-statusline — stars 1
1. By state for percentages, fixed for text. `statusline.sh`: context bar and `5h`/`7d` use 3-way thresholds (≥80 red `[31m`, ≥60 yellow `[33m`, else green `[32m`); burn rate green/yellow/red at 3K and 10K tok/min; CI result ✓ green / ✗ red / ⋯ yellow. Fixed: `[user@host]` BLUE with user CYAN, directory YELLOW, branch CYAN, tmux/SSH segments CYAN; everything else uncoloured.
2. Themes: not present (the scanner's "catppuccin" hit is not a theme in `statusline.sh`; `statusline.ts` targets Pi, not Claude Code, and uses the Pi host's `success/warning/error` roles via `meterColor()`).
3. ANSI 16 only (`\033[31m` etc.). No depth detection, no NO_COLOR.
4. Foreground only.
5. Separators: literal ` | ` (uncoloured); `▸` after the host.
6. Neighbours: separators plus hue differences (blue/cyan/yellow identity row).
7. Light/dark: none.
8. Glyphs: monochrome Unicode icons plus a handful of emoji (`💻 ⚡ 🕐 🔥 🔋 ☁ 🐍`, `⎇ ⏳ ✦ ❄ ⇅`); "no Nerd Fonts required" (README).
9. Other: three adaptive lines, CI status via cached `gh run list`, burn-rate segment.
10. Config: none (edit the script); installer scans for `claude`/`pi`.

## claude-statusline (MyFitnessPal)
https://github.com/myfitnesspal/claude-statusline — stars 1
1. By state, with a "quiet" default. `statusline.sh` colour table: GREEN, YELLOW, ORANGE `38;5;208`, RED, COLD `38;5;33` (blue), NORMAL `38;5;245` (grey). Default segment colour is NORMAL (grey). Context total uses absolute token thresholds: green <120K, yellow 120-250K, orange ≥250K (or `exceeds_200k`), red ≥400K. Limits (5h/7d) NORMAL grey, YELLOW at ≥50, RED at ≥80 (the limit-window formatter, ~L232-241); per-model buckets grey / yellow ≥50 / red ≥80; 7d "pace meter" cells yellow→orange (≥3 cells)→red (≥6 cells), blue COLD for under-pace (opt-in `STATUSLINE_PACE_SHOW_COLD`).
2. Themes: not present.
3. ANSI 16 + a few 256 indices (208, 33, 245). No depth detection; no NO_COLOR. `COLD` is commented "legible on light and dark".
4. Foreground only.
5. Separators: plain ` | ` and ` · ` in grey.
6. Neighbours: grey text with colour only where a value is unhealthy.
7. Light/dark: colour choices are deliberately picked to be legible on both (comment on `COLD`); no detection.
8. Glyphs: `█░` bars; no emoji/Nerd Font.
9. Other: pace meter and overflow `▶` marker fused to the context bar; env knobs `STATUSLINE_CTX_BAR_WIDTH`, `STATUSLINE_PACE_BAR_WIDTH`, `STATUSLINE_PACE_TOL`, `STATUSLINE_PACE_GAMMA`; round-cost tracking via a UserPromptSubmit hook.
10. Config: environment variables only (listed above); `install.sh`, `demo.sh`.

## claude-codex-usage
https://github.com/n-hiraha/claude-codex-usage — stars 1
not a Claude statusline: tmux status-bar usage gauge and pane monitor for Claude/Codex/Gemini accounts. Its colour logic, for reference: `internal/usage/display.go` emits tmux `#[fg=#RRGGBB]…#[default]` per account, remaining ≤20% red `#b91c1c`, ≤50% yellow `#a16207`, else green `#166534`; an account takes the colour of its scarcest window; gauge glyphs `━`/`·` with the percentage also spelled in text ("色だけに頼らず" — not relying on colour alone). Pane borders highlighted through a `@ccu_waiting` tmux option.

## neon-haze
https://github.com/NakajiZaiLFC/neon-haze — stars 1
1. Fixed per segment role via theme variables, plus 3-way state for bars. `neonhaze.sh` ~L596-612: roles `T_FRAME` (box borders), `T_PROJECT`, `T_BRANCH`, `T_BADGE`, `T_DIRTY`, `T_SENSEI`, `T_COST`, `T_MODEL`, `T_LABEL`, `T_PERCENT`, plus weather, pomodoro and temp roles. `_color_for_val` picks `T_BAR_BAD` ≥80, `T_BAR_MID` ≥50, else `T_BAR_GOOD`, each with a `_DIM` partner for the empty track.
2. Themes: README says 5 built in (neon, cyberpunk, gits, eva, akira); repo has 9 files under `themes/` (`akira, bladerunner, cyberpunk, eden, eva, gits, hitchhiker, neon, tachikoma`). Format: a shell file of ~40 `T_*` role variables holding `\033[38;5;Nm` strings. Users add `~/.claude/themes/mytheme.sh` (README "Creating Themes"). Switched by `/theme <name>`, stored in `~/.claude/state/current-theme`.
3. ANSI 256 index only (`\033[38;5;N`). No depth detection; no NO_COLOR. Defaults fall back to 256 indices if a role is unset (`${T_FRAME:-…}`).
4. Foreground only.
5. Separators: double-line box drawing (`╔═╗ ║ ╚╝`) frames in `T_FRAME` colour around each panel; no powerline.
6. Neighbours: separate framed boxes side by side, each role its own hue.
7. Light/dark: none (all themes are dark neon).
8. Glyphs: box drawing, emoji (weather, pomodoro), `█▒░` bars. No Nerd Font.
9. Other: multi-panel HUD (project, quotas, weather panel, pomodoro timer), `refreshInterval: 1`, themed bar colours; an iTerm2 status-bar widget (`widgets/path3-statusbar/crest_statusbar.py`) and pixel-art emblem tools; a demo GIF and theme comparison scripts (`scripts/demo-themes.sh`, `theme-compare.sh`).
10. Config: theme shell files, `/theme` slash command, env vars `CLAUDE_WEATHER_LAT/LON`.

## NeonCoat
https://github.com/NateCC0902/NeonCoat — stars 1
Mostly mods, with one statusline file. The mods (reply-media, reply-markdown, shell-tail, test-summary, turn-changes, skill-router) are not statuslines. Statusline = `statusline.mjs`:
1. By state + fixed. `paint(text, color)` over a `COLORS` table (copied from the user's `~/.claude/themes/charm.json`): text `236;235;240`, dim `162;160;173`, green `0;255;178`, yellow `245;239;52`, red `255;87;125`, pink `255;96;255`, purple `139;117;255`, teal `16;177;174`, cyan `0;164;255`. Context bar: tone red ≥90, yellow ≥70, else green. Rate-limit percentages (5h/week) same thresholds. Fixed: cost pink bold, model purple bold (+effort purple), folder teal, cache % cyan bold, git branch yellow with `±N` red or `clean` dim, remote control `◉ rc` green / `○ rc` dim, other sessions waiting yellow `◆`, busy yellow `●`, idle dim `○`.
2. Themes: none in the statusline; the palette is a single hard-coded copy of one external theme ("ponytail" comment says to read the file instead if it starts changing). Mods have a Claude Code theme dependency but not read here.
3. Truecolor only (`\x1b[38;2;r;g;bm`, `1;` for bold). No detection, no NO_COLOR.
4. Foreground only.
5. Separators: dim ` │ ` (`gap`) between segments.
6. Neighbours: one hue per segment role plus dim separators.
7. Light/dark: none.
8. Glyphs: `━`/`─` bar, `⎇ ⚠ ◉ ○ ◆ ●`.
9. Other: two rows (status then usage windows + other sessions); estimated tokens/second kept in a temp tally.
10. Config: none (edit file); `statusline.mjs` is wired in settings.json.

## bdigital-public (cc-context-monitor plugin)
https://github.com/neurot1cal/bdigital-public — stars 1
Only `plugins/cc-context-monitor/statusline.sh` is a statusline (the rest of the repo is skills, a PR-review renderer and a website).
1. Fixed per segment + state. Fixed: cwd CYAN, branch (+`*` dirty) MAGENTA, worktree `38;5;208` orange, agent CYAN, output style DIM, model uncoloured. State: `band_color` on ctx %, 5h and 7d each with their own dot bar: green ≤49, yellow ≤74, red above (env `CC_CTX_GREEN_MAX`, `CC_CTX_YELLOW_MAX`).
2. Themes: not present.
3. ANSI 16 + one 256 index (208). No depth detection, no NO_COLOR.
4. Foreground only.
5. Separators: plain ` | `, uncoloured.
6. Neighbours: separators; different hues per segment type.
7. Light/dark: none.
8. Glyphs: `●`/`○` dot bar (width `CC_CTX_BAR_WIDTH`, default 10), `↻` reset suffix.
9. Other: appends `CC_STATUSLINE_ANNOTATION` for composing with another tool; falls back to `ccusage` for percentage on old Claude Code builds.
10. Config: environment variables only (`CC_CTX_*`).

## claude-statusbar (Nishant-Rajj)
https://github.com/Nishant-Rajj/claude-statusbar — stars 1
1. By state + fixed per metric type. `src/claude_statusbar/themes.py` `Theme` dataclass: severity colours `s_ok/s_warn/s_hot` (chosen by `_severity_color(theme, pct, warn, crit)`, defaults 30/70 in `render_capsule`; context/5h/7d use `window_severity_rgb`, which also consults the projection), and a distinct capsule fill per metric type: `pill_5h`, `pill_7d`, `pill_model`, `pill_lang`, `pill_cost` (so 5H, 7D, model, language, cost pills are always the same hue family); text roles `ink` (primary), `mute`, `edge`, `pill_ink`. Cache countdown colours: COLD red, `<1m` yellow, else green (`_cache_severity`). Effort word coloured by tier, plus a static per-effort gradient across the whole mode line (`_EFFORT_GRADIENTS`, grey→blue→purple ladder).
2. Themes: 9 bundled `graphite` (default), `twilight`, `linen` (light), `nord`, `dracula`, `sakura` (light), `mono`, `catppuccin-mocha`, `tokyo-night` (`docs/styles-and-themes.md`). Format: frozen `Theme` with RGB triples for the 12 roles above. Independent of 3 styles (`classic`, `capsule`, `hairline`) = 27 combos. Not user-definable beyond overriding `s_ok/s_warn/s_hot` with hex (`apply_color_overrides`, config `color_ok/color_warn/color_hot`).
3. Truecolor only (`\033[38;2;…` / `48;2;…` in `styles.py`, `progress.py`). No downsampling. NO_COLOR honoured (`cli.py`: `"NO_COLOR" in os.environ` or `--no-color`; any value).
4. Both: `capsule` style = background-filled pills (`pill(bg_rgb, body)`), `classic` and `hairline` are foreground-only. Bars: fill is a same-hue gradient fading toward black by `_FILL_FADE` 0.35; empty cells sparkle with static `⋆` stars (`progress.py`).
5. Separators: capsule `╱` in `edge` colour with a space (`spacer`); hairline dashed `┊`; classic `|`. No powerline arrows; pills have no rounded caps.
6. Neighbours: capsule pills have a different fill per metric (5h/7d/model/lang/cost), all kept low-contrast from each other, plus the `╱`; severity dot `●` at the right of each pill.
7. Light/dark: user picks `linen`/`sakura` (light themes where `pill_ink` is dark and pill bgs are pale). No detection. Density setting `compact|regular|cozy` controls padding.
8. Glyphs: `⛁ CTX ◷ 5H ☷ 7D ◆ 📚`, `●` severity dot, `▁▃▆█` mini bar (hairline), `✦ ✧ ⋆` sparkle. Emoji used; no Nerd Font.
9. Other: animation/sparkle in progress bars (`motion.animation=24` signals), forecast chips (`⚠<eta>`), `cs preview` renders every style × theme, `/statusbar-theme` slash commands. The scanner's rainbow/animation signals: `unverified` beyond the sparkle code in `progress.py`.
10. Config: JSON/CLI (`cs config set theme twilight`), precedence flag > env (`CLAUDE_STATUSBAR_STYLE`…) > file; `cs themes`, `cs styles`, `cs preview`, `--no-color`.

## unspin
https://github.com/nkyriazis/unspin — stars 1
not a Claude statusline: shows live step progress for batched shell commands in a block above the prompt and in Claude Code's spinner verbs; it can also render under the status line (`skills/unspin/lib/render.awk`). Colour for reference: `render.awk` L36-37 only four SGRs (`[32m` green done, `[31m` red failed, `[33m` yellow running, `[2m` dim); `color=0` input switches colour off; `ascii=1` replaces glyphs. Foreground only.

## agentline
https://github.com/OFCode-dev/agentline — stars 1
1. Fixed per segment role + state. README tables: model name coloured by family (Fable/Mythos truecolor amber→orange gradient with ✦, Opus lavender→rose gradient, Sonnet cyan, Haiku green); effort tier colour 🟢low dim, 🟡med cyan, 🟠high orange, 🔴xhigh red, ultracode bold white on violet gradient, max animated rainbow (`_RAINBOW_WHEEL`, `agentline.sh` L198-280); context green <60, yellow ≥60, red ≥80; 5h/7d green <70, yellow ≥70, red ≥90 with pace arrows `⇡⇣`; cwd blue, branch magenta (+ dim owner/repo), clock cyan, version dim, cost green/red for lines; each live agent in its worker colour (codex `#A970FF`, gemini `#4285F4`, nvidia `#76B900`, hetzner `#D50C2D`, claude `#D97757`, …, README "agent colours").
2. Themes: 3 values of `AGENTLINE_THEME` = `dark` (default), `light`, `mono`. They swap only the fixed RGB values (gradients, gold/orange accents, rainbow); most colours are ANSI 16 roles the terminal maps itself (README "Themes, glyphs and colours"). Per-colour overrides `AGENTLINE_COLOR_GOLD/ORANGE/FABLE_FROM/FABLE_TO/OPUS_FROM/OPUS_TO` as `r,g,b`.
3. Mixed: ANSI 16, a few 256 (220/208 gold/orange), truecolor for gradients. No `COLORTERM` detection (no hit in `agentline.sh`). NO_COLOR honoured: any non-empty value selects `mono` (strips all colour including from `local.sh`). `COLORFGBG` is only consulted by `install.sh` to suggest `--theme light`, never at render time.
4. Foreground only, except `ultracode` effort pill (white on violet gradient, a background).
5. Separators: dim `│` between segments; `·` inside segments; no caps or powerline.
6. Neighbours: separators and per-role hues; line 2 uses a different hue for each of version/cwd/branch/clock.
7. Light/dark: explicit `light` theme darkens fixed colours to 4-7:1 contrast on white (the dark amber is about 1.4:1 there); no auto-detect (README says why). Worker-colour table has separate Dark and Light columns, light ones ≥4.5:1.
8. Glyphs: emoji default, `AGENTLINE_GLYPHS=ascii` turns every icon into short words and `│`→`|`. No Nerd Font.
9. Other: animated `max` rainbow (`_anim_frame`), subagent panel rows (`agentline-subagents.sh`), clickable OSC 8 links, adaptive 2-4 lines and `AGENTLINE_LAYOUT` to order segments, `local.sh` hook for custom segments with `agentline_seg`.
10. Config: env vars in settings.json `env` block, `install.sh --theme --glyphs`, layout string `AGENTLINE_LAYOUT`, `local.sh`.

## claude-statusblocks
https://github.com/okanerturan/claude-statusblocks — stars 1
1. Mostly fixed per segment + threshold. `src/colors.ts` `pctColor` (≥90 red, ≥70 yellow, else green) drives the context and usage bars. Fixed: model name `c.orange` bold (`rgb(217,119,87)`, Claude brand orange) in `segments/model.ts`; directory/duration/version `dim`; effort colour map `EFFORT_COLORS` (low/medium dim, high yellow, xhigh orange, max orange+bold); git branch `c.cyan`, staged green, modified yellow, clean dim, `+N` green `-N` red; promo `2×` off-peak green / peak `rgb(200,100,80)`; model-scope usage labels orange bold.
2. Themes: not present.
3. ANSI 16 + one truecolor orange (and peak colour). No depth detection; no NO_COLOR.
4. Foreground only.
5. Separators: dim ` · ` inside cards; segments are separate bordered boxes `╭─╮ │ ╰─╯` in gray (`boxify` in `layout.ts`) packed side by side.
6. Neighbours: each segment is its own rounded box with a dim title; cards are set apart by border and gap.
7. Light/dark: none.
8. Glyphs: rounded box drawing, `█▒` bars, `↻`. No Nerd Font, no emoji.
9. Other: bin-packing layout optimiser that assigns blocks to rows to minimise row count then widest row (`findOptimalAssignment`), pyramid row order; margin for Claude Code's notification panel.
10. Config: `~/.claude-statusblocks.json` (`segments` order, `remoteUsage`) or env `CLAUDE_STATUSBLOCKS_SEGMENTS`.

## surplus
https://github.com/oleg-koval/surplus — stars 1
not a Claude statusline: a CLI that watches Claude Code / Codex usage windows and routes the next session to a premium model when the weekly allowance would otherwise go unused (`src/core/notice.ts` builds plain-text session-start notices). No statusline styling found.

## claude-status-line (opezero)
https://github.com/opezero/claude-status-line — stars 1
1. Colour = danger only, hierarchy by lightness. `internal/statusline/theme.go` header comment: "色は『危険度』だけを表し、階層は明度（bold › 通常 › dim）で表現する" (colour means danger level only; hierarchy is bold > normal > dim). Roles `l1` label (systemGray6), `l2` secondary, `l3` tertiary, `track`, `ok`, `warn`, `bad`. `render.go`: model bold `l1`, project `l1`, labels/units/percent sign `l3`, branch `ok` when clean / `warn` + `*` when dirty, `+N` ok, `-N` bad. Percentages use a continuous gradient `grad(p)`: green→yellow→orange→red (<50 interpolates green→yellow-orange, 50-80 orange→yellow, ≥80 →red); bold only past `CTX_WARN` 90 / `RL_WARN` 85 (`emphasis`). Pace warning `!2.9x` in `bad`.
2. Themes: none selectable. One theme struct with Apple system colours; truecolor and 16-colour variants.
3. Truecolor when `COLORTERM` is `truecolor`/`24bit` (`newTheme`), else ANSI 16 (97/37/90, 32/33/31); the gradient collapses to 3 steps (<50 green, <80 yellow, else red). `NO_COLOR` non-empty → no escapes at all (`noColor: true`).
4. Foreground only; bar track is a `─` line in a dark grey, not a background.
5. Separators: plain spaces / two-space gaps. Bars `█▉▊…` use 1/8 blocks.
6. Neighbours: not separated by colour; lightness steps (bold / normal / dim) mark label vs value vs unit.
7. Light/dark: none (greys tuned for dark). No detection.
8. Glyphs: Nerd Font icons (`USE_ICONS`), `0` disables; Unicode eighth-blocks for bars; East Asian width aware.
9. Other: Go and shell implementations proven identical by `scripts/compare.sh` (31 cases); pace-based `!N.Nx` warning appears only when you run out before reset.
10. Config: env vars `CTX_BAR_CELLS`, `RL_BAR_CELLS`, `CTX_WARN`, `RL_WARN`, `PROJ_MAXLEN`, `USE_ICONS`; shell version edits the script header.

## ccreport
https://github.com/oroddlokken/ccreport — stars 1
Statusline is `src/ccreport/statusline.py` (plus a CLI report; `palette.js` is for the web dashboard).
1. By state + fixed hue per segment type; default is quiet grey. `SUBDUED` = `38;5;242` for structural info (session id, `+Nsess`). Fixed: directory blue `0;34`, hostname green `0;32`, git branch yellow `0;33` with per-flag colours inside `[…]` (`=` red, `⇡` green, `⇣` red, `$` magenta, `+` green, `»` yellow, `✘` red, `!` red, `?` white), DSP marker `38;5;208`, update notice yellow. State: context `:NN%` default grey `90`, yellow `33` ≥50, red `31` ≥70 (green `32` only if `CTX_GREEN`); usage `_usage_color`: grey, yellow ≥65, red ≥85; battery red/yellow when low and discharging.
2. Themes: not present. Opt-in whole-line recolour: `CLAUDE_STATUSLINE_RED` / `HAIKU_RED` strips existing colours and paints everything bold bright red (`_force_red`), except the model badge.
3. ANSI 16 + 256 (242, 208, 196, 93, 28 as bg). No depth detection; NO_COLOR: not present in the file.
4. Both: optional `MODEL_BANNER` is a background badge `\033[1;97;{bg}m` — Haiku `48;5;196` or magenta `45`, Sonnet blue `44`, Opus deep purple `48;5;93`, Fable green `48;5;28`, other bright-black `100`. Everything else foreground.
5. Separators: a dim dot (`dot` passed to `_append_custom_msgs`), no caps.
6. Neighbours: grey structure vs coloured meaning; per-model badge colour distinguishes the model cell.
7. Light/dark: none; defaults to grey `90`/`242`.
8. Glyphs: mostly text; `↑` update notice.
9. Other: per-model colour (`_model_banner`), line-level custom messages with named colours (`CLAUDE_STATUSLINE_LINE<n>_COLOR`, `_MSG_COLORS`: red/green/yellow/blue/magenta/cyan/white/grey/orange), layout 2 or 4 lines by `$COLUMNS` (≥150).
10. Config: env vars `CLAUDE_STATUSLINE_*` toggles (documented in the module docstring and `bin/statusline-command_x.sh`).

## space-statusline
https://github.com/Oscaraag/Space-Statusline — stars 1
1. Fixed per segment role; state for the context bar only. `runtime/statusline.sh` (L222-270): dir glyph `PUR` (accent) with the directory name drawn as the theme gradient (`grad "$NAME"`), branch `MAG`, new files `AMB`, modified `CYAN`, ahead `GRN`, behind `AMB`, model `PUR`+bold, "CTX" label `DIM`, cost `GRN`, tokens `DIM`, clock `CYAN`. Context % colour: `GRN` under `T_WARN`, `CTXW` ≥ warn, `CTXD` ≥ danger (config thresholds). A horizon rule line is drawn as a gradient with fade at the ends; the context bar is gradient-filled half-block cells.
2. Themes: 4 presets in `src/themes.ts`: `outrun-horizon` (default), `sunset`, `vaporwave`, `mono`, plus `custom` from the wizard. Format: `gradient {start,end}` hex + 8-slot semantic palette `accent, magenta, cyan, green, amber, dim, ctxWarn, ctxDanger`. Custom gradient/palette via the wizard or JSON.
3. Truecolor default; if `COLORTERM` is set to something other than `truecolor`/`24bit` it degrades to the xterm 256 colour cube (`fg()`/`mkfg()` ~L113-135, 6x6x6 mapping). NO_COLOR: not present.
4. Foreground only.
5. Separators: configurable text separator (default shown between sections `SEP="  ${DIM}${SEPARATOR}${RESET}  "`), in the dim colour; horizon rule is a full-width gradient line.
6. Neighbours: different palette role for each segment type (accent, magenta, cyan, green, amber).
7. Light/dark: none; the README recommends a bundled dark Windows Terminal scheme ("Outrun Horizon").
8. Glyphs: Nerd Font by default; `glyphs.mode: unicode` falls back (config); `doctor` command checks Nerd Font and truecolor.
9. Other: gradient text and rules per cell, half-block context bar, CLI wizard with preview.
10. Config: zod-validated JSON `~/.config/space-statusline/config.json` (`$SPACE_STATUSLINE_CONFIG`), wizard (`init`, `config`), `theme <name>`, `preview`, `doctor`; bash runtime reads the JSON on every render.

## powerline-studio
https://github.com/Owloops/powerline-studio — stars 1
not a Claude statusline itself: a Vue web editor for claude-powerline configs that runs claude-powerline's real renderer in the browser. Styling facts it exposes about claude-powerline: theme = per-segment `{bg, fg, bold}` for 19 segment keys (`SEGMENT_LABELS` in `src/lib/themes.ts`: directory, git, model, session, block, today, month, tmux, context, contextWarning, contextCritical, metrics, version, env, weekly, agent, thinking, cacheTimer, outputStyle); 6 built-in themes (`dark, light, nord, tokyo-night, rose-pine, gruvbox`) plus a custom theme editor with per-segment colour pickers and per-part `fg` overrides; styles `minimal`, `powerline`, `capsule`, `tui` (`useRenderer.ts` L116-125: capsule uses rounded caps `left_rounded/right_rounded`, minimal no separator); colour modes `truecolor | ansi256 | ansi | none` (`resolveThemeColors` converts hex with `hexToAnsi/hexTo256Ansi/hexToBasicAnsi`, `none` emits nothing and no bold); separator arrow fg = segment bg (`extractBgToFg`); in TUI style, if fg is within colour distance 60 of the terminal background (`hexColorDistance`) the fg is swapped for the segment bg; preview terminal backgrounds from 10 named terminal themes, 7 dark and 3 light (`terminalThemes.ts`); bar styles `text, ball, bar, blocks, blocks-line, capped, dots, filled, geometric, line, squares`. Also: mock-data presets, import/export JSON, localStorage persistence.

## oyvjul claude-statusline
https://github.com/oyvjul/claude-statusline — stars 1
1. Fixed per segment, one blue family; state changes bar shade only. `src/utils/theme.ts`: model `C_MODEL` rgb(100,180,255), context `C_CTX` (140,210,245), repo `C_REPO` (80,155,225), directory `C_DIR` (100,120,155), pipe `C_PIPE` (60,75,100), `current` label (70,185,225), `weekly` (120,160,210), Fable-limit label `C_FABLE` (220,150,95) as the only warm accent, percent `C_PCT`, reset time `C_RESET_TIME`. Bars (`src/render.ts` `getThresholdColor`): a four-step blue ramp by pct (<50 `35,85,155`, ≥50 `45,115,195`, ≥75 `60,145,230`, ≥90 `90,170,255`) — brighter with load, not red/green. A "COMMIT" gradient label above uses `COMMIT_GRADIENT` (6 blue stops).
2. Themes: not present; README "Customization": edit RGB constants in `theme.ts`.
3. Truecolor only (`ansi()`/`ansiBg()` in `utils/ansi.ts`), plus `48;5;234` for the empty track. No detection; no NO_COLOR.
4. Both: bar fill is background cells (`BG_FILL + " "`), empty `░` on bg `28,28,28`; labels/text are foreground. Badges (`renderBadge`) are bold fg on bg with padding.
5. Separators: dim blue-grey `|` between fields (`PIPE`). No caps.
6. Neighbours: slightly different blue tints per field and the pipe.
7. Light/dark: none (dark only).
8. Glyphs: `▏▎▍▌▋▊▉` eighth-blocks; `✍️` emoji beside context. No Nerd Font.
9. Other: bar with centred text overlay ("COMMIT" label drawn inside the bar cells, `renderCommitBar`), gradient label, rate limits fetched from Anthropic OAuth API and cached 3 min.
10. Config: edit TypeScript constants; `npm run configure` writes `statusLine` to settings.json.

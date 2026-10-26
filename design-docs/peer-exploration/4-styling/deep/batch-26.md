## sdadz-luo/ccstatusline-zh-deepseek
https://github.com/sdadz-luo/ccstatusline-zh-deepseek (stars 1). FORK OF huangguang1999/ccstatusline-zh (itself a Chinese-translation fork of sirmalloc/ccstatusline); the baseline is its v2.2.29. Only the differences in styling are reported.
- The whole powerline engine, themes (catppuccin, dracula, gruvbox, monokai, nord, one-dark, solarized, tokyo-night), colour menu, gradient and colour-depth code are inherited unchanged (README "与上游的差异" says the settings.json is shared and 80+ widgets are identical). Nothing in `src/utils/colors.ts` or `powerline*.ts` was changed by the fork (the fork's 10-item change table, README "本 Fork 的改动", lists no styling item except the one below).
- 1. Only styling difference, by state: `src/widgets/SessionCost.ts:74` `getDefaultColor(): string { return isDeepSeekPeakHour(new Date()) ? 'red' : 'green'; }`. Peak is Beijing time (UTC+8) Mon-Fri 09-12 and 14-18, computed by fixed offset (`src/utils/deepseek-pricing.ts`). Red in peak hours, green otherwise. This is a time-of-day-driven default colour on the cost widget. The README notes it applies in peak hours globally, not only for DeepSeek models.
- `src/widgets/MonthlyUsage.ts:36` new widget, `getDefaultColor()` returns fixed `'brightBlue'`.
- 2-10 otherwise: identical to the parent (user can still override each widget's colour in the TUI colour menu; the default is only used when no override). UI strings translated to Chinese. Nothing else styling-related differs.

## seanlee111/claude-code-monitor
https://github.com/seanlee111/claude-code-monitor (stars 1). Python statusline plus a separate web dashboard (`dashboard.py`) and terminal TUI (`tui.py`).
1. Two fixed colours for the whole statusline (`statusline.sh` top of the embedded python): `B='\033[38;2;59;130;246m'` (#3b82f6 blue) for every value, bar fill and the model tag, and `D='\033[38;2;100;100;120m'` gray-blue for every label and the separator. No per-segment colour, no thresholds: the Limit and Context bars (`bar()`) are blue at 5% and at 95%. The model tag (Opus/Sonnet/Haiku) is the same blue.
2. Themes: not present in the statusline. The dashboard (`dashboard.py:300-312`) has a fixed dark CSS-variable palette (bg #0f1117, accent #7c6aef, green/orange/red/blue/cyan); no switching. Per-model badges `.model-opus/.model-sonnet/.model-haiku` (`dashboard.py:419-421`) are fixed red/violet/cyan tints.
3. truecolor (`38;2;r;g;b`) only in `statusline.sh`; no depth detection, no NO_COLOR. `tui.py:25-45` uses ANSI 16 names (BBLUE, GRAY, ...).
4. Foreground-only, no background fills.
5. Separator: plain ` │ ` (U+2502) in the gray-blue `D`; header glyph `◇`.
6. Neighbours: distinguished by the label/value contrast (gray label then blue value), blank spacer lines (`print('')`) between four lines (header, Limit, Context, Models).
7. No light/dark adaptation or contrast logic (a gray #646478 label would be dim on a light terminal).
8. Unicode only: `█` filled, `░` empty bars, `◇`, box chars; no Nerd Font, no emoji, no ASCII fallback. (README sample shows half-height blocks `▄▁`, but the code uses `█`/`░`.)
9. Four-line layout with a model-distribution bar line (per-model token share); 60 s cache. No animation in the statusline (`tui.py` has a refresh loop).
10. Customisation: edit the script; no config, no flags. Install = copy `statusline.sh`.

## securacore/kanagawa-statusline
https://github.com/securacore/kanagawa-statusline (stars 1). Single bash script `statusline.sh` (also `bin/kanagawa-statusline` installer/updater), powerline, lualine-inspired.
1. Fixed per segment slot, with colours taken from one variant palette (`statusline.sh` `apply_palette`, ~lines 404-590): `CTX_BG` context % (violet), `A_BG` model (+ effort) (crystal blue), `B_BG` cwd basename (+ git counts `+!?`) (wave blue), `C_BG` branch (sumi ink 5), `D_BG/D_FG` logos plan anchor, then right cluster: language versions (node/bun/py/go/rust/zig/odin) on a dark-to-light gray gradient (`GRAD_MIN..GRAD_MAX`, N visible langs get N evenly spaced 256-colour indices), `Z_BG` cli version (muted orange), `X_BG` caveman badge (bright orange), `Y_BG` output style (boatYellow), `U_BG` update (samurai red). Context % segment is NOT threshold-coloured (the percentage text only; line 806: `add_left "$CTX_BG" "$CTX_FG" "$ctx_text"`).
2. Themes: 3 base variants `wave` (default night), `dragon`, `lotus` (light), each with `-lean` (muted monochrome ramp, powerline kept) and `-xlean` (text only, no backgrounds, ` │ ` divider) = 9, plus `off` (comment block lines 352-366). The format is per-slot variables in the script (`FUJI_WHITE`, `CTX_BG/CTX_FG`, `A_BG/A_FG` ... ) as ANSI-256 indices ("hex values mapped to nearest ANSI 256"). Selected with `KANAGAWA_VARIANT` env or `VARIANT` in `$XDG_CONFIG_HOME/kanagawa-statusline/config`. Users can edit the constants but there is no user-theme file format.
3. ANSI 256 only (`38;5;N` / `48;5;N`, lines 599-611); README says truecolor optional but the code emits 256 indices. No NO_COLOR; no depth detection.
4. Both: powerline mode = bg fills + arrows (`seg()` line 607); `*-xlean` = foreground only (`seg()` line 599, bg arg ignored).
5. Separators: Nerd Font powerline arrows `LSEP`/`RSEP` (lines 592-593; left cluster and right cluster use opposite-pointing glyphs); `ltrans/rtrans` set arrow fg = previous segment bg and bg = next segment bg; left cap uses `first_bg`. In text mode a ` │` divider in `DIV_FG`.
6. Neighbours: different hue per slot in the violet -> blue -> dark-blue -> sumi-ink -> orange progression plus arrow separators; the language run uses lightness steps (even gray gradient).
7. Light/dark: `lotus` variants are light themes with dark text (`SUMI_FG=234`), chosen explicitly by the user (no detection). Every segment has hand-paired fg/bg (e.g. `A_FG=$SUMI_FG` on light blue); no computed contrast.
8. Nerd Font required (powerline glyphs, `󱐋` effort, `󰍛` ctx size); a few emoji-free glyphs (`◈ ◇ ◌` logos mode). No ASCII mode other than `xlean` text mode (still uses `│`).
9. Dynamic gray gradient across detected languages, graceful degradation dropping low-priority segments by width, right-edge alignment via `stty`. `KANAGAWA_COLS` forces width. `STATUSLINE_DEMO=1` previews all 7 languages.
10. Customisation: env vars (`KANAGAWA_VARIANT`, `KANAGAWA_LOGOS`, `KANAGAWA_LOGOS_TTL`, `KANAGAWA_COLS`, `KANAGAWA_NO_UPDATE_CHECK`, `STATUSLINE_DEMO`), a small shell-format config file, edit constants; `kanagawa-statusline update` self-updates.

## seetheworldwithme/glm-status-line
https://github.com/seetheworldwithme/glm-status-line (stars 1). Node CLI for GLM (Zhipu) coding-plan quota in the statusline.
1. By state/tone, never by segment: `src/core/status/format.js` builds `{text, tone}` segments: labels `label` tone, prefixes `muted`, bar fill and the number in the quota's severity tone (`good`/`warn`/`danger`/`neutral`), empty bar `barEmpty`, reset time `reset`. Severity (`src/core/status/viewModel.js:53-67`): quota left >= 60% good, >= `LOW_QUOTA_THRESHOLD` warn, below danger; MCP usage 80/90 (`src/shared/constants.js:88-90`); a pace-based version for secondary quotas (pace > 1.3 danger).
2. 3 bundled themes `dark`, `light`, `mono` as `THEMES` in `src/core/status/theme.js`: a tone -> ANSI-code-list map with roles `label, reset, muted, shade_good, shade_warn, shade_danger, barEmpty, multiplier, good, warn, danger, neutral`. Selected with `--theme dark|light|mono` or `glm-status-line config set theme light`; no user-defined themes (`normalizeTheme` falls back to dark for anything else, `constants.js:134`).
3. Mixed: truecolor for accents/good/warn/danger (`src/shared/ansi.js`: darkAccent `38;2;119;209;208`, lightAccent `38;2;34;95;120`, "green" is really `38;2;70;148;175` a teal-blue, "yellow" `38;2;255;130;0` orange, red `38;2;220;53;19`), plain ANSI 16 for gray(90)/white/black/blue/cyan. No depth detection, no NO_COLOR (mono theme is the manual substitute: bold/underline/dim only).
4. Foreground-only.
5. Separators: plain text ` | ` in the muted tone (format.js:193-199).
6. Neighbours: tone differences (muted label then toned value); no separators colour logic.
7. Light/dark: manual `light` theme swaps accent to a dark teal and `neutral` to black (theme.js:22-24); no detection.
8. Unicode bars `█`/`░` (`src/shared/bar.js`; glyphs configurable via `characters`); no emoji, no Nerd Font. Three layouts `--style text|compact|bar`.
9. `shade_*` tones give a partial-cell shade tone to the bar's last cell. TUI config screen (`src/tui`) with its own colour palette, `mono` palette for it too (`ansi.js:getTuiColors`).
10. Customisation: `config set <key> <value>` CLI, JSON config file, flags `--style --display --theme --minimalist --raw-values --reset-format`; interactive TUI.

## SeoJaeWan/try-claude-code
https://github.com/SeoJaeWan/try-claude-code (stars 1). Personal workbench repo; the statusline is a legacy plugin at `legacy/old/claude-code/plugin/statusline/` (the rest, Figma JSON, planning docs, is unrelated; `variables-theme.json` is a Figma design-token export, not statusline styling).
1. By threshold plus fixed: `src/lib/format.mjs` `colorPct(pct)`: >=80 red, >=60 yellow, >=30 cyan, else green; used for the 5h and 7d rate limits and the `CTX:` context percentage (`src/status-line.mjs` renderInline, ~lines 236-263). Cache hit rate: >=90 green, >=50 yellow, else red (`status-line.mjs:275`). Permission-mode badge by state: plan cyan, auto yellow, acceptEdits yellow ("auto"), bypassPermissions red ("bypass"), default gray. Fixed: model id white, labels (`5h:`, `7d:`, `CTX:`, `cache:`, clock) gray, cost white, git branch white / cyan, separator gray.
2. Themes: not present.
3. ANSI 16 only (`format.mjs`: 31/32/33/36/90/97/1); no depth detection, no NO_COLOR.
4. Foreground-only.
5. Separator: plain ` │ ` in gray (`status-line.mjs:281` `parts.join(gray(" │ "))`) in the inline mode; a git sub-line uses ` | `.
6. Neighbours: gray labels vs coloured values, `│` separators.
7. No adaptation; `97` bright white and `90` gray assume a dark terminal.
8. Emoji/Unicode: `⏱`, `↓`, `—`; no Nerd Font or ASCII mode.
9. Reads `permissionMode` from the transcript tail (`permission-mode.mjs`). Described in code as "box mode" and "inline mode" renderers; only the inline renderer is in the file read.
10. Customisation: none visible (edit source). Hooks sync the plugin (`hooks/hooks.json`).

## seonggyujo/heron
https://github.com/seonggyujo/heron (stars 1). not a Claude statusline: a Tauri v2 Windows terminal app for running several Claude Code sessions (black/green window theme, pixel herons). Its `plugin/statusline.js` is only a pass-through that writes usage-limit and context data to a file for the app and chains the user's own statusline (`previous.js`); it prints no styling of its own.

## sglim/tmux
https://github.com/sglim/tmux (stars 1). A tmux config (Catppuccin Mocha) with Claude Code hooks, plus a tiny statusline script `bin/claude-statusline`.
1. Statusline script (`bin/claude-statusline`): only the context bar+percentage is coloured, by threshold: `if [ "$pct" -ge 85 ]; then c=31; elif [ "$pct" -ge 70 ]; then c=33; else c=32` (red/yellow/green, terminal theme colours). Model, folder, `git:(branch)` are uncoloured. Output: `[Opus 5.5] │ motherin git:(main) │ Context ████░░░░░░ 43%`. The same percentage is written to tmux pane option `@claude_ctx` and coloured in `tmux.conf:138` (>=85 `@thm_red`, >=70 `@thm_yellow`, else `@thm_green`).
   Session state (not the statusline, hooks -> `@claude_state` pane option, `tmux.conf:128,138`): working = yellow, blocked = red (+ tinted pane bg `bg=#2e1e26`), idle = green hollow circle, done = green (+ tint `bg=#1e2b26`), drawn as dots in the window tab and a coloured title band in the pane border.
2. Themes: Catppuccin via the `catppuccin/tmux#v2.1.3` plugin (`@catppuccin_flavor 'mocha'`, switchable to latte/frappe/macchiato by editing); colours referenced as theme roles `#{@thm_yellow}`, `#{@thm_red}`, `#{@thm_green}`, `#{@thm_crust}`. The statusline script itself has no themes.
3. Statusline: ANSI 16 (`31/32/33`) so the terminal's palette decides; tmux part uses theme hex (`#f9e2af` etc.). No NO_COLOR.
4. Statusline: foreground-only. tmux status-right uses bg fills (`#[fg=#11111b,bg=#f9e2af] CPU #[fg=#cdd6f4,bg=#313244]`), pane titles bg-filled bands.
5. Statusline: ` │ `. tmux: Catppuccin "rounded" window tabs (`@catppuccin_window_status_style "rounded"`).
6. Neighbours (tmux right bar): alternating label chip (yellow bg, dark text) / value chip (#313244 bg, light text) pairs for CPU, RAM, DISK.
7. Text on state bands uses `@thm_crust` (darkest theme colour) over yellow/green/red; no computed contrast.
8. Unicode `█░ ○ ●`; Nerd Font recommended for Catppuccin rounded tabs; iTerm2 badge. No ASCII mode.
9. State tint on pane background; compare-and-set to avoid redraws; no animation.
10. Customisation: edit `tmux.conf` options (`@claude_tint_done`, `@claude_tint_blocked`), `install.sh` installer, `claude/settings.json` for hooks.

## shaho/claude-visor
https://github.com/shaho/claude-visor (stars 1). Bun/TypeScript, multi-surface statusline (main line, tools, todo, agents rows).
1. Mixed (`src/theme.ts:SEGMENT_DEFAULTS`, lines ~58-81): main row `model` fg = `sessionTint` (a per-session hue from `src/session-color.ts`: `Bun.hash(sessionId + worktree) % 360` with HSL s=0.55 l=0.65, so parallel terminals are told apart by model colour), `context` ok/warn/critical (green `[123,216,143]` / yellow `[229,192,123]` / red `[244,112,103]`; `thresholdColor` in `src/render/bar.ts:10-12`: pct < 70 ok, <= 85 warn, else critical), `pace5h`/`pace7d` ok/critical, `git` / `cost` uncoloured by default. Tools row: running yellow, completed green; todo progress green; agents status/gauge ok/warn/critical, tool yellow.
2. 5 embedded presets in `PRESETS` (`theme.ts:~126-131`): nord, gruvbox, tokyo-night, rose-pine, minimal; each is five slots (`model, ok, warn, crit, git`) expanded by `slotConfig` into the sparse per-segment schema. Users can add `~/.claude/claude-visor/themes/<name>.json`, a global `config.json`, a project `.claude/claude-visor.json`, and `CLAUDE_VISOR_THEME` env; layered, never throws (invalid fields fall back with a warning). Per-segment fields: `enabled, priority, fg, bg, bold, ok, warn, critical, icon{plain,nerd}`; surfaces `main/tools/todo/agents`; array order = display order.
3. Colour spec: `#rrggbb`, `256:N`, or ANSI16 names (`red`, `bright-black`..) or `sessionTint` (`parseColor`, theme.ts). Depth detection in `src/render/style.ts:makeStyle`: `NO_COLOR` -> none; `COLORTERM` truecolor/24bit -> truecolor; `TERM` contains 256 -> 6x6x6 cube; else nearest of 16 by RGB distance (`fgCode`, `nearest16`). Honors NO_COLOR.
4. Foreground-only (the `bg` field exists in the schema but the default theme leaves it null).
5. Separator: ` │ ` dimmed (`style.sep`, SGR 2); ASCII ` | `.
6. Neighbours: differing fg colours, dim separator; no alternation.
7. No light/dark adaptation; colours are mid-lightness (l~0.65) pastel for dark terminals. `minimal` preset removes colour except red critical.
8. Three charsets: `unicode` (default), `ascii` (also `CLAUDE_VISOR_ASCII=1`; `#`, `-`, `[ ]`, `git`), `nerd_font`; every glyph is overridable (`GLYPH_KEYS`: filled, empty, sep, branch, running, completed ...); per-segment `icon {plain, nerd}`.
9. Width-pressure priorities per segment (`priority`: repo-name, cost, 7d, git drop first), config validation `check` subcommand with warnings, per-session deterministic tint.
10. Customisation: JSON config (global + project + theme files), `CLAUDE_VISOR_THEME`, `CLAUDE_VISOR_ASCII`, `check` and `theme <name>` subcommands.

## shiyaming1994/cc-hud
https://github.com/shiyaming1994/cc-hud (stars 1). not a Claude statusline: a floating macOS (SwiftUI) HUD that watches all Claude Code sessions via hooks, wrapping the user's statusline only to capture its data (README: "a statusline wrapper that leaves your own statusline display unchanged"). For the record, its `Sources/CCHud/UI/Theme.swift` colours by state: permission #FFB02E, working #4DA6FF, idle #46C08A, dead #80848F; context text/bar warn at >=72 and crit at >=90; account quota "sage" (#7b9a86) when >50% left, "amber" (#a98c4f) 20-50, alarm (#ff5d54) <20; glass dark background. No terminal ANSI output.

## shorty456132/claude-terminal-statusline
https://github.com/shorty456132/claude-terminal-statusline (stars 1). Single bash script `statusline-command.sh` (python3 for parsing).
1. By threshold on one element: the context bar and percentage are coloured: `COLOR=$RED` if PCT >= `RED_AT` (75), `$YELLOW` if >= `YELLOW_AT` (50), else `$GREEN`; the percentage is against a user "budget" (`BUDGET_TOKENS=200000`, 0 = real window) not the model window, so it can exceed 100. Model name uncoloured; `·` separators and "max" suffix `DIM` (`\033[2m`).
2. Themes: not present.
3. ANSI 16 (`\033[32m`, `33m`, `31m`, `2m`); no depth detection, no NO_COLOR.
4. Foreground-only.
5. Separator: dim `·`.
6. Neighbours: only the coloured bar vs plain text.
7. No adaptation.
8. `█`/`░` 10-char bar; no emoji or Nerd Font.
9. Budget-vs-window idea ("context rot"): the thresholds tune to a chosen effective window; optional "1M max" hint.
10. Customisation: constants at the top of the script (`BUDGET_TOKENS`, `YELLOW_AT`, `RED_AT`, `SHOW_MAX`).

## SimeonGrancharov/nvimconfig
https://github.com/SimeonGrancharov/nvimconfig (stars 1). not a Claude statusline: a personal Neovim config. It does show Claude Code data in a lualine bar via `lua/utils/claude-statusline.lua` (reads `/tmp/claude-code-status.json` written by a `~/.claude/statusline.sh`). Styling facts: `lua/plugins/lualine.lua` sets a custom "BMW M" lualine theme (a/z cyan `#4DD4FF`, b/y blue `#3D8BFF`, c/x red `#FF5370`, white text, ASCII-art `▓▒░` / `░▒▓` section separators), and Claude items (`model` icon 󰚩, context bar `█░`, cost 󰄘, duration 󱎫, `+added -removed`) sit in `lualine_x` with no per-item colour. `M.context_color()` defines thresholds (<50 `#4DD4FF`, <80 `#f9e2af`, else `#FF5370`) but is never passed as `color =` in `lualine.lua`, so it is dead code. Hex truecolor via Neovim highlight groups.

## simota/claude-mods
https://github.com/simota/claude-mods (stars 1). not a Claude statusline: a marketplace of ~25 Claude Code "mods" (function-hook plugins: panes, bands above the prompt). Two mods write the status line text through `$.ui.status(string)` (`pr-lamp`: `statusLineOf` returns plain text such as `🟢 マージ可能`, `mods/pr-lamp/hooks/lamp.ts:310,292`; `port-lantern`), i.e. emoji for state, no ANSI. `tool-row` (`mods/tool-row/hooks/summary.ts:5-12`) colours the tool-call rows with a fixed Gruvbox palette by tool kind (edit/write yellow `#fabd2f`, read/web blue `#83a598`, bash aqua `#8ec07c`, grep purple `#d3869b`, agent orange `#fe8019`, mcp gray, `+n` green / `-n` red, errors tint everything red `#fb4934`) with Nerd Font icons, via Ink `<Text color>`.

## sirkitree/claude-statusline
https://github.com/sirkitree/claude-statusline (stars 1). Bash script `statusline.sh` + `statusline-config.json`, needs ccusage (npx).
1. Fixed per segment (`statusline.sh` "Build sections" lines): directory ORANGE, model CYAN (abbreviated: `o4.7(1m)`), effort YELLOW (`lo/md/hi/xh/mx`), git branch GREEN, context PINK (`CTX_TOTAL + [█░]` bar), cost segment by threshold-layer (below), `weekly N%` uncoloured, session timer PURPLE, `×N` active-session count CYAN. Cost bar uses a multi-layer scheme: actual spend 0-30% (config default, 50% in the shipped JSON) of the cost limit stretches to a full bar in GREEN, next layer ORANGE, last layer RED (`multi_layer.layer1/2/3.threshold_percent`), and a coloured `│` marks the projected end-of-window position in its own layer colour.
2. Themes: not present; but the palette is user-editable under `colors` in `statusline-config.json`.
3. ANSI codes as raw strings, mixed: `\033[1;38;5;208m` orange, `\033[38;5;225m` pink, `\033[38;5;194m` green(pale), `\033[35m` purple, `\033[96m` cyan, `\033[33m` yellow, `\033[1;31m` red. No depth detection, no NO_COLOR.
4. Foreground-only.
5. Separator: plain ` | `.
6. Neighbours: different hue per segment, pipe separators.
7. No adaptation (pale greens/pinks assume a dark terminal).
8. Unicode `█░`, `×`, `→`; no emoji, no Nerd Font.
9. Layered progress bar with projection marker; debug log to `/tmp/statusline_debug.log`.
10. Customisation: `statusline-config.json` (plan, limits, colours as ANSI strings, thresholds, bar length, `sections.show_*` toggles); `install.sh`.

## snail2sky/claude-statusline
https://github.com/snail2sky/claude-statusline (stars 1). Python `statusline/fancy_statusline.py` (also install.sh/install.ps1).
1. Fixed per segment with one threshold bar (`fancy_statusline.py:377-396`): `user@host` 110 (light blue) with cwd 39 (blue); git branch 208 (orange) + flags (clean `✓` 121 green, `*` dirty 203 red, `↑ahead` 121, `↓behind` 203; no repo = 240 gray `no-git`); model 220 (gold) `⚡`; `Ctx:` label 141 (purple) with bar by threshold (`make_bar`, lines 100-116: <50 `38;5;121` green, <80 `38;5;220` yellow, else `38;5;203` red) and percent bold white; `Tokens:` label 214 (orange) with value 121; `Calls:` label 121. Separator and secondary text 244 gray.
2. Themes: not present.
3. ANSI 256 only (`38;5;N`); no depth detection, no NO_COLOR.
4. Foreground-only.
5. Separator: ` │ ` in 244 gray.
6. Neighbours: a different 256-colour hue per label, gray pipe.
7. No adaptation.
8. `⚡`, `✓`, `↑↓`, `█░` bars; no Nerd Font; no ASCII mode.
9. Estimates context limit from model id (`get_context_limit`); fallback line on error.
10. Customisation: edit script; no config.

## Sodanitertraction336/cc-statusline-tui
https://github.com/Sodanitertraction336/cc-statusline-tui (stars 1). A Rust TUI wizard + renderer (`src/styles.rs`, `render.rs`, `wizard/`). Caution: the README is boilerplate download-page text that links a "download" ZIP at an unrelated raw.githubusercontent URL (a likely malware-lure template); the Rust source is the real content and was read, the binary was not run.
1. Per segment style name stored in config (`config.rs` `style` field on each segment; defaults: model `cyan`, cost `green`, usage `white`, path `ultrathink` (rainbow), git `cyan`, context `semantic`, crypto `green`). `format_colored(style, text)` (`styles.rs`) maps the name: 16 named colours (`cyan green blue yellow magenta red white`, `soft-green/yellow/red/blue/cyan/magenta` as 256 idx 71/179/167/75/80/176, `orange` 208, `pink` 212, `purple` 141), plus `ultrathink` (per-character rainbow over a 7-colour truecolor palette, 2 palettes alternate by timestamp parity "shimmer", offset rotates every second) and bar styles `ultrathink-gradient` (interpolated over the filled portion) and `semantic` (traffic light on the ratio: >= 0.60 soft-red, >= 0.30 soft-yellow, else soft-green, `semantic_color`).
2. Themes: "12 color styles" and 5 presets (`wizard/presets.rs`: minimal, developer, dashboard, rainbow, crypto), which set rows, segment toggles and styles. Not a theme-role palette; the user picks a style per segment in the wizard.
3. Mixed ANSI 16 (`\x1b[0;36m`), 256 (`38;5;N`), truecolor (rainbow). No depth detection and no NO_COLOR found in `styles.rs`/`render.rs`.
4. Foreground-only.
5. Separator: segments in a row joined by a single space (`render.rs:271`, `parts.join(" ")`); up to 3 rows (`rows`). Dim is `38;5;239` for empty bar cells.
6. Neighbours: per-segment hue only.
7. No adaptation (the "soft" 256 colours are chosen for dark terminals).
8. Optional model `icon` field; emoji in several labels (26 detected); bar characters `shade ▓░`, `full-block █`, `rectangle ▬`. 7 UI languages (i18n.rs).
9. Animated rainbow (`ultrathink`) text and gradient bars, with the colour rotation driven by the clock at each refresh; crypto price segments with caches.
10. Customisation: interactive wizard (language, preset, segments, styles, order/rows), JSON config under the statusline dir (`config.rs:statusline_dir/config_path`), `install.rs` writes the Claude `statusLine` setting.

## sokojh/claude-code-tmux-hud
https://github.com/sokojh/claude-code-tmux-hud (stars 1). Node `scripts/statusline.mjs` (a claude-hud-style layout) plus tmux session-picker/panel scripts.
1. By threshold plus fixed (`statusline.mjs:27-45`): context bar and percent via `ctxColor`: >=85 red, >=70 yellow, else green; usage-quota bars via `quotaColor`: >=90 red, >=75 bright magenta, else bright blue (a non-traffic-light scale, so quota and context read differently). Fixed: `[model | plan]` cyan, project path yellow, git `git:(` `)` magenta with branch cyan, `⏱️` duration and secondary details dim, limit warning `⚠ Limit (resets)` red, plan-mode line bright magenta.
2. Themes: not present.
3. ANSI 16 plus bright (`\x1b[94m`, `\x1b[95m`); `color.bg_256` appears once in the tmux scripts; no depth detection or NO_COLOR.
4. Foreground-only in the statusline.
5. Separator: plain ` | ` (`parts.join(' | ')`), dim for detail lists.
6. Neighbours: hue per element; pipes.
7. No adaptation; `DIM` for de-emphasis.
8. Emoji (`⏱️`, `⚠`), `█▓▒░` bar with a 2-step fade at the fill edge (`coloredBar`: filled `█`, then `▓▒` gradient, then dim `░`).
9. Multi-line: identity line, project line, environment counts (`N CLAUDE.md`), tool/agent/todo lines; fetches OAuth usage with 60 s cache.
10. Customisation: edit script; `install.sh`; tmux panel scripts.

## solarahorizon/llmeter
https://github.com/solarahorizon/llmeter (stars 1). Python usage harvester; statusline text from `llmeter/core.py:format_line`.
1. No colour at all in the statusline: `format_line` joins plain parts `model · ctx N% (tokens/window) · 5h N% (reset) · cache 5m:Nk | 1h:Nk · wk N% (reset) · $cost` with " · " (`core.py:678-731`); the file contains no escape codes (0 matches for `\x1b`/`\033`). Segments appear only when data is present.
2. Themes: not present in the statusline. The TTL report (`ttl_report.py:45-58`) is an HTML page with CSS-variable light and dark palettes (`prefers-color-scheme` plus `data-theme`), fixed `--cost` amber / `--save` green / `--carry` gray.
3. Not applicable (no colour); NO_COLOR moot.
4. No fill; plain text.
5. Separator: ` · `.
6. Neighbours: only the separator and labels.
7. Not applicable in the statusline (the HTML report adapts).
8. Plain text; "Opus 5 (1M context)" shortened to "(1M)" to save width; no emoji, no Nerd Font.
9. The product is about harvesting `rate_limits` caps to disk; the line is deliberately minimal.
10. Customisation: none for the line; `install.sh` writes the `statusLine` key (with a backup).

## Sparrow447/wezterm-claude-sessions
https://github.com/Sparrow447/wezterm-claude-sessions (stars 1). A WezTerm config (tab/status bar, Lua), a terminal dashboard (`dashboard/dash.js`), and a plain Claude statusline (`dashboard/statusline.js`).
1. Claude statusline (`dashboard/statusline.js`, final lines): no colour; plain `model · folder · ctx N% · $cost` joined with ` · `. The real styling is in the WezTerm bar: session counts coloured by state in `wezterm/modules/claude.lua:20`: `M.colors = { working = c.orange, waiting = c.yellow, done = c.green, error = c.red }`; `status_bar.lua` badges (LEADER yellow, key-table name cyan) use dark `base` text on a coloured bg.
2. Themes: one palette file `wezterm/modules/palette.lua` (Dracula by name: base #282a36, surface #44475a, muted #6272a4, text, red, orange, yellow, green, cyan, purple, pink). Its comment: swap the values for Catppuccin or Rose Pine and everything follows. Roles are semantic enough (base/surface/muted/text + 7 hues). `dash.js` uses truecolor `fg(h)` helpers.
3. Truecolor hex (WezTerm `Color`, `dash.js:53` `38;2`); no depth detection.
4. WezTerm badges are bg-filled; the Claude statusline and dashboard text are foreground-only.
5. Separator: ` · ` plain in the statusline.
6. Neighbours (WezTerm bar): bg-filled badges on a dark bar, plain gaps.
7. Badge text always `base` (dark) on bright hues; no adaptive contrast.
8. Emoji/box glyphs in dashboard (22 emoji, 38 box chars).
9. Dashboard TUI with fake-chat demo for screenshots.
10. Customisation: edit `palette.lua`; `install.js` installer; `statusline.js --save-only` mode so an existing statusline is kept while data is saved.

## squanchymnonm/ClaudeCodeStatusBar
https://github.com/squanchymnonm/ClaudeCodeStatusBar (stars 1). Bash plugin (`plugins/statusline/scripts/statusline.sh`, `subagent-statusline.sh`); Spanish comments.
1. By threshold, only two colours: `colorize_pct` (`statusline.sh:41-50`): >= 70 red, > 50 yellow, else uncoloured; used for the 5h session and 7d week percentages; the context segment does the same plus emoji: >= 70 `ctx: <red>N% used</red> 🔥`, > 50 yellow with `⚠️`, else plain (lines 56-62). Model name plain.
2. Themes: not present.
3. ANSI 16 (`\033[31m`, `\033[33m`); no depth detection, no NO_COLOR.
4. Foreground-only.
5. Separator: plain ` | `.
6. Neighbours: labels (`ctx:`, `session:`, `week:`) and pipes only.
7. No adaptation (default terminal text colour is kept for the calm state, which is theme-safe).
8. Emoji for severity (🔥 ⚠️); no Nerd Font.
9. A separate `subagent-statusline.sh` renders per-task rows (name, tokens with dotted thousands, duration).
10. Customisation: edit script; `install-statusline.sh` and `settings.json`.

## sriinnu/tokmeter
https://github.com/sriinnu/tokmeter (stars 1). Monorepo (core, cli, tui, web, macos-bar, mcp). The Claude statusline lives in `packages/mcp/src/statusline-view.ts` (+ `statusline.ts`) and an older bash `packages/mcp/scripts/statusline-command.sh`.
1. TS statusline (`statusline-view.ts`): semantic tones, not slots: `Tone = plain|dim|ok|warn|bad|accent|cost|bold|chip|alertWarn|alertBad` (lines 74-98). Context tone: >= 85 bad, >= 70 warn, else ok (`ctxTone`); quota windows: >= 90 bad, >= 70 warn (`windowTone`). Fixed: project name is a `chip` (bold white on deep purple bg `48;2;91;33;182`, text ` ◆ <project> `), cost values `cost` (amber `252,211,77`), labels `today `/`repo ` `accent` (violet), separators `dim`, "of N routed" `ok`. Alerts (ctx >= 95, limit reached, compacting) render as `alertWarn`/`alertBad`: bold coloured text on a dark tinted background.
   Bash script: `cost_color` green, orange >= 500, red >= 1000 (units as written); bar green < 50, yellow >= 50, red >= 80; input blue `↑`, output red `↓`, cache gray `⟳R`, write magenta `⟳W`, purple branding, gold cost.
2. Themes: 6 in `packages/core/src/themes.ts` (tokmeter, tokyo-night, catppuccin-mocha, dracula, solarized-dark, high-contrast; `BUILT_IN_THEMES`), semantic roles (`primary, secondary, success, warning, danger, muted, text, bg`) plus data roles (`cost, input, output, cache, thinking`) plus statusline segment backgrounds (`segProject, segModel, segContext, segGit, segCost`) for a powerline style. User picks by `theme` in `~/.config/tokmeter/config.json` (`loadUserTheme`), `nerdFont: true` there too. The shipped statusline view does NOT read the theme (no `theme` reference in `statusline.ts`; SGR constants are fixed truecolor), so the seg* roles are declared but unused by this surface (the macOS bar and TUI/web read themes; docs/macos/themes.md lists 16 names there including aurora, nebula, paper, glass).
3. Truecolor SGR in the TS view; ANSI 256 in the bash script. Honors NO_COLOR and FORCE_COLOR (`statusline.ts:217-221`: `FORCE_COLOR` != "0" re-enables; `!NO_COLOR` otherwise); `paint()` emits plain text when disabled.
4. Both: foreground for most, bg only for the project chip and alerts.
5. Separator: ` │ ` dim (`SEP`, line 119), no arrows in the shipped view.
6. Neighbours: chip first, then coloured values; dim pipes; width-priority dropping (`prio`, `fit()` removes the lowest priority segment until the line fits `cols`).
7. No light/dark adaptation in the line (fixed mid-bright RGB); the `paper` and `github` themes exist elsewhere.
8. "The renderer only emits single-cell glyphs (no emoji)" (comment line 114): `▰▱` bars, `◆`, `│`; Nerd Font optional via config for other surfaces.
9. Burn-rate projection (`~projected%`), turns-left estimate, ctx alerts at 95/100; limit-aware segment dropping.
10. Customisation: `~/.config/tokmeter/config.json` (`theme`, `nerdFont`), env NO_COLOR/FORCE_COLOR; `statusline.ts` reads terminal columns.

## stricttools/howmuchleft
https://github.com/stricttools/howmuchleft (stars 1). Go binary (~6 ms), three gradient bars (context, 5h, weekly), TOML config `~/.config/howmuchleft/config.toml`.
1. Bars are coloured by value along a gradient (`internal/render/bar.go:GetGradientStop`): the percent picks a position in a stop list and the filled cells are coloured, so low = green, mid = yellow, high = red, interpolated in RGB for truecolor, snapped to a stop for 256 colour. Text: fixed per element (`compose.go`): percentages cyan (`Cyan + N% + Reset`, line 48), model white, tier magenta, cwd white, branch cyan, ahead/behind magenta `↑↓`, changed files yellow `+N`, "no .git" gray, ages/reset times dim. GitHub user and profile names get a hash colour: `HueToAnsi(HashToHue(user), isDark)` (`hash.go`, djb2 -> hue 0-359, s 0.7, l 0.75 dark / 0.35 light), so the same name always has the same colour. Time bars use an urgency gradient gray -> yellow -> red (`GetUrgencyColor`).
2. Themes: 4 built-in gradient entries (`gradient.go:BuiltinColors`): dark+truecolor (10 RGB stops 0,215,0 ... 255,0,0, empty bg 48,48,48), light+truecolor (muted stops, empty bg 208,208,208), dark+256 (indices 46 ... 196, bg 236), light+256 (indices 40 ... 160, bg 252). User override: `[[colors]]` entries in TOML with `gradient` (RGB triplets or 256 indices), `bg`, and optional `dark_mode`/`true_color` conditions (nil = wildcard), first match wins (`FindColorMatch`); `howmuchleft colors` previews the gradient.
3. Truecolor and 256; `COLORTERM` = truecolor/24bit selects (`IsTruecolorSupported`, cached); RGB gradients downsampled to the 6x6x6 cube by `RgbTo256` on 256-colour terminals; config key `color_mode`. No NO_COLOR handling found in `colors.go`/`compose.go`.
4. Both: gradient colours used as fg for glyph fills and as bg (`Fg` and `Bg` escapes returned together), with empty cells drawn on a dim bg colour.
5. Separator: plain text between elements; no powerline.
6. Neighbours: bar vs text colour contrast; no alternation.
7. Real light/dark detection: `IsDarkMode` checks `HOWMUCHLEFT_DARK` env, then a 2 s cache file `.dark-mode-cache.json` in the Claude dir, then macOS `defaults read -g AppleInterfaceStyle` or GNOME `gsettings color-scheme` (default dark if the command fails); picks the light or dark gradient/bg and the lightness of hashed colours. No per-pair computed contrast.
8. Fractional block glyphs for sub-cell precision (`▏▎▍▌▋▊▉`, vertical `▁..▇`), auto-disabled on `Apple_Terminal` and `linux` console (`PartialBlocksBlocklist`; config `partial_blocks`); no emoji, no Nerd Font; horizontal or vertical bar orientation (`progress_bar_orientation`).
9. Multi-profile dashboard (`profile list --live`), animated `demo`, three-line layout configurable (`lines.line1/2/3` arrays of element names), `time_bar_dim`.
10. Customisation: TOML (`color_mode`, `progress_length`, `colors`, `partial_blocks`, `progress_bar_orientation`, `cwd_max_length`, `cwd_depth`, `show_time_bars`, `time_bar_dim`, `lines`, `profiles`), `HOWMUCHLEFT_DARK` env, subcommands `colors`, `config`, `demo`.

## StupidIncarnate/token-nerd
https://github.com/StupidIncarnate/token-nerd (stars 1). A token analysis tool (Ink TUI) with a statusline formatter, `src/entries/statusline/format-statusline.ts` and `config.ts`.
1. By threshold, one element: token count + percentage get no colour below `THRESHOLDS.WARNING_PERCENT` (75%), yellow from 75%, red from `DANGER_PERCENT` (90%) (`config.ts:36-72`), with emoji (`⚠️` at warning, `🔴` at danger) and `| N% left!` appended when critical. Nothing else coloured.
2. Themes: not present.
3. ANSI 16 constants (`ANSI_COLORS.RED/YELLOW/RESET` from `shared-constants.ts`). Colour can be disabled with the `--no-colors` argument (`format-statusline.ts`: `showColors: !noColors`); NO_COLOR env not seen.
4. Foreground-only.
5. Separator: ` | ` text only for the "left!" suffix; otherwise one segment.
6. Not applicable (single value).
7. No adaptation; calm state is uncoloured so it follows the terminal.
8. Emoji for severity; no Nerd Font.
9. The statusline shows real tokens with cache breakdown (token count `toLocaleString`), an `~? (est)` fallback.
10. Customisation: constants in `shared-constants.ts`; flag `--no-colors`; installed through a `statusline-installer`.

## sumitosou/claude-statusline
https://github.com/sumitosou/claude-statusline (stars 1). Bash `statusline-command.sh`.
1. Fixed per segment plus thresholds (`statusline-command.sh:134-141,387-393`): model bold cyan, directory blue, git status `+staged` green, `~unstaged` yellow, `?untracked` dim, context bar by threshold (`<50` green, `<80` yellow, else red; `CTX_COLOR`), cost/secondary dim; at ctx >= 90 the first segment becomes a red-background alert badge ` ⚠ CTX N% ` (`BG_RED`, `WHITE_BOLD`), and a quota badge appears when the 5h usage passes `QUOTA_WARN`. Usage bars `5h ★ ★ ★ ☆ ...` (stars filled/empty, "ccsl style") for 5h and 7d.
2. Themes: two palette sets, `dark` and `light` (`THEME`, lines 82-102): the light set swaps DIM from SGR 2 to `90` bright-black and alert text from bold white to bold black.
3. ANSI 16 only; no depth detection, no NO_COLOR.
4. Mostly foreground; red background only on the alert badge.
5. Separator: `SEP` (dim, text).
6. Neighbours: hue per segment (cyan model, blue dir, green/yellow git) and dim separators; two-line layout with the 5h/7d usage as a right-hand column aligned to the longer left line (`pad_to`).
7. Real adaptation: `detect_theme` (lines 53-74): `STATUSLINE_THEME=dark|light|auto`; on macOS `defaults read -g AppleInterfaceStyle`; else `COLORFGBG` (bg index < 8 = dark); else dark. Alert badge text colour flips for readability.
8. Nerd Font optional: `STATUSLINE_NERD_FONT=1` switches icon sets (`ICON_*`), default plain text; emoji in the warning badges (82 emoji hits); stars `★☆` for usage bars.
9. Update-available hint (`upstream updated`), vim mode, venv, session name segments.
10. Customisation: env vars (`STATUSLINE_THEME`, `STATUSLINE_NERD_FONT`, `QUOTA_WARN`), edit the script; `install.sh`.

## terminalartclub/tac
https://github.com/terminalartclub/tac (stars 1). not a Claude statusline: a Claude Code plugin (`/tac:create`, `/tac:play`, `/tac:submit`) for making looping terminal-art animations (Python, `rich`) and a gallery platform. Its only statusline file, `plugins/tac-studio/scripts/statusline_cache.py`, is an opt-in wrapper that caches `rate_limits.seven_day` to `~/.cache/tac/usage.json` and runs the user's own statusline command; it prints nothing of its own. `platform/themes.json` is the gallery site's theme list.

## ThatMatin/tokenscope
https://github.com/ThatMatin/tokenscope (stars 1). Bash `scripts/statusline.sh` (two lines) + Python dashboard/grid/live views.
1. By provenance and threshold (`statusline.sh` "colors" block, ~lines 62-86): colours mean how trustworthy a number is, not which segment it is: `EXACT` (256: 114, green) for values the harness reports directly (model, dir, ctx %, cost, elapsed, 5h/7d percentages), `PARTIAL` (215, amber) for "true but incomplete" (total tokens, per-turn token delta), `GENERATED` (245, gray) for derived/annotation (cost delta, reset countdown, rtk savings). Bars (`mkbar`): fill green (114) < 50%, amber (215) < 80%, red (203) >= 80%, empty `░` uncoloured.
2. Themes: none in the statusline. The dashboard (`views/dashboard.py:114-131`) has CSS themes (default, `light`, `yellowish`) with a muted lower-chroma data palette and a theme switcher.
3. ANSI 256 (`38;5;N`); no depth detection, no NO_COLOR.
4. Foreground-only.
5. Separator: ` · ` (`SEP="${RESET} · "`).
6. Neighbours: colour encodes data provenance (green/amber/gray) rather than varying by neighbour.
7. No adaptation.
8. `█░` bars, `Δ`, `↻` reset arrow, `×`; no emoji, no Nerd Font.
9. Per-turn deltas (tokens, cost) kept in a `.tokdelta` file; turn log JSONL; optional rtk savings segment.
10. Customisation: edit script; side files in `~/.claude`; `tokenscope` CLI for dashboard/grid/live/report.

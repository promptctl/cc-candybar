## token-sprout
https://github.com/macacacacaca/token-sprout - stars 0
Verdict: mostly not a conventional statusline. It is a local proxy that turns token usage into a plant; the Claude statusline is one optional view. Styling read from `README.md`, `token_sprout/ui.py`, `ascii_art.py`.
1. Statusline text is emoji + plain text, e.g. `🌱🌱 2/20 · 💧 [██████░░░░] 67% · +5,000 tokens` (README, "Initialize and connect"). No per-segment ANSI colour found in `feed.py`/`ascii_art.py`/`cli.py` (grep for `\033`, `\x1b`, `color` empty). Colour is by stage emoji: seed 🌰, sprout 🌱, leaf 🪴, bud 🌷, bloom 🌸 (`ascii_art.py` `STAGE_EMOJI`). The statusline formatter itself was not located; the example line is README only.
2. Themes: not present for the statusline. The `watch` panel (`ui.py`) hard-codes rich styles (`bright_blue` droplets, `green` pile, `bold magenta` bloom, `bold cyan` thinking, `dim`). The VS Code sidebar follows the editor theme (README: dawn in light themes, night in dark; `vscode-extension/src/webview.js` not themed by user).
3. Colour spec: rich named styles in the TUI; statusline has none. NO_COLOR: not present.
4. Fill: foreground-only / emoji. No backgrounds.
5. Separators: ` · ` plain text.
6. Neighbours: separated only by ` · `.
7. Light/dark: only the VS Code sidebar (README); statusline none.
8. Glyphs: emoji throughout, `█░` bar. No ASCII fallback found.
9. Notable: the plant grows with tokens; statusline hides when idle unless `install-statusline --always` (README).
10. Customisation: CLI (`token-sprout install-statusline [--always]`, `uninstall-statusline`), no colour config.

## maderski/claude-cli-status-line
https://github.com/maderski/claude-cli-status-line - stars 0
1. `statusline-command.sh`: fixed per segment for most, threshold for rates. Model = cyan `\033[0;36m` (l.199); effort/output-style = magenta 35 (l.206); cost = yellow 33 (l.214); duration = dim `\033[2m` (l.229-233); lines `+N` green / `-N` red (l.241); git branch = bright blue `0;94` (l.296); agent/worktree = magenta (l.303-305). Threshold (>=80 red 31, >=50 yellow 33, else green 32): context (l.144-147), 5h limit (l.159-162), 7d limit (l.176-179).
2. Themes: not present.
3. Colour spec: named ANSI 16 only (`\033[0;3Xm`, `0;94`). No depth detection; NO_COLOR not present.
4. Fill: foreground only.
5. Separators: plain ` | ` in dim (`sep`, l.311).
6. Neighbours: plain dim `|` separators plus differing hues (cyan, magenta, yellow, blue).
7. Light/dark: not present. The 7d label uses `\033[0;37m` light grey (l.182).
8. Glyphs: `█░` 10-cell context bar in `[...]`; pie glyphs `○ ◔ ◑ ◕ ●` for 7d usage (l.180-181); a branch glyph before the branch name. No fallback.
9. Reset-aware: none. Git branch cached 5 s per workspace.
10. Customisation: edit the script; `setup.sh` installs it. No config.

## magnificenttaco/claudemods
https://github.com/mAgNiFiCeNtTaCo/ClaudeMods - stars 0
Mod suite (Dragon Ball Z HUD) for the Claude Code plugin API, not a plain statusline; `mods/saiyan-status` is the status-line piece.
1. By state/threshold via a palette: `shared/palettes.ts` `gaugeColorOf(p, percent)`: >=85 `danger`, >=70 `warn`, >=50 `gold`, else `ki`. `saiyan-status` status line `⚡ SSJ2 · Ki 73% · Stamina 41% (2h13m) · Zeni $1.24` (`hooks/logic.ts` `statusText`) is plain text, no colour code found in `register.tsx`. Tier names by context fill: Base/Kaioken 25/SSJ 50/SSJ2 70/SSJ3 85/Limit Breaker 95 (`TIERS`).
2. Themes: 10 bundled palettes (goku, vegeta, namek, frieza, super-saiyan-blue, ultra-instinct, majin-buu, kaioken, plus wish-only golden-frieza and super-saiyan-rose), semantic roles `ki, beam, heading, frame, gold, warn, danger, readout` (`shared/palettes.ts` `Palette`). Each palette is a TS object; user-defined palettes: not present (add by editing the file; each mod keeps a copy at `hooks/palettes.ts`). `/dbztheme` switches all mods through `$.config.set`.
3. Colour spec: hex strings for the host's `Text color` prop (`specs/THEME.md`). No depth detection; the host renders.
4. Fill: foreground only (colour on text/gauges); borders are glyphs.
5. Separators: ` · ` text in the status line; box-drawing glyphs in the panes.
6. Neighbours: by text labels and `·`; roles distinguish heading/readout.
7. Light/dark: not present ("Dim text stays dim in every scheme").
8. Glyphs: `█▓▒░`, `(◉)`, `★`, `⚡`, one 🐉; themed vocabulary (Ki, Stamina, Zeni). No ASCII mode.
9. Notable: secret palettes unlocked by an in-game wish; Kamehameha beam animation, toasts (`specs/THEME.md`).
10. Customisation: per-mod `palette` userConfig (`/config`), `pluginConfigs` in settings; per-feature toggles.

## mahadi2002/claude-token-analyzer
https://github.com/mahadi2002/claude-token-analyzer - stars 0
1. `scripts/statusline.py`: no colour at all. Output is `5h 42% · 7d 18% · ctx 31%` plain text; optional `statusline_chain` command output appended (reads `config.json`).
2. Themes: statusline none; the HTML dashboard has `dashboard/theme.css` (not a statusline theme).
3. Colour spec: not present. NO_COLOR: not present.
4. Fill: none.
5. Separators: ` · ` plain.
6. Neighbours: separator only.
7. Light/dark: dashboard CSS only; statusline none.
8. Glyphs: none.
9. Notable: the statusline's purpose is to record plan-limit readings to `~/.claude-token-analyzer/limits.jsonl` for the dashboard.
10. Customisation: `config.json` `statusline_chain`; installer `/token-analyzer:setup-statusline`.

## mansurmuaz/claude-statusline
https://github.com/mansurmuaz/claude-statusline - stars 0
1. `templates/statusline.sh` generated by `index.js` (npx wizard). Fixed per segment: dir `C_DIR`, branch `C_BRANCH`, worktree `C_WORKTREE` from the chosen theme; model, cost, separators `\033[0;90m` grey (l.22-27); dirty marker `38;5;214` (l.28). Threshold: context bar and 5h/7d plan bars use `C_BAR_OK` (<50), `C_BAR_WARN` (50-79), `C_BAR_CRIT` (>=80), `C_BAR_ALERT` (>=95 for 5h; 7d: 75-79 OK, 80-89 warn, 90-94 crit, 95+ alert) (l.92-98, 155-179). The reset countdown `↻` turns warn/crit/alert as the reset nears (5h: 1h/30m/5m; 7d: 1d/8h/1h; l.138-146).
2. Themes: 4 bundled, chosen in the setup wizard (`COLOR_THEMES` in `index.js` l.33-74): default (muted 256-colour), vibrant (ANSI 16), pastel, monochrome. Per-role format: keys dir, branch, worktree, barOk, barWarn, barCrit, barAlert. User-defined: not present at runtime (edit the generated script).
3. Colour spec: mix of 256-index (`38;5;N`) and ANSI 16 (vibrant). No depth detection; NO_COLOR not present.
4. Fill: foreground only.
5. Separators: ` | ` in `C_DIM` (`\033[0;90m`).
6. Neighbours: hue per role plus dim `|`.
7. Light/dark: not present.
8. Glyphs: `█░` bar, `⑂` for worktree, `●` dirty, `↻` reset; OSC 8 Jira link on branch (l.192).
9. Notable: Jira ticket auto-link from branch name.
10. Customisation: interactive Node wizard (bar width, worktree on/off, Jira URL/prefix, theme) that substitutes `__C_*__` placeholders into the script.

## marcelo-maciel/ccvitals
https://github.com/marcelo-maciel/ccvitals - stars 0
1. `utils.js` `C` table (l.22-28) + `display.js`. Fixed: model name and context bar fill use the user accent `C.accent`; separators `C.gray` (245); labels `C.soft` (250); empty bar cells `C.barEmpty` (238). Threshold via `colorByThreshold(value,[low,mid],palette)` (utils.js l.137): default palette `[green, warn(221), danger(203)]`; applied to session cost, monthly cost (gray/warn/danger), rate limits (`display.js` l.151); sub-agent ctx % (>=80 danger, >=50 warn); cache expiry (<30 s danger, <2 min warn); agent elapsed time (yellow/red). Effort tag: `EFFORT_CONFIG` maps low/auto soft, medium gray, high/xhigh/max accent (bold for xhigh/max), ultracode orange bold (utils.js l.45-53). Burn-rate delta green/gray/danger by +-15 points.
2. Themes: one accent colour only: `accentMap` of 9 names (orange, blue, teal, green, lavender, rose, gold, slate, cyan) read from `settings.json` `statusline.accent` (utils.js l.28-37); default blue. No full themes, no user palette.
3. Colour spec: 256-index (`38;5;N`) plus plain ANSI 16 (`\x1b[32m`). No depth detection; NO_COLOR not present.
4. Fill: foreground only.
5. Separators: ` | ` in gray (`SEP`).
6. Neighbours: gray `|` separators and a dim/labelled structure (`ctx:`, `5h:`); value colours differentiate.
7. Light/dark: not present.
8. Glyphs: emoji (📁 🔀 📂 💸), `█▄░` context bar with half-fill (display.js l.116-121), braille spinner for agents, `⚠`. No ASCII mode.
9. Notable: prompt-cache expiry clock, burn-rate delta vs elapsed window time, post-/compact estimated `~` percentage; plain `file://` URL for the cwd (OSC 8 is stripped by Claude Code; display.js l.13-20).
10. Customisation: `settings.json` `statusline.accent`; `config.json` `clickablePath`; env `DEBUG_STATUSLINE=1`.

## marcozaa/claude-chiptune
https://github.com/Marcozaa/claude-chiptune - stars 0
Not a general Claude statusline: a Spotify now-playing block (cover art as half-block pixels, equalizer, lyrics) rendered in the status line; `statusline_header` can add `model · folder` dim.
1. Single accent colour derived from the album cover: `cover.py` `accent_color` picks the most saturated pixel and maps to the 256 cube (`to_cube`); applied to the title, equalizer, progress bar and controls (`render.py` `_accent`, fallback index 77). Artist plain, album and timestamps `DIM` (`\033[2m`).
2. Themes: not present (theme names catppuccin/synthwave appear in the scanner only from other files; not a theme system in the files read).
3. Colour spec: 256-colour index only (`38;5;N`/`48;5;N`); cover pixels quantized to the 6x6x6 cube with a saturation boost (`boost`, `SATURATION_BOOST`). NO_COLOR: not present.
4. Fill: both: the cover is `▀` with foreground = top pixel and background = bottom pixel; text is foreground only.
5. Separators: none (block layout); `·` in the optional header.
6. Neighbours: not applicable.
7. Light/dark: not present.
8. Glyphs: `▰▱` progress, `▁..█` equalizer from a sine of time, `⏮ ⏯ ⏭` clickable via OSC 8 `claude-chiptune://` links, braille blank `U+2800` padding that survives trim (render.py).
9. Notable: album-art-driven accent colour; compact one-line mode while Claude is busy (`COMPACT_WHILE_BUSY`).
10. Customisation: env `CHIPTUNE_<NAME>=0` toggles (LYRICS, CONTROLS, COMPACT_WHILE_BUSY).

## markallisongit/claude-statusline
https://github.com/markallisongit/claude-statusline - stars 0
1. `statusline-command.sh` (and `.ps1`, same colours): fixed per segment from the Catppuccin Mocha palette in truecolor: user@host mauve bold `203;166;247`, dir blue `137;180;250`, git branch green `166;227;161`, model lavender `180;190;254`, effort peach `250;179;135`, labels `S`/`W` subtext1, values and remaining time overlay1 `127;132;156` (l.50-60). Threshold only on `ctx:N%`: >=80 red `243;139;168`, >=50 yellow `249;226;175`, else teal `148;226;213` (l.89-98).
2. Themes: one hard-coded palette (Catppuccin Mocha, "tuned for dark backgrounds"); no switch, no user themes.
3. Colour spec: truecolor `38;2;r;g;b` only. No depth detection; NO_COLOR not present.
4. Fill: foreground only.
5. Separators: ` | ` in overlay0 `108;112;134` (`c_sep`).
6. Neighbours: hue per segment role plus `|`.
7. Light/dark: dark-only by design.
8. Glyphs: none beyond text. Strips control bytes from dir/branch to stop escape injection (`clean()`).
9. Notable: Windows PowerShell twin renders identical colours.
10. Customisation: edit script; `install.sh`/`install.ps1`.

## masakasuno1/masao-cc-status-line
https://github.com/MASAKASUNO1/masao-cc-status-line - stars 0
1. `bin/cli.js`. Default theme: coloured "badges" (label cell + value cell). Percent badges (5h, 7d) and the context bar take colour from a continuous gradient of the usage: `gradient(pct)` green->yellow->red (r rises to 255 by 50%, then g falls; l.14-20) and `ctxGradient` (green until 50%, yellow at 85%, red at 100%; l.22-29); badge bg = that colour x0.3 (label) / x0.15 (value), fg = full colour (l.35-36); bar filled bg x0.5, empty x0.12 (l.48-49). Fixed: model per family via `styles` table Opus rose-ish (bg `80;20;40`, fg `255;140;180`), Sonnet orange (`70;30;10` / `255;170;80`), Haiku green (`15;50;40` / `120;230;180`), unknown grey (l.~345-352); dir badge yellow-brown (`50;45;20`/`230;210;120`); cost indigo; diff `+` green `100;255;100`, `-` red `255;100;100`; duration grey.
2. Themes: chosen by `argv[2]`: `default` (badges), `simple`/`simple-1`/`simple-*` (flat dark `BG 28;28;34`), `slave` (simple plus Codex/Fable usage and Claude email). Each is a hard-coded branch in `renderSimple`/main; no theme file, no user themes. Simple theme state colour `simpleStatusColor`: <=50 muted teal `110;185;165`, <=80 muted amber `195;175;105`, else muted rose `195;115;115` (l.171-175).
3. Colour spec: truecolor fg+bg only (`38;2`/`48;2`). No depth detection; NO_COLOR not present.
4. Fill: both. Default theme is background-filled badges with a tinted label cell; simple theme paints one dark bg across the whole line.
5. Separators: default has none (`S = ""`, "badge spacer none"); simple uses `│` in dim on the shared bg.
6. Neighbours: different hue per badge, plus the label/value two-tone split inside each badge.
7. Light/dark: dark-only.
8. Glyphs: emoji per model (🔮 ✨ 🍃), 📁, ⏱, `$`, arrows `↑↓`.
9. Notable: continuous colour gradient on usage, rather than 3 steps; tees rate limits into `~/.cache`; Japanese comments.
10. Customisation: single argv theme name; no config file.

## mateus-fagundes/claude-devbar
https://github.com/Mateus-Fagundes/claude-devbar - stars 0
Claude Code "mod" (function hooks, `hooks/line.tsx`, `register.tsx`) drawing a dev line with clickable buttons, not an ANSI script.
1. Host theme roles, not colours: `Text color` is one of `success`/`error`/`warning`/`claude`. Mapping in `format/meter.ts` `barColor`: <50 success, <65 warning, <80 `claude` (orange), else error; CI state `ok->success, fail->error, running->warning` (`format/ci.ts` l.95); PR review `success/error/warning/undefined`; git file codes new=green, deleted/conflict=red, others yellow (`format/git.ts` l.119-); cache time warning uses `warning`. Everything else is default text, `dimColor` for labels/separators and bold for task/worktree. Buttons are the host's `Button` (bracketed `[ label ]`).
2. Themes: not present (inherits the Claude Code theme through role names). 
3. Colour spec: theme role names only; no hex, no ANSI. Colour depth and NO_COLOR are the host's.
4. Fill: foreground only; buttons use the host's button style.
5. Separators: ` │ ` in `dimColor` (`line.tsx` `SEPARATOR`), sub-items joined by a space (`isSub`).
6. Neighbours: dim `│` only; the line flex-wraps.
7. Light/dark: inherited from host theme roles.
8. Glyphs: `█░` bar, `✓ ✗`, no Nerd Font; option to render each button group plain, without brackets (`format/options.ts` `buttonStyle`, `PLAIN_BY_DEFAULT` = compact/model/effort/project).
9. Notable: every piece is clickable (copy path, ask Claude to /compact, open git pane); PT/EN i18n.
10. Customisation: plugin `/config` options (`plain*` per button group, show* toggles, custom prompt texts, cache TTL, language).

## matthewjschultz/claude-statusline
https://github.com/matthewjschultz/claude-statusline - stars 0
1. `statusline.sh`: bars coloured by threshold: `bar()` <50 dim green `\033[2m\033[32m`, <80 yellow 33, else bright red 91 (l.71-75), used for ctx, 5hr and wk bars. Fixed: reset labels dim white; git branch magenta 35 with per-count colours (staged `S:` green, modified `M:` yellow, deleted `D:`/untracked `??:` red, renamed `R:` blue; l.103-109); dir cyan 36; model dim white; tokens/cost dim; "<no repo>" bright black 90.
2. Themes: not present.
3. Colour spec: named ANSI 16 incl. bright (91, 90) and dim modifier. No depth detection; NO_COLOR not present.
4. Fill: foreground only.
5. Separators: dim ` | `.
6. Neighbours: hue differences plus dim `|`; two lines separate usage (line 1) from identity (line 2).
7. Light/dark: not present (dim white may vanish on light backgrounds).
8. Glyphs: `▓░` bars; no emoji.
9. Notable: real usage limits from the OAuth usage API via the macOS keychain, cached 60 s.
10. Customisation: edit script.

## matwi5/mathis-plugins
https://github.com/matwi5/mathis-plugins - stars 0
Plugin marketplace (French). The statusline is `config/statusline.py`; the other plugins are mods (panels, bands: git-board, flow-board, asana-board, files-board, session-tools prompt footer) with their own SVG/hex colours, not statuslines.
1. `config/statusline.py`: fixed dir bold cyan `\033[1;36m`, model magenta 35 (`model (effort)`); three bars threshold-coloured by `_color(v)`: unknown grey 90, <50 green, <80 yellow, else red.
2. Themes: none for the statusline (catppuccin mention is from a board mod, not read in detail).
3. Colour spec: ANSI 16. No depth detection; NO_COLOR is only mentioned by the scanner in another file (`env.NO_COLOR=2`), not in the statusline.
4. Fill: foreground only.
5. Separators: plain ` | `.
6. Neighbours: hue + `|`.
7. Light/dark: not present.
8. Glyphs: emoji labels 🧠 ⏱️ 📅, `█░` bars (5%-per-block for context, 10% for limits via `step`).
9. Notable: mod boards (not statusline) in `plugins/*/hooks/*.tsx` with gradients and SVG; `session-tools` adds a prompt footer.
10. Customisation: edit script; `statusline.sh` launcher picks python3/python.

## maxichao/aiterminaldashboard
https://github.com/maxichao/AITerminalDashboard - stars 0
Rust multi-provider dashboard; Claude statusline is a secondary feature.
1. Statusline (`src/renderer/statusline.rs`): no colour at all: `Opus · repo · main* · CTX 18% · $0.42`, plain text, segments dropped by width (directory, then git, then cost). The coloured output is only the box dashboard (`box_renderer.rs`), which paints with `theme.accent` bold only (`accent()`), through `AnsiStyle::paint`.
2. Themes: 8 bundled JSON themes (default, claude, catppuccin, tokyo-night, nord, dracula, gruvbox, onedark) in `themes/*.json`, `include_str!` in `theme.rs` `bundled_theme`; format is five roles `name, foreground, accent, muted, success, warning` (hex). User themes: a path to a JSON file (`Theme::load`, relative to config). Of the five roles the box renderer uses `accent`; others read off `Theme` but not applied in the files read.
3. Colour spec: 6-digit hex, emitted as truecolor `1;38;2;r;g;b` (`ansi.rs`); ANSI toggle `enabled` (`ansi_enabled`); automatic depth detection or NO_COLOR handling: unverified (not in files read).
4. Fill: foreground only.
5. Separators: ` · ` in the statusline; box-drawing `╭─╮│├┤╰╯` in the dashboard, ASCII `+-|` when unicode is off (`box_renderer.rs` `glyphs()`).
6. Neighbours: ` · ` only.
7. Light/dark: not present.
8. Glyphs: emoji with fallbacks (`icon(emoji, fallback)`), unicode off -> ASCII box and `in `/`out `; progress bar ASCII variant (`ascii_progress`).
9. Notable: other widgets (Docker, k8s, weather) and a benchmark mode for sub-20 ms frames.
10. Customisation: `config.toml` (theme name or path), `ai-dashboard statusline --provider claude --preview`, `install`.

## maxtomachine/claude-monitor
https://github.com/maxtomachine/claude-monitor - stars 0
Mostly a session monitor TUI (`main.py`, Rich, Gruvbox Ghostty themes in `extras/ghostty/themes`); the statusline is `statusline/statusline.sh`, a 2-line HUD.
1. By state: context bar is 5-tier by used %: >=90 `CRIT` bold blink red `\033[1;5;31m`, >=80 bold red, >=75 red, >=50 yellow 33, else green 32 (statusline.sh l.147-168); the last 2 of 10 cells (the "danger zone") are drawn `▓` red / `▒` dim even when empty (l.173-188). Quota ("ammo") bar: remaining cells in a 10-shade blue 256-gradient `39 38 33 27 26 21 20 19 18 17`, spent cells dim `▯` (l.239-250). Effort: max `38;5;175` pink, high green, medium yellow, low dim. Fast mode orange 208 `⚡ fast`. Tokens/cost dim.
2. Themes: statusline none; monitor TUI ships gruvbox-custom-dark/light for Ghostty (extras), not Claude themes.
3. Colour spec: ANSI 16 + a few 256-index (208, 175, blue ramp); includes SGR blink (5) and `CRIT_BG` bold white on red defined (l.138). No depth detection; NO_COLOR not present.
4. Fill: foreground only.
5. Separators: none; fields separated by padding spaces.
6. Neighbours: whitespace and labels (`ctx`, `use`).
7. Light/dark: not present.
8. Glyphs: `█ ▓ ▒ ░ ▮ ▯`, `🧠`; uses `\033[K` erase-line after each row.
9. Notable: blinking critical state; sets the terminal tab title via OSC 2; hook-driven session state files.
10. Customisation: `~/.claude/monitor-prefs.json` `.statusline.{quota_bar,fast_mode}`; script edits.

## maxzarev/cc-statusline-pace
https://github.com/MaxZarev/cc-statusline-pace - stars 0
1. `statusline-command.sh` fixed palette (Tokyo Night, per the scanner's theme hint): red `247;118;142`, yellow `224;175;104`, green `158;206;106`, cyan `125;207;255`, blue `122;162;247`, purple `187;154;247`, gray `86;95;137` (l.16-22). Fixed: dir purple, git branch cyan with `✓` green / `✗` red, context tokens blue, model yellow (`⚡` for fast mode), reset-time labels cyan. Threshold (>60 yellow, >80 red): usage bar (`make_bar`) and 5h/7d percentage text (l.35-38, 231-232); pace forecast `→proj%` green / yellow beyond `warn_at` / red when verdict `over` or >100 (l.245-249); effort by level: medium cyan, high purple, xhigh red, else gray (l.194-198).
2. Themes: one hard-coded palette; no switch.
3. Colour spec: truecolor fg only. No depth detection; NO_COLOR not present.
4. Fill: foreground only.
5. Separators: ` │ ` gray.
6. Neighbours: hue per role + gray `│`; two lines (identity; limits and forecast).
7. Light/dark: dark-only.
8. Glyphs: `▓░` 8-cell bars, `✓ ✗ → ↑ ⚡`.
9. Notable: weekend-aware pacing forecast in `usage-pace.py` (projected % at reset and a daily ceiling).
10. Customisation: edit script; pace script flags.

## mayoral/claude-mods (statusline)
https://github.com/mayoral/claude-mods - stars 0
Claude Code mod (`statusline/hooks/register.tsx`) rendering a statusline as styled spans, themed per role.
1. Semantic palette role per cell (`register.tsx` l.74-100): `accent` model/version, `branch` git branch, `path` project dir, `note` worktree and ahead/behind arrows, `money` cost, `good` lines added and bars under 50%, `warn` bars from 50%, `bad` lines removed, dirty `*` and bars from 80%, `label`/`value`/`muted`/`track` for text and the unfilled bar. Bars by threshold: `pct>=80 ? bad : pct>=50 ? warn : good` (l.219), drawn with `━` filled / `─` track.
2. Themes: `catppuccin` (auto: Mocha on dark, Latte on light), `catppuccin-mocha`, `catppuccin-latte`, `default` (`THEME_OPTIONS`, l.26-31). Format: a `Palette` object of the 12 roles above (hex values with Catppuccin names in comments, l.116-145); `default` palette uses host theme keys and named colours (`success`, `warning`, `error`, `cyan`, `blue`). User palettes: not present beyond the four.
3. Colour spec: hex or host theme keys / named colours. Depth: host. NO_COLOR: not present.
4. Fill: foreground only.
5. Separators: not read in detail; cells are laid out as `Span` arrays per line.
6. Neighbours: role hue per cell.
7. Light/dark: yes. `paletteOf` picks Latte vs Mocha from the app's `userThemeMode` config file, then macOS `AppleInterfaceStyle`, then the Claude `theme` setting (`readAppThemeMode`, `readSystemAppearance`, l.516-548).
8. Glyphs: `━ ─` bars; no emoji read.
9. Notable: appearance detection reading the Claude desktop app setting; demo snapshot.
10. Customisation: plugin options (`theme`, layout rows, `statusLine` option) via `/config`; `plugin.json` userConfig.

## mdvcle123/power-view
https://github.com/MDVCLE123/power-view - stars 0
Mostly not a statusline: a mod suite (steps box, tools tray, agents pane, sessions, file tree). It ships one small status line, `plugins/power-view/bin/statusline` (Python), enabled from the Tools tray.
1. Statusline: fixed 256-colour: orange `38;5;208` diamond `◆` and effort value, bold model name, purple `141` for the `1M` tag, green `35` for context bar fill and output-style name, dim `245` for labels and empty cells (`bin/statusline`). Context bar `▰▱` x10 is always green (no threshold); 5h value plain.
2. Themes: none for the status line. The mods use fixed hex tables (`COLORS` in `register.tsx` l.~38-49: pink border `#e8799b`, title gradient `#f4a261 -> #ef6f8f -> #c77dff -> #7aa2f7`).
3. Colour spec: statusline 256-index; mods hex. NO_COLOR: not present.
4. Fill: statusline foreground only; mods use `backgroundColor` boxes for buttons and selected rows.
5. Separators: dim `│`.
6. Neighbours: dim `│` and an orange/purple/green accent per kind.
7. Light/dark: not present.
8. Glyphs: `◆ ▰ ▱`; mods use `▉` cells, spinner `✳ ✶ ✻ ✽`.
9. Notable: gradient progress bars (`gradient(stops, t)`, `register.tsx` l.123-135), title coloured word by word along a gradient; Orca hook passthrough.
10. Customisation: Tools tray toggles; edits to `~/.claude/settings.json` via the tray.

## meetp06/terminal-claude-mascot
https://github.com/meetp06/terminal-claude-mascot - stars 0
Statusline piece (`clawd_statusline.py`) is a pixel-art mascot; the rest (agentd, a Swift overlay, dashboard) are not statusline.
1. One fixed palette: Clawd orange `217,119,87` body, dark eyes, white ball, grey pole, orange flag (colour table l.38-45). The text label `✻ model ctx%` uses `dim` SGR only.
2. Themes: none (a `Theme.swift` exists in the macOS app, unrelated).
3. Colour spec: truecolor fg+bg (`38;2` and `48;2`). No depth detection; NO_COLOR not present.
4. Fill: both: half-block `▀`/`▄` with fg = top pixel, bg = bottom pixel (l.207-218).
5. Separators: none.
6. Neighbours: not applicable.
7. Light/dark: not present.
8. Glyphs: half blocks; 3 width tiers (label + art, art only, clipped) selected from `COLUMNS` (l.280-).
9. Notable: animation driven by `refreshInterval: 1` and a `clawd_state` file written by hooks.
10. Customisation: install script only; overlay CLI flags are not statusline.

## metaontology/claude-code-plugins (dash-statusline)
https://github.com/metaontology/claude-code-plugins - stars 0
Plugin collection; the relevant plugin is `plugins/dash-statusline` (Python; the `history` plugin viewer is not a statusline).
1. A `ColorPalette` of named roles (`theme/base.py`): `ok, warn, crit, dim, accent, highlight, orange, orange_soft, turn_label, blue, purple_red, effort, thinking, telemetry`. Context: bar of 13 `█` cells, fill colour `crit` >=90, `warn` >=70, else `ok`, empty cells `dim` (`statuses/context/__init__.py`); cost `orange`; per-turn cost `orange_soft`; labels `turn_label` periwinkle; `effort` label `effort` colour with a score suffix (low x0, medium x25, high x50, xhigh x75, max 🔥100). Git branch has no colour.
2. Themes: framework supports many (`theme/__init__.py` `_THEMES` dict, `load_theme(name)`), only `default` ships. The theme is a dataclass of ANSI strings.
3. Colour spec: mix of named ANSI (`\033[32m`, `\033[96m`), 256-index and a few truecolor (`38;2;177;185;249`, `162;216;247`). No depth detection; NO_COLOR not present.
4. Fill: foreground only.
5. Separators: plain ` | `.
6. Neighbours: separators + emoji prefixes.
7. Light/dark: not present in the statusline.
8. Glyphs: emoji per segment (🧩 🕒 🌿 🗃️ 📥 📤 🥶), `█` bar. No ASCII mode.
9. Notable: 2-line layout with per-turn token/cost breakdown; layered architecture (statuses/, views/, theme/).
10. Customisation: code-level (add a theme module); no end-user config read.

## metatronwings/claude-code-zenmux-status
https://github.com/Metatronwings/claude-code-zenmux-status - stars 0
Statusline for ZenMux subscription quota.
1. Threshold only: `utils.ts` `pctColor(rate)`: >0.80 red `\x1b[31m`, >0.50 yellow, else green; shell twin `color_pct` (>=0.80/0.50). Everything else uncoloured (tier emoji 💎🔥⭐🌱⚡, `|` separators).
2. Themes: not present.
3. Colour spec: ANSI 16. No depth detection; NO_COLOR not present.
4. Fill: foreground only.
5. Separators: plain ` | `.
6. Neighbours: separator only.
7. Light/dark: not present.
8. Glyphs: tier emoji; three display modes `full` / `bar` / `compact`; the bar is a 10-cell gradient of `█▓▒░` by fraction (`renderGradientBar`).
9. Notable: tier badge by plan; reset countdown `↻`.
10. Customisation: env `ZENMUX_PROGRESS_BAR`, `ZENMUX_COMPACT`, `ZENMUX_HIDE_7D_BELOW_70`, `ZENMUX_CACHE_TTL`, `ZENMUX_API_TIMEOUT`, `ZENMUX_NO_MODEL`; a Bash twin (`zenmux-status.sh`).

## mevanlc/xline
https://github.com/mevanlc/xline - stars 0
Rust (ratatui TUI editor + renderer); inspired by CCometixLine.
1. Fixed per component, by theme: each of 12 components (Model, Directory, Worktree, Hostname, Git, PullRequest, ContextWindow, UsageFiveHour, UsageSevenDay, Cost, Session, OutputStyle) plus Separator has `icon`, `text`, `background` colours and `text_bold` (`color_schemes/mod.rs` `ComponentColors`). E.g. Default scheme: Model 14 (bright cyan), Directory icon 11/text 10, Git/Worktree/Hostname/PR 12, Context 13, usage 14, Cost 3, Session 2, OutputStyle 6, Separator 8 (`default.rs`). No thresholds or state-dependent colour found in `render.rs`/`statusline.rs`.
2. Themes: 10 colour schemes bundled as presets (Default, Cometix, Gruvbox, Late, Nord, Minimal, Powerline Dark, Powerline Light, Rose Pine, Tokyo Night; `mod.rs` `all()`); a "theme" is a `.toml` of components saved under `~/.claude/xline/themes/` (`UserTheme`, `config/theme.rs`); schemes apply colours onto a theme (`apply_to`); icon sets are separate presets. Users create/edit their own in the TUI.
3. Colour spec: `AnsiColor` enum `Color16{c16}`, `Color256{c256}`, `Rgb{r,g,b}` (`render.rs` l.606-634); picker has tabs 16 / 256 / RGB (`tui/widgets/color_picker.rs`). Each colour keeps its authored depth; no downsampling or NO_COLOR handling found.
4. Fill: both, per scheme: Default/Minimal/Late fg-only (backgrounds `None`); Nord and Powerline Dark/Light give all 12 components a background (e.g. Powerline Dark: Model `45,45,45`, Directory `139,69,19`, Git `64,64,64`, Context `55,65,81`, usage `45,50,59`).
5. Separators: four style modes `Plain | NerdFont | Powerline | PlainPowerline` (`StyleMode`). Powerline draws `U+E0B0` between segments (plain-powerline uses `►` U+25BA) with `fg` = previous segment bg and `bg` = next segment bg (`render.rs` l.87-96); the other modes use the Separator component's glyph in its icon colour.
6. Neighbours: in powerline, background colours per scheme (two/three greys, brown for dir, etc.) and the arrow; in fg-only schemes, different foreground hues per component plus the separator glyph.
7. Light/dark: Powerline Light vs Dark presets chosen by the user; no auto-detection. Text colours are authored per scheme (white / `209,213,219` on dark backgrounds).
8. Glyphs: icon sets (`presets/icon_sets/`, `icon_catalog.rs`, TUI icon picker): plain, Nerd Font, emoji, powerline; per-model icons.
9. Notable: in-TUI theme bar and live preview, colour picker, OSC 8 PR links, worktree-aware identity, hostname suffix stripping.
10. Customisation: TUI editor, TOML theme files, `--config-dir` / `XLINE_CONFIG_DIR`, `--install-themes`.

## michael0520/cc-status-setting
https://github.com/Michael0520/cc-status-setting - stars 0
Not a statusline of its own: a setup script that installs `ccstatusline` (bunx) with a generated config, plus a rate-limit helper.
1. Fixed per widget via ccstatusline's `color` key: cwd magenta, git-branch brightRed, model white, context-percentage cyan, session-cost brightGreen, session-clock brightBlack (`setup-ccstatusline.sh` settings JSON). Helper `claude-ratelimit.sh` colours "5h: N%" / "7d: N%" by threshold: >=80 bright red `\033[91m`, >=50 bright yellow `\033[93m`, else bright cyan `\033[96m`.
2. Themes: not present (ccstatusline's own); `colorLevel: 3` (truecolor).
3. Colour spec: ccstatusline names + ANSI 16 bright. Depth/NO_COLOR: ccstatusline's, not here.
4. Fill: foreground only; `powerline.enabled: false`.
5. Separators: ccstatusline `separator` widgets; powerline separators empty.
6. Neighbours: hue per widget.
7. Light/dark: not present.
8. Glyphs: none added.
9. Notable: 5-minute cache of the Anthropic OAuth usage API.
10. Customisation: `~/.config/ccstatusline/settings.json` (ccstatusline format).

## michaeldtimpe/yet-another-statusline
https://github.com/michaeldtimpe/yet-another-statusline - stars 0
Personal fork of tmck-code/yet-another-statusline, flattened (no Nerd Font, box, gradients or sparkline in the live renderer).
1. `statusline_command.py`: many fixed slots from a `Theme` dataclass (`statusline/themes.py`): pwd, branch, commit, skills, tok, cost, ctx, model, label, dirty, arrow, etc. Three-step ladder `safe/warn/alert` via `fill_colour(pct)` (>=90 alert, >=70 warn, else safe; l.1088-1093) used for context % (as total/soft-limit), 5h and 7d %, ahead/behind arrows (warn/alert), API session cost (<$50 safe, <$100 warn, else alert; l.~1265) and branch state (clean+synced green, pending yellow, behind/diverged/detached red). Model name coloured per family (`r.model_colour`: opus/sonnet/haiku/other labels).
2. Themes: 5 bundled (`claude-dark`, `claude-light`, `catppuccin-latte`, `catppuccin-mocha`, `llmtop`); format is a flat frozen dataclass (about 25 ANSI-string slots, plus `ModelColors`, gradient stops, pill foregrounds). Selection layers: `--theme` flag > `CLAUDE_STATUSLINE_THEME` > `~/.claude/statusline-theme` > default. User-defined themes: not present (add to `THEMES`). The `llmtop` theme draws only from terminal ANSI indices 0-15 so it follows the terminal profile.
3. Colour spec: 256-index (`fg256`) and truecolor (`fg(r,g,b)`) mixed per theme. No depth downsampling; NO_COLOR not found.
4. Fill: foreground only in the live line (pill/gradient fields are "inert under the flattened renderer", themes.py comment).
5. Separators: ` · ` (`SEP`), colour from label/dim slot.
6. Neighbours: separators plus hue per slot; segments drop by priority when the line overflows (`segs` with drop priorities, path middle-ellipsis).
7. Light/dark: dedicated light themes (`claude-light`, `catppuccin-latte`, `llmtop` which uses `\033[39m` default fg for "white" so it reads on either). Pill foreground two-sided flip on luminance is defined (`pill_fg_dark/light`) but inert in the flat renderer.
8. Glyphs: no Nerd Font, "Monaco-safe": `✓ ↑ ↓`, no emoji.
9. Notable: terminal width discovered via AppleScript from iTerm2/Terminal; theme fields for gradients/sparkline/spectrogram retained from the parent; `mon.py` multi-session observer.
10. Customisation: theme file, env var, CLI flag; `make deploy THEME=...`; `~/.claude/terminal-width`.

## michaelkei/flapmind-statusline
https://github.com/michaelkei/flapmind-statusline - stars 0
1. `statusline.sh` fixed palette (256-index): header/model bold orange 208, labels `Context:`/`Session:`/`Weekly:` bold blue 31, dir blue 31, git added green 34 / removed red 160, cost pink 213 (l.8-19). Threshold in `make_bar`: >=90 red 196, >=70 yellow 220, else green 28; empty cells gray 244 (l.55-60).
2. Themes: not present.
3. Colour spec: 256-index only. No depth detection; NO_COLOR not present.
4. Fill: foreground only.
5. Separators: plain ` | ` on line 1; lines 2-4 are labelled rows.
6. Neighbours: four stacked rows with labels, plus hue per item.
7. Light/dark: not present.
8. Glyphs: emoji 📁 🌿, `█░` 20-cell bars, `↻` reset; Japanese labels in one fallback message.
9. Notable: 4-line layout; 1M-context tag appended to model name.
10. Customisation: edit script; `install.sh`.

## mightbeanshuu/cli-usage-bar-global
https://github.com/MightBeAnshuu/CLI-usage-bar-global - stars 0
Small CLI (`ai-usage-bar` / `claude-usage-bar` / `codex-usage-bar`) that prints one usage bar for a statusline or prompt, not a full statusline.
1. Whole bar one colour by threshold (`src/bar.js` `colorize`): >=90 red, >=70 yellow, else green; label and percentage uncoloured.
2. Themes: `--theme blocks|ascii|dots` selects glyphs, not colours (`█░`, `#-`, `●·`).
3. Colour spec: ANSI 16. NO_COLOR is honoured: colour default is `stdout.isTTY && !process.env.NO_COLOR` (`cli.js` l.150); `--color` forces, `--no-color` disables.
4. Fill: foreground only.
5. Separators: none (`label [bar] N%`).
6. Neighbours: not applicable.
7. Light/dark: not present.
8. Glyphs: ASCII fallback (`ascii` theme) and dots theme.
9. Notable: reads Claude Code's statusline JSON or Codex rate-limit JSON from stdin; also `--json`.
10. Customisation: CLI flags `--width`, `--label`, `--provider`, `--window`, `--theme`, `--color/--no-color`, env `AI_USAGE_PERCENT`.

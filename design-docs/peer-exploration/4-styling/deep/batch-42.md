## aigentry-devkit
https://github.com/dmsdc-ai/aigentry-devkit (stars 0). A dev-environment installer bundle; its only statusline is `hud/simple-status.sh`.
1. By state, one colour for the context cluster: `hud/simple-status.sh` picks `COLOR` from context % (>=85 red `\033[31m`, >=70 yellow, else green) and applies it to the bar fill and the "NN% used/total" text. cwd and model are uncoloured; the optional `PSM:<session> [branch]` suffix is fixed cyan `\033[36m` (yellow for the "N notif" count).
2. Themes: not present.
3. ANSI 16 only (31/32/33/36, dim 2). No depth detection, no NO_COLOR.
4. Foreground-only.
5. Plain ` | ` separators, uncoloured.
6. Neighbours told apart by the `|` separators only.
7. Not present.
8. Block glyphs `█`/`░` bar; no icons.
9. Nothing else.
10. No config; edit the script. Hook wiring via installer (`install.sh`, `bin/aigentry-devkit.js`); README has a `hud` entry with a `script` path.

## context-lens
https://github.com/Dousea/context-lens (stars 0). Not a plain text statusline: a Claude Code desktop/terminal "mod" (plugin using the `claude-code` mod API) that draws a band above the prompt (effort picker plus a lens row `● 38m │ ctx ███░ 152k/250k │ 5h ████ 46% 2h14m │ 7d …`). It is a fork of HeyCubit/effortless. Documented because it styles a status row.
1. By state/threshold, via Claude Code theme keys: `hooks/model.ts:256` `fillColor(fraction)` = >=0.85 `error`, >=0.65 `warning`, else `success`; `BUFFER_COLOR='warning'` (`model.ts:106`) for the autocompact buffer; each context category keeps its `/context` colour. Cache timer colour follows `Warmth` (warm/expiring/cold/uncached, `model.ts:25`). Signals fixed: `ICE/BOG/EMBER/SLATE` families per alert-band kind (cold, swamp, hot, down) in `hooks/core/palette.ts`, each with `_BG`, `_EDGE`, `_LIGHT` shades (e.g. `EMBER '#f08a3c'`, `EMBER_BG '#1a110c'`, `EMBER_EDGE '#6a3418'`).
2. Themes: 4 accent themes `cyan | violet | orange | rose` (`hooks/theme.ts:7`). Format: one brand violet `#a79cf7`; `tintHex()` rotates any violet-hued `#rrggbb` (h 235-300, chroma>=0.03, s>=0.15) to the theme's hue (`HUES = {cyan:182, orange:15, rose:340}`) keeping lightness/saturation roughly; neutrals and signal colours untouched. No user-defined themes.
3. Truecolor hex for its own SVG art and `<Text color>` hex; Claude Code theme keys (`success`, `warning`, `error`) for bar fill. `THEME_KEY_HEX` (`palette.ts`) maps keys to hex for SVG (success `#7fe0a4`, error `#e5534b`, claude `#d77757`, planMode `#48968c`...). No depth downsampling; host renders.
4. Both: panels have `backgroundColor` + round `borderColor` (`DASH_BG '#141416'`, `DASH_EDGE '#2a2a2f'`, `BRAND_BG '#15121f'`); the lens row itself is text/SVG on the panel.
5. Box-drawing `│` between lens-row cells; no powerline.
6. Neighbours: `│` separators and distinct bar widgets; alert bands differ by hue family.
7. Yes, light/dark: `lightHex(hex, role)` (`theme.ts`) converts the dark-designed palette for light apps, text role lowered in lightness until >=4.6:1 against `PALE_REF '#e3e0ed'` (`theme.ts` `luminance` loop), surfaces made near-white; `refreshAppearance` (`palette.ts`) reads Claude Code's own `/config` theme row (starts with `light`) every 4 s and redraws.
8. Block glyph bars (`█░`), pie/ring SVG glyphs, drawn scene art (frost, ember, swamp, down); no ASCII fallback mode.
9. Notable: animated bokeh/petal scene art per alert band, a "glow" on switch (`FLASH_COLOR`), hover colours (`CARD_HOVER`), settings panel UI inside Claude Code.
10. Settings panel (`/context-lens settings`), slash commands; config in plugin settings (`hooks/core/config`). Theme name is one setting.

## ccstatusline-editor
https://github.com/dpc00/ccstatusline-editor (stars 0). A Flask web editor that reads/writes ccstatusline's `~/.config/ccstatusline/settings.json` (`app.py:10`). Not a renderer; it sets per-widget `color` fields that ccstatusline renders.
1. By group via scheme: each widget's `color` is set from its group (`templates/index.html:842` `if (group && scheme.colors[group]) widget.color = scheme.colors[group]`). 12 groups in `app.py` `GROUPS`: AI, Context, Session, Tokens, Speed, Usage, Git, Git Origin, Worktree, Jujutsu, System, Custom (widget catalog of 89 types each tagged with a group). Example scheme: Ocean = AI cyan, Context blue, Session green, Tokens cyan, Speed blue, Usage yellow, Git blue, System white. Result is a fixed colour per widget group.
2. 68 colour schemes (`app.py:~285-360` `SCHEMES`, `scheme()` helper) incl. Ocean, Forest, Fire, Dracula, Nord, Gruvbox, Monokai, Tokyo Night, Catppuccin, One Dark, Solarized, Monochrome, Zen, Minimal ("only AI and Git stand out"), Cost Alert, Danger/Warning/Safe, Spectrum ("rainbow, each group its own hue"). Format: map of 12 group -> colour name. Names are mood names, not exact palettes. Users can edit a widget colour individually in the UI.
3. Only 8 names: `COLORS = ["black","red","green","yellow","blue","magenta","cyan","white"]` (`index.html:295`), mapped to preview hex via `COLOR_HEX`. Depth handling belongs to ccstatusline.
4. Foreground colour per widget in this tool's data model; background not set by schemes (unverified for ccstatusline powerline mode).
5. Separator widget types `separator`, `flex-separator`; "Auto-separators" button inserts a chosen character between widgets (README). No colour selection for separators found.
6. Distinct hue per group in rainbow-like schemes, or identical hue in mono schemes; nothing else.
7. Not present.
8. Per-widget options include Nerd Font toggles (e.g. `compaction-counter` `nerdFont`, `app.py`), custom symbols; no ASCII fallback mode in editor.
9. 30 widget presets, drag-and-drop layout, live preview, Ctrl+S save.
10. Flask web UI on :5199, `--config PATH`; output file is ccstatusline settings.json.

## ccstatusline-editor-node
https://github.com/dpc00/ccstatusline-editor-node (stars 0). A Node port of the same editor (`index.js`); the 68 `COLOR_SCHEMES` (`index.js:113`) are the same table as the Python version (same group-to-colour mapping, names and descriptions), `w(type, color)` writes `{type, color}` widgets (`index.js:184`). README is missing (404). Points 1-10 as for ccstatusline-editor: 12 groups, 8-name colour set, foreground colour per widget, config at the ccstatusline settings path, scheme chosen in a web UI. Only difference seen: implementation language and server.

## cc-usage-statusline
https://github.com/drebin573/cc-usage-statusline (stars 0). Two-line statusline, `statusline-command.sh`.
1. Fixed per segment with threshold on the context bar: cwd muted_blue 256-67, context bar muted_cyan 73, 5h bar muted_magenta 133, 7d bar muted_orange 173, branch muted_green 71, repo link muted_teal 109, cost muted_gold 178, session time dim (`statusline-command.sh:61-68`, `:250`). Context bar turns past 50%: `>=50` gold 178, `>=75` orange 208, `>=90` red 196, applied per character from the 50% mark onward (`context_bar`, `:148-210`). 5h/7d bars are one fixed colour.
2. Themes: not present.
3. 256-colour indices (`38;5;N`, bg `48;5;238`). No detection, no NO_COLOR.
4. Mostly foreground; the bar's empty track and fractional-block gaps use a bg `48;5;238`.
5. `·` separator in grey 238 (`sep_color`) on the repo/branch line; values on line 2 are centred under their bars.
6. Distinct muted hues per field; line 2 values align under line 1 bars.
7. Not present.
8. Block glyphs (`█`, eighths) for bars, OSC-8 hyperlink on repo name; no emoji or Nerd Font.
9. Fractional-eighths bars with background-filled gaps; right-aligned bars via `align_lr`.
10. No config; edit the script. `install.sh`.

## simple-statusline
https://github.com/Drizzy07x/Simple-statusline (stars 0). PowerShell 7 powerline-chips statusline for Windows Terminal, `statusline-powerline.ps1`.
1. Role-based accent, by segment and by state: each widget is a chip on one `Surface` background whose accent only colours its icon: model `Accent`, dir `Dir`, branch `Git`, worktree `Info`, effort/session `Time`, cost `Cash`, lines `Info`, tokens in `Info`, out `Warn`, total `Dir`, cache `Cache`/`Info` (`:408-612`). Threshold: `Heat(pct)` = >=90 `Bad`, >=75 `Hot`, >=50 `Warn`, else `Good` for context and 5h/7d limits (`:216`); cache hit is inverted (>=80 Good, >=50 Warn, else Hot). At `$AlertAt`=90% the whole chip floods with the accent and text flips to dark `Base` (`Render-Pill`, `:268`). Value text stays neutral `Text`; names in `Label` grey. Design comment states "when colour appears in the background, it means something."
2. Themes: 4 (`onehalf`, `mocha`, `tokyonight`, `nord`) in `$Palettes` (`:46-80`). Format: a semantic palette per theme with roles `Base, Surface, Text, Dim, Label, Accent, Dir, Git, Info, Good, Warn, Hot, Bad, Cash, Time, Cache, Add, Del`. Choose via `$env:CC_STATUSLINE_THEME`; no user-defined themes except editing the table.
3. Truecolor only (`38;2;r;g;b`/`48;2;...`); no depth detection, no NO_COLOR.
4. Background-filled chips: surface bg, plus accent-bg alert chips; text on dark base.
5. Rounded caps U+E0B6/E0B4 (Nerd Font) around each chip; chips are spaced by blank gaps (`$WidgetGap`=3, `$GroupGap`=7 between subject groups), not chained with arrows. Cap colour = the chip's bg colour. `CC_STATUSLINE_STYLE=plain` replaces with ` | `.
6. Neighbours told apart by whitespace gaps and by group spacing (comment `:11-17` explains that one-cell gaps read as one ribbon, so 3 cells; groups at 7); all chips share one surface colour; accent only on the icon.
7. Contrast-aware by design: comments state surface must lift off terminal bg, `Add/Del` colours chosen to clear AA 4.5:1 on all four surfaces, value kept white since saturated accent on Surface only reaches ~3.5:1; palettes calibrated to Windows Terminal One Half Dark (#282C34). No runtime light/dark detection.
8. Nerd Font icons required for `powerline` style (all below U+FFFF deliberately, `:~118`); `plain` style drops icons.
9. Width-aware priority dropping (priority 1-3 widgets, `Limit-Visible`), three rows with row spacing, git cache.
10. Env vars `CC_STATUSLINE_THEME`, `CC_STATUSLINE_STYLE`, `CC_STATUSLINE_COLUMNS`; knobs at top of script (`$WidgetGap`, `$GroupGap`, `$BarWidth`, `$AlertAt`, `$ShowLabels`).

## terminal-claude-mascot-windows
https://github.com/drsnsoni/terminal-claude-mascot-windows (stars 0). A pixel-art "Clawd" crab mascot; `clawd_statusline.py` is a statusline that animates the crab (plus an overlay app and a Swift-based dashboard `PetOS`). Styling is sprite rendering, not segment colouring.
1. No segments coloured; the sprite pixels come from a letter-to-RGB table `COLORS` in `clawd_scenes.py:14` (`O` Clawd orange `(217,119,87)`, `D` eyes, `W` ball, `Y` `(245,200,80)`, `B`, `G`, `R`...). The text label is coloured with `ORANGE`.
2. Themes: not present in statusline (a `Theme.swift` exists only in the separate PetOS dashboard app).
3. Truecolor `38;2;r;g;b` / `48;2;...` only (`clawd_statusline.py`); no depth detection, no NO_COLOR seen.
4. Both: half-block `▀` with fg = top pixel and bg = bottom pixel (docstring), `▄` variants.
5. Not present.
6. N/A.
7. Not present.
8. Half-block pixel art 8 px tall packed into 4 terminal lines; spinner glyphs `· ✢ ✳ ✶ ✻ ✽`.
9. Animation: frame chosen from wall clock, 1 s `refreshInterval`; scenes (walk, football, flag, ninja, confetti); hook-written `~/.claude/clawd_state` switches working/idle blink.
10. CLI flags `--action`, `--no-art`; installers (`install.sh`, `install.ps1`, `install_windows.py`).

## claude-code-statusline (DrStr4Nge147)
https://github.com/DrStr4Nge147/Claude-Code-Statusline (stars 0). A PowerShell installer (`install-statusline.ps1`) that embeds a bash script.
1. Fixed per segment plus threshold: folder bold bright-cyan, "on" grey, git branch bright-yellow, model bright-magenta, labels `ctx`/`5h`/`7d` grey 90 (`install-statusline.ps1:~203-257`). Context bar and percent: >=80 bright red, >=50 bright yellow, else bright green. Rate limit: percent colour same thresholds; time-remaining colour is inverted by `five_pct`/`seven_pct` (>96 green, >80 yellow, else red).
2. Themes: not present.
3. ANSI 16 incl. bright (`\033[91m`...). No detection, no NO_COLOR.
4. Foreground-only.
5. Grey `|` (`SEP="${FG_GRAY}|${RESET}"`).
6. Hues per segment, `|` separators.
7. Not present.
8. 12-wide `█░` bar; no icons.
9. Nothing else.
10. No config; installer writes the script and settings.json `statusLine`.

## dsgarage/claude-code-statusline
https://github.com/dsgarage/claude-code-statusline (stars 0). A set of 12 alternative scripts under `scripts/` (minimal, compact, standard, standard-color, full, full-color, progress-bar, multiline, cost-tracker, tokens-detail, git-focused, rate-limit).
1. By state, not per segment: `full-color.sh`: the context colour (0-49 green, 50-79 yellow, 80+ red) colours both the `[Model]` tag and the context %; cost green <$1, yellow <$5, red above; 5h/7d percent same 50/80 thresholds; branch fixed cyan; `+N` green, `-N` red (`full-color.sh:44-87`). `standard-color.sh` colours `[Model]`, Context % by context state. `progress-bar.sh` colours the bar by the same thresholds. `minimal.sh`, `standard.sh` (0 escape codes) are uncoloured; `multiline.sh` has 5 escape uses, not read in detail.
2. Themes: not present.
3. ANSI 16 (`\033[32m` etc.). No detection, no NO_COLOR.
4. Foreground-only.
5. Plain ` | `.
6. ` | ` separators; hue per metric in the full variant.
7. Not present.
8. Block bar in `progress-bar.sh`; no icons.
9. Variant choice at install time (`install.sh`).
10. Pick a script; edit thresholds in the script.

## claude-usage-statusline (dsqdqsds fork)
https://github.com/dsqdqsds/claude-usage-statusline (stars 0). Fork of webkubor/claude-usage-statusline. I diffed `scripts/statusline.py` and `install.sh` byte for byte against the parent at HEAD: identical, so no styling differences found in these two files. For reference, the shared styling: by threshold, a theme ramp keyed by usage `pct` (`THEMES`, 3 themes `default` sage-amber-coral, `cool` teal-indigo-magenta, `mono` luminance-only, each `[(pct, (r,g,b)) ...]` stops at 0/55/80/100) interpolated per bar cell via `ramp()` (`statusline.py:50-106`); unfilled half uses `shade()` same hue dimmed; theme picked by `$USAGE_STATUSLINE_THEME` or `~/.claude/statusline/theme`; truecolor only when `COLORTERM` is `truecolor`/`24bit` (`:45`) otherwise 3-stop ANSI `BASIC` (32/33/31 at 0/55/80); honours `NO_COLOR` (swaps `▓░` for coloured `█`); label colour fixed cyan `\033[36m` (`:377`); foreground-only.

## status-bar-claude
https://github.com/dt-florian-beaumont/status-bar-claude (stars 0). `statusline-command.sh`.
1. Threshold on the 3 bars, fixed elsewhere: dir bold white, model white, branch green, labels `ctx/5h/7d/reset` dim, percents white. Bar colour (`build_bar`, line ~34): >=90 bold red, >=75 red, >=50 yellow, else cyan; empty cells dim (`:25-47`).
2. Themes: not present.
3. ANSI 16 (`\033[0;37m`...). No detection, no NO_COLOR.
4. Foreground-only.
5. Two-space gaps, no glyph.
6. Whitespace plus the dim labels; hue differences between dir/branch/model.
7. Not present.
8. `▊` glyph for bar cells; none else.
9. Branch is truncated to fit `tput cols` width.
10. No config; edit script, `install.sh`.

## oh-my-zsh-claude-code-statusline
https://github.com/dumkoder/oh-my-zsh-claude-code-statusline (stars 0). An installer that detects your oh-my-zsh `ZSH_THEME` and generates a statusline mimicking it (`install.sh`).
1. Per-profile mapping. Powerline profiles: segment bg/fg pairs by index. `powerlevel10k`: user 238/180, dir 31/231, git 2 (fg 0 clean, 3 dirty), model 238/180, ctx 236/137 (fg 203 when ctx>=80). `agnoster`: user 240/231, dir 31/231, git bg 148 (fg 166 dirty), model 240/231, ctx 234/245 (fg 203 hot) (`install.sh:123-139`). `spaceship`: dir cyan(6) bold, branch magenta(5), dirty red(1), model blue(4), prompt `➜` green (`:210-226`); ctx bar green <60, yellow <80, red. `robbyrussell` arrow: `➜` green, dir cyan, `git:(branch)` green or yellow when dirty, model magenta, ctx grey. `minimal`: no colour.
2. Themes: 6 profiles `spaceship | powerlevel10k | agnoster | robbyrussell | pure | minimal`; format: bash variable blocks per profile (bg/fg 256 indices); user switches `THEME_PROFILE` in `~/.claude/statusline.conf`. Auto-detected from `~/.zshrc`.
3. 256-index (`38;5;N`/`48;5;N`) plus a few 16-colour codes. No detection, no NO_COLOR. Nerd Font presence detected at install (`has_nerd_font`, `fc-list`/Fonts dirs) to warn.
4. Both: background-filled segments in powerline/agnoster; foreground-only otherwise.
5. Powerline arrow U+E0B0; arrow's fg = previous segment bg, bg = next segment bg (`arrow()`, `:147-153`); end arrow on default bg (`\033[49m`).
6. Powerline: different bg colours per segment (dir blue-ish 31 vs user grey), arrows; nothing automatic.
7. Fixed fg per profile chosen by hand (e.g. black on green git); no detection.
8. Nerd Font `` branch icon and arrows; falls back to non-powerline profiles; `➜`, `✗`, `●`, `✓` unicode.
9. Mimics your terminal prompt's look.
10. `~/.claude/statusline.conf` (`THEME_PROFILE`), env var override at install.

## claude-context-widget
https://github.com/dustinJ15/claude-context-widget (stars 0). A Windows desktop widget plus a small CLI statusline (`statusline/statusline.js`, `context-lib.js`, `widget/widget.ps1`).
1. By threshold on absolute tokens, one segment coloured: the whole `165K (82%)` context chunk is green below 50K tokens, yellow >=50K, red >=100K (`context-lib.js:7` `THRESHOLDS`, `ANSI = {red:31, amber:33, green:32}`, `statusline.js:51-58`). Branch, model, effort are uncoloured.
2. Themes: not present.
3. ANSI 16 in the CLI. Widget uses hex band colours `green #1E7D34`, `amber #B7791F`, `red #B00020`, `idle #3A3A3A`, white text (`widget.ps1:40`). No detection, no NO_COLOR.
4. CLI: foreground-only. Widget: filled band.
5. CLI uses two-space `·` separators, uncoloured.
6. Separators only.
7. Widget comment: "White text reads on all of them" (bands picked for white text contrast).
8. None.
9. Shared threshold lib so widget and CLI agree on the 100K "dumb zone".
10. Edit the constants in `context-lib.js`.

## my-cli-config
https://github.com/dutykh/my-cli-config (stars 0). Dotfiles repo; the relevant file is `claude/statusline-command.sh`, a 3-line "high-tech" statusline.
1. By role and state: line 1 is powerline pills with fixed bg per segment: model `navy`, dir `blue`, git `sky` (clean) / `orange` (dirty) / `verm` (conflicts), PR `sky` approved / `verm` changes-requested / `steel` draft / `orange` otherwise, env `azure`, repo `steel` (`:~245-290`). Line 2 is a HUD strip on a dark bg: context/limit gauges coloured by `pct_col` (>=85 `verm`, >=60 `orange`, else `sky`); warm cache sky, cold orange; `+N` green, `−N` verm. Line 3 is system info.
2. Themes: `THEME=auto|light|dark` (two); palette is a fixed Okabe-Ito set (`declare -A RGB`, names navy, blue, azure, sky, ice, steel, deep, frost, green, orange, verm, yellow, amber, brick, ink, paper, mist, gray, white); user config `~/.claude/statusline.conf` (bash) overrides knobs, not palette.
3. Truecolor with 256-colour fallback: `TC=1` when `COLORTERM` truecolor/24bit, Zed or Warp; otherwise parallel `IDX` table of xterm-256 indices (`:127-140`). No NO_COLOR.
4. Both: bg pills on line 1, HUD bg `deep`/`deep2` on line 2, fg elsewhere.
5. Pills joined by `SEP_M`, edges `SEP_L`/`SEP_R`: Nerd Font powerline glyphs, or `▐ ▐ ▌` half blocks in emoji/unicode modes. Separator colours: fg = previous pill bg, bg = next pill bg (`seg()`, `:~205`).
6. Different bg per pill (navy -> blue -> sky/orange -> azure -> steel) plus the powerline joins; colour-blind-safe palette chosen so semantic states differ in lightness as well as hue.
7. Yes. `THEME=auto` reads Claude's `theme` from `settings.json`/`.claude.json` (`light*`/`dark*`), else `COLORFGBG`; light theme uses a darker `deep` HUD bg and `val_col()` swaps text colours sky->blue, orange->amber, verm->brick for plain text on light terminals; pill text `ink` or `white` chosen per bg by hand (`gfg`).
8. `ICONS=auto|nerd|emoji|unicode`; auto detects an installed Nerd Font (fc-list, Fonts dirs, Zed settings, cached hourly) else emoji; each mode has own icon table and gauge glyphs (`━╌` / `▰▱`).
9. Responsive tiers by `$COLUMNS` drop segments; `--demo [nerd|emoji|unicode] [cols]` preview mode; `docs/ansi2png.py` and `docs/make-previews.sh` generate screenshots.
10. `~/.claude/statusline.conf` (bash; ICONS, THEME, LINES, SHOW_*, GAUGE_W...), `CLAUDE_STATUSLINE_CONF` env, `--demo` flag.

## claude-statusbar
https://github.com/dveleztx/claude-statusbar (stars 0). `statusline.sh`.
1. Fixed per segment, threshold on context: model bold purple `\033[1;35m`, cwd bold blue, git branch bold green, session time dim (black in light theme). Context gauge colour: <=50 green, <=74 yellow, <=90 orange (256-208), else red (`:40-45`).
2. Themes: not present (reads Claude's theme only for one colour).
3. ANSI 16 bold plus one 256 index (208). No detection, no NO_COLOR.
4. Foreground-only.
5. Dim ` | `.
6. Different hue per segment; dim separators.
7. Minimal: reads `.theme` from `~/.claude/settings.json`; if `light`, the session-time part uses black instead of dim (`:16-18`).
8. Nerd Font icons for branch and folder (private-use glyphs, rendered as `` in source), 20-block gauge.
9. Nothing else.
10. No config; edit script.

## cc-stat-bar
https://github.com/dyx/cc-stat-bar (stars 0). Node script `cc-stat-bar.js` rendering pills and filled progress bars.
1. By state for bars, neutral for the rest: `pill(text)` paints model/workspace/cost+duration all with one `THEME.default` bg/fg; context and 5h/7d limits are `progressBar()`s whose filled colour comes from `progress.thresholds` (dark: <=50 `#A3BE8C` green, <=80 `#EBCB8B`, <=100 `#BF616A`; text `#E0E0E0`), unfilled part = same colour scaled by `unfilledBgFactor` 0.3 (dark) / 0.5 (light) (`:12-43`, `:119-130`).
2. Themes: 2, `dark` and `light`, selected with `--theme <name>`; format `{ default:{bg,fg}, progress:{unfilledBgFactor, unfilledFg, thresholds:[{max,bg,fg}]} }`; the file says "add custom themes to THEMES below" (edit the source).
3. Truecolor only (`\x1b[48;2;r;g;b m`); no detection, no NO_COLOR.
4. Background-filled pills and bars (text inside the fill; progress is filled by cell with bg change at the percentage point).
5. Plain two-space gap between pills; `\x1b[K` to clear the line. No arrows.
6. Neighbours: each pill is a flat default bg block separated by spaces; bars differ from pills by their state colour.
7. Manual only: `--theme light`, with a different set of hex values and text colours (`#F8F8F8` on darker greens/golds).
8. None (a CJK-aware `strWidth` handles wide chars).
9. Bar cell-level fill that carries the text label inside the bar.
10. CLI args `--theme <name>` plus module names (`context rateLimits cost model workspace`) selecting and ordering segments.

## capywork
https://github.com/E-JIWON/capywork (stars 0). Not a Claude statusline: a macOS menu-bar app (Swift, `Sources/CapyWork/Panel/Theme.swift`); its `scripts/statusline.sh` prints nothing and only stashes `rate_limits` JSON to `~/.capywork/limits.json` for the app.

## tokenometro
https://github.com/eacp1991/tokenometro (stars 0). `statusline/tokenometro.sh` (plus token-saving hooks in `savings/`).
1. By state on the 5h rate: one colour `C` for the 20-cell bar: >=80% red `\033[31m` with 🔴, >=60% yellow with 🟠, >=40% yellow with 🟡, else green with 🟢 (`:117-121`). Other fields (`wk`, `window`, `tok`, `cache`) uncoloured; a yellow `⚠ compactar` tag when `ECONOMY_MODE` and context >= threshold (`:126`).
2. Themes: not present.
3. ANSI 16. No detection, no NO_COLOR.
4. Foreground-only.
5. Plain ` | `.
6. Separators only.
7. Not present.
8. Emoji status dots and `█░` bar.
9. A "savings" hook family is not styling.
10. Edit script; installer.

## claude-cli-status-line
https://github.com/eccs0103/claude-cli-status-line (stars 0). TypeScript, config-driven (`resources/data/status-line.config.json`).
1. Fixed per segment from config and by threshold: `DirectorySegment` cyan (bold), `BranchSegment` magenta, `ModelSegment` blue (config `color` per segment, `status-line.config.json`); `SevenDay/FiveHour/Context` segments are bars coloured by `Thresholds.color(available)`: `<= alert(10)` red, `<= warn(30)` yellow, else green (note: based on *remaining*, `settings.ts` `Thresholds`); cache countdown dim, "cold" red (`status-line.ts:56`).
2. Themes: not present. Each segment's `color` is one of 7 names `cyan magenta blue green yellow red white` (`Color` enum, `settings.ts`).
3. ANSI 16 (30-37 codes) plus bold/dim (`color-system.ts`). No detection, no NO_COLOR.
4. Foreground-only.
5. Dim glyph between segments (`status-line.ts:14`, dim-painted separator).
6. Hue per segment from config; dim separators.
7. Not present.
8. Bar glyphs configurable (`bar.filled`/`bar.empty`, default `█░`, width 10); a `#` marker after the gauge.
9. `time_format` `clock` or `fractional`.
10. JSON config file with `$type`-tagged segment list (enable/disable, order, colours, thresholds, bar), loaded via `configuration-controller.ts`.

## ed1sonl1-byte/claude (token-flame statusline)
https://github.com/Ed1sonL1-byte/claude (stars 0). Node statusline `src/statusline.js` (cost-focused, Chinese labels).
1. Themed single accent, rest grey: `[Model]` bright-grey `\x1b[0;90m`; the session, today, week cost segments all use `theme.active`, total uses `theme.total` (grey) (`:558-585`).
2. Themes: 4 (`fire` red 31, `ocean` cyan 36, `forest` green 32, `golden` yellow 33), `THEMES = {active, total}` (`:44-49`); the color table `C` also defines orange 208 and fire 196. Chosen by `theme` in `~/.claude/token-flame-config.json` (default `fire`, merged over `DEFAULT_CONFIG`). Users can't add a theme without editing the source.
3. ANSI 16, two 256 indices. No detection, no NO_COLOR.
4. Foreground-only.
5. Plain ` | `.
6. One hue for all active parts, grey for model/total; separators.
7. Not present.
8. Emoji 🔥 and 🪙 style; Chinese labels.
9. Burn-rate flag option `show_burn_rate`.
10. JSON config `token-flame-config.json` (`theme`, `show_burn_rate`, `show_total`, `show_week`).

## zstheme
https://github.com/edari-bridge/zstheme (stars 0). A theme manager with an interactive Ink TUI (`bin/zstheme.js`, `src/components/ThemeSelector.js`, `ColorEditor.js`) over a bash/Node renderer.
1. Fixed per element in default (pastel) mode, with context-driven brightness: icon colours are fixed 256/ANSI values (`themes/_modules/colors/base_colors.sh`: branch bright yellow 93, tree 92, dir 96, model 95, status 256-111, sync 141, rate 229, burn 216, time 75). Text colours change by `CONTEXT_PCT`: <50 normal (`C_BRANCH` `\033[1;33m`...?), >=50 mid-bright (ctx 256-208), >=70 bright/bold (ctx `1;91`, with 🔥 icon) (`colors/pastel.sh`). Context battery icon: 🔋/🪫/🔥 at <50/>=50/>=70. Mono mode: grey ramp 255/250/245/240/236. Custom mode: user-picked.
2. Themes: a combinatorial name = colour mode x animation x layout x icon (`src/utils/themeContract.js`): colours `pastel`, `mono-`, `custom-`; animations static, `rainbow-`, hidden `lsd-` (and `p.lsd`); layouts `1line, 2line, badges, bars, card`; icons emoji / `-nerd`. Users define colours via the Color Editor (`custom-`): foreground per element `FG_DEFAULTS` (Branch, Worktree, Directory, Status, Sync, Model, Rate, Time, Burn) and background per element (badges) or per group (bars: `C_BG_LOC` 23, `C_BG_GIT` 24, `C_BG_SES` 53) stored in a user colours file (`src/utils/colors.js`).
3. 256-index colours (`38;5;N`/`48;5;N`) and 16-colour codes; animation palettes use truecolor 60-step RGB tables (`src/renderer/palette.js`: `RAINBOW_COLORS` pastel sine, `LSD_COLORS`, `MONO_CYCLE`). No detection, no NO_COLOR seen.
4. Both: `badges` and `bars` layouts fill backgrounds (badges: darkened version of the element colour, e.g. branch fg yellow -> bg 58; bars: one bg per group); `1line`/`2line` fg-only; `card` boxed with grey chip border 240.
5. Chip/box borders (`C_BOX` 240, `C_CHIP` 245); no powerline arrows seen; separators in 1line/2line plain.
6. By group background in `bars` (location teal, git blue, session purple, with a mono variant "brightness difference maximised": 239/237/233) and per-element backgrounds in `badges`.
7. Not present beyond hand-tuned dark bgs.
8. `emoji` and `nerd` icon sets (`src/utils/colors.js` `ICONS`), picked by theme suffix; ASCII not present.
9. Strong: animated rainbow/"LSD" colour cycling via the 60-colour tables (refresh-driven), unlockable hidden theme, theme explorer screenshot, interactive previews.
10. Ink TUI (`zstheme` command), theme string in a config (`CLAUDE_THEME=` in a themeConfig file or env var `CLAUDE_THEME`, default `2line`), custom-colour editor, 5 layouts x 3 colour modes x icon.

## claude-castle-mod
https://github.com/eddywong888/claude-castle-mod (stars 0). Not a text statusline: a Castlevania-style SVG HUD mod above the prompt in Claude Code's desktop app (`hooks/hud.ts`, `svg.ts`, `register.tsx`), with XP/achievements. Styling noted briefly: palette `LIGHT`/`DARK` CSS-variable sets (`svg.ts:21-22`, ink, stone, gold, blood, ...), `mode: 'auto'` follows `prefers-color-scheme` (`:341`); the context "blood meter" is 20 cells and the number turns gold from 60%, red from 85% (README); the castle art grows bolder and catches fire as cache runs down; fire colours `#ffd84a #ff8a1f #d8261c`. Fonts bundled via `fonts/build.py`. No user theme format.

## edlsy/claude-statusline
https://github.com/edlsy/claude-statusline (stars 0). Portable truecolor installer `install.sh` embedding the script.
1. Fixed per segment + threshold + enum: repo name bold yellow `(255,210,0)`, branch bold cyan `(0,210,220)`, cost yellow, `+N` green `(0,200,80)`, `-N` red `(220,40,20)`, output style light purple `(200,150,255)`, thinking `(180,140,220)`, model bold magenta `(200,80,220)` (`install.sh:61-240`). Context %: <20 green `(0,220,80)`, <70 yellow, <90 orange, else red; 5h/7d use 50/80/95 cut-offs. Effort enum: low grey, medium cyan, high orange, xhigh `(255,100,50)`, max red. Permission mode (risk semantics): default grey "ask", acceptEdits green, plan blue, auto orange, bypassPermissions red "yolo" (`:176-218`).
2. Themes: not present.
3. Truecolor `38;2` only (`rgb()` helper; script requires 24-bit terminal); no detection, no NO_COLOR.
4. Foreground-only.
5. Dim grey `|` (`PIPE`).
6. Different hue per segment; `|`.
7. Not present.
8. Minimal text.
9. State-keyed colours for effort and permission mode are the standout.
10. Edit script; installer.

## claudio
https://github.com/eduardoborges/claudio (stars 0). Fork of HermannBjorgvin/Clawdmeter. Not a Claude statusline: a desk display (ESP32-S3 AMOLED firmware plus macOS/Linux/Windows feeding app) for usage limits and sessions. Differing styling: terracotta design tokens from Anthropic's design system in `firmware/src/theme.h` (`THEME_ACCENT 0xd97757`, `THEME_ALERT 0xc6613f` near limit, `THEME_BG` black for AMOLED), the Mac app follows system light/dark (`mac/Sources/Claudio/Theme.swift`: bar = accent, alert at >=80%).

## ccbar
https://github.com/egg-/ccbar (stars 0). Minimal Python statusline `ccbar.py` (plus an Astro docs site, whose theme toggle is website-only).
1. By threshold: `severity(pct)` = >=85 red, >=60 yellow, else green (`WARN, CRIT = 60, 85`, `ccbar.py:21,32`), used for the 5h and 7d bars and for the context % after the model name. Labels and cost dim; model name uncoloured.
2. Themes: not present (README points to a fuller project for themes).
3. ANSI 16 (31/32/33, dim 2). No detection, no NO_COLOR.
4. Foreground-only.
5. Dim `│` (`" │ "` join, line 116).
6. Separators.
7. Not present (docs site only).
8. 5-cell bar; `$` cost.
9. Nothing else.
10. Thresholds are module constants (`WARN`, `CRIT`, `BAR_WIDTH`), edit and go; a self-test asserts `severity`.

# Batch 66: styling deep-dive

Anchors are file paths in each repo (files fetched via raw.githubusercontent.com). "Threshold" means a colour chosen by a numeric value.

## wolf123450/claudeskills
https://github.com/wolf123450/ClaudeSkills (stars 0)
1. Fixed per segment plus thresholds. `plugins/dev-workflow/skills/claude-code-statusline/statusline-command.sh`: model=CYAN (line 25), token count=WHITE (line 33), separator ` | ` in DIM (line 13), ctx% traffic light (lines 41-47: RED/YELLOW/GREEN, cut-offs not read past line 40), 5h and 7d limits: >=75 RED, >=50 YELLOW, else DIM (lines 58, 77). The Ink twin `plugins/desktop-statusline/hooks/register.tsx` (a Claude Code mod, not a command script) does the same: `trafficLight(pct, low)` line 11 (>=75 red, >=50 yellow), model `cyan` line 82, tokens `white` line 85, ctx low arm `green` line 88.
2. Themes: not present. No palette; hard-coded names.
3. Colour spec: named ANSI 16 only (`\033[36m`, `\033[97m`; Ink prop names `'cyan'`, `'red'`). No depth detection, no NO_COLOR.
4. Fill: foreground only.
5. Separators: plain ` | ` in DIM (shell line 13; tsx line 103).
6. Neighbours: separator only; text colours differ by segment.
7. Light/dark: not present. DIM and WHITE (97) assume a dark ground.
8. Glyphs: none (text labels `ctx:`, `5h:`, `7d:`).
9. Nothing else stands out. Shell script is a skill template Claude installs for the user.
10. Customisation: edit the script. No config file, no env vars. The desktop-statusline plugin has `plugin.json` and hooks only (`hooks/hooks.json`).

## woonglife62/claude-hud
https://github.com/woonglife62/claude-hud (stars 0)
not a Claude statusline: a Windows desktop overlay (pure-Go Win32 GUI window) that polls the Anthropic usage API and scans `~/.claude/projects` transcripts. For reference its only colour system is `internal/ui/colors.go`: a `ColorScheme` struct (15 slots: Bg, Card, CardBorder, TextPrimary/Secondary/Muted, AccentPurple/Green/Orange/Red/Blue/Cyan, ProgressBg/Fill, Divider) with a `LightScheme` and a `DarkScheme`, toggled by `ThemeMode` ("dark"/"light") in `internal/config/config.go` line 19.

## wooni-github/status-band
https://github.com/wooni-github/status-band (stars 0)
A Claude Code "mod" (Ink/React `hooks/register.tsx`, 1151 lines) that draws a clickable band above the prompt, not a `statusLine` command.
1. By position, in a fixed four-colour chain: every pill chain colours its Nth pill from `SEQ = [PINK, YELLOW, GREEN, BLUE]` cycling (`register.tsx` line 47; `chain()` ~line 845: `bg: SEQ[i % SEQ.length]`). So colour is positional within a row, not tied to a segment's meaning, except: git pill is YELLOW if dirty (staged+unstaged+untracked+conflicts > 0) else GREEN (`gitBg`, ~line 862); CPU/GPU/RAM load text: >=80 RED `#BF616A`, >=50 ORANGE `#D08770`, else GREEN (`load`, line 996); pet body takes the buddy's rarity colour (`RARITY_COLOR`, line 56); agent rows GREEN, running=YELLOW, done=BLUE (line 777); errors RED.
2. Themes: one palette of four roles ("pink, yellow, green, blue") replaced as a whole by the `pillColors` setting (4 comma-separated `#RRGGBB`, lines 405-409). Two presets in the settings pane: pastel `#D0607A,#E8C07D,#A3BE8C,#5B80A8` and deep `#A8405C,#8F6420,#4F7A35,#3A5A80` (line 722). Users may enter their own 4 colours.
3. Colour spec: truecolor hex only (`isColor` regex line 53). No depth detection, no NO_COLOR seen.
4. Fill: both. Pills are background-filled (`backgroundColor={sg.bg}`, line 833); other text is foreground-only.
5. Separators: Powerline. `CAP_L=`, `ARROW=`, `CAP_R=` (line 49): rounded start cap, arrow between pills drawn `color=prev.bg backgroundColor=next.bg` (line 835), rounded end cap in last pill's colour. Needs a Nerd Font (README).
6. Neighbours: four distinct hues cycled by position; arrows between.
7. Contrast: yes. `theme` setting `contrast` (default) picks black or white text per pill with `inkOn(bg, DARK, LIGHT)` using a WCAG contrast ratio (`hooks/lib.ts` lines 12-24; used at `register.tsx` line 824). Other modes: `auto` follows Claude Code's own theme (`themeOf`, lib.ts lines 9-11: names starting `light` -> light), `dark` = white text, `light` = black text. `pillText` overrides the ink with a fixed hex.
8. Glyphs: Nerd Font powerline caps required, plus many emoji (🤖 🔧 🎯 🔁 📝); box-drawing bars; ASCII fallback not present.
9. Extras: animated pet (`/buddy`) with per-character effect colours (`PET_FX`, line 50); a settings pane inside the band with colour swatches `██` and presets (lines 719-736), rounded bordered boxes coloured PINK/YELLOW (lines 1031, 1044).
10. Customisation: in-band clickable settings pane (`/band settings`), options include `pillColors`, `pillText`, `textColor`, `theme`, `petPlace`, `gpuColumns`, `language` (ko/en). Plugin install via `/plugin install`; launcher `install.sh`.

## wpham1/claude-chan
https://github.com/wpham1/claude-chan (stars 0)
1. The statusline itself is uncoloured: `lib/theme.js` `STATUS_LINE_SCRIPT` (line ~50) prints `printf "%s %s | $%.2f | ctx %d%%" "$FACE" "$MODEL" ...` with no escape codes; only the kaomoji face changes with context (<25 `(^_^)`, <50 `(o_o)`, <75 `(>_<)`, else `(x_x)`). Colours are used only by the installer CLI (`bin/cli.js`).
2. Themes: bundled six plus none in `lib/colors.js` lines 10-67: miku, sakura, naruto, eva, demon, jujutsu, none. Format is four semantic roles per theme: `primary`, `accent`, `success`, `highlight`, each a raw ANSI escape (e.g. miku primary `\x1b[36m`, accent `\x1b[35m`, success `\x1b[32m`, highlight `\x1b[96m`). Users can create custom themes (`npx claude-chan --theme create`, `saveCustomTheme`, stored in `~/.claude/.claude-chan-config.json` under `customThemes`; names from `NAMED_COLORS`, 16 ANSI names, lines 70-88).
3. Colour spec: ANSI 16 (including bright) only. No depth detection, no NO_COLOR.
4. Fill: foreground only.
5. Separators: plain ` | ` in the statusline.
6. Neighbours: not applicable (no colour in the line).
7. Light/dark: not present.
8. Glyphs: kaomoji faces, braille-art banner in installer.
9. Extras: the "theme" also rewrites spinner verbs and tips (`SPINNER_VERBS`, `SPINNER_TIPS`, `THEME_KEYS` line 136); colour roles only style installer output.
10. Customisation: CLI flags `--theme`, `--theme create`, `--uninstall`, `--purge`; config JSON `~/.claude/.claude-chan-config.json`.

## wr/quota-router
https://github.com/wr/quota-router (stars 0)
1. Mixed. `router/statusline.py` (1537 lines): quota numbers by threshold: `_paint` (lines 194-202) yellow `\033[33m` from threshold-10, bold red `\033[1;31m` past it; model+effort painted by effort level (`EFFORT_COLORS`, lines 388-391: low yellow, medium green, high `38;2;179;153;255` light purple, xhigh `38;2;124;58;237` purple, max rainbow); repo/branch segment painted with a per-repo "accent" hex; separators GRAY `38;5;247`.
2. Themes: not bundled. The accent resolves (`_accent_hex`, lines 527-553) from env `STATUSLINE_ACCENT`, then walking up from cwd a `statusline_accent` key or a Claude Code custom theme (`~/.claude/themes/<name>.json`, `overrides.claude` slot via `_theme_to_hex`, line 369), then global settings theme, then router config, then default `#D97757` (coral). So the segment reads the user's Claude Code theme accent.
3. Colour spec: ANSI 16 for alerts, 256 index for gray (`38;5;247`), truecolor hex for accent/effort. No depth detection. `statusline_color` config bool turns colour off (default True for `minimal` style, False for others, lines 560, 651); NO_COLOR not seen.
4. Fill: foreground only.
5. Separators: ` · ` in GRAY (line 639); `|`-style in other modes.
6. Neighbours: accent colour for place vs effort colour for model vs gray separators.
7. Light/dark: not present; accent is derived from the user's theme but no contrast logic.
8. Glyphs: circle ramp `○◔◑◕●` and braille ramp as optional `statusline_style` (lines 177-180); SF-symbol-like private-use badges for agents (`AGENT_BADGE_BASE`); `⏾` hibernate prefix; hyperlinked PR numbers via OSC 8 (line 364).
9. Extras: rainbow shimmer for effort `max`: per-character HSV hue = `(now/3 + i/n) % 1`, saturation 0.8 (`_rainbow`, lines 395-405), animates across repaints. Agent badges wear their agent's effort colour (line 521).
10. Customisation: router config JSON (`statusline_style` plain/circles/braille/minimal, `statusline_color`, `statusline_accent`, `statusline_show_pct`, thresholds), env `STATUSLINE_ACCENT`.

## wsh95/statusline-designer-dev
https://github.com/WSH95/statusline-designer-dev (stars 0)
A web designer that generates a standalone python statusline script.
1. By user choice per field, plus gradient for three fields: each segment has `color` (name) or `colorHex`; `ctxpct`, `lim5h`, `lim7d` are coloured green-to-red by usage via `grad_rgb(pct)` = `hsl_rgb(120*(1-pct/100), 0.45, 0.55)` (`scripts/generate.py` lines 21, 49-50, 381-390). Emphasis (bold etc.) via `emphCode`.
2. Themes: palettes defined in `scripts/ui/js/catalog.js` lines 43-75: Tokyo Night (default, "legacy": named colours desaturated 40% by the generator), Dracula, Nord, Catppuccin Mocha. Format is a map of 15 colour keys (default, gray, white, red, green, yellow, blue, magenta, cyan, plus bright variants) to hex; picking a palette bakes `colorHex` per segment into the saved choice. Users can pick any colour per field in the UI; no custom palette files.
3. Colour spec: always truecolor `38;2;r;g;b` in the generated script (comment, `generate.py` line 23: identical to the web preview, not the terminal's ANSI theme). No depth detection or NO_COLOR.
4. Fill: foreground only (`"\033[%d;%sm%s\033[0m"`, line ~437).
5. Separators: a single configurable string, default space (`CONFIG.get("separator", " ")`, line 410).
6. Neighbours: separator string plus per-field colour.
7. Light/dark: the designer UI has light and dark themes (README); the generated script does not adapt.
8. Glyphs: per-field emoji table `EMOJI` (lines 17-19), toggle `emoji`.
9. Extras: live terminal preview mirroring the script, 3D card ring, two-line dock, starter presets (Minimal, Essentials, Limits watch, Full telemetry), JSON export.
10. Customisation: browser designer (`open_designer.py`, `--port`, `--no-browser`, `--out`, `--settings`), `choice.json`, applies to `settings.json` via `apply_settings.py`.

## x-wink/cchud
https://github.com/x-wink/cchud (stars 0)
1. By state and threshold. `hud.js` lines 17-22: O (orange `38;2;217;119;87`) = busy, G (green `38;2;74;222;128`) = waiting for you, Y (yellow `38;2;250;204;21`) = waiting for confirmation; usage meters use `C(p)`: >=85 `\x1b[91m` bright red, >=60 `\x1b[93m` bright yellow, else `\x1b[92m` bright green (line 22, used line 311). Mascot rows (a block-art crab, lines 288-295) are drawn in the state colour.
2. Themes: not present. The config (`cchud.config.example.json`) only holds labels, sounds and toggles.
3. Colour spec: truecolor for state colours, ANSI 16 bright for meters. No detection, no NO_COLOR.
4. Fill: foreground only (block glyphs coloured by foreground).
5. Separators: `  ·  ` with a DIM middle dot (line 308).
6. Neighbours: dim separators; state colour only on the mascot and label.
7. Light/dark: not present.
8. Glyphs: Unicode block-element mascot (`▐▛███▜▌`), `▰▱` meter bars (line 24), `↻` reset marker; emoji only in notification text.
9. Extras: state-dependent mascot poses (idle, think, bash, read, web, edit, wait); desktop notifications and sound (`notify.js`).
10. Customisation: `cchud.config.example.json` (labels, `sound`, `sessionName`, `projectName`, `sessionId`, ...), `tools/preview.js`.

## xavierdavidgarcia/claude-status-go
https://github.com/xavierdavidgarcia/claude-status-go (stars 0)
1. Mixed: fixed per segment plus thresholds. `main.go` lines 868-1070: host label=magenta, model=blue, token counts=white, session duration icon dim + white, effort=magenta, cwd=cyan, branch/parens=green with red `*` when dirty, `+n` green, `~n` yellow, unpushed SHA red else green, PR number blue, lines `+` green `-` red, "tokens out"/"api time" white, usage bars by `colorForPct` (lines 271-282: >=90 red, >=70 yellow, >=50 orange, else green), cost: <2 green, >=2 orange, >=5 yellow, >=10 red (lines 897-904), cache % green/yellow by ratio.
2. Themes: five bundled, `themes` map (lines 91-137): default, dracula, catppuccin, solarized, mono. Format is eight semantic hue slots (`Blue, Orange, Green, Cyan, Red, Yellow, White, Magenta`) each a truecolor escape; the segments refer to the slot names so a theme swaps the hex but keeps intent. Selected by `--theme` flag or `CLAUDE_STATUSLINE_THEME` env (lines 164-189). No user-defined themes.
3. Colour spec: truecolor only (`rgb(r,g,b)` -> `38;2;...`, line 26). No detection, no NO_COLOR seen in `main.go`. (The separate `pkg/cockpit/theme.go` is a lipgloss TUI sidebar using Catppuccin Mocha hex: Surface0/1, Overlay0, Text, Mauve, Green, Yellow, Peach, Red, Blue; its selected-row highlight uses a background `#313244`.)
4. Fill: foreground only in the statusline (the cockpit TUI uses a background for the selected row).
5. Separators: ` │ ` with dim `│` (line 163).
6. Neighbours: different hues per segment type plus dim separators.
7. Light/dark: not present (solarized theme exists but is not adaptive).
8. Glyphs: emoji icons (💻 🪟 💾 ⏱ 📂 📊 🤖 💰); five bar styles `classic ●○`, `block █░`, `braille ⣿`, `line ━─` (default), `geometric ▰▱` via `--bar` / `CLAUDE_STATUSLINE_BAR` (lines 30-60). No ASCII-only mode.
9. Extras: OSC 8 link on the PR number; "extra usage" burn-rate projection coloured green/yellow/red; agent tracker; `make install THEME=dracula BAR=block` bakes flags into settings.json.
10. Customisation: CLI flags and two env vars; no config file.

## xilla420/claude-chronicle
https://github.com/xilla420/claude-chronicle (stars 0)
A Claude Code mod (Ink, `chronicle/hooks/register.tsx`) with a status line plus dashboard; not a `statusLine` command.
1. By state, using Claude Code's own theme role names rather than colours: `level(percent)` = `error` if >=85, `warning` if >=60, else `success` (`register.tsx` line 82); brand elements use `color="claude"` (lines 761, 804, 832, 881); everything secondary is `dimColor`. The status line text is built in `statusLine()` (line 483): `14:33 · $1.84 ($1.67/h) · ctx 48% · 5h 23% ↻17:00 · 7d 8%` (README).
2. Themes: not bundled; because it uses semantic role names (`claude`, `error`, `warning`, `success`) the host's active theme decides the actual colours.
3. Colour spec: Claude Code theme role names only; no hex, ANSI or depth handling in the mod.
4. Fill: foreground only.
5. Separators: ` · ` text.
6. Neighbours: dim vs normal weight; separators only.
7. Light/dark: inherited from Claude Code's theme through the role names.
8. Glyphs: `↻`, `⏱`, bar and sparkline glyphs (`bar()`, `spark()` helpers), no Nerd Font.
9. Extras: three-tab dashboard (`/chronicle`) with spend-per-day bars and per-turn sparklines.
10. Customisation: plugin options (`options.statusLine === false` disables, a style option `statusStyle`, line 75).

## xqsit94/cc-statusline
https://github.com/xqsit94/cc-statusline (stars 0)
1. By named colour key per field plus bands. `config/default.toml` `[colors]` lines 72-90: model_marker `#cba6f7`, model_name `#89dceb`, normal `#4ade80`, warning `#facc15`, danger `#ef4444`, cost `#4ade80`, duration `#6c7086`, ratelimit `#6c7086`, effort `#94e2d5`, branch `#cba6f7`, added `#4ade80`, removed `#ef4444`, project `#89b4fa`, separator `#45475a`, diffstat_delim `#45475a`, bar_empty `#45475a`. Context bar band: `BandColor` (`internal/config/derive.go`) picks normal/warning/danger at `thresholds.warning`=70 and `danger`=85; rate-limit uses `ratelimit` then `warning` at `RateLimitWarn`.
2. Themes: not present as named themes; two shipped presets `config/default.toml` and `config/minimal.toml`. Format: flat map of colour-key to `#rrggbb`. Users may override any key.
3. Colour spec: hex only (a comment in default.toml warns the renderer silently paints nothing for 7-char alternatives like `#abc`). Depth handled by termenv: `internal/style/profile.go` resolves, in order: `NO_COLOR` set -> none (always wins), `TERM` empty/dumb -> none, env `CC_STATUSLINE_COLOR` / config `general.color` (`none|16|256|truecolor`), `COLORTERM=truecolor|24bit` -> truecolor, `TERM` containing `256color` -> 256, else 16. lipgloss downsamples hex to the profile.
4. Fill: foreground only (no `Background` in `internal/style/*.go`, `internal/line/segments.go`).
5. Separators: `|` ASCII, `│` Unicode, or Powerline `` (`internal/style/glyph.go` lines 22-45), chosen by `general.icons` / `powerline` (`auto` = on with Nerd Font icons, off for ASCII; `capabilities.go`). Separator colour is the single key `separator` (`#45475a`); the arrow is not a fill transition.
6. Neighbours: separator only; each field its own key colour.
7. Light/dark: not present.
8. Glyphs: three icon sets ascii / unicode / nerdfont (`capabilities.go` `IconSet`), env `CC_STATUSLINE_ASCII` / `CC_STATUSLINE_NERDFONT`; East-Asian ambiguous width handling.
9. Extras: gradient context bar: `bar.gradient` with `gradient_stops = ["#4ade80","#facc15","#fb923c","#ef4444"]` interpolated in sRGB across the fill, active only in truecolor (`Style.Gradient()` in `theme.go` line 48; `ramp.go`). Two-pane TUI editor (`cc-statusline config`) with live preview where `i`/`p`/`c` cycle icon set, powerline and colour profile in the preview; `doctor` command reports resolved capabilities.
10. Customisation: `~/.config/cc-statusline/config.toml`, `[[line]]` blocks with per-segment `drop` priority and flex gaps, TUI editor, env vars `CC_STATUSLINE_NERDFONT|ASCII|POWERLINE|COLOR`, `NO_COLOR`, `COLUMNS`.

## xrf-9527/statusline
https://github.com/xrf-9527/statusline (stars 0)
1. By role slot and threshold. `statusline-hz.py`: model=ORANGE (line 734), dir/branch=DIM (753, 762), dirty marker RED, ahead=CYAN, behind=YELLOW (773-784), cost and duration=CYAN (797-800), lines added GREEN (841), context bar/percent by `_ctx_color` (lines 541-547): GREEN below `CTX_LOW`, YELLOW below `CTX_MED`, else RED; API time by `_api_perf_color` (845); vim mode via `VIM_MODE_MAP` (lines 73-79): NORMAL GREEN, INSERT YELLOW, VISUAL CYAN, REPLACE RED, COMMAND DIM.
2. Themes: four bundled (`THEMES`, lines 93-98): default, gruvbox, nord, minimal. Format: six semantic names (ORANGE, CYAN, GREEN, YELLOW, RED, DIM) mapped to xterm-256 indices (e.g. gruvbox ORANGE 208, nord GREEN 108); `DIM=None` means SGR 2 faint. Chosen by env `STATUSLINE_THEME` (line 229). No user-defined themes.
3. Colour spec: 256-colour index (`\033[38;5;Nm`, line 179). No depth detection. `NO_COLOR` honoured: `Colors.init_theme` blanks all codes (lines 168-170, 231).
4. Fill: foreground only.
5. Separators: plain text.
6. Neighbours: different hue slots, dim for structure.
7. Light/dark: not present.
8. Glyphs: two icon modes (`ICONS`, lines 103-143): `plain` (emoji ⏰ 📝 ⚡ and ASCII `*` `+` `-` for git, chosen because ambiguous-width glyphs break under CJK fonts) and `nerd_font` (``, ``, ``, ``). Env `STATUSLINE_ICON_MODE`.
9. Extras: filled bar `━` for context (`CTX_STYLE_BAR`) or text (`STATUSLINE_CTX_STYLE`).
10. Customisation: env vars only (`STATUSLINE_THEME`, `_ICON_MODE`, `_CTX_STYLE`, `_GIT_DETAIL`, `_BRANCH_MAX_LEN`, `_SHOW_TOKENS`, `_SHOW_BURNRATE`, `_COST_THRESHOLD`).

## xunzhou/cc-helper
https://github.com/xunzhou/cc-helper (stars 0)
1. By state only, and only for two segments. `cc-statusline.sh`: quota bar and percent coloured by pace (lines 221-262): red if used >= 90 or ahead state, yellow if >10 points ahead of linear pace, else default (uncoloured); context segment yellow when handoff state is `amber`, red for `red|degraded` (lines 278-293). Everything else (model, dir, branch, cost) uncoloured.
2. Themes: not present.
3. Colour spec: ANSI 16 (`\033[33m`, `\033[31m`, `\033[2m` dim; line 27). `NO_COLOR` and `CC_STATUSLINE_NO_COLOR` honoured: colour variables are emptied (lines 21-27). Overage cells `▓` carry the signal without colour.
4. Fill: foreground only.
5. Separators: ` | ` (line 296).
6. Neighbours: separator only.
7. Light/dark: not present.
8. Glyphs: bar `█ ▓ ░` (solid / overage / empty, lines 253-260); no emoji needed.
9. Extras: state is also published for polybar / i3 (`publish_context_state`).
10. Customisation: env vars; script edit.

## xyunjie/claude-hub
https://github.com/xyunjie/claude-hub (stars 0)
The richest system in this batch: a role palette.
1. By theme role mapped to segment. Each segment is created with a `ColorRole` (`src/render/parts.ts`): model->`model` (line 47), project->`project`, git->`git`, session name/version/extra/auth/environment->`label`, duration->`duration`, cost->`cost`, lines changed->`success`, memory/prompt-cache by state `warning`/`context`. Bars use roles by threshold: `contextRole(percent, warning=70, critical=85)` -> context/warning/critical; `usageRole` -> usage / usageWarning (>=75 or pace warning) / critical (>=90) (`src/render/colors.ts` lines 127-145).
2. Themes: nine bundled (`src/themes.ts` `THEMES`, lines 47-111): claude, lavender, default, dracula, nord, catppuccin, gruvbox, tokyonight, mono. Format: a `Palette` with 18 semantic roles (`COLOR_ROLES`, lines 22-25): model, project, git, gitBranch, label, context, warning, critical, usage, usageWarning, custom, running, success, tool, agent, cost, duration, barEmpty. Value type `ColorValue` = named ANSI, 256 index, or `#rrggbb`. Users override per role with `config.colors` merged over the theme (`buildPaint`, colors.ts line 28: `{...THEMES[theme], ...config.colors}`). `lavender` is one hue for everything except warning/critical; `default` uses the terminal's own 16 colours; `claude` uses orange `#e0875e` accent.
3. Colour spec: names (`red`, `brightBlue`, `dim`, `bold`, `gray`), 256 index, truecolor hex; `toAnsi` (themes.ts line 143). Depth not detected: the theme decides (16-colour themes `default`/`mono` vs truecolor others; gradient bars fall back to bands when colours are not hex). No NO_COLOR/COLORTERM reference in `themes.ts`, `colors.ts`, `config.ts`, `index.ts` (grepped).
4. Fill: both, by style. `style: powerline` and `capsule` fill each segment as a block (`blockColors(value)` returns `{bg, asFg, text}`, themes.ts lines 190-198); `dashboard`, `lean`, `boxed`, `bracket` are foreground-only.
5. Separators: six styles (`style` option): dashboard (default), lean (dim separator glyph), powerline (arrow `` in previous block's colour on next block's background, `src/render/segments.ts` lines 47-60), capsule (rounded caps `` `` in the block colour, lines 63-70), boxed, bracket (dim brackets around glued groups, lines 33-44). Arrow/caps empty unless `icons: "nerd"`.
6. Neighbours: in powerline/capsule, by the role colour of each block; adjacent blocks of the same role (e.g. several `label`) would share a colour. In lean/dashboard, dim separators and different roles.
7. Contrast: yes for blocks. `blockColors` computes luminance of the background (`0.2126r+0.7152g+0.0722b`/255 > 0.55) and chooses dark text `\x1b[38;2;30;30;46m` or white `\x1b[38;2;255;255;255m` (named colours: `\x1b[30m` or `\x1b[97m`). Named-colour RGB approximations in `NAMED_RGB` are used only for this. No terminal-background detection; `mono` theme for no-colour taste.
8. Icons: tiers `unicode`, `nerd`, `ascii` (`src/icons.ts`, README "five layouts, each with or without a Nerd Font"); bar glyph sets `BAR_STYLES` (11: solid, tall, block, half, thin, shade, line, dot, square, bead, ascii).
9. Extras: gradient bars (`barColor: gradient`) shading each cell along per-theme ramps `RAMPS` (themes.ts lines 203-211, e.g. claude: `#7dcfff -> #9ece6a -> #e0af68 -> #ff9e64 -> #f7768e`) via `sampleStops`; per-model colours (`src/render/model-style.ts`): Fable shimmers along a rainbow `SHIMMER_HEX` with a `✦`, Opus takes the theme `model` accent, Sonnet muted `#9aa3b2`, Haiku `#8bd5ca`; effort colours low gray `#6e7681`, medium blue, high green, xhigh orange, max red `#f7768e` (`EFFORT_HEX`); a pace marker tick `┼`/`▏` on bars coloured against the cell background; `npm run preview` renders every style x theme.
10. Customisation: JSON `~/.claude/plugins/claude-hub/config.json` (and `$CLAUDE_CONFIG_DIR/claude-hub.json` layered), `/claude-hub:configure` slash command, keys `theme`, `style`, `icons`, `barStyle`, `barColor`, `colors`, `contextWarningThreshold`, `contextCriticalThreshold`, `display.modelColors`.

## y-a-v-a/claude-code-statusline
https://github.com/y-a-v-a/claude-code-statusline (stars 0)
1. Fixed per segment plus thresholds. `statusline.sh`: model=CYAN (line 216), context bar: >=90 RED, >=70 YELLOW, else GREEN (lines 110-116); git staged `+n` GREEN, modified `~n` YELLOW, added GREEN, removed RED (lines 194-198); rate-limit and cache lines pick RED/YELLOW/GREEN by value (lines 228-232, 259-263); cold cache CYAN (273).
2. Themes: not present.
3. Colour spec: ANSI 16 names only (lines 104-108). No detection, no NO_COLOR.
4. Fill: foreground only.
5. Separators: spaces; emoji act as segment leaders.
6. Neighbours: emoji prefixes (🤖 🎲 📁 🧊) rather than colour.
7. Light/dark: not present.
8. Glyphs: emoji labels; bar `█░` (width 10). No fallback.
9. Extras: sanitises control characters in text before `echo -e` (line 3).
10. Customisation: edit script; reads Claude's JSON fields; no config.

## yaakov300/tmux-agents-mon
https://github.com/yaakov300/tmux-agents-mon (stars 0, FORK OF snirt/agenmux)
not a Claude statusline: a Rust tmux sidebar / status-line segment that monitors AI coding agents in panes by scraping the screen. Fork differences: none. GitHub compare `snirt/agenmux:master...yaakov300:master` reports the fork 0 commits ahead and 54 behind, so no styling differs from the parent.

## yablid/claude-status-bar
https://github.com/yablid/claude-status-bar (stars 0)
1. By state (context token count). `statusline.mjs` `BAND_COLORS` (lines 65-71), by absolute tokens used: <50k `#8a8a8a` "low", 50-80k `#829c5e` green, 80-100k `#F1D302` yellow, 100-120k `#F39237` orange, 120-140k `#EC4E20` orange+, >=140k `#E3170A` red. One coloured piece: the token label in `[model] ctxt - <label>` (line 97).
2. Themes: not present.
3. Colour spec: truecolor hex (`color()`, lines 75-78). `NO_COLOR` honoured (line 76: plain text). No depth detection.
4. Fill: foreground only.
5. Separators: plain ` - `.
6. Neighbours: not applicable (single coloured field).
7. Light/dark: not present.
8. Glyphs: none.
9. Extras: reads the transcript for ground-truth usage; cache throttled.
10. Customisation: env vars `CLAUDE_CONTEXT_TOKENS`, `CLAUDE_METER_THROTTLE_MS`, `CLAUDE_METER_MAX_MB`, `NO_COLOR`.

## yacchi/statusloom
https://github.com/yacchi/statusloom (stars 0)
1. By author: every `<field>` / `<span>` / `<text>` carries optional `color`, `background`, bold, dim, italic, underline, strikethrough (`internal/render/doc_style.go` `docStyle`, lines 18-27); nearest style wins down the tree (`mergeStyle`, line 34). Threshold colours via `<color-rule when="..." color="..."/>` children (README "Conditional display and color"). No per-segment default colour is hard-coded for standard output. In Powerline output uncoloured segments get a rotating built-in theme (below).
2. Themes: the render engine has none. Powerline's built-in rotation `powerlineTheme` (`internal/render/doc.go` lines 391-397): cyan bg + black text, magenta bg + bright-white text, yellow + black, blue + bright-white, green + black, indexed by segment order, cycling. The configurator's colour picker (`apps/configurator/src/themes.ts`) offers swatch palettes (Dracula, Nord, Solarized dark/light, Gruvbox, Tokyo Night and the 16 ANSI names), a UI preference stored in localStorage that just writes a hex or name into a field; not part of the saved config. Presets in `apps/configurator/src/presets.ts` (shareable layouts).
3. Colour spec: ANSI 16 names (camelCase and kebab `bright-red`), `ansi256:N`, `#rrggbb` (`internal/render/color.go` `parseColor`, lines 100-120). Downsampling: `downgrade` truecolor -> nearest ansi256 -> nearest ansi16 (lines 131-151). Depth comes from the document setting `color-level` (`none|ansi16|ansi256|truecolor`, default `ansi16`, `doc.go` line 235), not from env detection (no NO_COLOR/COLORTERM reference found in `internal/cli/render.go`); `none` emits no escapes.
4. Fill: both. `background` attribute fills cells (`sgrBgParam`, doc_style.go lines 59-76).
5. Separators: two modes. Standard: `<text role="separator">` collapsing separators (dropped when leading, trailing or adjacent to another). Powerline (`output-style="powerline"`): manual separators removed, `` generated between each visible top-level piece; `resolvePowerlineStyles` sets arrow `color = left piece's background`, `background = right piece's background`, so the arrow joins the two blocks (doc.go lines 487-512); `<flex/>` closes the left run with an arrow and reopens the right-aligned run.
6. Neighbours: in Powerline, the rotating five-colour theme (or explicit backgrounds); in standard mode, author's choice and separators.
7. Contrast: the Powerline theme pairs black text with light backgrounds and bright-white with dark ones (hand-picked, lines 391-397); no computed contrast. No terminal-background adaptation.
8. Glyphs: Powerline glyphs required in that mode; OSC 8 hyperlinks for PR/repo fields (`hyperlink="true"`). No ASCII fallback mode noted.
9. Extras: web configurator where the live preview is the editor (click a field to edit, drag to rearrange), responsive width variants (`when="width ge 80"`), compact mode, flex separators, subagent status line (`statusloom claude-subagent`), also targets Codex and Copilot.
10. Customisation: XML-like markup document (`markup.md`), `statusloom setup claude-code`, local web configurator, importable presets.

## yanbel/claude-statusline
https://github.com/YanBel/claude-statusline (stars 0)
1. By theme role mapped to segment. `statusline.js` palettes (lines 45-97) share role names: text, subtle, faint, track, project, branch, dirty, model, ok, warn, crit, effort{low..max}, agent, worktree, style, gradient. Use: project (line 308) `project`, branch (310) `branch`, dirty marker (311) `dirty`, model (317) `model`, agent (349) `agent`, worktree (350) `worktree`, output style (352) `style`, track/empty `faint`/`track`, usage by `ok/warn/crit` thresholds (296) and by gradient (below), effort coloured by level from the `effort` map.
2. Themes: six palettes keyed by Claude Code theme names (lines 92-97): `dark` (Catppuccin Mocha pastels), `light` (Catppuccin Latte deeper tones), `dark-daltonized`, `light-daltonized` (colourblind-safe palettes, blue/orange/yellow), `dark-ansi`, `light-ansi` (the 16 base colours, `gradient: null`). `pastel` aliases `dark`. Format: one JS object of roles. Not user-extensible apart from editing the file.
3. Colour spec: truecolor `38;2` for the four hex palettes; ANSI 16 for `*-ansi` (so the terminal's palette decides). No depth autodetection and no NO_COLOR found (grep); the user picks `--theme`.
4. Fill: foreground only.
5. Separators: plain text (not examined in detail).
6. Neighbours: different role hues per segment (project lavender, branch mauve, model blue, dirty peach).
7. Light/dark: yes, explicitly. `--theme=claude` reads Claude Code's own `/theme` from `settings.json` (`userSettings().theme`, lines 128-132) and maps dark, light, daltonized and ansi variants; unknown names fall back to dark. Light palette uses deeper tones "that hold up on a light background" (comment line 55). Statusline JSON does not carry the theme, hence the settings read.
8. Glyphs: heavy bar `━` with half cell `╾` (heavy-left, light-right) joining the track (line 205 comment); some emoji; no ASCII mode noted.
9. Extras: gradient context gauge: each cell takes the gradient colour at its own position (`gradient` stops e.g. dark: `#a6e3a1` 0, `#f9e2af` .55, `#fab387` .8, `#f38ba8` .95), line 188-206; ANSI themes fall back to ok/warn/crit thresholds. Derived from waelmas/claude-stat.
10. Customisation: `--theme=` flag only (`claude` or a palette name); `install.js` wires settings.

## yanlonglai/claude-code-usage-statusline
https://github.com/YanlongLai/claude-code-usage-statusline (stars 0)
1. By position and threshold. `statusline.sh`: usage bar cells coloured by their position along the bar, five bands at 25/45/65/85% (`cell_color`, lines 89-98: C0..C4), and the percent text coloured by value with the same five stops (`pct_color`, lines 145-152); model uses the theme accent (line 68); directory bold blue `\033[1;34m` (49); git `git:(branch)` oh-my-zsh style in blue/red/yellow (57-59); separator 256-colour 95 (43); empty bar dim white `\033[2;37m░`.
2. Themes: four bundled via `STATUSLINE_THEME` (lines 33-40): warm (default, 256 indices 223,216,173,166,124 = apricot to crimson, accent 173, Anthropic brand-like), classic (46,226,208,202,196 green to red), neon (51,87,201,165,93 cyan to magenta), mono (255..235 white to grey). Format: five gradient stops plus an accent, as 256 indices. Not user-extensible except editing.
3. Colour spec: 256-colour index (`\033[38;5;Nm`). No detection, no NO_COLOR.
4. Fill: foreground only.
5. Separators: a configurable character (`SEP_CHAR`) in 256-colour 95.
6. Neighbours: separator plus differing hues.
7. Light/dark: not present.
8. Glyphs: `█ ▒ ░` bar with a half block `HALF` for sub-cell precision.
9. Extras: animation. `STATUSLINE_PULSE`: 1 blinks the danger cells (SGR 5, pct >= 85, lines 110-113), 2 is a wave animation. Gradient is cell-by-cell by bar position, not a single colour per value.
10. Customisation: env vars `STATUSLINE_THEME`, `STATUSLINE_PULSE`, hide list (`HIDE`, line 31), bar width.

## yarora21/ccburn
https://github.com/yarora21/ccburn (stars 0)
Mostly not a statusline: a CLI that analyses session logs for cost waste (Rich tables and charts). Its statusline part is tiny.
1. `ccburn/cli.py` `_print_statusline` (lines 297-312) prints `next ≈ $x/turn` and a compact hint, coloured by cost ratio (`_ratio_color`, lines 244-250): none below 2.0, yellow `\033[33m` below 5.0, red `\033[31m` otherwise. Everything else uncoloured.
2. Themes: not present for the statusline. The rest uses Rich style strings (`header_style="bold cyan"`, `border_style="yellow"`).
3. Colour spec: ANSI 16 raw escapes for the statusline; Rich handles depth for the CLI report. NO_COLOR not seen in the statusline.
4. Fill: foreground only.
5. Separators: plain text.
6. Neighbours: not applicable.
7. Light/dark: not present.
8. Glyphs: `≈` and `→` only.
9. Extras: statusline fails silently by design (line 277).
10. Customisation: `cmd_statusline` args; hook events for compact warnings (`PreCompact`).

## yashkgp/cclive
https://github.com/yashkgp/cclive (stars 0)
1. Fixed per widget plus value. `src/ansi.js` defines the 16 `FG` codes and `bold`/`dim` helpers. Git widget (`src/widgets/git.js` lines 24-36): `➜` bold green, cwd cyan, `git:(` blue bold, branch red, dirty `✗` yellow (oh-my-zsh robbyrussell look). Stock widget (`stock.js` lines 16-41): label bold cyan, up bold bright green, down bold bright red, flat dim white. Active ticker item wrapped in bold bright-white `« »` (`render.js` line 28); unknown widget red `?type?`.
2. Themes: not present.
3. Colour spec: ANSI 16 incl. bright. No detection, no NO_COLOR.
4. Fill: foreground only.
5. Separators: widgets joined by spaces; `« »` marks the active one.
6. Neighbours: the highlight brackets on the active widget and bold vs normal weight.
7. Light/dark: not present (bright white and dim white assume dark).
8. Glyphs: `▲ ▼ ●`, `➜`, 2 emoji.
9. Extras: a rotating ticker that advances one slot per prompt render; stocks (Yahoo), sports (ESPN) with 5-minute cache and detached background refresh.
10. Customisation: JSON config choosing widgets and order (`src/config.js`); drop-in widget modules.

## yigalc/customized_claude_code_termial
https://github.com/yigalc/customized_claude_code_termial (stars 0)
1. Fixed per component with a threshold bar. `statusline.py` default config (lines 56-125): model cyan bold, repo bright_blue, context bar by threshold (`_pick_threshold_color`, lines 163-168: <50 green, >=50 yellow, >=80 red), context percent white, tokens bright_black, cost magenta.
2. Themes: not present. But every component's colour is a config key (`"color": "cyan"`), and the threshold colours and cut-offs are keys (`low_threshold`, `high_threshold`, `color_low|medium|high`).
3. Colour spec: ANSI 16 names incl. bright (`ANSI` dict, lines 17-38), `"none"` for no colour. No detection, no NO_COLOR.
4. Fill: foreground only.
5. Separators: a configurable string, default two spaces (line 61).
6. Neighbours: hue per component; spacing.
7. Light/dark: not present.
8. Glyphs: configurable bar characters (`filled_char` etc.), a prefix per component.
9. Extras: components list is ordered and removable.
10. Customisation: `~/.claude/statusline-settings.json` (user file merged over defaults, lines 148-153); `components` list, `separator`, per-component dicts.

## yigitkonur/lean-statusline
https://github.com/yigitkonur/lean-statusline (stars 0)
1. By theme role, symbolic. `lib/segments.mjs` uses palette slots: model=`blue` (line 475), directory name=`cyan` (504), git parens/branch=`green`, dirty `*`=`red` (510-511), labels (5h, 7d, context) `dim`/`white`, cost=`yellow` (633), lines `+` green `-` red (643-644), worktree name cyan (660), agent magenta (667), bypass banner red (586), >200k warning red (721), update notice yellow (568). Rate/context percentages by `colorForPct` (`lib/colors.mjs`): red at `critical_at` (90), yellow at `warn_at` (70), else green (README says four bands: green <50, orange 50-70, yellow 70-90, red 90+; the function shown has three, bar code not read to completion). Pace ETA: red <1 h, orange <4 h, else yellow (`colorForEta`, segments.mjs line 186). SSH host label coloured by LAN vs public IP kind (README).
2. Themes: six bundled palettes (`lib/colors.mjs` `PALETTES`, lines 33-103): solarized, rose-pine, catppuccin, catppuccin-latte, dracula, monochrome (reduced from 17 in 1.5.0; dropped names alias in `PALETTE_ALIASES`, `lib/config.mjs`). Format: eight named slots (blue, orange, green, cyan, red, yellow, white, magenta) of `[r,g,b]`, "so every segment consumes colors symbolically ... green stays the healthy/low hue in every theme" (lines 13-17). Picked in the TUI wizard; hex values audited against upstream palette repos (docs/research/palettes). Users cannot add palettes without editing the file ("append an entry").
3. Colour spec: truecolor `38;2;r;g;b` only. Colour switch: `colorsEnabled` (lines ~124-130) honours `NO_COLOR`, `LEAN_STATUSLINE_NO_COLOR`, env override `1/0`, config `colors`. No COLORTERM or 256 downsampling (README troubleshooting: "your terminal theme is probably overriding 24-bit colors").
4. Fill: foreground only.
5. Separators: configurable string, default `·` in dim (`ctx.palette.dim(ctx.cfg.separator)`, segments.mjs line 791).
6. Neighbours: slot hue per segment, dim separator.
7. Light/dark: partial. `catppuccin-latte` palette exists but its `white` is remapped to subtext1 `#acb0be` so labels read on dark terminals (comment lines 56-59); no detection.
8. Icons: three modes `ascii|unicode|nerd` (`pickIcons`, lines ~160-190). Nerd is explicit opt-in only because detecting a Nerd Font from a spawned shell is infeasible (comment cites `docs/research/nerd-fonts/02-detection-infeasibility.md`); `auto` falls back to ASCII for `TERM=dumb|linux|''` or SSH without UTF-8. Env `LEAN_STATUSLINE_ICONS`.
9. Extras: p10k-style interactive wizard with live preview and visual confirmation ("did the glyphs render?"); pace-vs-estimate arrows coloured orange (fast) / green (slow) (segments.mjs line 284); three presets (minimal, compact, full) in `lib/presets.mjs`.
10. Customisation: `~/.claude/lean-statusline.json` (`segments` array with `"\n"` for line breaks, `separator`, `colors`, `thresholds`, `show`), TUI wizard (`lean-statusline config`), `config --preset`, env `LEAN_STATUSLINE_NO_COLOR`, `LEAN_STATUSLINE_ICONS`, `LEAN_STATUSLINE_SSH_KIND`.

## yo-resistor/claude-code-statusline
https://github.com/yo-resistor/claude-code-statusline (stars 0)
1. By state, with emoji for identity. `statusline-command.sh` lines 35-41, 70-77, 152-168: context bar GRAY below 60%, ORANGE (`38;5;208`) 60-79, RED >=80; 5h limit GREEN below 80, YELLOW >=80, RED >=90; 7d limit passes BLUE as its low-usage colour (`format_rl pct reset label [low_color]`); git `+n` GREEN, `~n` YELLOW; PR link BLUE. Model, effort, cost, dir uncoloured, identified by emoji (🤖 💪 🧠 💰 📁 🌳 🌿).
2. Themes: not present.
3. Colour spec: ANSI 16 plus one 256 index (orange 208). No detection, no NO_COLOR.
4. Fill: foreground only.
5. Separators: ` | ` plain.
6. Neighbours: emoji prefixes carry identity; colour is reserved for alert state.
7. Light/dark: not present; GRAY (`90`) assumes a dark ground.
8. Glyphs: emoji labels, bar glyphs; no ASCII mode.
9. Extras: PR lookup cached per repo+branch (cksum key, line 129).
10. Customisation: edit script; `examples/generate-examples.sh` renders samples.

## yuanzhixiang/claude-statusline
https://github.com/yuanzhixiang/claude-statusline (stars 0, FORK OF JerryFan626/claude-statusline)
Fork differences only (GitHub compare: 2 commits ahead, 3 behind; changed files `statusline-command.sh`, `install.sh`, both READMEs). Styling that differs: (a) `ICON_GIT` in nerd mode becomes the Nerd Font glyph `󰘬` instead of `⎇` (patch hunk at line ~106); (b) the worktree root path is always shown in CYAN with `ICON_TREE` (new `worktree_path_str`, `${CYAN}${ICON_TREE} ...`); (c) detached HEAD shows the short SHA instead of the word `detached`; (d) line order swapped, workspace row (worktree, branch, dir in BLUE) on top, model/context/cost row below (`line1`/`line2` swap); (e) `install.sh` points at the fork. Unchanged parent styling worth recording from the file: themes `dark|light|auto` via `STATUSLINE_THEME`; auto uses macOS `defaults read -g AppleInterfaceStyle` (dark if it exits 0) then `COLORFGBG` background index < 8 = dark, default dark (`detect_theme`, lines 33-56); light mode swaps DIM to `\033[90m` and the warning text to `1;30` (dark `1;37`); ANSI 16 only; ctx colour by `pct_color`: <50 GREEN, <80 YELLOW, else RED; at >=90% a `BG_RED` background alert badge ` ⚠ CTX n% ` with bold text (the only filled cell); `SEP=" │ "` dim; icons `ascii` default or `nerd` via `STATUSLINE_ICONS`.

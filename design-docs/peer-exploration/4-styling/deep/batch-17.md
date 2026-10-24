## claude-status-chip
https://github.com/omarqra/claude-status-chip (stars 2)
not a Claude statusline: a VS Code extension that patches the Claude Code VS Code panel webview (`patch-core.js`) to add a coloured pill chip (branch, context, think, cost) to the input toolbar. It is a webview, not a terminal statusline. Styling facts, for reference only:
1. fixed per pill with one state ramp: `patch-core.js:290` `CH={branch:charts-purple, think:charts-orange, cost:yellow}`; context pill colour is green, then yellow at >=50%, red at >=80% (README). The context pill is drawn as a progress bar with `linear-gradient(90deg, color-mix(c 30%) P%, color-mix(c 10%) P%)` (`patch-core.js:297`).
2. themes: not present as its own. Colours are VS Code theme variables `--vscode-charts-{purple,green,orange,yellow,red,blue}` with hex fallbacks (`patch-core.js:288-290`), so the host theme is the theme.
3. CSS colours; no ANSI. NO_COLOR not applicable.
4. fill: tinted background, `color-mix(in srgb, <c> 12%, transparent)` with text in `<c>` (`patch-core.js:295`), pill radius 999px.
5. separators: none; pills are spaced with a 6px gap.
6. neighbours: different hue per pill (purple/green/orange/yellow, model pill blue `BLU`, `patch-core.js:156`).
7. light/dark: follows the VS Code theme through the charts variables; a 12% tint of the pill's own colour over the panel background. No contrast calculation.
8. glyphs: a `⚙` gear menu; `(main)` branch text.
9. gear menu toggles each pill (`SEGS`, `patch-core.js:90`); transcript zoom 80-160%.
10. customisation: a gear menu in the webview, with preferences persisted. No config file.

## openanalystinc/statusline
https://github.com/OpenAnalystInc/Statusline (stars 2)
1. fixed per segment, with one threshold segment. `themes/default.sh`: Skill pink `38;2;236;72;153`, Model purple `168;85;247`, Dir cyan `6;182;212`, GitHub near-white, Tokens amber `245;158;11`, Cost green `34;197;94`, Vim teal, Agent indigo. The whole `Label: value` pair for a segment takes that segment's one colour (`layouts/standard.sh`). Context bar by threshold (`lib/core.sh:155-161`): `CLR_CTX_LOW` white <=40%, `MED` orange 41-75%, `HIGH` red 76-90%, `CRIT` deep red >90%. The "N% left" and "COMPACTING" warnings also use the ctx colours.
2. five bundled themes as sourced shell files `themes/{default,nord,tokyo-night,catppuccin,gruvbox}.sh` (`commands/sls-theme.md`). The format is a per-segment colour map of `CLR_*` variables (about 17 names, fixed set including the 4 ctx levels, `CLR_SEP`, `CLR_BAR_EMPTY`, `CLR_LABEL`, git staged and unstaged). It is not a semantic palette. Every theme also sets `BAR_FILLED`, `BAR_EMPTY` and `SEP_CHAR`. Users can drop a new `themes/<name>.sh` file; `ccsl theme set <name>` or `/sls-theme` selects, and `lib/core.sh:16-51` falls back to default.
3. truecolor `38;2;r;g;b` only, no downsampling or depth detection. NO_COLOR is not present (grep finds none).
4. foreground only on the terminal's own background (no `48;` codes).
5. separators: a plain `│` (`SEP_CHAR`) in `CLR_SEP` dim grey, between two-column pairs (`layouts/standard.sh`: `rpad`ded column 1, then separator).
6. neighbours: different hue per segment, plus the `│` separator and a fixed column pad (`lib/helpers.sh` `rpad`).
7. light/dark: not present. All shipped themes assume a dark terminal; `CLR_BAR_EMPTY` is near-black.
8. glyphs: `█ ░` bar, `│`, a few emoji; no Nerd Font and no ASCII mode.
9. three layouts: `layouts/{compact,standard,full}.sh`; the standard layout is 4 rows with a full-width context bar row. No gradient.
10. customisation: `~/.claude/statusline-config.json` with `theme` and `layout` (grep-parsed from JSON in `lib/core.sh:26`), env overrides `STATUSLINE_THEME_OVERRIDE` and `STATUSLINE_LAYOUT_OVERRIDE`, an `ccsl` CLI (`bin/cli.js`), and a `/sls-theme` slash command.

## p5hema2/claude-code-cli-statusline
https://github.com/p5hema2/claude-code-cli-statusline (stars 2)
1. fixed per widget, set in the config. `src/defaults/statusline.json`: directory `"color":"blue"`, gitBranch default, model/outputStyle/vimMode `"colors":{}` (the widget picks), one widget `yellow`, one `magenta`, one `green`, separators and labels `dim`, one `bold`. The output-style widget defaults to cyan (`output-style.widget.ts:91`). Usage bars by threshold in `src/utils/colors.util.ts:100`: <50% green, <80% yellow, else red; the colours are overridable per bar as `{low, medium, high}` (`UsageBarColors`).
2. no bundled statusline themes. `terminal-themes.const.ts` lists 6 terminal backgrounds (Monokai, VS Code Dark, Light, Solarized Dark, Dracula, Nord) used only as the GUI preview background. The theme format is not present; colour is configured per widget.
3. chalk named colours only: 18 ANSI names plus 4 modifiers `dim, bold, italic, underline` (`src/types/colors.type.ts`). No hex, no 256 index. Depth handling and NO_COLOR are whatever chalk does (it honours FORCE_COLOR/NO_COLOR itself); the repo has no own code for them.
4. foreground only; no background fill.
5. separators: a `separator` widget (default dim `|`; choices `| • · / ⟩ │`, `separator.widget.ts`). `renderer.util.ts:renderRow` drops leading, trailing and doubled separators when a neighbour widget renders empty.
6. neighbours: only the separator widget, plus the colour the user gave each widget.
7. light/dark: the GUI preview can show a Light terminal background, but the statusline itself does nothing to adapt. Named ANSI colours follow the user's terminal palette.
8. glyphs: `█ ░` bars, a few emoji; configurable labels per widget (`"label":"Dir"`).
9. a web GUI configurator with drag-and-drop (`src/configure/gui`, `e2e/utils/drag-drop.ts`), live preview over terminal themes, rows of widgets.
10. customisation: `statusline.json` widget rows (`widget`, `color`, `colors`, `options`), the GUI, a `configure` CLI.

## papjamzzz/kodekeeper
https://github.com/papjamzzz/kodekeeper (stars 2)
1. no colour for the statusline. `kodekeeper/data/statusline-command.sh:187-198` is one plain `printf` with no escape codes: `Kode Keeper [OK|>|!! FILLING|!! RESET NOW] ████░░░░░░ 40% | 132k free | d:.. w:.. m:.. | Sonnet 4.6 | dir[branch] | HH:MM`. Context state is conveyed by text (`health` words at 50/70/85%), not colour.
2. themes: not present for the statusline. The Flask dashboard (`app.py`, `kodekeeper/server.py`) is a separate web UI and was not read for theming.
3. none; no ANSI. NO_COLOR moot.
4. neither (plain text).
5. separators: two spaces, `|`, two spaces.
6. neighbours: the `|` separators only.
7. light/dark: not present (no colour).
8. glyphs: `█ ░` bar, `----------` when unknown; no emoji in the line.
9. the same script records context history for a web "oscilloscope" dashboard (`ctx_history`, 120 samples).
10. customisation: none for the line; fixed format.

## paris-paraskevas/claude-usage-tracker
https://github.com/paris-paraskevas/claude-usage-tracker (stars 2)
1. no colour. `ctu/statusline.py:format_line` returns `Opus · ctx 73% · 5h 64% ↻16:40 · 7d 41%`, with no escape sequences.
2. themes: not present for the statusline. `ctu/ui/assets/theme.js` and the Android `Theme.kt` / `WidgetTheme.kt` belong to the tray window and the phone app, not the statusline.
3. none; no ANSI. NO_COLOR moot.
4. neither (plain text).
5. separators: ` · `.
6. neighbours: separator only.
7. light/dark: not present in the statusline; the tray UI has its own dark/light handling (unread).
8. glyphs: `↻` for reset time; no emoji.
9. the statusline's main job is merging `rate_limits` into a snapshot a tray app watches (`merge()`); not a styling project.
10. customisation: none for the line.

## pthexton/claude-sidebar-mod
https://github.com/pthexton/claude-sidebar-mod (stars 2)
Mainly not a statusline: a Claude Code mod plugin marketplace with a sidebar pane (an Ink/React view), a PR overview, and Rose Pine themes for Claude Code itself. Its `sidebar/statusline-feed.sh` is a statusLine command that prints nothing (it only saves the JSON per session). The sidebar is the display, so its styling is recorded here.
1. fixed per section heading and by threshold. `sidebar/hooks/register.tsx`: Heading colours CI green (line 692), Model magenta (739), Session yellow (754), Workspace blue (793), Tasks cyan (829), Cost yellow (837); model name cyan (740); cost amounts yellow (757). Bars by threshold, `barColor` (line 330): >=90% red, >=70% yellow, else green. Effort colour (363): max and xhigh magenta, high cyan, medium blue, low gray. CI marks ✓ green, ✗ red, ◔ ⊘ yellow, ⊝ dim. Cache chip: warm green or cold red.
2. the sidebar has no themes; it uses Ink named colours, so the terminal's ANSI palette decides (README says to give the terminal Rose Pine too). The `rose-pine` plugin ships 3 Claude Code themes (Rose Pine, Moon, Dawn) as JSON of Claude Code theme keys (`rose-pine/themes/rose-pine.json`: `claude, text, inverseText, inactive, subtle, suggestion, permission, success, error, warning, merged, promptBorder, planMode, diffAdded, userMessageBackground, ...` to hex) with `"base":"dark"|"light"` and `"overrides"`. It is generated by `rose-pine/build.rb` from the Rose Pine palette by role (rose accent, love errors, gold warnings, foam success, iris permissions/merges). Plugin themes are read-only, and `/theme` Ctrl+E saves an edited copy to `~/.claude/themes/`.
3. Ink colour names (red/yellow/green/gray/...); hex only in the theme JSON. Depth and NO_COLOR are left to Ink.
4. foreground only.
5. separators: none; headings are `── Title ──` rules, in the heading colour.
6. neighbours: a different hue per section heading, with `dimColor` labels and bright values.
7. light/dark: the Rose Pine Dawn theme is the light variant (`base: light`); the sidebar relies on the terminal palette; no contrast code.
8. glyphs: `█ ░` bars, `✓ ✗ ◔ ⊘ ⊝ ⚡ ↻`; the README mentions no Nerd Font mode.
9. pane tuned for fullscreen layout; GBP conversion, billing discount; none of it styling.
10. customisation: the plugin `/config` options (billing discount, GBP), slash commands `/sidebar /gbp /ci-refresh /open-pr`. No colour options.

## purpleprintai/save-ur-usage-limit-ttl-counter-for-claude-code
https://github.com/PurplePrintAI/save-ur-usage-limit-ttl-counter-for-claude-code (stars 2)
1. by state or threshold, on two segments only. `bridge/statusline.js:349-357` TTL clock: green `32` when over 50% of the TTL remains, yellow `33` at <=50% and <=20% (the two branches are the same colour), red `31` at <=10%, bold red `1;31` "TTL expired", grey `90` "TTL --:--" when unknown. `usageSegment` (365): 5h and 7d text turns bold red `1;31` at >= `HIGH_USAGE_PERCENT` 90, else uncoloured. `ctx NN%` is uncoloured. The separator is grey `90` ` · `. The VS Code status bar item uses `statusBarItem.errorBackground`/`warningBackground` ThemeColors, `#e0a030` and `#4ec95e` (`src/status-bar.ts:21-57`).
2. themes: not present. The VS Code item takes the editor theme's ThemeColors.
3. ANSI 16 only (`color(code,text)`, `statusline.js:63`). NO_COLOR and `--no-color` are honoured (line 61).
4. foreground only.
5. separators: a grey ` · `.
6. neighbours: separator only, plus the TTL clock colour.
7. light/dark: not present.
8. glyphs: none beyond ` · `; the VS Code item uses codicons (unread).
9. a VS Code extension plus the CLI statusline; the TTL countdown is the unusual segment.
10. customisation: `--usage`, `--no-color` flags and `NO_COLOR`; VS Code settings (`src/settings-manager.ts`, unread).

## revenantworks/claude-skills
https://github.com/revenantworks/claude-skills (stars 2)
Mostly not a statusline: a skills pack. One mod in it, `mods/vigil`, draws a pane and a status-line segment. Its themes file is relevant.
1. by role. `mods/vigil/hooks/theme-logic.ts:12` has six roles `accent, ok, warn, bad, dim, rule`; every view paints a tone through `toneStyle` (accent, ok, warn, bad, dim, rule, head = accent bold). The status-line text (`meters-logic.ts:57`, `5h 23% · wk 41% · ctx 38% · cache 92%`) is plain text with no escape codes: the header comment says "text surfaces get the glyphs and headers, never escape codes". Colour appears only on the pane, which paints.
2. four bundled themes (`BUNDLED`, line 64): `neutral` (default; each role is a Claude Code theme key, `accent: suggestion, ok: success, warn: warning, bad: error, dim: subtle, rule: inactive`, so it follows the user's own light/dark theme), `revenantworks` (brand hex, with `variants.dark` and `variants.light`), `hc-light` (high contrast on `#FAF6F1`), `off` (all roles `text`). Format: JSON `{name, description, background, colors:{6 roles}, glyphs, header, variants?}`. Users write `~/.claude/revenantworks/themes/*.json`, which win over a bundled name. `/rw-vigil theme new <name> accent=#... glyphs=ascii` makes one; `themeFromTokens` imports a brand tokens file or CSS by guessing roles from token names (`ROLE_WORDS`).
3. `#rgb`, `#rrggbb` or a Claude Code theme key (`THEME_KEYS`, 17 names; `isColor`, line 71). No ANSI-depth code; the host (Ink) draws it. "off" is its no-colour mode; NO_COLOR is not present.
4. foreground only.
5. separators: glyph set entries `sep` `' · '` (unicode) or `' | '` (ascii); `rule` `─`/`-`. Headers have 3 styles: `rule` (`── Title ───`), `plain`, `block` (`▍ Title`).
6. neighbours: not a concern; roles are fixed per text kind.
7. strong adaptation: `resolveVariant` picks a dark or light palette per theme (line 142). `consoleBackground` (line 150) reads `VIGIL_THEME_BACKGROUND`, then the Claude Code theme name (`light*` / `dark*`), then `COLORFGBG` (bg 7 or 15 = light), else a dark guess. `wantsContrast` switches to `hc-light`. Contrast is checked with a WCAG ratio: `FLOORS` accent/ok/warn/bad 4.5:1, dim 3:1, rule 1.5:1 against `#121212` or `#FFFFFF` (`contrastWarnings`, `roleChecks`, `consoleVerdict`). This reports and warns; it does not auto-adjust.
8. glyph sets `GLYPHS.unicode` (`✓ ! ✗ ● ○ █ ░`) and `GLYPHS.ascii` (`+ ! x * o # .`), selectable per theme (`"glyphs":"ascii"`) or per glyph.
9. contrast verdict UI per theme per console type; token-file import.
10. customisation: theme JSON files, `/rw-vigil theme ...` slash commands, env `VIGIL_THEME_BACKGROUND`, `VIGIL_THEME_CONTRAST`.

## rntgspr/claude-statusline-stickers
https://github.com/rntgspr/claude-statusline-stickers (stars 2)
1. no colour assignment. It prints one sprite glyph (a private-use codepoint in a generated fallback font carrying a colour `sbix` bitmap) chosen by the agent name (the folder above the project directory) via `manifest.json` (README, `install.py`). The colour is in the bitmap, not in ANSI.
2. "themes" are sprite sets, not colour themes: `claude_statusline_stickers/themes/{amongus,cars,memes,pokemon,powerrangers,smurfs,southpark,zootopia}/theme.json`, each with a `codepointSlot`, an `emoji_probe` and a `sprites[]` list (`name, key, url, agentNames`). Users can add theme folders.
3. none. macOS only (Apple `sbix` colour fonts), with ligatures required in the terminal; no ANSI codes, so NO_COLOR is moot.
4. images; not text fills.
5. separators: not present.
6. neighbours: not present.
7. light/dark: not present.
8. glyphs: font-based images. Warp and other terminals that do shaping fallback are needed (README "Ligatures").
9. the sprite approach is the stand-out: Claude Code's escape filter strips iTerm2/kitty/sixel image protocols, so this uses a fallback font.
10. customisation: the `stickers` CLI (fetch, build, install), theme JSON; Homebrew tap.

## roneli/claude-zj
https://github.com/roneli/claude-zj (stars 2)
Not a Claude statusline in the usual sense: hooks that push per-session activity into the Zellij `zjstatus` plugin's status bar (`zellij pipe zjstatus::pipe::pipe_status::...`). The styling is zjstatus `#[fg=...]` style strings.
1. by state, and by tool. `cc-zjstatus/scripts/lib/colors.sh`: a `tool_to_style` map gives each tool a colour and a symbol: WebSearch/WebFetch/Read/Glob/Grep blue `#0074d9`, Task/Skill/mcp purple `#b10dc9`, Bash orange `#ff851b` ⚡, Write/Edit aqua `#4166F5` ✎, TodoWrite yellow `#ffdc00`, AskUserQuestion red `#ff4136` ?, thinking gray `#666666` ◐, done green `#2ecc40`, default yellow ●. The line per session (`lib/zjstatus.sh:16`) is `#[fg=<state colour>]<symbol> #[fg=#4166F5]<project name> #[fg=<ctx_color, default #2ecc40>]<context %>`. The project name is a fixed aqua. The writer of `ctx_color` is not in this repo; only its pass-through and default exist.
2. themes: not present (the clrs.cc palette is hard-coded). The surrounding zjstatus bar is configured in the user's `default.kdl` (`mode_normal "#[bg=blue] "`, `border_format "#[fg=#6C7086]{char}"`, `notifications_format_unread "#[fg=#89B4FA,bg=#181825]..."`, Catppuccin-looking hex).
3. truecolor hex in zjstatus syntax. No depth detection and no NO_COLOR.
4. foreground only for the sessions; the sample `default.kdl` uses bg for mode and notification blocks.
5. separators: two spaces between sessions; `border_format` char in `#6C7086`.
6. neighbours: each session's symbol colour depends on its state; the name is the same aqua.
7. light/dark: not present.
8. glyphs: `◍ ↓ ▶ ⚡ ◔ ✎ ◎ ★ ◫ ? ◈ ◐ ●` per tool; no Nerd Font.
9. none beyond the per-tool symbol and colour map.
10. customisation: edit `colors.sh`; the zjstatus layout in `default.kdl`.

## ronrefael/sonde
https://github.com/ronrefael/sonde (stars 2)
1. by module name, with state overrides. `src/themes.rs`: a `Palette {base, text, surface, modules: [(module name, (fg, bg))]}`; each of the 10 to 14 modules (`sonde.model`, `context_bar`, `context_window`, `usage_limits`, `promo_badge`, `pacing`, `session_clock`, `git_branch`, `active_sessions`, `model_suggestion`, and in the sonde theme `project`, `usage_5h`, `usage_7d`) has a fixed `(fg, bg)` pair in each theme, e.g. Catppuccin Mocha: model mauve `203,166,247`, context sapphire, usage green, promo peach, pacing yellow, git teal, clock and sessions `surface1` with light text. Text is the dark `base` colour on a bright module background, and light text on the dark `surface` modules. Overrides: `sonde.pacing` takes its background from a pace tier (`modules/pacing.rs:66` `powerline_bg`: Comfortable green, OnTrack blue, Elevated yellow, Hot peach, Critical and Runaway red). In the `sonde` theme `sonde.model` is coloured per model family (`sonde_model_color`: opus mauve, haiku dark `24,24,37` with light text, else sonnet gold; `renderer.rs:216-237`), and the pace colours switch to `sonde_pace_color`.
2. bundled: `catppuccin-mocha` (default and fallback), `terminal`, `cyberpunk`, `synthwave`, `solarflare`, plus `sonde` (auto dark or light) and a `plain` mode (`ALL_THEME_NAMES`, `get_palette`; also assets/screenshots/terminal-themes.png). Format: a Rust static per theme, a per-module colour map plus three base colours. User-defined themes: not present in `themes.rs` (only `SondeConfig.theme` selects a name; a user module colour override via `custom.rs` was not read).
3. truecolor `Color::Rgb` throughout via `nu_ansi_term` (`src/themes.rs`, `src/ansi.rs`); `ansi.rs` also parses named colours. No depth downsampling found; `COLORTERM`/NO_COLOR matches were counted by the scanner but I did not find them in `renderer.rs` or `ansi.rs`: unverified.
4. background-filled cells (powerline).
5. separators: powerline arrow `\u{e0b0}` between cells, coloured `fg = this cell's bg, bg = next cell's bg`, and the last arrow `fg = last bg` on the default ground (`ansi.rs:201-229`). Cells are ` text ` with one space padding. The `plain` theme has no arrows.
6. neighbours: a different hue per module (or the surface vs bright alternation: bright modules and `surface` modules interleave), and the arrow joins them. If the line is too wide, lower-priority segments are dropped (`renderer.rs:249-300`).
7. light/dark: `is_light_terminal()` reads `COLORFGBG` (bg > 6); only the `sonde` theme switches to `SONDE_LIGHT` (Catppuccin Latte-like: base `239,241,245`) and light model and pace colours. In light mode, saturated model backgrounds get white text (`renderer.rs:230`); in dark mode, haiku gets `palette.text`. Text colour is otherwise hand-picked per module, not computed.
8. glyphs: Powerline `` needs a Nerd or Powerline font; emoji for some modules; no ASCII fallback beyond the `plain` theme.
9. per-model colour and a pace tier colour on the pacing cell; a macOS menu bar app shares the sonde theme (design doc `docs/superpowers/specs/2026-03-20-sonde-theme-design.md`).
10. customisation: a TOML or JSON config file (`SondeConfig.theme`, `lines`, `format` strings, `src/config.rs`; exact format unread), `sonde setup`, `sonde doctor`, a themes preview command (`themes_preview.rs`).

## rynaro/lararium
https://github.com/Rynaro/lararium (stars 2)
1. no colour. `src/lararium/statusline.py` writes one plain line (an emoji pet and a calm text); `render.py` contains no escape sequences (grep for `\033` and `\x1b` finds none).
2. themes: none for colour. The scanner's `catppuccin` and `night-owl` hits did not appear in the files I fetched (`README.md`, `render.py`, `statusline.py`, `cosmetics.py`); likely cosmetics names, unverified.
3. none; no ANSI, so NO_COLOR moot.
4. neither (plain text).
5. separators: not present beyond spaces and middle dots.
6. neighbours: not present.
7. light/dark: not present.
8. glyphs: emoji only (pet species map in `render.py`, e.g. `"nightowl": "🦉"`); fallback line `🥚 Lar · keeping you company`.
9. a virtual pet whose state lives in a file and is ticked by hooks; the statusline is read-only and reads `COLUMNS` for width, muted and quiet-hours settings.
10. customisation: a config file with `muted`, `quiet_hours`; `bin/pet.sh`, `bin/action.sh`.

## sandermuller/claude-statusline
https://github.com/SanderMuller/claude-statusline (stars 2)
1. fixed per segment, with threshold bars. `statusline.sh:365-377`: labels (`PWD:`, `git`) soft light-blue `38;5;111`; directory bold cyan `1;36`; model bold magenta `1;95`; git branch bold green `1;32`; peer session name bold yellow `1;33`; runtime versions soft green `38;5;114`; values bold bright white `1;97`; reset times near-white `253`; track dim grey `240`; separators grey `245`. Bars (line 383-397): green `1;32` below 50%, yellow `1;33` at 50-79%, red `1;31` at 80%+; the same ramp colours the `ctx` bar and the 5h and 7d bars. A separate prompt-cache countdown uses green/yellow/red by remaining fraction (lines 604-628, yellow when under 1/5 left).
2. themes: not present. The palette is a fixed block in the script ("easy to tweak", README).
3. 256-colour `38;5;N` plus 16-colour bold codes. Requires a 256-colour terminal (README line 99). No depth detection, no NO_COLOR.
4. foreground only.
5. separators: a grey `·` (`SEP`), and a grey `→` between the repo and the subfolder.
6. neighbours: different hue per fact kind (cyan dir, green git, magenta model, yellow peer) plus the `·`.
7. light/dark: not present; the grey and white values assume a dark terminal.
8. glyphs: Nerd Font runtime icons, a `CLAUDE_STATUSLINE_ICONS` of `auto` (default), `1` or `0`. `auto` reads the terminal's configured font (`icons_enabled`, cached in `$CACHE_DIR/nerdfont`) and uses icons only when that font is a patched one, else words; when unknown the answer is no (README line 156). `CLAUDE_STATUSLINE_ICON_WIDTH` sets the budgeted width (default 2). Bars use light-line rules (`━` filled over `─`-like track) rather than blocks, to lower visual weight.
9. responsive: segments are dropped or broken onto a new line to fit width (`add_seg` records width and break flags).
10. customisation: environment variables (icons, icon width, `CLAUDE_CONFIG_DIR`, bar width) or editing the block at the top of the script; `install.sh` merges `statusLine` with `refreshInterval: 30`.

## simplecore-inc/claude-mods
https://github.com/simplecore-inc/claude-mods (stars 2)
Mostly not a statusline: a Claude Code mod set (panes, a status band above the prompt, slash commands). The "status band" is a mod surface, and its pill styling is relevant.
1. by segment kind and state. `mods/accounts/hooks/statusline.ts`: the model pill is `bg 60` (xterm-256, a slate purple) with white bold text; the effort pill by level (`EFFORT_STYLES`): low `bg 240`, medium `25` blue, high `29` green bold, xhigh `166` orange bold, max `160` red bold; ultracode gets a rainbow letter ramp (`ULTRA_RAMP` 201..51) on `bg 53` with yellow text; fast `bg 220` yellow with black text. Place pill: directory `bg 237` grey, branch `bg 97` purple. Context label colour by threshold on a rescaled percent (`contextLabelColor`): green `46` below 63, yellow `226` below 81, orange `208` below 95, red `196`. The context percentage is rescaled so the 80% auto-compact point reads as 100% (`contextScaled`). PR review marks: approved `42`, changes requested `203`, commented `75`.
2. themes: not present in the files read; colours are literals.
3. xterm-256 indices (`PillSegment {bg, fg}` are numbers), converted to `#rrggbb` by `ansiHex` so every surface draws the same colour; the host (Ink) handles depth. NO_COLOR not present.
4. background-filled pills with contrasting foreground text chosen per segment by hand.
5. separators: pill edges are half blocks. On the cell grid a pill is `▐` (fg = first segment bg), each segment, `▌` (fg = segment bg, bg = next segment's bg, or no bg for the last) (`views/band.tsx:119-126, 150-172`); off the grid, a space on the same ground replaces the half block. So the cap and the joint colours are derived from the neighbouring segment backgrounds.
6. neighbours: each pill segment has its own hue/shade; the joint half block blends them.
7. light/dark: the code does not adapt. `README` has no light mode.
8. glyphs: `○ ◐ ● ◆ ★ ▶ ◇ ✔ ✖` marks; half-block caps.
9. the ultracode rainbow, the context rescaling, and a per-surface fallback for fonts where half blocks do not fill the line.
10. customisation: the mod's settings and docs (`docs/accounts.md`); pills are code-defined.

## siwalikm/statusline-pro
https://github.com/siwalikm/statusline-pro (stars 2)
1. by tone and state; everything at rest is gray. `src/core/palette.ts`: five tones `dim, mid, hi, warn, crit`. Dark: `#6e6a63 #a8a29a #e8e4dd #d9a05b #d96a5b`; light: `#a39c92 #5c564d #2a2723 #a86a1c #b3402f`. `render.ts:63-81` `paintSpan`: labels and brackets `dim`; static values `mid`; a metric value stays `mid` while its band is `rest`, becomes `warn` (amber) or `crit` (red) past thresholds; a gauge is `dim` at rest, else the band colour. `config.ts` thresholds: ctx 60/80, limit (5h and weekly) 70/90, extra 75/95. Only the single highest-priority hot metric is made bold (`pickBright`, `ELEVATION_PRIORITY`). The colour has no per-segment identity: segments differ by text, not hue.
2. two palettes, `dark` and `light`, chosen with `--theme=light` (default dark) in the interactive picker, which writes the choice into the statusLine command rather than a config file. Format: a tone-to-hex table. Users cannot define more.
3. truecolor `38;2;r;g;b` or ANSI 16 (`detectColorMode`: truecolor if `COLORTERM` contains `truecolor` or `24bit`, else `ansi16` with `90, 39, 1;39, 33, 31`). NO_COLOR not present.
4. foreground only.
5. separators: two spaces between segments (`paintLine` joins with `'  '`); no glyph.
6. neighbours: only the two-space gap and the dim label versus mid value contrast.
7. light/dark: a user choice (`--theme`); the light palette has a darker `hi` and `mid`. No detection of the terminal background and no contrast calculation. In ansi16 mode the default foreground (`39`) is used so the terminal decides.
8. glyphs: a 5-cell context gauge (`--ctx-gauge`); `emoji=1`; no Nerd Font.
9. width-aware truncation: low-value segments drop first (cost, reset times, branch). Subscription vs API-key detection chooses which quota segments to show.
10. customisation: an interactive picker (preset compact/default/full, theme, context style); flags such as `--theme=`, `--ctx-gauge`; `COLUMNS` for width.

## skrrt-sh/skills
https://github.com/skrrt-sh/skills (stars 2)
Mostly not a statusline: an agent skills repo; `skills/term/statusline/assets/statusline.py` is the statusline the skill installs.
1. by segment, with threshold overrides. Catppuccin Mocha hex constants (`statusline.py:7-12`): model pill mauve `#cba6f7`, directory pill blue `#89b4fa`, git pill flamingo `#f2cdcd`, 5h limit pill peach `#fab387`, weekly pill yellow `#f9e2af`. Context pill by threshold (line 106): green `#a6e3a1` below 50%, yellow at >=50%, red `#f38ba8` over 100% of the soft budget ("new session"). The 5h and weekly pills turn red at >=80% (`level()`, line 41). A "tail" on a pill is a darker tinted region of the same hue: `DEEP_FLAMINGO #5e4853` for the +/- line counts on the git pill, `DEEP_GREEN/YELLOW/RED` on the context pill.
2. one hard-coded Catppuccin Mocha palette; no theme switching; no user-defined themes.
3. truecolor `38;2` and `48;2` (`fg()`, `bg()`). No depth detection, no NO_COLOR.
4. background-filled pills with dark `INK #1e1e2e` bold text; the note text is `FADED #585b70`.
5. separators: rounded caps. Each pill is `` (left round, fg = pill colour), body, `` (right round); with a tail, a `` in the pill colour sits on the tail's background, then the tail ends with `` (`statusline.py:36-38`). Pills are joined by a single space; there are no joined arrows.
6. neighbours: a different Catppuccin hue per pill; pills are separated by a space and rounded caps.
7. light/dark: not present; the ink is the dark `base` colour and assumes the bright pastels.
8. glyphs: Nerd Font required: pill caps ` `, `nf-md` circle-slice glyphs as a 9-step radial gauge (`CIRCLE`, `circle(pct)`), alert glyph, branch ``, model icon `\U000f06a9`; no ASCII fallback.
9. the radial circle gauge; a soft context budget passed by the installer (default 256k tokens) used for the gauge.
10. customisation: edit the script; the budget is an installer argument (`scripts/install-statusline.sh`).

## Sniper7Kills-LLC/claude-plugins
https://github.com/Sniper7Kills-LLC/claude-plugins (stars 2)
Mostly not a statusline: a plugin marketplace; `statusline-spark` is the statusline part. It wraps `claude-powerline` and appends sparklines to its session row.
1. delegated to claude-powerline for its rows. Its config (`statusline-spark/config/claude-powerline.json`) sets `"theme":"dark"`, `"style":"minimal"`, `"charset":"unicode"`, 3 lines of segments (directory fish-style, git, model, thinking, version; context blocks, session, metrics, cacheTimer; block, weekly, today). The sparklines the plugin adds (`hooks/statusline.js:186-194`): the context-level sparkline is cyan `38;5;80` with a dim `◔` label, the cost-burn sparkline violet `38;5;177` with a dim `$` label. The subagent panel row uses dim directory name plus the model (line 170).
2. themes: the powerline `theme` key (`dark` here). The plugin adds none.
3. 256-colour `38;5;N` for its own sparklines; powerline has `colorCompatibility`. NO_COLOR not present in the plugin.
4. powerline "minimal" style is foreground-only; the sparklines are foreground only.
5. separators: powerline's `minimal` style (no arrows); the plugin pads its sparkline items with spaces.
6. neighbours: the two sparklines get two different hues (cyan, violet).
7. light/dark: the powerline `theme` key is manual; `lightdark.detection` signals were counted by the scanner, and the install script was not read for it.
8. glyphs: `▁▂▃▄▅▆▇█` sparkline blocks, `◔ ◷ $`; powerline charset `unicode`.
9. sparklines of history (context level and cost burn), which the built-in line cannot show because it only gets a snapshot.
10. customisation: `claude-powerline.json`, `CLAUDE_POWERLINE_BIN`, `/statusline-spark:install`, `CLAUDE_SUBAGENT_STATUSLINE_DEBUG`.

## sonyharv/claude-polyrouter
https://github.com/SonyHarv/claude-polyrouter (stars 2)
1. by state or threshold, with an animated mascot. `hud/polyrouter-hud.mjs`: mascot colour by state (`MASCOT_STATES`, lines 57-93): idle lavender `#afa9ec`, routing teal `#5dcaa5`, keepalive grey `#484f58`, danger red `#e24b4a`, thinking amber `#ef9f27`, compact green `#97c459`, ctx_high orange `#e8853a`, critical red; frames cycle (e.g. `[^.^]~`). Cache freshness bar by elapsed time (`CACHE_BAR_LEVELS`): 0-10 min green `#97c459` `cache:█████`, 10-30 min amber `████░`, 30-50 min orange `███░░ !`, else red `cache:░░░░░ exp`. Percentages (context, 5h, weekly, extra) by threshold (`thresholdColor`, line 135): green below 70, yellow 70-89, red 90+. Active-session minutes: green <30, yellow 30-60, red >60. Everything else (dir, model route, savings, language) is uncoloured.
2. themes: not present.
3. truecolor `38;2` for the mascot and cache bar (`ansiColor`), ANSI 16 `31/32/33` for thresholds. NO_COLOR is honoured by `colorEnabled()` for the threshold colours and the model segment, but `ansiColor` (mascot and cache bar, lines 560 and 579) does not check it: a partial implementation. `hooks/lib/hud.py` is a mirrored implementation ("must stay in sync").
4. foreground only.
5. separators: ` │ ` (`SEP`, uncoloured) between groups; spaces inside groups.
6. neighbours: separators only; coloured items are few.
7. light/dark: not present.
8. glyphs: ASCII-art mascot `[^.^]`, `█ ░`, emoji `📁 ⏱`.
9. animated mascot frames keyed to routing state; the colour changes with the state.
10. customisation: environment (`POLY_REFRESH_USAGE`, NO_COLOR); no colour config found.

## soyjuanxyz/awake-bar
https://github.com/SoyJuanxyz/Awake-Bar (stars 2)
1. by role and zone, with a locked palette. `statusline-gsd.sh:42-56` defines a locked set of ten 256-colour codes (README "Colors"): `231` block titles, `173` Anthropic orange for the "Context Management" title, `117` GSD blue for the "GSD Status" title, `252` active values (model, branch, percentages), `240` structure (labels, separators, rail glyph), `141` GSD progress fill and active step, `114` green for live signals (healthy branch, spinner), `178` amber (quick glyph, branch warning), `203` red (hung glyph, branch danger), `209` red-orange (debug glyph). Branch colour by git state (lines 875-897): danger red for conflict or detached HEAD, amber for rebase, merge, or no upstream with commits ahead, else green. The context gauge is 9 cells `▓/░` (line 1080-1105): cells 1-3 green, 4-6 amber, 7-9 red when filled, dark grey `240` when empty. The gauge number and the 5h and weekly percentages use `zone_color` (line 623): 0-33% light gray `252`, 34-66% amber, 67%+ bold red. (README text says green for zone 1; the code uses light gray for the number and green for the first three gauge cells.)
2. themes: not present. The README states the palette is locked and a ship-gate test enforces it (`tests/v1-ship-gate.sh` "palette lock").
3. 256-colour `38;5;N`. It deliberately rewrites claude-powerline's truecolor output to its own 256 codes (line 900-906). `claude-powerline.json` sets `colorCompatibility: "auto"`. NO_COLOR not present.
4. foreground only: the powerline config sets every segment `"bg":"none"` with fg `#d0d0d0` (git `#87d787`), `"style":"minimal"`.
5. separators: a dark-grey `·` between segments; a `│` rail glyph for block structure.
6. neighbours: the `·` separator and per-title colours (orange and blue titles); values share one light gray.
7. light/dark: not present (dark-terminal assumption: light grays, dark-grey structure).
8. glyphs: `▓ ░ ↻ ✳ ◎ ⚡ ⚠ ⌖ ◓`, a rotating quadrant spinner.
9. animation: with `refreshInterval: 1` the active GSD stage's glyph rotates through 4 quadrant frames, one per second, with a live-green label; a "stage pulse" colour (README, lines 1558-1619). Output of the powerline call is cached 4 s so the cheap bash part can animate each second.
10. customisation: edit `claude-powerline.json` and the script; `subagent-statusline.sh` for agent rows.

## srgexj/aesthetic-statusbar-cc
https://github.com/SrGexj/aesthetic-statusbar-cc (stars 2)
1. by threshold, by state, and fixed per segment. `src/aesthetic_statusbar/colors.py`: `color_for_pct` / `bg_color_for_pct` give a five-step ramp for usage: <=35% green, <=64% yellow-green, <=80% orange, <=95% light red, else strong red. `renderer.py` uses: pet cyan; model yellow; git green when OK else gray (line 101); update notice cyan with a dim hint; cache segment: cold light red, warm cyan, otherwise `color_for_pct(100 - pct)`; reset times `white_dim`; effort by level (`effort_color`: low/minimal green, medium/normal orange, else strong red). Separators `DIM` (`38;5;238`).
2. five bundled palettes in `PALETTES`: `default`, `dracula`, `nord`, `solarized`, `catppuccin`. Each is a dict of the same 17 semantic names (`yellow, green, orange, red_light, red_strong, gray, cyan, white_dim, yellow_green` plus `bg_*` versions for the bars, `bg_empty`, `white_fg`, `dim_fg`), so a palette is a set of colour roles not tied to segments; the segment-to-role mapping is in `renderer.py`. Config `palette` selects it (`~/.config/aesthetic-statusbar/config.json`). No user-defined palettes: `get_palette` falls back to default for unknown names.
3. 256-colour only (`38;5;N`, `48;5;N`), plus bright white `97`. No depth detection and no NO_COLOR.
4. both: text segments are foreground only; the 5h and 7d progress bars are background-filled cells (`bars.py`): each of the 14 cells has the fill bg (ramp colour) or `bg_empty`, and the percentage text is centred inside the bar (white on fill, dim on empty).
5. separators: configurable string, default ` │ ` in `DIM` (`config.py` `separator`).
6. neighbours: different hue per segment (cyan, yellow, green) plus the `│`.
7. light/dark: not present; a dark-terminal assumption (the Solarized palette just picks darker codes). The bar's percentage text is fixed white or dim, with no contrast calculation.
8. glyphs: `█ ░` for the title text bar, `⚡`, `↑`, `✗`, pets (animated frames, `pets.py`), emoji.
9. an animated pet companion; a watch mode (`watch.py`); a tmux integration (`tmux.py`) and a terminal-title text bar without ANSI (`text_bar`).
10. customisation: `config.json` (palette, pet, `bar_width`, `separator`, `show` toggles per segment, `order` list, `account_labels`), the `aesthetic-statusbar set --palette dracula` and `list palettes` CLI.

## thanhnhoncntt/oxen-pet
https://github.com/thanhnhoncntt/oxen-pet (stars 2)
Mostly not a statusline: a Claude Code mod with a pixel pet above the prompt and an RPG-style HUD (HP/MP/ST bars) below it.
1. by bar and by threshold. `plugins/oxen-pet/hooks/hud.ts:132-136`: each fill is a `[dark, bright]` pair: green `0x166534/0x4ade80`, yellow `a16207/facc15`, red `991b1b/f87171`, blue `3b5bdb/a78bfa`, gold `b45309/fbbf24`. HP (context left) is green above 50%, yellow above 25%, else red; MP (5-hour limit) is blue, red below 15%; ST (weekly) is gold, red below 15% (lines 212-252). Labels: HP `#f87171`, MP `#7aa7ff`, ST `#fbbf24`. Readings are bold in the bar's bright colour; details are grey. A pet theme may recolour a bar (`BarLook {label, color, fill}`) but warning colours always win.
2. pet themes: built-in `luffy` (default), `slime`, `duck`, `alien`, and user `<name>.theme.json` files in `~/.claude/oxen-pet/themes/` or a custom folder (`theme.ts`, documented in `skills/oxen-pet/FORMAT.md`). The theme is a pixel sprite, a character-to-hex palette, eyes, props, per-mode forms, and an optional `HudLook`. It is not a statusline colour theme.
3. `#rrggbb` hex only (`color()` accepts `#rgb` or `#rrggbb`); the host draws it. NO_COLOR not present.
4. the bars are drawn as pixel canvases (half-block cells) with two-tone fills; text is foreground only.
5. separators: not present; a frame colour (`frameColor`, `FRAME_COLOR`) around the HUD.
6. neighbours: different bar hue per resource (green or red, blue, gold).
7. light/dark: `lightdark.detection` hits were counted; the HUD colours are fixed bright-on-dark; not examined further.
8. glyphs: `♥ ⚠ ✦ ◆` labels, pixel sprites; emoji.
9. animated pixel pet acting out tool calls, a pace mark on the bars, gradient fills, a theme preview HTML builder (`tools/preview/build.mjs`).
10. customisation: plugin settings (theme, custom folder, status line text on or off, name files and commands), `/pet theme <name>`, Claude can author theme JSON.

## thrownlemon/claude-code-plugins
https://github.com/ThrownLemon/claude-code-plugins (stars 2)
1. by widget name, through the theme. `plugins/ultimate-statusline/themes/default.json` maps widget names to `{fg, bg?, bold?}`: model cyan bold, git_branch magenta, git_clean green, git_dirty yellow, cost magenta, time blue, mcp_ok green, mcp_error red, directory blue, separator gray. Context uses the three keys `context_low/mid/high` (green, yellow, red) by threshold `thresholds.low/mid/high` default 50/75/90 (`scripts/statusline.sh:220-233`); session cost is flagged at `thresholds.session` (default 10). Only the `fg` of the context key is used in the code I read (`jq '.colors.context_high.fg'`), so a theme's `bg` for it is ignored.
2. seven theme files listed: `default, gruvbox, nord, rose-pine, tokyo-night, powerline` (read) plus `cyberpunk` (name only). Format: JSON per-widget colour map `colors{widget:{fg,bg,bold}}` plus a `powerline{separator, separator_thin}` pair. The nord, gruvbox and other themes reuse the same widget keys with other ANSI names. Users add `themes/<name>.json`; selection by `"theme"` in the config.
3. ANSI 16 names only (`black ... white, gray, bright_*`) in `scripts/lib/colors.sh` `fg_color` and `bg_color` (bg has no bright variants); no 256 or truecolor, so the "nord", "gruvbox" themes only approximate through the user's own palette. No NO_COLOR.
4. foreground only in practice; the `powerline` theme defines `bg` for each widget (`white on blue`, `black on green`...), applied by `theme_color` where a widget uses it.
5. separators: plain ` │ ` by default (`widgets.separator.char`); with `"powerline": true` the separator is the single `` string from the config (`get_separator`, `lib/config.sh:140`), a plain uncoloured character: arrow colours are not derived from adjacent backgrounds, so it is not a true powerline transition.
6. neighbours: different hue per widget and the separator.
7. light/dark: not present.
8. glyphs: emoji icons per widget (`model_emoji`, `thinking_enabled` 🧠, `rate_limit_percent` 🚦, ...), configurable per widget; `█ ░` bars via `progress_bar`.
9. widgets can be reordered in `default-config.json` (`lines` of widget names); mentions gradient in the scanner (progress bars).
10. customisation: `config/default-config.json` (widget list, icons, thresholds, theme, powerline, padding), per-user config, theme JSON files.

## tsingke/claude-code-statusline
https://github.com/tsingke/claude-code-statusline (stars 2)
1. by field and by threshold, via the theme. `scripts/statusline.sh:24-74`: each theme sets SGR codes for `C_MODEL`, `C_DIR`, `C_AGENT`, `C_EFFORT`, `C_THINK` (dim italic) and three state colours `C_GREEN/YELLOW/RED`. Context percentage (line 139): <=50 green, 51-80 yellow, >80 red. Default theme: model bold magenta `1;35`, dir blue `34`, agent yellow `33`, effort cyan `36`. Duration, `fast` and effort all share `C_EFFORT`.
2. ten bundled themes in a `case` statement: `default, ocean, monokai, minimal, neon, forest, nord, lavender, gruvbox, sakura` (`statusline.sh`, plus an HTML preview in `screenshots/`). Format: per-field SGR codes, not a semantic palette; they use ANSI-16 codes, so "nord" or "monokai" are only names. No user-defined themes except by editing the script. A `statusline-config.sh` command writes the config.
3. ANSI 16 SGR codes (`30-37`, `90-97`, with `1;`, `2;3;` modifiers). No depth detection, no NO_COLOR.
4. foreground only.
5. separators: a configurable character (default `|`, config `separator`) drawn with `SEP_DIM` `2` (dim).
6. neighbours: different hue per field, plus the dim separator.
7. light/dark: not present (`minimal` theme uses white `37`/`1;37`, which would be invisible on a light terminal).
8. glyphs: emoji count 11 (scanner); the line itself uses text words `think`, `fast`.
9. field visibility is configurable (`show` list).
10. customisation: `~/.claude/statusline-config.json` with `theme`, `separator`, `show`; `statusline-config.sh` CLI.

## twok020101/claude-jarvis
https://github.com/twok020101/claude-jarvis (stars 2)
Mostly not a statusline: a Claude Code mod with a "Stark Industries" HUD (arc reactor, rounds). Its `extras/statusline-command.sh` is an optional plain statusline.
1. HUD: a fixed palette `jarvis/hooks/theme.ts` `C`: arc cyan `#00E5FF`, arcDim `#0A6E80`, arcDeep `#06343D`, gold `#FFC940`, red `#E62429`, white `#E8FBFF`, ok `#3DFFB0`, grid `#1C3A44`. The reactor load tone (hud.tsx:29): >=85% red, >=60% gold, else arcDim. Step pipes: error red, ok green-cyan, running arc, idle arcDeep. A heartbeat glyph pulses by `mix(arcDim, arc, (sin(tick/8)+1)/2)`. The extras statusline is dim grey for the whole line (`\033[2m[cwd | branch] model | ctx:N%`) with no per-segment colour.
2. one palette, no switching or user themes.
3. `#rrggbb` for the HUD; ANSI dim `2` only for the extras line. NO_COLOR not present.
4. foreground only.
5. separators: ` | ` in the extras line; none in the HUD.
6. neighbours: not a concern in the plain line.
7. light/dark: not present.
8. glyphs: `◉ ⤷ ◆ ▶ ✓ ✗ ⇢`, box characters (302 box signals), Stark-themed phrases (`PHRASES`).
9. animation: the pulse blend via `mix()` (a colour lerp helper) and a phrase rotation per mode (`MODE_LABEL`).
10. customisation: none found.

## useronezero/claude-statusbar
https://github.com/useronezero/claude-statusbar (stars 2)
1. fixed per segment, with a threshold bar. `statusline.sh:12-23`, Catppuccin Mocha truecolor: directory pink `245;194;231`, branch and model lavender `180;190;254`, separator ` | ` grey `108;112;134`. Spend `$spent/$balance`: yellow `249;226;175`, green `166;227;161` (line 281). Usage bars (`make_bar`): `●` filled, `○` empty (empty in dim `69;71;90`), colour by remaining percent: >60 green, >30 yellow, else red `243;139;168`.
2. themes: not present; the single Catppuccin palette is in the script (the scanner's theme name `catppuccin` is only that).
3. truecolor `38;2` only; no depth detection or NO_COLOR.
4. foreground only.
5. separators: grey ` | ` (plain character).
6. neighbours: separator, plus pink dir and lavender for branch and model (the latter two share a hue).
7. light/dark: not present.
8. glyphs: `●/○` bars; the branch has a leading private-use glyph (`LAVENDER` ` ${branch}`, probably a Nerd Font branch icon; codepoint unchecked).
9. none beyond the bars.
10. customisation: edit the script.

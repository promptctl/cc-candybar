## claude-code-line
https://github.com/yasir-ali9/claude-code-line (stars 1)
1. Fixed per widget by default, user-pickable per widget, plus state colour on usage. Defaults: name/model/tokens/effort/rate5h/rate7d/extra all `WHITE` (`widgets/*.ts`: `const c = color ? paletteToAnsi(color) : WHITE`); git branch `DIM` with `+N`/`-N` always GREEN/RED (`widgets/git.ts:21-38`); separators `DIM`. `usageColor(pct)` (`renderer/ansi.ts`) is >=90 RED, >=70 ORANGE, >=50 YELLOW, else GREEN, but only the Extra widget calls it (`widgets/extra.ts:14`). Every widget can be overridden to one of 8 palette names via `WidgetConfig.color` (`types.ts`). No per-position colouring.
2. One built-in "default" theme and a "custom" theme (`Config.theme: 'default' | 'custom'`, `types.ts`). Custom = chosen widgets, order, colour names, formats. The format is a per-widget colour name from a closed set of 8 (white, dim, orange, green, cyan, red, yellow, blue) plus `default`. No semantic roles, no user-defined colours.
3. Truecolor only, hardcoded RGB in `renderer/ansi.ts` (e.g. ORANGE `38;2;255;176;85`, GREEN `38;2;0;160;0`, CYAN `38;2;46;149;153`). No depth detection, no downsampling, no NO_COLOR handling found.
4. Foreground-only text on the terminal's own background. No `48;` sequences anywhere in the renderer.
5. Plain text separator `DIM + " | "` (`SEP`, `ansi.ts`). The one exception is name+git, which are joined with no separator (`renderer/index.ts`: `noSep`, so it reads `name@main(+1 -2)`). Separator colour is fixed dim.
6. Neighbours are told apart by the dim ` | ` only; with the default theme almost every widget is the same WHITE.
7. Not present. Fixed RGB values with no background detection. The only readability aid is the user-selectable palette, and `dim` is the SGR 2 attribute, which adapts to the terminal.
8. Box-drawing bar glyphs (`▓░`, `█░`, `[▓░]`; `types.ts` `BarStyle`). No Nerd Font, no emoji, no ASCII fallback mode.
9. An Ink TUI configurator (`app/tui/screens/palette.tsx`) with a colour picker that previews each colour in its own hex; presets are not present. Format options: tokenFormat (`bar+tokens+pct`, `tokens+pct`, `tokens`), rateFormat (`bar+pct`, `pct`), barStyle (`slider`, `block`, `bracket`).
10. Config is JSON written by the TUI (`claude-code-line` with no args opens it, "Save to Claude Code" writes settings.json). Per-widget settings are type, colour, formats, order and visibility. No env vars or flags found. README.md.

## statusline-builder
https://github.com/YH-Seo/statusline-builder (stars 1)
1. Fixed per segment kind, with a colour the user can change on each instance. Each `SegmentDef` has a default colour from the const palette `C` (`src/lib/segments.ts:264-274`): model coral `#d97757`; cwd/project_dir blue `#61afef`; git_branch/vim_mode/cost/lines_changed green `#98c379`; git_status/effort/fast_mode/rate_limit_5h/rate_limit_7d yellow `#e5c07b`; session_name/agent/thinking/pr purple `#c678dd`; output_style/worktree/context cyan `#56b6c2`; model_id/version/repo/duration/clock/user_host gray `#7f848e`. Each segment holds `fg` and `bg`, both defaulting to the same colour. There is no threshold or state colouring: context and rate-limit segments never change colour with usage.
2. Presets are layouts, not palettes (`src/lib/presets.ts`: minimal, developer, powerline, budget, context, everything). Only the `powerline` preset sets colours: bg coral/blue/green/cyan/yellow with fg `#16181d`. The user edits any segment's fg/bg freely, and there are SWATCHES in `Inspector.tsx:17`. The config is shared as a URL diff against defaults (`?c=`).
3. Output is 24-bit only: `ESC[38;2;r;g;bm` and `ESC[48;2;...` (`src/lib/generate.ts:263-276`). Colour input is hex. No depth detection, no downsampling, no NO_COLOR in the generated script.
4. Mode-dependent. `separator: 'powerline'` gives background-filled cells (fg + bg). `plain`, `space` and `custom` give foreground-only text (`generate.ts` non-powerline branch emits only `38;2`, so `bg` is ignored).
5. `powerline` (U+E0B0 `POWERLINE_GLYPH`, `render.ts`) draws the arrow with fg = previous cell's bg and bg = next cell's bg, closing with the arrow on the default background (`generate.ts:263,271`). Other modes: `plain` ` | `, `space` two spaces, `custom` free text. Non-powerline separators take `cfg.separatorColor` (default `#4b5263`). Powerline arrows are not user-coloured because they are derived from the cell backgrounds.
6. Powerline mode: different background hue per segment (preset: coral, blue, green, cyan, yellow). Other modes: separator character only; `bold` is an optional global flag.
7. `Config.terminalBg` (default `#16181d`, `presets.ts:36`) is only used to paint the browser preview. The generated script does no contrast calculation or light/dark detection.
8. Emoji icons per segment (the `icon` field, e.g. 📁 🌿 🧠 💰 ⏱ in the presets); the powerline preset uses a Nerd Font branch glyph. Box glyph bars in five `BarStyle`s (`shaded`, `solid`, `dots`, `line`, `ascii`), one of which is ASCII-only.
9. This is a web builder (Vite/React, GitHub Pages) with live preview against four sample payloads, an English/Korean UI, and a `?c=` share link written into the generated script header. Generated bash targets bash 3.2, with jq or python3 parsing.
10. Customisation is entirely in the builder UI. The output is a standalone `statusline.sh` plus the settings.json snippet (`generate.ts`). Per segment: icon, suffix, fg, bg, options (pathStyle, decimals, width, barStyle, rateShow, timeStyle, hideWhenEmpty). Global: separator, customSeparator, separatorColor, bold, padding, refreshInterval, cacheGit, parser.

## claude-rpg-statusline
https://github.com/yukurash/claude-rpg-statusline (stars 1)
1. By state/threshold, plus fixed roles. `PALETTE` in `lib/color.js` has six names: green, yellow, red, dim, border (blue), accent (gold). `byPct(text, pct)` returns red at >=85, yellow at >=60, otherwise green (`THRESHOLDS`, `color.js`); gauges and numbers use it (`render.js meterRow`, keyed on usage even though the bar shows what is LEFT). The window frame is always `border` blue, and the cursor row and labels `accent` gold. Unknown values are dim.
2. Two themes selected by `CCRPG_THEME=rpg|plain` (README table). These change the frame and fiction (double-line "Dragon Quest" window vs a single-line plain frame; `render.js FRAME`), not the palette. No user-defined colours.
3. Truecolor and 256 index per name (`{rgb, xterm}` pairs in `color.js`), with `detectMode()`: `CCRPG_COLOR` override (none/off/truecolor/24bit/256), then `NO_COLOR` set means none, then `COLORTERM` truecolor/24bit, then `TERM` containing 256, `dumb` means none. The fallback assumes truecolor.
4. Foreground only (`\x1b[38;2` / `38;5`). Box-drawing characters do the structure.
5. No separators between segments; a table layout instead, with frame glyph sets `unicode` ╔═╗║, `plain` ┌─┐│ and `ascii` +-=| (`render.js FRAME`). Borders are `c.border(...)`.
6. Table rows and columns. Hue differs only by role (frame blue, cursor gold, gauges by threshold).
7. Not present as adaptation. The comment in `color.js` says colour never affects layout (widths are computed before wrapping), and the README says to use `CCRPG_COLOR` when a terminal can't handle it.
8. Unicode pips `▰▱` by default (`gauge.js`), `CCRPG_GAUGE` picks `pips|bars|orbs|dots`. `CCRPG_ASCII=1` selects the `+-|` frame. Japanese or English labels (`CCRPG_LANG`, `ui.js`). Some emoji.
9. Dragon-Quest-style window with party roster, command menu and cursor (▶) that moves with the last action, "HP" bars that drain as limits are used, optional RPG flourishes (`lib/flourish.js`), and a combat log hook.
10. Environment variables only (`CCRPG_THEME`, `CCRPG_LANG`, `CCRPG_COLOR`, `CCRPG_ASCII`, `CCRPG_GAUGE`, `CCRPG_LAYOUT`, `CCRPG_BRANCH`, `CCRPG_PARTY`, `CCRPG_STATE_DIR`, `CCRPG_DEBUG`) plus an install script (`scripts/install.js --theme plain`). README.md.

## tmux-fuzzyclaw
https://github.com/ZacxDev/tmux-fuzzyclaw (stars 1)
1. The statusline subcommand itself has no colour: `cmd/statusline.go` prints `model | ctx:██░░ N% | +A/-R` with no ANSI. The colour lives in the tmux and dashboard side. Window tabs are coloured by idle time via `ThemeConfig.IdleColorFor` (`internal/config/theme.go`): 8 steps by minutes idle (<10 `#b8bb26`, <30 `#98971a`, <60 `#689d6a`, <120 `#d79921`, <240 `#d65d0e`, <480 `#cc241d`, <1440 `#b16286`, else `#665c54`). The dashboard maps status to colour via `StatusColors` (`internal/tui/styles/colors.go`: active/running green, paused yellow, resumed aqua, waiting orange, done/stale gray, bell bright red).
2. One theme named "gruvbox" (`DefaultTheme()`). The format is a YAML list of `{max_minutes, color}` (`yaml:"idle_colors"`), so users can redefine the scale. It is not a role palette.
3. Hex truecolor (lipgloss/termenv in the dashboard). No explicit depth handling or NO_COLOR code in the files read.
4. Both in the dashboard: `ColorBg #282828`, `ColorBgLight #504945`. The statusline output is plain text.
5. Statusline joins parts with ` | ` and no colour. Not present beyond that.
6. Plain ` | ` only.
7. Not present.
8. Statusline bar uses `█░`. Session lifecycle emoji in the README (●, 🔄, ⏸, ✅).
9. Not a classic statusline: a tmux session dashboard where the statusline command only writes telemetry JSON and emits a minimal line. Idle-time 8-colour Gruvbox scale on window tabs.
10. `fuzzyclaw statusline` (cobra); theme in YAML config (`idle_colors`); README.md.

## claude-statusline (ZGhey)
https://github.com/ZGhey/claude-statusline (stars 1)
1. Fixed per segment, plus thresholds (`statusline-command.sh`): dir CYAN, model YELLOW, duration WHITE, cost MAGENTA, git branch GREEN with `⎇` glyph, `+A` GREEN / `-R` RED. ctx% and the 5h/7d rates use one threshold: >80 RED, >=50 YELLOW, else GREEN (`rate_segment`; ctx block lines 79-86). The rate-limit group is wrapped in DIM.
2. Not present. No themes.
3. Named ANSI 16 only (`\033[36m` etc.). No depth detection or NO_COLOR.
4. Foreground only.
5. Plain dim `│` between groups (`DIM│`), two spaces within a group. The three groups are left (dir, model, ctx, duration, cost), rate limits, and tail (branch, lines).
6. Different hue per segment; group dividers dimmed.
7. Not present. Uses the terminal's own 16-colour palette, so it follows the terminal theme.
8. `⎇` branch glyph (UTF-8 bytes), `│` divider. No emoji, no Nerd Font.
9. Hides cost for subscribers and shows it for API billing (`rate_limits` present means subscriber); rate group is dimmed whole.
10. Script edit only; env `STATUSLINE_SHOW_COST=1`. README.md.

## claude-tmux-status
https://github.com/zino7825/claude-tmux-status (stars 1)
not a Claude statusline: a tmux status-bar/popup tool (`csm`, one Python file) that shows per-session state (waiting, quiet, done, working, unknown) as window-tab colours and a table. It does not install a Claude `statusLine`. For reference, the styling it does: state colours in `csm` (`SGR`: input bold bright red, stall bold bright yellow, done bold bright green, working bright cyan, unknown bright black), tmux tab colours as 256-colour indexes (`colour160` red, `colour214` yellow, `colour35` green, `colour240` grey; `tmux_conf()`), NO_COLOR honoured in the CLI table (`render()`), and Korean/English output.

## bmad-statusline
https://github.com/zRawday/bmad-statusline (stars 1)
1. By workflow/family and by state, not by statusline segment. `src/reader/workflow-colors.cjs` maps each BMAD workflow or agent name to an ANSI 16 escape: dev workflows cyan `\x1b[36m`, review bright red `91`, planning green `32`, product yellow `33`, architecture magenta `35`, research blue `34`, creative bright yellow `93`, documentation bright green `92`, quality/test red `31`, WDS bright blue `94`, builder bright cyan `96`, CIS bright magenta `95` (prefix table `WORKFLOW_PREFIX_COLORS`). Project name colour is a hash: `hashProjectColor(name)` indexes `PROJECT_COLOR_PALETTE` (12 named ANSI colours, `shared-constants.cjs:9-38`), overridable per project in the TUI (`ProjectColorsScreen.js`). The context% gradient is `getGradientColor` over `['brightGreen','green','yellow','brightYellow','brightRed','red']`. Weekly-usage zones map to green/blue/yellow words (`WEEKLY_USAGE_ZONES`).
2. Not present as themes. 3 preset slots save layouts (README), and colours are kept separately.
3. Named ANSI 16 plus bright variants (15 selectable in the TUI). The escape depth is whatever ccstatusline emits; no detection in this package.
4. Foreground only.
5. This is a plugin (custom-command widgets, `defaults.js getWidgetDefinitions`) for the `ccstatusline` host, which owns the layout. Separator styles in `shared-constants.cjs SEPARATOR_VALUES`: `serre` `┃`, `modere` ` ┃ `, `large` `  ┃  `, plus custom (`SeparatorStyleScreen.js`).
6. Colour per workflow family and per project (hash), plus the separator.
7. Not present.
8. Unicode bar and state dot (●), a few emoji; box-drawing separators.
9. State indicator colour across 5 `llm_state`s; a weekly-usage "sweet spot" band that is colour coded; Ink TUI with a per-skill colour editor.
10. TUI-edited `config.json` (widgets, colours, separators, presets); `defaults.js` writes the ccstatusline settings and Claude Code hooks. No colour env vars found.

## claude-code-statusline (rz1989s, GitLab)
https://gitlab.com/rz1989s/claude-code-statusline (stars 1)
1. A fixed colour variable per segment, with the variable's actual colour set by the theme (`lib/display.sh`): model CYAN (line 77); git branch GREEN clean / YELLOW dirty / MAGENTA otherwise (`format_git_branch`, lines 85-97); repo cost GREEN, monthly PINK_BRIGHT, daily TEAL (159-177); block info DIM or BRIGHT_GREEN; MCP BRIGHT_GREEN / YELLOW / RED / DIM by state (200-214); Claude Code version PURPLE; statusline version CYAN; clock LIGHT_ORANGE; submodules DIM/BRIGHT_GREEN; separator DIM. No position-based colouring.
2. Four bundled themes in `lib/themes.sh` (`apply_theme`): classic (ANSI 16 + a few 256 codes), garden (pastel truecolor), catppuccin (Mocha hex, the default) and ocean, plus `custom`. Each theme sets the same ~18 named variables (`CONFIG_RED`, `CONFIG_BLUE`, ... `CONFIG_TEAL`, `CONFIG_GOLD`, `CONFIG_PINK_BRIGHT`, `CONFIG_INDIGO`, `CONFIG_VIOLET`, `CONFIG_LIGHT_BLUE`). Users define their own through `theme.name = "custom"` and per-colour hex in Config.toml, or through inheritance (`apply_inherited_theme`: base theme plus hex overrides for 12 names, `hex_to_ansi`). It is a colour-name palette, not semantic roles: segments reference "CYAN", not "primary".
3. ANSI 16, 256 index and truecolor all appear (classic uses 31-37 and 38;5;N; the others `38;2;r;g;b`). Hex is converted to truecolor via `hex_to_ansi`. No downsampling and no depth or NO_COLOR detection found in `lib/`.
4. Foreground only.
5. A dim configurable separator string (`CONFIG_LINE_SEPARATOR`, `DISPLAY_SEPARATOR` wrapped in `CONFIG_DIM`, `display.sh:311`). No powerline arrows.
6. Different hue per segment role, plus the dim separator.
7. Day/night theme switching: `get_dynamic_theme` picks `CONFIG_THEME_DYNAMIC_DAY_THEME` (default garden) or `..._NIGHT_THEME` (default catppuccin) by time, sun position or prayer times (`is_daytime_by_time/by_sun/by_prayer`). This switches by clock, not by terminal background. No contrast checks.
8. Heavy emoji use (README lists 188 emoji hits; model and branch emoji like `CONFIG_OPUS_EMOJI`, `CONFIG_DIRTY_STATUS_EMOJI`, labels configurable). No Nerd Font or ASCII mode found.
9. Theme gallery with screenshots (`assets/screenshots/*-theme.png`), `preview_theme_colors`, `--test-config`, `--generate-config`. Islamic prayer-time component with its own icon.
10. TOML config (`Config.toml`, `theme.name`, per-colour keys, `ENV_CONFIG_THEME=...` env override, CLI `--generate-config`/`--test-config`), many `CONFIG_*` env-mapped variables. README.md lines 951-1043.

## claude-statusline (callmemorgan)
https://github.com/callmemorgan/claude-statusline (README via jsdelivr; stars n/a)
1. A theme role mapped to segments. `ThemeRoles` (`internal/palette/themes.go`): model, dir, git, changes, duration, cost, dim, ok, warn, crit, agent, vim, accent, session, sep, so each segment has a fixed role and the theme supplies the colour (in catppuccin-mocha: model mauve `#cba6f7`, dir sky, git green, changes peach, duration blue, cost yellow, agent pink, session teal). Bars and percentages use ok/warn/crit by threshold (`warn_at`/`crit_at`, README line 435); `ok_color`/`warn_color`/`crit_color` can be overridden per segment. Per-segment colour overrides can name hex, ANSI names, a 256 index, or a theme role (`model = "accent"`, README 433).
2. Ten bundled themes (README 9 and 291): classic, catppuccin-mocha, nord, dracula, gruvbox-dark, tokyo-night, newsprint, paper, solarized-light, monochrome. Format: a `Theme{ID, Desc, Roles map[string]ThemeColor{Hex, Ansi16}}`. Users override roles in a `[theme_colors]` table over any theme; whole user-defined themes are not shown (unverified).
3. Truecolor hex themes, with nearest xterm-256 and 16-colour fallbacks computed (`internal/palette/depth.go`). `detectDepth()` order: `NO_COLOR` or `TERM=dumb` is none; `COLORTERM`=truecolor/24bit; `TERM_PROGRAM` iTerm.app/ghostty/WezTerm/vscode, `WT_SESSION`; `TERM` containing 256color; else 16. Config `color_depth` overrides, and NO_COLOR still wins over `truecolor`.
4. Foreground only (colour applied to text).
5. Text separators chosen in config: `bar`, `dot`, `slash`, `chevron` (` ❯ `), `powerline` (the glyph, as a coloured character, not a bg arrow), `space`, `custom` (`render.go:57-58`, README 408). Separator colour is the `sep` role (classic leaves it uncoloured).
6. Different hue per role; separators.
7. Light-terminal themes: paper, solarized-light and monochrome are "tuned for light terminal backgrounds" (README 9). Not auto-detected: the user picks. The TUI `v` key renders into the real terminal to check. No text-contrast calculation found.
8. Icons: `icon = "emoji" | "text"` for thinking and fast-mode; twelve bar iconsets (`default`, `blocks`, `dots`, `ascii`, `minimal`, `smooth`, `braille`, `braille-fine`, `shade`, `line`, `slim`, `vertical`).
9. A full Bubble-Tea-style config TUI with live width-aware preview, theme and preset picker, colour swatch picker with hover preview, an animated demo mode, and a context-window trend arrow and projection. Presets (e.g. `cost-tracker`). Targets Claude Code, Antigravity and Pi. Screenshots per theme in assets/.
10. TOML config (`theme`, `separator`, `color_depth`, `[theme_colors]`, `[colors]`, `[settings.<segment>]`), `claude-statusline configure` TUI, plugin segments with a `preview` value, `NO_COLOR`. README.md.

## Usage Bars (claudelines.com)
https://claudelines.com/statuslines/usage-bars (stars n/a)
1. By threshold only: the two bars (ctx and plan) are green `38;2;96;200;112`, amber `38;2;220;180;70` at >=50, red `38;2;225;95;85` at >=80 (script in the page, `bar()`). Labels are uncoloured; the empty track is `\033[2m` dim `░`.
2. Not present.
3. Truecolor only, hardcoded. No detection, no NO_COLOR.
4. Foreground only; bar fill `▓`, track `░`.
5. No separators; the two bars sit on two lines.
6. Not applicable beyond the two lines having the same colour logic.
7. Not present. A DIM track works on any ground.
8. Box glyphs `▓░`; `n/a` text when the value is absent.
9. Full-width bars sized from `$COLUMNS` (`cols - 16`, min 10); pure bash, no jq. It is a gallery entry on claudelines.com (audited, free, 4 installs).
10. Edit the script. No config.

## claude-2x-statusline
https://codeberg.org/Nadav-Fux/claude-2x-statusline (stars 0)
1. By state and threshold, plus a few fixed colours (`engines/node-engine.js`, with the same logic in the bash and python engines). `colorPct(p)` gives >=80 RED, >=50 YELLOW, else GREEN (long-window variant 75/45) and is used on context and rate limits. Fixed: agent name/tasks/`LOCAL` CYAN, cost and `REMOTE` MAGENTA, effort dots and tool counter PURPLE `38;2;178;148;255`, branch DIM, vim mode BLUE (normal) / GREEN. Cache % has green/yellow/red bands at 80/50 (README Color Guide). Badges are background-filled `BG_GREEN/YELLOW/RED/BLUE/GRAY` (256-colour fg+bg pairs, lines 27-31) for peak/off-peak, update notices and "BLOCKED".
2. Not present as themes. A `tier` (minimal/standard/full/multi-cli) selects which segments show, not colours.
3. Mix: ANSI 16 (31-36), 256 (`38;5;255;48;5;28`) and a few truecolor (WHITE, PURPLE). No depth detection and no NO_COLOR found.
4. Both: foreground text for most data, background badges for peak/off-peak and warnings.
5. A dim `·` between metrics and a coloured `▸` that is green off-peak and yellow during peak (README Color Guide).
6. Different hue per segment; the badges stand out by background fill.
7. Not present.
8. Many emoji and Unicode (⚒, ◔, ⚙); battery-style bars in the editor extension.
9. A "peak hours" badge with countdown, a VS Code companion extension (teal/yellow/red by usage), narrator hooks, a doctor command.
10. JSON config (`tier`, `--tier=` flag), `statusline.sh` auto-picks Python, Node or bash engine; installer scripts. README.md.

## claude-code-status-line (crates.io)
https://crates.io/crates/claude-code-status-line (repo https://github.com/ndave92/claude-code-status-line; crate downloads 419; stars n/a)
1. Fixed per section, as alternating colourways in section order (`src/colors.rs`, `colors.json`): `cwd`, `model`, `quota_5h`, `quota_spend`, `cost` are `dark_on_orange` (bg `(217,119,87)`, fg `(38,38,36)`, details `(65,65,62)`); `git`, `context`, `quota_7d` are `orange_on_dark` (bg `(38,38,36)`, fg orange, details `(130,129,122)`). One orange accent for everything, with no threshold colouring in the files read.
2. One built-in palette (`ThemeConfig::default`), written out to `colors.json` and read back from the config dir (`load_theme`, `config.rs:216`). Format: per-section `{background?, foreground, details}` RGB triples plus a `separator` RGB; the user edits the JSON (a test keeps the sample in sync with the defaults). A `background: null` is allowed.
3. 24-bit RGB only (`\x1b[38;2;..`, `\x1b[48;2;..`). No detection or fallback found.
4. Both, switchable: `display.show_background` (default true) drops the backgrounds (`effective_background`, `render.rs:43`), leaving foreground-only.
5. Powerline arrow U+E0B0 when `use_powerline` is on (default false; the arrow is hardcoded, `POWERLINE_ARROW`), with fg = left bg and bg = right bg (`make_powerline_arrow`), the tail arrow on default background. Otherwise a configurable string `segment_separator` (default empty) in the `separator` colour (default `(65,65,62)`), or a fallback "plain arrow" when a section has no bg.
6. Alternation of two colourways: even sections dark on orange, odd sections orange on dark.
7. Not present. Fixed palette tuned for dark terminals.
8. Powerline glyph optional (a Nerd Font is needed for it); a few emoji.
9. Three colour fields per section, `details` for the secondary text inside a segment; multiline mode; a `doctor` command and a setup wizard (`src/setup.rs`).
10. `settings.json` (sections, display options: `multiline`, `use_powerline`, `segment_separator`, `details_separator`, `section_padding`, `show_background`) plus `colors.json`; CLI setup and doctor commands.

## tmux-agent-notifier
https://crates.io/crates/tmux-agent-notifier (stars n/a)
not a Claude statusline: a Rust tool (`tan`) that stores agent state in tmux pane options from Claude/Cursor/Goose hooks and sends bell/desktop notifications. It provides an optional tmux `status-right` snippet (`tmux.statusRight`), and none of the source files contains colour styling.

## claude-statusline (dev.to post, Felipe Elias)
https://dev.to/felipeelias/claude-statusline-a-configurable-status-line-for-claude-code-4da6 (post of https://github.com/felipeelias/claude-statusline; stars n/a)
Same project as the blog entry below; styling read from the repo source (`internal/config/themes.go`, `internal/style/style.go`, `internal/config/config.go`).
1. Fixed per module in the default config (`config.go`): context green, cost green, branch cyan, model bold, directory cyan/blue in minimal; thresholds change the style: context `above 50` yellow, `above 90` red; cost `above 1.0` yellow, `above 5.0` red. Context also has bar markers at 20/30/? in orange 208, orange-red 202 and red. In powerline presets, position decides colour: `colors [5]string` assigned in order to directory, git_branch, model, cost, context.
2. Six built-in presets (`builtinPresets`): default, minimal, pastel-powerline, tokyo-night, gruvbox-rainbow, catppuccin. Format: a per-module style string (Starship-like `fg:#11111b bg:#cba6f7 bold`), each preset a 5-colour list plus threshold colours (warn/high) and a fg. Users can start from a preset in `config.toml` and override any module.
3. Named ANSI 8, 256 codes (`"208"`), `#hex`, and attributes bold/dim/italic/underline (`style.go`). Hex becomes 24-bit. No depth detection or NO_COLOR found.
4. Both: default and minimal are foreground-only; powerline presets fill the background.
5. Powerline arrow E0B0 or rounded caps E0B4/E0B6 (`capsuleFormat`), written into the `format` string as `[glyph](fg:prev bg:next)`; Tokyo Night adds a leading `░▒▓` gradient. The default preset uses ` | `.
6. In powerline presets, five different background colours in order (pink to dark blue for pastel; a dark-to-light ramp for tokyo-night); in flat presets, different foreground hues.
7. Contrast is hand-picked per preset: segFg `#11111b` on pastel catppuccin, `#e3e5e5` on dark tokyo-night, and `""` (terminal default fg) for pastel-powerline. Catppuccin uses darker warn/high colours on its mauve usage cell (`#df8e1d`, `#d20f39`). No automatic detection.
8. Nerd Font glyphs in the powerline presets (branch E0A0, worktree F0E8); the others do not need one (the table says so).
9. `claude-statusline themes` previews presets with mock data, `init` generates a config, `test` iterates. Format strings with inline styled text `[$cost](dim)`. OSC 8 hyperlinks on the directory.
10. `~/.config/claude-statusline/config.toml` (preset, format, per-module style/format/thresholds), CLI (`prompt`, `init`, `themes`, `test`).

## Oh My Posh meets Claude Code (dev.to)
https://dev.to/jandedobbeleer/oh-my-posh-claude-code-66f (stars n/a)
Read from the post only; Oh My Posh's own source was not read. 1. Per segment, by whatever the user's theme config says: each block segment carries `foreground`, `background`, and optional `foreground_templates`/`background_templates` for state (the example git segment turns yellow when dirty, red when ahead and behind). The `claude` segment in the example takes `accent` background and `p:white` foreground. 2. A user-defined `palette` map (example: black, blue, green, orange, red, sapling, white, yellow) referenced as `p:name`, plus `accent_color`; any Oh My Posh theme can be passed with `--config`; bundled themes belong to Oh My Posh generally (unverified for this integration). 3. Hex and palette references; `accent` resolves to a terminal colour (`"accent_color": "32"`). Depth detection and NO_COLOR: unverified (README only). 4. Background-filled segments (diamond style). 5. Segment `style: "diamond"` with `leading_diamond`/`trailing_diamond` glyphs E0B6, E0B0, E0B2, E0B4; colours inside the glyph via tags such as `<parentBackground,background>`. 6. Different background per segment (orange path, green git, accent claude); state templates. 7. `foreground_templates` and palette let the author choose; no automatic contrast: unverified. 8. Nerd Font icons throughout (``, ``, and so on). 9. The `{{ .TokenUsagePercent.Gauge }}` template renders a `▰▰▰▱▱` context gauge; `oh-my-posh claude` has a built-in default statusline (cwd, git, model, gauge). 10. JSON/YAML/TOML Oh My Posh config via `oh-my-posh claude --config <file>`; the post itself shows JSON.

## claude-statusline (felipeelias.github.io blog)
https://felipeelias.github.io/2026/03/17/claude-statusline.html (stars n/a)
Same project as the dev.to entry above (felipeelias/claude-statusline): a blog post whose claims match the source. Details are in that section. Post facts: 6 presets (default and minimal need no Nerd Font; pastel-powerline, tokyo-night, gruvbox-rainbow, catppuccin do); cost thresholds yellow at $1 and red at $5; context bar yellow at 50% and red at 90%; style strings accept named colours, hex, 256-colour codes and attributes (`style = "fg:#11111b bg:#cba6f7 bold"`); config at `~/.config/claude-statusline/config.toml`; Starship-inspired format string `$directory | $git_branch | $model | $cost | $context`.

## gist pZacca statusline-starship.sh
https://gist.github.com/pZacca/00586fcc03b8bee4c72d6f8b9b568ee1 (stars n/a)
1. One dim colour for the whole line (`out="${DIM}..."`), with the context percentage by threshold: <50 green `38;5;78`, <80 yellow `38;5;220`, else red `38;5;196`. 5h/7d are plain dim text.
2. Not present.
3. 256-colour indexes. No detection, no NO_COLOR.
4. Foreground only.
5. Plain ` | ` in dim.
6. Separators only; everything but ctx is the same dim.
7. Not present; dim attribute follows the terminal.
8. None (` *` for a dirty branch).
9. Repo-relative path truncation, and the name hints at Starship but there is no Starship integration in the script.
10. Edit the script.

## gist joaumg (claude-statusline)
https://gist.github.com/joaumg/01c50329304ed27b0e3383d2526237e6 (stars n/a)
1. Fixed per segment: user bold cyan `1;36`, directory bold yellow `1;33`, branch bold magenta `1;35`, model bold blue `1;34`, ctx bold green `1;32` (a fixed colour, not thresholded), elapsed/cost/tokens dim white `2;37`. The 5h and 7d segments are thresholded bold: >=80 red, >=50 yellow, else green (lines 142-170).
2. Not present.
3. Named ANSI 16 with bold. No detection, no NO_COLOR.
4. Foreground only.
5. A dim `·` between segments (`\033[2m·\033[0m`).
6. Different hue per segment plus dim dots.
7. Not present.
8. None (middle dot).
9. Token breakdown line (in/out/cache); reset times beside limits.
10. Edit the script.

## gist sinzin91 (statusline-command.sh)
https://gist.github.com/sinzin91/02b7b24ee87058b5ae78cdf630e3afab (stars n/a)
1. Fixed plus thresholds. `user@host` cyan, directory yellow, branch green with a red `*` when dirty, model magenta in brackets, cost yellow. Context bar: <70 green, 70-84 yellow, >=85 red (`ctx_bar`). Rate limits use a different scale: <75 blue `94`, 75-89 bright magenta `95`, >=90 red (`color_pct`).
2. Not present.
3. Named ANSI 16 (31-37, 90-97). No detection.
4. Foreground only.
5. No separators; line breaks put the data in three rows.
6. Hue per segment and per row.
7. Not present.
8. ASCII bar `[||||····]` with `|` and `·`. No emoji.
9. Three-line layout.
10. Edit the script.

## gist AlexMeuer (Gruvbox Material statusline)
https://gist.github.com/AlexMeuer/03973e03d5a9e83a5bf55cdccd755ba8 (stars n/a)
1. Fixed per segment from one palette, with thresholds on two of them: model blue `#7daea3`, worktree purple `#d3869b`, agent green `#a9b665`, caveman badge bold orange `#e78a4e`. Context: >=90 red, >=70 yellow, else green. Rate limit: red at >=80, else yellow.
2. One hardcoded palette: Gruvbox Material Dark (`c_fg`, `c_red`, `c_green`, `c_yellow`, `c_blue`, `c_purple`, `c_aqua`, `c_orange`, `c_gray`, `c_dim`), R G B strings. Not user-selectable.
3. Truecolor (`38;2`). A `bg()` helper exists but is commented out. No detection or NO_COLOR.
4. Foreground only ("borderless style" in the comments).
5. A `│` (U+2502) in `c_dim` `#32302f`, a near-background colour so the divider recedes.
6. Different hue per segment and a faint divider.
7. Fixed to a dark palette; the dim separator colour assumes a dark ground.
8. `●○` circle bars (10 steps) for context and rate limit; no emoji.
9. Optional "caveman" mode badge read from a flag file.
10. Edit the script.

## gist yoshikouki (statusline.tsx usage bars)
https://gist.github.com/yoshikouki/0ad989928cb23920631df191a0e07d51 (stars n/a)
1. By threshold: `pctColors(pct)` gives green below 50, yellow below 80, red otherwise, and returns three values: fg name, a bright background method and a normal background method (`bgGreenBright`/`bgGreen`, etc.). Labels (`ctx`, `5h`, `week`) take the fg colour; the model and cwd are `chalk.dim`.
2. Not present.
3. Chalk with `new Chalk({ level: 3 })`, forcing truecolor output because stdout is piped; named colours map to ANSI 16 (bright variants for "used"). No NO_COLOR.
4. Background-filled bar cells (black text on a green/yellow/red background) with plain foreground labels. Each cell is a self-contained chalk string.
5. Two spaces between bars; no separator glyphs.
6. Not applicable.
7. Not present.
8. The bar uses `░` for unused cells; the percentage label is drawn over the bar in the same background so the bar is not interrupted.
9. A two-tone bar: bright background for usage, normal-tone background for elapsed time of the window (README "bar reading"), so pacing can be seen; cache refresh with `~` for stale data.
10. Edit the script; `install.sh` and `fetch-usage.ts` are in the gist. Readme in Japanese.

## gist Chris7Ji (one-click installer)
https://gist.github.com/Chris7Ji/0b6dca53a60d8cf83665836e94a5267f (stars n/a)
1. Two palettes selected by background (`install-statusline.sh`, lines 160-182), each a role-to-colour dict used by the embedded Python statusline: roles are model, model_backend, effort, dir, branch, staged, modified, ahead, behind, ok, warn, danger, sec, sep, cost, style, rate, ver, time, think, vim, agent, worktree, session, warn200k, api. Dark: bright ANSI (model `B_CYAN`, dir `B_WHITE`, branch `B_MAGENTA`, cost `B_YELLOW`, agent `B_BLUE`). Light: plain ANSI (model `C_CYAN`, dir `C_BLUE`, branch `C_MAGENTA`). Thresholds `PCT_WARN`/`PCT_DANGER` colour bars and percentages with ok/warn/danger (`pct_color`, `build_bar`).
2. Two bundled palettes, dark and light, as semantic role maps (above). User-defined: not present (edit the script).
3. Named ANSI 16 plus the bright 90-97 range. No depth detection, no NO_COLOR.
4. Foreground only.
5. A grey separator (`sep` role) between segments, with a priority-based layout that drops low-priority segments by width (`segments.append((priority, text))`, `get_terminal_width`).
6. Hue per role and the grey separator.
7. This is the strongest light/dark logic in the batch. `detect_dark_mode()`: `CC_STATUSLINE_THEME` override (dark/light), then `COLORFGBG` (background index < 8 is dark), then Ghostty config (`background =` luminance via `_luminance`, or a `theme` name containing light/dark), then Claude Code's own `theme` in settings.json, else dark.
8. Emoji icons (🧠 🤖 🌳 🕐 🐇 ⚡ ⚠️) with a `USE_EMOJI` flag and text fallbacks (`think`, `wt:`, `!`); `█░` bar.
9. Windows, macOS and Linux installers, a self-healing SessionStart hook; width-aware segment dropping.
10. Env `CC_STATUSLINE_THEME`; `USE_EMOJI` constant in the script; Chinese README.

## gist MartinKravec (usage limits statusline)
https://gist.github.com/MartinKravec/0c5de92db641f6dc11971fe07cf6749b (stars n/a)
1. Fixed plus thresholds: directory cyan `36`, branch yellow `33` with a Nerd Font glyph, model dim, effort magenta `35`. Context remaining: >=30 green, 10-29 yellow, else red. Usage 5h/7d: <70 green, 70-89 yellow, >=90 red.
2. Not present.
3. Named ANSI 16. No detection.
4. Foreground only.
5. Single spaces between segments, no separator glyph.
6. Different hue per segment.
7. Not present. Using the terminal's palette means it follows the terminal theme.
8. A Nerd Font branch glyph `\xef\x9c\xa8`; the README says to replace it with `git:` if it shows a box.
9. Writes the rate-limit JSON to `~/.claude/usage-cache.json` for a menu-bar companion.
10. Edit the script. README.md with screenshot.

## gist hectorromerodev (settings.json)
https://gist.github.com/hectorromerodev/111fb7915e72473b98c80cdcbeda8472 (stars n/a)
not a statusline: a Claude Code `settings.json` whose `statusLine.command` runs an external `cc-statusline` binary (`~/.bun/bin/cc-statusline`); the gist contains no styling code for it. Its only related field is `"theme": "auto"`, Claude Code's own UI theme. Styling of `cc-statusline` itself: unverified.

## gist ylgibby (ccstatusline setup)
https://gist.github.com/ylgibby/1186889c29d4c2072ef0b19b38829058 (stars n/a)
1. A fixed colour name per widget in a ccstatusline config (`~/.config/ccstatusline/settings.json`, version 3): model cyan, cwd basename blue, git (custom) magenta, context length/window/percentage green, session clock white, 5h and 7d usage yellow, cost green, version `gradient:atlas`, update-available red. The widgets are the host's, with custom-command shell scripts for git (`⎇ branch !N ?N`), usage (`5h 31%`) and a version-check arrow. No threshold colouring in this config.
2. Not present in the gist. The host (ccstatusline) is a separate project.
3. `colorLevel: 3` = truecolor, `2` = 256 colours (as the gist's notes say). Colour names are ccstatusline's. NO_COLOR: unverified.
4. Foreground only (powerline is `enabled: false`).
5. Plain `separator` widgets between every segment; `inheritSeparatorColors: false`. Powerline settings are present but off (`separators`, `startCaps`, `endCaps`).
6. Different hue per widget plus separators.
7. Not present.
8. Unicode: `⎇` branch, `↑` update arrow. No emoji.
9. A named gradient colour (`gradient:atlas`) on the version widget; `flexMode: "full"`, `compactThreshold: 60`; `globalBold`.
10. The ccstatusline JSON config plus `npx ccstatusline` TUI editor, and `statusLine.refreshInterval: 10` in Claude Code's settings.

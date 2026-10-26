## deimos-deimos/claude-statusline
https://github.com/deimos-deimos/claude-statusline — stars 0
Not a renderer: a personal config repo for the npm package `ccstatusline` (sirmalloc's). It pins `ccstatusline@2.2.29` (`install.sh:VERSION`) and ships one settings file. All styling is ccstatusline's; only the config's choices are recorded here.
1. Fixed per segment, set by hand in `ccstatusline.json` widget `color` keys: model=cyan, context-percentage=blue, "5h left: " label + session-usage=green, "Week left: " label + weekly-usage=yellow, thinking-effort=magenta. No threshold or state colouring in this config.
2. Themes: none used. `powerline.enabled:false`, no `powerline.theme`. (ccstatusline itself bundles powerline themes; not exercised here.)
3. Colour spec: `"colorLevel": 2` (ccstatusline's 256-colour mode); colours are named ANSI words (`cyan`, `blue`, ...). NO_COLOR: not present in this repo.
4. Fill: foreground-only (no `backgroundColor` on any widget).
5. Separators: plain `separator` widgets between segments; `powerline.separators:[""]` unused; `inheritSeparatorColors:false`.
6. Neighbours: a different named hue per segment plus `separator` widgets.
7. Light/dark: not present.
8. Icons: three emoji-class glyphs counted by the scanner, none visible in `ccstatusline.json` (likely in the install script's echo text). No Nerd Font use.
9. Other: `flexMode:"full-minus-40"`, `compactThreshold:60`, `globalBold:false`. `merge:true` on the label widgets glues a custom-text label to its value so they share one cell.
10. Customisation: `ccstatusline.json` copied by `install.sh` to `~/.config/ccstatusline/settings.json`; `CCSTATUSLINE_VERSION` env pins the version.

## demigod97/claude-statusline
https://github.com/demigod97/claude-statusline — stars 0
Single-file Python powerline renderer, stdlib only (`powerline.py`).
1. Theme role per segment, then state colour on the second line. Line 1 segments are keyed (`dir, git, model, session, context, rate, tokens, lines, vim, duration`) and each key maps to a `{bg, fg}` pair in the active theme (`THEMES`, `powerline.py:71-140`). Line 2 context and rate bars use thresholds: `context_fg` >=90 `#ff5050`, >=75 `#ffc832`, >=50 `#ffff64`, else `#64ff64`; `rate_fg` uses 80/60/40 with the same four colours (`:150-165`). Tokens, duration and lines on line 2 take the theme's `fg` for their key. Vim mode uses the theme's `vim` pair.
2. Four bundled themes in `THEMES`: `dark`, `nord`, `tokyonight`, `gruvbox`. Format: per-segment colour map of `{bg, fg}` hex pairs, not semantic roles. User choice is `theme` in `~/.claude/statusline/config.json`; users cannot add themes without editing the Python (unknown name falls back to `dark`, `:585`). Config also takes `style`, `path_levels`, `bar_width`.
3. Truecolor hex only: `ansi_fg/ansi_bg` write `38;2;r;g;b` / `48;2;...` (`:57-63`). No depth detection, no downsampling, no NO_COLOR.
4. Fill: background-filled in `powerline` and `capsule` styles on line 1; `tui` style draws foreground-only text in a box; line 2 is foreground-only.
5. Separators: three styles chosen by `style`: `powerline` (U+E0B0, fg = this segment's bg, bg = next segment's bg, `render_powerline_line :478-500`), `capsule` (rounded U+E0B6/U+E0B4 caps per segment, `:504`), `tui` (heavy box-drawing frame `┏┓┗┛` bordered in the model segment's fg, `:528`). Line 2 uses a dim `│`.
6. Neighbours: each segment has its own bg, usually a different dark shade per key (e.g. dark theme: dir `#8b4513`, git `#444444`, model `#1a1a1a`, session `#000000`); fg hue differs per key. No alternation rule.
7. Light/dark: not present (all four themes are dark). Text colour is hand-picked per segment in the theme table; vim in nord/tokyonight/gruvbox uses dark fg on a bright bg.
8. Icons: Nerd Font glyphs (powerline arrows, branch ``), block-bar `█░`, no ASCII fallback mode.
9. Other: `tui` heavy-box layout; bars coloured by threshold.
10. Customisation: JSON `~/.claude/statusline/config.json` (or `config.json` beside the script), keys `style`, `theme`, `path_levels`, `bar_width` (`:545-575`). Installed by `setup.sh`.

## Demogorgon314/cc-statusline
https://github.com/Demogorgon314/cc-statusline — stars 0
Rust (ratatui configurator), adapted from "kimi-statusline and CCometixLine" (`src/themes.rs:1`).
1. Per segment, colours stored per segment in a config (`ColorConfig {icon, text, background}`, `config.rs`), each theme filling a 14-segment table in `SegmentId::ALL` order (mode, cost, model, output_style, directory, git, context, usage, cache, subagent, session, quota, changes, tps). Fixed hue per segment in the fg-only themes (e.g. `cometix`: `pair(11)` mode yellow, `pair(5)` cost magenta, `pair(14)` model bright cyan, `pair(12)` dir bright blue...). On top of that, state colours inside segments when `colorful` is on: context and quota ramps, and the cache segment's rate colour (`CACHE_STOPS`, `render.rs:208-250`: HSL ramp 0% brick red -> 100% jade). With a background set, `colorful` is forced false (`themes.rs build()`), so the segment's own text colour wins ("a background (powerline) segment ... explicit colors win").
2. Ten bundled themes (`themes.rs BUILTIN`): `claude`, `cometix`, `default`, `minimal`, `gruvbox` (256-index), `nord` (truecolor bg, dark text), `powerline-dark`, `powerline-light`, `powerline-rose-pine`, `powerline-tokyo-night`. Format: per-segment colour map (icon/text/background), plus a separate semantic palette for tokens. Users save their own themes as `<name>.toml` under `themes_dir()` (`load_file`/`save`), which override built-ins by name; custom palettes are JSON files in `palettes/` with a `base` of dark/light and `colors` overrides.
3. Colour spec is an enum `AnsiColor`: `Color16{c16}`, `Color256{c256}`, `Rgb{r,g,b}`, or `Named("#rrggbb" | token)` (`config.rs:218-260`). No depth downsampling. NO_COLOR honoured (also `CC_STATUSLINE_NO_COLOR`): `collect.rs:87-88` sets `ctx.color` false.
4. Fill: both. fg-only presets (`claude`, `cometix`, `default`, `minimal`, `gruvbox`) and background-filled powerline presets (`nord`, `powerline-*`), one-space padding inside a filled cell (`paint_segment`, `render.rs:741`).
5. Separators: `style.separator` is text (` | `, ` │ `, two spaces) or the powerline arrow U+E0B0 (`powerline = separator == POWERLINE_ARROW`, `render.rs:807`). Arrow colours: fg = previous segment's bg, bg = next segment's bg; a trailing arrow closes the last cell (`arrow()`, `:839`). Plain separators use `separator_color` else the palette token `text_muted`.
6. Neighbours: in powerline themes backgrounds ALTERNATE between two shades along the default enabled order "so each arrow shows" (comment on `pl_theme`, `themes.rs:~180`; e.g. powerline-dark bg `(40,42,48)` vs `(62,66,76)`); text hue also varies per segment. `nord` is the exception: a different bg hue per segment, one dark text colour `(46,52,64)`.
7. Light/dark: yes. `appearance.rs` builds a `DARK`/`LIGHT` `Palette` with semantic tokens `text, primary, accent, text_dim, text_muted, success, warning, error` plus a `background`. `palette()` follows Claude Code's own `theme` in `settings.json` when unset or `auto` (`light*` -> LIGHT). `Palette::readable()` nudges a fixed fg toward black/white in 20 steps until WCAG contrast >= 4.5 against that background (`:166`); `on_terminal()` (`render.rs:100`) demotes bright 16-colours on light schemes and runs `readable` on rgb/256 colours, but only for text drawn straight on the terminal (not on a segment background). A unit test asserts contrast >= 4.5 for the tokens.
8. Icons: each segment has a (plain emoji, Nerd Font) pair (`themes.rs icons()`), and a `minimal` variant with symbols (`$`, `Σ`, `◷`); `StyleMode` Plain/NerdFont/Powerline chooses.
9. Other: ratatui TUI configurator (`src/tui/app.rs`), `assets/themes.png` gallery, wrap onto extra lines instead of dropping segments (`style.wrap`), OSC-8 hyperlinks for git PR (`hyperlink`).
10. Customisation: TOML config and theme files, CLI `--theme`, `--width`, subcommands `init`, `list` themes (`main.rs`), TUI editor, env `NO_COLOR`/`CC_STATUSLINE_NO_COLOR`.

## Demonad112/ccstatusline
https://github.com/Demonad112/ccstatusline — stars 0
Not marked a fork by GitHub (`fork:false`), but it is a copy of sirmalloc/ccstatusline (README links that project's star history) with extras, notably gradients. Read in full.
1. Per widget, two layers. Non-powerline: each widget has its own `color` (and optional `backgroundColor`), default from the widget's `getDefaultColor()` (Model=cyan, `Model.ts:14`), falling back to `'white'` (`renderer.ts:260`). Powerline with a theme: BY POSITION. Each themed widget takes `fg[i % n]`/`bg[i % n]` from the theme's 5-entry arrays, with `i = widgetColorIndex` incremented per rendered widget, except a widget merged with the next shares its colour slot (`renderer.ts:309-330`; `powerline-theme-index.ts` counts slots and can continue the index across lines via `continueThemeAcrossLines`). Widgets that preserve intrinsic foreground skip only the fg override (`preservesIntrinsicForeground`). No threshold colouring in the renderer itself.
2. Built-in powerline themes in `POWERLINE_THEMES` (`colors.ts:~313-500`): `custom` (uses each widget's own bg), `nord`, `nord-aurora`, `monokai`, `solarized`, `minimal`, `dracula`, `catppuccin`, `gruvbox`, `onedark`. Format: each theme has three variants keyed by colour level 1/2/3 (16-colour names, 256 `ansi256:N`, truecolor `hex:RRGGBB`), each `{fg:[5], bg:[5]}`: a 5-colour cycle, not roles. Users define their own by choosing `custom` and setting colours per widget; `applyCustomPowerlineTheme` copies a built-in theme's colours onto the widgets as a starting point (`PowerlineThemeSelector.tsx:42`).
3. Three levels via `settings.colorLevel` -> `chalk.level` (`ccstatusline.ts:96`): 1=16, 2=256, 3=truecolor, rebuilt COLOR_MAP per level. Colour strings: names (`red`, `bgBrightBlue`), `ansi256:N`, `hex:RRGGBB`, and `gradient:...`. 16-colour names map to fixed 256 indices (16-231, deliberately not the terminal theme's 0-15) and fixed truecolor hexes in `COLOR_MAP` (`colors.ts:17-58`). Level is a user setting, not auto-detected. NO_COLOR: not present.
4. Fill: both. Foreground-only by default; powerline mode uses `backgroundColor` per widget; a bg colour name converts to its fg twin via `bgToFg` for separators.
5. Separators: non-powerline = plain `separator` widgets; powerline = list of separator glyphs `separators[]` (default U+E0B0) with `separatorInvertBackground[]`, plus `startCaps[]`/`endCaps[]` lists cycled per segment (`PowerlineConfig.ts`). Separator colours derived from neighbours' backgrounds: normal = fg is previous widget's bg (`bgToFg`), bg is next widget's bg; inverted swaps; same-bg neighbours fall back to the widget's own fg (`renderer.ts:605-660`). `inheritSeparatorColors` copies the previous widget's colours to a plain separator.
6. Neighbours: powerline themes cycle 5 background colours with merged widgets sharing one; ends of a line start the cycle again unless `continueThemeAcrossLines`. In non-powerline mode: different named colours per widget. Same-bg neighbours get a thin-style separator using the fg.
7. Light/dark: not present as detection. Each theme hand-pairs fg with bg (dark text on pastel bg, white on saturated). `colors.ts` `getBackgroundColorsForPowerline` drops `bgBlack` for visibility.
8. Icons: emoji in widgets, powerline arrows needing a patched font; `checkPowerlineFonts()` (`powerline.ts:14`) scans OS font directories for Powerline/Nerd fonts and the TUI can install them. `CustomSymbol` widget for user glyphs.
9. Other: GRADIENTS. `gradient:<preset>` (13 presets in `GRADIENT_PRESETS`, `gradient.ts:30-45`: atlas, cristal, teen, mind, morning, vice, passion, fruit, instagram, retro, summer, rainbow, pastel), `gradient:RRGGBB-RRGGBB`, `gradient:hex:...,...`; interpolated in OKLab, applied per character on a widget or the whole line, suppressed at ansi16 (`colors.ts applyColors`). Parens-dim (`dim:'parens'`), bold, global overrides, `autoAlign`, `flex` modes. Full-screen Ink TUI with colour menu (`ColorMenu.tsx`), live preview, powerline theme selector with description per theme.
10. Customisation: JSON settings file edited via Ink TUI (`ccstatusline` with no stdin), per-widget `color`/`backgroundColor`/`bold`/`dim`, `colorLevel`, `defaultPaddingSide`, `powerline.*`. Env `DEBUG_FONT_INSTALL`.

## denfry/claude-code-statusline
https://github.com/denfry/claude-code-statusline — stars 0
Node, one file `statusline.js` (328 lines), multi-row framed panels.
1. Fixed per field from a theme's named slots, plus heat ramps. Slots: `frame, dim, track, label, model, dir, br (branch), dirty, tot, up, dn, add, del, cost` (`statusline.js:34-56`): model=violet, dir=blue, branch=green, dirty-count=yellow, up arrow=orange, down=pink, added=green, deleted=red, cost=yellow (Dracula values). Threshold/state: `heat(t)` is a continuous green->yellow->red RGB ramp (`:58`), applied per cell of the 24-cell context bar (`bar()`, position along the bar), to the context % number, the cache hit % (inverted), and the 5h/7d limit percentages. `del` red + bold "compact soon" warning at `compactWarn` (default 80%).
2. Four bundled themes in `THEMES`: `dracula` (default), `nord`, `catppuccin`, `mono`. Format: flat slot-name -> `[r,g,b]` map. Chosen by `theme` in `~/.claude/statusline.config.json`; unknown name -> dracula. No user-defined theme mechanism besides editing the JS.
3. Truecolor only: `rgb()` writes `38;2;r;g;b` (`:29`). No detection, no downsampling, no NO_COLOR.
4. Fill: foreground-only text (no `48;` sequences anywhere).
5. Separators: dim middle dot `·` (`DOT`) between fields; panels drawn with a `frame`-coloured box-drawing frame (`F()` helper).
6. Neighbours: different hue per slot, plus label column (`lab()` pads labels to 8 cols in the `label` colour) and `track` colour for empty bar cells.
7. Light/dark: not present. Slot colours are fixed per theme (all tuned for dark backgrounds).
8. Icons: Unicode symbols (`▸`, `⎇`, `↑↓`, `●`, `⏱`, `↻`, `⚠`, `Σ`, `█▒`), no Nerd Font; no ASCII mode.
9. Other: framed multi-panel layout (git, setup, plugins, MCP panels togglable), `maxWidth` truncation.
10. Customisation: `~/.claude/statusline.config.json` keys `theme, maxWidth, compactWarn, panels.{git,setup,plugins,mcp}, fields.{git,lines,usage,cache,mode,clock}`; env `CCSL_PANELS=0` turns panels off. Example at `statusline.config.example.json`.

## denipesto/claudegochi
https://github.com/denipesto/claudegochi — stars 0
A Tamagotchi-style pet statusline in Node, with a normal widget mode.
1. By state/threshold plus a 3-tone palette. A theme has `low/mid/high` 256-colour indices and a 7-stop `grad` (`colors.mjs THEMES`: warm `114/179/203`, cool `80/75/170`, mono `250/245/231`). Context widget: bar cells coloured by position along `grad` (`gradientBar`, `colors.mjs:56-69`), percentage coloured by ratio >=0.85 high, >=0.6 mid, else low (`widgets/context.mjs:14`). Limits widget: dots coloured by the same `levelColor` (85/60), and each window's identity letter has its own fixed colour (`limits.mjs:41-46`). Pet face tone: `mute` = gray, `warn`/`danger`/`ok` = theme mid/high/low (`tamagotchi.mjs:81-83`); streak flame uses theme high; XP bar theme low. Separator and meta text dim.
2. Three themes: `warm` (default), `cool`, `mono`. Format: tone triple + gradient array (`THEMES`), not roles. Selected by `petTheme`; no user themes (edit `THEMES`). `tools/theme-preview.mjs` renders them.
3. 256-colour indices (`38;5;N`) plus a few plain ANSI codes (red/green/yellow/cyan/gray 31-36/90-93). No depth detection. NO_COLOR only in `tools/theme-preview.mjs:76` (`isTTY && !NO_COLOR`), not in the statusline.
4. Fill: foreground-only (block glyphs `█▓░` coloured via fg; empty track is `█` in colour 237).
5. Separators: configurable text `separator` (default ` │ `), dimmed.
6. Neighbours: separator text only; widget colours come from the same 3-tone theme so neighbours are not intentionally differentiated.
7. Light/dark: not present (the dim track 237 assumes dark). `mono` theme is a grey ramp.
8. Icons: emoji in places (`🔥` streak), pet drawn from ASCII/Unicode faces (`chars.mjs`); i18n locales.
9. Other: animation at ~1 fps (blink/sleepy `z`) driven by `refreshInterval: 2`; sub-cell eighth-block partial fills (`EIGHTHS`); 10 pet characters.
10. Customisation: `config.json` (loaded in `src/config.mjs`): `widgets`, `separator`, `petTheme`, `petChar`, `lang`, `limitsStyle`, `petAnimate`, `refreshInterval`; CLI `bin/cc-config.mjs` (`ccg theme cool`).

## deniskern/hoobnn-agent-mods
https://github.com/deniskern/hoobnn-agent-mods — stars 0 — FORK OF hoobnn/hoobnn-agent-mods
Differs from parent: nothing. `gh api compare hoobnn:main...deniskern:main` reports `ahead_by: 0`, `behind_by: 7`, no changed files, so the fork carries no styling of its own (a stale snapshot of the parent).

## DenisRupp/Claude-usage-band
https://github.com/DenisRupp/Claude-usage-band — stars 0
Not a statusline: a Claude Code mod (TSX plugin, `hooks/register.tsx`) that draws a "band" above the prompt, with SVG bars in the desktop app and glyphs in the terminal. Styling details for completeness:
1. By state: usage bar fixed blue `USED_HEX #4E85DE` on track `#4F4D49`; context bar coloured by zone (`theme.ts ZONE_HEX`: smart `#4A9C74` green below 250k tokens, dumb `#E2B93B` above, limit `#F2464B` at 90% of window or auto-compact point). Percentage text severity: `error` >=90, `warning` >=70, else `text` theme key (`draw.tsx:84-88`). Stage icons green `#4A9C74`, muted `#97958E`, faint `#5F5E5B`; Claude spark `#D97757`.
2. Themes: not present; palette constants in `theme.ts`. Neutral text uses host theme keys (`text`, `subtle`, `error`, `warning`, `dimColor`), so it follows the user's Claude Code theme.
3. Hex strings for SVG and `<Text color>`; host theme key names for text. Depth/NO_COLOR handled by the host, not here.
4. Fill: bars as filled rects/SVG in the app; `━` / `─` foreground glyphs in the terminal. Panels use `backgroundColor: '#80808014'` (`PANEL_BG_HEX`) only when images are available.
5. Separators: dim `│` between columns; rounded `borderStyle="round"` panels in `borderColor="subtle"`.
6. Neighbours: row labels bold, values coloured by severity.
7. Light/dark: partly, via host theme keys for text; hex constants are fixed.
8. Icons: emoji (`⌛ 📅`), SVG icons, `✓ ⊘ ○` in terminal.
9. Other: SVG images in desktop app, buttons, zone tick at 250k.
10. Customisation: plugin settings via `/config` and `/usage-band` (README "Settings").

## derDere/claude-code-statusline
https://github.com/derDere/claude-code-statusline — stars 0
Python (uv script, depends on `coloraide`), "Powerlevel10k style" bars.
1. Mixed. Fill bars (context, 5h, 7d, cost): hue by state, not by segment: OKLCH ramp green(150) -> yellow(110) at 45% -> orange(62) at 70% -> red(29) at 100% (`RAMP`, `:56-62`), interpolated by `_ramp_at(frac)`. Fixed bars (model, working dir): fixed brand colour `#10475D` (`FIXED_HEX`). Effort bar: a colour per level (`EFFORT_COLORS` OKLCH: low orange, medium green, high blue, xhigh light purple, max rainbow hue sweep, ultracode/wx deep purple). Cost bar is always full but its hue follows the cost.
2. Themes: none. Two palettes (`DARK_PALETTE`, `LIGHT_PALETTE`) that differ in lightness numbers, not a theme system.
3. Colour depth is detected and downsampled: `ColorSupport` MONO/ANSI16/ANSI256/TRUECOLOR (`:196`), `detect_color_caps` reads `COLORTERM`, `TERM` (`*-direct`, `256color`, `dumb` -> MONO) and tmux `client_termfeatures` (`:644-678`). `Ink` subclasses per depth (`RgbInk`, `Ansi256Ink` with nearest-index `_x256`, 16-colour ink, mono ink). Flat blocks at 256 because the cube is too coarse for the lightness gradient; 16-colour picks base SGR hues. Override with `--colors truecolor|256|ansi|mono`. NO_COLOR: not present (TERM dumb gives mono).
4. Fill: background-filled bars (bg = fill/track colour, text on top), powerline end caps.
5. Separators: powerline caps U+E0B0 / U+E0B2 at bar ends and a dim diamond `⬩` (`SEP_RGB (90,100,120)`) between segments.
6. Neighbours: different colours by value, each bar has its own empty-track tint (same hue, low L/C), plus a subtle left->right lightness gradient inside every bar (`DL_FILL .055`, `DL_FIXED .040`, truecolor only), and the diamond separators.
7. Light/dark: yes. `detect_background` reads Claude Code's `theme` from settings.json cascade ("light*" -> light, else dark, `:687-705`); `--light/--dark` override. Light palette flips fill vs track lightness (`l_empty .93`, `dl_fill .12`) and text colours; `_contrast_fg` picks dark or white text by luma (>0.62) (`:189`).
8. Icons: Nerd Font glyphs (`ICON_*` at `:851-857`); powerline caps; no ASCII fallback.
9. Other: OKLCH hue ramp via coloraide with gamut fitting; rainbow `max` effort bar; truecolor warning banner when the terminal is not truecolor (`docs/terminal-truecolor.md`); `preview.py` for screenshots.
10. Customisation: no config file; CLI flags `--light --dark --colors --width --no-scroll --workflows` (`USAGE`).

## derekkinzo/tmux-coding-agents
https://github.com/derekkinzo/tmux-coding-agents — stars 0
not a Claude statusline: tmux plugin that tracks coding-agent panes (Claude, others) via hooks and shows `NEED n  WORK n  IDLE n` in the tmux status bar plus a picker. Styling lives in `lib/render.sh:19-24`: three states, waiting `#dc322f` red icon `!`, working `#cb4b16` orange `▶`, idle `#586e75` grey `·`, emitted as tmux `#[fg=...]` markup, chosen for red/green colour-blind distinguishability and readable without colour via the icon.

## deuxksy/statusline
https://github.com/deuxksy/statusline — stars 0
Go (lipgloss + termenv), multi-provider (Claude, Codex, z.ai, antigravity adapters) with a tray app.
1. Fixed per segment via a palette field per segment, plus threshold colour for quota/context. `ThemePalette` (`internal/render/renderer.go:21-40`): Badge bg/fg, Branch, Repo, Status, Cwd, Hostname, Model, Thinking, Skills, Tool, QuotaLabel, QuotaGood/Warn/Bad, Wait bg/fg. e.g. sleek_dark: branch `#10B981`, repo `#06B6D4`, model `#3B82F6`, thinking `#A855F7`, skills `#EC4899`, tool `#EAB308`, cwd `#64748B`. State: `contextColor` uses configurable `Thresholds.ContextWarning/Critical` -> QuotaWarn/QuotaBad else QuotaGood (`:263`); `quotaColor` remaining >50% good, >=20% warn, else bad (`:274`). A "WAITING" badge is bold fg on `WaitBg` red.
2. Four bundled themes in `themes` map: `sleek_dark`, `light`, `nord`, `monokai-dark`. Format: a semantic-ish palette struct per theme with a segment-specific field for each segment. Selected by `cfg.Theme`; unknown falls back to `sleek_dark`. No user-defined themes (compiled in).
3. Truecolor hex. `init()` forces `lipgloss.SetColorProfile(termenv.TrueColor)` (`:17`), so no detection, no downsampling, NO_COLOR ignored.
4. Fill: mostly foreground-only; only the badge (`BadgeBg`) and the WAITING badge use backgrounds with padding `(0,1)`.
5. Separators: plain text, `" "` between line-1 segments and `" │ "` between the main segments and between quota categories (`strings.Join`).
6. Neighbours: different hue per field and separators.
7. Light/dark: a `light` palette exists (darker hues, e.g. branch `#047857`), chosen by config only; no detection or contrast calculation.
8. Icons: emoji prefixes (`🔒`, `🧠`, `⚡`, `🔧`, `📊`), one Nerd Font branch glyph; no ASCII mode seen.
9. Other: truncate wrap mode by terminal width; tray renderer (`internal/tray/render.go`); Korean comments.
10. Customisation: config file with `Theme`, `Thresholds`, `WrapMode`, item list (`internal/config`); `cmd/statusline` subcommands (collect, tray).

## Dev-MS-Infrastructure-Ops/copyof-claude-code-statusline
https://github.com/Dev-MS-Infrastructure-Ops/copyof-claude-code-statusline — stars 0 — FORK OF rz1989s/claude-code-statusline
Differs from parent: nothing. `gh api compare rz1989s:main...Dev-MS-Infrastructure-Ops:main` reports `ahead_by: 0`, `behind_by: 247`, no changed files. A stale copy; no styling of its own.

## develdj/statusline
https://github.com/develdj/statusline — stars 0
Bash, `statusline-command.sh` (374 lines), multi-line "bars" layout (IN / OUT / SKL / MCP / TOT).
1. Mixed. Bars by threshold: `build_danger_bar` colours each CELL by its position along the bar in four zones (green 38;5;114 up to 50% of the width, yellow 180 to 70%, orange 173 to 85%, red 167 beyond; empty cells 238), so a full bar shows all the zones (`:164-188`); the simpler `build_bar` colours the whole fill by overall % with the same four tones (`:191-208`). Fixed hues elsewhere: model bold bright white, profile tag by profile (base grey 90, ios cyan, web magenta, python yellow, full red; `:77-82`), MCP dot green when all healthy else yellow, skill count magenta, plugin count blue, labels grey, percentages white.
2. Themes: not present. 
3. 16 colours (`\033[9x`, `3x`) plus 256 (`38;5;N`) pastel tones. No detection, no NO_COLOR.
4. Fill: foreground-only.
5. Separators: grey `│` between header segments.
6. Neighbours: different hue per element, grey separators.
7. Light/dark: not present.
8. Icons: emoji (`🔴 CRITICAL`, `🟡 Warning`, `⚙`); mono 3-letter labels instead of icons for the bars.
9. Other: banner text "CRITICAL /compact" at high context; per-profile colour tag.
10. Customisation: edit the script; no config file.

## deviationist/claude-usage
https://github.com/deviationist/claude-usage — stars 0
A zsh function (sourced from `.zshrc`) that prints spend/limit bars from the OAuth usage endpoint; built to be embedded in a statusline. The README names a companion project, `deviationist/claude-statusline`, that renders it inside a Claude Code status line (that project is outside this file).
1. By state: one low/mid/high triple per theme (`clo, cmid, chi`) with amber/red breakpoints (`CLAUDE_USAGE_THRESHOLDS`, default 70:90) colouring each bar by its fill; separators and resets use a `dim` SGR. Everything else is uncoloured.
2. Themes are full-config presets, selected by `--theme NAME` / `CLAUDE_USAGE_THEME` (`devi.zsh:829-900`): `default, mono, ascii, bright, neon, labelled, catppuccin, compact, retro, shade, dots, spark, line, dracula, nord, gruvbox` (16). Format: low/mid/high SGR parameters + bar glyph set (`full:partial:empty`) + brackets + dim colour, some also layout defaults (separators, prefixes, width). Truecolor palettes: catppuccin (Mocha), dracula, nord, gruvbox. Users do not add themes but override each part with `CLAUDE_USAGE_COLORS` (`low:mid:high` raw SGR, e.g. `38;5;46:38;5;226:38;5;196`), `_THRESHOLDS`, `_BAR_CHARS`, `_BRACKETS`, `_DIM`. Explicit values beat the theme.
3. Raw SGR parameter strings: 16-colour (`32/33/31`, bright `92/93/91`), 256 (`38;5;N`), truecolor (`38;2;r;g;b`). No depth detection. NO_COLOR honoured (`:925`: `--no-color` or non-empty `NO_COLOR` blanks all colours and keeps bars; documented at `:79`).
4. Fill: foreground-only glyph bars.
5. Separators: text, per theme/layout (` · `, ` | `, single space), coloured with the `dim` SGR; configurable (`CLAUDE_USAGE_SEP`, `_GROUP_SEP`).
6. Neighbours: separators and per-bar colour state only.
7. Light/dark: not present beyond `mono`/`--no-color`.
8. Icons: none; bar glyph sets from block elements to ASCII (`ascii` theme `#`/`.` with `[ ]`), retro `[====>....]`, dots `●●◑○○`, spark, shade, line.
9. Other: `--themes` previews every theme against live usage; `tools/generate-readme-svg.zsh` makes the screenshot; table mode with per-cell themed bars.
10. Customisation: flags, `CLAUDE_USAGE_*` env vars, config file `~/.config/claude-usage/config` of `KEY=value` lines.

## diakowicz/claude-statusline
https://github.com/diakowicz/claude-statusline — stars 0
Node, `statusline-standalone.js` (138 lines), single line; carries GSD (get-shit-done) task/update hooks.
1. By state. Context bar (10 cells): green (32) <50%, yellow (33) <65%, orange (38;5;208) <80%, else blinking red (`5;31`) with a skull emoji (`:59-62`). Rate-limit bars (5h, 7d): truecolor steps by usage: blue `(99,179,237)` <50, purple `(167,139,250)` <75, pink `(236,72,153)` <90, blinking rose `(251,113,133)` beyond (`:98-101`). For 5h, the time-left text is a continuous RGB gradient blue -> purple -> pink as the window elapses (`:103-123`), blinking under 10 minutes; for 7d it matches the bar colour. Model and directory are dim (`\x1b[2m`), task bold, gsd update notice yellow.
2. Themes: not present.
3. Mixed 16-colour, one 256 (`208`) and truecolor. No detection or NO_COLOR.
4. Fill: foreground-only.
5. Separators: plain ` │ ` text; two spaces between rate segments.
6. Neighbours: separators; colour only by state.
7. Light/dark: not present.
8. Icons: block bars `█░`, `💀`, `⬆`.
9. Other: blinking (SGR 5) for urgency, interpolated gradient on the reset timer.
10. Customisation: edit the file; `install.js` wires it up.

## diegopc99/claude-cli
https://github.com/diegopc99/claude-cli — stars 0
Not a statusline: `orange-hud` is a Claude Code mod (TSX plugin, `register.tsx`, 2219 lines) that draws a collapsible HUD of cards (session, workspace, toolkit, agents). Styling notes: neutrals are host theme keys (`'text'`, `'inactive'`, `'subtle'`, `'userMessageBackground'`) "so a light, ANSI, daltonized or custom theme keeps them readable" (`:41-56`); accent `ORANGE='claude'` (host key), section accents fixed hex (workspace `#7FB77E`, agents `#7AA2F7`, toolkit `#BB9AF7`, kube `#326CE5`; `SECTIONS`, `:1367`); meters coloured by level (`levelColor`: >=85 `error`, >=60 `warning`, else claude orange; `:237`), agent status via `success/error/inactive/warning`; meter glyph `─` on a `subtle` track; round-bordered cards; hover style on controls.

## Digital3D/Claude-usage-bar
https://github.com/Digital3D/Claude-usage-bar — stars 0
Not a statusline: a Claude Code mod (`usage-bar/hooks/register.tsx`, 1991 lines) drawing a band above the prompt with usage, git, cost, activity. Styling notes: threshold colours with user-set colours: `colorOk` default `green`, `colorWarn` `#ff8c00`, `colorDanger` `red`, band `background` `#0d0f14` (`DEFAULTS`, `:89-92`), picked by `colorOf(percent)` against `warnPercent` 50 / `dangerPercent` 90 (`:173`). Fixed: grey `#8a8f98`, added lines `#2e9e44`, removed `#c0392b`, branch `#7f9fc4` ("readable on the band's dark background"). Colours accepted as name, `#rgb`, `#rrggbb`, `rgb(r,g,b)`, `ansi256(n)` (validated at `:1190`), edited through a `/usage-bar config` UI with a live swatch beside each colour field (`:1748`).

## dinhdobathi1992/claude-statusline
https://github.com/dinhdobathi1992/claude-statusline — stars 0
Bash, `statusline.sh` (339 lines) plus `tmux-statusline.sh` (tmux status-bar version with `#[fg=colourN]` markup).
1. Mixed fixed/state. Fixed: values in bright white (`W` 97), separators `|` and secondary text dim grey (90), `+lines` green, `-lines` red (`:208-330`). State: context bar fill green <70, yellow >=70, red >=90 with empty cells grey `░` (`:167-172`); 5h and 7d percentages the same 70/90 thresholds (`:73-99`).
2. Themes: not present.
3. 16-colour SGR (31/32/33/36/90/97); tmux variant uses 256 indices (255, 82, 226, 196, 244). No detection, no NO_COLOR.
4. Fill: foreground-only.
5. Separators: grey `|` between line-2 fields; two spaces between line-1 items.
6. Neighbours: separators; emoji prefix per field (`📂 🌿 📊 🤖 ⚡ 👤 ☘️`).
7. Light/dark: not present.
8. Icons: emoji.
9. Other: none noted.
10. Customisation: edit the script.

## disbitski/claude-code-statusline
https://github.com/disbitski/claude-code-statusline — stars 0
Bash, `statusline-command.sh` (104 lines), one line of `key:value` pairs.
1. Fixed per field plus state. Fixed: `proj:` cyan (36), `model:` bright white (97), `effort:` magenta (35), `ctx/in/out` and version grey (90). State: `left:` (context remaining) red <=10, yellow <=20, else green (`:49-60`); `5h:` and `wk:` blue normally, yellow at >=80% (`:74-98`), never red.
2. Themes: not present.
3. 16-colour SGR only. No detection, no NO_COLOR.
4. Fill: foreground-only.
5. Separators: two spaces between `label:value` pairs; labels are text rather than icons.
6. Neighbours: a different colour per field (cyan, white, magenta, state, grey, blue).
7. Light/dark: not present.
8. Icons: none; ASCII labels.
9. None.
10. Customisation: edit the script; `examples/sample-statusline-input.json` for testing.

## Div0011/Frontend-Pipeline
https://github.com/Div0011/Frontend-Pipeline — stars 0
Not a Claude statusline project: a web-design pipeline / skills monorepo. It vendors a skill, `bencium-marketplace/emotion-statusline`, whose `scripts/statusline-command.sh` is a statusline (170 lines); the rest of the repo (palette scripts, themes, templates) is unrelated website theming. Statusline styling (`:36-166`): 2 lines. Directory bright blue (94), branch bright cyan (96), `+n` bright green (92) / `-n` bright red (91), model plain white (37), tokens blue (34) with dim `│`/`/` separators. Context % by state: bright green <50, bright yellow <80, bright red otherwise. An "emotion" label read from `~/.claude/cache/claude-emotion[-<session>].json` is coloured per emotion name (curious 96, focused 37, satisfied 92, cautious 93, enthusiastic 95, contemplative 34, confident 92, uncertain 33, determined 97, amused 95, concerned 91, relieved 92, calm 36, unknown dim 90;2) and `desperate` is bold bright red with "verify output quality" (`:114-166`). 16-colour SGR only, foreground-only, no themes, no depth detection, no NO_COLOR, no icons.

## dklima/claude-snowball-statusline
https://github.com/dklima/claude-snowball-statusline — stars 0
Bash, `snowball-statusline.sh` (209 lines): one context bar with a "snowball" phase name.
1. By state: one colour for bar, phase word and trend, chosen by context used % at fixed thresholds `THRESHOLD_FLAKE=15, ROLLING=40, STEADY=65, HEAVY=85, AVALANCHE=95` (`:30-34`): flake dim (2), rolling green (32), steady yellow (33), heavy orange (38;5;208), avalanche red (31), frozen bold red (1;31) (`:73-97`). Also names the next message cost ("light", "medium", "heavy", "expensive", "/compact", "DEAD"). Model name in dim brackets.
2. Themes: not present.
3. 16-colour plus one 256-index (208). No detection/NO_COLOR.
4. Fill: foreground-only.
5. Separators: spaces and ` · next ~ `.
6. Neighbours: not applicable (a single coloured group beside a dim model name); `SNOWBALL_SEGMENT_ONLY=1` omits the model so it can be embedded in another statusline.
7. Light/dark: not present.
8. Icons: bar `█` (`BAR_FILLED`) and `░` (`BAR_EMPTY`), width 10.
9. Acceleration trend arrow computed from a per-session log of used %.
10. Customisation: env `SNOWBALL_SEGMENT_ONLY`; thresholds are constants in the script.

## dlepold/cc-statusline-with-unix-prompt
https://github.com/dlepold/cc-statusline-with-unix-prompt — stars 0 — FORK OF chongdashu/cc-statusline
Differs from parent only on the branch `feature/unix-prompt-theme` (2 commits ahead; `main` is level with the parent and merely behind by 21 commits, which is what the scanner read). That branch adds `themes/unix-prompt-statusline.sh` (327 lines), a hand-written script, not a generator option:
1. Line 1 opens with a shell-prompt imitation, `user@host pwd $` in bold red / yellow / cyan / yellow / magenta (`\033[01;31m ... 01;33m@ ... 01;36m ... 01;35m$`, `:233`), then fixed 256-index tones for the rest: git branch soft green 150, model light purple 147, model version 180, Claude Code version 249, output style 245. Line 2 is deliberately all grey 256-tones ("modern sleek", muted): context uses 244/245/242 by remaining % (<=20/<=40/else), usage 245, cost 243, burn rate 240, session timer 245/243/241 by remaining % (<=10/<=25/else). So state is expressed as lightness steps of grey, not hue.
2. No themes; the branch is itself an alternative "theme".
3. 256-index and bold 16-colour. NO_COLOR honoured here (`use_color=0` when `NO_COLOR` is set, `:38-39`).
4. Fill: foreground-only. 5. Separators: two spaces. 6. Neighbours: different hues on line 1, grey tones on line 2. 7. Light/dark: not present. 8. Icons: emoji (`🌿 🤖 📟 🎨 🧠 ⌛ 💰 📊`), ASCII `=`/`-` bar.
9. Context and burn figures use greys on purpose to look calm.
10. Customisation: the script and the parent's generator (npx `init`) as before.

## dlnilsson/claude-tally
https://github.com/dlnilsson/claude-tally — stars 0
not a Claude statusline renderer: a Go program (`main.go`, 99 lines) that reads the statusLine JSON on stdin and stores it in a SQLite table (`status`, JSONB `raw`) for tallying; it prints no coloured text. No styling.

## dMARLAN/claude-config
https://github.com/dMARLAN/claude-config — stars 0
Bash, `statusline-command.sh` (187 lines), personal config.
1. Mixed. Fixed: directory name cyan (36), git branch magenta (35) with a yellow `*` when dirty, model dim grey (90), session peer name blue, session id dim (`:4-12, :143-170`). State: context shown as ONE block glyph `▁▂▃▄▅▆▇█` whose height and colour follow used %: green <25, yellow <50, orange (38;5;208) <75, red beyond (`select_bar_and_color_for_percent`, `:91-110`) with the % number; effort level glyph and colour `○ low` dim, `◔ medium` green, `◑ high` yellow, `◕ xhigh` orange, `● max` red (`:62-66`); sandbox state `◉ sbox` green / `○ sbox` red / `? sbox` dim.
2. Themes: not present. 
3. 16-colour plus one 256-index. No detection/NO_COLOR.
4. Fill: foreground-only.
5. Separators: dim ` • ` (`sep`, `:13`).
6. Neighbours: different hue per segment with dim bullets.
7. Light/dark: not present.
8. Icons: Unicode shapes (`◉ ○ ◔ ◑ ◕ ●`, `▁..█`); no emoji or Nerd Font.
9. A single-glyph gauge in place of a bar.
10. Customisation: edit the script.

## dmitry-do/ai-toolkit-public
https://github.com/dmitry-do/ai-toolkit-public — stars 0
Not primarily a statusline: a plugin toolkit (skills, evals, docs assets). The one statusline is `plugins/session-cost-stamp/scripts/statusline.sh` (47 lines): prints `<dir>  <branch>  •  N% context  •  $X.XX` with no ANSI at all and writes a per-session stash that a SessionEnd hook reads. Styling: none (plain text, `•` separators, no colour, no themes, no icons, no NO_COLOR concern). The hex/theme signals come from `scripts/docs-assets/theme.py`, which styles generated documentation images and is unrelated.

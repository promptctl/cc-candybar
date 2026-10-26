# Batch 13: styling read from source

## paceline
https://github.com/milaroid/paceline (3 stars)
1. By state/threshold plus fixed identity. `paceline/theme.py:load_color` is a 4-step ladder on pct: <50 blue, 50-69 green, 70-89 amber, >=90 red (None -> dim). It colours the bars, the percents, the projected "->N%" and the leading mark glyph (colour of the worst load, `layout.py` ~168). Fixed: labels are `dim`; the agent label is `theme.claude` (orange 230,125,34) or `theme.codex` (grey), `layout.py:172`. Separator ` │ ` is `dim`.
2. Three themes in `theme.py`: dark, light, mono (`THEMES`). Format is a namedtuple of roles: `dim bold italic track blue green amber red accent claude codex` (semantic roles, not per-segment). Not user-definable (only `get(name)`, unknown name -> dark). Config `theme` defaults to `"auto"` (`config.py:6`).
3. Truecolor only (`38;2;r;g;b`, `theme.fg`); no 256/16 path, no downsampling. NO_COLOR: not present (the mono theme is the only colourless route; the theme is chosen by config, not env).
4. Foreground-only on the terminal background, except bar cells: `bars.py:_cell` writes a truecolor background (`48;2`) behind partial eighth-block cells so no terminal bg shows through.
5. Plain ` │ ` in `dim` (`layout.py:_join`). No powerline.
6. Separators only; neighbours differ by the role colour/load colour. No alternating.
7. Best-in-batch light/dark handling. `appearance.py`: `auto` theme reads Claude Code's own `theme` in `settings.json` (resolving `custom:<slug>` to its `base` via `themes/<slug>.json`); "light*" -> light palette, "dark*" -> dark; for `auto`/unknown falls back to `COLORFGBG` (bg 7 or 15 = light) and macOS `defaults read -g AppleInterfaceStyle` (30 s cache, `OS_TTL`). Light palette has darker hues (e.g. green 20,115,60) instead of text-colour picking.
8. Unicode only: eighth-block bars `▏▎▍▌▋▊▉█` (`bars.py`), `│`, `→`, `↻`. Mono bar uses `█▒░`. No Nerd Font, no emoji dependence.
9. Projected-usage shade: the bar paints the pace projection in the same hue mixed 45% toward the track colour (`bars.py:PROJECTED_MIX`, `_mix`). Optional quotes line (`quotes.py`) coloured by the same ladder.
10. JSON-ish config in `config.py` (`theme`, `quotes`, `codex`, `bar_width` 3-20, `countdown_min_load`, `runway_minutes`); installer `scripts/install.py`.

## mv-claude-code-marketplace
https://github.com/mvasilenko/mv-claude-code-marketplace (3 stars)
Not a statusline of its own: a plugin marketplace. Its only styling is a shipped config for the third-party ccstatusline, `config/ccstatusline-settings.json`, so the points below describe that file, not code in this repo.
1. Fixed per widget via `"color"` names: model cyan+bold, session/weekly usage blue, context group green (custom-text pieces `Context: `/`/`/` (`/`)` and the length/window/percentage widgets all green, merged with `merge: no-padding`), git-branch magenta, a custom-command "Skills:" widget brightBlack. No thresholds.
2. Themes: not present (the file sets `powerline.enabled: false`).
3. Named ANSI colours; `colorLevel: 2` (256) in the file. NO_COLOR: not present here (ccstatusline's own behaviour is not read).
4. Foreground-only.
5. Plain ` | ` (`defaultSeparator`); `inheritSeparatorColors: false`.
6. Different hues per widget group (cyan, blue, green, magenta).
7. not present.
8. Plain ASCII text labels, no icons.
9. not present.
10. ccstatusline JSON v4 (`lines`, `flexMode`, `compactThreshold`).

## claude-code-agent-monitor
https://github.com/NeriakTo/claude-code-agent-monitor (3 stars)
A Claude Code mod (band above the prompt + `/monitor` pane), not a classic statusLine command; its band is a one-line statusline-like strip.
1. By state/role. `hooks/view.ts` has `Tone = 'accent'|'ok'|'warn'|'critical'|'muted'|'plain'`; `textProps` (view.ts:37-52) maps tone to named terminal colours only: accent cyan, ok green, warn yellow, critical red, muted `dimColor`, plain none. One table (`statusMark`, `levelTone`) feeds both band and pane. `quotaTone` (view.ts:124): green below `quotaWarnPercent` (70), yellow past it, red past `quotaCriticalPercent`; stale readings gray. Context badge `ctx 44%` same ladder. Labels like INBOX/NOW/QUOTA are `plain` bold.
2. Themes: not present; named colours inherit the terminal palette.
3. Named colour props passed to the mod renderer (Ink-style), so the terminal's own 16 colours; no depth detection in the mod. NO_COLOR: not present. README line 246: the separate `statusLine` text output "is plain text: no colors", every warning carries `!`/`!!`.
4. Foreground-only.
5. ` │ ` in muted tone (`SEPARATOR`, view.ts:144); pane uses box-drawing `╭╮╰╯┊`.
6. Separators and tone only.
7. Because colours are terminal named colours it follows the user's theme; no contrast logic.
8. Deliberate glyph whitelist `●✓✗◌–·│─┊╭╮╰╯■↑↓`, enforced by a test; shading blocks excluded on purpose (README "A glyph whitelist"). State never rests on colour alone (`!`, `!!`).
9. Quiet-until-it-needs-you design: green only below thresholds, stale = gray. Gauge `■■■■■■····`.
10. Mod config values (`quotaWarnPercent`, `contextWarnPercent`, `waitingAlertMinutes` ...), arrange-mode buttons for cards; colours themselves not configurable.

## sessiondeck
https://github.com/NetipunJi/sessiondeck (3 stars)
A Claude Code mod dashboard (panels, raster/SVG charts); also a text statusLine option (`statusLine` config).
1. By role in a palette: `hooks/core.ts` `Colors` = `main agent gate cleared amber warn dim faint text` (+ optional `bg`). Panels use these roles (main=model/context, agent=agents, gate=permission checks, amber/warn=state).
2. Three palettes (`PALETTES`, core.ts:169): `theme` (default), `pastel` (hex, tuned for dark), `dracula` (hex, with `bg #282a36`). Selected by `palette` config via `oneOf` (core.ts:147). Not user-definable beyond choosing one.
3. The `theme` palette is not colour values at all: it names Claude Code's own theme keys: `main:'claude' agent:'suggestion' gate:'success' cleared:'permission' amber:'warning' warn:'error' dim:'inactive' faint:'subtle' text:'text'` (core.ts:170-180), so it follows the user's Claude Code theme including light and colour-blind variants. pastel/dracula are `#rrggbb`. NO_COLOR: not present. SVG path uses fixed mid-tone hex (`SVG_COLORS`, core.ts:208) "that read on light and dark".
4. Both: panels on the host background by default; `bg` painted behind the whole deck only if the palette sets one (dracula, pastel).
5. Panel borders/titles; no powerline.
6. Panel titles with a colour square per series; separation by panel boxes.
7. Theme-key palette is the adaptation mechanism; SVG colours chosen mid-tone for both polarities.
8. Emoji and box glyphs; unicode charts.
9. Raster charts (context/agent history) and SVG in the desktop Code tab; `motion` option (`while-active`/off) for animation; agent grid cell colours by state.
10. Plugin `/config` values parsed in `core.ts:parseConfig` (`palette`, `layout`, `motion`, `charts`, `statusLine` ...).

## soffit
https://github.com/noxcraftdev/soffit (3 stars)
1. Theme role mapped to widgets. `src/theme.rs` defines 7 `PaletteRole`s (primary, accent, success, warning, danger, muted, subtle) as ANSI-256 indices; widgets are external scripts/plugins that receive the resolved palette as JSON (`widgets.rs:198-205`, `ansi(widget_palette.primary)` ...). Per-widget overrides: a widget's TOML `theme` slot can name a role or a raw 0-255 index (`ThemeValue::Role|Custom`, `types.rs`), merged into a per-widget palette (`widgets.rs:125-136`). Legacy field names map green->Success, orange/yellow->Warning, red->Danger, dim->Muted, lgray->Subtle (`widget.rs:142`). README: success = "context bar ok, git clean", warning = "quota approaching", danger = "quota critical".
2. 5 presets in `THEME_PRESETS` (theme.rs): Default, Nord, Warm, Mono, Dracula; each 7 role indices. Users override roles in `[palette]` TOML; unset roles keep defaults. Editor UI (`soffit edit`) exists.
3. ANSI 256 index only (`\x1b[38;5;Nm`, `theme::ansi`); no truecolor, no 16-colour downsample. NO_COLOR: not present (scan saw `env.256color` only).
4. Foreground-only.
5. Plain separator in the `muted` colour (`render.rs:66-71`); width wrap via `join_segments`.
6. Separators only; role colours per widget.
7. not present.
8. Icons per widget overridable (`[statusline_widgets.NAME.icons]`: nerd glyph or ASCII like `"> "`); `bar_style` block/dot/ascii (`BarStyle`); superscript/subscript toggle for version.
9. Desktop/TUI editor (`soffit edit`), `ansi_to_html` for previews (theme.rs).
10. TOML config (`[palette]`, `[statusline_widgets.*]`, `bar_style`), plugin manifests (`examples/plugins/*.toml`).

## pokutuna/claude-plugins
https://github.com/pokutuna/claude-plugins (3 stars)
not a Claude statusline: a personal plugin marketplace. The one statusline-adjacent piece, `limit-usage/bin/statusline-wrapper.sh`, only tees the statusLine JSON into a state file and replays it to the user's original command unchanged; it emits no styling. (`docgen/.../theme.js` is an HTML design system, unrelated.)

## pwdev-claude-marketplace
https://github.com/pwdev-solucoes/pwdev-claude-marketplace (3 stars)
Marketplace; styling lives in `plugins/pwdev-statusline/templates/statusline.sh`.
1. Fixed per segment plus thresholds. Lines 20-36: bold ANSI-16 colours `COLOR_BRAND=GREEN`, `COLOR_USER=WHITE`, `COLOR_SESSION=WHITE`, `COLOR_DIR=BLUE`, `COLOR_MODEL=CYAN`, `COLOR_GIT=MAGENTA`, `COLOR_TOKENS=WHITE`. Context bar (`ctx:██░░`, 10 cells): green <60, yellow 60-79, red >=80 (lines 122-124). 5h rate limit: green <50, yellow 50-79, red >=80 (137-139).
2. Themes: not present; the per-segment `COLOR_*` variables are the edit surface ("editable", rewritten by `/pwdev-statusline:customize`).
3. ANSI-16 bold (`\033[1;3Xm`). No depth detection, NO_COLOR not present.
4. Foreground-only.
5. Plain `SEP=" | "` (line 17), uncoloured.
6. Different hues per segment; separators only otherwise.
7. not present.
8. Text labels `ctx:` `tok:` `5h:`; bar `█░`; dir shortened with `…/`. No icons.
9. `SHOW_*` toggles per segment (lines 6-14).
10. Variables at the top of the script edited by a slash command; no config file.

## claude-quota-gauge
https://github.com/rajanshxrma/claude-quota-gauge (3 stars)
1. By state/intensity plus a per-session identity colour. README ~289: number colours are intensity, green <50, yellow 50-79, red >=80; the glyph/verdict says the kind. Session-title chip: background colour is a hash of the session id into `_TITLE_PALETTE = [39, 208, 141, 172, 205, 220, 41, 203]` (`bin/usage_common.py:1815-1856`), bold black text on `48;5;N`; chosen to differ in hue and lightness for red-green colour-blindness, to avoid pure red (alert) and teal (Claude Code's native chip), with a measured WCAG contrast check in the comments (135 replaced by 141 for contrast 7.73). Ultracode indicator: magenta-to-purple 256 gradient animated per render (`_UC_GRADIENT`, usage_common.py:961-989). Battery cell has its own colour function.
2. Themes: not present as such; `CLAUDE_USAGE_PROGRESS_COLOR` = `calm` (one hue for the row) / `plain` / `accent` / a 256 number (README 706).
3. ANSI 256 (`38;5`/`48;5`), some 16. NO_COLOR honoured: README 650 "Colour follows NO_COLOR" and `workload-gauge.py:309` checks it. The code deliberately emits ANSI with no TTY check because statusLine stdout is never a tty (usage_common.py comment ~1785).
4. Both: foreground numbers/bars, solid background for the title chip ("a solid background ... stays legible in both light and dark themes without needing to know which one is active").
5. Spaces/dim dots; right-aligned chip via `right_align()`; no powerline.
6. Lines and spacing; chip block vs plain text.
7. Chip uses solid bg + fixed dark ink so it does not need polarity detection. Optional macOS-only theme-staleness watcher (`CLAUDE_USAGE_THEME_WATCH=1`, `bin/theme-watch-prompt-hook.py`) compares OS appearance with the appearance the session launched under.
8. Heavy Unicode/emoji, `CLAUDE_USAGE_PROGRESS_ASCII=1` gives `[#---]`; `uc` indicator `⚡`.
9. Animation: shimmering gradient, charging battery edge rises, low battery breathes between two reds (`workload-gauge.py:~290`).
10. Env vars (`CLAUDE_USAGE_*`) and `~/.claude/claude-quota-gauge.env`.

## claude-code-statusline (risukisu)
https://github.com/risukisu/claude-code-statusline (3 stars)
1. By semantic theme role plus state. `statusline.js:102-122` `THEMES.<name>` keys: `fg dim faint empty accent effort blue good warn bad speech heat[5]`. Model dot `P.accent`, effort `P.effort`, dir `P.blue`, branch default `P.fg` else `P.warn`, dirty/unpushed `P.warn`, ahead `P.warn`, behind `P.bad`, synced `P.good` (or dim if `quiet`), `+/-` lines good/bad. Context bar: per-cell gradient `heatRGB(pos, warn, danger)` over 5 anchors (blue, amber, orange, red, deep red) with front-loaded thresholds (default warn 40, danger 50: "answers get worse long before the window is full"), `config.context`. Workspace folder: animated 2-colour "shimmer" per-character, colours per workspace path via `palettes` (match substring -> c1,c2 hex) or built-in `ROOT_PALETTES` (statusline.js:306-312).
2. 3 bundled themes: `default`, `high-contrast`, `colorblind` (Okabe-Ito). Format = semantic roles. User picks by `theme` in `~/.claude/statusline.json`; custom themes: not present, but `palettes` customises per-workspace shimmer.
3. Truecolor only (`38;2`). NO_COLOR honoured: `setTheme(dash.theme, !process.env.NO_COLOR, ...)` (line 467), all escapes become "".
4. Foreground-only; a left gutter glyph `▌` coloured per workspace gradient (line 498).
5. ` · ` (`P.sep`) and `  │  ` (`P.bigSep`) in `faint`; `╰─` tree trailer.
6. Single thin separators; hue by role.
7. `high-contrast` theme; no auto detection.
8. Emoji/Unicode, OSC-8 links (`links` option), no Nerd Font requirement.
9. Shimmer animation (3 s cycle, driven by refresh), companion "speech" line in italic (`extras/agent-model-tag.js`), README SVG renders built by `assets/readme/source`.
10. `~/.claude/statusline.json`: `theme`, `links`, `quiet`, `gutter`, `context{warn,danger}`, `hide[]`, `barWidth`, `palettes[]`.

## Rob-Morris/claude-usage-line (fork of canack/claude-usage-line)
https://github.com/Rob-Morris/claude-usage-line (3 stars); FORK OF canack/claude-usage-line, differences only.
Parent (`src/ansi.ts`): hard-coded ANSI-16 constants; `colorByThreshold` returns RED >=80, YELLOW >=50, else the segment's base colour; bar has `DIM` empty cells; org label picks from `ORG_COLORS` (256 indices + bright). No theme system.
Fork adds (`src/theme.ts`, `src/ansi.ts`, `themes/*.json`):
1. Colour per segment key via `ThemeColors` (`DEFAULTS` theme.ts:7-25): context magenta, five_hour cyan, seven_day green, cwd blue, branch green, model magenta, cost yellow, diff_add green, diff_remove red, duration blue, `warn` yellow, `danger` red, `dim` SGR 2; worktree/effort/reset fall back to branch/model/dim. Threshold now themable: `ansi.ts:colorByThreshold` >=80 `DANGER_COLOR()`, >=50 `WARN_COLOR()`, else base.
2. 10 shipped JSON themes: default (16-colour), dark-contrast, dark-muted, dark-vivid, dark-vintage, dark-rainbow, light-muted, light-vivid, light-vintage, light-rainbow (README 136-149). Format = per-segment colour map plus `style{filled,empty,width,separator,resetIcon}` plus `hide`. Merge order: shipped theme under user `~/.claude/statusline-theme.json` (`mergeThemes`, theme.ts); `--theme` flag; theme names validated (`THEME_NAME_RE`); symlinked theme files refused (`lstatSync`).
3. Colour spec parsed by `parseAnsi`: names (16 incl. bright_), `256:N`, `rgb:r,g,b`, or raw escape strings; invalid -> "". No depth detection, NO_COLOR not present.
4. Foreground-only.
5. Configurable `separator` glyph per theme (dark-rainbow uses `›`, `⣿`/`⣀` bar glyphs).
6. Per-segment hue; "dark-rainbow: every element its own hue at consistent brightness".
7. Separate dark-* and light-* themes (darkened palettes for white backgrounds); user chooses, no detection.
8. Braille/block bar glyphs and reset icon selectable.
9. `dark-vintage` is monochromatic warm (gold to sienna); `dark-muted` is split-complementary.
10. JSON theme file + `setup --theme` + `--style` flag.

## claude-code-usage-statusline (Scorpio3310)
https://github.com/Scorpio3310/claude-code-usage-statusline (3 stars)
1. Mixed. Segments carry a semantic colour in data (`seg(key, text, color)`, statusline-usage.sh ~340): model `model_color(d)`, dir/effort/burn dim, agent purple, session/today/month `C_MONEY`, git dim or amber when dirty, ctx and cache by `color_for` severity (green-amber-red; ctx forced amber/red near compaction). Themes decide painting. In powerline/slant/capsule/badge, the segment colour becomes the BACKGROUND with fixed ink `38;5;232`; the `rainbow` theme ignores semantics and cycles `[brand, blue, green, amber, purple, tan]` by position (`cycle[i % len]`).
2. 14 themes in `THEMES` (plain, boxed, frame, dots, prompt, gutter, mono, powerline, slant, capsule, badge, soft, rainbow; mode `sep`/`joined`/`pills`/`tinted`) crossed with 8 `PALETTES` (default, ocean, sunset, forest, nord, dracula, gruvbox, catppuccin; roles `red amber green brand money dim purple blue tan`, ANSI-256 indices). "Palettes remap hues, never meaning: green-amber-red stays a scale." Users choose by config; custom entries not present. Terminal TUI to edit.
3. ANSI 256 only (`38;5`/`48;5`). NO_COLOR: not present (scan: 256color env only; `mono` theme is the colourless route).
4. Both: fg-only for sep themes, bg-filled blocks for joined/pills, one shared dark band (`tint 238`) for `soft`.
5. Powerline arrow ``, slant ``/`╱` fallback, round caps `/`, `│`, `·`. For joined mode: arrow fg = previous bg, arrow bg = next bg (line ~422); when two neighbours share a bg, a thin separator in ink colour; without Nerd Font, hard edges or dark `╱` on the next block's bg.
6. Hue per segment from semantics (powerline) or position cycle (rainbow); equal-colour neighbours get a thin divider.
7. Contrast by fixed ink 232 on 256 backgrounds; `soft` theme comment: "fg on a set background is immune to minimum-contrast adjustments" (terminal min-contrast).
8. `ICONS` modes unicode/nerd/none (`⚡ ⑂ 📁 ⏱` vs nerd glyphs), pill/powerline degrade without Nerd Font; `doctor` command prints glyph test; BAR styles (boxes, slant, shade, line, dots, mini, bars, ascii).
9. Zone-heat bars (`BAR_HEAT`), `--preview` gallery, themes.png.
10. `~/.claude/statusline-usage.conf` + `CLAUDE_USAGE_*` env; TUI.

## claudeline
https://github.com/scttbnsn/claudeline (3 stars)
1. By state ladder plus fixed identity. Context colour/emoji from a 9-step ladder keyed by percent (`lib/statusline_display.sh:58-65`): 15 cyan sparkle, 30 lime, 50 yellow, 65 orange, 75 coral, 85 red, 95 hot pink, 101 magenta. "Burst" (rate limit) has 8 colours on 8 bands with `▁..█` bars. Fixed: dir `SKY`, branch `PURPLE`, model and token counter `DIM` (statusline.sh:662, 997, 1016).
2. 6 themes in `lib/statusline_themes.sh`: vibey (default), dark, light, nord, gruvbox, no-color; each an ordered array of 28 role variables (`THEME_COLOR_VARS`: RESET DIM PURPLE SKY CTX_* VEL_* BURST_*), env `CLAUDELINE_THEME`. Adding a theme = another values array; no user file.
3. Truecolor 38;2 only. NO_COLOR honoured with absolute precedence (themes.sh ~95: "NO_COLOR takes absolute precedence").
4. Foreground-only.
5. `DIM  ·  RESET` (statusline.sh:638).
6. Different hues; separators.
7. Explicit `light` theme with darkened hues; user selects, no detection.
8. Heavy emoji (context ladder emoji, burst bars); no Nerd Font.
9. Velocity colours (VEL_HOT..COLD) for token rate.
10. Env var `CLAUDELINE_THEME`, `NO_COLOR`; install script.

## k-mods
https://github.com/SeongGwangJu/k-mods (3 stars)
A Korean-localised catalogue of Claude Code mods (not a statusline itself). The statusline-relevant piece is `mods/ctx-strip` (a context-category strip + `extras/statusline-ctx.py`); other mods (pixel-pals, memo-pad, streamer-mode) are not statuslines.
1. Fixed per category: `hooks/palette.ts` `PASTEL` maps System prompt #86A0DC, System tools #8EC5CC, MCP tools #9F8FF2, MCP server instructions #B9AEF5, Custom agents #A8C98A, Memory files #E3C56A, Skills #E8A6C4, Messages #DE8E62; unknown categories cycle `fallback` (`categoryColor`). Threshold colours `warn`/`danger`; empty track.
2. 3 palettes selected by `palette` name: `dark` (default pastels on dark terminals), `gray` (originals tuned for a #bdbec6 grey background, darker text), `theme` (Claude Code theme keys: Messages->claude, System tools->suggestion, Skills->warning, Memory->remember, System prompt->inactive, MCP tools->permission, Custom agents->success, MCP instructions->planMode; track `inactive`, danger `error`). Format = semantic struct `CtxPalette` (category map, track, mark, chipInk, dim, bright, warn, danger, agentAccent, agentDone). The python script picks `dark`/`gray` tone from the mod's snapshot (`use_tone`, statusline-ctx.py:75-139).
3. Truecolor in the python script (`38;2`/`48;2`); the mod uses theme key names or hex. NO_COLOR: not present.
4. Both: legend chips are solid bg with `CHIP_INK` text; bar uses fg blocks on a `TRACK` bg (statusline-ctx.py:164-210).
5. Half-block bar caps `▐▌` in track colour, `▕` mark; none else.
6. Hue per category (eight pastels chosen so categories don't collide); share % bold.
7. Explicit polarity palettes (`dark`, `gray`, `theme`) with different ink colours per palette.
8. Emoji heavy in other mods; ctx-strip uses block glyphs.
9. HTML detail report (`report.ts`) deliberately ignores the palette and uses the originals ("terminal and Desktop UI follow theme keys only").
10. Mod config palette field; registry JSON for the catalogue.

## awesome-claude-mods
https://github.com/Singh-AP/awesome-claude-mods (3 stars)
not a Claude statusline: a curated catalogue/list of Claude Code mods (99 listed, 21 built) with a gallery site and build scripts (`scripts/ansi-to-svg.mjs` renders ANSI into SVG screenshots); no statusline of its own.

## omarchy-swapkin
https://github.com/SirAllap/omarchy-swapkin (3 stars)
Mostly not a statusline: an account switcher for the Omarchy (Hyprland) bar covering Claude Code, Codex and Copilot. One styling-relevant feature: `swapkin statusline [--plain]` (`bin/swapkin:282-287`, README 221-234) prints the active account as `@name` in the account's user-chosen colour: `\033[38;2;r;g;bm@%s` from `meta.json`, set by `swapkin colour <name> <#rrggbb>`.
1. Fixed per account, user-assigned truecolour hex (the same colour in the bar icon, account list and status line) , a rare case of identity colour chosen by the user.
2-4. Themes not present; truecolor fg only; `--plain` drops colour; NO_COLOR not present.
5-9. not present (one segment); the Omarchy bar UI itself is outside the Claude statusline.
10. `swapkin colour` CLI; per-account `meta.json`.

## statuscraft
https://github.com/statuscraft/statuscraft (3 stars)
1. Per widget, fixed default colour plus state tone; position-based in powerline themes. Each catalogue widget has `defaultColor` (e.g. context widgets green, git entries magenta/yellow/green/brightCyan/brightBlue, cache brightRed; `packages/core/src/widgets/catalog/*.ts`). Widgets with "warning colors" declare `thresholds` (context: >=70 `warn`, >=90 `danger` via `CONTEXT_THRESHOLDS`; prompt cache miss 30/50). In powerline mode `applyStyles` (`renderer/powerline.ts:~183-230`) assigns fg/bg by position: `colorIndex = widgetIndex % max(fg.length, bg.length)` from the selected theme, overridden by a widget's own `color`/`backgroundColor`; `custom` theme uses each widget's own colours (default fg white, bg bgBlue).
2. 8 powerline themes: custom, nord, dracula, catppuccin, gruvbox, plus three more including solarized and monokai (Nord/Dracula/Catppuccin/Gruvbox "come from ccstatusline (MIT)"; the editor also lists tokyo-night, one-dark, terminal in `terminal-themes.ts`). Format: for each of 3 colour levels (16, 256, hex) a 5-entry `fg[]` and `bg[]` list cycled by position (e.g. nord bg `88C0D0 4C566A 5E81AC B48EAD A3BE8C`). Users can set custom per widget; no user-defined theme file, but share codes and profiles exist.
3. Colour type union `named | hex | ansi256 | none` (`types/color.ts`; strings `hex:RRGGBB`, `ansi256:N`, names like `brightBlue`/`bgRed`). `colorLevel` 0-3 (disabled/16/256/truecolor), default 2 (`settings.ts:61`); `colorToAnsiFg` converts down (hex->256 via `rgbToAnsi256`, hex->16 via `rgbToAnsi16`). NO_COLOR: not found in the files read (unverified).
4. Both: plain look is fg text; powerline fills bg per segment with theme fg.
5. Powerline separators (`config/powerline.ts`): arrow ``/``, round ``/``, slash, slashThin, flame, pixel; start/end caps; `separatorInvertBackground` per separator for left-pointing glyphs. Arrow colours: fg = previous segment's bg, bg = next segment's bg (`drawPowerline`); caps take the segment's colour on the terminal bg. Plain look: default ` │ `.
6. Alternating/cycling palette position (5 colours, wrap), arrows between.
7. Per-theme fg chosen by hand for each bg (e.g. nord `2E3440` on cyan, `FDF6E3` on blue). No automatic contrast or terminal polarity detection.
8. Nerd Font needed for powerline (editor draws arrows without it for preview); Pip mascot `(^_^)`; bar styles `▰▱`, `█░`.
9. Drag-and-drop brick editor with live preview, 8 starter kits, profiles per repo, share codes, mods; widgets turn yellow then red on thresholds.
10. JSON config with migrations (`config/migrations.ts`), editor, `npx statuscraft apply <preset|code>`, per-project `.claude/statuscraft.json`.

## oh-my-claude
https://github.com/sw-willie-wu/oh-my-claude (3 stars)
1. Theme role mapped to segments, fixed by layout. Theme files (`themes/*.sh`) define `C_PRIMARY C_SECONDARY C_ACCENT C_GREEN C_YELLOW C_RED C_TEXT C_SUBTEXT C_SURFACE`. Default layout (`layouts/default.sh`): model PRIMARY, account SUBTEXT, folder SECONDARY, branch ACCENT, file adds GREEN / mods YELLOW / dels RED, `bar()` colour by pct: <=30 green, <=80 yellow, else red. The powerline layout colours each block's TEXT with the same role in turn (model PRIMARY, account SUBTEXT, dir SECONDARY, git ACCENT, stats by `pct_color`).
2. 9 themes: catppuccin (default, Mocha), dracula, gruvbox, mygo, nord, onedark, rosepine, solarized, tokyonight; semantic role palette in truecolor. 4 layouts (default, fancy, minimal, powerline). Users pick `THEME`/`LAYOUT` in `~/.claude/oh-my-claude.conf` and may add a theme file in `themes/` (sourced by name); `/set-theme`, `/list-themes` commands.
3. Truecolor only (`38;2`). NO_COLOR: not present.
4. Foreground-only everywhere, including the powerline layout (`layouts/powerline.sh`): the "arrow" `` is drawn in the block's text colour with no background fill, so it is a coloured arrow glyph, not filled cells.
5. Powerline arrow in segment colour (powerline layout); ` | `, `│`, a dot in SUBTEXT for other layouts.
6. Text hue per role; separators.
7. not present.
8. Nerd Font glyphs for folder/branch/account icons (fixed `\xef\x81\xbb`, `\xee\x82\xa0`), `WORKERS_SHELL_ICON` configurable.
9. Worker rows (`hooks/track-workers.sh`); preview scripts (`preview.sh`, `generate-preview.sh`); a character-themed `mygo` palette.
10. Shell conf file + slash commands.

## tokenboard
https://github.com/Typiqally/tokenboard (3 stars)
not a Claude statusline: a native macOS menu-bar app for Claude Code / Codex token usage (Swift; `CompanionTheme.swift` is its app mascot theme).

## custom-statusline
https://github.com/umarfarooque88/custom-statusline (3 stars)
27 designs in one script (`statusline.sh`, a Node program inside sh); chosen by number via `STATUSLINE_DESIGN`.
1. Fixed per segment inside each design plus a threshold helper. Each design hard-codes its own palette and per-segment backgrounds/foregrounds. Kiln Flow (design 1, line 120): model bg `#D97757` coral/ink text, dir bg `#2E2A2A`, branch bg `#7A5A4A`, ctx bg by `mk(sage, amber, danger)` = <50 sage, 50-79 amber, >=80 danger, usage bg slate; tail ink. Shared `mk(calm, warm, crit)` (line ~100) is used by every design for ctx/5h/7d. Designs 25 "RED vs BLU", 27 monochrome with one red at critical.
2. 27 numbered designs with names (Kiln Flow, Nightshade, Hairline, Gauge, Blocks, Claymorphic, Arcade HUD, Gradient Sweep, Synthwave, Phosphor LCD, Brutalist, Bauhaus, Swiss, Wabi-sabi, Glassmorphic, Memphis, Art Deco, Nord, Dracula, Terminal Rain, Flat, Vector, Geometric Art, Pixel, Cartoon, Cel Shading, Monochromatic). A "theme" is a whole layout+palette; no semantic roles; the user edits the script to make a new one.
3. Truecolor hex (`38;2`/`48;2`, `fg()`/`bg()` helpers, line 77). No depth detection, NO_COLOR not present. `STATUSLINE_PLAIN=1` swaps nerd glyphs for flat blocks.
4. Both: design-dependent: powerline/capsule designs fill bg; Hairline/Gauge/Dracula etc. are fg-only; some paint a thin bg under the bar.
5. Per design: powerline arrows with flush colour flow (`flow()`: next bg behind arrow in fg=this bg), round caps (`pills`), Memphis zigzag, thin rules, `│`. 
6. Different bg per segment in powerline/pill designs; Gradient Sweep (design 8) interpolates colour per character.
7. Fixed ink per design; no detection. Designs tuned dark.
8. Nerd-font designs vs font-safe designs flagged in the catalogue (comment list at lines 120-572); emoji in Arcade HUD; `STATUSLINE_PLAIN`.
9. `tools/build-gallery.js` + `ansi2html.js` produce a gallery HTML; per-character gradient, moon-phase meters, warm/critical background tints (`WARM_BG`, `CRIT_BG`, lines 271-272).
10. Env vars `STATUSLINE_DESIGN`, `STATUSLINE_PLAIN`; install by copying the script.

## claude-code-usage-statusline (victorstein)
https://github.com/victorstein/claude-code-usage-statusline (3 stars)
1. By threshold plus fixed theme roles. `claude-usage-statusline.py:87-95` `color_for_pct`: >=90 red, >=70 peach (orange), >=50 yellow, else green. Other text uses `accent`, `label`, `dim`.
2. 5 themes in `THEMES` (lines 26-72): catppuccin-mocha (default), catppuccin-latte, tokyo-night, gruvbox, plain (ANSI-16). Each = 7 semantic roles `green yellow peach red accent label dim`. Choice via `CLAUDE_USAGE_THEME` env; no user-defined theme.
3. Truecolor `38;2` for four themes, ANSI-16 for `plain`; NO_COLOR not present.
4. Foreground-only.
5. Plain text separators (not studied in detail); mini bars `█░` of `BAR_WIDTH`.
6. Colour by state; labels `label`, structure `dim`.
7. Light terminals: catppuccin-latte (darker hues) selectable by hand; no detection.
8. Unicode bars; emoji not central.
9. not present.
10. Env var only (`CLAUDE_USAGE_THEME`); `install.sh`.

## ai-dev-system
https://github.com/welflau/ai-dev-system (3 stars)
not a Claude statusline: a Chinese multi-agent software-development platform (web UI, orchestrator). It vendors third-party marketplace plugins; one is a copy of claude-hud (`.../external_plugins/claude-hud/src/render/colors.ts`): ANSI-16 `green/yellow/red/cyan/magenta/dim`, `getContextColor` = >=85 red, >=70 yellow, else green, `coloredBar` `█░` x10 in that colour. That is claude-hud's styling, not this repo's.

## tx-ide
https://github.com/wiktordaniec/tx-ide (3 stars)
A tmux-based terminal IDE; its Claude statusline is `claude/statusline.sh`.
1. Fixed per line: line 1 project name bold in `DIR_COLOR=\033[38;5;31m` (matches the author's p10k theme); line 2 model, effort ("effort:N" tier 1-5), token counts and `5h:`/`7d:` rate limits all in one `DIM` colour `38;2;169;177;214` (#a9b1d6). No thresholds on rate limits (`format_rate_limit` uses DIM only). Comment: "Model + tokens + rate limits use DIM so line 2 stays muted under the colourful line 1".
2. Themes: not present in the statusline, but the repo has a shared tokyonight-night palette (`shared/palette.sh`: ACCENT `#7aa2f7`, BORDER_DIM `#3b4261`, BG `#1a1b26`, FG `#c0caf5`) used by tmux, fzf, nvim; the statusline duplicates literals "in sync" by comment, not code.
3. Mixed 256 (`38;5;31`) and truecolor; no detection; NO_COLOR not present.
4. Foreground-only.
5. none (two lines; spaces).
6. n/a (bold bright vs dim).
7. not present; palette is tokyonight dark only.
8. Plain text, `↺` for reset.
9. Palette switching procedure documented for tokyonight-moon (`shared/palette.sh` header); a graph viewer is poked with rate-limit data (not styling).
10. Edit the script / palette file.

## Dog-RigLine
https://github.com/ZhouYinLong-lab/Dog-RigLine (3 stars)
1. By threshold plus fixed identity. `rigline.sh:36-47` 256-colour set: TEXT 230, MUTED 245, PEACH 216, GREEN 114, MINT 121, BLUE 117, PURPLE 183, YELLOW 221, RED 203. The bar (`rigline.sh:226-241`) is green <60, yellow >=60, red >=80. Other segments take fixed colours from this set.
2. Themes: not present.
3. ANSI 256 (`38;5`). NO_COLOR honoured: `rigline.sh:48` empties every colour variable if `NO_COLOR` is non-empty.
4. Foreground-only.
5. Dot separator after padding segments to target width (`# Build plain segments -> pad ... -> join with dot`, ~line 357).
6. Hue per segment; dots.
7. not present.
8. Box-drawing/Unicode heavy (counted 538 box glyphs), a few emoji; sanitize() strips ESC from input (line 287).
9. not present.
10. Edit the script variables; `install.sh`.

## cyberline
https://github.com/166xzx/cyberline (2 stars)
1. By role with fixed label colours and a threshold. `statusline.js:156-157` `C = theme.ui` with keys `cyan magenta yellow green red blue dim text`. Fixed: model magenta+bold, mode cyan, directory `text`, branch green clean / yellow dirty, cost yellow, labels (`模型`, `目录` ...) `dim`; usage percentages by `pctColor` (statusline.js ~106): >=90 red, >=70 yellow, >=40 cyan, else green; over-cap warning red bold `⚠`.
2. 4 themes in `themes.js`: neon (cyberpunk), outrun, matrix, tokyo. Each = `ui` (8 RGB roles) plus a `terminal` block (full 16-colour Windows Terminal scheme + background/foreground/cursor/selection). `config.json` `theme` or env `CYBERLINE_THEME`. Adding a theme = one more object (all roles required).
3. Truecolor RGB triplets (`fg()` emits `38;2`); the `ui.dim` values were brightened ("1.55x") so they hold 4.5:1 against the generated background image. No depth detection, NO_COLOR not present.
4. Foreground-only; the project also generates a terminal background image (`make-bg.js`, `bgpreview.js`, hand-written PNG codec) and applies a matching Windows Terminal colour scheme (`apply-terminal.js`).
5. ` │ ` in `dim` (`SEP`, with padding); two lines.
6. Hue by role; label dim vs value bright.
7. Contrast verified against the generated background per theme (comment on `dim`); no polarity detection (all themes dark).
8. Plain Unicode only (`│ ◆ ⑂ █ ░`), "no Nerd Font needed"; CJK-width aware layout (`dispWidth`).
9. Terminal colour scheme sync + background image + startup banner; `preview.js all` renders every theme x scenario.
10. `config.json` (gitignored), `node cyberline.js install/uninstall`, env override.

## claude-statusline-credits
https://github.com/68mschmitt/claude-statusline-credits (2 stars)
1. By threshold, one segment. `credits-segment.sh:69-82`: default `DIM`, `C_WARN` `38;2;254;188;56` (#febc38 amber) at >=`CREDITS_WARN_PCT` (50), `C_CRIT` `38;2;215;95;95` (#d75f5f) at >=`CREDITS_CRIT_PCT` (80). The bundled example `examples/statusline-robbyrussell.sh` (lines 30-62) uses fixed ANSI-16: arrow GREEN, dir CYAN, git `git:(` blue (RED when dirty, `✗`), model YELLOW, separators DIM.
2. Themes: not present.
3. Truecolor for the two alert colours, ANSI-16 in the example. `CREDITS_PLAIN=1` turns off colour (line 64); NO_COLOR itself not present.
4. Foreground-only.
5. ` | ` (credits module adds it via the host script); example uses DIM `|`.
6. Different hues per segment in the example.
7. not present.
8. Plain ASCII, `➜` and `✗` in the example.
9. not present.
10. Env vars `CREDITS_WARN_PCT`, `CREDITS_CRIT_PCT`, `CREDITS_PLAIN`.

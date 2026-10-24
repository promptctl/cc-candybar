# Batch 27: styling of 24 Claude Code statusline projects

Paths are repo-relative. Line numbers are from the files fetched on 2026-10-24.

## thefuga/claude-x
https://github.com/thefuga/claude-x, stars 1
Verdict: a Claude Code mod (plugin) marketplace. Its `mods/statusline` is a vim-style footer bar (editor mode, permission mode, model, effort, git, usage) drawn with Ink `Text` props, not ANSI strings. The other mods (syntax, vim, attachments, issues) are not statuslines.
1. Colour is by role, via a map in `mods/statusline/hooks/theme.ts`. Mode badge: NORMAL=`suggestion`, INSERT=`success`, VISUAL=`autoAccept`, SHELL=`bashBorder`, COMMAND=`warning` (`BADGES`, lines 5-11). Permission label: Plan=`planMode`, Auto=`warning`, Accept edits=`autoAccept`, Bypass=`error`. Effort=`claude`. Git branch=`inactive`, added=`success`, deleted=`error`. Everything else (model, provider, separators) uses `dimColor` or the default text colour (`view.tsx` `segments()`).
2. Themes: none of its own. Every colour is a *key of Claude Code's own theme* (comment at the top of `theme.ts`: "the bar follows whatever theme is picked in `/theme`, light or dark"). No user theme format.
3. Colour spec: Claude Code theme key names (`inverseText`, `userMessageBackground`, `selectionBg`, etc.). No hex or ANSI in this mod. Depth and NO_COLOR are inherited from the host; not present in the mod's code.
4. Fill: only the mode badge is a filled cell (`backgroundColor={badgeColor(mode)}` with `color='inverseText'`, bold, padded with spaces, `view.tsx`). All other segments are foreground-only. The completion menu rows are filled (`userMessageBackground`, picked row `selectionBg`).
5. Separators: plain text. A dim ` ·` between permission and model, ` · ` before effort, two spaces before the right half. No powerline caps.
6. Neighbours: told apart by role colour on the badge and bold/dim contrast; model is default text, provider and separators dim.
7. Light/dark: delegated to Claude Code's theme (see 2). `inverseText` on the badge gives readable text on whichever badge colour the theme supplies. No contrast code.
8. Glyphs: one Nerd Font glyph, the branch icon `` (`GIT_ICON`, `format.ts:310`). No ASCII fallback found.
9. Notable: the colour system is "borrow the host theme's semantic keys", with keys chosen "for their color in the built-in themes as much as for their meaning" (`theme.ts` header). Closest peer to cc-candybar's theme-role idea, with the host owning the palette.
10. Customisation: plugin options in `mods/statusline/README.md` (not read); colours are not user-configurable beyond the host `/theme`.

## theophilediot/claude-usage-tracker-linux
https://github.com/TheophileDiot/Claude-Usage-Tracker-Linux, stars 1
Verdict: a GNOME Shell extension (panel indicator, chart, notifications) that also installs a Claude Code statusline script (`statusline.js`). The statusline is what is described here.
1. Per element, by threshold for some. Default palette (`statusline.js:56-63` `BASE`): directory=blue, branch=green, model=yellow, profile=magenta, context=cyan, separator=gray. Context is by threshold (lines 409-411): value<=50 cyan, <=75 yellow, else `gradient[8]` (ANSI-256 160 red). Usage and weekly percentages use a 10-step gradient `GRADIENT = [22,28,34,100,142,178,172,166,160,124]` indexed by `ceil(pct/10)-1` (`gradientColor`, lines 204-206). The pace marker `┃` has a 6-tier palette `PACE = [34,37,178,208,160,135]` chosen by projected end-of-window usage: <50, <75, <90, and so on (`paceColor`, line 210).
2. Themes: no named themes. Four *colour modes* (`palette()`, lines 162-196): `colored` (default), `monochrome`, `singleColor` (one hex for everything, `SINGLE_COLOR`), `perElement` (a hex per element: `ELEMENT_COLOR_DIR`, `_BRANCH`, `_MODEL`, `_PROFILE`, `_CONTEXT`, `_SEPARATOR`, `_USAGE`, `_PACE`, `_WEEKLY`, `_EXTRA`). Per-element is a user-defined per-segment colour map.
3. Spec/depth: base six are 16-colour SGR (`\x1b[0;34m` etc.); gradient and pace are ANSI-256 (`38;5;n`); user hex becomes truecolor `38;2;r;g;b` (`hexToAnsi`, line 135). No depth detection. NO_COLOR is honoured: `options.colors ?? !process.env.NO_COLOR` (line 356), and the comment at line 13 says NO_COLOR suppresses reset sequences too. When the mode is `monochrome` all codes are empty strings.
4. Fill: foreground only.
5. Separator: plain ` │ ` in gray (`statusline.js:361`, `scheme.gray`, or the `ELEMENT_COLOR_SEPARATOR` hex).
6. Neighbours: different hue per element plus the gray `│`.
7. Light/dark: not present. Text colours are fixed foreground.
8. Glyphs: Unicode only: `⎇` branch, `▓░` bar, `┃` pace marker, `→`. No Nerd Font, no emoji in the line.
9. Notable: a marker `┃` placed at the elapsed position in the window whose colour encodes burn rate; the bar fill colour comes from the gradient. The extension's panel icon also uses a gradient (`extension.js`, not read in detail).
10. Customisation: GSettings (GNOME prefs UI) projected to `~/.claude/statusline-config.txt` as `KEY=value` lines (`skin.js:152-175`, `renderConfig`). Keys include `COLOR_MODE`, `SINGLE_COLOR`, `ELEMENT_COLOR_*`, `PACE_MARKER_STEP_COLORS`, `SHOW_*`. `skin.js` writes the `statusLine` entry into settings.json.

## thirteenash/ccometixline
https://github.com/ThirteenAsh/CCometixLine, stars 1. FORK OF Haleclipse/CCometixLine.
Differences only. The compare (parent master...fork master) shows 9 commits ahead, 86 behind. Changed files that touch the line's content: `src/core/segments/context_window.rs` and `src/ui/components/preview.rs`; the rest are CI, npm packaging and `src/updater.rs`. No theme file (`src/ui/themes/*`) differs.
1. Only change: the context-window segment gains a 10-cell text bar `[████████░░]` (`CONTEXT_PROGRESS_FILLED='█'`, `CONTEXT_PROGRESS_EMPTY='░'`, `CONTEXT_PROGRESS_WIDTH=10`, `format_context_progress_bar`), placed before the percentage: `"[bar] 78.2% · 156.4k tokens"`. The bar has no colour of its own; it is part of the segment's text and wears the segment/theme colour. No threshold colouring added.
2-10. Not present as a difference: themes (gruvbox, nord, powerline dark/light/rose-pine/tokyo-night, cometix, minimal, default), colour spec, separators, config and TUI are inherited unchanged from the parent.

## thomasbunch/dynamicisland
https://github.com/thomasbunch/dynamicisland, stars 1
1. By state/threshold plus fixed roles. `buildThemeFunctions` (`src/statusline-hook.js`, function at line 295, closures at 111-122) turns a theme into role helpers: `green`=`ok`, `yellow`=`warning`, `orange`=`danger`, `redBlink`=`critical`, `cyan`=`info`, `dim`=`muted`, `bold`=`accent`, plus `softRed`, `dimPurple`, `boldAmber`, `blue`. `colorByThreshold(val, warn, danger, critical)` (line 316-321) picks ok/warning/danger/critical. Fixed uses: separators and model name `dimPurple` (lines 1329, 1334); git branch `cyan`; directory `dim`; rate limits label `cyan` and value by threshold; cost icon `boldAmber`; session duration `cyan` icon plus `bold`; health score green >=70, yellow >=50, orange >=30, else redBlink (1236-1239); cache ratio green >=50, yellow >=20, else dim; agent name `boldAmber`; vim mode green/yellow/blue by mode.
2. Six bundled themes in `THEMES` (line 77+): `vibrant` (default), `catppuccin`, `gruvbox`, `dracula`, `monochrome`, `flstudio`. Format: a semantic role map (`ok, warning, danger, critical, info, accent, muted, softRed, dimPurple, boldAmber, blue`) plus a 10-stop `gradient` array. Selected with `display.theme` in config (validated against `THEMES`, line 1117). No user-defined themes.
3. Colour spec: ANSI-256 indexes (`\x1b[38;5;Nm`) for every colour theme; `monochrome` uses SGR 37/1/2/7/5. No truecolor, no depth detection, no NO_COLOR handling found (grep for NO_COLOR and COLORTERM returned nothing).
4. Fill: foreground only, except `monochrome` which uses reverse video (`\x1b[7m`) for danger.
5. Separator: `│` (│) in `dimPurple`, between segments, on two lines (lines 1329, 1413).
6. Neighbours: role hue differences plus the `│`.
7. Light/dark: not present. The `critical` role blinks (`\x1b[5;...`).
8. Glyphs: three icon sets: `ICONS_NERD` (config `use_nerd_fonts: true`), `ICONS_STANDARD` (emoji/Unicode), `ICONS_FLSTUDIO` (picked when `theme === 'flstudio'`) (`getIconSet`, line 382).
9. Notable: `gradientProgressBar` (line 425-460) colours each filled cell by its position along the bar from the theme's 10-stop gradient (green to dark red), with eighth-block fractional cells; blinking critical role; `flstudio` is a branded theme with its own icons.
10. Customisation: JSON at `~/.claude/dynamicisland/config.json` (line 1073), with `display` toggles, `preset` (`full`/`compact`/`essential`), `theme`, `thresholds`.

## thrownlemon/cc-hooks-custom
https://github.com/ThrownLemon/cc-hooks-custom, stars 1
Verdict: a hooks toolkit (audio, event DB, server); the statusline is `status-lines/status_line.py`.
1. By line (row) with threshold overrides. `THEME` dict (`status_line.py:91-105`): `line1` (210,140,100) muted orange for dir/model/version/style/project/git; `line2` (120,165,160) muted teal for tts/elevenlabs/openrouter; `line3` (160,145,180) muted lavender for usage/cost. Context and session use `_warning_color`: >80% `warning_high` (185,130,130) coral, >60% `warning_mid` (175,155,145), else line3 colour. Legacy usage uses a 10-level ANSI-256 gradient `[22,28,34,100,142,178,172,166,160,124]` (line 217).
2. One hard-coded `THEME` dict, "Edit colors here for easy customization" (line 88). No selectable themes or config.
3. Truecolor throughout (`_rgb` -> `38;2;r;g;b`, line 112); 256-index only for legacy usage gradient. No depth detection. `--no-color` CLI flag disables (`_should_use_color`, line 65); NO_COLOR env not read. Colours are forced on because the output is piped.
4. Foreground only.
5. Separator: plain ` | ` (`SEPARATOR`, line 106), same colour as the text it sits between or default.
6. Neighbours: separate rows in different muted hues; within a row all one colour.
7. Not present. The palette is deliberately muted so it sits on either background; no detection.
8. Glyphs: Unicode box and emoji in the layout (per signal counts); no fallback toggle checked.
9. Notable: row-level colour (colour identifies the *row's purpose*, not the segment), a restrained desaturated palette.
10. Customisation: Python source constants; CLI flags `--debug`, `--no-color` (lines 1160-1164).

## thunguo/claude-code-miku-theme
https://github.com/thunguo/claude-code-miku-theme, stars 1
Verdict: a Claude Code *theme* plugin (two theme JSONs) plus a bundled statusline script. The statusline is `plugins/miku-theme/statusline/miku-statusline.sh`.
1. Fixed per segment, six palette constants (`miku-statusline.sh:35-40`): `TEAL` model, `OFFWHITE` directory, `GRAY` the word "on" and the cost/duration line, `PINK` branch, context `TEAL` switching to `GOLD` at >=90% (line 54-55). The label `GRAY` on `Hatsune Miku theme`.
2. Two *Claude Code themes* (not statusline themes): `themes/miku.json` (`base: dark`, overrides such as `claude #39C5BB`, `suggestion #FF9AC3`, `warning #FFD86B`) and `themes/miku-ansi.json` (`base: dark-ansi`, `claude: ansi:cyan`, `suggestion: ansi:magenta`...). Format: Claude Code's role keys with hex or `ansi:` names. The script comment says its colours mirror `miku.json` "so the statusline stays on-theme even if the user switches to a different Claude Code color theme"; the statusline itself has no theme switch.
3. Truecolor only in the script (`\033[38;2;...`). The ANSI variant exists only for the Claude Code theme. No depth detection, no NO_COLOR.
4. Foreground text plus a large block of background-filled sextant half-block pixel art (`\033[48;2;...` and Unicode 13 sextants U+1FB00-1FB3B) forming a 28x14-cell Miku icon; the "rainbow/animation" counts in the scan come from that art, not from animation.
5. No separators; the icon is a left column and four info lines are on its right.
6. Neighbours: separate lines, each in a fixed colour.
7. Not present; palette is for dark terminals.
8. Glyphs: `♪`, sextant block characters; `MIKU_STATUSLINE_ICON=0` falls back to one compact text line; `MIKU_STATUSLINE_IMAGE=1` uses an iTerm2 inline PNG (OSC 1337).
9. Notable: theme and statusline shipped as one plugin; the statusline duplicates the theme hexes by hand.
10. Customisation: env vars only (`MIKU_STATUSLINE_ICON`, `MIKU_STATUSLINE_IMAGE`, `MIKU_ICON_PATH`).

## tiagobastos/statusline
https://github.com/tiagobastos/statusline, stars 1
1. Mixed: fixed per segment for pills; thresholds for bars. Pills (`main.go`): working dir `bgGreen` (80,190,100) (line 933, 976); git branch `bgPurple` (160,110,200) (962); git age and sync `bgDark` (80,88,105); modified count and stash `bgAmber` (230,155,60). Model pill by model: opus `bgBlue` (100,150,235), sonnet `bgPurple`, haiku `bgTeal` (70,185,165), default blue (`modelPillBg`, 204-217). Pill text is always `fgWhite` bold (`pill()`, 663). Context bar: green <50, yellow 50-74, red >=75 (`fgBarGreen/Yellow/Red`, 871-876). Rate-window bar: green, amber at 50, red at 75 (`fgWin*`, 864-869). Effort gauge: five dots coloured green to red by level (`fgEffortLow..Max`, 59-63); filled count carries the level so it still reads under red-green colour blindness (comment 52-57). `bgRed` "cost pill: expensive session" is defined (line 39) but I found no use of it.
2. No themes; colours are Go constants (lines 22-66). Not user-configurable except a few env vars.
3. Truecolor only (`38;2`/`48;2`). The signals list `env.truecolor` but I found no `COLORTERM` read. No NO_COLOR. Env read: `CLAUDE_STATUSLINE_MAX_WIDTH`, `COLUMNS`, `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`.
4. Pills are background-filled; bars, gauges and separators are foreground-only.
5. Rounded caps, not arrows: `capLeft` `` and `capRight` `` (lines 72-73). The cap colour is the pill's background converted to foreground by `bgToFg` (`48;`->`38;`, line 670). Pills are separated by a space (not joined). Mid-bar separator is a dim `⋮`.
6. Neighbours: different hue per pill, a space between; each pill has its own caps.
7. Not present beyond white text on mid-saturation backgrounds, and a deliberate colour-blind-safe design for the effort gauge.
8. Glyphs: Nerd Font caps required; Unicode `●◕◑◔⧉↻✎⚑⇅⏱`; no ASCII mode noted. Comment says the author confirmed every glyph is single-width in their terminal via a DSR probe.
9. Notable: pie-quarter icons (`◔◑◕●`) that fill with usage; render width is capped and has a 6-column safety margin because Claude Code insets the line.
10. Customisation: Go source constants; env vars listed above.

## troyjlorents-gh/mod-squad
https://github.com/TroyJLorents-GH/mod-squad, stars 1
Verdict: not a general Claude statusline. A marketplace of ten Claude Code mods (panes, bands, toasts, guards). Only `context-gauge` resembles a statusline (a band above the prompt). Styling of that and the panels:
1. `mods/context-gauge/hooks/gauge.ts`: `colorFor(percent, warnAt)` returns RED `#ef4444` at >=`warnAt` (default 80), ORANGE `#f59e0b` at >=50 (capped by warnAt), else GREEN `#22c55e`. The bar paints each filled cell by *its own position* (`segments()`: colour of cell i is `colorFor((i+0.5)/width*100)`), so a half-full bar is green then orange; empty cells are `dimColor`. Label percent is bold in the current-level colour.
2. No themes. Fixed hex constants. `burn-rate` panel (`hooks/layout.ts:10-19`) maps sections to fixed hexes (`daily #06b6d4`, `project #a855f7`, `model #f59e0b`, `activity #22c55e`, `tools #3b82f6`, `shell #ec4899`, `mcp #14b8a6`, `header`/`cost #ca8a04`) and a four-step heat scale (>=75% `#ef4444`, >=50% `#f59e0b`, >=25% `#a3e635`, else `#22c55e`, lines 68-71). `session-graph` uses `#06b6d4`, `#a855f7`, `#22c55e` borders.
3. Truecolor hex passed to Ink `Text color`; the host handles depth. No NO_COLOR code.
4. Foreground only; panels use round `borderStyle` with a coloured border.
5. Gauge framing: dim `▕` and `▏` end caps; no separators.
6. Not applicable beyond the per-section fixed hues.
7. Not present.
8. Glyphs: `█░▕▏`, emoji in toasts.
9. Notable: position-dependent colour along a bar (per-cell threshold), expressed as run-length segments.
10. Customisation: mod options in each mod's README (not read); `warnAt` for the gauge.

## turdpusher360/turd-box
https://github.com/turdpusher360/turd-box, stars 1
Verdict: the `4ge` plugin has a multi-row HUD statusline (`hud-engine.cjs --mode=statusline`), which is the part described.
1. By semantic role. `colorize(palette, role, text)` (`plugins/4ge/bin/hud-palette.cjs`) with eight roles: `ok, warn, error, accent, muted, text, glow, bg`. Zones pick roles: e.g. badges use `warn` for earned/new, `muted` for locked, `text` for names (`hud-zone-badges.cjs:71-97`); reactive rows pick role from event (`REACTIVE_STATUSLINE_ROLE`, `hud-engine.cjs:212`). Individual per-segment mapping not read exhaustively across ~20 zone files.
2. Seven presets (`PRESETS`, `hud-palette.cjs`): `dark-ansi`, `tokyonight-dark`, `plain`, `catppuccin-mocha`, `dracula`, `nord`, `forge` (default). Each preset has three variants keyed by colour depth ('8', '256', 'truecolor'), each a full role map with its own escape codes. Selection via `setTheme(name)` persisted to `plugins/4ge/.data/theme.json`. Not user-extensible (presets are in code).
3. Depth detection: `detectColorDepth()` reads `COLORTERM` (truecolor/256color) and `TERM` containing `256color`, otherwise '8'. NO_COLOR honoured via `isNoColor()` (NO_COLOR set or `CLICOLOR=0`, unless `CLICOLOR_FORCE`), returning the `plain` empty palette. Hand-authored per-depth values rather than computed downsampling.
4. Foreground by default; the palette carries a `bg` role used for panels.
5. Separators: not examined (box-drawing heavy: 388 box-glyph hits).
6. Neighbours: role changes (muted labels, `text` values, signal colours).
7. No light preset; all presets are dark. `forge` defines a vertical gradient ladder: dark `accent` at the top rows to a bright cream `glow` at the bottom (`docs/superpowers/specs/2026-04-08-hud-color-vertical-gradient.md`, referenced in the file); other themes set `glow` equal to `text`. Also a display-width calculator (`displayWidth`, `fitAnsi`) for CJK/emoji.
8. Glyphs: heavy box drawing, braille orb (`hud-braille-orb.cjs`), emoji, some creature sprite. No ASCII mode checked.
9. Notable: roles are depth-specific, not derived; `forge` has an explicit 256-index lightness ladder per row zone; animated braille orb and "face" sprite; session-keyed render cache for the statusline (`hud-statusline-cache.cjs`, 10 s TTL).
10. Customisation: `FORGE_HUD_*` env vars (cache dir etc.), theme file, `--mode` argv. No user palette file.

## victorfg21/claude-code-statusline
https://github.com/victorfg21/claude-code-statusline, stars 1
1. Fixed per segment plus thresholds (`statusline.sh`): directory bold blue (`FG_BLUE`, OSC-8 file link, line 365); git branch bold magenta (219); repo link cyan (200); clean=green, staged `+` green, modified `~` yellow (166-168); lines added green / removed red (299); cost gray; duration dim; model dim; "caveman" tag orange 256-index 172. Context bar and percentage by threshold (`color_by_threshold`, 234-244): >=90 red, >=70 yellow, else green. Rate limits 5h/7d: green, yellow >=50, red >=80 (284-286).
2. Not present (no themes or colour config).
3. ANSI 16 plus one ANSI-256 (orange 172). No depth detection, no NO_COLOR.
4. Foreground only.
5. Separators: two spaces between metrics; no glyph separators.
6. Neighbours: different hue per kind of fact; dim gray for low-priority.
7. Not present.
8. Glyphs: `▓░` bar; no emoji/Nerd.
9. Notable: the filled bar is coloured and the empty part uses `DIM`; OSC-8 hyperlinks on directory and repo; separate wide (>= `WIDE_LAYOUT_MIN_COLS`) and narrow layouts.
10. Customisation: constants at top of the shell script; no config file.

## victoriomolina/statusline.sh
https://github.com/victoriomolina/statusline.sh, stars 1
1. Fixed per segment plus a threshold bar: project name bold bright white (`fg_white`, line 223); model cyan (227); agent white; bar and percent by threshold (`render_bar`, 83-103): <50 green, <75 yellow, else red, empty cells dim gray; token detail gray; `+N` green, `-N` red; cost gray label with bold white value; elapsed gray.
2. Not present.
3. ANSI 16 only (`\033[31m` etc., `\033[97m`, `\033[90m`). No depth detection, no NO_COLOR.
4. Foreground only.
5. Separator: gray `│` with a space either side (`sep`, line 217).
6. Neighbours: a gray `│` and per-fact hue.
7. Not present.
8. Glyphs: emoji labels (📁 🧠 💰 ⏱ ⚡); bar `█░`.
9. Nothing beyond the above.
10. Customisation: edit script constants (`BAR_WIDTH`).

## vncntvx/codingplan-status
https://github.com/Vncntvx/codingplan-status, stars 1
1. Powerline blocks, fixed per segment with threshold overrides (`cli/renderer.js:64-117`): directory `#2563EB`, branch `#9333EA`, model `#4C1D95`, context `#0369A1`, remaining time `#92400E`. Usage block by threshold: `#065F46` green, `#9A3412` at >=75%, `#991B1B` at >=95%. Plan-expiry block: `#374151`, `#9A3412` at <=7 days, `#991B1B` at <=3. Every block declares `fg: '#FFFFFF'` but the renderer ignores it and always draws `chalk.whiteBright` text (line 128). A second, plain section (tools, agents, todos) uses chalk named colours: `getStatusColor` green <60, yellow >=60, red >=85 (53-57); tools `yellow ◐` running, `green ✓` done, agent type magenta, model cyan.
2. Not present.
3. Truecolor hex through chalk `bgHex`/`hex`; depth and `FORCE_COLOR` are chalk's built-in handling (not custom code). NO_COLOR is chalk's. `MINIMAX_PLAIN_UI` or `NO_NERD_FONTS` turns off Nerd glyphs.
4. Blocks are background-filled; the tool/agent lines are foreground only.
5. Powerline: `` arrow (same glyph for left cap and between blocks). Arrow colours: foreground = the block's bg, background = next block's bg (`chalk.bgHex(nextB.bg).hex(b.bg)(arrow)`, 132); last arrow on the terminal background; left cap in black on the first bg. Without Nerd Fonts the arrow is `>` and drawn in bright white on the block's own bg.
6. Neighbours: different hue per block, joined by the arrow.
7. Text is always bright white on dark-saturated backgrounds; no light-mode adaptation.
8. Glyphs: `` branch with Nerd Fonts, `*` without; Chinese text for plan expiry (`剩N天`).
9. Notable: the declared per-block `fg` field is dead; block bgs are all dark 700/800-level Tailwind shades so white text works. Also has a VS Code extension (`vscode-extension/src/constants.js`, not examined).
10. Customisation: env vars `MINIMAX_PLAIN_UI`, `NO_NERD_FONTS`; no theme file.

## volitent/claude-code-statusline
https://github.com/volitent/Claude-Code-Statusline, stars 1
1. Mostly by threshold, plus a fixed cyan: the bar and percentage take one of three colours from `get_color_for_percentage` (`statusline.py:110-127`): `low` <50 green, `medium` <75 yellow, then orange (ANSI-256 208) up to the `high` threshold 90, then red. Git branch cyan (241); staged `+` green; unstaged `~` red (264-266); custom components can name a colour (`COLORS[color]`, 406-410). The model, directory and cost components are uncoloured.
2. Not present; the three threshold colours are user-configurable by name from the 12 in `COLORS` (green, yellow, orange, red, blue, cyan, magenta, dim, bold, bright_blue, gray, reset).
3. ANSI 16 plus ANSI-256 208 for orange. No depth detection. NO_COLOR not read; `colors.enabled` in config turns colour off.
4. Foreground only.
5. Separators are configurable per line: default `" | "` between components on line 1, `" "` on line 2 (`DEFAULT_CONFIG.lines`).
6. Neighbours: separator only; most components share default colour.
7. Not present.
8. Glyphs: `█░▓` bar (the `▓` is the "gradient_char" for the partial cell); emoji in some components.
9. Notable: template strings per component (`{name}`, `{percent:.1f}`).
10. Customisation: JSON `~/.claude/statusline-config.json` (line 17): `lines[]` with `components` and `separator`, `progress_bar`, `colors`, per-component formats.

## waine-r/claude-token-statusline
https://github.com/waine-r/claude-token-statusline, stars 1
1. Only the context bar is coloured (`statusline.ps1:46-54`): >=90 `\e[91m` bright red, >=70 `\e[93m` bright yellow, else `\e[92m` bright green; empty cells `\e[90m` gray. Everything else (model in square brackets, token counts, cost, plan limits) is default text.
2. Not present.
3. ANSI 16 bright only. No depth detection, no NO_COLOR. (PowerShell script.)
4. Foreground only.
5. Separators: plain ` | ` text, uncoloured.
6. Neighbours: separators only.
7. Not present. Output encoding forced to UTF-8.
8. Glyphs: glyphs built from code points so the .ps1 stays ASCII: `█ ░ ↑ ↓`. Labels are in Portuguese.
9. Nothing else.
10. Customisation: edit the script.

## wasulajr/headsup
https://github.com/wasulajr/headsup, stars 1
Verdict: mainly a macOS tab-colour/notification fleet manager for iTerm2, WezTerm and AI Power Term. It also ships a statusLine hook (`hooks/headsup-context-bar.sh`).
1. Statusline: almost everything is `DIM` gray text (account, model, session, week, cost, branch). The context readout is the only coloured part, and only when `PCT >= WARN_AT` (70): green below, yellow with `⚠` from 70, red with `🔴 compact soon` from `DANGER_AT` 90 (`headsup-context-bar.sh:273-287`); below 70 it prints `Ctx: NN%` dim.
2. Not present for the statusline. The tab colour is the product: iTerm2 tab colours set per state (white idle, blue working, orange waiting, per README) by `hooks/iterm2-set-tab-color.py`, which takes a 6-char hex and injects `OSC 1337;SetColors=tab=<hex>`; WezTerm reads user vars in `wezterm/wezterm.lua`.
3. Statusline: ANSI 16 (`\033[32m/33m/31m/2m`). No depth detection, no NO_COLOR.
4. Foreground only.
5. Separators: two spaces.
6. Neighbours: dim text with a single colour accent.
7. Not present.
8. Glyphs: emoji (👤, 🔴, ⚠, ⎇), `▓░` bar.
9. Notable: colour carries *session state in the terminal's tab bar*, a different surface from the status line; the status line also notifies at usage thresholds 80/90/95 (`USAGE_ALERT_THRESHOLDS`).
10. Customisation: `~/.claude/hooks/headsup-status.conf` and `headsup-notifications.conf` (sourced shell files); `WARN_AT`, `DANGER_AT`, `BAR_WIDTH`.

## way29/cchline
https://github.com/WAY29/cchline, stars 1
1. Fixed per segment (`config/theme.go:118-140`, `segmentColors`; icon colour, text colour, bold): model bright cyan bold; directory icon bright yellow, text bright green, bold; git bright blue bold; context window bright magenta bold; usage bright cyan; cost yellow bold; session green bold; output style cyan bold; update bright yellow; the CCH-specific segments: model bright magenta, provider bright blue, cost yellow, requests bright green, limits bright cyan.
2. Two *icon* themes only, `default` (emoji) and `nerd_font` (`ThemeMode`, line 55-60); colours are the same in both. No user colour themes. A `BgColor` field exists on `SegmentTheme` and `render/statusline.go:66` applies it as ` icon text ` padded background, but `GetSegmentTheme` never sets it, so no segment is filled by default.
3. ANSI 16 named by index strings ("14", "11", ...). The renderer is created with `termenv.WithProfile(termenv.ANSI)` and `WithUnsafe()` to force colour even when stdout is not a TTY (lines 12-22), so it never emits more than 16 colours. No NO_COLOR.
4. Foreground only by default (see 2).
5. Separator: configurable string, default ` | ` (`separator = " | "` in `~/.claude/cchline/config.toml`); joined plain in `render/statusline.go:50`.
6. Neighbours: different bright hue per segment plus the separator.
7. Not present.
8. Glyphs: emoji set or Nerd Font set per segment (e.g. `` nf-md-git); toggled by `theme = "nerd_font"`.
9. Notable: this one's emphasis is the data (it queries a "CCH" API for provider, requests and limits).
10. Customisation: TOML `~/.claude/cchline/config.toml` (`theme`, `separator`, segment list).

## wenjiecome/claude-dashboard-zai
https://github.com/wenjiecome/claude-dashboard-zai, stars 1
1. By semantic role, widgets pick the role. `ThemeColors` (`scripts/utils/colors.ts:11-43`): `model, folder, branch, safe, warning, danger, secondary, accent, info, barFilled, barEmpty`, plus direct `red..gray`. Percent-driven widgets use `getColorForPercent`: <=50 `safe`, <=80 `warning`, else `danger` (323-328). Default theme: model pastel cyan (256-index 117), folder pastel yellow (222), branch pastel pink (218), safe pastel green (151), danger pastel red (210), secondary pastel gray (249).
2. Eight themes in `ThemeId` (`scripts/types.ts:129`): `default`, `minimal` (all white/gray), `catppuccin`, `dracula`, `gruvbox`, `nord`, `tokyoNight`, `solarized`. Format: the role map above, per theme. Selected by `theme` in config. Not user-extensible; theme docs are at `website/src/content/docs/guides/themes.md`.
3. `default` uses ANSI-256 pastels and 16-colour bar; the other themes are truecolor 38;2 from the named palettes (e.g. catppuccin `#89b4fa`). No depth detection found, no NO_COLOR.
4. Foreground only.
5. Separator style is a setting: `pipe` `│`, `space`, `dot` `·`, `arrow` `›` (`SEPARATOR_CHARS`, 340-345). It is drawn in the theme's `dim`; `space` is two blank spaces.
6. Neighbours: different roles per widget (model/folder/branch hues) plus the separator.
7. Not present.
8. Glyphs: emoji in widgets.
9. Notable: the widget system is modular with presets (`compact` 1 line to `detailed` 5 lines) and a docs website (Astro).
10. Customisation: JSON `~/.claude/claude-dashboard.local.json` with `theme`, `separator`, widget list; `/claude-dashboard-zai:setup` command with interactive and direct modes.

## whallysson/claude-status
https://github.com/whallysson/claude-status, stars 1
1. By semantic role. Each component takes roles from `ctx.theme.colors` (`src/render/themes.ts`, roles `primary, success, warning, danger, muted, accent, info, text`). Examples: model name `primary` bold with plan label coloured by plan (Max=`accent`, Pro=`info`, other `muted`, `components/model.ts:13-15`); context-usage colour <50 `muted`, >=50 `warning`, >=80 `danger` (`context-usage.ts:28-30`); the mascot has a fixed colour (210,110,80) (`mascot.ts:84`).
2. Six themes (`themes` map): `default`, `catppuccin`, `tokyonight`, `minimal`, `neon`, `none`. Format: a `Theme` object = eight RGB roles plus its own separator string, bar characters and icon set. `none` sets every role white and uses text icons. Selected by `"theme"` in `~/.config/claude-status/config.json`; no user-defined themes.
3. Truecolor roles are *downsampled* at output (`src/render/ansi.ts:46-60`): `fg(color, text, mode)` gives `38;2` for truecolor, `38;5;n` through a 6x6x6 cube mapping (`rgbTo256`) for 256, and `30+n` through `rgbTo16` for 16. `detectColorMode()` (`terminal.ts:7-26`): `NO_COLOR` present (any value) -> none; `FORCE_COLOR` 0-3; `COLORTERM` truecolor/24bit; `TERM` containing 256color; else 16.
4. Foreground only (`fg`, `fgBold`, `dim`).
5. Separators belong to the theme: `' │ '` (default, catppuccin, tokyonight), `' | '` (minimal, none), `' ┃ '` (neon). Colour is `muted` or default.
6. Neighbours: role hue and bold/dim; separator from the theme.
7. Not present; all themes assume a dark terminal.
8. Glyphs: per-theme icon sets: `defaultIcons` (emoji/Unicode) vs `textIcons` (`ctx`, `tok`, `eff`, ASCII); bars `●○` (default), `#-` (minimal/none), `█░` (neon).
9. Notable: a small animated ASCII mascot (frames in `mascot.ts`); the same role set drives everything, so a new theme is one object.
10. Customisation: JSON config (`theme`, `layout`), installer `bin/install.ts`.

## whiskychoy/whisky-claude-plugins
https://github.com/WhiskyChoy/whisky-claude-plugins, stars 1
Verdict: a multi-plugin marketplace (drawio, audio, paper-to-slides, ...); only `plugins/claude-statusline` is a statusline.
1. Fixed per segment plus one threshold bar (`scripts/statusline.sh:40-75`, same in `statusline.py`): directory bold blue `📂`, model yellow `⚡`, context bar green <50, yellow <80, red otherwise with empty cells dark gray; percentage uncoloured.
2. Not present.
3. ANSI 16 (`\033[1;34m`, `33m`, `32m`, `31m`, `90m`). No depth detection, no NO_COLOR.
4. Foreground only.
5. Separator: two spaces; none drawn.
6. Neighbours: hue per segment only.
7. Not present.
8. Glyphs: emoji `📂 ⚡`; bar `█░` 15 cells. `jq` missing prints a yellow hint.
9. Nothing else. There are both a shell and a Python version with the same output.
10. Customisation: none; edit the script.

## whisperers26/ccstatusline-desktop
https://github.com/whisperers26/ccstatusline-desktop, stars 1. FORK OF sirmalloc/ccstatusline.
Differences only. The compare (parent main...fork main) is 171 commits ahead, 9 behind. The diff does not touch `src/utils/colors.ts`, the powerline modules, or the TUI colour editor, so colour model, themes, separators and config format are the parent's. What it adds is where the engine's output is drawn:
1. Mod (`mod/hooks/ansi.ts`): parses the engine's SGR output into Ink `Span`s (`color`, `backgroundColor`, `bold`, `dimColor`, `italic`, `underline`, `inverse`, `strikethrough`, `href`), with xterm's default values for the 16 basic colours (`BASIC`, `#cd0000` etc.), the 6x6x6 cube (`CUBE_LEVELS`) and grey ramp, so ANSI-index colours become fixed hex in the desktop app instead of following a terminal palette. Powerline separators need a code font with their glyphs (README line 277).
2. JetBrains plugin (`jetbrains/.../Contrast.java`, `IdeLook.java`, `Look.java`): reads the IDE theme's font, text colour and panel background (`UIUtil.getPanelBackground()`) each time it paints, so a theme change shows at once. `Contrast.legible(color, background, foreground)` takes WCAG contrast ratios and, when a colour is under 2.0 against the panel (`LEGIBLE`), moves it in ten steps toward the IDE's own text colour until it reads. README: "the engine's colours are a terminal's: one that would be lost on the IDE's theme is moved toward the theme's own text colour until it reads."
3. The fork otherwise reuses the bundled engine (`mod/engine/*`) and configurator (`/ccstatusline-desktop edit` opens the parent's TUI).

## whitslar/claude-statusline
https://github.com/whitslar/claude-statusline, stars 1
1. Fixed per segment plus remaining-percentage thresholds (`statusline.sh`): directory cyan (1151); git branch violet=magenta (1159); model bold white (1163); git parts: ahead/behind and counts: staged bold cyan, modified bold white, untracked gray, stash magenta, SHA gray, added green, removed red (524-559); context tokens blue (671-755); session-stats message count cyan, session count blue, tokens magenta (910-924); cost green (801); reset timer yellow (1087). Context remaining colours (646-654): >=60% green, <60 yellow, <40 orange, <20 bright red. The battery icon changes colour likewise (583-595).
2. Not present. The aliases are "terminal-themed ANSI codes that respect your color scheme" (comment, line 69); `orange` is mapped to yellow (no orange in basic ANSI).
3. ANSI 16 (30-37, 90-97) only, deliberately so the terminal's scheme decides the colours. Colour on/off with `CLAUDE_STATUSLINE_COLORS=1|0`. NO_COLOR is not read.
4. Foreground only.
5. Separator: plain ` | ` (comment at 1145 and 1195).
6. Neighbours: hue per section and the pipe.
7. Not present beyond using the terminal's own palette; `gray` is `\e[39m` (default foreground), not bright black despite the comment.
8. Glyphs: Nerd Font icons by default (robot, folder, branch, clock, battery levels, Windows icons); `CLAUDE_STATUSLINE_ICONS=0` removes them.
9. Notable: battery-style context icon whose colour follows the same remaining-percent steps.
10. Customisation: environment variables only: `CLAUDE_STATUSLINE_COLORS`, `_ICONS`, `_GIT`, `_CONTEXT_USAGE`, `_CONTEXT_REMAINING`, `_COST`, `_DAILY`, `_SESSION`, `_VERBOSE`, cache TTLs, each section taking a comma-separated option list (or 0 to disable).

## wingatethomas/claudewatch
https://github.com/wingatethomas/claudewatch, stars 1
not a Claude statusline: a macOS menu-bar app (Python/AppKit) that lists running Claude Code sessions and switches to them. Its colours (`claudewatch/ui/theme.py`, `ui/components/tokens.py`) are three session-status colours (attention, working, idle) chosen from accessibility schemes: `Default` (attention red 0.85/0.30/0.28, working green, idle amber), `Blue-Orange` (attention orange, working blue, idle gray) and `Blue-Yellow`; other colours come from system semantic NSColors that follow light/dark mode.

## wyofalcon/ttyl
https://github.com/wyofalcon/ttyl, stars 1
Verdict: primarily a Windows desktop timer tile. The statusline part is a one-segment script (`scripts/cache-segment.sh`, composed by `scripts/statusline-standalone.sh`).
1. By state, emoji only, no ANSI at all: `🔄 active` (request in flight), `🟢 cache M:SS` (>2:00 remaining), `🟡` (1:00-2:00), `🔴` (<1:00 or `cache expired`) (`cache-segment.sh:16-20, 74-82`). The model, project and branch are plain text.
2. Not present for the status line.
3. No escape codes; colour comes from the emoji. NO_COLOR irrelevant.
4. None.
5. Separator: plain ` | ` (`statusline-standalone.sh:40-44`).
6. Neighbours: separators only.
7. Not present; emoji are the same on any background.
8. Glyphs: emoji circles.
9. Notable: all colour is carried by emoji traffic-light glyphs, which survive no-colour and pipe contexts. The desktop tile (Python, Windows) shows a yellow "you-are-here" border and a flash on turn end (`desktop-timer/`, hex colours not enumerated).
10. Customisation: none beyond editing the script and the TTL constants.

## xbcratos/claude-code-status-line
https://github.com/xbcratos/claude-code-status-line, stars 1
1. Fixed per field, user-remappable. Defaults (`src/constants/colors.py:48-67`): directory cyan; git branch green; model blue; version magenta; context remaining yellow; cost red; tokens cyan; duration magenta; output style blue; lines changed cyan; CPU blue; memory magenta; battery green; Python version yellow; datetime white; progress-bar filled green, empty white, separator white. Git status adds clean/dirty and ahead/behind colour indicators (README line 19; the status colours were not located in code).
2. Not present as themes; the colour map above is the user's per-field config. Seven names only (`VALID_COLORS`: cyan, green, blue, magenta, yellow, red, white).
3. The seven are the bright ANSI 16 codes (`\033[92m`, `96m`, `94m`, `95m`, `93m`, `91m`, `97m`, `src/colors.py:5-12`). No depth detection. `NO_COLOR` is honoured (`is_color_enabled`, `src/colors.py:24-30`) and a config switch overrides it.
4. Foreground only.
5. Separator: two spaces coloured by the `separator` colour (`display_formatter.py:67`); the progress bar is ASCII `[====----]` with brackets in the separator colour (231-237).
6. Neighbours: distinct hue per field, with different defaults for adjacent fields.
7. Bright (light) variants chosen "for better terminal visibility" (README line 129); no detection.
8. Glyphs: emoji labels (37 hits); ASCII bar.
9. A curses-like configurator `src/configure.py` (`python3 ~/.claude-code-statusline/configure.py`) lets you choose colours per field and the bar settings.
10. Customisation: JSON `~/.claude-code-statusline/config.json` (`config_manager.py:20-21`), the interactive configurator, NO_COLOR.

## xkelxmc/claude-code-statusline
https://github.com/xkelxmc/claude-code-statusline, stars 1
1. Mixed fixed, by model, by threshold, and by project path (`statusline.sh`):
   - Model by id (`model_color`, 85-93): opus purple (198,134,255), sonnet blue (92,178,255), haiku green (120,220,140), fable coral (255,145,90), other white.
   - Effort by level, cold to hot (`effort_display`, 96-113): low blue (80,160,255) `◔`, medium teal `◑`, high yellow `◕`, xhigh orange `●`, max bold red `●`.
   - Context bar `▰▱` by percent (`progress_bar`, 136-163): <20 gray, <50 white, <75 yellow, <85 ANSI-256 208 orange, else red.
   - Rate-limit bars and percentages (`usage_color`, 166-174): <25 gray, <50 green, <70 orange (255,176,85), <90 yellow (230,200,0), else red (255,85,85); labels `c:`/`w:` white and reset glyph `⟳` dim.
   - Path: parent segment dim gray, current directory in `path_highlight_color` (white by default).
   - Fast mode `⚡` yellow.
   - Per-project badge (below).
2. No themes. The user config is the badge list. `~/.claude/statusline-config.json` (lines 248-300): `badges[]` with `pathPattern`, `label`, `color` (hex), `pathColor`, `border`.
3. Mixed: truecolor `38;2` for the model, effort and usage; ANSI-16 and one 256-index for the bar. `hex_to_ansi` converts the badge hex. No depth detection, no NO_COLOR.
4. Foreground only.
5. Separator: a dim `·` between model and effort; otherwise spaces. The badge is a box drawn with border characters.
6. Neighbours: model/effort in distinct hues, structure in dim gray.
7. Not present.
8. Glyphs: Unicode (`▰▱ ◔◑◕● ⟳ ⚡`). Badge borders: `double` (╔═╗), `round` (╭─╮), `heavy` (┏━┓), `light` (┌─┐), `ascii` (+-+) (lines 248, 304-307).
9. Notable: a path-pattern-driven coloured badge with a box border, so a work and a personal checkout can be told apart at a glance (comment: `~/repos/me/*` green round, `~/repos/work/*` purple double); the path's last segment takes the badge colour. Per-model colouring including a "fable" entry.
10. Customisation: JSON badge file and shell constants; `hooks/model-effort-notify.sh` persists model and effort for hooks.

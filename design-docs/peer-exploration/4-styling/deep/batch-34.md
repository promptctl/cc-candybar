# Batch 34: styling read from source

Anchors are repo-relative paths read via raw.githubusercontent.com HEAD. Stars are the scanner's figure (0 everywhere in this batch).

## adenineio/syzygy
https://github.com/adenineio/syzygy, stars 0
Claude Code function-hooks plugin (Ink "band" above the prompt, plus a Go tmux side pane and a browser dashboard). `scripts/statusline-syzygy.sh` is only a tee wrapper that saves the statusLine JSON and then `exec`s the user's own command; it styles nothing.
1. By state/threshold plus fixed per segment, in `syzygy/hooks/hud.tsx` (~L3114-3128). Fixed: model `magenta`, branch `blue` (`gray` with no repo), `+N` green, `−N` red, spend `green` bold, relay `cyan` (gray/dim when down), guard flag `yellow` when >0 else `gray`, clock `cyan` dim. By state: pie glyph, `%` text and the band's border all take `pressure`, which comes from `pieStep(pct)` in the same table as the glyph (`pressureOf`, L559), so border and moon cannot disagree. Pane (`pane-v2/internal/theme/palette.go`): `CtxColor` teal below 65%, yellow from 65%, red from 85%; yellow=interaction/brand, teal=data, purple=agents, green=success "sparingly", grey=disabled/timestamps, red=errors, white=session names.
2. Themes: not present as a switchable feature. The pane has one palette (`palette.go`, a closed set of ANSI indices). Semantic roles are named (Yellow, Teal, Cyan, Red, Purple, Green, Grey, White) but no user theme format. The band uses Ink colour names.
3. Pane: ANSI 0-15 only, never 24-bit; a test asserts `Indexes = {1,2,3,5,6,8,14,15}` are the only ones emitted (`palette.go`). Band: Ink named colours (`hud.tsx`). No NO_COLOR handling found.
4. Foreground only. `palette.go`: "Nothing here paints a background either -- the terminal's own ground shows through every cell." Band is a round-bordered Ink Box (`borderStyle="round"`, `borderColor={pressure}`, `borderDimColor`, hud.tsx ~L3318).
5. No powerline. Single-cell glyph grammar in `pane-v2/internal/theme/glyphs.go`: `▌` panel head tick, `─` hairline rules, `━`/`─` bar fill/empty, sparkline `▁▂▃▄▅▆▇█`, box-drawing for cards. Band items joined by a gap (`VITAL_GAP = 1`).
6. Neighbours are told apart by glyph and by dim vs. bright, not by fill: labels use `TealDim` + Faint, numbers Teal, rules Grey. Band drops low-priority items (`prio`) when narrow (`fitVitals`).
7. Pane inherits the user's terminal theme by design ("change the Ghostty scheme and the pane changes with it"). No contrast selection or light/dark detection found.
8. Emoji moon-phase pie (`PIE_STEPS`, `pieStyle` moon or circle, adds VS16), `⎇`, `⚑`, `⬡ ◆ ✦ ✱ ✕ ⊘`. Each pane glyph is asserted single-width by a test (glyphs.go header). No ASCII fallback mode seen.
9. Animation: band text "decrypt" effect and per-character caption colour (`captionColor`, hud.tsx L993), `motion.animation` count 172 mostly in the browser/three.js dashboard. Browser dashboard with spinner ids, and an Electron app (`syzygy-app`). The cyberpunk look is stated to live in glyph/layout grammar, not colour values.
10. Band settings object `BandSettings` (e.g. `pieStyle`); `just` recipes; env `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`, `SZG_STATUSLINE_DIR`. No colour config.

## ader/ccstatusline
https://github.com/ader/ccstatusline, stars 0
Not marked FORK in the batch, but its README says "A customized fork of sirmalloc/ccstatusline" (npm `@ader-hwang/ccstatusline`). Full report of the shared code, then the differences.
1. Per widget, in settings: each widget item has `color` (fg) and `backgroundColor` (`src/utils/renderer.ts` ~L192: `fgColor = dynamicFgColor ?? widget.color ?? defaultColor`). Default per widget type via `getDefaultColor()` (Icon is `white`). Fork addition: optional `getDynamicColor()` on the Widget interface overrides the static colour from runtime state; used by Context Dots (<50% green, 50-70% yellow, >=70% red) and Context Percentage (README "About This Fork"). In powerline mode with a theme, colour is by POSITION: `themeColors.bg[widgetColorIndex % bg.length]` (renderer.ts L199-203), index not advanced for `merge`d widgets so merged widgets share a colour.
2. Themes: powerline themes only, `POWERLINE_THEMES` in `src/utils/colors.ts` (L268+): custom, nord, nord-aurora, monokai, solarized, minimal, dracula, catppuccin, gruvbox, onedark, tokyonight. Format: per-level (`1`=16, `2`=256, `3`=truecolor) pair of `fg[]`/`bg[]` arrays of five entries each (e.g. nord truecolor bg `88C0D0, 4C566A, 5E81AC, B48EAD, A3BE8C`), cycled by widget index. `custom` uses each widget's own colours. Themes are copyable into custom (`applyCustomPowerlineTheme`, PowerlineThemeSelector.tsx); users edit widget colours in the TUI, no standalone user-theme file.
3. Three colour levels set by `settings.colorLevel` 0 none, 1 ansi16, 2 ansi256, 3 truecolor (`src/types/ColorLevel.ts`; `chalk.level = settings.colorLevel` in `src/ccstatusline.ts` L92). Colour specs: names (`red`, `brightCyan`, `bgBlue`; table `COLOR_MAP` has fixed ansi16/ansi256/hex triples, e.g. red -> 160 -> `#cc0000`), `ansi256:N`, `hex:RRGGBB` (`getColorAnsiCode`). User picks the level; no auto-downsample from detection found. No NO_COLOR in renderer.ts (0 matches); level 0 is the off switch.
4. Both. Widgets can have `backgroundColor`; powerline mode always fills. Non-powerline mode is foreground text. `bgToFg()` maps a bg name to its fg twin.
5. Powerline separators are configurable lists (`separators`, `separatorInvertBackground`, `startCaps`, `endCaps`; default ``), chosen by global separator index, last one repeated. Colours (renderer.ts L355-381): fg = next widget's bg, bg = this widget's bg; if both backgrounds are equal it draws the thin divider instead; `inheritSeparatorColors` option for plain mode. Hex input for glyphs supports full Unicode (README v2.1.9).
6. Powerline themes cycle five bg colours so adjacent widgets always differ; the thin-divider fallback covers equal-bg neighbours. Plain mode: separator widget only. "Override Foreground Color" forces one fg for all.
7. No light/dark detection. Theme fg values are hand-paired with each bg (e.g. nord 3: `hex:2E3440` on `hex:88C0D0`); 16-colour themes pair black/brightWhite by hand. `PowerlineFontStatus` checks for installed powerline fonts by scanning font directories.
8. Powerline glyphs and optional emoji (Icon widget, 12 emoji). Font install helper. No ASCII-only mode beyond turning powerline off.
9. Fork extras: `ColorPicker256.tsx` (interactive 256-colour grid, `numeric` or `hsl` sorted), Context Dots bar, Git File Status, Random Quote. TUI live preview (`StatusLinePreview.tsx`). The upstream HEAD has since gained gradients and a dim option (`gradient.ts`, `applyParensDim`) that this fork lacks.
10. Ink TUI (`npx @ader-hwang/ccstatusline@latest`), settings JSON at `~/.config/ccstatusline/settings.json` (lines, widgets, `colorLevel`, `powerline`, `overrideForegroundColor`, `globalBold`, `flexMode`, `inheritSeparatorColors`).

## adirii/claude-superstatus
https://github.com/adirii/claude-superstatus, stars 0
1. Fixed per component, written inline. `components/repo.mjs`: branch green when clean, yellow when dirty (state), plus a ✅/📁 emoji; directory uncoloured. `components/model.mjs`: model name `cyan`, commit count yellow, version dim. `components/worldclock.mjs` L4-7: per-city colour, Jerusalem cyan `#89dceb`, Odessa green `#a6e3a1`, Winnipeg magenta `#cba6f7`, NY yellow `#f9e2af`. `lib/colors.mjs` has a `contextGradient(pct, greenMax, yellowMax)` (green `166,227,161`, yellow `249,226,175`, then orange to red) but `index.mjs` and the three components never call it (not wired).
2. Themes: not present.
3. Basic ANSI 16 named codes (`COLORS`), truecolor via `hex()`. Worldclock prefers the ANSI name if given ("more compatible"), else hex. No depth detection, no NO_COLOR.
4. Foreground only.
5. Plain text, one component per line; no separators drawn (components are whole lines, joined by `\n`).
6. Not applicable beyond different hues per field; each row is its own line.
7. Not present.
8. Emoji (🧠 Opus, 🎵 Sonnet, ⚡ Haiku, ✅/📁). No fallback.
9. Nothing beyond the unused gradient helper. Screenshot in README.
10. `config.json` (`lines` order list, per README also colours/separators, but `index.mjs` only reads `lines`: `unverified` for the rest), drop-in `components/*.mjs`.

## adlakhavansh/clawline
https://github.com/adlakhavansh/clawline, stars 0
1. Theme role mapped to segments. `src/theme.mjs` header: "Themes map semantic roles to SGR colour codes. Segments never hardcode a colour." Roles: `model, mode, dir, git, pr, cost, tip, good, warn, bad, crit, add, del, muted, sep, text, strong`, plus `bg{base,alt,accent}`, `track`, `ink`. Segment code does `paint(theme.git, branch)`, `theme.pr`, `theme.cost` etc. (`src/segments/repo.mjs`). Load-based colour: one shared `loadRole(pct)` ramp (theme.mjs end): >=90 crit, >=75 bad, >=50 warn, else good, used by context and both rate limits "so one glance means the same thing everywhere".
2. Eight bundled themes: dark, light, nord, mono, tokyo-night, catppuccin, gruvbox, ansi (`THEMES`). Format is the semantic role table above (values are SGR strings; dark/light/nord/mono use 256-index, the last three truecolor hex). `ansi` uses only the terminal's 16 colours. User-defined themes: not present (`config.theme` must be a key of `THEMES`; unknown falls back to dark with a warning, config.mjs L69).
3. 256-index and truecolor `38;2`. Depth detection: if `COLORTERM` is not truecolor/24bit, `getTheme()` lowers every `38;2/48;2` to the nearest xterm-256 (cube or grey ramp, `to256`). Honours `NO_COLOR` (`src/ansi.mjs` L10 `colorEnabled = () => !process.env.NO_COLOR`).
4. Both. Plain/minimal styles use foreground only; powerline and capsule fill blocks with `theme.bg.*` (`src/style.mjs`).
5. Four row styles (`STYLE_NAMES`): plain (configurable gap), minimal (`│` between), powerline (`` / `` right-side), capsule (`` + `` round caps per segment). Arrow/cap colour: `bgToFg(bg)` as foreground over the neighbouring block's bg (style.mjs L16-20, powerline join).
6. In powerline, blocks alternate `theme.bg.base` / `theme.bg.alt` (`blocks(items, theme, alternate)`); the model segment always gets `theme.bg.accent` with `ink` text. Capsule uses base for all and separates with a gap. Alternation counter skips the model block.
7. No light/dark auto-detect: user picks `light` theme (which swaps sep/muted to `37` and uses dark text colours). `ink` role is the dark text drawn on the accent block. No computed contrast.
8. Icon sets `none` / `nerd` (`ICON_SETS`); glyph.nerd_font signals in segments; plain mode is ASCII-clean.
9. Smooth bar with `track` background role; `mono` theme (bold/underline only). A segment can be shrunk or dropped by priority when the row is too wide. TUI picker plus non-TTY edit commands (`src/edit.mjs`), schema generator (`scripts/gen-schema.mjs`), `doctor`.
10. JSON config `~/.claude/clawline.json` then `./.clawline.json` (`config.mjs`): `theme`, `style`, `icons`, `separator`, `padding`, `rows` (also the enable list), per-segment option objects. Interactive picker, `edit` CLI.

## adriendesola/flashcards
https://github.com/AdrienDesola/flashcards, stars 0
Spaced-repetition flashcards shown in the status line. `flashcard.py` has no ANSI escapes, colour names or style code at all (grep for `\033`, `\x1b`, colour came back empty).
1. No colour: plain text.
2. Themes: "theme" here means a flashcard deck topic, unrelated to styling (`pick_theme`, `flashcard theme <name>`).
3. Not present.
4. Plain text.
5. Plain: card line then `a) ... b) ...` choices and a `!flashcard a/b/c/d` hint.
6. Line breaks and indentation only.
7. Not present.
8. Emoji appear in 9 places per scanner (`flashcard.py`); no fallback mode.
9. Nothing styling related.
10. Decks as JSON under `~/.flashcards/decks/`; no styling config.

## adventurelabsbrasil/adventureline
https://github.com/adventurelabsbrasil/adventureline, stars 0
1. Two mechanisms. Label colour by position: a truecolor gradient along the rows (`statusline-grid.py` `grad(t)`, `t = ri/(total-1)` over the row index, stops from `AL_GRAD`), applied to each "EMOJI LABEL:" cell via `style_label`. Value colour fixed per field in `statusline.sh` L91-151: repo bold blue `1;34`, branch magenta `35` (dirty marker yellow `33`), sync cyan `36`, path dim `2`, worktree yellow, session white `37`, agent dim, model bold cyan `1;36`, effort magenta, cost bold green `1;32`, burn dim, lines `+` green / `-` red, limits yellow. Context bar and tokens by threshold (L121-130): >=80 red `31`, >=50 yellow `33`, else green `32`; `(NN%)` dim.
2. Four named themes in `statusline.sh` L19-26 and the `adventureline` CLI (`THEMES="adventure aurora starcommand minimal"`): each is a gradient stop list plus flags. adventure `37,99,235;124,58,237;220,38,38` (blue to violet to red), aurora `52,211,153;34,211,238;167,139,250`, starcommand `96,141,204;226,232,240;148,163,184`, minimal = no gradient, no emoji, no bar, bold labels. Not a role palette; user-defined: via the `AL_GRAD` env var, or `./theme.conf`.
3. Gradient in truecolor `38;2`; values in plain ANSI 16 SGR. No depth detection. No NO_COLOR (0 matches); `minimal` is the monochrome path.
4. Foreground only.
5. Cells in an aligned grid separated by dim ` │ ` (gradient themes) or `  |  ` (bold style), `SEP` in `statusline-grid.py` L22.
6. Alignment into columns (2 columns, 3 at >=110 cols), measured on visible width; label colour steps along the gradient row by row.
7. No light/dark handling; minimal theme is the plain fallback.
8. Emoji per field (📁 🌿 🔃 📂 🔀 🌲 🏷️ 🕵️ 🤖 ⚡ 🧠 💰 🔥 ⏱️ ✏️ ⏳); minimal theme drops emoji. Block bar `█░`.
9. Gradient label style "inspired by Gemini CLI"; SVG previews of each theme in `assets/`. Theme switch via `adventureline theme <name>` or `ADVENTURELINE_THEME`.
10. Env vars `ADVENTURELINE_THEME`, `AL_GRAD`, `AL_LABELSTYLE`, `./theme.conf`, CLI `adventureline theme`.

## agukov-dev/token-meter
https://github.com/agukov-dev/token-meter, stars 0
1. Mostly one muted colour plus state colours. `statusline/statusline.mjs` L76-80: `dim` (the "secondary" grey described below), `bold`, green `32`, yellow `33`, red `31`. Threshold function `limitColor(percent)` L123: >=80 red, >=50 yellow, else green; used for the `▰`/`▱` gauge fill (`▰` coloured, `▱` dim). A "high burn" warning is bold red (L243). Labels, separators and model id are all `dim`. Spend and numbers are default colour.
2. Themes: not present as a feature. It reads Claude Code's own theme from `~/.claude.json` (`/"theme"\s*:\s*"([^"]+)"/`, L62-70, default dark) to choose its grey.
3. Basic ANSI 16 for green/yellow/red; truecolor `38;2;153;153;153` (dark) or `102,102,102` (theme starts with `light`) for the secondary text; `\x1b[90m` for `-ansi` themes (L73). Comment: "SGR 2 (dim) is too faint." No NO_COLOR (0 matches).
4. Foreground only.
5. Plain ` │ ` joiners in dim (L272).
6. Dim vs. coloured; gauge glyph shape.
7. Yes, and it is the distinctive part: it reads the Claude Code theme name and picks the secondary-text grey for light, dark, or ANSI-only themes so the "dim" text matches the mode hint under the prompt.
8. `▰▱` gauge, `│`, `↑`. No emoji seen; no fallback.
9. Plain-text preview mode strips ANSI (`replace(/\x1b\[[\d;]*m/g, '')`, L363) for chat display.
10. Settings persisted via an install flow (`statusline/install.sh`), currency and backfill; no colour config.

## agustin87/Claude_Usage_Monitor
https://github.com/agustin87/Claude_Usage_Monitor, stars 0
not a Claude statusline: a VS Code extension (fork of Claudometer) showing Claude Code cost and quota in the VS Code status bar and a webview dashboard. Only styling of note: `src/ui/statusBar.ts` L63, L74-100 sets the status-bar item colour to RED/AMBER (or none) at quota >=0.9/0.7 or monthly budget ratio >=1/0.8, and `package.json` has an accent-colour setting for the dashboard.

## ahmed-homishan/universal-ai-statusline
https://github.com/AHMED-HOMISHAN/universal-ai-statusline, stars 0
Statusline for Claude Code, Codex and Gemini CLIs, TypeScript, `src/`.
1. By theme, then fixed per field plus thresholds. `src/core/colors.ts`: a fixed ANSI-256 palette (green 82, yellow 226, blue 39, red 196, gray 245, magenta 170, cyan 80) and `contextColor(pct)`: <50 green, <80 yellow, else red, gray when unknown. `compact`/`minimal`/`dashboard` themes: model blue, git branch green, change count yellow, tokens cyan, session duration gray, cost magenta, directory gray, separators gray, context/limits by `contextColor` (`src/themes/compact.ts` L16-55, `minimal.ts`, `dashboard.ts`). `powerline` theme uses fixed background indices per segment (`src/themes/powerline.ts`): model bg 24/fg 255, context bg 22 (<50) / 94 (<80) / 88 (else), tokens 60, git 28 clean / 130 dirty, session 238/fg 250, cost 53, directory 236/fg 250.
2. Four layout themes, `ThemeName`: minimal, compact, dashboard, powerline (`src/themes/index.ts`). Each is a function `(data, cfg, colors) => string`, not a data format; colour palette is shared and fixed. User-defined: no (needs code). `scripts/configure.mjs` interactive config selects the theme.
3. 256-colour index (`38;5;n` / `48;5;n`). `makeColors(enabled)`; honours `NO_COLOR` (named in `src/index.ts` help text L174) and `UAIS_*` env. No depth downsampling.
4. Both: powerline theme fills; the other three are foreground only.
5. Powerline: `` joined so each arrow is previous bg as fg over next bg (`join`, powerline.ts L22-38), last arrow bg-as-fg on default. With colours disabled it joins with ` > `. Other themes use gray `|` or `•`.
6. Powerline: different fixed hue per segment type (blue-ish model, green/orange git, purple cost). Others: different foreground hues.
7. Light/dark: not present; powerline fixes fg 255 on dark backgrounds and fg 250 on greys.
8. Emoji in compact and dashboard (🌿 📂 📊 ⏱ 💲 🧠 📈 📁); powerline arrow needs patched font and falls back to ` > ` only when colour is off.
9. Block-bar for context in compact/dashboard. A VS Code package (`packages/vscode`) exists.
10. JSON config (`UAIS_CONFIG`), `show` flags per field, `UAIS_THEME`, `UAIS_PROVIDER`, `NO_COLOR`, `scripts/configure.mjs`.

## ahokinson/pharos
https://github.com/ahokinson/pharos, stars 0
tmux status-bar renderer (rows written into per-pane tmux options) plus an animated pulse; works for Claude Code, Codex, opencode, Hermes. Not a `statusLine` command output, but its field rows are statusline-style.
1. Theme role mapped to metrics, with ramps. `src/color/palette.ts` is a 26-entry Catppuccin Frappe palette (rosewater...crust) as hex; `src/metrics/builtins.ts` maps metrics to palette keys via `DEFAULTS`: diff add `green`, remove `red`, neutral `overlay2`; tokens gradient `mauve` to `sky` per character (`gradient`) with label `text`; context gradient `teal` to `green`, size `text`, trend rising `peach`, falling `green`, steady `overlay2`; model gradient `mauve` to `sky`; rate limit `lerp` `green` to `red` by percent, muted `overlay0`; tools label `text`/count `subtext0`; permission mode colours `{bypassPermissions: red, plan: sky, acceptEdits: peach}` default `overlay2`. Cost uses a stepped ramp (`steps` at 15 red, 5 peach, 1 yellow, base muted). Everything via `StyleKit` (style.ts): `ramp`, `lerp`, `gradient`, `color`.
2. One bundled palette (Catppuccin Frappe, mirrors `.p10k.zsh`); `config.palette` overrides any entry by hex (`resolvePalette(overrides)`); `metricStyle` bag overrides per-metric palette keys; plugins can add metrics sharing the kit. Format = semantic palette keys per metric, user-overridable.
3. Truecolor only (`rgbEscape`, hex input). No depth detection or NO_COLOR found in `src/color/ansi.ts` (0 matches).
4. Foreground only. The tmux pulse paints with `@thm_*` tmux theme variables (`pulse.themeVars`: think `@thm_blue`, tool `@thm_lavender`, ask `@thm_yellow`, background `@thm_mantle`) with hex fallbacks.
5. Fields separated by a mid-dot (`·`) in muted colour; no powerline.
6. Different palette keys per field plus per-character HSL gradients (shorter way round the hue wheel, `src/color/gradient.ts`); labels vs counts differ by `text`/`subtext0`.
7. Pulse reads tmux theme variables so it follows the user's tmux theme; no contrast computing.
8. Few glyphs: sparkline `▁..█`, trend arrows; `glyph.nerd_font` count 4.
9. ~30 fps pulsing light sweep with a fading comet tail (`buildTail`, `pulse.stepMs: 33`, `tail: 200`); HSL gradient text. Plugin system (`examples/guards.ts`).
10. Config object with `palette`, `fieldOrder`, `fieldSettings`, `widths`, `metricStyle`, `templates`, `plugins` (`src/config/defaults.ts`); CLI `pharos init`, `pharos tmux ...`.

## ahsnahp/claude-statusline
https://github.com/AhSnahp/claude-statusline, stars 0
1. By state/threshold plus a few fixed. `statusline.py`: model `cyan` `36`, branch `magenta` `35`, labels/pipes dim `2`. Effort is a heat map (L51-57): low dim, medium white `37`, high yellow `33`, xhigh orange `38;5;208`, max bold red `1;38;5;196`, ultracode bold magenta `1;38;5;201`; `✦ultrathink` bold magenta, `✦megathink` magenta, `⚡fast` bold yellow. Context bar (`build_bar`, L184): green when remaining >50%, yellow >25%, else red (`effective_remaining` against a compaction threshold). Rate bars: red >80, yellow >=50, else green.
2. Themes: not present.
3. ANSI 16 plus a few 256 indices (208, 196, 201). No depth detection, no NO_COLOR (0 matches).
4. Foreground only.
5. Dim ` | ` between line-1 parts.
6. Hue per field, dim labels vs coloured values.
7. Not present.
8. Block bar; `✦`, `⚡`; limited emoji (3).
9. Effort-level heat gradient is the notable feature; reads the transcript to detect ultracode.
10. None (edit the script).

## ai4pastor/claude-statusline
https://github.com/ai4pastor/claude-statusline, stars 0
Korean-language docs, bash + jq.
1. Mix of fixed role colours (variables in `statusline.sh` L74-117) and a threshold. Roles: `C_MODEL`, `C_DIR`, `C_GIT`, `C_COST`, `C_DIM`, `C_BAR_OK/WARN/CRIT`. `pct_color()` (L465): >= `CRIT_AT` (80) crit, >= `WARN_AT` (60) warn, else ok. Dark scheme: model `1;95`, ok `38;5;155`, warn `38;5;227`, crit `1;31`, dir `38;5;111`, git `38;5;180`, cost `38;5;150`, dim `90`. Light scheme: model `1;35`, ok `38;5;28`, warn `38;5;130`, crit `1;31`, dir `38;5;25`, git `38;5;94`, cost `38;5;22`, dim `38;5;240`.
2. Two colour schemes (`COLOR_SCHEME="dark"|"light"`) as role tables, plus layout "themes" `full`, `minimal`, default-compact that only switch which fields show (L88-100). Users override any role by setting `C_MODEL` etc. in `~/.claude/statusline.conf` (raw ANSI codes allowed).
3. 256-index and bold 16-colour; no depth detection, no NO_COLOR (0 matches).
4. Foreground only.
5. Plain `SEP=" · "` in dim colour.
6. Hue per field role; dim for separators/effort.
7. Light/dark: explicit user choice; the script says the terminal cannot report its background so there is no auto-detect. Light scheme uses darker colours "because pale colours are unreadable on white".
8. Emoji by default (📁 💰 🕐 📅 🖋), `USE_EMOJI=0` swaps in text; `I_*` overrides for Nerd Font glyphs; bar chars `▓░` and a `│` pace marker, all overridable.
9. Weekly bar has a pace marker `│` for "where you should be by now" and ▲/▼ arrows; yellow when ahead of pace. Interactive `--config` menu, `--doctor`.
10. `~/.claude/statusline.conf` (shell vars), `STATUSLINE_CONF`, interactive config, sync script.

## aiexpat/claude-statusline
https://github.com/aiexpat/claude-statusline, stars 0
1. Threshold only. `statusline.sh`: bar and nothing else coloured by context percent: >=90 red `31`, >=70 yellow `33`, else green `32`. Model, percentage, cost, minutes are default colour.
2. Not present.
3. ANSI 16, no detection, no NO_COLOR (not in the 17-line script).
4. Foreground only (the bar glyphs `◼`/`◻`).
5. ` | ` plain.
6. None beyond the bar colour.
7. Not present.
8. `◼◻` bar; no emoji.
9. Nothing.
10. None (edit the 17-line script).

## ajpy08/claudecode-statusline
https://github.com/ajpy08/claudecode-statusline, stars 0
1. Fixed per segment plus state. `statusline.sh`: path bold cyan with the repo folder in bold yellow (L109-ish `path_part`), branch bold cyan `🌿 (branch)`, `+N` green / `-N` red, model magenta `🤖`, separators dim `|`. Context percent coloured by threshold (L76-78): >=90 red, >=70 yellow, else green, plus a status emoji. Quota segments (`quota_seg`, L88-96): remaining <=10% red, <=30% yellow, else green. Context bar is a truecolor gradient along the bar position (L44-60): position 0 to 50 goes green `(0,200,80)` to `(220,200,0)`, 50 to 100 goes to `(220,40,20)`; filled cells take that position's colour, empty cells are dark grey `38;2;60;60;60` `░`.
2. Not present.
3. ANSI 16 plus truecolor via `rgb()` helper. No detection, no NO_COLOR.
4. Foreground only.
5. Dim `|` between sections.
6. Hue per field, dim separators.
7. Not present.
8. Emoji (🌿 🤖 🟢 status emoji); bar `█░`. No ASCII fallback. Day names in Spanish (`day_es`).
9. Per-cell gradient bar (colour by the cell's position, not by the overall fill).
10. Edit the script.

## akaz01/claude-mods
https://github.com/akaz01/claude-mods, stars 0
not a Claude statusline: a set of six Claude Code mods (agent-board panel with an ASCII cat, auto-model, session-collab, blast-radius, replay-theater, token-weather). Styling that is relevant: Ink colours by name, mostly theme-role names. `plugins/agent-board/hooks/view.tsx` L28-37: statuses to `success`, `inactive`, `subtle`, `error`, accent `cyan`. `plugins/token-weather/hooks/token-weather.mjs` L24-27: traffic-light word by context percent (<=50 `Go` green, <=75 `Caution` yellow, <=90 `Stop` red, else `Compact soon` red), `gray` when stale; sits above the prompt. blast-radius confirm box: round border `yellow`, risk summary `red` bold.

## akkijp/baro
https://github.com/akkijp/baro, stars 0
Japanese-only ETA/progress tool; statusline text from `src/baro/render.py`, and a Claude Code mod (`mod/baro-band/hooks/register.tsx`) for the Desktop Code tab.
1. By state. `render.py` L72: `ANSI = {DONE: "32", DOING: "33", WAIT: "34", BLOCK: "31", TODO: "90"}`; bar cells `█` done (green), `▓` current step (yellow), `░` todo (grey `90`), wait blue, blocked red. Only the statusline is coloured ("色を付けるのはステータスラインだけ"; replies stay uncoloured). In the band mod: `COLORS = {'31':'error','32':'success','33':'warning','34':'suggestion'}` (register.tsx L22) and usage percent `error`>=95, `warning`>=80, else `subtle` (L69).
2. Not present.
3. Statusline: ANSI 16 SGR. Mod: Claude Code theme-role names (so they follow the user's Claude theme). `color` flag lets callers turn colour off. No NO_COLOR.
4. Foreground only.
5. Fullwidth bar `｜` between sections.
6. State colour per step; `｜` in dim.
7. Mod uses theme roles, which adapt; statusline uses fixed codes.
8. Emoji state markers (🟩 🟨 ⬜ 🟦 🟥 ⬛, 🙋 💤 ✅) in the detail view.
9. Task-tree view with elapsed/estimated bars (`baro` command output).
10. CLI `baro` (+ hooks), no colour config.

## alamparelli/claude-code-statusbar
https://github.com/alamparelli/claude-code-statusbar, stars 0
1. State only. `statusline.sh`: context percent (including a buffer) coloured: >=80 red `31`, >=50 yellow `33`, else green `32` (L99-107). Git (L155-187) by state: clean green `✓`, changes yellow `⚠ branch(N)`, ahead blue `↑`, ahead plus changes red `⚡`, merging/rebasing magenta `⚙`. Model `[short]` prefix and cwd uncoloured.
2. Not present.
3. ANSI 16; no detection, no NO_COLOR.
4. Foreground only.
5. Plain ` | ` between cwd, context and git.
6. Only state colour; rest default.
7. Not present.
8. Unicode status glyphs `✓ ⚠ ↑ ⚡ ⚙` (emoji count 4).
9. Nothing.
10. Edit the script; `install.sh`.

## albireo3754/albi-config
https://github.com/albireo3754/albi-config, stars 0
A personal dotfiles repo; the styling is a saved ccstatusline config, `statusline/ccstatusline.json` (version 4).
1. Fixed per widget, as ccstatusline stores it: git-branch `magenta`, git-changes `yellow`, context-percentage `cyan`, session-usage `green`, reset-timer `brightBlack`, weekly-usage `blue`, weekly-reset-timer `brightBlack`, model `brightBlack`.
2. Not present; powerline disabled (`"powerline": {"enabled": false}`).
3. `"colorLevel": 2` (256 colours) with ccstatusline's named colours.
4. Foreground only.
5. `separator` widgets (plain) between groups; powerline separator list kept at `` but unused.
6. Different hue per widget; `custom-text` spaces.
7. Not present.
8. None in the file.
9. Nothing beyond `flexMode: "full"`, `compactThreshold: 60`.
10. ccstatusline JSON; `statusline/install.sh` (not read in detail).

## aledallas01/claude-usage-bar-mod
https://github.com/Aledallas01/claude-usage-bar-mod, stars 0
not a Claude statusline: a Claude Code mod for the Claude Desktop Code tab (usage-vs-time bars above the prompt) plus a Windows tray app. Styling that is relevant: colour by pace, not by absolute usage. `plugin/hooks/lib/ui.tsx` L86-100 `paceColor`: usage ahead of elapsed time `error`, within 5 points under `warning`, further under `success`; 0% always success. Uses Claude theme-role names (`suggestion` for fills, `subtle` border, `dimColor` text). SVG charts embed light and dark palettes via `prefers-color-scheme` (L171-172); the tray app uses fixed dark colours (`tray/ClaudeLimitsTray.ps1` L48-59).

## aleksadvaisly/ccstatusline
https://github.com/aleksadvaisly/ccstatusline, stars 0
FORK OF sirmalloc/ccstatusline. Differences only, from `src/`:
- Colour and theme code is the same as the older upstream: same eleven powerline themes (custom, nord, nord-aurora, monokai, solarized, minimal, dracula, catppuccin, gruvbox, onedark, tokyonight), same `COLOR_MAP`, same `ansi256:N`/`hex:RRGGBB` specs, same fg/bg-swap separator colouring (`src/utils/colors.ts`, `powerline.ts`).
- Added: `src/tui/components/ColorPicker256.tsx`, an interactive ANSI-256 picker with `sortMode` `numeric` or `hsl` (HSL-sorted gradient order), entered from `ColorMenu.tsx` in 256-colour mode (not in upstream HEAD, where that file 404s).
- Added: `src/widgets/Icon.ts`, a decorative-icon widget with 12 emoji choices (📁 ⚡ 📊 🕐 🔧 ⚙ 🧠 📄 ✏ 🔍 🏁 👀).
- Older than upstream HEAD on colour: lacks upstream's `gradient.ts` (gradient text) and `applyParensDim` / `dim` option (a diff of `colors.ts` shows these only on the parent side), so this fork is behind rather than ahead there.
- README is the upstream's minimal one; settings at `~/.config/ccstatusline/settings.json`.

## alepspizzetti/statusline-ai
https://github.com/alepspizzetti/statusline-ai, stars 0
1. Fixed labels plus threshold. `statusline-command.sh` L152-211: labels `ctx:`, `tokens:`, `Limits(` white `97`; separators and brackets gray `90`; context percent and used tokens take `bar_color` (>=90 red, >=70 yellow, else green) while the window size is always red; token arrows `↑` cyan, `↓` green; rate-limit values start cyan and become yellow >=50, red >=80 (L175-176); final printf (L222): model cyan, git info blue, separators gray. Order is limits, context, model+git.
2. Not present.
3. ANSI 16 (incl. bright white `97`, gray `90`); no detection, no NO_COLOR (0 matches).
4. Foreground only.
5. Plain gray ` | `.
6. Hue per field.
7. Not present.
8. Few glyphs (`↑ ↓`); script comments use box-drawing; no emoji.
9. Nothing; writes `last_input.json` for debugging.
10. Edit the script; `install.sh`.

## alevin76/claude-status-bar
https://github.com/AleVin76/claude-status-bar, stars 0
Claude Code mod rendering a coloured bar above the prompt (Italian docs); equivalent to a statusline.
1. By state, using Claude Code theme-role names. `hooks/register.ts`: `levelColor(percent)` L68: `error` from `ERROR_FROM`, `warning` from `WARNING_FROM`, else `success` (README: green <50%, yellow >=50%, red >=80%), applied to each bar and its value. Cache-timer bar goes green when fresh to red near expiry. Effort letters (`EFFORT_STYLE` L33-38): low `inactive`, medium `success`, high `warning`, xhigh `claude`, max `error` bold. Menu `[≡]` uses `suggestion`.
2. Themes: follows Claude Code's own theme by design ("I colori seguono il tema di Claude Code"); no theme format of its own.
3. Claude theme-role names resolved by Claude Code (so depth and light/dark handled by the host). Not ANSI codes.
4. Foreground only (bars are `█░` glyphs).
5. Dim ` | ` between blocks.
6. Different emoji per block and level colours; separators dim.
7. Yes via the host: theme roles adapt to light and dark Claude themes.
8. Emoji per block (⏳ 🧠 🕒 📅 🤖 ⚡ 💲).
9. In-band menu (`[≡]`) with a block editor (show/hide/reorder, per-block bar toggle, preview), sounds for completion and questions.
10. Options `blocks`, in-UI editor; config in `docs/configuration.md`; install scripts.

## alexandrebouthinon/claude-statusline
https://github.com/alexandrebouthinon/claude-statusline, stars 0
Go, Powerlevel10k-style pills.
1. Role per segment plus state, in `main.go` L100-161 with palette fields from `style.go`. Directory + branch `theme.dir`; model `familyColor(...)`: haiku, sonnet, opus and fable each have their own palette colour so a family keeps one colour everywhere (style.go); context bg `theme.ok`, becomes `warn` at `compactThreshold` and `crit` at 2x; 5h limit `theme.limitOK` and weekly `theme.week` become `warn` >=50% and `crit` >=80%; cost uses `costBg/costFg`. Segment text is `theme.light` on dir/model, `theme.dark` on state segments.
2. Five bundled palettes in `style.go` (p10k, Catppuccin Mocha, Tokyo Night, Nord, Gruvbox) as a `palette` struct of hex roles (dir, model, ok, limitOK, warn, crit, costBg, costFg, week, haiku, sonnet, opus, fable, light, dark). Selected at compile time: `var theme = palettes[2]` (Tokyo Night); README: "Change `theme` to switch". No runtime config, no user files.
3. Truecolor hex only (`\033[38;2/48;2`). No detection, no NO_COLOR (0 matches).
4. Background-filled pills (`pills()`); `powerline()` function exists with arrow joins but `layout` uses pills.
5. Rounded caps: Nerd Font `capRound` / `sepRound` per pill, pills separated by a space; powerline variant uses `` solid arrow, falling back to a thin divider when adjacent backgrounds are equal (style.go L84-90). Cap colour = the pill's own bg as fg.
6. Distinct role hue per pill and a gap between pills.
7. Yes: `textOn(bg)` (style.go) picks the palette's dark or light text from luma `0.299r + 0.587g + 0.114b > 140`.
8. Nerd Font icons throughout (35 refs); `--glyphs` and `--caps` demo commands; no ASCII fallback.
9. Per-model-family colours; team line of running subagents on a second row; `--demo`, a screenshot script.
10. Compile-time palette edit; flags `--demo`, `--glyphs`, `--caps`, `--hook`.

## alexfloyd13/questline
https://github.com/AlexFloyd13/questline, stars 0
A tamagotchi-style ASCII pet in the status line (XP from tokens). Styling is game-driven rather than informational.
1. By level band, rarity and event. `data.py` L104-111: the pet sprite colour climbs a ladder by level: <=5 white, <=15 green, <=30 cyan, <=50 blue, <=75 magenta, <=99 silver (256-index 250), above that gold (220); the owner can choose any unlocked colour (`color_for_pet`, core.py L375). Rarity names map to white, green, cyan, blue, magenta, gold (`RARITY_COLOR`). Landscape uses 256-greens (pine 28, forest 34, lime 76, sage 108, dark_green 22), brown trunks, seasonal orange pumpkins and pink hearts. Enemies each carry a colour (`adventure.ENEMIES`).
2. Not present as a theme feature (pet colour unlocks by level).
3. Bright ANSI 16 (`97 92 96 94 95 91`) plus 256-index for the extras (`COLORS`, data.py L78). Anything not in the table renders uncoloured. No NO_COLOR (0 matches).
4. Foreground only.
5. Plain double-space between stats; scenery drawn with ASCII.
6. n/a (a single scene).
7. Not present.
8. ASCII art; one emoji.
9. Procedural landscape, seasonal events, levelled colour unlocks.
10. State in a save file; commands in `cli.py`.

## alexisgeneau/claude-code-statusline
https://github.com/alexisgeneau/claude-code-statusline, stars 0
1. Fixed per project, persisted. `statusline.sh` L32-111: line 1 is a full-width bar whose background is chosen by project name from `~/.claude/statusline-colors.tsv` (`name<TAB>code`); a project with no entry gets a random pick from a 22-colour palette (`24 25 26 30 31 36 37 61 66 90 94 96 100 125 130 131 133 136 160 166 168 172`), which is appended to the file so it stays stable. The code may be a single 256 background index, `stripes:c1:c2` (vertical stripes alternating two colours) or `gradient:c1:c2` (horizontal gradient between two indices 16-255, per column). Text is always bold white (`1;38;5;15`). Line 2 (context, quotas, model, effort) is completely uncoloured.
2. Themes: not present; the per-project colour file is the only palette and it is user-edited. The README keeps the file out of git because it lists project names.
3. ANSI 256 backgrounds. No downsampling, no NO_COLOR (0 matches). Width from `COLUMNS` (needs Claude Code >= 2.1.153).
4. Background fill on line 1 (full width, padded with spaces); foreground-only on line 2.
5. None: single block; stripes and gradient are in-bar effects. Label truncated to width.
6. Different project colour per project (so you can tell terminals apart); within a line, nothing.
7. Fixed white text on a palette chosen to be readable with it ("palette lisible avec texte blanc"); no detection.
8. Emoji on line 2 (🧠 ⏱ 📅 🤖 ⚡), `⎇` for branch. No fallback.
9. Stripes and gradient backgrounds per project, case-insensitive name match. Directly relevant to "consistent colour for a specific thing": the unit coloured is the project, persisted and user-overridable.
10. `statusline-colors.tsv` and `install.sh` (writes settings.json key); nothing else.

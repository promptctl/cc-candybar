## thawinwats/claude-statusline
https://github.com/thawinwats/claude-statusline — stars: 0
1. Colour source: fixed per segment plus thresholds. `statusline-command.sh:36` model is always `\033[0;35m` (magenta); `:43-49` context bar colour by percent (>=85 red, >=60 yellow, else green); `:51` the "NN%" next to the bar is always green regardless of threshold; `:58` token count `\033[0;37m` (white); `rate_color` (`:77-86`) same 85/60 split for 5h and 7d; `pct_left_color` (`:90-99`) colours the reset countdown by time left (<=15 red, <=40 yellow, else green).
2. Themes: not present.
3. Spec/depth: ANSI 16 only (`\033[0;3Xm`). No depth detection. `NO_COLOR` is honoured only by `install.sh:5` for the installer's own messages, not by the statusline script.
4. Fill: foreground-only text.
5. Separators: plain ` | ` text (`:52`, `:58`), uncoloured.
6. Neighbours: separators only; hue differences come from the fixed per-segment colours.
7. Light/dark: not present (no contrast logic).
8. Glyphs: `█`/`░` 20-cell bar (`:15-26`), `↺` for reset; no Nerd Font, no ASCII fallback.
9. Other: a "caveman badge" segment (named in the header comment); reset times roll forward past elapsed windows. No gradient or animation.
10. Customisation: none beyond editing the script; `install.sh` writes the settings.json statusLine entry.

## the-cybersapien/claude-cache (cachekeeper)
https://github.com/the-cybersapien/claude-cache — stars: 0
not a Claude statusline: a Claude Code mod (plugin) that auto-compacts an idle session before the prompt cache expires. It draws a band above the prompt (`hooks/register.tsx:575-650`, `ui.render` on `AbovePrompt`) with `<Text color='green'|'yellow'|'red'>` on the word "cache", chosen by state (refreshing=green, warm >=5 min left=green, <5 min=yellow, compacting=yellow, cold=red), `dimColor` for the line text, and host `Button`s. Colours are the host's semantic names, so the host theme applies; no palette of its own.

## TheBrunoPetkovic/herdr-context-display
https://github.com/TheBrunoPetkovic/herdr-context-display — stars: 0
Note: this targets the herdr agent sidebar, with a Claude Code `statusLine` command as the data source. The styling is for herdr's sidebar row, with a bar in the statusline text.
1. Colour source: by threshold, three buckets. `src/lib/gauge.ts:17-21` `bucketFor`: pct >= crit_at (default 80) crit, >= amber_at (default 65) warn, else ok (`src/lib/config.ts` DEFAULTS). Bucket names map to herdr tokens `$ctx`, `$ctx_warn`, `$ctx_crit` (`gauge.ts:5-9`); `install.ts:14-16` writes those tokens into the herdr sidebar config with `fg = palette.ok/warn/crit` and `bold = true` for crit. The model name has its own token (`model`).
2. Themes: palettes keyed by the user's herdr theme name, `src/lib/themes.ts:13-25`: catppuccin, tokyo-night, dracula, nord, gruvbox, one-dark, solarized, kanagawa, rose-pine, vesper, plus `terminal` fallback (`#2f9e44/#e8590c/#e03131`). Format is a 3-role palette `{ ok, warn, crit }`. `readThemeName` parses `[theme] name` from the herdr TOML; unknown or missing theme falls back to catppuccin / FALLBACK. Users override with `ok_color`, `warn_color`, `crit_color` in config.toml (`install.ts:95-106`).
3. Spec/depth: truecolor hex. No downsampling, no `NO_COLOR` (herdr applies the colours).
4. Fill: foreground-only.
5. Separators: ` · ` in the default line format `"{model} · {bar} {pct}%"` (`config.ts`).
6. Neighbours: not applicable (one number per row).
7. Light/dark: follows the herdr theme by name only; no contrast calculation.
8. Glyphs: `▓`/`░` 10-cell bar (`gauge.ts:35-39`); no Nerd Font or emoji requirement.
9. Other: `{model} {pct} {bar} {used} {window} {dir}` placeholders in `line_format`.
10. Customisation: flat TOML `config.toml` (`amber_at`, `crit_at`, `show_tokens`, `line_format`, `wrapped_command`, three colour overrides).

## thecodekaizen/agent-statusline
https://github.com/thecodekaizen/agent-statusline — stars: 0
Multi-agent statusline (Claude, Codex, Antigravity, shell adapters).
1. Colour source: theme role mapped to segment, plus threshold. `src/renderer.ts`: agent badge `theme.primary` (:23), model `secondary` (:36), steps/tools `stats` (:54), sandbox `muted` (:65), git `tertiary` or `warning` when dirty (:99), cwd `quaternary` (:109), context `error` >80, `warning` >50, else `quaternary` (:121), tokens `quaternary`, cost `stats`, memory `error` >85 else `quaternary`, duration `primary` (:167).
2. Themes: 5 bundled in `src/themes.ts:11-72`: catppuccin (Mocha, default), tokyonight, nord, gruvbox, cyberpunk. Format: 9 semantic roles (`primary, secondary, tertiary, quaternary, stats, success, warning, error, muted`), each a `{fg, bg}` pair, so the text colour is hand-paired per role. Users choose by name (`--theme`, config `theme`); no user-defined palettes (the table is hard-coded).
3. Spec/depth: truecolor only (`utils/ansi.ts:16-21` `38;2`/`48;2`). No detection, no downsampling, no `NO_COLOR`.
4. Fill: background-filled powerline segments (`renderer.ts:243`, bold text).
5. Separators: 5 styles in `src/glyphs.ts:3-39`: arrow, rounded, slanted, block, ascii (`>`/`<` with `[`/`]` caps). Between segments: separator glyph with fg = previous bg and bg = next bg (`renderer.ts:239`); left segments and right-aligned segments (flex spacer) with mirrored glyphs; closing cap fg = last bg.
6. Neighbours: different theme role per segment (different bg hues); separators; `quaternary`/`muted` are dark surfaces.
7. Light/dark: not present; themes are dark. Foreground per role is the theme's own dark base colour on pastel bgs (e.g. `#11111b` on `#cba6f7`).
8. Glyphs: Nerd Font icons (`NERD_FONT_ICONS`, `glyphs.ts`) with Unicode fallback via `nerdFonts:false` / `--no-nerd-fonts`; ascii powerline style.
9. Other: width-aware priority dropping (`renderer.ts:199-224`, drops highest-priority-number segments until it fits); a `tui.ts` for cycling theme (`t`) and style (`s`) with live preview.
10. Customisation: JSON `~/.config/agent-statusline/config.json` (theme, style, nerdFonts, show* flags; `config.ts`), CLI flags `--theme --style --no-nerd-fonts`, TUI.

## theishandubey/claude-mods
https://github.com/theishandubey/claude-mods — stars: 0
Collection of Claude Code mods (plugins); the relevant one is `plugins/meter` (status line + band + SVG gauges), `agent-graph` is a diagram plugin.
1. Colour source: by state/threshold, via host semantic colour names. `plugins/meter/hooks/format.ts:18-29` `loadTone`: >=80 `error`, >=50 `warning`, else `rest` (default text); `hitTone` (cache hit rate): <40 error, <80 warning; cache dot (`:38-41`) success/warning/error by TTL. Model name uses `warning` only on fallback (`row.tsx:31`). Git detached head and behind count `warning` (`statusline.tsx:65-70`). Labels are `dimColor`.
2. Themes: none of its own; colour names are the host's (`Color` type from `claude-code`), so the user's Claude Code theme supplies the actual values. Fixed SVG colours `format.ts:1`: warning `#c98a1b`, error `#d0544a`.
3. Spec/depth: host semantic names (no ANSI index or hex in text runs); hex only in SVG gauges. `NO_COLOR` not present.
4. Fill: foreground-only text; gauges are SVG images (`svg.ts`).
5. Separators: gap-based columns (`columnGap` in `row.tsx`), no glyph separators.
6. Neighbours: dim labels versus toned values; spacing.
7. Light/dark: SVG `PALETTE_STYLE` (`svg.ts:7`) uses `@media (prefers-color-scheme: dark)` to swap `#2a78d6` / `#3987e5`; text follows host theme automatically.
8. Glyphs: `●` cache dot, `↓` behind; SVG bars instead of block characters.
9. Other: responsive "levels" that drop segments to fit width (`row.tsx`, `rowWidth`).
10. Customisation: plugin options in Claude Code (`/plugin configure`); no colour options.

## themikemoniker/200ktokenskill
https://github.com/themikemoniker/200ktokenskill — stars: 0
1. Colour source: by threshold on context percent. `scripts/statusline.sh:25-32`: >=80 red `\033[31m` (and a bold-red "USE /handoff" warning), >=60 yellow, else green; the whole segment (bar and count) takes the one colour.
2. Themes: not present.
3. Spec/depth: ANSI 16. No detection; no `NO_COLOR`.
4. Fill: foreground-only.
5. Separators: not present (single segment).
6. Neighbours: not applicable.
7. Light/dark: not present.
8. Glyphs: 10-cell block bar (`FILLED` capped at 10, `:39`); no icons.
9. Other: textual call to action at 80%.
10. Customisation: none (edit script); `setup.sh` installs.

## theofonsecapaixao-sys/claude-usage-overlay
https://github.com/theofonsecapaixao-sys/claude-usage-overlay — stars: 0
Mixed repo: a Windows PowerShell statusline plus a WPF desktop overlay and a browser extension showing the same usage.
1. Colour source: by threshold on percent. `terminal/statusline.ps1:5-8` `Paint`: >=85 red (31), >=60 yellow (33), else green (32); applied to the "5h", "7d" and context segments. The overlay (`overlay/usage-overlay.ps1:58`) and extension (`extensao/shared.js:5`) use the same 85/60 split with hex `#EF4444 / #F59E0B / #22C55E` (extension lower-case).
2. Themes: not present.
3. Spec/depth: ANSI 16 in the statusline; hex in the overlay. No detection or `NO_COLOR`.
4. Fill: statusline is foreground-only; the overlay uses filled progress bars.
5. Separators: not examined beyond plain text joins in the statusline.
6. Neighbours: threshold colour only.
7. Light/dark: overlay uses a translucent dark panel, white text (`#FFE5E5E5`); no adaptation.
8. Glyphs: text only in the statusline (Portuguese labels, e.g. "agora").
9. Other: overlay with drop shadow, opacity setting.
10. Customisation: none in the statusline script.

## thereprocase/claude-statusline
https://github.com/thereprocase/claude-statusline — stars: 0
1. Colour source: mixed. Each theme file is a Python module; the shared layout `themes/core.py:700-` (`render_standard`) takes a theme dict whose `colors` map semantic names to xterm-256 ints (user, effort, duration, empty_bar, rl_label, rl_reset, operation, worktree, branch, detached, remote_arrow, remote, ahead, behind, dirty, stash, path). Model colour by tier (`tier: {opus, sonnet, haiku}`, e.g. dracula: opus purple 141, sonnet cyan 81, haiku green 84). Context bar and rate-limit bars colour each cell along a 20-entry gradient list `grad` indexed by percent (`_std_grad_color`, `core.py:729`; `_std_bar` :734 gives each cell its gradient colour and four fill levels `█▓▒░`, empty `─`).
2. Themes: 14 bundled per README (buddy default, monochrome, amber, dracula, lcars, catppuccin, rainbow, outrun, ibm3278, c64, win95, teletext, matrix, skittles) as Python files in `themes/`; format is a Python dict (see 1) or a fully custom `render()`. Selected by `~/.claude/statusline-theme` (`theme.sh`, `statusline-command.sh:9`). Users can add a module.
3. Spec/depth: xterm-256 indexes only (`core.py:19-23`, `38;5` / `48;5`). No depth detection; `NO_COLOR` not present (grep).
4. Fill: mostly foreground; LCARS builds solid chips with `bg()` (`themes/lcars.py:42-43`, black text on a coloured bg, wrapped in fg-coloured bracket glyphs); win95/teletext/c64 also use backgrounds.
5. Separators: per theme `sep` string, e.g. dracula ` │ ` in comment colour; rainbow ` │ ` dim; skittles a random candy colour and random separator char each draw (`skittles.py:25-28`); lcars bars/brackets.
6. Neighbours: different hues from the theme dict; separators.
7. Light/dark: not present; themes are fixed dark styles. Monochrome theme for no colour.
8. Glyphs: heavy use of box/block characters (2835 signal hits); emoji few; no Nerd Font requirement.
9. Other: standout. Rainbow theme gradient with a "corruption glitch" engine at high context (random block glyphs, `BLINK`, `REVERSE`, `rainbow.py:33-60`); per-character colouring (`CHAR_COLORS` maps each letter to a colour; skittles colours every character; buddy cycles the "/buddy sunset" six colours through text); `random.seed` from the clock so skittles changes each draw. `docs/gridline/themes.css` preview gallery.
10. Customisation: `bash setup.sh` interactive walkthrough (theme, model format, initials, date format, auto-hide reset) saved to `~/.claude/statusline-config.json`; `theme.sh <name>`; `echo name > ~/.claude/statusline-theme`.

## thissayantan/vitals
https://github.com/thissayantan/vitals — stars: 0
1. Colour source: theme role mapped to segments plus a shared threshold ramp. Segments call `ctx.Theme.Style("<role>")` (`internal/segments/*.go`): `muted` for labels/badge/SHA, `warn` for the git dirty `*`, etc. Threshold role ramp `pctRole` (`context.go:75-83`): >=80 `crit`, >=60 `warn`, else `ok`, shared by context and rate-limit segments. Context bar cells use the theme gradient by position (`internal/theme/bar.go:9-27`, index `i*len(gradient)/total`; unfilled cells `#3c3c41` dim). Task bar: done=`ok`, next in-progress=`warn` (`bar.go:47-60`).
2. Themes: 6 JSON files in `themes/`: catppuccin-mocha (default), gruvbox, nord, rose-pine, tokyo-night, none. Format (`themes/nord.json`): `roles` = 12 semantic roles (`brand, accent, muted, git, dir, ok, warn, crit, add, del, cost, estimate`), each `{fg, bg?, bold?, dim?}` hex, plus a 10-stop `gradient`. User-defined: `"theme": "custom"` + `themeOverrides` per role (`theme.go:106-116`), or per-segment `"style"` in config.
3. Spec/depth: hex values downgraded at render: truecolor (`38;2`) -> ansi256 (`rgbToANSI256`, cube/grey ramp) -> ansi16 (nearest of a 16-colour table) -> none (`theme.go:208-262`). Detection: `COLORTERM` truecolor/24bit, `TERM` containing 256color, `TERM` empty/dumb is none (`resolveColorMode`, `:280-307`). `NO_COLOR` set to anything forces none (`:281`). Override via `colorMode` setting.
4. Fill: foreground-only (roles may carry `bg` but bundled themes set `fg`).
5. Separators: plain configurable string, default ` │ ` (`render.go`); falls back to ` | ` under ASCII charset when the string has non-ASCII (`effectiveSeparator`). Separator uncoloured/default.
6. Neighbours: separators plus per-role hues (git purple, dir blue in nord).
7. Light/dark: not present; all bundled palettes are dark. `none` theme for plain.
8. Glyphs: three charsets `unicode` / `nerdfont` / `ascii` (`glyphsFor`, `theme.go:~335`); `CC_STATUSLINE_ASCII=1`, `CC_STATUSLINE_NERDFONT=1` env; Nerd Font adds language icons.
9. Other: TUI config editor with live preview (`vitals config`: cycle theme `t`, charset `c`, separator `[ ]`, reorder, preset layouts, save), `vitals doctor` printing detected colour mode; JSON Schema for config.
10. Customisation: JSON at `./.vitals.json` or `~/.config/vitals/config.json` (lines -> segments -> options/style/enabled), CLI TUI, env `NO_COLOR`, `CC_STATUSLINE_*`.

## thurtado1993/claude-cabina
https://github.com/thurtado1993/claude-cabina — stars: 0
not a classic Claude statusline: a Claude Code mod (fork of Flightdeck) rendering a live dashboard panel for Claude Code Desktop, plus an optional one-row strip above the prompt. Styling notes, since the strip and panel colouring may be relevant: `cabina/hooks/core.ts:146-185` defines two palettes of 10 roles (`main, agent, gate, cleared, arch, amber, warn, dim, faint, text`): `theme` maps them to the host's own theme colour names (`claude, suggestion, success, permission, merged, warning, error, inactive, subtle, text`) so it follows light, dark and colour-blind themes, and `pastel` is fixed hex (`#7dd3fc`, `#93c5fd`, `#86efac`, ...) for dark terminals; chosen by the `palette` plugin option. Context and rate-limit gauges switch `C.main` to `C.warn` at >=80% (`register.tsx:758,773`). Round bordered boxes (`borderColor=C.main`). Animation: braille spinner (`spinner.tsx`, frames `⠋⠙⠹...`), packets along connectors. SVG fixed mid-tone colours (`SVG_COLORS`, `core.ts:183`) "read on light and dark backgrounds".

## tilakp/claude-statusline
https://github.com/tilakp/claude-statusline
 — stars: 0
Wraps the existing ccstatusline (npm) tool with a committed config; styling is ccstatusline's.
1. Colour source: fixed per segment, set in `ccstatusline/settings.json`: current-working-dir blue, model cyan, git-branch magenta, git-changes yellow, context-bar green, block-timer yellow, session-usage cyan, weekly-usage magenta, weekly-reset-timer brightBlack; separators uncoloured (`inheritSeparatorColors:false`). A custom command (`bin/code-velocity.sh:33`) prints `Δ` dim, added green (`\033[32m`), removed red (`\033[31m`) with `preserveColors`.
2. Themes: not present in this repo (ccstatusline's own powerline themes unused).
3. Spec/depth: named colours; `"colorLevel": 2` (256-colour) in settings.json. `NO_COLOR` not present here.
4. Fill: foreground-only (not powerline).
5. Separators: separator items of default text between segments (`type: "separator"`).
6. Neighbours: different named hues per segment, separators.
7. Light/dark: not present.
8. Glyphs: `⎇`, `Δ`, `█░` bars (README sample).
9. Other: two-line layout; `flexMode: full`, `compactThreshold: 60`.
10. Customisation: ccstatusline `settings.json` (version 3: lines of items with id/type/color/rawValue/metadata).

## tj-smith47/claude-ui
https://github.com/tj-smith47/claude-ui — stars: 0
1. Colour source: fixed per segment plus thresholds, all Dracula Pro truecolor. `statusline-command.sh:36-45` palette (CYAN `128;255;234`, GREEN `138;255;128`, ORANGE, PINK, PURPLE, RED, YELLOW). Model bold cyan (:93), directory bold purple, branch pink after an orange `▸`, dirty `✗` red, effort yellow `◆`, 1M tag pink, style name green. Context count: green, yellow at >=70, red at >=90 of the auto-compact window (:67-71 `fillpct`, graded against `autoCompactWindow` from settings.json, not the model max). Rate windows: 5h orange, 7d pink, each turning red at >=85 (:79-81).
2. Themes: the statusline is hard-coded Dracula Pro. `themes/dracula.json` is a different thing: a Claude Code theme file (`base: dark` plus `overrides` of ~30 Claude UI colour keys such as `claude`, `primary`, `diffAdded`, `keyword`), installed by `setup.sh`, not read by the script.
3. Spec/depth: truecolor `38;2;R;G;B` only; no detection, no `NO_COLOR`.
4. Fill: foreground-only.
5. Separators: major divider `❙` always green (`SEP`, :43), "keeps Dracula green on screen regardless of the context segment's gradient"; minor divider a muted `·` (`125;125;160`).
6. Neighbours: different hues per segment plus the green divider.
7. Light/dark: not present (dark only).
8. Glyphs: `◆ ⚡ ▸ ✗ ⊘ ❙` (Unicode, deliberately a solid triangle because `⎇` clipped); no Nerd Font.
9. Other: auto-compact marker `(⊘200k)`; comment explains choice of grading against compaction wall.
10. Customisation: edit script; `setup.sh` installs the script and the Claude theme.

## tkhashi/Claude.Mods
https://github.com/tkhashi/Claude.Mods — stars: 0
Collection of Claude Code mods (filepicker, peek, statusbar-buttons). The statusline is `statusbar-buttons/statusline/statusline.ts`; the 797 Nerd Font glyph and 720 hex hits come from `filepicker/hooks/devicons.ts` (file-type icon table), not the statusline.
1. Colour source: fixed labels plus threshold values. Labels (dir/git icons, `5h:`, `7d:`, `ctx:`, `ac:`, `pr:`) are fixed Claude orange `#da7756` (:27, truecolor). Values use 16-colour SGR "that follow the terminal theme": path cyan (36); branch green when clean, yellow when dirty (:157); ahead green, behind magenta, changes yellow; PR number by review state (approved 32, changes_requested 31, draft 90, else 35, :166). Indicators (`indicatorsOf`, :105-117): each has an accent (5h magenta 35, 7d blue 34, ctx cyan 36, ac yellow 33) that becomes yellow at >=50 and red at >=80 (`levelSgr`, :85).
2. Themes: not present (the repo's catppuccin hits are in the file picker).
3. Spec/depth: mix of truecolor (labels) and ANSI 16 (values). No detection or `NO_COLOR`.
4. Fill: foreground-only.
5. Separators: two spaces between groups (`GROUP_GAP`); no glyph.
6. Neighbours: orange label then coloured value; spacing.
7. Light/dark: values deliberately use 16-colour SGR so the terminal theme decides (comment at :146); labels fixed.
8. Glyphs: Nerd Font icons for dir and git (`ICON`, :30), OSC 8 hyperlink on the PR number.
9. Other: width-fitting (bar form then percent-only form then row wrapping; branch names shortened first).
10. Customisation: none beyond code.

## tkm3d1a/cship-windows (fork of stephenleo/cship)
https://github.com/tkm3d1a/cship-windows — stars: 0
Fork differs from parent: none in styling. The GitHub compare of `stephenleo/cship:main...tkm3d1a:main` reports 0 commits ahead and 214 behind, so the fork is a stale copy of the parent with no changes of its own. For reference, the parent's styling as it exists in the fork: style strings are Starship-compatible tokens ("bold green", "fg:red bg:blue") parsed in `src/ansi.rs:8-45` via `nu_ansi_term`; colour names black/red/green/yellow/blue/purple|magenta/cyan/white, `#RRGGBB`, `#RGB`, or a 0-255 index (`parse_color`, :125-155); threshold switching `apply_style_with_threshold` (`warn_threshold`/`warn_style`/`critical_threshold`/`critical_style`, applied e.g. in `modules/context_bar.rs:42-56`); foreground-only by default, bg via `bg:`; config is TOML.

## tmastalirsch/herdr-claude-context-meter
https://github.com/tmastalirsch/herdr-claude-context-meter — stars: 0
Herdr sidebar/pane meter fed by a Claude Code `statusLine` hook; bar conventions copied from the get-shit-done status line (`render.sh:3`).
1. Colour source: by threshold on "usable" context percent (after the auto-compact buffer): `render.sh:45-53` `color_for`: <50 green `\033[32m`, <65 yellow, <80 orange `\033[38;5;208m`, else blinking red `\033[5;31m`; the whole bar+label gets that colour. A skull emoji appended at >=80 (`glyph_for`, :55).
2. Themes: not present.
3. Spec/depth: ANSI 16 plus one 256 index (208). No detection. Colour is switchable off with `METER_COLOR=0` (`meter-statusline.sh:9`), not `NO_COLOR`.
4. Fill: foreground-only.
5. Separators: not present.
6. Neighbours: not applicable (single meter).
7. Light/dark: not present.
8. Glyphs: `█`/`░` bar, 💀 emoji; fixed-width label `%3d%% (%2d%%)` so columns align.
9. Other: blinking (SGR 5) at the critical level; shows usable and raw percentages.
10. Customisation: env `METER_COLOR` and width/raw toggles in the scripts.

## TobiWipf/claude-usage
https://github.com/TobiWipf/claude-usage — stars: 0
1. Colour source: theme role mapped to segments plus a threshold. `statusline.py:25-85` theme dicts have 9 roles: `branch, worktree, model, effort, label, sep, ctx_low, ctx_med, ctx_high`. Branch/worktree/model bold in own colours (:169-175), "effort:" and "ctx:" labels in `label`, effort value `effort`, separator `|` in `sep`. Context colour via `ctx_color` (:95-102): <50 `ctx_low`, <80 `ctx_med`, else `ctx_high`; label colour when unknown.
2. Themes: 6 bundled in a Python dict (`THEMES`): default (256-index: 110/214/140/108/244/240/108/214/203), mono (all empty), dracula, nord, solarized (truecolor), vivid. Format: per-role dict. Chosen by env `CLAUDE_STATUSLINE_THEME`; user-defined requires editing the dict.
3. Spec/depth: mix of 256-index (`_fg256`) and truecolor (`_fg`). No depth detection. `NO_COLOR` set (any non-empty value) selects the `mono` theme (:89-90).
4. Fill: foreground-only.
5. Separators: ` | ` text coloured by `sep` role (:166).
6. Neighbours: separators plus per-role hues; branch bold.
7. Light/dark: not present (dark palettes).
8. Glyphs: text only (`effort:`, `ctx:`, "(worktree)"), no icons.
9. Other: nothing notable.
10. Customisation: env var `CLAUDE_STATUSLINE_THEME`, `NO_COLOR`.

## toni-schmitt/claude-code-statusline (Ember)
https://github.com/toni-schmitt/claude-code-statusline — stars: 0
Note: the scanner read only the preview tooling; the real code is C# (Native AOT) in `src/Ember.Core/Render/`.
1. Colour source: by role plus severity plus gradient. `Palette.cs:11-24`: ANSI-256 indices; grey 245 (`Label`) carries every label, unit and non-status icon ("Colour carries severity"). Project name and session clock and ctx value use `GradientStop2` (223), branch 150 (`Line.cs:88-109`), effort `GradientStop6` (166). The model name is painted per character along a six-stop "ember" gradient (230, 223, 216, 209, 202, 166; `Gradient.cs`, interpolated across the string so the first char is stop 0 and the last stop 5). Severity (`Palette.Severity`, :34-41): <60 stop2, <80 notice 222, <95 warn 180, else critical 203 + bold. Usage bars: each cell is coloured by the severity of the percentage range that cell covers (`Meter.cs`), so the bar always reads calm to critical left to right regardless of fill; unfilled cells 240. The session's own share `+N%` uses stop 5 (202).
2. Themes: none; single hard-coded palette. User config is limited to icon set (`--icons=nerd|unicode|ascii`, `Options.cs`).
3. Spec/depth: ANSI-256 indices only, chosen "so the line renders identically on terminals without truecolour" (`Palette.cs` summary). No detection; `NO_COLOR` not found in `AnsiBuilder.cs`/`Program.cs` (grep).
4. Fill: foreground-only (with reverse video available via `ReverseOn`).
5. Separators: an icon-set glyph in colour 175 between segments (`Line.cs:67-70`).
6. Neighbours: grey labels versus coloured values, separator colour.
7. Light/dark: not present.
8. Glyphs: three icon sets, Nerd (default), Unicode, ASCII (`Icons.cs`), half-cell bar glyphs `▌` with per-set `BarChars`.
9. Other: narrow-terminal shedding order with 5-cell bars; screenshot gallery under `docs/previews/` generated by `tools/preview` (real terminal captures); a "limit reached" banner.
10. Customisation: command flags in settings.json (`--icons=`), line-2 segment selection in the settings block written by `--install`.

## torpedo88/cc-statusline
https://github.com/torpedo88/cc-statusline — stars: 0
1. Colour source: fixed per segment role, from 8 named accents. model purple (`segments/model.sh:9`), dir blue (`dir.sh:14`), git pink (`git.sh:32`), cost yellow (`cost.sh:17`), context green <50, yellow <80, red else (`context.sh:19-26`, bar of 8 cells, dim for the empty part), diff added green / removed red (`diff.sh:14-16`), dim for secondary text. Segment files also include aws, kubectl, node, python, battery, time, tokens, session, profile.
2. Themes: 6 bundled shell files in `lib/themes/`: catppuccin, dracula, gruvbox, nord, tokyo-night, minimal. Format: 10 named colour variables (`CCSL_C_accent_{red,orange,yellow,green,cyan,blue,purple,pink}`, `CCSL_C_dim`, `CCSL_C_fg`) as 256-index escapes. `docs/THEMES.md` documents adding a theme (copy a file, change codes; truecolor by swapping to `38;2`). Selected by `theme =` in config or `CCSL_THEME`.
3. Spec/depth: 256-index (catppuccin etc.), minimal theme is ANSI 16 (`31`-`36`, `95`, dim `2`). No detection; `NO_COLOR` not present.
4. Fill: foreground-only.
5. Separators: two renderers in `lib/render.sh`: plain (default `sep` string wrapped in dim) and powerline mode (`CCSL_POWERLINE=true`) which prints a single `` glyph between parts, uncoloured; segments stay foreground-only, so it is a "powerline-looking" separator with no background fills.
6. Neighbours: different accent per segment, separators.
7. Light/dark: not present.
8. Glyphs: `█`/`░`; emoji few; Nerd glyph only in powerline separator.
9. Other: `/theme` slash command (`commands/theme.md`), `cc-statusline --doctor`, `--list`.
10. Customisation: TOML `~/.config/cc-statusline/config.toml` (theme, powerline, segment list), env `CCSL_THEME`, `CCSL_POWERLINE`, `CCSL_CONFIG`.

## tousif101/meter
https://github.com/tousif101/meter — stars: 0
not a Claude statusline: a macOS menu-bar and desktop app (Tauri v2, React) that tracks Claude Code and Codex CLI usage. Its `meter/src/theme.ts` is a dark UI token set (surfaces `#0A0B0D`..`#282C33`, text ramp `#F2F4F7`..`#6C737C`, brand `claude #D2795A`, `codex #6FA8B8`, status `positive #6FB98F`, `warning #D2A45A`, `negative #C4756B`); no terminal output.

## Tribe-Coding/claude-plugins (fork of artem-from-ua/claude-plugins)
https://github.com/Tribe-Coding/claude-plugins — stars: 0
Fork differs from parent: none. Compare `artem-from-ua/claude-plugins:main...Tribe-Coding:main` shows 0 ahead and 58 behind, so the fork is stale and adds nothing. Parent's statusline styling as present in the fork (`plugins/statusline/scripts/statusline.sh`, 717 lines; a `statusline-compact` sibling):
1. Colour source: fixed plus state. Model keyword coloured by family (`colorize_model` :157-171): Opus 167 (red), Sonnet 71 (green), Haiku 33 (blue), version digits dim. Branch prefix coloured by type (:178-198): feature/feat green 114, fix/bugfix/hotfix red 203, release/chore/revert yellow 221, refactor/docs/test/ci/dev blue 110, other grey 245, slash dim. Context: >=80 colour 167 + 🛑, >=60 colour 178 + ⚠️ (:426-433), else uncoloured. Rate-limit pacing bar (`build_progress_bar`, :95-150): used part dark gray 236, headroom ahead of time bright green 71, overspent red 167, remainder dark blue 23, with a `■̿` marker at the current-time position.
2. Themes: not present.
3. Spec/depth: 256-index. No detection; no `NO_COLOR`.
4. Fill: foreground-only.
5. Separators: a `SEP` string (dimmed `･` style), plus a dimmed `/` in branch names.
6. Neighbours: emoji prefixes, dim separators.
7. Light/dark: not present; dark-gray tracks assume a dark terminal.
8. Glyphs: emoji-heavy (📚 etc., 44 hits), `■` bar, no Nerd Font.
9. Other: wide-character width measurement via Python `unicodedata` for alignment; limit indicators ❌/⚠️ from usage vs time pacing.
10. Customisation: `setup-statusline.sh` installer; no colour options.

## tschallacka/claude-usage
https://github.com/tschallacka/claude-usage — stars: 0
1. Colour source: by threshold on the worst of the shown windows. `scripts/claude-usage:223-230` `_colour`: >=90 colour 197, >=75 208, >=50 178, else 71; grey 244 when the cached data is stale (> `STALE_AFTER`, then "(stale)" appended). In bar style each window's bar uses its own percent's colour with the filled part in that colour and the trough in `BAR_TROUGH` (:202-215); in text style one colour for the whole line. `scripts/statusline.sh:20-22`: directory fixed 75 (blue), model and `|` fixed 244 (grey).
2. Themes: not present.
3. Spec/depth: 256-index (`38;5`). No detection; no `NO_COLOR`; modes `--plain`, `--ansi`, `--prompt` (readline-safe `\001..\002` wrapping for shell prompts).
4. Fill: foreground-only.
5. Separators: ` · ` between windows, ` | ` before usage in the statusline.
6. Neighbours: separators; shared colour in text style.
7. Light/dark: not present.
8. Glyphs: bar characters (full/half/empty; optional brackets `BAR_BRACKET`); no icons. `extras/iterm2-statusbar.py` for iTerm2's status bar.
9. Other: `scripts/chart.py` matplotlib history chart (blue `#4C78A8`, purple `#B279A2`, orange `#F58518`).
10. Customisation: config variables read by `claude-usage` (`CU_STYLE` bar|text, `CU_COUNTDOWN` off|…|both, bar width and glyph settings), env-based.

## Tsune2034/cc-cockpit
https://github.com/Tsune2034/cc-cockpit — stars: 0
1. Colour source: by threshold. `cc-cockpit.sh:32-34`: gauge colour >=80 red `\033[31m`, >=50 yellow, else green; applied to each of three gauges (5h, 7d, context), each gauge a coloured bar plus percent (`:44`). Context alert text `⚡MAX` at >=90 and `⚠️` at >=80 (:75-76).
2. Themes: not present.
3. Spec/depth: ANSI 16; no detection; no `NO_COLOR`.
4. Fill: foreground-only.
5. Separators: not examined beyond plain text between gauges.
6. Neighbours: not applicable.
7. Light/dark: not present.
8. Glyphs: `█`/`░`; emoji for alerts.
9. Other: Japanese comments naming the colours (赤/黄/緑).
10. Customisation: none (single script).

## TTigger/claude-status
https://github.com/TTigger/claude-status — stars: 0
1. Colour source: by tier on state, plus per-segment decoration. Bars and percentages take a tier `low`/`mid`/`high` from `colorThresholds` (defaults green 50, yellow 80; `src/registry.js` CONFIG_SCHEMA); the style's palette maps tiers to colours (claude style: low `#d97757`, mid `#e8a07e`, high `#e0533d` in dark). Decorated styles assign each element a deco colour: `mist` (pills) project foam, branch lavender, context sage, session gold, weekly rose, cost rose; `neon` assigns by group (env blue, context purple, limits green). At 100% a meter becomes a red `LIMIT` marker. Bar empty track is a darkened version of the tier colour (`barTrack: {from:'tier', factor:0.30}`) or of the deco background (`palette.js:61-74`).
2. Themes: called styles; 4 bundled in `src/registry.js:1-62`: `claude` (default, Clay terracotta), `mist` (soft pastel pills), `neon` (Tokyo-Night-like powerline segments), `ascii`. Format: per-style object with `palette.dark` and `palette.light` role sets (`text, dim, accent, accent2, low, mid, high, deco{name:{bg,fg}}`), `bar` glyphs, `decoration` type (`none|pill|segment`) and assignment map. No user-defined styles through config (a `.claude/skills/add-style` developer skill exists).
3. Spec/depth: hex converted at render by detected capability (`src/detect.js:1-8`, `palette.js:21-32`): `COLORTERM` truecolor/24bit gives `38;2`; `TERM` containing 256 gives xterm-256 mapping (`rgbTo256` with cube and grey ramp); otherwise no colour, with tiers falling back to ANSI green/yellow/red (`TIER8`). Each style declares `requires` (claude: truecolor, mist: color256, neon: nerd, ascii: ascii) and `recommendStyle` picks one. `NO_COLOR` not found.
4. Fill: `claude` foreground-only; `mist` background pill per element (`bg` + `fg` pair, ` text ` padded); `neon` background segments with half-circle caps.
5. Separators: default ` | ` (configurable `separator`); `neon` caps are Nerd Font half circles `` ``, falling back to Unicode `◖`/`◗` without Nerd Font (`engine.js:120-123`), and a space between segments; cap colour = segment bg turned into fg.
6. Neighbours: per-element deco hues (mist/neon) or separators (claude); neon text is a dark ink `#16161e` on bright backgrounds (`segInk`).
7. Light/dark: yes. Reads Claude Code's theme from `~/.claude/settings.json` (light/dark/system), `palette: auto|light|dark` option (`render.js:7-19`); every style carries separate light and dark palettes (e.g. claude: dark text `#cfc6ba`, light `#4a4640`; light deco colours are darker saturated pairs).
8. Glyphs: bars `▰▱` with 64-level sub-cell fills (`hiresBar`), `⎇` for branch, Nerd Font opt-in with `CLAUDE_STATUS_NERD=1` (cannot be auto-detected, `detect.js:5`), ASCII `#`/`-` with brackets.
9. Other: `claude-status preview` and `config set` with live preview, `media/style-*.svg` gallery generated by `scripts/styleMockup.js`; desktop "ping" notifications; layout options auto/oneline/two/three.
10. Customisation: JSON config via `claude-status config set` (style, layout, palette, separator, barWidth, colorThresholds.*, elements.*, autoCompact.thresholdPct, ping.*, refreshIntervalSec), `cc`/`cs` launchers.

## ttiimmaahh/claude-code-hud
https://github.com/ttiimmaahh/claude-code-hud — stars: 0
1. Colour source: theme role mapped to segment plus threshold. Model `accent` (`src/index.ts:38`); context bar `ok` / `warn` / `danger` by ratio vs `warnAt` 0.6 and `dangerAt` 0.8 (`features/context.ts:69`), 10 cells `█░`; git branch `accent`, or `gitDirty` when dirty, with `●N` dirty count (`features/git.ts:50-54`); cost `dim` normally, `warn` at $5, `danger` at $20 (`cost.ts:8`, from `.claude-hud.json`); todos `◐` accent for active, `✓N` ok and `○N` dim; tools name accent, label dim; env icons (⚡ 🪝 📋 🤖) accent.
2. Themes: 3 bundled in `src/themes/index.ts:12-43`: default, nord, dracula. Format: 8 roles `{fg, dim, accent, ok, warn, danger, gitDirty}` plus name (hex). Selected with `"theme"` in `.claude-hud.json`; user-defined themes: not present (no custom palette loading seen).
3. Spec/depth: truecolor `38;2` / `48;2` hand-rolled (`renderers/ansi.ts:6-13`). No detection, no downsampling, no `NO_COLOR`.
4. Fill: foreground-only (a `bg` helper exists but is unused by the segments read).
5. Separators: dim `│` with spaces (`index.ts:51`).
6. Neighbours: accent versus dim; separators.
7. Light/dark: not present (dark themes).
8. Glyphs: emoji and Unicode (`◐ ✓ ○ ● ⚡ 🪝 📋 🤖`); no Nerd Font.
9. Other: configurable `features` list order; tools/todos parsed from transcript.
10. Customisation: `.claude-hud.json` (theme, features list, context/cost thresholds, bar segments).

## tuandzung/glm-statusline-cc
https://github.com/tuandzung/glm-statusline-cc — stars: 0
1. Colour source: fixed per segment (each segment its own background), plus a threshold on the context segment. `statusline.py:26-36` dark theme: vim sky `48;5;117`, cwd blue 111, model mauve 183, 5h-quota lavender 147, 7d-quota sapphire 116, MCP teal 152, diff peach 216; context segment bg by percent (`context_bg`, :293-299): >80 red (210), >=50 yellow (223), else green (150). Comments name the Catppuccin colours they approximate.
2. Themes: 2, `THEME_DARK` and `THEME_LIGHT` dicts (:26-50), selected by env `STATUSLINE_THEME=light` (default dark, `resolve_theme` :53-58). Format: per-segment bg map plus `fg`, `ctx_bg` triple and `bar` colours. Light theme uses deeper Catppuccin Latte-like bgs (blue 27, mauve 99, ...) with white-ish text (231); no user-defined themes beyond editing the file.
3. Spec/depth: xterm-256 backgrounds and foregrounds (`48;5;N`, `38;5;N`). No detection, no `NO_COLOR`.
4. Fill: background-filled powerline segments; text colour is one `fg` for the whole theme (dark `38;5;17` on pastel bgs; light 231 on saturated bgs).
5. Separators: single powerline glyph (`SEPARATOR`, :78); `join_segments` (:266-279) emits fg = previous bg (`bg_to_fg` converts `48;5` to `38;5`), bg = next bg; final cap fg = last bg on `48;5;0`.
6. Neighbours: each segment a different pastel hue; powerline arrow.
7. Light/dark: manual switch via env; light theme has its own saturated bgs and inverted text. No auto-detection.
8. Glyphs: Nerd Font icons for folder, sparkle, clock, calendar, plug, plus/minus (`ICON_*`), plus `●`/`○` bar for context fill (filled in theme `bar.filled`, empty in `bar.empty`).
9. Other: header comments tag "V3 / V11" revisions; fetches GLM (z.ai) quotas for the 5h/7d segments with a cache.
10. Customisation: env `STATUSLINE_THEME`; settings.json env (`read_env_from_settings`); otherwise edit script.

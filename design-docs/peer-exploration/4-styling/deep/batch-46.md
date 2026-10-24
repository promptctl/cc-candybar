## guille-nat/token-bar
https://github.com/guille-nat/token-bar — stars 0
(A Claude Code *mod*: Ink-style React band drawn above the prompt, not a `statusLine` command; an optional plain-text statusline exists but is off by default because "Claude Code no le permite colores", README.md "Línea de texto bajo el prompt". UI is Spanish.)
1. Colour per segment: mixed. Usage meters (session/week/Fable/ctx) colour by threshold: `hooks/format.ts:72-77` `USAGE_LEVELS` min 0/50/75/90 -> tone `success`/`warning`/`claude`/`error` (green/yellow/orange/red); cut points configurable `config.ts:46-51` `LEVEL_SETS` [50,75,90],[60,80,95],[40,65,85]. Meter *labels* fixed per meter: `format.ts:99-107` `kindColor`: Sesión->`suggestion`, Fable semanal->`planMode`, Semana->`merged`, Gasto->`permission`, context->`ide`, else `text`. Data segments fixed hex: `register.tsx:311-314` tokens-in `#7DCFFF`, tokens-out `#9ECE6A`, cost `#E0AF68`, cwd `#BB9AF7`; repo `suggestion`; model name Claude orange `#D97757` with a `#FBD3BF` glow sweeping over letters (`format.ts:189-190`, `register.tsx:732-735`). CI/PR state -> theme tone (`register.tsx:499-505`: ok success, falla error, corriendo warning; merged `merged`).
2. Themes: no bundled themes of its own. Uses *Claude Code's own theme token names* (`success`, `warning`, `error`, `claude`, `suggestion`, `planMode`, `merged`, `permission`, `ide`, `subtle`, `text`) so colours follow the user's CC theme (`format.ts:63-65` comment "sigue al tema del usuario"). Plus hard-coded Tokyo-Night-ish hex. Users cannot define colours; only the 3 threshold sets.
3. Colour spec: theme-token names or `#RRGGBB` strings passed to Ink `<Text color>`; depth/NO_COLOR left to host. Emoji dots 🟢🟡🟠🔴 (`format.ts:73-76`) used in the plain-text statusline "que no admite colores".
4. Fill: foreground-only text; only background use is Clawd's sunglasses cell (`mascot.ts:18-30` `shades #000000`, `Seg.bg`).
5. Separators: plain ` │ ` with `dimColor` (`register.tsx:697,897`); no caps/powerline.
6. Neighbours: distinct fixed hues per data field plus dim `│`.
7. Light/dark: not present; README.md:270 says Clawd is designed for dark backgrounds; the theme-token colours adapt via CC.
8. Glyphs: Unicode box/blocks only (`━ ╸ ▐ ✻ ⎇ ↑ ↓ ↻`), no Nerd Font, emoji only for dots (README.md:270). Bars `━━╸──` half-cell (`format.ts:200`).
9. Extra: animated pixel mascot "Clawd" (`mascot.ts` TONE_COLOR table: clawd/glow/heart `#F7768E`/ok/error/sleep/sweat/gold/violet/shades/shine), pulse (dim blink) of % at >=red (`register.tsx:261,758`), fill-in animation of bars, spinner-like `✻` sparkle frames (`format.ts:192-198`), legend tab explaining colours.
10. Customisation: in-mod panel with 6 tabs (`/token-bar`), toggles per datum, presets, density auto/compacta/media/completa, JSON export/import `~/.config/token-bar/config.json` (`/token-bar-config`, README.md:222-230); colours themselves not user-editable beyond level sets.

## gusthanks/clawd-pet-statusline
https://github.com/gusthanks/clawd-pet-statusline — stars 0
(Mostly a Claude Code mod (pixel pet "Clawd" band/lane with weather, scenes); ships a plain statusline script `statusline/statusline-rgb.js`, and the mod can re-render the user's statusline output as coloured spans.)
1. Colour per segment (`statusline-rgb.js:10-18, 140-170`): fixed per segment: repo name bold YELLOW rgb(235,200,0); branch bold CYAN (0,220,220); `+added` GREEN / `-removed` RED; model MAGENTA (210,90,220), effort GRAY_DIM. By threshold: ctx% and 5h/7d % use `usageLevel` (`:78-83`): <20 green 🟢, <70 yellow ⚡, <90 orange 🔥 (255,140,0), else red 🚨; progress bars colour each filled block by a smooth gradient along the bar position (`gradient(t)` green(0,200,80)->yellow(220,200,0)->red(220,40,20), `:57-84`), empty blocks DARK_GRAY (60,60,60).
2. Themes: not present (constants in the script).
3. Colour spec: truecolor only `ESC[38;2;r;g;bm` (`:9`); no depth detection, no NO_COLOR. The mod side parses ANSI 16/256/truecolor into hex spans (`clawd/hooks/statusline.ts:7-60`, xterm 256 table, `BASIC`/`BRIGHT` VS Code-style palette).
4. Fill: foreground only; the mod discards background SGR 48 ("a faixa já tem o dela", `statusline.ts` ~line 62).
5. Separators: single space between segments; blank line between the two rows.
6. Neighbours: fixed distinct hues, emoji prefixes (📂 🌿 🌀 🧠 ⏳ 📅).
7. Light/dark: not present.
8. Glyphs: emoji-led, `█` bars; no Nerd Font.
9. Extra: gradient bars; narrow layout (<60 cols, flag file `~/.claude/statusline-narrow` or `CLAUDE_STATUSLINE_COLS`) splitting into four rows (`:21-54,138-157`); pixel-art pet rendered with half-block `▀▄█` truecolor at ~12 fps (README.md:407); holiday hats, weather.
10. Customisation: edit the JS; env `CLAWD_STATUSLINE` to point to another script, `CLAWD_BIRTHDAY`, `CLAWD_WEATHER` (README.md:163,374-377). No colour config.

## gwenwindflower/winline
https://github.com/gwenwindflower/winline — stars 0
1. Colour: a theme role/palette *name* per segment, set in config. Defaults `statusline.ts:145-157`: model mauve, directory peach, git yellow, worktrees pink, languages green, context blue (warn_color maroon at >=80%, optional critical tier; `resolveThresholdColor` `:584-600`). Git `colorized_status` paints `! + ✘ ?` indicators individually using hard-coded Catppuccin Frappe colours (`:684-699`), only on foreground-style rows. Position plays no role: each segment keeps its colour wherever it sits.
2. Themes: one palette, Catppuccin Frappe, a flat `[palette]` of named RGB triplets (mauve, peach, yellow, green, blue, pink, maroon, base, crust; `:115-125,162-172`); users override/add entries in `config.toml`; README says "Full theme support coming" and roadmap lists "theme selection beyond Catppuccin Frappe". Segment colour is a key into this palette (arbitrary new keys allowed, `[key: string]`).
3. Colour spec: truecolor only `38;2`/`48;2` (`:234-241`); no depth detection, no NO_COLOR.
4. Fill: both, per row `style`: `background` (coloured bg, dark `crust` text) or `foreground` (shared `base` bg, segment colour as text) (`:87-90, 306-380`).
5. Separators: `powerline`/`slant`/`round`/`straight`/`none` (`SEPARATOR_GLYPHS` `:225-231`), with independent `first_separator`/`last_separator`. Colours: in background rows arrow = bg of the next segment, fg of the previous (`:331-336`); end caps = base bg with segment colour fg; foreground rows use the previous segment colour for the separator (`:367-370`).
6. Neighbours: different palette hue per segment + arrow transitions (background rows).
7. Light/dark: not present; text on coloured bg is always `crust` (dark) (`:255,308`).
8. Glyphs: Nerd Font required (README Dependencies); Starship-derived language icons; no ASCII fallback beyond `separator = none`.
9. Extra: up to three rows each with its own style/separator (README Layout); `winline --print` mock preview, `--capture/--explain`.
10. Customisation: TOML `~/.config/winline/config.toml` (`winline config init`, `winline config`), deep-merged over defaults (`:178-205`); no TUI.

## h1n054ur/claude-code-h1n054ur
https://github.com/h1n054ur/claude-code-h1n054ur — stars 0
(A personal dotfiles-style pack: a Claude Code *theme JSON*, a bash statusline, two mods. Only `statusline.sh` and `themes/h1n054ur.json` are styling.)
1. `statusline.sh:10-12,20-90`: fixed per segment, ANSI names copied from the author's starship.toml: `[user@host]` brackets bold green, user bold bright-white, host cyan; dir bold bright-cyan (`BCYAN`); branch bold purple; git status string bold yellow; model bold green; clock/duration dim. One threshold: ctx% green <50, yellow >=50, red >=80 (`:84`).
2. Themes: the pack's own is `themes/h1n054ur.json`, a Claude Code theme file: `{ "name", "base": "dark", "overrides": { ... } }` listing ~65 CC role tokens (claude, text, subtle, suggestion, permission, success, error, warning, merged, planMode, ide, diffAdded…, rate_limit_fill, rate_limit_empty, `*_FOR_SUBAGENTS_ONLY`). That is the semantic-role theme format of Claude Code itself; it does not drive the statusline script. Single theme.
3. Colour spec: ANSI 16 names only (`\e[1;32m` style, `:12-14`), explicitly so the terminal's own palette decides ("both come out in the terminal's own colours", README.md). No depth detection, no NO_COLOR.
4. Fill: foreground only.
5. Separators: plain spaces (two spaces before model and clock); no glyph separators.
6. Neighbours: different hue per segment (green/cyan/purple/yellow/green) with spacing.
7. Light/dark: not present (terminal palette indirectly adapts since ANSI names); theme base `dark`.
8. Glyphs: Nerd Font icons (`I_DIR`, `I_BRANCH`, `I_MODEL`, `I_TIME`, `:16-17`), starship-style git symbols `= * ✘ ! + ? ⇡ ⇣ ⇕`; README says needs a Nerd Font; no ASCII fallback.
9. Extra: agent-tabs mod highlights the active tab with `backgroundColor` and `inverseText` foreground, per-state mark colour (`mods/agent-tabs/hooks/register.tsx:14-22,86-108`). Screenshot gallery in README.
10. Customisation: edit the script/theme file; `install.sh` links them into `~/.claude` and sets `settings.json`.

## haKC-ai/hakcerline
https://github.com/haKC-ai/hakcerline — stars 0
(Animated two-row `statusLine`: row 1 an ASCII/ANSI-art "scene" animated with colour effects, row 2 an info HUD.)
1. Row 2 HUD colours are fixed per segment: `src/renderer.ts:25-34` `SEG`/`:239-242` `C` 256-colour indices: model bright cyan bold (51), cwd aqua (49), cost teal (43), elapsed dark cyan (37), lines `+` green (48) / `-` crit (203), scene label pink (213), `/hakcerline` hint dim (240). Threshold: ctx bar blue(44) -> warn 214 at >=60 -> crit 203 at >=80 (`ctxColor :244`); 5h rate steel(38) -> warn at >=50 -> crit at >=80 (`rateColor :250`). Row 1 colour is a *gradient by character position* across the line, scrolled by frame number, using the active palette (`palIdx`, `:65-68`, effects `:70-183`).
2. Themes: 13 bundled 256-colour palettes + `random` (`renderer.ts:8-21`, `config.ts:17`): cyan_blue, purple_pink, green_cyan, fire, ocean, synthwave, matrix, mono, ember, frost, steel, amber, dusk. A palette is an ordered array of xterm-256 indices, not roles. 10 effects (glow, clean, solid, wave, rain, decrypt, sparkle, beams, nfo, hack) + `auto` (README effects table). No user-defined palettes (only custom *scenes* as JSON in `~/.config/hakcerline/scenes/`, README.md ~192).
3. Colour spec: xterm-256 only (`38;5;N`), plus `1;`/`2;` bold/dim modifiers; no truecolor, no depth detection, no NO_COLOR.
4. Fill: foreground only.
5. Separators: `✳` in colour 240 (` ✳ `, `renderer.ts:270`).
6. Neighbours: distinct hue per HUD item + `✳` separators.
7. Light/dark: not present (assumes dark terminal; `mono` and `frost` are light-on-dark palettes).
8. Glyphs: Nerd Font icons for HUD (``, ``, ``, ``), box drawing / ANSI art for scenes.
9. Extra: rainbow-like animated gradients per character (wave/rain/decrypt/sparkle/beams); `brightenColor`/`dimColor` helpers shift palette index (`:185-208`); effect tester `hakcerline test`; scenes rotate every 30 s.
10. Customisation: `~/.config/hakcerline/config.json` (theme, effect, duration, packs, paused…), CLI `hakcerline theme frost`, `effect glow`, `duration 60` (README ~83-91), `[e]`/`[t]` key hints shown in the HUD (renderer.ts:324-325); `/hakcerline-hack` slash command generates scenes.

## hankeGui/cc-status
https://github.com/hankeGui/cc-status — stars 0
1. `src/segments.rs:11-17`: ANSI-16 consts. Fixed per segment: dir bold cyan (`:91`), git branch bold magenta (`:119`), git dirty flags `[+!?]` red (`:167`), cost segments (`last/sess/today/7d`) yellow (`:1060-1118`), cache TTL red when <60 s else dim (`:529`). By threshold: `{ctx}` battery bar green/yellow/red on *remaining* % with cut points `theme.ctx_low`=20 / `ctx_med`=50 (`:359-364`, `config.rs:33-52`); filled cells take the colour, empty cells DIM. Other segments uncoloured.
2. Themes: not present as palettes; the `[theme]` table in config.toml holds only the two ctx thresholds (README.md ~352). "Modes" (`[modes.X] lines = [...]`) are layouts, not themes.
3. Colour spec: ANSI 16 SGR only; no depth detection, no NO_COLOR handling found (`grep NO_COLOR` empty). Plugins may emit their own SGR (kept, sanitised, `segments.rs:1228-1240`).
4. Fill: foreground only.
5. Separators: whatever literal text the user puts between `{tokens}` in a mode line (e.g. `|` in `{cost}` combo); no glyph logic.
6. Neighbours: different fixed ANSI hue per kind; most segments uncoloured.
7. Light/dark: not present (ANSI names defer to terminal palette).
8. Glyphs: `▰▱` battery bar, `⇡⇣`, emoji `🎯 🔥`; `ccs explain` prints an annotated glyph/colour legend (README.md:205).
9. Extra: `ccs list-modes` colourised preview; Claude-skill conversational setup; plugin segments `{plugin:NAME}` that may emit ANSI.
10. Customisation: TOML config with `[modes.*]` line templates using `{segment}` tokens, `[theme]` thresholds; CLI `ccs mode`, `ccs setup`, `ccs plugin new`.

## harshdvaid24/claude-code-usage-bars
https://github.com/harshdvaid24/claude-code-usage-bars — stars 0
1. `statusline-usage.py`: labels get a per-segment *accent* from the palette's `accents` list by slot: accents[0] cyan -> model badge and Session label and agents (`:471,488,573`), accents[1] violet -> Week label and git branch (`:497,533`), accents[2] slate -> Ctx label and bare indicator (`:506,590`). Values by threshold: `level_color` (`:165`) green <warn(50), amber >=50, orange >=critical(80), red >=100; Ctx critical styling at >=85 (`CTX_CRIT`). Bars: filled cells follow a 5-anchor gradient ramp scaled by usage (`bar :174-186`, `ramp_color :153`), so a fuller bar shifts warmer; track cells grey.
2. Themes: two built-in palettes `dark` and `light` (`:101-118`), each a dict of RGB lists: `ramp` (5 anchors), `accents` (3), `track`, `reset`, `levels` (4). Users override any key via `"palette"` in `~/.claude/statusline.json` (`apply_palette_override :321`), validated 0-255 RGB. `theme: auto|dark|light`.
3. Colour spec: truecolor when `COLORTERM` is `truecolor`/`24bit`, else quantised to the 6x6x6 xterm-256 cube (`fg() :146-150`). No NO_COLOR.
4. Fill: foreground only (glyph bars `▬`/`▭`).
5. Separators: configurable text, default `|` (`DEFAULTS separator`), coloured by palette (track/reset grey).
6. Neighbours: three accent hues rotating by segment role + separator.
7. Light/dark: explicit: `detect_theme()` parses `COLORFGBG` (`:635-643`, light if bg 7-15 except 8) else dark; `--theme` flag or `CLAUDE_STATUSLINE_THEME` env overrides; light palette uses darker 600-weight Tailwind-like colours. No computed contrast.
8. Glyphs: Unicode only (`▬ ▭ ⚙ ⎇ ⇄ ⟳ ↗`), configurable bar glyphs; no Nerd Font.
9. Extra: ETA-to-cap burn-rate hint; responsive compact layout (`compact_width` 100) and DROP_ORDER dropping segments to fit width.
10. Customisation: JSON `~/.claude/statusline.json` merged with `<cwd>/.claude/statusline.json` (project wins), env `CLAUDE_STATUSLINE_CONFIG`, `CLAUDE_STATUSLINE_THEME`, flag `--theme`; keys segments, bar_width, glyphs, thresholds, labels, separator, theme, palette, layout.

## HarzerHeribert/claude-modpack
https://github.com/HarzerHeribert/claude-modpack — stars 0
(Mostly a bench/modpack repo; the styling is its `statusline/` mod, an Ink band, not a `statusLine` command.)
1. `statusline/hooks/line.ts:26-35` `COLORS: Record<Tone, Color>` maps semantic tones to Claude Code theme tokens: accent->`claude`, good->`success`, text->`text`, label->`inactive`, faint->`subtle`, warn->`warning`, alert->`error`, glint->`text`. Segments use tones: context gauge tone by `severity(fraction)` accent <0.8, warn >=0.8, alert >=0.95 (`:62-64`); size text `label` while accent; plan limits `label` below 50 %, `text` 50-80, then warn/alert (`:153`); model `label`, effort via `EFFORT_TONES`; reset countdown `faint`. So colour is by role+state, not per segment name.
2. Themes: none of its own; deliberately inherits the user's Claude Code theme by using CC token names (comment `:30-31`: "inactive is the readable grey and subtle the dim one (dark theme: 246 and 239 of 256)").
3. Colour spec: CC theme-token names; depth/NO_COLOR left to host (the NO_COLOR hits in the scan come from benchmark scripts, not the mod).
4. Fill: foreground only.
5. Separators: three spaces `SEPARATOR = '   '` ("space, not punctuation", `line.ts:39-40`), `' · '` for plain-string surfaces; colour `faint`.
6. Neighbours: whitespace gaps only; tones differ by state not by segment.
7. Light/dark: delegated to the CC theme tokens.
8. Glyphs: half-cell gauge `━╸─` (`gauge :99-117`), spinner `◐◓◑◒`, `↺` for resets; no emoji/Nerd Font.
9. Extra: a "glint" highlight (bold text-colour cell) sweeps along the gauge while the model works, 20 fps redraw (`:95-98,126`).
10. Customisation: `limits` setting always/half/off (`LimitsShown`); no colour config.

## hasoftware/Claudefy
https://github.com/hasoftware/Claudefy — stars 0
1. `Linux/lib/statusline-command.sh`: every segment is a powerline cell with an *xterm-256 index* background and text index passed to `add_l1/add_l2/add_l3 BG FG TEXT`. Fixed per segment (line 1): folder 24 (blue), model 208 (orange, black text 0), clock 236, stash 53, commit age 240, runtimes 24, docker 25, server port 29, plan mode 61, YOLO 88, update-available 166, `.env` warning 88 (`:284-539,579,608`). By state/threshold: git cell `$gbg`, PR cell `$pr_bg`, battery `$bb`; context/5h/7d/Opus-week via `bg_remain`/`bg_used` (`:108-120`): good colour (22 green; context 29, week 28, Opus 65) -> 130 (orange) at 50 % -> 88 (red) at 80 %; line 2 other cells fixed (cost 94, +/- 22, tokens 24, idle 240). All text white (15) except model/AutoEdit (0). Same colours repeated in macOS and Windows variants.
2. Themes: the "ten preset themes" (One Half Dark, Dracula, Tokyo Night, Catppuccin Mocha, Nord, Solarized Dark, Gruvbox Dark, Monokai, Synthwave 84, GitHub Dark; README.md:98-99) switch the *Windows Terminal colour scheme* (Windows only, README.md:178,220), not the statusline; statusline colours are hard-coded indices and so follow the terminal's 256 palette only for indices 0-15.
3. Colour spec: xterm-256 (`48;5;N;38;5;N`); no truecolor, no depth detection, no NO_COLOR.
4. Fill: background-filled cells with white/black text.
5. Separators: Powerline arrow U+E0B0 between cells: fg = previous bg index, bg = next bg index; trailing arrow in last bg on reset (`render_line :179-194`).
6. Neighbours: each cell its own hue/shade index; the arrow does the separating.
7. Light/dark: not present; fixed white text on mid-dark backgrounds.
8. Glyphs: Nerd Font required (installer fetches a font; ~60 `NF_*` codepoints), emoji-free; no ASCII fallback.
9. Extra: compact mode auto-on over SSH (`CLAUDEFY_COMPACT`); quota-pace and compaction widgets; three lines (info / usage / repo stats).
10. Customisation: env `CLAUDEFY_COMPACT`; installer menu (Install/Reset/Theme/About); no colour config file.

## hb03/claude-mods
https://github.com/hb03/claude-mods — stars 0
(German-language; `statusline.sh` is the styling; the plugins are logic-only mods.)
1. `statusline.sh:104-160` (awk): fixed per segment truecolor: repo bold gold (255,215,0), branch bold cyan, model bold magenta (200,0,200), effort dim grey, cost gold, `+added` green (0,200,80) / `-removed` red (220,40,20). Threshold/gradient: 20-block context bar where filled block *i* gets `rgb(i*5)` a continuous green(0,200,80)->yellow(220,200,0)->red(220,40,20) ramp by block position, empty blocks dark grey (60,60,60); percentage text coloured by `rgb(p)`; emoji by level 🟢<20 ⚡<70 🔥<90 🚨; 5h/7d percentages `rgb(%)` and reset time shown only at >=80 % (dim); cache countdown green dot / orange `WARN` under 60 s (5 min for 1 h TTL).
2. Themes: not present.
3. Colour spec: truecolor `38;2;r;g;b` only; no depth detection, no NO_COLOR.
4. Fill: foreground only.
5. Separators: dim grey ` │ ` (`SEP`, `:122`).
6. Neighbours: different hue per segment + `│`; emoji prefix on each.
7. Light/dark: not present.
8. Glyphs: emoji (📁 🌿 🤖 💾 🕔 📅 💰) and `█`.
9. Extra: the same green->yellow->red formula as `gusthanks/clawd-pet-statusline` (identical anchor colours and emoji breakpoints), a second hint line `▲` warn / `›` info.
10. Customisation: edit the script; no config.

## healkeiser/claude-mods
https://github.com/healkeiser/claude-mods — stars 0
1. `statusline/statusline.sh`: a bordered "card" (box drawing) with header + one row per metric. Fixed: model bold Claude orange `ACCENT` (217,119,87) (`:18,82`); folder name uncoloured link; branch GREEN; working-tree `+N` green, `~N` yellow, `-N` red (`:88-90`); `↑in` green / `↓out` yellow; labels `ctx/5h/7d` DIM (245), border EDGE (240). By threshold: a 10-step 256-colour *heat ramp* `RAMP=(46 82 118 154 190 226 220 214 208 196)`; the bar's cell *i* wears RAMP[i] (rightmost lit cell = severity), and the percentage takes the colour of the decile it is in (`bar :56-64`, `heat :50-54`).
2. Themes: statusline has none. The repo also ships a Claude Code theme `prompt-cards/themes/claude-mods.json` (`base: dark` + overrides `promptBorder #7d87c9`, `promptBorderShimmer`, `diff*` shades).
3. Colour spec: mixes ANSI 16 (32/33/31), 256 index, one truecolor (`ACCENT`); no depth detection, no NO_COLOR.
4. Fill: foreground only.
5. Separators: `·` dim in header; the card uses `╭─ … ╮ │ … │ ╰─╯` in EDGE grey (`:127-131`).
6. Neighbours: row layout with fixed columns; colour by role.
7. Light/dark: not present.
8. Glyphs: `━` filled / `─` track bars, `↻`, `↗`, OSC 8 hyperlinks on folder (file://) and repo remote; no emoji.
9. Extra: pace indicator on rate rows; width computation ignoring SGR and OSC 8 so the card edge aligns.
10. Customisation: edit script; no config. Mods use CC tokens (`claude`, `error`, dimColor).

## herms14/claude-code-session-checker
https://github.com/herms14/claude-code-session-checker — stars 0
1. `statusline-command.sh:52-65`: one coloured thing: the context bar and % by threshold green <50, yellow 50-89, red >=90 (SGR 32/33/31). Model and directory uncoloured plain text.
2. Themes: not present.
3. Colour spec: ANSI 16 (`\033[0;3Xm`); no depth/NO_COLOR.
4. Fill: foreground only.
5. Separators: two spaces.
6. Neighbours: not distinguished (model and dir plain).
7. Light/dark: not present.
8. Glyphs: `[████░░░░]` 20-char bar with ASCII brackets.
9. Nothing else.
10. Customisation: edit script.

## hey-yvan/claude-quota-bar
https://github.com/hey-yvan/claude-quota-bar — stars 0
1. `src/theme.rs` `GRAPHITE` theme, one struct of RGB roles: bar background by severity (`bg_ok` olive (120,140,93), `bg_warn` amber (216,165,96), `bg_hot` coral (184,80,64)), unfilled `bg_empty` (60,65,72); `text_on_filled` dark (20,20,19) on filled cells, `text_on_empty` light (250,249,245) on the gutter (the % text is overlaid on the bar and switches colour at the fill boundary); `mute` for separators/brackets, `ink` for labels (5h/7d/dir), `model` Anthropic blue (106,155,204), `warn` orange (217,119,87) for dirty-file count. Severity flips at 30 %/70 % (`WARN_THRESHOLD`/`HOT_THRESHOLD`), also applied to ctx occupancy. Colour is thus by role + state, fixed per segment kind.
2. Themes: exactly one (`graphite`), as a Rust struct of semantic roles; not user-definable. Comments tie it to the Anthropic brand palette.
3. Colour spec: truecolor only (`fg()`/`bg()` 24-bit, `ansi.rs`); honours `NO_COLOR` (read on every call; strips all ANSI and falls back to `█`/`░` glyphs; README.md:123).
4. Fill: background-filled "battery" bar with overlaid text; other text foreground-only.
5. Separators: muted brackets/punctuation in `mute`; no powerline.
6. Neighbours: ink vs accent vs mute roles; bars distinguished by fill.
7. Light/dark: contrast is hand-tuned per background ("WCAG-grade contrast ... pairing light bgs with dark text", theme.rs header); no terminal-background detection.
8. Glyphs: Unicode only (`█ ░`, windfall marker `✦`, `▲`, `⏰` in render.rs:261,993); no Nerd Font.
9. Extra: battery-style bars with text embedded in the bar.
10. Customisation: env only: `STATUSLINE_LAYOUT` (segment list with `nl` line breaks), `STATUSLINE_THRESHOLDS` (`warn,hot`), `STATUSLINE_SID_LEN`, `NO_COLOR` (README.md:116-123). Colours not user-configurable.

## hiderin3658/Claude-StatusLine
https://github.com/hiderin3658/Claude-StatusLine — stars 0
1. `install-to-home/required/status-line.sh`: one fixed colour (model `[\033[36m...]` cyan, line 165; git branch green `\033[32m`, line 49); three threshold-coloured numbers: `Ctx:` (`:67-76`), `Session:` (`:98-107`), `5h:` (`:151-160`), all green <50, yellow 50-79, red >=80. Directory plain.
2. Themes: not present.
3. Colour spec: ANSI 16 only (`\033[3Xm`); no depth detection, no NO_COLOR. (A scan counted `motion.gradient` in the optional scripts; the required script has none.)
4. Fill: foreground only.
5. Separators: plain ` | ` and `[...]` brackets, uncoloured.
6. Neighbours: not distinguished beyond the `|`.
7. Light/dark: not present.
8. Glyphs: ASCII in the required script; emoji in the optional `status-line-cost.sh` / `status-line-with-usage.sh` (not read in detail).
9. Nothing else; installer scripts for Windows (`status-line.ps1`) and a ccusage daemon.
10. Customisation: edit the script; optional variants selected by copying files.

## hjsh200219/meta-status
https://github.com/hjsh200219/meta-status — stars 0
(Korean-language Claude Code *mod*: a one-line band above the prompt plus panels; not a conventional statusline.)
1. `hooks/register.tsx:778-790`: nearly colourless. Only styled fields: the repo/branch text fixed `#ff8700` (orange); the session summary default text colour; separators/counters `dimColor`; `[Agent N]` and `[Task N]` are buttons with hover colours `blue` / `error` (`:789-790`). Panels use bold names + dim details. No thresholds.
2. Themes: not present (none; relies on CC theme for default text).
3. Colour spec: one hex literal (`#ff8700`) and CC theme tokens (`blue`, `error`); depth/NO_COLOR left to host.
4. Fill: foreground only.
5. Separators: ` · ` in `dimColor` (`:779`).
6. Neighbours: dim separators; one orange field.
7. Light/dark: not present.
8. Glyphs: `↑ ✎ └ ✕ ·` Unicode only.
9. Nothing styling-specific beyond hover colour on buttons.
10. Customisation: none for style; panels via slash commands (`/loops-panel`, `/prompts`, `/workers`).

## hollegjx/mycode_statusline ("uucode")
https://github.com/hollegjx/mycode_statusline — stars 0
(Rust fork/derivative of the CCometixLine design: segment configs + theme presets + a ratatui configurator, repackaged as "uucode" with a branded API-gateway usage segment.)
1. Colour is fixed per segment *within a theme*, as a `SegmentConfig { id, icon{plain,nerd_font}, colors{icon,text,background}, styles }` per segment id (model, directory, git, context_window, cost, session, output_style, usage, uucode_usage/subscription/status). Example powerline-dark (`src/ui/themes/theme_powerline_dark.rs`): all text/icon white (255,255,255) on per-segment backgrounds model (45,45,45), directory (139,69,19), git (64,64,64), context (55,65,81), cost (40,44,52), session (45,50,59), output style (50,56,66). The default theme (`theme_default.rs`) has no backgrounds and gives each segment a bright ANSI-16 text colour (model c16 14, directory 10, git 12, context 13, usage 14, cost 3, session 2, output style 6). Position plays no role; no threshold logic found in the theme files (not checked in the segment code).
2. Themes: 9 built-in (`presets.rs:111-121`): cometix, default, minimal, gruvbox, nord, powerline-dark, powerline-light, powerline-rose-pine, powerline-tokyo-night. Format: a full `Config` per theme (per-segment colour map, no semantic roles). Users can save/load their own as TOML files in a themes dir (`load_theme_from_file`, `save_theme`, `list_available_themes`, `presets.rs:36-110`).
3. Colour spec: `AnsiColor` enum with three arms (`Color16{c16}`, `Color256{c256}`, `Rgb{r,g,b}`) mixed freely across themes; no depth detection or NO_COLOR found in the files read.
4. Fill: both, per theme: default = foreground only (`background: None`), powerline-* = background-filled.
5. Separators: global `style.separator` string; the special value `U+E0B0` triggers real powerline arrows with fg/bg colour transition computed from adjacent segments' backgrounds (`core/statusline.rs:59-61,128-136`, `create_powerline_arrow(prev_bg, curr_bg)`); any other separator is drawn in plain white (`\x1b[37m`).
6. Neighbours: powerline themes alternate by assigning each segment a different background shade (near-neutral dark steps in powerline-dark, only directory brown stands out); arrow separators.
7. Light/dark: a `powerline-light` theme exists; no automatic detection. Text colours fixed per theme.
8. Glyphs: three `StyleMode`s: `Plain` (emoji icons e.g. 🤖 📁 🌿 ⚡️), `NerdFont` (codepoints e.g. `\u{e26d}`), `Powerline` (`config/types.rs`); each segment carries both icon strings.
9. Extra: ratatui TUI configurator with `color_picker.rs`, `theme_selector.rs`, `icon_selector.rs`, `segment_list.rs` components (colour editor UI); terminal-width wrapping of segments.
10. Customisation: TOML config + themes directory, interactive TUI (colour picker, icon selector, theme selector); README documents only install via npm (`@gjx1/uucode`) and statusLine command.

## hong8300/cc-usage-monitor
https://github.com/hong8300/cc-usage-monitor — stars 0
not a Claude statusline: macOS Electron menu-bar / mini-window / panel app showing Claude usage (`package.json` description "statusLine ブリッジとローカルログから使用量を常時表示する"); it only reads usage through a statusLine bridge. For reference its colour rule is green up to 50 %, orange up to 80 %, red above 80 % (README.md), outside the terminal.

## hongge-ai/llm-quota-statusline
https://github.com/hongge-ai/llm-quota-statusline — stars 0
(A statusline that shows quota of other LLM providers' coding plans (GLM, Kimi, MiniMax), not Claude's own data; stdin is read and ignored, `statusline.sh:8`.)
1. Fixed per provider/region, whole line one colour: GLM CN 256-colour 208 (orange), GLM INTL 45 (cyan) (`lib/providers/glm.sh:57,68`); Kimi CN 200 / INTL 213 (pinks) (`kimi.sh:52,67`); MiniMax CN 183 / INTL 189 (lavenders) (`minimax.sh:50,59`). The colour string is prefixed to `<label> | <tokens> | <mcp>` and reset at the end (`glm.sh:41`). No thresholds, no per-metric colour.
2. Themes: not present.
3. Colour spec: xterm-256 index (`\033[38;5;Nm`); no depth detection, no NO_COLOR.
4. Fill: foreground only.
5. Separators: ` | ` inside the coloured line; multiple providers print as separate lines.
6. Neighbours: each provider/region line wears its own colour.
7. Light/dark: not present.
8. Glyphs: ASCII, with Chinese or English labels via `i18n`.
9. Nothing else.
10. Customisation: `~/.claude/llm-quota.conf` for providers/cache TTL (no colour keys); `_template.sh` for adding providers.

## HongtaoWang75/claude-code-statusline ("DSPG")
https://github.com/HongtaoWang75/claude-code-statusline — stars 0
(A DeepSeek/multi-provider statusline plugin: balance, cache hit, speed, context; Chinese-language.)
1. `scripts/deepseek-status.py`: colour only where a value enters a warning zone, otherwise plain (README.md:74). Zones: balance plain >¥1, yellow at ¥1, gradient ¥1->¥0, red at ¥0; cache hit plain >=95 %, gradient 95->90 %, red <=90 %; output rate plain >=150 tok/s, gradient to red at 100; context gradient green->yellow (first half) -> red (second half) by tokens vs the *auto-compact* window (`ctx_rgb :212-224`, `warn_rgb :168-173`). Per-model/provider colour: the model name is tinted with the provider's brand colour (`providers.py THEMES :113-124`: deepseek `#4D6BFE`.., anthropic `#D07050`.., openai `#10A37F`.., glm `#3859FF`.., xiaomi `#FF6900`.., gemini 4-stop red-yellow-green-blue gradient across the characters, `themed_text :142-165`). Fixed ORANGE (`1;38;5;208`) for the peak-price indicator (`:65`).
2. Themes: no user themes; two warning palettes `vivid` (pure RGB 255,255,0 / 255,0,0 / 0,255,0) and `soft` (255,215,95 / 255,95,95 / 95,215,95), chosen with env `DSPG_PALETTE`; comment (`:91-94`) notes pure red #FF0000 on #1e1e1e is only 4.3:1 contrast, below WCAG AA, which is why `soft` exists. `model_theme: true|false` toggles the brand tint.
3. Colour spec: truecolor with 256-cube fallback; detected via `COLORTERM`/`TERM`, override `DSPG_TRUECOLOR=0/1` (`_truecolor_ok :102-120`); no NO_COLOR found.
4. Fill: foreground; reverse-video (warning colour as background + white text) is used for the blink (`_invert_ansi :233-238`).
5. Separators: text; not examined in detail.
6. Neighbours: plain text vs coloured warnings; the model gets a brand tint.
7. Light/dark: contrast reasoning only for dark terminals (`soft` palette "深色终端友好"); WPF dialog follows system theme (not statusline).
8. Glyphs: mostly text/numbers with `¥`; icons not examined.
9. Extra: blink animation: when a metric *just* enters warning, the segment blinks 3 times in reverse video (`decorate :278-300`, README.md:84), per-session blink state file; animated moving highlight in a local extension (`theme_demo_local.py` referenced).
10. Customisation: `~/.claude/.dspg_config.json` (`model_theme`, others), env `DSPG_PALETTE`, `DSPG_TRUECOLOR`; settings slash command.

## hsincode/claude-code
https://github.com/hsincode/claude-code — stars 0
1. `statusline.sh:42-101`: Catppuccin truecolour role mapping. Fixed: model bold in the *accent* colour (default peach; follows the author's dwm theme env, or `CLAUDE_STATUSLINE_ACCENT`); effort via a cool-to-warm ramp low teal, medium sapphire, high mauve, xhigh pink, max bold maroon, else subtext1 (`:68-71`); `ctx` label overlay1 with value text; `reset` label overlay1 with countdown sky; dir subtext0; branch mauve. Threshold (`level :61-66`): green <50, yellow >=50, peach >=70, bold red >=85, applied to 5h and 7d %.
2. Themes: Catppuccin flavours latte and mocha only, hard-coded hex tables per flavour (`:29-41`, 20 named roles each); flavour read from `~/.local/state/dwm/theme` (suffix) or `CLAUDE_STATUSLINE_FLAVOUR`; accent from `~/.config/dwm/themes/<theme>.env` or `CLAUDE_STATUSLINE_ACCENT`. So palette *names* (roles like `overlay1`, `subtext0`, `surface2`) map to segments; a different flavour recolours everything.
3. Colour spec: truecolor `38;2;r;g;b` from hex; no depth detection or NO_COLOR.
4. Fill: foreground only.
5. Separators: ` · ` in surface2 (`SEP`, `:47`); right-aligned block via COLUMNS padding.
6. Neighbours: label (overlay1) vs value (text/threshold) colouring, dot separators; hue differences minor.
7. Light/dark: yes, via the latte vs mocha flavour switch (follows the desktop theme file), not via terminal detection.
8. Glyphs: plain text, `·`, `—`; no icons.
9. Extra: layout puts model/effort/ctx left and reset/5h/7d right-aligned, with a 4-column margin measured against Claude Code's own indent.
10. Customisation: env `CLAUDE_STATUSLINE_FLAVOUR`, `CLAUDE_STATUSLINE_ACCENT`; dwm integration files; edit script.

## htdguide/statusline-claude
https://github.com/htdguide/statusline-claude — stars 0
1. `statusline.sh`: fixed: repo bold Claude orange rgb(217,119,87) (`:~398`), branch bold cyan, model magenta, labels `ctx/5h/7d` bold bright white, cost/money `MONEY_GREEN` (133,187,101), month `+` (110,200,160) / `-` (230,140,110) (deliberately "softer, distinct from session +/-" `:375-377`), session `+` green / `-` red. Threshold-coloured: bar fill cell *i* = position-based gradient green(0,200,80)->yellow(220,200,0)->red(220,40,20) (`render_bar :43-66`, same formula as other projects in this batch), empty cells `░` rgb(60,60,60); the % number is green <70, yellow 70-89, red >=90. A "combo" feature: a multiplier tier 1-10 gets a distinct colour from a cool ramp (blue -> indigo -> violet -> magenta -> hot pink, `COMBO_R/G/B :182-188`) chosen "to clash with NOTHING else in the line" — the author explicitly partitions the spectrum (bars warm, money teal/coral, combo cool).
2. Themes: not present.
3. Colour spec: mixes ANSI 16 names and truecolor; no depth detection or NO_COLOR.
4. Fill: foreground only.
5. Separators: dim ` | ` (`DIM`), blank lines between groups.
6. Neighbours: distinct hue families per concern (warm bars, teal/coral money, cool combo).
7. Light/dark: not present.
8. Glyphs: `█ ░`, dynamic emoji next to bars, cheering words per combo tier.
9. Extra: gamified "combo" counter with cult-movie words; persistent monthly totals; centered layout.
10. Customisation: edit script; state files `~/.claude/statusline-combo.json`.

## huangko555/claude-poshline
https://github.com/huangko555/claude-poshline — stars 0
1. `statusline.sh:22-29,117-182`: posh-git-style fixed colours: `>>` and brackets muted grey (160,160,160) `ACCENT`; folder yellow (33); branch magenta (35); staged counts green (32), working-tree counts red (31); flag `!` red / `~` green / `=` green; ahead/behind grey; labels (`ctx`, `usg`) grey. Threshold (`pctcol :22-23`): >=90 hot red (255,92,87), >=70 amber (255,138,60), else caller default (ctx cyan 36, usg green 32); `usg 7d` grey below 90 then red. Model: cyan (36) for Claude, truecolor (150,166,246) `#96a6f6` for DeepSeek.
2. Themes: the statusline has none. The repo ships `themes/claude-fresh-blue.json`, a Claude Code theme (`base: dark`, overrides `promptBorder #B6C5D3`, `userMessageBackground #0E7490`, ...), selected in `/config` as `custom:claude-fresh-blue` (README.md:169-178). Shows the Claude Code custom-theme file format (base + token overrides).
3. Colour spec: mix of ANSI 16 numeric codes and `38;2` truecolor for the thresholds; no depth detection, no NO_COLOR.
4. Fill: foreground only.
5. Separators: ` | ` in grey `sep` (`:124`).
6. Neighbours: grey structural text vs coloured values; limited hue variety.
7. Light/dark: not present.
8. Glyphs: pure ASCII (`>>`, `^`, `v`, `[...]`) on purpose (Chinese Windows code page 936 issue noted at the top of the script).
9. Extra: Windows/Git Bash performance work (no subshells) and DeepSeek balance `bal ¥` in green.
10. Customisation: edit script; README tells an agent how to patch `settings.local.json`.

## huijoson/hudline
https://github.com/huijoson/hudline — stars 0
1. By *role*, decided by the field: colour is a threshold role (`ok`/`warn`/`danger`/`info`) that belongs to the field and "never the theme" (`src/fields.js:76-93`): `ctx` fullness ok <75, warn >=75, danger >=82; remaining-type fields (`5h`, `7d`, `quota`, `ctx_left`) ok >=50, warn >=20, danger <20; the `say` narration is `info` for agent-running and `danger` otherwise (`:179`). Literal format text is coloured in two kinds: *words* (`label` role) and *skeleton* (`punct` role: brackets, parens, separator) (`themes.js:8-14`, README.md:371-373). Model can be a filled "chip" (`chips: ["model"]`). A format never names a colour (README.md:329-332, 365-369).
2. Themes: two (`themes.js:106-165`): `neon` (default; sherly.dev palette: ok `#4ade80`, warn `#fbbf24`, danger `#f2555a`, info `#7dd3fc`, label `#ff49a4`, punct `#4a454e`, chip `#ff1f8f`, chipInk `#0b0a0d`; separator ` ★ `; meters on; Dragon-Quest-style narration phrases) and `plain` (basic 8 ANSI escapes `ok \x1b[32m`, `warn 33`, `danger 31`, no meters, ` | `). Format: a palette of semantic roles in hex plus options (`sep`, `meters`, `chips`, `representations`, `phrases`). No user-defined themes (CLI `--theme=neon|plain`).
3. Colour spec and depth: authored in 24-bit hex; `colourDepth()` reads `COLORTERM`/`TERM` and downsamples per process: truecolor, else 256-cube (`to256`, with grey ramp for near-neutrals), else nearest of 16 basic (`toBasic`, "keep red looking like danger", `themes.js:20-65`). Honours `--no-color` and `NO_COLOR` (meters and separators stay) (README.md:375-377).
4. Fill: foreground by default; the neon model chip is a background-filled badge with dark ink (`chip()` `:~195`).
5. Separators: theme string: ` ★ ` (neon) or ` | ` (plain), coloured with `punct`.
6. Neighbours: label (pink) vs value (threshold colours) vs punct (graphite) roles; chip for the model.
7. Light/dark: not present; text on chip is a fixed dark ink; plain theme is the escape hatch for limited terminals.
8. Glyphs: meters `▰▱` chosen for East Asian Width *Neutral* (so CJK terminals don't double them) with the reasoning in a comment (`:67-72`); `★` separator; deliberately no Nerd Font.
9. Extra: narrator phrases; a "pixel-hud" mod (`plugins/pixel-hud`, not read in detail); ADRs on theme design (`docs/adr/0004`, `0006`, `0014`); `docs/showcase` renderers.
10. Customisation: `--format="{model}[:{effort}]|CTX {ctx}|..."` (bracketed optional parts), `--show/--hide`, env `HUDLINE_FORMAT`, `HUDLINE_THEME`, `--list-themes`, `--no-color` (README.md:395-416).

## Huynha1/claude-statusline
https://github.com/Huynha1/claude-statusline — stars 0
1. `statusline.sh:166-193`: usage bars (context/5h/7d) coloured by threshold: green <35, yellow >=35 (33), orange >=60 (`38;5;208`), red >=85 (31) (`:175-179`); filled `█` takes the colour, remaining `░` is dim white `2;37`; label dim. Other segments uncoloured or dim (not examined further).
2. Themes: not present.
3. Colour spec: ANSI 16 plus one 256 index (208 for orange); no depth detection; no NO_COLOR found.
4. Fill: foreground only.
5. Separators: not examined in detail (spaces/dim).
6. Neighbours: by bar colour and dim labels.
7. Light/dark: not present.
8. Glyphs: `█ ░` and emoji labels (emoji width handled with an explicit `label_w`, `:166-168`).
9. Rate bars are 75 % the width of the context bar (`RATE_BAR_WIDTH`, `:30`); width-aware via `COLUMNS`.
10. Customisation: constants at the top of the script (bar width etc.); no config file.

## hymleong/claude-mods
https://github.com/hymleong/claude-mods — stars 0
(Windows-oriented mod marketplace; the styling is the `status-hud` mod, which draws the bar as an SVG image, plus a `Cache` countdown and a `workbench` pane.)
1. `plugins/status-hud/hooks/register.tsx`: colour by *state* for the activity tile: `LOOK` table maps state -> glyph + colour (`:157-172`): Idle gray `#8e8e93`, Thinking blue `#0a84ff`, Writing yellow `#ffd60a`, Editing purple `#bf5af2`, Planning indigo `#5e5ce6`, Running green `#30d158`, Reading/Searching teal `#64d2ff`, Delegating pink `#ff375f`, Browsing blue, Compacting amber `#ff9f0a`, Interrupted gray, Error / "Needs You" red `#ff453a` (Needs You also tints the whole tile at 14 % red, `tint :175`). Usage tiles use a fixed base per metric, 5-hour green, weekly amber, context green, flipping to red at >=90 % (`tone :112`, `:246-250`). Values drawn as rings (SVG stroke).
2. Themes: not present (an Apple-system-colour palette hard-coded at `:93-102`).
3. Colour spec: hex colours in SVG; no ANSI; depth/NO_COLOR not applicable.
4. Fill: tinted rounded rectangles (`rx=9/14`, `fill-opacity` 0.14-0.2) behind icons/tiles in an image; a dark card background.
5. Separators: spacing and tile boundaries; no glyph separators.
6. Neighbours: each tile has its own icon tint (state colour or metric base); background tints at low opacity.
7. Light/dark: not present (white `#fff` text and grey `#8e8e93` on a dark card).
8. Glyphs: custom line-art SVG icons (`glyph()` `:118-151`), no fonts needed.
9. Extra: whole bar rendered as image (so rings/rounded tiles possible); labels "Current Activity", "5 Hour Limit", "Weekly Limit", "Context Window"; a `Cache ⏱ 52:10` text countdown mod.
10. Customisation: none visible for colours; `workbench` has Shell / Load profile options.

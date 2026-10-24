## cc-usage-monitor
https://github.com/harveyxiacn/cc-usage-monitor — 1 star
1. Fixed per segment plus threshold. `bin/statusline.js:150-171` fixes colour per segment: model `paint(...,'cyan')` (bg `bgCyan` in badge mode), cost `magenta`, lines-changed `+green/-red` on `bgGray`, token arrows `gray`, token counts `cyan`, countdowns `gray`. Percent segments (ctx, 5h, 7d) go by threshold in `lib/format.js:129-133`: >=90 red, >=70 yellow, else green. Cache-hit is inverted (`format.js:141-145`: >=70 green, >=40 yellow, else red).
2. Ten bundled "themes" in `lib/theme.js` (`THEMES`: classic, minimal, compact, detailed, bracket, ascii, dots, badge, emoji, mono). They are glyph/label/width presets, not colour palettes. Only `color:` differs (`default`, `badge`, `mono`). Chosen by `CC_USAGE_MONITOR_STYLE` or `style` in the config file. Seven fine-tune overrides (sep, barWidth, brackets, labels...) exist, but no user-defined palette.
3. Named ANSI 16 only (`format.js:10-29`: `\x1b[32m`, `[97m`, bg `[42m`, `[100m`). No 256 or truecolor, no depth detection. Honours `NO_COLOR`, `CC_USAGE_MONITOR_NO_COLOR`, `FORCE_COLOR=0|false` (`format.js:32-39`).
4. Both. Default mode is foreground-only. `badge` theme (`format.js:100-110`) paints each segment as a pill ` text ` with black text on a segment-specific bg; with colour off it falls back to `[ text ]`.
5. Plain-text only. Default separator `│` in gray (`theme.js` CLASSIC `sep`); minimal `·`, compact `|`, dots `•`, ascii `|`. Badge mode uses a bare space plus a gray `·` inside. No powerline arrows.
6. Neighbours: separators only in default mode. In badge mode, different hue per segment (cyan, magenta, gray...).
7. Not present as adaptation. Badge pills use fixed black text (`format.js:105`). `mono` theme drops hue: gray becomes dim, red threshold becomes bold (`format.js:84-95`), which is a colour-free state signal.
8. Emoji labels via `emoji` theme (`labels: model 🤖, ctx 🧠 ...`); `ascii` theme is pure 7-bit with `locked` bar; bar glyph sets in `BAR_STYLES`; dot bars `●○`.
9. `mono` theme as accessibility mode; "unknown theme silently falls back to classic" (`theme.js` header).
10. Env vars `CC_USAGE_MONITOR_*` (STYLE, SEP, BAR_WIDTH, BRACKETS, LABELS, SHOW...), JSON config file bridged into env (`lib/config.js`), a `bin/config.js` CLI with validation, a slash command and live preview.

## claude-pulse
https://github.com/hasuwini77/claude-pulse — 1 star
1. Fixed label hue plus threshold. `statusline/claude-pulse-statusline.js:41-54`: 5h label/icon PINK `#f5c2e7`, weekly LAV `#b4befe`, credits PEACH `#fab387`, countdown MUTED `#9399b2`. Values go by threshold (`colorFor`, lines 56-61): <60 green `#a6e3a1`, 60-84 amber `#f9e2af`, >=85 red `#f38ba8`, null dim.
2. One hardcoded palette (Catppuccin Mocha) in the JS. No theme switching. `statusline.sh:10-17` and the sed block (~lines 74-77) remap ccstatusline's Tango ANSI names to the same palette. User-defined themes: not present.
3. Truecolor SGR only (`\x1b[38;2;r;g;bm`). No depth detection, no NO_COLOR (grep found none).
4. Foreground-only on the terminal's own background. ccstatusline config sets `"powerline": {"enabled": false}` (`ccstatusline.settings.json`).
5. Plain text, 2-space gaps; ccstatusline `separator` items in its config. No arrows.
6. Neighbours distinguished by different pastel label hues (pink vs lavender).
7. Header comment (`js:42-43`): palette chosen so every hue has about the same L/C and all pass >=4.5:1 on dark. Dark-only; no light handling.
8. `◔` `⟳` `⚡` glyphs; no Nerd Font. ccstatusline config uses `⌂` for worktree.
9. "Tonally unified" Catppuccin palette deliberately avoids "clashing-rainbow"; also a web dashboard (`dashboard/src/components/StatusBar.tsx`) which is separate from the terminal styling.
10. Edit constants in JS, or edit `ccstatusline.settings.json` (ccstatusline's own v3 format: `color: "brightGreen"`, `colorLevel: 3`, `flexMode`).

## zccstatus
https://github.com/hexsprite/zccstatus — 1 star
1. Fixed per segment, with a state override. `src/theme.zig` gives each theme an `fg`+`bg` `Pair` per segment: model, ctx, cwd, git, lines, cost, cache. Neon: model bg `#ff2a6d`, ctx `#1a1040`, cwd `#005678`, git `#05d9e8`, lines `#14213d`, cost `#2d1b4e`, cache `#7b2cbf`. Severity (`render.zig:377`): <60 `ok`, <85 `warn`, else `crit`; it colours only the ctx gauge cells (`emitCtx`, `setFg(hot)`). The cache cell swaps its whole pair when the countdown is short (`cachePair`, lines 342-347: <60s crit bg, <300s warn bg).
2. Three bundled (`theme.zig:~54-110`): neon (default), blade, acid. Format is a Zig struct with per-segment fg/bg pairs plus semantic roles `ok/warn/crit/bar_dim/ink_dark/ink_light/add/del`. Selected by `ZCC_THEME` or `--theme` (`main.zig:210-224`). Users cannot define a theme without recompiling.
3. Truecolor only (`render.zig:384/388`: `38;2;r;g;b`, `48;2;...`). No depth detection, no NO_COLOR.
4. Background-filled cells (every segment has a bg).
5. Powerline arrows `` U+E0B0 (left group) and `` U+E0B2 (right group). `render.zig:211-243`: separator fg = previous segment bg, separator bg = next segment bg. The left group's last arrow ends on the terminal bg with the previous bg as fg. Right group arrows sit before each segment, fg = that segment's bg.
6. Neighbours differ by a distinct bg hue per segment, alternating bright accent blocks with dark blocks (neon: pink, navy, teal, cyan, slate, purple...). The arrow chain carries the join.
7. Text contrast chosen by luminance: `alert()` (`render.zig:350`) picks `ink_dark` or `ink_light` by `luma(bg) >= 128`. A test, "every theme keeps every segment legible" (`render.zig:560`), enforces contrast. Terminal light/dark adaptation: not present (the fill is fixed).
8. Nerd Font required: bolt `\u{f0e7}`, microchip `\u{f2db}`, folder `\u{f07b}`, branch `\u{e0a0}`, clock `\u{f017}` (`render.zig:10-24`). Gauge `▓░`.
9. Width-aware shedding (`renderFit`) drops least-useful segments to fit; `--demo` mode prints all three themes; assets/demo.png screenshot.
10. Flags `--theme`, `--margin`, `--demo`; env `ZCC_THEME`, `ZCC_MARGIN`. No config file.

## cc-cleanline
https://github.com/heysash/cc-cleanline — 1 star
1. Fixed per line/segment plus per-model plus threshold. `cc-cleanline.config.sh:15-40` defines the colours. Per-model 256-colour (`COLOR_*`): Fable 141 lavender, Opus 215 sandybrown, Sonnet 130, Haiku 117 sky-blue; each has a dimmed "legacy" variant (104/180/101/110); deprecated 240; unknown 248. The context segment reuses the model colour (`context-display.sh:90` returns `model_color`). Rate-limit % by threshold (`lib/usage-tracking.sh:49-60`): <40 `COLOR_ACTIVE_STATUS` (bright green `\033[92m`), <90 orange 208, else red 196. Git line is active-green or inactive-red (`git-status.sh:48-55`). Directory, reset time, session cost: neutral gray `\033[90m`.
2. No themes. All colours are shell variables in `cc-cleanline.config.sh`; override by copying to `.local` file. "night-owl" was a false hit.
3. 256-index (`\033[38;5;Nm`) plus ANSI 92/90. No detection, no NO_COLOR.
4. Foreground-only.
5. No separators in the colour sense. Segments are space-joined and lines are separated by newline; `·` in gray between rate-limit and cost (`display-formatter.sh:~66`).
6. Line structure (3 core lines plus optional worktree/extras lines) and per-model hue.
7. Not present.
8. Emoji and symbols: `●` `○` `⚠` `✓` `▶`, `⏱`, 4-star effort meter `☆★`, `¹ᴹ` badge. No Nerd Font.
9. "Happy mode" easter egg (`happy-mode/rainbow.sh:10-24`): per-character rainbow cycling 256 colours `196 208 226 46 21 93`, enabled at `HAPPY_MODE_RAINBOW_CHANCE` (10% default); Matrix and fortune effects.
10. Edit `cc-cleanline.config.sh` or the git-ignored `.local` copy; env vars for happy mode.

## uucode
https://github.com/hollegjx/uucode — 1 star
FORK of CCometixLine (ratatui TUI configurator, themes as Rust modules); the repo is a Chinese-language fork (description: "optimization for Claude Code prompt bar"), not an explicit GitHub fork flag (`.fork=false`). Styling is the CCometixLine design plus a few additions.
1. Per theme, per segment, fixed. Each `src/ui/themes/theme_*.rs` function (`model_segment`, `directory_segment`, `git_segment`, `context_window_segment`, `cost_segment`, `session_segment`, `output_style_segment`, `usage_segment`, plus `uucode_*` segments) sets icon, text and background `AnsiColor`. In `theme_powerline_dark.rs` bg: model rgb(45,45,45), directory (139,69,19), git (64,64,64), context (55,65,81), cost (40,44,52), session (45,50,59), output style (50,56,66). In `theme_default.rs` (no bg, ANSI16): model cyan 14, directory yellow icon/green text, git blue 12, context magenta 13, cost yellow 3, session green 2, output style cyan 6. No threshold colouring found in `context_window.rs` (grep).
2. Nine built-ins (`presets.rs:get_theme`): cometix, default, gruvbox, minimal, nord, powerline-dark, powerline-light, powerline-rose-pine, powerline-tokyo-night. Format: per-segment `ColorConfig {icon, text, background}`. Users define their own as `~/.claude/uucode/themes/<name>.toml` (loaded first, `presets.rs:load_theme_from_file`); TUI can "save current config as theme".
3. `AnsiColor` enum has `Color16 {c16}`, `Color256 {c256}`, `Rgb {r,g,b}` (`statusline.rs:366-405`). Emits SGR directly. No depth detection, no NO_COLOR grep hit.
4. Both: backgrounded in powerline/nord/etc; foreground-only in `default` (no `background`).
5. Powerline arrow `\u{e0b0}` when `style.separator == "\u{e0b0}"` (`statusline.rs:60`, `create_powerline_arrow:483-512`): arrow fg = previous bg, arrow bg = current bg. Any other separator is drawn white (`\x1b[37m`).
6. Per-segment distinct bg in colourful themes; the dark powerline theme uses a near-neutral grey ramp (45/64/55/40/45/50) so neighbours differ by small lightness steps; nord uses the Nord accent for each segment's bg.
7. Not present as adaptation; `powerline-light` is a separate theme. `lightdark` hits were words in theme names.
8. Three icon modes (`StyleMode::Plain | NerdFont | Powerline`, `statusline.rs:361-364`): emoji (🤖 📁 🌿) vs Nerd Font codepoints (`\u{e26d}`, `\u{f024b}`, `\u{f02a2}`).
9. TUI configurator with colour picker (`src/ui/components/color_picker.rs`), icon selector and theme selector with live preview. A special coloured "welcome" text segment (`statusline.rs:277`, 256-colour 81).
10. CLI plus TOML config; interactive ratatui TUI; themes saved as TOML files.

## claude-statusline-mod
https://github.com/Hugopvigo/claude-statusline-mod — 1 star
Claude Code mod that draws a band (an SVG pill band on desktop, text pills in a terminal) and also keeps a classic ANSI script.
1. By state/threshold plus fixed per-metric. `hooks/render.ts:C` (lines ~44-53): dim `#94a3b8` model, time `#5eead4`, tokens `#7dd3fc`, resetIn `#fdba74`; `levelOf` thresholds: ok `#34d399` <80%, warn `#fbbf24` 80-94, crit `#f87171` >=95. In `hooks/register.tsx` pills: terminal `tone` map (lines 327-333) ok/warn/crit/up/cache each `{fg,bg}` e.g. ok `#6ee7b7` on `#14342b`; desktop SVG uses classes a/p/r/b/s/w/c (lines 157-172) per metric: 5h green-teal `.a`, 7d purple `.p`, tokens-in/out rust `.r`, cache blue `.b`, ctx slate `.s` (switching to warn/crit class at >=80%). 
2. No themes. One light and one dark class set in SVG CSS.
3. Truecolor (ANSI in `render.ts`, hex in Ink `color=`). No depth detection; no NO_COLOR.
4. Background-filled pills in both surfaces (SVG `rect rx=H/2`, terminal `backgroundColor`); the classic script is foreground-only.
5. Rounded pill ends (SVG `rx`); thin divider `<rect ... opacity=.25>`; classic script uses ` · ` in dim.
6. Neighbouring pills differ by hue (teal/purple/rust/blue/slate) and tinted bg of the same hue family.
7. SVG has `@media (prefers-color-scheme: dark)` swapping each class's text and fill (`register.tsx:165-173`) — the only light/dark adaptation. Terminal pills fixed to dark colours.
8. Geometric glyphs only ("no emoji", `render.ts` header): `◷ ◈ ▣ ◉ ↻ ▰▱`; stroke SVG icons.
9. Header rule "no purples" (yet the 7d pill is purple in SVG: `CLS7`). Pace marker on bars.
10. No config; edit source.

## cc-hud-go
https://github.com/huyhandes/cc-hud-go — 1 star
1. Theme role per segment plus threshold. `style/style.go:Init` loads 13 semantic roles (success, warning, danger, input, output, cacheRead, cacheWrite, primary, highlight, accent, muted, bright, info). Mapping: model/agent = primary bold (`ModelStyle`); git branch = highlight bold, dirty = warning, ahead = success, behind = danger, added = success, modified = info, deleted = danger (`segment/git.go:26-60`); tokens in/out = input/output; cache R/W = cacheRead/cacheWrite; cost = accent bold (`output/renderer.go:139`); duration = highlight; total tokens = info; separators `/` = muted. Thresholds (`style.go:ThresholdColor`): >=90 danger, >=70 warning, else success. Context tokens (`ContextTokenColor`): <150k success, <175k warning, <230k danger, >=230k hard `#ff0000`.
2. Four bundled Catppuccin flavors: mocha, macchiato (default), frappe, latte (`theme/theme.go:GetTheme`). Format is a semantic role map (`catppuccin.go`, `map[string]string` role to hex). `ThemeWrapper` supports per-role overrides, but ADR 0002 says that path is unreachable in practice (theme chosen only by `--theme` flag). User-defined themes: not present.
3. Hex strings via lipgloss/termenv; depth detection delegated to lipgloss `NewRenderer(os.Stdout)` (`style.go:init`). Whether it emits colour when Claude Code pipes stdout: unverified. NO_COLOR is handled by termenv, not in repo code.
4. Foreground-only.
5. Plain text: segments joined with `"  │  "` (`renderer.go:165-170`), uncoloured.
6. Segments distinguished by role hue and the `│` separators.
7. Flavor choice (latte vs mocha) is the user's manual light/dark adaptation (ADR 0002: "pick a Catppuccin variant to match their terminal"). No automatic contrast check.
8. Emoji labels (🧠 ⚡ 💰 ⏱ 📊); no Nerd Font.
9. Gradient bars: `style/gradient.go:RenderGradientBar` colours each filled cell by position along a 3-stop lerp (green `#a6da95` to yellow `#eed49f` at 50% to orange `#f5a97f` at 75% to red `#ed8796`), hardcoded to Macchiato, not theme-driven. `RenderContextBar` colours each cell by its absolute token zone.
10. `--theme` CLI flag in the `statusline.command`; no config file for colours.

## statusline-for-claude-code
https://github.com/hybrid2102/statusline-for-claude-code — 1 star
1. Almost uncoloured. `statusline.mjs:25-31`: only YELLOW and RED plus dim. Context: red >=90%, yellow >=70% or tokens >=200k, else uncoloured (line 213). Budget windows by traffic light (`segBudget:267-278`): green (uncoloured text), yellow, red, plus emoji 🟢🟡🔴. Labels dim; everything else default terminal colour.
2. No themes ("github" was a URL hit).
3. ANSI 16 only (`\x1b[33m`, `[31m`, `[2m`). No NO_COLOR, no detection.
4. Foreground-only, on the terminal's own background.
5. Plain ` · ` in dim between sub-items; segments are emoji-prefixed text.
6. Emoji prefix per segment (📁 🌿 🤖 🧠 💰 👤).
7. Using the terminal's own default colours is its adaptation; no explicit logic.
8. Emoji only; `short` variants for narrow widths, `prio` per segment (priority-based shedding).
9. Priority-based width fitting (`prio`, `short`).
10. No colour config; auto-updater and installer (`install.ps1`).

## claude-context-statusline
https://github.com/ibuckman-docflow/claude-context-statusline — 1 star
1. Threshold on one segment (`statusline.sh:43-52`): "Context: N% free" green >50% free, yellow 11-50%, red <=10%. Single segment.
2. No themes.
3. ANSI 16 (`\033[32m` `[33m` `[31m`). No NO_COLOR.
4. Foreground-only.
5. Not present (one segment).
6. Not applicable.
7. Not present.
8. Plain text (emoji hit is incidental).
9. Caches output to a file (not styling).
10. None; edit script.

## ccpulse
https://github.com/idootop/ccpulse — 1 star
1. By state/threshold plus structure. `statusline-command.sh:24-25` defines GREY, RED, YEL, GRN. Rate-limit bars (`rl_bar`, lines 77-101): >=80 red, >=50 yellow, else green; brackets are grey. cwd, branch, model, ctx text uncoloured (`lines 176-182`).
2. Six bar "styles" (blocks, compact, ascii, dots, line, minimal; `apply_style:51-58`), glyph presets only; no colour themes.
3. ANSI 16 (`\033[90m/31m/33m/32m`). No NO_COLOR.
4. Foreground-only.
5. Whitespace only: left group and right group separated by 4 spaces; items by 2 spaces.
6. Not present beyond spacing.
7. Not present.
8. Bar glyphs (`█░ ▰▱ ●○ ━─ #-`), `ascii` style for plain terminals.
9. Probes rate-limit headers; no styling extras.
10. `CCU_STYLE` / `CCU_BAR_WIDTH` env (`CCU_BAR_WIDTH` visible at line 61); script edit.

## cchud
https://github.com/IGoRFonin/cchud — 1 star
1. By position (powerline) or none. Powerline mode: each segment's bg/fg come from the theme's cycle by global index (`src/render/powerline.rs:101-102,138-153`: `bg_cycle[idx % len]`), unless the widget has an explicit per-widget style override. Plain mode: widgets carry no colour (checked `src/widgets/context.rs`, `git_diff.rs`: no colour calls), so colour only appears if the user sets it per widget; separator takes the previous segment's fg (`plain.rs:43-45`).
2. Five built-ins (`src/render/themes.rs`): default (greys `54/80/110`), dracula, solarized-dark, nord, gruvbox-dark. Format: `PowerlineTheme {terminal_bg, default_fg, default_bg, bg_cycle[], fg_cycle[], widget_styles map}`. Dracula `bg_cycle` = `(98,114,164) (189,147,249) (255,121,198) (80,250,123)` with fg `(40,42,54)` throughout. `widget_styles` empty in all built-ins. Theme values "mirror upstream ccstatusline". User themes: `PowerlineTheme` is serde-able; persistence via JSON config (`theme.theme_name`); custom palette authoring unverified.
3. Truecolor and ANSI-256 (`Color::Rgb`, `Color::Ansi256`). `ColorLevel::detect` (`render/mod.rs:39-52`) defaults to TrueColor (TTY check would wrongly say none because stdout is piped) and honours `NO_COLOR`; `CCHUD_TEST_COLOR_LEVEL` forces ansi256/truecolor/none. `color_sanitize.rs` downsamples RGB to a 6x6x6 cube/24-grey 256 index.
4. Both: plain `theme.kind = plain` is fg-only; powerline fills.
5. Powerline `U+E0B0` (left) with optional `U+E0B2`; configurable `separator_left/right`, `start_cap`, `end_cap` (`powerline.rs:16-39`). Sep style: fg = prev bg, bg = next bg; `inherit_separator_colors` option makes both halves previous bg. Final arrow transitions to `terminal_bg`.
6. Cycle through 3-4 background colours; lightness steps in `default` (54, 80, 110 greys), different hues in dracula/nord (a ramp of blues in nord).
7. Per-theme `fg_cycle` is a fixed dark fg on all bg's in dracula/nord/solarized; `terminal_bg` held per theme. No luminance-based pick.
8. Nerd Font required for powerline (README); OSC 8 hyperlinks (`hyperlink.rs`); emoji-stripped minimalist composer.
9. TUI configurator (ratatui) with theme overlay (`t`), colour picker (16 ANSI + custom hex), `ccstatusline` migration importer, presets `dev/git-heavy/minimal/powerline-dracula/powerline-gruvbox` as JSON.
10. JSON config (`lines[].widgets[]`, `theme`), TUI, per-widget overrides: color, background, bold; `NO_COLOR` env.

## yozakura
https://github.com/imdafne/yozakura — 1 star
Not a statusline project: Ghostty terminal theme pair (Yozakura dark, Sakura light; `themes/Yozakura` is a palette file of `palette = N=#hex`, built on Catppuccin Mocha with a pink/lavender/flamingo remap of red/blue/yellow). Its installer (`bin/install.js:65-100`) also generates a small `statusline-command.sh` with a 10-cell `█░` bar coloured by context percent (`>=60` ANSI 31, `>=40` ANSI 33, else ANSI 32), so the statusline simply inherits the remapped terminal ANSI palette. Ghostty `theme = dark:Yozakura,light:Sakura` auto-switches light/dark (`install.js:14`). Config surface: installer prompts; no statusline theming.

## claude-code-statusline (ist-j-ichikawa)
https://github.com/ist-j-ichikawa/claude-code-statusline — 1 star
1. Per segment fixed, plus per model, plus threshold. `statusline-command.sh:74-199` (256-colour): provider labels Anthropic 180, Bedrock 72, Vertex 33, Foundry 39; git 202; agent 213; output style 231; cost 136 bronze; thinking 117; fast 190; spend 220; draft PR 245; cache cold 81, warm 216. Context bar `color_by_threshold` (lines 427-436): >=`LIMIT_HI` red `\033[31m`, >=80 yellow, else `CTX_OK` 82 lime. Effort levels: low 178 gold, medium 71 green, high 105, xhigh 99, max gradient. Diff +/-: 71 / 203 (deliberately not ANSI 31/32, comment lines 81-90: terminals remap ANSI red/green to olive/brick). Rate-limit frames: one colour per element; 90%+ switches the whole element to red.
2. No theme files. Colours are `readonly` constants. Per-model palettes (`model_color`, lines 296-312): Opus 5 gradient `130 173 215`, Opus 5.5 `61 139 215`, Sonnet 5 `28 70 148 154`, Sonnet 5.5 `25 68 110 153`, Haiku 5.5 `168 175 222`, Fable 5 rainbow `178 172 130 167 143 107 66`, Fable 5.1 `95 137 214 187`; older Opus flat coral 173, Sonnet teal 79, Haiku lavender 183, Sonnet 4.5 amber 214. Users: edit script.
3. 256-index (plus ANSI 16 for 31/32/33). No depth detection, no NO_COLOR (comment line 13 notes it ignores `FORCE_COLOR`).
4. Foreground-only, except vim-mode badges which are bold black on bg 109 (INSERT) or 208 (VISUAL) (lines 192-199).
5. Plain-text separators; box-drawing glyph counts (534 hits) are braille bars and rule characters.
6. Distinct hue per element, with a stated rule: "do not put two colour systems in one element" and a catalogue of used xterm numbers to avoid collisions (comments at 606-640).
7. Comments reason about dark-terminal bias ("Primer dark tokens"), light-theme safety for gradient endpoints (avoid near-white 216/223), and the contrast between stops by relative luminance (about 38 apart, lines 100-115). No runtime detection.
8. Braille bars (`braille_bar`), emoji (🌲 worktree), OSC 8 links (line 223).
9. `gradient` (one sweep across a name) and `rainbow` (cycle per character) helpers, lines 229-255, give each model a multi-colour name; palettes derived from each model's announcement artwork.
10. Env vars (`CLAUDE_STATUSLINE_NO_NET`, `CLAUDE_STATUSLINE_V2_CACHE_DIR`...); edit constants. No colour config file.

## claude-forge
https://github.com/IT-BAER/claude-forge — 1 star
Not a Claude statusline: a collection of Claude Code mods and a VS Code extension ("Skills and mods for Claude Code"). Relevant styling: `extensions/claude-status/extension.js:15` maps band colours to VS Code theme colours (`green` to `terminal.ansiGreen`, `yellow`, `red`, `cyan`, `dim` to `disabledForeground`) so each editor theme supplies its own shades; `status.js:154-160` `limitColor` red/yellow by percent versus week-elapsed budget; cache state colours: kept cyan, warm green, cooling yellow, cold dim/red (`status.js:170-177`). `mods/session-band/hooks/register.mjs` uses Ink `Text color` named colours with `dimColor` for the same states.

## tokyo-train-board
https://github.com/JaeggerJose/tokyo-train-board — 1 star
Not a typical Claude statusline: a statusline that shows Tokyo train timetables (departures marquee). Styling noted: each rail line carries an official truecolor hex (`scripts/apply_colors.py:OFFICIAL`, e.g. yamanote `#9ACD32`, chuo `#F15A22`, ginza `#FF9500`), emitted as `ansi_bg` badge (`48;2` bg plus a luminance-chosen black/white fg: "dark text on light colours, white on dark", `brightness()` in that script) and `ansi_fg` for text. Fixed palette for alerts (`render.py:23-29`: orange 208, red 167, green bg 28 white-on-green nav bar). Single-line marquee scroll (`jrboard/statusline.py:1-7`) is the motion. Colour is per transit line (data-driven), not per statusline segment.

## claude-code-hud
https://github.com/JaQuan5000/claude-code-hud — 1 star
Not a plain statusline: a Claude Code plugin that routes requests to models and renders a HUD (a band mod plus a statusline). Styling noted: `hud-format.js:41-46` `tone()` maps percent to Ink colour names green/yellow/red (`AMBER_FROM=56`, `RED_FROM=86`); model text cyan (yellow if pinned) and routing badge green/yellow (`hud-format.js:223-225`); progress bars use eighth-block partial cells; plan accent `#7a7cf8`, glow `#bcc0ff`, done `#5fbf8f` (lines 468-471), with a comment that the terminal accent was nudged because a 16-colour terminal (tmux `TERM=screen`) rounded `#8f8cf4` to bright white. `hud-svg.js` (desktop SVG): zone colours `#3fa45b/#d79020/#d9534f` "chosen to read on a light and a dark theme", neutrals as mid-grey with opacity, a linear gradient over the whole track, twinkling squares disabled under `prefers-reduced-motion`. ASCII fallback flag throughout (`ascii ? '#' : '█'`).

## claude-pomodoro
https://github.com/jatinmayekar/claude-pomodoro — 1 star
1. By state. `scripts/statusline.sh:100-111`: phase colour coral 203 for focus, sage 108 for break; model/dim 245, separator 240, empty bar cells 238.
2. "theme" is an icon/animation set, not colours: tomato, cat, dog, dots, custom (`lines 72-90`). Custom fill/empty/head glyphs from config JSON.
3. 256-index only. No detection, no NO_COLOR.
4. Foreground-only.
5. Two-space gaps and a faint `|` after the model.
6. Not applicable beyond the phase colour.
7. Not present.
8. Emoji 🍅 ☕, kaomoji (`ᓚᘏᗢ`), braille spinner frames.
9. Animated icon frames step once per refresh (`frame=$elapsed`); bar drains across the phase.
10. JSON config at `$CFG` (work_min, break_min, theme, bar_len, show_model, custom).

## cc-statusline (jcarlin)
https://github.com/jcarlin/cc-statusline — 1 star
1. Fixed per segment plus threshold. `statusline.sh:22-90`: model bold; branch cyan (magenta with `•wt` for worktree); cost green; duration cyan; lines `+green/-red`; cache magenta; rate and context bar by threshold: <50 green, <80 yellow, else red. Separator `│` dim.
2. No themes.
3. ANSI 16. No NO_COLOR.
4. Foreground-only.
5. `│` in dim (`SEP="${DIM} │${RST}"`, line 32).
6. Distinct fixed hue per segment type (cyan/green/magenta) plus the separator.
7. Not present.
8. ASCII bars `[###---]`, no icons.
9. None.
10. None; edit script.

## agent-crew
https://github.com/jduerrmann/agent-crew — 1 star
Not a Claude statusline: a Claude Code mod pane for subagents, files they touch and usage (Ink/React components). For reference: file-operation colours are fixed (`register.tsx:69-73`: read `#a855f7`, write `#f97316`, commit `#22c55e`, delete `#ef4444`, new `#3b82f6`), agent types take the next free colour from an 8-colour palette or a hash of the key (`TYPE_PALETTE`, lines 486-514), animated crab sprites.

## df-market
https://github.com/jjj201200/df-market — 1 star
A plugin marketplace; only `plugins/glm` is a statusline (the token-reporter plugin is a web dashboard, outside scope).
1. GLM statusline (`plugins/glm/scripts/lib/statusline-core.mjs:56-104`): fixed `user@host` bold green, dir bold blue, model/ctx dim; quota windows by threshold (`colorFor`): >=80 bold red, >=60 bold yellow, else dim.
2. No themes.
3. ANSI 16 (`\x1b[01;32m` style bold-colour). No NO_COLOR.
4. Foreground-only.
5. Single spaces; format imitates a bash prompt (`user@host:dir [model] ctx:N% 5h:N%`).
6. Spaces only; the colour pair for user@host vs dir.
7. Not present.
8. None.
9. Reset time appended in dim at >=90%.
10. None.

## claude-mods
https://github.com/joeldg/claude-mods — 1 star
Not a Claude statusline: a set of personal Claude Code mods (dev-servers, downloads-drop, effort-router, job-watch, machine-guard, mod-monitor, modal-meter, pr-autopilot, recall). Styling is Ink `Text` with `color="yellow"` / `dimColor` (e.g. `modal-meter/hooks/register.tsx:601-640`) and `NO_COLOR=1` passed to a child process to get plain output.

## claude-status-bar
https://github.com/JohnnyTh/claude-status-bar — 1 star
1. By tier (progression) for the XP bar only: `statusline.py:42-52` `tier_color`: tiers 1-5 dim cyan, 6-10 blue, 11-14 yellow, 15-18 magenta, 19-20 bold red. All other text uncoloured.
2. A `theme` key (default "corpo", `DEFAULT_CONFIG` line 414) exists, but it is a narrative/flavour setting for tier-up quips; no visual palette. "cyberpunk" is the project's theme.
3. ANSI 16 (`C` dict lines 24-39). No NO_COLOR.
4. Foreground-only.
5. `|` and two-space gaps; the bar is `[████░░░]`.
6. Not applicable.
7. Not present.
8. Block bars, sparkline of token history (`fmt_sparkline`).
9. 20-tier cyberpunk "XP" progression with narrative quips; the bar colour changes with the tier.
10. JSON config (`xp_base`, `xp_exp`, `quip_interval`, theme).

## astrolabe
https://github.com/jonyfs/astrolabe — 1 star
A Claude Code mod ("session status, Spec Kit progress, usage governance"); its footer is drawn by a vendored copy of the separate `jonyfs/statusline` project (README "The footer is statusline itself"). Styling:
1. By theme role and state. `hooks/core/theme.ts`: 11 semantic roles (accent, text, muted, faint, done, current, warn, pending, barFill, barEmpty, blocked); statuses map `warning` to `current`, `error` to `blocked`, `success` to `done` (`STATUS_ROLE`). One usage ramp for context/5h/7d: below 60% done colour, from 60% yellow with `▵`, from 80% the blocked colour with `▴`, 100% reads "full" (README "One vocabulary").
2. Five flavors: mocha, frappe, macchiato, latte, colorblind (`FLAVORS`), plus `theme` which maps roles onto Claude Code's own theme keys (`THEME_TOKENS`: claude, success, warning, error, subtle, inactive, suggestion) so it follows the host's light/dark. Format: role to hex. Footer chips use a separate `CHIPS` table (crust, text, surface1, red, peach, yellow, green, sapphire, lavender, mauve, teal).
3. Hex and `ansi:0..15` run colours (`statusline-dep.ts`); `COLORTERM=truecolor` forced to the vendored renderer; Claude Code theme keys for `theme` flavor. NO_COLOR: not present.
4. Chips are background-filled with dark/light text; plain rows are foreground-only.
5. `│` between zones and `·` within a zone, never both (README); footer chips are zones. Powerline arrows: not present.
6. Chip bg hues from the CHIPS table and glyph one-cell-wide rule so rows do not shift.
7. Strongest contrast handling in the batch: `TEXT_ROLES` must reach 4.5:1 on the flavor base (comments, `theme.ts:7-9`); latte uses darkened variants of green/peach/blue/yellow because Catppuccin's own fall under 4.5:1; `chipForeground(bg)` picks `#11111b` or `#eff1f5` by WCAG contrast ratio; `flavorOf` maps `theme` to latte or mocha by lightness; a `no-literal-colour` test forbids colour literals outside `theme.ts`.
8. Icon sets with ASCII mode (`CLAUDE_STATUSLINE_ASCII=1`), Nerd glyph set (16 hits); colourblind flavor adds redundant marks `✓ ▲ ○ ✖` (`COLORBLIND_MARKS`).
9. Brighten-on-change: `lighten(hex, amount)` for a chip that just changed; colourblind-safe palette; "only place colors live" principle.
10. Mod options (`flavor`, `glyphs`, `separator`, `passive`, omit list); env vars `CLAUDE_STATUSLINE_FLAVOR/ASCII/OUTPUT` to the vendored statusline.

## claude-statusline (JoseVelazcoH)
https://github.com/JoseVelazcoH/claude-statusline — 1 star
1. Fixed role per segment plus threshold. `claude/themes/mocha.sh`: C_MODEL peach `250;179;135`, C_DIR sky `137;220;235`, C_BRANCH mauve `203;166;247`, C_SEP overlay0, C_LABEL overlay1, C_GREEN/YELLOW/RED. `statusline-command.sh:142-150` renders model/dir/branch bold in those; git +added green, ~modified yellow, -deleted red (line 162); usage bars via `usage_color` (lines 97-107): >=80 red, >=50 yellow, else green.
2. Four bundled Catppuccin flavors: mocha (default), frappe, macchiato, latte (`claude/themes/*.sh`), each a shell file of `"r;g;b"` roles (8 roles). Switch with `statusline-theme.sh <name>`, which writes `~/.claude/.statusline-theme`; users can drop their own `*.sh` into `~/.claude/themes/`. Built-in Mocha fallback in the script.
3. Truecolor (`\033[38;2;R;G;Bm`). No detection, no NO_COLOR.
4. Foreground-only.
5. Plain ` • ` and ` | ` in the separator colour (`statusline-command.sh:109-110`).
6. Distinct hue per segment (peach/sky/mauve) plus muted separators.
7. Flavor choice is the light/dark adaptation (latte). No contrast check.
8. Box-drawing / bar glyphs; no Nerd Font.
9. Interactive config script (`statusline-config.sh`, `/statusline-config` skill) toggles segments, order, theme.
10. Config file plus config script, theme files, install/uninstall scripts.

## claudux
https://github.com/jqueguiner/claudux — 1 star
Not a Claude Code statusLine: a tmux status-bar plugin showing Claude usage (colours via tmux `#[fg=colourN]`). For reference: `scripts/render.sh` bars coloured by thresholds (<warning dim grey 238, >=warning yellow 220, >=critical red 196; defaults 50/80 in `config/defaults.sh`), model dot per family (opus colour135, sonnet colour39, haiku colour214, other 245; lines 390-397), labels `fg=black,bold`, rate-limit counts coloured green 34 / yellow 220 / red 196 by hourly volume; options as `@claudux_*` tmux settings.

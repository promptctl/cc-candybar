## glm-quota-line
https://github.com/deluo/glm-quota-line — 33 stars. File anchors are in the repo as of HEAD at read time; line numbers are from the fetched copies.
1. Colour by role ("tone") and by severity. `src/core/status/format.js` tags every text run with a tone (`label`, `muted`, `barEmpty`, `reset`, `plain`, or a severity: `good`/`warn`/`danger`/`neutral`, e.g. lines 55, 72-75, 91-92, 124-140). Quota severity from `viewModel.js:49-62`: left% >= 60 good, >= `LOW_QUOTA_THRESHOLD` (30, `shared/constants.js:58`) warn, else danger; weekly severity from burn pace (`viewModel.js:67-121`: pace > 1.1 warn, > 1.3 danger). Context severity from used% (`core/context/calculator.js:34-47`: >= 80 danger, >= 60 warn, else good). Bar fill, the number and the "left" text share the severity colour; the label is `label` tone, `ctx`/separators are `muted`. Nothing is fixed per segment.
2. Three bundled themes, `dark`, `light`, `mono` (`theme.js:4-44`, validated in `constants.js:86`). Format is a semantic tone map: tone -> list of SGR strings. No user-defined themes (the config only picks one of the three names, `shared/config.js:25`).
3. `ansi.js:1-16`: a mix of truecolor (accent `38;2;119;209;208` dark / `38;2;34;95;120` light; "green" is actually `38;2;70;148;175` blue-teal; yellow `38;2;255;130;0`; red `38;2;220;53;19`) and ANSI-16 (`90` gray, `37` white, `30` black). No depth detection, no downsampling, no NO_COLOR handling found; the `mono` theme is the manual no-colour mode (bold/underline only, `theme.js:31-43`).
4. Foreground only. No background fills.
5. Plain-text separator string from config (`this.global.separator`, `format.js:270`) coloured `muted`, and a literal ` | ` (`format.js:192-198, 221-231`). No powerline.
6. Separators only (muted). Neighbours are not coloured differently: same label colour, severity colours only.
7. `light` vs `dark` themes differ in the accent (`darkAccent` vs `lightAccent`) and `neutral` (white vs black) (`theme.js:6,19,16,29`). Chosen by config, not detected.
8. Bar glyphs `█ ▒ ░` (`constants.js:69-73`); the `▒` "shade" cell is painted `shade_<severity>` (`format.js:137`). No emoji or Nerd Font in the status text that I found.
9. Per-cell pace "shade" cell in the bar. TUI configurator (`src/tui/index.js`) using its own palette (`ansi.js:24-52`, `getTuiColors("mono")`).
10. Config JSON via CLI (`src/cli/configCommand.js`): `theme`, `style` (`text|compact|bar`), display mode, reset format, work days; interactive TUI.

## minimax-status
https://github.com/JochenYang/minimax-status — 33 stars.
1. Fixed per segment (hex backgrounds), with state overrides. `cli/renderer.js:renderSessionLine` (lines 70-141): directory `#2563EB`, git branch `#9333EA`, model `#4C1D95`, context `#0369A1`, remaining-time `#92400E`; all `fg #FFFFFF`. The 5h quota block is state-coloured by REMAINING%: >= 60 `#065F46`, 30-59 `#9A3412`, < 30 `#991B1B` (lines 108-111). Expiry block: `#374151`, <= 7 days `#9A3412`, <= 3 days `#991B1B` (lines 131-135). Tools line (`renderToolsLine`, 176-253) uses fixed chalk named colours (running `◐` yellow, done `✓` green, agent type magenta, model cyan, elapsed yellow). `getStatusColor` (64-68): >= 85 red, >= 60 yellow, else green, used by `cli/statusbar.js` (the plain one-line variant, lines 18-48).
2. No themes, no user colour config found (colours are literals in `renderer.js`).
3. chalk `bgHex`/`hex`, so truecolor with chalk's own downsampling to 256/16 (`renderer.js:146-158`). NO_COLOR is not read in the code; chalk's supports-color does honour it and FORCE_COLOR (inferred from the library, not verified here).
4. Background-filled blocks with white text, plus fg-only for the tools line.
5. Powerline arrow `` between blocks; arrow fg = this block's bg, arrow bg = next block's bg (`renderer.js:150-158`). The last arrow fades to the terminal background (fg only). The first block starts with an arrow glyph drawn black-on-bg (146). No-Nerd-Font fallback: `>` drawn as white on this block's bg (155).
6. Different hue per segment (blue / purple / indigo / sky / brown), state recolours the quota block; arrows join them.
7. Text is always `whiteBright`; the palette is tuned dark ("Emerald 800 - dark enough for white text", comment line 108). No light-terminal adaptation.
8. Nerd Font `` and branch ``; ASCII fallback (`>` and `*`) when `MINIMAX_PLAIN_UI` or `NO_NERD_FONTS` is set (`renderer.js:7-16`). Emoji appear in other CLI output (not the statusline blocks).
9. Also ships a VS Code extension (`vscode-extension/`) — separate UI.
10. No config for colours. CLI (`cli/index.js`); env `MINIMAX_PLAIN_UI`, `NO_NERD_FONTS`.

## ccsidekick
https://github.com/krayong/ccsidekick — 31 stars. The most developed colour system in this batch.
1. By position, with state overrides. The theme carries a short list of "hues" (4-5 xterm-256 indices) and a banding mode: `solid` paints one hue per LINE (`hues[lineIdx]`), `cycle` advances per CELL (`hues[lineIdx + cellIdx]`), so each row is a rainbow shifted one stop per line (`packages/core/src/render/theme.ts:124-139`; applied at `render/layout.ts:181-205`). Icon/label segments use the accent hue and value segments use the same hue (`valueColor` = `accentColor`). Threshold/state segments (`seg.signal`) override with the theme's three signal colours `nominal` / `caution` / `critical` (`layout.ts:197`; `compose/statusline.ts` e.g. 289-309: `+ins` nominal, `-del` critical, ahead nominal, behind critical, merge-operation caution). Separators and placeholders use the theme's `separator` colour (`layout.ts:198`). Which widget gets which hue is therefore its cell index in the row, not its identity.
2. 57 built-in named themes (`packages/core/src/data/themes.ts`, header comment line 1; README says 75+ including character packs): Houston (fallback), Dracula, Nord, One Dark, Gruvbox Dark, Tokyo Night (+Storm), Catppuccin Mocha, Solarized Dark, Monokai, Material, Night Owl, GitHub Dark, Ayu, Everforest, Rosé Pine, Kanagawa, Zenburn, Synthwave '84, Cyberpunk 2077, etc. (all dark). Format: `{ displayName, hues[4-5], comment[2-3], signals{nominal,caution,critical}, separator }` — a role map, not a per-segment map. Per-surface override (statusline / logo / comment) with `config.theme.name` and a `character` sentinel that follows the active character pack's theme (`theme.ts:77-120`). Users can add themes by shipping a pack with a `theme` block; `themeValidate.ts` holds user themes to the same invariants (visible not grey, signal colours must be in green/amber/red hue families, `SIGNAL_HUE_RANGES`).
3. xterm-256 indices only, "there is no truecolor path" (`render/color.ts:1-3`). RGB gradients are interpolated then snapped to the nearest cube/grayscale index (`color.ts:59-78, 112-132`). NO_COLOR or a non-TTY strips every escape (`color.ts:165-175`, `term.noColor`).
4. Foreground only. No background fills.
5. A plain separator glyph in the theme's `separator` colour, put between cells (`layout.ts:225-228`); not powerline.
6. By hue: under `cycle` banding adjacent cells take consecutive hues; under `solid` neighbours share a hue and only the separator glyph divides them.
7. Dark-terminal only: validity rule rejects greys and near-black (`THEME_CHROMA_MIN` 40, `THEME_MAXCH_MIN` 95, `constants.ts:43-44`; `color.ts:81-86`). No light mode, no contrast computation.
8. Emoji icons per widget in `DEFAULT_ICONS` (`theme.ts:39-72`: 📁 dir, 🌿 branch, 📊 context, ...), overridable through `[theme.icons]`; braille/ASCII figure art. No Nerd Font.
9. A mood system tints accent colours toward warm/caution/cool by session mood (`theme.ts:150-166`, `color.ts:134-163`), never touching signal colours; an animated ASCII character figure with shimmer; gradient comment text; a bold bright-white fixed "helpful tip" row with severity emoji (`theme.ts:168-182`); OSC 8 links with dotted-underline (`color.ts:177-195`). Ink TUI dashboard with theme picker (`tui/sections/ThemeSection.tsx`) and a web render (`web/render-web.ts`).
10. Config object `config.theme.{name,statusline,logo,comment,banding,icons,mood_shift}` (`theme.ts:77-118`; file format not read). CLI `npx ccsidekick setup --character --theme --mode`, `list themes`, an Ink TUI, a wizard, and a `/ccsidekick-setup` slash command (README).

## tzengyuxio/claude-statusline
https://github.com/tzengyuxio/claude-statusline — 31 stars.
1. Fixed per segment plus threshold on percentages. `statusline-command.sh`: model cyan+bold with icon (240, 242), directory blue (245), git branch magenta (136), `+staged` green (132), separators dim `│` (84). Context bar and rate-limit percentages use `pct_color` (89-95): < 50 green, 50-79 yellow, >= 80 red. At context >= 90 a red-background badge ` CTX n% ` with bold white text is prepended (`BG_RED`, `WHITE_BOLD`, 240). Vim mode: NORMAL blue, otherwise green (160).
2. Two palettes only, `dark` and `light` (lines 52-72); no named themes, no user themes.
3. ANSI-16 codes only (`\033[32m`, etc.). No depth detection, no NO_COLOR.
4. Foreground only, except the one `BG_RED` alert badge (line 60/240).
5. Plain ` │ ` in dim (`SEP`, line 84).
6. Separators only; hue differs by role.
7. Real light/dark handling: `STATUSLINE_THEME=dark|light|auto`; auto reads macOS `defaults read -g AppleInterfaceStyle` (success -> dark), then `COLORFGBG` (bg < 8 -> dark), else dark (lines 21-46). Light palette swaps dim to bright-black `\033[90m` and alert text to bold black (53, 61).
8. Nerd Font Material Design icons (U+F0000+ range, lines 74-85); no ASCII fallback found.
9. Two-line layout; 16-segment progress bar.
10. Env var `STATUSLINE_THEME`; edit the script. `install.sh` wires it up.

## ccline-packycc
https://github.com/ding113/ccline-packycc — 29 stars. FORK OF Haleclipse/CCometixLine. Compared against the parent at the fork point (`compare` shows 17 commits ahead).
Everything about the shared renderer is the parent's; read from the fork's copy: `src/core/statusline.rs`, `src/ui/themes/*.rs`.
1. The only styling difference is one added segment, `Quota` (PackyCode balance, `src/core/segments/quota.rs`, `ui/themes/presets.rs:quota_segment` added at the end of every theme's segment list): icon and text `AnsiColor::Color16 { c16: 11 }` (bright yellow), `background: None`, in EVERY theme including the powerline ones. Fixed colour, no thresholds (no colour logic in `quota.rs`). Parent mapping for reference (`theme_powerline_dark.rs`): fixed per segment, white text on bgs model `rgb(45,45,45)`, directory `(139,69,19)`, git `(64,64,64)`, usage `(55,65,81)`, cost `(40,44,52)`, session `(45,50,59)`, output_style `(50,56,66)`.
2. Parent themes unchanged: cometix, default, minimal, gruvbox, nord, powerline-dark, powerline-light, powerline-rose-pine, powerline-tokyo-night (`themes/mod.rs`). Per-segment colour map (`ColorConfig {icon, text, background}`), user editing via TUI.
3. Unchanged: `AnsiColor::{Color16, Color256, Rgb}` (`config/types.rs:58-62`, `statusline.rs:apply_color`).
4-9. Unchanged except: because the quota segment has no background, in powerline mode the arrow into it takes the `(Some(prev), None)` branch of `create_powerline_arrow` (`statusline.rs`, last match arm) and the segment is fg-only inside a bg-filled chain; the TUI preview mock shows `$88.48 Opus✓` (`ui/components/preview.rs`).
10. Unchanged (TUI-driven config).

## hud-mode
https://github.com/adrida/hud-mode — 28 stars.
not a Claude statusline: a wrapper that drives `claude -p --output-format stream-json` and draws its own managed instrument block and prompt bar at the bottom of the terminal (`bin/hud.js:1-14`); it does not use Claude Code's `statusLine` setting. For the record, its colours are a fixed 256-colour palette (gold 178, champagne 222, brass 136, amber 214, red 167, green 108, cyan 116, ink 240; `hud.js:24-40`), with `[ label value ]` gauges (`hud.js:441`) and permission-mode colouring (plan = cyan, bypass = red, else champagne; 828-831).

## phase-runner
https://github.com/AyeJK/phase-runner — 28 stars.
not a Claude statusline: a Claude Code plugin for phase-based planning with a web viewer (`viewer/src/client/theme.ts` is a light/dark/system CSS `data-theme` toggle) and a HUD module that emits toasts and a `/phase-status` answer (`hud/hooks/hud.ts:1-12`); no ANSI colouring.

## alp82/claude-statusline
https://github.com/alp82/claude-statusline — 27 stars.
1. Mix of fixed per segment and thresholds, all truecolor (`statusline.sh:105-137`). Fixed: model `GREEN ★ name` (450), project name xterm-256 index 74 (437), branch `DIM ⎇` or amber `⎇+` for a worktree (439-441), added files green / modified amber (389-390), lines `+n` bold green (397). Thresholds: `pct_color` for 5h/7d/Fable limits: > 80 red `220,60,60`, >= 50 yellow `220,200,60`, else green `140,194,74` (115-119); `ctx_color` is tighter: >= 50 red, >= 25 yellow (134-138); `pace_color` colours the stacked bar by usage vs elapsed window time: > 5 points ahead red, within +/-5 yellow, behind green (125-130).
2. No themes (one hard-coded palette); the `remotion/src/theme.ts` palette is for the project's promo video, not the statusline.
3. Truecolor `38;2;r;g;b` for almost everything; one xterm-256 (74). No depth detection, no NO_COLOR.
4. Fg-mostly; bars use a background track `48;2;55;55;55` behind fg-coloured block glyphs (112, 152); the stacked bar uses `▀` with fg = usage colour and bg = elapsed-time blue `48;2;40;80;130` (162-172).
5. Plain `│` in colour `55,55,55` (`SEP`, 107; 304); `·` between model and effort (452).
6. Separators only, plus hue by role.
7. Grey `138,138,138` for labels and a very dark `55,55,55` separator: dark-terminal assumption; no detection.
8. Unicode block glyphs (eighths `▏…▉`, vglyph `▁…█`, `★`, `⎇`); no emoji/Nerd Font; no fallback mode.
9. Stacked pace bar (two rows in one cell: usage vs elapsed), pace-coloured glyph beside a blue time glyph (472-476); `subagent-statusline.sh`; `prototypes/stackline.sh`.
10. Edit the script; install via `docs/install.sh`. No config file found.

## claude-code-statusline-pro-aicodeditor
https://github.com/HorizonWing/claude-code-statusline-pro-aicodeditor — 27 stars. FORK OF Wangnov/claude-code-statusline-pro (15 commits ahead, 124 behind; `compare`).
Differences only. The themes (`classic` / `powerline` / `capsule`, `src/themes/types.ts`) and renderers are not in the fork's diff, so they are the parent's.
1. The one styling addition (commit "Add conditional color formatting to widget templates", `src/components/widgets/base-widget.ts`): a template can colour a value by state. `{points:color(< 1000, red, green)}` (condition, colour if true, colour if false) and the combined `{x:color(< 100, red, green):.2f}` (`base-widget.ts:391-425`), and static `{red:text}` (142-147). Used in `configs/components/aicodeditor.toml:59-61` to turn a credits balance red under 1000 and an expiry countdown red under 7 days. Applied to the new `api`/`info` widgets, not to the stock segments.
2. Not present (no new themes).
3. The colour names for this feature are ANSI-16 only: 8 normal + 8 `bright_*` (`base-widget.ts:169-173, 512-532`).
4-8. Not present beyond the above.
9. Windows/macOS/Linux settings loader (`src/utils/settings-loader.ts`), a `usage.toml` component.
10. TOML component configs (`configs/components/*.toml`); the condition/colour syntax lives inside widget `template` strings.

## barista
https://github.com/pstuart/Barista — 27 stars.
1. No ANSI colour at all in the statusline output; "colour" is carried by emoji status circles chosen by thresholds. `modules/context.sh`: warning at 60%, critical at 75%, compact at 80% (settings `CONTEXT_*_THRESHOLD`, lines 10-12); the theme maps the four states to glyphs (`STATUS_GREEN/YELLOW/ORANGE/RED`). Rate limits use four levels at 50/75/95% (README "4-Level Rate Limit Colors").
2. Five `COLOR_THEME` values: `default`, `minimal`, `vibrant`, `monochrome`, `nerd` (`modules/utils.sh:223-330` `apply_theme`). A theme fills unset glyph variables only: `minimal` = `◦ ◦ ◦ ●` and `→ ◐ ⎇ ◈`, `vibrant` = `💚💛🧡❤️` and `📂 🎯 🔀 🧠`, `monochrome` = `[OK] [~~] [!!] [XX]` and `DIR: CTX: GIT: AI:`. Users override any variable in `barista.conf`.
3. Not applicable (no SGR); `NO_COLOR=1` only affects the config TUI (`lib/config-tui.sh:11`). `--no-color` install flag.
4. Not present (text/emoji only).
5. `SEPARATOR` string from config; no colours.
6. Separators only.
7. `monochrome` is the terminal-agnostic mode; nothing detects light/dark.
8. Emoji by default, Nerd Font theme (`nerd`), full ASCII (`monochrome`), `USE_ICONS`, progress bar chars per theme (`▪·`, `▓░`).
9. `barista config` TUI to pick modules/theme, `--set`/`--toggle`; ~30 modules (cpu, battery, docker, weather...).
10. `barista.conf` shell variables, `barista config`.

## battery
https://github.com/allthingsclaude/battery — 26 stars.
not a Claude statusline: a macOS menu-bar app (plus iOS/Android apps) showing rate-limit gauges; it has its own "claude" and "classic multi-color" app themes (README). Only integration with Claude Code is a hook (`Hooks/battery-hook.sh`) for session detection.

## bartleby/claude-statusline
https://github.com/bartleby/claude-statusline — 26 stars.
1. Theme role map: each theme sets ten role variables `C_MODEL C_DIR C_BRANCH C_DIRTY C_BAR C_BAR_E C_TXT C_SEP C_OK C_WARN C_HIGH` (`themes.sh:8-22`), applied to fixed segments in `context-bar.sh:207-211`: model `C_MODEL`+bold, directory `C_DIR`, branch `C_BRANCH`, clean `C_OK ✓` / dirty `C_DIRTY`, lines `+n` `C_OK` and `-n` `C_WARN`, cost and time `C_OK`. States: rate-limit bars `<50 C_OK, <80 C_WARN, else C_HIGH` (137); context bar `C_BAR`, `>= 70 C_WARN`, `>= 90 C_HIGH` (201-202).
2. 21 bundled themes (README; 21 `theme_*` functions in `themes.sh`): kratos (default), spiderman, captain, shadow, ocean, goose, matrix, sakura, aurora, ember, frost, odi, cyberpunk, lavender, gold, inferno, amethyst, bubblegum, venom, ... Format is the role map above plus a 3-row block-character mascot logo coloured cell by cell. `/skin <name>` switches (`claude-skin.sh`); users can edit `themes.sh`, no user-theme loader. Windows port in `windows/themes.py`.
3. xterm-256 only (about 1,270 `38;5;n` literals). No truecolor, no depth detection, no NO_COLOR.
4. Foreground only.
5. A single `│` in `C_SEP` (`context-bar.sh:158`), wall glyphs `▏▕` in 237 around the logo (161-163).
6. Separators only; role hue per field.
7. Not present; palettes are chosen per theme, no polarity detection.
8. Block glyph logo, bar `▓` / `░`, few emoji.
9. Themed mascot logo (3 rows of `▐▛███▜▌`-style glyphs, e.g. kratos has a red accent on the right edge only, `themes.sh:20-23`); pop-culture themes.
10. `/skin` slash command; install via `install.sh` / `install.ps1`.

## tkm (tokenmon)
https://github.com/ThunderConch/tkm — 26 stars.
1. A Pokemon-collecting game rendered in the statusline; colour is mostly the sprite art. Text styling is small and by state: HP bar green when > 50%, yellow > 20%, else red, empty part gray `\x1b[90m` (`src/status-line.ts:288-294`); status tags `[BRN]` red, `[PSN]`/`[TOX]` magenta, `[PRZ]`/`[SLP]` yellow, `[FRZ]` cyan (371-377); weather particles coloured by condition (rain blue, thunderstorm yellow, snow bright white, fog gray, clear bright yellow; 182-189).
2. No themes. Shiny Pokemon get a hue-shifted sprite (`shiftAnsiHue`, 10, 92).
3. ANSI-16 for the text above; sprite files carry their own colours (loaded from `SPRITES_BRAILLE_DIR` / `SPRITES_TERMINAL_DIR`, 81-95; format not read). No NO_COLOR.
4. Sprites are braille characters (U+2800 block) in fg colour; HP bars fg-only.
5. Not present.
6. Not present (art).
7. Not present.
8. Braille sprites (padding with U+2800), emoji, and optional terminal-graphics renderers (kitty / sixel / iTerm2) picked by `detect-renderer.ts` from `TERM`/`TERM_PROGRAM`; VS Code forced to braille.
9. Battle mode with two sprites side by side, weather particles over the sprite, shiny hue shift.
10. i18n locale; CLI `tokenmon`; setup in `src/setup/setup-statusline.ts`.

## ui-themes
https://github.com/yugal1107/ui-themes — 26 stars.
1. A theme role map applied to fixed segments, plus thresholds. `statusline/statusline.sh`: defaults at 55-67 (`C_BADGE` Claude orange bold, `C_DIR` cream, `C_GIT` sage, `C_DIRTY` honey, `C_LABEL`, `C_MUTED`, `C_OK`, `C_WARN`, `C_HOT`, `C_SEP`), each overridden from the active theme file's `statusline.*` keys (74-85). Context % and the 5h/7d/spend chips use `level_color`: >= 80 `C_HOT`, >= 50 `C_WARN`, else `C_OK` (89-93, 126-132). Model colour by family: theme keys `modelOpus/Sonnet/Haiku/Fable` (151-159) with their own icons (opus diamond, sonnet feather, haiku bolt, fable book; 142-148).
2. Three bundled themes `claude-warm` (default), `night-blue`, `titanium` (`themes/*.json`). Format: JSON with a `statusline` role map (model, dir, git, dirty, label, muted, ok, warn, hot, sep, modelOpus/Sonnet/Haiku/Fable), plus `prompt.bg`, `reply.bg` and a `markdown` section that colours Claude Code's whole UI (README). Drop a JSON file in `~/.claude/ui-themes/` and write its name in `active` (`statusline.sh:75-80`).
3. 256 index (`c 141`, `c 237`) and truecolor via `hex_fg` from the hex in the JSON (71-73). No downsampling, no NO_COLOR.
4. Foreground only ("text coloured by usage level (no background)", comment line 114).
5. `·` in `C_SEP` (`DOT`, 85).
6. Separators only; hue by role.
7. Not detected; each theme is authored for the dark UI it also sets (`prompt.bg`/`reply.bg`).
8. Nerd Font icons for model family, 5h/7d (`󰙺`); no ASCII fallback.
9. `/ui-theme` command switches the status line and the reply boxes/markdown together; right-aligns limits when the width allows (`statusline.sh:155-165`).
10. JSON theme files + `/ui-theme` + the `active` file.

## claude-dashboard
https://github.com/JonImmsWordpressDev/claude-dashboard — 24 stars.
Mainly a local web dashboard (`server.js`); its statusline is the one-line subcommand `claude-dashboard statusline` (`lib/statusline.js`, 82 lines).
1. Almost uncoloured. Only two styles: amber `\x1b[33m` for "needs attention" parts (sessions waiting on you, context >= 70%, a limit forecast with a hit-time) and dim `\x1b[2m` for cost and the ` · ` separator (`statusline.js:9-11, 20-60`). Model name, 5h and week percentages are plain.
2. Not present.
3. ANSI-16 yellow and SGR dim. `formatStatusline(input, state, { color = true })` takes a colour switch (line 20) but nothing in the CLI wires NO_COLOR to it (`bin/claude-dashboard.js` calls `runStatusline()` directly).
4. Foreground only.
5. Dim ` · `.
6. Separators only.
7. Not present.
8. A `❯` prefix on the waiting-sessions part; otherwise text.
9. The statusline reads the dashboard's `/api/state` (port 4517) for a limit forecast; the web UI styling is separate and not covered here.
10. Env `CLAUDE_DASH_PORT`; no style config.

## claude-limitline
https://github.com/tylergraydev/claude-limitline — 24 stars.
1. Fixed per segment (bg + fg pairs), recoloured by state. `src/themes/index.ts` interface `ColorTheme` has ten slots (`directory`, `git`, `model`, `block`, `weekly`, `opus`, `sonnet`, `context`, `warning`, `critical`). Dark theme (lines 54-65): directory `#8b4513`/white, git `#404040`, model `#2d2d2d`, block `#2a2a2a` + fg `#87ceeb`, weekly `#1a1a1a` + `#98fb98`, opus fg `#c792ea`, sonnet fg `#89ddff`, context `#2a2a2a`, warning `#d75f00`, critical `#af0000`. State: `getColorsForPercent` (`src/renderer.ts:127-136`) replaces the segment's whole bg+fg with the theme's `warning` at >= `budget.warningThreshold` (default 80) and `critical` at >= 100.
2. Six bundled themes: `dark`, `light`, `nord`, `gruvbox`, `tokyo-night`, `rose-pine` (`themes` map at the end of `themes/index.ts`); semantic-per-segment map; `theme` is a name in config (default `dark`, `config/types.ts:100`). No user-defined themes found.
3. Hex in the theme, converted to xterm-256 only (`hexToAnsi256`, `themes/index.ts:21-41`; `ansi.fg/bg` emit `38;5;n` / `48;5;n`). No truecolor, no detection, no NO_COLOR.
4. Background-filled cells, white or tinted fg.
5. Powerline arrows: ``; arrow fg = this bg, arrow bg = next bg; last arrow fg-only (`renderer.ts:138-165`). Right-hand segments use left arrows `` (`renderRightPowerline`, 167-184). Text fallback: `renderFallback` draws bg-filled cells joined by `|` (`TEXT_SYMBOLS`, `utils/constants.ts:28-41`), used when `useNerdFonts` is false (renderer 486-495). Config lists `style: "powerline" | "minimal" | "capsule"` (`config/types.ts:38`); I found no capsule/minimal branch in the renderer, so those are unverified.
6. Fixed bg per segment (dark theme: a warm brown, then four steps of grey), so neighbours differ by hue/lightness and arrows join them.
7. Light theme exists (`lightTheme`: `#ff6b47`, `#4fb3d9`, `#87ceeb` with black fg) but is selected by name, not detected.
8. Nerd Font arrows/branch (`utils/constants.ts:2-9`), geometric symbols (`✱ ◫ ○ ◈ ◇ ▲`) per segment; ASCII set when `useNerdFonts` is false.
9. A theme-preview image `imgs/themes-preview.png` and `theme-demo.mjs` / `demo-modes.mjs`; progress bar `█░` or `#-`.
10. JSON config (`loadConfig`, `config/loader.ts:37-39`: `.claude-limitline.json` in cwd first, other paths follow); options for segment order, display style text/bar, nerd fonts, warning threshold.

## statusline-bar
https://github.com/Dworf/statusline-bar — 23 stars. One 3,957-line bash file.
1. Theme role + threshold per token. A theme has five colours (`good`, `warn`, `crit`, `dim`, `accent`) plus a `bar_style` (`THEMES_JSON`, `statusline-bar.sh:14-37`). `_threshold_color` (1483-1551) maps each token to a role: `context`/`rl_5h`/`rl_7d` >= 90 crit, >= 70 warn, else good; `context_remaining` < 10 crit, < 30 warn; `battery` < 20 crit, < 50 warn; `cache_hit` < 40 crit, < 70 warn (inverted); `memory` >= 95 crit, >= 80 warn; `lines_added` always good, `lines_removed` always crit; `cache_warm` true good / false crit; `cache_expires` < 120 s crit, < 600 s warn; `cache_misses` always warn; everything else (model, cost, git, directory, ...) gets `accent`. So colour is by theme role and state, never fixed per token identity.
2. 21 bundled themes in three groups (`_THEMES`, 2129-2135): adaptive `default`, `solarized`, `graphite`; light `light`, `solarized-light`, `catppuccin-latte`, `tokyo-day`, `ayu-light`, `garden`; dark `dark`, `dracula`, `nord`, `gruvbox`, `tokyo-night`, `catppuccin`, `one-dark`, `rose-pine`, `monokai`, `mocha`, `silver`, `ocean`. Semantic roles as above; `default`'s accent is empty (terminal default); `graphite` uses bold/dim/normal only. No user-defined themes (the theme table is embedded); users pick one, and per-token overrides cover prefix, format, bar style, separator but not colour.
3. Truecolor, 256 and 16 chosen by detection: `NO_COLOR` -> none; `COLORTERM=truecolor|24bit` -> truecolor; else `tput colors` >= 256 -> 256 (hex mapped to the xterm cube, `_hex_to_256`), >= 8 -> 16 (`detect_color_depth` 474-486; `color_fg` 540-558). At depth 16 every colour collapses to plain white `\033[37m` (555), so the roles disappear. `--no-color` flag; `_DEPTH` pin `auto|truecolor|256|16|none` in the wizard (2141).
4. Foreground only (no `48;` backgrounds anywhere).
5. Eighteen text separators selectable (`SEPARATORS_JSON`: space, pipe, slash, dot, vbar, dash, bullet, diamond, arrow, tri, star, sparkle, gear, check, heart, music, plus Nerd Font powerline `chevron`, `slant`, `chevron_thin`); used as characters, with no colour transitions.
6. Separators only; roles recolour value, but all neighbours at "good" read the same.
7. Strong: six light themes, three adaptive, and a screenshot of the same preset under dark and light (README); `default`/`solarized`/`graphite` described as working on either. Text contrast is hand-chosen per theme, not computed.
8. 49 tokens, prefix styles (`none label emoji nerd ascii emoji+label label+emoji nerd+label`), Nerd Font detection by `fc-list` / font-directory search (`detect_nerd_font` 488-515).
9. 12 progress-bar styles (blocks, heavy, line, braille, dots, arrows, ascii, plus five "gradient" bars; these are eighth-block partial fills, not colour gradients: `render_bar` 690-720), 12 presets, a TUI wizard with a live preview and swatches of each theme (2234-2265), JSON config with a shipped schema, screenshots gallery in `screenshots/`.
10. JSON config (schema shipped), `--preset`, `--theme`, `--no-color`, `themes` listing (`3778`), TUI wizard; env `NO_COLOR`, `COLORTERM`.

## felipeelias/claude-statusline
https://github.com/felipeelias/claude-statusline — 23 stars. Go.
1. Per-module style strings (Starship syntax) with threshold overrides. The module list is fixed in the format (`$directory $git_branch $model $cost $context`); each module has `Style` and optional `Thresholds` (`{Above, Style}`) that REPLACE the style (`internal/config/themes.go` `powerlineConfig`, 100-176): cost warns > $1.00 and context/usage have warn/high steps; the threshold style keeps the segment bg and changes only fg (`segStyle(thresholds.warn, colors[4])`). Minimal preset: directory blue, branch cyan, model bold, cost green, context green (`themes.go:51-66`).
2. Six built-in presets: `default`, `minimal`, `pastel-powerline`, `tokyo-night`, `gruvbox-rainbow`, `catppuccin` (`builtinPresets`, 37-44). A preset is a full Config (format string + per-module style), based on Starship presets; each powerline preset has a 5-colour array by module slot (e.g. pastel `#DA627D #FCA17D #86BBD8 #06969A #33658A`, catppuccin `#fab387 #f9e2af #a6e3a1 #74c7ec #b4befe`) plus a single text colour and warn/high colours. Users override anything in TOML-style config; `cli/themes.go` lists presets.
3. Style grammar (`internal/style/style.go`): named ANSI-16 (`red`...), 0-255 index (`fg:208`), `#RRGGBB` truecolor, `bg:`, `bold/dim/italic/underline`. No depth detection or downsampling; no NO_COLOR found.
4. Both: powerline presets bg-filled; minimal fg-only.
5. Starship-style `[text](fg:X bg:Y)` segments in the format string, so the author writes each transition by hand. Presets use a left half-circle cap ``, right arrows `` or right caps ``, with arrow fg = left segment bg and arrow bg = right segment bg (`capsuleFormat`, 67-82). Tokyo Night adds a leading `░▒▓` fade and rounded caps throughout.
6. By slot position: the five bg colours go in module order (pink -> peach -> light blue -> teal -> dark blue); Tokyo Night and Gruvbox use lightness steps of one hue family. Text colour is one value for the whole preset.
7. Text colour is chosen per preset by hand (empty = terminal default for pastel-powerline, `#e3e5e5` Tokyo Night, `#11111b` Catppuccin on pastel bgs).
8. Nerd Font glyphs (branch ``, worktree ``, arrows, caps); bar glyph presets `classic` etc. (`modules/helpers.go:57-80`); ASCII option not found.
9. Context bar with threshold markers (`BarMarkers`, a glyph at 80/90% in warn/high colours); OSC 8 hyperlinks (`modules/hyperlink.go`, directory links to `file://`).
10. TOML/Go-template config with `format`, per-module `format`/`style`; CLI `themes`/preset selection.

## claudemods
https://github.com/Jhonatan-de-Souza/ClaudeMods — 23 stars.
Two parts: `statusline/statusline.py` (a statusline) and `plugins/extra-mods/` (Claude Code mods: terminal palette tools, zen/rainbow effects) which are not a statusline.
1. Statusline (`statusline.py`, 241 lines): `color_for(pct)` >= 90 red, >= 70 yellow, else green (40-45) for the context bar and the 5h/7d bars (208-232); model `CYAN`, branch `GREEN`, directory plain, labels gray 244, cache dot green `●` "cache ok" / red `●` "cache over" (131-143). Percent numbers bold in the state colour (`num`, 53-54).
2. No themes in the statusline. The mods plugin has a terminal palette converter (`hooks/lib/palette.ts`: terminalcolors.com YAML in, Windows Terminal schemes and OSC sequences out) — unrelated to the bar.
3. ANSI-16 (`\033[32m` etc.) plus two xterm-256 greys: `GRAY 38;5;244`, `TRACK 38;5;238` (the file's comment says grays replace "dim", which is too faint in many themes, lines 22-24). No NO_COLOR.
4. Foreground only.
5. Dim-gray `│` between stats (`SEPS`, 26) and ` · ` on line 1.
6. Separators only.
7. Only the 256-gray choice to stay legible; no detection.
8. Block bar `█░`; no icons.
9. Three detail levels per segment, so narrow terminals drop to shorter segments and wrap (`layout`, 146-168).
10. Edit script; `windows` handling in-script (stdin/stdout reconfigured to UTF-8).

## claude-code-flow
https://github.com/kaisa-kucherenko/claude-code-flow — 23 stars.
1. Statusline (`statusline/statusline.sh`, 125 lines; header "Minimal: muted grays, color only for context %"): model in lavender `[Sonnet | effort]` (xterm 183), output-style bracket steel blue (110), path/branch dim; context % is a traffic light < 30 green (78), < 40 yellow (221), else red (203) (93-105); 5h/7d use `usage_color` < 70 green, < 90 amber (214), else red (108-123).
2. Per persona plugin: `plugins/richmond/` and `plugins/witcher/` each ship their own `persona/statusline.sh` (witcher: old gold 179, steel 109, silver 251, model 110, style 140; lines 32-38) and Claude Code UI themes (`themes/*.json` — `diamond-dogs`, `nelson-road`, `corvo-bianco`, `kaer-morhen`) which override Claude Code's own token colours (`claude`, `text`, `permission`, `diffAdded`, `userMessageBackground`, ... on a `"base": "dark"`). Those themes do not colour the statusline.
3. xterm-256 deliberately: "Claude Code force-dims the statusline, and 16-color codes come out olive/washed on top of that; explicit 256-color foregrounds survive the dimming (see claude-code issue #42382)" (`statusline.sh:70-72`). That is a real fact about how Claude Code renders the line. No NO_COLOR.
4. Foreground only.
5. ` | ` in dim white.
6. Separators only.
7. Hand-picked 256 values chosen to survive Claude Code's dimming; no detection.
8. `⎇` for branch, brackets; no emoji.
9. Persona statuslines (witcher/richmond), sound/timer scripts. Not styling.
10. Edit script / install a persona plugin.

## cc-chips
https://github.com/roger-me/CC-CHIPS — 23 stars.
1. Fixed per chip POSITION, themed: three chips (left = directory, middle = git branch, right = model + context bar), each with a bg + text colour pair defined in the theme (`themes/*.sh`; `engine.sh:319-336`). Left chip is the first colour, middle the second, right the third. Plus state: the usage bars below use fixed green/orange/red by percentage: < 50 `0,160,0`, < 80 `255,176,85`, else `255,85,85`, empty `80,80,80` (`engine.sh:221-226`). The context bar inside the right chip is plain text in the chip's colour.
2. Four bundled themes as shell files, `claude` (terracotta and white: `#2D2E29`/`#C6613F`, `#FFFFFF`/`#2E3440`, `#C6613F`/`#FFFFFF`), `cool` (`#008BB7` white / `#273227` `#00DB00` / `#FF4D00` white), `retro` (`#C41665` / `#E2E0E5` / `#9CC02A`), `cyber` (yellow `#FFF700` black text / teal `#132831` text `#64CCC2` / crimson `#46151F` text `#F7504A`). Format: three (bg, fg-of-bg, text) triples as SGR strings (`themes/cyber.sh`). Pick with `CC_CHIPS_THEME` (`engine.sh:4-16`); users add a file.
3. Truecolor SGR everywhere (`38;2`, `48;2`). No detection or downsampling, no NO_COLOR.
4. Background-filled "chips" with rounded caps, text in a third colour.
5. Rounded half-circle caps `` / `` (`CAP_LEFT`, `CAP_RIGHT`): each cap is drawn with fg = the chip's bg colour on the terminal's own background (`engine.sh:319-336`). No inter-chip arrows; chips sit apart.
6. Different hue per chip, with a space between; the middle chip is a contrast of the other two in every theme (dark on light or light on dark).
7. Each theme hand-pairs text to bg; no detection.
8. Nerd Font required (folder, github, branch, space-invaders-brain icons; `engine.sh:25-32`). No fallback.
9. Two extra rows of usage bars (`●` / `○`) for the current and weekly windows with reset times.
10. Env var `CC_CHIPS_THEME`; theme shell files.

## claude-2x-statusline
https://github.com/Nadav-Fux/claude-2x-statusline — 22 stars. Engines in bash, node and python mirror each other (`engines/`).
1. Fixed per segment with thresholds (node engine, `engines/node-engine.js`): model blue (600), agent / tasks / LOCAL cyan (627, 700, 744), cost magenta (730), REMOTE magenta, duration blue (732), diff blue dim (725), effort dots purple `178,148,255` (880). Bars `colorPct` (204-207): >= 80 red, >= 50 yellow, else green; weekly windows warn earlier (>= 75 red, >= 45 yellow). Peak-hours / update notices are filled badges: `BG_GREEN 38;5;255;48;5;28`, `BG_YELLOW 16 on 220`, `BG_RED 255 on 124`, `BG_BLUE`, `BG_GRAY 236` (27-31); the peak badge goes green/yellow/red by minutes left (bash engine 360-362).
2. No themes; three display "tiers" (minimal / standard / full) that change content, not colour (`assets/tier-*.svg`, README).
3. ANSI-16 plus a few 256 and truecolor literals (20-31). No depth detection, no NO_COLOR found.
4. Mostly foreground; backgrounds only for the peak-hours and update badges.
5. Plain `│` in dim (bash engine 304).
6. Separators only; hue by role.
7. Not present.
8. Emoji and block glyphs (`▰▱` bars, `◔`, `⚙`, `⚒`), no Nerd Font, no ASCII mode.
9. Peak-hours indicator pulled from a remote JSON (auto-updating schedule), burn-rate, narrator hook; a web tier picker at statusline.nvision.me.
10. `config.example.json`; `/statusline-tier` command; engines auto-detected.

## tmux-ccusage
https://github.com/recca0120/tmux-ccusage — 22 stars.
not a Claude statusline: a tmux plugin that prints ccusage cost totals into the tmux status bar (`scripts/formatter.sh`). For reference: tmux `#[fg=green|yellow|red]` by percent of a configured subscription (warn 80, critical 95; lines 116-157), switched off with `CCUSAGE_ENABLE_COLORS`; Dracula-theme glue in `scripts/dracula-ccusage.sh`.

## cc-foundry (the-statusline plugin)
https://github.com/xobotyi/cc-foundry — 22 stars. A plugin marketplace; the statusline is `plugins/the-statusline/statusline.js` (624 lines). The scanner's `theme` hits are from an unrelated Tailwind doc.
1. Fixed per segment plus a graded urgency ramp. Fixed pastel xterm-256 colours (`statusline.js:89-97`): output style green (151), engine yellow (223), directory blue (153), branch cyan (152), `+added` green / `−removed` red (174), cost magenta (182), separators and tags gray (245) (uses at 250-253, 443, 453, 593-607). State: `colorByUrgency(remaining%)` for context-left and the nearest rate-limit window: >= 60 gray 245, 50-59 light gray 251, 40-49 pale yellow 228, 30-39 yellow 220, 20-29 orange 208, 10-19 red 196, < 10 red-pink 197 (106-125; comment "Luminosity rises with urgency"). Note it keys on remaining, not used.
2. Not present.
3. xterm-256 only (`ansi256`, 75-77). No depth detection, no NO_COLOR.
4. Foreground only.
5. Gray ` | ` between the two halves of row 1 and ` · ` within them (561-569).
6. Separators only.
7. Pastel mid-tone colours chosen to read on either; no detection.
8. No icons seen in this file.
9. Width-adaptive rows: five degradation levels per row drop style/effort/reset/cost, then lines, then shorten the branch (`ROW1_LEVELS`, `ROW2_LEVELS`, 39-60).
10. Plugin hooks sync the statusline setting (`hooks/sync-statusline.js`); no style config in the script.

## benabraham/claude-code-status-line
https://github.com/benabraham/claude-code-status-line — 21 stars. One 2,554-line Python script.
1. Theme role map applied to fixed segments, with a threshold gradient. `THEMES` (`claude-code-status-line.py:225+`): model badges by family with (bg, fg) (`model_sonnet` Nord green `#A3BE8C`, `model_opus` frost `#88C0D0`, `model_haiku` `#4C566A`, `model_fable` red `#BF616A`, `model_default` `#D8DEE9`; 228-232), text colours per segment (`text_percent`, `text_numbers`, `text_cwd`, `text_git`, `text_na`, `text_added_dirs`, `text_worktree`, `text_cost`; 236-243), usage-pace colours `usage_light/green/yellow/red` (245-248). The bar fill follows a 10-step gradient list keyed by percent, `(threshold, (hex, fallback_256))`, from dark green at 0-9% through olive and orange to red at 90-100% (251-262; looked up at 486). Each colour is a pair: truecolor hex plus a hand-picked 256 fallback.
2. Two bundled themes, `dark` (Nord palette) and `light`. User-defined: a TOML file `~/.claude/claude-code-theme.toml` (`THEME_FILE`, line 67) loaded by `_load_custom_theme` (307-410), whose keys override the base theme; model badges as `["bg_hex","fg_hex"]`, simple colours as hex, text colours, and the `gradient` as `[{threshold, color}]`; registered as `"custom"`.
3. Truecolor when `COLORTERM` is `truecolor`/`24bit`, otherwise the 256 fallback stored with each colour (`supports_truecolor` 420-426, `_color` 436-443); user hex values get their 256 form by `hex_to_256` (199). No NO_COLOR.
4. Both: model badge is bg + fg; the rest is foreground.
5. Plain text separators; I found only a `" • "` option for the added-dirs list (line 107). No powerline.
6. Separators only; roles differ by hue.
7. Manual `THEME=dark|light` (or `SL_THEME`), with a separate light palette and explicit fg for each badge (e.g. light `model_fable` white text on `#A8505A`, line 272). Not auto-detected (the `termios` use is for the interactive setup, not for querying the background).
8. Emoji/Unicode glyphs; I did not check for a Nerd Font mode.
9. A plugin API: `register(api)` files add segments with `api.fg/bg/text_color` (1795-1811); a demo mode to preview the gradient (2161); a `DUMP` input debug option; 15 selectable segments in any order via `SL_SEGMENTS` (93-94).
10. Environment variables with `SL_` prefix for everything (`_env_str`, 46-58), a TOML theme file, plugins, an interactive setup flow.

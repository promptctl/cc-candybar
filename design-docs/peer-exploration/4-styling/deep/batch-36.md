# Batch 36: styling read from source

Anchors are `path:line` or `path:key` in the project's own repo (raw files read at HEAD, 2026-10-24).

## anpluto/cc-statusline-themes
URL: https://github.com/anpluto/cc-statusline-themes — stars: 0
1. Colour is fixed per segment, written in each theme file. `themes/minimal.js`: model=cyan, git branch=green (suffix dot: conflict red `✖` / dirty yellow `●` / clean green `✓`), context %=magenta. `themes/emoji-line.js`: model+window=brightCyan, effort=brightMagenta, output style=brightGreen, branch=brightGreen with a state dot (conflict brightRed / dirty brightYellow / clean brightBlue), context icon brightYellow with % brightMagenta. `themes/powerline.js`: by position, one bg per segment: model bgBrightBlack/fg brightCyan, branch bgBlue/brightWhite, context bgGreen/black, cost bgMagenta/brightWhite. No thresholds on context; only the git dot is state-driven.
2. Four themes are bundled, one JS file each in `themes/`: `powerline`, `bracket-panel`, `emoji-line` (default, `lib/themes.js` DEFAULT_THEME), `minimal`. A theme is a JS module (`segments[]` with `when`, `parts[{text,color}]`, `bg`, `fg`, `icon`, `iconColor`, `separator`, `separatorColor`, `wrap`), not a semantic palette. Users add a theme by dropping a `.js` file in `themes/` (`listThemes()` reads the directory); chosen via an `active` file, `switch.js`/`pick.js`.
3. Colour spec is a name looked up in `lib/palette.js` NAMED (ANSI 16 plus bright variants and bgX forms), a numeric SGR/256 string like `'38;5;213'`, or a raw ANSI escape (`code()`). No truecolor path in the palette (one truecolor line elsewhere). No depth detection, no NO_COLOR (`not present`).
4. Both: powerline theme is background-filled cells; the other three are foreground-only text.
5. Powerline: `lib/engine.js renderPowerline` (lines 88-104) draws the arrow `theme.powerlineArrow` (default U+E0B0) with fg = this cell's bg and bg = next cell's bg; the last block ends with a reset. Other themes use a text separator (`' | '`, two spaces) painted `dim` (`separatorColor`).
6. Neighbours differ by a different bg hue per segment (powerline) or by different fg hues plus emoji (others). Separators are secondary.
7. No light/dark adaptation. Powerline picks fg per segment by hand (black on bgGreen, brightWhite on bgBlue/bgMagenta). `engine.js:97` falls back to black text when fg is missing.
8. Nerd Font required for powerline (comment in `themes/powerline.js`, tofu otherwise); emoji icons in `emoji-line` and `bracket-panel`; `minimal` is plain.
9. Notable: CJK greeting text and a time-of-day greeting in `bracket-panel` (`TEXTS.greetings`); auto-wrap to terminal width (`wrap: 'auto'`, `wrapSegments`). Comment in engine: painting inner parts in powerline mode inserts resets that wipe the bg, so powerline segments take colour only from the segment's bg/fg.
10. Customisation: edit or add JS theme files; switch with `switch.js`/`pick.js` (interactive picker) writing the `active` file; `CCSL_ACTIVE_FILE` env overrides the file location (`lib/themes.js:21`).

## antrvan746/pomodoro-cli
URL: https://github.com/antrvan746/pomodoro-cli — stars: 0
Not mainly a statusline: a Go pomodoro timer whose `StatusSegment` (`internal/ui/statusline.go`) is installed into Claude Code's `statusLine` by `internal/cli/integrations.go` (also tmux and cmux). Only that segment is styled here.
1. Colour comes from the phase of the timer, by theme role. `StopsFor(kind)` returns `cur.Focus` / `cur.Short` / `cur.Long` gradient stops; the clock text uses `AccentFor(kind)` (FocusAccent/ShortAccent/LongAccent); the bar is `SubBar` with a Lab gradient across the stops; unfilled cells and the frame use `Subtle`; paused state fades the stops 50% toward `Track` (`Fade`) and sets the clock to `Muted`. Cycle dots take a gradient of `LogoStops`. No per-Claude-segment colours.
2. `internal/ui/theme.go`: a `Theme` struct of semantic roles (Text, Muted, Subtle, Track, Border, Empty, Focus/Short/Long gradients, Heat[4], Logo, FocusAccent..., Highlight, Key, Danger, PillText). Bundled `mocha`, `latte`, `ember`, `sand`, plus alias `catppuccin`/`auto` that chooses mocha or latte via `lipgloss.HasDarkBackground()`. Selected with the `theme` config key (`internal/cli/config.go:55`); users cannot define new themes (the map is compiled in).
3. Hex truecolor via lipgloss; `integrations.go:39-40` forces `termenv.TrueColor` unless `NO_COLOR` is set; `cli.go:186-189` honours COLORTERM=truecolor/24bit even when piped. NO_COLOR honoured.
4. Foreground only for the statusline segment. `Pill()` (bg-filled, `PillText` on a coloured bg) exists for the TUI, not the statusline.
5. Spaces between parts (`strings.Join(parts, " ")`); bar uses `▕ ▏` frame characters. No powerline.
6. Not applicable (one segment): parts differ by role colour (accent clock, gradient bar, `Subtle` frame).
7. Yes: `catppuccin`/`auto` picks the dark or light theme (`resolveTheme`), and each theme has a designed `PillText` for contrast ("Themes are explicit rather than adaptive so text contrast is designed together with the accents", `theme.go` comment). Detection runs from the process that renders.
8. Emoji per phase (`IconFor`: 🍅 ☕ 🌙, ⏸ paused); block/eighth glyphs `▏▎▍▌▋▊▉█`, `●○` dots. No Nerd Font, no ASCII mode seen.
9. Gradients in Lab space (go-colorful `BlendLab`), `GradientText`, a breathing animation (`internal/breath`, `ui/breathe.go`), theme screenshots in `docs/assets/theme-*.png`, a `pomo theme` swatch command.
10. Config via `pomo config` keys (`theme`, `statusline_view` = minimal/classic/full); `pomo` installs into settings.json.

## anupm-sinha/PRISM
URL: https://github.com/anupm-sinha/PRISM — stars: 0
1. Role-based: each theme assigns RGB to roles (`prism.mjs:89-120`). Model name = `model`, brand glyph = `brand`, branch = `branch`, cost = `cost`, diff add/del = `add`/`del`, times = `time`, version dot = healthy/warn. Context bar = gradient `ctxFrom`→`ctxTo` (neon: purple→magenta) while the percentage beside it is thresholded: `thresholdRgb` (line 502) healthy < warn < crit; context warn 70 / crit 90, rate limits 60 / 80 (`DEFAULTS.thresholds`, `rateThresholds`). Effort level has its own 5-step colour map (`effort.low..max`). 5h and 7d bars use a single threshold colour (no gradient).
2. Three bundled themes in `THEMES`: `neon` (default), `spectrum`, `mono`. Format = flat object of RGB triples per role (frame, dim, faint, label, text, brand, model, ctxFrom, ctxTo, ctxEmpty, healthy, warn, crit, cost, branch, add, del, time, accent, effort{}). Users can only choose among the three through config (`theme`); defining new themes is `not present` in config (they would edit `prism.mjs`).
3. Truecolor only: `fg(rgb)` writes `38;2;r;g;b` (line 35). No depth detection or downsampling. NO_COLOR `not present` (grep found none).
4. Foreground only (no bg fills).
5. Rounded box frame (`tl tr bl br h v` glyphs `╭╮╰╯─│`) around a panel, `·` between items, bar caps: Nerd-font half-circle caps or `◖◗` / `▕▏` depending on `barStyle` (`pill|rounded|block|line`). Colours: caps take the bar's gradient start colour when filled, `ctxEmpty` otherwise.
6. Items separated by spacing (`cfg.spacing`, default 5 spaces) and by role hue; rows aligned optionally (`align`).
7. No light/dark adaptation. `mono` theme is the low-saturation option.
8. Three glyph sets `unicode` / `ascii` / `nerd` in `GLYPHS`, auto-picked by `resolveGlyphs`, override with `PRISM_GLYPHS` or `glyphs` config; `labels: "text"|"icon"`; a `--install-font` command installs CaskaydiaCove Nerd Font.
9. Per-character gradient text (`gradientText`), sub-cell partial blocks in `meter()`, bar styles, `--demo` renders all themes.
10. `prism.config.jsonc` (path via `PRISM_CONFIG`), keys theme, glyphs, labels, align, spacing, minWidth, barStyle, barWidth, thresholds, stats toggles; CLI flags `--demo`, `--install-font`; installer scripts.

## apsolut/clawcoat
URL: https://github.com/apsolut/clawcoat — stars: 0
Mostly a binary patcher that re-skins Claude Code's UI (brand colour, banner, spinner); it also ships a statusline script (`statusline.js`, embedded as `$StatuslineSource` in `install.ps1` ~line 2115). Both are described.
1. Statusline: one accent colour for the identity parts and traffic-light state colours for metrics. `model` and `git` = accent `acc` (taken from the active palette's `claude` colour); `effort`, `cwd`, `clock` = DIM; `ctx` = `sevUp`: ok green (120,200,120) / warn (230,160,40) from 65 / bad (222,60,60) from 85; `5h` = DIM until 60 then warn, bad from 85; hive "costume" parts (contain, tvirus, pwr) use `sevDown` (falling values bad). Meter filled part by severity, empty part `dimAcc` (accent at 45%). The UI itself: the palette sets the brand colour tokens (`claude`, `claudeShimmer`, ...) for everything Claude paints in its accent.
2. Bundled palettes (`_CLAW_BAKED`, install.ps1 ~1117): `clawcoat` (default), `yellow`, `violet`, `gruvbox`, `dracula`, `biohazard`, `neon`; each = 5 token colours plus an ANSI fallback name (`_clawP`). Users add palettes via `palettes` in `~/.clawcoat/clawcoat.json`; presets (`umbrella-corp`, `hive`, `cyberpunk`, `vaporwave`, `ghibli`, `party`) bundle theme + bar + other settings and can be saved by the user (`docs/THEMING.md`).
3. Truecolor `rgb(...)` for UI tokens, `38;2;` for the bar (`const C = (rgb) => \x1b[38;2;...`). No depth detection; NO_COLOR `not present`.
4. Foreground only in the bar.
5. Plain `│` by default; `barSep` config key sets the divider.
6. Neighbours differ by role colour/dim; no alternation.
7. Mostly no. Palette carries a "Light" variant for tokens (`claudeLight`), and `bg` sets a background hex for the whole UI (`docs/THEMING.md`).
8. Emoji/unicode (`✳` dirty mark, `█░`), the "costume" parts rename metrics (CONTAIN/T-VIRUS/PWR) with `barLabels`.
9. Notable: live animation of the brand colour (`animate none|breathe|pulse|wave|rainbow|neon|strobe|fire|ocean`, `_clawAnim`, HSL-driven with speed), "reactive" colour drivers (`project` hash of cwd, `clock` time of day, `danger`, `model` colour per Opus/Sonnet/Haiku/Fable, `git` main-branch warning, `dose` time-at-desk), per-model colours (`_clawReactive`), live hot-reload of the config on mtime change.
10. `~/.clawcoat/clawcoat.json` (edited by `claude theme ...` commands: `theme`, `animate`, `reactive`, `bar`, `bg`, `preset`, `edit`); installer flags `-StatuslineOff/-StatuslineOn`.

## apurwa/ghostty-tmux-claude-setup
URL: https://github.com/apurwa/ghostty-tmux-claude-setup — stars: 0
1. One calm colour for the whole line, heat colours only on rising metrics (`claude/statusline-command.sh`, palette block). Everything (labels, branch, cost, bullets) uses `TEXT`; only the percentage text and bar fill of 5h / 7d / ctx change: `heat()` returns calm below 60, `HEAT_WARN` 60-79, `HEAT_ALARM` 80+; the empty track uses `BAR_EMPTY`; over-pace arrow uses alarm heat. Comments say "the whole line is a single calm colour ... EXCEPT the heat tones". All segment aliases (MAROON, GREEN, RED...) are set to `$TEXT`.
2. `STATUSLINE_THEME` env picks one of five: `gruvbox-light` (default, calm=157;0;6 maroon), `gruvbox-dark`, `catppuccin` (mocha), `tokyonight`, `nord`. A theme is four RGB triples: calm text, warn, alarm, empty-track. Users add a `case` branch ("Add a theme by adding a case"). Docs include a themes image.
3. Truecolor `38;2;R;G;B`, bold on (`1;38;2`). No depth detection; NO_COLOR `not present`.
4. Foreground only.
5. Text separator ` › ` in the calm colour (`SEP`).
6. Not distinguished by hue at all; separators and line layout (rows) do the work.
7. Palette is designed per terminal background: light theme uses a coloured primary, dark themes use the theme's foreground colour; bold is used because "Claude Code dims the status line". No runtime detection.
8. Nerd Font icons written as octal escapes (folder, GitHub, clock, chip, PR) because private-use glyphs get mangled by editors; `glyph-test.sh` checks width; emoji avoided because they ignore ANSI colour and are two columns wide (header comment).
9. Burn-rate arrows (`↓ → ↑` with "cap ~4h") in the line; optional Codex usage row.
10. Env vars `STATUSLINE_THEME`, `STATUSLINE_CODEX`; edit the shell script.

## archer0302/dot-configs
URL: https://github.com/archer0302/dot-configs — stars: 0
Dotfiles repo (nvim, wezterm); only `claude/statusline-command.sh` is a Claude statusline.
1. By segment and threshold, 256-colour indexes: branch GREEN (108), path BLUE (110), model LILAC (146), effort GREY (245), separator `·` DARK (240). `tint()`: percent < 50 GREEN, < 80 AMBER (179), else RED (174), applied to context % and the 5h/7d usage numbers.
2. Themes: `not present` in the statusline (the kanagawa hits are the nvim colourscheme).
3. 256-colour `\033[38;5;Nm`; no detection, no NO_COLOR.
4. Foreground only.
5. Middle dot `·` in dark grey.
6. Hue per segment only.
7. `not present`.
8. No icons.
9. Nothing else notable.
10. Edit the script.

## architg25/cc-statusline (fork of Haleclipse/CCometixLine)
URL: https://github.com/architg25/cc-statusline — stars: 0
Differences from the parent, by `compare` (6 ahead, 87 behind): the styling code is the same. The only changes under `src/ui/themes/` are a rename of the `cometix` theme to `classic` (`theme_cometix` → `theme_classic`, `get_cometix` → `get_classic`, label "Classic theme", `src/ui/themes/presets.rs`, `mod.rs`) and replacing the project name in the preview text and the models.toml header (`src/ui/components/preview.rs`, `src/config/models.rs`). The other changes are packaging (npm platform packages, release workflow, README, CLAUDE.md, a deleted changelog). No new colour feature. Bundled themes are therefore the parent's: classic, default, minimal, gruvbox, nord, powerline-dark, powerline-light, powerline-rose-pine, powerline-tokyo-night.

## ardet696/claude-waybar
URL: https://github.com/Ardet696/claude-waybar — stars: 0
not a Claude statusline: a Waybar (Linux bar) module and GTK popup showing Claude Code session state. Its `bin/claude-waybar-statusline` only stashes the status JSON and prints nothing (or passes it to a previous statusLine command). For reference, Waybar output uses Pango spans with a Catppuccin Mocha palette hard-coded in `bin/claude-waybar` (`C` dict: blue, yellow, mauve, green...), state colours idle=blue / running=yellow / waiting=mauve, and a green→yellow→red `heat()` mix for a 10-cell `━` bar.

## armitagethird/ClaudeCodeHUD
URL: https://github.com/armitagethird/ClaudeCodeHUD — stars: 0 (Rust)
1. Roles by load level, no per-segment hue. `src/render.rs`: labels (`ctx`, `carga`) use `dim`; context bar and % use `load_color` (Leve=ok, Medio=warn, Alto=crit; thresholds `load_medio` 50 / `load_alto` 80); rate-limit % uses `pct_color`. Other segments (model, branch, cost, timer) are uncoloured text.
2. Themes: `not present`; only four colour slots in `[colors]`: `ok`, `warn`, `crit`, `dim` (`src/config.rs`), default 256-colour indexes 2/3/1/8.
3. 256-colour index `\x1b[38;5;{n}m` (`render.rs:117`). No depth detection. NO_COLOR honoured: `src/color.rs color_enabled()` is false when the variable is set.
4. Foreground only.
5. Configurable separator string, default `"  ·  "` (`config.rs`).
6. Plain separators; no colour distinction.
7. `not present`.
8. `ascii_mode = true` swaps the `▓░` bar for `[#----]`; no icons otherwise.
9. Portuguese labels; model-name mapping table.
10. `~/.claude/hud.toml` (or `$HUD_CONFIG`): `segments` order/enablement, `gauge_width`, `separator`, thresholds, `colors`, `model_names`.

## aron0628/claude-statusline
URL: https://github.com/aron0628/claude-statusline — stars: 0
1. Fixed per segment, ANSI 16 constants (`src/segments/registry.ts`): model = bold cyan, dir = yellow (line 88), git branch = magenta, cost = green, context = cyan (bar + %), 5h rate = magenta (label, bar, %), tokens = blue, effort / output style = dim label + white value, session name = blue. No threshold colouring in these segments; bars via `makeBar` (`src/render/ansi.ts`) with the colour passed in and a `GRAY` track.
2. `theme` is a string field in the config schema (`src/config/schema.ts:67`, default `"default16"` in `src/config/defaults.ts`); only that default is evident, no other bundled themes found. Treat further themes as `unverified`.
3. ANSI 16 names; a 256-colour escape only for the buddy sprite (`fg256`). NO_COLOR and `TERM=dumb` disable all colour (`colorsEnabled()` in `ansi.ts`). No depth detection.
4. Foreground only.
5. Config `separator`, default `" | "`.
6. Distinct fixed hues per segment plus separators.
7. `not present`.
8. Emoji/unicode glyphs; `█░` bars in `[ ]`.
9. A pixel-sprite "buddy" companion with rainbow/animation (`src/render/sprite.ts`, `src/buddy/`, 256-colour), responsive width dropping segments by `priority`.
10. JSON config (`src/config/loader.ts`): per-segment `enabled` and options, `order`, `priority`, `separator`, `theme`, `responsive`, `mode`, `buddy`.

## aryansidbatte/nice-claude-status-bar
URL: https://github.com/aryansidbatte/nice-claude-status-bar — stars: 0
1. Two-colour scheme from the theme: `C_TEAL` for glyph markers and `C_BLUE` for values, `C_GRAY` (245) for secondary text (`context-bar.sh`). Every segment does the same (`◆` model, `⎇` branch, `⧗` time, `⊛`, `▸` context %, `⚡` 5-hour usage...). No state or threshold colouring found.
2. 16 named themes via `THEME` in `context-bar.conf` (`set_theme`): teal (default), amber, rose, green, purple, mono, red, orange, yellow, cyan, blue, pink, lavender, mint, catppuccin-mocha, gruvbox. A theme = two colours; most are 256-colour indexes, the last two truecolor. Specs under `docs/superpowers/specs/` describe the design. Users edit the script to add one.
3. 256-colour indexes (`38;5;N`) plus truecolor for catppuccin-mocha and gruvbox. Colour is opt-in via `--color` flag (otherwise no colour at all). No depth detection or NO_COLOR.
4. Foreground only.
5. Text separator `"  |  "` in gray (`SEP`), `  ·  ` between usage items.
6. Two-colour accent pattern (marker vs value); no segment hues.
7. `mono` theme; no adaptation.
8. Unicode glyphs per segment; no Nerd Font.
9. Notable: marker/value two-tone as the whole design.
10. `context-bar.conf` sourced by the script (`THEME=...`), `--color` flag.

## aryateja2106/Lecoder-Claude-code-statusline
URL: https://github.com/aryateja2106/Lecoder-Claude-code-statusline — stars: 0
Two implementations: bash (`statusline/`) and Rust (`statusline-rs/`).
1. Fixed role colours from the theme struct. Rust `main.rs`: folder = blue, git branch = green with status mark ✓ green / ✗ yellow, model (with emoji) = cyan, lines added green / removed red, version = magenta, agent name = yellow, cost = yellow, context `Ctx: N%` thresholded green / yellow / red (config `warn_threshold`, `critical_threshold`), separator `│` dim. Session lists coloured by state (green active, yellow, red strikethrough `\x1b[9m`).
2. Themes in `statusline-rs/src/theme.rs`: `catppuccin` (default, Mocha truecolor), `classic` (ANSI 16/256), `garden` (pastels). The bash `lib/themes.sh` adds `ocean`, theme inheritance (base theme + hex overrides via `hex_to_ansi`), a `custom` theme with user colours (`Config.toml` `colors.basic.*`), and dynamic day/night themes. A theme is a struct of 14 named colour slots (red, blue, green, yellow, magenta, cyan, white, orange, light_gray, bright_green, purple, teal, gold, pink).
3. Truecolor (`38;2;`) for catppuccin and garden, ANSI 16/256 for classic. No downsampling by detection found in `theme.rs`; the bash side has `NO_COLOR` and 256-colour env checks (the scanner counted `env.NO_COLOR`, `env.256color`, `env.truecolor`); anchored only at the signal level, exact lines `unverified`.
4. Foreground only.
5. `│` separator in `dim`.
6. By hue per role only.
7. Time-of-day theme switching (not terminal detection): `get_dynamic_theme` (`themes.sh:~480`) returns `CONFIG_THEME_DYNAMIC_DAY_THEME` (default garden) or night theme (default catppuccin); day/night decided by clock, sunrise/sunset, or prayer times (`CONFIG_THEME_DYNAMIC_MODE`).
8. Emoji (model emoji, 📁), ✓/✗ marks.
9. Dynamic day/night themes and theme inheritance are the standout features.
10. `statusline/Config.toml` (`theme.name`, `colors.*`, dynamic and inheritance keys), Rust `config.rs`.

## aryayt/claude-statusline
URL: https://github.com/aryayt/claude-statusline — stars: 0
1. Fixed per segment, ANSI 16 (`bin/claude-statusline.sh`): directory = cyan (line 294), git branch = green with yellow `±` when dirty (307-309), model name = dim (370), label `[..]` = dim (269), session/info = dim (364). Context bar `ctx:[bar]N%`: green, yellow from 70, red from 85 (345-347).
2. Themes: `not present`.
3. ANSI 16 + dim/bold. NO_COLOR and `CSL_NO_COLOR` blank all colour variables (lines 35-38).
4. Foreground only.
5. `CSL_SEPARATOR` env overrides the separator; default plain text.
6. Hue per segment.
7. `not present`.
8. No icons.
9. Nothing else notable.
10. Env vars (`CSL_NO_COLOR`, `CSL_SEPARATOR`, `CSL_LABEL` seen), edit script, `scripts/shell/aliases.sh`.

## ascurse/claude-mods
URL: https://github.com/Ascurse/claude-mods — stars: 0
not a Claude statusline: a collection of Claude Code mods (plugins: agent-compact-advisor, agent-flow, crew, flightdeck, next-steps). Only `flightdeck` touches status: it draws a rounded-border panel and sets a one-line mod status via `$.ui.status` (`hooks/register.tsx:~132`, text `ctx 42% · agents 2/3 · denied 1`, uncoloured). Its panel palette is of interest: `core.ts:155-180` `PALETTES.theme` maps roles to Claude Code's own theme tokens (main=`claude`, agent=`suggestion`, gate=`success`, cleared=`permission`, arch=`merged`, amber=`warning`, warn=`error`, dim=`inactive`, faint=`subtle`, text=`text`) so it follows light, dark and colour-blind themes, with a `pastel` alternative of fixed hex (e.g. main #7dd3fc, amber #fcd34d, warn #fca5a5, faint #3f4654). Gauge fill uses `warn` at 80% and above, else `main`.

## avzolem/ccstatusline-config
URL: https://github.com/Avzolem/ccstatusline-config — stars: 0
A config for the `ccstatusline` tool (not its own renderer; plus a custom metrics script `ccstatusline-metrics.js`).
1. Fixed per segment, truecolor hex written in `ccstatusline-settings.json`, each segment with its emoji sharing the colour: dir `#79c0ff`, model `#79d9a0`, context % `#7ee787`, effort `#e3b341`, weekly usage `#56d4dd`, git branch (custom command) `#d2a8ff`, block timer `#8b949e`. No thresholds.
2. `powerline.theme: "custom"`, powerline disabled; no bundled themes in this repo (ccstatusline's own themes are upstream).
3. `hex:RRGGBB` per item, `colorLevel: 3` (truecolor) forced.
4. Foreground only (powerline `enabled: false`; unused separator/caps arrays are present: `separators`, `startCaps`).
5. `defaultSeparator: "|"`, padding empty.
6. Different hue per segment, `|` separator.
7. `not present`.
8. Emoji as separate `custom-text` items merged with `merge: "no-padding"`.
9. `flexMode: full-minus-40`, `compactThreshold: 60`.
10. ccstatusline settings JSON (version 3); `install.sh`.

## axelhamil/ccwatermelon
URL: https://github.com/axelhamil/ccwatermelon — stars: 0
1. By state: pressure level of the context window (`src/context/pressure.ts`: calm / warn / critical / panic from an `alertAbove` threshold with a 20-point warn margin). `toneOf` gives green / yellow / red for the context gauge and the percentage (`segments.ts contextGauge`). A face "mood" at the start of the line takes its colour from the level (`mood.ts`: rose magenta below 30%, zen green, focus yellow, stressed red, panic red). Fixed: lines added green, removed red, dirty `*` yellow, fast mode yellow, thinking magenta, night `☾` blue, version dim, labels dim, cache % red when below 70. Directory, branch, model uncoloured.
2. Themes: `not present` (no theme system; colours are 8 named SGR codes in `src/terminal/format.ts`).
3. SGR names only (31-36, bold, dim). No depth detection; NO_COLOR `not present` in the files read.
4. Foreground only.
5. Gap string between parts; no coloured separator.
6. Spacing and dim labels; no colour alternation.
7. `not present`.
8. Braille gauge (`gauge.ts`); kaomoji faces `(◕‿◕)`, blink animation on a beat clock; OSC 8 links on branch and PR badge.
9. Alert pulse: when the context is critical the gauge alternates with dim on odd beats (`isPulseBeat`); responsive fitting by segment priority (`fit.ts`).
10. User config JSON (`src/config/userConfig.ts`, `segmentConfig.ts`): per-segment enable and priority, alert threshold; CLI in `src/cli.ts`.

## ayangd/claudepowerline
URL: https://github.com/ayangd/claudepowerline — stars: 0
Despite the name, no powerline arrows: README says "icons and braille usage bars are Nerd Font glyphs".
1. Fixed per segment with a threshold on bars (`src/render.rs`, palette `src/theme.rs`): model = bold blue, cwd = cyan, git branch = magenta, elapsed/latency = yellow / white / dim, usage and context bars use `level_colors(pct)`: over 80 red (fg RED, bar bg 52), over 60 orange (fg ORANGE=ansi 33, bg 94), else green (bg 22); cache write share uses red > orange > dim thresholds.
2. Themes: `not present`; a single constant palette in `theme.rs` (ANSI 91-96 bright colours).
3. ANSI 16 bright for text, 256-colour backgrounds for the bar (`48;5;22/94/52/236`). No detection; NO_COLOR `not present`.
4. Both: foreground text; the bar fill uses a coloured tint (dark green/orange/red bg) with a dark track `236`.
5. None (spacing); bars drawn with braille characters.
6. By hue per segment.
7. `not present` (dark-terminal assumption: dark tint backgrounds).
8. Nerd Font icons for model, folder, git, context, tokens, time, usage (`ICON_*`), braille fill levels, `—` placeholder.
9. Golden-file snapshot tests of rendered output (`tests/golden/`); latency percentile lines.
10. No config file seen; Nix flake; settings.json wiring via jq.

## aydenden/cc-plugins
URL: https://github.com/aydenden/cc-plugins — stars: 0
Plugin `statusline` draws a status line through the mods API (`Text` components), ported from `ccstatusline`'s configuration model.
1. By position within the line, from the theme: `layout.mjs styleSegment` (line 79-87): `theme.fg[groupIndex % theme.fg.length]`, `theme.bg[...]` where groupIndex counts segment groups (merged neighbours share one group). An item's own `color`/`bg` overrides the theme. Without theme or colours: `FALLBACK_COLORS` fg #D8DEE9 / bg #4C566A.
2. `scripts/lib/themes.mjs`: bundled `nord` (default; bg #88C0D0 #4C566A #5E81AC #B48EAD #A3BE8C with matching fg) and `nord-aurora` (bg #BF616A #EBCB8B #5E81AC #A3BE8C #B48EAD). A theme = two parallel arrays (fg, bg) of 5 cycled colours. Users cannot add a theme (`Object.hasOwn(THEMES, ...)` check, unknown name falls back to none with a message), but any item can set its own colours.
3. `#RRGGBB` only; comment says mod `Text` accepts named and hex colours but names are not rendered identically across terminals, so ccstatusline names are converted through `ANSI_HEX` (xterm palette). No depth or NO_COLOR handling (host draws).
4. Both: powerline mode (default `powerline.enabled: true`) fills each segment with its bg; plain mode uses fg only.
5. Powerline arrows: `powerlineCells` draws separator `` between segments with colour = previous segment's bg and bg = next segment's bg (line 113); a trailing arrow in the last bg; `config.powerline.separator` configurable; plain mode uses `separator` `" | "` dimmed. Manual separators are ignored in powerline mode.
6. Cycling bg/fg lists by group index: five bgs repeat, so neighbours always differ (hue differences in nord, e.g. cyan, grey, blue, purple, green).
7. Text colour is set per bg in the theme (dark #2E3440 on light bgs, light #D8DEE9 on dark #4C566A); no runtime contrast computation.
8. Powerline glyph; emoji in widgets.
9. Imports a ccstatusline settings file (`convertItem`, `convertColor`: `hex:` and `bgX` names) and reports what could not be carried over.
10. JSON config (`config.mjs`): `theme`, `powerline.{enabled,separator}`, `separator`, `padding`, lines of items with `color`, `bg`, `merge`, `url`; ccstatusline import.

## azandabot/selecta
URL: https://github.com/azandabot/selecta — stars: 0
not a Claude statusline: a music-player plugin (Soundtrack/YouTube) for Claude Code that installs a "now playing" statusline wrapper (`plugins/selecta/lib/statusline.sh`, `statusline/launcher.sh`). Styling is limited: the launcher prints a coloured line or a plain variant when `NO_COLOR` is set or `TERM=dumb` (`launcher.sh:72-75`); colour definitions of the now-playing text were not found in the files read (`unverified`).

## azekyoo/claude-code-status-line-editor
URL: https://github.com/azekyoo/claude-code-status-line-editor — stars: 0
A web editor that exports a `statusline.sh`. The style model of the exported script:
1. Fixed per element type, user-overridable, ANSI names (`src/elements.ts` defaults): model magenta bold, cwd-basename blue bold, project-dir bright-blue, git-branch green, cost yellow, duration/output-style/version/time/reset text bright-black, context-pct and context-bar cyan, rate-5h-bar yellow, rate-7d-bar magenta, tokens bright-cyan, session-name bright-magenta, vim-mode bright-yellow bold, separator bright-black dim. Each element's `color` can be an ANSI name, `custom` hex, or `gradient`. Bars have `barColorMode` solid / threshold (low/mid/high by usage; defaults `#87c05f`, `#d9a854`, `#e05f5f`) / gradient (3 stops across the bar).
2. Themes: `not present`; instead presets (`src/presets.ts`: balanced, minimal, dashboard, ...) and saved designs in localStorage plus a share link (`share.ts`).
3. 17 ANSI names (16 plus default) and 24-bit custom hex. `exporter.ts` detects truecolor at runtime (`COLORTERM` truecolor/24bit or `WT_SESSION`) and otherwise falls back to the nearest ANSI 16 code (`nearestAnsiCode`); no NO_COLOR.
4. Foreground only.
5. A separator is an element with a chosen glyph (`│`, `·`, plus a list of Nerd/powerline glyphs `NERD_SEP_GLYPHS`); colour set per element (default dim bright-black).
6. Authored by the user in the canvas; defaults give each element its own hue.
7. `not present` (the editor previews on a mock terminal).
8. Nerd Font prefix icon picker (`PREFIX_ICONS`), bar styles blocks / shade / segments / dots / thin / ascii.
9. Web UI: drag-and-drop canvas, live preview with mock data, per-character gradient text (`gradient` mode), colour popover, export panel, share links, screenshot script.
10. Output is a bash script (needs jq); the UI is the customisation surface.

## azharuddinkhan3005/cctrack
URL: https://github.com/azharuddinkhan3005/cctrack — stars: 0
Usage tracker CLI (`cctrackr`); its `statusline` subcommand (`src/commands/statusline.ts`, "Compact one-line output for tmux/editors") has no colour code: no chalk or ANSI in that file, output is plain text with `--format '{cost} | {model}'` placeholders. Colours (chalk, `lightdark` detection) exist only in the other commands (dashboard, tables) and are not part of the Claude statusline. Colour: `not present` for the statusline; all other points `not present`.

## bacharyehya/cockpit
URL: https://github.com/bacharyehya/cockpit — stars: 0
unreachable: `raw.githubusercontent.com/bacharyehya/cockpit/HEAD/...` and the GitHub API both return 404 for the repo and the owner's repo list. Scanner metadata only (unverified): a TypeScript grid-based segment renderer (`src/grid.ts`, `src/render.ts`, `src/segments/*`) with 16-colour and truecolor foreground, a few 16-colour backgrounds, 256-colour env check; nothing readable.

## baisiqi6/claude-code-statusline
URL: https://github.com/baisiqi6/claude-code-statusline — stars: 0
1. By state for the context bar, otherwise uncoloured (`statusline.sh:70-80`): usage < 50 green, < 80 yellow, < 90 red, else bold red plus a `⚠ /compact` warning; model, token counts, git and directory text are dim. One colour variable drives the bar and the percentage.
2. Themes: `not present`.
3. ANSI 16 (`\033[32m` etc.), no detection, no NO_COLOR.
4. Foreground only.
5. Two-space gaps, no separator glyph.
6. Dim vs coloured only.
7. `not present`.
8. `█░` bar; one ⚠.
9. Nothing else.
10. Edit the script.

## barbirosha/claude-statusline
URL: https://github.com/Barbirosha/claude-statusline — stars: 0
1. A theme maps eight roles (BLUE, ORANGE, GREEN, CYAN, RED, YELLOW, WHITE, MAGENTA) to 256-colour indexes (`statusline.sh` theme case). Fixed per segment: model = BLUE, directory = CYAN, git branch = GREEN (dirty `*` RED, ahead GREEN, behind RED), effort = MAGENTA for high/xhigh/max else DIM, row labels (`context`, `5h`, `7d`, `spend`) = WHITE, separator DIM `│`. By threshold: cost YELLOW → ORANGE at $10 → RED at $30; limit bars/percent `color_for_pct` GREEN, ORANGE from 50, YELLOW from 70, RED from 90; context colour also depends on token thresholds (250k, 500k). Red/orange background "badges" (`BADGE_RED`, `BADGE_ORANGE`: bold text on a bg of the role's colour) appear for high usage and large contexts.
2. Eight bundled themes: `nord` (default), `dracula`, `gruvbox`, `solarized`, `neon`, `pastel`, `mono`, plus a fallback default (`*` case, e.g. blue 39). Chosen by `--set-theme <name>` (writes `~/.claude/statusline-theme`) or `CLAUDE_STATUSLINE_THEME`; `--themes` previews all. Format = eight 256-colour indexes. Users add a case in the script.
3. 256-colour only (`38;5;N`, `48;5;N`). `NO_COLOR` blanks all variables, including badges. No depth detection.
4. Mostly foreground; filled badges for alerts.
5. Dim `│` between fields; rows are labelled lines.
6. Hue per role; value cells use the traffic-light scale.
7. `mono` theme sets badge text colour to black (`BADGE_RED_TEXT=16`) because its red is white-ish; otherwise none.
8. `▰▱` bars, `●◔◑` effort glyphs, `⟳`, `⏱`.
9. A themes screenshot (`themes.png`); advice lines below the bars in ORANGE/RED.
10. CLI flags (`--themes`, `--set-theme`), env `CLAUDE_STATUSLINE_THEME`, `CLAUDE_STATUSLINE_THEME_FILE`; edit script constants (`TOKEN_ALERT`, `BAR_WIDTH`).

## barletjb/claude-statusline
URL: https://github.com/Barletjb/claude-statusline — stars: 0
1. Fixed and by threshold, mixed depth (`statusline-command.sh`): model = truecolor amber `210;170;90`, context size = dim, folder/branch/effort = plain; context bar: below 40 indigo `129;140;248`, above 40 yellow, above 70 red; 5h bar: ≤ 40 green `76;175;80`, ≤ 70 yellow, else red; 7d same but only shown at 30% and above.
2. Themes: `not present`.
3. Mix of truecolor and ANSI 16; no detection, no NO_COLOR.
4. Foreground only.
5. `" | "` joining parts (`IFS=" | "`), `·` before usage.
6. Colour for model and metrics; text parts plain.
7. `not present`.
8. `█░` bars in `[ ]`.
9. Nothing else.
10. Edit the script; `install.sh` wires it up.

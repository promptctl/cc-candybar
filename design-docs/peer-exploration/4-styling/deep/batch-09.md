# Batch 09: styling deep-read

Sections are in batch order. Anchors are `file:line` or `file` + key, read from raw source at HEAD. Where a project is not a statusline renderer the section is one line plus the colour facts that are still worth having.

## claude-pokemon
https://github.com/Benoit1108/claude-pokemon (stars 5)
1. Colour per segment: no segments in the usual sense. The line is one Pokemon "buddy" row. Colour by data: the Pokemon's own `color` field (from evolution data) is mapped through `ansiColor(theme, name)` (`cli/src/statusline.ts:39-80`: dim, white, green, yellow, red, blue, magenta, cyan, gold -> themeAccent). `color: rainbow` falls back to gold; a shiny Pokemon is forced to the theme accent (`:175-186`). XP percent text turns accent at >=75% else cyan (`:201`). Level text is fixed `DIM+WHITE` (`:214`). Name can be per-character rainbow (`rainbowName`, six bright colours cycled per char, `:83-88`).
2. Themes: 4 (`default` gold, `dark` cyan, `light` sepia, `retro` GameBoy green), picked by `data.json.theme`, not user-definable (README "Themes"; `themeAccent` `statusline.ts:26-36` is a closed switch). `default`/`dark`/`light` only retint the accent; `retro` collapses every name to 3 greens (`:40-57`: dim 22, green-ish 46, red/magenta 34, blue 28).
3. Spec/depth: ANSI 16 (`\x1b[3Xm`) plus 256 index only for theme accents (`38;5;46/51/94/220`). No truecolor, no depth detection, no NO_COLOR.
4. Fill: foreground only.
5. Separators: none (spaces; `/` between XP and next-level XP).
6. Neighbours: not applicable; single row, differentiated by dim vs colour and bold name.
7. Light/dark: only via the `light` theme (accent `38;5;94` brown) chosen by hand; no detection, no contrast logic.
8. Glyphs: emoji (Pokemon emoji, sparkle) and box characters for gauge; no Nerd Font, no ASCII mode seen.
9. Notable: rainbow name, shiny sparkle, evolution-stage colours, theme demo script `.demo/demo-themes.sh`.
10. Customisation: `jq '.theme = "retro"' ~/.claude/pokemon/data.json` (README). No colour editor.

## cprof
https://github.com/dcotelo/cprof (stars 5)
1. Colour per segment: fixed per segment role with config override. Defaults `model=cyan dir=yellow git=magenta branch=cyan label=dim` (`scripts/lib/statusline.sh:111-112`, `d_model=cyan d_dir=yellow d_git=magenta d_branch=cyan d_label=dim`). Bars by threshold: `cp_usage_severity_colour` green < warn(70) <= yellow < crit(90) <= red (`scripts/lib/usage.sh:196-206`, defaults `statusline.sh:111`). Weekly threshold default 50. Profile badge: per-profile colour, auto-assigned by `cksum(name) % 6` over `red green yellow blue magenta cyan` (`scripts/lib/color.sh:12,67-80`), so the same name keeps its colour across machines with nothing stored.
2. Themes: none bundled. User can set `statusline.colors.{model,dir,git,branch,label}` and per-profile `color` in JSON config; validated against the 12 names (`color.sh:17-33`, `statusline.sh:361`).
3. Spec/depth: named ANSI only (31-36, 91-96), deliberately ("respect the terminal's own theme", `color.sh:14-16`). NO_COLOR honoured (any value, even empty): `color.sh:36-43`, `statusline.sh:566-575,603`. `CPROF_COLOR=auto|always|never`.
4. Fill: foreground only.
5. Separators: plain ` │ ` in the `label` colour (dim by default), `statusline.sh:626-632`; git renders `git:(branch*)` with parens in git colour and branch in branch colour (`:675-680`).
6. Neighbours: distinct hues per role plus dim separators.
7. Light/dark: the auto palette excludes black and white because "each disappears against one terminal theme or the other" (`color.sh:5-8`); named slots left to the terminal theme.
8. Glyphs: `⚑` badge, `▓░` bar (configurable fill/empty), box `│`. No Nerd Font.
9. Notable: interactive colour picker (`cp_color_pick`, up/down, each row previews the badge) and `colorText on|off` to colour only the flag or the whole name (`color.sh:99-114`). Bar filled run severity-coloured, remainder `\033[2m` dim (`statusline.sh:57-68`).
10. Customisation: JSON config (`statusline.lines`, `bar`, `thresholds`, `colors`), `cprof color <profile> [name|auto]`, `CPROF_COLOR`, NO_COLOR; `cprof doctor` reports bad keys (`statusline.sh:225-361`).

## burn-o-meter
https://github.com/devopsinside/burn-o-meter (stars 5)
1. The Claude statusline it installs (`src/burnometer/statusline.py:199-208`, `render`) prints plain text `5h 34% · 7d 15%` with no escape codes. Colour exists only in the macOS menubar app (`macos/burn-o-meter/Sources/burn-o-meter/Theme.swift`): identity colour follows provider, never rank; status colours fixed `good #0CA30C`, `warning #FAB219`, `serious #EC835A`, `critical #D03B3B`; categorical series `#2A78D6/#EB6834/#1BAF7A/#EDA100` with separate light/dark values.
2. Themes: none (CLI uses `rich` markup `[yellow]`/`[dim]` in `cli.py`; Swift `Theme` enum is dynamic light/dark).
3. Spec/depth: statusline none; Swift uses hex via `dynamic(light:dark:)`.
4. Fill: n/a for statusline. 5. Separators: ` · `. 6. Neighbours: n/a. 7. Light/dark: Swift palette validated "for colorblind separation and contrast against both surfaces" (`Theme.swift` header), warning step noted as sub-3:1 on light so a number always accompanies colour. 8. Glyphs: none in statusline. 9. Notable: Theme.swift is a good written rule set (status colours reserved, never carry meaning alone; fixed across modes). 10. Customisation: statusline wraps another with `--then`; no colour options.

## ritmex-marketplace
https://github.com/discountry/ritmex-marketplace (stars 5)
1. Colour: fixed per role in `ide-status/scripts/statusline.sh:80-100`: IDE name CYAN, model `WHITE+BOLD`, cost YELLOW, time DIM, labels `ctx/5h/7d` DIM. Bars by threshold (`:69-72`): >=90 red, >=70 yellow, else green; empty part DIM.
2. Themes: not present. 3. Spec: raw ANSI 16 (`\033[32m` etc., `:6-13`), no detection, no NO_COLOR. 4. Fill: foreground only. 5. Separators: ` ${DIM}·${RESET} ` between all segments (`:83-98`). 6. Neighbours: dim dots only; hues by meaning. 7. Light/dark: not present (`WHITE=97` bright white model name will wash out on light). 8. Glyphs: `█░` bars, `⏱`; no Nerd Font. 9. Plugin marketplace with a notification script too; the statusline is one of its plugins. 10. Customisation: edit the script; installer `install-statusline.sh`.

## galpratama/claude-statusline
https://github.com/galpratama/claude-statusline (stars 5)
1. Colour: by role from seven named slots `C_CYAN C_BLUE C_PURPLE C_GREEN C_YELLOW C_RED C_GRAY` (`statusline-command.sh:231-238`). Mapping: model `C_PURPLE` (`:2390`), git branch `C_CYAN` (`:1785`), git dirty marker yellow, sync `=` green / `↑↓` yellow (`:1786-1792`), `+added` green (`:1799`), PR segment blue (`:2526`), stash yellow (`:2529`), separator gray `┊` (`:2386`). Thresholds: `grad_color` green -> yellow at 70 -> red at 100 (`:1489-1505`), used for context, cost (`:2352-2354`, green/yellow), bars and cache timers.
2. Themes: 6 values of `display.theme` (`statusline-config.json`): `default`, `catppuccin`, `tokyonight`, `dracula`, `nord`, `rosepine`. A theme is a semantic palette of seven RGB triples in the order cyan blue purple green yellow red gray (`:219-228`); the same slots then feed the gradient endpoints (`:234-235`). Not user-extensible without editing the script. `default` keeps terminal 16 colours.
3. Spec/depth: truecolor only if `COLORTERM` is truecolor/24bit and `STATUSLINE_TRUECOLOR != 0` (`:215`); otherwise ANSI 16 (`:237-238`, `GRAD_*` fixed RGB fallback `:239`). Themes apply only under truecolor. NO_COLOR not present.
4. Fill: foreground only.
5. Separators: ` ${C_GRAY}┊${C_RESET} ` (`:2386`); per-row `s1/s2` arrays with a tab-delimited priority prefix for width fitting.
6. Neighbours: separated by hue by meaning plus gray separator.
7. Light/dark: not present beyond choosing theme; `default` defers to the terminal palette.
8. Glyphs: emoji and box chars, `⎇` branch, bar partial blocks `▏▎▍...█` at 1/8-cell precision; `·` for empty. No Nerd Font.
9. Notable: per-cell gradient bar, each cell coloured by its own position (`make_bar`, `:1510-1520`); animation signal counts are for spinner/cache states.
10. Customisation: `statusline-config.json` (`segments.*.show_*`, `display.theme`, `display.currency`, subscriptions), env `STATUSLINE_TRUECOLOR`.

## ccm
https://github.com/Jawad-Adas/ccm (stars 5)
1. Statusline (`src/statusline.js:21-37` `buildLine`): profile dot `●` in the profile's own colour (`profile.color`, assigned from `['cyan','magenta','yellow','green','blue','red']` in order of first unused, `src/registry.js:6,57-58`); email dim; usage windows by threshold >=90 red, >=70 yellow, else green; hint yellow; separator `dim(' · ')`. So colour = identity per account plus state.
2. Themes: none for the statusline. The TUI has a fixed dark "Solari board" token set in `src/tui/theme.js` (INK `#F5F3EA`, AMBER `#FAB219`, GOOD `#0CA30C`, SERIOUS `#EC835A`, CRITICAL `#D03B3B`, six account hues validated against `#1A1A19`); `meterColor(pct)`: >=95 critical, >=80 amber, else ink.
3. Spec/depth: ANSI 16 codes via `COLOR_CODES` incl. `gray 90`, `white 37` (`src/util.js:19-32`). NO_COLOR honoured (`ansiEnabled`, `util.js:22-24`). TUI uses hex.
4. Fill: foreground only. 5. Separators: dim ` · `. 6. Neighbours: dim dots, distinct hues. 7. Light/dark: TUI explicitly "dark-committed" (theme.js:1); statusline none. 8. Glyphs: `● ○`, `→`; no Nerd Font. 9. Notable: per-account identity colour so you can see which login a session runs as; the TUI palette was checked with a "dataviz palette checker" (contrast >=3:1, adjacent CVD delta E 41.3). 10. Customisation: `ccm color` style profile field; no theme files.

## usage-band-mod
https://github.com/jonathanlocks/usage-band-mod (stars 5)
Claude Code mod that draws a band of usage bars above the prompt (`hooks/ui.tsx`), not a `statusLine` command, but it styles the same data.
1. Colour: state-driven using Claude Code's own theme tokens, not RGB: `corDe(pct)` (`hooks/formato.ts:56-62`) returns `success` <60, `warning` >=60, `error` >=85, `subtle` when no reading. The mascot body uses token `claude` with black eyes `#000000` (`ui.tsx:13-26`).
2. Themes: none of its own; it inherits whatever Claude Code theme is active because it passes token names (`success/warning/error/subtle/claude`) to Ink `<Text color=...>`.
3. Spec/depth: token names resolved by the host; the only hex values are the bar track `#80808059` (translucent grey, for both themes) and the mascot art. Depth handled by the host.
4. Fill: background-filled cells (bar is painted spaces, `backgroundColor={corDe(pct)}` with `backgroundColor="subtle"` for the empty part, `ui.tsx:166-167`), chosen to avoid seams in macOS Terminal and glyph dependence.
5. Separators: spaces (`SEP_BARRAS`, `SEP_COMPACTO`), dim labels. 6. Neighbours: blank gaps; hue by state. 7. Light/dark: track comment says grey translucent works in dark and light so the green fill stands out (`ui.tsx:11-13`). 8. Glyphs: dotted `·` placeholder for no reading, mascot half-blocks `╺ ▮ ╸`. 9. Notable: Windows/macOS desktop-app renderings of the same band; animated mascot. 10. Customisation: preferences in `hooks/prefs.ts` (text strings in Portuguese).

## claude-statusline-metrics
https://github.com/kolindes/Claude-StatusLine-Metrics (stars 5)
not a Claude statusline: a metrics collector. A snippet appended to the user's own `statusline.sh` posts data to a local Python/SQLite server with a web dashboard (`server/static/`, charts in `js/charts.js`). It styles nothing in the terminal; `install.sh` only uses red/green/yellow/dim for its own messages.

## glassline
https://github.com/kurtbot/glassline (stars 5)
Rust port of sirmalloc/ccstatusline (`crates/glassline-core/src/color.rs` header) with a ratatui TUI editor.
1. Colour per segment: per widget, set in `settings.json` (`WidgetSpec.color`, `backgroundColor`, `bold`: `crates/glassline-core/src/settings.rs:120-145`) with widget-defined defaults when unset (`Widget::default_color`, applied in `glassline-render/src/pipeline.rs:112-123`): git-branch magenta, context-percentage blue, cwd blue. Default template pins model cyan, context yellow, git-branch magenta, git-changes brightGreen (`settings.rs:102-108`). By state: widget metadata `thresholds: "50:green,80:yellow,100:red"` picks fg by rendered percent; `pulseAbove` flashes (`crates/glassline-core/src/animate.rs:57-90`, README "Animation").
2. Themes: only powerline `theme` name (`PowerlineConfig.theme: Option<String>`, `settings.rs:255`) plus `continue_theme_across_lines`; no bundled theme list is visible in the render path.
3. Spec/depth: `Color` enum Default | Named(16, camel or kebab) | Ansi256(u8) | Rgb (`color.rs`); `ColorLevel` None/16/256/Truecolor, default 256 (`color.rs:12-25`, `settings.rs:63`), auto-detected from `COLORTERM`/`TERM`/`WT_SESSION` in the TUI wizard (`wizard.rs:234 detect_color_level`). Named colours resolve to the VS Code terminal default palette for animation math (`color.rs named_to_rgb`). NO_COLOR not present.
4. Fill: both (`background_color`, `override_background_color`, SGR 48 codes in `render/src/ansi.rs:64-90`).
5. Separators: powerline mode with curated Nerd Font glyphs `E0B0 E0B4 E0B8 E0BC E0C0 E0C4` and `separator_invert_background` (`tui/screens/powerline_setup.rs:21-30`); `inherit_separator_colors`. Note `pipeline.rs` header still says powerline "not yet ported", so the render side may lag the TUI (unverified).
6. Neighbours: separators plus the user's per-widget colours; editor rows are tinted by category colour.
7. Light/dark: not present (global `override_foreground_color` only).
8. Glyphs: Nerd Font powerline glyphs, a custom-symbol widget; no ASCII mode seen.
9. Notable: gradient (`gradientStart/End` hex) static or sweeping per character, `animate: rainbow|pulse|sweep` (README table), flashing threshold bands with `|` alternation, colour picker modal with Basic16/Ansi256/Truecolor tabs (`screens/color_menu.rs`).
10. Customisation: `settings.json` per widget metadata, ratatui TUI with live preview, import of ccstatusline configs (`import.rs`), `refreshInterval` note for animation.

## dojo (Lingelo/marketplace-claude-code)
https://github.com/Lingelo/marketplace-claude-code (stars 5)
not a Claude statusline: a Claude Code plugin marketplace (kaizen SDLC, motion-studio, slide-studio); no statusLine code found in the repository tree (the scanner hits are video and slide colour constants).

## tmux-claude-status-tabs
https://github.com/LiveNL/tmux-claude-status-tabs (stars 5)
not a Claude statusline: it colours tmux window tabs by Claude Code state through hooks. Mapping from `tmux/claude-state.conf`: running = cyan bold with a spinner `⬢/⬡` swapped by a background loop (`hooks/lib/state.sh:253-309`), input needed = yellow `?`, permission = red bold `!`, done = green `✓`, idle = `colour244`; current tab adds `bg=colour237`. Named palette colours so the tmux theme resolves them; the README says to swap the four names for your theme's values.

## mattypark/statusline
https://github.com/mattypark/statusline (stars 5)
1. Two scripts. `statusline-command.sh` is plain text (`folder | branch | model | effort: x | ctx: n%`, no colour). `statusline-neon.sh` colours by meaning (header comment): dir = per-project two-colour gradient, model always blue `38;2;77;163;255` bold (`:62-63`), effort a green family brightening with level `low 46;139;87, medium 57;255;136, high bold 125;255;79, xhigh bold 198;255;0, else 38;5;244` (`:46-51`), tokens orange -> red by context percent `<25 255;157;77, <50 255;122;31, <75 bold 255;77;43, else bold 255;43;77` (`:54-60`).
2. Themes: the sibling `paint` script has 9 per-pane themes `acid magma neon cyber rose gold ice lime mono`, each `bg fg border dim_bg` (`paint:14-26`) applied to tmux pane backgrounds/borders; the dir gradient ramp is read from the pane's `@ramp`, else hashed from the project name over 8 ramps (`statusline-neon.sh:28-36`).
3. Spec/depth: truecolor `38;2` for nearly everything, `38;5;238/244` for separator/unknown; no detection, no NO_COLOR.
4. Fill: foreground only on the statusline; pane backgrounds painted by tmux.
5. Separators: `\033[38;5;238m │ ` dim grey. 6. Neighbours: different hue per field, grey separator. 7. Light/dark: not present (dark-biased neon). 8. Glyphs: `▍` before the dir name; no icons. 9. Notable: statusline colour is tied to the tmux pane's border colour so a pane and its statusline match; per-character gradient text via 1000-step lerp (`gradient_text`, `paint:48-62`). 10. Customisation: edit script; `paint <theme>` command.

## claude-gauge
https://github.com/mil-orb/claude-gauge (stars 5)
1. Colour: one colour for the whole indicator, derived from a percent (rate-limit 5h utilisation when present, else context %). `colorSchemes[cfg.color](pct)` (`statusline.js:11-105`). Text segments (tokens, cost, duration) are not individually coloured; the bar/dot takes the percent colour (`:429,453` `colorFn(barPct)`), the text is uncoloured (only `DIM` is used, for the `-- error --` fallback).
2. Themes: 7 colour schemes by name, config key `color`: `gradient` (default: green (40,200,60) -> yellow (220,200,0) at 50 -> red (220,40,20) with a faster curve above 50), `ocean` (cyan -> blue -> purple), `ember` (yellow -> orange -> deep red), `frost` (white -> light blue -> deep blue), `retro` (CGA hard steps `0,170,0 / 170,170,0 / 170,0,0` at <33, <66), `spectrum` (per-character gradient along the bar), `mono` (grey ramp 220 -> 50). A scheme is a function pct -> RGB, not a semantic palette. Not user-extensible except by editing code.
3. Spec/depth: truecolor (`38;2`) only, requires a 24-bit terminal (README); no downsampling, no NO_COLOR.
4. Fill: foreground only (bar made of glyphs). 5. Separators: spaces between segments. 6. Neighbours: n/a (one coloured element). 7. Light/dark: not present (`mono` goes 220 -> 50 grey, readable on dark only). 8. Glyphs: `●` compact, bar styles `bar|drain|dots|blocks|compact`, dithered edge `▓▒`, ⚡ for rate limit. 9. Notable: `spectrum` rainbow per-character; `drain` renderer inverts into a fuel gauge. 10. Customisation: `config.json` keys `display, color, bar_size, show_cost, show_duration, show_lines, currency_rate`.

## cc-vitals
https://github.com/naicud/cc-vitals (stars 5)
Claude Code band mod (`plugins/vitals/hooks/band.tsx`), three density levels (`low|medium|full`), not a `statusLine` command.
1. Colour: host theme tokens by state. `tone(percent)` = `error` >=95, `warning` >=80, else none (`format.ts:42`); server grades `critical -> error`, `warning -> warning` (`:45`). Run status marks: running `claude` (spinner), waiting `suggestion`, completed `success`, failed `error`, other `warning` (`:95-100`). Frame/titles use the single accent `claude` (`ui.tsx:20 ACCENT = 'claude'`). Forecast text `warning` if >=80 else `success` (`band.tsx:111`).
2. Themes: none; uses Claude Code's named colours so it follows whichever theme is active. Only hex are the SVG meter fills `#e5484d` error, `#e0a030` warning, `#2f7de1` default over a `#808080` 30% track (`ui.tsx:163-167`).
3. Spec/depth: delegated to host. 4. Fill: foreground text plus SVG gauge in graphical hosts; terminal uses glyph bars. 5. Separators: dim ` │ ` and ` · `, round borders (`borderStyle="round"`, `borderColor` default `subtle`). 6. Neighbours: dim separators and card borders. 7. Light/dark: delegated to host tokens. 8. Glyphs: emoji (`🔮 FORECAST`, `◆ VITALS`), spinner, `◷ ✓ ✗ ■`. 9. Notable: forecast of usage at reset. 10. Customisation: view level setting; no colour options.

## cosmobar
https://github.com/oleksbard/cosmobar (stars 5)
Go, TOML config. This is the most role-based palette in the batch.
1. Colour per segment: segment -> role -> palette slot. Roles in `internal/segments/catalog.go`: dir, model = identity (Accent); git, git_stash = vcs (Secondary); cost, duration, lines = metric (Tertiary); tokens = usage (Quaternary); clock, output_style, effort = ambient (Muted); context and rate_limits = gauge. `partColor` (`internal/statusline/style.go:56-79`): if the part has a state, OK/Warn/Crit colour wins, else role colour (`vcs -> Secondary`, `metric -> Tertiary`, `usage -> Quaternary`, `ambient -> Muted`, default `Accent`). Gauge state: `StateFor(pct, warn, crit)` with default thresholds 70/90 (`config.go:63 GaugeThresholds`).
2. Themes: 4 bundled (`coral` default, `nord`, `catppuccin`, `gruvbox`; `internal/theme/theme.go`). Format: a semantic `Palette` of 10 roles `Accent Secondary Tertiary Quaternary Muted OK Warn Crit Dark Light`. `cosmobar themes` lists them; `preview --theme`. No user-defined palettes (map is compiled in).
3. Spec/depth: `DetectProfile` (`internal/render/color.go:20-34`): `NO_COLOR` non-empty -> none, `TERM=dumb` -> none, `COLORTERM=truecolor|24bit` -> truecolor, else 256 via a 6x6x6 cube quantiser (`to256`, `:49-55`). NO_COLOR honoured; with profile none the style degrades to `lean` (`effectiveStyle`).
4. Fill: both, per style. `lean` = foreground only; `tick` = coloured `┃` before foreground text; `blocks` = pill with background `Fill(p, fg, bg, ...)` (`style.go:90-135`).
5. Separators: lean uses `config.separator` (default ` · `) in `Muted` (`separatorRuns`, `:162-171`); `tick` two spaces; `blocks` one space. Pills use soft caps `▐` and `▌` coloured with the pill's own bg (`softCaps`, `:81-87`) or square padding with `block_caps = "square"`; ASCII mode drops caps. No powerline arrows.
6. Neighbours: by role hue (identity/vcs/metric/usage differ), plus Muted separators; in blocks mode each pill has its own bg.
7. Contrast: `Contrast(bg, Dark, Light)` picks the palette's `Dark` ink when Rec.601 luminance >= 0.55 else `Light` (`color.go:75-85`); each palette defines both inks (e.g. nord Dark `2e3440`, Light `eceff4`). Pill text colour is therefore computed per background. No terminal-background detection.
8. Glyphs: `glyphs = auto|unicode|ascii` (`config.go:46`); ASCII mode swaps tick and caps (`tickGlyph` `|`). Gauge width 8 default. No Nerd Font.
9. Notable: text-scramble animation on value change (`internal/anim`, variants decode/glitch/scatter, default `glitch`, 700 ms), spend ledger for rollups.
10. Customisation: TOML config (`theme`, `order`, `separator`, `max_rows`, `gauge_width`, `gauge_thresholds`, `style`, `block_caps`, per-segment tables), `cosmobar init|preview|doctor|themes|segments`, a skill under `internal/cli/assets/skill`.

## herdr-claude-usage
https://github.com/oszypczy/herdr-claude-usage (stars 5)
not a Claude statusline: a plugin for the herdr terminal-multiplexer sidebar fed by Claude's statusline JSON. For reference, `setup.sh:36-41` writes herdr row rules: bars `ok fg #98b17d (dim)`, `warn #dec27f`, `hot #df919b` (README: yellow at 50%, red at 80%), and the head token `✳` + workspace name coloured by state via invisible marker characters: idle `#a6e3a1`, working `#f9e2af`, done `#94e2d5`, blocked `#f38ba8` (Catppuccin Mocha values).

## cctokmon
https://github.com/ramon-webdevpro-nl/cctokmon (stars 5)
not a Claude statusline: a standalone terminal TUI monitor (`cctokmon.sh`) fed by a companion statusline script that writes the JSON to a state file and prints plain `$0.000 | ctx 12%` (`cctokmon-statusline.sh:19-25`, no colour). The TUI: themes `default`, `minimal`, `none` (`init_theme`, `cctokmon.sh:84-110`); `tput setaf` ANSI 16 only, gated on `tput colors >= 8`; bar green <=50, yellow <=75, red <=90, bold red above (`:244-252`); ASCII fallback charset when locale is not UTF-8 (`init_charset`).

## ccometixline (rere43 fork)
https://github.com/rere43/CCometixLine (stars 5), fork of Haleclipse/CCometixLine (3482 stars). Diffed from merge base `f36d76a` to fork `master` via the GitHub compare API.
Fork differences in styling (everything else is the parent's):
- New segment `CliProxyApiQuota` (`src/core/segments/cli_proxy_api_quota.rs`, +1141 lines), disabled by default, added to every built-in theme by `default_cli_proxy_api_quota_segment()` (`src/ui/themes/presets.rs`) with icon/text `AnsiColor::Color16 { c16: 11 }`. Per-model foreground colours inside the segment, overridable by option keys `opus_color`, `gemini3pro_color`, `gemini3flash_color`, `codex_color` (`cli_proxy_api_quota.rs:130-153`): defaults 256-index `214`, `129`, `45`, `48`. It emits its own SGR (`apply_foreground_color`, `:285-295`, only `\x1b[39m` reset so a segment background survives) and sets metadata `raw_text=true`, which makes the generator skip its text colouring (`src/core/statusline.rs` diff, `use_raw_text`), so a segment can carry multiple colours. Unknown/failed shows `\x1b[90mcpa:--`.
- Theme loader merges missing segments into older user theme files (`merge_missing_segments`) so new segments appear without recolouring existing ones.
- Model alias editor TUI, new `refresh-cpa-quota` command: no styling.
Parent baseline for context, read from the fork's own files: 9 built-in themes (`cometix default gruvbox minimal nord powerline-dark powerline-light powerline-rose-pine powerline-tokyo-night`, `ThemePresets::builtin_theme`) stored as per-segment `ColorConfig { icon, text, background }` using `AnsiColor::{Color16, Color256, Rgb}`; the default theme is fixed per segment (model 14, directory 11/10, git 12, context 13, usage 14, cost 3, session 2, output style 6; `theme_default.rs`); powerline-dark gives each segment its own near-grey background (model `45,45,45`, directory `139,69,19`, git `64,64,64`, context `55,65,81`, ...); user themes load from `~/.claude/ccline/themes/`. Separator `\u{e0b0}` builds a powerline arrow with fg = previous bg, bg = next bg (`create_powerline_arrow`, `statusline.rs:425-450`); any other separator is printed in plain white `\x1b[37m` (`:384`). Icon sets: plain emoji vs Nerd Font code points per segment. No NO_COLOR, no depth detection seen.

## aihud
https://github.com/RichardErtl/aihud (stars 5)
not a Claude statusline: a separate local web/desktop "HUD" strip (`npx aihud`) that reads transcript files and renders tiles in five style families with a layout composer. For reference only: settings carry `theme: system|dark|light` and per-theme `design_variables` hex overrides validated as `#rrggbb` (`node/store.js:39-45,146-190`).

## claude-code-usage-limits
https://github.com/ridelink0/claude-code-usage-limits (stars 5)
1. Colour: a copy of Claude Code's own dark theme read out of the CLI (`skills/usage-limits/scripts/bars.js:18-60`, `THEME`): `claude [215,119,87]`, `fill [177,185,249]`, `empty [80,83,112]`, `warning [255,193,7]`, `error [255,107,128]`, `success [78,186,101]`, `ultra [175,135,255]`, `permission`, `inactive [153,153,153]`, `subtle`, a Codex green `[16,163,127]`. Bar fill by level: `fill` below 80%, `warning` from 80, `error` from 90 (`level()`, `:104-110`; Codex drains, so `levelLeft`). Mark `✻` and "N working" in `claude`. Effort word coloured per level (`effortColour`, `:279-299`): low = warning, medium = success, high = permission, xhigh/ultracode = ultra with shimmer, max = rainbow.
2. Themes: one fixed palette (Claude's dark); not switchable.
3. Spec/depth: `colourMode` (`bars.js:144-163`): NO_COLOR (non-empty) -> none; FORCE_COLOR -> truecolor; non-TTY -> none unless the caller says it is the statusline; `USAGE_LIMITS_COLOUR=256|none|off`; `TERM=dumb` -> none; COLORTERM truecolor; `WT_SESSION` and a list of TERM_PROGRAMs -> truecolor; else 256 using a 6x6x6 cube/grey-ramp quantiser (`to256`). Best depth handling in the batch.
4. Fill: foreground only (`█` filled vs `░` empty in `empty` colour).
5. Separators: dim `·`.
6. Neighbours: n/a (rows of label + bar + percent); hue only changes by level.
7. Light/dark: dark theme only; no adaptation.
8. Glyphs: Claude's spinner frames `· ✢ ✳ ✶ ✻ ✽` and ASCII twins (`. + * x`), `#`/`-` bar in ASCII (`--ascii`), "Codex" as text since no codepoint exists.
9. Notable: rainbow shimmer for max effort and "ultrathink" (seven colours sliding, brighter lead edge), animation tick 150 ms to match Claude, `reduced` motion mode.
10. Customisation: `statusline.js on|off|status [--refresh N] [--no-chain]` chains an existing statusline; flags `reduced`, `ascii`; env as above.

## statuslines (ryanmaclean)
https://github.com/ryanmaclean/statuslines (stars 5)
A curated catalog (103 entries as of README; Claude entries below) plus one in-repo flavour, `pup`, wired to Datadog.
1. Colour (pup/shared `lib/bar.js`, `lib/colors.js`): usage bar by threshold: green <50, yellow >=50, orange `38;5;208` >=65, red + blink `\x1b[5m` >=80 (`bar.js:6-11`). Alert counts: success green, warning yellow, error red, info cyan, stale dim (`pup/lib/render.js:54-64`).
2. Themes: not present in `pup`. Catalog entries tag themes (names seen in catalog files: catppuccin, tokyo-night).
3. Spec/depth: ANSI 16 plus one 256 index; `noColor()` = `NO_COLOR` set or `TERM=dumb` (`colors.js`), text fallback `[###---] 40%`.
4. Fill: foreground. 5. Separators: spaces. 6. Neighbours: hue by meaning. 7. Light/dark: not present. 8. Glyphs: `█░` and emoji alerts. 9. Notable: blinking red at >=80%. 10. Customisation: `pup` JSON config; catalog CLI `node bin/statuslines.js list|show|configure`.
Catalog `catalog/claude/` entries (each JSON has repo, license, tags, image): adam-ismael-claude-fitness-break, akkaz-ccstatusline-gradient, alequip-ccstatusline-tokyonight, aneeshtigga-ministats, anirudhmkumar-claude-code-statusline, anthonybaldwin-claude-statusline, asaberui1-ccstatusline4deepseek, asafsaar-claude-code-statusline, assenav-gnuj-cc-petline, assenav-gnuj-ccstatusline-charm, awesomejun-cc-statusline, b-open-statusline, bawstosai-fun-fact, blazemalan-claude-plan-statusline, brandonchartier-cc-statusline, briansmith80-claude-code-status-bar, ccometixline, ccstatusline, ccusage, chae-dahee-claude-buddy, claude-hud, codyslater-ccstatusline-retro-hud, ctfbio-claude-code-statusline, daniel3303-claude-statusline, danielmackay-claude-code-statusline, darkronny23-statusmon, deluo-glm-quota-line, dpc00-ccstatusline-editor, dwillitzer-claude-statusline, entrolution-quotaline, entrolution-vastline, felipeelias-claude-statusline, ffontenit-claude-usage-statusline, fmondora-co2-claude, fredrikaverpil-claudeline, fyko-claudehud, gerardofc8-claude-subagent-statusline, gregoryho-cc-pulseline, hagan-claudia-statusline, haunchen-claude-code-statusline, hstojanovic-claude-vibeline, ilia-pluzhnikov-claude-code-statusline, intertechinc-claude-code-context-meter, kamranahmedse-claude-statusline, kenanbalija-islamic-statuses, laveez-ccsl, leeguooooo-claude-code-usage-bar, lightning7329-cc-statusline, lucasilverentand-claudeline, maximocorrea1-dumbometer, meros-claude-usage-statusline, mtschoen-schoen-claude-status, navifra-sally-sysmon-plugin, ndave92-claude-code-status-line, noahbclarkson-noahs-claude-statusline, o0000-cc-tempo, owloops-claude-powerline, padenot-foxtail, pcvelz-ccstatusline-usage, postmodum37-simple-claude-code-statusline, puddinging-prism-hud, raicony-claude-code-statusline, ratelworks-token-horse, riveroflogic-claude-code-statusline, ryukenshin546-a11y-claude-prompt-meter, rz1989s-claude-code-statusline, shallow-dusty-horologium, sirmalloc-ccstatusline, sleighmaster99-claudecodestatusbar, snackdriven-claude-statusline, soulagent-claude-duck, spences10-claude-statusline-powerline, squanchymnonm-claudecode-statusbar, srdarf-xclaudeusage, theobrigitte-claude-statusline, thisdot-context-statusline, victory-c-fitpet, xuedi-claude-statusline, xyzcardiff-claude-code-statusline, young1lin-claude-token-monitor, zrawday-bmad-statusline, zyx1121-claude-statusline. (Useful as a coverage cross-check for the whole survey.)

## ccbrief
https://github.com/shehab267/ccbrief (stars 5)
1. Colour per segment: by role plus state (`src/segments/*.js`): directory `cyan` (`core.js:22`), model `cyanBold` (`:31`), branch icon green + path in default foreground (`:46`), `+n` green / `-n` red (`:52`), context percent magenta with a bar toned by threshold green <70, yellow >=70, red >=90 (`:71-72`), tokens yellow (`usage.js:18`), cost default foreground (`:31`), usage percent by the same thresholds (`usageTone`, `usage.js:50`), countdown green (`:90`), labels `wk`/chrome dim. Principle written in `src/theme.js:1-60`: "colour marks WHICH FIELD this is, dim is for chrome only, and information is never dimmed"; identity text uses the terminal's default foreground with no escape.
2. Themes: no colour themes; four SYMBOL sets (`simple` default, `emoji`, `nerd-font`, `ascii`, `theme.js:36-45`) and `colors: true|false`.
3. Spec/depth: only normal ANSI slots 31-36, deliberately not bright 90-97 and not truecolor, because slots are resolved against the user's terminal theme and stay legible on dark and light (`theme.js:5-17`). NO_COLOR not present (config `colors: false` instead).
4. Fill: foreground only.
5. Separators: ` │ ` dimmed (ascii ` | `), `·` inside usage (`theme.js:63`).
6. Neighbours: field hue plus dim separators; spacing computed from measured symbol width.
7. Light/dark: the explicit design goal above: palette slots + SGR dim/bold attributes (relative to the foreground) rather than RGB; `cyanBold` replaces bright cyan for the same reason.
8. Glyphs: four modes; `simple` default has no pictographs at all (comment: nothing identical across fonts); bars `━ ─`, ascii `# -`.
9. Notable: interactive preview (`src/preview.js`) and installer; layout `auto` with `maxRows`.
10. Customisation: JSON config `{version, preset, layout, maxRows, symbols, colors, icons, segments}` (`src/config.js:47-99`).

## micusubcodeline (zuoliangyu)
https://github.com/zuoliangyu/MicuSubCodeLine (stars 5)
Not marked as a fork on GitHub (parent null), but its tree is the CCometixLine skeleton (same `src/ui/themes/theme_*.rs` names, `ColorPicker`, `ThemeSelector`) rewritten for Sub2API subscription data.
1. Colour: since v2.0.0 the statusline ignores config/themes entirely and renders a locked 3-line layout (`src/core/locked.rs:1-6`, README warning). Colour is by position, hand-assigned per block with five fixed RGB backgrounds `INDIGO 76,86,160`, `GRAY 68,71,90`, `GREEN 95,155,75`, `ORANGE 200,140,55`, `PINK 190,95,145` and one text colour `236,236,236` bold on all (`locked.rs:25-31`). Assignments (`render_locked`, `:52-115`): line 1 model INDIGO, context GRAY, branch GREEN, `(+N,-N)` GRAY, throughput ORANGE; line 2 session INDIGO, cost GRAY, cwd GREEN; line 3 plan INDIGO, daily GRAY, weekly GREEN, expiry PINK. So the first block of every line is indigo, the second grey, the third green; meaning is not encoded (no thresholds).
2. Themes: the nine legacy themes remain in the tree (`cometix default gruvbox minimal nord powerline-*`, `theme_selector.rs`, `presets.rs`) but do not affect the locked render.
3. Spec/depth: truecolor `38;2`/`48;2` only in the locked renderer; legacy path supports Color16/256/Rgb. No NO_COLOR or detection seen.
4. Fill: background-filled blocks.
5. Separators: rounded powerline caps: start cap `\u{e0b6}` in the first block's colour; between blocks `\u{e0b4}` with fg = previous bg and bg = next bg; end cap `\u{e0b4}` on default background (`locked.rs:117-150`).
6. Neighbours: hand-picked sequence indigo, grey, green, grey, orange so adjacent blocks never share a colour; the rounded caps blend each seam.
7. Contrast: single near-white bold text over mid-dark backgrounds; no computation.
8. Glyphs: Nerd Font caps required, `⌥` branch mark, fullwidth colons; Chinese labels.
9. Notable: "pixel-stable" locked layout is deliberate; screenshot-matched palette ("eyeball-matched", `locked.rs:24`).
10. Customisation: none for the statusline in v2; legacy TOML config and TUI still ship but are inert for rendering.

## aeo-skill-marketplace
https://github.com/AeyeOps/aeo-skill-marketplace (stars 4)
not a Claude statusline: a plugin marketplace (nous logging, architecture, security, testing hooks). The only statusline text is `aeo-nous/hooks/statusline-example.sh`, documentation for adding a logger trigger; its example colours context percent by tier green <50, yellow <75, 256-orange `38;5;208` <90, red above, `+n` green `-n` red.

## oh-my-claude-duo
https://github.com/alexj/oh-my-claude-duo (stars 4)
Wraps oh-my-posh: `src/statusline.sh` computes values and exports `CLAUDE_*` environment variables, then runs `oh-my-posh print primary --config <omp.json>` (`statusline.sh:201-236`), so styling lives in the oh-my-posh JSON.
1. Colour per segment: fixed background per segment in `src/claude-statusline-duo.omp.json` (and `-single`): path `#ff6b35`, git `#fffb38` (overridden by `background_templates`: changed `#ff9248`, ahead+behind `#f26d50`, ahead `#f17c37`, behind `#89d1dc`), context text segment `#00897b` (templates: warning `#e67e00`, danger `#cc2200` via `CLAUDE_CONTEXT_STATE`), model `#3a86ff`; the single variant also lists `#00d9ff`, `#ff8c94`, `#9d4edd` for further segments. Foreground `#ffffff`, git `#193549`. Context bar fill colour is passed in `CLAUDE_CONTEXT_BAR_COLOR`: `#7ec8a4` normal, `#e6c96a` >=75%, `#e87070` >=90% (`statusline.sh:26,62-71`); usage rows use grey `#aaaaaa` text with the same three bar colours at their own thresholds and unfilled `#444444`; a danger state turns the text white.
2. Themes: the oh-my-posh config file is the theme; two bundled (duo, single). Users can substitute any oh-my-posh theme/config.
3. Spec/depth: hex truecolor, handled by oh-my-posh (which downsamples). NO_COLOR not present in these scripts.
4. Fill: both: background-filled powerline segments on line 1; plain foreground-only text on the usage line (`background: transparent`).
5. Separators: oh-my-posh `diamond` and `powerline` styles: `` leading diamond, `` powerline arrow, `` trailing diamond, `` leading powerline symbol; arrow colours come from the neighbours' backgrounds by oh-my-posh.
6. Neighbours: distinct hue per segment (orange, yellow, teal, blue) joined by arrows.
7. Contrast: hand-picked white/dark-navy text per segment; no adaptation.
8. Glyphs: Nerd Font required (powerline glyphs, ``, ``, ``), emoji-free.
9. Notable: state-driven backgrounds via oh-my-posh templates; two-account ("duo") rows.
10. Customisation: edit the `.omp.json`; `install.sh`, `local-install.sh`.

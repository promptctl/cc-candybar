## merit-systems/claudelines
https://github.com/Merit-Systems/claudelines — stars 13
not a Claude statusline: a web registry/marketplace of statusline scripts (Next.js). It stores a publisher-supplied ANSI preview and renders it in the browser as inert cells (`src/lib/statusline/ansi.ts`: `CANONICAL_DARK_TERMINAL_PALETTE`, a fixed 16-colour palette `#0d0d0d … #ffffff`, bg `#171717`, fg `#d4d4d4`; `src/components/preview-theme.tsx`: dark/light preview toggle in localStorage). Useful only as a gallery of other people's statuslines; it has no statusline styling of its own.

## omriariav/claude-pulse
https://github.com/omriariav/claude-pulse — stars 13
1. Colour source: threshold/state, plus one fixed colour for diffs. `claude-pulse:264-268` context colour = green <50, yellow 50-79, red >=80 (`C_GREEN/C_YELLOW/C_RED`); rate-limit 5h/7d/Fable each use the same 50/80 cascade (`:992-1016`); diff counts always `C_CYAN` (`:458-465`); separators `C_DIM`. The `taboola` density (`:1204-1330`) maps by segment: dir blue, branch green, `[↑↓]` yellow, dirty `*` red, staged `+` green, model cyan, effort magenta, context-remaining inverted (<=20 red, <=40 yellow, else green), separators dim.
2. Themes: not present. Four "densities" (minimal/regular/heavy/taboola, `:105-117`) change layout, not palette; auto-chosen by terminal width (<100 minimal, >=160 heavy) or `CLAUDE_PULSE_DENSITY`.
3. Colour spec: truecolor fg for the default palette (`:12-21`, e.g. `C_GREEN=38;2;80;250;123`, `C_RED=38;2;255;85;85`); `taboola` density uses plain ANSI-16 ("theme-adaptive, not truecolor", `:1204`). No depth detection. NO_COLOR honoured only in the taboola branch (`:1206`); the other densities ignore it.
4. Fill: foreground-only, except alert banners which are background-filled (`C_RED_BG=\033[41;97m`, `C_YELLOW_BG=\033[43;30m`, `:18-22, 963-976`, white-on-red / black-on-yellow for air-raid-style alerts).
5. Separators: plain `│` in `C_DIM` (`:23`), ` · ` in some densities. No powerline.
6. Neighbours: separators plus emoji prefixes (🧠 🤖 📁 💰 📝); no hue/lightness scheme.
7. Contrast/adaptation: taboola density relies on the terminal's own 16-colour palette to adapt; the truecolor default palette is fixed (assumes dark). Alert banners pair a fixed readable fg with each bg (97 on red, 30 on yellow).
8. Glyphs: heavy emoji use (84 emoji hits); bar is `█`/`░`, optionally bracketed (`[ ]` in heavy density, `:255-258`). No Nerd Font, no ASCII mode.
9. Other: red-alert daemon with banner; terminal tab title set via OSC 0 (`:391`).
10. Customisation: env vars only (`CLAUDE_PULSE_DENSITY`, `_HIDE_COST`, `_HIDE_DIFF`, `_TAB_TITLE`, `_CACHE_DIR`); colours are hard-coded constants at the top of the script.

## fightingPig/claude-statusline
https://github.com/fightingPig/claude-statusline — stars 12
1. Colour source: threshold on one element only. `statusline.py:205-212`: context bar `38;5;46` green if remaining >=50, `38;5;226` yellow if >=20, else `38;5;196` red. Every other part (tokens, cache rate, DeepSeek balance, line 2) is uncoloured (`:216-218`, `" │ ".join(...)`).
2. Themes: not present.
3. Colour spec: 256-index only; no depth detection, no NO_COLOR.
4. Fill: foreground-only.
5. Separators: plain ` │ ` joined into two lines (`:297-298`), uncoloured.
6. Neighbours: separators only.
7. Contrast/adaptation: not present (fixed 46/226/196 are bright and assume a dark terminal).
8. Glyphs: emoji prefix (`🧠`), `█`/`░` bar, arrows `↑↓` for tokens; no Nerd Font/ASCII mode.
9. Other: nothing styling-related; ¥ balance from DeepSeek.
10. Customisation: none for styling (install.sh / merge_settings.py just wire settings.json).

## Flagrare/claude-statusline
https://github.com/Flagrare/claude-statusline — stars 12
1. Colour source: mostly state/threshold with a few fixed. `statusline.sh:42-50` palette = ANSI green/yellow/red/blue/cyan + 256-index orange `208`, gray `244`, dim `240`. Context bar green <50, yellow <=70, red above (`:180-185`); rate-limit colour by `rate_color()` green <50, blue <70, yellow <90, red >=90 (`:192-205`); effort level colours low gray, medium cyan, high green, xhigh yellow, max orange (`:249-253`); PR state OPEN green / DRAFT gray / MERGED cyan / CLOSED red (`:557-561`); git dirty `~` yellow, staged `+` green, untracked `?` gray, conflicts red, ahead green / behind yellow (`:704-734`); ins `+N` green / del `-N` red; goal cyan, loop blue; cwd, session id, version, style name, AI title all `CLR_DIM`; fast mode yellow; context warning red.
2. Themes: not present (an `ICONS` setting selects glyph sets, not colours).
3. Colour spec: ANSI-16 plus a few 256 indexes; no depth detection; NO_COLOR not present.
4. Fill: foreground-only.
5. Separators: ` │ ` in `CLR_DIM` with two spaces each side (`:939`).
6. Neighbours: separators only; hue carries meaning, not identity.
7. Contrast/adaptation: not present; it uses the terminal's ANSI palette for 16-colour entries so those follow the terminal theme.
8. Glyphs: four icon modes in `ICONS` (`:12, 52-135`): `nerd` (PUA codepoints), `unicode` (geometric text-presentation symbols, made for Warp mis-sizing emoji), `ascii` (`[wt]`, `[id]`, `!!`), and `emoji` (default).
9. Other: OSC 8 hyperlink on PR number (`:565`); about 20 `switch-*.sh` toggles.
10. Customisation: `.statusline.conf` sourced shell vars (`SHOW_*`, `ICONS`, `AI_TITLE_MAX_CHARS`); `configure.sh` interactive script; per-feature `switch-*.sh`.

## labzink/cc-probeline
https://github.com/labzink/cc-probeline — stars 12
1. Colour source: semantic roles by segment plus thresholds. `internal/renderer/theme.go` `ColorScheme` fields: `Cyan` = git branch / "orchestrator" label, `Yellow` = warnings, TTL <30m, `Red` = cache miss / TTL <5m / cost >90% budget, `Green` = progress <50 and healthy cost, `Orange` = progress 70-90, `Magenta` = `[high]` effort, `Italic` hint, `Dim` secondary. `ProgressBarColor` (`progressbar.go:131-152`): <50 green, <70 yellow, <90 orange, >=90 red; thresholds user-tunable (`ctx_notice/warn/critical_ratio` 0.50/0.70/0.90, same for 5h/7d quota). TTL colour green >30m, yellow 10-30m, red <=10m (`ttl.go:21-24`). Probes write `{{color:cyan}}…{{reset}}` markers that `Apply()` (`ansi.go:62-72`) turns into escapes, so segments name a role, never an escape.
2. Themes: one palette, `DefaultPalette()` (`theme.go:42-65`). Comments mention `highContrast`/`minimal` palettes (`ansi.go` dim fallback) but only the default is in `theme.go`; no user-defined themes.
3. Colour spec: ANSI-16 SGR deliberately ("respect the terminal's own colour theme", `theme.go:38-41`); one exception, Orange `38;5;208`. No depth detection. NO_COLOR honoured: `DetectAnsi` (`ansi.go:101-108`) returns false for any non-empty `NO_COLOR`, and `[general] no_color = true` in config; markers are stripped to plain text. It deliberately does not check for a TTY because Claude Code pipes stdout.
4. Fill: foreground-only.
5. Separators: Dim grey pipe/table borders (`DimGrey` = SGR 2); also a box-drawing table layout (272 box-glyph hits across `table.go`, `table_unified.go`).
6. Neighbours: separators/table columns only.
7. Contrast/adaptation: 16-colour palette defers to the terminal; Orange 208 chosen as "readable on light and dark".
8. Glyphs: box-drawing tables, a few emoji; `Theme.NerdFont` flag (`theme.go:29`) is "detected at startup" (detection code not read).
9. Other: per-turn cost table with cache-read/write; bold+colour combos (`BoldRed`) for hot cost.
10. Customisation: TOML (`~/.config/cc-probeline/config.toml`, `.cc-probeline.toml`, `CC_PROBELINE_CONFIG`), `[widgets]` on/off, `[thresholds]`; `/cc-probeline-config` wizard; `cc-probeline check-config`. No colour-value options.

## Marcel-Bich/marcel-bich-claude-marketplace
https://github.com/Marcel-Bich/marcel-bich-claude-marketplace — stars 12
Not a statusline project itself: a plugin marketplace. Its statusline is `plugins/limit/scripts/usage-statusline.sh` (and `zai-statusline.sh`); `plugins/credo/hooks/band.tsx` is a Claude Code mod band (task statuses clarify/go yellow, blocked red, done/verified green, parked gray, accent `#d946ef`), not a statusline.
1. Colour source: threshold + per-model + fixed. `usage-statusline.sh:484-516` `get_color`: <30 gray, <50 green, <75 yellow, <90 orange (`38;5;208`), >=90 red. Model name colour (`:1757-1759`): haiku silver `250`, sonnet salmon `210`, opus gold `220`, else gray. Git: worktree bright blue `94`, branch bright cyan `96`, diff counts soft green `151` / soft red `181` in gray parens (`:1505-1540`); cwd and `git:` prefix gray; "(try /compact)" orange (`:1622`).
2. Themes: not present.
3. Colour spec: ANSI-16, a handful of 256 indexes (`:254-272`); default gray overridable as a full escape string via `CLAUDE_MB_LIMIT_DEFAULT_COLOR` (`:242-244`). No depth detection; NO_COLOR not present (`CLAUDE_MB_LIMIT_COLORS=false` switches colour off, `:209`).
4. Fill: foreground-only.
5. Separators: configurable via `CLAUDE_MB_LIMIT_SEPARATORS`; mostly one item per line.
6. Neighbours: one metric per line; no inter-segment scheme.
7. Contrast/adaptation: not present beyond choosing 90 (bright black) default and softened 151/181 for diff counts.
8. Glyphs: `⎇` branch, `[wt]`, ASCII `progress_bar`; mode via `CLAUDE_MB_LIMIT_PROGRESSBAR_MODE`.
9. Other: nothing notable.
10. Customisation: ~25 `CLAUDE_MB_LIMIT_*` env vars toggling items and colours on/off.

## micschr0/claudebar
https://github.com/micschr0/claudebar — stars 12
1. Colour source: theme role (named slots) per segment, with threshold for bars. `src/model/palette.rs` `Theme` is a fixed struct (not a map) of 22 `Color(u8)` slots: `dir`, `git_branch`, `ahead`, `behind`, `modified`, `untracked`, `token`, `bar_ok/bar_warn/bar_crit/bar_track`, `separator`, `dim`, `reset`, `model`, `stash`, `lines`, `cost`, `duration`, `clock`, `effort`, `burn`. Each segment is hard-wired to its slot (e.g. `segment/cost.rs:19` `colored_with(ctx.theme.cost, …)`); context bar picks `bar_crit` if pct >100 or >=crit, `bar_warn` if >=warn, else `bar_ok` (`segment/context.rs:40-46`). A test (`bar_thresholds_distinct`) requires ok/warn/crit be pairwise distinct per theme.
2. Themes: 16 bundled in `src/themes/mod.rs` (tokyo-night default, ayu-mirage, catppuccin, cobalt2, everforest-dark, github-dark, gruvbox, kanagawa-wave, moonfly, night-owl, nord, one-dark, dracula, rose-pine, sonokai, solarized-dark). Format = semantic slots as above. Users cannot define themes in config (name only); contributing a theme is a Rust file (`CONTRIBUTING-themes.md`); unknown names fall back to tokyo-night. Separately selectable "style" axis (8 styles: powerline, lean, plain, rounded, minimal, unicode, ascii, dots).
3. Colour spec: 256-index only (`\e[38;5;<n>m`, `Color::write_fg`). No depth detection; no NO_COLOR found in `main.rs`.
4. Fill: foreground-only (slot docs for `lines`/`cost`/`duration`/`clock`/`effort`/`burn` say "background" but the writer emits fg via `write_fg`/`colored_with`).
5. Separators: style data (`src/model/style.rs`): powerline `\u{e0b1}`, rounded `\u{e0b5}`, `❯`, `|`, middot, empty (lean). Painted in `theme.separator`; intra-segment `window_gap` in `theme.dim`. Thin chevrons, not filled arrows.
6. Neighbours: different hue slot per segment plus a separator glyph.
7. Contrast/adaptation: not present; palettes are 256-index approximations of dark themes (contribution guide: "nearest xterm-256 index to each intended hex").
8. Glyphs: Nerd Font by default in powerline style; `icons: bool` flag gates all icons centrally in `SegmentWriter::icon`, so minimal/plain/ascii/unicode drop them. `bar_dots` quarter-step dot meter `○◔◑◕●`.
9. Other: ratatui config TUI with theme swatches (`src/tui/app.rs`); `claudebar render --theme X --style Y` preview; float readout file stripped of ANSI.
10. Customisation: TOML config (`theme`, `style`), CLI `--theme/--style`, TUI editor.

## n0mad-ai/bastra-recall
https://github.com/n0mad-ai/bastra-recall — stars 12
Mostly a memory daemon; `packages/statusline` vendors owloops/claude-powerline (README: "MIT, vendored") and adds a `bastra` segment plus a Codex panel. Styling below is that vendored statusline.
1. Colour source: fixed per segment type, theme-defined. `powerline-theme.ts` `getThemeColors()` resolves one `{bg, fg, bold}` per segment type: directory, git, model, session, block, today, tmux, context, contextWarning, contextCritical, metrics, version, env, weekly, agent, thinking, cacheTimer. `getSegmentBgColor` is a switch over segment type. `bastra` segment is a fixed brand colour in every theme: bg `#7c3aed`, fg `#ffffff`, bold (`:131-137`). Dark theme example (`themes/dark.ts`): directory `#8b4513`/white, git `#404040`, model `#2d2d3d`, contextWarning `#92400e`/`#fbbf24`, contextCritical `#991b1b`/`#fca5a5`. Context segment switches to the warning/critical entries by usage (threshold logic not located; slots exist).
2. Themes: bundled dark, light, gruvbox, nord, rose-pine, tokyo-night (`src/themes/`), each a per-segment `{bg, fg}` map in hex; each with `…Ansi256Theme`/`…AnsiTheme` variants chosen by detected depth. `theme: "custom"` takes `colors.custom` per segment, and `partFg` allows per-part fg. Unknown theme falls back to dark.
3. Colour spec: hex in theme, converted at runtime by `convertHex` to truecolor / 256 (`hexTo256Ansi`) / 16 (`hexToBasicAnsi`) / none. Detection in `utils/color-support.ts`: NO_COLOR, FORCE_COLOR 0-3, `TERM=dumb`, CI, COLORTERM, a list of truecolor terminals, `TERM_PROGRAM`, `-256color` suffix. `display.colorCompatibility` overrides ("auto" default).
4. Fill: background-filled cells with fg text (default); the `tui` style and `minimal` style differ.
5. Separators: powerline arrow, capsule (rounded caps), minimal (none), `tui` panel; charset `unicode` or `text` (`initializeSymbols`, `:24-30`). Arrow colour: `powerline-layout.ts:148-169` — arrow fg = previous segment's bg (`extractBgToFg`), arrow bg = next segment's bg, so the separator is chained from neighbours' fills; last segment's arrow on terminal bg.
6. Neighbours: each segment type has its own bg, mostly slightly different greys in the dark theme (e.g. `#404040`, `#2d2d2d`, `#202020`, `#2a2a2a`, `#1a1a1a`), differing in lightness, with fg hues for identity; arrows chain colours.
7. Contrast/adaptation: `light` theme exists; `tui` style swaps fg to bg if fg is within distance 60 of an assumed terminal ref (`#1e1e1e` dark / `#f0f0f0` light) (`:104-125`, `hexColorDistance`). Text colours are hand-picked per segment, not computed.
8. Glyphs: Nerd/Powerline symbols (`SYMBOLS`) or `TEXT_SYMBOLS` ASCII; many per-segment icons.
9. Other: `refreshInterval: 1`; Codex Powerline panel; `--design classic|orbital|ember` experimental console.
10. Customisation: JSON config (`claude-powerline.example.json`: `theme`, `display.style/charset/colorCompatibility/padding/lines[].segments`), CLI flags (`--style=powerline`).

## allandecastro/headroom
https://github.com/allandecastro/headroom — stars 11
not a Claude statusline: a Tauri 2 desktop menu-bar app (macOS/Windows/Linux) tracking Claude/Codex/Copilot quotas. `src/lib/theme.ts` is the app's light/dark UI theme, unrelated to terminal styling.

## artem-from-ua/claude-plugins
https://github.com/artem-from-ua/claude-plugins — stars 11
Plugin collection; statuslines are `plugins/statusline/scripts/statusline.sh` (3-line) and `plugins/statusline-compact/scripts/statusline-compact.sh`.
1. Colour source: mix of fixed, per-model, per-branch-prefix and threshold, all foreground 256-index. `statusline.sh:23-32` palette: dim `242`, very_dim `237`, dark_gray `236`, bright_green `71`, bright_red `167`, dark_blue `23`, yellow `178`. Model: only the keyword is coloured (`:157-171`): Opus `167`, Sonnet `71`, Haiku `33` (compact version also Fable `167`, Opus `71`, Sonnet `37`, Haiku `33`, `compact.sh:283-289`); version digits dimmed (`:373-375`). Branch: prefix coloured by type — feature/feat `114`, fix/bugfix/hotfix `203`, release/chore/revert `221`, refactor/docs/test/ci/wip/dev `110`, default `245`, slash dimmed (`:177-198`). Context % uncoloured until >=60 → yellow `178` + ⚠️, >=80 → red `167` + 🛑 (`:421-436`). Usage bars use a pace model: filled-by-usage `236` gray, ahead-of-time-elapsed green `71`, over-pace red `167`, remaining blue `23`, with an indicator block (`:108-152`). Effort (compact): low `33` blue, medium `37` cyan, high `71` green, xhigh `178` yellow, max `167` red (`compact.sh:381-385`).
2. Themes: not present.
3. Colour spec: 256-index only, no depth detection, no NO_COLOR.
4. Fill: foreground-only.
5. Separators: a middle dot `･` in very_dim `237` (`SEP`, `:32`), also used as the space replacement inside values; no powerline.
6. Neighbours: emoji prefix per item and fixed column alignment; separators barely visible.
7. Contrast/adaptation: not present; very dim greys (236/237) assume a dark terminal.
8. Glyphs: emoji (🤖 📚 📁 🌿 💵 ✏️), `･` dot, block bars; no Nerd Font.
9. Other: the 5h/7d bars show pace vs elapsed time as a coloured split bar (green zone = budget not yet due).
10. Customisation: none for styling (hard-coded); installed by `setup-statusline.sh`.

## EricAndrechek/Pacer
https://github.com/EricAndrechek/Pacer — stars 11
not a Claude statusline: a macOS 15+ menu-bar app (Swift, widgets, charts) for Claude Code usage. It has its own colour docs (`docs/identity-colors.md`, `PacerCore/Sources/PacerUI/PaceBandColor.swift`) for model/project identity colours, but nothing terminal-side.

## infiniV/claude-usage-waybar
https://github.com/infiniV/claude-usage-waybar — stars 11
not a Claude statusline: a Waybar (Linux desktop bar) module. `bin/claude-usage-statusline` is only a stdin tap that writes rate limits to a shared state file and chains to the user's real statusline; it emits no styling (`bin/claude-usage-statusline` docstring). Worth noting from the Waybar side (`bin/claude_usage.py:198-240`): accent colours are a fixed semantic set (`accent #66a773` healthy, `warn #b4b47b`, `crit #993426`, `danger #d24646`) deliberately NOT taken from the desktop theme ("harvesting them from alacritty's ANSI slots broke on non-IBM themes where red means red"), while chrome (`bg`, `surface`, `text`, `border`) is overlaid from the active Omarchy theme CSS (`@define-color`). Percent colour: >=exhausted danger, >=critical crit, >=50 warn, else accent (`claude-usage-bar:74-85`).

## Mirage20/ccstatus-go
https://github.com/Mirage20/ccstatus-go — stars 11
1. Colour source: per-component config, keyed by state where relevant. `config.yaml:170-176` model colours by substring of model id: opus magenta, sonnet cyan, haiku green, fable blue, mythos yellow; effort levels low gray / medium cyan / high yellow / xhigh magenta / max red (`:204-211`); context and rate-limit components use `normal_color` green / `warning_color` yellow / `critical_color` red with thresholds 60/75 for context (`:306-319`) and per-window for rate limits; other components take a single `color` (e.g. toggles `color: cyan` / `off_color: gray`, `:241-247`). Unknown colour names fall back to gray (`internal/format/colors.go ParseColor`).
2. Themes: not present; palette is per-component YAML.
3. Colour spec: exactly 8 named ANSI colours (red green yellow blue magenta cyan gray/grey) — "7 whole colors" (README). No 256/truecolor, no depth detection, no NO_COLOR.
4. Fill: foreground-only (`Colorize` wraps text with reset).
5. Separators: configurable `separator.symbol` (default ` | `) and `separator.color` (default gray) (`config.yaml:62-73`).
6. Neighbours: separator only.
7. Contrast/adaptation: not present (uses terminal ANSI palette; gray = SGR 90).
8. Glyphs: Nerd Font icons per component and per model/effort in YAML (`` etc.), overridable; emoji in README examples.
9. Other: Go-template strings per component (`template: "{{.Icon}} {{.ShortName}}"`); providers with TTL file cache.
10. Customisation: YAML (`.claude/ccstatus.yaml`, `.claude/ccstatus.local.yaml`, ~600 documented lines in `config.yaml`).

## spences10/claude-code-analytics
https://github.com/spences10/claude-code-analytics — stars 11
1. Colour source: almost none. Only gauge/bar helpers colour, via chalk 16-colour: `statusline/visuals.ts:26-28` `make_gauge` green if value >=80, yellow >=50, else red (value is a "good" percentage like tool success or cache hit, so high = green, the inverse of a usage bar); `make_lines_bar` added green / removed red (`:62-63`). Other segments (git, model, cost, duration, directory) are plain text; sparklines uncoloured (`segments/sparklines.ts`).
2. Themes: `display.theme` exists but only distinguishes `'ascii'` (`gauges.ts:66`) vs default, i.e. glyph set, not colour.
3. Colour spec: chalk (auto-detects level); `display.colors` can be set false to disable colour (`gauges.ts:33`). NO_COLOR comes only through chalk.
4. Fill: foreground-only.
5. Separators: literal ` | ` between segments (`statusline/builder.ts:30`), uncoloured.
6. Neighbours: separators only.
7. Contrast/adaptation: not present.
8. Glyphs: emoji (📁 💰 🧠 ⚡), Powerline branch ``, `±✓`, ascii `=`/`.` bars when ascii; `supports_powerline()` env check (`src/utils/symbols.ts`).
9. Other: sparkline (multi-row) cost trend; SQLite-backed analytics.
10. Customisation: config with `display.layout` (array of lines of segment names), `bar_width`, `icons`, `colors`, `theme`, `sparkline.width/height`, per-project `load_config(cwd)`.

## tenondecrpc/cc-statusline
https://github.com/tenondecrpc/cc-statusline — stars 11
1. Colour source: per-module config key, defaulted in `presets/default.json`: model white, effort gray, directory blue, git_clean green / git_dirty yellow, context ok/warn/crit = bright_green/yellow/red at thresholds 70/90, rate ok/warn/crit at 60/80, cost magenta, session_timer gray, lines_changed gray, vim_mode magenta, worktree blue, agent magenta (`lib/modules.sh` `ccsl_wrap "$(cfg '.colors.X // "default"')"`; `threshold_color` `:243-251`). The `basic_statusline` module draws a block bar with background fill: bar bg and pct fg `48;5;154` green (<60), `220` yellow (>=60), `196` red (>=80) (`:75-132`), empty cells `⣿` dim `245`.
2. Themes: three presets, `default`, `developer`, `minimal` (`presets/*.json`), deep-merged with user JSON (`lib/config.sh:29`). Format = per-segment colour map under `colors`. Users override any key.
3. Colour spec: named ANSI-16 (incl. bright_*), plus `#RRGGBB` only at truecolor level (hex silently produces nothing below level 3, `lib/colors.sh:41-47`). Depth detection `init_colors` (0 none / 1 16 / 2 256 / 3 truecolor) from NO_COLOR, COLORTERM, TERM (`:5-20`). NO_COLOR honoured. Note the basic module's hard-coded 256-index bar ignores the level.
4. Fill: fg-only in named modules; bg-filled bar cells in `basic_statusline`.
5. Separators: single configurable string `separator` (default ` │ `), uncoloured.
6. Neighbours: separators only.
7. Contrast/adaptation: not present.
8. Glyphs: Braille `⣿` empty bar cells; few emoji; no Nerd Font.
9. Other: `bin/cc-statusline.js` CLI installer.
10. Customisation: JSON user config merged over preset (`preset`, `separator`, `lines`, `modules.*`, `colors.*`), `cc-statusline` CLI.

## YuriNachos/claude-scope
https://github.com/YuriNachos/claude-scope — stars 11
1. Colour source: theme role per widget field. `docs/THEME-SYSTEM.md`: `IThemeColors` groups `base{text,muted,accent,border}`, `semantic{success,warning,error,info}`, `git{branch,changes}`, `context{low,medium,high,bar}`, `lines{added,removed}`, `cost`, `duration`, `model`, `cache`, `tools`, `devServer`, `docker`, `sysmon`, `configCount`, `poker`. Each widget reads its own group, so mapping is fixed per field and theme-defined. Nord example (`themes/nord-theme.ts`): branch cyan `rgb(136,192,208)`, model blue `(129,161,193)`, cost white, duration dark blue, contextLow green / Medium yellow / High red (<50 / 50-79 / >=80).
2. Themes: 17 bundled (monokai default, vscode-dark-plus, catppuccin-mocha, cyberpunk-neon, dusty-sage, dracula, github-dark-dimmed, gray, muted-gray, nord, one-dark-pro, professional-blue, rose-pine, semantic-classic, slate-blue, solarized-dark, tokyo-night). Format = full per-field colour table built with `createThemeColors({...})` helper (35 keys). Custom themes: code-level only (`WidgetFactory` takes an `IThemeColors`); the docs list config-file themes as "Future". Per-widget `colors` override exists in `~/.claude-scope/config.json` entries.
3. Colour spec: truecolor 24-bit only for themes (`rgb(r,g,b)`); `src/ui/utils/colors.ts` has basic ANSI red/green/yellow/gray constants. No depth detection or NO_COLOR found.
4. Fill: foreground-only.
5. Separators: not examined; sysmon has a `sysmonSeparator` colour per theme.
6. Neighbours: different hue per field, fixed by theme.
7. Contrast/adaptation: dark-oriented themes; `gray`/`muted-gray` for minimal distraction; no computed contrast.
8. Glyphs: 12 "display styles" per widget (balanced, playful, compact, verbose, technical…) change text/emoji forms, not colour.
9. Other: AI configuration via a `/scope` skill (natural-language theme change), `quick-config` interactive, `assets/themes.png` gallery, poker widget.
10. Customisation: JSON `~/.claude-scope/config.json` (lines → widget id/style/colors), `quick-config` CLI, `/scope` skill.

## b-open-io/statusline
https://github.com/b-open-io/statusline — stars 10 — FORK OF sirmalloc/ccstatusline
Differences: none found in styling. GitHub compare `sirmalloc/ccstatusline:main...b-open-io:statusline:main` reports `ahead_by: 0, behind_by: 346`, so the fork carries no commits of its own and is a stale snapshot of the parent (last push 2025-11-17). Its styling is therefore the parent's (Powerline themes catppuccin/dracula/gruvbox/monokai/nord/one-dark/solarized/tokyo-night via `PowerlineThemeSelector.tsx`, chalk, Ink TUI), to be read under sirmalloc/ccstatusline.

## ice-lfernandes/claude-code-mods
https://github.com/ice-lfernandes/claude-code-mods — stars 10
not a Claude statusline: a marketplace of six Claude Code "mods" (limits-meter, allowlist-coach, agent-watch, test-hud, launchpad, plain-view) that draw a band above the prompt, panes and toasts using Claude Code's React/Ink plugin API; test-hud also adds a status line entry. Styling facts worth keeping: colours are Claude Code theme role names, not escapes: `limits-meter/hooks/meter.ts:53-54` `tone(percent, warnAt=70, dangerAt=90)` returns `'error'`/`'warning'`/`'success'`, used as `<Text color={tone(p)}>`; accent is the role `'claude'` (`register.tsx:329`); secondary text is `dimColor`; max effort uses `'warning'`. Hex colours are confined to `plain-view/hooks/palettes.ts` (8 gradient palettes, each with a dark and a light stop set, "the one place hex colors live"), so terminal light/dark adaptation is handled by the host theme.

## lexfrei/ailine
https://github.com/lexfrei/ailine — stars 10
1. Colour source: state/threshold only; segments otherwise plain. `internal/fmtutil/format.go:81-96` context % green <50, yellow 50-79, red >=80 (`contextWarnPct=50`, `contextCritPct=80`). Status circles 🟢🟡🟠🔴 and severity markers 🔶 ⚠️ carry meaning as emoji; under `theme=text` they are replaced by text colour via `statusColor` (`:179-186`: 🟢 green, 🟡 yellow, 🟠 and 🔶 orange `38;5;208`, 🔴 red, ⚠️ yellow).
2. Themes: two "themes" that are icon styles, `emoji` (default) and `text` (`PartStyled`, `IconStyle`); not palettes. No user-defined themes.
3. Colour spec: ANSI-16 (green/yellow/red) + one 256 index orange (`:12-18`). No depth detection; NO_COLOR not present.
4. Fill: foreground-only.
5. Separators: ` | ` via `JoinPipe` (`:83-85`), uncoloured.
6. Neighbours: leading emoji per segment; separators.
7. Contrast/adaptation: not present.
8. Glyphs: emoji by default (58 emoji hits); `text` theme drops all identifying emoji and keeps colour for state, "so rate and severity survive as colour rather than a glyph".
9. Other: OSC 8 hyperlinks (`hyperlinks` auto/true/false, `fmtutil/link.go`).
10. Customisation: TOML config (`theme = "emoji"|"text"`, `hyperlinks`, per-segment true/false), CLI `--theme`, `--no-*` flags.

## meresiam/claude-statusline
https://github.com/meresiam/claude-statusline — stars 10
1. Colour source: theme slot per role; fixed role-to-slot map. `statusline.js:162-` each theme has `model, safe, dead, dang, cost, time, tok, sep` (+ bar glyphs, spinner frames, zone labels). Context bar zone is by threshold (`:494`): `<20% safe`, `<40% dead`, else `dang` (a "dead zone" model of degraded context), and uses `t[zone]`; folder dim, branch `(…)` in `t.safe` (`:523`); rate-limit bars override by fixed thresholds: red >=80, yellow >=50, else `t.safe` (`:537`). Pokémon themes also colour a pixel-art sprite.
2. Themes: 13 bundled (cyberpunk, matrix, neon, minimal, retro, meres, plus Pokémon sprites lugia, groudon, rayquaza, charizard, zapdos, articuno, moltres, README), user themes in `~/.claude/statusline-themes.json` (`loadCustomThemes`, `:14-40`, 256-index ints per slot). Format = per-slot colour map (shared type `ITheme`: `model, safe, dead, dang, cost, time, tok, sepChar, sepColor, bFull, bEmpty, frames, deadLabel, dangLabel, sprite`). AI generation: `generate-theme.js "Barbie"` calls the Anthropic API and writes a theme.
3. Colour spec: ANSI-16 in built-ins, 256 index in custom/built-in (`:229-336`), truecolor `[r,g,b]` supported in `fg()/bg()` (`:93-95`) for sprites (chafa). No depth detection; NO_COLOR not present; README requires 256-colour terminal.
4. Fill: foreground text; sprites use bg+fg half-blocks (`▀▄█`) to make filled pixel art.
5. Separators: single char per theme with its own colour (`sepChar`/`sepColor`, e.g. `║` red for a theme, `│` magenta, `·` dim); no powerline.
6. Neighbours: separators; slots give model/cost/time/tok distinct hues within a theme.
7. Contrast/adaptation: not present (themes assume dark); a `theme-studio` computes `softenHex/darkenHex` for previews (`packages/shared/src/utils/color.ts`).
8. Glyphs: animated spinner frames per theme (braille `⠋…`, `◐◓◑◒`, bars), bar glyph sets per theme (`█░`, `▓░`, `◆◇`, `■□`, `▬─`), zone labels with emoji (💀 DANGER).
9. Other: web Theme Studio (NestJS + React, `localhost:7337`) to browse/switch/generate themes; VS Code colour sync; pixel-art sprites; animation.
10. Customisation: JSON themes file, `statusline-config.json`, Theme Studio UI, AI generator CLI.

## padenot/foxtail
https://github.com/padenot/foxtail — stars 10
1. Colour source: 10 named colour slots, one per segment, plus a computed gradient. `src/colors.rs:111-134` default `Colors`: `background (240,160,80)` orange, `model/cwd/time/git_clean/delta/cost/cache/profile` all the same text colour (white, or black when light bg), `separator (220,100,0)`. Context % and git commit-age use `gradient_green_to_red(pct, bg, light)` (`:82-109`): green→yellow→red lerp at 50% midpoint, with two endpoint sets (dark bg: `(80,255,80)/(255,240,80)/(255,80,80)`; light bg: `(0,150,0)/(200,180,0)/(180,0,0)`).
2. Themes: not present; one `[colors]` table in `~/.claude/statusline.toml`, each field `Rgb([r,g,b])`, `Hex("#…")` or `Hsl("hsl(…)")` (`config.rs ColorSpec`, `example_colors.toml`). Invalid colours rejected by `validate_colors`.
3. Colour spec: truecolor RGB via `nu-ansi-term`; no 256/16 downsampling. Colour enablement: `--color auto|always|never`; auto checks `NO_COLOR` (off), `CLICOLOR_FORCE`, `CLICOLOR`, then isatty (`main.rs:41-58`).
4. Fill: background-filled: the whole line sits on one `background` colour when `enable_background = true` (every span painted `.on(bg)`), text in fg.
5. Separators: a coloured separator string in `separator` slot over the same bg; decorative fox head/tail glyphs drawn from block-element chars with fixed RGB (`render.rs:64-98`).
6. Neighbours: separators only (single bg, not alternating).
7. Light/dark: yes. `--background auto|light|dark` or `light_background` config (`main.rs:83-88`) choose gradient endpoints and default text colour; `adjust_colors_for_background` (`colors.rs:161-180`) forces user colours to white if luminance <80 on dark bg, or black if >175 on light bg (Rec.709 weights). A fixed contrast clamp, not a ratio.
8. Glyphs: `use_emojis` toggle; ASCII fallback `>>`/`<<` for fox head/tail when colour off.
9. Other: fox mascot; git-commit-age colour warning.
10. Customisation: TOML (`enable_background`, `use_emojis`, `[colors]`, `light_background`), CLI flags `--color`, `--background`, config path.

## saarshe/claude-code-statusline
https://github.com/saarshe/claude-code-statusline — stars 10
1. Colour source: theme role per component, fixed. `theme/theme.go` `Theme` has seven `lipgloss.Style` roles: Primary, Secondary, Accent, Success, Warning, Danger, Muted (+ optional `Separator`). Components choose a role: model, directory, agent → Primary; git branch → Accent; cost, duration, lines changed, cache hit → Secondary; effort → Muted/Secondary/Primary/Warning/Danger by level (`components/effort.go`); context bar/percent → `ContextStyle` Success below warn, Warning >= warn (default 70), Danger >= danger (default 90) (`components/format.go:23-33`); gradient bar greens up to 70% of width, yellow to 90%, rest red (`context_bar.go`).
2. Themes: bundled default (ANSI index 1-8), catppuccin (mocha hex), dracula, gruvbox, nord, tokyo_night, powerline, rounded. Format = semantic palette roles. Users pick by name in config / wizard; user-defined themes not present.
3. Colour spec: default theme uses ANSI index strings `"6"`, `"2"`, etc.; hex elsewhere. Renderer forced to ANSI256 profile for piped stdout (`theme.go:11`: `termenv.WithProfile(ANSI256), WithUnsafe()`), so hex is downsampled to 256 always, never truecolor. NO_COLOR not found.
4. Fill: foreground-only for default/catppuccin/dracula/gruvbox/nord/tokyo; background-filled with padding for `powerline` and `rounded` (each role is fg+bg+`Padding(0,1)`, e.g. powerline Primary white on `#4e6bbd`, Warning black on `#c4a53e`, Danger white on `#c23b3b`).
5. Separators: theme-provided string, e.g. powerline `" "`, rounded `" "`, otherwise config character (default ` | `). Always rendered with the Muted style (`render/render.go:104-110`): so the powerline arrow is a muted-gray foreground glyph, not chained to the neighbouring cell fills.
6. Neighbours: in fill themes different roles give different bg hues (blue/gray/purple/green/yellow/red); in text themes separators and role colours.
7. Contrast/adaptation: hand-paired fg per bg (black on yellow warning, white on the rest); no computation, no light/dark switch.
8. Glyphs: Nerd Font in powerline/rounded separators; emoji icons per component via config.
9. Other: lipgloss gradient bar (`BarGradient`), interactive wizard with theme selector and component styles (`wizard/`).
10. Customisation: config file, `wizard` TUI (theme step, context bar style step), separator character, `context_bar.style/width/thresholds`.

## thingineeer/claude-cat
https://github.com/thingineeer/claude-cat — stars 10
1. Colour source: state/threshold for bars, fixed for the rest. `src/format.js:62-67` `colorByPct`: >=95 red, >=85 magenta, >=60 yellow, else green. Fixed roles (`:23-59`): window labels "5h"/"week" in Claude Peach truecolor `38;2;222;115;86`; cat glyph cyan; model/cost/ctx chips `dim`; reset phrases dim gray; separator `bold` (default fg); debug chip magenta. Stale (last-known) data draws bars in gray (`mono`) so they stop competing with live bars (`statusline.js:465-468`).
2. Themes: not present (a `configure` wizard picks layout/language, not colours).
3. Colour spec: ANSI-16 plus one truecolor peach; comment says terminals without truecolor "ignore the CSI and fall back to default foreground" (`format.js:19-21`). No detection; NO_COLOR not present.
4. Fill: foreground-only.
5. Separators: `|` in bold default foreground ("so it pops on both dark and light backgrounds (bold white is invisible on light)", `format.js:36-38`).
6. Neighbours: separator plus dim vs coloured weight hierarchy (cost "most important number" bright, secondary chips dim).
7. Light/dark: explicit design choice to use default fg + bold/dim attributes rather than white; the comment documents it.
8. Glyphs: cat pictograms (`src/cats.js`), `▓░` bars, emoji; width helper (`width.js`); i18n.
9. Other: animated/stateful cat mood; i18n; sanitiser for control chars.
10. Customisation: `claude-cat configure` wizard (ink), config file, language option.

## timoncool/givememod
https://github.com/timoncool/givememod — stars 10
not a Claude statusline: a Claude Code skill that generates Claude Code "mods" (bands, panes, guards) from templates; the files listed are example mods (`context-gauge`, `focus-timer`, etc.). No statusline styling of its own.

## tofutools/tclaude
https://github.com/tofutools/tclaude — stars 10
Mostly an agent-fleet environment (tmux, daemon, web dashboard); its statusline is `pkg/claude/statusbar/statusbar.go`. The dashboard's palettes (`palette-*.js`, `terminal-theme.js`) are web UI, not statusline.
1. Colour source: threshold + one fixed. `statusbar.go:28-33` ANSI-16 constants. Bars (`:737-758`) green <60, yellow 60-79, red >=80 of usage; the context bar uses effective max with 60/85 on `usageFraction` (`:714-720`) and a `▒` compaction-buffer region in dim. Branch always cyan in brackets `[branch]` (`:276`); "⚠ SB-OFF" red; reset countdown `(2h5m)` dim. Model label and effort `🧠 high` deliberately uncoloured ("colorDim made it too dark to read", `:415-417`).
2. Themes: not present for the statusline.
3. Colour spec: ANSI-16 only; no detection; NO_COLOR not found.
4. Fill: foreground-only.
5. Separators: ` | ` plain, `strings.Join(line2, " | ")` (`:419`).
6. Neighbours: separator only.
7. Contrast/adaptation: avoids colouring text where the dim variant read too dark; no other.
8. Glyphs: emoji (🔗 📂 🧠), `█░▒` bars.
9. Other: per-repo render cache and broker for multi-session performance (`render_broker.go`).
10. Customisation: none for colours.

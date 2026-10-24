## caoer/ccc-status-line
https://github.com/caoer/ccc-status-line, stars 1. Three parallel implementations (bash, Go, Rust); the Go one (`statusline-go/main.go`) was read, the README says all three print the same line.
1. Fixed per segment, plus one threshold. `main.go:340-393`: model green, session id gray, dir cyan, git branch magenta, message count yellow, input tokens light blue (`94`), output tokens light red (`91`), cost bright cyan. Only context % is state-driven (`main.go:376-385`): >70 bright green, >30 bright yellow, else bright red.
2. Themes: not present. Colours are Go consts (`main.go:85-98`).
3. ANSI 16 only (`\033[32m`, `\033[94m`, `\033[90m` ...). No depth detection, no NO_COLOR (unverified for the Rust and bash ports, not read).
4. Foreground only on the terminal's own background (no `\033[4Xm` anywhere in `main.go`).
5. Plain space between segments, no separator glyphs; brackets/parens around session id and branch (`main.go:348,358`).
6. Neighbours are told apart by hue only (one ANSI colour per field).
7. Not present. Gray (`90`) is used for the session id; no contrast logic, no light/dark detection.
8. Emoji/Unicode only: `K↑`, `K↓`, `msg` text. No Nerd Font, no ASCII mode.
9. Rewritten three times for speed (README benchmark: Rust ~31 ms, Go ~88 ms, bash ~235 ms); no styling extras.
10. No config file; colours edited in source. `install.sh` picks an implementation.

## Carlos-Vera/braves-skills
https://github.com/Carlos-Vera/braves-skills, stars 1. A plugin pack. Its only statusline is `scripts/statusline-context.sh`; the rest is hooks plus a Claude Code mod (`mods/braves-panel`, a side panel with pixel-art mascot).
1. Statusline: no colour at all. `statusline-context.sh` (a Python heredoc) prints `model · folder · NN% ctx` plain, mainly to cache `context_window.used_percentage` to `~/.claude/braves-ctx/<sid>.pct`. Panel mod (`panel.tsx:282-298`): Claude Code theme keys per row kind (`ask`/`deny` warning, `plan`/`↑ tokens` suggestion, `error` error, `commit`/`ship`/`↓ tokens` success), plus `BRAND = '#01b7af'` and `GEMINI_COLOR = '#af87ff'` (`format.ts:5-6`); gauge colour from `colorFor(pct, warn, crit)` (`format.ts:38`, called with 30/50 for context at `panel.tsx:321`).
2. Themes: not present. The panel uses the host's theme keys, so it follows whatever Claude Code theme is active.
3. Statusline: none. Panel: theme key names or hex strings handed to the host renderer; the host decides depth. NO_COLOR not present.
4. Panel draws both: `scenery.ts` gives each row a `bg` (sky gradient array `['#0b1026','#0f1838','#141e45','#18234f']`, `scenery.ts:29`) and per-cell `color`/`bg`. Statusline: neither.
5. Not present (statusline). Panel uses `━` rule and `·` dividers.
6. Not present (single plain line).
7. Panel uses `dimColor` for labels; no contrast computation. Statusline: not present.
8. Panel: emoji/Unicode glyphs (`⎇ ◆ ✦ ⊘ ● ★ ▪`), block-art sprites (`sprites.ts`, imported by `tools/import-sprites.py`). No Nerd Font, no ASCII mode (unverified for sprites).
9. Animated parallax scenery (`scenery.ts`: far layers crawl, near layer faster) and a mascot (`mascot.ts`); `marquee` text helper in `format.ts`. This is a mod panel rather than a statusline.
10. Statusline: none. Mod language labels via `LABELS` in `format.ts` (i18n); hooks configured in `hooks.json`.

## catapultam/cc-coralline-rust (fork of Nanako0129/coralline)
https://github.com/catapultam/cc-coralline-rust, stars 1. Fork differences only. Comparison with the parent was inconclusive: GitHub reports the fork's default branch 0 ahead / 156 behind `Nanako0129:main`, so treat the list below as what the fork's README and code claim, not a verified diff.
1. Same model as the parent (kept byte-identical by `rust/test-parity.sh`): fixed colour per segment, set by a per-theme `VL_BG_<SEGMENT>` variable (`rust/src/config.rs:280-297`: DIR, PROJECT, WT, GIT_OK, GIT_DIRTY, STASH, MODEL, CTX, 5H, 7D, COST, CLOCK, LINES, STYLE, DURATION, EFFORT, NODE, PYTHON, BURN, SUB_NAME/MODEL/CTX/ELAPSED). Git pill picks `bg_git_dirty` vs `bg_git_ok` by dirty flag (`render.rs:550-552`). Gauge text colour is by threshold `pct_fg` (`render.rs:432-440`): `fg_ok` below `VL_WARN_PCT` (50), `fg_warn` from 50, `fg_hot` from `VL_HOT_PCT` (75). Segment text colour is one shared `fg_text` (`render.rs:497,528,...`).
   Fork additions: a `worktree` pill (`VL_BG_WT`, glyph U+2442, `render.rs:541`), a `burn` range-to-empty segment (`VL_BG_BURN`), and four `VL_BG_SUB_*` colours for subagent-panel rows (README "Subagent panel", falls back to the DIR/MODEL/CTX/DURATION colours).
2. Themes: 9 bundled as `themes/*.conf` (catppuccin-mocha, claude-coral, dracula, gruvbox-dark, lunar-pink, mono, nord, reverie, tokyo-night). The parent lists 10 (adds morning-haze). Format: per-segment colour map in shell variables, e.g. `themes/nord.conf` (`VL_BG_DIR="136,192,208"  # nord8` ... plus `VL_FG_TEXT/DIM/OK/WARN/HOT`). Users can edit `~/.claude/coralline.conf` or drop their own file; the installer asks the AI to pick one.
3. `color()` in `render.rs:17-28`: a spec containing `,` becomes truecolor `38/48;2;r;g;b`, otherwise a 256 index `38/48;5;n`. No ANSI-16 names, no depth detection. NO_COLOR: not present in `render.rs`/`main.rs`/`statusline.sh`.
4. Background-filled pills (pill/classic styles) or foreground-only (lean style): `render.rs:884-939`.
5. Powerline pill caps/seps from `VL_CAP_L`/`VL_CAP_R`/`VL_SEP` (`render.rs:884-902`). A separator is drawn with fg = left pill's bg and bg = right pill's bg; the end cap is fg = pill bg on terminal default. Lean style uses `VL_LEAN_SEP` text between coloured text; classic style paints one uniform `VL_LEAN_BG` bar behind it.
6. Different per-segment background colours with powerline arrows; the `mono` theme uses a grey ramp of near values (`240/238/244/242/235...`) and sets `VL_BG_BAR=234` darker than all of them so classic labels stay visible (`themes/mono.conf` comments).
7. Text colour is a theme constant (`VL_FG_TEXT`), chosen by hand per theme (nord uses dark `46,52,64` on its pale frost pills). No computed contrast, no terminal light/dark detection.
8. Nerd Font glyphs; `VL_ASCII=1` removes them (`config.rs:275,324`). Plain Unicode glyphs for `◆ ψ ⧖ ⚑ ↺ ↗ ⎇`.
9. `tools/render-screenshots.py` renders theme previews to `assets/theme-*.png`; `configure.sh` and the AI-driven INSTALL.md interview choose theme and layout; `VL_STYLE` pill/lean/classic; responsive `VL_LAYOUT=auto` wrapping (README table).
10. Plain-bash config file `~/.claude/coralline.conf` (`VL_*` variables), `configure.sh --subagent-rows=on|off`, `CORALLINE_CONFIG` to point the subagent renderer at another file, `VL_BG_*`/`VL_FG_*` take a 256 index or `"R,G,B"`.

## Celtas6655/Claudebar
https://github.com/Celtas6655/Claudebar, stars 1. not a Claude statusline: a Windows system-tray app plus floating Tk widget (`claudebar.py`, one file) showing token usage and a red/amber/green working-state dot. For reference only: fixed widget palette `WIDGET_COLORS = {green #5fb85f, yellow #e0b341, red #e0605a, dim #888888}` (`claudebar.py:1876`), bar colour by threshold (`pct_tag`: green <50, yellow <80, else red, `claudebar.py:373`), dark panel `#1e1e1e` that is colour-keyed out when idle.

## ceshine/claude-statusline-for-linux
https://github.com/ceshine/claude-statusline-for-linux, stars 1.
1. Fixed per segment with threshold overlays. `formatters.py`: model cyan+bold (`:211`), directory blue (`:234`), git branch magenta with staged `+` green, modified `~` yellow, untracked `?` dim (`:117-123`), vim mode blue for NORMAL else green (`:140`), token breakdown labels cyan/green/yellow/blue (`:174-178`), cost label dim. Context bar and rate-limit percentages use `pct_color` (`theme.py:57-68`): green <50, yellow <80, else red. At high context a red-background badge `bg_red` + bold white ` CTX n% ` is shown (`formatters.py:205`).
2. Two themes only, `light` and `dark`, both built by `build_theme` (`theme.py:26-58`) as dataclass fields of ANSI escapes (dim, cyan, green, yellow, red, magenta, blue, bg_red, white_bold). Not a semantic palette with roles; users cannot add themes except by editing the file.
3. ANSI 16 only (`\033[36m`, `\033[90m`, `\033[41m`). No depth detection, no NO_COLOR.
4. Foreground text on terminal background; only the context-critical badge has a background (`\033[41m`).
5. Plain dim ` │ ` between segments (`cli.py:34`), same colour for every gap.
6. Hue only, with `│` dividers.
7. Yes, a light/dark switch: `detect_theme()` (`theme.py:9-25`) reads `STATUSLINE_THEME`, else parses the background index from `COLORFGBG` (`bg < 8` is dark). Light theme changes dim to `\033[90m` and bold-white to bold-black `\033[1;30m`; dark uses `\033[2m` for dim.
8. Nerd Font Material Design icons required (`constants.py:3-9`: robot, memory, folder, source-branch, cash, warning, vim). No ASCII fallback.
9. Two-line layout (`cli.py` builds `line1` and `line2`); `BAR_SEGMENTS = 16` bar width.
10. `STATUSLINE_THEME` env var (`light`/`dark`/`auto`) and `COLORFGBG`; no config file.

## chairat25/claude-statusline
https://github.com/chairat25/claude-statusline, stars 1.
1. Fixed per role, threshold-switched for bars. `themes.mjs` colours dict: `text`, `dim`, `sep`, `barOk`, `barEmpty`, `barWarn`, `barCrit`, `pet`. `statusline.mjs:40-42,63-65`: bar is `barCrit` at >= `critThreshold` (95), `barWarn` at >= `warnThreshold` (80), else `barOk`. Everything else (labels, percentages, model name) is `text` or `dim`. No per-segment hue.
2. 5 bundled: `default` (Claude-orange bar `221,129,97`), `minimal`, `catppuccin`, `tokyonight`, `plain` (all colours empty strings). Format is a semantic role map, plus `bar`, `labels`, `icons`, `animation`, thresholds. Users can define their own: `~/.claude/statusinline-theme.json` is deep-merged over the default (`themes.mjs` `loadTheme`/`mergeTheme`).
3. Truecolor only: `ansi.rgb(r,g,b)` -> `38;2;r;g;b` (`format.mjs:9`). No downsampling. NO_COLOR honoured only by the CLI/dashboard (`cli.mjs:31`: `--no-color` flag or `NO_COLOR` set); `statusline.mjs` does not check it. `plain` theme is the manual no-colour mode.
4. Foreground only.
5. Plain text `|` in the theme's `sep` colour (`statusline.mjs:19`).
6. Separators only; all content text is one colour.
7. Not present.
8. Theme-specific icons (`✦ ⏱ 📅`, `◆ ◈`, `⚡`, `*~#` in plain); bar glyphs set per theme (`▆`, `█░`, `#-`).
9. Animation: a pet kaomoji that cycles frames (idle `(=^.^=)` slow blink, busy running cat at 280 ms) and a braille spinner; a daemon (`src/daemon.mjs`) and pre/post-tool hooks drive busy state. Stale-data marker `~`.
10. `CLAUDE_STATUSINLINE_THEME` env var, `--theme` CLI flag, `themes` subcommand, JSON theme override file.

## chunxue-ding/claude-glm-quota-line
https://github.com/chunxue-ding/claude-glm-quota-line, stars 1. Shows GLM (Zhipu) quota, not Claude's.
1. By state/threshold only. `statusline.js:13-17` default `levels`: remaining >= 70 green, >= 30 orange (`38;5;214`), >= 0 red. The whole line (label, bar, percent, reset time) is painted one colour (`:87`). `N/A` renders gray `90`.
2. No themes; the level table is user-editable.
3. ANSI 16 names plus one 256-colour (`orange 38;5;214`) in `COLOR_ANSI` (`:19-24`: green, orange, red, yellow, blue, cyan, magenta, gray, white). No NO_COLOR.
4. Foreground only.
5. Not present (`label [bar] N% left · reset ...`, `·` text).
6. Not applicable: two quota lines are each one colour by their own level.
7. Not present.
8. Block bar `█░`, bar width configurable 1-20. No icons.
9. Nothing extra.
10. JSON config at `GLM_QUOTA_CONFIG` or a default path (`barWidth`, `levels[{min,color}]`, validated by `configValid`, `:26-45`).

## Clarity-EngineAI/Claude-Code-Status-Clarity
https://github.com/Clarity-EngineAI/Claude-Code-Status-Clarity, stars 1.
1. Mostly state-driven with one theme accent. Model tier (`statusline.sh:944-946`): haiku faint, sonnet `COLOUR_ACCENT`, opus `COLOUR_BRAND` (Anthropic purple `#7266EA`). Context/usage bar (`_build_gradient_bar`, `:335-360`): in truecolor each filled cell gets its own colour on a green -> yellow -> red ramp by cell index (`G=200, R ramps 0..255`), empty cells faint; in 8-colour mode zones `COLOUR_GREEN/YELLOW/RED` (`:386-390`). Lines changed `+n` green `/` `-n` red (`:774`). Cost colour comes from `cost_colour_for_model` (tier). Warnings red/yellow (`:457,466`). Spike arrow is accent in `warm` theme, red elsewhere (`:563`).
2. 5 presets (`lib/theme.sh`): `warm` (default, accent amber `226,150,76`), `cool` (Anthropic purple), `mono` (white), `terminal-classic` (ASCII `|` separator, green accent), `nerdfont-powerline`. A theme only sets `COLOUR_ACCENT`, `SYMBOL_BAR_SEPARATOR`, `SYMBOL_POWERLINE_LEFT` (everything else shares `theme_set_common_defaults`). Not a per-segment map. Custom themes: not present (edit `lib/theme.sh`).
3. Truecolor when `COLORTERM` is `truecolor`/`24bit` (`statusline.sh:112-118`), else ANSI 8-colour fallback (`_colour_24_or_basic` in `theme.sh:16-24`). `TERM=dumb` or `CLAUDE_STATUSLINE_ASCII=1` forces ASCII. NO_COLOR: not present.
4. Foreground only.
5. Plain `│` (or `|`) with two spaces either side in faint (`:781`); Powerline `` available as `SYMBOL_POWERLINE_LEFT` only in the nerdfont-powerline theme.
6. Separators only; hue carries state, not identity.
7. Not present beyond the 24-bit/8-colour fallback.
8. Unicode glyphs (`◆ ↑ ⚡ ◇ ▏`) with ASCII equivalents (`^`, `|`, `#-`) under `TERM_ASCII`; Nerd Font opt-in via `CLAUDE_STATUSLINE_NERDFONT=1`.
9. Gradient bar; forecast spike arrow; fast-mode badge.
10. Env vars: `CLAUDE_STATUSLINE_THEME`, `_ASCII`, `_NERDFONT`, `_POWERLINE`, `_FORECAST`, `_DEBUG`.

## cornellnoel/glancebar
https://github.com/cornellnoel/glancebar, stars 1. Three tiny scripts (`styles/gauge.sh`, `gauge-colorblind.sh`, `gauge-grayscale.sh`) plus path-showing variants.
1. By state only, on remaining context. `gauge.sh:49-57`: <=10% remaining bold red (`1;31`), <=20% orange (`38;5;208`), <=40% yellow (`33`), else green (`32`). Empty braille cells fixed `38;5;237`. Only the 6-cell bar is coloured; folder, percent, tokens and model are the terminal's default.
2. Not themes but 3 variants (user installs the file they want): standard, colourblind-safe (blue `34` > cyan `36` > yellow `33` > bold magenta `1;35`), grayscale (dim `2`, normal `0`, bold `1`, bold+inverse `1;7`). README links `DESIGN.md` for the HCI rationale (thresholds ~20% like battery indicators).
3. ANSI 16 plus 256-colour for orange/grey. No detection, no NO_COLOR. The grayscale variant is the no-colour mode.
4. Foreground only (bold+inverse in grayscale critical).
5. Plain double spaces; no separators.
6. Not applicable (one coloured element).
7. Colourblind and grayscale variants are the accessibility answer; no light/dark adaptation.
8. Braille block `⣿` filled/dim; no icons.
9. Screenshot gallery in README; design rationale doc.
10. Copy the script; no config.

## cozminu/claude-code-status-line
https://github.com/cozminu/claude-code-status-line, stars 1. Modular bash: one file per segment under `segments/`, registered with `register_segment <line> <name> <fn> <toggle>`.
1. Fixed per segment plus thresholds. `lib/colors.sh` palette: DIM, CYAN, MAGENTA, GREEN, YELLOW, ORANGE (`38;5;208`), RED, BRIGHT_BLUE (`94`), TEAL (`38;5;43`), WHITE, BOLD_RED, BOLD_MAGENTA. Mappings in `lib/helpers.sh`: model by family (`:24-28`) opus bright-blue, sonnet cyan, haiku white, fable magenta; effort (`:10-15`) low green, medium yellow, high teal, xhigh bold red, max bold magenta; context uses a 4-band `ctx_pct_color` (green/yellow/orange/red at 20/40/60% by default); 5h/7d usage `pct_color` green/yellow/red at 50/80, or `pace_color` (usage vs elapsed window, green below pace, yellow on pace, orange above, with 5h passing red as the "above" colour so the two bars stay distinguishable, `helpers.sh:108-122`). Git (`lib/git.sh:38-43`): clean branch green `✓`, dirty yellow `✗` with green `+staged`, yellow `~modified`, dim `?untracked`. Cost green, email cyan, title dim, emotion segment maps 14 states to ANSI colours (`segments/25-emotion.sh`).
2. Themes: not present (single palette).
3. ANSI 16 plus two 256-colour indices. No detection. NO_COLOR: not present.
4. Foreground only.
5. Dim ` | ` (`helpers.sh:246`).
6. Hue per field and separators.
7. Not present.
8. Few Unicode glyphs (`✓ ✗`); bars from `bar()` helper. No Nerd Font.
9. Per-segment toggles, three-line layout, plugin directory `STATUSLINE_SEGMENTS_DIR` for extra segment files.
10. Env vars > `~/.config/claude-statusline.conf` (plain bash assignments) > defaults (`lib/config.sh`): `STATUSLINE_SHOW_*`, `STATUSLINE_LINE{1,2,3}_SEGMENTS`, `STATUSLINE_PCT_WARN/CRIT`, `STATUSLINE_CTX_PCT_*`, `STATUSLINE_PACE_TOL`, bar widths.

## CS-Abuhelal/claude-usage-monitor
https://github.com/CS-Abuhelal/claude-usage-monitor, stars 1. A usage monitor with a statusline script, a browser extension and a Claude Code plugin; only the statusline was read for styling.
1. By state only. `statusline/render.mjs:15-20`: TONE map normal (no colour), elevated `38;5;179` (60%), warning `38;5;208` (80%), critical bold `38;5;196` (95%), unknown dim; thresholds in `core/usage-format.mjs:14-20`. Weekly figure is bold; the `S` session figure is plain; reset times dim. "colour appears only once a figure needs attention" (file header).
2. Themes: not present.
3. 256-colour indices (`38;5;N`) and bold/dim; no detection; NO_COLOR not present.
4. Foreground only.
5. Dim ` · ` (`render.mjs:57`).
6. Not applicable beyond bold weekly vs plain session.
7. Not present.
8. Progress ring glyphs from `ringGlyph(usedPct)` (`W ◔ 37% ... S ○ 2%`), `↻`, `☁`; no ASCII fallback seen.
9. Browser extension and `claude-code-plugin/hooks/footer.ts` show the same severity scale elsewhere (not read for colour).
10. `scripts/configure.mjs` (not read); `CLAUDE_CONFIG_DIR` for the cache location.

## Cubence-com/CubenceLine (fork of Haleclipse/CCometixLine)
https://github.com/Cubence-com/CubenceLine, stars 1. Fork differences only (GitHub compare: 10 ahead, 116 behind `master`; the parent's current tree has moved, so its files were not re-read).
1. Parent's model kept (read from the fork, which still has it): fixed colour per segment, defined per theme as a `SegmentConfig { icon, colors: {icon, text, background}, styles }` (e.g. `theme_cometix.rs`: model Color16 14, directory 11/10, git 12, context 13, cost 3, session 2, output style 6, usage 14). Fork adds one segment, `Cubence` (`src/core/segments/cubence.rs`, shows a Chinese-language balance/subscription/latency string for the Cubence API gateway), with a colour added to every theme: Color16 10 in `theme_cometix`, Rgb `163,190,140` on `40,44,52` in `theme_powerline_dark` (similar RGBs in the others). No threshold colouring on it.
2. 9 presets, unchanged by the fork except the extra segment (`presets.rs:22-30`: cometix, default, gruvbox, minimal, nord, powerline-dark, powerline-light, powerline-rose-pine, powerline-tokyo-night). Format: per-segment colour map (not roles). The fork adds `Config::ensure_theme_segments` (`config/types.rs`) which backfills missing segments/options from the active preset so older configs gain `Cubence`.
3. Colour spec enum `AnsiColor::{Color16{c16}, Color256{c256}, Rgb{r,g,b}}` (`core/statusline.rs:293-355`), emitted as `\x1b[..m`, `38;5;`, `38;2;`. No detection or downsampling, no NO_COLOR.
4. Both: powerline themes fill `background`; others foreground only.
5. `presets.rs`: powerline themes use the Powerline arrow, nord uses it too, others `" | "` or `" │ "`. With the arrow, colours are chosen as fg = previous bg, bg = next bg (`create_powerline_arrow`, `statusline.rs:408-437`); any other separator is drawn white `\x1b[37m` (`:139,367`).
6. Different background per segment in powerline themes; `│`/`|` in the others.
7. Per-theme hand-picked text colours (the light theme is a separate preset). No computed contrast.
8. Per segment `IconConfig { plain: emoji, nerd_font: glyph }` chosen by `StyleMode::{Plain, NerdFont}` (`presets.rs:128-296`); the fork adds `💎` / `\u{f0c9a}` for Cubence.
9. Ratatui TUI configurator (`src/ui/`: theme selector, colour picker, icon selector, segment list, live preview) is inherited from the parent.
10. TOML config under `~/.claude/ccline/` and the TUI (parent behaviour; not re-read here).

## cyzlmh/tmux-agent-state
https://github.com/cyzlmh/tmux-agent-state, stars 1. not a Claude statusline in the statusLine sense: a tmux status-bar segment and window-label chips fed by agent hooks (Claude Code, Codex, Kimi, pi). Styling facts: colour by agent state, not by segment. `statusbar/scripts/indicator.py:69-75` and `colorize.sh:76-84`: needs-input `colour180`, truncated/error/stale `colour167`, done `colour108`, running `colour68`, bg `colour172`; each overridable with tmux options `@agent-status-color-<state>`. Chips are `#[bg=colourN]` blocks, one per agent pane in layout order, appended after the window name (`colorize.sh` header). 256-colour tmux indices only; no themes; no NO_COLOR; no separators besides tmux's own; counts rendered `fg=` coloured in `indicator.py:114`. Config: tmux user options.

## czoido/burnie
https://github.com/czoido/burnie, stars 1. Cost analytics (HTML report, `/burnie` skill) plus a tiny statusline.
1. Statusline (`src/burnie/cli.py:71-84`): no colour codes. Prints `💰 $12.34 🔥🔥` where the flame count escalates by cost: `_FLAME_THRESHOLDS = (10, 30, 75, 150)` dollars (`:63`). The HTML report (`report.py`, 62 hex colours) is out of scope for the bar.
2. Themes: not present for the statusline (report has light/dark words, not read in depth).
3. No ANSI at all in the statusline, so NO_COLOR is moot.
4. Neither.
5. Not present (one segment).
6. Not applicable.
7. Not present.
8. Emoji only: `💰`, `🔥`.
9. `--install-statusline` writes `statusLine` with `refreshInterval: 1` (`cli.py:96`).
10. CLI flags `--statusline`, `--install-statusline`; no config.

## dancemonk/token-damage
https://github.com/dancemonk/token-damage, stars 1. A satirical "receipt" of token spend with a 1-3 row statusline and a web app.
1. Plain text with a tiny style vocabulary. Statusline rows (`packages/core/src/live/statusline.ts`) carry no per-segment colour; only the optional third row (a satirical note) is `style: "red"` (`:155`). Receipt styles (`receipt/text.ts:395-400`): muted `90`, ochre `33`, red `31`, stamp bold red `1;31`, bold `1`. State-like behaviour: a 5-cell bar appears only from 70% (`BAR_FROM`, `:75`) and is dropped if the row would not fit.
2. Themes: not present (web app has its own CSS, not read).
3. ANSI 16 only. Honours NO_COLOR and TERM=dumb in the statusline (`cli/src/statusline.ts:103`); CLI `wantColor()` also honours `FORCE_COLOR` (0 off, any other value forces colour on a pipe) with NO_COLOR and `TERM=dumb` winning (`cli/src/color.ts`).
4. Foreground only.
5. Plain ` · ` between parts (`join`, `statusline.ts:54`).
6. Separators only.
7. Not present.
8. Unicode glyphs (`▸ ✶ ■·`); the bar is `■`/`·` from `receipt/glyphs.ts`. No emoji in the bar, no Nerd Font.
9. Rows adapt to width: bars omitted if they would not fit, text clipped to `o.width`; 1, 2 or 3 row modes.
10. CLI options parsed by `parseStatuslineOptions` (rows, width, `--install`); no config file read.

## danielriddell21/skills
https://github.com/danielriddell21/skills, stars 1. not a Claude statusline: a marketplace of Claude Code plugins/mods (context bar, subagent pane, approval gate, UI components). The nearest thing to a bar is the `whats-in-the-box` mod (`plugins/whats-in-the-box/hooks/register.tsx`): a context bar whose category colours are `PALETTE = ['cyan','magenta','yellow','green','blue','red','white']` assigned by row index (`:51,153`), headline level `levelColor` cyan <70%, yellow >=70, red >=85 (`:60-63`), free space dim `░`. All colours are Ink/Claude Code theme names, so the host theme maps them.

## davidpeden3/claude-status-line
https://github.com/davidpeden3/claude-status-line, stars 1. One bash script (`statusline.sh`, uses python3 for JSON and the macOS keychain for an out-of-band Fable weekly quota).
1. Git branch fixed cyan (`\033[36m`, `:204`). Bars by threshold (`make_bar`, `:180-196`): green <70, yellow >=70 (`33`), orange >=80 (`38;5;208`), red >=90 (`31`), thresholds are function parameters. Model name, labels, `↻` reset times uncoloured.
2. Themes: not present.
3. ANSI 16 plus one 256-colour. No detection, no NO_COLOR.
4. Foreground only.
5. Plain ` │ ` between groups (not coloured).
6. Separators only.
7. Not present.
8. Branch glyph (private-use Powerline branch icon, Nerd Font), block bar `█░` 10 cells, `↻`.
9. Fetches Fable weekly usage via the OAuth usage endpoint with a TTL cache and a lock file (`:98-170`); shows bars for context, 5h, 7d and Fable.
10. Edit the script; no config.

## daydeda/claude-code-statusline
https://github.com/daydeda/claude-code-statusline, stars 1. Single bash file with a semantic-role palette per theme.
1. Role-based. Each theme defines `C_MODEL`, `C_FOLDER`, `C_OK`, `C_MED`, `C_WARN`, `C_BAD`, `C_MUTED` (`statusline.sh:54-90`). Mapping: model name bold in `C_MODEL` (`:339`); folder bold `C_FOLDER` (`:360`); git clean `C_OK`, dirty uses the change count; labels `C_MUTED`. Meters use `pct_color` (`:243-247`): `C_OK` <50, `C_WARN` >=50, `C_BAD` >=80, and from 90% the meter pulses dim/bright on odd/even seconds. Effort (`:254-265`): low green, medium yellow, high red, xhigh/max an animated rainbow through the theme's 7-colour `RAINBOW` array shifting one step per second. Pace prediction colours `C_OK` (`on pace`) or `C_BAD` (`runs out ...`).
2. 6 themes: default, catppuccin, dracula, nord, gruvbox, tokyonight, as semantic roles + a rainbow array (`images/themes.svg` screenshot). Custom themes: not present (edit the `case`).
3. Truecolor `38;2;r;g;b` by default; `STATUSLINE_COLORS=256` maps to the nearest xterm-256 cube colour (`__color`, `:172-180`; formula `16 + 36r + 6g + b`, grey ramp not used). No auto-detection. NO_COLOR: not present.
4. Foreground only, except the fast-mode badge, which has `bg 140;0;0` (`:352`).
5. Text `▶` between groups (ASCII `>`), `·` dot, neither coloured per neighbour.
6. Different hue per role (model vs folder), separator glyphs.
7. Not present; muted colours are per theme.
8. Unicode glyphs (`▶ ⌂ ⎇ ● ✓ ⚠ ↻ ⚡`); `STATUSLINE_ASCII=1` swaps all to ASCII; 5 bar styles (blocks, shade, dots, slim, line).
9. Animated rainbow for high effort, pulsing meters at 90%, pace prediction, `scripts/render-preview.py` generates the SVG previews.
10. `~/.claude/statusline.conf` (KEY=value, never executed) and same-named env vars: `STATUSLINE_THEME`, `_BAR`, `_COLORS`, `_ASCII`, `_ANIMATE`, `_SHOW_*`, `_CLOCK`, `_COMPACT`; `/pace-statusline theme <name>` plugin command.

## DBR77Red/context-window-live-visualization
https://github.com/DBR77Red/context-window-live-visualization, stars 1. One Node script (`statusline.mjs`).
1. One colour for everything: the session's own `/color` (`sessionPillColor`, `:100-115`, reads the last `"agentColor"` from the transcript, default cyan). The session-name badge, context bar fill, ctx % badge and the 5h/weekly % badges all use it (`:164-190`). Header comment: "Deliberately no severity colouring" (design in `DESIGN.md`). Model bold, folder/branch plain, rest dim.
2. Themes: it reads Claude Code's own theme name from `~/.claude/settings.json` (`loadPalette`, `:88-99`) and uses a copy of Claude Code's palette for that theme (`SESSION_PALETTES`, `:36-86`): dark, dark-daltonized, light-daltonized, dark-ansi, light-ansi (light = dark). Colours are the eight session colours red, blue, green, yellow, purple, orange, pink, cyan. Users cannot define their own.
3. Truecolor RGB for dark/daltonized; ANSI base (30-37 / 90-97, bg 40-47 / 100-107) for the `*-ansi` themes (`toBg`/`toFg`, `:23-26`). Depth follows the Claude Code theme setting, not detected. NO_COLOR not present.
4. Background-filled badges (` n% ` with terminal-black `30` text, `badge()` `:30`), plus a foreground-coloured bar `▓` over dim `░`.
5. Plain dim `  |  ` (`:155`).
6. Dim separators; all badges share one hue, differentiated by label text.
7. Yes, in a limited way: it matches Claude Code's active theme (including the daltonized and ANSI variants) and fixes badge text at terminal-black so it is readable on the mid-tone session colours; no contrast computation.
8. Block-bar glyphs only; no icons.
9. The colour tracks `/color` live ("change /color, the whole status line re-tints on the next refresh"); two-line layout with width-aware session-name truncation.
10. None; reads `settings.json` and the transcript.

## deeheinhtet/claude-usage-statusline
https://github.com/deeheinhtet/claude-usage-statusline, stars 1.
1. By threshold only. `usage.py:27-39`: 10-cell bar `█░`, red `31` at >=90, yellow `33` at >=75, else green `32`; percentage text uncoloured. Session and week bars use the same function.
2. Themes: not present.
3. ANSI 16. No detection, no NO_COLOR.
4. Foreground only.
5. Plain ` │ ` between session and week (`:156`).
6. Separators only.
7. Not present.
8. Block glyphs only.
9. Nothing.
10. Edit the script; `install.sh` registers it.

## deep-muni/claude-status-line
https://github.com/deep-muni/claude-status-line, stars 1. Closest match to cc-candybar's intent: powerline pills where each segment owns an identity hue and state overrides the whole fill.
1. Fixed identity hue per segment, overridden by severity. `src/utils/color/theme.ts:17-25` `SEGMENT_COLORS`: project `#875FD7` (white ink), git `#00AF87` (near-black ink `#1C1C1C`), model `#5F5FD7` (white), context `#00AF5F` (ink), 5h quota `#00AFFF` (ink), 7d quota `#005FAF` (white), cost `#D70087` (white). Severity replaces the whole ground (`SEVERITY_SURFACES`: warning `#D78700` ink, critical `#D70000` white). Context uses `colorsForUsed` (>=50 warning, >=80 critical); quotas use `colorsForRemaining` (<15 warning, <5 critical); stale quota (unchanged 15 min) is grey `#6C6C6C` with `?` (`STALE_SURFACE`). The cost segment has one inline accent: cache-miss figure in yellow `#FFFF87` (`MISS_INK`, `colorizeForeground`, which restores the segment fg rather than resetting so the background is not punched out).
2. One built-in palette, no theme switching. Format: constant table of `{fg, bg}` pairs per segment (not roles). Users cannot define their own without editing source.
3. Truecolor only (`38;2`/`48;2`, `powerline.ts:21-30`). No downsampling. Honours NO_COLOR (`isColorEnabled`, `powerline.ts:8-11`): falls back to plain text joined by ` · `.
4. Background-filled cells (` text ` with padding, optional bold), no foreground-only mode.
5. Powerline solid arrow `` (U+E0B0) drawn fg = left segment bg, bg = right segment bg (`renderSolidArrow`). If two neighbours end up with the same bg (e.g. both quotas critical), a thin `` (U+E0B1) is drawn in the left segment's ink on that ground instead (`renderSeparator`, `powerline.ts:50-53`), because the solid arrow would vanish.
6. Distinct hue per segment, with a comment stating "Adjacent grounds must differ" for arrow visibility; two rows (identity above, metrics below, `builder.ts`) keep like-hued items apart. Where severity makes neighbours equal, the thin separator keeps them apart.
7. Yes, hand-picked contrast: each ground gets white or near-black ink, chosen so text clears WCAG AA 4.5:1 (comment cites white on `#00AFFF` = 2.5:1 and on `#00AF5F` = 2.9:1 as the reason for dark ink). Not computed at runtime, and no terminal light/dark detection.
8. Nerd Font required for the arrows; one emoji in git (`🌿`) per README example. No ASCII mode, but NO_COLOR gives plain text with ` · `.
9. Severity changes the pill's whole colour so warnings read across the room; staleness drains a segment to grey; screenshots in `assets/`.
10. None found in `src/index.ts` (no flags, config file or env var other than NO_COLOR).

## dengshuit/cclinepro (fork of Haleclipse/CCometixLine)
https://github.com/dengshuit/cclinepro, stars 1. Fork differences only (compare against `master`: 11 ahead, 86 behind).
No styling differences found. The changed files are CI/npm packaging, `README`, `src/config/types.rs` (+46) and `src/core/segments/context_window.rs` (+263/-38); the patches contain no colour, icon, theme or style lines. The fork's stated change (README "Functional Upgrades") is data accuracy: read Claude Code's `context_window` payload (including `context_window_size`, so 1M windows are shown against the real limit) before falling back to transcript parsing. All themes, colour handling, powerline logic and the ratatui configurator are the parent's (see the Cubence entry above, which was read in full from a sibling fork).

## derek1ee/claude-context-band
https://github.com/derek1ee/claude-context-band, stars 1. A Claude Code mod that draws a row of squares above the prompt (not the statusLine command).
1. By category and state, with host theme keys. Squares copy `/context`'s categories and colours (README "What it shows"): system prompt `promptBorder` (light grey), system tools `inactive`, MCP tools cyan, custom agents `permission` (blue), memory files `claude` (orange), skills `warning` (yellow), messages purple (`hooks/layout.ts:205-215`). Free space is dim. The cache countdown label is state-coloured (`cacheLabel`, `layout.ts:261-271`): `success` while warm, `warning` in the last 20% of the TTL, `error` when expired, `inactive` while unknown; a 1h cache flashes `inverse` through its last five minutes.
2. Themes: not present; follows Claude Code's own theme because it uses its colour keys.
3. Theme key names (`'error'`, `'success'`, `'inactive'`, `'text'`) resolved by the host; no hex in the logic. NO_COLOR not present.
4. Foreground glyph squares (`⛁ ⛀ ⛃ ⛶ ⛝`); the label can be `inverse` (swapped fg/bg).
5. Not present; single space between squares.
6. Category = colour; the same colour is used for all of a category's squares, with solid vs hollow glyphs marking what the last turn added.
7. Inherits light/dark adaptation from Claude Code's theme; no own logic.
8. Unicode only (squares); `↻ (n)` button; tooltip on hover.
9. Hover tooltips, click-to-refresh cache button, Herdr integration where the agent's list entry flashes in step with the label.
10. Slash command `/context-band` (`refresh`, `auto-refresh <n|reset|default n>`, `herdr`); a "Cache auto-refresh" row in `/config`.

## dewyze/tmux-agent-bar
https://github.com/dewyze/tmux-agent-bar, stars 1. not a Claude statusline in the statusLine sense: a tmux status line (extra `status-format` line) showing one glyph per agent pane. Styling facts: colour by agent state (`lib/bar-format.sh:99`): needs-input yellow bold `?`, error red bold `!`, done green `+`, subagent-running cyan `**`, idle `colour243` `·`, running cyan `*`. Theme `ascii` (default) or `nerdfont` (`@agent_bar_theme`); nerdfont uses Powerline `` as group/session separator and `` as pane divider, ASCII uses `│ ║ ▌`. `scripts/adopt-theme.sh` infers the window-group fg/bg and accent from the user's existing `window-status-format`, `window-status-current-format` and `status-left`, and `@agent_bar_*` options hold them; with a nerdfont theme plus known status bg and both window styles carrying backgrounds, groups draw as real powerline segments with transition chevrons (old bg over new bg). 256-colour tmux names (`colour109` accent, `colour240/245` dividers); no NO_COLOR.

## dgaidula/claude-rocketline
https://github.com/dgaidula/claude-rocketline, stars 1. p10k "Rainbow"-style left and right chains on one line.
1. Fixed per segment with state overrides, via theme variables (`statusline.sh:59-81`). Badge (OS icon + AI), model `MODEL_BG` (24 teal-blue), repo `REPO_BG` (4 in `danny`, `BLUE` in `dark-dan`), clock `TIME_BG` (238 grey). State colours: context chip background `CTX_GREEN/YELLOW/RED` from used % (>=85 red, >=60 yellow, else green, `:219-223`); branch background `BRANCH_CLEAN` vs `BRANCH_DIRTY` by `git status --porcelain`; "live" chip uses the flame orange.
2. 2 bundled: `danny` (light badge, `7`/`232`; ANSI palette `2/3/1/4`) and `dark-dan` (dim greys, `28/136/124`); per-segment overrides by env (`STATUSLINE_BLUE`, `_NEUTRAL`, `_BADGE_BG/_FG`, `_TIME_BG/_FG`, `_PIPE`). Format: variables per segment, not semantic roles.
3. 256-colour indices for all segments (`48;5;N`/`38;5;N`); one accent, the flame, auto-upgrades to truecolor `F2920D` when `COLORTERM` is truecolor/24bit (`flame_sgr`, `:89-99`), else 256 `208`. No NO_COLOR.
4. Background-filled pills.
5. Angled powerline (`E0B0`, `E0B1`, `E0B2` built from bytes) with four end-cap styles `STATUSLINE_CAPS` = flame, slant, rounded, pointed. Separator colours: fg = previous bg, bg = next bg (`render_lchain`, `:142-151`); two neighbours with the same bg get a thin `E0B1` in black (`38;5;0`) instead.
6. Different background per segment, with the thin separator for same-coloured neighbours; the right chain mirrors the left (`RSEP`).
7. Two hand-tuned themes (light vs dark); text colours fixed per theme (e.g. `254` on teal). No auto-detect or computed contrast.
8. Nerd Font required (README); OS icon auto-detected and overridable; emoji `🤖 🧠`; glyph widths measured via perl, with the special case that flame separators count as 2 cells (`:177-189`).
9. Responsive shedding by width (clock, then live chip, branch, repo, reset, effort, model qualifier, context), a Remote Control "on-air" chip that migrates into the badge, `demos/showcase.sh` for every theme x cap style.
10. Environment variables inline in the `command` string (`STATUSLINE_THEME`, `_CAPS`, `_OS_ICON`, `_AI_ICON`, `_CTX_ICON`, `_PIPE`, `_FLAME`, `_BLUE`, `_NEUTRAL`, ... `_LCAP/_RCAP`, `_RC*`); no config file.

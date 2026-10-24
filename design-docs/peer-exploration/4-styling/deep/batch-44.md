## claude-code-time-tracker
https://github.com/fikret/claude-code-time-tracker (stars: 0)
1. Fixed per segment, no state. `scripts/statusline.py:35-37`: project name `ACCENT` amber (`38;5;179`) + bold; "today" duration `GREEN` (`38;5;71`); "total", "session", tokens/cost all `DIM` (`\033[2m`) or default text. No thresholds.
2. Themes: not present. Colours are three module constants.
3. 256-index (`38;5;N`) plus SGR dim/bold. No depth detection, no NO_COLOR (`statusline.py` has no env read for colour).
4. Foreground only.
5. Plain ` · ` separator, dimmed (`SEP`, `statusline.py:38`).
6. Neighbours distinguished by dim vs normal vs the two accent colours; separator only.
7. Not present (comment at line 32 says "degrade gracefully in any terminal", nothing implemented).
8. One emoji icon `⏱` (env `CC_TIME_ICON` overrides); no Nerd Font, no ASCII mode.
9. Nothing else styling-related.
10. Env vars only: `CC_TIME_GAP`, `CC_TIME_SHOW_COST`, `CC_TIME_ICON` (`statusline.py:~58-60`). No config file.

## claude-statusline (FlaccidNoise)
https://github.com/FlaccidNoise/claude-statusline (stars: 0)
1. Fixed per segment role, from a theme file. `scripts/statusline.sh:46-60` output line: spinner `COLOR_SPINNER`, directory `COLOR_DIR`, model `COLOR_MODEL`, bar `COLOR_BAR`, percent `COLOR_PERCENT`, labels (`Ss:`, `Wk:`, `All:`, `7d:`) `COLOR_LABEL`, numbers `COLOR_VALUE`, sparkline `COLOR_SPARKLINE`, separator `COLOR_SEPARATOR`. The bar colour does not change with context level (one colour, `COLOR_BAR`).
2. Five bundled shell themes: synthwave (default, in the script), ocean, nord, dracula, racing-green (`themes/*.sh`). Format = per-role variables (9 colour vars plus glyph vars `SPINNER_FRAMES`, `SEPARATOR`, `BAR_FILLED/HEAD/EMPTY`, `SPARKLINE_CHARS`). Users make their own by copying a theme file (README "Creating Custom Themes"); `CLAUDE_STATUSLINE_THEME` or `~/.claude/statusline-theme.sh` selects it.
3. Truecolor `\033[38;2;r;g;bm` (e.g. `themes/dracula.sh`), a few bright-16 in synthwave (`\033[95m`, `\033[96m`). No depth detection, no NO_COLOR in `statusline.sh`.
4. Foreground only.
5. Plain glyph separator, theme-set (`│` in dracula, `▸` default synthwave), coloured `COLOR_SEPARATOR` (synthwave hot pink, dracula "comment" grey-blue).
6. Separators and label-vs-value colours only; the model/dir/percent each have a different hue per theme.
7. Not present; synthwave is commented "optimized for dark terminals".
8. Unicode only (box/block glyphs, `◐◓◑◒` or `◢◣◤◥` spinner, `▁▂▃▄▅▆▇█` sparkline). Themes change the glyph set (ocean has wave glyphs). No Nerd Font, no ASCII fallback.
9. Animated spinner (frame = `date +%s` mod N, `statusline.sh:~38`); 7-day token sparkline; `statusline.ps1` is a PowerShell twin.
10. Theme file chosen at install (`install.sh <theme>` / `install.ps1 -Theme`), env `CLAUDE_STATUSLINE_THEME`. No JSON/TUI.

## claude-code-session-bar
https://github.com/flaviu-vanca/claude-code-session-bar (stars: 0)
1. Mixed: fixed role colours plus a green-to-red heat ramp by value. `session-bar.py:511` model name `ACCENT` bold; frame/separators `EDGE` (`session-bar.py:578`); unfilled meter cells `EMPTY`; meters and numbers via `heat(t)` (`:120`), interpolating GREEN 0.0, YELLOW 0.6, ORANGE 0.85, RED 1.0 in RGB. Cache-hit meter is inverted (`good_high`, `:606`). Permission mode glyph colours: auto YELLOW, acceptEdits PURPLE, plan TEAL, bypass RED (`:83-87`).
2. 17 bundled palettes (`session-bar.py:22-73`): default, nord, dracula, gruvbox, tokyo, catppuccin, rose-pine, solarized, one-dark, everforest, kanagawa, monokai, ayu, synthwave, mono, matrix, amber. Format = semantic roles per palette: `accent, edge, empty, green, yellow, orange, red, purple, blue, teal`, each an RGB tuple. User-defined palettes: not present (select by name only; unknown name falls back to default, `:421-422`).
3. Truecolor only (`38;2;r;g;b`, `:149`). No depth detection, no NO_COLOR.
4. Foreground only.
5. Rounded card frame in box-drawing (`╭─ ... ─╮`, `╰─`), drawn in `EDGE`; dim middle-dot between elements. No powerline.
6. Not colour-differentiated: elements are text on the card with a dim `·` between; meter groups distinguished by labels.
7. Not adapted. Comment at `:18` says `edge` is chosen "visible on a dark terminal". Emits `\x1b[0m` first because Claude Code wraps lines in dim (`:147`).
8. Unicode only (`▰▱`, `⎇`, `⌂`, `✻`, `↻`); every glyph one cell wide (comment `:139`). No Nerd Font mode.
9. Web settings page (`configure.py`, served on 127.0.0.1) with drag-and-drop placement of elements and palette picker; `preview/chips.py` preview; OSC 8 links (`:151`).
10. JSON layout file (`~/.claude/session-bar/` or project `.claude/session-bar.json`), edited through the browser page launched by `session-bar`; `install.py --scope project`. Settings keys: `palette`, `meter` length, element lists per card place (`DEFAULT` at `:117`).

## flobernd/claude-statusline
https://github.com/flobernd/claude-statusline (stars: 0)
1. Fixed semantic meaning per colour, by state where a value carries information. `src/theme.rs:4-11` one 8-colour palette (Tokyo Night values): COMMENT `#565f89`, BLUE `#7aa2f7`, CYAN `#7dcfff`, GREEN `#9ece6a`, MAGENTA `#bb9af7`, AMBER `#e0af68`, RED `#f7768e`, WHITE. `src/sections.rs`: model MAGENTA (`:110`), token counts BLUE (`:55`), directory CYAN or RED when missing (`:175`), branch GREEN on default branch else MAGENTA (`:183-186`), `+n` GREEN, `-n` RED, `~n` AMBER (`:220-226`), PR# CYAN, review state approved GREEN / changes_requested RED / pending AMBER / draft COMMENT (`:446-449`), effort high/xhigh/max bold MAGENTA, low/medium bold COMMENT (`:115-116`). Bars: `src/bar.rs:5-12` GREEN <=60, AMBER <85, RED >=85. Cache-age against TTL: COMMENT / AMBER / RED (README "First line").
2. Themes: not present; one fixed palette (README "Colors" calls it "one fixed 24-bit palette so a color means the same thing wherever it appears"). No user palette.
3. Truecolor only (`theme.rs:40`). `NO_COLOR` honoured (any non-empty), `FORCE_COLOR` overrides (`Style::from_env`, `theme.rs:30-35`); no 256/16 downsample.
4. Foreground only.
5. Plain ` │ ` separator painted COMMENT (`sections.rs:522, 567`).
6. Labels and separators in COMMENT grey, saturated colour only on informative values; chips otherwise distinguished by hue per meaning.
7. Not present. README: "identical in every terminal regardless of its palette"; README swatch images have light/dark variants for the docs only.
8. Unicode glyphs (`\u{2338}`, `\u{2387}`, `\u{2302}`, `\u{2B06}`); `tools/preview/extract_glyphs.py` for the preview. No Nerd Font, no ASCII mode.
9. Dim-to-COMMENT signal for stale cached meters; OSC 8 links (`clickable_links`); control-character sanitising of payload text (`theme.rs:17-25`).
10. `~/.claude/claude-statusline.json`: `disabled_sections`, `clickable_links`, subagent sections, polling intervals. No colour keys. Env `NO_COLOR`/`FORCE_COLOR`.

## dsh-flykit
https://github.com/flykit-cc/dsh-flykit (stars: 0)
not a Claude statusline: a plugin for DeepSeek Harness's `dsh web` GUI (file explorer, xterm terminals, model picker). It has a one-line HTML status line under the composer (`src/client/StatusLine.tsx`: text in `var(--dsw-alias-label-tertiary)`, segments joined by ` │ `), a context ring recoloured by occupancy (`src/client/segments.ts:33-38`: <60 success, <85 warn, else error tokens of the host's `--dsw-*` theme), and Claude usage bars above a Claude Code terminal (`src/client/styles.ts:146-148`, brand colour, warn/error tone). Terminal palette is fixed One Dark (`src/client/term-theme.ts`).

## agent-statuslines
https://github.com/fobtastic/agent-statuslines (stars: 0)
Two folders. `claude-code/` is only a ccstatusline config; `antigravity/` is a statusline for Google's Antigravity CLI (not Claude).
1. `claude-code/settings.json` (ccstatusline v3 config): fixed colour per widget, set by the user: model cyan, thinking-effort cyan, git-branch magenta, git-changes brightYellow, context-length brightGreen, tokens-total red, tokens-cached yellow; cwd, reset-timer, weekly-usage, weekly-reset-timer use backgrounds (`bgBrightBlue`, `bgBrightWhite`, `bgBrightRed`, `bgBrightMagenta`) which the powerline theme then overrides. Antigravity script (`antigravity/statusline-blue.js`): bold-16 colours, model BLUE; quota % GREEN >=50 / YELLOW >=20 / RED (`:198`); agent-state tags (Thinking blue, Working blue, Responding cyan, Ready green, Pending yellow) at `:218-226`; PR colour by CI state (`:337-361`).
2. Themes: the Claude config selects ccstatusline's built-in `"tokyonight"` powerline theme (`claude-code/settings.json`, `powerline.theme`); the Antigravity script has none.
3. ccstatusline `colorLevel: 3` (truecolor). Antigravity script: bold ANSI-16 (`\x1b[1;34m` etc.) plus `\x1b[90m` grey; no NO_COLOR.
4. Claude config: background-filled powerline (`powerline.enabled: true`). Antigravity: foreground only.
5. Claude config: single powerline arrow separator (private-use glyph in `powerline.separators`), `separatorInvertBackground: [false]`, no caps; `autoAlign: true`. Antigravity: grey `|` and `└─▶`.
6. ccstatusline theme colours by position (see the ccstatusline sections of this file); Antigravity only separators.
7. Not present.
8. Powerline glyph requires patched font; Antigravity uses emoji (`🤖 📂 ⚠️ 🤔 ⚙️ 💬 🟢`).
9. Antigravity script also pushes status colours (hex `#34C759`, `#FFB300`, `#4C8DFF`, `#00E5FF`, `#8E8E93`) to a cmux sidebar (`:58-79`).
10. ccstatusline `~/.config/ccstatusline/settings.json` copied in; Antigravity has `settings.json.sample`.

## ccstatus-rs
https://github.com/folded/ccstatus-rs (stars: 0). A Rust port of daniel3303/ClaudeCodeStatusLine.
1. Fixed per segment plus thresholds. `src/color.rs:1-8` eight truecolor constants. `src/main.rs:462-537`: model BLUE; directory CYAN; context tokens ORANGE, `pct` GREEN, "cache" label WHITE, cache % GREEN >=80 / YELLOW >=50 / RED (`:495-499`); effort medium ORANGE, xhigh PURPLE, max RED, other GREEN (`:519-523`); version ORANGE. `usage_color` (`color.rs:12-19`): RED >=90, ORANGE >=70, YELLOW >=50, else GREEN. Cache warmth: "warm" GREEN / "cold" RED (`render.rs:59`).
2. Themes: not present as such. Only optional per-surface `background` hex in `~/.config/ccstatus/config.json` (`src/config.rs` doc, "`background` is a reserved per-surface key (`#rrggbb`)").
3. Truecolor SGR only; `#rrggbb` parsed in config (`config.rs:416`). No depth detection; NO_COLOR not present.
4. Foreground, plus optional whole-row background fill (`paint_background`, `main.rs:627-632`: `48;2;r;g;b`, re-asserted after each reset and padded to width).
5. Plain dim ` | ` (`render.rs:28-31`) and dim `·` inside segments.
6. Different hue per segment; dim separators.
7. Not present.
8. Unicode only (`█`, `·`); heatmap rows. No Nerd Font.
9. Two-row token heatmap: each cell `█` coloured by a Matlab-style "jet" function of the cell's percentile (`src/heatmap.rs:381, 398-404`), dim `·` for passed empty slots. tmux mode translates SGR to tmux `#[fg=#rrggbb]` styles (`src/render_tmux.rs:61-75`) so the same colours drive the tmux status bar.
10. Flags (`--no-heatmap`, `--no-tokens`, `--no-effort`, `--no-limits`), env `STATUSLINE_HEATMAP`, and `~/.config/ccstatus/config.json` mapping elements to layout/surface/region.

## pyccsl
https://github.com/forkni/pyccsl (stars: 0)
1. Fixed per field category, by theme. `pyccsl.py:240-277` `get_field_color`: folder -> theme "folder"; git -> "git"; model, weekly-limit and the `perf-*` fields -> "model"; input -> "input"; output, tokens, compact-remaining -> "output"; cost -> "cost"; badge always `38;5;244` grey. Default theme (`:131-138`): folder 208 orange, git 39 blue, model 141 purple, input 83 green, output 214 gold, cost 196 red. Badge dots use a fixed 4-colour heat `[82, 220, 208, 196]` (`:1184`).
2. Eight bundled themes plus `none` (`pyccsl.py:130-196`): default, solarized, nord, dracula, gruvbox, tokyo, catppuccin, minimal. Format = per-field colour map of six 256-colour indices (`folder, git, model, input, output, cost`). User-defined themes: not present (`--theme` / `PYCCSL_THEME` pick by name).
3. 256-index only (`38;5;N`, `48;5;N`, `apply_color` `:207-236`). No depth detection; NO_COLOR not present. `none` theme turns colour off.
4. Both: foreground-only in non-powerline styles; in `--style powerline` each segment is background-filled with the theme index and text forced to colour 0 (black, `:1672`).
5. Five styles (`--style`): powerline (U+E0B0 arrow, `:204`; arrow fg = segment bg, bg = next segment bg, last arrow on bg 0, `:1674-1680`), simple ` > `, arrows ` → `, pipes ` | `, dots ` · ` (`:1419-1426`). Adjacent fields with the same bg merge into one block (`:1655-1662`).
6. Different theme colour per field category (six hues); consecutive same-category fields share a background.
7. Fixed black text on every powerline background, with no contrast calculation; not adapted to terminal background.
8. Emoji prefixes by default; `--no-emoji` swaps them for short text labels (README). Powerline arrow needs a patched font; no separate Nerd Font set.
9. Context-window badge of coloured dots; many fields (cost, perf-*, compact-remaining), multi-line via a `newline` pseudo-field.
10. CLI flags (`--theme`, `--style`, `--numbers`, `--no-emoji`, `--no-cost`, `--debug`), env `PYCCSL_THEME`, positional comma-separated field list (README line 45). No config file.

## tabby-claude-usage
https://github.com/fqix/tabby-claude-usage (stars: 0)
not a Claude statusline: a Tabby terminal plugin that draws an HTML status bar at the bottom of the Tabby window showing Claude and Codex plan usage. For reference: usage colour is a 3-step threshold, `src/statusBar.ts:292-296` green `#57ab5a` / amber `#d4a72c` at `warnThreshold` (default 70) / red `#e5534b` at `criticalThreshold` (default 90, `src/config.ts:50-51`); provider brand colour `#d97757` (Claude) and `#10a37f` (Codex) from `src/providers/*.ts`; bar background and text inherit Tabby theme variables `--theme-bg-more` and `--theme-fg-less` (`statusBar.ts:20`). Thresholds editable in the plugin's settings page.

## claude-context-monitor
https://github.com/FrancescoASessa/claude-context-monitor (stars: 0)
1. By threshold for the context bar, fixed elsewhere. `cc-monitor.sh:86-91`: bar colour `C_ACCENT` (256-colour 74 blue, or grey) until DANGER_YELLOW 70 -> `C_YELLOW` (178), DANGER_ORANGE 85 -> `C_ORANGE` (208), DANGER_RED 95 -> `C_RED` (196). Model name `C_ACCENT`; rest of line 1 and the info line `C_GRAY` (245); empty bar cells `C_BAR_EMPTY` (238); "suggest reset" `C_RED` (`:201`).
2. Themes: not present. One variable `COLOR="blue"` (else grey) at `cc-monitor.sh:5,39-41` sets the accent.
3. 256-index only (`38;5;N`). No depth detection, no NO_COLOR.
4. Foreground only.
5. Plain ` | ` in grey on line 1; two spaces between info items on line 2.
6. Grey text with one accent word (model) and an emoji prefix on each item.
7. Not present.
8. Emoji per module (`📁 📜 ⏱ 💬 🔧 📂 🧠`), `█▄░` bar glyphs; no Nerd Font/ASCII mode.
9. Half-block `▄` marks the partial cell of the bar (`:102`). Nine `MOD_*` toggles.
10. Edit variables at top of `cc-monitor.sh` or override in `~/.cc-monitorrc` (sourced, `:28`): `COLOR`, `BAR_WIDTH`, thresholds, module toggles.

## claude-statusline (frank-bee fork of felipeelias)
https://github.com/frank-bee/claude-statusline (stars: 0). FORK OF felipeelias/claude-statusline; only what differs. Parent styling (style strings, `format` tokens, presets) is unchanged in kind.
- Presets are the same six (`internal/config/themes.go:41-47`: default, minimal, pastel-powerline, tokyo-night, gruvbox-rainbow, catppuccin). Differences in them: every preset now shows a `$usage` segment, which was disabled in the parent's powerline presets (`Disabled: false // every preset shows $usage`); the capsule/powerline format gains a usage cell after the last colour cell, with its own background (`usageBg`, tokyo-night `#292e42`) and an extra `plRight` arrow `fg:colors[4] bg:usageBg` (`capsuleFormat(colors, usageBg, trailing)`); `minimal` now sets `Separator = "  "` and appends `$usage`.
- New modules with the same threshold-style mechanism (`Thresholds: [{Above, Style}]` using `thresholds.warn/high` colours on the segment's own bg): `credits`, `windows` (`internal/modules/credits.go`, `windows.go`); `effort` and `output_style` modules (`modules/effort.go`, `outputstyle.go`), effort default style `bold yellow` and disabled in powerline presets.
- Renderer: `internal/render/render.go` adds a configurable `Separator` that splits the format into sections and drops sections whose visible text (ANSI stripped via `ansiEscapePattern`) is empty, so separators vanish with empty modules.
- Bars: `internal/modules/helpers.go` fills at least one cell for any non-zero percentage.
- Adds `scripts/render-preview.sh` and `scripts/ansi2png.py` for preview screenshots (`assets/preview.png`).
- Not verified: the parent's current state (fork is 20 commits behind), so some listed changes may reflect the parent being newer.

## p-claude-navbarmod
https://github.com/franscottadev/p-claude-navbarmod (stars: 0)
1. By state for one segment, otherwise uncoloured. `statusline-custom.sh:20-28` context % coloured GREEN (<50), YELLOW (>=50), RED (>=80) using plain SGR 32/33/31; active-plugin flag dots `● name` GREEN (`:51-55`). Model, token counts, 5h/7d limits are default text colour.
2. Not present.
3. ANSI-16 only (`\033[31m/32m/33m`). No depth detection, no NO_COLOR.
4. Foreground only.
5. Plain ` | ` between segments, uncoloured.
6. Separator only.
7. Not present.
8. ASCII text labels (`ctx:`, `sess:`, `5h:`, `7d:`), `●` for plugin flags.
9. Plugin tracker hook (`hooks/plugin-tracker.sh`) writes flag files that become green dots.
10. Edit the shell script; `install.sh`/`uninstall.sh`. No config.

## claude-monitor-limes
https://github.com/frazac/claude-monitor-limes (stars: 0)
Mostly a local web dashboard; the statusline part is minimal.
1. `statusline.py:62,418` one colour: model name in CYAN (`\033[36m`) inside `[ ]`; bar and numbers in default text colour. No thresholds in the terminal line.
2. Terminal line: not present. The web dashboard has light/dark theming (`js/app.js:154,1033-1043`: `localStorage` key `claude-monitor-theme`, falls back to `prefers-color-scheme`).
3. ANSI-16 (`\033[36m`) only; no NO_COLOR.
4. Foreground only.
5. Plain ` · ` between the 5h part; text parentheses.
6. Not differentiated.
7. Terminal line: not present. Dashboard adapts to system light/dark.
8. `█░` bar (`statusline.py:60-61`); no emoji/Nerd Font in the line.
9. Dashboard is the main product (weekly work-slot calendar, thresholds, demo gifs in light and dark).
10. Python scripts (`install-statusline.py`, `configure-slots.py`, `wizard.py`); dashboard settings in browser localStorage. Terminal line has no options.

## ccstatusline (fredericosantos copy)
https://github.com/fredericosantos/ccstatusline (stars: 0). Not marked as a GitHub fork, but its README, sources and badges are those of sirmalloc/ccstatusline (v2.2.x with gradients, bar styles); described from its own source.
1. By theme position or per-widget user choice. Without a powerline theme, each widget has `color` / `backgroundColor` set by the user, defaulting to the widget's `getDefaultColor()` (e.g. Model `cyan` `src/widgets/Model.ts:24`, GitBranch `magenta`, ContextPercentage `blue`); `src/utils/renderer.ts:320-322`. With a powerline theme, colours come from the theme by position: `themeColors.fg/bg[widgetColorIndex % length]` (`renderer.ts:329-333`); the index advances per rendered widget but not for a widget merged with the next (`mergesWithNext`, `:336-338`), and the counter continues across lines via `globalPowerlineThemeIndex` (`src/utils/powerline-theme-index.ts`). So colour is by position, cycling over the theme's 5 slots, not by segment identity. Widgets that "preserve intrinsic foreground" keep their own fg (`:326`).
2. Bundled powerline themes (`src/utils/colors.ts:350-519`): custom, nord, nord-aurora (default), monokai, solarized, minimal, dracula, catppuccin, gruvbox, onedark, tokyonight. Format: per-theme `{fg[5], bg[5]}` at three colour levels (1 = ANSI-16 names, 2 = `ansi256:N`, 3 = `hex:RRGGBB`), so a theme is a 5-slot palette of paired text/background colours, with text chosen per slot by hand (e.g. dark `#2E3440` on light bg). `custom` uses each widget's own `backgroundColor`. User themes: not present (the TUI picks bundled ones; per-widget colours are free-form including `hex:` and `ansi256:`).
3. Three levels selected by the `colorLevel` setting (default 2 = 256, `src/types/Settings.ts:70`; 1 = 16, 3 = truecolor), applied as `chalk.level` (`src/ccstatusline.ts:96`). The setting is user-chosen, not auto-detected here; each named colour has an ansi16, ansi256 and truecolor spelling (`colors.ts:15-52`). NO_COLOR: not present in these files.
4. Both: foreground-only in plain mode, background-filled cells in powerline mode, and per-widget `backgroundColor` in any mode.
5. Powerline arrows with start/end caps, user-defined lists with custom hex codes (`powerline.separators`, `startCaps`, `endCaps`, `separatorInvertBackground`); plain mode has `separator` widgets. Powerline separator colours: fg = previous widget's bg (via `bgToFg`), bg = next widget's bg; when two neighbours share a bg it uses the previous widget's fg on the next bg; inverted mode swaps (`renderer.ts:615-660`). Caps repeat by segment index modulo list length.
6. Adjacent cells differ by the theme slot's different background (5 hues per theme, cycling); same-bg neighbours are merged or drawn with the widget fg as the divider.
7. Text colour is a hand-picked per-slot `fg` in each theme (light text on dark slots, dark on light); `color-sanitize.ts` exists. No terminal-background detection.
8. Powerline glyphs need a patched font (the TUI has a font-install status, `PowerlineFontStatus.ts`); emoji in widget labels; no ASCII mode noted.
9. Gradients: per-widget foreground gradient with named presets or hex stops, and a whole-line foreground gradient (`overrideForegroundColor`, `renderer.ts:62-76, 464-560`); global override FG/BG; bold/dim; bar widgets with styles ("pill"); `flex-separator`.
10. Ink TUI (`src/tui/components/ColorMenu.tsx`, `PowerlineThemeSelector.tsx`, `PowerlineSeparatorEditor.tsx`, live `StatusLinePreview.tsx`); settings JSON (`~/.config/ccstatusline/settings.json`).

## claude-cli-plugin-usage
https://github.com/freejerry/claude-cli-plugin-usage (stars: 0)
1. Fixed per segment, with state on the context cell. `src/powerline.js:39-75`: model bg `theme.model`, branch bg `theme.git`, cost and rate-limit cells bg `theme.ratelimit`; context cell bg = `contextOk` / `contextWarn` / `contextDanger` by percent against `config.contextBar.thresholds` (`:16-19`); rate-limit text colour `contextDanger` at danger, else `textLight`; reset countdown text `contextOk` when within 1 h (`:34`). All cell text is `textLight` (white).
2. Three themes (`src/theme.js:3-47`): default, minimal (all cells 238 grey except warn/danger), solarized. Format = named roles with 256-index values: `model, git, contextOk, contextWarn, contextDanger, ratelimit, textLight, textDark, secondaryText, secondaryDim`. Selected by `theme` in the JSON config; user-defined themes not present (README roadmap: "Additional built-in themes").
3. 256-index only (`48;5;N`, `38;5;N`). No depth detection, no NO_COLOR found.
4. Background-filled cells (line 1) plus foreground-only second line (`secondaryText`/`secondaryDim`).
5. Powerline arrow U+E0B0 between cells, fg = previous bg, bg = next bg (`buildTransition`, `theme.js:~58`); trailing arrow to default bg (`49m`); remaining width padded with the last cell's bg (`powerline.js:116-123`).
6. Different background per segment role (blue model, purple git, state-coloured context, dark grey rate limit); arrows.
7. Two text colours per theme exist (`textLight`/`textDark`) but the code always uses `textLight`; no terminal detection.
8. Emoji in cells (`🧠`, `💰`) and powerline arrow; no ASCII mode noted.
9. Context mini-bar inside the cell; width-aware layout (`src/width.js`).
10. `~/.claude/claude-cli-plugin-usage.json` (`theme`, `contextBar.thresholds`, `ratelimit.thresholds`, block list); install via postinstall script.

## claude-statusline-ultimate
https://github.com/FrostBy/claude-statusline-ultimate (stars: 0)
1. Semantic roles mapped to segments, plus severity thresholds. `src/theme.js` `paint(key, text)` looks the key up in `config.colors` first (`:44-48`). Defaults (`src/config.js:21-24`): `model` cyan, `muted` gray, `ok` green, `warn` yellow, `crit` red, `info` cyan, `branch` magenta, `repo` blue, `dir` blue, `separator` gray. Widgets call roles: labels `muted`, branch `branch`, repo `repo`, dir `dir`, PR link by state, cache hit % `ok`>=80 / `warn`>=50 / `crit` (`widgets.js:153`), limits/context via `t.sev(pct)` which returns `ok`/`warn`/`crit` at config `thresholds` {warn 50, crit 80} (`theme.js:51-52`); bypass-permissions mode `crit`, other modes `warn`; added lines `ok`, removed `crit`. A limit projected to run out turns the whole segment `crit` (`widgets.js:22`).
2. Themes: not present as named bundles; the `colors` map is the theme (role -> ANSI name or `#rrggbb`) and users override per role in config.
3. Named ANSI-16 (30-37, 90-97) or truecolor hex (`code()`, `theme.js:36-41`). No downsampling. `NO_COLOR` honoured (`colorOn = config.color !== false && !process.env.NO_COLOR`, `:34`).
4. Foreground only.
5. Configurable plain-text separator (default three spaces, `config.js:15`) painted with the `separator` role; `'|'` entries in a line spec are drawn as grey dividers; rows are separate lines.
6. Muted grey labels against coloured values; segments grouped by `|` dividers; no per-segment hue assignment beyond roles.
7. Not present beyond NO_COLOR; README notes Cascadia glyph width issues.
8. Three icon sets (`ICONS` in `theme.js:12-30`): `unicode` (default), `ascii` (`git:`, `ok`, `x`, `#`/`-` bars), `nerd` (private-use glyphs, `█░` bars). Config `icons`.
9. TUI editor (`src/tui.js`), English and Russian (`src/i18n.js`), OSC 8 links (`links` option), burn-rate forecast, sub-agent rows; custom `text` and `cmd` widgets take `color`.
10. `colors`, `thresholds`, `icons`, `lines`, per-widget `widgets` options in a JSON config, plus the TUI; env `NO_COLOR`.

## plan-limits
https://github.com/fs666666/plan-limits (stars: 0)
Two parts: a Claude Code mod band (`hooks/register.tsx`, Ink) and a small `statusline/statusline.sh`.
1. Statusline (`statusline/statusline.sh:27-51`): fixed per segment in truecolor Catppuccin Mocha: directory `#89b4fa`, model `#cba6f7`, `·` separator `#6c7086`; effort by level (`:35-38`): low `#a6e3a1`, medium `#f9e2af`, high `#fab387`, xhigh/max `#f38ba8`. Mod band (`hooks/register.tsx:25-32`): "weather" bands by percent used, 0-25 yellow `☀ Clear`, 25-50 cyan `☁ Cloudy`, 50-75 blue `☂ Showers`, 75-90 magenta `☇ Storm`, above red `↯ Limit soon`; colours are Ink named colours (`<Text color={f.color}>`), so the terminal's own palette decides the hex.
2. Themes: not present (the README and the script both say Catppuccin only by comment).
3. Statusline: truecolor only. Band: named Ink colours (ANSI-16 mapped by the host). No NO_COLOR.
4. Foreground only.
5. Plain `·` in the statusline; `│` dim between groups in the band (`register.tsx:376`).
6. Separators and different hues per field.
7. Not present for the band beyond using the host's named colours (so it follows the terminal theme).
8. Weather glyphs `☀ ☁ ☂ ☇ ↯ ↻ ⚡` and moon-phase emoji ring style; a `WIDE` set (`register.tsx:135`) accounts for glyphs that draw two columns. Nerd Font not required.
9. Selectable ring styles (including moon phases) and `full` detail with a coloured bar; Chinese UI text.
10. Mod options in Claude Code (ring style, detail level); statusline is a shell script to edit.

## claude-plugins (FunDrivenDev)
https://github.com/FunDrivenDev/claude-plugins (stars: 0)
Contains `plugins/statusline` (deprecated, shell) and `plugins/session-mods` (Ink bar), plus unrelated plugins.
1. Statusline (`plugins/statusline/statusline.sh:74-82`): bold bright 256-colour roles GRAY 245, GREEN 82, YELLOW 226, ORANGE 214, RED 196, `ALERT` bold white on red bg (`1;97;48;5;196`), DIM 240, TEXT 250. By state: context tokens against the auto-compact trigger graded GREEN/YELLOW/ORANGE/RED by `WARN/DANGER/ALERT` percent, then `ALERT` block `⚠ COMPACTING` (`:314-318`); cache TTL countdown GREEN (>=50% left) / YELLOW (>=20%) / ORANGE, `EXP` RED (`:270-276`); quota bar fill GREEN, or the verdict colour past the pace mark (`:385-387`); effort `n/5` in the colours `/effort` uses (low `255;193;7`, medium `78;186;101`, high `177;185;249`, xhigh `175;135;255`, max rainbow per char, `:290-294`); git branch TEXT, dirty `*` ORANGE, PR review mark GREEN `✓` / RED `✗`. `session-mods/hooks/bar.tsx:15-40`: per-model colour (`claude-opus-5-5 #ef9f76`, `fable #ca9ee6`, `sonnet #8caaee`, `haiku #a6d189`) and per-effort colour, Catppuccin Frappé hexes.
2. Themes: not present as a selectable set. `bar.tsx:50-73` has a fixed dark-to-light twin map (Frappé -> Latte hexes) rather than themes.
3. Statusline: 256-index plus truecolor for effort; no detection, no NO_COLOR. Bar: hex.
4. Foreground, plus one background (`ALERT`).
5. Dim `│` between segments, dim `·` rows when `SPACING == 1` (`:235, 476`).
6. Mostly value-driven colour, dim separators; segments otherwise grey TEXT.
7. Yes in the bar: `readScheme` runs `defaults read -g AppleInterfaceStyle` (macOS only; dark elsewhere), re-read every 5 ticks, and `recolor` swaps every hex through a dark-to-light map (`bar.tsx:76-95`). Statusline: comment at `:72` notes the host dims output so it uses bold bright codes (`:72-73`).
8. Unicode and emoji (`⌛ 🔄 ⎇ ⚡ ✓ ✗`, `█░`); no Nerd Font/ASCII mode.
9. Quota bar with an even-pace tick (`│`); max-effort rainbow text; Catppuccin Frappé model colours matching the selector.
10. Environment variables for thresholds (`CC_TOKEN_WARN`, `CC_TOKEN_DANGER`, `CC_TOKEN_ALERT`, `CC_TOKEN_RESERVE`, segment count), documented in `docs/settings.md`; invalid ordering resets to 50/75/90 and prints `⚠ ignored` (`:66-69, 240`).

## tokenbar
https://github.com/Funnyyanne/tokenbar (stars: 0). Multi-provider (Claude, Codex, Kimi, ...) status bar.
1. By provider: whole line for a provider is one colour. `src/ai_cli_statusline/render.py:121,157`: `palette.colors.get(snapshot.provider)` applied as a prefix to the whole snapshot text, `palette.error` for errors. catppuccin-mocha: codex `#89b4fa`, claude `#cba6f7`, kimi `#a6e3a1`, error `#f38ba8` (`:25`). No per-field or threshold colour.
2. Four themes (`:24-28`): catppuccin-mocha (default), nord, dracula, default (ANSI-16 35/36/32/31). Format = `Theme(name, {provider: ansi}, error)`. User-defined: not present. Four progress-bar glyph styles (`PROGRESS_STYLES`): blocks `█░`, ascii `#.`, thin `▓·`, dots `●○`.
3. Truecolor SGR for named themes, ANSI-16 for `default`. `NO_COLOR` env and `--no-color` honoured (README lines 134, 156). No downsample.
4. Foreground only.
5. Plain `  │  ` between providers, ` · ` inside one.
6. A different hue per provider; same colour within a provider.
7. Not present.
8. ASCII-safe bar option (`ascii`), otherwise Unicode; control/format characters in log text sanitised (`render.py:112`).
9. Watch mode redraws on an alternate screen; screenshot SVG in `docs/`.
10. CLI flags `--theme`, `--progress-style`, `--no-color`; env `AI_CLI_STATUSLINE_THEME`, `NO_COLOR`.

## claude-token-tools
https://github.com/G-Machado/claude-token-tools (stars: 0)
The statusline is `bin/token-cycles.sh --status` inside a bash/awk token-budget toolkit; the rest is hooks plus a Windows WPF widget.
1. No colour: grep for `\033`, `\e[`, `\x1b` and `tput` in `bin/token-cycles.sh` finds none, so the status line is plain text (verdicts such as "CUT NOW" are text, `:1045`).
2. Not present for the terminal. The Windows desktop widget has a XAML theme (`windows/token-chat/src/TokenChat.App/Theme.xaml`, not a terminal; README describes spend split green/orange/blue).
3. Not present (no colour, no NO_COLOR).
4. Not present; unstyled text.
5. Plain text separators only.
6. Wording only.
7. Not present.
8. Not present in the status line.
9. Nothing styling-related in the terminal part.
10. Env vars for budgets (`TOKEN_ALERT_BUDGET` etc.), tier names; `install.sh` prints the `statusLine` + hooks block to merge into settings.

## hudcade
https://github.com/g761007/hudcade (stars: 0)
A Claude Code mod (Ink band above the prompt plus pixel-art spinner scenes), not a `statusLine` command.
1. Semantic roles resolved by Claude Code's own theme: segments carry `color: 'claude' | 'suggestion' | 'success' | 'warning' | 'error'` (`plugin/src/core/band.ts:26,63-285`). Mapping: model `claude` bold; project `suggestion`; git branch `success` clean / `warning` dirty; diff `+n` `success`, `-n` `error`; context bar and percent `success`/`warning`/`error` at `ctxWarnPercent` 60 / `ctxCriticalPercent` 80 (`band.ts:113`; README line 135); rate-limit bars `error` >=90, `warning` >=75, else `success` (`:132`); cache cold `warning`; working `claude`, waiting `warning`; current tool `suggestion`; failed tools `error`; agent rows by status. Everything else dim or default.
2. Themes: not present as hudcade's own; colours follow whichever Claude Code theme is active (role names are the host's). Spinner scenes use a fixed pixel palette (`scenes/kit.ts:11-33`, 21 hex constants) and each scene has an `accent` for the spinner word.
3. Role names (host maps to terminal/truecolor); pixel scenes truecolor. No NO_COLOR.
4. Both: foreground text in the band; pixel scenes drawn with half-block cells (`▀` U+2580, `▄`) carrying separate fg and bg colours (`scenes/canvas.ts:7-8, 53-83`).
5. Plain separators in the band; no powerline.
6. Not colour-differentiated beyond role hues; right/left sides with priorities.
7. Follows the host theme by using role names, so light/dark adaptation is Claude Code's.
8. Emoji and Unicode (`◆ ⎇ ◇ » ↻ ⚠ ●`); pixel art rendered as half blocks; Chinese README.
9. Ten animated 8-bit scenes (robot, coffee, garden, rocket, cat, fishing, train, campfire, weather, equalizer; `scenes/index.ts`) playing while Claude thinks, with spinner modes; Telegram hooks.
10. Plugin options (`plugin/src/core/config.ts`): scene choice (fixed or `random`), `ctxWarnPercent`, `ctxCriticalPercent`, layout toggles.

## cc-daily-usage
https://github.com/gagle/cc-daily-usage (stars: 0)
1. Mixed fixed and gradient/state. `assets/statusline.mjs`: repo bold yellow `220;200;0` (`:124`); branch bold teal `0;200;200` (`:127`); cost yellow `220;200;0`; duration grey; `+n` green `0;200;80`, `-n` red `220;40;20` (`:145`); model magenta `200;0;200` (`:148`); effort lavender (`:151`); rate limits blue `100;180;255` (`:170`), warnings red. Spend bar: 20 `█` cells each coloured by its position on the whole bar, green (`r` rises 0->220, g 200, b 80->0) to red (`g` falls to 40) at the 50% midpoint (`:99-121`), unfilled `60;60;60`; the percentage and emoji (✅/⚡/🔥/🚨 by pct band `:76-93`) use the matching colour. Today/month dollar segments coloured by `ccColor(frac)` (`:198-204`, spreadsheet-style 5 stops: `99;190;123`, `161;215;106`, `255;235;132`, `244;164;96`, `248;105;107`).
2. Themes: not present.
3. Truecolor only; no detection; no NO_COLOR.
4. Foreground only.
5. Dim grey `|` (`\x1b[2;38;2;120;120;120m|`, `:123`).
6. Separator plus distinct hue per field.
7. Not present (the unfilled bar cell `60;60;60` assumes a dark ground).
8. Emoji (`🌿 🤖 💪 ⏱ ⏲ 🎫`), block bar; no Nerd Font/ASCII mode.
9. Per-cell gradient bar coloured by absolute position so low usage stays green (comment `:96`). Also a calendar TUI (Ink) and init server for budget setup.
10. Config via `cc-daily-usage init` (days, caps) rather than colour options; no colour customisation.

## claude-statusline (Galfurian)
https://github.com/Galfurian/claude-statusline (stars: 0)
1. By state for bars, fixed for the rest. `statusline.sh:38-45` palette: DIM 245, TRACK 238, TEXT 252, GREEN 77, YELLOW 221, ORANGE 208, RED 203. `set_colour` (`:50-56`): pct >= `T_CRIT` 90 RED, >= `T_WARN` 75 ORANGE, >= `T_MEDIUM` 50 YELLOW, else GREEN, used for context and both rate-limit bars (`render_bar`, label DIM, brackets TEXT, track TRACK). Directory and model and cost TEXT; branch GREEN, ahead/behind YELLOW `↑↓`, dirty `●` ORANGE, detached ORANGE; `+n` GREEN / `-n` RED; worktree and duration DIM.
2. Themes: not present; one palette.
3. 256-index. NO_COLOR honoured: any value blanks every colour variable (`:34-36`). No depth detection.
4. Foreground only.
5. Dim ` · ` between items (`C_DIM`).
6. Dim separators, DIM labels vs TEXT values; hue only for state.
7. Not present.
8. Unicode only (`█░ ↑ ↓ ●`); `G_FILL`/`G_EMPTY` overridable (README line 92).
9. A non-zero percentage always shows at least one filled cell (`:66-67`). Context and rate-limit bars share width 10 so one cell is 10%.
10. Environment variables: `BAR_W_CTX`, `BAR_W_LIM`, `T_MEDIUM`, `T_WARN`, `T_CRIT`, `G_FILL`, `G_EMPTY`, `NO_COLOR`; installer flags.

## Claude-Live-Usage
https://github.com/GamerGodASN/Claude-Live-Usage (stars: 0)
1. Fixed per field plus thresholds. `statusline.py:17-25` 256-colour constants ORANGE 208, CYAN 44, GREEN 42, YELLOW 220, RED 203, GREY 245. `pct_color` (`:41-46`): RED >=80, YELLOW >=50, else GREEN for rate-limit and context percentages. Model: ORANGE `●` + bold name; session cost GREEN; today tokens CYAN and today cost GREEN; labels (`ses`, `today`, `ctx`) GREY; context tokens CYAN; project name DIM.
2. Themes: not present.
3. 256-index and SGR bold/dim. No detection; no NO_COLOR.
4. Foreground only.
5. `│` separator (GREY or default; one line example in README).
6. Grey labels with coloured values; separators.
7. Not present.
8. Unicode `●`, `↻`; no emoji or Nerd Font.
9. Same data feeds a browser dashboard and CLI table (`dashboard.py`, `cli.py`, scanner/db).
10. Edit the script; no config.

## GammaPluginTk
https://github.com/gamma2653/GammaPluginTk (stars: 0)
Marketplace of Claude Code plugins; the statusline is `plugins/statusline` (bash plus PowerShell twin).
1. By state for bars, fixed for the rest. `plugins/statusline/scripts/statusline.sh:41-45,75-87`: CYAN `[model·effort]` brackets, GREEN `+staged` / RED `!conflicts` / YELLOW `~unstaged` / FAINT `?untracked` / CYAN `↑↓` (`:178-183`), churn GREEN/RED, cost YELLOW (`:195`), durations and token counts FAINT. Progress bars use `bar_color(pct)`: a continuous truecolor gradient green `90,200,90` -> amber `235,185,90` at 70% -> red `240,65,70` at 100% (piecewise linear, `:75-87`); unfilled cells fixed grey `110,110,110` (`TROUGH`, `:45`).
2. Themes: not present; README says to edit the RGB endpoints in `bar_color` / `Get-Color` (`README:167`).
3. Mix of ANSI-16 SGR (36/32/31/33, 2) and truecolor for bars. No detection, no NO_COLOR.
4. Foreground only.
5. Plain double-space gaps and FAINT `·`; no glyph separators.
6. Faint vs normal text and hue per item; no separators beyond spacing.
7. Comment at `:43-44` notes the trough grey was chosen to be visible on a dark background (80,80,80 vanished); no detection.
8. Unicode bars with eighth-block partial cells (`PARTIALS` `▏▎▍▌▋▊▉`, `:50`) for ~8x resolution; emoji elsewhere in the plugin. No ASCII/Nerd Font mode.
9. Continuous gradient rather than three cutoffs (README line 32); separately coloured filled vs empty halves so the bar does not read as a solid block (comment `:53-55`).
10. No colour config; edit script constants; plugin install via marketplace scripts (`scripts/install.sh`, `update.sh`).

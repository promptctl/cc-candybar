# Batch 52: styling in 25 Claude Code statusline projects

All repos list 0 stars. Anchors are `file:line` or `file` key, read from raw source at HEAD.

## libaoming/claude-statusline-theme
https://github.com/libaoming/claude-statusline-theme (stars 0)
1. Three separate scripts, one per theme, sharing `lib.sh` data. Powerline `themes/powerline.sh:12-22`: fixed bg per segment by position/role: model 173 (orange), dir 238, branch 240, context = threshold bg, session/today tokens 60, duration 236, alert 160. Context bg by level (`lib.sh` CTX_LEVEL: 0 / >=70 / >=90; `powerline.sh:9` 71 green, 178 amber, 160 red). `claude.sh`: foreground only, fixed warm palette (clay model, ivory dir, stone dim, olive/amber/crimson context). `minimal.sh`: no colour except context text yellow >=70, red >=90.
2. Three bundled themes = three files (`themes/powerline.sh|claude.sh|minimal.sh`). No palette roles, each file hard-codes its colours. `switch.sh` lists/previews/switches; users can add a `themes/<name>.sh` (switch.sh scans `themes/`).
3. powerline uses 256-index (`38;5;N`/`48;5;N`); claude.sh uses truecolor (`38;2;r;g;b`, comment "needs truecolor"); minimal uses ANSI 16 (`\033[33m`). No depth detection, no NO_COLOR.
4. powerline: bg-filled cells. claude/minimal: fg-only.
5. powerline: U+E0B0 arrow, `seg()` at `powerline.sh:12-15` draws arrow with fg = previous bg, bg = next bg (true blended arrow); final arrow fg = last bg on default bg. Fallback char via `STATUSLINE_PL_SEP` (e.g. `▶`). claude: dim `│`. minimal: dim `·`.
6. powerline: different bg per segment (hue/lightness), arrow blending. claude/minimal: separators only.
7. powerline picks text `38;5;235` dark on the orange/amber/green bgs and `38;5;255` light on grey bgs (`powerline.sh:8`), hand-paired, no computation. No light/dark detection.
8. Nerd/Powerline font needed for arrow only; `⎇`, `▰▱`, `━─` bars; claude theme says "no emoji". ASCII-ish fallback only for the arrow (`STATUSLINE_PL_SEP`).
9. `switch.sh` rewrites `~/.claude/statusline.sh` into an exec wrapper; `preview` renders all themes with a sample JSON. `STATUSLINE_LANG=zh` labels.
10. Bash scripts; `config.local.sh` (STATUSLINE_LANG, STATUSLINE_ALERT_FILE/TEXT, STATUSLINE_PL_SEP); `switch.sh list|current|preview|<theme>`.

## lightningjim/claude_statusline
https://github.com/lightningjim/claude_statusline (stars 0)
1. `.examples/statusline-command.sh:23-29,82-86`: threshold colour via `perc_color` (>=90 red, >=70 yellow, else green) applied to context bar and the 5h/weekly rate percentages. user@host bold green and cwd bold blue copied from the author's PS1 (`:86`). Everything else uncoloured.
2. Themes: not present.
3. ANSI 16 only (`\033[31m` etc., `:14-22`). Detection / NO_COLOR: not present.
4. Foreground only.
5. Separators: plain text `|` and brackets (`:59,89-91`), uncoloured.
6. Neighbours: brackets and `|` only.
7. Not present.
8. Emoji (⏳🗓️🌅🌇🌃🌧️), `▓░` bar (`:78-83`). No fallback.
9. Fetches weather from wttr.in every render (`:51`). `install.py` is an installer only (not read for colour).
10. Edit the shell script. `.examples/` dir is an example; `install.py` copies it.

## lilicocon/CCometixLine (FORK OF Haleclipse/CCometixLine)
https://github.com/lilicocon/CCometixLine (stars 0)
The parent has since been restructured (parent HEAD has no `src/ui/themes/`; `src/style/color.rs` and `src/tui/dialogs/color.rs` instead), so this fork keeps the older theme architecture. Compare against merge base a73b166: fork is 18 commits ahead, 86 behind.
1. Differences in styling: adds three segments that borrow another segment's palette instead of defining their own: `prompt_cache` takes `cost_segment().colors` and `mode` takes `model_segment().colors` and `usage_weekly` takes `output_style_segment().colors` (`src/ui/themes/theme_powerline_dark.rs` end of file, comments "Cost's palette", "Model's palette", "Output style's palette, so the 7-day window reads apart"). New opt-in options `show_200k_marker` (context shows `⚠ >200k`, `context_window.rs:122`) and `show_five_hour_reset`. Otherwise same model as parent: per-segment ColorConfig {icon, text, background} in each theme file, with `Color16{c16}` / `Color256{c256}` / `Rgb{r,g,b}` (`config/types.rs`, `statusline.rs:292-355`).
2. Nine bundled presets (`presets.rs:111-121`): cometix, default, minimal, gruvbox, nord, powerline-dark, powerline-light, powerline-rose-pine, powerline-tokyo-night. Format = per-segment colour map; users save/load TOML themes from `~/.claude/ccline/themes/<name>.toml` (`presets.rs:36-60`). TUI has `color_picker.rs`, `theme_selector.rs`, `icon_selector.rs`.
3. Colour space chosen per colour value (16/256/RGB); no depth detection, no NO_COLOR (grep of src finds neither).
4. Powerline themes: bg-filled (e.g. dark: model 45,45,45; dir 139,69,19; git 64,64,64; context 55,65,81; cost 40,44,52; session 45,50,59; usage 45,50,59). default/cometix: fg-only c16 colours (model cyan 14, directory yellow icon/green text, git blue 12, context magenta 13, cost 3, session 2).
5. When separator == U+E0B0, arrow fg = previous bg, bg = current bg (`statusline.rs:407-420`); any other separator is drawn white `\x1b[37m` (`:138`).
6. Powerline dark neighbours differ by small lightness steps of a grey, plus the arrows; default theme by hue per segment.
7. Separate light theme (`theme_powerline_light.rs`), chosen by the user, no detection.
8. Nerd Font or emoji icons per segment (IconConfig plain/nerd_font), switch via StyleMode.
9. Interactive TUI configurator with preview; segment ordering.
10. JSON/TOML config in `~/.claude/ccline`, `--config` TUI, `--theme` flag (parent behaviour).

## linuxiscool/claude-statusline
https://github.com/LinuxIsCool/claude-statusline (stars 0)
1. Semantic palette roles per theme layout, with explicit mapping: `lib/themes.py:72-82` context % and bar = `info`, `:83-86` cost = `warn`, `:115-131` git branch = `ok`, ahead = `info`, behind = `warn`, persona tag = `accent` (or a persona colour from `resolve_persona_color`, `lib/colors.py:~360`). Threshold: `_severity_color(value, warn_at, error_at, palette)` `:1112`, `_rate_color` <50 ok, 50-80 warn, >80 error. Labels `fg_dim`.
2. 9 bundled palettes (`lib/colors.py`): catppuccin mocha/macchiato/frappe/latte, nord frost/aurora/polar, solarized dark/light. Format = frozen `ColorPalette(bg, fg, fg_dim, ok, warn, error, info, accent, separator)`, all `#RRGGBB` validated. Layouts ("themes") are code classes (classic, hw, observatory, zen, narrative, fleet, memory_palace, economics, git_forge, heartbeat, archaeologist, rice, gpu, grid...) each with a `default_color_scheme`; colour scheme and layout cycle via `scripts/cycle_theme.py`. Users: only by editing Python.
3. Truecolor hex source, downsampled at emit time to 256 or 16 by `_rgb_to_256` / `_rgb_to_16` (`colors.py` `_color_escape`), depth from `terminal_caps.detect()`. Honours NO_COLOR (docstring top of `colors.py`: emits "" for everything, including bold/dim).
4. Foreground-only; `bg` is a palette field but layouts draw text with `styled()`.
5. Plain text separators: ` │ ` grid separator, ` → ` topic chain in `fg_dim`; a `_hline` helper.
6. Neighbours: separators plus role hue (ok green / info blue / warn yellow).
7. Includes light palettes (latte, solarized_light) as default of the `narrative`/`fleet` layouts; chosen by layout, not detected.
8. Nerd Font icons via `icon('git_branch')`, emoji, box drawing for grids (2155 box-glyph lines).
9. Persona colour table `_FALLBACK_PERSONA_COLORS` (Catppuccin Mocha named colours); GPU/CPU hardware layouts with temperature severity colours.
10. Python plugin; `/theme` command (`commands/theme.md`), `cycle_theme.py color next|prev|set|list`; state file stores `color_scheme`.

## lion231226/glmcode (FORK OF kiritoko1029/glmcode)
https://github.com/lion231226/glmcode (stars 0)
Fork is 0 commits ahead and 4 behind the parent (GitHub compare, status `behind`), so there is no styling difference. Not independently read; the file set (`src/ui/themes/theme_powerline_*.rs`, `color_picker.rs`, `theme_selector.rs`) shows it is the same CCometixLine-derived architecture described in the lilicocon section.

## liush2yuxjtu/minimax-statusline
https://github.com/liush2yuxjtu/minimax-statusline (stars 0; statusline for the MiniMax provider in Claude Code)
1. By state/threshold plus fixed per role: directory `dir_color`, branch `branch_color`, separator `sep_color` fixed per theme (`themes/default.toml:5-7`); effort word coloured by level (`minimax-statusline.sh:431-437`: default/low/medium/high+max); context % by 3 buckets (`:446-448` high/mid/low vs `GREEN_BELOW`/`YELLOW_BELOW`); 5h bar colour by 3 buckets; errors by kind.
2. 4 bundled TOML themes (`themes/default|minimal|vivid|solarized.toml`; docs list those four, scan also saw monokai). Format = flat keys + `[effort] [bar] [ctx] [error]` tables, values are colour names. Users: set `display.theme` to a path to their own .toml (`docs/themes.md`), or `STATUSLINE_THEME=` env.
3. ANSI 16 names only: black..white, `bold_*`, `faint`, `dim` (`color()` at `minimax-statusline.sh:62-85`). No depth detection. NO_COLOR honoured: zeroes all codes (`:54-57,64`).
4. Foreground only.
5. Separator glyph in theme (`sep_glyph` `│` / `▌` / `|`), coloured by `sep_color` (default `dim`) (`:414-415`).
6. Neighbours: separator glyph only.
7. `minimal` theme for colourless terminals; `vivid` described as accessibility/bright on dark. No detection.
8. Emoji default (🌿 🔋 ⚡ 🪫), unicode in solarized (`❦ ▰▱ ☀◐☁`), pure ASCII in minimal (`@`, `#/.`). Chosen by theme.
9. Battery-style 5h bar; icon swaps by remaining %.
10. TOML theme files, config (`display.theme`, thresholds), env STATUSLINE_THEME, NO_COLOR, `--dump-config`.

## ll931217/claude-hud-enhanced
https://github.com/ll931217/claude-hud-enhanced (stars 0; Go)
1. Almost uncoloured. The only colour applied in the files read is the context bar: `theme/ansi.go:18-26` `ContextColor` >=85 red (256 #203), >=70 yellow (#215), else "" (comment "No color for low usage (user request)"), used in `sections/contextbar.go:65,113`; `Dim` for breakdown text. A semantic `Theme` struct (Background, Primary, Secondary, Muted, Success, Warning, Error, Info) exists (`theme/theme.go`), only Catppuccin Mocha, and `config.Colors` mirrors it with defaults (`config.go:35-44,179-199`); whether any section reads `cfg.Colors` is unverified (not seen in files read).
2. One bundled palette (Catppuccin Mocha, hex); users can override seven role colours in YAML `colors:`. No theme switching.
3. Mixed: hex palette in the struct, but the live code path emits fixed 256-index ANSI (`38;5;40/215/203`). No detection, no NO_COLOR.
4. Foreground only.
5. Separators are plain text, ` | ` default, per-line override (`config.go` `LineConfig.Separator`; `statusline.go:323-327`).
6. Separator only.
7. Not present.
8. `icons.go`: each icon has a Nerd Font form and an ASCII form (e.g. GitBranch `` vs `branch`); emoji for some.
9. Responsive layout that drops sections by width (`responsive.go`).
10. YAML config (lines/sections/separator/colors/responsive), Go binary + `scripts/claude-hud-statusline.sh`.

## lokesh2021/homebrew-claude-status
https://github.com/lokesh2021/homebrew-claude-status (stars 0)
1. By state and fixed role: bright-colour constants `bin/claude-status:21-25`: model bold white, branch bright cyan `⎇`, user dim, duration dim. Thresholds: context/rate `:220-222` >=90 red, >=75 yellow, else green; cost `:228-230` >=$0.20 red, >=$0.05 yellow; inverted "HP" colours for game modes `:266-272`; XP green, distance cyan, streak yellow, boss warning red.
2. Themes: not present. "Game modes" (rpg, space, tamagotchi, dungeon, streaks, invader; `:41`) change content, not palette.
3. ANSI 16 bright (`\033[91-97m`). No detection, no NO_COLOR.
4. Foreground only.
5. `join_segs` ` · ` dim (`:253-254`).
6. Separator only.
7. Not present.
8. Emoji heavy (🐉 🔥 etc.) plus `⎇`; blocks `█░`. No fallback.
9. Gamified: fuel, XP, boss; reads `/dev/tty` for width (`:185`).
10. `jq` config file with `game_mode`; `claude-status mode <name>` command.

## LolerHero/claude-cockpit
https://github.com/LolerHero/claude-cockpit (stars 0; a plugin whose status line is `statusline/statusline.mjs`)
1. By role from a semantic palette: seven roles named by meaning not hue (`palettes.js:5-6`): muted (separators, secondary), subtle (readable default), gold (uncommitted/warnings), love (detached head, context nearly full, alerts), foam (room to spare, lines added), iris (accent), track (unlit bar cells), base. Mapping `statusline.mjs`: model = muted, dir = subtle, branch = subtle clean / gold dirty (`*`) / love detached (`:~170-178`), ahead/behind muted, `+N` foam, `-N` love, context bar = 5 `▪` cells with traffic light by cells lit (1-2 foam, 3-4 gold, 5 love; `bar()` `:62-66`), clock subtle.
2. Four bundled palettes: rose-pine (default), catppuccin-mocha, tokyo-night, `ansi` (names `gray/white/yellow/red/cyan/magenta` so the terminal's own theme rules). Format = 8 roles -> hex or ANSI name; chosen via the plugin `palette` option in Claude's config menu, read back from `settings.json` `pluginConfigs`. Users cannot add palettes without editing the file.
3. Hex -> truecolor `38;2`; names -> 16-colour SGR (`sgr()` `:25-29`); unknown names default 37. No depth detection, no NO_COLOR.
4. Foreground only.
5. Plain ` │ ` in `muted` (`:56`), `  ·  ` on the right group.
6. Separators plus role hue.
7. The `ansi` palette follows terminal colours; no polarity detection or contrast calc.
8. `glyphs` option: `nerd` (nf-fa-file, clock) or `plain` words (`:57-58`).
9. Right-aligned cockpit group; priority-based dropping to fit width (`prio` per segment).
10. Plugin options in Claude Code config menu (`palette`, `glyphs`); `setup.mjs` installs.

## lololopez200123/claude-code-statusline
https://github.com/lololopez200123/claude-code-statusline (stars 0)
1. Palette of 8 env vars per theme, mapped to segments by position/role: CYAN=user, BLUE=dir, MAGENTA=git, YELLOW=model, GREEN=context & low plan%, RED=high plan%, DIM=time and separators (`statusline-command.sh:227-233`, and theme-file comments `themes/deep-crimson.theme`). Threshold: plan 5h/7d <50 green, 50-79 yellow, >=80 red (`:153-160`, using the theme's GREEN/YELLOW/RED slots, so themes remap what "red" is).
2. 7 bundled `.theme` files: deep-crimson, hot-pink-neon, midnight-neon, royal-violet, sakura-rose, terminal-matrix, ultraviolet-neon (repo `themes/`). Format = bash snippet setting CARD_BG, CYAN, BLUE, MAGENTA, YELLOW, GREEN, RED, DIM (truecolor SGR strings, hex in comments) plus THEME_DISPLAY_NAME/THEME_VIBE. Users add files to `~/.claude/statusline-themes/`. Scan also saw catppuccin/dracula/tokyo-night as bg examples in comments (`:60-64`).
3. Truecolor and 256 SGR strings written directly; built-in defaults ANSI 16. No depth detection, no downsampling; NO_COLOR is not read in the files (signal count 1 unverified).
4. Both: "card mode" paints the whole line on one bg `CARD_BG` (`:53-64,85,104-108`), with soft resets (`22;23;24;39m`) so the bg survives; fg per segment.
5. Dim ` | ` (`:111`).
6. Neighbours: different fg hues, a single shared card bg, `|` separators.
7. Hot-pink theme comment: orange for high-% alerts "to avoid clash with pink bg" (hand-chosen per theme, no computed contrast). No polarity detection.
8. Minimal glyphs (branch icon).
9. `statusline-theme` CLI: fzf picker, list, preview-all with captured JSON, `set`.
10. `~/.claude/statusline-theme.conf`; env `STATUSLINE_CONFIG`, `STATUSLINE_THEME_DIR`, `STATUSLINE_ENGINE`; every colour env-overridable.

## LorenzoNu/carbonero-statusline-claude
https://github.com/LorenzoNu/carbonero-statusline-claude (stars 0; Peñarol football fan statusline)
1. By model and by threshold. Model name colour per family (`statusline.sh:38-44`): fable 196, opus 135, sonnet 214, haiku 245 (256-index) with a different emoji string each; branch fixed 214 ("same yellow as Sonnet's"); context icon/colour by %: >=80 blinking red `\e[5;31m` + ☣️, >=70 208 orange, >=60 yellow, else green (`:46-49`); 5h limit `limit_color` >=80 red, >=60 yellow else green (`:70-75`); weekly colour compares usage with the share of the week elapsed (`:99-105`: green if at or under pace, yellow within 15 points, red beyond). Club line: gold truecolor `245,200,0`, silver `200,200,210`.
2. Themes: not present.
3. Mix of ANSI 16, 256 index and truecolor, no detection, no NO_COLOR.
4. Foreground only.
5. Plain ` | `.
6. Separator only.
7. Not present.
8. Custom icon font "Penarol Icons" private-use glyphs (`gothic()` maps letters to U+100100.., installer ships `fonts/PenarolIcons.otf`), emoji. No fallback.
9. Blinking SGR 5 as a danger state; pace-relative colour for weekly quota; second line of club trophies.
10. Edit the script; `install.sh`.

## loucadgarbon/cc-cost
https://github.com/loucadgarbon/cc-cost (stars 0)
1. By threshold ratio only: `statusline.js:19` `color(ratio, s)`: >=1.0 red, >=`warnAt` (default 0.8) yellow, else uncoloured; applies to ctx (ratio to handoff %), session spend vs cap, today and month budgets, 5h window. Savings `↓$` green. Rest uncoloured; "cost n/a" dim.
2. Themes: not present for the statusline.
3. ANSI 16 raw (`\x1b[33m/31m/32m/2m`). No depth detection, no NO_COLOR.
4. Foreground only.
5. Dim `|` (`:58`).
6. Separator only.
7. The HTML dashboard (`lib/dashboard.js:2,44-49`) is light/dark aware via `prefers-color-scheme` and `data-theme`, with a hand-tuned 8-series categorical palette per scheme; not the statusline.
8. `⇄` handoff mark, `↓`; plain text.
9. Dashboard: single-file inline SVG charts.
10. `lib/config.js` JSON (`defaults.warnAt`, budgets, modes), `cc-cost` CLI.

## lrashhcad-hub/ClaudeTeamUsage
https://github.com/lrashhcad-hub/ClaudeTeamUsage (stars 0)
1. By threshold: `skill/claude-team-usage/tools/statusline.sh:130-136` `pct_colour`: >= CRIT (90) bold red, >= WARN (70) yellow, else no colour; whole line wrapped in `DIM` (`:195`). Both thresholds env/config (`CTU_WARN_PCT`, `CTU_CRIT_PCT`).
2. Themes: not present.
3. ANSI 16 only (`:61`). `CTU_COLOR=never` strips all codes; NO_COLOR itself not read. Comment `:50-57` warns against `[ -t 1 ]` gating, since stdout is a pipe.
4. Foreground only.
5. Configurable `CTU_SEPARATOR` (default ` | `) in dim.
6. Separator only.
7. Not present.
8. None.
9. Segment order configurable (`CTU_SEGMENTS=dir,model,5h,7d`); shared-team-account usage pool label.
10. `~/.config/claude-team-usage/config.env`; environment overrides win over the file.

## lsg1103275794/claude-code-statusline
https://github.com/lsg1103275794/claude-code-statusline (stars 0)
1. By threshold, 4 tiers, two directions. `statusline/format.js:65-79`: remaining-style (context left) <=10 red, <=25 orange (256 index 208), <=50 yellow, else green; used-style (quota) >=90 red, >=75 orange, >=50 yellow, else green. Fixed per segment elsewhere (`render.js`): model name cyan, effort magenta if "hot" else gray, `+N` green / `-N` red, PR label blue with review mark (approved green ✓, changes_requested red ✗, pending yellow ◔, draft gray ◌; `:144-158`), worktree `⑂` and agent `◆name` orange/magenta.
2. Themes: not present.
3. ANSI 16 names plus one 256 index (orange `38;5;208`) (`format.js:7-25`). NO_COLOR honoured (`useColor()` `:5`). No depth detection.
4. Foreground only.
5. Dim ` · ` (`render.js:9`).
6. Separator only.
7. Not present.
8. `━─` bar (filled coloured, empty dim), `⇢` ETA, `↻` reset, `⑂` `◆`. No fallback.
9. Replicates Claude Code's auto-compact threshold maths (`threshold.js`) so the context colour tracks time-to-compact rather than raw %.
10. `statusline-pricing.example.json` (pricing), env vars; no colour settings.

## LTnanana/claude-code-config
https://github.com/LTnanana/claude-code-config (stars 0; "claude-bar")
1. Per theme file, functions per segment (`theme_dir`, `theme_git`, `theme_context`, ...). Powerline theme `claude/themes/powerline.sh`: fixed bg per segment: dir blue, git green, tokens yellow, context green/yellow/red (>50 yellow, >80 red), time & memory grey, model magenta, today cyan, month red. Nerd theme: fg-only, context bar colour green/yellow/red >50/>80 (`nerd.sh:67-70`), git `+N` green `-N` red.
2. 6 bundled themes = 6 bash files: ascii, compact, emoji (default `statusline.sh:16`), minimal, nerd, powerline. Format = shell functions, no palette table. Users: drop a file in `~/.claude/themes/`.
3. ANSI 16 only (`\033[44m` bg etc.). No depth detection, no NO_COLOR.
4. powerline: bg-filled. others: fg-only.
5. powerline: U+E0B0 arrow after each segment, fg = that segment's own colour (`PL_SEP`), no next-bg, so the arrow sits on the terminal's default background and points at the next filled cell without blending. nerd: dim `│` (`nerd.sh:32`). ascii: space; `[DIR:x]` brackets.
6. powerline: distinct hue per segment; others separators only.
7. black text on green/yellow/cyan bgs, white on blue/magenta/grey bgs (hand-paired); no detection.
8. Four glyph tiers via themes: ASCII (`[DIR:...]`), emoji, Nerd Font (`NF_*` codepoints), Powerline.
9. Section toggles and order in config (`SECTION_*`, `SECTION_ORDER`).
10. `CONFIG_FILE` sourced by `statusline.sh` (THEME, SECTION_*), `setup.sh` installer.

## Lucagdev/claude-code-statusline
https://github.com/Lucagdev/claude-code-statusline (stars 0; Python)
1. Semantic roles per widget, with thresholds. `widgets.py` mapping: model name `primary` (bold), model id/duration/paths `muted`, cost `success`, tokens in `info`, tokens out `secondary`, tokens total `text`, branch/links `accent`, lines `+` `success` / `-` `danger`, vim mode/warnings `warning`. Utilisation: `_pct_color` (`:132-139`): >=80 `danger`, >=60 `warning`, else `accent` for context bar and 5h/7d bars.
2. 7 bundled themes (`themes.py`): tokyo-night, catppuccin (mocha), gruvbox, nord, dracula, rose-pine, warm ("earthy tones like allthingsclaude/bar"). Format = 9 semantic roles (`primary, secondary, accent, info, success, warning, danger, muted, text`) as hex (docstring `:1-5`). Selector (`selector.py`) and `configure.py` TUI choose; no user-defined themes in code (dict `THEMES`).
3. Truecolor only (`_hex_to_ansi_fg` `:14-16`). No detection, no downsampling, no NO_COLOR.
4. Foreground only; per-widget `fg` override (`config.py:16`) replaces all fg codes in the widget by regex (`format_widget` `:144-163`).
5. Dim `│` (`render.py:16`, "No powerline arrows - minimal and readable").
6. Separator only.
7. All themes dark; no light variant or detection.
8. Emoji/ASCII light (`%` bars etc.); no Nerd Font.
9. Per-widget hex override, multi-line layouts with widget lists in config.
10. JSON config (`theme`, `lines[].widgets[{id,fg}]`), interactive `configure`, `build.sh` single-file build, Windows `install.ps1`.

## lucas-lima-duarte/claudometer
https://github.com/lucas-lima-duarte/claudometer (stars 0)
1. By pace, then state. `scripts/statusline.sh:112-157`: context uses `pct_color` <50 `GREEN`, <75 `MODEL_COLOR` (orange/yellow slot), else `RED`. 5h and weekly use `pct_color_paced`: green when usage is below the floor of the active time segment ("ahead of pace"), orange within it, red beyond it. Bright variants for the active filled cell. Labels use `ORANGE` slot (nord: frost blue, dracula: purple). Model name `MODEL_COLOR` bold.
2. 3 bundled themes via `CLAUDOMETER_THEME` = fuel (default) | nord | dracula (`statusline.sh:16`, `set-theme.sh`; header comment says mono/neon, stale). Format = a `case` block setting 6 state-palette variables (GREEN, GREEN_BRIGHT, MODEL_COLOR, ORANGE_BRIGHT, RED, SALMON, ORANGE; `:43-60`). Structure style is a separate axis: `CLAUDOMETER_STYLE` segmented|blocks|compact. Users edit script.
3. fuel: ANSI 16 + 256; nord/dracula: truecolor (`38;2`). Theme-selected, no detection, no NO_COLOR.
4. Foreground only; blocks drawn with `━ ─` / `█ ░` glyphs.
5. Bar divider glyph `▪` in grey 90 (segmented) (`:214`).
6. Pace-colour only; neighbours separated by padded labels.
7. Not present.
8. `en`/`pt` label sets; unicode bars; no Nerd Font.
9. `set-theme.sh` rewrites env prefix on the statusLine command in settings.json; README images generated with `ansi2svg.py`.
10. Env vars `CLAUDOMETER_THEME|STYLE|LANG` in the statusLine command; `/claudometer:theme` skill.

## LUCASDREYER/claude-ui
https://github.com/LUCASDREYER/claude-ui (stars 0; mostly a Minecraft bridge, `statusline/statusline.py` is a plain statusline)
1. By threshold and fixed (`statusline.py:77-80,87-92`): model cyan, directory blue, `git:branch` magenta, context `ctx NN% used/size` red >=80, yellow >=50, else green.
2. Themes: not present.
3. ANSI 16 SGR codes (`DIM, RED, GREEN, YELLOW, BLUE, MAGENTA, CYAN = "2","31",...`). NO_COLOR honoured (`COLOR = "NO_COLOR" not in os.environ`, `:12`). No depth detection.
4. Foreground only.
5. Dim ` │ ` (`:96`).
6. Fixed hue per segment plus dim separator.
7. Not present.
8. None.
9. Reads `.git/HEAD` directly (no subprocess).
10. None (edit script); stdlib only.

## lucasmm96/claude-statusline
https://github.com/lucasmm96/claude-statusline (stars 0)
1. `scripts/statusline-command.sh:132,159-164`: line is `Model: <cyan> | Context: <threshold> | Tokens: <magenta>`; context SGR 31 >=80, 33 >=60, else 32.
2. Themes: not present for the statusline. The `report/` web dashboard reads CSS variables so chart colours follow the page theme (`report/js/theme.js:1-12`, `--tc-input|cache-read|cache-write|output`).
3. ANSI 16. No NO_COLOR.
4. Foreground only.
5. Plain ` | `.
6. Fixed hue labels plus separator.
7. Dashboard only (CSS var reader); statusline none. A light/dark toggle in report JS was not found in `config.js`/`main.js`.
8. Emoji minimal.
9. Primary purpose is logging sessions to `statusline-sessions.json` with optional git backup; HTML report with Chart.js.
10. `~/.claude/statusline-backup.conf`; `STATUSLINE_PROFILE` env.

## lucasram20/claude-mods
https://github.com/lucasram20/claude-mods (stars 0; `statusline/` package, plus a better-diff mod)
1. Fixed per segment + level: `statusline/src/runtime/theme.ts:23-36` PALETTE: claude `#d97757` (model with `✻`), branch purple, staged green, modified yellow, untracked red, ahead/behind cyan, clean calm green, music teal, artist blue-gray, time blue, divider slate, bar-empty. Context bar and percent by `levelColor` (`:46-47`): <45 green, <70 yellow, <85 orange, else red (`bar.ts`: bg-filled solid cells).
2. One fixed palette (`as const satisfies Record<string, Rgb>`); no theme switching.
3. Truecolor by default; macOS `Apple_Terminal` gets nearest 256 cube entry (`theme.ts:10-17`, `to256`). NO_COLOR/depth env flagged in scan (env.NO_COLOR=1) but not seen in the files read.
4. Both: context bar is background-filled spaces (`bar.ts`), text is fg-only.
5. Dim slate ` | ` (`line.ts:14,33`).
6. Fixed hue per segment type plus dividers.
7. Not present.
8. `✻` starburst (Claude Code's own glyph), `♪` and a unicode wave for the music line.
9. Now-playing music line with mini waveform and clickable buttons; adapts to terminal width.
10. TypeScript installer (`installer/cli.ts`) patches settings.

## LuiserFarzati/ccstatusline
https://github.com/LuiserFarzati/ccstatusline (stars 0; not marked as a GitHub fork, but the code is a Jan-2026 snapshot of sirmalloc/ccstatusline: same `src/utils/colors.ts`, `powerline.ts`, `PowerlineThemeSelector.tsx`; parent HEAD has since diverged ~185 diff lines in colors.ts, so no styling of its own was found)
1. Per widget colour chosen by the user in the TUI (`widget.color`, `widget.backgroundColor`), or in powerline mode by position: `renderer.ts:181-195` colours cycle by `widgetColorIndex % theme.bg.length` with a 5-colour list, merged widgets share a colour; theme overrides widget fg/bg unless theme is `custom`. Custom commands can `preserveColors`.
2. 10 named powerline themes + `custom` (`colors.ts` POWERLINE_THEMES): nord, nord-aurora, monokai, solarized, minimal, dracula, catppuccin, gruvbox, onedark, tokyonight. Each defines `fg[]`/`bg[]` of 5 entries for three colour levels (1 = 16, 2 = 256, 3 = truecolor hex). Users: `custom` uses per-widget colours; `customize` copies a theme's colours onto widgets.
3. Named colours (Black..BrightWhite, bg variants) with per-level mapping; `ansi256:N` and `hex:RRGGBB` custom forms (`colors.ts:85-110`); `settings.colorLevel` 0-3 sets `chalk.level` (`ccstatusline.ts:61`); default level 2. No NO_COLOR read in the files seen.
4. Both: powerline mode is bg-filled; normal mode is fg and optional bg per widget.
5. Powerline caps and separators are lists (default U+E0B0), with `separatorInvertBackground` per separator: separator fg = previous bg and bg = next bg (or inverted), same bg uses next fg (`renderer.ts:326-360`). Start/end caps lists. Font check `checkPowerlineFonts` + installer (`powerline.ts`).
6. Neighbours: cycle through the 5 theme colours (modulo), so lightness/hue steps depend on the theme; separators blend.
7. `minimal` theme and solarized choose dark text `073642` on light bgs and light text on dark bgs, hand-paired per theme; global `overrideForegroundColor`.
8. Powerline glyph font; emoji in some widgets.
9. Ink TUI with live preview, global bold, flex mode.
10. `~/.config/ccstatusline/settings.json`, TUI; `npx ccstatusline`.

## luisromano-gf/claude-statusline-config
https://github.com/luisromano-gf/claude-statusline-config (stars 0)
A settings file for the real ccstatusline (`npx -y ccstatusline@latest`), plus a Python usage widget.
1. `ccstatusline-settings.json`: per widget colour in line 1 (model cyan, context-percentage-usable brightBlack, git-branch magenta, git-changes yellow); lines 2-3 are bg-filled (cwd bgBrightMagenta, session-clock bgYellow, usage custom command bgBrightCyan).
2. Uses ccstatusline powerline theme `minimal` (`powerline.theme`), no theme of its own.
3. `colorLevel: 2` (256), named ANSI colours; no NO_COLOR handling.
4. Both (line 1 fg-only, lines 2-3 bg-filled).
5. `separators` and caps are powerline glyphs (private-use, stripped in the dump), `separatorInvertBackground: [true]`, `inheritSeparatorColors: false`.
6. Different bg per widget plus arrows.
7. Not present.
8. Powerline glyphs.
9. `claude-usage-widget.py` prints usage limits with no ANSI codes (no colour calls found).
10. JSON for ccstatusline; `flexMode: full-minus-40`, `compactThreshold: 60`.

## m-a-c-m/macm-hudclaudecodeskill
https://github.com/m-a-c-m/macm-hudclaudecodeskill (stars 0)
1. By theme accent plus threshold: `hooks/pulse_statusline.py:28-39,83-89`: theme gives (bright, dim) pair; bright for model `◈`, context bar and today's messages; dim for CACHE/COMPACT/session; bars and 5H/7D go yellow (256 #220) >=70 and red (#196) >=90, else the theme's bright.
2. 5 themes: cyan, green, purple, orange, mono (`THEMES` dict of 256-index bright/dim pairs). Chosen in `config.theme`; web config UI shows swatches (`pulse_config_ui.py:183-200`). No user-defined themes.
3. ANSI 256 index only. No detection or NO_COLOR (scan flagged an env 256color mention).
4. Foreground only.
5. Dim ` │ ` (`:12,151`); can wrap into two lines (`:258-259`).
6. Separator only.
7. Not present.
8. `█░` bar, `◈`; no icons font.
9. Localhost browser config UI (binds 127.0.0.1) to toggle each component and pick theme/language (en/es).
10. JSON config with `show.*` toggles, `theme`, `language`; `pulse_config_ui.py`.

## m16khb-org/oh-my-statusline
https://github.com/m16khb-org/oh-my-statusline (stars 0; multi-harness: Claude, Codex, omp, OpenCode)
1. Hybrid: fixed per segment by family plus thresholds. Chips (`domain/render/palette.ts`): model chip by family regex (opus purple, sonnet cyan, haiku teal, fable orange, gpt purple, gemini blue, deepseek purple, kimi cyan, glm teal, qwen orange, grok slate, else silver; `MODEL_FAMILIES` `:128-140`); effort chip max red / xhigh orange / high yellow / medium teal / else slate (`effortColors`); dir chip blue; git chip green, yellow when dirty, red on conflicts (`statusline.ts:121-130`); PR chip teal/red/slate/cyan by state; env chips ssh orange, tmux silver, venv teal, k8s purple. Usage ink: `levelColor` <50 green, 50-64 yellow, 65-79 orange, >=80 red; bars use `gradient()` green until 35%, then blended green->yellow->orange->red (OKLCH not used, linear RGB `mix`, `palette.ts:196-208`).
2. Two ink sets, `dark` and `light` (`INK`), `theme: auto|dark|light` (`config.ts:10,43`); chip backgrounds are the same in both. Not user-extensible except by source.
3. Truecolor or 256 via `rgb256`; `colors: auto|truecolor|256|none`, auto reads `COLORTERM` (24bit/truecolor -> 24 else 256), NO_COLOR non-empty wins over everything (`config.ts:156-164`). Mode 0 drops all SGR but keeps OSC-8 links.
4. Both: chips bg-filled, ink text on terminal bg.
5. Powerline arrow U+E0B0 between chips, fg = previous chip bg, bg = next; thin arrow U+E0B1 when adjacent chips share a colour; end arrow (`statusline.ts:40-60`). Glyph modes: powerline | plain | ascii.
6. Distinct hue per chip, arrows blend; thin arrows when equal.
7. `theme: auto` uses the desktop appearance (injected `appearance`) to pick ink set; light ink is darker and desaturated. Chip text is fixed dark (26,27,38) on all chips (light text on slate only).
8. Three glyph sets: powerline (Nerd/PL), plain unicode, 7-bit ASCII (`GLYPHS`, `glyphSet` also gives a distinct bar track when colour is off).
9. Responsive degrade ladder (drops chips at narrow width), OSC-8 hyperlinks on PR chips, `tools/render_png.py` renders screenshots.
10. Env `STATUSLINE_THEME|GLYPHS|COLORS`, config file, `install` CLI per harness.

## mabhub/claude-statusline
https://github.com/mabhub/claude-statusline (stars 0)
1. By level on a fixed 9-step ramp: `QUOTA_COLORS` (dark green, green, light green, yellow, amber, orange, red, crimson, violet; `statusline.sh:147`) with glyph arrows `↓ ↘ → ↗ ↑ ↟` per step (`:148`). Quota gauges pick the step from projected usage (thresholds 75/81/86/91/95/100/105/110, `:149`); context gauge picks the step from token count not % (`CTX_THRESHOLDS`, in thousands: 60, 90, 120, 150, 175, 200, 300, 400); cache gauge from minutes since last response. Effort word coloured per level (`:317-337`): low/medium/high/xhigh pairs for dark vs light, `max` rainbow. Cost/version grey `38;5;248`, newer-version yellow.
2. No themes; one `CLAUDE_STATUSLINE_THEME=light|dark` that only switches the effort colours (`:20-21,321-326`).
3. Truecolor (`38;2`/`48;2`) for the ramp, 256 index for greys (`TRACK 48;5;250`), ANSI 16 for green/blue. No depth detection, no NO_COLOR.
4. Both: gauges are bg-filled cells with eighth-block glyph partial cells (fg and bg in two colours per cell, `gauge_dual` `:260-266`), text elsewhere fg-only.
5. Dim ` | ` between groups, lighter grey ` | ` between "light" blocks (cost, version, account) (`:635-636,664`).
6. Groups divided by separators; inside a gauge, neighbouring segments differ by darkened/lightened level colour (30% dark for early consumption, grey for elapsed time).
7. `contrast_text` picks text for a gauge by luminance: darkens bg by half if lum > 110, else lightens 70% to white (`:170-180`); the theme hint reads GNOME `color-scheme` via `gsettings` when `CLAUDE_STATUSLINE_THEME` is unset (`:322`), comment says the script has no TTY so cannot query the terminal.
8. Unicode partial-block gauges, `◷` cache, `❺❼` quota labels. No Nerd Font.
9. Dual gauge draws used quota and elapsed time in one bar; quotas shared across sessions via cache.
10. `CLAUDE_STATUSLINE_BLOCKS` (order, `|` placement), `_ACCOUNT`, `_PROJECTS_DIRS`, `_PROJECTS_ICON`, `_THEME`; read from env or `~/.config/claude-statusline/config` (parsed as data, never sourced).

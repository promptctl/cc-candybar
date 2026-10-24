# Batch 58: styling deep-dive

All stars n/a to the scanner (0 listed). Anchors are files in each repo, read via raw.githubusercontent.com.

## psymboll/bestiary
URL: https://github.com/Psymboll/bestiary (stars 0)
Statusline that prints a random ASCII animal (89 of them) after each response; colour is for the animal only.
1. One random colour per animal, not per segment: `bestiary/render.py` `pick_color(seed)` = `random.Random("color:"+seed).choice(palette)`; `colorize` wraps the whole art+label block in that one colour. Separate RNG salts for animal and colour so they are not pinned together (`render.py:_ANIMAL_SALT/_COLOR_SALT`).
2. Two palettes, `dark` and `light`, 10 named colours each (`bestiary/colors.py` `DARK`, `LIGHT`: coral, amber, gold, lime, mint, sky, periwinkle, orchid, rose, sand / crimson, rust, olive, forest, teal, navy, indigo, plum, maroon, slate). Format = ordered tuple of (name, escape code). Choice via `BESTIARY_PALETTE` env only; no user-defined palettes.
3. 256-colour foreground only: `_fg(i)` -> `\033[38;5;{i}m` (`colors.py`). No truecolor, no downsampling. Honours `NO_COLOR` (`color_enabled()`).
4. Foreground-only text on the terminal's own background (no `48;` codes anywhere).
5. Separators: not present (single art block).
6. Neighbour distinction: not present (one colour for the whole block).
7. Light/dark adaptation is the notable part: `bestiary/theme.py` `detect_palette()` order = `BESTIARY_PALETTE` override, then Claude Code's own `theme` key read from `settings.local.json`/`settings.json`/`$CLAUDE_CONFIG_DIR/settings.json` (a value containing "light"/"dark"), then `COLORFGBG` (background code in `{7,9..15}` = light), else dark. The two palettes are deliberately disjoint hues, light set runs deep because pastels vanish on white (docstring in `colors.py`). No contrast calculation.
8. ASCII art animals; no Nerd Font or emoji requirement.
9. Palette follows Claude Code's own theme setting (rare). `refreshInterval: 2` in the example settings.
10. Env var `BESTIARY_PALETTE`; `NO_COLOR`; no config file for colours.

## pthexton/muxclaude
URL: https://github.com/pthexton/muxclaude (stars 0)
1. Fixed per segment plus threshold. `statusline.sh:307/448` model is always CYAN `[model]`; ctx/5h/7d bars use `usage_bar()` (lines 125-136): >=90 red, >=70 yellow, else green; cost YELLOW (346, 460); worktree tag DIM; separators DIM `|`. Sidebar section headings (lines 332-382) each get a fixed bold colour: Usage MAGENTA, Session YELLOW, Workspace BLUE, CI GREEN, Tasks CYAN, Keys DIM. Task states: completed dim, in_progress green, blocked red (171-174); CI checks pass green, fail red, pending/cancel yellow, skip dim (265-269).
2. Themes: not present. Palette is 6 hardcoded ANSI names (`statusline.sh:96-97`).
3. ANSI 16 only (`\033[3Xm`, bold 1, dim 2). No depth detection, no `NO_COLOR` handling.
4. Foreground only.
5. Separator is plain ` | ` in DIM (lines 453-460); sidebar uses `── Heading ──` rules.
6. Neighbours distinguished by ` | ` separators and the fixed-hue-per-section scheme in the sidebar; no lightness steps.
7. No light/dark adaptation; relies on DIM (SGR 2) and base ANSI colours that the terminal remaps.
8. Emoji/box-drawing in a tmux sidebar (`sidebar-loop.sh`), block glyphs `█░` for bars; no ASCII fallback.
9. Multi-pane tmux sidebar mode (`sidebar-loop.sh`) is a second render of the same data as sections.
10. Shell scripts, no config file; `install.sh` wires it.

## pubespattamapulchai/mha-statusline
URL: https://github.com/PubesPattamapulchai/mha-statusline (stars 0)
PowerShell statusline themed on My Hero Academia characters.
1. Per-segment role colour from a per-character theme, other segments fixed. `statusline.ps1:170-` `$Themes` hashtable gives each theme three colours: `Quirk` (model + rank + level bar, `$C_QUIRK`, line ~1197 `rankPart`, `quirkPart`), `Agency` (directory, `$C_AGENCY`, mostly `Ansi 97` bright white), `Cooldown` (5h rate-limit text, `$C_COOLDOWN`). Separator ` · ` is fixed `Ansi256 244` grey (line 164 comment: "content carries the theme color, not punctuation"). Motto fixed bold 256-colour 201 (heroes) or 196 (villains) (~1300). Not threshold-driven: rate-limit text is one theme colour regardless of value.
2. Themes bundled: 108 character themes (`set-theme.ps1:38` "cycles through all 108 themes"; list in `$ThemeOrder` `statusline.ps1:1078-1106`). Format = per-theme map {Label, QuirkIcon, Quirk, Agency, Cooldown, Hero}, colours as `Ansi256 n` or `Ansi n`. Selected by `$env:MHA_STATUSLINE_THEME` > `~/.claude/mha-theme.txt` > default `auto` which rotates a theme every 5h/108 (time-bucket, `statusline.ps1:1128-1131`, shared by parallel sessions). Users can add themes by editing the script only.
3. 256-colour and base ANSI: `Ansi256 n` = `38;5;n` (`statusline.ps1:74`), `Ansi n` base SGR. No truecolor, no depth detection, no `NO_COLOR`.
4. Foreground only.
5. Separator: plain ` · ` in dim grey, same colour always.
6. Neighbours distinguished by theme-hue segments vs grey dots; Agency is near-white so Quirk vs Agency vs Cooldown differ by hue.
7. Not present (dark-terminal assumption, grey 244 fixed).
8. Emoji heavy (per-theme quirk emoji, `$QUIRK_ICON`), progress glyph pair that changes with level thresholds (`▰▱` -> `▮▯` -> `★☆` -> `◆◇` -> `●○` -> `■□` at Lv 5..40, ~1245) and box-drawing level-up banner (`Get-LevelUpBanner`, line 142).
9. Gamification: rank/level derived live from `rate_limits.seven_day.used_percentage` (Lv1-100, `Get-LevelFromWeekPct`); level-up banner when crossing a multiple of 10; per-theme colour is the only colour. `assets/themes.svg` gallery.
10. PowerShell scripts; `set-theme.ps1` interactive menu or `-Theme <key>`; `/mha-theme` command (`commands/mha-theme.md`); env var `MHA_STATUSLINE_THEME`.

## purelife12181-droid/claudecode-statusline
URL: https://github.com/purelife12181-droid/ClaudeCode-Statusline (stars 0)
Byte-identical `statusline-command.sh` to danielmackay/claude-code-statusline (diffed, no differences), so same styling as that parent.
1. Only three ANSI colours in the script: GREEN for `+staged`, YELLOW for `~modified` in the git string, and green/yellow/red for rate-limit text by percentage (>=90 red, >=70 yellow, else green; `format_rl`). Everything else (model, effort, ctx, cost, dir, worktree, branch name) is uncoloured terminal default text.
2. Themes: not present.
3. ANSI 16 (`\033[32m` etc). No detection, no `NO_COLOR`.
4. Foreground only.
5. Plain ` | ` separators, newline between two rows, emoji as segment labels.
6. Neighbours distinguished only by emoji prefixes and ` | `.
7. Not present.
8. Emoji (🤖💪🧠💰⏱️📁🌳🌿) as labels; `make_bar` builds `█░` (no ASCII fallback).
9. Nothing else.
10. Edit the script.

## pytagoraspublishing/pytagoras-agent-plugins
URL: https://github.com/pytagoraspublishing/pytagoras-agent-plugins (stars 0)
Plugin collection; `plugins/statusline/statusline.py` (and a copy at `.claude/statusline.py`, plus `plugins/book-latex/utilities/statusline/statusline.py`, the latter two not diffed) is a Python port of cc-statusline's "detailed" generator output.
1. Fixed per segment plus thresholds (`statusline.py:36-91`): dir sky blue 38;5;117, model light purple 147, model version soft yellow 180, CC version light gray 249, output style gray 245, git branch soft green 150, tokens lavender 189, cost light gold 222, burn rate bright gold 220. Context by remaining %: <=20 coral 203, <=40 peach 215, else mint 158 (`context_color_by_pct`). Session timer by remaining %: <=10 pink 210, <=25 light yellow 228, else light green 194.
2. Themes: not present as a colour theme; header says `Theme: detailed` which is a layout name.
3. 256-colour fg (`\033[38;5;Nm`). `NO_COLOR` honoured (`use_color = os.environ.get("NO_COLOR") is None`, line 23). No depth detection.
4. Foreground only.
5. Plain two-space gaps, emoji prefixes; no separator colour.
6. Neighbours distinguished by distinct fixed pastel hues per segment and emoji.
7. Not present, pastel palette assumes dark background.
8. Emoji labels (📁🌿🤖🏷️📟🎨🧠⌛📊💰) and `█░`-style bars.
9. Soft pastel palette ("modern sleek colors" comment) is the design stance.
10. `settings.example.json` only; no colour config. `uv run --script`.

## qcko/claude-code-progress-bar
URL: https://github.com/Qcko/claude-code-progress-bar (stars 0)
not a Claude statusline: background-task progress add-on (hooks plus a Tk always-on-top timer overlay `heartbeat/heartbeat.py`); its "statusline" is a one-line text summary `⏳ 2 bg [npm test 0:47 | pytest 3:12 ⚠]` with no ANSI colour. The only colours are in the Tk overlay (`heartbeat.py:98-178`: bg `#1a1a1a`, text `#e0e0e0`, `[!]` rows `#ffd166`, `[!!]` rows `#ff6b6b`), so the state-colour mapping is hang severity, drawn in a separate window, not in the bar.

## qdsfdhvh/cc-tri-statusline
URL: https://github.com/qdsfdhvh/cc-tri-statusline (stars 0)
1. Fixed per segment plus threshold. `statusline.sh:408-412`: model CYAN bold, directory BLUE, branch MAGENTA with GREEN `+staged`, YELLOW `~unstaged`, DIM `?untracked` (218-222), JDK YELLOW (240), vim NORMAL BLUE else GREEN (247), version/session/token text DIM. Context bar and % by utilisation (`pct_color`, 93-99): <=12 TEAL 38;5;46 (bright green), <=20 AMBER 226, <50 CORAL 208, else CRIT 196 — note tight thresholds (red at 50%). The bar is a per-cell gradient (`build_bar`, 109-142): each filled cell is coloured by its own position along the bar using the same four bands, with eighth-block partials `▏..█` and empty cells `░` in EMPTY_COLOR. At >=90% the whole line starts with a red-background warning badge `BG_RED`+bold white ` CTX n% ` (410). Cache/cost values coloured by an awk band (v<2 yellow, <5 226, <15 208, else 196; ~391-396).
2. Themes: only light vs dark, not a palette set. `detect_theme()` lines 41-53: `STATUSLINE_THEME` env, else macOS `defaults read -g AppleInterfaceStyle` (-> dark), else `COLORFGBG` background <8 = dark, else dark.
3. Mix of ANSI 16 (CYAN GREEN etc) and 256-colour (TEAL/AMBER/CORAL/CRIT, EMPTY_COLOR). No truecolor, no `NO_COLOR`.
4. Foreground, with one background-filled badge (BG_RED when context >=90%).
5. Separator `SEP="${DIM} │ ${RST}"` (line ~87), DIM only.
6. Neighbours distinguished by distinct fixed hues per segment and `│` separators.
7. The theme switch changes only the neutral colours: light theme DIM=`\033[90m`, WHITE_BOLD=`1;30` (black), EMPTY_COLOR 250; dark theme DIM=`2`, WHITE_BOLD=`1;37`, EMPTY 237 (61-69). Hue colours are not changed per theme.
8. Nerd Font icons (󰚩 model, 󰍛 ctx, 󰝰 dir, 󰘬 git, 󰄉 cost, 󰥔 clock, 󰕷 vim, JDK), eighth-block bars. No ASCII fallback.
9. Gradient memory bar (per-cell colour by position) is the distinguishing feature; 3-line layout.
10. Env var `STATUSLINE_THEME`; installer `install.sh`; edit script otherwise.

## qeridoo/statusline-builder
URL: https://github.com/Qeridoo/statusline-builder (stars 0)
Browser-based builder that exports a plain-Node statusline script (EN/DE UI); also a "cheat sheet" SVG/PNG exporter.
1. Per-segment colour spec resolved by value, in `src/color.js` `resolveColor(spec, value)`: `static` (hex), `threshold` (sorted `[at, hex]` stops, last stop with value >= at wins), or `gradient` (`from`,`to` hex, `min`,`max`, linear RGB interpolation, `t` clamped). Defaults in `src/catalog.js`: shared presets `USAGE` (0 `#7ec699`, 50 `#e0c46c`, 75 `#e5a95f`, 90 `#e06c75`), `INVERSE` (reverse, for "remaining"), `BURN` (-100 green, 0 amber, 10 red). Fixed colours: TEXT `#c8ccd4`, MUTED `#8a90a0`, ACCENT `#a78bfa` (model), GREEN `#7ec699` (branches, lines added), RED `#e06c75` (lines removed), BLUE `#6cb6ff` (project dir, PR), amber `#e0c46c` (cost, fast mode, 200k flag). Context, 5h and 7d limits use USAGE; ctx-left and pace use INVERSE. Per-segment `bold`/`dim` flags.
2. Themes: not present; no theme concept. Colour is set per segment in the builder UI (colour picker for static, mode switch to gradient, `src/ui.js:98-113,436-439`). Exported config JSON can be re-imported.
3. Truecolor only: `hexToAnsi` -> `38;2;r;g;b` (`color.js`), comment "every terminal Claude Code runs in supports it". No downsampling, no `NO_COLOR`.
4. Foreground only (no background code in `ansiWrap`).
5. Separator is a user string per line (default ` | `), rendered dim by default (`dimSeparator !== false`, `render.js:52-56`); no powerline.
6. Neighbours distinguished by separators plus per-segment colours; no automatic mechanism.
7. Not present.
8. Emoji per segment, user can blank or replace (`showEmoji`, `emoji` field; default emoji in `catalog.js`); label text optional.
9. The live HTML preview shares `buildLines` with the real renderer, so the preview cannot drift (`render.js` header comment); colours are validated `#rrggbb` before interpolation into markup.
10. Browser UI (single inlined `index.html`), exports script / handover prompt / JSON config; state in localStorage.

## qianzitech/cc-statusline-for-deepseek
URL: https://github.com/QianziTech/cc-statusline-for-deepseek (stars 0)
FORK OF chongdashu/cc-statusline: styling differs not at all in what I could compare. `src/features/colors.ts` is byte-identical to the parent's (diffed, empty diff), and the colour calls in `src/generators/bash-generator.ts` are unchanged; the fork is an older snapshot of the parent (parent has since added v1.4.0, a jq-less bash JSON fallback and a script-local log file; none of that is styling). For reference, the inherited scheme: fixed 256-colour fg per segment (dir 38;5;117, model 147, model version 180, CC version 249, output style 245, git 150, tokens 189, cost 222, burn 220), context colour by remaining % (<=20 203, <=40 215, else 158), session timer by elapsed (210/228/194), `NO_COLOR` honoured (`colors.ts` `[ -n "$NO_COLOR" ] && use_color=0`), foreground-only, emoji labels, plain-space separators, `Theme: minimal|detailed|compact` is a layout choice, not a palette.

## questi0nm4rk/qsm-marketplace
URL: https://github.com/Questi0nM4rk/qsm-marketplace (stars 0)
Plugin marketplace of many `qsm-*` plugins; only `plugins/qsm-statusline` is a statusline. Other flagged files (`qsm-secrets/qml/askpass`, `qsm-uix/lib/color.ts` WCAG contrast maths) are unrelated to the bar.
1. Severity tone by percentage, shared across all meters, plus fixed colours (`plugins/qsm-statusline/lib/render.ts`): `severity()` (lines 56-69) >=80 red, >=50 orange (38;5;208), >=25 yellow, else green; applied to context bar+%, session and week bars+%. Comment: "One scale for every percentage on the line. A second scale would mean the same colour meant two different amounts of trouble." Fixed: model bold green, context-size CYAN, git branch green, `clean` green, staged `+n` green, modified `~n` orange, untracked `?n`/conflicts `!n` red, separators `|` gray (38;5;245), "resets in" dim.
2. Themes: not present (`CODES` table, lines 24-34: reset, bold, dim, red, green, yellow, cyan, orange, gray).
3. Base ANSI 16 plus two 256-colour entries (orange 208, gray 245). Colour off via `--noColor` flag on the `render` command (`qsm.json`, `scripts/cli.ts:91`); `NO_COLOR` env not read; also disabled for `--json`.
4. Foreground only.
5. Separator ` | ` in gray (`join()`, line ~122).
6. Neighbours distinguished by labelled text (`context:`, `git`, `session:`, `week:`) and gray `|`; hue not used for identity apart from model green.
7. Not present.
8. Block bars `█░` with width constants, no emoji/Nerd Font.
9. Designed so absent sources drop their segment ("a source that is unavailable is omitted, and the render always succeeds"); git state is a background-refreshed cache (`lib/gitcache.ts`).
10. CLI flags (`--cwd`, `--noColor`), `doctor` subcommand prints the settings.json entry; no colour config.

## qutaiba-khader/claude-code-helper
URL: https://github.com/Qutaiba-Khader/claude-code-helper (stars 0)
Web builder (`tools/statusline/`) that emits a bash statusline from a JSON `CONFIG`.
1. Per-field colour name chosen by the user in the builder; generated script maps names to SGR (`statusline.sh:143-162`): `black..white`, `grey` = 38;5;244, `dim` = 2, `bold-<name>`, and `cNNN` = 256-colour index. Special modes: `heat` (green <50, yellow 50-79, red >=80; lines 183-192) and `ramp` (10 bands by percent, default list `c46,c82,c118,c154,c190,c226,c220,c214,c208,c196`, i.e. green -> yellow -> orange -> red; `ramp_colour`, lines 167-182; user can supply their own comma list). The sample config (line 11) uses bold-blue cwd, bold-yellow branch, bold-cyan model+ctx, grey separators, ramp for token bar and rate limits, dim effort.
2. Themes: no output themes. `tools/statusline/app.js:36-84` bundles 9 terminal schemes (VS Code Dark+, Windows Terminal Campbell, One Dark, Dracula, Nord, Gruvbox Dark, Solarized Dark/Light, macOS Terminal Basic, GitHub Light) each as {bg, fg, 8 normal, 8 bright hex}; these are used only to PREVIEW what base ANSI names and 256 indices will look like in the builder, not written into the script.
3. ANSI 16 names plus 256-colour indices in the output; no truecolor. The script has no `NO_COLOR` handling (the NO_COLOR/FORCE_COLOR hits are in the web tools). The builder previews xterm-256 (`xterm256(n)`).
4. Foreground only (bold/dim attributes).
5. Separators are `text` fields in a row, coloured by name (the sample uses grey `|`); `rule` field draws a `─` line. Aligned grid layout (columns padded to common widths).
6. Neighbours distinguished by user-chosen names plus text separators.
7. The builder preview lets the user check light schemes (Solarized Light, GitHub Light, macOS Basic); the output itself does no adaptation. `statusline.sh:12-27` picks a UTF-8 locale so width maths work.
8. Box-drawing for the rule, emoji in builder; no Nerd Font.
9. OSC 8 hyperlink for PR URL (`statusline.sh:495`); ANSI-aware width measurement (641-646).
10. Browser UI with per-field colour picker and swatches (including a ramp swatch, `app.js:721`); JSON config embedded in generated script.

## r-neves/claude-code-status-bar
URL: https://github.com/r-neves/claude-code-status-bar (stars 0)
Go binary.
1. Theme role to segment, plus threshold. `internal/status/theme.go` `Theme` struct has eight roles (Blue, Orange, Green, Cyan, Red, Yellow, White, Magenta). `render.go` maps: hostname Magenta, model Blue, directory Cyan, branch+parens Green (dirty `*` Red, `+n` Green, `~n` Yellow), PR `#n` Blue (Green if approved), agent name Orange, effort `● high/xhigh/max` Magenta else dim glyph, cache % Green>=70 / Yellow>=40 / dim, cost Green <2, Orange >=2, Yellow >=5, Red >=10, labels/values White, separators and unit text `Dim`. `colorFor(pct)` for context, rate limits and bars (`theme.go:colorFor`): >=90 Red, >=70 Yellow, >=50 Orange, else Green.
2. Six bundled themes in `themes` map: `default`, `dracula`, `catppuccin`, `solarized`, `mono`, `plain` (all empty, for NO_COLOR). Format = semantic eight-role struct, truecolor `rgb()` values. Selected by `--theme` or `CLAUDE_STATUSLINE_THEME`. No user-defined themes (compile-time map).
3. Truecolor only (`\033[38;2;r;g;bm`). `NO_COLOR` honoured: swaps in the `plain` theme (`main.go:68-70`). No 256/16 downsampling.
4. Foreground only (plus `Dim` SGR 2).
5. Separator `" " + Dim + "│" + Reset + " "` (`render.go:82`), always dim; priority-based dropping of segments when width is short (`joinFit`).
6. Neighbours distinguished by distinct role hue per segment and the dim `│`.
7. Not present; `mono` theme exists as a hue-free option.
8. Emoji labels (💻📂🤖🪟💾💰⏱⟳), five bar styles (`line ━─`, `classic ●○`, `block █░`, `braille ⣿⠄`, `geometric ▰▱`) via `--bar`; no Nerd Font.
9. Three row layouts (`compact`, `ultra`, `full`), terminal-width fitting (`width.go`), OSC 8 PR link (`termLink`).
10. CLI flags `--theme --bar --layout --bar-width --width --extra`, env vars `CLAUDE_STATUSLINE_THEME/BAR/LAYOUT`, `--themes`/`--bars` listings.

## rafagomes/claude-code-mods
URL: https://github.com/rafagomes/claude-code-mods (stars 0)
Collection of mods; the statusline is `statusline/statusline-command.sh` (the others, `english-coach`, `toolbar`, are not statuslines for this purpose).
1. Fixed per segment plus heat. 256-colour table (`statusline-command.sh:69-81`): dir 39 cyan bold, branch 141 purple, dirty `✚` 215 orange, model 208 amber, effort/mode flags 244 grey, cost 78 green, reset timestamps 117 blue, labels 250, separators 245. `heat()` (lines 150-158, for rate limits/bar): >=90 HOT 203, >=70 WARN 221, else OK 78. Context token colour is not a plain percent: red/amber lines are Claude Code's own autocompact "redline" = window minus 33000 tokens and an "ideal" threshold, with fallback 85% (lines ~225-240).
2. Themes: not present (single palette).
3. 256-colour fg only (`c()` -> `38;5;N`). `NO_COLOR` honoured (lines 54-59). Comment explains a tty test would wrongly disable colour because Claude Code captures stdout.
4. Foreground only.
5. Separator ` · ` in grey 245 (`SEP`, line 83); row 2 uses a spaced gap.
6. Neighbours distinguished by distinct hue per segment and dim middots.
7. Comment (line 51): "256-colour codes, chosen to stay legible on dark and light terminals". No detection or contrast calculation.
8. Unicode glyphs only (`✚`, `↻`, block bars), no Nerd Font; degrades by `$COLUMNS` width.
9. Never prints a partial line; single `jq` pass.
10. Environment variables for hiding rows, `refreshInterval` suggestion; edit the script.

## rainghj/claude-hud
URL: https://github.com/rainghj/claude-hud (stars 0)
1. Threshold for the context bar only: green <60, yellow <85, red >=85 (`claude-hud.sh:50-53`); filled cells and the percentage take that colour, empty cells `\033[90m`. Model, tokens-in/out, and branch are uncoloured.
2. Themes: not present.
3. ANSI 16 (`\033[32m/33m/31m/90m`). No detection, no `NO_COLOR`.
4. Foreground only.
5. Separator is plain two-space `  |  ` (line ~100), uncoloured.
6. Neighbours distinguished only by `|`.
7. Not present.
8. `█░` bar of 10 cells; Chinese comments; no emoji at runtime.
9. Nothing else.
10. Edit script; install/toggle/uninstall scripts for bash and PowerShell.

## ramazangirgin/claude-code-statusline
URL: https://github.com/ramazangirgin/claude-code-statusline (stars 0)
1. Threshold on the two rate-limit windows only, colouring the whole `label: pct% (resets …)` text by REMAINING share: <20% remaining red, <40% yellow, else green (`statusline.sh` `window()`). Model and `ctx: n%` are uncoloured.
2. Themes: not present.
3. ANSI 16. No detection, no `NO_COLOR`.
4. Foreground only.
5. Plain ` | ` separators, uncoloured.
6. Neighbours distinguished by `|` only; rate-limit windows differ by label.
7. Not present.
8. No glyphs beyond ASCII brackets.
9. Nothing else.
10. Edit script.

## rammuthurangan/claude-statusline
URL: https://github.com/rammuthurangan/claude-statusline (stars 0)
1. Fixed plus threshold. Model `BOLD`+CYAN; labels `ctx`/`5hr`/`wk`/`in:`/`out:` GRAY; cost GREEN; git branch CYAN with YELLOW `*` when dirty (`get_git_info`). Bar and % for context, 5h and weekly: green <50, yellow >=50, red >=80 (`build_bar`, `format_with_bar`). Fallback "Ready" in gray.
2. Themes: not present.
3. ANSI 16 (`\033[0;3Xm`, gray 90). No detection, no `NO_COLOR`.
4. Foreground only.
5. Separator `${GRAY} │ ${RESET}`.
6. Neighbours distinguished by gray `│` and per-segment fixed hue.
7. Not present.
8. `█░` 5-cell mini bars; no emoji.
9. Fetches OAuth usage as fallback; caches.
10. Edit script; `install.sh`.

## rangerdjanger/claude-code-statusline
URL: https://github.com/RangerDjanger/claude-code-statusline (stars 0)
FORK OF danielmackay/claude-code-statusline. Styling is unchanged from the parent: still only GREEN `+staged`, YELLOW `~modified`, and green/yellow/red rate-limit text at the same 70/90 thresholds (diffed `statusline-command.sh`). Differences are non-styling: `bash` shebang, reads `.cwd // .workspace.current_dir` instead of `worktree.original_cwd`, CR stripping for Windows, drops the `💪 effort` segment and its conditional second printf, GNU-only `date -d` (so reset time formatting is Linux/Git-Bash only).

## raphael-0624/claudecode-status
URL: https://github.com/Raphael-0624/claudecode-status (stars 0; README badge points at rockelbel/claudecode-status, the upstream)
1. One accent colour for model name and the token bar fill, grey for the rest. `src/templates/status-bar.template.sh:19-36`: `C_GRAY` 245 for everything else, `C_BAR_EMPTY` 238, `C_BAR_FULL` 74, `C_ACCENT` from `[[COLOR]]` placeholder. Output: model in accent, then grey text, bar cells `█` (>=8 of 10 in the cell) / `▄` (>=3) in accent, `░` in 238 (lines 170-184, 192). No threshold colouring.
2. 10 accent "themes" (`orange 173, blue 74, teal 66, green 71, lavender 139, rose 132, gold 136, slate 60, cyan 37`, plus `gray` default = C_GRAY); chosen at install time and baked into the template (`install.sh` substitutes `[[COLOR]]`). Format = single 256-colour index. No user-defined list beyond editing.
3. 256-colour fg only. No `NO_COLOR`, no detection.
4. Foreground only.
5. Separator plain ` | ` in gray.
6. Neighbours distinguished by `|` and the accent only on model + bar.
7. Not present; accent set is muted mid-tones (indices 60-173) that read on both backgrounds, but no code adapts.
8. Emoji (📁, project-type icons) and `█▄░` half-block bar; Chinese UI text.
9. Optional modules: git, clock, memory, cloud env, CLAUDE.md indicator, project type.
10. Interactive installer asks for theme colour and modules; flags are baked as `SHOW_*` variables in the generated script.

## raystyle/hst_rs
URL: https://github.com/raystyle/hst_rs (stars 0)
Rust toolbox whose `hst statusline render <agent>` (`src/statusrender.rs`, 3339 lines; config in `src/statusline.rs`) draws statuslines for Claude plus other agents (kimi, grok).
1. Fixed 256-colour per segment (`ansi(text, "38;5;N")` calls): dir 39 (`statusrender.rs:~325`), git branch 176, model 147, context 116 (kimi path), package/toolchain versions each a fixed index (python 143, rust 180, node 78, zig 178, go 80, cpp 110), clock 67, task 179, hook alias 143. State-driven: hook state `idle` 108, `working` 179, `blocked`/`no-hook!`/`proj-yolo!` 203, else 245 (`state_color`, 1042-1048); stale fleet counts grey 245, fresh 117, running count 114. Header comment in `statusline.rs:10` calls the palette "Catppuccin 系 256 色" (Catppuccin-flavoured 256 colours), but no theme switch exists — only that one name appears.
2. Themes: not present (the "catppuccin" hit is the description of the fixed palette). Layout and icons are configurable instead: `[template]` per-segment format strings with `{icon}`, `{branch}`… placeholders and `<seg>-ascii` variants in the config TOML (`statusline.rs:545-575`), `[icons]` overrides.
3. 256-colour fg. `NO_COLOR` or `HST_STATUSLINE_NO_ANSI` (non-empty) strips all colour (`statusrender.rs:56-71`).
4. Foreground only.
5. Separator is plain ` | ` between parts (`parts.join(" | ")`); multi-line layout with `segments`, `segments2..5` row lists.
6. Neighbours distinguished by distinct fixed hues per segment and the `|`.
7. Not present.
8. Nerd Font icons by default with an ASCII variant per segment (`nerd: bool`, `-ascii` templates, `⇡`/`⇣` arrows vs `+`/`-`).
9. Per-agent behaviour (kimi forced to one line, grok multi-line); width-based degradation (dir to basename under 80 cols).
10. TOML config (`segments`, `segments2..5`, `[template]`, `[icons]`, `single_line`); CLI `hst statusline`.

## rca-umb/usage-pace
URL: https://github.com/rca-umb/usage-pace (stars 0)
Plugin that APPENDS one segment (`pace 5h -5, 7d +13 | 5h resets in 2h03m`) to the user's existing statusline command (`statusline/wrapper.sh` runs the original, then joins with ` | `).
1. By state: pace number coloured by difference between usage and elapsed share of the window (`pace-segment.sh:pace_diff`): over pace by more than threshold red `\033[31m`, within ±threshold (default 5) yellow `\033[33m`, under pace green `\033[32m`. Rest uncoloured. `USAGE_PACE_AHEAD_POSITIVE` flips sign convention.
2. Themes: not present.
3. ANSI 16. No detection, no `NO_COLOR`.
4. Foreground only.
5. Plain ` | ` between the user's line and the segment.
6. The segment is simply appended; it inherits whatever the host line looks like.
7. Not present.
8. ASCII only.
9. Unusual: `hooks/pace.ts` `sessionColorFor` sets Claude Code's session `/color` to green/yellow/red following whichever window is further over pace (`SESSION_COLOR` map, line 38), i.e. colour used outside the statusline.
10. Options in `options.env` (`USAGE_PACE_AHEAD_POSITIVE`, `_THRESHOLD`, `_COUNTDOWN`).

## reif-y/maxx
URL: https://github.com/reif-y/Maxx (stars 0)
Rate-limit "pace" statusline in Node; the colour system in `maxx/render.mjs` is the most thought-out of this batch.
1. Role colours by state. Palette roles `BG, INK, DIM, BRAND, BORDER, GREEN (safe), AMBER (elevated), RED (danger)` (lines 83-90); text is INK, labels are faint DIM, the `/maxx` mark and handle are BRAND, and readings take GREEN/AMBER/RED by how far past the "advised" pace line they are (header comment ~935-960: `chat 26/35%` under the line = plain ink, past it = amber (bold on session), at the wall = red plus curly underline). Typography carries meaning: faint labels, bold = crossed advised mark, curly underline = hard wall, blink (SGR 1;5) for the one reading that must not be missed (lines 166-190).
2. Own palettes: purple "baby purple / deep plum" light and dark sets via `T(light, dark)` (lines 83-90, HSL-defined). No named user themes. `/maxx dark|light|auto` writes `cfg.theme` to `~/.maxx/config.json`. `auto` (default) mirrors the terminal.
3. Truecolor `38;2;r;g;b` by default; downconverts to xterm-256 cube/greyscale for Apple Terminal (`USE_256 = TERM_PROGRAM === "Apple_Terminal"`, `to256()`, lines 148-163). Curly-underline and SGR 58 only for ghostty/iterm/wezterm/kitty/vscode (`CURLY_OK`), else plain underline. No `NO_COLOR` read (the COLORTERM hits are about truecolor).
4. Foreground only by explicit decision (comment line 165 "NO BAND: the bar paints foreground only and lets the terminal's own background show through… A filled panel across the full width read as a coloured stripe"); `BG` still defined but unused for fill.
5. Separators are typographic: ` │ ` (faint DIM) between groups, ` · ` (faint BORDER, lighter) within a group (lines 950-957), with the comment that the group break must read stronger than the item break.
6. Neighbours distinguished by punctuation hierarchy (group `│` stronger than item `·`) and by colour carrying judgement, not identity.
7. Strongest of the batch: dark/light from `cfg.theme`, else the host CLI's own theme (`.claude.json` `theme` startsWith "dark", honouring `CLAUDE_CONFIG_DIR`), and under Ghostty it parses the user's Ghostty config/theme file (background, foreground, palette 1-15) and adopts them: safe = ANSI green (bright variant on dark), danger = ANSI red, brand = theme blue, DIM/BORDER = `blend(fg, bg, 0.38/0.58)`, panel = bg tinted 12-16% toward brand (lines 91-139). `goldenize()` forces the elevated colour to true amber-gold hue 45-48, clamping lightness (dark 0.55-0.70, light 0.38-0.47) because a theme's "yellow" is often orange and blurs with red.
8. Unicode box/block glyphs; no Nerd Font; links via OSC 8 (`link()`).
9. Colour semantic of "same colour never means two scales"; wall states escalate in typography (bold -> curly underline -> blink); width-ranked segment dropping.
10. `~/.maxx/config.json` (theme), slash command `/maxx dark|light|auto`; terminal config is read, not configured.

## rejlander/cc-statusline-plugin
URL: https://github.com/rejlander/cc-statusline-plugin (stars 0)
Not a renderer of its own: a plugin that installs `ccstatusline` (npm) and writes a default ccstatusline config (`assets/default-config.json`, schema version 3), so styling is ccstatusline's (see the ricks774 entry below for that engine).
1. Fixed per widget, set in the default config: model cyan bold, session-usage yellow, block-timer brightWhite, weekly-usage magenta, weekly-reset brightWhite, thinking-effort brightCyan bold, context-bar green, session-clock brightWhite, tokens-total white bold, tokens-input blue, tokens-output green, tokens-cached yellow, cost brightGreen bold (`default-config.json`).
2. Themes: none selected; `powerline.enabled: false`, `theme` unset. Config only; ccstatusline's own powerline themes would be available if the user enables powerline.
3. `colorLevel: 3` (truecolor) with the named ccstatusline colours.
4. Foreground only in this config (no `backgroundColor` fields).
5. `separator` widgets with strings ` | `, ` · `, spaces; `inheritSeparatorColors: false`.
6. Neighbours distinguished by per-widget colours and text separators.
7. Not present.
8. Not set in the default config.
9. One-button `/statusline-on|off|status` slash commands toggle the `statusLine` block in `~/.claude/settings.json` (`cc-statusline-ctl.sh`).
10. Config file is `~/.config/ccstatusline/settings.json`; flags `flexMode`, `compactThreshold`, `globalBold`, `minimalistMode`.

## rgfx/cc-status
URL: https://github.com/rgfx/cc-status (stars 0)
1. Role colours by state, set in config. `src/config/config.ts` `colors` roles: `safe #00ff00`, `warning #ffff00`, `critical #ff0000`, `neutral #8387a1`, `lightBlue #87ceeb` (session timer). `src/renderer.ts` applies: git, context icon, burn rate, time left, session timer, daily cost = `neutral` text; only the numeric value changes colour: subscription % safe <60, warning >=60, critical >=80 (lines 72-79); context % neutral <50, warning >=50, critical >=70 (94-99); burn rate neutral / warning >=500 tokens/min / critical >=1000. Icons are neutral grey, percentages carry the colour.
2. Themes: not present; the five colour roles are user-configurable (semantic role palette, hex values).
3. Truecolor hex only (`\x1b[38;2;r;g;bm`, `src/utils/colors.ts`); `ANSI_COLORS` constants exist for "PowerShell compatibility" but `colorText` only handles `#hex` (non-hex returns uncoloured text). No detection, no `NO_COLOR`.
4. Foreground only.
5. Separator is `format.separator`, default a single space; no colour on it.
6. Neighbours distinguished by icons (`⑂ ↻ ◐ ✽ ⏱ ◷ $`) in neutral grey; no hue differences.
7. Not present.
8. Unicode symbols as icons, all customisable in `format.icons`.
9. Leading reset `\x1b[0m` to fix a PowerShell first-segment colour bug (`renderer.ts:179`).
10. JSON config looked up in `./cc-status.json`, `~/.claude/cc-status.json`, `$XDG_CONFIG_HOME/cc-status/config.json` (`config-loader.ts:15-21`), per-segment `enabled` and `color`.

## richardhuang0001/claudecode-statusline
URL: https://github.com/RichardHuang0001/claudecode-statusline (stars 0)
1. Threshold on one element: the 15-cell context bar `█░` is green <60, yellow <85, red >=85 (`statusline.py` `progress_bar`, ANSI `\033[32m/33m/31m`). All other text (model `[name ver]`, project, branch, token counts, cost, time) is uncoloured.
2. Themes: not present.
3. ANSI 16; no detection, no `NO_COLOR`.
4. Foreground only.
5. Plain ` | ` separators, two lines.
6. Neighbours distinguished by emoji (📁📍📜🧠⏱) and `|`.
7. Not present.
8. Emoji labels, block bar; no fallback.
9. Keeps a local cache (`~/.claude/session_token_cache.json`) of cumulative session tokens; not styling.
10. Edit script.

## ricks774/ccstatusline-zh-tw
URL: https://github.com/ricks774/ccstatusline-zh-tw (stars 0)
Traditional-Chinese translation fork of sirmalloc/ccstatusline v2.2.32 (README says so); the listed source is that engine, so this entry documents it. The batch did not mark it FORK OF, so the engine is described in full.
1. Per widget, user-assigned: each widget has `color` (fg), optional `backgroundColor`, `bold`, `dim` (`src/utils/renderer.ts` `fgColor = widget.color ?? defaultColor`, where `defaultColor = widgetImpl.getDefaultColor()` is a fixed per-widget default; the per-widget defaults themselves are in `src/widgets/*`, not read). In powerline mode with a theme, colours are by POSITION: a running widget slot index selects `theme.fg[i % n]` / `theme.bg[i % n]`, merged widgets share a slot (`renderer.ts:~320-330`, `powerline-theme-index.ts`), and `continueThemeAcrossLines` keeps counting over lines. No threshold/state colouring in the engine itself (widgets may colour their own content).
2. Themes: 10 powerline themes in `POWERLINE_THEMES` (`src/utils/colors.ts`): `custom` (uses each widget's own bg), `nord`, `nord-aurora`, `monokai`, `solarized`, `minimal`, `dracula`, `catppuccin`, `gruvbox`, `onedark`, `tokyonight`. Format = per colour level (1 = ANSI16 names, 2 = `ansi256:N`, 3 = `hex:RRGGBB`) two parallel arrays `fg[]` and `bg[]` of 5 entries, cycled by slot; each theme hand-picks fg per bg for contrast (e.g. nord level 3: bg `88C0D0, 4C566A, 5E81AC, B48EAD, A3BE8C` with fg `2E3440, D8DEE9, FDF6E3, 2E3440, 2E3440`). Users define their own by choosing `custom` and per-widget colours in the TUI; theme list itself is code, not user-extensible.
3. Colour spec grammar: named (`red`, `brightCyan`, `bgBlue`…), `ansi256:N`, `hex:RRGGBB`, and `gradient:<preset>|RRGGBB-RRGGBB|hex:…` (`colors.ts getColorAnsiCode`). Depth is a user setting `colorLevel` 0-3 (0/1 -> ansi16, 2 -> ansi256 default, 3 -> truecolor), applied via `chalk.level`; hex/ansi256 specs return no code at ansi16, gradients collapse to first stop for powerline, per-character in normal mode. No automatic detection seen in `ccstatusline.ts`; `NO_COLOR` not read there (unverified elsewhere).
4. Both: background-filled cells in powerline mode, foreground-only in normal mode (`backgroundColor` optional per widget).
5. Powerline: configurable separator list (default U+E0B0, cycled by separator index), `separatorInvertBackground[]`, `startCaps[]`, `endCaps[]` (`PowerlineConfig.ts`). Separator colours (`renderer.ts:598-672`): normal = fg is previous widget's bg converted to fg (`bgToFg`), bg is next widget's bg; inverted swaps; when adjacent widgets have the same bg it uses the previous (or next, if inverted) widget's FOREGROUND colour instead so the arrow stays visible. Non-powerline: `separator` widgets with text, default grey, optionally `inheritSeparatorColors` to take the previous widget's colours (`renderer.ts:1141-1157`).
6. Neighbours are told apart by the theme cycling a 5-entry bg array across widgets (position-based), so adjacent cells always differ in hue/lightness within the theme, and the same-bg special case for merged widgets. In `custom` mode, only the user's choices.
7. Contrast pairs are baked into each theme (dark fg on light bg and vice versa, e.g. nord fg `2E3440` on bright cyan, `FDF6E3` on blue); `bgToFg` converts bg names to fg names; no luminance computation and no terminal-background detection in this code.
8. Nerd Font / Powerline glyphs (U+E0B0 family); a setup wizard checks and offers to install a Powerline font (`PowerlineFontStatus.ts`, `PowerlineSetup.tsx`); emoji in widgets optional; `CustomSymbol` widget.
9. Gradients: named presets (atlas, cristal, teen, mind, morning, vice, passion, fruit, instagram, retro, summer, rainbow, pastel) interpolated in OKLab (`src/utils/gradient.ts`) applied per character, also as an override foreground gradient across a powerline line; global override fg/bg colour; auto-align columns across lines; flex separators.
10. Config: JSON (zod schema) at `~/.config/ccstatusline/settings.json`; Ink/React TUI (`ColorMenu`, `PowerlineThemeSelector`, `PowerlineSeparatorEditor`, live `StatusLinePreview`); CLI via npx; this fork only translates the UI text.

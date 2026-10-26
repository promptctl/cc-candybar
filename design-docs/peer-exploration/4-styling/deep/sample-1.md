# Styling deep-dive, sample-1 (25 hardcoded-colour statuslines)

Common shape of this batch: nearly all are foreground-only text on the terminal's own background, ANSI colours hardcoded in the script, separators are plain `|` / `│` / `·` / spaces, and there are no themes. The recurring colour rules are (a) a fixed hue per segment type and (b) a green/yellow/red threshold ramp on percentages (context, 5h, 7d). Nobody adapts to light/dark or downsamples depth.

## danielnatoli/claude-statusline
https://github.com/danielnatoli/claude-statusline — 0 stars
1. Fixed per segment plus threshold. `statusline.sh:46-51` maps model→38;5;75 blue, dir→109 muted cyan, git→143 khaki, cost→244 grey, punctuation→244 grey. Threshold ramps: `pct_colour` (`:54-61`) green 78 (<50), amber 214 (50-79), red 196 (80-89), blinking red `196;5` (>=90), used for context and 5h/7d. `effort_colour` (`:65-74`) is a state ramp low=78 green, medium=75 blue, high=214, xhigh=208, max=196.
2. Not present (no themes, colours are `C_*` vars at `:46-51`).
3. 256-colour index only (`38;5;N`). No depth detection, no NO_COLOR.
4. Foreground-only.
5. Plain `  │  ` in 240 grey (`:51`).
6. Distinct hues per segment plus the grey `│`.
7. Not present.
8. Unicode only: `⚡`, `⌗`, `↺`, `⑂`, `▓░` bar. No Nerd Font, no ASCII mode.
9. Blinking red (SGR 5) at >=90% (`:56`).
10. Edit the script. No config or env.

## jpoley gist d13754a6… (host/OS-aware statusline)
https://gist.github.com/jpoley/d13754a6b85b3794cf287af517ef15e3 — n/a
1. Fixed per segment, with one dynamic exception: host name and OS logo take the OS brand colour. Fixed table in `claude-code-statusline.md` script: sep 95;100;115 grey, folder 97;175;239 blue, branch 152;195;121 green, model-splat violet 167;139;250, model bold white, metrics (ctx/sess/7d) 200;205;215 light grey. Host/OS: Darwin→white, Ubuntu→233;84;32 orange, other Linux→255;204;0 Tux yellow (the `case "$(uname -s)"` block). No thresholds: ctx% and 7d% are uncoloured.
2. Not present.
3. Truecolor only (`38;2;R;G;B`). Honours `NO_COLOR` (blanks every `C_*` var, and `C_OS`/`C_HOST`). No depth downsampling.
4. Foreground-only.
5. Plain ` | ` in dim grey so separators "recede" (`sep="${C_SEP} | ${C_RESET}"`).
6. Distinct hue per segment plus grey pipes.
7. Not present.
8. Nerd Font glyphs for OS logo (U+F179/F31B/F17C) and branch (U+F126); emoji 📁; `✳`. Text still reads without a Nerd Font (author says glyphs become boxes).
9. The stated design idea: colour encodes "which machine" before the hostname is read. Screenshot `galway-statusline.png` in the gist (not inspected).
10. Edit the script. Multi-host rollout loop shown. No config.

## LenardiBRA/claude-usage-bar
https://github.com/LenardiBRA/claude-usage-bar — 0 stars
1. By threshold, continuously. `statusline.js:23-39` `STOPS` gradient: 0%→(80,200,120) green, 50→(230,200,60) yellow, 75→(240,140,50) orange, 90→(230,60,60) red, linearly interpolated in RGB per bar (`rgb()`). Bar and percent text share the colour (`:66-68`). Model/effort and labels are plain `DIM` (`:76`). Empty cells fixed 70;70;70 (`:18`).
2. Not present.
3. Truecolor only. No NO_COLOR, no downsampling.
4. Foreground-only.
5. Three spaces between segments (`parts.join('   ')`, `:80`).
6. Spacing only; only the two usage bars are coloured.
7. Not present.
8. Block characters with eighth-step partials `▏▎▍▌▋▊▉█` (`:20`), `░` empties. No icons.
9. Smooth RGB gradient keyed on value, not position. `configure.js` only writes settings.json, no colour options.
10. Edit script. No config.

## SH-OH gist 310a10a0…
https://gist.github.com/SH-OH/310a10a0b1b2ebb17d2bf0cd476f15a0 — n/a
1. Fixed per segment plus one threshold. `statusline-command.sh`: dir→`\033[34m` blue, git branch→`\033[33m` yellow with a `\033[31m` red `*` dirty mark, model→32 green, cost→36 cyan with grey 90 rate-limit suffix, duration→37 white, separator→90 grey. Context `ctx:N%` ramp: green <50, yellow 50-79, red >=80 (the `ctx_color` block).
2. Not present.
3. ANSI 16 only. No NO_COLOR.
4. Foreground-only.
5. Plain `|` in grey 90 around spaces.
6. Distinct basic hues per segment.
7. Not present (comment says "bright blue" but code uses plain 34).
8. None (ASCII, `ctx:` label).
9. Two-line layout: line 1 dir+git, line 2 model|cost|time|ctx.
10. Edit script.

## dnavarrom/claude-statusline
https://github.com/dnavarrom/claude-statusline — 0 stars
1. Fixed per segment plus threshold. Heredoc script in `install-statusline.sh:37-44`: model blue 0;153;255, dir cyan 46;149;153, branch green 0;160;0, token count orange 255;176;85, "5h"/"7d" labels white 220;220;220, +/- diff green/red, `|` and `@reset` dim. `usage_color` (`:48-55`) green <50, yellow 50-69, orange 70-89, red >=90, on context % and 5h/7d. Effort word has its own map (`:101-108`): low dim, medium orange, high green, xhigh purple 167;139;250, max red.
2. Not present.
3. Truecolor only. No NO_COLOR.
4. Foreground-only.
5. Plain ` | ` dim.
6. Distinct hues per segment.
7. Not present.
8. None (text labels `effort:`).
9. README says "green/yellow/orange/red thresholds". This palette is the same one as wallace921029's (below): both look descended from a common script (same 0;153;255 blue, 255;176;85 orange, 230;200;0 yellow, 255;85;85 red).
10. Installer writes `~/.claude/scripts/statusline.sh`; edit it.

## erk-statusline (PyPI, dagster-io)
https://pypi.org/project/erk-statusline/ (v0.9.11, read from the wheel) — n/a
1. Fixed per segment, semantic by kind. `colored_tokens.py:66-73` `Color` enum: CYAN `\033[96m` repo name, YELLOW `\033[93m` worktree name, RED `\033[91m` branch name, GRAY `\033[90m` default/structure, "BLUE" `\033[36m` (actually cyan) for hyperlinks (PR numbers). Used in `statusline.py:1025-1043`. All else (labels like `(git:`, `✗`, `|`, model code `(S)`) uses the base gray. PR/CI state is emoji, not colour.
2. Not present. Description says "robbyrussell theme style" (zsh theme lookalike), but no theme code.
3. ANSI 16 bright codes (90s). No detection, no NO_COLOR. The scanner's `hex_colors` hits are SHA hex digests, not colours (`statusline.py:58`).
4. Foreground-only.
5. Plain `|` / `│` tokens in gray; items joined by a space. `➜` prompt arrow prefix.
6. Distinct hues for repo/worktree/branch; everything else gray.
7. Not present.
8. Emoji for PR state/CI (`👀 🚧 🎉 ⛔ 💥 ✅ 🚫 🔄`), `✗` dirty, `➜`.
9. Immutable `Token`/`TokenSeq` builder that restores gray after each coloured token (`Token.render`, `:90-99`): the closest thing to a style model in the batch. OSC 8 hyperlinks for PRs (`hyperlink_token`).
10. CLI `uv tool install`; no user config.

## jessebond2 gist a8f3d7b5…
https://gist.github.com/jessebond2/a8f3d7b5d8d0138d047e73a62d0cdbf1 — n/a
1. By threshold, on one segment only. In `settings.json` (inline shell command) and README table: ctx% green <20 `\033[32m`, yellow 20-29 `\033[33m`, orange 30-39 `38;5;208`, red 40-49 `\033[31m`, bold red `1;31` >=50, with label suffixes ("dumb zone", "idiot zone"). Model, worktree, branch are uncoloured.
2. Not present.
3. ANSI 16 plus one 256 index (208). No NO_COLOR.
4. Foreground-only.
5. Plain ` | `, uncoloured.
6. Separators only.
7. Not present.
8. None (text `wt:`, `br:`).
9. Colour ramp tied to a joke-labelled "context rot" zone scale starting at 20%.
10. Paste JSON into settings.json.

## drubb gist ef71ca90…
https://gist.github.com/drubb/ef71ca909aacc7fb0a314dcf18cdd88a — n/a
1. Fixed per segment plus threshold. `statusline.sh`: cwd `\e[01;34m` bold blue, git `(branch*)` `\e[01;33m` bold yellow (a copy of the PS1: "PS1 equivalent"); `level_color` green <50, yellow 50-79, red >=80 on ctx bar, 5h, 7d. Model, cost uncoloured.
2. Not present.
3. ANSI 16. No NO_COLOR.
4. Foreground-only.
5. Plain ` | `, uncoloured.
6. Separators only; only blue/yellow on the dir/branch pair.
7. Not present.
8. `█░` 10-cell bar (rounds up so any usage shows a block).
9. Colours chosen to match the author's shell prompt.
10. Edit script.

## meyer-coder/claude-code-eta
https://github.com/meyer-coder/claude-code-eta — 0 stars
1. By state/threshold. `hooks/eta/statusline.sh:10`: only B/D/R and RED/GRN/YEL. ETA text green when on schedule, yellow when "running long", red when past the ETA (`:45-51`); job lines ✓ green / ✗ red (`:109-112`); battery bar fill red >=85, yellow >=60, else green, empties dim (`bar()`, `:231-237`). Everything else is bold or dim. Not a segment-to-colour map.
2. Not present.
3. ANSI 16 only. No NO_COLOR.
4. Foreground-only.
5. Plain double spaces and dim `·`.
6. Bold/dim emphasis; dim for secondary text.
7. Not present.
8. Emoji `⏱ 🔋`, `↳`, `✓ ✗`, `█░`.
9. Mostly an ETA/job-tracking tool whose statusline is its display surface; styling is incidental.
10. Edit hook scripts. No config.

## zbshadow/claude-context-meter
https://github.com/zbshadow/claude-context-meter — 1 star
1. By threshold plus fixed. `context_meter.js:10-20,37-42`: token count green <70k, yellow <=100k, red >100k (`classify`; absolute tokens, not percent). Everything else GRAY `38;5;245`. VCS bit is CYAN when dirty, GRAY when clean (`:237`). Update-available line YELLOW (`:287`).
2. Not present.
3. ANSI 16 plus one 256 index (245). No NO_COLOR.
4. Foreground-only.
5. ` · ` in gray.
6. Only the colour of the one metric and dirty VCS stands out.
7. Not present.
8. None.
9. Threshold on absolute token count (a "dumb zone" idea) rather than percent.
10. `npx` installer; no config.

## yee346-source/context-meter
https://github.com/yee346-source/context-meter — 0 stars
1. By threshold, on context only. `src/segments/context.ts:11-13` green/yellow/red by `config.thresholds` (default warn 60, danger 80, `src/config.ts:11`). Model, tokens, git, cost, duration segments are uncoloured (their files import no colours; `src/ansi.ts` also exports unused `dim`).
2. Not present.
3. ANSI 16 (32/33/31, `src/ansi.ts:7-10`). No NO_COLOR.
4. Foreground-only.
5. Plain configurable `separator` (default ` · `, `src/config.ts:10`).
6. Separator only.
7. Not present.
8. Configurable bar glyphs `▓`/`░` (`bar.filled`/`bar.empty`).
9. Segment registry (`REGISTRY` in `src/render.ts:9`) is the only abstraction; no colour per segment.
10. JSON config `~/.claude/context-meter.json` or `$CONTEXT_METER_CONFIG`: segments list, separator, thresholds, bar glyphs/width, contextLimit. Cannot change colours.

## MohammadMD1383/claude-plugins
https://github.com/MohammadMD1383/claude-plugins — 0 stars
Not a statusline command: a plugin marketplace with two "bar above the prompt" mods (usage-bar, progress-bar) drawn via the mod API's Ink `<Text>` components, plus a usage-guard hook and a docs website (the scanner's hex colours come from the website/social-image tooling).
1. By state/threshold, with the colour *name* handed to the host. usage-bar `plugins/usage-bar/hooks/register.tsx:12`: `COLOR = { ok: undefined, warn: 'yellow', critical: 'red' }`; level from `warn_pct` 70 / `critical_pct` 90 (`hooks/format.ts:20-22,85-88`). Meter `━` coloured, remainder `─` dim, label dim, non-ok value bold. progress-bar `register.tsx:53,299`: `{ running: 'cyan', stalled: 'yellow', failed: 'red', done: 'green' }`; paused jobs dim.
2. Not present; colours are terminal-theme names resolved by Ink/the host.
3. Named colours only (`yellow`, `red`, `cyan`, `green`); depth/NO_COLOR left to the host.
4. Foreground-only; `dimColor` for secondary text.
5. Plain `  ·  ` (`SEPARATOR`, `format.ts:46`) in dim.
6. Spacing and dim.
7. Delegated to the host via named colours and `dimColor`; nothing computed.
8. `━ ─` meters; `↻` reset glyph; state glyph per job.
9. Animated "slide" block on indeterminate jobs (`r.slide`). Placement option `above-prompt | footer` (`format.ts:10`).
10. Plugin options (`show_*`, `placement`, `warn_pct`, `critical_pct`). No colour options.

## Rafaelclaro-pr/claude-statusline-windows
https://github.com/Rafaelclaro-pr/claude-statusline-windows — 0 stars
1. Fixed per segment plus threshold. `statusline.py:46-56` named 256 palette: edge `▎` blue 39, project name and time cyan 87, cost/burn gold 214, dirty branch pink 213 (clean branch green 76, `:223`), model purple 177, subpath white 253, separators/dates grey 244. `_pct_color` (`:67-78`) ramp: 76 green <50, 220 yellow <70, 208 orange <90, 203 red >=90; used on bars and percentages of ctx, 5h, 7d.
2. Not present.
3. 256 index only. Honours `NO_COLOR` by stripping SGR from the output (`:361-363,380`). Enables Windows VT mode (`_enable_vt`, `:26`).
4. Foreground-only.
5. `  │  ` in grey 244, and a coloured `▎ ` left edge on each line.
6. Distinct hue per segment plus grey separators.
7. Not present.
8. Eighth-step fractional bar `█▉…░` (`:81-94`); `●` dirty, `↑↓` ahead/behind; box chars. No emoji.
9. Compact mode when terminal width <100 (`render(width)`, `:338,370-385`), shorter bars and fewer fields. Two lines.
10. Edit script; `install.py` registers it.

## ye4wzp/claude-statusline
https://github.com/ye4wzp/claude-statusline — 0 stars
1. Fixed per segment plus threshold. `statusline.ts:26-33,108-130`: model icon cyan with bold name, dir blue, branch `🌿` green with `+n` green and `~n` yellow, PR line green (approved), red (changes_requested), yellow otherwise (`:110-112`). `pct2color(p, warn, crit)`: green/yellow/red with thresholds 70/90 for ctx, 60/85 for 5h/7d. Badges (effort blue, fast/thinking magenta) are off by default.
2. Not present.
3. ANSI 16 numeric codes (`A` table). No NO_COLOR.
4. Foreground-only.
5. Two spaces.
6. Emoji icons per segment carry most of the distinction; hues secondary.
7. Not present.
8. Emoji throughout (🤖 📁 🌿 🧠 ⏱️ 📅 💰 ⌛); `█░` bar with the empties dim.
9. Feature flags in a `CFG.show` object (`:6-21`); git/cost/duration off by default.
10. Edit `CFG` at the top of the script (Bun).

## charles0103/claude_statusline
https://github.com/charles0103/claude_statusLine — 0 stars
1. Fixed per segment plus threshold. `context-bar.py:30-40` 256-colour constants: model bold 141 violet, dir 75 blue, branch 114 green, dirty count 208 orange, bar 75 blue, empty cells 238, text 252, sep 240, OK 114, WARN 220, HIGH 208. Context bar: blue by default, 220 at >=70%, 208 at >=90% (`:232-238`). 5h/7d via `lim_color`: 114 <50, 220 <80, 208 above (`:149-161`). Clean git shows a green `✓` (114), dirty a count in 208.
2. Not present.
3. 256 index only. No NO_COLOR.
4. Foreground-only.
5. ` │ ` in 240 grey.
6. Hue per segment plus grey separator. The ramp deliberately never reaches red (tops out at orange).
7. Not present.
8. `▓░` bar; `✓`. No emoji in output beyond one flagged.
9. Reads a cached usage file written by `update-usage-cache.py` (not a styling matter).
10. Edit script; `install.ps1` for Windows.

## d3soxyephedrine/claude-statusline
https://github.com/d3soxyephedrine/claude-statusline — 1 star
1. Mixed. Fixed per segment: dir bold cyan `1;36`, git `` bold magenta `1;35`, "req" count bold yellow, in-tokens bold green, out-tokens bold cyan, cost bold yellow, labels dim (`statusline.sh:195-215,252-266`). Threshold: context bar `━╌` green <=50, yellow >50, red >75 (`:134-136`); token-expiry minutes green >=30m, yellow <30m, bold red <5m. State badges with background fill: effort `max` white on orange `48;5;208`, `high` white on green `48;5;28`, low/other dim; permission mode `edits` black on yellow `48;5;220`, `YOLO` white on red `41`, `plan` white on blue `44`, `ask` black on white `47` (`:146-160`). Live-activity line coloured by kind: thinking magenta, tool green, server tool yellow, response blue (`:212-230`). Project brand badge `1;97;48;5;91` white on purple (`:105`).
2. Not present. A user conf file (`~/.claude-statusline.conf`, sourced) can set `BRAND`, a hand-written ANSI string.
3. Mix of ANSI 16 and 256 index (backgrounds). No NO_COLOR.
4. Both: background-filled "pill" badges for effort, permission mode and brand; everything else foreground-only.
5. Dim `│`, no caps; badges are padded with a space inside the background.
6. Badge backgrounds vs coloured text vs dim labels.
7. Not present, but the badge text colour (white `97` vs black `30`) is hand-picked per badge background.
8. `━╌` bar, emoji 🔑, a Nerd/PUA glyph before the branch.
9. Mode is encoded as colour (YOLO red is the loud case). Live "thinking/tool/response" line with italic snippet (`3;35`) fed by a proxy watcher.
10. Edit script; sourced conf for brand.

## tubyram/claude-code-statusline
https://github.com/tubyram/claude-code-statusline — 0 stars
1. Fixed plus threshold. `statusline.sh:14-24,50-59`: model CYAN; ctx and 5h/7d ramp green <70, yellow 70-89, red >=90 (`used_color`); dir, branch, token detail, cost DIM.
2. Not present.
3. ANSI 16. No NO_COLOR.
4. Foreground-only.
5. Two spaces.
6. Cyan/ramp vs dim.
7. Not present.
8. None.
9. Phrased as "N% used" with colour on the whole phrase.
10. Edit script.

## skaigroove/claudebar
https://github.com/skaigroove/claudebar — 0 stars
1. Fixed plus threshold. `claudebar.sh:22-26,67-73,95-105`: model cyan; labels (`ctx`, `5h`, `7d`, reset time, cost, effort, account) dim; percentage via `paint()`: green <70, yellow 70-89, red >=90.
2. Not present.
3. ANSI 16. No NO_COLOR.
4. Foreground-only.
5. Configurable `separator` (default two spaces).
6. Spacing; one cyan item.
7. Not present.
8. None.
9. The only user choice is *which* segments and their order.
10. Key=value file `${XDG_CONFIG_HOME:-~/.config}/claudebar/config`: `segments="model effort ctx 5h 7d cost account"` and `separator`. Colours not configurable. Comments in Korean.

## wallace921029/claude-statusline
https://github.com/wallace921029/claude-statusline — 0 stars
1. Fixed plus threshold. `statusline.sh:12-21,26-33,175-192`: model blue 0;153;255, dir cyan 86;182;194, branch green with a red dirty mark, session time white, effort `high` magenta 180;140;255 else dim; context-% and rate-limit bars share `color_for_pct`: green <50, orange 50-69, yellow 70-89, red >=90. Labels `current`/`weekly` white.
2. Not present.
3. Truecolor only. No NO_COLOR. `set -f`.
4. Foreground-only.
5. ` │ ` dim.
6. Hue per segment plus dim separator.
7. Not present.
8. Bars use `●`/`○` dots; `✍️` and `⏱` emoji; `⟳`. `statusline.ps1` is a PowerShell port with the same palette.
9. Rate limits get their own lines under line 1. Same base palette as dnavarrom's above.
10. Edit script.

## jantimon/cc-statusline
https://github.com/jantimon/cc-statusline — 1 star
1. Fixed per segment, plus per-model colour. `src/main.rs:209-217` consts: cyan (dir, session id), green (branch, cost), yellow (model name row 1), lavender 178;185;244 (context bar), LABEL 150;158;178 muted grey-blue for "in/out/total", DIM, BOLD. `model_color` (`:606-615`) tints each model family in row 2: opus lavender, sonnet cyan, haiku magenta, fable green, other yellow. No threshold colour on context.
2. Not present.
3. Mix of ANSI 16 and truecolor (the lavender and label). No NO_COLOR.
4. Foreground-only.
5. Plain ` | ` (row 1) and dim `|` (row 2).
6. Hue per segment; row 2's token breakdown uses grey labels with bold values.
7. Not present; the LABEL colour comment says it is chosen to be "readable".
8. `█░` bar; emoji 🏡 for treehouse slot; OSC 8 file links (`link()`, `:553`).
9. Per-model-family colour is the distinctive part. Rust binary.
10. Compile and edit consts; no config.

## hydra8/m3cc-statusline
https://github.com/hydra8/m3cc-statusline — 3 stars
1. Fixed per row label plus threshold. `statusline.py:15-23,746-751,789-870`: every row starts with a cyan label (`[model]`, `PRJ:`, `GIT:`, `CTX:`, `GLB:`, `AGT:`, `TODO:`, `NOW:`, `SMM:`), values white `97`, accents 256-colour 214 orange (session count, time, SUM, branch, percent, tool names, todo), project name 167 red-pink, hostnames 75 blue. Git facts: clean green, staged green, modified yellow, untracked red, ahead green, behind red. Bars: quota bar red >=90, yellow >=75, else green (`:749`), context bar `⣿⣀` braille red >=80, yellow >=50, else green (`:853`). Empties dim.
2. Not present.
3. ANSI 16 plus 256 index. No NO_COLOR. Bar width fixed 12 because "terminal width not available" (`:24`).
4. Foreground-only.
5. Line-per-concern layout (multi-line) instead of separators; labels end with a colon.
6. Labelled rows; cyan label vs white value vs orange accent.
7. Not present.
8. Braille bars; box characters; one emoji.
9. Up to ~10 lines (agents, todos, current tool, tool summary, files touched). Screenshot and hero image in repo. README in English and Russian.
10. Edit script; installer script.

## norbertgodany/ng-claude-statusline
https://github.com/norbertgodany/ng-claude-statusline — 0 stars
1. Fixed plus threshold. `statusline.ps1:9-18,20-46,48-60,78-91`: project name blue, `[model effort]` model magenta and effort cyan, branch cyan with yellow `*` dirty, ahead green `↑`, behind red `↓`; context bar grey 244 <30%, orange 208 30-49%, red >=50%; limits grey <50, yellow 50-79, red >=80. Calm state is grey, not green.
2. Not present.
3. ANSI 16 plus 256 (244, 208). No NO_COLOR.
4. Foreground-only.
5. ` | ` plain before the branch, ` · ` grey between limits.
6. Hue per item; calm values go grey so only warnings stand out.
7. Not present.
8. `█░` bar, `↑↓`, `·`.
9. PowerShell only.
10. Edit script.

## McDusty/claude-status-line
https://github.com/McDusty/claude-status-line — 0 stars
1. Fixed plus threshold. `statusline.py:34-47,196-209,419-440`: dir bold-white `1;37` (comment: "Bright white for dark mode"), branch `⚡️` green, model bold-bracketed magenta, version green (orange when outdated), time white, separators grey 90. Context bar and % ramp: green <50, yellow <80, orange <90, red >=90; token count cyan.
2. Not present. Dict `COLORS` at top is the only palette.
3. ANSI 16 bright codes plus one 256 (208). No NO_COLOR.
4. Foreground-only.
5. ` | ` in grey 90.
6. Hue per item plus grey bars.
7. Only a comment: the directory colour is white "for dark mode" (`:43`); no detection.
8. Emoji 📁 ⚡️; `█░` bar.
9. Plays a sound at 95%/100% context (`ALERT_THRESHOLDS`).
10. Edit script.

## JunseokAhn/claude-enhanced-monitor
https://github.com/JunseokAhn/claude-enhanced-monitor — 0 stars
1. Fixed per element, with background-filled gauges. `statusline/statusline.js:34-35,51-60`: `C = { repo 37, branch 170, commit 238, changes 179, name 130, dim 244 }` as bold 256 foregrounds. The two gauges are *background-filled*: context bar fill 68 / empty 18 (blue family), session (5h) bar fill 167 / empty 52 (red family); the label text is overlaid white (255) on the cells. Colour does not move with the value; the one state switch is `sessionWeek` (fill 178 / empty 94, yellow, dark text 232) when the weekly limit has under 10% left (`:336`).
2. Not present.
3. 256 index only. No NO_COLOR.
4. Both: foreground-only for repo/branch/commit, background-filled gauge cells with centred text.
5. Single space; left text and right-aligned gauges, padding between (`align()`).
6. Different bar families (blue vs red) and the left text's hues.
7. Fixed foreground choices per fill (255 white, 232 dark on yellow), no adaptation.
8. Korean labels, no icons. OSC 8 repo link off by default (iTerm bell issue, documented at `:36-48`).
9. CJK-width-aware truncation; uses `COLUMNS` for width; weekly limit shown as a colour change only. Fills fixed per bar rather than ramped.
10. Env vars `STATUSLINE_REPO_LINK`, `STATUSLINE_NO_CACHE`; `.debug` file. Colours are edited in the `C` and `BAR` consts.

## sfioritto gist d5afda29…
https://gist.github.com/sfioritto/d5afda29062bfbbe224a878c9f6d3b82 — n/a
1. Threshold plus dim labels. `statusline.sh:41-57`: only a ramp, using bright ANSI codes: green `\e[92m` <50, yellow `\e[93m` <80, red `\e[91m` >=80, applied to the context bar, context %, and each rate-limit % (the labels "session", "all models", "resets…" are `\e[2m` dim). Directory and model are dim; branch uncoloured.
2. Not present.
3. ANSI 16 bright. No NO_COLOR.
4. Foreground-only.
5. Dim `│`.
6. Dim vs coloured only.
7. Not present.
8. `█░` bracketed bar `[████░░░░░░]`.
9. Two lines; uses `refreshInterval: 60` so countdowns stay current.
10. Edit script.

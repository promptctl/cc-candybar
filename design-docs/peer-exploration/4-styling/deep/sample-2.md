# Styling deep-dive: sample-2 (25 hardcoded-colour statuslines)

Line anchors are to the file as fetched from HEAD on 2026-10-24. In every project below, the colours are literals in the script and there is no theme system, so point 2 is `not present` unless stated. Common pattern across the sample: segment colour is decided by threshold (green/yellow/red on a percentage) far more than by segment identity; where identity colours exist they are a handful of fixed foreground hues. No project in this batch uses background-filled cells with a separator except chobitnet (powerline mode) and lotyszm (bar fill only).

## gist dayton-bobbitt/768b28886af5dc112487ccc0404f8e70
URL: https://gist.github.com/dayton-bobbitt/768b28886af5dc112487ccc0404f8e70 · stars n/a
Files: `statusline-command.sh` (98 lines)
1. Colour by state only. `pct_color` (l.16-25): >80 red `\e[31m`, >60 yellow `\e[33m`, else green `\e[32m`, applied to the 5h and 7d percentages. `token_color` (l.29-38): >=90k red, >=75k yellow, else green, applied to the context token count. Labels (`ctx:`, `5h:`, `7d:`), the max-token figure and reset times are uncoloured (terminal default). No per-segment fixed colour.
2. not present.
3. ANSI 16 only (`\e[31m/33m/32m`). No depth detection, no NO_COLOR.
4. Foreground only.
5. Plain text `  │  ` between groups (l.86, 94), uncoloured.
6. Separators only; neighbours are not otherwise differentiated.
7. not present (no theme-background awareness; red/yellow/green are the terminal's own palette).
8. No icons. ASCII labels plus the `│` box char.
9. Nothing notable. Only context and rate limits shown.
10. Edit the script; no config or env.

## github.com/sbelmar/claude-statusline
URL: https://github.com/sbelmar/claude-statusline · stars 0
Files: `scripts/statusline.sh` (165 lines)
1. Fixed per segment (palette l.47-54, 256-colour index): folder 117 sky blue, agent/session name 208 "Claude orange", model 228 light yellow, context bar 208, 5h bar 117, 7d bar 39 (comment: "matches Update installed message"). One state rule: git branch is 83 bright green when `main`/`master`, else 75 cornflower (l.101-105). The context and rate-limit bars do NOT change colour with percentage; fill is shown only by `█`/`░`.
2. not present.
3. 256-colour index (`\033[38;5;Nm`). No detection, no NO_COLOR.
4. Foreground only.
5. Plain space between segments; no separator glyphs.
6. Different hues per segment (sky blue / blue / orange / yellow); same-family blues for 5h vs 7d (117 vs 39) to pair them.
7. not present.
8. No icons; `█`/`░` bars inside `[ ]`.
9. Notable: matches colours to Claude Code's own UI (orange, "Update installed" blue) per comments l.50, 54.
10. Edit constants at top of the script.

## gist Skeyelab/a6c8c10d40bfd42b88538f351d6c4d95
URL: https://gist.github.com/Skeyelab/a6c8c10d40bfd42b88538f351d6c4d95 · stars n/a
Files: `statusline.sh` (115 lines), `README.md`, `statusline.svg` (screenshot; the hex counts come from the SVG, not the script)
1. Mixed. Fixed: host magenta `\e[35m`, model cyan `\e[36m` (l.96), dir uncoloured, separators and git ahead count/duration/cost dim 244 (l.9). State: git branch green, yellow on `main`/`master` ("nudge: you're on the default branch", l.48); `level()` (l.30) maps context %, 5h %, 7d % to green <60, yellow <80, red; prompt-cache hit `◎` is inverted, green >=90, yellow >=70, red below (l.77).
2. not present.
3. ANSI 16 plus one 256 index (244 dim). No depth detection, no NO_COLOR.
4. Foreground only.
5. `${DIM} · ${R}` (l.11), dim grey dot.
6. Separators only, plus different hues for host/model.
7. not present.
8. Unicode only: `█░` meter, `◎` cache, `◷` duration, `↑` ahead. No Nerd Font.
9. Width-adaptive: `build` tries six progressively shorter variants against `$COLUMNS` and drops low-priority segments (l.100-114). README ships an SVG screenshot.
10. Env vars `STATUSLINE_HOST`, `STATUSLINE_COST=1`; otherwise edit script.

## github.com/bestes206/claude-whereami
URL: https://github.com/bestes206/claude-whereami · stars 0
Files: `src/whereami/statusline.py` (346 lines)
1. State only, one score. `_color_for(score)` (l.75-80): drift score <=33 green `\033[32m`, <=66 amber `\033[33m`, else red `\033[31m`; the colour is applied to the gist text (l.138) and the "label · gist" head (l.282). Goal text and placeholder `…` are dim grey `\033[90m` (l.17). Nothing else is coloured.
2. not present.
3. ANSI 16 only. No detection, no NO_COLOR.
4. Foreground only.
5. Plain double spaces / newlines; no separator glyph.
6. Not applicable: one coloured head line plus a dim goal.
7. not present.
8. No icons found in the styling code (the "emoji" hits are in other files, not checked further). `_CTRL_RE` (l.101) strips terminal escapes from model-supplied text so injected text cannot recolour the line.
9. Colour encodes semantic "drift" (on track / drifting / off track / way off, l.84-95), bucketed to match the colour thresholds. Not general-purpose styling.
10. Env `WHEREAMI_SHOW_DRIFT_SCORE`; otherwise edit script.

## github.com/lgdy88/claude-hud
URL: https://github.com/lgdy88/claude-hud · stars 0
Files read: `src/render/colors.ts` (147 lines), `src/config.ts` (colour types), `src/render/{tools,agents,usage}-line.ts` (partial greps)
1. Per-role fixed colours with per-role overrides, plus thresholds. Roles (`colors.ts` l.87-117) and defaults: model cyan, project yellow, git wrapper magenta, git branch cyan, label dim, custom line 256-index 208 orange, warning yellow, critical red. Context bar (`getContextColor`, l.119): >=85 critical (red), >=70 warning (yellow), else `colors.context` (green). Quota bar (`getQuotaColor`, l.125): >=90 critical, >=75 `usageWarning` (bright magenta), else `usage` (bright blue). Tool/agent status glyphs are hardcoded: running `◐` yellow, done `✓` green, tool name cyan, agent type magenta (`tools-line.ts` l.19, 33; `agents-line.ts` l.41-53). Bar empty cells are always dim.
2. No bundled themes. A user "theme" is the `colors` object (11 keys, `config.ts` l.34-45) that overrides role colours; roles are semantic-ish (context/usage/warning/critical/model/project/git/gitBranch/label/custom).
3. `resolveAnsi` (l.38-49) accepts a name from an 8-name set (dim, red, green, yellow, magenta, cyan, brightBlue, brightMagenta), a 256 index number, or `#rrggbb` (converted to truecolor `38;2`). No depth detection or downsampling; no NO_COLOR in colours.ts.
4. Foreground only.
5. Plain text (spaces, `|`, `git:(` `)` wrappers coloured with the git colour).
6. Hue per role; no neighbour logic.
7. not present (uses `dim` SGR 2 for labels; no contrast logic).
8. Unicode: `█░` bars, `◐ ✓ ⚠`. Emoji flagged by the scanner in other files; not checked for a fallback mode. README mentions i18n via `t()` labels.
9. Adaptive bar width (`getAdaptiveBarWidth`).
10. JSON config at `~/.claude/plugins/claude-hud/config.json`, edited by hand for `colors.*`; README table at README.md l.183-195.

## github.com/yct94/claude-statusline
URL: https://github.com/yct94/claude-statusline · stars 0
Files: `status_bar.py` (156 lines)
1. Mixed fixed + state. Fixed (l.146-148): directory bold cyan, `in:` tokens green, `out:` tokens magenta, `in:`/`out:`/`ctx:` labels dim. State: context bar+percent `ctx_color` (l.95): >=80 red, >=50 yellow, else green; cost: >$1.0 red, >$0.1 yellow, else green (l.143). Empty bar cells dim `░`.
2. not present.
3. ANSI 16 + SGR bold/dim. No detection, no NO_COLOR.
4. Foreground only.
5. Two spaces between segments; no glyph.
6. Different hues for dir/in/out; thresholds for the rest.
7. not present.
8. Unicode bars only (`█░`).
9. Nothing notable; computes cost from hardcoded PRICING table.
10. Edit script.

## github.com/chobitnet/claude-code-statusline-simple
URL: https://github.com/chobitnet/claude-code-statusline-simple · stars 0
Files: `statusline.py` (320 lines)
1. Hybrid: gradient by state, accent by segment. Value-to-colour gradient: `heat(pct)` (l.98) interpolates `HEAT_STOPS` (0%: 126,196,140 green; 55%: 223,190,100; 80%: 228,148,78; 100%: 222,88,88) in RGB, used for the context gauge. Rate limits: weekly windows are coloured by pace (usage / expected-even-spread) via `PACE_STOPS` (1.0 green, 1.3 amber, 1.7 orange, 2.2 red; l.68), other windows by `heat`; >=95% forced red (l.72). Fixed accents: model `ACCENT_MODEL` (128,190,235) bold, fast-mode flag `ACCENT_FLAG` (238,200,110); everything else is neutrals (`C_VALUE`, `C_LABEL`, `C_DETAIL`, `C_MUTED`, `C_DIVIDER`, `C_EMPTY` greys, l.37-42). Comment l.188: "Colour carries the gauge meaning; everything else is a shade of grey."
2. No themes; a `STYLE` switch with two renderers: `minimal` (default) and `powerline` (env `CC_STATUSLINE_STYLE`, l.29).
3. Truecolor only (`38;2`/`48;2`, l.80-85). No downsampling, no detection, no NO_COLOR.
4. Minimal: foreground only. Powerline: background-filled (`bg(back)` with ink `PL_INK` 26,28,34 over it, l.77, 208-215), segment bg = its accent else `NEUTRAL` (150,158,172).
5. Minimal: dim-grey `│` (`C_DIVIDER`). Powerline: `` arrow whose fg = this segment's bg and bg = next segment's bg (or reset at end), l.210-212. Arrow colours are derived from the neighbours' fills.
6. Minimal: separators only. Powerline: each cell takes its gauge colour, so neighbours differ by value, not by position; all non-gauge cells are the same neutral grey (adjacent neutrals are separated only by the arrow).
7. Text on coloured background is a fixed near-black `PL_INK` (no contrast calculation). Avoids SGR dim because it stacks with Claude Code's own dim (comment l.35); emits `\033[22m` to cancel it (l.33, 205).
8. Unicode eighth-block partial cells `" ▏▎▍▌▋▊▉"` (l.47), empty `·`, `↻` reset mark (overridable via `CC_STATUSLINE_RESET`, l.57). Nerd Font only in powerline mode; the file credits ccstatusline for the look.
9. `--demo` prints both styles plus a glyph check and a 0-100% gradient strip (l.239-245); `tools/render_svg.py` renders screenshots.
10. Env vars `CC_STATUSLINE_STYLE`, `CC_STATUSLINE_RESET`; constants at top of script; debug flag file.

## github.com/aururn/claude-statusline-progress
URL: https://github.com/aururn/claude-statusline-progress · stars 0
Files: `statusline-progress.js` (341 lines)
1. Fixed role palette with one state rule. Palette `C` (l.33-43): coral `#D97757` (model glyph `✻`, in-progress fill), amber `#E8B04B` (in-progress marker), mint `#7CC99A` (done), text, dim, faint, track, ink, slate. Model glyph coral, model name text, folder dim (l.~270). Task status: completed mint `●`, in_progress amber `◉`, pending faint `○` (l.~245). Fill colour: coral until finished, then mint (pill/line). Separator faint.
2. No themes. Four progress "styles" selected by `--style=pips|aurora|pill|line` (l.4, 16), which change the bar rendering, not the colours.
3. Truecolor hex (`38;2` / `48;2`, l.19-21), hand-coded. No detection, no NO_COLOR.
4. Both: `pill` style uses background fill (`bg(fillColor)` with `fg(C.ink)` bold text, l.244); other styles foreground. `aurora` draws a track with `bg(C.track)` on the partial-cell only.
5. Faint `│` between segments (l.~262).
6. Separators only.
7. Fixed dark ink `#1C1A18` for text on filled pill; palette assumes a dark terminal (track `#2B2825`, faint `#3A3632` would vanish on light).
8. Unicode: `✻ ● ◉ ○ ◌ ✓`, eighths `▏…▉`, `━ ╸`. No Nerd Font. Japanese label strings.
9. Notable: `aurora` bar is a per-cell gradient coral to amber to mint via `gradient()` (l.28-31, 223-229) using 1/8-cell partials. This is the only gradient along a bar in the batch besides chobitnet/zenn.
10. CLI `--style`, `--demo`; palette constants in the script.

## github.com/jcoder-stack/claude-statusline
URL: https://github.com/jcoder-stack/claude-statusline · stars 0
Files: `statusline.py` (221 lines; `statusline.js` is a port with the same constants), `check-font.sh`
1. Fixed per segment plus state for gauges (256 indices, l.18-27): model + bolt BLUE 117, dir 250, git branch PURPLE 176, reset countdown 245, cost 150, empty bar 238. Gauges (context, 5h, week; `gauge()` l.79): label, bar and percent share `level_color` (l.60): >=85 RED 203, >=60 YELLOW 179, else GREEN 114. The comment says indices were "pixel-sampled from a reference screenshot, not estimated" (l.18).
2. No themes.
3. 256-colour only (`38;5;N`). No detection, no NO_COLOR.
4. Foreground only.
5. `\x1b[38;5;241m │ \x1b[0m` (l.15), grey 241.
6. Different hue per segment; gauges differ by threshold colour.
7. not present.
8. Two glyph sets switched by constant `NERD_FONT = True` (l.30): Nerd Font v3 codepoints for model/dir/branch/context/5h/week/reset/cost, or emoji fallback (l.43-46). `check-font.sh` prints each glyph so the user can verify the font. Bars use `▰▱` (l.48).
9. Two-line layout (identity row, then limits row). Edit-one-constant icon switch is the only fallback mode.
10. Edit constants in script; `install.sh`.

## gist dot-mike/f14c3be7cb30d1727b1727acf2912b31
URL: https://gist.github.com/dot-mike/f14c3be7cb30d1727b1727acf2912b31 · stars n/a
Files: `statusline-script.sh` (134 lines), `setting.json`
1. State only, no per-segment colour. Context % (l.20-26): >=80 red, >=50 yellow, else green. 5h % and 7d % (l.79-93): same 80/50 thresholds. Thinking effort (l.59-63): low green, medium yellow, high/xhigh/max red. Everything else (folder, language, branch, model) uncoloured; identity comes from leading emoji.
2. not present.
3. ANSI 16 only; `echo -e`. No detection, no NO_COLOR.
4. Foreground only.
5. Plain ` | ` (l.131, 135).
6. Separators plus a distinct emoji per segment (`📁 🐍 🌿 🤖 🧠 📚 ⏱ 📅`).
7. not present.
8. Emoji only, no ASCII fallback.
9. Detects Python/Go project and shows language version; nothing colour-related beyond thresholds.
10. Edit script.

## github.com/noambrand/kivun-terminal
URL: https://github.com/noambrand/kivun-terminal · stars 26
Files: `source/statusline.mjs` (265 lines), `source/apply-terminal-color.js`. The repo is a Windows Terminal launcher for Claude Code (Hebrew/RTL); the statusline is one component.
1. Mixed fixed + threshold (`C` table l.10-19, ANSI 16): project folder cyan, tokens yellow, duration and full path bright-black `\x1b[90m`, effort magenta, cost green, cache blue, tpm cyan. Model: green if name matches /opus/, else yellow (l.123). `makeBar` (l.95-102): >=80 red, >=50 yellow, else green fill, dim `░` rest; used for Context, Session (5h), Weekly bars. Labels (`Context`, `Session`, `Weekly`) uncoloured.
2. Statusline: not present. Separate feature: `TERMINAL_COLOR` in `config.txt` sets the Windows Terminal background (`kivun` #C8E6FF, `dark`, `black`, `white`, `default`, or any `#RRGGBB`), and the text colour is picked automatically (dark text on light bg, light on dark) per `apply-terminal-color.js` header. That recolours the terminal scheme, not the bar.
3. ANSI 16 only in the statusline. No detection, no NO_COLOR.
4. Foreground only (statusline).
5. Dim `|` between fields (l.~240).
6. Hue per field type, separators.
7. Statusline: not present. The terminal-colour script does choose light/dark text for a custom background (apply-terminal-color.js header).
8. Unicode bars; no icons. Output is plain English labels.
9. Opt-in fields via env `KIVUN_SL_COST`, `KIVUN_SL_CACHE`, `KIVUN_SL_TPM` (l.20-22). A picker app (`picker-app/`) chooses launcher options.
10. Env vars above; `config.txt` for terminal colour.

## github.com/haiderali3d/catline
URL: https://github.com/HaiderAli3D/catline · stars 2
Files: `statusline-command.js` (3106 lines), `demo.js`
1. Role palette plus a four-step severity ramp, 256-colour (l.724-753): REPO 111 steel blue (project dir leaf), WTREE 153 (worktree dir, "same hue one step up"), REF 109 (branch, path stem, sha), MODEL 250, MUTED 246 (labels), RULE 244 (rules, separators), TITLE 253 (session name). RAMP = sage 108, gold 179, apricot 215, red 203. Each meter gets sev 0-3 from thresholds: context [60,80,90], 5h [60,80,92], 7d [50,75,90] (l.2994-2996); fill and the empty track share the ramp colour and differ only in density (`█` vs `░`, "density carries progress, hue carries severity", l.602). Past the first threshold the label also takes the colour. The pet cat's ink follows the worst meter's severity colour.
2. No themes; one fixed restrained palette ("two hues plus a neutral ramp", l.719).
3. 256-colour only. Colours close with `ESC[39m` not `ESC[0m` so they compose with the dim Claude Code wraps around lines (l.606). Never emits bold/dim/italic. No colour-depth detection, no NO_COLOR (grep finds none).
4. Foreground only.
5. Dim `│` and `·` in RULE 244.
6. Not a goal: one block with one left margin; ink value steps (253 > 250 > 246 > 244) rank elements instead of hue, and layout position does the heading.
7. Ink chosen to survive Claude Code's dim wrap; no light-terminal adaptation.
8. Bar tier by env `CLAUDE_STATUSLINE_BAR` = ascii (`#`/`-`) | blocks | smooth (eighth partials); auto: SSH forces blocks, `WT_SESSION` (Windows Terminal) enables smooth (l.837-843). Pet and width overrides via `CLAUDE_STATUSLINE_PET`, `CLAUDE_STATUSLINE_WIDTH`.
9. Animated ASCII pet cat (30 animation signals) that paces, naps, grooms, etc., stepped per `refreshInterval`; its mood/colour tracks the worst meter. Every payload string is sanitised to strip escapes/bidi (l.614-622). Extremely long design comments throughout.
10. Env vars above; `settings.json` `refreshInterval` is coupled to `TICK` (l.1200).

## gist mikekoka/5f27e226b1ffecfb9bff5ce96981653d
URL: https://gist.github.com/mikekoka/5f27e226b1ffecfb9bff5ce96981653d · stars n/a
Files: `statusline.sh` (111 lines)
1. Fixed per field plus thresholds, 256 indices (l.62-64). Eight slots: C0 75 model (bold), C1 183 git branch, C2 114 green (cache >=50%, lines added), C3 210 salmon (cache <50%, lines removed, 5h/7d >=80%), C4 180 cost, C5 248 context % / duration / ratio, C6 117 input tokens, C7 222 output tokens. Context bar (l.70-76): `━` filled cells coloured 114 below 70%, 222 at 70-89, 210 at 90+, empty `─` 238. Labels (`ctx`, `in`, `out`, `ch`, `cost`) are SGR dim. Rate limits (l.98, 106): dim grey normally, switch to C3 at >=80%. Line 3 only.
2. No themes.
3. 256-colour + SGR bold/dim. No detection, no NO_COLOR.
4. Foreground only.
5. Dim `|` (`S`, l.65) between groups within a line; three lines instead of one row.
6. Hue per metric.
7. Uses SGR dim for labels (the pattern chobitnet notes stacks with Claude Code's dim); no light-bg handling.
8. Unicode `━─` bars. No icons.
9. Burn-rate ETA (`burn_eta`, l.44) per limit.
10. Edit script.

## github.com/lightpointventures/claude-tab-tracking
URL: https://github.com/lightpointventures/claude-tab-tracking · stars 26
Files: `scripts/session_statusline.sh` (145 lines) is the only styling file; the rest are task-tracking hooks.
1. State only (l.65-72, 80-89, 134-138). Badge: `[DONE]` green, `[WIP]` yellow, `[SET]` bold, `[---]` dim. Context % in the footer: <50 green, <80 yellow, else red. Directory name, duration and model are dim; "ctx" and `|` uncoloured.
2. not present.
3. ANSI 16 (green/yellow/red/cyan; cyan defined but unused in the greps) plus bold/dim. No detection, no NO_COLOR.
4. Foreground only.
5. Two-space `|` two-space (`  |  `) in the footer (l.141).
6. Separators only.
7. not present.
8. Text badges (`[DONE]`, `[WIP]`) are an ASCII-only status vocabulary. A "[---] jq not found" error path.
9. Multi-line layout: task line, up to two previous done tasks (dim green `[DONE]`, dim text), then footer. The statusline exists to show the session's task title across tabs.
10. Edit script; task files under `~/.claude/session-tasks/`.

## github.com/lotyszm/cc-statusline
URL: https://github.com/lotyszm/cc-statusline · stars 5
Files: `statusline.py` (1259 lines; most of the repo is a time/cost tracker and dashboard unrelated to colour)
1. Fixed per segment plus thresholds, 256 indices (l.70-79): labels and muted 245, separators 242, values 252, money 221, model 81 cyan, path 111, git 176, account tag 209, warn 214, task time 115. Bar fill via `bar()` (l.620): `BAR_OK` 77 below 70%, `BAR_WARN` 214 at >=70, `BAR_HOT` 203 at >=90; track `BAR_TRACK` 238 ("raise it on light themes", l.78).
2. No themes; a flat block of colour constants in a CONFIGURATION section (l.50-80), plus `LAYOUT` ("gauges" 4-line aligned columns / "compact" 2-line) and `LANG` en/pl.
3. 256-colour only (fg `38;5`, bg `48;5`). No depth detection, no NO_COLOR.
4. Both. `BAR_STYLE = "solid"` (default) draws the bar with background-coloured spaces `\033[48;5;Nm ` so it stays opaque on translucent terminals (comment l.623-626); `"ascii"` uses `█` glyphs instead.
5. Plain spaces/columns; `C_SEP` 242 for separators.
6. Hue per segment; columns aligned across gauge lines.
7. Single comment suggesting raising `BAR_TRACK` on light themes (l.78); no automatic adaptation.
8. No Nerd Font. Emoji appear minimally; `↗ Open panel` OSC 8 hyperlink (l.711) to a local dashboard (works in terminals that support OSC 8).
9. Width-aware task column on the right when wide enough (`TASKS_MIN_W`); OSC 8 link; `~` marker for a limit reading borrowed from another session.
10. Constants in the script; `tracker/config.py` for the tracker (TOML-lite).

## github.com/techsnazzy/claude-crt-statusline
URL: https://github.com/TechSnazzy/claude-crt-statusline · stars 0
Files: `statusline.js` (166 lines)
1. Fixed palette of four RGB triples (l.37-42): amber `f2a65a` (model name, and a usage limit >=50%), muted `8a7d68` (directory, labels, `│` separators, reset times), green `639922` (limit <50%), pink `d4537e` (limit >=80%). `rateLimitSeg` (l.110): <50 green, 50-79 amber, >=80 pink. Gauge and percent take the state colour; label is muted.
2. No themes; the file header calls it a "warm CRT-terminal / Omarchy-flavoured" look, one fixed palette.
3. The only project in this batch with real depth handling. Truecolor if `COLORTERM` matches `truecolor|24bit`, else every RGB is converted to the nearest xterm-256 index (`to256`, 6x6x6 cube plus greyscale ramp, l.52-62). Honours `NO_COLOR` (non-empty): all escape codes are dropped (l.47-72).
4. Foreground only.
5. Muted `│` (l.126).
6. Separators plus an icon per segment.
7. not present; palette is warm mid-tones, no contrast logic.
8. Emoji map `ICON` (`🤖 📁 🔥 ☕`) editable, set any to `''` to drop (l.27-32). Responsive: `cols<72` drops gauges, `<100` shortens them.
9. demo script `demo.sh`; palette chosen to match the Omarchy terminal style.
10. Edit the `PALETTE` and `ICON` constants; env `NO_COLOR`, `COLORTERM`, `COLUMNS`.

## gist nitan-jana/96c15241473e2fe56d40bad6ddb7dd2e
URL: https://gist.github.com/nitan-jana/96c15241473e2fe56d40bad6ddb7dd2e · stars n/a
Files: `claude-statusline.py` (118 lines)
1. Mostly one colour rule by state, rest monochrome (l.24-29, 20-21). `by_usage`: >=85 red `31`, >=60 yellow `33`, else green `32`, applied to the context bar, and to the 5h/7d percentages. Model is bold (`1`), effort, labels, cost and separators are dim (`2`). No hue is attached to a segment's identity.
2. not present.
3. ANSI 16 + SGR bold/dim. Honours `NO_COLOR` (`COLOR = not os.environ.get("NO_COLOR")`, l.13; `paint` returns plain text, l.16-17) but no depth detection.
4. Foreground only.
5. `dim("·")` between groups (l.115).
6. Separators only.
7. not present (uses SGR dim so it follows the terminal's palette).
8. `━`/`─` line bars (l.10); no icons.
9. Nothing more.
10. Edit constants `BAR_WIDTH`, `WARN`, `CRIT`; env `NO_COLOR`.

## gist adavoudi/67b453f95b8607d55fa910339a794121
URL: https://gist.github.com/adavoudi/67b453f95b8607d55fa910339a794121 · stars n/a
Files: `statusline.sh` (77 lines), `README.md`
1. State only. `color()` (l.8-10): >=85 red, >=60 yellow, else green, used for the context bar+percent and for the 5h and weekly bars+percent. Model is bold; separators and token counts / reset text are dim; cost uncoloured. A trailing hint line (l.66-76): red `⚠ /compact now` at ctx>=80 or >=400k tokens, yellow `● cache cold` / `● consider /compact` hints, dim cache-expiry note.
2. not present.
3. ANSI 16 + bold/dim via `$'\033[..m'`. No detection, no NO_COLOR.
4. Foreground only.
5. Dim `│` (l.6).
6. Separators only.
7. not present.
8. `▰▱` bars (l.16), `⚠`, `●`.
9. Second line of coloured advice that depends on prompt-cache state fields (`prompt_cache.warm`, `expires_at`).
10. Edit script.

## github.com/renshuyuan/claude-code-statusline
URL: https://github.com/RenShuYuan/claude-code-statusline · stars 1
Files: `status_line.py` (259 lines)
1. State plus a few fixed. `progress_bar` (l.124-134): context bar uses `▓░` with cyan <50, yellow <80, red; the 5h and 7d bars use `█░` with green <50, yellow <80, red. So the same percentage maps to different "ok" colours for context (cyan) and rate limits (green). Fixed: model name cyan `36`, session name `[ ]` grey `90`, labels `context`/`5h`/`7d` grey `90`, `plan:` value green `32`, `advisor:` magenta `35`, effort low green / medium+high yellow / max red (l.~190), reset countdown grey `90`, "即将重置" yellow `33`.
2. No themes.
3. ANSI 16 only (`\033[{code}m`, l.44). No detection, no NO_COLOR.
4. Foreground only.
5. Box-drawing card (`make_box`, l.~112): `╭─ title ─╮ │ … │ ╰──╯`, uncoloured frame; spaces between fields.
6. Rows in a card, not coloured separators.
7. not present. East Asian width handled for alignment (`vlen`).
8. Emoji companion icon derived from the name of Claude Code's companion (🐉 ⚡ ❄️ 🌑 🐾, l.~160), `⏱`, `↺`. No fallback.
9. Boxed multi-line card; companion pet emoji. Other files (`amplify_wav.py`, `play_sound.py`) are sound hooks.
10. Edit constants (`PROGRESS_WIDTH`, `EMOJI_OVERRIDE`).

## github.com/dougtudino/claude-gestor-tokens
URL: https://github.com/dougtudino/claude-gestor-tokens · stars 0
Files: `scripts/statusline.js` (66 lines); other files are hooks/reporting.
1. State plus one grey. `COR` table (l.8): green/yellow/red/grey(90). The context bar and `pct%` take red >=80, yellow >=60, else green (l.48); the `(used/window)` tokens, the git branch in parentheses, and the session name are grey `90`; the "sem nome → /rename" prompt is yellow. Model, cost and folder are uncoloured.
2. not present.
3. ANSI 16. No detection, no NO_COLOR.
4. Foreground only.
5. Plain ` · ` (l.63), uncoloured.
6. Separators plus a leading emoji (`🧠 📁`).
7. not present.
8. Emoji; Portuguese text.
9. Nothing beyond the nudge to name the session.
10. Edit script (installed by a Claude skill that copies it to `~/.claude/`, l.3).

## gist Chemaclass/dedbbe124732c2742559468d61edb0bd
URL: https://gist.github.com/Chemaclass/dedbbe124732c2742559468d61edb0bd · stars n/a
Files: `statusline.sh` (89 lines)
1. Fixed per segment with a thresholded one, modelled on the oh-my-zsh robbyrussell prompt (l.3, 34-41): arrow `➜` bold green, dir cyan, `git:(` `)` bold blue wrapping the branch in red, dirty marker `✗` yellow, model grey `90`, cost green, total tokens magenta `35`, context %: cyan below 70, yellow 70-85, red above 85 (note: cyan, not green, is the calm colour), 5h/7d: green / yellow / red at 70 and 85.
2. No themes; the colours are the zsh theme's.
3. ANSI 16 + bold. `printf` with escapes. No detection, no NO_COLOR.
4. Foreground only.
5. Two spaces; no glyph (the `➜` arrow is a prompt, not a separator).
6. Hue per segment; each segment a different colour.
7. not present.
8. Unicode only (`➜ ✗`).
9. The only project here deliberately mimicking a shell prompt theme.
10. Edit script; header says override locally via `.claude/settings.local.json`.

## github.com/xleddyl/claude-watch
URL: https://github.com/xleddyl/claude-watch · stars 71
Files: `statusline-command.sh` (126 lines), `fetch-usage.sh` (usage fetcher)
1. Fixed per segment, truecolor, no thresholds in the bar (l.93-125): container badge `⬢ container` bold (97,175,239); model bold orange (256 index 208); folder name bold (76,208,222) teal; git branch bold (192,103,222) purple; 5h / 7d / ctx lines in uniform grey (156,162,175), reset deltas and token counts the same grey at SGR dim. Usage and context numbers carry no state colour.
2. not present.
3. Mixed: one 256 index (208) and the rest truecolor `38;2;R;G;B`; plain `\033[90m` for separators. No detection, no NO_COLOR.
4. Foreground only.
5. `\033[90m | \033[0m` between model/folder and the usage line; ` • ` between folder and branch and between 5h and 7d (l.90).
6. Different hue for each identity segment (orange, teal, purple); grey for numbers.
7. not present.
8. `⬢` for the dev container; otherwise text only.
9. Two lines: identity, then usage/ctx. Usage is fetched by a separate script and cached in `/tmp/.claude_usage_cache`.
10. Edit script.

## github.com/will0wn/willown-code
URL: https://github.com/Will0wn/willown-code · stars 0
Files: `statusline.ps1` (242 lines, PowerShell, Windows)
1. Fixed per information type (comment l.3 "un colore per tipo di informazione") plus threshold scales (l.4-13). Greeting lavender (167,139,250), model amber (251,191,36), separators grey, labels light grey, effort light yellow (253,224,71), folder blue (96,165,250), MCP teal (52,211,153), GitHub account dot green (34,197,94) connected / grey off. Scales (`Get-Segment`, l.20-35; `<50`, `50-80`, `>80`): Context uses bright 16-colour green/yellow/red (`92/93/91`); Usage uses truecolor sky blue (56,189,248) / orange (251,146,60) / deeper orange (249,115,22), i.e. a blue-to-orange scale with no red.
2. No themes.
3. Mixed: truecolor for most, ANSI bright 16 for the context scale. No detection, no NO_COLOR.
4. Mostly foreground, plus a truecolor half-block pixel-art devil logo using paired fg+bg (`▀` with `38;2` top and `48;2` bottom, l.186) so each cell carries two pixel colours (purple/light/dark shades P, L, S).
5. Dim grey `|` and `·` (l.6, 156).
6. Hue per info type.
7. not present.
8. Unicode (`█░ ● ↻ ↝`) and the pixel-art logo; Italian labels.
9. Animated "tamagotchi" logo: frame depends on current second (`% 10`), swaying and blinking each second with `refreshInterval` (l.173-181). Four-row layout, one logo row per output line. A per-machine `statusline.local.ps1` extension hook.
10. Edit script; `statusline.local.ps1` for local segments.

## github.com/alwinpaul1/claude-hud-enhanced
URL: https://github.com/alwinpaul1/claude-hud-enhanced · stars 10
Files: `plugins/claude-hud-enhanced/src/render/colors.ts` (167 lines)
1. Same module as the lgdy88 claude-hud entry above (identical constants and function set), with two differences. Roles and defaults: model cyan, project yellow, git magenta, gitBranch cyan, label dim, custom 256-index 208 orange, warning yellow, critical red (l.87-117). Context bar `getContextColor` (l.124) thresholds are configurable (`thresholds.critical` default 85, `warning` default 70), else `colors.context` (green). Quota bar (l.136): >=90 critical, >=75 `usageWarning` bright magenta, else `usage` bright blue.
2. Same as lgdy88: no bundled themes, user `colors` overrides.
3. Same: name / 256 index / `#rrggbb` (truecolor). No detection or NO_COLOR in colors.ts. Scanner counted `env.256color` and `env.truecolor` hits elsewhere in the plugin, not checked.
4. Foreground only.
5. Plain text.
6. Hue per role; no neighbour logic.
7. not present.
8. Bar glyphs are configurable: `colors.barFilled` / `colors.barEmpty` default `█` / `░` (l.148-149, 164-165), the difference from the lgdy88 file.
9. Configurable context thresholds.
10. JSON config (`config.ts`); a larger plugin (daemon, usage fetchers) not read for styling.

## zenn.dev/m0370/articles/b8e43519850cec
URL: https://zenn.dev/m0370/articles/b8e43519850cec · stars n/a (blog article, 2026-04-11, Japanese)
Source read: the article text and its full script (curl of the page).
1. Gradient by state, one rule. `gradient(pct)`: below 50% rgb(pct*5.1, 200, 80) (green to yellow-green); at 50% and over rgb(255, max(200-(pct-50)*4, 0), 60) (yellow to red), applied to a `●` dot beside each of ctx, 5h and 7d. Model is bold, reset time and the `·` separators are dim. Dot colour is the only colour.
2. not present.
3. Truecolor `38;2` computed per value. No detection, no NO_COLOR.
4. Foreground only.
5. Dim `·` between segments.
6. Separators only.
7. not present.
8. Unicode `●`; Japanese article text.
9. Continuous colour gradient on the dot; a deliberately minimal one-line layout (`model · ctx ● 42% · 5h ● 15% to 23:00 · 7d ● 8%`).
10. Copy-paste script; register with the `statusline` settings key (the article writes `statusline.command`; the current key is `statusLine`, unverified whether the old spelling still works).

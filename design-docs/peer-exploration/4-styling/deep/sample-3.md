# Styling deep-dive: sample-3 (25 hardcoded-colour statuslines)

Pattern across the batch: almost every one colours by state threshold (usage % -> green/yellow/red) with a handful of fixed per-segment hues; none has themes, none uses background fills or powerline caps, none adapts to a light terminal. Anchors are file:line in the fetched copy.

## gist/826f0c5af67ebd06771afbbc9fad4733 (panicoenlaxbox statusline.py)
https://gist.github.com/panicoenlaxbox/826f0c5af67ebd06771afbbc9fad4733 , stars n/a
1. Fixed per segment plus one threshold. `statusline.py:6-13` constants; line ~158 branch line GREEN, worktree icon CYAN; model line `YELLOW`+`ITALIC` (~l.162); cwd line `GRAY` (~l.208), VS Code icon truecolor `38;2;35;129;204`. Threshold: context % > `CONTEXT_WARN_THRESHOLD = 60` (l.15) turns the "N% used" text ORANGE (`38;5;208`) with a warning icon; below it no colour. tokens, cost, 5h, 7d: uncoloured.
2. not present (no themes).
3. Mixed: ANSI-16 (32/33/36/90), 256 index (208), one truecolor (VS Code blue). No depth detection, no NO_COLOR.
4. Foreground only.
5. Plain ` | ` between segments, uncoloured; branch / model / cwd are on separate lines.
6. Separators and separate lines only; hues differ per segment.
7. not present.
8. Nerd Font icons with a Unicode fallback noted in comments (`BRANCH_ICON`, `WORKTREE_ICON`, `WARNING_ICON`, `VSCODE_ICON`, l.16-19), no runtime switch. OSC 8 hyperlinks on branch/cwd/VS Code icon (l.28).
9. Italic model line; clickable links.
10. Edit constants in the script; no config file.

## github.com/wowoweewa/cc-usage
https://github.com/wowoweewa/cc-usage , stars 0
1. State only. `claude-usage-statusline.py:81-85,122-128` `color_for(pct)`: >= `RED_AT` 90 red, >= `AMBER_AT` 70 amber(33), else green; colours the bar fill and the % number. Labels `5H`/`7D` and reset text uncoloured. Empty remainder `DIM`.
2. not present.
3. ANSI-16 only (32/33/31/2). No depth detection, no NO_COLOR.
4. Foreground only.
5. Two bars joined by a space on one line, or stacked with a braille-blank spacer row (`SEP_ROW`, l.79) when width < `SINGLE_LINE_MIN_COLS` 72 (COLUMNS).
6. Distinct by label only; both bars share the same colour rule.
7. not present.
8. Box/block glyphs `█░` fill, `┫ ┣` caps (l.70-71); braille blank U+2800 trick because Claude Code drops whitespace-only lines.
9. Layout reflow by terminal width (l.17, 72).
10. Constants in the script; env `CLAUDE_USAGE_CACHE` for cache path only.

## github.com/dfkhelper/claude-code-statusline
https://github.com/DFKHelper/claude-code-statusline , stars 1
1. Fixed per segment plus thresholds. `statusline.js:29-39` neon palette `FG`: model magenta `255,70,255` (l.31/130+), token count cyan, but turns yellow >= 250K tokens (l.104); cwd orange; peak/off-peak marker yellow "PEAK" or teal moon (l.~172); context % tiers: >=95 red, >=80 orange, >=60 yellow, else green (l.115-120); auto-compact warning `AC!!` red <5 / orange <9 / yellow remaining (l.125-129).
2. not present. One hardcoded palette tuned for pure black.
3. Truecolor SGR only (`38;2;r;g;b`), foreground only; no depth detection, no NO_COLOR.
4. Foreground only.
5. Plain `|` in gray `220,224,230` (l.38, l.~188 `parts.join`).
6. Different hue per segment; separators.
7. Palette comment (l.20-27) says tuned for black background; no adaptation. The companion `copilot-hc.js` is a PTY proxy that rewrites every SGR colour the Copilot CLI emits (grayish brightened, hues saturation/lightness boosted to "neon", user prompt recoloured teal, OSC 10/11 forced white-on-black) - it restyles another tool's output, not Claude's.
8. Emoji moon; no icon modes.
9. Same script is dual Claude Code / GitHub Copilot CLI statusline (defensive field lookup, l.1-18). Peak-hours (5-11am PT) indicator is time-based state.
10. Edit constants; package.json/install.js installer only.

## github.com/mttmcknn/prism
https://github.com/mttmcknn/prism (README badges point at himattm/prism), stars 35
1. Fixed per section plus threshold. `internal/statusline/statusline.go`: dir `colors.Cyan` (l.205-209), model `colors.Magenta` (l.344), +added green / -removed red (l.512), cost `colors.Gray` (l.595), git plugin yellow (`internal/plugins/git.go:63`); context bar uniform colour by `colorPct`: >= 90 red, >= 70 yellow, else default/uncoloured (l.468-476); usage plugin `GetUsageColor(utilization, white, yellow, red)` (`usage_common.go:346`) white <70 / yellow 70-89 / red 90+. Plugins receive a colour map and choose their own.
2. Themes not present. A named-colour palette exists (`internal/colors/colors.go:130-230`, ~80 names like `coral`, `supabase_green`, `dodger_blue`) exposed to plugins via `ColorMap()`; `api_billing.color` config picks a name (README "color from palette").
3. Constants are ANSI-16 plus bright, 256-index for the named palette, one truecolor (Supabase `38;2;62;207;142`). No depth detection; no NO_COLOR found in the files read.
4. Foreground only.
5. Separator `Dim + "·" + Reset` (`colors.go:Separator()`, ` · `), same colour for all.
6. Hue per section plus dim middot.
7. not present.
8. Emoji icon configurable (`icon`, default gem), `⎇` worktree glyph; bar glyphs `█░▒` (`▒` marks the autocompact buffer, l.455-499). Bars-style usage `▂█` sparkline.
9. Plugin system (Go-native plugins, any-language via scripts, `examples/prism-plugin-weather.sh`). Scanner's "rainbow/animation" hits did not correspond to any rendering code I found (only the colour names); treat as unverified.
10. JSON config in three tiers (`~/.claude/prism-config.json`, `.claude/prism.json`, CLI `prism init`), `sections` array (nested arrays = multi-line); no colour-per-section config beyond plugin options.

## github.com/hbcbh1999/claude-statusline (FORK OF nilbuild/claude-statusline)
https://github.com/hbcbh1999/claude-statusline , stars 0. Differences vs parent only.
- Palette and colour rules are identical to the parent (`bin/statusline.sh:11-21` truecolor `blue 0,153,255` model / `cyan` dir / `green`+`red` branch / `white` timer; `color_for_pct` l.36-42: >=90 red, >=70 yellow, >=50 orange, else green, applied to ctx % and bars; separator `dim │`). Bars `●`-less block bars via `build_bar`.
- Fork is an OLDER snapshot of upstream, not a restyle: lines 190-193 show `◐ thinking` in magenta when `alwaysThinkingEnabled` else dim `◑ thinking` (upstream: effort level `high` magenta `●`, medium/low dim `◑/◔`); no `⚡` skip-permissions marker; no stdin `rate_limits` path (always OAuth API + cache); `format_tokens` helper present, `format_epoch_time` absent; git status without `--no-optional-locks`.
- No new styling points (1-10 otherwise as upstream: foreground-only, truecolor, no NO_COLOR, no themes, env/script editing only).

## gist/1ce34c43b03d53785f5b0af8ebaba759 (galipyildiz statusline.py)
https://gist.github.com/galipyildiz/1ce34c43b03d53785f5b0af8ebaba759 , stars n/a
1. Fixed per segment plus state. `statusline.py:16-23`: labels "Context:", "5s", "7g", "Limit:" CYAN; token count CYAN; cost YELLOW (l.131); model MAGENTA (l.154). State: % number green <70 / yellow >=70 / red >=90 (l.117-123) and `rl_color` same thresholds (l.39-44) for 5h/7d. Context bar is a per-cell truecolor GRADIENT by cell position (l.84-106): pos<=50 `rgb(0..220, 200, 80..0)` green->yellow, >50 `rgb(220, 200..40, ..20)` -> red; filled cells coloured by their own position, empty `38;2;60;60;60 ░`. Status emoji by tier: green circle <20, lightning <70, fire <90, siren >=90 (l.109-115).
2. not present.
3. ANSI-16 plus truecolor via `rgb()` (l.26). No detection, no NO_COLOR.
4. Foreground only.
5. ` DIM|RESET ` between segments (l.149).
6. Hue per segment; separators.
7. not present.
8. Emoji heavy (status, hourglass, robot); `█░` bars.
9. Gradient bar (20 cells); bar colour is position-based while % text is tier-based, so the two can disagree.
10. Edit script; the `.md` file in the gist is install notes.

## gist/984aa915c3e3b6695b2c14f0cc1c1f4d (ohadperry gistfile1.sh)
https://gist.github.com/ohadperry/984aa915c3e3b6695b2c14f0cc1c1f4d , stars n/a
1. Fixed per segment plus threshold. `gistfile1.sh:141` dir cyan `0;36`; model magenta `0;35` (l.158); git prompt in oh-my-zsh style: `git:(` bold blue `1;34`, branch red `0;31`, dirty `✗` yellow `33` (l.168-172); session text dim (`2`) with `✳` prefix on first line (l.148). Context bar: green <=60, yellow <=85, red above (l.86-88, 133-135), bar drawn `[████░░]` all in that one colour.
2. not present.
3. ANSI-16 only, written as `\033[0;3Xm`. No detection, no NO_COLOR.
4. Foreground only.
5. Two spaces between dir/model/ctx; no coloured separators. The "mission control" Goal/Done/Now/Next block is dim text lines read from a per-session file the agent rewrites.
6. Hue per segment, whitespace.
7. not present.
8. `✳`, `✗`, box bar; no emoji.
9. Content-driven rather than style-driven: agent writes the status block via a CLAUDE.md directive + SessionStart hook (header comments l.1-40).
10. Edit script.

## nyosegawa.com/posts/claude-code-statusline-rate-limits
https://nyosegawa.com/posts/claude-code-statusline-rate-limits/ , stars n/a (blog post, five Python patterns)
1. State only, one function shared by all five patterns: `gradient(pct)`: pct<50 `38;2;int(pct*5.1);200;80` (green -> yellow), pct>=50 `38;2;255;max(0,200-(pct-50)*4);60` (yellow -> red). A continuous colour from usage %, applied to ctx, 5h, 7d alike. Labels `DIM`, model `BOLD`/plain.
2. not present.
3. Truecolor only (`38;2`); no fallback, no NO_COLOR.
4. Foreground only.
5. Plain spaces / ` | ` joins (parts list); not coloured.
6. Not addressed: all meters use the same gradient, distinguished by labels.
7. not present.
8. Five meter glyph sets are the point of the post: Pattern 1 `●` dots, 2 sparkline gauge ` ▁▂▃▄▅▆▇█` (8 cells), 3 ring `○◔◑◕●`, 4 fine bar with eighth-blocks ` ▏▎▍▌▋▊▉█` + `░` (10 cells), 5 braille bar (8 cells). Windows stdout UTF-8 reconfigure.
9. The colour-from-percentage gradient is the whole styling idea; shown as screenshots.
10. Copy-paste scripts.

## dev.classmethod.jp/articles/claude-code-statusline-setup-windows
https://dev.classmethod.jp/articles/claude-code-statusline-setup-windows/ , stars n/a (Japanese blog, one Python script)
1. State only. Script block (page lines ~40-58): `color(pct)`: <=30 GREEN `92`, <=60 YELLOW `33`, else RED `31`; colours the 10-cell `▓░` bar and the % text per meter (ctx, 5h, 7d). Model name uncoloured.
2. not present.
3. ANSI-16 (bright green 92 + 33/31). No detection, no NO_COLOR.
4. Foreground only.
5. Spaces / pipes in uncoloured parts list.
6. Labels only.
7. not present.
8. `▓░` bars; Windows-specific `sys.stdout.reconfigure(encoding='utf-8')` is the main styling-adjacent point of the article.
9. not present.
10. Edit script.

## github.com/romacv/claude-plan-usage-statusline
https://github.com/romacv/claude-plan-usage-statusline , stars 8
1. Fixed per segment with state overrides. `statusline.rb:66-81` `COLORS` hash (256-index): directory 32, model 91, tokens 30, ctx_warn 172, ctx_alert 160, plan 31, messages 64, time 136, worktree 137, git_clean 60, git_dirty 131, loop 35, custom 44, gray (90) for separators/stale. Context segment `context_segment` (l.200-209): remaining <=20% ctx_alert (+ " COMPACT" warning), <=35% ctx_warn, else `tokens` colour. Git colour switches clean/dirty by indicators (l.911). Usage segment colours via `usage_segment` (l.1206, stale usage prefixed `~` gray). Custom (non-Claude) model segment uses `custom` colour.
2. not present. Muted 256-colour palette hardcoded in one hash, so one-line retunes.
3. 256-index + one ANSI-16 gray. No detection, no NO_COLOR found.
4. Foreground only.
5. `|` in gray (`sep`, l.99), spaced.
6. Hue per segment from a deliberately muted palette; separators.
7. not present.
8. Unicode symbols per segment: `◆` model, `✦` effort, `▤` context, `⌥` branch, `⑂` worktree, `◎` goal, `⟳` loop, `⚠` (l.108-296). No Nerd Font, no emoji for segments.
9. Stale data marking via `~` + gray; pause segment in alert colour.
10. Edit `COLORS` in the Ruby script; env only for token source.

## gist/d62a746f5106f215fbb0d69d14eacfff (kenjikato statusline.sh)
https://gist.github.com/kenjikato/d62a746f5106f215fbb0d69d14eacfff , stars n/a
1. Fixed per segment plus threshold. `statusline.sh:21-23`: `[model]` CYAN (l.~58 printf), diff `+N` GREEN `-N` RED (l.~44), cost YELLOW (l.~62), context bar GREEN <50, YELLOW 50-74, RED >=75 (l.29-31) on the `█░` bar only (the % number is plain); In/Out token labels CYAN. Dir name, duration, limits uncoloured. Bold cyan/magenta constants (`BOLD_CYAN`, `BOLD_MAGENTA`, l.22) are defined (from the author's PS1) but not used in output.
2. not present.
3. ANSI-16 only. No detection, no NO_COLOR.
4. Foreground only.
5. Plain ` | `, uncoloured.
6. Emoji prefix per segment is the main separator (brain, folder, hourglass, arrows, money, clock).
7. not present.
8. Emoji per segment (`🧠 📁 🌿 ⏳ ➡️ ⬅️ 💸 ⏱️ ⏰`), `⚠️` warning when `exceeds_200k_tokens`.
9. not present.
10. Edit script.

## github.com/kachvanov/claude-pace
https://github.com/kachvanov/claude-pace , stars 0
1. By semantic group plus state, from a deliberate palette. `pace.mjs:121-133`: top line exactly three colours, one per meaning group: REPLY warm white `#E8EDE4` (model, effort, style, vim mode: l.329-339), ACCOUNT dusty lavender `#B0A2C4` (email, l.343), PROJECT muted teal `#6FA8A0` (dir, PR number, l.354-358). Scales: `thresholdColor(p)` (l.145-149): MOSS `#7FB069` <60, AMBER `#D6B27A` 60-85, CLAY `#D87A6E` >85, applied to bars and % for ctx, 5h, 7d (l.411-425); burn-rate projection and daily budget ratio use the same three (l.415, 432). MUTED `#7A857A` for labels, resets, sizes; TRACK `#404840` for the empty bar. Comment (l.100-115): analogous green->teal->blue->lavender run of similar lightness; warm tones reserved for alarm and never on the top line.
2. No theme switch. One palette in two forms (truecolor and `--basic` 16-colour: REPLY 37, ACCOUNT 35, PROJECT 36, MOSS 32, AMBER 33, CLAY 31, MUTED 2, TRACK 2; l.119-133).
3. Truecolor default, ANSI-16 via `--basic` / `CLAUDE_PACE_BASIC=1` (l.55, 69). Honours `NO_COLOR` (l.59, 68, 136) and the bar stays readable without colour (comment l.152). No auto depth detection (flag only).
4. Foreground only.
5. Plain `  ·  ` (`SEP`, l.98), uncoloured.
6. By colour group on the top line, alignment (labels padded to `LABEL_W` 3, pct to `PCT_W` 6, l.100-110) on the scale lines.
7. not present as adaptation; palette stated to read on dark.
8. `█░` bars, `⟲` for reset, no emoji, no Nerd Font. `--lang=en|ru`.
9. The only project in the batch that documents a colour design rationale (semantic groups, alarm-only warm tones, equal-lightness cool run). Bar never lies at edges (min 1 cell for any non-zero).
10. CLI flags with env mirrors: `--compact`/`CLAUDE_PACE_COMPACT`, `--basic`/`CLAUDE_PACE_BASIC`, `--lang`, `--email`, `--state`.

## npmjs.com/package/claude-hud
https://www.npmjs.com/package/claude-hud , stars n/a (v1.1.0; package.json repository url is empty)
1. Almost none. `statusline-command.sh` (104 lines): only `green`/`red` for `+added`/`-deleted` diff counts (l.21), and the 20-cell context bar by threshold: green <50, yellow <80, red >= 80 (l.37-44). Model, cost, timer uncoloured.
2. not present.
3. ANSI-16 only; no detection, no NO_COLOR.
4. Foreground only.
5. Three spaces between segments; no separator glyph.
6. Emoji prefix per segment.
7. not present.
8. Emoji (`🤖 🌿 💭 💰 ⏱️`), `█░` bar.
9. Cost/reset from `ccusage blocks --json`, cached 5 min.
10. Edit script. `bin/install.mjs` only installs it (no colour options).

## github.com/daaar/claude-statusline
https://github.com/daaar/claude-statusline , stars 0
1. Fixed per segment plus threshold plus per-value. `statusline-command.sh:5-18`: model MAGENTA (l.148), dir BCYAN `96` (l.14), branch YELLOW with 🌿 (l.256), cost GREEN (l.167), "Context:" label WHITE, duration/API duration GRAY `38;5;245` (l.133-141), diff `+` GREEN `-` RED (l.242). `pct_color` (l.24-31): <50 green, <80 yellow, else red for ctx and 5h/7d bars and %. Effort level has its own per-value 256 colours (l.154-159): low 220, medium 71, high 147, xhigh 141, `max` rendered as a three-colour per-letter gradient (203, 209, 221).
2. not present.
3. ANSI-16 + a few 256-index. No detection, no NO_COLOR.
4. Foreground only.
5. `SEP=" ${WHITE}│${RESET} "` (l.18): bright-white box-drawing bar, same colour everywhere; effort uses a white `·`.
6. Hue per segment plus bright-white separators.
7. Comment on GRAY: "visible medium grey" (l.16) - picked for legibility, no adaptation.
8. Emoji (`⏱️ 🌐 💰 🌿`), `█░` bars.
9. Per-letter colouring of effort `max`.
10. Edit script.

## github.com/criptso/claude-code-statusline
https://github.com/Criptso/claude-code-statusline , stars 0
1. State only, as a continuous gradient. `statusline.sh:45-76` awk `setcol`: anchor colours muted green `(0,140,0)` -> yellow `(200,170,0)` -> orange `(210,115,0)` -> red `(200,45,40)`, interpolated linearly between per-meter thresholds t1/t2/t3 (ctx 20/30/50; 5h, 7d, per-model weekly 25/50/75; l.79, 89, 97, 130). The whole filled part of a bar takes one colour sampled at the current % (not per cell, header comment l.6); the % number uses the same colour; empty cells `38;2;80;80;80`. Everything else (model, token sizes, reset times, separators) `\033[2m` dim.
2. not present.
3. Truecolor only. No detection, no NO_COLOR.
4. Foreground only.
5. Dim `|` (l.90, 152).
6. Dim separators; labels only.
7. Palette described as "darker, easy on the eyes" (l.46); no adaptation.
8. `█░` bars, `↻` reset glyph.
9. Per-meter threshold tuning (context gets turned red at 50% because the author gates on context size); monthly API-equivalent cost segment via ccusage with env `STATUSLINE_ANCHOR_DAY`.
10. Env vars `STATUSLINE_IDENT` (ANSI prefix) and `STATUSLINE_ANCHOR_DAY`; edit script for colours.

## gist/92783f99af691c9ca941b4a649b68a73 (ryanzec, one-line jq statusLine command)
https://gist.github.com/ryanzec/92783f99af691c9ca941b4a649b68a73 , stars n/a
1. State only, written inline in a `jq` program (`gistfile1.txt` l.3): context % `>80` red `31`, `>60` orange `38;5;208`, `>40` yellow `33`, else reset; 5h session % and weekly % `>90` red, `>80` orange, `>65` yellow, else uncoloured. Labels, cost and token counts uncoloured.
2. not present.
3. ANSI-16 + one 256 (208). No detection, no NO_COLOR.
4. Foreground only.
5. Plain ` | `.
6. Labels only.
7. not present.
8. none (ASCII).
9. Different thresholds per meter (context 40/60/80; limits 65/80/90). Entire statusline is a settings.json `command` string, no file.
10. Edit the JSON string.

## github.com/tlqqqqqi/claude-statusline
https://github.com/tlqqqqqi/claude-statusline , stars 0
1. Fixed per segment plus one threshold. `statusline.py:10-22`: `[model (window) · effort]` CYAN bold `1;36` (l.~80), folder/branch icons uncoloured, cost and clock DIM (l.97-102). Battery bar and context-tokens segment share one colour by absolute INPUT TOKENS not percentage: <=200k WHITE `97`, <=400k YELLOW, else RED (`color_for_tokens`, l.25-31); applied to bar, % and token count (l.94-95).
2. not present.
3. ANSI-16 only. No detection, no NO_COLOR.
4. Foreground only.
5. `SEP = " DIM│RESET "` (l.22), dim vertical bar.
6. Dim separators; two lines (identity / metrics).
7. not present.
8. Nerd Font glyphs for folder, git, context, clock (l.18-21, comment "confirmed rendering in Ghostty"), no fallback; `▰▱` battery bar (10 cells, l.37).
9. Colour driven by tokens used, so it turns warn colours at 200k/400k irrespective of window size; "battery" shows remaining %.
10. Edit script.

## npmjs.com/package/claude-status-ollama
https://www.npmjs.com/package/claude-status-ollama , stars n/a (v1.0.1, chalk)
1. Fixed per segment plus threshold. `src/status.js:243-302`: model `chalk.cyan`, email `white`, "Think: ..." magenta, "Switched ->" yellow, reset text gray, `Auto Switch ON` green / `OFF` red (gray when absent) (l.90-96). Usage bars `usageSegment` (l.77-88): red >=90, yellow >=70, else green, colouring the bracketed bar `[####...]` only.
2. not present.
3. `chalk` ANSI-16 names; depth detection and `NO_COLOR` come from chalk itself (library behaviour, not code in this repo - unverified here). Own `--plain` flag swaps chalk for a pass-through Proxy and ASCII separator (`index.js:14`, `status.js:98-104, 302`).
4. Foreground only.
5. ` ${chalk.dim("|")} `, ` | ` in plain mode (l.302).
6. Hue per segment and dim pipes.
7. not present.
8. `--plain` = "Disable colors and emoji" (`index.js:14`); otherwise ASCII/`#` bars.
9. not present.
10. CLI flags (commander) `--plain`, `--token`, `--token-file`; env `OLLAMA_TOKEN`, `OLLAMA_TOKEN_FILE`.

## github.com/cyber-dani/claude-code-statusline
https://github.com/Cyber-Dani/claude-code-statusline , stars 1
1. State only, with grey as the calm state. `statusline.sh:8-20,47-53`: `pct_color`: >= `CRIT_PCT` 75 RED, >= `WARN_PCT` 50 YELLOW, else DIM (not green). Applied to context and each rate-limit item; context also YELLOW when `used_tokens >= WARN_TOKENS` 100000 even if % is low (l.81). Model+effort DIM. `statusline.ps1` is the same logic (`Get-PctColor`, l.27).
2. not present.
3. ANSI-16 only, hand-built `ESC`. No detection, no NO_COLOR.
4. Foreground only.
5. Plain ` | `, uncoloured; two spaces between the two limit items.
6. Separators; everything calm is dim so only warnings stand out.
7. DIM (SGR 2) as the neutral works on both polarities; no explicit adaptation.
8. ASCII only.
9. Silent-by-default design: no colour until a threshold trips.
10. Edit constants (`WARN_PCT`, `CRIT_PCT`, `WARN_TOKENS`); separate .sh and .ps1.

## github.com/ivanmurzak/claude-subscription-switcher
https://github.com/IvanMurzak/Claude-Subscription-Switcher , stars 2
not a Claude statusline renderer: a subscription-token auto-switcher. `src/statusLine.ts` is a telemetry collector that wraps and forwards the user's existing statusLine command (`--forward <base64>`, timeout 5000 ms, l.5-20, 328-330) and prints that command's stdout unchanged (l.197-199); it adds no colour. Its styling lives in the management dashboard: `src/tui.ts` (chalk; frame `#FB923C`, cyan labels, green/yellow/gray status, `[####----] NN% used` bars coloured red/orange/gray/green by quota severity, l.592-603) and `src/openTuiDashboard.ts:21-34` (hardcoded dark palette: bg `#090D13`, panel `#111827`, border `#334155`, text `#E5E7EB`, muted `#94A3B8`, blue/cyan/green/amber/red/violet/orange, rounded borders, active row background `#10251C`, `severityColor()` for the 5h/7d bars). Not relevant to statusline segment colouring.

## github.com/robin-dong/cc-statusline
https://github.com/Robin-Dong/cc-statusline , stars 0
1. Fixed per segment plus threshold, two lines. `statusline.sh:24-32,70`: dir CYAN, `(branch)` DIM, model BOLD (no hue), `Ctx: N%` and bar share `BAR_COLOR` green <50 / yellow 50-79 / red >=80 (l.43-48, `▓░`). Line 2 (l.71+): `30d:` cost YELLOW, `7d:` GREEN, `Today:` CYAN, `Session:` MAGENTA - each cost window its own fixed hue; labels DIM; tool list WHITE.
2. not present.
3. ANSI-16 only, `echo -e`. No detection, no NO_COLOR.
4. Foreground only.
5. DIM ` | `.
6. A different fixed hue per cost window, dim separators.
7. not present.
8. `▓░` bar; no emoji.
9. Costs come from ccusage cache.
10. Edit script; install.sh only copies it.

## github.com/ai-advanced-futures/clux
https://github.com/ai-advanced-futures/clux , stars 0
not a Claude statusline in the sense of `statusLine` command: a Claude Code plugin that writes tmux status-bar notifications and a per-session agent-state column. Styling is tmux-native `#[fg=...]` (`plugins/clux/scripts/agent-bar.sh:47-56`): four agent states each one colour glyph - busy cyan (animated frames `- \ | /` cycling, `helpers.sh:273-304`), needs-you yellow (`!`), finished green (`v`), failed red (`x`) - defaults in `helpers.sh:325-328` (`@clux-agent-*-color` tmux options, accepting any tmux colour spec). Glyphs plain ASCII one column by design (`helpers.sh:222-228`, "width is guaranteed in every terminal"). Other colour options: `--workspace-text-color`, `--notify-bg/-fg` (`render-clux-conf.sh:67-104`). Foreground only; no themes; customisation via tmux options or `/clux:setup`.

## github.com/goslowpoke168/claude-statusline
https://github.com/GoSlowPoke168/claude-statusline , stars 10
1. Fixed per segment plus gradient/threshold. `statusline-command.sh`: model BOLD Claude orange `217,119,87` and effort the same orange without bold (l.34-35); thinking on `180,130,255` purple / off `120,120,120` grey (l.47-49); mode `215,225,130` (l.56); cost `220,200,0` (l.124); `+added` `25,180,95` / `-removed` `220,40,20` (l.135-136); rate limits `120,200,255` (l.174); cwd `150,200,255` (l.210); branch `120,200,120` (l.226); worktree `0,220,220` (l.215); original-branch `220,180,0` (l.219); water segment `70,150,255` (`water.sh:138`). Context: 20-cell `█` bar, each filled cell coloured by its own position along a green(25,180,95) -> yellow(220,200,0) -> red(220,40,20) ramp (`color_at`, l.12-29, l.66-76), empty cells `60,60,60`; the % text takes the colour of the last filled cell (l.84-100); emoji tier green circle <20 / lightning <70 / fire <90 / siren (l.79-86).
2. not present.
3. Truecolor only (an env.truecolor hit exists in the installer); no fallback, no NO_COLOR.
4. Foreground only.
5. `SEP` dim gray pipe `110,110,110` with spaces (l.9-10).
6. Distinct hue per segment, grey pipes.
7. not present.
8. Emoji heavy (folder, leaf, drop, status tiers); circle glyphs for rate limits (`circle_glyph`).
9. Model colour is Anthropic's brand orange, not per-model. Position-gradient bar. README ships an SVG preview (`docs/statusline-water-preview.svg`). Optional water-usage segment. Windows PowerShell twin (`statusline-command.ps1`).
10. Edit script; install flags `--water-session/--water-lifetime/--water-equivalents` (PS: `-WaterSession` ...) control the water segment only.

## github.com/konnichiwab/claude-code-config
https://github.com/konnichiwab/claude-code-config , stars 0
Mostly not a statusline: a personal config repo. Its statusline `statusline-command.sh` (24 lines) prints one line of `Context: used / total tokens used (N% used, N% remaining) [model]` entirely in SGR 2 dim (l.19-21), nothing else coloured; hardcodes a Windows Python path. `settings-menu.py` is an unrelated Windows (`msvcrt`) animated settings TUI with a 256-colour palette (`c256`/`bg256`, l.21-29: orange 208, amber 214, cyan 39, green 77, selection bg 236, gradient list `GRAD`). Rest of repo is invoice-processing scripts. Styling points 2-10: not present for the statusline.

## github.com/dezeat/claude-usage-meter
https://github.com/dezeat/claude-usage-meter , stars 0
1. State-driven, one rule for everything. `src/bars.ts:36-47` `fillColor(used)`: <= 50 green, <= 70 yellow, > 70 red ("one flat colour rule for every bar", absolute used %, not pace, "user-validated"); used by `contextBar`, `paceBar` and the pill. Fixed per segment: model name `brightWhite` lowercased, location name `brightWhite`, row labels `accent` (bright blue `94`, `render.ts:321`), `⎇`/`⌂`/`·`/empty cells/resets `dim`, fleet `●` green. A white `│` pace marker sits between cells (non-colour hint, `bars.ts:60-75`).
2. not present. Six named colours in `src/ansi.ts:1-9`: reset, dim, green, yellow, red, brightWhite, accent.
3. ANSI-16 only. Honours `NO_COLOR` (any non-empty value, `statusline.ts:18-22`): all painting becomes identity (`paint(..., enabled)`), and pills degrade to `[NN%]` text (`meters.ts:16-23`).
4. Both: bars are foreground; the optional `pill` meter is reverse-video - black text `\x1b[30m` on `\x1b[42m/43m/41m` background by the same severity (`meters.ts:10-24`), selected by `USAGE_METER_METERS=pill`.
5. Dim `·` between cells (`layout.ts:50,61`).
6. Dim separators; row labels in accent blue.
7. not present (no light/dark handling).
8. `▓░` fill, `│` marker; `⎇ ⌂ ⟳ Σ ↑`; no emoji or Nerd Font. Shed/truncate by priority to fit COLUMNS (`layout.ts`: `DROP`, `truncateVisible`).
9. ADR-driven design: block (four rows) vs `line` single-line HUD; optional fleet roster of other sessions.
10. Env: `NO_COLOR`, `USAGE_METER_LAYOUT=line|block`, `USAGE_METER_METERS=bar|pill`, `USAGE_METER_FLEET=on`.

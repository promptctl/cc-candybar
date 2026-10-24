## mksglu/context-mode
https://github.com/mksglu/context-mode (32127 stars). A context-saving MCP/plugin; only `bin/statusline.mjs` is a statusline.
1. Fixed per segment, minimal: `statusline.mjs:85-91` defines `brand` bold cyan (`1;36`), `bold`, `dim`, `green`/`yellow`/`red`. Brand name = bold cyan, KPI numbers = bold default fg, labels = dim. The only state colour is a status dot `●` (`:224-226`): green if pct>=50, yellow if pct>=1, else green. Comment at `:82` says "single chromatic accent on the status dot".
2. Themes: not present.
3. Plain 16-colour SGR codes (`ansi(code,text)`, `:84`). Honours NO_COLOR and non-TTY stdout (`:83`). No depth detection.
4. Foreground-only text on the terminal's own background. Not present: filled cells.
5. Plain-text separator `SEP = dim("·")` (`:91`). Not powerline.
6. Neighbours are told apart by bold vs dim weight and the dim `·`, not by hue.
7. Not present: no light/dark adaptation; relies on terminal default fg plus bold/dim.
8. One Unicode dot `●`; no Nerd Font, no emoji in the line (`:240`).
9. Nothing else; the file comment stresses a deliberately near-monochrome design.
10. No config. The only knobs are env vars for session dir (`CONTEXT_MODE_DIR`) and NO_COLOR.

## jarrodwatts/claude-hud
https://github.com/jarrodwatts/claude-hud (28844 stars)
1. By role plus threshold, user-overridable. `src/render/colors.ts:93-127` fixes defaults per segment type: model cyan, project yellow, git magenta, gitBranch cyan, label dim, custom orange (`38;5;208`). Context bar/percent goes via `getContextColor` (`:131-141`): `colors.context` green below 70, warning yellow at >=70, critical red at >=85 (thresholds configurable). Usage windows via `getQuotaColor` (`:149-159`): brightBlue, brightMagenta at >=75 or pace warning, red at >=90 or pace critical. Defaults table at `src/config.ts:300-314`.
2. No named themes. `HudColorOverrides` (`config.ts:82-93`) is a flat per-role map: context, usage, warning, usageWarning, critical, model, project, git, gitBranch, label, custom, plus `barFilled`/`barEmpty` glyphs. Users override it in `claude-hud.json` / `config.json` (`config.ts:318-324`). Roles are semantic-ish, not palette roles.
3. Each override accepts a named ANSI preset (8 names), a 256 index (number), or `#rrggbb` truecolor (`colors.ts:42-52`, validated at `config.ts:367-371`). No downsampling. No NO_COLOR handling found in render code.
4. Foreground only. The bar is filled `█` in colour followed by `░` in DIM (`colors.ts:176-185`); no background fills.
5. Plain text: ` | ` in compact, ` │ ` in expanded (`expanded.ts:44,69`), `showSeparators` option (`config.ts:108`), and a `separatorLine` rule between line groups (`expanded.ts:154`). No powerline.
6. Hue per segment role (cyan vs yellow vs magenta) plus a dim label for the label/value distinction.
7. Not present: no background detection; relies on the terminal's ANSI palette, and `label` uses DIM. `ansi.ts` handles display-width, CJK and OSC8, not contrast.
8. Emoji and box glyphs; `barFilled`/`barEmpty` are user-replaceable single graphemes (`config.ts:376,431`); i18n label table (`t('label.*')`). No Nerd Font mode.
9. Layouts `compact` / `expanded` (`config.ts:16`), orderable segments (`projectLineOrder`), pace marker `▲` coloured by pace (`colors.ts:162-170`), usage `percent|remaining` mode.
10. JSON config file (`claude-hud.json` in the Claude config dir, or the plugin dir `config.json`) validated per key (`config.ts:395-433`). A `/claude-hud:configure` flow exists in the plugin (unverified, README only).

## ccusage/ccusage
https://github.com/ccusage/ccusage (19163 stars). Mostly a CLI usage-report tool; `statusline` is one subcommand.
1. By threshold, on one segment only. `rust/crates/ccusage/src/commands/mod.rs:704-711` `statusline_context_color`: green below `context_low_threshold` (default 50), yellow below `context_medium_threshold` (default 80), else red. Only the context `%` is coloured (`:695-700`). The burn-rate emoji is chosen by tokens/min (`:461-467`: under 2000 🟢, under 5000 ⚠️, else 🚨), shown only when `--visual-burn-rate` is not `off`. `docs/guide/statusline.md:133-137` claims coloured burn-rate text, but the Rust code does not colour it (docs and code disagree). Everything else (model, cost, block, today) is uncoloured.
2. Themes: not present.
3. Five named ANSI codes: blue 34, green 32, grey 90, red 31, yellow 33 (`rust/crates/ccusage-terminal/src/style.rs:20-26`). Honours NO_COLOR, FORCE_COLOR and isatty (`style.rs:34-39`). No 256 or truecolor.
4. Foreground only.
5. Plain ` | ` between segments, hard-coded in the format string (`mod.rs:480,531`).
6. Separators only; one pipe, no hue difference.
7. Not present.
8. Emoji prefixes per segment (🤖 💰 🧠 🔥, `mod.rs:531`); no Nerd Font or ASCII mode.
9. `--visual-burn-rate off|emoji|text|emoji-text` (docs `statusline.md:225-260`).
10. CLI flags (`--context-low-threshold`, `--context-medium-threshold`, `--visual-burn-rate`, `--cost-source`, model aliases) plus a ccusage config file (docs link to the configuration guide, unverified here).

## trailhq/Trail-Code
https://github.com/trailhq/Trail-Code (10723 stars). A code-graph tool; its statusline is `src/claude/format.ts` called from `src/claude/statusline.ts` (`.claude/helpers/graft-statusline.cjs` is only a loader).
1. Fixed per semantic role, four colours. `format.ts:15-20`: `indigo` truecolor `84;111;255` (brand name, "✓ synced", saved-token count), `amber` `224;165;68` (syncing, stale warnings, learnings count), `muted` 256-idx 244 (glyphs, labels, separators), `text` 256-idx 251 (values). Mapping at `:44-61`. Context % is plain `text`, with no threshold colouring.
2. Themes: not present. `src/brand.ts` provides a brand string (not a colour theme).
3. Truecolor for the two accents, 256-index greys for the neutrals; mixed. No detection, no NO_COLOR found in these files.
4. Foreground only.
5. Plain ` · ` in `muted` (`format.ts:21`), `◤ ` and `▸ ` line leaders.
6. Role colour (indigo or amber for status facts, text for values, muted for chrome); separators.
7. Not present.
8. Unicode glyphs (`◤ ✓ ⚠ ▸`); no Nerd Font or emoji in the bar.
9. Second renderer for subagents (`renderSubagent`, `statusline.ts:31`), which is a different line when `input.agent.name` is set.
10. No styling config. The statusline reads project cache files; install via `.claude/helpers/graft-statusline.cjs`.

## ykdojo/claude-code-tips
https://github.com/ykdojo/claude-code-tips (10266 stars). A tips repo; styling lives in `scripts/context-bar.sh` (the statusline) and `scripts/color-preview.sh`.
1. One accent colour for whole-line emphasis. `context-bar.sh:5-21`: `COLOR="blue"` selects `C_ACCENT` from a case table (orange 173, blue 74, teal 66, green 71, lavender 139, rose 132, gold 136, slate 60, cyan 37, `*` = gray). The accent colours the model name (`:177`) and filled bar cells (`:144-167`). Everything else uses `C_GRAY` (245), the empty bar uses 238. No state or threshold colouring.
2. A hand-edited 9-entry accent table; no theme format. `color-preview.sh` prints all variants for choosing one.
3. 256-index only (`38;5;N`). No detection, no NO_COLOR.
4. Foreground only.
5. Plain ` | ` in gray (`:177-180`).
6. Not distinguished: all non-accent text is the same gray; separators only.
7. Colours were picked "slightly darker" for legibility (`color-preview.sh` comments), but nothing adapts at runtime.
8. Emoji 📁 🔀 💬 and `█▄░` half-block bar (`:144-167`; the `▄` marks a half-filled cell).
9. Second line shows the user's last message prefixed `💬`, truncated to the first line's width (`:178-210`). Context % is estimated from the transcript with a 20k baseline.
10. Edit the `COLOR=` variable in the script; `jq` required.

## nilbuild/claude-statusline
https://github.com/nilbuild/claude-statusline (1395 stars)
1. By role plus threshold. `bin/statusline.sh:11-19` truecolor palette: blue (model `:171`), cyan (dir `:175`), green (git branch parens `:177`) with red for the dirty marker, white (durations and labels), magenta (high effort `:185`), orange (50-70% tier). `color_for_pct` (`:26-33`): >=90 red, >=70 yellow, >=50 orange, else green; applied to context % and to each rate-limit bar and percent (`:134,297-311`).
2. Themes: not present.
3. Truecolor `38;2;R;G;B` only, no detection, no NO_COLOR.
4. Foreground only; bars are coloured `█` over dim `░` (`:50`).
5. ` │ ` dim vertical bar (`:23`).
6. Hue per role plus dim `│`.
7. Not present.
8. Emoji (✍️ context, ⏱ time) and effort glyphs `● ◑ ◔` (`:185-188`), `⟳` for resets.
9. Multi-line rate-limit block: separate lines "current / weekly / extra" each with a bar (`:296-328`).
10. No config file; edit the script. `bin/install.js` installs it.

## hoangsonww/Claude-Code-Agent-Monitor
https://github.com/hoangsonww/Claude-Code-Agent-Monitor (1114 stars). Mainly a web dashboard plus MCP server. The statusline part is a sample `statusline/statusline.py` (and a Windows wrapper `statusline-command.sh`, which only calls it). The other flagged files (`mcp/src/ui/colors.ts`, client components) are dashboard styling, not statusline.
1. By role plus threshold. `statusline.py:46-52,57-110`: model CYAN, user GREEN, cwd YELLOW, branch MAGENTA; context bar RED at >=80, YELLOW at >=50, else GREEN (`:90-92`); cost RED at >=$20, YELLOW at >=$5, else GREEN (`:107`); tokens `in↑` GREEN, `out↓` CYAN, cache DIM.
2. Themes: not present in the statusline.
3. 16-colour SGR (`\033[0;3Xm`). No detection; NO_COLOR is handled in the other (CLI/dashboard) code, not here.
4. Foreground only.
5. Plain dim ` | ` (`:136`).
6. Hue per segment role plus dim pipes.
7. Not present.
8. `█░` bar, `↑ ↓` arrows; no emoji.
9. Nothing styling-related; the web UI is separate.
10. Edit the script and its install path (hard-coded Windows path in the wrapper).

## daniel3303/ClaudeCodeStatusLine
https://github.com/daniel3303/ClaudeCodeStatusLine (615 stars). Has `statusline.sh` and a `statusline.ps1` with the same palette.
1. By role plus threshold. `statusline.sh:16-25` truecolor: blue model (`:137`), cyan dir (`:145`), green branch/stat (`:147-149`) with red for deletions, orange token counts (`:154`), effort colour per level (`:158-163`: low dim, medium orange, high green, xhigh purple, max red), orange version (`:514`). `pct_color` (`:48-51`): >=90 red, >=70 orange, >=50 yellow, else green, used for 5h/7d/extra (`:403-413`). The context percentage itself is fixed green (`:154`) despite the helper.
2. Themes: not present. The comment at `:15` says the palette matches an oh-my-posh theme.
3. Truecolor only (`38;2`); PowerShell mirrors it (`ps1:18-25`). No detection, no NO_COLOR.
4. Foreground only.
5. Dim `|` (`:144,372`), `@` before branch/reset times.
6. Hue per role; dim pipes.
7. Not present.
8. No emoji; text labels (`5h`, `7d`, `extra`).
9. Update-available hint line (`:507`).
10. Edit the script; no config file.

## bencium/bencium-marketplace (emotion-statusline)
https://github.com/bencium/bencium-marketplace (467 stars). Only the `emotion-statusline` plugin is relevant.
1. By state and by role, two-line layout. `scripts/statusline-command.sh` header: "line 1 cool blues/cyans, line 2 warm complementary". Line 1: dir bright blue `\033[94m`, branch bright cyan `96`, `+n` green / `-n` red. Line 2: model white `37`, context % green below 50, yellow below 80, else red (`:35-54`), token arrows blue `34`. An emotion label from a classifier cache is coloured through a 15-entry map (`curious`=cyan, `satisfied`=green, `cautious`=yellow, `concerned`=red, `desperate`=bold red with a "verify output quality" warning, `unknown`=dim gray; `:93-109`).
2. Themes: not present.
3. ANSI 16 only, using bright variants (`9x`). No detection, no NO_COLOR.
4. Foreground only.
5. Dim `│` between segments (`|` before the emotion).
6. Hue by role plus dim pipes.
7. Not present.
8. Unicode arrows `↓ ↑`; no emoji.
9. Emotion-state colour keyed by a classifier hook (`classify-emotion.sh`), which is state-driven colour independent of numeric thresholds.
10. No config for colour; the map is in the script.

## vibe-log/vibe-log-cli
https://github.com/vibe-log/vibe-log-cli (339 stars). Its statusline shows a prompt-quality score, not session metrics.
1. By state, via emoji rather than SGR colour. `src/commands/statusline.ts:31-37` `getScoreEmoji`: <=40 🔴, <=60 🟠, <=80 🟡, else 🟢. The statusline text itself is not ANSI coloured (no escape codes in `statusline.ts` or `statusline-base.ts`).
2. Themes: not present. `src/lib/ui/styles.ts` defines a chalk palette (brand orange `#d97757`, accent `#FF5F56`, muted greys) but for the CLI menus, not the statusline.
3. Statusline: no colour spec. CLI menu: chalk hex with named fallbacks (`styles.ts:3-9`).
4. Not present (no fills).
5. Plain ` | ` in the format strings (`statusline.ts:62`).
6. Separators only.
7. The CLI palette comments say it is "optimized for visibility on both dark and light terminals" (`styles.ts:20`), but that is menu code.
8. Heavy emoji (`🟢 💡 ✨ 🌟 ⏳`).
9. Five output formats: compact, detailed, emoji, minimal, json (`statusline-base.ts:13`), and a configurable "personality" that rewrites the suggestion text.
10. CLI flag `--format`; a menu (`status-line-menu.ts`) to pick personality and install.

## NYCU-Chung/cc-statusline
https://github.com/NYCU-Chung/cc-statusline (265 stars)
1. By role plus threshold. `statusline.js:26-27` defines CYAN, GREEN, RED, YELLOW, MAGENTA, BLUE, DIM. Fixed: model CYAN (`:604`), repo CYAN and branch MAGENTA (`:547-548`), `+n` GREEN / `-n` RED (`:599`), memory/mcp health GREEN, agents running YELLOW/done GREEN (`:470-471`), mcp error state YELLOW (auth) / RED (`:515`). Threshold `cc(pct)` (`:141`): >=80 RED, >=50 YELLOW, else GREEN, applied to context and 5h/7d quota bars. Effort colour map (`:438-446`): low DIM, default/medium GREEN, high YELLOW, xhigh orange (`38;5;208`), max RED.
2. Themes: not present.
3. 16-colour SGR plus one 256-index orange. No detection, no NO_COLOR.
4. Foreground only.
5. Dim `·`, `│` and `→` depending on the row (`:606,657,660`).
6. Dim labels (`tokens`, `context`, `cost`) against coloured values, plus dim separators.
7. Not present.
8. Emoji and glyphs (`○ ✓ ▶ ◀`), CJK-aware width table (`:70-100`).
9. Multi-row dashboard; per-row on/off via `~/.claude/cc-statusline-rows.json` (`:13-22`); a session-summary row.
10. A JSON row-visibility file edited by a `/cc-statusline:rows` command. No colour config.

## Astro-Han/claude-pace
https://github.com/Astro-Han/claude-pace (241 stars)
1. By threshold. `claude-pace.sh:22` defines C(cyan) G(green) Y(yellow) R(red) D(dim). Model is cyan (`:281`); context bar colour `BC` (`:170`): >=90 red, >=70 yellow, else green; usage `%` (`:246`) same 90/70 tiers; `⇡n%` over-pace red, `⇣n%` under-pace green (`:250-251`); git `+AD` green, `-DL` red (`:219`).
2. Themes: not present.
3. 16-colour SGR. No detection, no NO_COLOR.
4. Foreground only.
5. Dim ` | ` (`:281,284`).
6. Role hue plus dim pipe.
7. Not present.
8. `█░` 10-cell bar, `⇡ ⇣` arrows.
9. The "pace" delta is the distinctive element: colour encodes burn rate relative to elapsed window time.
10. Env var `CLAUDE_CODE_AUTO_COMPACT_WINDOW` read; no colour config.

## BotchetDig/workout-gate
https://github.com/BotchetDig/workout-gate (220 stars). Not a Claude statusline: a webcam exercise gate for Claude Code. It exposes an optional `workout statusline` segment (`workout_gate/cli.py:222-229`): the whole segment, `🏋 <reps> 🔥<n>d`, is wrapped in one colour, 256-index 208 orange, honouring a `color` argument. The rest of the repo is a curses UI.

## awesomezun/claude-statusline
https://github.com/awesomezun/claude-statusline (201 stars). Five size presets (xs-xl) in `scripts/awesome-statusline-{xsmall,small,medium,large,xlarge}.sh` plus a PowerShell port.
1. By role and by gradient over a numeric value. The palette is Catppuccin: model teal, context label pink, 5H label lavender, 7D label yellow, cost yellow, directory subtext, clean-git/branch Latte green, dirty-git Latte yellow (`large.sh:34-45,158-197`). Bars are coloured per block via interpolated truecolor (`large.sh:50-107`): context goes Mocha pink to Latte maroon-red (stops at 30% and 70%, then fixed red); 5H goes lavender to Latte blue to Latte red (stop at 50%); 7D goes yellow to peach to red. The `%` number takes the gradient end colour in bold. xlarge header: stops at 40% and 80%.
2. One bundled palette (Catppuccin Mocha with Latte accents mixed in), hard-coded in functions (`cat_teal`, `latte_red`, …). No theme format, no user themes.
3. Truecolor only (`38;2`). The README troubleshooting tells tmux users to enable RGB (`README.md:208`). No downsampling, no NO_COLOR.
4. Foreground only.
5. Plain; lines are stacked rather than joined, with ` | ` inside lines 1-2.
6. Hue per role; each line starts with an emoji.
7. Not present, but Latte (light-theme) reds, greens and yellows are used for the alert end of gradients on a Mocha base.
8. Emoji-only (`🤖 📂 🌿 🧠 🚀 ⭐ 💰 ⏰`), "No Node, no Nerd Font" (`README.md:56`); effort `⚡` and thinking `💡` markers (`xlarge.sh:181-182`). The README ships a 12-font showcase.
9. Per-block gradient bars (176 gradient hits by the scanner) are the stand-out feature; the README shows a screenshot gallery.
10. Choose one of five presets by installer argument (`install.sh`, `xs`/`s`/`m`/`l`/`xl`). No other config.

## minorun365/my-claude-code-settings
https://github.com/minorun365/my-claude-code-settings (142 stars). A personal settings repo; the statusline is `claude/statusline.py` (48 lines).
1. By threshold, continuous. `gradient(pct)` (`:11-17`) emits truecolor green-to-yellow below 50% (`r = pct*5.1`, g 200, b 80), then yellow-to-red above 50% (`g = 200-(pct-50)*4`). Used for a `●` dot next to context, 5h and 7d percentages (`:21,35-47`). Model name is bold; everything else is plain.
2. Themes: not present.
3. Truecolor for the dot, SGR bold/dim; no detection, no NO_COLOR.
4. Foreground only (a coloured `●`).
5. Dim `·` (`:48`).
6. Separators only.
7. Not present.
8. Single `●` glyph; model name shortens `(1M context)` to `[1M]`.
9. A continuous gradient on a single dot, rather than a bar.
10. None; edit the script.

## ishefi/zellaude
https://github.com/ishefi/zellaude (117 stars). Not a Claude Code statusline: a Zellij tab-bar plugin (Rust/WASM) showing Claude Code session activity per tab. Styling for reference: truecolor fg and bg (`src/render.rs:54-59`), powerline arrow `\u{e0b0}` with fg=previous bg and bg=next bg (`:69,80-87`), bar background `(30,30,46)`, prefix `(60,50,80)`, active tab `(140,100,200)`, inactive tab `(80,75,110)`, flash `(80,80,30)` (`:72-77`). Activity colours are per state (`:31-50`): thinking purple `180,140,255`, any tool amber `255,170,50` (glyph varies by tool), waiting-for-permission red `255,60,60`, prompting/done green `80,200,120`, idle/init grey `180,175,195`. Input-mode label colours per mode (`:100-118`). Clickable tabs and a 2-second flash on permission requests; settings (notifications, flash, elapsed) are in `~/.config/zellij/plugins/zellaude.json`.

## travisjneuman/.claude
https://github.com/travisjneuman/.claude (106 stars). A personal Claude config repo; the statusline is `hooks/statusline.js` (49 lines).
1. No colour: plain text parts joined with ` · ` (`:46-49`): model, effort, `dir (branch)`, `ctx 118k`, cache hit ratio or "cache cold", `5h`, `7d`, cost. Empty parts are filtered out.
2. Themes: not present.
3. No ANSI emitted at all (the scanner's colour counts come from other hooks).
4. No fills.
5. Plain ` · `.
6. Separators only.
7. Not present.
8. None; no emoji.
9. Shows context as an absolute token count rather than a percent (`:5-6` comment).
10. None; edit the script.

## abhisekjha/pith
https://github.com/abhisekjha/pith (98 stars)
1. No colour: `hooks/statusline.sh` prints plain text (`PITH`, `PITH:LEAN`, `PITH:WIKI`, optional `↓N%`, `12k/200k`). The mode badge is conveyed by upper-case suffix only (`:51-60`).
2. Themes: not present in the statusline (the scanner's catppuccin and colour hits come from other tools in the repo).
3. No ANSI emitted.
4. No fills.
5. Spaces only.
6. Not distinguished.
7. Not present for the statusline.
8. One arrow `↓`.
9. Nothing styling-related.
10. None.

## Druthulu/ProjectArchitect
https://github.com/Druthulu/ProjectArchitect (93 stars). Statusline is `project-architect-3.0/pa/statusline.py` (3054 lines).
1. By state and threshold, with several fixed accents. `:42-52` defines 16-colour constants. Fixed: context token count MAGENTA (`:895-904`), `max` effort MAGENTA / `xhigh` BRIGHT_MAGENTA / `high` CYAN / `medium`,`low` DIM (`EFFORT_COLORS`, `:65`), model uncoloured, usage readings uncoloured (`:937`, comment "usage reading: no colour"), labels DIM. Thresholded: context bar (`_bar`, `:658-669`) is a 10-cell per-cell zone gradient, cells 0-3 green, 4-6 yellow, 7-9 red; window tiers (`_window_color`, `:672`) yellow at 50, red at 80; pace tiers (`_pace_color`, `:740`) yellow at 1.25, red at 1.75; `/day left` tiers (`_left_color`, `:749`) green >=14, yellow >=10, else red. Config keys `ctx_yellow`, `ctx_red`, `win_*`, `pace_*` (`:68-73`).
2. Themes: not present.
3. 16-colour SGR; the `colors` boolean in config switches painting off entirely (`_paint`, `:353-356`). No NO_COLOR, no depth detection.
4. Foreground only.
5. Dim ` | ` produced by `_join` (`:381-383`); segments are width-fitted (`_fit`, `:386`) with a `max_width` default 130 and shrink or ellipsis.
6. Dim separators and dim labels against coloured numbers.
7. Not present. The comments `# was LIGHT_BLUE` show the author moved from a blue "good" colour to green for contrast.
8. `⚠`, `≈`, `⇢handoff`, `—`; bar glyphs. No emoji, no Nerd Font.
9. Up to 7 lines (config `lines`), per-item `show` flags (`:73-92`), a `fewer_numbers` preset.
10. `statusline` block in the project's `config.json` merged over `STATUSLINE_DEFAULTS` (`:301-315`).

## sdsrss/code-graph-mcp
https://github.com/sdsrss/code-graph-mcp (85 stars)
1. No colour in its own segment: `claude-plugin/scripts/statusline.js` writes plain text via `process.stdout.write` (`:97-148,304`), e.g. `code-graph: ↻ indexing 12/40 (30%)`, plus an optional ` | N answers · N calls` tail (`:296-300`). The state is carried by the words and glyphs (`↻`, `✗`).
2. Themes: not present.
3. `statusline-composite.js:24` is the only escape code: a dim `\x1b[2m|\x1b[0m` separator used when chaining another statusline provider.
4. No fills.
5. Dim ` | ` in the composite (`statusline-composite.js:24`); plain text otherwise.
6. Separators only.
7. Not present.
8. Unicode glyphs `↻ ✗`.
9. The composite pipes stdin through a primary statusline command and appends its segment (statusline chaining, `statusline-chain.js`).
10. Env `CODE_GRAPH_STATUSLINE_COUNTS=0` hides the counts tail; no colour config.

## Priyanshu-Byte-Coder/contextrot
https://github.com/Priyanshu-Byte-coder/contextrot (77 stars)
1. By state and threshold. `src/contextrot/statusline.py:204-221`: a `Palette(green, yellow, red, dim, reset, cyan)`. `_zone` (`:304-318`) colours the context fill red at/above the user's calibrated "knee", yellow within 10 points below it, else green; uncalibrated fallback is red >=90, yellow >=70. Rate-limit meters use fixed generic thresholds (`:86` comment). Water-use segment is cyan on purpose ("water is not a health signal, so it borrows none of the three status colors", `:211-213`). Notes are dim; a past-threshold warning is red `▲ past threshold ~N%` (`:420-424`).
2. Three output palettes rather than themes: `ANSI`, `PLAIN`, and `TMUX` (`#[fg=green]` tags; tmux ignores ANSI) selected by `--format ansi|plain|tmux` (`:221-229`, `cli.py:1450`). No user colour themes.
3. 16-colour SGR (`\x1b[32m` etc.), `colour244` for dim in tmux. `PLAIN` is the no-colour mode; NO_COLOR is read in some other module (scanner count 1), not in `statusline.py`.
4. Foreground only.
5. Plain; segments joined by spaces and `·`.
6. Mostly one health colour per line; dim for secondary notes.
7. Not present.
8. Eighth-block smooth bar (`_bar`, `:286-301`, uses `▏…█` partials with `░`), `▲` warning, an animated droplet loop `▁▂█▂▁` driven by render count, not clock (`:477-486`).
9. The animated water-use droplet and the same status rendered to tmux and shell prompt (`cli.py:1161-1179`); a web showcase in `site/js`.
10. `--segments ctx,tokens,health,plan,cost,water|all` (`:84,232-247`) and `--format`.

## xleddyl/claude-watch
https://github.com/xleddyl/claude-watch (71 stars)
1. Fixed per segment, truecolor. `statusline-command.sh:94-125`: container marker `⬢` bold blue `97;175;239`, model orange 256-idx 208 bold, directory bold cyan `76;208;222`, branch bold magenta `192;103;222`, all usage/context readings (`5h`, `7d`, `ctx`) a single muted grey `156;162;175` with deltas dim. No threshold colouring.
2. Themes: not present.
3. Mixed truecolor and 256-index; no detection, no NO_COLOR.
4. Foreground only.
5. Grey ` | ` (`\033[90m`, `:6,9,34`).
6. Hue per identity segment (model, dir, branch); the numeric group is uniformly grey.
7. Not present.
8. One `⬢`; plain text labels.
9. Two lines: line 1 identity, line 2 usage and context; `fetch-usage.sh` supplies usage deltas.
10. None; edit the script.

## henchmarketing-rgb/headroom
https://github.com/henchmarketing-rgb/headroom (70 stars). Only `install.sh` is in the repo. The statusline it writes (`install.sh:108-131`) is a plain `██████░░░░ 60%` bar read from a token file, with no colour codes. The `GREEN/DIM/BOLD` variables in the file colour the installer's own messages only.
1-10: no colour or theme; 10-cell `█`/`░` bar, no separators; no config beyond editing the generated `~/.claude/statusline.sh`.

## MartyBonacci/specswarm
https://github.com/MartyBonacci/specswarm (66 stars). Two statusline pieces under `plugins/ss-status/statusline/`: `base-statusline.sh` (a full bash statusline) and `segment.sh` (a builder-status segment appended by `wrapper.sh`).
1. By role plus thresholds, 256-index. `base-statusline.sh:42-47`: dir sky-blue 117, model light-purple 147, version soft-yellow 180, CC version grey 249, style grey 245, worktree peach 215, git soft-green 150, usage lavender 189, cost gold 222, burn bright-gold 220, account pink 213, prompt mauve 183. Context tiers (`:67-71`): <50 mint 158, 50-80 gold 222, >80 coral 203. Rate-limit tiers (`:219-223`, `rate_limit_color`): <50 mint, 50-75 peach / 50-80 gold, >75/80 coral. Effort (`:54-57`): low sky blue, medium gold, high coral. `segment.sh`: building peach 215, session work gold 222, build died coral 203, idle mint 158. The palette is a pastel set with consistent roles (coral = bad, gold = caution, mint = ok).
2. Themes: header (`base-statusline.sh:4`) names `Theme: detailed | Colors: true | Features: …`, a generated-config comment; no switchable colour themes in the file.
3. 256-index only. Honours NO_COLOR (`:36`, `use_color=0`). No depth detection.
4. Foreground only.
5. Plain; `=`/`-` ASCII bar fallback (`:97-98`) beside block bars.
6. Distinct pastel hue per role.
7. Not present (same pastel on any ground).
8. Emoji (`🧠 🔨 ⚙ 💀 ✓`) and `⚠`.
9. `wrapper.sh` composes the user's own base statusline (cached) with the builder segment, re-rendering the segment every tick (`wrapper.sh:1-12`); this is a statusline-chaining design.
10. Features and colour on/off chosen when the script is generated (header line); env `SS_STATUS_BASE_MAX_AGE`; NO_COLOR.

## shanraisshan/claude-code-status-line
https://github.com/shanraisshan/claude-code-status-line (64 stars)
1. By state, minimal. `status-line.sh:25-28` defines BLUE/RED/YELLOW. Context circle bar `●○` is BLUE up to 60% and RED above (`:52-57`), filled cells only; rate-limit percentages (`format_limit`, `:75-87`) are RED at >=90, YELLOW at >=70, else uncoloured. Model name, token text and reset times are uncoloured.
2. Themes: not present.
3. 16-colour SGR; no detection, no NO_COLOR.
4. Foreground only.
5. Plain ` | ` and ` · ` between limits (`:104-118`).
6. Separators only.
7. Not present.
8. `●`/`○` circle bar, no emoji; loading state `○○○○○○○○○○`.
9. Effort or thinking appended to the model name as `(high)` / `(thinking)` (`:10-18`).
10. None; edit the script.

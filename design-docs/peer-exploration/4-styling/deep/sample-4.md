# sample-4: long-tail hardcoded-colour statuslines (25 projects)

Pattern across the batch (read from the files below): every project colours by state/threshold or by fixed segment, none by position; none has a theme system; none uses background fills except `claude-hud-combo` (the only powerline). Typical mapping is green/yellow/red on context or rate-limit percent, plus one or two fixed hues for identity segments.

## cc-quota-statusline
https://github.com/gxuanmo/cc-quota-statusline — stars 0
1. State only. `bin/cc-quota-statusline.mjs` `fmtBlock`: pct>=80 red `\x1b[31m`, >=50 yellow `\x1b[33m`, else green `\x1b[32m`; expired window dim `\x1b[90m`. Everything else (path `📁`, ccusage output) is wrapped from `ccusage statusline`, uncoloured by this script. Non-subscription fallback line (`📊 … 🧠 …`) has no colour at all.
2. Themes: not present.
3. ANSI 16 only (31/32/33/90). No depth detection, no NO_COLOR.
4. Foreground only.
5. Separators: plain ` | ` between the 5h and 7d blocks, newline-separated lines; no colour.
6. Neighbours: only the green/yellow/red state colour and emoji prefixes.
7. Light/dark: not present.
8. Emoji (`📁 📦 🚨 📊 🧠 🤖`); no ASCII mode.
9. Wraps ccusage (`--visual-burn-rate emoji-text`), so the first line's styling is ccusage's, not this repo's.
10. No config; edit the script; settings.json `statusLine.command`.

## gist 8db11824… (zeroam)
https://gist.github.com/zeroam/8db11824325b507bc19b774509d9290b — stars n/a
1. Mixed. `statusline-command.sh` `colorize_pct`: <=50 green, <=75 yellow, else red (`\033[32m/33m/31m`) applied to `ctx`, `5h`, `7d` values; missing value dim `\033[2m`; cost and elapsed time dim; reset countdown dim. Model and branch uncoloured.
2. Themes: not present.
3. ANSI 16; no detection, no NO_COLOR.
4. Foreground only.
5. Separator: three spaces (`sep="   "`), uncoloured.
6. Neighbours: whitespace gap only.
7. Not present.
8. Glyph prefixes for branch/worktree in the script (private-use characters, stripped in my fetch); no fallback mode.
9. Git branch cached 5 s per cwd.
10. Edit the script only.

## claude-hud-glm
https://github.com/BND-1/claude-hud-glm — stars 2 (fork of jarrodwatts/claude-hud; GLM/Zhipu quota added)
1. Fixed per segment with config override. `src/render/colors.ts` + defaults in `src/config.ts:283`: model cyan, project yellow, git `git:(`/`)` magenta, branch cyan, label dim, custom 208 (orange), context green. State: `getContextColor` warning>=70 yellow, critical>=85 red (thresholds configurable); `getQuotaColor` <75 brightBlue, >=75 brightMagenta, >=90 red.
2. Themes: not present as themes, but a `colors` block of 11 semantic keys (`context usage warning usageWarning critical model project git gitBranch label custom`) plus `barFilled`/`barEmpty` chars (`config.ts:58-69, 755+`). User-definable via the config file.
3. Value accepts named preset (8 names), 256 index number, or `#rrggbb` truecolor (`colors.ts resolveAnsi`). No depth detection, no NO_COLOR (grep found none).
4. Foreground only; empty bar cells `░` dim.
5. Separator: plain ` | ` or `│` (`session-line.ts:334` `parts.join(' | ')`), uncoloured.
6. Neighbours: different fixed hues per identity segment; separators only.
7. Not present (dim label assumes dark-ish terminal).
8. Unicode bars `█░` or `bar_style: ring` (`◌○◔◑◕●`, `colors.ts ringGlyph`); emoji `⏱️`, `⚠`. No Nerd Font.
9. Ring vs bar style toggle; i18n labels via `t()`.
10. JSON config file (`getConfigPath`), validated per key (`validateColorValue`).

## claude-code-core-statusline
https://github.com/sunwxxpi/Claude-Code-Core-Statusline — stars 0
1. Fixed per segment. `statusline-command.sh`: model purple `38;5;141`, dir+branch cyan-blue `38;5;69`, context line green `38;5;71` (all of it, bar included, no threshold: `BAR_COLOR="$GREEN"`), cost yellow `38;5;179`, usage line yellow `38;5;179`. `RED='\033[31m'` is declared but unused. Version and mode uncoloured.
2. Themes: not present.
3. 256-colour indices plus one ANSI 16; no detection, no NO_COLOR.
4. Foreground only.
5. Separator: plain ` | ` uncoloured inside the line; three separate lines.
6. Neighbours: different hues for model vs dir; yellow shared by cost and usage.
7. Not present.
8. ASCII bar `[====----]`; no icons.
9. Fetches Anthropic OAuth usage (`api.anthropic.com/api/oauth/usage`) for plan %.
10. Edit script; `install.sh`.

## cc-minimal-statusline
https://github.com/runsonmypc/cc-minimal-statusline — stars 0
1. Fixed per segment plus a state gradient. `statusline.sh:164-173`: version/separators dim `38;5;239`, model orange truecolor `38;2;230;113;78` (#E6714E), dir blue `38;5;75`, worktree flask cyan `38;5;80`, branch purple `38;5;141`, lines added green `38;5;108`, removed red `38;5;167`, effort gray `38;5;245`, ultracode violet `38;2;175;135;255`. Context bar: `BAR_COLORS` 20-entry truecolor array (every 5%) from green (70,200,70) through gold (255,200,0) and the model colour (193,95,60) at 75-79% to red (220,60,60), indexed by `pct/5` (`generate_bar`, line 360).
2. Themes: not present.
3. Mixed 256-index and truecolor; no depth detection, no NO_COLOR.
4. Foreground only; unfilled bar `━` in dim gray.
5. Separator: none; two-space gap, "colors carry the separation" (comment at `build_status`).
6. Neighbours: distinct hue per segment, no separator glyph.
7. Not present.
8. Nerd Font icons (branch U+E725, flask U+F0C3, file U+F15B, arrow U+F062, compact U+F0615 at lines 175-180); no ASCII fallback.
9. Bar colour deliberately passes through the Claude brand colour; width-aware layout (`visible_width`).
10. Edit script; postinstall/update-check scripts.

## claude-code-context-meter
https://github.com/IntertechInc/claude-code-context-meter — stars 0
1. State only. `statusline-ctx.sh:~166`: context fill pct>=90 red `31`, >=70 orange `38;5;208`, >=50 yellow `33`, else green `32` (thresholds credited to daniel3303/ClaudeCodeStatusLine). Only the `(tokens/max, pct%)` parenthetical is coloured; model, delta, sparkline and rate limits are plain.
2. Themes: not present.
3. ANSI 16 + one 256 index. Env `CTX_NO_COLOR=1` disables (not the standard NO_COLOR).
4. Foreground only.
5. Separator: plain ` | ` before rate limits.
6. Neighbours: plain/coloured contrast only.
7. Not present.
8. Unicode sparkline `▁..█`, `▲ ▼ ● ⟲`; no icons.
9. Per-turn delta, growth sparkline, compaction marker `⟲M/⟲A` via PreCompact hook.
10. Env: `CTX_SPARK_WIDTH`, `CTX_COMPACT_MIN`, `CTX_NO_COLOR`.

## jorruss claude-code-status-line
https://github.com/jorruss-git/claude-code-status-line — stars 0
1. Fixed per segment, bar by state. `statusline-command.sh`: dir cyan `36`, model blue `34`, context line orange `38;5;214` (label) with bar green/yellow/red at <70 / >=70 / >=90 (`progress_bar`), tokens white `37`, branch green `32`. 
2. Themes: not present.
3. ANSI 16 + one 256 index; no detection, no NO_COLOR.
4. Foreground only.
5. Separator: ` | ` in bright-black `\033[90m`.
6. Neighbours: distinct hue per segment.
7. Not present.
8. `█░` bars only; no icons.
9. Duplicate-ish token bar for total tokens vs window.
10. Edit script.

## aperea-cc claude-code-status-line
https://github.com/aperea-cc/claude-code-status-line — stars 0
1. Fixed per segment, no thresholds. `statusline-command.sh`: repo/path cyan bold `\033[01;36m`, branch green bold `01;32`, rate info (5h/7d) yellow bold `01;33`. 
2. Themes: not present.
3. ANSI 16 bold; no detection, no NO_COLOR.
4. Foreground only.
5. Separator: plain ` | ` uncoloured.
6. Neighbours: three hues (cyan/green/yellow).
7. Not present.
8. None.
9. Palette copies the default bash PS1 colours (`01;36`, `01;32`).
10. Edit script; `statusline-wrapper.sh`.

## codex_hud
https://github.com/Feng-Y-28/Codex_hud — stars 3
not a Claude statusline: Codex CLI wrapper that runs Codex in a PTY and draws a usage row under its footer (README: "Terminal usage HUD for Codex"); a descendant of claude-hud's styling (ANSI 16 model cyan / project yellow / git magenta / context+quota thresholds, `src/colors.js`; honours `NO_COLOR`, `src/hud.js:35`).

## beedev claudestatusline
https://github.com/beedev/claudestatusline — stars 0
1. State only. `statusline.js:16` `colorForPct`: >=90 red, >=50 yellow, else green; applied to the model name (by context %), and to the 5-hour and weekly usage bar and percent. Labels `current`/`weekly`, token counts uncoloured.
2. Themes: not present.
3. ANSI 16; no detection, no NO_COLOR.
4. Foreground only.
5. Separator: two spaces / newlines; none coloured.
6. Neighbours: spacing only.
7. Not present.
8. Bar `●○` ×10 (`makeBar`); no icons.
9. Reads OAuth credentials (including a Windows credential-manager P/Invoke) and caches usage 60 s.
10. Edit script; `install.js`.

## @botaoxyz/claude-statusline
https://www.npmjs.com/package/@botaoxyz/claude-statusline — stars n/a (npm 1.0.0)
1. Fixed per segment, applied to the icon only. `dist/index.mjs`: `o={model:yellow(icon), folder:blue(icon), git:green(icon), context:cyan(icon)}` with SGR 93/34/32/36. Values (model name, folder, branch, `█░` bar, pct) are uncoloured; no thresholds.
2. Themes: not present.
3. ANSI 16 bright-yellow plus basics; no detection, no NO_COLOR.
4. Foreground only.
5. Separator: plain ` | `.
6. Neighbours: icon colour differs per segment, separators.
7. Not present.
8. Nerd Font icons (4 private-use glyphs in `o`); no fallback. Bar `█░` 15 wide.
9. Git status in starship style (`⇡⇣ = + ! » ✘ ? $`).
10. None; edit source. Minified single file.

## parvezrob/claude-dotfiles
https://github.com/parvezrob/claude-dotfiles — stars 0
1. State plus fixed. `claude/statusline.sh:98-130`: one 4-colour palette: teal `38;5;86`, amber `214`, red `203`, green `72`. `color_for`: teal <80%, amber 80-89, red >=90 on context and session/week limits. Fixed: tok in/out teal, `+lines` green / `-lines` red, PR approved teal / changes-requested red / else dim, cache-hit teal >=90, amber <90, red <50. Dim `\033[2m` for labels.
2. Themes: not present.
3. 256 index; no detection, no NO_COLOR.
4. Foreground only.
5. Separator: dim `·`.
6. Neighbours: separator only; most text is the same teal.
7. Not present (explicit ambiguous-width handling for right-alignment, `dispw`, is layout not colour).
8. `↻ ✓ ✗ — ·` Unicode, no icons.
9. Model and effort right-aligned using `$COLUMNS` (`emit_line`).
10. Edit script.

## gist bf56afc2… (zafstojano)
https://gist.github.com/zafstojano/bf56afc2c4dc0ad081210e554a04ef1a — stars n/a
1. One accent for everything. `statusline-command.sh`: model, `ctx` bar, `5h` bar, `7d` bar all orange `38;5;208`; labels and `│` gray `38;5;245`. No thresholds.
2. Themes: not present.
3. 256 index; no detection, no NO_COLOR.
4. Foreground only.
5. Separator: gray `│` with two-space padding.
6. Neighbours: orange values against gray labels.
7. Not present.
8. `█░` bars; no icons.
9. Brand-orange only look.
10. Edit script.

## claude-hud-combo
https://github.com/danmestas/claude-hud-combo — stars 1
1. Fixed per segment on line 1, state on line 2. `src/statusline.ts:126` `COLORS`: each powerline segment has a truecolor `{fg,bg}` pair: model white on (56,56,56); directory (137,192,240) on (23,48,71); git (122,235,206) on (20,56,50); context (255,188,92) on (64,44,14); session = git's pair; output_style (160,206,245) on (28,42,66). Line 2 `quotaColor`: <75 brightBlue `94`, >=75 brightMagenta `95`, >=90 red. Child-process names coloured by role (nats green, context-mode cyan, caffeinate yellow, mcp brightBlue; `ChildRole`, line 463).
2. Themes: not present.
3. Truecolor for powerline, ANSI 16 elsewhere; no detection, no NO_COLOR.
4. Both: filled backgrounds on line 1, foreground on the rest.
5. Powerline arrow U+E0B0 (`POWERLINE_SEP`, line 56). `renderPowerline` (line 105): arrow fg = this segment's bg, arrow bg = next segment's bg; last arrow drawn on default bg (`\x1b[49m`).
6. Neighbours: different hue family per segment (grey / blue / teal / amber / teal / blue), dark bg with a bright same-hue fg; comment at line 122 says backgrounds are kept distinct "even where the separator arrow is subtle". git and session share a pair and sit apart (context between).
7. Text contrast is hand-picked per pair (bright fg over dark saturated bg, comment line 122); no adaptation to terminal.
8. Nerd Font icons per segment (`\u{e725}` branch, `\u{f0e7}` bolt); `●` status dots.
9. Progressive-drop layout: when line 1 overflows, segments drop in order output_style, directory, session, git (`DROP_ORDER`, line 760), ellipsis last resort.
10. Deno script; no config file (edit `COLORS`).

## simple-cc-statusline
https://github.com/ZephyrCICD/simple-cc-statusline — stars 2
1. Mixed fixed/state. `scripts/setup-statusline.sh` (writes a node script; colours at lines 38-60, use 245-256): path blue, git `Git` label dim + branch blue, model blue, effort magenta, context `ctxColor` >=85 red, >=70 yellow, else green; token speed arrows dim with values green; update hint yellow. `blue` here is bright `94`, magenta bright `95`.
2. Themes: not present.
3. ANSI 16 (incl. bright); no detection, no NO_COLOR.
4. Foreground only.
5. Separator: plain ` | ` (`parts.join(' | ')`).
6. Neighbours: path, branch, model all blue, separated by `|` only.
7. Not present.
8. `↑ ↓` text arrows only.
9. Installer script also provides a PowerShell variant.
10. Edit the generated script.

## oh-my-toomuchtalker
https://github.com/tristanjung1006/oh-my-toomuchtalker — stars 0
not a Claude statusline: an MCP/CLI "shout" chat for Claude Code; its HUD (`src/hud/wrapper.mjs`, `renderer.ts formatHudMessage`) wraps the previous statusline and appends a plain `[shout] "text" — author` string with no colour codes; chalk (`lib.chalk`) is used only in its CLI output.

## grrru/claude-status
https://github.com/grrru/claude-status — stars 0
1. State plus fixed, deliberately terminal-theme-relative. `claude-status:8` comment: only the terminal theme's basic 16 colours, "labels dim, values default colour, only status coloured". `pcolor` usage <50 green, <90 yellow, else red (line 15); `ctx_color` >=60 red, >=40 yellow else green (line 19). Fixed maps: `EFFORT_COLORS` low green / medium,high yellow / xhigh red / max,ultra magenta; `REVIEW_COLORS` approved green / pending yellow / changes_requested red / draft dim; `PLAN_COLORS` enterprise magenta / team blue / max yellow / pro green (lines 60-63). Directory head dim, last segment default.
2. Themes: not present, but user picks which elements show (see 10).
3. ANSI 16 only, using `\033[22;3Xm` (explicit non-bold) and `\033[22;39m` default text; no NO_COLOR.
4. Foreground only; curses TUI uses `use_default_colors()` so the terminal background shows through (line 575).
5. Separator: dim ` | ` (`SEP`, line 13).
6. Neighbours: dim labels vs default-colour values; separators.
7. Yes in spirit: avoids hardcoded RGB so that light and dark terminal themes recolour it (comment line 8).
8. Effort marks `○ ◐ ● ◉ ★ ⚡`, review marks `✓ ● ✗ ◌`; OSC 8 links for PRs; OSC 9;4 terminal progress bar.
9. OSC 9;4 taskbar progress state (line 397).
10. `~/.claude/claude-status.json`; curses TUI to toggle elements per plan (`ELEMENTS`, `claude-status` TUI).

## rashidul-rahul/claude-code-statusline
https://github.com/rashidul-rahul/claude-code-statusline — stars 6
1. State plus fixed. `statusline.sh:166-247`: palette gray 245, dgray 240, white 252, blue 81, magenta 176, green 114, amber 214, red 203. Model blue; effort max/xhigh red, high amber, medium green, else gray; dir white; branch magenta, dirty marker amber, arrows gray; context bar green <60 / amber 60-79 / red >=80; rate 5h gray <60 / amber / red >=85; cost gray <$5, amber, red >=$20.
2. Themes: not present.
3. 256 index; no detection, no NO_COLOR.
4. Foreground only.
5. Separator: dark gray `·` (`sep`, line 227).
6. Neighbours: different hues, dim separators.
7. Not present.
8. `◈ ⧉ ⎇ ↻` Unicode glyphs; no Nerd Font.
9. Quiet defaults: rate limits gray until warning.
10. Edit script; `install.sh`.

## m0s-indicator
https://github.com/m0squared/m0s-indicator — stars 5
1. State plus fixed. `core/indicator.py:27-114`: bright ANSI (92/93/91/96). `color_used` (ctx): >=80 red, >=50 yellow, else green; `color_remaining` (quota, drains): <20 red, <50 yellow, else green. Plan badge `BADGES`: pro cyan, max bright magenta `95`, payg yellow, free dim; agent badges Codex magenta, Gemini blue. Labels dim.
2. Themes: not present.
3. ANSI 16 bright; no detection, no NO_COLOR.
4. Foreground only.
5. Separators: dim `│` (`SEP`) between bars, dim `·` (`DOT`) between identity parts.
6. Neighbours: separators, plan badge hue.
7. Not present.
8. `[████░░░░]` bracketed bars, `↺`; emoji in installer only.
9. Multi-agent (Claude Code, Codex, Gemini) in one HUD; `rows` or `inline` layout.
10. `~/.m0squared/config.json` (`layout`, `plan`); CLI install/uninstall.

## Qiita: takana_eng statusline article
https://qiita.com/takana_eng/items/6110998bc3fdc7515bf6 — stars n/a (Japanese blog post)
1. State only. Script in the article: `get_color`: <=50 green, <=80 yellow, else red (`\033[32m/33m/31m`) for context bar and %, and for 5h / 7d percentages. Model and token counts uncoloured.
2. Themes: not present.
3. ANSI 16; no detection, no NO_COLOR.
4. Foreground only.
5. Separator: none; two lines (`⏳ 5h: … 7d: …`).
6. Neighbours: not applicable beyond the colour per value.
7. Not present.
8. Bar `▓░` ×10, `⏳` emoji.
9. None.
10. Edit script; settings.json `statusLine`.

## supadLL/deepseek-hud
https://github.com/supadLL/deepseek-hud — stars 1
1. Mixed. `src/render.js` + `src/format.js:13` (`C` = reset, bold, dim, red, green, yellow, cyan, white): model cyan bold in brackets (render.js:71), context bar green <70, yellow 70-89, red >=90 (`format.js:84-88`), cache `⟳` green, cost `💰` yellow, input tokens white, output/labels dim. README "Color Reference" documents the same.
2. Themes: not present.
3. ANSI 16; no detection, no NO_COLOR.
4. Foreground only.
5. Separator: plain ` | `.
6. Neighbours: separators plus differing hues.
7. Not present.
8. Emoji heavy (`📁 💰 🗜️ ✅ ❌ 💎`), `↑ ↓ ⟳`; no ASCII mode.
9. Three-line HUD with real DeepSeek balance/usage, bilingual labels (`fmt.t`), animation flagged by scanner (not styling).
10. Language and layout set via install; no colour config.

## parzival1l/claude-code-statusline
https://github.com/parzival1l/claude-code-statusline — stars 2
1. Fixed plus state. `statusline.sh`: model `[name]` cyan; dir and branch uncoloured; `|` dim; context bar red at WARN_PCT_HIGH (50), yellow at WARN_PCT_MED (40), else green; trailing percent warning: >=20 yellow bold, >=40 orange `38;5;208` bold, >=50 red bold.
2. Themes: not present.
3. ANSI 16 + one 256 index; no detection, no NO_COLOR.
4. Foreground only.
5. Separator: dim ` | `.
6. Neighbours: separators only (cyan model is the only fixed hue).
7. Not present.
8. `█░` bar only.
9. Early-warning thresholds tuned low (20/40/50%) as the author wants to clear context early.
10. Env vars `STATUSLINE_WARN_PCT_LOW/MED/HIGH`.

## tickerline
https://github.com/avalidurl/tickerline — stars 0
1. Fixed plus state. `tickerline.js:14`: stock tickers green if up / red if down / uncoloured if unknown (`:398`); market-closed keeps colour with a dim dot; prediction-market prob green >=60, red <=25, else yellow; index numbers cyan; context bar green/yellow(>=70)/red(>=90) (`:413`); branch cyan; cost yellow. Separator dim.
2. Themes: not present.
3. ANSI 16; no detection, no NO_COLOR.
4. Foreground only.
5. Separator: dim `|` with three-space gaps (`GAP`, line 461).
6. Neighbours: semantic colour per item, gaps.
7. Not present ("whole-DIM vanishes on dark themes" comment at `:399` shows awareness).
8. Emoji/Unicode default (`🌿 ▲ ▼ █ ░ ⚠ …`) with an ASCII mode (`glyphs(ascii)` line 52: `^ v # - ! | . ...`).
9. Scrolling ticker animation (`scrollSpeed`), OSC 8 click-through links.
10. `~/.claude/tickerline.json`; env `TICKERLINE_ASCII/MODULES/TTL/CONTEXT_AWARE/POLYMARKET`; interactive setup prompt.

## OlafvanDijk/Token-Saver
https://github.com/OlafvanDijk/Token-Saver — stars 0
1. One colour for everything. `scripts/statusline.js:6`: the Claude-mascot ASCII art in orange truecolor `38;2;215;119;87` and the "saved" sign in bold; no other colours. Output is a mascot jumping with a "~12.4k saved" sign (frame alternates each second).
2. Themes: not present.
3. Truecolor + bold; no detection, no NO_COLOR.
4. Foreground only.
5. Separators: box-drawing sign frame `┌─┐│└┘`, no colour.
6. Neighbours: not applicable.
7. Not present.
8. Block-character mascot, 👍 emoji.
9. Animation: mascot lifts every second via `Date.now()` parity; multi-line statusline.
10. Edit script; the plugin is a token-saving hook set and the statusline is incidental.

## ilemuelfigueira/claude-code-statusline
https://github.com/ilemuelfigueira/claude-code-statusline — stars 0
1. Fixed per segment, with only effort level by state. `statusline.sh:22-85`: repo owner magenta `35` and repo name blue `34` (`owner @ name`); with no repo, directory magenta; effort low green, medium yellow, high red, xhigh/max magenta. Branch, model, cost, 5h uncoloured; context bar uncoloured `[███░░░] 42%`.
2. Themes: not present.
3. ANSI 16; no detection, no NO_COLOR.
4. Foreground only.
5. Separator: plain `|` and the word `on`.
6. Neighbours: whitespace and `|`.
7. Not present.
8. `█░` bars; no icons.
9. Responsive layout: bar width computed from `COLUMNS`/`tput cols`, 5 to 20 cells (`bar_min/bar_max`), right-aligned.
10. Edit script.

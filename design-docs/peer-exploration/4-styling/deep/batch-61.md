## sleepydogx/claude-statusline
https://github.com/sleepydogX/claude-statusline — stars 0
1. Fixed per segment, plus thresholds. `statusline.js` hardcodes SGR per segment: model bold 256-colour 141 (`:565`), workspace bold cyan / path bold blue (`:559-561`), repo bold white, branch bold green (`:488-489`), worktree 114, supabase 42, task 220, session label 213 (`:276`), duration bold magenta (`:325`), cost bold yellow (`:335`), lines +green/-red (`:527`), output style cyan (`:223`), fast mode bold bright cyan (`:238`). By threshold: rate limits `colorPct` (<50 green, <75 yellow, <90 orange 208, else blinking red `5;31`, `:346-350`); context bar+% same 4 steps (`:538-544`, last step adds a skull and blink); PR colour by review state (approved green, changes_requested orange, pending yellow, draft dim, `:592-595`); effort level colour map (low 245, medium green, high yellow, xhigh 208, max bold magenta, `:195-201`).
2. Themes: not present. No theme format; colours are literals in the file.
3. Raw ANSI 16 + 256 index (`38;5;N`); no truecolor, no depth detection, no NO_COLOR handling found in `statusline.js`.
4. Foreground-only text on the terminal's own background; no background fills.
5. Separators: plain text. A dim `│` (U+2502) between rate-limit parts (`:369`), dim `›` between workspace and path (`:559`).
6. Neighbours are told apart by distinct fixed hues per segment, emoji prefix per segment, and bold. No lightness stepping.
7. Light/dark adaptation: not present. Uses `dim` and 245/249-ish greys; no contrast logic.
8. Emoji-heavy (🧠 💰 📁 📂 🐙 🌳 🏷 📅), geometric symbols (⎇ ⬡ ⚙ ⚡), `█`/`░` 10-cell context bar (`:535`). No Nerd Font, no ASCII mode.
9. Blinking SGR 5 on critical rate-limit and context states (`:350`, `:544`). OSC 8 link helper (`:27`). Install/uninstall scripts.
10. Customisation: `~/.claude/statusline-config.json` is `Object.assign`ed over a `MODULES` on/off map (`:77-97`); only module toggles, no colour options. Env: `CLAUDE_CODE_EFFORT_LEVEL` read for effort (`:155`).

## smartanalyticsav/claude-sessions-panel
https://github.com/SmartAnalyticsAV/claude-sessions-panel — stars 0
not a Claude statusline: a Claude Code mod (Ink panel, `hooks/register.tsx`) listing live sessions and 5h/weekly limits. For reference, it colours by Ink semantic theme-role names rather than hex: session state groups `waiting`=warning, `busy`=success, `other`=subtle, `idle`=inactive (`hooks/sessions.ts:40-43`); limit bars `error` >=90, `warning` >=70, else `success` (`sessions.ts:162`). UI is Russian.

## smbslt3/agent-statusline
https://github.com/smbslt3/agent-statusline — stars 0 (README says it is a fork of uppinote20/claude-dashboard adding Antigravity "agy" host support)
1. By theme role, then state. `scripts/utils/colors.ts` defines `ThemeColors` roles (`model, folder, branch, safe, warning, danger, secondary, accent, info, barFilled, barEmpty` plus raw red..gray, `:11-37`). `getColorForPercent` (`:347-352`): <=50 safe, <=80 warning, else danger; used by `widgets/context.ts:64`. Model mark and name are HOST-branded, not model-branded (`widgets/model.ts` header): Claude Code = coral `#D97757` `✽`; Antigravity host = per-character blue-green-orange-red gradient (`utils/provider.ts:24-92`, `gradient()` `:66`). The model widget shows effort as a badge letter (U/M/xH/H/M/L).
2. Themes: 9 bundled, as role maps in `colors.ts` `THEMES`: default (256-index pastels), minimal (white/grey only), catppuccin, catppuccinLatte, dracula, gruvbox, nord, tokyoNight, solarized (truecolor hex). Format is semantic roles (above). README table `theme` lists them. Users pick a name only; no user-defined themes found.
3. Mixed per theme: default uses 256-index (`38;5;117` etc.), minimal uses ANSI 16, the rest 24-bit `38;2;r;g;b`. No depth detection or downsampling and no NO_COLOR in `colors.ts` or `statusline.ts` (grep).
4. Foreground only; no background fills.
5. Separators plain text, set by `separator` config: `pipe` │, `space`, `dot` ·, `arrow` › (`colors.ts` `SEPARATOR_CHARS`, drawn in theme `dim`).
6. Neighbours distinguished by role colour differences plus the separator; no alternation or lightness logic.
7. Light handling = a `catppuccinLatte` theme the user must choose (it is the only light-background theme; its `white` role is a dark `#4c4f69`). No auto-detection or contrast computation.
8. Unicode symbols and emoji; no Nerd Font and no ASCII mode noted.
9. Per-host brand colouring and the agy rainbow gradient on the model name are the stand-out features. Statusline can run a render loop (`scripts/render-loop.ts`).
10. Config: JSON file with `displayMode`, `theme`, `separator`, `rateLimitResetDisplay` (README `:82-88`), per-host file; `/agent-statusline:setup` slash command. No env vars for colour.

## snackdriven/claude-statusline
https://github.com/snackdriven/claude-statusline — stars 0
1. Per region, chosen by each producer script. Producers write JSON regions `{id,text,color,priority,row,...}`; `buddy/render.sh:179-186` and `buddy/assemble.py:25-28` map a colour NAME to ANSI: dim=90, cyan=36, magenta=35, yellow=33, red=31, green=32, default=reset. Examples: `producers/context.sh:113-123` (threshold: red with 🔴/🔶, yellow with ⚠️, default, dim); `producers/gh.sh:60-63` (colour by active gh account: work account = 256-colour 117 sky, personal = 217 pink, unknown = yellow, inline "Catppuccin 256-color palette"). Most regions default to `dim`.
2. Themes: not present. The README mentions Catppuccin only as the source of two hand-picked 256 colours in `gh.sh`.
3. ANSI 16 names plus two inline 256-colour codes; no depth detection, no NO_COLOR. Width via stdin `.terminal.width`, falling back to `tput cols`.
4. Foreground only.
5. Separators: plain text. ` · ` inside a zone, `◆` between zones (`assemble.py:5`, `INTRA`), not coloured by neighbours.
6. Neighbours told apart by zone grouping (work / context / calendar), the `◆` zone marker and per-region colour name; rows are assigned by a `LAYOUT` map (`assemble.py:33-44`), three rows minimum.
7. Not present.
8. Emoji and unicode only; `short` variants of a region swap in when a row overflows. No Nerd Font.
9. Clickable regions via OSC 8 `href` (`assemble.py:55-62`). Width-budget fitting drops low-priority regions.
10. Customisation = editing producer scripts (the colour map is "edit the case statement"); renderer colour map in `render.sh`/`assemble.py`. No config file for colours.

## snowsky1/clawd
https://github.com/SnowSky1/clawd — stars 0
Styles the Clawd mascot shown in a status line (it can also wrap the claude-hud output), not the data segments.
1. One colour for the mascot per skin: `skins/skins.json` has 23 skins, each `{label, body:[r,g,b], faceBg:[r,g,b], snow?, snowColor?}`. e.g. classic body `[215,119,87]`, snowflake `[173,216,230]` plus white snow, matrix `[80,250,123]`, sunset body `[255,138,101]` with faceBg `[40,16,28]`. The info text beside it is plain `DIM` (`bin/clawd.mjs:362-374`: model, `NN% ctx`, cost, branch, `+a/-r`). No per-segment colour.
2. Themes = "skins" (23 bundled); format is per-skin RGB triples, not semantic roles. Users: `set <skin>` (persisted in `~/.clawd-skin`), `random`, `edit` pixel editor (dev only), and `generate "<vibe>"` which asks Claude (SDK + `ANTHROPIC_API_KEY`) to invent a skin; `clampRgb` validates (`clawd.mjs:604`).
3. Truecolor only (`38;2;r;g;b`, `48;2;...` at `clawd.mjs:47-48`); no depth detection or NO_COLOR found.
4. Both: mascot body is foreground half-block glyphs over a `faceBg` background fill (`:142-163`).
5. Separators: not present (info is padded text).
6. Not applicable; one mascot plus dim text.
7. Not present, except per-skin `faceBg` and an Apple_Terminal solid variant (README).
8. Half-block Unicode art (`▐▛███▜▌`); optional snow decorations.
9. Skin carousel in `list`, startup-banner patch scripts (`tools/patch-claude-banner.ps1`), pixel-faithful PNG/SVG renders in `art/`.
10. CLI modes `banner|statusline|list|get|set|reset|random|generate|check|edit|install-statusline`; `skins.json`; `~/.clawd-skin`; `COLUMNS` env respected when composed with claude-hud.

## sohee-zoe/claude-statusline
https://github.com/sohee-zoe/claude-statusline — stars 0
1. By state only. `variants/full.sh:138-143` `color_for_remaining`: remaining >=50 bright green `92`, >=20 orange `38;5;208`, else red `31`; applied to the context bar and the 5h/7d usage bars (`bar_for_percent` `:171`). Model, directory and branch are uncoloured. Separator is dim.
2. Themes: not present.
3. ANSI 16 + one 256 colour; no detection or NO_COLOR.
4. Foreground only.
5. Plain text `   |   ` (wide) / ` | ` (tight), dimmed (`compact.sh:31-32`).
6. Separator only; neighbours are not otherwise differentiated.
7. Not present.
8. `[██░░░]`-style 10-cell bars using `░`, emoji ⏳/⌛️ for rate-limit rows; `STATUSLINE_CJK_AMBIGUOUS=1` counts block glyphs as 2 cells. No Nerd Font.
9. Two variants (`full`, `compact`) with width-adaptive one/two-line wrapping.
10. Env overrides only: `STATUSLINE_COLUMNS`, `STATUSLINE_PADDING`, `STATUSLINE_LINES`, `STATUSLINE_DIR_STYLE`, `STATUSLINE_CJK_AMBIGUOUS` (`compact.sh` header). Colours edited in the script.

## sonmibz/claude-monitor
https://github.com/sonmibz/claude-monitor — stars 0
Mostly not a statusline: a blessed TUI dashboard (`src/index.ts`). The only statusline piece is `scripts/statusline-rate-limits.sh`, which writes JSON for the dashboard and prints an uncoloured `[Model] | 5h: N% 7d: N% ctx: N%` (`:56-66`).
1. Statusline: no colour at all. Dashboard: panel borders fixed green, rate panel yellow (`index.ts:119-248`); agents table maps an agent's declared colour name to ANSI (`COLOR_MAP` `:357-366`: red..cyan, pink=magenta, orange=`38;5;208`).
2. Themes: not present.
3. ANSI 16 + one 256; blessed handles terminal depth. No NO_COLOR.
4. Foreground / border colours; no fills.
5. Statusline separator: plain ` | `.
6. N/A for the statusline.
7. Not present.
8. ASCII gauges `[####....]` (`src/ui/gauge-bar.ts`), sparkline and spinner in the TUI.
9. Animation in the TUI (spinner, sparkline).
10. No styling configuration.

## sonusrujan/lull
https://github.com/sonusrujan/lull — stars 0
not a Claude statusline in the styling sense: an ad/sponsor-line tool that writes a spinner line and a status line. Styling is two strings in `client/src/render-core.mjs`: sponsor line plain text `▸ Sponsored · <text> · getlull.dev` as an OSC 8 link (`:27`), and earnings line fully dim `\x1b[2m⚡ Lull · ... \x1b[0m` (`:48`). One attribute (dim), no colours, themes, depth handling or config for styling.

## soy-rafa/claude-barra-campeones26
https://github.com/soy-rafa/claude-barra-campeones26 — stars 0
1. Mixed. Base `barra.sh`: context bar is a continuous truecolor gradient per cell green to yellow to red (`:96-118`, `r=pos*255/50` then `g` falls), unfilled cells grey `60,60,60`; rate-limit percentages by threshold (`color_pct` `:132-138`: >85 bold red, >60 bold yellow, else bold green); a pulsing "live" dot cycles four greens (`:126-129`); fixed SNTL badge green/red. Folder, model, tokens and duration are uncoloured, separated by `│`. The `campeones26` theme (`themes/campeones26.sh`) recolours in Spain's flag colours: red `170,21,27`, gold `241,191,0`, green `46,125,50` (`:44-47`), with the bar gradient running grass green to gold to red (`:310-326`).
2. Themes: pluggable shell files. Bundled: `campeones26`, `campeones26_hook` (themes dir). A theme is a `.sh` defining `barra_theme_render`, which reuses variables the base script computed (`barra.sh:171-185`). Active theme via `BARRA_THEME` or first line of `~/.claude/barra_theme`; users can add `~/.claude/barra_themes/<name>.sh`. Format is code, not data.
3. Truecolor when `COLORTERM` is `truecolor`/`24bit`, else 256-index fallback (`campeones26.sh:41-55`, flat three-zone bar at `:294-306`). Base `barra.sh` is truecolor-only. No NO_COLOR.
4. Both: foreground gradient blocks `█`; theme adds background fills (`C26_FONDO_ROJO` 48;2, goal banner `:591`).
5. Separators: plain `│` and spacing.
6. Distinct emoji per segment plus the `│` separator; colour only on bar, rate limits and badges.
7. Not present.
8. Emoji (📁 🤖 🔢 ⏱ 📊 🛡), `█` bars; no Nerd Font or ASCII mode.
9. Animation: a 1 Hz-clocked shimmer block travelling along the bar (`anim_frame = seconds % 13`, `barra.sh:5-6,106-118`), pulsing dot, themed goal-celebration banner and a news ticker with OSC 8 link (`campeones26.sh:633`), `demo_reel.sh`.
10. Env/config: `BARRA_THEME`, `~/.claude/barra_theme`, `BARRA_NO_USAGE_CACHE`; otherwise edit the shell.

## spboxer3/progress-hud
https://github.com/spboxer3/progress-hud — stars 0
not a Claude statusline: a to-do progress panel (Ink, `hooks/register.tsx`) for Claude Code and Codex. Styling is Ink props, no hex: done=green dim, doing=cyan bold, bad=red, gone=dim strikethrough, warnings yellow, tag cyan dim, progress bar green (`register.tsx:90-96,178-196`). No themes, depth handling or colour config.

## spuentesp/minimax-status-en
https://github.com/spuentesp/minimax-status-en — stars 0 — FORK OF JochenYang/minimax-status. Only differences, read from `cli/renderer.js` and `cli/statusbar.js` of both repos. The parent's current HEAD has moved on; the fork is an older snapshot.
1. Fork's block colours are fixed hex backgrounds with white text (`renderer.js:99-130`): dir `#2563EB`, branch `#9333EA`, model `#4C1D95`, context `#0369A1`, 5h quota `#065F46` safe / `#9A3412` warn / `#991B1B` danger, time-remaining `#92400E`, expiry `#374151` going orange at <=7 days and red at <=3. Difference from parent: the fork judges quota by USED percent (>=75 warn, >=95 danger, `renderer.js:106-109`); parent colours by REMAINING percent (<60 orange, <30 red) and always shows a `5h` prefix and a block even when total=0. The plain statusbar uses chalk red/yellow/green at used >=85/>=60 (`statusbar.js:17-21`) with `✓ ⚡ ⚠` icons; parent flips that to remaining (<30/<60).
2. Themes: not present in either.
3. Truecolor hex via chalk (`bgHex`), chalk auto-downsamples and honours `FORCE_COLOR`/`NO_COLOR` through supports-color (not read directly in this code).
4. Background-filled powerline blocks.
5. Powerline arrow U+E0B0 between blocks, arrow fg = block bg and arrow bg = next block bg (`renderer.js:143-152`); first block gets an opening arrow; last arrow fg only. `>` fallback when `MINIMAX_PLAIN_UI` or `NO_NERD_FONTS` is set.
6. Different hue per block plus arrows.
7. Fixed white text on dark-800-level backgrounds; no adaptation.
8. Nerd Font (U+E0B0, U+E0A0 branch) with ASCII fallback via the two env vars above.
9. Not notable.
10. Env: `MINIMAX_PLAIN_UI`, `NO_NERD_FONTS`; no colour config. This fork has translated English text; renderer is otherwise the parent's.

## srikanth-11/leakhound
https://github.com/srikanth-11/leakhound — stars 0
Mostly not a statusline: a token-waste audit plugin; the statusline is `scripts/statusline.js` (optional `/leakhound:live`).
1. By state only: the badge `🐕 ctx 839k↑ compaction near · +715 out` is green by default, yellow at `ctx >= yellow`, red with "compaction near" at `>= red` (`statusline.js:65-71`); defaults 500k / 800k tokens (`:15`). The `· +N out` part is uncoloured.
2. Themes: not present.
3. ANSI 16 only; no detection or NO_COLOR.
4. Foreground only.
5. One segment; ` · ` plain text.
6. N/A.
7. Not present.
8. Emoji 🐕 and arrows ↑ ↓ →.
9. Not notable.
10. `~/.claude/leakhound.json` `{"live": {"yellow": N, "red": N}}` thresholds only.

## ssajaia/claude-budget-hud
https://github.com/Ssajaia/claude-budget-hud — stars 0
not a Claude statusline: a floating PyQt desktop overlay showing Anthropic API budget. Has a dark/light mode (`ui/hud_window.py:59,177-204`: `#1E1E1E` or `#F7F6F3` panel, `#E5E7EB`/`#111827` text, accent `#F59E0B`/`#D97706`, error `#EF4444`) set by a `dark_mode` config key; irrelevant to terminal styling.

## ssenu/token-per-prompt
https://github.com/ssenu/token-per-prompt — stars 0
Adds a per-prompt token line beneath another statusline (it can chain an existing statusline command via `chain_command`, `scripts/statusline.py:55-66`).
1. By role within one theme. `scripts/report.py:44-53` `THEMES["tokyonight"]` has five roles: `label` blue `#7aa2f7`, `accent` green `#9ece6a`, `num` fg `#c0caf5`, `pct` yellow `#e0af68`, `muted` comment grey `#565f89`, plus dim and reset. `format_line` (`:214-`) paints labels (output, new context) with `label`, numbers with `num`, cache read with `muted`, `·` and `|` separators dim, percentage `pct`. No threshold colouring seen.
2. Themes: `tokyonight` and `default`; `default` means no colour at all (`_painter` returns identity, `report.py:57-62`). Role map format; users choose via `theme` in config.json (README `:106`); defining new themes means editing `THEMES`.
3. Truecolor only; no depth detection or NO_COLOR.
4. Foreground only.
5. Plain dim ` · ` and `|`.
6. Roles by function (label vs number vs muted), not by position.
7. Not present (`default` is colourless for any terminal).
8. Emoji indicator 🔄 climbing / ✅ finalised; Korean labels.
9. Not notable.
10. `config.json` in a per-user data dir with `theme`, `chain_command`; `/token-setup` command.

## ssilverstar/hh-claude-kit
https://github.com/Ssilverstar/hh-claude-kit — stars 0
The "editorial" and "tech" theme names the scanner saw are CSS for a web-slides skill in the same kit, unrelated to the statusline. Statusline = `statusline/statusline.sh`.
1. Fixed per segment plus thresholds. `statusline.sh:19-26`: user bold blue, dir bold cyan, git branch bold magenta, model yellow, CC version grey 244, usage 189, cost 222, burn 220. Thresholds: context remaining <=20 coral 203, <=40 peach 215, else mint 158 (`:28-33`); session time remaining <=10 light pink 210, <=25 light yellow 228, else light green 194 (`:36-41`).
2. Themes: not present.
3. ANSI 16 + 256 index; honours `NO_COLOR` (`:13-14`, every colour function is a no-op when unset). No depth detection.
4. Foreground only.
5. Separator is dim grey `\033[0;90m | ` (`:18`); plain text.
6. Different hue per segment plus emoji prefix (📁 🌿 🤖 📟 🧠 ⌛ 💰 📊).
7. Not present.
8. Emoji; `█`/`░`-style bars for context and session (`ctx_bar`, `session_bar`). No Nerd Font or ASCII mode.
9. Multi-line (up to three lines).
10. None; edit the script.

## st0nefish/claude-statusline
https://github.com/St0nefish/claude-statusline — stars 0
1. Role-to-colour map, themable by config. `statusline.sh:19-31` `DEFAULT_COLORS` (256-index numbers): `low=76` green, `mid=178` gold, `high=196` red, `separator=dim`, `git_branch_feature=76`, `git_branch_primary=178` (warns when on the primary branch), `git_staged=178`, `git_unstaged=196`, `git_untracked=39`, `git_ahead=76`, `git_behind=196`, `user=3`, `user_root=196`, `dir=31`, `cost=76`, with `label`, `model`, `host`, `reset_time` = terminal default. Threshold segments (context, session, weekly, extra) use `usage_c` (>=80 high, >=50 mid, else low, `:73-83`); cost uses `cost_c` with two configurable thresholds.
2. Themes: not present as named themes, but every role is overridable via `colors` in config.
3. 256-index (`38;5;N`), or keywords `default`, `dim`, `bold`, `reset` (`c()`, `:56-69`). No detection or NO_COLOR.
4. Foreground only.
5. Plain configurable separator, default ` | ` in `separator` colour (default dim, `:728`).
6. Per-segment colour from the role map; separator only otherwise.
7. Not present; `default` (SGR 39) keeps the terminal's own text colour for labels and model.
8. Short vs long labels (`label_style`, `Ctx`/`Context`); no icons noted.
9. Not notable.
10. JSON config at `${XDG_CONFIG_HOME:-~/.config}/claude-statusline/config.json`: `segments` order list (default user dir git model context session weekly extra cost), `separator`, `colors{}`, `label_style`, cache TTLs, `currency`, cost thresholds.

## starbased-co/ccstatusline
https://github.com/starbased-co/ccstatusline — stars 0 — FORK OF sirmalloc/ccstatusline. Differences only, from a file-by-file comparison with the parent's current HEAD plus its two sibling forks.
1. Same as parent (each widget has a `getDefaultColor()`; in powerline mode a theme assigns fg/bg to widgets by index modulo the theme's colour list, `renderer.ts:182-193`, merged widgets share an index). The fork is a snapshot of an older parent: it lacks the parent's `continueThemeAcrossLines` option (`PowerlineConfig.ts`), its gradient colour support (`colorLevel !== 'ansi16'` gradient branch in the parent's `colors.ts` applyColors), and the parent's shared context-percentage helper (the fork hardcodes a 200,000-token window, `renderer.ts:104-105`).
2. One extra theme: `srcery` (absent in parent HEAD), defined at each of three colour levels (`colors.ts:432-`: 16-colour names, 256 indices like `202,149,32,161,37`, hex `FF5F00 98BC37 2C78BF E02C6D 0AAEB3`, dark `1C1B19` text). Total 11 entries: custom, nord, nord-aurora, monokai, solarized, minimal, dracula, catppuccin, gruvbox, onedark, tokyonight, srcery. Each theme is parallel `fg[]`/`bg[]` arrays cycled by widget position. Users can copy a theme into `custom`.
3. Same as parent: three levels (16, 256, truecolor via `ansi256:N` / `hex:RRGGBB` prefixes), chosen by a `colorLevel` setting driving chalk (`colors.ts:85-125`).
4. Powerline mode: backgrounds with text; normal mode foreground (optional `bg`).
5. Same as parent: configurable powerline separators/caps (default U+E0B0); separator fg = previous widget bg, bg = next widget bg, with inversion and same-background cases (`renderer.ts:335-400`).
6. Theme colours cycle by widget index, so neighbours differ; same-background neighbours switch the separator to the widget's fg.
7. Same as parent.
8. Same as parent (powerline needs a powerline font; installer for fonts in `powerline.ts`).
9. Same as parent TUI (Ink) configurator with theme selector.
10. Same as parent. Env and TUI: no extra surface seen.

## stellin-15/burnrate
https://github.com/Stellin-15/burnrate — stars 0
1. By threshold, otherwise dim. `packages/cli/src/render.ts:49-53` `levelColor(pct)`: >= `danger` red, >= `warn` yellow, else green; applied to the 5h bar and %, spend %, and context % (`:78,100,110`). Defaults warn 60, danger 85 (docs/configuration.md `:50`). Model is bold (a `⚡` in magenta for fast mode); labels (`5h`, `7d`, `ctx`, reset countdown) are dim; "limit in ..." warnings red.
2. Three "themes" that are modes, not palettes: `default` (colour + bars), `minimal` (colour, no bars), `plain` (no colour, ASCII) (`docs/configuration.md:23-25`; `render.ts:66-68`). No user-defined palette.
3. ANSI 16 only (`ansi.ts`: green 32, yellow 33, red 31, cyan 36, magenta 35, dim 2, bold 1). `NO_COLOR` honoured (`commands/statusline.ts:150`, `ansi.ts` `colorEnabled`, FORCE_COLOR too). The statusline forces colour on unless NO_COLOR since stdout is not a TTY.
4. Foreground only.
5. Plain ` │ ` dim (` | ` in plain theme).
6. Separator only; hue means state, not identity.
7. Not present beyond using the terminal's own 16 colours.
8. `▰▱` bars (ASCII `[###---]` in plain), `↻`, `⚠`.
9. Estimated values prefixed `~`; widgets dropped from the end to fit `columns` (`render.ts:125-128`).
10. `~/.burnrate/config.json` (or `BURNRATE_CONFIG`): `theme`, `thresholds{warn,danger}`, `barWidth`, `widgets[]` order and choice, `currency`; `burnrate config init`.

## stelsoft/claude-code-statusline
https://github.com/stelsoft/claude-code-statusline — stars 0
1. By threshold, mostly uncoloured. `statusline.sh:34-41` `pct_text`: >=80 red, >=50 yellow, else default; context colour red at >=80%, yellow at >=150k tokens, else default (`:80`); cache timer green / yellow / red as TTL runs down (`:149-155`, "cache cold" red). The model/effort bracket and dir are uncoloured. Bar is grey `\033[90m`.
2. Themes: not present.
3. ANSI 16 only; no detection or NO_COLOR.
4. Foreground only.
5. Plain ` | `.
6. Separator only.
7. Not present.
8. `▓▒░` half-step bars (`make_bar` `:14-31`, half blocks double resolution of a 4-cell bar).
9. Writes a shared usage file for a companion limit-watch/herdr script; shows "(updated)" age.
10. Edit the script; no config surface.

## stevevitali/claude-readout
https://github.com/SteveVitali/claude-readout — stars 0 — Go. Strongest colour-system design in this batch.
1. By role, with state heat. `internal/theme/palette.go:21-45` `Palette` has exactly three saturated families: `Accent` (identity: the model name, bold, `segment/build.go:143`), `Location` (where you are: branch and the repo/path leaf, `:177-204`), and `Heat` (measurement: Good/Warn/Danger, each with a `Fill` for bars and a separate `Text` shade for digits). The rest are neutrals `Primary`, `Secondary` (cost, drift), `Muted` (badges, tokens, reset, path dirs), and `Track`. Header comment: "anything coloured is a number you may need to act on." Heat chosen by `HeatFor(pct, thresholds)` (`:96-104`), defaults warn 60, danger 85.
2. One palette bundled: `primer` (Light and Dark variants, `palette.go:48-70`, with GitHub-Primer-like values). The config names solarized, nord, gruvbox, mono but they are unshipped and "a config that asks for one is told so" (`:121-125`). Format is semantic roles; every value is contrast-checked: text >=4.5:1, fills >=3:1, track 1.6-1.9:1 (header). `theme palette` command inspects.
3. Truecolor RGB internally; `paint.Quantise` maps to 256 index (`cmd/theme.go:174`). Depth ladder in `internal/caps/depth.go`: NO_COLOR (highest), explicit `color_depth`, then `COLORTERM` truecolor/24bit, then `TERM`, `dumb` = none; `doctor` prints which rung answered.
4. Foreground only (the meter track is `▒` at ~50% coverage so the terminal background shows through, `palette.go:30-33`).
5. Plain `│` divider (Nerd tier uses U+E0B1), muted.
6. Hue is reserved for meaning, so neighbours differ by role colour vs neutral grey and by the divider; no alternation.
7. Yes, explicit: light vs dark palette selected by detected appearance. Ladder (`internal/caps/background.go`): cached OSC 11 background query (`theme probe` writes the cache because `render` has no tty), then `COLORFGBG`, then default dark; `[theme] appearance` pins it. Contrast verified per palette at design time rather than computed per frame.
8. Glyph tiers by measured font support: ascii (`# = - |`), unicode (`█ ▒ │ → ◆`), extended (eighth-blocks `▏..▉`), nerdfont (``, ``, ``) (`internal/segment/glyphs.go`); `[meter] style` shade / solid / rule / none.
9. Fractional-cell meters, jitter guard, `doctor` command, custom `[[segment]]` kinds incl. command-backed (`segment/custom.go`).
10. TOML config (`cmd/claude-readout/config.go`): `[theme] palette, appearance`, `[meter] warn_at, danger_at, style`, `color_depth`, `glyphs`, `[[segment]]`; flags `--appearance`; `NO_COLOR`.

## stw-sp/claude-token-tracker
https://github.com/stw-SP/claude-token-tracker — stars 0
Only `install.sh` is read; it embeds a Node statusline.
1. By threshold: weekly tokens `<50 green, <75 yellow, <90 orange 208, else red` (`install.sh:403-407`); context bar `<50 green, <65 yellow, <80 orange, else blinking red 5;31` (`:473-481`, usable-context calc subtracts a 16.5% auto-compact buffer). Separators and reset label dim; installer messages use red/green/yellow/dim.
2. Themes: not present.
3. ANSI 16 + 256 (208); no detection or NO_COLOR.
4. Foreground only.
5. Dim plain ` | `.
6. Separator only.
7. Not present.
8. `█`/`░` 10-cell bar. No Nerd Font.
9. Blinking red at the top context band.
10. None (installer writes the script).

## subaru486desuwa/mochiapi-statusline
https://github.com/Subaru486desuwa/mochiapi-statusline — stars 0 (README: statusline for MochiAPI users showing model, context, balance, daily spend; code is a derivative of sirmalloc/ccstatusline's file layout, not marked as a GitHub fork). Compared with the parent and with the other ccstatusline forks.
1. Same mechanism as ccstatusline: widget default colours, powerline themes assigned by widget index modulo (`renderer.ts`, shared with the other forks).
2. Ten themes (custom, nord, nord-aurora, monokai, solarized, minimal, dracula, catppuccin, gruvbox, onedark; no tokyonight/srcery here despite the scanner's name list) with 16 / 256 / hex arrays per theme (`colors.ts:272-`). Parent today has the same set plus tokyonight. Users edit `custom`.
3. ansi16 / ansi256 / truecolor (`ansi256:N`, `hex:RRGGBB`), `colorLevel` setting. Difference from parent and the other forks: `applyColors` here emits raw SGR with explicit resets (`\x1b[22m`, `\x1b[39m`, `\x1b[49m`, `colors.ts:135-165`) instead of nesting chalk, to avoid bold/colour leaking into later widgets. `src/utils/color-sanitize.ts` resets a widget's custom colour to its default when the colour level changes to one that cannot show it (hex at 256, ansi256 at truecolor, any custom at 16).
4-5. Same as parent: background blocks in powerline mode; separators/caps from `PowerlineConfig` including `continueThemeAcrossLines` (present here, absent in the starbased and Suraj forks) and `separatorInvertBackground`.
6-8. Same as parent. No gradient support found in the fork's `colors.ts`.
9. MochiAPI-specific widgets (balance, daily spend); powerline font installer (temp dir renamed `mochiapi-statusline-powerline-fonts-*`).
10. `mochiapi-statusline --mochiapi-setup` interactive setup; Ink TUI configurator inherited.

## sullivanxiong/tmux-claude-status
https://github.com/SullivanXiong/tmux-claude-status — stars 0
not a Claude statusline: a tmux plugin that marks tmux window tabs with Claude state via hooks (README says it moved off the `statusLine` API). Styling per README `### Colors`: active tab white bold, working inactive tab yellow `...`, ready inactive tab green `✔`. Colours live in tmux format strings; not verified in the three scripts read (README only).

## sungurerdim/statusline
https://github.com/sungurerdim/statusline — stars 0 (Rust)
1. By theme role, in a fixed palette. `src/theme.rs:56-62` `Palette` roles (Catppuccin Mocha hexes with ANSI-16 fallbacks): GREEN `a6e3a1` (branch, additions), MAUVE `cba6f7` (model), SKY `89dceb` (context, accent), YELLOW `f9e2af` (modified, cost), PEACH `fab387` (burn rate, warning), RED `f38ba8` (danger, deletions), GRAY `6c7086` (dim, separators). Rate and context percentages by threshold, `pct_color` (`render.rs:167-175`): >=90 red, >=70 yellow, else sky. Model is mauve (`render.rs:255`), cost yellow, burn peach (`:322-338`), file counts green/yellow/red or gray when zero (`:309-316`).
2. One bundled palette (Catppuccin Mocha, hardcoded constants); not user-definable. The `catppuccin` name seen by the scanner is this.
3. Truecolor / 256 / 16 / none, auto-detected (`theme.rs:96-130`): `FORCE_COLOR` first (0 = off), then `NO_COLOR` (non-empty), `TERM=dumb`, then `COLORTERM` truecolor/24bit, `TERM` containing 256, else 16. `rgb_to_256` maps hex to the 6x6x6 cube or grey ramp (`:77-92`); 16-colour uses a per-role bright ANSI code. Config key `color = auto|truecolor|256|16|off` overrides.
4. Foreground only.
5. Plain glyph separator (`|` ASCII or a Unicode one per glyph mode), coloured GRAY (`render.rs:369,421`).
6. Role colours plus a gray separator; no alternation.
7. Not present (single dark palette).
8. Three glyph modes: `ascii`, `unicode` (default, △ ⌥ ◉ ◔ ✓ ↻ 🔥-style universal symbols), `nerd` (opt in); auto-downgrades to ASCII on non-UTF-8 or dumb terminals (`theme.rs:115-200`, `statusline.example.toml:20-27`). Env `STATUSLINE_GLYPHS`.
9. Two layouts, `multi` (aligned two-row block, default) and `single` (`STATUSLINE_LAYOUT`).
10. TOML config (`statusline.example.toml`; a typo like `color = "trucolor"` is reported, a broken config falls back to defaults with a stderr warning); env `NO_COLOR`, `FORCE_COLOR`, `STATUSLINE_LAYOUT`, `STATUSLINE_GLYPHS`; segment toggles such as `context = true`.

## surajkuswawer/ccstatusline
https://github.com/SurajKuswawer/ccstatusline — stars 0 — FORK OF sirmalloc/ccstatusline. Differences only.
1. Same widget-default-colour and powerline-theme mechanism as the parent. The fork is an older parent snapshot. The only code differences found against the starbased-co fork: it has no `srcery` theme, and `renderer.ts` computes context percentage through an imported `calculateContextPercentage(context)` (`renderer.ts:20,105,683`) instead of a hardcoded 200,000-token window.
2. Ten themes (no `srcery`): custom, nord, nord-aurora, monokai, solarized, minimal, dracula, catppuccin, gruvbox, onedark, tokyonight (`colors.ts`; parallel `fg[]`/`bg[]` arrays at 16, 256 and hex levels). Parent HEAD has these ten plus further changes. Users edit `custom`.
3. Same as parent snapshot: 16 / 256 / truecolor (`ansi256:N`, `hex:RRGGBB`) by `colorLevel` setting; lacks the parent's gradient support.
4-10. Same as the parent snapshot, including lacking `continueThemeAcrossLines` in `PowerlineConfig.ts`. `powerline.ts`, `PowerlineThemeSelector.tsx` identical to the starbased-co fork.

## @ed1sonl1/token-flame
https://www.npmjs.com/package/@ed1sonl1/token-flame (v1.2.2, stars n/a). Single-line cost tracker (session / today / week / total), read from the npm tarball `src/statusline.js`.
1. Colour: by role of segment, fixed. `[model]` is always gray `\x1b[0;90m` (`statusline.js:574`); session, today and week cost cells all wear the one "active" theme colour (`:577-585`); the total cell is gray `theme.total`. No thresholds, no position logic.
2. Themes: 4 bundled, `THEMES` at `statusline.js:44-49`: fire (red 31), ocean (cyan 36), forest (green 32), golden (yellow 33). Each is `{active, total}`, two colours only. Selected by `theme` in `~/.claude/token-flame-config.json` (`:15,78`). Users cannot define new themes (unknown name falls back to fire, `:116`).
3. Spec/depth: ANSI 16 (`\x1b[3Xm`, `9Xm`) plus two 256-index colours (`orange 38;5;208`, `fire 38;5;196`, `:38-39`, defined in `C` but the active theme path uses 16-colour). No depth detection, no NO_COLOR.
4. Fill: foreground-only.
5. Separators: plain ` | ` text, uncoloured (`:579,588`).
6. Neighbours: only the plain `|` separator and the model-gray vs themed-cost contrast.
7. Light/dark: not present.
8. Glyphs: emoji (fire, per README/`:577`), Chinese labels (会话/今日/本周/总计). No ASCII mode.
9. Other: nothing special; `show_burn_rate` appends a fire emoji plus rate.
10. Customisation: JSON config `~/.claude/token-flame-config.json` keys `theme`, `show_burn_rate`, `show_total`, `show_week` (`:61-66`). No flags/env.

## @eximia-ventures/claude-code-toolkit
https://www.npmjs.com/package/@eximia-ventures/claude-code-toolkit (v5.3.0, stars n/a). An installer toolkit; styling lives in the shipped bash script `assets/statusline/statusline.sh`.
1. Colour: mostly uncoloured text with emoji labels; colour by state/threshold plus one by-model dot. Model dot `●` colour by model name (`statusline.sh:162-168`: Opus 4.6 magenta, Sonnet 4.5 blue, Haiku 4.5 cyan, other green); model name always bold blue. Context bar and % use the same threshold: >80 red, >60 yellow, else green (`:83-86`, `:189-191`). Git branch always magenta (`:176`). Date, tokens, message count, cost and duration are uncoloured.
2. Themes: not present. Colours are hard-coded constants (`:27-36`).
3. Spec/depth: ANSI 16 only (`\033[31m`..`37m`). No detection, no NO_COLOR.
4. Fill: foreground-only.
5. Separators: plain ` | ` between parts (`:211-215`), uncoloured.
6. Neighbours: ` | ` separator and emoji prefixes only.
7. Light/dark: not present.
8. Glyphs: emoji prefixes (📅 📊 ⚡ 💰 ⏱ 🔀), block bar `█░`, `●` dot. No fallback.
9. Other: currency env `CLAUDE_TOOLKIT_CURRENCY` / `_RATE` (`:38-39`). Bar is 10 cells (`progress_bar`, `:76-95`).
10. Customisation: edit the script; the two currency env vars. No config file.

## @gabrihhh/jarvis
https://www.npmjs.com/package/@gabrihhh/jarvis (v3.5.0, stars n/a). Statusline is two boxed "pills" drawn with box-drawing characters (`src/statusline.js`); the rest of the package is a Kanban/dashboard app.
1. Colour: fixed per box, user-recolourable. Each box has one hex colour for its whole outline and text: `context` default `#22d3ee`, `tokens` default `#ef4444` (`src/theme.js:7-10`). The box borders and text are painted with `chalk.hex(color).bold` (`statusline.js:46-48`). The context bar is not threshold-coloured in the statusline (the dashboard `display.js:32` does use red >=85, yellow >=60, else `#00e5ff`).
2. Themes: no named themes; a two-key colour map stored at `~/.claude/jarvis-theme.json` (`theme.js:5`). Users set a key with `jarvis --theme context:#hex` or `reset` (`bin/jarvis.js:29-32`); hex validated (3 or 6 digits, `theme.js:isValidHex`).
3. Spec/depth: truecolor hex only. `new Chalk({ level: 3 })` forces truecolor regardless of terminal (`statusline.js:8`). No NO_COLOR, no downsampling.
4. Fill: foreground-only; boxes are outline glyphs `╭─╮ │ ╰─╯`, no background.
5. Separators: none between boxes; the boxes are joined side by side (`joinBoxes`, `:32-36`), each with its own rounded outline.
6. Neighbours: two boxes in two different hues (cyan vs red) with rounded borders.
7. Light/dark: not present.
8. Glyphs: box-drawing, `█░` bar, `◈` token marker. No ASCII mode.
9. Other: an optional second line in "complete" token mode where INPUT / HISTORY / CACHE / RESPONSE are all painted the tokens colour with `│` separators (`:62-70`).
10. Customisation: `jarvis --theme` CLI, `~/.claude/jarvis-theme.json`, `config.tokenDisplay` (off / simple / complete) in `src/config.js`.

## @sooneocean/claude-hud
https://www.npmjs.com/package/@sooneocean/claude-hud (v1.0.0, stars n/a). A claude-hud-lineage multi-line HUD (TypeScript); not flagged as a fork by the batch, so reported in full.
1. Colour: mixed. By threshold: context bar/percent via `getContextColor` (`src/render/colors.ts`: >=85 critical/red, >=70 warning/yellow, else `colors.context` green); quota bar via `getQuotaColor` (>=90 critical, >=75 `usageWarning` bright magenta, else `usage` bright blue). Fixed per segment elsewhere: model `[name]` cyan, git `git:(` `)` magenta with branch cyan (`lines/project.ts:32,75`), agent type magenta, custom line `claudeOrange` (256 index 208), everything else `dim`. Heatmap sparkline `▁..█` is coloured per sample by value: 34/70/226 below 50, 226/208 to 80, 208/196 above (`lines/identity.ts:10-35`).
2. Themes: 6 bundled, `src/themes.ts`: default, catppuccin (Mocha), dracula, nord, catppuccin_latte, nord_light. Each theme is a semantic map of 5 roles `{context, usage, warning, usageWarning, critical}` (hex or ANSI names). `config.theme` selects one, then user colour overrides win (`config.ts:417-430`). Users can override any of the 5 roles individually; cannot add named themes.
3. Spec/depth: three forms accepted per colour (`resolveAnsi`, `colors.ts`): named ANSI preset, 0-255 index (`38;5;n`), or `#rrggbb` truecolor (`38;2;r;g;b`). No depth detection, no NO_COLOR.
4. Fill: foreground-only.
5. Separators: plain dim ` | ` or dim `│` (`identity.ts:88,102`, `alert-line.ts:18`).
6. Neighbours: dim separators only; segments differ by the fixed hue per kind.
7. Light/dark: `detectTerminalTheme()` reads `COLORFGBG` (`themes.ts:79-90`) but is exported and never called (only `dist/themes.js` re-defines it; no caller in `src`). Light variants exist (`catppuccin_latte`, `nord_light`) but are selected manually. No text-contrast calculation.
8. Glyphs: emoji and unicode (`⏱️`, `⚑`, `↓→`), bar styles `classic █░` or `modern ▰▱` (`BAR_CHARS`). No Nerd Font.
9. Other: sparkline heatmap with 8-step glyph ramp; `commands/theme.md` slash command to switch theme with a picker; `auto-tune.ts` for thresholds.
10. Customisation: `~/.claude/plugins/claude-hud/config.json` (`theme`, `colors`, `barStyle`, thresholds); `/theme` slash command.

## @wyouwd1/cc-hud
https://www.npmjs.com/package/@wyouwd1/cc-hud (v0.7.3, stars n/a). Compact one-line HUD with Chinese-provider quota support; styling is all in `src/render.ts` (193 lines).
1. Colour: by threshold for percent bars/numbers (`color()`: <=50 green, <=70 yellow, <=85 peach, else red, `render.ts:80-85`); by countdown bucket for reset timers (`countdownColor`: >=24h sapphire, >=3h lavender, >=0.5h flamingo, else maroon, `:107-112`); fixed per role elsewhere: model name `blue`, agent glyph `◐` and "extra" text `teal`, separators/labels `overlay`, bar track `surface`.
2. Themes: 3 bundled, `THEMES` (`:22-69`): catppuccin (default), dracula, nord. Format is a 13-role semantic palette (`Palette` interface, `:7-20`: green ok, yellow caution, peach warning, red critical, teal agent accent, blue model, sapphire/lavender/flamingo/maroon countdown, overlay dim, surface track, text). Chosen with env `CC_HUD_THEME`. No user-defined themes.
3. Spec/depth: 256-colour indices only (`fg(n)` = `38;5;n`, `:5`); each index has the target hex in a comment, i.e. truecolor palettes quantised by hand. No depth detection, no NO_COLOR.
4. Fill: foreground-only; the bar track is drawn with `░` in the `surface` colour rather than a background.
5. Separators: plain `│` in `overlay` colour (`SEP`, `:77`).
6. Neighbours: separators only.
7. Light/dark: not present (no light theme).
8. Glyphs: eighth-block fractional bar `▏▎▍▌▋▊▉█` with `░` track (`BLOCKS`, `:73-74`), `◐`, Chinese labels. No ASCII fallback.
9. Other: `—%` dim em-dash when context usage is not yet populated (`:92`); `CC_HUD_COMPACT=1` shows only model plus bar.
10. Customisation: env vars `CC_HUD_THEME`, `CC_HUD_COMPACT`, `CC_HUD_EXTRA_FILE`, provider keys. No colour config file.

## claude-contextline
https://www.npmjs.com/package/claude-contextline (v2.5.0, stars n/a). Two-line statusline whose colours follow the herdr terminal-multiplexer theme; whole logic in `dist/index.js`.
1. Colour: by theme role, fixed per segment. 4 roles: `blue` for context bar, percentage and directory; `red` for model name; `mauve` for git branch; `overlay0` for the empty bar and email (`index.js` renderer). No thresholds at all, so the bar does not change colour with usage.
2. Themes: 18 palettes keyed by name (`PALETTES`): catppuccin, catppuccin-latte, terminal, tokyo-night, tokyo-night-day, dracula, nord, gruvbox, gruvbox-light, one-dark, one-light, solarized, solarized-light, kanagawa, kanagawa-lotus, rose-pine, rose-pine-dawn, vesper, plus aliases. Format: 4 semantic tokens `{blue, red, mauve, overlay0}`. The active theme is read each render from the herdr TOML (`~/.config/herdr/config.toml`, `[theme] name`), with `[theme.custom]` per-token overrides (`loadHerdrTheme`); falls back to catppuccin.
3. Spec/depth: truecolor `38;2;r;g;b` or ANSI codes (the `terminal` palette uses 34/91/37; `parseColor` accepts hex, `rgb()`, and 19 named ANSI colours). `reset`/`default`/`none` emit `39`. No depth detection, no NO_COLOR.
4. Fill: foreground-only.
5. Separators: none; layout is two aligned lines with column padding (`modelCol`), not separators.
6. Neighbours: different hues per role, plus line layout.
7. Light/dark: light variants exist per family (latte, tokyo-night-day, gruvbox-light, one-light, solarized-light, kanagawa-lotus, rose-pine-dawn) and are picked by whichever theme herdr is on, so adaptation is by theme name, not by detection of the terminal.
8. Glyphs: `█░` bar in `[...]`. No icons.
9. Other: palette follows another tool's live theme; email of signed-in account from `~/.claude.json`.
10. Customisation: no own config; herdr's `config.toml` (`HERDR_CONFIG_PATH` env override) and `[theme.custom]` keys.

## claude-minigame
https://www.npmjs.com/package/claude-minigame (v0.1.0, stars n/a). Not a styled statusline: a terminal dino-style game ("Clawd Runner") whose only statusline contribution is a clickable crab.
1. Colour: statusline helper `tools/statusline-basic.js` writes model and dir uncoloured; the crab `▐▛▜▌` is fixed Clawd orange `38;2;217;119;87` followed by dim " play" (`statusline-basic.js:13-15`). The game itself uses a single-letter truecolor table (`src/ansi.js:7-25`: orange, cactus green, bug magenta, blue-violet runner, sun gold, dim stars).
2. Themes: not present (game has a day/night cycle, not user themes).
3. Spec/depth: truecolor `38;2;r;g;b` literals and a few ANSI 16; no detection, no NO_COLOR.
4. Fill: foreground-only.
5. Separators: plain ` | ` between model and dir.
6. Neighbours: not present.
7. Light/dark: not present.
8. Glyphs: block-element sprites (`▐▛▜▌`, `░▒`), OSC 8 hyperlink `clawd://play` makes the crab ctrl+clickable (`ansi.js` `link()`).
9. Other: OSC 8 click-to-launch; day/night cycle and parallax inside the game only.
10. Customisation: none for colour.

## masao-cc-status-line
https://www.npmjs.com/package/masao-cc-status-line (v1.0.2, stars n/a). Badge-style statusline with truecolor backgrounds; all in `bin/cli.js`.
1. Colour: mixed. Fixed per segment (static badges, `staticBadge`): model badge by model (`cli.js:166-171` Opus bg `80;20;40` fg `255;140;180`, Sonnet bg `70;30;10` fg `255;170;80`, Haiku bg `15;50;40` fg `120;230;180`, else grey), directory/branch badge olive bg `50;45;20`, cost badge indigo `40;40;60`/`25;25;40`, diff `↑` green `100;255;100` / `↓` red `255;100;100`, duration grey. By threshold (continuous gradient): the 5h and 7d badges and the `ctx` bar take a colour from `gradient(pct)` (green 0 to yellow 50 to red 100, `:14-20`) and `ctxGradient` (green to 50, green-yellow to 85, then toward red, `:22-28`).
2. Themes: two layouts selected by first CLI arg `argv[2]` (`THEME`, `:10`): default (coloured badges) and `simple`/`simple-1` (muted dark bar `renderSimple`, `:84-160`). `simple` palette: bg `28;28;34`, dim `85;85;100`, text `165;165;178`, status teal `110;185;165` / amber `195;175;105` / rose `195;115;115` (`:86-95`). Not user-extensible.
3. Spec/depth: truecolor only (`38;2`/`48;2`). No detection, no NO_COLOR.
4. Fill: both. Badges are background-filled cells; the gradient badges derive background by multiplying the foreground RGB by 0.3 (label) and 0.15 (value), the ctx bar by 0.5 filled / 0.12 empty (`:34-36,48-55`), so each badge's bg is a darkened version of its own fg.
5. Separators: none between badges in default (`S = ""`, "badge間スペーサーなし", `:9`), adjacent filled cells touch; simple theme uses dim `│` on the dark bg (`:98`).
6. Neighbours: different background hues per badge (olive, indigo, grey...) and the two-tone label/value split within one badge.
7. Light/dark: not present (dark-only backgrounds). Text colour is the badge's own bright fg, not computed.
8. Glyphs: emoji in badges (🔮 ✨ 🍃 📁 ⏱), `↑↓`. No ASCII mode.
9. Other: per-model colour set; effort tag `/l /m /h /mx` read from `~/.claude/settings.json`; gradient-derived backgrounds are the distinctive trick.
10. Customisation: one positional argument (`default` / `simple` / `simple-1`). No config file.

## power-viz
https://www.npmjs.com/package/power-viz (v0.2.0, stars n/a). Usage monitor with preset "themes" that are bar styles plus a 3-tier colour map.
1. Colour: by state/threshold. `colorFor(pct)` maps tier low/mid/high to a named colour; thresholds default `mid 50, high 80` (`lib/ansi.js` `DEFAULT_THRESHOLDS`, `tierFor`). Used for the context bar and percentage, and the 5h session and weekly bars (`statusline.js:72-79`). Labels (`sessão`, `semana`, `hoje`) and detail text are `dim`; model name bold. Otherwise uncoloured.
2. Themes: 8 presets in `lib/themes.js`: default (green/yellow/red, `█░`), mono (ASCII `#-`, all white), neon (cyan/magenta/brightRed, `▓░`), sunset (yellow/brightRed/magenta), ocean (cyan/blue/brightBlue), emoji (🟩🟨🟥⬜), hearts (💚💛❤️🤍), fire (🟢🔥🔥⬛). Format: `{barStyle, barChars|emojiChars, colors:{low,mid,high}}`. `power-viz theme set <name>` merges the preset into the user config; `--theme` applies for one run. Users can set `colors`, `thresholds`, `barChars`, `emojiChars` themselves in config.
3. Spec/depth: ANSI 16 names only (`COLOR_CODES`: black..white, gray, bright*). No 256/truecolor, no detection, no NO_COLOR.
4. Fill: foreground-only (emoji bars are glyph-coloured).
5. Separators: spaces and ` · ` / double space; uncoloured.
6. Neighbours: not distinguished beyond labels in dim vs values in tier colour.
7. Light/dark: not present, but `mono` theme with white and ASCII exists.
8. Glyphs: three bar modes: blocks, ASCII, emoji (explicit fallback ladder via `barStyle`). Portuguese labels.
9. Other: emoji bar styles as a "theme" axis; interactive setup picks a preset (`bin/cli.js:115-125`).
10. Customisation: JSON config (`lib/config.js`: `colors`, `thresholds`, `barStyle`, `barChars`, `emojiChars`, `showCost`), CLI `theme list|set`, `--theme`.

## pulse-dev
https://www.npmjs.com/package/pulse-dev (v0.1.1, stars n/a). A tamagotchi-style "creature" statusline (Python, `pulse/statusline.py`).
1. Colour: by state. The creature's face and its colour come from its mood: `MOODS` (`statusline.py:104-110`): happy blue, excited green, sleepy yellow, worried orange, proud purple, egg gray, hype cyan. Context bar by threshold: >=80 red, >=60 yellow, else green (`context_bar`, `:146-150`). Model bold, % and cost and duration `dim`, heart pink (`35`).
2. Themes: not present as a theme system; a `persona` config picks message sets (`PERSONAS`), not colours.
3. Spec/depth: ANSI 16 incl. bright variants (`C` dict `:20-23`, `\033[94m`, `92m` etc). No detection, no NO_COLOR.
4. Fill: foreground-only.
5. Separators: two spaces between parts (`"  ".join`, `:177,224`); no visible separator.
6. Neighbours: not distinguished except dim vs coloured.
7. Light/dark: not present.
8. Glyphs: ASCII-art kaomoji faces with 4 animation frames per mood (`(^.^)`, `(★o★)`), `█░` bar, 🔥 streak, heart.
9. Other: animation by frame cycling (`get_frame`) and mood from cross-session SQLite stats; level names.
10. Customisation: `~/.pulse/config.json` (`show_cost`, `show_duration`, `show_streak`, `show_level`, `show_message`, `persona`, `creature_name`).

## pulse-line
https://www.npmjs.com/package/pulse-line (v1.0.6, stars n/a). Plugin with 17 modules, 5 themes, themed per component (compiled JS in `dist/src`).
1. Colour: mixed. Most modules take their colour from a per-component field in the theme (`theme.components.<module>.fg`: model, git, rateLimit, weeklyQuota, accountUsage, toolTimeline, rules; used by `extractors/git.js:32`, `rate-limits.js:21,36`), while others use semantic theme roles directly in `dist/src/index.js`: context `colors.success` (`:40`), cost `warning` (`:69`), duration `muted` (`:77`), workspace `accent` (`:85`), turns `info` (`:92`), cache ratio `accent`, MCP `muted`, thinking `accent`, output style `muted`. In the dark theme the two coincide (e.g. context fg `#9ece6a` = success). No visible threshold colouring in the files read for context.
2. Themes: 5 bundled (`themes/builtin`): dark ("Deep Dark", Tokyo-Night palette), light ("Minimal Light"), cyberpunk, forest, ocean. Format (dark.js): `colors` = 9 semantic roles `{background, primary, accent, success, warning, error, info, muted, dim}` plus `components` = per-module `{fg, bold, icon, showIcon}` and a `separator {left, color}`. `theme <name>` switches (`/pulse-line:theme`). User-defined themes: config validator only requires `theme` to be a string; a custom theme definition path was not found in the files read (unverified).
3. Spec/depth: truecolor hex only: `ansiColor(hex)` emits `38;2;r;g;b`; `ansiColor256` is an alias that also emits truecolor (`utils/ansi.js`). No detection, no NO_COLOR.
4. Fill: foreground-only (`background: 'transparent'` in themes; `contextBar` has a `bg` field).
5. Separators: default `│` in `#565f89` (`separator.color`), dimmed; with `iconSet: "nerd"` the separator becomes the powerline arrow `` (`themes/index.js overlayNerdIcons`) but still foreground-only.
6. Neighbours: separator plus different fg hue per module.
7. Light/dark: a `light` theme with darker hues exists; chosen manually.
8. Glyphs: two icon sets: `text` (default, ASCII-safe `[M] [C] [G] [$] [T]`... ) and `nerd` (Nerd Font icons), `iconSet` config. README line 246 calls text the safe default.
9. Other: i18n zh/en; adaptive line wrapping by width; 13 slash commands incl. `/themes`.
10. Customisation: JSON config (`modules.<x>.{enabled,order,icon}`, `theme`, `iconSet`, separator, per-row module cap), slash commands `/pulse-line:theme|themes|enable|disable|config`.

## setup-ccstatusline
https://www.npmjs.com/package/setup-ccstatusline (v1.0.0, stars n/a). A one-shot installer that writes a ccstatusline config; the styling is the config it writes (`index.js:12-92`), executed by the real ccstatusline.
1. Colour: fixed per widget. Mapping in the written config: model fg `cyan`; thinking-effort bg `bgMagenta`; version `bgCyan`; git-branch `bgBrightBlue`; git-changes `bgYellow`; current-working-dir `bgBrightCyan`; context-bar `bgRed`; session-usage `bgBrightWhite`; reset-timer `bgYellow`; weekly-usage `bgRed`; weekly-reset-timer `bgBrightBlack`; session-clock has none. Colour values are ccstatusline named ANSI backgrounds.
2. Themes: sets `powerline.theme: "onedark"` (`:89`), a ccstatusline built-in powerline theme. Whether that theme overrides the per-widget colours listed above is not visible here: unverified (ccstatusline code not read).
3. Spec/depth: `colorLevel: 2` (256-colour mode in ccstatusline's scale, `:79`); named ANSI colours. NO_COLOR not present in this file.
4. Fill: background-filled (powerline mode on).
5. Separators: powerline arrow ``, `separatorInvertBackground: [false]`, no start/end caps, `inheritSeparatorColors: false` (`:80-88`).
6. Neighbours: different background colour per widget plus powerline arrows; adjacent widgets in each line get different backgrounds in the written config (line 1: magenta, none, cyan; line 2: brightBlue, yellow, brightCyan, red; line 3: brightWhite, yellow, red, brightBlack), chosen by hand.
7. Light/dark: not present.
8. Glyphs: Nerd Font powerline glyph required.
9. Other: three lines, `flexMode: full-minus-40`, `compactThreshold: 60`.
10. Customisation: the written file `~/.config/ccstatusline/settings.json` (JSON v3), edited later through ccstatusline's own TUI.

## sk-claudecode
https://www.npmjs.com/package/sk-claudecode (v1.1.0, stars n/a). A large agent/skills plugin; its statusline is the "SKC HUD" in `dist/hud/` ("Based on claude-hud reference implementation", `colors.js` header). The Python/JS colour matches in the scan are skill assets, not the HUD.
1. Colour: mixed. By threshold: context % (`getContextColor`: >=85 red, >=70 yellow, else green; `colors.js`), rate limits 5h/wk (`limits.js getColor`), ralph iteration (70%/90% of max), todo progress (>=80 green, >=50 yellow, else cyan), background-task capacity. By model tier: `getModelTierColor` Opus magenta, Sonnet yellow, Haiku green, unknown cyan (agent codes in `elements/agents.js`); agent duration colour green <2min, yellow 2-5, red >5. Fixed per segment: model, repo, branch and skill text cyan with dim label prefix (`model:`/`repo:`/`branch:`), cwd dim, `[SKC]` bold, autopilot phase colours.
2. Themes: not present. `preset` (`focused` default, `PRESET_CONFIGS` in `types.js`) selects which elements show, not colours.
3. Spec/depth: ANSI 16 only (31-37, 94-96, dim, bold). No detection, no NO_COLOR.
4. Fill: foreground-only.
5. Separators: dim ` | `, and `└─` tree prefix for agent detail lines.
6. Neighbours: `label:` dim prefix and cyan values; separators only.
7. Light/dark: not present.
8. Glyphs: `█░` bar, brackets, `└─`; text labels instead of icons (ASCII-safe).
9. Other: model-tier colouring of subagents; several agent-list display styles.
10. Customisation: HUD config JSON with `preset` and per-element toggles (`state.js applyPreset`); no colour options.

## ohmyposh.dev/blog/oh-my-posh-claude-code-integration
https://ohmyposh.dev/blog/oh-my-posh-claude-code-integration (blog, 2025-12-28; project oh-my-posh, stars n/a here). `oh-my-posh claude` renders Claude Code's statusline with the oh-my-posh engine. Source checked: `src/config/default.go` `statuslineCLIConfig` and `src/cli/claude.go`.
1. Colour: fixed per segment from a named palette, with templates for state. Default config: path segment fg `white` on bg `orange`; git segment fg `black` on bg `green`, with `background_templates` switching by state (working/staging changed `p:yellow`; ahead and behind `p:red`; ahead only `#49416D`; behind only `#7A306C`) and matching `foreground_templates` (black or white); the claude segment (model name plus `TokenGauge`) fg `black` on bg `blue` (`default.go:236-309`). The blog's own sample uses `accent` bg and a battery segment with state backgrounds.
2. Themes: a config is a "theme" in oh-my-posh terms; `--config` loads any JSON/YAML/TOML theme. Palette is a user-extensible name→hex map: default `{black #262B44, blue #4B95E9, green #59C9A5, orange #F07623, red #D81E5B, white #E0DEF4, yellow #F3AE35}`, referenced as `p:name`. Hundreds of bundled prompt themes exist on the site (not Claude-specific).
3. Spec/depth: hex, palette refs (`p:name`), named colours, `parentBackground`/`background` references in diamond markup; oh-my-posh downsamples to terminal depth in its own colour layer (not verified from the files read).
4. Fill: background-filled segments (diamond style) with foreground text; text segments can be transparent.
5. Separators: Nerd Font powerline: leading diamond ``, trailing ``, arrow `` as a text segment coloured `parentBackground` on a transparent bg (`default.go:275-281`); the blog's sample colours the arrow with `<parentBackground,background>` inline markup. Separator colours are derived from the neighbouring segments by reference.
6. Neighbours: different background colours per segment from the palette, with cap/arrow glyphs joining them. Left block (path, git) and right-aligned block (claude segment) are separate.
7. Light/dark: fg is chosen by the author per segment (black on green/blue, white on orange); no automatic contrast. Not present as automation.
8. Glyphs: Nerd Font required (folder, git, branch icons via `\u` escapes), plus `▰▱` gauge.
9. Other: `.TokenUsagePercent.Gauge` / `GaugeUsed` template values; template language lets any colour be conditional on session data (blog "What's next" suggests colour by token usage).
10. Customisation: `--config <file>` (JSON/YAML/TOML), `claude` segment template variables, palette, cache settings.

## photostructure.com/coding/claude-code-statusline
https://photostructure.com/coding/claude-code-statusline/ (blog; stars n/a). Bash script for `~/.claude/statusline-command.sh`.
1. Colour: mixed. Fixed: cwd bold blue `01;34`, model bold cyan `01;36`, separator `|` grey `00;37`. By state: context % green <50, yellow 50-75, red >75 (`01;32/33/31`); effort glyph colour by level: low grey `○`, medium cyan `◐` (matches model), high orange `38;5;208` `●`, auto cyan `Ⓐ`. Design note in the script: medium blends in with the model name so deviations stand out.
2. Themes: not present.
3. Spec/depth: ANSI 16 plus one 256 index (208). No detection or NO_COLOR.
4. Fill: foreground-only.
5. Separators: grey ` | `.
6. Neighbours: separators plus different hues (blue, cyan, state colour).
7. Light/dark: not present; uses terminal ANSI palette so it follows the terminal theme.
8. Glyphs: geometric glyphs `○◐●Ⓐ` for effort (with a thin-space fix for Ⓐ width).
9. Other: effort level read from `~/.claude/settings.json` since stdin lacks it.
10. Customisation: edit the script.

## qiita.com/dai_chi/items/d5f82ef4b727681f3efa
https://qiita.com/dai_chi/items/d5f82ef4b727681f3efa ("Claude Code statusline 完全ガイド", article; stars n/a). Bash examples with 256-colour codes.
1. Colour: by state. Git branch: clean green `38;5;77`, dirty orange `38;5;208` with `*` appended (lines 151-157). Context example: >70 red `38;5;196`, >40 yellow `38;5;220`, else green `38;5;77` (lines 185-194). Model/dir uncoloured in the samples.
2. Themes: not present.
3. Spec/depth: 256-index `\033[38;5;Nm`. No detection or NO_COLOR.
4. Fill: foreground-only.
5. Separators: plain ` | `.
6. Neighbours: separators and emoji prefixes (📁 🌿).
7. Light/dark: not present.
8. Glyphs: emoji.
9. Other: colour plus an asterisk so the dirty state is not carried by colour alone.
10. Customisation: edit shell script; `settings.json` statusLine command.

## qiita.com/nogataka/items/a18fb4ad9cc577aea1ec
https://qiita.com/nogataka/items/a18fb4ad9cc577aea1ec ("Claude Codeのステータスラインを自作して…", article; stars n/a).
1. Colour: by threshold. Progress bar and percent: >=80 red `\033[31m`, >=50 yellow `33`, else green `32` (lines 512-520, again 569-575); everything else uncoloured.
2. Themes: not present.
3. Spec/depth: ANSI 16. None other.
4. Fill: foreground-only.
5. Separators: plain `│`.
6. Neighbours: separators only.
7. Light/dark: not present.
8. Glyphs: `█░` bar and box separator.
9. Other: none.
10. Customisation: edit script; `statusLine` command in settings.

## qiita.com/saitoko/items/db7540220b996473e5d8
https://qiita.com/saitoko/items/db7540220b996473e5d8 ("ステータスラインに何を表示するか", article; stars n/a). Four-line personal statusline.
1. Colour: by threshold: each bar green <60, yellow 60-79, red >=80 (`\033[32m/33m/31m`, lines 199-211); the author notes the official doc uses 70/90. Context-only alert shown as a red band when >80 (line 195). Other lines (GTD counts, task id, now-playing) are uncoloured text with emoji prefixes.
2. Themes: not present.
3. Spec/depth: ANSI 16. No NO_COLOR.
4. Fill: foreground-only (the "red band" is a larger red text element).
5. Separators: not specified in the colour sections read; lines separated by newlines.
6. Neighbours: by line, one concern per line, not by colour.
7. Light/dark: not present.
8. Glyphs: emoji for GTD categories (📥 🎯 ⏳ 🌈 🔁 📁 📎), progress bars.
9. Other: argument is that content should follow the author's workflow; conditional display (show only when relevant).
10. Customisation: bash script, 5-minute cache for GitHub issue counts.

## qiita.com/yousan/items/e677ab6b736632b50fe8
https://qiita.com/yousan/items/e677ab6b736632b50fe8 ("ccstatusline ここから削るための全部のせの設定", article about the ccstatusline tool; stars n/a). Shows a full ccstatusline `settings.json` (v3).
1. Colour: fixed per widget in the sample: model `cyan`; most numeric widgets `brightBlack`; session-cost `yellow`, session-usage `green`, weekly-usage `blue`, reset-timer `magenta`, tokens-input `green`, tokens-output `yellow`, tokens-cached `blue`, git-branch `magenta`, git-changes `yellow`, git-insertions `green`, git-deletions `red`, git-root-dir/cwd `blue`, session-name `yellow`; context-bar has none. So colour groups by data type across lines.
2. Themes: `powerline.theme: "nord-aurora"` (ccstatusline built-in powerline theme; `nord` appears in the scan). Format is the tool's own, per-widget `color`/`backgroundColor`; users can edit either.
3. Spec/depth: ccstatusline `colorLevel: 2` and named ANSI colours; NO_COLOR not discussed.
4. Fill: powerline mode enabled (`powerline.enabled: true`), i.e. background-filled; but this sample sets only fg `color` per widget (whether the theme overrides them in powerline mode is unverified).
5. Separators: powerline arrow `` (empty in the transcript), no caps, `separatorInvertBackground: [false]`.
6. Neighbours: by hue per data type and powerline arrows (theme handles backgrounds).
7. Light/dark: not present.
8. Glyphs: Nerd Font powerline.
9. Other: TUI editor, "全部のせ" 3-line config as a starting point to prune.
10. Customisation: `~/.config/ccstatusline/settings.json`, interactive TUI via `npx ccstatusline@latest`.

## qiita.com/yureki_lab/items/8d478dea02ffe2db85f4
https://qiita.com/yureki_lab/items/8d478dea02ffe2db85f4 (article on a DIY statusLine; stars n/a).
1. Colour: by threshold: green by default, yellow >=70, red >=90 applied to the bar and percent (lines 48-50); model, dir and cost uncoloured.
2. Themes: not present.
3. Spec/depth: ANSI 16.
4. Fill: foreground-only.
5. Separators: spaces only.
6. Neighbours: not distinguished.
7. Light/dark: not present.
8. Glyphs: `▓░` bar (line 45).
9. Other: article's focus is pitfalls (null used_percentage, `tput cols`, slow `git status`), not styling.
10. Customisation: edit the shell script.

## statuslin.es/c/activity-feed-b2164f9d
https://statuslin.es/c/activity-feed-b2164f9d (directory entry; 51 installs; original https://github.com/JungHoonGhae/claude-statusline `statusline.sh`, 705 lines, read raw at that commit).
1. Colour: mostly by state/threshold; some fixed. Context bar and `ctx N%` use `ctx_color` thresholds env-tunable `CONTEXT_WARN_PCT` 30 / `CONTEXT_CRIT_PCT` 70 (green/yellow/red, `statusline.sh:85-86,250-259`). Rate-limit dots `status_dot`: >50 green, >20 yellow, else red (`:306-317`). Fixed: model bold white `1;37`, cost yellow `33`, git branch magenta `35`, ahead green / behind red, dirty `*` red, PR label cyan with state mark (approved green `✓`, changes_requested red `✗`, draft dim `◌`, else yellow `●`), lines `+N` green / `-N` red, running tools yellow, agents magenta, fast-mode cyan, everything secondary `dim` `\033[2m`.
2. Themes: not present.
3. Spec/depth: ANSI 16 plus `dim`. No NO_COLOR, no depth detection.
4. Fill: foreground-only.
5. Separators: dim `│`.
6. Neighbours: dim separators; hue-by-meaning.
7. Light/dark: not present (relies on terminal palette).
8. Glyphs: `●○` dot bars (`:279-281`), `✓✗◌⚡⎇✦`, OSC 8 hyperlinks (`:234`) for branch and PR; Nerd Font signal count 5 (not required).
9. Other: multi-line activity feed (tools and agents parsed from the transcript), budget alert, ccusage table.
10. Customisation: env or `~/.claude/statusline.conf` toggles (`SHOW_TOOLS`, `SHOW_CONTEXT_BAR`, ... lines 76-96) and the two thresholds; no colour options.

## statuslin.es/c/git-detective-cb282aa6
https://statuslin.es/c/git-detective-cb282aa6 (directory entry; original https://github.com/ilia-pluzhnikov/claude-code-statusline `statusline.js`, 373 lines).
1. Colour: by state/threshold. Context bar+tokens: <50 pink truecolor `255;125;218`, <65 yellow, <80 orange `255;140;0`, else red plus a skull prefix 💀 (`statusline.js:83-87`); pink downgrades to yellow past 250k absolute tokens regardless of percentage (`:92-94`). Usage-limit percents use the same four-step ramp (`colorPct`, `:299-304`). Cache ratio: 0 bold red, >=90 bold green, >=75 green, >=50 yellow, else orange (`:249-253`); cache TTL countdown colour by remaining fraction. Git: behind red, ahead yellow, md drift red; branch cyan `(branch)`, detached red; model and dir name `dim`.
2. Themes: not present.
3. Spec/depth: ANSI 16 plus a few truecolor literals. No detection, no NO_COLOR.
4. Fill: foreground-only.
5. Separators: plain ` │ ` (`segments.join(' │ ')`, `:370`), uncoloured.
6. Neighbours: separators and hue-by-state.
7. Light/dark: not present (the pink-for-healthy choice is dark-terminal oriented).
8. Glyphs: `█▌░` half-block bar (`:70-75`), `↓↑ ⚠ 💀`.
9. Other: a pink "calm" colour at low usage instead of green; absolute-token override of the percent colour.
10. Customisation: none beyond editing; only `CLAUDE_CONFIG_DIR` env read.

## statuslin.es/c/keyblade-status-bar-4a772931
https://statuslin.es/c/keyblade-status-bar-4a772931 (directory entry, author emoralesb05; script embedded in the page, `keyblade.py` ~1100 lines, extracted from the page).
1. Colour: mixed. By state: HP bar green >50, bright orange 21-50, red <=20 (`render_classic`, `:925-930`); MP bar colour from `mp_label_and_color`; drive-form colour by effort level (`drive_form_colors`: low red, medium blue, high bright_cyan, xhigh bright_yellow, max bright_white, `:47-53`; Anti Form dim). Fixed per role via `colors` config: hp green, mp blue, munny yellow, keyblade cyan, drive magenta (`:56-62`); keyblade name by model (`keyblade_names`: opus "Ultima Weapon", sonnet "Oathkeeper", haiku "Kingdom Key").
2. Themes: `theme` selects a renderer layout, not a palette: `classic` (2-line HUD) or `minimal` (1-line) (`RENDERERS`, `:1104-1105`). Colour names in `colors` and `drive_form_colors` are user-editable per role. Two colour tables: `ANSI_BASIC` and `ANSI_TRUECOLOR` with Kingdom Hearts hexes (`#8EBC4F` green, `#185FAD` blue, `#64C8DC` cyan, `#F8C169` gold, `#E15239` red, `#DBA8CD` pink, ...).
3. Spec/depth: both. `_detect_color_mode()` returns `none` if `NO_COLOR` set or `CLICOLOR=0`, `truecolor` if `COLORTERM` is truecolor/24bit, else `basic` (16-colour); `color_mode` config can override (`"auto"` default). The basic table includes `38;5;208` for orange. Only in this batch with NO_COLOR + COLORTERM.
4. Fill: both. Bars draw a background-filled track using `bg_<colour>` entries (darkened versions: truecolor `48;2;35;50;20` dark green etc., basic `42`/`44`...) behind the bar (`render_bar`, `:835-860`), with foreground-coloured text.
5. Separators: plain double spaces and frame brackets in a muted grey `frame` colour (`38;2;100;100;100`).
6. Neighbours: different roles use different hues (green HP, blue MP, cyan keyblade, magenta drive, yellow munny); bar tracks have their own darkened bg.
7. Light/dark: not present (dark-tuned truecolor palette). `dim` bg for Anti Form.
8. Glyphs: emoji-ish and symbols for heart, MP sparkle, keyblade, world, munny (icons configurable in code); bars; Nerd Font signal count 5 on the scan but not verified as required.
9. Other: game-themed HUD (HP = usage budget, MP, Drive gauge, level), named forms per effort level.
10. Customisation: `$CLAUDE_CONFIG_DIR/hooks/keyblade/config.json` (`theme`, `color_mode`, `colors`, `drive_form_colors`, names, toggles `show_*`, `hp_source`, ...).

## statuslin.es/c/nerd-font-duo-5af014c4
https://statuslin.es/c/nerd-font-duo-5af014c4 (directory entry; original https://github.com/tzengyuxio/claude-statusline `statusline-command.sh`, 247 lines).
1. Colour: mixed. Fixed: model bold cyan, directory blue, git `+staged` green / `~unstaged` yellow / `?untracked` dim; all separators and labels `dim`. By threshold: `pct_color` green <50, yellow 50-79, red >=80, used for the context bar, `%`, and 5h/7d usage (`duo.sh:96-101,211-219`). At >=90 context an alert badge appears with red background `\033[41m` and bold white text `CTX N%` (`:240`).
2. Themes: not a theme set; two palettes `dark` and `light` (`:52-72`) differing in `DIM` (`\033[2m` vs bright black `\033[90m`) and alert text colour (bold white `1;37` vs bold black `1;30`).
3. Spec/depth: ANSI 16. No NO_COLOR. Theme "detection" (below).
4. Fill: mostly foreground; the alert badge is background-filled (`BG_RED`).
5. Separators: dim ` │ ` (`SEP`, `:84`).
6. Neighbours: separators and hue by role.
7. Light/dark: yes. `detect_theme()` (`:22-44`): `STATUSLINE_THEME=dark|light|auto` override; auto checks macOS `defaults read -g AppleInterfaceStyle` (dark) then `COLORFGBG` background index `<8` => dark; default dark. Light mode swaps dim to bright-black for visibility and the badge text to black.
8. Glyphs: Nerd Font Material Design icons (`nf-md-robot` etc., "all MD range, U+F0000+", `:74-81`), `▰▱` 16-cell bar.
9. Other: critical context badge with red bg.
10. Customisation: env `STATUSLINE_THEME`; edit script.

## statuslin.es/c/tasqr-queue-c085b5c3
https://statuslin.es/c/tasqr-queue-c085b5c3 (directory entry; Python script `tasqr` embedded in the page, ~1130 lines, extracted and de-HTML'd).
1. Colour: by theme role mapped to meaning. Roles: dim, accent, branch, ok, warn, alert (`PALETTES`, `:71-114`). Semantics: model name and pending = accent (blue); in-progress / quota pressure = warn (amber); blocked / critical = alert (coral); healthy = ok (mint); secondary text = dim. Quota threshold: `alert` >=80 (>=95 in one cell), `warn` >=60, else dim/ok (`:892,899,826`).
2. Themes: 4 palettes: `ansi` (terminal's own 16 colours mapped by meaning, adapts to any terminal theme), `dark` (xterm-256 values for Tasqr's Signal tokens: accent `#5B8CFF`, mint `#54E6B5`, amber `#E0B23C`, coral `#FF6B6B`, muted `#7C879E`), `light` (re-derived darker hues), `dracula`. Format: semantic roles (6 per palette) plus a `CHIPS` table of `(bg, fg)` 256-index pairs per role per theme. Settings resolve in layers (global config, per-project entry, `.tasqr-statusline` file, `TASQR_STATUSLINE_*` env). New palettes need code.
3. Spec/depth: ANSI 16 (ansi theme) and 256-index (`38;5;n`, `48;5;n`). `NO_COLOR` honoured (`_want_color`, `:187`): colour off, and the colour-only `bubble` style collapses to `plain`. Theme auto-resolution: `TASQR_STATUSLINE_THEME`, then config, then Claude Code's own `theme` setting in `~/.claude/settings.json` (dark/light/dracula names), else `ansi` (`resolve_theme`, `:166-185`). No truecolor.
4. Fill: both, by style. `plain` is foreground-only; `bubble` paints each segment as a background-filled chip with padding spaces (`_bubble`, `:226-232`), "pure background color rather than edge glyphs".
5. Separators: plain text ` · ` in the one-line mode; `meters` style uses a wider separator (`METERS_SEP`); `bubble` joins chips with a single space.
6. Neighbours: in bubble style each chip has its own role bg with on-accent dark text (neutral chips sit on a surface colour that tracks theme); in plain, separators and role hues.
7. Light/dark: yes. Reads Claude Code's theme (`~/.claude/settings.json`), dedicated `light` palette and `light` chips with light surface `254` instead of near-black; the `ansi` palette adapts to the terminal automatically; chip text is dark-on-accent (dark theme) or white `231` on dark accent (light theme), hand-picked per theme.
8. Glyphs: no emoji in bubble mode ("works in any font"), otherwise a blocked-marker emoji that is replaced by the word "blocked" in chip mode (`_chip_text`); ASCII-friendly.
9. Other: four styles `plain`, `bubble`, `panel`, `meters` (`STYLES`); marquee scrolling title (`MARQUEE_GAP`); background-refresh cache.
10. Customisation: layered settings `tags, theme, style, segments, ttl, refresh` (`SETTING_KEYS`, `:51`), env `TASQR_STATUSLINE_THEME|STYLE|TTL`, `NO_COLOR`.

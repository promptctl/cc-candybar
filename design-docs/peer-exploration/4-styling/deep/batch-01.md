# Batch 01: how 25 Claude Code statusline projects do styling

Source: each project's own code, fetched from raw.githubusercontent.com. File anchors are repo-relative. "Not found in files read" means a grep of the files I fetched came back empty; it is not a claim about the rest of the repo.

## ruflo
https://github.com/ruvnet/ruflo — stars 79032
1. Fixed per segment, plus state/threshold. `.claude/helpers/statusline.cjs` ~L1083-1160 hard-codes roles: header `▊ RuFlo V…` bold bright-purple, repo name bright-cyan, branch bright-blue, model purple, duration cyan, cost bright-yellow, "Swarm"/"Hooks" labels cyan. Thresholds: context `usedPct>=90` bright-red, `>=70` bright-yellow, else bright-green (`ctxColor`); intelligence `>=80` green, `>=40` yellow, else dim; git `+staged` bright-green, `~modified` bright-yellow, `?untracked` dim, `↑` green, `↓` red; security status maps PENDING/IN_PROGRESS yellow, ISSUES red, STALE dim. Zero/inactive counts fall to `c.dim`.
2. Themes: not present in the statusline (no theme table, no user colour map). `plugins/ruflo-console/hooks/themes.ts` is the separate ruflo-console UI, not read.
3. Colour spec: ANSI-16 only, `\x1b[0;3Xm` and `\x1b[1;3Xm` (`statusline.cjs` L658-673 `c` table). No depth detection. NO_COLOR: not found in files read.
4. Fill: foreground-only on terminal background.
5. Separators: plain-text `│` and `·` in `c.dim` (statusline.cjs ~L1090, L1140). No powerline.
6. Neighbours: separated by dim `│` / `·` text, plus different colour per role. No position logic.
7. Light/dark: not present. Uses `dim` and bright variants with no contrast check.
8. Glyphs: emoji (`💾`, `🛡`, `👥`) and box/unicode (`▊ ● ⏇ ⏱ ◉ ○`). No ASCII fallback found.
9. Other: a promo/insight line coloured by kind (promotional bright-purple, educational yellow, insight bright-red). A `.claude/statusline.sh` and `.mjs` variant exist; I read only the `.cjs` in detail.
10. Customisation: `CONFIG` object in the generated helper (e.g. `CONFIG.costSymbol`); `v3/@claude-flow/cli/src/init/statusline-generator.ts` generates the helper (197 lines, not studied for colour options). No colour config surface found.

## awesome-claude-code (entry: cc-hud)
https://github.com/hesreallyhim/awesome-claude-code/issues/1320 — list repo stars 56438; the issue submits WaterTian/cc-hud (no star count fetched)
Note: awesome-claude-code itself is a curated list, not a statusline (its scripts are README/ticker generators). The URL is the submission issue for **cc-hud**, so this section analyses https://github.com/WaterTian/cc-hud, `src/render.ts`.
1. By state/threshold plus fixed per segment. Context bar colour by `color(percent)` (render.ts L26-31): <=50 green `fg(151)` #a6e3a1, <=70 yellow `fg(223)`, <=85 peach `fg(216)`, else red `fg(211)`. Reset countdown colour by time left `countdownColor` (L72-77): >=24h sapphire, >=3h lavender, >=0.5h flamingo, else maroon. Fixed: model `BLUE`, agents `TEAL` (`◐`), folder `SAPPHIRE`, branch `GREEN`, extra `TEAL`, cost/separators `OVERLAY`.
2. Themes: one hard-coded Catppuccin Mocha palette (render.ts L3-21), no theme switching, not user-definable (README says "Catppuccin Mocha color theme").
3. Spec: ANSI 256 indices (`\x1b[38;5;Nm`), each annotated with its Mocha hex. No detection/downsampling; NO_COLOR not found in render.ts.
4. Fill: foreground only. Bar track is `░` in `SURFACE` fg(238).
5. Separators: plain `│` in `OVERLAY` (L184) and ` · ` inside the workspace segment.
6. Neighbours: distinct hue per role plus `│`.
7. Light/dark: not present (palette is for a dark terminal).
8. Glyphs: Unicode only; 1/8-precision bar `▏▎▍▌▋▊▉█` (L23).
9. Other: stale rate-limit gauge prefixed `~`; `clean()` strips control chars from third-party text.
10. Customisation: `/cc-hud:setup` command; no colour options found.

## claude-code-templates
https://github.com/davila7/claude-code-templates — stars 32876
1. Mostly no colour. `cli-tool/components/settings/statusline/*.json` (34 files) are `settings.json` snippets whose `command` is a one-line bash echo. I grepped 18 of them for `\033`/`\e[`: zero hits. Example: `colorful-statusline.json` is described as "blue for model, green for directory, yellow for git branch" but its command is `echo "[$MODEL] 📁 ${DIR##*/}$BRANCH"` with no escape codes, so the description is not backed by the code. `productivity-rainbow-statusline.json` "rainbow" is a seconds-indexed emoji array `("🔴" "🟠" "🟡" "🟢" "🔵" "🟣")`. Only the two Python scripts colour: `context-monitor.py` (git clean green `\033[32m` / dirty red `\033[31m` L47-50; context bar icon+colour by level 🟢/🟡/🟠/🔴/🚨 L140-152; cost red/yellow/green L202-206; model name coloured by context level L266-276; directory `\033[93m`) and `deadline-countdown.py` (12 escape hits, not read).
2. Themes: not present for statusline (the theme names in the scan come from Marp/skill CSS and the analytics UI).
3. Spec: ANSI-16 in the two Python scripts only. No depth detection; NO_COLOR not found.
4. Fill: foreground only.
5. Separators: ` | ` plain text; `\033[90m|\033[0m` grey in context-monitor.py L53/243.
6. Neighbours: emoji prefixes; `|` separators.
7. Light/dark: not present.
8. Glyphs: emoji-heavy (🌿 📁 💰 ⏱ 📝 🎮 etc.). No ASCII mode.
9. Other: theme-park statuslines (rpg, tamagotchi, casino, spaceship) are novelty text, not colour systems.
10. Customisation: pick a JSON snippet from the catalogue; the CLI installs it into settings.json. Users edit the bash string.

## oh-my-posh
https://github.com/jandedobbeleer/oh-my-posh — stars 23646
Note: a general shell prompt engine; it ships a Claude Code statusline subcommand (`oh-my-posh claude`), analysed here.
1. Fixed per segment in the bundled Claude config, with state templates. `src/config/default.go` `statuslineCLIConfig` (L236-310): left block PATH = white-on-orange (`p:white` on `p:orange`), GIT = black on green; `BackgroundTemplates` (L263-268) switch git bg: changed -> `p:yellow`, ahead+behind -> `p:red`, ahead -> `#49416D`, behind -> `#7A306C`; `ForegroundTemplates` flip text to black/white to match. Right block: the Claude segment (model + `.TokenGauge`) black on `p:blue`. Any user config can colour any segment arbitrarily with `background`, `foreground`, `*_templates`.
2. Themes: yes, 126 files in the repo `themes/` dir (e.g. catppuccin x4 flavours, dracula, gruvbox, tokyo-night, agnoster, M365Princess, atomic…), format `*.omp.json`: per-segment colour fields plus a named `palette` map. Default Claude palette: black #262B44, blue #4B95E9, green #59C9A5, orange #F07623, red #D81E5B, white #E0DEF4, yellow #F3AE35 (default.go L296-304). Segments reference `p:name`, so the palette is swappable; templates can choose the palette name dynamically. Users define their own config (JSON/YAML/TOML). The `claude` command uses a config only if `--config` is passed explicitly (statusline.go L26-31).
3. Spec: hex, named ANSI, 256 index, palette refs `p:`, `transparent`, `parentBackground` (`color.ParentBackground`), gradients `c1:c2` (writer.go ~L1062 `stampGradient`). Downgrades via gookit/color (`src/color/colors.go`); `color.TrueColor = Program != AppleTerminal` (src/terminal/writer.go L304). macOS accent colour readable (`colors_darwin.go` `GetAccentColor`). NO_COLOR: not found in the files read.
4. Fill: both. Background-filled segments, or text-only (`plain` style with transparent bg).
5. Separators: segment `style` = powerline / plain / diamond / accordion. Default Claude config: diamond caps `` `` on the PATH and Claude segments, and a trailing `TEXT` segment `` with `Foreground: ParentBackground`, `Background: transparent` (default.go L275-281), so the arrow takes the previous segment's background automatically. Powerline-style separator colours inherit from neighbouring backgrounds.
6. Neighbours: different backgrounds per segment (the author picks them); the arrow glyph bridges them.
7. Light/dark: `terminalBackground` config template (`terminal.BackgroundColor = cfg.TerminalBackground.ResolveTemplate()`, statusline.go L66) is used to blend/fix transparent colours; no automatic text-contrast picker found. Themes include light flavours (catppuccin_latte).
8. Glyphs: Nerd Font heavy (powerline `..`, ``, `\U000f0bc9`); `.omp.json` themes include ASCII-friendly ones (e.g. `1_shell`). Emoji used in some.
9. Other: theme gallery on the website (`website/export_themes.mjs`), a config editor component (`website/src/components/ConfigEditor/editorTheme.js`), SVG export (`src/svg/colors.go`).
10. Customisation: config file (json/yaml/toml), `oh-my-posh init`, `oh-my-posh config export`, `--config`, `POSH_THEME`/`POSH_CONFIG` env (ignored by the statusline command), `--shell`.

## ccstatusline
https://github.com/sirmalloc/ccstatusline — stars 13394
1. Fixed per widget by default, user-overridable, optionally cycled by position in powerline mode. Each widget class has `getDefaultColor()` (e.g. `Model.ts` L14 cyan, `GitBranch.ts` L74 magenta, `ContextPercentage.ts` L30 blue, `CurrentWorkingDir.tsx` L32 blue, `SessionCost.ts` L22 green, `GitInsertions` green, `GitDeletions` red, `GitChanges` yellow, `BlockTimer` yellow, `TokensTotal` cyan, `Version` gray). Per-widget `color`/`backgroundColor`/`bold` stored in settings. In powerline mode with a theme, colours are assigned by slot index: `themeColors.fg/bg[widgetColorIndex % length]` (`src/utils/renderer.ts` L317-330); slot numbering in `powerline-theme-index.ts` (a widget with `merge` shares the previous widget's slot; separators and hidden widgets take none; `continueThemeAcrossLines` carries the counter across lines). Threshold colouring of context/cost: not found in the widget files read.
2. Themes: 10 bundled powerline themes plus `custom` (`src/utils/colors.ts` L332-490: nord, nord-aurora, monokai, solarized, minimal, dracula, catppuccin, gruvbox, onedark, tokyonight). Format = per-slot colour LISTS per colour level, 5 entries each, `{ 1: {fg[], bg[]}, 2: {...}, 3: {...} }` (1=16-colour names, 2=`ansi256:N`, 3=`hex:RRGGBB`), i.e. three hand-authored variants per theme. Example nord truecolor bg: 88C0D0, 4C566A, 5E81AC, B48EAD, A3BE8C with matching fg list. `custom` = user picks each widget's colours in the TUI. Default theme `nord-aurora` (`getDefaultPowerlineTheme`).
3. Spec: named ANSI 16 (incl. bright, `bgBrightX`), `ansi256:N`, `hex:RRGGBB`, and `gradient:` specs (below). Depth = `settings.colorLevel` 0-3 set into `chalk.level` (`src/ccstatusline.ts` L84-87, default 2 = 256 per `Settings.ts` L69); user-chosen in the TUI, not auto-detected. Named colours map to three different concrete values per level (`createColorMap`, colors.ts L16-58, e.g. `green` = ansi16 / 256-idx 70 / #4e9a06). NO_COLOR / COLORTERM: not found.
4. Fill: both. Normal mode = coloured text with optional per-widget background; powerline mode = background fills.
5. Separators: normal mode: configurable `separator` widgets (default `|`, `inheritSeparatorColors` option copies the previous widget's colours, `Settings.ts` L73). Powerline mode: `separators` array (default ``, cycled per slot) with `separatorInvertBackground[]`, `startCaps[]`, `endCaps[]` (`PowerlineConfig.ts`). Arrow colours: fg = previous widget bg via `bgToFg(widget.bgColor)`, bg = next widget bg (renderer.ts L595-676); cap fg likewise.
6. Neighbours: powerline themes cycle through 5 distinct bg/fg pairs (distinct hues, not lightness steps); non-powerline relies on `|` text separators and per-widget hue.
7. Light/dark: not present as detection. Text contrast is hand-chosen per theme slot (e.g. nord fg `2E3440` on light `88C0D0`, `D8DEE9` on dark `4C566A`). Only `overrideForegroundColor`/`overrideBackgroundColor` global overrides.
8. Glyphs: powerline font check and installer (`powerline.ts` `checkPowerlineFonts`, `installPowerlineFonts` clones powerline/fonts); widgets use emoji/unicode; custom symbol widget (`CustomSymbol.tsx`).
9. Other: **per-character gradients** `gradient:<preset|stop-list>` (`src/utils/gradient.ts`; stops joined by `,` or `-`, interpolated in OKLab, presets mirror gradient-string: atlas, cristal, teen, mind, morning, …); at ansi16 the gradient spec is suppressed (colors.ts L185-188). Dim-parens option `dim: 'parens'`. `globalBold`. Interactive Ink TUI with live preview (`StatusLinePreview.tsx`, `ColorMenu.tsx`, `PowerlineThemeSelector.tsx`).
10. Customisation: JSON settings (`Settings.ts`, zod), Ink TUI (`npx ccstatusline`), per-line widget lists; env `DEBUG_FONT_INSTALL`. No env colour controls found.

## buildwithclaude (claude-hud plugin)
https://github.com/davepoon/buildwithclaude — stars 3673
Note: a plugin/skill marketplace; its statusline-relevant styling is `plugins/claude-hud/src/render/*` (and a codex-hud wrapper script with no colour code).
1. Fixed per element plus state. `render/colors.ts`: model `[name]` cyan (`session-line.ts` L14); context bar colour by `getContextColor` (>=85 red, >=70 yellow, else green; colors.ts L37-41) and the same colour on the bar `█`/`░`; config counts and duration `dim`; `⚠️ COMPACT` red at >=95%. `agents-line.ts` L29-43: status `●` yellow when running / `✓` green when done, type magenta, model/description/elapsed dim. `todos-line.ts`: `✓` green, `▸` yellow.
2. Themes: not present (the `theme-*` names in the scan are skill assets, e.g. theme-factory markdown). One hard-coded palette.
3. Spec: ANSI-16 escapes only (`\x1b[32m` etc.) plus `\x1b[2m` dim (colors.ts L1-7). No detection; NO_COLOR not found.
4. Fill: foreground only.
5. Separators: single spaces between parts (`parts.join(' ')`, session-line.ts L47); no separator glyph.
6. Neighbours: colour by role and space only.
7. Light/dark: not present.
8. Glyphs: unicode `█ ░ ● ✓ ▸ ⏱` and an emoji `⚠️`. No ASCII mode.
9. Other: nothing else styling-related found.
10. Customisation: `config-reader.ts` reads a plugin config (127 lines, display toggles; no colour options found).

## CCometixLine
https://github.com/Haleclipse/CCometixLine — stars 3482
1. **By data category through a semantic palette.** Every metric declares a `Category` (`src/style/palette.rs` L8-23): Identity, Workspace, Vcs, Context, Quota, Cost, Cache, Session, Timing, Activity, System, Custom (src/metrics/*.rs assign them, e.g. identity.rs model/identity -> Identity, code.rs git -> Vcs, usage.rs context -> Context, quota -> Quota, cost -> Cost, cache -> Cache). Colour = palette token for the category (`base_color`, skin.rs L177); an item may carry its own `color`/`fg`/`icon_color` override. State: severity Good/Warn/Crit maps to tokens `ok`/`warn`/`crit` (`severity_token`, skin.rs L168): in plain skin it recolours the text, in filled skins it recolours text if that reads (contrast >= 3.0 `SEVERITY_TEXT`) else the background (skin.rs L243-297). Graph/bar fill uses `gradient(theme, t)` ok -> warn -> crit, lerped when all RGB else stepped at 0.5/0.8 (skin.rs L316-338). `Custom` category uses `accent`.
2. Themes ("palettes"): 13 built in (`BUILTIN_NAMES`, palette.rs L206-220: terminal, catppuccin-mocha, catppuccin-latte, dracula, nord, tokyo-night, rose-pine, gruvbox, anthropic-clay, powerline-dark, powerline-light, powerline-rose-pine, powerline-tokyo-night). Format = semantic tokens: `ok warn crit accent muted separator text bg on_fill` plus one colour per category plus optional `<category>.bg` / `<category>.fg` segment pair (20 plain tokens + 12x2 segment tokens). Users add `palettes/<name>.toml` with `light = false` and a `[colors]` table of token = colour; a user file with a built-in's name replaces it (palette.rs `Palette::load`). `terminal` palette = ANSI colours only. 8 built-in presets combine palette+skin+glyph tier (src/presets.rs, with tags minimal/multi-line/powerline/quota/cache/context); users add `presets/*.toml`.
3. Spec: `#rrggbb`, `#rgb`, `256:n`, `16:n`, or ANSI names `red`, `bright_blue` (`Color::parse`, color.rs L63-80). `ColorDepth` truecolor/256/16/none with `Color::downgrade` (nearest via `rgb_to_ansi256`/`rgb_to_ansi16`, color.rs L108-123). Auto depth from env: `NO_COLOR` non-empty -> none, `COLORTERM=truecolor|24bit` -> truecolor, TERM contains `256color` -> 256, else 16 (`src/env.rs` L17-31). NO_COLOR honoured.
4. Fill: both, by skin. `SkinKind` plain / bracket / pill / powerline (skin.rs L12-23). `FillStyle::Solid` (item colour as bg, text a deep shade) or `Tinted` (item colour as text on a dark bg mixed 22% with it, `TINT`).
5. Separators: plain skin = ` │ ` (` | ` in ASCII tier), coloured by token `separator` (unset: ANSI white, or `muted` on a light palette, palette.rs `color()`); bracket skin `[ ]`; pill skin rounded caps U+E0B6/E0B4 with cap fg = segment bg; powerline skin arrows whose fg = this segment bg and bg = next segment bg (`compose`, skin.rs L474-516), including right-aligned segments pointing left. Pill/powerline fall back to bracket when the glyph tier is not Nerd (`effective`).
6. Neighbours: by category colour (different hue per category), or per-category `<cat>.bg` in filled skins; in powerline skin the arrow bridges backgrounds. No lightness stepping.
7. Light/dark and contrast: yes. `Palette.light` flag (affects separator fallback). WCAG relative luminance and contrast ratio implemented (skin.rs L182-205); `readable()` shades the text toward the target in 10 steps until contrast >= 4.5 (`READABLE`); default text on a filled segment is `ink_on(bg)`, a 75% (`INK`) shade of bg toward `on_fill`, then made readable. Unknown (terminal) colours are never adjusted (contrast returns 21).
8. Glyphs: three tiers `GlyphTier` Nerd / Unicode / Ascii (glyphs.rs L8-16), plus `scripts/nerd-glyphs.mjs` and a font dialog in the TUI (`tui/dialogs/fonts.rs`).
9. Other: ratatui configurator with colour dialog (`src/tui/dialogs/color.rs`, `tui/pages/style.rs`); live preview; a presets gallery referenced as statuslin.es (presets.rs comment).
10. Customisation: TOML config, `palettes/*.toml`, `presets/*.toml`, TUI, CLI (`src/cli.rs`), env `NO_COLOR`/`COLORTERM`/`TERM`.

## token-optimizer
https://github.com/alexgreensh/token-optimizer — stars 2685
Note: mainly a token-audit plugin/skill; its statusline is `skills/token-optimizer/scripts/statusline.js` (copies under `plugins/` and `cowork/`; `codex_statusline.py` is for Codex).
1. By state/threshold, one colour for the rest. Context bar: `<50%` green `\x1b[32m`, `<70%` yellow `\x1b[33m`, `<80%` orange `\x1b[38;5;208m`, else blinking red `\x1b[5;31m` (statusline.js L328-339); rate-limit percent uses the same ladder at 50/75/90 (L618). Quality score tag green/yellow/orange/red (L468-474); `Fill:`/`Tools:` yellow warn / red-and-bang critical (L543-554); `Compacts:` 0 green, <=2 yellow, else red (L565-568); `⤸resumable` cyan (L513). Model/dir/cost otherwise uncoloured.
2. Themes: not present in the statusline. `scripts/check-theme-contrast.py` is a WCAG AA audit for the HTML dashboard's dark/light CSS palettes, not the statusline.
3. Spec: ANSI-16 plus 256 indices (`38;5;208`, `38;5;245`). No depth detection; NO_COLOR not found.
4. Fill: foreground only.
5. Separator: ` | ` where the bar is `DIM` = `\x1b[38;5;245m` (L249-251; comment says ANSI faint `\x1b[2m` was too low-contrast, so a fixed medium grey is used).
6. Neighbours: ` | ` separators; most segments are uncoloured text.
7. Light/dark: not present in the statusline (contrast reasoning only in the grey choice).
8. Glyphs: `█ ░` bar, `⤸`; no emoji in the colour paths read.
9. Other: blinking red (`5;31`) at >=80% context as an alarm.
10. Customisation: not found in files read (no colour options).

## my-claude-code-setup
https://github.com/centminmod/my-claude-code-setup — stars 2677
Note: a personal config/skills repo. Its only statusline is the sample script in `README.md` ("Claude Code Statuslines" section, ~L195-290).
1. No colour. The script `echo`s `[$MODEL_DISPLAY] 📁 dir | 🌿 branch…` then `Context: [██░░] N%` and `Cost: $… | +A -R lines` with zero escape codes.
2. Themes: not present.
3. Spec: none; NO_COLOR irrelevant (no colour emitted).
4. Fill: n/a (terminal default).
5. Separators: ` | ` plain text.
6. Neighbours: emoji prefixes and `|`.
7. Light/dark: not present (nothing coloured).
8. Glyphs: emoji (📁 🌿 🌳) and `█ ░` bar (20 wide).
9. Other: worktree 🌳 and ahead/behind arrows `↑ ↓ ↕`.
10. Customisation: edit the pasted bash file. The other files the scanner read (`session-metrics` skill, notifier) are HTML/chart code, not a statusline.

## CodeIsland
https://github.com/wxtsky/codeisland — stars 2516
not a Claude statusline: macOS MacBook-notch app (plus iOS/Watch/Windows companions) that shows live status of AI coding agents and approves tool calls; README: "Your AI coding agents, live in the MacBook notch". The scanner's colour hits were icons and build scripts.

## claude-code-tools
https://github.com/pchalasani/claude-code-tools — stars 2020
Note: a large tools repo; the statusline is `scripts/statusline.sh` (192 lines).
1. Mixed: position + fixed + state. Line 1 is a p10k-style powerline: model pill (`BG_GREEN`, text black bold), directory pill `BG_BLUE`, git pill light blue 256-index 75 (`BG_LTBLUE=48;5;75`), then `BG_CYAN` as the next-bg for the closing arrow, then a plain date. State changes the model pill: **green when the git tree is clean, yellow when dirty** (statusline.sh L87-124, `model_bg`). Line 2 (no fills): context, 5h and 7d are 10-cell bars coloured by usage `build_bar`: >95 `38;5;196` red + blink, >85 `38;5;208` orange, >70 `38;5;220` yellow, else `38;5;29` green; empty cells `38;5;240` (L67-84). Labels `38;5;250`, reset times `38;5;244`.
2. Themes: not present; hard-coded.
3. Spec: ANSI-16 (`\033[44m`) and 256 (`48;5;208`, `75`). No detection; NO_COLOR not found.
4. Fill: both. Line 1 background pills; line 2 foreground only.
5. Separators: powerline arrow `$SEP` (Nerd Font); echo order writes `FG=<previous bg>` + `BG=<next bg>` + arrow, e.g. `${model_fg}${BG_BLUE}${SEP}` (L180ff), so arrow colours follow neighbouring pills.
6. Neighbours: different hue per pill (green/yellow, blue, light-blue, cyan) and the arrow.
7. Light/dark: not present; text black on bright pills, white on bars.
8. Glyphs: Nerd Font required (header comment L3 "Uses nerd fonts"); `⇡ ⇣ ~ + !` p10k-style git counts; `↻` for reset.
9. Other: `\033[5m` blink on the >95% bar.
10. Customisation: edit the script; no config file read.

## claude-code-skills (statusline-generator)
https://github.com/daymade/claude-code-skills — stars 1493
Note: a skills collection; the relevant file is `daymade-claude-code/statusline-generator/scripts/generate_statusline.sh` (227 lines).
1. By state plus fixed. Context text `ctx: used/size (N%)` coloured by level `ctx_color`: green `\033[01;32m` <=50%, yellow `\033[01;33m` 51-80%, red `\033[01;31m` >80% (L150-156). Fixed: username bold green, working dir bold cyan, git `[git:branch]` bold yellow when clean / bold red when dirty (L179-181), cost `[$session/$daily]` bold magenta, bottom line bold white.
2. Themes: not present.
3. Spec: ANSI-16 with bold `\033[01;3Xm`. No detection; NO_COLOR not found.
4. Fill: foreground only.
5. Separators: spaces and brackets; no separator glyph.
6. Neighbours: hue per role.
7. Light/dark: not present.
8. Glyphs: emoji in some layouts; no ASCII mode found.
9. Other: layouts `render_full` etc. (multi-line with cost, git and percent).
10. Customisation: edit the generated script; `install_statusline.sh` installs it. Colour options: not found.

## claude-codex-settings
https://github.com/fcakyon/claude-codex-settings — stars 1187
Note: a settings/plugins bundle; the statusline is `.claude/statusline.sh` (262 lines).
1. By state, otherwise dim/plain. `color_for_pct` (L10-17): <50 GREEN, <70 YELLOW, else RED; applied to context (`CTX_CLR`, L123) and weekly (`WEEK_CLR`, L246). Other segments use `DIM` or no colour.
2. Themes: not present (the `pptx_theme.py` hits are Office skills).
3. Spec: ANSI-16 (`\033[32m`, `[33m`, `[31m`, `[2m`). No detection; NO_COLOR not found.
4. Fill: foreground only.
5. Separators: ` ${DIM}|${RST} ` (dim pipe) between counts (`.claude/statusline.sh` L252-256); no powerline glyphs.
6. Neighbours: dim pipes; ctx and weekly coloured, counts dim.
7. Light/dark: not present.
8. Glyphs: bars (`ACCT_BAR`, `WEEK_BAR`) and plain text labels `[5h]`, `[7d]`; no Nerd Font. ASCII mode: not present.
9. Other: nothing else.
10. Customisation: edit the script.

## claude-powerline
https://github.com/Owloops/claude-powerline — stars 1175
1. **Fixed per segment through a per-segment theme record, plus state.** `ColorTheme` (`src/themes/index.ts`) has one `{bg, fg, bold?}` pair per segment kind: directory, git, model, session, block, today, month, tmux, context, contextWarning, contextCritical, metrics, version, env, weekly, agent, thinking, cacheTimer, outputStyle (19). Mapping to segments is fixed (`getSegmentBgColor`, `src/powerline.ts` ~L1020). State: context uses `contextWarning` when remaining <=40% and `contextCritical` when <=20% (`segments/renderer.ts` L538-547; same pattern for other bars). Per-part override `colors.custom.<key>.fg` (`resolvePartColors`, powerline.ts L995-1008).
2. Themes: 6 bundled families x 3 depth variants = 18 entries (`BUILT_IN_THEMES`): dark, light, nord, tokyo-night, rose-pine, gruvbox, each with `-ansi256` and `-ansi` (16) hand-authored variants. Example dark: directory bg #8b4513, git #404040, model #2d2d2d, contextCritical bg #991b1b / fg #fca5a5 (`themes/dark.ts`). Semantic roles: not present, it is a per-segment map. Users define their own with `theme: "custom"` plus `colors.custom` (`.claude-powerline.json` has `"theme":"custom"`), `getThemeColors` powerline.ts L853-880. Screenshot gallery `images/claude-powerline-themes.png`, `scripts/screenshot-themes.tape`.
3. Spec: hex strings only in themes; converted at output by depth: `hexToAnsi` (truecolor), `hexTo256Ansi` (own cube/greyscale quantiser), `hexToBasicAnsi` (backgrounds dropped, foreground classified into red/green/blue/white/grey by channel dominance) (`utils/colors.ts`). Detection: `getColorSupport()` (`utils/color-support.ts`): NO_COLOR -> none, FORCE_COLOR 0-3, TERM=dumb, CI, `COLORTERM=truecolor`, terminal-name tables (kitty, ghostty, wezterm, alacritty, foot, iTerm, vscode, Apple Terminal -> 256), `-256color`, tty `hasColors`. Config `display.colorCompatibility` = auto or forced. `"none"` -> no colour; theme lookup picks the `-ansi`/`-ansi256` variant (`getTheme`, themes/index.ts L137-152).
4. Fill: both; powerline/capsule use backgrounds, `minimal` removes the arrow glyph. `transparent`/`none` bg accepted (`\x1b[49m`).
5. Separators (`display.style`): `powerline` arrow ``, `capsule` rounded ``/`` caps around each segment, `minimal` none; `charset: text` swaps to ASCII (`BOX_CHARS_TEXT`, `TEXT_SYMBOLS`). Arrow colour: fg = `extractBgToFg(bgColor)` (the segment's own bg turned into a fg), bg = next segment's bg (powerline.ts L1105-1146); at 16-colour depth the arrow fg is plain white (`isBasicMode`).
6. Neighbours: different hue/brightness per segment baked into each theme (e.g. dark: #8b4513 brown, #404040, #2d2d2d, #202020 stepping darker), so mostly lightness steps in dark and hues in light.
7. Light/dark: `light` theme and light-ansi variants exist, chosen by the user; no auto-detection of terminal background. Text contrast is hand-chosen per segment (light theme model fg #000000 on #87ceeb).
8. Glyphs: Nerd/powerline arrows; unicode symbols for icons (`⎇ ✱ ◷ §…`); `charset: "text"` for ASCII.
9. Other: TUI display style (`src/tui/renderer.ts`, box-drawing panels); bar styles; `icon-visibility.ts`; `bold` per segment.
10. Customisation: JSON config (`.claude-powerline.json`, `~/.claude/claude-powerline.json`), CLI flags (`--style`, `--theme`, …), env `NO_COLOR`, `FORCE_COLOR`, `TERM`, `COLORTERM`.

## claude-forge (cc-chips)
https://github.com/sangrokjung/claude-forge — stars 863
Note: the statusline is `cc-chips-custom/engine.sh` (178 lines) with theme `cc-chips-custom/themes/claude.sh`.
1. Fixed per chip by position. Four chips: left (cwd), mid (git branch, only in a repo), right (model/context bar/cost/session id), stats (cache %, API seconds). Each chip's bg/fg is a theme variable pair: `BG_LEFT/FG_LEFT_TEXT`, `BG_MID/FG_MID_TEXT`, `BG_RIGHT/FG_RIGHT_TEXT`, `BG_STATS/FG_STATS_TEXT` (themes/claude.sh). Claude theme values: left bg #1F1E1D text #C6613F (terracotta), mid white bg with #2E3440 text, right brown #8B5A2B with white text, stats green #2E7D32 with white. No threshold colouring seen in engine.sh.
2. Themes: engine reads `${SCRIPT_DIR}/themes/${CC_CHIPS_THEME:-claude}.sh`; header says `claude, cool, retro, cyber` but only `claude.sh` exists in the tree, so one bundled theme. Format = shell variables (a bg, a fg-matching-bg for the caps, and a text colour per chip). Users add a file.
3. Spec: truecolor `\033[38;2;R;G;Bm` / `\033[48;2;…m` only (themes/claude.sh). No detection; NO_COLOR not found. Note the comment says left chip bg #2D2E29 while the code is rgb(31,30,29), so the comment is stale.
4. Fill: both. Chips are background-filled with rounded caps.
5. Separators: none between chips (just a space); each chip has its own rounded caps U+E0B6/E0B4 printed in the chip's colour as fg (engine.sh L153-176: `${FG_X}${CAP_LEFT}`, content on `${BG_X}`, `${FG_X}${CAP_RIGHT}`).
6. Neighbours: chips contrast sharply (dark / white / brown / green), separated by a gap.
7. Light/dark: not present; text colour per chip is hand-picked (dark text on white chip).
8. Glyphs: Nerd Font icons (folder, github, branch, coins, key, bar-chart, bolt…) and caps; no ASCII fallback found.
9. Other: bold text on all chips.
10. Customisation: `CC_CHIPS_THEME` env + theme shell file.

## ccstatusline-zh
https://github.com/huangguang1999/ccstatusline-zh — stars 813
FORK OF sirmalloc/ccstatusline. The fork is a Chinese translation of the TUI; I diffed `src/utils/colors.ts`, `src/utils/renderer.ts`, `src/utils/powerline.ts`, `src/ccstatusline.ts` and `src/types/Settings.ts` against upstream and they are byte-identical (`diff -q` printed nothing). Styling differences from the parent: none found; README states it is synced to upstream v2.2.32 and only the UI language differs.

## ai-usagebar
https://github.com/akitaonrails/ai-usagebar — stars 721
not a Claude statusline: Waybar / Omarchy / GNOME / KDE / tray widget and ratatui TUI showing plan-usage quota for many AI providers (Claude, Codex, Copilot, Z.AI, …); ported from `claudebar`. Its theme code (`src/theme.rs`, one-dark) styles those widgets, not Claude Code's `statusLine`.

## cc-statusline
https://github.com/chongdashu/cc-statusline — stars 646
1. Fixed per segment, with state on context, session and (not on) cost. A generator emits a bash script. `src/features/colors.ts` L28-34 `generateBasicColors`: dir 256-idx 117 sky blue, model 147 light purple, version 180 soft yellow, claude-code version 249 grey, output style 245 grey. Git branch 150 soft green (`features/git.ts` L13). Usage: tokens `usage_color` 189 lavender, cost 222 light gold, burn rate 220 bright gold (`features/usage.ts` L14-17). State: context colour by remaining% (`generators/bash-generator.ts` L186-194): <=20 coral red 203, <=40 peach 215, else mint 158; session (5h) colour by remaining (`usage.ts` L18-23): <=10 pink 210, <=25 light yellow 228, else light green 194.
2. Themes: `theme: minimal | detailed | compact` is a layout/verbosity choice (prompts.ts L7, default 'detailed'). `getThemeColors` in colors.ts L63-88 defines per-theme named-colour maps but nothing imports it (grep finds only its definition), so they are dead code and colour does not vary by theme. No user themes.
3. Spec: 256-index (`38;5;N`) pastels, and some bold ANSI-16 (`1;37`). NO_COLOR honoured: `[ -n "$NO_COLOR" ] && use_color=0` (colors.ts L18). Colours can also be disabled at generation time. No depth detection.
4. Fill: foreground only.
5. Separators: two spaces between items on a line; no glyph separators.
6. Neighbours: pastel hue per role, emoji prefixes (🌿 🧠 ⌛ 💰 📊).
7. Light/dark: not present; pastels assume a dark terminal.
8. Glyphs: emoji by default; `customEmojis`/`config.colors` toggle emoji usage (bash-generator.ts L215); ASCII mode not found.
9. Other: progress bars `[====]` coloured like their value.
10. Customisation: interactive CLI wizard (`src/cli/prompts.ts`) -> generates `.claude/statusline.sh`; preview command (`src/cli/preview.ts`). Colour choices only on/off.

## claude-dashboard
https://github.com/uppinote20/claude-dashboard — stars 583
1. **A theme role mapped to segments, plus usage level.** `ThemeColors` (`scripts/utils/colors.ts` L14-42) defines roles: model, folder (directory name and cost), branch, safe, warning, danger, secondary, accent, info, barFilled, barEmpty, plus raw red/green/yellow/blue/magenta/cyan/white/gray. Widgets call `getTheme()` and use roles. Usage: `getColorForPercent` (L355-360) <=50 safe, <=80 warning, else danger.
2. Themes: 9 bundled (`THEMES`, colors.ts; documented `website/src/content/docs/guides/themes.md`): default (pastel 256-idx), minimal (monochrome white+grey), catppuccin (Mocha), catppuccinLatte (light), dracula, gruvbox, nord, tokyoNight, solarized. Format = semantic palette roles (above). User-defined themes: not present (config key `theme` selects only a bundled id, `~/.claude/claude-dashboard.local.json`).
3. Spec: `default` and `minimal` use ANSI-16 / 256-idx; the other seven use truecolor `38;2;R;G;B` with hex in comments. No depth detection and no downsampling; NO_COLOR: not found.
4. Fill: foreground only.
5. Separators: `pipe │` (default), `space`, `dot ·`, `arrow ›`, drawn in the theme's `dim` (`getSeparator`, colors.ts L383-396). Colour of separator = dim style, not a theme colour.
6. Neighbours: separators only plus different role colours (model blue/cyan, folder yellow, branch pink in default).
7. Light/dark: user picks `catppuccinLatte` for light terminals (documented as "light-mode terminals"); no automatic detection and no contrast function.
8. Glyphs: unicode `◆ │ · ›`; emoji in widgets; no ASCII mode found.
9. Other: display modes compact/normal/detailed (not colour); i18n; `scripts/mod/*` (Claude Code mod registration).
10. Customisation: JSON config `~/.claude/claude-dashboard.local.json` (`theme`, `separator`, `displayMode`, `language`, `plan`, `cache`); `/claude-dashboard:setup` commands.

## the-startup
https://github.com/rsmdt/the-startup — stars 569
Note: a multi-skill plugin; the statusline is `scripts/statusline.sh` with `scripts/statusline.toml`.
1. By state, otherwise uncoloured. Only context, cost and lines get colour. Constants (L27-31): DEFAULT rgb(250,250,250), MUTED (96,96,96), WARNING (255,184,0), DANGER (255,68,68), SUCCESS (136,204,136). `format_context` (L321-323): default colour, `>= warn` (70) warning, `>= danger` (90) danger, percent includes a 45k-token compaction buffer. Cost: success green, warning/danger by plan thresholds (L369-373; pro warn $1.50/danger $5, max5x $5/$15, max20x $10/$30, api $2/$10 per statusline.toml comments). Lines added `+` success, removed `-` danger (L391). Help text muted italic. Path, branch and model are plain text in the terminal's own foreground.
2. Themes: not present (the TOML holds thresholds and a `format` string, not colours).
3. Spec: truecolor `\033[38;2;R;G;Bm` only. No detection; NO_COLOR not found.
4. Fill: foreground only.
5. Separators: two spaces between placeholders (`format = "<path> <branch>  <model>  <context>…"`).
6. Neighbours: whitespace and emoji prefixes.
7. Light/dark: not present (MUTED 96,96,96 may be weak on dark, untested).
8. Glyphs: emoji (📁 🧠) and `⎇`; bar glyphs; no ASCII mode.
9. Other: 5-cell bar with 1/8-block resolution (L328ff).
10. Customisation: `~/.config/the-agentic-startup/statusline.toml`: `format` placeholders (`<path> <branch> <model> <context> <session> <lines> <spec> <help>`), `plan`, thresholds. No colour options.

## tmux-ide
https://github.com/wavyrai/tmux-ide — stars 555
not a Claude statusline: a tmux-based workspace/app for running a team of coding agents; the scanner hit its own TUI status bar (`packages/daemon/src/tui/chrome/statusline.ts`) and a large theme layer (catppuccin, dracula, gruvbox, nord, etc. in `packages/contracts/src/visual-theme-presets.ts`) that styles tmux-ide's UI, not Claude Code's `statusLine`. I did not read those files beyond the README.

## coralline
https://github.com/Nanako0129/coralline — stars 549
1. **Fixed per segment through theme variables, plus state on gauges.** Each segment's background is a variable `VL_BG_*` (statusline.sh L148-190): dir "81,166,199", git ok 65 / dirty 130, model 173, ctx 238, 5h 237, 7d 236, cost "212,125,145", clock "70,80,110", style 96, effort 141…; optional ones fall back to a related one (project -> dir, stash -> git ok, cache/toks/ttft -> ctx, node/python -> model). Text inks `VL_FG_TEXT/DIM/OK/WARN/HOT` (231/245/114/179/167). State: gauges colour by `pct_fg` (L1365-1371): `>= VL_HOT_PCT` (75) HOT ink, `>= VL_WARN_PCT` (50) WARN ink, else OK ink; git bg switches ok/dirty.
2. Themes: 10 bundled `.conf` files in `themes/` (claude-coral default, catppuccin-mocha, dracula, gruvbox-dark, lunar-pink, mono, morning-haze, nord, reverie, tokyo-night). Format = sourced bash variable files (per-segment `VL_BG_*`/`VL_FG_*`, not semantic roles); extra "candidate" variables `_VL_SUB_*` plus a palette fingerprint let the subagent-panel pill pick a readable ground (statusline.sh L247-270). Users author their own `~/.claude/coralline.conf` (sourced bash) or import powerlevel10k colours (`configure.sh --import-p10k`, reads `~/.p10k.zsh`); wizard offers live previews.
3. Spec: each colour is a 256-index or an `"R,G,B"` triple (`fg()`/`bg()`, L335-348). No depth detection. NO_COLOR: not honoured (only an internal `VL_NOCOLOR` used for the plain-text "float" readout, L83, L2583); `VL_ASCII=1` removes Nerd glyphs.
4. Fill: both. `VL_STYLE`: `pill` (powerline pills with backgrounds), `lean` (flat text; optional `VL_LEAN_BG` single uniform bar), `classic` (lean on a dark bar, p10k classic look).
5. Separators: pill style uses rounded caps U+E0B6 / U+E0B4 and arrow U+E0B0 (`VL_CAP_L/R/SEP`, L144-146); lean style has an optional text separator `VL_LEAN_SEP` and optional bevel caps `VL_LEAN_CAP_R/L` in the bar colour.
6. Neighbours: different bg per segment (hues) in pill style; the 5h/7d/ctx grounds are close dark greys (238/237/236) separated by caps.
7. Light/dark and contrast: partly. Comments (L90-100, L1851-1853) record contrast work: the light name pill washed out to 1.0:1 so the subagent name pill takes a dark ground and its own inks; "VL_FG_TEXT … reads dark on dark in seven of the ten themes" is handled per segment. Themes `morning-haze` suggests a light variant. No terminal-background detection found.
8. Glyphs: Nerd Font (powerline caps, `\xee\x9c\x98` node, python, tachometer…); `VL_ASCII=1` gives plain coloured blocks; the segment glyphs `⬡ ⬢ ⛁` are plain Unicode on purpose (comment L52-55: avoid wide-glyph misalignment).
9. Other: `VL_LAYOUT=auto` wraps by width; subagent panel rows (`--subagent`), float readout file; wizard (`configure.sh`, 1572 lines) with previews, screenshot renderer `tools/render-screenshots.py`.
10. Customisation: `~/.claude/coralline.conf` (bash), `configure.sh` wizard (`--wizard`, `--import-p10k`), many `VL_*` knobs (bar width, fill/empty glyph, warn/hot pct, clock, path depth).

## token-tracker
https://github.com/stormzhang/token-tracker — stars 533
1. **A theme role mapped to segments.** The statusline template (`src/token_tracker/templates/claude_statusline.py`) uses 13 ANSI keys baked in at install time by `themes.theme_to_statusline_ansi(theme)`; `_STATUSLINE_SLOTS` (ui/themes.py) maps key -> one of 9 base colours: project green, branch red, added green, deleted red, untracked mauve, label pink, bar_ok green, bar_warn yellow, bar_danger red, tokens peach, total red, duration blue, model blue. Bars use bar_ok/warn/danger by usage level. The CLI report separately derives 17 semantic slots from the same 9 (`derive_slots`: dim=overlay0, token=sapphire, cost=yellow, bar_low/mid/high=green/yellow/red, …). A comment admits the statusline roles intentionally differ from the CLI's.
2. Themes: 6 bundled (mocha, latte, frappe, macchiato, nord, dracula; `THEMES` in ui/themes.py), each = `is_light` flag + exactly 9 base colours (`overlay0 green yellow peach red blue sapphire mauve pink`) + `cell` colour and 5-step heat ramp (explicit for mocha/latte, else interpolated `cell` -> `green` by ratios 0, .2, .42, .65, 1.0). Semantic palette roles drive everything. Selection persisted via `config.resolve_theme()`; a user-defined theme: not found (themes are code), `preview_theme` context manager for previews.
3. Spec: truecolor `38;2` and a 256-colour approximation (`_hex_to_256`, nearest cube/grey). Depth: `COLORTERM in ("truecolor","24bit")` else 256 (template L16-17). 8-colour terminals deliberately unsupported (themes.py docstring). NO_COLOR: not found.
4. Fill: foreground only in the statusline.
5. Separators: items on a line joined by plain ` | ` (`" | ".join(line)`, template L278, L357); labels `Name:` prefixes.
6. Neighbours: role-based hues (project green, branch red, label pink, model blue).
7. Light/dark: `is_light` per theme plus Latte theme for light terminals; no auto-detect of terminal background for the statusline.
8. Glyphs: progress-bar block chars; Chinese/CJK width handling (`vlen` uses `east_asian_width`); no Nerd Font requirement seen.
9. Other: GitHub-style 5-level heatmap colouring for the CLI report (`heat_colors`).
10. Customisation: `tt theme` commands and setup wizard (`wizard.py`), config file, i18n (`i18n.py`); the template is re-baked on theme change (`update_hook`).

## claude-code-statusline
https://github.com/rz1989s/claude-code-statusline — stars 480
1. Fixed per component through 18 named palette slots, with state on a few. Components pick slot names (`lib/display.sh`): directory `CONFIG_BLUE` (L337), model `CONFIG_CYAN` (L77), commit count `CONFIG_TEAL` (L350), repo cost `CONFIG_GREEN` (L159), daily cost `CONFIG_TEAL` (L177), branch `CONFIG_GREEN` clean / `CONFIG_YELLOW` dirty (L91-94), MCP `CONFIG_RED` when failing/`YELLOW` partial (L200-214), Claude Code version `CONFIG_PURPLE`, statusline version `CONFIG_CYAN`, reset info `LIGHT_GRAY` italic, separators `CONFIG_DIM` (L311). The slot names are colours (RED, BLUE, GREEN, YELLOW, MAGENTA, CYAN, WHITE, ORANGE, LIGHT_ORANGE, LIGHT_GRAY, BRIGHT_GREEN, PURPLE, TEAL, GOLD, PINK_BRIGHT, INDIGO, VIOLET, LIGHT_BLUE) so a theme re-maps what "blue" means; the component-to-slot mapping stays fixed.
2. Themes: 4 bundled plus custom (`lib/themes.sh`: classic ANSI, garden pastel truecolor, catppuccin Mocha with hex comments, ocean). `custom` fills missing slots with ANSI defaults (`apply_custom_theme_defaults`). Format = shell variables of escape strings. **Theme inheritance** (base theme + overrides, `apply_inherited_theme`, L609-649) and **dynamic day/night theme** (`theme.dynamic.*` in `examples/Config.toml`: `day_theme`, `night_theme`, `day_start`, `night_start`, modes time / sunrise_sunset / prayer, `get_dynamic_theme` L474). Config in TOML; users define colours in config.
3. Spec: ANSI-16 (classic), 256 (a few `38;5;N`), and truecolor `38;2` for garden/catppuccin/ocean. No depth detection; NO_COLOR: not found in the files read.
4. Fill: foreground only.
5. Separators: `DISPLAY_SEPARATOR` text in `CONFIG_DIM` (`format_separator`, lib/display.sh L310-312).
6. Neighbours: hue per component and dim separators.
7. Light/dark: only the day/night auto-switch, which swaps whole themes by clock, sun or prayer time (`is_daytime_by_time/sun/prayer`); no terminal-background detection.
8. Glyphs: emoji heavy (scan: 188 emoji hits); `lib/components/prayer_icon.sh`.
9. Other: 1487 box/unicode glyph hits; multi-line (up to 9 lines via `CONFIG_LINE1_COMPONENTS`…); IDE plugin for neovim (`ide-plugins/neovim`).
10. Customisation: `Config.toml` (`examples/Config.toml`, 1144 lines), per-component `CONFIG_COMPONENT_<NAME>_<KEY>` options, `theme.*` keys, `bin/cli.js`.

## usage-pulse
https://github.com/NoobyGains/usage-pulse — stars 465
Note: a single 11096-line Python file, `claude_status.py`, driven by `config.json`.
1. **By usage level, via theme.** Each theme maps three levels low/mid/high to an ANSI code (`THEMES`, L113-124); bars and percentages pick the level by thresholds. Themes colour the bars; text colour is separate (`text_color: "auto"` -> `THEME_TEXT_DEFAULTS`, L529-545: "white" for most themes, "dim" for mono, "none" for rainbow). Colour is not assigned per segment type.
2. Themes: 10 bundled (README "10 themes, 5 animations, 8 bar styles, 5 sizes, 4 layouts and 48 widgets"): default (green/yellow/red), ocean (cyan/blue/magenta), sunset (yellow/orange208/red), mono, neon (bright green/yellow/red), pride (256 violet135/green49/pink199), frost, ember, candy, rainbow. Format = 3-slot level ramp, not semantic roles. User-defined theme: not found (a wizard selects among them; config `theme`).
3. Spec: ANSI-16 plus 256-idx (`\033[38;5;N`); rainbow animation uses RGB triples (`_ULTRATHINK_BASE`, L741-761, matching Claude Code's ultrathink colours). No depth detection; NO_COLOR: not found.
4. Fill: foreground only.
5. Separators: not found in the first-pass greps of the 11k-line file (only a ` · ` join at L8949 for panel rows); layouts standard/compact exist.
6. Neighbours: only the text-colour/bar-colour split; no per-segment hue.
7. Light/dark: `text_color` option; no detection.
8. Glyphs: 8 bar styles (classic `━ ─`, block `█ ░`, shade `▓ ░`, pipe, dot `● ○`, square, star `★ ☆`, braille gradient `⣀⣄⣤⣦⣶⣷⣿`, L46-64).
9. Other: **animation**: `animate` = off / rainbow / pulse / glow / shift with `animation_speed` (L895ff); rainbow shimmer per character via `_lerp_color` (L763) when Claude is processing, static rainbow when idle. Visual full-screen setup wizard with live previews.
10. Customisation: `config.json` (`theme`, `text_color`, `animate`, `bar_size`, `bar_style`, `layout`, `max_width`, `show.*` widget toggles, currency…), `/usage-pulse:setup` wizard, CLI flags (`--update`, full flag list in README).

# Batch 07: styling deep-read

Source files were fetched from raw.githubusercontent.com HEAD. Anchors are `path:line` in that repo.

## claude-mini-hud
https://github.com/zander-zyx/claude-mini-hud, 10 stars
1. By state/threshold, otherwise fixed per segment. `src/render.ts:48` `pctColor(pct)`: >= RED_PCT (env, default 80) red, >= YELLOW_PCT (default 60) yellow, else green; used for the context bar, usage windows and monthly %. Fixed: git branch green clean / yellow dirty (`render.ts:446`), ahead cyan, behind red (`:449-450`), cost and token usage cyan bold (`:370`, `:543`), running mark yellow, completed mark green (`:609`, `:621`), alerts red (`:502`), secondary text `c.gray` = SGR dim only.
2. No colour themes. `src/themes.ts` has 21 progress-bar GLYPH themes (default, neon, braille, hardcore, minimal, pixel, diamond, arrow, wave, tide, dot, target, gradient, shades, retro, ascii, rail, star, spark, heart, love) chosen with `CLAUDE_MINI_HUD_THEME`; `ThemeConfig` holds filled/empty chars, borders, separator, marks. `monochrome: true` (heart/love) disables the green/yellow/red colouring (`themes.ts:202,220`, `render.ts:49`). Users define their own only by editing `ThemeConfig` in source (README "自定义主题").
3. ANSI 16 only (`src/colors.ts:44-49`: 31-36 on dark, 91-96 on light). No 256/truecolor, no depth detection. `NO_COLOR` not present.
4. Foreground only (`colors.ts:51-63`); no backgrounds.
5. Plain-text separators: ` `, ` │ ` (hardcore), ` ┃ ` (minimal) per glyph theme (`themes.ts:126,142`). Not coloured separately.
6. Neighbours are separated by line (one row per fact), not by colour; distinct fixed hues per row (cyan cost/tokens, green/yellow git).
7. Yes, `colors.ts:22-41`: `detectLightBackground()` reads `CLAUDE_MINI_HUD_BG`, then `COLORFGBG` (bg 7, 8 or >= 15 = light), then `TERM_BACKGROUND_COLOR`; light terminals switch to the bright 91-96 codes. Grey is `dim` on the default foreground ("white+dim is near invisible on white", comment `colors.ts:60`).
8. Emoji and box glyphs; `CLAUDE_MINI_HUD_NO_EMOJI=1` forces ASCII marks (README env table). No Nerd Font. OSC 8 links (`colors.ts:62`).
9. `gradient`/`shades` themes cycle the glyph shade `█▓▒░` along the bar (glyph gradient, not colour). `CLAUDE_MINI_HUD_MARKS` picks the tool/agent mark glyph set independently of the bar theme.
10. Environment variables only (deliberate: "no config file", README ~449): LANG (zh/en/minimal/ultra-minimal), THEME, MARKS, LAYOUT (row names and order), COMPACT, RED_PCT, YELLOW_PCT, BG, NO_EMOJI, SHOW_* toggles.

## fuelgauge
https://github.com/adityaarakeri/fuelgauge, 9 stars
1. Fixed per segment plus threshold bars. `scripts/statusline.sh:60-62`: folder bold magenta, branch cyan in parens, model dim yellow. `make_bar` (`:45-49`): the bar and its % are `38;5;114` green below 70, `38;5;221` yellow at 70+, `38;5;203` red at 90+; same rule for ctx, 5h and 7d bars; label ("ctx", "5h", "7d") is dim.
2. Not present. No themes.
3. 16-colour for the fixed segments (`:9`), 256-index for the bars (`:46-48`). No detection, no `NO_COLOR`. (`scripts/statusline.ps1` is the Windows twin; not read in detail.)
4. Foreground only.
5. Plain ` │ ` in dim (`:59`).
6. Separator only, plus different hues per segment.
7. Not present (only `DIM`).
8. Block glyphs `█░`; no emoji or Nerd Font in the script.
9. Nothing else.
10. No config. Edit the script.

## claude-marketplace (atournayre, mlvn statusline plugin)
https://github.com/atournayre/claude-marketplace, 9 stars. Styling is in `mlvn/scripts/statusline/`.
1. Fixed per segment with state-driven bars. `src/lib/formatters.ts:17-51` `colors` object. Branch light grey, dirty `*` purple, `+N` green, `-N` red, staged `~N` grey, unstaged `~N` yellow (`:61-88`); path grey and model name in "peach" truecolor (`render-pure.ts:382-386`); sonnet name hidden by default. Progress bar `getProgressBarColor` (`formatters.ts:189-204`): "progressive" = grey below 50, yellow below 70, orange 208 below 90, red above; other modes pin a single colour. Pacing delta colour (`render-pure.ts:281-284`): > 5 green, > 0 light grey, > -10 yellow, else red. Labels `S:`/`L:`/`W:`/`D:` grey.
2. Not present as colour themes. `src/lib/presets.ts` has three layout presets (Minimal, Balanced, Full) that set features, not colours.
3. picocolors ANSI 16 forced on (`pc.createColors(true)`, `formatters.ts:15`, so `NO_COLOR` is ignored), plus raw 256 (`38;5;208`) and truecolor peach `38;2;222;115;86` (`:23-27`). No depth detection.
4. Mostly foreground. Progress-bar backgrounds are optional: `ProgressBarBackground` none/dark/gray/light/blue/purple/cyan/peach (`config-types.ts:23-31`, `formatters.ts:207-218`); default `none`.
5. Plain text, configurable glyph `|`, `•`, `·`, `⋅`, `●`, `◆`, `▪`, `▸`, `›`, `→` (`config-types.ts:1-11`), default `•`, drawn grey.
6. Separators only.
7. Not present; `black` and `white` bar colours are fixed truecolor.
8. Braille / filled / rectangle bar styles (`ProgressBarStyle`, default braille). No Nerd Font.
9. `peach` is the one brand-colour accent (model). Bar length 5/10/15.
10. JSON config `statusline.config.json` (defaults in `defaults.json`), typed in `config-types.ts`; presets via `applyPreset`.

## ccvitals
https://github.com/educlopez/ccvitals, 9 stars
1. By state/threshold and fixed role names. `statusline.sh:199-206` seven role colours (RED GREEN BLUE YELLOW CYAN GRAY MAGENTA). Fixed: model CYAN (`:2047`), branch YELLOW with GREEN `+` staged, YELLOW `~`, GRAY `?` (`:1262,1351-1353`), PR and agent CYAN, vim mode N green / I cyan / V yellow / VL magenta (`:933-937`), agents and mode MAGENTA, lines +/- GREEN/RED. Thresholds: context >= 90% RED plus warn icon (`:494-499`); 7d usage CYAN, >= 75 MAGENTA, >= 90 RED (`:814-816`); weekly CYAN, >= 50 YELLOW, >= 75 MAGENTA, >= 90 RED (`:974-977`); budget cost GRAY/YELLOW/RED.
2. Seven bundled: default, pastel, tokyo-night, catppuccin, dracula, nord, mono, plus `custom` (`:211-286`). Format: the same seven semantic role names remapped to hex (`hex_to_ansi`), not per-segment maps. User-defined: `theme: "custom"` with `colors.{red,green,blue,yellow,cyan,gray,magenta}` hex; missing keys keep default.
3. Default = ANSI 16 (`\033[0;31m` ... `0;90`, `0;95` for magenta). Themes switch to truecolor `38;2` (`:195`). Powerline default theme uses 256-index grays (`48;5;236/238`). No depth detection in `statusline.sh`. `NO_COLOR`: not in `statusline.sh` (the five hits are in asset/preview scripts).
4. Both. Normal mode is foreground only. `powerline: true` gives background-filled segments.
5. Plain-text default. Powerline: U+E0B0 or `powerline_separator` override (`:379-391`). Separator fg = previous segment's bg, bg = current segment's bg; final arrow on terminal default bg (`build_pl_line`, `:2079-2120`).
6. Powerline mode alternates two shades by index parity (`i % 2`, `:2091-2097`), shades chosen per theme as dark panel tones: e.g. catppuccin `49;50;68` / `69;71;90`, nord `59;66;82` / `67;76;94`, dracula alternates in reverse order, default/mono `236` / `238`. Non-powerline: separators only. Internal `\033[0m` resets are rewritten to re-assert the segment bg.
7. Not present for light/dark. `mono` theme is bold/white-grey only. Context-pressure alert is a state colour, not a contrast calculation.
8. Three icon sets (`icons: unicode|ascii|nerd`, `:290-352`), including ASCII fallbacks (`T:`, `[x]`, `#`/`-` bar). Nerd Font set for tools/agents/todos/ETA etc.
9. `smart` mode shows modules only when notable; `responsive` trims to `COLUMNS`; `module_order` array; PNG theme preview assets in `assets/`.
10. JSON `~/.claude/.statusline-config.json` (written by `/ccvitals:setup` and `/ccvitals:configure`); module toggles, module order, theme, icons, powerline, smart, responsive.

## claude-marketplace (FabienSalles, statusline plugin)
https://github.com/FabienSalles/claude-marketplace, 9 stars. Only `plugins/statusline/statusline.sh` (93 lines) is a statusline; the rest of the repo is a plugin marketplace plus verification scripts.
1. Fixed per segment with one threshold. `statusline.sh:39-91`: cwd blue (`34`), git branch and worktree yellow (`33`), model cyan (`36`), effort grey (`90`), context `ctx:N%` green below 50, yellow 50-79, red 80+ (`:61-68`), 5h limit magenta (`35`).
2. Not present.
3. ANSI 16 only. No detection, no `NO_COLOR`.
4. Foreground only.
5. Plain dim `|` between parts (`:91`).
6. Separators plus distinct hue per segment.
7. Not present.
8. Branch glyph (private-use or Nerd-style icon before the branch, `:43,45`); otherwise ASCII. No fallback mode.
9. Nothing else.
10. None; edit the script.

## ccbar
https://github.com/lakpriya1s/ccbar, 9 stars
1. By role and state. `bin/ccbar:69-110` `apply_theme` sets role variables: `C_MODEL`, `C_ARROW`, `C_DIR`, `C_ORG`, `C_BRACKET`, `C_LABEL`, `C_RESETTXT`, `BAR_LOW/MID/HIGH`, `E_LOW..E_MAX`. Bars switch LOW below 50, MID 50-79, HIGH 80+ (`:123-128`). Effort word coloured by level low/medium/high/xhigh/max (`E_*`, `:295-`). Burn-rate ETA warning uses `BAR_HIGH` (`:195`).
2. Three bundled: `default`, `mono` (white/grey with dim/bold weight only), `vivid` (bold 16-colour) (`:69-110`). Format: semantic role variables, per-theme. A `gallery` command lists six curated presets of theme + bar width + bar glyphs (`:810-817`). No user-defined colour themes; users choose the name in `CCBAR_THEME`.
3. ANSI 16 with bold/dim attributes only (`\033[1;32m`, `\033[2;37m`). No detection, no `NO_COLOR` found.
4. Foreground only.
5. Plain text: `->` arrow and `[ ]` brackets drawn in `C_ARROW` / `C_BRACKET` (dim grey).
6. Role colours and spacing; no separator chrome.
7. `mono` theme works by dim/normal/bold so it reads on either background. No detection.
8. Bar glyph pair user-chosen (`CCBAR_BAR_FILLED/EMPTY`: `█░`, `▓░`, `■□`, `=-`); a "Mono ascii" preset exists. Org badge text.
9. Interactive setup wizard (`ccbar config`), `gallery` preview with apply, `demo`, `stats`/`history` subcommands. Usage-burn ETA.
10. Plain `KEY="value"` shell file sourced at start (`load_config`, `:41-62`): CCBAR_THEME, ORG, BAR_WIDTH, BAR_FILLED/EMPTY, SHOW_EFFORT/CTX/5H/7D/OVERAGE/COST/BURN. `cli.js` is an npx installer wrapper.

## my-claude-hud
https://github.com/Link-Start/my-claude-hud, 9 stars. Rewrite inspired by jarrodwatts/claude-hud (README:16, "all code written from scratch"), so treated as its own project.
1. By state/threshold plus fixed role. `src/render/colors.ts:116-133`: context bar/value `contextLow` below 50, `contextMedium` 50-79, `contextHigh` 80-94 (orange), `contextCritical` 95+; quota bar `info` blue-ish below 75, `magenta` 75-89, `error` 90+. Fixed (`session-line.ts:51,110-113`): model `[name]` cyan, project path yellow, `git:(` `)` magenta around cyan branch, `project.ts:23` project cyan, warnings yellow / red.
2. Five bundled (`src/themes.ts:45+`): default, nord, dracula, monokai, solarized. Format: a 15-role `ThemeColors` object (contextLow/Medium/High/Critical, success, warning, error, info, magenta, cyan, yellow, green, red, dim, reset). User-defined: `theme.colorTheme` plus `theme.customColors` per-role overrides as `#hex` or raw ANSI (`parseCustomColors`, `themes.ts:~200`, example `.claude-hud.example.json`).
3. Default theme ANSI 16 plus 256 orange (`38;5;208`); other themes truecolor via `hexToAnsi`. No detection, no `NO_COLOR`.
4. Foreground only.
5. `showSeparators` option; `getSeparator` (`colors.ts:164-185`) styles `default` (space), `powerline` (` ` U+E0B0 / U+E0B1) and `arrow` (➤ ➢). Separators are uncoloured glyphs here (no bg/fg pairing), so powerline is a glyph, not filled segments.
6. Separator glyphs and per-role hue only.
7. Not present.
8. Emoji and block glyphs; powerline glyphs optional.
9. Alerts with configurable context warning/critical percentages; `lineLayout: compact` option.
10. JSON `.claude-hud.json` (`examples/.claude-hud.example.json`): lineLayout, showSeparators, theme.{colorTheme,customColors}, alerts, display.*.

## cctally
https://github.com/omrikais/cctally, 9 stars. A usage tracker; the statusline is `bin/_lib_statusline.py`.
1. By threshold only. `_lib_statusline.py:629-709`: three colours (green, yellow, red). Context segment: green below `context_low_threshold`, yellow below `context_medium_threshold`, else red (`:693-702`). 5h/7d segment uses max % in text: < 60 green, < 85 yellow, else red (`:647-657`). Model, cost, burn-rate segments uncoloured (burn can carry a visual indicator).
2. Not present.
3. ANSI 16 (`\033[32m/33m/31m`, `_ANSI`, `:630-634`). Colour decided by a resolution ladder in `bin/cctally` (`:2732-2767`): `--color` flag forces on, then tty check, then `NO_COLOR` env (any value) forces off.
4. Foreground only.
5. Plain ` | ` between segments (`:714`).
6. Separators and emoji lead each segment (💰 🔥 🧠).
7. Not present.
8. Emoji only (💰 🔥 🧠), no fallback mode.
9. Optional visual burn-rate indicator (`visual_burn_rate`).
10. CLI flags on the statusline subcommand (`--color`, thresholds, `--usage-only`, `--cost-source`, `--cctally-extensions`).

## cyberpunk-theme (statusline subpackage)
https://github.com/pablobfonseca/cyberpunk-theme, 9 stars. Mainly a Neovim / VS Code / tmux / Ghostty colour scheme; `statusline/` ships `@pablobfonseca/claude-cyberpunk-powerline`. Despite the name there are no filled powerline arrows.
1. Fixed per segment with state ramps. `statusline/lib/render.js:258-416`: separator ` │ ` in `fg_dim`; project bold `neon_blue`; model wrapped `⟨ ⟩` in bold `neon_pink` around bold `neon_cyan`; tokens `neon_yellow`; cost `neon_purple`; lines `+` green `-` pink; wall time cyan, API time dim; branch blue; vim mode NORMAL blue, INSERT green, else yellow; cache ratio >= 70 green, >= 40 yellow, else orange (`:357-359`); effort low cyan, medium green, high yellow, xhigh orange, max pink (`:370-374`); cron countdown < 1 min pink, < 5 min yellow, else cyan. Context bar (`:114-130`): < 50 cyan, < 70 green, < 85 yellow, < 95 orange, else pink.
2. Three bundled palettes, `storm`, `night`, `neon` (`statusline/lib/palettes.js`), each 8 semantic tokens (`neon_pink/cyan/green/purple/orange/blue/yellow`, `fg_dim`) as hex. Chosen by `--style=`. Not user-extensible without editing the file. The parent repo also has Neovim, VS Code, tmux, Ghostty, Starship palettes (not statusline).
3. Truecolor hex only (`render.js:25-29`, `38;2`). No detection, no `NO_COLOR`.
4. Foreground only.
5. Plain dim ` │ ` (`render.js:259`).
6. Different neon hue per segment; separators.
7. Not present; palettes are for dark terminals (`night` is dimmer, `storm` brightest).
8. Unicode only (`⟨ ⟩`, block bar).
9. Cyberpunk neon naming; optional segments via flags `--git --duration --cache --vim-mode --cron --effort`.
10. CLI flags in the statusline command (`--style=storm|night|neon`, feature flags). No config file.

## status-line-claude-code (PatrickJaiin)
https://github.com/PatrickJaiin/status-line-claude-code, 9 stars. Several script variants installed by curl; the "Classic" script is embedded base64 in `install.sh` (decoded and read).
1. By threshold for numbers, fixed for the rest. Classic: `color_for_pct` green below 50, yellow below 80, red above (decoded script ~`:103-110`) for CTX, 5h, 7d, fable bars; CPU, RAM thresholds 50/80, battery 30/15 (`:201-205,276-292`). Fixed: model CYAN, effort MAGENTA, cost MAGENTA, lines, duration, Spotify track, weather WHITE (`:376-379,408-469`). RogueDBear variant (`variants/roguedbear-statusline.sh:71-83`) adds ORANGE `38;5;208`, BLUE, DIM `90`; Pie variant replaces bars with ◔◑◕ gauge glyphs.
2. Not present; variants are separate scripts, not themes.
3. ANSI 16 (+ one 256 orange). No detection, no `NO_COLOR`.
4. Foreground only.
5. Two spaces between segments (Classic, `sep_w=2`); RogueDBear uses a three-column aligned layout.
6. Whitespace, hue per segment.
7. Not present.
8. Emoji and box glyphs, bar `█░`. Unicode only.
9. Touch Bar variant via Hammerspoon (`touchbar-hammerspoon.lua`); weather, Spotify and YouTube Music segments; battery/CPU/RAM; on/off toggle flag file; Codex variants.
10. Install-time variant choice only; edit the scripts. `~/.claude/statusline-off` toggle.

## claude-code-status-line (SaharCarmel)
https://github.com/SaharCarmel/claude-code-status-line, 9 stars
1. By state/threshold plus fixed. `statusline-haiku-summary.sh:303-311` context bar: green < 50, yellow < 75, orange (`38;5;208`) < 90, red; `limit_color` same four steps for rate-limit mini bars (`:342-352`). Fixed (`:404-415`): leading `➜` bold green, folder cyan, model yellow, shortcuts indicator yellow, reset times dim. PR chips coloured by CI/review state (`:230-246`): merged magenta `⇲`, closed dim `⊘`, draft dim `◐`, success green `✓`, failure red `✗`, pending yellow `⏳`; PR for the current branch is also bold; `CHANGES_REQUESTED` adds red `!`.
2. Not present.
3. ANSI 16 plus 256 orange. No detection, no `NO_COLOR`.
4. Foreground only.
5. Plain ` | ` (`:405-415`).
6. Separators plus hue.
7. Not present.
8. Emoji/Unicode marks; OSC 8 links on PR chips (`:246`).
9. Haiku-generated session summary in the script name; the PR chips are the notable styling.
10. Install script only; edit the script.

## claude-pulse
https://github.com/ali-nr/claude-pulse, 8 stars
1. By state and fixed role from one palette. `src/components/context.ts:24-39`: context bar `●●●○○` and % in green, yellow >= 70 (`warn`), peach >= 85 plus ⚠️ (`critical`), red >= 95 plus 🔴 (`danger`), thresholds configurable. Model by family (`model.ts:76-112`): Opus mauve, Sonnet blue, Haiku green, unknown text. Git branch teal; diff lines green / yellow / red (`git.ts:36-59`). Token arrows sky and peach, cache teal. Dim labels `overlay0`.
2. One bundled theme: Catppuccin Mocha (`src/themes/catppuccin.ts`, 26 named truecolor roles: rosewater ... crust plus reset/bold/dim). `config.theme` is a string (default `"catppuccin"`, `config.ts:28`) but only that one exists in the tree; no user-defined theme format.
3. Truecolor `38;2` only. No detection, no `NO_COLOR`.
4. Foreground only.
5. Configurable per-line separator strings (`LineOverrideSchema`, `schema.ts:262`) and optional `dividers` / `sectionSeparators` booleans. Plain text.
6. Fixed five-line layout (identity / git / engine / mcp / hooks / skills), so neighbours are distinct by line and hue.
7. Not present; Mocha assumes a dark terminal.
8. Emoji and `●○` glyphs, per-model icon `◆` configurable (`model.ts:72`).
9. Clickable components (`action: "/context"`), compact mode, reactive/interactive options.
10. JSON `~/.config/claude-pulse/config.json`, zod-validated (`src/schema.ts`), per-component `enabled/style/label/thresholds`; `/pulse-compact` command.

## claude-code-statusline (amazopic)
https://github.com/amazopic/claude-code-statusline, 8 stars
1. Per theme (themes are scripts). Default `statusline.sh:27-42` defines 256-colour bright/dim pairs (gold, green, yellow, red, blue, cyan, magenta, white). `pct_color` (`:51-57`): < 50 bright green, < 70 yellow, else red; dim variant for the unit; model gold, cost gold, tokens cyan, folder blue, separator grey `244`. Per-theme scripts reuse the pattern with other palettes; `rainbow` (`examples/statusline-rainbow.sh:29-44`) colours bar cell i with `GRADIENT=(196 202 208 220 226 154 46 51 39 129)`, so a gradient along the bar. The `cyberpunk` theme uses pink `201`, cyan `51`, yellow `227`.
2. 82 themes, each shipped in a detailed and a compact script (docs/js/themes.js:4-5; bundled into `statusline-bundle.sh`). Format: a whole script per theme with its own colour variables, so no shared semantic role map; the landing-page metadata gives each a 5-colour hex `palette` and a `vibe`. Includes `mono`/`zen` (no colour) and `muted`. Users compose a custom line from 26 blocks (`statusline custom <blocks>`).
3. 256-colour index (`38;5;N`) with bold; README says "256-color ANSI" and requires a 256-colour terminal (README:370). No detection; no `NO_COLOR` (0 hits in the bundle).
4. Foreground only.
5. Plain glyphs, dim `│` (`:44`) or per-theme (`·`, `//`, `▐`).
6. Whitespace/`│` separators, then bright digits vs dim units: two intensities of one hue within a segment.
7. Not present; a `muted` theme and grayscale `mono` exist.
8. Heavy emoji and themed glyphs (rocket/car/warning icon by usage, `pct_icon`); `zen` uses pure ASCII; bar styles `vertical` (8 sub-cells) and `quadrant`.
9. Themed gauge metaphors (HP/MP, fuel gauge, coffee level); rainbow gradient; landing page `docs/`.
10. CLI inside the bundle (`status-line.sh use <theme>`, `list [themes|compact|blocks]`, `custom <blocks>`); config `~/.claude/statusline.conf`; `/statusline` slash command; `refreshInterval: 30`.

## marmot
https://github.com/DrDroidLab/marmot, 8 stars. A session/cost monitoring tool (CLI, hooks, HTML dashboard); the statusline is `scripts/statusline.mjs`.
1. Minimal. `scripts/statusline.mjs:84-97`: cost bold (yellow when over the plan cap), prompt count yellow when over the first turn mark else dim, `ctx %`, `cache %` and model name dim, trailing yellow `▲` when over/manyTurns.
2. Not present.
3. ANSI 16 + dim/bold (`D`, `R`, `Y`, `B` at `:81`). The scanner's `NO_COLOR` hit is in the other modules, not read here: `unverified` for the statusline path.
4. Foreground only.
5. Dim ` · `.
6. Dim vs yellow emphasis only.
7. Dim attribute only.
8. `▲` only.
9. Rate-limit "in colour" is a separate dashboard feature (README:73), hex colours in `src/html.mjs`; not statusline.
10. Config in `src/config.mjs` (thresholds `session.costCap`, `session.turnMarks`), not styling.

## status-line (Elbhnasy)
https://github.com/Elbhnasy/status-line, 8 stars. An installer for statuslines of several agents (Claude, AGY, OpenCode, Hermes); the Claude one is `statuslines/claude/statusline.js`.
1. By threshold. `statusline.js:38-42` usage colour: < 50 green, < 75 yellow, < 90 orange (`38;5;208`), else red. Context bar (`:62-73`): < 50 green, < 65 yellow, < 80 orange, 80+ blinking red with 💀 (`\x1b[5m`). Dir, model plain; effort and task dim.
2. Not present.
3. ANSI 16 + 256 (orange, bar track `48;5;237`). No detection, no `NO_COLOR`.
4. Both: bar track is a background fill (`TRACK = \x1b[48;5;237m`, `:49-58`), filled cells are foreground blocks; text is foreground.
5. Plain ` │ ` (`:360-400`, `parts.join(' │ ')`).
6. Separators.
7. Grey track `237` chosen so empty cells never read as progress; no adaptation.
8. Block glyphs with eighth-cell partials `▏▎▍▌▋▊▉` (80 steps per 10-cell bar); 💀 at critical.
9. Blink at 80%+ context.
10. None for styling; installer CLI (`src/cli.js`) with manifest/plan.

## dashboard (gentry-tran)
https://github.com/gentry-tran/dashboard, 8 stars
1. By role per theme, with fixed segment-to-role assignment. `dashboard.sh:1046-1700`: `T_BORDER` frame, `T_TITLE` header, `T_ACCENT1` Cost / Uptime / account, `T_ACCENT2` CC version, session and week icons, `T_ACCENT3` Session/Week/CPU/Mem/Disk labels and city region, `T_ACCENT4` reset detail and Context label, `T_HIGHLIGHT` city, `T_BAR_SESSION` / `T_BAR_WEEK` / `T_BAR_CTX` fixed per bar (not threshold-driven). System CPU/Mem/Disk are the only threshold-coloured values: <= 33 `T_GREEN`, <= 66 `T_YELLOW`, else `T_RED` (`~:1460-1462`).
2. 25 case branches in `load_theme` (`:257-1036`): terminal-green, solarized, nord, cyberpunk, minimal, batman, iron-man, dbz, evangelion, ghost-in-shell, akira, spider-verse, blade-runner, one-piece, ghibli, rainforest, garden, terrarium, harvest (default), nebula, mythos, netrunner, and light, solarized-light, paper. Format: ~20 role variables per theme (BORDER, TITLE, LABEL, VALUE, HIGHLIGHT, ACCENT1-4, GREEN/YELLOW/RED, DIM, WEATHER, BAR_SESSION/WEEK/CTX) plus glyph variables (SEP, LINE_H, BAR_FILL/EMPTY, ICON_*, HEADER). Users add a theme by adding a case branch; no external theme file.
3. Truecolor `38;2;R;G;B` throughout (408 hits). No depth detection, no `NO_COLOR`.
4. Foreground only; the file comment says "FOREGROUND-ONLY and assumes a dark terminal" (`:418`), except the three light themes.
5. Box-drawing frame: `╔══` / `━━━━` headers and `│` separators per theme (`T_SEP`, `T_LINE_H`, `T_LINE_TOP`), coloured `T_BORDER`.
6. Distinct accent role per field type; border colour dimmer than values.
7. Yes: three light themes (light, solarized-light, paper) built "dark ink for a light page", with WCAG ratios stated in comments (`:417-455`). `check-contrast.py` computes WCAG contrast of every theme colour against two frames (#ffffff for light themes, #1e1e2e for dark): >= 4.5 body text, >= 3.0 information-bearing colours, borders and empty bar exempt.
8. Emoji (⏳ 📆 🧠) and per-theme ICON glyphs; bar glyph per theme (`#`/`.` in terminal-green, `█░` elsewhere); minimal theme has no frame.
9. Weather and location lines, usage-history logger, `make-screenshots.sh` (screenshot gallery), themed headers ("SECTION 9", "DASHBOARD").
10. `DASHBOARD_THEME` env, `--theme` flag, or config file; cache dirs and TTLs via `DASHBOARD_*` env.

## hallmonitor
https://github.com/hiteshbandhu/hallmonitor, 8 stars
not a Claude statusline: a session monitor for Claude Code / Codex / opencode (TUI board, macOS menu bar and notch, GPUI app) that also ships `hallmonitor statusline [--install] [--then '<your status line>']`. Its own statusline fallback (`cmd/hallmonitor/statusline.go:142-177`) is tiny: Claude-orange `✻` (`38;2;217;119;87`), model name, then `ctx`, `5h`, `7d` percentages coloured truecolor green (`74;222;128`), amber (`251;191;36`) at >= 50, red (`248;113;113`) at >= 80; dim ` · ` separators; no theme, no NO_COLOR. Gradient hits come from the TUI/launch-video code, not the statusline (not read).

## newsline
https://github.com/itdar/newsline, 8 stars
1. One colour for everything: the news headline. `statusline.sh:57-72` `NEWSLINE_COLOR` maps a name to an SGR code at print time (dim 2, gray 90, red 31 ... white 37, orange `38;5;208`) or accepts raw SGR params such as `38;5;245`; unset = terminal default. The click hint "(cmd+click)" is grey `90` (`:84,89`).
2. Not present. `newsline color` steps through default, gray, white, cyan, yellow, green, blue, magenta, red; `newsline colorlist` previews them (README:78-80).
3. ANSI 16 names, 256 orange, or raw SGR; no detection; no `NO_COLOR`.
4. Foreground only.
5. Not present (single line).
6. Not present.
7. Not present.
8. 📰 emoji prefix; OSC 8 headline link.
9. Rotating news headlines and a stock mode (`fetch_stock.py`).
10. `NEWSLINE_COLOR`, `NEWSLINE_CLICKHINT` env and the `newsline` CLI.

## ccstatus
https://github.com/moonD4rk/ccstatus, 8 stars
1. Per-widget default colour, overridable, plus thresholds. `internal/config/config.go:43-86` defaults: model cyan, effort cyan, context-percentage brightBlack, git-branch magenta, git-worktree brightBlack, lines-added green, lines-removed red, session-cost green, current-working-dir blue, rate-limits white, session-clock white. Each widget type also supplies its own `DefaultColor()` and optional data-dependent `DefaultColorFor(ctx)` (`render.go:301-322`). `thresholds: [{gte, color, backgroundColor, bold}]` restyle a numeric widget; the highest `gte` reached wins (`widget.go:25-45`). Context scale (README:190): grey below 30%, white from 30, yellow from 60, red from 90; rate limits a shade brighter (white then brightWhite from 30). Resolution order (`render.go:271-295`): threshold, then widget `color`, then separator inherit, then type default; then global override.
2. Not present as bundled themes. Colours are named per widget in `settings.json`. Global `overrideForegroundColor` / `overrideBackgroundColor` force one colour everywhere.
3. 16 named colours only: black, red, green, yellow, blue, magenta, cyan, white and bright variants (`internal/color/color.go:21-39`), via fatih/color. `colorLevel` 0 disables colour, 1-3 all give ANSI-16 (README:238). No truecolor or 256, no autodetect, no `NO_COLOR` found.
4. Both: `color` (fg) and `backgroundColor` (bg) per widget, bg derived as fg code + 10 (`color.go:34,61-66`). Defaults are foreground only.
5. A `separator` widget with a `character` of the user's choice, and `flex-separator` that expands to fill width; `inheritSeparatorColors` makes a separator take the preceding widget's colour (`render.go:283-296`). `merge` joins widgets with no padding.
6. Whatever the user configures; defaults use hue per widget and separators.
7. Not present.
8. Prefix/suffix strings per widget; emoji/unicode defaults; no Nerd Font handling.
9. `ccstatus validate` checks colour names including threshold and override colours; `preview` and `widgets` commands.
10. JSON `settings.json` (widget list with id, type, color, backgroundColor, bold, prefix, suffix, rawValue, maxWidth, thresholds, merge), CLI `init/install/preview/validate/widgets/dump`.

## tmux-og
https://github.com/noamsto/tmux-og, 8 stars
not a Claude statusline: a Nix-packaged tmux distribution (Catppuccin Mocha) whose status line shows Claude Code / Codex / Pi / OpenCode session state via tmux `#[fg=#rrggbb]` styles, not Claude Code's own statusLine. Colour by agent state from a Catppuccin palette (`picker/statusline/claude.go:14-50`): waiting peach, compacting sky, processing teal, done green, idle overlay0, error red, denied yellow; a light variant uses Latte hexes; idle state fades toward the dim hue (`fadeHex`, `:56-85`); usage % coloured by tiers at 70 and 90 (`usage.go:183-190`). Nerd Font window icons.

## frank-claude-cockpit
https://github.com/Nongfsq/frank-claude-cockpit, 8 stars
not a Claude statusline: two Claude Code mods (Ink/React `register.tsx`): `context-card` (a line above the prompt) and `pr-pane` (a side pane). Notable for colour: it uses Claude Code's own theme KEYS, not hex, so colours follow light/dark/ANSI themes: `fillColor` `claude` (terracotta) below 60%, `warning` 60-79, `error` 80+; `limitColor` `suggestion` (blue) below 75, `warning` 75-89, `error` 90+ (`context-card/hooks/register.tsx:111-115`). The context-breakdown bar takes each slice's colour from `/context`'s own row colours (`:85-86,311`). `pr-pane` maps PR state to `success` / `warning` / `error` (`pr-pane/hooks/register.tsx:27-29`) and uses `dimColor` for secondary text.

## claude-code-mods (ronanworks)
https://github.com/ronanworks/claude-code-mods, 8 stars
not a Claude statusline: Claude Code mods (`usage-hud`, `html-shelf`); `usage-hud` draws an animated pixel-crab strip above the prompt and a usage panel below it (`usage-hud/hooks/register.tsx`). Colour: fixed `ACCENT #d97757` and `VIOLET #a78bfa`; effort word by level low `#a1a1aa`, medium `#60a5fa`, high `#fbbf24`, xhigh `#fb923c`, max `#f87171` (`:298-304`); percentages use a continuous green `#4ade80`, yellow `#fbbf24`, red `#f87171` interpolation `heat(t)` (`:307+`, `:552,590`), bars are lit up to the fill with the same heat gradient along the bar and an empty `TRACK` colour. Truecolor hex via Ink `color=`.

## claude-rich-terminal
https://github.com/xiaolai/claude-rich-terminal, 8 stars. Statusline is `statusline/scripts/rich-status.sh` (bash, truecolor powerline); `hooks/statusline.ts` is the `/rich status` controller.
1. Fixed role colour per segment plus gradient background by position. `rich-status.sh:100-110` foreground "color = meaning" table (R;G;B): account `208;135;112`, dir `136;192;208`, model `197;168;216`, effort `150;140;185`, clean branch `163;190;140`, dirty `236;196;135`, ahead/behind green/amber, cost `235;203;139`, time `154;165;196`, add/del green/red. Gauges via `gauge_fg` (`:117-121`): < 60 `LO_FG` green, 60-84 `MID_FG` amber, >= 85 `HI_FG` red.
2. Four background gradients ("themes"): gray (default), aurora, sunset, forest, each a start and end RGB (`:95-100`, e.g. aurora `#1e2a4a` to `#52304f`); foregrounds are the same for all (tuned for dark). Set with `THEME`; no user-defined theme beyond editing the case table.
3. Truecolor (`38;2` / `48;2`) only. Comment line 2: "Ghostty / 24-bit". No depth detection; `NO_COLOR`: not present.
4. Both: `STYLE=powerline` fills segment backgrounds; `STYLE=plain` is foreground only with dim `>` (`:9-10,412-415`).
5. Powerline: solid U+E0B0 (`SEP=$'\356\202\260'`, `:112`); separator fg = this segment's bg, bg = next segment's bg; last arrow on the terminal bg (`:424-430`). Plain: dim `>` in `SEP_DIM 96;104;122`.
6. Positional gradient: segment i of m gets `lerp(start, end, i*100/(m-1))` per channel (`render_row`, `:416-423`), so neighbours differ by a small lightness/hue step along the row; text colour is the same for every segment.
7. Foregrounds are tuned for dark and fixed; backgrounds are dark. No light adaptation (the plain style comment says "colors tuned for dark terminals").
8. Powerline arrows need a Nerd/Powerline font; `ICONS=nerd|unicode` for the weather glyph (`:343-357`), forecast icon coloured by rate.
9. "Token Weather" forecast icon led by usage, `/rich status` live controller (theme, style, lines 1/2/3/auto, toggle, hide, bar, weather, icons), multi-line grouping with width-based fit, `HIDDEN`.
10. State file `~/.claude/rich-status.state` read via one schema (`rich-status-lib.sh:25-37`: THEME, STYLE, LINES, HIDDEN, SHOW_BAR, SHOW_ACCOUNT, SHOW_RESET, SHOW_WEATHER, ICONS), edited with `/rich status ...`.

## vde-tmux
https://github.com/yuki-yano/vde-tmux, 8 stars
not a Claude statusline: a Rust tool that tracks Claude Code / Codex / opencode panes and renders agent state into the tmux status line and a ratatui sidebar. Colour by agent state (Blocked, Limited, Working, Done, Idle) through `SidebarRenderTheme` badge colours (`src/sidebar/render/theme.rs:19-50`), configurable per theme; fixed agent colours Claude `Rgb(127,166,195)`, Codex `Rgb(169,142,210)`; the sidebar header can use powerline arrows (U+E0B0, `theme.rs:10`); tmux statusline output uses `#[fg=...]` ranges.

## claude-recall
https://github.com/dkstm95/claude-recall, 7 stars
1. Fixed role per element, plus a per-session accent chosen by hash. `src/config.ts:79-90` `colorTheme()` maps a palette to roles: focus bold cyan, branch cyan, model yellow, worktree purple, prompt bold text, dim, green/yellow/red for gauges. Gauge colours (`src/format.ts:221-229,261`): green below `th.yellow`, yellow from it, red from `th.red` (configurable thresholds). The line prefix `▍` takes `sessionColor(cwd, branch, accents)` (`format.ts:113-120,552-556`): a string hash of `cwd:branch` picks one of six accents (cyan, purple, blue, yellow, green, red), so each session/branch gets a stable identity colour.
2. Four bundled (`config.ts:11,92-113`): `default` (Tokyo Night Storm hexes), `minimal` (SGR dim/bold only, one accent), `vivid` (bright 16-colour 90-96), `light` (hexes tuned for light terminals, e.g. text `#343b58`, red `#b83251`). Format: the same 8-colour palette (text, dim, cyan, purple, blue, yellow, green, red) mapped to named roles. Users select by `theme` in config; no custom palette format.
3. Default and light use truecolor `38;2` fixed foregrounds ("independent of the terminal's 16-color palette", `config.ts:73-74`); vivid uses ANSI 16 bright codes; minimal uses SGR attributes. `NO_COLOR` honoured: any value returns a no-colour theme (`config.ts:137-143`, README:132). No depth detection.
4. Foreground only ("The terminal still owns its background").
5. Plain, configurable `separator` string drawn dim (`format.ts:146-149`); empty string turns off the column grid (`gridOn`).
6. Separators plus the left accent bar; right-zone cells padded to a min width of 10 for stable columns (`CELL_MIN_WIDTH`).
7. Yes: when `theme` is omitted and `COLORFGBG` is exported, `light` is auto-selected for bg 7 or 15, `default` otherwise (README:131). Explicit `theme` wins.
8. Unicode only (`▍`, `│`); no emoji/Nerd.
9. AI-refined "focus" label from a background Haiku call, 3-line layout (identity / focus+prompt / gauges), width-aware compaction ladder.
10. JSON `~/.claude/claude-recall/config.json` (honours `CLAUDE_CONFIG_DIR`): theme, separator, widthReserve, line3, thresholds.

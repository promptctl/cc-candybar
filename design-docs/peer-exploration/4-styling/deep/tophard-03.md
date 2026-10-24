## texmeijin/claude-code-mascot-statusline
https://github.com/TeXmeijin/claude-code-mascot-statusline  (31 stars)
1. Colour source: the mascot is a pixel sprite whose cells come from a pack palette; text extras are uncoloured except usage. `src/lib/renderer.ts:18-43` `applyContextHeatPalette` is a threshold rule: above 60% context, palette index 2 (`HEAT_PALETTE_INDEX`) is lerped toward `#ff4444`, reaching full at 85%. `colorizeByHeat` (`renderer.ts:548`) does the same for the `5h:`/`7w:` text, from grey `0xcc` to red over 60-85%. Branch, model, project, ctx and tools text carry no colour (`summarizeState`, `renderer.ts:160-241`, joined with plain ` | `).
2. Themes: "packs" (sprite packs: `pixel-buddy` default, `space-invader`), not colour themes. Pack format is `pack.json`/`pack.yaml` carrying a palette and sprite frames (`renderer.ts` `PaletteColor[]`). Users can write their own (`~/.claude-mascot/packs/`, `.claude/mascot-packs/`); README plus `src/cli/validate-pack.ts`.
3. Spec/depth: truecolor only, `\u001b[38;2;r;g;bm` / `48;2` (`renderer.ts:526-535`). No downsampling. `src/lib/terminal.ts` `shouldUseColor`: config `color: auto|always|never`; auto honours `NO_COLOR`, `TERM=dumb`, and `CLAUDE_MASCOT_FORCE_COLOR=1`.
4. Fill: sprite cells are background-filled (`bgColor` + a cell char) or half-blocks `▀`/`▄` with fg+bg (`renderHalfBlockCell`, `renderer.ts:485-508`). Text is foreground only.
5. Separators: plain ` | ` text, uncoloured (`full: [base, ...extras].join(" | ")`, `renderer.ts:241`). Not present as caps/arrows.
6. Neighbours: separators only; text is monochrome.
7. Adaptation: `renderProfile: "claude-code-safe"` with `safeBackground` (`#000000`) replaces transparent cells with a coloured NBSP (`renderHalfBlockSafeCell`, `renderer.ts:512-523`) so the sprite does not depend on the terminal background. No text-contrast logic.
8. Glyphs: half-block characters, `⎇` for branch, `…` truncation. No Nerd Font. No ASCII mode other than `color: never`.
9. Other: 9 mascot states animate through frame periods (`src/lib/constants.ts` `DEFAULT_TIMINGS`, 250-1200 ms); sprite fur reddens as context rises; storybook and preview-pack CLIs (`src/cli/storybook.ts`, `preview-pack.ts`); screenshots in `docs/`.
10. Customisation: JSON config `~/.claude/plugins/claude-code-mascot-statusline/config.json` or `.claude/mascot.json` (`pack`, `color`, `twoLine`, `renderProfile`, `safeBackground`, `summaryItems`); env `CLAUDE_MASCOT_HOME`, `CLAUDE_MASCOT_WIDTH_HINT`, `CLAUDE_MASCOT_FORCE_COLOR`.

## allthingsclaude/bar
https://github.com/allthingsclaude/bar  (29 stars)
1. Colour source: one brand hue family, mostly fixed per segment. `src/colors.js:3-9` defines `BRAND #D97757`, `BRAND_DARK #B85A3A`, `BRAND_LIGHT #F0C4AE`, `BRAND_LIGHTER #F5D9CB`, `TRACK`, `DIM`. `src/render.js:86-114`: model name, "Session" label, project and branch icon are `BRAND`; counts/countdown `DIM`; `+N` lines `BRAND_LIGHT`, `-N` lines `BRAND_DARK`. State-driven part: `intensityColor(pct)` (`colors.js:11-16`) picks lightness by threshold: >=75 DARK, >=50 BRAND, >=25 LIGHT, else LIGHTER, used for bar fill and the percentage. So "intensity" is a single-hue lightness ramp, not green/yellow/red.
2. Themes: not present (one hard-coded palette).
3. Spec/depth: truecolor fg only (`\x1b[38;2;r;g;bm`, `colors.js`). No detection, no downsampling, no NO_COLOR.
4. Fill: foreground only. Bar is `█` filled in intensity colour and `░` in `TRACK` (`render.js:30-39`).
5. Separators: plain ` │ ` in `DIM` (`render.js:20`).
6. Neighbours: separators only; same brand hue throughout.
7. Adaptation: none; colours are mid-tone fixed values, `BRAND_LIGHTER` would be weak on a light background.
8. Glyphs: box/block chars, `⎇`, `𖠰` (Runic-range glyph, `render.js:109`). No Nerd Font, no ASCII mode.
9. Other: README says "Progress bars shift from dim to bright as usage increases". Web screenshot asset `assets/bar.webp`.
10. Customisation: `~/.bar/config.json` toggles only the three lines (`lines.context/session/git`, `src/config.js`); colours not configurable. Setup wizard (`src/setup.js`, `src/prompts.js`).

## boyand/cc-budget
https://github.com/boyand/cc-budget  (29 stars)
1. Colour source: by threshold plus a few fixed accents. `lib/format.cjs:20-30`: `colorForPct` (>=90 bright red, >=70 yellow, else green) colours the 5h/7d label, bar and percent; `colorForCost` (config `warn_cost_usd` 5, `critical_cost_usd` 20) for session cost. Fixed: `FABLE_TAG` yellow, peak marker `▲` bright red bold + yellow "peak", off-peak `▽` green, pace delta `⇡` red / `⇣` green / "on pace" dim (`format.cjs:~47-52`, `formatStatusLine`). Everything secondary `DIM`.
2. Themes: not present. Config has thresholds only (`lib/config.cjs` DEFAULTS).
3. Spec/depth: ANSI 16 names only (`\x1b[32m` etc., `format.cjs:4-11`). No detection, no NO_COLOR.
4. Fill: foreground only.
5. Separators: ` │ ` in `DIM` (`SEP`, `format.cjs`).
6. Neighbours: separators only; sections colour by their own state.
7. Adaptation: none. Uses `DIM` and avoids hex.
8. Glyphs: `▓`/`░` bar, `│` pace marker, `⇡⇣`, `➞`, `▲▽`. No Nerd Font; no ASCII mode.
9. Other: pace marker drawn inside the bar in bold white (`progressBar`, `format.cjs:~35-50`); also exports `formatWidget` for embedding in ccstatusline; a VS Code extension is in the repo.
10. Customisation: JSON `~/.config/cc-budget/config.json` (`thresholds`, `peak`, `show_delta`, `show_7d`, `enterprise_discount`); no colour keys.

## field-logic-ltd/claudestatsbar
https://github.com/Field-Logic-Ltd/ClaudeStatsBar  (29 stars)
1. Colour source: by state plus fixed per segment. `statsbar.py:31-38` constants: GREEN 256-78, AMBER 214, RED 203, BLUE 110, GREY 245. Fixed: model BLUE, project DIM, turn count and cost GREY, cache-miss warning AMBER (`statsbar.py:169-239`). Thresholds: context `GREEN if ctx<WARN else AMBER if ctx<HIGH else RED` (line 176; `CC_CTX_WARN`/`CC_CTX_HIGH`), rate limits green<50, amber<80, else red (line 210), forced RED when burn<15 turns left (line 220). Warning line RED or AMBER (line 244).
2. Themes: not present.
3. Spec/depth: 256-colour indices. `NO_COLOR` honoured (`statsbar.py:27`, `c()` at line 42 returns plain text). No truecolor, no downsampling.
4. Fill: foreground only.
5. Separators: ` · ` in GREY (`statsbar.py:242`).
6. Neighbours: separators plus differing hues (BLUE model, state-coloured context, AMBER warnings).
7. Adaptation: 256-colour mid-tones, nothing adaptive.
8. Glyphs: small bar via `bar()`, `⚠`, `↻`, `×`. Emoji count 2 per scan, none structural. No Nerd Font.
9. Other: per-turn cache re-read cost shown with the context colour; second line prints a long advisory in RED/AMBER when context is high.
10. Customisation: env vars `CC_CTX_WARN`, `CC_CTX_HIGH`, `CC_CTX_FULL_PCT`, `CC_SHOW_COST`, `NO_COLOR` (header comment `statsbar.py:257`). No config file for colours.

## rathi-prashant/claude-code-terminal-pro
https://github.com/rathi-prashant/claude-code-terminal-pro  (29 stars)
1. Colour source: fixed per segment, self-described "Gruvbox Dark" (`scripts/status-line.sh:3,17-25`). Model `#56B6C2` teal, bar brackets `#665C54`, empty bar `#32302F`, filled bar `#8EC07C`, percentage `#FBF1C7`, token budget `#E0AF68`, git branch `#8FAFD1`, directory `#98C379`. Several of these are not actual Gruvbox values, so the label is loose. No state or threshold colouring: filled bar stays aqua at any percentage (lines 55-76).
2. Themes: one hard-coded palette in script variables; no bundled alternatives; edit the script to change.
3. Spec/depth: truecolor fg only (`\033[38;2;r;g;bm`). No detection, no NO_COLOR.
4. Fill: foreground only.
5. Separators: plain ` | ` text (lines 76-99), uncoloured in the printf.
6. Neighbours: different fixed hues per segment.
7. Adaptation: none; colours assume a dark background (empty-bar `#32302F` is near-invisible on light).
8. Glyphs: `✦` model, `■`/`□` bar (20 segments of 5%), `↯` tokens, `◆` directory, `⎇` branch (lines 41-99). No Nerd Font. Comment lists alternative bar glyph options (`▰▱`, `━─`).
9. Other: nothing beyond the script; 20-segment bar.
10. Customisation: edit the bash script; no config, flags or env.

## xyzbit/claude-plugins (claude-hud)
https://github.com/xyzbit/claude-plugins  (29 stars). Contains a copy of the `claude-hud` statusline plugin (`claude-hud/`).
1. Colour source: by role and by threshold. `claude-hud/src/render/colors.ts`: `getContextColor` (>=85 red, >=70 yellow, else green) for context bar and percent; `getQuotaColor` (>=90 red, >=75 bright magenta, else bright blue) for usage bar. Fixed per segment (`render/lines/project.ts`): model `[...]` cyan, project path yellow, `git:(` `)` magenta around branch in cyan (a zsh-theme look), `API` billing label red. Agents line (`agents-line.ts`): running `◐` yellow, done `✓` green, agent type magenta, model/description dim. Labels ("Context", "Usage") `dim`.
2. Themes: not present.
3. Spec/depth: ANSI 16 only (`\x1b[31m`..`36m`, `94m`, `95m`, `2m`; `colors.ts:1-9`). No detection, no NO_COLOR.
4. Fill: foreground only. Bars are `█` in colour and `░` in `DIM` (`coloredBar`, `quotaBar`).
5. Separators: plain ` │ ` (`project.ts` join); config `showSeparators` toggles extra separator lines.
6. Neighbours: different ANSI hues per segment; separators.
7. Adaptation: relies on the terminal's own 16-colour palette, which adapts to light/dark themes automatically; no explicit contrast logic.
8. Glyphs: `█░`, `◐`, `✓`, `⚠`, `↑↓`, git status marks `!+✘?`. No Nerd Font.
9. Other: multi-line layout (`lineLayout: compact|expanded`); tools/agents/todos lines; dev-engine line.
10. Customisation: JSON `config.json` in the plugin dir (`src/config.ts` `HudConfig`: `lineLayout`, `showSeparators`, `pathLevels`, `gitStatus.*`, `display.*` toggles and thresholds). No colour keys.

## jrykn/save-buddy
https://github.com/jrykn/save-buddy  (28 stars)
1. Colour source: a companion-pet statusline wrapper; colour is by pet rarity. `server/types.js:62-83`: `RARITY_HEX` common 220,220,220; uncommon 40,255,130; rare 70,170,255; epic 210,160,255; legendary 255,230,50, with matching 256 (`RARITY_256`: 255/48/75/141/227) and 16 (`RARITY_16`: 97/92/94/95/93) tables. Sprite, speech-bubble borders and the name/stars take the rarity colour (`buddy-hud-wrapper.js:styleBubbleLines`, `server/ansi.js:colorize`). Colours are "brightened ~1.7x" (comment in `types.js:57`) to compensate for Claude Code dimming. The wrapped existing statusline's output is passed through unchanged.
2. Themes: not present; rarity table is the only palette.
3. Spec/depth: best in this batch. `server/ansi.js:detectColorLevel`: 0 for `NO_COLOR` or `TERM=dumb`; `FORCE_COLOR` 0-3; `COLORTERM` truecolor/24bit = 3; `WT_SESSION`, iTerm, Apple Terminal = 3; `TERM` containing `256color` = 2; else 1. Each colour has truecolor / 256 / 16 variants (`colorize`, `colorRGB`).
4. Fill: foreground only.
5. Separators: not applicable (sprite plus bubble block box-drawn `│ ─`, line borders in rarity colour).
6. Neighbours: not applicable.
7. Adaptation: `dim` and `italic` used for fading bubbles (`styleBubbleLines`); brightening for dark UI; no light-terminal logic.
8. Glyphs: ASCII-art sprites (`server/sprites.js`), box-drawing bubbles, hearts `♥`; emoji in other files.
9. Other: animation via 1-second refresh (installer sets `refreshInterval: 1`), idle sequence blinks (`IDLE_SEQUENCE`), pet hearts, bubble fade-out by age (`getReaction` 10 s).
10. Customisation: install/uninstall CLI; no style config; env `NO_COLOR`, `FORCE_COLOR`, `COLORTERM`.

## vbcherepanov/claude-statusbar
https://github.com/vbcherepanov/claude-statusbar  (28 stars)
1. Colour source: by threshold plus fixed per segment (`statusline.sh`, 16-colour escapes). Context colour: >=90 red, >=70 yellow, else green (lines 220-224). Rate-limit bars by *remaining*: >50 green, >20 yellow, else red (lines 338-344). Effort suffix by level: low green, medium yellow, high red, xhigh bright red `91m`, max bold red (lines 365-376). Fixed: model bold cyan, tokens `↓` green / `↑` magenta, cost yellow, duration blue `⏱`, lines `+` green `-` red, git branch magenta `⎇`, vim `[N]` blue `[I]` green, agent cyan, `>200K` red (lines 381-398).
2. Themes: not present.
3. Spec/depth: ANSI 16 only; no detection, no NO_COLOR.
4. Fill: foreground only; bars `█`/`░` coloured by state.
5. Separators: ` | ` in `\033[2m` dim (line 363).
6. Neighbours: distinct hue per metric (cyan model, yellow cost, blue time, magenta branch).
7. Adaptation: relies on terminal's 16-colour palette; no contrast logic.
8. Glyphs: `█░`, `⎇`, `⏱`, `↓↑`, emoji `🤖` `📂`.
9. Other: sound/alert notifications by level in the same script (`critical`/`warning`, mac `Sosumi`/`Glass`); compaction window counter.
10. Customisation: env vars (`STATUSLINE_WINDOW_COUNTER=0` etc., help text near line 129-138); no colour config.

## ventuss-ovo/cc-costline
https://github.com/Ventuss-OvO/cc-costline  (28 stars)
1. Colour source: by threshold plus fixed per role (`src/statusline.ts:16-26`). `ctxColor` (line 41): >=80 red 167, >=60 orange 208, else green 29; used for context % and for the 5h and 7d usage numbers. Fixed: cost and period-cost segments yellow `#E5C07B` truecolor, model `#CA7C5E` (Claude orange, truecolor), separators `·` dim-grey 102, `/` grey 245. `rankColor` (line 79): rank 1 yellow, 2 white, 3 orange, else cyan.
2. Themes: not present.
3. Spec/depth: mix of 256 indices and a few truecolor values. No detection, no NO_COLOR.
4. Fill: foreground only.
5. Separators: grey `·` within a group and grey `/` between groups (lines 180-231).
6. Neighbours: separators, with fixed model/cost hues distinct from state hues.
7. Adaptation: none. Comment says colours match "original statusline.sh".
8. Glyphs: plain text labels `5h:` `7d:` `30d:`; no icons beyond `#`. 7 emoji hits are in other modules.
9. Other: countdown format `-HH:MM`; ccclub rank segment.
10. Customisation: JSON config (`period`: 7d/30d/both) via `src/cli.ts`; no colour keys.

## hell0github/claude-statusline
https://github.com/hell0github/claude-statusline  (27 stars)
1. Colour source: by state layer, with colours as named config roles. `src/statusline.sh:131-137` requires `colors.{orange,bright_orange,dim_orange,red,dim_red,pink,dim_pink,bright_pink,green,dim_green,purple,cyan,dim_blue,reset}` in `config.json`; defaults at lines 287-300 (e.g. `orange '\033[1;93m'`, `bright_orange 38;5;208`, `pink 38;5;225`, `green 38;5;194`). Layered thresholds: the 5h cost bar has 3 layers (default green/orange/red, `threshold_multiplier` 0.3/0.5/1.0), daily 2 layers (green/bright_orange), context 3 layers (default dim_pink/dim_orange/dim_red) (`LAYER*_COLOR`, `CTX_LAYER*_COLOR`, lines 256-324, `calculate_three_layer_metrics` in `statusline-layers.sh`). Fixed: directory `ORANGE_CODE`, timer `PURPLE_CODE`, token rate and session count `CYAN_CODE`, monthly `DIM_BLUE_CODE` (lines 999-1059).
2. Themes: no bundled themes; the `colors` map plus per-layer colour names in `config/config.json` is the user-editable palette (names, not semantic roles). `get_color_code` (line 327) maps a name to its escape.
3. Spec/depth: raw escape strings in config (so any of 16/256/truecolor if the user writes it); defaults use 16 and 256. No detection, no NO_COLOR.
4. Fill: foreground only.
5. Separators: ` | ` in dim (line 1064). Progress bars use a `│` projection marker in the current layer colour (lines 524-533).
6. Neighbours: different named colours per section plus separators.
7. Adaptation: `dim_*` variants use `\033[2;38;5;N`; no light/dark logic.
8. Glyphs: block-fill bars, `×` session count, `│` projected marker; 37 emoji hits across the layer scripts (labels).
9. Other: multi-layer bars (the fill restarts at layer boundaries with a new colour, "2-layer or 3-layer visualization" in `statusline-layers.sh`) plus a projected-usage marker coloured by the layer it falls in.
10. Customisation: `~/cc-statusline/config/config.json` (plan, limits, `display.bar_length`, `colors.*`, layer thresholds/colours, `sections.show_*` toggles); startup validation (`check_required`).

## zwen64657/glm-plan-usage2
https://github.com/zwen64657/glm-plan-usage2  (27 stars)
1. Colour source: fixed per provider segment. `src/core/segments/glm_usage.rs:131-134` colour 256-index 109 (grey-teal) for GLM and bold for error states (line 173); `kimi_usage.rs` 79 (green-teal); `minimax_usage.rs` 208 (orange). Colour does not vary with usage (`get_color(_stats)` ignores its argument). Formatting in `core/statusline.rs:format_segment`: emits `38;5;N` if `color_256` else `38;2;r;g;b`, optional bold, then reset.
2. Themes: not present. `StyleConfig` (`config/types.rs`) has a `separator`.
3. Spec/depth: segment style struct holds either a 256 index or an RGB tuple; no detection, no NO_COLOR.
4. Fill: foreground only.
5. Separators: config `style.separator` string joined between segments (`statusline.rs:generate`).
6. Neighbours: separator string only.
7. Adaptation: none for colour. Character mode detection: `src/terminal.rs` picks emoji vs ASCII (Windows 10 -> ASCII, Windows 11/Unix -> emoji; override `GLM_FORCE_EMOJI`/`GLM_FORCE_ASCII`).
8. Glyphs: emoji set `🔋⏰📊📅🌐⚡` with ASCII fallback `$ T # % M k` (`glm_usage.rs:90-91`). Explicit ASCII fallback mode.
9. Other: Rust binary; only shown for GLM/MiniMax/Kimi models (`main.rs`).
10. Customisation: TOML config (`config/loader.rs`, `toml::from_str`), `--init` writes it, flags `--verbose`, `--no-cache`.

## jhonatan-de-souza/claude-code-statusline
https://github.com/Jhonatan-de-Souza/claude-code-statusline  (26 stars)
1. Colour source: by threshold plus fixed. `statusline-command.py:40-45` `color_for(pct)`: >=90 red, >=70 yellow, else green, used for context, 5h and 7d (bar + bold percent via `num()`). Fixed: model CYAN, branch GREEN, directory uncoloured, secondary text `GRAY 244`, empty bar `TRACK 238`; cache timer green if remaining >20% of ttl else yellow (line 146). Parallel `.sh` version.
2. Themes: not present.
3. Spec/depth: ANSI 16 plus two 256-greys (`statusline-command.py:20-24`; comment: "256-color grays instead of dim, which is too faint in many themes"). No detection, no NO_COLOR.
4. Fill: foreground only; bar `█` / `░` in TRACK.
5. Separators: `│` in GRAY with two spaces each side, tighter for the short level (`SEPS`, line 27); `·` between line-1 fields.
6. Neighbours: separators plus differing hues on line 1.
7. Adaptation: deliberately avoids `dim` because it is too faint in many themes; uses 16-colour so terminal theme decides light/dark appearance. Width-aware: three detail levels and wrapping (`layout`, line 169).
8. Glyphs: `█░`, `│`, `·`. No emoji, no Nerd Font.
9. Other: responsive layout drops detail level as terminal narrows; UTF-8 forcing for Windows.
10. Customisation: edit the script; no config.

## lightpointventures/claude-tab-tracking
https://github.com/lightpointventures/claude-tab-tracking  (26 stars)
1. Colour source: by state. `scripts/session_statusline.sh`: task badge `[DONE]` GREEN, `[WIP]` YELLOW, `[SET]` BOLD, `[---]` DIM (lines ~62-75); context % green<50, yellow<80, else red (`PCT_COLOR`, ~line 130); footer directory, duration and model are DIM. Previous tasks `DIM+GREEN`.
2. Themes: not present.
3. Spec/depth: ANSI 16 escapes. No detection, no NO_COLOR.
4. Fill: foreground only.
5. Separators: two-space-padded ` | ` plain (`FOOTER`).
6. Neighbours: separators; badge colour differs from DIM text.
7. Adaptation: none.
8. Glyphs: text badges, no icons.
9. Other: `--segment` mode prints only the task line for embedding in ccstatusline / claude-powerline / claude-hud custom lines (script header).
10. Customisation: env `CLAUDE_TAB_SEGMENT=1`; no style config. The rest of the repo is a task-tracking hook system, not styling.

## noambrand/kivun-terminal
https://github.com/noambrand/kivun-terminal  (26 stars)
1. Colour source: fixed per segment, with threshold bar. `source/statusline.mjs:10-19` palette `g,y,r,c,d,b,m` (ANSI 16, `d` = bright black 90). `makeBar` (line ~113): green <50, yellow 50-79, red >=80, empty `░` in `d`. Fixed: model green for Opus else yellow (`fieldModel`: `/opus/i`), project cyan, tokens yellow, effort magenta, cost green, cache blue, tpm cyan, duration and directory dim.
2. Themes: statusline has none. The repo separately ships terminal background colour schemes for Windows Terminal (`source/apply-terminal-color.js`): `kivun` (`#C8E6FF`), `dark` (`#1E1E1E`), `black`, `white`, `default`, or custom `#RRGGBB`.
3. Spec/depth: ANSI 16 in the statusline. No detection, no NO_COLOR.
4. Fill: foreground only in the statusline.
5. Separators: dim `|` with one space (line 1) or two spaces (line 2).
6. Neighbours: distinct hue per field plus dim separators.
7. Adaptation: `apply-terminal-color.js` header: for a custom background "the text color is chosen automatically (dark text on a light background, light text on a dark one)". That is terminal-profile level, not the statusline's text.
8. Glyphs: plain text labels (`duration:`, `tpm:`), `█░` bar. No emoji, no Nerd Font. Product targets RTL/Hebrew terminal use.
9. Other: opt-in fields via env `KIVUN_SL_COST`, `KIVUN_SL_CACHE`, `KIVUN_SL_TPM`; writes rate-limit state for an auto-continue watcher.
10. Customisation: env opt-ins for fields; `config.txt` `TERMINAL_COLOR` for the terminal background; no statusline colour config.

## siropkin/budi
https://github.com/siropkin/budi  (26 stars)
1. Colour source: fixed per segment, minimal. `crates/budi-cli/src/commands/statusline.rs:99-126` (`render_context_prefix`): model cyan `\x1b[36m`, cwd uncoloured, branch bright-black `\x1b[90m`, separator `·` bright-black. Cost slots yellow `\x1b[33m` (lines 506-530), the `budi` word cyan and OSC-8 linked (line 503). No threshold colouring.
2. Themes: not present.
3. Spec/depth: ANSI 16 only; `ansi: bool` parameter (tests pass false). Custom and Starship formats print uncoloured text (`render_slots`, `render_template`, lines 485-499). No NO_COLOR.
4. Fill: foreground only.
5. Separators: ` · ` dim.
6. Neighbours: separators, with cyan model and dim branch.
7. Adaptation: none.
8. Glyphs: text only; `--` placeholder when the daemon is down.
9. Other: a `--format` of `claude`, `custom` (template with `{slot}` placeholders), `starship`, or `json`; slots like `1d`, `7d`, `30d`, `session`, `message`.
10. Customisation: `~/.config/budi/statusline.toml` (slots, `format` template), `--slots` flag (`parse_slots_arg`), `--format`.

## dashed/claude-marketplace
https://github.com/dashed/claude-marketplace  (25 stars)
not a Claude statusline: a plugin marketplace repo. Its `plugins/statusline/skills/statusline/SKILL.md` is documentation for writing a statusline script (git/jj segments, width-aware wrapping); the reference script "emits no escapes" (SKILL.md line ~214), so it has no styling of its own, and it only advises measuring an escape-stripped copy if colour is added (line 337).

## duartevi/ecologits-statusline
https://github.com/DuarteVi/ecologits-statusline  (25 stars)
1. Colour source: one colour for everything. `ecologits-bar.sh:38,224`: the whole line is `GRAY='\033[90m'`. No per-segment or state colour. Impact metrics are told apart by emoji only (`render_metric`, lines ~195-203: `🔥` gwp, `💧` water, `⚡️` energy, `⛏️` adpe, `🛢️` primary energy, `🤖` model).
2. Themes: not present.
3. Spec/depth: ANSI 16 bright black. No detection, no NO_COLOR.
4. Fill: foreground only.
5. Separators: plain ` | ` inside the grey line.
6. Neighbours: emoji prefix per metric.
7. Adaptation: bright black relies on the terminal's palette; none beyond that.
8. Glyphs: emoji only; no ASCII fallback.
9. Other: appended as an extra line below another statusline; no state colours.
10. Customisation: `~/.claude/ecologits.config.sh` (`ECOLOGITS_METRICS` ordering/visibility, `ECOLOGITS_MODEL`, `ECOLOGITS_ZONE`, `ECOLOGITS_API`); env vars override.

## narcooo/ccbar
https://github.com/Narcooo/ccbar  (25 stars)
1. Colour source: fixed per label plus value gradients. `src/statusline.ts:46-70` `COLORS` is a named truecolor map: `label [70,110,180]`, `sess`, `today`, `week`, `month`, `ctx`, `total` (blue family), `cost [255,210,60]`, `burn`, `proj_` (yellow/amber), `tleft`/`dur` (lavender), `time` peach, `tok [200,210,230]`, `model [80,220,170]` mint, `proj [255,140,80]`, `cache`/`hit` tan, `lines+` green, `lines-` red, `sep`, `dim`, `empty`. Value-driven: `gradientColor(pct)` (line 111) is hue `120*(1-ratio^2)` in HSL (s .8, l .52), green to red, used for 5h/7d percent and each bar cell (`gradientBar`, line 167, hue by cell index so the bar is a green-to-red ramp up to the fill); `contextColor(pct)` (line 118) is a two-segment RGB lerp from grey-blue (140,150,170) to orange (235,140,70) to red (255,60,30).
2. Themes: not present (single `COLORS` table).
3. Spec/depth: truecolor bold only (`rgb()` emits `\u001b[1;38;2;...`, line 75). No detection, no NO_COLOR.
4. Fill: foreground only. Bars are `━` (filled, per-cell colour) and `─` in `empty` grey; dual-scope bar uses `━` vs `─` for overall vs scoped (`dualGradientBar`, line 145).
5. Separators: `│` in `sep` grey, `›` and `·` in `dim`.
6. Neighbours: different hue family per label (blue labels, yellow money, lavender time, mint model), `│` separators; multi-column grid layout with `rows` config.
7. Adaptation: none. All text bold truecolor, mid-lightness values tuned for dark backgrounds.
8. Glyphs: `━─` line bars, `♻` cache, `│›·`. No emoji dependence; one emoji hit elsewhere. No Nerd Font.
9. Other: per-cell hue gradient bars; table layout with compact breakpoint (`DEFAULT_COMPACT_BREAKPOINT` 113, `src/config.ts`); also a Python package build.
10. Customisation: `~/.claude/plugins/ccbar/config.json` (`rows`, `compactRows`, `columns`, `compactBreakpoint`; `src/config.ts`). Colours not configurable.

## bhpark1013/claudenews
https://github.com/bhpark1013/claudenews  (23 stars)
1. Colour source: not a general statusline; a news-ticker widget (`plugin/hud/claudenews-hud.mjs`). Fixed: label bold, source cyan, `│` dim, title white and underlined as an OSC-8 link (`\x1b[37;4m`), score `▲` yellow, comments grey `90`, summary text configurable colour (default `38;5;245`, `summaryColor` config, validated to digits and semicolons, lines 123-136).
2. Themes: not present.
3. Spec/depth: ANSI 16 plus one 256 grey; `summaryColor` accepts any SGR parameter string. No NO_COLOR.
4. Fill: foreground only.
5. Separators: dim `│` between label and source; `↳` for summary continuation.
6. Neighbours: not applicable (a single news line).
7. Adaptation: comment (line 123): default grey chosen over the faint attribute "which many terminals render too low-contrast to read".
8. Glyphs: `▲`, `💬`, `↳`, OSC-8 links (segment mode drops hyperlinks because the host measures width).
9. Other: web UI (`web/`) and a Hammerspoon nav helper; "gradient" hit is unrelated CSS.
10. Customisation: JSON config key `summaryColor`; commands in `plugin/commands/`.

## gs/tmux-agent-status
https://github.com/gs/tmux-agent-status  (23 stars)
not a Claude statusline: a tmux status-bar plugin that shows agent state (Claude, opencode, pi) as tmux `#[fg=...]` markers. For the record: `bin/agent-status:182-196` colours by state, waiting = `color-waiting` default yellow (bold) with icon `⚠`, done = `color-done` default green with `✓`, via tmux user options `@agent-status-color-waiting`, `-color-done`, `-icon-waiting`, `-icon-done`; no background fill, no separator logic.

## intense-visions/harness-engineering
https://github.com/Intense-Visions/harness-engineering  (22 stars). Large monorepo; the statusline is `packages/burn/src/statusline.ts`. Other colour hits (dashboard `statusColors.ts`, design-craft catalog) are not statuslines.
1. Colour source: by state/status. `statusline.ts:51-59` `STATUS_STYLE` maps burn status to SGR code and emoji: CRITICAL `31` 🔴, HOT `31` 🔥, WARM `33` 🟠, OK `32` 🟢, EARLY `36` 🌱, UNDERCOUNT `31` ⁉️, NO_DATA `33` ⚠. Reset countdown: dim, yellow when <=12 h (`countdownSegment`). Session-window segment yellow only when >=70% (`sessionSegment`). Exhausted models red `⛔`, merged-branch hint magenta `✅ ... merged → /clear`, other git text and model name dim, stale cache `[stale Nm]` yellow, recalibrate yellow. Forecast text is dim and always labelled "proj" (header comment on not letting a forecast read as a measurement).
2. Themes: not present.
3. Spec/depth: ANSI 16 + dim via `\u001b[Nm` (`col()`, `dim()`). No detection, no NO_COLOR.
4. Fill: foreground only.
5. Separators: dim ` │ ` (`join(dim(' │ '))`, line ~160).
6. Neighbours: separators; segments that are normal are dim, so only abnormal ones draw colour.
7. Adaptation: none.
8. Glyphs: emoji status icons (defined in `STATUS_STYLE`), `⛔`, `⏳`, `✅`. No ASCII mode.
9. Other: design principle recorded in the file: a missing or stale cache is stated aloud ("A silent HUD reads as all clear when it is really just blind").
10. Customisation: `BurnConfig` (`config.ts`, `stale_after_minutes` etc.); no colour options.

## tylergallenbeck/claude-code-limit-tracker
https://github.com/TylerGallenbeck/claude-code-limit-tracker  (22 stars)
1. Colour source: by threshold, truecolor. `src/config.py:155-170` `get_usage_color`: <50% `(0,255,0)`, <75% `(255,255,0)`, else `(255,150,150)` ("very bright red, highly readable"). Applied to the whole 5h segment and each weekly Sonnet/Opus segment (`src/status_line.py:121-136`). Model label uncoloured.
2. Themes: not present.
3. Spec/depth: truecolor fg `\033[38;2;r;g;bm`. No detection, no NO_COLOR.
4. Fill: foreground only.
5. Separators: plain `" | "` (`status_line.py:~142`).
6. Neighbours: separators only; each segment coloured by its own usage.
7. Adaptation: the light-red choice (255,150,150) was picked for readability on dark backgrounds; yellow `(255,255,0)` would be poor on light.
8. Glyphs: emoji `⚡` `📅` (23 emoji hits). No ASCII mode.
9. Other: nothing.
10. Customisation: `configure.py` interactive script and `~/.../config.json` user config (`config.py` `user_config_path`) for plan limits; colours not configurable.

## gabriel-dehan/claude_monitor_statusline
https://github.com/gabriel-dehan/claude_monitor_statusline  (21 stars)
1. Colour source: fixed per segment, with three selectable schemes (`statusline.rb:73-107` `COLOR_SCHEMES`). `colors` (default): directory 256-51, model 105, tokens 141, messages 147, time 220, git clean 154, git dirty 222 (clean/dirty picked by whether git info matches `/[?+!↑↓]/`, line 249). Not driven by usage thresholds.
2. Themes: three bundled "display modes": `colors`, `minimal` (all segments grey 248/250, one hue), `background` (filled blocks: blue/magenta/cyan/green/yellow bg with white or black text). Selected by env `CLAUDE_STATUS_DISPLAY_MODE`. Format: segment-name to escape map; no user-defined themes except by editing the Ruby hash.
3. Spec/depth: 256 indices and ANSI 16 backgrounds. No detection, no NO_COLOR.
4. Fill: both, per mode. `background` mode paints cells (`\033[44m\033[37m` etc.) with space padding (`" #{text} "`, lines 160-162, 218-228); the other modes are foreground only.
5. Separators: `·` in bright-black joined with spaces (line 188); in background mode cells simply abut.
6. Neighbours: different hues per segment (colours mode) or contiguous differently filled blocks (background mode); one grey (minimal).
7. Adaptation: `background` mode pairs text colour per fill (white on blue/magenta, black on cyan/green/yellow, hand-picked). No light/dark detection.
8. Glyphs: optional emoji per segment via `CLAUDE_STATUS_INFO_MODE` = none (default) | emoji | text (`EMOJIS`, line 17+). Emoji fallback is simply "none".
9. Other: matches Claude Monitor's 5-hour session logic; token/message counts per plan.
10. Customisation: env vars `CLAUDE_STATUS_DISPLAY_MODE`, `CLAUDE_STATUS_PLAN`, `CLAUDE_STATUS_INFO_MODE`; edit Ruby constants.

## gui-gou/claude-statusline-burnrate
https://github.com/Gui-Gou/claude-statusline-burnrate  (21 stars)
1. Colour source: the most elaborate in this batch; three mechanisms in `statusline.sh`. (a) Semantic "gray = good, red = bad" scale (lines 162-166): `NEU 148,155,168`, `YEL 234,179,8`, `ORG 236,141,47`, `RED 239,68,68`; a healthy meter is deliberately grey so only warmed-up meters draw the eye (README line 18). (b) Position along a gamma-corrected truecolor ramp: bars use `SUN8`/`SUN5` palettes with cell i coloured by its index, so the right end of a lit bar is always warmer (lines 207-228), and the percentage text samples the 16-stop `SUNV` ramp at the value (`gradc`). Today/pace figures use step thresholds (`todaycol`, `pacecol`). Effort colour: low NEU, medium YEL, high ORG, xhigh/max RED (lines 190-196). (c) Per-model identity: model name drawn char by char from a model-specific 256-colour hue list (`MHUES`: Opus reds/golds, Sonnet blues, Fable purples, Haiku greens, Flash cyan, GPT emerald, Pro indigo, unknown full rainbow, lines 183-189; comment says it is "exempt from the gray-until-it-matters rule: it is identity, not a meter").
2. Themes: not present; palettes are bash arrays ("short, commented blocks of bash. Make it yours", README line 112).
3. Spec/depth: truecolor for ramps/bars, 256-colour for rainbow and frame. No COLORTERM/NO_COLOR detection or downsampling (grep found none).
4. Fill: foreground only. Bars are `▰` lit (coloured) and `▱` unlit `55,60,70` (lines 224-225).
5. Separators: dim `│` between columns (`SEP`, line 528); box-drawing frame `╭─ ... ─╮ │ ╰─╯` around the two rows (lines 515-647).
6. Neighbours: columns separated by `│`, labels dim (`CX`, `5H`, `WK`), numbers coloured by their own value; frame is a gradient.
7. Adaptation: none for light terminals; all values tuned for dark. The grey `NEU` is mid-tone.
8. Glyphs: `▰▱`, box drawing, `📋 ☐ ▶ ⛔ ⌚ ⌂ 💵` emoji in the cells; classic one-line v1 (`statusline-classic.sh`) uses emoji labels and an animated cat. No Nerd Font; no ASCII mode.
9. Other: animated drift of rainbow name and frame gradient per render (`fn` counter file, `bxrun` stretches the model's hue list across the frame width, not tiled, lines 535-560); a pet/mascot in classic; screenshot tooling (`tools/ansi2html.py`, `infographic.py`, `make-images.sh`); extends to agy (Gemini/GPT) hosts with their own colours.
10. Customisation: edit bash blocks; `demo.sh` (`--classic`); no config file or flags for style.

## ethanmcdonnell/claude-usage-bar
https://github.com/EthanMcDonnell/claude-usage-bar  (20 stars)
1. Colour source: one chosen accent plus grey. `context-bar.sh:1-16`: `COLOR="blue"` variable selects `C_ACCENT` from nine 256-colour names (orange 173, blue 74, teal 66, green 71, lavender 139, rose 132, gold 136, slate 60, cyan 37; default falls back to grey); `C_GRAY` is 245. Model name and all numeric values use the accent; labels and the directory are grey (lines 150-167). No threshold colouring: the percentage colour never changes with usage.
2. Themes: nine named accent colours selected by editing the `COLOR=` line; no theme file.
3. Spec/depth: 256-colour indices; no detection, no NO_COLOR.
4. Fill: foreground only; no bars.
5. Separators: newlines (multi-line vertical layout), no glyph separators.
6. Neighbours: accent versus grey (number vs label) only.
7. Adaptation: mid-tone muted 256 colours (e.g. slate 60, teal 66); none adaptive.
8. Glyphs: emoji prefixes `📁 💬 ⚡ 🔄 🎯`. No ASCII mode.
9. Other: output is a vertical stack of lines (model, dir, usage, pacing, context).
10. Customisation: edit the `COLOR=` variable at the top of `context-bar.sh`; no config or env.

# Batch 38 — styling deep read

Files were fetched from each repo's HEAD with curl and read directly. Anchors are file:line (or key) in that repo.

## brunoraphaell/status-line-claudecode
https://github.com/BrunoRaphaell/status-line-claudecode — stars 0
1. One conditional colour only: the context bar and `NN%` take `$COLOR` chosen from used%: >=85 red, >=60 yellow, else green (`statusline-command.sh:16-22`). Every other segment (model, folder, branch, duration) is uncoloured text.
2. Themes: not present. Colours are three hard-coded vars (`:11-14`).
3. Colour spec: ANSI 16 only (`\033[32m`/`33m`/`31m`). No depth detection, no NO_COLOR.
4. Fill: foreground-only.
5. Separators: plain ` | ` text, uncoloured.
6. Neighbours: separators only (plus emoji prefixes 📁 🌿 ⏱️).
7. Light/dark: not present.
8. Glyphs: emoji prefixes, `█`/`░` 10-cell bar (`:24-31`). No ASCII mode.
9. Nothing else.
10. Customisation: edit the script.

## bryanroscoe/dotfiles-public
https://github.com/bryanroscoe/dotfiles-public — stars 0 (a dotfiles repo; the statusline is `claude/statusline.js`)
1. Fixed per segment, as background fills, from a Catppuccin Mocha palette (`statusline.js:10-14`, push calls `:70-91`): directory peach, worktree red, git yellow, task green, context bar mauve, model sapphire; time is plain lavender text after the bar (`:112`). The API-usage segment is the one threshold segment: background green <50%, yellow <75%, peach <90%, red above, on the worse of 5h/7d (`:292-298`).
2. Themes: one hard-coded palette (Catppuccin Mocha) as 8 named 256-colour indices (`PAL`, `:11-14`: crust 234, mauve 183, peach 216, yellow 223, green 157, sapphire 117, lavender 189, red 211). No theme switch, no user themes.
3. Colour spec: 256-colour indices only (`38;5;n` / `48;5;n`, `:15-16`). No detection, no NO_COLOR.
4. Fill: background-filled cells with dark text. `dark = fg('crust')` is the text colour on every fill (`:64`).
5. Separators: Powerline arrows `` right and `` left (`:25-26`). The arrow's fg is the previous segment's bg, its bg the next segment's (`:36-38`); the line opens with a left arrow and closes with a right arrow (`:34-36`, `:42`).
6. Neighbours: a different hue per segment plus the arrow. Pastel backgrounds with one shared dark text, so contrast comes from the pastel being light.
7. Contrast: one dark `crust` foreground on all light pastels; no terminal-background adaptation.
8. Nerd Font powerline glyphs, branch/staged/modified icons `  ` (`:21-28`), emoji (📁 📋 📊 🧠), Fira Code progress-bar glyphs `-` (`:217-226`). No ASCII fallback.
9. Responsive priority drop: segments carry priority 1-3 and are filtered by `process.stdout.columns` (<80, <100) (`:96-100`). Context above 90% swaps the brain for a blinking skull (`BLINK`, `:18`, `:232`).
10. Customisation: edit the JS; no config.

## bsnsolution/tmux-statusline-editor
https://github.com/BSNSolution/tmux-statusline-editor — stars 0
not a Claude statusline: an Ink TUI editor for the tmux status line (`shared/src/model.ts`, `generator.ts` emit `#[fg=,bg=]` tmux styles). Its only Claude tie is an agent-state icon per tmux tab (⚙ working, 🔔 needs you) driven by Claude Code hooks (README "Agent indicator in tabs"). The `catppuccin`/`nord`/`tokyo-night` names in `cli/src/themes-cli.ts` are a regex for detecting and disabling third-party tmux theme plugins, not bundled themes. For reference, the editor stores per-segment `fg`/`bg` as tmux colour names or hex, with a `Theme` type (palette + statusStyle + powerline separators, `model.ts:70-80`) that has no instances in the tree.

## bstyler/claude-mods
https://github.com/bStyler/claude-mods — stars 0
Claude Code mods (a `plugin` marketplace), not a statusline. The relevant mod is `cache-keeper`, a band above the prompt drawn with the mod API's `Text`/`Box` components, so there is no ANSI of its own.
1. By state: cache-keeper's line is coloured by cache state — kept warm cyan, warm green, cooling yellow bold, cold red bold (or dim when the context is small) (`cache-keeper/hooks/register.mjs:860-863`, `:933-942`); plan limits are red bold at >=95%, yellow at >=80%, else dim (`limitTone`, `:338-342`). Everything else is `dimColor`. goal-meter: bar and headline green when the goal is met, else cyan; "not met" yellow (`goal-meter/hooks/register.mjs:545`, `:566-567`).
2. Themes: not present; colours are the host's named colours (`green`, `cyan`, `yellow`, `red`, `gray` -> `dimColor`, see `tone()` at `:1009-1011`), so they follow the user's Claude Code theme.
3. Colour spec: colour names handed to the host; depth and NO_COLOR are the host's.
4. Fill: foreground-only.
5. Separators: ` · ` text.
6. Neighbours: dim vs coloured; one hue per state.
7. Adapts through the host theme; comment at `:1009` notes "'gray' draws dim, which every theme has".
8. Glyphs: `● ◐ ○ ◆` for cache state, `█░` bars, sparkline (`fmt.mjs:49-58`).
9. Nothing else.
10. Customisation: mod settings (thresholds); no colour settings.

## btrav/claude-mini-hud
https://github.com/btrav/claude-mini-hud — stars 0
1. By state/threshold, three roles: `C_LOW`/`C_MID`/`C_HIGH` (`statusline.sh:13-28`). Context bar is a cascade by cell position (cells 1-6 low, 7-8 mid, 9-10 high, `:81-95`); the `%` takes the frontier colour (>=90 high, >=70 mid). Rate-limit battery: remaining <=10 high, <=24 mid, else low (`:114-118`). Diff `+n` `-n` use mid/low or low/high depending on net sign (`:150-153`). Callsign `✦CC✦` / `◈CC◈` / `!CC!` is dim / mid / high by context and rate state (`:70-76`). Everything else (duration, model, effort, fast, streak) is dim.
2. Themes: 7 selected by `CLAUDE_HUD_THEME` — default, synthwave, ghost, matrix, blueprint, vaporwave, lava-lamp (`:10-27`). Each theme is just a 3-tuple of escapes (low/mid/high). Users override each with `CLAUDE_HUD_C_LOW/MID/HIGH` raw escape strings (`:29-31`).
3. Colour spec: ANSI 16 plus a few 256 indices (201, 183, 51); `2;37` dim white for ghost. No detection, no NO_COLOR.
4. Fill: foreground-only.
5. Separators: dim `·`.
6. Neighbours: dim dot separators; hue differences only inside the threshold cascade.
7. Light/dark: not present; `ghost` theme is dim/white only.
8. Glyphs: `▓░` bar, `▮▯` battery, `✦◈♨⟳▴↯` marks; no Nerd Font.
9. `lava-lamp` (`:36-37`, `:86`) alternates the bar's cells between two colours by index parity instead of the threshold cascade.
10. Customisation: env vars only (`CLAUDE_HUD_THEME`, `_C_*`, `_EFFORT`, `_FAST`, `_NOTIFY`).

## buhrerm/omz2cc
https://github.com/buhrerm/omz2cc — stars 0
1. Fixed per field per theme: each of the 142 oh-my-zsh themes is a static `TemplateDef` listing segments as `field(Field, Colour)` / `lit(text, Colour)` / `dirty(clean, dirty, c1, c2)` (e.g. `defs.rs:19-47` ys: user Cyan, host Green, cwd Yellow bold, branch Cyan, dirty marker Red). Git dirtiness is the only state-driven colour. The Claude model name replaces the user field (`--set user=@model`, README).
2. Themes: 142 oh-my-zsh themes ported (README list; `defs::TEMPLATES` + manual `agnoster`, `themes/mod.rs:19-50`), plus `random`. Format is a segment-template DSL (`themes/template.rs`, shared pieces in `components.rs`, e.g. `GIT_ANGLE_YELLOW`). Users cannot add themes without recompiling; they pick a name via `--theme`, `$ZSH_THEME` or `~/.zshrc`.
3. Colour spec: ANSI 16 (named enum incl. bright and gray) plus `Color256(n)` (`color.rs:1-81`, used by e.g. af-magic at `defs.rs:66-87`). No depth detection, no NO_COLOR found.
4. Fill: foreground-only, except `agnoster`, which fills (`agnoster.rs:30-39`, `bg.bg()`/`prev_bg.fg()`).
5. Separators: whatever the source theme draws; agnoster uses Powerline `\u{e0b0}` with fg = previous bg (`agnoster.rs:8`, `:30`).
6. Neighbours: whatever the original theme does (brackets, `@`, `in`, `on` in white).
7. Light/dark: not present.
8. Glyphs: emoji and Unicode as in each source theme (`➜`, `✗`, `λ`, box-drawing `╭─`); Nerd Font only in agnoster.
9. `--theme random`; `sporty_256`, `af-magic` use the 256 palette.
10. Customisation: CLI flags `--theme`, `--set key=value`, `--list`, `--init`; mappings file `~/.config/omz2cc/mappings.conf`.

## buluktaev/statusline-editor
https://github.com/buluktaev/statusline-editor — stars 0 (a static browser editor that generates a bash statusline script)
1. Per block: every block has a configurable 256-colour index (`js/state.js` `DEFAULTS`: model 254, rate 249, tokens 245, dir 247, separator 243). Context % is a threshold block: <50 index 82 green, <80 226 yellow, else 203 red (`state.js:14-18`; the README text says gray/orange/red but the defaults are green/yellow/red). Git block has separate branch, clean (82), dirty (203), staged (82), modified (226), untracked (245) colours. Bars colour by percent too (`js/bars.js:35-53`: green <50, yellow <80, red).
2. Themes: no colour themes. The only "theme" is a light/dark toggle of the editor's preview window (`js/theme.js`).
3. Colour spec: ANSI 256 index only (`js/ansi.js:24-28`, generated script writes `\033[38;5;Nm`, `js/generator.js:128-166`). Includes a 256-colour picker (`js/components.js`, base 16 + 216 cube). No NO_COLOR.
4. Fill: foreground-only.
5. Separators: a configurable global text separator (default `|`) with its own colour (`globalSep`, `globalSepColor`).
6. Neighbours: per-block colour pick plus the separator.
7. Light/dark: only the preview switches (`bars.js:36-37` picks the empty-bar grey by preview theme); the generated script does not adapt.
8. Glyphs: bar styles classic `▓░`, diamond, dot, line, plus `gradient` (`█▓▒░` by position) and `emoji` 🟢🟡🔴 (`bars.js`).
9. Web configurator with drag-to-reorder, copy script and a one-line base64 install command (`js/output.js`).
10. Customisation: browser editor with localStorage state; output is a bash script.

## buyi1net/claude-line
https://github.com/buyi1net/claude-line — stars 0
1. Light-touch scheme: body text is neutral and colour marks only location and warning (comment `src/core/theme.ts:1-2`). Fixed: cwd base grey, branch/model/provider blue `#7aa2f7`, thinking effort yellow, git `+n` green, `~n` red, `↑↓` yellow, tokens dimmer grey, session cost green (`src/core/pipeline.ts:24-76`). State-driven: quota remaining <=10 red, <=30 yellow, else green; context used >=85 red, >=70 yellow, else green; cache hit <50% red else base; timer >60 s yellow; balance <=5 red else green (`theme.ts:30-64`). Tones are a four-value `Tone` (`base|dim|mid|hot`).
2. Themes: one palette `C` of 9 hex values (`theme.ts:4-13`, Tokyo Night-like hues). No switch, no user themes. `~/.claude/claude-line/config.json` configures quota/balance TTLs and provider queries, not colours.
3. Colour spec: truecolor hex only (`fg()` writes `38;2;r;g;b`, `theme.ts:16-21`). No fallback, no NO_COLOR.
4. Fill: foreground-only.
5. Separators: ` · ` in base grey.
6. Neighbours: separators plus the blue/neutral split.
7. Light/dark: not present (greys are chosen for dark terminals).
8. Glyphs: emoji and Unicode (⎇ ⏱ 🧩 ⚡), no Nerd Font.
9. Provider-aware (many Chinese relay/API providers) — not styling.
10. Customisation: JSON config for data sources only.

## buzzshu/pokemon-statusline
https://github.com/buzzshu/pokemon-statusline — stars 0 (PowerShell, a gacha/pet game rendered as a multi-line boxed panel)
1. Fixed per label and per data type: `HP` red 196, `MP` orange 208, `SP` blue 39; bar colour by remaining% (>=70 green 46 / 39, >=30 yellow 226, else red 196) (`statusline.ps1:495`, `:515`, `:535`). Per Pokémon type colour table (15 types) and glyph (`:254-267`), rarity colours C 245 / U 82 / R 220 / HR 213 (`:269`), 10 title colours (`:285-298`), badge colours.
2. Themes: three frame themes `gba`, `crystal`, `dark`, each a map of outer/outerTitle/frame/label SGR strings, selected from the game state's `theme` field (`:301-309`, `:720-722`). Also a weekday "daily theme" banner that picks a type colour (`:906-914`). No user-defined themes besides editing the state file.
3. Colour spec: 256-colour (`38;5;n`, `1;38;5;n` bold) via `Color` helper (`:23`). No NO_COLOR; notes a conhost-fallback mode that drops emoji (`:287`).
4. Fill: foreground-only; frame lines are double-line box-drawing `╔═╗║╚╝` coloured per theme (`:741-748`, `:819-821`).
5. Separators: none between segments; each stat is its own row inside the box.
6. Neighbours: distinct colour per row label.
7. Light/dark: not present.
8. Glyphs: Unicode symbols per type, emoji, CJK names; box-drawing frame.
9. Animation: expression/emoji frames and sprite art, bold-gold `Gold` helper (`:24`) for shiny Pokémon (used at `:553`).
10. Customisation: game state file plus `gacha.ps1` commands; no styling config.

## bvfusion1001/claude-mods
https://github.com/bvfusion1001/claude-mods — stars 0
Claude Code mods (plugins), not a statusline; `context-band` draws a band above the prompt via the mod `Text` API.
1. By threshold: token count picks a zone — red at >=700k tokens (default `redAt`), yellow at >=550k, else green, with matching 🔴🟡🟢 dots (`plugins/context-band/hooks/register.tsx:14-17`, `:164-165`); the band is dim until `handoffFrom`. Usage limits are yellow, red at >=90% (`:240`). `plan-pane` uses `cyan` for the current phase heading, `yellow` for the active item, `dimColor` for done phases (`plan-pane/hooks/register.tsx:374-391`).
2. Themes: not present; colour names go to the host so they follow the Claude Code theme.
3. Colour spec: colour names via the host (`color="red"`); `dimColor` prop.
4. Fill: foreground-only.
5. Separators: none.
6. Neighbours: dim vs coloured text.
7. Adapts via the host theme.
8. Emoji dots 🔴🟡🟢, `⏳`.
9. Nothing else.
10. Customisation: plugin options `yellowAt`, `redAt`.

## bvur/mission-control
https://github.com/bvur/mission-control — stars 0
Claude Code mod drawing an SVG panel above the prompt (images built as strings in `hooks/register.tsx`, not terminal ANSI).
1. By role from the active theme: `MINT`=`accent`, `MOSS`=`deep`, `GREEN`=`accent`, `INK`, `LINE`, `PANEL`, `INSET`, `PATCH` are set by `applyTheme` (`hooks/register.tsx:199-214`). Meter fill is `MINT` normally, `AMBER` `#e0a458` at >=75%, `RED` `#e5695f` at >=90%; the "Cache" meter is always MINT because full is good (`:853-863`). Time-share segments in the summary bar alternate `MINT`/`MOSS` by index parity (`:618`).
2. Themes: 9 bundled — Forest (default), Midnight, Graphite, Paper, Ocean, Plum, Ember, Slate, Sand (`:90-170`). A theme is a record of semantic roles `{ panel, inset, line, ink, accent, deep, patch, night?, font?, advance? }`. Two are light (Paper, Sand). The user picks from a dropdown in the panel, remembered across sessions (README "Controls"); no user-defined themes.
3. Colour spec: hex in SVG fill; depth not applicable.
4. Fill: both: filled `panel` backdrop, `inset` chips, coloured text.
5. Separators: hairline `line` colour rules (an SVG divider).
6. Neighbours: panel vs inset fills plus accent; the two-tone MINT/MOSS alternation inside the share bar.
7. Light/dark: `night` ink override under `prefers-color-scheme:dark` for a theme that paints no panel (`:216-218`); `Paper` and `Sand` are light themes.
8. Glyphs: SVG icons; animated wave line under steps while a turn runs.
9. Per-theme font and character advance (`font`, `advance`), gradient stops with opacity for the wave (`:539`); `docs/themes/*.png` gallery.
10. Customisation: theme dropdown in the panel only.

## bylkraft/claude-statusline
https://github.com/bylkraft/claude-statusline — stars 0
1. Fixed per element with picocolors: model cyan with 🤖, path lightGray, branch cyan, `+n` green, `-n` red, staged `~n` gray, unstaged yellow, cost yellow (`src/lib/render-pure.ts:101-141`, `:166-168`, `:401-405`). Percentages are always gray; the bar carries the signal (`:89-91`). Effort dot: low gray, medium yellow, high green, xhigh violet, max a per-character red -> pink -> violet -> blue truecolour gradient (`:412-424`, `src/lib/formatters.ts:30-57`). Pacing delta green/lightGray/yellow/red (`:302-305`).
2. Themes: none. Three presets Minimal/Balanced/Full are layout presets, not colours (`src/lib/presets.ts:155-165`).
3. Colour spec: picocolors ANSI 16 via `pico.*`, hand-written 256 (`orange 38;5;208`) and truecolor (`peach`, `teal`, `violet`) escapes (`formatters.ts:17-30`). picocolors honours NO_COLOR itself; the raw-escape colours do not.
4. Fill: mostly foreground; progress bars can have a background (`ProgressBarBackground`: none, dark, gray, light, blue, purple, cyan, peach) via `bgFn` (`formatters.ts:244-257`).
5. Separators: configurable single glyph (default `•`), gray (`render-pure.ts:393`).
6. Neighbours: separators plus emoji prefixes.
7. Light/dark: not present.
8. Glyphs: emoji 🤖📁💰⏱️, bar styles filled `█░`, rectangle `▰▱`, braille, smooth (`config-types.ts:14`).
9. `progressive` bar colour mode: green <70, yellow <90, red (`formatters.ts:225-235`); bar colour choice among green/yellow/red/peach/black/white/gray; empty part is the same hue dimmed.
10. Customisation: `statusline.config.json` (features, separators, per-bar style/colour/background/length), interactive menu factories (`menu-factories.ts`), presets.

## calevi-consulting/claude-statusline
https://github.com/Calevi-Consulting/claude-statusline — stars 0
1. Fixed: directory name orange `255,140,0`, branch grey, model dim (`statusline.sh:20-22`, `:97-108`). State-driven: context bar and percentage green / yellow / red; red at the configured critical % or at 1.5x the "smart zone" token threshold, yellow when a hint (zone warning) is showing, else green; the hint text takes the same colour (`:145-148`).
2. Themes: the `themes/naranja.json` is a Claude Code UI theme (base `dark`, overrides `promptBorder`/`promptBorderShimmer` to orange `rgb(...)`), not a statusline theme. Installed with `--with-theme`.
3. Colour spec: truecolor `38;2;r;g;b` (`:20-22`). No fallback, no NO_COLOR.
4. Fill: foreground-only.
5. Separators: ` · ` plain.
6. Neighbours: orange name vs grey vs dim.
7. Light/dark: not present.
8. Glyphs: `█░` 10-cell bar only.
9. The statusline gives advice text ("dumb zone · /clear…") by absolute token thresholds; README shows SVG state screenshots.
10. Customisation: `statusline.json` (warn/critical %, smart-zone tokens), installer flags.

## callmemorgan/agents-statusline
https://github.com/callmemorgan/agents-statusline — stars 0
1. Theme role mapped to segment, by `PrimaryColor` in the segment table (`internal/segments/segments.go:513`, `:536`): model->Model, dir->Dir, git->Git (dirty `*` Chg), lines changed->Chg, duration->Dur, cost->Cost, cache/api->Dim, agent->Agent, session name->Session, sandbox->RCrit (`segments.go:57-398`). Bars use ok/warn/crit by `warn_at`/`crit_at` (default thresholds configurable; per-bar `ok_color`/`warn_color`/`crit_color` overrides). Each segment's colour can be overridden in `[colors]` by name, hex, 0-255 index or role name (README).
2. Themes: 10 bundled — classic (default, exact pre-1.0 ANSI), catppuccin-mocha, nord, dracula, gruvbox-dark, tokyo-night, newsprint, paper, solarized-light, monochrome (`internal/palette/themes.go:40-231`). Format is semantic: 15 roles `model dir git changes duration cost dim ok warn crit agent vim accent session sep` (`ThemeRoles`, `:25`), each a hex plus optional explicit ANSI16 fallback. User overrides single roles in `[theme_colors]` (`ApplyThemeOverrides`, `:280-310`); no whole custom theme.
3. Colour spec: hex truecolor, nearest xterm-256 index, nearest ANSI-16 (`depth.go:12-45`, `roleEscape` in themes.go). Depth detected from `NO_COLOR`/`TERM=dumb` (none), `COLORTERM`, `TERM_PROGRAM` (iTerm, ghostty, WezTerm, vscode), `WT_SESSION`, `TERM` containing 256color; `color_depth` config overrides, but NO_COLOR always wins (`depth.go:25-72`). Comment notes Claude Code may strip COLORTERM.
4. Fill: foreground-only; no backgrounds.
5. Separators: six styles — bar ` │ `, dot, slash, chevron, powerline (glyph in text, no bg fill), space, custom (`internal/render/render.go:55-62`); coloured by the `sep` role (classic leaves it uncoloured).
6. Neighbours: different role hue per segment plus separator.
7. Light/dark: `paper` ("high-contrast ink colors for light terminal backgrounds"), `solarized-light`, and `monochrome` that emits no colour at all so the terminal foreground applies on any background (`themes.go:231-262`); a TUI view `v` renders in the real terminal to check against the background. No automatic detection.
8. Glyphs: bar iconsets default, blocks, dots, ascii, minimal, smooth, braille, braille-fine, shade, line, slim, vertical; emoji in segments; ASCII iconset exists.
9. TUI configurator (tview): live preview at terminal width, colour swatch picker (`c` cycle, `C` picker with hover preview), theme picker with live preview, 8 layout presets; screenshots generated from real renderer output (`scripts/screenshots.py`); also serves Antigravity and Pi.
10. Customisation: TOML `config.toml` (`theme`, `color_depth`, `[theme_colors]`, `[colors]`, `[style]`, `[settings.<segment>]`), `agents-statusline configure` TUI, script-plugin segments with `preview` values.

## cancoretamero/abaco-cost-cockpit
https://github.com/cancoretamero/abaco-cost-cockpit — stars 0
1. Fixed per element: brand `⌘ Ábaco` gold, model dim, session cost green, cap line red when over else dim, `dial:` dim (`statusline/cockpit.cjs:12-30`). The only state colour is cap breach (red).
2. Themes: not present.
3. Colour spec: ANSI 16 + dim (`:12`). No detection, no NO_COLOR.
4. Fill: foreground-only.
5. Separators: dim ` · `.
6. Neighbours: separators only.
7. Light/dark: not present.
8. Glyphs: `⌘` only.
9. Nothing else; the project is a cost governor with a one-line statusline.
10. Customisation: `~/.abaco` config (cap, dial), not colours.

## cangokturk/claude-statusline
https://github.com/cangokturk/claude-statusline — stars 0
1. Role palette per theme, each element mapped to a role in `statusline.sh:357-372`: SKY headings (plan, model, dir), STEEL labels (`in`, `out`, `api`), ICE primary data (input tokens, 5h bar, time), MINT positive (output tokens, user), TEAL secondary positive (branch, 7d bar, api), AMBER attention (cost, git state), SILVER (clock, uptime), ASH dim, SLATE separators. Threshold badges (context, cache, tok/s, cpu, mem, 5h, 7d) fill with BG_MINT / BG_AMBER / BG_ROSE with white bold text, thresholds mid/bad per metric, inverted for "remaining" metrics (`badge()`, `:167-180`); context bar colour tracks the badge (60/80, `:183-191`).
2. Themes: 4 bundled — arctic (default), ember, neon, pastel (README table says inspired by VS Code Dark+, Gruvbox, Synthwave '84, Catppuccin Mocha). Each is a 15-variable shell file (SKY STEEL SLATE ICE MINT TEAL AMBER CORAL ROSE SILVER ASH BG_MINT BG_AMBER BG_ROSE WHITE; `themes/neon.sh`). Selected by `~/.claude/theme`; users add `~/.claude/themes/<name>.sh` defining the 15 variables (README "Creating Custom Themes"). Themes claim WCAG AA 4.5:1 against a dark background in header comments.
3. Colour spec: 256-colour indices (`38;5;n`, `48;5;n`) with hex noted in comments. No detection, no NO_COLOR.
4. Fill: both — foreground text plus background-filled "badges" for threshold values.
5. Separators: `│` and `·` in the SLATE role (`:336-337`).
6. Neighbours: role hue per element; badges are the only filled cells.
7. Contrast: palettes picked dark-terminal-only; badge text is fixed white on dark-tint backgrounds (indices 22/94/53 etc.).
8. Glyphs: `▰▱` bars; no Nerd Font required.
9. Multi-row grid layout (`C1_1`…`C3_3`).
10. Customisation: theme file + `~/.claude/theme`; edit script for layout.

## cass-2003/ccpill
https://github.com/cass-2003/ccpill — stars 0
1. Semantic category colour per segment, per theme: `Model, Context, Cost, Rate, Git, Dir, Extra, Clock` (`internal/theme/theme.go:27-36`). In the default catppuccin-mocha: Model mauve, Context blue, Cost green, Rate peach, Git teal, Dir blue, Extra pink, Clock subtext1 (`:40-52`). State: a segment at warn level flips the whole pill — background becomes the theme `Warn` colour, text `WarnFG` (`render.go:99-105`). Per-pill overrides `color`/`bg` in config.
2. Themes: 5 bundled — catppuccin-mocha (default), nord, dracula, gruvbox-dark, tokyo-night (`theme.go:38-120`). Format: struct of RGB roles `PillBG, Sep, Muted, Warn, WarnFG` plus the 8 category colours. User themes: not present (per-pill overrides only, README `color`/`bg`).
3. Colour spec: truecolor only (`38;2`/`48;2`, `render.go:60-66`). No detection, no NO_COLOR.
4. Fill: both. Default is "pills": one uniform `PillBG` per theme (e.g. Surface0) with a coloured foreground; `pills = false` gives coloured text on the terminal background (`render.go:50-70`, `:122-160`).
5. Separators: round caps `` / `` (fg = pill bg, no bg) around each pill when `caps` is round (default only for the nerd icon set; flat otherwise), then a single space between pills; in no-pill mode a `Sep`-coloured ` │ ` (`render.go:33-43`, `:73-92`).
6. Neighbours: every pill shares one background; neighbours differ by foreground hue by category, and pills are spaced apart. No alternation or lightness steps.
7. Contrast: the warn pill uses a dark `WarnFG` on the Warn colour; line starts with reset to override Claude Code's dim; spaces become U+00A0 to avoid VS Code trimming (`render.go:1-4`, `:84`). Dark themes only.
8. Glyphs: icon sets `nerd` / `unicode` / `ascii` (`icon_set`, README; `render/icons.go`).
9. Local web configurator `ccpill --config` with 1-3 line drag layout and live preview using the same compose layer; `--import-ccstatusline` migrates a ccstatusline config; custom slots can show any text or command output.
10. Customisation: `~/.claude/ccpill/config.toml` (`theme`, `pills`, `icon_set`, `caps`, per-pill `color`/`bg`/`prefix`/`bold`), web UI, CLI flags.

## ch/claude-statusline
https://github.com/ch/claude-statusline — stars 0
1. Default `statusline.sh`: emoji-led segments, colour only on state values: context % green <50, yellow <80, red (`:38-46`); limit bars green <50, yellow <80, red (`pct_bar`, `:142-152`); effort low green, medium yellow, high/xhigh/max red (`:104-109`); remote-control magenta link; cost blue (`:123`, `:136`). Folder, branch, model are uncoloured. The `catppuccin` variant gives fixed hues: model mauve, effort by level (low subtext, medium yellow, high/xhigh peach, max flamingo), dir blue, branch teal, `+staged` green, `~modified` yellow, cost overlay; bar green <40, yellow <60, red; 5h limit lavender/yellow/red; 7d subtext/yellow/red (`variants/catppuccin.sh:13-24`, `:60-135`). The `simple` variant: dir bold blue, branch magenta, model cyan, bar green/yellow/red bold (`variants/simple.sh`).
2. Themes: one palette in the catppuccin variant (Macchiato, 12 truecolor vars). No theme system; variants are separate scripts installed by `install.sh <name>`.
3. Colour spec: default and simple use ANSI 16; catppuccin uses truecolor `38;2` and says it needs a truecolor terminal. No detection, no NO_COLOR.
4. Fill: foreground-only.
5. Separators: ` | ` (default), ` │ ` in overlay grey (catppuccin).
6. Neighbours: separators and emoji prefixes; catppuccin adds hue per segment.
7. Light/dark: not present.
8. Glyphs: emoji in the default (📁🌿🤖📚); catppuccin uses `✦ ▸ ⎇ ◷` with a note that Nerd Font glyphs can be swapped in.
9. Width-aware degradation: `render` drops segments in 7 steps until it fits `COLUMNS` (`:180-226`); dir is an OSC 8 `file://` link in catppuccin.
10. Customisation: pick variant at install; edit script.

## chahindb7/ccstatusline (fork of sirmalloc/ccstatusline)
https://github.com/ChahinDB7/ccstatusline — stars 0
Fork differences only, from the compare against the parent's main (6 commits ahead, 233 behind): no styling change. The diff touches widget text and metrics — "Model:" -> "M:", "Thinking:" -> "Effort:" labels, a narrower context bar (`barWidth` 32/16 -> 22/11) with a `Nk/Nm` token format, an added `ultracode` effort level in the description, new token-by-source widgets, and a CurrentWorkingFolder tweak. `src/utils/colors.ts`, the powerline theme files and `PowerlineThemeSelector` are unchanged versus the parent. Its colour system is the parent's (themes catppuccin/dracula/gruvbox/monokai/nord/one-dark/solarized/tokyo-night in the powerline theme selector, ANSI16/256/truecolor per `ColorLevel`); not re-documented here.

## chandrasekar-r/claude-code-statusline
https://github.com/chandrasekar-r/claude-code-statusline — stars 0
1. Fixed per segment through a theme: five background vars (`BG_DIR BG_GIT BG_MODEL BG_TOKENS BG_COST`) and per-field foreground vars (`SEG_DIR_FG`, `SEG_GIT_FG`, `SEG_MODEL_FG`, `SEG_TOKENS_IN_FG`, `SEG_TOKENS_OUT_FG`, `SEG_CACHE_FG`, `SEG_CACHE_WRITE_FG`, `SEG_COST_FG`, `SEG_TOTAL_FG`, `SEG_RATE_FG`, vim normal/insert) (`themes/neon.sh`, `themes/catppuccin.sh`). Neon: dir blue, git green, model navy 17, tokens purple 54, cost green 22. Rate limits show as dim plain `5h:NN%` in the cost segment's bg (`segments/rate_limits.sh:15-18`): no threshold colours.
2. Themes: 22 bundled files in `themes/` (ashes carbon catppuccin chalk dusk gunmetal midnight minimal mocha mono neon nord obsidian onyx paper-dark pitch retro slate steel tungsten warm-black), wizard orders neon, minimal, mono, retro first. Format: ~17 shell vars (5 bgs with their 256 index twins, per-field fgs). Users: `CCS_THEME=custom` plus `CCS_COLOR_BG_<seg>` overrides (`statusline.sh:46-52`); README says 4 themes (stale).
3. Colour spec: 256-colour indices only (`lib/ansi.sh:8-18`; every bg also stores its raw index for separators). No detection, no NO_COLOR.
4. Fill: background-filled segments with foreground accent per field.
5. Separators: four sets — round `E0B4/E0B6`, sharp `E0B0/E0B2`, slanted `E0B8/E0BA`, bare space/`|` (`lib/separators.sh`). `compose_segments` colours a hard separator fg = previous bg index, bg = next bg; when two adjacent segments share a bg index it emits no separator and the segment prints its own thin divider (`lib/composer.sh:25-34`). End cap uses last bg as fg on a reset bg.
6. Neighbours: different dark-tone backgrounds (e.g. 234/235/236 in catppuccin, three one-step lightness greys) plus the separator; some themes (mono, minimal) use gray steps (240, 244, 236).
7. Contrast: hand-picked fg per field per theme; no calculation; `mono` uses black text on 244 grey for git (`themes/mono.sh`).
8. Glyphs: icon sets nerd3, unicode, ascii (`lib/icons.sh`).
9. Setup wizard (`configure.sh`, `wizard/step_theme.sh`) with scrolling theme list and inline preview, step for font, segments and separators.
10. Customisation: generated `~/.config/claude-statusline/config.sh` (`CCS_THEME`, `CCS_ICON_SET`, `CCS_SEPARATOR_STYLE`, `CCS_SEGMENTS`), wizard, per-segment shell files.

## charlesg3/claude-status
https://github.com/charlesg3/claude-status — stars 0 (statusline for a Neovim/tmux Claude status system)
1. By semantic token in each component: components emit `[[token]]…[[/]]` spans (`scripts/components/*.sh`) and the formatter resolves a token to `statusline.colors.<token>` (`scripts/lib/format.sh:25-60`). Tokens: `working` #6FC1FF, `ready` #55B96D, `error` #C91614, `warning` #FFB86C, `branch` #B1B9F5, `dim` #676B79 (`config/config.json:61-68`). Context bar: ready < warning_threshold (65) < warning < error_threshold (75) < error (`components/context.sh:10-26`); filled blocks coloured, empty `░` dim.
2. Themes: not present; a single semantic role map overridable per key in config (Panda Syntax values, `scripts/common.sh:31-36`). Arbitrary new tokens allowed because resolution is generic.
3. Colour spec: hex -> truecolor only for ANSI output; the same tokens become Neovim highlight groups `%#ClaudeStatus<Name>#` for the vim format (`format_vim`). No depth detection, no NO_COLOR.
4. Fill: foreground-only.
5. Separators: two spaces between components; `[[spacer]]` is a flexible gap between left and right sections.
6. Neighbours: whitespace only.
7. Light/dark: not present.
8. Glyphs: `get_icon` with configurable `statusline.icons.*` (emoji/Nerd), e.g. `🌿`, `↻`.
9. One token format renders to ANSI or Neovim statusline: a clean separation of colour role from sink.
10. Customisation: `config.json` colours/icons/layout JSON, env `CLAUDE_CONFIG_statusline_colors_*`.

## charlomrt-boop/claude-cockpit
https://github.com/charlomrt-boop/claude-cockpit — stars 0
1. Fixed per segment as a background index from config (`src/config.ts:23-34`): model blue 33, cost magenta 129, activity teal 30, agents blue, todos yellow 220, duration gray 245, session darkGray 240; usage cyan 44 normal / orange 208 warning. Threshold segments: context bg green <50, yellow <75, red (`src/segments/context.ts:13-21`); burn rate low/mid/high green/yellow/red. Text colour is white 255 on every segment (`context.ts:30`, `model.ts:7`).
2. Themes: `theme: "default"` exists in the config schema (`config.ts:10`, `:227-230`) but nothing else reads it. The only palette control is per-segment colour overrides in `colors` (`mergeColors`, `:137`). No bundled themes.
3. Colour spec: 256-colour indices (`src/colors.ts`). No detection, no NO_COLOR.
4. Fill: both modes. `powerlineGlyphs` true -> background-filled segments; false -> text on the terminal background where the segment's bg index is used as the text colour, joined by ` | ` in grey 240 (`renderer.ts:45-60`). Default is false (`config.ts:12`), written "the claude-hud style the user prefers".
5. Separators: Powerline `` with fg = this bg, bg = next bg, plus a trailing arrow; ASCII `>` constant exists but is unused in the renderer; or dim ` | ` (`renderer.ts:9-28`).
6. Neighbours: different bg hue per segment plus the arrow.
7. Contrast: white on yellow 220 / orange 208 is weak; no check.
8. Glyphs: `█░` bars, icons from segments, Powerline glyph only if enabled.
9. Layouts: `expanded` two lines vs `compact` one.
10. Customisation: `~/.claude/plugins/claude-cockpit/config.json` (`config.ts:263-270`) with per-segment enable/colour.

## chcardoz/custom-claude-config
https://github.com/chcardoz/custom-claude-config — stars 0
1. By threshold: all bars (context, session, weekly, CPU, MEM) go green <50, yellow <80, red (`color_for_pct`, `statusline.py:313-319`, thresholds from `theme.low_threshold/high_threshold`, defaults 50/80, `:63`). Git: branch cyan, `+n` green, "clean" dim (`:692-697`). Empty/unknown bars dim `░ ——%`. Contribution heatmap uses a 5-step green 256-colour ramp (`CONTRIB_COLORS_256`, `:554-562`: 239, 157, 71, 35, 22).
2. Themes: only the two threshold numbers under `theme` in `config.json`; no palettes.
3. Colour spec: ANSI 16 for bars, 256-colour for the heatmap (chosen on purpose for smaller output, comment `:554`). No NO_COLOR.
4. Fill: foreground-only.
5. Separators: ` · ` between reset times; content wrapped in a rounded Unicode box frame `╭─ title ─╮ │ … │ ╰─╯` (`box_frame`, `:777-804`), uncoloured.
6. Neighbours: boxed rows, labels like `ctx`/`sess`/`week` in plain text.
7. Light/dark: not present.
8. Glyphs: `█░` bars, half-block heatmap, box-drawing, ♫ Spotify.
9. Extras: GitHub contribution heatmap, Spotify now-playing, macOS Focus status, CPU/MEM, stretch reminders.
10. Customisation: `config.json` in the plugin root (`show` toggles, `bar_size`, `theme` thresholds, intervals).

## cheeky-amit/conductor-mod
https://github.com/cheeky-amit/conductor-mod — stars 0
Claude Code mod (a pane/panel), not a statusline; its colour handling is still informative.
1. By role and by state: worker boxes coloured by tier — T0 `permission`, T1 `suggestion`, T2 `merged`, T3 `claude` in the `theme` palette (`hooks/model/config.ts:19-36`, `tierColor` at `:134`); context % ok/amber/red by `contextAmber` (70) / `contextRed` thresholds (`:130-132`, `mini.tsx:28`); status glyph colour per worker state.
2. Themes: two palettes (`PALETTES`, `config.ts:19-55`): `theme`, which names the host's own theme tokens (`claude`, `success`, `permission`, `merged`, `warning`, `error`, `inactive`, `subtle`, `text`, `suggestion`) so light, dark and colour-blind themes all read (comment `:18`); and `pastel`, fixed hex for dark terminals (`main #7dd3fc, gate #86efac, cleared #5eead4, arch #c4b5fd, amber #fcd34d, warn #fca5a5, dim #6b7280, faint #3f4654, text #e5e7eb, ok #3fb950, run #58a6ff, t0..t3 #7ee0c3 #79c0ff #d2a8ff #f2cc60`). Selected by the `palette` option, default `theme`.
3. Colour spec: host theme-token names or hex; depth and NO_COLOR left to the host.
4. Fill: foreground-only text in bordered boxes.
5. Separators: box borders; thin dim text separators.
6. Neighbours: hue by tier; `faint`/`dim` for chrome.
7. Light/dark: the `theme` palette exists precisely to adapt to the user's light, dark or colour-blind host theme.
8. Glyphs: `▲ ◆ ◇ ▶ → ⚠ ○`, time bars.
9. Nothing else.
10. Customisation: mod options (`palette`, thresholds, tier map `T0=haiku,…`, prices) read in `hooks/model/config.ts`.

## chen-rong-zi/tmux-claude-workload
https://github.com/Chen-Rong-Zi/tmux-claude-workload — stars 0 (a Docker workload image; contains a Claude statusline script and a Rust tmux agent tracker "chikuwa")
1. Claude statusline (`home/.claude/statusline/statusline.sh`): fixed per segment — model blue, directory cyan, branch green, git stat added green / removed red, tokens orange with the percentage green, effort: medium orange, high green, xhigh purple, version orange; labels white with dim `(`/`@`/`|` (`:137-163`, `:514`). Threshold colours only for usage: `usage_color` red >=90, orange >=70, yellow >=50, else green, on 5h / 7d / extra-usage (`:44-51`, `:402-461`). The header says the colours match an oh-my-posh theme (`:15`).
2. Themes: none in the shell script. The chikuwa TUI has a 3-colour purple palette plus dim/yellow/red accents (`chikuwa-src/crates/chikuwa/src/ui/theme.rs:5-26`), no selection.
3. Colour spec: truecolor `38;2;r;g;b` in the shell script (`:16-23`); ratatui `Color::Rgb` in Rust. No detection, no NO_COLOR.
4. Fill: foreground-only in the statusline (the TUI selects with a DarkGray bg).
5. Separators: ` | ` in dim (`:372`).
6. Neighbours: hue per field plus dim separators.
7. Light/dark: not present.
8. Glyphs: Nerd Font icons in the Rust TUI (`theme.rs:11-27`), animated spinner frames `· ✢ * ✶ ✻ ✽` and face emojis escalating with wait time (`theme.rs:52-90`).
9. The chikuwa TUI animates status icons; time-escalated emoji frames for permission waits.
10. Customisation: edit the script / Rust consts; the repo only bakes them into a Docker image.

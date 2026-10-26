## claude-cli-mod
https://github.com/iagopadilha/claude-cli-mod — stars 0
A Claude Code mod (plugin hooks module, Ink `<Text color>` elements), not a plain statusline command. It recolours Claude Code itself and also draws its own status row under the prompt.
1. Segment colour, in `hooks/register.tsx` `drawPromptHintRow` (about l.1495-1560) and `hooks/lib/status.ts:4-14`. Fixed per segment: model + effort = `STATUS_CYAN #22d3ee`, git branch = `STATUS_GREEN #22c55e`, separators and token counts = `dimColor`, account tag = `ACCOUNT_KIND_COLORS[kind]` (bold). By state: `colorFor(percent)` is >=90 red `#ef4444`, >=70 yellow `#eab308`, else green. It is used for the context % and each rate-limit % (`ctx`, `5h`, `7d`) and their bars. Cache state: kept = cyan, warm = green, cooling = yellow bold, cold = red or dim (`register.tsx:719-722`). Effort has its own heat ramp, `lib/modes.ts:6-12` (low `#38bdf8`, medium `#a3e635`, high `#fbbf24`, xhigh `#f97316`, max = rainbow).
2. Themes: not for the status row. The mod's "themes" are terminal palettes, scraped from terminalcolors.com as Warp-format YAML (`lib/palette.ts:16-49`, `register.tsx downloadThemes` l.223). The mod converts each palette to a full Claude Code custom theme JSON written to `~/.claude/themes/claude-cli-mod.json` (`toClaudeTheme`, `palette.ts:81-161`). That maps about 60 Claude Code colour tokens from 9 palette roles (fg, bg, accent, ANSI normal/bright): `claude`=accent, `success`=green, `error`=red, `warning`=yellow, `text`=fg, `diffAdded`=`mix(bg, green, .22)`, and so on. It also builds shimmer twins (`mix(c, fg, .35)`), `isLight()` to pick the base theme, and a rainbow_* set. Users get any theme from the site. There are also 'zen' themes (`ZEN_THEMES`) and a rainbow title.
3. Truecolor hex only (`#RRGGBB`), plus Ink named colours (cyan, red). Also recolours the terminal itself through OSC 4/10/11/12 (`oscFor`, `palette.ts:250`) or Windows Terminal `settings.json` schemes. Depth detection and NO_COLOR: not present.
4. Foreground only on the status row (`<Text color>`, `dimColor`). Fill appears only in the generated Claude Code theme (message backgrounds are `mix(bg, fg, 0.08)`, `mix(bg, magenta, 0.08)`, etc., `palette.ts:147-158`).
5. Separators: plain text `' │ '` dim and `' · '` (`register.tsx` `const sep = <Text dimColor>{' │ '}`). Not coloured by neighbour.
6. Neighbours are told apart by separator glyph plus the fixed hues in item 1. Not present as a lightness-step or alternating system.
7. Light/dark: `isLight(bg)` (luma > 140, `palette.ts:69`) sets the base theme of the generated Claude theme. `inverseText` = bg. No contrast-picking for status text.
8. Glyphs: block bars `█`/`░` (BAR_WIDTH 10, `status.ts:8`), `●` for the cache dot, `▰` effort meter. No Nerd Font or ASCII modes. Emoji used in menus.
9. Notable: rainbow (letter-by-letter `RAINBOW[i % n]`, `register.tsx:975`), shimmer animation tokens, a theme browser/search UI in the mod menu, live theme write that Claude Code reloads.
10. Customisation: the mod's own menu (`/tools`), themes dir `~/.claude/claude-cli-mod/themes/*.yaml`, i18n (`lib/i18n.ts`). Status line on/off toggle. No config-file colour map.

## name-navigator
https://github.com/ibragimov-oasis/name-navigator — stars 0
not a Claude statusline: a Vite/React/shadcn web app ("Name Navigator", anthroponymic data platform, `package.json` name `vite_react_shadcn_ts`). The scanner hit vendored third-party Claude assets under `.claude/` (claude-hud, GSD, ruflo, supermemory, impeccable). The one repo-authored statusline, `.claude/helpers/statusline.cjs` (52 lines), prints uncoloured emoji text (`📝 N files | ✅ N tasks | 🤖 N agents | 🔧 Vibe-Coder`), no ANSI at all. Vendored copies belong to other projects.

## understatus
https://github.com/ictechgy/understatus — stars 0
A Rust statusline binary that appends a CPU/memory/network HUD to Claude Code (and Codex, cmux) status lines, chaining another statusline.
1. Colour per element, by "COLOR-ONCE" rule (`src/render.rs:6-13`): only the load glyph is coloured; segment values (58%, $1.23, model, branch, cwd) have no colour (terminal default); labels/units use dim `label_color`; separators use darker `separator_color`. The glyph colour is by state: CPU % -> band index 0-4 (`theme.rs band_index`, thresholds 25/50/75/90) -> `band_tints[band]`. An optional pulse breathes the tint (`theme.rs pulse_color`, calm/flash/hue/swap) with hysteresis 90/80. Exception: a rate-limit segment above its threshold gets the critical tint on its value (`warn_colored_segment`, render.rs:447). cmux pills use fixed hexes per metric: model `#7AA2F7`, ctx `#34D399`, mem `#A0A0A0`, git `#F1502F` (render.rs:482-535).
2. Themes: 9 bundled presets in `src/themes.rs:40-50`: calm (default), mono, vivid, ember, emoji, neon, aurora, sunset, spectrum. Each preset is a bundle of 8 fields (`ThemePreset`): `load_glyphs` (5), `pulse_style`, `band_tints` (5 hex), `pulse_palette` (2 hex), `label_color`, `separator`, `separator_color`, `hud_seam`. Format is a per-field colour map (state ladder), not semantic roles. User TOML keys override any theme field (`config.rs apply_theme` l.465: only keys not in the raw TOML are filled). Users can set every field themselves. Example calm tints: `#5a6878 #6d8296 #86a0b4 #9fbfce #b87848`; vivid is a traffic-light ladder `#2f9150 ... #e34a3a`.
3. Truecolor `38;2;r;g;b` or 256 index via `nearest_xterm256` (render.rs:786); `[color] mode` = auto/truecolor/256/none; auto reads `COLORTERM` (render.rs:774-784). NO_COLOR honoured (render.rs:117, `NO_COLOR` set -> zero ANSI bytes, tested at l.973).
4. Foreground only. No background fills. It explicitly never emits bold (`\x1b[1m`, render.rs:13).
5. Separators: plain ` · ` in `separator_color`; a `│` HUD seam between its own output and the chained statusline (`render_seam`, l.869). No powerline caps.
6. Neighbours distinguished by separator and by colour-less values vs dim labels. No hue difference.
7. Light/dark adaptation: not present (single palette per theme; `calm` assumes dark).
8. Glyphs: load ramp `○ ▁ ▄ ▆ ◆` (calm), `░▒▓██`, dots, or emoji faces `😌🙂😅🥵🔥` (emoji theme, 2-cell width handling). Pulse swap style flips filled/hollow glyphs.
9. Notable: calm "breathing" pulse as a pure function of time with hue-rotate (`hue`/`swap`) rainbow shimmer in neon/spectrum (`theme.rs hue_rotate`), pill colours for cmux sidebar.
10. Customisation: `config.toml` (`theme = "vivid"`, `[color]`, `[cpu]`, `[pulse]` sections), CLI `pulse` command validates styles, install subcommands (`src/install.rs`), npm and Homebrew distribution.

## claude-code-statusline (IFAKA)
https://github.com/IFAKA/claude-code-statusline — stars 0
1. By state: context % picks one colour for the glyph and number, `statusline.sh:19-25` (<50 green `\033[32m`, <80 yellow `33`, else red `31`). Everything else uncoloured: `[Model] ◉ NN% | NNk↓ NNk↑`.
2. Themes: not present.
3. ANSI 16 only. No depth detection, no NO_COLOR.
4. Foreground only.
5. Separator: plain ` | `, uncoloured.
6. Neighbours: separator only.
7. Light/dark: not present.
8. Glyphs: `◉`, `↓` `↑`. No icon modes.
9. Nothing else (28-line script).
10. Customisation: edit the script. `install.sh` / `uninstall.sh` only.

## claude-code-plugin-marketplace
https://github.com/ikmski/claude-code-plugin-marketplace — stars 0
A marketplace of plugins; only `plugins/statusline` is a statusline. `chrome-devtools` and `design-system` (`_ds_bundle.js`, `deck-stage.js`) are unrelated (the large colour counts came from the design-system bundle). Statusline section:
1. `plugins/statusline/scripts/statusline.sh:42-60` (ANSI, pure bash): fixed per segment: directory = bold blue `1;34`, git branch = bold green `1;32`, separators dim `2`. Other segments (model, context %, 5h/7d, duration, tokens, cost) use the default foreground. By state: rate-limit segments (`rl_add`) turn bold red `1;31` at >=80%.
2. Themes: not present.
3. ANSI 16 + bold/dim. No depth detection, no NO_COLOR.
4. Foreground only.
5. Separator: dim `|`, added only between segments that have data (`add()`).
6. Neighbours: dim `|` plus per-segment Nerd Font icon label.
7. Light/dark: not present.
8. Nerd Font icons per segment, defined as escapes (`i_git=$'\UE725'`, `i_model`, `i_ctx`, `i_session`, `i_tokens`, `i_cost`, `i_rate`). No ASCII fallback.
9. Nothing else.
10. Customisation: edit the script; plugin manifest `.claude-plugin/plugin.json`.

## breather
https://github.com/ilandahan/breather — stars 0
A "take a break" presence tracker whose statusline (`hooks/statusline.mjs`) shows rest/usage countdowns.
1. State/zone colour from 4 raw ANSI codes (`statusline.mjs:7`: green `32`, amber `33`, red `31`, grey `90`). Rest segment: red if zone is "boundary", green if "quiet", else amber (l.52). Stretch ("no break"): amber, red from `NO_BREAK_RED` (l.72). Usage: `c` by percent; week amber, red >=90; spend red >=100 (l.105-111); `api billing` / `extra usage` red; context % coloured by `c`; labels, model, arrows, sessions count grey.
2. Themes: not present.
3. ANSI 16 only; no truecolor, no NO_COLOR.
4. Foreground only.
5. Separators: grey ` · ` between items, grey `  │  ` between head and tail (l.147-150).
6. Neighbours: separator and state colour. No other scheme.
7. Light/dark: not present (uses bright-black `90` for dim).
8. Glyphs: `▓`/`░` bars (l.30), `→`, `☾` at night. Unicode only.
9. Per-segment toggles via an option object; width trimming at `NARROW_COLS = 75` using `COLUMNS`.
10. Customisation: options in `install.mjs` and the hook option object (`o.bar`, `o.arrow`, `o.moon`, `o.cost`, `o.resets`); no colour config.

## claude-statusline (illumin8ca)
https://github.com/illumin8ca/claude-statusline — stars 0
Fork of Owloops/claude-powerline (package.json: "Forked from Owloops/claude-powerline"). It is not labelled FORK in the batch, so the full picture follows.
1. Fixed per segment through the theme: each segment key (`directory, git, model, session, block, today, tmux, context, contextprogressbar, metrics, version`) has its own `{bg, fg}` (`src/themes/index.ts` `ColorTheme`; `src/powerline.ts getThemeColors` l.354+). By state, overriding the theme: `context` segment bg by usage: >=80 `#dc2626`, >=60 `#ea580c`, >=40 `#ca8a04`, else `#16a34a` (`segments/renderer.ts:327-345`); the context progress bar fg is green `#22c55e` / yellow `#eab308` / red `#ef4444` / grey `#6b7280` (renderer.ts:371-382) on a `#666666` bg. Budget warning thresholds (default 80) on session/today cost.
2. Themes: 5 bundled (`BUILT_IN_THEMES`: dark, light, nord, tokyo-night, rose-pine; `src/themes/index.ts:44-50`). Format is a per-segment colour map, 11 keys, each `{bg, fg}` hex. Users define their own with `"theme": "custom"` and `colors.custom` in the JSON (`.claude-powerline.json` ships a grey-ramp custom theme). Dark: directory `#8b4513`, git `#404040`, model `#2d2d2d`, session `#202020`, ... Missing keys fall back to the dark theme.
3. Truecolor hex only (`utils/colors.ts hexToAnsi` `38;2` / `48;2`); `transparent`/`none` bg maps to `49`. No depth detection or downsampling; no NO_COLOR.
4. Background-filled cells with fg text (powerline); `contextprogressbar` has a transparent bg.
5. Separator: one `symbols.right` glyph (`">"` ASCII in powerline style; empty string in minimal style, `powerline.ts:327`). Its colours: fg = previous segment's bg, bg = next segment's bg (`formatSegment`, powerline.ts:477-490; `extractBgToFg` turns the `48;2` code into `38;2`). Last segment arrow ends on terminal bg.
6. Neighbours are told apart by each segment's own distinct bg in the theme (dark theme is a ladder of near-greys with a brown directory; light/nord are multi-hue) plus the arrow. No alternating or generated shading.
7. Light/dark: a `light` theme (white fg on saturated bgs, black fg on pale model bg), chosen by name. No detection and no automatic contrast.
8. Glyphs: ASCII/unicode symbols (`⎇ ⚡ ✓ ● ⚠ ↑ ↓ ⧉ ⌂ ♯ → ⧇ ◷ § ◱ ☉ ◔ ⧖ Δ ⧗ ⟐ ⟢ ◈`, powerline.ts:326-348). No Nerd Font requirement.
9. Multi-line layout (`display.lines[].segments`), `style` powerline or minimal, per-segment options (git sha, tag, stash, upstream, repo name, time since commit), cost/token budgets.
10. Customisation: JSON config (`.claude-powerline.json` / `.claude-statusline.json`), `--config`, `--style` flags.

## flux-code
https://github.com/im-shubhamsharma/flux-code — stars 0
1. By state, with some fixed: `CTX`, `5H`, `7D` segments are coloured from percent via `colorForPercent` (green < yellow 60 <= yellow < orange 80 <= orange < red 90, `colors.ts:70-80`, thresholds `config.colorThresholds` default `{yellow:60, orange:80, red:90}`, `config.ts:52`); unknown value = gray. Powerline fixed per segment as 256 indexes (`renderer.ts:216-290`): model bg 24 (blue), branch 240, cost 22 (green), lines 238, duration 236, burn rate 22, repo 54 (purple), dirty count 130 (orange, black text), tokens 240, version/output style/effort 238, `supa` project `rw` 88 / else 22; percent segments `bg256ForPercent` (34/220/208/196, 240 for null), black text.
2. "Themes" are layouts, not palettes: 5 (`minimal`, `powerline`, `nerd-font`, `plain-text`, `compact` default; `renderer.ts:407-418`). No colour themes; users change the thresholds only.
3. ANSI 16 (red/green/yellow/blue/cyan/magenta/gray 90), 256 index (orange 208, powerline bgs). Colour gated on `useColors` and `NO_COLOR` (any non-empty value disables, `statusline.ts:81-83`), never on isTTY. `plain-text` forces colour off (renderer.ts:404). No truecolor.
4. `powerline`: background fills; the other layouts: foreground only.
5. Powerline separator U+E0B0 (`icons.ts:84`), fg = this segment bg and bg = next segment bg; last gets fg only (`renderer.ts:285-296`). Other layouts use plain text separators.
6. Powerline: distinct fixed bg per segment kind (greys for secondary ones so they merge visually); compact: separators only.
7. Light/dark: not present (black text on bright bgs, white on dark bgs, hard-coded).
8. Glyph sets: `NERD_ICONS`, `EMOJI_ICONS` (`icons.ts`), `config.useIcons`, ASCII-only plain-text theme.
9. Progress bar helper (`progress.ts`), blink helper exists in `Ansi.blink`; countdown/notify.
10. Customisation: JSON config at `~/.claude/flux-code.json` or `FLUX_CODE_CONFIG`; `show*` toggles for every segment; CLI (`src/cli.ts`).

## claude-code-statusline (immanewel)
https://github.com/immanewel/claude-code-statusline — stars 0
1. By state: only the context text, via a 4-step threshold (`statusline.ps1:25-28`): <50% dim `2m`, <80% default `0m`, <95% yellow `33m`, else red `31m`. The whole string `ctx: Nk / 200k (N%)` takes that colour.
2. Themes: not present.
3. ANSI 16 plus dim. No detection, no NO_COLOR.
4. Foreground only.
5. Separators: not present (single segment).
6. Neighbours: not applicable.
7. Light/dark: not present (dim at low usage assumes any bg).
8. ASCII text only.
9. PowerShell, 34 lines; hard-coded 200000 max.
10. Customisation: edit the script; `install.ps1`.

## buddy-forever
https://github.com/inaaa821-design/buddy-forever — stars 0
A Tamagotchi-style pet statusline (species art, XP, moods), not a conventional metrics statusline.
1. Fixed by pet property (`lib/render.js:14-33`): pet name coloured by rarity (common white 37, uncommon green 32, rare blue 34, epic magenta 35, legendary yellow 33), mood label coloured by mood (content cyan 36, happy green 32, excited 93, worried 33, scared 91, sleepy 90, celebrating 95), level / quip / context bar dim.
2. Themes: 4 (`THEMES` at render.js:36): `classic` (16-colour SGR above), `pastel` (256-colour pastel indexes, e.g. rare `38;5;110`), `neon` (bright 9x codes, bold on scared/celebrating), `mono` (no codes at all). Format: per-property maps (`rarity`, `mood`, `dim`). Pets and quips are user-extensible; theme colours are config-selectable (`cfg.theme`) but not user-definable beyond these four.
3. ANSI 16, ANSI bright, 256 index. `NO_COLOR` honoured (`colorsEnabled`, render.js:54-57); `mono` also disables colour. No downsampling.
4. Foreground only.
5. Separators: plain-space layout; no coloured separators.
6. Neighbours: different semantic colour per part (rarity vs mood vs dim).
7. Light/dark: not present.
8. Glyphs: emoji accessories (`🎩 👑 🎀 🧙 🌱 🧣`), `✨` shiny, `▰▱` context bar, per-species multi-frame ASCII/Unicode art (`lib/species.js`), animation frame by time (`FRAME_MS` 1200).
9. Animation: idle frame cycles by time; mood from a simulation (`lib/sim.js`).
10. Customisation: `~/.buddy` state and config via `bin/buddy.js` CLI (theme, accessories, quips, species roster).

## 5-mods
https://github.com/inematds/5-mods — stars 0
A bundle of five Claude Code mods (cache-keeper, collision-guard, goal-meter, next-steps, recording-mode); Ink `<Text>` bands, not a command statusline.
1. By state, named colours via the host's Ink theme (`color: 'red'|'yellow'|'cyan'|'green'`, `dimColor`, `bold`): cache-keeper band: `● cache warm` green, `◐ cache cools in` yellow bold, `○ cache cold` red bold (when context is big) or dim, `◆ kept warm` cyan (`cache-keeper/hooks/register.mjs:719-722`); context/usage tone from percent: >=95 red bold, >=80 yellow, else dim (l.223-225). goal-meter: met = green, in progress = cyan, goal-check-not-met yellow (`goal-meter/hooks/register.mjs:522,564`). next-steps header cyan; recording-mode `● REC` red bold, with `REC_RED #e5484d` (recording-mode register.mjs:39).
2. Themes: not present (inherits Claude Code's theme through named colours).
3. Ink named colours + one hex; depth/NO_COLOR left to the host.
4. Foreground only.
5. Separators: dim ` │ ` text.
6. Neighbours: separator and state colour.
7. Light/dark: relies on host theme; privacy mod `hooks/privacy.mjs` unrelated.
8. Glyphs: `█`/`░` bars, `●◐○◆` state dots, `└`.
9. Notable: pure text; shared `fmt.mjs` copied into each mod.
10. Customisation: slash commands (`/<name> hide|show|strict`) per mod; no colour config.

## claude-statusline (insidehand)
https://github.com/insidehand/claude-statusline — stars 0
Go binary (`statusline/statusline.go`) with a bash twin (`statusline.sh`), plus a `todo-panel` mod (`mods/todo-panel/hooks/register.tsx`, host theme colours `claude`, `warning`, `subtle`, `inactive`, `success`).
1. By model family (fixed): Opus gold `38;2;195;158;83`, Sonnet teal `118;170;185`, Haiku pink `255;182;193`, other grey `192;192;192`, each with an emoji (💛 💠 🌸 🤖; `statusline.sh:40-45`, go l.29-32). By state: a 4-step ramp for context/rate/waste (`CTX_GREEN 108;167;108`, `GOLD 188;155;83`, `ORANGE 210;120;60`, `RED 185;102;82`): context % <=25 green, <=50 gold, <=75 orange, else red (`used_pct_color`, sh:49-56; go l.537-585). Rate-limit "waste urgency" = (100 - used%) x elapsed/window picks the same ramp (`waste_urgency_color`). Message text (the last assistant line, `>` quoted) green `152;195;121`; empty bar cells and `[N x]` live counter dark grey `64;64;64`.
2. Themes: not present (constants in script).
3. Truecolor `38;2;r;g;b` only. No downsampling, no NO_COLOR.
4. Foreground only.
5. Separators: plain ` | ` (go l.345).
6. Neighbours: separator only; muted earthy palette keeps ramp colours subtle.
7. Light/dark: not present (the palette is tuned for dark; `64,64,64` grey disappears on dark-grey bgs).
8. Glyphs: model emoji, `█`/`░` bar, `Δ`, `[N x]`.
9. Muted earth-tone palette is the stylistic feature; shows the last assistant message under the bar.
10. Customisation: edit constants; Go build via `build.sh`, `install.sh` offers go or bash variants and installs mods.

## claude-statusline (Insulince)
https://github.com/Insulince/claude-statusline — stars 0
1. By state through three helper ramps (`statusline.py:53-71`): context `pct_color` (>=90 bright red `91`, >=75 red `31`, >=50 yellow `33`, else green `32`), rate limits `rate_color` (>=85 red, >=65 yellow, else green), cost `cost_color` (>=$20 red, >=$10 yellow, else green; None = dim). Fixed: model name bold cyan; "Pace" label coloured red (overconsuming), blue (underconsuming), green (on target) with a log-ish `*` marker in white for noisy values; resets and times white; unavailable = dim. Bars coloured the same way as their numbers (`make_bar(color_fn)`). The non-active rate bar is dimmed when the other window is in "extra usage" (`dimmed`).
2. Themes: not present.
3. ANSI 16 + bright; no detection, no NO_COLOR.
4. Foreground only.
5. Separator `SEP` = dim white `│` (`statusline.py:41`), with two spaces around it.
6. Neighbours: dim `│` and the state colours. Output spans two lines plus a blank.
7. Light/dark: not present (white `37` used as "bright" text).
8. Glyphs: `█`/`░` bar of scaled width (`scaled_bar_width`, py:19), `↻`, `—`.
9. Pace/surplus analysis with asymmetric grace windows (`GRACE_OVER_SECONDS 12h`, `GRACE_UNDER 24h`).
10. Customisation: edit Python constants; `statusline-command.sh` just dispatches to python3/python.

## composer-meter
https://github.com/ioctlLR/composer-meter — stars 0
A Claude Code mod band showing a meter (Ink `<Text>`), not a command statusline.
1. Band colours from `hooks/band.ts:62-64`: `BandColors {accent, fg, muted}`. Dark = Dracula (`accent #bd93f9`, `fg #f8f8f2`, `muted #6272a4`), light = `accent #685189`, `fg #1f1f1f`, `muted #6b6b6b`. Bars use `accent` (normal) or the host's `warning`/`error` tone colours; the percent is plain below 80, `warning` from 80, `error` from 95 (`meterTone`, `hooks/band.ts:30`). Cache TTL piece tone `normal`/`warning`/`error` by minutes left (WARN 4 min, DANGER 2 min before expiry). Cost and model values use `fg`; their labels `muted` (register.tsx:489-506).
2. Themes: two palettes only (dark Dracula / light), chosen from Claude Code's `theme` config row (`register.tsx:153-158`: the name contains "light"). Format: 3 semantic roles. Not user-definable.
3. Hex for accent/fg/muted; named host tones (`warning`, `error`) for alert colours. Depth/NO_COLOR left to host.
4. Foreground only.
5. Separators: dim `·` and `&` text.
6. Neighbours: muted label + bright value pairs.
7. Light/dark: yes, explicit (palette swap keyed to Claude Code's theme, refreshed on theme change, `refreshTheme`).
8. Glyphs: `▰▱` bars (CELLS wide).
9. Pulses nothing; meter label modes.
10. Customisation: mod options in plugin manifest; no colour option.

## statuscraft-cli
https://github.com/israel-gs/statuscraft-cli — stars 0
An interactive generator (`index.js`, prompts + chalk preview) that writes a bash statusline script (`generator.js`, `items.js`).
1. Fixed per item, user-changeable: each item has a default colour (`items.js` `defaultColor`: model 36 cyan, context_pct 33 yellow, tokens 35 magenta, cost 32 green, git_branch 36, git_status 33, ahead/behind 34 blue, cwd 34, time/session/duration 90 gray, etc.). By state: items with `autoColor: true` (context %, context bar) override by percent via `autoColorBlock` (`items.js:32-48`): <40 green `32`, <70 yellow `33`, else red `31`. The user picks any colour per item in the wizard.
2. Themes: 5 presets in `themes.js`, each a list of `{id, color, autoColor, mode}` plus a separator: minimal, developer, git_focused, full, compact. Format: per-item colour map. Users pick their own item colours and separators in the wizard (custom).
3. ANSI 16 (14 choices: cyan, green, yellow, red, blue, magenta, white, gray 90, bright reds/greens/yellows/blues/magentas/cyans 91-96, `items.js:4-18`), always emitted as `\033[01;<code>m` (bold). No 256/truecolor, no NO_COLOR.
4. Foreground only.
5. Separator: one chosen glyph per theme or user (`│`, `•`, `›`...), joined with spaces, uncoloured (`generator.js:25,44`).
6. Neighbours: separator plus the per-item hue the user chose.
7. Light/dark: not present.
8. Glyphs: emoji in the wizard UI; separators and `↑↓` in output.
9. Colour picker UI with emoji-swatch labels in the wizard (`ANSI_COLORS` labels), backups of the existing settings (`backups.js`), custom prompts.
10. Customisation: interactive CLI wizard, resulting bash script and settings.json entry; no file format to hand-edit besides the generated script.

## claude-code-usage-bar
https://github.com/itsdadelous/claude-code-usage-bar — stars 0
1. By state on bars only (`statusline.sh:100-141`): base is terracotta (256 index 173) below 60%, yellow 220 from 60, orange 208 from 80, red 196 from 90. Anthropic's own `severity` field can only escalate (critical -> red, warning -> orange at least). Unfilled bar cells are dim; "resets ..." text dim.
2. Themes: not present.
3. 256-colour indexes (`38;5;N`) plus dim. No detection, no NO_COLOR.
4. Foreground only.
5. Separator: dim ` | ` (`sep`, sh:148).
6. Neighbours: dim `|`.
7. Light/dark: not present.
8. Glyphs: 10-cell bar from filled/unfilled characters (fill = val*10/100).
9. Severity-escalation rule is the distinct feature.
10. Customisation: edit script.

## ccline
https://github.com/itzTiru/ccline — stars 0
1. Fixed per segment with bold ANSI 16 (`bash/statusline.sh:23-30`): git branch cyan `1;36` with yellow `*` when dirty, AWS profile yellow `1;33` (`☁`), model magenta `1;35`, 5h limit / duration / diff counts dim. By state: cost grey, then yellow above $1, red above $5; context % green, yellow at `CONTEXT_WARN`, red at `CONTEXT_ALERT` (configurable); `⚠200k` yellow. PowerShell twin has the same mapping (`powershell/statusline.ps1:43-156`).
2. Themes: not present.
3. ANSI 16 (bold variants) + dim. No detection, no NO_COLOR.
4. Foreground only.
5. Separators: pipe from the `push` helper, plain.
6. Neighbours: fixed hues per segment (cyan, magenta, yellow, green).
7. Light/dark: not present (`GRAY` is `0;37`).
8. Glyphs: `⎇`, `☁`, `⏱`, `⚠`.
9. Cross-platform (bash + PowerShell) parity.
10. Customisation: thresholds in config (`CONTEXT_WARN`, `CONTEXT_ALERT`); `setup.sh`/`setup.ps1` scripts.

## claudestatus
https://github.com/ivan-moskvin/claudestatus — stars 0
A Rust statusline plus a Divoom pixel-display panel renderer.
1. By state (all 256-index): bar colours GREEN 35, ORANGE 214, RED 167 (`src/statusline.rs:27-29`). Context colour = worse of share-of-window (60% orange, red threshold constant) and absolute tokens per model family (`CONTEXT` table, e.g. opus-4-7 orange at 120k, red at 200k; `context_color`, l.344). Rate windows are coloured by pace: `pace_level` forecasts usage to the reset (>100% orange, >130% red) and falls back to 60/85% thresholds with no reset time (l.300-340). Fixed: the reset bar is CYAN 38 ("shows time, not risk"), weekly elapsed strip 245 grey, update marker 178; model name + effort glyph coloured by effort: low 245 `○`, medium 111 `◔`, high 141 `◑`, xhigh 171 `◕`, max 199 `●` (purple-to-pink so it never reads as green/orange/red, l.43-50).
2. Themes: not present. i18n only. The pixel panel uses fixed `CLAUDE Rgb(0xd9,0x77,0x57)` plus the same level colours.
3. 256-colour indexes (`\x1b[1;38;5;N m`); backgrounds `48;5;N`. No detection, no NO_COLOR (the match `env.256color` is a code comment).
4. Both: labelled bars are background-filled cells with the label centred inside (`labeled_bar`, l.247): filled part in level colour, remainder `EMPTY_BG 237` / `EMPTY_FG 250`. Text on the fill is `DARK_TEXT 16`, or `LIGHT_TEXT 231` on RED (`text_color`, l.284): a hand-picked contrast rule.
5. Separators: plain text parts joined; braille blank `U+2800` used as indent.
6. Neighbours: separate hue families by meaning (level colours vs. purple effort vs. cyan reset vs. grey strip).
7. Text contrast: explicit per-fill rule above; no light/dark detection.
8. Glyphs: effort circles, braille indent, `‾` strip, `↑` update marker.
9. Distinct: pace-forecast colouring rather than raw percent; model-specific recall thresholds; a physical Divoom panel renderer (`src/panel/render.rs`) with sparkle icon.
10. Customisation: panel `divoom.json` config (device ip, screen, port); no style config; Russian i18n.

## NeonMeter
https://github.com/IvanPavlak/NeonMeter — stars 0
A Claude Code band mod (and optional desktop widget) drawing usage meters in neon colours.
1. By state through a six-colour range ramp (`hooks/builder.ts` `THEMES`): dark `ramp #1E90FF, #39FF14, #00D45A, #FFF01F, #FF5F1F, #FF073A`; light `#1874D2, #32A800, #139A43, #A89200, #E84A00, #E8001F`; lower bounds of ranges 2-6 default `[50,60,70,80,90]` (`DEFAULT_BOUNDS`); a percent picks `ramp[rampIndex(pct)]`. `barColoring: 'level'` colours every cell with the percent's range, `'ramp'` runs through each range up to the percent's in equal stretches (`cellColor`, builder.ts:464-470). `resetColor: 'time'` colours a window's reset time through a second set of bounds (`DEFAULT_TIME_BOUNDS [17,33,50,67,83]`). Context bar can be split per category with six category colours (`DEFAULT_PART_COLORS`: messages `#1E90FF`, system/tools `#FF5F1F`, MCP `#00D45A`, skills `#FFF01F`, other `#39FF14`, buffer `#6E7681`). Neutral/stale `#6E7681`.
2. Themes: two palettes, `dark` and `light` (`Palette { bg, text, track, neutral, ramp }`, `THEMES` at builder.ts:54); `theme: auto|dark|light`, separate `desktopTheme`. Users override the six range colours, `colorsLight`, `contextColors`, `contextColorsLight`, bounds, cell glyph, in options (`register.tsx` `DEFAULTS`/`pick`).
3. Hex `#RRGGBB` only; blends toward the ground are precomputed by `mix(color, ground, strength)` (`hooks/color.ts:22`), no terminal dim/alpha. No depth detection or NO_COLOR.
4. Foreground-only bar cells in the terminal; desktop widget draws dots or solid bars.
5. Separators: horizontal rule glyph `─`/`━` row (`RULE_GLYPH`, `FRAME_GLYPH`); `RULE_KEY = 'promptBorder'` follows the host's border colour.
6. Neighbours: separated by label and the colour of the range each value falls into.
7. Light/dark: explicit; theme detection `paletteOf` reads Claude Code's `theme` row (name contains "light", `register.tsx:371`), with a manual override. Light palette uses darker, more saturated ramps for contrast on white.
8. Glyphs: `━` bar cell (user-settable single-width char), `◉` button, no emoji in bars.
9. Animation: pulse (`pulseForeground`: colour blended toward white up to 45% at the peak of an 8-frame cosine cycle, `pulseMode: responsive|always`), halo/glow under desktop bars, stale cells fade to 45% opacity, benchmark scripts for performance.
10. Customisation: mod options (theme, ramps, bounds, bars, pulse, labels full/short), install scripts for unix and Windows, `design/readme` generator for screenshots.

## token-tracker
https://github.com/iYuXiaoyan/token-tracker — stars 0
A token/cost tracker CLI (`tt`) with a statusline template, a sidebar, daily heatmap and wizard.
1. Statusline colours are semantic keys mapped to palette slots (`ui/themes.py:60-79` `_STATUSLINE_SLOTS`): project=green, branch=red, added=green, deleted=red, untracked=mauve, label=pink, bar_ok=green, bar_warn=yellow, bar_danger=red, tokens=peach, total=red, duration=blue, model=blue. By state: bar colour by percent (`color_by_pct`, `templates/claude_statusline.py:57`: <50 ok, <80 warn, else danger).
2. Themes: 6 bundled (`THEMES`: mocha, latte, frappe, macchiato, nord, dracula). Format: 9 base colour slots (Catppuccin names: overlay0, green, yellow, peach, red, blue, sapphire, mauve, pink) + `is_light` + a 5-step heat ramp (explicit for mocha/latte, else interpolated cell->green); 17 CLI semantic slots and 13 statusline keys are derived from the 9 slots (`derive_slots`). Themes are baked into the statusline script at setup. Users pick via `tt theme`/wizard; adding a theme is a code edit (no user theme file).
3. Truecolor `38;2` and 256 `38;5;N` (nearest in 6x6x6 cube or greyscale, `_hex_to_256`); `COLORTERM` truecolor/24bit selects truecolor, otherwise 256 (`claude_statusline.py:14-17`); 8-colour no longer supported. NO_COLOR: not present.
4. Foreground only.
5. Separators: plain text; labels pink, values coloured; project name bold in brackets `[name]`.
6. Neighbours: distinct fixed hue per field (green project, red branch, peach tokens, blue model/duration).
7. Light/dark: yes. `resolve_theme` order: `TT_THEME` env, config, then `COLORFGBG` auto (last field > 8 means latte, else mocha; `config.py:116-125`); `is_light` per theme.
8. Glyphs: `█`/`░` bars, East-Asian-width aware width calc; sidebar/split panes for Ghostty and iTerm.
9. Heatmap contribution graph with percentile-bucket colours (25/50/75), theme preview (`preview_theme`), screenshot-themes image in assets.
10. Customisation: `~/.../config.json` (`theme`, `lang`), `TT_THEME` env, wizard (`wizard.py`), i18n.

## oh-my-statusline
https://github.com/j2h4u/oh-my-statusline — stars 0
Python statusline plus a TUI theme editor in the same file (`omcc-statusline.py --theme`).
1. Semantic tokens (`class T`, py:229-247): dir_parent 239 (dim grey), dir_name 243, branch 66 (muted teal), git_dirty dim 3, git_staged dim 2, git_untracked 3, git_ahead 6, git_behind 5, ok 22 (dark green), warn 94, wait 27, none 237, notif 6, sep 241, err 88, lim_time 239, lim_bar_bg bg 236. Usage bars/numbers coloured by a named ramp (`RAMP_PRESETS`, py:125-132): aurora, traffic, twilight, ember, spectrum, heatmap, each a piecewise list of (percent, 256-index) waypoints interpolated per percentage (`_multi_ramp_color`, l.849); defaults: 5h and 7d = spectrum, context = aurora. Pace delta is coloured in OKLCH, log-scaled teal (under budget) or orange (over) (`_pace_delta_color`, l.908).
2. Themes: one theme with 18 overridable tokens (`ELEMENTS` list, l.287-305: each has `fg`, `bg`, `attrs`), selected ramps by setting. Users edit every token in the TUI or in `config.json` `theme` (validated: fg/bg 0-255, attrs from 13 SGR attributes incl. curly/dotted underline, blink, reverse). No named multi-theme bundle.
3. 256-colour index for tokens (`fg256`/`bg256`); truecolor RGB for OKLCH output (`fg_rgb`, l.148). No depth detection; `FORCE_COLOR=1` is set when it shells out (l.1742). NO_COLOR: not present.
4. Both: bar background token `lim_bar_bg` (bg 236) behind coloured fill; most text foreground-only.
5. Separators configurable: `separator` (default `⋮`), `git_separator` (`·`), `limits_separator` choices (`SETTINGS_DEFS`, l.401-409); coloured by token `sep` (241).
6. Neighbours: separator glyphs and per-token hues; lower-contrast greys for structural parts, so data stands out.
7. Light/dark: not present (all defaults dark-oriented; vertical bar flips bg to 250 at high fill for contrast, l.969).
8. Glyphs: eighth-block bars (`_BAR_EIGHTHS`) and vertical bars (`_VBAR_EIGHTHS`), display mode per limit (horizontal / vertical / number); `⑂` branch sign; emoji `💬` notifications.
9. Animated rainbow: weekend label drawn with an OKLCH rainbow whose phase advances per refresh and is stored in sqlite (`_rainbow`, `_rainbow_next_phase`, l.151, 724-736); OKLCH gamma maths in-file; full TUI theme editor with attribute choices.
10. Customisation: `~/.config/omcc-statusline/config.json` (`slots`, `settings`, `theme`) with schema validation, TUI editor, external shell-command slots.

## my-claude-hud (JackCmd233) — fork of Link-Start/my-claude-hud
https://github.com/JackCmd233/my-claude-hud — stars 0
Fork differences, from a file-by-file diff of the fork against Link-Start/my-claude-hud HEAD (`src/themes.ts` is byte-identical):
- `src/render/colors.ts`: the fork is the parent minus its separator-style block. Parent adds `SeparatorStyle = 'default' | 'powerline' | 'arrow'`, `getSeparator()` (powerline ``/``, arrow `➤`/`➢`) and `renderSegment()`. The fork has none of them (161 vs 211 lines).
- `src/render/canary-line.ts` (99 vs 170 lines) and `src/render/session-line.ts` (281 vs 325 lines) are shorter in the fork; neither diff touches a colour or ANSI line.
- Inherited, unchanged: 5 bundled colour themes (`default`, `nord`, `dracula`, `monokai`, `solarized`; `themes.ts`), each a `ThemeColors` map of 15 semantic keys (contextLow/Medium/High/Critical, success/warning/error/info, magenta/cyan/yellow/green/red/dim/reset), as ANSI escape strings, truecolor in non-default themes and 16-colour + `38;5;208` orange in default. Context bar: <50 low, 50-80 medium, 80-95 high, >=95 critical (`getContextColor`); quota bar: >=90 error, >=75 magenta, else info (`getQuotaColor`). User config `theme.colorTheme` plus `theme.customColors` overrides by key (`examples/.claude-hud.example.json`). Foreground-only, `█`/`░` bars, no NO_COLOR handling.
- Fork-only files named in the scan: `scripts/ensure-cc-switch-hud.sh`, `scripts/ensure-hud-config.sh` (config setup, not styling).
Nothing else in styling differs.

## statusline (jackhutson)
https://github.com/jackhutson/statusline — stars 0
Three variants chosen at install (`install.sh:12-14`): Powerline (Catppuccin Mocha with pets), Default (minimal with icons), Compatible (any UTF-8). Also `statusline-sumi.js`, a Kanagawa-ink "desktop retheme" variant.
1. Powerline variant, fixed per segment (`src/statusline.js:30-37`): model bg red `#f38ba8`, dir bg peach `#fab387`, git bg yellow `#f9e2af`, context bg surface0 `#313244`, end/pet bg mauve `#cba6f7`; fg on coloured bgs = crust `#11111b`. By state: the context bar fg takes the urgency colour (normal green `#a6e3a1`, warning yellow at >=60%, critical red at >=80%; `URGENCY`, thresholds l.14-15). Sumi variant: dir icon + dir = "spot" gold `#e6c384`; text `#c5c9c5`/dim `#a6a69c`; usage coloured `WARN #ffa066` over 60, `ERROR #ff5d62` over 80, else dim; branch icon `#7e9cd8`; brain icon sakura `#d27e99`. Default and compat variants use Catppuccin yellow/red `#f9e2af`/`#f38ba8` for warnings.
2. Themes: not user-selectable; each variant is one theme: Catppuccin Mocha (powerline/default/compat) and Kanagawa (sumi). Format: constants per segment (`SEG`).
3. Truecolor `38;2`/`48;2` only. No downsampling or NO_COLOR.
4. Powerline: background fills with pill caps; context segment has a custom bg. Default / compat: foreground only.
5. Powerline arrows U+E0B0 between segments (`mkArrow(fromBg, toBg)`: fg = left bg, bg = right bg, l.84-91), pill caps U+E0B6 / U+E0B4 coloured as the first/last bg; progress bar with Nerd glyph segments U+EE00-EE05 (empty/full left/mid/right).
6. Neighbours: distinct Catppuccin hue per segment (red, peach, yellow, grey surface, mauve) plus the arrow.
7. Text contrast: dark crust text on all light pastel bgs; no light/dark detection.
8. Nerd Font icons (branch U+F418, model, ctx, dir) in powerline/default; compat uses no private-use glyphs. 8 pet names with icons by tier.
9. Pets (name + icon) that vary, Nerd Font bar, optional herdr sidebar mirror in sumi.
10. Customisation: install-time variant choice; edit the JS constants. `preview.sh` and `preview/preview-runner*.js` render previews.

## claude-statusline (JaeggerJose)
https://github.com/JaeggerJose/claude-statusline — stars 0
A theme system with a `csl` package-manager CLI (`bin/csl`) for themes and themepacks, with optional inline pixel art.
1. Fixed per field via theme variables (`lib/render.sh:5-12`): `T_USER`, `T_DIR`, `T_GIT`, `T_MODEL`, `T_STYLE`, `T_TIME`, `T_DIM`; by state the context bar `T_BAR_LOW/MID/HIGH` (>=90 high, >=70 mid, else low; render.sh:180-182). Bundled `nord.sh`: user bold 110 frost blue, dir 116, git 150 green, model 111, style/time 245, bar low 150 / mid 222 / high 174, separator 240 (`themes/nord.sh`). Defaults without a theme: user bold red, dir yellow, git green, model cyan, bar green/yellow/red (render.sh:27-36).
2. Themes: 3 built-in (`nord`, `minimal`, `blank`), plus a user tier `~/.config/csl/themes` (`CSL_USER_DIR`) and installable themepacks. Format: a `themes/<name>.sh` palette (`T_*` raw ANSI, `ART_MODE`, `SHOW_*` toggles) and a `.json` manifest (`render.mode`, `requires`, `art.build` recipe). Users author their own (`csl init <name>`, `csl edit`).
3. Raw ANSI SGR strings: 16-colour bases (`A_RED` ...) and 256 indexes in themes. Header README says art themes want a truecolor terminal. No NO_COLOR.
4. Foreground only for text; art themes emit inline images (iTerm2 `1337;File=inline=1` sequence, render.sh:90) / ANSI pixel art via `chafa` + PIL.
5. Separator `SEP` is a theme variable (nord: 240-grey `|`), default dim `|`.
6. Neighbours: per-field hues plus `SEP`.
7. Light/dark: not present.
8. Glyphs: `█`/`░` 10-cell context bar; pixel-art frames/playlists generated from images (`csl build`, gallery, `ART_PLAYLIST`).
9. Distinct: image/pixel-art statuslines with a gallery of art, themepack sharing, `csl next` theme cycling, rewrites `settings.json` `statusLine.command` on switch, component composer (`lib/components.sh`, `CSL_ROWS`).
10. Customisation: theme `.sh` files, `csl` CLI (list/search/set/next/build/init/edit/info), env `CSL_USER_DIR`.

## claude-code-mods (jaeseongs95)
https://github.com/jaeseongs95/claude-code-mods — stars 0
A collection of Claude Code mods; only `usage-line` is relevant (`korean-ui` translates the UI, not styling). `usage-line/hooks/register.tsx` draws a usage row with Ink `<Text>`.
1. Fixed: directory cyan bold, `dim()` labels. By state, a percent helper `pct(label, v, warn, crit)` (l.37-40): default colour, yellow at warn, bold red at crit. Effort level (`EFFORT`, l.61-67): low gray, medium cyan, high yellow, xhigh orange `#ff8700`, max bold red. `LAVENDER #af87ff` and `ORANGE #ff8700` are the only hexes.
2. Themes: not present; host named colours only.
3. Ink named colours + 2 hex. Depth/NO_COLOR delegated to host.
4. Foreground only.
5. Separators: dim `' · '` (DOT) and dim `'  │  '` (BAR).
6. Neighbours: dim separators; fixed hues for dir and effort.
7. Light/dark: `slim` mode switches to plain dim when width-constrained; no theme detection.
8. Glyphs: text and `%`. No icon modes.
9. Nothing else styling-related.
10. Customisation: warn/crit thresholds in code; no config file seen.

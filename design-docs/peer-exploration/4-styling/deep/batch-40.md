## powerline-claude-code
https://github.com/cwood/powerline-claude-code, stars 0 (README.md fetched empty; read `powerline_claude_code/segments.py` and `cli.py`)
Not a standalone renderer: a Python segment library for the Powerline (tmux) daemon. It emits segment dicts and the user's Powerline colorscheme paints them.
1. By state, via Powerline highlight-group names, not colours. `segments.py:236-246` attention segment uses group `claude_code:attention_<reason>` (`done`/`permission`/`idle`), optionally preceded by `…_pulse` on even seconds (`pulse` option, line 238). Quota (`:303-308`): `claude_code:quota_crit` (pct >= crit) / `quota_warn` (>= warn) / `claude_code:quota`. Usage (`:455-476`): `claude_code:usage_spike` vs `claude_code:usage`.
2. Themes: none bundled. Each group carries a fallback chain defined in `segments.py:35-41` and per segment: `[group, fallback, "background"]` with fallbacks `information:additional` (calm), `warning`, `critical:failure`. User defines `claude_code:*` groups in their Powerline colorscheme, else generic Powerline groups apply.
3. Colour spec/depth: not present in this repo (Powerline owns it). No ANSI emitted, no NO_COLOR handling.
4. Fill: whatever Powerline's tmux theme does; not decided here.
5. Separators: `divider_highlight_group: "claude_code:divider"` on every segment (`segments.py:245,315,477`); the separator glyph is Powerline's.
6. Neighbours: not present (Powerline's concern).
7. Light/dark: not present.
8. Glyphs: configurable `done_glyph`/`permission_glyph`/`idle_glyph` arguments (`segments.py:521,562`); signals counted 6 emoji.
9. Other: pulse alternation of two highlight groups per second (`:238-239`) as the only animation; cycling attention indicator across panes (`cycle_seconds`).
10. Customisation: Powerline JSON theme/colorscheme referencing the segment functions; `powerline-claude-code setup` CLI wires the statusLine and prints the tmux theme snippet (`cli.py:164`); config at `~/.config/powerline-claude-code/config.json` (`segments.py:30`).

## claude-context-warning
https://github.com/cyberpunkbeatgeneration/claude-context-warning, stars 0 (read `context_warning.sh`, 42 lines)
1. By threshold, one segment only (context %): `context_warning.sh:22-35` >=95 `\033[1;5;31m` (bold blink red) with text "🔴 CONTEXT n% - /compact or /clear now"; >=80 `\033[31m` red "⚠"; >=60 `\033[33m` yellow "⚡"; else `\033[32m` green "✓". Whole string is one colour.
2. Themes: not present ("cyberpunk" in the scan is only the author's name/tagline).
3. ANSI 16 only (31/32/33, bold, blink 5). No depth detection, no NO_COLOR.
4. Fill: foreground only.
5. Separators: not present (single segment).
6. Neighbours: not present.
7. Light/dark: not present.
8. Glyphs: emoji/Unicode per level (✓ ⚡ ⚠ 🔴); no ASCII mode.
9. Notable: blink attribute (SGR 5) at >=95% as the only escalation; glyph changes with level so state survives colour loss.
10. Customisation: none beyond editing the script; `install.sh` registers it.

## ck-statusline
https://github.com/cyckuan/ck-statusline, stars 0 (read `scripts/statusline.js`, `config/colors.json`)
1. Mixed. Fixed per segment from a colour scheme (`colors.json`; `statusline.js:94-134`): model bold white (dark) / bold black (light), agents `1;95` / `1;35`, cwd `36` / `1;34`, branch `1;96` / `1;36`, remote `1;94` / `1;34`, behind `33` / `38;5;208`, token/cpu/mem labels `2` dim / `90`, separator dim. By threshold: context bar and cpu/mem use `trafficColor` (`:139-145`) with thresholds `[40,60,80]` -> green `32` / yellow `33` / amber `38;2;255;165;0` / bold red `1;31`. Cost/context/memory get notification styling (`applyNotification`, `:475-479`): warn bold yellow `1;33`, critical blinking bold red `5;1;31` (defaults cost 5/20 USD, ctx 70/90, mem 80/95, `:55`).
2. Themes: two schemes in `config/colors.json` keyed `dark` and `light`; format is a per-segment ANSI-code map (not semantic roles). Users can edit the JSON file; `scripts/set-mode.js` switches `verbose`/`compact` layout, not colours.
3. ANSI 16 foreground codes, one truecolor (amber), one 256 (`38;5;208`). No depth detection; no NO_COLOR.
4. Fill: foreground only, except the "company badge" (`bg: "\x1b[41m"`, red background, `statusline.js:112,125`).
5. Separators: plain ` | ` in the scheme's separator colour (dim in dark, `90` in light) (`:587`). No powerline glyphs.
6. Neighbours: separators plus per-segment hue differences; no alternation.
7. Light/dark: yes, a real branch: `loadColors(theme)` sets `isLight = /light/i.test(theme)` where `theme = data.output_style.name` (`:77,493-494`), i.e. it reads the output-style name, not the terminal.
8. Glyphs: 10 box/block (sparkline `SPARK_CHARS`, bar blocks); no Nerd Font.
9. Notable: sparkline history for cpu/mem (`updateSparkHistory`); traffic-light colouring shared by bar and numbers; layout order configurable (`DEFAULT_ORDER`, `:54`) with compact mode excluding tokens/remote.
10. Customisation: `config/colors.json`, a layout JSON (mode, order, compact.exclude, notifications), `scripts/set-mode.js`.

## clawd-hud-zq
https://github.com/DaiZiQiao/clawd-hud-zq, stars 0
not a Claude statusline: a Claude Code mod (HUD side pane with animated mascots plus an image strip), not a statusline command. Styling note useful to cc-candybar: `mod-hud/hooks/hud.tsx:32-36` colours by Claude Code theme keys only (`ACCENT='claude'`, `GOOD='success'`, `WARN='warning'`, `HOT='error'`) so it follows the user's dark/light theme; `svg-style.ts:15-22` holds the dark/light hex for those keys (`claude #D77757`, `success #4EBA65`/`#2C7A39`, `warning #FFC107`/`#966C1E`, `error #FF6B80`/`#AB2B3F`) and switches by `prefers-color-scheme`.

## claude-context-gauge
https://github.com/DamianoCode/claude-context-gauge, stars 0 (read `statusline/statusline.mjs`, 156 lines)
1. Theme role mapped to segments, with Claude Code's own palette. `paint(colors, key, text)` (`:82-88`). Model name bold `claude` (`:105-108`); effort level coloured by level via `{low:'warning', medium:'success', high:'suggestion', xhigh:'permission', max:'claude'}` (`:106`); separator `subtle` ` │ `; limit label `inactive`; branch `planMode`, `+n` `success`, `-n` `error` (`:146-151`). Rate-limit bar tone by pace: `error` if used >= 90 or projected pace >= 130, `warning` if pace >= 100, else `success` (`:129-135`).
2. Themes: reads Claude Code's own `settings.json` `theme` (`:63-76`). Built-ins `dark` and `light` hex tables of 10 roles (`text subtle inactive claude success warning error suggestion planMode permission`, `:57-60`), `custom:<name>` themes read from `~/.claude/themes/<name>.json` as `{base, overrides}` merged over the base. So users do not define themes here; they inherit Claude Code's.
3. Truecolor hex -> `38;2;r;g;b` only (`:87`). `-ansi` themes (theme name ends with `-ansi`) return null palette and fall back to ANSI 16 map `ANSI` (`:79-84`, e.g. success 32, error 31, claude 33). No NO_COLOR.
4. Fill: foreground only.
5. Separators: plain ` │ ` in `subtle`.
6. Neighbours: separators only; hue by role.
7. Light/dark: yes, via the user's Claude Code theme (`theme.startsWith('light')`), the strongest example in this batch of following the host theme.
8. Glyphs: `━`/`─` bars, `↻`, `⎇`; no Nerd Font.
9. Notable: the palette is a copy of Claude Code's role vocabulary (`claude`, `suggestion`, `permission`, `planMode`) so the line matches the host UI; `--chain` hands stdin to another statusline.
10. Customisation: `--chain` flag; otherwise edit the file; colours come from Claude Code settings.

## hazline
https://github.com/DamianPala/hazline, stars 0 (Rust; read `src/themes/*.rs`, `src/themes/presets.rs`, `src/core/statusline.rs`, `src/config/types.rs`, `src/config/theme_file.rs`; descends from CCometix-style `StyleMode`)
1. Fixed per segment per theme, with optional thresholds. Each theme file builds one `SegmentConfig` per segment (model, directory, git, context_window, cost, session, output_style, usage, peak_hours) with `icon`, `colors{icon,text,background}` (`types.rs:30-37`). `powerline-dark` backgrounds: model rgb(45,45,45), directory (139,69,19), git (64,64,64), context (55,65,81), cost (40,44,52), session (45,50,59), output_style (50,56,66), usage (45,50,59). `powerline-light`: model sky (135,206,235), directory (255,107,71), git (79,179,217), context (107,114,128), cost (255,193,7), session (40,167,69), output_style (32,201,151). Thresholds (`Threshold{above, icon, icon_color, text, background}`, `types.rs:46-53`; highest `above` <= value wins, `appearance_for`): only `haz-tokyo-night` ships them (header comment, `theme_haz_tokyo_night.rs:1-6`): context aqua -> yellow at 30% -> pink at 50%; usage -> pink at 80%; peak-hours swaps green for pink. Thresholds resolve before arrows are drawn so arrows follow the changed background (`statusline.rs:18-45`).
2. Themes: 10 compiled in (`presets.rs:14-25`): cometix, default, minimal, gruvbox, haz-tokyo-night, nord, powerline-dark, powerline-light, powerline-rose-pine, powerline-tokyo-night. Format: per-segment colour structs (not semantic roles). User themes are TOML in `~/.claude/hazline/themes/<name>.toml` (`theme_file.rs`: `theme`, `style`, `segments[]` with `colors`, `styles`, `thresholds`); a same-named file shadows a built-in; a theme file missing a newer segment is completed from the built-in (`into_config`). `hazline themes`/`preview --theme` exist.
3. `AnsiColor` enum: `Color16{c16}`, `Color256{c256}`, `Rgb{r,g,b}` (`statusline.rs:157-220`). Themes use RGB (powerline-*, nord) or 16 (`default`: cyan = c16 14). No depth detection or downsampling found; NO_COLOR: not found.
4. Fill: both. With a `background` the cell is ` icon text ` on bg (`statusline.rs:91-122`); with none, foreground-only (`:124-143`; `default` and `minimal` themes).
5. Separators: Powerline arrow U+E0B0 when `style.separator == "\u{e0b0}"`; arrow fg = previous bg, bg = next bg (`create_powerline_arrow`, `:279-310`), final arrow closes the last segment (`:263-277`). Any other separator string is joined in white `\x1b[37m` (`:223-229`). No rounded caps.
6. Neighbours: per-segment distinct fixed backgrounds, plus in `haz-tokyo-night` "each segment on its own step of the background ramp so the powerline arrows read as depth" (file header): BG_DARKEST (21,22,30), BG_BASE (26,27,38), BG_SURFACE (36,40,59), BG_HIGHLIGHT (41,46,66), BG_SELECTION (51,70,124), BG_GUTTER (55,62,92), BG_PEAK (30,34,52): lightness steps of one hue, with accent colour carried only by the text/icon. Usage segment sits on BG_HIGHLIGHT, context on BG_SELECTION.
7. Light/dark: `powerline-light` is a separate theme (black icon/text on sky; white on coloured). No detection of terminal background; user picks.
8. Glyphs: `StyleMode::{Plain, NerdFont, Powerline}` (`types.rs:19-24`); each segment has `icon.plain` (emoji, e.g. ✨ 📁 🌿) and `icon.nerd_font` (e.g. `\u{f0674}`) (`statusline.rs:148-155`). Powerline mode currently reuses Nerd Font icons.
9. Notable: thresholds change the background (so arrows recolour); `check` reports theme errors rather than silently falling back (`presets.rs:resolve_theme` comments); themes carry appearance only, not machine options.
10. Customisation: TOML config and theme files, `--theme` flag, `hazline themes|preview|check` subcommands.

## statusline (dan1d)
https://github.com/dan1d/statusline, stars 0 (read `themes/{powerline,compact,full,minimal}.js`, `lib/config.js`)
1. Mostly fixed per segment, with two threshold rules. Colour constants in every theme file are the same Catppuccin-Latte-like truecolor set: CYAN (23,146,153), GREEN (64,160,43), YELLOW (223,142,29), MAGENTA (136,57,239), GRAY (76,79,105), RED (220,50,47), ORANGE (245,166,35), BLUE (30,102,245) (`powerline.js:14-21`). Mapping in `powerline.js:51-124`: project cyan bold, branch green + dirty flag red, model gray, cost yellow, session LOC green, uncommitted diff yellow, duration blue, todos cyan. Thresholds: context magenta, red when > 80 (`:75`); rate limit (`rlColor`, `:44-48`) gray < 60, orange >= 60, red >= 80.
2. Themes: four named layouts (powerline, compact, full, minimal), selected by `theme` in `~/.claude/statusline-config.json` (`config.js:11`); they differ in what is shown, not in palette (all four hardcode the same constants). Not user-extensible except by editing code. Plus a separate `detail` level low/medium/high.
3. Truecolor foreground only (`\x1b[38;2;…`), no depth detection, no NO_COLOR.
4. Fill: foreground only.
5. Separators: despite the name, the "powerline" theme uses ` │ ` in dim gray (`powerline.js:24`), no arrows or caps.
6. Neighbours: separator only plus per-field hue.
7. Light/dark: not present (the palette happens to be a light-theme one: GRAY (76,79,105) is dark-on-light).
8. Glyphs: `❯` prefix on project, emoji counted 13 across themes; no Nerd Font.
9. Notable: nothing beyond the above; "detail" tiers gate which fields appear.
10. Customisation: JSON config `{theme, detail}` plus a slash command (`lib/ensure-config.js`).

## claude-code-cli-status-line
https://github.com/dandjo/claude-code-cli-status-line, stars 0 (read `statusline-command.sh`, 170 lines)
1. Mixed. Fixed: model/effort header cyan (`CYAN='\033[36m'`, `:46`), directory bold blue `\033[01;34m` ("coloured like the ~/.bashrc prompt", `:4,153`), tokens count cyan, reset time cyan. "Money" colour for cost and effort level is truecolor amber `38;2;255;193;7` matching Claude Code's `warning` role, falling back to yellow without `COLORTERM=truecolor|24bit` (`:47-53`). Threshold bars (`render_bar`, `:122-124`): green < 70, yellow >= 70, red >= 90; applied to context, 5h, 7d and model-specific limits.
2. Themes: not present.
3. ANSI 16 plus one truecolor value gated on `COLORTERM` (`:50-53`): a real, if tiny, depth detection. No NO_COLOR.
4. Fill: foreground only.
5. Separators: plain ` | ` (`:157`).
6. Neighbours: separators only.
7. Light/dark: not present (comment at `:47-49` aligns one colour to Claude Code's dark-theme `warning`).
8. Glyphs: emoji labels 📂 🌿 🪙 ⏱️ ⏰; `█`/`░` 20-cell bars.
9. Notable: effort and cost deliberately share one colour ("higher effort costs more", `:143`).
10. Customisation: edit the script.

## claude-lantern
https://github.com/danieledel288-code/claude-lantern, stars 0 (read `plugin/lantern/statusline.py`, `build_presets.py`, `plugin/themes/hal.json`)
1. One colour for everything in the statusline, per preset. `statusline.py:247-262`: `colors = theme["colors"]` has just `text` and `separator` as SGR strings; whole line is `text`, separators `  │  ` in `separator`. Presets (`build_presets.py:30,51,72`): Hal `text 38;5;48 / sep 38;5;29`, John `38;5;43 / 38;5;30`, Guy `38;5;118 / 38;5;64`. Usage "charge bars" `▰▱` (`:113-115`) are not state-coloured. Mood text (emoji) varies by context/activity (`FALLBACK_THEME.moods`), not colour.
2. Themes: three bundled (Hal Jordan, John Stewart, Guy Gardner), each in two forms: a statusline preset JSON (`colors.text/separator`) and a Claude Code theme file (`plugin/themes/*.json`, `{name, base:"dark", overrides:{claude, claudeShimmer, promptBorder, permission, suggestion, remember, rate_limit_fill, success, clawd_body}}`) overriding Claude Code's own role colours (e.g. Hal `claude #1aff8c`, `promptBorder #109a55`). Generated by `build_presets.py` from one accent/border/soft triple per Lantern. Users could add presets but there is no editor.
3. 256-index SGR for the statusline; hex for the Claude Code theme. No depth detection, no NO_COLOR.
4. Fill: foreground only.
5. Separators: plain `  │  `.
6. Neighbours: separators only.
7. Light/dark: Claude Code theme files are `base: "dark"` only.
8. Glyphs: braille/ASCII emblem art on the left (`ascii_to_braille.py`, `corner_art`), emoji moods.
9. Notable: animation (about 30 fps braille constructs via mod hooks, `plugin/hooks/wave.ts`); the statusline and the host theme are recoloured together from one accent triple, so the bar matches the spinner and prompt border.
10. Customisation: slash commands `/hal /john /guy /lantern-off` write an `active` file; presets are JSON.

## malka-claude-mods
https://github.com/danielmalka/malka-claude-mods, stars 0 (collection of mods; read `plugins/statusline/hooks/status-line.tsx` and `status.ts`)
Styling-relevant part is the `statusline` mod only (a Claude Code mod band, not a statusLine command; the rest of the collection is unrelated mods).
1. By state/threshold plus fixed. `status.ts:2-11`: `STATUS_GREEN #22c55e`, `STATUS_YELLOW #eab308`, `STATUS_RED #ef4444`, `STATUS_CYAN #22d3ee`; `colorFor(pct)` = red >= 90, yellow >= 70, else green, applied to context % and the 5h/7d limit percentages (`status-line.tsx:42,60`). Model cyan, branch green, cache dot green/red (`:48-67`), all else `dimColor`.
2. Themes: not present (hex constants are fixed; the headings use the host theme key `color="claude"`, `:106`).
3. Truecolor hex via the mod renderer's `color` prop; no depth handling in the mod's code.
4. Fill: foreground only.
5. Separators: `' · '` and `'  │  '` in dim (`:49,77`).
6. Neighbours: dim separators only.
7. Light/dark: the mod renders `dimColor`/`claude` host keys but its hex status colours are fixed and not light-adapted.
8. Glyphs: `●`/`○` toggles, `←` button.
9. Notable: the rainbow signals the scanner counted come from other plugins in the repo, not the statusline mod; `on` replaces the user's `statusLine` in settings.json, `off` restores it.
10. Customisation: in-app toggles (`Button`), `settings.ts`.

## ccstatusline-rs
https://github.com/danielnc/ccstatusline-rs, stars 0 (Rust, byte-identical port of sirmalloc/ccstatusline v2.2.32; read `src/colors.rs`, `src/render.rs`, `src/gradient.rs`, `src/widgets/core.rs`, `src/settings.rs`, parity corpus)
1. By position (powerline themes) or per-widget config. With a powerline theme, every non-separator widget with output takes `bg = theme.bg[color_index % len]` and `fg = theme.fg[color_index % len]`; `color_index` increments per widget (not for widgets merged with the next) and can continue across lines (`continueThemeAcrossLines`) (`render.rs:165-203`). Without a theme (`custom`), each widget uses its own `color`/`backgroundColor` or its widget's built-in default colour (`default_color()`, e.g. model `cyan`, `core.rs:16-18`; git widgets carry a per-widget `color`). Theme palettes have exactly 5 entries cycled, so segment 6 reuses segment 1's colours.
2. Themes: 10 powerline themes plus `custom`: nord, nord-aurora, monokai, solarized, minimal, dracula, catppuccin, gruvbox, onedark, tokyonight (`colors.rs:380-488`). Each defines three parallel 5-colour (fg, bg) lists, one per colour level: ANSI16 names (`bgBlue`), ansi256 (`ansi256:73`), truecolor (`hex:88C0D0`). Format: positional palette, not semantic roles. Users override per widget in `settings.json` (`color`, `backgroundColor`, `bold`), or define gradients; no user-defined theme files, only the built-ins or per-widget overrides.
3. All three depths, chosen by `colorLevel` (0-3, a setting; `chalk_level`, `colors.rs:25-47`) and the theme list is picked by level (`render.rs:114-125`). Colour names resolve through a 32-entry map with ansi16/ansi256/rgb for each (`colors.rs:104-141`), plus `hex:RRGGBB` and `ansi256:N`; `ansi256_to_ansi` downsamples. Level 0 emits nothing (`chalk_wrap` returns plain text). `NO_COLOR`/`FORCE_COLOR`: not found in this source.
4. Fill: both. Powerline mode fills backgrounds; non-powerline mode is foreground only (or fg with optional bg per widget).
5. Separators: configurable `separators` list (default `\u{e0b0}`), with `separatorInvertBackground` per separator, optional `startCaps`/`endCaps` lists (rounded caps etc.), cycled by index (`settings.rs:83-101`, `render.rs:392-445`). Separator colours: normal arrow fg = previous cell's bg (via `bg_to_fg`), bg = next cell's bg (`render.rs:397-419`); inverted: fg = next bg-as-fg, bg = previous bg; same-bg neighbours use the text colour as the arrow fg so the seam stays visible.
6. Neighbours: different palette entries per position (5 distinct colours cycling); identical adjacent backgrounds get a text-coloured arrow instead of an invisible one.
7. Light/dark: not present; the `minimal` theme has light and dark entries but there is no detection. Text contrast is hand-paired in each theme (fg list parallel to bg list, e.g. black on `bgBrightCyan`, white on `bgBlue`).
8. Glyphs: Powerline glyphs U+E0B0 and caps; widgets carry emoji/Nerd icons upstream-compatible.
9. Notable: text gradients (`gradient:` prefix, 13 presets e.g. `rainbow`, `atlas`, `instagram`, `retro`; `gradient.rs:12-29`) with `overrideForegroundColor`; auto-align columns across lines; flex separators; full TUI colour editor ported screen by screen (340 parity cases); `defaultPadding`, `globalBold`.
10. Customisation: `settings.json` (version 4), TUI editor (run with no stdin), env/hook install; byte-identical to upstream.

## cc-limits-statusline
https://github.com/danilchernyshev/cc-limits-statusline, stars 0 (read `statusline.sh`, 288 lines)
1. Mixed. Fixed: cwd bold blue `\033[01;34m`, plan `[Max 20x]` bold magenta `\033[01;35m` (`:90`), `ctx` label dim. By threshold: 5h/7d/ctx numbers (`color_for`, `:141-146`) green, yellow >= `YELLOW_AT` (80), bold red >= `RED_AT` (100); extra-usage dot `●`/`●●` (yellow/red, `:149-160`); context uses its own 70/85 thresholds (`CTX_YELLOW_AT`, `CTX_RED_AT`, `:70-72`, tied to when `/compact` pays off). By value: effort name (`effort_color`, `:126-134`): low green, medium cyan, high yellow, xhigh magenta, max bold red.
2. Themes: not present.
3. ANSI 16 + bold. No depth detection, no NO_COLOR.
4. Fill: foreground only.
5. Separators: ` │ ` dim (`:257`); header group cwd/plan/model is space-joined.
6. Neighbours: dim bars + spaces.
7. Light/dark: not present.
8. Glyphs: `●`, emoji 💳; plain-text dot chosen to avoid emoji width issues (comment `:149`).
9. Notable: all thresholds are env-overridable (`YELLOW_AT`, `RED_AT`, `DOUBLE_AT`, `CTX_*`); fields toggled by `SHOW_*` flags; the severity logic encodes paid-overage meaning.
10. Customisation: environment variables (`SHOW_*`, thresholds), Windows installer scripts.

## claude-norns-statusline
https://github.com/danjuls/claude-norns-statusline, stars 0 (read `src/themes/*.ts`, `src/styles/*.ts`, `src/renderer.ts`, `src/utils/{ansi,bar}.ts`, `src/segments/context.ts`)
1. Fixed per segment per theme, by name. Each theme has `colors.segments[name] = {bg, fg}` for 19 segments (model, git, context, session, usage, ratelimit, agent, tasks, subagents, block, daily, diff, metrics, sparkline, activity, version, tmux, directory, custom); `renderer.ts:44-52` looks up the segment name and falls back to `{theme.bg, theme.fg}`. Colour is NOT data-driven in the renderer: `getBarThreshold` (>= 90 critical, >= 70 warning, `bar.ts:30-34`) exists, but I did not find where it colours output (unverified).
2. Themes: 7 registered (`themes/index.ts:10-18`): yggdrasil (dark, brown/moss/gold), bifrost, ragnarok (ember), valhalla (light: `bg #e8e4df`), mist, jotunheim, nott; plus `custom` from `config.customTheme`. Format: a semantic base (`bg fg accent accent2 dim warning critical success separator`) plus the per-segment map. Users can define a full `customTheme`; `/norns:theme` command and a preview (`renderThemePreview`, screenshots in repo).
3. Truecolor only: `38;2;r;g;b` / `48;2;…` from hex (`utils/ansi.ts:11-28`). No downsampling, no NO_COLOR.
4. Fill: both depending on style: powerline and capsule fill `bg`; minimal is foreground-only with plain separators.
5. Separators: three styles (`styles/`): powerline arrow U+E0B0 (arrow fg = current bg, bg = next bg, last arrow on reset ground; `powerline.ts:18-29`), capsule with rounded caps U+E0B6/U+E0B4 and a space between pills (`capsule.ts`), minimal ` │ ` (`minimal.ts`). A `text` charset swaps to `>`, `(`/`)`, ` | `.
6. Neighbours: by hand-authored alternation inside each theme: segments cycle between two or three near-identical bg tints (valhalla alternates `#d4d0ca` and `#dce8e4`; yggdrasil rotates `#2e261f`, `#1f2a1a`, `#2a2318`), keyed by segment name not position, so a segment keeps its tint when others are hidden; text colour (`fg`) carries the accent.
7. Light/dark: light is a bundled theme (valhalla); no detection of terminal background or Claude theme.
8. Glyphs: charset `nerd` (default) or `text` fallback for separators and the context icon (`` vs `Ctx `, `context.ts`).
9. Notable: optional `shimmer` effect sweeping toward `lerp(accent2, #fff, .35)` (`renderer.ts:64-68`, `applyShimmer`); five bar styles (`block classic shade dot pipe`); priority-based segment dropping to fit terminal width; `lines` multi-line layouts.
10. Customisation: config file with `theme`, `style`, `charset`, `barStyle`, `barWidth`, `shimmer`, `lines`, per-segment `enabled`/`priority`; slash command for theme; custom theme object.

## claude-statusline (danrynr)
https://github.com/danrynr/claude-statusline, stars 0 (read `statusline.js`, 381 lines)
1. Mixed. Fixed: model bold yellow (`:313`), cwd cyan (`:319`), branch magenta `⎇` (`:320`), labels bold dim. Threshold: context/limit bar and percent: green < 50, yellow < 80, red (`pctColor`, `:38-40`), and the bar is a zoned track: each tick bright in its zone's colour when filled and the same colour dim when empty (`ZONES`, `:43-59`). Effort badge matches Claude Code's own (`:244-262`): low `warning`, medium `success`, high `permission`, xhigh `autoAccept`, max per-character RAINBOW.
2. Themes: not present as a feature; reads Claude Code theme only for the effort badge.
3. ANSI 16 plus bright variants `1;92` etc.; truecolor for the effort badge. No NO_COLOR, no downsampling.
4. Fill: foreground only.
5. Separators: ` │ ` dim (`:17`).
6. Neighbours: separators and a dim-bold row label (`label.padEnd(7)`, `:268`).
7. Light/dark: yes for the effort badge only: reads `theme` from `~/.claude.json` and picks `st.light` (e.g. low (150,108,30), medium (44,122,57)) vs `st.dark` ((255,193,7), (78,186,101)), matching Claude Code's own role colours.
8. Glyphs: effort symbols `○ ◐ ● ◉ ◈`, 🪨, `⎇`, `●`; tick bar uses `|`.
9. Notable: `max` effort drawn as a rainbow (`RAINBOW` six truecolor stops cycled per character); escape-stripping of untrusted strings (`clean`, `:22`).
10. Customisation: edit script; installers.

## claude-icq-mode
https://github.com/daogurtsov/claude-icq-mode, stars 0 (read `plugins/icq-mode/scripts/statusline.sh`)
1. By state: status (from a per-session file) sets one colour for the flower `✿` and label: occupied red `\033[31m`, away yellow `\033[33m`, online green `\033[32m` (`statusline.sh:16-20`); `UIN`/separators grey `\033[90m`; dir and model uncoloured.
2. Themes: not present.
3. ANSI 16 only. No depth detection, no NO_COLOR.
4. Fill: foreground only.
5. Separators: ` │ ` grey.
6. Neighbours: separators only.
7. Light/dark: not present.
8. Glyphs: `✿`, 📁; no fallback.
9. Notable: ICQ-style presence statuses (Online/Away/Occupied) as the colour axis, and a fake UIN derived from `cksum` of the session id (`:23-25`).
10. Customisation: none (the plugin's skill changes the status file).

## claude-code-config
https://github.com/Dark-GreenCat/claude-code-config, stars 0 (read `statusline-command.sh`, 62 lines, and `themes/tokyonight.json`)
1. Mixed. Fixed: model cyan `◆`, effort dim, dir blue, branch magenta (`:15-16,44-52`). By threshold: context and limit bars via `pc()` green < 50, yellow < 80, red (`:20`), all Tokyo Night values (green (158,206,106), yellow (224,175,104), red (247,118,142)).
2. Themes: one hardcoded palette (Tokyo Night) in the script; plus `themes/tokyonight.json`, a Claude Code theme file (`{name, base:"dark", overrides:{claude rgb(255,158,100), success, error, warning, permission, planMode, promptBorder, text, inverseText, diff*, clawd_body, userMessageBackground …}}`), i.e. the host UI is re-themed alongside.
3. Truecolor `38;2` hand-coded in shell (`:14-15`); file uses `rgb(r,g,b)` strings. No depth detection, no NO_COLOR.
4. Fill: foreground; the partial bar cell uses a background `48;2;59;66;97` for the eighth-block glyph (`bar()`, `:23-33`).
5. Separators: ` | ` dim.
6. Neighbours: separators only.
7. Light/dark: not present (`base: "dark"`).
8. Glyphs: Nerd Font folder/branch (U+F07B, U+E0A0) with a comment saying to change them if the font lacks them; block glyphs ▏▎▍▌▋▊▉ for sub-cell precision.
9. Notable: eighth-block bars with a same-glyph dark-gray "empty" so there is no gap; theme file recolours Claude Code itself.
10. Customisation: edit script/theme JSON.

## cache-weather-and-pause-resume
https://github.com/DarthSonic/cache-weather-and-pause-resume, stars 0
not a Claude statusline: a Claude Code mod band above the prompt (cache countdown, Compact/Pause buttons, keep-warm checkbox). Styling note: it colours with host theme keys, not hex: `cacheTone(share)` returns `error` at <= 20% of cache lifetime left, `warning` <= 60%, else `success` (`hooks/logic.ts:27-32`), with `subtle` when unknown (`register.tsx:805`).

## cc-bottomline
https://github.com/DatabenderSK/cc-bottomline, stars 0 (read `scripts/statusline-command.sh`, 511 lines, and README)
1. Mixed. Per-theme palette variables `C_MODEL C_FOLDER C_BRANCH C_TOOL C_GREEN C_YELLOW C_RED C_MUTED C_BAR_E C_ADD C_DEL C_AGENT` (`:37-96`). In the default palette: model orange `38;5;208`, folder cyan (76,208,222), branch purple (192,103,222), tool gold (255,200,0). Threshold colouring: `usage_color` (`:126-132`) green < 60, yellow 60-79, bold red >= 80, used by context % and 5h/7d bars. Hybrid and monochrome layouts colour line 2 grey and add colour only when a threshold is crossed.
2. Themes: 11 per README ("11 themes", `README:3`): hybrid (default), monochrome, brackets, minimal, default, nerd (Catppuccin palette), compact, tokyo (Tokyo Night, 3 lines), plus Cyberpunk, Material, Clean in `preview/index.html`. Format: palette variables + a layout `case` per theme in shell; selected by `THEME=` in `~/.claude/statusline.conf`. Users edit the shell/conf; no theme file format.
3. Truecolor `38;2` for most, `38;5;208` for orange; ANSI `90` for separators. No depth detection, no NO_COLOR.
4. Fill: foreground only.
5. Separators: per theme: ` • ` / ` | ` (default), ` │ ` (nerd), ` · ` (minimal), brackets `[ ]` (`:100-120`), all grey `\033[90m`.
6. Neighbours: separators; hue per role; mono layouts rely on one grey plus bold.
7. Light/dark: not present.
8. Glyphs: emoji icon sets in the `nerd` theme (🤖 📁 🌿 ⚡ ⏳ 📅 🧠 💰 🌳); other themes have fewer; `█░` bars.
9. Notable: "hybrid" idea (one coloured identity line, one monochrome metric line, colour appearing only on threshold); HTML preview page of all themes; `BAR_WIDTH`, `SHOW_*` toggles.
10. Customisation: `~/.claude/statusline.conf` (shell vars: `THEME`, `SHOW_*`, bar widths, TTLs); installers for macOS/Linux/Windows.

## claude_usage_bar
https://github.com/davisinho99/claude_usage_bar, stars 0 (read `plugin/claude-code/scripts/statusline.sh`, 59 lines)
1. By threshold, one colour for the whole segment: `statusline.sh:44-52` green `1;32` < 60, yellow `1;33` 60-84, red `1;31` >= 85; bar brackets, percent and token text all share it.
2. Themes: not present.
3. ANSI 16 bold. No depth detection, no NO_COLOR.
4. Fill: foreground only.
5. Separators: none (single segment `[████░░░] 42% tokens`).
6. Neighbours: not present.
7. Light/dark: not present.
8. Glyphs: `█` bar, 20 cells.
9. Notable: nothing.
10. Customisation: edit script; installer and session hooks.

## claude-statusline-with-quota
https://github.com/dbuezas/claude-statusline-with-quota, stars 0 (read `render.ts`, 180 lines)
1. By value (gradient along the bar), plus fixed. Each filled cell of a 45-cell bar gets a background computed by `colorRGB(cellPct)` (`render.ts:28-42`): HSL hue 120 degrees -> 0 degrees (green -> yellow -> red) at saturation 1, lightness .4, by the cell's own position, so the bar is a fixed gradient revealed by fill. Text is written on the bar. Pace marker: cells before the marker are darkened to half (`dark`, `:69-74`). Empty cells gray (`\x1b[100m`), pace-gap cells dark gray `48;5;238`. Fixed text: dir name bright cyan, `+n` bright green, `-n` bright red (`:167`).
2. Themes: not present.
3. Truecolor backgrounds `48;2` for the bar; ANSI bright 16 and one 256 colour elsewhere. No depth detection, no NO_COLOR.
4. Fill: both: bar rows are fully background-filled with text over them; header row is foreground only.
5. Separators: none between segments (rows are separate lines); ` │ ` inside the right label text.
6. Neighbours: separate lines; adjacent cells within a bar differ by gradient step.
7. Text contrast: yes. Per-cell text colour chosen from background luminance: `lum = 0.299r + 0.587g + 0.114b`; black text if `lum > 100` else bright white (`:77-78`). A rare example of computed readable text on generated backgrounds.
8. Glyphs: none beyond text; plain characters on the coloured cells.
9. Notable: three stacked bars (context, 5h, weekly) with labels embedded inside the bar (left text and right text); darkened "elapsed time" region marks where steady pace would be (`markerPct`).
10. Customisation: none (edit constants like `BAR_WIDTH`).

## agent-session-status
https://github.com/dcaixinha/agent-session-status, stars 0
not a Claude statusline: a Rust tool that reduces OpenCode/Claude Code/Codex session events into a state store for Waybar and Ironbar widgets (Pango markup). Colour note only: three states, `waiting #e0af68`, `working #9ece6a`, `idle #7f849c` (`src/render.rs:439-441`), overridable via `AGENT_SESSION_STATUS_COLOR_<STATE>` and a per-theme `_LIGHT`/`_DARK` variant resolved on every call (`render.rs:454-464`).

## claude-statusline (DDDDD12138)
https://github.com/DDDDD12138/claude-statusline, stars 0 (read `src/theme/theme.ts`, `tokyo-night.ts`, `src/ansi.ts`, `src/segments/context.ts`, `src/render.ts`)
1. Theme role mapped to segments: `Theme` interface (`theme.ts`) has `model effort dir branch separator dim barEmpty barGradient[3]`. Tokyo Night values: model `#7aa2f7`, effort `#565f89`, dir `#c0caf5`, branch `#bb9af7`, separator `#3b4261`, dim `#565f89`, barEmpty `#3b4261`, gradient `#9ece6a -> #e0af68 -> #f7768e`. Context is by value: an 8-cell `━` bar where each filled cell takes `gradient(stops, i/(8-1))` (a fixed gradient revealed by fill) and the percentage takes the colour of the bar's leading edge (`context.ts`, `ansi.ts` `gradient`: linear RGB mix across 3 stops).
2. Themes: one (Tokyo Night). The `Theme` type is the extension point (hex strings); to add one a developer writes a second object. Not user-configurable at runtime.
3. Truecolor foreground only (`fgRgb`, "no dependency on the terminal's palette"). No NO_COLOR, no downsampling (the scan saw `env.truecolor=2` in docs).
4. Fill: foreground only.
5. Separators: ` · ` in `theme.separator` (`render.ts:5`).
6. Neighbours: separator only; hue per role.
7. Light/dark: not present.
8. Glyphs: `━` cells; no Nerd Font.
9. Notable: gradient implemented in RGB linearly (not OKLCH); a segment is a function `{input, theme} -> string | null`, a failing segment is skipped not fatal; `scripts/svg.ts` and `preview.ts` regenerate the README screenshot from real output.
10. Customisation: editing source and rebuilding a single-file `statusline.mjs`; installer writes settings.

## claude-mods (debba)
https://github.com/debba/claude-mods, stars 0 (read `statusline/statusline.sh`, 74 lines; the other plugins in the repo are unrelated mods)
1. Fixed per segment, no thresholds: model bold white, branch green, PR link cyan, ctx bar+percent white, 5h bar+percent yellow, weekly purple, reset time white, dashboard link cyan underlined (`statusline.sh:51-71`). Bars are bracketed `[████░░░░]` in the segment colour with the empty part dim.
2. Themes: not present.
3. ANSI 16 (`\e[97m`, `33`, `32`, `35`, `36`). No NO_COLOR.
4. Fill: foreground only.
5. Separators: two spaces.
6. Neighbours: one hue per segment (white / yellow / purple), no separators.
7. Light/dark: not present (white text assumes dark ground).
8. Glyphs: `█`/`░`; OSC 8 hyperlinks for PR and dashboard.
9. Notable: each of the three quota bars has its own identity colour, rather than a threshold colour, so you tell meters apart by hue.
10. Customisation: edit script.

## context-gauge
https://github.com/Deckerda/context-gauge, stars 0 (read `statusline/context-gauge.sh`, 201 lines)
1. By threshold, for the gauge and percent only: green by default, amber `\033[33m` at >= 50, red `\033[31m` at >= 80 (`RAMP="50,80"`, `:88-91`); dim when the percentage is unknown. Everything else (model, dir, branch, cost, time, tokens, rate limit, style, version) is plain dim (`DIM`, `\033[2m`).
2. Themes: not present; env `CONTEXT_GAUGE_STYLE` chooses glyph style (blocks, smooth, ascii, dots), not colour.
3. ANSI 16 + dim. NO_COLOR honoured: `if [[ -n "${NO_COLOR:-}" ]]` sets every colour variable empty (`:63-64`), the only project in the batch that does so.
4. Fill: foreground only.
5. Separators: `CONTEXT_GAUGE_SEP`, default two spaces.
6. Neighbours: none beyond spacing; dim vs. coloured gauge.
7. Light/dark: dim attribute rather than a colour, which adapts to either ground.
8. Glyphs: `█ ░` (smooth adds partial-block); an `ascii` style for fallback.
9. Notable: `CONTEXT_GAUGE_RAMP=off` for a single uncoloured gauge; the comment calls the ramp "purely cosmetic"; segment order is a comma list.
10. Customisation: environment variables only (`CONTEXT_GAUGE_SEGMENTS/WIDTH/STYLE/RAMP/SEP`, `NO_COLOR`).

## claude-statusline-plugin
https://github.com/Deepanhp/claude-statusline-plugin, stars 0 (read `scripts/statusline.sh`, `scripts/themes.json`, `scripts/apply-theme.sh`)
1. Theme role mapped to segments with seven named colour slots, then fixed assignment: slots `cyan green yellow orange purple blue gray` (`statusline.sh:112-118`). Assignment: directory CYAN, branch `38;5;109`, duration GRAY, `+n` `38;5;46` and `-n` `38;5;214` (hardcoded, not themed, `:87,95`), cost PURPLE, API calls BLUE, separators dim. Thresholds: context GREEN <= 60, YELLOW > 60, ORANGE > 80 with icon `◉` -> `⚠` (`:163-172`); cache ratio GREEN > 75, YELLOW > 50, else ORANGE (`:199-205`).
2. Themes: 10 in `themes.json`: default (Cyberpunk), dracula, nord, cyberpunk (neon), solarized-dark, gruvbox, ocean, sunset, monochrome, matrix. Format: seven 256-colour indexes per theme (`{"cyan": 87, "green": 46, …}`); the slot name is a hue, not a role, so in `monochrome` cyan/green/yellow are all grays. Theme chosen by `theme` in a config JSON; `/theme` command runs `apply-theme.sh`. Users can add entries to `themes.json`.
3. 256-colour index only (`\033[38;5;Nm`). No depth detection, no NO_COLOR.
4. Fill: foreground only.
5. Separators: dim `│`.
6. Neighbours: separators and hue slots.
7. Light/dark: not present (the scan flagged only words).
8. Glyphs: emoji (📁 ⏱ 📦 ⚡) and `⎇ ◉ ⚠`; no ASCII mode.
9. Notable: feature toggles per field (`enabled_features` in config: git, context, duration, changes, cost, api_calls, cache_ratio); `toggle-feature.sh` and `statusline-cli.sh` scripts.
10. Customisation: JSON config for theme and feature toggles, slash commands (`commands/theme.md`), `themes.json` editable.

## claude-pulse
https://github.com/tumuyijiao114514/claude-pulse (stars: 0)
1. Fixed per segment plus threshold. `scripts/statusline.cjs:640-685`: model is always `C.cyan` bold (256-colour 39); Ctx label/gray, percent coloured by threshold (`:653-655` <60 green, 60-79 yellow, >=80 red); cache-hit badge by threshold (`:665-668` >=80 green, >=50 cyan, >0 purple, else darkGray); 5h quota always `C.magenta`. Effort badge by state (`:189-196,265-271`): low=rgb(255,193,7), medium=rgb(78,186,101), high=rgb(177,185,249), off=gray; these are copied from Claude Code's own /effort palette.
2. Themes: none in the statusline. `scripts/setup-terminal.ps1:43-61` only installs Windows Terminal colour schemes (Tokyo Night, Catppuccin Mocha) for the terminal itself. No user-defined themes.
3. 256-colour indices for the main palette (`:16-28`), truecolor only for the effort badge. No depth detection, no downsampling, no NO_COLOR.
4. Foreground only; no backgrounds.
5. Plain ` │ ` in `C.darkGray` (`:636`).
6. Neighbours told apart by the dim `│` and by each segment having its own hue.
7. Not present. Fixed palette, no light-terminal handling.
8. Emoji icons per segment (📦 model, 💾 cache, ⏳ quota; `:642,672,683`); block-bar `█`/`░` (`:437`). No ASCII fallback.
9. Animation: `xhigh` effort gets a moving shimmer (`renderAutoAcceptShimmer`, `:219-231`, 10 fps), `max` gets a rainbow 7-colour cycle per character (`:199-207,234-241`), ported from Claude Code's own effort rendering. A no-op SGR marker `\x1b[0;0m` is added so Claude Code re-renders at 100 ms. Segments are dropped by priority when too wide (`:687-702`).
10. No config file for styling. Only env `COLUMNS`/`CLAUDE_CODE_EFFORT_LEVEL`; installers `install.sh`/`install.ps1`.

## glm-statusbar-themes
https://github.com/tupacalypse187/glm-statusbar-themes (stars: 0)
1. Three layers. (a) By metric type: capsule style gives each module a rotating pill background (`src/styles.js:60-73` `PILL_PALETTE` cycles pill_5h, pill_7d, pill_mcp, pill_daily, pill_model, edge by module index; model pill uses `pill_model`, session `pill_7d`, daily `pill_daily`, `:278-284`). (b) By state: `severityColor` (`:48-53`) maps pct to `s_ok`/`s_warn`/`s_hot` using thresholds 50/80 (`src/config.js` defaults). (c) Text roles `ink`/`mute`/`edge`.
2. 26 bundled themes in `src/themes.js:36-226` (graphite, twilight, linen, nord, dracula, sakura, mono, catppuccin-mocha, tokyo-night, solarized-dark/light, gruvbox, one-dark, rose-pine, github-dark, night-owl, material, everforest, ayu, palenight, synthwave, cyberpunk, neon, candy, lava). Format is a semantic palette of 13 roles: ink, mute, edge, s_ok/s_warn/s_hot, pill_5h/7d/model/mcp/daily, pill_ink (`:8-27`), all RGB triples. Ported from `claude-code-usage-bar`'s themes.py. Users can only override ok/warn/hot via `color_ok/warn/hot` hex (`src/formatter.js:65-70`, `themes.js:252`); no user-defined themes.
3. Truecolor only (`38;2`/`48;2`, `styles.js:39-40`). No detection, no downsampling, no NO_COLOR.
4. Both. Styles: `classic` (battery bar with bg fill, `buildBatteryBar`), `capsule` (bg pills), `hairline` (fg only), `gradient` (bg-filled bar) (`RENDERERS`, `:366-371`).
5. Capsule: spaces inside the pill plus ` ╱ ` in `edge` colour between pills (`:253`); hairline: `┊` in edge (`:297`). No powerline arrows.
6. Capsule: each pill a different background from the palette (hue/lightness varies by role, themes keep them close in tone, e.g. graphite pill_5h [38,70,83] vs pill_7d [42,56,79]). Hairline: separator only.
7. Per-theme `pill_ink` is the pill text colour, chosen by hand per theme (dark text on linen/sakura/solarized-light, light on dark themes). `linen`, `sakura`, `solarized-light` are the light-terminal themes. No auto-detection.
8. Emoji per module (`styles.js:13-29`), toggled by `emojis` option (default true). Block bar `█░`.
9. Gradient style: bar fill interpolated per cell between severity endpoints (`lerpColor`/`buildGradientBar`, `:118-160`; start/end shift by severity). Battery bar overlays the percent text on the bar.
10. Config `~/.claude/glm-statusbar.json`; precedence CLI flag > env `CLAUDE_STATUSBAR_THEME/STYLE/WARNING_THRESHOLD/CRITICAL_THRESHOLD/COLOR_OK…` > file > default (`src/config.js:1-60`); `bin/cli.js` for commands.

## uma-status-line
https://github.com/turbokazax/uma-status-line (stars: 0)
1. Fixed per segment plus threshold. `uma_statusline/theme.py:8-33` `PALETTE_256`: model=51 (cyan), directory=183 (violet), git=114 (green), separator=240; context bar by threshold `CTX_THRESHOLDS` (`:40-45`): >=90 196, >=80 208, >=60 214, else 114. Mascot sprite coloured by zone/row (`TALL_ROW_STYLES`, `:73-82`: pink 211, violet 183, gold 220, cyan 51). State label colours: idle 245, working 211, error 196 (`LABELS`).
2. One hard-coded palette dict; no theme names, no user themes (edit the file).
3. 256-colour indices for the palette. Sprite art uses truecolor when `COLORTERM` is truecolor/24bit, else nearest xterm-256 via `rgb_to_256` (`:112-150`, cube vs grey ramp). NO_COLOR honoured, also `TERM=dumb` and `UMA_STATUS_NO_COLOR` (`color_enabled`, `:153-159`); `UMA_STATUS_NO_TRUECOLOR` forces 256.
4. Foreground, except half-block sprite cells that use fg+bg pairs (`style_fg_bg`, `:172-186`).
5. Single space in `separator` colour (`layout.py:66,111`).
6. Only hue per segment role and the space separator.
7. Not present.
8. Block/braille mascot sprites (animated, 1 fps frames, `FRAME_DURATION`), `█░` context bar. Uses U+2800 braille blank as invisible padding because Claude Code trims leading whitespace (`:106-109`).
9. Animated mascot character on row two (braille, block, halfblock/pixel modes; experimental Kitty graphics under `experimental/`), tall sprite 8 rows.
10. Env only: `UMA_STATUS_HEIGHT`, `UMA_STATUS_PIXEL_MODE`, `UMA_STATUS_STYLE`, `UMA_STATUS_NO_COLOR`, `UMA_STATUS_NO_TRUECOLOR`. Constants edited in `theme.py`.

## claude-cli-context
https://github.com/tushar9989/claude-cli-context (stars: 0)
1. Roles and state, foreground only. `statusline.sh:67-75` defines `c_label,c_sec,c_sep,c_val,c_warn,c_crit,c_bar,c_empty,c_effort,c_time`. Values are bold-white (dark) / bold-black (light) by default; `level()` (`:103-105`) switches value colour by percent: >=80 `c_crit`, >=50 `c_warn`, else `c_val`. Bar fill `c_bar` (blue 75/25) until >=50% then the level colour (`:358-360`). Effort is purple 141/91 (`:373`). Reset times in Claude Code's own "permission" colour so they match inline code (`:77-80`).
2. Two palettes (dark, light) in the script, picked by macOS appearance (`defaults read -g AppleInterfaceStyle`, `:64-66`). Also ships two Claude Code custom-theme files `themes/chat-dark.json`, `themes/chat-light.json` (`base` + `overrides.userMessageBackground: ansi256(24)/(153)`) plus a `chat-auto.json` the script rewrites to follow macOS appearance (`:82-94`). These theme Claude Code itself, not the bar.
3. 256-colour indices; truecolor (`38;2`) only for the reset-time colour when `COLORTERM` is truecolor/24bit and not Apple Terminal (`:77-80`). Deliberately avoids faint/dim SGR because Terminal.app fades it (`:62`). No NO_COLOR.
4. Foreground only.
5. ` │ ` in `c_sep` (242 dark / 249 light, `:96`).
6. Separators plus label (`c_label`) vs value (`c_val`) contrast.
7. Yes: explicit dark/light palettes, colours chosen per polarity (e.g. warn 220 dark vs 130 light, `:68,73`); detection is macOS-only, defaults to dark elsewhere.
8. `░` bar; no emoji. Plain text labels (`ctx`, `reset`).
9. Weekly-limit projection ("ends X%", "out in…") coloured via `level()` on the projected pace (`:347`).
10. No config; theme files are Claude Code themes dropped into `~/.claude/themes`.

## phosphorflux
https://github.com/twjohnwu/phosphorflux (stars: 0)
1. Theme role per segment, with state overrides. `src/segments/defaultColorTokens.ts` maps segment id to palette token: model→`model`, effort→`effort`, git→`git.ok`, dir→`dir`, ctx→`ctx.ok`, limit5h/7d→`ok`, node/python, version, cost, burn→`clock`, pomodoro→`pomodoro.work`. State: gauges (ctx, limit5h, limit7d) switch ok→warn→hot at `gauge.warnPct` 65 / `hotPct` 85 (`docs/THEME.md`); git clean `#00CDCD` vs dirty `#00FFFF`. Per-segment override chain in `src/color/resolveColor.ts`: `segments.<id>.fg|bg` > `rows[n].color` > template default, fg and bg fall back independently.
2. Three read-only built-in templates (`docs/THEME.md`): `matrix-tron` (default, 25 palette tokens), `solarized-dark`, `solarized-light`. Format is a flat token→hex palette (`dir`, `git.ok`, `git.dirty`, `model`, `ctx.ok`, `gauge.*-well`, `ok/warn/hot`, `text`, `text.dim`, `sub.*`, `pomodoro.*`). Users can save custom templates to `~/.claude/phosphorflux/templates/<name>.json` via the TUI (save-as).
3. Hex only. `src/color/detectDepth.ts`: `colorDepth` config `auto|16color|256color|truecolor`; auto = `COLORTERM=truecolor` > `TERM` ending `-256color` > 16color; `encodeColor` downsamples. NO_COLOR: not seen.
4. Docs say bg is reserved: the current `lean` style renders fg only ("`bg` has no visible effect", `THEME.md`); gauges have a "well" bg for the empty track.
5. `lean` style: no separator glyph by default; segments joined by spaces (`src/render/index.ts:723-725`).
6. Separation by hue only (different palette token per segment) and spacing.
7. Solarized light/dark templates are the only polarity adaptation; manual selection.
8. Unicode bar gauges; `src/segments/glyphPrefix.ts` adds optional glyph prefixes. No Nerd-font requirement stated.
9. React/Ink TUI (`src/tui/MainMenu/ColorsThemeScreen.tsx`) with a Colors and Theme screen, templates screen, first-run wizard; bold per segment (`segments.<id>.bold`).
10. JSON `~/.claude/phosphorflux/settings.json` (+ JSON schema), `phosphorflux config` command, TUI, `$PPF_CONFIG_DIR`.

## phosphorpulse
https://github.com/twjohnwu/phosphorpulse (stars: 0)
1. Rust port of phosphorflux, same model. Theme palette token per segment; `gauge.okColor/warnColor/hotColor` for limit5h, limit7d, limitModel, ctx, cache; `segments.<id>.fg|bg`; subagent line has its own `subagent.colors.<id>` that does NOT inherit from `segments` (`docs/themes.md`). Precedence for ok state: row `color.fg` or `segments.<id>.fg` > `gauge.okColor` > theme; warn/hot always from `gauge.*` (`docs/themes.md`).
2. Three built-ins (`src/render/themes.rs`: `matrix-tron`, `solarized-dark`, `solarized-light`), each a `BTreeMap<token, "#RRGGBB">` (e.g. solarized-dark dir `#268BD2`, git.ok `#2AA198`, git.dirty `#B58900`, ctx.ok `#859900`, clock `#CB4B16`) plus default rows. Custom templates: save-as, load, export, import in the TUI; loading a template does not apply a custom colour palette (documented limitation, `docs/themes.md`).
3. Hex `#RRGGBB` only (config validation rejects others). Depth handling not verified here (extractor saw COLORTERM/256color env reads in `src/jsx/color.rs`).
4. Foreground; gauge wells use bg. Same lean style as phosphorflux (unverified for bg).
5. Not verified; `glyph.nerd_font` signal present in extractor counts, so a Nerd-font separator option likely exists (unverified).
6. Hue per segment via tokens; two default rows with a `flex` spacer between left and right groups (`themes.rs` `common`).
7. Solarized light/dark only.
8. Emoji and Nerd-font glyphs present per extractor counts; unverified in detail.
9. Also edits Codex CLI `.tmTheme` files (scope colours `constant.numeric`, etc.) with a live preview in the TUI (`src/tui/screens/tmtheme_editor.rs`, `docs/themes.md`). Pomodoro segment.
10. JSON config, ratatui TUI with Colors screen and Templates screen, template export/import.

## YetAnotherCCStatusLine
https://github.com/tylyp/YetAnotherCCStatusLine (stars: 0)
1. By threshold, plus fixed. `statusline.js:37-47` theme has 4 colours: `low`, `mid`, `high`, `label`; `colorForPct` (`:57-61`) picks low <50, mid 50-79, high >=80 for bars and percentages. Directory and model text are `dim` (`:196-197` area); labels `ctx/5h/7d` use `label`. Context >= a threshold prints a blinking skull 💀 (`\x1b[5m`).
2. Nine bundled themes in `THEMES` (`:37-47`): default, ocean, sunset, mono, neon, frost, ember, candy, matrix. Format is 4 RGB triples (low, mid, high, label). Selected by `cfg.theme`; no custom definitions.
3. Truecolor `38;2` only (`:50`); no detection, no NO_COLOR.
4. Foreground only.
5. ` | ` dim (`sep`, `:239` area).
6. Not really needed: lines are one metric each (dir | model, ctx, 5h, 7d on 4 lines).
7. `mono` theme is dim greys; `linen`-style light handling not present.
8. Nine bar styles `BAR_STYLES` (`:25-30`: classic █░, shade ▓░, dot ●○, square ■□, star ★☆, pipe, thin, braille, arrow) and five sizes. 💀 emoji only.
9. `assets/themes.svg` / `generate-previews.py` produce a theme gallery image.
10. JSON config at `$CCSTATUSLINE_CONFIG`, `~/.config/ccstatusline/config.json`, or beside the script (`:11-14`); keys `theme`, `bar_style`, `bar_size`, reset-time format.

## ai-usage
https://github.com/Tyrannoapartment/ai-usage (stars: 0)
not a Claude statusline: a terminal live usage dashboard and macOS menubar app for Claude Code and Codex quotas (`bin/ai-usage` is a refreshing TUI; `--menubar` emits SwiftBar frames). For reference its colour logic is a 7-stop 256-colour ramp by percent (`ramp_code`, 46→82→154→226→214→202→196→160), NO_COLOR and `tput colors` honoured (`:163-173`), brand colours per vendor (claude 173, codex 36), but it is not a statusLine command.

## u-hashmi/claude-statusline
https://github.com/u-hashmi/claude-statusline (stars: 0)
1. Fixed per segment (theme role). `statusline.sh:34-53` each theme sets `C_MODEL`, `C_DIR`, `C_GIT`, `C_CTX`, `C_COST` plus `TEXT_FG`; `resolve_segment` (`:203-218`) maps model→C_MODEL, dir→C_DIR, git→C_GIT, context→C_CTX, cost→C_COST, usage→C_GIT, duration→C_DIR, lines→C_MODEL. Tokyonight example: model purple 187;154;247, dir blue 122;162;247, git green 158;206;106, ctx amber 224;175;104, cost pink 247;118;142. Context bar uses `mix(C_CTX, 66/32)` to darken track/fill (`:145-146`); no threshold colouring seen.
2. Six themes: tokyonight, dracula, catppuccin, nord, gruvbox (default), rosepine (`:35-53`), chosen by `CLAUDE_STATUSLINE_THEME`. Format = 5 segment colours + a text colour as "R;G;B" strings. No user-defined themes.
3. Truecolor only (`fg()`/`bg()`, `:87-88`). No detection, no NO_COLOR.
4. Background-filled powerline cells with dark text (`TEXT_FG`).
5. Powerline arrow U+E0B0 when `USE_NERD_FONT=true`, else `›` (`:67-82`). Arrow fg = previous cell bg, arrow bg = next cell bg; last arrow on terminal bg (`render_row`, `:246-262`).
6. Different hue per segment role; the arrow joins them.
7. Text colour is a per-theme dark constant (`TEXT_FG`, e.g. 26;27;38 on tokyonight) chosen by hand; no light/dark adaptation.
8. Nerd-font on/off switch (`USE_NERD_FONT`) with ASCII fallbacks (`*`, `git:`, `t`, `~`); context bar glyph `▬` vs `=`.
9. Wrap: packs segments into extra powerline rows by `$COLUMNS` (`:267-283`). Density presets minimal/balanced/full.
10. Env vars only: `CLAUDE_STATUSLINE_THEME`, `_DENSITY`, `_SEGMENTS`, `USE_NERD_FONT`, `WRAP`, `BAR_CELLS`. `statusline.ps1` for Windows; `assets/gen_svg.py` generates screenshots.

## MorgottStatusLine
https://github.com/UberMorgott/MorgottStatusLine (stars: 0)
Based on claude-limitline (per `package.json` description); bundled single file `dist/index.js`.
1. Theme role per segment plus threshold. `dist/index.js:1111-1142` themes map `directory`, `git`, `model`, `block`, `weekly`, `opus`, `sonnet`, `context`, `warning`, `critical` each to `{bg, fg}`. Segments take their own entry (`:1385` directory, `:1401` git, `:1412` model, `:1451` block, `:1486` weekly, `:1571` context). `getColorsForPercent` (`:1346-1352`): >=100 → `critical`, >= `budget.warningThreshold` (80) → `warning`, else base. The `opus`/`sonnet` entries are defined but no reference to them was found in the bundle. Progress bar fill is a separate green→yellow→red RGB ramp by percent (`getBarColor`, `:1288-1297`), empty cells grey 90,90,90.
2. Six themes (`:1203-1210`): dark, light, nord, gruvbox, tokyo-night, rose-pine. Format = per-segment `{bg, fg}` hex map with shared warning/critical entries. Selected by config `theme`; no custom themes seen.
3. Hex → truecolor `38;2`/`48;2` only (`:1100-1110`). No detection, no NO_COLOR.
4. Background-filled with fg text.
5. Powerline arrow U+E0B0 when Nerd fonts enabled (`SYMBOLS.right`), `|`/`>` text set otherwise (`TEXT_SYMBOLS`, `:1063-1090`); fallback join is ` | ` (`renderFallback`, `:1371`). Arrow fg = this cell's bg, arrow bg = next cell's bg (`:1360-1365`).
6. Hue/lightness steps in the theme (dark: directory `#8b4513`, git `#404040`, model `#2d2d2d`, block/weekly/context `#1e1e1e`) so neighbours are near-greys of different lightness, plus arrows.
7. `light` theme (orange/blue bg) exists; hand-picked fg per entry; no auto-detection.
8. `display.useNerdFonts` default true, switches the symbol set and powerline arrows (`:20,1259-1261`). Russian-language labels (e.g. `5ч`).
9. Progress bar with smooth green→red gradient; prognosis ("5h→100% ~T"), trend arrows.
10. JSON config deep-merged over defaults (`src/config/loader`, `DEFAULT_CONFIG` ~`:55-70`), keys `theme`, `segmentOrder`, `display.*`, `budget.warningThreshold`; `install.sh`/`install.ps1`.

## tmux-agent-tracker
https://github.com/ulas96/tmux-agent-tracker (stars: 0)
not a Claude Code statusline: a tmux/Neovim-style plugin that tracks Claude Code and Codex sessions in tmux (status line per pane window, numbered badges on pane borders). For reference: colours are per agent state (waiting yellow, done-unread orange, done green, working blue) via config keys `color-waiting/complete/unchecked/busy/unknown/selected` (`lua/agent_tracker/render.lua:39-45`), emitted as tmux `#[fg=…,bg=…]` styles with an optional pill/powerline-capsule module style (`:154-192`).

## cyberpunk-hud
https://github.com/ultimatevegance/cyberpunk-hud (stars: 0)
1. Theme role per segment plus gradient by value. `lib/segments.mjs`: callsign=`accent` (pulsing); model name=`accent2` bold, effort=`warn`, thinking `accent`, fast `ok`; dir=`ok` bold with `accent2` pointer; git=`ink`; context and limit bars = value→colour gradient over `[ok, warn, crit]` stops (`gaugeBar`, `gradient(stops, pct/100)`, `:6-20,52-60`); cost=`warn`; lines `ok`/`dim`/`crit`; duration/clock `accent2`+`dim`; version `dim`.
2. Five bundled themes in `lib/themes.mjs`: netrun, synthwave, matrix, vapor, ice. Format is 7 semantic roles of RGB triples: `accent, accent2, ok, warn, crit, dim, ink`. User can override any role via `palette` in config (`resolveTheme(name, overrides)`, `lib/config.mjs`), not define whole new named themes.
3. Truecolor default; `lib/color.mjs:detectMode`: `CYBERPUNK_HUD_COLOR` override, NO_COLOR or TERM=dumb → none, `COLORTERM` truecolor/24bit → truecolor, TERM contains 256 → 256 (`rgbTo256` cube/grey mapping), else truecolor.
4. Foreground only.
5. Plain separator, default `"  │  "` (`config.mjs` DEFAULTS), render uses `cfg.separator || "  ░  "` in `dim` (`render.mjs:36`). Decorative brackets `▟▙`, `⟨ ⟩` around callsign/model.
6. Different roles per segment; `dim` separator.
7. Not present.
8. Unicode braille gauge `⣿`, `▸`, `⎇`, `⚡`; no Nerd fonts, no ASCII fallback.
9. Animation modes idle/active/alert (`computeAnimMode`, `render.mjs:19-26`): idle callsign pulse (brightness sine), active shimmer travelling across gauge cells (`brightness(color,1.7)`), alert glitch-char text (>=85% ctx or >=90% limits), marquee for long dir/branch names. Segment drop order when too wide (`DROP_ORDER`).
10. JSON `~/.claude/cyberpunk-hud/config.json` (`theme`, `callsign`, `segments`, `animation.*`, `palette`, `separator`, `colorMode`); CLI `bin/cyberpunk-hud.mjs`; install script chains a previous statusLine.

## un-lucielafarge/claude-statusline
https://github.com/un-lucielafarge/claude-statusline (stars: 0)
1. Fixed per segment plus threshold. `statusline-command.sh:30-60`: repo cyan bold `\033[1;36m`, branch magenta bold `[1;35m`, "no repo" dim, model yellow bold `[1;33m`; context bar colour by percent (<50 green, <80 yellow, else red, all bold).
2. Not present.
3. ANSI 16 only. No detection, no NO_COLOR.
4. Foreground only.
5. Plain ` | `, uncoloured.
6. Different hue per segment.
7. Not present.
8. ASCII bar `[#####-----]`; no emoji or Nerd glyphs.
9. Not present.
10. None; edit the script.

## unaibermudez/claude-statusline
https://github.com/unaibermudez/claude-statusline (stars: 0)
1. Threshold-driven value colour. `statusline.sh:22-54`: bar and percent green <50, yellow 50-79, red >=80 (bold percent). Fixed: separator `GRAY` ` │ ` (`:75`), countdown `GRAY` parens with `WHITE` time; defined but unused-by-threshold cyan/blue/magenta for labels (unverified which segments).
2. Not present.
3. ANSI 16 (`\033[3Xm`, bright white 97 and gray 90). No NO_COLOR, no detection.
4. Foreground only.
5. ` │ ` in bright-black (`SEP`, `:75`).
6. Separators only.
7. Not present.
8. Block-character bar (many box glyphs); `install.ps1` for Windows. No emoji.
9. Context, 5h (with reset countdown), weekly (7d) bars.
10. None beyond editing the script; `install.sh`/`install.ps1`.

## claude-usage-mods
https://github.com/underscoreloG/claude-usage-mods (stars: 0)
Claude Code mods (Ink/React `<Text>` components in a plugin), not a classic `statusLine` command; the `usage-band` mod is a one-line band above the prompt.
1. Semantic role by state, via Claude Code's own theme tokens, so the host theme decides actual RGB. `usage-band/hooks/register.tsx:53-58` `level(pct)`: >=80 `error`, >=50 `warning`, else `success`; used on percentage text and bar. Model name uses `color="claude"` (`:175`); labels and separators `dimColor`. `agents-band/hooks/register.tsx:20-23` fixed per model family: fable `#f2c94c`, opus `#b388ff`, sonnet `#4f8cff`, haiku `#3ecf8e` (`MODEL_COLORS`, applied `:238,305`); running counts `claude`, idle/other `subtle`.
2. No themes of its own; inherits Claude Code's theme (role names `success/warning/error/claude/subtle`).
3. Named roles from the host plus literal hex in `MODEL_COLORS`; depth handling and NO_COLOR are the host's.
4. Foreground only.
5. `│` in `dimColor` between groups (`:179-180`).
6. Group separators and dim labels.
7. Inherits host theme (role colours adapt to Claude Code light/dark themes); hex model colours are fixed.
8. Emoji/symbols (✈, ⚙️, ✓, ✗, ■, spinner frames).
9. Spinner animation in agent rows; mods are clickable buttons (✈, ⚙️). Not a pure statusline.
10. Plugin toggles via slash commands (`/usageband`, `/agentsband`); no colour config.

## unify-kit
https://github.com/unifylabs-dev/unify-kit (stars: 0)
Not mainly a statusline: a workflow plugin; its statusline is `plugins/unifylabs-workflow/statusline/statusline.sh` (77 lines).
1. Threshold plus fixed. Context bar colour: >=90 red, >=70 yellow, else green (`:54-60`). Model `[name]` uncoloured, branch default, lines-changed count cyan `\033[36m`, cwd magenta `\033[35m` (`:67-76`).
2. Not present.
3. ANSI 16. No NO_COLOR.
4. Foreground only.
5. Two-space gaps; no separator glyph.
6. Spacing and per-field hue (cyan, magenta, bar colour).
7. Not present.
8. `▓░` bar, `Δ` marker. No emoji.
9. Not present.
10. None.

## AI-Engineering-Lab
https://github.com/UnscriptedByKraMy/AI-Engineering-Lab (stars: 0)
Statusline lives in `Statusline/` of a larger repo.
1. Role-based decoration applied at render layer (`Statusline/lib/style.js`): route segment = provider prefix in a provider hue (`config.js:22-23` providerHues: local green, opencode 38;5;111, nvidia cyan, gemini magenta) + bold light-blue model (`modelColor 38;5;117`); git branch muted green 38;5;65, but bright red 196 on main/master (`branch()`, `mainBranchColor`); context fill/tokens grey 245; stale marker yellow; usage bar and percent by threshold (`usageThresholds`: <50 green, <80 yellow, else red); empty bar cells 238.
2. One `STYLE` object in `Statusline/lib/config.js:22-37`; no named themes.
3. Named SGR 31-36 plus 256-colour `38;5;n` strings (`NAMED` map). NO_COLOR (any value) disables all decoration (`colorEnabled`, `style.js`), returning plain text.
4. Foreground only.
5. Not verified (plain text separators in segments).
6. Not verified in detail; hue per segment and provider.
7. Palette hand-picked "dark-mode readable"; no adaptation.
8. Emoji for route/branch/worktree/state (`ROUTE_EMOJI`, `BRANCH_EMOJI`, etc., `config.js`), `▓░` bar.
9. Main-branch warning colour is the stand-out: branch turns red on the protected default branch, including remotes' HEAD branches.
10. Constants in `config.js`; `Scripts/deploy-statusline.js` installer.

## forged-statusline
https://github.com/urda/forged-statusline (stars: 0)
1. Fixed per segment plus threshold. `urda-com-forged-statusline.sh:910-923,484-490`: model WHITE, context badge CYAN, effort CYAN, "Thinking: OFF" RED, dir BLUE, update badge CYAN, labels/brackets/countdown GRAY; gauge bar+percent by threshold (`render_bar`, `:361-410`): green < warn (default 50), yellow < alarm (80), else red, per-gauge overrides `THRESHOLD_<GAUGE>_WARN/ALARM`.
2. Not present, apart from a dark/light switch.
3. ANSI 16 (`\033[3Xm`, 90 for gray); 256-colour 30 and 240 for light mode. No NO_COLOR seen.
4. Foreground only.
5. ` | ` in GRAY (`SEP`, `:137`).
6. Separators and per-field hue.
7. Yes: `URDA_AI_FORGED_STATUS_LINE_THEME=light` retints only colours that wash out on white: cyan→38;5;30, gray→38;5;240, white→default fg (`:128-134`). Manual.
8. Emoji icons per field (🔮 model, 🦾 effort, 💾 dir, 🧠 context, 🔴/🟡 alarm, `:103-112`), all overridable via env and disabled by `URDA_AI_FORGED_STATUS_LINE_ICONS=0`. Eighth-cell block bar.
9. Update-check badge; cache writer.
10. Env vars `URDA_AI_FORGED_STATUS_LINE_*` (THEME, ICONS, THRESHOLD_WARN/ALARM, per-icon overrides); installer `install.sh`.

## agentic (statusline package)
https://github.com/v1nvn/agentic (stars: 0)
Monorepo; styling is in `packages/statusline`. (`packages/rulings/src/style.ts` is HTML page CSS for a different tool, not the statusline.)
1. Fixed per segment/variant plus state. `src/render/segments.ts`: plain model `cyan`; block model bg 61 with fg 231 (`modelBlock`); pill model same with U+E0B6/E0B4 rounded caps (`modelPill`, `:78-97`); effort plain cyan or dim; state pills bg 95/240/97/66 (`statePill`, `:110-129`, e.g. INSERT bg 97 fg 16, THINK bg 66); git ahead green, behind red; bar/gauge uses a 26-step green→red RGB `HEAT` ramp (`:30-58`, `HEAT[i]` per cell, `:368`) with empty cells `GRAY` rgb(68,71,90).
2. "Themes" are layout/variant bundles, not colour palettes (`src/themes.ts:15-102`): `quiet`, `classic`, `lean`, `rich`, `custom`, each a layout string plus per-item variant picks (e.g. model: plain|block|pill|zen). No colour themes; the colours come from the chosen variant.
3. Ink type with named colours, indexed 256 (`indexed(n)`) and rgb (`@v1nvn/agentic-core/draw`). NO_COLOR: one reference in the package (not located).
4. Both: plain/zen are fg only, block/pill variants are bg-filled.
5. Separator style item (`styleSeparators`, `segments.ts:637-649`): `plain` ` │ `, `dots` ` · `, `dim` dim ` │ `, `bare` spaces. Rounded pill caps U+E0B6/E0B4 for pill variants; powerline glyph signals (`glyph.powerline`).
6. Separators/pill caps; no hue alternation rule.
7. Not present.
8. Nerd-font glyphs for pill caps and icons (`cwd=icon`, `branch=icon`, `status=icons`); text-only `lean` theme as the fallback.
9. Interactive wizard (`wizard-tui.ts`) and `configure` CLI with live preview, `catalog`, `status`; cache-expiry "fuse" visual, burn-rate cost.
10. CLI flags per item (`model=pill`), `--theme`, `--layout`; wizard writes settings; precedence item flags > theme > defaults (`src/render/theme.ts`).

## vadimvitvickiy/claude-statusline
https://github.com/vadimvitvickiy/claude-statusline (stars: 0)
1. Fixed per kind of value, with threshold for usage. `statusline.sh:25-31,157-246`: MODEL blue, EFFORT/FAST/AGENT violet, FOLDER amber, BRANCH/PR/WORKTREE fuchsia, CACHE teal ("cold" orange), SESSION and reset countdowns cyan, lines +green/-red, PR state approved green/pending orange/changes red; every usage value (context, 5h, 7d, spend) green below 50, orange from 50, red from 80 (`usage_color`, `:80-90`). Titles uppercase bold in terminal text colour.
2. Two palettes dark/light hard-coded (`:25-31`: 9 colours each); dark = Tailwind 300 shades, light = Tailwind 800 shades. No user themes.
3. Truecolor only (`\033[1;38;2;R;G;Bm`, `paint`, `:75`). No NO_COLOR.
4. Foreground only, all values bold.
5. `"  ·  "` between fields, unstyled (`SEPARATOR`, `:34`).
6. Each kind of value has its own hue; titles in plain terminal colour vs coloured values.
7. Yes, and with a stated reason: Claude Code draws the whole status line dimmed, so shades are the darkest (light) or brightest (dark) that still read as their hue (header comment `:8-12`). Dark/light from macOS `AppleInterfaceStyle` or `CLAUDE_STATUSLINE_THEME`.
8. No icons; uppercase text titles.
9. Reads many newer payload fields (effort, fast mode, prompt cache, PR review state, spend limit).
10. Env `CLAUDE_STATUSLINE_THEME`; edit script constants (`WARNING_PERCENT`, `ALERT_PERCENT`).

## vanhiep99w/claude-statusline
https://github.com/vanhiep99w/claude-statusline (stars: 0)
1. Fixed per segment plus threshold. `statusline-command.sh:6-16,160-231`: directory cyan bold, git info magenta, bar+percent colours <50 green / 50-79 yellow / >=80 red (`:77-83,129-131`), model dim, tools-used dim, clock white, vim mode NORMAL yellow / INSERT green (`:182-188`). Separators dim.
2. Not present.
3. ANSI 16. No NO_COLOR.
4. Foreground only.
5. Thin Nerd-font separator `sep_thin` dim with two spaces each side (`:195`), `│` pipe and `❯` chevron defined at `:20-21`.
6. Dim separators.
7. Header comment: "dim-friendly — works well on terminal dimmed palette" (`:6`); otherwise none.
8. Heavy Nerd-font use: path joined with `󰿟`, branch/tools/clock glyphs (`:33,200-231`); no ASCII fallback.
9. Shows context bar with token count, 5h and weekly bars with reset times.
10. None; edit script. `install.sh`.

## ccstatusline (vbonk)
https://github.com/vbonk/ccstatusline (stars: 0)
Not marked as a fork in the batch (GitHub says `isFork: false`), but its layout matches sirmalloc/ccstatusline; documented in full.
1. Per widget, user-assigned. Each widget in settings has `color` and `backgroundColor` (names or `ansi256:N`/`hex:RRGGBB`); defaults per widget type. In powerline mode with a theme, colours are assigned by POSITION: `themeColors.fg[widgetColorIndex % len]` and `bg[...]` (`src/utils/renderer.ts:197-201`), so widgets cycle through the theme's 5 fg/bg pairs; theme `custom` uses each widget's own colours.
2. Powerline themes in `src/utils/colors.ts:268-440`: custom, nord, nord-aurora, monokai, solarized, minimal, dracula, catppuccin, gruvbox, onedark, tokyonight. Format `{name, description, 1|2|3: {fg: string[], bg: string[]}}` keyed by colour level (1=ansi16, 2=ansi256, 3=truecolor), so every theme is hand-tuned per depth. Selectable in TUI (`PowerlineThemeSelector.tsx`), copying to custom is supported. Users define colours per widget (custom), not new named themes.
3. Names (`red`, `brightBlue`, `bgGreen`, 32 entries each with ansi16/ansi256/truecolor variants, `colors.ts:9-53`), `ansi256:N`, `hex:RRGGBB`. `colorLevel` setting 0-3 sets `chalk.level` (`src/ccstatusline.ts:91-94`) and picks the column of each named colour; named colours have fixed 256 indices (16-231) rather than the terminal's 0-15 so they stay stable across terminal themes. NO_COLOR not seen.
4. Both: plain mode fg (+ optional bg); powerline mode bg-filled with fg.
5. Powerline separators are a list (`separators: string[]`, default U+E0B0, per-position, last repeats), `separatorInvertBackground[]`, `startCaps[]`, `endCaps[]` (`renderer.ts:87-98,337-385`). Normal: separator fg = left cell bg (`bgToFg`), bg = next cell bg. Inverted variant swaps. Merge option fuses adjacent widgets into one cell. Same-bg neighbours handled specially (`:360-370`).
6. Positional cycling through the theme's colour list; separators.
7. Foreground for caps derived from background (`bgToFg`); contrast is per-theme hand-chosen fg lists (e.g. nord level-1 fg `black, brightWhite, brightWhite, black, black`). No auto detection.
8. Powerline glyphs with font checker/installer (`src/utils/powerline.ts` `checkPowerlineFonts`, `PowerlineSetup.tsx`); emoji in some widgets.
9. Full Ink TUI with colour menu (`ColorMenu.tsx`), live preview (`StatusLinePreview.tsx`), `autoAlign` of columns, global bold/override colours.
10. `~/.config/ccstatusline/settings.json`, interactive TUI, CLI.

## claude-statusline-1m
https://github.com/vedmichv/claude-statusline-1m (stars: 0)
Node wrapper (`statusline.js`, `cli.js`) around Python `scripts/context-monitor.py`; styling is in the Python script.
1. Threshold-driven plus fixed. Context (`context-monitor.py:295-347`): <50 🟢 green, >=50 🟡 yellow, >=75 🟠 `\033[91m`, >=90 🔴 red, >=95 🚨 bold red; bar `█▁` 8 cells. Model brackets coloured by context (`:895-907`): <75 green, 75-89 yellow, >=90 red (blue `\033[94m` when unknown). Directory bright yellow `\033[93m` with 📁. Cost: <0.05 green, <0.10 yellow, else red (`:786-798`); daily cost via `DAILY_YELLOW/DAILY_RED` env floats (`:728-734`); duration yellow long/green; lines +green/-red/yellow; provider badge magenta `\033[35m`; token counts and separators gray `\033[90m`.
2. Not present.
3. ANSI 16 plus bright codes. No NO_COLOR.
4. Foreground only.
5. Gray ` | ` before the metrics group (`:839`); other fields space-separated.
6. Emoji and hue.
7. Not present.
8. Emoji heavily (🚨🔴🟠🟡🟢 per level, 📁, 🧠, 💰, ⏱, 📝, 💸); no ASCII fallback.
9. Provider detection (badge), keyboard layout indicator, 1M-context "premium pricing 💸2x" warning.
10. Env vars for thresholds (`_env_float`); no theme config.

## usage-guard
https://github.com/vickingur/usage-guard (stars: 0)
Claude Code mod (plugin of function hooks) plus Python CLI `ug`; shows a prompt-footer widget, not a statusLine command.
1. State by role tokens. `hooks/register.tsx:454-461` state glyph + role: `success` (●, healthy), `warning` (○ disabled/◔ pacing), `error` (⊘ hold), `subtle` (· / ~ stale) with bold when holding; per-window percent coloured by `pctColor` (`:641-642`): >= threshold `error`, >= 0.66×threshold `warning`, else `success`; stale windows dim. Labels dim; pacing marker `warning`.
2. None; inherits Claude Code's theme role names.
3. Host-defined role names; depth/NO_COLOR are the host's. (`ug` CLI has `env.NO_COLOR` handling per extractor, not inspected.)
4. Foreground only.
5. Not verified; superscript window labels (`sup(w.label)`).
6. Dim labels vs coloured values.
7. Host roles adapt with Claude Code's theme.
8. Unicode glyphs ●○◔⊘·~; no emoji.
9. Codex hooks and pacing rather than styling.
10. Python CLI `ug` config; no colour customisation.

## ccsl
https://github.com/vimukthiD/ccsl (stars: 0)
1. Per widget by theme key, with threshold tiers. `src/themes/index.ts:4-30` ThemeColors keys: model, context(+High/Critical), tokens, cost, duration, lines, linesAdded, linesRemoved, directory, version, separator, usage(+High/Critical), resetTime, branch, worktree, rateLimit(+High/Critical), weeklyLimit(+High/Critical). Context tier at >=60 High, >=80 Critical (`src/widgets/index.ts:114-118`); usage at >=70 High, >=90 Critical (`:286-291`). Each value is a `ColorStyle {fg,bg,bold,dim,italic,underline}` (`src/utils/colors.ts`).
2. Six bundled themes (`themes` map, `:258-265`): neon, rainbow, ocean, minimal (default), monochrome, corporate. Format = per-segment colour map of hex styles (not semantic roles), optional per-theme `icons` override. Users can supply `customTheme` in config (`src/formatter.ts:8`: `config.customTheme || themes[config.theme]`).
3. Hex only via chalk with `chalk.level = 3` forced (truecolor even when piped, `colors.ts:3-6`). No detection or downsampling; NO_COLOR not seen.
4. Foreground only by default (bg supported by `ColorStyle`).
5. Configurable plain separator, default ` │ ` styled with theme `separator` (`defaults.ts`, `formatter.ts:22`).
6. Hue per widget; the `rainbow` theme assigns one colour per widget along the spectrum.
7. Not present.
8. `icons`: `auto|nerd|unicode|ascii` (`src/utils/icons.ts`) with three icon tables.
9. Rainbow theme; Ink TUI (`src/tui/app.tsx`) for configuring; padding option.
10. JSON config (`src/config/loader.ts`, defaults theme minimal, widgets model/context/tokens/cost, separator, icons, padding), TUI, CLI (`src/cli.ts`).

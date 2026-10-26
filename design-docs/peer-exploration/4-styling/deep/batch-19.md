# Batch 19: styling read from source

All projects are 1 star. File names are repo-relative; line numbers are from raw HEAD files fetched during this pass.

## claudemeter
https://github.com/arifbsmrstu/claudemeter (stars: 1)
1. By state/threshold on usage segments, fixed identity hue on the rest. `scripts/theme.mjs`: `meter()` colours each filled cell at its own position along the theme ramp (`cellColor` L369, calm to alarming, so colour of the leading edge is the reading); `valueColor` (L374) colours the `%` number on the same ramp, pushed up the ramp by `pct**0.85`; `paceColor` (L362) centres on ratio 1.0. Non-severity segments take an identity hue via `HUE_INDEX = { dir: 0, model: 2, cost: 2, branch: 3, lines: 4 }` into `theme.hues` (L493-499); anything else is `theme.text`. Labels/icons `theme.muted`; separator `theme.rule`.
2. Six bundled themes in `THEMES` (L147-214): aurora (default), neon, sunset, matrix, ice, mono ("no hues, brightness only"). Format is a per-theme record: `ramp[6]`, `text`, `muted`, `accent`, `hues[5]`, `pill`, `track`, `rule` (hex). `resolveTheme` falls back to aurora. User-defined themes: not present (only the six, chosen by `CLAUDEMETER_THEME`; `commands/themes.md` is a preview command).
3. Hex only internally. `detectDepth` (L13-30): forced via `CLAUDEMETER_COLOR_DEPTH` (0/4/8/24), `NO_COLOR` -> 0, `CLAUDEMETER_COLOR=off` -> 0, COLORTERM truecolor/24bit -> 24, TERM with 256 -> 8, `WT_SESSION`/`TERM_PROGRAM` -> 24, else 4. All downsampling is in `paint()`/`seq()` (L89-99): 24-bit, `rgbTo256` cube/grey (L56), or `rgbToBasic` nearest of 8 ANSI hues (bright-bold fg).
4. Both. Default (non-pill) styles are foreground-only; `pill` style (`CLAUDEMETER_STYLE=pill`) paints a background `theme.pill` behind content (`pill()` L405) and re-arms the bg after every inner reset.
5. Plain text: default separator ` │ ` (`defaultSeparator`, `statusline.mjs` L289), ` · ` for compact, ` and ` for words, a single space for pill. Pills have half-block caps `▐` `▌` tinted to the pill bg (`theme.mjs` L405-415), explicitly chosen over powerline arrows so no Nerd Font is needed. Separator colour is `theme.rule`.
6. Separators only (and capsule edges in pill style). Neighbours of the same kind are not hue-differentiated; non-severity segments get the 5-entry `hues` list by fixed index.
7. No light-terminal adaptation. Contrast handled by pill bg being dark plus `text`/`muted` greys. Pace tick is inverted against whatever it lands on (L292-296).
8. Icon sets via `CLAUDEMETER_ICONS` (`ICON_SETS` L431-479): `emoji` (default, unpainted), `shapes` (geometric Unicode, painted `theme.muted`), `ascii`, `none`. Seven bar styles (`BAR_STYLES` L231): smooth (1/8-block partials), blocks, shade, dots, line, bars, ascii.
9. Per-cell gradient along the ramp (`sampleRamp` L130, RGB interpolation); gradient sparkline of history (`sparkline` L387); pace tick `│` cut into the bar (L246-297); history sparkline sampled every 3 min (`statusline.mjs` L37-40).
10. Environment variables only: `CLAUDEMETER_THEME`, `_STYLE` (compact/words/chill/pill), `_BAR_STYLE`, `_BARS`, `_ICONS`, `_RESETS`, `_PACE`, `_BAR_WIDTH`, `_SEPARATOR`, `_SEGMENTS` (default `model,daily,weekly,dir,branch`), `_COLOR`, `_COLOR_DEPTH`, `_DRY` (`statusline.mjs` L42-102). A theme preview renders the real line once per theme.

## overclaude
https://github.com/arthur-bump-pm/overclaude (stars: 1)
1. By threshold on usage, bold for identity, no hue otherwise. `statusline/statusline-command.sh`: `render_bar` (L166-170) and `fmt_pct` (L270-274): green <50, yellow 50-79, red >=80 on the filled bar and the percentage; `login_warn` (L308-310) red (<1 day) or yellow (<3 days). Line 1 segments (model | dir | sessions | account) are all `BOLD` with no colour (L433-437); costs/reset hints are `DIM`.
2. Not present (three hard-coded constants GREEN/YELLOW/RED/BOLD/DIM, L137-142). No themes.
3. Plain ANSI 16 (`\033[31m/32m/33m`). No depth detection; no `NO_COLOR`.
4. Foreground-only.
5. Plain ` | ` between segments, lines joined with newlines (L433, L526-527).
6. Not present: separators only.
7. Not present.
8. Emoji in a few places (`👤` account, `↻`, `⚠`, `↳`); bar glyphs `█` / `░` (L178-179). No fallback mode.
9. Multi-line output: line 1 identity, line 2 usage bars, line 3 other accounts' limits (L526-531); "(Nm old)" dim staleness suffix.
10. Shell script with a few env hooks (`SWAP_*`, `SWAP_HIDE_SPEND`); bar width fixed `BAR_WIDTH=10` (L144). Installer scripts, no config file for style.

## claude-code-vibe-mods
https://github.com/asfbr/claude-code-vibe-mods (stars: 1)
1. By state/threshold plus fixed neutrals. `statusline/statusline.js`: `tone(p)` L25: red >=85, yellow >=60, green below; applied to the context bar and `%` and to the 5h/7d/spend windows (L89-91). Fixed: model name `BOLD` uncoloured (L145), branch glyph `⑂` and cost/token counts `MUTED` (L147,158,160), `+N` lines added GREEN and `-N` removed RED (L153), cache `●` GREEN when warm, `○` YELLOW when cold (L39-40). Directory plain.
2. Not present for the statusline (constants at L10-23). The repo also holds an `announcer` mod whose `themes/index.ts` "themes" are sound packs (UT voice lines), not colour themes: not styling.
3. Truecolor everywhere: `rgb(r,g,b)` -> `\x1b[38;2;...m` (L16). Palette: MUTED 138,138,138; TRACK 82,82,82; GREEN 112,200,128; YELLOW 224,184,72; RED 232,104,94. No depth detection, no `NO_COLOR`. Comment L13-15: SGR dim was abandoned because it rendered unreadably on Windows Terminal; MUTED is a real grey.
4. Foreground-only.
5. Plain text `SEP` = muted ` · ` (L23). `justify()` (L124-128) right-aligns a group when width allows.
6. Not present: separators only.
7. Only the "no dim attribute" decision; no adaptation. Width from `COLUMNS` minus `STATUSLINE_RESERVE` (L117-121).
8. Bar `▓`/`░` (L29); glyphs `⑂ ● ○ ↻`. No font modes.
9. Prompt-cache warm/cold countdown, 5h/7d/spend/"fable" windows with reset times; wraps to two rows ("prefer wrapping over losing information").
10. Options in `render()` (`opts.bar/count/cache/lines`), env `STATUSLINE_RESERVE`, `STATUSLINE_DEBUG`. Install by asking Claude.

## claude-code-statusline (ashwinksv)
https://github.com/ashwinksv/claude-code-statusline (stars: 1)
1. By threshold plus fixed. `statusline.py`: `context_bar` L57-67 (>=85 RED, >=60 YELLOW, else GREEN, bar `▓`/`░`); 7-day tokens by magnitude (L333-337: <5M green, <15M yellow, else red); context-collapse ETA `RED` <5 min, `YELLOW` <15, else `DIM` (L378); compaction warnings bold red (L80-82). Fixed: model `cyan(bold())` (L444), lines `+N` green and `-N` red (~L463), burn rate and token breakdown `dim`.
2. Not present (ANSI constants L36-45).
3. ANSI bright-16 only (`\033[91m..97m`: RED 91, YELLOW 93, GREEN 92, CYAN 96, MAGENTA 95, BLUE 94, WHITE 97, plus DIM/BOLD). No detection, no `NO_COLOR`.
4. Foreground-only.
5. Plain-text join (no separator colours observed beyond `dim`).
6. Not present.
7. Not present.
8. Heavy emoji (💀 ⚠ ☢️ 📅 🔥 ⏱ 🤖, `cost_emoji`); no fallback.
9. Two-line layout with weather, "wisdom counter", context vibe text and a "context collapses in" countdown; example scripts in bash/node/powershell/python under `examples/`.
10. Single Python script; no config file seen.

## claude-statusline-extra
https://github.com/atermenji/claude-statusline-extra (stars: 1)
1. Chosen per segment by config, with threshold defaults on usage segments only. `statusline.sh`: `usage_color` L106-111 (>=80 high, >=50 medium, else low) used by `5h`/`7d` segments when no `color` is set (L220, L240); every other segment (`model`, `cost`, `time`, `context`, `tokens`) is uncoloured unless its entry in `~/.claude/statusline.json` sets `color` (L299-309).
2. Not present as themes. User sets `colors.{high,medium,low}` globally (L272-274) and `segments[].color/bold/emoji/label/reset` per segment (L284).
3. `stylize()` L150-170 accepts names (red green yellow blue magenta cyan white), `#RRGGBB` (to `38;2`) or a 0-255 index (`38;5`). No detection, no downsampling, no `NO_COLOR`.
4. Foreground-only.
5. Plain-text separator joined from config (not colour-controlled).
6. Not present (only per-segment colours the user assigns).
7. Not present.
8. Per-segment `emoji` boolean; ASCII `[MODEL]` style brackets.
9. Config-driven ordering (`DEFAULT_SEG_LIST="model cost time context 5h 7d tokens"`, `statusline.sh` L265).
10. JSON config `~/.claude/statusline.json` read with `jq`; installer scripts.

## claude-code-statusline (av-rx)
https://github.com/av-rx/claude-code-statusline (stars: 1)
1. By role, fixed, with threshold swaps. `src/statusline-command.sh` L20-33: model 183 lavender (`C_MODEL`), effort 139 mauve, location/dir 110 sky blue, session name 252 near-white, muted 242, separators 244. Context bar fill: 248 grey <60, 221 golden yellow 60-84, 210 coral >=85 (L61-63); percent text: 73 teal low, 221 warn, 210 crit (L76-78). Rate-limit values use `C_WARN`/`C_CRIT`.
2. Not present (constants only). One fixed muted pastel palette.
3. 256-colour indexes (`\033[38;5;Nm`). No detection, no `NO_COLOR` seen.
4. Foreground-only.
5. `SEP=" \033[38;5;244m│\033[0m "` (L33): plain bar, one grey.
6. Separators only.
7. Not present; the greys are chosen for dark terminals.
8. Bar glyphs plus a few emoji; no fallback.
9. Gradient-tagged signal counts exist but the bar uses three discrete colours, not a gradient; there are PowerShell twins (`.ps1`) and `sync-installers` tooling so bash and PowerShell stay identical.
10. None beyond editing the script; installer for sh and ps1.

## claude-statusbar (netsignal + usagebar)
https://github.com/avazibra/claude-statusbar (stars: 1)
Claude Code mods (plugin hooks) that draw pills above the prompt as SVG; not an ANSI statusline, but styling is real.
1. Fixed tone per metric, with level overrides. `hooks/pills.ts` L9-21 `Tone { bg, ink, fill, glow }` per metric: fiveHour (bg #d9eae2, ink #3f7d68), sevenDay (#e5def3, #7a5fc0), input (#f1ddd6, #c0583f), output (#d9eadb, #4f8a55), context (#dde2f6, #4f5fc9), cost (#f1e6cc, #a8812a), plus good/ok/bad/unknown. A bar's fill is the tone's `fill` unless `level` is warn (`#d6a33a`) or alert (`#cf5f45`) (L135). netsignal: good <300 ms, OK <700, poor <1500, bad above (README).
2. Four paint styles over the same tones: `soft` (pastel bg, dark text), `outline` (white bg, tone ring), `solid` (tone ink as bg, white text), `dark` (#33322f bg, glow-coloured icon) (L23-42, `STYLES`). No user-defined palette.
3. Hex/rgba in SVG; ANSI statusline fallback not read (`usagebar` also writes a text status line; unverified).
4. Background-filled pills (rounded rect `rx=(H-1)/2`).
5. Pills separated by gaps; inside a pill a 1px `rule` divider (L148).
6. Different tone per metric (hue families: green, violet, orange-red, green, blue, gold).
7. Not adaptive; four styles include one dark and three light variants chosen by the user.
8. Hand-drawn SVG stroke icons (`ICONS`, L64-). ASCII fallback in the text status line: unverified.
9. Pace tick on bars (L143-148); responsive `fit()` scales/drops pills (L180-196); a `◐` switch cycles styles.
10. Style switch in the UI (`styleFrom`), mod settings; no theme file.

## angeclaudebar
https://github.com/azhang4216/angeclaudebar (stars: 1)
1. Fixed per segment, thresholds on gauges. `statusline.sh` L7-14 (Catppuccin Macchiato truecolor): project path `C_RED` #ed8796, branch `C_GREEN` #a6da95, diff stats `C_AMBER` #eed49f, model `C_PURPLE` #c6a0f6, cost `C_AMBER`, labels `C_MUTED` #6e738d, separators/empty gauge `C_OVERLAY` #363a4f (L501-506). Gauge fill is a background colour: context/weekly teal <40, amber <70, red above; "budget" mode green <50 / amber <80 / red (L441-448), empty cell bg #363a4f.
2. One hard-coded theme (Catppuccin Macchiato). No switching.
3. Truecolor `38;2`/`48;2`. No depth detection or `NO_COLOR`.
4. Both: text is foreground-only, gauges are background-filled cells (`bgauge` L431-455).
5. Plain `|` in overlay grey (L392).
6. Different hues per segment (red path, green branch, purple model).
7. Width tiers (XWIDE/WIDE/MID/NARROW/TINY) drop segments; no colour adaptation.
8. No glyph modes; `bgauge` uses space cells with bg colour.
9. Two-line status line (project/branch/model/context, then gauges); bypass-mode badge uses `C_PEACH`.
10. Script only; `demo.sh` for previews.

## ClaudeCode_status_bar
https://github.com/B143KC47/ClaudeCode_status_bar (stars: 1)
1. Fixed identity plus thresholds. `bin/statusline.js` L350-422: model bold bright-cyan; output tokens bright green / yellow >20k / orange >50k / bright red >100k; cost green / yellow >$1 / orange bold >$5 / bright red bold >$10; branch bright green on `main`/`master`, bright magenta otherwise; folder bold bright blue with 📁. The Next.js `app/components/StatusBar.tsx` dashboard uses Tailwind (`bg-red-500` >80, yellow >60, green).
2. Not present.
3. ANSI 16 incl. bright (91-97) plus bg 40-46; dim/italic/underline/blink/reverse attributes defined (L366-371). No detection, no `NO_COLOR`.
4. Foreground-only in the statusline (bg codes defined, unused in the lines read).
5. `' │ '` with `dim`.
6. Different hues per segment.
7. Not present.
8. Emoji (📁 etc.), `⎇` branch glyph.
9. Web dashboard (Next.js) with pulse animation; burn-rate widgets.
10. `install.sh`/`web-install.sh`; no config.

## claude-code-cockpit
https://github.com/baeseokjae/claude-code-cockpit (stars: 1)
1. Semantic palette roles per theme; per segment via role. `src/themes/neon.ts`: model `palette.blue` (bold), session name and duration and separators `palette.muted`, branch `palette.mauve`, token speed `palette.green`, cost `palette.peach`, CRITICAL `red` / WARNING `yellow`, box borders `blue`. Threshold colour via `getPercentColor` (`helpers/data-extraction.ts` L32-41): >=90 `progressCritical`, >=75 `progressHigh`, >=50 `progressMid`, else `progressLow`; also `getUsageColor` for 5H usage. Tool/agent/todo categories use `categoryTools/Agents/Todos`.
2. Five bundled themes (`src/themes/index.ts`): aurora (default fallback), neon, mono, zen, retro. A `ColorPalette` is semantic (`src/types/theme.ts`): base/surface/overlay, text/subtext/muted, blue/green/yellow/red/mauve/teal/peach, `progressLow/Mid/High/Critical`, `categoryTools/Agents/Todos`. Each theme also carries `chars` (progress glyphs, box corners, separator), `icons`, `layout` breakpoints, `features` (gradient progress, box borders, animated spinner, blink on critical). Mono palette sets nearly every role to #fff/#ccc. User-defined themes: not present; theme chosen by config or `COCKPIT_THEME` (`src/config/loader.ts` L83).
3. Truecolor hex (`hex()` -> `38;2`, `src/render/colors.ts`) plus basic 16 helpers. No depth detection or `NO_COLOR` in files read.
4. Foreground-only (box-drawing borders in "full" tier).
5. Theme-supplied separator char (`' │ '` neon, coloured `muted`) and box-drawing in full tier.
6. Hue differences by role; separators.
7. Mono theme for colourless; no light/dark adaptation.
8. `getIcons()` (`themes/icons.ts` L82): `hasNerdFont()` picks `NERD_ICONS` (Powerline `` branch) else `FALLBACK_ICONS`.
9. Three width tiers (minimal <80, compact 80-120, full >=120), stable height padding, animated spinner and blink on critical in some themes, SVG theme screenshots in `assets/`.
10. `~/.claude/plugins/claude-code-cockpit/config.json` (`loader.ts` L26), `COCKPIT_THEME`, `COCKPIT_PRESET`; many `display.*` toggles, `detailMode`, `pathLevels`, `rightMargin`, `maxWidthRatio`.

## claude-code-statusline-editor (yacc)
https://github.com/barvhaim/claude-code-statusline-editor (stars: 1)
1. User-assigned per segment, with a threshold option on bars. `segments/base.py`: `ANSI_FG` is ANSI 4-bit names (L19-29); each segment has a `color` OptionSpec with defaults: cost green (`cost.py` L17), duration blue, directory cyan, custom_text default (none). `context_bar` and `context_pct` use `threshold` `{warn: 70, crit: 90, low: green, mid: yellow, high: red}` via `threshold_color` (L96-104).
2. No themes. The "theme" is the per-segment choice stored in `statusline.config.json` (`config.py` L16).
3. ANSI 8 named colours only (`colorize`, `bash_color`); no detection, no `NO_COLOR`. The generator emits a Bash script using `printf "\033[..m"`.
4. Foreground-only.
5. One global `separator` string in the composition (default " ").
6. Not present beyond user choice.
7. Not present.
8. Emoji icons with `icon`/`icon_char` options (e.g. 💰, 📁); toggle on or off per segment.
9. A Textual TUI editor with live preview against FULL/MINIMAL/NULLED fixtures, outputs a Bash+jq script and merges a `statusLine` block into settings.json; OSC 8 hyperlink helper.
10. Textual TUI (`statusline-editor`), JSON config, generated Bash.

## lmux (LYNA TMUX)
https://github.com/bayoudhdev/lmux (stars: 1)
1. Theme role per segment. `internal/statusline/statusline.go` L226-: model `Accent` bold; effort `Muted`; sandbox: strict `Success`, standard `Muted`, off `Danger` bold; context and limits `Muted` label + `level(pct)` value (`Success` <50, `Warning` <80, `Danger`; L67-75 with `warnPercent=50`, `dangerPercent=80`); cost `Text`; directory `Text`; branch `Accent2`; separator `Muted`. Agent states (tmux bar) Busy/Waiting/Idle are three distinct colours in every palette.
2. 14 themes (README): ten dark, three light, one `ansi` using the terminal's palette. `internal/domain/theme/palette.go`: monokai (default), lyna, light, slate, dusk, contrast, solar-dark, solar-light, earth-dark, earth-light, nord, rose, mono, ansi. A `Palette` is semantic: Bg, Surface, Overlay, Border, Muted, Text, Accent, Accent2, Busy, Waiting, Idle, Danger, Success, Warning, plus `Dark`. Tests hold text to 4.5:1 and muted to 3:1 against Bg, and text/bg separate after reduction to 256/16 (palette.go L28-32). The repo also writes each palette as a Claude Code custom-theme JSON (`internal/claudetheme`, `plugins/lyna-tmux/themes/*.json`, `base` + sparse `overrides` of tokens like `claude`, `warning`, `rate_limit_fill`). User-defined: via config file, details unverified.
3. `Color` is RGB or ANSI index (`color.go`); `Depth` = 16/256/truecolor (`ParseDepth`, `DetectDepth` from `COLORTERM`/`TERM`, L89-95); palette colours quantise down; indexed colours keep their index at every depth. `NO_COLOR` honoured (`envNoColor`, statusline.go L33; `color: getenv(envNoColor) == ""`).
4. Statusline command: foreground-only (SGR fg via `paint`). tmux status bar: background segments, powerline-pointed with a Nerd Font, otherwise ending where bg ends (README L294).
5. Statusline: `Muted`-coloured `icons.Sep` (` │ ` unicode, `` nerd, `|` ascii). Status bar: `ui.status_style = powerline | plain`.
6. Hue by role; also `Palette.Lanes()` (`lanes.go`): eight git-graph lane colours derived by rotating the accent hue in 45-degree steps, saturation floor 0.45, lightness 0.42-0.72, lifted until WCAG 3:1 against Bg (`readable`); grey accents yield eight lightness steps; indexed palettes take eight basic hues.
7. Strong: WCAG contrast (`Contrast`, `contrast.go`) enforced on palettes and lanes; separate light themes; `ansi` theme follows the terminal.
8. Icon sets `unicode`/`nerd`/`ascii` (`icons.go` L33-48); auto-fall back to ASCII outside UTF-8.
9. Theme preview command (`lmux theme preview`) per depth, demo videos/gifs; workspace-wide restyle (borders, menus, review editor) from one palette; priority-based segment dropping by width (`prio*` consts).
10. Documented config file via `lmux config init/edit/validate` (format unverified), `lmux setup` wizard, `lmux theme <name>`; the managed launch exports theme/icons/colour-depth to the statusline through `session.EnvTheme`, `EnvIcons`, `EnvColor` (statusline.go L28-31, L145).

## claude-crt-hud-mod
https://github.com/BedirYilmaz/claude-crt-hud-mod (stars: 1)
A Claude Code mod drawing a CRT-style HUD panel above or below the prompt (not a one-line ANSI statusline).
1. Tone per meaning, fixed per line. `mods/hud/hooks/panel.ts` L8, L57-77: `Tone = label | value | dim | model | project | clean | dirty | ok | warn | crit | cache | cost | busy`, mapped by `PALETTE` to hex: label #4ea26a, dim #2f6a45, value #d6ffe1, model #ffa94d, project #6cc7ff, clean #7dff9a, dirty #ffd166, ok #5cff8a, warn #ffc145, crit #ff5c5c, cache #4fe3d0, cost #c79bff, busy #9fb3ff. Gauge `Level` ok/warn/crit selects the tone; lines carry `rank` and drop lowest first; a warning line gets `WARN_BONUS=20`.
2. One hard-coded "phosphor" palette; comment: "One place to recolor". Background #070b08, bezel #18241c, track #16301f.
3. Hex (SVG/Ink); no ANSI depth logic.
4. Background-filled "glass" panel with scanlines (`scan`, `bezel`, `edge`).
5. Label left, value flush right; no separators between lines.
6. Distinct tone per field type.
7. Not adaptive (dark-glass only).
8. Gauges and `▾ MIN` toggle; no Nerd Font mode.
9. CRT effect (`crt.ts`): scanline/glow; clickable compact button; alerts (`alerts.ts`).
10. Plugin install via marketplace; no user theme file seen.

## cc-vox (statusline plugin)
https://github.com/BestSithInEU/cc-vox (stars: 1)
1. Fixed per segment, plus state accent and gradients. `plugins/statusline/statusline_pkg/renderer.py`: model by family (`_model_color` L13-21: opus MAUVE, sonnet BLUE, haiku TEAL, else TEXT); cwd BLUE, branch MAUVE, clean dot GREEN / dirty dot PEACH, session cost YELLOW bold, labels `OVERLAY0`, clock `OVERLAY0`; a leading `▐` accent bar in every line coloured by context pressure (`_accent` L24-31: `accent_healthy` <50, `accent_warm` <80, `accent_hot`). Cost figures via `cost_color` (`theme.py` L202-209: >=50 PEACH, >=20 YELLOW, >=5 SAPPHIRE, else TEAL). Bars (`bars.py`): per-bar-kind three-band gradients (context 50/80, 5-hour window 60/85, weekly 50/80) from `bar_*_{healthy,warm,hot}_{start,end}` interpolated per cell.
2. Two palettes in `theme.py` `PALETTES`: `catppuccin` (Mocha values) and `synthwave` (default). Format: Catppuccin-style semantic names (rosewater..lavender, text, subtext1/0, overlay2..0, surface2..0, base) plus `bar_track`, 18 `bar_*` gradient endpoints and 3 `accent_*` entries. User picks via `~/.claude/statusline_theme.json` `{"theme": ...}` (L119-128); defining a new palette needs editing the Python.
3. Truecolor only (`38;2`/`48;2`). No detection, no `NO_COLOR`.
4. Foreground-only text; bars draw `█` partials with a darker `bar_track` colour.
5. `DOT` ` · ` and `PIPE` ` │ ` in `SURFACE2` (L195-196).
6. Fixed hue per segment; four stacked lines each start with the accent bar.
7. Not present.
8. Sub-character precision blocks (`▏▎▍▌▋▊▉█`); few emoji.
9. Gradient bars with sub-cell precision (`make_bar`, bars.py L9-31); multi-line (identity, costs day/7d/30d/repo, context, windows, MCP, voice).
10. `statusline_theme.json`; plugin with auto-setup hook; env/config in `config.py` (bar width `BAR_W`).

## Slime
https://github.com/bitqs/Slime (stars: 1)
Gamified Claude Code plugin; its statusline (`scripts/statusline.js` + `core/hud.js`) is plain emoji text.
1. No colour: `core/hud.js` and `core/report.js` contain no ANSI escapes; meaning is carried by emoji (🗡️ ❤️ 🟢 ⚡ 🔥 🐺 💥, `👾`) and a 10-cell `█`/`░` bar (`report.js` L43-46). Colour appears only in the browser arena.
2. Not present for the statusline. The arena has a day/night theme toggle (`docs/superpowers/specs/2026-06-09-day-night-live-theme-design.md`: PixiJS scene, `body.day`), unrelated to terminal colour.
3. Not present (no ANSI).
4. Foreground-only (terminal's own).
5. Plain text, a `[HUD]` OSC-8 link to the arena (`hud.js` `uiLink`).
6. Not present.
7. Not present.
8. Emoji-based throughout; sanitiser strips control and invisible characters (`hud.js` L22-50).
9. Composite mode: wraps the user's original statusline command and prints it above or below Slime's row (`scripts/statusline.js` L50-77, `core/statusline-chain.js`).
10. `config.json` (`statusline.mode = combine`, `chain`, `position`), `autoArena`.

## byj-cc-statusline
https://github.com/BitYoungjae/byj-cc-statusline (stars: 1)
A Claude Code mod (band above the prompt), not a script; the most directly relevant design here: segments name Claude Code theme keys, not colours.
1. Theme keys by role/state, per segment. `hooks/lib/style.ts` `Part.color/bg` are "a theme key (`warning`, `inactive`...)". `paletteOf` (L131-157): terminal palette `accent: claude`, `ultra: effortUltra`, `fill: rate_limit_fill`, `track: rate_limit_empty`, `badge: userMessageBackground`, `hover: userMessageBackgroundHover`, `border: promptBorder`; other surfaces get `COMMON` keys (`merged`, `suggestion`, `subtle`). Segments (`hooks/lib/segments.ts`): model = accent text on `badge` bg, bold (L80); lit effort bars accent, or `ultra` at max (L97-103); session name `merged` (L160); branch status: `success` (clean/staged), `warning` modified, `error` conflicted, rest `inactive`/quiet (L164-174); gauges `fillColor(level)` -> calm `fill`, else `warning`/`error`; the low-fuel percent is `inverseText` on `error` bg (L196); labels `quiet` = `inactive`; separators/rules `faint` = `subtle`. Fuel thresholds: yellow <70%, red <30% (README).
2. No bundled themes; it follows whichever Claude Code theme the user has (including custom themes). Two "looks" via `icons: symbols | emoji`: symbols = calm (colour only on warnings), emoji = "the original" with traffic lights (`levelColor`/`fillColor` L190-205 use `success` when `!isModern`).
3. Theme keys resolved by Claude Code; no depth logic or `NO_COLOR` in its code (the host does it).
4. Both: model badge and alarm percent use `bg`; gauges draw fill/track as colour and background (`gauge.ts`); other text foreground-only.
5. Gaps: symbols look `'   '` (3 spaces) in the `subtle` colour, emoji look `' | '` (L96-129).
6. By type of key and bg only: the model badge is a bg block; everything else is separated by spacing. No alternating shades.
7. Adapts through the host's theme (the gauges "use the same colours /usage draws"); `inverseText` for text on alarm bg; a `COMMON` fallback key set on non-terminal surfaces.
8. `symbols` look: box-drawing, block elements and Latin-1 only so no glyph falls back to another font's width; `emoji` look alternative.
9. Hover cards with details (borders `promptBorder`), live clocks and spinner ticking on the terminal's frame clock, pace tick on the 5h/7d gauges that turns `warning` when on pace to run out, copy-on-click, `/compact` button, toasts.
10. Options in Claude Code `/config`: `layout` (auto/two-line), `icons`, `details`, `activity`, `cache`, `showCost`, `alerts` (README Options table).

## claude-usage-monitor
https://github.com/Bortlesboat/claude-usage-monitor (stars: 1)
not a Claude statusline: a cross-platform system-tray app (colour-coded tray icon plus a dashboard window with gauges) that reads Anthropic's rate-limit API; the only terminal part is a `--cli` print mode (`cli.py`, no ANSI found, no `statusLine` integration).

## ccline
https://github.com/br9704/ccline (stars: 1)
1. Semantic colour names per segment, mapped by theme. `src/theme.ts` defines nine names (red yellow green cyan blue magenta gray white dim). Segments: context = "ctx N% left" red <=15, yellow <=40, else green (`segments/context.ts` L27-34, configurable `warnBelow`/`dangerBelow`); model white (`model.ts` L25); branch magenta (`branch.ts` L34); tokens cyan (`tokens.ts` L36); update cyan (`update.ts` L71); duration gray; cost gray, yellow above `noticeAbove` (default 5); rate limit gray, yellow when low (`limit.ts` L40); pet segment has `PET_COLORS[state]`.
2. Five bundled themes (`THEMES`, `theme.ts` L110-157): `default` (16-colour, SGR 31..37/90/dim), `bright` (91-97), `ocean` (256-colour, red 203 kept warm "a red that reads as blue is a red nobody looks at"), `sunset` (256), `plain` (null palette). Format: nine semantic names -> escape; unknown theme falls back to default. Users cannot define themes beyond these five; config `theme` plus a TUI picker (`ccline config`). (Not to be confused with its `styles/` = Claude Code output-style markdown files.)
3. 16-colour and 256-index (`38;5;N`); no truecolor, no detection. `NO_COLOR` honoured when non-empty, plus `"color": false` and theme `plain` (`render.ts` `colorEnabled` L62-67). Colour is not gated on isTTY because Claude captures stdout.
4. Foreground-only.
5. Plain separator string `" · "`, configurable and control-stripped (`render.ts` L183-188).
6. Separators only.
7. Not present; `dim` attribute for secondary; "bright" theme "for a dark background".
8. Minimal ASCII/Unicode text; no emoji mode needed.
9. Interactive TUI picker with live preview; pet animation segment (`src/pets/`); `guard` PreToolUse hook is unrelated to styling.
10. JSON config at `~/.ccline/config.json` and nearest `.ccline.json` (3 layers); `ccline config` TUI; segments array sets order.

## statusline (Bravim-Ketan-Purohit)
https://github.com/Bravim-Ketan-Purohit/statusline (stars: 1)
1. Per-tile user style, `pens` mapping tile-type to bg/fg in presets, plus rules. `packages/web/src/lib/themes.ts`: `Preset.pens` maps `clock`, `model`, `cwd`, `git-branch`, `context-bar`, `five-hour-bar`, `pr`, `ci` to `{bg, fg}` hex; e.g. Drafting: clock #005f87, model #5f00af, cwd #005faf, git-branch #005f00, context-bar #00005f, five-hour-bar #5f0000. `applyPreset` writes these into each tile's `style` (L77-91). 26 "signals" (CI failing, memory spike) can bind a colour, border, blink or hide rule to a tile (README). `dangerColor` (default #ff5f5f) overrides all colour for a "danger" span (`adapters/ansi.ts` L163-167).
2. Five presets: Drafting, Blueprint, Silkscreen, Plain ink (no fills), 16 colour. Each: `terminalBg`, `colorMode`, `palette` (accent, muted), `pens`. `palette:name` refs resolve through `cfg.theme.palette` (`resolveColor` L58). Users build own themes in the web builder / by editing the config.
3. Three `colorMode`s: truecolor, ansi256 (`rgbTo256` cube/grey), ansi16 (nearest of 16 by distance) in `sgr()` (ansi.ts L63-70). `NO_COLOR` not found in files read.
4. Both: bg-filled tiles with fg, edges, or `plain` style with no fills.
5. Three styles (`render.ts` `STYLE_OPTS`): `pills` (pad 1, gap 1), `powerline` (gap 0), `plain` (gap 3). Per-tile edge shapes `none | thin | block | bracket | round | angle | powerline` (`schema.ts` L55), coloured by `border.color` or the tile's bg.
6. By per-tile bg colours; fills; rules.
7. Each preset names the terminal ground it expects; no automatic fg picking found for tile bg (pens give fg explicitly).
8. Glyph prefixes (`⎇`, `▸`, `✦`, `◷`) with compact mode that drops labels at 64 cols; tile priority drop.
9. 15 animated/static fill modes (linear radial conic ... rainbow strobe), quantised to the 216 cube; image import; blink derived from the clock; bell; web drawing-sheet builder using the same core for preview; tmux target too.
10. JSON config with zod schema, web builder (statusline.xyz), CLI (`render`, `tmux`, `doctor`, `import/export`, `creds`), daemon for metrics.

## claude-statusline-market
https://github.com/Brit-juho/claude-statusline-market (stars: 1)
A gallery of preset JSON for other tools (mainly ccstatusline); it renders nothing itself except a preview script.
1. Per widget background chosen by the preset author. In the "theme" presets, each widget gets a hex `color` that becomes its powerline background, stepping by position: Ember `#2b1210 -> #3d1a14 -> #4f2318 -> #612c1c` (then back to `#2b1210` for cost); Violet Dusk `#1c1030 -> #25153e -> #2e1a4c -> #37205a`; Deep Current `#0c1a26 -> #102431 -> #142e3d -> #18384a` (`public/presets/theme-*.json`). The non-theme preset `powerline-flow` uses named colours (cyan, white, blue, green, dim, yellow).
2. Five theme-named presets seen (ember, violet-dusk, deep-current, nord, tokyo-night) as ccstatusline settings. Format is the target tool's (`ccstatusline_settings` v3: per-widget `color`, `bold`, `powerline.separators`). The first two are described as "tone-on-tone dark palette" (README text in the JSON).
3. Hex or named, as ccstatusline accepts. `scripts/render-preview.mjs` emits truecolor (`38;2`/`48;2`) with named map (accent #00d97e, cyan, blue, ...). No `NO_COLOR` in the preview.
4. Both: powerline mode uses bg blocks with auto-picked fg.
5. ccstatusline powerline separators chosen per preset: `⟩`, `›`, `»`; preview joins with the separator char (`renderLines` L168-174). Real arrow colours are ccstatusline's.
6. Lightness steps: ember/dusk/current presets deliberately step lightness by about +8 to +12 per segment along the line (a single hue family), with the last widget returning to the first colour.
7. Preview contrast: `contrastFg` picks `#0a0a0a` or `#f2f2f2` from luma `0.299r+0.587g+0.114b` > 0.6 (render-preview.mjs L151-157).
8. Emoji tag widget (🔥, 🌙, 🌊) leading each theme line.
9. Multi-language marketplace (ko/en), CI screenshots of presets, `curl | sh` installer with SHA256 and backup; Claude Code skill to apply presets.
10. Presets are JSON; install scripts write into ccstatusline's settings.

## claude-code-mods (token-ledger, next-steps, auto-docs)
https://github.com/bully911210/claude-code-mods (stars: 1)
Claude Code mods; the styling-relevant part is token-ledger's telemetry row above the prompt (not a one-line ANSI statusline).
1. Theme key per metric (fixed). `token-ledger/hooks/telemetry.tsx` `buildGroups` (L72-99): 5h limit icon `warning` + value `warning`, rate icon `warning`, reset time icon `subtle`, time-left icon `subtle`, week icon `suggestion`, context icon `merged`, cache hit icon `success`; model bold uncoloured; labels `inactive`, dividers `subtle` dim (L138-156); also a hex pair for the desktop's SVG (`iconHex`: ORANGE, MUTED, BLUE, PURPLE, GREEN). No thresholds in the row (value colours fixed); subagent lines `#378ADD` while running, `dimColor` when done (`views.tsx` L70).
2. No bundled themes; keys follow the user's Claude Code theme.
3. Theme keys (host resolves); hex only for the SVG variant. `NO_COLOR` not applicable.
4. Foreground-only text.
5. Dividers `SEP_WIDE=5` / `SEP_TIGHT=3` cells with a `subtle` glyph.
6. Different icon colour per metric.
7. Follows host theme; `text` default for values.
8. Icon set (database, zap, clock, hourglass, chart) drawn as SVG on desktop or terminal glyph (`IconKey`); comment: "desktop shows plugin SVG blank, so none is used" for the row.
9. `?` button asks Haiku for questions; priorities drop groups when narrow (`fitGroups`).
10. Plugin config; commands `/ask`, `/ledger`.

## claude-statusline (bxzfxl)
https://github.com/bxzfxl/claude-statusline (stars: 1)
1. By threshold plus fixed. `statusline.sh`: context bar GREEN <60, YELLOW 60-84, RED >=85 (L73-79); rate limits via `rate_indicator`: GREEN <40, YELLOW 40-69, RED 70-89, `BG_RED`+WHITE+BOLD >=90 (L31-38 of the sed slice); model bold magenta; tokens `↑in ↓out` CYAN; cost GREEN; duration BLUE `⏱`; `+N` GREEN `-N` RED; separators/labels DIM.
2. Not present.
3. ANSI 8 plus dim/bold and one bg (`BG_RED`). No detection, no `NO_COLOR`.
4. Mostly foreground; critical rate limit is a red-background chip.
5. `│` in DIM.
6. Different hue per segment (magenta, cyan, green, blue).
7. Not present.
8. A few emoji/glyphs (`⏱`, `↑↓`, `↻`); bar glyphs.
9. Two-line output.
10. Shell script with install/uninstall scripts; no config.

## claude-pixelbar
https://github.com/caiquecontarini/claude-pixelbar (stars: 1)
1. Theme slots, fixed per segment, with context-zone colours. `statusline.js` theme object (L14-28, L93-220): `model` (bold), `safe`/`dead`/`dang` (context bar by zone: 0-20% safe, 20-40% "dead zone", 40%+ danger, with labels), `cost`, `time`, `tok`, `sep` (char + colour), plus bar glyph pair `bFull`/`bEmpty`, spinner `frames`, `deadLabel`/`dangLabel`, optional pixel `sprite`. e.g. cyberpunk: model magenta bold, safe cyan, dead yellow, dang red, cost yellow, time white, tok bright-black, sep magenta `│`.
2. Ten bundled themes (README tables): cyberpunk, matrix, neon, minimal, retro, plus Pokemon/special meres, lugia, groudon, rayquaza, charizard; format is the slot object above (built-ins use ANSI codes, custom ones 256 indexes). Custom themes in `~/.claude/statusline-themes.json` (hand-written, or generated by `generate-theme.js` from a text prompt via Claude Haiku; `{ "accent": "#ff6600", "model": 214, "safe": 46, ... }`).
3. Built-ins: SGR 16 (`\x1b[35m`, bright 9x). Custom: 256 index (`38;5;N`). No truecolor path in the statusline, no `NO_COLOR` found.
4. Foreground-only text; sprites use half-block chars with fg and bg 256 colours (`spriteChar`).
5. Per-theme `sepChar` and `sepColor` (default `│`).
6. Fixed slot colours; separators.
7. Not present for the terminal; VS Code colours are synced to the theme (writes `settings.json`: title bar, activity bar, 50+ tokens).
8. Per-theme glyph sets for bar (`█░`, `▓░`, `◆◇`) and spinners; 5x4 pixel-art sprites rendered as 5x2 chars via `▀▄█`; emoji labels.
9. Local web **Theme Studio** at `localhost:7337` (`theme-studio.js`, `statusline-server.js`) to browse, switch and AI-generate themes; Ctrl+click on `🎨` in the bar switches themes; animation frames per theme.
10. `~/.claude/statusline-config.json` (`{ "theme": "neon" }`), `statusline-themes.json`, Theme Studio, `generate-theme.js "<description>"`; Windows and POSIX installers.

## cc-menubar
https://github.com/calvindotsg/cc-menubar (stars: 1)
not a Claude statusline: a macOS menu-bar (SwiftBar) quota-pacing plugin; it has a role-based light/dark colour theme (`render.py` `Theme.color(role)` returns a "light,dark" pair, Ayu/Catppuccin named) but draws in the menu bar, not in Claude Code.

## rust-statusline
https://github.com/camjac251/rust-statusline (stars: 1)
1. Identity colours for models, one shared attention scale for limits, everything else neutral. README "Model pricing and colors" and `src/tokens.rs` L139-168: model identity: Fable rose #FF8CBE, Opus lavender #C8A0FF, Sonnet amber #FFC864, Haiku cyan #64DCFF, GPT-5.6 Sol/Terra/Luna coral/green/periwinkle. Attention tiers (README): calm <75% plain white, elevated 75-89% amber, critical >=90% bold red, applied only to quantities with a cap (5h, weekly, scoped weekly rows, extra-usage credit, context %); 5h also rises to elevated when its linear pace will hit the cap before reset. Effort chip tier colours (none grey, low cyan, medium white, high amber, xhigh pink, max bold pink). Costs, counts, countdowns are deliberately neutral ("colour means one thing"). Workspace path/worktree/+N in `ACCENT` #60A5FA; separators `MUTED` (#999999) `│` (compact `·`) (`display.rs` L19-20, L122-125). Semantic base tones copy Claude Code's dark theme: SUCCESS #4EBA65, WARNING #FFC107, ERROR #FF6B80, MUTED #999999.
2. No selectable themes; one palette of `ColorToken`s `{truecolor rgb, ansi fallback}`. Not user-definable.
3. Every token has truecolor RGB and a 16-colour ANSI fallback (`ColorToken::new((r,g,b), Ansi::X)` in tokens.rs). `is_truecolor_enabled` (`display.rs` L368-385): `NO_COLOR` disables all; `--truecolor`/`CLAUDE_TRUECOLOR=1` forces; `COLORTERM` truecolor/24bit; `TERM` xterm-truecolor/xterm-256color. Same signals for the footer and the agent panel.
4. Foreground-only (Claude Code paints uncoloured runs in its own gray, so tokens are chosen to sit level with it, per README).
5. Muted `│` between segments; `·` in compact width.
6. Separators and identity-versus-attention colour classes; neighbours otherwise plain.
7. Palette tuned to Claude Code's dark theme; no light-mode logic found.
8. Mostly text labels (`labels` long/short), a few symbols; OSC 8 `file://` hyperlinks on workspace/worktree (`--no-hyperlinks`).
9. Subagent panel mode emits JSONL rows with burn chips and effort chips on the same scale; `--json` output mode; width tiers (`TerminalWidth` narrow <140).
10. TOML config (`~/.config/claude-statusline/config.toml`: `[display] preset = minimal|default|full`, `truecolor`, `hyperlinks`, labels, git), CLI flags (`--truecolor`, `--no-hyperlinks`, `--json`), env `CLAUDE_TRUECOLOR`, `NO_COLOR`.

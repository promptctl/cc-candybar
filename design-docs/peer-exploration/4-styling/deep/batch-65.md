# Batch 65: styling deep read

Anchors are `file:line` or key, from raw files fetched for this batch. "Pct ramp" means a colour chosen from a percentage.

## claude-statusline-rs
https://github.com/Vincent615/claude-statusline-rs, stars 0
1. Fixed per segment, plus a threshold ramp on gauges. `src/render/layout.rs:3-9` defines seven truecolor foreground consts: C_BRAND (120,119,255) for `◆ model` (l.93), C_ACCENT (99,215,190) for the dir (l.102), C_BRANCH (130,220,160) for `⎇ branch` and staged `+n` (l.104-106), C_DIRTY (255,140,90) for `~n` (l.109), C_TEXT for cost/lines/clock/token counts, C_MUTED for the `ctx/5h/7d` labels, C_DIM for the separator and `⟳`. The only state colour is `color_for_pct` (`gauge.rs:10`) on the context, 5h and 7d gauges and their percentages (l.164, 190, 213).
2. Themes: not present. The colours are consts. `config.rs` has only `lang` (en/zh), `gauge_width`, `narrow_threshold`.
3. Truecolor only (`\x1b[38;2;r;g;bm`). No depth detection, no NO_COLOR (grep for NO_COLOR and COLORTERM in src/ finds nothing).
4. Foreground only; no background fills.
5. Plain text separator `  │  ` in C_DIM (`layout.rs:13`).
6. Separators only. Different hues per segment type, no alternation logic.
7. Not present. Fixed colours, no light/dark adaptation and no contrast calculation.
8. Unicode glyphs (`◆ ⎇ ⏱ ⟳`), no Nerd Font. Gauge uses 1/8 blocks `▏..▉`, track `▁`, framed by `▐ ▌` in dark grey (`gauge.rs:3-8`).
9. The gauge gradient is the notable part: `build.rs` bakes a 101-entry table from six stops (green 0, lime 30, yellow 50, orange 65, red 80, pink 100). Each filled cell is coloured by its own position along the bar (`gauge.rs:33-37`), and `color_for_pct` colours the percentage text from the same table. Filled cells are bold; the empty track is a fixed (30,34,40).
10. TOML config (`config.rs`): `lang`, `gauge_width`, `narrow_threshold`. No colour keys.

## mods-equipo
https://github.com/Vincitorecode/mods-equipo, stars 0
1. By threshold. `plugins/contexto-costo/hooks/register.tsx:374` `colorDe(p, umbral)`: red at or above the threshold, yellow from threshold-25, otherwise green. Rate-limit meters (l.267): red >=80, yellow >=50, green. Agent name `cyan` (l.119). Costliest turn `yellow` (l.278). Everything else `dimColor`.
2. Themes: not present. Colours are Ink named colours (`green`, `yellow`, `red`, `cyan`), so the terminal's palette decides the shade.
3. Ink named colours (ANSI 16). Depth and NO_COLOR handling is Ink's, none in this code.
4. Foreground only.
5. Plain ` · ` in `dimColor` (l.207).
6. Not applicable; one line of dim text with a coloured bar and percentage.
7. Not present. Uses `dimColor` and Ink named colours, which follow the terminal.
8. Unicode: `○ ◔ ◑ ◕ ●` context icon (l.378), block-bar sparkline, `⎿`. No Nerd Font. Strings are Spanish or English via `tr(es, en)`.
9. Not a standalone statusline: a Claude Code mod (`on('ui.render', { component: 'AbovePrompt' })`, l.171) drawing a band above the prompt, bars under tool calls (`component: 'ToolUse'`, l.102) and a pane (l.223). Counted as a statusline-like band.
10. Plugin settings (threshold, show-under-calls) in the plugin's `hooks/` code. No colour configuration found.

## claude-status
https://github.com/virajp/claude-status, stars 0
1. Fixed per segment, via config. `assets/claude-status.defaults.json` `segments`: model bg blue (bold), context bg aqua, rl5h bg blue, rl7d and rl7dm bg purple, session bg orange, cost bg green (bold), spend bg orange (bold), duration bg aqua, project bg green (bold), worktree bg yellow with fg grey, branch bg aqua. Segment lookup is inline override, then `segments.<id>`, then `FALLBACK_BG` (`segments.rs:59-64`). Foreground is `defaultFg` ("white") unless overridden. The sub-agent bar maps status text to a colour by regex (`subagent.statuses`: done green, error red, pending bg3, running blue).
2. Themes: not present as a switch. There is a single `palette` of 10 named RGB colours that is Gruvbox (blue 69,133,136; aqua 104,157,106; green 152,151,26; orange 214,93,14; purple 177,98,134; red 204,36,29; yellow 215,153,33; white 251,241,199). Users override `palette` entries or write `#rgb`/`#rrggbb`/`[r,g,b]` per segment (`config/color.rs:3-5`). Format is a name-to-RGB map plus per-segment bg/fg/bold.
3. Truecolor only (`color.rs:82-88`, `38;2` and `48;2`). Unresolvable specs fall back to palette `white`, else Gruvbox white. No depth detection or NO_COLOR found in `color.rs`/`powerline.rs`.
4. Background-filled cells, with `fg`/`bold` per segment.
5. Powerline arrows, from `powerline.cap`, `sep`, `sepThin` (Nerd Font glyphs in the defaults; the characters were stripped from my fetch). `powerline.rs:80-117`: opening cap is the first segment's bg as foreground; between segments with different bg the arrow is fg=this bg, bg=next bg; with the same bg a thin separator in `thinFg` (grey) is drawn on the shared bg; closing arrow is the last bg as foreground. Segments compare by resolved RGB, so `"blue"` and `"#458588"` are the same background.
6. Hue per segment (the same hue repeats across non-adjacent ones), plus the same-bg thin-separator rule. In the default layout line 1 runs blue, aqua, blue, purple, purple, orange, so the two purple segments are told apart only by the thin divider.
7. Not present. Fixed palette and `white` text on all segments except worktree (grey on yellow).
8. Nerd Font glyphs by default (`symbols`, with `typeSymbols` for sub-agent kinds), a few emoji (⏱️ 🌲 ⚡), gauge `▰▱` configurable. No documented ASCII mode found.
9. Sub-agent status bar (separate renderer `render/subagent.rs`). Escapes in separators are sanitized (`powerline.rs:61-67`). The site has a config generator (`site/static/config-generator.js`).
10. JSON config in layers (user layer plus a restricted repo layer), JSON schema (`schemas/claude-status.schema.json`), `claude-status --configure`, `--doctor`. `lines` is an ordered list of segment ids per line; each entry can carry inline `bg`/`fg`/`bold`.

## claude-usage-band
https://github.com/visavv/claude-usage-band, stars 0
1. By state. `extras/statusline.js:96` context colour: red (31) >=80, yellow (33) >=60, else green (32). Rate windows (l.129-132): green; yellow when behind pace by >10; magenta when behind by >25; red at >=90 used. Chrome is grey: `38;5;250` text, `244` separator, `238` track. Pace tick `250`, plan-target tick `214`. The mod version (`hooks/register.tsx:336`) maps bar colours green `#5fae7b`, yellow `#d9a441`, red `#e5534b`, magenta `#c86fd0`.
2. Themes: not present.
3. SGR 16 for state colours, 256 index for chrome (statusline.js); Ink named and hex in the mod. No depth detection or NO_COLOR.
4. Foreground only.
5. Plain ` │ ` in 256-colour 244 (statusline.js:37); the mod uses a `SEP` constant and `┃`.
6. Separators and labels only.
7. Not present. The mod uses Ink `gray` and `dimColor`.
8. Unicode: bars `█` with `░` track, `│` ticks, `◆`, `◇ Codex`. No Nerd Font.
9. Dual deliverable: `extras/statusline.js` (a real statusLine script) and a Claude Code mod (`AbovePrompt`, l.267) with SVG-style meters (`rect ... rx=3`, l.349). Pace and plan-target ticks are drawn over the bar (`bar(..., ticks)`, l.43-52).
10. Not found. Colours are code constants.

## claude-readout
https://github.com/VitorFOG/claude-readout, stars 0
1. By semantic palette role. `render.go`: model glyph `Muted` with the name in `Accent` (l.201); branch glyph `Muted` with the name in `Accent` (l.412); repo name `Text` (l.409); session/tools/cost values `Text` with `Muted` glyph (l.267-284); thinking glyph `Muted`; scoped weekly meter `Scoped` (l.237); git staged `OK`, modified `Warn`, untracked `Muted`, ahead `OK`, behind `Crit` (l.417-429). Meters (5h, weekly, context) use `rampColor(value, palette.Bar)` for both the filled bar and the `%` text (l.155, 177); reset countdown is dim `Muted`.
2. One default theme: Tokyo Night (`theme.go:210` `defaultPalette`: accent #7aa2f7, muted #565f89, text #c0caf5, barEmpty #3b4261, scoped #bb9af7, ok #9ece6a, warn #e0af68, crit #f7768e). Format: semantic roles `accent muted text bar barEmpty scoped ok warn crit`, where `bar` is a ramp of `["#hex",...]` spread evenly or `[{at,color}]` stops. The user `palette` object merges over the default key by key. No other bundled themes.
3. Truecolor hex. `color.go:22` `detectColorSupport`: honours NO_COLOR (non-empty), `READOUT_NO_COLOR=1`, `TERM=dumb`; otherwise assumes truecolor. No downsampling.
4. Foreground only, plus a `dim` attribute for reset countdowns.
5. Plain text separator, `│` (nerd) or `|` (text mode), configurable via `separator`.
6. Separators only; hue carries roles, not neighbour distinction.
7. Not present beyond the palette being user-overridable. A malformed colour becomes #dddddd.
8. Two glyph sets: Nerd Font (`nerdGlyphs`) and `glyphs: "text"` ASCII mode (`textGlyphs`), plus per-key overrides; `--legend` prints them.
9. Smooth OKLCH-free RGB lerp ramp for meters (`rampColor`, `color.go:107`): green until 55%, amber at 80%, red at 100%. Width-driven layout shedding (`shedOrder`, `overflow`).
10. JSON config at `$READOUT_CONFIG` or `~/.config/claude-readout/config.json` (`env.go`): `glyphs`, `palette`, `barWidth`, `labels`, `names`, `separator`, `overflow`, `elements`, `shedOrder`, `showGitLine`. CLI `--legend`, `--no-color`. Setup via `setup.go`.

## vkartaviy/statusline
https://github.com/vkartaviy/statusline, stars 0
1. Fixed per segment plus a 4-step threshold on the bars. Roles in `themes/default.sh`: project blue, dir white, model cyan, cost yellow, worktree magenta, lines-added green, lines-deleted red, time/sep/label/pct dim white, vim normal green, vim insert blue. Context bar (`segments/context_bar.sh`): <50% `BAR_LOW`, <70 `BAR_MED`, <80 `BAR_HIGH`, else `BAR_CRIT`. Rate limits use `RATE_OK/WARN/CRIT`.
2. Four bundled themes in `themes/*.sh`: `default` (SGR 16, dim green/yellow/red gradient), `neon` (256-colour, e.g. 71 green, 178 amber, 160 red, 39 bold blue project, 141 purple dir), `minimal` (mostly dim white, magenta project), `monochrome` (all empty strings, ASCII). Format: a shell file of 21 `_THEME_*` variables holding raw escape strings. Users add their own as `themes/<name>.sh` (loaded by `--theme`, `statusline.sh:33`; unknown falls back to default).
3. SGR 16 (`\033[0;3Nm`, `2;3Nm` for dim) and 256 index (neon). No truecolor; no terminal detection. `--no-color` flag (`config.sh`) wipes every `_THEME_*` variable (`colors.sh`). `NO_COLOR` env not read (grep of `lib/` found only the flag).
4. Foreground only.
5. Plain text separator, default ` | ` (`_CFG_SEPARATOR`), coloured by `_THEME_SEP`; settable via `--separator`.
6. Separators only.
7. The default uses SGR 16 plus dim so the terminal palette decides shades. No contrast logic.
8. Icon sets via `--icons nerd|unicode|none` or a custom `icons/<name>.sh`; bar glyphs via `--bar-style block|shade|dot|ascii`.
9. Rate limits get a "pace" mark in the bar (`_CFG_BAR_PACE`). `preview.sh` previews themes.
10. CLI flags only (`--segments --theme --bar-width --rate-bar-width --bar-style --separator --rate-style --icons --no-icons --no-color`), installed via `install.sh`.

## git-pr-prompt
https://github.com/vladsavelyev/git-pr-prompt, stars 0
1. Fixed per segment, from the sample command `snippets/statusline.command`: dir 256-colour 45 (cyan), branch 76 (green), `→ <PR base>` 244 (grey), `#<PR>` 39 (blue, OSC 8 link), model 141 (purple), effort 183 (light purple), cost 222 (gold). Context bar by threshold: <50% 76 green, <80 178 amber, else 196 red.
2. Themes: not present.
3. 256-colour index only (`\033[38;5;Nm`). No detection, no NO_COLOR.
4. Foreground only.
5. Plain spaces between fields; the bar is `[====    ]` ASCII.
6. Different hues per field.
7. Not present.
8. `` branch glyph (private use) in the sample; a clickable OSC 8 PR number. Otherwise plain.
9. Not a styling project: the repo is a PR-base-branch helper for a Powerlevel10k prompt and a Claude statusline fragment. The styling is a one-line example. Colours in `bin/claude-spend` are for an HTML report page, not the statusline.
10. Edit the one-line shell command; no config.

## claude-pro-hud
https://github.com/VoidLight00/claude-pro-hud, stars 0
1. Mixed. Context: gradient by percent (`utils/colors.ts:getGradientColor`): <=25 bright green, <=50 green, <=65 yellow, <=80 bright yellow, <=90 red, else bright red. Fixed roles in `render/session-line.ts`: model name bright cyan bold (l.29), cache hit rate green >70, yellow >30, else dim (l.60), rate-limit % coloured by severity. `render/project-line.ts`: project name yellow (l.23), `git:(` and `)` magenta, branch cyan, dirty `*` yellow, ahead green, behind red.
2. "Themes" are icon and bar-glyph sets only, not colours: `emoji`, `nerd`, `ascii`, `minimal` (`constants.ts` `ICONS`); progress bar chars for `default`, `powerline`, `minimal`, `blocks` (`PROGRESS_CHARS`, l.115). Colours do not change per theme. Users cannot define a colour theme.
3. ANSI 16 only, including bright variants (`COLORS` in `colors.ts`). No 256 or truecolor, no NO_COLOR.
4. Foreground only (`bgRed` etc. are defined but the render files use foreground).
5. Plain separators: `createSeparator` styles pipe, dot, arrow (`›`), space, in dim.
6. Separators only.
7. Not present.
8. Emoji, Nerd Font, ASCII and minimal icon sets selected by `theme`; EN/KO/JA strings.
9. 6-step gradient on the bar, `renderMiniSparkline`, partial-block bar (`▏..▉`). Fork of claude-ultimate-hud.
10. JSON config (theme, language, compact, separator style) per README; `src/utils/config-counter.ts` counts the user's own config files for display.

## statusline-configurator
https://github.com/vrandecicp/statusline-configurator, stars 0
Web tool that generates a bash statusline script. Styling of the generated output: not present. `src/lib/generator.ts` has no ANSI escapes or colour (grep for color/\033/printf found nothing); `StatuslinePreview.tsx` renders a plain monospace string. The only user choices are which fields, their order, and a separator (`SeparatorPicker.tsx`). The site's own UI colours (hex in globals.css, gruvbox-like) are not statusline styling.
1-8 not present. 9. Drag-to-reorder field configurator with live text preview. 10. Web UI: field toggles, drag order, separator; copy-paste a bash function reading `~/.claude/statusline.json`.

## cc-statusline-usando
https://github.com/vrgcosta/cc-statusline-usando, stars 0. FORK OF chongdashu/cc-statusline.
Styling differences from the parent: none. `src/features/colors.ts` is byte-identical to the parent's (diff empty). `src/generators/bash-generator.ts` differs only in version (`1.3.2` vs parent `1.4.0`) and in using an older context calculation (model-name lookup plus transcript tail, instead of native `context_window`); the colour thresholds are the same (context remaining <=20% coral red 203, <=40% peach 215, else mint 158; session bar <=10% remaining pink 210, <=25% yellow 228, else green 194; fixed 256-colour roles dir 117, model 147, version 180, cc version 249, style 245, git 150, usage 189, cost 222, burn 220). Honours `NO_COLOR` (`use_color=0`, generated `.claude/statusline.sh:36`). It is an older snapshot of the parent plus a committed generated script, not a restyle.

## claude-statusline (vt-gw)
https://github.com/vt-gw/claude-statusline, stars 0
1. By threshold. `merged-statusline.js:46-50` `colorByUsage`: green <50, yellow <80, red otherwise, applied to plan-window segments. Context meter (l.97-104): green <50, yellow <70, orange (`38;5;208`) <85, red <95, blinking red (`5;31`) from 95, each with a text flag (`compact soon`, `compact now`, `auto-compact imminent`). Lines 2 and 3 are wrapped in dim `\x1b[2m` (l.266-267).
2. Themes: not present.
3. SGR 16, one 256-colour entry (208). No detection or NO_COLOR.
4. Foreground only.
5. ` │ ` in the fallback line (l.258), and `  ·  ` between joined items; both uncoloured except dim.
6. Not applicable; dim versus coloured.
7. Not present.
8. Emoji flags (`🔴 🚨 ⚠`), `█░` bar.
9. Composite script: delegates line 1 to `gsd-statusline.js` and line 2 to `ccusage statusline`, stripping duplicate segments; the blink code is the only animation.
10. Edit the script; installed by `setup-statusline.sh`.

## status-bar-claude
https://github.com/W4Ro/status-bar-claude, stars 0
1. Fixed per segment with one threshold bar. `statusline-command.sh:10-23` 256-colour: model 213 (pink), dir 39 (blue), git clean 114 (green), git dirty 208 (orange), cost 220 (yellow), time 244 (grey), lines added 114, deleted 203 (red), separator 238, output style 141 (purple), labels 240, user 80 (cyan), version 180, session id 103. Bars (l.126-129): >=90 bold 196, >=75 196, >=50 220, else 114. 200K+ warning bold red.
2. Themes: not present.
3. 256-colour index (`\033[38;5;Nm`). No detection, no NO_COLOR.
4. Foreground only.
5. Plain ` │ ` coloured 238 (l.25).
6. Different hues per field; separators.
7. Not present.
8. Emoji/Unicode (`⏱`, bars `█░`).
9. Two-line layout (main plus secondary/debug line). Usage bar function shared by context, 5h and 7d.
10. Edit the bash script; `install.sh` copies it.

## claude-statusline-config
https://github.com/wangbin3162/claude-statusline-config, stars 0
1. Template tokens. `scripts/setup-statusline.py:68-115` renders `{model} {dir} {ctx} {tokens} {branch} {cost} {duration} {version}`. Colour is only applied if a template contains `{red}`, `{green}`, `{yellow}`, `{blue}`, `{orange}`, `{cyan}`, `{pink}` (`COLORS`, l.21-28; a reset is appended if any was used). None of the four built-in templates use colour tokens (`THEMES`, l.33-38), so the built-ins are uncoloured.
2. Four "themes", which are layout templates (`classic`, `minimal`, `developer`, `power`), not colour schemes. Custom themes are saved as scripts in `~/.claude/statusline-themes/`.
3. Truecolor (`38;2;r;g;b`): red 245,34,45; green 82,196,26; yellow 250,219,20; blue 94,163,255; orange 250,140,22; cyan 19,194,194; pink 255,20,147. No detection, no NO_COLOR.
4. Foreground only.
5. Plain characters written into the template (`|`).
6. Not applicable.
7. Not present.
8. Emoji in the built-in templates (🤖 📁 ⚡️ 🌿 🚀 📂 🔋 💰).
9. A manager script and CLI for switching and creating themes (`statusline-manager.sh`, `setup-statusline.py`).
10. Template strings with tokens; CLI commands to apply a theme or write a custom one.

## cc-line
https://github.com/wangwalk/cc-line, stars 0
1. By threshold, on two items only. `statusline.sh:54-60` context bar: >=85% red (31), >=70 yellow (33), else green (32). System load (l.86-90): >=100% of cores red, >=50 yellow, else green. Everything else is the terminal's default colour.
2. Themes: not present.
3. SGR 16 (`\033[3Nm`). No detection, no NO_COLOR.
4. Foreground only.
5. Plain spaces.
6. Not applicable.
7. Not present; uses the terminal's palette.
8. Emoji/Unicode: `⎇`, `⏱`, `⚡`, `█░`, an ASCII cat `=^.^=` (a static pet, not animated here).
9. macOS only (`sysctl`).
10. Edit the script.

## claude-plugins (wcampbell-dw)
https://github.com/wcampbell-dw/claude-plugins, stars 0. Statusline lives in `plugins/statusline`.
1. Fixed per segment plus one threshold helper. `scripts/statusline.sh:46-49` defines the 16-colour palette (RED 31, GREEN 92, YELLOW 33, BLUE 34, MAGENTA 35, CYAN 36, GRAY 90). Dir: BLUE bold (l.208). Git repo label: MAGENTA bold with GREEN/YELLOW/RED for ahead/staged/modified/conflicts, GREEN check when clean (l.188-196). Model: MAGENTA bold (l.247). Effort: YELLOW (l.248). Context icon CYAN, with the bar and percentage by `color_for` (l.102-108): green below T1, yellow below T2, red above. Usage thresholds 50/80 (5h, 7d); context 15/25 (l.253, remaining-based). Account GREEN bold (l.280).
2. Themes: not present. The script states "Colors come from the terminal's own 16-color palette, so the theme decides the actual shades." (l.45).
3. SGR 16 only. No detection and no NO_COLOR found.
4. Foreground only, plus bold.
5. Plain ` │ ` in GRAY (l.50).
6. Separators only.
7. Adapts by delegation: it uses terminal ANSI colours, so the terminal theme handles light/dark. No contrast logic.
8. Nerd Font glyphs (`I_DIR`, `I_BRANCH`, `I_MODEL`, ...), OSC 8 hyperlinks (`link()`, l.74).
9. Width-aware layout (`vislen`, strips SGR and OSC 8). The repo also holds non-statusline plugins (`agent-spinners`, `subagent-kit`). Installed by `/statusline-install`, which sets `refreshInterval` 60 (`hooks/register.ts:80`).
10. Edit the script; plugin commands `statusline-install` and `statusline-uninstall`.

## claude-usage-statusline
https://github.com/webkubor/claude-usage-statusline, stars 0
1. By state: a single ramp keyed by percent used. `scripts/statusline.py:83-125`: `ramp(pct)` interpolates the active theme at the percentage; `shade(pct, 0.34)` gives the same hue dimmed for the unfilled part of the bar. Each bar cell is coloured for its own position on the track (l.136-157), so the alarm colour is always at the right end. Fixed: project dir cyan (36, l.377), grey (90) for `dim()`. Mixed severities (`WARN_AT 80`, ramp(85) for a warning mark at l.443).
2. Three bundled themes, as ramps (l.50-58): `default` (sage 74,B3,88 to amber D1,B5,66 to coral DE,8A,5F to red D6,5D,5D, stops 0/55/80/100), `cool` (teal, blue, violet, magenta), `mono` (pure luminance ramp). Format: list of `(percent, (r,g,b))` stops, chosen by `$USAGE_STATUSLINE_THEME` or `~/.claude/statusline/theme` (file switch takes effect without restarting Claude Code). Not user-extensible except by editing the script.
3. Truecolor when `COLORTERM` is `truecolor` or `24bit` (l.45); otherwise a three-colour SGR fallback (`BASIC`: 32/33/31 at 0/55/80). Honours `NO_COLOR` (l.43, strips all colour and uses `▓░` bar characters).
4. Foreground only.
5. Plain text.
6. Not applicable.
7. The `mono` theme exists for people who want it to fade; no automatic adaptation.
8. `█` solid bar (`SOLID`) with `·`; `▓░` in no-colour. Unicode only.
9. Each bar cell is individually coloured, so it is a per-cell gradient with a dimmed track in the same hue. Reads billing mode from `~/.claude.json` to adjust wording.
10. Env var `USAGE_STATUSLINE_THEME`, a theme file, `install.sh`.

## kadustatusline
https://github.com/whatiskadudoing/kadustatusline, stars 0
1. Fixed per widget via `getDefaultColor()`, with threshold colours inside some. `src/widgets/*.ts`: ModelName `#06b6d4` bold; SessionCost `#22c55e` bold; ContextBar label `#818cf8`/`#a5b4fc`, percentage by `percentageColor` (>=80 `#fb7185`, >=60 `#fb9238`, >=40 `#fbbf24`, else `#4ade80`); BlockTimer `#fb7185` at >=80, `#fbbf24` at >=60, else `#4ade80`. Each item in config can override with `color` (`renderer.ts:44`: `item.color ?? widget.getDefaultColor()`).
2. Five bundled presets in `ThemeSelector.tsx`: Default Blue, Emerald, Purple, Sunset, Rose. A preset only sets `brandingColors` (3 hex gradient for the branding header) and the separator colour; widget colours do not change. Users edit settings JSON for arbitrary colours.
3. Truecolor hex (`colors.ts` `rgbToAnsi`, `38;2`). The settings schema has `colorLevel: none|basic|256|truecolor` (`Settings.ts`), but I found no use of it in `colors.ts`, `renderer.ts` or `main.ts`. No NO_COLOR read found there.
4. Foreground only, plus bold and dim.
5. Plain character separators (`|` default, `│` in presets), colour `#475569`. A "line separator" row of `─` is optional.
6. Separators only.
7. Not present.
8. Unicode: `⛁` context buckets, `◉` icon. No Nerd Font.
9. Context bar is a per-bucket gradient green to yellow to red (`bucketColor`, three-segment lerp); the branding widget colours each letter of the name from a 3-colour list (`Branding.ts:21`), and `colors.ts` has a `gradient()` function. Display modes (nano, micro, mini, normal) shrink content by width. Ink TUI configurator with live preview.
10. Settings JSON (zod schema, `Settings.ts`): `lines` of widget items (id, type, color, bold), `separator`, `lineSeparator`, `brandingName/Colors`, `cacheTTL`, `timezone`. Ink TUI to edit it.

## switchboard-for-claude-code
https://github.com/Wheatlay/switchboard-for-claude-code, stars 0
not a Claude statusline: a VS Code extension that switches Claude Code accounts and shows 5h/7d plan limits in the VS Code status bar.

## whendone
https://github.com/wheninspace/whendone, stars 0
not a Claude statusline: a Claude Code skill that logs subtask estimate versus actual and writes an HTML progress artifact with a calibrated ETA.

## claude-code-matrix-theme
https://github.com/wickedteeth/claude-code-matrix-theme, stars 0
1. Fixed brightness tiers, one hue, plus a threshold. `files/statusline-matrix.sh:12-14`: BRIGHT (0,255,65), MID (0,143,17), DIM (0,95,20). Model, dir, branch, effort name, values are BRIGHT; separators `::` and labels (`context`, `session`, `weekly`) MID; empty bar cells and `↻` DIM; five random half-width katakana/digits in DIM at the line start (a "digital rain", new each refresh, l.16-20). Percent colour (l.50-54): >=80 HOT (255,59,59), >=50 WARN (212,255,0), else BRIGHT.
2. One theme, Matrix. `files/themes/matrix.json` is a Claude Code theme (not the statusline): `base: dark` plus `overrides` with Claude's role keys (`claude`, `text`, `inactive`, `subtle`, `permission`, `success` #00ff41, `error` #ff3b3b, `warning` #d4ff00, diff backgrounds, `rate_limit_fill`, `rate_limit_empty`, ...), about 40 keys. The statusline hardcodes its own matching colours instead of reading the theme.
3. Truecolor only. No detection, no NO_COLOR.
4. Foreground only.
5. Plain ` :: ` in MID.
6. Brightness tiers (bright value, mid label, dim filler); separators.
7. Not present; the theme is dark-only (base `dark`).
8. Unicode `▮▯` bars, `⎇`, `↻`, half-width katakana. `files/matrix-intro.py` plays an intro animation and `matrix-shell.zsh` a shell effect.
9. Theme-pack scope: statusline, Claude Code theme JSON, intro animation, zsh integration; the rain glyphs are the only per-refresh animation in the statusline.
10. Edit the script; `install.sh`/`uninstall.sh`.

## claude-statusline (wieTW)
https://github.com/wieTW/claude-statusline, stars 0
1. By theme role, by state. `lib/render.sh:16-20` documents the role set: WH primary text, MD model name, CY project path, DM secondary grey (timestamps, worktree, effort normal), SP structural grey (separators), the ladder GR to YL to OG to RD (4 quota levels, 4 progress-bar zones; OG doubles as effort=medium; RD doubles as low/no-think and context alert), RD_DATA for deleted-lines count, TRK for the bar track. Context text is WH, turning RD above 80% (92% on 1M windows, l.319). The 12-cell bar splits into quarters green, yellow, orange, red (l.329-346).
2. Palettes in `load_palette()`: dark styles chosen by `STYLE` in `statusline-command.sh:33`: `claude` (default, terracotta #D97757 with warm greys), `tokyo-night`, `tokyo-night-claude`, `catppuccin` (Mocha), `rose-pine`; plus one fixed light palette used whenever the theme name contains "light". Format: shell vars holding truecolor escapes, ~11 roles per set, values taken from each theme's official palette. Users edit the script to add one; `assets/themes.svg` shows them.
3. Truecolor (`38;2`, and `48;2` backgrounds for the bar). No depth detection or NO_COLOR found in `render.sh`/`statusline-command.sh`.
4. Both: foreground text, with the bar drawn as background-coloured spaces (`${c/38;2/48;2} `, l.342) so the fill has no font gaps.
5. Plain text separators in the `SP` structural grey; no powerline.
6. Separators and hue roles; one-line layout.
7. Yes: reads Claude Code's own theme from `~/.claude.json` (settings.json fallback) in a background job (`lib/collect.sh` `resolve_theme`, l.27-38) and switches to the light palette when the theme name contains "light". Light palette uses deep, low-luminance foregrounds (e.g. text 40,40,40).
8. Unicode only (`⚑` for the 200k cliff marker); no Nerd Font. OSC 8 links noted as dropped by Claude Code (statusline-command.sh:28).
9. Degrades to fit width across tiers (`degrade_layout`, `assets/degrade.svg`), always one line; pure bash with zero forks per frame; its context % is aligned to Claude Code's own "Context low" banner.
10. Edit `STYLE` and constants in `statusline-command.sh`; `install.sh`.

## statuslines (williamzujkowski)
https://github.com/williamzujkowski/statuslines, stars 0
1. By state, with position carrying category. `docs/THEMES.md` rule: "Position encodes category; colour encodes state." Defaults per segment key (THEMES.md §4.4): dir blue, git green, model magenta, agent bright magenta, session cyan, cost yellow, duration cyan, delta add green and del red, tokens cyan, pr blue (or approved green / changes_requested red / pending yellow / draft dim), effort low dim, medium green, high yellow, xhigh and max red. Threshold numbers use `sl_threshold_color` (`lib/colors.sh`): warn at `context_warn` 60, crit 85; ratelimit 70/90; burn $5/h and $15/h. The `instrument` theme goes further: `quiet = 1` removes colour from healthy values.
2. Six bundled themes (`docs/THEMES.md`): `default`, `dashboard`, `instrument`, `minimal`, `plain` (`color = off`), `powerline` (needs a Nerd Font for its separator). Format: a declarative `key = value` `.conf` file, parsed rather than sourced (`lib/theme.sh`, ADR-0001) with keys validated and control characters stripped; per-segment `*_color` keys plus thresholds, layout (`line1`, `drop_order`), separator, `quiet`. Users add `~/.config/statuslines/themes/<name>.conf`, which beats shipped themes of the same name (`theme.sh:sl_theme_resolve`).
3. Only the 16 standard SGR colours, by name (`colors.sh:sl_code`, plus `dim bold italic underline reverse` and bright variants); this is a stated rule: hardcoded 256 or truecolor can land unreadable on the user's background (THEMES.md §5.1). A truecolor theme must declare `requires = truecolor` and cannot be the default. Honours `NO_COLOR` and `STATUSLINE_COLOR=0|1` (`sl_colors_init`).
4. Foreground only.
5. Plain text separator, default ` | `, coloured by `separator_color` (default dim) (`render.sh:271-272`). `powerline` theme uses a thin Nerd Font glyph (U+E0B1), not filled arrows. A `spacer` pseudo-segment lets the gap be the separator.
6. Position (fixed order per theme), the colour-per-category defaults, and separators. The `instrument` theme deliberately removes hue variation so one item can pop out.
7. Adapts through the terminal's own 16-colour mapping; no probing. Accessibility rules in THEMES.md §6: colour never the only signal (`!` and `!!` markers, `colors.sh:sl_state_marker`), at most one metric may be critical per frame (`sl_crit_owner`), green unused in `instrument`.
8. ASCII by default; `context_bar_full/empty` configurable (`#`/`.` default, `█`/`▒` in `powerline`); `requires = nerdfont` declared by themes that need it; no emoji in the default.
9. Normal-is-silent: `ratelimit_show_above = 70` hides quota fields until they matter. State ladder normal/watch/crit changes text and weight before hue. Pace marker (`over12`, `under20`). Width fitting with `drop_order`. The one `rainbow` mention is a design argument against rainbow lines (`colors.sh:124`).
10. `.conf` theme files, `STATUSLINE_THEME` env, config at `$XDG_CONFIG_HOME/statuslines/config` or `~/.claude/statuslines.conf`, `STATUSLINE_COLOR`, `NO_COLOR`; a dry-run workflow in THEMES.md §8.2.

## cc-utils (wilsonneto-swe)
https://github.com/wilsonneto-swe/cc-utils, stars 0
1. By threshold, on rate limits and git counts only. `statusline-command.sh`: 5h/7d lines (`format_rl`): >=90 red, >=70 yellow, else green, colouring the whole `label bar pct resets time` string. Git: staged `+n` green, modified `~n` yellow. All other text (model, effort, cost, branch, worktree, folder, context) is uncoloured.
2. Themes: not present.
3. SGR 16 (`\033[31/32/33m`). No detection, no NO_COLOR.
4. Foreground only.
5. Plain ` | `, uncoloured.
6. Not applicable.
7. Not present.
8. Emoji per field (🤖 💪 💰 🌿 🌳 📁 🧠 ⏱️), `█░` bars.
9. Three lines; reset time prefixed with the weekday when not today.
10. Edit the script.

## cc-gradient-statusline
https://github.com/wiztek-llc/cc-gradient-statusline, stars 0
1. By state through one gradient: `statusline.py` `grad(pos)` (l.111) samples the active stop list; the percent label and context percentage are coloured by the gradient at their own value (`pct_label`, l.166; `ctx_chip`, l.428). Fixed roles: accent cyan `◆` before the model, model name TEXT, glyph labels GREY, reset countdown SOFT.
2. Three themes via `CC_STATUSLINE_THEME` (l.36-46): `pill` (default; neon on a dark background island), `light` (deep jewel tones, no background, for cream terminals), `dark` (neon on the terminal's own dark). Format: Python tuples. Stops dark: (0 mint 0,255,170), (.25 cyan), (.5 blue), (.72 violet), (.88 pink), (1.0 red 255,60,60); light: emerald, teal, ocean blue, indigo, purple-magenta, crimson, blood red. Chrome colours (`TEXT ACCENT GREY SOFT TRACK SEPC SAVED`) are per theme. Not user-extensible without editing.
3. Truecolor only (`38;2`, `48;2`). The scan flagged `env.truecolor` but I found no depth fallback or NO_COLOR read in this file.
4. Both: the default `pill` theme wraps the whole line in a dark background (22,23,30) and re-arms it after every reset (`with_background`, l.95), padded two spaces each end; `light` and `dark` are foreground only.
5. Plain separator characters coloured by `SEPC`.
6. Not applicable; one hue ramp across a line, coloured by value.
7. Yes, by explicit theme: `light` is for cream backgrounds, `pill` supplies its own dark ground so the neon works on a light terminal. Selected by env, not detected.
8. Unicode bars: eighth blocks (`EIGHTHS`), `█`, `·` track; `◆`. Emoji in glyph labels.
9. The main feature: smooth gradient bars where each cell is coloured by its position along the full bar (so the leading edge heats up), empty cells are a dimmed gradient or `TRACK`; sub-cell precision. `render_png.py` and `showcase.py` produce screenshots.
10. Env vars `CC_STATUSLINE_THEME`, `CC_BAR_WIDTH`; CLI args via `argval` in `main()`; `install.sh`, plus date/time injection hooks.

## ai-toolkit (wmxscott)
https://github.com/wmxscott/ai-toolkit, stars 0. Statusline in `plugins/statusline`; also a pi extension and a theme-sync plugin.
1. By theme role, plus threshold. `plugins/statusline/scripts/statusline.py:30-50` `Palette` roles: lavender (repo name, model, bold), sky (output style), mint (added lines, vim insert), gold (branch, effort medium), coral (effort high), rose (effort xhigh), silver (plain path), muted (separator, repo subpath), `bar_ok`/`bar_warn`/`bar_crit` (deleted lines use `bar_crit`), four vim-mode colours, effort low/max. Context, session and weekly use `pct_color`: <60 `bar_ok`, <85 `bar_warn`, else `bar_crit` (l.184).
2. Two bundled palettes, `dark` = Catppuccin Macchiato and `light` = Catppuccin Latte (l.51-92). Format: a frozen dataclass of 17 truecolor escape strings. Not user-extensible without editing. (The repo's `pi/themes/catppuccin-*.json` are for a different tool, pi.)
3. Truecolor only (`rgb()`, `38;2`). No depth detection, no NO_COLOR.
4. Foreground only, with `BOLD` and `DIM`.
5. Plain ` · ` in `muted` (`sep()`, l.284), with ` | ` between the effort badge and output style.
6. Separators only; hue by role.
7. Yes: `detect_theme()` (l.153) picks light or dark from `CLAUDE_STATUSLINE_THEME`, else a trigger file written by a theme-monitor (`~/.local/share/theme-monitor/theme-change.trigger`, set by the sibling `theme-sync` plugin), else macOS appearance (`macos_appearance()`), else dark.
8. Nerd Font required (docstring: "for NerdFont, true-colour terminals"): model ``, bolt, db, clock, dollar, calendar glyphs; progress circles `CIRCLES` in place of bars; effort shown as rising block glyphs (`▁▂▃▅█` with low/med/high/xhigh/max).
9. Companion `theme-sync` plugin keeps Claude Code and the statusline in step with the OS appearance. Three-line layout.
10. Env `CLAUDE_STATUSLINE_THEME`; `setup_statusline.py` and `link_statusline.sh` install it. No config file.

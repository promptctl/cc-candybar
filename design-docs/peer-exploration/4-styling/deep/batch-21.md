## djmaam/dotfiles
https://github.com/djmaam/dotfiles — stars 1 (a personal dotfiles repo; the statusline part is a ccstatusline config set, not an engine)
1. Fixed per segment, authored by hand, plus gradient for gauges. `ccstatusline/settings.json` gives each segment a `color` hex and no backgrounds (for example `"color": "hex:00F0FF"`, branch/date `3B4261`, separators `FF003C`). `ccstatusline/themes/powerline-neon.json:34` sets the usage bar to `"color": "gradient:05D9E8-B967FF-FF2A6D-FF003C"` (a gradient along the bar). Each segment group has its own bg (model chip bg `711C91`, usage bg `1A1A2E`, context bg `16213E`, cost bg `FF2A6D`, weekly bg `0F3460`).
2. Four hand-made theme files in `ccstatusline/themes/`: `cyberpunk-2077.json`, `neon-noir.json`, `powerline-neon.json`, `violeta-minimal.json`, plus `original-previo.json`. Each is a complete ccstatusline settings file (per-segment colour map; no palette roles). Users swap by copying a file over settings.json.
3. Truecolor hex via ccstatusline's `hex:RRGGBB` strings; `"colorLevel": 3` in settings.json:227. `ccstatusline/sysline.sh:16-21` (a third-line script) hard-codes `\033[38;2;R;G;Bm` truecolor. No NO_COLOR handling seen.
4. Both. `settings.json` is foreground-only (`powerline.enabled: false`, line 233); `powerline-neon.json:213` sets `powerline.enabled: true` and uses `backgroundColor` on every item.
5. Powerline arrow separator (a private-use glyph, `separators` array, `separatorInvertBackground: [false]`) with start/end caps in powerline-neon.json; non-powerline settings.json uses `type: "separator"` items coloured `hex:FF003C`.
6. Neighbours are told apart by group background: model chip `711C91`, usage `1A1A2E`, context `16213E`, cost `FF2A6D`, weekly `0F3460`. Within a group, adjacent items share the same bg (`merge: "no-padding"`). Not alternating by position.
7. Not present as detection. Fixed dark palettes with hand-picked text colours per bg (e.g. cost text `01012B` on `FF2A6D`).
8. Emoji and box-drawing glyphs in custom-text items (`⏳`, `◈`, `⟨ ⟩`); powerline glyphs.
9. Gradient on the usage meter (`motion.gradient`); `ccstatusline/busy.sh`, `thinking.sh` are extra shell scripts for custom-command items (not examined for colour).
10. ccstatusline JSON settings (version 3). Env vars on its helper scripts only (`CCSL_WEATHER_*` in sysline.sh).

## dkmaker/my-claude-plugins
https://github.com/dkmaker/my-claude-plugins — stars 1 (a plugin collection; only `baseline/statusline.sh` is a statusline)
1. Fixed per segment with one threshold. `baseline/statusline.sh:12-19` defines named constants; usage at 158-172, 175-190: model cyan (`C_CYAN=\033[96m`), version green (orange if an update exists), git orange, relative path red, `+N` green / `-N` red, tokens dim. Context % is by threshold: `<80` green, `80-94` yellow; past a 95% soft limit it shows used/remaining and goes orange, yellow (<=15 left), red (<=5 left).
2. Themes: not present.
3. ANSI 16 bright codes (`\033[96m`, `[92m`, `[91m`, `[93m`), one 256-index (`38;5;208` orange), one truecolor background (`C_ASTERISK=\033[48;2;218;115;88m`, Claude-orange chip around a `*`). No depth detection; NO_COLOR not present.
4. Mostly foreground-only; one small background chip (`C_ASTERISK`, line 18).
5. Plain-text: spaces only; no separator glyphs.
6. Telling neighbours apart: different hue per segment (cyan/green/orange/red), no separators.
7. Not present.
8. Emoji prefixes (`🤖 🌿 📂 📥 📤 🔄`).
9. The bg-chip `*` imitates the Claude logo; otherwise nothing.
10. No config; edit the script. Reads Claude Code's JSON from stdin.

## domin1c86/multi-hud
https://github.com/domin1c86/multi-hud — stars 1
1. Fixed per semantic role from a theme map; bars have a fixed fill colour per bar, not by threshold. `src/themes/built-ins.ts:11-35` (default theme): `model #00bcd4`, `label/dim #757575`, `warning #ff9800`, `error #f44336`, `toolActive #ff9800`, `toolDone #4caf50`, `agentRunning #00bcd4`, `cost #e91e63`, `gitBranch #2196f3`, `gitDirty #ff9800`. Bars: context `#4caf50`, quota5h `#ff9800`, quota24h `#2196f3`, quota7d `#e91e63`, quota30d `#00bcd4` (each bar keyed by name, fixed). `src/core/renderer.ts:61-141` uses `t.colors.<role>` per element; no percentage-based recolouring.
2. Four built-in themes: `default`, `minimal` (all `#e5e5e5`, ASCII icons), `powerline` (letter abbreviations + high-contrast backgrounds), `neon` (`built-ins.ts:51,106,146`). Format is a role map (13 colour roles + 5 bar styles + icons + layout). Users override via `customTheme` in `~/.claude/plugins/multi-hud/config.json`, merged by `mergeTheme` (`src/themes/custom.ts`).
3. Truecolor only: `src/themes/compiler.ts:62-72` compiles every spec to `\x1b[38;2;r;g;bm` / `[48;2;...`. Specs are `#RRGGBB` (fg), `[#RRGGBB]` (bg), `b`/`i` prefixes for bold/italic. No depth detection, no NO_COLOR (grep found none).
4. Both: bar tracks use a background (`bgColor: '[#000000]'`), text is foreground-only.
5. Plain ` │ ` between groups in line 1 (`renderer.ts:67,79`); no powerline arrows despite the theme name "powerline" (its difference is backgrounds/abbreviations).
6. Different hues per role; separators `│`.
7. Compiler derives a missing bg from a fg at 2/3 brightness and a missing fg from a bg at 1.5x (`compiler.ts:57-65`, constants "fg / bg = 1.5"). No light/dark detection.
8. Provider emoji icons (`🔥 🌙 🧠 🎭 📱`), `⎇`, ASCII fallback only in the `minimal` theme.
9. Animations: `pulse` (triangle-wave brightness scale of the bar fg, `src/animations/pulse.ts`, min brightness 0.45) and `laser` (sweep highlight), `always` or `on-change`, per-bar overrides; off by default (README "Animations").
10. JSON config at `~/.claude/plugins/multi-hud/config.json`; `/multi-hud:configure` slash command; separate `keys.json` for provider API keys.

## dotcommander/statusline
https://github.com/dotcommander/statusline — stars 1
1. Position-based emphasis plus state. `main.go:33-114`: every segment has an `active bool`; the LAST segment in a line is `active` (`pal.active` #c0caf5) and all earlier ones are `pal.muted` (#565f89) (`main.go:288`, "last in line gets active=true"). Fixed accents inside: git branch dot green when clean / red when dirty (`main.go:52-56`), model name orange (`pal.orange`) for Claude models and pale orange for Opus (`main.go:103-108`), dir icon `pal.git` blue (#7aa2f7). The leading dot and context colour come from context health: green / yellow / red from `remaining% > warning_pct(25)` / `> critical_pct(10)` (`tokens.go:68-93`). Below `alert_pct` (30) the whole bar turns red (`theme.go:alertPalette`, all fields = red).
2. One bundled Tokyo Night palette (`theme.go:36-49`) plus the red alert palette; the struct `palette{muted,soft,active,separator,git,prompt,green,red,yellow,orange,paleOrange,gray}` is a semantic role map. Per-token override via `tokens.<name>.style` in config.yaml (`style.go` parses `bold italic underline dim strikethrough #RRGGBB`); no user-defined palettes. Comments mention Catppuccin Mocha for the health colours (`tokens.go:81`) but the code uses Tokyo Night.
3. Truecolor only (`theme.go:hexToAnsi` -> `\x1b[38;2;r;g;bm`, hex for fg only). No depth detection, no NO_COLOR.
4. Foreground-only.
5. Plain-text configurable separator (`separator: " > "`, README line 70) and a leading dot bullet; coloured by `pal.separator` (#3b4261).
6. Brightness: earlier segments dimmed, final segment bright; plus the separator.
7. Not present (fixed dark palette).
8. Nerd Font branch glyph `` (`theme.go:9`, `symBranch`); no ASCII fallback seen.
9. Whole-bar red alert as a single state palette swap is the standout.
10. YAML `~/.config/statusline/config.yaml` (override `STATUSLINE_CONFIG`), `statusline config` interactive TUI (`internal/configtui`), per-token `style`, layout strings like `line1: "[dir] [prompts]"`.

## dox187/usage-aware-claude-statusline
https://github.com/dox187/usage-aware-claude-statusline — stars 1
1. Fixed per placeholder via template colour keys, plus semantic bands by usage. Template syntax `{c.NAME}...{r}` (`statusline_config.json` "templates"); defaults in `statusline.py:150-175` COLORS: time `#E5C07B`, version `#808080`, model `#E06C75`, effort `#61AFEF`, path `#61AFEF`, branch `#E5C07B`, input `#E06C75`, output `#61AFEF`, total `#B8FF75`, weather `#87CEEB`, etc. Context bar bands by absolute tokens (`statusline.py:421-426`): <150K `ctx_bar #98C379`, 150-250K `ctx_bar_mid #3E8E41`, 250-300K `ctx_bar_high #E5C07B`, 300-500K `ctx_bar_crit #E06C75`, 500K+ `ctx_bar_max #FF2A2A`. Usage bars use fraction bands (`USAGE_BAR_BANDS`, 0.4/0.625/0.75/0.875). Incident status colours by state (`status_investigating #E67E22` ...).
2. Eleven bundled palettes applied by the `/statusline-theme` skill, not at render time: Catppuccin, Dracula, Nord, Gruvbox, Tokyo Night, One Dark, Solarized, Monokai, Rose Pine, Everforest, Ayu (`.claude/skills/statusline-theme/palettes.json`). Format: a palette of 9 roles (`text, muted, red, peach, yellow, green, sky, blue, mauve`); `rolemap.json` maps each colour KEY to a role (`model: red`, `path: blue`, `branch: yellow`, `total: green`, `cached: mauve`, `weather: sky` ...). The semantic severity keys (`ctx_bar*`, status_*) are deliberately NOT in the role map, so severity green->red survives theming unless the user opts in (`bands_optin`, `status_optin`). Result is written back as per-key hex overrides. Users can define their own by editing `colors`.
3. Truecolor only: `statusline.py:320` emits `\033[38;2;r;g;bm`. README: "You do need a 24-bit truecolor terminal". Snap-to-palette uses CIEDE2000 (`colorutil.py:101 ciede2000`, `nearest_color`). NO_COLOR not present.
4. Foreground-only text; bar is block glyphs (eighth-blocks) with a track colour.
5. Plain-text: template-authored separators (`{c.separator}` key, #717171); no powerline.
6. Hue per element via the role map; separators.
7. No terminal detection. `colorutil.py` snaps colours to the nearest palette entry in CIEDE2000; no text-contrast logic seen.
8. Emoji in templates (README: "Nerd Fonts are not required"), ASCII `(git)/` label.
9. Textual TUI editor with a 2D colour picker and live preview (`statusline_editor.py`); `/statusline-preview` renders SVG (`ansi2svg.py`); history snapshots of configs; Claude status-page incident banner coloured by severity.
10. JSON `statusline_config.json` (layout, weather, colours, templates), env `STATUSLINE_CONFIG`, Textual TUI, and 5 Claude skills (config, theme, preview, install, doctor).

## Dr-LinLang/claude-statusline
https://github.com/Dr-LinLang/claude-statusline — stars 1
1. One coloured element: the context bar, by threshold. `statusline.py:243-248` (and `statusline.js:93-96`): remaining >=50% `38;5;46` (green), >=20% `38;5;226` (yellow), else `38;5;196` (red). Everything else (model, tokens, cache, cost) is uncoloured default text.
2. Themes: not present.
3. 256-colour indexes only; no detection; no NO_COLOR.
4. Foreground-only.
5. Plain ` │ ` between parts (`statusline.py:341-342`), uncoloured.
6. Separators only.
7. Not present.
8. Emoji (`🧠`, `⚡`, `💰`), block bar `█░`.
9. DeepSeek balance in `¥`, cumulative token stats; no styling extras.
10. None (edit script). Two implementations (Python and Node), installers for sh and PowerShell.

## DrayChou/cc-status
https://github.com/DrayChou/cc-status — stars 1
1. Fixed per field plus thresholds by value. `cc_status/utils/colors.py:50-62` `get_status_colors`: model green, time magenta, usage bright cyan, directory cyan, git clean green / dirty yellow, subscription blue, error red, warning yellow. Value tiers: `get_usage_color` maps spend to a 10-step "game rarity" ladder (>=300 red, >=200 orange 208, >=100 purple 128, >=50 pink 201, >=20 blue 21, >=10 light-blue 117, >=5 green 34, >=2 light-green 120, >=0.5 white, else gray 242); `get_budget_warning_color` (>=90% red, >=70% orange, else green); `get_balance_color` (negative red, low yellow by currency threshold, else green). Platform name bright magenta.
2. Themes: not present (one `ColorScheme` class).
3. ANSI 16 + 256-index (`38;5;N` for the rarity ladder). `is_color_supported()` (colors.py:189-217): honours `NO_COLOR` (off), `FORCE_COLOR` (on), `CLAUDE_CODE_STATUS_LINE` (on), TTY, TERM list; otherwise defaults on. `formatter.py` gates each colour on `self.use_colors`.
4. Foreground-only.
5. Plain-text, env-selectable: `CC_STATUS_SEPARATOR` = `pipe` (` | `), `arrow` (` ⮞ `), `bullet` (` • `) (`formatter.py:23,52-57`), uncoloured.
6. Hue per field, `Label:value` prefixes, separators.
7. Not present.
8. Unicode vs ASCII via `CC_STATUS_CHARSET` (`formatter.py:27`; git symbols `⎇ ↑ ↓ ⚑ ● =` vs `~ ^ v S * =`). Few emoji.
9. The rarity-tier colour ladder for spend is unusual.
10. Env vars (`CC_STATUS_SEPARATOR`, `CC_STATUS_CHARSET`, `CC_STATUS_SESSION_BUDGET`, `CC_STATUS_DEBUG`) and a JSON platform config (README); `validate_config.py`.

## dukechain2333/cc-status-band
https://github.com/dukechain2333/cc-status-band — stars 1
1. By theme role and by position and by state. `core/themes.js` palettes: `model` chip (accent), then alternating tones `a` / `b` by segment index (`core/band.js:325-327`: `toneOf = seg.id==='model' ? T.model : i%2===1 ? T.a : T.b`), icons use the tone's `icon`, muted text `muted`. Gauges/numbers by state: `contextRole` (`band.js:49`) `>=85%` crit, `>=60%` warn, else ok; `quotaRole(left)` `<15` crit, `<=40` warn, else ok. Roles `ok/warn/crit/track/sep/divider` come from the palette.
2. Four bundled themes in `core/themes.js:13-87`: `clay` (warm dark, accent `#D97757`), `paper` (light terminals), `aurora` (cool vivid, arrows), `ink` (no fills). Format = semantic palette: `terminal{bg,fg}`, `accent`, `model{bg,fg,icon,pip,pipOff}`, `a{bg,fg,muted,icon}`, `b{...}`, `ok`, `warn`, `crit`, `track`, `sep`, `divider`. Users pick by `--theme`/`STATUS_BAND_THEME`/`/band` picker; custom palettes not offered (themes.js is code).
3. Truecolor, with 256 fallback: `core/ansi.js:15-31` `to256` (nearest in the 6x6x6 cube vs the grey ramp by squared distance); `detectColorMode` (`ansi.js:48`) uses COLORTERM, `TERM_PROGRAM=Apple_Terminal`, TERM `*256color`. NO_COLOR not present in the fetched files.
4. Both, by shape: `chips` (a pill per segment), `arrows` (powerline), `band` (one block, segments split by `│`, two rows tall with block-char corners), `line` (no fills; `bg: null` means terminal default) (`themes.js:96 SHAPES`).
5. Per shape: Nerd Font round caps and powerline arrow, or square ends in `unicode` glyph set; `band` uses `│` coloured `T.divider`; `line` uses ` │ ` coloured `T.sep` (`band.js:355-357`). Arrow/cap colours are the neighbouring bgs (by construction).
6. Alternating two tones `a` / `b` ("neighbouring chips stay distinct", themes.js header comment), with the model chip carrying the accent.
7. The `paper` theme is a dedicated light palette (terminal bg `#FAF9F5`); each tone has an fg chosen for its bg. As a mod, it picks light/dark from Claude Code / system (see file `core/snapshot.js`, not read). Otherwise explicit.
8. Three glyph sets (`themes.js:99-166`): `nerd`, `unicode` (default, square ends), `ascii` (`*`, `#`/`.` pips, `=` fills); block elements for the two-row band corners.
9. Same renderer produces both a native mod band (Claude Code >= 2.1.287) and a classic statusLine command; `/band` picker previews every theme on the live session; SVG preview script; DESIGN.md.
10. Flags `--theme --shape --glyphs` and env `STATUS_BAND_THEME/SHAPE/GLYPHS`; `/band` interactive picker; time mode, hide list, rows, width options.

## dukechain2333/starfleet-panel
https://github.com/dukechain2333/starfleet-panel — stars 1
Claude Code mod (not a statusLine command): an LCARS panel drawn under the prompt. Styling read from source:
1. Fixed per readout from one palette `LCARS` (`plugin/hooks/lcars.ts:10-21`): orange `#FF9900`, sand `#FFCC99`, peach `#FF9966`, lavender `#CC99CC`, violet `#9999FF`, blue `#99CCFF`, tan `#CC9966`, green, yellow, red. Each column in `panel.ts` has a fixed colour (e.g. model blue, 5h limit lavender `panel.ts:242`, 7d violet, directory sand, branch violet, cost sand). State: context meter colour from percent used, `>=80` red, `>=60` yellow, else blue (`panel.ts:138-140`). On a red-alert the whole frame is repainted from the alert colour (`alertFrame`, `lcars.ts:66-79`, mixes the colour toward ink/white).
2. Themes: not present as selectable themes; one `STANDARD_FRAME` and a derived alert frame.
3. Hex strings handed to the host UI (Ink-style `color`/`backgroundColor`); `mix()` does linear RGB blends (`lcars.ts:60`). No depth detection (host's concern).
4. Both: header blocks ink-on-colour (`backgroundColor`), labels foreground-only.
5. LCARS pills `▐ LABEL ▌` (`lcars.ts:187`), elbows, block-drawing frame; no powerline.
6. One colour per column segment, each different hue; labels printed beneath their segment.
7. Text on colour blocks is always black ink (`LCARS.ink`); during an alert's blink the dark half inverts to a 75% mix toward ink (`panel.ts:149-151`). No light/dark detection.
8. Box and block-element glyphs, no emoji, no Nerd Font.
9. Blink animation synchronised with the red-alert mod; width-adaptive column dropping.
10. Mod settings via the mod system; install.sh. No colour config seen.

## earchibald/statusline-plugin
https://github.com/earchibald/statusline-plugin — stars 1
1. Authored per segment, no defaults beyond the shipped list. `bin/statusline.js:19-28` DEFAULT_CONFIG: model `cyan` bold, cwd `blue`, git_branch `magenta`, context `yellow`, cost `gray`. Each segment carries `color` (name), `bold/dim/italic`; `colorize()` (line 287-296) prepends the SGR. No thresholds.
2. Themes: not present.
3. ANSI 16 names only (`ANSI` table lines 31-53, including `gray` as 90 and bright variants). No detection; NO_COLOR not present.
4. Foreground-only.
5. Plain-text `separator` (default ` | `), uncoloured, `joinPrev` merges segments (`render`, lines 311-321).
6. Hue per segment; the separator.
7. Not present.
8. `⎇ ` prefix on the branch; segment `prefix`/`suffix` fields allow any glyph.
9. Configured by chatting: `/statusline-plugin:configure` plus a skill teaching Claude the JSON schema (README).
10. JSON `~/.claude/statusline-plugin/config.json` with a published JSON Schema (`$schema` in DEFAULT_CONFIG), edited by Claude through the slash command.

## emoralesb05/claude-keyblade-statusbar
https://github.com/emoralesb05/claude-keyblade-statusbar — stars 1
1. By state and fixed per element, in a Kingdom Hearts HUD. `keyblade.py:1252-1266` `hp_bar_color`: HP bar `colors.hp` (default green) when `>50%`, `bright_orange` `>20%`, else `red`; MP bar `blue`, switching to `magenta` ("MP Charge") below 10% (`mp_label_and_color`, 1286). Fixed: munny yellow, keyblade name cyan (`colors.keyblade`), drive bar magenta, heart icon `icon_heart`, frame brackets grey. Danger markers `「DANGER」` in reverse video below 15%.
2. "Themes" are layouts, not palettes: `classic` (2 lines), `minimal` (1 line), `full_rpg` (3 lines) (`keyblade.py:1710,1743,1780`; `config.theme`). Colour set is one table. Users override named colours through `config.colors.*` (`hp`, `mp`, `munny`, `keyblade`, `drive`) and per-effort `drive_form_colors`.
3. Three modes, detected: `_detect_color_mode` (`keyblade.py:164-176`) returns `none` if `NO_COLOR` is set or `CLICOLOR=0`, `truecolor` if `COLORTERM` is `truecolor|24bit`, else `basic`. `ANSI_TRUECOLOR` (line 87) holds RGB values "extracted from KH game assets" (e.g. HP green `#8EBC4F`, MP blue `#185FAD`); `ANSI_BASIC` is ANSI 16 plus `38;5;208` orange. `color_mode` config can force one.
4. Both: truecolor mode defines `bg_*` darkened track colours (`bg_green 35;50;20` etc., lines 109-123) for the bar tracks; text is foreground.
5. Plain-text: two-space gaps between segments (`fit_segments`, `keyblade.py:436-458`, default separator `"  "`), grey `[ ]` bar brackets (`frame` colour); no powerline.
6. Per-element hue; whitespace gaps; a muted grey frame `\033[90m`.
7. No light/dark detection; truecolor-only brighter variants.
8. Unicode symbols (`♥ ✧ ✦ ◆ ♛ ⎇ ⏱`) and some emoji (`🗝`); no Nerd Font; ASCII only if colour is off.
9. Per-model "keyblade" names (opus Ultima Weapon, sonnet Oathkeeper, haiku Kingdom Key) and a Drive form colour per effort level; level-up and save-point markers; OSC 8 hyperlinks (`hyperlink()`); `--preview` renders sample scenarios.
10. `config.json` (`color_mode`, `theme`, `colors.*`, `keyblade_names`, many `show_*` toggles), `--preview [theme] [--width N]`, `/kh-menu` command.

## enhki/claude-mods
https://github.com/enhki/claude-mods — stars 1
Collection of Claude Code mods. Only `mods/statusline-desktop` is statusline-related and it is a host, not a design: it runs the user's own `statusLine` command in the desktop app and draws its first line in a band.
1. Whatever the user's command prints: `hooks/line.ts:35-78` parses SGR into styled runs (`parseAnsi`).
2. Themes: not present of its own. Colours 0-15 map to ghostty's `palette = N=#rrggbb` lines (and files it includes via `config-file`) when set (`parsePalette`, `ghosttyIncludes`, lines 12-33); otherwise to the app's own theme keys (`fallbackPalette`: `inactive, error, success, warning, permission, merged, suggestion, text` twice, lines 7-10).
3. Handles SGR 30-37, 90-97, `38;5;n` (only n<16 mapped, higher ignored), `38;2;r;g;b` (kept as hex); background SGR is not handled (only `color`, `bold`, `dim` are applied).
4. Foreground-only (the band draws text with `color`, `bold`, `dimColor`).
5. Not present (user's output passes through as-is).
6. Not present.
7. This is the one piece worth noting: ANSI 0-15 follow the host theme so a 16-colour statusline adapts to the desktop app's light/dark theme; truecolor does not.
8. Not present.
9. Refreshes every 30 s and after each tool call/turn; other mods in the repo (forgejo-issues, walkthrough) are pane UIs, not statuslines.
10. Plugin install via `/plugin install`; reads project/user `statusLine` settings the way Claude Code does.

## EricJamie/claude-code-mods
https://github.com/EricJamie/claude-code-mods — stars 1
Claude Code mods (context-band, cache-timer) that draw cards/bands above the prompt as SVG/Text, not statusLine commands. Read: `plugins/context-band/hooks/register.tsx`, `plugins/cache-timer/hooks/register.tsx`.
1. Fixed per stat, by state, and per model. context-band `register.tsx:52-92` has two palettes (`LIGHT`, `DARK`), each a `tones` map keyed by stat (`fiveHour, sevenDay, input, output, speed, cache, cost, ctx`) with a `{bg, accent}` pair (DARK: fiveHour `#183B2F/#5BD1A3`, sevenDay `#2B2550/#A996FF`, input `#46231D/#FF8C76`, cost `#3D331A/#E9B949` ...), plus `models` colours (opus, sonnet, fable, haiku, other; `modelColor`, line 524). State: `levelOf` (line 925) `>=85` danger, `>=60` warn, else normal; `levelColor` picks `p.danger/p.warn/p.text`. cache-timer (`register.tsx:18,62-63`): label `#8A8A8A`, warm `#3E9E6E`, warn `#D08A1E` (<= ttl/6 left), danger `#D64545` (<= ttl/30), expired grey.
2. Two bundled palettes, `light` and `dark`, selectable as `auto | light | dark` (`THEMES`, line 31). Format: semantic (`card, text, muted, divider, warn, danger, tones, models, tint/track/area opacities`). User-defined: not present.
3. Hex strings; SVG cards for the desktop app and Text colours in the terminal. No depth handling.
4. Both: tinted `bg` per stat card plus accent foreground.
5. Dividers (`p.divider`), SVG rounded cards; block glyph bars `█▒░` (`register.tsx:737`).
6. Each stat has its own tint hue; two-tone background/accent per stat.
7. Strong: `auto` follows the surface; `resolveDark` (line 198) reads Claude Code's theme setting for the terminal (`$.config.list()` key `theme`, `dark*`/`light*`), macOS appearance via a `defaults`/`plutil` read of the desktop config (`userThemeMode`), and the SVG variant uses `@media (prefers-color-scheme: dark)` to swap the two palettes with no polling (line 284-289).
8. SVG icon set (`gauge, calendar, bolt, coin, doc`) with glyph fallbacks (`◔ ▦` ...).
9. Per-model colours, spend-curve chart with limit line, tinted answer columns.
10. In-mod theme command (`setTheme`, stored in the mod's store); codex/grok variants in `codex/` and `grok/` (Python).

## erik-romson/lidskjalv
https://github.com/erik-romson/lidskjalv — stars 1
not a Claude statusline: a SketchyBar + AeroSpace tracker that shows every live Claude Code session as items in a macOS menu bar (state colours: green running, peach blocked, blue compacting, grey idle, dark grey presumed dead; Catppuccin Mocha hex values in the bar scripts, e.g. popup background `0xff313244`, `plugins/lidskjalv_items.sh:104-107`).

## EvanPluchart/claude-code-status-line
https://github.com/EvanPluchart/claude-code-status-line — stars 1
1. Theme role mapped to widget, with thresholds on a few. `internal/themes/themes.go` defines `Theme{Primary, Secondary, Muted, Success, Warning, Danger, Info, Text, Separator, BarFilled, BarEmpty}`. Widgets pick roles: git branch `Info`, git clean `Success`, dirty `Warning`, ahead `Success`, behind `Warning`, untracked `Muted` (`internal/widgets/git.go`); rate limits / hints `Muted`; session widgets use `Info/Success/Warning/Danger/Secondary/Text` (`session.go`). Threshold colours: `thresholdColor` (`widgets/tokens.go:30-47`): `>= red` Danger+bold, `>= orange` Danger, `>= yellow` Warning, else Success, with config defaults context 60/80/90, cost 0.25/1/5, duration yellow 60 / orange 600. The model name and bar fill take the context threshold colour (`model.go:116`, `renderBar`). Separator widget uses `Theme.Separator`.
2. Six bundled themes (`themes.go:23-62`): `default`, `minimal` (white/grey), `neon` (bright variants), `dracula`, `catppuccin`, `nord`. Format: semantic roles. BUT the colour values are ANSI 16 names only, so "dracula/catppuccin/nord" are approximations by 16-colour slot (e.g. dracula Primary `ansi.Magenta`). Users cannot define themes; thresholds and glyph chars are configurable.
3. ANSI 16 only (`internal/ansi/ansi.go` constants incl. gray 90 and bright 91-97). `SupportsColor()` (ansi.go:44-62): `NO_COLOR` off, `FORCE_COLOR` on, else stdout must be a character device. (lipgloss/termenv are in go.mod but colours here are plain SGR.)
4. Foreground-only.
5. Plain-text separator widget `│` (default; `separator.char` configurable), coloured `Theme.Separator`; consecutive/leading/trailing separators auto-collapsed (`engine.go:82-108`).
6. Hue by role and the separator widget.
7. Not present (palette is the terminal's own 16 colours, so it follows the terminal theme).
8. Bar glyphs `━ ─` configurable; few emoji; i18n locales (fr etc.).
9. 6 locales, currency formatting; PR/agent widgets that render nothing when empty.
10. YAML `~/.claude-statusline/config.yml` with widget lines, `thresholds`, `widgets.*` options; `init`, `config set theme nord`; flags `--locale --theme --currency`.

## fbogensperger/dotfiles
https://github.com/fbogensperger/dotfiles — stars 1 (the statusline is `claude-code/statusline.sh`; "One Dark Triptych")
1. Fixed per segment plus thresholds. `claude-code/statusline.sh:26-36` One Dark truecolor constants (BLUE `61AFEF`, RED `E06C75`, GREEN `98C379`, GREY `ABB2BF`, PURPLE `C678DD`, YELLOW `E5C07B`, ORANGE `D19A66`, CYAN `56B6C2`, DIM `5C6370`). Fixed: model blue (171), thinking/effort red (174-176), git branch purple (189), line delta yellow (195), session duration cyan (201), In t/s cyan, Out t/s blue, cached dim, vibes line grey, session name purple. Thresholds: context `>=90` red / `>=70` yellow / else green (180-182); rate-limit bars the same (116-118); extra-usage credits `>=90` red, `>=50` yellow, any use orange, else green (332-335).
2. Themes: not present (the one palette is named in the header comment).
3. Truecolor only (`\033[38;2;...`); no detection; no NO_COLOR.
4. Foreground-only.
5. Plain ` | ` in DIM (`SEP`, line 36).
6. Hue per segment; the dim separator.
7. Not present.
8. Block gauge `▰▱`, `⎇`, a kaomoji "vibes" string rotating by clock (`VIBES`, line 214-227), emoji sparing.
9. Per-model usage buckets drawn as 3 extra bar lines (Session/Weekly/Fable) via a cached OAuth call.
10. Env `STATUSLINE_RATE_LIMITS=false`; otherwise edit the script.

## Fibonach0/claude-code-gadgets-macos
https://github.com/Fibonach0/claude-code-gadgets-macos — stars 1 (a macOS gadget bundle; the statusline is `claude/statusline.sh`, 39 lines)
1. State only. `claude/statusline.sh:28-34`: `color()` returns red at `>=80`, yellow at `>=50`, else green, applied to `ctx`, `5h`, `7d` percentages. Model/dir/cost uncoloured; dim grey for the separator and the git parens.
2. Themes: not present.
3. ANSI 16 (`\e[32m/33m/31m/2m`); no detection; no NO_COLOR.
4. Foreground-only.
5. Plain ` · ` in dim (`sep`, line 30).
6. Dim separator only.
7. Not present.
8. Few; README names a SwiftBar menu-bar companion with an orange dot for waiting sessions.
9. Not styling: SwiftBar bar, Finder workflow, Siri hooks, secret-guard hooks.
10. None (edit script); installer `install.sh`.

## foxfollow/Statusline-CC-Script
https://github.com/foxfollow/Statusline-CC-Script — stars 1
1. One accent per profile, plus severity colours. `statusline.sh:75-84`: `C1` separator `3D3F4C`, `C2` dim labels `7A7A7A`, `C3` = the profile accent (main text for every field), `C5` red, `C6` yellow, `C7` green, `C8` dark empty-bar fill. All field values use `C3`. Bars (`statusline.sh:158-164`): `context` bar goes green<50, yellow 50-79, red >=80 (inverted for the cache bar: high = green); filled uses the severity colour, empty `C8`.
2. A palette of ten named accents (`main-statusline.sh:30-45`): green `42e66c`, red `e64747`, blue `58a6ff`, yellow `e4f34a`, purple `b07cff`, orange `ff9f45`, cyan `4ee6d2`, pink `ff7ab6`, lavender `ccc9d7` (default), grey `8a8a94`, or any hex. Not themes: one accent per Claude profile ("tag"), stored in `statusline.conf` beside the engine so a profile cannot pick up another profile's colour. The rest is fixed.
3. Truecolor hex (`ansi_fg` -> `\033[38;2;r;g;bm`); no detection; no NO_COLOR. Invalid colour degrades to the default.
4. Foreground-only.
5. Plain separator character (`SEP_CHAR`) coloured `C1`.
6. Not distinguished; the whole line is one accent. The label tag is how profiles differ (the accent differs per account across windows, not within a bar).
7. Not present.
8. Emoji/symbols as labels (`⚡ ⏱ ★ ⌘ ⌚`), `⎇`.
9. Per-account colour so several Claude sessions/profiles can be told apart visually; an interactive installer menu (`main-statusline.sh`) to pick colour/fields.
10. `statusline.conf` per profile (tag, `STATUSLINE_COLOR`, line field lists), env overrides, interactive menu.

## francismiko/CCometixLine
https://github.com/francismiko/CCometixLine — stars 1 — FORK OF Haleclipse/CCometixLine (4 commits ahead, 116 behind; compare API 2025-11)
Differences only: the fork adds a third-party subscription quota segment and nothing else in styling.
1. New segment `src/core/segments/quota.rs`: the battery icon and its colour come from remaining percentage via `get_color_code` (`quota.rs:209-232`): >0.60 ANSI 256 index 10 (bright green), >0.50 bright yellow 11, >0.30 yellow 3, >0.10 bright red 9, else red 1 (cyan 14 at 0.6-0.7). Amount text in white; no other segment is changed.
2. Same themes as the parent (the file list shows the parent's presets: cometix, default, minimal, gruvbox, nord, powerline-dark/light/rose-pine/tokyo-night). Not changed.
3. The quota colours use `38;5;N` indices 1-14, i.e. the terminal's own 16 palette ("Colors adapt to user's terminal theme automatically", commit message), unlike truecolor themes elsewhere in the parent.
4. Unchanged.
5. Unchanged.
6. Unchanged.
7. The quota segment inherits terminal palette adaptation via indices 0-15.
8. Dynamic 12-level Nerd Font battery icon (`quota.rs:181-203`, `󰁹 󰂂 ... 󰂃`) with a health check mark.
9. 60 s / 30 s cached API for a Chinese relay platform (nf.video).
10. Quota config via `~/.claude/ccline/` files; token file; otherwise the parent's TUI.

## Gabriel-Dalton/claude-statusline-tokens
https://github.com/Gabriel-Dalton/claude-statusline-tokens — stars 1 (PowerShell)
1. Fixed per segment, with threshold on percentages. `statusline-tokens.ps1:1699-1713` 256-colour constants: dir 215, git 180, model 141, 5h 81, 7d 108, scoped model 176, session 178, ctx 110, dim 245. `Get-PctColor` (1715-1722): `>=crit(80)` red 203, `>=warn(50)` yellow 221, else green 77; applied only to the percentage figure inside the 5h / 7d / scoped segments (the rest of the segment keeps its fixed colour, via `"$pct5Color$p5$reset$fg5h"`).
2. Themes: not present; the script's top block is editable ("Colors, separators, segment order ... editable near the top of the script", README 575).
3. 256-colour indexes (`38;5;N`); no detection; no NO_COLOR.
4. Foreground-only.
5. Plain ` | ` in dim (`$sep`, last line).
6. Distinct hue per segment.
7. Not present (README mentions responsive checks in scripts/, not colour).
8. Few; text labels.
9. Env `STATUSLINE_PCT_THRESHOLDS=warn,crit` tunes the colour bands. A dashboard (`claude-dashboard.ps1`) separate.
10. Edit script; one env var; `docs/CUSTOMIZE.md`.

## gencrewai/aiops
https://github.com/gencrewai/aiops — stars 1 (a larger tool; the statusline is `claude-statusline.sh`, plus a tiny `statusline.js`)
1. Fixed per field with thresholds. `claude-statusline.sh:466-545`: model bold cyan, `In:`/`Out:`/tokens white with dim labels, cost bold yellow, account white, project blue, git branch yellow with dim hash, duration magenta, `+lines` green / `-lines` red, task text white, cache green. Percent colouring `pct_color` (378-383): `>=80` red, `>=50` yellow, else green; remaining-style `h<=30` red, `<=60` yellow, else green (387-392); effort colour by level (high magenta, medium blue, low green, 396-401).
2. Two themes selected by flag: `soft` (default; truecolor pastels: sky blue, mint, butter, peach coral, cream, lilac, periwinkle, lines 36-44) and `normal` (`--hard`, plain ANSI 16: `\033[36m` ...) (`claude-statusline.sh:16-53`). Same role names (CYAN, GREEN, YELLOW, RED, WHITE, MAGENTA, BLUE). Not user-definable except by editing.
3. Truecolor for `soft`, ANSI 16 for `--hard`; selected by flag not detection. No NO_COLOR seen.
4. Foreground-only.
5. Plain ` │ ` in dim (`SEP`, lines 44, 53).
6. Hue per field and dim `│`.
7. The `--hard` ANSI-16 mode defers to the terminal palette; no detection.
8. Emoji heavy (`💰 👤 📋 ▶ ✎ 📦`), block bar `░`.
9. `--mask-account` flag for screenshots; `--left` view toggle; three-line layouts incl. task lines.
10. CLI flags `lite`, `--left`, `--hard`, `--mask-account`; installer scripts; no config file seen for colours.

## gfreschi/claude-code-statusline
https://github.com/gfreschi/claude-code-statusline — stars 1
1. Weighted segments on a semantic token layer. `lib/derive.sh` maps `PALETTE_*` base colours (12 roles: BG, FG, BG_ALT, BG_DIM, BLUE, GOLD, GREEN, CYAN, RED, ORANGE, MAGENTA, DIM) to `C_*` tokens. Each segment declares `_seg_weight` (`lib/render.sh:421-436`): `primary` has its own bg/fg, `secondary` is on `C_MUTED_BG` with `C_BASE_FG`, `tertiary` is on `C_MUTED_BG` with a per-segment fg (default `C_DIM`), `recessed` is on `C_DIM_BG`. Model is primary and coloured by tier (`lib/segments/model.sh:17-20`: opus `C_OPUS_BG`=gold, sonnet blue, haiku cyan, other base). Context is primary with five threshold bg/fg pairs (`derive.sh:23-36`): healthy 0-49 (bg 22 dark green, fg green), warming 50-69 (gold), filling 70-84 (bg 52 dark red, orange), soon 85-94 (red), crit 95+ (red). Duration escalates fg (`C_DUR_LOW/MED/HIGH/CRIT`); lines delta add green / del red / zero gold; worktree magenta; project secondary.
2. Four bundled themes in `lib/themes/`: `catppuccin-mocha` (default), `dracula`, `nord`, `bluloco-dark` (THEMES.md). Format: `PALETTE_*` 256-colour indexes (12 roles, with the hex in a comment table) plus optional `C_*` overrides (nord raises `C_CTX_HEALTHY_BG`, catppuccin overrides `C_SONNET_BG`, `C_CTX_*_BG`). Users add a theme by adding a file under `lib/themes/`; chosen with `CLAUDE_STATUSLINE_THEME`. CONTRIBUTING.md has a guide for porting a terminal theme (hex to 256 conversion).
3. 256-colour indexes only (`\033[48;5;Nm` / `38;5;N`); README requires a 256-colour terminal. No downsampling; NO_COLOR not present.
4. Background-filled powerline cells (primary/secondary/tertiary/recessed), with foreground-only text on those fills.
5. Powerline triangle (`GL_POWERLINE` U+E0B0) or capsule round caps (`CLAUDE_STATUSLINE_CAP_STYLE=capsule`, `GL_CAP_LEFT/RIGHT` U+E0B6/E0B4); transition colours are computed: arrow fg = previous bg, bg = next bg (`render.sh:226`); same bg on consecutive segments emits no arrow (`render.sh:218-221`); thin separator `│` in dim for tertiary clusters (`emit_thin_sep`).
6. Telling neighbours apart: by weight tier (primary bright, secondary/tertiary share the muted bg, recessed darker) so neighbours of equal weight are merged into one band separated by thin `│`, with arrows only where the bg changes.
7. Per-theme `C_*_FG` pairs chosen by hand to fit their bg (nord has a "low contrast by design" override); no automatic contrast and no light/dark detection (all four themes are dark).
8. Capability detection (`detect_capabilities`, `render.sh:55-150`): `CLAUDE_STATUSLINE_NERD_FONT` (1/0) switches the whole glyph table to ASCII (`>`, `dir`, `br`, `(`...); Unicode vs ASCII by locale; OSC 8 links off in tmux/SSH.
9. Layouts (`classic` 2 rows, `zen` 3 rows), rate-limit styles (`ember`, `bar`, `pill`, `minimal`), context gauge styles (`dots`, `blocks`, `braille`, `pips`); `CLAUDE_STATUSLINE_MINIMAL=1` strips icons keeping colour; blink attribute for criticals; vhs-generated preview GIFs.
10. Env vars (`CLAUDE_STATUSLINE_THEME/LAYOUT/RATE_STYLE/CTX_GAUGE/CAP_STYLE/SEGMENTS/MINIMAL/NERD_FONT`) or a sourced shell file `~/.config/claude-statusline/config.sh`; unknown values silently fall back.

## Gjermstad/claude-statusline
https://github.com/Gjermstad/claude-statusline — stars 1
1. Fixed per element with state for gauges. `statusline.sh:38-98`: model cyan, folder blue, countdowns magenta, branch green; effort by level (low/medium green, high yellow, xhigh/max red, else cyan); bars `bar()` (69-77) green `<=50`, yellow `50-75`, red `>75`; cache timer green/yellow by remaining TTL (163-165), cache-miss red.
2. Themes: not present (the "github" hit in theme names is the repo URL).
3. ANSI 16 by default; truecolor RGB for the three pressure colours when `COLORTERM` is `truecolor|24bit` (`statusline.sh:45-50`: green `63;185;80`, yellow `219;158;24`, red `248;81;73`), with a comment: ANSI slots 2/3/1 rendered the three bars indistinguishable in Ghostty's default palette. No NO_COLOR.
4. Foreground-only.
5. Plain ` | ` uncoloured.
6. Hue by role, ` | `.
7. The truecolor-over-palette choice is the only adaptation: RGB so the terminal palette cannot flatten the three severity colours.
8. Emoji (`🌿 📁 ❄️`), block bar `█░`.
9. A tiny quota log (`CLAUDE_STATUSLINE_QUOTA_LOG`) and screenshot generator `docs/generate-screenshots.py`.
10. Env only (`CLAUDE_STATUSLINE_QUOTA_LOG`, `CLAUDE_CODE_AUTO_COMPACT_WINDOW` read); edit script.

## Glucksberg/cc-hud
https://github.com/Glucksberg/cc-hud — stars 1 (README: "a merge of ccstatusline and claude-hud"; carries ccstatusline's engine, so read as such, plus activity widgets)
1. Per widget, authored: each widget has `color` and `backgroundColor` (`src/utils/colors.ts getChalkColor/applyColors`), with `overrideForegroundColor` global. In powerline mode a theme overrides them by position: `renderer.ts:187-194` picks `themeColors.fg[widgetColorIndex % len]` and `bg[...]`, where the index increments per non-merged widget (merged widgets share one colour). So position-cycled five-colour palettes.
2. Eleven powerline themes (`colors.ts:266-433`): `custom`, `nord`, `nord-aurora`, `monokai`, `solarized`, `minimal`, `dracula`, `catppuccin`, `gruvbox`, `onedark`, `tokyonight`. Each theme is `{ name, description, 1|2|3: { fg: [5], bg: [5] } }`, one set per colour level (basic 16, 256, truecolor), e.g. nord truecolor bg `88C0D0, 4C566A, 5E81AC, B48EAD, A3BE8C` with fg `2E3440, D8DEE9, FDF6E3, 2E3440, 2E3440`. The TUI selector can "customize" a theme: copies its colours into the widgets and switches to `custom` (`PowerlineThemeSelector.tsx:50-95`).
3. All three depths with hand-authored values per depth: ANSI16 names (`bgBrightCyan`), `ansi256:N`, `hex:RRGGBB`; chalk level is a setting `colorLevel` 0-3 (`types/ColorLevel.ts`) applied as `chalk.level = settings.colorLevel` (`cc-hud.ts:62`); `bgToFg()` converts a bg name to the same hue fg for separators. No auto-detect seen here; NO_COLOR not seen.
4. Both: plain mode foreground (+ optional bg), powerline mode background cells.
5. Powerline separators configurable arrays (`separators: ['']`, `separatorInvertBackground`, `startCaps`, `endCaps`; `PowerlineConfig.ts`). Colouring (`renderer.ts:334-342`): normal = fg is previous widget's bg, bg is the next widget's bg; inverted = swapped. Font presence check by scanning font directories (`powerline.ts:checkPowerlineFonts`) with an auto-installer.
6. Cycling the five (fg,bg) pairs of a theme by widget index.
7. Per-theme explicit fg per bg (dark text on light bgs, e.g. nord `2E3440` on `88C0D0`). No automatic contrast or light/dark detection.
8. Powerline/Nerd fonts; emoji labels via merge; tool/agent/todo activity widgets.
9. Activity tracking (tools, agents, todos) is its added feature; gradient noted in signals but not read.
10. TUI configurator (Ink) with colour menus, `settings` JSON, theme selector, powerline setup.

## glunkov/claude-code-statusline
https://github.com/glunkov/claude-code-statusline — stars 1
1. Fixed per role with severity. `statusline.sh:48-60`: palette `NEU` neutral, `ACC` accent, `C_GRN`, `C_YEL`, `C_RED`. Model in accent (`[MODEL]`, line 133), path and branch neutral, separators `·` neutral. Gauges recolour by percent: `>=90` red, `>=70` yellow, else green (88-90).
2. Two palettes, light and dark, selected by detection (below), 256-colour: dark `NEU 245, ACC 44, GRN 34, YEL 214, RED 203`; light `NEU 240, ACC 25, GRN 28, YEL 166, RED 160`. Not user-editable beyond the script.
3. ANSI 256 indexes; no truecolor; no NO_COLOR.
4. Foreground-only; a `BAND` background variable exists but is deliberately empty on both themes ("no background band", lines 53, 57, 263).
5. Plain ` · ` neutral.
6. Hue per role, `·`.
7. Strongest feature: theme resolution (`statusline.sh:12-42`) in order: `CLAUDE_STATUSLINE_THEME` override (`light|dark|auto`), then the `.theme` key in `~/.claude/settings.json` then `~/.claude.json` (anything starting `light`/`dark`), then `COLORFGBG`'s last field (bg index 7 or 9-15 = light), else dark. Light palette uses darker, white-legible colours.
8. Emoji (`📁 🌿`), `●` dots; gauges shrink to a single dot when narrow.
9. Gauges "grow toward trouble": colours shift with them (README line 17).
10. One env var `CLAUDE_STATUSLINE_THEME`; otherwise edit the script.

## claude-sabai
https://github.com/panupat-top/claude-sabai — stars 0
Two surfaces: `statusline/hub.sh` (a real two-line terminal statusline) and `plugins/sabai/hooks/*` (a Claude Code desktop-app mod: pixel-art band, panes, SVG). Both described.
1. Colour assignment, `hub.sh`: fixed per segment, then state override. Dir bold default; branch `$MAG`; ahead `$GRN`; behind `$CYN`; dirty `$YEL`; session group (model/effort/cost/time) `$DIM`; context meter base `$CYN`, 5H meter `$BLU`, 7D meter `$YEL`. In `meter()` the base colour switches to `$YEL` at >=70% and `$RED` at >=90% (`WARN_AT=70 ALERT_AT=90`). Band (`themes.ts`): colour by role: `text: Record<Ink,string>` and `bar: Record<BarKind,string>` hold per-metric colours (`tasks`, `context`, `session`, `week`, `warn`, `alert`); tool-call tiles use `tiles: Record<Hue,[bg,fg,line]>` keyed by call kind (`read`, `edit`, `command`, `ok`, `web`, `skill`, `fail`, `stop`, `warn`).
2. Themes: band only. 6 bundled in two modes, picked independently: light `mono`/`pastel`/`matcha`, dark `ink`/`forest`/`synthwave` (`themes.ts` `LIGHT_THEMES`, `DARK_THEMES`, `DEFAULT_THEME = {light:'mono', dark:'ink'}`). Format is a semantic table `{card, track, pill, text{t,m,tasks,context,session,week,warn,alert,ok}, bar{...}, tiles{...}}`. User-defined themes: not present (picked in desktop settings). `hub.sh`: no themes.
3. Colour spec/depth: `hub.sh` uses ANSI 16 only (`\e[31m` etc, comment "the terminal's own 16 colours, so the line follows its theme, light or dark"); no depth detection, no NO_COLOR. Band: hex.
4. Fill: `hub.sh` foreground-only on terminal bg (bars are `━` cells, filled in colour, track `$DIM`). Band: filled cards/tiles/pills (SVG).
5. Separators: `hub.sh` two spaces (`SEP="  "`) with icons, ` · ` without; no powerline. 
6. Neighbours: different hues for the three meters (cyan/blue/yellow); separators only.
7. Light/dark: `hub.sh` defers to terminal 16-colour palette. Band: separate light/dark theme per OS appearance; header comment: every theme's words read 4.5:1 on its card, white 4.5:1 on its pill, tile glyphs 5:1 on their ground "checked by the tests".
8. Glyphs: Nerd Font v3 Material Design range by default (`I_DIR="󰉖 "` etc); `SABAI_HUB_ICONS=0` switches to ASCII (`⎇`, `$`, ` · `).
9. Other: pixel-art mascot "Clawd" sprites (`sprites.ts`), animation, a "race" row per subagent; screenshots `docs/images/themes-light.png`/`themes-dark.png`.
10. Customisation: `SABAI_HUB_ICONS` env; thresholds hard-coded in `hub.sh` (`WARN_AT`, `ALERT_AT`, `CELLS`); band settings in desktop app (theme pair, thresholds "you set" per README).

## ai-usage-advisor
https://github.com/Parrilla38/ai-usage-advisor — stars 0
Mostly not a statusline: a Windows model/effort recommender app. Its statusline piece is a thin wrapper.
1. `src/integrations/statusline-wrapper.ps1` runs the user's own `statusline-command.ps1` and appends a suffix (`💡<model>/<effort> <conf>%` or `✓IA`) with no colour codes at all: one colour for everything (the user's inherited output). The separate desktop widget (`scripts/widget.ps1:28`) colours the model badge fixed per model: haiku `#34D399`, sonnet `#60A5FA`, opus `#A78BFA`, fable `#FBBF24`.
2. Themes: not present.
3. Depth/NO_COLOR: not present (widget is WPF hex).
4. Fill: statusline suffix none; widget has a filled rounded badge `Background="#60A5FA"` with dark text `#10121A`.
5. Separators: a single space before the suffix.
6. Neighbours: not present.
7. Light/dark: not present (widget is a fixed dark card `#F0171A23`).
8. Glyphs: emoji `💡`, `✓`.
9. Notable: per-model colour mapping in the widget only.
10. Customisation: none for colour.

## tamashell
https://github.com/paullaudeman/tamashell — stars 0
A virtual-pet/companion HUD in the statusline, not a metrics statusline.
1. Colour: by rarity of the pet. `server/types.js`: `RARITY_HEX` common (220,220,220), uncommon (40,255,130), rare (70,170,255), epic (210,160,255), legendary (255,230,50); `RARITY_256` 255/48/75/141/227; `RARITY_16` 97/92/94/95/93. `buddy-hud-wrapper.js` applies `colorize(line, rarity)` to the sprite, name, star line and the `│` border; `dim()` while the pet sleeps.
2. Themes: `pixel/pixel-owl.js:65` `THEMES = ['nord-midnight','amber-crt','gameboy','barn-owl']` colour the kitty-graphics pixel owl image; `pixel/set-theme.js <name>` selects. Palette lives in pre-generated PNG assets (`pixel/generate.py`). User themes: not present.
3. Depth: `server/ansi.js` `detectColorLevel()`: `NO_COLOR` -> 0, `TERM=dumb` -> 0, `FORCE_COLOR` 0..3, `COLORTERM=truecolor|24bit` or `WT_SESSION` or iTerm/Apple Terminal -> 3, `TERM` contains `256color` -> 2, else 1; colour then picks hex / 256 / 16 table. Honours NO_COLOR.
4. Fill: foreground only for text; sprites are kitty images placed via Unicode placeholder cells whose fg colour carries the image id (`SGR 38;5;<id>`).
5. Separators: `│` border box in rarity colour; no powerline.
6. Neighbours: not applicable.
7. Light/dark: not present.
8. Glyphs: emoji, box-drawing, ASCII fallback for the owl when tmux/screen or `TAMASHELL_PIXEL=0`.
9. Notable: pixel art through kitty graphics protocol; bubble fade effects (`pixel/bubble-render.py`, `ansi.js` "bubble fade").
10. Customisation: `pixel.json` in state dir via `node pixel/set-theme.js` (theme, on/off, perch, offset, lane); `commands/theme.md` slash command.

## claude-task-manager
https://github.com/paunescumihai/claude-task-manager — stars 0
1. Fixed per segment with one threshold ramp. `hooks/statusline.sh`: host bold cyan, user cyan, cwd blue (`BLU`), model bold magenta (`MAG`), email dim, cost `$` dim + green, `+N` green / `-N` red, pending-task count yellow, `BYPASS` bold red when on (dim "bypass off"), version dim. Threshold `heat()`: >=85 red, >=60 yellow, else green, applied to 5h, 7d and ctx percentages.
2. Themes: not present.
3. Depth: ANSI 16 only (`\033[31m`...). NO_COLOR is honoured only in `hooks/pending_tasks.py:972` (`color = not os.environ.get("NO_COLOR")`) for the task board rows, not the main line.
4. Fill: foreground only.
5. Separators: dim `│` (`SEP="${D}│${R}"`).
6. Neighbours: hue per segment + dim separator.
7. Light/dark: not present (relies on terminal's 16 colours).
8. Glyphs: plain ASCII + `│`; Romanian text labels ("compact în").
9. Notable: second line board of pending tasks (python `pending_tasks.py board`), wraps to `COLUMNS`.
10. Customisation: edit the script; `NO_COLOR` for the board; `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`.

## CYC
https://github.com/pbayzelfium/CYC — stars 0
A Windows terminal theming kit (oh-my-posh prompt variants + Windows Terminal schemes); the statusline is one piece, `src/.claude/statusline.ps1`.
1. Colour: semantic palette roles mapped to segments, with state override. `statusline.ps1`: model `os` (mauve), dir `path` (blue), git clean `gitClean` / dirty `gitDirty`, ahead `python` (sky), behind `ahead` (peach), PR by `review_state` (approved green, changes_requested red, draft dim, else sky), cost `ahead` (peach), rate limit `node` (teal), separators/dim `dim`. Context bar and `5h`: ctx >=85 danger, >=60 yellow, else green; 5h >=80 red, >=50 yellow, else teal. Lines `+N`/`-N` green/red.
2. Themes: 7 palettes in `src/.oh-my-posh/palettes.json`: `catppuccin-mocha`, `tokyo-night`, `kanagawa-wave`, `nord`, `dracula`, `gruvbox-dark`, `rose-pine`. Format: roles `bg fg os path gitClean gitDirty danger ahead python node segFg dim` + a Windows Terminal `scheme` name. Users add a palette to the JSON (the file's `_comment` says so). Statusline follows the active theme via `~/.oh-my-posh/active-theme.txt` (`cyc-<name>.omp.json`), else matches Windows Terminal's `defaults.colorScheme` against palette `scheme`; fallback Catppuccin Mocha.
3. Depth: truecolor only (`38;2;r;g;b` from `Hex()`); no downsampling or NO_COLOR.
4. Fill: statusline foreground-only; the oh-my-posh prompts use powerline background pills (`segFg` is the text colour on filled segments).
5. Separators: statusline `"  ·  "` in dim; prompts: powerline glyphs (glyph.powerline=6).
6. Neighbours: different roles per segment.
7. Light/dark: palettes are all dark; `segFg` gives readable text on fills; adapts by following the terminal scheme.
8. Glyphs: header says "no Nerd Font glyphs" in the statusline (`⎇`, `●`, `↑↓`, `⚡`, `█░`); the prompts use Nerd Font, plus `subset-font.py` / catalogue HTML.
9. Notable: a single palette file drives prompt, Windows Terminal scheme and Claude statusline; `theme-catalogue.html` gallery; `/terminal-theme` command.
10. Customisation: `palettes.json`, `theme-tools.ps1` (Set-TerminalTheme), slash command.

## turn-tides
https://github.com/pengkangzhen/turn-tides — stars 0
not a Claude statusline: a Claude Code desktop mod (`hooks/register.tsx`) that draws one bar per conversation turn above the prompt with hover summaries and click-to-jump. No statusline styling to report (single `hex_colors` hit, theme keys only).

## claude-simple-hud
https://github.com/PengShiqiu/claude-simple-hud — stars 0
1. `scripts/statusline.sh`: branch fixed cyan (`\033[36m`); context bar by threshold: >=90 red, >=70 yellow, else green (`COLOR`), bar drawn in `#`/`-` ASCII; directory, `[model]`, percent and API time uncoloured.
2. Themes: not present.
3. Depth: ANSI 16; no NO_COLOR.
4. Fill: foreground-only.
5. Separators: plain spaces.
6. Neighbours: not distinguished except the cyan branch.
7. Light/dark: not present.
8. Glyphs: ASCII only.
9. Nothing else.
10. Customisation: edit script (bar width `BAR_WIDTH=10`, thresholds inline).

## redline
https://github.com/PepijnSenders/redline — stars 0
A Rust port of ccstatusline (reads ccstatusline settings, byte-identical output to ccstatusline 2.2.32 per README), plus a ratatui editor. The ccstatusline model is described here.
1. Colour: in plain mode each widget item has `color` / `background_color` in settings, default = the widget's `default_color()` (`src/widgets/mod.rs:15`; ccstatusline's defaults, e.g. in the fork api-monitor: Model cyan, Git Branch magenta, Context % blue). In powerline mode a theme overrides by POSITION: `powerline.rs:84-92` `fg = t.fg[color_index % 5]; bg = t.bg[color_index % 5]`, `color_index` advances for each rendered widget (not for ones merged with the next; `continueThemeAcrossLines` carries it across lines). So colour cycles through a 5-colour list, regardless of what the segment is. Widgets that carry their own ANSI (`preserves_colors`) keep their fg.
2. Themes: 10 bundled powerline themes (`colors.rs` THEMES): nord, nord-aurora, monokai, solarized, minimal, dracula, catppuccin, gruvbox, onedark, tokyonight. Format: per-theme `fg[5]`/`bg[5]` arrays at three chalk levels (16-colour names, `ansi256:N`, `hex:RRGGBB`), e.g. nord truecolor bg `88C0D0 4C566A 5E81AC B48EAD A3BE8C`, fg `2E3440 D8DEE9 FDF6E3 2E3440 2E3440` (fg per slot is chosen for contrast on that bg). `theme: "custom"` lets users set per-item colours instead; no user theme files.
3. Depth: `settings.color_level` 0-3 (default 2 = 256 colours, `settings.rs:216`) mirrors chalk; named, `ansi256:N`, `hex:` and `gradient:` specs are downsampled per level (`chalk_open`, `ansi256_to_ansi`, `rgb_to_ansi256`). No env detection or NO_COLOR found in the source read; level is a config value.
4. Fill: both. Plain mode fg only (optional bg per item); powerline mode background pills.
5. Separators: plain string(s) between widgets; powerline separators cycle `separators[(offset+n) % len]` with optional `separator_invert_background`; start/end caps lists. Separator colours: fg = the previous segment's bg (via `bg_to_fg`), bg = next segment's bg (`powerline.rs:257-263`), the standard arrow join; equal-bg neighbours use the segment's own fg.
6. Neighbours: powerline theme position cycle (5 distinct colours) is what separates adjacent cells; separator glyph joins them.
7. Light/dark: `solarized` and `minimal` themes exist; no auto adaptation. Each theme slot pairs a fg with its bg for contrast; `overrideForegroundColor`/`overrideBackgroundColor` exist.
8. Glyphs: powerline arrows/caps need patched font; widgets are text; emoji in some.
9. Notable: `gradient:` colour specs (`gradient.rs`, OKLab sampling, per-character) with presets atlas, cristal, teen, mind, morning, vice, passion, fruit, instagram, retro, summer, rainbow, pastel; ratatui editor shows live preview (`c` toggle colour, `p` cycle separator).
10. Customisation: ccstatusline-compatible JSON `~/.config/redline/settings.json` (falls back to `~/.config/ccstatusline/settings.json`), TUI editor `redline config` (first line only), `REDLINE_WIDTH`.

## claude-code-weaverbird
https://github.com/PeterSR/claude-code-weaverbird — stars 0
Go statusline multiplexer: providers emit a semantic `class`, never ANSI; one theme maps class to colour.
1. Colour: by state class from the provider. Severity classes `ok`, `info`, `warn`, `danger`, `stale`, `neutral`; polarity classes `gain`, `loss` (`theme.go`). Providers compute their own class (weaverbird "never derives one from a threshold"). Theme maps class -> colour; a class absent from the palette is uncoloured. Segment identity is not coloured at all.
2. Themes: 2 built in (`catalog.go`): `vanilla` (default; `warn` yellow, `danger` red, `stale` dim, `ok`/`info`/`neutral` uncoloured, `gain` green, `loss` red - "Color is reserved for what wants attention") and `teal` (truecolor; light ok `#1f9e8f`, warn `#e2892a`, danger `#d1483a`, gain `#3f8a52` and loss `#a85a50` deliberately less saturated than severity). Format: JSON per appearance, `light` and `dark` flat maps: classes, tones `<class>.tint` / `<class>.ink`, bar colours `bar.track`, `bar.ink`, `bar.fill.<class>`; values `"@key"` reference, `#rrggbb`, 256-index or named ANSI. User themes at `~/.claude/weaverbird/themes/<name>.json` (same name overrides built-in); reference cycles bounded at depth 16 and resolve uncoloured. README "Theming".
3. Depth: truecolor when `COLORTERM` contains `truecolor|24bit` (`resolve.go:133`), else hex approximated to the nearest 256 index (`color.go` `approxTo256`). `NO_COLOR` honoured (`noColorSet`, any value) and forces glyph bar style.
4. Fill: foreground text by default; optional `track` bar style draws the meter as a coloured background (`bar.track`, `bar.fill.<class>`, text `bar.ink`).
5. Separators: plain text, always dim (SGR 2, fixed across themes). Intra-provider default two spaces; inter-provider default ` · `; both overridable per theme (`separator`, `provider_separator`).
6. Neighbours: whitespace/dot separators only, plus provider boundaries get the middle dot.
7. Light/dark: yes. Appearance `auto` resolves from env override, config pointer, Claude Code's own `~/.claude/settings.json` theme, `$COLORFGBG` (`appearance.go`), else dark; each theme has light and dark palettes; tones `*.ink` give readable text on `*.tint` fills.
8. Glyphs: provider-declared icons; user `icons` map in config.json overrides per widget id or provider; README warns on emoji width.
9. Notable: `weaverbird preview --demo` renders every class; width-degradation cascade; `weaverbird theme use|appearance|bar` CLI.
10. Customisation: `~/.claude/weaverbird/config.json` (theme, appearance, bar.style, layout, icons, when), theme JSON files, env `WEAVERBIRD_THEME`/`WEAVERBIRD_APPEARANCE`, CLI commands.

## claude-code-usage-bar
https://github.com/phate09/claude-code-usage-bar — stars 0
not a Claude statusline: a Linux desktop tray/panel usage indicator (`claude_usage.py`) emitting Pango markup `<span color='#...'>`; for reference only: threshold colour from `COLORS` green `#00FF00`, yellow `#FFFF00`, orange `#FFA500`, red `#FF0000`, error grey `#888888` (`claude_usage.py:25-45`).

## claude-code-statusline (phorvicheka)
https://github.com/phorvicheka/claude-code-statusline — stars 0
1. `statusline.sh`: mixed. Threshold ramp for bars and percentages (`pct_color`, `THRESHOLD_GREEN=50`, `THRESHOLD_YELLOW=75`: green/yellow/red). Per model: `render_model` colours the `◆ name` Opus amber (`38;5;208`), Haiku cyan, otherwise blue. Fixed: `user@host` bold green (`\033[01;32m`), anchor path bold blue (`01;34`), branch blue (link-wrapped), clean `✔` green, ahead `↑` green, behind `↓` red, PR number yellow with review-state mark (approved `✔` green, changes_requested `✗` red, draft dim), fast mode `⚡` yellow, labels dim, token counts white.
2. Themes: not present (per-element `SHOW_*` toggles only, 24 of them, lines 21-43).
3. Depth: ANSI 16 plus one 256 index (amber `38;5;208`); no detection, no NO_COLOR.
4. Fill: foreground only; bars are `█`/`░` coloured by threshold.
5. Separators: assembled in `assemble_line` (whitespace/dim); narrow/wide `TIER` layouts change spacing.
6. Neighbours: hue per element.
7. Light/dark: not present.
8. Glyphs: emoji and `◆`, `⎇`; OSC 8 clickable links to repo/PR/branch (`SHOW_CLICKABLE_LINKS`, terminal allow-list at line 51).
9. Notable: width tiers (narrow/wide), multi-line (`STATUSLINE_LINES`), worktree row.
10. Customisation: edit variables at the top of the script; env `STATUSLINE_LINES`, `STATUSLINE_DEBUG`, `FORCE_HYPERLINK`.

## claude-board-kit
https://github.com/Pika-vn/claude-board-kit — stars 0
Statusline in `statusline/statusline.py` (and `.ps1`) plus a desktop mod `plan-progress-plus/hooks/register.tsx`.
1. Statusline: fixed per segment: dir cyan, branch dim, `+N` green / `-N` red, model dim. Threshold on remaining percent in `bar()`: <20% red, <50% yellow, else the base colour passed in (context blue, 5h and week green); `█` filled coloured, `░` dim. Mod: by state, `STATE_COLOR` running `#8B7CF6`, needs_input `#E09A1E`, error `#E5484D`, done `#30A46C`; token chips `CHIP_COLOR` input `#E0735A`, output `#4FAE6E`, cache `#6E8CF0`, cost `#D3A23A`, total `#B07FD9`, task `#38A9B8` (`register.tsx:26,419`).
2. Themes: not present.
3. Depth: ANSI 16 (statusline); mod is SVG hex/rgb. No NO_COLOR.
4. Fill: statusline foreground; mod SVG fills with gradients and glow.
5. Separators: ` | ` dim.
6. Neighbours: hue per segment.
7. Light/dark: mod uses a light variant via `mix(...)` toward white; statusline none.
8. Glyphs: block bar; emoji in mod.
9. Notable: mod draws an animated SVG progress pill with shimmer gradient, knob and per-state glow; shows "left" (remaining) percentages rather than used.
10. Customisation: edit scripts; installers `install.sh`/`install.ps1`.

## statusline (pikachumetal)
https://github.com/pikachumetal/statusline — stars 0
1. `statusline.js`: fixed palette `C` (all truecolor): orange `(217,119,87)` bold = project/dir name, green `(80,200,120)` = branch (`` icon), yellow dirty `●`, dim `(130,130,130)` ahead/behind and labels, magenta `(200,120,220)` = profile and model (`🤖`), `cost` `(209,154,102)`. Diff `+N` green / `-N` red. Rate limits and context: by level (`levelColor`: <20 green, <70 yellow, <90 amber, else red) with matching emoji `🟢🟡🔥🚨`. Bars are a per-cell gradient by position along the bar green `(0,200,80)` -> yellow `(220,200,0)` -> red `(220,40,20)` (`gradientAt`), not by value.
2. Themes: not present.
3. Depth: truecolor only (`38;2;r;g;b`); no detection, no NO_COLOR.
4. Fill: foreground; bar uses grey background `48;2;60;60;60` for the eighth-block boundary cell and for the pace marker `┃` which takes the background of its cell's gradient colour.
5. Separators: gray `│` (`SEP = " │ "`, `C.gray`).
6. Neighbours: hue per segment + gray divider.
7. Light/dark: not present.
8. Glyphs: emoji and Nerd Font branch icon; eighth blocks `▏▎▍▌▋▊▉`.
9. Notable: pace marker on the usage bar (elapsed fraction of window); gradient bars.
10. Customisation: `statusline.json` configurable lines (per file header); no colour options found.

## cc-statusline (PlasmaNeon)
https://github.com/PlasmaNeon/cc-statusline — stars 0
Notable for following Claude Code's own theme.
1. `statusline-command.sh`: a mix. Role-mapped to Claude's theme keys: model name `TH_claude`, labels `TH_inactive` (dim), git dirty marker `TH_error`, gauge `success` -> `warning` -> `error` (six bands built from those three anchors, `GAUGE_MODE`), effort level `low` = `warning`, `medium` = `success`, `high` = `permission`, `xhigh` = `autoAccept` base plus shimmer crest `208,180,255`, `max` = animated rainbow over the 7 `rainbow_*` keys, ultracode = white on `rgb(140,80,240)` background. Fixed hues (comment: clear ~3:1 against both white and black): cwd cyan `(14,140,158)`, git branch rose `(186,92,124)`, cost sage `(107,128,104)` (lines 294-302).
2. Themes: reads the active Claude Code theme from `settings.json` (`.theme`, local overrides it) and carries the CLI's literal palettes: `dark` (default), `light`, `dark-daltonized`, `light-daltonized`, `dark-ansi`, `light-ansi`; plus `custom:<slug>` files in `~/.claude/themes` (`{base, overrides}`) merged on the CLI's rules. Keys: warning success permission autoAccept claude inactive error + 7 rainbow. `auto` cannot be followed (falls back to dark). Own themes: not present.
3. Depth: truecolor `38;2` for the rgb themes; the two `-ansi` themes emit named ANSI colours (`ansi:yellowBright`, ...); chosen by theme, not detected. No NO_COLOR.
4. Fill: foreground only, except ultracode label background.
5. Separators: dim `·` (`DIM + C_LABEL`), or `:` for some pairs; location group wraps to a second line on narrow terminals.
6. Neighbours: hue per segment + dim dot.
7. Light/dark: yes, by following the CLI theme (comment: not `COLORFGBG`, "captured when the shell starts and never updates"); daltonized themes avoid green in the gauge (blue/yellow, `GAUGE_MODE=dim|pale`, weakened step 0.65x toward black on dark, 45% toward white on light); fixed hues picked for ~3:1 on both backgrounds.
8. Glyphs: Nerd Font branch icon; ASCII otherwise.
9. Notable: effort level rendered like the CLI's `/effort` picker including animated rainbow/shimmer, frame advanced per redraw by cost/context/transcript-size change (`anim_frame`, state file in `$TMPDIR`).
10. Customisation: edit script; picks up `/theme`.

## loadout
https://github.com/poindexter12/loadout — stars 0
A plugin collection; `plugins/observability/bin/statusline.js` is the only statusline code.
1. No colour: it prints plain text (request-body size, rate-limit status, observer health) joined by ` | ` and appends to another statusline's output (`renderPassthrough`). No ANSI codes found in the file. Dashboard CSS (`plugins/sidequest/dashboard/.../theme.css`) is a web UI, unrelated.
2. Themes: not present.
3. Depth/NO_COLOR: not present.
4-8. Not present (plain text, ` | ` separator).
9. Nothing styling-related.
10. Customisation: none for style.

## claude-statusline (PouriahLabs)
https://github.com/PouriahLabs/claude-statusline — stars 0
Go single binary, pill-style.
1. By segment, with state override. `internal/config/config.go` `Theme` struct: model background by effort level (`effort_low #444444`, `effort_medium #005f87`, `effort_high #000075`, `effort_xhigh #87005f`, `effort_max #b02a7a`, `model_default #5f0087`), context pill by threshold `ctx_ok #3d5a45` / `ctx_warn #70551f` / `ctx_crit #8a2b2b` (warn at 50, crit at 80, `Context` thresholds), `cost #5b3f5c`, limits pill one fixed bg `#332a5c` with severity carried on the NUMBER colour (`limits_warn_fg #e8a33d`, `limits_crit_fg #ff6b6b`, `limits_dim_fg #9a93c4`), `dir #2d3d5a`, `git #3a3a3a`; text `#ffffff`, diff `#87d787`/`#ff5f5f`. Comment: effort ramp is grey -> blue -> violet -> magenta -> pink, "deliberately no amber or red: those are the alarm colours owned by the two meters".
2. Themes: one shipped theme (the `Theme` struct defaults) under `[theme]` in TOML; README line 144; the scan saw "solarized" only as a sample. Format: flat per-segment colour map, values `"#rrggbb"` or 0-255 index (`ColorValue.UnmarshalTOML`). `[theme_256]` overrides individual keys at 256-colour depth only.
3. Depth: `ColorTier` none/16/256/true, `auto` detects `TERM=dumb`, `COLORTERM`, `WT_SESSION`, `TERM` containing 256, empty TERM -> 256, else 16 (`color.go:DetectColorTier`); config `display.color` overrides. Downsampling: 256 uses CIELAB nearest over indices 16-255 only (skips 0-15 because terminals repaint them; comment explains grey-collapse of the earlier NTSC metric on macOS Terminal.app), 16-colour nearest over the sixteen. NO_COLOR deliberately IGNORED (`README:187`, because Claude Code sets NO_COLOR=1 for subprocesses); `color = "none"` in config is the monochrome switch.
4. Fill: background-filled "pills" with fixed white text.
5. Separators: not powerline joins; each pill is separate with `Sep` (default one space) between and `Caps` option `none|block (▐ ▌)|round|arrow` (powerline glyphs), drawn in the pill's bg colour as fg against the terminal background so pills look detached (`render.go:pill`).
6. Neighbours: different dark hues per pill and a gap between pills; the author measured perceptual distance (comment: EffortHigh changed from violet because it measured 15.3 against cost's plum, now 43.5).
7. Light/dark: dark-only palette; text contrast audited: `doctor` reports WCAG contrast against white (`ContrastWithWhite`, aim AAA 7.0; ctx colours 7.65/6.98/8.53). Bar not adapted to light terminals.
8. Glyphs: three tiers `display.icons = nerd | unicode | ascii` chosen by an install wizard; `ascii` uses "Model:" text labels.
9. Notable: effort-level colour on the model pill; `Order` list reorders pills; reset countdown on limits pill (`limits_reset`); width fitting (`internal/render/fit.go`, `termwidth`).
10. Customisation: TOML config (`order`, `display.*`, `context`/`limits` thresholds, `theme`, `theme_256`, `context_window`, `model_names`), install wizard, `doctor` command.

## personal-plugins (powcai001)
https://github.com/powcai001/personal-plugins — stars 0
Plugin collection; `plugins/statusline/scripts/statusline_lib.py` is the statusline, `plugins/claude-pet/lib/render.js` a pet (no colour hits found).
1. Fixed per segment, with thresholds. `statusline_lib.py`: model bright white `✱` (`\x1b[97m`), git cyan `⎇ branch` with dirty `✱` red, ahead green / behind red, cwd magenta, separators grey `\x1b[90m │ `. Context bar `▓░` by threshold on 256-colour indices: `<60` -> 71 (green), `<85` -> 178 (amber), else 167 (red) (`pct_color`). Work-time segment: grey <1h, yellow <2h, white-on-red background (`41;97`) beyond. Clock: red between 23:00 and 06:00 else grey. Load average: grey <0.7, yellow <1.0, red.
2. Themes: not present.
3. Depth: ANSI 16 plus 256 indices; no detection or NO_COLOR.
4. Fill: foreground mostly; work-timer overload uses a red background.
5. Separators: grey `│`.
6. Neighbours: hue per segment + separator.
7. Light/dark: not present.
8. Glyphs: emoji `🕐`, `⚡`, `⏱`; Chinese comments.
9. Notable: time-of-day coloured clock; health reminder.
10. Customisation: edit the script; plugin.json.

## API-Monitor
https://github.com/powerfulhang/API-Monitor — stars 0
FORK OF sirmalloc/ccstatusline (README: "maintained fork", version 2.2.12). Parent model is the same as redline above (per-widget `getDefaultColor`: Model `cyan`, Git Branch `magenta`, Context `blue`; powerline theme cycle by position over 8 named themes `catppuccin dracula gruvbox monokai nord one-dark solarized tokyo-night` in `src/utils/powerline.ts`; chalk-based colour levels via `colorLevel` default 2 in `Settings.ts`; named/`ansi256:`/`hex:` colours with `COLOR_MAP` in `colors.ts`, each name carrying ansi16/ansi256/truecolor values e.g. red `#cc0000`/idx 160, green `#4e9a06`/70; React/Ink TUI colour menu and powerline theme selector with separator editor). Differences from parent:
- Pac-Man context bar: `ContextBar` display mode `pacman` (`src/widgets/ContextBar.ts`, `shared/progress-bar` `makePacmanProgressBar`) rendered as `[ ᗧ••••••]` with an ASCII option; widget default colour stays `blue`.
- New widgets for API credit cost shown as `CNY` text and API call count (provider rates for MiMo and DeepSeek in `src/utils/api-providers.ts`), default layout changed. CHANGELOG lists only these; no colour-system change found.

## pip-skills (census statusline)
https://github.com/ppryde/pip-skills — stars 0
Plugin collection; `plugins/census/scripts/render.py` is the statusline (a desktop-mod port in `plugins/census-mod/plugin/core/render.ts`; the `overseer` dashboard icons are a web UI).
1. Fixed per segment, ramp for gauges. `_CODES`: model name cyan after a bold-orange `✻` mascot (`1;38;2;217;119;87`), git `🌿 branch` green, dir `📁` magenta, changes `✏️`/`⬆️` yellow, PR by review state (approved green, pending yellow, changes_requested red), separator grey. Gauges `pac_bar` (Pac-Man style, bright-yellow `93` pacman, bright-white `97` track): percentage coloured by `level_colour_name`: green <75, orange (`38;5;208`) >=75, red >=90; an inverted ramp for good-is-high gauges (`level_colour_inv_name`, cache hit ratio).
2. Themes: not present.
3. Depth: ANSI 16 + one 256 index + one truecolor. NO_COLOR honoured: `color_enabled()` -> `CENSUS_STATUSLINE_COLOR=auto|always|never`, auto = on unless `NO_COLOR` set.
4. Fill: foreground only.
5. Separators: grey ` │ ` between segments, two-line layout joined by newline.
6. Neighbours: hue per segment.
7. Light/dark: not present.
8. Glyphs: emoji-led segments (`🌿 📁 ✏️ ⬆️`), `•` pellets; mascot overridable via env.
9. Notable: Pac-Man style bars for context, cache, limits, cost-vs-budget.
10. Customisation: env `CENSUS_STATUSLINE_SEGMENTS` (comma list, `/` for line breaks, default `context,cache,limits,cost/model,git,dir,changes,pr`), `CENSUS_STATUSLINE_COLOR`, mascot env, `CENSUS_...` budget (`DEFAULT_BUDGET=20`).

## claude-mods (pradyb)
https://github.com/pradyb/claude-mods — stars 0
Mod collection; styling is in `status-bar/hooks/register.tsx` (desktop-app band above the prompt; README: "Desktop app only; the CLI keeps its own status line").
1. By Claude Code theme role, mapped to segments. `register.tsx:19`: `level = pct>=80 ? 'error' : pct>=50 ? 'warning' : 'success'` used for 5h/7d/ctx/cache. Fixed roles: folder `claude` (bold, first segment), branch `suggestion` with git flags counts (`✓` in `success` when clean), cost/elapsed/turns `text`, labels and track `subtle`, clock `subtle`, cache `cold` `error`.
2. Themes: not bundled; uses Claude Code's own theme keys (`claude`, `suggestion`, `success`, `warning`, `error`, `text`, `subtle`), "so the bar follows the person's theme".
3. Depth: delegated to the host (Ink `<Text color=...>` theme keys).
4. Fill: foreground only.
5. Separators: spacing; bars `█░` 4 cells.
6. Neighbours: theme role per segment.
7. Light/dark: inherited from the user's Claude Code theme.
8. Glyphs: `⎇`, `⏱`, `$`, `█░`.
9. Notable: other mods in the repo (focus-panel, turn-summary) not styling-relevant.
10. Customisation: mod settings (`cacheTtlMinutes`).

## claude-statusline-pro
https://github.com/pranav2012/claude-statusline-pro — stars 0
1. `statusline-command.sh`: fixed per segment plus thresholds. Model cyan (`⬢`), tokens `↑` green / `↓` red, cost green <$3, yellow >=$3, red >$12; context/usage bars: braille blocks `⣿`/`⣀` coloured green <50, yellow <80, else red (`build_bar`), a time-remaining variant inverted (green >50 remaining, yellow >20, red); extra-usage `💳` by budget percent (green/yellow >=50/red >=80).
2. Themes: not present.
3. Depth: ANSI 16; no detection, no NO_COLOR.
4. Fill: foreground only.
5. Separators: ` · ` plain.
6. Neighbours: hue per segment + dot.
7. Light/dark: not present.
8. Glyphs: emoji (`💰 💳`), braille bars.
9. Notable: braille bar style.
10. Customisation: `bin/install.js` installer; edit script.

## cc-candybar
https://github.com/promptctl/cc-candybar — stars 0
This is the project the survey is being run for (the user's own repo), not a peer; styling is documented in the repo's `CLAUDE.md` ("Themes", "Decorative colour by address"). Not analysed here.

## claude-statusline (proxikal)
https://github.com/proxikal/claude-statusline — stars 0
1. `command.sh`: fixed per segment, all user-configurable under `.colors.*` with defaults: separator `37`, model `36` (cyan), total tokens normal `97` / warning `38;5;208` / critical `31`, tokens icon `34`, input `38;5;39`, output `38;5;27`, git `35`, directory `31` (red), last message time `36`, session duration `38;5;244`, output style `38;5;213`, vim insert `38;5;46` / normal `38;5;33`, session cost `38;5;226`, cache stats `38;5;141`, last-call tokens `38;5;249`, agent `38;5;208`, version `38;5;244`, project `38;5;99` (lines 307-327). Progress bar: background-filled cells by threshold `progressBar.thresholds` yellow 60 / red 80, colours `48;5;46` / `48;5;226` / `48;5;196`, empty `48;5;236`, with text overlaid on the bar (`textColors.onFilled` `30`, `onEmpty` `97`).
2. Themes: `themes/developer.json`, `full.json`, `minimal.json` are LAYOUT presets (`order` + `sections` toggles + icon/bar-width tweaks), not colour themes. Colours live in the `colors` block of the config. User-defined: yes via config.
3. Depth: named ANSI names resolved by `resolve_color` (standard, bright, plus extended names orange/pink/light-blue/dark-blue/teal/lime/coral/salmon/violet/gold/silver as 256 indices) or raw SGR passthrough; no detection, no NO_COLOR.
4. Fill: both. Foreground segments plus background-filled progress bar.
5. Separators: configurable `colors.separator` (default 37), plain-text separator; no powerline.
6. Neighbours: distinct hue per segment.
7. Light/dark: not present; bar text colour pair (black on filled, white on empty) chosen for the bar.
8. Glyphs: emoji icons by default (`⚡ ⎇ 📁 ⏱ ⏳ ✨ ✏️ 💰 💾`), `icons.enabled: false` for none, each icon overridable (`.icons.*`).
9. Notable: compact mode (`compact.enabled`, `maxWidth`), `deploy.sh`.
10. Customisation: JSON config with `order`, `sections`, `colors`, `icons`, `progressBar`, `tokens.warningThresholds`; three presets; `test.sh`.

## psoares-claude-plugins (psoares-statusline)
https://github.com/ps-dev-team/psoares-claude-plugins — stars 0
Plugin collection; styling is in `plugins/psoares-statusline/scripts/statusline.sh`.
1. Fixed palette, "Gruvbox Material Dark" (header comment), truecolor: model/context OK green `#8bd49c`, context warning orange `#e9ac67`, critical/error red `#d95468`, directory blue `#5396fd`, cost/tokens cyan `#70e1e8`, agent label purple `#b62d65`, branch and agent names purple2 `#c28dd9`, thinking effort teal `#44cfb2`, default text `#b7c5d3`, dim `(113,121,131)`. Context bar `█░` coloured by threshold (green/orange/red). Vim mode `[N]` orange, `[I]` green. Optional label coloured by `CLAUDE_LABEL_COLOR` (hex or raw ANSI).
2. Themes: one hard-coded palette; no theme switch.
3. Depth: truecolor `38;2` only; no detection or NO_COLOR.
4. Fill: foreground only.
5. Separators: `$SEP` string between parts (plain).
6. Neighbours: hue per segment.
7. Light/dark: dark palette only.
8. Glyphs: Nerd Font-style branch glyph in the branch part (private-use char in source).
9. Notable: nothing else.
10. Customisation: env `CLAUDE_LABEL_COLOR`; edit script.

## SlowpokeClaudeMod
https://github.com/PseudoMetalhead/SlowpokeClaudeMod — stars 0
not a Claude statusline: a Tamagotchi pet mod (`slowpoke-tamagotchi/hooks/register.tsx`) drawing a pixel-art pet band above the prompt; the statusline only shows a one-line summary.

## claude-fleet
https://github.com/verkyyi/claude-fleet — stars 2
Not really a Claude statusline: a tmux multi-session "fleet" manager. Its Claude statusLine script prints nothing; the context numbers are drawn by its own tmux top bar. Styling facts below are for that tmux surface.
1. Statusline script prints nothing (`conf/statusline.sh` header, and `bin/fleet-statusline.sh` header "PRINTS nothing"); it only stamps tmux options `@ctx_pct @ctx_band @model @effort`. `conf/statusline.sh:216-219` maps pct to band `ok|watch|handoff` (hand=80, warn=50). The drawn colour is in `bin/fleet-topbar.py:136`: `pcol = DIM if old else BAD if band=="handoff" or left<20 else WARN if left<=50 else OK` (by state/threshold, on context LEFT). Pane-border PR badge (`conf/tmux-attention.conf:170`): PR checks state -> red `#f7768e` bg / yellow `#e0af68` / green `#9ece6a`, text `#1a1b26`; active pane title bg `#7aa2f7`. Everything else is fixed per element.
2. One palette, Tokyo Night: `conf/fleet-palette.conf` defines `PAL_BG PAL_FG PAL_DIM PAL_BLUE PAL_GREEN PAL_YELLOW PAL_RED PAL_CYAN PAL_MAGENTA PAL_SEL` (semantic-ish role names, one hex each). No theme switching for the terminal side; users edit the file. The web console has light/dark/system (`extras/web-console/src/shared/theme.ts`, `data-theme` attribute, `extras/fleet-theme/theme.css`).
3. Truecolor hex in tmux `#[fg=#rrggbb]` (`tmux-attention.conf:170`); Python side reads the same palette. NO_COLOR or `FLEET_COLOR=0` honoured (`bin/fleet_view.py:674-675`). No depth downsampling found.
4. Both: pane-border badges are bg-filled with dark text; text elsewhere is fg on `PAL_BG`.
5. Separators: plain text `·`; no powerline.
6. Neighbours told apart by role colour and bold only (`tmux-attention.conf:170`); no alternation.
7. Fixed dark Tokyo Night text colours; contrast hand-picked (`#1a1b26` text on bright badges). No terminal-background adaptation (web console only).
8. Glyphs: `!`,`x`,`»`,`✓`,`∙`,`?` state glyphs, `FLEET_GLYPHS=ascii` swaps to letters (`fleet_view.py:638-666`). Chinese UI strings.
9. Stands out: `bin/fleet-palette-selftest.sh` and `fleet-theme-selftest.sh` fail CI if a hex colour is defined outside the one palette (`fleet-theme-selftest.sh` header: "colours ... defined in ONE place").
10. Config: palette conf file, env vars `NO_COLOR`, `FLEET_COLOR`, `FLEET_GLYPHS`; no TUI for colours.

## claude-code-status-line (wpfleger96)
https://github.com/wpfleger96/claude-code-status-line — stars 2
1. Per widget, user-assignable colour name, plus an `auto` colour resolved by state. `config/defaults.py`: model=cyan, directory=blue, git-branch=magenta, context-percentage/cost/lines-changed/session-id/session-clock have no colour set (widget default). `utils/colors.py:get_usage_color`: <50 green, <80 yellow, else red (context). `get_cost_color`: 0 grey, <$5 green, <$10 yellow, else red. `renderer.py:12-63` resolves `auto`.
2. No themes. Per-widget override model (`config/schema.py`: `WidgetOverride{color,bold,priority,enabled}`, `order`). Users define their own via `~/.config/claude-code-statusline/config.yaml` (`config/loader.py:26`, XDG_CONFIG_HOME).
3. Named ANSI 16 only: `COLORS` dict in `utils/colors.py:8-27` (black..white, bright_*, gray/grey, dim, bold). No 256/truecolor, no depth detection, no NO_COLOR found.
4. Foreground-only; no backgrounds.
5. Separators are a `separator` widget between widgets (`config/loader.py:121`, `renderer.py:_remove_orphaned_separators` drops orphans). Its glyph/colour: not read (widget file not found).
6. Neighbours: different colour names per widget; separators.
7. Not present.
8. Emoji used in widget text (scanner counted 21); no ASCII mode found.
9. Width-aware degradation: full -> compact -> two lines -> drop lowest `priority` widgets (`renderer.py:render_status_line_width_aware`).
10. YAML config, CLI commands in `cli/commands.py`, bootstrap installer; no env colour vars.

## emcc-claude-code-mods
https://github.com/Xabilimon1/emcc-claude-code-mods — stars 2
Mostly Claude Code mods (TUI panels); one shell statusline in `statusline/statusline.sh`.
1. Statusline: fixed per label plus thresholds. `statusline.sh:11-16` ANSI 16 codes. `pct_color` (lines 21-27): >=80 red, >=50 yellow, else green, applied to ctx/5h/7d bars (lines 54, 59, 68). model=CYAN, project=BOLD WHITE, labels `ctx:`/`5h:`/`7d:` GREY, dir DIM. Mod `mods/headspace/hooks/bar.ts:3-5` fixed hex per context category: system `#b0aea5`, rules `#d97757`, conversation `#6a9bcc`, large `#788c5d`, free/reserve `#b0aea5`.
2. No themes (a `catppuccin` string is only a VHS recording theme, `docs/media/tapes/theme.tape`).
3. ANSI 16 in shell (`\033[32m`...); hex in mods. No depth detection, no NO_COLOR.
4. Foreground-only.
5. Plain `" | "` separator, DIM GREY (`statusline.sh:124`).
6. Separators only plus label colours.
7. Not present.
8. Block bars `█░`; no icons.
9. Mod UI strings checked by `scripts/check-ui-strings.mjs` (not styling).
10. Edit the script; no config.

## claude-status-themes (XiaoHuZi-design)
https://github.com/XiaoHuZi-design/claude-status-themes — stars 2
1. Four separate scripts, each its own look. Fixed per element plus thresholds. `statusline-geek.sh:98-106` truecolor palette; git branch orange when dirty, green when clean (line ~113-118); memory % green <50, yellow <80, else magenta (121-130); CPU bar same thresholds (148-154); node version blue, separators gray, time/dir DIM. `statusline-cost.sh:64-81`: cost green <$5, orange <$20, else red; tokens cyan; duration green. `statusline-pixel.sh:132-170`: `[Lv.N]` gold, XP bar green, today cyan, runs orange, XP purple, git magenta. `statusline-xianxia.sh:204-210`: three pale truecolor tints for time/verse/dir.
2. "Themes" = the four scripts; `switch-theme.sh` rewrites `.statusLine.command` in settings.json via jq. No theme format; user edits scripts.
3. Truecolor `\033[38;2;R;G;Bm` only (`statusline-geek.sh:98`). No detection, no NO_COLOR.
4. Foreground-only.
5. Plain `|` in gray.
6. Different hue per segment, `|` separators.
7. Not present.
8. Emoji heavy (`⚡ 🔥 🌿 💾 🚀`, `💰 📊`); Chinese text; no ASCII mode.
9. Animation/theatrics: gamified XP/levels (pixel), time-of-day classical poem per minute (xianxia: `verse_index = hour*12+minute`).
10. Bash scripts and `switch-theme.sh [xianxia|geek|pixel|cost]`.

## claude-statusline-themes (xiaoming91024)
https://github.com/xiaoming91024/claude-statusline-themes — stars 2
1. Ten theme scripts, each with the same six slots: ctx (state), token, model, user. Slot colours fixed per theme; ctx by threshold. `themes/01-aurora-极光.sh:30-41`: ctx <50 bg 256-colour 24 (deep blue), 50-79 bg 57 (purple), >=80 bg 196 (red), all white text; token bg 20; model bg 22 (dark green); user bg 54 (dark purple). `03-neon`: all on black bg 16, fg 51 cyan / 226 yellow / 196 red for ctx, 201 pink tokens, 118 green model, 226 user. `05-dracula`: ctx bg 61 with fg 84 green / 214 orange / 196 red, token fg 212, model fg 141, user bg 84 black text. `07-mono`: greys 238-246 with white/black text alternating.
2. Ten bundled themes: aurora, minimal, neon, nord, dracula, retro, mono, candy, sunset, ocean (`themes/*.sh`); no theme format; one script per theme; `install.sh` copies the chosen one over the statusline script.
3. 256-colour indices (`\033[48;5;Nm`, `\033[38;5;Nm`) plus a few 16-colour. No detection, no NO_COLOR.
4. Mostly background-filled blocks (aurora, mono, candy), fg-only in neon.
5. No powerline arrows despite the "Powerline style" comment in aurora: blocks are separated by a single space; Nerd glyph icons inside blocks (`󰧑`).
6. Neighbours: different bg colour per slot (aurora: blue/deep-blue/green/purple); mono uses stepped greys with alternating text colour (white on 240, black on 244).
7. Text colour chosen by hand per bg (mono uses black text on lighter greys, `07-mono-水墨.sh:32-37`). No detection.
8. Nerd Font glyphs in several themes; `ctx:[███░░░]` bars; dracula uses `■□`. No ASCII mode.
9. Right-aligns the line by computing padding from `$COLUMNS` (aurora line ~97-100).
10. Interactive `install.sh` picker; edit the theme script.

## claude-auto-yes
https://github.com/xShiroeNguyenx/claude-auto-yes — stars 2
A VS Code extension (auto-approve + status bar items). Its Claude statusLine bridge (`media/statusline-bridge.cjs`) writes live usage to a file and prints one plain uncoloured line.
1. No colour: `buildStatusLine` (bridge lines ~72-80) joins `model 5h:N% 7d:N% ctx:N%` with spaces; no ANSI.
2. Not present (VS Code status bar item icon colour `#C15C3C` in `package.json:24` is the extension icon).
3. None.
4. Neither (plain text).
5. Space.
6. Not distinguished.
7. Not present.
8. None.
9. Scanner "gradient" hits are VS Code UI, unverified.
10. VS Code extension settings; `src/services/statuslineInstaller.ts` installs the bridge.

## claude-plugins (yonggao)
https://github.com/yonggao/claude-plugins — stars 2
1. One colour for everything: `statusline/statusline-metrics.sh:60-110` builds plain text parts (model, dir, git, `msgs/tok/cost`, `style:`, `load:`) joined with `" | "`; no ANSI codes found.
2. Not present. 3. No colour at all. 4. Plain text. 5. `" | "`. 6. Separators only. 7. Not present. 8. Emoji (counted 33, mostly in other skills; statusline itself plain). 9. The hex colours and gradients in the scan come from the PDF/image skills, not the statusline. 10. Edit the script.

## claude-cyberpunk-statusline
https://github.com/0xaissr/claude-cyberpunk-statusline — stars 1
1. Theme-role mapping per block, with threshold override. Theme JSON (`themes/neon-classic.json`) has `colors{bg_primary,bg_panel,accent_1,accent_2,accent_3,warning,alert,separator,dim}` and `blocks.<name>{color,bg,pl_bg,pl_fg}` that map each of model, context, rate_5h, rate_7d, directory, git, time, cost, tokens, session, last_chat to a role (neon-classic: model accent_1, context accent_2, rate_5h accent_3, rate_7d accent_1, directory accent_2, git accent_1, time accent_1, cost accent_3). `statusline.sh:88-93` `neon_colour`: pct >=80 -> `alert`, >=50 -> `warning`, else the block's own accent. Rainbow mode ignores the per-block `pl_bg` and cycles `accent_1,2,3` by index within the line (`statusline.sh:862-870`).
2. ~13+ bundled JSON themes: blade-runner, catppuccin-mocha, dracula, gruvbox-dark, midnight-phantom, neon-classic, nord, one-dark, rose-pine, synthwave-sunset, retrowave-chrome, terminal-glitch, tokyo-night (names seen); `themes/custom-example/` shows a theme dir with its own `render.sh`. Format: semantic palette roles + per-block role mapping + three symbol sets. Users can add themes (custom-example) and `configure-theme.sh`; `docs/all-themes.html` gallery.
3. Truecolor hex only (`hex_to_fg/bg` -> `\033[38;2;..`, `statusline.sh:68,73`). No depth detection or NO_COLOR found.
4. Both: classic mode bg_panel cells with fg accent; rainbow/powerline mode full bg fill with `pl_fg` text.
5. Config `style`: `classic` (separator char `cfg_separator`, default `│`, coloured `separator`) or `rainbow` (powerline); `head`/`tail` shapes sharp E0B0/E0B2, slanted E0BC/E0BA, rounded E0B4/E0B6, flat (`statusline.sh:196-213`). Arrow fg = previous bg, arrow bg = next bg (lines 877-880).
6. Rainbow: three accents cycled by position. Classic: per-block role colours plus separators.
7. Text colour is hand-set per theme `pl_fg` (default `bg_primary`); no adaptation.
8. Three symbol sets per theme: `nerd`, `unicode`, `ascii` (`symbols` in theme JSON); `show_icons` toggle.
9. Burn-rate block, Codex adapter, bar glyphs configurable (`bar_filled`, `bar_empty`).
10. `~/.claude/cyberpunk-statusline` config JSON (`theme`, `symbol_set`, `spacing`, `separator`, `style`, `head`, `tail`, `bar_width`, `blocks`, `blocks_line2`, `time_format`), slash command `/cyberpunk-statusline configure`, `configure-theme.sh`.

## claude-mod-todo-list
https://github.com/0xnicholasy/claude-mod-todo-list — stars 1
not a Claude statusline: a Claude Code mod (todo-list panel plugin). Only styling note: one accent colour, `hooks/accent.ts` accepts `#rrggbb` or a named colour, resolved as saved `/todo color` > `accentColor` plugin option > default.

## grav-bar
https://github.com/AABelkhiria/grav-bar — stars 1
1. Theme role mapping plus a usage gradient. `src/theme.rs:Theme{user,path,branch,model,dim,gradient}`: user, directory path, git branch, model each fixed to one role colour; `dim` for labels and separators; context % and gauge cells coloured by `Theme::grad_color(pct)`. `render.rs:51-77`: separator ` · ` in dim, `ctx` label dim, percent on gradient.
2. Seven bundled (`theme.rs:THEMES`): default (sky/lavender/pink/indigo/slate), classic, nord, catppuccin-mocha, gruvbox, dracula, tokyo-night. Format: 5 named colours + gradient (Rust struct, compiled in). Users cannot define their own (only select by name).
3. Truecolor `Rgb` or 16-colour `Ansi(n)` per colour (`theme.rs:Color`); `classic` is the 16-colour fallback with thresholds green <50, yellow <80, red (`Gradient::Thresholds`). No automatic depth detection seen (user picks `classic`); env.truecolor hits are test strings. No NO_COLOR.
4. Foreground-only.
5. Plain ` · ` in dim (`render.rs:52`).
6. Different hue per segment role; no alternation.
7. Not present.
8. Box-drawing/block chars for the gauge (`█`); no emoji or Nerd glyphs.
9. Percent colour is a linear RGB interpolation across 3 stops (blue->purple->pink in default; green->yellow->red in nord/gruvbox/dracula/tokyo/catppuccin) at 0/50/100 (`theme.rs:grad_color`), per gauge cell too. `docs/themes.png` gallery.
10. `--theme <name>` or `GRAV_BAR_THEME`, `--list-themes`, no config file (`main.rs:23-25,78-85`).

## MIT-ccstatusline (aavva)
https://github.com/aavva/MIT-ccstatusline — stars 1 — FORK OF sirmalloc/ccstatusline
Differences: none. `gh api compare` shows 0 commits ahead and 218 behind the parent, no differing files; README is the parent's. See the ccstatusline-gradient section for the parent's styling code (the parent's `colors.ts`, `powerline.ts` and `renderer.ts` are shared).

## adhanline
https://github.com/abdalhalimalzohbi/adhanline — stars 1
A prayer-times statusline (Hijri date, prayer countdown).
1. By role + state tier. `src/status/theme.ts` roles: date, passed, upcoming, calm, amber, now, countdown, divider, location, dhikr, grace, each a list of SGR codes. Tier by minutes to next prayer (`urgency.ts`: <=0 now, <=`urgency.amberMinutes` amber, else calm). `line1-prayers.ts:29-38`: next prayer painted `calm`/`amber`/`now` tier, countdown role `countdown`, passed prayers `passed` (dim), upcoming `upcoming`.
2. Three themes: `minimal`, `neon`, `powerline` (`theme.ts:THEMES`), semantic role -> SGR codes. Users pick by name (`display.theme`), cannot define new ones.
3. ANSI 16 SGR codes only (e.g. neon 95/96/92, `theme.ts:30-41`). NO_COLOR honoured (`src/util/color.ts:4`: `colorEnabled = !process.env.NO_COLOR`).
4. Both: `powerline` theme uses bg codes (`calm: [1,44,97]` white on blue, `amber: [1,43,30]` black on yellow, `now: [1,41,97]` white on red, `date: [100,30]`); minimal/neon fg-only (neon `now: [1,41,97]` red bg).
5. Divider glyph configurable (`display.divider`, `"space"` option), painted with `divider` role; no real powerline arrows in the "powerline" theme (bg fills only).
6. Tier colours and divider; roles differ.
7. Not present (fixed ANSI 16 follow terminal palette).
8. Emoji per next prayer (`icons.ts`: 🌅 ☀️ 🌤️ 🌇 🌙, `🔴 ... NOW`, `🕌`); Arabic reshaping (`util/arabic.ts`).
9. Pre-shapes Arabic into presentation forms (render.ts) since Claude Code does not shape it.
10. JSON config via `adhanline config` interactive CLI; `adhanline test`, `tmux`, `tasbih`, `doctor` commands.

## ai-workbench
https://github.com/abhibansal60/ai-workbench — stars 1
1. Fixed per segment plus threshold. `.claude/skills/ai-workbench/assets/statusline.sh:6-11,29-34`: directory soft_green `#00ff9f`, git branch cyber_purple `#9d4bff` (with `Ψ`), model neon_cyan `#00fff9`, separators/tokens muted_grey `#5c5c6e`. `bar_color` (102-111): <70% healthy colour (ctx cyan, 5h/7d green), 70-89 amber `#ffb000`, >=90 red `#ff003c`.
2. One palette mirrored from the author's starship/Ptyxis/zellij config (`ai-workbench.theme` is a btop-style theme file for another tool). No selectable themes.
3. Truecolor `38;2;R;G;B` only (sl.sh:29-34). No detection, no NO_COLOR.
4. Foreground-only.
5. ` │ ` in muted grey (sl.sh:36).
6. Hue per segment plus separators.
7. Not present; palette assumes a dark background.
8. Unicode `Ψ`, bars `▓░`; no emoji or Nerd.
9. 5h/7d segments omitted when the payload lacks `rate_limits`.
10. Edit the script.

## claude-timeline
https://github.com/abnersajr/claude-timeline — stars 1
not a Claude statusline: web viewer/CLI for session timelines; `setup` installs a cost-capture wrapper that delegates to the user's original statusLine (`packages/extractor/src/cli.ts:172-176`) and adds no styling. CLI output uses chalk; web UI has a light/dark theme provider.

## dev-environment (ahmed-mili)
https://github.com/ahmed-mili/dev-environment — stars 1
A personal dotfiles repo; its statusline is a Rust binary (`claude-code/statusline-rs/src/main.rs`, 3320 lines, port of `statusline.ps1`), Windows-first.
1. Mix of fixed, state and position. Line 1 is a gradient banner: path segment bg interpolated per character between stops `BANNER_STOP_1..3` (`main.rs:1393-1400`, deep navy `(20,28,42)` -> navy `(27,46,74)` -> blue `(33,66,112)`), per-char loop at ~1620-1655; model block on `SEG_BG (22,26,34)`; git branch/dirty/sync have fixed fgs (`DIRTY_FG` salmon, `SYNC_FRESH` gold, `SYNC_FADED` desaturated when fetch failed). Context counter and usage bars by threshold: `usage_palette` (1463): fill blue `(42,120,214)` <75%, amber `(250,178,25)` >=75, red `(208,59,59)` >=90, tracks dark tints; `LOAD_*` consts for ctx (blue <70, amber <90, red), stale variants dimmed to 0.7. Permission mode backgrounds fixed per mode (`MODE_BYPASS_BG`, `MODE_PLAN_BG`, `MODE_ACCEPT_EDITS_BG`, `MODE_DONT_ASK_BG`, `MODE_AUTO_BG`, 1417-1425). Effort level: ANSI bright codes matching Claude Code's own indicator colours (low 93, medium 92, high 94 bold; xhigh 95; max 91), main.rs:167-200.
2. No themes. A palette copied from claude.ai's usage gauges and Claude's diagrams theme (comments 1380-1460). `claude-code/themes/sombre.json` is a Claude Code UI theme (`base: dark-ansi` plus rgb overrides), not a statusline theme.
3. Truecolor `38;2`/`48;2` (`rgb()`/`bg()` main.rs:30,44) plus ANSI bright for effort. No detection, no NO_COLOR.
4. Both: banner bg gradient with fg text; gauges use bg-filled cells on a track.
5. Single Powerline chevron `U+E0B0` only for line-1 transitions; final chevron takes the model block colour (comments 1730-1737).
6. Position gradient across the path banner; blocks differ by bg.
7. Comments discuss contrast targets (text 4.5 target on darkest stop, `SYNC_FADED` desaturated rather than darkened for contrast) but nothing computed at runtime.
8. Nerd Font device icon (desktop/laptop by battery presence), OSC 8 hyperlink around the path banner.
9. Stale data dimmed; Arabic BiDi run handling; refreshInterval 1 Hz note.
10. Edit constants; no config file seen.

## claude-usage-status (AjinkaBhosale)
https://github.com/AjinkaBhosale/claude-usage-status — stars 1
1. Fixed per element plus one threshold. `statusline.sh:44-48`: context bar GREEN <70, YELLOW 70-89, RED >=90. Model `[..]` CYAN, git dirty `●` YELLOW, untracked DIM, ahead GREEN, behind RED, worktree DIM, line 2 date BOLD CYAN, session/today/MTD cost YELLOW, tokens CYAN, separator DIM `┃` (lines 79-85, 189-237).
2. No themes.
3. ANSI 16 (`\033[3Xm`). No detection, no NO_COLOR. (Hex colours in the scan belong to the HTML dashboards/reports, not the statusline.)
4. Foreground-only.
5. DIM `┃`.
6. Labels dim, values coloured; separators.
7. Not present.
8. Emoji `📁 ⏱ ⚡`, block bar `█░`.
9. Two-line output; much of the repo is reports (dashboard.py etc.).
10. Slash-less scripts (`statusline-toggle.sh`, `statusline-show.sh`); edit script.

## ccstatusline-gradient (akkaz)
https://github.com/akkaz/ccstatusline-gradient — stars 1
Standalone copy (not a GitHub fork; `fork:false`) of sirmalloc/ccstatusline plus a gradient layer. Parent baseline is documented here because the code is shared.
1. Parent: each widget has user-set `color` and `backgroundColor` (per-widget fixed); widgets supply a default fg via `getDefaultColor()` (`renderer.ts:244-260`). In Powerline mode with a theme, colour is by position: `bg[widgetColorIndex % theme.bg.length]`, `fg[...]` (`renderer.ts:303-305`); merged widgets share one index. Added by this copy: `color: "gradient:<preset>|RRGGBB-RRGGBB..."` sweeps per character (`colors.ts:185-192`, `applyGradientToText`), and `dynamic: true` samples one colour from the ramp by the widget's value 0-100% (`colors.ts:resolveDynamicColor`, ~330-350; solid base colour auto-derives a pale->deep ramp via `deriveRampFromSolid`). Default preset `akkaz`: indigo->amber identity row, bars coloured dynamically (README 87-95).
2. Parent powerline themes (`colors.ts:403-560`): custom, nord, nord-aurora, monokai, solarized, minimal, dracula, catppuccin, gruvbox, onedark, tokyonight. Format: per-level (1=ansi16, 2=ansi256, 3=truecolor) `{fg: string[5], bg: string[5]}` cycled by widget position (not semantic roles). This copy adds 13 gradient presets (`gradient.ts:35-48`: atlas, cristal, teen, mind, morning, vice, passion, fruit, instagram, retro, summer, rainbow, pastel) and 7 signature presets (`presets/*.json`, `--onboard --preset`). Users define their own: custom hex gradients, `custom` theme, saved settings JSON.
3. Named ANSI 16, `ansi256:N`, `hex:RRGGBB` (`bgToFg` handles all). `settings.colorLevel` 0-3 sets `chalk.level` (`ccstatusline.ts:110`); gradients degrade: truecolor sweep, ansi256 quantized, ansi16 first stop only (`colors.ts:192,215-225`). Auto-detection/NO_COLOR: not found in the files read (colorLevel is a setting).
4. Both: foreground colours and `backgroundColor`; powerline mode is bg-filled.
5. Powerline arrows/caps selectable (`PowerlineSeparatorEditor.tsx:54-71`: E0B0, E0B2 triangles, E0B4/E0B6 round, E0B8/E0BA/E0BC/E0BE diagonal); arrow fg = previous widget bg (`renderer.ts:602-641` use `bgToFg(widget.bgColor)`); non-powerline separators are widgets with own colour (renderer ~1066-1087).
6. Powerline themes: five rotating bg colours by position. Non-powerline: user-assigned colours plus separators.
7. Theme fg colours are picked per bg by the theme author (dark text on light pastels); no runtime contrast computation.
8. Nerd Font icons (`nerd-icons.ts`), emoji, powerline glyphs.
9. Gradient across several widgets by splitting stops at seams (README 76-82); ink TUI colour menu with `g` and `y` keys; `--onboard` wizard with live preview.
10. Ink TUI configurator, settings JSON (`~/.config/ccstatusline/settings.json`), CLI `--onboard --preset <name>`, preset files `presets/*.json`.

## claude-code-statusline-designer (aleslanger)
https://github.com/aleslanger/claude-code-statusline-designer — stars 1
1. Per segment colours stored in the config; status segments by state. `contrast.py:11-12`: simple segments user_host, dir, pr, session, model, mode, output_style, lines, duration have fixed `{fg,bg}`; git has `bg_clean`/`bg_dirty`; effort has `colors` per level; limits/cost/cache/thinking have `colors` per state; context has `thresholds [(limit,bg)...]` plus an optional truecolor gradient bar (`config.py:179-182`, `render.py:65` checks `$COLORTERM` truecolor|24bit). Presets use "the conventional green -> amber -> red progression in every theme" (`presets.py` header).
2. 22 bundled schemes: 11 dark (`presets.py`: agnoster, minimal, mono, neon, dracula, nord, gruvbox, solarized, catppuccin (Mocha), tokyo-night, onedark) + 11 `-light` variants (`presets_light.py`: Alucard, Snow Storm, Latte, Tokyo Night Day, One Light...). Format: per-segment xterm-256 codes (no semantic roles). Users save/import/export own schemes (`claude-style scheme import|export`, `~/.config/claude-style/schemes/`).
3. xterm 256 codes everywhere (`palette.py`); hex input is mapped to nearest cube/gray code (`nearest_code`, skipping 0-15). Truecolor used only for the context gradient bar when `COLORTERM` allows. NO_COLOR: not found.
4. Both: `separator: "powerline"` gives bg-filled segments; `plain` gives fg-on-terminal-background (`contrast.py:_plain_pairs`).
5. Powerline arrow U+E0B0 plus thin U+E0B1 between two equal backgrounds; unicode set uses `▌` and `│`; ascii set none and `|` (`glyphs.py:30-52`).
6. Different bg per segment per scheme; thin arrow when two neighbours share a bg.
7. Strong: `palette.py:contrast_fg` picks black or white text by luminance (>140), `contrast.py` checks WCAG ratios of every text/bg pair (min 3.0 text, 1.4 for subtle empty bar blocks) against assumed dark (234) and light (231) terminal backgrounds; light schemes exist for light terminals; `gradient_peak` lowered for light terminals.
8. Glyph modes `nerdfont | unicode | ascii` (`glyphs.py:GLYPH_MODES`).
9. Curses TUI with a 256-colour palette picker whose preview follows the hovered colour; readability warnings; theme gallery PNG/SVG.
10. `claude-style` CLI (`install`, `preset <name>`, `scheme import/export`, `show`, `menu [--classic]`), config under `~/.config/claude-style/`; generates a bash statusline script `~/.claude/statusline-command.sh`.

## claude-statusline (alexander-rehm)
https://github.com/alexander-rehm/claude-statusline — stars 1
1. Threshold bars only. `statusline-command.sh:7-27`: `colored_bar PCT YELLOW_AT RED_AT` green below, yellow up to, red above; context thresholds 50/70, 5h/7d 50/80 (line ~85-92). Labels DIM; folder, model and emojis uncoloured.
2. No themes. 3. ANSI 16 (`\033[32m` etc.); no detection, no NO_COLOR. 4. Foreground-only. 5. Two spaces between segments, no separators. 6. Emoji prefixes (`📂`, `★`) and DIM labels. 7. Not present. 8. Emoji plus `█░` bar. 9. Fetches plan usage from the OAuth usage endpoint cached 60 s (pre-`rate_limits` era). 10. Edit the script.

## claude-plugins (amims71)
https://github.com/amims71/claude-plugins — stars 1
1. No colour: `plugins/credit-gate/scripts/statusline.sh` prints `5h: N%  7d: N%` via jq with no ANSI; with an argument it runs the user's own statusline and shows that instead (lines 15-23). The hex colours in the scan are in the ntfy/discord notification code, not styling of a statusline.
2-10. Not present (themes, depth, fill, separators, contrast, glyphs); customisation is passing your own command as the first argument.

## claude-moodline
https://github.com/amirhoseinhematloo/claude-moodline — stars 1
1. Theme-defined colours per part, plus a four-level mood by percentage. `src/render.js:215-273` each theme has `colors{model,effort,branch,moods[4]}`; `moodIndex(p)` (283): >=90 -> 3, >=70 -> 2, >=40 -> 1, else 0, selecting `moods[i]` for ctx/5h/7d bar and percent (`colorFor`, 376). Mood theme: model cyan, effort magenta, branch blue, moods green/green/yellow/red. Minimal theme: colour only on warnings (moods none/none/yellow/red), model bold, effort dim.
2. Nine bundled themes (keys of `THEMES`): mood, minimal, space, nature, jurassic, game, matrix, one-piece, god-of-war. Format: glyph set + ANSI colour names for parts + waiting text. Not user-definable (select by name).
3. ANSI 16 names (`ANSI` map, render.js:12-24; includes bright variants). NO_COLOR honoured plus `--no-color` (`bin/claude-moodline.js:27`).
4. Foreground-only.
5. Plain text separators between items (not colour-driven).
6. Emoji/glyph prefixes and colour per part.
7. Not present.
8. Emoji per theme with a plain-ASCII fallback per theme (`--ascii`, `CLAUDE_MOODLINE_ASCII=1`); mood faces by level.
9. Mood faces/animals/seasons per percentage ("moods run through the seasons to a wildfire", render.js:98); wraps segments onto extra lines on narrow terminals; per-item `--no-bar`.
10. CLI flags `--theme=NAME`, `--ascii`, `--no-color`, `--no-bar[=ITEMS]`; env `CLAUDE_MOODLINE_THEME`, `CLAUDE_MOODLINE_ASCII`, `CLAUDE_MOODLINE_NO_BAR`; subcommands `install`, `preview`, `themes`.

## claude-usage-meter
https://github.com/Anandprasun/claude-usage-meter — stars 1
Browser extension, macOS menubar plugin and a Claude Code statusline; styling is in `claude-code/usage-statusline.py`.
1. Threshold: `colour_for(p)` (line 87): >=ALERT_AT(90) red, >=WARN_AT(75) yellow, else green, applied to `ctx N%`, `5h` bar and `wk`; model bold; reset text dim; pace warning bold yellow `⚠`.
2. No themes. 3. ANSI 16 SGR (`\033[{code}m`); NO_COLOR honoured (line 23); thresholds via env `CLAUDE_USAGE_WARN`/`CLAUDE_USAGE_ALERT`. 4. Foreground-only. 5. Plain ` · `. 6. Separators only. 7. Not present. 8. `█░` bar, `⚠`. 9. Burn-rate "limit in ~Xh" prediction. 10. Env vars only.

## spider-claude-mods
https://github.com/anderson-spider/spider-claude-mods — stars 1
not a Claude statusline: Claude Code mods (a session HUD panel and a file explorer). Notable for the question: `plugins/session-hud/hooks/palette.ts` maps semantic styles (`plain, strong, secondary, model, success, warning, danger, sent, bar, track, tick, frame`) either to a fixed dark-terminal hex palette (`model #d97757`, `success #4fb383`, `warning #e5c07b`, `danger #e06c75`) or to Claude Code's own theme keys (`claude`, `success`, `warning`, `error`, `subtle`, `inactive`), choosing by the host theme name (`paletteOf`: `auto`/`dark*` non-ansi -> fixed palette, else theme keys).

## claude-status-pet
https://github.com/angbo-sys/claude-status-pet — stars 1
A virtual-pet statusline (pet animation, mood, XP).
1. Palette role mapping with fixed role colours. `scripts/pet-lib.js:887-938` `PALETTES` roles pet, label, mood, tool, muted, success, error, flair, each an SGR string; palettes: `mono` (all `0`), `classic` (ANSI 16: pet 36, label 33, mood 35, success 32, error 31), `soft` (256-colour `38;5;110` etc.), `terminal` (bright 16), `alert`. A pet can override with `pet.color`.
2. Five palettes plus five themes (`scripts/pet-theme.js`: focus, cute, dense, night, minimal) that bundle palette, display mode, which segments show, quiet hours. Users select via `pet-theme.js <name>`/config.
3. ANSI 16 and 256-colour indices; `NO_COLOR` honoured (`pet-lib.js:1100`) and `config.colors:false`. No truecolor, no detection.
4. Foreground-only.
5. `style: "powerline"` (theme `dense`) only changes the separator to a space (`pet-statusline.js:359`); otherwise `config.separator` default ` · `.
6. Role colours and separators.
7. `terminal` palette and `mono` as plain options; no automatic adaptation.
8. Pet ASCII/emoji frames; quiet hours.
9. Animation frames chosen per state, random events and flair, achievements and growth (`pet-growth.js`).
10. JSON config and many `pet-*` CLI scripts, env `CLAUDE_STATUS_PET`.

## claude-code-multi-account-statusline (ArielRi)
https://github.com/ArielRi/claude-code-multi-account-statusline — stars 1
An installer that configures sirmalloc/ccstatusline with a fixed layout and a custom usage widget; plus an Antigravity CLI statusline.
1. Fixed per widget, Nord-flavoured. `ccstatusline-install.sh:365-376` writes ccstatusline settings: model fg `#ECEFF4` on bg `#BF616A`; context-percentage-usable `#2E3440` on `#EBCB8B`; usage custom-command `#FDF6E3` on `#5E81AC`; session-clock `#2E3440` on `#A3BE8C`; cwd (second line) `#ECEFF4` on bgMagenta. `AntigravityCLI/agystatusline.js:13-19` fixed truecolor constants (red, beige, blue, green, purple) per segment.
2. `powerline.theme: "custom"` (explicit colours); no bundled themes of its own.
3. `hex:` truecolor via ccstatusline `colorLevel: 3` (install.sh:375); `agystatusline.js` raw `38;2`/`48;2`. Installer itself honours NO_COLOR for its output (line 11) and forces `FORCE_COLOR=0` when capturing node output (385-391).
4. Background-filled blocks (powerline).
5. Powerline arrow U+E0B0 as both separator and end cap (`"separators":["$SEP"]`, `endCaps`); `agystatusline.js:165-179` arrow fg = previous bg, bg = next bg.
6. Different bg colour per widget plus arrows.
7. Text colour hand-picked per bg (dark `#2E3440` on yellow/green, light on red/blue). No adaptation.
8. Powerline needs Nerd Font; installer installs Hack Nerd Font on macOS (README, install.sh:150).
9. Usage widget differs for Pro/Max (5h/7d) and Enterprise ($ cap).
10. Interactive installer; settings JSON for ccstatusline; per-account `CLAUDE_CONFIG_DIR` aliases.

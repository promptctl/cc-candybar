## sy-stef/session-cycle
https://github.com/sy-stef/session-cycle — stars 0
Not a terminal statusline: a Claude Code mod (plugin) that draws a one-row status image (project name, context bar, weekly %, prompt-cache minutes) in the app's band above the prompt, plus a handoff list. Styling notes for what it does draw:
1. Fixed per element, one threshold: bar fill class `f` grey by default, `a` amber at ctx >= 55, `r` red at ctx >= 75 (`hooks/row.mjs:63-70` area, `ctxPct >= 75 ? 'r' : ctxPct >= 55 ? 'a' : 'f'`). Labels are muted (`m`), values strong (`t`). A single brand dot `ACCENT = '#b0587d'` (`row.mjs:6`).
2. Themes: no named themes. Two hard-coded palettes `LIGHT` and `DARK` as CSS-class fills (`row.mjs:11-12`); the app theme is read from the host config key `theme` (`register.mjs:111-115`, "dark"/"light" substring); otherwise `@media (prefers-color-scheme: dark)` (`row.mjs:16`). Users cannot define their own.
3. Hex fills in SVG only. No ANSI, no depth detection, no NO_COLOR.
4. Fill: foreground-style fills on a transparent SVG ("Transparent, so the app's own rounded band is its plate", `row.mjs:2`); the bar track is a rect at 20%-36% opacity grey.
5. Separators: none (gaps by x-offset, `wk.w + 18`). The handoff panel uses a round border `borderStyle: 'round', borderDimColor: true` (`register.mjs:542`).
6. Neighbours: distinguished by muted-label / strong-value weight, not hue.
7. Light/dark: yes, as in point 2; amber/red are re-picked per mode (`#c77c1e` light vs `#f0a43a` dark).
8. Glyphs: no icons; one circle. Text fallback `Text({dimColor:true})` when no SVG support (`register.mjs:475`).
9. Cache countdown is drawn with SVG `<set>` visibility timers, one text per minute (`row.mjs:46-60`), so it ticks without redraws. No gradients.
10. Customisation: none visible for colours; theme follows the host app.

## syntaxerror00100/claude-code-statusline
https://github.com/syntaxerror00100/claude-code-statusline — stars 0
1. Mixed. Fixed per segment (`statusline.sh:409-420`): brand mark `PURPLE` (#7266EA truecolor, else magenta, `:48-51`), model `CYAN`, branch `GRAY`, folder `DIRCOL` (#8FB8FF truecolor else `\033[94m`, `:55-57`), worktree/agent tag `YELLOW`. By state/threshold: effort word low=gray, medium=green, high=yellow, xhigh=magenta, max=red (`:168-173`); context % and tokens green <70, yellow >=70, red >=90 (`:214-227`); rate limits gray, yellow when pace is ahead of the window, red >=80 (`:381-395`); `+N/-N` green/red.
2. Themes: not present. One hard-coded palette.
3. ANSI 16 named escapes (`:37-44`) plus truecolor only if `COLORTERM` is truecolor/24bit (`:27`); 16-colour fallback for every truecolor value. NO_COLOR: not present.
4. Foreground-only text on the terminal background.
5. Separators: plain ` │ ` or two spaces (powerline mode `SEP="  "`, `:77-91`); `CLAUDE_STATUSLINE_POWERLINE=1` switches symbol set but segments stay un-filled. Separator uncoloured.
6. Neighbours distinguished by different hues per segment and the `│` separator.
7. Light/dark adaptation: not present. DIM/GRAY used for quiet text.
8. Three symbol sets: ASCII (`CLAUDE_STATUSLINE_ASCII=1`, `<>`, `#`/`-` bar), Nerd Font (`CLAUDE_STATUSLINE_NERDFONT=1`), default Unicode (`◆`, `⎇`, `▲`) (`:60-91`).
9. Truecolor per-cell gradient on the context bar: 10 hard-coded RGB stops green -> yellow -> orange -> red (`GRAD_R/G/B`, `:191-193`), each filled cell takes its stop by position, empty cells `38;2;60;60;60 ░`; 16-colour mode uses one bar colour by percentage (`:214-221`).
10. Customisation: env vars only (`CLAUDE_STATUSLINE_ASCII`, `_NERDFONT`, `_POWERLINE`, `COLORTERM`); `install.sh` / `install.ps1` for Windows.

## synx33/statusdeck
https://github.com/Synx33/statusdeck — stars 0
1. Theme role mapped to segments: `scripts/statusline.sh:14-31` defines 8 roles FRAME/ACC/OK/WARN/CRIT/SEC/GREY/FG aliased to PINK/CYAN/LIME/AMBER/RED/VIO/WHITE. Segments: row labels `ACC` bold; model `FG` bold; effort and folder `SEC`; git branch `OK`; cost `WARN`; session time `SEC`; tokens in `ACC`, out `FRAME`; cache `ACC`/OK/WARN; frame `│ ╭ ╰` in `FRAME`. By threshold: `color_for` returns OK <50, WARN 50-79, CRIT >=80 (`:41-42`), used by context, 5h and weekly bars, and per cell inside the bar (cell colour from its own position, `:47`).
2. Seven bundled themes via `STATUSLINE_THEME`: tokyo (default), catppuccin, dracula, nord, gruvbox, neon, slate (`:8-27`), each 8 truecolor roles as `c R G B`. Semantic-role format. Users edit the case block in the script; `skills/theme/SKILL.md` switches by `sed` on the default.
3. Truecolor only (`c()` emits `38;2;r;g;b`, `:12`). No depth detection, no NO_COLOR.
4. Foreground-only.
5. Separators: box-drawing frame (`╭─ ╰─`, left `│` gutter), no inter-segment separators; each fact is a labelled row (BRAIN, WHERE, MEMORY, 5H LIMIT, WEEKLY, CACHE, SESSION).
6. Neighbours distinguished by row labels and per-role hues.
7. Light/dark: not present; `slate` is a muted dark theme.
8. Glyphs: `■ ·` bar cells, `⚡`, `⏱`, `↑ ↓`; a branch icon. No ASCII mode.
9. Per-cell threshold bar (each filled cell is OK/WARN/CRIT by its own position, so a full bar shows green->amber->red); dim `← hint` annotations beside each row (`hint()`, `:61`).
10. Customisation: `STATUSLINE_THEME` env, `STATUSLINE_DEBUG`, edit script; `/statusdeck:theme` skill.

## sytang9/cc-usage-bar
https://github.com/sytang9/cc-usage-bar — stars 0
1. Fixed per label plus threshold per meter (`statusline-usage.sh:13-23`): label 5H = 256-colour 110 soft blue, WK = 176 soft magenta, CTX = 246 grey; email 250, org/model/percentages/reset text 245 (`COLOR_DIM`). Capsule fill colour by meter's own percent: <60 sage 108, 60-85 amber 179, >85 red 167 (`color_for`, `:36-45`, `PCT_OK_MAX=59`, `PCT_WARN_MAX=85`).
2. Themes: not present; constants block at top is the only customisation.
3. 256-colour index (`\033[38;5;Nm`, `:86`, `:145`). No depth detection, no NO_COLOR.
4. Foreground-only.
5. Separators: group separator is dim middot with 3-space padding (`GROUP_SEP`, `:213`); items inside a group are one space apart. Capsule "wall caps" are glyphs in `COLOR_TRACK` 240.
6. Neighbours: by proximity grouping and distinct label hues, not separators.
7. Light/dark: not present (muted greys assume dark).
8. Glyphs: 8-segment capsule meter with wall caps, `↻` reset marker; no ASCII fallback seen.
9. Also ships a VS Code extension (`vscode/`, webview panel) and a `ccswitch` account switcher; two-row layout (identity row, meters row).
10. Customisation: edit readonly constants in `statusline-usage.sh`; `install.sh` / `uninstall.sh`.

## t968rs/operator-straps
https://github.com/t968rs/operator-straps — stars 0
Not a single statusline: a monorepo of Claude Code mods/plugins (harness hooks, git-status, band-line). Styling-relevant parts only:
1. `plugins/band-line/hooks/band.tsx:25` colours the whole banner text with a host theme role: `needsAttention(git) ? 'warning' : 'subtle'`. One role, chosen by state. 
2. Themes: the host app's own theme roles (`warning`, `subtle`); none bundled. A `ccstatusline.defaults.json` ships for the separate ccstatusline tool (`plugins/banner-status/skills/setup-statusline/`): named colours per widget (git-branch magenta, ahead-behind yellow, thinking-effort brightCyan, context-length brightBlue), `colorLevel: 2`.
3. Role names resolved by the host; ccstatusline file uses named ANSI. No NO_COLOR handling in the files read.
4. Foreground-only; ccstatusline `powerline.enabled: false`.
5. Separators: ccstatusline `separator` widgets (plain, `character: " "` or `"-"`); powerline separator list contains one glyph but disabled.
6. Neighbours: plain separators and a few named hues.
7. Light/dark: delegated to the host's theme roles.
8. Glyphs: one powerline glyph in the schema; nothing else seen.
9. Nothing else styling-related.
10. Customisation: ccstatusline JSON defaults; plugin config via host.

## taegtae/dotfiles
https://github.com/taegtae/dotfiles — stars 0
Dotfiles repo; the only styling file is `.claude/statusline-command.sh`.
1. Fixed per segment (`:55-72`): model `\033[36m` cyan, "effort:" label `\033[35m` magenta, output-style name uncoloured. By threshold on context bar: <=50 green `\033[32m`, <=75 yellow `\033[33m`, else red `\033[31m` (`build_bar`, `:49-55`).
2. Themes: not present.
3. ANSI 16 named escapes. No depth detection, no NO_COLOR.
4. Foreground-only.
5. Separators: plain `  |  ` uncoloured.
6. Neighbours: cyan model, magenta label, coloured bar, plain `|`.
7. Light/dark: not present.
8. Glyphs: `█` `░` bar in brackets, ASCII otherwise.
9. Nothing else (shells out to `python` for every JSON field).
10. Customisation: edit the script.

## takumi00nine/claude-codex-usage
https://github.com/Takumi00Nine/claude-codex-usage — stars 0
A tmux status-right segment (fed by a LaunchAgent cache) showing Claude and Codex usage; not a Claude Code statusline command.
1. Fixed per service label: CL = `colour39`, CX = `colour213` (`tmux-usage.sh:196-198`, passed to `service_segment`); label bold in that colour. By threshold on each gauge and percentage: >=80 `colour197`, >=50 `colour214`, else `colour114` (`pcolor`, `:60-71`); unknown `colour244`. Text `colour252`, empty cells `colour238`, secondary text `colour244`, divider `colour240`, `EXP` amber, `ERR` red (`:151-177`).
2. Themes: not present.
3. tmux `colourN` 256 indices. No depth detection, NO_COLOR not present.
4. Foreground-only (`#[fg=...]`).
5. Separators: ` | ` in `colour240` between services.
6. Neighbours: differentiated by the two service hues and the divider.
7. Light/dark: not present.
8. Glyphs: gauge bar cells (width `CELLS=8`), `↻` reset countdown, `(N分前)` stale marker; bars dropped under `USAGE_NARROW_BELOW=100` columns (`config.example.sh`).
9. Nothing else.
10. Customisation: `~/.config/claude-codex-usage/config.sh` (intervals, thresholds, `CELLS`, `USAGE_NARROW_BELOW`); colours are not configurable.

## talayhan/tmux-claude
https://github.com/talayhan/tmux-claude — stars 0
A tmux plugin that shows Claude window state and quota in the tmux bar. Its `scripts/statusline.sh` is only a harvester that prints nothing (`statusline.sh:2-9`). Styling is tmux `#[fg=..,bg=..]` format.
1. By state: beacon capsule colour attention `#e0af68` (question/plan), error `#f7768e`, done `#9ece6a`, otherwise unset (`scripts/beacon.sh color_for`, options `@claude_beacon_color_*`). Ambient mode tints each tab background by state: working `bg=#2b3350`, waiting `bg=#402b33,fg=#e0af68`, plan `bg=#2f2b40,fg=#bb9af7`, done `bg=#26331f,fg=#9ece6a`, error `bg=#3a2330,fg=#f7768e`, loop `bg=#26313a,fg=#7dcfff` (`tmux-claude.tmux:64-69`). Usage by threshold: >=90 `#f7768e`, >=70 `#e0af68`, else empty = inherit the theme (`helpers.sh pick_color`, `:89-99`).
2. Themes: the Tokyo Night hexes are the defaults; every colour is a tmux option, so any palette can be set. Four modes: dual-rail, beacon, hud, ambient. "Theme-agnostic": normal colour is unset.
3. Hex truecolor in tmux styles; README says ambient needs truecolor. No NO_COLOR.
4. Both: ambient uses tab background fill with a quota hairline `#7aa2f7` over `#3b4261` (`hairline.sh:44-64`); other modes foreground text.
5. Separators: configurable text (`@claude_beacon_separator`, default ` · `); no powerline.
6. Neighbours: ambient tab-background tint per state; badges per state.
7. Light/dark: by leaving normal colour unset so the host tmux theme decides; README caveat about themes that hard-code per-segment backgrounds.
8. Emoji badges per state, configurable (`@claude_badge_*`: ❓ ⚠️ 📝 ✅ 🔄 ⏳ 🌀); optional accessibility dot glyphs in ambient (`@claude_ambient_glyphs`).
9. Usage sparkline (`spark.sh`) coloured by last reading; full-width hairline bar on a second status row; demo recorder scripts in `assets/record`.
10. Customisation: tmux options (`@claude_*`), mode switch, docs/configuration.md.

## tantk/claude-statusline
https://github.com/tantk/claude-statusline — stars 0
Configuration for the external ccstatusline tool, not an original renderer (`ccstatusline-settings.json`, `install.mjs`).
1. Fixed per widget via ccstatusline `color` (`ccstatusline-settings.json`): model brightBlue, context-percentage brightMagenta, tokens-cached brightGreen, tokens-total brightRed, session-cost cyan, block-timer brightBlue, git-worktree brightBlue and brightYellow, git-changes red, git-root-dir green, free-memory green, cwd brightRed; session/weekly usage, clock use default colour.
2. Themes: none; powerline `enabled: false`, so no theme.
3. ccstatusline `colorLevel: 2` (256-colour). NO_COLOR not present in these files.
4. Foreground-only.
5. Separators: ccstatusline `separator` widgets, `inheritSeparatorColors: true` (separator takes the previous widget's colour), `globalBold: true`.
6. Neighbours: different bright hues per widget; five lines.
7. Light/dark: not present.
8. Glyphs: whatever ccstatusline draws; none custom.
9. Nothing else.
10. Customisation: ccstatusline JSON; `install.mjs` writes it.

## tanwar-harsh/luff-crew-monitor
https://github.com/tanwar-harsh/luff-crew-monitor — stars 0
Mainly a Claude Code mod (job bar + agents panel drawn as SVG, half-block pixel mascots in the terminal) with a secondary one-line terminal statusline (`src/statusline.ts` -> `renderStatusline` in `src/render-text.ts`).
1. Statusline (`render-text.ts:85-100`): ANSI codes by role: flow title/bar green `32` when finished else magenta `35`; label bold; percent and crew count/cost dim `2`; running-agents count yellow `33`. Mod graphics (`hooks/draw.ts`): meter colour by threshold `meterColor`: calm `ACCENT #5b6cf0`, `WARN #c98a12` >=70, `BAD #d0453f` >=90 (`:108-109`); status colour done `OK #2f9e66`, failed `BAD`, running = the agent's own colour, else grey (`:90`). Per agent type colour from a 7-hex `PALETTE`, fixed for `general-purpose`/`Explore`/`Plan`, others by string hash (`typeColor`, `:20-30`).
2. Themes: none of its own; the engine gives render hooks no theme, so words are host Text (themed by the app) and SVG colours are picked to read on both light and dark (`draw.ts:36-37`).
3. Statusline uses ANSI 16 SGR; NO_COLOR and `--no-color` honoured (`src/cli.ts:99-101`). SVG uses hex.
4. Foreground; SVG bars/rects are filled shapes; terminal mascot uses coloured half blocks.
5. Separators: two spaces between statusline parts; no powerline.
6. Neighbours: per-agent hue from the palette hash; status via colour.
7. Light/dark: SVG greys use fixed-opacity `#8a8a8a`; README ships light and dark screenshots; reduced-motion media query disables animation (`draw.ts:57`).
8. Emoji `⛵` in the statusline, glyph set in `src/render-text.ts`; i18n in `src/i18n.ts`. Pixel mascots with hats/eyes/mouth derived from a hash (`src/crew.ts`).
9. Animation: CSS keyframe animation per effort level (propeller, flame, spin; `draw.ts:43-57`), striped running segments; effort shown as held gear (mop, oar, spyglass, lantern, wheel).
10. Customisation: `src/config.ts` options (language, stepReports, etc.), CLI flags `--no-color`, `--wrap`.

## tanyusylvain/mossccline
https://github.com/TanyuSylvain/mossccline — stars 0 — FORK OF Haleclipse/CCometixLine
Differences from the parent only:
1. Adds one segment `SegmentId::MossAiHub` (`src/core/segments/moss_ai_hub.rs`, config in `src/ui/themes/theme_default.rs:165-200`): fixed RGB cyan `(0,200,255)` icon and text, bold, `new_line: true`; in the powerline themes it also gets a background (`theme_powerline_dark.rs:264-282`, bg starts `rgb(45,...)`). Rest of the colour mapping is the parent's per-segment `ColorConfig {icon, text, background}` (e.g. default theme Model/Usage `Color16 14`, Directory icon 11 / text 10, Git 12, Context 13).
2. Same nine themes as the parent: cometix, default, minimal, gruvbox, nord, powerline-dark, powerline-light, powerline-rose-pine, powerline-tokyo-night (`presets.rs:83-91`); user themes read from `~/.claude/mossccline/themes` (`presets.rs:56`) instead of the parent's path.
3-10. Unchanged from parent (Color16 / Color256 / Rgb enum `AnsiColor`, Nerd Font/emoji icons via `IconConfig {plain, nerd_font}`, ratatui TUI configurator with colour picker); the fork's addition is the MossAIHub usage line (`🔵 MossAIHub - Weekly [$..] rank [..] Opus remains [..]`, README line 17) and a `setup` subcommand.

## tarunlnmiit/statusline-plus
https://github.com/tarunlnmiit/statusline-plus — stars 0
1. Fixed per segment and by threshold (`bin/statusline.sh`): model magenta (`:71`); effort high magenta / medium cyan / low green / else dim (`:78-81`); context bar, tokens (>=50k yellow, >=100k red) and rate limits green <50, yellow 50-79, red >=80 (`:102-155`); cost, duration, reset time, output-style dim; git branch green; folder bold cyan (`:215`).
2. "Themes" are only segment lists, not colours: `themes/full.sh`, `minimal.sh`, `power.sh` each set `SEGMENTS=(...)`; active theme chosen from a state file (`:221-232`). Users can add a file.
3. Seven ANSI 16 escapes at the top (`:8-15`). No depth detection, NO_COLOR not present.
4. Foreground-only.
5. Separator: dim ` │ ` (`SEP`, `:16`).
6. Neighbours: separator plus different hues.
7. Light/dark: not present.
8. Glyphs: Unicode bars and a branch glyph; no mode switch.
9. Preview PNGs per theme in `assets/`.
10. Customisation: theme name file, edit segment lists; script functions `seg_*`.

## taskx6004/claudia-statusline
https://github.com/taskx6004/claudia-statusline — stars 0
1. Theme role per segment, fixed set of 14 role keys (`src/theme.rs ThemeColors`, `themes/dark.toml:11-33`): directory, git_branch, model, duration, separator, lines_added, lines_removed; by threshold: `cost_low/medium/high` (config low/medium thresholds, `display.rs:186-199`), `context_normal/caution/warning/critical` (thresholds in config, `display.rs:203-218`). Dark default: directory cyan, branch green, model cyan, duration/separator light_gray (256-colour 245), lines +green/-red, context white -> yellow -> orange (208) -> red.
2. Eleven bundled TOML themes embedded in the binary: dark, light, monokai, solarized, high-contrast, gruvbox, nord, dracula, one-dark, tokyo-night, catppuccin (`theme.rs:28-38`). Format: per-role colour map (not semantic palette). Users add `~/.config/claudia-statusline/themes/*.toml`; selection order CLI `--theme` > config > `CLAUDE_THEME` > user themes > embedded > default (`theme.rs:9-19`). Optional `[palette.custom]` of named raw escapes.
3. A colour value may be a name (black..white, gray, bright_*, `light_gray` = 38;5;245, `orange` = 38;5;208), `#RRGGBB` (truecolor), or a raw `\x1b[` string (`resolve_color`, `theme.rs:466-535`); unknown name warns and uses white. NO_COLOR honoured (`display.rs:36-38`, `--no-color` flag in `main.rs:237`). No depth downsampling.
4. Foreground-only.
5. Separator: ` • ` coloured by theme `separator` (`display.rs:458`), configurable string, or a `format` template with `{directory} • {git}` placeholders (config.rs docs :374-383).
6. Neighbours: different roles per segment plus the dot separator.
7. Light/dark: two explicit themes; `light.toml` uses blue instead of cyan and gray instead of white ("darker for visibility"). No auto-detection (selected by name).
8. Emoji/Unicode glyphs; progress bar `[===>---]` ASCII-style in compaction state.
9. Cost and context colours also drive the context bar; compaction state shown ("Compacting..." yellow, check mark green); SQLite stats, token rate display.
10. Customisation: TOML config file, CLI flags, `CLAUDE_THEME`/`STATUSLINE_THEME` env, `format` templates.

## tasqrai/tasqr-statusline
https://github.com/tasqrai/tasqr-statusline — stars 0
1. By meaning (`tasqr_statusline.py:80-155`): six roles dim/accent/branch/ok/warn/alert. accent = model name and "next:" (pending), warn = in-progress `▶` and quota >=0 (alert at >=95%), alert = `⛔` blocked and P1/P2 priority, ok, dim for counts/time/cost/lines. Per-meaning rules match the tasqr dashboard (amber in progress, blue pending, coral blocked).
2. Four bundled palettes: `ansi` (default, terminal's own 16 colours), `dark` (xterm-256 mapped Signal tokens: accent #5B8CFF, mint #54E6B5, amber #E0B23C, coral #FF6B6B), `light`, `dracula` (`PALETTES`, `:77-113`). Format: semantic roles. Resolution: `TASQR_STATUSLINE_THEME` env, then config, then Claude Code's own `theme` in `~/.claude/settings.json` (a value containing "light"/"dark" maps to those), then `ansi` (`resolve_theme`, `:166-185`). No user-defined palettes beyond editing the file.
3. ANSI 16 and 256-colour indices (`38;5;N`, `48;5;N`). NO_COLOR honoured (`_want_color`, `:187`): colour-only styles collapse to plain.
4. Both: style `bubble` paints each segment as a background chip `48;5;bg` + `38;5;fg` with per-theme (bg, fg) pairs (`CHIPS`, `:129-155`); `plain` is foreground-only; `panel` and `meters` are multi-line layouts.
5. Separator: dim ` | ` for plain; bubble style joins chips by a single space (no glyph, "pure background colour rather than edge glyphs", `:192-193`).
6. Neighbours: bubble chips with distinct role colours and a neutral "surface" chip colour per theme; chips use dark on-accent text.
7. Light/dark: yes; `light` palette re-derived at readable contrast, light chip surface `(254,236)`; `ansi` adapts to any terminal theme; follows Claude Code's theme setting.
8. No emoji in bubble mode ("No emoji", `:192`); `⛔`/`▶` in plain; `_chip_text` spells "blocked" out because the emoji keeps its own red on a coral chip.
9. Marquee scrolling for long task titles (`marquee()`); box-drawn panel (`╭ │ ╰`).
10. Customisation: layered settings (global, per-project `projects.conf`) for tags, theme, style, segments, ttl, refresh (`SETTING_KEYS`, `:51`); env vars `TASQR_STATUSLINE_THEME`, `_STYLE`.

## tchejunior/claude-sl
https://github.com/tchejunior/claude-sl — stars 0
A web builder (React + MUI) that generates statusline scripts in bash/python/node/PowerShell; the MUI `theme.ts` (#7aa2f7, #1a1b26) styles the builder page itself, not the generated bar.
1. Generated output: one fixed rule only. Params declared `colorize` get a green/yellow/red choice by two thresholds (`src/schema/params/context.ts:36` default `[75, 90]`, rate limits likewise); other fields uncoloured. Colour helper defined in `src/codegen/runtimes/sh.ts:2`: `G=\e[32m Y=\e[33m R=\e[31m C=\e[36m`.
2. Themes: not present in the generated scripts.
3. ANSI 16 only; no depth detection, NO_COLOR not present.
4. Foreground-only.
5. Separators: not styled (line packing joins parts; `pack.ts`).
6. Neighbours: not styled.
7. Light/dark: not present (builder page is dark MUI).
8. Emoji in field labels (15 hits); no ASCII toggle.
9. Live ANSI-to-HTML preview in the page (`src/output/ansiToHtml.ts`); OSC 8 clickable repo link; "smart line packing" to a target width.
10. Customisation: checkbox UI + sub-options (bar width, thresholds, timestamp format) emitting `settings.json` plus script.

## tech-andgar/custom_statusline
https://github.com/tech-andgar/custom_statusline — stars 0
Config for the external ccstatusline tool plus an add-on analytics script from claudetop (`claudetop-statusline-query.py`); the 1,595-line `claudetop-engine` is a web dashboard whose CSS colours are not statusline styling.
1. Fixed per widget in `example-ccstatusline-settings.json`: model fg 16 on bg 111 (blue), context-length fg 234 on bg 248 (grey), git-branch fg 16 on bg 176 (pink-purple), git-changes fg 234 on bg 221 (yellow), custom claudetop widgets white/cyan (`ccstatusline-widgets.json`). Budget widget threshold colour inside the script: >=100% red, >=80% yellow, else green (`claudetop-statusline-query.py:88-93`), `preserveColors: true` so ccstatusline keeps the script's ANSI.
2. Themes: ccstatusline `powerline.theme: "custom"`; no bundled themes of its own.
3. ccstatusline `colorLevel: 2` (256) with `ansi256:N` colour strings; script uses ANSI 16. NO_COLOR not present.
4. Both: powerline enabled with per-widget `backgroundColor` fills (ansi256 111/248/176/221) and dark foregrounds; the claudetop widgets are foreground-only.
5. Separators: powerline arrow `` (`separators`, `separatorInvertBackground: false`, `autoAlign: true`), colours derived by ccstatusline from the adjacent backgrounds.
6. Neighbours: four different background hues with dark text and arrow transitions.
7. Light/dark: not present; foregrounds chosen dark on mid-tone backgrounds.
8. Powerline glyph only.
9. Nothing else styling-related.
10. Customisation: ccstatusline JSON; widgets installed by `install.sh`.

## techiewonk/cc-status-dash
https://github.com/techiewonk/cc-status-dash — stars 0
1. Theme role mapped to widgets: semantic keys `model, cwd, git, gitBranch, context, usage, warning, critical, label, paceGood, paceBad, barFilled, barEmpty, activeTool, doneTool, agent, todo` (`src/themes/index.ts:21-41`). Default `hud-clean`: model cyan, cwd yellow, git magenta, gitBranch cyan, context green, usage brightBlue, label dim, agent magenta. Threshold: `thresholdColor(pct, warn=60, crit=85)` returns `context | warning | critical` (`src/render/bars.ts:39-47`). In powerline mode the default background cycle is `["model","cwd","git"]` roles by widget position, fg `label` (`renderer.ts:314,323-324`).
2. Ten bundled themes: hud-clean, tokyo-night, gruvbox, nord, catppuccin, dracula, one-dark, rose-pine, hud-light, mono (`THEMES`, `themes/index.ts`). Semantic palette roles; users override single keys through `colors` in config (`resolvePalette(theme, overrides)`). A colour value can name another colour key (indirection, `resolveColorKey`). Separately, ccstatusline-parity powerline themes cycle 5 fg/bg slots by position in 16/256/truecolor variants: nord, nord-aurora, monokai, solarized, minimal, dracula, catppuccin, gruvbox, onedark, … (`src/render/powerlineThemes.ts`, `position % 5`).
3. Named ANSI 16, 256 index, `#hex`; downsampling truecolor -> 256 -> 16 (`colors.ts` `rgbToAnsi256`, `rgbToBase16`); depth auto from `COLORTERM`/`FORCE_COLOR`/`TERM`, or config `colorDepth` (auto|ansi|ansi256|truecolor|none). NO_COLOR and `FORCE_COLOR=0` disable colour (`colorsEnabled`).
4. Both: styles `inline` (foreground), `powerline` and `capsule` (background fills), `panel` (box frame) (`config/schema.ts:17`). `overrideForeground` / `overrideBackground` force one colour everywhere.
5. Separators: inline text separator (config `separator`, `│` or `|` in text charset); powerline glyph chosen from arrow, round, triangle, flame, pixel (`powerlineSeparator`), optional end caps none/round/flame; capsule uses rounded caps. Separator colour: arrow fg = current segment bg, arrow bg = next segment bg (`renderer.ts:337-341`); `inheritSeparatorColors` takes the previous widget's colour for inline.
6. Neighbours: powerline cycles three role backgrounds (model, cwd, git) or five themed slots, each with a paired contrast fg; lightness steps not used.
7. Light/dark: `hud-light` theme with darker hexes; `mono` theme for no colour; per-slot fg chosen per palette. No auto detection of terminal background.
8. Nerd Font glyphs for powerline/caps; `charset: "text"` swaps in ASCII (`>`, `(` `)`, `+--`); bar styles blocks `█░` or text `#-`.
9. Line gradient: per-widget recolour by position across hex stops, left to right (`gradientAt`, `renderer.ts:182-187`); panel style with rounded box.
10. Customisation: JSON config schema with valibot (`config/schema.ts`), `wizard.ts` and `mutations.ts` for a setup wizard, `/configure` command (`commands/configure.md`).

## technique-prosec/claude-status_line
https://github.com/technique-prosec/claude-status_line — stars 0
1. Fixed per segment (`statusline-command.sh:15-86`): hostname bold white, model cyan, directory yellow, branch green, rate-limit text bold white, token text dim. Threshold on the context bar: green <50, yellow 50-79, red >=80.
2. Themes: not present.
3. ANSI 16 escapes. No depth detection, no NO_COLOR.
4. Foreground-only.
5. Separators: two spaces, no glyph.
6. Neighbours: distinct hues (white, cyan, yellow, green).
7. Light/dark: not present.
8. `█ ░` bar in brackets, width via `STATUSLINE_BAR_WIDTH`; no icons.
9. Nothing else; French comments.
10. Customisation: env `STATUSLINE_SHOW_HOST`, `STATUSLINE_BAR_WIDTH`.

## teja-codevibes/claude-code-cli-statusline
https://github.com/teja-codevibes/claude-code-cli-statusline — stars 0
1. By threshold plus fixed (`statusline-command.sh:37-89`): context bar and text: 0% gray 90, <50 green, 50-70 yellow, >70 red; agent name bright blue `\033[94m`; model, token line and `|` separators gray `\033[90m`.
2. Themes: not present.
3. ANSI 16 escapes. No depth detection, no NO_COLOR.
4. Foreground-only.
5. Separators: gray ` | `.
6. Neighbours: gray `|` separators, bright-blue agent.
7. Light/dark: not present (gray on dark assumed).
8. 20-cell `[█░]` bar; text labels; emoji appear only in the installer.
9. Nothing else.
10. Customisation: edit script.

## teo-zent/claude-statusline
https://github.com/teo-zent/claude-statusline — stars 0
1. By threshold, one colour per meter (`statusline.sh:30-32,123-142`): context bar and its percentage green <70, yellow 70-89, red >=90; 5h and 7d quota bars and labels coloured the same way by their own percentages. Tokens, cost, model uncoloured.
2. Themes: not present.
3. ANSI 16 escapes. No depth detection, no NO_COLOR.
4. Foreground-only.
5. Separators: plain ` | ` uncoloured (`:178`).
6. Neighbours: plain separators; only meters carry colour.
7. Light/dark: not present.
8. Block-glyph bars; no icons.
9. Nothing else (a `cost_aggregator.py` handles cost).
10. Customisation: edit script; `install.sh` / `uninstall.sh`.

## terrylica/cc-skills
https://github.com/terrylica/cc-skills — stars 0
A large plugin marketplace; the styling file is `plugins/statusline-tools/statusline/custom-statusline.sh` (2,432 lines). Other files read are not statusline styling.
1. By state/threshold, six ANSI names (`:72-78`): grey `\033[90m` for quiet/zero values and most labels, yellow for non-zero git stats and warnings (`append_stat`, `:395-399`), red `\033[91m` for conflicts and errors, green `\033[92m` for repo path, cyan `\033[96m` for tags and cron jobs, magenta for a URL. Context bar: grey normally, yellow within 12 points of the auto-compact trigger, red at the token threshold (`:1700-1710`). Gateway health uses a state-to-colour table (`✓` green, `?` yellow, `✗` red; `:2215-2257`).
2. Themes: not present. (ThemeCatalog files exist under `floating-clock`, an unrelated macOS clock plugin.)
3. ANSI 16 incl. bright variants. No depth detection; NO_COLOR not present.
4. Foreground-only.
5. Separators: grey `|` and `·`.
6. Neighbours: grey structure with coloured values; value colour carries meaning, so "nothing to see" stays grey.
7. Light/dark: not present.
8. Emoji and Unicode (⚠ ✓ ✗ `▕▏` bar edges); OSC 8 file:// hyperlinks for cron jobs and session files (`:2398-2425`).
9. Multi-line renderer; `STATUSLINE_HIDE` hides segments by name.
10. Customisation: env `STATUSLINE_HIDE`, `STATUSLINE_GATEWAY_LABEL`, etc.; `manage-statusline.sh`.

## teutooni/cc-vitals
https://github.com/Teutooni/cc-vitals — stars 0
1. Theme role per segment, a fully data-driven map in `scripts/default-config.json:39-90`: model=accent, cwd=primary, git.branch=secondary, git.added=success, git.modified=warning, git.deleted=error, git.untracked=muted, git.op=error, cost.session=primary, cost.day/month=muted, context.normal=muted / warn=warning / crit=error, cache.hit_high=success / hit_low=warning / hit_crit=error, cache.ttl=muted, duration/runtime/cc_version=muted, separator=dim. A value is a role name or a literal `#hex` (`resolve_color`, `lib/colors.py:84-93`), so a user remaps any segment key.
2. Three bundled themes, each 8 roles (primary, secondary, accent, muted, warning, error, success, dim): vs-dark-modern, high-contrast, claude-default (accent #D97757) (`colors.py:55-84`). Selected by `theme` config or `CC_VITALS_THEME`; `/cc-vitals preset` command. Users can override colours per key.
3. Truecolor only: `\033[38;2;r;g;bm` from hex (`_fg`, `colors.py:44-52`), 3- and 6-digit hex accepted. NO_COLOR honoured (`_NO_COLOR` empties every code, `:5-9`). No depth downsampling.
4. Foreground-only.
5. Separator: configurable string, default ` │ `, painted with the `separator` role and dim (`render.py:214-216`).
6. Neighbours: role colours plus the dim separator.
7. Light/dark: not present beyond the themes' own contrast; `high-contrast` exists.
8. Nerd Font icons by default (`icons: "nerd"`) with an `ascii` style; per-segment icon override; distro-specific brand icons and colours for the env segment (`segments.py:29-110`, `_DISTRO_COLORS`, `_ENV_COLORS`).
9. Gradients along theme roles: context bar colour = `gradient_hex(frac, theme)` through success -> warning -> error; 5-hour limit bar success->warning->error; 7-day bar secondary->accent->error (`segments.py:616,660,664`); RGB linear mix (`_mix_hex`). Rainbow: effort `max` is painted per character from a 7-hex cycle (`_RAINBOW`, `:204-217`); other effort levels fixed hex (minimal/low amber #FFC108, medium green #4EBA65, high #B1B9F7, xhigh purple #AF87FF). A tmux mode ticks a countdown at 1 Hz.
10. Customisation: JSON config merged over `default-config.json` (`lib/config.py`), `CC_VITALS_THEME` env, slash command, tmux or native mode.

## thadeu/clowk-claude-statusline
https://github.com/thadeu/clowk-claude-statusline — stars 0
1. Fixed per segment (`statusline.sh:13-15`, 256-colour): model 141 (purple, bold), effort 183 (light purple, uppercase), repo/dir 75 (blue), branch 213 (pink), cost `$` muted 245 + value ok 114, +added ok 114, -removed bad 203, session name muted dim. By threshold: `tone()` ok 114 <70, warn 221 >=70, bad 203 >=90 for each gauge's cells and percentage (`:24`).
2. Themes: not present; a constants block only.
3. 256-colour fg (`38;5;N`), plus one truecolor escape for the padding dot. No detection, NO_COLOR not present.
4. Foreground-only.
5. Separators: `  │  ` painted in the track colour 238 (`SEP`, `:21`); ASCII mode `  |  `.
6. Neighbours: distinct hues per identity element, separator in a dark grey.
7. Light/dark: partial hack: a third line prints a dot in the terminal's background colour so the host keeps a padding line; `STATUSLINE_BG` or auto-read from the active Ghostty theme (`ghostty_bg`, `:107-131`, picks the `dark:` half of a `light:x,dark:y` theme). Default `#0c0b14`.
8. Nerd Font folder icon `󰉋`, `▰▱` gauges, `●` dirty marker; `STATUSLINE_ASCII` switches to `#`/`.`/`*` (`:17-21`).
9. Apple-metrics parts on line 2; per-gauge reset countdowns dim.
10. Customisation: env `STATUSLINE_ASCII`, `STATUSLINE_BG`; edit script.

## thariman/myccstatusline
https://github.com/thariman/myccstatusline — stars 0
A ccstatusline setup (`settings.json`) plus two custom-command scripts (`credits.sh`, `fable-weekly.sh`); no own renderer.
1. Fixed per widget via ccstatusline colour names: model/context/cwd/labels white, branch and separators gray, usage bars, reset timers and credits green (`settings.json:5-39`). No threshold colouring (the scripts emit no ANSI).
2. Themes: `powerline.theme: "catppuccin"` set, but powerline is `enabled: false`, so it has no effect.
3. ccstatusline `colorLevel: 2` (256). NO_COLOR not present.
4. Foreground-only.
5. Separators: ccstatusline separator widgets ` | ` in gray; powerline separator list present but disabled.
6. Neighbours: white vs gray vs green only.
7. Light/dark: not present.
8. `⟳` reset icon via custom-text; ccstatusline `progress-short` bars (`█░`).
9. Three-line layout (identity, session usage and credits, Fable weekly and weekly usage).
10. Customisation: ccstatusline JSON, `install.sh` / `build.sh` (bun).

## thatgroot/claude-tokens
https://github.com/thatgroot/claude-tokens — stars 0
Mostly a token-usage reporter/PNG card generator plugin; the statusline piece is `statusline/tokens-statusline.js`.
1. Statusline: not present (outputs the plain string `🪙 <compact> today`, cached 45 s, `tokens-statusline.js:60-80`; no ANSI). The card (`src/card.ts`) bucket-maps each day's tokens to 5 quartile levels of a green ramp (GitHub contribution-graph style).
2. Themes: card only, two palettes `LIGHT_PALETTE` and `DARK_PALETTE` (`card.ts:41-57`, `Theme = "light" | "dark"`), e.g. dark cells `#161b22 #0e4429 #006d32 #26a641 #39d353`.
3. Statusline: no colour. Card: hex.
4. Statusline: plain text. Card: filled cells on a filled background.
5. Separators: none.
6. Neighbours: not applicable.
7. Light/dark: card has both palettes (chosen by option, not detected).
8. Emoji `🪙` in the statusline.
9. Card is rendered with `@napi-rs/canvas` (IBM Plex Sans font asset).
10. Customisation: plugin skills `tokens` and `tokens-card`; CLI in `src/cli.ts`.

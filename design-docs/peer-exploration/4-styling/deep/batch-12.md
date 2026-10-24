# Batch 12: styling in 20 Claude Code statusline projects

Anchors name a file and the identifier or key the claim came from (raw files were read via curl; line numbers were not recorded).

## cctap
https://github.com/chipmates/cctap (3 stars)
Not a conventional statusline: a multi-session "board" (strip of sessions) that can also be fed to a Claude Code status line or tmux status-right.
1. By state, per session entry: `src/render/theme.ts` `sgrFor(state)` maps `permission_wait`->bright red bold (`[91,1]`), `failed`->red `[31]`, `your_turn`->yellow `[33]`, `working`->green `[32]`, `compacting`->cyan `[36]`, `ended`->dim `[2]`. `colorScopeFor`: every state paints the whole entry except `compacting`, which tints only the glyph (and subagent count). No fixed per-segment colour.
2. Themes: `theme.ts` `Theme` = glyph sets only (`unicode`, `ascii`), chosen by `CCTAP_THEME`/config/TERM/locale (`resolveTheme`). No colour themes; no user-defined themes.
3. Plain SGR 16 colours only (`ansi` object in `src/ansi.ts`: 31/32/33/36/90). No 256/truecolor, no downsampling. `colorEnabled()` honours `NO_COLOR` (wins over `CCTAP_COLOR=1`), `FORCE_COLOR`, TTY check. Non-colour attributes (reverse, bold) deliberately survive NO_COLOR (`attrsEnabled`).
4. Foreground-only; reverse video (SGR 7) used for the "you are here" number and highlight.
5. Plain separators: `theme.separator` `│` (ascii `|`) between project groups, two-space gap between entries (`ENTRY_GAP` in `src/render/strip.ts`).
6. Neighbours told apart by glyph and per-session spinner phase offset (`phase(sessionId)` in `strip.ts`), project grouping with `│`, and state colour; not by hue per slot.
7. No light/dark detection; 16-colour traffic-light chosen to be terminal-palette-safe (comment on `sgrFor`). Blink off by default (accessibility).
8. Braille spinner `⠋⠙…` / ascii `/-\`; glyphs `!!`, `▲`, `✗`, `◌`, `·`; ASCII fallback theme auto-selected for TERM=dumb/vt100, non-UTF-8 and CJK locales.
9. Animation: spinner frame from wall clock (`SPIN_STEP_MS` 500); optional blink (`CCTAP_BLINK`); width-fit ladder drops labels before attention glyphs.
10. Env vars `CCTAP_THEME`, `CCTAP_COLOR`, `CCTAP_BLINK`, `NO_COLOR`, `FORCE_COLOR`; config file (`src/config.ts`, not read in detail); CLI flags `--rows`.

## claudeblue
https://github.com/cloudblue/claudeblue (3 stars)
1. Fixed per segment, per theme script, plus threshold for context. `statuslines/electric.sh`: model `NEON_BRIGHT` bold, git branch `NEON` bold (dirty marker `FG_WARNING` gold), cost `NEON_DIM`, separator `NEON_DIM` `║`; context bar `NEON` <50, `FG_WARNING` >=50, `FG_DANGER` >=80. `glacier.sh`: branch `FG_SKY`, bar `FG_GLACIER` -> `FG_WARNING` >=60 -> `FG_DANGER` >=80, empty cells and `ctx` label `FG_STORM`. `midnight.sh`: model `FG_COBALT` bold, git `FG_SKY` (modified `~N` gold, staged `+N` `FG_SUCCESS`), cost `FG_GLACIER`, 4-step bar (`FG_GLACIER` <40, `FG_SKY` <60, gold <80, danger).
2. Three bundled statusline themes (`THEMES=("glacier" "midnight" "electric")` in `bin/claudeblue`), each a separate script sharing `palette.sh` (CloudBlue brand blues). Format = bash scripts with named colour variables; users edit scripts, no user-theme schema. Separately ships terminal themes (alacritty, iTerm2, Warp, Windows Terminal, ghostty, zsh prompt) in `themes/`, light and midnight variants.
3. Truecolor only: `palette.sh` defines `\033[38;2;R;G;Bm` and `48;2` for 9 hexes (`#1CD8F9`, `#288AF9`, `#0723EA`, `#130EB1`, `#0B0355`, `#060228`, `#E0F0FF`, `#264BFA`, `#ECC30B`) plus semantic aliases `FG_PRIMARY/SECONDARY/MUTED/TEXT/SUCCESS/WARNING/DANGER`. No downsampling, no NO_COLOR.
4. Foreground-only (BG_* are defined in `palette.sh`; `NEON_BG` in electric.sh is defined but not used in the composed output).
5. Plain-text separators: `║` (electric) or `│` (glacier, midnight) in a dim blue, two spaces either side.
6. Separators only; hues come from one blue family.
7. Terminal themes ship `claudeblue-light` and `claudeblue-midnight`, iTerm2 DynamicProfile switches light/dark automatically; the statusline scripts themselves have no light/dark logic (palette is fixed dark-terminal oriented).
8. Nerd Font branch glyph before the branch name; `◆`, `⚡`, `▰▱`, `█░` bars. No ASCII mode.
9. Session analytics CLI (`claudeblue stats`, `history`) with blue bars; `claudeblue preview` shows all three themes with sample data.
10. `~/.claudeblue/config` (shell vars `CLAUDEBLUE_THEME`, `CLAUDEBLUE_SHOW_COST/MODEL/GIT/CONTEXT`), CLI `claudeblue use <theme>`.

## crazycoder/ccstatusline
https://github.com/CrazyCoder/ccstatusline (3 stars) - FORK OF sirmalloc/ccstatusline
Differences only: published as `ccstatusline-jb`; adds nine JetBrains Central quota widgets (`src/widgets/JbCentral*.ts`: account, plan, usage, quota, usage %, remaining, period start, reset date, days until reset), `src/utils/jbcentral.ts`, plus install/update-checker/global-package-manager changes. `gh api compare` against parent shows 49 commits ahead, and none of the changed files are styling code (`colors.ts`, `renderer.ts`, `powerline*.ts`, `PowerlineThemeSelector.tsx` are untouched). The README's "Everything below this section is inherited from upstream." The 8 powerline theme names the scanner saw (catppuccin, dracula, gruvbox, monokai, nord, one-dark, solarized, tokyo-night) and gradients (README v2.2.20) are the parent's.

## dip497/claude-code-statusline
https://github.com/dip497/claude-code-statusline (3 stars)
Installer that wraps upstream ccstatusline; no styling code of its own.
1. Fixed per widget, written into `~/.config/ccstatusline/settings.json` by `setup.sh` (heredoc `CCEOF`): model cyan, version brightBlack, output-style green, vim-mode yellow, session-cost red, session-usage yellow, weekly-usage brightBlack, git-branch magenta, git-changes yellow, git-insertions green, git-deletions red, git-worktree blue, cwd blue, git-root-dir brightBlack, tokens-input green, tokens-output cyan, tokens-cached yellow, context-length brightBlack, context-percentage white, session-clock blue, block-timer magenta, memory-usage brightBlack. No thresholds in this config.
2. Themes: not present in this repo (`"powerline": { "enabled": false }`); upstream ccstatusline powerline themes are reachable via its TUI.
3. Named ANSI 16 colours; `"colorLevel": 3` (truecolor) set in the settings. NO_COLOR: not present.
4. Foreground-only (powerline disabled).
5. Plain `separator` widgets between most widgets (`"type": "separator"` entries); `separatorInvertBackground` / `inheritSeparatorColors: false`.
6. Different hue per widget, plus separators.
7. Not present.
8. `cc-config.js` / `font-selector.js` install a Nerd Font (JetBrainsMono, CascadiaCode, FiraCode, Hack, Iosevka) via curl + `gsettings`; emoji/Nerd glyphs come from ccstatusline.
9. `cc-config.js` menu: "Change Font" or "Edit Colors & Lines" (launches ccstatusline TUI).
10. ccstatusline `settings.json` (`flexMode: "full-minus-40"`), `ccstatusline` TUI, `cc-config` command.

## e950280/hudlite
https://github.com/e950280/hudlite (3 stars)
A Claude Code mod (hooks/register.tsx) that re-themes `claude-hud`'s HUD rows; it is a styling layer over claude-hud, not a standalone line.
1. By semantic palette role, with threshold states. `hooks/hud/render/colors.ts`: `model()` default CYAN, `project()` YELLOW, `git()` MAGENTA, `gitBranch()` CYAN, `label()` DIM, `custom()` `38;5;208`; context bar `getContextColor`: green (`colors.context`) <70, `warning` yellow >=70, `critical` red >=85 (thresholds configurable); quota `getQuotaColor`: `usage` bright blue, `usageWarning` bright magenta >=75% or pace warning, `critical` red >=90%.
2. `hooks/themes.ts` `THEMES`: 12 bundled (classic, neon, rainbow, emoji, sakura, kawaii, mecha, shonen, tokyo-night, matrix, nerd, powerline). Format = `Theme { palette (partial HudColorOverrides: model, project, git, gitBranch, label, context, usage, warning, usageWarning, critical, custom, barFilled, barEmpty), glyphs, separator{text,color}, extras, powerline{backgrounds[], cap}, gradient[], mascot }`. `applyPalette` lets a user's own claude-hud colour (anything off default) override the theme. User-defined themes: not present in code read (`findTheme` searches the built-in `THEMES` list).
3. Named 8/16 colours, 256 index (`HudColorValue` number), or `#rrggbb` truecolor (`resolveAnsi`). No downsampling or NO_COLOR seen in `colors.ts`.
4. Both: foreground by default; `powerline` theme fills each segment with a background (`powerlineSpans`).
5. Plain separators replaced per theme (` ❯ `, ` ✦ `, ` │ ` in `#3b4261`, nerd `  `); `powerline` theme uses cap `` with fg = left bg, bg = right bg.
6. Powerline: `backgrounds` list cycled by segment index (`pl.backgrounds[i % length]`; powerline theme: `#313244`, `#45475a`, `#1e1e2e`, three lightness steps of Catppuccin surface colours). Other themes: separators plus differing role hues.
7. Not present beyond per-theme palettes (powerline backgrounds are dark Catppuccin; no light variant).
8. Per-theme glyph sets (emoji, Nerd Font `NERD_GLYPHS`, ASCII-ish matrix/mecha); `isNerdFont` flag marks themes that need a Nerd Font.
9. Gradient bar fill: `gradientSpans`/`gradientAt` interpolate hex stops across filled bar cells and the model badge (rainbow, shonen themes); a mascot face by mood (`moodOf`: calm/busy/worried/panic/out) with per-theme kaomoji.
10. claude-hud config colour overrides, `/hud theme` command (per `THEME_NAMES` comment, not verified in detail), `register.tsx` mod.

## eakkapoom-name/statusline-in-nutshell
https://github.com/Eakkapoom-Name/statusline-in-nutshell (3 stars)
1. One accent colour for labels' values and state colour for effort; everything else default. `skills/nutshell-setup/scripts/statusline.sh`: model, workspace path segments, branch, and the `[█░]` bar fill use `ORANGE` (`CLAUDE_ORANGE='\033[38;2;217;119;87m'`); `"/"` and labels stay default foreground (`color_path`); empty bar cells `GRAY='\033[38;5;240m'`. Effort level fixed scale `effort_color()`: low `230;180;40`, medium `80;200;120`, high `177;185;249`, xhigh `185;150;235`, max = Claude orange (pinned, does not follow the accent). Context bar is a fixed accent, no threshold colouring found.
2. No themes; one switch: `config.json` `color` = `"blue"` swaps the accent `ORANGE` for `BLUE='\033[38;2;138;180;248m'` (`$config_color`; anything but exact `blue` -> orange). User themes: not present.
3. Truecolor for accent/effort, one 256-index grey. No downsampling, no NO_COLOR found.
4. Foreground-only.
5. Plain text `" | "` separators (`join_segments`) and multi-line output (`line1`..`line3`).
6. Separators/rows only; labels are the accent-vs-default contrast.
7. Not present.
8. Emoji labels (`LBL='💡'` model, `🎓` advisor, `⏳` context, `🪙` cost, `🕐` 5h, `🔄` week, `📂` workspace, `🌐` repo, `🌿` branch) vs word labels (`model:`, `context:`...) via `config.json` `emoji`.
9. 10-cell `[███░░░░░░░]` bar (`render_bar`) with accent fill and grey remainder.
10. `config.json` (`color`, `emoji`), `statusline-toggle.sh`, `nutshell-doctor.sh`; skill-driven setup.

## egor-xyz/robot
https://github.com/egor-xyz/robot (3 stars)
A Claude Code mod (robot mascot animation) with a custom status line under the prompt (`claude-mod/statusline.ts`).
1. By Claude Code theme key and state: `statusline.ts`. Calm = grey: `DIM='inactive'`; separator `LINE='subtle'` (` | `). `levelOf(percent)`: <50 `inactive`, <80 `warning`, else `error` (used for rate-limit meters). Model by family `MODEL_COLORS`: opus `warning`, sonnet `suggestion`, haiku `success`, fable `planMode`, other grey. Effort `EFFORT_COLORS`: high/xhigh `warning`, max `error`, else grey. Project `planMode`; branch `ide`; ahead count `warning`; cost `warning` above `COST_HIGH` ($100) else grey; ctx `error` at/over `hotAt` else grey; `❄ cache cold` `ide`; compacting ctx `suggestion`. README: "Grey means calm. A part gets a colour only when it needs your attention."
2. No theme files; uses Claude Code's own theme keys (README: "The line uses Claude Code's theme colors (warning, error, …), not fixed ones. It reads well in dark, light and color-blind themes"). The mascot animations have their own colour per mood.
3. Theme-key names, not RGB: Claude Code resolves them (a `-ansi` theme uses the terminal's own scheme per README). Mentions a 256-colour table in the shimmer module (`color.fg_256=3`); no NO_COLOR.
4. Foreground-only; the file under the mouse gets a soft background in the files panel.
5. Plain ` | ` in `subtle`.
6. Separators plus colour only on parts needing attention; rest uniform grey.
7. Adapts to the terminal by delegating to Claude Code theme keys, which is the whole mechanism (dark, light, colour-blind, ansi).
8. Emoji/symbols: `❄`, `↑`, `▸ ◂` squeeze arrows while compacting; `meterOf` glyph meter in `usage.ts`.
9. Shimmer sweep across the branch name for 3 s on change/commit (blue -> purple -> pink -> orange -> yellow, `claude-mod/shimmer.tsx`, `SHIMMER` colour key); rainbow for dance/jump animations; rank-based segment dropping (`RANK`) when narrow.
10. Mod settings via `/robot` commands (`status`, `changes`, `calm`...), `Limits shown`, `Branch wave`, `Cache cold` toggles saved across sessions.

## felipeness/claude-statusline
https://github.com/Felipeness/claude-statusline (3 stars)
1. Fixed per component name from the theme, with severity override for some. `internal/statusline/theme.go` graphite: cwd bg `#3d3d3d` fg `#fafafa`; git bg `#4a4a4a` fg `#7dd3fc`; model bg `#2d2d2d` fg `#a5b4fc`; cost_session fg `#fbbf24`; ticket `#34d399`; cluster `#c4b5fd`; vim_mode `#fbbf24`; gateway_budget `#4c1d95/#ede9fe`; gateway_tokens `#134e4a/#ccfbf1`; gateway_reset `#1e3a8a/#dbeafe`; tokens_in `#064e3b/#d1fae5`; tokens_out `#78350f/#fef3c7`; tokens_total `#1e293b/#e2e8f0`; tokens_cache `#312e81/#e0e7ff`. Unlisted components use `Theme.Default`. `components.go`: `context_pct`, `cost_session`, `burn_rate` take `Theme.SeverityFG(Classify(value, warn_at, critical_at))` (ok `#4ade80`, warn `#fbbf24`, crit `#f87171`) only when severity is not OK.
2. Five themes (`ThemeNames`): graphite, nord, dracula, sakura (light pastel: bg `#fdf2f8`), mono. Theme struct = `Default{BG,FG}`, `Segs map[component]{BG,FG}`, `Status{OK,Warn,Crit}`, `Muted`. Nord/dracula/sakura/mono map only cwd, git, model, cost_session; the rest fall back to Default. Hard-coded in Go; user themes: not present (config only selects a name).
3. Truecolor only: `Color.FG()`/`BG()` emit `38;2`/`48;2` (comment says "resolved at runtime to truecolor or 256" but no 256 path exists in `ansi.go`). `Color{}` (0,0,0) means "no colour". No NO_COLOR/COLORTERM handling found in `main.go`/`render.go`.
4. Both by style: `plain` = foreground only (BG ignored); `powerline` and `capsule` = background-filled pills.
5. Three styles (`StyleNames` plain|powerline|capsule): plain uses `" │ "` (configurable per line) in `Theme.Muted`; powerline arrow U+E0B0 with fg = previous bg, bg = next bg, plus a tail arrow; capsule `` `` rounded caps (U+E0B6/E0B4) around independent pills separated by one space (`render.go` `renderPowerline`, `renderCapsule`). Empty BG falls back to graphite `45,45,45`.
6. By per-component bg difference in graphite (`#2d2d2d` vs `#3d3d3d` vs `#4a4a4a` for cwd/git/model) and by separator/arrow; not alternating.
7. Sakura is a light theme but selected manually; no auto adaptation or contrast calculation.
8. `charset` = unicode|ascii (`config.go`); emoji in some labels; powerline glyphs require Nerd/Powerline font.
9. Local HTML export (`html.go`), history, budget report commands, gateway probe.
10. TOML `~/.claude-statusline/config.toml` (`theme`, `style`, `charset`, `auto_wrap`, `[[lines]]` components + separator, `[components.<name>]` `warn_at`/`critical_at`/`format`/`hide`/`label_prefix`), install script, interactive TUI not examined.

## gaoziman/cchstatusline
https://github.com/gaoziman/cchstatusline (3 stars)
A ccstatusline-derived line for a "CCH" proxy (balance/quota widgets).
1. Fixed per widget in config; powerline colours by position. `src/utils/config.ts` default lines: username cyan, `cch-model` cyan, `cch-directory` blue, git-branch magenta, context-usage yellow; other CCH widgets (trial balance, monthly quota, balance, daily cost, requests) have no colour set (each widget has `getDefaultColor()`, e.g. `src/widgets/cch-balance.ts`). Powerline mode: `src/renderer.ts` `applyPowerlineStyle` takes `fg[i]`/`bg[i]` from the theme by widget index `i` (`bg[i] || bg[0]`) unless the widget overrides `color`/`backgroundColor`.
2. Three powerline themes in `src/utils/colors.ts` `POWERLINE_THEMES`: gruvbox, dracula, nord (default `theme: 'gruvbox'`). Format: per colour-level keys `'1'` (ANSI16 names), `'2'` (256 indices), `'3'` (hex), each `{ fg: [4], bg: [4] }`. E.g. nord truecolor bg `#5e81ac, #88c0d0, #a3be8c, #ebcb8b` with fg `#eceff4` x3 and `#2e3440` last. User themes: not present (theme name looked up in the fixed table; unknown name falls back to normal mode with a warning).
3. Three depths explicitly: `colorLevel` 0 none, 1 ansi16, 2 ansi256 (default `colorLevel: 2`), 3 truecolor (`getColorAnsiCode`; hex only honoured at level 3; 256-named colours `orange 208`, `purple 135`, `pink 211`, `teal 37`, `lime 154`). Each powerline theme ships three per-depth palettes; no automatic detection beyond the setting (the scan shows `env.truecolor` hits, not verified). NO_COLOR: not present.
4. Both: foreground-only in normal mode (optional `backgroundColor`), background pills in powerline mode.
5. Normal: `defaultSeparator` `' | '` (optionally inherits the colour of the neighbour via `inheritSeparatorColors`); powerline: `separators: ['', '']` arrows with fg = widget bg, bg = next widget bg, start/end caps (`startCaps`, `endCaps`), `separatorInvertBackground`.
6. Cycling position palette: `bg[i]` where themes have four hues; the fourth entry also flips fg (dark text on yellow/cyan).
7. Per-theme `fg` array pairs dark text with light backgrounds (e.g. `black` on yellow), a hand-chosen contrast per slot; no detection of terminal background.
8. Emoji in widgets (13 hits); Powerline glyphs from config.
9. `overrideForegroundColor`/`overrideBackgroundColor` global overrides, `flex-separator` widget.
10. JSON settings (zod `PowerlineConfigSchema` in `config.ts`), TUI inherited from ccstatusline (ink).

## gerardofc8/claude-subagent-statusline
https://github.com/GerardoFC8/claude-subagent-statusline (3 stars)
1. By threshold plus fixed. `scripts/statusline.js` `colorForPct(p)`: <50 green `\x1b[32m`, <80 yellow `33`, else red `31` (context bar, rate-limit percentages via `buildRateLimit`); other text uses the terminal default. `scripts/subagent-statusline.js` (agent panel rows): model `BOLD+CYAN`, effort/type/description/tail `DIM`.
2. Themes: not present.
3. Named ANSI 16 only (`\x1b[32m` etc.). No depth detection, no NO_COLOR.
4. Foreground-only.
5. Plain: `' │ '` between main groups and counters (`⚡ n · ✓ n · ✗ n`); `' · '` (`SEP`) between subagent row fields.
6. Separators and dim/bold weight.
7. Not present.
8. Emoji/symbols `⚡ ✓ ✗`; block bar `█░`; no ASCII mode.
9. Subagent task panel via `subagentStatusLine` with width-aware truncation (`visibleWidth`); `scripts/lib/width.js`.
10. No config file found for styling; auto-configure script edits settings.json.

## gregoryho/cc-pulseline
https://github.com/GregoryHo/cc-pulseline (3 stars)
1. By semantic role, state thresholds, and per-metric fixed accents. `docs/theme-palette.md`/`src/render/color.rs`: model identity `stable_blue` (111); git branch clean `stable_green` (71), dirty `*` `alert_orange` (214); ahead/behind `active_coral`; tools `active_cyan`, agents `active_purple`, todos `active_teal`; L2 metric icons each fixed `indicator_*` (CLAUDE.md steel 109, rules sage 108, memory lilac 182, hooks amber 179, MCP lavender 139, skills teal 73, duration rose 174); context `color_for_ctx_pct`: good <55, `active_amber` 55-69, `alert_red` >=70; quota `color_for_quota_pct` (warning >=50, critical >=85); burn rate `color_for_burn_rate` low <$10/h, med, high >$50/h magenta; effort `color_for_effort_level`: low structural, medium `stable_blue`, high `active_amber`, xhigh `active_coral`, max `alert_red`. Text hierarchy: four emphasis tiers primary/secondary/structural/separator (dark 251/146/103/238, light 234/240/246/253).
2. 18 bundled themes (`src/themes/*.json`: tokyo-night default, aburaya-twilight, cnc-telemetry, copper-noir, cyberdeck-hud, echo-sub-zero, mako-reactor, matte-carbon-neon, nd-ember, nd-flux, nd-glacier, nd-slate-jade, pulseline-aurora, signal-phosphor, stark-hud, titanium-precision, cyberpunk, ...). Format (`docs/theme-schema.json`): `palette_mapping` of ~34 named ANSI-256 role fields (emphasis_*, alert_*, active_*, stable_*, indicator_*, cost_*, optional strata_*, aurora_*, tag_label, head_*), plus `light_emphasis` overrides for a light variant (omitted fields fall back to dark values), documentation-only `colors`/`element_mapping`. Custom themes: drop JSON in `~/.claude/pulseline/themes/`, loaded at runtime; per-colour TOML overrides; CI lint requires `|strata_state - strata_activity| >= 3` on the 256 scale.
3. 256-colour indices (`\x1b[38;5;Nm`); powerline fills use 256 backgrounds (`bg_code`); truecolor deferred (`powerline.rs` header: "Truecolor is a later backend swap"). Honours `NO_COLOR` (README env table; layout tier `AsciiFloor` for `NO_COLOR` or `icons=false`).
4. Both by layout: most layouts foreground-only; `rail`/`anchor` layouts fill segments with 256 grey ramp backgrounds (`RAMP_*`, brightest `RAMP_HIGH=241` for the model anchor) and "tint" fills for alerts with `TINT_FG=16` near-black text.
5. Layouts `none`, `console` (frame), `rail` and `anchor` (powerline/capsule). Seam tiers by capability (`frames/powerline.rs` `tier`): `Powerline` PUA `\u{e0b0}/e0b2` with fg = left bg, bg = right bg; `Blocks` `▐ ▌`; `AsciiFloor` ` | `. Capsule caps angled or rounded `\u{e0b6}/e0b4` (`CapStyle`). Outer edges use `\x1b[49m` default bg so no terminal bg is needed.
6. Monochrome ramp of gray backgrounds in steps (3 `RampLevel`s), alert segments recoloured with a bright tint; separator tinted per row type (`strata_state` for state rows, `strata_activity` for activity rows when `layout.tonal_strata`).
7. Explicit `variant = "dark" | "light"` setting plus per-theme `light_emphasis`; warns on stderr if a light variant has high-luminance value fields (`main.rs`). No auto-detection of terminal background.
8. Nerd Font icons (`src/render/icons.rs`, `ICON_*` constants) with ASCII prefix fallback (`GlyphMode`, `icons = false`, `--no-icons`).
9. `--preview`, `--preview-layouts`, `--select-theme` (interactive), `--palette-map`; sparkline "aurora" gradient (`aurora_low/mid/high`); gauge/sparkline/plot widgets per segment.
10. `config.toml` (`theme`, `variant`, `icons`, `[layout]`, `[segments.*] visual`), CLI overrides (`--layout`, `--columns`, `--rows`), `COLUMNS`, `NO_COLOR`.

## gruku/claude-tools
https://github.com/Gruku/claude-tools (3 stars)
The statusline is `plugins/statusline/statusline.sh` (and a PowerShell twin); the repo also holds unrelated taskmaster tools (its `theme.js` is a web viewer).
1. Fixed per segment from a pastel palette plus gradient for urgency. `statusline.sh` lines 22-32: `cSand` 205;185;165 (directory/project path, `line1`), `cPeach` 195;160;155 (model, fast mode `↯`), `cLav` 165;150;200 (agent `⚙`), `cSage` 135;180;160 (staged `✔`, 5h reset), `cMauve` 185;140;160 (weekly reset), `cSalmon` 205;140;125 (modified `~`), `cSlate` 140;160;185 (git branch `⎇`), `cTeal` 115;195;195 (hosted-repo `⬡`), `cAmber` 235;195;80 (update `↑`), `cDim`/`cDimmer` greys. Context: five `■□` squares coloured by `grad_rgb` (green 130;190;150 -> amber -> red 210;95;85, breakpoints 60/80), brightness-modulated; limit bars `limit_grad_rgb` (muted green to 80%, then amber/red up to 100%, saturation rising). Account badge colour: per-account `statusline.config.json` (`sage amber orange teal mauve lavender salmon slate peach sand` or `#RRGGBB`), else a stable colour hashed from the account label (`accountHash`).
2. No themes: one fixed pastel palette; per-account colour only. Users cannot define themes (they edit the script).
3. Truecolor only (`38;2;R;G;B`); no 256 fallback or NO_COLOR found.
4. Foreground-only.
5. Plain: two spaces between groups; `│`-less layout.
6. Spacing and the hue per role; no alternation.
7. Not present for the bar; the scan's `lightdark.detection` hits are in the unrelated taskmaster viewer.
8. Unicode shapes (`■□`, `▰`, `◌ ○ ◎` focus ring, `⎇`, `⬡`, `◆`), OSC-8 hyperlinks on branch; emoji minimal.
9. Brightness-based "squares" and limit-bar pips with a time-budget marker (`pip_base_rgb`), leading cell gradient; compact line.
10. `~/.claude/statusline.config.json` (accounts, labels, colours), `install.sh`.

## hanliang97/claude-buddy-cn
https://github.com/hanliang97/claude-buddy-cn (3 stars) - Chinese localisation fork of 1270011/claude-buddy
A pet (ASCII-art companion with speech bubble) rendered in the statusline, not a metrics line.
1. One colour for the whole pet by rarity: `statusline/buddy-status.sh` lines 79-87: common `153;153;153`, uncommon `78;186;101`, rare `177;185;249`, epic `175;135;255`, legendary `255;193;7`; name line `DIM` (`\033[2;3m`); speech bubble border/text coloured separately (`BUBBLE_TYPES` border vs text). Comment: "pC4 = dark theme, the default" - the rarity colours are Claude Code's dark-theme palette values.
2. Themes: not present (README: `cyberpunk` scan hit is a species/biome name). The `cli/biomes.ts` set is world flavour, not colour themes.
3. Truecolor escapes (`38;2`) in the shell script; the TypeScript CLI (ink) uses 16-colour names (`color.fg_16=88`). No NO_COLOR; `COLORTERM` appears twice in the scan, not verified for its use.
4. Foreground-only.
5. Box-drawing speech bubble (`|` borders) and art; no segment separators.
6. n/a (single object).
7. `pC4` dark theme only.
8. ASCII/Unicode art (7000+ box-drawing glyphs in scan), emoji; CJK/emoji width fixed with Python `unicodedata.east_asian_width` (this fork's change).
9. Animated pet frames, reactions text translated; compact variant `buddy-status-compact.sh`.
10. MCP-server driven CLI (`cli/install.ts`, `pick.ts`, `tui.tsx`); no colour config.

## harunteper/claude-statusline
https://github.com/HarunTeper/claude-statusline (3 stars)
1. Fixed per segment plus threshold for usage bars. `statusline-command.sh` lines 99-128: model (and `[effort]`) `CYAN` (`\033[36m`); branch `GREEN`; context `ctx:NN% (used/total)` `MAGENTA`; session cost `BLUE`; reset times `↺` `YELLOW`; 5h/7d bars `make_bar` coloured by percentage (`>=80` RED, `>=50` YELLOW, else GREEN). Context is not threshold coloured.
2. Themes: not present.
3. Named ANSI 16 only. No depth detection, no NO_COLOR.
4. Foreground-only.
5. Plain two-space gaps; no separator glyph.
6. Different hue per segment.
7. Not present.
8. Block bar `[████░░░░]` (464 box glyph hits), `↺`; no emoji, no Nerd Font.
9. Version-update check cached 24 h.
10. None; edit the script (`install.sh` installs it).

## heathdutton/claude-dipstick
https://github.com/heathdutton/claude-dipstick (3 stars)
1. Mode-dependent (`COLOR_MODE=colored|perElement|single|monochrome`, `statusline.sh`). Default `colored`: usage/context bars are background-filled with a 10-step gradient chosen by percentage (`level_color`, `LEVEL_1`..`LEVEL_10`: Material green 400 `102;187;106` through lime, amber, orange to red 400 `239;83;80`), label knocked out in `BAR_TEXT_COLOR #1c1c1c`; every level checked for 4.5:1 contrast on the fill. Fixed per element in `colored`: folder `BLUE` (66;165;245), branch `GREEN`, worktree `TEAL`, profile `MAGENTA`. Model by family `MODEL_COLOR_*` (mythos `#DA627D`, opus `#9A348E`, fable `#D4AF37`, sonnet `#86BBD8`, haiku `#06969A`, "Starship Pastel Powerline"). `perElement` uses `ELEMENT_COLOR_*` (dir `#DA627D`, branch `#FCA17D`, worktree `#33658A`, model `#86BBD8`, profile `#9A348E`, context `#06969A`, separator `#585858`; usage/pace/weekly/extra empty = follow the gradient). PR badge by review state (green approved, red changes requested, grey draft, amber otherwise). Pace marker 6 tiers (green/cyan/amber/orange/red/purple). Prompt-cache flame: none while holding, amber late in TTL, red bold when cold.
2. Themes: no named themes; four colour modes plus the `ELEMENT_COLOR_*`/`MODEL_COLOR_*` keys in `~/.claude/statusline-config.local.txt` (shell `KEY=value`, sourced as a patch over defaults; exported env wins).
3. Truecolor for default palette (tints require truecolor: "A non-truecolor palette has nothing to tint and ignores it"); monochrome mode falls back to 256-index codes for pace (`38;5;208/160/135`) and `▓/░` blocks; `TERM`/truecolor detection greps show `env.256color=7`, `env.truecolor=8`. NO_COLOR: not found by name; `COLOR_MODE=monochrome` is the equivalent switch.
4. Both: solid background-filled bars with a dark track (`BAR_STYLE=solid`, track is a dark tint of the bar colour `BAR_TRACK_TINT=30`) vs `blocks`; rest foreground-only.
5. `section_separator` two spaces (`SECTION_SEPARATOR`). Bar end caps `BAR_CAPS=powerline|half|none` (rounded Powerline caps U+E0B6/E0B4, or `▐▌`); effort chevrons built from arrow-cap glyphs with background hand-off between the meter and the effort ramp.
6. Spacing and per-element hue; bar colours encode value, not identity.
7. Contrast-aware: every gradient level validated to keep dark text readable (comment lines ~920); bar text colour configurable; no terminal light/dark detection.
8. Nerd Font required (Material Design glyphs above U+F0000 chosen deliberately to avoid macOS BMP private-use fallback loss); `MODEL_STYLE=glyph|icon|name|both|full` and letter fallbacks for monochrome; `BAR_CAPS=half` for no-Nerd-Font.
9. Family shape as a model mark, effort drawn as lit chevrons/pill, pace marker on usage bars, subscript/superscript digits inside bars (`BAR_DIGITS`), OSC-8 links for folder/branch/PR/cache, auto bar width from `COLUMNS` (`BAR_WIDTH=auto`).
10. `statusline-config.local.txt` (dozens of keys: `SHOW_*`, `MODEL_COLOR_*`, `ELEMENT_COLOR_*`, `BAR_*`, `COLOR_MODE`, `SINGLE_COLOR`), env overrides, `tools/preview.sh`, `tools/enable.py`.

## hobeedzc/ccline-customcc
https://github.com/HoBeedzc/ccline-customcc (3 stars) - FORK OF Haleclipse/CCometixLine (default branch `yescode`)
Differences only (via `gh api compare master...yescode`, 4 commits ahead): adds a `Quota` segment (`SegmentId::Quota`, `src/core/segments/quota.rs`) for the YesCode proxy's API quota. Each bundled theme file (`theme_default`, `theme_cometix`, `theme_gruvbox`, `theme_minimal`, `theme_nord`, `theme_powerline_dark/light/rose_pine/tokyo_night`) gains a `quota_segment()` with icon `💰` / Nerd `\u{f155}` and fixed colours per theme, e.g. nord: icon and text RGB `208;135;112` on background `76;86;106`; powerline_dark: white `255;255;255` text on `85;85;85`. No other styling changes: theme list, TUI (`ratatui` colour picker) and the rest are the parent's.

## hwwwww-dev/pulse
https://github.com/Hwwwww-dev/pulse (3 stars)
1. Per-item user colour, slot palette by position under powerline, dynamic colour for thresholds. `src/config/themes.ts`: `minimal` (no colour), `pastel` (all items `#C792EA`), `powerline`. Powerline (`src/render/engine.ts` `renderPowerlineLine`): an item's `style.color` wins, otherwise the bg is `pl.palette[slots.length % length]` over visible items only ("hidden items don't consume a palette slot so colors stay packed"). Palette `POWERLINE_SLOT_BGS` in `src/config/palette.ts`: `#B05360, #B8792D, #6C8A41, #7A5B96, #4D8077, #4B7B9D, #8C4A62, #8C5340` (Kanagawa-adjacent), forced fg `#FFFFFF` bold. Item options `dynamic_color: true` make context/cost bars shift green->yellow->red at tunable thresholds; sub-parts (label, bar, value) styled independently.
2. Three themes (minimal, pastel, powerline) in `THEMES`; theme = `{ defaults: { itemStyle, lineBg? }, powerline?: { palette[], arrow, fg, padding } }`; user theming through per-item colours. A 24-colour picker palette (`PALETTE_ROWS`: accents, pastels, warm-grey neutrals), with `FG_TO_BG_COLOR`/`BG_TO_FG_COLOR` maps so a colour picked under one theme mode is translated to its sibling under the other (fg accent column <-> slot bg column). Custom hex passes through.
3. `detectColorLevel()` in `src/render/ansi.ts`: `NO_COLOR` -> none; `COLORTERM` truecolor/24bit -> truecolor; `TERM` containing "256" -> 256; any other TERM -> 16; unset -> truecolor. Hex downsampled to the 6x6x6 cube (`to256Index`); named colours (`red`, `bright-black`...) supported.
4. Both: classic themes foreground (optional per-line background `line.bg`), powerline fills.
5. Classic: per-item configurable separators. Powerline: arrow `` fg = previous slot bg, bg = next slot bg, padding 1.
6. Powerline: cycling eight hues by visible-slot index. Classic: the user's per-item colours.
7. Powerline forces white bold fg on the slot bgs, whose darkness (e.g. `#6C8A41`) is chosen to hold it. No terminal-bg detection.
8. Nerd Font icon catalogue (`src/ui/data/iconCatalog.ts`, `IconPickerModal.tsx`; 126 Nerd hits), emoji.
9. Blink/reverse glow effects on threshold items (`blink`, `reverse`, `glow`), animated; gradient hits in the colour ramp.
10. `~/.pulse/config.json` plus Ink TUI editor with live preview, colour picker, icon picker, threshold tuner, drag-reorder.

## iamcxa/kc-claude-plugins
https://github.com/iamcxa/kc-claude-plugins (3 stars)
A plugin marketplace; the only statusline is `kc-hyperfocus/hooks/scripts/hyperfocus-statusline.js` (set up by the `kc-statusline-setup` skill).
1. By threshold and fixed: context bar (`██░░` x10) green `\x1b[32m` <50%, yellow `33` <65%, orange `38;5;208` <80%, blinking red `\x1b[5;31m` with a skull emoji >=80%; branch magenta `35`; model and directory `DIM`; usage `5h:`/`7d:` labels dim with percentages green (`22;32`) in the fallback; or an external `quota-statusline.sh` output.
2. Themes: not present.
3. ANSI 16 plus one 256 index (208 orange). No depth detection, no NO_COLOR.
4. Foreground-only.
5. Plain `│` (U+2502) between model, dir and usage sections; spaces elsewhere.
6. Separators plus dim vs colour.
7. Not present.
8. Emoji skull `💀`, block bar; no Nerd Font.
9. Blink on critical context; writes a context bridge file to `/tmp/claude-ctx-<session>.json`.
10. None; script edited by hand.

## ibragimov-oasis/vibe-coder
https://github.com/ibragimov-oasis/vibe-coder (3 stars)
A large content kit; statuslines inside are mostly vendored third-party scripts (ruflo, GSD) plus its own.
1. Own statusline `vc-kit/configs/vc-claude/helpers/statusline.cjs`: no colour (plain emoji text `📝 N files | ✅ N tasks | 🤖 N agents | 🔧 Vibe-Coder`). Vendored GSD `gsd-statusline.js`: context bar green `32` <50%, yellow `33` <65%, orange `38;5;208` <80%, blinking red + `💀` above; update notice yellow, stale hooks red; model/dir dim, task bold. Vendored ruflo `statusline.cjs` (`core-ruflo/claude/helpers`): fixed colours per segment from a `c` table of ANSI 16 incl. bold bright variants: header bold bright-purple `▊ RuFlo V3`, repo name bright-cyan, branch bright-blue `⎇`, staged `+` bright-green, modified `~` bright-yellow, untracked `?` dim, ahead green / behind red, model purple, duration cyan, intelligence `●` by `intellColor`, agents bright-yellow `◉`, hooks bright-green, MCP `mcpCol`.
2. Themes: not present in the statusline code (the scanned `theme-*` hits are web UI components).
3. ANSI 16 (`\x1b[0;3Xm`, `1;3Xm`) and one 256 index. No downsampling, no NO_COLOR.
4. Foreground-only.
5. Plain `|` (own) or dim `│` (ruflo, GSD).
6. Separators and colour per segment type.
7. Not present.
8. Emoji (103 hits) and box-drawing glyphs.
9. Kit bundles many unrelated statuslines (`statusBar.ts` VS Code extension views, web `StatusBar.tsx` components are not Claude statuslines).
10. JSON progress file `.claude/.session-state.json` read by own script; scripts edited in place.

## jeancarlo-javier/claude-status-bar
https://github.com/jeancarlo-javier/claude-status-bar (3 stars)
1. By phase label (semantic palette) and thresholds. `README.md` "Phases and colors" (256-colour): `Research:`/`Explore:`/`Analysis:` 176 orchid; `Plan:`/`Planification:` 111 blue; `Review-Plan:` 141 lavender; `Exec:` 220 gold; `Q&A:`/`Review:`/`Critique:` 208 orange; `Verify:` 80 cyan; `Done:` 114 green; `Debug:`/`Fix:`/`Blocked:` 203 red; `Focus:` 213 pink; `Chat:` 117 sky; `Docs:` 109 slate; `Needs-Review:` 226 yellow as a reverse-video chip (dim past 90 min); unknown labels bold grey 250. Only the label is coloured, subject plain. `bin/claude-code-status.js`: context/usage gauge `▁▂▃▄▅▆▇█` with colour by percent (<40 green, 40-59 yellow, 60-79 `38;5;208`, 80-94 red, >=95 blinking red); session time green <30 min, yellow <=90, red; cost green <$3, yellow <=$6, red; tokens/s green >=60, yellow >=30, red; intelligence score colours 245/220/114/51/201 by band; effort `effortColorMap` truecolor (low `#F5C344`, med `#6CB86E`, high `#B3B9F4`, xhigh `#B388F4`, max animated `rainbow`). Brackets and `@` grey 245.
2. Themes: not present; one semantic palette.
3. Mostly 256-index, ANSI 16 and truecolor for effort. No detection, no NO_COLOR found.
4. Foreground-only (reverse-video chip for waiting).
5. Plain: `[ ] · @` in grey 245; lines `L1`, `L2`.
6. Colour per phase/metric; grey punctuation.
7. Not present.
8. Block gauge glyphs, emoji (21 hits); no Nerd Font.
9. Animated rainbow on `max` effort (`rainbow()` cycles per render); sets terminal tab title (OSC 0) and a Warp tab colour via OSC 7 directory mirror; blink at >=95%; screenshot generator `bin/make-screenshot.js`.
10. Skill/hook driven phase file `~/.claude/session-context/<sid>`; no colour config file.

## jerryfan626/claude-statusline
https://github.com/JerryFan626/claude-statusline (3 stars)
1. Fixed per element plus threshold. `statusline-command.sh`: model `CYAN`+bold, context bar and percentages by `pct_color` (<50 GREEN, <80 YELLOW, else RED), vim mode BLUE (NORMAL) / GREEN, rate-limit rows with `DIM` labels and `pct_color` percentages, reset time dim; above a context threshold a `BG_RED`+`WHITE_BOLD` ` CTX nn% ` badge (line 290).
2. Two palettes, dark and light (`detect_theme`): light uses `DIM=\033[90m` (bright black) and `WHITE_BOLD=\033[1;30m`; dark uses `DIM=\033[2m` and `\033[1;37m`; other colours (cyan/green/yellow/red/magenta/blue) identical. No named user themes.
3. ANSI 16 only (`\033[3Xm`, `41` bg). No depth detection, NO_COLOR: not present.
4. Mostly foreground; one red background badge.
5. Plain separator `SEP` between items; two lines.
6. Hue per element plus separators.
7. Light/dark adaptation: `STATUSLINE_THEME=dark|light|auto`; auto checks macOS `defaults read -g AppleInterfaceStyle` (only returns dark; absence falls through) then `COLORFGBG` (background index <8 = dark); default dark. Only dim and bold-white text change.
8. `STATUSLINE_ICONS=ascii` (default; `⚡ ◧ 📂 ⎇ ⚠`, "VIM") or `nerd` (md-robot, memory, folder, branch, cash, etc.).
9. Two-line layout.
10. Env vars `STATUSLINE_THEME`, `STATUSLINE_ICONS`; `install.sh`/`uninstall.sh`.

## karneeshkarv/ai-usage-bar
https://github.com/KarneeshkarV/AI-Usage-Bar (3 stars)
not a Claude statusline: a Rust CLI reporting AI usage (Codex, Claude, Grok, Cursor, OpenCode) as Waybar JSON (`ok`/`warn`/`crit`/`stale` CSS classes), a `ratatui` TUI popup (hard-coded Catppuccin Mocha constants in `src/cli/tui.rs`) and local cost reports.

## lamclaw/ccline-setup
https://github.com/lamclaw/ccline-setup (3 stars)
Installer/skill for CCline/CClineBar (a CCometixLine variant); ships its TOML themes.
1. Fixed per segment id per theme (`themes/*.toml`, `[[segments]]` with `id`, `colors.icon/text/background`). powerline-dark backgrounds: model `45,45,45`, directory `139,69,19`, git `64,64,64`, context_window `55,65,81`, usage `45,50,59`, cost `40,44,52`, session `45,50,59`, output_style `50,56,66` (white `255,255,255` icon and text). default.toml (plain): text colours as 16-colour indices `c16`: model 14, directory 10 (icon 11), git 12, context_window 13, usage 14, cost 3, session 2, output_style 6. No threshold colouring in these files.
2. Nine themes: default, minimal, cometix, gruvbox, nord, powerline-dark, powerline-light, powerline-rose-pine, powerline-tokyo-night (`themes/*.toml`). Format = whole config per theme: `theme`, `[style] mode = plain|nerd_font`, `separator`, segment list with per-segment `colors.{icon,text,background}` as `c16 = n`, `c256 = n` or `r,g,b`. Users can edit/copy TOML.
3. ANSI 16 (`c16`), 256 (`c256`) and RGB per colour spec; default theme 16-colour. No NO_COLOR (in the TOML layer).
4. Both: `default`/`minimal` plain foreground; powerline themes set `background` per segment.
5. `default.toml`: `separator = " | "`; powerline themes use a Powerline arrow glyph as `separator` (`style.mode = "nerd_font"`).
6. Powerline themes: a small lightness spread of near-greys (model `45` -> git `64` -> usage `45,50,59`), with directory the single brown accent `139,69,19`; the plain theme uses distinct hues.
7. Separate `powerline-light` theme chosen by the user; no detection.
8. Per segment `icon.plain` (emoji `🤖 📁 🌿 ...`) and `icon.nerd_font`, picked by `mode`.
9. None beyond the underlying CCline TUI.
10. TOML themes copied into `~/.claude/ccline/themes`, `ccline-wrapper.sh`, `install.sh`; the underlying binary is leo919cc/CClineBar.

## lucaswebsystems/openlimiter
https://github.com/lucaswebsystems/openlimiter (3 stars)
A usage/limits tracker whose CLI also renders a Claude Code statusline (`packages/cli/src/statusline.ts`, `render.ts`).
1. By pressure band of the reading. `render.ts` `BAND_CODE`: healthy `32` green, watch `33` yellow, urgent `33` yellow (or `38;5;208` orange when 256 colour is available, `bandCode`), critical `31` red, none/stale `90` grey; all bars and percentages go through `paintBand` so a reading is one colour everywhere. Failures `RED`. Stale readings grey with `~`. Labels uncoloured.
2. Themes: not present in the CLI (the web app `apps/web/lib/theme.ts` / `theme-toggle.tsx` is the marketing site's light/dark).
3. ANSI 8 + one 256 index (orange 208). `supportsColor()`: `NO_COLOR` (any value) or non-TTY disables; `supports256Color()`: `TERM` containing `256color` or any `COLORTERM`. Graceful degrade: urgent shows yellow on 8-colour terminals.
4. Foreground-only.
5. Plain gap strings between cells; header lead; no glyph separators.
6. Spacing and row layout only.
7. Not present (palette is the 8 base colours so the terminal theme decides actual hues).
8. Ten-block bars with eighth-block sub-cell resolution (`supportsEighthBlocks`; ASCII blocks on Windows consoles without WT_SESSION and with NO_COLOR); no emoji.
9. Width-budget fitting of bar style vs legacy cells style; provider flag icons only in the web demo.
10. `StatuslineConfig` (`config.ts`: bars, captions, colour settings `StatuslineColor`), env `NO_COLOR`, `TERM`, `COLORTERM`; wrapper to chain another statusline.

## luodashiv5/please_answer_this_era_5.0
https://github.com/LuodashiV5/please_answer_this_era_5.0 (3 stars)
A personal grab-bag repo (Obsidian vault with themes, skills, RAG scripts). The only Claude statusline is the skill script `claude-code-skills/statusline-generator/scripts/generate_statusline.sh`.
1. Fixed per segment with a git state switch. `generate_statusline.sh` last `printf`: username bold green `\033[01;32m`, `(model)` bold cyan `01;36`, cost `[$session/$daily]` bold magenta `01;35` (ccusage), path bold white `01;37`; git `[git:branch]` yellow `01;33` when clean, red `01;31` when dirty (`*`/`+`).
2. Themes: not present (the "Blue Topaz" hit is an Obsidian theme).
3. ANSI 16 (bold + 3x codes). No detection, no NO_COLOR.
4. Foreground-only.
5. Plain spaces; three lines (`username (model) [costs]`, path, `[git:branch]`).
6. Hue per segment and line breaks.
7. Not present (comment: bright white path "for better visibility").
8. No icons; text only.
9. Three-line layout for portrait screens; 2-minute ccusage cost cache.
10. None; script edited by hand (installed by `install_statusline.sh`).

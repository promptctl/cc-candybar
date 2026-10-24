# Batch 05: styling read from source

Anchors are file plus line or key, read from each repo's default branch (raw.githubusercontent.com) on 2026-10-24.

## cc-pretty-statusline
https://github.com/minoism/cc-pretty-statusline (21 stars)
1. Fixed per segment, plus threshold for bars. `bin/statusline.sh:380-432,561-571`: model `blue`, model-context suffix `blue_dim`, git label `white_dim`, git `+n` green / `-n` red / `?n` yellow, session duration icon `blue` + text `white`, `5h` limit `cyan`, `7d` limit `magenta`, cost `yellow`, extra-usage `white_dim`, version `ctx_info`. Context bar and % use `color_for_pct` (`:227-234`): <50 green, 50-69 orange, 70-89 yellow, >=90 red.
2. Two palettes, selected by light/dark, not user-named themes: Catppuccin Latte for light (`:172-193`), a hand-picked pastel set for dark (`:195-215`). Each palette has about 20 named slots (blue, blue_dim, orange, orange_bright, orange_dim, orange_dark, green, green_dim, cyan, cyan_dim, red, yellow, yellow_dim, white, white_dim, magenta, magenta_dim, pink, pink_dim, ctx_info, sep_color); every colour has a `_dim` twin. Users cannot define palettes except by editing the script.
3. Truecolor only (`\033[38;2;R;G;Bm`, all 45 hits are foreground). No downsampling, no COLORTERM or NO_COLOR check (grep finds none).
4. Foreground-only on the terminal's own background. No background fills.
5. Plain `│` separator (`:219-223`): `sep_color` in light mode, the `dim` attribute (`\033[2m`) in dark mode (`:215` comment "rely on terminal dim attribute").
6. Neighbours are told apart by hue (blue, cyan, magenta, yellow per segment) and `│`; a segment never changes hue by position.
7. This is its main feature. Light/dark is detected: `CLAUDE_STATUSLINE_THEME` env pin (`:98`), then `--set-theme light|dark|auto` override file (`:23-36,102-110`), then `CLAUDE_STATUSLINE_BG_HEX` classified by Rec.709 luminance > 128 (`:81-91,112`), then a per-window cache with 3 s TTL (`:78,120-131`), refreshed in the background from macOS `AppleInterfaceStyle` (`:148-166`), default dark. `--probe-bg` (`:1-11`) asks the terminal for its background via OSC 11 from the shell rc and exports the hex. Dim variants are "brightness matched" per comment (`:174,189,191`). No computed contrast ratio.
8. Nerd Font glyphs for git/duration/reset (`󰔟`, `󰑐`, `:432,562`); bars use `━` filled and `┅` empty (`build_bar`, `:236-249`). No ASCII fallback found.
9. Unfilled bar cells are drawn with `dim`, not a second colour (`:247`).
10. Env vars (`CLAUDE_STATUSLINE_THEME`, `CLAUDE_STATUSLINE_BG_HEX`), `--set-theme`, `--probe-bg`; `bin/install.js:97-129` takes `--theme auto|light|dark` and bakes the env prefix into the statusLine command. No config file.

## codex-statusline
https://github.com/Moviw/codex-statusline (21 stars). Serves Codex (tmux status) and Claude Code (`target` in `src/render.py`, `ansi=True` path).
1. By state/threshold via three roles. `src/render.py:210-224`: `_context_role` is accent below 60, warning at 60-79, critical at 80+; `_quota_role` (remaining %) is critical at or below `crit_at` (20), warning at or below `warn_at` (40), else accent. Model, tokens, git branch, usage line and "lasts to reset" pace text are always `accent` (`:292,301,373,379`); the update hint is `warning` (`:398`).
2. Three themes in `THEMES`/`_PALETTES` (`:17-27`): `auto`, `dark`, `light`. Semantic roles only (accent, warning, critical). Palette values: auto `colour33/172/160`, dark `colour75/220/196`, light `colour25/130/160`. `THEMES` also holds tmux `status-style` bg/fg for dark (`bg=#202431,fg=#d5dceb`) and light (`bg=#f1f3f7,fg=#253047`); `auto` is `bg=default,fg=default`. Not user-extensible; theme picked by config `theme` or `CODEX_STATUSLINE_THEME` (`:31,89`).
3. 256-colour indices only. `_paint` (`:321-329`) emits `\x1b[38;5;Nm` for Claude Code, `#[fg=colourN]` for tmux, or plain text. No downsampling, no NO_COLOR; `CODEX_STATUSLINE_ASCII=1` strips non-ASCII (`:91`).
4. Foreground-only for the segments. The tmux theme sets the bar's background itself.
5. Plain text `" | "` (`:309`), uncoloured.
6. Not distinguished: nearly every part is `accent`; only state changes colour.
7. The `auto` palette is described in a comment (`:23`) as "mid-tone colors ... readable on white and black backgrounds". No detection.
8. Unicode default (`⎇`, `·`, bar), `ascii` mode swaps in `git:`, `-`, `~` (`:170,296-298,312`).
9. Width-driven tiers drop parts when narrow (`:380-400`). Colour carries only severity.
10. TOML config at `$XDG_CONFIG_HOME/codex-statusline/config.toml` (`:42`), keys: `segments`, `theme`, `ascii`, `warn_at`, `crit_at`, `line2` (`_CONFIG_DEFAULTS`, `:28-37`); env overrides; a `src/configure.py` exists (not read, so unverified what it offers).

## claude-hud-fix
https://github.com/MUST-panxiao/claude-hud-fix (21 stars)
1. By threshold, one segment only. `context-status.sh:122-136` and `context-hud-wrapper.sh:134`: pct <50 `\033[32m` green, <75 `\033[33m` yellow, else `\033[31m` red; the colour applies to the bar and the percent. Label `CTX` / `上下文` is plain or `\033[2m` dim.
2. Not present.
3. ANSI 16 only (32/33/31/2). No depth detection, no NO_COLOR.
4. Foreground-only.
5. Not present (single segment).
6. Not applicable (one coloured segment; the rest of the HUD output is passed through from claude-hud unchanged, `wrapper.sh:140-166`).
7. Not present.
8. 20-cell block bar: `█` (9608) filled, `░` (9617) empty (`context-status.sh:132-133`). Wrapper localises label to Chinese.
9. It is a patch that replaces claude-hud's context line with a transcript-based estimate (`CLAUDE_SYSTEM_OVERHEAD`, `CLAUDE_CONTEXT_WINDOW` env vars).
10. Two env vars above; otherwise none.

## claude-skins
https://github.com/basicScandal/claude-skins (20 stars)
1. Mostly one accent for everything, plus fixed thresholds. `engine/statusline.sh:122-147`: model name and the skin icon use `ACCENT`; `|` separators, `⎇` and the branch glyph use `DIM`; context bar cells use `BAR_FILL` / `BAR_EMPTY`; the percent is hard-coded `\033[31m` red at >=90, `\033[33m` yellow at >=70, else `\033[32m` green; `+N`/`-N` lines are hard-coded green/red. Directory, cost and branch name are uncoloured.
2. Ten skins in `skins/`: default, brutalist, grimoire, mission-control, mythos, nebula, netrunner, noir, retro86, sensei. YAML format (`skins/netrunner.yaml`): `terminal` block (background, foreground, cursor, 8-colour ANSI `palette`: black, red, green, yellow, blue, magenta, cyan, white), `statusline` block (only `accent`, `dim`, `bar_fill`, `bar_empty`, `icon`), plus `branding`, `personality`, `tools.sounds`. The statusline reads only the five `statusline.*` keys (`statusline.sh:78-100`). Users can add a YAML file to `~/.claude/skins/`; a custom YAML parser lives in `engine/parse-yaml.sh`.
3. Truecolor only for the statusline, from hex via `hex_to_ansi` (`:102-108`), `\033[38;2;R;G;Bm`. No depth detection, no NO_COLOR. The terminal block is applied separately with OSC sequences.
4. Foreground-only in the statusline.
5. Plain `|` in `DIM`.
6. Separators only; one accent colour for the leading label and the model.
7. Not present for the statusline. Skins that set `terminal.background` re-colour the whole terminal (`engine/activate.sh:64-76`: OSC 11 background, OSC 10 foreground, OSC 12 cursor, OSC 4;0-7 palette) so the statusline always sits on a background the skin chose. `default` skin leaves the terminal alone.
8. Skin-specific icon (netrunner `⟐`, default `>`), `⎇`, bar `▓` / `░` (`:117-118`). Emoji in banners. No fallback modes.
9. Heavy theatre outside the statusline: per-skin ASCII/braille banners with per-line RGB gradient (`skins/netrunner.yaml` banner), sound effects hooks (`engine/play-sound.sh`), tool-call prefixes (`skin-tool-hook.sh`), generated screenshots (`generate_screenshots.py` uses `rich`).
10. `engine/current` file names the active skin; `install.sh` / `activate.sh` / `deactivate.sh`; slash-style commands via `skin-command-hook.sh`. YAML only.

## claude-code-status-bar
https://github.com/briansmith80/claude-code-status-bar (20 stars)
1. Fixed per segment plus threshold and by-tier model colour. `statusline-command.sh:996-1046` `apply_palette` assigns 18 roles by positional hex list: dir, branch, model, opus, fable, add, del, warn, info, dim, bar_ok, bar_med, bar_high, pace, ramp0-3. Model coloured by tier (`:2044-2053`): Haiku = add (green), Sonnet = warn (yellow), Opus = orange (`CLR_MODEL_OPUS`), Fable/Mythos = purple, else the theme's model colour. Bars (`:1898-1905`): <50 `bar_ok`, 50-79 `bar_med`, >=80 `bar_high`. Default theme: dir cyan, branch magenta, model blue, add green, del red, warn yellow, info cyan, dim `0;90`, pace `38;5;199`.
2. Eight themes (`:870`): default, nord, dracula, solarized, tokyo-night, catppuccin, matrix, mono. Format: a role-per-slot hex list inside `apply_palette` calls (`:1002-1014`), each theme "spread across a saturation/temperature ladder so no two read alike" (`:998-999`). `matrix` is monochrome "separated by brightness". Selected via `colour_theme` in `statusline.conf`, env `STATUSLINE_THEME` wins (`:657-668`). User-defined palettes: the conf file is sourced as bash (`:652-654`), so a user can reassign `CLR_*`, but there is no palette file format.
3. Truecolor when `STATUSLINE_TRUECOLOR=1` or `COLORTERM` contains truecolor/24bit (`:922-930`); otherwise `tc_clr` (`:957-968`) downsamples hex to the nearest 256-cube index in pure bash. `NO_COLOR` forces `mono` (`:920`), which empties every colour variable.
4. Foreground-only text. Progress bars are `█` blocks in colour.
5. Two spaces between segments (`seg_sep="  "`, `:2590`); `SEP` of dim `|` appears elsewhere. Separators uncoloured beyond `dim`.
6. Neighbours differ by role colour (directory cyan, branch magenta, model blue, add/del, warn); in `matrix`, by brightness. A "Scanner" and "pulse" animation exist for the activity line (`activity_pulse`, `activity_scanner`, `:640-641,1446`).
7. Not detection-based. `NO_COLOR` only. The `dim` attribute is the de-emphasis tool.
8. `use_icons` (default true), `icon_set` `classic` | `modern` (`:604-608`) with glyphs such as `◆`, `▸`, `↱`, `⑂`, `⇄`, `⏱`. Emoji not default. No Nerd Font.
9. Gradient bars: `bar_gradient=true` interpolates a colour per filled cell across the four `ramp0-3` stops with integer lerp (`:626-629,1909-1944`); `heat` option uses a fixed green-yellow-orange-red ramp on any theme. `--demo [theme|all]` prints a canned scene per theme (`:866-885`); README SVG per-theme screenshots made by `docs/assets/themes/generate-theme-demos.sh` plus `ansi-to-svg.js`; animated demo GIF and hero (`docs/assets/generate-*.js`).
10. `statusline.conf` (bash-sourced key=value: `colour_theme`, `bar_gradient`, `bar_width`, `layout` `classic|three-line|stacked`, `line1..3` token lists, `dir_style`, `use_icons`, `icon_set`, `show_*`, `context_warn_threshold`, `max_width`), `--demo`, `--dump-config`, env `STATUSLINE_THEME`, `STATUSLINE_TRUECOLOR`. Installers for sh and PowerShell.

## claude-mnemonic
https://github.com/lukaszraczylo/claude-mnemonic (20 stars)
1. Fixed, by state. `cmd/hooks/statusline/main.go:66-73,165-212`: prefix `[mnemonic]` cyan (`[m]` compact), online indicator `●` green, offline `[mnemonic]` and `○` gray, starting `○` yellow, stat fields uncoloured. Not a general-purpose bar: it shows memory-plugin stats.
2. Not present.
3. ANSI 16 constants (green 32, yellow 33, cyan 36, gray 90, red 31). `NO_COLOR` honoured, `TERM=dumb` disables, `CLAUDE_MNEMONIC_STATUSLINE_COLORS=true|false` forces (`:132-138`, `:252`).
4. Foreground-only.
5. Plain ` | ` in gray (`:204`).
6. Gray separators only; fields share the default colour.
7. Not present.
8. `●` / `○`; three formats default / compact / minimal (`formatDefault`, `formatCompact`, `formatMinimal`). No emoji or Nerd Font.
9. Nothing further.
10. Env var above. Which of the default, compact and minimal formats is used is decided in `formatStatusLine` (`:127-160`); the selector was not traced.

## centminmod/claude-plugins
https://github.com/centminmod/claude-plugins (18 stars). Only `plugins/desktop-statusline` is styling-relevant; `session-metrics` is an HTML/chart report tool, not a statusline.
1. By threshold. `plugins/desktop-statusline/hooks/register.tsx:46`: `tone(percent)` is `'error'` at >=95, `'warning'` at >=80, otherwise no colour (default text). Used on the context and limit percentages (`:323`). Everything else is `dimColor` (`:396,409,423,427,441`) unless it needs attention: `color='warning'` on `emphasis === 'warning'` items and on failed workflow counts (`:412,435`).
2. Semantic roles only, supplied by the host (`'warning'`, `'error'`); the mod owns no palette. Themes follow Claude Desktop's own.
3. Not applicable: it is a Claude Code mod drawing React/Ink-style `<Text>` in the Desktop app, not ANSI. Bars are inline SVG with fixed hex `#e5484d` (>=95), `#e0a030` (>=80), `#2f7de1` otherwise, track `#808080` at 0.3 opacity (`:50-58`), because "Drawn as an image, so it cannot follow the theme".
4. Both: foreground text plus SVG bars with rounded (`rx`) ends.
5. `' · '` dim text (`:409`).
6. Dim vs normal text and per-line layout (four lines). No hue per segment.
7. Host theme handles light/dark; the SVG track uses translucent grey to read on both (comment `:50`).
8. Emoji agent states `⋯ ⏳ ⏸ 💤` (`:24`), 🌳 for worktree, `🔎 advisor`.
9. Desktop-only band above the prompt; threshold toasts at 80 and 95 per README. Screenshot `images/desktop-statusline.png`.
10. No user styling config found; `plugin.json` and `hooks.json` only.

## claudemeter
https://github.com/hyperi-io/claudemeter (18 stars)
not a Claude statusline: a VS Code extension (status bar item) that monitors Claude Code usage. For reference, its colours are by tier, `src/tk/colorMap.js:20-47`: warning `#cca700` (VS Code theme id `charts.yellow`), error `#cc4540` (`claudemeter.outageRed`), `rotLight #6ca0c4`, `rotDeep #4279a1`, `normal` = no decoration. Three-layer resolution in `src/colorResolver.js:14-47`: user hex setting `claudemeter.colors.<tier>` (regex `^#[0-9a-fA-F]{6}$`), else `vscode.ThemeColor`, else the fallback hex. A continuous OKLab "context rot" gradient runs from `#eef5fc` to `#163a63` (`ROT_GRADIENT`). `statusBar.colorMode` is `color` or `basic`.

## claude-epic-status-line
https://github.com/dsebastien/claude-epic-status-line (17 stars)
1. Fixed per role plus severity escalation. `statusline.sh:88-101`: text `220;220;220`, dir `86;182;194`, agent `180;140;255`, model by family (`:418-422`): opus `180;140;255`, sonnet `0;153;255`, haiku `64;200;180`, fable/mythos `240;190;60`, other `0;153;255`. Escalation `state_rgb` (`:210-217`): ok `0;175;80` below `CESL_WARN` (70), warn `230;200;0` from 70, high `255;176;85` from 80, crit `255;85;85` from 90. Used for context percent, bars, cost (`:508-509`), per-turn tokens (`:410-411`), rate limits (`:767`). Context text is dim while healthy (`:524`).
2. One built-in palette, fully overridable per role through env vars: `CESL_COLOR_TEXT/OK/WARN/HIGH/CRIT/DIR/AGENT/OPUS/SONNET/HAIKU/FABLE/MODEL` as `"R;G;B"` strings. No named themes. `video/src/theme.ts` mirrors the palette for the promo video ("mirrors statusline.sh's default 256-colour theme").
3. Truecolor only (`\033[38;2;...`). `CESL_COLOR=auto|1|0`; auto honours `NO_COLOR` and `TERM=dumb` (`:126-132`). No downsampling.
4. Foreground-only.
5. Plain `│` (`sep`, `:168`), dim; `·` dot for sub-separators.
6. Different hues per role plus dim `│`; no alternation.
7. Not present beyond the overridable palette and NO_COLOR.
8. Three glyph sets via `CESL_GLYPHS` (`:59,137-152`): `unicode` (default), `nerd`, `ascii` (`|`, `#`, `.`, `!`, `~`, `^`, `v`). Bar width `CESL_BAR_WIDTH` 1-200.
9. Remotion promo video in `video/` with the same palette. Effort glyphs `● ◑ ◔` in unicode mode.
10. All config by `CESL_*` environment variables (thresholds `CESL_WARN/HIGH/CRIT`, `CESL_CTX_WARN/HIGH`, colours, glyphs, bar width, currency symbol); a diagnostic dump line prints `colour: enabled|disabled` with the env values (`:872`).

## claudecode-statusline (caveman)
https://github.com/FahimFBA/claudecode-statusline (17 stars)
1. Fixed per segment plus thresholds. `hooks/caveman-statusline.sh:44-55,72-132,182-187`: caveman badge `38;5;172` (orange), project `38;5;75` (blue), branch `38;5;114` (green), model `38;5;183` (lavender), separator `38;5;240` grey ` │ `, savings `38;5;172`. Used-percent colour (`:44-46`): >=80 `196` red, >=50 `220` yellow, else `114` green; remaining-percent colour (`:53-55`) mirrored (<=20 red, <=50 yellow). Effort (`:125-130`): low 244 grey `▁`, medium 75 blue `▄`, high 220 yellow `▇`, xhigh 208 orange `█`, max 196 red `█`.
2. Not present.
3. 256-colour indices only; no detection, no NO_COLOR.
4. Foreground-only.
5. Plain ` │ ` in 256-colour grey (`:187`).
6. Hue per segment plus grey separator.
7. Not present.
8. Emoji-heavy (🪨 🤖 📁 🌿 ⚡), block-height glyphs for effort.
9. A hook-driven "caveman mode" badge (`caveman-mode-tracker.js`) and a savings counter are the unusual parts; the statusline is branded for that mode.
10. No config file for colours; `caveman-config.js` configures the mode, not styling.

## ijfw
https://gitlab.com/therealseandonahoe/ijfw (17 stars)
1. No colour for everything. `claude/hooks/scripts/ijfw-statusline.js:90-176` emits plain text: `##########.. 62% left` bar of `#` and `.`, and `^ <version> available`. No ANSI escape appears in the file (grep for escape sequences, `color`, `NO_COLOR`: none).
2. Not present.
3. None; ASCII only.
4. Neither (uncoloured text).
5. Plain `  |  ` (`fitToBudget`, `:130-133`).
6. Separator only.
7. Not present.
8. ASCII only (`#`, `.`, `^`); this is deliberate (fail-open, 80-char budget `WIDTH_BUDGET`).
9. Context percentage is autocompact-aware: `100 - ((remaining - 16.5) / 83.5) * 100` (`:92-95`). `context_bar.style` is `left` / `runway` / `classic`, changes wording only.
10. `~/.ijfw` `settings.json`: `statusline.enabled` (`off`) and `context_bar.{enabled,style}` (`:107-122`). Composes with an existing statusLine command (header comment). `scripts/dashboard/render.js` is a separate dashboard, not read.

## oh-my-claude
https://github.com/ssenart/oh-my-claude (16 stars)
1. Fixed per segment, via an oh-my-posh theme. `src/claude-statusline.omp.json`: path bg `#ff6b35` orange, git bg `#fffb38` yellow (state templates below), context (`CLAUDE_CONTEXT`) `#00897b`, code usage `#00d9ff`, pro usage `#ff8c94`, reset `#9d4edd`, model `#3a86ff`. Foreground `#ffffff` everywhere except git (`#193549`). Git bg switches by state via `background_templates`: working/staged changed `#ff9248`, ahead and behind `#f26d50`, ahead `#f17c37`, behind `#89d1dc`. Usage values are env vars set by `src/statusline.sh`; the colours do not change with the value.
2. One theme file (an oh-my-posh JSON); users can swap in any oh-my-posh config because `statusline.sh:119-131` runs `oh-my-posh print primary --config <file>`. All colour semantics belong to oh-my-posh, not this repo.
3. Hex per segment; depth handling is delegated to oh-my-posh. No NO_COLOR logic here.
4. Background-filled cells with explicit white foreground.
5. Powerline arrows `` (`powerline_symbol`); first segment has a rounded leading diamond ``, last a rounded `` with a `<transparent,background></>` joiner. The arrow colour comes from oh-my-posh's powerline style: fg is the previous segment's bg and bg is the next one's (standard oh-my-posh behaviour, not in this repo).
6. Hue per segment plus arrows: seven distinct hues, no repetition.
7. Foreground is fixed white / one dark; no contrast calculation, not adapted to terminal.
8. Nerd Font required (``, ``, ``, ``, `󰍛`, `󰓅`, `󰔛`, `󰯉`).
9. Git icon upstream and branch status come from oh-my-posh.
10. Edit the `.omp.json`; requires oh-my-posh installed. No other knobs in this repo.

## prismatic-claude-statusline
https://github.com/XyzElias/prismatic-claude-statusline (16 stars)
1. By model, by effort, by threshold, and fixed per pill. `statusline_config.yml` + `statusline.js:400-415,560-700`: model text is a per-character two-stop RGB gradient chosen by model id (`model_themes`: opus `[175,100,255]` to `[255,120,230]`, sonnet `[40,230,160]` to `[120,255,180]`, haiku `[255,140,60]` to `[255,90,140]`, fable `[64,224,208]` to `[255,198,88]`, default grey-white). Effort text is a gradient per level (`effort_levels`: low yellow, medium periwinkle, high blue, xhigh violet, max rose). Cost uses `cost_grad` yellow to amber. Path `[120,200,255]`, branch `[180,160,255]`, time `[130,210,255]`, diff add `[60,255,110]`, remove `[255,75,75]`. Context and rate bars and percents use `thresholds` (first match wins): <40 `[50,255,160]`, <65 `[200,255,50]`, <80 `[255,210,30]`, <92 `[255,120,30]`, else `[255,50,50]` (`:469-481`).
2. No named themes; one config where every colour is an `[R,G,B]` array. `model_themes` is the closest thing, extensible by adding a key. A visual editor `config-editor.html` generates the YAML.
3. Truecolor only (`fgC`/`bgC`, `:400-401`). The README claims truecolor; no COLORTERM or NO_COLOR check found in `statusline.js`.
4. Both: every pill is a filled `pill_bg` `[58,62,72]` cell (`bgC`), with gradient foreground text; the bar track is `pill_bg + 55` per channel (`:570`).
5. Pill caps by `style` (`STYLE_PRESETS`): `nerd` (Powerline half-circle glyphs), `unicode` (block characters), `ascii` (`[ ]`). The cap is drawn as the pill background colour in the foreground over the terminal's ground (`fgC(...b) + PL_LEFT`, `:596`). Pills are separated by a space; a rounded frame (`╭╮╰╯─│`, `frame:` block) surrounds the pill row, and a small `LABEL` row sits beneath each pill.
6. Every pill has the same dark fill; neighbours differ by the hue of their gradient text and by the label underneath. No alternation or lightness steps.
7. Not adapted to light terminals. Pill fill is fixed dark grey; gradient text is bright. Bar fill darkens slightly along its length (`factors [0.2,0.12,0.08]`, `:575-580`).
8. `style` nerd / unicode / ascii; emoji not used. `docs/nerd-fonts.md` explains setup.
9. Per-character gradients are the signature. `tools/render-svg.js` renders screenshots to SVG; `assets/models.svg`, `context-states.svg`, `anatomy.svg`. Browser configurator `config-editor.html` (screenshot `assets/config-editor.png`).
10. `statusline_config.yml` (auto-created with defaults on first run, `:299-300`): per pill `enabled`, `label`, `order`, `bar_width`, `show_seven_day`; `colors.*`; `frame.*`; `style`; `show_labels`; `path_segments`. Visual editor in HTML.

## codex-claude-plugins (duyet) statusline
https://github.com/duyet/codex-claude-plugins (15 stars). Only the `statusline` plugin is styling-relevant (`statusline/scripts/statusline.py`); `okf`/`kb` render knowledge-base HTML.
1. Fixed per segment plus threshold. `statusline.py:225-230` `color_for(pct)`: >=85 bold red, >=70 bold yellow, >=50 plain yellow, else bold green; used for context and both rate limits (`:337,362,370,411,432-434,463-469`). Folder bold cyan (`:315,394,452`), git branch bold magenta in parentheses, model bold yellow (`:323,402,460`), agents bold green (`:382,441`), cache percent green >=70 / yellow >=40 / red (`:177`), cache expired bold red (`:181`), cache countdown red / yellow / dim (`:187`).
2. Not present. Five layout templates in `scripts/templates/` (minimal, balanced, developer, detailed, performance, monitor) pick which segments show, not colours.
3. ANSI 16 only (`\033[1;3Xm`, `\033[0;33m`). No depth detection, no NO_COLOR.
4. Foreground-only.
5. Configurable text separator: `SEPARATORS` maps `arrow` `→`, `pipe` `│`, `slash` `/`, `dot` `·` (`:72-74`); default `arrow`. Uncoloured.
6. Hue per segment (cyan folder, magenta branch, yellow model, green agents) plus separator.
7. Not present.
8. Three icon sets via `icon_style` (`:44-62`): `emoji` (📁 🤖 📊 ⏱️ 🗃️ 🔧 👷 ⏳ 💰 💤), `unicode` (■ ⑂ ◈ ▪ ◷ ◇ ▸ ◆ ∘ ¤ ·), `minimal` (none).
9. `color_style: "colorful"` is declared in `DEFAULT_CONFIG` (`:29`) but never read anywhere else in the file (grep finds only that line), so there is no non-colourful mode in practice.
10. JSON config merged over defaults (`load_config`, `:33-41`), keys `show_*`, `icon_style`, `separator`, `cache_ttl`, `color_style`; slash commands `config`, `setup`, `status`, `disable`; plugin manifests for Claude, Codex, Cursor and Grok.

## status-bar-claude (FlorianBx)
https://github.com/FlorianBx/status-bar-claude (15 stars)
1. Fixed per segment plus threshold. `statusline-command.sh:13-21,22-43,62-95`: directory bold white; branch green; model white (or dim `claude` fallback); `ctx`, `5h`, `7d`, `reset` labels dim; values white. Bars (`build_bar`, `:32-43`): 8 cells of `▊`, filled colour by percent: >=90 bold red, >=75 red, >=50 yellow, else cyan; empty cells dim.
2. Not present.
3. ANSI 16 (`\033[0;32m` etc). No detection, no NO_COLOR.
4. Foreground-only.
5. Two spaces, no glyph.
6. Dim labels versus white values; whitespace.
7. Dim attribute `2;37` used for de-emphasis; no adaptation.
8. Block `▊` only; no icons.
9. Nothing further.
10. None (edit the script).

## usage-meter
https://github.com/rohit3a/usage-meter (15 stars)
not a Claude statusline: a Claude Code mod (`mod/hooks/register.tsx`, React/Ink style) drawing a usage band above the prompt, a details pane, and a Python collector for Claude Code and Codex usage. For reference, `register.tsx:489-494` `pctColor` is green below 70, yellow 70-89, red from 90, with the SVG bar using `#3fb950` / `#d29922` / `#f85149` on a translucent `#8b949e` track; hosts in the pane are given `HOST_COLORS` `#58a6ff #bc8cff #3fb950 #d29922 #8b949e` (`:37`); everything else is `dimColor` or host-named colours (`cyan`, `yellow`, `green`, `red`).

## Himmel
https://github.com/yotamleo-org/Himmel (15 stars). A personal workflow repo; the statusline is `scripts/statusline/bin/statusline.sh` (a variant of the well-known "blue/orange/green/cyan/red/yellow/white/magenta" truecolor script) plus a vendored copy of claude-hud in `marketplace/plugins/claude-hud`.
1. Fixed per label plus threshold. `scripts/statusline/bin/statusline.sh:20-29,34-41,439-469`: palette is `blue 0;153;255`, `orange 255;176;85`, `green 0;175;80`, `cyan 86;182;194`, `red 255;85;85`, `yellow 230;200;0`, `white 220;220;220`, `magenta 180;140;255`; `5h bank`, `7d bank`, `extra` labels white; context and bar colour by `color_for_pct`: >=90 red, >=70 yellow, >=50 orange, else green. Net-cost lines green for `+`, red for `-` (`:1210,1244`). Vendored claude-hud (`marketplace/plugins/claude-hud/src/render/colors.ts`) maps model cyan, project yellow, git magenta, git branch cyan, label dim, custom `38;5;208` (Claude orange), context green / yellow at 70 / red at 85 (`getContextColor`), quota red at 90 or warning pace, bright magenta at 75, and lets each be overridden by a name, a 0-255 index or `#rrggbb` (`resolveAnsi`, `:32-47`).
2. Not present for the shell script. The claude-hud copy has `HudColorOverrides` (per-role override keys: model, project, git, gitBranch, label, custom, context, warning, critical, usageWarning), not named themes. `scripts/config-ui/public/theme.css` styles a web config UI, not the statusline.
3. Shell script: truecolor only. claude-hud: ANSI 16 names, 256 index and hex. No downsampling, no NO_COLOR in either.
4. Foreground-only.
5. Dim `│` with spaces (`sep`, `:30`).
6. Hue per label; claude-hud also varies by role.
7. Not present.
8. Emoji (`✍️`) and `⟳`; bars of filled/empty block glyphs with `dim` for empty (`:58`).
9. A drift checker keeps the shell composer and the vendored HUD render in parity (`scripts/statusline/check-hud-drift.sh`, `test-hud-render-parity.sh`).
10. claude-hud config JSON (colour overrides above); shell script has none. `scripts/lib/wire-statusline.sh` installs it.

## micucodeline (fork of CCometixLine)
https://github.com/zuoliangyu/MICUCODELINE (15 stars). Differences from the parent only. (The parent has since been rewritten as v2; its README now lists 13 palettes, four skins and `--theme` removed, so the parent's current design differs from this fork's v1 base. Parent comparison from its README, not code.)
1. Fixed per segment, hard-coded background, no thresholds. `src/ui/themes/theme_default.rs`: model bg `42,56,110`, context `68,95,167`, usage `92,124,192` (a lightness ramp in blue), cost `188,121,196` purple, session `220,99,134` pink-red, output style `228,134,78` orange, cwd `43,60,95`, directory `63,86,142`, git `87,114,175` (second blue ramp), used `184,102,169`, balance (red-pink, `218,…`), branding unread. Text and icon `245,245,245` on the model segment (the only one read in full).
2. Fork removes theme switching: `src/ui/themes/presets.rs:1-4,15-17` "The theme is now a single hard-coded preset ... Theme switching, file-based themes, and the TUI theme selector are all gone"; `get_theme` ignores its argument. The default is three rows with a "fixed neon gradient" per README. Per-segment colours, icons, order and separators stay editable in the TUI (`--config`) and saved to `~/.claude/micucodeline/config.toml`.
3. `AnsiColor` enum with `Color16`, `Color256`, `Rgb` (`src/core/statusline.rs:447-480`). Default preset uses `Rgb` only. No NO_COLOR or COLORTERM check found in `statusline.rs`.
4. Background-filled cells with separate icon and text colours (`render_segment`, `:365-420`).
5. Powerline arrow `\u{e0b0}`: fg is the previous segment's bg, bg is the next segment's bg (`create_powerline_arrow`, `:584-598`); other separators are white `\x1b[37m`.
6. Within each row, adjacent segments differ by lightness step in one hue (navy 42,56,110 to 68,95,167 to 92,124,192) and then jump hue (purple, pink, orange). Arrow joins them.
7. Text fixed near-white on dark-to-mid blues; no detection.
8. Nerd Font default (`StyleMode::NerdFont`); each segment has `plain` emoji and `nerd_font` glyph (`IconConfig`).
9. Unlike the parent, it injects line breaks before the cwd and branding segments (`presets.rs:32-40`), giving three rows.
10. TUI (ratatui), `config.toml`, no theme flag.

## cc-statusline (SammyLin)
https://github.com/SammyLin/cc-statusline (14 stars)
1. By colour slot, mixing fixed and threshold. `lib/colors.js:7-20` slots: `m` model, `c` cost and primary highlight, `d` dim, `b` branch/dir, `i` info or medium warn, `ok`, `err`, `ed` edited files and agents, `bar` token bar, `hi` high usage. `statusline.js:60-130`: model bold `m`; cost bold `c`; quota percent `hi` at >=80, `i` at >=50, else `ok`; permission mode `acceptEdits` ok, `auto` i, `plan` bar, `bypassPermissions` err plus `⚠`, default `d`; `+N` ok, `-N` hi; MCP failed err, healthy ok, auth `i`; agents and edited file `ed`; token count and speed `bar`.
2. Five themes in `THEMES` (`lib/colors.js:14-25`): `default` (ANSI 16), `nord`, `catppuccin`, `dracula`, `pastel` (256-colour indices). Format is a flat slot-to-escape map of ten slots, semantic roles. Default theme in config is `catppuccin` (`lib/config.js:9`). Users cannot define a theme without editing `colors.js`; `getTheme` falls back to `default`.
3. ANSI 16 for `default`, 256 index for the rest. No depth detection, no NO_COLOR.
4. Foreground-only.
5. Powerline mode is a dim `` glyph between segments with `|` as the non-powerline alternative; both dimmed text, not background arrows (`statusline.js:174-180`). The multi-line `rounded` layout draws `╭╴` and `╰╴` prefixes in dim.
6. Hue per slot; separators dim.
7. Not present.
8. Emoji minimal; glyphs `◆ ◇ ✓ ✗ ↑`.
9. Palettes are described as softened (comments: "mauve instead of hot pink", "Ultra-soft pastel").
10. `~/.claude/statusline-config.json` (`theme`, `layout` `rounded|single`, `powerline`, `showDir`, `showPermission`, `showAccount`, `showCompact`, `showSubagent`, `showMcp`, `showEditedFiles`, `showDirty`, `quotaBarLen`, `dirSegments`), env `CC_STATUSLINE_THEME`, `CC_STATUSLINE_LAYOUT`, `CC_STATUSLINE_POWERLINE`.

## codachi
https://github.com/vincent-k2026/codachi (14 stars)
1. A virtual pet statusline. Pet cells are coloured by role of the pet palette: body, accent, face, blush (`src/render/index.ts:68-98,142`), picked randomly per session from `PALETTES` (10 palettes, `src/identity.ts:15-`), e.g. coral `255,127,80`, sky `80,180,255`, mint `50,220,160`, violet `180,120,255`. Context bar threshold `getContextColor` (`src/render/colors.ts:100-104`): <70 `80,220,120` green, 70-84 `255,200,50`, >=85 `255,80,80`. Usage bar `getUsageColor`: <75 `100,150,255` blue, 75-89 `200,100,255` purple, >=90 red. Git markers fixed: modified yellow, added green, deleted red, untracked grey, ahead yellow, behind purple.
2. "catppuccin, monokai, night-owl" in the scan are joke lines in message text, not themes. There are 10 pet colour palettes and 5 species (cat, penguin, owl, octopus, bunny, `src/animals/`); `palette` config index 0-9 or random.
3. Best depth handling in the batch. `src/render/colors.ts:1-80`: four tiers truecolor / ansi256 / ansi16 / none; `NO_COLOR` first, then `CODACHI_COLOR=truecolor|256|16|none`, `FORCE_COLOR=0-3`, `TERM=dumb`, `COLORTERM`, known terminals (iTerm, WezTerm, vscode, Windows Terminal, Kitty, Alacritty), then `TERM` containing `256`. All colour passes through `rgb(r,g,b)`, which maps to cube index or 16-colour code (`rgbToAnsi256`, `rgbToAnsi16`); none returns an empty string and bars fall back to `#` / `-`.
4. Foreground-only.
5. A plain `SEP` between fields on the git line (`index.ts:189`).
6. Not relevant: the pet takes the colour; stats use fixed semantic colours.
7. Not present.
8. ASCII-art animals, emoji one hit; messages localised (`src/locales/zh.json`).
9. Animation: frames, mood messages, idle and event reactions (`src/mood.ts`, `src/events.ts`); `scripts/record-gif.sh` for the demo GIF.
10. JSON config (`src/config.ts`, `src/configure.ts` exists, not read): `palette`, species, language; env `CODACHI_COLOR`, `FORCE_COLOR`, `NO_COLOR`.

## claude-skills (alonbaron)
https://github.com/alonbaron/claude-skills (13 stars)
not a Claude statusline: a collection of Claude Code skills plus an optional `workflow-watch` mod (`mods/workflow-watch/hooks/register.tsx`) that draws a session timeline pane using host theme colours (`claude`, `subtle`, `warning`, `permission`, `inverseText`) and hex tallies; no statusLine command.

## claude-powerline-rust
https://github.com/david-strejc/claude-powerline-rust (13 stars)
1. Fixed per segment, per theme; no thresholds. `src/themes/mod.rs:23-92`: `dark` theme gives directory `#2d3748` bg, git `#38a169`, block `#3182ce`, today `#d69e2e`, session `#805ad5`, context `#e53e3e` (always red, even at low usage), metrics `#38b2ac`, model `#ed8936`. Each entry is a `(bg, fg)` pair; `apply_theme_colors` (`src/main.rs:380-402`) paints it.
2. Five themes (`get_theme`, `:15-24`): dark, light, nord, tokyo-night, rose-pine. Format: a map of segment name to `(bg, fg)` hex pair, eight segments each; unknown name falls back to dark. Chosen by `--theme` or `CLAUDE_POWERLINE_THEME`; user-defined themes are not supported (compiled in); config file loader exists (`src/config/loader.rs`, not read for theme keys).
3. Truecolor `\x1b[48;2;..m\x1b[38;2;..m` when `COLORTERM` has truecolor/24bit, or `TERM` contains `256`/`color`, or is `xterm-kitty` / `alacritty` (`supports_rgb_colors`, `:414-423`, which is broader than real truecolor support); otherwise 8-bit via `rgb_to_8bit`. `NO_COLOR` or `TERM=dumb` returns plain text (`should_use_colors`, `:408-412`).
4. Background-filled cells with an explicit text colour per segment.
5. `--style minimal|powerline`: `powerline` joins segments with the literal string `" ⮀ "` in default colours (`main.rs:137`), not a background-aware arrow; `minimal` uses two spaces. So the separator is not coloured from neighbouring backgrounds.
6. Hue per segment: eight distinct backgrounds, no repetition. Text colours switch between light and dark per cell so each pair reads on its background (`dark`: `#1a202c` on the yellow `today`; `rose-pine`: `#191724` on lavender block, `#e0def4` on pine green git).
7. Text contrast is hand-picked per cell, not computed. `light` theme uses pale pastel backgrounds with dark text. The theme is selected explicitly; no terminal detection.
8. Emoji in the segment text (🧠 for context, etc., `main.rs:361`).
9. A small Rust port of Owloops' claude-powerline concept; per the README, performance is the pitch.
10. CLI `--theme`, `--style`, env `CLAUDE_POWERLINE_THEME`, `CLAUDE_POWERLINE_STYLE`, config file under `src/config/` (segment toggles).

## context-bar
https://github.com/htahaozlu/context-bar (13 stars)
not a Claude statusline: a macOS menubar app plus Rust CLI/TUI for Claude Code and Codex usage. The Claude statusline hook it ships (`crates/context-bar-core/src/claude_statusline.rs:151-160`) prints the uncoloured text `[<model>] N% ctx` and writes a JSON snapshot for the app. For reference, the menubar `Theme.swift` colours context by `pctLow` below 60, `pctMid` below 85, `pctHigh` from 85 (calm clay, amber, red per README); the TUI uses ratatui `Green/Yellow/Red` by tier (`src/bin/live_tui.rs:52-54`) and honours NO_COLOR.

## claude-code-statusline (jsubroto)
https://github.com/jsubroto/claude-code-statusline (13 stars)
1. A generator (`ccsl.py`, a curses TUI) that writes a Python statusline. Generated colours are fixed per field, theme-independent (`generate_script`, `:222-290`): model `\033[96m` bright cyan, cost `\033[93m` bright yellow, context bar `\033[92m` bright green (all three only when the theme has an accent), dir/git/session/duration uncoloured. The context bar has no threshold colouring.
2. Five `THEMES` (`:63-70`), each only `(bar chars, accent ANSI, preview colour pair)`: default `█░` accent `\033[96m`, minimal `▓░` `\033[97m`, neon `█▒` `\033[95m`, pastel `●○` `\033[93m`, mono `#-` no colour. The accent colours only the `│` separator; the field colours above are the same in every non-mono theme. Not user-extensible except by editing the script.
3. ANSI 16 bright colours (90-97). No detection; `mono` removes all escapes.
4. Foreground-only.
5. `  │  ` coloured with the theme accent (`sep`, `:226`).
6. Separator only; fields share their fixed colours across themes.
7. Not present.
8. Emoji per field (🤖 📁 📊 💰 🌿 ⏳ 🔖), `[Model]` brackets.
9. The curses TUI previews the result live (`render_preview`, `_draw_preview`).
10. Interactive curses configurator choosing fields and theme; writes `~/.claude/statusline.py` and the `settings.json` entry (`CLAUDE_SETTINGS`, `STATUSLINE_SCRIPT`).

## magus (MadAppGang)
https://github.com/MadAppGang/magus (13 stars). The statusline is `plugins/setup/scripts/statusline.sh`; `claudish/hooks/status/palette.ts` and `dev/scripts/status/render.ts` are separate status renderers (not read).
1. Fixed per role, plus threshold ramps, plus chips. `statusline.sh:1001-1262`: model name bold cyan (`C_CYAN`), `prefix@` magenta with gray `@`, agent `→name` cyan, cost yellow with `↑` velocity, duration magenta, RAM cyan dim, diff `+` green / `-` red, git `⎇` yellow, compaction `⟳×N` bold magenta, separator `|` gray. Context bar fill `bar_color_for_pct` (`:502-519`): <40 green (46 dark, 34 light), <70 yellow, <90 orange, else red 196; the percent label uses the separate muted ramp `color_for_pct` (`:487-493`: `C_GREEN`/`C_YELLOW`/`C_ORANGE`/`C_RED`). Plan-limit bars use a cool ramp teal then blue then orange then red (`plan_bar_color_for_pct`, `:521-536`, and muted `plan_color_for_pct` for text) "so they stay distinguishable from the context bar". Worktree chip background is picked from `WT_PALETTE` by a name hash (`pick_wt_bg`, 31x+ord mod 1000003), or from the tmux window's `@cc_colour` / `CLAUDE_WT_COLOUR` session colour token (red, orange, yellow, green, cyan, blue, purple, pink) mapped to a 256-cube index per tier; branch chip `BG_BRANCH`; alert chip `BG_ALERT`; vim-mode chips `BG_VIM_*`.
2. Four themes (`THEME`, `:37`, `apply_theme` `:263-318`): `default`, `minimal`, `neon`, `monochrome`. Format: eight role slots (cyan, green, yellow, red, magenta, white, gray, orange) per theme per appearance, each a 256-cube index; user cannot add themes, config picks one.
3. 256-cube indices only (16-255) via `38;5;N` / `48;5;N`, and never base-16 codes. Comment `:243-262` explains why: base-16 codes are palette slots the terminal remaps (iTerm "Light" profile turned `97` into `#3C3835`, making bold white render black, a 2.1:1 or 1.04:1 chip), whereas cube indices are fixed RGB, so both halves of every pair are fixed. No truecolor, no depth detection, no NO_COLOR.
4. Both: text-only segments plus filled chips for branch, alert, worktree and vim mode, with explicit `BADGE_FG`.
5. Plain gray `|` (`SEP`, `:1001`). Chips are not joined by arrows.
6. Hue per role; chips are distinguished by background tint (worktree tinted by name or session colour).
7. The most thorough contrast handling in the batch. Appearance is resolved light vs dark (`resolve_appearance`, `:91-240`) in order: config `appearance`, `STATUSLINE_APPEARANCE`, tmux `#{client_theme}` of the client showing this pane (live, per client), `$TERM_THEME`, tmux session `COLORFGBG` (30 s cache, since Claude freezes the env var at launch), `$COLORFGBG`, default dark. `colorfgbg` fg/bg index 7 or 15 means light. Light tier uses muted mid-dark text (about 3.5-4.8:1 on cream `#FBF1C7`), dark tier brighter colours; chips invert (pale fill with dark ink on light, saturated fill with white on dark); the `dim` attribute is dropped on light because it "erases text rather than de-emphasising it" (`:271-276`). Contrast ratios for every chip pair are computed in comments (WCAG 4.5:1 target, `:243-262,350-420`).
8. Nerd Font opt-in `icons.nerd_font` (default false) with plain-text fallback per segment, because coverage of glyphs like U+F2DB or U+F4BC differs by font and unsupported ones render blank (`:55-65,462-475`). Emoji `🤖` for diff and `⎇` / `⟳` unicode.
9. Wrapping layout: `wrap`, `max_lines`, `layout auto|aligned|compact`, gutter labels (`:41-52,1550`). Per-worktree and per-session chip colour keeps a tmux tab and the bar in agreement.
10. `~/.claude/statusline-config.json` read through `jq` (`CONFIG_FILE`, `:17`): `theme`, `appearance`, `sections.*`, `icons.nerd_font`, `wrap`, `max_lines`, `layout`, plan bar width; env `STATUSLINE_APPEARANCE`, `TERM_THEME`, `COLORFGBG`; install via `/setup:statusline-install`.

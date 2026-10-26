## araujobsd/shellmate
https://github.com/araujobsd/shellmate (stars 2)
A Claude Code statusLine that draws an animated pet sprite ("buddy") whose colour tracks session mood.
1. Colour: two layers. The sprite body is fixed per species (`shellmate/theme.py` `SPECIES_COLORS`: cat ginger `222,116,45`, owl tawny, frog green, dragon gold, ... 17 species). Trailing mood marks (`!`, `?`, `*`, `z`, `..`), name and phrase take a mood colour by state: `render.py:MOOD_COLOR_ROLES` / `statusline/shellmate-sprite.sh:~150` map sleeping=dim, working=blue, happy/perked=green, alert=yellow, alarmed=red, offline=dim. Species `glitch` is a rainbow: `theme.py:paint_spectrum` cycles an 8-colour `SPECTRUM` per glyph, shifted per frame (animated). Comment at `theme.py:~58` states the design rule: body colour never changes with mood, only the marks do, so identity is stable.
2. Themes: one hardcoded palette, labelled "tokyo-night" (`theme.py` `COLORS`: dim, blue, green, yellow, orange, red as truecolor). No theme switching, no user-defined themes. Species colours are held `MIN_MARK_DISTANCE = 65.0` away from every mood-mark colour (checked by tests/test_theme.py per the comment).
3. Spec/depth: truecolor only (`\033[38;2;r;g;bm`). No depth detection or downsampling. NO_COLOR honoured in `shellmate/app.py:35-36` (`color_enabled()`), passed as `color=` into `render.py`. The sprite statusline script (`shellmate-sprite.sh:153`) imports `COLORS` directly (NO_COLOR check not found there).
4. Fill: foreground-only text and glyphs; no backgrounds.
5. Separators: none in the statusline. The `shellmate` TUI/panel uses a box-drawing frame (`theme.py` `BOX`, unicode `┌┐└┘─│├┤` or ASCII `+-|`), title ` buddy `.
6. Neighbours: not applicable; one sprite plus dim text; contrast between body and mood marks enforced numerically (point 2).
7. Light/dark: not present. Only a dark-biased palette. Colour distance guard is the only contrast logic.
8. Glyphs: `GLYPHS`/`BOX` have `unicode` and `ascii` sets, chosen by config `ascii_glyphs` (`config.py:26`) / `style == "ascii"` (`render.py:114`). Comment notes every glyph in a set shares one East Asian Width class so frames do not tear.
9. Other: per-frame animation (`motion.animation`), `glitch` spectrum crawl, secret/rare species colours (dragon gold "the rare one", bilai "spectral pale, opt-in").
10. Customisation: `shellmate/config.py` dataclass (`ascii_glyphs` etc.), install via `install.sh`/pyproject; no colour config surface.

## arthuroli29/cc-statusline
https://github.com/arthuroli29/cc-statusline (stars 2)
1. Colour: fixed per segment plus threshold. `statusline-command.sh:6-13`: directory = blue (`\e[94m`), branch = yellow (`\e[93m`), everything else = gray (`\e[90m`). Context bar (`:84-100`): per-cell colour by position, cells 1-6 green, 7-8 orange (`\e[33m`), 9-10 red, filled cell draws `=`, empty `-`. Token count `ctx_color` (`:103-109`): green <60, orange 60-79, red >=80 of usable context (window minus 33000 autocompact buffer).
2. Themes: not present. Hardcoded.
3. Spec/depth: ANSI 16 only (`\e[31m/32m/33m/90m/93m/94m`). No depth detection; NO_COLOR not present.
4. Fill: foreground-only.
5. Separators: plain text `|` inside gray text (`:126`), no colour of its own.
6. Neighbours: different hues (blue dir, yellow branch, gray rest), separators only.
7. Light/dark: not present.
8. Glyphs: emoji suffixes in gray text (`📁 🧠 📊 💰 🕐`); no ASCII fallback.
9. Other: two lines (`line1`, `line2`); context bar is the only colour-by-position construct.
10. Customisation: edit the shell script; no config file or env.

## audi63/claude-usage-monitor
https://github.com/audi63/claude-usage-monitor (stars 2)
not a Claude statusline: a Python desktop tray icon + always-on-top overlay + popup for Claude Pro/Max usage limits (`src/claude_usage_monitor/themes.py` only holds `DARK_THEME`/`LIGHT_THEME` hex dicts for its Tk-style windows, `get_theme("auto")` reads the Windows registry `AppsUseLightTheme`, default dark elsewhere).

## bennyzen/coding-plans-waybar
https://github.com/bennyzen/coding-plans-waybar (stars 2)
not a Claude statusline for styling purposes: a Waybar module/tooltip for coding-plan usage. Its `lib/coding_plans/statusline.py` only records stdin into `~/.cache/coding-plans/state.json` and chains to any prior statusline, emitting no styling. The styled output is Pango markup in Waybar (`render.py` `<span foreground=...>`). Colour logic worth knowing: `palette.py:16-26` `BAKED_PALETTE` has accents baked (accent `#66a773` healthy, warn `#b4b47b` at 50%+, crit `#993426` at critical threshold, danger `#d24646` at exhausted) while only chrome (bg, surface, text, border) is overlaid from the active Omarchy theme (`~/.config/omarchy/current/theme/waybar.css` `@define-color`). Comment `palette.py:5-8`: harvesting accents from the terminal's ANSI slots was tried and abandoned because on non-IBM themes "healthy usage would paint red". `pct_color` (`:52-62`) = muted if unknown, else danger/crit/warn(>=50)/accent.

## Boming0002/cc-statusline-magma
https://github.com/Boming0002/cc-statusline-magma (stars 2)
1. Colour: bar cells coloured by position (gradient index), same palette for every metric. `statusline.sh:102-205`: a 10-stop RGB `GRADIENT` array; cell i of the filled run uses `GRADIENT[i]` (`render_bar`, `:200-207`), so a longer bar reaches hotter colours; empty cells `▱` are dim (`\033[2m`). Metrics ctx / 5h / 7d / cache all use the same ramp; labels carry the good/bad meaning (comment `:102-104`). Fixed accents elsewhere (`:217-225`): model and token counts cyan (`36`), cost magenta (`35`); on light bg blue (`34`), blue, red (`31`).
2. Themes: 5 gradient themes x 2 backgrounds (`STATUSLINE_THEME` = magma default | viridis | ocean | forest | cyberpunk; `STATUSLINE_BG` = dark | light), 10 palettes in a `case` (`:109-178`). Format = ordered list of 10 RGB triples per theme; no semantic roles; users edit the script to define their own. Unknown theme silently falls back to magma_dark (`:177`).
3. Spec/depth: truecolor `\033[38;2;r;g;bm` for bars, ANSI 16 for accents. No depth detection, no NO_COLOR. `statusline.ps1` is the Windows twin.
4. Fill: foreground-only glyphs `▰`/`▱`.
5. Separators: plain `│` in uncoloured text.
6. Neighbours: separators only; bars share a ramp so adjacent bars at equal fill look identical; distinguishing is by text label.
7. Light/dark: yes, explicit. Each theme has a `_light` variant that caps brightness so filled cells stay visible on white ("no yellow/white fade to invisible", `:107`), plus darker accent colours (blue/red) for light. Selected by env var, not detected.
8. Glyphs: `▰▱`, `│`, `⚡` for cache; no ASCII fallback.
9. Other: viridis variant described as colour-blind friendly (`:121`); gradient-by-position is the signature feature.
10. Customisation: env vars `STATUSLINE_THEME`, `STATUSLINE_BG`; `install.sh`/`install.ps1`.

## bouob/claude-statusline
https://github.com/bouob/claude-statusline (stars 2)
1. Colour: mixed. Fixed per segment with theme fallbacks, resolved by `resolveColor(ctx, key, fallback)` (`src/segments/base.ts`): config `colors.<key>` > theme > default. `model.ts:9-15` per-model colour map (opus `200,120,255`, sonnet `100,180,255`, haiku `100,220,160`, fable `245,185,65`, mythos `255,80,120`, unknown gray; `palette.ts`), `git.ts:54-57` dirty = yellow, clean = `theme.secondary`; project = `theme.secondary` (`project.ts:12`). Context bar is by state (README visual modes: <70% theme primary, 70-85 yellow, 85-90 red, >90 per-character rainbow); rate-limit bar thresholds `rate-limit.ts:125-127`: >85 critical, >60 warning, else primary. Empty cells `theme.dimmed`. Rainbow = `gradient.ts:rainbowGradient`, hue 0-300 across the bar at HSL(90%,60%).
2. Themes: 10 bundled (`src/themes/loader.ts`: default, rainbow, nord, catppuccin, dracula, gruvbox, tokyo-night, solarized, one-dark, monokai). Format = semantic roles, 7 keys (`themes/types.ts`: primary, secondary, warning, critical, dimmed, text, background; RGB triples). Custom: partial `colors` map of 18 hex keys (opus, sonnet, haiku, fable, mythos, progressNormal/Warning/Critical/Empty, gitClean, gitDirty, worktree, project, session, resetTime, pr, agent, effort). No user-defined whole themes.
3. Spec/depth: truecolor and 256. `color/detect.ts` reads COLORTERM, WT_SESSION, TERM_PROGRAM (iTerm/WezTerm), TERM=xterm-kitty, `*256color`; `color/ansi.ts` `rgbTo256` downsamples. `colorMode: auto` in config can force. NO_COLOR not present.
4. Fill: foreground-only (bg helpers exist in `ansi.ts` but segments use `fg`).
5. Separators: `core/separators.ts` 5 styles: powerline `/E0B2/E0B1`, rounded `/E0B6/E0B5`, slash `╱`, minimal `|`, none (two spaces). In composer (`core/composer.ts:86-90`) only the `between` glyph is used, drawn in `theme.dimmed`, fg-only; the left/right caps are defined but not used as filled arrows.
6. Neighbours: different hues (per-segment colour keys) plus a dimmed between-glyph.
7. Light/dark: not present. Themes include solarized but no detection or text-contrast logic.
8. Glyphs: Nerd Font/powerline separators, emoji, bar chars from `core/bar-chars.ts` (`barStyle`: block etc.). ASCII separator options (`minimal`, `none`).
9. Other: conditional rainbow bar at >90% context (`rainbow.contextThreshold`), optional `rainbow.alwaysOn/onAgent/onWorktree`, natural-language config skill (`/claude-statusline:customize dracula + dot + powerline`), responsive width fitting (`composer.ts:fitToWidth`), refreshInterval support.
10. Customisation: JSON config (`claude-statusline.json`, fields theme, colorMode, separator, barStyle, colors, layout.lines/line1/line2, segments.*), Claude slash command wizard, `scripts/setup.js`.

## brenoxp/claude-code-statusline
https://github.com/brenoxp/claude-code-statusline (stars 2)
1. Colour: semantic roles, fixed per segment plus threshold. `src/lib/theme.ts:11-24` mutable `theme` with 12 keys. Segments: path = `green` (`Location.svelte:25`), branch = `label`, `+N` = green, `-N` = red, model = `model` bold (`ContextBar.svelte:26`), token count / cost = `slate` dim, clock = `slate`, update arrow = green, usage labels = `label`. Thresholds: `ctxRgb` (`theme.ts`) 40/50/70 -> green/yellow/orange/red; `rateRgb` 50/70/90; `UsageLimits.svelte` adds `inverse` when pct >= 90.
2. Themes: 5 (`themes.ts`: default, tokyo-night, dracula, gruvbox, nord). Format = a 12-key semantic palette of RGB tuples (green, yellow, orange, red, model, label, slate, purple, muted, prompt, barDim, barLerp), not per-segment maps. Users override single keys with `colors: {key:[r,g,b]}` in config; `applyTheme()` swaps in place.
3. Spec/depth: truecolor RGB via Svelte+nib-ink `rgb(r,g,b)`; README requires truecolor terminal. No downsampling found; NO_COLOR not found.
4. Fill: foreground-only; `inverse` used at >=90% for rate limits.
5. Separators: none found in the colour code (layout via flex boxes).
6. Neighbours: different roles per segment (green path, blue-ish label, orange model etc.).
7. Light/dark: `setTheme("light")` in `src/index.ts:38` is an nib-ink call; no background detection or contrast function found.
8. Glyphs: progress bar of `●`/`○` with 10x sub-cell precision (`ProgressBar.svelte`): the partial dot lerps from `barLerp` (white) toward the fill colour; emoji minimal.
9. Other: fractional-dot gradient on bars; SVG example generator (`scripts/generate-example-svg.ts`); compiled binary.
10. Customisation: `~/.claude/.statusline/config.json` (theme, colors, maxLineWidth, minPromptLineWidth, cacheWrite, debug); no TUI.

## byQuexo/claude-pet
https://github.com/byQuexo/claude-pet (stars 2)
not a Claude statusline: idlemon, an idle RPG pet game that ships as a Claude Code mod (and an optional statusline wrapper that runs your old one first); sprites and gear tiles use rarity/element hex colours, not a statusline colour system.

## chrishinyu/claude-token-tracker
https://github.com/chrishinyu/claude-token-tracker (stars 2)
1. Colour: none. `cli/tt-statusline.sh` emits plain text via an inline `node -e` script: `NN% ██████░░░░ │ resets 3h 12m │ 4.1M (12 msgs)`; no ANSI escapes at all.
2. Themes: not present in the statusline (the Chrome extension has its own hex styling, out of scope).
3. Spec/depth: not present; NO_COLOR not present.
4. Fill: neither; uncoloured.
5. Separators: plain `│` (`:77`).
6. Neighbours: not applicable; text separators only.
7. Light/dark: not present (it works on any terminal by having no colour).
8. Glyphs: `█`/`░` bar (`:11`), `│`.
9. Other: falls back to estimating a 5 h token budget (`TT_TOKEN_BUDGET`, default 20 M) from transcripts when extension data is stale (`:78-84`).
10. Customisation: env var `TT_TOKEN_BUDGET`; edit the script.

## Christandoh/context-cache
https://github.com/Christandoh/context-cache (stars 2)
not a Claude statusline: a Claude Code mod that draws a card above the prompt (context window / usage limits / prompt-cache temperature). Colour rule from its README: limit bars have a dark layer for elapsed time and a bright layer for usage; bar turns amber when usage is ahead of time pace and red at 90%.

## cjodo/claude-colorizer
https://github.com/cjodo/claude-colorizer (stars 2)
Mostly a terminal tab/background colouriser; its `statusline` subcommand is a real statusLine.
1. Colour: statusline shows (a) a state indicator `● <state>` and (b) swatches of colour literals mentioned in the conversation. State colours are fixed per state (`internal/config/config.go:70-76`, `Default()`): idle `#94a3b8`, working `#3b82f6`, attention `#f59e0b`, done `#22c55e`, error `#ef4444`, each with a tab colour, a dark background tint (`#181b21`, `#151b2b`, `#2a2112`, `#13231a`, `#2b1515`) and an emoji glyph. Swatches are drawn as `bg(color) + 2 spaces` (`cmd/claude-colorizer/main.go:renderSwatches`, `:496` `bg()`), so each swatch is the literal's own colour.
2. Themes: per-state `states` map (tab, background, glyph) in `~/.config/claude-colorizer/config.json`; no named themes. User-definable via `states`.
3. Spec/depth: truecolor `\x1b[38;2/48;2;r;g;bm` only for the statusline; parser accepts `#rgb(a)`, `rgb()`, `hsl()`, `oklch()` (`internal/colors/find.go`). Terminal detection exists for tab colours (`internal/terminal/detect.go`, `CLAUDE_COLORIZER_TERMINAL`), not for depth. NO_COLOR not found.
4. Fill: background cells for swatches (2-space blocks), foreground dot for the state; the terminal background itself is tinted by OSC sequences.
5. Separators: two plain spaces between swatches; optional `statusline.prefix` text.
6. Neighbours: not applicable; swatches are the colours themselves.
7. Light/dark: comment `config.go:68`: "Default tints assume a dark theme; override background colors for light ones". `colors.Color.Contrast()` picks black/white text for inline highlighting in `show` (`main.go:444`), not used in the statusline swatch.
8. Glyphs: `●`, emoji state glyphs (⚪🔵🟡🟢🔴) in the window title where tabs cannot be coloured; no ASCII fallback beyond `indicator: none`.
9. Other: OSC 7501 program-status reports, tmux passthrough, tab colour per terminal (kitty, WezTerm, iTerm2, Ghostty), `show`/`try` commands to preview colours, a TS mod (`hooks/colorize.tsx`).
10. Customisation: JSON config (`statusline.swatches|max|sources|label|indicator|prefix|empty`, `states`, `tab`, `background`, `title`, `status`, `tmuxBackground`), `CLAUDE_COLORIZER_CONFIG`, `CLAUDE_COLORIZER_TERMINAL`, `CLAUDE_COLORIZER_STATE_DIR`, `install` writes settings.

## codecoincognition/claude-quota-statusline
https://github.com/codecoincognition/claude-quota-statusline (stars 2)
1. Colour: by state/threshold only. `quota-statusline.sh:43-49,62-66`: green below 80%, yellow 80-94%, red >= 95%, applied to the bar fill and percentage; empty cells `░` take `\e[2m` dim; labels `5h:`/`7d:` and `│`, `⟡` uncoloured.
2. Themes: two hard-coded variants selected by Claude Code's own theme: `quota-statusline.sh:24-41` reads `.theme` from `~/.claude/settings.json`; `light` uses bold `\e[1;31m/1;33m/1;32m`, otherwise plain `\e[31m/33m/32m`. No user themes.
3. Spec/depth: ANSI 16 only; NO_COLOR not present.
4. Fill: foreground-only.
5. Separators: plain ` │ ` between 5h and 7d.
6. Neighbours: separator only.
7. Light/dark: yes, via settings.json `theme` (bold variants for light backgrounds, comment "bold yellow/brown has excellent readability on light BG"); dim for empties "adapts to terminal background".
8. Glyphs: `█`/`░`, `⟡`, `│`; text-only mode (`MODE=text`) drops the bar.
9. Other: bar vs text render modes.
10. Customisation: `MODE` variable, `install.sh`; edit script.

## comonetso/claudeStateBar
https://github.com/comonetso/claudeStateBar (stars 2)
not a Claude statusline: a VS Code extension that puts Claude Code and Codex usage in the editor status bar and webview panels.

## cookie2509011-png/claude-antigravity-statusline
https://github.com/cookie2509011-png/claude-antigravity-statusline (stars 2)
1. Colour: by threshold/state. `statusline.py:84-98`: RED, ORANGE (`38;5;208`), YELLOW, GREEN, BLUE, GRAY. Context text coloured by `used%` (`:250`: red >=80, yellow >=50, green). Rate-limit segments coloured by usage versus pace (`build_rate_seg`, `:114-133`): with pace known, red if over by >= 20 points, yellow if over, else green; without pace, red >=80 / yellow >=50. Effort badge fixed per level (`EFFORT_COLORS`: max red, xhigh orange, high yellow, medium green, low blue). Cost/duration parts gray (`:351`).
2. Themes: not present.
3. Spec/depth: ANSI 16 plus one 256 index (208 for orange). Enables ANSI on legacy Windows consoles (`enable_ansi_colors`, ctypes `ENABLE_VIRTUAL_TERMINAL_PROCESSING`). NO_COLOR not present.
4. Fill: foreground-only.
5. Separators: plain ` | ` and ` · ` uncoloured.
6. Neighbours: separators; each part has its own state colour.
7. Light/dark: not present.
8. Glyphs: none beyond ASCII text.
9. Other: the "pace" colouring (usage vs elapsed fraction of the rate-limit window) is unusual; also counts Antigravity CLI history entries.
10. Customisation: edit script; env `CLAUDE_CONFIG_DIR`, `ANTIGRAVITY_HISTORY_PATH`.

## cordwainersmith/cc-status-bar
https://github.com/cordwainersmith/cc-status-bar (stars 2)
1. Colour: mostly one dim tone with state colour only on thresholds. `statusline.js`: model, dir/branch, effort, tokens, session id/name, output style are all `T.DIM` (`:82,881,903,909`); context bar and usable-context % graded green/yellow/orange/red (bar: <50 green, 50-69 yellow, 70-79 orange, >=80 `BLINK_RED`, `:325-330`; usable ctx 62.5/87.5/100 breaks, `:149-156`); session duration dim -> yellow (30 min) -> red (60 min) (`:377-379`); running subagent dot green `●`, finished dim `○` (`:759-762`). Separator `//` in `T.ACCENT`.
2. Themes: 8 (`themes.js`: dark, light, cyber, nord, dracula, catppuccin, gruvbox, tokyonight). Format = semantic ANSI roles, 8 keys (RESET, BOLD, DIM, GREEN, YELLOW, RED, ORANGE, BLINK_RED, ACCENT, MARKER); each theme is a delta over `BASE_THEME`. `cyber` also sets a `▸` marker prefix per segment. Users select, cannot define new (edit `THEME_DELTAS`).
3. Spec/depth: 256-colour indices (`\x1b[38;5;Nm`) in non-base themes, ANSI 16 in dark/light; no depth detection; NO_COLOR not present. `BLINK_RED` uses SGR 5.
4. Fill: foreground-only.
5. Separators: ` // ` in `ACCENT` colour (`:770`); no powerline.
6. Neighbours: separator only; segments are mostly dim.
7. Light/dark: `light` theme swaps dim to `\x1b[90m`, yellow to bold, orange to 166. Chosen by name, not detected. Auto-detects Nerd Fonts (`detectNerdFonts`, regex over installed fonts, `:203-238`) for icons.
8. Glyphs: Nerd Font icon per segment when enabled (`NERD_ICONS`, `:179-195`), `auto` detection; otherwise plain text; `█░` bar with fractional blocks.
9. Other: notification flash when crossing 50/70/80% thresholds (`:333-`), blinking red.
10. Customisation: `~/.claude/settings.json` key `claude-status-bar` (theme, nerdFonts, segments, `lines` multi-line layout, segmentOrder, custom shell commands); `configure.sh`/`configure.js` interactive menu with live preview.

## cubha/claudepulse
https://github.com/cubha/claudepulse (stars 2)
not a Claude statusline: AgentVitals, a VS Code/Cursor extension (formerly Claude Code Gauge) with a status bar item and webview.

## cubxxw/claude-code-statusline
https://github.com/cubxxw/claude-code-statusline (stars 2)
1. Colour: fixed per element plus threshold (`presets/full.sh`, `powerline.sh`, `minimal.sh`, `compact.sh`; 4 presets). Model = cyan bold, dir = bold, git branch = green (`powerline.sh:47`), vim mode fixed (NOR cyan, INS green bold, VIS magenta, other yellow, `:54-57`), tokens = cyan, cost = yellow, duration/labels = dim. Bars (`:64-66,97-99`): green, yellow >= 70, red >= 90 (README "Color Thresholds").
2. Themes: not present (README roadmap lists catppuccin/nord/dracula/gruvbox as future). Presets differ in layout, not palette.
3. Spec/depth: ANSI 16 (`\033[36m` etc.). No detection, no NO_COLOR.
4. Fill: foreground-only. The `powerline` preset defines `BG_C/BG_B/BG_G/BG_M` background codes (`:30`) but never uses them and emits no private-use arrow glyph (searched the file: none); it renders like the others with a different header comment.
5. Separators: dim `│`.
6. Neighbours: different hues per field; separators.
7. Light/dark: not present.
8. Glyphs: `━`/`─` line bars, `│`, `↑↓` token arrows; no Nerd Font required.
9. Other: three-line layout (identity / context+cost / rate-limit bars 5h, 7d); `refreshInterval` not mentioned.
10. Customisation: copy a preset to `~/.claude/statusline-command.sh` and edit; `install.sh`; Python example in `examples/`.

## DamMarin/claude-code-bar
https://github.com/DamMarin/claude-code-bar (stars 2)
1. Colour: semantic roles. `src/core/options.mjs` ROLES = low, medium, high, accent. `src/core/status.mjs:32-54`: level for any percentage = high if >= `thHigh` (80) / medium if >= `thMedium` (50) / low; used for context %, rate-limit percentages and bars. Accent (default `none`, i.e. terminal text) applies to the model name, git branch and the update notice (`status.mjs:47,53,54`); duration, dir, labels are unstyled.
2. Themes: 6 (`options.mjs:12-18`: default green/yellow/red, colorblind blue/yellow/magenta, ocean cyan/blue/magenta with `bright-cyan` accent, `high-contrast` fixed bold + inverse on high, `mono` dim/normal/bold, `none`). Format = four role->colour-name slots; custom via `--colors=low:green,medium:yellow,high:red,accent:cyan` (state `custom`). No hex.
3. Spec/depth: ANSI 16 names only (`COLOR_CODES`, 30-37 and 90-97). NO_COLOR honoured: `style.mjs:resolvePalette(options, noColor)` returns the `none` theme; `--no-color` flag too. No depth detection.
4. Fill: foreground-only, with bold/dim/inverse attributes (`style.mjs:paint`); high-contrast uses inverse on red.
5. Separators: 4 plain text choices (`SEPARATORS`: pipe `│`, dot `·`, slash `/`, arrow `›`), uncoloured.
6. Neighbours: separators only.
7. Light/dark: not detected; `high-contrast` and `mono` themes give attribute-based legibility; ANSI 16 colours follow the terminal's palette.
8. Glyphs: emoji labels toggle (`emoji: true`, `🤖 ⏱️`), 6 bar styles (`BAR_STYLES`: shade, block, line, dots, squares, braille with partial fills), text fallback via `emoji=false` short labels.
9. Other: interactive `--config` TUI with a live preview that underlines what each setting affects (`paint(..., underline)`), colour-blind theme.
10. Customisation: all options are CLI flags inside the `statusLine.command` (no config file), e.g. `claude-code-bar --theme=ocean --hide=dir`; `--install`, `--config`, `--uninstall`.

## dayfinggg/claude-code-discord-presence
https://github.com/dayfinggg/claude-code-discord-presence (stars 2)
not a Claude statusline for styling purposes: a Discord Rich Presence service. Its `scripts/statusline.mjs:36` writes plain uncoloured text (`model[effort][fast] • limits`) with no ANSI at all; `src/appearance/theme-*.ts` is the OS light/dark watcher for its own assets.

## derblub/awesome-claude-usage
https://github.com/derblub/awesome-claude-usage (stars 2)
not a Claude statusline: an AwesomeWM (Lua) bar widget; `contrib/statusline-cache.sh` only caches rate-limit JSON from Claude Code's stdin and chains to a downstream statusline, emitting nothing styled.

## devemberx/knit-statusline
https://github.com/devemberx/knit-statusline (stars 2)
1. Colour: fixed per field, with threshold grading. Reference palette in `internal/render/style.go:17-28` (10 truecolor fg colours: Blue `0,153,255`, Orange, Green, Cyan, Red, Yellow, White, Magenta `180,140,255`, Pink, Aqua, plus Dim). Mapping (`internal/segment/builtin.go`, `git.go`): model = Blue (`builtin.go:37`), dir/project = Cyan (`git.go:29-31,56`), branch = Green, dirty `*` = Red, worktree = Magenta, vim mode = Magenta, PR number = Cyan, lines added green / removed red, session/cost icons = White, version/output style/repo = Dim, caveman icon orange, thinking `●` pink on / `○` dim off, effort icon by level (low dim, medium white, high cyan, xhigh aqua, max magenta; docs/CONFIGURATION.md "Colors"), todo `☑` green when complete. Percentages: `Thresholds.Color` (`style.go:63-76`) green < warn(50), orange >= 50, yellow >= 70 (`High`), red >= 90 (`Crit`); filled bar cells take that colour, empties are dim over the same hue (`:97-124`). Text typed in a template is a muted "label"; only `{field}` placeholders carry colour (docs lines 188-190).
2. Themes: not present. One hardcoded palette; no user colour override (only thresholds `warn/high/crit` are configurable). Comment `style.go:14-21` records that each new colour must clear CIEDE2000 18.4 against all others and that ten is near the limit.
3. Spec/depth: truecolor fg escapes only (`\033[38;2;r;g;bm`), `\033[2m` dim. No depth detection. NO_COLOR honoured: `NewPalette()` disables colour when `NO_COLOR` is non-empty; `Wrap` returns the string untouched (never a bare reset).
4. Fill: foreground-only.
5. Separators: plain text, built-in `" │ "`, configurable per line (`separator = "  "`), uncoloured.
6. Neighbours: separators plus the distinct hue per field.
7. Light/dark: not present (docs and code assume nothing about background); effort glyphs form a fill ramp so levels survive without colour.
8. Glyphs: `●`/`○` bar cells, emoji icons per segment, `⟳` etc.; icons are template fields so colour follows them.
9. Other: palette distance was measured with CIEDE2000, golden tests render plain text via `NoColor()`.
10. Customisation: TOML (`~/.claude/statusline.toml`, per-project `.claude/statusline.toml`): `[[lines]] segments=[...]`, `separator`, per-segment `template`, `bar_width`, thresholds; presets reference/minimal/verbose/api; `knit-statusline doctor` lists fields and config errors.

## DmVergasov/ClaudeTerm
https://github.com/DmVergasov/ClaudeTerm (stars 2)
not a Claude statusline: an Electron/xterm.js terminal app with its own status bar UI (`src/renderer/status-bar.ts`, three terminal themes in `themes.ts`); `src/hook/status-line.ts` only captures statusLine data and prints nothing styled.

## EdoardoCroci/claude-tap
https://github.com/EdoardoCroci/claude-tap (stars 2)
Two things: a statusline script and a notification popup; themes belong to the popup.
1. Colour: fixed per segment plus threshold (`linux/src/statusline.sh:101-135,265-310`, macOS/Windows twins). Model = bold orange (`38;5;215`), cwd name bold, branch gray `⎇`, separators gray `│`, `5h:`/`7d:` labels gray. `pct_color` (`:117-126`): green `38;5;114` below 50, yellow `38;5;222` below 80, else red `38;5;174` (muted pastel tones); applied to the context % + bar and to each rate percentage. Lines `+N` green, `-N` red, `DND` dim.
2. Themes: statusline has none. `assets/themes.json` holds 6 popup themes (dark, light, solarized-dark, catppuccin-mocha, dracula, nord), each with `normal`/`warning`/`critical` states of RGBA background, border, title, text (floats 0-1); custom RGBA allowed (README). Popup only, not statusline.
3. Spec/depth: 256-colour indices; no detection; NO_COLOR not found.
4. Fill: statusline foreground-only; popup is filled with backgrounds.
5. Separators: gray plain `│`.
6. Neighbours: separators and per-state colours.
7. Light/dark: statusline none; popup has `light` theme (README says themes selectable).
8. Glyphs: `⎇`, `│`, bar chars; no Nerd Font.
9. Other: Dynamic-Island-style notification with warning/critical colour states; sound alerts; DND flag.
10. Customisation: `macos/configure.sh` for the popup/themes; statusline edited as a script.

## ethanplusai/context-meter
https://github.com/ethanplusai/context-meter (stars 2)
1. Colour: threshold on one segment (`statusline.js:49-55`): `[██░░ N%]` bar in green (<50), yellow (<65), orange `38;5;208` (<80), red; model and dir are `\x1b[2m` dim. Percent is usable context with an auto-compact buffer subtracted (`:30-41`).
2. Themes: not present.
3. Spec/depth: ANSI 16 + one 256 index. No detection, no NO_COLOR.
4. Fill: foreground-only.
5. Separators: two plain spaces.
6. Neighbours: bright bar vs dim text.
7. Light/dark: not present.
8. Glyphs: `█`/`░`, brackets; no icons.
9. Other: ships a Codex config helper (`scripts/codex-config.js`).
10. Customisation: `install.sh`; edit `statusline.js` constants (`BAR_WIDTH`, `AUTO_COMPACT_BUFFER_PCT`).

## ExtReMLapin/tqdm-claude
https://github.com/ExtReMLapin/tqdm-claude (stars 2)
not a Claude statusline: a Claude Code mod that draws tqdm-style progress bars above the prompt for background tasks and subagents (`hooks/render.ts`, label/cells/percent each in its own colour).

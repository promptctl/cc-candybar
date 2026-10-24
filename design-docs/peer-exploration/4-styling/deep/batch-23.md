## github.com/jsaddnf/claude-code-status-line
https://github.com/jsaddnf/claude-code-status-line - stars 1
1. By state/threshold plus fixed. `statusline.sh`: context-left colour is a threshold (>50 green `\033[32m`, >20 yellow, else red). 5h bar colour by used% (<60 green, <85 yellow, else red). Cost (API-billing only) <$1 dim, <$10 cyan, <$50 yellow, else red. Effort per level: low dim, medium yellow, high cyan, xhigh magenta, max bold red. Fixed: model dim, git branch cyan.
2. Themes: not present. Colours are hard-coded in the script.
3. Named ANSI 16 only (`\033[3Xm`). No depth detection, no NO_COLOR.
4. Foreground only.
5. Plain ` │ ` text separator, uncoloured.
6. Neighbours: separator `│` plus emoji prefixes (🌿 🧠 ⚡ 📊 💰); different hues only incidentally.
7. Light/dark: not present. Uses `\033[2m` dim and 16-colour ANSI, which the terminal theme maps.
8. Emoji only; no ASCII fallback. Bar glyphs ▓░.
9. Nothing notable; cost segment hidden on subscription plans.
10. Edit the script; `install-statusline.sh` only wires settings.json. No config file.

## github.com/jv-k/claude-gauge
https://github.com/jv-k/claude-gauge - stars 1
1. By state and by role. `src/statusline.ts` `THEME_REGISTRY` (l.~365): each part draws from role slots, never its own code: `levels` (10 steps by usage decile), `pace` (6 steps by projected end-of-window usage), `context` (3 stops: <=50, <=75, above), plus `muted` (separator, time, duration, repo), `accent` (model state, unreported window), `good` (branch, lines added), `bad` (lines removed, failure), `info` (folder). `--color part=colour` overrides one part to a solid colour (`solid()`), except pace marker keeps its theme colour.
2. Four bundled presets via `--theme`: default, mono, high-contrast, pastel. Format is a semantic role record (`Theme` interface). Custom themes: no preset file, but `--color` per-part override accepts name, 256 index or hex.
3. Default theme uses 256-colour indices (`ansi256(22,28,34,100,...)`); `--color` accepts named ANSI (incl `bright-`), 0-255, `#f80`/`#ff8800` (truecolor `38;2`). No auto depth detection. `statusline.ts` does not read NO_COLOR (grep shows none); the CLI output helper `colorEnabled` in `src/wordmark.ts:22` honours NO_COLOR, FORCE_COLOR, CLICOLOR_FORCE. The `mono` theme is the statusline's colour-off.
4. Foreground only on the statusline. The command's own section headers use inverted pills (`\x1b[7;1;36m`) in `src/styles.ts`.
5. Plain ` │ ` in `muted`; `--compact` drops the spaces (`separatorOf`, l.509).
6. Separator only; hue by role.
7. `high-contrast` uses bright ANSI + white details "for dim screens and low vision"; `pastel` soft tones. No terminal-background detection.
8. Emoji/box glyphs; OSC 8 hyperlinks on folder/branch parts. Pace marker `┃`.
9. Pace marker coloured by projected usage; a 10-step green-to-red level scale; web docs/media/themes.png screenshots. Parts selectable with `--show`.
10. CLI flags (`--theme`, `--color`, `--show`, `--compact`), setup wizard (`src/wizard.ts`), settings file written by setup.

## github.com/kaic5504/clawd-bar
https://github.com/KaiC5504/clawd-bar - stars 1
not a Claude statusline: a Claude Code mod plugin that draws a three-row animated band (pixel crab Clawd, SVG/pixel scenes) above the prompt. Colour note only: its gauges use `levelColor(percent)` in `hooks/usage.ts:17` (>=90 RED, >=80 AMBER, else GREEN); empty boxes are dim text colour, "glint" sweeps a colour change across boxes (`hooks/bars.ts`). Colours are "a theme colour" per `Paint`.

## github.com/kevanshgopani/claude-statusline
https://github.com/KevanshGopani/claude-statusline - stars 1
1. Fixed label colours plus threshold on bar fill. `statusline-command.sh`: labels bold bright: Context `\033[1;96m`, Weekly `1;95`, Session `1;94`; cwd bold cyan `1;36`; effort label bold yellow, value bright yellow; model bold yellow; reset countdown bright green `92`. Bar fill by used%: <60 `38;5;108` (sage), <85 `38;5;180` (tan), else `38;5;174` (rose); empty cells grey `90` ░.
2. Themes: not present.
3. ANSI 16 (labels) plus 256 index (bar fill). No depth detection, no NO_COLOR.
4. Foreground only.
5. Plain text: two spaces between bars, `*` before the reset time, ` | ` between effort and model (grey `90`).
6. Neighbours: different label hues (96/95/94 are adjacent blues-magentas) plus spacing.
7. Light/dark: not present. Muted sage/tan/rose 256 colours chosen as softer than pure red/green.
8. ASCII plus block `█░`; no icons.
9. Right-aligned second line: pads to `tput cols` using ANSI-stripped visible width (`right_align`, `vlen`).
10. Edit the script; bar width constants `CONTEXT_BAR_WIDTH=24`.

## github.com/kevinlincg/claude-statusline
https://github.com/kevinlincg/claude-statusline - stars 1
1. Per theme, each theme is a Go struct with its own constants (`themes/*.go`, ~69 themes, each a `Render(StatusData)`). Shared palette in `themes/themes.go` (all truecolor: ColorGold `195;158;83`, Cyan, Pink, Green, Orange, Purple, Blue, Red...). Context colour via `GetContextColor` (`ColorCtxGreen`/`Gold`/`Red`, 108,167,108 / 188,155,83 / 185,102,82). In `oneline_powerline.go`: fixed per segment, model amber bg `48;2;60;50;30` text `220;185;100`; path blue bg `30;40;65`; git green bg `30;55;35`; 5h teal bg `25;50;55`; 7d purple bg `45;30;55`; percent colour by threshold (<50 bright green, <75 bright yellow, else red).
2. 69 bundled themes (README says so; THEMES.md groups: Classic & Minimal, One-line & Pills, Sci-Fi & Cyberpunk, Nature, System Monitor, Retro & Gaming, Classic Anime Tributes, Studio Ghibli, Modern Anime, Anime Aesthetics). Themes are code (a `Theme` interface registered with `RegisterTheme`), not data; users cannot define their own without writing Go. Default `classic_framed`.
3. Truecolor `38;2`/`48;2` only. No depth detection, no NO_COLOR (grep of `statusline.go` and `themes.go`: none).
4. Both: fg-only themes (classic, framed) and bg-filled (powerline/pill/HUD uses glow-bar backgrounds `BgGreenGlow 20;55;25`).
5. Powerline theme uses `` arrow whose fg is the previous segment's bg and bg is the next (separate `PL*Fg` constants mirror each `PL*Bg`). Other themes use tree glyphs / frames (`ColorFrame 60;60;60`).
6. Powerline: a distinct dark hue per segment (gold, blue, green, teal, purple) plus arrows. Other themes: frames/dividers.
7. Light/dark: not present. All palettes are dark-terminal tuned.
8. Emoji and box-drawing in 5817 hits; powerline needs Nerd Font in the powerline theme only; no ASCII mode seen.
9. Interactive theme picker (`--menu`), `--preview <theme>`, `--set-theme`, screenshots per theme in assets/themes/.
10. Theme name stored in a config file (`loadThemeConfig`/`saveThemeConfig`), CLI flags `--list-themes --preview --set-theme --menu`.

## github.com/kevinmedeiros/claude-mods
https://github.com/KevinMedeiros/claude-mods - stars 1
not a Claude statusline: a marketplace of six Claude Code mod plugins (usage-limits band, fluxo handoff, roadmap, tarefas, Unity and Blender tools) that draw bands/panes via TypeScript hooks. Its one status-line-like item is a "Unity status line" inside the unity-tools mod; styling not examined (66 hex colours across the SVG preview generator `docs/generate-previews.ts` and mod hooks).

## github.com/key/key-plugin-cc
https://github.com/key/key-plugin-cc - stars 1
1. `plugins/statusline/scripts/statusline.sh`: fixed per segment, ANSI vars: red `31` (Sandbox/DevContainer label), cyan `96` (user, host, account), blue `94` (dir), magenta `95` (branch), green `32` (worktree), yellow `33` (model), separators white `37` ` | `. Bars (ctx, 5h, 7d) by threshold: >=80 red, >=50 yellow, else green (`bar_for_pct`).
2. Themes: not present.
3. ANSI 16 only; no NO_COLOR, no depth detection.
4. Foreground only.
5. Plain ` | ` in `sep='\033[37m'`.
6. Neighbours: differing hues per segment plus emoji prefix (📦 🏠 🌿 🌳 📧 🤖 🧠 ⏱️ 📅) and pipes.
7. Light/dark: not present.
8. Emoji only. Bar uses eighth-block partials `▏▎▍▌▋▊▉` for sub-cell resolution.
9. The comment says "gradient" but the bar is a 3-step threshold, not a gradient. Account email masking (`CLAUDE_STATUSLINE_ACCOUNT=masked|full|domain|off`). Other plugins in repo are lint hooks (not styling).
10. Script only; env var for the account display.

## github.com/khaleelibrahimofficial/claude-hud
https://github.com/Khaleelibrahimofficial/claude-hud - stars 1
1. `hooks/statusline-command.sh`: only the context line is coloured, by threshold: >=70 red `\033[31m`, >=40 yellow, else green. The Session/Week line is uncoloured plain text.
2. Themes: not present.
3. ANSI 16. No NO_COLOR, no depth detection.
4. Foreground only.
5. Plain ` | ` between Session and Week.
6. Neighbours: not distinguished (labels `Context:`, `Session:`, `Week:`).
7. Light/dark: not present.
8. ASCII plus `█░` bars in brackets; no icons.
9. Desktop notifications via `notify-send` at 70% once per session per metric (sentinel files in /tmp); `--test` mode.
10. Script edit only; timezone hard-coded label (Asia/Calcutta).

## github.com/kiriketsuki/claude-statuskine
https://github.com/Kiriketsuki/claude-statusKine - stars 1
1. `statusline-command.sh` (project name "Chrysaki"): mixed. Fixed: Blonde Light `208;184;80` unsynced commits, Teal `30;136;152` context normal and issues, Emerald Light `26;138;106` 5h normal and inbox, Secondary `160;164;184` 7d normal, Muted `106;110;130` separators and reset timers, green `80;180;80`/red `192;80;80` for insertions/deletions. By threshold: >=50% `C_WARN 184;160;56`, >=75% `C_ERROR 192;64;80`; context orange (256 index 208) as warning, red at >=128k tokens. Progress bar fill picks normal/warn/critical colour by thresholds (`progress_bar`, 8 cells). Plus animation (below).
2. One palette named "Chrysaki"; no theme switch. Bar glyph style selectable (`BAR_STYLE`: hex `⬢⬡` default, diamond, circle, wave `▲▼`, block).
3. Truecolor `38;2` for nearly all colours, one 256 index (`38;5;208`). No depth detection. Honours NO_COLOR with a local twist: `NO_COLOR=0` re-enables colour (`NO_COLOUR` var, l.~12); all colour vars set empty. `CHRYSAKI_NO_ANIMATE` freezes animation, `CHRYSAKI_NO_LINKS` drops hyperlinks.
4. Foreground only.
5. Plain text and "bridge" glyphs tinted by a jewel colour.
6. Neighbours: per-line "bridge" accent colour from a 9-colour jewel pool (Emerald, Jade, Deep Teal, Royal Blue, Sapphire, Indigo, Amethyst, Twilight, Storm), seeded by the timestamp so each line gets a different colour that shifts per render; dimmed variants for lines 2-4.
7. Light/dark: not present (dark palette). NO_COLOR path only.
8. Unicode geometric glyphs (hexagons, diamonds, triangles); emoji sparse. No Nerd Font required.
9. Animation: threshold pulse using an 8-step sine table (scale 70-100 on warn/critical colours), 4-phase wave scroll on the bar (`wave_shift`), solid/outline badge alternation, jewel colours changing each render. A `gradient_text` helper was REMOVED in v2.1 (comment l.139), pending `refreshInterval`.
10. Env vars (`BAR_STYLE`, `CHRYSAKI_*`, `NO_COLOR`); scripts `init.sh`, `fetch-stats.sh`, `export-cost.sh`.

## github.com/kj21-eng/keyjey
https://github.com/KJ21-ENG/keyjey - stars 1
1. User-defined per module via Starship-style style strings. `src/ansi.rs` `apply_style`: space-separated tokens `bold|italic|underline|dimmed|blink|reverse|hidden|strikethrough`, `fg:`/`bg:` prefixes, colour names `black..white` (`purple|magenta`), `#RRGGBB`, `#RGB`, or 0-255 index (`parse_color`, l.189). Threshold switching per module: `warn_threshold/warn_style`, `critical_threshold/critical_style` (`apply_style_with_threshold`); README example: cost green, warn 2.0 yellow, critical 5.0 bold red; context_bar warn at 40. Inline spans in format strings: `[text](style)`.
2. Themes: none bundled as a theme system; README ships config recipes, one of them "Material Hex" (every style `fg:#rrggbb`, e.g. model `#c3e88d`, amber warn `#ffcb6b`, coral critical). Users write TOML freely.
3. Named ANSI 16, 256 index, and truecolor via `nu_ansi_term`. No depth detection or NO_COLOR seen in `ansi.rs`/`renderer.rs` (grep: none).
4. Both, user's choice (`bg:` token supported; a test shows `fg:#3d414a bg:#5f6366` for an empty styled span used as a separator cap).
5. User-defined text in the `lines` format string (e.g. `$keyjey.model  $keyjey.cost`); empty styled spans can act as caps. No built-in powerline logic seen.
6. Neighbours: author's choice; no automatic distinction.
7. Light/dark: not present.
8. Emoji and box glyph counts high in README; Starship modules can bring Nerd Font symbols. No ASCII-mode flag seen.
9. Starship passthrough ($git_branch etc.), Codex CLI footer setup with presets `rich|compact|minimal|off`, `keyjey explain` table, ≤10 ms render budget.
10. TOML `~/.config/keyjey.toml` or project `keyjey.toml`; `lines = [...]` rows of `$keyjey.<module>` tokens; CLI `keyjey setup`, `explain`.

## github.com/kk-ben/claude-code-statusline
https://github.com/kk-ben/claude-code-statusline - stars 1
1. `statusline.sh`: by threshold via `make_bar pct yellow_th red_th`: green below, yellow at >=th, red at >=th. Per metric thresholds: ctx 50/60, 5h 70/90 (default), 7d 51/76, Fable weekly 51/76. Git dirty `●N` yellow, clean `✓` green; lines `+N` green `-N` red; others uncoloured.
2. Themes: not present.
3. ANSI 16 (`\033[32m` etc.) with `$'\033[0m'` reset; no depth detection, no NO_COLOR.
4. Foreground only.
5. Plain ` │ ` joiner (`join_sections`).
6. Neighbours: separators and a distinct emoji lead (🤖 ⏳ 📅 📖).
7. Light/dark: not present. It does detect real terminal width by walking the process tree to the Claude Code tty, and truncates model/dir/skill in three width bands (<90, <140, >=140).
8. Emoji; bar uses eighth-block partials `▏..▉` over 5 cells.
9. Async cached fetches (Fable weekly usage via OAuth usage API), per-model token breakdown line 3. Nothing visual beyond that.
10. Script only; env `CLAUDE_STATUSLINE_COLS` forces width.

## github.com/kylesnowschwartz/tail-claude-mux
https://github.com/kylesnowschwartz/tail-claude-mux - stars 1
not a Claude statusline: a tmux sidebar (`tcm`, bun, TPM plugin) listing sessions and agent state. For reference it bundles themes: `apps/server-go/internal/theming/themes.go` and `packages/runtime/src/themes.ts` list ayu, catppuccin, dracula, everforest, github, gruvbox, kanagawa, nord, one-dark, tokyo-night, plus `integrations/tmux-plugin/themes/default-palette.tmux.conf`.

## github.com/lanestp/vid-line
https://github.com/lanestp/vid-line - stars 1
1. No segment colouring of note. `statusline.zsh`: plays pre-rendered video frames (chafa output) cat'd from `~/.cache/vidline/current/frame_NNNNN.txt`, chosen by wall-clock (`EPOCHREALTIME * fps % nframes`). The one info line is fixed: dim `[2m` 🎬, model cyan `[36m`, rest uncoloured.
2. Themes: not present.
3. Frame colour depth is a build option in `vidline`: `--colors full|256|16` (default `256`; truecolor "~3x the bytes", l.118). Info line ANSI 16. No NO_COLOR.
4. Both: chafa symbols `vhalf` (half-block `▀▄` with fg and bg per cell) for the video; info line fg-only.
5. Not present.
6. Not applicable (image).
7. Not present. Image is dithered by chafa to the chosen palette.
8. Half-block pixel graphics; emoji 🎬.
9. Video-as-statusline animation (ffmpeg → PNG → chafa → text), `demo/` Remotion project.
10. CLI `vidline` (width, height, fps, max seconds, colours), `install.sh`.

## github.com/leaf-x317/cc-statusline
https://github.com/leaf-x317/cc-statusline - stars 1
1. `bin/statusline.sh` `set_theme_colors()`: role variables per theme: `COLOR_MODEL`, `COLOR_EFFORT`, `COLOR_THINKING`, `COLOR_CONTEXT_LOW/MED/HIGH`, `COLOR_DURATION`, `COLOR_CPU`, `COLOR_GRAY` (90, prefixes and separators). Context colour by threshold: >=85 HIGH, >=70 MED, else LOW. Changes fg `+N` green `32`, `-N` red `31`; cwd/repo/branch values white `37`.
2. Three bundled: classic (model 94, effort 36, thinking 35, ctx green/yellow/red), matrix (green 32/92; ctx identical), ocean (cyan 36/96, blue 94; ctx LOW is cyan 36). Format: SGR number per role in a shell `case`. Select with `CC_STATUSLINE_THEME` env or edit `THEME=`. Users can add a case arm; no external theme file. Screenshots `assets/theme-*.png`.
3. Named ANSI 16 SGR numbers (the "unclassified" 24 hits). No depth detection, no NO_COLOR.
4. Foreground only.
5. Plain ` | ` in gray `90` (`$COLOR_GRAY`).
6. Neighbours: gray `|` dividers and gray glyph prefixes (✦ ◼ ⎔ ⌥ ◔ ◷ ▣ Δ) before white values.
7. Light/dark: not present.
8. Unicode symbols (not emoji, not Nerd Font); bar `█░` over 10 cells.
9. CPU utilisation from `/proc/stat` deltas (hidden on macOS); `timeout 2 git` guards.
10. Env var `CC_STATUSLINE_THEME`, script edit; `bin/install.js` npm installer.

## github.com/leonardocandiani/glint
https://github.com/leonardocandiani/glint - stars 1
1. `statusline-command.sh` (zsh): palette "Apple dark system" fixed: primary `242;242;245` values, second `162;162;170` labels/icons, tertiary `104;104;112` bar track, accent blue `10;132;255` for the model, dirty amber `232;163;61`, gold `255;200;60` thinking lamp. By state: context colour is one value for the whole block: <50 green `48;215;88`, >=50 yellow `255;214;10`, >=75 orange `255;159;10`, >=90 red `255;69;58`. Effort per level: low gold, medium green, high blue `77;158;255`, xhigh purple `167;139;250`, max magenta `210;110;245`, ultra cyan `45;215;255`. Quota windows 55/80/90 thresholds (README). Account `①` blue / `②` amber. Colour appears "only in the context state", per the header comment.
2. Themes: not present; one look. A JSON config `~/.config/glint/config.json` has `theme.flat/links/ascii` booleans only (parts on/off, order, join style `block|pipe|space|none`).
3. Truecolor `38;2`/`48;2`. Depth handling: gradient only enabled in an allowlist of terminals (`TERM_PROGRAM` ghostty, iTerm2, WezTerm, kitty, Alacritty, vscode) because Claude Code downgrades the statusline to 256 colours elsewhere (anthropics/claude-code#59737, l.~262); otherwise it falls back to a solid background (`glass_flat=1`). `GLINT_FLAT_BG=1` forces solid, `GLINT_FORCE_GRADIENT=1` forces gradient. NO_COLOR: not present (grep none).
4. Background-filled pill cells with per-character `48;2` background and per-character fg (cells are one char + one fg).
5. Rounded Powerline caps `CAP_L`/`CAP_R` (Nerd Font); cap colour computed from the same edge light as the gradient (`FCAP`). Blocks inside a pill joined by 3 spaces, or `block|pipe|space|none` per part.
6. Neighbours: blocks inside one pill separated by spaces; when the terminal is narrow, blocks wrap greedily into extra pills (each rounded and complete). Hue is deliberately near-monochrome.
7. Adapts to terminal capability, not light/dark; palette is dark-only.
8. Nerd Font icons (16 hits) for folder, git, worktree, context, thinking, bolt, user, tag; `GLINT_ASCII=1` gives straight pill, no icons.
9. "Liquid glass": continuous background gradient across the pill, light rim at edges to dark centre, cool blue tint (`GLASS_B* 50;50;58` centre → `GLASS_S* 96;100;118` edges, `EDGE_PEAK=680`, quadratic curve). Web config panel `python3 ~/.claude/glint-panel/server.py` (loopback, drag order, live preview from the real script, undo/redo, presets, export/import).
10. JSON config; local web panel; env `GLINT_ASCII`, `GLINT_NO_LINKS`, `GLINT_FLAT_BG`, `GLINT_FORCE_GRADIENT`.

## github.com/lineofflight/claude-code-plugins
https://github.com/lineofflight/claude-code-plugins - stars 1
1. `plugins/statusline/scripts/statusline.sh`: Starship-style. Fixed: dir bold cyan `1;36`, branch bold purple `1;35` with Nerd Font glyph U+E0A0, dirty `*` red `0;31`, model/effort text uncoloured. Thresholds via `fmt_pct`: green <50, yellow <75, red >=75 for 5h and 7d. Context bar: filled in bold cyan (same as dir), empty bright-black; "no threshold colouring — the fill level alone shows how full".
2. Themes: not present.
3. ANSI 16 only. No NO_COLOR, no detection.
4. Foreground only.
5. Plain two-space gaps; no separator glyph.
6. Neighbours: dir cyan vs branch purple vs bars; spacing.
7. Light/dark: not present. Uses bright-black `90` for the empty part of the bar.
8. Nerd Font branch glyph (U+E0A0), heavy/light rules `━ ─` for the bar. No ASCII fallback.
9. Progressive disclosure: model shown only below the Opus baseline, effort only below xhigh, 5h/7d only past a hide threshold (7d uses a time-aware threshold: pace + 10pp capped at 75). Worktree-aware: shows project name when dir name equals branch.
10. Script only (plugin installs it via `setup.sh`).

## github.com/lippdev/lippstack
https://github.com/lippdev/lippstack - stars 1
Mostly not a statusline (collection of Claude Code mods and skills). Two relevant mods:
1. `plugins/where-line/hooks/register.ts`: calls `$.ui.status(text)`, a status line under the prompt, plain text `project · ⎇ branch · Model 5.5 · 🟢 ctx 40%`. Only colour is the emoji dot by context: >=80 🔴, >=60 🟡, else 🟢 (`contextText`). Text colours are the host's.
2. `stage-bar`: "an animated bar above the prompt... one color per stage" (README claim; `plugins/stage-bar/hooks/register.tsx` not read in depth).
3. Colour depth/NO_COLOR: not applicable to where-line (emoji only).
4. Fill: not present for where-line.
5. Separator: ` · ` with two spaces either side.
6. Neighbours: separator only.
7. Not present.
8. Emoji and ⎇.
9. Hallmark design-skill themes (almanac, arcade, ... 48 named) are web-design themes for a skill, not statusline themes.
10. Mod code only.

## github.com/lokiq0713/cc-statusline-tui
https://github.com/LokiQ0713/cc-statusline-tui - stars 1
1. Per segment `style` string. `src/config.rs` defaults: model "ultrathink" (rainbow), cost "green", usage and usage_7d "white", path "cyan", git "cyan", context "semantic", session "gray". `src/styles.rs` `color_code`: cyan `0;36`, green, blue `1;34`, yellow, magenta, red, white, gray `38;5;250`, soft-green/yellow/red/blue/cyan/magenta `38;5;71/179/167/75/80/176`, orange 208, pink 212, purple 141. "semantic" = traffic-light truecolor ramp: solid green `95,175,95` below 0.2, green→yellow `215,175,95` over 0.2-0.5, yellow→red `215,95,95` over 0.5-0.7, solid red above (`semantic_color`, piecewise RGB lerp). Layout fixed: rows `[model cost path git context]` and `[usage usage_7d session]`, not user-reorderable (comment at top of `config.rs`).
2. Themes: not present; per-segment style names only.
3. Named ANSI 16, 256 index (soft-* names), and truecolor (rainbow, semantic ramp). No depth detection or NO_COLOR seen in `styles.rs`.
4. Foreground only.
5. Single space join (`parts.join(" ")`).
6. Neighbours: different style per segment.
7. Not present.
8. Emoji default model icon 🔥; `bar_char` styles `shade ▓░`, `full-block █`, `rectangle ▬` (empty drawn dim `38;5;239`).
9. "Ultrathink" rainbow: 7-colour palette `ULTRATHINK_MAIN` with `ULTRATHINK_SHIMMER` light variant; per-character colour `(i + offset) % 7`, `timestamp % 2` picks shimmer, `timestamp % 7` is the rotation, so it animates on each refresh; "ultrathink-gradient" bar interpolates across the 7 colours.
10. A TUI installer/config (the repo name; `src/install.rs`), JSON-serialised `Config` with `rows`.

## github.com/lorenzopasquali/claude-statusline-configurator
https://github.com/LorenzoPasquali/claude-statusline-configurator - stars 1
1. Web configurator (Next.js) that generates a Python statusline script. Fixed per module in `src/lib/formatter.ts` `MODULE_COLORS`: context `#f59e0b` amber, session `#3b82f6` blue, model `#a78bfa` violet, cost `#34d399` emerald, git `#f472b6` pink, tokens `#38bdf8` sky, duration `#fb923c` orange, cwd `#94a3b8` slate. User picks a colour per module from a swatch row (`ModuleSelector.tsx` colour picker). `src/lib/generator.ts` l.~196 wraps each module's output in `\033[38;2;R;G;Bm` of its colour. Git adds green `+staged` and yellow `~modified` (l.152).
2. Themes: not present (per-module colour only).
3. Truecolor `38;2`. No depth detection or NO_COLOR.
4. Foreground only.
5. Configurable text separator, default ` | ` (`defaultSeparator`).
6. Neighbours: per-module hue plus separator.
7. Not present for the output; the configurator page itself is a dark UI.
8. Bar styles `ascii [###---]`, `unicode [▓▓░░]`, `minimal █░`, `none`; length configurable; i18n locales.
9. Live terminal preview in the page; drag-sort modules; generates install commands (`installer-generator.ts`).
10. Web UI, output is a generated script.

## github.com/lucasilverentand/claudeline
https://github.com/lucasilverentand/claudeline - stars 1
1. The user writes it per component with a format string: `colour:component`, e.g. `bold:cyan:claude:model`, `green:git:branch`. `src/colors.ts` maps names to SGR: black..white, gray, `bright-*`, `bg-*`, styles bold/dim/italic/underline/blink/inverse/hidden/strikethrough. Built-in state colours in `src/runtime.ts`: `ctx:bar` fill green <50, yellow <75, red else, bold at >=90, empty cells dim in the same hue; `ctx:icon` same thresholds (red bold >=90); git dirty `+N` green, `-N` untracked red, `~N` modified yellow.
2. Themes: 15 named presets in `src/themes.ts` (minimal, default, powerline, full, git, tokens, dev, dashboard, context-focus, cost, simple, verbose, nerd, compact, colorful, luca): these are format strings (layout + colour tokens), not palettes. `--theme X` installs; `theme:name` works as a format. Users can write any format string.
3. Named ANSI 16 + bright only (no 256, no hex, no truecolor). `--no-color`/`--disable-color` flag strips; env NO_COLOR not read (grep none). Nerd Font detection `detectNerdFont()` via `CLAUDELINE_NERD_FONT`/`NERD_FONT` env, then TERM_PROGRAM.
4. Foreground only (bg-* codes exist but themes do not use them).
5. `sep:` tokens in `src/separators.ts`: pipe, arrow, chevron, dot, middot, dash, slash, space, none, colon, tilde, double-pipe, bullet, diamond, star, newline, plus `powerline`, `powerline-left`, `powerline-thin` (Nerd Font glyphs). Separators auto-drop when an adjacent side is empty. Separator colour via prefix (`dim:sep:middot`).
6. Neighbours: separators; the `colorful` theme gives each component a distinct hue (magenta/cyan/green/yellow/blue).
7. Not present.
8. Nerd Font icons via `nerd:nf-*` tokens (162 hits in `nerdfonts.ts`); `--no-icons` flag and auto detection drop them. Effort icons ○ ◑ ● ◉.
9. Web preview/configurator (`web/` Astro app with `themes.ts`, `renderer.ts`); `--refresh-interval` installer option.
10. CLI flags (`--theme --install --project --no-icons --no-color --refresh-interval --list --preview`), format DSL.

## github.com/lucasquiles/qline
https://github.com/LucasQuiles/qLine - stars 1
1. `src/statusline.py` `DEFAULT_THEME` ("Muted Ocean", Nord-based): per-module dict with `color` (text hex) and `bg` (pill hex). Mostly fixed: model text `#d8dee9` on `#3b4252`; most other modules on bg `#2e3440` with a per-module text colour (dir `#8eacb8`, context `#8fbcbb` teal, git blue `#81a1c1`, etc.). By threshold: modules carry `warn_color` (`#ebcb8b`/`#f0d399`) and `critical_color` (`#bf616a`/`#d06070`); some carry `spike_color`/`notable_color`/`degraded_color`/`failed_color`. Alerts flash (`_flash`).
2. One default theme; users override any section via `~/.config/qline.toml` (`load_config`: shallow per-section merge over defaults, needs tomllib). Format: per-module hex map.
3. Truecolor hex only (`style()` emits `38;2`/`48;2`). Honours `NO_COLOR` (`NO_COLOR = bool(os.environ.get("NO_COLOR"))`, `style()` returns plain text). No depth downsampling.
4. Both: pills with bg + fg.
5. Rounded pill caps from `theme["pill"]` left/right (Nerd Font glyphs; `_pill`), caps drawn in the pill's bg colour. Row separator `│` dim (`separator.char`, `dim: True`).
6. Neighbours: separator `│` plus pills; two bg shades (`#3b4252` for model vs `#2e3440` for the rest).
7. Not present (dark Nord palette); `_darken_hex` helper exists for dimmed states.
8. Nerd Font glyphs (69 hits, Supplementary PUA like `\U000f06a9`); no ASCII mode seen. Layout can be forced to a single line.
9. Three-line layouts with ~40 modules (observability hooks for reads, rereads, compactions, hook faults), alert flash, `QLINE_*` env paths.
10. TOML `~/.config/qline.toml` (`[layout]` line1/line2/line3 lists, per-module tables), env vars.

## github.com/ma1achy/claude-statusline
https://github.com/Ma1achy/claude-statusline - stars 1
1. Semantic role system. `src/elements.ts` maps each element id to a `fill` role (fg, muted, accent, ok, warn, bad, info, gold, `gradient`, `rainbow`), e.g. `git.branch`→accent, `git.ahead`→ok, `git.behind`→bad, `git.dirty`→warn, `tokens.hit`→ok, `tokens.write`→warn, `dir`→muted, `separator`→muted, `usage.pct`→gradient (by value), `usage.warn`→bad bold, `name`→rainbow. `src/style.ts` `st(id, text)` is the single place colour is applied; cascade built-in default ← theme `elements` ← user `elements` ← per-call. Roles come from the theme palette (`src/themes.ts` `ROLES`): fg=WHITE, muted derived (foreground halved, floor 72), accent=CYAN, ok=GREEN, warn=AMBER, bad=RED, info=BLUE, gold=GOLD; a theme may pin `roles` to override.
2. 70 bundled themes (count of keys in `src/themes.data.ts`): heat (default), synthwave, matrix, mono, pastel, viridis, inferno, magma, plasma, cividis, twilight, cubehelix, batlow, turbo, coolwarm, rdbu, ice, deep, dracula, nord, gruvbox, tokyonight, rosepine, catppuccin x4, solarized dark/light, kanagawa, etc. Format: `ThemeData` = bar gradient (HSV ramp `hueHi/hueLo/sat/valLo/valHi` or `cmap` colormap stops) + 7-colour palette (RED GREEN AMBER BLUE CYAN WHITE GOLD) + optional per-element styles/glyphs/labels. Custom: `"theme":"custom"` with inline `customTheme`, `themeFile` (default `~/.claude/statusline-theme.json`), or a base16 hex string (`themeFromBase16` maps slots 05,08-0E onto the palette); colormap-only themes derive a palette (`deriveCmapPal`, brightness floor 125). Auto-theming: `autoTheme` daynight/seasonal/branch (`branchThemes`).
3. Colour depth is detected: `resolveColorMode()` in `src/config.ts` l.76: NO_COLOR → mono; else `SL_COLOR_MODE` env or `colorMode` config; else COLORTERM truecolor/24bit → truecolor, TERM dumb → mono, TERM contains 256 → 256, default truecolor. `src/ansi.ts` `tc()`/`bg()` downsample RGB to xterm-256 (`rgbTo256`, cube + grey ramp) and to 16 (`rgbTo16`), and emit nothing in mono.
4. Foreground text with some background (a `bg()`/`fgbg()` helper for half-block glyphs); mostly fg-only.
5. Text separators, role `separator`→muted (glyph configurable via elements).
6. Neighbours: role colours per element; no alternating scheme.
7. Accessibility mode `SL_ACCESSIBLE` swaps to a high-contrast palette `A11Y_PAL` over any theme, kills motion and turns rainbow into plain fg, with an AAA muted `tc(150,170,210)`; gauge variant `SL_ACCESSIBLE_GAUGE` (cvd palette). Muted/gradient text floored for readability (`gradientColor` lifts max channel to ≥150). Theme/terminal-background detection: not present.
8. Emoji and Unicode glyphs (1007 hits); VS16 text-presentation selector `︎` appended to force emoji-capable glyphs to take ANSI colour (`txt()`); glyph/label overrides per element.
9. Heavy animation: rainbow per-letter, `shimmer` (sweep/breathe/scan), element `anim` kinds pulse/breathe/wave/gradient-cycle, pseudo-fonts and case transforms, 'pet', 'moon', 'weather', gradient bars sampled from colormaps (viridis, turbo...), progress-file runs (`SL_RUNS_DIR`). Demo gifs in `assets/`.
10. JSON `~/.claude/statusline.json` (or `SL_CONFIG`), env `SL_THEME`, `SL_COLOR_MODE`, `SL_ACCESSIBLE`, `SL_RAINBOW_MIX`, presets, bad JSON falls back to defaults.

## github.com/malik1234567891011/poketerm
https://github.com/Malik1234567891011/poketerm - stars 1
1. `claude/statusline.py`: fixed per segment plus state. Model bold electric yellow `255,209,5`; HP label `TXT 217,210,194` (turns bold fire orange `255,106,19` at <=20%); HP bar colour by remaining%: >50 green `88,208,104`, >20 yellow `248,200,56`, else red `240,88,56`, empty `▱` dim `90,96,128`; PP value shiny pink `240,183,253` if >30 else fire; repo `TXT`; branch pink. Names use "living ink" colours (ELEC, SHINY, FIRE, GHOST) that a Ghostty shader animates.
2. One theme, "Poketerm": `claude/poketerm-theme.json` is Claude Code's own custom-theme file (`base: dark`, `overrides` with `claude`, `claudeShimmer`, `promptBorder`, `permission`, `planMode`, `success`, `error`, `warning`, `diffAdded`, `rate_limit_fill`, ...), plus a Ghostty theme (`ghostty/themes/poketerm`). That theme file styles Claude Code itself, not the statusline.
3. Truecolor `38;2` only. No depth detection, no NO_COLOR. (`osc11` hit = terminal background query elsewhere in the project.)
4. Foreground only.
5. Plain ` · ` in dim `90,96,128`.
6. Neighbours: separators; HP/PP labelled.
7. Light/dark: dark only; `lightdark.osc11` signal exists in the repo (not in statusline.py).
8. Pokémon battle UI motif: `▰▱` bar, labels HP/PP; no icons.
9. Ghostty shader that animates specific RGB values ("living ink") so the statusline's names shimmer; Pokémon sprites, sounds, PMD tools in other scripts.
10. Script/installer; theme JSON for Claude Code.

## github.com/manukrish2504/themes
https://github.com/Manukrish2504/themes - stars 1
1. `engine/statusline.sh` template (placeholders `@@BG@@ @@HEAD@@ @@ACCENT@@ @@MID@@ @@DIM@@ @@WARN@@ @@ERR@@ @@ICON@@ @@TAIL@@`, rendered per film plugin). Roles: HEAD (model, bold, uppercased, with icon), ACCENT (dir, branch, healthy bars, `+N` lines), MID (labels `ctx 5h 7d`, cost), DIM (separator dots), WARN (dirty count `●N`, bars past 60%), ERR (bars past 85%, `-N` lines). `heat()`: accent below 60, WARN at >=60, ERR at >=85, for ctx, 5h, 7d. Example `plugins/matrix/skills/statusline/statusline.sh`: BG `0;36;9`, HEAD `205;248;200`, ACCENT `0;255;65`, MID `47;158;79`, DIM `37;115;56`, WARN `230;255;0`, ERR `255;59;59`.
2. 50 bundled film themes (the extractor's list: arcane, avatar, avengers, ... wednesday). Each plugin ships `themes/<name>.json` — a Claude Code custom theme (`name`, `base: dark`, ~50 `overrides` keys: `claude`, `text`, `subtle`, `success`, `error`, `warning`, `diffAdded`, `userMessageBackground`, `rate_limit_fill`, `rainbow_*` ...) — plus a statusline whose six-colour palette is derived from the same theme (matrix's accent `#00ff41` = theme `claude`). Format: semantic palette. Users pick a plugin; the `/<slug>:statusline` skill installs the script. A new theme needs a new plugin.
3. Truecolor `38;2`/`48;2` only. No depth detection, no NO_COLOR.
4. Background-filled: every segment is wrapped in one flat `BG` (`seg()` prints bg, space, content, space, reset); fg varies inside.
5. Not present: segments are separated only by the bg block + spaces (and dim `·` inside the 5h/7d segment).
6. Neighbours: all segments share one background colour; distinguished by the HEAD/ACCENT/MID fg roles and spacing (a uniform slab).
7. Dark only (`base: dark`; background is a dark tint of the theme's hue). No contrast function.
8. Per-film icon (`@@ICON@@`) and `⌂ ⎇` glyphs; bar `█░`.
9. Chains to a previous statusline command via `FILM_THEMES_FORWARDED` forwarding. Matrix theme also recolours the `rainbow_*` keys to greens.
10. Install via per-theme plugin skill; requires jq; template placeholders substituted at generation.

## github.com/marmyx77/lampboard
https://github.com/marmyx77/lampboard - stars 1
not a Claude statusline: a macOS floating panel of traffic lights (Swift app plus a Claude Code mod) showing session state and a context ring per project; themes in `Sources/LampBoardCore/Live/LiveTheme.swift` and `VSCodeTheme.swift` style the panel, not a statusline.

# Batch 08: how 25 Claude Code statusline projects style

Source: each project's own code, fetched from raw.githubusercontent.com. File names below are repo paths. Line numbers are given where I read them; otherwise the file and key are named.

## claudehud
https://github.com/fyko/claudehud, stars 7
1. By role, with state thresholds. `claudehud/src/render.rs`: model name is always BLUE (~l.185), dir/repo CYAN (~l.288), git branch parens GREEN with a RED `*` when dirty (~l.291-299), labels (`ctx `, separators, `(1M)`) DIM. State colours via `claudehud/src/fmt.rs`: `color_for_pct` (<50 GREEN, 50-69 YELLOW, 70-89 ORANGE, >=90 RED) for context %, rate-limit %, and bars; `color_for_cost` (<$1 GREEN, <$5 YELLOW, <$20 ORANGE, else RED); `color_for_effort` (low DIM, medium GREEN, high YELLOW, xhigh ORANGE, max RED, unknown DIM); `color_for_severity` for status-page incidents (Minor YELLOW, Major ORANGE, Critical RED, Maintenance CYAN).
2. Themes: not present. The file header (`fmt.rs` l.1-8) says the point is to inherit the terminal's own palette so it works light and dark.
3. ANSI 16 only (`\x1b[31m`..`\x1b[36m`, `\x1b[2m` dim), plus one 256-colour exception: ORANGE = `\x1b[38;5;208m` (`fmt.rs` l.11), because ANSI has no orange and the severity ladder needs a step between yellow and red; the comment says 208 reads on both light and dark. No depth detection, no NO_COLOR handling in the files read (scanner flagged env.256color/truecolor hits elsewhere; not found in render.rs/fmt.rs).
4. Foreground-only text on the terminal's background. No background fills.
5. Plain text: `SEP = " \x1b[2m│\x1b[0m "` (`fmt.rs` l.18), a dim vertical bar with spaces. Fixed colour.
6. Neighbours are told apart by the dim `│` separator and by each segment's fixed hue (blue model, cyan dir, green branch). Nothing alternates.
7. Light/dark: solved by using the terminal's ANSI 16 palette instead of fixed RGB (header comment, `fmt.rs`). No contrast calculation.
8. Unicode only: `●`/`○` bars (`build_bar`, `fmt.rs` l.70-83), `⚡` fast-mode, `💰` cost emoji. OSC 8 links on the incident line (`render.rs` ~l.338-378). No Nerd Font, no ASCII mode seen.
9. Notable: effort level and cost share the same green->red ladder as usage, so one colour vocabulary means "how expensive is this". An unrecognised effort tier renders DIM "rather than guessing at a tier" (`fmt.rs` l.44-46).
10. Customisation: not verified from colour code; colours are consts, no user colour knobs found in `fmt.rs`/`render.rs`. Rounding mode is parsed in `render.rs` l.28-29 (not styling).

## hoobnn-agent-mods (hud mod)
https://github.com/hoobnn/hoobnn-agent-mods, stars 7. Note: `claude-code/hud` is a theming/animation layer over the third-party claude-hud plugin, not a standalone line; the spinner mod in the same repo is unrelated to colour of a statusline.
1. Per segment role from a palette, with state overrides. `hooks/hud/render/colors.ts`: model default CYAN (l.86), project YELLOW (l.90), git MAGENTA (l.94), gitBranch CYAN (l.98), label DIM (l.102), custom CLAUDE_ORANGE `38;5;208` (l.106). Context bar: `getContextColor` (<70 context colour/GREEN, >=70 warning/YELLOW, >=85 critical/RED, thresholds overridable, l.122-132). Usage: `getQuotaColor` (<75 BRIGHT_BLUE, >=75 BRIGHT_MAGENTA, >=90 RED; also escalates by "pace", l.138-146). Each role is overridable by key (`HudColorOverrides`).
2. Themes: 13 names seen in `hooks/themes.ts` (l.66-215): classic, neon, rainbow, emoji, sakura, kawaii, mecha, shonen, tokyo-night, matrix, nerd, powerline (plus `gallery` png). Format: semantic palette roles `{model, project, git, gitBranch, label, context, usage, warning, usageWarning, critical, custom, barFilled, barEmpty}` as hex, plus `glyphs`, `separator {text,color}`, optional `powerline {backgrounds[], cap}`, optional `gradient[]`, optional `mascot` faces. `applyPalette` (l.228) lays the theme over claude-hud's colours but a colour the user already changed from default stays theirs. Users select with `/hud theme <name>`; user-defined themes: not present (list is a const array).
3. Colour spec: named ANSI (8 names incl. `brightBlue`), 256 index number, or `#rrggbb` truecolor (`colors.ts` `resolveAnsi`, l.40-51). `hooks/ansi.ts` parses `ansi256(n)` codes for the Ink span model. No depth detection or NO_COLOR found in the files read.
4. Both. Default themes: foreground only. `powerline` theme: each separator-delimited segment gets `backgroundColor` from `backgrounds[i % n]`, `['#313244','#45475a','#1e1e2e']` (`themes.ts` l.213, `powerlineSpans` l.297-315).
5. Per theme: `separator.text` replaces claude-hud's ` │ ` (neon ` ❯ ` `#7a5cff`, sakura ` ✿ `, mecha ` ┃ `, tokyo-night ` │ ` `#3b4261`, nerd `  `). Powerline: cap `` with fg = left segment background and bg = next segment background (`powerlineSpans` l.311-312); last cap fg only. The separator is a fixed colour per theme.
6. Powerline theme alternates three dark backgrounds by index (cycle of 3). Other themes rely on separators and per-role hues (each element a different hex).
7. Not present as detection. Themes pick colours by hand (tokyo-night, nerd use Catppuccin Mocha hexes `#89b4fa` etc.). Powerline text colours are the palette fg over dark backgrounds; no contrast computation.
8. Nerd Font glyph set `NERD_GLYPHS` (`themes.ts` l.43-64), flagged `isNerdFont`; emoji theme; kawaii/sakura kaomoji mascot; ASCII-ish `matrix`/`mecha` glyphs (`context: 'SYNC'`, `usage: 'PWR'`). Per-theme `barFilled/barEmpty` (`▰▱`, `✿·`, `▮▯`, `●○`).
9. Gradient: `gradientAt(stops, t)` linear RGB interpolation (l.259-266); `gradientSpans` colours each filled bar cell and the model badge along the gradient (rainbow: 7 stops; shonen: 4 stops), skipping bars already in warning/critical colour (l.272-290). Mood-driven mascot (`moodOf`: calm/busy/worried/panic/out by context %, usage %, busy) in the extras row. README screenshots in `claude-code/hud/assets/themes/*.png`.
10. Config via Claude Code `/config` option `theme` (README l.35); `/hud theme [name|next|reset]`; claude-hud's own `colors` config for per-role overrides.

## ccquota
https://github.com/Nardohsu/ccquota, stars 7. Two surfaces: a Python statusline (`ccquota.py`), a Tk desktop panel (`ccquota_panel.py`), and an Ink mod (`hooks/register.tsx`).
1. Statusline (`ccquota.py`): ANSI codes `DIM=2 RED=31 YEL=33 GRN=32 CYA=36` (l.44). Directory basename CYAN (l.758), session name DIM (l.763), `ctx`/`5h`/`wk`/Codex percentages coloured by `level(frac)` (>=0.90 RED, >=0.70 YEL, else GRN; l.50-56), labels `5h `/`wk `/`today `/`cache ` plain or DIM, cost DIM, running-count dot GRN, cache cold marker `*` YEL. By state for numbers; fixed for dir/labels.
   Mod (`hooks/register.tsx` l.25-30): `tone(pct)` returns Ink semantic names `success`/`warning`/`error`/`subtle` (>=90 error, >=70 warning), so it follows the host's theme roles.
2. Themes: not present in the statusline. The Tk panel hard-codes a dark palette (`ccquota_panel.py` l.39-48: BG `#0d1722`, CARD `#162432`, GRN `#72d6a4`, YEL `#e4c775`, RED `#d1554f`, BLUE `#8dafcb`).
3. ANSI 16 only for the line. `NO_COLOR` honoured and also `CCQUOTA_COLOR=0` (`ccquota.py` l.42). No depth detection. Panel uses hex.
4. Foreground only on the line.
5. Plain-text: `SEP = os.environ.get("CCQUOTA_SEP", "  ")` (l.38), two spaces by default, user-settable. Mod uses a dim `  ·  `.
6. Separator whitespace plus per-value colour; labels DIM so numbers stand out.
7. Statusline: none (ANSI 16 inherits the terminal). Mod: Ink semantic roles follow host theme.
8. Plain text mostly; `●` dot, `~` marks estimates/stale values. No Nerd Font.
9. Python Tk desktop panel with a scene renderer (`ccquota_scene.py`) and some animation (scanner flagged motion.animation=3). Not statusline-relevant.
10. Env vars: `CCQUOTA_COLOR`, `NO_COLOR`, `CCQUOTA_SEP`, `CCQUOTA_CTX_LIMIT`, others (README l.149-150). No config file for colour.

## dashline
https://github.com/ordinarynerds/dashline, stars 7
1. Per widget with state override. `src/widgets/*.ts` set a fixed `color` per label widget (branch `cyan` + `⎇`, model `bold`, `--` placeholder `dim`); `context`, `session`, `weekly` return `kind: 'percent'` with a `scale` and "color themselves by fill (green to red)" (README l.167) using thresholds `contextWarningAt 40 / contextCriticalAt 50`, `usageWarningAt 70 / usageCriticalAt 90` (`src/config.ts` l.43-47). Every item can override with `color`, `bg`, `bold/italic/underline` (`src/config.ts` TextItem).
2. Themes: 5 (`src/style.ts` l.20-28): nord, dracula, gruvbox, catppuccin, ordinarynerds. Format: a remap of the ten named colour words (`red green yellow blue magenta cyan gray black white`) to hex, applied once at startup (`setTheme`); attributes are never themed. Not semantic roles; user-defined themes: not present (const table), but a user may use any hex per item.
3. Colour spec: named SGR 30-37/90, or `#rrggbb`/`#rgb` truecolor (`style.ts` `codesFor`, `hex`). Bars use truecolor (`38;2`). No depth detection or NO_COLOR found in `style.ts`/`render.ts`.
4. Both. Default: foreground. `bg` option for badges (`{ "text":" PR ","color":"black","bg":"#C678DD" }`, README l.295-296). Powerline mode fills.
5. Default separator is the text `·` (`config.ts` DEFAULTS.separator), configurable. Powerline (`src/powerline.ts`): `` U+E0B0 right and U+E0B2 left; arrow fg = left segment's bg code converted via `bgToFg`, arrow bg = next segment's bg (l.34-38); last arrow fg only.
6. Powerline: a segment with no bg takes an alternating neutral from `AUTO_BG = ['#3b3b3b','#2f2f2f']` by index (`powerline.ts` l.5, 18-21). Otherwise separators and per-widget hue.
7. Not present beyond theme choice; no contrast calc.
8. `icons: false` default; `⎇` glyph for branch; powerline needs Nerd Font (README l.328-331).
9. Bar style `gradient`: each filled cell coloured on a green `[53,209,59]` -> yellow `[229,185,58]` -> red `[255,85,85]` ramp by position (`src/present/gradient.ts` l.5-52). Browser "builder" playground (`playground/`, dashline.ordinarynerds.com/build) to set colours/thresholds and copy the config. Layout zones left/center/right per line.
10. JSON under a `dashline` key in Claude `settings.json` / `settings.local.json`, global and project-level merged (`config.ts` l.54-85); project-level files may not introduce commands (trust check). Keys include `theme`, `powerline`, `icons`, thresholds, `separator`, `margin`.

## tokburn
https://github.com/patheonsceo/tokburn, stars 7
1. Mostly one colour; colour is reserved for state. Header comment of `tokburn-cli/statusline.js` l.113: "COLOR RULE: White = facts. Dim = structure. Green/Yellow/Red = bars ONLY." Model/plan, tokens, cost are uncoloured. Bars and their percentage: `barColor`/`pctColor` (>=80 red, >=50 yellow, else green; l.82-88) with truecolor values `fg(70,160,70)`, `fg(180,150,50)`, `fg(180,60,60)`, `fg(80,180,80)`, `fg(200,170,60)`, `fg(200,70,70)` (l.28-31, 76-78). Context bar uses a fixed `xpFill = fg(200,150,50)` (l.80, 98).
2. Themes: not present in the statusline. `github` in the scanner list is a URL, not a theme. (Pet "personality" and sprite palettes exist: `sprites.js` Flint/Pixel/Mochi palettes.)
3. Truecolor `\x1b[38;2;r;g;bm` (l.25), `DIM = \x1b[90m` (bright black). No depth detection, no NO_COLOR in the files read.
4. Statusline: foreground only. Pet sprite art uses half-block `▀` with fg and bg truecolor pairs (`sprites.js` `renderSprite` l.659-680).
5. Plain `SEP = DIM + ' | ' + RESET` (l.113-114ish), fixed dim.
6. Neighbours told apart by the dim `|` and by position; only bars carry colour.
7. Not present; muted mid-saturation palette is chosen by hand ("subtle, tasteful", l.27).
8. Bar glyphs `▰▱`, `━─`, `◆◇` per bar type (l.94-101); emoji sparingly; sprite blocks.
9. A pixel-art "Tokmon" pet drawn with half-blocks beside the status text, evolution/XP bar, mood-based layouts (chill/panic) in `layout-preview.js`, `personality.js`.
10. `~/.tokburn/config.json` holds only port/pricing/target (`config.js`); `init` CLI with an Ink UI (`init-ui.mjs`). No colour options.

## ccbox
https://github.com/tom-ha/ccbox, stars 7
1. Per slot of a theme struct, with state ladders and per-model identity. `src/theme/mod.rs` `Theme` fields: border, pwd, branch, commit, session, skills, time, tok, cost, ctx, model, dirty, icon_path, label ... (about 25 decorative slots), a three-step ladder `safe/warn/alert` plus `yellow`, and `models: [ModelColors;4]` (Opus, Sonnet, Haiku, Other; `model_key` in `render/palette.rs` l.34-45). `claude-dark` examples (`builtin.rs`): pwd `38;5;75`, branch `38;5;114`, cost `38;5;210`, ctx `38;5;216`, model `38;5;183`. Fill colour by pct: <70 safe, 70-89 warn, >=90 alert (`render/sections/colour_pickers.rs` l.5-14). Context risk by absolute tokens (<=50k safe, <=80k yellow, <=150k ...).
2. Themes: 4 built in (`theme/mod.rs` ALL_THEMES): claude-dark (default), claude-light, catppuccin-latte, catppuccin-mocha. Format: Rust const struct of pre-built escape strings plus RGB tuples for gradients; no user-defined themes. Resolution `cli --theme > env CLAUDE_STATUSLINE_THEME > $CLAUDE_DIR/statusline-theme file > default` (`theme/resolve.rs`).
3. Mixed 256-index and truecolor within one theme: dark uses `38;5;N`, light uses `38;2;r;g;b` for several slots. Gradients are RGB. No depth detection; NO_COLOR: not found in the files read (`src/env.rs` could not be fetched).
4. Both. Foreground text on a box drawn with border characters; the model "pill" and context bar use truecolor backgrounds (`render/sections/model.rs`: `model_bg_lead` and `model_bg_trail` emit `48;2;...`).
5. Rounded box-drawing border (`render/border.rs`, `glyphs.rs` PILL_TL/TR/BL/BR) around a multi-line box rather than inline separators. Border colour theme slot `border`/`border_off`.
6. By hue per slot and the box layout. Model pill: anchor colour per model (Opus yellow `(255,255,0)`, Sonnet green `(135,215,135)`, Haiku blue `(95,175,255)`, other lilac) with a warm or cool shifted second colour (`--bg-shift warm|cool`) forming a gradient stripe whose brightness scales with the effort level (`LevelPct` low 30 ... max 140, `palette.rs` l.54-76; `scale()` in `model.rs`).
7. Light/dark: separate `claude-light` and `catppuccin-latte` themes picked by the user. Pill text flips by per-cell luminance: `pill_fg_dark (15,15,15)` / `pill_fg_light (235,235,235)` with `BG_LUM_THRESHOLD = 110` (`palette.rs` l.9-11, `theme/mod.rs` l.64-66). This is the one adaptive-contrast mechanism.
8. Requires a Nerd Font (README l.25); `glyphs.rs` constants; no ASCII fallback mentioned.
9. Gradient engine (`render/gradient.rs`): theme `grad_stops` 5-stop green->yellow->orange->red->purple, sparkline stops, 12 `spec_gradients`; rainbow palette of 30 xterm indices for the title (`RAINBOW_PALETTE`, `palette.rs` l.4-7); `--snapshot` JSON diagnostics.
10. Env vars only, no config file (README l.121): `CLAUDE_STATUSLINE_THEME`, `CCBOX_DENSITY`, width flags `--width/--full-width`, `--theme`, `--bg-shift`.

## AISC
https://github.com/Wifabric/AISC, stars 7
not a Claude statusline: a Docker-based workstation/Workbench (Windows desktop app plus `aisc` CLI) that runs Claude Code, Codex and cc-switch in containers. Its `container/_bundle/` only vendors third-party plugins unchanged: claude-hud (`src/render/colors.ts`, same code as the claude-hud defaults: model CYAN, project YELLOW, git MAGENTA, context GREEN/YELLOW/RED at 70/85, quota BRIGHT_BLUE/BRIGHT_MAGENTA/RED at 75/90) and caveman (`caveman-statusline.sh`, one badge `[CAVEMAN]` in `38;5;172`). The "themes" it lists are the Anthropic document-skills theme-factory presets, not statusline themes.

## c-c-statusline
https://github.com/babarot/c-c-statusline, stars 6
1. By semantic role, with a state ladder. `src/colors.ts`: `paint(text, role)` over 8 roles. Mapping read from items: model -> `primary` (`items/model.ts` l.10); dir -> `secondary`; git branch -> `success` (or `danger` when detached; `git-status.ts` l.37); unstaged and untracked flags `danger`, staged and ahead `success`, behind `danger`, stash `primary`, in-progress operation `accent`; effort high `accent` else dim half/quarter circles (`items/effort.ts`); usage labels and reset times `muted`. Context and usage percentages: `colorForPct` >=90 danger, >=70 caution, >=50 warning, else success (`colors.ts` l.13-18).
2. Themes: 13 (`src/themes.ts`): default, tokyo-night, tokyo-night-storm, tokyo-night-light, catppuccin-mocha, dracula, solarized-dark, gruvbox-dark, nord, one-dark, github-dark, kanagawa, rose-pine. Format: exactly 8 semantic roles per theme (`primary, secondary, success, warning, caution, danger, muted, accent`), hex ints; the header says role names "describe purpose, not colour" so a theme may give `success` any hue (tokyo-night sets `success` to muted grey-blue `0x787c99`). User-defined themes: not present (const record; unknown name falls back to default).
3. Truecolor only: `rgb24` from `@std/fmt/colors` (`colors.ts` l.1,11). No depth detection, no downsampling, no NO_COLOR found in the files read. Plain `dim` for secondary structure.
4. Foreground only.
5. Plain dim `│` between items: `` ` ${dim("│")} ` `` (`src/render.ts`), fixed.
6. Separators plus role hue per item; nothing alternates.
7. Light terminals: only through picking `tokyo-night-light` (a hand-darkened set, e.g. primary `0x34548a`). No automatic detection or contrast calc.
8. Unicode only (`●◔◑`, `⟳`, bar glyphs). Git symbols are user-overridable (README "Git symbols").
9. Multi-line layout from `DEFAULT_LINES`; bar styles via `--bar-style block`; OSC8 git links (gitLink config).
10. CLI flags (`--theme`, `--bar-style`, `--path-style`) and a config file (`src/config.ts`, format not checked) with per-item options plus global `theme` (README l.81, 180-184), install script.

## claude-statusline (callmemorgan)
https://github.com/callmemorgan/claude-statusline, stars 6
1. By theme role per segment. `internal/palette/colors.go` Palette struct: Model, Dir, Git, Chg (changes), Dur, Cost, Dim, ROK/RWarn/RCrit (bar ok/warn/crit), Agent, Vim, Purple (the "accent" role), Session, Sep. Classic theme assigns them (`themes.go` l.40-58): model magenta, dir cyan, git green, changes yellow, duration blue, cost yellow, dim `90`, ok green, warn yellow, crit `91`, agent `95`, vim `97`, accent magenta, session `96`, sep uncoloured. Bars colour by `warn_at`/`crit_at` thresholds into ok/warn/crit. Per-segment override in `[colors]` table accepts names, hex, 0-255 index, or a theme role name (`model = "accent"`).
2. Themes: 10 (`themes.go` IDs): classic (default, byte-identical to the pre-1.0 look), catppuccin-mocha, nord, dracula, gruvbox-dark, tokyo-night, newsprint, paper, solarized-light, monochrome. Paper, Solarized Light and Monochrome are tuned for light backgrounds (README l.9). Format: 15 semantic roles (`ThemeRoles`: model, dir, git, changes, duration, cost, dim, ok, warn, crit, agent, vim, accent, session, sep), each `{Hex, Ansi16}`. Users can override any role in `[theme_colors]` (`ApplyThemeOverrides`). New whole themes: not present.
3. Truecolor hex themes with automatic downsampling to xterm-256 or 16-colour nearest match (`palette/depth.go`). `detectDepth`: `NO_COLOR` or `TERM=dumb` -> none; `COLORTERM=truecolor|24bit` -> true; known `TERM_PROGRAM` (iTerm, ghostty, WezTerm, vscode) or `WT_SESSION` -> true; `TERM` containing `256color` -> 256; else 16. Config `color_depth` overrides ("auto|truecolor|256|16|none"); NO_COLOR beats an explicit truecolor. Comment: Claude Code may strip COLORTERM from the subprocess env.
4. Foreground only on the line (themes define no backgrounds); the configurator TUI uses fills.
5. Plain text; six styles in `internal/render/render.go` l.53-60: `bar` ` │ `, `dot` ` · `, `slash` ` / `, `chevron` ` ❯ `, `powerline` (Nerd Font glyph, shown blank in the fetched text), `space`, plus `custom`. Separator is coloured with the theme's `sep` role (`render.go` l.84-85); classic leaves it uncoloured.
6. Separator plus the per-segment role hue. Nothing alternates.
7. Light terminals handled by choosing a light theme (newsprint/paper/solarized-light). No auto detection of terminal background, no computed contrast.
8. Emoji and Unicode; `iconset` per bar (`default blocks dots ascii minimal smooth braille braille-fine shade line slim vertical`); `thinking`/`fast-mode` icon `emoji` or `text`; powerline separator needs Nerd Font.
9. Full-screen configurator TUI (`internal/tui/tui_colorpicker.go`): colour picker with theme roles, ANSI names, recents, live hover preview; `v` renders against the real terminal; screenshots per theme in `assets/`; wrap `reflow`; also runs under Pi and Antigravity.
10. TOML `~/.config/claude-statusline/config.toml` (`theme`, `[style]`, `[colors]`, `[theme_colors]`, `[settings.<segment>]`), TUI configurator, `color_depth`, `NO_COLOR`.

## claude-code-usage-statusline
https://github.com/dantereve/claude-code-usage-statusline, stars 6
1. Mostly one colour; state only on usage bars and git change counts. `src/lib/formatters.ts` l.4-25 palette: GREEN `0;32`, RED `0;31`, PURPLE `0;35`, YELLOW `0;33`, ORANGE `38;5;208`, GRAY `0;90`, LIGHT_GRAY `0;37`. Branch, dir, model are LIGHT_GRAY (`src/index.ts` l.28-34); separator GRAY; dirty indicator PURPLE (l.50); `+N` GREEN and `-N` RED, staged `~N` GRAY, unstaged `~N` YELLOW (l.60-70). Limit bars: `limits.color` mode "progressive" = <50 gray `38;5;240`, <70 yellow `38;5;220`, <90 orange `38;5;208`, else red `38;5;196` (`formatters.ts` l.172-183); fixed modes green/yellow/red/blue.
2. Themes: not present.
3. ANSI 16 plus 256-index. No depth detection, no NO_COLOR.
4. Both: limit bars draw a background `BG_BAR = 48;5;236` (blue mode `48;5;60`) behind the fill so partial blocks look like a track (l.23-24, 195-211). Everything else foreground.
5. Plain text, configurable `separator` (default `•`), coloured GRAY (`src/index.ts` l.28).
6. A single grey separator; text segments are all light grey, so only bars and git counts have hue.
7. Not present.
8. Emoji/Unicode symbols and a text-label fallback (`symbols.*` vs `Context:`/`5h:` labels).
9. Partial-block bars with eighths precision.
10. JSON `statusline.config.json` (example in repo) and `src/config-cli.ts`; keys `oneLine`, `git.*`, `separator`, `limits.color` ("progressive|green|yellow|red"), `limits.progressBarLength`.

## gaccode-statusline
https://github.com/DrayChou/gaccode-statusline, stars 6
1. Fixed per segment, plus threshold. `statusline.py` `get_color_scheme()` l.847-856: model GREEN `32`, directory CYAN `36`, git branch YELLOW `33`, time PURPLE `35`, session duration BLUE `34`, session cost MAGENTA `95`. Today's usage cost is a 10-tier rarity ladder by dollar amount (`get_usage_color`, l.905-926: >=300 red 196 "Exotic", orange 208, purple 128, magenta 201, blue 21, light blue 117, green 34, light green 120, white 255, grey 242). Generic `get_color_code(value, thresholds)` red/yellow/green (`\033[91m/93m/92m`, l.809-816). Platform-supplied colour per period from config (`get_color_by_name`, l.362-374, eight named bright colours).
2. Themes: not present.
3. ANSI 16 and 256-index. No depth detection, no NO_COLOR found.
4. Foreground only.
5. Plain space join: `" ".join(parts)` (l.1441, 1447); labels like `Model:` `Dir:` `Git:` carry the structure.
6. Each segment has its own hue and a text label prefix; no separator glyph.
7. Not present.
8. Emoji used for some items; Chinese comments and labels in places; no Nerd Font.
9. Rarity-tier colouring of daily spend (game-style), a cost multiplier badge coloured per platform (`multiplier_info['color']`, l.1154).
10. JSON config via `config.py`/`config-statusline.py` interactive tool; per-platform colour in config (l.75, 84).

## pixelbeat
https://github.com/Dylanwooo/pixelbeat, stars 6
not a Claude statusline: a terminal music player (Rust, ratatui TUI plus daemon). It ships a snippet (`integrations/claude-code.sh`) that appends `px status --format "♪ {title:.25} {icon} {bar:12} {elapsed}/{duration}"` to a user's own statusline script. Styling in that output (`src/cli/format.rs` l.4-9, 267-320): fixed truecolor Anthropic orange family, `ORANGE_PRIMARY 38;2;227;137;62` (icon, spectrum bars), `ORANGE_BRIGHT 255;170;80` (title), `ORANGE_DIM 140;85;40` (elapsed, inactive), `ORANGE_BG 60;35;15` (duration); spectrum cells alternate primary/dim by level; OSC 8 `pixelbeat://` links for buttons. TUI theme `src/tui/theme.rs` is one "anthropic" struct (primary, bright, dim, bg, surface, text, text_dim, accent, spectrum_colors). No NO_COLOR or depth handling seen.

## claude-usage-panel
https://github.com/fschmutz/claude-usage-panel, stars 6. Primarily a GNOME Shell extension and macOS menu bar app; the `claude-code/statusline.js` part is the statusline.
1. By severity only. `claude-code/statusline.js` l.44-47 `SEV_COLOR`: normal GREEN `\x1b[32m`, warning YELLOW `\x1b[33m`, critical bold red `\x1b[1;31m`. Severity from `usageSeverity` (`lib/pure/accounts.js` l.25-33): >=70 warning, >=90 critical. Context gauge and each usage card gauge plus percent take the severity colour (l.87-88, 168-172); unknown readings DIM; labels (`Context`, card labels) plain. `⚠full` and `wait N` YELLOW, `awake?` bold red.
2. Themes: not present.
3. ANSI 16 only; no depth detection, no NO_COLOR.
4. Foreground only.
5. Two spaces: `parts.join('  ')` (l.174, 388). No glyph separator.
6. Whitespace plus gauge colour; each card carries a label.
7. Not present.
8. Unicode gauge with eighth-block fractions (`FULL`, `FRACTIONS`, `EMPTY`, l.59-70); a few emoji/symbols (`⚠ ↑ ⇢`).
9. Same severity vocabulary as the GNOME panel and macOS app, so colour means the same across surfaces.
10. Layout in `claude-code/layout.js`; account switching and CLI (`claudectl.js`); no colour options found.

## claude-statusline (h2ik)
https://github.com/h2ik/claude-statusline, stars 6
1. By theme role per component, with thresholds. `internal/render/theme.go` Theme: Base, Overlay0 (dim/labels), Text, Green (good), Red (critical), Yellow (warning), Blue (paths/info), Mauve (accent), Peach (costs), Teal (secondary). Default style: repo_info prints dir in Blue, branch in Mauve, clean marker Green or dirty Yellow, worktree tag Teal (`components/repo_info.go` l.55-80); model name Teal (`model_info.go` l.47); context window Green <50, Yellow 50-74, Red >=75 and a warning icon at >=90 (`context_window.go` l.38-50). Powerline style groups components by category: info (repo, model, bedrock) -> Blue bg, cost (cost_*, burn_rate) -> Peach, metrics (context, cache, block projection) -> Teal, activity (code productivity, commits) -> Green, meta (version, session mode) -> Mauve, anything else -> Overlay0 with Text fg (`render/segment.go` l.10-45).
2. Themes: 4, all Catppuccin: mocha (default), macchiato, frappe, latte (`theme.go` l.22-94). Format: ten named hex slots. User-defined themes: not present; `theme` key in `[layout]` config picks one.
3. Truecolor forced via `termenv.TrueColor` and lipgloss (`render.go` l.19-34); no downsampling, no depth detection, no NO_COLOR.
4. Default style: foreground only. Powerline style: background-filled segments, `Padding(0,1)`, fg = theme Base on the category background (`powerline_style.go` l.58-65).
5. Default: configurable string separator. Powerline: `` right and `` left arrows, arrow fg = left segment bg and arrow bg = next segment bg (l.77-81, 107-111), trailing arrow fg only; adjacent same-category components merge into one segment, joined internally by ` │ `. Right-aligned groups supported with space padding to terminal width.
6. Powerline: different category -> different background hue (blue/peach/teal/green/mauve); same category merges. Default style: separator plus role hue.
7. Light terminals: Latte theme; because fg is always `theme.Base` (light in Latte) the README says Latte "automatically inverts powerline segment contrast". Not a computed contrast.
8. Two icon sets: `emoji` (default) and `nerd-font` single-cell glyphs (`internal/icons/`), model icon chosen by family name.
9. Fish-style path compression; Catppuccin themes design doc in `docs/plans/`; `assets/themes.png` gallery.
10. TOML config `[layout]` with `style` (default|powerline), `theme`, `icon_style`, per-component sections; no colour overrides beyond choosing a theme.

## coding-usage-bar
https://github.com/hanzhangzzz/coding-usage-bar, stars 6
not a Claude statusline: a macOS menu-bar monitor (SwiftBar plugin plus launchd daemon) for Claude Code, Codex, GLM, DeepSeek, MiniMax and Kimi usage. It can wrap or create a minimal Claude Code status line and feed it with `ingest claude-statusline`, but its own rendering (`src/menubar-render.ts`, `src/glyphs.ts`) is the menu bar title and dropdown, with a few hex colours and gradients for that surface only.

## claude-code-statusline (kalmarr)
https://github.com/kalmarr/claude-code-statusline, stars 6
1. By category and by state. `statusline.sh`: model name coloured by tier (l.79-91): fable/mythos bold yellow `1;33`, opus bold magenta `1;35`, sonnet blue `34`, haiku green `32`, unknown uncoloured. Effort (l.101-105): max bold red, xhigh bold magenta, medium/low dim `90`. Context bar by percent (l.137-143): <50 green, <75 yellow, else red. Rate-limit %: >=95 blinking bold red (`5;1;31`), >=80 red, >=60 yellow (l.235-237). Cache-hit ratio: >=80 green, >=50 yellow, else red (l.260-262). Permission mode: plan yellow, auto blue, acceptEdits cyan, bypass red (l.190-193). PR state: approved green, changes-requested red, draft dim (l.311-313). `+N` green, `-N` red (l.204). Reset countdown and version dim `90`.
2. Themes: not present. README "Colors" documents the above tiers only.
3. ANSI 16 (`\033[3Xm`, `9Xm`) with bold, dim and blink; no 256/truecolor; no depth detection; NO_COLOR not found. README says it needs 256-colour support but the code uses only 16 codes.
4. Foreground only.
5. Plain ` │ ` between segments in `printf "%b"` output (l.325-375); emoji prefix per segment (`🤖 🌿 📁 💰`).
6. Separator plus an emoji marker per segment and category hues; the model is the one place hue encodes identity (price tier).
7. Not present.
8. Emoji-heavy (`🤖 🧠 ⚡ 📋 🚀 ✅ ⚠️ 🔀 ♻️`); no Nerd Font; no ASCII mode.
9. Blinking critical rate limit (SGR 5); one-line, two-line (`STATUSLINE_LAYOUT=2`) and `minimal` profile layouts.
10. Env vars `STATUSLINE_PROFILE`, `STATUSLINE_LAYOUT`; no colour configuration; shell script is edited directly (examples/minimal.sh).

## commander (CC Commander)
https://github.com/KevinZai/commander, stars 6
1. Statusline (`lib/statusline.sh`): heat-map by state plus fixed structure. Palette l.19-29: `H1` `38;5;51` cyan (0-30%), `H2` 39 (30-50), `H3` 198 magenta (50-70), `H4` 208 orange (70-85), `H5` 196 red (85+); W 255 white, D 240 dim, M 145 mid-grey, GR 238. Context % colour `heat_color` (l.186-194, H5 bold at >=85); context bar `mini_bar` green `38;5;77` <50, H4 <80, H5 else (l.169-180); cost colour W <2, H4 >=2, H5 >=5 (l.238-240); model name and arrows use the theme colour `TC`; project name GR; separators D; the `CC`/`CCC<ver>` label gets an HSL rainbow gradient (`rainbow_gradient`, l.36-61).
2. Themes: only three affect the statusline `TC`: claude (default, cyan), oled (`38;5;15`), matrix (`38;5;46`) (`lib/statusline.sh` l.31-36; `lib/themes.js` has claude/oled/matrix with roles primary, secondary, dim, accent, success, warn, error, plus a `css` block and a `random` palette). The extended pack `commander/themes-extra.js` (ocean, aurora, ...) is RGB for the TUI menu, not the statusline. Selected by `CC_THEME`/`KZ_THEME` or `bible-config.json`. User-defined themes: not present.
3. 256-index only for the line; TUI uses RGB. `lib/themes.js` `isColorDisabled` honours `CC_NO_COLOR=1`, `KZ_NO_COLOR=1`, `NO_COLOR=1` (exact value `1` only); the shell statusline script does not check it (grep found none).
4. Foreground only.
5. Dim `│` (D) between segments, `━━` leader. Fixed.
6. Dim bar separators, emoji marker per segment, heat colour only on numeric fields.
7. Not present.
8. Emoji markers (`🔑 🧠 💰 ⏰ 🎯 📂 🚀`); `▐█░▌` bar; no Nerd Font.
9. Rainbow-gradient brand label; a separate Ink HUD mod (`cowork-plugin/mods/commander-hud/hooks/hud.ts`) and many dashboards/themes for the larger CC Commander product (not read).
10. `CC_THEME`, `KZ_THEME`, `CCC_STATUSLINE_SF=off`; `/ccc-theme` command; JSON config for segment padding in header comment of `statusline.sh`.

## pulse-line
https://github.com/knqiufan/pulse-line, stars 6
1. Fixed per component in the theme, plus threshold colours inside some. `src/types/theme.ts` defines `components.{model,context,contextBar,git,cost,duration,workspace,turns,cacheRatio,rateLimit,weeklyQuota,mcpStatus,thinking,outputStyle,accountUsage,toolTimeline,rules,separator}` each `{fg, bg?, bold?, dim?, icon, showIcon?}`. In the dark theme (`builtin/dark.ts`): model `#7aa2f7` bold, context `#9ece6a`, git `#7dcfff`, cost `#e0af68`, duration `#a9b1d6`, workspace `#bb9af7`, turns `#7dcfff`, cacheRatio `#bb9af7`, rateLimit `#7dcfff`, weeklyQuota `#e0af68`, accountUsage `#f7768e`, thinking `#bb9af7`. Theme also has 9 semantic `colors` (primary, accent, success, warning, error, info, muted, dim, background). Context threshold recolouring uses success/warning/error (not read in detail).
2. Themes: 5 built in (`themes/index.ts`): dark ("Deep Dark", Tokyo Night hexes), light, cyberpunk, forest, ocean. Format: full per-component map plus semantic palette. Custom themes: README documents `/pulse-line:theme` selection; user theme files not verified.
3. Truecolor only: `ansiColor(hex)` emits `38;2;r;g;b` (`utils/ansi.ts`); `ansiColor256` is an alias that also emits truecolor (not a real 256 downsample). No depth detection or NO_COLOR.
4. Foreground only in `renderSegment` (`formatters/segment.ts` ignores `bg`); `bg` exists in the type (contextBar `bg: '#565f89'`) but this renderer does not write it.
5. Theme `separator {left, right, color}`: dark uses `│`; Nerd icon set swaps `separator.left` to `\u{e0b0}` (`themes/index.ts` l.40) but still draws it as a coloured glyph, not an arrow between fills.
6. Per-component hue; light theme darkens the hexes (primary `#0369a1`). Nothing alternates.
7. Choice of `light` theme; no detection or contrast calc.
8. Two icon sets: `text` ASCII-safe tags (`[M] [C] [G] [$] [T]`) and `nerd` (`themes/icon-sets/nerd.ts`), setting `iconSet`.
9. Tool timeline and rules components; `/pulse-line:theme`.
10. JSON config (`theme`, `iconSet`), slash commands `/pulse-line:theme|themes`, CLI `pulse-line theme cyberpunk`.

## claude-usage-statusline (meros)
https://github.com/meros/claude-usage-statusline, stars 6
1. Fixed per segment role plus threshold. `lib/util.sh` l.98-105 truecolor palette (Gruvbox): GREEN `142,192,124`, YELLOW `250,189,47`, RED `251,73,52`, AQUA `131,165,152`, PURPLE `211,134,155`, ORANGE `254,128,25`, FG `235,219,178`, DIM `146,131,116`. Defaults (`lib/config.sh` l.23-31): sparkline PURPLE, burn rate ORANGE (RED when the cap arrives before the reset), reset time DIM, reset icon PURPLE, labels (`5h`/`7d`) DIM, directory AQUA, branch GREEN, warning RED, ETA coloured by margin to reset when empty. Percent/bars: `cu_pct_color` <`CU_PCT_WARN` (50) green, <`CU_PCT_CRIT` (80) yellow, else red (`util.sh` l.109-119).
2. Themes: not present as switchable themes; the single Gruvbox palette is hard-coded.
3. Truecolor SGR strings (`38;2;r;g;b`). `NO_COLOR` or `--no-color` disables all ANSI (`util.sh` l.84-93, README l.269). No downsampling.
4. Foreground only.
5. Plain text separators in `views/statusline.sh`; fixed.
6. Role hue per element (aqua dir, green branch, purple sparkline, orange rate).
7. Not present.
8. Unicode: `↻`, sparklines, `█░` bars.
9. Pace/ETA, sparkline history; screenshots script.
10. Env vars `CU_COLOR_SPARKLINE/RATE/ETA/RESET/RESET_ICON/LABEL/DIR/BRANCH/WARN`, `CU_PCT_WARN`/`CU_PCT_CRIT`, `CU_NO_COLOR`; flags `--no-color`, `--no-fetch` (README l.266-281).

## statusline (ryanclark)
https://github.com/ryanclark/statusline, stars 6
1. By state; most segments uncoloured. `crates/statusline-core/src/format.rs` l.40-75: `Percentage::color()` is a continuous gradient, not steps: <50% interpolates `(80,200,120)` -> `(240,200,80)`, 50-80% -> `(255,140,50)`, 80-100% -> `(255,70,70)`; used by `context_percentage`, usage windows (`ColoredPercentage`). Fixed state colours in `constants.rs`: GREEN/YELLOW/RED/GRAY (git ahead GREEN, behind RED, PR review state approved GREEN / changes_requested RED / draft GRAY / pending YELLOW, `segment/git.rs` l.62-106; cache warm GREEN, cold YELLOW, `segment/context.rs` l.189-193; effort coloured by level; task status states running `(100,200,220)`, waiting `(240,200,80)`). `>200k` bold RED.
2. Themes: not present. The configurator TUI has its own chrome colours (`statusline-configure/src/theme.rs`).
3. Named (red, green, yellow, blue, purple, cyan, orange `(255,140,50)`, white, gray), `#RGB`/`#RRGGBB`, or `rgb(r, g, b)` (`NAMED_COLORS`, `parse_color`; README l.361). Rendered with owo-colors (DynColors). Depth detection: not found in the files read. NO_COLOR: scanner counted 1 hit, location not found; the per-segment `colors: false` option strips colour and OSC links (README l.355).
4. Foreground only.
5. A `divider` segment, default `•`, whose style is dimmed (`segment/render.rs` l.939 test: "divider not `\x1b[2m`..."); position and glyph are user-set.
6. The user places `divider` segments; hue gradient on percentages.
7. Not present.
8. Icons per segment (Unicode), `nerd_font: true` setting swaps in Nerd Font glyphs (README l.406-416); `icon: false` and custom `label`.
9. Interactive TUI configurator with a colour picker (`colorpick.rs`), screenshots crate (`statusline-screenshots`) that renders each variant; OSC 8 links for PR and repo.
10. `~/.statusline/settings.json` (segments array with per-segment `colors`, `icon`, `icon_color`, `label`, `style` bold/dim/italic/underline, `dirty_color`, `warm_color`, `cold_color`, `color_env`), `statusline configure` TUI.

## ccbar
https://github.com/taras-mrtn/ccbar, stars 6
1. By threshold on the bars, otherwise uncoloured. `ccbar.py` `COLORS` l.34-55 (basic ANSI: green, yellow, red, cyan, blue, magenta, white, bright variants; fixed 256: orange 208, teal 45, royal_blue 33, purple 129, gold 220, coral 203, lime 118, sky 117, gray 252). Bar fill colour is `low`/`mid`/`high` from the config by `threshold_mid` (50) and `threshold_high` (80) (l.353-365); unfilled part DIM. Other sections (git, cwd, model, plan) are plain text.
2. Themes: 7 (`THEMES`, l.73-81): default (green/yellow/red), ocean (teal/royal_blue/purple), sunset (gold/orange/coral), mono (gray/gray/coral), neon (lime/gold/coral), frost (sky/gold/orange), ember (gold/orange/coral). Format: just the three bar colours. Layering: DEFAULT < theme < user `colors` (l.135-136). User-defined: yes by setting `colors.low/mid/high` to any name in `COLORS`.
3. ANSI 16 named (follows terminal theme) and fixed 256-index (consistent across terminals), explicit split noted in the comments at l.35 and l.46. No depth detection, no NO_COLOR.
4. Foreground only.
5. Plain `" | ".join(parts)` (l.502). Fixed.
6. The pipe only; sections are not hued.
7. Not present.
8. Twelve bar styles (`BAR_STYLES`, l.58-70): `━─`, `█░`, `▓░`, `●○`, `■□`, `◆◇`, `▰▱`, `┃╌`, braille, ASCII `#-`, `▪▫`, `•◦`.
9. Install wizard TUI with live preview (`--install`, arrow-key navigation); layout presets.
10. JSON `config.json` next to the script (`bar.style`, `bar.width`, `colors.*`, `theme`, `sections`, `layout`).

## cc-statusline (vtmocanu)
https://github.com/vtmocanu/cc-statusline, stars 6
1. Per theme "role" for segment areas, project hue by hash. `statusline.sh`: `THEME_NAMES` l.7. Classic and hue-dark derive a project colour: `COLOR_IDX = PHASH % 12` from a cksum of the session id (or cwd), mapped to a 12-colour RGB palette (blue `105,145,225`, green, pink, amber, teal, purple, sky, olive, coral, steel, khaki, violet; l.1332-1347), so a project always looks the same; users pin a project with `~/.claude/statusline-color-overrides.json` (project root -> index 0-11). Newer themes use `_theme_roles handle topic directory branch status tail right` for segment backgrounds (l.1398-1407) and `_theme_palette` for text roles; alert colours (green `9ece6a`, amber `e0af68`, red `f7768e`, blue `7dcfff` in tokyo-night) are kept across themes. Context/usage bars switch to amber/red at thresholds.
2. Themes: 12 (`THEME_NAMES`): classic, hue-dark, nord, phosphor, synthwave, tokyo-night, tokyo-day, tokyo-auto (default; resolves to tokyo-night or tokyo-day by appearance), gruvbox, dracula, catppuccin, default (alias). Format: shell blocks setting palette variables, segment role backgrounds, cap glyphs, separator and bar glyphs. User-defined: not present. `STATUSLINE_THEME` env, `~/.config/cc-statusline/theme` file, or `cc-statusline-theme set|preview|list` (interactive picker with fzf, preview renders the real script).
3. Truecolor `38;2`/`48;2` throughout; no 256/16 downsampling. NO_COLOR: not found in `statusline.sh` (scanner reported no env.NO_COLOR).
4. Both: themes pick transparent (`\033[49m`) for nord/phosphor; classic, tokyo, gruvbox, dracula, catppuccin fill segment backgrounds.
5. Per theme: powerline arrows with stepped colours (tokyo-night `THEME_STYLE=arrow`, `SEP2_CH=\xee\x82\xb1`), hard arrows (gruvbox), flame joiners (dracula), capsules (catppuccin), corner glyphs (synthwave), half-blocks `▌▐` caps in the project colour (hue-dark), ASCII `>`/`|` (phosphor). Nerd glyph constants l.1229 (`NF_GIT` U+E0A0).
6. Segments carry different role backgrounds (e.g. tokyo-night handle `7aa2f7`, topic `bb9af7`, dir `3b4261`, rest `292e42`), while the project hue differentiates sessions from each other rather than segments from one another.
7. Real adaptation: `tokyo-auto` reads appearance by `CC_STATUSLINE_APPEARANCE`, macOS `defaults read -g AppleInterfaceStyle`, or GNOME `gsettings color-scheme`, cached 60 s (`_appearance`, l.60-110) and switches between tokyo-night and tokyo-day. Light-day theme uses the official folke palette. Text colour pairs are hand-chosen per theme (`SEG_INK` etc.), no contrast maths.
8. Nerd Font glyphs, ASCII bar chars in phosphor (`#` `.`), braille `⣿⣀` bars in synthwave, `▮▯` in hue-dark.
9. "Weight, not hue, carries urgency" for busy/idle/waiting session states (bold, dim separator tone, reversed chip; l.2149-2153); responsive tiers drop segments by terminal width with the same palette (l.2225, 2337); background usage fetchers for Claude and Codex.
10. Env `STATUSLINE_THEME`, `CC_STATUSLINE_APPEARANCE`, `STATUSLINE_LAYOUT`, `STATUSLINE_TOPIC`; project colour override JSON; `cc-statusline-theme` CLI.

## burn-your-money
https://github.com/winston-wwzhen/burn-your-money, stars 6
1. Fixed per theme plus a threshold alert. `src/statusline.js` l.28-34: four themes map today-tokens, cost and burn-rate to SGR codes: fire `31/31/31`, ocean `34/36/36`, forest `32/33/32`, golden `33/33/1;33`. Model name `[name]` is grey `0;90` normally and bold red `1;31` once daily cost passes `alert_daily` (l.296-301); totals grey. 
2. Themes: 4 (fire default, ocean, forest, golden), each three ANSI SGR codes; config key `theme`. No user-defined themes.
3. ANSI 16 only; no depth detection, no NO_COLOR.
4. Foreground only.
5. Plain `|` between today and totals (l.317), space otherwise.
6. Today's group wears the theme colour, totals are grey.
7. Not present.
8. Emoji `🔥` and Chinese labels.
9. Burn rate and ETA display.
10. JSON `~/.claude/burn-your-money-config.json` (`theme`, `alert_daily`, `alert_weekly`, `show_burn_rate`, `show_eta`, `show_trend`).

## context-bart
https://github.com/alejandrok5/context-bart, stars 5
1. By state only: "Smart Zone / Dumb Zone" context meter. `src/render.js` l.6-16: zones smart -> green, approaching -> yellow, dumb -> red; thresholds default 30 and 40 percent (`zones.smart`, `zones.dumb`). The bar fill, the zone label and the percent take the zone colour; empty cells DIM. Single segment.
2. Themes: not present.
3. ANSI 16 (`\x1b[32m/33m/31m`, dim, reset). `"color": "never"` in config disables; deliberately does not auto-disable on non-TTY (`render.js` l.72-77). The scanner flagged one NO_COLOR hit not in `render.js`; unverified.
4. Foreground only.
5. Not applicable: one segment plus optional tokens/cost/branch fields separated by spaces; `↑version` update hint dim.
6. Not applicable.
7. Not present.
8. `[▰▰▰▰▰▱▱▱▱▱]` Unicode bar; ASCII `[#####-----]` fallback chosen automatically when the locale (`LC_ALL`/`LC_CTYPE`/`LANG`) is not UTF-8, or `"ascii": true` (`render.js` l.82-87). Update arrow degrades to `^`.
9. Threshold values are opinionated product claims (30/40%) with docs; works across Claude Code, Codex, OpenCode.
10. JSON config with `zones`, `color`, `ascii`; no colour choices.

## burnboard-plugin
https://github.com/behappybill/burnboard-plugin, stars 5
1. By tier of monthly token total. `scripts/statusline.mjs` l.31-36: Spark `\x1b[2m` dim (0-1M), Ember `38;5;208` (1-5M), Flame `38;5;196` (5-20M), Blaze `91` (20-50M), Inferno `35` (50-100M), Supernova bold yellow `1;33` (100M+); the tier name+icon, and the progress bar are all painted in that tier colour, the percent and token counts are plain, and `Session:` is DIM.
2. Themes: not present.
3. ANSI 16 and 256-index; no depth detection, no NO_COLOR.
4. Foreground only.
5. Plain two spaces and a `│` between the tier block and the session block (`render()` l.152-165).
6. Whitespace and `│`.
7. Not present.
8. Emoji per tier (`✦ 🔶 🔥 💥 🌋 ⭐`), `█░` bar.
9. Gamified tiers/levelling on a leaderboard ("burnboard").
10. Setup via `/burnboard:setup` command; no colour configuration.

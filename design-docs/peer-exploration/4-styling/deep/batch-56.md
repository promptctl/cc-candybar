# Batch 56: styling read from source

All 25 projects show 0 stars. File anchors are paths in each repo at HEAD, fetched 2026-10-24. "SGR" means the ANSI escape written to the terminal.

## nonkr/cc-glm-statusbar
https://github.com/nonkr/cc-glm-statusbar (stars: 0). Two-line bash script for z.ai / GLM Coding Plan users.
1. Segment colour: mostly one colour per role, plus thresholds. `cc-glm-statusbar.sh:111` model is bold cyan `[model]`; directory, git, cache text have no colour (terminal default); separators `|` and `r`/`w` labels are DIM. Threshold: context bar and the 5h/weekly usage bars use `<70` green, `70-89` yellow, `>=90` red (`:72-74`, `:50-52` in `make_usage_bar`). The MCP counter is plain text.
2. Themes: not present. No palette, no user-definable colours.
3. Colour spec/depth: ANSI 16 only, as raw `\033[3Xm` strings (`:11-17`). No depth detection, no NO_COLOR (grep finds none).
4. Fill: foreground-only. No backgrounds.
5. Separators: plain text `|` and `·` in DIM (`:111`, `:170`). Not powerline.
6. Neighbours: separated only by the dim `|`; everything else is the same default colour.
7. Light/dark: not present (relies on terminal default + DIM).
8. Glyphs: emoji (`📁 🌿 💾 🤖`) plus `█░` bars; no Nerd Font, no ASCII fallback.
9. Other: bars are `█`/`░` with 10 cells (context) and 5 cells (usage), recoloured by threshold. Non-zero usage always shows at least one filled cell (`:46`).
10. Customisation: none; edit the script. `install.sh` just wires settings.json.

## notsuhas/claude-statusline
https://github.com/notsuhas/claude-statusline (stars: 0). Bash, built to one file by `bin/build.sh`; one theme named `robbyrussell`.
1. Segment colour: fixed per segment, plus thresholds. `src/themes/robbyrussell.sh:19-47`: arrow `➜` bold green, directory cyan, `git:(` bold blue, branch green when clean / red when dirty plus a yellow `✗` (`:25-32`), model magenta (`:35`), session duration `⏱` dim + RGB 220,220,220 (`:47`). Threshold: `format.sh:16-25` `color_for_pct` gives `>=80` red, `>=50` yellow, else green; used for the `ctx: N%` text and the rate-limit bars.
2. Themes: one bundled (`src/themes/robbyrussell.sh`, a zsh oh-my-zsh prompt clone). `main.sh:57` calls `theme_robbyrussell` directly, so there is no theme switch. A theme is a shell function that prints the lines, not a colour map.
3. Colour spec/depth: ANSI 16 (`\033[0;32m`) and one truecolor value (`\033[38;2;220;220;220m`, `format.sh:9`). No detection, no NO_COLOR.
4. Fill: foreground-only.
5. Separators: two spaces between items; no glyph separators.
6. Neighbours: different hues per field (green, cyan, blue, magenta) and spacing.
7. Light/dark: not present.
8. Glyphs: `➜ ✗ ⏱ ↻ ◉ ◎` Unicode; no Nerd Font. No ASCII mode.
9. Other: usage bar is `◉`/`◎` circles coloured by `color_for_pct` and empty cells DIM (`format.sh:27-46`).
10. Customisation: none beyond editing/rebuilding the script (`bin/build.sh`); installed with `npx` (`bin/install.js`, not read for options).

## noxcraftdev/soffit-widgets
https://github.com/noxcraftdev/soffit-widgets (stars: 0). A set of widget scripts for a host called "soffit" (not Claude Code itself). Each script reads JSON on stdin and prints JSON `{output, components}`. Colour comes from a palette the host sends in `config.palette`.
1. Segment colour: semantic palette roles, chosen by the widget. `agent/agent.sh:30-38` the agent name uses `warning`. `git/git.sh:96-101,162-173`: branch `subtle`, staged count `success`, modified `warning`, repo name/dir `primary`, worktree name italic `accent`. `quota/quota.sh:31-38,198-243`: label and reset `muted`, bar `primary` (switching to `warning`/`danger` by threshold), separators `muted`. `context_bar/context_bar.sh:20-100`: the bar is split into three zones, green `success` then `warning` then `danger` along the bar; each zone has a bright and a `dim_*` shade, and the half-point of the zone flips from dim to bright (`:75-86`). Label colour follows the zone the fill has reached (`:90-95`).
2. Themes: not in this repo. The palette keys the widgets read are `success warning danger muted subtle primary accent reset dim_success dim_warning dim_danger dim_primary` (missing `dim_*` fall back to the base role). The themes themselves live in the host (unverified: the host is not in this batch).
3. Colour spec/depth: the widget never writes colour numbers; it concatenates whatever escape strings the host puts in `palette`. Depth and NO_COLOR are the host's problem.
4. Fill: foreground-only text.
5. Separators: `quota.sh:243` joins with ` | ` in `muted`.
6. Neighbours: different palette roles per widget, plus the muted separators.
7. Light/dark: not in widgets; the host's palette decides.
8. Glyphs: icons come from `config.icons` with defaults (`❯ ` for agent; `■ □ ◧` block bar, `● ○ ◐` dot bar, or `# - ~` ASCII chosen by `bar_style`, `context_bar.sh:54-60`). The percentage is drawn in the Unicode segmented-digit block (U+1FBF0..) with a `٪` sign (`:104-110`).
9. Other: the context bar has three bar styles and a gradient built from dim/bright pairs per zone; `compact` mode drops the token text.
10. Customisation: per-widget `config` object from the host (`bar_style`, `components`, `icons`, `compact`, `palette`). README.md does not exist (404).

## Nrect/claude-statusline-config
https://github.com/Nrect/claude-statusline-config (stars: 0). A personal bash script plus a ccstatusline config.
1. Segment colour: fixed per segment plus thresholds. `statusline-command.sh:8-21` defines a 256-colour palette (`cyan 87, purple 141, dim_white 250, amber 214, green 114, red 203, yellow 228, pink 213, teal 43, lavender 183, gold 220, blue 75`). Use: model bold cyan (`:111`), repo cyan and branch bold amber (`:152`), ahead green / behind red (`:161-162`), staged green, modified red, untracked yellow, "clean" green (`:170-175`), duration blue (`:198`), version pink, latest lavender, tokens teal (`:324`), style lavender. Threshold: context bar `>=80` red, `>=50` amber, else green (`:118-122`); cache hit `>=70` green, `>=40` amber, else red (`:268-271`). The ccstatusline half (`ccstatusline-settings.json`) assigns fixed named colours per widget: model cyan, context-bar blue, thinking and style magenta, usage widgets brightBlue, git-branch yellow, git-changes green, cwd brightBlack, memory green, cost yellow.
2. Themes: not present (README calls it a "dark-theme" statusline).
3. Colour spec/depth: 256-colour indexes `\033[38;5;Nm` in the script; ccstatusline file sets `"colorLevel": 2` (256). No detection, no NO_COLOR.
4. Fill: foreground-only; ccstatusline `powerline.enabled` is `false`.
5. Separators: `│` in dim_white (`:23`, `sep=`). ccstatusline lines use its `separator` widgets.
6. Neighbours: a different hue for most fields and the `│` separator.
7. Light/dark: not present; it is described as a dark-theme layout.
8. Glyphs: Unicode (`█░`, `↑↓`), no Nerd Font requirement.
9. Other: 4-line layout, hybrid of the bash script and ccstatusline. RAM/CPU via PowerShell.
10. Customisation: edit the script; ccstatusline's own TUI/JSON for the second half.

## nrzz/claude-code-glow
https://github.com/nrzz/claude-code-glow (stars: 0). Node ESM. One file per theme sets Claude Code's whole UI colours (71 keys) and also a `glow` block that styles the status line.
1. Segment colour: the model chip uses the accent; every other chip gets the next step of a graded panel ramp; value text uses state colours. `src/render.mjs:164-168` `styles()`: `model` gets `g.model` (accent bg + readable fg); the remaining chips take `g.panels[k++]`, each "a little lighter than the last". State: context bar `>=75%` bad, `>=50` warn, else ok (`:79`); limits `>=90` bad, `>=70` warn (`:109`); dirty `*` warn; cache "cold" bad / "cold in" warn (`:126-127`). Cost, time, dir, branch carry no colour of their own beyond the panel.
2. Themes: bundled 14 UI themes plus `classic` (no UI overrides): synthwave-84, dracula, tokyo-night, catppuccin-mocha, catppuccin-latte, nord, gruvbox-dark, solarized-dark, rose-pine, one-dark, monokai, matrix, cyberpunk, github-light (`src/palettes.mjs:20-122`). Format: a compact palette `{bg, fg, muted, subtle, border, accent, accent2, blue green yellow red purple cyan orange pink}` expanded by `src/theme-gen.mjs` into the 71-key Claude Code theme plus a `glow` block (`bg fg dim accent accent2 model{bg,fg} panels[7] panelFg ok warn bad tip gradient swatches`). Files: `themes/glow-<slug>.json`. Users can add theme files (`config.mjs` `themeSlugsIn`); `normalizeGlow` (`src/defaults.mjs:38-62`) fills missing fields from a default.
3. Colour spec/depth: hex palette. `src/colors.mjs:11-18` modes `truecolor` / `256` / `none`; `NO_COLOR` or `GLOW_COLOR=0` gives none; Apple Terminal (`TERM_PROGRAM=Apple_Terminal`) auto-drops to 256; `GLOW_COLOR=256|truecolor` forces. `to256()` (`:34-45`) picks the nearest of the 6x6x6 cube or the grey ramp by squared distance.
4. Fill: background chips (powerline and half-block modes); ascii/no-colour mode is foreground-only (`plainLine`, `render.mjs:192-197`).
5. Separators: three layouts keyed on icon mode (`render.mjs:170-203`). Nerd: powerline arrow U+E0B0 with fg=left bg, bg=right bg (`powerlineLine`). Unicode: each chip wrapped in half-blocks `▐ … ▌` and one space apart. Ascii or no colour: ` | ` in `dim`.
6. Neighbours: the panel ramp. `src/theme-gen.mjs:175` panels = `mix(bg, fg, t)` for t in 0.10,0.12,...,0.22, so adjacent chips differ by a 2% lightness step toward the foreground (darker on light themes). The model chip is the one accent-coloured block.
7. Light/dark: yes. Theme generator guards contrast: text >= 4.5:1, accent hues >= 3:1, dim text >= 3:1 (`theme-gen.mjs:9-11`), moving a colour only toward white or black when it fails. Model chip fg is picked by `readableOn(accentBg, [bg, fg, #000, #fff], 4.5)` (`:183`). Two light themes (catppuccin-latte, github-light).
8. Glyphs: three icon sets: nerd (Font Awesome codepoints + powerline), unicode (`◆ ⌂ ⎇ ◷ ◔ ↻`), ascii (`render.mjs:17-22`). Context bar `▰▱` (ascii `#-`).
9. Other: each theme also carries a `gradient` array (accent, purple, accent2) and `swatches`, but the status-line renderer does not read `gradient` (grep of `src/*.mjs` outside defaults/theme-gen finds no use). A `hud/` web page and `docs/themes.svg` exist (not read); the scanner's rainbow/animation counts come from there. Live theme switch rewrites `~/.claude/themes/glow.json`, which Claude Code watches and recolours a running session (`themes.mjs:70-78`).
10. Customisation: `config.json` (`theme`, `icons`, `segments`, `tips`, `gitDirty`), CLI `claude-glow` with theme list/apply and typo suggestions (`themes.mjs:49-68`), env `GLOW_COLOR`, `NO_COLOR`.

## nuricanaksu/claude-code-subbar
https://github.com/nuricanaksu/claude-code-subbar (stars: 0). A single-file Node script that shows only 5h/weekly/extra usage.
1. Segment colour: label/bar/percent follow a threshold. `bin/claude-code-subbar.js:590-594` `colorFor(pct)`: `>=80` danger, `>=60` warn, else cyan. Label uses `label`, reset text `muted`, values `text`, the left capsule bold `label` colour.
2. Themes: four named: `claude` (default), `sunset`, `mono`, `high-contrast` (`:28-57`), chosen with `--theme` or `CLAUDE_SUBBAR_THEME`. Format: an object of 7 semantic roles `{text, muted, accent, cyan, warn, danger, label}` as RGB triples. The `claude` theme is null and uses the layout preset's own palette (`presetColors.full/compact/small/badge`, `:59-104`). Not user-definable (only these four).
3. Colour spec/depth: truecolor only, `\x1b[38;2;r;g;bm` (`:169`). No depth detection. `--no-color` / `CLAUDE_SUBBAR_NO_COLOR=1` turns colour off (`:147,160,577-586`); `NO_COLOR` itself is not read.
4. Fill: foreground-only.
5. Separators: a per-preset spacing string: two spaces (full), ` | ` (compact), one space (small), `|` (badge) (`:112-139`).
6. Neighbours: the separator only; segments share the text colour.
7. Light/dark: not present (one `high-contrast` theme only).
8. Glyphs: Unicode bars; `unicode` flag with an ASCII fallback (`makeProgressBar`, `:531`).
9. Other: four layout presets (`full`, `compact`, `small`, `badge`) with different caps like `[ Claude Code Subbar ]`, `◉ SUBBAR`; the badge preset uses a `premium` bar style.
10. Customisation: CLI flags (`--theme`, `--preset`, `--no-color`, unicode) and env vars `CLAUDE_SUBBAR_THEME`, `CLAUDE_SUBBAR_NO_COLOR`, `CLAUDE_SUBBAR_INSTALL_MODE`.

## nxhung1610/claude-odometer
https://github.com/nxhung1610/claude-odometer (stars: 0). A Claude Code mod (plugin API, TSX), not a statusline command: it draws a band above the prompt using the host's `Text` element and the host's theme tokens.
1. Segment colour: host theme tokens, by role and state. `hooks/band.tsx:39-88`: labels, reset time, cost `inactive`; model name and the lit letter of "working" `claude`; unused bar part `subtle` (`TRACK`, `:25`). Threshold: `hooks/format.ts:19-23` `toneOf`: `>=90` `error`, `>=70` `warning`, else `success`; applied to the percentage text. The terminal card (`hooks/terminal-band.tsx:56-59,104,157`) draws the filled bar in `claude`, empty in `subtle`, and the context percentage with the same tone; context groups (system/tools/memory/messages) each get a legend colour (`item.color`, `:166-175`).
2. Themes: none of its own. It uses the host theme names (`claude inactive subtle success warning error`).
3. Colour spec/depth: token names only, no escapes; depth and NO_COLOR belong to the host. A few hex values appear in `docs/*.mjs` image generators, not the runtime.
4. Fill: desktop band uses solid-colour bar cells (host element), terminal uses characters in foreground colour.
5. Separators: ` · ` text in `inactive`.
6. Neighbours: spacing + `inactive` vs `claude` text; no separator colours.
7. Light/dark: delegated to the host's theme tokens.
8. Glyphs: `◆ ↻ █ ─ ░`; alerts as toasts. No Nerd Font.
9. Other: alert toast at 90%; separate desktop-app rendering path (solid colour bars) vs terminal characters.
10. Customisation: mod settings through the host (not read). README describes behaviour only.

## oakoss/linesmith
https://github.com/oakoss/linesmith (stars: 0). Rust, role-based themes, the closest to a semantic palette in this batch.
1. Segment colour: each segment declares a role; the theme maps role to colour. Roles (17): Foreground, Background, Muted, Primary, Accent, Success, Warning, Error, Info plus extended SuccessDim, WarningDim, ErrorDim, PrimaryDim, AccentDim, Surface, Border, Timer (`crates/linesmith-core/src/theme/mod.rs:34-66`). Extended roles fall back to a base role when a theme omits them (`Role::fallback`, `:75-93`; e.g. Timer -> Muted, Surface -> Background). Segment mapping from source: model `Primary` (`segments/model.rs:87`); workspace `Info` (`workspace.rs:50`); context_window `Info` (`context_window.rs:36`); cost `Muted`; effort `Muted`; version `Muted`; vim `Muted`; tokens `Muted`; session_duration `Timer` (`session_duration.rs:28`); git_branch `Accent` for branch/label, `Success` staged count, `Warning` modified, `Error` conflicts (`git_branch.rs:356-499`). Threshold: `context_bar` and the rate-limit segments set Success / Warning / Error by percent (tests at `context_bar.rs:323-392`).
2. Themes: 11 bundled (README): `default` (ANSI-16 anchor), `minimal` (dim/muted only), `catppuccin-latte|frappe|macchiato|mocha`, `dracula`, `nord`, `gruvbox`, `tokyo-night`, `rose-pine` (`theme/mod.rs:5-9`). Format: a fixed-size array of 17 role colours. User themes: TOML files in `~/.config/linesmith/themes/*.toml`, parsed in `theme/user.rs`; a user theme with a built-in's name replaces it (with a warning).
3. Colour spec/depth: `Color` is TrueColor / Palette256 / Palette16 / NoColor (`mod.rs:127-141`); `Color::downgrade(cap)` converts truecolor down to 256 or 16 (`:146-163`). `Capability::detect` honours `NO_COLOR` (`:290`), `supports-color` on stdout, `COLORTERM`/`TERM` probe for forced colour (`from_env_vars`, `:316-335`); config `[layout_options].color = "always"` forces ANSI through the pipe; `--force-color` and `FORCE_COLOR` also handled (`:338`). Style strings accept `role:<name>`, `fg:<hex|named|rgb()>`, `bold italic underline dim` (`style_syntax.rs:1-80`).
4. Fill: foreground-only today. `Style` has a doc note that `bg` "lives in the spec but isn't wired through" (`mod.rs:178-181`); `Background` role is `NoColor` in `default`.
5. Separators: `[layout_options].separator` = `"space"` (default), `"powerline"` (U+E0B0), `""`, or any literal string. A powerline chevron separator is styled `Role::Muted`; plain separators get no style (`layout/mod.rs:590-595`).
6. Neighbours: different roles per segment (Primary, Info, Muted, Accent) and the separator; there is no alternating or stepped shading. A `group_id` lead-colour rule makes satellites of a group take their lead's colour (`apply_group_lead_colors`, `layout/mod.rs:555`).
7. Light/dark: partial. Catppuccin Latte is a light theme; no automatic contrast fixing. `Surface`/`Border` roles exist for backgrounds. `ThemeRegistry` lists built-in vs user themes.
8. Glyphs: Unicode by default, powerline chevron optional (`powerline_width` 1 or 2). A Nerd Font mention appears in README only.
9. Other: OSC 8 hyperlinks via `Style.hyperlink` with `supports-hyperlinks` detection; a ratatui theme picker TUI (`crates/linesmith/src/tui/theme_picker.rs`); plugin segments (rhai) planned and can set their own style.
10. Customisation: `~/.config/linesmith/config.toml` (`theme`, `[line].segments`, `[layout_options]`), user theme TOML, TUI picker, CLI flags, env vars.

## oboistwalpurgisnight703/ccbar
https://github.com/oboistwalpurgisnight703/ccbar (stars: 0). The README is a Windows ".exe download" page pointing at the author's own github.io (not the real usage doc); the real code is the bash script `bin/ccbar` (1173 lines) wrapped by `cli.js`. Treat the README claims as unreliable.
1. Segment colour: fixed per role through three themes, plus thresholds. `bin/ccbar:68-105` `apply_theme` sets variables `C_MODEL C_ARROW C_DIR C_ORG C_BRACKET C_LABEL C_RESETTXT BAR_LOW/MID/HIGH E_LOW..E_MAX E_DEFAULT`. Usage bars: `render_bar` (`:115-136`) uses `BAR_HIGH` at `>=80`, `BAR_MID` at `>=50`, else `BAR_LOW`. The effort word takes `E_LOW/E_MED/E_HIGH/E_XHIGH/E_MAX` by level (`:292-296`): in `vivid` bold green, cyan, yellow, magenta, red.
2. Themes: three: `default`, `mono`, `vivid` (`:70-105`, setup menu `:972-979`). Format: shell variables of raw SGR strings. `mono`: only dim/white shades and bold (no hues). `vivid`: bold 16-colour hues (dir cyan, org red, bars bold green/yellow/red). `default`: non-bold, dim variants (`\033[2;33m` for mid bar). Not user-extensible except by editing the script.
3. Colour spec/depth: ANSI 16 + bold/dim attributes only. No detection; no NO_COLOR (grep finds none in `bin/ccbar`).
4. Fill: foreground-only.
5. Separators: text arrows/brackets in `C_ARROW`/`C_BRACKET` (dim grey); no powerline.
6. Neighbours: label dim vs value; dir/org/model in separate hues in `vivid`.
7. Light/dark: not present (`mono` avoids hue).
8. Glyphs: bar glyphs configurable (`CCBAR_BAR_FILLED`, `CCBAR_BAR_EMPTY`, width); gallery presets `█░`, `▓░`, `■□`, `=-` ASCII (`:784-790`).
9. Other: `ccbar gallery` previews six named looks ("Default blocks", "Mono blocks", "Vivid blocks", "Default shaded", "Vivid squares", "Mono ascii") and applies one; `ccbar config` is an interactive wizard.
10. Customisation: `KEY="value"` config file sourced by the script (`CCBAR_THEME`, `CCBAR_BAR_WIDTH`, `CCBAR_BAR_FILLED`, `CCBAR_BAR_EMPTY`, `CCBAR_SHOW_*`), wizard, gallery.

## OctopiAI/claude-code-statusline
https://github.com/OctopiAI/claude-code-statusline (stars: 0). Now a Claude Code mod (plugin `usage-statusline`, `hooks/register.tsx`); the original Python scripts in `python/` are deprecated.
1. Segment colour: fixed per segment, with a threshold override. `hooks/register.tsx:185-236`: model bold `yellow`; context bar `green` (switching to `red` at `ALERT_PERCENT`, `limitColor`, `:181`) with `gray` percent; 5h/week windows each have a colour from a `windows` table (passed to `limitColor`, which forces `red` at the alert level); model-scoped weekly limit `magenta`; folder bold `cyan`; branch `green`; cache countdown `cacheTone(...)`; cost `≈$` in `warning`. Original Python (`python/mac/statusline.py:13-17`): model bold yellow, brackets/separators/5h yellow, filled bar and 7d green, folder+branch bold cyan, model-scoped limit magenta, separator ` | ` DIM.
2. Themes: not present. Colour names are the host's (`yellow green red gray cyan magenta warning`).
3. Colour spec/depth: Python: ANSI 16 `\033[Nm`. Mod: named colours handed to the host's `Text`. No NO_COLOR handling in either.
4. Fill: foreground-only.
5. Separators: Python ` | ` DIM (`:19`). Mod: segments wrap between rows when narrow.
6. Neighbours: different hue per field.
7. Light/dark: not present.
8. Glyphs: Python bar `▓`/`░` 20 cells in `[ ]`; mod `●` cache dot. No Nerd Font.
9. Other: stale usage drawn dim (`:215`).
10. Customisation: mod install via `/plugin install`; no colour config found.

## offbeatport/savemytokens
https://github.com/offbeatport/savemytokens (stars: 0). A token-budget tool whose statusline is its "HUD". Colours come from a named theme.
1. Segment colour: semantic roles by segment and state. `src/runtime/kernel.mjs`: HUD segments paint with roles `accent` (tag), `dim` (labels like "target", "resets in", "stale"), `fg`, `ok`/`warn`/`danger` (`~1409-1470`). `pressureRole(p)`: `>=0.9` danger, `>=0.8` warn, else ok (`~1294-1298`); used for the used-% number, the 5h meter and each sparkline step. `pace` segment: `ok` "on pace", `warn` when more than 5 points ahead; `empty` segment `danger` "runs dry ...", `ok` "lasts the window".
2. Themes: 18 built in (`kernel.mjs:1075-1195`): default, tokyonight, minimal, nord, violet, matrix, solarized, gruvbox, rose, paper, neon, onedark, monokai, everforest, kanagawa, terracotta, orange, ember. Aliases map `catppuccin`, `dracula`, `tokyo-night`, `rose-pine`, `one-dark` to those names (`THEME_RENAMES`). Format: `{name, colors{fg, dim, accent, ok, warn, danger, track, fill, head?}, glyphs{full, empty, sep, arrow, tag}, border{...}, tui{...}}`. Users add `<THEME_DIR>/<name>.json`, merged key by key over the built-in (`loadTheme`, `:1222-1236`). CLI: `savemytokens theme new <name>`, `theme check <name>`, `theme tui <name>`.
3. Colour spec/depth: hex in themes. `truecolor()` (`:1247-1252`) checks `COLORTERM` for truecolor/24bit, else `TERM` containing direct/truecolor/kitty; otherwise `xterm256()` maps RGB to the 256 cube or grey ramp (`:1254-1264`). `NO_COLOR` (set at all) disables colour in `paint`/`paintHead` (`:1273-1281`).
4. Fill: foreground-only.
5. Separators: `theme.glyphs.sep` (default `·`) with spaces; bare segments (bar, meter, sparkline) join with a single space (`renderSegments`, `~1478-1490`).
6. Neighbours: the sep glyph, `dim` labels vs coloured values.
7. Light/dark: yes, explicit. `theme check` (`src/commands/theme.ts:50-97`) computes WCAG contrast of every role against a dark or `--light` terminal background: text roles (fg, accent, ok, warn, danger) need >= 4.5:1, `dim` >= 2.5:1, others >= 1.15:1, and `track` at most 4:1. A `paper` theme exists for light terminals.
8. Glyphs: theme-defined `full`/`empty` (default `█░`), `arrow`, `tag` ("SMT"); sparkline `▁..█`; borders rounded `╭╮╰╯` in some themes. No Nerd Font.
9. Other: HUD layouts `default minimal window pacing everything off` (`HUD_PRESETS`); per-segment list is user-editable; sparkline of 5h history coloured per point by `pressureRole`.
10. Customisation: JSON config (`config.theme.hud`, `config.hud.segments`), user theme JSON, `theme` subcommands, `hud` command, `NO_COLOR`, `COLORTERM`.

## ohnoshivm/tokenmaxxing
https://github.com/ohnoshivm/tokenmaxxing (stars: 0). A prompt-cache tool; its statusline is a single coloured line.
1. Segment colour: one colour for the whole line, chosen by state. `scripts/statusline.py:243-251`: red when context ratio `>=0.85` or the cache has expired, yellow when `>=0.60` or the cache has `<=60` s left, else green. Text and glyphs are not individually coloured.
2. Themes: not present.
3. Colour spec/depth: ANSI 16 (`\033[31m/33m/32m`). `--no-color` flag or `NO_COLOR` set (any value) disables colour (`:243`).
4. Fill: foreground-only.
5. Separators: ` · ` plain text, same colour as everything else.
6. Neighbours: not distinguished by colour (one colour per line).
7. Light/dark: not present.
8. Glyphs: ASCII text, bar via a `_progress_bar` helper (not inspected); no emoji.
9. Other: embeds advice text "consider /compact" / "/compact now" as colour-coded state.
10. Customisation: argparse flags (`--no-color`, `--window`, `--ttl`).

## oklahaha/deepseek-balance
https://github.com/oklahaha/deepseek-balance (stars: 0). A Claude Code mod for DeepSeek users: a single line above the prompt.
1. Segment colour: fixed brand colours plus a state-coloured "weather" for context. `hooks/register.tsx:26-28`: name `◆ DeepSeek` `BRAND #869cff`, balance gauge `GAUGE #fbd800`; gauge turns `error` (red) under 10% (`gaugeColor`, `:33`). `hooks/context.ts:13-17` the context "sky" by percent: `<25` `☀` `#e0b000`, `<50` `☁` `#1ba1c4`, `<75` `☂` `#2f68c0`, `<90` `☇` `#b04fc0`, else `↯` `error`. `warning`/`error` host tokens for messages (`:280,290,450`).
2. Themes: none; hex plus host token names.
3. Colour spec/depth: `#rrggbb` strings and host tokens passed to `Text`; no depth or NO_COLOR logic of its own.
4. Fill: both. The gauge is drawn as spaces with `backgroundColor` (`:294`, `:334`, `:370`), the empty remainder as dim `▁`.
5. Separators: `│` text.
6. Neighbours: separator plus the distinct hues of the context, balance and spend parts.
7. Light/dark: not present (hex values chosen once).
8. Glyphs: weather glyphs `☀ ☁ ☂ ☇ ↯`, bar of block/space cells; no Nerd Font.
9. Other: sparkline-like per-prompt bars coloured by the weather colour.
10. Customisation: mod settings (balance gauge full amount, key limit, refresh); README table only.

## open-bbug/go-ccstatusline
https://github.com/open-bbug/go-ccstatusline (stars: 0). Go port of ccstatusline (Bubble Tea TUI + lipgloss).
1. Segment colour: three layers. `cmd/go-ccstatusline/renderer.go:313-331` `resolveSlot`: explicit widget `backgroundColor`/`color` wins, then the powerline theme's slot, else the widget's default. Theme slots cycle by position across widgets, and the cycle index continues across lines (`RenderLines`, `:35-43`). Widget defaults are ANSI indexes (`widgets.go`): model 6 (cyan), version 8, account email 4, vim mode 2, thinking effort 5, git branch 5, git staged 2, unstaged 3, untracked 8, insertions 2, deletions 1, conflicts 1, root dir 4, tokens total 6, input 4, output 15, cached 14.
2. Themes: 13 built in (`themes.go:15-163`): dracula, gruvbox-dark, gruvbox-light, nord, solarized-dark, solarized-light, monokai, tokyo-night, one-dark, catppuccin-mocha, rose-pine, ansi-basic, grayscale. Format: ordered `[]ThemeSlot{Bg, Fg}` of six slots; a theme applies only in Powerline mode. User themes: not present (map is compiled in); `theme clear` turns it off.
3. Colour spec/depth: named 16 colours, an ANSI 256 index string, or `#RRGGBB` (README "Color Reference"). Downsampling is delegated to lipgloss/termenv. NO_COLOR: not seen in the files read.
4. Fill: background chips in Powerline mode; foreground-only otherwise.
5. Separators: powerline arrow (default U+E0B0 from `Separators[0]`), optional start/end caps (`StartCap`/`EndCap`, e.g. round caps); the arrow is fg=this bg, bg=next bg, and the last arrow has no bg (`renderer.go:294-309`). Non-powerline mode uses `defaultSeparator` in grey `8` (`:168`).
6. Neighbours: the cyclic slot list: six colours rotate, so adjacent chips differ by hue (not by lightness step). Each slot's text colour is hand-set per background (dark text on light slots, e.g. Dracula all `#282a36`).
7. Light/dark: partial. Light themes exist (gruvbox-light, solarized-light); fg per slot is hand-picked; no contrast computation.
8. Glyphs: powerline glyphs; emoji in widget labels; ASCII not specified.
9. Other: TUI to toggle powerline, pick theme and caps; `theme set/list/clear` CLI; merge flags to share a colour block between widgets.
10. Customisation: JSON settings (`lines[][]` of widgets with `color`, `backgroundColor`, `bold`, `padding`, `separator`, `merge`; `powerline{enabled, separators, theme, startCap, endCap}`), TUI, CLI.

## Open01277/claude-mods
https://github.com/Open01277/claude-mods (stars: 0). A set of Claude Code mods (README is Traditional Chinese). The one that draws a band is `quota-pets`; `convo-board` and `convo-diff` are a sidebar and a diff panel.
1. Segment colour: `quota-pets/hooks/register.tsx` colours by state with host tokens: `barColor(pct)` `>=85` `error`, `>=60` `warning`, else `success` (`:802`); belly gauge stage >=3 `error`, >=2 `warning`, else `success` (`:1150`); pet rarity colour `N gray, R blue, SR magenta, SSR warning, UR red` (`RARITY_COLOR`, `:703-709`); the weekly "lane" uses `warning` and `error` glyph colours (`:837-844`); a coupon note takes `couponColor` (README: purple normally, yellow in the last three days, red when the week is used up).
2. Themes: not present.
3. Colour spec/depth: token names to the host; no escapes.
4. Fill: foreground-only text.
5. Separators: `·` text.
6. Neighbours: not styled.
7. Light/dark: delegated to host tokens.
8. Glyphs: emoticon-face pets (kaomoji), `ᗧ ᗣ •` Pac-Man style lane, gauge blocks.
9. Other: animated pet faces (mostly state text), toasts. This is not a conventional statusline.
10. Customisation: per-mod commands (`/petdex ...`); no colour settings.

## oray749616/ccometixline
https://github.com/oray749616/CCometixLine (stars: 0). FORK OF Haleclipse/CCometixLine; only differences reported.
1. Segment colour: the fork adds one segment, `IkunCode` (shows daily spend and balance from the ikuncode API, `src/core/segments/ikuncode.rs`), and a per-theme constructor `ikuncode_segment()` in each theme file (`src/ui/themes/theme_*.rs`, +22 lines each), wired into `presets.rs`. Its colour is fixed per theme, not by state. `theme_default.rs:166-186`: icon and text ANSI-16 index 10 (bright green), no background. `theme_nord.rs` (and the powerline themes): RGB (163,190,140) (Nord green) with a background of the same family; powerline themes use the same green on bg. All other segments are the parent's.
2. Themes: same nine built in (cometix, default, minimal, gruvbox, nord, powerline-dark, -light, -rose-pine, -tokyo-night); format is per-segment `ColorConfig{icon,text,background}` using `AnsiColor::{Color16, Color256, Rgb}`. No new theme.
3. Colour spec/depth: unchanged from the parent (16 / 256 / RGB).
4. Fill: unchanged (themes decide per segment; default has `background: None`).
5. Separators: unchanged.
6. Neighbours: unchanged.
7. Light/dark: unchanged.
8. Glyphs: IkunCode uses emoji `🏀` plain and Nerd glyph U+F0175 (`theme_default.rs:170-173`).
9. Other: the fork has diverged from the parent (2 commits ahead, 114 behind per the GitHub compare API), so the fork's themes predate the parent's current layout (the parent's `src/ui/themes/` no longer exists at HEAD, so no further comparison was possible).
10. Customisation: unchanged apart from the `ikuncode` segment's `timeout` option (default 2).

## Organized-AI/organized-statusline
https://github.com/Organized-AI/organized-statusline (stars: 0). FORK OF chongdashu/cc-statusline; only differences reported.
1. Segment colour: `src/features/colors.ts` is byte-identical to the parent. The difference is the committed generated script `.claude/statusline.sh`, which uses a 256-colour pastel set instead of the generator's `basic` colours: directory 117 (sky blue), model 147 (light purple), version 180 (soft yellow), Claude Code version 249, style 245, git 150 (soft green), usage 189 (lavender), cost 222, burn rate 220. Context colour by remaining percentage: `<=20` coral red 203, `<=40` peach 215, else mint 158 (`:196-200`). Session time remaining: `<=10` pink 210, `<=25` light yellow 228, else light green 194 (`:214-216`).
2. Themes: the same three generator themes (`minimal`, `detailed`, `compact` in `getThemeColors`), unchanged.
3. Colour spec/depth: the pastel set is 256-colour `\033[38;5;Nm`. `NO_COLOR` is honoured in the generator (`use_color=0`).
4. Fill: unchanged (foreground-only).
5. Separators: unchanged.
6. Neighbours: unchanged.
7. Light/dark: unchanged.
8. Glyphs: unchanged.
9. Other: the fork is behind the parent (VERSION 1.3.2 vs 1.4.0; the parent adds native `context_window` and jq checks); styling code is the same.
10. Customisation: unchanged apart from prompts (session time defaults on; ccusage forced on).

## Osyna/claude-status-line
https://github.com/Osyna/claude-status-line (stars: 0). Two versions: a compact bash script and a Python "6-row dashboard".
1. Segment colour: fixed per segment plus a threshold. Python (`statusline-command.py:212-289`): model is a "pill" (bold bright cyan on bg 256-colour 23); session name bright magenta on 53; agent bright yellow on 58; worktree bright blue on 17; vim mode green-on-22 for NORMAL, else yellow-on-58; directory bright yellow icon with bold bright white name; git branch bright green; cost icon yellow; time icon cyan; lines added bright green, removed bright red; session-token sigma magenta; down arrows green. Context bar colour: `>=80` bright red, `>=50` bright yellow, else bright green (`:154,205`). The bash version defines the same 16-colour letters (`R B D CY GR YE RE MA BL WH`).
2. Themes: not present.
3. Colour spec/depth: ANSI 16 (including bright 90-97) plus 256-colour backgrounds (`48;5;23|53|58|22|17|236`, `:59-64`). No detection, no NO_COLOR.
4. Fill: both. Pills have a dark tinted background (`pill()`, `:127`); everything else is foreground-only.
5. Separators: `` thin powerline glyph defined (`I["sep"]`, `:93`); layout is padded columns (`pad_right`) with left and right halves rather than separators.
6. Neighbours: each pill has its own hue family (cyan, magenta, yellow, blue, green); the rows are spaced apart.
7. Light/dark: not present; the pill backgrounds are dark (256 indexes 17-58), so it assumes a dark terminal.
8. Glyphs: Nerd Font icon table (`I`, `:67-95`, brain, git, tree, vim, dollar, clock...); the bash version is plain Unicode `▓░` and needs no special font.
9. Other: rotating tips row; right-aligned info computed from terminal width.
10. Customisation: none; edit the files (`install.sh` to wire).

## otzgo/statusline
https://github.com/otzgo/statusline (stars: 0). Not a statusline implementation: it is an agent "skill" (docs plus setup scripts) that installs and configures the third-party `ccstatusline`. The only styling is an example config.
1. Segment colour: fixed per widget in `assets/ccstatusline-powerline-config.json`: model white on blue (bold), context-length black on cyan, git-branch white on magenta (icon `⎇ `), git-changes black on yellow.
2. Themes: not present (just this one example).
3. Colour spec/depth: ccstatusline named colours; `"colorLevel": 2` (256). No detection in this repo.
4. Fill: background-filled (powerline enabled).
5. Separators: powerline (`powerline.enabled: true`, separator is a single private-use glyph, `autoAlign: true`, no caps).
6. Neighbours: a different background hue per widget (blue, cyan, magenta, yellow); fg flips between white and black for contrast.
7. Light/dark: the setup script's advice only: "Choose colors suitable for your terminal theme (dark/light)" (`scripts/setup-unix.sh:100`).
8. Glyphs: powerline glyph; emoji in script output; the README is Chinese text with no font logic.
9. Other: nothing.
10. Customisation: ccstatusline's own JSON (`flexMode`, `compactThreshold`, `powerline.*`).

## overact/claude-code-dotfiles
https://github.com/overact/claude-code-dotfiles (stars: 0). One Python statusline.
1. Segment colour: semantic role names in the code. `statusline/statusline.py:49-66,70-78`: roles `muted path branch ok warn bad accent add del` map to variables used per segment: user@host `ok`, path `path`, branch `branch` with `ok`/`del` marker (`✓`/`✗`, `:286`), model `accent`, effort level colours `low dim, medium ok, high warn, xhigh del, max bad` (`:301`), tok/s `accent`. Threshold `color_for_pct` (`:80-84`): `<50` ok, `<80` warn, else bad; applied to context and the 5h/7d windows (`:315,395,403`). Cache-timer: `warn` when `<60` s left.
2. Themes: six, selected by `CC_STATUSLINE_THEME`: `default` (terminal's own 16 colours in bold), `tokyo`, `nord`, `solarized`, `dracula` (hex), `mono` (dim and bold only, no hues). Format: a role-to-colour dict of the nine roles; adding one is editing the `THEMES` dict. Unknown name falls back to default.
3. Colour spec/depth: `default`/`mono` ANSI attributes; other themes truecolor `38;2` via `_rgb()`. No downsampling, no NO_COLOR.
4. Fill: foreground-only.
5. Separators: `│` in `muted` (`:263`); `·` inside notes.
6. Neighbours: role colours plus the muted `│`.
7. Light/dark: not present; `default` uses the terminal's own palette, so it follows the terminal.
8. Glyphs: emoji (`🧠 🕐 ⏱`), bar `▓░` 6 cells. No Nerd Font.
9. Other: effort level colour ladder; cache TTL countdown note.
10. Customisation: env var `CC_STATUSLINE_THEME`; edit the dict.

## Owen-Silva/mods
https://github.com/Owen-Silva/mods (stars: 0). Five Claude Code mods (rails, followups, eta, fleet, pace); they draw bands above the prompt. Not a conventional statusline.
1. Segment colour: by tone. `pace/hooks/register.tsx:43-49` and `eta/hooks/register.tsx:63-68` map a segment's `tone` to a fixed hex: `accent #8fa7bf` (eta `#8a9bb0`), `warn #c9a25a`, `alert #c96f5f`, `dim` = host dim colour, `normal` = host default. The tone is set by the mod's logic (pace status, estimate state).
2. Themes: not present (a muted fixed palette). The word "catppuccin" appears in the file scan but the colour code read does not use it.
3. Colour spec/depth: hex strings to the host `Text`; depth and NO_COLOR are the host's.
4. Fill: foreground-only.
5. Separators: not styled.
6. Neighbours: tone differences only.
7. Light/dark: not present (fixed mid-tone hexes).
8. Glyphs: not inspected beyond text.
9. Other: bands are text; `fleet` shows context % against hand-off and ceiling lines.
10. Customisation: `user.local.json` (name setting) and rule files; no colour options.

## ozzycodes2/cc-powerline
https://github.com/ozzycodes2/cc-powerline (stars: 0). TypeScript, two render styles (powerline, builtin), Ink TUI editor.
1. Segment colour: by palette position, with auto-contrast text. `src/config/palette.ts:31-47` `applyPalette`: a theme is `{fg, bgs[]}`; each group (left or right of each line) is painted round-robin over `bgs` (`bgs[i % len]`), restarting at `bgs[0]` per group, and each segment's fg is computed with `readableFg(bg)`. A segment may still carry its own `fg`/`bg` (`defaultSettings.ts:9-16` sets model `#2d3142`, git-branch `#4f5d75`, directory `#3d5a80`, context `#5c6b73`, cache-hit `#6d597a`, session-cost `#2a9d8f` with black text).
2. Themes: three presets (`src/cli/presets.ts:12-28`): `slate` (default, `#2d3142 #4f5d75 #3d5a80 #5c6b73 #6d597a #2a9d8f`), `mono` (`#1c1c1c #3a3a3a #585858 #767676`), `ocean` (`#023047 #126782 #219ebc #2a9d8f`). It also reads rings from the user's existing prompt themes: Powerlevel10k `~/.p10k.zsh`, oh-my-posh (`$POSH_THEME`), classic Powerline colorschemes (first 2 to 8 distinct colours; README Themes). Users can recolour per segment in the TUI.
3. Colour spec/depth: 16 named colours plus `#rrggbb` truecolor only (`src/render/colors.ts:11-72`); no 256, no downsampling. `NO_COLOR`: not present.
4. Fill: both. Powerline style uses background blocks; the builtin style is foreground-only (`builtinRenderer.ts:4`).
5. Separators: powerline arrows, separate left and right groups: left `` chained, right `` mirrored (`powerlineRenderer.ts:14-15`). Arrow = this block's bg as fg on the neighbour's bg; the end cap is the last block's colour on the terminal default (`:67-72`). Builtin style joins with a configurable string (default two spaces).
6. Neighbours: the background ring; neighbours differ by the order of hand-picked colours (slate is muted blue-grey steps with a teal end, not a strict lightness ramp).
7. Light/dark: yes, a real contrast solver. `readableFg` (`colors.ts:119-136`) finds the neutral grey whose WCAG contrast against the segment bg is 7:1 (`TARGET_CONTRAST`), darkening text on light backgrounds (luminance > 0.179) and lightening on dark; mid-tones that cannot reach 7:1 clamp to black or white. Named colours are resolved with the xterm default palette RGB table (`NAMED_RGB`).
8. Glyphs: Nerd Font powerline glyphs; emoji appear in the TUI; no ASCII mode noted.
9. Other: full-screen Ink TUI with live preview; the wizard falls back to readline when piped; right-anchored segment group with width composition (`composeLine`).
10. Customisation: JSON config (`style`, per-line `left`/`right` widget lists with `fg`/`bg`, `theme{separator, rightSeparator, defaultFg, defaultBg}`), TUI (`cc-powerline init`), `--style builtin`, `--width`.

## Palmerschallon/claude-code-context-statusline
https://github.com/Palmerschallon/claude-code-context-statusline (stars: 0). One bash script showing a 30-cell context bar.
1. Segment colour: threshold on the bar. `statusline.sh:70-73`: `>=80` red, `>=50` yellow, else green; applies to `[bar]` and the bar only. Lines added `+N` green, removed `-N` red (`:52`). Model and token counts DIM.
2. Themes: not present.
3. Colour spec/depth: ANSI 16; no NO_COLOR, no depth detection.
4. Fill: foreground-only.
5. Separators: two spaces.
6. Neighbours: the bar colour vs dim text vs green/red diff counts.
7. Light/dark: not present.
8. Glyphs: `█ ░` in brackets; no emoji.
9. Other: 30 cells wide (`BAR_WIDTH=30`).
10. Customisation: none.

## Pamacea/statusline
https://github.com/Pamacea/statusline (stars: 0). TypeScript/Node plugin; foreground ANSI only.
1. Segment colour: fixed per element, plus a threshold ladder. `plugins/statusline/src/lib/render.ts`: git branch `lightGray` (`:112`), dirty `*` purple, staged counts cyan, unstaged adds green / deletes red / file count yellow (`:129-144`), model name/version `peach` (RGB 222,115,86, `colors.ts` `peach`) (`:430`), cost green, context percent bold light grey with a grey `%`, durations and labels (`S:`, `L:`, `W:`, `D:`) gray, pace delta green `>5`, lightGray `>0`, yellow `>-10`, else red (`:233-236`). Progress bars: `formatters.ts:196-201` `progressive` mode: `<50` gray, `<70` yellow, `<90` orange (256 colour 208), else red; other modes fix one colour (green, yellow, peach, black, white).
2. Themes: not present (`defaults.json` has bar `style` rectangle/filled, `color` progressive, and `colorThresholds` low 30 / medium 60 / high 90 for context).
3. Colour spec/depth: ANSI 16 (bright variants), 256 for `orange`, truecolor for `peach` (`colors.ts:79-90`). `supportsColor()` (`:130-165`): `FORCE_COLOR` (0 disables), `CI` disables, `NO_COLOR` disables, `TERM=dumb` disables, Windows assumed on.
4. Fill: foreground-only; background helpers (`bgPeach`, `bgBlue`, etc.) are defined but not used in the render path I read.
5. Separators: configurable strings: `▸` between top-level parts and `•` for info items, drawn gray (`defaults.json:13-15`, `render.ts:223,415`).
6. Neighbours: gray labels vs coloured values; separators.
7. Light/dark: not present.
8. Glyphs: Unicode (`▸ •`), bar style rectangle/filled; emoji present in hook output.
9. Other: hooks (`session-start`, `post-tool-use`, `user-prompt-submit`) feed a plugin; pacing delta colouring for 5h and weekly limits.
10. Customisation: `defaults.json` config (separators, bar style, colour mode, thresholds, tokens/cost formats, pathDisplayMode).

## panuakdet-gmail/claude-statusline-ramp
https://github.com/panuakdet-gmail/claude-statusline-ramp (stars: 0). A wrapper around ccstatusline that recolours its output with a perceptual-style ramp.
1. Segment colour: the context group (token count, bar, percent) takes one colour from a five-band ramp; other widgets are fixed. `statusline-wrapper.sh:145-155` ramp: `>=90` 256-colour 167 soft red `#D75F5F`, `>=75` 208 orange `#FF8700`, `>=50` 178 gold `#D7AF00`, `>=25` 107 moss `#87AF5F`, else 79 mint `#5FD7AF`. Fixed (from `ccstatusline-settings.json`): cost hex `8A8A8A`, folder cyan, branch magenta, brackets brightBlack. The plan row's 5h/7d bars (`:240-262`): steel blue 74 while there is room, orange 208 at `>=75`, red 167 at `>=90`; label grey 59, percent bold 255.
2. Themes: not present.
3. Colour spec/depth: 256-colour indexes. The wrapper folds any truecolor SGR (`38;2;r;g;b`) down to the 256 cube, with a separate grey ramp 232-255, because Apple Terminal has no 24-bit (`rgb_to_xterm256`, `:158-180`). `ccstatusline-settings.json` sets `colorLevel: 2`. NO_COLOR: not present.
4. Fill: foreground-only (`powerline.enabled: false`).
5. Separators: ` | ` (`defaultSeparator`); `[` `]` in brightBlack around the bar.
6. Neighbours: separators and hue (cyan folder, magenta branch, grey cost).
7. Light/dark: not present; the ramp is picked for dark backgrounds (unverified for light).
8. Glyphs: bar `▓░`; plan row bar `▬`/`░`; `↻` for reset.
9. Other: the recolour finds the context widgets by the colour code that sits immediately before a bar glyph (`U+2588..U+2593`), swaps every occurrence for the ramp colour, and notes the coupling: another widget sharing that sentinel colour would be recoloured too (`:50-63`). Plan row switch `CCRAMP_PLAN_LINE=off`.
10. Customisation: ccstatusline JSON for layout; env var `CCRAMP_PLAN_LINE`; edit the wrapper for the ramp. `preview-ramp.sh` / `preview-plan.sh` render previews.

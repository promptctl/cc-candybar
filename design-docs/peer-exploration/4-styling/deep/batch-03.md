# Batch 03: styling read from source

Anchors are `file:line` (or key/function) in the repo's default branch as fetched. Numbered points follow the brief: 1 segment colour, 2 themes, 3 colour spec/depth/NO_COLOR, 4 fill, 5 separators, 6 telling neighbours apart, 7 light/dark + text contrast, 8 glyphs, 9 other, 10 customisation.

## par_cc_usage
https://github.com/paulrobello/par_cc_usage , 84 stars
(The Rich theme system serves the monitor dashboard, not the statusline; the statusline is nearly monochrome.)
1. By state only: the statusline colours just the progress bar by percentage, `statusline_manager.py:255-271` `_get_progress_color`: <50 bright green `\033[92m`, <80 bright yellow `\033[93m`, else bright red `\033[91m`. Every other token (model, project, cost, git) is uncoloured text from a template with `{sep}`. No `theme` import in `statusline_manager.py` (grep: zero hits).
2. Themes exist only for the Rich dashboard: `theme.py` `ThemeManager` has 6 (DEFAULT, DARK, LIGHT, ANSI, ACCESSIBILITY, MINIMAL, defined at lines 132/196/259/324/388/452). Format is a semantic `ColorScheme` pydantic model (`theme.py:15-51`: success/warning/error/info, primary/secondary/accent/border/background/text/text_dim, plus data roles token_count, model_name, project_name, tool_usage, tool_mcp, cost, progress_low/medium/high/critical, burn_rate, eta_normal/eta_urgent). Light is Solarized-light hex (`theme.py:204-230`). Selected by `display.theme` / env `PAR_CC_USAGE_THEME` (`config.py:64,514`). No user-defined themes found.
3. Statusline: ANSI 16 bright codes only; `color_end` is `\033[39m`. No NO_COLOR check in `statusline_manager.py`. Dashboard hex themes go through Rich (downsamples itself).
4. Foreground only.
5. Plain text separator, config `statusline_separator`, default `" - "` (`statusline_manager.py:722`); `_collapse_separators`/`_trim_separators` (932-1018) tidy empty segments.
6. Not present (separator text only).
7. Light/dark: only the dashboard `light` theme; `statusline_progress_bar_colorize` toggles bar colour (`config.py:217`). No contrast logic.
8. Unicode bar glyphs (basic or "rich" centred-percent style, `config.py:221`); emoji used in dashboard (`emoji_config.py`, not read in detail).
9. Rich-style bar with percent drawn inside the bar (`statusline_manager.py:376-430`).
10. TOML/YAML config + env vars (`PAR_CC_USAGE_*`), `statusline_template` with variables, date/time formats.

## pyccsl
https://github.com/wolfdenpublishing/pyccsl , 83 stars
1. Fixed per field via theme role: `pyccsl.py:197-226` `get_field_color` maps folder->`folder`, git->`git`, model and all `perf-*` fields->`model`, input->`input`, output and tokens->`output`, cost->`cost`, badge->always 244 (grey). Performance badge dots use state colours `[82,220,208,196]` (`:841`) from cache-hit/response-time thresholds.
2. 9 bundled in `THEMES` (`:93-159`): default, solarized, nord, dracula, gruvbox, tokyo, catppuccin, minimal, none. Format: 6-key dict `{folder, git, model, input, output, cost}` of 256-colour indices. No user-defined themes (only edit the file); selected by `--theme` / env `PYCCSL_THEME`.
3. 256-colour indices only (`38;5;n`/`48;5;n`, `apply_color :170-194`). No depth detection. No NO_COLOR; `theme=none` is the only colour-off switch (`:207`, `:1319`).
4. Both: foreground text in non-powerline styles (`:1150-1154`); powerline style fills each segment with its bg and black text `fg_color=0` (`:1191`).
5. `--style` choices `powerline, simple, arrows, pipes, dots` (`:326`): ` > `, ` → `, ` | `, ` · ` (`:1021-1029`); powerline arrow U+E0B0 (`:168`) with fg=current bg, bg=next bg (`:1199`); last arrow bg=0 (`:1206`).
6. Powerline: different bg per role, but adjacent segments with the same bg are merged into one block (`:1163-1177`), so model+perf badges merge. Otherwise separators only.
7. No light/dark detection. Powerline text is always black (index 0) regardless of bg lightness (`:1191`), so dark themes like `minimal` (greys 242-252) use black on mid-grey.
8. Emoji by default, `--no-emoji` (`PYCCSL_NO_EMOJI`) swaps to ASCII; powerline needs a powerline font.
9. Performance badge of 4 coloured dots on a 50% grey (244) bg in powerline mode (`:846`).
10. CLI flags + `PYCCSL_*` env vars + `--env-file` (`:285-394`), `--fields` list.

## arcade-statusline
https://github.com/sorosora/arcade-statusline , 81 stars
1. Mostly fixed per element inside a themed scene; state only for percentages: `src/helpers.rs:34-42` `colour_remain`: remaining >50 white `\x1b[0;37m`, 21-50 bold yellow, <=20 bold red. Fixed: "CLAUDE" orange 208 (`helpers.rs:50`), model white (pacman) or dim (pikmin), pacman player yellow, ghosts red, walls blue 27 (`pacman.rs:14-18`), pikmin sky 39 and grass 28 (`pikmin.rs:192-197`).
2. Two "themes" = game scenes (`src/themes/mod.rs` `trait Theme`: pacman, pikmin) chosen with `--theme`; they are renderers, not palettes. No user themes.
3. ANSI 16 + a few 256 indices (27, 28, 39, 208). No depth detection, no NO_COLOR.
4. Foreground only.
5. Box-drawing frame (pacman) and emoji trail (pikmin), not separators.
6. Not present (spatial layout in a fixed-width box).
7. No light/dark logic; `--narrow-emoji` auto-detected for JetBrains terminals to fix emoji width (README, `visible_width_ex` in `helpers.rs:54`).
8. Heavy emoji/unicode (flowers, fruits, ᗧ, ᗩ). No ASCII mode.
9. Animation: chomp toggle and trail state persisted in `/tmp/.claude-pacman-chomp` / `/tmp/.claude-pikmin-anim`; effort badge from `~/.claude/settings.json` (`settings.rs`).
10. CLI flags only (`--theme`, `--narrow-emoji`, `--buddy-padding`).

## claude-statusline (ersinkoc)
https://github.com/ersinkoc/claude-statusline , 78 stars
1. Powerline themes: by position, cycling a per-theme colour list: `unified_powerline_system.py` `_generate_100_themes` (`random.seed(42)` at :100-104) does `color = colors[j % len(colors)]` over a randomly chosen widget list, so colour has no relation to which widget it is. Non-powerline path: `config.json` `display.color_scheme` maps roles to names (model cyan, status_live green, status_expired red, status_new blue, time yellow, messages white, tokens magenta, cost yellow, git_branch blue, brackets white), resolved to colorama `Fore` in `console_utils.py:211`.
2. 100 generated powerline themes (`{base_name}_{NNN}`, base names like cyber, matrix, fire, ocean, nord-ish, drawn from 12 colour-scheme lists, e.g. `['dark_blue','blue','cyan','white']`, :111-124). Theme = `{name, description, segments:[{widget, icon, color}]}`. Users can build custom ones in `interactive_theme_manager.py` ("THEME BUILDER", saved as `custom_<name>`). Selected via `theme_config.json`.
3. Truecolor throughout (`\x1b[48;2;r;g;bm`, 30 "soft" named RGB entries, :17-60). `_check_terminal_capability` (:651-678) sniffs `WT_SESSION`, `TERM`, `ConEmuPID`, VS Code. No downsampling; `render_theme` says "NO CHECKS - JUST RENDER POWERLINE" (:491). No NO_COLOR.
4. Background-filled cells with text colour bundled per colour (`'text': '\x1b[97m'` white or `'\x1b[30m'` black).
5. Powerline U+E0B0 arrows: bg = next segment's bg, fg = current colour's `fg` (same RGB) (:520-531); final arrow on default bg. Legacy path: brackets/plain.
6. Different hues per position plus arrows; the lists include dark->light ramps (`['black','dark_gray','gray','light_gray','white']`), so some themes are lightness steps.
7. Per-colour hard-coded text: light fills (soft_white/yellow/peach/mint/lavender/beige/sand) get black text, the rest bright white. No computed contrast, no terminal-bg detection.
8. Nerd Font icons chosen randomly per widget from pools (`model_icons`, `git_icons` ... :150-170) and emoji; "ALWAYS with nerd fonts".
9. Second line: block-character session progress bar (`_render_progress_bar` :540). Rotator and daemon files (`statusline_rotator.py`).
10. `config.json`, interactive TUI selectors, CLI (`cli.py`), `theme_config.json`.

## claude-leverage
https://github.com/Filip-Podstavec/claude-leverage , 68 stars
(The repo is a plugin/benchmark collection; styling is in `statusline/statusline-command.sh` only. The hex/gradient signals come from `bench/` plot scripts, not the statusline.)
1. Fixed + state: bars for 5h, 7d, ctx via `make_bar` (`statusline-command.sh:15-24`): >=85 red `\033[31m`, >=60 yellow `\033[33m`, else green `\033[32m`. Model name cyan `\033[36m` (line ~63), git branch blue `\033[34m` prefixed `# ` (~74). Reset countdown dim `\033[2m`.
2. Themes: not present.
3. ANSI 16 only. No depth detection, no NO_COLOR.
4. Foreground only.
5. Dim ` | ` (`sep = '\033[2m | \033[0m'`, last lines).
6. Not present beyond the separator and per-segment colour (cyan model vs blue branch).
7. Not present.
8. Block bar `█`/`░`, 10 cells; ASCII `#` for branch; no emoji.
9. Python-in-bash for JSON parsing, Windows Git Bash oriented.
10. None (edit the script).

## claudebar
https://github.com/mryll/claudebar , 61 stars
not a Claude statusline: a Waybar/Omarchy-shell widget that prints Pango-markup JSON of Claude plan usage (`claudebar` bash script, header lines 1-4). Style note for reference: palette resolved from the OS theme (Omarchy `colors.toml`, else pywal, else One Dark defaults, `:540-681`) and `--color-low/mid/high/critical` overrides; usage colour is a continuous OKLab-free linear hex interpolation between anchors at 0/50/75/90% (`color_for :845`, `GAUGE_PCTS :710`); honours `NO_COLOR` and `--no-color=all|bar|tooltip` (`:46,279-289`).

## project-sentinel
https://github.com/Arjun0014/project-sentinel , 57 stars
(A Claude Code mod/HUD in React/Ink, with a status bar and cards, not a classic `statusLine` command.)
1. By semantic tone, mapped to Claude Code theme keys: `plugins/project-sentinel/hooks/ui/theme.ts:14-33` `toneProps`: normal=none, muted=dimColor, good=`success`, warn=`warning`, bad=`error`, accent=`claude`, info=`suggestion`. Each tab has one accent key (`ACCENT` :39-46: overview claude, context ide, behavior autoAccept, guardrails planMode, activity suggestion, setup inactive) used only for card titles and tab indicator. Which tone a given metric gets is decided upstream (not read).
2. No own themes: "Colors are Claude Code theme keys, so every drawing follows the person's theme (dark, light, daltonized, ANSI)" (`theme.ts:1-9`). A separate `SVG_COLOR` hex table (`:52-60`) is for Desktop/mobile SVG output where theme keys do not reach.
3. Theme keys resolved by Claude Code (so depth handled by the host); SVG path uses hex. NO_COLOR: not found in the files read.
4. Foreground tones; the open-pane chip uses `backgroundColor='claude'|'subtle'` with hover (`hud.tsx:382`).
5. Plain glyph separators `·` and `│`-style rules (`G.rule`, `G.mid`).
6. Restraint rule stated in `theme.ts:5-8`: default text, dim secondary, one accent for brand and selection, status colours reserved for state; neighbours differ by glyph/label, not hue.
7. Light/dark entirely delegated to the host theme keys.
8. Single-cell BMP glyph set `G` (`theme.ts:63-110`), sparkline `▁..█`, block meters `▇`, notch `█`, thin bar `▂`; clock face `○◔◑◕●`.
9. Meters with a handoff notch; also renders SVG graphics inline on Desktop (`hud.tsx` `graphic: { source: svgContextMeter ... }`); animation signals (52) are in other files.
10. Mod settings via the plugin; no colour config found.

## ctxline-claude
https://github.com/MithunWijayasiri/ctxline-claude , 55 stars. FORK OF TahaSabir0/Best-ClaudeCode-statusline: differences only.
1. Parent (`statusline.js:20-36`): green/yellow/orange(208)/red by usage <50/<75/<90, `│` separators, dir/model uncoloured. Fork (`statusline.js:78-95`): usage thresholds shifted to <60/<80/<90; context bar uses its own <50/<65/<80 ladder (`:222-226`); added effort colour (`getEffortColor :79`: max red, ultracode purple 135, else dim), scoped model-usage bars flat orange, red at >=90 (`getScopedColor :94`), git ahead green `↑`/behind red `↓` (`:212-213`), cost dim, task dim, update notice green.
2. Themes: not present in either (the "github" signal is README badges/preview scripts).
3. Same: ANSI 16 + 208/135 indices; no NO_COLOR, no depth detection. Fork adds `CTXLINE_DISABLE` segment toggles (`:20`).
4. Foreground only.
5. Fork keeps `' │ '` (`SEGMENT_SEP :32`) but wraps to a second line by measured width using `COLUMNS` (`:732-760`); parent just joins with `│`.
6. Separators only (same as parent).
7. Not present.
8. Fork adds `⎇`, `↺` reset glyphs, `⏱`, `⬆`; parent uses a skull emoji with blink at critical (`statusline.js:54`), fork drops that.
9. Fork has a desktop pet hook (`desktop/hooks/pet.ts`) and SVG preview scripts (not read).
10. Env `CTXLINE_DISABLE`; no config file.

## xiangrui-toolkit (xiangrui-hud)
https://github.com/xiangruiai/xiangrui-toolkit , 55 stars
(Only `plugins/xiangrui-hud` is a statusline; the rest of the repo is unrelated skills.)
1. Fixed per role with threshold switching: `src/render/colors.ts:84-123` defaults model cyan, project yellow, git magenta, gitBranch cyan, label dim, custom line 208, context green; `getContextColor` (:127) >=85 critical red, >=70 warning yellow, else context colour; `getQuotaColor` (:133) >=90 red, >=75 bright magenta, else bright blue.
2. Themes: not present (single palette), but every role is overridable in `config.json` `colors` (`config.ts:34-45`, defaults :151-163).
3. Values accept 8 named presets, 256 index (number), or `#rrggbb` truecolor (`colors.ts:42-60`). Brand mark uses truecolor `#22a667` hard-coded (:12). No depth detection, no NO_COLOR.
4. Foreground only; `█`/`░` bars (empty part dim).
5. Layout `'default' | 'separators'` in config (`config.ts:241`); separators are plain text.
6. Different hue per role; otherwise not present.
7. Not present.
8. `❖` brand prefix, block bars, plain glyphs.
9. Per-model/usage thresholds are config numbers (`usageThreshold`, `sevenDayThreshold` 80).
10. JSON config at the plugin dir `config.json` (`getConfigPath`), validated per colour (`validateColorValue`).

## claude-terse
https://github.com/lowenbjer/claude-terse , 52 stars
1. By state only, one segment: `statusline/context-meter.js:11-22` context used %: green `\x1b[32m` <37, yellow `\x1b[33m` 37-48, orange `\x1b[38;5;208m` 49-59, from 60 blinking red with skull `\x1b[5;31m💀`. Model name uncoloured. Thresholds are deliberately low ("retrieval quality degrades before a large window fills", comment line 14).
2. Themes: not present.
3. ANSI 16 + one 256 index; blink SGR 5. No depth detection, no NO_COLOR.
4. Foreground only.
5. Two-space gap between model and meter.
6. Not present.
7. Not present.
8. One skull emoji.
9. Blinking critical state.
10. None.

## videvjs/claude-statusline
https://github.com/videvjs/claude-statusline , 52 stars
1. Fixed + state, `statusline-command.sh:46-76`: model fixed truecolor amber `38;2;210;170;90`; context ladder >70 red `\033[31m`, >40 yellow, else indigo `38;2;129;140;248` (calm state is a brand colour, not green); 5h/7d bars <=40 green `38;2;76;175;80`, <=70 yellow, else red. Folder and branch uncoloured.
2. Themes: not present.
3. Mixed ANSI 16 and truecolor in one ladder. No detection, no NO_COLOR.
4. Foreground only.
5. Plain `" | "` joined by `IFS` (`:106`).
6. Not present.
7. Not present.
8. `█`/`░` 10-cell bar, `/folder`, `(branch)`; no emoji.
9. Effort shown in `[ ]` after the model.
10. None (edit script).

## glauberlima/claude-code-statusline
https://github.com/glauberlima/claude-code-statusline , 51 stars
1. Fixed per segment from a 6-slot semantic palette (`src/render.rs:14-23`, `components.rs:35-117`): model cyan, directory blue, git branch magenta, files-changed orange, cost green, context bar by tier. Tier (`config.rs:132-140`): <=30 green, <=50 cyan, <=70 orange, <=85 orange, else red (`components.rs:133-137`).
2. 6 bundled themes (`config.rs:71-78`): default (ANSI 16), dracula, tokyo-night, one-dark, solarized-dark, phosphor (CRT green with amber). Format: `Palette { blue, magenta, orange, cyan, green, red }` as ANSI strings (`render.rs:14-77`); no user-defined palettes. Unknown name falls back to default with a stderr note (`config.rs:92`). Bar style is a separate setting (plain, rainbow, gradient, gsd, plus the themed gradients `config.rs:38-60`).
3. Default = ANSI 16; others truecolor `38;2` (test asserts it, `render.rs:129`); bars use 256-colour indices. No downsampling shown, no NO_COLOR found (the env.truecolor signals are theme code).
4. Foreground only.
5. Gray `|` between components (`render.rs:107` `separator()`), parts filtered if empty.
6. Different hue per segment; separators.
7. Not present; "default" theme leaves the terminal palette to the user's terminal theme.
8. Emoji prefixes (🤖 📁 🌿 ✏️ 💰), `█`/`░` 15-cell bar (`render.rs:100`); no ASCII mode.
9. Animated/positional bars: `rainbow` cycles `WAVE_COLORS` (12 xterm indices) shifted by `now_secs()` (`components.rs:142-152`); `gradient` is a positional green->red ramp over 11 indices (`GRADIENT_COLORS`); `fill_theme_gradient` walks the theme's six colours along the bar. Context messages rotating by time (`messages`).
10. `~/.claude/statusline.toml`, `--print-defaults`, interactive configure (`configure.rs`).

## claude-code-mods (nateherkai)
https://github.com/nateherkai/claude-code-mods , 46 stars
not a Claude statusline: four Claude Code mods (cache-keeper, recording-mode, goal-meter, collision-guard) that draw a line above the prompt / footer / pane in React-style `Text` with Claude Code theme colour names (`cache-keeper/hooks/register.mjs:223-225,719-722`: red bold >=95, yellow >=80, else dim; cache state warm green, cooling yellow, cold red, kept cyan; `gray` mapped to `dimColor`, `:805`). `fmt.mjs` has only number/sparkline/bar formatting.

## packycc
https://github.com/petiky/packycc , 46 stars
1. Fixed per segment, hard-coded in `src/core/statusline.rs:18-52`: model bold cyan `1;36`, directory icon bold yellow `1;33` + name bold green `1;32`, git bold blue `1;34`, usage bold magenta `1;35`, quota bold bright yellow `1;93`. No thresholds.
2. `Config.theme: String` exists (`config/types.rs:5`, default "dark" at `defaults.rs`) but nothing reads it; README lists "Custom themes" as unchecked (README:198).
3. ANSI 16 bold codes only. No detection or NO_COLOR.
4. Foreground only.
5. White `" | "` (`\x1b[37m | \x1b[0m`, `statusline.rs:56`).
6. Hue per segment; separators.
7. Not present.
8. `○` for directory, emoji and Nerd glyphs in segments (`glyph.nerd_font=6`; segment modules not read in detail).
9. A `text_mode` segment module exists (ASCII variant, file listed, not read).
10. `segments.{directory,git,model,usage,quota}` booleans in a config file (`types.rs:10-16`).

## claude-code-zellij-status
https://github.com/thoo/claude-code-zellij-status , 43 stars
not a Claude statusline: a Zellij zjstatus bar fed by Claude Code hooks (`cc-zjstatus/scripts/claude-activity-hook.sh`). Style note: colour by activity state from the clrs.cc palette (`:39-46`, README 45-76): done green `#2ecc40`, working yellow `#ffdc00`, reading/search blue `#0074d9`, project name `#4166F5`, needs attention red `#ff4136`, bash orange `#ff851b`, agent/skill/MCP purple `#b10dc9`, idle gray `#666666`; emitted as zjstatus `#[fg=#hex]` tags (`:111`).

## jantichy/claude
https://github.com/jantichy/claude , 41 stars
1. Fixed + state, `statusline/statusline.sh`: cwd dim yellow `2;33` (:300); model by family and effort (:177-189): Opus cyan family (`36`, `96` for max/xhigh, dim `2;36` for low), others blue family (`34`, `94`, bold `1;94` for max, dim `2;34` low); context ladder (:85-95) <60 dim green, <80 dim yellow, <85 yellow, >=85 red; 5h limit magenta (bright >=80 else dim, :111-113); weekly cyan (bright >=80 else dim, :138-140); git: red on suspicious config, yellow `~N changes`, dim green Clean (:269-277).
2. Themes: not present.
3. ANSI 16 with SGR 2 (dim) as the second intensity. No depth detection, no NO_COLOR.
4. Foreground only.
5. Gray `\033[90m│` (:285).
6. Hue per segment and dim-vs-bright intensity as a "calm vs attention" step; separators.
7. Not present.
8. `█/░`-style `[bar]`, `⚠`; Czech labels.
9. Model hue and brightness encode effort level ("Opus medium visually corresponds to Sonnet xhigh", comment :173).
10. None (script edit).

## ccswap
https://github.com/errhythm/ccswap , 39 stars
(Account switcher; `ccswap statusline` is one of its features, plus a Claude Code mod and a Textual TUI.)
1. Semantic roles, `src/claude_swap/statusline.py:35-52` `_Palette{accent, fg, muted, ok, warn, crit, track}` with `severity(pct)` (>=90 crit, >=70 warn, else ok). Mapping (:232-262): model accent, context % by severity, cwd fg, git branch ok-green with dirty `*` crit, duration muted/fg, effort accent when high/xhigh/max else muted, account number accent, `next:` muted; rate bars by severity over a `track` colour.
2. Two palettes `DARK` and `LIGHT` (:54-55), copied from `tui/theme.py` ("cswap-dark" Textual theme: one warm terracotta accent `#d7875f`, desaturated severity colours). Setting `ui.theme` auto/dark/light; no user palettes. The Claude Code mod maps the same roles to host theme keys (`mod/hooks/register.tsx:44-46`: accent->`claude`, fg->`text`, muted->`inactive`, ok->`success`, warn->`warning`, crit->`error`, track->`subtle`), with explicit dark/light hex when the config row is readable.
3. Truecolor `38;2` only (:63). No downsampling. No NO_COLOR.
4. Foreground only.
5. Muted `│` (:241). Bars use `━ ╸ ─` glyphs.
6. Not present (roles, separators).
7. Real light adaptation: LIGHT palette with darker hexes (`#954c2a` accent, `#2b2723` fg); selection in the CLI is `auto` -> OSC 11 background query in `appearance.py:24-93` (luminance >0.5 = light), but the statusline itself cannot probe from a pipe and defaults auto to dark (`statusline.py:300`). Mod follows host theme.
8. Emoji `✍️` for context, `⏱`, `◑`; thin-line bar glyphs.
9. Half-cell bar resolution (`╸`).
10. `ui_settings` file (theme, mask, `load_ui_settings`), CLI.

## glowup
https://github.com/NovusEdge/glowup , 37 stars
(A Claude Code mod with "packs" and themes; also a takeover of the statusLine command that prints a per-session status file.)
1. Fixed roles + state, `hooks/fields.ts:50-93`: activity `◆` accent + word `text`; `ctx`/`5h`/`wk` label `dim` and percent `toneFor(p)` = `pass` below `meter.warn` (50), `edit` from it, `fail` from `meter.danger` (80), configurable in `/glowup setup` (docs/statusline.md); `+N` pass `−N` fail; level accent with `faint` empty pips; everything else `text`.
2. 7 bundled themes (`docs/themes.md`): classic (default, Claude Code's own colours), glowup, aurora, dusk, cyberpunk, vaporwave, high-contrast. Format: JSON with comments in `~/.claude/glowup/themes/<name>.json`: `extends`, 14 semantic `colors` roles (accent, text, dim, faint, read, edit, shell, agent, pass, fail, panel, addBg, delBg, sel), `spinner.words`, `glyphs` (one width-1 char per tool kind), `band.hearts`. Users define and share (`/glowup theme add <https url>`; 64 KB data-only, no code). Validation strict `#rrggbb` (`docs/theme-reference.md`).
3. Truecolor when `COLORTERM` is truecolor/24bit, else 256 via a 6x6x6 cube map (`fields.ts:96-100`); entry under the prompt is plain text. No NO_COLOR found.
4. Foreground in the status line; diff views use `addBg`/`delBg` backgrounds; themes "leave the terminal background alone".
5. `·` plain separators in the entry; rules use `dim`.
6. Not present (roles).
7. `high-contrast` theme; `classic` follows Claude Code colours. No automatic light/dark.
8. Width-1 BMP glyphs only, emoji rejected by validation.
9. Gradient and wave colour helpers `hooks/color.ts` (`mix`, `gradient`, `wave`, `wave3` for the shimmer spinner, bold on crest); a web "studio" (`docs/web/app/studio/ColorWheel.tsx`, `ColorsSection.tsx`, `ThemeSection.tsx`) to design themes; pets and a context "hearts" meter.
10. `/glowup config`, `/glowup setup`, `/glowup theme`, statusline fields list (`activity ctx effort 5h week` default, 14 field ids), `/plugin` settings.

## claudia-statusline
https://github.com/hagan/claudia-statusline , 36 stars
1. Semantic roles per component, `themes/catppuccin.toml:14-33`: directory, git_branch, model, duration, separator, lines_added, lines_removed, cost_low/medium/high (<$5, $5-20, >=$20), context_normal/caution/warning/critical (<50, 50-70, 70-90, >=90). Directory and model get different hues (catppuccin: blue, pink; light theme: both blue).
2. 11 embedded TOML themes (`src/theme.rs:35-45`): dark, light, monokai, solarized, high-contrast, gruvbox, nord, dracula, one-dark, tokyo-night, catppuccin. User themes in `~/.config/claudia-statusline/themes/*.toml` (size cap 256 KiB). Format: component colours + optional `[palette.*]` of named custom colours. Discovery order CLI `--theme` > config > env `CLAUDE_THEME` > user dir > embedded > default (`theme.rs:8-18`).
3. Values may be named (black..white, bright_*, gray, light_gray 245, orange 208), `#RRGGBB` (24-bit), or raw ANSI (`resolve_color`, `theme.rs:484-545`). No depth detection. NO_COLOR honoured: `display.rs:266-316` (`enabled()` reads env, with a test override) and a CLI flag sets it (`main.rs:465`). Unknown name warns and falls back to white.
4. Foreground only.
5. Bullet `•` coloured by the `separator` role; layout/template mode has configurable separator (`display.rs:90`).
6. Not present beyond hue per role and separators.
7. Explicit `light` theme with darker/named colours ("darker for light backgrounds", `themes/light.toml`); selection is by name, no terminal-background probe found. `context_normal` is gray on light vs `#CDD6F4` text on catppuccin.
8. Emoji/box glyph counts are small; no ASCII mode noted.
9. None found beyond cost/context threshold colours.
10. TOML config + themes, CLI flags, env vars, layout templates.

## goccc
https://github.com/backstabslash/goccc , 35 stars
1. Plain style: segments mostly uncoloured; only thresholds colour a value (`color.go`, `statusline_config.go:140-142,242`): cost and context yellow then red as they rise (cost defaults `warn_threshold` $25, `alert_threshold` $50, README:299-300); rate-limit windows inverted (yellow below 50% remaining, red below 25%). Powerline style: palette cycled by position (below).
2. Powerline palette is data (`PowerlineConfig`, `powerline.go:37-45`): default five Dracula slates `#383a4c #404358 #494c63 #52556e #5a5e7a` (a lightness ramp), `fg #f8f8f2`, warn `#f1fa8c`, alert `#ff5555`; accents outside the cycle: `cap` bg `#2a2c3a`, `pet` bg `#ff79c6` fg `#282a36` (:28-31). A user palette replaces the whole set and drops the accents. No named themes.
3. Truecolor `38;2`/`48;2` only (:106-112); plain style uses ANSI 16. NO_COLOR and `-no-color` flag supported (`color.go:15-17`, README:322); powerline falls back to plain under NO_COLOR (`statusline_config.go:35`). Powerline needs truecolor + Nerd Font (README:157).
4. Plain = foreground; powerline = bg-filled blocks with padded text.
5. Powerline: U+E0B0 arrow, fg = this block's bg, bg = next block's bg (`:223-228`); last arrow fg only; `│` divider when two neighbours share a bg (`:224-225`); arrow and divider configurable. Plain: configurable `separator`.
6. By position, lightness steps within one hue family: `styleSegments` (`:183-208`) gives each segment `palette[next % len]` (accent segments don't advance the counter), so adjacent blocks differ by a small lightness step, repeating every 5. `segment_options.<name>.bg/fg` override per segment. Same-colour neighbours merge (README:172).
7. `textOn(bg)` picks `#1c1c1c` or `#f5f5f5` by WCAG relative luminance > 0.18 (`:122-141`) for alert blocks; normal blocks use fixed `fg`. No terminal light/dark detection.
8. Emoji per segment (configurable via `segment_options.emoji`, `label`), Nerd Font arrows in powerline; `cap` block.
9. `alert_style` `block` (whole block recoloured warn/alert, keeping its palette slot so later blocks don't shift), `text`, or `none` (:178); a `pet` segment (`pet.go`, animation signals) with its own accent colours.
10. JSON config under `statusline` (`segments`, `separator`, `style`, `segment_options`, `powerline`, `pet`), CLI flags.

## fusengine/agents (statusline plugin)
https://github.com/fusengine/agents , 34 stars
(A large agent-plugin repo; the statusline is `plugins/core-guards/statusline` plus a `statusline-mod` that draws cards.)
1. Fixed per segment with percent thresholds: label+icon colours: claude blue (`claude.segment.ts:24`), agent cyan, directory cyan with bold link, git branch magenta, staged green `+N`, unstaged red `~N`, edits cyan with green/red counts, model purple, cost yellow, daily-spend orange label + yellow value, effort orange, extra-usage green label; context label magenta. Progressive colour (`utils/colors.ts:46-50`): >=90 bold bright red, >=70 bold bright yellow, else green; the context alert % is rescaled so 100% matches the autocompact point (`context.segment.ts:19-26`) while the shown % stays real. Constants `COLOR_THRESHOLDS` 70/90 (`constants/colors.constant.ts`).
2. Themes: not present for the terminal statusline. The mod's card look is one fixed `THEME` (`statusline-mod/theme.ts`: navy chips `#07182b`, text `#fff`, muted `#8da2bb`, warn `#f5c242`, bad `#ff5c5c`, ctxFill `#22c55e`, fiveFill `#2f6bff`, sevenFill `#e6a117`; `contextColor` green <60, amber <80, red).
3. Forced ANSI: "FORCE ANSI colors (ignore TTY detection)" (`colors.ts:2`); 16-colour codes plus 256 indices for purple 135, orange 208, gray 240. No NO_COLOR.
4. Foreground in the terminal statusline; filled chips in the mod cards.
5. Gray separator string from config `global.separator`, with spaces unless `compactMode`; optional two-line mode split by segment priority (default 45) (`statusline.renderer.ts:63-88`).
6. Different hue per segment, gray separators.
7. Not present.
8. Icons per segment (`icons.*`) and optional labels (`showLabels`); clickable OSC-8 directory link.
9. Web configurator: `src/configure-web/styles.ts` (dark UI with live preview and per-segment toggles); hit-ratio colour for cache (`hitColor`).
10. JSON config (`StatuslineConfig`: global, per-segment enabled/progressBar style/length/useProgressiveColor), web configurator, `setup.sh`.

## tokenline
https://github.com/inbrace-tech/tokenline , 34 stars
1. Mixed: labels gray 244; context bold ladder >=80 red, >=50 yellow, else green (`tokenline.sh:373-375`); effort by level (:396-401): low/medium green, high yellow, xhigh orange, max red, else gray; rate-limit windows (:407-413): >=90 blinking red, >=75 red, >=50 orange, >=25 yellow, else green; cache TTL countdown a 5-step gradient green->lime 154->yellow->orange->red, blinking under 10% (:345-355); token kinds fixed per kind (read cyan, write yellow, input magenta, output green, equivalent orange, saving ladder green/yellow/orange, :535-548); running tool `●` 39.
2. "Themes" are layout presets (`--theme` / `TOKENLINE_THEME`: full, minimal, compact, economics, limits; `tokenline.sh:52-67`), not colour themes. Configurable colours are an unchecked TODO (README:227).
3. 256-colour indices (`38;5;n`) plus bold SGR (`01;3x`) and blink (`1;5`). No depth detection; NO_COLOR not present in `tokenline.sh`.
4. Foreground only.
5. Gray ` · ` for the one-line themes (:637); multi-line `full` uses separate rows.
6. Not present beyond hue per kind.
7. Not present.
8. Emoji and block bars; `🌌 Antigravity` marker for another client.
9. Blink on critical states; supports a Gemini/Antigravity client mode.
10. CLI/env theme; `install.sh --theme`.

## JungHoonGhae/claude-statusline
https://github.com/JungHoonGhae/claude-statusline , 34 stars
1. State ladders plus fixed: header line model bold white `1;37`, `│` dim (`statusline.sh:634`); context ladder by configurable `CONTEXT_WARN_PCT` 30 / `CONTEXT_CRIT_PCT` 70 -> green/yellow/red (:263-272, 85-86); rate-limit "left" bars by remaining >50 green, >20 yellow, else red (:276-288); smart-zone ladder <70 green, <100 yellow, else red (:302-311); git branch magenta `⎇`, ahead green `↑`, behind red `↓`, dirty red `*`; fast-mode cyan, output style magenta, agent blue, effort/thinking dim; PR state ✓ green / ✗ red / ◌ dim / ● yellow; today cost yellow.
2. Themes: not present.
3. ANSI 16 + SGR 1/2 only. No depth detection, no NO_COLOR.
4. Foreground only.
5. Dim `│` between header fields; dim rule lines `─` between sections.
6. Not present beyond hue per kind.
7. Not present.
8. `●`/`○` dot gauges for rate limits and context, `⎇ ⚡ ✦ ◑ ⛭ ⚠ ✓ ✗`, OSC-8 hyperlinks (:247).
9. Multi-line dashboard (ccusage daily/30-day cost table, tool and agent activity, budget warning in bold red).
10. `~/.claude/statusline.conf` (or env vars): thresholds, `SMART_ZONE_TOKENS`, `DAILY_BUDGET` (README:157-202).

## Claude-Code-Personalities
https://github.com/kumamaki/Claude-Code-Personalities , 34 stars
1. Fixed per element via 12 theme roles (`src/theme/colors.rs`): personality, activity, directory, file, error, warning, success, info, separator, model_opus/sonnet/haiku. Mapping in `statusline/mod.rs`: directory `apply_directory` (:206), personality (:223), git branch/files `apply_file` with `±N` warning and `✓` success (:285-303), activity (:356-366), model by family (:435), update notice success (:457), separator (:477). Default theme: Opus yellow 226, Sonnet 121, Haiku 32 (`theme/context.rs:11-19`), personality white 231; other themes use `model_opus/sonnet/haiku` roles (`theme/presets.rs:51-61`).
2. 8 themes (`theme/mod.rs:9-20`): Default ("terminal colours"), Dark, Light, Solarized, Dracula, Nord, Gruvbox, HighContrast. Format: `ThemeColors` struct of `Color::Rgb` or `Color::Terminal256`; no user-defined themes (config picks one).
3. Everything is emitted as truecolor: Default theme's 256 indices are converted by a 9-entry lookup (`colors.rs:30-41`, unlisted index -> gray 128), so it is not the terminal's own palette. Uses the `colored` crate (honours NO_COLOR by that crate's convention, not verified here). `prefs.use_colors` switch (`mod.rs:503`).
4. Foreground; `apply_with_dim_background` (fg at 25% as bg, `colors.rs:70-85`) is defined but not called in `statusline/mod.rs`.
5. Default `•` (configurable `separator_char`, `show_separators`), coloured with the `separator` role (`mod.rs:503-508`).
6. Hue per role; separators.
7. `Light` theme with darker RGB values (personality 64,64,64, success 0,136,0, etc.); `HighContrast` for accessibility; chosen by name, no probe.
8. Nerd Font icons module (`src/icons`), kaomoji personalities, emoji.
9. Personalities (task-based kaomoji) and context-aware model colour.
10. Interactive TUI (`claude-code-personalities config`, ratatui) saving `~/.claude/personalities_config.json`.

## ccstatus (MaurUppi/CCstatus)
https://github.com/MaurUppi/CCstatus , 34 stars. FORK OF Haleclipse/CCometixLine: differences only. The parent's current HEAD has been restructured (`src/style/`, `src/tui/dialogs/color.rs`; the fork's `src/ui/themes/presets.rs` 404s there), so the base compared here is the fork's own snapshot.
1. Fixed per segment per theme, background-filled: in `powerline-dark` (`ui/themes/presets.rs:647-720`) model bg (45,45,45), directory (139,69,19), git (64,64,64), usage (55,65,81), network (40,44,52); text and icon white. Plain `default` theme colours icon/text per segment with ANSI 16/256 via `ColorConfig {icon, text, background}`.
2. 8 presets (`get_available_themes`, :106-116): default, minimal, gruvbox, nord, powerline-dark, powerline-light, powerline-rose-pine, powerline-tokyo-night. Format: whole `Config` per theme with per-segment `{icon{plain, nerd_font}, colors{icon,text,background}, styles{bold...}, options}`; colour enum `AnsiColor::Color16{c16} | Color256{c256} | Rgb{r,g,b}` (`config/types.rs:61`). Users save/load theme files (`load_theme_from_file`, `save_theme`, `list_available_themes`). Fork-specific: `themes/powerline_importer.rs` converts claude-powerline colour schemes `(dir, git, model, usage, update)` bg/fg pairs into a Config with the U+E0B0 separator and Nerd Font mode (:19-40).
3. Mixed ANSI 16/256/truecolor chosen per colour in the config (`statusline.rs:329-391` writes `38;5`, `38;2`, `48;5`, `48;2`). No downsampling or NO_COLOR found in `core/statusline.rs`.
4. Both: plain mode foreground text; powerline mode background fills.
5. `style.separator`: plain mode uses white ` | ` (`\x1b[37m`, :179); if the separator equals U+E0B0 it draws powerline arrows from previous bg to current bg (`create_powerline_arrow`, :165-181); lines wrap at width by whole segment, dropping the separator at breaks (:206-223).
6. Different bg per segment per theme (hand-picked); arrows.
7. `powerline-light` preset; no detection; text colour is authored per segment, not computed.
8. `StyleMode` plain (emoji) vs nerd_font per segment icon pair (`IconConfig {plain, nerd_font}`).
9. Fork adds a network-health segment with 🟢/🟡/🔴/⚪ state emoji and a proxy prefix (`core/network/status_renderer.rs:14-85`, feature `network-monitoring`); ratatui TUI with `color_picker.rs`, `theme_selector.rs`, `icon_selector.rs`.
10. `Config` TOML, interactive TUI (colour picker, theme selector, icon selector), CLI (`cli.rs`).

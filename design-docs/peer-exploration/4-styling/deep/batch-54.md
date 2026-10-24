## mikkonumminen/claude-code-customization
https://github.com/MikkoNumminen/claude-code-customization — stars 0
Files read: `src/statusline.js`, `src/theme.js` (plus `plugins/ccbar-band/hooks/register.tsx` listed by the scanner, not read). A "ccbar" display: a 2-row title + gauge, not a segmented bar.
1. Not per segment. There are two fixed colour languages (`src/theme.js` header): a cool TITLE gradient (`TITLE_RAMP`: ice, cyan, azure, violet, magenta) laid across the project name's letters and animated, and a warm METER gradient keyed on percent REMAINING (`METER_RAMP`, theme.js: 0 red `[255,48,42]`, 12 ember, 28 orange, 48 amber, 68 lime, 84 green, 100 aqua) via `rampKeyed`. Gauge cells darken away from the edge (depth 0.62..1), a bright band drifts through them, and under 10% remaining the whole gauge pulses (`alarm`, sine 0.8 Hz). Unfilled cells `SLATE [46,62,84]`, labels `STEEL [96,132,166]`.
2. Themes: not present as a switchable feature. One hard-coded palette in `theme.js`; no user theme format.
3. Truecolor `38;2;r;g;b`, else 256-cube downsample (`fg()`, theme.js: `16 + 36*cube(r)+...`). `CAP` honours `NO_COLOR` and `TERM=dumb` (no escapes at all), and treats `TERM=*256color` without `COLORTERM`/`WT_SESSION` as non-truecolor.
4. Foreground only on the terminal background (no `48;` codes).
5. No separators; the gauge is framed in `⟨ ⟩` glyphs coloured `mix(STEEL, SLATE, 0.4)`.
6. Not applicable (one gauge); title and gauge differ by palette family (cool vs warm).
7. Contrast: not handled. Palette is dark-terminal oriented (ship-console look); no light-terminal adaptation.
8. Unicode only: `█`, eighths `▏..▉` (`EIGHTHS`, statusline.js:37), `░`, `⟨⟩`, `·`. No Nerd Font, no emoji.
9. Animation is the point: continuous time `t`, drifting gradient, gliding specular highlight (`SWEEP_PERIOD 9s`), phosphor breath (`BREATH_PERIOD 6.5s`); `pingPong` avoids seam jumps. Centres each line to the pane width.
10. No config file for colours; all constants in `theme.js`. Layout driven by a launcher that puts a top pane over Claude (`src/topbar.js`, `launch.js`); the statusline degrades to a once-per-redraw sample when no pane claims the session (`claimed(key)`).

## mikolajpochec/cws
https://github.com/mikolajpochec/cws — stars 0
Files read: `lib/statusline.sh` (a Python script despite the name), `lib/colors.sh`, `lib/theme-gen.sh`. A shell "workspace" manager whose statusline shows the workspace colour.
1. By identity: one colour per WORKSPACE, not per segment. `workspace_color()` reads the hex from the registry (`$CWS_ROOT/workspaces`, field 5) for `$CLAUDE_WORKSPACE`. It fills the workspace badge background (`ansi_bg`) and the context bar `[####------]` foreground. Threshold override: `bar_color = RED if pct >= 90` (statusline.sh). Everything else (model, dir, cost, time, 5h limit) is uncoloured, with `DIM` labels.
2. Palette `CWS_PALETTE` (colors.sh): 12 hexes (violet `#c084fc`, blue, green, orange, red, cyan, yellow, pink, teal, indigo, lime, rose). `_cws_next_color` hands out the first unused colour, then cycles by count. Separately `theme-gen.sh` generates a full Claude Code THEME JSON (`name/base/overrides`, ~40 keys) from one accent hex via HLS shifts (`shift(accent, dl=, ds=)`; `claude`, `text`, `inactive`, `userMessageBackground`, `rate_limit_fill`, etc.), with fixed success/error/warning. Users pick the accent, so effectively user-defined; no bundled named themes.
3. Truecolor only (`38;2`/`48;2`) plus ANSI `31`/`2`. No depth detection. `NO_COLOR` not honoured in the files read (scanner flagged an env hit, in shell files only).
4. Both: coloured badge (` ws `, background = workspace colour) plus fg-only text.
5. Plain text separator `  |  ` in DIM (statusline.sh `sep`). No powerline.
6. Badge background vs plain text; separators only.
7. Contrast: yes. `fg_for_bg()` picks `(20,20,20)` if luminance (0.299R+0.587G+0.114B)/255 > 0.6 else `(240,240,240)` for badge text. No light/dark adaptation otherwise.
8. ASCII bar `#`/`-`; no icons in the statusline (Nerd Font hit is from the shell prompt segment).
9. Per-workspace Claude theme generation (`theme-gen.sh`) so the whole Claude UI takes the workspace accent, including `rainbow_*` slots, is the notable idea. Prompt segment shares the same colour.
10. `$CWS_ROOT` registry file (pipe-separated), env `CLAUDE_WORKSPACE`; `cws add` CLI chooses colour. No statusline config file.

## milan44i/claude-setup
https://github.com/milan44i/claude-setup — stars 0
Files read: `scripts/statusline-command.sh` (19 lines); other scanned files are hooks, not styling.
1. One fixed colour for the model name, bold cyan `\033[1;36m` (statusline-command.sh:17); the rest of the line is uncoloured. No thresholds on the bar.
2. Not present.
3. ANSI 16 only. No detection, no `NO_COLOR`.
4. Foreground only.
5. Two spaces between model and `[bar]`.
6. Not applicable.
7. Not present.
8. `█`/`░` 20-cell bar; no icons.
9. Nothing else; the scanner's emoji/box counts come from hook scripts, not the statusline.
10. No config. Edit the script.

## millersoft-systems/claude-code-status-line
https://github.com/millersoft-systems/claude-code-status-line — stars 0
Files read: `colors.json`, `src/colors.rs`, `src/render.rs`, `src/config.rs`. Rust binary.
1. By position, in a fixed section order: cwd, git, model, context, quota_5h, quota_7d, cost. Colours alternate two schemes (`src/colors.rs`): `dark_on_orange()` for cwd, model, quota_5h, cost (bg ORANGE `(217,119,87)`, fg DARK `(38,38,36)`, details MUTED_DARK `(65,65,62)`) and `orange_on_dark()` for git, context, quota_7d (bg DARK, fg ORANGE, details MUTED_LIGHT `(130,129,122)`). So it is a fixed per-section assignment that happens to alternate; no state or threshold colouring found in the files read.
2. One theme, the Claude-orange/charcoal pair. User-definable: `~/.claude/statusline/colors.json` (`config.rs: load_theme`, written with defaults on first run). Per section `{background, foreground, details}` as `[r,g,b]`, plus a `separator` colour. Roles are per segment, not semantic.
3. Truecolor RGB only (`48;2`/`38;2`, render.rs). No depth detection or downsampling; `NO_COLOR` not found.
4. Background-filled cells with padding (`display.section_padding`), or `None` background resets with `49m`.
5. Powerline arrow `\u{E0B0}` (`config.rs: POWERLINE_ARROW`, "hardcoded, not user-configurable") when `use_powerline`; arrow fg = left section bg, arrow bg = right section bg (`make_powerline_arrow`, render.rs:63). Default is non-powerline with a configurable `segment_separator` coloured `theme.separator` (default muted gray). Last section gets a terminating arrow on bg reset.
6. Alternating two inverse schemes (dark-on-orange / orange-on-dark) plus the arrows.
7. Text on each bg is the paired `foreground` from the colour pair; nothing computed. No light/dark adaptation.
8. Emoji icons (scanner: 19), one Nerd glyph (the arrow).
9. A `details` colour per section lets a secondary part of a cell (e.g. numbers after a label) take a third, quieter colour via `get_details_and_fg_codes`.
10. `colors.json` (theme) and a config for `display.use_powerline`, `arrow`, `segment_separator`, `details_separator`, `section_padding` (`config.rs`). Docs site in `docs/script.js`.

## ming-claude/ccsl
https://github.com/ming-claude/ccsl — stars 0
Files read: `internal/style/style.go`, `internal/render/renderer.go`, `internal/render/ansi.go`, `internal/config/colorlevel.go`, `internal/config/types.go`, `themes/*.json`, `internal/segment/context_bar.go`. Go, Bubble Tea TUI configurator.
1. Theme role per segment GROUP: each theme maps ~16 group names (model, git, context, tokens, cost, usage_5hour, usage_weekly, version, session, speed, diff, activity, live, cwd, env, clock) to a colour (`themes/dracula.json`: model `#bd93f9`, git `#50fa7b`, context `#8be9fd`, cost `#f1fa8c`, usage_5hour `#ffb86c`...). Colour is fixed per group, chosen by the theme. No threshold colouring found: `context_bar.go` calls `ProgressBar` with no colour. `SegmentColor` has `positive`/`negative` (git/diff green/red) but `types.go:44` carries `TODO: wire Positive/Negative through pipeline`, so they are declared and not used.
2. Bundled: 15 theme files, eight pairs: catppuccin, cyberpunk, dracula, gruvbox, high-contrast, monochrome, nord (each `x.json` text and `x-block.json` bg-filled) plus `solarized-light-block`. Format: JSON `{variant: "block"|"non-block", separator, colors: {group: "#hex" | {fg,bg,positive,negative}}}`, embedded via `go:embed` (`themes/themes.go`). User themes: not found in the files read.
3. `colorCode()` (ansi.go) accepts named (red..white, dim), `#rrggbb` (emitted as truecolor `38;2`/`48;2`), or 0-255 index. `DetectColorLevel()` (colorlevel.go) mirrors supports-color: `FORCE_COLOR`, `NO_COLOR`, `TERM=dumb`, `COLORTERM`, TERM names (ghostty/kitty/wezterm), `256color`. It is stored at `cmd/statusline.go:199` but I found no consumer, and `colorCode` never downsamples hex.
4. Both, by variant: non-block themes are fg-only; block themes give each group `{fg, bg}` and `ColorizeBlock` pads one space each side inside the bg.
5. Plain text separator per variant: plain ` | `, nerd-font ` │ ` (`style.go: separators`), powerline style mode `""`. Block themes use separator `""`. `colorizeSep` (renderer.go:381) paints a separator with the LEFT element's bg when that element has one. Per-element `SeparatorAfter` override exists.
6. Different hue per group in the theme; block variant adds a darker tint of the same hue as bg (dracula-block model fg `#bd93f9` on bg `#3a2860`). Same-hue groups repeat (model and session share a colour).
7. Light terminal: `solarized-light-block` (bg `#eee8d5`) and `high-contrast`. No computed contrast; bg tints are hand-picked per theme.
8. Three icon sets per group (`style.go: icons`): plain ASCII (`>`, `*`, `Ctx:`), Nerd Font (md-*/fa glyphs), powerline mode uses the Nerd set. 
9. Fractional-block progress bar (`ProgressBar`, eighths). Width-aware priority dropping and smart alignment of multiple lines (`align.go`). TUI preview and theme picker (`view_themes.go`), presets (minimal, standard, full, dev), snapshot JSON for external tools.
10. Bubble Tea TUI (`cc` config), JSON presets/themes, env `FORCE_COLOR`, `NO_COLOR`. Writes settings.json statusLine via install.

## minhngoc2512/status-bar
https://github.com/minhngoc2512/status-bar — stars 0
Files read: `hooks/statusline.sh`, `README.md`. Mostly not a statusline: an Ubuntu/GNOME GTK tray indicator (Claude session state, weather, crypto, hardware) in Python (`indicator.py`, `claude_status/*`).
1. The one statusline piece, `hooks/statusline.sh`, prints `5h 12% · 7d 30%` with no colour at all; its main job is spooling the payload for the tray. The tray's own colours are not statusline styling.
2. Not present for the statusline.
3. No ANSI emitted. No `NO_COLOR` handling.
4. Not applicable (plain text).
5. Plain ` · ` between the two windows.
6. Not applicable.
7. Not present.
8. None in the statusline; tray uses emoji/spinner animation.
9. Tray spinner/blink animation (scanner: 27 motion hits) in the GTK app, outside the Claude statusline.
10. Settings window in the tray app (toggle each indicator); no statusline config.

## Miracle0x0/CCometixLine
https://github.com/Miracle0x0/CCometixLine — stars 0 (GitHub reports it as not a fork; the layout matches the upstream CCometixLine, parent unverified)
Files read: `src/ui/themes/palette.rs`, `presets.rs`, `theme_nord.rs`, `theme_default.rs`, `theme_minimal.rs`, `theme_powerline_dark.rs`, `src/core/statusline.rs`.
1. Theme role per segment id, by index: `Palette::colors(id)` (palette.rs) takes a 15-entry accent array per theme ordered Model, Effort, Agents, Directory, Git, ContextWindow, PromptCache, Usage, Cost, Session, OutputStyle, SessionName, Worktree, PullRequest, Update. e.g. Tokyo Night: model `0x7dcfff`, effort `0xbb9af7`, agents `0xffa86c`, directory `0x9ece6a`, git `0x7aa2f7`. Each segment's icon and text take its accent; background (themes that have one) is `tint(surface, accent)` = 88% surface + 12% accent per channel (palette.rs). No threshold colouring in the files read; sub-agent rows have a separate 5-role status set (`agent_status_colors`: running, completed, failed, killed, unknown).
2. 9 built-in themes (`BUILTIN_THEMES`, presets.rs): cometix, default, minimal, gruvbox, nord, powerline-dark, powerline-light, powerline-rose-pine, powerline-tokyo-night. Palette variants are Default, Minimal, Gruvbox, Nord, PowerlineDark/Light, RosePine, TokyoNight. Saved configs "never pass through this palette": each theme is materialised into a config that users edit (`SegmentConfig.colors {icon, text, background}`). User themes: yes, by saving a config; TUI configurator (ratatui).
3. `AnsiColor` enum: `Color16{c16}`, `Color256{c256}`, `Rgb{r,g,b}` (statusline.rs:200-265); 16-colour code `30+c` / `90+(c-8)`. Built-in themes are all RGB. No depth detection or `NO_COLOR` found.
4. Both: Default/Minimal/Gruvbox have `surface() = None`, so fg-only; Nord and the four powerline themes give each segment a background (surface `#2e3440`, `#171b22`, light `#fafafa`, `#191724`, `#1a1b26`).
5. Powerline arrow `U+E0B0` when `style.separator == "\u{e0b0}"` (statusline.rs:83); arrow fg = previous bg, arrow bg = current bg (`create_powerline_arrow`, line 316). Non-powerline themes use ` | ` (cometix, default, gruvbox) or ` │ ` (minimal), always painted white `\x1b[37m` (`join_with_white_separators`, line 275). Nord and the four powerline themes use the arrow.
6. Unique accent per segment id (test `every_theme_has_unique_accents...` asserts no duplicate accent in a theme); background tint differs per segment by 12% of its accent, so neighbours differ by both hue and slight bg hue.
7. Contrast is enforced by test, not at runtime: palette.rs test requires WCAG ratio >= 4.5 for every segment text on its bg (unfilled themes assume a dark terminal `0x1e1e2e`). `powerline-light` uses darker accents (`0x006479`, `0x7044a8`...) on `#fafafa`.
8. `IconConfig {plain (emoji), nerd_font}` per segment; `StyleMode::{Plain, NerdFont, Powerline}`. Emoji and Nerd glyph pairs, e.g. model `🤖`/`\u{e26d}`, git `🌿`/`\u{f02a2}`.
9. Wrap-to-width by terminal cells (`generate_with_width`, tests at exact boundaries in every theme). TUI preview (`generate_for_tui_preview`).
10. TOML/JSON config under the user's `.claude/ccline`, ratatui TUI, per-segment `options`, per-segment `styles` (bold etc.).

## miyago9267/coralline
https://github.com/miyago9267/coralline — stars 0 — FORK OF Nanako0129/coralline. Differences only.
Fork is an older snapshot (`statusline.sh` 527 lines vs parent 2640; `configure.sh` 1238 vs 1572). Same design: Powerlevel10k-style pill bar, `VL_*` variables sourced from `~/.claude/coralline.conf`, `fg()`/`bg()` take a 256 index or `"R,G,B"` (`statusline.sh:117-130`), pills with `U+E0B6`/`U+E0B4` caps and `U+E0B0` separators, bar-colour thresholds `VL_WARN_PCT=50` / `VL_HOT_PCT=75` picking `VL_FG_OK/WARN/HOT` (`pct_fg`), git bg switching `VL_BG_GIT_OK` vs `VL_BG_GIT_DIRTY`, `VL_ASCII=1` fallback, `lean` style (no bg, `VL_BG_*` becomes text accent).
Differences from parent:
- Themes: 7 `.conf` files (catppuccin-mocha, claude-coral, dracula, gruvbox-dark, mono, nord, tokyo-night) against the parent's 10 (parent adds lunar-pink, morning-haze, reverie). A theme file is just `VL_BG_*` / `VL_FG_*` assignments per segment (e.g. dracula.conf: dir cyan `139,233,253`, project pink, model purple, cost red; `VL_FG_TEXT` dark `40,42,54` on neon pills). `mono.conf` is greyscale 256 indices.
- Fork lacks the parent's `classic` style (lean text on a uniform bar via `VL_BG_BAR`), p10k import, burn-rate/glyph tests, subagent segments, float companion and PowerShell scripts.
- Fork has no `NO_COLOR`/truecolor probing either (grep: none).
- Fork keeps `tools/render-screenshots.py` and screenshot PNGs per theme in `assets/`.

## mk124/my-claude-statusline
https://github.com/mk124/my-claude-statusline — stars 0
Files read: `statusline-command.sh`, `statusline-config.json`.
1. By state/threshold, plus a few fixed: model `[name]` cyan `\033[36m`; branch magenta in dim parens; context bar green `38;5;2` (<70%), yellow `38;5;3` (70-89), red `38;5;1` (>=90); 5h and 7d usage bars green (<50), yellow (50-79), red (>=80) (`usage_bar`); `+N` green / `-N` red lines; tokens, duration uncoloured.
2. Not present.
3. ANSI 16 names (`\033[36m`) and 256-index (`38;5;N`, `48;5;N` for the pace marker). No detection; no `NO_COLOR`.
4. Foreground, except the pace marker `│` which gets a 256-colour bg tied to the bar state (`BGREEN 48;5;10`, `BYELLOW 48;5;184`, `BRED 48;5;196`, dark variants for the projected part).
5. Dim `|` between segments.
6. Separators only; sections are told apart by their own content colours.
7. Not present (uses terminal-theme-relative ANSI 1-3, and dim for empty bar cells).
8. `█ ▒ ░ │` bar glyphs, `⇡ ⇣` token arrows, `→` projection; no emoji or Nerd Font.
9. Quota bar shows projected usage at reset (`▒` cells in a darker shade of the state colour, `dcolor`: `38;5;22/94/52`) and a pace marker coloured light cyan (`LCYAN 96`) or light red (`LRED 91`) if usage is ahead of elapsed time.
10. `~/.claude/statusline-config.json`: `bar_round`, `pace_indicator`, `session_min_proj_elapsed`, `weekly_min_proj_elapsed`. No colour config.

## mkloveyy/binnacle
https://github.com/mkloveyy/binnacle — stars 0
Files read: `plugin/hooks/modules/status/palette.ts`, `segments.ts`, `plugin/hooks/modules/ui/theme.ts`. A Claude Code mod (plugin hooks + `register.tsx`); its status band draws grouped spans.
1. Mixed. Fixed per group (`COLOR` in segments.ts:10): model green, effort magenta, context info blue, time yellow, cost green, cwd dim. By threshold: context `toneColor` (>=90 red, >=80 yellow, else base blue); limits `limitColor` in four bands (<50 `success`, 50-79 `suggestion`, 80-89 `warning`, >=90 `error`), commented "user, 2026-10-12". The context bar is split by CATEGORY, each category a fixed palette colour: `PALETTE` of 8 hexes (`#7aa2f7`, `#7dcfff`, `#bb9af7`, `#9ece6a`, `#e0af68`, `#f7768e`, `#73daca`, `#ff9e64`), messages `#d97757`, free/buffer gray.
2. No bundled themes. It uses the host's theme: `ROLE` map in ui/theme.ts: text, `inactive` (dim), `subtle` (frame), `claude` (brand), `suggestion` (focus), `success`/`warning`/`error`, `permission`, `diffAdded`/`diffRemoved`, so light/dark is the host's job. Header: "Colour says state, never identity" (theme.ts). The category bar is the exception (its own hex palette).
3. Names are Claude Code `ThemeKey`s or ANSI-like names (`green`, `yellow`, `gray`) or `#hex`; depth is the host's. No `NO_COLOR` code.
4. Foreground (`Span.color`, `dim`, `bold`); empty bar cells in `subtle`.
5. Spans separated by a dim ` · ` (`MID`). No powerline.
6. Not by colour; groups differ by their fixed colour, with width-priority forms that drop groups (`priority`, `forms`) when narrow.
7. Delegated to the host theme via semantic roles (the stated design rule).
8. Unicode glyph table `SYM` (● ✓ ✗ ⏸ ◆ ○ ▸ ▾ ⟳ ⇣), `█ ░ ─` bars. No Nerd Font.
9. A `/binnacle` overview with legend, two-column legend layout, press-to-open model/effort pickers (`Span.press`).
10. Settings object `BinnacleSettings.status` toggles per group (model, effort, context, limits, duration, cost, cwd); colours not configurable.

## MLKyu/mlk-kit
https://github.com/MLKyu/mlk-kit — stars 0
Files read: `engine/compose-statusline.sh`, `engine/apply-style.sh`, `modules/statusline/*.sh`.
1. Modular: each statusline module owns its colour, mostly by threshold. context-gauge: 8-cell `▓/░` bar driven by session COST (not context %) with colour by bars lit, <=3 bright green `92`, <=5 bright yellow `93`, <=7 yellow `33`, 8 bright red `91`; `exceeds_200k_tokens` makes a red `▓▓▓▓▓▓▓▓!!`. cost-tracker tiers by dollars: <$1 green `92`, $1+ yellow `93`, $10+ magenta `95`, $30+ red `91`. git-status: clean green `92`, dirty yellow `93`. session-timer: <1m gray `90`, then green `92`, yellow `93`, red `91` with break nudge. pomodoro red `91` work / cyan `96` break. work-mode: code yellow `93`, debug red `91`, review cyan `96`, explore magenta `95`. vibes: colour by hour of day (6-8 yellow, 9-11 `33`, 12-13 `95`, ..., night gray `90`). focus-topic cyan `96`. mini-pet: stressed `91`, tired `93`, working `96`.
2. No theme system. A "bundle" JSON (`bundles/<id>.json`, e.g. one named night-owl in scanner output; not read) selects which modules are active; it carries no colours.
3. ANSI 16 bright codes (`\033[9Xm`). No detection, no `NO_COLOR`.
4. Foreground only.
5. Module outputs are joined by `\033[90m │ \033[0m` (compose-statusline.sh:15), overridable by `MLK_STATUSLINE_SEPARATOR`.
6. Separator only plus each module's own colour.
7. Not present; bright ANSI codes defer to the terminal's palette.
8. Emoji in most modules (🌿 💵 🍅 ☕ 🎯 ⏱, time-of-day icons).
9. Output-style markdown composition (`apply-style.sh`) beside the statusline; `--undo` backups.
10. `~/.claude/mlk-style-kit/active.json` chooses modules and order; `apply-style.sh --bundle|--statusline`. Modules are plain scripts, easy to add.

## mlosavio/CodeAgentMonitor
https://github.com/mlosavio/CodeAgentMonitor — stars 0
Files read: `statusline/cam-statusline.js`, `install_statusline.py`. A cost/usage monitor (Python GUI + CLI) with a small statusline script.
1. One conditional colour. The 5h-limit segment: dim `\x1b[2m` normally, orange `38;5;208` at `limit_warn_pct` (default 75), red `31` at `limit_critical_pct` (default 90) (cam-statusline.js:593-596; defaults line 112). The cost/duration segment is uncoloured.
2. Not present for the statusline (the GUI has its own palette; hex-heavy, not read).
3. ANSI 31, 256 index 208, dim. No detection and no `NO_COLOR` in the statusline file.
4. Foreground.
5. Dim ` │ ` (`SEP`, line 80) between a wrapped existing statusline and its own segment; ` · ` between its own parts (`separator` option).
6. Not applicable.
7. Not present.
8. None (text, `~` for stale).
9. It can WRAP a user's existing statusline command (`wrap_command`, `CAM_SL_WRAP`) and append its segment, so styling of the wrapped output is preserved.
10. Options under pricing JSON (`slOptions`): `separator`, `limit_warn_pct`, `limit_critical_pct`, `show_limits`; env `CAM_SL_DISABLE`, `CAM_SL_WRAP`, `CAM_SL_DEBUG`.

## mmin-sportradar/claude-usage-monitor
https://github.com/mmin-sportradar/claude-usage-monitor — stars 0
Files read: `statusline-usage.sh` (embedded Python), `install-statusline.sh`; browser-extension JS listed by the scanner not read.
1. By threshold plus two fixed. `color(p)` (statusline-usage.sh:30): red `38;5;203` at `p >= th` (default 80, env `CLAUDE_USAGE_THRESHOLD`), orange `38;5;214` from `th-15`, green `38;5;114` below; applied to both the 5h and 7d segment (label, bar, percent, with `⚠ ` prefix over threshold). Fixed: separator/countdown `DIM 38;5;245`, bolt `BRAND 38;5;209` (coral), daily-spend `MONEY 38;5;150`.
2. Not present.
3. 256-index only (`38;5;N`). No detection, no `NO_COLOR`.
4. Foreground.
5. Dim `·` between a segment and its countdown; space between segments.
6. Not applicable.
7. Not present.
8. `▉`/`░` 8-cell bar, `⚠`, bolt glyph; no Nerd Font.
9. Shares its threshold with the companion browser extension. Sums today's cost across all sessions from transcripts.
10. Env var `CLAUDE_USAGE_THRESHOLD` only.

## mohnoor94/nova-ccline
https://github.com/mohnoor94/nova-ccline — stars 0
Files read: `packages/core/src/index.js`, `defaults.js`, `config.js`, `pack-loader.js`.
1. Mixed fixed and state, 256-colour. Fixed: model/branch/dir `dim` (`38;5;248`), task bold. State: context percent uses 5 tier colours `TIER_COLORS` (`38;5;34` green, `220` yellow, `208` orange, `167` red, bold `167`) via `contextTier(usedPct)`; effort has its own ladder (`index.js:186-191`: auto italic gray, low dim, medium `248`, high `220`, xhigh `208`, max bold `205`); cost green `32` under $1 else yellow `33`; session timer by minutes (<15 dim, <30 green `32`, <60 yellow `33`, <90 `208`, else red `31`); +lines green, -lines red; PR badge red/yellow.
2. None bundled. `theme: 'auto'|'light'|'dark'` is declared in `defaults.js:26` but no code reads it in `index.js` (grep: no use), so it is inert. A content "pack" (`@bynoor/nova-ccline-pack-default`) supplies line-3 comments, not colours.
3. ANSI 16 and 256-index. No detection, no `NO_COLOR`.
4. Foreground only.
5. Dim `·` and spacing. No powerline.
6. By content colour only.
7. Not functional: the `theme` option is not consumed.
8. Emoji (✨, time-of-day icons, 💀 at >=80%), `▰/▱` 15-dot context trail.
9. The user's name renders as a per-letter 4-colour cycle `[223,217,211,205]` (pink-peach gradient, index.js:499); a context-percent "comment" line changes style with tier (italic dim to bold red).
10. Config file merged over `defaults.js` (`widgets` toggles, `layout: full|compact|minimal`, `currency`, `timeFormat`, `workSchedule`); `nova-ccline-init` installer.

## mohsenabedelaal/claude-toolbox
https://github.com/mohsenabedelaal/claude-toolbox — stars 0
File read: `.claude/statusline.sh` (145 lines).
1. Fixed for model (cyan `36`) and branch (cyan `⎇`); thresholds elsewhere: context bar green <50, yellow >=50, red >=80 (`make_bar`, lines 22-24); cost green <$1, yellow >=$1, red >=$5 (`COST_COLOR`); git `+staged` green, `~modified` yellow.
2. Not present.
3. ANSI 16 (`32`, `33`, `91`, `36`). No detection, no `NO_COLOR`.
4. Foreground.
5. Plain ` | ` uncoloured.
6. Separator only.
7. Not present.
8. `█/░` 8-cell bar, `⎇`, `↺`; no emoji.
9. Reads OAuth credentials to fetch usage (5h and 7d labels), nothing styling-specific.
10. Edit the script.

## moneymikemd/session-band
https://github.com/moneymikeMD/session-band — stars 0
Files read: `hooks/register.tsx`, `hooks/where.ts`. A Claude Code mod drawing a one-line band above the prompt, not a statusline.
1. Fixed per field, by host theme role: label `dimColor`; computer `suggestion`, workspace `warning`, project `success`; an optional herdr badge `inverse` on `claude` (register.tsx:76-86).
2. Host theme keys only (`suggestion`, `warning`, `success`, `claude`); no bundled themes.
3. Delegated to the host (Ink `<Text color>` theme keys).
4. Foreground, plus one inverse (reverse-video) badge.
5. Two spaces between fields.
6. Different role colours per field.
7. Host handles light/dark via theme keys.
8. None.
9. Surfaces where the session runs (computer / workspace / project) for multi-host use.
10. None.

## Moonkeemoo/claude-sidebar
https://github.com/Moonkeemoo/claude-sidebar — stars 0
not a Claude statusline: a Node.js session-list sidebar TUI (`sidebar.js`) run in a split terminal pane (mouse, heat-map charts, `sgr()` colours at sidebar.js:35).

## moukrea/agentline
https://github.com/moukrea/agentline — stars 0
Files read: `claude/statusline.sh` (869 lines), `lib/wizard.sh`, `bin/agentline`.
1. Mostly fixed per fact plus gradient/thresholds. Role palette (statusline.sh:233-262, dark): ORANGE `215;119;87` (Claude's spinner colour; `PATH_COLOR` default for the directory), CYAN git branch/stash/pinned, VIOLET worktree, ahead/behind, agent `@name`, automodel flash; GREEN/YELLOW/RED for `pct_color` (>=70 red, >=40 yellow, else green); LABEL gray for labels (`ctx`, `5h`, `edits`); TEXT for cost; ICE for cold cache; ORANGE hot cache. Gauges use a continuous "heat" gradient green->yellow->red along the bar, per cell by position (`grad()`, lines 197-205; `cell_colour heat`). Effort has a 5-step colour list (`EFFORT_RGB`).
2. Two palettes only, `AGENTLINE_THEME=dark|light`: dark is for dark terminals, light uses darker inks (`ORANGE 195;95;55`, `CYAN 0;110;190`, `GREEN 20;140;60`, ...) and a different `grad()` and `TRACK`. Not user-extensible except `PATH_COLOR` (an `R;G;B` string).
3. Truecolor only (`38;2;r;g;b`, `48;2` for the rail). No depth detection, no `NO_COLOR`.
4. Mostly foreground; background used for the smooth-bar RAIL (`38;42;46` dark / `226;228;232` light) behind partial blocks.
5. No visible separator; segments joined by two spaces (`GAP`, line 792), laid out as left block ... right block, right-aligned across rows. The capsule bar draws rounded caps `U+E0B6`/`U+E0B4` coloured like the adjacent cell (`gauge`, capsule branch).
6. By content colour and the two-space gap; no alternating shades.
7. Yes, explicit: `THEME=light|dark` selects ink sets "against the terminal's background" (line 93, wizard row). Not auto-detected.
8. `GLYPHS=nerd|unicode` (line 90); Octicons / MDI Nerd glyphs with `ICON_GAP`, Starship-style ASCII-ish fallbacks (`+ ! ? = $ ↑ ↓ ✓`); 12 gauge styles (capsule, smooth, blocks, line, segments, braille, ramp, dots, bars, squares, pie, none); emoji for cache (🔥 ⏳ 🧊).
9. Animation: `ULTRA_EFFECT=violet|rainbow|plain` (`shimmer()` rainbow 18 degrees per character, drifting 15 degrees per second; `violet()` highlight sweep 3 chars/s) driven by a frame counter at 1 fps; automodel routing display; terminal-width degradation per segment (`put seg level text`); site build and demo recording in repo.
10. Config file `~/.config/agentline/config` (sourced bash), `AGENTLINE_*` env vars override, interactive wizard `lib/wizard.sh` (`GLYPHS BAR COMPACT_STYLE EFFORT_STYLE ULTRA_EFFECT BRANCH_ICON RESET_ICON THEME AUTOMODEL`), `SEGMENTS` list and `LAYOUT` string.

## mrjk05/modemon
https://github.com/mrjk05/modemon — stars 0
Files read: `README.md`, `mods/project-color/*`, `mods/context-bar/*`. A marketplace of ten Claude Code mods; the styling-relevant two are below.
1. project-color: colour by IDENTITY. `autoSwatch(project)` = `PALETTE[fnv1a(projectName) % 12]` (hooks/lib.ts), same repo same colour on every machine; a `/color` pin overrides. Draws a full-width stripe above the prompt and a coloured circle emoji in the status line. context-bar: by zone, `zoneColor(percent)` = `success` <50, `warning` <80, `error` (lib.ts:72); bar segments take `/context`'s category colours, free space `inactive`, used `claude`.
2. project-color palette (lib.ts `ENTRIES`): 12 named mid-tones (purple `#8B5CF6`, blue `#3B82F6`, teal `#0D9488`, green `#22C55E`, lime, yellow `#EAB308`, amber `#B45309`, orange `#F97316`, red `#DC2626`, pink `#EC4899`, magenta `#C026D3`, slate `#64748B`), each paired with an emoji. Users may pin any `#hex` (`/color #RRGGBB`). context-bar uses host theme keys.
3. Hex for project-color (README: "In a terminal without truecolor support, hex colours are approximated" by the host); host theme keys elsewhere.
4. project-color: solid background stripe; context-bar: coloured glyph cells.
5. Not applicable (band, not segments).
6. Not applicable.
7. Contrast computed: `textOn(hex)` picks black or white by WCAG contrast (`contrast()`, lib.ts), guaranteeing >= 4.5:1; palette "chosen to stand out on both dark and light terminal themes".
8. Colour-circle emoji for the status entry (only 9 circles so several colours share one; noted in README Limitations), block glyphs `█ ░ ▒ ┃ ╎`.
9. 50% ACTIVE/PASSIVE divider, auto-compact mark, mobile fallback to emoji status line.
10. Mod config in `/config` (`stripe`, `thickness`, `branch`, `statusLine`); `/color` command.

## MrMichou/claude-status-bar-awesomewm
https://github.com/MrMichou/claude-status-bar-awesomewm — stars 0
not a Claude statusline: an AwesomeWM wibar widget (Lua, `init.lua`) showing animated Claude state frames; brand tint `#d97757`, amber `#f2bb2e` permission dot, red `#e5484d` service-down dot (init.lua:27-29).

## mstuart/ai-statusline
https://github.com/mstuart/ai-statusline — stars 0
Files read: `src/themes/mod.rs`, `src/render/mod.rs`, `src/layout/mod.rs`, `README.md`. Rust, ratatui TUI configurator; it targets several AI assistants.
1. A theme ROLE per widget type (`role_for_widget`, themes/mod.rs): model->`model`, context -> `context_ok` (hint switches to `context_warn`/`context_critical`), git-branch/worktree -> `git_branch`, git-status -> `git_clean`/`git_dirty`, cost and block-timer -> `cost`, durations -> `duration`, separator -> `separator_fg`. Precedence for foreground (layout/mod.rs:81): explicit widget `color` > widget `color_hint` (dynamic, e.g. context %) > theme role > none. 10 roles per theme.
2. 11 bundled (`Theme::list`): default, solarized, nord, dracula, gruvbox, monokai, light, high-contrast, one-dark, tokyo-night, catppuccin. Format: a role map of 10 names, foreground only (e.g. dracula: model `#8be9fd`, context_ok `#50fa7b`, git_branch `#bd93f9`). Default theme uses ANSI names (`cyan`, `green`, `brightBlack`). User-defined themes: not found; per-widget `color` and `background_color` override in TOML.
3. `Renderer::detect` (render/mod.rs:23-48): `NO_COLOR` -> none; `COLORTERM` truecolor/24bit; `TERM` contains `256color`; else 16. `--color-level none|16|256|truecolor` override. Hex downsampled to 256 by `rgb_to_256`. Names, hex and 0-255 indices accepted (`parse_color`).
4. Both: fg-only by default; `background_color` per widget for powerline.
5. Powerline mode (`[powerline] enabled, separator "", start_cap, end_cap, auto_align`) with reverse arrow `\u{E0B2}` for right-aligned flex content; arrow fg = previous widget bg, arrow bg = this widget bg (layout/mod.rs:371+); backgrounds default to `black` when a widget sets none, so theme roles do not give powerline backgrounds. Non-powerline: `default_separator` (` | `) coloured by `separator_fg`, with `inherit_separator_colors`.
6. Separators and role hues; powerline adjacency needs explicit `background_color` per widget.
7. `light` theme (e.g. model `#0550ae`, context_ok `#116329`); `high-contrast`. No computed contrast.
8. Powerline glyphs; widget `raw_value` compact mode; OSC 8 links (`osc8_link`).
9. `preset powerline` command, flex separators, fish-style path, burn-rate; license/server code (paid tier) unrelated to styling.
10. TOML config (`theme`, `[[lines]]` widgets with `color`, `background_color`, `bold`, `padding`, `merge_next`, `metadata`), TUI tabs (Widgets, Theme, Powerline, Layout, Preview), CLI `theme list|set`, `--color-level`.

## mtrense/mx_status
https://github.com/mtrense/mx_status — stars 0
Files read: `src/theme.rs`, `README.md`, `docs/config-examples/no-color-ascii.toml`.
1. By state (three severity roles) plus a positional emphasis ramp. Widgets recolour by zone: `Palette {nominal green, elevated orange(208), critical red}` (theme.rs:103-121 and defaults); context_saturation shows colour dot -> percentage -> bar as the zone rises (README line 97); `plan` colours each rate-limit window by a pace ratio R = budget_left_fraction / time_left_fraction (R >= 1 green, below yellow/red); git dot green when clean; `pr` coloured by `review_state`; vim by mode. Separately the EMPHASIS RAMP: five greys `#ffffff, #bcbcbc, #8a8a8a, #585858, #3a3a3a` (brightest to dimmest, `default_emphasis_grades`) paints the first-to-last parts of ONE value (duration `2d23h45m` most-significant brightest; project path basename brightest; model leading token; `$14.42` dollars vs cents); "Severity always wins". This is positional gradation inside a value, not across segments.
2. One theme, user-editable: `[theme]` `colors`, `glyphs`, `[theme.palette]` `nominal`/`elevated`/`critical`, `[theme.palette.emphasis] enabled, grades[]`. Semantic roles, not per-segment colours. No bundled named themes.
3. `Color` = named (black..white + orange, mapped to 256-index), `#rrggbb` truecolor, or 0-255 (theme.rs:22-100). No depth detection ("output is captured by Claude Code, not a terminal"). `NO_COLOR` honoured (any value, even empty) and applied LAST so it overrides config `colors = true`; it never touches glyphs.
4. Foreground only; every paint ends `\x1b[0m`.
5. Configurable `[statusline] separator`, `prefix`, `suffix`; no powerline in the files read.
6. Hierarchy by emphasis grade within values; widgets themselves are shown only when notable, so adjacency is by content.
7. Not present beyond user-set palette strings.
8. Every Nerd Font glyph has an ASCII fallback; `[theme] glyphs = false` (the `no-color-ascii.toml` example); width-aware ladders degrade to a coloured dot.
9. Width ladders (full bar -> % -> dot -> dropped), `--debug` report, OSC 8 PR links, model alias ladders.
10. TOML config (`[theme]`, `[statusline]` layout, per-widget tables), `NO_COLOR`, `MX_STATUS_DEBUG`; many example configs under `docs/config-examples/`.

## mturley/agent-handler
https://github.com/mturley/agent-handler — stars 0
Files read: `cmd/statusline.go`, `hooks/statusline.sh`, `ui/src/utils/eventColors.ts` (web UI Tailwind, not statusline). A Go multi-session coordinator ("handler") whose `handler statusline` prints a multi-line status.
1. Fixed per role, ANSI 16 plus one truecolor (statusline.go:29-47): model name Claude orange `38;2;218;119;86`; `usageBar(pct)` colour by threshold, green <50, yellow >=50, red >=80 (shared by context and rate-limit bars, lines 660-680); git branch bold white, `rebasing` yellow, ahead `↑N` green, additions green / deletions red, dirty `N modified` yellow; session-attention lines coloured by kind (awaiting approval bold yellow, unread cyan, reminders purple); Vertex AI marker light red; hints purple/dim.
2. Not present.
3. ANSI 16 names plus one truecolor const. No detection and no `NO_COLOR`.
4. Foreground.
5. Dim `·` and `↳` continuation markers; no powerline.
6. Not applicable beyond content colour.
7. Not present.
8. `▓/░` bars, `↑ ↳ ⚠ ⠀` (braille blank used as a spacer line).
9. Multi-line output: model/context/cost line, rate-limit line, git line, then other-session lists (awaiting approval, unread, reminders).
10. Go code constants; no statusline colour config.

## muchiny/claude-mods
https://github.com/muchiny/claude-mods — stars 0
Files read: `mode-clair/hooks/colors.ts`, `README.md`. A Claude Code mod ("mode-clair") adding a coloured pipeline band for Superpowers/ultracode/bridge-mcp steps and a status entry; mostly not a classic statusline.
1. By identity, in order of appearance: `PALETTE` of 8 hexes (`#007fff` azure, `#ff7f4c` salmon, `#d74cff` violet, `#7fafd7`, `#afafff`, `#7f7fd7`, `#00d77f`, `#7fd700`) assigned to "machines" (bridge-mcp servers) by `colorOf(index)` (colors.ts:44), cycling modulo 8. Status states use host theme keys.
2. Single fixed palette; no user themes found.
3. Hex values, each tuned so the 256-colour quantisation (`quantize256`) lands on a chosen palette entry (comments give the 256 index per colour); the mod assumes a 256-colour terminal ("spec §10"). No `NO_COLOR` handling found.
4. Not read in detail (band cells).
5. Not read.
6. Hue distance >30 degrees from the theme's state colours (`THEME_STATE_COLORS`), deltaE >= 25 from text and grey, pair deltaE >= 14.32, also under deuteranopia; first machines get the most distinct colours; the two greens come last because they are closest to the theme's success green.
7. WCAG contrast >= 4.56 against the theme bg `#2a0e2e` and `#0c0c0c`, verified by tests (`contrast`, `deltaE`, `deuteranopia` helpers). Dark-theme only.
8. Unicode/emoji not examined.
9. The palette is generated and verified by a procedure (hue, deltaE, deuteranopia, 256-colour quantisation) rather than by eye; a pty "paint" test bench checks real on-screen colours.
10. None for colours.

## mutton-dev/claude-pet
https://github.com/mutton-dev/claude-pet — stars 0
not a Claude statusline in the usual sense: a 3-line Tamagotchi-style virtual pet drawn in the status bar (`src/renderer.ts`); the only colouring is one ANSI-16 bright colour per species (`src/species.ts`: dragon `91`, slime `94`, golem `93`, phoenix `97`, fairy `92`, mecha `96`, ghost `95`, cat `33`) and a sparkle `93` for the highest evolution.

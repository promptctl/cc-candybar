## yuichinagao/claude-code-statusline
https://github.com/YuichiNAGAO/claude-code-statusline — stars 0
1. Fixed per segment for identity, threshold for usage. `index.js:86-115` `COLOR` table: repo 38;5;80 cyan, branch 177 magenta, model 180 gold, PR 75 blue, worktree 245 grey, dirty 214 amber, added 114 green, removed 203 red, draft 214 / ready 114. Usage (context bar, 5h/7d limits) goes through `percentColor` (`:145-149`): <70 `ok`=246 grey (same as muted, "normal state does not speak"), >=70 warn 214, >=90 crit 203 (`:119-122`). Header comment (`:80-82`): only identifiers get soft colour, numbers go grey, strong colour is saved for things that need attention.
2. Themes: not present. One hardcoded table.
3. Colour spec: 256-index only (`38;5;N`). `USE_COLOR = !NO_COLOR && STATUSLINE_NO_COLOR !== "1"` (`:83-84`). No depth detection.
4. Fill: foreground-only.
5. Separators: plain text ` | ` in 242 grey (`:774`, `COLOR.separator`; comment `:112-114` says 242 is chosen to survive Claude Code's own dim).
6. Neighbours: different hue per identifier (cyan/magenta/gold/blue) plus grey separators.
7. Light/dark: not present (the grey 242/246 are picked for dark terminals; comment mentions Claude Code's dim only).
8. Glyphs: bar `▰▱` (`:128-129`), review badges `✓ ✗ ◦`, OSC 8 hyperlinks for PR (`:550`). No Nerd Font.
9. Other: `tools/preview.js` renders fixtures with and without `NO_COLOR` for checking. Context bar is 8 cells so warn zones look different (`:124-127`).
10. Customisation: env vars only (`STATUSLINE_NO_COLOR`, TTL vars, `--help` at `:700`); colours not configurable.

## zach-highley/claude-usage-bar
https://github.com/zach-highley/claude-usage-bar — stars 0
1. By state/threshold plus fixed accents. `statusline.sh:85-87` `pressure(v)`: 108 (green) below 60, 179 (amber) from 60, 167 (red) from 85; used for context % (`:112`) and 5h/7d (`:152`). Burn-rate marker `:157-159`: >1.05x `▲` 167, <0.95x `▼` 108, else `=` 245. Fixed: leading glyph 173 (orange, `:106`), folder 109 (`:108`), link 110 (`:132`). Active account `●` bold, other accounts dim (`:173-175`).
2. Themes: not present.
3. Colour spec: 256-index (`38;5;N`) plus SGR 1/2/3. No detection, no NO_COLOR handling found.
4. Fill: foreground-only.
5. Separators: not present as a styled element (spaces).
6. Neighbours: different fixed hues (orange glyph, blue-grey folder) and state colours on numbers.
7. Light/dark: not present.
8. Glyphs: a rotating glyph `✳✶✻✽` advancing per render as a liveness signal (`:91`, `bump(".glyph")`); `▲▼=` for rate.
9. Other: dim+italic quote line (`:131`); hostname prefix dim (`:52`).
10. Customisation: env vars `CUB_CACHE`, `CUB_HOST` (header `:22-26`); no colour options.

## zainokta/zstack
https://github.com/zainokta/zstack — stars 0
not a Claude statusline: an agent-team orchestrator plugin (manager agent, mods under `mods/`). Its `mods/usage-meter/hooks/register.ts` calls `$.ui.status(usageLine(...))` with plain text `ctx 12% 24k/200k · 5h 40%` and no colour (`:11-17`); `zstack-pane/hooks/register.tsx` is an Ink pane using `<Text color="red">`/`"yellow"`/`dimColor` (`:263, :290`). The "catppuccin" hit is not a theme in these files.

## zehuac2/status-line
https://github.com/zehuac2/status-line — stars 0
1. By role, then state of the vim mode. `theme.go:12-48`: semantic struct `Text` (cwd, git brackets, ctx bar, cost) #8f8a80, `TextDim` (duration, 7d bar, mode label) #6f6b62, `Primary` (branch, model, 5h bar, reset) #d97757 (Claude orange), `Divider` #6f6b62. Per vim mode accent: normal #d97757, insert #69c27e, visual/visual-line #9792ec, replace #e36b65. `render.go:50-91` applies `Primary`/`Text`/`TextDim` per row; usage bars are not threshold-coloured (same style, partial cell drawn `Faint`, `components/bar.go:14-45`).
2. Themes: one built-in (`claudeTheme()`), the struct is designed to be swapped ("a different *theme", `theme.go:9-10`) but no selector. Not user-definable without code.
3. Colour spec: hex via lipgloss v2 (`charm.land/lipgloss/v2`), which handles downsampling; no NO_COLOR code in repo files read.
4. Fill: foreground-only, bold.
5. Separators: horizontal rule `─` in `Divider` colour between mode row and identity row; boxed rows (`components/box.go`, `row.go`).
6. Neighbours: role colours (Primary vs Text vs TextDim) and bold; no hue cycle.
7. Light/dark: not present.
8. Glyphs: `█░` bars with faint partial cell instead of eighth-blocks (fonts draw hairline gaps, `bar.go:10-13`), `✦ ▲▼ ↺`, box-drawing. No Nerd Font.
9. Other: multi-row layout with aligned label column.
10. Customisation: Go code only; no config file found.

## zenonix-studio/agent-rail
https://github.com/Zenonix-Studio/agent-rail — stars 0
1. By pipeline stage. `bin/agent-rail-statusline.mjs:9-13` `STAGE_RGB`: plan [180,154,242], analyse [127,168,240], dev [217,119,87] (Claude accent), fix [236,116,108], review [76,194,182]. Head `● <stage>` takes the stage colour; done `32` green, waiting `33` yellow, error `31` red (`:42-46`); everything after the label is `dim` (SGR 2, `:57`). The same palette exists in the macOS menubar app (`menubar/AgentRail/Views/Theme.swift`, not read).
2. Themes: one palette; "the menubar's dark-mode hues" (`:9`). Not user-definable.
3. Colour spec: truecolor `38;2;r;g;b` plus basic SGR; `NO_COLOR` honoured (`:11`). No depth detection.
4. Fill: foreground-only.
5. Separators: dim ` · ` (`:57`).
6. Neighbours: first field plain, rest dim; stage-coloured head.
7. Light/dark: not present in the statusline (palette is dark-mode hues).
8. Glyphs: `● ✓ ✗` plus emoji elsewhere; `core/render-ascii.mjs` draws stage bars/pills (not read in depth).
9. Other: the same data drives a rail view, a menubar app and a statusline, so the stage colour is shared across surfaces.
10. Customisation: none for colour; settings snippet in header comment.

## zenzenzen/watch-my-token-burn
https://github.com/zenzenzen/watch-my-token-burn — stars 0
1. By provider. `src/inline.js:5-8` `THEME = { claude: {brand:205, accent:39, soft:221, ok:49, dim:245}, codex: {brand:39, accent:81, soft:221, ok:49, dim:245} }`; `inline.js:99` `palette = THEME[snapshot.provider] || THEME.codex`. Role names (brand/accent/soft/ok/dim) are mapped to 256 indexes; which role each field wears was not traced.
2. Themes: two provider palettes as role maps; no user themes (config file `~/.config/token-gauge/config.json` is runtime defaults, README).
3. Colour spec: 256-index via `fg256`/`bg256` helpers (`:9-15`); `stripAnsi` for width; plain format option (`inline.js:154`, `format === 'plain' || !ansi`). NO_COLOR not seen.
4. Fill: both helpers exist (`bg256`); usage of bg not traced.
5. Separators: not traced.
6. Neighbours: not traced (unverified beyond palette).
7. Light/dark: not present.
8. Glyphs: not traced. It is mainly a fullscreen dashboard / MCP server; the inline renderer is its statusline mode.
9. Other: fullscreen TUI (`src/ui.js`, not read), JSON output.
10. Customisation: `~/.config/token-gauge/config.json`, CLI flags override.

## zeroblack/vibeline
https://github.com/zeroblack/vibeline — stars 0
1. Fixed per segment plus thresholds. `statusline.sh:31-35` palette (bright ANSI 16): model cyan `96` (`:392`), folder blue `94` (`:396`), git branch magenta `95` (`:398`), elapsed `36` muted (`:428`), clock `90` grey (`:434`). Thresholds: cost green <$1, yellow >=1, orange(33) >=5, red >=10 (`:213-216`); usage dots green/yellow/orange/red at 50/75/90 (`:254-259`); context green/yellow/red at 60/80 with matching 🟢🟡🔴 (`:373-377`); status incidents by impact red/orange/yellow (`:338-341`); todos green when done, yellow when in progress, orange otherwise (`:409-411`).
2. Themes: not present.
3. Colour spec: ANSI 16 only (`\033[9Xm`). No detection, no NO_COLOR.
4. Fill: foreground-only.
5. Separators: not styled; segments joined with spacing.
6. Neighbours: distinct hues per segment, each with a leading emoji.
7. Light/dark: not present.
8. Glyphs: emoji-heavy (54 hits): model icon by family 🧠 opus / 🎵 sonnet / 🍃 haiku (`:107-111`), 🏠📁🌿💰🎯, session-age icons 💀☠️👻 (`:100`). Dots bar via `build_dots`.
9. Other: per-model emoji instead of per-model colour; `demo/loop.sh` for screenshots.
10. Customisation: env vars `CCSL_SHOW_*` toggles per segment (cost, todos, context, usage, clock, elapsed, status...), `CCSL_PLAN`, TTLs; no colour options.

## zerofaultlabs/claude-statusline
https://github.com/zerofaultlabs/claude-statusline — stars 0
1. Mixed: fixed per segment (theme-defined), threshold/step for growth and cost. `statusline-command.sh:50-79` each theme sets `C_REPO C_BRANCH C_MODEL C_ADD C_REM C_COST C_TOK C_LABEL C_DIM` plus `T_GROW` (8 steps light to heavy), `T_OFF`, `T_INK`, `T_INSET`, `T_HIT`. Example ember: repo 216, branch 180, model 222, add 150, rem 203, cost 215. The context-growth pill steps through `T_GROW` as tokens grow (`:337`); API cost pill steps through the same 8 colours at `COST_STEPS="5 25 50 100 200 500 1000 2500"` cents (`:21, :481-484`); cache hit colour by >=80 / >=50 / below via `T_HIT` (`:342`). Effort uses the theme's secondary range green to red (`:382-388`). Usage bars (`statusline-ctxbar.py`) are a value-locked HSL gradient: per-theme stops `(percent, hue, sat, light)`, hue interpolated along the shortest arc (`:12-28`), half-cell colour samples, "head bloom".
2. Themes: 7 bundled, `sorbet` (default), `ember`, `sunset`, `ocean`, `forest`, `grape`, `mono` (`:6, :28`). Format: per-theme variables for segments plus a ramp, not semantic roles. Users choose via config; no user-defined theme without editing the script.
3. Colour spec: 256-index mostly (`c256`), some truecolor (sorbet model `38;2;45;251;251`, `:78`; ctxbar uses `38;2`), a few ANSI 16. No NO_COLOR/depth detection seen.
4. Fill: both. `PILLS=true` fills every segment as a rounded pill with background (`pill()` `:224-226`: fg colour + left cap, bg colour + ink text, right cap); default is foreground-only text with ` | ` separators.
5. Separators: default `SEP=" | "` in DIM (`:86`); in pill mode a single space (`:87`). Caps `LCAP=U+E0B6`, `RCAP=U+E0B4` (rounded Nerd Font, `:88`). No powerline arrows.
6. Neighbours: in default mode different hues plus ` | `; in pill mode pills separated by space, each a different fill.
7. Light/dark: yes. `STATUSLINE_BG=dark|light` (`:8`); light overrides all text colours to darker (25/30/240/28/124...) and `T_INSET=254`, `T_HIT=(28 130 160)`, effort colours darker (`:80-85, :388`); the ctxbar gets `--bg` and switches track to pale and bloom to darken (`statusline-ctxbar.py:30-31`). `T_INK=234` is the fixed dark text on every pill.
8. Glyphs: Nerd Font caps and bolt `U+F0E7`; box-drawing bar caps; `docs/` has theme screenshots (`theme-colors.png`, `themes-pills-on.png`, `themes-pills-off.png`).
9. Other: gradient bars with bloom on the head; "pill within a pill" insets (`CTX_PILL`, `LIMIT_PILL`); layouts compact/wrap/full that drop low-priority segments to fit width (`:7, :397`).
10. Customisation: config file `~/.claude/statusline.conf` (or `STATUSLINE_CONF`), keys `STATUSLINE_THEME`, `STATUSLINE_LAYOUT`, `STATUSLINE_BG`, `STATUSLINE_MARGIN`, `PILLS`, `CTX_PILL`, `LIMIT_PILL`, `BILLING`, `COST_STYLE`, `COST_STEPS`, `GROWTH_SHOW` (`:6-21`).

## zeulewan/zeul-claude-plugins
https://github.com/zeulewan/zeul-claude-plugins — stars 0
1. Fixed per segment plus threshold. `plugins/custom-statusline/scripts/statusline.sh`: cwd cyan `36` (`:157`, OS icon white `37` `:155`), git magenta `35` with green `✓` / red `✗` dirty mark (`:166-173`), model blue `34` (`:181`), duration grey `90` (`:189`), 5h/7d green `<50`, yellow `>=50`, bold red `>=80` (`:202-216`), ctx bar same thresholds (`:234-238`), empty bar grey `90` (`:245`).
2. Themes: not present.
3. Colour spec: ANSI 16 (`\033[0;3Xm`, `0;90m`). No detection, no NO_COLOR.
4. Fill: foreground-only.
5. Separators: ` │ ` in grey `90` between segments (`:180` etc.).
6. Neighbours: distinct hue per segment (cyan, magenta, blue, grey) plus grey `│`.
7. Light/dark: not present.
8. Glyphs: Nerd Font icons when `show_icons` is on (os `U+F8FF`, git `U+E0A0`, clock `U+F017`, usage `U+F0A0`; `:44-48`); icons off gives plain text (`:50-53`). `custom_os_icon` overridable.
9. Other: usage fetched from a cache file (`:140`).
10. Customisation: `~/.claude/statusline-config.json` booleans `show_cwd/icons/git/model/duration/usage/context`, `os_icon` (`:5-24`). Colours not configurable.

## zhoufanscut/vantagehud
https://github.com/zhoufanscut/VantageHUD — stars 0
1. By semantic token. `src/hud/themes.js:55-66` documents the 10-token contract: `text` (path), `label` (every `xxx:` prefix, counts), `faint`, `sep` (` | ` and empty gauge track), `gradLow`/`gradMid`/`gradHigh` (usage tiers calm <70, watch 70-84, alert >=85; gradLow is also the static value colour for repo/branch/token), `add` (staged/ahead), `del` (modified/behind), `track` (untracked). `colors.js:175-196` `gradientColor` snaps to one of three flat bands, deliberately categorical not a continuous lerp, because 256/16 quantisation of a lerp is ragged. `elements/context.js:37-77` bar and % take the tier colour.
2. Themes: 5 bundled (`THEMES`): `aurora` (default, Nord/Tokyo-Night family), `ember` (Gruvbox), `nebula` (Catppuccin Mocha), `graphite`, `daylight` (light). Format: flat palette of 10 `#rrggbb` tokens. User themes in `config.json` with `base` inheritance (partial override), a user theme with a bundled name shadows it; invalid hex falls back to base with a `HUD_DEBUG` warning (`themes.js:13-30, 200-258`). Env `HUD_THEME=<name>`. `preview-themes.mjs` renders them.
3. Colour spec: hex authored, converted to RGB once. Depth detection in `colors.js:16-80`: `FORCE_COLOR` (0 none, 1/2/3 floor of 16/256/truecolor, beats NO_COLOR), then `NO_COLOR` (none), `COLORTERM=truecolor|24bit`, `TERM` containing 256, `TERM=dumb` none. Downsamples to xterm-256 cube/grey and to 16 (`rgbTo256`, `rgbTo16`, `:83-131`).
4. Fill: foreground-only.
5. Separators: plain ` | ` in `sep` token colour; the same token is the empty bar track `░`.
6. Neighbours: not distinguished by hue; mostly one `label` tone + value tone, hue is saved for tier/state colours.
7. Light/dark: partially. `daylight` is a dedicated light palette chosen manually; no auto-detection.
8. Glyphs: `█░` bars, many box/emoji characters (311 box hits are mostly theme comments/tests); no Nerd Font requirement seen.
9. Other: effort ramp colours reuse gradLow/gradHigh ("effort `low`" is the alert end); cache warm/cold use gradLow/gradMid; subagent and call-count elements.
10. Customisation: `config.json` (`theme`, `themes`, thresholds, labels), `HUD_THEME`, `HUD_DEBUG`, `FORCE_COLOR`, `NO_COLOR`.

## zhoufanscut/vargus
https://github.com/zhoufanscut/VArgus — stars 0
1. Same token model as VantageHUD, ported to TypeScript (header of `src/theme/palettes.ts:3-14`: "VantageHUD 0.6.0's five bundled palettes"). `src/render/fragments/context.ts:5-17`: label in `label` token, value coloured by `t.gradient(percent, [WARNING, CRITICAL])` over gradLow/gradMid/gradHigh.
2. Themes: 5 bundled, same names as VantageHUD (aurora, ember, nebula, graphite, daylight); default `graphite` (near-monochrome, only usage tiers carry hue; README:167). 10 hex tokens each. Chosen in the plugin `/config` UI; user-defined palettes not documented here.
3. Colour spec: 24-bit SGR only, "no 256/16 conversion" (`src/theme/index.ts:5-6`), unlike VantageHUD (README:68 table: "24-bit colour; NO_COLOR turns it off"). `NO_COLOR` non-empty: no escapes at all (`index.ts:42-50`).
4. Fill: foreground-only.
5. Separators: ` | ` in `sep` token.
6. Neighbours: not distinguished by hue (graphite default is near-grey).
7. Light/dark: one dedicated light palette (`daylight`, README:168 "All but daylight assume a dark terminal"); no detection.
8. Glyphs: emoji present in some fragments; not required.
9. Other: detail pane (`/vargus`) with all limits; blank-on-stale option.
10. Customisation: plugin options in `/config` (theme, detailView, blank-stopped-line); `NO_COLOR`.

## zhourui156897/ccstatusline
https://github.com/zhourui156897/ccstatusline — stars 0. Not marked as a fork on GitHub, but the README and badges are those of `sirmalloc/ccstatusline` (copy). Findings below are from its source; treat any difference from upstream as unchecked.
1. Per widget, user-assigned, or by position under a powerline theme. Each widget has `color` (fg) and `backgroundColor`. With a powerline theme, `PowerlineThemeSelector.tsx:62-70` and `renderer.ts:199-201` colour the n-th non-separator widget with `theme.fg[n % len]` / `theme.bg[n % len]` (cycling by index, per line). Theme `custom` keeps each widget's own colours. Threshold colouring is not built in.
2. Themes: 11 powerline themes in `colors.ts:271-440`: `custom`, `nord`, `nord-aurora`, `monokai`, `solarized`, `minimal`, `dracula`, `catppuccin`, `gruvbox`, `onedark`, `tokyonight`. Format: for each of colour level 1/2/3 (16 / 256 / truecolor) a list of 5 fg and 5 bg colours, e.g. nord truecolor bg `88C0D0 4C566A 5E81AC B48EAD A3BE8C` with fg `2E3440 D8DEE9 FDF6E3 2E3440 2E3440` (text chosen per background by hand). Themes can be copied to `custom` and edited in the TUI (`applyCustomPowerlineTheme`, `:42-84`).
3. Colour spec: named 16 + bright, `ansi256:N`, `hex:RRGGBB` (`color-sanitize.ts:3-12`); `COLOR_MAP` has 16 names each with ansi16/ansi256/truecolor variants (`colors.ts:11-49`). Level is a setting (`chalk.level = settings.colorLevel`, `ccstatusline.ts:92`, 0-3), not auto-detected here; switching level resets custom colours incompatible with it (`color-sanitize.ts:14-25`). NO_COLOR not seen.
4. Fill: both. Foreground-only in normal mode; background fills in powerline mode and as an optional per-widget background; global `overrideForegroundColor` / `overrideBackgroundColor`.
5. Separators: powerline arrows (default ``), configurable list of separators and caps with hex input up to U+10FFFF (README:74); start/end caps per line (`renderer.ts:92-98`); `separatorInvertBackground`. Arrow colours derive from the neighbouring widgets' backgrounds via `bgToFg` (`renderer.ts:281`). Non-powerline: text separator widget, optional "inherit colours" so the default separator takes the preceding widget's fg/bg (README:500).
6. Neighbours: different bg per index in powerline themes (palette of 5 cycles); arrow separators; `merge` flag fuses widgets so no separator between them.
7. Light/dark: not present. Text colour per background is hand-picked in each theme. README:515 warns that VS Code's `minimumContrastRatio` rewrites colours.
8. Glyphs: Powerline/Nerd Font required for arrows, with a font-install helper and detection (`PowerlineFontStatus.ts`, `powerline.ts:27` tests which symbols can display); emoji in widget labels.
9. Other: React/Ink TUI configurator (`ColorMenu.tsx`, `PowerlineSetup.tsx`, `StatusLinePreview.tsx`) with live preview; widget auto-alignment across lines; flex separators; bold toggle.
10. Customisation: JSON settings written by the TUI; no env vars for colour found.

## zl190/cc-fuel-gauge
https://github.com/zl190/cc-fuel-gauge — stars 0
1. One colour for the whole line, chosen by state. `statusline.sh:83-132` `determine_color`: green `\033[32m`, yellow `33`, red `31`, applied to model, bar, percent and tokens together (`:190-199`; cost appended uncoloured). Zone by mode: `absolute` (default) tokens <30K green, <50K yellow, else red; `ratio` 50/75%; `auto` absolute plus yellow when ratio >=80 (`lib/defaults.sh:5-20`).
2. Themes: not present.
3. Colour spec: ANSI 16. No detection, no NO_COLOR. Error message in grey `90`.
4. Fill: foreground-only.
5. Separators: not present (spaces).
6. Neighbours: not applicable, single colour.
7. Light/dark: not present.
8. Glyphs: `[████░░░░]` bar. No Nerd Font.
9. Other: colour is tied to a handoff trigger (red zone fires a context handoff, `lib/handoff-trigger.sh`), so the colour is functional state, exported as `ZONE`.
10. Customisation: `~/.config/cc-fuel-gauge/config.yaml` (mode, soft/hard thresholds, ratio thresholds, `show_tokens`, `show_cost`, `compact`).

## zleo-ai/line
https://github.com/zleo-ai/line — stars 0. Self-described "Based on CCometixLine"; GitHub does not mark it as a fork.
1. Fixed per segment, per theme. Each segment (model, directory, git, context_window, cost, session, output_style, usage) carries `ColorConfig { icon, text, background }`, each `Option<AnsiColor>` (`theme_powerline_dark.rs:6-250`). Powerline dark: model bg (45,45,45) white text, directory bg (139,69,19) white, git bg (64,64,64) white, context bg (55,65,81) text (209,213,219), cost bg (40,44,52) text (229,192,123), session bg (45,50,59) text (163,190,140), output_style bg (50,56,66) text (129,161,193). Default theme (`theme_default.rs`) is foreground-only 16-colour: model 14 cyan, directory icon 11 / text 10, git 12 blue, context 13 magenta, cost 3 yellow, session 2 green. Not threshold-based in the files read.
2. Themes: 9 built-in (`presets.rs:17-27`): `cometix`, `default`, `gruvbox`, `minimal`, `nord`, `powerline-dark`, `powerline-light`, `powerline-rose-pine`, `powerline-tokyo-night`. Format: a whole `Config` (every segment's colours/icons) per theme. Users can save the current config as `~/.claude/horus/themes/<name>.toml` and it overrides a built-in of the same name (`presets.rs:36-77`).
3. Colour spec: `AnsiColor` enum `Color16{c16}` / `Color256{c256}` / `Rgb{r,g,b}` (`statusline.rs:372-383`). No depth detection or NO_COLOR seen in files read.
4. Fill: both. Segment with `background` set gets a bg fill across ` icon text ` (`statusline.rs:303-337`); without one it is fg-only.
5. Separators: if `style.separator == "\u{e0b0}"` powerline arrows with fg = previous segment's bg and bg = next segment's bg (`create_powerline_arrow`, `statusline.rs:487-512`), with fallbacks when one side has no bg; otherwise a white `\x1b[37m` separator string (`:217-218`).
6. Neighbours: powerline themes use different greys/browns per segment bg and arrows; default theme uses different 16-colour hues.
7. Light/dark: only by choosing `powerline-light` vs dark themes; no adaptation. Text is hand-assigned per segment.
8. Glyphs: each segment has `icon.plain` (emoji, e.g. 🤖📁) and `icon.nerd_font` (`\u{e26d}`, `\u{f024b}`), chosen by `StyleMode` (`statusline.rs:364-368`).
9. Other: ratatui TUI configurator with `color_picker.rs` (modes `Basic16`, 256, `RgbInput` with hex field), `theme_selector.rs`, `icon_selector.rs`, `segment_list.rs`; segment priority drives dropping on narrow terminals (`statusline.rs:42-63`).
10. Customisation: TOML config, theme TOML files, TUI.

## zm2231/cc-utility
https://github.com/zm2231/cc-utility — stars 0
Mostly not a statusline: a local session-log analytics / "harness doctor" CLI (`src/cli.ts`, `src/report/render.ts` uses kleur). It ships one statusline sidecar, `integrations/pacekit-sidecar/statusline.sh`, described below.
1. By state, via named semantic colours. `statusline.sh:14-31` defines `SUCCESS` 114, `WARNING` 221, `DANGER` 210, `CRITICAL` 177, `SPEND` 75 (blue, "off the good-to-bad spectrum on purpose: cost is information, not bad", `:19-21`), `COST` 80, `FG_DIM` 244, `FG_LIGHT` 252, plus dim variants for empty bar cells (65/136/131/97). Comment `:8-13` ties them to a design-system's dark-mode oklch semantic tokens. Context threshold (`:165-172`): >=60 critical, >=50 danger, >=40 warning, else success. Window pace velocity colour compares usage% to elapsed% (`:191-208`): pace >10 critical, >=0 danger, >-10 warning, else success.
2. Themes: not present.
3. Colour spec: 256-index. No depth detection or NO_COLOR.
4. Fill: foreground-only.
5. Separators: not examined in detail (spaces/dim).
6. Neighbours: semantic colour per state, grey labels.
7. Light/dark: dark-mode semantic tokens only; "avoids DIM attribute" by using darker explicit greys for empty bar segments (`:24`).
8. Glyphs: `▮` bar cells, filled in colour, empty in the dim variant (`:121-138`).
9. Other: the empty-cell colour is a darker version of the same hue rather than a neutral track.
10. Customisation: not seen.

## zomboky/claude-status-bar
https://github.com/zomboky/claude-status-bar — stars 0
1. Fixed per bar plus threshold. `statusline.sh:13-17` ANSI 16. `make_bar(pct, safe_color)` (`:24-42`): below 50% the bar uses `safe_color`, then yellow, then red. Context bar green base (`:35`), 5h bar blue base, weekly bar magenta base (`:39-40`). Git: staged `+N` green, modified `~N` yellow (`:49-50`). Effort in DIM brackets (`:33`).
2. Themes: not present.
3. Colour spec: ANSI 16 (`\033[32m`, `91` for red). No detection, no NO_COLOR.
4. Fill: foreground-only.
5. Separators: plain ` | ` (`:39`).
6. Neighbours: each bar has its own base hue (green/blue/magenta) until it turns yellow/red; ` | ` separators.
7. Light/dark: not present.
8. Glyphs: `▓/░` bar; no Nerd Font. `install.ps1` for Windows.
9. Other: none.
10. Customisation: none beyond editing the script.

## zpiao1/m3-terminal-theme
https://github.com/zpiao1/m3-terminal-theme — stars 0
1. By theme role mapped to segment, with state swap. Segments are pills; `m3sync/src/targets.rs:25-37` `PILLS`: DIR primaryContainer/onPrimaryContainer, BRANCH secondaryFixedDim/onSecondaryFixed, MODEL tertiaryContainer/onTertiaryContainer, COST secondaryFixed, CTX primaryFixedDim, 5H tertiaryFixedDim, 7D secondaryFixedDim, WARN yellowFixed/onYellowFixed, DANGER error/onError. Comment `:25-27`: "Neighbouring statusline segments alternate primary/secondary/tertiary families so they always differ, whatever the wallpaper. Warn/danger replace the whole segment." The script (`statusline-command.sh:25-42`) reads `C_<SEG>` (pill bg), `F_<SEG>` (text), `T_<SEG>` (progress-track tint = 30% ink mixed over bg, `targets.rs:38,127`). `pick_state` swaps the whole pill to WARN/DANGER: cost >$5 / >$15, context 50 / 75%, 5h and 7d 50 / 80% (`:36-42, :99-135`).
2. Themes: generated, not bundled. `m3sync` (`palette.rs:1-26`) turns the wallpaper into a Material 3 Expressive palette (QuantizerCelebi, Score, `SchemeExpressive`, 2025 spec, dark and light via material-colors) and writes `~/.config/m3-theme/statusline.sh` / `statusline.json` (`targets.rs:121-134`). Format: semantic M3 roles. Without the file every pill is one neutral grey pair (68,68,68)/(230,230,230) (`statusline-command.sh:26-29`).
3. Colour spec: truecolor `38;2;`/`48;2;` only. No depth detection or NO_COLOR in files read.
4. Fill: background-filled pills, bold text.
5. Separators: rounded left cap U+E0B6 on the first pill, powerline arrow U+E0B0 between pills with fg = previous bg and bg = next bg, thin chevron U+E0B1 in `outline` colour when two neighbours share a bg, rounded right cap U+E0B4 (`:140-160`).
6. Neighbours: alternate primary/secondary/tertiary families so adjacent pills differ; thin chevron fallback when equal.
7. Light/dark: yes. `m3sync` watches wallpaper and Windows light/dark (`win::is_dark`, `main.rs:5, 141`) and regenerates both schemes; the bar is re-read each render so it follows live. Text colour comes from M3's paired `on*` role of each container (contrast built into the scheme).
8. Glyphs: Nerd Font powerline glyphs; `━╸` heavy-line progress bar with half step, 10 cells x 2 halves (`:113-122`). Not emoji.
9. Other: same palette also drives Windows Terminal scheme/theme, PowerShell syntax colours, cmd prompt (`targets.rs:43-62, 185-258`); a Rust statusline (`statusline/src/main.rs`) duplicates the bash one with a parity test.
10. Customisation: role table edited in `targets.rs` (code); wallpaper is the input; no per-user config for the bar.

## zt1314888/ccstatusline-context-color
https://github.com/ZT1314888/ccstatusline-context-color — stars 0
Not a full statusline: a custom-command widget script for ccstatusline. `context-color.js:7-17`: ANSI green `32` below 50%, yellow `33` below 80%, bright red `91` above (matching ccusage defaults), wrapping `<tokens> (<pct>%)`. Needs ccstatusline's `preserveColors` option to keep the codes. Foreground-only, ANSI 16, no themes, no NO_COLOR handling, no glyphs beyond text; customisation is editing the constants. `install.js` wires it into ccstatusline settings.

## gitlab.com/flo-labs/ai (claude_statusbar)
https://gitlab.com/flo-labs/ai/claude_statusbar — stars n/a
Source `hooks/statusline.py` was not reachable (the raw URL returns a login page, API 404), so everything below is `unverified (README only)`.
1. By threshold (README): cpu yellow >=50% / red >=80%, mem yellow >=75% / red >=90%, branch age suffix yellow >=1 day / red >=7 days, red `⚠` on the weekly block when a per-project cap is exceeded. Pace shown as emoji (🐌🐢🎯🚀🤯) rather than colour. unverified (README only).
2. Themes: not for the bar. `.claude-theme` (README) holds a *Claude Code* theme name (`dark`, `light`, `dark-daltonized`, `light-daltonized`, `dark-ansi`, `light-ansi`) and a `theme-picker.ps1` picks one at random per cwd on Windows; it changes Claude Code's theme, not the statusline's.
3. Colour spec: unverified (README only).
4. Fill: unverified (README only).
5. Separators: plain ` | ` between fields (README line format).
6. Neighbours: separators only (README).
7. Light/dark: not present beyond the Claude Code theme override above.
8. Glyphs: per-session emoji hashed from `session_id` or pinned via `.claude-emoji`; 12-cell `▁▂▃▄▅▆▇█` sparkline chosen to be PuTTY-safe.
9. Other: tab-emoji hook (`set-tab-emoji`).
10. Customisation: per-project files `.claude-emoji`, `.claude-theme`, `.claude-cap.txt`; env `CLAUDE_5H_TOKEN_CAP`, `CLAUDE_WEEK_TOKEN_CAP`.

## gitlab.com/thomastartrau/jevcc
https://gitlab.com/ThomasTartrau/jevcc — stars n/a
Primarily a per-turn model router/proxy; the statusline is `src/bin/statusline.rs`.
1. By model tier and threshold. `src/config.rs:24-31` `color_of(tier)`: Haiku green `32`, Sonnet cyan `36`, Opus magenta `35`, Fable yellow `33`; the tier name is bold in that colour (`statusline.rs:182-183`). Rate bars have fixed base colours: Session blue, Weekly magenta (`:120-123`); context bar has none, so `bar()` (`:233-239`) uses green <50, yellow <80, else red. cwd yellow (`:137`), git branch magenta (`:214`), `+N` bold green / `-N` bold red (`:208`), errors red, "fallback" yellow, metadata (`conf`, `effort`, reasons, reset) DIM.
2. Themes: not present.
3. Colour spec: ANSI 16 plus bold/dim (`:19-29`). No detection, no NO_COLOR.
4. Fill: foreground-only.
5. Separators: DIM `|`.
6. Neighbours: different fixed hue per line/role, DIM for secondary info.
7. Light/dark: not present (the `lightdark.words` hits are README logo `prefers-color-scheme`).
8. Glyphs: dot bar (`FILL`/`EMPTY` constants), no Nerd Font.
9. Other: per-model colour is the distinctive part (tier of the model the router chose for the turn).
10. Customisation: none for colours.

## gitlab.com/vfeoche/claude-cost-statusline
https://gitlab.com/vfeoche/claude-cost-statusline — stars n/a
1. Two parts. A ccstatusline config (`ccstatusline.settings.json`) with per-widget `color`: session-usage green, reset-timer brightBlack, weekly-usage blue, weekly-reset-timer brightBlack, tokens-total white, `colorLevel: 2` (256). Plus `statusline.js:50-100`: percent colour green `32` <50, yellow `33` <80, red `31` (`pct()`, `:55`); git flags fixed: branch magenta `35`, ahead/staged/`+` green, behind/`-` red, modified yellow `33`, untracked cyan `36` (`:90-98`); tokens in grey `90`, separator ` · ` grey; folder name bold.
2. Themes: not present.
3. Colour spec: named ANSI names (ccstatusline) plus raw SGR codes; `colorLevel: 2` fixed. No NO_COLOR.
4. Fill: foreground-only.
5. Separators: ccstatusline `separator` widgets; in the script a dim ` · ` (`:57`).
6. Neighbours: different colours per widget; grey separators.
7. Light/dark: not present.
8. Glyphs: emoji 📁, `⎇ ↑ ↓ ● ✚ ?` git symbols.
9. Other: cost is shown as `<tokens grey> (<coloured cost>)` per period via ccusage.
10. Customisation: the settings JSON (ccstatusline format v4); script constants.

## jonathonringeisen.com/blogs/build-a-custom-claude-code-statusline-with-one-prompt
https://jonathonringeisen.com/blogs/build-a-custom-claude-code-statusline-with-one-prompt — n/a
Blog post showing a `/statusline`-generated script, not a project.
1. By threshold: the token count and bar share one colour, green `\033[32m` below 50% of a 150k soft cap, yellow 50-90%, red above 90% (`COLOR` block in the article). Model and branch plain.
2. Themes: not present.
3. Colour spec: ANSI 16; no detection.
4. Fill: foreground-only.
5. Separators: ` | `.
6. Neighbours: separators only.
7. Light/dark: not present.
8. Glyphs: `█░` 10-cell bar.
9. Other: the colour thresholds are specified in the prompt itself; the post stresses stating thresholds and a soft cap (150k of 200k) so red arrives before compaction.
10. Customisation: edit the prompt / script.

## juejin.cn/post/7548042861847150626
https://juejin.cn/post/7548042861847150626 — n/a
Chinese tutorial "Claude Code 状态栏工具完整配置指南" (Leo): compares ccline, cc-statusline, ccstatusline and a hand-written macOS bash script. The script in the post emits no colour codes in the version shown.
1. No colour: segments are emoji-led plain text (📁 dir, git, time, model, context...), no ANSI found in the article.
2. Themes: a "theme" is a layout preset, not colours: `STATUSLINE_THEME=minimal|developer|full|default` selects which fields are joined with ` | ` (`get_themed_output`).
3. Colour spec: not present.
4. Fill: not present.
5. Separators: ` | `.
6. Neighbours: separators and emoji.
7. Light/dark: not present.
8. Glyphs: emoji icons per language (🐹 Go etc.), weather, motivation line.
9. Other: weather and "motivation" segments.
10. Customisation: `~/.claude/statusline.conf` with `SHOW_*`, `UPDATE_INTERVAL`, `THEME`; env `STATUSLINE_THEME`. The one-click script is gated behind a WeChat follow, so it was not read.

## juejin.cn/post/7631860056708153350
https://juejin.cn/post/7631860056708153350 — n/a
Chinese tutorial on a two-line statusline with usage focus; script is in the post.
1. By threshold, and inverted for cache. `color_pct`: red >=76, yellow >=51, else green (context, 5h, 7d); `color_pct_inv` for cache hit rate: green >=71, yellow >=41, else red. Labels `In:`/`Out:` and the cost use cyan `36`.
2. Themes: not present.
3. Colour spec: ANSI 16 via `printf '\033[3Xm'`; no detection.
4. Fill: foreground-only.
5. Separators: spaces and `|` between left and right groups.
6. Neighbours: only value colours differ; labels uncoloured.
7. Light/dark: not present.
8. Glyphs: `→` before reset times; no emoji or Nerd Font.
9. Other: plan label `[Pro]`/`[Max]` guessed from the model id.
10. Customisation: edit script.

## npmjs.com/package/@ckeith26/claude-statusline
https://www.npmjs.com/package/@ckeith26/claude-statusline — n/a
1. Fixed per segment plus threshold. `bin/statusline.sh:2-15` Catppuccin Macchiato truecolor: project name `C_RED` #ed8796, git branch `C_GREEN` #a6da95, diff stats and cost `C_AMBER` #eed49f, model `C_PURPLE` #c6a0f6, healthy gauge `C_TEAL` #8bd5ca, bypass mode `C_PEACH` #f5a97f, labels `C_MUTED` #6e738d, empty gauge and separators `C_OVERLAY` #363a4f (`:449-452`). Gauge fill is a *background* block coloured by threshold: budget mode green <50, amber <80, red; usage mode teal <40, amber <70, red (`:86-98`); the percent text uses the same colours (`:328-334`).
2. Themes: one (Catppuccin Macchiato), role names in variables, no switcher.
3. Colour spec: truecolor `38;2`/`48;2` only. No detection, no NO_COLOR.
4. Fill: both. Text is foreground-only; gauges are spaces on a coloured background (`filled` / `empty` spaces with `fill_bg` / `empty_bg`, `:101-108`).
5. Separators: a `sep` variable in overlay colour (plain text), no powerline.
6. Neighbours: different Catppuccin hues per field; muted labels.
7. Light/dark: not present (Macchiato is dark).
8. Glyphs: layouts adapt to width (full/medium/short/tiny variants with abbreviated model names, `:449-513`); no Nerd Font seen.
9. Other: width-responsive layouts; a Python snippet for subagent/session counts coloured by status.
10. Customisation: none; edit script.

## claude-pulse
https://github.com/LukasRahn/claude-pulse (stars 2). Node. A one-badge statusline showing what Claude is doing right now (Thinking, Shell, Editing...), plus a few chips.
1. Colour is by state, not by segment. The badge background comes from the activity state: `hooks/indicator.js:189-214` `deriveState` maps event/tool to a theme slot (Bash->bash, Edit/Write->code, Read/Grep->read, Task->agent, WebSearch/WebFetch->web, mcp__*->mcp, Stop->done, notification->input, thinking/start/end/compact->idle, TodoWrite and other tools->tool). Fixed chips in `statusline/badge.js:~140-150`: permission-mode chips PLAN `#4a3aff`, AUTO-EDIT `#1f8f3a`, AUTO `#00a0a0`, NO-ASK `#c08000`, BYPASS `#c01818`; NEEDS OK `#ff8c00`; subagent count `#c83ab0`; effort chip `#5a6cf0`. Context gauge is by threshold (`badge.js` `contextGauge`: >=90 or exceeds_200k `#e04040`, >=70 `#e0a020`, else `#3ad27a`). Duration/cost/model/dir are one grey (`38;5;250`).
2. Themes: 3 bundled, `themes/dark-minimal.conf` (default), `ocean.conf`, `monokai.conf`. Format is a shell-style conf of 10 per-state keys (`COLOR_BASH, CODE, READ, AGENT, INPUT, IDLE, DONE, TOOL, WEB, MCP`, each `#rrggbb`), not semantic roles. Users can supply any file via `CLAUDE_PULSE_THEME` or `theme.conf` in the config dir (`indicator.js:69-74`); `/claude-pulse:theme` copies a bundled one over `theme.conf` (`commands/theme.md`).
3. Truecolor when `COLORTERM` matches truecolor|24bit or `TERM` ends `-direct`, else nearest 256-cube index via `to256()` (`badge.js:~105-110`). No 16-colour tier. NO_COLOR: not present.
4. Fill: background-filled badge and chips (`bgSeq`), foreground-only grey tail and gauge.
5. Separators: none drawn; chips separated by two spaces, tail items by ` · `. `full` style pads one solid bar to `COLUMNS` (`badge.js` termWidth).
6. Neighbours: different hue per chip, plus two-space gaps. Badge and chips never touch.
7. Contrast: `brighten()` scales any theme colour so its max channel reaches 210 (hue kept), then `fgCode()` picks black (30) or bright white (97) by luminance `0.2126r+0.7152g+0.0722b > 140` (`badge.js`). Theme colours are therefore deliberately dark, brightened at draw time. No light/dark terminal detection.
8. ASCII state icons in the badge (`* v ! > ~ ? @ o # / & + % .`, `indicator.js:191-214`); `⏱`, `⚙` in chips; block-shade gauge `▓░` (7 cells).
9. Three badge widths (`BADGE_STYLE` compact|wide|full). Live ticking duration. Mode chip hidden when idle so it is never stale.
10. Config: `config.conf` with `BADGE_STYLE`, `FEATURE_*=on|off` flags (DETAIL, EFFORT, CONTEXT, DURATION, COST, SUBAGENTS, MODE, TITLE); slash commands `/claude-pulse:theme|config|setup|doctor`; env `CLAUDE_PULSE_THEME`, `CLAUDE_CONFIG_DIR`.

## claude-statusline-config
https://github.com/LZong-tw/claude-statusline-config (stars 2). A personal configuration of the third-party ccstatusline tool, plus helper scripts. Styling is ccstatusline's, not its own.
1. Per-widget background by a named colour, set by hand in `ccstatusline-settings.json`: thinking-effort bgRed; model (custom-command) bgMagenta; version bgYellow; context-bar bgBlue; "recent" bgBrightYellow; "read" bgBrightBlack; "savings" bgYellow; "roi" bgBrightYellow; "creation" bgBrightCyan; "input" bgBrightBlue. git-branch `color: magenta`, git-changes `color: yellow` (foreground). Widgets without a colour key (tokens-*, git-worktree, session-cost, session-clock) take the powerline theme colour.
2. `powerline.theme: "nord-aurora"` (`ccstatusline-settings.json:141`), one of ccstatusline's bundled themes; no theme files in this repo. `continueThemeAcrossLines: false`.
3. `colorLevel: 2` (256-colour) in the same file; named bg/fg keys (`bgRed`, `bgBrightCyan`). `statusline-fast.mjs` and the `.sh` helpers contain no ANSI at all (grep found none): they only emit text for custom-command widgets. NO_COLOR: not present.
4. Background-filled powerline cells.
5. Powerline: `separators` has one entry and `separatorInvertBackground: [false]`; `startCaps` and `endCaps` have four entries (one per line). The glyphs are Private Use Area characters that did not survive the fetch, so which glyph is `unverified`. Arrow colours are decided inside ccstatusline.
6. Theme colours cycle per cell via the powerline theme; explicit bgX overrides win.
7. Not present in this repo's own code.
8. Powerline glyphs (Nerd Font); `defaultPadding: " "`.
9. `flexMode: "full-until-compact"`, `compactThreshold: 60`. A Windows variant `ccstatusline-settings.windows.json` exists.
10. ccstatusline JSON settings (version 3); hooks/check-ccstatusline.cjs; verify scripts.

## claude-toolbelt
https://github.com/Malo-T/claude-toolbelt (stars 2).
not a Claude statusline: a marketplace of six Claude Code plugins (branch-recap, compact-nudge, clean-context, slack-changelog, status-icons, status-sounds). `status-icons/hooks/tab-title.sh` only prefixes the terminal tab title (OSC 0) with an icon; no colour code.

## cctv
https://github.com/manelrv/CCTV (stars 2).
not a Claude statusline: a macOS menu-bar / floating-window app (Tauri 2, Rust + React) showing the state of every running Claude Code instance, with a global hotkey to jump to the terminal.

## codebuddy-plugins-official
https://github.com/masx200/codebuddy-plugins-official (stars 2). A mirror of CodeBuddy plugins. Only `external_plugins/claude-hud` is a statusline (a copy of the claude-hud project); the theme-factory, matplotlib and other plugins are not statuslines.
1. Fixed per element, with one threshold. `src/render/session-line.ts`: model `[name]` cyan (line 14), config summary and duration and token breakdown dim, `⚠️ COMPACT` red. `colors.ts` `getContextColor`: >=85 red, >=70 yellow, else green; `coloredBar` uses that colour for `█` and no colour (dim default) for `░`. `tools-line.ts`: running tool yellow spinner + cyan name, done `✓` green with dim `×N`. `agents-line.ts`: running `●` yellow, done `✓` green, agent type magenta, model and description dim. `todos-line.ts`: `▸` yellow in progress, `✓` green when all done.
2. Themes: not present in the statusline (the theme-factory colour palettes belong to a different plugin).
3. Named ANSI 16 only (`colors.ts:1-6` `\x1b[32m` etc., `\x1b[2m` dim). No depth detection. NO_COLOR: not present.
4. Foreground-only; no background fill.
5. Separators: plain text (` | `-style joins in `session-line.ts`), no powerline.
6. Neighbours: different foreground hue per element; dim for secondary.
7. Not present; relies on terminal's own 16-colour palette.
8. Emoji and Unicode: `⏱`, `⚠️`, spinner frames, `✓ ● ▸`.
9. Animated spinner for running tools (`tools-line.ts:21`, `SPINNER_FRAMES`).
10. Config via `config-reader.ts` (show/hide of lines); no colour options found.

## claude-cache-timer
https://github.com/mattcmorrell/claude-cache-timer (stars 2). Bash + jq statusline whose first element is a prompt-cache countdown.
1. By state for the cache timer, fixed per segment for the rest. `scripts/statusline.sh:23-27` defines 256-colour fg: green 78, amber 179, dim 242, orange 209, red 196, model 188, effort 30, dim-sep 59, ctx 109, branch 111, main-branch 96, cwd 140, total-tokens 145. Cache timer (`:55-100`): `◉ cached` green (>10 min left), `◎ NmNs` amber (<=10 min), expired: red `☣` when cache_read tokens >1,000,000, orange `○` >500,000, dim otherwise; ">1h stale" red/dim by the same token rule. Other segments: model `CM`, effort `CE`, `Total:` `CT`, `Ctx(u): N%` `CC` (no threshold colouring), cost amber `A`, session time `CD`, branch `CB`, main branch `CP`, cwd `CW` (`:134-143`).
2. Themes: not present.
3. 256-colour indexes (`38;5;N`) only. No detection. NO_COLOR: not present.
4. Foreground-only.
5. Separators: a dim `|` in `${CD}` between model and total; otherwise two spaces. No powerline.
6. Neighbours: each segment has its own muted hue (all in the 30-188 greyish-pastel range) so adjacent items differ by hue, not lightness.
7. Not present.
8. Unicode glyphs `◉ ◎ ○ ☣ ⎇ 𖠰`; no Nerd Font, no ASCII mode.
9. A three-line layout (`printf` of L1/L2/L3). Plugin also ships a cache-expiry warning hook (`scripts/cache-expiry-warn.sh`).
10. Fixed: colours are hard-coded variables in the script; behaviour switched by `*.timer-off` marker files only.

## statux
https://github.com/Meteorkid/statux (stars 2). TypeScript, widget-based statusline and TUI configurator for Claude Code, Codex and iTerm2; 72 widgets.
1. Normal mode: fixed per widget by a `color` in config (`src/config.ts:17-37` default layout: model orange, tokens magenta, cost green, session-clock yellow, git-branch cyan, git-changes yellow, cost-rate cyan, rate-limit yellow, tool-calls blue, separators white); each widget also has a `defaultColor` (e.g. context-bar `defaultColor: "green"`, `widgets/context-bar.ts:68`) and thresholds (`context-bar.ts:82-86`: >80 red, >60 magenta, >20 green, else white). Powerline mode: by position, cycling through the theme (`src/render/powerline.ts` `widgetBgColor`, `themeIndex % theme.colors.length`); a widget's own `backgroundColor` overrides.
2. Four built-in powerline themes in `powerline.ts:17-61`: `dark` (blue, green, yellow, magenta, cyan, red bg), `ocean` (blue/cyan alternating), `warm` (red/yellow alternating), `mono` (white / bright-black alternating). The theme is a list of `{bg, fg}` pairs, not roles. Users can only choose one by name (`powerline.theme`); no user-defined themes found in `getTheme`.
3. Named ANSI 16 plus two 256-colour names (`orange` 208, `pink` 213) in `src/render/ansi.ts:3-33`. `config.colorLevel` (0-3, default 3, `config.ts:41`, README) is declared but nothing in `ansi.ts`, `pipeline.ts` or `powerline.ts` reads it, so there is no downsampling. NO_COLOR: not present.
4. Normal mode foreground-only; powerline mode background-filled (`bg + fg + bold` per segment, `powerline.ts`).
5. Powerline arrows U+E0B0 / U+E0B1 / U+E0B2 / U+E0B3 (`powerline.ts:6-9`), configurable `powerline.separator`. Arrow colour: fg = this segment's bg, bg = next segment's bg; the last arrow's bg is black (`DEFAULT_BG`). Normal mode: user `separator` widgets (default ` │ `, white).
6. Neighbours: powerline themes cycle through hues (`dark`) or alternate two colours (`ocean`, `warm`, `mono`); a `separator` widget in the list advances the colour index.
7. Per-theme fg is hard-coded black or white to pair with the bg (`powerline.ts` colour pairs). No light/dark detection.
8. Emoji and box glyphs in widgets; powerline needs a Nerd/Powerline font (comment at `powerline.ts:6`).
9. Interactive TUI configurator (Ink); iTerm2 integration (`iterm2/statux.py`); custom-command and link widgets.
10. JSON config (`renderMode: normal|powerline`, `colorLevel`, `powerline.theme`, `powerline.separator`, per-widget `color`, `backgroundColor`, `bold`, `label`, `merge`); CLI flags in `src/cli/args.ts`; `doctor`.

## claude-code-statusline (mfeolacruz)
https://github.com/mfeolacruz/claude-code-statusline (stars 2). One bash script, `.claude/statusline-command.sh` (110 lines).
1. By threshold, only on the percentage digits: `make_bar` (`:28-31`) >85 red `\033[31m`, >=60 yellow `\033[33m`, else green `\033[32m`. Applies to ctx, 5h and 7d bars alike. Label, brackets and bar glyphs are uncoloured.
2. Themes: not present.
3. Named ANSI 16 (`31/33/32`). No detection. NO_COLOR: not present.
4. Foreground-only; only the number is coloured.
5. Plain ` │ ` between segments (`:106-109`).
6. Neighbours: separator only; all segments share the terminal text colour.
7. Not present.
8. `█░` bar, `↻` reset marker; no icons.
9. Drops 7d under 80 columns and 5h under 50 (`$COLUMNS`/`tput cols`).
10. None; edit the script.

## context-helper
https://github.com/michal-franc/context-helper (stars 2). Bash `statusline.sh` + Python analyzer showing instruction count, density and an estimated accuracy.
1. By threshold: instruction metrics `I:/D:/A:` take one colour from estimated accuracy (`statusline.sh:66-71`): >=90 green, >=75 yellow, else red; grey if analysis failed (`:80`). Context percentage (`:95-101`): <50 green, <80 yellow, else red. Brackets, labels and `|` are grey `\033[90m`. Model and folder uncoloured.
2. Themes: not present.
3. Named ANSI 16 (`\033[32m 33m 31m 90m`). NO_COLOR: not present.
4. Foreground-only.
5. Plain grey `|`.
6. Neighbours: grey structure vs coloured values.
7. Not present.
8. None.
9. Not present.
10. None (edit script); `install.sh` wires it up.

## claude-statusline (michalschroeder)
https://github.com/michalschroeder/claude-statusline (stars 2). Node; cost-tracking statusline with a session viewer.
1. Mostly dim text with colour reserved for state. `hooks/statusline.js`: model, dir, worktree, vim, duration, rate limits all `dim()` (`:332,356,373,390,465,476`); effort yellow (`:335`); agent bold; lines added green / removed red (`:469-470`). Cost chips use a 4-tier ladder `lib/color.js` `COST_TIERS=[green,yellow,orange,red]`: session cost thresholds `SESSION_TIERS=[5,10,20]` USD, period chips use `BUDGET_TIERS=[0.5,0.75,0.9]` of the limit. Context bar (`statusline.js:199-262`): 10 cells, each filled cell takes its own colour from `CTX_RAMP=[34,70,106,142,178,214,208,202,196,160]` (forest green to dark red), empty cells grey 240; past the panic cell the filled cells blink red (`\x1b[5;31m`) with a skull.
2. Themes: not present. (`solarized` and `synthwave` appear only as palette options in `demo/palette.sh`, a preview script for choosing the ramp.)
3. Mix of ANSI 16 (`31/32/33`, `2;36`) and 256-colour (`38;5;208`, `38;5;110`, the ramp). No depth detection, no NO_COLOR.
4. Foreground-only.
5. Dim `┊` between segments (nerd and unicode sets), `|` in ascii; `─`/`-` rule under the skills line (`:54-69`, `:493`, `:518`).
6. Neighbours: separator only; dim vs coloured.
7. Not present (it hand-picks a muted ramp "ramp B").
8. Three icon tiers `ICON_SETS` (`:56-70`): `nerd`, `unicode`, `ascii`, chosen by `STATUSLINE_ICONS` env > cached choice > first-run default; a hint line is shown on first run (`:515`).
9. Blinking red panic state; the bar spans the full 1M window on 1M models. Screenshot tooling in `demo/` (`ansi2html.js`, `screenshots.sh`).
10. Env `STATUSLINE_ICONS`; budgets in a config consumed by `lib/budget.js`; `bin/sessions.js` viewer.

## phase-gate
https://github.com/Michuru/phase-gate (stars 2). A larger process framework; only `standalone/statusline/statusline.py` (165 lines) is a statusline.
1. By threshold: context line `statusline.py:119-127` >=75 red-bold with a warning sentence, >=50 yellow, else green. Rate limits 5h / 7d (`:151-155`): >=90 red, >=75 yellow, else cyan. Lines added green / removed red (`:136`). Everything else (model, dir, git, PR, cache) dim (`DIM`).
2. Themes: not present.
3. Named ANSI 16 (`:35-40`). NO_COLOR: not present.
4. Foreground-only.
5. Plain ` · ` between items.
6. Neighbours: dim vs coloured only.
7. Not present.
8. Emoji `💰 ⏱ ⚠`.
9. Not present.
10. `settings.fragment.json` for wiring only; no styling options.

## devpilot-studio
https://github.com/mr-kumuditha/devpilot-studio (stars 2). Bash (`bin/devpilot`, 1,460 lines, the real renderer; `cli.js` is a launcher) statusline with themes, presets and an interactive config.
1. Fixed per element plus threshold. `bin/devpilot:209-218` default palette: model dim, arrow dim white, dir dim cyan, org bold red, brackets and labels dim white. Bars (`render_bar`, `:318-340`) colour by thresholds `DPS_THRESHOLD_MID/HIGH` (default 50/80): `BAR_LOW` green, `BAR_MID` dim yellow, `BAR_HIGH` red. Effort level has its own 6-colour scale `E_LOW green, E_MED dim cyan, E_HIGH dim yellow, E_XHIGH dim magenta, E_MAX red, E_DEFAULT dim`.
2. Three built-in themes in `apply_theme` (`:245-300`): `default`, `mono` (white/grey weights only), `vivid` (bold bright variants); plus `custom` built from 16 `DPS_COLOR_*` keys (MODEL, ARROW, DIR, ORG, BRACKET, LABEL, RESETTXT, BAR_LOW/MID/HIGH, EFFORT_LOW/MED/HIGH/XHIGH/MAX/DEFAULT); unset keys fall back to default. `dps theme save|use|list` stores named custom presets (`:1206-1290`). Format is per-element (roles are fixed names, not generic primary/accent).
3. Default themes use ANSI 16 with dim/bold attributes. Custom values may be raw escape strings, or 6-digit hex which become `38;2;r;g;b` only when `DPS_TRUECOLOR=1` (`_theme_color`, `:228-243`); with it off, hex falls back to the default colour. No depth detection. NO_COLOR: not present.
4. Foreground-only.
5. Plain text arrow/separators in `C_ARROW`; no powerline.
6. Neighbours: dim vs coloured; hue by element.
7. `mono` theme for monochrome use; nothing adaptive.
8. Nerd Font glyph labels opt-in via `DPS_ICONS=1` (`:77`); bar glyphs `DPS_BAR_FILLED/EMPTY` default `█░`.
9. `dps gallery` previews preset looks and applies one (`:991-1030`); `dps config` wizard asks for theme (`:1148-1181`); `dps demo`.
10. Config file with `DPS_*` keys (ORG, THEME, BAR_WIDTH, SHOW_*, LAYOUT, ICONS, TRUECOLOR, THRESHOLD_*); commands `config`, `theme`, `gallery`, `presets`.

## pi-cc-status
https://github.com/msdavid/pi-cc-status (stars 2).
Adjacent, not Claude Code: a Claude-Code-style status line for the `pi` coding agent (a different agent), with a "command" mode that runs existing Claude Code statusline scripts verbatim. Styling in its own mode, `render.ts`:
1. By role and threshold, through pi's theme API: model `theme.fg("accent")` (`:90`); dir, effort, git, session, cost, duration, tokens `dim`; context bar filled cells `error` if used% >= `thresholds.error` (95), `warning` if >= `thresholds.warning` (80), else `accent`, empty cells `dim` (`:98`); child cost `muted`. Labels (`Model:` etc.) bold, optional.
2. Themes come from pi itself (semantic roles accent/dim/muted/warning/error); the extension bundles none.
3. Colour depth and NO_COLOR are pi's concern; the extension never emits escapes in this mode.
4. Foreground-only.
5. Plain `separator` string, default ` | ` (`config.ts:86`).
6. Neighbours: separator only.
7. Inherited from pi's theme.
8. `accessibility` option: `enabled`, `labels` (text labels), `plainBar` (`=`/`-` instead of block glyphs) (`render.ts:74-83`, `config.ts:92`).
9. Not present.
10. JSON config merged over defaults (`config.ts`): layout, bar width and glyphs, separator, thresholds, accessibility; `/` commands.

## status-herald
https://github.com/muslewski/status-herald (stars 2). Node, zero-dependency; one engine feeding tmux status, a Claude statusline and a terminal "card".
1. By role and state. `lib/status/segments.mjs:8-16` defines 7 roles with both an ANSI and a tmux colour: ok green(32/colour46), notice cyan(36/51), warn yellow(33/226), crit red(31/196), over bright-red(91/201), accent bright-yellow(93/214), dim grey(90/244). Segments choose a role: model badge `accent`; account gauges by `_accountRole(pct)`; context bar by its own bucket; gauge roles `gaugeRole` (`<85` ok, `<100` warn, `<120` crit, else over). `lib/status/claude-statusline.mjs:12-19` then draws a state chip: "your turn" (idle) white bold on brown bg 94; "working" near-black on amber bg 214; otherwise a grey `▶`.
2. Themes: not present; the role table is a fixed constant.
3. Role colours in three render modes: `ansi` (16-colour SGR), `tmux` (`#[fg=colourN]`, 256-colour) and `plain` (no colour) (`roleColor`). Chips use 256-colour (`38;5;231`, `48;5;214`). No depth detection; NO_COLOR: not present (mode is chosen by the caller).
4. Both: chip with background fill (padded to width, `claude-statusline.mjs:~125`), role text foreground-only.
5. Plain `sep`, default two spaces (`renderLine`); `·` inside chips.
6. Neighbours: role colour per item; width-priority dropping when narrow (`priority` field).
7. Chip text colour is chosen for contrast, with a source comment: dark ink on amber because white-on-amber(214) fails WCAG at ~1.9:1 (`claude-statusline.mjs:14-16`). No terminal-background detection.
8. Emoji heavy (`⌨️ 🧠 🕐 📅 💬`).
9. Priority-based dropping of segments by width.
10. Config via `loadConfig` (`config.mjs`; per-segment `enabled`, `order`); not otherwise read.

## agent-status-pills
https://github.com/mvfsillva/agent-status-pills (stars 2). Bash + python3 powerline "pills" with a Catppuccin rainbow, for Claude Code and Cursor.
1. By position: a gradient. `statusline.sh:361-410`: 14 Catppuccin accents in rainbow order (rosewater, flamingo, pink, mauve, red, maroon, peach, yellow, green, teal, sky, sapphire, blue, lavender). With n segments it picks `round(i*13/(n-1))` for segment i, so the first segment is rosewater and the last is lavender whatever the count. Three extra "ghost" arrows are inserted before the last segment, evenly interpolating the last two colours (`:395-407`). No colour depends on a segment's identity or value.
2. Four Catppuccin flavours as bash case blocks, `STATUSLINE_THEME` = `latte`, `frappe`, `macchiato`, `mocha` (default) (`:25-157`). Each defines 14 `BG_*`, 14 `FG_*` plus `FG_CRUST`. Chosen in `STATUSLINE_CONF` / `~/.claude/statusline.conf` / `~/.cursor/statusline.conf`. Users cannot define a new palette without editing the script.
3. Truecolor only (`38;2;` / `48;2;`), no fallback and no detection. NO_COLOR: not present.
4. Background-filled pills; text is the theme's crust colour (`FG_CRUST`, darkest) on every pill (`:415`).
5. Powerline: U+E0B0 arrow between pills, U+E0B6 round opening cap, U+E0B4 round closing cap (`:140-144`). Arrow fg = previous pill bg, bg = next pill bg (`_prev_fg` logic, `:420-424`).
6. Neighbours: every pill is the next hue step on the rainbow, so adjacent pills differ by hue (about 13/(n-1) steps apart), never by lightness.
7. Text is always dark `FG_CRUST`, so text contrast follows the flavour; no terminal detection.
8. Nerd Font icons (`󰧑`, `󰊚`, `󰉖`, `󰘬`, `󰡉`) and `⇅`.
9. Rainbow gradient across the bar; `python3` is required for the index maths.
10. `statusline.conf` setting `STATUSLINE_THEME`; `bin/install.js`; nothing else.

## claude-statusline-sh
https://github.com/nagameTW/claude-statusline-sh (stars 2). One bash script (`claude-statusline.sh`, 290 lines) with deliberately restrained colour.
1. State only: "Colour carries state, not decoration" (`:12`). Everything is `PRIMARY` (a light grey) unless a threshold is hit: `level_color` (`:80-84`) `WARN_AT=60` yellow, `BAD_AT=80` red; applies to the context percentage, the used part of the meters, and rate-limit percentages (`:196,248`). Model has a fixed accent `38;5;173` (terracotta) as `● ` plus bold name (`:219-221`); separators and "rest" of bars `MUTED` (dim, `2`).
2. Themes: not present as files, but it reads Claude Code's own theme: `CLAUDE_STATUSLINE_THEME` env, else `.theme` from `~/.claude.json`; `light*` switches `PRIMARY` to `38;5;236`, anything else `38;5;251` (`:69-74`).
3. State colours are the terminal's own ANSI 16 (`GREEN=32 YELLOW=33 RED=31 BLUE=34`) so they follow the user's palette; two 256-colour constants for accent and primary. NO_COLOR: honoured (`:131-134,172`).
4. Foreground-only.
5. Dim ` · ` (wide `  ·  `, tight ` · `) between segments (`:21-22`); segments drop right-to-left by priority when narrow.
6. Neighbours: separators only; all values share `PRIMARY`.
7. Yes: three grey steps (dim for structure, terminal default for labels, explicit light or dark grey for values) with the top step chosen from Claude Code's theme (`:13-18`, `:69-74`).
8. Unicode only: `●`, `/`, `·`; no emoji or Nerd Font.
9. Git info cached for 5 s.
10. Env `CLAUDE_STATUSLINE_THEME`, `NO_COLOR`; constants at the top of the script (`WARN_AT`, `BAD_AT`, ...).

## nalyk-skills
https://github.com/nalyk/nalyk-skills (stars 2). A collection of Claude Code plugins; the statusline is `plugins/statusline/scripts/statusline-command.sh` (147 lines).
1. No colour at all: the script contains no ANSI escapes (grep found none). Distinction is by glyph only: model badge `◆ OPUS` / `◇ SONNET` / `○ HAIKU` (`:134-139`), context indicator `◉ ≥60% remaining`, `◎ ≥30%`, `○` below (`:103-107`), vim mode icon, time-of-day icon `☀ ◐ ◑ ☽`.
2. Themes: not present for the statusline. (`plugins/superpowers-tracker/hooks/ui/theme.ts` with a Catppuccin theme belongs to a different plugin and was not read.)
3. Not applicable (no colour). NO_COLOR: not present.
4. Neither fill nor colour: plain terminal text.
5. Powerline glyphs as plain text: U+E0B0 after the model badge, U+E0B1 thin arrows between items, U+E0B2 before the time (`:8-10`, `:145-147`) inside a `╭─` prefix. They carry no colour, so they render as the terminal's text colour.
6. Neighbours: thin arrow glyphs only.
7. Not present.
8. Needs Nerd/Powerline font for the arrows; emoji `📂`; ▰▱ meter.
9. Meter `▰▱` (10 cells) from `remaining_percentage`.
10. None.

## agent-statusline
https://github.com/nathabonfim59/agent-statusline (stars 2). Go; statusline for Claude Code and Cursor, with a 5-role theme system.
1. By theme role. `theme.go:20-27` `ThemeColors`: `primary, text, success, warning, danger`. Use sites: model name `Primary` + bold (`claude_code/model.go:20`); context tokens `[N]` and cost `Text` (`model.go:25`, `cost.go:15`); context bar and percentage use `Success`/`Warning`/`Danger` by thresholds (`harness/harness.go:103-127`, default warn 50, danger 75, per-model override via `thresholds` map, `theme.go:resolveThresholds`); rates and context-size hints `Dim` (`rates.go:24`, `model.go:22`); separator `|` dim (`main.go:19`). The bar draws a `┃` marker in `Danger` at the danger threshold with green/yellow/red segments (`harness.go:100-115`).
2. Seven built-in YAML themes embedded from `themes/*.yaml`: default, catppuccin (Mocha), dracula, jetbrains, monokai, oggu, onedark. Format: `name` + `colors: {primary,text,success,warning,danger}`. Users add `~/.config/claude-statusline/themes/<name>.yaml` (local overrides built-in with the same name, `loadTheme`); `init` command writes a sample config.
3. A role value is `cyan|green|yellow|red|white|dim|bold|reset` (ANSI 16), `#RRGGBB` (truecolor, `38;2;r;g;b`), or a raw escape string (`resolveColor`, `theme.go:~180`). No depth detection or downsampling; NO_COLOR: not present. Default theme is all ANSI 16.
4. Foreground-only.
5. Plain dim `|` between blocks. Blocks are listed per line (`blocks.line1/line2/compact`).
6. Neighbours: dim separator; hue by role.
7. Not present; `default` uses terminal ANSI colours, so it follows the terminal palette.
8. Unicode block glyphs; `bar.brackets` option.
9. Per-model thresholds; per-harness block lists (`claude_code`, `cursor`) with `extends`.
10. `config.yaml` (`theme`, `thresholds`, `blocks`, `bar`, harness overrides); `init`.

## claude-code-statusline (nidelson)
https://github.com/nidelson/claude-code-statusline (stars 2). Bash widget framework; the core applies a per-widget colour and widgets may colour themselves.
1. Mixed. Brand-fixed model: Claude models get `SL_BRAND` truecolor coral `#D97757` (`lib/colors.sh:12`, `widgets/model.sh:27-30`); other models magenta. Widgets declared with `--color`: branch cyan (`branch.sh:30`), repo yellow (`repo.sh:32`), worktree magenta (`worktree.sh:15`). Widgets declared `--self-color` paint themselves by state: context bar and percent (`context.sh`: green/yellow/red by threshold; bar cells are a per-position green to yellow to red truecolor gradient computed in RGB, `r=220*pos/50`, ... with a dim track), cost (green/yellow/red by cents, user colour override, `cost.sh:61-87`), cache (countdown red/yellow/green, hit% >=70 green, >=30 yellow, else red, `cache.sh:128-215`), flow/forecast (red/yellow/green on `SL_FLOW_CRIT/WARN`, `flow.sh:126-129`), git-status (yellow dirty `●`, green `↑`, red `↓`, `git-status.sh:79-89`), velocity (green `+`, red `-`).
2. Themes: not present. `lib/colors.sh` has a fixed palette of 7 names: red, green, yellow, blue, magenta, cyan, dim (`:21-27`).
3. ANSI 16 names plus one truecolor (brand coral) plus truecolor RGB for the context bar. The comment says terminals lacking 24 bits "ignore the sequence" and fall back to default text colour. No depth detection. NO_COLOR: not present.
4. Foreground-only.
5. Configurable `separator` (`lib/config.sh`), default dim; no powerline.
6. Neighbours: different hue per widget, plus a configurable separator.
7. Not present.
8. Emoji and Nerd Font glyphs (`icons` config flag `SL_CONFIG_ICONS`, default on; model uses Unicode `✻`/`◆` "not Nerd Font" so it works anywhere, `model.sh:25`).
9. Positional gradient in the context bar; colour resolution designed to avoid a subshell per widget for speed (`colors.sh:14-20`, a 3-second hang fix).
10. JSON config (`lines`, `separator`, `icons`, per-widget `color`/options) read by `lib/config.sh`; widgets as files.

## claude-statusline-gitgraph
https://github.com/NowhereMan-in-Galaxy/claude-statusline-gitgraph (stars 2). Python statusline that draws a git branch graph (per-branch rows) in Claude Code.
1. By git role, with a lane colour per open branch. `gitgraph.py:39-100` each theme defines keys `trunk, lanes[], head, ahead, behind, sync, dirty, merged`. `default`: trunk 75 (blue), lanes cycle through pink 176, green 114, amber 179, steel 110, head bold 222, ahead green 114, behind 174, sync 110, dirty 179, merged none (the lane colour dimmed).
2. Six themes (`THEMES`, `:39-100`): `default`, `gold` (black and gold), `mint` (silver and green), `quiet` (colour only for what needs doing), `colorblind` (Okabe-Ito, no red/green pairs), `terminal` (the terminal's own 16 colours). Light-background variants in `LIGHT` (`:71-91`) for the themes that have one (gold and mint are dark-only). Selected by `--theme=NAME`, `GITGRAPH_THEME`, or a saved `~/.config/gitgraph/theme` (`gitgraph theme NAME`); a `themes` command previews all (`:1239`). User-defined themes: not present.
3. 256-colour indexes (`38;5;N`) and, for `terminal`, plain 16. `use_color` (`:196-203`) respects `--no-color`, `NO_COLOR`, and non-TTY output unless in the status line. No downsampling.
4. Foreground-only.
5. Git-graph glyphs are the structure; no separators.
6. Neighbours: lanes cycle through different hues (default); `quiet` uses one hue for all lanes.
7. Yes: `appearance()` (`:144-165`) = `GITGRAPH_APPEARANCE`, then `COLORFGBG`, then the OS setting (`defaults read -g AppleInterfaceStyle` on macOS and equivalents), then selects the `LIGHT` variant of the theme (`:169-172`).
8. Box-drawing / graph glyphs; Chinese and English text (`tr()`).
9. Colour-blind theme; `docs/themes.svg` gallery; multilingual output.
10. CLI: `theme NAME`, `themes [PATH]`, `--theme=`, `--no-color`, `--color`, `--statusline`; env `GITGRAPH_THEME`, `GITGRAPH_APPEARANCE`, `NO_COLOR`.

## ccbar
https://github.com/oaooao/ccbar (stars 2). Go; statusline with bars for context and rate limits.
1. By threshold: `render.go:88-130`. Context bar (`━`) >=80 red, >=60 yellow, else cyan; rate bar (`▰▱`) >=80 red, >=60 yellow, else bright blue (256: 75); percentage number `pctColor`: >=80 bold red, >=60 yellow, else `Text`. Labels use `th.Label`; empty bar `BarEmpty`; secondary text `Secondary`; separators `Muted`.
2. Two themes in `render.go:10-70`: `darkTheme` and `lightTheme`, a struct of named slots (Reset, Bold, White, BoldWhite, Cyan, Green, Yellow, Red, BoldRed, BoldYellow, Magenta, BrightBlue, Text, Secondary, Muted, BarEmpty, Label). The light theme swaps in darker 256-colour values (`38;5;28` green, `160` red, `130` amber, `26` blue) and greys (`241/244/248/253`). Selected with `--theme dark|light` (`config.go:33-37`, default dark). User-defined themes: not present.
3. Mix of ANSI 16 (dark theme) and 256-colour (`38;5;N`). No depth detection or NO_COLOR (not found in render.go).
4. Foreground-only.
5. Computed separators from theme (`render.go:80`), plain text.
6. Neighbours: separators and labels.
7. Explicit light/dark split: the `White` slot is black in `lightTheme` (`:54`), greys change. No auto-detect: user passes `--theme light`.
8. Unicode bar glyphs `━ ▰ ▱`; emoji sparingly.
9. `--locale en|zh` date format; `--hide` segments.
10. CLI flags `--theme`, `--locale`, `--hide`; no config file styling.

## sketchybar-clawd
https://github.com/oauramos/sketchybar-clawd (stars 2).
not a Claude statusline: a macOS SketchyBar menu-bar widget showing one animated pixel "clawd" per Claude Code session (working, waiting, asleep), driven by hooks.

## claude-agentline
https://github.com/odere-pro/claude-agentline (stars 2). TypeScript; the most structured of this batch: widget families, semantic palette roles, powerline, colour-depth downsampling, Ink TUI picker.
1. Fixed per widget family, overridden by state. `src/widgets/families/family-identity.ts:36-41`: session blue, tokens yellow, context magenta, rate-limits red, git green, other cyan; each family also has a glyph (`⌂ ◇ ◰ ◔ ⎇ ○`) and an ASCII form (`[s] [t]...`). Fg precedence (`src/widgets/render-widget/render-widget.ts:61-72`): explicit `config.fg` > a state-signal cell's own fg (git clean/dirty, token/context threshold, effort) > family accent > cell fg. Signal roles per `docs/themes.md`: `git-clean`/`git-dirty`, `tokens-low`/`tokens-mid`/`tokens-high`, `warning`, `danger`, `accent` for session widgets, `info` for context/tokens (low).
2. Five bundled JSON themes in `themes/`: `claude-code-dark`, `claude-code-light`, `high-contrast`, `ansi-minimal` (named ANSI only), `midnight`. Format is a semantic palette of 13 required roles (`accent, info, success, warning, danger, muted, git-clean, git-dirty, tokens-low, tokens-mid, tokens-high, bg-section, bg-emphasis`) plus optional `fg`, `bg`, `effort-ultracode` (`docs/themes.md:76-100`, `schemas/theme.schema.json`). Missing roles fall back to compiled defaults. Users add `${CLAUDE_CONFIG_DIR:-$HOME/.config}/agentline/themes/<name>.json`; themes can carry powerline `caps`. Select via config `theme` or env `AGENTLINE_THEME`.
3. A colour is a named ANSI (16 names), `colour:N` (0-255), or `#RRGGBB` (`src/data/theme/colours/colours.ts`). Depth detection (`src/render/render/colour-depth/colour-depth.ts`): `COLORTERM` truecolor/24bit then `TERM` `*-256color` then 16 then none; hex is quantised to the nearest 256 index or named colour. NO_COLOR and `--no-color` honoured (documented in `docs/themes.md:171`).
4. Both: foreground by default; with powerline each cell gets a background (`bg-section` when unspecified, `transform.ts:84-95`).
5. Powerline opt-in (`powerline.enabled`): configurable glyphs `hardRight/softRight/hardLeft/softLeft`, `caps.start`/`caps.end` (cycled per line with `idx % length`, `transform.ts:57-71`). Arrow fg = previous cell bg, bg = next cell bg; if two adjacent cells share a bg, the chevron uses the cell's fg so it stays visible (`transform.ts:147`). Without a Nerd Font it falls back to ASCII `>` `<` (`AGENTLINE_GLYPHS=ascii`). Non-powerline: `separator` and `padding` from config.
6. Neighbours: in powerline mode every cell without an explicit bg gets the same `bg-section`, so neighbours are told apart by the chevron and by foreground family hue, not by background. Per-widget `bg` overrides are available.
7. A light theme is bundled (`claude-code-light`, warm cream) and a high-contrast one; selection is manual. No automatic terminal-background detection or readable-text calculation found.
8. Family glyphs with ASCII fallback; Nerd Font powerline glyphs with ASCII fallback; `src/tui/tui/glyphs/glyphs.ts` for the picker.
9. An Ink TUI editor/picker and live preview using the same colour path; `agentline doctor` checks (`d04-themes-installed`, `d08-render-fixture`); fixture replay to preview degraded depths (`COLORTERM= TERM=xterm-256color agentline render --fixture`); docs have per-theme SVG screenshots (`docs/themes/claude-code-dark.svg`).
10. JSON config (`theme`, `powerline`, `families` overrides per family `{glyph, glyphAscii, colour}`, per-widget `fg`/`bg`), TUI, env `AGENTLINE_THEME`, `AGENTLINE_GLYPHS`, `--no-color`, `NO_COLOR`, JSON schemas in `schemas/`.

## glint
https://github.com/oleg-koval/glint (stars 2). Python; one-line status with topic groups; also supports Codex and tmux.
1. Fixed per segment with thresholds. `glint.py:40-50` 256-colour palette: CORAL 209 (model badge), BLUE 75 (directory), GREEN 114 (git clean, cheap, added), YELLOW 179 (git dirty, mid cost), RED 174 (behind, expensive, removed), GOLD 220 (cost), DIM 244 (separators, labels), PURPLE 141 (worktree), CYAN 80 (hydration), RULE 242. Branch green clean / yellow dirty (`:1029`); cost green <$1, gold <$5, else red (`:1055`); context percentage green <60%, yellow <85%, else red (`:88`); effort badge by what it costs: low/medium green, high gold, xhigh/max red (`:441-448`); `+N/-N` green/red; behind red.
2. Themes: not present.
3. 256-colour only (`\033[38;5;Nm`, `c()` at `:80`). No detection; NO_COLOR: not present (no occurrence). `to_tmux()` (`:906-918`) rewrites the SGR into tmux `#[fg=colourN]` for a tmux status line.
4. Foreground-only.
5. Within a topic group a two-space gap in DIM; between groups a `  ┃  ` rule in colour 242, "dimmer than any data" (`:93-103`). Topic groups: session, place, change, budget, rest (`GRP_*`).
6. Neighbours: grouping with a faint rule, plus different hue per segment; width-priority dropping (`PRIO_*`).
7. Not present.
8. Heavy emoji prefixes (`📁 🌿 🌳 💰 🧠`), OSC 8 hyperlinks (`:242`); no ASCII mode found.
9. Break and water nudges that escalate; PR segment; each segment toggled by `GLINT_<NAME>=0`.
10. Environment variables `GLINT_*` (per segment off, `BARS` opt-in); `install.sh`, `install-codex.sh`.

## claude-code-statusline (OleksandrCEO, fork of danielmackay)
https://github.com/OleksandrCEO/claude-code-statusline (stars 2). Fork-differences only. The parent's file is `statusline-command.sh` (92 lines, POSIX sh); the fork replaced it with `statusline.sh` (131 lines, a `python3 -c` body).
Parent styling: ANSI 16 green/yellow/red (`statusline-command.sh:28-31`), rate-limit text coloured by threshold (>=90 red, >=70 yellow, else green, `:72-78`), plain `█░` bar.
1. Differs: only the 5h rate-limit element is coloured. `statusline.sh:~75-80`: >=90 red 256 `160`, >=70 orange `214`, normal state grey `\033[90m` (the parent used green for normal). Model, context % and tokens uncoloured.
2. Themes: not present.
3. 256-colour red and orange, ANSI grey, one truecolor `38;2;60;60;60` for the eaten-pacman dots. No detection or NO_COLOR.
4. Foreground-only.
5. Plain ` | ` between emoji-labelled parts.
6. Neighbours: separator only.
7. Not present.
8. Emoji `🌳 🌿 🦥 ⏱️ ⚡`.
9. New: `--bar=pacman` (default), `--bar=none`, or the parent's block bar; the pacman `ᗧ` marker takes the threshold colour with dim `·` trail and `•` pellets ahead. New flags `--tokens` and `--ollama` (shows GPU/CPU placement of a local model).
10. CLI flags `--tokens`, `--bar=`, `--ollama`; no config file.

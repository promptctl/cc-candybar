## modz
URL: https://github.com/katipally/modz (stars 0)
Claude Code "mod" collection (Ink/React tiles in a band above the prompt), not a classic stdout statusline. Styling is read from `mods/ui/*/hooks/register.tsx`.
1. Colour per segment: fixed identity tint plus state override. `usage-limits/hooks/register.tsx:87-89`: `TINT = 'claude'` (Claude's own theme key) for labels; `tone(pct, calm)` returns `error` at >=85, `warning` at >=60, else calm colour. `cache-timer/hooks/register.tsx:167-170`: hit% is `claude` at >=90, `warning` >=70, else `error`; countdown `success` while warm, `error` when cold. `model-info/hooks/register.tsx:141`: model name bold `claude`. Placeholder `–` is `dimColor`.
2. Themes: none of its own. Colours are theme keys of the host (`claude`, `success`, `warning`, `error`, `inactive`, `subtle`), so Claude Code's theme decides the actual hex. No user themes. The `catppuccin` hit is not a theme (buddy sprite pixel palette).
3. Colour spec/depth: semantic key names only (plus 0xRRGGBB ints in the mascot, `buddy/hooks/clawd-term.tsx:17-32`). No depth detection, no NO_COLOR handling: not present (host renders).
4. Fill: foreground-only text; no background-filled cells (mascot uses half-block glyph colours).
5. Separators: plain ` · ` dim text between values (`usage-limits` line 171). No powerline.
6. Neighbours: separate rows/columns in a tile grid (`modz-lead`/`modz-left`/`modz-right` Boxes), labels padded to 5 cols; identity tint `claude` for every label, so no per-segment hue.
7. Light/dark: delegated to host theme keys; no contrast code. unverified beyond that.
8. Glyphs: Unicode blocks `█░`, sparkle chars, mascot sprite; no Nerd Font, no ASCII mode.
9. Other: animated pixel mascot "Clawd" (`buddy/hooks/clawd*.ts`) with per-activity colour table `DOING` (think grey `b8bcc4`, edit yellow `f5c542`, read mint `7fd1ae`, git orange `f0883e`, ...) - fixed colour per activity. Spinner for running agents.
10. Customisation: plugin install/enable per mod; slash commands per mod; no colour config. README only lists mods.

## claude-code-weekly-statusline
URL: https://github.com/kaushikhegde11/claude-code-weekly-statusline (stars 0)
1. By threshold, same ramp for every bar: `statusline.sh:46-48` `<50` cyan `\033[36m`, `<80` yellow `\033[33m`, else red `\033[31m`. Model name bold only (`BOLD`, line 35,58). Labels (`SESH`, `7D`, `CTX`) uncoloured.
2. Themes: not present.
3. Colour: ANSI 16 only (36/33/31). No depth detection, no NO_COLOR: not present.
4. Fill: foreground-only; bar made of `█` coloured and `░` (same colour, line 44-45).
5. Separators: none; three stacked lines (model / SESH bar / 7D bar), labels padded to 5 columns (line 37-41).
6. Neighbours: separate lines, not distinguished by colour.
7. Light/dark: not present.
8. Glyphs: `█░` only; no icons.
9. Day counter `Xd/7d` prefix on weekly line (`week_day_prefix`, line 32). No animation.
10. Customisation: edit the script; no config.

## claude-powerline (KawaiiLLM fork of Owloops/claude-powerline)
URL: https://github.com/KawaiiLLM/claude-powerline (stars 0). Not tagged FORK OF in the batch, but README line 20 says it is a personal fork of Owloops/claude-powerline v1.23.5. Whole styling pipeline is upstream's; fork-specific parts called out.
1. Per segment name from a theme: `src/themes/index.ts` `ColorTheme` has one `{bg, fg}` for each of directory, git, model, session, block, today, tmux, context, contextWarning, contextCritical, metrics, version, env, weekly, cacheHit, fiveHour. e.g. `dark.ts`: directory bg `#8b4513`/fg white, git bg `#404040`/fg `#cba8e8`, model fg `#fd3e74`. State: context swaps to `contextWarning` / `contextCritical` chips (dark: bg `#d9820e`, `#f59e0b`, dark text; nord: `#d08770`, `#bf616a`); budgets use `warningThreshold` default 80 (README 538-548). FORK ADDITION: for themes `dark` and `white`, backgrounds are overwritten BY POSITION: `src/powerline.ts:61-75,436-439,466-488` `cycleBackgrounds` repaints each kept chip from a 3-step cycle (`DARK_BG_CYCLE = #1a1a1a #2a2a2a #3a3a3a`; `WHITE_BG_CYCLE = #f3f5fc #e4eaf8 #d5def2`), skipping chips whose luma is outside a gate (alert chips and the warm directory anchor) so they keep popping. Comment: per-name bgs flatten when many segments are on; cycling by position keeps every neighbour a clear step apart.
2. Themes: 7 bundled (`dark, light, white, nord, tokyo-night, rose-pine, gruvbox`) + `custom` (README 111,137). Format = per-segment-name `{bg, fg}` hex map; each theme exists in three tiers (`darkTheme`, `darkAnsi256Theme`, `darkAnsiTheme`), picked by detected depth (`themes/index.ts` imports). Users define `theme: "custom"` + `colors` map in JSON (README 642-664). Fork: `dark`/`light` are an fg<->bg inversion pair from a 13-colour "rainbow-streak" palette (`dark.ts` header comment), `white` new.
3. Spec/depth: hex in config (`bg` hex, `transparent`, `none`; `fg` hex). `src/utils/colors.ts:81-195` `getColorSupport()` -> none|ansi|ansi256|truecolor from `NO_COLOR` (>=86), `FORCE_COLOR` 0/1/2/3 (90-99), `COLORTERM`, TERM `-256color`, tty `hasColors`. `hexTo256Ansi`, `hexToBasicAnsi` downsample. `NO_COLOR` honoured; FORCE_COLOR outranks it (README 677). Config `colorCompatibility: auto|ansi|ansi256|truecolor`.
4. Fill: background-filled chips with fg text (`powerline.ts:formatSegment` 960+); `bg: transparent|none` allowed.
5. Separators: styles `minimal` (none), `powerline` (arrow ``), `capsule` (rounded caps, cap fg = chip bg via `extractBgToFg`), `tui`. Arrow: fg = this chip's bg, bg = next chip's bg (`powerline.ts:997-1000`); last arrow on terminal bg. `charset=text` swaps to ASCII symbols (`TEXT_SYMBOLS`).
6. Neighbours: different bg per segment name in most themes; in `dark`/`white` position-cycled lightness steps of one neutral hue (see 1); capsule style adds a space gap. Chevrons rely on contrast; comment notes two near-black tones barely differ in WCAG contrast so range widened to #1a1a1a..#3a3a3a.
7. Contrast/light-dark: separate `light` and `white` themes; fork's effort label colours picked from chip luma (`renderer.ts:255-303`: luma>=140 -> "light" deeper rainbow/tones, chroma>=80 && 70<luma<190 -> keep plain fg). `lightdark.words` is only theme naming; no terminal-background detection.
8. Glyphs: Nerd Font powerline symbols by default; `--charset=text` ASCII fallback; emoji/box symbols per segment (`SYMBOLS`).
9. Other (fork): model segment shows live `/effort` level coloured like Claude Code's own: low/medium/high flat semantic colours, `xhigh` violet base with a moving glint, `max` scrolling 7-colour rainbow (`renderer.ts:200-303`, `CC_RAINBOW` = Claude Code's rainbow_red..violet RGB, `CC_RAINBOW_DEEP` halved luminance for pale chips); tick-based so animated only when Claude Code redraws. Screenshots in `images/`. Two-tier alert escalation (caution pale -> urgent saturated, same hue).
10. Config: `.claude-powerline.json`, CLI flags (`--theme --style --charset`), env `CLAUDE_POWERLINE_THEME/STYLE`, interactive wizard; segment display styles (`text`, bars) per segment.

## session-dashboard
URL: https://github.com/KeaneCloud/session-dashboard (stars 0)
not a Claude statusline: a Claude Code mod that adds a Sessions pane (list of open sessions with status lights, progress bars, usage). For the record: fixed status colours `hooks/lib.js:310,633` (`done #2f8f4e, warn #e07a10, bad #c8222b, running #0088b0, todo #a9a5a3`; `LIGHT` map for the status dot), SVG drawn, no themes, no separators.

## cc-statusline (KenKinCOM)
URL: https://github.com/KenKinCOM/cc-statusline (stars 0). Modified fork of ohugonnot/claude-code-statusline plus a ccstatusline config (README line 5).
1. Main script `hooks/statusline.sh`: no colour at all. No ANSI escapes in the file (`grep -c $'\033'` = 0). `make_bar` (72-86) sets `BAR_COLOR` to the Chinese strings `充足/适中/紧张` (<50/<80/else), but they are only stored into `CTX_COLOR`/`WEEK_COLOR` and never printed, i.e. a translation pass replaced the colour codes; the output is monochrome text. Pre-edit severity survives only as the header sample `🟢 Ctx ▓▓▓░░░ 42%` (line 8), emoji dots, not emitted now. Alternative `ccstatusline/settings.json`: fixed per widget names - model cyan, session-usage green, block-timer brightBlack, weekly-usage yellow, context-percentage brightBlack, git-branch magenta.
2. Themes: ccstatusline `powerline.enabled:false`, no theme set; script has none.
3. Spec/depth: ccstatusline named 16 colours, `colorLevel: 2` (256). Script: none; no NO_COLOR.
4. Fill: foreground only.
5. Separators: script ` │ ` plain; ccstatusline `separator` widgets, powerline off (`separators: [""]`, no caps).
6. Neighbours: separators only.
7. Light/dark: not present.
8. Glyphs: emoji (🌿, ⏳, ⏱), `▓░` bars, Chinese labels.
9. Remaining quota shown rather than used; stale marker ⚠.
10. Config: env vars (`TIMEZONE, REFRESH_INTERVAL, SHOW_WEEKLY, USAGE_FILE`); ccstatusline JSON; installer.

## kensei-claude-plugins
URL: https://github.com/KenseiTheOne/kensei-claude-plugins (stars 0). Statusline lives in `plugins/kensei-statusline/scripts/statusline.py`; the other files hit by the scanner belong to a toolkit plugin (diff tour, SVG diagram) and are not statusline styling.
1. Mixed: state/threshold plus fixed. `statusline.py:110-115` `pct_color`: >=80 red, >=50 yellow, else green, applied to context bar and usage rows (`:118,212`); `SEVERITY_COLOR` warning yellow / critical red (140, 160). Fixed: branch bold blue (497), staged `●` green, modified `+` yellow, untracked dim, clean `✓` green, ahead `⇡` cyan, behind `⇣` magenta (501-516); agents bright magenta `\033[95m` (561); token arrows cyan/magenta (571); added green / removed red (390); separators dim `│`.
2. Themes: not present.
3. Colour: ANSI 16 SGR codes only (`\033[3Xm`, `[9Xm`, `[2m` dim, `[1m` bold). No depth detection, no NO_COLOR: not present.
4. Fill: foreground only.
5. Separators: dim `│` (U+2502) plain text.
6. Neighbours: semantic colours by content type; separators.
7. Light/dark: not present (relies on terminal's 16-colour palette).
8. Glyphs: Unicode only (`●✓⇡⇣↑↓`); `glyph.nerd_font` hits are from other plugins' files.
9. Cost shows `$n/a` in dim when unknown (378-380).
10. Config: plugin `setup` skill; usage via `usage.py`; no colour options.

## claude-status-line (kensteele)
URL: https://github.com/kensteele/claude-status-line (stars 0)
1. Mostly fixed per segment, with threshold colour for context. `statusline-command.sh:42-56` palette (256-colour fg): repo dim cyan `C_CYAN 81` (line 136), branch bold purple `C_PURP 183` (141), compactions `⟳` cyan + white count (146), model dim grey `◆` (`C_DIMW 245`), cost green-ish `C_COST 84`, agents `⚙` yellow + white names, separators `C_GRAY 239`. Context bar: `set_color` (67-74) level 0 green 78, 1 yellow 220, 2 orange 208, 3 red 196, level from `cc_context.severity` (`lib/cc_context.py:299-315`): worse of ratio to auto-compact threshold (<50/75/90%) and ratio to a 200K recommended ceiling (50%/95%/at-tick).
2. Themes: not present.
3. Colour: ANSI 256 fg (`\033[38;5;Nm`), bold/dim. No NO_COLOR, no detection (env 256color hits are comments).
4. Fill: foreground only.
5. Separators: `sep()` line 64: two spaces, gray `│`, space.
6. Neighbours: different hue per segment type + gray separators.
7. Light/dark: not present (greys chosen for dark terminals).
8. Glyphs: Unicode (`⎇ ⟳ ◆ ⚙ ⟨ ⟩`), bar uses `━ ╸ ─` heavy/light lines with a tick `┆` marking the compaction threshold (84-100); no emoji, no Nerd Font.
9. Context bar's tick shows the auto-compaction point; bold colour run-length coalescing of escapes (line 95).
10. Config: none visible; edit script; a context-pressure hook in `hooks/`.

## context-bonsai
URL: https://github.com/KerbalTheGathering/context-bonsai (stars 0)
Plugin + Electron/Tk desktop widget; the statusline is a 70-line script `plugin/statusline/statusline.py`, the rest is the widget.
1. Statusline: by threshold. `statusline.py:7-21` `GREEN/AMBER/RED/DIM` ANSI 16; `stage(pct)`: <35 🌱 green, <66 🌿 green, <80 🌳 amber, <92 🍂 amber, else 🍁 red (context %); `color_for`: <60 green, <85 amber, else red for 5h/7d percentages; branch dim `⎇`. Labels uncoloured.
2. Themes (widget only, `desktop/shared/themes.js`): 13 bundled named themes (Moss, Paper, Sakura, Midnight, Sumi-e, Night Ink, Aurora, Frost, Canyon, Clay, Neon, Pixel, ...). Format = semantic palette roles `panel, wall, ink, muted, line, pot, wood, soil, moss, bark, ok, warn, crit, glow` + `stops` (context-fill, hue, sat%, light%) gradient for leaf colour + `style` (diorama/glass/ink). Statusline does not use them. User-defined themes: unverified.
3. Colour: statusline ANSI 16; widget hex/HSL. No NO_COLOR.
4. Fill: statusline foreground only.
5. Separators: ` · ` dim.
6. Neighbours: separator only.
7. Light/dark: widget has light (`Paper`, `Sumi-e`) and dark themes with per-theme palettes; statusline not present.
8. Glyphs: emoji stages.
9. Other: leaves' colour is a gradient over context fill (hue stops per theme); animations in widget.
10. Config: widget settings (`desktop/main/config.js`); statusline none (`--log` flag only).

## claude-context-bar
URL: https://github.com/keremozkefeli/claude-context-bar (stars 0)
1. By threshold of tokens used (not percent): `terminal/statusline-command.sh:25-40` <50k green `\033[32m` + ✅, <80k yellow + ⚠️, <95k orange `\033[38;5;208m` + 🛑, else red + 🚨. Fixed: model cyan, token counts bright white `\033[97m`, note dim (44-46). Mod version `hooks/format.ts`: plain text, colour via emoji squares 🟩🟨🟧🟥 + ⬜ (header comment: "colour comes from emoji squares instead of ANSI codes").
2. Themes: not present.
3. Colour: ANSI 16 + one 256 index (208). No NO_COLOR/depth detection.
4. Fill: foreground only (script); emoji squares in mod.
5. Separators: two spaces, no glyph.
6. Neighbours: different colours per field; spacing.
7. Light/dark: not present.
8. Glyphs: emoji status icons; `█░` bar (15 cells) or emoji squares (10 cells).
9. The "smart zone" idea: bar fills to 100k tokens then everything beyond is "dumb zone".
10. Config: none (constants `SMART_MAX=100000`).

## ferrisbar
URL: https://github.com/kerryhatcher/ferrisbar (stars 0)
1. Context bar by threshold; everything else dim. `src/layout.rs:1-7` consts DIM, BOLD, GREEN `32`, YELLOW `33`, ORANGE `38;5;208`, BLINK_RED `5;31`; `src/context_bar.rs:36-47`: used < `threshold_yellow` green bar, < `threshold_orange` yellow, < `threshold_critical` orange, else blinking red with `💀`. In `compose_statusline` (`layout.rs:9-33`) directory, branch, model, cost dim; task bold. README: budget bars coloured the same way.
2. Themes: not present.
3. Colour: ANSI 16 + one 256 index; blink attribute `5;31` is unusual. No NO_COLOR / depth detection found.
4. Fill: foreground only.
5. Separators: plain ` │ ` with the glyph dim where it joins ctx/cost.
6. Neighbours: dim text with one coloured item.
7. Light/dark: `lightdark.words=1` is README logo `prefers-color-scheme`; statusline: not present.
8. Glyphs: `█░` bar of `bar_width`, `💀`.
9. Blinking red at critical context (`BLINK_RED`).
10. Config: TOML `~/.config/ferrisbar/config.toml` (`[display]` thresholds `threshold_yellow/orange/critical`, `bar_width`, budget, analytics).

## claude-tamagotchi
URL: https://github.com/kethoo/claude-tamagotchi (stars 0)
A virtual pet, shown in a one-line statusline (`plugins/pet/scripts/lib/render.js:360-374`) and a panel. Styling-relevant code is thorough.
1. Fixed colours by role from one named palette `C` (render.js:14-19: green `#5BD27A`, red `#FF5C6C`, cyan, purple, orange, yellow, gray, blue, pink, magenta, text `#E6E6F0`, dim, faint, accent `#C9A7FF`, border, track). Stat bars (`mini`, 363-366): happiness green, energy cyan, fullness yellow, turning red below 25. Level text accent bold; bubble gray.
2. Themes: pet colour schemes only (`sprites.js:117-123` THEMES calico/gray/orange/black/snow/mint, per-part hex `o w p k e h`); UI palette not themable. The `catppuccin` hit is not a UI theme. User themes: not present.
3. Colour: hex palette; `render.js:8-13,28-35` truecolor if `COLORTERM` matches truecolor|24bit (or Windows without TERM), else downsample to 256 via `to256`. `NO_COLOR` in env disables all escapes and swaps pixel art to `█▀▄` (lines 13, 33, 37-39, 132-134). Best-practice reference.
4. Fg and bg both: sprite drawn with half-block `▀` using fg for top pixel and bg for bottom pixel (line 132).
5. Separators: box-drawing frames `╭─╮`, `│`, `├──┤` in `border` colour for the panel; statusline uses spaces.
6. Neighbours: n/a (pet art).
7. Light/dark: not present.
8. Glyphs: emoji species/icons, box drawing, pixel half-blocks; ASCII-art plain mode (`plain()` render.js:287+) when colour/pixels unavailable.
9. Animation: moods, blink, hat; level-up sparkle.
10. Config: pet name/species/theme via commands (`/pet:*`), state in JSON; `NO_COLOR` env.

## kgtools
URL: https://github.com/kgkylegilhooly/kgtools (stars 0). Repo of tools; the Claude statusline is `statusline/statusline.js`.
1. Mixed fixed + threshold: `statusline.js:10-17` 256-colour consts; cwd blue `38;5;39`, branch green `114`, model purple `177`, tokens and cost yellow `179`, separator ` | ` grey `245` (lines 139-150). Context gauge `gauge()` (114-121): pct>=0.85 red `203`, >=0.6 yellow, else green; empty cells dim `░`.
2. Themes: not present (the `harbor` theme is `themes/harbor.css`, unrelated).
3. Colour: ANSI 256 only; no NO_COLOR.
4. Fill: foreground only.
5. Separators: plain grey ` | `.
6. Neighbours: distinct hue per field class.
7. Light/dark: not present.
8. Glyphs: `⎇`, `█░`.
9. Transcript-derived token total cached per session.
10. Config: none (edit script).

## woo-mods
URL: https://github.com/kgrvGRECO/woo-mods (stars 0)
Two Claude Code mods (usage-band, pocket-pet). Not a statusline: `usage-band` draws an SVG usage panel above the prompt (Korean UI); relevant styling in `usage-band/hooks/panel.ts`.
1. Fixed per provider/window + threshold: `PROVIDER` colours Claude `#d97757`, Codex `#3b6fe0`; badge colours per window (`badgeColor`: Claude 5h `#e2772e`, weekly `#a8502c`, per-model weekly `#7c4dff`; Codex `#4f86f7`/`#2a4fbf`); `levelColor(pct)` (line 47): <50 `#1f9d55`, <80 `#e8890c`, else `#e5484d`; pace text red/green/tan (`paceOf`, 86-88).
2. Themes: none; single palette; light/dark via CSS `@media (prefers-color-scheme: dark)` swaps fills (panel.ts:178-185).
3. Colour: hex in SVG; no ANSI. No NO_COLOR.
4. Fill: filled SVG rects (segmented bars, badges).
5. Separators: whitespace/hairlines; no glyph separators.
6. Neighbours: provider colour per row; bar segments.
7. Light/dark: yes, via `prefers-color-scheme` CSS class swaps (e.g. `.mut`, `.cf`, `.trk`).
8. Glyphs: pixel-art text via custom font `neodgm-font.ts` (Korean bitmap font) in SVG.
9. Bar of discrete segments (`SEG_W`) coloured by level; pace marker.
10. Config: slash command `/usagebar` (two lines / one / hidden); pet via `/plugin configure`.

## cc-usage-statusbar
URL: https://github.com/KhaiStimpson/cc-usage-statusbar (stars 0)
Mod drawing a band above the prompt (terminal text and SVG on desktop); not stdout.
1. By state: `hooks/svg.ts:5-10` `SVG_COLOR` calm `#4f9e6a`, warm `#d4923a`, hot `#d9563f`, ctx `#6f8fbf`; README: amber from 70% (80% for spend) or when ahead of pace, red from 90% (95% spend); cache part dim -> amber in last minute -> red when lapsed. Labels quiet grey `SVG_QUIET #8a877f`.
2. Themes: `model.ts:489-493` `ACCENTS`: `default`, `violet` (terminal `#a79cf7`/svg `#8b7fe8`), `orange`, `rose`; theme only replaces the "calm" and ctx colour with the accent, amber/red never change (`register.tsx:93-98` `applyTheme`). Not user-definable beyond these 3 (`/usagebar theme`).
3. Colour: hex; SVG rgba. No NO_COLOR; `prefers-reduced-motion` honoured (svg.ts:47).
4. Fill: styles `pulse` (bars fg only), `chips` (pill with coloured fill behind the text: grey calm, amber, red; calm pill = accent at 0.45 alpha), `ledger` (column with bar under label). Four styles total.
5. Separators: spaces, hairline rules in pane (`svg.ts:328`).
6. Neighbours: quiet grey calm state means neighbours differ only when one becomes loud; chips style differentiates by pill fill.
7. Light/dark: fills "that read on both the desktop's light and dark themes" (svg.ts:4); text `prefers-color-scheme` swap (315-316); white digits with dark outline halo for text on tinted fill (192).
8. Glyphs: eighth-block bar chars (`▅▃`), `┃` pace marker; terminal fills by eighths of a cell.
9. Animations: sheen on bars, breathing pace marker, pulse dot while a turn runs (disabled for reduced motion); sparkline chart of daily spend.
10. Config: slash command `/usagebar style|theme|show|hide|budget`, plugin options.

## agent-statusline
URL: https://github.com/khou/agent-statusline (stars 0)
1. Fixed by content type, threshold for percentages (`statusline.sh:38-61`, embedded Python): project dir CYAN, model MAGENTA, branch/worktree BLUE, `+n` GREEN, `-n` RED, cost GREEN, extra segment DIM; `by_level(pct)`: >=80 RED, >=50 YELLOW, else CYAN (comment: healthy is cyan not green "so green means one thing only: lines added") for ctx, 5h, wk, Cursor budget.
2. Themes: not present.
3. Colour: ANSI 16 (`\033[36m`, `[94m`...). `NO_COLOR` honoured (line 42-43: if set, all codes become empty), comment line 11: not gated on isatty because the payload is piped.
4. Fill: foreground only.
5. Separators: dim ` | `.
6. Neighbours: distinct hue per type.
7. Light/dark: not present.
8. Glyphs: `⑂` worktree prefix; otherwise plain text; no emoji.
9. Works with Cursor too (`AGENT_STATUSLINE_HOST=cursor`).
10. Config: optional user script `~/.config/agent-statusline/extra.sh` for an extra dim segment; no colour options.

## my-claudecode-statusline
URL: https://github.com/kilhyeonjun/my-claudecode-statusline (stars 0). A ccstatusline (sirmalloc) configuration plus helper scripts.
1. Fixed per widget in `ccstatusline/settings.json`: model cyan, thinking-effort brightMagenta, autopilot custom brightYellow, git-branch magenta, git-changes yellow, cwd blue, context-bar green, session-clock brightBlack, burn custom brightBlack, usage custom brightCyan, skills brightMagenta. Scripts (`statusline-burn.sh`, `-usage.sh`, `-autopilot.sh`) output plain text with emoji/symbol cues (`🔥 full in 5m`, `✓0.8x`, `·0.5x`) and `preserveColors:false`, so the widget colour wins.
2. Themes: ccstatusline `powerline.theme: "nord-aurora"` but `powerline.enabled:false`, so the theme is inert (settings.json:115-121).
3. Colour: ccstatusline named 16 colours, `colorLevel: 2` (256). No NO_COLOR (ccstatusline's behaviour: unverified).
4. Fill: foreground only (powerline disabled), `globalBold: true`.
5. Separators: ccstatusline `separator` widgets between items; `inheritSeparatorColors: true`; 5 lines.
6. Neighbours: different colour per widget, separators.
7. Light/dark: not present.
8. Glyphs: emoji in scripts; ccstatusline built-in bars.
9. Burn-rate and 5h/7d usage scripts.
10. Config: ccstatusline JSON (`__CLAUDE_SCRIPTS__` placeholder replaced by installer), install/uninstall scripts.

## cc-hud
URL: https://github.com/kimyong6366/cc-hud (stars 0)
Claude Code mod (panel under the prompt, Ink); `cc-hud/hooks/register.tsx` (3.3k lines).
1. By threshold gradient plus fixed accents: `register.tsx:297-303` `heat(t)` interpolates green `#4ade80` -> yellow `#fbbf24` (at 60%) -> red `#f87171` for bar and percentage (677); effort has a fixed colour per level (289-295: low `#a1a1aa`, medium `#60a5fa`, high `#fbbf24`, xhigh `#fb923c`, max `#f87171`, shown as 5 notches filled up to the level); `ACCENT #d97757`, `VIOLET #a78bfa`; `TRACK 0x3f3f46`, `TICK 0xe5e5e5` (time tick on quota bar, readable on green/yellow/red and dim segments); labels `DIM`. `[handoff]` button turns orange at 85% context (README).
2. Themes: none; fixed colours. Sprite colours `COL` in `hooks/sprites.ts`.
3. Colour: hex ints; no depth handling, no NO_COLOR (host renders).
4. Fill: foreground-coloured block glyphs and buttons; no background cells noted.
5. Separators: spaces and ` · ` text.
6. Neighbours: fixed accent vs dim, bars separated by label column padded to widest label across EN/ZH (`labelW`).
7. Light/dark: not present.
8. Glyphs: pixel crab sprite in half-cells at 13 fps, block bars, emoji-free; EN/ZH UI.
9. Animated mascot reacting to quota; subagent board.
10. Config: toolbar buttons, `/hud lang`.

## claude-mods (KingP1197, "desk" mod)
URL: https://github.com/KingP1197/claude-mods (stars 0)
Claude Code mod (band above prompt, agent board, file tracer), not stdout. Styling split across `desk/hooks/*`.
1. Mostly host theme keys with a small fixed palette: `band/register.tsx:113` `level(pct)` -> `error` >=80, `warning` >=50, else `text`; cache `claude` when warm, `inactive` when cold (648,663); labels `inactive`/`subtle`; error `error`. Context bar segments coloured by source from `PALETTE = ['#7aa2f7','#ff9e64','#9ece6a','#f7768e','#bb9af7','#e0af68','#7dcfff','#c0caf5']` cycling by index (`register.tsx:96,681`), free space `#4b5563`. Board: `BAR_LIVE #d77757`, `BAR_DONE #8b949e`, `FAILED_RED #e5534b`, `ICON_INK #8b949e` (`board/colors.ts`).
2. Themes: none of its own; follows host theme for text keys. Header of `board/colors.ts`: "Text colours are the engine's theme keys, which follow the theme".
3. Colour: theme keys + hex + rgba; no NO_COLOR.
4. Fill: see-through greys `rgba(128,128,128,0.10/0.20/0.25/0.40)` for raised cards, selected rows, dividers - chosen "so one value reads on either theme" (`board/colors.ts:5-12`, `tracer/colours.ts`).
5. Separators: rule lines with alpha greys.
6. Neighbours: cycling palette by index for context segments; alpha fills for cards.
7. Light/dark: yes by design: semi-transparent grey overlays and host theme keys avoid per-theme palettes.
8. Glyphs: SVG icons in one grey ink, critter sprite with hats (`CRITTER_INK`).
9. Critter pixel sprite.
10. Config: slash commands (`/agent-board`, `/file-tracer`), band buttons.

## statusline (kinncj)
URL: https://github.com/kinncj/statusline (stars 0). Multi-host installer (Claude Code, Copilot CLI, OpenCode, Pi, Hermes); styling in `statusline.sh`.
1. Fixed per field label+value, threshold for context: `statusline.sh:11-18,27-190` dir GREEN, branch CYAN, model BLUE, thinking/effort/agent MAGENTA, `[vim]` YELLOW, worktree CYAN, cost YELLOW, labels (`dir:`, `branch:`, `context:`) DIM; context `ctx_colour` (66-76): >=80 RED, >=50 YELLOW, else GREEN. 5h/7d quotas: label dim, value uncoloured (226-234).
2. Themes: not present.
3. Colour: ANSI 16 only (`\033[3Xm`). `NO_COLOR` appears only in installers (`installers/_tui.sh`), not in the statusline: not present for statusline.
4. Fill: foreground only.
5. Separators: dim ` | `.
6. Neighbours: dim text `label:` prefixes plus distinct colours.
7. Light/dark: not present.
8. Glyphs: plain ASCII labels (`dir:`, `branch:`); no icons; `glyph.box` counts are logo art in assets.
9. Two-line layout (location+model line, context+usage line) and raw rebuild pass for narrow terminals.
10. Config: installers pick host; no colour config.

## chrysaki-claude
URL: https://github.com/Kiriketsuki/chrysaki-claude (stars 0)
Bash statusline `statusline-command.sh` (1096 lines) plus mods (`mods/chrysaki-statusline`, TS band).
1. Role palette + per-line jewel accent + thresholds. Semantic roles from `palette/chrysaki-core.sh` mirrored in `mods/chrysaki-statusline/hooks/palette.ts:2-64` (CORE hex tokens; ROLE: emeraldLt, sec, muted, teal, blondeLt, warn, error, hexEmpty, text; git diff green `#50b450`/red `#c05050` kept local). Script `statusline-command.sh:355-384`: C_TEAL ctx normal, C_EMERALD_LT 5h normal, C_SEC 7d normal, C_MUTED separators and reset timers, C_WARN at >=50%, C_ERROR at >=75%/128k, C_ORANGE xterm 208 for ctx warning, C_HEX_EMPTY for dim positions. Jewel pool (446-482): 9 colours around an emerald-royal blue-amethyst loop (`JEWEL_COLORS`, plus dimmed `_DIM`), chosen by time seed `_ts % 9`; each of 4 lines gets a different index using primes (`/3`, `/7`, `/11`) "so no two adjacent lines share a colour", used for dir, branch and the `━` bridge lines. Threshold sections pulse brightness (`pulse_scale` 70-100, sine table, 8 s cycle).
2. Themes: one bundled palette "chrysaki" (generated from a core palette file; `scripts/sync-palette.mjs`; each mod has `theme.ts`). Format = named tokens, roles map to tokens. User-defined: via editing palette files and `personal.example.json`; unverified.
3. Colour: truecolor hex (`hex_fg` -> `\033[38;2;r;g;bm`, line 59), one 256 index (208). `NO_COLOR` honoured (39-41; `NO_COLOR=0` re-enables, deliberate deviation). No depth downgrade.
4. Fill: foreground only.
5. Separators: `━` heavy-line "bridges" between segments coloured per line with the dim jewel; hex gauges `⬢/⬡` (default), also `◇ ○ ▲ ▼ ░` styles for bars.
6. Neighbours: rows separated by differing jewel hue, within row semantic role colours.
7. Light/dark: dark-first palette (`abyss`, `textInverse`); no adaptation.
8. Glyphs: Nerd Font aware: TS mod falls back from private-use glyphs to `◆` outside the terminal surface (`band.ts:156-167`); hex and box glyphs.
9. Animation: gradient text was removed in v2.1 ("looked broken when static", lines 190-192); now solid jewel tones, pulse, wave scroll, badge alternation, all frozen by `CHRYSAKI_NO_ANIMATE`; `CHRYSAKI_JEWEL_STATIC` pins colour for screenshots.
10. Config: env vars `CHRYSAKI_NO_ANIMATE`, `CHRYSAKI_JEWEL_STATIC`, `CC_*` colour overrides, `personal.example.json`, gauge style option (lines 201-255).

## glmcode (fork of Haleclipse/CCometixLine)
URL: https://github.com/kiritoko1029/glmcode (stars 0). FORK OF CCometixLine. The parent has since been restructured (its current tree has `src/style`, `src/widgets`, `src/render`), so a precise diff is not possible; fork looks to be built on the older `src/ui/themes/` + `src/core/segments/` layout.
1. Base (parent-shared pattern): each segment config carries `icon`, `text`, `background` as `AnsiColor` (`Color16{c16}` | `Color256{c256}` | `Rgb{r,g,b}`, `src/config/types.rs:45-61`); in `theme_powerline_dark.rs` e.g. model bg rgb(45,45,45) white text, directory bg rgb(139,69,19). So colour is fixed per segment per theme. FORK DIFFERENCE: new `glm_usage.rs` (GLM quota segment) colours its `▓░` 10-cell bar by threshold with 256 indexes: <=50% `38;5;114` soft green, <=80% `179` soft yellow, else `167` soft red (`glm_usage.rs:10-17`), and `decode_speed.rs` segment; update/output_style segments from parent.
2. Themes: 9 presets: `cometix, default, minimal, gruvbox, nord, powerline-dark, powerline-light, powerline-rose-pine, powerline-tokyo-night` (`src/ui/themes/presets.rs:22-30`); per-segment colour map format; user themes loaded from `~/.claude/glmcode/themes` (line 56; parent uses `~/.claude/ccline/themes`, rename).
3. Colour: 16/256/RGB per field (`statusline.rs:300-355` writes `38;5`, `38;2`, `48;5`, `48;2`). NO_COLOR: not found.
4. Fill: both - segment bg fill when `background` set, else fg-only (`statusline.rs:224-260`).
5. Separators: if separator is `\u{e0b0}` powerline arrow with fg = previous bg, bg = current bg (`create_powerline_arrow`, 371+); any other separator is a plain white (`\x1b[37m`) string.
6. Neighbours: per-segment bg in powerline themes; no luminance logic seen.
7. Light/dark: `powerline-light` vs `powerline-dark` presets; no detection.
8. Glyphs: `IconConfig { plain (emoji), nerd_font }` per segment; mode chosen by config.
9. TUI configurator with `color_picker.rs`, `theme_selector.rs`, `icon_selector.rs`, `separator_editor.rs` (ratatui).
10. Config: TOML `~/.claude/glmcode/`, ratatui TUI, CLI.

## statusLine-node (kiritoko1029)
URL: https://github.com/kiritoko1029/statusLine-node (stars 0)
1. Per segment style objects in a JS config; values may be functions of the payload. `config.js` default: model fg 256-colour 208 bold, directory fg 142 bold, cost fg 214 bold; context fg is dynamic (`config.js:90-104`): >80% 196 red, >50% 214 orange, else 5. Themes `themes/nord.js` use fg+bg RGB per segment (model bg `{136,192,208}` frost blue with dark text `{46,52,64}`, directory bg aurora green `{163,190,140}`).
2. Themes: 2 bundled (`themes/gruvbox.js`, `themes/nord.js`), as JS modules with segment list; users write their own `config.js` (JS function-valued styles).
3. Colour: `lib/render/color-resolver.js:1-120`: hex `#RGB/#RRGGBB`, 16 names (`bright-black`..), 256-index number, or `{r,g,b}`; priority RGB > 256 > 16; invalid -> no colour. No depth detection, no NO_COLOR found.
4. Both: bg set in nord theme, fg-only in default config.
5. Separators: `settings.separator` joined between rendered segments, unstyled (`render-statusline.js:64,85`); nord.js sets `separator: ''` with comment "for powerline effect" but no arrow glyph rendering (no powerline logic in renderer).
6. Neighbours: in nord theme a distinct bg hue per segment, no separator; default config distinct fg per segment.
7. Light/dark: not present.
8. Glyphs: `icon: { nerd_font, plain }` per segment, `settings.mode` `nerd_font` | `plain`.
9. Segment `enabled` and `content` can be functions; `style` resolved per render (`render-segment.js:15-31`).
10. Config: `config.js` (JS), `lib/config/load-config.js`.

## ai_status_line
URL: https://github.com/Kmagameguy/ai_status_line (stars 0)
1. Semantic roles per element: `lib/.../color_schemes/color_scheme.rb:9-67` `Scheme(primary, status_info, status_warning, status_alert, text)`. `model.rb:12` primary; `working_directory.rb:21` branch `status_warning` (yes, branch is in the warning colour); `session_cost.rb:8` `status_warning`; context % and rate limits via `colorize_range` (90+ alert, 70-89 warning, else info); session length and tokens uncoloured (`text`).
2. Themes: 3 bundled: `default` (ANSI 16: cyan, green, yellow, red), `solarized` (256 idx 33/64/136/160, text 244), `nord` (111/108/179/131, text 252), `REGISTRY` hash; selected with `color_scheme:` in YAML; user-defined: not present.
3. Colour: ANSI 16 and 256 index; no truecolor, no depth detection, no NO_COLOR.
4. Fill: foreground only; every colourize resets to scheme `text`.
5. Separators: plain text in element layout (no colour); lines configured as lists.
6. Neighbours: whitespace and role colours.
7. Light/dark: not present (nord/solarized dark-oriented).
8. Glyphs: mostly ASCII, 1-2 box/emoji chars.
9. Pure roles design: elements ask for `:primary`/`:status_warning`, never a colour, so adding a scheme is one struct.
10. Config: `config.yml` (`color_scheme`, `lines: [[model, working_directory], ...]`).

## claude-contextline
URL: https://github.com/knowsuchagency/claude-contextline (stars 0)
1. Four theme tokens, fixed per segment: `src/theme.ts:23-41` `ThemeColors {blue, red, mauve, overlay0}`; `renderer.ts:20-60`: battery bar filled + directory = blue, model = red, git branch = mauve, empty bar cells and email = overlay0. Colour does not change with usage.
2. Themes: 18 palettes ported from the herdr terminal multiplexer's `Palette` (`theme.ts:55-77`: catppuccin, catppuccin-latte, terminal, tokyo-night, tokyo-night-day, dracula, nord, gruvbox, gruvbox-light, one-dark, one-light, solarized, solarized-light, kanagawa, kanagawa-lotus, rose-pine, rose-pine-dawn, vesper) with aliases (`catppuccin-mocha`, `latte`, `light`...). Format = 4 semantic tokens; theme is read each render from herdr's `config.toml` `[theme] name` and `[theme.custom]` overrides (HERDR_CONFIG_PATH / XDG) (`theme.ts:151-215`), default catppuccin. So the user selects via herdr, not the statusline.
3. Colour: RGB truecolor `\x1b[38;2;r;g;bm`, or named ANSI code (`terminal` theme uses 34/91/37), or reset `39`. Accepts "reset/default/none/transparent". No downsampling; no NO_COLOR.
4. Fill: foreground only.
5. Separators: none; two-space gaps, bar delimited by `[ ]`.
6. Neighbours: distinct token per segment; layout alignment (model column aligned under branch).
7. Light/dark: light variants as separate named themes (latte, day, lotus, dawn, gruvbox-light, solarized-light); chosen by herdr's theme, no detection.
8. Glyphs: `█░` battery bar; no icons.
9. Two-line layout with column alignment (branch left, directory tail aligned to model column).
10. Config: herdr config file; no own config.

## claude-control-tower
URL: https://github.com/koffih/claude-control-tower (stars 0)
1. Semantic palette roles; segments never name a colour. `packages/render/src/theme/theme.ts:1-60` `Theme { text, muted, accent, severity(ok|info|warn|critical), gaugeEmpty }`. `plugins-builtin/src/session-plugin.ts`: model name `accent` (icon `muted`), effort label `muted`, thinking icon `accent`, fast icon `severity('warn')`, directory/repo `text` bold (OSC 8 link to repo), session name `muted`. Gauges coloured by `severity` from percentage via configurable thresholds (docs/configuration.md 130-145: context warn 75, critical 90; quota warn 80, critical 95); unfilled part `gaugeEmpty`.
2. Themes: 3 bundled `tower-dark` (default), `tower-light`, `tower-mono` (all one colour; severity carried by icon+number). Format = 9-token semantic palette. Config `"theme"` key. Custom user themes: documented as contributor addition (no config path seen) - unverified for users.
3. Colour: authored in RGB (`hex()`), downsampled at output: `ansi/style.ts:57-88` `toAnsi256`, `toAnsi16`; `capabilities.ts:36-65` depth none|ansi16|ansi256|truecolor from `NO_COLOR` (non-empty -> none, also disables OSC 8), `FORCE_COLOR` 0-3, `TERM=dumb`, `COLORTERM`, `WT_SESSION`, `TERM_PROGRAM` in a rich-terminal set, `TERM` containing 256color. Complete.
4. Fill: foreground only.
5. Separators: glyph-set dependent text separator (`separator(glyphs)`), plain; composer drops lowest-priority segments to fit width (`layout/compose.ts`, priorities critical/high/normal/low).
6. Neighbours: not distinguished by hue (text/muted/accent roles, separators). Desaturated greens/ambers on purpose so colour does not read as an alarm in peripheral vision (theme.ts comment).
7. Light/dark: separate `tower-light` palette (darker tones); no detection; mono theme for colourless sinks; colour-blind rationale: every state also has an icon/number.
8. Glyphs: three tiers `ascii | unicode | nerdfont` (`icons.ts`, each icon defined `[nerdfont, unicode, ascii]`), chosen by `glyphs` config or `CCT_GLYPHS`; Nerd Font never auto-detected ("guessing wrong produces tofu"); default unicode.
9. OSC 8 hyperlinks only for recognised terminals; half-block sub-cell gauge precision.
10. Config: JSON (`theme`, `glyphs`, `disabledSegments`, `thresholds`), env `NO_COLOR FORCE_COLOR CCT_GLYPHS`, `cct init` writes glyph tier, `cct doctor`/`status`.

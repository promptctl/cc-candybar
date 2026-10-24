## ekcm/agent-toolkit
https://github.com/ekcm/agent-toolkit — stars 0
(Claude Code "mod" `mods/dev-statusline`; styling is in `hooks/format.ts`. The pr-review-board mod and repo-wiki skill are unrelated.)
1. Fixed per segment, plus state on a few. `format.ts` `COLORS` table: `claude` 38;2;215;119;87 (ctx gauge fill + ctx %), `codex` 38;2;180;160;255 (Codex 5h figure), `repo` bold 38;2;193;95;60 (repo name), `dim` 2 (separator dot, branch parens, "no PR"), `good`/`warn`/`bad` = ANSI 32/33/31. State: `checksText` (failing=bad, running=warn, passing=good, none=dim); `threadsText` (all resolved=good, some=warn, none=bad); 5h "left" figure turns bold+underline (`1;4`) under `LOW_LEFT`=10% left; subagent "idle" text is `warn`.
2. Themes: not present. One hard-coded `COLORS` object; no user theme.
3. Colour spec: ANSI 16 for good/warn/bad (comment says they "follow its theme"), truecolor for brand colours (comment: needs 24-bit terminal). No depth detection, no NO_COLOR (`paint()` always emits).
4. Fill: foreground-only text; no backgrounds.
5. Separators: plain text, a dim `·` (`SEPARATOR = ' ' + paint('dim','·') + ' '`).
6. Neighbours: distinct brand colours per agent (claude vs codex) and the dim dot; nothing else.
7. Light/dark: not present beyond relying on terminal's own 16-colour mapping for good/warn/bad.
8. Glyphs: `▰`/`▱` gauge (`GAUGE_WIDTH` 10), `✗ ◷ ✓` for checks. No Nerd Font, no fallback.
9. Also: a third line summarising subagents; a `subagentStatusLine` command in `mods/dev-statusline/settings.json` (`subagents.sh`, not styled in what I read). Claude-vs-Codex brand colours in the same bar.
10. Customisation: none seen; edit `format.ts`. Installed via `install.sh`/plugin `hooks.json`.

## ekksoft/claude-usage-tray
https://github.com/ekkSoft/claude-usage-tray — stars 0
1. Not colour-styled. `status_line.py` prints one uncoloured line (`⏳ 3h48m · 5h 8% · wk 0%`, built in `build_status_line_text`), no ANSI at all. Hex colours (31 hits) are all in `tray_app.py` for a Tk/tray widget (e.g. `TIME_LEFT_COLOR="#5aaaff"` line 56, `pick_usage_bar_color_for_percent` ~L308: grey #bbbbbb / #ff6b6b red / #ff9a3c orange / #7ee2a0 green by percent). That is the tray app, not the statusline.
2. Themes: not present.
3. Colour spec: statusline none; tray uses hex. No NO_COLOR.
4. Fill: n/a (statusline plain text).
5. Separators: plain ` · ` (`" · ".join(...)`).
6. Neighbours: not present (monochrome).
7. Light/dark: not present (tray widget hard-codes dark `#222222` label background, `tray_app.py` L263).
8. Glyphs: `⏳` only.
9. Pet-like extras: none. The point of the project is the tray app that feeds `~/.claude/usage-watch.json`; the statusline ignores Claude Code's own `rate_limits` on purpose (docstring).
10. Customisation: constant `OLD_DATA_WARNING_MINUTES` in source; no config.

## elmofromok/claude-statusline
https://github.com/elmofromok/claude-statusline — stars 0
1. By state/threshold, mostly. `statusline.sh` (Python heredoc): model `[...]` uncoloured; directory and `(branch)` `DIM`; context segment by absolute tokens: `<SMART_MAX` 125k green "smart", `<DUMB_MIN` 150k yellow "edge", else red "dumb"; `%win` shown only from `WINDOW_WARN`=70% (yellow <90, red); cost uncoloured; subscription limits 5h/7d hidden below `LIMIT_WARN`=75 then shown as filled blocks `BLOCK_WARN` `\033[43;30m` (yellow bg, black text) or `BLOCK_HOT` `\033[41;97m` (red bg, white) at `LIMIT_HOT`=90.
2. Themes: not present.
3. Colour spec: ANSI 16 only (`\033[32m` etc). No depth detection, no NO_COLOR.
4. Fill: both. Text-only normally; background-filled badges are used only for the rarely-shown rate-limit warnings ("meant to grab the eye first", comment above `BLOCK_WARN`).
5. Separators: single space between segments (`" ".join(seg)`); no glyph separators.
6. Neighbours: no colour distinction except the alert blocks; segments hidden until relevant.
7. Light/dark: chooses black text on yellow fill and white on red (`BLOCK_WARN`/`BLOCK_HOT`) — hand-paired, not computed.
8. Glyphs: none (ASCII).
9. Notable design idea: colours are about the "smart zone / dumb zone" absolute-token thresholds, not window percentage; compares rounded value so 89.9 and 90.0 get the same colour (`limit_seg` comment).
10. Customisation: thresholds are constants at the top of the script; edit the file.

## ElRroRo/claudezilla-rice
https://github.com/ElRroRo/claudezilla-rice — stars 0
(A dotfiles/"rice" repo; the Claude part is `claude-code/bin/statusline.js` plus `claude-code/themes/neo-tokyo.json`.)
1. Mix. `statusline.js` `C` palette (truecolor, all `38;2;`): `mag` 255,0,135 (brand "ゴジラ", branch, bar default), `magHi` (model badge), `cyan` 0,240,255 (directory), `violet` 176,38,255 (effort), `yellow` 255,230,0 (cost, fast mode), `cyanLo` (thinking ✶), `slate` 73,84,112 (labels, separators, "/size"), `ice` 240,244,248 (pct text). State: `bar()` and `pctText()` — pct >=90 red (`red`/`redLo` track), >=75 yellow, else magenta bar / ice text. Same rule for CTX, 5H, WK bars.
2. Themes: one hard-coded palette in the script, named "Neo-Tokyo". Separately `claude-code/themes/neo-tokyo.json` is a Claude Code UI theme (`"base":"dark"`, `overrides` of Claude Code's own role keys like `claude`, `permission`, `promptBorder`, `rate_limit_fill` 255,0,135, `rate_limit_empty`, `success`/`error`/`warning`) — it themes Claude Code itself, not the statusline. Other palettes (cyberpunk, tokyo-night) seen by scanner appear in non-Claude files (fastfetch, PowerShell).
3. Colour spec: truecolor only; no detection/downsample; no NO_COLOR.
4. Fill: foreground only.
5. Separators: plain, `│` and `·` in `slate` (`SEP`, `DOT`), `╰` connector before line 2.
6. Neighbours: different hues per segment type (magenta/cyan/yellow) plus slate separators.
7. Light/dark: not present (assumes dark; neo-tokyo.json sets `"base":"dark"`).
8. Glyphs: Nerd Font icons in the script (`󰉋` folder, `` branch, `󰑐` reset) and box chars, no fallback. Japanese brand text.
9. Notable: pairs a statusline palette with a matching Claude Code theme JSON so the whole UI shares one palette; bars use a dim "Lo" companion colour for the empty portion (`magLo`, `yelLo`, `redLo`) rather than a grey.
10. Customisation: edit the script; theme file is Claude Code's custom-theme format.

## elsung/claude-code-context-monitor
https://github.com/elsung/claude-code-context-monitor — stars 0
1. By state/threshold. `context-monitor.py`: context bar icon+colour by percent (`get_context_display`, L122-144): 🚨 bold red (`31;1`, commented "Blinking red"), 🔴 red, 🟠 bright red `91`, 🟡 yellow, 🟢 green. Model name `[...]` coloured by the same context state (L266-278), `\033[94m` bright blue when unknown. Directory `\033[93m` fixed. Cost green/yellow/red by amount (L199-203), duration green/yellow (L213-215), lines changed green/red/yellow by sign (L231-235). Separators grey `90`.
2. Themes: not present.
3. Colour spec: ANSI 16 only (31/32/33/90/91/93/94). No detection, no NO_COLOR.
4. Fill: foreground only.
5. Separators: plain `|` and `·` in grey `\033[90m` (L166, L240).
6. Neighbours: emoji prefix per segment (📁 🧠 💰 ⏱ 📝) and per-state colour; no hue scheme.
7. Light/dark: not present.
8. Glyphs: emoji-heavy, no ASCII fallback. Bar uses block chars.
9. Notable: model name takes the context's severity colour, so one segment doubles as the alarm.
10. Customisation: edit script (thresholds in code); two copies `context-monitor.py` and `scripts/context-monitor.py`.

## EmanuelFaria/claustatus
https://github.com/EmanuelFaria/claustatus — stars 0
1. Fixed per row (labelled powerline rows), with state overrides. `statusline.sh` header comment: "basic 16-color only (8-bit breaks Claude Code TUI redraws)" yet later rows use 256 (`48;5;N`). Fixed: MODEL `BG_CYAN`=`\033[45m` (variable names are legacy, actual magenta, L17), version `44m` blue, thinking ON green `42m` / OFF red `41m` (L263-269), CTX `46m` cyan, "% used" `44m` blue, "% left" `42m` green (L685-687), REPO `42m` green (L695), CLONE `43m` yellow with black text (L705), NAME `48;5;25` (L699), AGENT `48;5;208` orange (L678). State: API$ row teal 30 -> orange 130 at >=$10 -> red 196 at >=$50 (L244-246); USAGE row blue 25 -> yellow 136 (>=50%) -> orange 130 (>=75%) -> red 196 (>=90%) (L251-255); activity row grey 248, orange 214 (tool running), blue 33 (processing), yellow 226 (awaiting approval) (L288-308); GUIDE/SKILL/INTENT/LEARN/LIMITS/CAP rows grey 240 default, green 28 loaded, blue 24 offered, amber 136 cooldown/declined, red 196 (L404-535). Alert banners with background fills for "PASTE PRECOMPACT NOW" / "CONTEXT LOW" (L604-648).
2. Themes: not present; colours are inline assignments.
3. Colour spec: ANSI 16 backgrounds + 256 index; no truecolor, no detection, no NO_COLOR. Comment at L588: "Claude Code TUI strips \033[5m (blink)".
4. Fill: background-filled cells (powerline), white bold text (`FG_WHITE`, `BOLD`), black on yellow for CLONE.
5. Separators: powerline arrow (`ARROW`) in the segment's own fg colour. In `flex_segments` (L329-398) arrow after segment i is drawn with `bg` of the NEXT segment and `fg` = previous segment's colour (`printf "%b%b%b" "$bg" "$prev_fg" "$ARROW"`); last arrow ends on default bg. When too wide for `AVAIL_W = COLUMNS - CC_RIGHT_RESERVE` (42), segments stack one per row via `print_row`.
6. Neighbours: each segment gets a different fixed hue by role, arrow between. Rows labelled (MODEL, CTX, USAGE, API$, REPO, CLONE, GUIDE…).
7. Light/dark: not present; white text on coloured bg assumed.
8. Glyphs: emoji in rows (🧠 ⚙️ 💭 ⏳ 🔔 🚨 ⚠️), powerline arrow needs a powerline font; no fallback.
9. Notable: iTerm2 escapes for session badge / user vars (L851-858); activity row driven by hook-written JSON; rows hide when empty; width-aware wrap into stacked rows.
10. Customisation: `CC_RIGHT_RESERVE`, `WEEKLY_BUDGET_USD` env; otherwise edit script.

## ember-hearted/statusline
https://github.com/ember-hearted/statusline — stars 0
1. By state plus fixed. `bin/statusline.sh`: progress bar colour by used%: green `\033[32m` < `green_threshold`(55), yellow <= `yellow_threshold`(75), else red (L109-116). Fixed: directory cyan 36, branch configurable (`branch_color` default 33 orange), separator `▸` and no-git grey `38;5;245`, Tasks line purple 35, PR icon by review state (approved green, changes_requested red, pending yellow, draft grey, L251-255), effort colour by level: low grey, medium green, high yellow, xhigh/max red (L365-369), time grey.
2. Themes: not present. Config JSON exposes `colors.thresholds.green/yellow` and `colors.branch` (L55-82).
3. Colour spec: ANSI 16 plus one 256 grey (245). No detection, no NO_COLOR.
4. Fill: foreground only.
5. Separators: plain `▸`, `⟦ ⟧` brackets around effort/balance, in grey.
6. Neighbours: different fixed hues by role; grey structure glyphs.
7. Light/dark: not present.
8. Glyphs: emoji and a battery-style bar built from Mahjong tiles (`🀫 ▣ 🀆`, L131ff), `❦` prefix, `↯`; Nerd glyph for branch (1 hit). No fallback.
9. Notable: provider balance display (deepseek, kimi, volces…) in `config/providers/*.sh`; OSC-8 PR links (L265).
10. Customisation: JSON config file with thresholds/branch colour and show_* toggles (L55-82); `install.sh`.

## Englader/purrgotchi
https://github.com/Englader/purrgotchi — stars 0
(Tamagotchi-style kitten in the statusline; Rust binary + a Claude Code "mod" + a VS Code theme.)
1. Fixed per role from a small palette. `rust/src/colors.rs` truecolor constants: CYAN 10,189,198; PINK 234,0,217; MAGENTA 113,28,145; YELLOW 243,243,27; GREEN 87,236,166; RED 255,84,104; PURPLE; GOLD; BLUE. `rust/src/statusline.rs` L376-480: frame/border/dividers PINK, title "NETRUNNER" bold CYAN, `//` MAGENTA, cat name PINK, MODEL/DIR/GIT values CYAN, 5h/7d bars and RESET/Cost/Total values YELLOW, CTX bar CYAN, `+lines` GREEN `-lines` RED, level PINK bold, coins YELLOW; labels `dim()`. Pet sprite colour by rarity (`rarity_rgb`: common cyan, uncommon green, rare purple, epic gold, legendary cycles the 6-colour `RAINBOW` by `now % 6`); shiny alternates Bold/Dim each second. Mood colours L136-141 (panic red, alert yellow, happy green, sleep magenta, hungry dim cyan).
2. Themes: the HUD colours are hard-coded in Rust. A "neon-grid" / "neon-grid-violet" palette is shipped as Claude Code theme JSON (`mod/themes/neon-grid.json`: `claude` #ea00d9, `permission` #b45cff, `success` #57eca6, `error` #ff5468, `warning` #f3f31b, `text` #e4dcff…) and as VS Code themes built from `vscode-theme/src/*.jsonc` by `build.py`. Semantic roles only in those Claude Code theme files, not in the statusline.
3. Colour spec: truecolor only (`Attr::Fg(Rgb)` writes `38;2;r;g;b`). No depth detection, no NO_COLOR found.
4. Fill: foreground only.
5. Separators: box-drawing frame, `│` in PINK between cells, `═╡ ╞ ╔ ╗`.
6. Neighbours: panels per field with dim labels; hue by role (cyan data, yellow numbers, pink structure).
7. Light/dark: not present (dark neon assumed).
8. Glyphs: box drawing, ASCII sprite art; rarity stars; few emoji.
9. Notable: animation (67 hits) — pet frames, rainbow cycling for legendary, shiny shimmer; `mod/hooks/neon.ts`, `band.ts`, `backdrop.ts` draw an animated band in the Claude Code mod UI; the same palette is exported to a VS Code colour theme.
10. Customisation: no colour config seen; theme JSONs are installed by `mod/scripts/theme.mjs`; pet state in files.

## Entze/zeile
https://github.com/Entze/zeile — stars 0
(Zig. `docs/external/claude-status-line_files/*.js` are a saved copy of someone else's web page, `claude-status-line`, kept as reference; the theme names scanner saw (catppuccin, dracula, nord, …) come from THAT site's JS, not zeile.)
1. By state only. `src/color.zig` + `src/usage.zig`: rate-limit bars coloured by PACE (`paceColor`), context bar by fill (`fillColor`). README table: blue < 0.50x affordable rate, green 0.80-1.15x, yellow ~1.70x, red >= 2.50x, blended along a 21-step 256-colour ramp (`ramp`, 38;5;21 blue -> 51 cyan -> 46 green -> 226 yellow -> 196 red) by `gradient(stops, at)`, stops spaced by log of the multiple; context bar blue empty, green 15%, yellow 60%, red 100%. Fixed: lines added `green` 32 / removed `red` 31 (`root.zig` L153-154); model name, cost, labels uncoloured.
2. Themes: not present. Config (`display.pass-mode`, `pass-file` in `tests/resources/config/good/full.json`) has no colour keys.
3. Colour spec: 256-colour index for the ramp, ANSI 16 for green/red. No depth detection; no NO_COLOR in `main.zig`/`root.zig`.
4. Fill: foreground only.
5. Separators: bracketed groups `[5h: [##/ ] ...]`, plain spaces; ASCII bars (`#`, `/`, `.`, `v`).
6. Neighbours: no colour distinction; bar groups are bracketed; only the bars are coloured.
7. Light/dark: not present.
8. Glyphs: ASCII only (deliberate).
9. Notable: pace-relative colouring (compares current spend rate with the rate you can still afford) rather than raw percentage; ramp built from cube edges.
10. Customisation: JSON config (XDG or `~/.config/zeile/config.json`), only pass-through options; no colour setting.

## epatnerlab/skills
https://github.com/epatnerlab/skills — stars 0
(A plugin/skills collection; styling is in `plugins/claude-code-tools/skills/statusline/scripts/custom-statusline.sh`.)
1. By state plus fixed. Palette: GRAY `\033[90m`, YELLOW 33, RED 91, GREEN 92, CYAN 96. Repo path GREEN, branch GRAY in parens, release tags CYAN with GRAY age, URL line CYAN, separators GRAY `|`. Git indicators via `colorize_stat`: value 0 -> GRAY, nonzero -> YELLOW (conflicts `⚠` -> RED). Context bar: GREEN, YELLOW at >=70%, RED at >=90%. Effort/thinking badges GRAY `[...]`.
2. Themes: not present.
3. Colour spec: ANSI 16 incl. bright variants; no detection/NO_COLOR.
4. Fill: foreground only.
5. Separators: plain GRAY `|`, double-space between groups.
6. Neighbours: greys vs colours — zero values go grey, active ones coloured.
7. Light/dark: not present (bright codes 9x assume dark).
8. Glyphs: `↑ ↓ ≡ ⚠ ∅` indicators; no fallback.
9. Three-line layout (repo+git, model+ctx+cost, GitHub URL + visibility badge).
10. Customisation: copy the script into the repo and edit; installed by the skill's flow.

## EranDaniel98/claude-code-statusline
https://github.com/EranDaniel98/claude-code-statusline — stars 0
1. By state. `claude_watcher/statusline.py`: project name bold cyan `1;36` (fixed); model `2;37` (dim white); status dot: `1;32` ● busy, `1;33` ● THINKING at >=60s (`SLOW_THRESHOLD`), `1;31` ● STUCK at >=180s / WAITING (`render_status`); `FAST` `1;36`; context % `2;37` <60, `33` <80, `1;33` <90, else `1;31` (`render_context`); rate limits `_rl_color`: `2;37` <60, `33` <85, `1;31`; last-activity time `2;37` <30s, `33` <120s, `1;31`.
2. Themes: not present (the 8 `theme.key` hits are unrelated, in the watcher/notify code).
3. Colour spec: ANSI 16 SGR via `ansi(text, code)` (L30). No detection, no NO_COLOR.
4. Fill: foreground only.
5. Separators: plain ` | ` (`" | ".join(parts)`).
6. Neighbours: not distinguished by colour; all neutral dim-white except status and alerts.
7. Light/dark: dim white (`2;37`) assumes dark; not present otherwise.
8. Glyphs: `●` only; a Windows-aware width detector truncates the project name (`detect_terminal_width`).
9. Notable: a three-step escalation (dim -> yellow -> bold red) reused for context, rate limits and idle time; liveness derived from transcript mtime.
10. Customisation: env `CLAUDE_WATCHER_SLOW_SECONDS`, `CLAUDE_WATCHER_STUCK_SECONDS`, `CLAUDE_STATUSLINE_DEBUG`; installed via `scripts/install.ps1`/`merge_settings.py`.

## eranltd/pixel-pet
https://github.com/eranltd/pixel-pet — stars 0
not a Claude statusline: a Claude Code mod (`hooks/register.tsx`, imports from `claude-code`) drawing a pixel-art pet and a plan/PR/Slack "band" with ink-style named colours (`<Text color="green|red|yellow|cyan|magenta|gray">`, `limitColor(...)`, `cacheColor`), SVG sprites with a `PALETTE` map, and a catppuccin-ish hex set; no statusline command.

## ericrihm/claude-hud
https://github.com/ericrihm/claude-hud — stars 0
1. By theme-defined roles. `plugin/lib/renderer.py`: per-segment colours come from the theme: powerline layout uses `segment_backgrounds` per segment name (`powerline.json`: os 25, cwd 236, git_branch 22, context 238, context_bar 234, model 54, cost 236, rate_5h 238, rate_7d 234), falling back to `default_bgs` list by position (`[236,238,240,242,244,238,236,234,232,234]`, `_render_powerline`). Text colour is a severity role (`severity_colors`: ok/warn/critical/accent/muted/normal), chosen by each segment's computed severity (`_sev_fg`); optional `segment_colors` per-segment fg/icon override (`_style_segment`, priority: segment override < severity). Gradient bar: `bar_gradient` list, one colour per cell (`_draw_bar`). The OS/host name rotates through `host_palette` per character, shifted by `int(time.time())` (`_render_host`). `+N`/`-N` lines fixed 46 green / 196 red.
2. Themes: bundled 9 JSON files in `plugin/themes/`: default, powerline, dashboard, hacker, kali, operator, operator-parrot, parrot, vaporwave, zen (scanner also lists synthwave, SKILL as names). Format: a flat JSON with `layout.style` (plain|powerline|boxed|minimal), `icon_tier`, `host_palette`, `bar_gradient`, `severity_colors` (ok/warn/critical/accent/muted/normal), `segment_backgrounds`, `segment_colors`, `separator`, `separator_color`, `lines` (segment order). Selected by `~/.claude/oh-my-claude/config.json` `theme` (`get_active_theme_name`). Users can add JSON themes (`load_theme`).
3. Colour spec: `colors.py` `resolve_color` accepts 256-index ints, `#rrggbb` truecolor, `NAMED_COLORS` (24 names mapped to 256 codes), or palette keys. The shipped themes use 256 integers. Renderer calls `fg256`/`bg256` only. `detect_all()` in `plugin/statusline.py` L59 detects terminal caps (OS, icon tier); no NO_COLOR handling found. (README mentions fallbacks; code path for truecolor downsampling not seen.)
4. Fill: both — powerline theme uses background cells; others foreground.
5. Separators: powerline arrow `` (`powerline_separator`): drawn with `bg=this segment's bg`, `fg=previous segment's bg`; last closing arrow fg = last bg. Plain themes: `" | "` coloured by `separator_color` (default `muted`); line 2 uses ` · ` or `│`.
6. Neighbours: powerline = different background shade per segment (named or by position from a list of greys); plain = separators plus severity colours; boxed layout exists.
7. Light/dark: not present; powerline themes set `severity_colors.ok/warn` to 0 (black) and `normal` 231 (white) on dark bgs by hand.
8. Glyphs: three icon tiers `nerd` / `unicode` / `ascii` (`lib/icons.py`: tuple of (nerd, unicode, ascii) per icon); `icon_tier` per theme.
9. Notable: animated rotating-colour host name; SVG gallery of themes (`assets/themes/*.svg`, `scripts/render_hud_svg.py`); `severity_color(value, thresholds)` default ok 40 / warn 65 / critical 85 returning green/cyan/yellow/red.
10. Customisation: JSON theme files + `config.json`; `doctor.py` diagnostic command.

## ericwu917/claude-utils
https://github.com/ericwu917/claude-utils — stars 0
1. By state plus fixed. `statusline/statusline.sh`: `CYAN` 36 `[model vX]` and the `↑` update arrow YELLOW; branch GREEN; `+add` GREEN `-del` RED; cost YELLOW; `|` separators `DIM`. `bar_color` (context): GREEN <50, YELLOW >=50, ORANGE (`38;5;208`) >=75, RED >=90. `rate_bar_color` for 5h/7d: GREEN when usage <= time elapsed, YELLOW when under 50% or within 1.5x pace, else ORANGE; RED >=90 (pace-aware). Bars are `█` coloured + `░` DIM. The `mods/statusband` mod (`register.tsx`) draws the same data as SVG/raster with hex `GREEN #22c55e`, `YELLOW #eab308`, `ORANGE #f97316`, `RED #ef4444`, `GREY #8a8a8a`, `CYAN #06b6d4`, and a track that "follows CC's theme" (L663).
2. Themes: not present.
3. Colour spec: ANSI 16 + one 256 index (orange 208). No detection, no NO_COLOR.
4. Fill: foreground only (statusline); the mod draws filled bars with mixed colours (`mixInt`).
5. Separators: plain DIM `|`.
6. Neighbours: fixed hues per kind; dim bars/separators.
7. Light/dark: the mod's grey track follows Claude Code's theme; script has none.
8. Glyphs: emoji (📁 🔀), block chars; OSC-8 directory link (L451).
9. Notable: pace markers `│` at the time position on rate bars; extra "Fable" overlay marker `┃`; two surfaces (script + mod) share one 4-step traffic-light palette.
10. Customisation: edit scripts; `install.sh`; cache refresh script.

## espiria/statusline
https://github.com/espiria/statusline — stars 0
1. Two themes with different rules. Default (`src/themes/defaultTheme.ts`): `colorizeUsageStatus` only — used% 0 hidden, <=50 green, <=75 blue, <=87.5 yellow, else red (chalk named); everything else uncoloured. Powerline (`powerlineTheme.ts`): fixed per segment background RGB: model `[30,40,80]`, session `[60,30,70]`, project `[25,65,75]`, git `[30,65,40]`, usage `[85,70,20]`; white text.
2. Themes: 2 bundled (`default`, `powerline`) selected by `--theme/-t`; custom theme is a JS module default-exporting `async (input) => string`, loaded by `--theme-file/-f` (`loadTheme.ts`). The theme owns all styling; no palette schema.
3. Colour spec: chalk. `index.ts` forces `chalk.level = 3` (truecolor) with the comment that auto-detection fails when stdin is piped; so no depth detection, no NO_COLOR.
4. Fill: default = foreground; powerline = background-filled cells with white fg.
5. Separators: powerline ``; arrow fg = previous bg, bg = next bg (`styleSep(from,to)`), final arrow on default bg. Default theme: no separator, pads with spaces between left/centre/right.
6. Neighbours: distinct muted dark hue per segment (powerline); not applicable in default.
7. Light/dark: not present (dark muted bgs + white text).
8. Glyphs: emoji (🤖 📃 🗂️ 🌿 🪾 💾 💥), width helper `getDisplayWidth` counts emoji as 2; powerline arrow needs powerline font.
9. Notable: layout wraps powerline segments onto extra lines when over `terminalSize().columns`.
10. Customisation: CLI flags `--theme`, `--theme-file`; no config file. Installer with `--overwrite`.

## est7/my-statusline
https://github.com/est7/my-statusline — stars 0
1. By state plus fixed. `statusline.sh`: dir CYAN 36 (L295+: `%b%s%b` with `$CYAN`), `(branch` GREEN with dirty `*` RED, model BLUE `\033[94m`; labels (`eff`, `ctx`, `5h`, `7d`, `up`) `DIM`; effort colour: low DIM, medium GREEN, high YELLOW, xhigh MAGENTA `95`, max RED; ctx GREEN <70, YELLOW >=70, RED >=85; 5h/7d `usage_color` (L104): BLUE <70, MAGENTA >=70, RED >=90; duration WHITE.
2. Themes: not present.
3. Colour spec: ANSI 16 incl. bright (90s). No detection, no NO_COLOR.
4. Fill: foreground only.
5. Separators: plain DIM `|` (`SEPARATOR=" \033[2m|\033[0m "`, L24).
6. Neighbours: dim labels + coloured values; fixed hues per segment type.
7. Light/dark: not present.
8. Glyphs: box drawing only for the git/dir bits; no emoji.
9. Notable: usage colours avoid green (blue -> magenta -> red) so "green" is reserved for context/effort/branch.
10. Customisation: edit script; has rate-limit cache + high-water lock (behaviour, not styling).

## EstevamBruno/cc-token-bar
https://github.com/EstevamBruno/cc-token-bar — stars 0
1. By state: one segment. `plugins/token-bar/bin/statusline.sh`: 20-cell `█`/`░` bar and `[bar] pct%` coloured green `\033[32m` (<70), yellow `33` (>=70), red `31` (>=90); model name and window size (`200k`/`1M`) uncoloured.
2. Themes: not present.
3. Colour spec: ANSI 16; no detection/NO_COLOR.
4. Fill: foreground.
5. Separators: single space.
6. Neighbours: not present (one coloured block).
7. Light/dark: not present.
8. Glyphs: `█ ░`.
9. Pure-bash JSON parsing, no jq (header comment).
10. Customisation: none; `install-statusline.sh` writes settings.

## ethanbch/tempo
https://github.com/ethanbch/tempo — stars 0
(A Next.js dashboard for Claude usage; the statusline is `scripts/statusline.mjs`, which mostly relays rate limits to Tempo.)
1. By state plus roles. Palette "Readout" (L136-143): `accent` #8b93ff, `warning` #e5b04a, `critical` #e5675a, `ink` #ecebe7, `muted` #8c8c8c, `faint` #555555 (all truecolor `38;2`). Model name accent; effort muted with a filling glyph `○ ◔ ◑ ◕ ●` (`EFFORT_GLYPHS`); fast mode warning `⚡`; folder basename ink; branch muted with `⎇`; dirty `●` warning; ahead/behind muted. `gauge()` (L403): tone = critical at >= `criticalAt`, warning at >= `warnAt`, else accent: ctx 60/80, 5h and 7d 70/90; filled `▰` in tone, empty `▱` faint; reset time faint.
2. Themes: not present in the statusline (one palette). The web dashboard has light/dark detection separately.
3. Colour spec: truecolor only; `NO_COLOR` is referenced in the repo (3 hits, in the CLI files read), not in `statusline.mjs`; no depth detection there.
4. Fill: foreground only.
5. Separators: faint `  ·  ` (`SEPARATOR`).
6. Neighbours: grey ladder (ink > muted > faint) with a single accent hue; status colours reserved for warning/critical.
7. Light/dark: not present in the statusline (greys chosen for dark terminals).
8. Glyphs: `▰▱ ○◔◑◕● ⎇ ⚡ ↻`; no Nerd Font; locales en/fr/es/de for text.
9. Notable: "statuses reserved" design — one accent hue plus amber/red only for thresholds; alert notifications at 80/95%.
10. Customisation: env `TEMPO_LIMITS_PATH`, `TEMPO_ALERT_THRESHOLDS`, `TEMPO_ALERT_DRY_RUN`, `TEMPO_LANG`; no colour options.

## ezequielmm/claude-doom
https://github.com/ezequielmm/claude-doom — stars 0
1. Not a segment scheme: the statusline is a pixel-art image. `lib/fire.mjs` has the DOOM PSX 37-entry `FIRE_PALETTE`; `lib/render.mjs` renders pixels as half-blocks `▀` (fg = upper pixel, bg = lower pixel; `renderHalfBlocks`) or quadrant glyphs (`renderQuadrants`), with per-cell colours chosen from pixel content. Text/status segments are minor.
2. Themes: not present (palette fixed).
3. Colour spec: truecolor `38;2`/`48;2` if `COLORTERM` matches `/truecolor|24bit/i` (`detectTruecolor`, `scripts/statusline.mjs` L67-69), otherwise downsampled to 256 via `rgbTo256` (cube + grey quantiser, `render.mjs` L18-60). No NO_COLOR found.
4. Fill: both (fg+bg per cell).
5. Separators: not applicable.
6. Neighbours: not applicable.
7. Light/dark: not present.
8. Glyphs: `▀`, quadrant blocks (U+2596-259F), plus Kitty/iTerm2 image protocols for pixel-perfect mode (`gfx-protocol.mjs`).
9. Notable: runs real DOOM (WASM) and an animated fire banner in the statusline; AFK attract mode; Kitty/iTerm graphics.
10. Customisation: config object (`banner`, `backdrop`, `style` keys read in `statusline.mjs`) and env `AFK_ARCADE_*`.

## fabianferno/payload
https://github.com/fabianferno/payload — stars 0
1. Fixed per element, one tiny line. `plugin/payload/bin/payload-statusline.mjs` `C` (L28-35, 256-colour): `dim` 245, `blue` 75, `cyan` 51, `green` 42, `white` 255, `violet` 141. Output: `▍PayLoad` blue, ad body white as an OSC-8 link, advertiser dim, earnings `+price` green, 🧠 marker violet, wallet dim.
2. Themes: not present. (`web/` is a Next.js marketing site with its own colours; `StatusLine.tsx` is a web mock of the line.)
3. Colour spec: 256-colour index; no detection/NO_COLOR.
4. Fill: foreground.
5. Separators: plain `·`, `→`.
6. Neighbours: fixed hues per role.
7. Light/dark: not present.
8. Glyphs: `▍`, 🧠.
9. Notable: the statusline is an ad slot (x402 ad endpoint) with clickable link.
10. Customisation: `payload-config.mjs` for wallet/settings; no colour options.

## fabifont/claude-statusline
https://github.com/fabifont/claude-statusline — stars 0
1. Fixed per item, user-chosen. Each `[[items]]` has an optional `color` (`statusline.toml.example`; README "Item keys"), validated against 18 names in `src/format.rs` `is_supported_color` (black, red, green, yellow, blue, magenta, cyan, white, bright_* variants, gray/grey → 90); `apply_color` (L82-112) maps to `\x1b[3Xm`. No threshold/state colouring in `items/limits.rs` (grep found no colour use): colour is purely per-item config.
2. Themes: not present. Colours live per item in `config.toml`; `--preview colors` lists them.
3. Colour spec: ANSI 16 by name only; `colors_enabled` bool (global, default true) turns all off; no NO_COLOR env handling seen; no depth detection.
4. Fill: foreground only.
5. Separators: text `separator` (default `" | "`), uncoloured.
6. Neighbours: whatever colours the user assigns; separator only.
7. Light/dark: not present.
8. Glyphs: emoji for peak hours (`🔥`), `✓ ✗ ⋯` for PR state; no fallback modes.
9. Notable: priority-based dropping of items when `COLUMNS - width_margin` exceeded; `command` item (external command output); OSC-8 PR links (`links_enabled`); `--preview` and `--preview validate/explain`.
10. Customisation: TOML (lookup order `CLAUDE_STATUSLINE_CONFIG`, `$CLAUDE_CONFIG_DIR/statusline.toml`, `~/.claude/statusline.toml`, XDG), CLI `--preview`, setup subcommand (`src/setup.rs`).

## fabioivan/claude-code-mods
https://github.com/fabioivan/claude-code-mods — stars 0
(`synapse-rate-limit` mod: a themeable layer over the claude-hud statusline (jarrodwatts) running inside Claude Code's mod UI; other mods in the repo not read.)
1. Roles in the HUD, overridable per theme. `hooks/hud/render/colors.ts`: role functions with defaults — `model` CYAN, `project` YELLOW, `git` MAGENTA, `gitBranch` CYAN, `label` DIM, `custom` `38;5;208` (Claude orange), `warning` YELLOW, `critical` RED; context bar `getContextColor`: critical >=85 (red), warning >=70 (yellow), else `context` (green); quota `getQuotaColor`: >=90 or pace critical red, >=75 or pace warning bright magenta, else bright blue. Themes override via `HudColorOverrides` (keys model, project, git, gitBranch, label, context, usage, usageWarning, warning, critical, custom, barFilled, barEmpty).
2. Themes: 13 in `hooks/themes.ts` `THEMES`: classic (no change), neon, rainbow, emoji, sakura, kawaii, mecha, shonen, tokyo-night, matrix, nerd, powerline (+ a `gallery` screenshot). Format: `{ name, sample, palette: Partial<HudColorOverrides>, glyphs, separator?, extras?, powerline?, gradient?, mascot? }`. User-defined themes: `findTheme` resolves by name from the bundled list; custom colour overrides come from HUD config `colors.*` (config.ts L425-427 accepts named, 0-255, or `#rrggbb`).
3. Colour spec: named ANSI 16, 256 index, or `#rrggbb` truecolor (`resolveAnsi`, colors.ts). Mod span colours are hex strings. No NO_COLOR handling seen.
4. Fill: both — `powerline` theme sets `backgroundColor` per segment (`powerlineSpans`).
5. Separators: HUD's ` │ ` replaced per theme (`separator: {text, color}` e.g. neon ` ❯ ` #7a5cff, rainbow ` ✦ ` #f857a6); powerline theme: `cap` `` with `{color: bg, backgroundColor: nextBg}` (fg = this segment's bg, bg = next segment's bg).
6. Neighbours: powerline cycles `backgrounds: ['#313244','#45475a','#1e1e2e']` by position (`pl.backgrounds[i % length]`); gradient themes colour bar cells along stops; otherwise separators + role colours.
7. Light/dark: not present (Catppuccin Mocha-like dark backgrounds).
8. Glyphs: per-theme glyph sets (`NERD_GLYPHS` with PUA codes, emoji, kawaii text mascot faces); header note keeps emoji to default-presentation to avoid width errors.
9. Notable: gradient along bar cells (`gradientAt`, `gradientSpans`, rainbow = 7 stops), mood-based mascot per gauge state (`Mood`: calm/busy/worried/panic/out), `/hud theme` list command with `sample` strings, theme PNG gallery in `assets/themes/`.
10. Customisation: `/hud theme` command, HUD config colours (`colors.*`), glyph sets, bar chars (`colors.barFilled/barEmpty`).

## fegome90-cmd/fabrik_bar
https://github.com/fegome90-cmd/fabrik_bar — stars 0
The statusline script itself (`~/.claude/statusline.sh`) is not in the repo (tree has hooks/, lib/, tests only); the repo is the hook-notification half. 1-10: `unverified (README only)` — README table lists model 🎭, dir 󰉋 (Nerd), branch `main*`, `+42 -13`, ctx bar `███░░░░░ 25%`, bundles 📦, MCP, timer ⏱, PR 🔶; no colour rules readable. Only styling-adjacent code is hook alert text at 80% (⚡) and 90% (⚠️) thresholds (`lib/constants.py` `DEFAULT_WARNING_THRESHOLD` 80, `DEFAULT_CRITICAL_THRESHOLD` 90). Config is `fabrik_bar.local.md`.

## felipe-donoso-zenta/claude-mods
https://github.com/felipe-donoso-zenta/claude-mods — stars 0
1. Fixed per segment (256-colour), plus state for context. `statusline/bin/statusline.js` helper `c(code, s)`: spark glyph `38;5;173` (orange), model bold `1;38;5;215`, effort `90`, branch `38;5;75` (blue), dirty count `●N` `33` else `✓` `32`, ahead `32`/behind `31`, account `38;5;141`, context bar `▰/▱`: `31` red >=80, `33` yellow >=60, `32` green; empty `▱` and separator `  │  ` `90`; update notice `33`.
2. Themes: not present.
3. Colour spec: ANSI 16 + 256 index; no detection/NO_COLOR.
4. Fill: foreground only.
5. Separators: plain grey `  │  `.
6. Neighbours: fixed hue per segment (orange model, blue branch, violet account), grey separators.
7. Light/dark: not present.
8. Glyphs: animated Claude spark `['✻','✽','✺','✹','✺','✽']` by `Date.now()/1000`; `⎇ ◉ ↑ ↓ ● ✓`; sanitises control chars from untrusted text (`clean`).
9. Notable: animated glyph via per-second frame choice; mod keeps the script updated and writes `update.txt` notice; `dev-panel` mod not styled here.
10. Customisation: edit script; installed/updated by the statusline mod.

## ferrarifankid04/ai-skills-public
https://github.com/ferrarifankid04/ai-skills-public — stars 0
not a Claude statusline: a mirrored collection of agent skills for several tools; the only statusline is the "caveman" badge, `antigravity/caveman/src/hooks/caveman-statusline.sh` — prints `[CAVEMAN]` or `[CAVEMAN:<MODE>]` in a single fixed 256-colour orange (`\033[38;5;172m`), plus an optional savings suffix in the same colour (opt out with `CAVEMAN_STATUSLINE_SAVINGS=0`); mode is read from a whitelisted flag file (`.caveman-active`). No themes, no NO_COLOR, foreground only, no separators.

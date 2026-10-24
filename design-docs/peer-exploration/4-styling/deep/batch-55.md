# Batch 55: statusline styling, read from source

All 25 projects have 0 stars. Fetched files live under raw.githubusercontent.com; paths below are repo-relative.

## tonys-tcc
https://github.com/mysticalsin/tonys-tcc — stars 0
(A dotfiles repo that configures the upstream `ccstatusline` npm package, plus a bash health script and a separate "samantha" Python voice HUD.)
1. Per-widget fixed colour in `.config/ccstatusline/settings.json`: model=cyan bold, dir=brightBlue, git-branch=magenta, session-cost=green, tokens-total=cyan, total-speed=brightCyan; emoji prefixes are separate `custom-text` widgets in white. Threshold/state colour comes from `.claude/bin/cc-health.sh` (`preserveColors:true` custom-command widgets): ctx/limit % green `38;5;115` <70, amber `215` 70-89, red `203` >=90 (lines 40-45); effort level -> gray 245/cyan 80/yellow 227/orange 214/red 203 (`ecol`, lines 66-73).
2. Themes: not present (the powerline block is `enabled:false`; no theme names). Users edit the JSON.
3. 16 names via ccstatusline (`colorLevel: 2` = 256) plus raw `38;5;N` in cc-health.sh and truecolor `38;2;r;g;b` for the rainbow rule (lines 13-27). No NO_COLOR handling found in the files read.
4. Foreground-only; powerline disabled (`settings.json` powerline.enabled=false).
5. Plain two-space `defaultSeparator` (`"  "`); `inheritSeparatorColors:false`. A separate full-width `─` rule is drawn in a hue-swept rainbow (`cc-health.sh rainbow`, `_rb` awk hsv function, hue offset = `(epoch*37)%360`).
6. Neighbours distinguished by different fixed hues and by the two-space gap; nothing else.
7. Not present. Fixed 256 indices (245 grey "dim", 238 empty-track) assume a dark terminal.
8. Emoji prefixes (🤖 📁 🌿 💲 📊 ⚡ 💭 ⚠); no ASCII fallback.
9. Truecolor hue-sweep rainbow rule and rainbow-filled bars (`_rb` filled cells get hue `off + j*360/n`, empty cells `38;5;238`), animated by the time-seeded offset. samantha/ui.py/hud.py use `rich` styles ("bold red" when context over threshold else "cyan", hud.py:179).
10. ccstatusline `settings.json` (v3 schema); `install.sh` symlinks dotfiles; cc-health.sh takes a mode arg (effort/ctx/limits/rainbow) and env `RB_OFF`.

## ttt
https://github.com/mysticalsin/TTT — stars 0
(A "task time tracker" CLI whose statusline output is two more `ccstatusline` custom-command widgets, added by `scripts/statusline.mjs`.)
1. Fixed per role in `lib/style.mjs` `c`: dim 245, faint 240, green 115, amber 215, red 203, cyan 80, sky 117, violet 141, pink 211, gold 222, white `97`. Palette is copied from tonys-tcc's cc-health.sh (comment line 1). Used in `lib/bar.mjs` as semantic-ish picks (e.g. violet for one fact, pink for another, red/green for over/under forecast); no per-segment table, each string picks its colour inline.
2. Themes: not present. (`prefers-color-scheme: dark` appears only in the HTML report/dashboard CSS, `lib/dashboard.mjs:76`, `lib/trace-html.mjs:29`, not the statusline.)
3. 256-colour indices, plus truecolor for the gradient bar. `NO_COLOR` honoured and `--plain` flag disables escapes (`style.mjs:3`).
4. Foreground only.
5. `scripts/statusline.mjs` only inserts widgets into ccstatusline's JSON; separators are ccstatusline's. Inside the bar, ` · ` and dim text.
6. Different hues per fact; dim for secondary text.
7. Not present.
8. Emoji heavy (⏳ 🔮 etc., bar.mjs doc comments); `▰▱` gauge cells and `▁▂▃…` sparkline; no fallback.
9. `gradientBar(frac, cells, {from:180,to:300,over})` in style.mjs:25-41: truecolor hue sweep cyan(180°)->violet(300°) across filled cells, tip turns `38;5;203` red when past forecast.
10. Env `NO_COLOR`, `TTT_CACHE_DIR`; `--plain` flag; no colour config.

## visor
https://github.com/namyoungkim/visor — stars 0
(Go statusline with TOML config and a bubbletea TUI configurator.)
1. Threshold-by-state: `internal/widgets/widget.go:41-58` `ColorByThreshold` returns "green" below warn, "yellow" >= warn, "red" >= danger (context 60/80 %, cost $0.5/$1, latency 2000/5000 ms, block timer 80/95 %); inverse variant for cache-hit (80/50). Thresholds overridable per widget (`warn_threshold`, `critical_threshold`, context.go:27). Non-threshold widgets take a per-widget `color` in config.
2. Themes bundled: 6 in `internal/theme/presets.go`: default, powerline, gruvbox, nord, gruvbox-powerline, nord-powerline. Format = semantic palette `ColorPalette{Normal, Warning, Critical, Good, Primary, Secondary, Muted, Backgrounds[]}` + `SeparatorSet` + `Powerline bool` (`types.go`). Users override any palette slot, backgrounds and separators in `[theme.colors]`/`[theme.separators]` (`resolve.go`, config template in `internal/config/defaults.go:50-70`). Caveat: in the files read, `main.go` `renderSession` calls `render.Layout`/`SplitLayout` with a plain `general.separator` and never `theme.Resolve` or `PowerlineLayout`; wiring of the theme package into the live render path is unverified.
3. Named ANSI 16 map (`ColorMap`/`BgColorMap`, ansi.go:50-90) and `#RRGGBB` truecolor only (`RGB`/`RGBBg`, `HexToRGB`). No downsampling, no NO_COLOR in files read.
4. Both: `PowerlineLayout` fills each segment bg+fg (layout.go:108-165); default layout is fg only.
5. Powerline mode: U+E0B0 arrow, arrow fg = this segment's bg, arrow bg = next segment's bg, final arrow into default bg (layout.go:140-165). Default mode: ` | ` text. SeparatorSet has hard/soft left/right glyphs (types.go).
6. By position: `Backgrounds` list cycled across adjacent widgets (presets.go comment "Background colors cycle for adjacent widgets"; powerline preset `#3c3836,#504945,#665c54,#7c6f64` = lightness steps of one hue; gruvbox/nord 3 steps).
7. Not present (no luminance-based text pick found).
8. Powerline glyphs optional; ASCII ` | ` default. Emoji not checked.
9. `cc-candybar`-relevant: Backgrounds in presets are pure lightness ramps of a single neutral (gruvbox bg1->bg3), the "lightness steps" approach.
10. TOML `~/.config/visor/config.toml`; `visor --init <preset>`, `--check`, `--tui` (bubbletea editor, `internal/tui`), `--setup`, `--debug`.

## claude-usage-hud
https://github.com/NasckDev/claude-usage-hud — stars 0
1. By threshold, one function (`statusline.js:28-33`): pct >= 85 red, >= 60 yellow, else green; null -> dim. Applies to Ctx, 5h and 7d gauges. Model name is fixed magenta (line ~160), everything else dim.
2. Themes: not present in statusline.js. The desktop widget `widget/usage-widget.ps1` (PowerShell, 18 hex colours) was not read: unverified.
3. Raw 16-colour SGR codes (`\x1b[31m`..`36m`, 2 dim, 1 bold); no depth detection, no NO_COLOR.
4. Foreground only.
5. Plain dim `│` with two spaces each side (line ~172).
6. Different content colours (magenta model, threshold-coloured gauges) and dim labels/separators.
7. Not present. At narrow width (`COLUMNS`) the model/dir part is dropped rather than recoloured.
8. Block gauge `█ ▌ ░` (6 cells); no emoji in the statusline; text in Portuguese.
9. Writes a shared state JSON (`STATE_FILE`) for the separate desktop widget.
10. Installers only (install.sh/.ps1); no config; constants edited in source.

## nathansimony/claude-statusline
https://github.com/nathansimony/claude-statusline — stars 0
1. Role -> colour using Claude Code's own theme tokens (`lib/statusline.sh:114-135`): claude `#D77757` (model/engine), success (clean git branch, +added, READY deploy), warning (dirty git, ctx >= 70 %, limits >= 50 %, BUILDING), error (ctx >= 85 %, limits >= 80 %, -removed, ERROR), inactive (cost, duration, normal ctx/limits, vercel url), border (the `·` separator), plan (`planMode`, directory name). Thresholds in a few `if` ladders (ctx 70/85; limit max 50/80).
2. Two embedded token tables, `dark` and `light` (7 tokens each), not user-extensible. Selection tracks Claude Code's own `/config` theme (below).
3. Truecolor `\033[38;2;r;g;b m` only; no 256/16 fallback, no NO_COLOR seen.
4. Foreground only.
5. Single dim-border-colour `·` between "clusters" (identity | engine | context | limits | metrics | diff | deploy), one leading space stripped for symmetry (lines ~122-140).
6. Clusters separated by a dot; within a cluster hues differ by role.
7. Yes, notable: `resolve_theme()` (lines 22-47) reads the `theme` key from `~/.claude/settings.json`, `settings.local.json`, then project equivalents (later wins); `light*` or `dark*` prefix (also -daltonized/-ansi variants) picks the table; for `auto`/unset it falls back to `COLORFGBG` (last field 0-6 or 8 = dark, else light), else dark. Light table has darker success/warning/error values (e.g. success `#2C7A39` vs dark `#4EBA65`).
8. `▲` for Vercel deploy, `⎇`-free; otherwise text. Minimal glyphs.
9. Mirrors Claude Code's palette so the bar looks native; re-resolves each render so changing theme in /config changes the bar next tick.
10. Reads Claude Code settings; no own config. `install.sh`/`uninstall.sh`.

## claude-bar
https://github.com/NatoliChris/claude-bar — stars 0
1. Fixed per semantic role (`src/theme.rs:25-52`, 10-variant `Color` enum): Model bright cyan, Effort bright magenta, Good green, Warn yellow, Bad bright red, Money yellow, Add green, Del red, Dim bright-black, Plain none. Segments (`src/segments.rs`) pick: model->Model, effort->Effort, git branch->Plain with ` ●` Warn when dirty, cost->Money, +/- lines->Add/Del, durations/labels->Dim. Threshold segments: context `context_color` (>=90 Bad, >=70 Warn, else Good; theme.rs:108), rate limits `usage_color` (>=80 Bad, >=50 Warn, else Good).
2. Themes: not present; the `Theme` struct only holds a `color: bool`.
3. SGR 16 only (90/91/9x). `NO_COLOR` honoured (`main.rs:46` -> `Theme::new(false)`).
4. Foreground only.
5. Dim-grey ` · ` (theme.rs `SEP`).
6. By hue per role and a dim separator only.
7. Not present.
8. Emoji (💰 handled as 2 cells via a `WIDE` list), `▓░` bar; some segments have compact detail levels dropped by priority under width pressure (segment.rs: priority + ordered `levels`).
9. Width-priority degradation: each segment has detail levels, lowest-priority dropped first.
10. No config file found in files read; NO_COLOR env only.

## naughty00shortie/claude-statusline
https://github.com/naughty00shortie/claude-statusline — stars 0
1. Fixed per segment in `statusline/statusline.sh:181-193`: dir bold blue `1;34`, git branch yellow `0;33` with `⎇`, model cyan `0;36`, cost bold bright yellow `1;93`, cpu bold bright red `1;91`, ram bold bright blue `1;94`, labels dim. Quota bar by state (lines 124-134): >=90 % bold red, >=75 orange `38;5;208`, >=50 yellow, else green; same colour on bar and %. Now-playing line: green ♫, magenta artist, cyan title, yellow/green progress (lines 31-55).
2. Themes: not present.
3. Raw SGR 16 plus one 256 index (208 orange). No NO_COLOR.
4. Foreground only.
5. Dim `│` with spaces (`sep`, line 181).
6. Different bright hues per fact; bold vs normal; dim labels.
7. Not present.
8. `▰▱` gauge cells, `♫`, `⎇`; some emoji.
9. Multi-account quota rows with aligned fixed-width columns; `statusline-sys.sh` supplies cpu/ram numbers.
10. Shell scripts, `install.sh`/`.ps1`; edit script to restyle; a `provider-switch` plugin hook exists (not styling).

## navigotechsolutions-labs/claude-agent-skills-hub
https://github.com/navigotechsolutions-labs/claude-agent-skills-hub — stars 0
(A vendored dump of many repos; the flagged statusline files are copies of three unrelated projects.)
1. (a) `claude-hud/scripts/statusline.mjs` is only a launcher that imports the newest installed claude-hud plugin from the plugin cache; no styling in it (the real HUD code is not in these files: unverified). (b) `caveman/src/hooks/caveman-statusline.sh:76`: one badge `[CAVEMAN]`/`[ULTRACAVE]`/`[MEGACAVE]`/`[CAVEMAN:COMMIT]` in fixed 256-colour 172 (orange). (c) ruflo (claude-flow) `.claude/helpers/statusline.cjs` and `.claude/statusline.sh`: fixed per segment with bold bright SGR — header `▊ RuFlo` brightPurple, git name/domains brightCyan, branch brightBlue, hooks/arch purple/blue; state colours: context % <50 brightGreen, <70 brightCyan, <85 brightYellow, else brightRed (`statusline.sh:222-229`); security status green/yellow/red; `●` brightGreen done vs dim `○` pending.
2. Themes: not present in any of the three statusline files. (The "theme names" the scanner saw come from unrelated web apps in the dump.)
3. Raw SGR 16 (`0;3Xm` and `1;3Xm`) and a single 256 index (172) for caveman. No NO_COLOR.
4. Foreground only.
5. ruflo: dim `│` between header items; multi-line dashboard with emoji row labels (🏗️ 👥 🪝 💾 📊 🔧).
6. Hue per fact, dim vs bright.
7. Not present.
8. Heavy emoji and `▊ ● ○ ⟳ ⊘`; no ASCII fallback in the files read.
9. ruflo draws a multi-line dashboard with progress bars (`progressBar()`); caveman is a one-badge statusline.
10. Shell/Node scripts; edit source. Other flagged files (XcodeBuildMCP `sim_statusbar`, UI-TARS StatusBar.tsx) are not Claude statuslines.

## ClaudeBuddy
https://github.com/NBS1997/ClaudeBuddy — stars 0
(A tamagotchi-style ASCII pet drawn in the status line, with MCP server and hooks.)
1. By rarity of the pet (`buddy-statusline.js:240-244`): common 248 grey, uncommon 78 green, rare 69 blue, epic 135 purple, legendary 220 gold, used as the colour of the speech-bubble border, name, level tag and the dominant stat; the other stats are dim. A fading reaction uses dim 242.
2. Themes: not present in the statusline file. The scanner's "catppuccin / iceberg / night-owl" matches are not colour themes in the files read (README only has a "Night Owl" achievement); unverified elsewhere.
3. 256-colour indices (`38;5;N`); also cursor-column escapes (`\x1b[nG`) to right-align the sprite. No NO_COLOR.
4. Foreground only.
5. Rounded speech-bubble box `╭─╮│╰╯` in the rarity colour; stat strip uses `▰▱` bars joined by spaces.
6. Not applicable (one pet, one colour per rarity).
7. Not present.
8. Large box/braille sprite art (2400+ glyph lines), emoji for achievements.
9. Animated pet frames, evolution ceremony text for 15 s after stage change (`CEREMONY_TTL`), level-up and achievement banners.
10. Node scripts; progression saved in a save file; no styling config.

## claude-tamagotchi
https://github.com/ncrohn/claude-tamagotchi — stars 0
1. By pet mood (`bin/tamagotchi-render.sh:85-93`), one hex per mood: stressed `#fb4934`, tired `#d79921`, sleepy gray `#928374`, proud `#98971a`, dead `#504945`, happy `#b8bb26`. The whole segment (name, bar, level) takes that colour.
2. "Themes" = creature emoji sets only, `themes/{default,cat,dragon,ocean,octopus,plant}.json`: `{name, emoji[5], levels[5]}`, 7 including gruvbox mentioned in a comment. Not a colour theme; the palette is hard-coded Gruvbox (comment line 9).
3. Truecolor only via `hex_to_fg/hex_to_bg` (`38;2`/`48;2`); no depth detection, no NO_COLOR.
4. Both: fixed background `#3c3836` (Gruvbox bg1) behind the segment with a mood-coloured foreground (line 98, 111).
5. Space padding inside the filled cell; no separators.
6. Single segment; not applicable.
7. Not present.
8. Emoji creature (🥚🐣🐥…), `▰▱` HP bar, `⬆` level.
9. Mood-driven colour is the main styling idea.
10. Hex constants in the shell script; theme JSON for emoji; state in a JSON file.

## claude-usage-statusline (NehanSikder)
https://github.com/NehanSikder/claude-usage-statusline — stars 0
1. By threshold (`statusline-usage.py:33-38` `pct_color`): >= CRIT red `38;5;203`, >= WARN yellow `179`, else green `114`. Same colour on bar, % and the "N k / M k" text; labels and notes dim `244`.
2. Own themes: not present. It wraps the `claude-statusbar` (`cs`) tool, whose config `claude-statusbar.json` selects `"theme": "graphite"`, `"style": "classic"`, `color_ok/color_warn/color_hot` (null = default) and `mode_gradient`, `bar_shimmer`; those themes live in the other tool (unverified here).
3. 256-colour indices; no NO_COLOR.
4. Foreground only.
5. Two spaces / ` · ` text.
6. Different content colours + dim.
7. Not present.
8. Text-labelled ("Claude usage limits"), `█░` bar; light emoji.
9. Config key `bar_shimmer`/`mode_gradient` exist in the wrapped tool's settings file.
10. `claude-statusbar.json` (see 2); script constants WARN/CRIT.

## claude-mods (nemokoala)
https://github.com/nemokoala/claude-mods — stars 0
(Not a classic statusline: three "mod" plugins that draw in Claude Code's UI via a React/ink-style `ui.render` hook: git-graph, pretty-replies, usage-band. The usage-band is a rate-limit band above the prompt.)
1. usage-band (`plugins/usage-band/hooks/register.tsx:83-85`): by threshold, `toneFor(p)`: >= 80 % `{main:#ef4444, light:#fb7185}`, >= 50 `#f59e0b/#fcd34d`, else `#10b981/#5eead4`; same tone on the bar fill, label % and, in SVG mode, a gradient from `light` to `main`. git-graph: lane colours by position, `LANE_COLORS` 8 hex values cycled (line 15), `#3b82f6` for the branch header, `#f59e0b` for uncommitted changes.
2. Themes: not present; hex constants.
3. Truecolor hex passed to the host's `<Text color>`; no depth handling in these files. SVG output where the host can draw images (`Svg` component) with a text fallback.
4. Foreground; track `░` dim. SVG pill uses fill-opacity.
5. Not applicable (gauges in a flex `Box` with `marginRight`).
6. Not applicable.
7. git-graph SVG carries `@media (prefers-color-scheme: dark)` overrides for text and badge colours (register.tsx:367-369). usage-band relies on `dimColor`.
8. Block-eighth gauge (`█▏▎…`), pill SVG; Korean text strings.
9. Gradient pill SVG for gauges; image-capable surface.
10. Plugin hooks (TypeScript); no user colour config found.

## claude-prompt-band (neogeweb3)
https://github.com/neogeweb3/claude-prompt-band — stars 0
(Mods drawing a band above the prompt: usage-band and goal-meter. Not a command statusline.)
1. Fixed hue per metric (`usage-band/hooks/register.tsx:12-14`): five-hour `#5cc4d6`, seven-day `#e8a25f`, context `#9aa5f5`, cache `#72cf9f`; `RED #e5685f` takes over when a metric is in trouble (pct >= 80 for limits/context, cache hit < 50); track `#4a4f5c`. goal-meter (`goal-meter/hooks/row.mjs:12`): goal `#d5d8dd`, done `#72cf9f`.
2. Themes: not present. A fixed "look" selection exists (below).
3. Truecolor hex, with an explicit 256 downgrade `to256()` (register.tsx:62-74: nearest xterm cube/grey) and a `Look {style, colors:'true'|'256'}` preview matrix: Ghostty nerd/true, iTerm2/Warp/WezTerm/kitty unicode/true, macOS Terminal unicode/256, ascii/256 (lines 446-449). No NO_COLOR.
4. Foreground; bars are `■` cells (track in `#4a4f5c`).
5. Plain spaces/`·`; dim text.
6. Each metric has its own hue; red replaces the hue on alert.
7. Light/dark: SVG output declares `color-scheme: light dark` and swaps ink via `@media (prefers-color-scheme:dark)` (register.tsx:295-299): text is the hue darkened 38 % on light and lightened 25 % on dark (`lighten(hue,-0.38)` / `+0.25`).
8. Three glyph styles: nerd (`󰌨 `/`󰓾 ` icons), unicode (`≡ ●`), ascii (`ctx hit`, `#`/`-`), chosen by setting or autodetected: terminals in `NERD_BUILTIN` (ghostty) get nerd, else unicode (lines 20-31).
9. Animated gradient bars: fill runs deep->bright shade along its length (`shade -0.15..+0.2`) with a moving highlight (`glow` .55 on the cell at `frame % (cells+5)`, 200 ms frames), all bars in step.
10. Settings atom `style` (nerd|unicode|ascii|auto); mod hooks.

## ccstatusline-windows
https://github.com/Neragoth/ccstatusline-windows — stars 0 — FORK OF sirmalloc/ccstatusline
Differences only (fork is a Windows port frozen at package version 2.0.4; upstream HEAD is much later):
1. Same model as parent: per-widget `color`/`backgroundColor`, and with a theme, colour by position `themeColors.fg/bg[widgetColorIndex % length]`, index not advanced for widgets merged into the previous one (`src/utils/renderer.ts:~175-190`); custom-command widgets with `preserveColors` skip the theme foreground.
2. Themes in `src/utils/colors.ts` `POWERLINE_THEMES` (9 entries: custom, nord, nord-aurora, monokai, solarized, dracula, catppuccin, gruvbox, tokyonight), each with three tiers (`1` ansi16 names, `2` ansi256 indices, `3` hex) of 5 `fg` + 5 `bg` colours. Parent HEAD adds `minimal`, `onedark`, and more. Fork lacks upstream's newer features: gradient foreground specs (`gradient.ts`, `parseGradientSpec`), `applyParensDim`, the `dim` option, and raw-ANSI reset sequencing; it still uses chalk wrappers (`getChalkColor`, colors.ts ~129-160).
3. Same three levels (`ansi16`/`ansi256`/`truecolor`) chosen by the user's `colorLevel`; named colours carry an index+hex per level (colors.ts:12-47); `ansi256:N`/`hex:RRGGBB` strings.
4. Both (powerline mode fills bg).
5. Powerline separators and caps from config (`separators` default U+E0B0, `startCaps`, `endCaps`, `PowerlineConfig.ts`); same as parent.
6. By position cycling through the theme's five bg colours.
7. Not present in what differs.
8. Powerline font install helper adjusted for Windows (`windowsHide`, no `cd && ./install.sh`) in `src/utils/powerline.ts`; otherwise as parent.
9. As parent (TUI colour menu `ColorMenu.tsx`, theme selector); older snapshot.
10. Same TUI-driven `settings.json` as the parent.

## claudeline
https://github.com/NetBUG/claudeline — stars 0 — FORK OF lexfrei/ailine
Differences only: an older rename of ailine (binary/config strings "claudeline"); it lacks ailine's `PromptCache` segment (🧊 cold-cache marker, `promptCacheSegmentStyled`) and the `hyperlinks` (OSC 8 auto/on/off) config. Styling that remains and is shared:
1. Only the context segment is colourised: `internal/fmtutil/format.go:81-96` `ContextSegment` green `\033[32m` < 50 %, yellow `33m` >= 50, red `31m` >= 80 (`contextWarnPct`/`contextCritPct`). Everything else is uncoloured text with emoji icons.
2. "Themes" are icon styles: `theme = emoji | text` (`internal/config/config.go:89-100`). Not colour themes; no user-defined themes.
3. Basic SGR 16 plus 256-index 208 orange; no depth detection or NO_COLOR.
4. Foreground only.
5. Plain text spacing (`internal/fmtutil/scoped.go` not checked in detail).
6. Not applicable: mostly uncoloured emoji-led segments.
7. Not present.
8. Emoji by default; `text` theme drops icons and carries severity as colour: `statusColor` maps 🟢 green, 🟡 yellow, 🟠 orange(208), 🔴 red, 🔶 orange, ⚠️ yellow onto the text (format.go:143-173).
9. Status glyph -> text colour conversion in the text theme.
10. Viper config (YAML/env) with `theme`, `segments.*` modes.

## claude-dock
https://github.com/New-Retr0/claude-dock — stars 0
(A Claude Code mod panel ("dock") built from React-like elements; not a command statusline.)
1. Uses Claude Code's own theme token names as colours: `'claude'` (orange), `'warning'`, `'success'`, `'ide'` (blue), `'permission'` (lavender), `'error'`, `'text'`, `'inactive'`, plus literals `#827dbd` purple, `#ff5fa2` pink, `#a78bfa`, `#e8c547` (`cc-dock/hooks/register.tsx:36,396,421-422`). By state: bar colour `barColor(pct)` >= 90 error, >= 70 warning, else success (line 539); bypass button turns `error`; effort badge (`agent-model-badge/hooks/register.ts:24-28`): low success, medium ide, high warning, xhigh claude, max error (`EFFORT_COLOR`); model name `text` bold.
2. User picks colours from a fixed list of 9 named choices (`COLORS`, line 34-37: orange, yellow, green, blue, lavender, purple, red, white, grey) on a "Dock" tab for UI accents, rule colour, alt-rule colour, rule style (8 glyph styles), stored in the mod store (`DockLook`).
3. Host theme tokens + hex; the host maps tokens to its own light/dark theme, so adaptation is delegated. No NO_COLOR.
4. Foreground; `dimColor` for inactive.
5. A horizontal rule line with chosen glyph (`─ ━ ═ - = + · ╌`).
6. Not applicable (panel rows); chips in brackets `[ label ]`.
7. Via host tokens (the token names resolve per Claude Code theme), so it follows the user's theme without detection.
8. Emoji and box glyphs; no ASCII mode noted.
9. Rule "shimmer": a bright crest sweeping along the rule with a fading tail (`ruleFrame*5`, lines 2010-2030) and an "alternating colours" toggle that swaps base/alt every 2 cells; `[ ultracode ]` chip with letter-by-letter glow sweep at 90 ms (`cc-dock/hooks/chip.tsx`); animated mascot (`mascot.tsx`).
10. In-UI "Dock" settings tab with toggles (shimmer, alternating colours, avatar, header), persisted by the mod store.

## crabswarm
https://github.com/ngicks/crabswarm — stars 0
(Go multi-purpose tool; `crabswarm statusline render '<template>'` is its statusline.)
1. No colouring: output is whatever the user's Go `text/template` renders (`cmd/crabswarm/commands/statusline_render.go`, `crabswarm/statusline/statusline.go:Render`). The helper FuncMap (`internal/templateutil/templateutil.go`, layout.go) has padding/truncation/splitPath/join helpers, no colour or style functions (grepped none). Raw escape codes could be typed by the user into the template string: unverified.
2. Themes: not present. (Scanner's "github" theme is the web UI's ThemeToggle, unrelated.)
3. Not present.
4. Not present (no styling).
5. User-written text in the template.
6. User's responsibility.
7. Not present; `$COLUMNS` exposed as `{{ columns }}` so a template can shorten layout; width helpers count terminal cells (CJK/emoji = 2).
8. Whatever the template contains.
9. Nothing styling-related.
10. One positional CLI arg template; payload fields PascalCased (`.ContextWindow.UsedPercentage`, `.Model.DisplayName`, `.Effort`, `.Pr`, `.Worktree`).

## cli-statuslines
https://github.com/ngoohebi/cli-statuslines — stars 0
(Multi-agent: Claude Code, Codex, Antigravity adapters.)
1. A semantic palette keyed by data type (`src/lib/theme.js:8-55`, "Abyss" 256-colour dark theme): dir 60, vendor 60, model 91, repo 65, branch 95, glyph 24, label 240, border 244, positive 65 (cost, added, memory ok), negative 95, warn 130, error 88, effort low 238 / default+medium 65 / high 130 / xhigh 94 / max 88, agent running 130 / done 65, user-msg arrow 60, assistant arrow 65. Bars by state (`src/lib/format.js:43-57`): quota bars >= 80 barHigh(88), >= 50 barMid(130), else barLow(65); context bar uses a separate cool family (ctxBarLow 24, Mid 60, High 91) "to read distinct from the warm quota bars"; empty cells 234.
2. One bundled theme (the single `THEME` object); "Any visual change should land in this file" (theme.js header). No user theme loading seen.
3. 256-colour indices only; no 16/truecolor, no NO_COLOR (grep none).
4. Foreground only on the dark-grey box chrome.
5. Rounded box-drawing dashboard `╭─┬─╮ │ ├ ┤ ╰ ╯` (THEME.border) with `·` divider and `▎` glyph; border colour 244.
6. By role-hue and by cool/warm family; boxes divide rows.
7. Dark-only by design ("nothing glows or pops", low-chroma 24-130 cube range); no adaptation.
8. Box-drawing heavy; `█░` bars; a few emoji; no ASCII fallback.
9. Multi-row bordered dashboard with message column; cumulative stats hooks.
10. Config in `src/lib/config.js` (not read for colours); colours edited in source.

## claude-code-usage-statusline (nhooey)
https://github.com/nhooey/claude-code-usage-statusline — stars 0
(Python + a Node/TS Claude Code mod; spec-driven. Extremely detailed colour system.)
1. Fixed named colour roles defined once in `spec/layout.jsonc` (generates `spec.py` and `mod/src/spec.ts` via `tools/gen-spec.py`): ~25 foreground roles `F_*` and backgrounds `B_*`, each with a `"256"` and a `"true"` value. Examples (lines 398-560): F_BLU cwd 📁 (256 `rgb(0,175,255)` / true `rgb(100,170,255)`), F_PROJ project coral, F_GRN healthy/clean, F_AMB `*_WARN` thresholds, F_RED `*_CRIT`, F_OVER redder than F_RED, F_LIM_SESS = F_GRN for the 5-hour row, F_LIM_WEEK = F_RED for weekly, F_CHAT_U/B greys, F_SUM and F_RULE share one dim grey; B_DRK, B_MSG backgrounds for chat rows. Thresholds as data: `CACHE_WARN 80`, `CACHE_CRIT 50`, `QUIET_WARN_S 600` (line 831 ff.). Design rule in code comments: one colour per row, brightness (dim) carries magnitude (`claude_render.py:299`).
2. Themes: not present; one palette with two depth variants. Edited in the jsonc, regenerated.
3. Two tiers explicitly: true colour when Claude Code draws true colour, otherwise 256 values that are exact xterm palette entries "that Claude Code's rounding gives back" (channels 0/175/215/255 or greys 8-178 step 10); `gen-spec.py` refuses any other value and names the nearest, and refuses a dim-text value whose contrast on black is under a floor. `tools/palette-review.py` draws both sets, 256 value indices, chalk `rgbToAnsi256` rounding, the pair distances and any two names sharing a 256 entry. Env `COLORTERM`/`TERM` scrubbed in that tool; `NO_COLOR`/`FORCE_COLOR` only appear in its env scrub list (line 128), not a feature.
4. Mostly foreground; backgrounds (`B_DRK`, `B_MSG` = `rgb(175,0,175)`) for chat/message rows, with `F_MSG` white on `B_MSG`.
5. Column grid with `F_RULE` rules (same dim ink as `F_SUM`); no powerline.
6. Role-hue plus dim levels: "PAIRS" list in palette-review.py (lines 33-41) names role pairs that must stay visually apart (e.g. F_LIM_SESS vs F_LIM_WEEK, F_AMB vs F_YEL, F_PNK vs F_ETA) and prints their distances in both sets.
7. Contrast is checked against black for faint text (gen-spec floor); `PROMPT_BG` = Claude Code's default dark user-message background `(0,0,95)` is a pair target for B_MSG. Dark terminals assumed; no light adaptation seen.
8. Emoji as data (`E_*` glyph constants, effort ladder 🐢🚶🏃🚀🔥, 🔋🪫, 📁📦), each required to be single codepoint, <= Unicode 9, no variation selector, width-measured (`probe-advance.sh`, `docs/glyphs-and-terminals.md`); `E_SUB_DIGITS` subscript digits.
9. Spec-first approach with generated code in two languages; regenerate-or-test-fails (`tests/formatting.py`); `--nearest N` palette neighbours; renders agent panel and band at both depths.
10. `spec/layout.jsonc` (constants), `coding_agent_usage_line/config.py`, CLI; layout columns in the same jsonc (`"width"`, `"gap"`).

## claude-peak-hours
https://github.com/nickywan/claude-peak-hours — stars 0
1. Fixed per segment (`bin/statusline.sh:73-83`, truecolor): model blue `0,153,255`, cwd cyan `86,182,194`, white `220,220,220` labels, magenta `180,140,255`, plus orange `255,176,85`, green `0,175,80`, red `255,85,85`, yellow `230,200,0`. By state: `color_for_pct` (usage): >= 90 red, >= 70 yellow, >= 50 orange, else green (lines 126-132); `remaining_color` ("% free"): <= 10 red, <= 30 yellow, <= 50 orange, else green (226-232). Peak/off-peak banner: peak red bold, off-peak green bold ⚡ with a dim `~` (lines 409-421).
2. Themes: not present.
3. Truecolor `38;2` for text; dim and bold SGR. No NO_COLOR seen, no downsampling.
4. Foreground only.
5. Dim `│` with spaces (`sep`, line 84).
6. Hue per fact; red/green pair for peak vs off-peak.
7. Not present.
8. Labels localised (`L_PEAK`, `L_OFFPEAK`, `L_CURRENT`, `L_WEEKLY`), `⚡` emoji, block bars; `assets/gen-svg.sh` makes README images.
9. Peak-hours schedule indicator (time and duration) is the feature.
10. Shell script plus `bin/install.js` (npm); edit script constants.

## nicomlawson/claude-code-statusline
https://github.com/nicomlawson/claude-code-statusline — stars 0
1. By state only (`statusline-command.sh:50-76`): bar fill colour green < 50 %, yellow >= 50, red >= 80 (ctx, 5h, 7d); the unfilled `░` is dim. Model name and percentage numbers in `C_BLACK` (`\033[30m`, ANSI black), "resets" text dim.
2. Themes: not present.
3. SGR 16 (31/32/33/30/2). `NO_COLOR` honoured: every `C_*` set to empty (lines 5-11, comment cites no-color.org).
4. Foreground only.
5. Dim ` | ` (line 92).
6. Dim separators; colour appears only on the bars.
7. Risk worth noting: model/percent text uses ANSI black, which is unreadable on dark terminals (line 95, 100); no adaptation.
8. `█░` 5-cell bars; ASCII text labels (`ctx:`, `5h:`, `7d:`); no emoji.
9. Nothing else.
10. `install.sh`; `BAR_WIDTH` variable in script; `NO_COLOR` env.

## ccstatus-rs
https://github.com/NiHikKi/ccstatus-rs — stars 0
1. By position, with per-widget override (`src/main.rs:76-90`): bg = `cfg.colors[widget_name]` (fixed per widget, TOML `[colors]`) else `cfg.theme[slot % len]` where `slot` is the index among widgets that actually rendered (hidden widgets do not consume a slot), else 238. Default theme (`src/config.rs:42-43`): xterm-256 `[131, 173, 222, 144, 139, 110, 109, 67]` = Nord aurora+frost "red, orange, yellow, green, purple, cyan, blue, deep blue".
2. One built-in palette (the `theme` array), user replaceable in TOML; named themes: not present in the files read (the scanner's "nord" is that default's comment).
3. xterm-256 indices only (`\x1b[48;5;Nm`/`38;5;Nm`). No truecolor, no NO_COLOR.
4. Background-filled segments with a padded space each side.
5. Powerline arrow (default `\u{e0b0}`, configurable `separator`, `start_cap`, `end_cap`): arrow fg = previous bg, bg = next bg; last segment ends with `\x1b[49m` + arrow in its bg (`src/render.rs:28-50`).
6. Cycling through 8 distinct hues (not lightness steps); separator arrows with matched colours.
7. Yes: `fg_for(bg)` (render.rs:61-65) converts the xterm index to RGB (`xterm_rgb`), computes Rec.709 luminance `0.2126R+0.7152G+0.0722B`/255 and picks `fg_dark` (16) when > 0.55 else `fg_light` (231). Unit tests pin it (`fg_for(222)`=dark, `fg_for(67)`=light).
8. Nerd/Powerline font required for arrows; set separator `""`-style fallback described in the config template (config.rs:82-83 "Use \"\" to disable"). Few emoji.
9. Width-aware truncation drops trailing segments to fit `max_width` (render.rs:16-25).
10. TOML config (`config::load`, `ccstatus check` prints path and errors), per-line widget lists, `[colors]` overrides.

## nomnomtokens
https://github.com/NikolaiKushner/nomnomtokens — stars 0
(Token-usage tracker with a web dashboard; its statusline hook prints plain text.)
1. One colour: the label is cyan `ESC[36m` (`packages/cli/src/statusline-render.ts:20-24`, `paintLabel`); values are uncoloured. No threshold colouring in the files read.
2. Themes: not present in the statusline; `apps/web/app/composables/useTheme.ts` is the web dashboard's light/dark toggle.
3. SGR 16; honours `NO_COLOR` (checked with `!== undefined`) and deliberately ignores isTTY because the hook's stdout is a pipe (comment line 20).
4. Foreground only.
5. Plain text.
6. Not applicable.
7. Not present in the statusline.
8. Plain text.
9. Nothing.
10. CLI subcommand `statusline`; `NO_COLOR` env.

## niltonvolpato/claude-plugins (statusline plugin)
https://github.com/NiltonVolpato/claude-plugins — stars 0
1. Fixed per module via `python/statusline/defaults.toml`: model cyan, workspace blue, cost green, context yellow, version dim, git magenta; each module's `format` is Rich markup (`"[cyan]{{ theme.label }}{{ model.display_name }}[/cyan]"`) so the user can write any Rich style per module. Events module has per-context backgrounds (`main = "on #2a3a2a"`, `user = "on #3a2a2a"`, `subagent = "on #2a2a3a"`, `edit_bar #4c4d4e`), i.e. dark tints distinguishing agent contexts. Context percentage colour is fixed yellow (module "context"), not threshold-driven in the defaults read.
2. "Themes" are glyph/label sets, not colour: `theme = "nerd"` default with `nerd | ascii | emoji | minimal` per module (`themes.nerd.label = "  "`, `themes.ascii.label = "Model: "`, `themes.emoji.label = "🤖 "`, minimal drops the label). No colour themes.
3. Rich: `render_to_ansi` uses `Console(color_system="auto" if use_color else None, no_color=not use_color)` (`python/statusline/style.py:36-57`), so depth is auto-detected by Rich and downgraded; named ANSI, hex, and `on #hex` backgrounds all allowed. Config `color = true/false` toggles; env `NO_COLOR` handling is Rich's default.
4. Foreground text; the events module uses background tints.
5. ` | ` text separator by default (`separator` in defaults.toml).
6. Fixed hues per module and the separator; event runs differ by bracket style (`[ ]` main, `{ }` user, `< >` subagent) and background tint.
7. Width fit only: `get_terminal_width` subtracts Claude Code's 19 columns of padding (style.py:10-27); no light/dark adaptation.
8. Nerd Font icons by default (47 hits), ASCII, emoji and minimal alternates per module, switchable via `theme`.
9. Jinja-style templates in `format`, tool-icon tables for events (`tool_icons`, `bash_icons`, `event_icons`).
10. TOML: `~/.claude/statusline.toml` merged over `defaults.toml`; module list `enabled = [...]`; pydantic-validated config.py.

## cockpit-claude
https://github.com/noluyorAbi/cockpit-claude — stars 0
1. Mixed: fixed per segment plus thresholds (`src/statusline.js`). Fixed: model bold magenta, cwd bright cyan `1;96` with `▸`, git branch cyan `⎇`, cost green, repo ledger Σ gold `38;5;220`, lines `+` green / `-` red, ahead cyan `↑`, behind magenta `↓`, output style cyan. Threshold ladders: context bar green < 50, yellow < 65, orange `38;5;208` < 80, else blinking red (`C.blink + C.red`, lines 390-398); another ladder green < 50 / orange < 90 (lines 253-255); pool concurrency green < 3, orange < 9 (292-294). Dim for labels and `│`/`·` separators.
2. Themes: not present in the statusline. `video/src/theme.ts` is the Remotion promo video's palette (Claude coral `#d97757` accent, grays), unrelated.
3. SGR 16 + 256 indices (208 orange, 213 pink, 245 gray, 220 gold); `\x1b[5m` blink. No NO_COLOR in the file.
4. Foreground only.
5. Dim `│` and ` · `.
6. Hue per fact; bold vs dim.
7. Not present.
8. Unicode glyphs `⎇ ▸ Σ ◷ ⌁ ▶ ↑ ↓ ✓ █ ░`; few emoji.
9. Blinking red on critical context (`\x1b[5m`) is the notable one.
10. `cfg.segments` booleans (everything on by default; "a config file only ever turns things OFF or retunes a number", lines ~64-72); `cfg.colors` maps a segment key to a colour **name** from the fixed `C` table (`col(cfg, key, fallback)`, line 105) so model, cwd and ledger colours are user-overridable by name.

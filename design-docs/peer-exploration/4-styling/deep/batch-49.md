## joao-carmassi/claude-statusline
https://github.com/joao-carmassi/claude-statusline — stars 0
1. By state/threshold plus one fixed. `token-usage-statusline.js` `bar()`: context bar is green `38;5;114` below warn, yellow `38;5;220` at >=50, red `38;5;203` at >=75 (the `bar(ctx, 50, 75, ...)` call); `limBar()`: 5h bar green, yellow at >=75, red at >=90, the 7-day share drawn in fixed blue `38;5;75`. The leading "CAV" tag is by state of the caveman plugin: red = not installed, orange `38;5;208` = off, green = on (`cColor`). Labels `CONT`/`LIM` are uncoloured.
2. Themes: not present. Colours are literals in the script.
3. 256-colour indices (`38;5;N`), plus dim (`ESC[2m`) for the empty/unknown state. No depth detection, no NO_COLOR.
4. Foreground only; no backgrounds.
5. Plain ` | ` with the pipe dimmed (`sep` in the JS).
6. Neighbours differ only by the dim separator; all text uses the terminal default except the coloured bars and tag.
7. Not present.
8. ASCII only: `#` and `-` bar, `[ ]` brackets, no emoji or Nerd Font.
9. A `.ps1` twin (`token-usage-statusline.ps1`) is kept byte-identical (comment at the top of the JS); an `install-claude-statusline.ps1` installer.
10. No config. Customisation is editing the script; `CLAUDE_CONFIG_DIR` is read only to find the caveman plugin flag.

## johan--/claude-pulse-statusline (FORK OF NoobyGains/usage-pulse, now claude-pulse)
https://github.com/johan--/claude-pulse-statusline — stars 0
Fork differences only. This fork is an older snapshot of the parent's single-file `claude_status.py` (fork `VERSION = "3.1.0"`, 4,982 lines; the parent `NoobyGains/usage-pulse` HEAD is `3.6.0`, 11,096 lines), so the fork has the same styling model with fewer features and no styling of its own that I could find that is absent from the parent.
1. By threshold, themed: `bar_colour()` (`claude_status.py:1742`) maps usage <50 to `theme["low"]`, 50-79 to `mid`, >=80 to `high`. Every bar (session, weekly, context) uses it. Non-bar text takes one base colour from `TEXT_COLORS` via `resolve_text_color()` (:694) and `apply_text_color()` (:703), which re-applies it after every reset. Threshold flash (`FLASH_THRESHOLDS = (50, 75, 90)`, :1870) overrides the bar colour for 3 s.
2. Themes bundled: 10 in `THEMES` (:96): default, ocean, sunset, mono, neon, pride, frost, ember, candy, rainbow. Format: `{"low","mid","high"}` ANSI strings per theme (usage-level roles, not segment roles). `THEME_TEXT_DEFAULTS` gives each theme a default text colour. User-defined themes: not present (select a name only).
3. Named ANSI 16 (`\033[32m`), 256 index (orange 208, violet 135, ice 159, etc.), truecolor only inside animations (`pulse` uses `38;2;r;g;b`). No depth detection; NO_COLOR: not present (grep finds none).
4. Foreground only.
5. Plain ` | ` joined by `" | ".join(...)` (:3749), coloured by the base text colour.
6. Neighbours distinguished by the separator and by the bars' own threshold hues; text is one colour.
7. `text_color: auto` picks a per-theme text colour (`THEME_TEXT_DEFAULTS`); no light/dark terminal detection.
8. Eight bar-glyph styles (`BAR_STYLES`: classic ━─, block, shade, pipe, dot, square, star, plus braille gradient); ASCII spinner `| / - \` for the heartbeat; no Nerd Font.
9. Animations: `rainbow_colorize()` (:530), per-character `pulse`/`glow`/`shift` bar animation (:637), threshold flash, celebration glyph `✦` when weekly usage drops; `generate_gif.py` renders `assets/demo.gif`/`themes.png`.
10. JSON config (`load_config`, :861) written by CLI flags (`--theme`, `--text-color`, `--bar-style`, `--animate`, `--layout`, presets); a `/pulse` plugin command.

## joharraza/claude-deck
https://github.com/joharraza/claude-deck — stars 0
Not a command statusline: a Claude Code mod (plugin modules `deck`, `baton`, `limit-radar`, `workbench`) that draws a two-line band above the prompt; styling read from `plugins/deck/hooks/strip.tsx` and `model.ts`.
1. By state/threshold. `model.ts` `TONE` (:8-14): ok `#4ade80`, watch `#fbbf24`, hot `#f87171`, info `#22d3ee`, ctx `#a78bfa`, calm `#94a3b8`. `usageTone()`: green below 75, amber from 75, red from 90 (5h and 7d bars). Context bar colour `cool()` (:170) interpolates cyan to violet to pink as it fills (0-0.6, 0.6-1.0). Baton states have a colour each (light cyan, growing blue, ready teal, armed amber, holding grey, compacting violet, handed green). Git corner tone by motion: calm=ok, busy=info, knot=hot, else watch.
2. Themes: not present as a feature; fixed hex constants (`TRACK = '#3f3f46'` in `strip.tsx`). SVG docs adapt via `prefers-color-scheme` (art.ts).
3. Truecolor hex strings passed to Ink-style `<Text color=...>`; the host handles depth. NO_COLOR: not present.
4. Foreground only in the terminal strip (`backgroundColor` supported by the run type but unused for the main cells).
5. Plain: `   │  ` in `TRACK` colour between the corner and the message (`strip.tsx`).
6. By different tubes each carrying its own tone and a dim label; no alternating.
7. Dim attribute for labels/notes; a `lightdark.detection` hit is in art.ts's CSS `prefers-color-scheme` for README SVGs only. Terminal polarity: not present.
8. Unicode box/arc glyphs (`━ ─ ┃`, sweep `◜◝◞◟`, git sprite frames `●─●`, `╲✕╱`); no Nerd Font.
9. 10 fps animation in the strip (`surface.every(100,...)`): a light (`#ffffff`) running through the filled bar, blinking gold while a hand-off counts down, a "tick" notch showing time elapsed in the window.
10. Plugin options only (per-plugin settings, e.g. handoff token threshold 100K); no theme file.

## john-cornell/claude-statusline
https://github.com/john-cornell/claude-statusline — stars 0
1. Mostly fixed grey, one by threshold. `statusline.sh`: model `[name]`, branch `(branch)` and token counts are grey `\033[90m`; the context bar and percent are grey, yellow `\033[33m` at >=60, red `\033[31m` at >=85 (`COLOR`); the quota projection is grey, red once >=100%.
2. Themes: not present.
3. Named ANSI 16 only (90, 33, 31). No depth detection, no NO_COLOR.
4. Foreground only.
5. Plain: two spaces then a grey `|`.
6. Neighbours distinguished by brackets/parentheses and the grey `|`; no colour change between most segments.
7. Not present (grey 90 relied on to read on both backgrounds).
8. Block-shade bar `▓░` (10 cells); no emoji/Nerd Font.
9. Linear projection of 5h/7d usage at window reset (`calc_projection`) is shown as `(proj N%)`.
10. None; edit the script.

## jomplox/cache-clock
https://github.com/jomplox/cache-clock — stars 0
Not a statusline: a mod for the Claude Desktop app's Code tab that draws a prompt-cache countdown band above the prompt, with a keep-warm feature and a pixel-art "reward" animation.
1. By state. `hooks/register.tsx`: Ink-style named theme tokens, e.g. `<Text color="green">● Subagent running</Text>`, `color="red"` for cold, `color="yellow"` for warnings (:1948-2231), `'warning'`/`'success'` for end-state text (:2083); a fixed `GOLD = '#e3b341'` (:1442) for milestones.
2. Themes: not present; it inherits Claude Code's theme through named tokens (`success`, `warning`, `error`, `suggestion`).
3. Named tokens/ANSI names plus hex in SVG art; the host handles depth.
4. Foreground only in text; the LED panel and reward art are inline SVG.
5. Dim `·` separators in text (`dimColor`).
6. By hue per state (green warm, red cold) and dim text for secondary facts.
7. SVG art uses `prefers-color-scheme` (:438-439: `--bar #2a78d6`/dark `#3987e5`, `--good #0ca30c`, `--bad #ec835a`).
8. Emoji and glyphs (`⏱️`, `◷`, `❄`, `⚠`), SVG sprites, `scripts/sounds.mjs` chimes.
9. Animated LED sweep and "mint" block break-up animation in SVG (`<animate>`), pixel mascot variants.
10. Mod settings in the Desktop UI; no style config.

## jonyfs/statusline
https://github.com/jonyfs/statusline — stars 0
1. By role, with state on gauges. `src/colourRoles.js` `ROLE` + `SEGMENT_COLOURS` (a colour budget: one token, one meaning, with a test that fails if a segment uses a role it was not given). Roles: critical=red, attention=peach, modified=yellow, healthy=green, merged=mauve, identity=lavender (branch and model; effort takes the model's colour), open=blue (open PR), money=teal, cold=sapphire, skills=flamingo, neutral=surface0 (dir, repo, worktree, duration etc.). Gauges (context, fiveHour, sevenDay, spend...) fill neutral then attention then critical by band: `src/ramp.js` bands ok<60, warn<85, critical for rate gauges; context warn 70, critical 85 (`contextBand`); a pace band also exists (`paceBand`: >15 points ahead of the clock is critical, 90% used is critical regardless).
2. Themes bundled: 12 palettes in `src/theme.js` `PALETTES`: catppuccin mocha (default), frappe, macchiato, latte, plus nord, gruvbox, tokyonight, rosepine, dracula, solarized, onedark, and `terminal` (the terminal's own ANSI 16 via `ansi:N`). Format: one semantic palette with the same 19 token names in every theme (crust, mantle, base, surface0-2, text, red, peach, yellow, green, sapphire, blue, lavender, mauve, flamingo, teal, pink), so no segment can name a colour missing from a theme. Selected by `CLAUDE_STATUSLINE_FLAVOR`; user-defined palettes: not present as a file (a composer page and arrangement config exist for layout; README "Arranging the bar yourself").
3. Truecolor hex and ansi:N; downsamples to 256 by OKLab nearest cube/grey entry (`nearest256`, `colourDepth()` reads `COLORTERM`, `TERM_PROGRAM`, `TMUX`, `WT_SESSION`, `TERM`); honours `NO_COLOR` read per call (`colourEnabled()`) and in that case swaps to the thin separator because solid arrows need two backgrounds.
4. Background-filled chips (powerline), icon coloured on the fill; foreground-only variants exist for text counts.
5. Powerline separators selectable with `CLAUDE_STATUSLINE_SEPARATOR`: arrow (default), round (pills, with gap), slant, thin; `ascii` fallback `▸` (`SEPARATOR_GLYPHS`). Two adjacent chips on the same background are joined by the thin arrow (a solid one would vanish); between differing backgrounds the arrow takes the previous chip's colour as fg and the next as bg.
6. Neighbours: mostly the same neutral surface0 fill, split by arrows; coloured chips (branch lavender, model lavender, PR blue/mauve, critical red) stand out; thin arrows on same-colour neighbours.
7. Strongest of the batch. Text on a chip is chosen per background as whichever of the flavor's `crust`/`text` (`#11111b`/`#ffffff`) has the highest WCAG contrast and at least 4.5:1, darkening the background if neither reaches it (`chipColours`, `readableOn` in `src/contrast.js`); a test checks 4.5:1 for every chip in every palette; `CLAUDE_STATUSLINE_CONTRAST=high` forces black/white at 7:1; light terminal auto-detected from `COLORFGBG` (7 or 15) selecting `latte`, or an OSC 11 answer remembered by `install`/`doctor`; `CLAUDE_STATUSLINE_RAMP=cvd` replaces red/green with blue/yellow/red.
8. Icon tiers via `CLAUDE_STATUSLINE_ICONS`: `nerd` (default), `emoji`, `plain`; `CLAUDE_STATUSLINE_ASCII=1` swaps all glyphs and separators; optional event emoji.
9. Gauge with a 5-cell track and band mark glyph so colour is never the only carrier; sparkline option; overline hairline; dotted-underline links; `--format runs` outputs styled runs as JSON for a host that draws itself; works as a Codex/Copilot/opencode footer too; a browser composer page; `doctor --explain` prints a colour legend.
10. Env vars (`CLAUDE_STATUSLINE_FLAVOR/ASCII/ICONS/SEPARATOR/CONTRAST/RAMP/DIM/PADDING/BLOCK/OMIT`...), a JSON arrangement, `cli.js install/doctor` TUI-less CLI, composer page.

## jopolko/cctokenviz (FORK OF gosparq/claudewatch)
https://github.com/jopolko/cctokenviz — stars 0
Fork differences only. Not a terminal statusline: a Windows desktop (Go/Wails) always-on-top window. Its included `scripts/cctokenviz-statusline.py` is an uncoloured plain-text line (`model | ctx N% | 5h N% | 7d N%`, joined by ` | `) whose only purpose is to dump the payload to `~/.cctokenviz/status-<id>.json`.
1. Window UI colours come from CSS variables of the active theme (`frontend/themes.js`: `good`/`warn`/`danger`/`crit` on the meter by usage); terminal output has none.
2. Themes: 13 in `frontend/themes.js` `THEMES`: linux, scifi, bitcoin, ai, cowboy, anime, sweet, bloom, celestial, lab (groups "styles") and midnight, light ("Daylight"), contrast ("High contrast") (group "simple"). Format: `vars` (bg, panel, panel2, border, track, text, dim, strong, accent, good, warn, danger, crit), plus `look` (radius, border width, background pattern, heading decoration), `meter` kind (block, led, heart, smooth...), font, labels. User accent colour override exists; a full custom-theme file: not present.
3. CSS colours; no ANSI. NO_COLOR n/a.
4. Filled panels (GUI).
5. n/a (GUI panel borders).
6. n/a (GUI).
7. Default theme follows Windows `prefers-color-scheme` (midnight or light); `themeIsDark()` sets native title bar.
8. Emoji logos per theme; meter glyph shapes.
9. Meter kinds, pattern backgrounds (`gridBg`, `dotBg`, `scanBg`, `emojiBg`, `starsBg`), glow.
10. Settings in the GUI.

## josefthedev/claude-status-line
https://github.com/josefthedev/claude-status-line — stars 0
1. By state/threshold plus fixed. `statusline.sh` :31-38 / `lib/segments.py` :12-19 define BLUE `38;2;0;153;255`, ORANGE `255;176;85`, GREEN `0;175;80`, RED `255;85;85`, YELLOW `230;200;0`, WHITE `220;220;220`, DIM `2m`. `_color_for_pct` (segments.py:117): >=90 red, >=70 yellow, >=50 orange, else green (context, rate limits, exhaust ETAs). Cache hit % reversed (`_color_for_cache_pct`: >=70 green, >=40 yellow, >=15 orange, else red). Fixed: model BLUE, branch GREEN, directory WHITE, worktree label dim + YELLOW name, git ahead GREEN/behind RED/staged YELLOW/unstaged ORANGE, agents BLUE. Effort: low green, medium yellow, high orange, max red. Session timer orange when long, white otherwise. Hookify rule count yellow, red if blocking.
2. Themes: not present.
3. Truecolor `38;2;r;g;b`. No depth detection; no NO_COLOR.
4. Foreground only.
5. `│` (`SEP_CHAR`, `statusline.sh`:20), dimmed, with a space either side; a `lib/packer.py` packs segments into lines by width.
6. Separators only; labels in dim (`lbl`) vs value colours.
7. Not present (fixed truecolor values).
8. `▓░` bars; arrows `↑↓`; plain Unicode; tmux variant in `tmux/statusline.sh`.
9. Two renderers share the palette (bash and Python), a `hooks/gsd-statusline.js` for the GSD workflow phase colours (executing blue, verifying yellow, complete green, planning dim).
10. KEY=value `~/.claude/statusline.conf` plus per-project `.claude/statusline.conf` (`lib/config.py`); segment lists, labels, bar width.

## joshkerr/claude-mods
https://github.com/joshkerr/claude-mods — stars 0
Mostly not statuslines: three Claude Code mods (`pkexec-guard`, `long-task-notifier`, `herdr-statusline`). Only `herdr-statusline` is a band above the prompt.
1. `herdr-statusline/hooks/register.tsx`: theme tokens by role/state: workspace `claude` (bold), pane id and separators `subtle`, cwd `text`, branch `success` when clean / `warning` when dirty, `✓` `success`, `✎ N` `warning`, ahead/behind `subtle`, working dot `claude`.
2. Themes: not present; it uses Claude Code's own semantic tokens (`claude`, `subtle`, `text`, `success`, `warning`), so it follows whatever theme Claude Code is in.
3. Token names only; depth handled by host. NO_COLOR: not present.
4. Foreground only.
5. `  │  ` in `subtle`.
6. Separators plus role tokens.
7. Inherits from the host theme, which is the adaptation.
8. Glyphs `▣ ⎇ ✎ ✓ ↑ ↓ ●`; no Nerd Font.
9. `long-task-notifier` (timer in status line) has no colour code (`format.ts` has none).
10. None; plugin manifest only.

## jparkypark/ratatoskr
https://github.com/jparkypark/ratatoskr — stars 0
(The statusline app is called "chud", `apps/statusline`.)
1. By segment type, fixed per theme. `src/config/themes.ts`: `DARK_THEME_COLORS` and `LIGHT_THEME_COLORS` map segment types to `{fg,bg}`. Light (default, "Tailwind 500 rainbow"): directory red `#ef4444`, git orange `#f97316`, pr yellow `#eab308`, usage green `#22c55e`, pace cyan `#06b6d4`, context blue `#3b82f6`, time indigo `#6366f1`, thoughts violet `#8b5cf6`, all with fg `#ffffff`. Dark: vibrant fg/bg pairs (directory `#ff6666` on `#ec4899`, git `#ffbd55` on `#f97316`, pr `#ffff66` on `#10b981`, usage `#9de24f` on `#3b82f6`, pace `#87cefa` on `#9333ea`, context `#a5b4fc` on `#6366f1`, time `#c084fc` on `#9333ea`, thoughts `#9ca3af` on `#6b7280`). The colour is per segment type; the rainbow arrangement comes from the order of the defaults (`defaults.ts`).
2. Two bundled (light, dark) plus `themeMode: auto|light|dark`; per-segment overrides in config keys `darkTheme` / `lightTheme` (`ThemeColorOverrides`, merged by `mergeThemeColors`). Format: per-segment `{fg,bg}` map (not semantic roles). Segment-level `colors` in config too.
3. Truecolor hex; `chalk.level = 3` forced (`powerline.ts`), so no downsampling; no NO_COLOR.
4. Both: `colorMode: background | text` (`ThemeConfig.colorMode`; default config sets `text`: foreground-only with `chalk.dim('|')` between).
5. Powerline arrows selectable: `separatorStyle` angled, thin, rounded, flame, slant, backslant (`separators.ts`, E0B0-E0C2). Arrow fg = previous segment bg darkened 10% (`darkenColor`, "compensate for font rendering making separators appear lighter"), bg = next segment bg; the last arrow has no background.
6. Different hue per segment (rainbow across the bar) plus arrows.
7. Light/dark detection (`detect.ts`): macOS `defaults read -g AppleInterfaceStyle`, Linux `COLORFGBG` background >=7 means light, else dark. Dark theme uses tinted text colours; light uses white text.
8. Nerd Font glyphs (powerline, icons) optional via `powerline: boolean` and `display.icon`; segment text uses non-breaking spaces so wrap occurs at segment boundaries.
9. Context segment `mode: used`; SQLite-backed usage segment (`database/`), PR segment; a `motion.rainbow` hit is only the comment "rainbow".
10. JSON config `~/.claude/chud.json` (`parser.ts`), validated by `validator.ts`.

## jpsirois/claude-statusline
https://github.com/jpsirois/claude-statusline — stars 0
1. By threshold, one segment only. `statusline-command.sh` `format_rl()`: the 5h rate-limit text and bar is green `\033[32m`, yellow `\033[33m` at >=70, red `\033[31m` at >=90. Git staged `+N` green, modified `~N` yellow. Everything else uncoloured.
2. Themes: not present.
3. Named ANSI 16; no detection, no NO_COLOR.
4. Foreground only.
5. Plain ` | ` between emoji-labelled items; two lines.
6. Emoji icons (🤖 🧠 💰 ⏱️ 📁 🌳 🌿) distinguish items, not colour.
7. Not present.
8. Emoji only; `█░` bar.
9. Nothing notable.
10. None; edit the script.

## jqtmviyu/ccometixline-go (CCometixLine-go)
https://github.com/jqtmviyu/CCometixLine-go — stars 0
Go port of the Rust CCometixLine (README says it re-implements the Rust version; TUI `--config` and themes files not implemented).
1. Fixed per segment id, from config. `internal/config/config.go` `defaultSegmentDefs`: icon and text colour as ANSI-16 indices: model 14 (bright cyan), effort 13 (bright magenta), directory icon 11 (bright yellow)/text 10 (bright green), git 12 (bright blue), context_window 13, cost 3 (yellow), session 2 (green), environment 14. No thresholds in the colour code I could find (`context_window.go` has none); icons can be overridden per state via `Metadata["dynamic_icon"]`.
2. `Theme string` field default `"default"` exists, but themes are "not implemented" (README: "主题文件自动生成" listed as not implemented); user-defined per-segment colours in `config.toml`.
3. `AnsiColor` (config.go:53): `c16` index (0-15 -> 30-37/90-97), `c256`, or `r,g,b` truecolor, rendered in `internal/render/ansi.go colorCode`. No detection; no NO_COLOR.
4. Both: when a segment has `colors.background`, it is drawn as a filled cell with ` icon text `; otherwise foreground only (`renderSegment`, `statusline.go`).
5. `style.separator` default `" | "` drawn in white `\x1b[37m`; if the separator equals `` the powerline mode draws arrows with fg = previous bg, bg = next bg (`createPowerlineArrow`). `style.mode`: plain, nerd_font, powerline.
6. In powerline mode by different segment backgrounds; otherwise by the white separator and distinct icon/text colours.
7. Not present.
8. Each segment has `plain` emoji and `nerd_font` icon (`getIcon`); mode chooses.
9. Wrap at `wrap_width` (80) before the context segment (`Generate`); model-name pattern table (`models.toml`).
10. TOML `~/.claude/ccline/config.toml`; `models.toml`; no TUI in this port.

## jquezada19/claude-mods
https://github.com/jquezada19/claude-mods — stars 0
Not statuslines: five Claude Code mods (cache-status, usage-hp, ticket-phase, agents-panel, repo-diffs) that add a row to the band above the prompt (text in terminal, SVG art in Desktop) or open panes.
1. By state/threshold. `usage-hp/hooks/register.tsx` `colorOf(left)`: green when >50% left, yellow >20%, else red, with hysteresis (`prior`); `FILLS = { green '#4fb36b', yellow '#e0b93a', red '#ef3b36' }` for SVG. `cache-status/hooks/register.tsx`:498 colour `red` if cold, `yellow` if left < CLOSE, else `green`. agents-panel `draw.ts`: DONE `#3B9C5F`, FAIL `#D0453F`, LOST `#9a9a96`; each agent type has its own costume. ticket-phase picks a `RowColor` per phase state.
2. Themes: not present; named colours (`red`, `yellow`, `green`) go to the host's theme.
3. Named colour tokens; SVG hex. NO_COLOR: not present.
4. Foreground only in text rows.
5. Plain glyph separators.
6. By state hue and dim secondary text.
7. SVG art uses `prefers-color-scheme` dark/light CSS classes (`draw.ts`:24-25); `repo-diffs` highlights with a `github` theme (`highlight.ts`).
8. Hearts (`♥ ♡`), `●`, `◆◆◆◈◇`, `█░` bars; pixel mascot SVGs.
9. Pixel "Clawd" mascot art, walking-agent animation, diff highlighting.
10. Mod options only.

## juancho391/claude-crew-statusline
https://github.com/juancho391/claude-crew-statusline — stars 0
1. By threshold plus fixed. `statusline/statusline.sh`:8-13: MUTED `108 112 134`, TEXT `205 214 244`, MINT `126 224 181` (<60%), AMBER `245 194 107` (60-84%), CORAL `255 107 129` (>=85%) via `color_for()`; used for context, 5h and weekly bars and percent. Model name TEXT; labels/separators/empty track MUTED; activity: thinking LILAC `180 190 254` with cycling glyphs/verbs, tool use MINT, "needs you" blinks CORAL/MUTED, done MINT.
2. Themes: the statusline script has none. The companion mod `mods/subagent-crew/hooks/themes.ts` bundles 4 `THEMES`: warp, midnight, mocha, light, each a 9-key role palette {BG, CARD, EDGE, TRACK, TEXT, SUB, MUTED, MINT, CORAL}; options pick `theme` and an override `background` hex.
3. Truecolor only (`rgb()` helper); no depth detection; no NO_COLOR.
4. Foreground only in the script; the mod's pane uses card backgrounds.
5. Plain `│` in MUTED with two spaces either side (`SEP`).
6. Separators and the muted label vs coloured value.
7. A `light` palette exists in the mod (mint `#1A9E6B`, coral `#D1365A`); the script has no adaptation.
8. Thin bar `━` (8 cells), braille spinner, `✶✸✹✺`, `✎ ⚡ ⌕ ⇶ ◍ ⚙`, `💤`; the bar's empty portion is the same glyph in MUTED.
9. Frame-indexed animation by clock (`now % n`, refreshInterval 1), hook-written activity state (`statusline-state.sh`), pixel crew sprites in the mod.
10. `settings.example.json`; mod options (`theme`, `background`).

## justanotherspy/garnish
https://github.com/justanotherspy/garnish — stars 0
Rust statusline with a documented SPEC (`SPEC.md`, `docs/`).
1. By theme role. `src/theme.rs` `Role`: accent, accent2, muted, text, ok, warn, hot, danger, frame, band1-4. Each module's sub-parts default to a role (`docs/modules/model.md`: icon accent, name text, id muted, fast warn, thinking accent2; `branch.md`: icon accent, name text, sha muted, dirty warn). Bars use bands by threshold: context `thresholds = [50,75,90]`, `band_colors = band1..band4` (`context.md`); any module takes `[modules.X.colors]` overrides with a role or literal (`red`, `208`, `#ff8800`).
2. Six bundled `PALETTES` (theme.rs): garnish (default), catppuccin-mocha, nord, dracula, tokyonight, mono (no colour, dim and bold only). Format: 13 semantic roles per palette; user overrides any role under `[colors]`; `presets/my-work-theme.toml` shows a user theme.
3. Hex, 256 index, named; `color = auto|always|never|256|truecolor` (`docs/config.md`:14). `auto` is truecolor unless `NO_COLOR` is set non-empty; `ColorMode::Ansi256` approximates with an exact-gray-aware cube mapper (`rgb_to_256`, tests pin themes' mapping).
4. Foreground only: the painter `Style` has `fg`, bold, dim, underline, no background (`src/ansi.rs`).
5. Frames, not per-segment caps: `FrameStyle` none, rounded, square, double, heavy, powerline, custom (`src/frame.rs`) with rules `─` between left and right groups (`fill`), optional animated `fill_pattern`, optional titles, boxes; separators between modules coloured by `separator_color` (default `muted`; or `inherit` = the colour of the first coloured undimmed segment of the module before it).
6. Single role colours (icon accent, value text) and the frame; no alternation. `align = true` pads columns.
7. `mono` palette and `dim`; `parens = dim` uses muted. No light/dark detection.
8. Icon sets `nerd`, emoji, ASCII (`src/icons.rs`, per-module `icons` table).
9. Animation (clock spinner, `*_frames` icons, travelling rule pattern, frozen with `--static`), caching workers, preview command, `docs` generated.
10. TOML config with presets, rows, columns, boxes, per-module tables; CLI (`garnish preview`, docs subcommand); `NO_COLOR`.

## justdan0227/claude-code-statusline
https://github.com/justdan0227/claude-code-statusline — stars 0
1. One colour for the model name; the parenthetical in another. `statusline.sh` `COLOR="dim_bright_green"` (the model name) and `PAREN_COLOR="teal"` (the "(1M context)" part). The script prints only the model name.
2. Themes: not present; a `--preview` flag prints every colour name x weight combination to choose from.
3. Named ANSI 16 (30-37, 90-97), 256 for `orange` (208), `pink` (213), `purple` (141), `teal` (44); `bold_`/`dim_` prefixes. Unknown name falls back to cyan. No detection; no NO_COLOR.
4. Foreground only.
5. A single space between name and parenthetical; no separators.
6. Name vs parenthetical colour.
7. Not present (the preview lets the user pick).
8. None.
9. `--preview` mode (`statusline.sh`).
10. Edit two variables at the top of the script.

## jweisber/claude-config
https://github.com/jweisber/claude-config — stars 0
A personal config repo; styling is `files/home/.claude/statusline.py` plus mods and a Claude Code theme.
1. By role and state in a fixed Catppuccin Mocha palette (`statusline.py`:14-23, truecolor tuples). Model LAVENDER, effort YELLOW, folder/git OVERLAY grey, other values SUBTEXT with OVERLAY labels. Context text turns YELLOW at >=50, PEACH at >=75, RED at >=90 (`warn`); 5h limit coloured by pace (`pace_color`: RED if >=90% used or projected >=100% at reset, YELLOW if projected >=90, else none).
2. Themes: the script is a single fixed palette. The repo also ships `files/home/.claude/themes/catppuccin-mocha.json`, a Claude Code custom theme (`"base": "dark"` plus `overrides` keyed by Claude Code's own colour tokens: claude, text, inactive, subtle, promptBorder, success, error, warning, merged, planMode, ide, etc.) — useful as a reference vocabulary for Claude Code's host token set.
3. Truecolor `38;2` and `48;2` helpers (`fg()`, `bg()`); no depth detection; no NO_COLOR.
4. Foreground only in the script (a `bg()` helper exists, unused in what I read).
5. Dim middle dot `·` in `#454759` between groups; left and right groups are spread to the terminal width found by walking `/proc` fds for a tty (`terminal_width`).
6. Quiet by design: values in soft grey text, labels one step dimmer; warning colours appear only on state.
7. Not present beyond the dark Mocha theme.
8. Nerd Font branch glyph ``, `↑ ↓` ahead/behind, `*` dirty; no emoji.
9. Mods `chat-frames` (spinner glyph) and `sidebar` in the same repo; the statusline saves the payload per session for the sidebar mod.
10. Edit the script; theme JSON is Claude Code's own `/theme` custom-theme format.

## jz-wilson/claude-mods
https://github.com/jz-wilson/claude-mods — stars 0
Mostly not statuslines: a marketplace of Claude Code mods (filetree, helper-desk, cache-clock, handoff, etc.). The one status line is `cache-bar`, which prints a bar under an existing inner statusline.
1. By state/threshold: `cache-bar/lib/bar.ts`: the cache bar and remaining minutes are green, yellow when remaining <= TTL/4, red when remaining <= handoff threshold (`min(handoffMinutes*60, ttl/5)`); everything else dim; "handoff now" red bold. Cold cache is all dim.
2. Themes: not present.
3. Named ANSI 16 via `esc('32')` etc.; no detection; no NO_COLOR.
4. Foreground only.
5. Single spaces and a dim `·`.
6. State colour for the bar versus dim secondary fields.
7. Not present.
8. `▰▱` 8-cell bar; mods elsewhere use Nerd Font file icons (`filetree/hooks/icons.ts`) and logo SVGs.
9. Wraps an arbitrary inner statusline command (`config.inner`) and prints the bar after it. `cache-clock/hooks/register.tsx` uses host tokens `error`, `suggestion`, `warning`.
10. `plugins/cache-bar/config.json` (`inner`, `handoffMinutes`, `floorTokens`), a `/mods` on/off switchboard.

## k8adev/tmux-vitals
https://github.com/k8adev/tmux-vitals — stars 0
Not a Claude Code statusline: a tmux status-bar plugin (CPU, memory, network, battery) that also shows Claude and Codex rate limits from a cache file written by a Claude Code hook (`scripts/rate-limit-hook.sh`).
1. By threshold plus fixed. `scripts/vitals.sh`: `level_color()` (helpers.sh:54) gives ok `#89CA78`, warn `#e5c07b` (>=60), crit `#EF596F` (>=85) for every gauge; fixed Claude brand `#D97757` and Codex `#4FA0F0` for their icons/labels; foreground `#9da5b4`, dim `#5C6370`.
2. Themes: not present; every colour is a tmux option (`@vitals_color_ok|warn|crit|fg|dim|claude|codex`).
3. Hex via tmux `#[fg=...]` (tmux handles depth). NO_COLOR n/a.
4. Foreground only.
5. Configurable `@vitals_separator` (default two spaces) and `@vitals_llm_separator` (` | `) in dim.
6. By icon and by threshold colour; separators.
7. n/a.
8. Nerd Font (Material Design icons for cpu, mem, net, battery, reset) and braille sparklines `⣀…⣿`; icons are options.
9. Sparkline history files, bar `━╌`.
10. tmux options for everything (warn, crit, widths, icons, colours).

## Kaidorespy/claude-starship
https://github.com/Kaidorespy/claude-starship — stars 0
not a Claude statusline: a local FastAPI + vanilla-JS "starship" chat app with an AI crew (themes `night-owl`, `synthwave` in `frontend/css/themes.css` are web CSS).

## kaisudo0520/cc-dashboard
https://github.com/kaisudo0520/cc-dashboard — stars 0
Not a command statusline: a Claude Code mod that draws a mission-control pane beside the transcript or above the prompt (built on Flightdeck).
1. By state/threshold, via a role map. `hooks/core.ts` `PALETTES` (:203): `theme` palette maps roles to host tokens: main `claude`, agent `suggestion`, gate `success`, cleared `permission`, arch `merged`, codex `ide`, branch `promptBorder`, ok `success`, amber `warning`, warn `error`, dim `inactive`, faint `subtle`, text `text`. Context bar: green under 50%, yellow from 50%, red from 80% (README). Permission-gate cells: green allowed by rule, blue decided by classifier, amber pending, red denied. Flow line orange.
2. Two palettes (`palette` option): `theme` (uses the host's own token names, so it follows light, dark and colour-blind themes) and `pastel` (fixed hex `#7dd3fc`, `#93c5fd`, `#86efac`, `#5eead4`, `#c4b5fd`, `#fcd34d`, `#fca5a5`, ... tuned for dark terminals). Format: 13 semantic role keys.
3. Host tokens or hex; the host handles depth. NO_COLOR: not present.
4. Foreground only plus box borders.
5. Box frames; no powerline.
6. By panel role colour and dim/faint tracks.
7. The `theme` palette is the adaptation (inherits the user's host theme, including colour-blind variants).
8. Unicode glyphs (`━─ █░ ⟲ ⏱ 🔀 ↔ ↑ ↓ ✓ ↻`).
9. Animated orange "flow line" packets while the main loop works (`motion: off` stills it); SVG chart output.
10. Mod options in the settings (`palette`, `panels`, `motion`, layout).

## kam-hak/pacman-statusline
https://github.com/kam-hak/pacman-statusline — stars 0
1. By state plus hash. `statusline-command.sh`: pacing "tiers" (`tier_of`, `tier_color`) map a pacing score (usage versus elapsed window time, asymmetric) to five colours: purple 99 (way under, "YOLO"), green 32, white 37 (on track), yellow 33 (outpacing), red 31; used for the pac-man gauges of 5h and 7d (5h inherits 7d if worse). Repo name coloured by stable hash: `cksum` mod 16 of `_REPO_COLORS=(196 202 214 226 154 46 48 51 45 39 33 99 129 163 198 205)` (`_repo_color_hash`, :151-189) so the same repo is always the same colour. Branch yellow for main/master, cyan for others. Model tier colour: opus 214 orange (196 red when 7d pacing is bad), sonnet 75, haiku 71, other 245. A business-hours frown glyph is 172 orange or dim.
2. Themes: not present.
3. 256-colour (`38;5;N`) and named ANSI 16; no depth detection; no NO_COLOR.
4. Foreground only.
5. Dim `│` bars and a dot `·` as pac-man dots.
6. The gauge itself (pac-man eating dots) carries state; neighbours differ by hash colour and tier colour.
7. Not present (white 37 for on track).
8. Heavily glyph-based: Nerd Font Material pac-man `󰮯`, ghost `󰊠`, a left-facing pac-man patched into the user's font by `scripts/patch-font.py` (install.sh picks a free PUA slot); `scripts/render-mockup.py`.
9. Pacing-based "pac-man" gauge cell dispatch; quality-budget context meter.
10. Optional `~/.config/pacman-statusline/config` (`PAC_L_CODEPOINT`); otherwise edit the script.

## Kangaroo4789/claude-code-statusline
https://github.com/Kangaroo4789/claude-code-statusline — stars 0
1. By threshold on remaining %. `statusline-command.sh`:89 `_rl_color`: remaining >75 green, >50 yellow, >25 orange, else red (rate limits and extra-usage); the bar `_bar()` colours its cells by position (first quarter green, then yellow, orange, red) so a fuller bar is redder; context turns red above 80% used else white. Fixed: model MD (`246;184;90` dark), plan badge dim, EXTRA badge red.
2. Two palettes chosen by Claude Code's own theme: `statusline-parse.py`:34 reads `theme` from `~/.claude.json` (fallback `settings.json`) and `*light*` selects the light set: WH `40,40,40`, GR `20,120,20`, YL `160,100,0`, OG `180,80,0`, RD `160,20,10`, MD `140,80,10`, DM `110,110,110`; dark: WH bright white, GR `80,200,81`, YL `255,235,59`, OG `255,152,0`, RD `244,67,54`, MD `246,184,90`, DM 90. Role-named variables (WH, GR, YL, OG, RD, MD, DM). User-defined palette: not present.
3. Truecolor `38;2` plus ANSI 97/90; no depth detection; no NO_COLOR.
4. Foreground only.
5. Plain ` │ ` in dim (`SEP`).
6. Separators plus dim labels (`CTX`) versus coloured values.
7. Yes: reads Claude Code's theme setting (light vs dark) and swaps to darker saturated-for-white-background colours.
8. `█░` bars, optional emoji (`EMOJI_STR`); no Nerd Font.
9. Derives an "EXTRA" plan badge when extra-usage credit is burning (statusline-parse.py); `extra-usage-refresh.sh`.
10. Shell variables at the top of the script (formats `RATE_5H_FORMAT`, bar widths, `SHOW_*` toggles); comments are in Chinese.

## Kanyandula/claude-statusline
https://github.com/Kanyandula/claude-statusline — stars 0
1. By severity role. `statusline.js`: `severity(value, warn, danger)`; defaults `DEFAULT_THRESHOLDS` context warn 60 / danger 85, cost warn $5 / danger $20; severity maps to green/yellow/red (named ANSI in the `minimal` theme: `SEV_COLOR`, hex `#3fb950`/`#d29922`/`#f85149` in `vivid`). A health "pixel" takes the worst of the signals. Roles painted by theme: pixel, project, branch, model, size, duration, burn, ctx, cost, loc.
2. Themes bundled: 2 in `THEMES` (:441): `minimal` (terminal ANSI palette, only threshold roles coloured) and `vivid` (design-mock truecolor: project pink `#ff7bd5` bold, branch/duration/burn gray `#6e7681`, model/size blue `#58a6ff`, loc split green/gray/red, pixel purple `#bc8cff` until danger then red). A theme is a function `paint(role, text, sev, w)`; users cannot add one in config (only choose `theme`). Four layouts: spatial, compact, zen, powerline.
3. Named ANSI (31-33, 1, 2), hex truecolor, and 256 downsample (`rgbTo256` using the 6x6x6 cube and gray ramp; `colorDepth: auto|truecolor|256`; auto uses 256 only on `TERM_PROGRAM=Apple_Terminal`). `supportsColor()`: `NO_COLOR` off, `FORCE_COLOR` on, else TTY; the installed command adds `--color`.
4. Both: powerline layout draws background-filled segments; other layouts foreground only.
5. Powerline arrow `` (`PL_SEP`, opt-in, needs Nerd Font): fg = this segment bg, bg = next segment bg; the last arrow has no bg. Other layouts use plain separators.
6. In powerline by distinct fixed backgrounds: project purple `#bc8cff` (dark text `#1a1030`), branch `#30363d`, model blue `#1f6feb`, context/cost red/amber/green by severity (`#da3633`/`#9e6a03`/`#238636`), loc green. Elsewhere by role colour.
7. Not present (fixed hex).
8. `▰▱` context bar (10 cells), `⎇` branch, `●` pixel; powerline glyph opt-in; stripping ANSI yields the same structure (golden-test invariant). Control-character sanitising of every external string.
9. Health pixel, `stripControlChars` hardening.
10. `statusline.json` with `config set/get/list` CLI (`cli.js`), `CLAUDE_STATUSLINE_CONFIG`, thresholds, fields, layout, theme, colorDepth.

## katalalab/usage-pulse
https://github.com/katalalab/usage-pulse — stars 0
Not primarily a Claude Code statusline: a Python tmux status-right / system-tray / notification tool built on `ccusage` (not a fork per the GitHub API). Its tmux output (`src/usage_pulse/providers/ccusage.py:161 format_tmux`) colours today's cost by share of a threshold.
1. By threshold: cost >= threshold red bold, >= 70% yellow, >= 30% cyan, else green (tmux `#[fg=red,bold]` etc.); tokens and model list uncoloured.
2. Themes: not present.
3. tmux named colours; tmux handles depth. NO_COLOR n/a.
4. Foreground only.
5. Plain spaces.
6. n/a.
7. n/a.
8. Brackets `[model+model]`; the tray icon is a coloured dot.
9. System tray dot icon, notifications.
10. Python CLI flags and a Claude Code hook; no style config.

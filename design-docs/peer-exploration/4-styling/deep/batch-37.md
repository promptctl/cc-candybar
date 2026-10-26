## harness-status-line
https://github.com/barnuri/harness-status-line (stars 0). Bun/TS, multi-harness (Claude Code, Cursor, Copilot, Codex, opencode).
1. Fixed per segment, plus thresholds on three kinds. `src/configManager.ts` `DEFAULT_CONFIG.colors` is a per-segment bg/fg map (folder slate [30,41,59], git [47,58,97], model [51,65,85], slug purple, effort indigo, worktree orange, autorun pink, yolo red, lines grey). Threshold segments have three entries each: ctx (`ctxHealthy` green / `ctxWarning` amber / `ctxCritical` red, chosen by `ctxColor` in `src/statusParser.ts:248`: >80 critical, >60 warning), rate/credit/quota (`rateHealthy` cyan-teal, >50 warning, >80 critical, `statusParser.ts:~474,644`), and auth (`authSubscription` dark green vs `authApi` dark purple, by account type).
2. No bundled themes. `colors.<segment>.<bg|fg>` is a per-segment colour map; the user overrides any via `config set colors.folder.bg 30,41,59` (`src/configCli.ts`). Config deep-merges over defaults.
3. Truecolor only (`38;2;r;g;b` / `48;2;`, `statusRenderer.ts:ansi38/ansi48`). No depth detection, no downsample. NO_COLOR: not present.
4. Background-filled cells, always, with bold fg text, padded with one space each side (`formatSegmentSpaces`).
5. Two modes via `separatorStyle`: `spaces` (default; no separator at all, cells butt together, `SEPARATOR=''`) and `powerline` (`renderPowerlineLine`: fg = previous bg, bg = next bg, glyph `❯` rather than the PUA arrow, closing arrow fg = last bg on reset bg).
6. Different fixed hues per segment (dark Tailwind-ish 700-900 shades); no alternation logic. Adjacent cells differ because the palette gives each its own hue.
7. Text colour is a fixed near-white `[248,250,252]`, except the amber warning cells use dark `[15,23,42]` (`DEFAULT_CONFIG`). No terminal-background detection.
8. Emoji icons per segment (📁 🤖 🌿 🏷 ⎇ 👤 🧠 ⏳ 🔑 ✨ 🌐); no Nerd Font; no ASCII mode.
9. Wraps to extra lines instead of truncating (`groupIntoLines`). `docs/` has an animated GIF and screenshots of healthy/warning/critical states. Also ships a subagent statusline and an opencode TUI renderer.
10. `~/.config/harness-status-line/config.json`; CLI `config show|set|reset`; `--setup` wizard (`src/setupWizard.ts`); per-segment visibility booleans; `refreshInterval`.

## claude-code-statusline (bath)
https://github.com/bath/claude-code-statusline (stars 0). Sixteen POSIX-shell variants sharing `_common.sh`.
1. By state/threshold plus fixed roles, all foreground. Roles in `_common.sh`: user/place CYAN, model TEXT, dir BLUE, branch PURPLE, labels DIM, separators FAINT. Meters get GREEN/AMBER/RED: usage windows by percent (`WIN_WARN_PCT=50`, `WIN_CRIT_PCT=75`, `hue()`), context by absolute tokens (`CTX_WARN_TOKENS=100000`, `CTX_CRIT_TOKENS=200000`, `hue_tokens()`, because price steps at 200k). Bars `█`/`░`.
2. Three palettes keyed on terminal brightness, not themes to choose among: `light`, `dark`, `universal` (`_common.sh` theme block). No user-defined palette; edit the file. `CC_STATUSLINE_THEME=light|dark|universal` forces one.
3. Truecolor only (`38;2;`). No depth detection. NO_COLOR: not present, but `14-mono.sh` is an ASCII/no-colour variant for ssh.
4. Foreground-only in most variants; `06-pills.sh` uses bg-filled pills (`pill()` writes `48;2` + `38;2`); `TRACK_BG` bar track fill in light/dark only.
5. Pills have no separator glyph (space-padded blocks). Other variants use `│` in FAINT and plain spaces. No powerline.
6. Neighbours distinguished by hue per role (cyan/text/blue/purple) or, in pills, by `PILL_USER/MODEL/DIR/BR` fixed pairs of dark-tinted bg + matching lighter fg. Meter pills take `PILL_OK/WARN/HOT` bg by the same thresholds.
7. The most developed in this batch. Theme resolved from `~/.claude/settings.json` `theme`, then `COLORFGBG` (bg slot 0-6,8 = dark; 7,9-15 = light), then macOS `AppleInterfaceStyle`, else `universal`. `universal` is a documented design: every colour at luminance 0.185 (3.9:1 against both Catppuccin Latte `#eff1f5` and Mocha `#1e1e2e`); `TEXT=ESC[39m` (terminal default fg) and `FAINT` uses SGR 2 because 4.5:1 on both is impossible. Pill text colours are paired per pill.
8. Glyph `█░▁▂▃▄▅▆▇█●○` bars/gauges; `│`, `·`. No Nerd Font; no emoji.
9. README "How the colours are graded" and "The universal palette" sections explain the contrast maths. `15-alert.sh` is silent until a threshold trips. `09-countdown`, `11-cache` variants.
10. Pick a variant by `use.sh <n> [refresh-seconds]` which writes `.statusLine`; env `CC_STATUSLINE_THEME`; thresholds are shell variables at the top of `_common.sh`. No config file.

## cc-side-context
https://github.com/bcanozgur/cc-side-context (stars 0).
not a Claude statusline: a Claude Code mod that draws a live side pane (context-eater breakdown, cache-cold timer, compact/handoff keys). Styling note: `hooks/pane.tsx:31-33,133,187-192` colours by Claude Code's own theme role names, not hex: setup=`suggestion`, conversation=`claude`, turn=`text`, status Healthy/Filling/Near compact = `success`/`warning`/`error`, card borders `subtle`. The browser variant `hooks/pane-web.tsx:36-49` has fixed hex per context category (Conversation `#3fa877`, Built-in tools `#4f86e8`, MCP tools `#e2703f`, System prompt `#d9a521`, Skills `#9a72d8`, ...), a per-category fixed-colour map.

## powerline-claude
https://github.com/bcmyguest/powerline-claude (stars 0). Rust binary.
1. A theme role mapped to segments, with a threshold override. `src/segments.rs:90-150` `MODULES` table maps module to (fg Family, bg Family): logo=Claude, dir=Directory, git=Git, model=Model, context=Context, cost/usage=Cost, stats = fg Cost on bg Context, effort=Model. Context swaps family by tokens (`context_family`, `segments.rs:312`: >=80k `ContextWarn` orange bg, >=125k `ContextAlert` red bg; consts at `:47-48`). The usage/budget segment also swaps to warn/alert families.
2. Eight semantic families (`src/theme.rs` `Family`): claude, directory, git, model, context, context_warn, context_alert, cost, each an fg/bg hex pair. Six bundled palettes (`PALETTES`): catppuccin-mocha (default), catppuccin-frappe (its values are actually Latte-light, `#eff1f5` backgrounds), dracula, gruvbox-dark, nord, tokyonight. Custom: a directory with `theme.yaml` holding any subset of the families (missing ones fall back to mocha), loaded by `--theme <path>` or `~/.config/powerline-claude/themes/<name>` (`Theme::resolve`). Example `docs/themes/synthwave/theme.yaml`.
3. Truecolor only (`render.rs:fg/bg` emit `38;2`/`48;2`); hex `#rrggbb` input. No depth detection; NO_COLOR: not present (no hit in `cli.rs`).
4. Background-filled cells with fg text (`render()` writes `bg+fg` then ` text `).
5. Powerline via `--mode`: `patched` (Nerd Font `` hard, `` thin, leading/trailing `░▒▓` fade), `compatible` (`▶ ❯`, same fade), `flat` (no separators). Separator rule (`render.rs`): if previous bg == this bg draw the thin glyph in this fg on this bg; else hard glyph with fg = previous bg, bg = this bg. Right-aligned mirror `render_right`.
6. By theme design: palettes alternate two backgrounds. In catppuccin-mocha, claude `#313244`, directory `#1e1e2e`, git `#313244`, model `#1e1e2e`, context `#313244`, so neighbours alternate two shades; text fg carries the hue. When equal-bg neighbours occur the renderer uses the thin separator instead of the hard arrow, so adjacency is handled in the separator.
7. Warn/alert families invert to dark-text-on-bright-bg (e.g. mocha `0x11111b` on `0xfab387`/`0xf38ba8`). No light/dark detection.
8. Nerd Font glyphs (`LOGO \u{f4f5}`, branch `\u{e0a0}`, per-model Haiku/Sonnet/Opus icons) with `compatible` fallbacks (`✳`, `⎇`); emoji not used.
9. Segments dropped by `priority` and `NARROW_COLUMNS=80`. `docs/custom-theme.png` screenshot.
10. CLI flags in `src/cli.rs`: `--modules`, `--theme`, `--mode`, plus others; theme dirs in `~/.config/powerline-claude/themes`. No config file.

## claude-toolbelt
https://github.com/bdnowicki/claude-toolbelt (stars 0). Plugin `plugins/statusline/scripts/statusline.cjs`.
1. Mostly one colour with threshold bars. Model, task and dir use the dim attribute (`\x1b[2m`, line 223-225); the effort suffix is cyan (`\x1b[36m`, 124). Bars: context (`:138-141`) green <63%, yellow <81%, orange (256-colour 208) <95%, then blinking red `\x1b[5;31m` with 💀; 5h/7d usage (`:104-107,166-169`) green <50, yellow <75, orange <90, red.
2. Themes: not present.
3. ANSI 16 plus 256 index 208 for orange. No depth detection; NO_COLOR: not present.
4. Foreground-only.
5. Plain ` │ ` separators.
6. Separators and dim vs bold (`\x1b[1m` on the task name); no hue difference between neighbours.
7. Not present.
8. Block bar glyphs, `↻` reset marker, one 💀 emoji.
9. The blinking red + skull at >=95% context is the notable touch (`:141`).
10. Plugin only; no config seen (unverified beyond the script).

## claude-stream-statusline
https://github.com/beansiayo/claude-stream-statusline (stars 0). Node, zero dependencies.
1. Fixed per segment plus thresholds. `src/statusline.cjs:33-60` `PALETTES.{light,dark}` give each role a 256-colour index: model, effort, dir, branch, sep, label, value, good/warn/bad, compact, speed, faint. Model `✻` uses `model`, effort `effort`, dir `dir`, branch `branch` (`:307-311`). `usageColor` (`:152`): >=75 bad, >=50 warn, else good. `cacheColor` inverted (>=90 good, >=60 warn). Speed >=50 tok/s good else warn (`FAST_TPS`).
2. Two palettes, light and dark, chosen automatically. User edits `THEME` numbers in the file ("change the numbers to re-tune", header line 15). No named themes.
3. 256-colour index only (`ESC + '0;38;5;N' + 'm'`). The `0;` prefix is deliberate because Claude Code dims statusline output and a bare `38;5;N` inherits it (comment at `:27`). NO_COLOR: not present.
4. Foreground-only.
5. ` │ ` between groups and ` · ` within the head group, in `sep` grey.
6. Hue per role; separators.
7. Scheme detection order (`:85-101`): `STATUSLINE_SCHEME=light|dark`, `COLORFGBG`, macOS `AppleInterfaceStyle` (`defaults read`), else light. Light palette uses dark saturated codes (e.g. dir 24, good 34); dark uses bright (dir 110, good 113).
8. `✻`, `⎇`, `█`/`─` bar; no Nerd Font.
9. Narrowing drops details progressively (`:339-382`). Optional `stream-speed` plugin measures tok/s.
10. Env `STATUSLINE_SCHEME`; installer `scripts/install.cjs`; no config file.

## claude-code-rpg-status
https://github.com/BeMySlaveDarlin/claude-code-rpg-status (stars 0). Bash.
1. Mix. `rpg/theme.json` has `fg` roles (text, label, value, order, dim, chaos, added, removed, hp, mp, warn, exp, empty) and `bg` roles for seven segments (name, level, location, branch, model, effort, duration). Segments with bg: name `76,86,106`, level/branch/effort/duration `91,91,91`, location/model `74,104,104` (so grey/teal alternation by fixed assignment). Meters (`statusline-command.sh:172-182` `bar_color`): context as STA (low is good: >=50 warn yellow, >=75 red `removed`), 5h as MP and 7d as HP (high is good: <50 yellow, <25 red; healthy colour mp blue / hp green).
2. One theme file `theme.json`, a flat per-role "R,G,B" map. Built-in fallbacks in the script (`:32-49`). Users edit it freely; `_comment` says so. No named theme set.
3. Truecolor only (`_fg`/`_bg` write `38;2`/`48;2`); NO_COLOR: not present.
4. Both: bg-filled `seg()` cells for name/level/location/branch/model/effort/duration; bar rows are foreground only.
5. A hair space U+200A (`SEP=$'\xe2\x80\x8a'`, line 18) as the gap between bg cells; a `─` rule line in the separator colour. No arrows.
6. Alternating greys/teal by fixed assignment per segment plus the gap; white text throughout.
7. Not present.
8. Emoji (📍 ⚔️), `▰▱` tile bars, stars `☆★`.
9. RPG theming (class, level, XP bar, faction colours order/chaos).
10. `rpg/theme.json`, `rpg/config.json`; `RPG_DIR` env.

## ben-mods
https://github.com/bencsmartucph/ben-mods (stars 0).
not a Claude statusline: a marketplace of Claude Code mods (`readable`, `backlog`, `outside`, `dictation`, `cache-dot`, `session-notify`). The only status-like piece is `cache-dot/hooks/register.ts`: a prompt-footer indicator `◕ 47m` coloured with Claude Code theme-role names, `STYLE` at `:21` = warm dim, warn `warning`, cold `error`; context % beside it is `cyan` below 60, `warning` from 60, `error` from 85 (`CTX_WARN=60`, `CTX_CRIT=85`, `:43-46`). Warn at <=2 min (5m TTL) or <=10 min (1h TTL).

## ccline (beneathatree)
https://github.com/beneathatree/ccline (stars 0). `context-statusline.sh`.
1. Mixed. Model CYAN `100;200;255`; the context field is coloured by used percent: <50 GREEN `0;200;0`, <75 YELLOW `255;200;0`, <90 ORANGE `255;130;0`, else RED `255;50;50`; cost uncoloured; cwd dim (`\033[2m`).
2. Themes: not present.
3. Truecolor fg only (`38;2`). No depth detection or NO_COLOR.
4. Foreground-only.
5. Plain ` | `.
6. Hue per field; separators.
7. Not present.
8. The unusual part: a "redaction" meter that censors the label as context fills (`redaction_viz`: `CONTEXT WINDOW (x%)` to `CONTEXT ██████` to `██████████████`), no emoji.
9. As above.
10. Edit the script.

## pituto
https://github.com/betoescobar46/pituto (stars 0).
not a Claude statusline: a suite of five Claude Code mods. The relevant styling is the `session-bar` mod, which moves model, context and the 5h limit next to the prompt and gives each folder its own colour. `plugins/session-bar/hooks/color.ts`: `PALETA` of 8 session colours (red, green, blue, yellow, purple, orange, pink, cyan), each with an `ink` and a dark `tinte` (e.g. red `#3a2b30`) plus a light-terminal variant `claro` (e.g. `#f7e4e7`, and a darker `ink` for orange/pink). Colour is assigned per project folder by a stable string hash of the cwd (`colorPorCarpeta`), excluding colours pinned by the user via the `folderColors` option ("api=cyan, shop=purple"). Clicking cycles the palette. `medidor.ts:11-18` thresholds: context <50 greenBright, <75 yellowBright, <90 `#ff8c3a`, else redBright; 5h limit >=50/70/90. Model shortened to `O5.5`, `S4.6` etc.

## status-line (bfd-kr)
https://github.com/bfd-kr/status-line (stars 0). Shell; shows a KrAIG API budget, not session data.
1. One colour for the whole line, picked by budget percent (`get_status_indicators`, `status-line:470-497`): <75 GREEN `\033[32m`, <90 YELLOW, else RED, with matching emoji 🟢🟡🔴 and cat emoji.
2. Themes: not present.
3. ANSI 16. `-c/--no-color` flag (`:12,193`); NO_COLOR env: not present.
4. Foreground-only.
5. Plain text `|`.
6. Not applicable (single colour).
7. Not present.
8. Emoji; `[█░]` bar.
9. Formats: minimal, money, bar, full, emoji, json (`-f`).
10. CLI flags `-f`, `-k`, `-c`.

## tidepool
https://github.com/BhumilModi/tidepool (stars 0). Claude Code plugin (mod) plus a Node statusline.
1. By semantic palette role with fixed seg assignment. `statusline/render.mjs`: model on `C.accent` bg (bold, text `C.onAccent`), effort `C.seg`, folder `C.segAlt`, git `C.seg`, PR `C.segAlt`, ctx `C.seg`, cache `C.segAlt`; line 2 limits alternate `i % 2 ? segAlt : seg`. Foreground within a cell by state: `level(C,pct)` = crit >=80, warn >=50, else ink (ctx bar and limits); PR state colour `{OPEN: info, DRAFT: mid, MERGED: accent, CLOSED: crit}`; cache warm `mid`, <5 min `warn`, cold `crit`; git dirty `warn`, ahead/behind `info`.
2. Five palettes in `hooks/palettes.mjs`: claude, nord, dracula, warm (default), mono. Each has 12 roles (`accent onAccent seg segAlt ink soft mid faint track warn crit info`). Users pick via `/config` option; no custom palette format. A big plus: each palette has a matching generated terminal theme (`themes/*.json`, `scripts/build-themes.mjs` emitting alacritty, ghostty, iterm2, kitty, vscode, warp, wezterm, windows-terminal, terminal.app) whose background equals `onAccent`.
3. Truecolor (`38;2`/`48;2`, `render.mjs:fg/bg`). No downsample. NO_COLOR: not present.
4. Background-filled segments in `draw()`, fg per part.
5. Powerline (PUA `` hard separator, start/end caps `START_CAP`/`END_CAP`); toggle `options.powerline` off gives flat blocks. Arrow rule: `bg(next.bg) + fg(seg.bg)` between, closing arrow fg = last bg.
6. Alternating two shades (`seg` `#2A2D35` / `segAlt` `#3A3E46` in claude), the model cell the accent.
7. `onAccent` is by design the terminal theme's background, so text on the accent cell matches the terminal ground. No detection; palettes are dark-terminal only (`palettes.mjs` header).
8. Nerd Font powerline glyphs toggle ("Powerline glyphs" off in `/config`); the bundled Maple Mono NF font is installed; bar uses `━╸─`.
9. Wider plugin restyles transcript, tool rows, spinner in the same theme; `keep` priorities drop segments on narrow terminals.
10. `/config` plugin options (theme, powerline), `/tidepool-statusline` prints the settings block.

## claude-statusline (bigbenjoman)
https://github.com/bigbenjoman/claude-statusline (stars 0). One `install-statusline.sh` that writes the real script.
1. Fixed per role plus thresholds, all foreground 256-colour (`:64-76`): model 183 lavender, effort 139, dir/repo 110 sky, parent repo+branch 103, session 252, values bright white 97, muted 245; bar fill neutral 248 / warn 221 / crit 210 (`bar` at `:146-149`); percentage text 73 teal below the warn threshold (`pct_color`, `:164`). Thresholds: rate limits >=60 / >=85, context >=75 / >=90 (README).
2. Themes: not present (constants at top).
3. 256-colour index; NO_COLOR: not present. Contrast ratios are listed in comments per colour (e.g. `# (8.8:1)`).
4. Foreground-only.
5. Separator grammar: `│` (244) between groups, `·` (245) within a group, sigil `⎇` for the branch.
6. Separators and hue by role.
7. Non-colour severity is deliberate: amber vs coral differ by 1.67:1 luminance, so critical also switches the bar glyph `█` to `▓` (`:147`). Colours chosen with WCAG ratios in comments; no background detection.
8. `⎇`, block bars; no Nerd Font.
9. Worktree display dims the parent repo and brightens the worktree.
10. Edit script constants (`WARN_AT`, `CRIT_AT`, `CTX_WARN_AT`, `CTX_CRIT_AT`).

## ccstatuskit
https://github.com/bigdra50/ccstatuskit (stars 0). Rust, starship-flavoured.
1. Per-module defaults in code, overridable by style string. `src/theme.rs` Monokai constants GREEN, YELLOW, BLUE, MAGENTA, CYAN, ORANGE, RED, WHITE, GRAY. Examples: model by family (`modules/model.rs:9-16`: sonnet BLUE, opus MAGENTA, haiku GREEN, else WHITE); directory GREEN; git by state (GREEN/YELLOW/RED at `git.rs:136-140`); ctx >=40 YELLOW, >=60 RED (`ctx.rs:9-14`); cost >=$1 YELLOW, >=$5 RED (`cost.rs:12-17`); memory >60% / >80%; PR coloured by review state.
2. One built-in palette (Monokai). User `[palette]` table in TOML defines named colours usable in any style string (`style.rs:parse_color` resolves one level).
3. Style grammar (`src/style.rs`): `bold dimmed italic underline inverted fg:<c> bg:<c>` where c is `#rrggbb`, a 0-255 index, or the 16 named ANSI colours incl. `bright-*`. Output via `anstyle`. NO_COLOR honoured (`main.rs:69`, docs). No downsampling.
4. Foreground by default; `bg:` possible through style strings.
5. Plain spaces between modules; layout via `format = "$model $directory $git\n..."`. No powerline.
6. Hue per module; user can restyle.
7. Not present.
8. Emoji and a Nerd Font icon per module (`glyph.nerd_font` hit); per-language modules with icons.
9. `ccstatuskit doctor` reports invalid styles/palette entries. Custom modules via `[custom.x]` with `style`.
10. `$XDG_CONFIG_HOME/ccstatuskit/config.toml` (`CCSTATUSKIT_CONFIG`), per-module `style`/`disabled`, `format` template (docs/configuration.md).

## GLM StatusLine (CCStatusline)
https://github.com/BingqiangZhou/CCStatusline (stars 0).
1. No colour for any segment: `glm-statusline.js` and `lib/statusline-format.js` contain no escape codes (grep for `x1b|033|color|ansi` found only unrelated comments; the format file at `:76` notes the `░▒▓█` gradient bar).
2. Themes: not present (the "08-Themes.md" hit is a plugin-system note, not a colour theme).
3. No colour output; NO_COLOR: not applicable.
4. Neither (plain text).
5. ` │ ` plain.
6. Separators only.
7. Not present.
8. `░▒▓█` four-level bar giving 24 steps of resolution; no emoji.
9. Interactive field picker; single-line vs grouped layout; wraps to terminal width. README only for these.
10. Interactive field selection stored in plugin config; installer `bin/glm-statusline-install.js`.

## claude-statusline-astro
https://github.com/black-astro/claude-statusline-astro (stars 0). Shell + PowerShell, with a mascot.
1. Fixed per segment plus thresholds (`scripts/statusline.sh:127-170`): dir bright white `97`, main/master branch magenta `95`, other branches sky `96`, model yellow `93`; effort ramps low to max: `37` grey, `92` green, `96` sky, `95` magenta, `1;93` bold yellow; meters `C_OK 46` / `C_WARN 214` / `C_CRIT 203` at `WARN_AT=60`, `CRIT_AT=90`. Mascot colour by gacha rarity tier: common 253, uncommon 120, rare 117, unique 141, legend bold orange 208, dev bold cyan 51.
2. No theme set. Legend tiers have five hard-coded gradient ramps, each as 36 truecolor stops with a 256-colour twin (`LEGEND_RAMP_TRUE_1..5`, `LEGEND_RAMP_256_*`, `:521-542`).
3. ANSI 16 (bright variants) for text, 256 for meters, truecolor for legend ramps. `STATUSLINE_TRUE_COLOR=0` forces 256 ramps. NO_COLOR honoured (`:127`: empties every colour variable).
4. Foreground-only.
5. Plain spaces / dim grey `90` separators.
6. Hue per role.
7. Not present.
8. Emoji and kaomoji mascots (~100 emoji hits); no Nerd Font.
9. Animated per-character gradients and "sparkle" twinkle for legend mascots (rainbow, aurora, fire), chosen by the clock each redraw. Notable but decorative.
10. Env vars (`STATUSLINE_TRUE_COLOR`, `STATUSLINE_CACHE_DIR`, NO_COLOR); `/statusline-*` slash commands via plugin; no config file for colours.

## Bobbycodachi (fork of vincent-k2026/codachi)
https://github.com/BobbyFongAU/Bobbycodachi (stars 0). Differences from the parent only.
1. Same segment mapping as parent (context >=85 red, >=70 amber, else green; usage >=90 red, >=75 purple, else blue; git `~ + - ?` fixed colours), but those fixed-colour functions are routed through a new `uiRgb` that multiplies each channel by `UI_DIM` (`src/render/colors.ts`), default 0.6, set by env `CODACHI_UI_DIM` (0..1). Parent calls `rgb()` directly at full brightness (`src/render/index.ts:171-189`).
2. Parent's palette set (10 built-in pet palettes, plugin-added ones) is unchanged in `src/config.ts`; no new themes seen.
3. Same four-tier detection and NO_COLOR. Fork-only change: at level `none`, `RESET` and `DIM` become empty strings, so output holds no ANSI bytes at all (parent exports them unconditionally).
4. Foreground-only, as parent.
5-6. Not different.
7. The 0.6 dim of UI text (not pet art in the comment, but `render/index.ts:151-152` also wraps pet body/accent/face/blush with `dimAnsi`) is a fork-specific legibility choice; no terminal detection.
8-10. Otherwise same as parent: `CODACHI_COLOR`, `FORCE_COLOR`, `npx codachi config` TUI.

## claude-usage (BoeyCorp)
https://github.com/BoeyCorp/claude-usage (stars 0).
not a Claude statusline: a Quickshell/QML widget for the Omarchy (Hyprland) top bar that shows Claude Code session activity and quota. Colour facts: model tier colours `scripts/claude_usage_scanner.py:536-542` Opus `#A855F7`, Haiku `#38BDF8`, others (Sonnet) `#D97757`; state dot green (working) / blue (waiting) / transparent (idle); the icon follows the Omarchy theme foreground colour.

## claude-config (bogos)
https://github.com/bogos/claude-config (stars 0). `statusline.sh`.
1. Threshold colour on the meters, fixed on a few fields. Context bar and 5h and 7d: green <50, yellow <75, red >=75 (`:75-85`). Git section: branch in parens MAGENTA, change counts YELLOW. Token arrows: `↑` GREEN, `↓` RED. Time/session/model right block DIM.
2. Themes: not present.
3. ANSI 16 (`\033[32m` etc.). NO_COLOR: not present.
4. Foreground-only.
5. Plain ` | `; the right block is pushed to the terminal edge with computed padding (widths via `stty` on `/dev/pts/*`).
6. Separators only.
7. Not present.
8. `▓░` bar, `↑↓` arrows.
9. Right-aligned right block.
10. Edit script.

## claude-statusline (boldave)
https://github.com/boldave/claude-statusline (stars 0). `statusline.sh`.
1. By role through a theme: each theme defines 8 role variables PINK(header), YELLOW(time/model), GREEN(directory/sync), CYAN(branch), ORANGE(cost/effort), RED(errors), PURPLE(vim), DIM(separators), plus a fixed BLUE for the path. Context bar and usage limits by percent: >=90 RED, >=70 ORANGE, >=50 YELLOW, else GREEN (`pct_color`).
2. Ten bundled themes in a `case` block: monokai (default), dracula, nord, gruvbox, solarized, catppuccin, tokyo-night, one-dark, rose-pine, cyberpunk, each citing the official palette URL. Format is the eight role variables as `\033[38;2;r;g;bm`; users edit the script to add one. Select via `~/.claude/statusline_theme` or env `CC_THEME`.
3. Truecolor only; NO_COLOR: not present.
4. Foreground-only.
5. `│` in DIM; six header templates (`rghtON`, `box`, `neon`, `cyberpunk`, `retro`, `minimal`) chosen via `~/.claude/statusline_template` / `CC_TEMPLATE`.
6. Hue per role.
7. Not present.
8. Emoji (📂 📊 ⏳), `` branch icon (one Nerd hit).
9. A per-letter rainbow and a 150 ms shimmer on the "rghtON" brand label, time-based.
10. Files `~/.claude/statusline_theme`, `statusline_template`; env `CC_THEME`, `CC_TEMPLATE`.

## pawline
https://github.com/Bonny07/pawline (stars 0). `statusline.sh`.
1. Fixed per field plus thresholds. Project CYAN `86,182,194`, model BLUE `0,153,255`, tokens WHITE labelled DIM, lines `+` GREEN / `-` RED. Effort fixed by level (`:80-89`): max RED, xhigh ORED `255,120,60`, high ORANGE, medium YELLOW, low GREEN. Context dots and 5h/7d: GREEN, ORANGE >=50, YELLOW >=70, RED >=90 (`:93-110`; note orange precedes yellow, so the ramp is not monotone in warmth).
2. Themes: not present.
3. Truecolor fg only. No NO_COLOR.
4. Foreground-only.
5. ` │ ` dim.
6. Hue per field; separators.
7. Not present.
8. `●○` 5-dot meter, trailing 🐾.
9. Windows PowerShell twin (`statusline.ps1`).
10. Edit script; installer scripts only.

## ClaudeCLI_statusbar
https://github.com/Bornitoo/ClaudeCLI_statusbar (stars 0).
1. Wraps the existing `ccstatusline` package. `color_wrapper.py` runs it, strips ANSI to read the "5H Limit" and "Weekly" percentages, then swaps ccstatusline's own 256-colour codes on those blocks: <50 green (`38;5;70`), <75 yellow (178), >=75 red (160) (`_threshold_color`). Other segments keep ccstatusline's colouring (set in the copied `settings.json`, not read here).
2. Themes: not present (ccstatusline's own).
3. ANSI 256 (`38;5;N`) assuming ccstatusline `colorLevel=2`. No NO_COLOR.
4-8. Inherited from ccstatusline; `unverified (settings.json not read)`.
9. Technique worth noting: recolouring a finished statusline by regex on the ANSI stream.
10. Installer copies config to `~/.config/ccstatusline/`, sets `refreshInterval: 10`.

## termtheme-release
https://github.com/brandon-meza/termtheme-release (stars 0).
1. By theme role, with a fixed assignment and one threshold. `statusline-command.sh` reads `~/.config/termtheme/current.env` (`TH_BLUE TH_DBLUE TH_GRAY TH_DIM TH_TEAL TH_GREEN TH_PEACH TH_RED TH_YELLOW`, truecolor R;G;B, Catppuccin Mocha fallbacks at `:16-17`). Mapping: model BLUE, effort GRAY, context bar fixed YELLOW (comment: "thin line, fixed yellow"), 5h dot meter GREEN <50 / PEACH >=50 / RED >=80, reset time TEAL, RAM and CPU PEACH, separators dim GRAY, week % dim GRAY; prompt line user BLUE, `@` DBLUE, path RED.
2. Seven bundled themes (`termtheme list`): everforest, gruvbox-material, kanagawa, mocha, nord, rose-pine, tokyonight. A `*.theme` file defines `R_BLUE R_DBLUE R_GRAY R_DIM R_TEAL R_GREEN R_PEACH R_RED R_YELLOW` plus terminal `BG FG PALETTE CURSOR` and tmux `T_*` colours; `termtheme new <name>` scaffolds one from `_template.theme`. User-definable.
3. Truecolor fg (`38;2`); no depth detection or NO_COLOR.
4. Foreground-only.
5. Plain ` | `, dim gray.
6. Separators and hue.
7. Not present as detection; the theme sets terminal background itself, so one command (`termtheme apply`) coordinates gnome-terminal, tmux, statusline and bash PS1 from the same role palette, which is the notable design.
8. `●○`, `━─` meters; kanji weekday for the weekly reset (月 火 ...).
9. `termtheme revert`.
10. CLI `termtheme list|apply|current|new|revert`; theme files in `~/.config/termtheme/themes/`.

## claude-kit
https://github.com/brian-rey-development/claude-kit (stars 0). Python CLI + jq statusline, macOS/iTerm2.
1. By theme role, with threshold overrides. `statusline/palette.jq` exposes roles brand, accent, accent_soft, ok, warn, danger, merged, bright, caption, detail, divider, track, icon. Mapping: location/repo name `bold brand`; branch `bold accent`; model name `bold bright` with effort in `detail`; cost `bright`; git counts: ahead/staged `accent_soft`, behind `danger`, modified `warn`, untracked `detail`, dirty dot `warn`, conflicts `bold danger`; PR colour by review state `{approved: accent, changes_requested: danger, merged: merged}` else `warn`. Meters: `severity(p, warn_at, critical_at)` = ok/warn/danger, context at 50/75 (`widgets/context.jq`), limits at 60/85, and a limit meter forced to `danger` when its projected pace would run out before the reset (`meters.jq runs_out_at`).
2. Themes are folders of data (`themes/moonlit/theme.json`, validated by `schema/theme.schema.json`): `palette` of 13 named roles, plus `terminal` (background, foreground, ansi[16], cursor, selection, link, tab). One bundled theme (moonlit). `kit new-theme <name> --image photo.png` derives a theme from an image by taking hues from it and pushing lightness until text is readable, and `kit check` fails palettes under WCAG AA (`contrast.shortfalls`). Users make their own.
3. Truecolor fg only (`rgb()` in `palette.jq`; `claude_kit/color.py:sgr`). Output drops colours when not going to a terminal (README). No downsample.
4. Foreground-only; the bar track is the `track` colour as a dim `━` run.
5. `│` in `divider` colour between columns of a three-column grid; no arrows.
6. By column grid alignment and hue per role.
7. Contrast is the central design point: palette roles are held to WCAG AA against `terminal.background` and generated from one palette for Claude Code colours, subagent panel and iTerm2 profile. `appearance` field is `dark` or light; no runtime detection.
8. Custom mascot glyph: builds a patched Monaco whose icon char draws the theme mascot (iTerm2), width via `icon.cells`; box/bar glyphs `━`.
9. Width ladder: each cell has 3-4 variants (long bar, short bar, number only) and the lowest-`keep` cell steps down until the grid fits (`grid.jq`). OSC 8 links for PRs.
10. `kit widgets`, `kit layout "location,context" "git,limit_5h" "model,clock"` (rows of up to 3 widgets), `kit themes|preview|apply|new-theme|doctor`; jq widgets in `widgets/*.jq`.

## claude-code-hud
https://github.com/BrucePelser/claude-code-hud (stars 0). Python, standard library.
1. Mostly uncoloured text with coloured bars and icons. `hud.py:39` `colors`: ok 71, warn 208, bad 196, dim 245, add 71, del 196 (256-colour indices). Bars (`level_color`, `:515`): ok <60, warn <85, else bad (`thresholds`). Segment text itself is the default terminal colour; the `dim` colour paints empty bar cells, reset countdowns. `+N`/`-N` lines use add/del. Brain-folder dot green `ok` vs red `bad`. With the `custom` icon set each icon has its own colour from `icon_colors` (model 141, time 80, cost 222, folder 110, branch 114, brain 179, context 114, cache_warm 208, cache_cold 75).
2. Themes: not present. The `colors`, `icon_colors`, `thresholds` dicts are user-overridable in `~/.claude/hud.config.json`.
3. 256-colour index (`\x1b[38;5;Nm`, `paint()`). NO_COLOR honoured (`make_config`: `cfg["color"] = not os.environ.get("NO_COLOR")`). No truecolor.
4. Foreground-only.
5. Plain spaces between items; three rows (you / limits / place).
6. Icons (each its own colour in `custom` set) and whitespace.
7. Not present.
8. Three icon sets via `icons`: `custom` (a shipped 14-glyph icon font at private-use code points, SVG sources, built by `icons/design.py`), `emoji` (default), `plain` (text labels).
9. Row layouts `rows` / `compact`; priority-order truncation. `assets/preview.svg` previews.
10. `~/.claude/hud.config.json` (example `hud.config.example.json`): layout, per-row item lists, icons, colours, thresholds, `bar_width`; installer `install.py --font`.

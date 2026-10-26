## fbincon/claude-code-statusline
https://github.com/fbincon/claude-code-statusline (2 stars). TypeScript core `packages/core/src/rendering/`; the old Python version is in `archive/python/`.
1. Colour comes from a theme role, and each item belongs to a role. `appearance.ts` `itemRole()` maps item group to role: model->model, location->directory, repo->branch, context+limits->percentage, usage+cache+requests->tokens, anything else->timer. Dark role colours (`DARK` array): model #f6e2b7, directory #abdfa7, branch #c8a9ee, percentage #f2b590, tokens #e990a9, timer #8ed3d3. All bold foreground. A `riskColor()` threshold (config `formatting.thresholds`, warning/critical) overrides the foreground only: dark #f2b550 then #f28686, light #805000 then #a02020, ansi yellow(3) then red(1). Per-item `foreground`/`background` overrides exist. In powerline mode the block colour can instead rotate by position (point 6).
2. Four theme IDs: `classic` (legacy), `dark`, `light`, `terminal` (ANSI slots). The palette is semantic roles (`ROLES` = model, directory, branch, percentage, tokens, timer, plus git_error and separator), so it is a role palette, not a per-segment map. Roles can be overridden per item. Users cannot add whole themes; they use per-item colours and portable named "display schemes"/profiles (docs/PROFILES.md, unverified beyond README). The TUI screenshots are named main-dark, main-light, main-dark-ansi, main-light-ansi.
3. Item colours accept `inherit`, `default`, `ansi:N` (0-255) or `#RRGGBB` (docs/APPEARANCE.md; `appearance.ts` `color()`). Config `palette: ansi` quantizes truecolor to the 16 ANSI slots (`colors.ts` `nearestTerminalColor`, with 8/16/256 tiers); there is no automatic depth detection from COLORTERM. `use_colors=false` gives an empty palette (`palette.ts` `NO_COLOR` is that palette, not the env var). No reading of the NO_COLOR environment variable found.
4. Both. Default is foreground-only bold text. Powerline mode (`separator_style: powerline`) fills each block with a background: dark `BLOCK_DARK` #3c3548 #234337 #3d3155 #543720 #542b3c #1f4148 with fg #f4f5f7; light `BLOCK_LIGHT` pastels with fg #202630.
5. Plain mode: grey ` | ` and ` · ` (`palette.ts` `styledSeparator`). Powerline mode (`powerline.ts` `separator()`): shapes arrow/slash/bar/none, start/end caps optional. The glyph is U+E0B0 or U+E0B2 (arrow), U+E0B8 or U+E0BA (slant). The glyph's foreground is the previous block's background and its background is the next block's. ASCII fallback is `>`, `/`, `|` when `powerline_glyph=ascii` or colours are off. The glyph is used only where adjacent backgrounds differ and the source background is explicit.
6. In powerline mode `powerline.color_mode`: `semantic` (role colours), `continuous` (the six block colours advance one per visible block across rows, `sequence()`), `restart` (resets each row). Hidden items and spacers consume no colour. If a rotating background equals the retained foreground (e.g. ANSI yellow warning on yellow), a neutral black/white background is substituted (`appearance.ts` `sequence()`).
7. Light and dark are separate explicit themes (no terminal detection). `terminal` uses ANSI slots so the terminal's own palette decides. Text on blocks is a fixed near-black or near-white per theme; the contrast fix is only the equal-colour guard above. The TUI follows the Claude theme, and its preview background is user-chosen.
8. Powerline glyphs need a patched font and are opt-in (`powerline-glyph ascii|powerline`). "Built-in icons" are configurable per item. Five UI languages. Not auto-detected.
9. In-session TUI (`/statusline-configure-native`), external TUI, wizard, per-item colour picker, 65 main metrics, per-subagent rows, screenshot gallery under docs/images. Colour is written through SGR parse/serialize with LRU memo (`styles.ts`).
10. JSON config with schema version 9. CLI `claude-statusline config set|item ...`, in-session editor, terminal TUI, Q&A wizard, portable import/export, project profiles.

## gati3478/preen
https://github.com/gati3478/preen (2 stars). A macOS dotfiles setup; its statusline piece is `prompt/cship.toml`, a config for the third-party cship renderer, not its own renderer.
1. Fixed per segment with threshold overrides (`prompt/cship.toml`): account `bold fg:#fabd2f`; model `bold fg:#83a598` with `family_style` fable #8ec07c, opus #83a598, sonnet #d3869b, haiku #b8bb26; agent #fe8019; effort low #b8bb26, medium #83a598, high #fabd2f, xhigh bold #fabd2f, max bold #fb4934; context_bar #8ec07c, warn >=40 #fabd2f, critical >=70 bold #fb4934; cost #b8bb26, warn >=2 and critical >=5 same two colours; +lines #b8bb26, -lines #fb4934; usage_limits warn >=70, critical >=90; duration #ebdbb2; used_tokens #83a598. Line 1 is starship passthrough.
2. One palette only, Gruvbox Dark Hard as literal hexes (README: "There is no light variant"). Format is cship TOML `style = "fg:#rrggbb"` strings per module. Users edit the file.
3. Truecolor hex. No downsampling or NO_COLOR in this repo (cship's behaviour not checked).
4. Foreground-only text on the terminal's own background (README: tuned against #1d2021).
5. Plain spaces. Fill alignment via `$fill`. No separators between segments.
6. Neighbours are told apart by differing hues and the literal spacing; no mechanism.
7. Dark only. No contrast logic.
8. Nerd Font icons required (README); without it icons are blank cells.
9. Colour-by-model-family and colour-by-effort tiers are notable. The statusline SVG screenshot is rendered from the configs.
10. cship.toml plus starship.toml; installer script `prompt/install.sh`.

## gautham-v/claudebar
https://github.com/gautham-v/claudebar (2 stars).
not a Claude statusline: macOS menu-bar app (Rust + GPUI) showing Claude usage-limit rings; settings in `~/.config/claudebar/config.toml` (`menu_bar`, `low_remaining_percent` 20 turns it red). Its theme code is `src/ui/theme.rs` for the popover (not read in detail).

## ggombee/forge-glow
https://github.com/ggombee/forge-glow (2 stars). Bash HUD, `hud/statusline.sh` + `hud/lib/render.sh`.
1. By state/threshold only. `render.sh`: `context_color` >=80 red(31), >=70 orange(38;5;208), >=50 yellow(33), else green(32). The `progress_bar` is 20 cells of █/░ in that colour. `cache_display` colours green >=70, yellow >=40, red below. Emoji carry the rest: `context_indicator` 🧊 <50, ⚠️ >=50, 🔥 >=70, 💀 >=80, ♻️ >=84; cost 💰/💸/🚨 at $2 and $5 per hour; rate limit ⚠️ >=60, 🔴 >=80. `hud/config.json` holds the thresholds. Model, project, cost and others are uncoloured text.
2. Not present.
3. Named ANSI 16 plus one 256 index (208). No depth detection or NO_COLOR found.
4. Foreground-only.
5. Plain text.
6. Emoji prefixes; no colour distinction.
7. Not present.
8. Heavy emoji (about 60 in the scan); no ASCII mode found.
9. Korean-language, adapters for other tools (OMC, ECC, Codex).
10. `hud/config.json` (layout, thresholds, elements toggles, prices). tmux status-right script also shipped.

## hasuwini77/ccstatusline-nocturne
https://github.com/hasuwini77/ccstatusline-nocturne (2 stars). Settings files for the ccstatusline tool, generated by `scripts/make_themes.py`, plus `statusline.sh` launcher and `standalone/noctu.py`.
1. Fixed per meaning, one colour each (README): yellow=context, orange=session window, purple=weekly limit, red=model window, blue=throughput, green=money/health. Each meter is split in two: a muted bar and a bright value. Only two items are filled chips: the model (palette `model`) and the git branch (palette `branch`); everything else is flat text. `make_themes.py colours()` builds the bar as `mix(accent, bg, .62)` (dark) or `.32` (light), timers `.25`/`.18`, chip icon cell `mix(body, bg, .45)`. Mapping per palette: effort=green, speed=blue, cost=green, changes=yellow, opus=red.
2. 7 palettes x 2 layouts (noctu two-row, panel three-row) = 14 theme folders: nocturne, dracula, tokyo-night, palenight, nord, gruvbox, material-light. Palette is 14 named colours (`bg fg glyph model branch limit ctx ses week green blue yellow red sep`, plus `light` flag). Generated JSON. Users copy one `settings.json` over `~/.config/ccstatusline/settings.json`; they can edit `PALETTES` and rerun the script.
3. `hex:RRGGBB` truecolor; README requires a truecolor terminal. No downsampling.
4. Mixed on purpose: two filled chips (model, branch), the rest foreground text on the terminal's own background ("your wallpaper still shows through").
5. A thin ` ▏ ` separator in the palette's `sep` grey; chips end with a powerline cap glyph (`l1-cap` custom text, coloured as the chip body). Not arrow-chained.
6. Different accent hue per meter plus grey separators. Each theme leads with its own signature colour so themes differ from each other.
7. Material Light is a real light variant with less blending toward the background ("at the dark value they wash out to nothing on white"). Chip text is the theme background colour (`chip1_ink` = bg). Chip icon glyph colour is `glyph`.
8. Needs a Nerd Font. No ASCII mode.
9. `scripts/align-bars.py` post-pass aligns bar columns across rows by planting zero-width markers. Preview PNG per theme.
10. ccstatusline JSON settings; `make_themes.py` regenerates all.

## heenatrivedi321-max/deadtime
https://github.com/heenatrivedi321-max/deadtime (2 stars).
not a styled statusline: `statusline.py` fetches one text line (a tip or a disclosed sponsor line) from a server and prints it with no colour codes (checked `public/statusline.py` and `.js`). The colour/animation signals come from the marketing site scripts (`aurora.js`, `magicrings.js`).

## henu-wang/cc-status-board
https://github.com/henu-wang/cc-status-board (2 stars). `src/statusline.js`.
1. By threshold for context only (lines 48-54): used <50 green(32), <65 yellow(33), <80 orange(38;5;208), else blinking red (`5;31`). The 10-cell █/░ bar and percentage share that colour. Tips beside it: >=90 blinking red, >=75 orange, >=60 yellow, >=40 dim. Model and directory are dim (`2`); the asset hint is cyan(36). Used% subtracts a 16.5% auto-compact buffer.
2. Not present.
3. Named ANSI 16 and one 256 index (208). No detection, no NO_COLOR.
4. Foreground-only.
5. Dim `│` (U+2502).
6. Only the dim separator.
7. Not present; dim attribute works on both backgrounds.
8. Emoji 💡 and block bar; no ASCII mode.
9. Blinking red SGR at critical context.
10. No config; install.js writes settings.

## ibragimov-oasis/oasis-languages-jp
https://github.com/ibragimov-oasis/oasis-languages-jp (2 stars).
not a Claude statusline project: a personal repo that vendors many third-party Claude assets. Statusline-relevant copies inside it:
1. `.claude/helpers/statusline.cjs` is its own: plain emoji text (`📝 files | ✅ tasks | 🤖 agents | 🔧 Vibe-Coder`), no colour. Vendored `.claude/hooks/combined/hooks-gsd/gsd/gsd-statusline.js` (the GSD statusline, lines 59-65): context <50 green, <65 yellow, <80 orange(38;5;208), else blinking red with 💀; model dim, task bold, directory dim, update notice yellow. Vendored `.claude/plugins/claude-hud/src/render/colors.ts` is claude-hud (see johnleeGitHub entry): per-element colours model cyan, project yellow, git magenta, branch cyan, label dim, custom 208; context <70 green, >=70 yellow, >=85 red; quota >=75 bright magenta, >=90 red, else bright blue. Vendored `everything-claude-code/examples/statusline.json`: a shell one-liner in truecolor, fixed per segment (directory blue, branch green, dirty yellow, ctx% magenta, model grey, user/todos cyan; the `_comments.colors` block lists it). The ruflo `statusline.js` imports a built module (`dist/statusline`) that was not in the fetched path, so its colours are unverified.
2. claude-hud copy: colours overridable per element with name, 256 index or `#rrggbb` (`resolveAnsi`). Others none.
3. As above (ANSI 16, 256, hex for claude-hud only).
4. Foreground-only.
5. gsd: dim ` │ `. Others none.
6. Not distinguished beyond separators.
7. Not present.
8. Emoji.
9. Blinking red at critical context (gsd).
10. claude-hud `config` JSON; others none.

## ibro45/claude-glance
https://github.com/ibro45/claude-glance (2 stars). `scripts/statusline.sh`.
1. Fixed per segment with one threshold: domain/anthropic.com grey(90), folder green(32), branch magenta(35), context cyan(36) and red(31) with ⚠️ at >=70 (line 105), timestamp 256 index 242, diff +green -red, summary line yellow(33).
2. Not present.
3. Named ANSI 16 plus index 242. No detection.
4. Foreground-only.
5. Plain grey-less ` │ ` (default colour).
6. By hue (green, magenta, cyan).
7. Not present.
8. Emoji ⚠️.
9. Two-line output with an AI-written summary line (`update-summary.sh`).
10. Installer CLI (`bin/cli.js`); no config file found.

## ilyannn/claude-statusline
https://github.com/ilyannn/claude-statusline (2 stars). Python `statusline.py` and a Rust port; styling in `rust/src/theme.rs` and `format.rs`.
1. Fixed roles plus thresholds (`theme.rs` struct `Colors`, `format.rs`): context uses `ctx_good/warn/crit` at <50, <75, else; usage (5-hour) at <50, <80, else; model `model`; git `git` (grey 90) with the dirty `*` in `ctx_warn`; update arrow `update`. Dark: good 92, warn 93, crit 91, model 96, git 90. Light: 32, 33, 31, model 34, git 90.
2. Two built-in palettes (`DARK_COLORS`, `LIGHT_COLORS`) of 12 semantic slots (reset bold dim ctx_good ctx_warn ctx_crit model git update usage_good usage_warn usage_crit). Users can't define more.
3. Named ANSI 16 only (bright 90-97 variants for dark). No downsampling or NO_COLOR.
4. Foreground-only.
5. Single spaces between parts; no separator glyph.
6. By distinct hue per role and icons (`✦ model`, `⎇ branch`, `⏱ usage`).
7. Yes, a real one (`theme.rs` `detect_dark_mode_from_env`): `CLAUDE_STATUSLINE_THEME=dark|light`, then `COLORFGBG` (background index <8 is dark), then macOS `defaults read -g AppleInterfaceStyle`, default dark. Light uses non-bright colours.
8. Unicode symbols (✦ ⎇ ⏱ ↑) and a context fill icon (`context_icon`); no Nerd Font.
9. Not present.
10. Env var `CLAUDE_STATUSLINE_THEME`; no config file.

## iskorotkov/cc-statusline
https://github.com/iskorotkov/cc-statusline (2 stars). Go; `style/style.go`, `parts/*.go`.
1. By part type, using only three colours (`parts/cc.go`, `git.go`, `gh.go`): additions `+NL` green, removals `-NL` red, cost green; PR merge flag `M` green or `NM` red; section labels (`CC`, `API`, `GIT`, `PR`, `TASK` in `main.go`) dim blue. Everything else uses attributes: model bold, directory italic, branch italic, remote URL underline, version dim, PR number bold, PR title italic.
2. No themes. `style.go` has a dark and a light variant of blue/red/green only.
3. Truecolor SGR 38;2 (`rgb()`). Dark: blue (192,192,255), red (255,127,127), green (127,255,127). Light: (0,64,160), (180,0,0), (0,128,0). No downsampling, NO_COLOR not found.
4. Foreground-only.
5. Dim ` / ` between parts (`parts/rows.go` `partSeparator`); rows joined by newline with a label prefix.
6. Separators and attribute differences (bold, italic, underline) rather than hue.
7. `detectTheme()`: env `CC_THEME=light|dark|auto`, else `COLORFGBG` (bg >=8 means light), default dark. Colours switch accordingly.
8. None noted; OSC 8 hyperlinks for PR and ticket links.
9. Italic/underline as the main differentiator.
10. Go code (compile-time part list), env `CC_THEME`.

## itsomidho/clawd-statusbar
https://github.com/itsomidho/clawd-statusbar (2 stars). `scripts/statusline.sh`.
1. Fixed per segment with a shared threshold helper (lines 27-42, 123, 294): model `◆ name` bold cyan; `pct_color()` returns green below 50, yellow at 50-79, red at 80+ and is used for CTX, 5h/7d limit meters, CPU, RAM; repo folder bold blue with dim parent; branch magenta `⎇`; review/CI status green ok, red fail, yellow running, dim otherwise; separators and labels dim.
2. Not present.
3. Named ANSI 16. No detection, no NO_COLOR.
4. Foreground-only.
5. ` · ` dim (`SEP`).
6. By hue and by only showing facts when they apply.
7. Not present.
8. Unicode glyphs (◆ ⎇ ● ↑ ↓ ≡ ↻) and a small block-drawn creature; no Nerd Font.
9. Animated "Clawd" frying an egg beside the bar while Claude works (hooks/register.tsx drives state; `docs/clawd_gif.py` makes the GIF), 8-cell bar meters with fractional fills.
10. Env/flags in the script (e.g. `LAYOUT`, `SYS_MIN`); installer script.

## j2h4u/oh-my-claude-plugins
https://github.com/j2h4u/oh-my-claude-plugins (2 stars). One file: `meta/utils/statusline/omcc-statusline.py` (2985 lines), also a theme-editor TUI.
1. Semantic tokens (class `T`, lines 228-248) in 256-colour: dir_parent 239, dir_name 243, branch 66, git_dirty dim 3, git_staged dim 2, git_untracked 3, ahead 6, behind 5, ok 22, warn 94, wait 27, none 237, notif 6, sep 241, err 88, lim_time 239, limit-bar bg 236. Usage limits are drawn as bars coloured by ramp over percent. `RAMP_PRESETS` (256 indices at percent stops): aurora, traffic, twilight, ember, spectrum, heatmap. The "pace delta" colour is an OKLCH ramp: teal when under budget (L .45-.65, C .06-.10, h 195), orange when over (h 50 to 25), log-scaled to 40 percent (`_pace_delta_color`).
2. One built-in token set; users override any token in `config.json` under `"theme"`: `{token: {fg: 0-255, bg: 0-255, attrs: [...]}}` (validator lines 453-515). 18 editable tokens (`ELEMENTS`). Ramp name is a setting. No named bundled themes.
3. 256-colour indices for all tokens; OKLCH rainbow and pace colour emit truecolor (`fg_rgb`). No depth detection, no NO_COLOR found; `FORCE_COLOR=1` is set only when it runs ccusage as a child (line 1742).
4. Foreground mostly; the limit bar uses a background (`lim_bar_bg` 236) with fractional block glyphs in the ramp colour.
5. Configurable separator glyph from `SEP_OPTIONS` (· • │ ─ ⋮ | ║ ┃ ❘ or none) with separate settings for git, limits and extra slots.
6. Spacing and the chosen separator; muted greys for secondary text.
7. Not present.
8. Unicode only; sub-cell bar glyphs (` ▏▎▍▌▋▊▉█` horizontal, ` ▁▂▃▄▅▆▇█` vertical); OSC 8 links.
9. Perceptually uniform OKLCH rainbow text (`_rainbow`, binary-searched max chroma per hue, phase advanced per render in a SQLite cache) on weekends; a built-in theme editor (`--theme`: colour grid, attrs including curly/dotted underline, blink, strike), ramp preview strips, number/vertical/horizontal bar display modes.
10. `config.json` ("slots", "settings", "theme"); a TUI editor; slots can wrap external commands (e.g. ccusage) with ttl.

## jah2488/low-load
https://github.com/jah2488/low-load (2 stars). `claude/statusline.sh`.
1. By threshold, three-step (lines 18, 65-78): `color()` green below the amber threshold, yellow/amber at it, red at the red one. Context 50/80 with ⚠ red at >=90; 5h limit 60/85. Fixed: lines added green, removed red, git `*` yellow dirty or `✓` green clean, flint mode glyph feral red / ultra amber / full+lite green / off dim. Labels dim; session name bold.
2. Not present (the repo also ships an Alacritty theme in `terminal/alacritty/`, unrelated to the bar).
3. Named ANSI 16 only.
4. Foreground-only.
5. Dim ` · `.
6. Mostly colourless text with colour reserved for state ("color carries the signal"), separators dim.
7. Not present.
8. Few glyphs (✦ ⚠ ✓).
9. Design stance: preattentive cues only.
10. Script edit; installer.

## jasonhoang6201/claude-statusline
https://github.com/jasonhoang6201/claude-statusline (2 stars). `statusline.sh`.
1. Fixed per segment from a theme (lines 2-60): model `C_MODEL`, "In:" `C_IN`, "Out:" `C_OUT`, "Cache:" `C_CACHE`, "Ctx:" `C_CTX`, 5h/7d labels `C_LABEL`, dim numbers `C_DIM`. Bars (context, 5h, 7d) switch to `C_OK` below 60, `C_WARN` at 60-79, `C_DANGER` from 80, with ░ in `C_DIM`.
2. Four themes selected by editing the `THEME=` line: catppuccin (Mocha), tokyo, dracula, nord. Each is 11 role variables (MODEL OK WARN DANGER LABEL DIM SLASH IN OUT CACHE CTX), truecolor. Users add a `case` branch.
3. Truecolor only (38;2). No downsampling or NO_COLOR.
4. Foreground-only.
5. Faint `│` in `C_SLASH`, and two-space gaps.
6. Different role hue per metric (e.g. Catppuccin: mauve model, blue in, pink out, peach cache, teal ctx).
7. Not present; dark themes only.
8. Plain Unicode.
9. Two-row layout with reset countdowns.
10. Edit the script variable.

## jccidc/.statusline
https://github.com/jccidc/.statusline (2 stars). `hook/statusline.js`, `shared/statusline-preset-common.js`, plus a browser playground.
1. Per-segment colour from a preset, each segment independently styled. Default segment colours (`statusline-preset-common.js`, segment catalogue): caveman/rtk/ctx badges bold bright yellow / bright cyan / bright magenta; enforcer bright blue; branch magenta; ahead-behind cyan; dirty bold red; untracked yellow; diffstat yellow; PRs green; commit age grey italic; repo white; model white dim; task white bold; dir white dim; clock grey; cost bright green; 5h quota bright cyan; weekly bright blue; context bar green. A preset can override any segment (e.g. cyberpunk: model orange, branch/repo/commit red, todos magenta).
2. Presets are bundled (8+) and the playground has 9 terminal themes for previewing. Format: per-segment style map `{color, bold, dim, italic, underline, strikethrough, bgColor, hex/useHex, hexBg, icon, bracket, caseTransform, caption, sepBefore, alignment, maxWidth}`. Users can create/save/share presets (URL sharing) via the playground; `/statusline-preset` switches.
3. 16 ANSI names (30-37, 90-97), two 256 entries (orange 208, pink 205), plus per-segment truecolor hex for both foreground and background (`buildSegmentCodes`). No downsampling or NO_COLOR found.
4. Both: optional background colour per segment (`bgColor`, `hexBg`), default `inherit`.
5. A per-segment `sepBefore` string (e.g. ` → `, ` │ `); separator style set in the snapshot (`sepColor` default gray, `sepBold`, `sepDim`). No powerline glyphs.
6. By assigned colour per segment and the chosen separators; no auto rule.
7. Not present in the hook; the playground previews against 9 terminal backgrounds.
8. Emoji icons optional per segment (`icon`), bracket styles; no Nerd Font.
9. Browser playground with live preview, undo/redo, URL sharing; a dim caption row printed under each segment, width-aligned.
10. JSON presets in `~/.claude`, `/statusline-preset` command, playground "Link Claude" for the local folder.

## JerryLien/claude-code-hp-statusline
https://github.com/JerryLien/claude-code-hp-statusline (2 stars). `statusline-hp.sh` with an embedded Python helper.
1. By threshold: `pick_color()` bright green below 50, bright yellow 50-79, bright red 80+ (lines 540-548) for the 5h, 7d and context bars (HP-style: filled = remaining). Token count in the task row uses `token_color` red >=90, yellow >=70, else cyan. Fixed: `[1M]` badge cyan, update version yellow badge, branch/worktree dim grey, effort uses a 5-level glyph (RPG: ↓ ~ ↑ ⇈ ★; Bloom: 🔵🟡🔴🟣⚫) with max in reverse video.
2. Two themes, `rpg` (default) and `bloom` (flowers), picked by env or settings `STATUSLINE_THEME` (also read from `~/.claude/settings.json` `env`). A theme is a block of shell variables (bar glyphs, icons, effort styles); not a colour palette. `THEME_FILE` suggests a file-based theme, not verified.
3. Named ANSI 16 (bright variants). No detection or NO_COLOR found.
4. Foreground-only (reverse video for max effort).
5. Spaces; bar brackets coloured with the bar.
6. Mostly emoji prefixes.
7. Not present.
8. Emoji-heavy (⚔ ❤ 🧠 ⚡ 🔮 💰 / 🌱 🌸 🍄); bar glyphs █░ for RPG, 🌸 for Bloom.
9. Game HUD framing; OSC 8 clickable PR badge with review-state colour; auto-wraps to two rows when narrow.
10. Env var `STATUSLINE_THEME`; hooks for usage and update checks.

## jiikko/dotfiles
https://github.com/jiikko/dotfiles (2 stars). The Claude statusline is `_claude/statusline-command.sh`; `src/ratelimit/usage/render.go` is a Go usage renderer; `_claude/mods/desktop-statusline` is a Claude Code mod for the desktop app.
1. By state plus fixed. Fixed (script lines 105-111, 123, 564, 594): branch black on green background `[git info]`; model cyan `[model]`; effort magenta `[effort:x]`. Usage `rate_color()` green below 50, yellow 50-79, red 80+. A pace row gives pace words colours (over limit red, over yellow, on-pace green, spare bright blue, surplus magenta), green/red backgrounds with black text for cells, today's cell underlined (lines 186-194). `blink_color()` blinking bold red/yellow near limits.
2. No theme selector in the statusline. The repo has a separate documented terminal/tmux/nvim palette system (`docs/theme-colors.md`; the 017 issue designs a Claude-orange theme with 256-colour approximations); not part of the bar.
3. Named ANSI 16 in the script. The Go renderer takes a `colored` bool. No detection of depth in the script.
4. Both: the branch tag and pace cells use ANSI backgrounds with black text; the rest is foreground.
5. Plain spaces and brackets.
6. Bracket plus colour per field.
7. Not present.
8. Emoji and CJK pace labels.
9. Blinking SGR, a pace/budget gauge row.
10. Script edit; Go binary flag for coloured output.

## johnleeGitHub/claude-hud-enhanced
https://github.com/johnleeGitHub/claude-hud-enhanced (2 stars). Fork of jarrodwatts/claude-hud (TypeScript, `src/render/colors.ts`, themes in `src/constants.ts`).
1. Per element role (`colors.ts`): model cyan, project yellow, git magenta, git branch cyan, label dim, custom 256-208 orange; context bar green until 70, yellow 70-84, red 85+ (thresholds configurable); quota bright blue, bright magenta from 75, red from 90. Every role can be overridden per config.
2. 12 bundled themes (`COLOR_THEMES`, README): default, solarized-dark, dracula, nord, catppuccin-mocha, monokai, gruvbox, neon, synthwave, matrix (the default of this fork), sunset, ocean. A theme is a map of roles (context, usage, warning, usageWarning, critical, model, project, git, gitBranch, label, custom, barFilled, barEmpty). Selected by `display.theme`; user colour overrides in `colors`. No user-defined theme files found.
3. A colour value is a name (8 names), a 256 index, or `#rrggbb` (`resolveAnsi`). No downsampling or NO_COLOR.
4. Foreground-only.
5. Optional `showSeparators`; plain text.
6. By role hue; matrix theme makes nearly everything the same green (#00ff00), differing only in alerts.
7. Not present.
8. Emoji and CJK labels; i18n en/zh; bar glyphs configurable (`barFilled`/`barEmpty`).
9. Bilingual UI, prompt-cache countdown, cost in CNY.
10. JSON config (`display`, `colors`, `elementOrder`, presets Full/Essential), install script.

## khalilgitsit/claude-code
https://github.com/khalilgitsit/claude-code (2 stars). Bash, `statusline/` with `themes/`, `sections/`, `lib/`.
1. Fixed per section from theme variables: directory BLUE; model CYAN; cost GREEN; MCP count CYAN; tokens LIGHT; session time MUTED; permission mode via `perm_color`: bypass RED, acceptEdits YELLOW, plan BLUE, default GREEN; context percentage and 5h/7d limits via `tier_color` (`lib/helpers.sh`): GREEN <=40, YELLOW <=70, RED above. Context bar (`lib/layout.sh` `render_bar`) is a per-cell truecolor gradient from green (91,185,140) to amber (212,160,74) at 50% to red (224,108,108) at 100%, drawn with `━` filled and `╌` empty.
2. Three themes, `dark` (default), `light`, `minimal`, picked by `STATUSLINE_THEME`; each is a sourced shell file of 13 roles (structural DIM MUTED LIGHT SEP LABEL; semantic GREEN YELLOW RED BLUE CYAN PURPLE ORANGE WHITE; CTX_EMPTY). Adding a file adds a theme.
3. Truecolor for dark and light; `minimal` is basic ANSI 16 plus the dim attribute "for maximum compatibility". No detection, no NO_COLOR.
4. Foreground-only.
5. ` | ` in the theme's `SEP` colour (dark #374151).
6. By different hue per section and the separator.
7. Explicit light theme with darker hues (e.g. green 40,140,80; text white role is 30,30,30). Caveat: the bar gradient endpoints are hard-coded dark-theme colours, so they do not change with the theme.
8. Plain Unicode box glyphs; no icons.
9. Gradient bar; nano/compact/full width modes; random quote section.
10. `STATUSLINE_THEME`, `SL_MODE`; edit shell files.

## konser80/cc-statusline
https://github.com/konser80/cc-statusline (2 stars). `statusline.sh`.
1. Mixed. Fixed: directory parent grey (240) + current dir blue (4); model icon/text grey (8); git `git:` grey with status green clean or red dirty; cache timer dark grey, yellow when low. Threshold: percentage and bar share `pct_color` (red high, orange, yellow, green), bar dark grey up to 40%; limit lines dark grey, yellow, red.
2. Not present.
3. Depth-aware via `COLORTERM`: when `truecolor|24bit`, green/yellow/orange/red are hex (#8fae7a, #c4a767, #c9885f, #cc6666), else nearest 256 indices (108, 179, 173, 167); other colours are fixed 256/16 indices (30, 240, 8, 4, 81, 78). Only this project in the batch with this fallback. No NO_COLOR.
4. Foreground-only.
5. Grey `|`.
6. Distinct hues for state and grey for structure; muted palette.
7. Not present.
8. Emoji/Unicode glyphs (❄ cache timer, ⤳ non-Claude model).
9. Muted earthy truecolor palette with a 256 fallback.
10. Script edit; deploy script.

## kylinfish/coralline-best-themes
https://github.com/kylinfish/coralline-best-themes (2 stars). FORK OF Nanako0129/coralline. Parent facts needed to read the diff: the parent engine (`statusline.sh`, 2640 lines) renders powerline pills with a fixed colour per segment (`VL_BG_DIR`, `VL_BG_GIT_OK/DIRTY`, `VL_BG_MODEL`, `VL_BG_CTX`, `VL_BG_5H`, `VL_BG_7D`, `VL_BG_COST`, `VL_BG_CLOCK`, `VL_BG_EFFORT`, ...) from a theme `.conf`; styles pill, lean, classic (`VL_STYLE`); separators U+E0B0 arrows between pills with the glyph foreground = previous bg and background = next bg (`render_range`); `VL_ASCII=1` fallback; bg values are 256 index or "R,G,B"; ten bundled themes.
Differences in the fork:
1. Same mechanism (fixed bg per segment), but colours are generated. `tools/gen-best-themes.py` takes 11 semantic colours per palette and maps them: blue->dir, green->git-ok and FG_OK, magenta->project/style, yellow->git-dirty and FG_WARN, purple->model, red->cost and FG_HOT, cyan->clock/duration, bg->the gauge gradient (7d = bg, 5h and ctx lifted toward fg via `blend`) and dark pill text, comment->FG_DIM brightened. Example `themes/best-themes/andromeda-mariana.conf`: dir 124,183,255; model 199,77,237; git ok 150,224,114; dirty 243,156,18; cost 238,93,67; clock 0,232,198; ctx/5h/7d 56,59,72 / 44,47,60 / 31,35,48.
2. Adds a 72-theme pack ported from the VS Code extension Best Themes Redefined (README: 92 entries fold to 72 distinct palettes, 79 total with the upstream 7), all truecolor "R,G,B". Palette table lives in the generator; some marked `# approximated`. Adds a pure-bash live theme picker `tools/theme-picker.sh` (previews a real statusline, swaps only the theme line of `coralline.conf`) and `tools/render-screenshots.py`.
3-9. Same as parent otherwise. The fork's `statusline.sh` (471 lines) is an older, smaller snapshot of the parent engine (the parent has since grown a subagent panel, more segments, auto-contrast of subagent inks); not checked line by line.
10. `~/.claude/coralline.conf` sourcing a theme file; picker; AI-driven install playbook (INSTALL.md).

## leehack/cc-litellm-statusline
https://github.com/leehack/cc-litellm-statusline (2 stars). `scripts/cc-litellm-statusline.sh`.
1. Fixed, copying the robbyrussell zsh prompt: green bold arrow `➜`, cyan directory, bold blue `git:(` with red branch and yellow `✗` when dirty; LiteLLM spend 💰 magenta without a budget, otherwise by percent: green up to 75, yellow 75-90, red over 90. All dimmed (`\033[2;...`).
2. Two variants as files: default dimmed, and `examples/statusline-custom-colors.sh` using bright (non-dim) codes. No theme system.
3. Named ANSI 16 with the dim attribute. No detection, no NO_COLOR.
4. Foreground-only.
5. Spaces.
6. Hue per role.
7. Not present.
8. Emoji 💰.
9. Spend/budget from a LiteLLM proxy.
10. Edit the script; cross-platform installers (sh and PowerShell).

## LeeYudok/dotfiles
https://github.com/LeeYudok/dotfiles (2 stars). `claude/statusline-command.sh` (also `agy/` and a Codex variant).
1. Fixed per segment in 256-colour, muted palette (lines 13-27): path 110 steel blue, git clean 108 sage, git dirty 179 amber, model 73 dusty teal, cost 144 khaki, mute 244 grey; ok/warn/crit = 108/179/167. Context bar and percent: warn at 60, crit at 80 (or if `exceeds` 200k flag). Cache hit coloured ok when warm, mute otherwise.
2. Not present.
3. 256-colour indices; dim attribute for separator. No detection.
4. Foreground-only.
5. Dim ` │ `.
6. Hue per role, desaturated.
7. Not present.
8. Korean labels; block bar.
9. Deliberately "dim/muted for a quieter look".
10. Script edit.

## lucasmen9527/CCometixLine
https://github.com/lucasmen9527/CCometixLine (2 stars). FORK OF Haleclipse/CCometixLine; 4 commits ahead of a parent that has since moved 86 commits (parent HEAD is a v2 rewrite with 13 palettes and a new config). The fork sits on the older v1 line.
Differences in the fork:
1. Adds segments ported from claude-hud (commit "integrate claude-hud statistics"): tools, agents, todos, environment (`src/core/segments/{tools,agents,todos,environment}.rs`). The context-window segment draws a coloured progress bar with raw ANSI: green below 70, yellow 70-85, red >=85, empty cells grey 90 (`context_window.rs` lines ~290-311). The inherited mechanism is fixed colours per segment per theme: each theme file builds a `SegmentConfig` with `icon`, `text` and `background` colours (e.g. `theme_powerline_dark.rs`: model bg 45,45,45; directory 139,69,19; git 64,64,64; context 55,65,81; cost 40,44,52; session 45,50,59; output_style 50,56,66; usage 45,50,59, text/icon white). The four new segments have no entry in that theme file, so they render without a background there.
2. Nine v1 themes selectable in the TUI (`theme_selector.rs`): cometix, default, gruvbox, minimal, nord, powerline_dark, powerline_light, powerline_rose_pine, powerline_tokyo_night. Format: Rust structs, user themes as `~/.claude/ccline/themes/*.toml` (README).
3. `AnsiColor` enum: 16-colour, 256 index, or Rgb (`statusline.rs` `apply_background_color`); no downsampling logic seen. No NO_COLOR found.
4. Both: segments with `background` set are filled; the plain themes are foreground-only.
5. Powerline arrow U+E0B0 when `style.separator == "\u{e0b0}"`: `create_powerline_arrow(prev_bg, curr_bg)`; any other separator is drawn in white (`\x1b[37m`).
6. Each segment has its own background in the powerline themes; the dark theme uses near-identical greys (45,50,59 vs 50,56,66) so the arrows do the separating.
7. `theme_powerline_light.rs` is a separate light theme; no detection.
8. Nerd Font icons with an emoji plain fallback per segment (`IconConfig {plain, nerd_font}`).
9. Interactive ratatui TUI with colour picker and icon selector (`ui/components/color_picker.rs`, `icon_selector.rs`), live preview.
10. TOML config, `ccline -c` TUI, install script added by the fork.

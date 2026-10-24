## cc-statusline-rust
https://github.com/jaewon-nm/cc-statusline-rust — stars 0
1. Fixed per widget kind, plus threshold on bars. `docs/design-docs/default-theme.md` table: model cyan+bold, cwd blue, session_tokens magenta, session_cost yellow, git_branch green, git_status yellow, git_changes `+` green / `-` red. Bar fill (context, 5h, 7d) goes by state: `bar_tier_color` in `src/render/color.rs` is green <50, yellow <80, red >=80 (`BAR_WARN_PERCENT`/`BAR_CRIT_PERCENT`); NaN gives green.
2. Themes: one hard-coded "default" theme (locked golden-output doc plus an `insta` snapshot). No bundled alternatives. Users override per widget kind in `config.colors[kind]` (`ColorStyle {fg,bg,bold}`); an override REPLACES the theme style end to end, including the threshold bar colours (`src/render/mod.rs` ~L101-116).
3. Colour spec: names (16 ANSI incl. `bright_*`, `purple`, `grey`) or `#RRGGBB` truecolor, parsed by `parse_color` in `color.rs`; invalid values are rejected by `config validate`. No depth detection or downsampling. NO_COLOR (via `anstyle_query::no_color`) strips everything; `CLICOLOR_FORCE` and `FORCE_COLOR` force it on (the doc says Claude Code always pipes, so colour defaults to on).
4. Fill: foreground-only by default. `ColorStyle.bg` exists as an override option but no default widget sets it.
5. Separators: plain ` | ` (`INTER_WIDGET_SEPARATOR` in `src/render/mod.rs`), unstyled.
6. Neighbours: different hues per widget plus the ` | ` separator.
7. Light/dark: not present (fixed ANSI names, which the terminal palette remaps).
8. Glyphs: emoji icons in the default theme (`✦ 📂 🔋 📊 💰 ⏱ 📅 🌿 ⛓`); the doc states no Nerd Font. Bar is ASCII `[##........]`.
9. Other: `NO_COLOR=1` gives the diff-friendly plain text. `ColorMode::{Auto,Always,Never}` test seam. Reset times default to KST (`tz` config).
10. Customisation: JSON config with a `colors` map, edited via CLI `ccstatusline-rs config color <kind> --fg/--bg/--bold/--clear`, `config validate`, `preview`, `install` (`src/cli/*`). Env: NO_COLOR, FORCE_COLOR, CLICOLOR_FORCE.

## cc-chips-jy
https://github.com/JaeyeonBang/cc-chips-jy — stars 0
1. By position slot (each chip has a theme colour slot) with state overrides. `engine.sh` L670-777 paints chips as LEFT (folder/path), MID (git/worktree), RIGHT (context chip), STATS (cache chip), ACTIVITY, CONFIG. Each slot has `FG_x`, `BG_x`, `FG_x_TEXT`. Section [K] "dynamic colour alerts" (L570-585) swaps the whole chip: context >=80% red, >=50% orange, else the theme default. Cache chip >=80% green, <20% yellow. A slow-API chip gets a `!!` prefix. Chips 5 and 6 default to blue (30,100,160) and slate (70,70,100) (`engine.sh` L38-47).
2. Themes: 5 bundled in `themes/*.sh`: claude, cool, retro, cyber, minimal. Each is a shell file of per-slot ANSI truecolor variables (not semantic roles). `CC_CHIPS_THEME` env var, falling back to a value read from the shell rc file; names are sanitised against path traversal. Users can add a `themes/<name>.sh` file.
3. Colour spec: truecolor `\033[38;2;r;g;bm` / `48;2` everywhere. No depth detection, no NO_COLOR handling (grep finds none). minimal theme sets `CHIPS_ASCII=1`.
4. Fill: background-filled "chips" (bg + bold text), with the cap glyphs drawn in the chip colour as foreground over the terminal background.
5. Separators: rounded caps U+E0B6 / U+E0B4 around each chip (`CAP_LEFT`/`CAP_RIGHT`); `CHIP_SEP=" "` between chips. The cap fg equals the chip bg (`FG_x` is the same hex as `BG_x`). No powerline arrows between chips; each chip is its own pill. ASCII mode uses `[` `]` and ` | `.
6. Neighbours: every chip has a distinct bg hue per theme (claude: near-black #1F1E1D, white #FFFFFF, brown #8B5A2B, green #2E7D32). Cyber reuses teal for the MID and STATS chips. Gaps between pills separate them.
7. Light/dark: chip text is hand-paired per slot (`FG_x_TEXT`); no automatic contrast. Responsive hiding by terminal width (chips drop at <70, <100, <120 columns), not colour adaptation.
8. Glyphs: Nerd Font icons by default (`engine.sh` L76-100); `CHIPS_ASCII=1` swaps in ASCII icons and `#`/`-` bar fill.
9. Other: progressive disclosure hides the stats chip when all metrics are healthy (`CHIPS_QUIET`); a "DISCONNECTED" state; PowerShell twin `engine.ps1`.
10. Customisation: env `CC_CHIPS_THEME`, `CC_CHIPS_COLS`; edit theme shell files; `install.sh` / `uninstall.sh`. No TUI.

## jamescarron/claude-statusline
https://github.com/JamesCarron/claude-statusline — stars 0
1. Per item, three tones plus none, chosen per item in config: `dim`, `accent`, `warn`, or `threshold` (becomes `warn` once used% >= the item's `warn` value, default 80, else uncoloured). Function `colour()` at `statusline.sh` L79-85. `ANSI` map L300: dim=`\e[2m`, accent=`\e[36m`, warn=`\e[33m`. Default config (L46-48): context, 5h and weekly use `threshold`; month cost is `dim`.
2. Themes: not present. There are no palettes, only the three tones.
3. Colour spec: three fixed 16-colour SGR codes. No depth detection or NO_COLOR handling found.
4. Fill: foreground only.
5. Separators: plain ` | ` between shown items (L304), uncoloured.
6. Neighbours: separators only. Colour appears on an item only when it crosses its threshold.
7. Light/dark: not present (uses dim, cyan and yellow, which depend on the terminal palette).
8. Glyphs: `█`/`░` bar (L91) for the context display; otherwise plain text, no Nerd Font or emoji.
9. Other: a local web config page (`config_server.py`) with a live preview. The script has a preview mode (`STATUSLINE_PREVIEW=1`) that prints `id<TAB>colour<TAB>text` per item so the page can draw the colours. Per-item options: label, measure (used/left), display (pct/bar/both), `colour`, `warn`. Weekly item auto-hides below a threshold or pace.
10. Customisation: `config.txt` key=value file (order, show, per-item keys) written by the web UI; env `STATUSLINE_CONFIG`, `STATUSLINE_NOW`, `STATUSLINE_PREVIEW`; PowerShell setup script.

## japan-da-man/claude-code
https://github.com/japan-da-man/claude-code — stars 0
not a Claude statusline: a fork/collection of Claude Code mods and plugins ("Claude Code plugins and mods", derived from anthropics/claude-code-playground mods; blast-radius, design-system, factory "line" = a build/QA production line, replay-theater). The `line` directory is not a status line; no statusline styling found.

## jarek2k/claude-statusline-editor
https://github.com/Jarek2k/claude-statusline-editor — stars 0
1. Fixed per element type, with an "auto" mode for percentage elements. Each `TYPES` entry in `src/renderer.mjs` has a default `color`: model `#3bd6e0` bold, folder `#ffffff`, branch `#c678dd`, pr `#61afef`, worktree `#56b6c2`, fast `#f1c40f`, agent `#c678dd`, vim `#98c379` bold, cost `#e5c07b`, tokens `#aaaaaa`, version/session `#808080`, compact hint `#e74c3c`, text/separator `#555555`. `color:"auto"` (ctxbar, ctxpct, tokens, ratelimit, lines, cache) means by state. The traffic light `ampel()` is green below `warn` (default 50), yellow from `warn`, red from `crit` (default 80). The alternative fill mode is a continuous gradient green→yellow(0.5)→orange(0.75)→red (L25-38). Lines +/- is green/red; cache is green warm / dim cold. Every element can override fg and bg.
2. Themes: not a theme system. Instead 3+ whole-layout presets (`PRESETS`: "minimal"/Schlicht, "compact"/Kompakt, "dashboard"/Übersicht) applied from the editor.
3. Colour spec: hex (`#rgb` or `#rrggbb`) in config; output is always truecolor `38;2;r;g;b` / `48;2` (`ansi()` L690-715). No depth detection, no NO_COLOR found.
4. Fill: both. Each element can set `bg` (hex); the thick "inverse" bar style uses SGR 7 (reverse) so the cell wears the bar colour as a background.
5. Separators: user-placed `text` elements (default `│` or `·`, `#555555`, `autohide:"1"` so a separator is dropped when a neighbour is empty). No powerline arrows.
6. Neighbours: per-element hue chosen by the type's default colour, plus explicit separator elements.
7. Light/dark: not present beyond the empty-bar colour being editable (default `#555555`). Safe-width logic accounts for Claude Code's 4-column inset (`EDGE`).
8. Glyphs: emoji and Unicode prefixes (`📁 ⎇ 🌳 🤖`); bar styles `blocks █░`, `thin ━─`, `shade ▰▱`, `dots ●○`, "inverse" eighth-blocks, a joke `kotz` bar with green-shade runs.
9. Other: a web designer (`src/server.mjs`) with a drag-and-drop live preview and per-element colour pickers; layout with left/center/right zones and multi-line; a "mood" element that comments more rudely as context fills; gradient bar fill.
10. Customisation: JSON `~/.claude/statusline-config.json` (v2 schema: `elements[]` with `type,line,col,opts`), edited through the local web UI; renderer CLI flags `--segments`, `--types`; PowerShell build script.

## jbmoutout/spark
https://github.com/jbmoutout/spark — stars 0
1. No colour. `spark.sh` writes a plain-text line (`⚡ branch · model · tokens · clock`) and delivers it as `UserPromptSubmit` additionalContext that Claude is asked to echo verbatim (L484-513), not as a `statusLine` command. No ANSI anywhere in the files read.
2. Themes: two layouts only, `default` and `compact`, read from the widget config `theme` key (L141-146, branch at L333). They differ in text layout, not colour.
3. Colour spec: not present. NO_COLOR is not relevant.
4. Fill: not present.
5. Separators: ` · ` plain text.
6. Neighbours: separators only.
7. Light/dark: not present.
8. Glyphs: `⚡` prefix, `✓`/`✗` in compact, a block-character splash banner (`███…`) on first prompt, optional plant emoji widget.
9. Other: delta mode (prints only values that changed since the last prompt); splash screen.
10. Customisation: a widget config file with `theme`; `install.sh`, `bin/cli.js`.

## jbonomo38/claude-status-line
https://github.com/Jbonomo38/claude-status-line — stars 0
1. By state/threshold, one colour for the whole line. `status-line.sh` L148-195: used% <60 green (`\033[32m`), <80 yellow, 80-85 red plus ⚠️, 85-95 red with checkpoint/`/clear` hints, >=95 bold red. The colour is applied to the percentage and warning text; the "In/Out/Cache/model" tail is uncoloured.
2. Themes: not present.
3. Colour spec: ANSI 16 only (31/32/33, 1 for bold). No detection or NO_COLOR (L199-207 uses `echo -e`).
4. Fill: foreground only.
5. Separators: ` | ` plain.
6. Neighbours: separators only.
7. Light/dark: not present.
8. Glyphs: emoji status markers (⚠️ 💾 ✅ 🔴 🟢) in the warning text.
9. Other: this repo is mostly a checkpoint daemon (auto-checkpoint, `/clear` hooks); the status line is a cue for it.
10. Customisation: edit the script; `install.sh`, `setup-auto-checkpoint.sh`.

## jcsoftlabs/civora-backend
https://github.com/jcsoftlabs/civora-backend — stars 0
Not a statusline project: a monorepo for a "Civora" backend/app that vendors third-party Claude skills (`skills/bencium-marketplace-main`, `ui-ux-pro-max-skill`, etc.). The only statusline code is the vendored `skills/bencium-marketplace-main/emotion-statusline/scripts/statusline-command.sh` (a bencium "emotion statusline"), covered here:
1. Two-line design split by purpose. Line 1 repo context is cool: dir `\033[94m` bright blue, branch `\033[96m` bright cyan, `+N` `\033[92m` green, `-N` `\033[91m` red. Line 2 session: model `\033[37m` white, context % by threshold (<50 `\033[92m`, <80 `\033[93m`, else `\033[91m`), tokens in/out `\033[34m` blue, and an emotion label whose colour is mapped per emotion (curious 96, focused 37, satisfied 92, cautious 93, enthusiastic 95, contemplative 34, confident 92, uncertain 33, determined 97, amused 95, concerned 91, relieved 92, desperate `91;1`, calm 36, unknown `90;2`) from a cache written by an async classifier (L119-141). Comment: "semantic color theory".
2. Themes: not present.
3. Colour spec: ANSI 16 incl. bright (90-97), no 256 or truecolor; no NO_COLOR.
4. Fill: foreground only.
5. Separators: dim (`\033[2m`) `│` between segments, `|` before the emotion label.
6. Neighbours: separators plus the cool/warm split between lines.
7. Light/dark: not present.
8. Glyphs: `↓ ↑` token arrows, `│`; no emoji or Nerd Font.
9. Other: emotion-driven colour (a bold-red DESPERATE warning), per-session cache file.
10. Customisation: edit the shell script. (Other files in this repo, such as `packages/ui/src/theme.ts`, `ColorPalette.tsx` and the pptx theme helpers, are unrelated web/office theming.)

## jdk-official/claude-code-terminal-bar-crawl
https://github.com/jdk-official/claude-code-terminal-bar-crawl — stars 0
1. By theme role, and by state. `statusline/statusline.sh` L19-26: `c_accent` (model name), `c_text` (project), `c_mute` (labels, separators, reset times), `c_ok`/`c_warn`/`c_bad` (bar thresholds), `c_mag` (git branch). Effort colour (low=mute, high=accent, xhigh/max=magenta, else text). Fast-mode bolt `c_warn`; dirty `*` `c_warn`. Bar: green <60, yellow >=60, red >=85 (`bar()`).
2. Themes: palette from a TOML file with `name = "#rrggbb"` lines (accent, foreground, dark_foreground, green, yellow, red, magenta). Default path is Omarchy's current theme `colors.toml` when present; otherwise built-in Catppuccin Mocha-like fallbacks (`89b4fa`, `cdd6f4`, `7f849c`, `a6e3a1`, `f9e2af`, `f38ba8`, `cba6f7`). The palette follows the desktop theme, so the statusline matches it with no per-theme work. Override with `CLAUDE_STATUSLINE_PALETTE`. This is a real semantic-role mapping (seven roles).
3. Colour spec: truecolor only (`38;2`), built from hex via `printf '%d' 0x..`. No depth detection or NO_COLOR.
4. Fill: foreground only.
5. Separators: `  │  ` with muted colour (`c_mute`); `|` in plain-icons mode.
6. Neighbours: separators plus differing roles (accent/text/magenta).
7. Light/dark: relies on the palette; no contrast computation. The fallback comment says "the fallback keeps it readable anywhere".
8. Glyphs: Nerd Font by default (md icons for model, folder, git), `CLAUDE_STATUSLINE_ICONS=plain` swaps in ASCII. Bar glyphs `▰▱`.
9. Other: 5h meter carries a burn arrow (usage ahead of / level with elapsed time, `↑` warn / `→` mute); optional extras (pending pacman updates, failed systemd units). The repo also holds Claude Code mods (`plugins/*/hooks/register.tsx`) but those are not the status line.
10. Customisation: env `CLAUDE_STATUSLINE_PALETTE`, `CLAUDE_STATUSLINE_ICONS`, `CLAUDE_STATUSLINE_EXTRAS`; edit the script.

## je4yfc/claude-catppuccin
https://github.com/je4yfc/claude-catppuccin — stars 0
1. By position slot, with state overrides. `statusline.sh` L12-24 defines six pill colours (blue, green, yellow, mauve, teal, peach) then assigns by slot: model = blue, git = green (yellow when staged or modified > 0), context+cost+duration = mauve, output style = teal (hidden when "default"), agent = peach, vim mode = green (yellow in NORMAL). Fixed per segment; git and vim change by state.
2. Themes: one hard-coded Catppuccin Mocha palette in the script (e.g. blue 137,180,250; mauve 203,166,247). The repo also ships `themes/catppuccin-mocha.json`, a Claude Code `/theme` custom-theme file (keys like autoAccept, claude, permission, error, warning, plus `*Shimmer` variants), which themes Claude Code itself, not the status line.
3. Colour spec: truecolor (`38;2`/`48;2`). No detection, no NO_COLOR.
4. Fill: background-filled pills with dark text (`FG_BASE` 30,30,46) in bold. Context bar is drawn in dark text with a dim overlay0 empty portion (`━` filled / `─` empty).
5. Separators: powerline arrow U+E0B0 between pills with fg = previous bg and bg = next bg (L96-132), left rounded cap U+E0B6 at the start and right rounded cap U+E0B4 at the end (cap colour tracks `LAST_FG`).
6. Neighbours: different pastel hue per slot (blue, green/yellow, mauve, teal, peach) plus arrow transitions.
7. Light/dark: dark base text (#1e1e2e) on pastel pills; no adaptation to terminal background.
8. Glyphs: Nerd Font required (microchip, branch, robot, powerline).
9. Other: gist-derived (credits tjhanley gist); the `rainbow`/`shimmer` hits are theme-JSON key names, not status-line animation.
10. Customisation: edit the shell script. JSON theme installed separately for Claude Code.

## jemings/skill
https://github.com/jemings/skill — stars 0
1. Fixed per segment with a threshold on the session segment. `plugins/statusline-kit/.../statusline-command.sh` L102-160: model bold green, cwd bold cyan, branch yellow in dim parentheses, context segment sky blue `38;5;39` (256-colour), 5h session `5h:NN%` coloured by threshold (>=80 red, >=50 yellow, else green) with a reset-time prefix. Per-session token segment from `statusline-tokens.sh`.
2. Themes: not present.
3. Colour spec: ANSI 16 plus one 256-index (`38;5;39`). No detection; NO_COLOR not found.
4. Fill: foreground only.
5. Separators: single space (comment: colours separate regions so no `|`); `(branch)` in dim parens.
6. Neighbours: different hues per segment.
7. Light/dark: not present, but the context colour was chosen for colour-blind safety (comment L108-110): magenta was dropped because it greys out under red-green colour-vision deficiency; sky blue chosen from the daltonized axis (blue/orange); no bold on it.
8. Glyphs: none beyond text; no emoji in the output.
9. Other: colour-blind-aware colour choice; `agent-dispatch`/`agent-update` plugins in the repo are not statusline.
10. Customisation: edit the script; `install.sh` plus a test installer.

## jeongseokjin/claudecode-hub-ko
https://github.com/Jeongseokjin/claudecode-hub-ko — stars 0
1. Delegated to ccstatusline (a third-party renderer). `statusline/statusline.sh` only runs the global `ccstatusline` bundle, passing COLUMNS minus 4. The styling is ten locale JSON files (`statusline/locales/*.json`, ccstatusline settings v4). In `en.json`, per widget fixed hex colours: labels/text `#8BE9FD`, brackets/separators `#6272A4`, model `#50FA7B` bold, git-root-dir `#FFB86C`, git-branch `#FF79C6`, context-percentage `#39FF14`, session-usage `#FF4FD8`, weekly-usage `#00E5FF`, fable-weekly `#FFE600`, git-pr `#82AAFF`, git-ci-status `#5AF78E`, cache hit/read/write/ttl `#C792EA` (a Dracula-like palette).
2. Themes: one palette, replicated across 10 locale files that differ in label language only (de, en, es, fr, ja, ko, pt-BR, ru, zh-Hans, zh-Hant). ccstatusline's own theme system is unused here.
3. Colour spec: `hex:RRGGBB` strings; `colorLevel: 3` (truecolor) in the settings. Downsampling and NO_COLOR are ccstatusline's business (unverified here).
4. Fill: foreground only (no `backgroundColor` set).
5. Separators: `custom-text` widgets that spell `│` and brackets in the muted `#6272A4`; powerline disabled (`powerline.enabled:false`).
6. Neighbours: distinct hex per widget plus text separators.
7. Light/dark: not present (neon hex values fixed).
8. Glyphs: plain Unicode `│`; labels in the locale language.
9. Other: wrapper script strips `NODE_OPTIONS` so a stale preload cannot break the bar; also tees the payload to an Orca app hook.
10. Customisation: the settings JSON (ccstatusline v4 schema), `install.sh`.

## jesserweigel/repo-pet
https://github.com/JesseRWeigel/repo-pet — stars 0
1. By state: one colour per pet mood. `repo-pet` L32-62: `MOODS` table maps each of 18 moods to a colour, and `COLORS` maps names to codes (red 31, green 32, yellow 33, "blue" is actually cyan 36, dim 2). E.g. conflicted/tangled/dizzy/sick/glum/anxious red, buried/hoarding/nervous/working yellow, ecstatic/fed/content green, adrift/curious/eager cyan, newborn/sleepy dim. The whole face (and optional label) is one colour.
2. Themes: not present.
3. Colour spec: ANSI 16 only. NO_COLOR honoured (`want_color` L529); `--color always|never|auto` (auto = stdout is a TTY), `--no-color`, `REPO_PET_COLOR` env to force on.
4. Fill: foreground only.
5. Separators: not present; it is a single face segment.
6. Neighbours: not applicable (single segment).
7. Light/dark: not present; the header comment says faces avoid glyphs missing in common fonts and are single width.
8. Glyphs: Latin-1/Greek kaomoji faces, `--ascii` fallback with pure ASCII faces (`(^ω^)` vs `(^o^)`).
9. Other: the point is mood from git state (rebase in progress, unmerged paths, stash count, unpushed commits, age of last commit).
10. Customisation: CLI flags only (`--ascii`, `--color`, `--label`, `--no-color`); env `REPO_PET_COLOR`.

## jeziellopes/claude-stats
https://github.com/jeziellopes/claude-stats — stars 0
1. Mixed: fixed per segment, thresholds on bars, a hash-based pick for the profile badge. `statusline-command.sh` L59-69 defines nine truecolor swatches (blue 97,175,239; amber 229,192,123; cyan 86,182,194; green 80,200,120; orange 255,176,85; yellow 230,200,0; red 235,87,87; magenta 198,120,221; dim). Model: amber for Opus, cyan for Haiku, blue otherwise (L255-258). Effort: low dim, medium cyan, high orange, xhigh/max red. Git branch magenta; `✓` green; staged `+` green; modified `~` yellow; untracked `?` dim; unpushed `⇡` orange; unpulled `⇣` cyan. Context bar: cyan <50, orange >=50, red >=80. 5h bar: cyan, yellow >=50, red >=80. Cache hit: green >=80, cyan >=50, else orange. Budget: cyan/yellow/red at 50/80. Reset-pace colour: green/orange/red by ratio (33/66). Profile badge colour is picked from a 6-colour palette by `cksum` of the profile name (L246-251), so each profile is stable and distinct.
2. Themes: not present (one hard-coded palette).
3. Colour spec: truecolor `38;2` only. No detection or NO_COLOR.
4. Fill: foreground only.
5. Separators: `sep=" ${dim}│${reset} "` (dim bar); a dim `───` rule under the block.
6. Neighbours: different hues per segment plus the dim separator.
7. Light/dark: not present.
8. Glyphs: `⎇ ✓ ⇡ ⇣ ⏰` and bar `[████░░░░]`; emoji in a few spots; no Nerd Font.
9. Other: multi-line layout (identity, 5h, 7d, cache, budget, info), stores sessions in SQLite (`statusline-db.sh`).
10. Customisation: edit script; `install.sh` / `install.ps1`; `preview.sh`.

## jfcarpiopuntocom/claude-mascotas
https://github.com/jfcarpiopuntocom/claude-mascotas — stars 0
1. By state: whole pet line coloured by pet state. `plugin/mascota.js` L151: calm 36 (cyan), working 33 (yellow), agents 35 (magenta), error 31 (red), sleeping 90 (bright black). Extra agent names magenta (35).
2. Themes: none; "creatures" (e.g. `gata`) change the ASCII art, not colour. `lang` selects messages.
3. Colour spec: ANSI 16 SGR codes. A `color` boolean in config turns all colour off. NO_COLOR not read (grep found none).
4. Fill: foreground only.
5. Separators: two spaces between pet and agent names; `+n` overflow counter.
6. Neighbours: single colour per line; agent list magenta.
7. Light/dark: not present.
8. Glyphs: ASCII/kaomoji frames alternating by second; width measured with wide-character awareness and cut with an ellipsis.
9. Other: animation (2 frames, by wall-clock second), can chain a second statusLine (e.g. claude-hud) and put the pet under it.
10. Customisation: `mascota.config.json` defaults merged with a user `config.json` and env `MASCOTAS_CONFIG`; keys `creature, lang, color, maxAgents, maxWidth, chain, thresholds`.

## jfcarpiopuntocom/claude-pets
https://github.com/jfcarpiopuntocom/claude-pets — stars 0
1. By state, identical to claude-mascotas: `plugin/pet.js` L151 uses the same `{ calm:36, working:33, agents:35, error:31, sleeping:90 }` map, agent names 35.
2. Themes: not present (creatures only).
3. Colour spec: ANSI 16; `cfg.color` boolean toggles; NO_COLOR not read.
4. Fill: foreground only.
5. Separators: spaces and `+n`.
6. Neighbours: not applicable.
7. Light/dark: not present.
8. Glyphs: ASCII pets with 2-frame animation.
9. Other: English-language twin of claude-mascotas (same structure, `pick.js`, `gallery.js`).
10. Customisation: JSON config file merged over defaults.

## jgoneit/claude-statusline
https://github.com/jgoneit/claude-statusline — stars 0
1. Mixed: a 10-stop gradient indexed by percentage for gauges, plus fixed accent roles. `statusline.sh` L99-117: `bar()` colours each cell with its own gradient stop `SUNSET[i]` (filled cells full colour, empty cells the same stop dimmed `░`), half-cell resolution via `▌`. The percentage text takes the stop at `pct*10/100` (L155). Accents come from the theme: `C_MODEL` (model), `C_DIR`, `C_GIT` (branch, ahead `↑`), `C_STAGE` (staged `+`, cost), `C_MOD` (modified `~`, behind `↓`), `C_MUTE` (labels, time). Effort name colour rises with intensity: low mute, medium dir, high stage, xhigh/max mod (L196-206).
2. Themes: 2 directories, `themes/summer` (implemented sunset palette, teal→gold→coral→red) and `themes/christmas` (scaffold with empty values; an empty theme renders uncoloured rather than erroring). A theme is colour-only: `SUNSET` array plus six `C_*` vars for each of two depths. `STATUSLINE_THEME` picks; users add a `themes/<name>/colors.sh`.
3. Colour spec: both truecolor (`38;2;r;g;b`) and hand-picked 256 indices per theme, "no auto-conversion, so no banding". Depth detection: `STATUSLINE_COLOR=truecolor|256`, else `COLORTERM` contains truecolor/24bit, or `TERM` contains "direct", else 256 (L34-44). NO_COLOR not found.
4. Fill: foreground only (block-character bar, not background cells).
5. Separators: dim `·` between row parts; no powerline.
6. Neighbours: colour roles per item, spacing, and dim `·`.
7. Light/dark: not present.
8. Glyphs: no emoji or Nerd Font ("the look is carried by COLOR, not emoji"); `⧗` for time; bar `█▌░`.
9. Other: gradient gauge reused for context and the 5h/7d limits so all gauges share one visual language; screenshot helper with a demo percentage.
10. Customisation: env `STATUSLINE_THEME`, `STATUSLINE_COLOR`, demo pct var; theme shell files; `install.sh`.

## jhonrak1/claude-status-line
https://github.com/Jhonrak1/claude-status-line — stars 0
1. By position slot (a background per section). `src/statusline.js` L7-14: each theme has `fg`, `dot`, `model`, `cost`, `bar`, `date` colour numbers, and sections are model, cost, context bar, date, each with its own bg. Model dot is a separate accent. No state/threshold colouring (context bar colour is the fixed `bar` bg).
2. Themes: 5 bundled in the `THEMES` object (default, ocean, forest, mono, light), chosen with `--theme <name>`. Format is a flat per-slot map of 256-colour indexes (not semantic roles). Users cannot define their own without editing the file.
3. Colour spec: 256 index only (`38;5;N;48;5;N`). No depth detection. NO_COLOR honoured: if the env var exists, colour is dropped and sections become `[text]` brackets (L2-5).
4. Fill: background-filled sections with a space of padding either side, light text on dark backgrounds.
5. Separators: single space between sections; no arrows.
6. Neighbours: a different background hue per section (e.g. default: blue 24, green 22, purple 54, brown 130); `mono` uses four grey steps (236, 238, 240, 242), i.e. a lightness ramp.
7. Light/dark: a `light` theme with dark text (fg 16) on pastel backgrounds (153, 157, 183, 223); manual choice only.
8. Glyphs: emoji (💰 🗓️), `●` model dot, `█░` bar.
9. Other: model label appends context window size ("1M context") when the name lacks it. Plain-text fallback `claude` on bad input.
10. Customisation: CLI flag `--theme`; `bin/cli.js` installer; no config file.

## jimismith/oh-my-claude
https://github.com/JimiSmith/oh-my-claude — stars 0
1. Delegated to oh-my-posh: the statusLine command is `oh-my-posh claude --config <install>/claude-native.omp.json`. Styling lives in `src/claude-native.omp.json`. Row 1: path = blue bg / gray text; git = gray bg with `background_templates` switching to palette colours by state (dirty `#ff9248`, diverged `#f26d50`, ahead `#89d1dc`, behind `#f17c37`), fg flipping gray/blue accordingly. Row 2 (claude): model teal bg + lime text, context lime bg + teal text, 5h teal/lime, 7d lime/teal; the 5h and 7d segments switch bg to `warning` `#ff8d0a` when usage > 90.
2. Themes: a single bundled omp theme with a named `palette` (teal #003543, blue #0087d8, lime #d2ff5e, orange, gray #242424, dirty, ahead, behind, diverged, warning); segments refer to `p:<name>`. Users can swap in any oh-my-posh theme.
3. Colour spec: hex palette entries (truecolor); oh-my-posh handles depth (not verified here). NO_COLOR not verified.
4. Fill: background-filled powerline segments.
5. Separators: powerline arrow U+E0B0 (`powerline_symbol`), leading rounded cap U+E0B6 on the first segment of a row; oh-my-posh derives the arrow colours from adjacent segment backgrounds.
6. Neighbours: ALTERNATING TWO SHADES. Row 2 alternates teal-on-lime / lime-on-teal with inverted fg/bg each segment, so every neighbour pair is a colour swap; plus arrows.
7. Light/dark: text colour is the inverse palette colour, hand-assigned; no contrast calculation.
8. Glyphs: Nerd Font icons (folder, git upstream icon, brain, clock); no fallback.
9. Other: uses a dedicated `claude` segment type from oh-my-posh (`.Model.DisplayName`, `.TokenUsagePercent`, `.FiveHourUsage`...).
10. Customisation: edit the omp JSON (any oh-my-posh option); `install.sh`/`install.ps1` and local installers; `bump-version.sh`.

## jimjkelly/claude-statusline
https://github.com/jimjkelly/claude-statusline — stars 0
1. By state/threshold, bars only; all other text uses the terminal's default colour. `src/render.rs`: 5h, 7d and context bars take `color::threshold(pct, 60, 85)` = green <60, yellow <85, red else (`src/color.rs`). The pace pendulum is green if ahead of pace (delta <0), yellow <10, red otherwise (L107-115). Cost is default colour, yellow >$10, red >$50 (L124-131). Model name, branch, directory: uncoloured.
2. Themes: `Theme` is `Plain | Nerd` (labels vs glyphs), `src/theme.rs`; not colour themes. No user-defined colours.
3. Colour spec: ANSI 8-colour codes (31/32/33) and dim (`\x1b[2m`), "so they render correctly even on terminals without 256-colour support" (comment, `color.rs`). NO_COLOR honoured plus `--no-color` flag (`enabled()`; empty NO_COLOR does not disable).
4. Fill: foreground only.
5. Separators: ` · ` plain text.
6. Neighbours: separators only.
7. Light/dark: not present beyond using only the base 8 colours.
8. Glyphs: `--nerd` flag swaps labels (`Sess/Week/Ctx/Pace`) for Nerd Font icons (stopwatch, calendar, microchip, line chart, folder, branch, clock); plain text default.
9. Other: a "pendulum" pace bar and responsive truncation by column width (`line_one_short` uses a 4-cell bar).
10. Customisation: CLI flags `--nerd`, `--no-color` (`src/cli.rs`); env `NO_COLOR`. No config file seen.

## jinhuang712/claude-super-statusline
https://github.com/jinhuang712/claude-super-statusline — stars 0
1. By theme role (semantic tokens), plus state/gradient for percentages. `src/core/theme.ts` token set: `fg, muted, accent, ok, warn, crit, model, project, git, usage, context`. Widgets name tokens, e.g. model badge `fg:"model"` and effort `fg:"model"`, separators/labels `fg:"muted"` (`src/widgets/model.ts` L78/95/109; separator styled `fg:"muted"` in `layout.ts` L122). Percentage widgets: `level(pct, warnAt=70, critAt=85)` gives `ok`/`warn`/`crit` tokens (`api.ts` L32); a global `colorMode` of `thresholds` (default) or `gradient` (continuous hex from 7 stops, `GRADIENT` in `api.ts` L47-55: #8a8a8a at 0, #3d8fe0 10, #2f9e44 30, #a8840a 50, #e2680c 70, #e03131 90, #c92a2a 100; linear RGB interpolation).
2. Themes: 7 bundled in `THEMES`: default, nord, dracula, gruvbox, tokyo-night, catppuccin, mono. Format is a semantic token map (11 tokens) plus bar glyphs; a user passes a full `ThemeDef` or partial tokens merged over the default (`resolveTheme`). Tokens may reference other tokens (aliasing, depth-limited to 4).
3. Colour spec: token names, 16-colour names, 0-255 index, or hex. Output downgraded by `ColorLevel` `auto|truecolor|256|16|none` (`src/core/ansi.ts`): `detectColorLevel` checks NO_COLOR (empty ignored), FORCE_COLOR=0, COLORTERM truecolor/24bit, TERM 256color. `rgbTo256` and `rgbTo16` convert down. NO_COLOR honoured.
4. Fill: foreground only by design. The `bg` style field exists but themes never paint a background: comment in `theme.ts` says the status line "never paints its own background".
5. Separators: configurable string (`separator` default ` │ `), per-line override, always coloured `muted`. No powerline.
6. Neighbours: different token hues (model cyan, project yellow, git magenta, usage bright blue, context green in the default theme) plus muted separators.
7. Light/dark: explicit. `fg` is `"default"` in every theme so plain values use the terminal's own foreground (hard-coded white vanished on light terminals). Gradient stops are all mid-tones kept >= 3:1 against white, #141413 and black, checked by `tests/gradient.test.ts` (comment `api.ts` L39-46). The `mono` theme uses terminal fg everywhere and `#`/`-` bar.
8. Glyphs: bar glyph pair per theme (`█░`, mono `#-`); effort symbols (`◕`); OSC 8 links.
9. Other: a web configurator (`web/`, Vite + Zustand, served locally on 127.0.0.1:4877) with a live preview and a separate "terminal background" light/dark toggle for the preview; landing site (`site/`); also ships as a mod (`hooks/register.tsx`) and `scripts/super-statusline.sh`. Layout with left/center/right zones.
10. Customisation: three-layer config (defaults, user file, project file) as JSON; web UI; CLI (`src/cli/main.ts`); widget plugin API (`examples/widgets/hello.ts`, `defineWidget` with JSON-schema options).

## jitender-saini/claude-code
https://github.com/jitender-saini/claude-code — stars 0
1. Fixed per segment, threshold on context. `statusline/statusline-command.sh` L72-143: model yellow (`\033[33m`) with 🤖, context bar green <50, yellow >=50, red >=80 (plus ⚠️), tokens in/out cyan, branch magenta with 🌿, lines `+` green `-` red, project dir blue with 📁, cost green, session duration white (37), API duration cyan.
2. Themes: not present. (`statusline-command_jq.sh` is a jq variant of the same.)
3. Colour spec: ANSI 16 only. No detection or NO_COLOR.
4. Fill: foreground only.
5. Separators: dim bullet ` • ` (`\033[2m`, L151).
6. Neighbours: different hue per segment plus dim bullet.
7. Light/dark: not present.
8. Glyphs: heavy emoji (🤖 🌿 📝 📁 ⏱️ ⏳); `█░` 12-cell bar.
9. Other: none notable.
10. Customisation: edit the script; `install.sh`.

## jiwoong-choi/claude-code-gauge
https://github.com/jiwoong-choi/claude-code-gauge — stars 0
1. By state/threshold on three bars. `plugins/statusline-usage-bars/bin/statusline.sh` `draw_bar` L110-147: green <50, yellow <80, red >=80 on `[██░░]` plus percentage; the label (`Ctx:`, `5h:`, `7d:`) is bold in the terminal colour, suffix text dim. Trailing `model · effort:x` dim. Same threshold for all three bars.
2. Themes: not present.
3. Colour spec: ANSI 16 (32/33/31), bold, dim. No detection or NO_COLOR.
4. Fill: foreground only.
5. Separators: plain ` | ` between bars, dim before the model tail.
6. Neighbours: labels and separators only (all bars share the same colour logic).
7. Light/dark: not present.
8. Glyphs: `█░` bars in brackets, ASCII otherwise.
9. Other: shipped as a Claude Code plugin with a `SessionStart` hook that installs the statusLine setting; parses JSON with jq or python3.
10. Customisation: edit the script (`BAR_WIDTH=10`); plugin install.

## jkubo/context-gauge
https://github.com/jkubo/context-gauge — stars 0
1. By state (five bands) only. `context_gauge.py` L149-153 and `hooks/register.tsx` L35-41: GREEN `\033[32m`, YELLOW `33`, ORANGE `38;5;208` (mod: `#ff8700`), RED `1;31` bold, BLACK `1;97;41` (bold bright-white on red bg). The band is picked from the "reasoning working set" token count (absolute ceilings, or ratio ceilings when the window is known, `BANDS` L132-139); the colour applies to the whole `⛽ 🟢 GREEN 85k` segment and the "NN% of 1M" text.
2. Themes: not present. Band thresholds are configurable ceilings (memento-style `active_ceilings`).
3. Colour spec: ANSI 16 plus one 256 index in the CLI (`208`), hex `#ff8700` in the mod; no detection, NO_COLOR not found.
4. Fill: foreground only, except BLACK band which uses a red background for emphasis.
5. Separators: dim ` · ` (`SEP`, `gauge.ts` L346).
6. Neighbours: single-segment widget; not applicable.
7. Light/dark: not present.
8. Glyphs: emoji for each band (🟢🟡🟠🔴⚫) and `⛽`. It is a statusline command AND an Ink-based Claude Code mod (`hooks/register.tsx` uses `TextProps` color names, `TONES` map).
9. Other: wording is deliberately descriptive only (never imperative) to avoid steering the agent; parity tests keep the Python and TypeScript copies aligned (`hooks/parity.ts`).
10. Customisation: env/config for ceilings, Python CLI (`context-gauge`, `claude-context-gauge`), `install.sh`, `pyproject.toml`.

## jnapper7/show-model-context
https://github.com/jnapper7/show-model-context — stars 0
1. By category (the bar is segmented by what filled the context), not by segment slot. `src/show_model_context/config.py` L15-43 defaults: system `bright_black` (system reminders/CLAUDE.md), files `blue` (Read/Write/Edit), tools `yellow` (Bash/Glob/Grep/WebFetch/WebSearch), skills `magenta` (Task/Skill), claude `green` (assistant text/thinking); empty portion `bright_black`. Each category's cell count is proportional to its tokens. Each category has a configurable `color`, `label`, `match_tools`, `match_type`, `content_contains`.
2. Themes: not present; categories are user-defined in TOML with a colour each.
3. Colour spec: 16 named ANSI colours incl. bright variants plus `dim` (`COLOR_CODES` in `renderer.py`); unknown name leaves text uncoloured. No detection or NO_COLOR.
4. Fill: foreground-only glyph bar (`█` filled, `░` empty by default).
5. Separators: none inside the bar; label separated by a space; label left or right (`label_position`).
6. Neighbours: adjacent bar runs are distinct hues per category.
7. Light/dark: not present.
8. Glyphs: configurable `filled_char`/`empty_char`; auto bar width from terminal columns (`bar_width` 0).
9. Other: `mode` total (100% = window) vs current (100% = tokens used); label formats (e.g. ratio).
10. Customisation: TOML `~/.config/show-model-context/config.toml` (general + `[[categories]]`), Python package CLI.

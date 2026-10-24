# Batch 31 - 25 gists (all bash/node/python scripts read from gist raw files)

Common to nearly all: foreground-only text on the terminal's own background, no separators other than a plain `|`, no themes. Exceptions are called out.

## BastienTeissier/7301398063b4f6245e12e84fda957a9f
https://gist.github.com/BastienTeissier/7301398063b4f6245e12e84fda957a9f - stars n/a
1. Fixed per segment plus threshold: `statusline.sh` model line is CYAN `\033[36m`; `+lines` GREEN, `-lines` RED, cost YELLOW, session id DIM. Bars (`render_window`) go by state: >=90 RED, >=70 YELLOW, else GREEN, applied to ctx, 5h and 7d bars alike.
2. Themes: not present. Colours are hard-coded vars on one line (`CYAN GREEN YELLOW RED DIM`).
3. ANSI 16 only (`\033[3Xm`, `\033[2m`). No depth detection, no NO_COLOR.
4. Foreground only.
5. Plain ` | ` text separator, uncoloured.
6. Neighbours: only the `|`; line 1 model cyan, line 2 dim/green/red/yellow runs.
7. Light/dark: not present.
8. Emoji (`📁 🌿 🆔 ⏱️`), block bar `█░`. No ASCII mode.
9. Three-line layout; model/dir/branch, id/diff/cost/time, then three bars.
10. Edit the script; no flags or env.

## AvasDream/73617886e42e4b8074f1456c3f0b7d22
https://gist.github.com/AvasDream/73617886e42e4b8074f1456c3f0b7d22 - stars n/a
1. By state, context only: `claude.md` script maps used% in 20% steps to GREEN `0;32`, LIGHT_GREEN `0;92`, YELLOW `0;33`, ORANGE `38;5;208`, RED `0;31` (only the `used/total (pct%)` text is coloured). Model, cost, git branch, venv are uncoloured.
2. Themes: not present.
3. ANSI 16 plus one 256 index (orange 208). No detection, no NO_COLOR.
4. Foreground only.
5. Plain ` | `, uncoloured.
6. Neighbours: only the `|`.
7. not present.
8. No glyphs beyond text labels `git:` `venv:`.
9. Five-step context ramp is the only styling feature.
10. Edit script; settings.json wiring only.

## davidamo9/764415aff29959de21f044dbbfd00cd9
https://gist.github.com/davidamo9/764415aff29959de21f044dbbfd00cd9 - stars n/a
1. By state: `statusline.sh` colours the 10-cell bar and pct text GREEN `\033[32m` (<50), YELLOW `\033[33m` (50-79), RED `\033[31m` (>=80). Model badge `[op]/[so]/[ha]`, cost, git branch are uncoloured.
2. not present.
3. ANSI 16. No detection, no NO_COLOR.
4. Foreground only.
5. Plain ` | `.
6. Only the `|`.
7. not present.
8. `█░` bar; `*` dirty mark. Text model abbreviations.
9. README documents the 50/80 thresholds.
10. Edit script.

## jourheighness/7a7f7ba1be835000f3cd37792a0738e9
https://gist.github.com/jourheighness/7a7f7ba1be835000f3cd37792a0738e9 - stars n/a ("themeup" installer that writes a Ghostty config and a statusline)
1. Fixed per segment with a semantic role name, plus state. Embedded statusline (`themeup:118-132`): folder `C_TEXT` bold (205,214,244); model `C_MAUVE` (203,166,247); separators `C_OVR0` (108,112,134); effort glyphs `C_PEACH` filled / `C_OVR0` empty; token count `C_OVR0`; focus text `C_SUB`. Context bar and pct: `CTX_C` = `C_RED` >=80, `C_YELLOW` >=60, else `C_GREEN`, empty cells `C_SURF0`. "Clarity" label stepped TEAL/GREEN/YELLOW/RED/RED/DIM_RED by score (`themeup:293-307`).
2. One bundled palette, Catppuccin Mocha, as named bash constants with palette-role comments (Mauve, Sky, Blue, Surface0, Overlay0, Peach, Subtext). Not user-definable except by editing; Ghostty config `theme = Catppuccin Mocha` is written alongside.
3. Truecolor `38;2;r;g;b` throughout, ANSI 16 only in the installer's own messages. No detection, no downsampling, no NO_COLOR.
4. Foreground only.
5. `SEP="${C_OVR0} | "` (`themeup:133`), a dim role-coloured pipe.
6. Neighbours: different roles (mauve model vs white folder vs blue/green/yellow/red bar) and the dim pipe.
7. Assumes a dark terminal (it sets Ghostty to Mocha); no adaptation.
8. Unicode geometric glyphs `▣ ◆ ◈ ○ ◇ ▲ △ ◌ ⊗`, bar `█▒`; model glyph per family (Opus ◆, Sonnet ◈, Haiku ○). No Nerd Font.
9. Clarity score computed from a rolling buffer; focus text parsed from transcript; model glyph by family.
10. Edit script; installer `themeup` has only `--help/--version`.

## shaharid/8289209264a3fb7ecd03c54ffc792014
https://gist.github.com/shaharid/8289209264a3fb7ecd03c54ffc792014 - stars n/a
1. Fixed per segment plus a threshold on one: `statusline-command.sh:95-112` session name blue `34`, dir+branch cyan `36`, model green `32`, output style yellow `33`; ctx-free % is RED `31` (<20), YELLOW `33` (<50), MAGENTA `35` otherwise; cost yellow `33` with dim `(+last)` `\033[2m`.
2. not present.
3. ANSI 16 plus dim. No detection, no NO_COLOR.
4. Foreground only.
5. Plain ` | `, uncoloured.
6. Different hue per segment (blue, cyan, green, yellow, magenta) plus `|`.
7. not present.
8. `¢` cost formatting, no icons.
9. Cost computed from transcript with per-model pricing; not styling.
10. Edit script.

## verehfy/84ff8fc1674df0cc0a354e2e9c881a73
https://gist.github.com/verehfy/84ff8fc1674df0cc0a354e2e9c881a73 - stars n/a
1. Fixed plus threshold (`statusline-command.sh`): `user@host` cyan `36`, cwd blue `34`, session name magenta `35`, model bright-black `90`, worktree branch yellow `33`, "left" % cyan; `usage_bar()` GREEN <50 / YELLOW <80 / RED for context, 5h and 7d; vim INSERT green, NORMAL yellow.
2. not present.
3. ANSI 16 incl. bright-black. No detection, no NO_COLOR.
4. Foreground only.
5. `sep` = ` \033[90m|\033[0m ` dim grey pipe (script, "Join with a dim separator").
6. Different hue per segment plus dim pipe.
7. Uses `90` grey for muted text; no adaptation.
8. `█░` 8-cell bar. No emoji. Comment says cross-platform (Git Bash/WSL).
9. none.
10. Edit script; settings.json only wires the command.

## jakewg-victra/86f698886b519b4e111a0b6547e319eb
https://gist.github.com/jakewg-victra/86f698886b519b4e111a0b6547e319eb - stars n/a. Windows fork of benabraham/claude-code-status-line (python); fork-level differences listed in `INSTALL.md`, but the styling surface below is the script's.
1. By state and fixed by role, all from a theme dict (`THEMES`, py:205+): model badge is a filled cell chosen by model name (`get_model_colors`, py:497): Sonnet bg `#A3BE8C` / fg `#2E3440`, Opus bg `#88C0D0`, Haiku bg `#4C566A` / fg `#ECEFF4`, default bg `#D8DEE9`. Text roles: percent and numbers `#5E81AC`, cwd `#81A1C1`, git and worktree `#B48EAD`, n/a `#D08770`, added-dirs `#4C566A`. Progress bar fill is a 10-step gradient keyed on pct (`gradient`, dark green `#183522` to red `#B30000`, `get_colors_for_percentage` py:488). Usage gauges colour by burn ratio: `usage_light/green` `#A3BE8C`, `usage_yellow` `#EBCB8B`, `usage_red` `#BF616A` (py:1123-1135).
2. Two bundled themes, `dark` (Nord) and `light` (muted/darker variants, white text on model badges, `bar_empty` `#D8DEE9`), chosen by `SL_THEME`. User themes: `~/.claude/claude-code-theme.toml` (`SL_THEME_FILE`) merged over the selected base per key (`_load_custom_theme`, py:283-390, keys `model_*` as `[bg, fg]`, `bar_empty`, `usage_*`, `text_*`, `gradient` as `{threshold, color}`). Semantic role keys, not per segment.
3. Every colour is a `(hex, 256-fallback)` pair (py:204 comment). `supports_truecolor()` (py:399) reads `COLORTERM` in `truecolor|24bit`, on Windows `WT_SESSION`, `ConEmuANSI`, or `TERM_PROGRAM` vscode; otherwise emits the 256 index. NO_COLOR not present.
4. Both: model badge is bg-filled and bold; bar uses fg+bg trick (empty cells bg `bar_empty`, partial cell uses `▏▎▍▌▋▊▉█` `BLOCKS` py:1741); text segments fg-only.
5. Plain text: added-dirs separator ` • ` configurable (py:90); segments otherwise spaced.
6. Neighbours: text hue per role (blue percent, steel cwd, purple git) and one filled badge.
7. Yes: explicit `light` theme with darker usage colours and white-on-colour badges; choice is manual via `SL_THEME`, not detected. Badge fg picked per theme by hand.
8. Block/partial-block bars, vertical gauge `▁▂▃▄▅▆▇█` (py:1141) for 5h/7d (`gauge=vertical`); no Nerd Font.
9. Sub-cell-precision progress bar and a ratio-based burn gauge with top-fill illusion; `--demo`-style table of gauge states printed at py:1857-1925.
10. Env vars `SL_THEME`, `SL_THEME_FILE`, `SL_SEGMENTS='model progress_bar ... usage_5hour:gauge=vertical'` with per-segment `:opt=val` options; TOML theme file.

## MetalArend/90788ef3ce05236aba635f5f46fcbc49
https://gist.github.com/MetalArend/90788ef3ce05236aba635f5f46fcbc49 - stars n/a
1. By role: `config.theme` (statusline.js:54-66) maps roles to escapes: `path` blue `34`, `git` magenta `35`, `accent` cyan `36` (model, bold; `plan` mode), `good` green, `warning` yellow, `caution` `38;5;208`, `critical` red, `alert` `5;31` blinking red, `secondary` bright-black `90`, `dim`, `bold`. Segments: directory=path, git branch=git, model=accent, permission mode: bypass=critical, auto-edit=warning, plan=accent; bars and cache % use good/warning/caution/critical via `barColorThresholds` `[50,65,80]` (README); cache efficiency green >=80 / yellow >=50 / secondary; `+N` good, `-N` critical.
2. Single role-based theme (a role to escape-sequence table). User override: `statusLine.theme` object in settings.json, merged key by key, only known keys accepted (statusline.js:104-109).
3. ANSI 16 plus 256 index 208 for caution. User values are raw escape strings so truecolor is possible by hand. No detection, no NO_COLOR.
4. Foreground only.
5. `segmentSeparator` default `' | '` and `groupSeparator` `' · '` (README lines 168-190), both configurable; not coloured.
6. Segment hues by role, separators.
7. `secondary` grey for muted; no adaptation.
8. Text labels table `config.labels` (`⏱`, `↑↓`, `↺`), blocks `█░`; reserved auto-compact buffer drawn in grey `░`.
9. Blinking red (`5;31`) context bar when total usage > `contextBlinkThreshold` 95; two-percentage bar (usable vs total).
10. Config object at top of script, overridable from settings.json `statusLine` (documented list), `segmentOrder` arrays for grouping.

## remerle/9464a36eab3c9fb55975b96f1fda44b3
https://gist.github.com/remerle/9464a36eab3c9fb55975b96f1fda44b3 - stars n/a. Named "powerline" but contains no powerline separators.
1. Fixed plus state (`statusline-powerline.sh:11-24`): model `C_MODEL` `38;5;141` purple; path `C_PATH` `75` steel blue; branch `C_BRANCH` `77` green clean / `C_DIRTY` `214` orange when dirty; sync arrows `117`; counts `255` bold; lines `+` `77` and `-` `196`. Context bar GREEN `77` (>50% remaining), YELLOW `226` (>30), ORANGE `214` (>15), RED `196`; pct text white `255` only in the green band, otherwise same colour as bar. Rate limits: green, yellow >50, orange >75, red >90.
2. not present; README says edit the constants to match your terminal theme.
3. 256-colour indices only (`38;5;N`). No detection, no NO_COLOR.
4. Foreground only.
5. `SEP="\033[90m│\033[0m"` dim vertical bar (line 4).
6. Different hue per segment and dim `│`.
7. Not present; README advises editing colours.
8. Nerd Font required: git branch icon `nf-md-source_branch` (U+F062C, line 3), `█░` bar of 20 cells. No fallback.
9. Context bar is measured against the autocompact threshold, not the raw window.
10. Edit constants; env `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`.

## mojo-codes/997596cc5f5f8b4a0184697b8afd641b
https://gist.github.com/mojo-codes/997596cc5f5f8b4a0184697b8afd641b - stars n/a (README in German)
1. Fixed plus state (`statusline-command.sh`): dir blue `34`, model yellow `33`; the 5h/7d limit text colours via `fmt_limit`: red `31` >80, yellow `33` >50, green `32`. Context bar uncoloured.
2. not present.
3. ANSI 16. No detection, no NO_COLOR.
4. Foreground only.
5. Two spaces.
6. Hue per segment only.
7. not present.
8. `█░` bar.
9. README steers users to let Claude generate the line with `/statusline` first.
10. Edit script.

## zurfyx/9ae0ffc3436ff7a08dcb97ff1df66bd9
https://gist.github.com/zurfyx/9ae0ffc3436ff7a08dcb97ff1df66bd9 - stars n/a. A dotfiles gist (gitconfig, zshrc, Ghostty, VS Code keybindings, Codex status_line, cmux.json); only `Claude statusline.sh` is a Claude statusline.
1. By state, plus dim: `Claude statusline.sh`: context bar and pct coloured `C` = RED `31` >=90, YELLOW `33` >=70, else GREEN `32`; quota % red >=90 / yellow >=70 / DIM `\033[2m` otherwise; directory and diff counts DIM. Model, branch, cost uncoloured.
2. not present (the Ghostty and Codex files in the gist are other tools' configs, unread).
3. ANSI 16 plus dim. No detection, no NO_COLOR.
4. Foreground only.
5. Plain ` | `, uncoloured.
6. Only the `|`.
7. not present.
8. `█░` 10 cells (comment about GNU `tr` mangling multibyte glyphs, a real portability trap); branch glyph is a private-use Nerd icon.
9. none.
10. Edit script.

## captivus/9ccd08b2760215e91b9c820c6d7bcde3
https://gist.github.com/captivus/9ccd08b2760215e91b9c820c6d7bcde3 - stars n/a
1. By state: the whole `ctx: N% used (M% remaining)` text is bold red `1;31` >=85, bold yellow `1;33` >=65, bold green `1;32`. Model and dir uncoloured.
2. not present.
3. ANSI 16 bold. No detection, no NO_COLOR.
4. Foreground only.
5. Two spaces.
6. Only spacing.
7. not present.
8. none.
9. Also writes pct to `/tmp/claude-context-percentage.txt` for Claude to read (not styling).
10. Edit script.

## rachelhung/9e39f4b5eb1f8fecb757fb65c9c54dee
https://gist.github.com/rachelhung/9e39f4b5eb1f8fecb757fb65c9c54dee - stars n/a
1. By state, bar only (`build_context_bar`): GREEN `32` <=40, YELLOW `33` <=70, ORANGE `38;5;208` <=85, RED `31`. Everything else (model, rate limits, git, session) uncoloured.
2. not present.
3. ANSI 16 plus 256 index 208. No detection, no NO_COLOR.
4. Foreground only.
5. Plain ` | `.
6. Only the `|`.
7. not present.
8. Dog emoji prefix; `█░` bar; `*` dirty mark.
9. none.
10. Edit script.

## gittyhubbyfrankybobby/a2257bb7c1039a8fdb0cc2f67851c1b9
https://gist.github.com/gittyhubbyfrankybobby/a2257bb7c1039a8fdb0cc2f67851c1b9 - stars n/a
1. Fixed plus state (`statusline-command.sh:15-21`): `[model · effort]` YELLOW `00;33`; session name line DIM `00;90`. Quota bars take a PACE colour: CYAN `00;36` on pace or no signal, GREEN `00;32` more than 2pp under pace, YEL_B `01;33` >2pp over, RED_B `01;31` >5pp over (colour is used% minus elapsed% of window). Context text cyan <150k tokens, bold yellow >=150k, bold red >=200k (absolute tokens, not %).
2. not present.
3. ANSI 16 (bold/dim variants). No detection, no NO_COLOR.
4. Foreground only.
5. Two spaces.
6. Whole-segment hue (yellow model, cyan/green/red quota) plus spacing.
7. not present.
8. `█░` with a `▏` pace tick overlaid on the cell where elapsed time lands (render_bar).
9. Pace-based colouring of rate limits is the distinctive idea: colour answers "ahead of or behind the window", not "how full".
10. Edit script; pure bash with no jq.

## AmanThuL/a312d37da54bcf46b764bb425bfe2164
https://gist.github.com/AmanThuL/a312d37da54bcf46b764bb425bfe2164 - stars n/a
1. Fixed per role plus severity (`statusline-command.sh:55-66`): named palette `teal #7fcbc4` (project and session names, bold), `green #a7c88c` (model, git clean, diff +), `purple #b9a0ed` (usage metrics and Context/Limits row labels), `gold #e3c98a` (git marks, >=70%), `red #f09193` (conflicts, diff -, >=90%), `dim #9eaba5` (labels, brackets), `empty #9eaba5` (bar tracks). `severity(pct, base='purple')` (line ~152): red >=90, gold >=70, else base. Each row label coloured by `row(..., label_color)`: Context and Limits purple, Model green, rest dim.
2. One fixed palette; no switch or override. README states it was contrast-checked (>4.5:1) against Everforest Dark `#272e33`.
3. Truecolor only: `paint()` emits `38;2;r;g;b`. `NO_COLOR` honoured, `TERM=dumb` also disables colour (line 55). No depth fallback.
4. Foreground only.
5. Two spaces between fields; labelled rows (`Project:` `Model:`); no pipe.
6. Hue per role, row labels, brackets `[ ]` around bars.
7. Contrast-aware by hand: palette chosen for a specific dark background; README notes Ghostty `minimum-contrast` can alter results. No runtime adaptation.
8. `█░`; `STATUSLINE_ASCII=1` switches to `# -` and `~`; no Nerd Font; width calc counts East Asian wide cells.
9. Five labelled rows with wrapping at `COLUMNS-4`; strips control characters from untrusted names.
10. Env: `STATUSLINE_ASCII`, `STATUSLINE_FULL_ID`, `STATUSLINE_WIDTH`, `STATUSLINE_GIT_TTL`, `STATUSLINE_CACHE_DIR`, `NO_COLOR`; `refreshInterval` in statusLine settings.

## keentechcodes/a5064efa9408e97362397e7942685bbf
https://gist.github.com/keentechcodes/a5064efa9408e97362397e7942685bbf - stars n/a. A dotfiles gist (tmux, zsh, bootstrap, starship, tokyonight); `.statusline-command.sh` is the Claude part and is described as mirroring the author's Starship theme.
1. Fixed plus threshold (`.statusline-command.sh`): hostname icon GREEN `(129,193,155)`; model PURPLE `(197,151,216)`; dir WHITE bold `(232,227,227)`; branch GREEN; ahead/behind arrows PURPLE; dirty dot YELLOW `(229,200,144)`; context pct GREEN <50, PURPLE 50-79, RED `(182,100,103)` >=80.
2. Palette is a Starship-matching set of five RGB constants; not switchable. Other gist files carry tokyonight and nightfox palettes for other tools.
3. Truecolor `38;2` only. No detection, no NO_COLOR.
4. Foreground only.
5. Two spaces.
6. Hue per role.
7. not present (tuned for the author's dark terminal).
8. Nerd Font icons (hostname glyph U+F0 5CD, branch glyph) with no fallback.
9. Two lines: host/model/ctx then dir/git, to mirror a prompt.
10. Edit script.

## justdan0227/a8f0b6d105cb1e565b456331a5515b3c
https://gist.github.com/justdan0227/a8f0b6d105cb1e565b456331a5515b3c - stars n/a. README says it moved to github.com/justdan0227/claude-code-statusline; the gist copy is frozen.
1. Fixed per part, user-chosen: it prints only the model name; `COLOR` (default `dim_bright_green`) colours the name and `PAREN_COLOR` (default `teal`) colours a trailing `(1M context)`.
2. A name table (`color_code`): black..white, gray, bright_* (`90-97`), plus `orange 208`, `pink 213`, `purple 141`, `teal 44` as 256 indices; `bold_` and `dim_` prefixes. Unknown name falls back to cyan. No themes, user edits two variables.
3. ANSI 16 and four 256 indices. No detection, no NO_COLOR.
4. Foreground only.
5. none (single segment).
6. not present; two-colour split of name vs parenthetical.
7. not present.
8. none.
9. `statusline.sh --preview` prints every colour and weight combination so a user can pick (statusline.sh, lines 49-60).
10. Variables at the top of the file; `--preview` flag. Repo version unread.

## andreschuenck/a8fd2385fe5bbcd9a0f66a35a2be1cc6
https://gist.github.com/andreschuenck/a8fd2385fe5bbcd9a0f66a35a2be1cc6 - stars n/a. An installer for the ccstatusline npm package, not a renderer.
1. Fixed per widget via ccstatusline settings (`setup-ccstatusline.sh` heredoc): model cyan bold, thinking-effort brightMagenta, output-style brightWhite, context-bar brightYellow bold, account email brightBlack, session-clock white, block-timer yellow, reset-timer brightYellow bold, session-usage blue, weekly-usage brightBlue, weekly-reset-timer brightCyan bold, session-cost green bold, tokens-total white bold, tokens-cached brightGreen, total-speed brightMagenta, git-branch magenta bold, git-changes yellow, git-pr brightCyan, free-memory and version brightBlack. Three lines, 37 widgets.
2. Colours are named ccstatusline colours per widget, no theme here; `powerline.enabled: false` so it uses plain separators (`separators: [""]`, caps empty). The powerline keys (`separators`, `separatorInvertBackground`, `startCaps`, `endCaps`, `continueThemeAcrossLines`) show ccstatusline supports powerline mode and themes (unread; see its own repo).
3. `colorLevel: 2` in settings (256-colour level); names are ANSI 16 names.
4. Foreground only in this config.
5. `separator` widgets between every item; `inheritSeparatorColors: false`.
6. Different colour per widget plus separators.
7. not present.
8. none specified.
9. `flexMode: "full-minus-40"`, `compactThreshold: 60`, `minimalistMode`, `globalBold` options.
10. JSON at `~/.config/ccstatusline/settings.json` (version 3), widget `id/type/color/bold`.

## PewDieRes/a9ec6a016f168c2042c4779891954e03
https://gist.github.com/PewDieRes/a9ec6a016f168c2042c4779891954e03 - stars n/a
1. Fixed plus state (`statusline-command.sh`): folder blue `34`, model cyan `36`, branch green `32`, dirty count yellow `33`, ahead/behind cyan `36`, effort magenta `35`. Cost green <$1, yellow >=$1, red >=$5. `pct_color`: green, yellow >=70, red >=90 for 5h, 7d and the context bar; elapsed and reset times grey `90`.
2. not present.
3. ANSI 16. No detection, no NO_COLOR.
4. Foreground only.
5. Grey ` | ` (`\033[90m|`).
6. Hue per segment plus grey pipes.
7. Grey `90` for secondary only.
8. `[` `]` around `█░` bar; arrows `↑↓`.
9. Three-line layout; git cached 3 s.
10. Edit script.

## y-hirakaw/aa59ce04ab5aacabd2752eb1eff47350
https://gist.github.com/y-hirakaw/aa59ce04ab5aacabd2752eb1eff47350 - stars n/a (Japanese notes plus `statusline.cjs`)
1. By state: `getPercentageColor` (cjs ~453): red >=90, yellow >=70, green otherwise for the percent shown. Changed-file counts: green <10, yellow 10-24, red >=25 (cjs 349-384). Git status counters: staged and added green `+N`, modified yellow `~N`, deleted red `-N`, untracked cyan `?N`. Directory, tokens and branch uncoloured.
2. not present.
3. ANSI 16. No detection, no NO_COLOR.
4. Foreground only.
5. Plain ` | ` between emoji-led segments.
6. Emoji prefixes and `|`.
7. not present.
8. Emoji `📁 🪙 📝 🔄`; no ASCII mode.
9. Auto-detects a parent branch to show a files-changed count against it.
10. Edit the cjs file.

## ArtemXTech/ab3fa0c970564a20cbffaf5692d6a073
https://gist.github.com/ArtemXTech/ab3fa0c970564a20cbffaf5692d6a073 - stars n/a
1. Fixed plus state (`statusline-minimal.js`): context pct green `32` <=50, yellow `33` 50-80, red `31` >80 (relative to an assumed 61.5% autocompact threshold); model name steel blue `38;5;117` (hard-coded for all models); the `(NK/NK)` suffix dim `2`. Path uncoloured.
2. not present.
3. ANSI 16 plus one 256 index (117). No detection, no NO_COLOR.
4. Foreground only.
5. Spaces.
6. Hue per part.
7. not present.
8. none.
9. none.
10. Edit script.

## all-you-need-is-laugh/ac4ac8dfc9872bfc824e32300d5729ab
https://gist.github.com/all-you-need-is-laugh/ac4ac8dfc9872bfc824e32300d5729ab - stars n/a. Same statusline in node (`.js`) and bash (`.sh`) versions; the sh header comment (lines 1-20) matches the js, so the js was read.
1. Fixed plus state (`statusline-command.js:30-47, 111-131`): repo name yellow, worktree cyan, branch `greenLight 92` with 🌿, model name coloured by context-window size (magenta >=1M, cyan >=200k, yellow >=100k, else none), `ctx:` green <=50, yellow <=75, red >75. Rate-limit bars are FILLED cells (`renderRateBar`, js 148-180): used cells bright bg (`102` / `103` / `101`), unused cells dim bg (`42` / `48;5;178` / `41`), both by traffic light (<=50 green, <=75 yellow, >75 red), bold-black `30` text of the pct stencilled into the bar; grey `100` bg bar when no data.
2. not present.
3. ANSI 16 backgrounds and foregrounds plus one 256 bg (178 for dim yellow). No detection, no NO_COLOR.
4. Both: bars are bg-filled with text stencilled in; the rest fg-only.
5. Dim ` | ` between segments.
6. Hue per segment, dim pipe; bar uses bright vs dim shade of the same hue to show used vs unused (a two-lightness pair per state).
7. Black text on bright/dim backgrounds; not adaptive.
8. Effort emoji by level (🐌 🏃 🏎️ ✈️ 🚀), 🌿, ⤴️.
9. Percentage printed inside a coloured bar.
10. Edit script.

## gugol2/ac9fa265711f394ad6833b9be2933788
https://gist.github.com/gugol2/ac9fa265711f394ad6833b9be2933788 - stars n/a
1. Fixed plus state (`gistfile1.txt` awk block): model cyan `36`; effort dim; token count plain; context pct bold green `1;32` <50, bold yellow `1;33` 50-79, bold red `1;31` >=80.
2. not present.
3. ANSI 16, bold/dim. No detection, no NO_COLOR.
4. Foreground only.
5. Dim ` · ` (`sep = dim " · " off`).
6. Dim middle dots.
7. not present.
8. none.
9. none.
10. Edit script.

## BenevolentFutures/ad29ae6dd10a2b5cfc1a203f320887f4
https://gist.github.com/BenevolentFutures/ad29ae6dd10a2b5cfc1a203f320887f4 - stars n/a
1. Fixed plus state plus gradient (`statusline.sh:84-92, 156-203`): model colour by FAMILY (Opus bright white `97`, Sonnet blue `38;2;90;160;255`, Haiku pink `255,128,200`, Fable purple `175,95,255`, unknown cyan); context % is a continuous truecolor gradient green to yellow (0-70%) to red (90%+) computed per pct (lines 199-203). Rate limits dim until a warn threshold, then YELLOW, RED >=95; the pace "glide" figure is never coloured. Effort text weight-coded (italic below high, bold above). PR state: approved green ✓, changes-requested red ✗, pending yellow ●, draft dim ◌. Branch and path in other fixed colours.
2. not present; header says "on a truecolor terminal each group is tinted".
3. Truecolor for the model, gradient and grey `38;2;130;130;130`; ANSI 16 elsewhere. Header requires a truecolor terminal; no fallback or NO_COLOR.
4. Foreground only.
5. `SEP="${DIM}│"` dim vertical bar.
6. Hue per group (family colours, gradient context) plus dim `│`.
7. Not present (grey fixed at mid 130).
8. Unicode only: `⑂ ⎇ ● ◇ ✓ ✗ ◌`; no emoji, no Nerd Font.
9. Per-model colouring is the standout, and a continuous context gradient; avoids red for effort because it reads like "bypass permissions".
10. Edit script; width-aware path collapse at <150 `COLUMNS`.

## akunzai/b1151ff86099c4a12935a71dda2bd380
https://gist.github.com/akunzai/b1151ff86099c4a12935a71dda2bd380 - stars n/a (a personal Claude config; `statusline.sh` is the styling part, `settings.json` has Claude Code's own `"theme": "auto"` at line 227, not the statusline's)
1. Fixed plus state (`statusline.sh:7-23`, "Standard 16-color palette only"): model + effort bright magenta italic; numbers bright white bold; token fraction bright yellow; cache hit `✓` bright cyan bold; sandbox `⌬ sandbox` bright green bold; dir `⌂ leaf` bright yellow bold; branch bright green bold clean, bright red bold with `*` when dirty. Context icon steps by pct (`○ ◐ ◑ ◉ ●` at 50/75/90/100), not colour. Rate-limit segments show REMAINING: green >50, bright yellow <=50, bright red bold <20 (whole segment incl. name), reset string bright yellow.
2. not present.
3. ANSI 16 only, by design. No detection, no NO_COLOR.
4. Foreground only.
5. Two spaces between fields on a line.
6. Hue per field, bold/italic weights.
7. Uses bright variants for contrast on dark; no adaptation.
8. Unicode symbols; branch icon is a Nerd Font glyph (`BRANCH_ICON`, line 290) - no fallback; handles CRLF for Windows Git Bash.
9. Context state carried by a moon-phase icon rather than colour.
10. Edit script; README documents install and a Windows `sh` workaround.

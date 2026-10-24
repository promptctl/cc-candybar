## aperritano gist 45023438 (Ghostty + tmux + Claude setup, statusline-command.sh)
URL: https://gist.github.com/aperritano/45023438c60e0ba0e6a5565060e3361d  stars: n/a
Only `statusline-command.sh` (83 lines) is the Claude statusline. The other flagged files (ghostty-config, tmux.conf, tmux-* scripts, Alien Blood / catppuccin hex colours) style the terminal and tmux, not the statusline.
1. Fixed per segment, ANSI 16 fg: user@host green `\033[32m` (L47), dir blue 34 (L50), git `repo:(branch) ↑↓` yellow 33 (L55), model cyan 36 (L60), session name `[x]` magenta 35 (L64). Threshold only on `ctx:N%`: >=80 red, >=50 yellow, else green (L70-77).
2. Themes: not present (no theme concept in the script; the terminal theme supplies the 16 colours).
3. Named ANSI 16 only; no depth detection; NO_COLOR not present.
4. Foreground-only text on the terminal's own background.
5. Plain spaces between segments; no separator glyphs.
6. Neighbours differ by hue only (green/blue/yellow/cyan/magenta, one hue per segment).
7. Not present; relies on the terminal's own palette to stay legible on light or dark.
8. No icons; only `↑` `↓` in git sync text (L38-39). Mirrors Powerlevel10k lean prompt per header comment.
9. Nothing else in the statusline script.
10. Customisation: edit the shell script; no env vars or config file.

## LaurentQ56 gist 454e56f6 (statusline.py)
URL: https://gist.github.com/LaurentQ56/454e56f61922f85dae33bc4312f87377  stars: n/a
1. Context threshold colours the bar and `NN%`: red if `exceeds_200k_tokens` or >=80, yellow >=60, else green (`statusline.py` L23-28). `+N` lines added fixed green, `-N` fixed red (L47). Model name, `Context:` label, `|` separators and duration are uncoloured.
2. Themes: not present.
3. ANSI 16 only (`\033[31m/32m/33m/1m`); no depth detection; no NO_COLOR.
4. Foreground only.
5. Plain ` | ` text separator, uncoloured.
6. Separators only, plus the one coloured bar.
7. Not present.
8. 10-cell `█`/`░` bar (L20); `!` bold marker when over 200k. No emoji/Nerd Font.
9. Window size label like `(1000k)` appended when not 200k.
10. Edit the Python; settings.json only registers the command.

## njacobson-hrp gist 460b22ea (statusline-command.sh)
URL: https://gist.github.com/njacobson-hrp/460b22ea8829fd2d272f44f0f7a11cfd  stars: n/a
1. Fixed per segment (ANSI 16): model cyan 36, cwd yellow 33, git `(branch*)` magenta 35, cost white 37, rate limits `5h:N% 7d:N%` and elapsed time grey 90 (bright black), vim mode bold blue `1;34`. Threshold: context bar red >=80, yellow >=50, else green (L52-58, bar `[████░░░░░░]`, colour wraps bar + % + token count).
2. Themes: not present.
3. ANSI 16 only; no depth detection; no NO_COLOR.
4. Foreground only.
5. Single plain spaces; no separator glyph.
6. Hue per segment, grey for secondary info.
7. Not present.
8. `█░` bar in brackets; no emoji or Nerd Font.
9. Elapsed time derived from transcript birth time (macOS `stat -f %B`).
10. Edit the shell script only.

## mathematicalmichael gist 46339f37 (statusline.sh)
URL: https://gist.github.com/mathematicalmichael/46339f37c050b73cb3873513c50d20e4  stars: n/a
1. Only the context readout is coloured: `used/size (N%)` green `\033[32m` below 50, bold bright yellow `1;93` 50-74, bold red `1;31` >=75 (`statusline.sh`). Model, cwd, branch are uncoloured.
2. Themes: not present.
3. ANSI 16 (bold/bright variants); no depth detection; no NO_COLOR.
4. Foreground only.
5. Plain ` | ` text.
6. Separators only; colour only on the one metric.
7. Not present.
8. None.
9. Nothing else; notes the cumulative-token bug (issue 13783) and derives tokens from `used_percentage`.
10. Edit the script.

## thyagoluciano gist 463ad558 (statusline.sh)
URL: https://gist.github.com/thyagoluciano/463ad5584dc83340b0379f5ba477073f  stars: n/a
1. Model `[Opus]` fixed cyan 36; context bar colour by threshold: green <70, yellow 70-89, red >=90 (L13-15); cost fixed yellow 33. Folder, branch, duration uncoloured.
2. Themes: not present (the flagged `theme.key` and `lightdark.words` hits were not in anything the script does).
3. ANSI 16; no depth detection; no NO_COLOR.
4. Foreground only.
5. Plain ` | `.
6. Separators and emoji only.
7. Not present.
8. Emoji: 📁 folder, 🌿 branch, ⏱️ time; `█░` 10-cell bar. Two lines.
9. Nothing else.
10. Edit the script.

## fabn gist 47b4bca0 (ccstatusline 3-line powerline config)
URL: https://gist.github.com/fabn/47b4bca04e9258c3f78040201d2ffc38  stars: n/a
This is a settings file for the ccstatusline tool (sirmalloc/ccstatusline), not a script. All colour logic lives in that tool; this gist only chooses options. Source of ccstatusline itself not read here.
1. By theme: `powerline.theme: "nord-aurora"` (`ccstatusline-settings.json` end of file) assigns colours to widgets; no per-widget `color` set except `current-working-dir` with `"color": "gradient:atlas"` (L10). Mapping of widget to colour inside the theme: unverified (README only; not read from ccstatusline source).
2. Themes: bundled theme chosen by name (`nord-aurora`; README says drop `colorLevel` to 2 for 256-colour); user definition format not present in this gist. Config also supports per-widget colour including a `gradient:<name>` form.
3. `colorLevel: 3` = truecolor, `2` = 256-colour (README "Requirements"); depth is a setting, not detected here. NO_COLOR: unverified.
4. Background-filled powerline cells (powerline enabled; `autoAlign` pads columns inside the coloured cell, README Tuning table).
5. Powerline: separator U+E0B4 (right half circle), `startCaps` U+E0B6, `endCaps` U+E0B4, `separatorInvertBackground: [false]`, `inheritSeparatorColors: false`. README warns the PUA glyphs get stripped on copy/paste.
6. Neighbours distinguished by the theme's per-position background colours plus separators; `continueThemeAcrossLines: false` restarts the theme each line.
7. Not present in the gist.
8. Nerd Font required (README); no emoji.
9. `autoAlign` column alignment across 3 lines; `flexMode: full-until-compact` with `compactThreshold: 60`; gradient colour on cwd. Second variant `ccstatusline-settings-usage.json` exists.
10. JSON settings in `~/.config/ccstatusline/settings.json`; interactive TUI via `npx ccstatusline@latest`; export/import config from the TUI; env `CCSTATUSLINE_WIDTH` forces width.

## joeyhipolito gist 4e8b1f75 (statusline-command.sh, Auckland 2x badge)
URL: https://gist.github.com/joeyhipolito/4e8b1f758051d702d82911fb058721a5  stars: n/a
1. Fixed per segment (ANSI 16): dir cyan 36, git branch yellow 33 with dirty `*` red 31, model green 32, cost magenta 35. By threshold: context remaining green >50, yellow <=50, red <=20 (L42-48); 5h/7d usage green <50, yellow >=50, red >=80 (`render_usage`). By state: `NORMAL` green / `NERFED` red badge by Auckland clock hour.
2. Themes: not present.
3. ANSI 16; no depth detection; no NO_COLOR.
4. Foreground only.
5. Plain spaces, no separator glyph.
6. Hue per segment.
7. Not present.
8. Nerd Font glyphs (folder `󰉋`, branch, model, cost icons stripped in output, `glyph.nerd_font=2`); no ASCII fallback.
9. Two lines; time-of-day badge.
10. Edit the script; per-UID cache dir in `$XDG_RUNTIME_DIR`.

## lis186 gist 4f920c86 (statusline.sh, two-line with account badge)
URL: https://gist.github.com/lis186/4f920c8657161278e0ad9166f03871ca  stars: n/a
1. Role-named 256-colour variables (`statusline.sh` palette block): model `38;5;255` bright white, project `111` blue, dim secondary (branch, cost, duration) `245`, OK `114` green, WARN `221` amber, CRIT `204` rose. By threshold: context bar OK <70, WARN 70-89, CRIT >=90; cost goes WARN when >=$10; rate segments `N% left` OK >30, WARN <=30, CRIT <=10. Header comment: "tuned to match Claude Code's purple/blue palette".
2. Themes: not present (one hard-coded palette).
3. 256-colour indexes only; no detection; no NO_COLOR.
4. Mostly foreground; the account badge is background-filled: `\033[48;5;141m` purple with `38;5;232` near-black text.
5. Badge uses rounded caps U+E0B6 / U+E0B4 coloured 141 to match; elsewhere `·` and `│` plain separators.
6. Distinct hues for model/project, grey for the rest; separators only.
7. Dark text (232) chosen by hand on the light purple badge; no automatic contrast.
8. Powerline rounded caps (Nerd Font) only for the optional badge; `█░` bar.
9. Optional multi-account badge from claude-code-account-switcher files.
10. Edit the script; README documents hook setup.

## kimtoma gist 52095c26 (statusline-command.sh plus dotfiles)
URL: https://gist.github.com/kimtoma/52095c26ff87ba6cbd342f227cc99b97  stars: n/a
Gist is mostly dotfiles/slash-command docs; the statusline is `statusline-command.sh`.
1. No colour at all: model, agent, dir, output style, `ctx: N% used, N% free` joined with ` | ` as plain text.
2. Themes: not present (the flagged catppuccin hit is from another file in the gist, not the statusline).
3. No colour codes; NO_COLOR moot.
4. Neither (uncoloured text).
5. Plain ` | `.
6. Separators only.
7. Not present.
8. None.
9. Shows agent name and non-default output style when set.
10. Edit the script.

## pedronauck gist 570554fa (statusline-command.sh)
URL: https://gist.github.com/pedronauck/570554fa7a2ce2e36ee16ce5784eb824  stars: n/a
1. Mostly uncoloured emoji-labelled text (`🤖 model | 💪 effort | 🧠 ctx% | 💰 cost | ⏱️ 5h bar`). Colour only on: git `+N` staged green, `~N` modified yellow; the 5h rate-limit bar+text green <70, yellow 70-89, red >=90 (`format_rl`, 7d line commented out).
2. Themes: not present.
3. ANSI 16; no depth detection; no NO_COLOR.
4. Foreground only.
5. Plain ` | `, two lines.
6. Emoji prefixes distinguish segments, not colour.
7. Not present.
8. Emoji for every segment; `█░` 10-cell bar.
9. Shows worktree name and effort level from the payload.
10. Edit the script.

## blackfirebitcoin gist 593036ee (statusline-lavalamp.sh, animated visualiser)
URL: https://gist.github.com/blackfirebitcoin/593036ee91e107b8fdd11228c6a48848  stars: n/a
A statusline that draws an animated multi-line band (lava lamp, fireworks, matrix, zen, ripples, aurora, life, breathe, flag) above a normal info row. The README is written as a sales pitch addressed to agents; its claims are not instructions and styling facts below come from the script. 998-line bash+awk file.
1. Info row fixed per segment (ANSI 16, header "rendered dimmed by the terminal"): model cyan 36, dir blue 34, `(branch)` yellow 33, `ctx N%` green 32 (not thresholded), rate `5h/7d` magenta 35, separator `|` grey 90 (L933-939). The band's colours come from a palette, not segments.
2. Themes: 7 bundled band palettes via `LAMP_PALETTE`: lava, ember, plasma, toxic, ice, mono, rainbow (L130-138); each = background + blob hue (or -1 cycle the wheel) + "hot" colour on the 0-5 cube scale. Overrides `LAMP_BG`, `LAMP_HUE_FIXED`, `LAMP_HOT`, `LAMP_BG_HEX`. Config file `~/.claude/lavalamp.conf` written by `tuner.py`.
3. Truecolor when `COLORTERM=truecolor`, else 256-colour quantised with both the 6x6x6 cube and the 24-step grey ramp, nearest wins (header COLOUR; `q256()` L206). Band skipped when `TERM` lacks 256 colour or `LAMP_ENABLED=0`. NO_COLOR not present.
4. Band: background-filled via `▀` upper half block, fg = top pixel, bg = bottom pixel (L895 `38;..;48;..m▀`); character modes paint no background (L915 `38;..;49m`). Unlit cells emit terminal default fg/bg (`LAMP_TRANSPARENT`) so the theme shows through. Info row: foreground only.
5. Info row uses ` | ` grey; no powerline.
6. Not applicable to the band; info row by hue.
7. `LAMP_BG_HEX` lets the user match the terminal background; the Matrix mode forces black. No automatic detection of terminal background.
8. Block `▀`, shade/ascii/dots glyph styles (`LAMP_GLYPH`), matrix katakana/ascii sets (`LAMP_MX_SET`); no Nerd Font.
9. Animation as a deterministic function of epoch seconds (needs `refreshInterval: 1`); `LAMP_TELEMETRY=1|2` ties speed to 5h usage and glow/hue ramp to context fill; rainbow palette cycles hue (`LAMP_HUE` period). Web tuner (`tuner.py`, Win95-styled page on port 8794) previews by running the real script and converting ANSI to HTML. Screenshots `visualizer.png`, `tuner.png`.
10. Environment variables (`LAMP_*`: MODE, PALETTE, GLYPH, FX, COLS, LINES, SPEED, etc.), `~/.claude/lavalamp.conf`, web tuner, `LAMP_BARE=1` for use outside Claude.

## bshakr gist 59d38fed (Catppuccin Mocha, Starship-inspired)
URL: https://gist.github.com/bshakr/59d38feded4a54afdc7225a2f4da5f28  stars: n/a
1. Truecolor Catppuccin Mocha constants (`statusline.sh` L6-25): branch YELLOW `249;226;175`, dir PEACH `250;179;135` (shown only when no branch), model LAVENDER `180;190;254`, separators/time SUBTEXT `166;173;200`, dirty `*` RED / clean `✓` GREEN. Context, 5h and wk bars: filled background GREEN/YELLOW/RED by remaining % (<=20 red, <=50 yellow, else green; `pick_bg_color`), empty cells `BG_EMPTY` `49;50;68`.
2. Themes: one hard-coded palette (Catppuccin Mocha); no theme switching.
3. Truecolor `38;2`/`48;2` only; no detection or downsampling; no NO_COLOR. README requires 24-bit terminal.
4. Both: text segments foreground only; progress bars are background-filled cells with the label printed inside the bar.
5. Plain ` · ` in SUBTEXT; no glyph separators.
6. Distinct Catppuccin hues per segment; bars separated by a space.
7. Text on bars is hand-picked: `FG_DARK` `30;30;46` on filled, `FG_LIGHT` `186;194;222` on empty (L18-19). Mocha-only, assumes dark terminal.
8. Branch/dir prefix glyph (Nerd icon, stripped in fetched text); `✓`/`*`. No ASCII fallback.
9. Percent text rendered inside the bar via per-cell bg/fg.
10. Edit the script.

## farnell gist 5ac1a1dc (statusline.sh, user@host:dir)
URL: https://gist.github.com/farnell/5ac1a1dce2f14d852a2e689821a40d34  stars: n/a
1. Only the context-token count is coloured: green `32` <100k, orange `38;5;208` 100-150k, red `31` >=150k (`statusline.sh` L48-52). Everything else plain text: `user@host:dir ⑂ repo ⎇ branch* [Model · effort] · tokens ctx · $cost · duration`.
2. Themes: not present.
3. ANSI 16 plus one 256 index (208); no detection; no NO_COLOR.
4. Foreground only.
5. Plain ` · `.
6. Glyph prefixes (`⑂`, `⎇`) and brackets, not colour.
7. Not present.
8. Unicode symbols `⑂` `⎇`; no Nerd Font or emoji.
9. Tokens read from the transcript, not the payload.
10. Edit the script.

## abrinsmead gist 5cc3a54d (statusline.sh, boxed widgets)
URL: https://gist.github.com/abrinsmead/5cc3a54df42a078e6acbdb647828867f  stars: n/a
1. Per-widget fixed colour inside grey brackets (`statusline.sh` L12-20, widgets L35-110): model orange `38;5;208` with `✻`, dir blue `4` with `󰉋`, git purple `5` clean / magenta `13` dirty with `*`, poker cards red for hearts/diamonds, grey for spades/clubs. Context threshold: green <33%, yellow <66%, red above (L56-58); the icon also steps through 7 Nerd gauge glyphs.
2. Themes: not present. `SHOW_MODEL/CONTEXT/DIR/GIT/POKER` booleans toggle widgets.
3. 256-colour indexes (includes 0-15 via `38;5;1..5,13`, so they follow the terminal palette); no detection; no NO_COLOR.
4. Foreground only.
5. Brackets `[ ]` around each widget in light grey `245`; whole line framed by `└─ ... ─┘` in `240`.
6. Each widget boxed in brackets and given its own hue.
7. Not present.
8. Nerd Font required (header); emoji-free; a random two-card poker hand widget.
9. Random poker hand per render.
10. Edit variable block at top of script.

## MickaelBlet gist 5e41ff1f (statusline-command.sh, powerline pills)
URL: https://gist.github.com/MickaelBlet/5e41ff1fe75001c8b3b53fcbc1c2cccb  stars: n/a
1. Background colour per segment, 256-colour, by state: model bg by name (`current_dir()`/`model()` L11-45): Opus 125, Sonnet 24, Haiku 22, else 240; effort pill: low 22, medium 130, high 124, xhigh 124, max 54, none 240. Dir pill fixed 238. Git pill by repo state (L190-205): conflict/in-.git 124, dirty 226, staged 207, untracked 214, detached 97, clean-in-sync 118, else 240. Context pill by %: >=60 124, >=40 130, else 22. 5h pill >=80 124, >=50 130, else 22; weekly fixed 24.
2. Themes: not present; hard-coded.
3. 256-colour only (`48;5;N`/`38;5;N`); no detection; no NO_COLOR.
4. Background-filled pills; text fixed white 231 (dark 232 on light git backgrounds, chosen per branch of the if).
5. Rounded pill caps U+E0B6 left / U+E0B4 right, cap fg = pill bg; chained `` (U+E0B0) arrow joins effort pill to model pill and 5h to weekly, arrow fg = left bg, bg = right bg. Separators coloured by neighbouring segment backgrounds.
6. Separate pills with different backgrounds, each ending in its own cap; adjacent pills in a group share an arrow.
7. Text colour hand-picked per background (231 white on dark, 232 black on yellow/pink/orange/green git states).
8. Nerd Font caps plus emoji icons (📂 🤖 🔖 📊 ⏳, effort 🟢🟡🟠🔴🟣).
9. Git pill shows in-progress ops (REBASE n/m, MERGE, CHERRY-PICK, BISECT, CONFLICT), M/A/U/S counts, ahead/behind.
10. Edit the script.

## 1kaiser gist 60fcceb1 (GNOME quota bars + terminal statusline)
URL: https://gist.github.com/1kaiser/60fcceb152ac455d09888f04fb1be793  stars: n/a
Mostly a GNOME top-bar extension patch (Pango markup, Nyan Cat frames, glow) plus one terminal statusline `statusline-usage.py` (176 lines). `agy-statusline.py` is another tool's statusline and was not read.
1. `statusline-usage.py`: model bold cyan 36; quota bars `▰▱` coloured by percent: green <50, yellow 50-79, red >=80 (`color()`); empty cells DIM; labels and `(2h13m)` reset times DIM; `(cached)` DIM.
2. Themes: not present in the terminal script. In the GNOME patch the two windows are told apart by fixed colour (5h lime `#32CD32`, 7d orange `#FFA500`, unfilled `#6b6b6b`) per README.
3. ANSI 16 (bold, dim); no detection; no NO_COLOR.
4. Foreground only in the terminal script.
5. Plain ` · ` dimmed.
6. Separators and dim labels.
7. Not present.
8. `▰▱` bar glyphs; no emoji in the terminal script. GNOME side uses cycling emoji and a Nyan Cat.
9. GNOME panel: animated Nyan Cat frames, rainbow glow, cycling emoji (README); not terminal styling. Terminal script fetches quota from the OAuth usage endpoint with negative caching.
10. Edit script; `install.sh` merges the `statusLine` key into settings.json.

## seri1091 gist 6589768a (team display, Japanese article)
URL: https://gist.github.com/seri1091/6589768a6757cdeac3f784fcb0d475b9  stars: n/a
1. No colour: the script prints `[org: <CLAUDE_TEAM_NAME>] ~/path (branch)` as plain text.
2. Themes: not present (the `theme: "dark"` in the sample settings.json is Claude Code's own UI theme).
3. No colour codes.
4. Neither.
5. Plain text.
6. Not applicable.
7. Not present.
8. None.
9. Shows the active team via env `CLAUDE_TEAM_NAME` (multi-org use case).
10. Edit the script; env `CLAUDE_CONFIG_DIR` / `CLAUDE_TEAM_NAME`.

## mvwi gist 661d15bc (statusline.sh with usage limits)
URL: https://gist.github.com/mvwi/661d15bce8bbca364400d9306b0d6110  stars: n/a
1. Fixed: dir cyan 36, branch magenta 35. By threshold (green <50, yellow <80, red >=80): context `% ` (L66-72) and the 5h/7d usage segments (`usage_color`, shown only when >=50%). Dir hidden when it matches the branch name.
2. Themes: not present.
3. ANSI 16; no detection; no NO_COLOR.
4. Foreground only.
5. Single spaces.
6. Hue per segment; Nerd icons.
7. Not present.
8. Nerd Font required (README): branch `󰘬`, context `󰧮`, limits `󰾅`.
9. Fetches usage from the OAuth endpoint (macOS keychain) in the background with a 60 s cache.
10. Edit the script; macOS only.

## mdoering gist 67212299 (statusline-command.sh)
URL: https://gist.github.com/mdoering/67212299857be946420bae06c0116edd  stars: n/a
1. Fixed (ANSI 16): model yellow 33, context `󰧑 N%` magenta 35, worktree blue 34, dir white 37, branch cyan 36 with `+staged` green and `~modified` yellow. Threshold: rate-limit bar+% green <70, yellow 70-89, red >=90 (`format_pct`; weekly shown as `N% Week` without bar).
2. Themes: not present.
3. ANSI 16; no detection; no NO_COLOR.
4. Foreground only.
5. Plain ` | `, two lines.
6. Hue per segment.
7. Not present.
8. Nerd Font glyphs `󰧑` `󰐅`; `█░` bar.
9. Nothing else.
10. Edit the script. Same lineage as pedronauck's script (same variable names).

## lajosbencz gist 696cf16e (claude-statusline, env-configurable)
URL: https://gist.github.com/lajosbencz/696cf16ecbbbe86a4f246369a32a7026  stars: n/a
1. Fixed per component (`statusline.sh` L37-38 palette, L59-310): cwd bright blue 94, git branch cyan, `+N`/`↑` green, `-N`/`↓` red, untracked grey, stash yellow, venv yellow, node/python version cyan, kube context blue, namespace grey. By model (L257-275): Opus magenta `◆`, Sonnet blue `◇`, Haiku green `○`, else grey `●`. By threshold: context bar red >=75, yellow >=50, green; memory grey/yellow >=500MB/red >=1024MB; CPU grey/yellow >=25/red >=75.
2. Themes: not present as a feature (the flagged "nord" is not in the script or SKILL.config.md).
3. ANSI 16 with bright variants; sets `TERM=xterm-256color` default; no detection; no NO_COLOR.
4. Foreground only.
5. Configurable text separator `CLAUDE_STATUSLINE_SEP`, default `|`, drawn grey; `|` token in `FORMAT` inserts it between groups.
6. Separators grouping components; hue per component.
7. Not present.
8. All symbols overridable via `CLAUDE_STATUSLINE_SYM_*` (dir, branch, model symbols, bar fill/empty, kube, etc.); defaults mix Unicode and some Nerd/emoji; bar uses `━`.
9. Layout is a token string `CLAUDE_STATUSLINE_FORMAT`; skills `/claude-statusline-setup` and `/claude-statusline-config` edit settings.
10. Env vars `CLAUDE_STATUSLINE_*` stored in `~/.claude/settings.json`, Claude skills for guided setup, `setup.sh` installer.

## interaminense gist 6a4665f9 (statusline.sh, six themes)
URL: https://gist.github.com/interaminense/6a4665f933da85a387b2cdccc1355502  stars: n/a
1. Depends on `THEME`. `colorido` (default): fixed per segment: session name cyan, branch green, path blue, webpack port orange `38;5;208`, FARO_URL teal `38;5;44`, model magenta; context bar and 5h % by threshold via `clr()`: green <50, yellow 50-79, red >=80. Other themes use only the threshold colour and dim/gray.
2. Themes: 6 bundled layout themes selected with `CC_STATUSLINE_THEME`: adaptativo, minimalista (monochrome, no emoji, `·` separator), colorido, duas-linhas (two lines), powerline, usage. They are layout+colour presets in one `case`; user-defined themes need editing the script.
3. ANSI 16 plus 256 indexes (208, 44, powerline backgrounds); no detection; no NO_COLOR.
4. `powerline` theme is background-filled; others foreground only.
5. Powerline theme: arrow (PUA glyph, stripped in fetch, presumably U+E0B0) coloured fg = previous bg, bg = next bg. Other themes: grey `│` or dim `·`.
6. Powerline: per-segment fixed backgrounds in the `bgs` array (24 blue, 54 purple, 94 brown, 23 teal, 238 grey for ctx, 240 for 5h) with white text 231. Others: separators.
7. `adaptativo` is named for adapting by using only grey separators and dim; no real detection of terminal background.
8. Emoji for every segment except minimalista; Nerd Font only for powerline; OSC 8 hyperlinks on path (`ghosttycd://`), localhost port and FARO URL.
9. Zero-width-space second line to separate from Claude's hints.
10. Env var `CC_STATUSLINE_THEME` or edit variable in script.

## brzvsk gist 6c37801e (statusline.sh)
URL: https://gist.github.com/brzvsk/6c37801e890b1baba20798a87315aee3  stars: n/a
1. Dir cyan 36 fixed. Context % and 5h limit % by threshold: green <50, yellow <80, red >=80. Reset time fixed amber `38;5;220`. Separator `·` grey 90.
2. Themes: not present.
3. ANSI 16 plus one 256 index; no detection; no NO_COLOR.
4. Foreground only.
5. Plain grey `·`.
6. Separators and hue.
7. Not present.
8. None.
9. Fetches 5h usage from the OAuth endpoint (macOS keychain), 5-minute cache.
10. Edit the script.

## igorgcustodio gist 6c7dccb7 (context-monitor.py)
URL: https://gist.github.com/igorgcustodio/6c7dccb705b413a030805081428d0212  stars: n/a
1. By state: context bar + icon by % (`get_context_display`): >=60 `🚨` bold red `31;1` + "CRIT", >=50 `🔴` red + "HIGH", >=40 `🟠` bright red `91`, >=20 `🟡` yellow, else `🟢` green. Model `[name]` coloured by the same context % (red >=50, yellow >=40, else green; L151-156). Cost: red >=$0.10, yellow >=$0.05, green. Duration: yellow >=30 min, green. Lines changed: green if net positive, red negative, yellow zero. Directory bright yellow `93`; separators grey `90`.
2. Themes: not present.
3. ANSI 16 incl. bright (91, 93, 94); no detection; no NO_COLOR.
4. Foreground only.
5. Plain grey `|`.
6. Colours are state-driven, not distinct per segment; emoji prefix tells segments apart.
7. Not present.
8. Emoji heavy (📁 🧠 💰 ⏱ 📝); `█▁` 8-cell bar.
9. Clickable `📝 log` OSC 8 link to a log file (L128); the "blinking red" is just bold.
10. Edit the Python; settings-snippet.json.

## thesimonho gist 71104cd2 (pace-aware rate limit bars)
URL: https://gist.github.com/thesimonho/71104cd2f9762da00d5ddc40a7e977a3  stars: n/a
1. By state, pace-based: the 5h and 7d bar colour comes from burn rate = time-remaining% / quota-remaining%: bright green below 1.25, bright yellow 1.25-1.5, red >=1.5 (`pace_color`, `BURN_YELLOW=1.25`, `BURN_RED=1.5` tunable at top). Context bar uses plain thresholds: green <60, yellow 60-79, red >=80. Model and labels uncoloured.
2. Themes: not present; the three colour constants are at the top.
3. ANSI 16 incl. bright (`0;92`, `0;93`); no detection; no NO_COLOR.
4. Foreground only.
5. Two spaces / `|` plain text.
6. Separators only.
7. Not present.
8. `░▒▓` density glyphs: `▓` filled, `░` empty, `▒` marker where usage would be at an even pace.
9. The pace marker inside the bar is the distinguishing idea: colour tracks speed of consumption relative to period elapsed.
10. Thresholds editable as variables in the script.

## bricelam gist 72e74ce1 (statusline.ps1, Windows)
URL: https://gist.github.com/bricelam/72e74ce1398e8e7e6cfa8dc0a381ac80  stars: n/a
1. One colour for everything: whole line grey `ESC[90m` (`statusline.ps1`): `model.id | ctx: N% | $cost`. No per-segment colour.
2. Themes: not present (the flagged `theme.key` is Claude Code's own `"theme": "dark-ansi"` in settings.json).
3. ANSI 16 bright black only; no detection; no NO_COLOR.
4. Foreground only.
5. Plain ` | `.
6. Not applicable.
7. Chooses `dark-ansi` in Claude Code settings so colours follow the terminal palette; the statusline itself does nothing.
8. None.
9. `prefersReducedMotion: true` in settings.json (the flagged motion hit); not statusline-related.
10. PowerShell script; settings.json registers `powershell -NoProfile -File`.

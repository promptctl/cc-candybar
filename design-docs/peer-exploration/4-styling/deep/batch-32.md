# Batch 32: styling analysis (25 gists, stars n/a for all)

Anchors name the gist file and the variable or function that holds the colour. Gists are scripts of a few hundred lines, so names locate faster than line numbers.

## gist/b355b160db0f22ea474976a64783ad9a (lololopez200123, plan-usage "card" statusline with themes)
URL: https://gist.github.com/lololopez200123/b355b160db0f22ea474976a64783ad9a, stars n/a. README says the project moved to github.com/lololopez200123/claude-code-statusline (this gist is a legacy mirror).
1. Colour per segment is fixed by role through 8 palette variables: `statusline-command.sh` line build: user@host=CYAN, dir=BLUE, git=MAGENTA, model=YELLOW, ctx bar=GREEN, time=DIM, separator `|`=DIM. The variable names are ANSI names but the values are theme-defined (in `deep-crimson.theme` CYAN holds cream, `# user (cream)`). Plan 5h/7d percentages are the exception: `plan_color_for` is a threshold (<50 GREEN, 50-79 YELLOW, >=80 RED). Labels `5h`/`7d` are BOLD.
2. 7 bundled themes in `*.theme` files and the installer's FILES list: midnight-neon (default), royal-violet, deep-crimson, terminal-matrix, ultraviolet-neon, hot-pink-neon, sakura-rose. Format: a sourced bash file that sets 8 variables (CARD_BG, CYAN, BLUE, MAGENTA, YELLOW, GREEN, RED, DIM), so a per-slot palette where the slot names are historical ANSI names that carry semantic roles (comments such as `# git (violet pop)`, `# plan-high`). Users add their own by dropping a `.theme` file in `~/.claude/statusline-themes/`; `statusline-theme` is a picker (fzf with live preview, else numbered menu; subcommands list/set/preview/current).
3. Truecolor hex (`\033[38;2;R;G;Bm`) in themes; defaults fall back to ANSI 16 (`CYAN=${CYAN:-$'\033[36m'}`), and the default card bg is 256-colour `48;5;236`. No depth detection or downsampling. NO_COLOR is read only by `install.sh` for its own log output, not by the statusline.
4. Background fill: the whole line sits on one background, `CARD_BG` (e.g. `#0c0e27` in midnight-neon, `#ec4899` in hot-pink-neon). Text is foreground-only on top. `RESET` is a soft reset (`\033[22;23;24;39m`) so the bg survives between segments; `LINE_END` hard-resets. `CARD_BG=""` disables card mode.
5. Separators: plain text `SEP=" ${DIM}|${RESET} "`; colour is DIM from the theme, no caps or powerline.
6. Neighbours are told apart by per-slot hue and the `|` separator; nothing else. No lightness stepping or alternation.
7. Contrast is hand-tuned per theme, not computed: `hot-pink-neon.theme` comments `# plan-high (orange — avoids red/pink clash)`; `deep-crimson.theme` `RED` is pale rose "visible on dark red". No light/dark detection.
8. Emoji/Nerd: a branch glyph before git (`${MAGENTA} ${git_branch}`, the private-use char is stripped in the dump) and `ctx [####------]` ASCII bar. No fallback mode.
9. Notable: card background as a "border-less card" idea with theme-chosen bg; per-theme choice of which colour plays the alert role (orange on pink/green backgrounds); ANSI-injection hardening of JSON strings.
10. Customisation: theme file + `~/.claude/statusline-theme.conf` (name), env overrides `STATUSLINE_CONFIG`, `STATUSLINE_THEME_DIR`, any palette variable can be injected via env (`VAR:-default`). Installer is a curl|bash that merges `statusLine` into settings.json with jq.

## gist/b7361f3934d3b80a29bb753c508c062b (tiago-aguiar-moreira, git repo/branch + model + ctx + elapsed)
URL: https://gist.github.com/tiago-aguiar-moreira/b7361f3934d3b80a29bb753c508c062b, stars n/a.
1. Fixed per segment with one threshold: `statusline-command.sh` repo=`\033[32m` green, branch=`\033[36m` cyan, model=`\033[35m` magenta, elapsed=`\033[90m` grey; ctx% threshold <50 green, 50-79 yellow, >=80 red (`color=` in the `used_int` block).
2. Themes: not present.
3. ANSI 16 only (31/32/33/35/36/90). No depth detection, no NO_COLOR.
4. Foreground-only.
5. Separator: plain `" | "` joined in the `result` loop, uncoloured.
6. Neighbours: hues only (green/cyan/magenta/grey).
7. Not present.
8. No glyphs beyond ASCII.
9. Nothing notable; also writes `statusLine` as a bare string in settings.json in the installer (`install-statusline.sh`).
10. Edit the script; `STATUSLINE_URL` env for the installer.

## gist/b7e63d8c1cb29c83960944d833422d04 (inchan, "Claude Code Statusline v6", Korean/English)
URL: https://gist.github.com/inchan/b7e63d8c1cb29c83960944d833422d04, stars n/a.
1. `statusline.sh` (`OUTPUT=` assembly): model=CYAN `[Opus 4.5]`, bar+percent=`COLOR` by threshold (>100 RED+BOLD with the text "Compressed", >80 RED, >50 YELLOW, else GREEN), tokens `(81K/200K)`=DIM, cost=MAGENTA, cache `⚡96%`=CYAN, time left `~7m`=DIM.
2. Themes: not present. Items are toggled, not themed.
3. ANSI 16 + bold/dim. Honours NO_COLOR: `if [ -n "${NO_COLOR:-}" ]` blanks every colour variable (also documented in the README).
4. Foreground-only.
5. Separator: single space between items, no glyph.
6. Neighbours: hue only.
7. Not present.
8. Block-bar `█░` (10 cells), `⚡` emoji; box-drawing is only in the config TUI.
9. Interactive config TUI `statusline-config.sh`: arrow keys + space toggle, live preview of each item in its colour, ko/en language toggle.
10. Config is `~/.claude/statusline/statusline.env` with `CLAUDE_SL_MODEL/BAR/PERCENT/TOKENS/COST/CACHE/TIME/LANG` = 0/1; env vars override the file; also `NO_COLOR`, `CLAUDE_STATUSLINE_DEBUG`.

## gist/b968e6f592558e584dc90ada12babc08 (JerryLien, "HP status line", rpg/bloom themes)
URL: https://gist.github.com/JerryLien/b968e6f592558e584dc90ada12babc08, stars n/a.
1. `statusline-hp.sh`: by state, not by segment. `pick_color` for the 5h/7d bars is >=80 BRIGHT_RED, >=50 BRIGHT_YELLOW, else BRIGHT_GREEN; the context bar (`ctx_bar`) is >=90 RED, >=70 YELLOW, else CYAN; model line BOLD+WHITE; effort icon coloured by level (high BRIGHT_RED, medium BRIGHT_YELLOW, low GRAY); cost DIM+MAGENTA; `+N/-N` DIM GREEN and RED. Empty bar cells are GRAY.
2. Two bundled themes selected by `case "$THEME"`: `rpg` (default) and `bloom`. A theme is a set of glyph variables (MODEL_ICON, BAR_FILL, BAR_EMPTY, CTX_ICON, COST_ICON, EFFORT_*), not colours. Colours are the same across themes. Users can only add one by editing the case block. A dead `pikmin` branch remains in the lines-changed code.
3. ANSI 16 incl. bright variants (`\033[91m`..`\033[97m`). No depth detection, no NO_COLOR.
4. Foreground-only.
5. Separator: two spaces, no glyph.
6. Neighbours: separated by spacing plus icons and labels.
7. Not present.
8. Emoji heavy (⚔ ❤ 🧠 💰 in rpg; 🌱 🌸 🍄 🌕 🔴🟡🔵 in bloom); bloom replaces the bar with flower emoji. No ASCII fallback.
9. Gaming health-bar concept: the bar shows remaining HP (100 - used) in rpg and used in bloom (`BAR_INVERTED`). A `/statustheme` skill (`statusline-hp-SKILL.md`) toggles the theme by editing `env.STATUSLINE_THEME`. Optional `spinnerVerbs` flavour text.
10. `STATUSLINE_THEME` env in settings.json; the skill switches it. No config file.

## gist/ba6870a90391ce512d697f36b7aa2304 (LaszloMocsy, truecolor sub-cell bars with band colours)
URL: https://gist.github.com/LaszloMocsy/ba6870a90391ce512d697f36b7aa2304, stars n/a.
1. `statusline-command.sh`: threshold bands for every bar (Ctx, 5h, 7d) in `render_metric`: `p>=CRIT_AT(85)` crit, `>=WARN_AT(60)` warn, else ok. Each band has a fg/bg pair: OK `40;225;90` on `8;28;14`, WARN `255;190;30` on `28;20;4`, CRIT `255;45;45` on `30;6;6`. Fixed per segment elsewhere: model=`MODEL_FG` `217;119;87` (Anthropic terracotta #D97757), git branch and `⎇`=`ACCENT_FG` `120;170;255`, effort has its own colour per level (`EFFORT_LOW_FG` 245;195;68 gold, MEDIUM 108;184;110 green, HIGH 178;185;244 periwinkle, XHIGH 169;137;248 violet, MAX 235;82;82 red, ULTRACODE 235;120;205, AUTO 140;146;158) sampled from Claude Code's own /model effort slider; `+N` uses OK fg, `-N` uses CRIT fg; labels, reset countdowns, cost and separators are `dim`. Unknown effort falls back to the accent.
2. One theme, user-overridable: any of BAND_*, MODEL_FG, ACCENT_FG, EFFORT_*, glyphs, thresholds, SHOW_* can be put in `~/.claude/statusline-theme.sh` (env `STATUSLINE_THEME` for the path), which is sourced after the defaults. The header mentions a "preview editor" whose Copy output pastes into that file; the editor is not in the gist (unverified).
3. Truecolor only (header: "Truecolor (24-bit) required"), `R;G;B` triplets. No detection, no downsampling, no NO_COLOR.
4. Both: bar is foreground fill glyphs on a dark background of the same hue (`${esc}[38;2;${fg};48;2;${bg}m`), so the empty part is the band's dark colour. Rest is fg-only.
5. Separator: plain ` · ` (`SEP`), dimmed; brackets `[ ]` around bars dimmed.
6. Neighbours: separator plus label; bars differ in label text, not hue.
7. Not present beyond the "avoid emoji that render double width" note.
8. Unicode only: left-eighth blocks `▏▎▍▌▋▊▉█` for 1/8-cell precision (explicit UTF-8 bytes, locale-independent), `↻`, `Δ`, `⎇`, `✱`. No Nerd Font, no emoji.
9. Fill/empty are the same hue in two lightnesses (prominent vs cell background darkened) which is the "light step within one hue" idea; pacing delta `Δ+N` takes the WARN colour when ahead of budget, dim when behind.
10. Config: edit the script's top block or the sourced theme file; `SHOW_MODEL/EFFORT/GIT/LINES/PACE` 0/1 toggles; `BAR_WIDTH`, `WARN_AT`, `CRIT_AT`, glyph vars.

## gist/bb4d15ea57aa7f21fc7bc6d7759453a9 (echo724, LiteLLM budget status line)
URL: https://gist.github.com/echo724/bb4d15ea57aa7f21fc7bc6d7759453a9, stars n/a.
1. The script embedded in `install.sh`: fixed per segment: `user@host` plain, cwd=`\033[34m` blue, branch=`\033[90m` grey, dirty `*`=`\033[36m` cyan, `❯`=`\033[35m` magenta, model plain, session cost=`\033[36m` cyan. Budget uses a threshold: `pct>=90` red `31`, `>=70` yellow `33`, else green `32` (README: "green <70%, yellow 70-90%, red >=90%").
2. Themes: not present.
3. ANSI 16 only (31/32/33/34/35/36/90). The installer's own helpers (`red()`, `green()`, `amber()`, `info()`) are fixed ANSI. No NO_COLOR, no detection.
4. Foreground-only.
5. Separator: two spaces / newline, no glyph; line 2 starts with `❯`.
6. Neighbours: hue only.
7. Not present.
8. `❯` and `✔` only.
9. Nothing notable.
10. Edit the script; env `CLAUDE_CONFIG_DIR` for the install location.

## gist/bbef076946299a04b0ece77c235eb736 (anchietajunior, emoji three-line, Portuguese labels)
URL: https://gist.github.com/anchietajunior/bbef076946299a04b0ece77c235eb736, stars n/a.
1. `statusline.sh`: only the rate-limit line and git counters are coloured. `format_rl` colours the whole "label bar pct% resets time" by threshold (>=90 RED, >=70 YELLOW, else GREEN); in git, staged `+N` GREEN and modified `~N` YELLOW. Everything else (model, effort, ctx, cost, dir, worktree, branch) is uncoloured and identified by a leading emoji (🤖 💪 🧠 💰 ⏱️ 📁 🌳 🌿).
2. Themes: not present.
3. ANSI 16 (31/32/33). No detection, no NO_COLOR.
4. Foreground-only.
5. Separator: plain ` | `, uncoloured; three lines.
6. Neighbours: emoji prefix and `|`.
7. Not present.
8. Emoji-only identity per segment; bar `█░`.
9. Nothing notable.
10. Edit the script.

## gist/becbe5f3632ed12691032f44195b03bd (dorukardahan, "claude-statusline-setup.md" v7 prompt, 2-line)
URL: https://gist.github.com/dorukardahan/becbe5f3632ed12691032f44195b03bd, stars n/a. The gist is a markdown prompt that has Claude Code write `~/.claude/statusline.sh`; the colours below are from the script block in it.
1. Fixed per segment (bright ANSI): model `[..]`=96 bright cyan, path=36 cyan, session id=90 grey, project dir=97 bright white, branch=92 bright green, `[wt:..]`=95 bright magenta, `[agent]`=93 bright yellow, `[effort:..]`=`38;5;208` orange, `[style:..]`=36, `⚡fast`=93, `think:off`=90, version=90; line 2: absolute ctx (`CTX_ABS`)=95 magenta, tok/s=93, duration=94 bright blue, cost=97, lines `+N`=92 / `-N`=91, reset times=90, separators `|`=90. Thresholds: context % in `format_ctx` (>=90 91, >=70 `38;5;208`, >=50 93, else 92); cache hit (`>=80` 92, `>=40` 93, else 90; TTL <10 min orange; cold rebuild = orange); rate-limit bars `mini_bar` (>=80 91, >=50 93, else 92). PR badge colour by review state (approved 92, pending 93, changes_requested 91, draft 90, other 36).
2. Themes: not present.
3. ANSI 16 bright plus one 256-colour index (`38;5;208`). No detection, no NO_COLOR.
4. Foreground-only.
5. Separator: grey `|` (`sep()` prints ` \033[90m|\033[0m `).
6. Neighbours: distinct hues per field and grey pipes.
7. Not present.
8. Emoji for reset clocks (`🔄` 5h, `🏁` 7d), `⏳ ✓ ⚠ ✎` in the PR badge, 5-cell `▮▯` bars, `↻` for cold cache. OSC 8 hyperlink on the PR badge.
9. Orange via 256-colour index used as the "warn" step between yellow and red.
10. It is an LLM prompt, so the user edits the generated script; no config file.

## gist/c4340c6febd1b9848eb1656197bf17ca (ericboehs, proxy-aware, copilot/cerebras/oMLX usage)
URL: https://gist.github.com/ericboehs/c4340c6febd1b9848eb1656197bf17ca, stars n/a.
1. `statusline.sh`: segment colours are fixed by role plus thresholds. Dir=`\033[34m` blue (host prefix over SSH/container=green), branch=`\033[35m` magenta, git indicators `[!?+]`=`\033[33m` yellow, model=`\033[33m` yellow, proxy name (copilot / oMLX / cerebras / any other base URL)=`\033[31m` red. Thresholded in cyan/yellow/red (cyan is the healthy colour, not green): ctx tokens (`pct_color`: >=80 red, >=50 yellow, else cyan), usage windows (`usage_color` >=90 red, >=75 yellow, else cyan), pace ahead (>=20 red, >=10 yellow, else cyan), extra usage.
2. Themes: not present.
3. ANSI 16 only. No detection; width via `tput cols` for layout only. No NO_COLOR.
4. Foreground-only.
5. Separator: single spaces; it keeps a parallel plain-text copy of each segment (`seg_*_plain`) to measure the width and wraps to line 2 when it does not fit.
6. Neighbours: hue only.
7. Not present.
8. ASCII plus `↻` and `…`.
9. Plain/coloured twin strings per segment so width is measured without escape codes; healthy state is cyan rather than green.
10. Edit script; env `SHOW_PACE`, thresholds `PACE_AHEAD_THRESHOLD`, `USAGE_ALWAYS_SHOW`.

## gist/c84876263251194d2f0b0d3546f7b088 (mzelzoghbi, 3-line, light/dark theme detection)
URL: https://gist.github.com/mzelzoghbi/c84876263251194d2f0b0d3546f7b088, stars n/a.
1. `statusline-command.sh`: model=`BLUE_MODEL` bold, context label and token usage and `thinking:` value=`ORANGE_CTX`, repo name BOLD, git branch GREEN when clean / RED when dirty (`branch_col`), `bar_color` threshold for the 5h and 7d bars (<50 GREEN, <80 YELLOW, else RED), "no data" bars DIM, `mcp: N` plain.
2. Two palettes chosen at runtime, not user-named themes: `dark` (vivid; GREEN/YELLOW/RED are ANSI `32/33/31`, `BLUE_MODEL` #0A99F7, `ORANGE_CTX` #F2A95D) and `light` (truecolor #2E8B3D green, #B8860B yellow "dark goldenrod — readable on white", #C0392B red, #0A66CF blue, #C77A2A orange). Override with `CLAUDE_STATUSLINE_THEME=light|dark`.
3. Mixed ANSI 16 (dark) and truecolor (light/blue/orange). No downsampling, no NO_COLOR.
4. Foreground-only.
5. Separator: `SEP="  |  "`, uncoloured.
6. Neighbours: hue plus pipes; each of the 3 lines has a label (`current:`, `weekly:`).
7. Yes: detection order is `$CLAUDE_STATUSLINE_THEME`, then `$COLORFGBG` (last field 7 or 15 = light), then macOS `defaults read -g AppleInterfaceStyle`, then dark. The light palette is a darker, higher-contrast set. The contrast is chosen by hand per palette, not computed.
8. Bar `█` plus eighth blocks `▏▎▍▌▋▊▉` and `─` for empty; no emoji or Nerd Font.
9. Detection chain for light/dark is the standout.
10. Env `CLAUDE_STATUSLINE_THEME`; edit script; optional `ccusage` for limits.

## gist/cc4fe8add6af41f82c1d9ec36d1f6454 (kenji4569, minimal pastel-branch statusline)
URL: https://gist.github.com/kenji4569/cc4fe8add6af41f82c1d9ec36d1f6454, stars n/a.
1. `statusline.sh`: path=`SILVER` `38;2;205;214;244` (#CDD6F4 Catppuccin Text), model=CYAN, `ctx N%`=MAGENTA, 5h/7d percent by `limit_color` (>=90 red, >=70 yellow, else green) with the reset countdown in `SAGE` `38;2;122;158;122`, cost=YELLOW, separators `|`=GRAY. Branch colour encodes git state, bold truecolor pastels: `BRANCH_CLEAN` #89B4FA blue, `BRANCH_UNTRACKED` #F9E2AF yellow, `BRANCH_MODIFIED` #F38BA8 pink, `BRANCH_ADDED` #94E2D5 teal (Catppuccin Mocha values), with a prefix `:` / `?:` / `M:` / `A:`.
2. Themes: not present as a feature; the palette is hard-coded Catppuccin Mocha for the truecolor parts.
3. ANSI 16 plus truecolor. No detection, no NO_COLOR.
4. Foreground-only.
5. Separator: GRAY `|` and `/` between 5h and 7d.
6. Neighbours: hue; branch is bold to stand out ("brighter (pastel) + bold so the branch stands out").
7. Not present.
8. ASCII only.
9. State-coded branch colour is the notable part.
10. Edit script (it mirrors the author's zsh PROMPT).

## gist/cd74f2056cc99ce618ee3f6a9f3e3476 (yoavmmn, 2-line right-aligned Nerd Font statusline)
URL: https://gist.github.com/yoavmmn/cd74f2056cc99ce618ee3f6a9f3e3476, stars n/a.
1. `statusline.sh` (assembly block `L1_LEFT`/`L1_RIGHT`/`L2_LEFT`/`L2_RIGHT`): dir=BLUE, runtime version (Node/Python)=`NODE_GREEN` `38;5;71` (#339933 brand), AWS profile=YELLOW, PR number=MAGENTA bold underlined (OSC 8 link), model=`CLAUDE_ORANGE` `38;2;204;125;94`, session name=MAGENTA, agent=YELLOW, git branch + diff=GREEN with `+N`/`-N` GREEN/RED and `N files` DIM, `bg:N`=YELLOW, bar labels `ctx`/`session`/`week`=WHITE. Bars (`make_bar`): filled `▬` coloured by threshold (>=80 RED, >=50 YELLOW, else GREEN), empty `─` DIM.
2. Themes: not present. Palette is brand-oriented (Claude orange, Node green).
3. ANSI 16 + one 256 index + one truecolor. README: "Your terminal must support these". No detection, no NO_COLOR.
4. Foreground-only.
5. Separator: DIM `|`.
6. Neighbours: hue plus Nerd Font icon per segment.
7. Not present.
8. Nerd Font icons (git 󰘬, node 󰎙, python 󰌠, AWS, PR codicon), plus `❋`; written as UTF-8 byte escapes for macOS bash 3.2. `vislen` note about double-width PUA glyphs. Non-breaking spaces (` `) used for right-alignment because Claude Code trims normal spaces.
9. Right-aligned layout using terminal width found through the parent TTY; clickable PR link.
10. Edit script; icons replaced by editing `$'\x..'` values. Setup doc only.

## gist/d053a7eebb8f87fee99133b52a811333 (phramz, gitstatus-style git info + ctx bar)
URL: https://gist.github.com/phramz/d053a7eebb8f87fee99133b52a811333, stars n/a. README has a screenshot (not viewed).
1. `claude-statusline.sh`: fixed per git fact, modelled on powerlevel10k gitstatus: branch/tag/commit=GREEN, upstream and push ahead/behind (`⇡⇣⇢⇠`) and stash `*N`=CYAN, action (merge/rebase/cherry-pick/bisect)=BOLD YELLOW, conflicts `~N`=RED, staged `+N`=GREEN, unstaged `!N`=YELLOW, untracked `?N`=BLUE. Model plain. Context bar `|` x10 with the filled part coloured by threshold (>80 RED, >30 YELLOW, else GREEN) and empty bars DIM.
2. Themes: not present.
3. ANSI 16 only. No NO_COLOR.
4. Foreground-only.
5. Separator: plain ` | `.
6. Neighbours: hue per git fact; spacing.
7. Not present.
8. Arrow glyphs `⇡⇣⇢⇠`, ASCII pipe bar.
9. Thresholds are low (30/80), so yellow is the common state.
10. Edit script.

## gist/d8e6ea13faaa0fd1d13b2103c2f31154 (Panmax, Chinese Ghostty + Claude Code guide)
URL: https://gist.github.com/Panmax/d8e6ea13faaa0fd1d13b2103c2f31154, stars n/a. Not a statusline project: a guide to Ghostty config for Claude Code with one embedded example statusline script.
1. Embedded example (`ghostty-claude-code-guide.md`, "Status Line" section): `threshold_color` (val warn=50 crit=80: GREEN / YELLOW / RED) for the context bar `▓░`; branch=CYAN, staged `+N` GREEN, modified `~N` YELLOW, lines `+N`/`-N` GREEN/RED, duration DIM, separator DIM `|`, worktree `⎇` MAGENTA; effort tag colour by level (max RED, xhigh MAGENTA, high YELLOW, medium/low DIM) as `⚡max`, `⚡xhigh`... ; model and cost plain.
2. Themes: not for the statusline. The guide recommends the terminal theme `Catppuccin Mocha` (and `light:Catppuccin Latte,dark:Catppuccin Mocha` in Ghostty).
3. ANSI 16 only; no NO_COLOR.
4. Foreground-only.
5. Separator: DIM `|`.
6. Neighbours: hue plus dim pipes.
7. Terminal-level only (Ghostty `window-theme = auto`, light/dark theme pair); nothing in the script.
8. `▓░` bar, `⚡`, `⎇`.
9. Nothing beyond the guide.
10. Edit script; Ghostty config is the larger customisation surface.

## gist/d92cd6a483c8b8683a2cd04137257866 (kaushikgopal, model + usage only)
URL: https://gist.github.com/kaushikgopal/d92cd6a483c8b8683a2cd04137257866, stars n/a.
1. `statusline.sh`: model name always `\033[90m` grey; usage text coloured by threshold (>=80 red `31`, >=60 `33` commented "orange", else `90` dark grey), so the calm state is grey.
2. Themes: not present.
3. ANSI 16 only (31/33/90).
4. Foreground-only.
5. Separator: single space.
6. Neighbours: same grey as the model until usage turns warm; deliberately low-key.
7. Not present.
8. None.
9. Output is two words; the "alternate tokens/percent by minute" branch is dead (`|| true`).
10. Edit script.

## gist/d955a0f2158a89d4431c6d3b3ca78bbd (hendrickmelo, smart-dir + ctx + 5h battery)
URL: https://gist.github.com/hendrickmelo/d955a0f2158a89d4431c6d3b3ca78bbd, stars n/a.
1. `statusline.sh`: context `(NN%)` by threshold (<=50 GREEN, <=70 YELLOW, <=85 ORANGE `38;5;208`, else RED), cost `≈$N`=CYAN, `+N/-N` GREEN/RED, 5h limit in remaining % as `🔋NN% ↻XhYm`: <10 remaining RED, <30 ORANGE, else periwinkle `38;5;146`; dir=CYAN, branch+dirty `✗`=MAGENTA, env (pixi/venv)=ORANGE, `❯`=PURPLE `95`, 200k warning RED.
2. Themes: not present.
3. ANSI 16 plus 256 indexes (208, 146). No NO_COLOR.
4. Foreground-only.
5. Separator: spaces; ends with a `❯` prompt glyph.
6. Neighbours: hue; also an emoji prefix on directory (🌿 repo, 🏠 home, 📁 other, 💾 volume).
7. Not present.
8. Emoji heavy (🌿 🏠 📁 💾 📦 🐍 🔋 ⚠).
9. Directory emoji encodes where you are (repo/home/volume).
10. Edit script.

## gist/dc35acae391da921974b35469d77ddaf (lucasmodrich, 2-line, emoji, highlights the binding limit)
URL: https://gist.github.com/lucasmodrich/dc35acae391da921974b35469d77ddaf, stars n/a.
1. `claude_statusline.sh`: `render_usage_bar`: threshold per bar with its own cut-offs (context lo=50 hi=70; 5h/7d lo=65 hi=85): green `32`, yellow `33`, red `31`. The label of the higher of 5h/7d is yellow (`binding=1`) and the other is dim white (`2;37`). Line 1: dir and branch bold cyan `1;36`, model and separators dim white `2;37`, cost `37` white.
2. Themes: not present.
3. ANSI 16 with bold/dim attributes. No NO_COLOR.
4. Foreground-only.
5. Separator: dim white `|`.
6. Neighbours: bold-cyan vs dim-white weights; bars differ by label.
7. Not present.
8. Emoji 📂 🌿 ★ 💰; bar `[███░░░]`.
9. "Binding constraint" highlight (amber label on whichever of 5h or 7d is higher).
10. Edit script (bash 4+, `mapfile`).

## gist/dcc6a1ac3c1d9695f24f846946d891f7 (rvd-gmpplus, PowerShell Claude env installer that writes a ccstatusline config)
URL: https://gist.github.com/rvd-gmpplus/dcc6a1ac3c1d9695f24f846946d891f7, stars n/a. Mostly not a statusline (a Claude Code environment setup script, `Setup-ClaudeCodeEnv.ps1`); it only writes a config for the ccstatusline package.
1. The `$statusLineConfig` JSON: model `color: "cyan"`, context-percentage `brightBlack`, session-cost `magenta`, session-clock `yellow`; git widgets have no colour set. So fixed per widget, named ANSI colours.
2. Theme: powerline theme not used (`"powerline.enabled": false`).
3. ANSI 16 names; `colorLevel: 3` (truecolor) set but unused by names.
4. Foreground-only (powerline off).
5. Plain `separator` widgets between widgets; `powerline.separators: [""]` exists but is disabled.
6. Separators only.
7. Not present.
8. Powerline glyph defined but disabled; `custom-text` "ins: " / "del: " labels.
9. Not present.
10. ccstatusline `settings.json` v3; `flexMode`, `compactThreshold`.

## gist/e061e2452573251c8dde04a44adf6323 (pwrsoft, Ukrainian one-line token/cost installer)
URL: https://gist.github.com/pwrsoft/e061e2452573251c8dde04a44adf6323, stars n/a.
1. `gistfile1.txt` (embedded statusline script): only two colours, fixed: model `\033[1;34m` bold blue and branch `\033[1;32m` bold green. The rest (tokens, cost, ctx bar `[####------]`) is uncoloured and identified by emoji (🤖 🌿 🪙).
2. Themes: not present. The installer sets Claude Code's own `"theme": "dark"` in settings.json only when it creates the file.
3. ANSI 16 bold. No NO_COLOR.
4. Foreground-only.
5. Separator: plain ` | `.
6. Neighbours: emoji and pipes.
7. Not present.
8. Emoji; ASCII bar `#`/`-`.
9. Output is deduplicated (`awk '!seen[$0]++' | head -n 1`) to cope with parallel renders.
10. Installer script; edit the heredoc.

## gist/e0f4e94073eda3c394ecab57947a67db (ArielRi, Windows ccstatusline installer with Nord powerline)
URL: https://gist.github.com/ArielRi/e0f4e94073eda3c394ecab57947a67db, stars n/a. Mostly an installer for account aliases and ccstatusline; the statusline styling is the settings object it writes.
1. `ccstatusline-install.ps1` `$SettingsObj`: fixed per widget background and foreground, all `hex:`: model `ECEFF4` on `BF616A` (Nord red), context-percentage-usable `2E3440` on `EBCB8B` (yellow), custom-command usage widget `FDF6E3` on `5E81AC` (blue), session-clock `2E3440` on `A3BE8C` (green), second-line current-working-dir `ECEFF4` on named `bgMagenta`. Text is Nord polar-night dark on light backgrounds and snow-white on dark ones, chosen by hand per cell.
2. Powerline `theme = "custom"` (ccstatusline has built-in powerline themes; this uses its own hex values). Users edit the generated JSON or use the ccstatusline TUI. The usage widget script is `usage.ps1` (writes five_hour/seven_day, cached).
3. Truecolor hex plus a named bg (`colorLevel = 3`). Depth handled by ccstatusline's `colorLevel`.
4. Background-filled cells (powerline on, `minimalistMode = $true`, `defaultPadding = " "`).
5. Powerline arrows: `$Sep = [char]0xE0B0` as both `separators` and `endCaps`, `separatorInvertBackground=[false]`; ccstatusline derives each arrow's colour from the neighbouring cell backgrounds.
6. Neighbours: four distinct backgrounds (red, yellow, blue, green) plus the arrow.
7. Hand-picked light or dark text per background; no detection.
8. Nerd Font/Powerline glyph E0B0; a `?` encoding workaround noted in the usage script.
9. Multi-account aliases (`~/.claude-*` dirs) are the installer's main purpose.
10. JSON config; ccstatusline TUI.

## gist/e12efdcf165cabd7ca01d1dccaac553d (brunohafonso, ccstatusline v4 template + custom scripts)
URL: https://gist.github.com/brunohafonso/e12efdcf165cabd7ca01d1dccaac553d, stars n/a.
1. `ccstatusline-settings.json`: fixed per widget by name, `colorLevel: 1` (ANSI 16): model cyan bold, thinking-effort magenta bold, ctx bar green bold, repo `ansi256:39` bold, branch green bold, worktree green bold, PR (git-review) cyan, session clock `ansi256:214` bold, cost yellow bold, `5h`/`7d` labels brightMagenta bold, usage bars green, reset times dim. README admits "The ctx / 5h / 7d bars have a fixed colour (no green->yellow->red thresholds)". `files.sh`/`lines.sh`/`thinking.sh` emit their own SGR: `\033[32m● N` staged green, `\033[33m✚ N` modified yellow, `+N` green / `-N` red, thinking enabled blue bold / disabled red.
2. Themes: not present; ccstatusline's powerline themes unused (`powerline.enabled: false`).
3. ANSI 16 by name, `ansi256:NNN` and `hex:RRGGBB` per widget (README), `colorLevel` 1 / 2 / 3 switch.
4. Foreground-only.
5. Separator: `defaultSeparator: "|"`, `inheritSeparatorColors: false`, padding both sides.
6. Neighbours: emoji prefix per widget, pipe, and bold/dim attributes.
7. Not present.
8. Emoji prefixes (🤖 ⚡ 🧠 📊 🔗 🌱 🌿 🔀 ⏱️ 💰 🚦), `▓░` bar via `display: slider`, `↻`, `↗` OSC 8 links.
9. Template pieces that work around ccstatusline's merge/hide behaviour.
10. ccstatusline JSON v4, edited by hand or in its TUI (reorder/recolour with live preview); `refreshInterval: 10` in the Claude Code snippet.

## gist/e43e0a6986ad1c2a75888306d10428a5 (novaross, README-style two-line)
URL: https://gist.github.com/novaross/e43e0a6986ad1c2a75888306d10428a5, stars n/a.
1. The script in `claude-cli-statusline.md`: model `[Model]` CYAN, cost YELLOW, bars (`make_bar`) coloured by threshold (>=90 RED, >=70 YELLOW, else GREEN) for context, session and week; dir, branch, duration, labels uncoloured.
2. Themes: not present.
3. ANSI 16 only.
4. Foreground-only.
5. Separator: plain ` | `.
6. Neighbours: pipes and labels (`Context:`, `Session:`, `Week:`).
7. Not present.
8. ASCII bar `#` filled and `.` empty.
9. Nothing notable.
10. Edit script; `refreshInterval: 1` in settings.

## gist/e606820ebf824249d4bc35d786344b0a (csi111, Korean, `◆ model │ bar │ ...`)
URL: https://gist.github.com/csi111/e606820ebf824249d4bc35d786344b0a, stars n/a.
1. `statusline.sh`: README table maps colour to field: model default (`◆` glyph), agent name MAGENTA, context bar by threshold (<50 GREEN, <80 YELLOW, else RED), cost and API time default, wait ratio DIM, elapsed YELLOW, project name MAGENTA, branch CYAN, lines `+N -N` DIM.
2. Themes: not present.
3. ANSI 16 only.
4. Foreground-only.
5. Separator: box-drawing `│` uncoloured.
6. Neighbours: hue for some fields, `│` between all.
7. Not present.
8. `◆`, `█░` bar of 12, `│`.
9. Nothing notable.
10. Edit script; `padding: 1` in settings.

## gist/e61d31bdfe0c6a0163c0f92fefd82b40 (tylerho5, cache TTL countdown and dual-context %)
URL: https://gist.github.com/tylerho5/e61d31bdfe0c6a0163c0f92fefd82b40, stars n/a.
1. `statusline-command.sh`: model CYAN, project path MAGENTA, branch YELLOW, `·` between. Tokens/context text coloured by threshold on the 200k-equivalent percentage (>=67 RED, >=34 YELLOW, else GREEN; README: "color-coded green->yellow->red"). Cache TTL countdown (>1200 s GREEN, >300 s YELLOW, else RED). Rate limits shown as remaining %, `color_for_remaining` (<=20 RED, <=50 YELLOW, else GREEN), so the colour scale inverts relative to the others.
2. Themes: not present.
3. ANSI 16.
4. Foreground-only.
5. Separator: ` | ` and ` · `, uncoloured.
6. Neighbours: hue (cyan, magenta, yellow) and line breaks (3 lines).
7. Not present.
8. ASCII.
9. Colour thresholds are tied to the "degraded zone" of 200k even on a 1M window.
10. Edit script; `refreshInterval: 60`; `cache_ttl` variable.

## gist/e70c94d40e3644beb6f78d3528f0a5b2 (vlazic, context + 5h rate limit + "PacePro")
URL: https://gist.github.com/vlazic/e70c94d40e3644beb6f78d3528f0a5b2, stars n/a.
1. `statusline-command.sh`: whole line is dimmed (`\033[2m` reapplied after each reset); dir=blue (`\033[2m\033[34m`), branch (`` Powerline git icon ``)=dim, model=dim; the context and 5h segments are colour by threshold (>=80 red `31`, >=60 yellow `33`, else green `32`); pace indicator `▲` red (spending faster than even), `▼` green (slower), `─` dim (within 5 points).
2. Themes: not present.
3. ANSI 16 + dim attribute. No NO_COLOR.
4. Foreground-only.
5. Separator: dim `│`.
6. Neighbours: dim vs bright; only the two meters are saturated, the rest recede.
7. Not present.
8. Powerline branch glyph (README: "font with Powerline icons (optional, for the git icon)"), `█░` bars 10 wide, `▲▼─`.
9. Pace arrow with a 5% dead zone to avoid flicker.
10. Edit script.

# Batch 29 — gist statuslines, styling read from source

All entries are GitHub gists (stars n/a). Anchors are gist file + function/variable name (gists have no stable line numbers via the API). "Unverified" marks claims taken from a README, or from a ccstatusline reference rather than ccstatusline's own source. Common pattern across most plain-shell gists here: ANSI-16 foreground only, no bg, no themes, no NO_COLOR, no separators beyond ` | `/` · `/spaces, and the only dynamic colour is a green/yellow/red threshold on a percentage.

## davegallant/151b01b3c22db989fd870269aeba1654
https://gist.github.com/davegallant/151b01b3c22db989fd870269aeba1654 — stars n/a
1. Fixed per segment plus threshold: `statusline-command.sh` `parts+=` blocks: directory `\033[36m` cyan, git branch `\033[32m` green, model `\033[33m` yellow. Context bar threshold: `used_int >= 80` red `\033[31m`, `>= 50` yellow, else green; the whole bar+label `[████░░░░░░] 12.3% (a / b)` takes that one colour.
2. Themes: not present.
3. ANSI 16 foreground only (`\033[3Xm`). No depth detection, no NO_COLOR.
4. Foreground-only text on the terminal's own background.
5. Separator: a single space (`IFS=' '` join of `parts[*]`). No colour of its own.
6. Neighbours distinguished by different hues (cyan/green/yellow) plus spaces.
7. Light/dark adaptation: not present (plain ANSI 16 relies on the terminal palette).
8. Glyphs: `█` and `░` block bar (10 cells); no emoji/Nerd Font.
9. Nothing else (no gradient/animation). Bar fill is `used_int/10` cells.
10. Customisation: edit the script; no config file/flags/env.

## Petri-Hub/1701bc7f2c096b78331ce66a5e418020
https://gist.github.com/Petri-Hub/1701bc7f2c096b78331ce66a5e418020 — stars n/a
1. Fixed per segment via a ccstatusline config (`settings.json`): model `white` bold, thinking-effort `brightRed`, total-speed `cyan`, context-bar `brightBlack`, session-usage `brightBlue`, worktree-mode/worktree-name `yellow`, git-branch `brightRed`, git-changes `brightGreen` with `"dim":"parens"`, free-memory `black`. session-clock/separators have no colour (terminal default). Colours are static per widget; any threshold colouring lives inside ccstatusline (not read here).
2. Themes: `powerline.theme` absent and `powerline.enabled: false`; no theme used. (ccstatusline itself has powerline themes; see grigarr entry.)
3. ccstatusline names: `"colorLevel": 2` (256) with ANSI names (`brightRed`…). No hex used. NO_COLOR: not present in this gist.
4. Foreground-only (no `backgroundColor` keys; powerline off).
5. Separators are widgets: `separator` with `character` `-` and `|` or default; `flex-separator` pushes items to the right edge. `inheritSeparatorColors: false`, so separators are uncoloured. (`ccstatusline.sh` is only a PATH-resolving launcher; `install.sh` writes `~/.config/ccstatusline/settings.json`, sets `refreshInterval: 10`.)
6. Neighbours: different ANSI hues per widget plus `|`/`-` separators.
7. Adaptation: not present (ANSI names only; `black` widget on dark terminals would vanish — author's choice).
8. No Nerd Font (powerline off); `defaultPadding: ""`.
9. Nothing else.
10. Customisation: ccstatusline JSON v3 config; `installation.method: pinned`, version 2.2.22.

## plribeiro3000/17354a5214a97f59c8fef9e37b30c87e
https://gist.github.com/plribeiro3000/17354a5214a97f59c8fef9e37b30c87e — stars n/a
1. By threshold, one colour for the bar: `statusline.sh` `USAGE_PCT >= 90` red `\033[31m`, `>= 70` yellow, else green. The usage % is computed relative to the autocompact limit (`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`, default 90), so colour tracks "distance to autocompact", not raw window use. Model/token text is uncoloured.
2. Themes: not present.
3. ANSI 16 foreground; `printf '%b'` with `\033[..m`. No NO_COLOR.
4. Foreground only.
5. Separators: none (`[Model · 200K] ####------ 92K/140K left`; `·` is plain text).
6. Neighbours: only the coloured bar vs uncoloured text.
7. Not present.
8. ASCII bar `#` and `-` (10 cells), no emoji.
9. Nothing else.
10. Customisation: edit script; env `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` changes the denominator (README).

## submtd/1a1e065c589943049d405d5b869534ed
https://gist.github.com/submtd/1a1e065c589943049d405d5b869534ed — stars n/a
1. Fixed per segment plus threshold (`statusline-command.sh`): directory basename `CYAN` `\033[36m`; `git:(branch)` `GREEN`, `✗` dirty marker `RED` (oh-my-zsh robbyrussell style); model `BOLD`+`CYAN`; labels `Context`/`Usage` `BOLD`. `make_bar`: `pct>=80` RED, `>=50` YELLOW, else GREEN for filled blocks `█`; empty blocks `░` in `DIM`; percentage `BOLD`. Reset countdown `↻2h14m` `DIM`. Missing data prints `n/a` in `DIM`.
2. Themes: not present.
3. ANSI 16 + bold/dim attributes (variables `RESET DIM BOLD GREEN YELLOW RED CYAN`). No depth detection, no NO_COLOR.
4. Foreground only.
5. Separators: double-space between items; no glyph separators.
6. Neighbours: hue (cyan dir vs green git) and whitespace; line 2 uses bold labels.
7. Not present; `DIM` is used for de-emphasis on any background.
8. `█`/`░` bars (width `BAR_WIDTH=20`), `↻`, `✗`. No Nerd Font/emoji.
9. Two-line layout (line 1 dir/git/model; line 2 two bars). README: "Tweak `BAR_WIDTH` and the color thresholds near the top of the script".
10. Customisation: edit script constants; installer `install.sh` merges `statusLine` into settings.json with jq.

## andrewcummings/1bc03edc9d0dcd42a1dfd0f91ab6be5f
https://gist.github.com/andrewcummings/1bc03edc9d0dcd42a1dfd0f91ab6be5f — stars n/a
1. Fixed per segment plus threshold (`statusline.js`): repo name cyan `\x1b[36m`, branch magenta `\x1b[35m`, `|` separators and model name grey `\x1b[90m`. `progressBar(pct)`: `<=50` green, `<=80` yellow, else red; token count `current/max` uses the same colour as the bar (`tokenColor` computed with an identical if-chain, duplicated rather than shared).
2. Themes: not present.
3. ANSI 16 incl. bright-black (90) foreground. No depth detection, no NO_COLOR.
4. Foreground only.
5. Plain-text `|` in grey (separator colour = fixed grey, independent of neighbours); `⎇` glyph joins repo and branch.
6. Neighbours: cyan vs magenta vs grey, `|` dividers.
7. Not present.
8. `█`/`░` bar width 20 (default arg), `⎇`.
9. README says the code is meant to be edited by asking Claude to modify it (customisation table: bar width, ANSI codes, final `console.log`).
10. Customisation: edit JS. Format string is the last `console.log`.

## Pduhard/1e227fe30a212d09063aa3ecb023000a
https://gist.github.com/Pduhard/1e227fe30a212d09063aa3ecb023000a — stars n/a
1. By state/threshold only: `statusline.sh` `format_rl`: `pct >= 90` RED `\033[31m`, `>= 70` YELLOW, else GREEN, applied to the whole `5h ██████░░░░ 62% resets 3:10PM` rate-limit text. Git segment: `+N` staged GREEN, `~N` modified YELLOW. Everything else (model, effort, context, dir, worktree, plan) is uncoloured; icons carry the meaning (`🤖 💪 🧠 ⏱️ 📁 🌳 🌿`).
2. Themes: not present.
3. ANSI 16 foreground. No NO_COLOR.
4. Foreground only.
5. Separator: plain ` | `, no colour. Two lines joined by `\n`.
6. Neighbours: emoji prefixes + ` | `.
7. Not present.
8. Emoji-heavy (🤖💪🧠⏱️📁🌳🌿🏢🏠); no ASCII fallback. Bar `█░` width 10.
9. Optional plan indicator by env `CLAUDE_PLAN=team|perso`.
10. Customisation: edit script; env `CLAUDE_PLAN`.

## ArielRi/1f70230c8cdbbe8a6f1ba2a900f12420
https://gist.github.com/ArielRi/1f70230c8cdbbe8a6f1ba2a900f12420 — stars n/a
Installer for ccstatusline (with a Claude usage `custom-command` widget and multi-account shell aliases). Its styling lives in the generated ccstatusline config (heredoc at "ccstatusline runtime & settings" in `ccstatusline-install.sh`).
1. Fixed per segment, background-filled, hex: model fg `hex:ECEFF4` on bg `hex:BF616A`; context-percentage-usable `2E3440` on `EBCB8B`; custom-command (usage.sh) `FDF6E3` on `5E81AC`; session-clock `2E3440` on `A3BE8C`; line 2 current-working-dir fg `ECEFF4` on `bgMagenta` (ANSI name — the only non-hex bg). These are the Nord palette (aurora reds/yellows/greens + frost blue), hand-assigned per widget; dark text on light bgs, light text on dark bgs, chosen by hand per segment.
2. Themes: `"powerline": {"theme": "custom"}` — i.e. its own per-widget colours rather than a ccstatusline built-in theme.
3. `"colorLevel": 3` (truecolor) with `hex:` and ANSI names mixed. The installer's own messages honour `NO_COLOR` and `[ -t 1 ]` (`C_RESET` etc. emptied) — that is installer output, not the statusline.
4. Background-filled cells with powerline.
5. Powerline arrow U+E0B0 generated via `node -e String.fromCharCode(0xE0B0)` into `separators` and `endCaps`; `separatorInvertBackground: [false]`; ccstatusline draws arrow fg/bg from adjacent segment bgs (per the ccstatusline reference in the kensongzhu gist).
6. Neighbours: four distinct hues per row, arrows.
7. Hand-picked contrast pairs only; no automatic text choice.
8. Powerline/Nerd glyph required (E0B0). `minimalistMode: true`.
9. Installer UI uses coloured section banners (`▸`, `✓`, `!`, `✗`, box-drawing banner).
10. Customisation: ccstatusline JSON (version 3) written by the script; `flexMode: full-until-compact`.

## ondrasek/1f801107be6b7e391b488c723b125260
https://gist.github.com/ondrasek/1f801107be6b7e391b488c723b125260 — stars n/a
1. By semantic alias role (the best role-naming in this batch), `statusline.sh` section 1: `C_TITLE` (labels, white 220,220,220), `C_EMPTY` (dim 80), `C_VALUE` (cyan 46,149,153: percentages, costs, language versions, git branch, dir), `C_ACCENT` (orange 255,176,85: token counts, agent name, vim mode, ETA, worktree name), `C_GOOD` (green 0,160,0: clean, passing, lines added), `C_BAD` (red 255,85,85: failing, compaction, lines removed), `C_WARN` (yellow 230,200,0: pending, stash count, concurrent sessions), `C_MUTED` (dim: separators, brackets, bar empties, reset times), `C_MODEL` (blue 0,153,255). Comment: "change one line here to restyle globally". Segments are therefore coloured by meaning (value/accent/good/bad/warn/muted) not per segment name. Context/usage bars `color_for_pct`: `>=90` BAD, `>=70` WARN, `>=50` ACCENT (orange), else GOOD — four stops. PR status icons `✓ ⊘ ✗` in GOOD/WARN/BAD; hook events decorated with the same three.
2. Themes: not present as a switch, but the alias block is a single-file palette ("oh-my-posh inspired true-color palette").
3. Truecolor foreground `\033[38;2;R;G;Bm`. No depth detection, no NO_COLOR.
4. Foreground only.
5. Separator: `sep=" ${C_MUTED}|${C_RESET} "` — fixed muted colour.
6. Neighbours: labels white vs values cyan vs accents orange; each `label: value` pair alternates title/value colour.
7. Not present; palette is mid-lightness truecolor, `C_DIM` (80,80,80) is dark and would be low-contrast on dark backgrounds.
8. Unicode only: `█░`, `✓ ⊘ ✗ ⚠ →`. No emoji/Nerd Font.
9. Multi-line, verbose (hooks, rules, git worktrees, PR CI state, language version). Fallback trap prints plain `Claude` on any error.
10. Customisation: edit the alias block; env `MAX_THINKING_TOKENS`; cache TTL constants.

## shikhar1verma/218b4b556fffad8a9ff2759fe4c41293
https://gist.github.com/shikhar1verma/218b4b556fffad8a9ff2759fe4c41293 — stars n/a
1. Fixed plus threshold (`claude-code-statusline-setup.md`, script in markdown): model `BOLD`+`CYAN` `\033[36m`; context % `PCT_COLOR` red `>=80`, yellow `>=50`, else green; "ctx" label and token counts `DIM`. Allowance segments are inverted: `limit_part` colours by percent LEFT: `<=20` red, `<=50` yellow, else green (`5h 86% left`, `weekly 96% left`). A quota segment is hidden when absent.
2. Themes: not present.
3. ANSI 16 + bold/dim. No NO_COLOR.
4. Foreground only.
5. Separator: two spaces.
6. Neighbours: dim labels vs coloured values; whitespace.
7. Not present.
8. No glyphs beyond text.
9. Document is written as a runbook for an AI agent (steps, validation with `bash -n`, mock JSON test); verified against Claude Code 2.1.207. Strips `[1m]` style bracket suffix from model name via `sed`.
10. Customisation: edit script; `~/.claude/settings.json` `statusLine`.

## funivan/2525251a72d8c4e7a435bea7ddafcde7
https://gist.github.com/funivan/2525251a72d8c4e7a435bea7ddafcde7 — stars n/a
1. Threshold for bars, fixed for the rest (`statusline.sh`): palette `G` green 140,194,74 (the `★ model ★`), `Y` yellow 220,200,60, `RD` red 220,60,60, `D` dim 55,55,55 (unfilled bar + `|` separators), `DG` dark grey 101,101,101 (bar fill below 50%), `W` light grey 180,180,180 (text). `bar()` picks fill colour: default `DG`, `>=50` Y, `>80` RD; unfilled cells are the same `█` glyph in `D` (so the bar is a solid-block bar drawn in two near-black shades, not a light/shade glyph pair).
2. Themes: not present.
3. Truecolor foreground `38;2`. No depth detection, no NO_COLOR.
4. Foreground only (but uses `█` in a dim colour to simulate a track).
5. Separator: ` | ` in `D` (55,55,55) — very low contrast on dark terminals, dark on light ones (not adapted).
6. Neighbours: green model vs grey numbers, dim pipes.
7. Not present.
8. `█`, `★`, `♻️` emoji; token counts as `IN:` `OUT:`.
9. Subtle: low-contrast "track" instead of a distinct empty glyph.
10. Customisation: edit script; `settings.json` has `statusLine` with `padding: 0`.

## gu7araujo/264d4a8bd1fd587858c2072a8f278b35
https://gist.github.com/gu7araujo/264d4a8bd1fd587858c2072a8f278b35 — stars n/a
Not a styling-focused statusline: it is a full `claude-code-default-settings.json` (permissions, hooks, voice, `"theme": "dark"`). Its inline `statusLine.command` is a jq/bash one-liner that prints plain text `[session] | [model] | ctx tokens context | branch` and switches to two lines when `${#full} > $(tput cols)`. Styling: 1 none (no ANSI at all); 2 none; 3 none (no colour); 4 text only; 5 plain ` | `; 6 brackets/pipes; 7 the `theme: dark` key is Claude Code's own UI theme, not read by the statusline; 8 none; 9 width-based wrapping via `tput cols` (the only layout adaptation); 10 customisation: edit JSON string. Mentions `CLAUDE_CODE_PLUGIN_DIRS=~/.claude/mods/context-bar` (a separate mod, not included).

## WillKoehrsen/29fddff059eaa1d60ad07e07a3e1fedd
https://gist.github.com/WillKoehrsen/29fddff059eaa1d60ad07e07a3e1fedd — stars n/a
A ccstatusline layout plus two custom-command widgets (grid prices, weather).
1. Mixed: `settings.json` model `cyan`, context-bar `brightBlack`, others uncoloured. The distinctive part is `grid_snapshot.sh`: a fuel-mix bar whose colour is DATA-assigned per fuel (jq table `$styles`, truecolor): gas `16;90;218`, coal `179;80;15`, oil `164;121;96`, multiple_fuels `7;73;85`, nuclear `125;197;48`, hydro `12;167;167`, wind `66;128;0`, solar `255;200;0`, other_renewables `202;43;178`, storage `135;67;203`, other `222;59;113`; unknown fuels `138;138;138`. Colours "match the fuel mix charts on gridstatus.io" — a fixed colour per category (the answer to "consistent colour per specific thing").
2. Themes: none; `powerline.enabled: false`.
3. Truecolor required for the widget (`38;2;r;g;b`, README: "A terminal with 24-bit color"); config `colorLevel: 2`. `"preserveColors": true` on the widget is required, otherwise ccstatusline strips the script's colours. No NO_COLOR.
4. Foreground only (`█` runs coloured via fg).
5. Separators: ccstatusline `separator` widgets (default `|`); no colour.
6. Neighbours: category colours inside the bar; separators elsewhere.
7. Not present.
8. `█` bars (20 cells, remainder-apportioned so the bar is always exactly 20 wide), `°F`.
9. Network stale-while-revalidate caching so rendering never blocks. Largest-remainder cell allocation for proportional colour bars.
10. Customisation: `bar_width`, `top_count`, `price_location` in the script; ccstatusline JSON v4.

## takeshitayy/2a652b3253920560227c56d0d0c27d52
https://gist.github.com/takeshitayy/2a652b3253920560227c56d0d0c27d52 — stars n/a
1. Fixed plus threshold (`claude-statusline.sh`): model `CYAN` `\033[36m`; branch name `CYAN`; staged `+N` GREEN; modified `~N` YELLOW; cost YELLOW; account/pipes/labels `DIM \033[2m`; ctx bar `[####-----]` `BAR_COLOR`: `>=90` red, `>=70` yellow, else green. Usage bars (`usage_bar`): `>=80` red, `>=50` yellow, else green — NOTE different breakpoints (70/90) for ctx vs (50/80) for usage within one script. Unavailable values render `[----------] --` in DIM.
2. Themes: not present.
3. ANSI 16 + dim. No NO_COLOR.
4. Foreground only.
5. Separator: ` | ` in DIM.
6. Neighbours: dim pipes between cyan/plain items.
7. Not present.
8. ASCII bars `#`/`-` in brackets; Japanese text label `相当`.
9. Reads account email from `.claude.json`; fetches `/api/oauth/usage` (60 s cache) for 5h/7d/sonnet bars.
10. Customisation: edit script; per-profile `~/.claude-{profile}/` location.

## grigarr/2b2e461933a5b0fd12215236a467ff08
https://gist.github.com/grigarr/2b2e461933a5b0fd12215236a467ff08 — stars n/a
ccstatusline config share (`ccstatusline-share.md`).
1. Partly theme-assigned: `powerline.theme: "nord-aurora"` auto-assigns segment fg/bg by cycling through the theme's palette (per the kensongzhu reference: "auto-assigns segment foreground/background colors (cycling through the theme's palette) when widgets don't set their own"). So colour is by position. Widgets that set `backgroundColor` (session-cost `bgRed`, session-clock `bgBrightMagenta`) override the theme per widget; widgets that set `color` (context-length `brightBlack`, git-branch `magenta`, git-changes `yellow`, model `cyan`) override fg. The README says ctx goes green→yellow→red (unverified; no such key in the config).
2. Themes: uses the built-in `nord-aurora`; cannot see ccstatusline's theme list here (unverified beyond one name). `continueThemeAcrossLines: true`.
3. `colorLevel: 2` (256), ANSI names.
4. Background-filled powerline cells.
5. Powerline arrow U+E0B0 in `separators`, `separatorInvertBackground: [false]`, `autoAlign: true`.
6. Neighbours: palette cycling gives each segment a different aurora hue plus arrows.
7. Not present beyond the theme's own pairs.
8. Powerline/Nerd glyph; `⎇` etc. in widget labels.
9. TUI: `npx ccstatusline@latest` opens the config UI. Uses `--hook` PreToolUse/UserPromptSubmit hooks for a skills widget.
10. Customisation: `~/.config/ccstatusline/settings.json`, interactive TUI.

## kensongzhu/2c2dafbedf1302f135d87de24b47bb7c
https://gist.github.com/kensongzhu/2c2dafbedf1302f135d87de24b47bb7c — stars n/a
A written reference for ccstatusline 2.2.19 plus a personal `settings.json`. Useful because it documents ccstatusline's colour model second-hand (ccstatusline source itself not read here).
1. Fixed per widget in the user's `settings.json`: hand-picked hex warm palette: model `hex:cc785c` (bold), dir `e8dcc4`, branch `c5a253`, git-changes `8a9a5b`, ahead/behind `7a9595`, tokens in `7a8450`, out `c5a253`, cache `8a9a5b`, timers/labels `6b5d4e`, block usage `b78a3c`, weekly `b88a7e`. Muted brown `6b5d4e` is reused for all punctuation/labels (bracket text widgets `[ ` ` ]` `⟦ ⟧`), so labels recede and values pop. ccstatusline docs: no per-widget threshold colouring documented in this reference.
2. Themes: powerline `theme` named theme cycles colours when widgets don't set their own (reference, "Powerline mode"); personal config sets `powerline` off.
3. Documented: `colorLevel` 1=16, 2=256, 3=truecolor (default 2). Values: ANSI names (`black`…`brightWhite`, `default`), and at level 3 `hex:RRGGBB` (no `#`), `ansi256:N`. `overrideForegroundColor`/`overrideBackgroundColor` override every widget and separator. No NO_COLOR mention.
4. Both: widgets have `color` and `backgroundColor`; powerline fills bg.
5. Documented: explicit `separator` widgets, optional `defaultSeparator` auto-insert, `inheritSeparatorColors`, powerline `separators` array cycling per line, `separatorInvertBackground`, `startCaps`/`endCaps`, `autoAlign`. `formatSeparator()` auto-pads `|` `,` `-`.
6. Neighbours: powerline arrows appear "between widgets with different `backgroundColor`" (documented), otherwise separators.
7. `overrideForegroundColor` is a global recolour; no auto-contrast documented.
8. Nerd Font optional via `metadata.nerdFont` for compaction/voice/vim widgets; powerline requires patched font. Context bar styles `progress` / `progress-short` / `slider` (`▓░`).
9. `globalBold`, `minimalistMode` (raw values, no labels), `merge`/`no-padding` to glue widgets, `flex-separator`.
10. Customisation: JSON config + TUI; `custom-command` runs a shell command (stdout colours stripped unless `preserveColors`).

## pranav2012/2c5d7e0fb6960a64de2b8a729ad5f6cc
https://gist.github.com/pranav2012/2c5d7e0fb6960a64de2b8a729ad5f6cc — stars n/a
1. Fixed plus threshold (`statusline-command.sh`): model `⬢ Sonnet 4.6` cyan `\033[36m`; `↑` green, `↓` red (token direction arrows, numbers uncoloured); session cost: green `<$3`, yellow `>= $3`, red `> $12` (editable thresholds); context bar `build_bar`: green `<50`, yellow `<80`, else red; rate-limit bars use `build_bar_remaining` (inverted, by percent REMAINING: green `>50`, yellow `>20`, else red); extra-usage `💳` text green/yellow `>=50`/red `>=80`. Two colour logics for two bar kinds: used vs remaining.
2. Themes: not present.
3. ANSI 16 foreground. No NO_COLOR.
4. Foreground only.
5. Separator: ` · ` plain text (default colour), joined in the final loop.
6. Neighbours: emoji prefixes plus `·`.
7. Not present.
8. Braille bars `⣿`/`⣀` (4/6/10 cells), emoji `🧠💰📆💳⏱`, `⬢`. README requires an emoji-capable terminal.
9. Different bar widths by importance (10 ctx, 6 five-hour, 4 weekly).
10. Customisation: edit script constants (`CACHE_TTL`, cost thresholds, README). Note README installs via `statusCommand` key (not `statusLine`; likely wrong — unverified).

## ingara/2e5e9c041351700c713093e96205b9cb
https://gist.github.com/ingara/2e5e9c041351700c713093e96205b9cb — stars n/a
1. By semantic Base16 slot (`claude-statusline.sh` "palette"): `base03` muted (labels/separators) `6e6a86`; `base08` red (over budget, behind upstream, conflicts) `eb6f92`; `base09` orange (approaching budget, agent) `f6c177`; `base0A` yellow (unstaged) `f6c177`; `base0B` green (branch, staged, clean) `31748f`; `base0C` cyan (meters at rest, ahead) `9ccfd8`; `base0D` blue (repo) `3e8fb0`; `base0E` magenta (model, effort, worktree) `c4a7e7` (Rosé Pine). Segment→slot is fixed: repo BLU, worktree MAG, branch GRN, `+N` staged GRN, `~N` unstaged YEL, `?N` untracked DIM, `!N` conflicts RED, `↑N` ahead CYA, `↓N` behind RED, clean `✓` GRN, model MAG, agent ORG, output style DIM. Meters (`heat()`): cyan at rest, `>=70` orange, `>=90` red.
2. Themes: one default palette; user overrides by `$XDG_CONFIG_HOME/claude-statusline/theme.env` with bare hex `base03,base08..base0E` (parsed, not sourced, for safety; invalid hex lines ignored). install.md tells an agent to generate theme.env from a user's existing base16/stylix/catppuccin scheme (catppuccin mentioned). This is the closest to cc-candybar's "theme role maps to segment" in the batch: 8 slots, role-named in comments.
3. Truecolor foreground via `setcolor` (`\e[38;2;R;G;Bm`). No depth detection, no NO_COLOR.
4. Foreground only.
5. Separator: `│` in DIM between identity line halves, `·` in DIM between model/effort/agent, three spaces between meters; no powerline.
6. Neighbours: role colours; each chip prefix (`⧉`, `▸`, `✎`, `⇥`) in the same role colour.
7. Not present (palette chosen for dark; user remaps via theme.env).
8. `▓░` bars (width 10) plus `┃` pace marker (colour of fill) showing even-burn position; `⧉ ▸ ✎ ⇥ │ ✓`; comment on East-Asian-ambiguous glyph widths so bar width is stable.
9. The pace marker is the notable element: where usage would be if burned evenly. Reset shown as wall-clock, not countdown.
10. Customisation: `theme.env`; env `CLAUDE_STATUSLINE_DEBUG=<path>` dumps raw payload.

## rarestg/3592a553adde3ee97e95df59ee3e35c2
https://gist.github.com/rarestg/3592a553adde3ee97e95df59ee3e35c2 — stars n/a
Superseded ccstatusline setup (README tells users to use `rarestg/claude-statusline` instead).
1. Fixed per segment, ansi256 (`ccstatusline.json`): model `ansi256:99`; thinking-effort `30`; branch (custom script) `38;5;169` magenta, wrapped in an OSC-8 link to `pr.url` when a PR exists; git-changes `136`; session-cost `28`; context-bar `32`; agent name `166`; session id `244`. Every colour "has at least 3:1 contrast against both a light (#f5f5f5) and a dark (#1e1e1e) background" (README) — i.e. colour chosen to work on both terminals, one fixed colour per segment, no thresholds.
2. Themes: not present. README: "The colors are fixed values. They don't follow your terminal theme."
3. 256-colour (`colorLevel: 2`, `ansi256:N`). No NO_COLOR.
4. Foreground only; powerline disabled.
5. ccstatusline `separator` widgets (default); not coloured.
6. Neighbours: separate hues across 256-palette plus separators.
7. Explicit light/dark constraint: ≥3:1 contrast against both `#f5f5f5` and `#1e1e1e` (README claim; ratios not re-computed here).
8. `⎇` glyph; no Nerd Font.
9. OSC-8 hyperlink on the branch to the open PR.
10. Customisation: ccstatusline JSON v4 and TUI (`ccstatusline --config ~/.claude/ccstatusline.json`); branch colour is an escape code in `statusline-branch-pr.sh`.

## DerekLiang/3634a6b7627a26c523409ae4d2daeba9
https://gist.github.com/DerekLiang/3634a6b7627a26c523409ae4d2daeba9 — stars n/a
Near copy of the Pduhard script (identical structure) with a cost field added.
1. Same as Pduhard: only the rate-limit text (`format_rl`: `>=90` RED, `>=70` YELLOW, else GREEN) and git `+N` GREEN / `~N` YELLOW are coloured. Context `🧠` and cost `💰` (`block_str="$"cost`) are uncoloured.
2. Themes: not present. 3. ANSI 16 (`GREEN YELLOW RED RESET`); no NO_COLOR. 4. Foreground only. 5. Plain ` | `. 6. Emoji prefixes. 7. Not present. 8. Emoji everywhere (`🤖💪🧠💰⏱️📁🌳🌿`); `█░` bar width 10. 9. Nothing else. 10. Edit the script.

## mochery/365faf8578e086f79815dd7ed8a9e8c8
https://gist.github.com/mochery/365faf8578e086f79815dd7ed8a9e8c8 — stars n/a
not a Claude statusline: a Claude Code mod ("MochTools", TSX plugin plus an LLM-wiki setup prompt) that adds a button in the footer under the prompt and a tool pane. For reference, its styling (`mochtools-kit.tsx`): colours are the engine's own theme KEYS, not RGB — `THEME = { border: 'promptBorder', muted: 'subtle', good: 'success', warn: 'warning', bad: 'error' }` (comment: "they follow the light/dark theme on the terminal and the desktop alike"); per-tool accents are also theme keys (`KB.accent: 'remember'`, shell accent `'suggestion'`); one-line framed strip `borderStyle="round" borderColor={accent}`; glyph `◆`. This is semantic-role colouring resolved by the host, the same model as cc-candybar's palette roles.

## MarlzRana/3a4f4106311ce394a847529f058cd11f
https://gist.github.com/MarlzRana/3a4f4106311ce394a847529f058cd11f — stars n/a
1. Fixed per segment plus threshold plus per-model (`custom_statusline.sh`): directory bold cyan `\033[1;36m`; `git:` `(` `)` bold blue `\033[1;34m`, branch bold red `\033[1;31m` (oh-my-zsh robbyrussell look), dirty `✗` bold yellow; context bar and percent `>=75` bold red, `>=50` bold yellow, else bold green (same colour for bracket, bar, `%`); token text bold magenta `\033[1;35m`; model name `[name]` coloured BY MODEL FAMILY (`model_id` match): claude → bold orange `\033[1;38;5;208m`, gemini → bold blue, openai/gpt → bold white, else bold grey `\033[1;90m`.
2. Themes: not present.
3. ANSI 16 + one 256-colour index (208). No NO_COLOR.
4. Foreground only (all bold).
5. Separator: single spaces; brackets `[ ]` around the bar.
6. Neighbours: hue differences (cyan/blue-red/orange/green/magenta), all bold.
7. Not present.
8. ASCII bar `=` / `-` width 20; a configurable `status_emoji` (default 🚀).
9. Layout adapts: if dir+git text exceeds 50 characters (`first_line_length`) the model+context part moves to a second line.
10. Customisation: edit script (`status_emoji` var).

## joepreludian/3b218674b3d65c7625b8eb51f77a7b5d
https://gist.github.com/joepreludian/3b218674b3d65c7625b8eb51f77a7b5d — stars n/a
1. Fixed bg per badge plus threshold bg (`statusline-command.sh`): tokens `BG_CYAN \033[46m` + black text; model `BG_BLUE \033[44m` + white text; branch `BG_ORANGE \033[48;5;208m` + black text with `⎇`; context/5h/weekly badges bg by used%: `>=85` `BG_RED`+white, `>=60` `BG_YELLOW`+black, else `BG_GREEN`+black; missing data `BG_GRAY \033[100m`+white (`ctx: --`). Text colour is chosen by hand per bg (white on red/blue/gray, black on cyan/yellow/green/orange). `prompt.md` shares the same spec in prose.
2. Themes: not present.
3. ANSI 16 backgrounds plus one 256 (208). No NO_COLOR.
4. Background-filled pills (`printf "${bg}${fg} %s ${RESET}"`), one space of padding inside each.
5. Separator: a plain space between pills (no arrows/caps) — each badge's bg ends at RESET.
6. Neighbours: different bg hues; but the three data badges (ctx/5h/wk) turn the SAME green/yellow/red together when thresholds match, so adjacent identical colours merge visually (no divider between them except the space).
7. Hard-coded black/white text per background; no adaptation to terminal bg (bg-filled badges are self-contained so this works on both).
8. `⎇` only.
9. Prompt-shareable spec (`prompt.md`) lets another user regenerate the script.
10. Customisation: edit script or the prompt; no config.

## thfrench/3c1470f7dcabfcf5b455d2f693d1b812
https://gist.github.com/thfrench/3c1470f7dcabfcf5b455d2f693d1b812 — stars n/a
1. By threshold (`install-statusline.sh`, embedded script): colour of the bar and `[====....] N%` text only: `EFFECTIVE_PCT >= 85` red `\033[31m`, `>= 60` orange `\033[38;5;214m`, else grey `\033[90m`. The calm state is dim grey (quiet when safe), warming to orange then red. Model name `BOLD`; separators and raw % `DIM`. The percent is rescaled to the autocompact threshold (84 default, env `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`) when autocompact is on; shown capped as `95%+`.
2. Themes: not present.
3. ANSI 16 + one 256-colour index (214). No NO_COLOR.
4. Foreground only.
5. Separator: `  |  ` in DIM.
6. Neighbours: bold model vs coloured bar vs dim pipes.
7. Grey calm state `\033[90m` is theme-dependent (bright black); no adaptation.
8. ASCII bar `=` / `.` width 20; compaction counter `(xN)` in DIM.
9. Detects compaction by comparing against a state file (`/tmp/claude-statusline-<id>`: pct dropped >20 points).
10. Customisation: edit script; env override for threshold; installer merges `statusLine` with jq.

## kirimajiro/3e3e20c23bc527b830b8d8d8f1196a82
https://gist.github.com/kirimajiro/3e3e20c23bc527b830b8d8d8f1196a82 — stars n/a
1. Fixed per segment, bg-filled, one palette role per segment (`statusline.py` `COLORS` dict): model Mauve `#cba6f7` (203,166,247), ctx Peach `#fab387`, git Green `#a6e3a1`, 5h+7d limits Blue `#89b4fa`, per-model weekly (e.g. Fable) Red `#f38ba8`. Segment colour does NOT depend on value (no thresholds): the ctx/limit state is shown by a block bar instead. Text on every segment is the same dark `FG_BASE` `#1e1e2e` (Catppuccin base).
2. Themes: one hard-coded theme, Catppuccin Mocha (dict of 5 entries; README table). Format: per-segment colour map in Python; user edits the dict. No theme switch.
3. Truecolor only (`\033[38;2;…m` / `\033[48;2;…m`, helpers `fg()`/`bg()`). No downsampling, no NO_COLOR. README requires Nerd Font.
4. Background-filled segments with dark text.
5. Powerline arrow U+E0B0 (`SEP`), `render()`: after each segment emit `bg(next_color) + fg(this_color) + SEP`; at the end `RESET + fg(color) + SEP + RESET` — arrow colours derive mechanically from the two adjacent segment colours (no separate arrow colour setting).
6. Neighbours: five distinct Catppuccin hues. README note: 5h and 7d are merged into one segment `5h:  2%·7d: 22%` because "if 5h and 7d were the same colour the powerline separator between them would be invisible" — the author hit the same-adjacent-colour problem and solved it by merging, not by shade steps.
7. Fixed dark text on pastel backgrounds (all five pastels have high luminance, so contrast is by construction; no computation).
8. Nerd Font/powerline glyphs, `⎇`, block bars `█` 4 cells; the bar inside a segment uses two shades of the SEGMENT's own colour: filled = `darken(bg, 0.55)`, empty = the bg colour itself (`bar()` in `statusline.py`) — a lightness step within a hue rather than a separate colour.
9. Effort level appended to model (`Opus·xhigh`, optional short `XH`); fixed-width right-aligned % so segments do not shift; Japanese README.
10. Customisation: constants at top of file (`COLORS`, `BAR_W`, `EFFORT_DISPLAY`, `GIT_CACHE_TTL`); `refreshInterval` optional in settings.json.

## DerekLiang/43008157b1608614506398e073b666a2
https://gist.github.com/DerekLiang/43008157b1608614506398e073b666a2 — stars n/a
Another variant of the Pduhard script, adding a GitHub Actions minutes meter.
1. Threshold only: `format_rl` `>=90` RED, `>=70` YELLOW, else GREEN for rate limits; the added `CI ██░░ used/total min (N%)` segment uses the same three-stop rule (`actions_pct`). Git `+N` green, `~N` yellow. Remaining segments uncoloured, distinguished by emoji.
2. Themes: not present. 3. ANSI 16 only; no NO_COLOR. 4. Foreground only. 5. Plain ` | `, no colour. 6. Emoji prefixes. 7. Not present. 8. Emoji (`🤖💪🧠💰⏱️📁🌳🌿`), `█░`. 9. Calls `gh api users/<u>/settings/billing/usage` with a 10-minute cache. 10. Edit script; `GH_MINUTES_TOTAL` var.

# Batch 39: styling deep-dive

All projects below report stars=0 in the batch file.

## glm-hud
URL: https://github.com/chen2151643/glm-hud (stars 0)
1. Colour source: fixed per segment role plus thresholds. `render.mjs:12-41` palette keys: model/branch = `model`/`branch` (same cyan), directory = `project` (olive), `git:(`/`)` = `git` (magenta), labels/"Context" = `dim`. Thresholds: `ctxColor` (`render.mjs:79`) = healthy <70, warn 70-84, critical >=85; `quotaColor` (`:80`) = healthy <75, quotaWarn (purple) 75-89, critical >=90. Critical quota rows get a bold red row with a warning sign (`:229`).
2. Themes: two bundled palettes, `dark` (default) and `light` (`DARK`/`LIGHT` consts, `render.mjs:11-44`). Format is a fixed role map of 10 keys: dim, dimBar, model, project, git, branch, healthy, warn, critical, quotaWarn. No user-defined themes; `GLM_HUD_THEME=dark|light` only (`themeFromEnv`, `:51`).
3. Colour spec and depth: xterm-256 indices only (`\x1b[38;5;Nm`), plus bold. No truecolor, no downsampling. NO_COLOR: not present (grep finds none).
4. Fill: foreground-only text, no backgrounds.
5. Separators: plain ` │ ` between segments, ` | ` fallback (`render.mjs:141,354`). Not coloured separately (inherits default text colour).
6. Neighbours: separators only, plus hue differences per role (cyan, olive, magenta).
7. Light/dark: explicit light palette tuned for `#fafafa` and dark for `#1c1c1c`. Comment at `:3-41` records measured WCAG contrast ratios per colour (text >=4.5, bar glyphs >=3 per WCAG non-text) and colourblind-safe warn/critical hue separation (blue to orange to red). Selection is manual by env var, not auto-detected.
8. Glyphs: block bars `█░`, lightning-bolt and warning-sign emoji, `│`. Widths of ambiguous glyphs were recalibrated to 1 column (`:87-103`). No Nerd Font or ASCII mode.
9. Other: OSC 8 file:// link on the directory name (`:166,190`). Row wrap breaks at separators; narrow terminals (<60 cols) collapse to one compact line. `tools/ansi2html.mjs` and `gen-scenes.mjs` produce preview screenshots (`preview/dark-s1.png`).
10. Customisation: environment variables only: `GLM_HUD_THEME`, `GLM_HUD_HIDE` (comma list of segment keys: badge, effort, dir, branch, ctx, ctxabs, env, fiveHour, week, mcp). No config file.

## cc-ctx
URL: https://github.com/chenyie7/cc-ctx (stars 0)
1. Colour source: per-field named colour, plus threshold for the context meter. `config.js:24-35` `DEFAULT_COLORS`: label, brand, model, effort, dir, value, ok, warn, hot, divider, barEmpty. `statusline.js:87-131`: brand=`brand`, model=`model` (purple), effort=`effort` (yellow), dir label `label` + value `dir` (sky), most numeric values=`value`, cache-read count=`ok`. Context bar and percent use `ok`/`warn`/`hot` at contextWarn 60 and contextHot 85 (`config.js:135-136`, `render.js:107`). Every item is `labelledItem` = dim `label` text + coloured value (`render.js:315`).
2. Themes: not present as named themes. A single semantic role map of 11 names, each overridable via `CC_CTX_COLOR_<NAME>` (`config.js:99-103`). Users define colours by editing `~/.claude/cc-ctx/cc-ctx.env` or env vars.
3. Colour spec and depth: stored as raw SGR strings, default truecolor `38;2;r;g;b`. Downsamples to xterm-256 (`rgbTo256`, `render.js:46`) unless COLORTERM says truecolor/24bit; `CC_CTX_TRUECOLOR=on|off|auto`. NO_COLOR honoured (`config.js:112`, `paint` in `render.js:67`), plus `CC_CTX_NO_COLOR=1`.
4. Fill: foreground-only.
5. Separators: configurable `divider` string (default ` │ `) painted in the `divider` role colour (slate); items in the same group are joined by `gap` (two spaces) instead (`render.js:172,207,231`).
6. Neighbours: group membership (identity / place / tokens / stats) decides whether a divider or a plain gap sits between items; hues differ by role.
7. Light/dark: not present (palette is tuned for dark; no detection).
8. Glyphs: `█`/`░` bar with env-overridable characters (`CC_CTX_BAR_FULL`, `CC_CTX_BAR_EMPTY_CHAR`); no icons. Layout is width-aware: wrap uses dynamic programming for balanced lines (`render.js:~260-300`), and path truncation mode start/middle/end.
9. Other: layout fields are an ordered list (`CC_CTX_FIELDS`); pricing/peak-hour JSON.
10. Customisation: `conf/default.env`, then user `~/.claude/cc-ctx/cc-ctx.env`, then real `CC_CTX_*` env vars (`config.js:90-100`). CLI `cc-ctx` has setup/report subcommands.

## chethiyakd/ccbar (fork of lakpriya1s/ccbar)
URL: https://github.com/ChethiyaKD/ccbar (stars 0). FORK OF lakpriya1s/ccbar.
Differences only. Styling is identical in design: `apply_theme` (fork `bin/ccbar:48-88`, parent `bin/ccbar` same block) defines the same three themes `default`, `mono`, `vivid` as plain ANSI-16 SGR strings, and bars colour at the same cut-offs (>=80 `BAR_HIGH`, >=50 `BAR_MID`, else `BAR_LOW`, fork `:111-117`). Per-effort colours `E_LOW..E_MAX`, org badge `C_ORG`, config via `~/.config` KEY="value" file, `ccbar gallery` of six preset looks (`CCBAR_PRESETS`, fork `:296-302`) and a `ccbar config` wizard are shared.
- The fork is an older snapshot: `CCBAR_VERSION="0.2.1"` (619 lines) versus the parent's `0.5.1` (1202 lines). It lacks the parent's `stats`, `history`, `install` commands and the burn-rate hint that prints a warning sign plus ETA in `BAR_HIGH` (parent `render_burn`). No new styling was added by the fork.
- Parent features absent in fork: cost/overage segments toggles (`CCBAR_SHOW_COST`, `CCBAR_SHOW_OVERAGE`, `CCBAR_SHOW_BURN`).
Common facts: colour by threshold (bars) and by effort level; foreground only; ANSI-16 only (`\033[0;32m` etc., dim `2;`, bold `1;`); NO_COLOR not present; light/dark adaptation not present (mono theme uses dim/white); separator is the literal `->` in `model effort -> dir` and bracket glyphs `[ ]` around the org badge (colour `C_ARROW`, `C_BRACKET`); bar glyphs configurable (`CCBAR_BAR_FILLED/EMPTY`, width); no emoji besides a prompt marker in demo.

## chewygumxx/claude-status-line
URL: https://github.com/chewygumxx/claude-status-line (stars 0)
1. Colour source: semantic role per segment. `src/theme.rs` enum `Role` (Success, Warning, Danger, EffortLow, EffortHigh, Model, Path, Muted, Owner, Repo, PathMarker, Directory, Branch, Punctuation, Divider). Mapping in `render.rs`: model=Model (`:153`), effort LOW=EffortLow, MEDIUM=Warning, HIGH=EffortHigh, MAX=Danger (`:139-143`), gauges (CTX, 5H, 7D) via `Severity` -> Success <50, Warning <80, Danger >=80 on the *rounded displayed value* (`format/gauge.rs:71-74`), unknown=Muted; token counts: OUT=Danger (bold), cache-write=Warning, cache-read=Success (`render.rs:111-127`); WHERE row: owner/repo/marker/directories/branch/punctuation/divider each have their own role (`render.rs:224-244`); unpushed-commit counter Warning else Muted (`:210`). Labels and deltas Muted.
2. Themes: not present as switchable themes; one fixed palette. Format is a role table `spec(Role)` returning `{truecolor RGB, ansi256 index, ansi16 colour}` per role (`theme.rs`). The WHERE-row roles copy the author's WezTerm ANSI table verbatim (comment in `theme.rs`). Not user-configurable (`config.rs` only handles HOME/paths).
3. Colour spec and depth: three tiers per role. `detect_tier` (`theme.rs`) uses `supports-color` and sets `IGNORE_IS_TERMINAL` because stdout is a pipe: TrueColor, Ansi256, Ansi16, Plain. Roles with an ANSI equivalent use palette-relative indices 0-15 at the 256 tier so they follow the user's terminal theme; Muted/EffortHigh keep fixed 244/208. NO_COLOR honoured via supports-color (to `Tier::Plain`, no escapes emitted).
4. Fill: foreground-only, with bold on selected roles and dim attribute for brackets/separators.
5. Separators: dim text separators (`theme::dim`); the WHERE row builds `~owner/repo.git:/dir/sub` where each punctuation class has its own role colour.
6. Neighbours: different role hues; row labels (`LIMITS`, `WHERE`, model/token row) in Muted. Separate roles for Branch vs Success so retinting one never retints the other (explicit design note).
7. Light/dark: not present beyond the ANSI16 tier following the terminal's palette.
8. Glyphs: Unicode gauge in `format/gauge.rs`; no Nerd Font requirement documented in the files read. ASCII fallback: unverified.
9. Other: a Rust rewrite of an earlier Python script; gauge severity derived from the same rounded number that is shown (bug fix recorded at `gauge.rs:100`).
10. Customisation: none beyond the wrapper script `claude-status-line.sh`; no config file read for colours.

## chintanturakhia/claude-statusline-builder
URL: https://github.com/ChintanTurakhia/claude-statusline-builder (stars 0)
1. Colour source: user-assigned per segment in a web builder. Each `Segment` has `color: AnsiColor` and `bold` (`src/lib/statusline.ts:41-54`); defaults per type (`:105-300`): model cyan, directory default, session_name magenta, version bright_black, vim_mode yellow, agent magenta, context_bar green, git_branch green, git_status yellow, cost yellow, worktree blue, separator bright_black, tokens bright_black, rest default. Context bar optionally `thresholdColors`: green <70, yellow 70-89, red >=90 (generated code `generators.ts:183-186`, preview `statusline.ts:401-405`). Presets (`PRESETS`): Minimal, Developer, Dashboard, Cost Tracker, Git Power, Rate Watcher.
2. Themes: not present for the generated statusline (only a UI light/dark toggle for the web app itself, `theme-toggle.tsx`). Colour set is the 17 names `default`, 8 base, 8 bright.
3. Colour spec and depth: ANSI 16 SGR codes only (`30-37`, `90-97`), generated into bash, Python or Node scripts (`generators.ts:17-22`). The preview maps each name to a Catppuccin-like CSS hex (`ANSI_COLORS`, `statusline.ts:62-82`). No depth detection; NO_COLOR not present.
4. Fill: foreground-only.
5. Separators: a `separator` segment emitting ` | ` in a chosen colour (default bright_black); segments otherwise joined by prefix/suffix strings the user types.
6. Neighbours: separator segments and user-chosen hues.
7. Light/dark: not present in output.
8. Glyphs: emoji prefixes in presets (e.g. folder, money bag); bar styles `blocks`, `hashes`, `dots` (`barStyle`).
9. Other: a Next.js drag-and-drop builder with live terminal preview (`terminal-preview.tsx`) that outputs a ready script (bash, Python or Node) and settings JSON.
10. Customisation: the web UI itself; output languages bash/python/node; padding and refreshInterval fields (`StatuslineConfig`).

## choo121600/oh-my-cchud
URL: https://github.com/choo121600/oh-my-cchud (stars 0)
1. Colour source: semantic role plus thresholds. `src/theme.ts:7-47`: roles `accent` (bold cyan), `muted` (gray 90), `ok` (bright green 92), `warn` (bright yellow 93), `crit` (bright red 91) and `scale(value, warn, crit)` picking ok/warn/crit. Context bar and percent use `scale` with `config.context.warn/crit` (`segments.ts:~30-40`); rate limits likewise per window; model=`accent`; project name in bold between muted brackets (`segments.ts:21`); cost `c.yellow` (`:46`); effort: xhigh/max crit, high warn, low muted, else cyan (`:160-170`); worktree glyph muted + blue label; agents magenta; todos green when complete else cyan; PR text blue with OSC 8 link; git dirty count warn.
2. Themes: three, but they differ in glyph sets not colours: `default` (Unicode), `nerd`, `ascii` (`theme.ts:49-103`); "Colors are shared across themes". Selected by config key `theme` or `OH_MY_CCHUD_THEME`. Custom themes: not present.
3. Colour spec and depth: ANSI 16 only (`ansi.ts`: 31-36, 90-92). NO_COLOR honoured (`ansi.ts:4`, also strips OSC 8 links). No depth detection.
4. Fill: foreground-only.
5. Separators: configurable string `separator` (default two spaces, `config.ts:29`), uncoloured.
6. Neighbours: whitespace and hue per role.
7. Light/dark: not present.
8. Glyphs: three glyph sets; Nerd set uses private-use icons for branch/dirty/todo/tool/agent/worktree/effort/thinking/PR/status, ASCII set uses `git:`, `[x]`, `wt:`, `eff:`, `[!]`; bar `█░` or `#-`.
9. Other: OSC 8 hyperlinks on branch and PR; service-outage badge from the Claude status page; subagent statusline (`src/subagent-statusline.ts`).
10. Customisation: JSON file at `$CLAUDE_PLUGIN_ROOT/config.json` or `~/.claude/oh-my-cchud.json`, shallow-merged over defaults (`config.ts:2-3,73-75`); env `OH_MY_CCHUD_THEME`.

## cjmellor/mella-marketplace
URL: https://github.com/cjmellor/mella-marketplace (stars 0)
Not a Claude statusline: a plugin marketplace (commit skill, grain memory, guardrails, worktree tools). Two of its mods draw a band above the prompt instead of a statusline, noted here for styling:
1. Colour source (`plugins/session-stats/hooks/register.tsx`): model name bold uncoloured; context and each rate-limit percent coloured by `levelColor` = green <60, yellow 60-84, red >=85 (`:51`); the fill bar is `◼` cells coloured by that level with empty cells `dimColor` (`:244-247`); labels and reset countdowns `dimColor`; branch `dimColor`. `plugins/git-diff/hooks/register.tsx`: `+N` green bold, `-N` red bold, a proportional `◼` squares bar of green/red/grey (`:43-48`, `:277-278`).
2. Themes: not present; the mod API takes colour names (`green`, `red`, `gray`) and `dimColor`, so it inherits Claude Code's own theme.
3. Colour spec: named colours via the mod's `<Text color=...>` props; depth and NO_COLOR handled by the host (unverified).
4. Fill: foreground-only.
5. Separators: not present; spacing only (`│ ` guides in the file tree).
6. Neighbours: dim vs coloured, whitespace.
7. Light/dark: delegated to the host theme.
8. Glyphs: effort icons `○ ◐ ● ◉ ◈` (`register.tsx:28`), `⎇` branch, `◼` bars, `±`, `+`/`−`. No Nerd Font.
9. Other: a plugin API (`claude-code` import, `atom`/`read`/`update`) with Button components and a pane.
10. Customisation: per-mod `/config` switches for guardrails; styling not user-configurable.

## ckross01/statusline-context
URL: https://github.com/ckross01/statusline-context (stars 0)
1. Colour source: threshold on context fill only. `color(pct)` (`statusline-context.py:24-31`): <50 green (`\033[32m`), <75 yellow (`\033[33m`), <90 orange (`\033[38;5;208m`), else bold red. Model and folder segments are `DIM`; compact-soon warning at >=90 bold red.
2. Themes: five *emoji* themes (`THEMES`, `:35-41`) of five tiers each, not colour themes: `faces`, `growth`, `fire`, `weather`, `moon` (e.g. growth = seedling, herb, tree, fallen leaf, wilted flower). Selected by `CLAUDE_STATUSLINE_THEME`. Tier cut-offs 25/50/75/90. Custom: not present.
3. Colour spec and depth: ANSI 16 (32, 33) plus one xterm-256 index (208). No depth detection; NO_COLOR not present.
4. Fill: foreground-only.
5. Separators: two spaces.
6. Neighbours: dim vs coloured only.
7. Light/dark: not present.
8. Glyphs: emoji prefix per segment (brain, folder) and the tier emoji; bar `█░` of width 14.
9. Other: reads the transcript to compute context size rather than using the payload; `CLAUDE_CONTEXT_WINDOW` override.
10. Customisation: two env vars (`CLAUDE_STATUSLINE_THEME`, `CLAUDE_CONTEXT_WINDOW`).

## claude-contrib/claude-status
URL: https://github.com/claude-contrib/claude-status (stars 0)
1. Colour source: fixed per segment with a theme-supplied colour per segment role. Theme JSON keys (`themes/catppuccin-mocha.json`): `cost_fg`, `agent_fg`, `model_fg`, `dir_fg`, `branch_fg`, `worktree_fg`, `diff_add_fg`, `diff_del_fg`, `context_bar_fg`, `docker_fg`, `nix_fg`, `muted_fg`, `sep_fg`. Mapping in `claude-status` (`:67-257`): cost=cost_fg, agent=agent_fg, model=model_fg, directory=dir_fg, branch=branch_fg, worktree=worktree_fg, session time=muted_fg, `+N`=diff_add_fg, `-N`=diff_del_fg. Context bar: <70 diff_add_fg (green), >=70 context_bar_fg (yellow), >=90 diff_del_fg (red) (`:67-72`); the percent is muted_fg; empty cells sep_fg.
2. Themes: four bundled Catppuccin flavours (`catppuccin-mocha` default, `-macchiato`, `-frappe`, `-latte`). Format is a flat per-segment colour map of `"R;G;B"` strings (13 keys), loaded through `queries/claude-theme.jq` into shell vars. Users can pass an absolute path to their own JSON via `CLAUDE_CODE_STATUS_THEME` (`:30-36`).
3. Colour spec and depth: truecolor only (`\033[38;2;%sm`, `_printf_color` `:45`). README states a TrueColor terminal is required; no downsampling; NO_COLOR not present.
4. Fill: foreground-only.
5. Separators: two-space gap painted in `sep_fg` (`:271-272`). No glyph separator.
6. Neighbours: different hues per segment, from the theme; gaps only.
7. Light/dark: a `catppuccin-latte` theme file for light backgrounds, chosen manually; no detection.
8. Glyphs: Nerd Font icons (folder, branch, clock, worktree, nix, docker) and a Braille-cell progress bar (`⣿`/`⣀`) per README; emoji `⚡` for agent. No ASCII fallback documented.
9. Other: zsh plugin / Nix flake / zinit distribution; conditional segments (agent, worktree, docker, nix).
10. Customisation: single env var `CLAUDE_CODE_STATUS_THEME` (name or JSON path); no segment toggles.

## clearmountaindigital/mountainlabs-statusline
URL: https://github.com/ClearMountainDigital/mountainlabs-statusline (stars 0)
1. Colour source: mixed. Line 1 is three background-filled powerline segments with fixed colours: model on SLATE `73;91;108`, directory on STONE `113;106;86`, git on FOREST `63;81;71` (`statusline.sh:253-307`), all with CREAM text `242;242;242`. Line 2 foregrounds: context bar is a per-cell gradient keyed on ABSOLUTE tokens, sage `150;200;165` up to 100k tokens, then sage to rust `226;138;74` to red `238;108;100` over 100k-400k (`grad_color`/`bar_grad`, `:80-100,214-240`); 5h and weekly bars use `pct_color`: sage <70, rust 70-89, red >=90 (`:131-135`); cost via `cost_col` sage to rust to red between $5 and $20 (`COST_WARN`/`COST_DANGER`); effort glyphs high=sage `▲`, xhigh=rust `▲▲`, max=red `◆◆◆` (`:247-249`); git arrows ahead=sky, behind=amber, staged=sage, modified=rust, clean check=sage.
2. Themes: one palette ("MountainLabs.ai"); no theme switch. Each hue is an overridable `R;G;B` variable (CREAM, FOREST, RUST, STONE, SLATE, RED, SAGE, DIM, SKY, AMBER, TRACK). `assets/ghostty-theme.svg` shows a companion Ghostty theme.
3. Colour spec and depth: truecolor only (`38;2`, `48;2`); depth detection and NO_COLOR not present.
4. Fill: both. Background fills on line 1 only; line 2 is foreground text.
5. Separators: powerline right arrow glyph; its fg is the left cell's bg and its bg is the next cell's bg (`:303-307`, last segment ends on a fg-only arrow).
6. Neighbours: three distinct bg hues (slate, stone, forest) with powerline arrows.
7. Light/dark: dark-terminal assumption. Comment (`:104-110`) says accent foregrounds are chosen to meet WCAG 1.4.11 (>=3.0) on the mid-tone segment backgrounds and AA 4.5 on a dark terminal; no detection.
8. Glyphs: Nerd Font powerline separator, branch and folder and worktree glyphs; Unicode `∞`, `▲`, `◆`, `✎`, `↑↓`. No ASCII mode.
9. Other: gradient bar tied to tokens rather than percent ("smart zone" vs "dumb zone" idea).
10. Customisation: env vars or a sourced config file (`_ml_config`), where env wins; thresholds `CTX_WARN_PCT`, `CTX_DANGER_PCT`, `CTX_GOOD_TOK`, `CTX_RED_TOK`, `COST_WARN`, `COST_DANGER`, effort glyphs.

## clppan/claude-color-rate
URL: https://github.com/ClpPan/claude-color-rate (stars 0)
1. Colour source: pace-based. Rate-limit colour is blue/yellow/red depending on usage vs expected pace for elapsed window time: used <= expected = blue; <= 1.5x expected = yellow; else red (`status-line.sh:26-65`); with no reset time, blue until >80% (red). Context bar `●`/`○` cells are red above 60% else blue (`:106-115`). Model name and labels uncoloured.
2. Themes: not present.
3. Colour spec and depth: ANSI 16 (`\033[34m`, `[33m`, `[31m`). No depth detection; NO_COLOR not present.
4. Fill: foreground-only.
5. Separators: plain ` | ` uncoloured.
6. Neighbours: not present beyond the separator.
7. Light/dark: not present (plain blue is used instead of green, with no stated reason found in the file).
8. Glyphs: `●`/`○` dots for context, `↺` for reset time.
9. Other: appends a TSV history log to `~/.claude/usage-history.log` (`:131-147`); `usage-report.sh` summarises it.
10. Customisation: edit the script; no config.

## cmorenogit/claude-statusline
URL: https://github.com/cmorenogit/claude-statusline (stars 0)
1. Colour source: theme role per segment plus severity scale. Semantic roles in each theme file (`themes/catppuccin-mocha.sh`): PRIMARY (model, weekly-limit icon), SECONDARY (context icon, worktree marker), POSITIVE (branch, additions, bars <50), NOTICE (5-hour icon, bars 50-69), CAUTION (extra credits, bars 70-89), NEGATIVE (removals, bars >=90), TEXT (directory), SUBTEXT (duration), OVERLAY (reset times), SURFACE (separators, empty bar blocks). `color_for_pct` (`bin/statusline.sh:178-184`) uses four tiers: <50 POSITIVE, 50-69 NOTICE, 70-89 CAUTION, >=90 NEGATIVE; the same function colours the context percent and every bar.
2. Themes: three bundled (`catppuccin-mocha` default, `dracula`, `nord`) plus `_template.sh` explaining how to add one. Format: semantic palette of 10 shell vars as truecolor SGR. User themes: copy the template to `~/.claude/statusline-themes/` (per header comment), then `STATUSLINE_THEME=my-theme`.
3. Colour spec and depth: truecolor `\033[38;2;R;G;Bm` only; no downsampling; NO_COLOR not present.
4. Fill: foreground-only.
5. Separators: ` │ ` in the SURFACE colour (`SEP`, `statusline.sh:13`).
6. Neighbours: hue per role plus the `│` separator.
7. Light/dark: only by picking a theme; no latte/light theme among the three. Not auto-detected.
8. Glyphs: Nerd Font codepoints for model, dir, branch, time, context, rate, week, worktree, cache-cold (`:118-126`), `│`, `█░`. No ASCII mode.
9. Other: two layouts (`full` two-line with bars and reset times, `compact` single line), selected by `STATUSLINE_LAYOUT`; the branch name is shortened to fit the width; a "cold" prompt-cache indicator.
10. Customisation: env `STATUSLINE_THEME`, `STATUSLINE_LAYOUT`; npm installer (`npx @cmorenogit/claude-statusline`, `bin/install.js`); layout and theme files are shell snippets.

## cody-xue/cc-statusline
URL: https://github.com/Cody-Xue/cc-statusline (stars 0)
1. Colour source: fixed per segment with a threshold tier. `statusline.sh:376-391,320-341` (offsets from file read): model base `blue`, model context suffix `blue_dim`, effort `magenta`, git label `white_dim`, `+N` green, `-N` red, `?N` yellow, session duration icon blue with `white` text, 5h bar and percent `cyan`, 7d bar and percent `magenta`, reset times use the `_dim` variant, extra-credit `white_dim`. Context bar green below 20% used, `pink` from 20% up (`:380-386`). The generic `color_for_pct` (`:~225-232`) is red >=90, yellow >=70, orange >=50, else green.
2. Themes: two palettes, `dark` and `light`, with Catppuccin Latte hex values for light (`:171-193`) and a pastel set for dark (`:195-210`). Format: ~20 colour variables (blue, blue_dim, orange, orange_bright, orange_dim, orange_dark, green, green_dim, cyan, cyan_dim, red, yellow, yellow_dim, white, white_dim, magenta, magenta_dim, pink, pink_dim, ctx_info, sep_color). User-defined themes: not present.
3. Colour spec and depth: truecolor only; no NO_COLOR.
4. Fill: foreground-only.
5. Separators: ` │ ` in `sep_color` for light; dark relies on the terminal `dim` attribute with no colour (`:216-220`).
6. Neighbours: each family has a bright and a `_dim` variant ("brightness matched" comments), so labels and values differ in lightness; cyan vs magenta distinguish the two limit bars.
7. Light/dark: the strongest of this batch. Detection order: `CLAUDE_STATUSLINE_THEME`, a manual override file from `--set-theme light|dark|auto`, `CLAUDE_STATUSLINE_BG_HEX` classified by Rec.709 luminance >128 (`:81-91`), a cached per-window value (3 s TTL), else system appearance. `--probe-bg` queries the terminal background by OSC 11 (`\033]11;?`) from the shell rc, because a statusline child has no tty.
8. Glyphs: Nerd Font icons (git icon, `󰔟` timer, `󰑐` reset), `█░` bars.
9. Other: a third line for extra usage; rate-limit bars share `build_bar` with a passed colour.
10. Customisation: env `CLAUDE_STATUSLINE_THEME`, `CLAUDE_STATUSLINE_BG_HEX`, flags `--probe-bg`, `--set-theme`; edit script for the rest.

## codyhxyz/statusline
URL: https://github.com/codyhxyz/statusline (stars 0)
1. Colour source: a continuous gradient by percent. `color_for` (`statusline-command.sh:21-41`) maps pct 0-100 to HSL hue 120 degrees (green) down to 0 (red), S=0.90, L=0.55, emitted as truecolor. Used for ctx, 5h and 7d meters identically; `ring_for` picks a quarter-fill glyph (`○ ◔ ◑ ◕ ●`) at 13/38/63/88 breakpoints. Labels `DIM` (`\033[90m`), the extra bracket `[...]` in 240 grey, model name BOLD uncoloured.
2. Themes: not present.
3. Colour spec and depth: truecolor for the gradient, xterm-256 (`38;5;240`) for the grey, ANSI 90 for dim. No depth detection or NO_COLOR.
4. Fill: foreground-only.
5. Separators: `  ·  ` (middle dot) in dim.
6. Neighbours: separator only; the three meters can have differing hues because each reflects its own percent.
7. Light/dark: not present.
8. Glyphs: pie-style ring glyphs; reset countdown text `T-2h30m`.
9. Other: hue is continuous, not stepped; meters with 0% are hidden unless a reset countdown exists.
10. Customisation: edit the script; no config.

## cognifer-labs/cogwait
URL: https://github.com/Cognifer-Labs/cogwait (stars 0)
Not a general statusline but a Claude statusline that renders a sponsored ad line (plus an unpaid news fallback) beneath a chained user statusline. Styling is relevant for prominence levels:
1. Colour source: by prominence level 1-5 (`lib/render.js:20-60`): level 1 cyan `[sponsor]` label with dim text; 2 yellow bold `▸ [sponsor]` with cyan text; 3 magenta bold `◆ SPONSOR` with bold text; 4 reverse-video bold `★ [sponsor]`; 5 a magenta box (`┌─┐│└┘`) with a blinking magenta `●` (SGR 5). News fallback: cyan `[news]` with dim text. CTA link yellow.
2. Themes: not present (the repo's `video/src/theme.ts` is for a promo video, not the statusline).
3. Colour spec and depth: ANSI 16 only; plain-text variant `renderPlain` for GUI hosts. NO_COLOR not present.
4. Fill: reverse video (`\x1b[7m`) at level 4; otherwise foreground.
5. Separators: not present (box-drawing frame at level 5).
6. Neighbours: not applicable; the user's own statusline is chained above (`bin/statusline.js:49-60`, run via `spawnSync` with 2 s timeout).
7. Light/dark: not present.
8. Glyphs: `▸ ◆ ★ ● ›` and box-drawing; OSC 8 links (`osc8`, BEL-terminated).
9. Other: blink attribute at the top level.
10. Customisation: ad level via account config (`~/.cogwait/config.json`, `COGWAIT_API`); not user-styled.

## coltonbearden/awakened
URL: https://github.com/coltonbearden/awakened (stars 0)
The statusline part is the `aura` satellite plugin: three presets in `plugins/aura/statuslines/` (bash and PowerShell twins) plus six terminal palettes.
1. Colour source: state/threshold per preset. `power-level.sh`: context percent drives colour: <60 gold `38;5;220`, 60-89 orange `208`, >=90 red `196`, with labels CHARGING / RISING / ASCENDED (or LIMIT BREAK when exceeds_200k). `transformation.sh`: state decides: agent active = crimson `160` "kaioken-x20", lines changed = gold `220` "super-saiyan", else silver `250` "base-form"; "thinking" in blue `39`; effort and agent text dim. `barrier.sh`: `[BARRIER]` tag in violet `93`, each present config layer (CLAUDE.md, rules, settings, dirs, worktree, style) in cyan `51`, absent layers dim.
2. Themes: six *terminal palette* files (`plugins/aura/palettes/`: domain-expansion, final-flash, gear-fifth, getsuga-tensho, six-eyes, ultra-instinct), each exactly a Windows Terminal scheme of 20 hex colours plus background/foreground/cursor/selection (`schemas/palette.schema.json`). They colour the terminal, not the statusline; the statusline scripts use fixed 256-colour indices. Users paste palettes into their terminal config.
3. Colour spec and depth: xterm-256 indices only; no depth detection; NO_COLOR not present. Palette files are `#RRGGBB`.
4. Fill: foreground-only.
5. Separators: plain ` | `.
6. Neighbours: separators only, dim vs accent.
7. Light/dark: not present.
8. Glyphs: ASCII `#`/`-` bars in brackets, no icons.
9. Other: the aura plugin's `/aura:equip` command installs a preset; scripts have no jq dependency (pure bash regex JSON parsing) and always print one line.
10. Customisation: pick one of three presets; palettes are terminal-side files; no per-colour options.

## comdoly-life/claude-session-dashboard
URL: https://github.com/comdoly-life/claude-session-dashboard (stars 0)
Not a Claude statusline: a Claude Code mod (session list pane plus a three-row band above the prompt). Styling is notable because it uses the host's theme roles.
1. Colour source: theme role names, not hex, for most things. `hooks/view.tsx:57-62`: status look: running `claude`, idle `inactive`, done `success`, failed `error`. Warnings use `warning`; text on chips `text`. Chips in the band (`hooks/controls.ts:29-36` `CHIP`): idle chip on the host's `subtle` background; a picked chip gets its own bright hex with black ink: model `#ffa36c`, effort `#7cc4ff`, workflows `#7ee0a1`, ultracode `#c49bff`. Limit bars: colour from remaining percent via `remainingColor` (`hooks/format.ts:~250`): `success` when remaining is safe, else an HSL ramp from amber through orange to deep red as the remainder runs out.
2. Themes: not present; the mod inherits the host theme via role names.
3. Colour spec and depth: role names plus hex for chips and the HSL ramp; depth handled by the host (unverified).
4. Fill: both: chips are background-filled (`backgroundColor`), the rest foreground.
5. Separators: dim ` │ ` between tabs; no powerline.
6. Neighbours: the four chips use four distinct hues (orange, blue, green, purple) so groups tell apart; one session's name is shown in its own `MINE` colour.
7. Light/dark: role names follow the host theme; the fixed chip hex uses black ink (assumes mid-bright fills).
8. Glyphs: `☐ ☑ ☒`, `●`, `│`; UI text is Korean.
9. Other: limit bar with percent *remaining* shown as the fill; per-folder grouping.
10. Customisation: not user-styled; toggles are in-band buttons (model, effort, workflows, ultracode).

## cppmyjob/claude-mods
URL: https://github.com/cppmyjob/claude-mods (stars 0)
1. Colour source: threshold and role. `statusline/footer-info.js:17-24` palette: model `rgb(215,119,87)` (Claude orange, bold), effort `rgb(177,185,249)` (lilac), ok `78,186,101`, warn `255,193,7`, full `255,107,128`, unknown grey. `levelTone` (`:86-96`): green <50, yellow <80, red >=80 (for ctx and the 5h/7d percentages). Cache countdown ok, or warn in the last 5 minutes, red `full` when cold. Pace projection `→ 100% ~12:00` in bold `full`. Labels (`5h `, `cache `, `ctx `, `effort `) dim.
2. Themes: not present; README says "The colors are Claude Code's dark theme" (values copied from Claude Code's own palette: claude, permission, success, warning, error, inactive).
3. Colour spec and depth: truecolor only. NO_COLOR honoured (`isColored = !process.env.NO_COLOR`, `:346`).
4. Fill: foreground-only.
5. Separators: ` · ` in dim (`SEPARATOR`, `:26`).
6. Neighbours: dim labels vs coloured values, dot separators.
7. Light/dark: dark theme only.
8. Glyphs: none beyond the dot and arrow; text labels.
9. Other: right-aligned model/effort/ctx group and left-aligned limits group with a computed gap (MIN_GAP, DEFAULT_MARGIN); 5-hour burn projection from a temp-file history shared across sessions.
10. Customisation: env `FOOTER_INFO_MARGIN`; installer `install.js` sets `refreshInterval` 2; no colour options.

## crafts69guy/claude-statusline.nvim
URL: https://github.com/crafts69guy/claude-statusline.nvim (stars 0)
1. Colour source: fixed per segment, with an optional semantic palette. Defaults (`lua/claude_statusline/render.lua`): repo bold `255,210,0` yellow, directory same yellow, branch bold `0,220,220` cyan, tokens yellow, diff `+` green `0,220,80` and `-` red `220,60,40` with grey icon, model bold magenta `200,80,220`, agents blue `120,170,255`. Context bar: 20 `█` cells with a gradient (green to yellow at cell 10 to red) and a percent label tier: <20 green, <70 yellow, <90 orange, else red with distinct Nerd Font icons per tier (`󰾆 󰊚 󰓅 󰀦`); unfilled cells grey `60,60,60`.
2. Themes: one default plus a *palette mode*. A JSON config (`config.lua:load`) with `palette` of semantic roles (required: `text.primary`, `text.secondary`, `text.accent`, `accent.primary`, `accent.secondary`, `border.subtle`, `status.success`, `status.warning`, `status.error`, `status.info`; optional `border.faint`), all `#RRGGBB`, and `segments` order. Segment-to-role: repo and tokens = text.accent, directory = text.primary, branch = accent.secondary, model = accent.primary, diff = status.success/status.error with text.secondary, agents = status.info. In palette mode the context bar blends success to warning to error and uses `border.faint` for empty cells. Bundled integration: the author's "hue-theme" plugin supplies palettes ("moods") (README, unverified beyond the config).
3. Colour spec and depth: truecolor only; palette values must be `#RRGGBB`. NO_COLOR not present.
4. Fill: foreground-only (bold).
5. Separators: ` | ` with dim `90,90,90` (or `border.subtle` in palette mode).
6. Neighbours: different hues per segment; the separator.
7. Light/dark: the Hue moods are selected at startup; README notes switching Claude's `/theme` mid-session does not update the palette. Palette mode strips control characters from displayed names (`display`).
8. Glyphs: Nerd Font required (private-use icons as byte escapes, `render.lua:12-17`).
9. Other: a Neovim playground renders the statusline live; pairs the Claude `theme` setting (`custom:hue-theme:hue-<mood>`) with the statusline palette so both change together (`config.lua:settings`).
10. Customisation: JSON file via `--config`, `setup({segments, palette})` in Neovim; ordered segment list.

## creamcitycyber/usage-meter
URL: https://github.com/creamcitycyber/usage-meter (stars 0)
Not a Claude statusline: a Claude Code mod (band above the prompt plus a `/usage` pane) that replaces a statusline's job. Styling:
1. Colour source: threshold and fixed. `hooks/meter.ts:256` `pctColor`: green `#5fd787` <50, yellow `#ffd700` <80, red `#ff0000`. Band (`hooks/view.tsx:56-102`): model cyan, context percent via `pctColor`, limit percents via `pctColor` with muted reset time `#a8a8a8`, cost default colour, branch magenta, dirty marker yellow, session time muted.
2. Themes: not present. Breakdown pane uses a fixed category palette (`COLORS`: system `#808080`, rules `#af87ff`, skills `#ff87ff`, summary `#87afaf`, you `#00afff`, claude `#ff8700`, tools `#ffd700`, agents `#5fd787`), documented in the file as xterm-256 numbers.
3. Colour spec and depth: hex values with 256-colour origins; host handles depth (unverified). NO_COLOR not present.
4. Fill: foreground-only.
5. Separators: muted ` │ ` (`Sep`, `view.tsx:56`).
6. Neighbours: separators and per-role hue.
7. Light/dark: not present (one fixed grey `#a8a8a8` for muted).
8. Glyphs: `█░` bars, `■` legend squares, `⎇` branch, `↻` reset; layout adapts with `wide`/`mid` width flags.
9. Other: an estimated-vs-engine marker `est.`.
10. Customisation: not present beyond `/usage` and `/usage builtin`.

## crisandrews/claude-usage-statusline
URL: https://github.com/crisandrews/claude-usage-statusline (stars 0)
1. Colour source: pace-based and threshold. `statusline-command.sh:20-56` `colorize_rate`: for the 5h and weekly windows, ratio = used% over elapsed-time share; >=150 red, >=115 yellow, else green (so 50% used at 10% elapsed is red); falls back to absolute (>=80 red, >=50 yellow). Context percent `colorize`: >=80 red, >=50 yellow, else green (`:60-66`). Model and effort `DIM`; reset text `DIM`.
2. Themes: not present.
3. Colour spec and depth: ANSI 16 (32/33/31, 2); no depth detection; NO_COLOR not present.
4. Fill: foreground-only.
5. Separators: plain text separators (details unverified in file read).
6. Neighbours: only colour on the percentages; the rest dim.
7. Light/dark: not present.
8. Glyphs: no icons; text labels `Session:`, `Week:`, `Ctx:`.
9. Other: includes a first-run hint hook (`hooks/first-run-hint.sh`).
10. Customisation: edit the script; none documented.

## cruelladev/claude-code-prayops
URL: https://github.com/cruellaDev/claude-code-prayops (stars 0)
A Claude Code companion whose statusline is a one-line session-phase indicator, with a full animated TUI (an incense-burner scene).
1. Colour source: by session phase (`internal/statusline/statusline.go:137-160`): approval-required muted gold (256 index 179), failed ritual red (174), completed green (108), idle/ended gray (245), thinking/working red (174). The whole line takes the one tone. The "percentage" is the burn-down of a per-turn timer, not context.
2. Themes: "theme" selects the *art*, not colours: `censer` (default), `lamp`, `holder` (README lines 89-92), stored as one word in `statusline-theme` (`internal/userconfig/theme.go`). Colours are fixed.
3. Colour spec and depth: statusline uses xterm-256 indices (`38;5;N`); the TUI canvas uses truecolor with fg and bg per cell (`internal/render/canvas.go:208-211`). NO_COLOR honoured: turns off colour and motion (`cmd/prayops/main.go:235-236,628-636`). `Color` defaults off in `Options` so the zero value is safe.
4. Fill: statusline foreground-only; TUI scene uses block glyphs with foreground and background.
5. Separators: ` · ` (`statusline.go:30`).
6. Neighbours: not applicable (single colour for the line).
7. Light/dark: not present.
8. Glyphs: block-element pixel art (`▗▄▟█▙▀`), ember `▪` and incense `▮`; width pinned to non-East-Asian (`runewidth` with `EastAsianWidth:false`) so ambiguous glyphs are 1 cell.
9. Other: animation (`contracts/effect.go`, smoke rows, motion off via `--motion off`); compact label when the terminal is under 34 columns.
10. Customisation: `prayops statusline theme <censer|lamp|holder>`, `NO_COLOR`, `PRAYOPS_MOTION=off`, `--motion`.

## ctsdm/tmux-config
URL: https://github.com/CTSDM/tmux-config (stars 0)
not a Claude statusline: a personal tmux configuration whose two-line tmux status bar shows the state of Claude Code and Codex sessions per tmux pane (Catppuccin Mocha palette in `theme.conf`, agent states yellow/peach/green/red/teal, blinking highlight for sessions needing attention).

## cuishiying-1/claude-hud
URL: https://github.com/cuishiying-1/claude-hud (stars 0)
1. Colour source: theme role per widget plus thresholds. `src/widgets/`: model name `model_color` with icon in `muted` (`model_display.rs:19-27`); context bar: by default a per-cell gradient from `success` to `danger` across the bar width (`gradient = true`), or without gradient `success` <80, `warning` 80-94, `danger` >=95 (`context_bar.rs:56-80`, warn/critical configurable); empty cells `border`; rate limits `success` unless >= warn then `danger` (`rate_limits.rs:27-28`); cost `warning` once over a threshold else `success` (`cost_display.rs:73`); git branch `accent`, dirty `*` `warning`, ahead/behind `muted`; alerts `warning`/`danger` (a danger alert "breathes" via `animation::breathe`).
2. Themes: ten built-in presets in `Theme::preset_names()` (dracula, nord, tokyo-night, catppuccin, monochrome, solarized-dark, gruvbox-dark, one-dark, github-dark, palenight); README says six. Format: a 20-token struct (`theme.rs:25-64`): 11 colour tokens (`bg`, `fg`, `accent`, `success`, `warning`, `danger`, `muted`, `border`, `skill_color`, `mcp_color`, `model_color`) and 9 style tokens (`bar_filled`, `bar_empty`, `separator`, `border_style`, `icon_set`, `bar_width`, `padding`, `compact_lines`, `dashboard_grid`). Users can set `theme = "dracula"` or a `[theme]` table with `preset` plus `overrides` or any single key (`ThemeRef`, `theme.rs:3-20`). "Mod" packages can bundle themes.
3. Colour spec and depth: hex strings in config; output as truecolor SGR (`ansi_fg`, `core/ansi.rs:6`); the TUI uses ratatui RGB. No downsampling or NO_COLOR found in the files read.
4. Fill: foreground-only in the status bar; the dashboard uses `bg`/`border` and rounded/double/thick/single/hidden borders (`BorderStyle`).
5. Separators: configurable `separator` token, default ` │ `; groups dropped from the right when over width (`fit_line`, `compact.rs:310`).
6. Neighbours: distinct widget colours; separator; `skill_color` and `mcp_color` are separate hues.
7. Light/dark: all presets are dark; adaptation not present. Nerd Font detection per OS (`detect_nerd_font`, `theme.rs:560-609`: `fc-list`, registry, font folders) selects `icon_set` Auto to Nerd or Minimal.
8. Glyphs: `icon_set` = auto/nerd/ascii/minimal; bar chars configurable.
9. Other: full-screen ratatui dashboard, web dashboard on localhost:9527, mod packages, Rhai scripting widget, `claude-hud doctor`, a TUI config editor (`config_tui.rs`, `mod_preview_tui.rs`).
10. Customisation: TOML at `~/.claude/plugins/claude-hud/config.toml` (widget list, theme, thresholds), CLI (`mod list`, `doctor`, dashboard), TUI config, language setting.

## cursedchair/krab-koder
URL: https://github.com/CursedChair/krab-koder (stars 0)
Not a Claude statusline: a Claude Code mod that draws an animated pixel-art crab (SVG sprites) above the prompt with small "usage pills" beside it. Styling for the pills only (`hooks/chips.mjs`):
1. Colour source: threshold. `levelColor` (`:30-35`): green `#5E8C6A` <50, amber `#E7B04A` 50-79, orange `#F28A2E` 80-94, red `#E03C31` >=95; applied to context, 5h and 7d meters; mood badge (filling up / getting full / almost full) amber / clay `#DD775B` / red; notes clay.
2. Themes: not present for the pills; the sprite has ~80 outfits and seasonal/weather/moon scenes (`outfits.mjs`, `seasons.mjs`, `weather.mjs`, `moondata.mjs`), with a rainbow palette for the birthday outfit (`RAINBOW`, `settings.mjs:302`). "catppuccin" is an outfit name, not a colour theme.
3. Colour spec and depth: hex in SVG; the mod host rasterises (unverified). NO_COLOR not present.
4. Fill: filled rounded pills and bars drawn as SVG (so both).
5. Separators: not present; pills have gaps (`GAP = 5`).
6. Neighbours: pill shape and bar colour; fixed label text.
7. Light/dark: not present.
8. Glyphs: pixel font and sprites instead of text glyphs (`pixelfont.mjs`, `sprite.mjs`); emoji in reaction labels.
9. Other: reactions (146), a glow that beats faster at >=95%, animation, holiday/weather/moon context, a browser demo.
10. Customisation: `/krab location|holidays|birthday|settings` slash commands.

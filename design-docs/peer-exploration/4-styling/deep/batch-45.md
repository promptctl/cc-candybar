# Batch 45: styling of Claude Code statusline projects (ai-guardrails-kit .. claude-dashboard-vscode)

All 24 projects list 0 stars. Anchors are repo-relative paths read from raw source.

## ai-guardrails-kit
https://github.com/ganbaroff/ai-guardrails-kit (stars: 0)
not a Claude statusline: a hooks/guards collection. Its `mods/spend-line` mod (`hooks/register.ts`) calls `$.ui.status(parts.join(' · '))` with plain uncoloured text (`$1.23 · context 40% · 5h 20%`) plus 80/90/100% toasts; no colour code, theme, fill or separator styling anywhere (`texts.ts` is only EN/RU strings). Points 1-10: not present, except 8 (no glyphs; text labels `5h`/`7d`) and 10 (a single `LANGUAGE` const in `texts.ts`).

## claude-cache-statusline
https://github.com/GandzyTM/claude-cache-statusline (stars: 0)
1. Mixed. Fixed per segment (bash vars in `statusline.sh`): dir `38;5;117` (l15), model `38;5;183` (l35), git `git:(` frame `240`, branch `204`, dirty mark `226`; separator `240`; limits text `250`. By threshold: context-bar fill (l48-62) 0-50% `255` near-white, 50-75% `51` cyan, 75-90% `226` yellow, 90-95% `208` orange, 95%+ `196` red, thresholds chosen around auto-compact. Cache timer by state: warm green `114` / yellow `226` near expiry, cold orange `208` (`/clear?` hint) or grey `244` (l119-143).
2. No themes. Bundled mod `plugins/cache-indicator/hooks/cache.ts` uses Ink colour names (`gray`/`yellow`/`green`/`red`, l30-76).
3. 256-colour index only (`c()` helper l8 printf `\033[38;5;Nm`). No depth detection, no NO_COLOR.
4. Foreground only, no background fills.
5. Plain text separator `│` in 240 grey (l187).
6. Neighbours distinguished by distinct fixed hues plus the grey `│`.
7. None; fixed 256 colours, no light/dark adaptation. Context-bar near-white at low use assumes a dark terminal.
8. `█`/`░` bar glyphs (l68), one emoji; no Nerd Font.
9. README documents five context stages with synthetic screenshots (`examples/gen_screenshots.py`).
10. Edit the `if [ "$CTX_INT" -ge ...]` chain in the script (README l92). No config file.

## ccus-cli
https://github.com/gaoshang212/ccus-cli (stars: 0)
1. One colour only: whole `ctx NN.N%` segment wrapped in `\x1b[31m` red when over a threshold (`src/lib/payload.ts:171-173,296-303`); all other segments uncoloured. Thresholds per window tier: 200K window 80%, 1M window 50% (README l77-82).
2. Themes: not present (the web dashboard `chart-assets.ts` has its own hex palette, not the statusline).
3. ANSI 16 red (`31`) only; no depth detection, no NO_COLOR.
4. Foreground only.
5. Plain ` | ` join (`payload.ts:~311`): `5h | 7d | ctx | model | workspace | ⎇ branch | time`.
6. Separators only (` | `).
7. Not present.
8. `⎇` branch glyph, `⏱` time, `⬆` update mark; no Nerd Font.
9. Main product is a usage collector/web dashboard (`dashboard`, `export`, `aggregate` commands), not styling.
10. Env vars `CCUS_CTX_RED_PCT[_200K|_1M]`, `CCUS_CTX_RED_TOKENS[_200K|_1M]`; `ccus install` writes settings.json.

## gccusage
https://github.com/gapietro/gccusage (stars: 0)
1. By position within a theme: segment i uses `theme.segments[i % len]` (`src/render/powerline.ts:~52`), a 4-step bg ramp that darkens left to right. Overridden per widget by `fg`/`bg` in config. By state: runtime backgrounds from thresholds in `src/widgets/alert-colors.ts`: session-cost/today-spend/context amber `#a67c00` / red `#c01c28` at warn/danger thresholds (`alerts.sessionWarn` 5, `sessionDanger` 15, `dailyWarn` 10, `dailyDanger` 25), compact-countdown own amber/red pair, vim-mode green `#2ec27e` / amber `#e5a50a`.
2. Five bundled (`src/render/themes.ts`): default (purple `#5f5faf` then greys), ocean, forest, sunset, minimal. Format: per-segment `{fg,bg}` array of 4, cycled. Users select by name via `powerline.theme`; no user-defined theme file (custom colours only via per-widget `fg`/`bg`).
3. Hex (3 or 6 digit) plus 12 named colours (`src/render/colors.ts` `NAMED_COLORS`); ansi256 explicitly rejected with a config error (README l398-407). `chalk.level = 3` forced (powerline.ts:9) = always truecolor; no downsampling; NO_COLOR not honoured.
4. Background-filled pills with 1-space padding (` text `), plus plain mode (`powerline.enabled:false`) with fg-only.
5. Powerline-style separator `▶` (default, configurable) coloured fg = previous segment bg, bg = next segment bg; closing separator on terminal bg (powerline.ts:~86-107).
6. Strong, algorithmic: if CIEDE2000 distance between adjacent backgrounds < `MIN_SEPARATOR_DELTA = 8` (`src/render/color-compare.ts`), the wide separator would not read, so it falls back to `separatorThin` `│` drawn in the previous fg. Alert colours were hand-picked to stay distinct from neighbours (`alert-colors.ts` header comments, issues #36/#40/#45).
7. `contrastingForeground(bg)` (color-compare.ts:138) picks dark or light text by WCAG contrast when a widget sets `bg` without `fg`. No terminal-background adaptation.
8. `▶`, `│`, ASCII bar `[===-------]`; some emoji; no Nerd Font requirement.
9. Published JSON Schema for the config (`config-schema.json`), config validation error line on the bar, `flex` layout modes.
10. `~/.config/gccusage/settings.json` (partial overrides), `lines[].widgets[]` with `type`/`fg`/`bg`, `gccusage setup` CLI.

## ccseat
https://github.com/garzario/ccseat (stars: 0)
1. Mixed. Fixed roles in `lib/ccseat/statusline.sh:105-117` (`_SL_*`): labels mid-gray `176,174,165`, faint `110,108,102`, main text `39` (terminal default fg), kraft `212,162,127` for usage >=60% and uncommitted `*`, orange `217,119,87` for >=85% and alerts, blue `106,155,204` for progress, purple `167,139,250` for ultracode mode, red `229,83,75` for exhausted seat / LIMIT REACHED. By state: usage text uses SOFT under 60, MID 60-84, HI 85+ (l152-153). By position: each seat (account) gets an accent cycling orange/blue/green/kraft/purple by its index in the seat list `i % 5` (l120-145, `_ccseat_sl_seat_color`), bold.
2. One Anthropic palette; no theme files. Shared with the picker via `ccseat_colors_enable` (`lib/ccseat/core.sh`).
3. Truecolor `38;2;r;g;b` (l109-117); picker palette comments mention 256-colour for Terminal.app. Honours NO_COLOR (`statusline.sh:75`) and a `colors=never|off|no|false|0|none` line in `~/.ccseat/config`.
4. Foreground only.
5. Plain spacing `"   "` gaps (`_CCSEAT_SL_GAP`, l20); no separators glyphs.
6. Per-seat accent colour on the seat name; labels grey vs values in text/accents.
7. Main text left at the terminal's own foreground (`39`) "so light themes stay readable" (l86-90 comment). No contrast computation.
8. `●`/`○` dots for progress (l165), emoji in picker; no Nerd Font.
9. Dot meters instead of bars; `LIMIT REACHED` bold red banner.
10. `~/.ccseat/config` key `colors`; NO_COLOR env.

## claude-mods (gauravruhela07)
https://github.com/gauravruhela07/claude-mods (stars: 0)
Not a classic statusline: a set of seven Claude Code "mods" (function-hook plugins) drawing panes/bands/status lines through the mod API, not ANSI. Styling is by Ink-like semantic colour names, not hex.
1. Semantic role names only: `success`/`warning`/`error`/`subtle`/`claude`/`suggestion` plus `dimColor`. skins (`skins/hooks/skins.ts`) maps skin→role: matrix `success`, pirate `warning`, zen `subtle`, retro `claude`, space `suggestion`. savvy-progress (`savvy-progress/hooks/register.tsx:168-238`): spinner `claude`, slow note `warning`, head `success`/`claude`/`warning` by state, errors `error`, stats `dimColor`. cache-tax status via `$.ui.status(...)` plain text; busted turn rows `warning` (`cache-tax/hooks/register.tsx:314`).
2. Themes: only the "skins" (spinner glyphs + verbs + one colour role), 5 bundled: matrix, pirate, zen, retro, space. User-defined: not present. Palette itself belongs to Claude Code's active theme.
3. Role names resolve through the host theme; no direct colour spec, depth, or NO_COLOR handling in these mods.
4. Foreground text only (`<Text color>`).
5. Plain text ` · ` joins.
6. Distinct semantic roles; otherwise `dimColor`.
7. Delegated entirely to Claude Code's theme (role names adapt to light/dark).
8. Unicode spinner glyph sets per skin (`░▒▓█`, `_-~^`, `·∙•`), emoji few.
9. `/skin` picker with sample in the skin's colour; animation ticks (TICK_MS 250).
10. Slash commands (`/skin`, `/savvy-progress on|off`); choice remembered; no config file.

## claude-code-midnight-synthwave
https://github.com/gblsun/claude-code-midnight-synthwave (stars: 0)
1. Role palette applied to segment kinds (`claude/palette.mjs:5-17`, used in `claude/statusline.mjs:231-390`): labels always LABEL lavender `#9a86c2`; values by role: model/cost/duration/PR ACCENT neon pink `#ff2e97`; folder/repo/vim/ahead INFO cyan `#36f9f6`; branch/session/agent HIGHLIGHT purple `#b967ff`; changed files WARN orange `#ff8b39`; behind/fast-mode CAUTION yellow `#fede5d`; numbers STRONG `#e5dcf2`; separators MUTED `#4b3d66`. Thresholds: `levelColor(pct)` <50 cyan, <80 yellow, else orange, deliberately avoiding red/green for colour-blind users (palette.mjs:19-20). PR review state via regex table (statusline.mjs:222-225).
2. One bundled palette; also a Claude Code theme file `claude/themes/midnight-synthwave.json` (base `dark-daltonized`, ~40 role overrides such as `claude`, `suggestion`, `permission`, `rate_limit_fill`) for `/theme`. Single theme, no user theme mechanism beyond editing.
3. Truecolor `38;2` only (`palette.mjs:4-6`). No depth detection or NO_COLOR.
4. Foreground only.
5. ` · ` dot (MUTED) within a segment, ` │ ` (MUTED) between packed segments (`statusline.mjs:16,406`).
6. Label/value colour alternation within each segment plus per-role value hues.
7. Fixed for dark backgrounds ("quase pretos"); the theme is `dark-daltonized` based. No adaptation.
8. Block bar `█░` with cyan→pink gradient when under 50% (palette.mjs:23-34); small ASCII-art mascot on the right (`statusline.mjs:400`, colour `#d77757`) when width >= 70; OSC 8 links for repo/PR.
9. Gradient bar, accessibility-driven level colours, mascot, Windows-only hardware segments, themed spinner verbs in Portuguese.
10. Edit `palette.mjs`; installer scripts `install.mjs`/`install.ps1`.

## claude-code-bear-statusline
https://github.com/gecgelcem/claude-code-bear-statusline (stars: 0)
Not its own renderer: a ccstatusline configuration (`ccstatusline-settings.json`, version 4) plus helper widget script.
1. Fixed per widget via ccstatusline colour names (`ccstatusline-settings.json`): model cyan bold, thinking-effort white, compaction-counter yellow, session-cost magenta, session-clock/reset-timers/cache-timer/cwd brightWhite, git-branch magenta, git-changes yellow, separators/dots brightBlack. By threshold in `statusline-widgets.sh:19-34`: context `%` and rate-limit `%` green <50, yellow 50-79, red >=80 (`level()`), context bar `▓░`. The bear pet colour: cyan normal, yellow >=75% context, red >=90% or 5h >=80% (l48-52).
2. No themes of its own; ccstatusline `colorLevel: 1` (16 colours), `powerline.enabled: false`.
3. ANSI 16 names only (`ESC[32m` etc. in the script, l13-14).
4. Foreground only.
5. Plain `│` and `·` custom-text/separator widgets in brightBlack.
6. Separator widgets only.
7. Not present.
8. Emoji kaomoji bear (`ʕ•ᴥ•ʔ`) animation with states (sweating 💦, panic, nap 💤); `▓░` bar.
9. Animated pet whose face and colour follow context/rate-limit state (`statusline-widgets.sh:36+`).
10. ccstatusline settings JSON; `install.sh`.

## ai-cli-statusline
https://github.com/GenSSK/ai-cli-statusline (stars: 0)
1. Mixed. By threshold (`claude/statusline.sh:82-95,283-295`): context bar and rate bars green <50, yellow 50-79, red >=80 (ANSI 32/33/31). Fixed: effort tag dim `2`, fast-mode magenta `35`, dir parent `38;5;74` deeper blue and current dir bold sky blue `1;38;5;117` (l157-162), line-1 separators plain `│`, rate-limit unset rows `90`.
2. Not present.
3. ANSI 16 plus two 256-colour indices; no detection, no NO_COLOR. (It also configures Codex's `status_line_use_colors`, README l131.)
4. Foreground only.
5. Plain ` │ ` text between fields.
6. Separators only plus differing fixed colours.
7. Not present.
8. Emoji/box glyphs: `█░` and `▱` meters, `⚡fast`.
9. Also installs the status line for Codex CLI.
10. Installer scripts; no colour config.

## claude-skills (GeoffBao / webup-statusline)
https://github.com/GeoffBao/claude-skills (stars: 0)
A skill whose generator script emits a bash statusline; styling lives in `webup-statusline/scripts/generate.mjs`.
1. Fixed per element per theme plus state arms. Theme keys (l36-62): `model`, `dir`, `git`, `git_dirty`, `vim`, `worktree`, `style`, `cost`, `thinking`, `io`, `pct`, `sep`, `bar_empty`; thresholds: context `ctx_ok/ctx_warn/ctx_low` by remaining % (<20 low, <50 warn, else ok; l386-388); effort `effort_high/med/low/off`; rate limits `rate_ok/warn/full` at 50/80% used (l259-260, 490-508).
2. Four bundled themes: gruvbox (default), robbyrussell, minimal, dracula (l35-150). Format: flat dict of semantic role keys → escape strings (truecolor for gruvbox/dracula, 256-index for robbyrussell, ANSI 16 for minimal). User-defined: not present (edit the script).
3. Mixed per theme: truecolor `38;2`, 256 `38;5`, ANSI 16. No detection, no NO_COLOR.
4. Foreground only.
5. Plain separator string per theme (`' | '`, key `separator`) painted with `sep` colour.
6. Separators only; element colours differ.
7. `minimal` theme uses terminal defaults (`0`, dim `2`, ANSI 31-33). No adaptation.
8. Per-theme icon sets (`elementIcons`, l158-): gruvbox `✦ ⌂ ⎇ ⌨ ⊕ ↯ ❋ ⇅ ⧗ ⊟`, dracula `◈ ...`; bar chars `■□`.
9. Generator interviews the user, emits and installs the script (`--install`).
10. CLI flags `--elements`, `--line2`, `--theme`, `--effort-icon`, `--install`.

## claude-monitor
https://github.com/ggarcia0/claude-monitor (stars: 0)
not a Claude statusline: an htop-style Python TUI that monitors running Claude Code sessions. Styling notes anyway: 3 themes (`oscuro`, `claro`, `contraste`) as role→RGB dicts (`claude-monitor.py:38-52`: coral/cream/purple/teal/green/yellow/red/gray plus bg roles sel/panel/band/zebra), truecolor `38;2`/`48;2` helpers (l30-31), status badges with fg/bg per state (waiting yellow, blocked red, busy teal, idle green, dead grey; l54-60), animated gradient titles (`gradient()` l270), `claro` theme for light terminals, theme cycling at runtime (key/menu).

## cc-statusline-widgets
https://github.com/GGGODLIN/cc-statusline-widgets (stars: 0)
1. Fixed per widget, per theme: each widget kind owns a pill background variable (`scripts/wrapper.sh:47-65`): `WT_BG_MODEL`, `_CACHE`, `_SKILL`, `_GIT_OK`, `_GIT_DIRTY`, `_COST`, `_RUNAWAY`, `_USAGE`/`_USAGE2`, `_VENDOR`, `_CODEX`, `_GROK`, `_GLM` and `_GLM_PEAK`, `_AGENTS`, `_CTX`, `_SYS`/`_SYS2`. By state: git pill ok vs dirty colour (l729-730); GLM peak variant (l895); percentage text `pct_color` ok <50, warn 50-74, hot >=75 (l102-107); quota text `usage-color.sh:14-20` green <30, blue 30-49, yellow 50-79, red >=80, bold red >=100. By position (system line): alternating `WT_BG_SYS` / `WT_BG_SYS2` pills (l1263-1266) and usage pills alternate `USAGE`/`USAGE2` per account (l1167-1169).
2. Ten bundled themes as `themes/<name>.conf` shell files (claude-coral, catppuccin-mocha, nord, gruvbox-dark, tokyo-night, mono, dracula, lunar-pink, reverie, morning-haze), each setting `VL_BG_<WIDGET>` per-widget backgrounds plus `VL_FG_TEXT/DIM/OK/WARN/HOT` (e.g. `themes/catppuccin-mocha.conf`: dir blue, git_ok green, git_dirty peach, model mauve, cost pink...). Users copy `cc-widgets-theme.conf.example` to `~/.claude/cc-widgets-theme.conf` and override individual `WT_BG_*`/`WT_FG_MODEL`; drop-in new themes in `themes/`.
3. 256 index or `"R,G,B"` truecolor per value (`bg()`/`fg()`, wrapper.sh:70-90). No detection, no NO_COLOR.
4. Both: `WT_STYLE=pill` (bg-filled powerline pills) or `lean` (fg-only, no background) (l168-176).
5. Powerline: left rounded cap U+E0B6, separator U+E0B0, right cap U+E0B4 (l66-68); separator fg = previous pill bg, bg = next pill bg (l240-246); caps in the end pills' bg.
6. Different per-widget background hues in the semantic grouping (fixed 3 lines), alternating two shades in the system and usage rows, powerline arrows.
7. One `VL_FG_TEXT` per theme (dark text on pastel pills in catppuccin; per-pill `WT_FG_MODEL` override "for a light model bg"). No computation.
8. Nerd Font powerline glyphs required for pill style; emoji in widget text (🤖, 🌡️); bar `▰▱`.
9. 3-line semantic layout (`WT_LAYOUT=fixed`) vs greedy wrap (`auto`); `scripts/preview-themes.sh`; design adapted from coralline / powerlevel10k.
10. Bash config file, env `CC_WIDGETS_CONF`, `WT_STYLE/THEME/LAYOUT/MAX_LINES/BAR_WIDTH`.

## claude-infobar
https://github.com/GiampaoloGabba/claude-infobar (stars: 0)
Two renderers: a mod band (`hooks/register.tsx`) and a bash fallback (`extras/statusline.sh`).
1. By value/state, same mapping in both. Model by family (`hooks/testi.ts:83-89`, statusline.sh:31-41): Opus bright blue, Sonnet orange `#ff8700`/208, Haiku green, other cyan. Effort (`testi.ts:91`): low green, medium cyan, high yellow, xhigh orange `#ff8700`, max red, unknown gray. Directory bold yellow, branch cyan. Context/limit level `coloreLivello`: green <50, yellow 50-79, red >=80 (`testi.ts:180`; bash l131-141 at 50/80).
2. Not present.
3. Mod: Ink colour names plus hex `#ff8700`; bash: ANSI 16 plus `38;5;208`. No detection, no NO_COLOR.
4. Foreground only (no bg).
5. Plain ` | ` in `dimColor` (register.tsx:692).
6. Distinct per-field hues, dim ` | `.
7. Ink names follow the host theme; none otherwise.
8. `◐` context glyph, `█░` bar, `◷` count, `✓`; no Nerd Font.
9. Mod also shows pasted-image thumbnails (`png.ts`, `raster.ts`) above the prompt.
10. Mod install via plugin marketplace; no styling config (edit `testi.ts`).

## neon-noir
https://github.com/gicerre/neon-noir (stars: 0)
Mostly a PowerShell/Windows Terminal setup; statusline is `claude/neon-statusline.js` (207 lines).
1. Fixed per segment, one theme (`neon-statusline.js:15-16`): path cyan `24,214,208`, branch green (yellow plus `●` when dirty, l177), model purple `164,114,255` with `text` `189,242,207` for effort, brackets/labels `dim` `85,102,95`, lines added green / removed red. Bars (l47-51): green <60, yellow 60-79, red >=80, empty `▱` dim. Third line tags: skill yellow, plugin purple, mcp cyan, agent green (l139), active-in-current-prompt bright vs used-earlier dimmed.
2. Single look in the statusline; `docs/THEMES.md` is about 12 "cinema" terminal modes (e.g. synthwave, Matrix) for the shell, not the statusline.
3. Truecolor `38;2` only (`paint`, l14). No detection or NO_COLOR.
4. Foreground only.
5. Box-drawing frame `┌─[ … ]─[ … ]`, `├─`, `└─` in dim (l169-204): bracket frame instead of a separator.
6. Brackets plus per-field hue.
7. Not present (dark neon assumed).
8. Box-drawing frame, `▰▱` meters, `◆ ⚡ ⧉ ◈ ⚙ ↻`, Nerd Font branch glyph; EN/IT texts via `NEON_LANG`.
9. Three-line frame matching the PowerShell prompt; incremental transcript parsing for skills/plugins/MCP.
10. Installer-driven; `~/.config/neon-noir/config.psd1` for the shell part; statusline has no colour config.

## harness (giocaizzi)
https://github.com/giocaizzi/harness (stars: 0)
Multi-harness plugin (Claude Code, Copilot CLI, pi, opencode); the "hud" plugin has a classic status line (`plugins/hud/hooks/statusline.mjs`) plus mod bands/panes.
1. Fixed per part with state arms, hard-coded Catppuccin Mocha (`statusline.mjs:31-36`): user@host white `#cdd6f4`, branch red `#f38ba8`, GCP project yellow `#f9e2af`, session name blue `#89b4fa`, path pink `#cba6f7`, model white, cost grey `#6c7086`; brackets grey. Threshold `tone(pct)` (l36): >=80 red, >=50 yellow, else blue, applied to context % and 5h/7d windows (l86-93). Weather glyph for context and battery glyph for windows chosen by level (`weather.mjs`). The mod rewrite layer (`markup.mjs:17-44`) maps entities to Catppuccin hexes (issue green `#a6e3a1`, PR mauve `#cba6f7`, workitem/host blue, time teal, sha yellow, line peach) plus role names (`success`, `error`, `merged`, `inactive`, `warning`).
2. Single hard-coded Catppuccin Mocha; no theme switch; role names defer to host theme.
3. Truecolor `38;2` (l32). NO_COLOR honoured in links/markup (`hooks/links.mjs:100-101` `styled(env)`), not in the status line script itself.
4. Foreground only.
5. Bracket chips `[icon value]` with grey brackets; two lines joined by box corners `┌` `└` in blue (l103).
6. Each part is a bracketed chip; hues differ by role.
7. Not present beyond role names.
8. Nerd Font icons (`ICON` in `weather.mjs`, 79 nerd-font hits), emoji few.
9. Context grid via raster image cells (`context.mjs`), PR/CI strip, reply rewrites with colour-coded refs.
10. Settings documented in `docs/hud.md`; installed as a Claude plugin; no theme config in the status line.

## bottomline
https://github.com/giorgiostokje/bottomline (stars: 0)
1. By position: a background gradient interpolated across the number of segments actually shown (`lib/ansi.sh:76-98` `flush`, `expand_bg(gradient, n)` in linear RGB), first keyframe on first segment, last on last. Text colour is one `text` role; icons use `accent`; states use `warning`/`danger`. By state: per-segment maps in config, e.g. effort level → `{color, icon}` (low..max), context token thresholds (`"200000"` → warning, `"300000"` → danger), usage percentage thresholds, branch-name matches (README l140-152, 304-310).
2. 22 bundled (`themes/*.json`): claude (default), clarice, claire, catppuccin latte/mocha, dracula, everforest dark/light, github dark/light, gruvbox dark/light, monokai, nord, one dark/light, rose-pine plus dawn, solarized dark/light, tokyo-night plus day (README l201-224). Format: semantic palette of 5 roles `text`, `accent`, `warning`, `danger`, `background` (hex string or array of keyframes) (e.g. `themes/catppuccin-mocha.json`). Users set `appearance.colors.*` at user/project config layers, or add theme JSON files (`/bottomline:create-theme` can design or extract one).
3. Truecolor hex only (`bg3`/`fg3`, ansi.sh:8-9). No depth detection or NO_COLOR.
4. Background-filled segments with a 1-space pad each side, fg text.
5. Powerline separator, default Nerd glyph, override via `segments.separator` (codepoint or literal, e.g. `e0b0`) (README l295-300); colours: fg = this segment bg, bg = next segment bg; last separator on terminal bg (ansi.sh:90-94).
6. Smooth gradient steps in lightness/hue between consecutive backgrounds plus the arrow separator.
7. Light themes shipped (latte, github-light, gruvbox-light, one-light, rose-pine-dawn, solarized-light, tokyo-night-day, everforest-light) as a manual choice; single `text` colour per theme, no computed contrast.
8. Icon sets `nerd` (default) | `emoji` | `none`, per-segment overrides (README l229-246, `lib/icons.sh`).
9. Slash commands `/bottomline:configure` and `/bottomline:create-theme`; custom script bars; three-layer config merge (user, project, local).
10. JSON config at user/project levels, theme name, per-segment settings, `segments.disabled`.

## claude-widget-usage
https://github.com/Glerme/claude-widget-usage (stars: 0)
1. State only: usage bar coloured by threshold (`statusline.sh:80-96`) ok green `\033[32m`, warn yellow `33`, crit red `31`, at `THRESHOLD_WARN`/`THRESHOLD_CRIT` env-tunable; `COLOR_DIM` `2` declared.
2. Not present.
3. ANSI 16; no detection, no NO_COLOR.
4. Foreground only.
5. Plain double-space/`·` text, e.g. `📊 in · out  bar %`.
6. Not distinguished beyond the bar colour.
7. Not present.
8. Emoji `📊`, configurable `BAR_FILLED`/`BAR_EMPTY` glyphs.
9. Nothing notable.
10. Env vars for thresholds and bar glyphs.

## StatusLine (gn00678465 / cc-statusline)
https://github.com/gn00678465/StatusLine (stars: 0)
Rust binary.
1. Fixed roles from a `Palette` (`src/render/theme.rs:60-78`): folder cyan `100,220,255`, branch green `100,255,100`, model blue `80,180,255`, tokens white `240,240,240`. State: meters (context, limits) use `level_color(pct, ladder)` over `thresholds [50,70,90]`: `bar` style ladder green→yellow→orange→red, `dots` style green→orange→yellow→red (`meter.rs:20-23`). Effort: medium yellow, high/xhigh orange, max red (`blocks.rs:32-36`); git counts S green / W yellow / C red; cache hit green >=50 else gray; TTL colour by remaining (green/yellow/red/bright red); dim separators.
2. No named themes; a `[colors]` table in `~/.config/cc-statusline/config.toml` (`folder`, `branch`, `model`, `tokens`, `levels` = 4 hex, `thresholds` = 3 ascending ints); strict `#RRGGBB` validation (`theme.rs:112-125`). Effort, git counts, cache, TTL, separators are not configurable.
3. Truecolor `38;2;r;g;b` only (`src/render/color.rs`). No depth detection or NO_COLOR.
4. Foreground only.
5. Plain text: `│` dim between groups, `›` between folder and branch, `·` within, `├─`/`└─` for multi-line (README l114-127).
6. Separators plus distinct fixed hues.
7. Not present (dim attribute for secondary).
8. Emoji per field (📁 🌿 🤖 🧠 ⚡️ 📊), `▓░` bar or `●○` dots (meter styles).
9. Meter styles `bar`/`dots`, width 1-20, layouts `auto`/`stacked`, wrap into 2-3 lines by `COLUMNS`.
10. TOML config at XDG path; `layout`, `[meter]`, `[colors]`; validation errors fall back with message.

## googilyboogily-claude-code-statusline
https://github.com/GoogilyBoogily/googilyboogily-claude-code-statusline (stars: 0)
1. Fixed per segment from Catppuccin Macchiato palette (`src/theme.ts:4-31`, `src/main.ts:15-70`): dir `blue` bold, VCS name `mauve`, model `teal`, window size/token counts/labels `subtext0`, percent `text` bold, glyph dots `overlay1`, separator `surface2`, error `red`. By position: the progress bar gets a per-cell gradient by cell index along the bar green→yellow→peach→red (`src/bar.ts:14-46`), filled cells coloured by position (not by current level), empty cells `surface2`.
2. One theme (Catppuccin Macchiato, full 26-colour set as semantic names). Customise by editing `theme.ts` and rebuilding (README l41-44).
3. Truecolor `38;2` (`fgRgb`). No detection or NO_COLOR.
4. Foreground only.
5. Plain `│` in `surface2` with double spacing (`main.ts:15`).
6. Separators plus distinct palette hues.
7. Not present (dark Macchiato).
8. Heavy line bar `━ ╸ ─`, `↻`, `🔖` for jj bookmarks; no Nerd Font.
9. Per-cell gradient bar; supports git and jj.
10. Source constants only; compiled with Bun.

## ClaudeMods (Gooner44)
https://github.com/Gooner44/ClaudeMods (stars: 0)
Mods collection (usage-bar, staff-board, compact-*); the relevant one is the `usage-bar` band.
1. By state: `level(pct)` 90 crit / 70 warn / ok (`plugins/usage-bar/hooks/register.tsx:12`), fixed colours `ok #3987e5` blue, `warn #e0a100`, `crit #d03b3b` (l15), grey track `#6e6e6e`. Only alert levels colour the label text; ok uses default text with `dimColor`. Level also carried by words/glyphs ("Nearing limit", `▲`/`●`) so "a level never rides on color alone" (l14).
2. Not present.
3. Hex via Ink props; no NO_COLOR.
4. Both: a drawn bar uses `backgroundColor` boxes (l228-229) in the main renderer, with a `━`/`─` text fallback (l235-236).
5. Not present.
6. Not applicable (three labelled slots).
7. Chosen "to read on light and dark" (comment l14); fixed mid-tone colours.
8. `━ ─ ▲ ●`.
9. Real filled bar via flex Box widths; staff-board animated sprites.
10. None (edit source).

## clickline
https://github.com/gradigit/clickline (stars: 0)
1. Ten semantic colour slots per theme (`statusline.sh:387-504`): `label`, `sep`, `dim`, `sapphire`, `lavender`, `mauve`, `gold`, `green`, `peach`, `red`. Slots assigned to segments: dir `sapphire`, branch `green`, dirty `·N` `peach`, ahead `green`/behind `peach`, PR number `lavender`, CI ✓ green / ✗ red / ? peach, model `lavender` bold with thinking `mauve` italic, vim `mauve`, agent `lavender`, context `gold` (used colour by threshold at l518-520: <50 green, <75 peach, else red), custom items choose a slot by name (l705-708, default `dim`).
2. Ten bundled themes in a `case` of RGB escapes: catppuccin-mocha (default), frappe, latte, dracula, tokyo-night, gruvbox-dark, nord, solarized-dark, one-dark, rose-pine (README l160-171). Format: semantic slot palette. User-defined: not present (add a case branch); unknown name falls back to mocha.
3. Truecolor `38;2` only. No detection or NO_COLOR.
4. Foreground only.
5. Plain ` │ ` (`c_sep`) and ` · ` (l531-532); no powerline.
6. Separator colour and the per-slot hues.
7. Light variant (catppuccin-latte) is manual; no automatic adaptation.
8. Emoji warnings ⚠️/🚨 at 60/80% context; OSC-8 clickable path/branch/PR/quota/cost.
9. Textual TUI configurator (`configure.py`) with live preview, drag-and-drop layout, theme switcher, presets; custom shell-driven items; per-repo `.clickline`.
10. `~/.claude/clickline.conf` (`THEME=`, `SHOW_*` booleans); TUI/bash wizard.

## moods
https://github.com/grassclaw/moods (stars: 0)
1. Per theme 3 roles (`scripts/statusline.sh:25-37`, `themes/<name>/theme.json` `colors`): `primary`, `accent`, `ok` as 256-colour indices. Segments: model and cost `primary`, effort `accent`, dir `ok`, context `ok` <50, `primary` 50-79, `accent` >=80; separator `·` fixed grey `245`.
2. Four bundled themes (caveman 220/213/114, doge 96/179/108, pirate 179/24/108, shakespeare 130/208/100), folder-per-theme with `theme.json` (also words, emoji, outputStyle, signoff, art); users add a folder.
3. 256 index only (`38;5;N`). No detection or NO_COLOR.
4. Foreground only.
5. Plain dim ` · `.
6. Separators plus three roles.
7. Not present.
8. Per-mood emoji prefix; the statusline words themselves are randomised mood vocabulary ("such", "wow").
9. A joke-but-functional plugin; the statusline is themed in text more than colour.
10. `/mood <name>`; theme folder authoring.

## claude-statusline (gravicity-archive)
https://github.com/gravicity-archive/claude-statusline (stars: 0)
1. By model: per-model theme (`statusline-command.sh:622-645`): Opus purple (`93`/`139,92,246`), Sonnet orange (`208`/`255,140,0`), Haiku teal (`37`/`0,188,212`), default orange; primary and accent shades each. By state: health good/warn/crit cyan/orange/red tied to `thresholds` context 50/75, memory 4/8, staleness 100/500 (l507-508, 572-581); user may override via `health_colors`. Fixed: purple/green/yellow/slate for CLI output (l28-36). Project colour: each project declares `color` hex in `.claude/statusline-project.json`.
2. Three effective model themes; not user-defined; health colours configurable.
3. Detects `COLORTERM` truecolor/24bit and otherwise falls back to 256-colour approximations (l26-36, 559-581, README l248-281). NO_COLOR not honoured.
4. Foreground only.
5. Plain text; animated pulse bar of `━` characters.
6. Distinct per-field colours; pulse gradient from theme colour to health colour.
7. Not present.
8. Emoji set (📁 🛡 etc.), `━ ─` pulse glyphs.
9. Animated pulse: truecolor RGB gradient (l1312-1383), simplified moving orb in 256-colour mode; screenshots in `screenshots/`; cost cycling.
10. `~/.claude/statusline-config.json` (`display`, `thresholds`, `health_colors`), per-project JSON.

## claude-usage-statusline (Greg-Klein)
https://github.com/Greg-Klein/claude-usage-statusline (stars: 0)
1. State: bar colour green `38;5;46` / yellow `226` / red `196`, switching at `CLAUDE_BAR_WARN` (60) and `CLAUDE_BAR_CRIT` (85) (`statusline.sh:25-26,40,68-70`). Fixed: model label cyan, dir/eta/effort dim, brackets dim, unfilled cells `235` dark grey (l58).
2. Not present.
3. 256 index and ANSI 16/attributes; no detection, no NO_COLOR.
4. Foreground only.
5. Plain double-space with `·`.
6. Dim vs coloured text.
7. Not present (README l23: unlit cells are dark grey for contrast).
8. Braille/block partial-fill bar `▉▊░` in `[ ]` brackets (l60-83).
9. Sub-cell bar resolution.
10. Env vars `CLAUDE_BAR_WARN`, `CLAUDE_BAR_CRIT`; "edit the script" for other styling (README l119).

## claude-dashboard-vscode (dashnlines)
https://github.com/grgrwlkr/claude-dashboard-vscode (stars: 0)
Mainly a VS Code extension (status-bar items plus a dashboard webview); it also ships an optional terminal statusline `bin/statusline.js`.
1. State only. Thresholds shared (`segments.js:20-33`): `toneOf(pct)` >=80 alarm, >=50 warn, else none. Terminal renderer maps tone to ANSI red `31` / yellow `33` (`terminal.js:122`); VS Code bar uses the editor's warning/error background (README l215-218). Segments that show a limit or context take the louder of their topics (`COLOUR_BY`, segments.js:34+); weekly limit drives limits topic.
2. VS Code: inherits the editor theme (webview drawn from `--vscode-*` variables, README l86, 229); terminal: none.
3. Terminal: ANSI 16 only; NO_COLOR honoured plus `--no-color` flag (`bin/statusline.js:75`).
4. VS Code status bar items with themed background; terminal foreground only.
5. Templates with literal text; no separator styling.
6. Not applicable.
7. In VS Code, follows the theme; the dashboard's burn-rate rule uses the theme text colour (white on dark, black on light) (README l229).
8. Emoji/Codicon-style glyphs in templates; no Nerd Font.
9. Dashboard with charts and heat tracks; `claudeStatusline.segments` templates like `{today}`.
10. VS Code settings (`claudeStatusline.*`), CLI args as segment templates, `--no-color`, `NO_COLOR`.

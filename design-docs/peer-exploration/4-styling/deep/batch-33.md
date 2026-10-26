# Batch 33: styling deep-dive

Anchors are file names (and line numbers or keys) in the cited project. "Truecolor/256/16" is the SGR class actually emitted. None of the gist scripts checks NO_COLOR or detects colour depth unless said.

## gist e9d4c2dd (justintieu) claude-code-statusline.sh
https://gist.github.com/justintieu/e9d4c2ddb8beb962b2d2bdb39de466b7 | stars n/a
1. Fixed per segment plus threshold. `claude-code-statusline.sh:32-33` defines 8 ANSI-16 codes. Model=CYAN (l.~116 `model_display`), folder=MAGENTA (`folder_display`), branch=GREEN with a dim glyph, session cost=YELLOW, duration value=WHITE, labels (`ctx`, `5h`, `7d`, `up`, `in`, `out`) DIM. Thresholds: ctx bar (l.50-52) and `pct_colored` (l.67-69) green <50, yellow >=50, red >=80; bar fill and the percent share the threshold colour.
2. No themes; colours are constants at the top of the script (l.32-33).
3. Named ANSI 16 only (`\033[3Xm`, `\033[2m`). No depth detection, no NO_COLOR.
4. Foreground-only on terminal background.
5. Plain separator `│` in DIM (`SEP`, l.34).
6. Neighbours distinguished by hue (cyan/green-yellow-red/magenta/green) and dim `│` separators.
7. Not present (white/dim only; no light/dark handling).
8. Emoji `💰`, a branch glyph; box-drawing bar `█░` inside `[ ]`. No ASCII fallback.
9. Two lines: L1 model|ctx bar|5h|7d|up|folder|branch, L2 session cost and token counts computed from the transcript with an in-script pricing table.
10. Edit the script; no config or env.

## gist ea160622 (b19g3r) ccstatusline_settings.json + claude_settings.json
https://gist.github.com/b19g3r/ea160622dda1a80c2dd9788321562f58 | stars n/a
1. It is a ccstatusline config (`type` + `color` per widget): fixed per widget. `ccstatusline_settings.json`: git-branch=magenta, git-changes=yellow, model=cyan, context-length=brightBlack; cwd, tokens-*, session-id, context-bar, git-root-dir, skills have no `color` key (ccstatusline default). No thresholds.
2. No themes in the gist. `powerline.enabled:false`, `separators:[""]` (a single powerline glyph, unused), `startCaps/endCaps:[]`.
3. `colorLevel: 2` (ccstatusline's 256-colour level); names are ANSI names incl. `brightBlack`. Depth handling is ccstatusline's own (not in this gist).
4. Foreground only (powerline off).
5. `separator` widgets between items; `flex-separator` pushes the right group to the edge; `inheritSeparatorColors:false`.
6. Different colours per widget and separators.
7. Not present.
8. Not present in the gist (powerline glyph configured but disabled).
9. `flexMode: full-minus-40`, `compactThreshold: 60`. `claude_settings.json` wires `statusLine.command: bunx -y ccstatusline@latest`.
10. JSON (ccstatusline v3 schema) at `~/.config/ccstatusline/settings.json`.

## gist ed6c86ca (gitawego) statusline-command.sh
https://gist.github.com/gitawego/ed6c86ca0202879b0e1966696b020788 | stars n/a
1. Threshold-driven, mostly. `statusline-command.sh:260-267`: ctx% >=95 bold red `1;31`, >=80 red, >=50 yellow, else green (text `ctx N%`). Cache hit rate (l.209-220): bold red + `↺` on a detected rebuild (create>=20000 and hit<20), green >=50, else dim grey `2;37`. Cache TTL countdown (l.176-193): >=2400 s green, >=1200 yellow, >=300 red, else bold red, expired dim grey. 5h/7d (l.411-412): green, yellow >=70, red >=90. Git `+N` green, `~N` yellow (l.366-367). Effort text RED (l.~437). Model, dir, worktree, branch name, cost: uncoloured.
2. No themes.
3. ANSI 16 with bold/dim modifiers only (`0;3X`, `1;31`, `2;37`).
4. Foreground only.
5. Plain ` | ` between segments (`join_segs`, l.428-435); no colour on the separator.
6. Emoji prefix per segment (`🤖 🧠 💪 ⚡ 💰 📁 🌳 🌿 ⏱️`) and colour of the value; separators plain.
7. Not present.
8. Emoji for every segment; block bar `█░` for rate limits (`make_bar`, l.397-401). No fallback.
9. Cache-bust marker `↺`; bold-red last 5 minutes (comment says terminal may blink it). Cumulative cache rate `ΣN%` dim.
10. Edit the script; it also dumps the payload to `/tmp/statusline-last.json.$$`.

## gist edc399b1 (navidnabavi) statusline-command.sh
https://gist.github.com/navidnabavi/edc399b1e36521a6e84e8f9d4f3c4c19 | stars n/a
1. Mixed. Fixed "pills" with background: session name = `BG 236` + cyan (l.67), dir = `BG 24` + white (l.77), git clean = `BG 28` + white, git dirty = `BG 136` + black with ` *` (l.91-96), vim NORMAL magenta bg / INSERT cyan bg (l.103-106), caveman badge `BG 130` orange. Model = bold magenta `⬡ name` (no bg). Context bar by remaining% (l.126-129): <=10 red, <=25 orange `38;5;214`, <=50 yellow, else green. Rate limits 5h/7d: green, yellow >=70, red >=90.
2. No themes; palette constants l.11-33.
3. ANSI 16 plus 256 indexes (`48;5;236/24/28/136/130`, `38;5;214`). No detection.
4. Both: bold background pills for session/dir/git/vim/caveman, foreground-only for model, ctx bar and rate limits.
5. Pills end with a space and no arrow; the segment separator is a grey `│` (`SEP`, l.37). No powerline glyphs despite the "Powerlevel10k" comment.
6. Distinct background colour per pill (dark grey, blue, green/amber, magenta/cyan), then `│` between groups.
7. Chooses fg per pill by hand: white on dark/green, black on amber/cyan (l.91-106); no automatic contrast.
8. Unicode symbols `✦ ⬡`, Nerd/PUA glyph before dir and branch (the file has them as box/PUA characters), `▓░` bar, `🪨`. No fallback.
9. Dirty state flips the git pill colour (green to amber).
10. Edit the script; env `CAVEMAN_STATUSLINE_SAVINGS=0`.

## gist f0acabf1 (jmelosegui) Oh My Posh statusline
https://gist.github.com/jmelosegui/f0acabf184701e1e4b842ecd6e5d56d7 | stars n/a
1. `statusline.omp.json` (Oh My Posh v3, every segment `style: plain`): model cyan, effort `<magenta>`, path white, git lightYellow with `<green>+staged` `<yellow>~working`, context bar `<{{.Env.CC_CTX_COLOR}}>`, tokens `<darkGray>`, cost yellow, duration white, lines `<green>+ <red>-`, rate limits lightBlue, session name/worktree darkGray. Context colour is chosen in `statusline.ps1:110-112`: >=90 red, >=70 yellow, else green, passed as env var `CC_CTX_COLOR`.
2. Uses Oh My Posh's themes; any OMP theme can replace the file. This one has no palette block.
3. Named colours (OMP resolves them); depth is OMP's business.
4. Foreground only here (OMP supports background/powerline, unused).
5. Whitespace plus emoji; `final_space:false`.
6. Hue per segment only.
7. Not present in the gist.
8. Emoji (`🌿 📁 💰 ⏱ 🧠`). Block-bar built in ps1.
9. Needs `oh-my-posh` on PATH, falls back to plain text if missing (README).
10. JSON OMP theme + PowerShell/cmd wrapper exposing `CC_*` env variables; any OMP template works.

## gist f5ce5bbc (Suhasnama) statusline.sh
https://gist.github.com/Suhasnama/f5ce5bbc57c3016e6839359c2d704075 | stars n/a
1. `statusline.sh:30-34`: model CYAN `[model]`, cost YELLOW, everything else uncoloured. Context bar threshold: >=90 red, >=70 yellow, else green. (`theme: dark` in the header comment is Claude Code's own setting, not read by the script.)
2. No themes.
3. ANSI 16 (`\033[3Xm`). No detection.
4. Foreground only.
5. Plain ` | `, uncoloured.
6. Separators only.
7. Not present.
8. Emoji `📁 🌿 ⏱️`, bar `█░`.
9. Two lines.
10. Edit the script.

## gist f9660748 (tonyrosario) statusline.sh + touch-cache-ts.sh
https://gist.github.com/tonyrosario/f9660748f1a423b7f179de6745cfdb9d | stars n/a
1. Explicit role scheme (`statusline.sh:15-21` comment): identity (dir, branch, account) uses hues no state uses; gauges (ctx, cache, 5h, 7d) share one green/yellow/red scale; facts and separators neutral. Values: dir `1;96` bright cyan, branch `1;91` bright red-ish, git parens in dir colour, dirty `✗` `1;93`, model `38;5;252`, labels `38;5;246`, separators `38;5;240`, empty meter pips `38;5;238`, arrow `➜` `1;92`. Linked worktree swaps dir/branch to cobalt `1;38;5;69` + periwinkle `1;38;5;147` (l.43-52). Context REMAINING: <20 `1;31`, 20-40 yellow, >40 green. Cache elapsed: green <5m, yellow 5m-1h, red >1h "EXPIRED". Usage meters coloured by projected pace (l.~150): proj <80 green, <100 yellow, else red, bold red at >=90% used; first 10% of window damped.
2. No themes; the oh-my-zsh "robbyrussell" look is hard-coded.
3. 16 + 256 index (`38;5;N`). Greys are fixed 256 values on purpose, since SGR dim renders too faint on dark themes (comment l.12-14). No detection.
4. Foreground only.
5. Plain `|` in `RULE` grey.
6. Hue by role: identity vs state vs neutral; separators grey.
7. Chooses fixed mid greys (252/246/240/238) to work on dark backgrounds; no real adaptation.
8. Meters `▰▱` (six pips, dropped below 150 columns via `COLUMNS`), `➜`, `✗`. Unicode only.
9. Colour = pace, not level, for plan usage; worktree gets a distinct colour pair "so working in a worktree is visible at a glance". Optional account label in orchid `38;5;170` for non-default config dir.
10. Edit script; `COLUMNS` read; `touch-cache-ts.sh` hook feeds the cache segment.

## gist fa52852b (TanjaZzz) statusline-command.sh
https://gist.github.com/TanjaZzz/fa52852ba2bfd9192e37ac746d8ce67d | stars n/a
1. `make_bar` (l.5-30): <=50 green, <=75 yellow, else red for the 5h, 7d and context bars (`\033[0;3Xm`). Labels: `5h:`/`7d:` cyan `0;36`, `context:` magenta `0;35`; percent and reset text `0;37`; tokens/cost labels `2;37` dim.
2. No themes.
3. ANSI 16 only.
4. Foreground only.
5. Plain ` | ` (via `IFS`).
6. Label hue (cyan vs magenta) and separators.
7. Not present.
8. `█░` bar in `[ ]`; no emoji.
9. None.
10. Edit script.

## gist fb22a345 (maddada) ccstatusline setup prompt
https://gist.github.com/maddada/fb22a3453e72b2ef73104cf284b206c6 | stars n/a
1. A markdown prompt that writes a ccstatusline config. Fixed per widget: line 1 (context-percentage, context-percentage-usable, session-cost, model) all `brightCyan`; session-id and current-working-dir `brightBlack`. No thresholds.
2. `powerline.theme: "minimal"` (ccstatusline's own powerline theme name, powerline disabled). No custom themes.
3. `colorLevel: 2`, named bright ANSI colours.
4. Foreground only.
5. `defaultSeparator: " | "`, `defaultPadding: ""`, `inheritSeparatorColors:false`.
6. Separators only; same hue within line 1.
7. Not present.
8. Not present.
9. `rawValue:true` strips labels; 4 lines (two empty).
10. ccstatusline JSON; installed through `npx -y ccstatusline@latest`.

## gist fc35ee4a (hamzawaleed0102) Cursor + Claude Code dotfiles
https://gist.github.com/hamzawaleed0102/fc35ee4a34493c0bf3dba1a9a6c3a6f3 | stars n/a
1. Mostly not a statusline: the 135 hex colours are Cursor's `workbench.colorCustomizations` (pure-black theme). The statusline is `claude-statusline.sh:51-71`: folder DIM, branch GREEN (clean) or YELLOW (dirty `*`/`+`), ahead/behind CYAN, `·` DIM, model MAGENTA.
2. No statusline themes (Cursor theme is a separate hex colour map in `cursor-settings.json`).
3. ANSI 16 + dim.
4. Foreground only.
5. Plain ` · ` dim.
6. Hue per segment.
7. Not present.
8. `⎇` branch glyph; no emoji in the statusline (emoji appear in the tab-title hooks).
9. State-driven git colour (clean green, dirty yellow).
10. Edit script; the rest is hooks and Cursor configuration.

## gist fcfc8a34 (nosas) statusline-command.sh
https://gist.github.com/nosas/fcfc8a3484eb50be70e52111918e473b | stars n/a
1. Only the context percentage is coloured (l.40-48): <40 green, <80 yellow, else red (comments: "dumb zone"). Model, branch, sha, commit message, token breakdown uncoloured.
2. No themes.
3. ANSI 16.
4. Foreground only.
5. Plain ` | `.
6. Separators only.
7. Not present.
8. None.
9. Shows branch + sha + truncated commit message.
10. Edit script.

## gist fd2311bd (tylerho5) statusline-command.sh
https://gist.github.com/tylerho5/fd2311bde2fef106839694bf86af1138 | stars n/a
1. Fixed per segment plus thresholds. Model CYAN, effort DIM, token count + `[pct%]` coloured by ctx fill (>=75 red, >=50 yellow, else green; l.~143-150), project MAGENTA, branch YELLOW (dirty `*` red, `↑N` green, `↓N` yellow), worktree `94` bright blue. Cache: >1200 s green, >300 yellow, else red; cold = dim. Rate limits show REMAINING: <=20 red, <=50 yellow, else green (`color_for_remaining`). Per-model overrides for glm/deepseek names and window size.
2. No themes.
3. ANSI 16 (+ `94`, `95` bright).
4. Foreground only.
5. Plain ` | ` and ` · `, uncoloured.
6. Hue per segment, separators plain.
7. Not present.
8. None (ASCII).
9. Three lines.
10. Edit script.

## gist fe2e0153 (neokn) statusline-command.sh
https://gist.github.com/neokn/fe2e0153d92b639fd70e2781efd826ee | stars n/a
1. Mixed. `statusline-command.sh` (the builder part): user green, dir blue, branch yellow, model cyan; `compact:N%`/`ctx:N%` green <50, yellow >=50, red >=80; input-token line magenta `35`, output tokens bright magenta `95` ("different shade of magenta"), account cyan, vim mode magenta, cost yellow. Pace bars: filled up to the pace marker green, past the marker red, empty `90` grey, marker `97` white (`render_pace_bar`).
2. No themes.
3. ANSI 16 + bright.
4. Foreground only.
5. Plain spaces; no separator glyph.
6. Hue per segment.
7. Not present.
8. Emoji heavy (`📖 ⌨️ 📝 ⏲️ 🧠 🏎️💨 💰`), `█░│` bars, prime marks `′ ″` for durations. Fixed-width formatting so the line does not jitter.
9. Pace bar with elapsed-time marker; `🏎️💨` swaps in when over pace. `refreshInterval: 1` documented.
10. Edit script; env `CLAUDE_CODE_AUTO_COMPACT_WINDOW`, `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`, `DISABLE_AUTO_COMPACT` are read for the compact figure.

## gist fef35e44 (jhackz) statusline.sh / statusline.ps1
https://gist.github.com/jhackz/fef35e444dfee4494dce9b19aad9ddc3 | stars n/a
1. Only the context bar is coloured: >=80 red, >=50 yellow, else green (`statusline.sh:30-36`; ps1 `:34-51` same, guarded by `$supportsColor = $null -ne $PSStyle`). Dir, model, cost uncoloured.
2. No themes.
3. ANSI 16. The PowerShell variant tests for `$PSStyle` before emitting colour, which is the only capability test in this batch.
4. Foreground only.
5. Plain ` | `.
6. Separators only.
7. Not present.
8. `▓░` 15-cell bar.
9. None.
10. Edit script; two variants (bash, PowerShell).

## 0xahs/claude-code-vitals
https://github.com/0xahs/claude-code-vitals | stars 0
1. Theme role mapping plus gradient and thresholds (`index.mjs:219-283, 362-409`). Model=`accent` bold, plan label=`yellow`, git branch=`purple`, worktree=`pink`, project=`cyan` with `blue` subdir, version=`dim`, output style=`teal`, agent=`orange`, vim INSERT=`green` else `yellow`. Gauge labels: 5-Hour=`orange`, Weekly=`purple`, Context=`blue`. Percent number by `usageColor`: below `thresholds.warning` (50) green, below `critical` (80) yellow, else red. Metrics: cost=`green`, duration/API=`cyan`, tokens=`teal`, lines=`rose`, `>200K` warning red. Bar fill is a per-cell gradient `gradientColor` (green to yellow at 50% to red) lerped in RGB (l.233-239), not a stepped threshold. Tips take their colour from severity (red/yellow/cyan/blue/green).
2. Five bundled themes in `THEMES` (l.19-71): catppuccin-mocha (default), tokyo-night, dracula, nord, gruvbox-dark. Format = 17 semantic roles as `[R,G,B]`: text, subtext, dim, border, track, surface, overlay, accent, blue, cyan, teal, green, yellow, orange, red, purple, pink, rose. Users can supply their own: `resolveTheme` accepts `cfg.theme` as an object when it has `.text` (l.~107-110).
3. Truecolor only: `fg = \x1b[38;2;r;g;bm` (l.~128). No 256/16 fallback, no depth detection, no NO_COLOR.
4. Foreground only.
5. `│` between identity items in `border` colour, `·` between account items; no powerline.
6. Hue per role (each segment has its own role colour), plain `│`.
7. No light/dark handling; all five themes are dark.
8. Nerd/PUA branch glyph ``, `✓ ● ⚠` git state, bar glyphs `━ ● ─` (slider) or `█▏…` (blocks). No ASCII mode.
9. Gradient slider bar with a `●` position marker; `bar.style` slider or blocks; a tip engine with custom `when` rules (`evaluateCondition`) where level picks the colour.
10. `~/.claude/vitals.config.json` or `$CLAUDE_VITALS_CONFIG`: theme, bar style/width, section/gauge/metric toggles, thresholds, custom tips. `npx claude-code-vitals init|remove`.

## 2dubu/claude-statusline-preset
https://github.com/2dubu/claude-statusline-preset | stars 0
1. A ccstatusline preset (`home/.config/ccstatusline/settings.json`): fixed per widget. Line 1: git-root-dir brightBlue, git-branch brightGreen, context-length brightYellow, git-changes brightCyan. Line 2: model (custom-command `cc-model.js`) brightBlue, "Effort: " label + thinking-effort brightMagenta, session-usage brightWhite, reset-timer brightWhite. No thresholds.
2. No themes; powerline off.
3. `colorLevel: 2`, bright ANSI names.
4. Foreground only.
5. `separator` widgets; `inheritSeparatorColors:false`.
6. Hue per widget, separators.
7. Not present.
8. None; `cc-model.js` only appends ` (1M)` to the model name.
9. `minimalistMode:false`, `continueThemeAcrossLines:false`.
10. ccstatusline JSON + `setup.sh` installer.

## 3dnow/claude-mods (weektoken)
https://github.com/3dnow/claude-mods | stars 0
Not a statusline: a Claude Code mod (plugin hooks, `weektoken/hooks/register.tsx`) that draws a rate-limit pace band above the prompt and a `/weektoken` pane using SVG. Styling notes for reference only: `theme.ts` fixes status colours by pace (`comfortable`, `onPace`, `overPace`, `exhausted`, `early`, `unknown`, each `{start,end,solid}` hex, shared by light and dark); quota identity colours (seven_day blue, five_hour green, weekly_fable violet) have light and dark variants and any other quota hashes into 4 slots (orange, magenta, yellow, red). `color.ts` does sRGB-OKLCH conversion and Material 3 hue harmonization: an over-pace segment is the same hue one shade darker (OKLCH L minus 0.13), exhausted is a warm colour harmonized toward the quota hue. `svg.ts` adapts via `prefers-color-scheme` with translucent grey neutrals. Gradients are angular/linear in the SVG. No terminal ANSI path.

## a692570/gauge
https://github.com/a692570/gauge | stars 0
1. Usage-level colour from a theme (`claude_status.py:96-107, 1763-1769`): `bar_colour(pct, theme)`: >=80 `high`, >=50 `mid`, else `low`. Applies to every bar (session, weekly, opus, sonnet, extra, context). Non-bar text gets a base text colour (`resolve_text_color`, `THEME_TEXT_DEFAULTS`).
2. Ten bundled themes, each `{low, mid, high}` of ANSI codes: default (green/yellow/red), ocean (cyan/blue/magenta), sunset (yellow/orange `38;5;208`/red), mono, neon (bright green/yellow/red), pride (`38;5;135/49/199`), frost, ember, candy, rainbow. User-defined themes: not found in the file (themes are picked by name with `--theme <name>`).
3. ANSI 16 + 256 indexes for themes; truecolor `\033[38;2;…` only for animation modes. No depth detection found; `plain` mode returns bars without ANSI (`make_bar(plain=…)`), no NO_COLOR.
4. Foreground only.
5. Plain separators in text layouts (`standard`, `compact`, `minimal`, `percent-first`).
6. Widget order by priority (`WIDGET_PRIORITY`); hue only by usage level, so neighbours with the same level look alike.
7. `text_color: auto` picks per-theme text (`THEME_TEXT_DEFAULTS`: white, dim for mono, none for rainbow) so bars contrast; no terminal-background detection.
8. Seven bar styles: classic `━─`, block `█░`, shade `▓░`, pipe, dot `●○`, square, star; braille gradient bars; sparkline `▁…█`; emoji widgets.
9. Strong: animation modes `off|rainbow|pulse|glow|shift` (l.628-690); rainbow reuses Claude Code's "ultrathink" 7-colour palette with a shimmer variant (l.474-527), animated only while Claude is processing; speeds 1x etc.; presets; theme demo previews.
10. `config.json` (XDG config dir) edited via CLI flags `--theme`, `--preset`, `--themes`, `--show-colors`, `--themes-demo`, `--show`, plus text_color, bar_size, bar_style, layout, max_width.

## aaltw/claude-code-statusline
https://github.com/aaltw/claude-code-statusline | stars 0
1. Position/alternation plus state (`main.go:26-210`, `segment.go`). Left and right bars are lists of `Segment{BG, Text, SepColor}`. Backgrounds alternate `Surface1` (model, git, ctx), `Surface0` (tokens, cache, 5h, lines) with the next one switching (7d `Surface1`, waste `Surface1`) so neighbours differ by two surface shades; the text colour is a semantic palette role per fact (model Blue, branch Pink, tokens Teal `~`, `+lines` Green / `-lines` Red, counters Green/Yellow). State: ctx bar and percent green <70, yellow <90, else red; cache ratio Sapphire >=50, Yellow >=20, else Red; waste factor Peach <1.5, Yellow <2.5, else Red; 5h colour from projected usage (`windowColor`: red >=100, peach >=90, else green); burn arrow →/↗/↑ green/peach/red; 7d via `budgetColor` against a working-day budget. `COMPACT` badge has `BG: Red` with `Base` text at pct>=85.
2. One palette, `CatppuccinMocha` (`color.go`), struct `Palette` of roles (Base, Surface0/1, Blue, Green + Green80 + GreenDim, Yellow tri-tones, Red tri-tones, Pink, Teal, Peach, Sapphire). Six separator "themes" in `theme.go` all carry that palette; selected by `STATUSLINE_THEME=arrow|round|slant|slantr|flame|plain`. Palette is not user-definable without recompiling.
3. Truecolor only: `\033[38;2;…` / `\033[48;2;…` (`color.go:7-8`). No downsampling, no NO_COLOR.
4. Background-filled cells (every segment has a `BG`), with fg text colours inside.
5. Powerline glyphs from `theme.go`: arrow `/`, round `/`, slant `/`, slantr (inverted), flame `/`, plain ` │`. Colours (`segment.go`): separator fg = the left segment's BG, separator bg = the next segment's BG (swapped for `InvertSep`); trailing edge fg = segment BG over the terminal background; right side mirrors with `SepColor` override (the context bar uses `SepColor: &barFill` so the fill edge is drawn by the separator glyph).
6. Alternating two surface shades plus separator glyph; segment text carries the hue.
7. Not present: palette is dark (Catppuccin Mocha); text roles are hand-picked.
8. Nerd Font required (README); Nerd glyphs `󰧑 󰅐 󰃭 󰆼` and powerline PUA glyphs. No ASCII fallback except `plain` theme.
9. Context bar drawn with the separator glyph as the fill boundary (`filled/10` cells of `█`, a separator glyph, then `▒`), the fill/empty tones use Green80/GreenDim style variants. Burn-rate colour from a persisted sample history.
10. Env vars: `STATUSLINE_THEME`, `STATUSLINE_TOKEN_COUNTERS=1`, `STATUSLINE_CACHE_EFFICIENCY=1`, `STATUSLINE_HIDE_USAGE=1`. No config file (Go binary).

## AbdulrahmanMasoud/claude-bar
https://github.com/AbdulrahmanMasoud/claude-bar | stars 0
1. Depends on the chosen theme file (`lib/themes/*.sh`; one function per section: dir, git, tokens, context, time, model, today, month). `powerline.sh`: fixed per section background: dir BLUE, git GREEN, tokens YELLOW, model MAGENTA bold, today CYAN, month RED, time/memory GRAY; context is state-coloured: GREEN, YELLOW >50, RED >80 (l.~44-56). `nerd.sh`: model CYAN, +adds GREEN / -dels RED, context bar GREEN only (no threshold); `emoji.sh`: GREEN bar, CYAN model; `minimal`, `compact`, `ascii`: DIM separators, GREEN/RED diffs, CYAN model.
2. Six bundled themes: powerline, nerd, emoji, minimal, compact, ascii. A theme is a bash file defining `theme_init`, `theme_separator` and one `theme_<section>` function per section. User themes go in `~/.claude/themes/<name>.sh` (loaded first, `statusline.sh:30-45`). A theme here is layout + glyphs + colour together, not a palette.
3. ANSI 16 backgrounds `\033[4Xm` / `\033[100m` and foregrounds; no 256/truecolor, no detection, no NO_COLOR.
4. Powerline theme: background-filled cells (white bold or black text); others foreground-only.
5. Powerline: U+E0B0 after each section, arrow fg = that section's colour on the terminal background (no next-bg blend: `${FG_BLUE}${PL_SEP}${RESET}`), so it is a coloured arrow tip after each pill. Others: `│` DIM (nerd/minimal), ` ~ ` (minimal), `|` DIM (compact/ascii).
6. Distinct background hue per section in powerline; dim separators elsewhere.
7. Text is hand-chosen per background: black on green/yellow/cyan, white on blue/magenta/red/gray (powerline.sh). No auto contrast.
8. Nerd Font icons (nerd.sh), emoji (emoji.sh), pure ASCII (ascii.sh), powerline. Selected by theme.
9. Section order is configurable (`SECTION_ORDER="dir,git,session,context,time,model,today,month"`).
10. `~/.claude/claude-bar.conf` (sourced shell: `THEME`, `SECTION_*`, `SECTION_ORDER`), `claude-bar` CLI to install/switch.

## abdulwasea89/traj-claude
https://github.com/abdulwasea89/traj-claude | stars 0
1. Statusline (`statusline/statusline-command.py:42-52, 118-135, 453-481`): context bar and its fill coloured by `color_for(pct)`: >=90 RED, >=75 ORANGE `38;5;208`, >=50 YELLOW, else GREEN, empty cells DIM. Fixed per segment: model bold WHITE, project DIM, `ctx N/limit` CYAN, `↑ in` BLUE, `↓ out` MAGENTA, cost MAGENTA, message count DIM.
2. Statusline: no themes. The companion web dashboard (`dashboard/`) has six palettes: midnight (default), light, dark, solarized, oled, paper (README "Six palettes"), each with a paired accent, hairlines derived as foreground at 10% and 5%, and a per-source colour setting rendered at lifted lightness (x1.38 L, x1.12 C) on dark stocks. Text contrast is held to AA (4.5:1) on light, dark, midnight and oled; solarized and paper are documented exceptions.
3. Statusline: ANSI 16 + one 256 index (208). No detection; ~hex values are in the dashboard CSS.
4. Statusline foreground only.
5. Plain separators (spaces/`│`).
6. Hue per segment.
7. Dashboard: light/dark palettes, contrast measured against AA. Statusline: not present.
8. Statusline: `█░` bar, `↑ ↓`; no emoji.
9. Dashboard Settings page with palette, accent and hairline-strength controls; source colour editor.
10. Statusline tunables are env vars `CLAUDE_CONTEXT_LIMIT`, `CLAUDE_BAR_WIDTH`, `CLAUDE_SHOW_PROJECT`, `CLAUDE_EXACT`, `CLAUDE_COST_*`. Dashboard config in `dashboard/trajectory.config.json`.

## abrose/claude-plugins
https://github.com/abrose/claude-plugins | stars 0
Not a statusline: a plugin marketplace. The `quota-statusline` plugin ships `bin/quota-statusline`, which prints a per-window JSON verdict (on pace or not) and explicitly leaves rendering to the user ("bring your own rendering"); it contains no ANSI or colour code. The other plugins are an output style, `chebu-ui` (a mod restyling transcript rows with Ink `<Text color="gray">` such as `turn-separator.tsx:38,40`), and `team`.

## ACaiA-77/pi-ccstatusline
https://github.com/ACaiA-77/pi-ccstatusline | stars 0
Not a Claude statusline: an extension for the Pi coding agent that runs the real ccstatusline renderer and shows its output in Pi's footer (`index.ts:341` `ctx.ui.setFooter`, truncation uses `theme.fg("dim","...")`). Colours, separators, powerline and layout all stay in ccstatusline's `~/.config/ccstatusline/settings.json`; `examples/ccstatusline.json` is a one-line example: model cyan, effort magenta, context-percentage green, cost yellow, cwd blue, separators between. Env: `PI_CCSTATUSLINE=off`, `PI_CCSTATUSLINE_COMMAND`, `PI_CCSTATUSLINE_REFRESH_MS`.

## adam-yl/liltoken
https://github.com/adam-yl/liltoken | stars 0
Not a Claude statusline: a macOS menu-bar app (Swift) that pops up Claude and Codex allowance. `scripts/statusline-config.py` only prints a `statusLine` command block that feeds the app (no ANSI). For reference, its own look is in `Sources/Theme.swift`: light-gray glass (`233,233,233`), purple accent (`138,101,196`), dark purple action text, light-purple primary button, 21 px radius, with a Reduce Transparency fallback.

## adaminspaceship/claude-code-explainer
https://github.com/adaminspaceship/claude-code-explainer | stars 0
1. One statusline row (`explainer.py:55-61, 282-358`): a TWITTER_BLUE `●` (`38;5;39`), topic in BOLD, `·  N posts  ·` DIM, then an OSC 8 `open ↗` hyperlink. Fixed colours, no thresholds.
2. No themes. (The generated browser feed is a separate light HTML page, `color-scheme: light`, `#0f1419` text.)
3. ANSI 16 + one 256 index; also `ITALIC`, `GREY 90`. No detection.
4. Foreground only.
5. Plain double-space and `·`, DIM.
6. Not applicable (single segment).
7. The HTML feed fixes `color-scheme: light`; statusline has no adaptation.
8. `●`, `↗`, OSC 8 clickable link (Cmd-click in iTerm, Terminal, Ghostty, WezTerm).
9. Statusline shows nothing styled beyond the link; the tweet UI lives in a per-session HTML file.
10. Edit the script; needs an xAI API key (`GROK` fetch). Not a general-purpose statusline: it shows tweets about the current topic.

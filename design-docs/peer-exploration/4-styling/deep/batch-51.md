## korakod-dev/claude-code-statusline
URL: https://github.com/korakod-dev/claude-code-statusline — stars: 0 (single bash script `statusline.sh`, 182 lines; demo/ scripts only render screenshots)
1. Colour source: mixed fixed + threshold + gradient-along-bar. Fixed (`statusline.sh:166-172`): dir icon 256-colour 45, dir text 81, git branch 176, model 141, effort 240, labels `CTX/5H/7D` 245, separator `▕` 238. Threshold (`:85-91` `pct()`): <60 -> 84 (green), <85 -> 220 (amber), else 203 (red), bold. Gradient along the bar (`:68` `RAMP=(48 84 120 156 191 220 214 208 202 196)`, `:77` cell i takes `RAMP[i*10/n]`): the filled cells go cool->hot by cell position, regardless of the percentage; unfilled cells are 240 `░`. Reset-countdown colour (`:113-122` `waitcol`): 245 under 60%, 220 under 85%, 203 above, but forced to 48 (green) when the window is in its last tenth.
2. Themes: not present. No theme file, no flags.
3. Colour spec/depth: 256-colour index only (`c() { printf '\033[38;5;%sm' }`, `:64`). No depth detection, no downsampling, no NO_COLOR.
4. Fill: foreground only, no backgrounds.
5. Separators: plain `▕` glyph in colour 238 surrounded by spaces (`:65`, `join()` `:144-151`). Colour fixed.
6. Neighbours: different fixed hues per segment (cyan dir, pink branch, violet model) plus the `▕` separator.
7. Light/dark: not present. 245/240/238 greys assume a dark background. The extractor's `lightdark` hit is in the demo screenshot tooling, not the statusline.
8. Glyphs: Unicode only (`◈ ⑂ ▓ ░ ⟲ ▕`), no Nerd Font, no ASCII mode.
9. Other: 3-line layout (identity line, then one gauge line per rate-limit window); a `~` marker for a cached (unconfirmed) reading; `waitcol` makes the countdown quiet at low use and loud when the quota runs out.
10. Customisation: none at runtime; edit the script. `install.sh` writes the settings.json entry.

## kreddevils18/claude-usage-mod
URL: https://github.com/kreddevils18/claude-usage-mod — stars: 0
not a Claude statusline: a Claude Code "mod" (plugin) that draws a band of coloured chips above the prompt plus a details pane. Useful styling fact: fixed per-metric tint, `hooks/theme.ts:8-19` `TONES` gives each metric (five, seven, model, extra, context, up, down, cache, session, today) a pastel `bg`, a dark `ink` and a saturated `accent` (e.g. five `#dcebe0/#25402f/#3f8f5b`, seven `#e4defa/#35286a/#7357d4`), chosen so a chip reads the same on light and dark themes (comment at `:2`); the bar and dot take a separate severity colour (`:22` `BAR_COLOR` ok `#4f9d69`, warn `#d9a21b`, crit `#d9534f`) so "green/yellow/red keep one meaning". Truecolor hex only, chips are background-filled with no separators.

## krishna-goutham-tls/cc-mods
URL: https://github.com/krishna-goutham-tls/cc-mods — stars: 0. Repo has three Claude Code mods (folio file pane, reply quoting, tint restyle); only `tint/statusline/statusline.sh` (111 lines) is a statusline, the rest are not statuslines (folio pane colours are Claude theme keys, `folio/hooks/theme.ts:3-19`: text, suggestion, professionalBlue, inactive, subtle, userMessageBackground, claude, success).
1. Colour source: by theme role plus a few thresholds. Model name is the accent (`statusline.sh:87`); folder uses default fg; branch and effort and `% of 5h` use bright-black `\033[90m` (dim, `:71,89,95`); context % is green `\033[32m` normally and yellow `\033[33m` at >=80 (`:92`); 5h usage goes yellow when >=80% and more than 30 min remain, otherwise dim (`:107`).
2. Themes: two "looks", `warm` and `grok`, chosen from `$CLAUDE_CONFIG_DIR/tint/active` and overridden by whichever `tint-warm`/`tint-grok` Claude Code `/theme` entry is selected (`:58-66`). Each look has dark+light variants (`tint/hooks/palette.ts:5-14`, userFg/replyBg only for message blocks). The accent: warm = truecolor orange `38;2;217;119;87` on dark macOS, `38;2;193;95;60` on light/unknown; grok = ANSI blue `\033[34m` (`:73-79`). Users cannot define their own beyond editing theme files.
3. Colour spec/depth: ANSI 16 (`32,33,34,90`) for everything except the warm accent, which is truecolor. Comment `:68-70`: ANSI colours come from the terminal palette so they follow its dark/light. No downsampling, no NO_COLOR.
4. Fill: foreground only.
5. Separators: plain ` │ ` in faint grey (`\033[2;90m`, `:72`).
6. Neighbours: separators only; text colour roles (accent / default / dim).
7. Light/dark: yes. On macOS runs `defaults read -g AppleInterfaceStyle` to choose the orange variant (`:75`); relies on ANSI palette for everything else.
8. Glyphs: Nerd Font folder U+F07B and branch U+E0A0 (`:82`), `✻` model mark. No fallback.
9. Other: the `tint` mod also rewrites a Claude Code custom theme file (`themes/tint.json`, name "Tint (auto)") so the bar and the transcript agree.
10. Customisation: files only (`tint/active` containing `warm` or `grok`, Claude `/theme`).

## krmlizm/claude-code-contextpercentage
URL: https://github.com/krmlizm/claude-code-contextpercentage — stars: 0
1. Colour source: threshold on context remaining only (`statusline.sh:29-35`): <10% left red `\033[31m`, <20% yellow `\033[33m`, else green `\033[32m`. Whole output ("`NNk left (P%)`") is one colour.
2. Themes: not present.
3. Colour spec/depth: ANSI 16 named, no detection, no NO_COLOR.
4. Fill: foreground only.
5. Separators: not present (single segment).
6. Neighbours: not applicable.
7. Light/dark: not present (ANSI palette inherited from terminal).
8. Glyphs: none.
9. Other: computes usage from transcript with a hard-coded 200k budget (`:24`).
10. Customisation: edit script.

## kuan0808/cliproxy-kit
URL: https://github.com/kuan0808/cliproxy-kit — stars: 0
not a Claude statusline: a CLIProxyAPI plugin (Go) + web panel plus a Claude Code mod ("quota-band", `mod/hooks/terminal.tsx`) drawing a quota band above the prompt. Styling facts from `mod/hooks/logic.ts:20-62`: two palettes with identical role names (`C` = fixed gruvbox-like hex: fg `#ebdbb2`, dim `#928374`, red `#fb4934`, orange `#fe8019`, yellow `#fabd2f`, green `#b8bb26`, aqua `#8ec07c`, accent `#d97757`; and `DESK` mapping the same roles to Claude desktop theme keys `text/inactive/error/warning/success/permission/claude`), so a role is mapped per surface. Severity `sevIn` (`:60`): remaining <10 red, <25 orange, <50 yellow, else green. Fills only on tiles/notices (`tile`, `warnBg`, `infoBg`, `askBg`).

## kuangketongxue/cc-tool
URL: https://github.com/kuangketongxue/cc-tool — stars: 0 (`statusline-command.sh`, 46 lines of bash wrapping inline node; chime/notify scripts are unrelated)
1. Colour source: threshold on context % only (`:32-35`): >=85 red `\x1b[31m`, >=60 yellow `\x1b[33m`, else green `\x1b[32m`. The model short name is uncoloured; the colour wraps only the `[████░░░░]` bar (`:45`), the percentage label after it is uncoloured.
2. Themes: not present.
3. Colour spec/depth: ANSI 16, no detection, no NO_COLOR.
4. Fill: foreground only.
5. Separators: single space; bracketed bar.
6. Neighbours: not applicable (two items).
7. Light/dark: not present.
8. Glyphs: `█` / `░`, 20 cells.
9. Other: side effect writes `~/.claude/context.json` for a popup; hard-codes window sizes by model family (opus/sonnet 1M, haiku 200k, `:8-12`) and prints "Nx compressed" past 100%.
10. Customisation: edit script.

## kumamaki/statusmaxxx
URL: https://github.com/kumamaki/statusmaxxx — stars: 0 (Rust, ratatui configurator; serves Claude Code plus Amp, opencode, pi hosts)
1. Colour source: theme role mapped per segment, plus one threshold. `src/theme.rs:5-18` defines 12 roles: Path, Worktree, Branch, Dirty, Clean, Issue, Model, Context, ContextHigh, Cost, Muted, Error. `src/segment.rs` assigns them fixed per segment: directory->Path (`:281`), worktree->Worktree (`:340`), branch->Branch (`:353`), changes `✓`->Clean / `±N`->Dirty (`:358-359`), issue->Issue (`:387`), model->Model (`:304`), cost->Cost (`:315`), context->Context, switching to ContextHigh at >=80% (`:309`), separators and the `:`/`(state)` text->Muted, failures->Error.
2. Themes: 7 bundled (`theme.rs:41`): Terminal (default), Short Giraffe, Catppuccin, Dracula, Nord, Gruvbox, Light. Format is a code `match` of role->colour (not a user file). Users can pick one in config/TUI but cannot define their own theme.
3. Colour spec/depth: `Color::Palette(u8)` (16 ANSI, emitted as `3x`/`9x` codes) or `Color::Rgb` truecolor (`theme.rs:20-25,78-85`). The `Terminal` theme uses only palette indexes so the user's terminal theme applies; the others are truecolor with no downsampling. No NO_COLOR found in the files read.
4. Fill: foreground only (`paint` emits `\x1b[<fg>m text \x1b[0m`).
5. Separators: plain text from a presets list (`src/separator.rs:5`): space, ` · ` (default), ` │ `, ` | `, ` › `, ` / `, or any custom string; painted with the Muted role (`render.rs:70`).
6. Neighbours: different hue per role + separator.
7. Light/dark: a `Light` theme with darker truecolor values (`theme.rs:176-189`); no auto-detect, no contrast computation.
8. Glyphs: three icon fonts (`segment.rs:134-152`): Nerd Fonts (default), Unicode, None; icons toggled per segment; per-model-family Nerd glyphs (`MODEL_ICONS`, `:410`).
9. Other: OSC-8 hyperlinks on issues; errors appear as red `✗ name` in line; `docs/tui-*.png` screenshots of the TUI.
10. Customisation: TOML config (`config.rs`: segments list, theme, icons set, icon_font, separator, per-host segment overrides) edited through a ratatui TUI.

## kurok/busybar-cclimits
URL: https://github.com/kurok/busybar-cclimits — stars: 0
not a Claude statusline: pushes Claude usage limits to a BUSY Bar hardware display over HTTP. Styling: config `Colors` (`src/busybar_cclimits/config.py:174-181`) label `#D97757`, track `#333333`, ok `#00C853`, warn `#FFC800`, critical `#FF2A00`, text `#FFFFFF`, idle `#5A5A5A`; bar fill chosen by usage (green, yellow from 75%, red from 90% per README; `render.py:113-119`).

## kwag93/cc-dash
URL: https://github.com/kwag93/cc-dash — stars: 0 (TypeScript, `src/`)
1. Colour source: role/threshold, not per-segment hue. Widgets call the theme: model `theme.accent("[name]")` (`widgets/model.ts:8`), cwd `accentBold` on basename and `accent` on parent (`widgets/cwd.ts`), git modified/untracked counts `theme.dim` (`widgets/git.ts:57-58`, branch has no theme call), cost `theme.dim` (`cost.ts:14`), context and 5h/7d use `theme.color(text, level)` with `levelFromPercentage` (`colors.ts:22-26`: >=80 critical, >=50 warn, else ok), with countdowns `dim`. So accent = identity (model, cwd), severity = quotas, dim = secondary.
2. Themes: 5 (`config.ts:13`): `minimal` (default) and truecolor palettes `catppuccin`, `nord`, `tokyonight`, `gruvbox` (`themes/palettes.ts:12-17`). Format: a semantic palette of 5 roles `{ok, warn, critical, accent, dim}`, one hex each. No user-defined themes (validated against a fixed `Set`).
3. Colour spec/depth: `minimal` = ANSI 16 for severity (`\x1b[32m/33m/31m`) and 256-colour accent (`38;5;31`, bold `1;38;5;39`, `minimal.ts:4-5`); palette themes truecolor `38;2;r;g;b`. No downsampling, no NO_COLOR.
4. Fill: foreground only.
5. Separators: 3 options (`separators.ts`): dot ` · ` (default), pipe ` │ `, space. Uncoloured.
6. Neighbours: separators only; most segments are dim/accent.
7. Light/dark: not present.
8. Glyphs: `▰▱` bars (`colors.ts:46-50`), no Nerd Font.
9. Other: narrow-terminal (<100 cols) compact layout (`renderer.ts:11,20`).
10. Customisation: `~/.claude/cc-dash.json` with `layout` (normal|compact), `theme`, `separator`, `showCost`.

## kyungkoo/claude-statusline
URL: https://github.com/kyungkoo/claude-statusline — stars: 0 (`statusline-command.sh`, 139 lines POSIX sh + awk)
1. Colour source: state/threshold. Git branch: red `\033[31m` if the tree is dirty, green `\033[32m` if clean (`:19-23`). Context bar and the 5h/7d mini bars: >=80 red, >=50 yellow, otherwise uncoloured (`:52-54,94-96`). Everything else (cwd, model, cost) is uncoloured.
2. Themes: not present.
3. Colour spec/depth: ANSI 16; no detection, no NO_COLOR.
4. Fill: foreground only.
5. Separators: ` | ` plain text.
6. Neighbours: separators and emoji prefixes (`📁`, `🤖`, `⑆`).
7. Light/dark: not present.
8. Glyphs: emoji (`🤖 📁`), `█░` bars; no Nerd Font.
9. Other: dumps raw payload to `/tmp/statusline-debug.json`.
10. Customisation: edit script.

## l0ng-ai/claude-statusline
URL: https://github.com/l0ng-ai/claude-statusline — stars: 0. The shipped tool is Zig (`statusline.zig`); `bench/statusline.py` is a Python benchmark control implementing the default layout only.
1. Colour source: semantic palette slots with fixed assignment per segment plus severity. 8 slots (`statusline.zig:35-43`): ink, dir, dim, slot, green, amber, red, blue. Assignments: model/effort/think/style `blue` (`:421,431,511,516`), dir `dir` (`:492`), branch `green` (or dim "(no git)", `:499`), `+N` green / `-N` red (`:506-508`), cache and the 5h/7d labels and reset `⏰` countdown `green` (`:364,372,462`), cost, duration, ctx size, `v<ver>` dim, separators dim. Bars: level colour by value (`:256-258` `level()`: <60 green, <85 amber, else red).
2. Themes: 12 bundled (`:73-85`): light (default), dark, gruvbox, gruvbox-light, nord, mocha, latte, tokyo-night, dracula, rose-pine, solarized, solarized-light. Format: one `theme(...)` row of 8 hex values per theme ("Adding a theme is one row", `:61`). `--theme NAME`; `--list` prints them. No user-defined theme file (adding means editing source).
3. Colour spec/depth: truecolor only (`38;2`/`48;2`, `fg()` `:235`). No downsampling, no NO_COLOR.
4. Fill: both. Default `block` bar paints the cell background (green/amber/red for filled cells, `slot` for the track) with the percentage text written into the bar; `ink` is the theme background colour so digits stay legible on a coloured fill (comment `:28-34`). Other bar shapes `hairline` (`━ ─`) and `dots` (`● ·`) are foreground-only (`bar_styles` `:102-106`, `paint=false`).
5. Separators: plain text; `dim` colour.
6. Neighbours: different semantic colours (blue/green/dir/dim) and dim separators.
7. Light/dark: yes, by explicit theme choice: `light` and `dark` are deliberately desaturated (comment `:64-65`: standard ANSI greens/blues glare on white). Text-on-fill contrast handled by the `ink = theme background` rule. No auto-detect.
8. Glyphs: `⏰`, `⤷`, bar shapes; Unicode only.
9. Other: usage projection `→NN%` (percent extrapolated to reset time); built for speed (Zig vs Python benchmark in `bench/`); configurable layout string (`default_layout` `:117`, rows separated by ` / `).
10. Customisation: CLI flags `--theme`, `--bar` (block|hairline|dots), `--bar-width 4..40`, layout string, `--list` (`:135-179`); env. No config file read in the files checked.

## lamosty/claude-code-statusline
URL: https://github.com/lamosty/claude-code-statusline — stars: 0 (`statusline.sh`, 52 lines)
1. Colour source: threshold on context % only (`:39-45`): >80 red, >60 yellow, else green, applied to the `NN.Nk` token count; "new" in dim when no usage. Model, `Ctx:` label and branch are default fg.
2. Themes: not present.
3. Colour spec/depth: ANSI 16, no detection, no NO_COLOR.
4. Fill: foreground only.
5. Separators: ` | ` plain.
6. Neighbours: separators only.
7. Light/dark: not present.
8. Glyphs: `⌀` before the branch.
9. Other: jq optional with grep/sed fallback.
10. Customisation: edit script.

## laveez/ccsl
URL: https://github.com/laveez/ccsl — stars: 0 (TypeScript, npm `ccsl`, zero deps)
1. Colour source: background-filled badges, colour from a mix of fixed-per-badge and value-driven gradients. Fixed (`src/render.ts`, palette `BADGE` at `src/types.ts:202-213`): model blue, repo green, worktree cyan, running tool cyan, context/cache cyan, agent purple, `EFFORT_COLORS` (`render.ts:116`) low steel, medium blue, high gold, xhigh orange, max rose, tool categories (`:264-271`: Read/Write/Edit green, Grep/Glob purple, Bash orange, Task/Skill blue, Todo gold, Web cyan). Value-driven via `gradientColor` stops (`utils.ts:295`): duration green->gold(60 min)->purple(180) (`render.ts:134`), cost green->gold($10)->orange($50)->rose($100) (`:140`), prompt-cache time left orange->gold->green (`:176`), spend limit green->orange->rose (`:188`); context bar fill `[50,110,50]` / `[140,120,40]` at 70% / `[140,60,60]` at 85% on `[45,48,55]` track (`:79-83`); rate-limit bars coloured by pace against the clock (README), PR badge colour by review state. Main/master branch in purple.
2. Themes: not present as a feature (one dark-tuned palette). Layout presets (dense, semantic, adaptive) are row arrangements, not colour themes.
3. Colour spec/depth: truecolor `48;2`/`38;2` only (`utils.ts:13-27`). No depth detection, no NO_COLOR.
4. Fill: background-filled badges with white text (`colorSegment` -> `\x1b[48;2..m\x1b[97m text`, `utils.ts:82-92`); one `fgBlack` helper exists. Dark backgrounds (e.g. blue `38,60,100`) chosen so white text always passes.
5. Separators: `badgeStyle` (`types.ts:218`): `flat` (just a space between badges, default), `powerline` (U+E0B0), `rounded` (U+E0B4), or any custom string (`utils.ts:34-39`). Powerline join (`:223-265`) colours the arrow fg=previous badge background (extracted by regex from the ANSI), bg=next badge background, and a trailing arrow on fg=last bg over the default bg. Config-file only (not in wizard).
6. Neighbours: different hues per badge kind; adjacent badges are mostly different hues but value gradients can land similar. Powerline arrows join them.
7. Light/dark: not present; white text on dark fills only; no detection. Output is prefixed with a reset and uses non-breaking spaces so Claude Code does not dim/trim.
8. Glyphs: heavy emoji (`🧠 🔥 💾 💸 ⏲ 🌿 🌳 🔗 📝 💭 🤖`); powerline glyphs only in powerline style.
9. Other: pace-aware rate-limit bars with a white tick for elapsed window; gradient backgrounds that shift with value; interactive `ccsl setup` wizard with live preview (`src/wizard/*`); demo gif and `docs/badge-reference.png`.
10. Customisation: `~/.claude/statusline-config.json` (`rows` array of badge-group ids, `flexMode`, `compactThreshold`, `flexPadding`, `badgeSpacing`, `badgeStyle`); `ccsl setup` TUI wizard; `COLUMNS` for width.

## lazearth/claude-code-usage-bar
URL: https://github.com/lazearth/claude-code-usage-bar — stars: 0. FORK OF leeguooooo/claude-code-usage-bar.
Differs from parent: nothing. GitHub compare `leeguooooo...lazearth:main` returns status `behind`, ahead_by 0, behind_by 291, so the fork adds no commits and is an older snapshot of the parent. For orientation, the snapshot's styling (read in `src/claude_statusbar/themes.py`, `styles.py`): 9 bundled truecolor themes (graphite, twilight, linen, nord, dracula, sakura, mono, catppuccin-mocha, tokyo-night), each a frozen dataclass of semantic RGB roles `ink, mute, edge, s_ok, s_warn, s_hot` plus one capsule fill per metric (`pill_5h, pill_7d, pill_model, pill_lang, pill_cost`) and `pill_ink` text-on-pill (`themes.py:13-35`); 3 styles (`classic`, `capsule`, `hairline`, `styles.py:250-254`) — capsule draws background-filled pills joined by ` ╱ ` with a severity dot `●` (`:70-123`); `linen` and `sakura` are light-terminal themes; hex overrides for `s_ok/s_warn/s_hot` only (`apply_color_overrides`, `themes.py:174-188`, config keys `color_ok/warn/hot`); NO_COLOR (any value) and `--no-color` strip all colour (`cli.py:186-189`).

## lbb00/a-hud
URL: https://github.com/lbb00/a-hud — stars: 0 (multi-agent HUD: Claude Code, Codex, Cursor, pi; TypeScript `plugins/agent-hud/src/`)
1. Colour source: state only, by design. Header comment `render.ts:19-22`: "Hue is reserved for warning severity plus the single opportunity signal (green, an open promotional window); brightness, not decorative color, separates session state from location" (and `design.ts:4-7`: "color encodes warning level, with one deliberate exception"). Palette (`render.ts:23-29`): dim `\e[2m`, bright `\e[97m`, green, yellow, red. Model, effort, context, token pressure, quota, turns each take a `yellow|red|plain` tone computed from `HUD_DESIGN.warning` thresholds (`design.ts`); running tools `◐` yellow, error `!` red, `│` separators dim.
2. Themes: not present (deliberately minimal).
3. Colour spec/depth: ANSI 16 + dim/bright-white. Honours NO_COLOR: `colors = options.colors ?? !process.env.NO_COLOR` (`render.ts:297`), and every `paint()` returns bare text when colours are off (`:37-39`).
4. Fill: foreground only.
5. Separators: ` | ` between line-1 items (dim), `│` between tool/agent groups.
6. Neighbours: separators and brightness; no hue differences by design.
7. Light/dark: not present beyond relying on dim/bright; `dimLine` re-applies dim after nested resets.
8. Glyphs: `◐ ✓ ! ? ▸ │`; emoji in a few spots; no Nerd Font.
9. Other: control-character stripping of untrusted strings (`render.ts:51`); width-aware truncation.
10. Customisation: CLI/setup (`cli.ts`, `setup.ts`), no colour config.

## leafylion/claude-statusline-pretty
URL: https://github.com/leafylion/claude-statusline-pretty — stars: 0
1. Colour source: fixed role per segment with a context threshold. 13 theme keys (`examples/themes/README.md`): model, session, dir, branch, effort, ctx_ok/ctx_wn/ctx_er, cache, duration, cost, total, sep. Context %: <50 `ctx_ok`, 50-79 `ctx_wn`, 80-100 `ctx_er` (`scripts/statusline.sh:168-174` plus README comments). Everything else a fixed colour per field (`:38-96`).
2. Themes: 4 bundled in the script (`statusline.sh:30-50`: `current`, `cool-pastel` (default), `earthy`, `neutral`) plus `custom` read from `~/.claude/statusline-theme.json` (all 13 keys required, else silent fallback to cool-pastel, `:51-65`). Format: per-segment colour map of 256-colour numbers (e.g. cool-pastel model 183, dir 81, branch 121, ctx_ok 152 / wn 215 / er 174). Example theme files under `examples/themes/`.
3. Colour spec/depth: 256-colour index only (`fg() { ESC[38;5;Nm }`, `:13`). No depth detection, no NO_COLOR.
4. Fill: foreground only.
5. Separators: plain glyph in `sep` colour (238): STYLE picker `minimal` `·` / `sharp` `│` / `soft` `•` (`:68-73`), which also switches the dir glyph (`›`/`❯`/`»`) and branch glyph (`⎇`/`⊢`/`↳`).
6. Neighbours: different fixed colours per field plus a dim separator.
7. Light/dark: not present (themes assume a dark terminal; neutral is greyscale).
8. Glyphs: Unicode symbol sets only, no Nerd Font/emoji.
9. Other: PowerShell twin (`scripts/statusline.ps1`) and `bin/install.ps1` for Windows; per-model cost breakdown and monthly total shown in coloured fields.
10. Customisation: edit the `THEME=` and `STYLE=` lines in the script, or installer flag `--theme custom` / `-Theme custom`; custom JSON file as above.

## Leehyunbin0131/stone-warm-theme
URL: https://github.com/Leehyunbin0131/stone-warm-theme — stars: 0 (repo's README titles it `claude-statusline`; `awesome-statusline.sh` plus `terminal-profile.sh`, which creates a "Stone Warm" GNOME Terminal profile)
1. Colour source: one colour for everything: the gauge is a single `ACCENT` for filled cells and `TRACK` for unfilled (`awesome-statusline.sh:99-113`); no severity colouring. Text: model bold `FG`, labels and notes `DIM`, percentages bold `FG`.
2. Themes: not present as a switch; one palette tuned for a light "Warm Stone" terminal (bg `#F4F2EF`), with dark-terminal values in trailing comments (`:94-97`: FG `42;38;33` / dark `255;255;255`, DIM `138;133;125`, TRACK `216;211;201` / dark `69;69;69`, ACCENT teal `44;122;130` / dark `148;226;213`). Swapping is manual.
3. Colour spec/depth: truecolor `38;2` only. No detection, no NO_COLOR.
4. Fill: foreground only (bar is `━` in two colours).
5. Separators: `   │   ` plain dim text between line-2 metrics.
6. Neighbours: not distinguished by colour; label dim, value bold.
7. Light/dark: explicitly light-first (comment `:86-89`: accent dropped to a teal "that actually reads on paper"), dark values documented but not auto-selected. The companion `terminal-profile.sh` sets the terminal colours to match.
8. Glyphs: `━`, no emoji (header: "no emoji").
9. Other: self-installer `--install` (copies script, backs up and edits settings.json, smoke test).
10. Customisation: edit the four colour constants.

## leewest0/claude-code-statusline
URL: https://github.com/leewest0/claude-code-statusline — stars: 0 (`statusline.sh`, 324 lines)
1. Colour source: gradient along the bar plus thresholds. Context bar: each filled cell takes `gradient_color(position%)` — green (0,200,83) -> yellow (255,214,0) at 50 -> red (255,23,68) at 100 (`:32-56,58-80`), so colour depends on the cell's position, not the value; empty cells dim `░`. Cost: dim at 0.00, 256-colour 220 (yellow) otherwise, 196 (red) at >=$10 (`:218-226`). `+N` green 46 / `-N` red 196 (`:246`). 5h/7d `%`: red 196 when >80, else dim (`:270-285`). Brand diamond `◆` fixed violet (truecolor 114,102,234 or 256-colour 99, `:186-192`). Model name, branch uncoloured.
2. Themes: not present (README only mentions a `github` look in generated previews).
3. Colour spec/depth: detects truecolor via `COLORTERM` = truecolor|24bit (`:20-23`) and uses RGB, else falls back to three 256-colour steps (46 / 220 / 196 at <50, <80, else). `CLAUDE_STATUSLINE_ASCII=1` removes all colour and unicode. No NO_COLOR.
4. Fill: foreground only (bar blocks are fg-coloured `█`).
5. Separators: dim ` | ` by default; with `CLAUDE_STATUSLINE_POWERLINE=1` or `NERDFONT=1` a Nerd/powerline glyph in colour 240 (`sep()` `:143-151`). Colour fixed, not derived from neighbours.
6. Neighbours: separators only.
7. Light/dark: not present.
8. Glyphs: three modes via env: Unicode (default `◆ ⎇ ⚙ █░`), Nerd Font (`CLAUDE_STATUSLINE_NERDFONT=1`, icons for git and dollar), ASCII (`=`/`-`, `git:`, `*`).
9. Other: git branch+dirty cached 5 s in `/tmp`; `scripts/generate-previews.py` renders preview PNGs with rich.
10. Customisation: env vars `CLAUDE_STATUSLINE_ASCII`, `_NERDFONT`, `_POWERLINE`, `COLORTERM`; no config file.

## lemonyangzw/ccometixline
URL: https://github.com/LemonYangZW/CCometixLine — stars: 0. FORK OF Haleclipse/CCometixLine.
Differs from parent (GitHub compare: 7 commits ahead, 86 behind): adds a `Sub2Api` segment (usage tracking against a sub2api proxy) and shared `usage_common.rs`. Styling that differs: (a) a heat-gradient progress bar, `src/core/segments/usage_common.rs:33-52` `heat_color(t)` interpolates 6 truecolor stops teal(0,200,180) -> green -> lime -> yellow(255,220,40) -> orange(255,140,0) -> red(240,60,50) per bar cell, sub-block precision (`generate_bar` `:54-101`), foreground-coloured `█`, unfilled `░` dim, `bar_colored` option, plain `▕██░░▏` otherwise; (b) every bundled theme file gains a `sub2api_segment()` with its own per-segment RGB `icon/text/background` triple (Nord: text `46,52,64` on background `235,203,139`, `theme_nord.rs` diff), disabled by default, icon `🔗` / Nerd U+F0219; (c) segments may be "block" segments rendered on their own line(s) below the inline powerline row (`core/statusline.rs` diff: `block_display` metadata or newline in output), and empty-icon segments skip the icon column; (d) `backfill_missing_segments()` adds new segments to old theme files; (e) an options editor TUI (`ui/components/options_editor.rs`). Parent mechanics (per-theme `SegmentConfig` with `ColorConfig{icon,text,background}` using `AnsiColor::{Color16,Color256,Rgb}`, 9 theme files cometix/default/minimal/gruvbox/nord/powerline-dark/light/rose-pine/tokyo-night, powerline arrow join) are unchanged.

## leo919cc/cclinebar
URL: https://github.com/leo919cc/CClineBar — stars: 0. FORK OF Haleclipse/CCometixLine.
Differs from parent (GitHub compare: 20 commits ahead, 87 behind). Styling-relevant differences: `StyleConfig.show_icons` boolean (default true) hides every segment icon (`src/config/types.rs` diff, commit "add show_icons option"); a new `ModelTime` segment and monthly cost tracking (cost segment now persists a ledger with file locking); the context segment now shows percent REMAINING until auto-compact, using Claude Code's own formula (effective window = size - min(max_output,20000); threshold = effective - 13000; `context_window.rs` diff) instead of percent used, with no token count; a `--patch-context` flag and automatic patching of Claude Code's own "context low" warning. No colour-system, theme or separator changes found in the diff; themes remain the parent's 9 per-segment RGB/ANSI theme files.

## LetermeFlorent/claude-statusline
URL: https://github.com/LetermeFlorent/claude-statusline — stars: 0 (Rust, no_std-style, Windows+Unix; code comments in French)
1. Colour source: per-metric palette plus value-driven gradient. Context bar: cells interpolate from `ctx_from` to `ctx_to` by cell index (light default `#7DB9FF -> #285AB4`, dark `#96CDFF -> #4682DC`, `config.rs`/`statusline.json`) — a gradient along the bar, not a threshold. 5h and 7d quota bars: start colour chosen by threshold from a 3-colour palette (`ok/warn/hot`; 5h `[120,110,200]` / `[170,90,175]` / `[200,60,95]`, 7d `[83,137,119]` / `[184,129,67]` / `[185,85,85]`, `config.rs:165-166`), warn at >=30%, hot at >=70% (`quota_warn/quota_hot`, `:161-162`), then a gradient away from that start colour controlled per metric (`gradient: {5h: 0.55, 7d: 0.3}`, `render.rs:130-134`). Optional system meters ram/io/cpu with their own ok/warn/hot palettes, warn 70 / hot 85. Model name underlined ink; effort word is drawn as a per-character gradient (`effort_pair` table of 6 level pairs for light and dark, `render.rs:42-61,217-226`); value text turns to the bar's last colour at 100%.
2. Themes: no named themes. Colours are set per light/dark mode (`Config::colors(light)`) with every colour overridable in `statusline.json` (`colors.ctx_from_light`, `palettes.5h.ok`, `system.colors.ram.ok`, …). The dracula/monokai/solarized names the scanner saw are terminal-detection test fixtures (`theme.rs` tests), not bundled themes.
3. Colour spec/depth: truecolor `38;2` from hex; no depth detection, no downsampling; no NO_COLOR found.
4. Fill: foreground only (bar cells are glyphs `■ ▪` coloured; empty cells use the `empty` colour).
5. Separators: plain text (`sep()`); not coloured per neighbour.
6. Neighbours: each metric has its own palette hue (5h violet-pink, 7d green-amber, ram teal, dsk olive, cpu blue); label text dimmed.
7. Light/dark: yes, the most thorough detector in this batch (`src/theme.rs:detect`): precedence `STATUSLINE_BG` env, then `terminal_background` config, then `COLORFGBG`, then reads the host terminal's own settings (VS Code and forks Cursor/Windsurf/VSCodium `settings.json` workbench.colorTheme; Windows Terminal profile colourScheme/background luminance; Zed theme; Ghostty config), then OS theme, default dark; cached in state keyed on file size+mtime. Chooses the light or dark palette set and effort-gradient table.
8. Glyphs: `■ ▪` bar glyphs configurable (`glyphs.filled/empty/half`), `ª` auto-compact marker; no Nerd Font or emoji.
9. Other: gradient everywhere; background self-update (`update.rs`), cross-platform binary `bin/statusline.exe`.
10. Customisation: `statusline.json` (bar_width, bold, glyphs, effort_style gradient|flat, segments on/off, gradient amounts, colours, palettes, thresholds, system metrics), env `STATUSLINE_BG`.

## letungq/claude-usage-gadget
URL: https://github.com/letungq/claude-usage-gadget — stars: 0
not a Claude statusline: a Windows 11 taskbar gadget (Python/tkinter, `min_claude_usage.py`) showing 5H/7D usage. Styling fact: fixed per-window hue `PALETTE = {five_hour #4cc2ff, seven_day #c792ea}` (`:810`), overridden by value colour `_value_color` (`:931-938`): >=90 `#ff6b6b`, >=75 `#ffb454`; background `#1c1c1c` with light/dark text variants chosen from the taskbar luminance (`:880-891`).

## LeviLazinskiy/ccstatusline
URL: https://github.com/LeviLazinskiy/ccstatusline — stars: 0. GitHub reports it as a standalone repo (`fork: false`), but it is a copy of sirmalloc/ccstatusline (same `src/widgets`, `src/tui`, `NOTICE`, `AUTHORS`); no upstream compare was possible, so the whole styling is given from `src/`.
1. Colour source: per-widget colour chosen by the user (each widget item carries `color` and optional `backgroundColor`; default layout `types/Settings.ts:31-39`: model cyan, context-length brightBlack, git-branch magenta, git-changes yellow) with a per-widget default (`widget.getDefaultColor()`), OR, in Powerline mode with a theme, by position: `fgColor = theme.fg[widgetColorIndex % fg.length]`, `bgColor = theme.bg[widgetColorIndex % bg.length]` (`utils/renderer.ts:180-195`), index counted over non-merged widgets so merged widgets share one colour.
2. Themes: Powerline themes only. `POWERLINE_THEMES` (`utils/colors.ts:~267-430`): custom, nord, nord-aurora, monokai, solarized, minimal, dracula, catppuccin, gruvbox, onedark, tokyonight. Format: each theme has up to three colour-depth variants keyed 1 (ANSI16), 2 (256), 3 (truecolor), each `{fg: string[5], bg: string[5]}` of colour names (e.g. nord truecolor bg `88C0D0, 4C566A, 5E81AC, B48EAD, A3BE8C`, fg `2E3440, D8DEE9, FDF6E3, 2E3440, 2E3440`), so text colour is hand-paired with each fill. `custom` uses each widget's own colours. TUI can "customize" a theme: copies the theme's colours onto widgets and switches to custom (`PowerlineThemeSelector.tsx:50-94`). Users cannot add themes without editing source; they can fully colour widgets by hand.
3. Colour spec/depth: names `black..brightWhite` and `bg*` variants plus `ansi256:N` and `hex:RRGGBB` (`colors.ts getChalkColor`). Colour level is a setting, `colorLevel` 0-3 default 2 (256), applied by `chalk.level = settings.colorLevel` (`ccstatusline.ts:60-63`); each named colour has an ansi16, an ansi256 and a truecolor value in `COLOR_MAP` (`colors.ts:11-49`, e.g. red `chalk.red`/`ansi256(160)`/`#cc0000`). The user picks the level; no automatic terminal detection, no NO_COLOR.
4. Fill: both. Normal mode is foreground-only text with optional per-widget background; Powerline mode always fills with themed backgrounds.
5. Separators: normal mode a separator widget (default text, colour inheritable `inheritSeparatorColors`); Powerline mode `separators` array (default U+E0B0), `separatorInvertBackground` per separator, `startCaps`/`endCaps` arrays (`types/PowerlineConfig.ts`). Arrow colours derived: normal = fg is previous widget's bg (converted via `bgToFg`), bg is next widget's bg; inverted swaps; same-background neighbours use next widget's fg (`renderer.ts:~300-350`). TUI separator editor (`PowerlineSeparatorEditor.tsx`).
6. Neighbours: in powerline themes, cycling through a 5-colour list by widget index, so adjacent fills differ by hue (not lightness steps); wraps after 5.
7. Light/dark: no terminal-background detection. Text contrast is hand-paired in the theme fg list (dark `2E3440` on light fills, light on dark); `overrideForegroundColor` and `overrideBackgroundColor` global settings force one colour.
8. Glyphs: Powerline glyphs (U+E0B0-E0B3) require a Powerline/Nerd font; `checkPowerlineFonts()` searches font directories for powerline/nerd/meslo/etc names and `fc-list`, and can clone powerline/fonts and install them (`utils/powerline.ts`); emoji in several widgets.
9. Other: React/Ink TUI configurator with live preview (`StatusLinePreview.tsx`); `globalBold`; flex separators; `autoAlign` column alignment across lines; terminal width modes (full, full-minus-40, full-until-compact).
10. Customisation: JSON settings with zod schema (`types/Settings.ts`: lines, flexMode, compactThreshold, colorLevel, defaultSeparator, defaultPadding, inheritSeparatorColors, override colours, globalBold, powerline{}), Ink TUI (`ccstatusline` with no stdin), custom-command and custom-text widgets.

## levy-n/claude-code-mods
URL: https://github.com/levy-n/claude-code-mods — stars: 0
not a Claude statusline: two Claude Code mods (context-handoff offer, token-weather band above the prompt). Styling fact: token-weather colours its forecast by fill band (`token-weather/hooks/token-weather.mjs:23-27`: <25% yellow "Clear", <50% cyan "Cloudy", <75% blue "Showers", <90% magenta "Storm", else red "Compact soon"), using ink named colours plus `dimColor`; it ships a "weather glyph" per band (`☀ ☁ ☂ ☇ ↯`).

## lexbryan/ai-usage-limit
URL: https://github.com/lexbryan/ai-usage-limit — stars: 0
not a Claude statusline: a GNOME Shell top-bar extension showing Claude Code and Codex remaining capacity; `bin/aiul-statusline.sh` only wraps the user's existing statusLine command to capture the rate-limit JSON (it adds no styling). Styling fact: severity CSS classes in `extension/stylesheet.css` on remaining capacity: `.aiul-ok #8ff0a4`, `.aiul-warn #f8e45c`, `.aiul-crit #ff7b63` ("close to GNOME's own warning/error hues"), stale readings faded with opacity 0.5, bar track `rgba(255,255,255,.13)`; picked by `extension.js:~105-110`.

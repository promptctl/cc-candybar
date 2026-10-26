# Batch 35: styling of 25 Claude Code statusline projects

All 25 repos had stars=0 in the batch file. Anchors are file paths in each repo (line numbers where I had them).

## alexw24/claude-hud
URL: https://github.com/alexw24/claude-hud (FORK OF jarrodwatts/claude-hud) | stars: 0
Differs from parent only as listed; the rest of the styling is the parent's.
1. Colour mapping: fixed per role, same as parent. `src/config.ts:284-298` defaults: context=green, usage=brightBlue, warning=yellow, usageWarning=brightMagenta, critical=red, model=cyan, project=yellow, git=magenta, gitBranch=cyan, label=dim, custom=208. Thresholds in `src/render/colors.ts:getContextColor` (>=85 critical, >=70 warning, else green; both configurable). Usage bar `getQuotaColor` is >=90 red, >=75 brightMagenta, else brightBlue. DIFFERENCE: parent's `colors.ts` has a `UsagePace` argument (`getQuotaColor(percent, colors, pace)`, a coloured `▲` marker). The fork's `getQuotaColor(percent, colors)` has no pace. The fork keeps a `claudeOrange()` helper that the parent's colors.ts lacks.
2. Themes (the fork's main difference): one bundled oh-my-posh theme, `themes/claude-hud.omp.json`. Users can point `ohMyPosh.configPath` at their own oh-my-posh theme. The native renderer has no themes, only the `colors.*` overrides.
3. Spec/depth: native renderer takes a named preset, a 256 index (number) or `#rrggbb` (`colors.ts:resolveAnsi`); no downsampling and no NO_COLOR found in colors.ts/config.ts. Under oh-my-posh, depth is oh-my-posh's own.
4. Fill: native = foreground only. omp theme = background-filled powerline/diamond blocks on line 1; line 2 (tools, agents, todo) is fg-only (`style: plain`).
5. Separators (omp only): `style: "powerline"` with `powerline_symbol`, and `"diamond"` with leading/trailing diamonds (glyph bytes are private-use and did not survive the fetch). Native renderer uses plain-text separators.
6. Neighbours (omp theme): fixed hue per segment: os `#b2bec3` (SSH session -> `#C792EA` via `background_templates`), model `#0077c2`, project `#FF9248`, git `#59C9A5`, context `#59C9A5`, 5h usage `#59C9A5`, cost `#83769c`. Git, context and usage share one green, so only the arrow separates them while all are calm.
7. Text contrast (omp): hand-picked per segment, `#1a1a1a` on the light backgrounds, `#ffffff` on `#0077c2` and `#83769c`. No luminance logic. No light/dark adaptation found.
8. Glyphs: Nerd Font in the omp theme (os icon, branch icon etc.), emoji/box in native. Native bar chars `colors.barFilled`/`barEmpty` default `█`/`░`.
9. Other: state-driven backgrounds in omp via env vars set by `src/omp-env.ts`: `CLAUDE_HUD_CONTEXT_STATE` = critical -> `#ef5350`, warning -> `#FFFB38`, else `#59C9A5` (`omp.json` `background_templates`); git dirty -> `#FFFB38`. Falls back to the native renderer if `oh-my-posh` is missing or times out (`src/omp.ts`, 1500 ms).
10. Customisation: `~/.claude/plugins/claude-hud/config.json` (`renderer`, `ohMyPosh.*`, `colors.*`, thresholds), `/claude-hud:configure` command; `CLAUDE_HUD_DISABLE` env.

## ali-raza-arain/claude-status-line
URL: https://github.com/Ali-Raza-Arain/claude-status-line | stars: 0
1. Colour: by theme role, with the role chosen per segment. `core/segments.sh:65-79` `_seg_bg` maps segment -> role: model/agent/ctx_*/pr/rate_limit/effort/thinking/worktree/vim/clock/link -> `accent`; dir/session/repo/duration/output_style/version/api_duration/git_sha/untracked/memory -> `muted`; git/lines_added/ahead/staged/clean -> `ok`; cost/cost_per_min/behind/unstaged -> `warn`; tier/lines_removed/deletions -> `crit`. Context % and rate limits use a gradient instead: `_grad_fg` (segments.sh:37) interpolates the theme's `ramp` (3 hex stops, OKLCH not used, plain RGB lerp in `lib/gradient.awk`) by 0-100 value.
2. Themes: 8 bundled JSON files in `themes/`: nord, dracula, gruvbox, tokyo-night, catppuccin, solarized, neon, mono. Format = semantic palette `colors.{fg,muted,accent,ok,warn,crit,ramp[]}` + `glyphs{}` per segment + `powerline{sep,sep_thin,left_end,right_end}` + `truecolor` bool. Users can add `themes/<name>.json`; `render.sh:109-112` falls back to mono if missing.
3. Spec/depth: hex only in themes. `core/colors.sh:10-68` writes truecolor when `CSL_TRUECOLOR=1`, else maps hex to the nearest xterm-256 index (cube + grey ramp). `render.sh:131-138`: truecolor only if theme `truecolor:true` AND `$COLORTERM` is truecolor/24bit (or `CSL_FORCE_TRUECOLOR=1`). `CSL_NO_COLOR=1` strips colour (`segments.sh:20`); the standard `NO_COLOR` is not read.
4. Fill: both, by layout. `layout: powerline` paints fg-on-bg blocks and sets `CSL_PLAIN_SEG=1` so segments emit plain text (`render.sh:151`); `pipe` and `plain` layouts are fg-only.
5. Separators: three layouts (`layout.sh:25-31`): `plain` (space), `pipe` (` │ ` in the `muted` colour, glyph from theme `glyphs.sep_thin`), `powerline` wedge. Powerline: wedge fg = previous block bg, wedge bg = next block bg (`layout.sh:127`); closing wedge fg = last bg on default bg (137); optional `head_cap`.
6. Neighbours: powerline blocks take the role bg, so neighbours differ only if roles differ (model accent, dir muted, git ok: three roles cycle). Same role twice in a row = same colour, arrow only.
7. Contrast: `_pl_text_fg` (`layout.sh:144-148`) picks `#1a1a1a` or `#f5f5f5` by luma `(299R+587G+114B)/1000 > 140`. No terminal-background detection.
8. Glyphs: per-theme `glyphs` map (catppuccin uses emoji/Nerd icons; neon uses `⚡ ▸ ⎇ ★ ◈`; mono uses none and `|`). Nerd Font only for powerline wedges.
9. Other: powerline column auto-align across rows (`render.sh:187-198`, `powerline.align`); flex spacer segment `flex`/`|>`; whiptail TUI (`tui.sh`) to pick theme, reorder widgets, preview against mock payload; HTML/PNG gallery in `docs/`.
10. Customisation: `config.json` (`theme`, `preset`), `presets/*.json` (`layout`, `lines[][]`, `options`), `widgets.json`; env `CSL_THEME`, `CSL_PRESET`, `CLAUDE_STATUSLINE_CONFIG`, `CSL_FORCE_TRUECOLOR`, `CSL_NO_COLOR`; `install.sh`, `tui.sh`, `preview.sh`.

## alimpfard/howmuchleft
URL: https://github.com/alimpfard/howmuchleft (FORK OF stricttools/howmuchleft) | stars: 0
Fork carries the old Node.js implementation (`lib/statusline.js`); the parent has since been rewritten in Go (`internal/render/colors.go` and `gradient.go`, whose header says "ANSI escape constants matching the Node.js colors object"). I read the fork in full and only the first 80 lines of the parent's `colors.go`, so any further differences are unverified.
1. Colour: bars by value, labels fixed. `statusline.js:57-67` fixed 16-colour roles: context % cyan, tier magenta, model/cwd white, git branch cyan, git changes yellow, `+n` green, `-n` red, reset-countdowns dim, "no .git" gray. The three progress bars (context, 5h, weekly) get colour from `getGradientStop(percent)` (686-708): a 10-stop green->yellow->orange->red gradient, interpolated per cell in truecolor, snapped to the nearest stop in 256.
2. Themes: no named themes. `~/.claude/howmuchleft` config `colors` is an array of entries `{dark-mode?, true-color?, bg, gradient[]}` (`findColorMatch`, 158-166). Built-in set has 4 combos (`BUILTIN_COLORS`, 128-136): dark/light x truecolor/256. Users can supply their own entries.
3. Spec/depth: truecolor RGB arrays or 256 integer indices, validated by `isValidGradient`. Detection: `COLORTERM` truecolor/24bit (`isTruecolorSupported`, 120-123); `colorMode: auto|truecolor|256` overrides; RGB gradients are converted to the nearest 256 index (`rgbTo256`). NO_COLOR: not found.
4. Fill: both. The bar cell is a block glyph, with empty cells painted via a background `emptyBg` (`[48,48,48]` dark / `[208,208,208]` light truecolor; 236 / 252 in 256) and the same bg/fg trick for partial blocks. Text labels fg-only.
5. Separators: plain spaces between fields; no powerline.
6. Neighbours: not applicable (fields are separated by spaces and colour differs by role).
7. Light/dark: yes. `isDarkMode()` (statusline.js:27-52) reads the OS appearance (macOS `defaults`, Linux gsettings `prefer-dark`), and picks the light gradient (darker greens/oranges, e.g. `[0,170,0]`, `[200,30,0]`) and a lighter empty-bar bg. The parent caches that answer 2 s in `.dark-mode-cache.json`.
8. Glyphs: eighth-block partial chars, optionally vertical bars; `partialBlocks: auto|true|false`, `progressBarOrientation: horizontal|vertical` (`getBarConfig`, 209-244).
9. Other: `--test-colors` renders a swatch (0/25/50/75/100 % bars plus a 40-cell continuous gradient strip, `testColors`, 982-1007); demo GIFs in dark and light.
10. Customisation: JSONC config file (`parseJsonc`) with `progressLength` 3-40, `colorMode`, `colors[]`, `partialBlocks`, `progressBarOrientation`; CLI `howmuchleft --test-colors`.

## allenbw/agentic-workflow-toolkit
URL: https://github.com/AllenBW/agentic-workflow-toolkit | stars: 0
Only the `code-status-bar/` part is a statusline; `shift/` is an unrelated workflow tool. The bar is a pinned ccstatusline engine (v2.2.32) plus a config and one custom script.
1. Colour: fixed per widget in the ccstatusline config (`code-status-bar/settings.json`): context-bar/context-percentage brightBlue, compaction-counter brightYellow, model cyan (bold), thinking-effort brightCyan, cwd blue, git-branch magenta, git-changes yellow, ahead-behind cyan, session-usage brightYellow (bold), reset-timer and separators brightBlack, session-cost green, cache-timer brightCyan, weekly brightBlue, weekly-opus brightMagenta. `settings.colored.json` replaces the three usage bars with `scripts/usage-bar.cjs`, which colours by threshold: `COLORS` green [138,226,52], yellow [252,233,79], red [239,41,41]; `YELLOW_AT=50`, `RED_AT=85` (usage-bar.cjs:19-26, `colorOf`).
2. Themes: none of its own (ccstatusline's powerline themes exist upstream, but `powerline.enabled` is false here).
3. Spec/depth: ccstatusline named colours (ANSI 16 names); `colorLevel: 2` (256) in settings; the custom script emits truecolor `38;2`. No NO_COLOR handling in the files read.
4. Fill: fg only (`powerline.enabled: false`).
5. Separators: `separator` widgets with text characters (` · ` in brightBlack, spaces); `flex-separator` pushes the right-hand group to the edge.
6. Neighbours: distinct fg hue per widget plus separators.
7. Contrast: none; relies on terminal ANSI palette.
8. Glyphs: block bars via ccstatusline `progress-short`; usage-bar.cjs uses `█ ░` and a `│` pace cursor (where you are in the reset window, in time).
9. Other: pace cursor on usage bars; bold on the bar text.
10. Customisation: ccstatusline `settings.json` (v4 schema: `lines[][]` of `{id,type,color,bold,metadata}`), `install.sh`, `CCSTATUSLINE_CONFIG_DIR`.

## alleneubank/agent-statusline
URL: https://github.com/alleneubank/agent-statusline | stars: 0
Zig renderer (`src/main.zig`, ~3000 lines) for Claude Code, Codex and Grok payloads; plus a `pi/agent-statusline.ts` extension for the pi agent.
1. Colour: fixed per element plus state. `main.zig:26-36` palette: cyan, green, gray (90), red, orange (256 #208), yellow, light_gray (256 #245). Directory path cyan, with the last path segment green when it equals the git branch (SPEC REQ-SL-013, main.zig:1997); host cyan, session gray; context gauge by value: gradient `gradientColor` (main.zig:590-610) 0-50 % green->yellow (R 0->255), 50-100 % yellow->red (G 255->0), full-saturation truecolor; legacy `color()` (651-656) <50 green, 50 yellow, 70 orange, 90 red. Effort badge by tier (SPEC REQ-SL-090): minimal/low gray, medium light-gray, high yellow, xhigh orange, max/ultra red. Permission mode: bypass red, edits yellow, plan/default green (main.zig:1330-1339).
2. Themes: not present.
3. Spec/depth: raw ANSI 16, one 256 index (208, 245) and truecolor for the gauge. No depth detection or NO_COLOR found in main.zig.
4. Fill: both. The 5-cell context gauge paints empty space with background `48;2;60;60;60` and the gradient colour as fg, using eighth-block glyphs for 40 steps (main.zig:615-648); everything else fg only.
5. Separators: plain spaces / `[branch]` brackets; no powerline.
6. Neighbours: fg hue by role, gray for punctuation.
7. Contrast: none (assumes dark-ish terminal; light_gray 245).
8. Glyphs: emoji per model (🌠 🌞 🌕 🌑 🌌 🐳 🐬 🔮 🐉), emoji dot dial for effort (⚫⚪🔵🟡🟠🔴🟣), 🎯 goals, 🛡 permissions, 💬/💤 activity. No Nerd Font, no ASCII mode.
9. Other: model-specific glyphs are the "per-model colour" analogue; hook-owned activity state.
10. Customisation: no config file; flags `--debug`, env `STATUSLINE_DEBUG`, `STATUSLINE_CAPTURE_DIR`, `AGENT_STATUSLINE_BIN`. Colours are compile-time constants.

## alokm3hta-star/claude-mods
URL: https://github.com/alokm3hta-star/Claude-Mods | stars: 0
Not a statusline. It is a collection of Claude Code mods (plugins): client-mask, control-panel, git-guard, house-style, released-objects, workspace-board. One mod, `context-bar`, draws a line above the prompt (band UI, not the statusline), so I answer the ten points for that mod only (`mods/context-bar/hooks/register.tsx`).
1. Colour: by state, using Claude Code's own theme role names. `format.ts`/register.tsx:34 `colourFor(percent)`: >60 `error`, >45 `warning`, else `success`; cache label `success` when warm, `inactive` otherwise; board summary `warning` when something is waiting. Labels use Ink `dimColor`.
2. Themes: inherits Claude Code's active theme; role names (`success`, `warning`, `error`, `inactive`) are resolved by the host. No bundled themes.
3. Spec/depth: semantic role names only; host handles depth.
4. Fill: fg only (Ink `<Text color=...>`).
5. Separators: ` · ` plain text in dim.
6. Neighbours: dim separators.
7. Contrast/light-dark: delegated entirely to the host theme roles.
8. Glyphs: `● warm` / `○ cold` markers, `█░` bar.
9. Other: clickable `<Button>` to open the board.
10. Customisation: none for colour.

## alphadoiy/usage
URL: https://github.com/alphadoiy/usage | stars: 0
A Rust ratatui usage monitor for Claude Code, Codex and Grok; `usage statusline` is its statusline mode (`src/statusline.rs`).
1. Colour: per provider accent plus value threshold. `src/theme.rs`: TEXT (242,242,247), WARNING (255,159,10), ERROR (255,69,58); `accent(provider)`: claude (217,119,87), codex (96,165,250), grok = TEXT, other (142,142,147). `meter(provider, percent)`: grok always TEXT; else >=90 ERROR, >=70 WARNING, else the provider accent. Used for the model name (claude accent), `ctx NN%` and the dot bars. Empty dots `○` fixed (110,110,115) (statusline.rs:397).
2. Themes: not present (one shared palette for the TUI and the statusline, `theme.rs` header comment).
3. Spec/depth: truecolor only, `paint()` (statusline.rs:460-465) writes `38;2;r;g;b`. A `color: bool` parameter disables it (tests render with false); where the caller sets it was not found in the scanned file.
4. Fill: fg only.
5. Separators: ` │ ` plain text between header fields; dot bars `● ● ○ ○`.
6. Neighbours: not applicable (separators only).
7. Contrast/light-dark: not present; palette assumes a dark terminal.
8. Glyphs: `● ○ ⟳`, Braille bars in the TUI; Chinese UI strings in errors.
9. Other: two chart styles in the TUI (Braille, ring, dot bar) and the README says the dot bar follows nilbuild/claude-statusline.
10. Customisation: TOML config (`style = "statusline"` for text), `usage statusline --providers claude`, env `USAGE_LOG_DIR`.

## alrightlad/custom-claude-code-terminal
URL: https://github.com/AlrightLad/custom-claude-code-terminal | stars: 0
A procedurally generated 8-bit golf game drawn in the statusline with half-block/sextant art. It is a statusline, but the "styling" is a pixel-art palette.
1. Colour: pixel colours come from palette roles (the scene draws by role name, `assets/palettes/augusta.json` `roles`: sky, water, tree, rough, fairway, green, sand, flag, ball, ...). The HUD text row (`src/render/hud.mjs`) uses fixed roles: `R.text`, `R.textDim`, `R.accent`, `R.info`, `R.bad` (flag red), `R.good`. Fixed chip backgrounds: `chipA` (green) for hole number and score, `chipB` (blue) for the shot, `chipC` (brown) for wind, `chipD` (gray) for par and stroke. Score colour by value: under par `bad` (red flag), over par `info` (blue), even `text` (hud.mjs:56).
2. Themes: 3 bundled palettes in `assets/palettes/`: augusta, desert, links (JSON: 42 named hex colours + `roles` mapping role -> colour name or index, `frame`). Users can add JSON files; `loadPalette(name)` (`src/render/palette.mjs`) falls back to augusta. Roles can be remapped freely (the file's note says so).
3. Spec/depth: truecolor by default, `256` on request; `sgrTables` (palette.mjs) emits `38;2` / `38;5` from a table, `toAnsi256` does the nearest cube/grey match. Mode comes from an env var read in `statusline.mjs:57` (`envVar('COLOR') === '256'`). No NO_COLOR found.
4. Fill: both. The art is background/foreground pairs per half-block cell; cell quantiser picks the palette index pair using a precomputed Lab distance table (`labDistances`, CIE76).
5. Separators: single-space `GAP` between chips; no powerline.
6. Neighbours: chips are told apart by four distinct background roles (green/blue/brown/gray).
7. Contrast: palette built on a luminance ladder (water < trees < rough < fairway < green < sand < highlight) and `harness/greyscale.mjs` asserts the ladder. No terminal-background detection.
8. Glyphs: half-block `▀▄`, sextants, arrows `→↘↓↙←↖↑↗`, `▂▄▆` wind bars; render tiers (`halfblock` default, higher tiers in `tiers.mjs`).
9. Other: animation (golfer, weather, seasons from the calendar, sprites), subagents appear as rival golfers on a leaderboard, GIF capture harness.
10. Customisation: env vars (`CCGOLF_*`: DISABLE, TIMEOUT_MS, STDIN_MS, TRACE, COLOR), palette JSON files, installer edits `~/.claude/settings.json`.

## alvinycheung/statusline
URL: https://github.com/alvinycheung/statusline | stars: 0
1. Colour: fixed per field plus thresholds, bright-16 ANSI. `statusline.sh:28-37`: PURPLE `95`, GREEN `92`, YELLOW `93`, RED `91`, BLUE `94`, GRAY `90`, WHITE `97`. Model in `[brackets]` uncoloured; `C` label PURPLE; directory BLUE (789); branch BRIGHT_GREEN (790); `5`/`7` window labels PURPLE; time-to-reset GRAY. Context left: >60 green, 50-60 yellow, else red (653-660). 5h and 7d: <60 green, 60-80 yellow, >80 red (718-726, 745-749). Velocity glyph `▁..█` coloured green/yellow/red by an awk category (696-701).
2. Themes: not present.
3. Spec/depth: ANSI bright-16 only. No detection, no NO_COLOR in the file.
4. Fill: fg only.
5. Separators: ` | ` plain text between usage fields; fields on separate lines (model / `C ##%` + 5h + 7d / directory / branch).
6. Neighbours: separate lines and one hue per kind (purple labels, blue dir, green branch).
7. Contrast: bright variants chosen to be readable on dark; no adaptation.
8. Glyphs: block-height velocity glyphs only; no icons.
9. Other: velocity bar (burn rate of the 5h and 7d windows), account rotation/alt-token logic unrelated to styling.
10. Customisation: edit the script; no config.

## alxmlv/claude-code-statusline
URL: https://github.com/alxmlv/claude-code-statusline | stars: 0
1. Colour: fixed per segment, bar by threshold. `statusline.sh` palette lines: C cyan = directory, G green = clean branch / low context / staged `●`, Y yellow = model name and dirty branch and warning, M magenta (declared "context percentage" but unused; the bar uses state colours), B blue = unstaged `○`, D red = danger / deletions, DIM `\033[90m` = separators. Context bar `build_bar`: `>=CONTEXT_DANGER (80)` red, `>=CONTEXT_WARNING (60)` yellow, else green; bar and % share the colour.
2. Themes: not present.
3. Spec/depth: ANSI 16 (`30-37`, `90`). No detection; no NO_COLOR.
4. Fill: fg only.
5. Separators: ` │ ` in DIM gray (`sep`).
6. Neighbours: separators plus one hue per segment; emoji prefixes (📁 🌿 🤖 🧠).
7. Contrast: header claims "Works in light and dark terminals" by using only the terminal's own 16-colour palette (no truecolor, no fixed greys beyond `90`).
8. Glyphs: emoji prefixes; bar `█`/`░` (`BAR_FILLED`/`BAR_EMPTY`, alternatives listed `━ ■ ●`).
9. Other: `BAR_WIDTH`, thresholds as top-of-file constants.
10. Customisation: edit the variables at the top of the script.

## amadeus19/cc-statusline
URL: https://github.com/amadeus19/cc-statusline (FORK OF Wangnov/claude-code-statusline-pro) | stars: 0
Fork is 10 commits ahead of the parent (and 78 behind). Differences: package rename (`@amadeus19/cc-statusline`, command `cc-statusline`), a `rate_limit` component (GLM Coding Plan), an API client (`src/api/`), a `progress_bar` component, `system_overhead` token config. Everything else is the parent's Rust engine, which I read in the fork's copy.
1. Colour: per component, from config. `configs/config.template.toml`: each `[components.X]` has `icon_color` and `text_color` (project blue/white, model cyan/white, branch green/white, tokens yellow/white, usage cyan/white, status magenta/white). Tokens by state: `colors.safe=green`, `warning=yellow`, `danger=red`; thresholds warning 60, danger 85, backup 85, critical 95. NEW progress bar (`src/components/progress_bar.rs:13-47` `rainbow_gradient_color`): 5 soft stops (80,200,80) green -> (150,200,60) -> (200,200,80) -> (220,160,60) -> (200,100,80), lerped per cell by percent; cells above the backup threshold use `▓` (`backup_char`).
2. Themes: 3 renderers selected by `theme =`: `classic` (fg text + coloured separator), `powerline` (bg blocks + Nerd Font arrows), `capsule` (rounded caps, `ignore_separator = true`); presets and `[themes.*]` tables. Colour names are mapped to a built-in Nord-derived RGB table (`src/themes/mod.rs:resolve_color`: black (46,52,64), red (191,97,106), green (163,190,140), yellow (235,203,139), blue (129,161,193), magenta (180,142,173), cyan (136,192,208), white (236,239,244), orange (208,135,112), bright_* = `lighten()` 12-20 %). Users can write `#rrggbb` and `custom_color_codes`.
3. Spec/depth: `ColorSupport::{None, Basic16, Extended256, TrueColor}` (`themes/mod.rs`): `rgb_to_ansi256` (grey ramp + 6x6x6 cube) and `rgb_to_ansi16` downsample. `style.enable_colors` can be `auto`; powerline falls back to classic when colours or Nerd Font are unsupported (`powerline.rs:174-200`). NO_COLOR: not seen in files read.
4. Fill: powerline = bg-filled blocks; capsule = bg-filled with half-circle caps; classic = fg only.
5. Separators: powerline arrow U+E0B0 and start cap U+E0D7 (`powerline.rs:15-16`); capsule U+E0B6/U+E0B4; classic uses `style.separator` (default `|`, colour `separator_color = white`, `separator_before/after` spaces). Powerline arrow fg = this block's bg, arrow bg = next visible block's bg (`render_segment`, `next_visible_color`).
6. Neighbours: powerline bg per component (`colors` slice, fallback `blue`); fg is one theme value (`themes.powerline.fg`). `reapply_colors` re-applies bg/fg after inner resets so inner coloured text keeps the block bg.
7. Contrast: a single configured fg for the whole powerline; no luminance logic found.
8. Glyphs: Nerd icon, emoji or text icon per component (`nerd_icon`, `text_icon = "[P]"`, `[M]`, `[B]`), `terminal.force_nerd_font`, `force_text`.
9. Other: three-segment progress bar; multi-line rows (`[multiline.rows]`).
10. Customisation: TOML `config.toml`, `components.order`, per-component icon/text colours, presets, `--theme` flags in the parent; npm/Rust binary.

## amali01/cc-pacer
URL: https://github.com/amali01/cc-pacer | stars: 0
1. Colour: role palette (8 named roles) assigned per element, and thresholds. `bin/cc-pacer.sh:16-23` default truecolor: blue (0,153,255), orange (255,176,85), green (0,175,80), cyan (86,182,194), red (255,85,85), yellow (230,200,0), white (220,220,220), magenta (180,140,255). Use: model = blue (325), directory = cyan (328), git branch parens green with dirty `*` red (330), duration/cost white, `+n` green `-n` red, effort magenta (346-348), mic/remote dot green/red. Bars by percent (119-122): >=90 red, >=70 yellow, >=50 orange, else green.
2. Themes: 4 bundled via `"theme"`: default, light, nord, dracula, plus mono (no colour) (57-72); each redefines the same 8 roles in truecolor. User override: `colors.{model,directory,good,warning,high,critical,text,effort}` as `#rrggbb` mapped to those roles (74-87).
3. Spec/depth: truecolor `38;2` only; `mono` empties every role. No NO_COLOR/COLORTERM check.
4. Fill: fg only.
5. Separators: plain text (` · `, `/`) with `dim`.
6. Neighbours: hue per role.
7. Light/dark: a `light` theme with darker fixed colours (e.g. white role = (60,60,60)), selected manually.
8. Glyphs: bar styles `dots` (● ○), `squares`, `slants` (▰ ▱), `blocks`, `line`, `braille`, `bar`; emoji 🔥 ⏱; `⟳`.
9. Other: configurable bar width/size/spacing; `hide` list to drop segments.
10. Customisation: `cc-pacer.json` (`theme`, `hide`, `barWidth`, `barStyle`, `barSize`, `barSpacing`, `clock`, `colors`), `npx cc-pacer config` wizard, `CC_PACER_CONFIG` env.

## aminmmmm/cometix-hud
URL: https://github.com/Aminmmmm/cometix-hud | stars: 0
A claude-hud-based fusion with the CCometixLine look; `dist/index.js` etc. are the claude-hud base.
1. Colour: per element from a theme table; context/usage by state. `src/themes.ts` `ThemeColors` slots: model, project, git, gitBranch, gitDirty, context, contextWarn, contextCritical, usage, usageWarn, cost, effort (+High/Med/Low), dir, separator, label. Example `cometix`: model (86,182,194) teal, dir (152,195,121) green, git (143,175,209) blue, cost (215,153,33) gold, effort (177,98,134) violet. Context bar (`render/powerline.ts:contextBar`): remaining <20 % critical, <50 % warn, else context colour; percent text uses >=85 critical, >=70 warn. Usage: >=90 critical, >=75 warn.
2. Themes: 5 bundled in `THEMES`: cometix, dracula, gruvbox, nord, minimal. Format = per-slot colour map with icons and `segmentSep`. `minimal` uses plain ANSI 16 and `·`. Unknown name falls back to cometix. No user-defined theme file.
3. Spec/depth: truecolor `38;2` for four themes, ANSI 16 for minimal; the base claude-hud `colors.ts` accepts names, 256 indexes and hex. No downsampling, no NO_COLOR found.
4. Fill: fg only. Despite the name, the "Powerline single-line renderer" (`powerline.ts`) draws no bg blocks; it joins coloured text with `│`.
5. Separators: ` │ ` (DIM) from theme `segmentSep`.
6. Neighbours: hue per slot plus dim separator.
7. Contrast: none.
8. Glyphs: Nerd-style icons per element via `theme.icons` (`✦ ⌂ ⎇ ↯ ❋ ⊕ ⌨ ⏱`), minimal theme has none; bars `█░` or `▰▱`.
9. Other: `lineLayout: auto` switches to the single-line renderer at >= 120 columns, expanded multi-line when narrower.
10. Customisation: JSON config (`theme`, `lineLayout`, `display.*`, `colors`), `/cometix-hud:configure`.

## anascunha/claude-monitor-and-alerts
URL: https://github.com/anascunha/claude-monitor-and-alerts | stars: 0
Statusline plus a beep hook and an optional always-on-top monitor window (WPF, `scripts/overlay/overlay.ps1`).
1. Colour (statusline): by value only. `scripts/statusline.sh:render_bar`: >=90 red `31`, >=70 yellow `33`, else white `37`; reset text dim `2`. Bar and label share the colour.
2. Themes: not present.
3. Spec/depth: ANSI 16 only; no detection, no NO_COLOR.
4. Fill: fg only.
5. Separators: ` · ` in dim; rows are separate lines (Session 5h / Weekly).
6. Neighbours: separate lines.
7. Contrast: none.
8. Glyphs: `█ ░` 10-cell bar, `%-10s` aligned labels.
9. Other: the overlay window has its own hex palette (overlay.ps1:58-61): working `#22C55E`, finished `#EF4444`, question `#699BFB`, permission `#FACC15`; usage bar `#EF4444` >=95, `#F59E0B` >=80, else `#699BFB`; card bg `#F21C1D2F`. Not terminal styling.
10. Customisation: `scripts/setup_statusline.sh`; nothing for colour.

## anay-schottlabs/claude-usage-bar
URL: https://github.com/anay-schottlabs/claude-usage-bar | stars: 0
1. Colour: threshold with a per-window colour pair. `statusline.sh:render_section` (76-143): >=80 red always; >=50 `mid_color`; else `low_color`. 5h window: low green `32`, mid yellow `33` (line 260); 7d window: low cyan `36`, mid magenta `35` (261), so the two windows are told apart by hue. Lines changed: `+n` green `-n` red (157). Git, commit stats and totals: uncoloured.
2. Themes: not present.
3. Spec/depth: ANSI 16; no detection, no NO_COLOR.
4. Fill: fg only.
5. Separators: two spaces + `│` + two spaces (stats line, 265-268); bars in `[ ]`.
6. Neighbours: separators and per-window hue.
7. Contrast: none.
8. Glyphs: bar chars in `[ ]`, `n/a` dots when no data; a zero-width space line to keep a blank row (comment 270+).
9. Other: caches last-known rate-limit values.
10. Customisation: edit the script. `pause-button/` is a separate plugin using `dimColor` text.

## anaypaul/agent-status-line
URL: https://github.com/anaypaul/agent-status-line | stars: 0
Most relevant of the batch: per-segment colour pairs per urgency, light/dark families, three render styles.
1. Colour: a theme maps each segment id to colours per urgency. `src/themes/engine.ts:resolveSegmentColors`: `theme.segments[segment.id][segment.urgency] ?? .normal`, falling back to `theme.base`. Segment ids: model, context, rate-limit, cost, git, session, directory, vim-mode, agent-info. Example `src/themes/builtin/nord.ts`: every segment has `normal {fg, bg:#3b4252}`; model fg `#81a1c1`, context/rate-limit/git fg `#a3be8c`, cost/agent-info `#b48ead`, session `#88c0d0`, directory `#d08770`. `warn` is `{fg:#000000, bg:#ebcb8b}` and `critical` `{fg:#ffffff, bg:#bf616a}` for every segment, identical across segments. Urgency thresholds: `src/config/defaults.ts` context 50/90, rate 60/85, cost $1/$5.
2. Themes: 12 bundled in `src/themes/index.ts`: default, monokai, solarized, catppuccin, gruvbox, nord and a `-light` twin of each. Format = `{name, meta{variant}, base{bg,fg,separator_fg}, segments{id: {normal, warn, critical}: {fg, bg}}}`. Users can load their own JSON by path or `*.json` (`getTheme`). `THEME_FAMILIES` maps a family name to its dark and light variant.
3. Spec/depth: hex only, truecolor only (`src/render/ansi.ts`: `38;2` / `48;2`). No downsampling, no NO_COLOR found.
4. Fill: both by style. `style: minimal` (default) = fg only; `powerline` and `capsule` = bg-filled.
5. Separators: minimal ` | ` in `base.separator_fg`; powerline arrow U+E0B0 with fg = this block's bg, bg = next block's bg (`styles/powerline.ts`; last arrow into reset); capsule = left U+E0B6 and right U+E0B4 caps per segment, joined by a space (`styles/capsule.ts`).
6. Neighbours: in the shipped themes every segment's `normal` bg is the same single colour (`#3b4252` in nord), so neighbours differ by fg hue only and the powerline arrow is bg-to-same-bg. Only warn/critical change the bg.
7. Light/dark: yes. `theme: auto` (default) or a family name resolves to the dark or light twin via `detectTerminalBackground()` (`src/utils/terminal-background.ts`): `COLORFGBG` bg index (7, 9-15 = light), `VSCODE_THEME_KIND`, macOS `AppleInterfaceStyle`, else dark. Text contrast is hand-set per theme (black on warn yellow, white on critical red).
8. Glyphs: `icons: ascii | nerd | none` (`src/render/icons.ts`: Nerd codepoints e.g. `` model; ASCII `[M]`, `[Ctx Window]`, `[$]`). Default `ascii`.
9. Other: a setup wizard (`src/config/wizard.ts`), `watch` mode, multi-agent adapters (`src/agents/`).
10. Customisation: config file via `loadConfig` (`style`, `theme`, `icons`, `max_width`, `thresholds`, per-segment `enabled/position/options`), wizard, custom theme JSON.

## andhikapraa/goccline
URL: https://github.com/andhikapraa/goccline | stars: 0
1. Colour: semantic slots, fixed per component, plus per-model and per-threshold. `internal/theme/theme.go` `Theme` slots: Path, Branch, Session, SessionText, Model, Sonnet, Haiku, Opus, Style, Version, Time, CostLive/Today/Week/Month/Repo, Hijri, Wellness(Ok/Nudge), Location, Prayer(Done/Next), Dim. Catppuccin Mocha: Path blue (137,180,250), Branch mauve (203,166,247), Model/Opus/Session cyan (137,220,235), Sonnet green (166,227,161), Haiku yellow (249,226,175), CostLive yellow, CostToday green, CostWeek blue, CostMonth mauve, CostRepo pink. Per-model colours are explicit slots. Context: `ctxColor` (`components/context_window.go`): >=90 `WellnessNudge` (red), >=75 `Time` (peach), else `WellnessOk` (green) - threshold colours reuse unrelated slots.
2. Themes: 4 bundled (`Resolve`): catppuccin (default), garden, ocean, classic. Format = struct of ~28 ready-made SGR strings. `classic` uses plain ANSI 16; the others truecolor. No user-defined themes (adding one means editing Go).
3. Spec/depth: truecolor `38;2` (catppuccin/garden/ocean) and ANSI 16 (classic). No detection; no NO_COLOR found.
4. Fill: fg only.
5. Separators: plain text between components/lines (emoji prefixes).
6. Neighbours: one hue per slot; lines grouped by config.
7. Contrast/light-dark: not present.
8. Glyphs: emoji prefixes throughout (🧠, ⚠️); no Nerd Font.
9. Other: prayer/Hijri/wellness components (unusual); GPS location.
10. Customisation: `~/.claude/goccline/Config.toml` (`[theme] name`, `[display] lines`, `[display.lineN] components`).

## andr-dst-sandbox/statusline-or
URL: https://github.com/andr-dst-sandbox/statusline-or | stars: 0
1. Colour: semantic roles, state-driven bars. `statusline-or.js:104-108` themes; roles: model, effort, label, track, dim, good, warn, bad, cost, cache, tok, sep. Mapping (lines 350-412): `ctx` label = label, bar+% = `heat(pct,60,85)`; rate-limit bars `heat(pct,50,80)` (good/warn/bad); cache hit = `cache`; token arrows = `tok`; costs = `cost`; model = `model`; effort = `effort`; reset text = dim; empty bar track = `track`.
2. Themes: 4 bundled in `THEMES`: catppuccin (default), tokyonight, gruvbox, nord (hex per role, no `#`). Chosen by env `SL_THEME` or a constant; users edit the hex in the file. No theme files.
3. Spec/depth: truecolor only (`paint()`, line 115). `NO_COLOR` honoured (113: `USE_COLOR = !process.env.NO_COLOR`; separator falls back to ` | `). No depth detection.
4. Fill: fg only.
5. Separators: ` │ ` in the `sep` colour (121), ASCII ` | ` under NO_COLOR.
6. Neighbours: hue per role + dim separator.
7. Contrast/light-dark: not present (dark themes only).
8. Glyphs: eighth-block bars (`▏▎▍▌▋▊▉`), `⚡ ↑ ↓ ↻ ▸`; no Nerd Font.
9. Other: its own cost engine; bar track colour is its own role.
10. Customisation: env `SL_THEME`, editing the script.

## andre-bzk/claude-statusline-kit
URL: https://github.com/Andre-Bzk/claude-statusline-kit | stars: 0
A Windows installer around the `cship` binary (a Starship fork); the styling is `assets/cship.toml` plus a PowerShell wrapper.
1. Colour: per module style string in TOML. `cship.toml`: model `bold cyan`, effort `fg:#7dcfff` (high `fg:#e0af68`, xhigh bold same, max bold `fg:#f7768e`), context bar `fg:#7dcfff` with `warn_threshold = 20.0` -> `yellow` and `critical_threshold = 40.0` -> `bold red`, tokens `fg:#a9b1d6`, peak usage `fg:#e0af68`. The wrapper `assets/cship-statusline.ps1:34-37` recolours the 5h and 7d bars the same way: >=70 `1;31`, >=40 `33`, else truecolor `38;2;125;207;255`.
2. Themes: not present (Tokyo Night hex values used directly).
3. Spec/depth: Starship style strings (named + `fg:#hex`) and raw SGR; no NO_COLOR/depth handling in the files read.
4. Fill: fg only.
5. Separators: `$cship.model $cship.effort ...` space-separated; usage bars joined by three spaces.
6. Neighbours: spacing and emoji prefixes.
7. Contrast: none.
8. Glyphs: emoji (🤖 ⚡ 🧠 🔢 ⏰ ⏳ 📅), bar `█░`.
9. Other: screenshot in `docs/`; German/English README.
10. Customisation: `cship.toml` (`lines`, per-module `symbol`, `style`, `format`, thresholds).

## andregosling/claude-statusline
URL: https://github.com/andregosling/claude-statusline | stars: 0
1. Colour: fixed per field plus threshold. `statusline.js:C` (71-87), all truecolor: path (125,207,255), git (195,232,141), gitDirty (255,203,107), gitGone (240,113,120), gitAdd green, gitMod yellow, gitDel red, gitCount (160,170,190), model (199,146,234), cost (255,203,107), tokens (130,170,255), time white, rule (90,100,120), label (160,170,190). Context bar `ctxColor` (338-343): >=80 `ctxHot`, >=50 `ctxWarn`, else `ctxOk`.
2. Themes: not present; README says edit the `C` object.
3. Spec/depth: truecolor only (`rgb()`); no detection, no NO_COLOR.
4. Fill: fg only.
5. Separators: box-drawing frame `╭─ │ ╰─` (`G.tl/mid/bl`) and dim `rule` colour; fields separated by spaces.
6. Neighbours: hue per field.
7. Contrast: none.
8. Glyphs: Nerd Font by default; `CLAUDE_STATUSLINE_PLAIN=1` swaps to ASCII (`G` table, 91-106). Width accounting counts private-use glyphs as double-width (`termWidth` reflow, uses `COLUMNS`).
9. Other: OSC 8 hyperlinks (`ANSI_OSC8`), a built-in HTML dashboard page (CSS gradients; not terminal styling), telemetry opt-out via `CLAUDE_METRICS_DISABLED`.
10. Customisation: edit `C` and `G`; env `CLAUDE_STATUSLINE_PLAIN`; installers for sh and PowerShell.

## andrewmikhailiuk/go-claude-statusline
URL: https://github.com/andrewmikhailiuk/go-claude-statusline | stars: 0
1. Colour: semantic palette slots; solid "chip" for the context %, outline chips for others. `theme/theme.go` `Palette`: Red, Green, Yellow, Blue, Purple, Cyan, White, Gutter, Bg2, Bg3, ChipBg, ChipFg. Use: model chip = `ChipOutline(text, p.Yellow, p.Bg2)` (`statusline/meta.go:56`); git branch = `ChipOutline(.., p.Green, p.Bg3)` (`git.go:55`); path = `ChipOutline(.., p.White, p.ChipBg)` (`path.go:22`); context % = solid `Chip` whose bg is by value (meta.go:60-72): >=90 Red, >=70 Yellow, >=40 Blue, else Green, with dark `ChipFg` text.
2. Themes: self-registering; 2 files, `atom_one_dark` (default; README also calls it one-dark) and `dracula` (`theme/dracula.go`). Format = `Palette` struct, each colour a `Color{Fg, Bg}` pair of truecolor escapes built from one RGB triple (`NewColor`). Users add a theme by dropping a Go file that calls `Register` (compile-time, not a data file).
3. Spec/depth: truecolor only (`FgEscape`/`BgEscape`). No detection or NO_COLOR in files read.
4. Fill: both. `ChipOutline` = coloured text on a darker background; `Chip` = dark text on a solid colour.
5. Separators: none; rows are separate lines and chips abut with one-space padding.
6. Neighbours: chips differ by fg colour and by backdrop depth (`Bg2` raised vs `Bg3` deeper vs `ChipBg` deepest).
7. Contrast: `ChipFg` per theme is the dark base colour used on bright solid chips; no luminance computation.
8. Glyphs: `icons` sets `nerd`, `plain`, `none` (`icons/nerd.go`, `plain.go`, `none.go`); `Prefix` drops the space when a glyph is empty.
9. Other: interactive full-screen config editor (`config/ui.go`, raw-mode TTY via stty, live preview, toggle rows, pick theme and icon set).
10. Customisation: `~/.claude/claude-statusline.json`, env `CLAUDE_STATUSLINE_THEME` (env > file > default), `claude-statusline config|help`.

## andrews-aule/claude-usage-statusline
URL: https://github.com/Andrews-Aule/Claude-Usage-Statusline | stars: 0
1. Colour: fixed per field, bar by threshold. `statusline.py`: `user@host` bold green `1;32`, cwd bold blue `1;34`, model yellow `33`, `|` separators dim `2`, rate-limit string wrapped in cyan `36` but its percentage overridden by value: >=90 bold red, >=70 bold yellow, else bold green (`1;31/1;33/1;32`). Reset time dim.
2. Themes: not present.
3. Spec/depth: ANSI 16; no detection; no NO_COLOR.
4. Fill: fg only.
5. Separators: ` | ` dim.
6. Neighbours: hue per field.
7. Contrast: none.
8. Glyphs: `[████░░░░]` bar, `↺` reset marker.
9. Other: caches last rate-limit reading in `~/.claude/daily_tokens/rl_cache.json`.
10. Customisation: edit the script (the `.sh` is a 2-line wrapper that calls the Python script).

## andyjohansson/claude-code-jarvis-hud
URL: https://github.com/andyjohansson/claude-code-jarvis-hud | stars: 0
Two separate things: a Claude Code colour theme (JSON) and a statusline script that matches it.
1. Colour (statusline): 6 named truecolor roles, fixed per element, level colour for gauges. `statusline/statusline.sh` night palette: cyan (0,216,255), text (212,243,255), dim (47,85,102), muted (111,147,165), gold (255,215,95), red (255,77,94). Use: `◆` and model name cyan/bold-text, effort muted, gauge brackets dim, branch cyan, dirty dot gold, dir bold text, `5h`/`7d` labels muted, separator `┊` dim. `level_color`: <50 cyan, 50-79 gold, >=80 red, applied to the context gauge/percent and to 5h and 7d percentages.
2. Themes: two Claude Code themes (`themes/jarvis-hud.json`, `jarvis-hud-day.json`) as `{name, base: dark|light, overrides{...}}` over Claude Code's own role names (claude, text, inactive, subtle, success, error, warning, diff*, ..._FOR_SUBAGENTS_ONLY, rate_limit_fill/empty). The statusline has two matching palettes (night and day).
3. Spec/depth: truecolor only. No detection, no NO_COLOR.
4. Fill: fg only in the statusline; the theme JSON sets diff and message backgrounds for Claude Code itself.
5. Separators: ` ┊ ` in `dim`.
6. Neighbours: dim separator; fg roles.
7. Light/dark: yes. The statusline reads `.theme` from Claude Code's `settings.json` and switches to the Day palette (cyan (0,134,179), text (11,39,51), gold (166,107,0), red (214,40,57)) when it equals `custom:jarvis-hud-day`. `appearance/appearance-sync.sh` (a LaunchAgent) flips the Claude theme with macOS dark/light mode.
8. Glyphs: standard Unicode only (`◆ ⟨▰▱⟩ ⎇ ● ↻ ┊`), no Nerd Font.
9. Other: `mod/jarvis-reactor/` animated arc-reactor spinner plugin (animation); spinner verbs/tips; `tools/preview.sh`.
10. Customisation: `install.sh`; editing the palette variables.

## anitchaudhry/claude-code-statusline
URL: https://github.com/AnitChaudhry/claude-code-statusline | stars: 0
1. Colour: semantic `CLR_*` vars, one per field, plus a 4-step context ramp. `themes/*.sh` define `CLR_SKILL`, `CLR_MODEL`, `CLR_DIR`, `CLR_GITHUB`, `CLR_TOKENS`, `CLR_COST`, `CLR_VIM`, `CLR_AGENT`, `CLR_CTX_LOW/MED/HIGH/CRIT`, `CLR_SEP`, `CLR_BAR_EMPTY`, `CLR_LABEL`, `CLR_GIT_STAGED/UNSTAGED`. Default theme: skill pink (236,72,153), model purple (168,85,247), dir cyan (6,182,212), tokens amber, cost green, vim teal, agent indigo. Context (`lib/core.sh:153-162`): >90 CRIT, >75 HIGH, >40 MED, else LOW (default: white, orange, red, deep red; nord: Snow Storm, orange, red, red).
2. Themes: 5 bundled, listed by the `/sls-theme` command: default, nord, tokyo-night, catppuccin, gruvbox (`themes/*.sh`). Format = bash variable file of truecolor escapes. Users add a `themes/<name>.sh`; `core.sh:61-65` falls back to default.
3. Spec/depth: truecolor `38;2`. No detection; no NO_COLOR.
4. Fill: fg only.
5. Separators: ` │ ` (`SEP_CHAR`) in `CLR_SEP` between columns of a 4-row layout.
6. Neighbours: labelled rows ("Skill:", "Model:") each in its own hue; columns split by a dim pipe.
7. Contrast: none.
8. Glyphs: no icons; `BAR_FILLED █` / `BAR_EMPTY ░` per theme.
9. Other: 3 layouts (`compact`, `standard`, `full`), compaction warning text coloured with `CLR_CTX_CRIT`/`HIGH`; both bash and Node statusline implementations (`bin/statusline.sh`, `bin/statusline-node.js`).
10. Customisation: `~/.claude/statusline-config.json` (`theme`, `layout`), env `STATUSLINE_THEME_OVERRIDE`, `ccsl theme set <name>`, `/sls-theme` slash command.

## annieday/oh-my-claude-cli
URL: https://github.com/Annieday/oh-my-claude-cli | stars: 0
A wizard that generates a shell statusline script (`src/generator.js`).
1. Colour: per segment `{fg, bg}` from the theme, user-overridable. `src/themes.js`: segment ids directory, git_branch, session_name, model, context_bar, cost, clock, tokens_raw, agent_indicator. Only `directory` and `git_branch` get a background (dark text `232` on a theme colour); the rest are fg-only. Dracula: dir bg 61 / git bg 84; nord: dir 68 / git 71; tokyonight: dir 62 / git 33 (white text); catppuccin: dir 183 / git 114. Context bar ignores the theme unless overridden: >=80 `196`, >=50 `220`, else `114` (`generator.js` context_bar), percent `245`.
2. Themes: 6 bundled (dracula, nord, tokyonight, catppuccin, powerline, minimal), each with an emoji for the picker. Format = per-segment colour map (not semantic roles). Users can override any segment's fg (bg set to null) in the wizard, saved in `overrides` (config.js).
3. Spec/depth: ANSI 256 indices only (`38;5;n`, `48;5;n`); no truecolor, detection or NO_COLOR.
4. Fill: both (dir and git cells bg-filled, the rest fg).
5. Separators: `separatorStyle` is stored (`powerline` or `space`) but `generator.js` and `preview.js` emit no separator glyph: cells are concatenated with a space ("powerline: space between blocks; color does the visual work", preview.js:33).
6. Neighbours: dir vs git use different bg colours; the remaining fields are fg hue only.
7. Contrast: hard-coded dark text (`232`) on the light bgs and white (`255`) on tokyonight's dark ones, per theme.
8. Glyphs: git branch icon, `⚡ agent`, `█░` bar; emoji per theme in the wizard.
9. Other: 5-step `@clack/prompts` wizard with a live preview (`src/preview.js`), segment toggles, colour overrides.
10. Customisation: `~/.claude/ohmyclaude.json` (`theme`, `separatorStyle`, `segments[]`, `overrides{}`), regenerates the script.

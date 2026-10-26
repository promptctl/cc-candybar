## rmdrao/ccbar
https://github.com/rmdrao/ccbar — stars 0
1. Fixed per segment, plus state on two. `scripts/statusline-command.sh`: dir `\033[0;36m` cyan (l.66), model `0;33` yellow (l.69), session-token label `0;35` magenta (l.365), daily-total label `0;34` blue (l.406), separator `0;90` grey `|` (l.415). Context is by threshold on remaining %: <=10 red, <=25 yellow, else green (l.75-81). Rate-limit segments (5h/7d) are mostly uncoloured text plus an emoji dot chosen by projected end-of-window usage: >=100 red, >=95 or >=90 yellow, else green (l.123-160); over 100% adds a reverse-video bold bright-red " EXTRA USAGE " prefix (`1;7;91`, l.148) and a separate alert line (l.342); >=95 adds bold yellow "⚠ " (l.155).
2. Themes: not present.
3. Colour: ANSI-16 SGR only (`0;3x`, `0;90`, `91`). No depth detection; no NO_COLOR (grep finds none).
4. Fill: foreground-only, except the reverse-video (`;7;`) EXTRA USAGE badge, which is a filled block.
5. Separators: plain grey ` | ` between parts (l.415).
6. Neighbours: different hues per segment + the grey pipe.
7. Light/dark: not present (relies on the terminal's own ANSI palette).
8. Glyphs: emoji status dots 🟢🟡🔴 and 🚨; no Nerd Font, no ASCII mode.
9. Other: "cycling views" of the burn-rate label (View A / View B) switched by a state file `~/.claude/status-detail-mode` (compact/detailed) — a content toggle, not styling.
10. Customisation: shell script, `toggle-status.sh` flips the mode file; no config file or env for colours.

## rmuthura/claude-statusline
https://github.com/rmuthura/claude-statusline — stars 0
1. Fixed per segment with thresholds. `statusline.sh`: model bold cyan (l.197), tokens "in:/out:" labels grey, cost green (l.219), git branch cyan + dirty `*` yellow (l.184). Bars (context, 5hr, wk) use one rule: <50 green, >=50 yellow, >=80 red (l.111-113, 132-134); only the bar glyphs and the percentage take the colour, the label stays grey.
2. Themes: not present.
3. Colour: ANSI-16 escapes `\033[0;3x`, `0;90` grey (l.8-14). No depth detection, no NO_COLOR.
4. Fill: foreground only.
5. Separators: plain ` │ ` in grey (`SEP`, l.192).
6. Neighbours: separator plus the segment's own hue.
7. Light/dark: not present.
8. Glyphs: `█`/`░` 5-cell bar; no icons, no Nerd Font.
9. Other: nothing notable.
10. Customisation: edit the script; `install.sh` only wires settings.json.

## RobGruhl/ccstatusline
https://github.com/RobGruhl/ccstatusline — stars 0 (GitHub says `fork: false`, but the tree is an older copy of sirmalloc/ccstatusline: it lacks the parent's gradient code, `src/utils/gradient`, and has one extra file, `src/widgets/shared/git-no-git.ts`; compared via tree listing and a diff of `src/utils/colors.ts`)
1. Per segment, user-assigned. Non-powerline: each widget has a fixed default foreground from `getDefaultColor()` (Model `cyan` `src/widgets/Model.ts:10`, GitBranch `magenta` `GitBranch.ts:35`, Context % `blue` `ContextPercentage.ts:23`, Tokens Input `blue`, Output Style `cyan`), overridable per widget (`widget.color`, `widget.backgroundColor`, `bold`). Powerline mode with a named theme: BY POSITION — widget i (merged widgets share one index) takes `theme.fg[i % n]` and `theme.bg[i % n]` (`src/utils/renderer.ts:190-208`, n = 5 for every bundled theme). No state/threshold colouring in the renderer.
2. Themes (powerline only): 11 entries in `POWERLINE_THEMES` (`src/utils/colors.ts:273-430`): Custom, Nord, Nord Aurora, Monokai, Solarized, Minimal, Dracula, Catppuccin, Gruvbox, One Dark, Tokyo Night. Format = two parallel arrays `{fg:[5], bg:[5]}` per colour level (keys `1`=ansi16, `2`=ansi256, `3`=truecolor, e.g. Nord truecolor bg `88C0D0,4C566A,5E81AC,B48EAD,A3BE8C`). Not semantic roles. "Custom" uses each widget's own colours; the TUI `(c)` key copies a theme's colours into the widgets so they become user-editable (`PowerlineThemeSelector.tsx:42-85`). Users cannot add a named theme except by that copy-to-custom path.
3. Colour spec: names (16 + bright), `ansi256:N`, `hex:RRGGBB` (`colors.ts` getChalkColor). Depth is a SETTING, not detected: `colorLevel` default 2 (256) (`src/types/Settings.ts:45`), applied as `chalk.level = settings.colorLevel` (`src/ccstatusline.ts:92`); each named colour has distinct ansi16/ansi256/truecolor values (e.g. red = chalk.red / 160 / #cc0000). Level 0 = no colour. NO_COLOR not read.
4. Fill: both. Non-powerline foreground-only by default, optional per-widget background; powerline mode is background-filled cells.
5. Separators: powerline arrows (``/`` right, `` `` left, thin variants, `src/utils/powerline.ts:30-33`), user-chosen list cycling per position (`separators[min(globalIndex, last)]`, renderer l.340); `separatorInvertBackground` flags; start/end caps (`startCaps`, `endCaps`). Colour of an arrow = fg is the previous widget's bg (converted `bgToFg`), bg is the next widget's bg (renderer l.346-420); cap fg = adjacent widget's bg (l.281). Non-powerline: plain-text separator widget.
6. Neighbours: powerline bg cycle through the 5 theme colours; separators blend the two.
7. Contrast: hand-paired fg per theme slot (e.g. Nord slot 0 black on `88C0D0`, slot 1 white-ish on `4C566A`); `overrideForegroundColor` forces one fg for all (renderer l.211). No automatic contrast calculation, no light/dark detection (Minimal and Solarized are dark-ish presets).
8. Glyphs: Nerd/Powerline font required for arrows; installs powerline fonts via `PowerlineSetup.tsx` / `PowerlineFontStatus.ts`; emoji in widget labels.
9. Other: Ink React TUI with live preview (`StatusLinePreview.tsx`), per-widget bold, global override fg/bg, `inheritSeparatorColors` (Settings.ts:48). No gradient in this snapshot (parent added one later).
10. Customisation: JSON settings written by the TUI, `~/.config/ccstatusline/settings.json`; TUI only for colours.

## robin-sm/claude-usage-statusline
https://github.com/robin-sm/claude-usage-statusline — stars 0 — FORK OF Greg-Klein/claude-usage-statusline
Differences only (diff `statusline.sh` against parent: 1 line differs, `statusline.sh:83`): the closing `]` of the bar is drawn after an explicit `RESET` then `DIM` (`printf '%s[%s%s%s%s%s]%s' "$DIM" "$color" "$filled" "$SPENT" "$blank" "$DIM" "$RESET"`), the parent resets before re-applying DIM. Styling model is otherwise the parent's, recorded here for reference: bar colour by used %, 256-index green 46 / yellow 226 / red 196 at `CLAUDE_BAR_WARN`=60 / `CLAUDE_BAR_CRIT`=85 (l.40, 66-70); unfilled cells in 256-grey 235 (`SPENT`, l.58); model cyan, dir/eta dim; braille `⣿`/`⡇` glyphs or `CLAUDE_BAR_STYLE=blocks` (`▉▌`); chosen 256-codes deliberately instead of ANSI 30-37 because themes remap the base colours (comment l.36-39). No themes, foreground-only, no NO_COLOR. `preview.sh` is in the fork; parent's presence of it was not checked.

## robotnealan/claude-burritos
https://github.com/robotnealan/claude-burritos — stars 0
1. By threshold on one segment, fixed on the rest. `statusline.sh`: context token count coloured by absolute tokens: <50k bright-black `\033[90m`, <100k green `32`, <200k orange 256-208, else red `31` (l.52-57). Energy-equivalent text yellow `33`, volume text light-blue `96` (l.84-85). Branch/dir uncoloured.
2. Themes: not present.
3. Colour: ANSI-16 plus one 256 (208). No detection, no NO_COLOR.
4. Fill: foreground only.
5. Separators: plain ` · ` and `@`.
6. Neighbours: the two joke metrics have different colours; ctx separated by `·`.
7. Light/dark: not present.
8. Glyphs: emoji (the `junkfood-items.sh` table of ~100 food/drink units, e.g. 🌯, 🥤; picked per session by `cksum` of the transcript path, l.62-67).
9. Other: the per-session random unit is the only decorative variety.
10. Customisation: edit script/items file.

## Rockelbel/claudecode-status
https://github.com/Rockelbel/claudecode-status — stars 0
1. One accent for everything it colours. `src/templates/status-bar.template.sh`: model name uses `C_ACCENT` (l.192); all other text `C_GRAY` 245; context bar filled cells use `C_ACCENT` (`█`/`▄`, l.178-180), empty `C_BAR_EMPTY` 238 `░`. No state/threshold colours.
2. Themes: not a theme system; an installer-chosen accent (`COLOR="[[COLOR]]"`, l.9) from a table of 9 named 256-codes: orange 173, blue 74, teal 66, green 71, lavender 139, rose 132, gold 136, slate 60, cyan 37 (l.25-35); unknown name = grey. Users pick one at install.
3. Colour: ANSI 256 (`38;5;N`). No detection, no NO_COLOR.
4. Fill: foreground only.
5. Separators: plain ` | ` in grey.
6. Neighbours: only the grey separator; model is accent, rest grey.
7. Light/dark: not present; the 245/238 greys assume a dark background.
8. Glyphs: emoji (📁 etc.) and block bar; optional modules git, project type, CLAUDE.md, time, system, cloud toggled at install (`SHOW_*`, l.11-16).
9. Other: nothing notable.
10. Customisation: installer prompts that substitute `[[...]]` placeholders in the template; edit script afterwards.

## RocketPartners/rocket-ccstatusline
https://github.com/RocketPartners/rocket-ccstatusline — stars 0 — FORK OF sirmalloc/ccstatusline
Differences only. This fork is an older snapshot of the parent (pushed 2025-11-17) and has no styling features of its own that the older parent lacks: same 11 powerline themes in the same 5-slot fg/bg format (`src/utils/colors.ts:268-430`: Custom, Nord, Nord Aurora, Monokai, Solarized, Minimal, Dracula, Catppuccin, Gruvbox, One Dark, Tokyo Night), same position-cycle assignment, same arrow/cap logic. Versus the current parent it lacks: the gradient colour specs (`gradient:` specs, `applyGradientToText`), the `dim: 'parens'` option, and ansi16-mode suppression of 256/hex colours — none exist in `rk-colors.ts`. It composes SGR through chalk wrappers (`getChalkColor(...)(text)`, bg then fg then bold) where RobGruhl's and the parent's later code write raw escapes with explicit 49/39/22 resets. Colour depth is still a stored setting rather than detected; NO_COLOR not read. Compared by diffing `colors.ts`/`powerline.ts`/`renderer.ts` against RobGruhl's older snapshot and the parent's current files.

## RockInMars/claude-statusline
https://github.com/RockInMars/claude-statusline — stars 0
1. Fixed per segment, threshold for context. `statusline.sh`: model bold + provider magenta (l.345), project blue (l.352), session name dim, git branch cyan, staged `+N` green, modified `~N` yellow, untracked `?N` dim (l.280-289), token/cost/output-style dim (l.425-440). Context percentage: >=90 red, >=70 yellow, else green (l.318-324).
2. Themes: not present.
3. Colour: ANSI-16 via `tput setaf 1-6` when tput supports colour (l.9-21), fallback to raw `\033[0;3xm` (l.24-32). Output through `printf %b`. No NO_COLOR.
4. Fill: foreground only.
5. Separators: dim `│` (`SEP`, l.36).
6. Neighbours: distinct hue per segment kind + dim pipe.
7. Light/dark: uses `tput dim`/bold and the terminal's palette; no adaptation.
8. Glyphs: mostly plain text; one box glyph.
9. Other: two-line layout (line1 identity, line2 tokens/cost/style).
10. Customisation: edit the script; README documents fields.

## Roflochinsky/beads-hud
https://github.com/Roflochinsky/beads-hud — stars 0
1. By state/threshold on usage, fixed on the rest. `bin/statusline.sh`: `tone()` maps a percentage: >=85 red, >=60 amber (`33`), else green (l.27-29), applied to ctx, 5h and week percentages (l.97-103). Beads issue counts: ready green, in-progress amber, blocked red (l.82-84). Labels `bd`, `ctx`, `5ч`, `нед`, cost `$` dim; model bold, effort dim (l.100-104).
2. Themes: the terminal statusline has none. The companion web dashboard (`public/beads-hud.js:65-72`) has a light/dark toggle persisted in `localStorage('beadshud.theme')` via `dataset.theme` — unverified beyond that toggle (stylesheet not read).
3. Colour: ANSI-16 escapes (l.8-9). No detection, no NO_COLOR.
4. Fill: foreground only.
5. Separators: dim ` │ ` (l.10).
6. Neighbours: dim pipes and dim labels in front of coloured values.
7. Light/dark: none in the shell line.
8. Glyphs: Cyrillic labels, no icons.
9. Other: a local web server (`server.mjs`, `bin/up.mjs`, `bin/open.mjs`) serving a HUD page — not a styling feature of the statusline.
10. Customisation: edit script; installer `bin/install.mjs`.

## rogeriodeandradepires/usageline
https://github.com/rogeriodeandradepires/usageline — stars 0
1. Fixed per provider, threshold for percentages. `lib/segment.mjs`: each third-party provider (DeepSeek, Kimi, GPT, Gemini, Ollama) has a fixed label colour: `TALLY_META` kimi magenta, openai blue, ollama dim-green, gemini yellow, other dim (l.8-11, 128-133); the compact "all" line uses 256-codes Kimi 81, DS 75, GPT 114, Ollama 176 (`COMBINED_META` l.55-58). DeepSeek balance: red below `lowBalance`, yellow below 5x, else green (l.24, 148). Quota percentages (`pctColor`): >=90 red, >=70 yellow, else green (l.165-167). Value fields use fixed 256 codes borrowed from ccstatusline: tokens 81, requests 176, reset countdown 116 (l.160-163). Labels dim 245, provider separator 238 (l.61-62). It is an add-on line for non-Anthropic provider spend, run through ccstatusline's custom-command.
2. Themes: not present.
3. Colour: names ANSI-16 or 256-index numbers (`ansi(color, text)`, `lib/core.mjs:108-113`; `ANSI_CODES` red 31 … `dimGreen` `2;32`). Honours NO_COLOR (`core.mjs:109`). No depth detection.
4. Fill: foreground only.
5. Separators: dim ` | ` between providers (238).
6. Neighbours: per-provider hue + dim grey separator.
7. Light/dark: none; greys 238/245 assume dark.
8. Glyphs: text labels (DS, KIMI, GPT); no icons.
9. Other: layout modes (combined line vs one line per provider).
10. Customisation: JSON config via `loadConfig` (`lib/core.mjs`), CLI `bin/usageline.mjs`; no colour options.

## RomanDenysov/claude-toolkit
https://github.com/RomanDenysov/claude-toolkit — stars 0
1. Fixed per segment (hard-coded Tokyo Night), model by name, threshold for context. `statusline/statusline.sh:4-12` truecolor fg palette: red `f7768e`, yellow `e0af68`, green `9ece6a`, cyan `7dcfff`, blue `7aa2f7`, purple `bb9af7`, grey `565f89`, white `a9b1d6`. Directory: parent grey + leaf purple (l.25); git branch cyan, clean ✓ green, dirty ✗ red, unpushed ↑ yellow, worktree ⎔ blue (l.36-56); model icon by family: opus ◆ purple, sonnet ◇ blue, haiku ○ cyan, other ● white (l.65-82); context % and bar: >80 red, >60 yellow, else green, empty cells grey (l.131-148); tasks yellow/white, MCP count cyan, cost yellow; separators grey `│`.
2. Themes: the statusline is Tokyo Night only. The theme names the scanner saw (catppuccin, gruvbox, nord) belong to the other tools in the repo (`tmux-usage`, `ghostty-notify`), which I did not read; unverified for those.
3. Colour: truecolor only (`38;2;r;g;b`), no ANSI fallback, no detection, no NO_COLOR.
4. Fill: foreground only.
5. Separators: grey `│` (l.56, 92, 150).
6. Neighbours: different hues per segment + grey pipes.
7. Light/dark: none (Tokyo Night dark palette; `565f89` grey assumes dark).
8. Glyphs: Unicode symbols ◆◇○●⎔✓✗↑ and emoji ⏳📋⚡⏱; no Nerd Font.
9. Other: the same repo also ships a tmux usage bar and a Ghostty notifier.
10. Customisation: edit the script; per-tool `install.sh`.

## romular21/cc-probeline
https://github.com/romular21/cc-probeline — stars 0 — FORK OF labzink/cc-probeline
Differences only (compared `internal/renderer/theme.go`, `progressbar.go`, `config/colors.go`):
- Added palette roles `Amber` (256-179) and `Sage` (256-108) in `internal/renderer/theme.go:62-73` — the parent has neither. They colour the calm/notice bands of values drawn as text rather than bars (`internal/probes/bar.go:62-79`: red -> `Red`, orange -> `Orange`, amber -> `Amber`, healthy -> `Sage`), because ANSI yellow/green read as "acid" on a bare number.
- New file `internal/config/colors.go` (absent in the parent: 404): a `[colors]` table lets the user repoint 8 roles (green, sage, amber, yellow, orange, red, cyan, magenta) with `"#rrggbb"` (emitted as truecolor `38;2`) or raw SGR parameters like `"38;5;179"` (emitted verbatim); invalid values are skipped; derived bold combos follow their base (l.1-110). `SetColor` writes it via `cc-probeline config set` (`config_set.go`).
- `bar_style` option (`config/config.go:146-157`): block | line | low | dot | none; `ProgressBarN` adds an n-segment bar (`progressbar.go:155-200`); `effort_style` glyph|word.
Shared with parent for reference: default 16-colour ANSI palette so it reads on any terminal theme (`theme.go:46-52`), orange 208 the lone exception; colour by state (context bar `<50` green, 50-69 yellow, 70-89 orange, >=90 red, >95 bold red, `probes/ctx.go:30-34`; branch cyan; effort high/xhigh/max magenta; cost >90% budget bold red); NO_COLOR honoured (`renderer/ansi.go` `DetectAnsi`: any non-empty value disables; colour is ON through a pipe by default); Nerd Font a config flag (`nerd_font`); fg-only; `{{color:NAME}}` marker templates stripped when ANSI disabled.

## ronalove/ccfaststatus
https://github.com/ronalove/ccfaststatus — stars 0 (Rust, ratatui config TUI)
1. Fixed per segment, via a theme. `src/main.rs:134-375` assigns each segment a theme slot: time `bg_time`, model `bg_model`, folder `bg_folder`, git `bg_git`, context `bg_ctx`, 5h limit `bg_limit_5h`, 7d limit `bg_limit_7d`; text `tx_white` on time/model/folder/limits, `tx_dark` on git and context (l.159-357). Segment bg is the same slot regardless of state; context percentage has no threshold colour (the braille context bar is white cells on `ctx_empty`, `format.rs:75-97`). Only the `bullet` skin colours by state: continuous green→yellow→red gradient `pct_color` (`skins/bullet.rs:8-22`: below 50% red rises 0→255 with green 200; above 50% green falls 200→80).
2. Themes: 6 bundled, selected by name (`src/theme.rs:20-130`): m365princess (default; purple→pink→orange→light-blue→steel-blue ramp), catppuccin, tokyo-night, gruvbox, nord, dracula. Format = struct of 7 background RGB slots + 3 text colours (white/dark/gray) + `ctx_empty` — a per-segment colour map, not semantic roles. Unknown name falls back to m365princess. No user-defined themes (only the six; the TOML takes a name, `settings.rs:89-93`).
3. Colour: truecolor RGB only (`38;2`/`48;2` via `fgc`/`bgc`, `term.rs`). No ANSI fallback, no depth detection found, NO_COLOR not read.
4. Fill: background-filled cells for the powerline and rounded skins; foreground-only for minimal/pipe/bullet/rainbow (those use `seg.bg` as a text colour, `skins/minimal.rs:19`).
5. Separators (skin, orthogonal to theme: `[skin] name`, `skins/mod.rs:60-69`): `powerline` ``, `rounded` (left cap `` first, `` between, `` end, `rounded.rs:23-41`), `minimal` ` · `, `pipe` ` | `, `bullet` `●` dots, `rainbow` (minimal body with a six-square rainbow prefix `■` in fixed RGB, `skins/rainbow.rs:5-12`). Powerline arrow: fg = current segment bg, bg = next segment bg; last arrow fg = last bg on terminal bg (`segments.rs:44-70`).
6. Neighbours: each segment has its own hue in the theme (m365princess is a deliberate hue ramp, other themes use palette colours); arrows blend.
7. Contrast: hand-assigned per slot: dark text on light backgrounds (git, ctx), white text elsewhere, in each theme (`tx_dark` is the theme's base colour, e.g. catppuccin `(30,30,46)`). No computed contrast, no light/dark detection (all six themes are dark).
8. Glyphs: Nerd Font required (nf-md icons `config.rs:18-31`, Powerline separators `E0B0/E0B6/E0B4`); priorities drop segments on narrow terminals.
9. Other: rainbow prefix skin; priority-based truncation (`fit_segments`) when the width is short.
10. Customisation: `~/.config/ccfaststatus/config.toml` (`[theme] name`, `[skin] name`, segment toggles), ratatui TUI launched when run in a terminal (README l.50), docs `docs/plans/2026-04-18-v0.5-themes-skins-plan.md` (unread).

## routerr/aubar
https://github.com/routerr/aubar — stars 0
not a Claude statusline: a Go TUI/tmux status bar showing remaining quota for AI CLIs (OpenAI Codex, Anthropic Claude, Google Gemini); GitHub description "A TUI status bar to show the remaining quota for AI CLIs". It is not driven by Claude Code's statusLine hook. For the record, styling is a hard-coded Catppuccin Mocha hex set emitted as tmux `#[fg=#rrggbb]` markup (`internal/render/banner.go:13-23`) with a percent-band colour ramp (<20 pink, <40 maroon, <50 peach, <70 yellow, <80 green, else teal, `percentColor` l.177-193), and a config `theme {name, dark_mode}` (`internal/config/settings.go:47`, read at l.198).

## rperez93/claude-progress
https://github.com/rperez93/claude-progress — stars 0 (PyPI package `cc-progress`; bash + jq engine)
1. By state. `bin/cc-progress` jq template (the file the scanner listed, `cc_progress/__init__.py`, only launches it; the engine was read at `cc_progress/bin/cc-progress`): running bar fill green `32`, icon/tone cyan `36` while running or yellow `33` when stalled; done = bold green `1;32` tone with green fill; failed = bold red `1;31` with red fill (l.333-334); percentage bold; stall text yellow (l.367); empty cells and notes use a muted colour (`$muted` = `CC_PROGRESS_MUTED`, default not read).
2. Themes: not present (by design: "Colours are the terminal's ANSI roles ... never fixed values, so the bar follows whatever theme the terminal uses", README l.88-89).
3. Colour: ANSI-16 roles only (comment l.276-277). `NO_COLOR` honoured: colour is off if `NO_COLOR` is set or stdout is not a tty in the CLI path (l.413, 453); env table README l.216.
4. Fill: foreground only.
5. Separators: a `─` rule closing the progress block; `›` note marker.
6. Neighbours: not applicable (stacked rows, label column padded).
7. Light/dark: relies entirely on the terminal's 16-colour palette.
8. Glyphs: fractional block bar `█▏▎▍▌▋▊▉░`, braille spinner `⠋⠙…`, `✔✘▶`; `CC_PROGRESS_ASCII=1` switches to `# - | / \ + x >` (`G` table, l.285-290).
9. Other: animation — one frame per poll (statusline `refreshInterval` 1 s), spinner and a "scanner" sweep bar for unknown totals (l.296-303); ETA/stall detection is the product.
10. Customisation: env vars `CC_PROGRESS_*` (DIR, KEEP_DONE, STALE_HIDE, PRUNE_AFTER, MUTED, ASCII, SESSION, HOOK_LOG); no config file.

## rquintino/claude-code-xtras
https://github.com/rquintino/claude-code-xtras — stars 0
1. By threshold on most; fixed on the rest. `statusline/statusline-command.sh`: context % >=80 red, >=50 yellow, else green (l.120-122), `⚠` + red when over the 200k cliff (l.126); effort: max bold red, xhigh red, high yellow, medium/low dim (l.137-140); usage pct 80/50 red/yellow/green (l.173-175); projected pace >=115 red, >=85 green, else cyan (l.253-255); PR review state approved green, changes_requested red, pending yellow (l.269-271); lines +N green / -N red (l.284); model bold bright-cyan `1;96` (l.291); token breakdown fixed: input yellow, cached green, cache-write red, output magenta (l.417-420); big-request estimate over $0.50 bold red (l.526); platform marker green ●. PowerShell twin `statusline.ps1` kept in parity by `test-parity.sh`.
   Plugin `mods/statusline-hud/hooks/present.ts` re-expresses this as data with semantic role names: `pctColor` returns `'error'|'warning'|'success'` (>=80/>=50) and `projColor` `'error'|'success'|'cyan'`, big context `'error'` (l.47-53, 200) — roles resolved by the Claude Code mod host, not by this code.
2. Themes: not present in the shell script; the mod path uses the host's semantic roles (error/warning/success), so it follows whatever theme the host applies (host-side behaviour unverified).
3. Colour: ANSI-16 `\033[3Xm` plus bold/dim/`1;96`; no depth detection; no NO_COLOR.
4. Fill: foreground only (one `1;30;<n>m` combo for a last-call estimate, l.524).
5. Separators: plain text ` · ` (mod: `SEP` dim ` · `, present.ts l.40) and `|`.
6. Neighbours: dim separators plus per-field hue.
7. Light/dark: not present.
8. Glyphs: emoji and Unicode (⚠ ● and others); no Nerd Font.
9. Other: multi-line (up to 6 lines: identity, tokens, last call, compaction, version); cost model per token category.
10. Customisation: edit script; the mod has its own plugin.json hooks.

## rsurasin/claude-statusline
https://github.com/rsurasin/claude-statusline — stars 0 (Go)
1. Fixed per segment, threshold for usage. `main.go:21-30` ANSI-16 constants; model name bold blue (l.108), agent `@name` magenta (l.113); context "Nk/Nk N%" and 5h/7d/extra: <50 green, >=50 yellow, >=80 red (`format.go:22-32, 68-75, 124-134`) with the number in bold; 5h circle bar fill cyan, 7d fill blue (`main.go:150-153`), empty circles dim. Embedded starship modules are re-emitted from starship's own output (`starship.go`).
2. Themes: not present; comment says it follows terminal palettes (base16, catppuccin, nord) because only ANSI-16 is used, "no hardcoded RGB" (`main.go:18-19`).
3. Colour: ANSI-16 SGR; "dim" is actually bright-black `90` (l.23). No depth detection, no NO_COLOR.
4. Fill: foreground only.
5. Separators: dim ` | ` (l.104, 140).
6. Neighbours: pipes; 5h and 7d bars take different hues.
7. Light/dark: relies on terminal palette; deliberately avoids the `2` dim attribute for better behaviour under terminals and tmux.
8. Glyphs: `●`/`○` five-circle bar, 20% each; no Nerd Font.
9. Other: starship integration (reads starship module output for the git/dir section).
10. Customisation: Go source; starship config is the user surface.

## ryanjao/claude-code-statusline
https://github.com/ryanjao/claude-code-statusline — stars 0
1. Threshold for usage, fixed otherwise. `statusline.sh`: context/usage bars: >=85 red, >=70 orange (256-208), >=50 yellow, else green; filled cells and the percentage take the colour, empty cells dim (l.44-60, 198-208). Model bold (+ dim context size) (l.128), git branch magenta + dirty `*` yellow (l.96-98), `+N` green / `-N` red (l.101), project name cyan, dirty-file count yellow, others dim (l.168-179). Alerts: knowledge-sync warnings dim/yellow/red (l.155-161).
2. Themes: not present.
3. Colour: ANSI-16 via `$'\e[3Xm'` plus 256-208 orange (l.11-19). No detection, no NO_COLOR.
4. Fill: foreground only.
5. Separators: dim `|` (l.128, 184).
6. Neighbours: hue per field, dim pipes.
7. Light/dark: not present.
8. Glyphs: braille/box bar, a few emoji, CJK text labels (the file is largely Traditional Chinese); `✚`.
9. Other: multi-provider quota block with dots (`build_dots`, l.237) for Claude/Codex/Grok.
10. Customisation: `STATUSLINE_PREFIX` env var; otherwise edit the script.

## s112076649/agent-tree
https://github.com/s112076649/agent-tree — stars 0
1. Fixed per role, text only. `plugins/agent-tree/hooks/render/theme.ts:7-13`: `COLORS` = main `#f0883e` (orange), sub `#58a6ff` (blue), advisor `#bc8cff` (purple), jev `#56d364` (green), fail `#f85149` (red). A finished row is drawn dim, not in its own colour (comment l.1-3); row tone is `run|done|fail` (`render/text.ts:10`, `toneOf` l.126). So colour = agent role, dim = finished, red = failed.
2. Themes: not present; the file's header says colours are "text colors only, no backgrounds, so a light theme stays readable".
3. Colour: truecolor hex only, emitted as `38;2;r;g;b` (`statusline/hud-print.mjs:38-45`); bold/dim/reverse (`b`,`d`,`i` flags = `1`,`2`,`7`). The Ink pane path hands hex to the host's `Text`. No detection, no NO_COLOR.
4. Fill: foreground only by design.
5. Separators: a dim `SEP` string from `stats` (not read); box-drawing connectors in the pane (`boxes/connectors.tsx`).
6. Neighbours: role colours + boxes/connectors.
7. Light/dark: explicitly avoids backgrounds so light themes work; hex values are mid-tone GitHub-style colours that read on both. No contrast calculation.
8. Glyphs: box-drawing characters for a tree/pane; a few emoji.
9. Other: this is a Claude Code mod that draws a live agent-tree pane; the statusline script (`agent-tree-statusline.mjs`) only prints HUD runs as ANSI. Elapsed-time runs tick (`since` runs formatted by `formatDuration`), no styled animation.
10. Customisation: none seen for colours; colours are constants in `theme.ts`.

## saharkit/windowsill
https://github.com/saharkit/windowsill — stars 0
Mostly not a statusline repo (monorepo of plugins: voice-loop, sill-core, agent-handbook, merge-queue …); the statusline part is `plugins/agent-statusline/statusline.js` (102 lines), so styled as follows.
1. By threshold. `statusline.js:14-31`: context segment (glyph `◐` + "ctx Nk/Nk (N%)") coloured by REMAINING %: >50 green, >=20 yellow, else red; weekly rate-limit " wk N%" by used %: >85 red, >60 yellow, else green; "/5h N%" dim; model name dim (l.63-82).
2. Themes: not present.
3. Colour: ANSI-16 (`\x1b[31m/32m/33m`, dim `2`). No detection, no NO_COLOR.
4. Fill: foreground only.
5. Separators: spaces only.
6. Neighbours: not distinguished beyond colour of the leading segment.
7. Light/dark: not present.
8. Glyphs: `◐` only.
9. Other: `settings-edit.js` edits settings.json to install; the scanner's gradient hits come from other plugins in the repo, not the statusline.
10. Customisation: none.

## sainteye/claude-bestiary
https://github.com/sainteye/claude-bestiary — stars 0
1. Per project, by hash-and-registry; state colours on metrics. `statusline.py`: each project gets a generated 5x4-pixel creature (half-block `▀▄` cells) whose colour is a HSL hue from `HUES` (16 hues around the wheel `[8,28,45,…,330]`, l.38) in one of two tones `TONES` (vivid and "chalk", l.41): chosen the first time the project is seen as the (hue,tone,shape) least like all registered ones (hue gap maximised, then tone, l.262-292) and stored in `~/.claude/project-icons.json`, editable. The rest of the line is derived from that accent: `soft` (path, branch, HSL s<=.26-.30, l .56-.58), `faint` (model, cost, l .42-.44), `text` (what it is doing, l .84) (`palette()` l.104-114, `text_palette()` l.97-101). Metrics override: context % >=85 red, >=65 yellow, else green (l.1406); 5h/7d >=85 red, >=60 yellow else faint (l.1416); git conflict yellow; errors red.
2. Themes: not a theme system; "theme" = per-project accent (16 hues x 2 tones = 32 slots). Users can hand-edit hue 0-15 / tone / hand-drawn pixel art in the registry (art with palette hex, `art_cells` l.147-165).
3. Colour: truecolor fg/bg (`38;2`/`48;2`, l.119-123) plus ANSI-16 for alerts. Honours NO_COLOR (l.47, every `fg/bg/paint` returns plain text). No depth detection.
4. Fill: both — creature uses fg+bg half-blocks; text is fg only.
5. Separators: two spaces between env parts, `·` inside; no powerline.
6. Neighbours: by distance: derived tints of one accent for text, plain alert colours for metrics.
7. Light/dark: assumes a dark background (comment l.40-43: lightening and desaturating rather than darkening because darker tones are unreadable on dark); no light-mode path found. Text lightness is fixed per role, not computed against a background.
8. Glyphs: emoji set `EMOJI` (30 animals) as fallback, half-block pixel art, `⎇` branch; OSC 8 hyperlinks (`osc8`, disabled under NO_COLOR).
9. Other: unusual — identity by colour: each project window has its own colour so you can tell windows apart; preview renderer `tools/render-statusline.py`, `tools/render-bestiary.py`; width-aware truncation that steps over ANSI (l.1271).
10. Customisation: `project-icons.json` registry (hue, tone, shape, art), options `show_cost`/`show_limits`; `project-icons.example.json`; no theme file.

## sam-david/context-usage-bar
https://github.com/sam-david/context-usage-bar — stars 0
1. By threshold, one colour for the whole line. `statusline.sh:18-27`: context % >=90 red `\033[31m`, >=70 yellow `33`, else green `32`; the bar (20 cells `▓`/`░`) is the only coloured part; `NN% · model · $cost` is uncoloured after the bar reset (l.29).
2. Themes: not present.
3. Colour: ANSI-16. No detection, no NO_COLOR.
4. Fill: foreground only.
5. Separators: plain ` · `.
6. Neighbours: not applicable.
7. Light/dark: not present.
8. Glyphs: `▓░` only.
9. Other: nothing.
10. Customisation: edit script (48 lines).

## samanthvittal/cc-catppuccin-statusline
https://github.com/samanthvittal/cc-catppuccin-statusline — stars 0
1. Fixed per segment, via Catppuccin roles, with threshold on context. `status-line.sh:109-124`: model LAVENDER, git branch MAUVE, dirty `*` PEACH, folder TEAL, session time SUBTEXT, separator OVERLAY ` ● ` (`SEP`, l.110). Tokens and context % share a colour by usage: >70 RED, >50 YELLOW, else BLUE; zero state OVERLAY (l.76-92).
2. Themes: 4 bundled — the Catppuccin flavours Mocha, Macchiato, Frappe, Latte — as `themes/<flavor>.sh` files that define 10 variables (BLUE, RED, TEAL, MAUVE, LAVENDER, PEACH, GREEN, YELLOW, OVERLAY, SUBTEXT) as truecolor fg, e.g. Mocha BLUE `#89b4fa`, Latte BLUE `#1e66f5` (themes/mocha.sh, latte.sh). Format = semantic role names (the Catppuccin palette's), so the script uses roles, not colours. `switch-theme.sh <flavor>` copies the chosen file to `theme.sh`; takes effect on restart. Users can add a theme by writing a file with those 10 variables (the script sources `theme.sh`, l.8-14; falls back to frappe).
3. Colour: truecolor fg only (`38;2;r;g;b`). No ANSI fallback, no detection, no NO_COLOR.
4. Fill: foreground only.
5. Separators: ` ● ` in OVERLAY grey-violet.
6. Neighbours: different pastel hue per segment + dot separators.
7. Light/dark: Latte flavour is the light variant (darker saturated foregrounds, e.g. TEAL `#179299`, YELLOW `#df8e1d`), selected manually, not auto-detected. No computed contrast.
8. Glyphs: Nerd Font icons (``, `` branch, `` folder, `` database, `` pie chart, `` clock; l.29-34). No ASCII fallback.
9. Other: nothing beyond the four flavours.
10. Customisation: `switch-theme.sh`, `install.sh`; theme file variables.

## samgilletgaras/claude-code-terrarium
https://github.com/samgilletgaras/claude-code-terrarium — stars 0
1. By state. `statusline.sh`: the face + quip line coloured by context % (>=80 red, >=50 yellow, else green, l.41-47). A "scene" row of emoji-like plants each take a health colour by a count (git `♣`, brain-dump `✿`, todo `△`, inbox `o`): 0-2 green, 3 yellow, >=4 red (l.563-610); grass green (l.615); dim for the rest.
2. Themes: not present.
3. Colour: ANSI-16 only. No detection, no NO_COLOR.
4. Fill: foreground only.
5. Separators: none; scene is a character row.
6. Neighbours: a fixed set of glyphs coloured by their own counts.
7. Light/dark: not present.
8. Glyphs: emoji faces, `♣✿△` plant glyphs.
9. Other: a "terrarium" mood/quip game — decoration, day-of-week dependent text.
10. Customisation: edit script.

## samir-abis/cc-minimax-status
https://github.com/samir-abis/cc-minimax-status — stars 0
1. By threshold, one segment. `statusline.sh:33-40`: `color_for` — used % <40 green, <60 yellow, else red, applied to the "MiniMax: <quota>" text (l.108-112). Nothing else coloured.
2. Themes: scanner saw `theme.key` in `opencode/minimax-status.tsx`; that file (an OpenCode TUI plugin) was not read — unverified.
3. Colour: ANSI-16. No detection, no NO_COLOR.
4. Fill: foreground only.
5. Separators: not present (single segment).
6. Neighbours: not applicable.
7. Light/dark: not present.
8. Glyphs: one emoji in package metadata only.
9. Other: nothing.
10. Customisation: install script and `package.json` bin; no colour options.

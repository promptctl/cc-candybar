## claude-foot (sanchez314c/claude-foot)
https://github.com/sanchez314c/claude-foot , stars 0
1. By state/threshold plus fixed per segment. `clawdfoot.sh:195,200` hard-wires: model bold CYAN, in-tokens `↑` GREEN, out-tokens `↓` YELLOW, cost CYAN, time DIM, project MAGENTA, branch CYAN, `~N` dirty YELLOW / `clean` GREEN, ports/agents DIM. Context bar colour by threshold (`:104-112`): >=90 RED "CRITICAL", >=70 RED "RUNNING HOT", >=50 YELLOW, else GREEN (25-49 "WARMED UP", <25 "FRESH"). CPU and RAM colour: >=80 RED, >=50 YELLOW, else GREEN (`:152-175`).
2. Themes are sourced shell files that redefine 8 variables (RED YELLOW GREEN CYAN MAGENTA DIM BOLD RESET). Bundled in `themes/`: `default.sh` (ANSI-16), `neon.sh` (256-colour: 196/226/46/51/201), `monochrome.sh` (everything `\033[37m`, CYAN = bold white). Selected via `CLAWDFOOT_THEME`, directory via `CLAWDFOOT_THEME_DIR` (`clawdfoot.sh:43-48`). Users add a theme by dropping a `.sh` file. The colour names are hues, not roles: a theme remaps what "GREEN" is, not which segment uses it.
3. ANSI 16 (`\033[3Xm`) by default, 256-index in `neon.sh`. No depth detection, no NO_COLOR (grep of `clawdfoot.sh` finds neither).
4. Foreground-only text; no background fills.
5. Plain text separator `SEP="${DIM}|${RESET}"` (`:60`). Bar is ASCII `#` and `-` (`:123-124`).
6. Neighbours are told apart by the dim `|` and by differing hues of fixed segments.
7. Not present (monochrome theme is the only concession). No contrast logic.
8. ASCII only. No icons, no Nerd Font (`↑ ↓` arrows only).
9. Two-line output. Mood word attached to the context bar ("FRESH" ... "CRITICAL").
10. Env vars `CLAWDFOOT_THEME`, `CLAWDFOOT_THEME_DIR`; theme files are shell snippets; installer scripts.

## token-count (sanket-gangani/Token-Count)
https://github.com/sanket-gangani/Token-Count , stars 0
1. No colour in the statusline. `src/statusline.ts:41-49` joins plain strings: `🔥 <tokens> today · $x api-eq · ≈water`, with optional leading `<n> session`. Segment colour: not present.
2. Not present for the statusline. `src/config.ts` has `theme?: "dark"|"light"` but it only drives the web dashboard (`web/src/App.tsx:58-76` toggles `data-theme`, persisted in localStorage). Config is `~/.tokenburn/config.json`.
3. The CLI helpers in `src/format.ts:39-48` emit 256-index codes (ember 208, blue 75, green 114, gray 245) and are gated by `process.stdout.isTTY && !process.env.NO_COLOR`; the statusline function never calls them, and a statusline stdout is not a TTY anyway.
4. Text only.
5. ` · ` plain text.
6. Separator only.
7. Not present in the statusline (dashboard has a light/dark toggle).
8. One emoji (🔥) and `≈`.
9. Web dashboard (Vite/React) with an SVG flame gradient (`#ffd27a` -> `#ff5a1f` -> `#c92d0a`, `App.tsx:23-27`); not statusline-related.
10. `~/.tokenburn/config.json` (footprint weights, theme); env `TOKENBURN_HOME`.

## claude-mods (Savo2610)
https://github.com/Savo2610/claude-mods , stars 0
Not a classic statusline: four German-language Claude Code mods (Function Hooks plugin API, early access): `cache-waechter`, `deploy-wacht`, `telegram-draht`, `werkbank` (`README.md`). They draw Ink `<Text>`/`<Box>` rows in the band under the prompt, not a `statusLine` command.
Styling facts that are visible: colours are Claude Code theme role names, never hex. `cache-waechter/hooks/register.tsx:108-110` `farbe(rest)` returns `'success'` while more than 15 min of prompt cache remain, else `'warning'` (comment: "so wenig Farbe wie moeglich"); cold-cache line uses `color="suggestion"` (`:906`), warning card uses `borderColor="warning"` (`:880`), "compressed" is `success` (`:895`); everything else is `dimColor`/`bold`. `deploy-wacht` status line is plain text (`statusText`, `register.ts:228`). Themes, depth, separators, glyph modes: not present (inherits Claude Code's theme).

## tokenforward (sayonsom/tokenforward)
https://github.com/sayonsom/tokenforward , stars 0
1. No colour. The statusline command (`scripts/tf.py:448-461`) prints one plain line: `TF [#####-----] 12k/40k etok 30% ~$0.12 | <phase>`, or `TF off`. Per-segment colour: not present.
2. Not present.
3. No escape codes in `tf.py` or `tf_plan.py` (grep finds none). NO_COLOR irrelevant.
4. Plain text.
5. Plain ` | `.
6. Separator only.
7. Not present.
8. ASCII bar (`#`/`-`).
9. The hex colours the scanner counted are in benchmark and ticket files, not the statusline.
10. Statusline is a subcommand `tf.py statusline` launched through `scripts/tf-launch.js`; no style options.

## scrothers/statusline
https://github.com/scrothers/statusline , stars 0
1. Theme role mapped to segments, plus threshold gradients. Roles: `Theme` struct in `internal/theme/theme.go:45-58`. Model icon uses a per-family colour (`segment/model.go:29-33`; `IdentityColorFor`: Opus=accent `#D97757`, Sonnet `#7B87D9`, Haiku `#6FAE8C`, Fable `#9B7EC4`, Mythos `#C97BA0`, unknown family falls back to IdentityAccent), label in `IdentityText`. Git branch colour is `Success`, or `Warning` when dirty (`segment/git.go:28-30`); badges staged/ahead `Success`, modified/behind `Warning`, untracked `Muted`, conflicts `Danger`. Context bar (`segment/context_window.go:61-77`) is a per-cell gradient by position: `threeStopGradient` in `segment/gradient.go` lerps Success -> Warning at 50% -> Danger, via `style.Lerp` (RGB per-channel, `style/color.go`). Over-limit: `Danger` bold. Track `TrackDim`, spacing `Muted`.
2. Two bundled themes only, `claude-dark` and `claude-light` (`internal/theme/themes/*.toml`, `names` in `theme.go:25`). Format = semantic palette of 15 hex tokens: identity_accent, identity_text, identity_opus/sonnet/haiku/fable/mythos, text_primary, text_secondary, success, warning, danger, info, muted, track_dim. No background token by design (comment `theme.go:36-39`). Users override single tokens with `[theme_overrides]` (`WithOverrides`, `config/types.go:13`; unknown token name is an error). The scanner's catppuccin/dracula/nord names are not shipped; the comment at `theme.go:22-25` says they were dropped.
3. Truecolor only (`style/paint.go:35` `38;2;R;G;B`). No downsampling. `NO_COLOR` honoured (`paint.go`, returns text unstyled). Terminal default colour is the zero Color (no escape emitted).
4. Foreground only; `Paint(text, fg, bg, bold)` can emit bg but `joinLine` passes `style.Default` for bg.
5. Plain-text divider with a Nerd Font glyph: `"    "` between segments, painted in `Muted` (`render/divider.go`, `render/render.go:52`). No filled powerline arrows.
6. Divider only; neighbours differ by the semantic colour of their content.
7. Light/dark adaptation: `claudetheme.Resolve` (`internal/claudetheme/claudetheme.go`) reads Claude Code's own `theme` from `.claude/settings.local.json`, `.claude/settings.json`, then `~/.claude/settings.json`, classifies dark/light(+daltonized, ansi), follows `custom:<slug>` themes through their `base`, and for `auto` reads `COLORFGBG` (default dark). So the palette follows Claude Code's theme choice; no per-colour contrast computation.
8. Nerd Font icons with fallback: `nerd_font = true` in `config/default.toml`, `theme.Glyph(icon, nerd)` in `theme/icons.go` swaps to non-Nerd glyphs; per-segment `icon` override in `[segments.<name>]`.
9. Hyperlinks (`style/hyperlink.go`), demo mode (`cmd/statusline/demo.go`), a `Lerp` gauge.
10. TOML config (`internal/config/default.toml`): `theme`, `theme_overrides`, `nerd_font`, `[[lines]]` with `segments = [...]`, per-segment `enabled`/`icon`; Cobra CLI.

## claude-statusline-bars (scubafly)
https://github.com/scubafly/claude-statusline-bars , stars 0
1. Threshold for bars, fixed for the rest. `claude-statusline-bars.sh:42-52` gives each of ctx, 5h and wk a 10-cell bar whose fill background is by percent: <50 `48;5;40` green with black text, <70 `154` yellow-green, <85 `220` yellow, <95 `208` orange, else `196` red with white text (`231`). Empty cells `48;5;238` bg with `38;5;250` text. Model/effort text fixed `38;5;110` (`:89`). Labels and suffixes `38;5;245`.
2. No themes. Palette is hard-coded in the script.
3. 256-colour indices only. No detection, no NO_COLOR.
4. Background fill in the bar cells (percentage text centred inside the bar); everything else foreground only.
5. `│` in `38;5;240`, joining left and right groups (`:35`, `:123`).
6. Separators only; bars differ from each other by label.
7. Chooses text colour per bar state by hand (black on green/yellow/orange, white on red, light grey on the empty track) so the number is readable across the range (comment `:38-41`). No terminal-background adaptation.
8. Box-drawing/block glyphs only.
9. Percentage printed inside the bar; reset time suffix `↻6d19h`.
10. Edit the script; no config.

## sdrik/claude-statusline
https://github.com/sdrik/claude-statusline , stars 0
Claude Code mod (plugin hooks, `hooks/register.ts`), not a `statusLine` command: draws in the footer right of the hint line, and as SVG bars in the desktop app.
1. Mixed. Fixed named colours per segment (`hooks/line.ts:103-114`): email cyan, git branch magenta (dirty dot yellow), model blue, effort yellow, cost green, dim `│` separators. Context gauge and rate gauges by tier (`tierColor`/`rateTier`, `:46-48`): tier 0 green, 1 yellow, 2 red; rate tiers at 50%/80%; context tiers on absolute tokens (`ctx_warn` 100k, `ctx_crit` 200k). The `⟳ N` request counter uses a 10-step green-to-red hex ramp (`RAMP`, `:36`), position given by `turns_min`/`turns_max`.
2. No themes. Comment `:28-29`: "named colours follow the terminal's theme, the gauges keep their 256-colour codes as hex".
3. Named ANSI colours (inherit the terminal palette) plus hex for gauges (`#008700 #af8700 #af0000`, fill text `#eeeeee`, empty `#444444`/`#bcbcbc`). No depth detection in this file.
4. Both: gauges are background-filled with the percentage centred (`gauge()` `:73-85`); other segments foreground only.
5. Dim ` │ ` text (`:132`).
6. Separator only.
7. Gauge text is fixed light-on-dark-fill, with the SVG variant using a stroked white label "legible on either theme" (`:177-184`). Named colours adapt via the terminal.
8. Unicode only (`⊞ ⟳ ↑ ●`); emoji in toasts (`🟧 🟥`).
9. Responsive drop order when narrow (`DROP_ORDER`, `:36`); compact forms; per-turn summary; clickable `⊞` (`press`).
10. Plugin options in `/plugin` or `pluginConfigs`: `ctx_warn`, `ctx_crit`, `turns_min`, `turns_max`, `show_email`, `show_git` (README).

## zenmux-cli (sephxu)
https://github.com/sephxu/zenmux-cli , stars 0
1. By threshold plus fixed. `src/commands/statusline.ts:20-31,50-60` with chalk: bar fill `chalk.cyan` always, empty `chalk.gray`; percentage plain, `chalk.yellow` above 70%, `chalk.red` above 90%; account name bold; separators and reset times `chalk.dim`; PAYG amount `chalk.yellow` when under $10, else bold. Applies to ZenMux subscription quota, not Claude's context.
2. Not present.
3. Uses chalk's named colours (ANSI-16) with chalk's own auto-detection of colour level. Since a statusline command's stdout is a pipe, chalk will likely drop colour unless `FORCE_COLOR` is set (inference from chalk behaviour, not checked in this repo). No explicit NO_COLOR code.
4. Foreground only.
5. Dim ` · ` text.
6. Separator only.
7. Not present.
8. `◉`, `█`, `░`; no Nerd Font.
9. A separate Ink TUI (`src/components/StatusDisplay.tsx`) for the main CLI.
10. CLI subcommand `statusline install|remove` writes `~/.claude/settings.json`; cached output; no style options.

## claude-code-digipet (Seung-o)
https://github.com/Seung-o/claude-code-digipet , stars 0
Statusline plugin that draws a Digimon pet (README, in Korean) rather than a metrics bar.
1. Per pet line and evolution stage, plus thresholds. `src/digimon/registry.ts:8-48`: each Digimon line has 7 stage colours as 256-index (e.g. agumon `252,216,214,208,202,196,bold 196`; the final stage bold). Name and EXP bar use the stage colour (`art/renderer.ts:17,35`). HP/hunger bars (`art/bars.ts:15-31`): `38;5;46` green, `226` yellow, `196` red at ratio 0.6/0.3 (hunger inverted 0.4/0.7). Divider line `38;5;240` (`renderer.ts:54`).
2. No themes. Palette is per Digimon line in `registry.ts`.
3. 256-index only. No detection, no NO_COLOR.
4. Foreground only (braille sprite cells).
5. A `─` rule line; no inline separators.
6. Not applicable (pet sprite is one colour per frame).
7. Mood tint (`braille-renderer.ts:52-89`): for non-happy moods the cube colour or grey index is shifted darker. No terminal adaptation.
8. Braille-art sprites, emoji icons per line (`🔥 ⚡`), box/block bars.
9. Animation (frames in `art/animations.ts`), mood tinting, 5% rare variant (★).
10. Setup script (`scripts/setup.js`); no style config.

## claude-agent-watch (sgarcia-dev)
https://github.com/sgarcia-dev/claude-agent-watch , stars 0
Claude Code mod (hooks/register.tsx) showing running agents in a pane/band, not a `statusLine` command.
1. By state and fixed per tool. `hooks/format.ts:9-14` `TOOL_STYLE` gives each tool a glyph and colour: codex `◆ #10a37f`, opencode `■ #4f8cff`, agy `▲ #f4b400`, hermes `● #c678dd`, claude `✻` with theme role `claude`. `STATE_STYLE` (`:128-135`) maps run state to Claude Code theme roles: running `success`, waiting `warning`, failed `error`, done `inactive`, starting/unknown `subtle`. Context bar colour by share (`contextColor`, `:122`): >=0.85 `error`, >=0.6 `warning`, else `success`.
2. No own themes. Uses Claude Code theme role names, so it follows the user's Claude Code theme; only the four other-tool accents are fixed hex.
3. Role names plus hex; whatever depth Claude Code's renderer handles. No NO_COLOR code.
4. Foreground only (`dimColor`, `bold`, `italic`).
5. ` · ` dim text.
6. Per-agent rows distinguished by glyph and tool colour.
7. Via theme roles (inherited from Claude Code).
8. Unicode glyphs; no Nerd Font.
9. Progress bars per run, `~N left` estimates.
10. No config surface found in the files read.

## Claude-Status-Bar-Builder-Web (shanadev)
https://github.com/shanadev/Claude-Status-Bar-Builder-Web , stars 0
A visual designer (Blazor WASM site, hackthestatusbar.dev) plus a C# console renderer that Claude Code runs.
1. Fully user-assigned per segment, with optional threshold override and position gradients. `Theme.cs` `Segment` has `Fg`, `Bg`, `IconFg`, `LabelFg`, `ValueFg`, bold/dim/italic/underline, `Bar` and `Thresholds`. `ThresholdRule { AtOrAbove, Fg, Bg }` overrides colours when a percent-valued element crosses a value (`SegmentRenderer.cs:38-50`). Bars: `BarOptions` with `GradientFrom/To`, positional `Stops` zones with mini-gradients (`SegmentRenderer.cs:349-395`, `Ansi.Lerp` in `Ansi.cs`), `TintTrack` (empty track = darkened zone colour) and `MatchFg` (text takes the bar tip's colour). The default (`DefaultTheme.cs`) is Tokyo Night: model `#7aa2f7`/`#16161e`, ctx tokens `#3b4261`, ctx % `#24283b` with bar `#9ece6a -> #f7768e` and thresholds 70 -> `#e0af68`, 90 -> `#f7768e`, branch `#9ece6a`, diff `#414868`, cost `#bb9af7`, 5h `#7dcfff`, 7d `#565f89`, clock `#24283b`. Each segment has a different background hue.
2. Theme = one JSON file (`Theme.cs`: name, fontFamily, background, rows, palette) with a per-segment colour map; user-built in the browser, no semantic roles. A `Palette` list of hex swatches is offered in every colour field and travels with the theme. Share links carry the theme deflate-compressed in `#t=`. A community templates gallery (`wwwroot/templates.json`, 4 entries at read time, with "steal just the colors" onto your own layout, per README).
3. Colour spec strings (`Ansi.cs`): `#RRGGBB` truecolor, `ansi:0`..`ansi:255` (0-7 -> 30-37, 8-15 -> 90-97, higher -> 38;5;n), `none`/empty = terminal default. No downsampling; no NO_COLOR code found (Program.cs).
4. Both: solid powerline capsules with background fills, or flat foreground text (thin separators), per row.
5. Rich: `SeparatorStyle` None, Space, Pipe, Dot, ChevronLine, Chevron, Round, Slant, Backslant, Flame, Blocks (`Theme.cs:17`; glyphs in `Composer.cs:17-39`), and `CapStyle` None, Chevron, Round, Slant, Backslant, Flame, Blocks at both ends. Powerline colour chaining: a solid separator is drawn with `fg = left segment bg, bg = next segment bg` (`Composer.cs:139`); the final cap `fg = last bg, bg = default` (`:141`). Thin separators use `Row.SeparatorFg`. Per-section overrides via `SectionSeparator`/`SectionCaps`, with spacers splitting capsules.
6. Different background per segment (author's choice) plus the chevron colour chain.
7. Not present: no contrast computation; the 16-colour picker uses Windows Terminal default hex only to preview/lerp `ansi:N` values (`Ansi.Ansi16`).
8. 12,678-icon browser (1,914 emoji + 10,764 Nerd Font glyphs), `IconSpace` for wide glyph overhang, own width table (`tools/gen-width-table.js`, `UnicodeWidth.cs`).
9. The web builder itself: live xterm.js preview with sample-data drawer, share links, templates gallery, animated spinner element, smooth 1/8-block bar fill, bar bracket/char sets.
10. Theme JSON at `~/.claude/statusbar-theme.json`; installer one-liners (`install.sh`/`install.ps1`, env `SBB_THEME`); single-binary renderer. No NO_COLOR/flags documented.

## token-tracker-grok (shankinchina-dotcom)
https://github.com/shankinchina-dotcom/token-tracker-grok , stars 0
1. Theme role mapped to segments, threshold for bars. `ui/themes.py:100-114` `_STATUSLINE_SLOTS` maps 13 statusline keys to 9 base slots: project -> green, branch -> red, added -> green, deleted -> red, untracked -> mauve, label -> pink, bar_ok -> green, bar_warn -> yellow, bar_danger -> red, tokens -> peach, total -> red, duration -> blue, model -> blue. Bar colour (`templates/claude_statusline.py:57-58`): <50 `bar_ok`, <80 `bar_warn`, else `bar_danger`.
2. Six bundled themes in `THEMES` (`themes.py:32-95`): mocha, latte, frappe, macchiato (Catppuccin hex), nord, dracula. Format: 9 base colours (`overlay0 green yellow peach red blue sapphire mauve pink`) + `is_light` + `cell` (+ optional 5-step `heat`); 17 CLI slots derived by `derive_slots()` from the 9; heat levels interpolated from `cell` to green when not hand-set (`_HEAT_RATIOS`). The 9 base slots are palette-named, shared between the CLI report and the statusline. The chosen theme's colours are baked into the statusline script at setup time (`__STATUSLINE_TRUECOLOR__` placeholder).
3. Truecolor with a 256 fallback: the script emits `38;2` or `38;5` according to `COLORTERM in ("truecolor","24bit")` (`claude_statusline.py:9-17`); `_hex_to_256` quantizes to the 6x6x6 cube or grey ramp (`themes.py:149-165`). No 8-colour support (stated in the docstring). No NO_COLOR handling found in the statusline template.
4. Foreground only (all `38;...`).
5. Plain separators; the statusline composes labels like `Total:`/`Cost:` with segments in several lines. (Separator characters not examined beyond this.)
6. Hue differences between roles; no separators doing the work.
7. `is_light` flag per theme (latte) so the CLI heatmap uses a light cell; the statusline has no runtime light/dark detection (colours baked at setup). `COLORFGBG` appears in `ui/theme.py` only per the scanner; not verified further.
8. Emoji and box chars; progress bar `█`/`░`.
9. Contribution-style heatmap (CLI report), screenshot-themes image `assets/screenshot-themes.png`, i18n.
10. CLI `tt theme list`, setup wizard (`wizard.py`), config file (`config.py`); statusline regenerated on theme change (`update_hook`).

## claude-code-status-line (shawn-dsz)
https://github.com/shawn-dsz/claude-code-status-line , stars 0
1. By state/threshold and fixed. `status-line.sh:187-206`: context heat gradient on a six-step 256-index ramp by used %: <15 `34` green, <30 `112` light green, <45 `220` yellow, <60 `208` orange, <75 `196` red, else `160` dark red, with text hints ("compact soon", "compact now"). Effort colours (`:105-112`): none grey `245`, minimal cyan, low green, medium yellow, high magenta, xhigh bold magenta, max bold red. Model fixed cyan (`:332`). Git ahead count and dirty-file count each use a 5-step ramp (`:360-398`). Duration grey `245`, Linear ticket `141`, account label by name (`:87-89`: personal blue `39`, fho orange `208`, else grey), agent colour from an identity file's `color` field (red/blue/green/yellow/purple/orange/pink/cyan -> 256 index, `:36-44`).
2. No themes.
3. 256-index plus ANSI-16 in the same script. No depth detection. NO_COLOR is honoured only in the usage helper scripts (`claude-usage.sh:9`, `ai-usage.sh`), not in `status-line.sh`.
4. Foreground only.
5. Plain ` | ` between segments (`:326-335`).
6. Separator only.
7. Not present.
8. Emoji (`🤖 🕐 🎫 🛑`), `⚠`, `✓`, `⎇`; dial glyph for the context gauge. No Nerd Font.
9. Per-agent colour by identity file; OSC-8 link on the Linear ticket (`:306-308`).
10. Edit the script; env/files for identity; usage helper scripts for Claude and Codex.

## shimi0556-bit/- (grab-bag repo)
https://github.com/shimi0556-bit/- , stars 0
Not one statusline: a personal monorepo (games, courses, a Rust CLI) that happens to hold two statusline-related items.
- `claude-hud/` is a vendored copy of Jarrod Watts' claude-hud plugin. 1. Role-named colours with thresholds: `src/render/colors.ts` default model CYAN, project YELLOW, git MAGENTA, gitBranch CYAN, label DIM, custom 256-`208`; context bar GREEN until warning 70, YELLOW to critical 85, then RED (`getContextColor`); quota bar `brightBlue` -> `brightMagenta` at 75 -> RED at 90. 2. No named themes; `config.ts:99-123,387-402` exposes `colors` overrides per role accepting a name (dim, red, green, yellow, magenta, cyan, brightBlue, brightMagenta), a 256-index number, or `#rrggbb`. 3. ANSI-16 default; 256 and truecolor on override. No detection; no NO_COLOR in `colors.ts`. 4. Foreground only. 5. Not examined. 6. Hues per role. 7. Not present. 8. Bar chars configurable (`barFilled` `█`, `barEmpty` `░`). 9-10. JSON config `colors` block.
- `tokana/bin/statusline.mjs` is a plain-text one-liner (`⧉ tokana: ...`): list cost, last turn in/out, cache-read share, no colour at all.
- `logan-cli/...` (ratatui Rust), `gods-eye-view`, `iron-hawk-3d`, `.agents/skills/yuv-design-system` are unrelated to Claude statuslines (a Grok pager TUI with tokyo-night/rosepine/oscura themes, web HUDs, a design-system skill).

## claude-code-statusline (shyam-pareek)
https://github.com/shyam-pareek/claude-code-statusline , stars 0
1. Fixed per metric within each of 7 selectable themes (`themes/*.sh`), usage-aware only in some. Theme 01 Pills (`01-pills.sh:38-43`) backgrounds: project `60` slate, model `55` purple, ctx `30` teal, 5h `130` orange, 7d `24` blue, cost `22` green; white bold text `231`. Theme 02 Powerline pills uses the same backgrounds plus extra pills for reset times (`94`, `31`). Theme 03 Vivid labels / 05 Neon separators / 04 Emoji neon use `uc()` (`03-vivid-labels.sh:38`): number colour <50 `82` green, 50-79 `214` amber, >=80 `196` red; labels fixed (ctx `51`, 5h `226`, 7d `45`). Theme 06 Two-tone pills: bright backgrounds (`189,213,51,220,117,118`) with dark text `38;5;16`. Theme 07 Gradient sweep: hue glides along the line by position, pink -> purple -> blue -> green (`199,213,171,170,141,111,81,80,84`).
2. Seven bundled themes (`01-pills`, `02-powerline-pills`, `03-vivid-labels`, `04-emoji-neon`, `05-neon-separators`, `06-two-tone-pills`, `07-gradient-sweep`); each is a complete shell script, chosen at install (`THEME=1..7`, menu in `install.sh:23-56`) and copied to `~/.claude/statusline/statusline.sh`. No role palette; users edit numbers in the script (README:136).
3. xterm-256 indices only (`38;5;N`/`48;5;N`); README states every modern terminal qualifies. No detection, no NO_COLOR.
4. Both, by theme: backgrounds in 01/02/06, foreground only in 03/04/05/07.
5. Theme 02 uses real powerline arrows `U+E0B0` with colour chaining (`fg = previous bg`, `bg = next bg`, final arrow `bg=49` default) (`02-powerline-pills.sh:36-60`). Theme 05 uses dim diamond separators. 01/06 use a space gap. 03/04/07 two spaces.
6. Different background hue per metric (01/02/06), chevron chain (02), different label hue (03/05), position gradient (07).
7. Text colour is hand-picked per theme (white `231` on dark pills, `16` on bright pills). No adaptation.
8. Nerd Font required only for theme 02; theme 04 uses emoji (`🤖 📁 🧠 ⏳ 📅 💰`).
9. A gradient-sweep theme; `preview.sh` shows all themes; `update.sh`.
10. Env `THEME`, `SHOW_PROJECT`, `SHOW_COST` at install; edit the installed script.

## sicsGitHub/claude-code-statusline
https://github.com/sicsGitHub/claude-code-statusline , stars 0
1. Threshold for the meters, otherwise none. `statusline-command.sh:72-87`: 10-cell bar `[█░]` bold green (<70%), bold yellow (>=70), bold red (>=90), brackets dim. Model name bold, no colour (`:89`). Session and weekly rate-limit text uncoloured.
2. No themes.
3. SGR attributes (`01`, `02`, `3x`) only; no 256/truecolor; no detection or NO_COLOR.
4. Foreground only.
5. Dim `|` (`:105-106`).
6. Separator only.
7. Not present.
8. `█ ░ [ ]`; ASCII otherwise.
9. "Resets in 2 days 3 hr" text (`fmt_reset`).
10. Edit the script; also shipped as a skill (`skills/statusline/`).

## silee-tools/claude-statusline
https://github.com/silee-tools/claude-statusline , stars 0
Go binary plus plugin wrapper (the scanner read also `scripts/statusline.sh`).
1. Fixed per segment with thresholds for gauges. Constants in `internal/theme/theme.go:10-23`: Green/Yellow/Red/Magenta/Cyan/Blue (ANSI-16), Amber214, Lime148, Grey240, Coral173 (256). Fixed: model Cyan (`render.go:192`), branch Magenta with Nerd glyph U+E0A0 (`:63,150`), clock Green (`:82`), session Grey240, email Coral173 (`segments.go:264`), forgejo Amber214, `gh@` Grey240 / Red on error, aws Green/Red/Dim. Context gauge: `GaugeColor(pct, 40, 70)` yellow >=40, red >=70, else uncoloured. Rate gauges: warn 80, danger 90. Effort glyph + colour (`theme.go:126-140`): low `○` green, medium `◐` lime, high `●` yellow, xhigh `◉` amber, max `◈` red, ultracode `✦` magenta. Labels via `theme.Label` = DIM so values stay bright.
2. No themes; colours are Go constants in one file (the file's doc says "both layouts share").
3. ANSI-16 plus a few 256 indices. No detection, no NO_COLOR (not found in `cmd/statusline/main.go`).
4. Foreground only. The 20-cell bar is two independent channels: glyph says spent (`█`/`░`), colour says beyond-budget (`theme.Bar`, `theme.go:62-82`), each cell closing its own colour.
5. Group joining by spaces (`joinGroups`); no powerline.
6. Layout rows and dim labels; no colour trick.
7. Not present. Layout switches compact vs full by width (`width/fit.go`).
8. Nerd Font for the branch glyph only (`theme.go:25-27`); `⧉`, `↺`, `▲` unicode.
9. Pace marker `▲` on rate gauges (budget vs actual).
10. Plugin hooks and config paths (`config_paths.go`); no colour config.

## coralline (Silverance fork of Nanako0129/coralline)
https://github.com/Silverance/coralline , stars 0 , FORK OF Nanako0129/coralline (diverged: 26 ahead, 35 behind); only differences reported.
1. Fork adds segments ported from ccstatusline (effort, cache, vim, worktree, per-model limits, sha, conflicts, custom command, version, session) and gives each its own fixed per-theme background variable (`VL_BG_WORKTREE`, `VL_BG_VIM`, `VL_BG_CUSTOM`, `VL_BG_CONFLICT`, `VL_BG_CACHE`, `VL_BG_SHA`, `VL_BG_VERSION`, `VL_BG_SESSION`), in every theme file (13 added lines per `themes/*.conf`). E.g. catppuccin-mocha (`themes/catppuccin-mocha.conf`): worktree `148,226,213` teal, vim `250,179,135` peach, custom `242,205,205` flamingo, conflict `243,139,168` red (comment: "loudest"), cache = gauge ground `49,50,68`, sha/version/session tinted dark "dim metadata". Cache text is value-coloured with `VL_FG_OK/WARN/HOT`. Parent mechanics unchanged: per-segment `VL_BG_*` (RGB triple or 256 index), `VL_FG_TEXT` on pills, `VL_FG_OK/WARN/HOT` thresholds (`statusline.sh:1367-1368`).
2. Fork adds a `warp` theme (`themes/warp.conf`, 35 lines) tuned to Warp's navy ground. Total themes seen: catppuccin-mocha, claude-coral, dracula, gruvbox-dark, lunar-pink, mono, morning-haze, nord, reverie, tokyo-night, warp. Format is a per-segment colour map in a `.conf` shell file; users can write their own.
3. Same as parent: `fg`/`bg` helpers accept a 256 index or `"R,G,B"` truecolor triple (`statusline.sh:354-372`); `VL_NOCOLOR=1` suppresses all colour. `VL_ASCII=1` for glyphs.
7. This is the fork's real addition: a WCAG-style contrast regression suite, `test/test-contrast.sh`. It fails when a fork-added pill is too close to the ink it is drawn with (motivating case: catppuccin-mocha had `VL_BG_SHA` equal to `VL_FG_DIM`, a 1.00:1 pair that rendered nothing). Two tiers: 4.5:1 for signal segments (worktree, vim, custom, conflict, cache), 3.0:1 for recessed metadata (sha, version, session). Theme files carry the measured ratios in comments. A subagent-panel colour set `_VL_SUB_*` is adopted only when the live palette fingerprint `_VL_SUB_FP` still matches, so a user's retinted `VL_FG_*` keeps its own colours.
5. Adds a `sep` group-divider segment for lean style (`VL_SEP_GLYPH="┃"`, `VL_SEP_FG`, `statusline.sh:46-47,2007`).
9. Adds `--doctor`, a git-status cache, a worktree location badge, CJK width fix.
4,6,8,10: not examined beyond the parent's behaviour (styles `pill`/`lean`/`classic`, ASCII mode `VL_ASCII`).

## oh-my-statusline (simhani1)
https://github.com/simhani1/oh-my-statusline , stars 0
1. Only the context status is coloured (`src/statusline.js:178-183`): >=80 red "compact now", >=75 orange "compact soon", >=60 yellow "watch", else green "good". All other segments (model, project, git, context counts) are uncoloured.
2. "Themes" are icon sets, not colours (`THEMES`, `statusline.js:12-98`, `commands/theme.md`): symbols, emoji, space, neon, cafe, lab, toybox, each also swapping the status words (e.g. toybox "playtime"/"toy box full"). No colour themes.
3. Four named SGR plus `38;5;208` orange (`:4-9`). `--no-color` flag and `NO_COLOR` env honoured (`bin/oh-my-statusline.js:26,48`).
4. Foreground only.
5. Dim `│` (`:194`); plain ` │ ` when colour is off.
6. Separator only.
7. Not present.
8. Emoji and symbol sets per theme (the whole point of the "theme").
9. Status words change per theme.
10. `--theme`, `--no-color`; installer `bin/install.js --local --theme <name>`; `/theme` slash command.

## augur-skills (simpleapps-com), plugin simpleapps-statusline
https://github.com/simpleapps-com/augur-skills , stars 0
Claude Code mod (`plugins/simpleapps-statusline/hooks/register.tsx`) drawing Ink rows.
1. Fixed named colours per segment (`register.tsx:418-461`): user green, project blue, branch dim, account magenta, version cyan, model yellow, `:` and meters' empty part dim. Usage meters by threshold (`percentColor`, `:84-90`): >=90 red, >=75 yellow, else the default text colour (undefined); `meterColor` (`:172`) falls back to green.
2. No themes; colours are Claude Code's colour names.
3. Named colours resolved by Claude Code's renderer; no depth or NO_COLOR code.
4. Foreground only.
5. Dim `:` and spacing.
6. Distinct fixed hue per segment.
7. Not present beyond named colours following the terminal.
8. Bar of `━` (heavy line) for fill and empty (`:454-455`), distinguished by dim only.
9. `/plan-usage` command uses the same colours.
10. No visible style config.

## claude-newsline (sitapix)
https://github.com/sitapix/claude-newsline , stars 0
A rotating news-headline ticker in the statusline, not a metrics bar.
1. One colour for the feed text and one for the prefix glyph; no per-segment mapping. Defaults `NEWSLINE_COLOR_FEED=dim_yellow` at runtime (`amber` when written by the wizard), `NEWSLINE_COLOR_PREFIX=dim` (`statusline.sh:199,208`). Test-feed output uses ok/warn/fail = green/yellow/red (`:988-991`).
2. A 7-colour truecolor palette by name: amber `255,193,7`, coral `255,127,80`, pink `255,105,180`, mint `0,255,135`, sky `135,206,235`, lavender `177,156,217`, lime `198,255,0` (`bin/colors.sh:77-84`), each with a 256 index and a 16-colour SGR fallback, plus any named SGR (`bold_red`, `dim_cyan`...) or raw SGR (`38;5;208`). No theme files.
3. Best of the three, the most complete depth handling in this batch: `COLOR_DEPTH` 0/4/8/24 from `NO_COLOR` (wins, suppresses even the reset), `FORCE_COLOR` (0/1/2/3), `COLORTERM=truecolor|24bit`, then `TERM` (`dumb` -> 0, unset -> 4, else 8) (`colors.sh:20-60`). `_palette` picks `38;2`, `38;5` or SGR by depth.
4. Foreground only.
5. Brand glyph prefix `Ξ ` (configurable); no separators.
6. Not applicable (one line).
7. Not present.
8. Single glyph prefix; hyperlinks (`FORCE_HYPERLINK` honoured).
9. Scrolling/marquee transition between headlines, rotation by time (`pos_in_cycle`).
10. Env vars `NEWSLINE_COLOR_FEED`, `NEWSLINE_COLOR_PREFIX`, `NEWSLINE_PREFIX`, etc.; install wizard; `--color` flag.

## StatusAI (SixFive7)
https://github.com/SixFive7/StatusAI , stars 0
Windows-only native C# statusline (`src/Program.cs`), plus an optional starship/cship config.
1. Zone and state colours with fixed role colours, all truecolor on a Tokyo Night-like palette. Bar cells are coloured per cell by zone (`ZoneColor`, `Program.cs:1268-1274`): cells 1-7 cyan `125,207,255`, 8-9 amber `224,175,104`, 10+ bold red `247,118,142`; percent text: >=90 bold red, >=70 amber, else cyan (`:1309`). Limit rows: the `→ time to 100%` is red when it arrives before the reset, "forest green" `#28A428` when the reset comes first (`:25`), dim otherwise (`:1418`); `↻` mint `166,227,161`, reset time `198,246,193`; lines `+` green, `-` red; duration lavender `180,190,254`; labels dim `110,115,141`, text `169,177,214`; sub-agent tokens lavender, total bold cyan (`:2059-2061`). Over-100% projections drawn as red `✗` cells.
2. No theme system. The colours are constants in code; the doc `docs/design/house-style/` records them as a "house style" and `docs/design/limits-decisions.*` records colour decisions.
3. Truecolor only (`\x1b[38;2;...`). No downsampling; no NO_COLOR (not found).
4. Foreground only.
5. Dim `│` rule (`:2081`) between columns; no powerline.
6. Dim vertical rules and column alignment.
7. Contrast was measured by hand for the forest green (`Program.cs:17-24`): `#228B22` was lifted to `#28A428` "the first step that reaches 4.5:1 on every ground" (Campbell `#0C0C0C` 5.99, lightest wallpaper `#242424` 4.75, `#16161E` 5.51), and kept distinct from the pastel greens by CIEDE2000 (21.7 and 27.3). Targets dark terminal grounds only.
8. Emoji (`⏱ 📝`), unicode (`↻ → ⇢ ✗ —`); `—` as no-data sentinel (never `0`).
9. Per-product usage split, pace projection, Stream Deck plugin renders the same data (`src/Deck.cs`, `streamdeck/`), a separate generator of docs figures (`figures.gen.js`).
10. Windows `.exe` configured through the starship/cship TOMLs in `config/` (`cship.toml` styles like `fg:#7dcfff`, warn `fg:#e0af68` at 40, critical bold `fg:#f7768e` at 70). `config/starship.toml` is a Catppuccin Powerline preset.

## skaterino/claude-mods
https://github.com/skaterino/claude-mods , stars 0
German-language Claude Code mods; `verbrauch` (0.7.2) draws a status line and a `/verbrauch` pane via Ink; `sessions` is a pause/resume command (not styling).
1. Threshold zones by Claude Code theme role. `verbrauch/hooks/register.tsx:102-103,473-474`: `LIMIT_ZONES` `[60,'success'],[80,'warning'],[Infinity,'error']`; `CONTEXT_ZONES` the same with `WARN`/`ALARM` token cutoffs. The gauge (`:476-494`) colours each cell by the zone its midpoint falls in and dims empty cells (`dimColor={seg.isEmpty}`), so the thresholds are visible even in the unfilled part. Pace text uses `error`, `warning`, `success` (`:1450-1456`).
2. No own themes; role names (`success`, `warning`, `error`) resolve in the user's Claude Code theme.
3. Role names; whatever depth Claude Code supports; no NO_COLOR code.
4. Foreground only.
5. Plain text separators; not examined further.
6. Not applicable beyond text.
7. Via Claude Code theme roles.
8. `█ ░` gauge, emoji in text.
9. Pace projection ("Tempo -> Limit um ... vor dem Reset"), cache-lock info.
10. Plugin loaded via `CLAUDE_CODE_PLUGIN_DIRS` in settings; no style options seen.

## claude-thinking-tokens (slavko-at-klincov-it)
https://github.com/slavko-at-klincov-it/claude-thinking-tokens , stars 0
1. By threshold. `statusline.sh:33-56` `build_bar`: <=40% green `\033[32m`, <=70% yellow, <=90% red, else bold red; used for the 5h, 7d and context bars. The "thinking" label is green with a thinking bar (`:191`), `thinking: OFF` grey `\033[90m` (`:196`). Other text uncoloured.
2. No themes.
3. ANSI-16 only. No detection, no NO_COLOR.
4. Foreground only.
5. Plain ` | ` (`:159`).
6. Separator only.
7. Not present.
8. `█ ░`; no icons.
9. Estimates of thinking tokens per turn (`time-analysis.sh`).
10. Edit the script.

## claude-statusbar (sleep)
https://github.com/sleep/claude-statusbar , stars 0
1. Fixed per segment with severity colouring. `scripts/statusline.py:39-52` has an editable `THEME` dict of 256 indices: logo `209` clay orange (the `❋`), model `255`, sep `238`, path `75` blue, branch `141` violet, cost `220` gold, ok `114`, warn `221`, hot `203`, muted `245`, faint `238` (bar background). Severity (`severity_color`, `:65-70`): <0.60 ok, <0.85 warn, else hot; applied to the context meter and percentages. Diff `+` uses ok, `-` uses hot (`:468`).
2. One built-in palette, a semantic dict (logo/model/sep/path/branch/cost/ok/warn/hot/muted/faint). User edits the dict in the script ("tweak these to restyle the whole line"); no theme loading.
3. 256 indices (`38;5;N`) only. No detection, no NO_COLOR.
4. Foreground only.
5. Dim `│` in colour `238` (`SEP`, `:54`).
6. Separator only, plus per-segment hues.
7. Not present.
8. `❋`, `⎇`, `⏱`, `█░`, optional `▰▱` meter (`:86-89`); no Nerd Font.
9. Two meter styles; context meter shows "% left".
10. Edit `THEME`; `scripts/statusline-wrapper.sh`; env `CLAUDE_CONFIG_DIR` only.

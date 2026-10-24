## ccinfobar
https://github.com/alpadalar/ccinfobar — 4 stars
1. Colour source is a per-theme `colors.mode` (`src/core/themes/style.ts` `ColorMode`): `widget` = each widget type's own default colour (`part.def.color`), `category` = widget category (session, context, tokens, cost, limits, gsd, git, workspace, system, custom, layout, charts, agents) maps to a `Swatch`, `cycle` = position, rotating through a `cycle[]` list (`renderer.ts:244-251` `swatchFor`: `c.cycle[index % c.cycle.length]`). Threshold colouring is on top: `statusColors` lets widgets such as context-bar colour themselves by state (text style only, `renderer.ts:260`); default gradient ramp is green(76,207,146) at 0%, yellow(242,192,92) at 50%, red(240,106,106) at 80%, violet(198,120,221) at 100% (`src/core/ansi.ts` `STOPS`, theme `gradient` overrides, max 8 stops). A per-item `color`/`background` in the user's config overrides everything (`colorsFor`).
2. 30 built-in themes (`docs/THEMES.md`): classic, minimal, mono, neon, pastel, amber, matrix, blocks, slate, paper, powerline, nord, dracula, gruvbox, tokyo-night, solarized, monochrome, dark, light, rose-pine, catppuccin-latte/-frappe/-macchiato/-mocha, everforest, kanagawa, catppuccin (capsule), bubblegum, one-dark, panel. Format is a JSON object with a per-category colour map plus a few roles: `fg`, `bg`, `on` (text on blocks), `muted` (separator colour) (`schema/theme.schema.json`). Users define their own: `~/.config/.../themes/<id>.json`, `extends` another theme and override only fields set (`themes.ts` `resolveTheme`/`merge`). Theme and style are independent: `{ "theme": "nord", "style": "capsule" }`. Also importers from eight other statuslines (`src/importers/*.ts`: ccstatusline, claude-powerline, statusline-pro, etc.) and a theme builder in the web editor (`src/editor/web/theme-builder.ts`).
3. Named ANSI 16 (`NAMED_COLORS`, `ansi.ts:5`), `ansi256:N`, `#rrggbb`/`#rgb`, `default`/`none`. Downsamples: `colorCode` converts rgb to 256 (`rgbTo256`) or to the nearest of 16 (`nearestBasic`) by level. `detectLevel` (`ansi.ts`): `NO_COLOR` non-empty gives level 0, `FORCE_COLOR` 0-3, `COLORTERM=truecolor|24bit` gives 3, Windows Terminal / VS Code / iTerm gives 3, else 2.
4. Both, by style: `text` (fg-only on terminal background), `blocks`, `powerline`, `capsule` are background-filled, `tui` is a bordered panel (`docs/THEMES.md` Styles table).
5. Powerline arrow (`STYLE_GLYPHS`, `style.ts`) plus a thin variant used between same-coloured neighbours; capsule start/end caps are Nerd Font rounded glyphs (half-block `▐ ▌` in unicode charset, `renderer.ts:72`); text style uses `' │ '`. Arrow colours: fg = previous cell's bg, bg = next cell's bg (`renderer.ts:renderPowerline`, ~line 333-339); same-bg neighbours get the thin glyph in `separatorColor` instead (`theme.colors.muted` by default, `renderer.ts:109`).
6. Neighbours differ by category hue (category mode), rotating cycle list (cycle mode), or the thin-arrow rule when two adjacent cells happen to share a bg. No lightness-step logic.
7. Text colour on a block is `theme.colors.on`, or per-swatch `fg`; if a widget has its own colour on a block it is used only if contrast >= 3 (`MIN_CONTRAST`, `readable()`), else falls back; for borrowed fg-as-bg swatches `onColor()` picks black or brightWhite by WCAG contrast ratio (`renderer.ts:277-291`). Light terminals: themes `paper`, `light`, `catppuccin-latte`; editor can detect terminal colours (docs claim; `src/editor/terminal-colors.ts` not read in detail).
8. Nerd Font glyphs by default; `charset: auto|nerd|unicode|text` (auto = unicode in Apple Terminal); text mode is pure ASCII with `=`/`-` bars; Nerd/emoji icons fall back to text labels (`docs/THEMES.md` Character sets).
9. Panel (`tui`) style with borders (`rounded`, `heavy`, `double`...), `borderColor: "context"` shifts green to red to violet as the context fills; responsive grid layouts; gradient bars; web theme builder with light/dark screenshots (`docs/images/screenshots/theme-builder-*.png`); i18n.
10. JSON config + JSON schema, CLI (`ccinfobar theme <name>`, `themes` preview, `edit` web editor, `tui`), per-item overrides (color, background, bold, dim, italic, merge, priority), env `NO_COLOR` / `FORCE_COLOR` / `COLORTERM`.

## ccost
https://github.com/cc-friend/ccost — 4 stars
not a Claude statusline: a Rust CLI that analyses Claude Code token usage and cost from `~/.claude/projects` logs; its `ccost sl` subcommand only reads a `statusline.jsonl` that the user's own statusline script appends to (README "Statusline Analysis"). Its only styling is ANSI colour on tables (`src/sl/formatter.rs`: yellow `\x1b[33m` for totals, green `\x1b[32m`/red `\x1b[31m` for +/- lines, a `color: bool` option).

## creatmanceo/claude-statusline
https://github.com/CreatmanCEO/claude-statusline — 4 stars
1. Fixed per segment plus threshold. `statusline.sh:37-40` defines ANSI 16 constants; model = bold magenta (`:172`), git branch = cyan (`:181`), lines `+N` green / `/-N` red (`:188`), cost = yellow (`:202`), duration/separators dim. Threshold function `color_by_threshold value warn crit` (`:42-46`) gives green below warn, yellow >= warn, red >= crit; used for context (`CONTEXT_WARN`=50, `CONTEXT_CRIT` default in config, `:324`), 5h/weekly limits (warn 50, crit 80, `:218`), VPS RAM/disk/CPU (80/90, 70/90). VPS health dots: ok green `●`, warn yellow `◉`, crit/down red, boot magenta `↻`, unknown gray (`:299-301`). At context >= crit it prints bold red `/compact!`.
2. Themes: not present (STYLE and POWERLINE_SEP variables are defined at `:21-22` but never used in rendering; only `SEPARATOR`, default ` │ `, dim).
3. ANSI 16 only (`\033[3Xm`, bright gray `\033[90m`). No depth detection, no NO_COLOR.
4. Foreground-only.
5. Plain-text separator `│` (override via `SEPARATOR`) in dim.
6. Separator only; neighbours distinct by their fixed hues.
7. Not present (no light/dark logic; uses the terminal's ANSI palette).
8. Emoji/unicode dots only (`●`, `◉`, `✗`, `↻`, `▶`); Russian label option `LANG_RU`.
9. VPS auto-focus marker `▶` driven by transcript parsing; tmux plain-text bridge (`TMUX_BRIDGE`, strips ANSI with sed, `:341`).
10. Shell config file `~/.claude/statusline.conf` (or `$CLAUDE_STATUSLINE_CONF`) sourced as variables: `SHOW_*`, `SEPARATOR`, thresholds, VPS lists.

## proc-stats
https://github.com/DragosMocrii/proc-stats — 4 stars
Claude Code mod (pins a text status line of memory/CPU/uptime via `$.ui.status(...)`, `hooks/register.ts:508`, and a `/proc-stats` task-manager pane).
1. Status line is unstyled text (`hooks/status.ts` has no colour calls; a leading marker glyph for alerts). Pane (`hooks/pane.tsx`) uses Claude Code theme keys, not colours: header background `'claude'` (`:23`), striped row background `'subtle'` (`:25`), `dimColor` for secondary text, `bold` for totals.
2. Themes: not present (inherits the user's Claude Code theme "so both follow the person's light or dark theme", `pane.tsx:22`).
3. Theme-key names only; no ANSI/hex handling, depth and NO_COLOR left to Claude Code.
4. Pane: background-filled header and zebra stripes; status line: plain text.
5. Separator is the text ` · ` in the status line.
6. Zebra row stripes (`STRIPE_COLOR`) in the pane; status line separator only.
7. Handled by theme keys following Claude Code's active theme (comment at `pane.tsx:22`).
8. Tree glyphs `▾/▸`, sparkline charts (`hooks/sparkline.ts`); no emoji/Nerd.
9. Live history charts and a stop-process UI; markers/toasts for alerts.
10. Settings in Claude Code's `/config` menu (`statusShowChildren`, refresh interval, history window).

## eflowcodeline
https://github.com/EF-FlowCode/EFlowCodeLine — 4 stars. FORK OF Haleclipse/CCometixLine (README names it), a vendor-specific variant.
Differs from the parent in styling:
1. Fixed per segment, hard-coded RGB, and the theme system is removed: `src/ui/themes/presets.rs:1-3` "single hard-coded preset ... Theme switching, file-based themes, and the TUI theme selector are all gone" and README "v1.7.0 locks the style to the built-in theme, no `--theme`, no custom config.toml". Each segment has its own filled background in a navy-to-magenta-to-gold gradient across a three-line layout (`theme_default.rs`): model (42,56,110), context (68,95,167), usage (92,124,192), cost (188,121,196), session (220,99,134), output_style (228,134,78, disabled), cwd (43,60,95), directory (63,86,142), git (87,114,175), used (184,102,169), balance (218,159,86), branding (245,213,96). Text and icon are (245,245,245) everywhere except branding, which is (30,30,30) on gold.
2. One preset, `theme: "default"`; no user themes. `AnsiColor` supports `Color16`/`Color256`/`Rgb` in the config type (`statusline.rs:445-457`).
3. Emits what the segment config says (16 / 256 / truecolor `38;2`); no downsampling code seen in `statusline.rs`; no NO_COLOR check seen there.
4. Background-filled segments (`render_segment`, `statusline.rs:~363-395`, bg applied to ` icon text `, reset with `\x1b[49m`).
5. Powerline arrow `` between segments; arrow fg = previous segment bg, arrow bg = next segment bg (`create_powerline_arrow`, `statusline.rs:584-597`). Lines wrap by measuring visible width.
6. Hue/lightness steps along a fixed gradient: each line is a ramp of progressively lighter/shifted blues, ending in a magenta/rose/orange, so neighbours differ by step.
7. Light text on dark fills only; no adaptation.
8. Nerd Font mode (`StyleMode::NerdFont`) with per-segment icons; emoji icons in the icon selector.
9. Ratatui TUI configurator exists in the tree (`src/ui/components/color_picker.rs`, `theme_selector.rs`) but the theme selector is disabled in this fork.
10. Config is locked; no flags for theme.

## emaballarin/ccplugins
https://github.com/emaballarin/ccplugins — 4 stars
Collection of plugins (ccscience, autoresearch, dm42dev, mindfunnel, ccbar...); only `plugins/ccbar` is a status display, a Claude Code mod band (`hooks/band.ts`, `register.tsx`). Other plugins: not a Claude statusline.
1. Colours are by meaning, as Claude Code theme keys (`band.ts` `COLOR`): identity/model `claude` bold, mode/effort `permission`, labels `inactive`, diff added `diffAddedWord`, removed `diffRemovedWord`; separators `subtle`. Load against a cap is a threshold (`loadColor`, `band.ts:30-34`): `success` below 60%, `warning` below 85%, `error` from 85%. Context bar colours: fill `inactive`, track `userMessageBackground`, reserve `subtle` (`BAR`), plus per-category segments.
2. Themes: not present; uses the active Claude Code theme.
3. Theme-key strings (`color`, `bg` on a `Run`), depth/NO_COLOR left to Claude Code. No hex in styling code.
4. Both: runs have `color` and `bg`; the context bar uses fg+bg half-block cells (`lib.ts` `EIGHTHS`, `layBar`).
5. Plain text separators: `"  ·  "` between groups and `" · "` tight, both `subtle` (`band.ts:11-14`).
6. Spacing and separator only; hue by meaning.
7. Inherits Claude Code's theme, which supplies light/dark values.
8. Unicode only (`⎇`, `−`, eighth-block bars); OSC 8 links on repo/branch.
9. Context bar broken into token categories; clickable GitHub links.
10. Mod configuration via Claude Code plugin options; not examined.

## tamagoxtix
https://github.com/fabandrade88/tamagoxtix — 4 stars
Claude Code mod with a pixel monster plus an optional powerline status line, and a herdr plugin.
1. By position-independent role plus state: `claude/scripts/statusline.mjs:61-82`: model = `p.orange` bold, folder = `p.accent`, branch = `p.yellow` if dirty else `p.magenta`, context = `levelColor(ctx, p, p.cyan)`, 5h = `levelColor(five, p)` (calm default `green`), weekly = `levelColor(week, p, p.teal ?? p.cyan)`, session time = `p.muted`. `levelColor` (`shared/powerline.mjs`): >= 90 `red`, >= 70 `orange`, else calm colour.
2. 12 palettes (`shared/palettes.mjs`): beach (default), omarchy (reads Omarchy's `colors.toml` live), tokyo-night, catppuccin, gruvbox, nord, everforest, kanagawa, rose-pine, osaka-jade, ristretto, matte-black. Format: semantic slots `bg fg muted accent red orange yellow green cyan blue magenta` + `mode: dark|light`. User-defined: only via an Omarchy theme file, no own format seen.
3. Truecolor hex only (`\x1b[38;2;..`/`48;2`); no downsampling, no NO_COLOR seen.
4. Background-filled powerline cells with rounded caps (`round` option).
5. Powerline arrow `` after each cell: fg = this cell's colour, bg = next cell's colour; ends with a rounded cap or arrow; `plain` mode drops arrows and abuts cells (`powerline()` in `shared/powerline.mjs`).
6. Different palette slot per segment (fixed hue per segment type); no alternating logic.
7. Text colour on every cell is the palette bg darkened 20% (`ink = mix(palette.bg, '#000000', 0.2)`), so text always dark-on-colour; palette carries `mode` but the status line does not branch on it.
8. Nerd Font icons by default, `/tamagoxtix icons plain` swaps to plain symbols (`◆ ▸ ⎇ ◔ ◑ ▦ ◷`).
9. Palette also themes the Claude Code chat via `/tamagoxtix theme on` (maps palette to Claude Code theme like Omarchy); animated monster sprites; screenshot gallery script `scripts/gallery.mjs` and `scripts/ansi-to-svg.mjs`.
10. `/tamagoxtix` slash commands (`statusline on|off`, `palette`, `icons`), config stored in a JSON file read by `config()` in `statusline.mjs`.

## fiale-claude-plugins
https://github.com/fiale-plus/fiale-claude-plugins — 4 stars
Multi-plugin repo; the statusline is `plugins/claude-status-hub/bin/statusline.sh`. Others (brain, mdbrowser): not a Claude statusline.
1. Fixed per segment plus thresholds. Default prompt part: user purple, `@` dim, host yellow, cwd cyan (`:36`); git branch green after a dim `›` (`:60`); context `pct_color`: >= 80 red, >= 60 yellow, else green (`:74`); quota: >= 90 red, >= 75 yellow, else green (`:96`); alerts red `⚠`, background tasks magenta, notifications green, dead daemon red `💀`.
2. Themes: not present.
3. ANSI 16 constants only (`:4-6`, plus bright magenta `\033[95m`); no detection, no NO_COLOR.
4. Foreground-only.
5. Plain dim `›` separators.
6. Separator only.
7. Not present.
8. Emoji and unicode (`⚡`, `⚠`, `💀`, icons from monitors).
9. Notification feed in the line that expires; context display modes `bar|percent|threshold`.
10. Env/config via `setup-statusline.sh`; display mode variables (`CTX_THRESHOLD`, bar styles).

## cc-usage-statusline
https://github.com/fletcherholt/cc-usage-statusline — 4 stars
1. Deliberately theme-neutral: only ANSI 16 slots, "so the line looks native on any terminal — Catppuccin, Solarized, or a plain black default" (`statusline.sh:13-14, 33-37`). Directory bold, `▌` marker and branch cyan, model plain, effort dim, fast-mode yellow; `pct_color` (`:57-62`): >= 80 red, >= 60 yellow, else green, used for context % and the 14-cell session/week bars (`▌` filled in that colour, `░` empty dim).
2. Themes: not present (adopts the terminal theme by design).
3. ANSI 16 (`\033[31/32/33/36m`, bold, dim). No detection, no NO_COLOR.
4. Foreground-only.
5. Plain dim `·` text separators.
6. Separator only.
7. Handled implicitly by using the terminal palette (no explicit adaptation).
8. Unicode blocks `▌ ░`; no emoji icons in the rendering seen.
9. Two-line + bar layout with reset times.
10. Edit the script (README says thresholds in `pct_color`); `install.sh`/`uninstall.sh`.

## fractal-manifold/mcp-marketplace
https://github.com/fractal-manifold/mcp-marketplace — 4 stars
Marketplace with several plugins; the relevant one is `plugins/token-monitor-hud` (a mod band with a statusline-like usage display). `plugins/agentnetwork`, `plugins/tokenmonitor` (hardware device themes Day/Night/Auto) are not Claude statuslines.
1. By state: `colorFor(pct)` in `hooks/forecast.ts:6`: >= 85 `'red'`, >= 60 `'yellow'`, else `'green'`; applied to window bars, percentage, projected percentage and context % (`register.tsx:299-312, 347-368`). Labels `dimColor`, headings `weight="semibold"`.
2. Themes: not present in the HUD (the `tokenmonitor` plugin's `/tokenmonitor:theme` is a Day/Night/Auto switch for a separate physical device, with a brand-tinted palette per provider; `SKILL.md`).
3. Named colour strings handed to Claude Code's renderer; no depth/NO_COLOR code. Emoji dots for text fallback: `dot()` returns 🔴/🟡/🟢 at the same thresholds.
4. Foreground-only.
5. Not present (separate `Text` elements, spaces).
6. Spacing only.
7. Not present.
8. Bars `█░`; emoji dots in plain text mode.
9. Forecast projection (`→NN%`) coloured by the same function; a band toggle.
10. Plugin options; no styling options.

## fynn-mods
https://github.com/FynnXland/fynn-mods — 4 stars
Six Claude Code mods (clawd-buddy mascot, limit-bars, sidekick, quick-replies, worklist, cost-ledger). Only `limit-bars` is a status-style display; the rest are not statuslines.
1. limit-bars is an SVG image band, fixed hex palette with thresholds (`mods/limit-bars/hooks/view.ts:12-17`): ORANGE `#D77757` (labels/tags), GREEN `#6CC070`, YELLOW `#F2C94C`, RED `#C9594B`, EMPTY `#4A4A4A`, GREY `#9A9A9A`. Bar colour: `full || p >= 85` red, `p >= 60` yellow, else green (`view.ts:154`); stale/unknown readings GREY (`:120`).
2. Themes: not present (fixed palette).
3. Hex only, written into SVG `fill=` attributes (`svg.ts:27-34`); no depth/NO_COLOR concept.
4. Both via SVG: filled `rect` segments (`rx=0.5`) and text spans.
5. Not present.
6. Gap/pitch spacing between blocks.
7. Not present (hex tuned for dark).
8. Segmented bar and a ring (cache-warm indicator); pixel-art crab mascot in clawd-buddy.
9. Animated mascot, ring for prompt cache TTL, storage ring.
10. Plugin options via `/plugin configure`, `language en|de`.

## hd838a/claude-code-config
https://github.com/HD838A/claude-code-config — 4 stars
1. Fixed per segment, mirroring a starship config (`statusline/statusline-command.sh:30-44`, all bold truecolor): directory cyan (95,179,196), worktree orange (255,138,0), git branch pink (255,32,110), staged green (106,190,145), modified yellow (255,210,63), untracked magenta (199,36,177), ahead lime (57,255,20), behind orange-red (255,107,53), conflicted/deleted red (255,0,67), renamed blue (0,180,216), diverged purple (157,78,221), model purple (179,136,255). Usage by threshold (`usage_color`, `:201-208`): >= 85 RED, >= 60 YELLOW, else GREEN (the code uses the staged-green variable although the comment says neon green); applies to the 5-cell context bar (filled = pct/20), 5h and 7d.
2. Ships its own Claude Code theme pair `theme/dopamine-dark.json` and `dopamine-light.json` (a `base` plus `overrides` of Claude Code theme keys such as `claude`, `success`, `error`, `userMessageBackground`); `theme/sync.sh` copies the one matching macOS appearance (`defaults read -g AppleInterfaceStyle`) into `~/.claude/themes/dopamine.json`. Statusline itself has one palette.
3. Truecolor `38;2` and 16-colour white for brackets; no downsampling, no NO_COLOR.
4. Foreground-only, except the last-user-prompt line which has a filled background (`YOU_BG`).
5. Plain text: bracketed labels `[dir]`, `[wt]`, `[model]`, spaces.
6. Hue per segment only.
7. Reads `"base"` from `~/.claude/themes/dopamine.json` and switches the "[you] last prompt" line between light and dark colours (bg #DCD2F5 / #3A2A5E, fg #2A2440 / #F4F0FF, label #0096C7 / #00E5FF) (`:48-62`).
8. Text tags `[dir] [wt]`; 4 emoji.
9. Rainbow/animation signals in the scan belong to other files; the statusline has a last-user-prompt strip styled like the transcript's user-message block.
10. Edit the script; `install.sh` and `theme/sync.sh`.

## idlepay-co/client
https://github.com/idlepay-co/client — 4 stars
Not a general statusline: a VS Code extension that installs a Claude Code statusline showing a sponsored ad (`src/statusline.ts` writes `statusLine` with `refreshInterval: 5`). Styling in `bin/idlepay-statusline.mjs:100-135`:
1. One badge plus one text: a bold ` SPONSORED ` badge with the advertiser's `badgeColorHex` as truecolor background (default amber 245,158,11), and ad text in the advertiser's `textColorHex` (white `97` if absent), bold by default. Paused state dim white link.
2. Themes: not present; colours come from the ad payload.
3. Truecolor (`48;2`/`38;2`) from validated hex; `clean()` strips control chars from ad strings (escape injection defence). No depth/NO_COLOR.
4. Badge filled; text foreground-only.
5. Single space; dim `↗` suffix when the ad has a URL (OSC 8 hyperlink).
6. n/a (badge versus text).
7. `contrastFg(bg)` picks black (30) or bright white (97) on the badge using luma `0.299r+0.587g+0.114b > 150` (`:93-95`).
8. `↗`, `⏸` only.
9. Animation signals are the extension's spinner patch, not the statusline.
10. None for the user.

## awesome-claude-statusline
https://github.com/jak-myers/awesome-claude-statusline — 4 stars
1. Fixed per component plus thresholds. Semantic theme variables in `lib/themes.sh` `apply_jakd_theme`: directory (225,187,139) tan (`lib/components/directory_info.sh:57`), git branch (127,86,50) brown, commits green (78,182,80) (`commits.sh:57`), burn rate coral (255,96,96) (`burn_rate.sh:42`); context by state: `CONFIG_CONTEXT_SAFE` (0,255,0) < 60, `_WARNING` (255,165,0) at 60-79, `_CRITICAL` (255,96,96) >= 80 (`context_usage.sh:278-282`). Labels are dim emoji with coloured values.
2. 5 themes via `theme.name` in `Config.toml`: jakd (default), classic, garden (pastel truecolor), catppuccin (Mocha hex), custom. Format: a fixed list of colour slots (`CONFIG_RED/BLUE/GREEN/.../TEAL/GOLD/PINK_BRIGHT/INDIGO/VIOLET/LIGHT_BLUE`) as raw ANSI escapes; custom theme sets them as `colors.basic.*` / `colors.extended.*` in TOML; `theme.inheritance` lets a theme extend a base.
3. Mixed: ANSI 16, 256 index (`38;5;208`), truecolor. `platform.color_support_level = "full"` setting exists; no downsampling or NO_COLOR found in `lib/config.sh` / `lib/core.sh`.
4. Foreground-only.
5. Dim `│` text separator between components (`lib/display.sh:24, 371`).
6. Separator only; each component has its own fixed colour.
7. Not present (garden/catppuccin are single palettes).
8. Emoji per component (`🗂️`, `✅`, `🔥`); no Nerd Font mode.
9. Up to 9 configurable lines (`display.lineN.components`).
10. `Config.toml`, `install.sh`, `STATUSLINE_*` env; custom colours as raw escape strings.

## javoxirjava/claude-code-statusline
https://github.com/JavoxirJava/claude-code-statusline — 4 stars
1. Fixed per segment plus thresholds (`statusline.js`): model bold cyan with cyan `◆` (`:152`), agent state yellow, directory blue (`:158`), git branch magenta, staged green `+N`, modified yellow `~N`, untracked red `?N` (`:164-167`), cost yellow (`:176`), tasks cyan, separators dim. `thresh(p)` (`:75`): >= 90 red `31`, >= 70 yellow `33`, else green `32`, used for context bar, 5h/7d bars. Effort levels get colours and a 5-dot gauge (`:78-91`): low green, medium cyan, high yellow, xhigh magenta, max bold red.
2. Themes: not present.
3. ANSI 16 only; `NO_COLOR` honoured (`:11, :21`: `paint()` returns plain text).
4. Foreground-only.
5. Dim ` · ` text separators.
6. Separator only.
7. Not present.
8. Three modes: emoji (default), Nerd Font (`CCSL_NERD_FONTS=1`), plain ASCII (`CCSL_NO_EMOJI=1`) via `icon(emoji, nerd, plain)` (`:22`).
9. Dot gauge for effort; adaptive line count (`CCSL_LINES`, `COLUMNS`).
10. Env variables: `CCSL_HIDE`, `CCSL_BAR_WIDTH`, `CCSL_LINES`, `CCSL_NO_EMOJI`, `CCSL_NERD_FONTS`, `NO_COLOR`; Node/bash/PowerShell installers.

## ClaudeStatusLineWidgets
https://github.com/JerrettDavis/ClaudeStatusLineWidgets — 4 stars
Widget-based statusline (62 widgets, an ink TUI configurator, and a native Mod renderer).
1. Per widget, user-assignable: each widget has `getDefaultColor()` (most return `"default"`; separator `"dim"`) and `supportsColors()` (model and branch: true; context bar and cache TTL: false, they self-colour). Self-colouring is by threshold: context bar `clamped > 80 ? red : > 60 ? yellow : green` (`src/widgets/helpers.ts:76`); cache TTL goes green, yellow, red as expiry nears (README; `formatCache`, not read).
2. Themes: not present as such (the scan's "catppuccin" hit is incidental); colour is a per-widget setting.
3. 14 named ANSI colours only (`src/colors.ts` `COLOR_CODE_MAP`: red green yellow blue magenta cyan white gray + 6 bright). No hex, no depth detection, no NO_COLOR.
4. Foreground-only.
5. Dim ` | ` text separator widget (`SeparatorWidget.ts`); `" | "` dim in the Mod path too.
6. Separator only.
7. Not present.
8. Unicode/emoji; mod path renders tokens as ink `Text` with `color`/`dimColor` and OSC 8 hyperlinks (`colors.ts` `hyperlink`).
9. Two render paths from one token list: ANSI string (`tokensToAnsi`) and ink elements (`renderer-mod.ts`).
10. JSON settings, interactive ink TUI with an "Edit Colors" screen (`src/tui/components/ColorMenu.tsx`: pick a widget, pick one of 15 named colours), CLI `ccfooter-config`.

## claude-code-arcade
https://github.com/jystervinou/claude-code-arcade — 4 stars
Statusline that is an animated arcade/aquarium game; `statusline.sh` just prints the frame a daemon (`arcaded.js`) renders.
1. Fixed per game entity, not per statistic: Ms. Pac-Man yellow `\x1b[93m`, ghosts bright red / magenta / cyan / 256-colour orange `38;5;208` (`arcaded.js:138`), frightened bright blue, HUD bold bright white, water dim white; every scene paints on a 256-colour black background `48;5;16` (`:133-136`, comment: Terminal.app has no truecolor). Aquarium water dim cyan `0;2;36`, safari ground dim yellow. WOPR scene uses `38;5;117` phosphor on/`38;5;110` dim (`:274-275`).
2. Themes: not present (scene palettes).
3. ANSI 16 bright variants plus a few 256-colour indexes, chosen deliberately for macOS Terminal.app compatibility; no detection or NO_COLOR.
4. Both: explicit black cell background for game scenes, fg elsewhere.
5. Not present.
6. n/a.
7. Hard black background so the sprites read regardless of terminal theme.
8. Custom sprite font installed to the user font dir (README: "one font file in your user font dir"); games drawn in glyphs.
9. Animation daemon at fixed frame rate; per-session cabinets keyed by `session_id`.
10. `arcade` CLI (`arcadectl.js`): on/off switch, game selection.

## claudebar
https://github.com/LabLeaks/claudebar — 4 stars
Not a Claude statusline: a Go tmux wrapper that runs Claude Code in a tmux session with a bottom status bar and menu. Styling is tmux `#[fg=...]` hex: status bar `bg=#1a1a2e,fg=#e0e0e0` (`tmux.go:211`), title `#00d4ff` on `#16213e`, usage % coloured green `#00ff88` <= 50, yellow `#ffd700` > 50, red `#ff6b6b` > 80 (`status.go:48-54`), peak hours red `#ff6b6b` / off-peak green, router tag `#b388ff`, shortcut hints each with its own hex (`tmux.go:217`). Fixed palette, foreground-only text on a filled bar, plain space separators, no themes (the scan's "catppuccin" hit was incidental), no NO_COLOR.

## levz0r/claude-code-statusline
https://github.com/levz0r/claude-code-statusline — 4 stars
Two statuslines: `classic` (Bash/PowerShell) and `adaptive` (Python).
1. Classic (`statuslines/classic/statusline.sh:110-150`): fixed ANSI 16: directory green, branch magenta, upstream cyan, model magenta, tokens yellow, cost green; git status colour is state: red when dirty, green when clean (`:99-105`). Adaptive (`statuslines/adaptive/statusline.py:168-300`): fixed per role from the palette: path blue bold, worktree teal, branch mauve, dirty `●` yellow, untracked `?` muted, ahead `↑` green, behind `↓` red, `+N` green / `-N` red, agent teal, effort muted, PR `#N` mauve, vim INSERT peach else blue, cost green; context bar and 5h/7d: green < 60, peach < 85, red.
2. Adaptive has exactly two semantic palettes (`:35-39`): dark = Kanagawa dragon (blue #8ba4b0, mauve #a292a3, green #87a987, peach #b6927b, red #c4746e, yellow #c4b28a, teal #8ea4a2, muted #737c73, text #c5c9c5), light = Catppuccin Latte (blue #1e66f5, mauve #8839ef, green #40a02b, peach #fe640b, red #d20f39, yellow #df8e1d, teal #179299, muted #6c6f85, text #4c4f69). Not user-extensible except by editing the file.
3. Classic: ANSI 16. Adaptive: truecolor `38;2` via `fg(hex)`; no downsampling, no NO_COLOR.
4. Foreground-only.
5. Classic: text; adaptive: muted ` │ ` (`SEP`, `:55`), segments wrap to new rows on narrow panes.
6. Separator only.
7. Adaptive follows the macOS appearance: `is_light()` reads `AppleInterfaceStyle` from the global preferences plist; `STATUSLINE_THEME=light|dark` overrides; other OS defaults to dark (`:18-30`). Palettes were chosen per mode.
8. Nerd Font glyphs in adaptive (branch, agent icons).
9. Light/dark palette pairing is the notable point.
10. Environment `STATUSLINE_THEME`; edit the script.

## pi-hud-footer
https://github.com/liao666brant/pi-hud-footer — 4 stars
not a Claude statusline: an extension for the `pi` coding agent (earendil-works/pi) that draws a Claude-HUD-style footer. For reference, its styling uses semantic theme roles from pi's own theme (`theme.fg("accent"|"success"|"warning"|"error"|"muted"|"dim", ...)`, `extensions/hud-footer/render.ts`): context bar `success` < 70%, `warning` >= 70%, `error` >= 90%; cache hit-rate `success` >= 50%, `warning` > 0, else `dim`; styles `classic` and `border`.

## miluer-tcq/cc-statusline
https://github.com/Miluer-tcq/cc-statusline — 4 stars
1. Fixed per segment role within each theme, truecolor (`scripts/statusline.sh:42-153`, `load_theme`): each theme defines `COLOR_MODEL, _EFFORT, _THINK, _FAST, _PERM_AUTO/_PLAN/_DEFAULT, _ACTIVE, _VERSION, _CONTEXT, _SKILLS, _MCP, _CWD, _GIT, _CTX_TOKENS, _SUM_TOKENS, _DURATION, _COST, _TEXT, _MUTED` plus four state colours `COLOR_OK/CAUTION/WARN/DANGER`. State colours by percent (`pct_color`, `:238-252`): >= 90 DANGER, >= 70 WARN, >= 50 CAUTION, else OK; also git: `✓` OK, `+N` OK, `-N` DANGER, `?N` WARN.
2. 4 bundled themes: aurora (default, blue-purple), sunset (ambers/oranges), ocean (teals/blues), mono (greys). Themes are a `case` in the shell script; `themes/*.json` only hold id and labels. In the mono theme the states are separated by lightness (OK 240 grey to DANGER 120 grey), in the other three by hue. Users select via `CC_STATUSLINE_CUSTOM_THEME` naming a built-in; no user-defined palette format.
3. Truecolor `38;2` only; no downsampling, no NO_COLOR.
4. Foreground-only.
5. Muted ` │ ` text separator (`SEP`, `:347`).
6. Separator only; segments are different hues inside a theme.
7. Not present.
8. Three icon sets in `icons/*.json`: classic, developer, minimal (`load_icons`, `ICON_STYLE` third arg); emoji.
9. Presets for layout (`full`, `minimal`, `developer`, `custom`) and custom three-line layouts via `CC_STATUSLINE_CUSTOM_LINE_1..3`; a theme-and-icons preview SVG (`assets/screenshots/theme-and-icons.svg`).
10. Positional args `preset theme icon_style`; env `CC_STATUSLINE_CUSTOM_THEME|ICON_STYLE|LAYOUT_MODE|LINE_N`; install/activate scripts for macOS/Linux/Windows.

## mkalkere/claude-statusline
https://github.com/mkalkere/claude-statusline — 4 stars
1. Per-key role in each theme dict (`claude_statusline/themes.py`), ANSI 16 constants: `separator`, `label` bright black; `value` white; `cost` yellow; `branch_main` green, `branch_feature` yellow; `added` green, `removed` red; `model` bright magenta; latency/sessions/speed/agent cyan; vim normal blue / insert green; effort high..max bright magenta, low bright black; git conflict bright red; rate-limit `ok` green, `warn` yellow, `danger` bright red. Bar colour by state (`bar.py:14-36`): green <= 60, yellow < 85, red >= 85.
2. 8 built-in themes: default, minimal, powerline, nord, tokyo-night, gruvbox, rose-pine, focus. Format: dict with `separator`, bar glyphs, `line1`/`line2` section lists and a `colors` map of ~40 semantic keys. All colours are the 16 ANSI constants, so the "nord" etc. themes remap ANSI slots (e.g. nord value = bright cyan, model = bright cyan) rather than carry hex. User theme: `~/.claude/claude-status-theme.json` with `base` plus overrides of `colors` (names such as `bright_cyan`, or raw escape strings), separator, bar glyphs, any `lineN` lists (`themes.py:527-600`).
3. ANSI 16 (names or raw escapes). `NO_COLOR` honoured and `FORCE_COLOR` overrides it (`colors.py:5-9, 62-66`). No depth detection.
4. Foreground-only (powerline theme uses only the arrow glyph in fg colour, no bg fill).
5. Theme `separator` string: `" │ "`, `" "`, or `"  "` in the powerline theme, all coloured `separator` (bright black).
6. Separator only.
7. Not present beyond the terminal's own ANSI palette.
8. Unicode bars (`█░`, `●·`); one Nerd Font glyph in the powerline theme; 2 emoji.
9. Sections can "spill" between rows when they do not fit (`spill: True`); SVG renderings per theme (`assets/themes/*.svg`, `scripts/render_svg.py`).
10. Config via CLI flags/env and the custom theme JSON; env `NO_COLOR`/`FORCE_COLOR`.

## garrys-count
https://github.com/mrieck/garrys-count — 4 stars
1. Colour by count tier, one colour for the whole line (`scripts/statusline.sh:57-70`): bold green < 1000 lines, bold yellow >= 1000, bold red >= 5000, bold magenta >= 10000; the working directory is fixed orange `38;5;208` (`:75`).
2. Themes: not present.
3. ANSI 16 bold plus one 256 index; no detection, no NO_COLOR.
4. Foreground-only.
5. A single space between the count and the directory.
6. n/a (two chunks, count and directory, different colours).
7. Not present.
8. None in the rendering.
9. Tier names in comments ("warming up", "cooking", "on fire", "legendary").
10. `~/.claude/garryscount/config.json`: `reset_hour`, `label`, `show_directory` (no colour options).

## claude-progressbar
https://github.com/mvrozanti/claude-progressbar — 4 stars
Statusline plugin that draws one progress bar per running Bash command (can wrap claude-hud above it).
1. Not per segment: bars are the accent colour of ANSI index 12 (`c12` bright blue) normally and `dim` when the run is stale/quiet (`scripts/claude_progressbar/draw.py:127`); text parts use `dim`. Style strings are `b`, `dim`, `cN`, `F#rrggbb`, `B#rrggbb` tokens (`draw.py:68-88` `sgr`), so truecolor is available but the stock styles mostly use ANSI indexes.
2. Themes: not present; 12 bar "styles" (`rise` default, `field`, `dots`, `rail`, `graph`, `digits`, `ruler`, `segments`, `countdown`, `history`, `today`) differ by glyph, not colour. `--palette FILE` reads a kitty colour file: the `field` style takes its accent from `color12` and its track from `background` (README Options).
3. ANSI index (`30+n` / `82+n` for bright) and truecolor hex tokens; no NO_COLOR or depth detection seen.
4. Foreground-only (Braille/blocks).
5. Not present (bars stand alone; wrapped statusline sits above).
6. Rows only.
7. Optional kitty palette so the accent matches the terminal; otherwise relies on ANSI index 12.
8. Braille and block glyphs (`EIGHTHS`, braille cells), spinner; unicode only.
9. Animated styles (rolling wave, twinkling dot field) redrawn each refresh (`refreshInterval: 1`); overtime and `quiet` markers; goldens test pins exact bytes.
10. CLI flags `--style`, `--max-rows`, `--wrap`, `--palette`; `/progressbar:setup`.

## claudewatch
https://github.com/nitintf/claudewatch — 4 stars
1. By role from the theme, all in one statusline (`internal/statusline/statusline.go:71-190`): model name `Accent` inside muted brackets, plan `Fg`, `ctx`/`5h`/`7d` labels `Muted`, cost value `Fg`, cwd and branch `dim`+`Muted`. Bars and percentages by state (`barColor`, `:205-214`): >= 80 `Error`, >= 50 `Warning`, else `Info`.
2. 10 built-in TOML themes (`internal/theme/builtin/`): catppuccin-latte, catppuccin-mocha, dracula, gruvbox, nord, one-dark, rosepine, solarized-dark, solarized-light, tokyo-night. Format is semantic roles `[colors] bg fg accent success warning error info muted` as hex, plus `[separators]` (powerline glyphs left/right/thin) and `[icons]` (Nerd Font codepoints model/context/cost/tools/warn/ok) (`theme.go:17-60`). Users add `~/.config/claudewatch/themes/<name>.toml`, checked before built-ins (`Load`); config key `theme = "tokyo-night"`.
3. Truecolor hex only (`fg()` emits `38;2;r;g;b`); no downsampling, no NO_COLOR.
4. Foreground-only in the renderer; `Bg` role is defined but not used by `Render`.
5. Plain dim muted ` | ` (`:72`). The theme's powerline `[separators]` are defined but the renderer does not use them (no reference in `statusline.go`).
6. Separator only.
7. Both `-latte` and `solarized-light` themes exist for light terminals; no runtime detection.
8. Nerd Font icons for cwd (``) and branch (``) hard-coded; theme `[icons]` mostly unused in `Render`; bars use `█░`.
9. `Info` is the calm colour rather than green; mini 3-cell bars.
10. TOML config `~/.config/claudewatch/config.toml` (`theme`, `show_*` toggles via `config.Enabled`), `/claudewatch:config` slash command.

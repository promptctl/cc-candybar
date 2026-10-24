# How Claude Code statuslines do colour and styling

The usual statusline gives each segment a fixed colour and recolours it by state. Only 68 (5%) of system-tier statuslines step lightness between neighbours and 33 (2%) alternate two shades, almost all of them on background-filled bars, and those few are the projects most worth reading for cc-candybar's choices.

## What was surveyed, and how

Discovery found 9,558 projects ([discovery-github.md](discovery-github.md), [discovery-registries.md](discovery-registries.md), [discovery-web.md](discovery-web.md)). A script read each one's statusline files and sorted them into tiers ([all-projects.md](all-projects.md)): *system* (themes, palette files or colour config), *hardcoded* (colours written in code), *nocolor*, and *irrelevant*. Agents then read the code of every system-tier project (1,703), the 77 hardcoded-tier projects with 20 or more stars, and a seeded random sample of 100 of the 4,394 hardcoded-tier projects, the long tail. Firecrawl was used for exactly 20 searches, for discovery only.

Not every project read turned out to be a statusline. Of the 1,703 system-tier projects, 1,386 are; the rest are 239 other things (menu-bar apps, Waybar modules and the like), 67 forks described only by their differences, 9 copies and 2 unreachable. The sample holds 94 statuslines (4 others, 2 fork diffs) and the popular hardcoded set 72 (5 others). Every count below is over the statuslines only, copied from [tally.txt](tally.txt). Percentages from the sample stand for the whole hardcoded tier, with the caveat that the sample is 100 projects. A project can use several methods at once, so percentages in a column add up to more than 100.

Exemplars name their deep file and the code anchor the reader recorded there; each `deep/*.md` section heading is the project's name.

## How a segment gets its colour

| method | system tier (1,386) | hardcoded sample (94) | hardcoded, 20+ stars (72) |
|---|---|---|---|
| state: value or threshold | 1181 (85%) | 83 (88%) | 52 (72%) |
| fixed: each segment type has its own colour | 732 (53%) | 64 (68%) | 38 (53%) |
| role: segment maps to a theme role | 288 (21%) | 1 (1%) | 8 (11%) |
| user: config sets every colour, no default | 171 (12%) | 2 (2%) | 4 (6%) |
| position: place on the bar | 112 (8%) | 3 (3%) | 1 (1%) |
| single: one colour for everything | 53 (4%) | 4 (4%) | 4 (6%) |
| none | 51 (4%) | 1 (1%) | 6 (8%) |

The typical statusline is `fixed+state`: 538 system-tier statuslines, 51 in the sample and 27 of the popular hardcoded ones are exactly that combination. State colouring is nearly always a context-percent ladder of green, yellow and red.

- **Fixed.** jarrodwatts/claude-hud (28,844 stars) fixes model cyan, project yellow and git magenta by default, colours context by threshold, and lets the user override each colour in `claude-hud.json` (`deep/tophard-01.md`; `src/render/colors.ts:93-127`, `getContextColor` `:131-141`, overrides `src/config.ts:82-93`). The long tail looks the same: mttmcknn/prism has dir cyan, model magenta and a context bar red at 90 and yellow at 70 (`deep/sample-3.md`; `internal/statusline/statusline.go` l.468-476).
- **State only.** ccusage colours one thing, the context percent, and leaves every other segment uncoloured (`deep/tophard-01.md`; `rust/crates/ccusage/src/commands/mod.rs:704-711`).
- **Role.** CCometixLine gives every metric a category (Identity, Vcs, Context, Quota, Cost…) that maps to a palette token, and maps severity to `ok`/`warn`/`crit` tokens (`deep/batch-01.md`; `src/style/palette.rs` L8-23, `skin.rs` L168). saarshe/claude-code-statusline has seven roles (Primary, Secondary, Accent, Success, Warning, Danger, Muted): model and directory are Primary, branch Accent, cost Secondary (`deep/batch-06.md`; `theme/theme.go`, `components/format.go:23-33`).
- **Position.** ccstatusline keeps a default colour per widget but, in powerline mode, colours by slot: `themeColors.fg/bg[widgetColorIndex % length]` (`deep/batch-01.md`; `src/utils/renderer.ts` L317-330).
- **User.** cship ships no palette at all; every module's `style` string is the user's (`deep/batch-02.md`; `src/config.rs:60,78,113`).
- **Single.** ykdojo/claude-code-tips puts one user-chosen accent on the model name and the filled bar cells and greys everything else (`deep/tophard-01.md`; `scripts/context-bar.sh:5-21`).

Position and role are system-tier methods; the hardcoded sample barely uses them. They are also more common among background-filled bars: of the 324 system-tier statuslines with filled cells, 80 (25%) colour by position and 86 (27%) by role.

## Telling neighbours apart, fill, and separators

Most bars are coloured text on the terminal's own background: fill is foreground-only in 1026 (74%) of system-tier statuslines, in 86 (91%) of the sample and in 63 (88%) of the popular hardcoded set. Filled cells appear in 251 (18%) system-tier statuslines that offer both modes and 73 (5%) that fill only. Separators are mostly text too: plain text such as ` | ` in 1044 (75%) of the system tier, none in 224 (16%), powerline arrows in 175 (13%) and end caps in 86 (6%). In the sample, text separators are 73 (78%) and powerline 2 (2%).

| how neighbours differ | system tier (1,386) | system, filled cells (324) | hardcoded sample (94) | hardcoded, 20+ stars (72) |
|---|---|---|---|---|
| separator | 810 (58%) | 154 (48%) | 54 (57%) | 47 (65%) |
| hue | 698 (50%) | 215 (66%) | 46 (49%) | 31 (43%) |
| none | 265 (19%) | 42 (13%) | 22 (23%) | 12 (17%) |
| lightness steps | 68 (5%) | 58 (18%) | – | – |
| alternating two shades | 33 (2%) | 33 (10%) | – | – |

Every alternating bar and 58 of the 68 lightness-stepped ones fill their cells; neither method appears in the hardcoded tier. The common case, different hue plus a separator, is 401 system-tier statuslines.

The powerline arrow's colours are settled across the field: the arrow takes the left cell's background as its foreground and the right cell's background as its own, as in ccstatusline (`deep/batch-01.md`; `renderer.ts` L595-676). The methods other than hue:

- **Lightness steps by position.** goccc cycles five Dracula slates (`#383a4c` to `#5a5e7a`) by visible position, so adjacent blocks differ by a small step (`deep/batch-03.md`; `styleSegments`, `statusline_config.go:183-208`). bsmr/claude-cli-status-bar rotates nine greys (232–240) one slot per visible segment, and starts each row two slots lighter than the one above (`deep/batch-11.md`; `PaletteStride` in `internal/pkg/render/render.go defaultConfig`).
- **Lightness steps by fixed assignment.** hazline's haz-tokyo-night puts "each segment on its own step of the background ramp so the powerline arrows read as depth", with the accent carried only by text and icons (`deep/batch-40.md`; `theme_haz_tokyo_night.rs:1-6`).
- **Lightness as hierarchy, no fills.** opezero/claude-status-line states the rule in its theme header: colour means danger only, and hierarchy is bold, normal, dim (`deep/batch-24.md`; `internal/statusline/theme.go`).
- **Alternating two shades.** dukechain2333/cc-status-band alternates tones `a` and `b` by segment index, "so neighbouring chips stay distinct" (`deep/batch-21.md`; `core/band.js:325-327`). Demogorgon314/cc-statusline alternates two backgrounds along the default order "so each arrow shows" (`deep/batch-41.md`; `themes.rs` ~180).
- **A rule for equal neighbours.** When two neighbours share a background the arrow vanishes, and several bars switch to a thin divider: goccc draws `│` (`deep/batch-03.md`; `:224-225`), zpiao1/m3-terminal-theme a thin chevron in the outline colour (`deep/batch-67.md`; `statusline-command.sh:140-160`), and gccusage measures it, falling back to `│` when the CIEDE2000 distance between adjacent backgrounds is under 8 (`deep/batch-45.md`; `src/render/color-compare.ts`).

## Themes, colour depth, and light/dark

Bundled themes are a system-tier habit: 584 (42%) of system-tier statuslines ship them and 214 (15%) let users define their own, against 4 (4%) and 1 (1%) in the sample and 13 (18%) and 5 (7%) of the popular hardcoded set. Among the system tier's themes, 278 are sets of semantic roles, 175 are per-segment colour maps and 128 are named colour lists that segments index into.

| colour depth | system tier (1,386) | hardcoded sample (94) | hardcoded, 20+ stars (72) |
|---|---|---|---|
| 16 colours | 808 (58%) | 66 (70%) | 41 (57%) |
| hex / truecolor | 618 (45%) | 24 (26%) | 24 (33%) |
| 256 colours | 542 (39%) | 33 (35%) | 29 (40%) |
| honours NO_COLOR | 226 (16%) | 9 (10%) | 8 (11%) |
| detects depth | 129 (9%) | 2 (2%) | 2 (3%) |
| downsamples | 84 (6%) | 1 (1%) | 1 (1%) |

Two approaches to lower depths recur. claude-powerline and ccstatusline hand-author every theme three times, for truecolor, 256 and 16 colours (`deep/batch-01.md`; claude-powerline `getTheme`, `themes/index.ts` L137-152; ccstatusline `src/utils/colors.ts` L332-490). callmemorgan/claude-statusline instead computes nearest 256 and 16-colour matches from hex, and its depth detection carries a warning worth knowing: Claude Code may strip `COLORTERM` from the subprocess environment (`deep/batch-08.md`; `internal/palette/depth.go`).

| light/dark | system tier (1,386) | hardcoded sample (94) | hardcoded, 20+ stars (72) |
|---|---|---|---|
| none | 1054 (76%) | 87 (93%) | 71 (99%) |
| ships light themes | 175 (13%) | – | – |
| picks readable text per background | 160 (12%) | 5 (5%) | 1 (1%) |
| detects the terminal background | 115 (8%) | 2 (2%) | – |

Detection is rare and has to work around the statusline having no terminal of its own. The Chris7Ji gist chains an override variable, then `COLORFGBG`, then the Ghostty config's background luminance or theme name, then Claude Code's own `theme` setting, defaulting to dark (`deep/batch-28.md`; `detect_dark_mode()`, palettes at `install-statusline.sh` lines 160-182). cody-xue/cc-statusline queries the background with OSC 11 from the shell rc, "because a statusline child has no tty" (`deep/batch-39.md`; `--probe-bg`). agukov-dev/token-meter reads the Claude Code theme name to choose its grey (`deep/batch-34.md`; `statusline/statusline.mjs`), and thefuga/claude-x draws every colour from a key of Claude Code's own theme, so it follows `/theme` in light or dark (`deep/batch-27.md`; `mods/statusline/hooks/theme.ts`).

Computed text contrast is the other adaptation. CCometixLine shades text toward its target until it reaches 4.5:1, and recolours a severity on a filled cell as text when that reads at 3:1, otherwise as the background (`deep/batch-01.md`; `skin.rs` L182-205, L243-297). jonyfs/statusline tests that every chip in every palette reaches 4.5:1 (`deep/batch-49.md`; `src/contrast.js`).

## What bears on neighbours, keystones, open menus, and per-segment colour

**Lightness steps or alternating shades.** Both are used almost only on filled cells, and the projects that use them say why in their code. The KawaiiLLM fork of claude-powerline replaced per-segment backgrounds with a three-step position cycle (`#1a1a1a`, `#2a2a2a`, `#3a3a3a`) because per-name backgrounds "flatten when many segments are on", widened the range because two near-black tones barely differ in contrast, and skips alert chips and the warm directory anchor so they keep standing out (`deep/batch-50.md`; `src/powerline.ts:61-75,436-439,466-488`). nrzz/claude-code-glow steps each chip 2% further from the background toward the foreground, mixing at t = 0.10, 0.12 … 0.22, which on a light theme means darker (`deep/batch-56.md`; `src/theme-gen.mjs:175`). Alternation shows its weakness where it is fixed rather than counted: powerline-claude alternates two catppuccin backgrounds by fixed assignment to segment families, so whenever the chosen modules put two of the same shade side by side its renderer draws a thin glyph instead of the arrow (`deep/batch-37.md`; `src/segments.rs:90-150`, `render.rs`). The claude-code-status-line crate assigns one of two colourways to each section in `colors.json`, dark on orange or orange on dark, and the default order alternates them (`deep/batch-28.md`; `src/colors.rs`, `colors.json`).

**Whether hiding a segment recolours the others.** Position-counted schemes count only what is drawn: ccstatus-rs takes `theme[slot % len]` where the slot counts rendered widgets only, and bsmr likewise gives hidden segments no slot, so every later neighbour stays distinct but shifts colour (`deep/batch-55.md`; `src/main.rs:76-90`; bsmr's anchor is above). claude-norns-statusline keys its alternating tints by segment name, so a segment keeps its tint when others hide (`deep/batch-40.md`; `renderer.ts:44-52`). tylergraydev/claude-code-tool-manager shows the cost of fixed per-type backgrounds with no alternation: model and cwd are both blue, so if they sit side by side they merge into one block (`deep/batch-02.md`; `get_powerline_default_bg`, `src/services/statusline_writer.rs:688-699`).

**Keystones.** In the projects found that reserve an accent for one segment, the segment is usually the model. tidepool alternates `seg` and `segAlt` (`#2A2D35`, `#3A3E46`) and puts the model on `accent` (`deep/batch-37.md`; `statusline/render.mjs`). adlakhavansh/clawline alternates `bg.base` and `bg.alt` and always gives the model `bg.accent`, and its alternation counter skips the model so the shades either side still alternate (`deep/batch-34.md`; `src/style.mjs`). cc-status-band and claude-code-glow do the same (anchors above; glow's model chip at `src/render.mjs:164-168`). goccc keeps its accents (a cap and a pet segment) outside the lightness cycle, and they do not advance its counter (`deep/batch-03.md`; `powerline.go:28-31`, `statusline_config.go:183-208`). Among plain-text bars the accent is spent on one thing rather than one segment: mksglu/context-mode's comment calls its status dot the "single chromatic accent" (`deep/tophard-01.md`; `bin/statusline.mjs:82`).

**Open menus.** No row in `rows.tsv` records a menu drawn inside the bar, so the survey has no direct precedent. The menus it found are configurator TUIs outside the bar, such as ccstatusline's colour menu (`deep/batch-01.md`; `ColorMenu.tsx`) and callmemorgan's colour picker with live hover preview (`deep/batch-08.md`; `internal/tui/tui_colorpicker.go`). The nearest in-bar case is a cell changing its background on state: hazline resolves thresholds before drawing arrows, so the arrows follow the changed background (`deep/batch-40.md`; `src/core/statusline.rs:18-45`), and zpiao1/m3-terminal-theme replaces the whole pill with its warn or danger pair rather than tinting it (`deep/batch-67.md`; `m3sync/src/targets.rs:25-37`).

**Consistent colours for specific segments.** This is what the field already does: a fixed colour per segment is 732 (53%) of the system tier and 64 (68%) of the sample, and role mapping, 288 (21%) of the system tier, keeps a segment's colour stable within a theme. The projects that combine it with position colouring layer an override over the cycle: open-bbug/go-ccstatusline takes an explicit widget colour first, then the theme's positional slot, then the widget's default (`deep/batch-56.md`; `resolveSlot`, `cmd/go-ccstatusline/renderer.go:313-331`), and ccstatus-rs takes `colors[widget_name]` before the slot (`deep/batch-55.md`; `src/main.rs:76-90`). callmemorgan/claude-statusline has 15 roles and lets a per-segment override name a role instead of a colour (`model = "accent"`) (`deep/batch-08.md`; `internal/palette/themes.go` l.40-58). jonyfs/statusline enforces "one token, one meaning" with a test that fails when a segment uses a role it was not given (`deep/batch-49.md`; `src/colourRoles.js`). Colour can also identify something other than the segment: Claude-Code-Personalities and sonde colour the model by family (Opus, Sonnet, Haiku) (`deep/batch-03.md`; `statusline/mod.rs:435`; `deep/batch-17.md`; `renderer.rs:216-237`), and vtmocanu/cc-statusline hashes the session id into one of 12 project colours, with a file to pin a project (`deep/batch-08.md`; `statusline.sh` l.1332-1347).

Alert colours are the one place projects deliberately refuse the theme. infiniV/claude-usage-waybar, a Waybar module rather than a statusline, takes background, surface, text and border from the desktop theme but keeps its healthy, warn, crit and danger colours fixed, because "harvesting them from alacritty's ANSI slots broke on non-IBM themes where red means red" (`deep/batch-06.md`; `bin/claude_usage.py:198-240`). vtmocanu/cc-statusline keeps its alert green, amber and red across all 12 themes (`deep/batch-08.md`, point 1; the section gives no line for it).

## Files in this directory

- [discovery-github.md](discovery-github.md), [discovery-registries.md](discovery-registries.md), [discovery-web.md](discovery-web.md): the raw discovery lists, from GitHub, registries and awesome lists, and the wider web.
- [all-projects.md](all-projects.md): all 9,558 projects with the script's styling signals, tier, and a link to the deep section where one exists.
- `deep/`: one section per deep-read project, ten numbered points each (segment colour, themes, colour spec and depth, fill, separators, neighbours, light/dark and contrast, glyphs, other, customisation). `batch-*.md` is the system tier, `sample-*.md` the random hardcoded sample, `tophard-*.md` the hardcoded projects with 20 or more stars.
- [rows.tsv](rows.tsv): one row per deep-read project, stars first, then the coded columns defined in `tools/map-brief.md`: source, name, url, kind, seg, seg_detail, themes, depth, fill, sep, neighbours, lightdark, notable. Grep it; the free-text fields are cut to 200 characters, and the deep section holds the full reading.
- [tally.txt](tally.txt): every count in this README, produced by `tools/tally.py` over the rows.
- [analyst-brief.md](analyst-brief.md): the brief every deep-read agent followed.
- `tools/`: the pipeline (`merge.py` merges the discovery lists, `extract.py` reads each project's files, `tier.py` assigns tiers, `batch.py` splits the system tier into batches, `master.py` writes `all-projects.md`, `focus.py` cuts the rows into subsets, `tally.py` counts them) and the briefs for the map step (`map-brief.md`) and this README (`writer-brief.md`). The scripts read and write intermediates under `/tmp/ccsl/`, which is not kept here, so rerunning them starts from extraction.

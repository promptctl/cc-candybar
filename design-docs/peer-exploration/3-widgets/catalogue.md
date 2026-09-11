# A menu of widget ideas from twenty-six statuslines

Three inventories recorded what every peer project puts on the bar, project by project. This file
turns that ninety degrees: one entry per **idea**, each checked against what cc-candybar already
renders, ordered by what is worth taking rather than by who does it. An idea four projects share is
one entry naming four projects.

Most entries are `pass`. That is the finding, not a shortfall of the fold — cc-candybar already has
more display machinery than anything surveyed, so the value here is the short head of the list, not
its length.

Five projects are called "claude-statusline" upstream. Throughout, they are named by author:
**TheoBrigitte**, **m5d215**, **ersinkoc**, **rz1989s**, **kcchien**. Everything else uses its repo
name, shortened where it is unambiguous (**usage-bar** = claude-code-usage-bar, **spences10** =
claude-statusline-powerline, **claudia** = claudia-statusline, **YAS** = Yet Another Statusline).

## The shortlist

| Idea | Seen in | cc-candybar today | Verdict |
|---|---|---|---|
| A gauge whose cells are painted individually | kcchien, usage-bar, Token Tracker, + ~16 more | lacks it | take |
| A `ramp` that returns text, not colour | YAS, CCometixLine, claude-carbon, ersinkoc, tamagotchi | lacks it | take |
| A look chosen by data, not by a name | Powerline, usage-bar, coralline | lacks it | take |
| The live activity line — todo and running tool | Claude HUD, usage-bar, claude-dashboard | lacks it | take |
| Picker options painted in what they would apply | ersinkoc, usage-bar, CCometixLine, ccstatusline | adjacent | take |
| Headroom to auto-compact, not to the wall | claude-pace, YAS, claude-powerline, arcade | adjacent | maybe |
| The compaction itself, shown | claudia, ccstatusline | lacks it | maybe |
| A colour hashed from the session id, and a generated title | which-claude-code | adjacent | maybe |
| Idle, warming up, or actually burning | coralline | adjacent | maybe |
| Degrade a segment in steps before dropping it | Powerline, Token Tracker, ccstatusline, TheoBrigitte | adjacent | maybe |
| Column alignment across stacked rows | ccstatusline, Claude HUD, claude-pace | lacks it | maybe |
| Claude service status, with a 48-hour incident strip | ccstatusline, TheoBrigitte | lacks it | maybe |
| A staleness marker on a number that could not be refreshed | usage-bar, ersinkoc, Claude HUD, spences10 | adjacent | maybe |
| A wall-clock expiry instead of a countdown that ages | Claude HUD | has it (the countdown) | maybe |
| MCP and environment health | Claude HUD, claude-dashboard | lacks it | maybe |
| The subagent statusline, as its own render target | m5d215, coralline, YAS | lacks it | maybe |
| Named fill/empty glyph vocabularies | claude-powerline, cship, usage-bar, TheoBrigitte | adjacent | pass |
| The gradient level as a theme-owned mapping | Powerline | has it | pass |
| Budget against a configured limit | claude-dashboard, ersinkoc, claude-powerline | has it | pass |
| Hide at zero | kcchien, ccstatusline, Powerline | has it | pass |
| Inverted thresholds — high is the good end | cship, usage-bar, claude-dashboard, coralline | has it | pass |
| The git diffstat symbol vocabulary | claudia, spences10, Token Tracker, gitui | has it | pass |
| One glyph, three meanings carried by colour | claudia, coralline | has it | pass |
| Model-name shortening and alias maps | ccusage, Claude HUD, CCometixLine | has it | pass |
| Directory shortening, forge icons, breadcrumb cells | m5d215, Powerline, coralline, which-claude-code | has it | pass |
| The Anthropic peak-hours window | claude-dashboard | adjacent | pass |
| Effort, thinking, vim mode, output style, agent name | ccstatusline, claude-dashboard, Claude HUD, + ~9 more | adjacent | pass |
| Cache hit rate as a percentage | claude-dashboard, coralline, rz1989s, spences10 | adjacent | pass |
| Pace as a signed percentage | claude-pace, cship | has it (as a time) | pass |
| Two independently-computed costs side by side | ccusage | adjacent | pass |
| Host-machine and world readouts | Powerline, ccstatusline, Claude HUD, rz1989s | adjacent | pass |
| Starship passthrough | cship | adjacent | pass |
| Bordered grid panels with breakpoints | claude-powerline, YAS, arcade | lacks it | pass |
| The bar as a game | arcade, tamagotchi | lacks it | pass |
| Long-horizon heatmaps and calendars | Token Tracker, ersinkoc | lacks it | pass |
| Config errors, update nudges, install drift | YAS, claude-carbon, usage-bar, CCometixLine | has it | pass |
| Wizards, TUIs and preview commands | ccstatusline, CCometixLine, coralline, cc-statusline | has it | pass |

## The ideas

### A gauge whose cells are painted individually

- **What it is:** a fixed-width run of block glyphs — ten cells is the near-universal choice — where
  the *fill* is a proportion and each filled cell carries its own colour. kcchien paints all ten
  cells along a fixed green→yellow→orange→red RGB array, so a half-full bar reads two-toned rather
  than one flat colour, and falls back to a single ANSI colour when truecolor is unavailable.
  usage-bar anchors the leftmost cell at the exact severity colour and blends 35% toward black
  toward the tip. Token Tracker tints the *empty* cells in the same hue instead of leaving them
  neutral grey.
- **Seen in:** kcchien (`statusline.sh:151-197`), usage-bar (`src/claude_statusbar/progress.py`),
  Token Tracker (`src/token_tracker/templates/claude_statusline.py:61-73`), and a plain flat-colour
  version in roughly sixteen others — claude-powerline (`src/segments/context.ts`), cship
  (`src/modules/context_bar.rs`), Claude HUD (`src/render/colors.ts`), claude-dashboard
  (`scripts/utils/progress-bar.ts`), coralline (`seg_ctx`, `make_bar` in `statusline.sh`),
  claude-pace (`claude-pace.sh:157-198`), TheoBrigitte (`main.go`), cc-statusline
  (`generateContextBashCode` in `src/generators/bash-generator.ts`), claudia (`src/display.rs`),
  YAS (`README.md`), ersinkoc (`_render_progress_bar`), claude-carbon
  (`scripts/statusline.sh:99-116`), ccstatusline (`src/widgets/shared/progress-bar.ts`).
- **cc-candybar today:** lacks it. It draws exactly one mini-graph, the eight-level sparkline in
  `src/template-engine/sparkline.ts`, which shows *shape over time* and normalises against its own
  window — the opposite of a gauge, which shows one value against a fixed maximum. Threshold
  display is colour instead: `ramp` paints the whole cell (`context`, `block`, `weekly` in
  `src/config/default-dsl-config.ts`). `repeat` from sprigStrings would build a monochrome bar by
  hand, at the cost of the cell arithmetic in every template that wants one.
- **Worth taking:** take. This is the one display form every peer has and cc-candybar has none of,
  and the painted-cell version is a form no peer except kcchien reaches. Build a `gauge` template
  function beside `sparkline` — same seam, same purity (value, max, width, glyph pair in; a
  `RichText` out) — and colour each cell by running the existing `ramp` at that cell's own position
  rather than at the value. `ramp` already does linear OKLCH interpolation between stops, so the
  gradient is free; the function only has to decide how many cells are lit.

### A `ramp` that returns text, not colour

- **What it is:** a threshold cascade whose output is a *word or glyph*. YAS morphs one word through
  `Smart → Coasting → Foggy → Cooked → Dumb` at four configurable ascending thresholds (25/50/70/90%)
  and tints it the same colour as the bar. CCometixLine makes the icon itself the gauge: eight
  Nerd Font pie-slice codepoints, one per ~12.5% band, so the icon fills like a clock face with no
  bar beside it. claude-carbon replaces the percentage *number* with the literal word `COMPACT!`
  at ≥80%. ersinkoc maps data freshness onto 🟢 LIVE / 🔵 NEW / 🔄 DB / 🔴 EXPIRED; tamagotchi runs a
  mood ladder 😴/🤒/😊/🙂/😐/😢 off one 0–100 stat.
- **Seen in:** YAS (`claude/yas/constants.py`), CCometixLine (`src/core/segments/usage.rs`),
  claude-carbon (`scripts/statusline.sh:99-116`), ersinkoc (`_get_status_indicator` in
  `claude_statusline/statusline.py`), tamagotchi (`src/engine/PetEngine.ts:349-359`).
- **cc-candybar today:** lacks it. `ramp` (registered in rich-js `paletteFuncs`, used throughout
  `src/config/default-dsl-config.ts`) maps a number onto ordered colour stops and returns `#RRGGBB`
  only. Every text-side threshold in the bundled default is therefore a nested `if` chain — see
  `cacheTimer`'s `fg:`, three levels deep for `error`/`warning`/`foreground`, and the same shape
  again inside its template for `cold` vs `Nm`.
- **Worth taking:** take. The mechanism already exists and is already proven; only its output domain
  is narrow. A sibling that resolves stops to strings — `{{ pick .context.contextLeft "step" 0
  "Cooked" 21 "Foggy" 41 "Smart" }}` — collapses those if-chains, gives the gauge its glyph-band
  variant for free, and keeps the "positions must ascend, no sorting" discipline that makes `ramp`
  honest. Build: one function in `src/template-engine/funcs.ts` plus the shared stop parser.

### A look chosen by data, not by a name

- **What it is:** the *whole bar's* palette shifts when the session enters a mode. Powerline's
  `mode_translations` remaps a dozen base colours to a blue family when vim enters insert mode, so
  the entire status line changes temperature rather than just the mode segment. usage-bar sweeps its
  whole session-mode line in one of seven named two-colour gradients chosen by effort tier, and
  appends a bold red `⚠️BYPASS` at line end when permission checks are off. coralline flips the git
  pill's background colour wholesale when the tree is dirty.
- **Seen in:** Powerline (`powerline/segments/vim/__init__.py:92-114`,
  `powerline/config_files/colorschemes/vim/default.json`), usage-bar
  (`src/claude_statusbar/styles.py`), coralline (`seg_git` in `statusline.sh`).
- **cc-candybar today:** lacks it. Looks are exactly the right primitive — named OKLCH transforms
  applied in one `transposePalette` call per render — but the *selection* is a name, never an
  expression: `effectiveLookName(staged, session, globals, declared)` in `src/themes/policy.ts`
  reads a session key, then a config string, then the `"none"` floor. A click can change the look;
  a fact about the session cannot.
- **Worth taking:** take. The machinery is built and the gap is one field's type. Let `globals.look`
  (or a `look:` beside `root`) hold a template string evaluated per render like any `when`, so a
  config can say the bar goes dim while idle, or hot the moment a rate-limit window passes its
  warning threshold, or unmistakably different under bypass permissions — one expression, every
  segment recoloured coherently, no per-segment `bg:` overrides fighting the decorative vocabulary.
  Build: a compiled template in the look slot, resolved in `renderDsl` before the transpose.

### The live activity line — todo and running tool

- **What it is:** what Claude is doing *right now*, parsed live from the transcript. Three forms, all
  small: the in-progress todo as `▸ <task text> (3/7)`, switching to `✓ All todos complete (n/total)`
  when done; running tools as `◐ <tool> <target>` in yellow, capped at two, with completed tools
  rolled up by name as `✓ name×N` and a `+N more` overflow; and the slash command that opened the
  current turn as `🎯 /command-name`, cleared the moment a plain-text message arrives.
- **Seen in:** Claude HUD (`src/render/todos-line.ts`, `src/render/tools-line.ts`), usage-bar
  (`src/claude_statusbar/styles.py`), claude-dashboard (`scripts/widgets/todo-progress.ts`,
  `scripts/widgets/tool-activity.ts`, `scripts/widgets/slash-command.ts`).
- **cc-candybar today:** lacks it. The payload
  (`RenderPayload` in `src/daemon/render-payload.ts`) carries usage, cost, git, context, cache,
  speed and metrics — every number is about *how much*, none about *what*. The nearest thing is
  `metrics.messageCount`, a count of turns.
- **Worth taking:** take. This is the only genuinely new *fact* class in the whole fold, and the
  expensive half is already built: `src/daemon/cache/session-usage-store.ts` already tail-reads each
  transcript incrementally from a byte cursor, so the todo state and the last tool-use block are
  bytes it is already passing over. Build: a provider under `src/segments/` folding the same
  appended entries into `{ todo: { text, done, total }, tools: [...] }`, its projection in
  `buildRenderPayload`, and one bundled segment. Every display form above is then a template.

### Picker options painted in what they would apply

- **What it is:** each option cell in a theme picker is rendered *in that theme*, so choosing is
  looking rather than reading names. ersinkoc browses 100 generated themes in a paged,
  keyboard-driven gallery where every entry is drawn with the user's real session data. usage-bar's
  `/statusbar-preview` renders all 3 styles × 7 themes against the user's real cached stdin.
  CCometixLine and ccstatusline both keep a live preview pane updating as the edit is made.
- **Seen in:** ersinkoc (`claude_statusline/simple_theme_selector.py`), usage-bar
  (`commands/statusbar-preview.md`, `commands/statusbar-theme.md`), CCometixLine (`src/ui/events.rs`),
  ccstatusline (`src/widgets/index.ts`, `README.md`).
- **cc-candybar today:** adjacent. `src/render/picker.ts` already takes `itemStyle: (position) =>
  Style` — a per-option styling function — but every caller passes `bandItemStyle`
  (`src/render/band-style.ts`), which colours an option by its *address in the band*, not by what it
  writes. So the theme picker shows theme names in band colours, and the look picker shows look
  names unaffected by the look.
- **Worth taking:** take. The seam exists and is already a function of the option; only the function
  is generic. Give the theme picker an `itemStyle` that resolves `paletteForThemeName(optionValue)`
  (`src/themes/palette-resolvers.ts`) and paints the cell from that palette's own background and
  foreground; give the look picker one that transposes the current palette by that look's
  `ThemeKey`. Build: one or two option-domain-aware item styles, no new primitive.

### Headroom to auto-compact, not to the wall

- **What it is:** the context percentage measured against the point where Claude Code *compacts*
  rather than against the raw window size, so the number answers "how long have I got" instead of
  "how full is the buffer". claude-pace recomputes the whole bar against `CLAUDE_CODE_AUTO_COMPACT_WINDOW`
  when that env var is set, and switches the context-size label to match. YAS's fill ratio is against
  the compaction soft-limit by default. claude-powerline computes an autocompact-buffer-aware
  "usable" percentage. arcade marks the 95% auto-compact threshold with a cherry glyph (`ᐝ`) sitting
  in the maze ahead of Pac-Man.
- **Seen in:** claude-pace (`claude-pace.sh:157-198`), YAS (`README.md`,
  `claude/yas/constants.py`), claude-powerline (`src/segments/context.ts`), arcade
  (`src/themes/pacman.rs`).
- **cc-candybar today:** adjacent, and this was considered and rejected once. `src/segments/context.ts`
  carries the note: "No auto-compact buffer: that was a hardcoded guess at Claude's threshold and a
  soft second source; the native remaining_percentage is authoritative."
- **Worth taking:** maybe. The rejection was of a *guess*, and claude-pace's version is not one — it
  reads an env var the user sets, which is a fact the client can forward the way it already forwards
  `termCols` and the tmux hint. If that env var is unset there is still nothing to measure against,
  so this only earns its keep for a user who sets it. Worth a ticket, not worth inventing a
  threshold for.

### The compaction itself, shown

- **What it is:** the compaction event as display state, not just a percentage that suddenly drops.
  claudia's context bar has three renderings: `Compacting...` as static text with no bar at all
  (the tool's own reasoning: the bar cannot animate fast enough to be worth drawing);
  `NN% [====>----] ✓` with a green check for the compaction that *just* happened; and the normal
  bar with an `⚠` only when approaching the threshold. ccstatusline counts them instead — `↻ N`
  parsed from `compact_boundary` transcript markers, with an optional `(1 auto, 1 manual)` split and
  an optional `↓120K` reclaimed-tokens suffix, hidden entirely at zero.
- **Seen in:** claudia (`format_context_bar` in `src/display.rs`), ccstatusline
  (`src/widgets/CompactionCounter.ts`).
- **cc-candybar today:** lacks it. `context` in `src/config/default-dsl-config.ts` is a stateless
  function of `.context.contextLeft`; a compaction shows up only as the number jumping.
- **Worth taking:** maybe. The counter half is cheap — `compact_boundary` markers are in the same
  appended bytes the usage store already reads. The three-state bar is the more interesting half and
  the weaker case: it needs a "recently" window, which is a clock in the render path, and
  cc-candybar keeps its derived state incremental rather than time-decayed. Take the counter, leave
  the transition state until something else wants a recency window.

### A colour hashed from the session id, and a generated title

- **What it is:** two halves of one idea — making parallel panes tell themselves apart. The colour:
  `cksum session_id % 20` picks one of twenty fixed 256-colour codes, so two concurrent sessions
  never coincidentally match and one session always re-renders the same colour across restarts; a
  bare `●` in that colour leads the line. The title: a 3–6 word summary of what the session is
  *about*, generated in the background by a `claude -p --model haiku` call on `UserPromptSubmit`,
  read from a per-session file, showing `·  ·  ·` until the first generation lands.
- **Seen in:** which-claude-code (`bin/statusline.sh:33-40`, `bin/statusline.sh:47-53`,
  `bin/update-session-title.sh:1-9`).
- **cc-candybar today:** adjacent for the title (`session_name` is already in the hook payload,
  `src/utils/claude.ts`, so `/rename` is one `input` variable away), lacks it for the colour.
  Decorative colour is dealt from a node's *address in the layout tree*
  (`decorFor` in `src/themes/decor.ts`), which is identical across every pane by design — the
  opposite of what this needs — and no hash function is registered in the engine (`sprigHash` is not
  among the sets composed in `src/template-engine/engine.ts`).
- **Worth taking:** maybe. For someone running several panes at once this is the cheapest possible
  win: one small function mapping a string onto a palette entry, one segment. It is a `maybe` only
  because it cuts against the tree-address vocabulary — a session-hashed cell is the one cell on the
  bar whose colour means something other than where it sits, and that exception has to be worth
  making deliberately.

### Idle, warming up, or actually burning

- **What it is:** a burn indicator with three states instead of two, because zero has two meanings.
  coralline renders a dim `✓` when genuinely idle (no tokens burning), a dim `…` while warming up
  (no samples yet), and a coloured `⇢ <ETA>` once actually burning — the colour set by how close the
  ETA is to the window's own reset time. A fresh install and a quiet session would otherwise render
  identically.
- **Seen in:** coralline (`seg_burn` in `statusline.sh`).
- **cc-candybar today:** adjacent, and one state short. `projectEtaMinutes`
  (`src/daemon/render-payload.ts`) returns `undefined` for *both* "the window is younger than five
  minutes" and "usage is zero", the field drops, the variable falls back to `-1`, and `formatEta`
  renders `—` for both. The burnrate cell reads calm in either case, which is correct, but it cannot
  say which.
- **Worth taking:** maybe. It is a `[LAW:no-silent-failure]`-shaped distinction — two different
  absences collapsed into one sentinel — and the fix is to give them two sentinels or an `Outcome`,
  which is how the git provider already spells exactly this. Small, principled, low urgency.

### Degrade a segment in steps before dropping it

- **What it is:** width handling as an ordered retreat rather than a wrap. Powerline gives each
  segment a numeric `priority`, drops lowest-priority-first when the bar does not fit, and only
  after dropping is exhausted falls back to per-segment content truncation. Token Tracker pops
  trailing segments one at a time (`while vlen(...) > W: pop()`), steps its gauge width down 8 → 6 →
  4 cells as room shrinks, and tries three renderings per rate-limit window — full text, gauge
  without countdown, bare percent — taking the shortest that fits. TheoBrigitte gives each module
  its own `min_term_width`/`max_term_width` band, so modules vanish at different breakpoints rather
  than the line switching mode at once. ccstatusline's `flexMode` reserves 40 columns only once
  context passes a threshold.
- **Seen in:** Powerline (`powerline/renderer.py:257-384`), Token Tracker
  (`src/token_tracker/templates/claude_statusline.py`), TheoBrigitte (`main.go`,
  `pkg/layout/layout.go`), ccstatusline (`src/types/FlexMode.ts`, `src/utils/renderer.ts`).
- **cc-candybar today:** adjacent in two partial ways. `globals.autoWrap` folds an overlong row onto
  more lines rather than dropping anything (`FlexStrip`, `src/render/strip.ts`), and `term.cols` is
  already an input variable, so a `when` of `{{ gt (int .term.cols) 80 }}` reproduces TheoBrigitte's
  width bands exactly, today, with no new machinery.
- **Worth taking:** maybe. The band half is already expressible and needs only a documented recipe.
  The interesting half is Token Tracker's — a segment declaring *shorter renderings of itself*
  rather than an on/off gate — which has no spelling in the DSL and would need one. A `when` chain
  over `term.cols` across three sibling segments fakes it and reads badly. Worth designing if the
  two-row bar ever feels cramped; not before.

### Column alignment across stacked rows

- **What it is:** making a multi-row bar read as a table rather than as independent strings.
  ccstatusline's Powerline-only `autoAlign` pads every widget to the same column width *across*
  lines, with a per-widget `excludeFromAutoAlign` escape hatch. Claude HUD right-pads progress-bar
  labels (Context/Usage/Weekly/RAM) to the widest label in the active locale so stacked bars line
  up, backed by CJK/emoji-aware grapheme measurement. claude-pace re-pads its two lines on every
  render so the `|` separators land in the same column whatever the left-hand content's length.
- **Seen in:** ccstatusline (`src/utils/renderer.ts`, `README.md`), Claude HUD
  (`src/render/lines/label-align.ts`, `src/render/width.ts`), claude-pace (`claude-pace.sh`).
- **cc-candybar today:** lacks it. Rows are joined independently — a vertical container's children
  each serialize through the powerline `Joiner` and are joined with `\n` (`renderDsl` in
  `src/dsl/render.ts`) — so the default two-row bar's columns land wherever their content puts them.
  Per-segment `width:` exists, which is the manual version of the same thing.
- **Worth taking:** maybe. The bundled default is two rows, so this applies to every user, and
  ccstatusline's escape hatch shows the shape the feature wants (opt-out per segment, not a global
  mode). It is also the one idea here that fights `FlexStrip`'s wrap: aligned columns and soft
  wrapping disagree about what a row's width is for. Design before building.

### Claude service status, with a 48-hour incident strip

- **What it is:** whether Anthropic itself is up, cached against status.claude.com. TheoBrigitte
  renders one traffic-light emoji — 🟢 operational, 🟡 degraded, 🔴 error or unreachable with the
  error text appended — file-cached for ten minutes. ccstatusline renders the severity word coloured
  per level and, when incident history is on, follows it with an eight-cell strip of `▮` glyphs,
  each bucket coloured by its own incident severity: a miniature coloured history of the last
  48 hours.
- **Seen in:** ccstatusline (`src/widgets/ClaudeStatus.ts`), TheoBrigitte (`pkg/status/status.go`).
- **cc-candybar today:** lacks it. The nearest is the npm registry poll behind the update notice
  (`src/daemon/update-notice.ts`), which proves the daemon is happy to hold a long-TTL network fact,
  and the forge PR lookup in `src/daemon/cache/git.ts`, which proves the three-state
  ok/absent/failed discipline for one.
- **Worth taking:** maybe. The traffic light is genuinely useful about twice a year and costs a
  cached poll; the incident strip is the interesting form and is really the painted gauge again with
  time on the x-axis, so it wants that function to exist first. Rank it under the gauge, not beside
  it.

### A staleness marker on a number that could not be refreshed

- **What it is:** saying out loud that a figure is cached, estimated, or from a fallback source
  rather than showing it as live. usage-bar replaces both rate-limit bars outright with a yellow
  `⟳ 5h/7d stale·restart` when its cached window data goes stale. ersinkoc prefixes the line with a
  freshness emoji naming the source — 🟢 LIVE / 🔵 NEW / 🔄 DB / 🔴 EXPIRED. Claude HUD switches the
  label from "Cost" to "Estimated cost" when Claude Code's native cost field was not usable.
  spences10 renders a distinct `⚠ DB Error` segment on a database read failure rather than hiding
  the segment.
- **Seen in:** usage-bar (`src/claude_statusbar/progress.py`), ersinkoc
  (`_get_status_indicator` in `claude_statusline/statusline.py`), Claude HUD
  (`src/render/lines/cost.ts`), spences10 (`src/segments/usage.ts`).
- **cc-candybar today:** adjacent, at the wrong altitude. A source that fails loudly reaches the
  diagnostic strip (`src/render/diagnostic-strip.ts`) and a document that failed to parse errors the
  segment that reads it (`src/var-system/sources.ts`), but a shell or file source that simply has
  not re-run keeps publishing its last value with no mark on the cell, and `registry.settled()`
  exists only for `cc-candybar check`.
- **Worth taking:** maybe. It is the law the codebase already argues for — a number whose provenance
  changed silently is exactly the case `[LAW:no-silent-fallbacks]` exists to refuse — but the honest
  scope is small, because every cc-candybar number that can go stale is one the daemon can also just
  refresh. Revisit if user-authored `shell` sources with long TTLs become common.

### A wall-clock expiry instead of a countdown that ages

- **What it is:** Claude HUD renders the prompt cache's expiry as a fixed clock time rather than a
  live countdown, explicitly because the bar repaints only on Claude Code events — a ticking
  countdown would freeze between repaints and lie about how much time is left. Three colours:
  active, warning inside the last fifth of the TTL, dim once expired, showing `cold` past it.
- **Seen in:** Claude HUD (`src/render/lines/prompt-cache.ts`).
- **cc-candybar today:** has the countdown. `cacheTimer` in `src/config/default-dsl-config.ts`
  renders `{{ minutesUntilReset .cache.expiresAt }}m`, which is computed fresh on each render and
  is therefore exactly as stale as the last render, with `cold` at zero — the same three-tier colour
  ladder, the opposite formatting decision.
- **Worth taking:** maybe. The argument is real and cuts both ways: during active work the bar
  repaints constantly and the countdown is the friendlier number; while idle it stops updating, and
  idle is precisely when the cache is expiring under you. A compromise exists — `4m (until 14:32)`
  — but it costs cells on a row that already carries five segments. Worth a deliberate decision;
  not obviously an improvement.

### MCP and environment health

- **What it is:** the session's *configuration* as a readout: counts of CLAUDE.md files, rules, MCP
  servers, hooks and added directories, joined compactly — and, the part that earns the row, failing
  MCP servers named in red as `⚠ name1, name2 +N`. Claude HUD also renders added directories as
  clickable dimmed basenames with a `+N more` overflow past five; claude-dashboard lists skills or
  MCP servers as `✓ Skills (n): name, name, +N more`.
- **Seen in:** Claude HUD (`src/render/lines/environment.ts`, `src/render/lines/added-dirs.ts`,
  `src/render/skills-mcp-line.ts`), claude-dashboard (`scripts/widgets/config-counts.ts`).
- **cc-candybar today:** lacks it. `workspace.added_dirs` is in the hook payload
  (`src/utils/claude.ts`) and reachable by an `input` variable, but nothing reads it, and MCP server
  health is not in the payload at all — it would need its own probe.
- **Worth taking:** maybe. The counts are decoration; the failing-server alert is the real content,
  and it is genuinely valuable (a dead MCP server currently announces itself only by tools quietly
  not existing). The cost is a new provider with a source of truth Claude Code does not hand the
  statusline, which is why this sits at `maybe` rather than above it.

### The subagent statusline, as its own render target

- **What it is:** Claude Code calls a *second* statusline for its subagent panel, and three projects
  render it as a themed panel of per-task rows rather than a line. m5d215 renders
  `{icon} {label} [· {description}] · {tokens} [· {elapsed}]` with `…` green running, `✓` cyan
  completed, `✗` red failed, `○` grey other. coralline draws a whole multi-row panel themed like the
  main bar — identity coloured by status, model badge, a bare context gauge with no window size,
  elapsed time. YAS nests subagents into a file-tree layout with branch and elbow glyphs, marking
  each row `✓` completed, `✗` killed ("ended early by intent"), `!` failed (ended by error), `↺`
  resumed.
- **Seen in:** m5d215 (`subagent-statusline.sh`), coralline (`subseg_name`, `subseg_model`,
  `subseg_ctx`, `subseg_elapsed` in `statusline.sh`), YAS (`claude/yas/info/subagents.py`,
  `claude/yas/render/tasks_view.py`).
- **cc-candybar today:** lacks it. The daemon renders one bar per `(projectDir, cwd)` tuple
  (`src/daemon/cache/render.ts`) from one hook payload shape; there is no second entry point and no
  subagent facts in `RenderPayload`.
- **Worth taking:** maybe. The rendering half is nearly free — a preset whose root is a vertical
  container of per-task rows is exactly what the DSL already expresses, and YAS's tree glyphs are a
  template. The cost is everything around it: a second hook wiring, a second render cache key, and a
  payload shape for a list of tasks when every `input` variable today reads a scalar path. Real
  work, real payoff, and the one item here that is a project rather than a ticket.

### Named fill/empty glyph vocabularies

- **What it is:** the gauge's glyph pair as a named, swappable choice. claude-powerline ships nine:
  `blocks` (`█`/`░`), `blocks-line` (`█`/`─`), `ball` (a `─` track with a moving `●`), `capped`
  (`━`/`┄` with a `╸` end-cap), `dots` (`●`/`○`), `filled` (`■`/`□`), `geometric` (`▰`/`▱`), `line`,
  `squares`. cship makes both characters independently configurable; usage-bar's `hairline` style
  swaps the ten-cell battery for four-level `▁▃▆█` micro-bars; TheoBrigitte uses `#`/`-`.
- **Seen in:** claude-powerline (`src/segments/context.ts`), cship (`src/modules/context_bar.rs`),
  usage-bar (`src/claude_statusbar/progress.py`), TheoBrigitte (`main.go`).
- **cc-candybar today:** adjacent — `globals.charset` (`src/themes/policy.ts`) is already the axis
  this belongs on, indexing glyph *options* while style picks the joiner class.
- **Worth taking:** pass. Once the gauge function exists its glyph pair is an argument, and the
  ascii/unicode split is already the policy for deciding which glyphs are legal. Nothing to decide
  separately.

### The gradient level as a theme-owned mapping

- **What it is:** a segment emits one 0–100 number and nothing else; the *theme* owns the colour list
  and the thresholds that number maps through. `pick_gradient_value` maps the level onto a named
  gradient by nearest-index rounding, so load average, battery, temperature and unread mail all
  drive continuous colour without a threshold `if` chain anywhere in the segment. Segments also
  declare an ordered fallback chain of highlight groups (`['battery_full', 'battery_gradient',
  'battery']`), so a theme overriding one inherits the rest.
- **Seen in:** Powerline (`powerline/colorscheme.py:27-32,62-64`,
  `powerline/segments/common/bat.py:277-297`).
- **cc-candybar today:** has it, and one level further. `ramp` takes the stops inline with either
  `step` or `linear` easing, resolves palette *names* through the same resolution `color` uses, and
  accepts variable refs in position slots so a threshold can be a user-overridable knob — see
  `block`'s `bg:` in `src/config/default-dsl-config.ts`. The colour list lives in the palette; the
  thresholds live where the decision is.
- **Worth taking:** pass.

### Budget against a configured limit

- **What it is:** spend shown against a number the user set, with the icon and colour escalating
  together — claude-dashboard's `<icon> $spent / $budget (pct%)` stepping banknote → warning → alarm
  at 80%/95%, ersinkoc's ✅ → ⚠️ → ❌ at the same thresholds, claude-powerline's budget-relative
  colour escalation on the block and today segments.
- **Seen in:** claude-dashboard (`scripts/widgets/budget.ts`), ersinkoc
  (`claude_statusline/budget_manager.py`), claude-powerline (`src/segments/renderer.ts`).
- **cc-candybar today:** has it — the `budgetStatus` helper and `.today.budget.amount` /
  `.warningThreshold` in `src/config/default-dsl-config.ts`.
- **Worth taking:** pass.

### Hide at zero

- **What it is:** dropping a segment entirely rather than rendering `0` — kcchien calls it "smart
  hiding" and applies it to duration, line changes and rate limits; ccstatusline has a shared
  "hideable state" mechanism across its git family; Powerline's stash segment is simply absent, not
  zero.
- **Seen in:** kcchien (`statusline.sh:231-241`, `statusline.sh:286-291`), ccstatusline
  (`src/widgets/Git*.ts`), Powerline (`powerline/segments/common/vcs.py:59-81`).
- **cc-candybar today:** has it — `when` predicates gate any segment or row, and the bundled default
  gates every status segment on its own signal (`src/config/default-dsl-config.ts`).
- **Worth taking:** pass.

### Inverted thresholds — high is the good end

- **What it is:** the same colour ladder run backwards where high numbers are the good outcome —
  cache hit rate, remaining balance, remaining percent. cship makes it an explicit per-field
  `invert_threshold` flag so "remaining %" fires warn/critical on *low* values without inheriting
  the parent's used-oriented thresholds by accident. usage-bar's relay fuel gauge is green when full
  and red at ≤10% remaining. Powerline's battery gradient is called out in its own code as the
  inverse of every other gauge.
- **Seen in:** cship (`src/modules/context_window.rs`), usage-bar
  (`src/claude_statusbar/progress.py`), claude-dashboard (`scripts/widgets/cache-hit.ts`), coralline
  (`seg_cache` in `statusline.sh`), Powerline (`powerline/segments/common/bat.py:230-300`).
- **cc-candybar today:** has it, without a flag. `ramp` stops are ordered data, so an inverted ladder
  is `0 "error" 21 "warning" 41 "surface-active"` — which is literally what the `context` segment in
  `src/config/default-dsl-config.ts` does, ramping over *remaining* context.
- **Worth taking:** pass. A flag would be the control-flow spelling of a thing already expressed as
  data.

### The git diffstat symbol vocabulary

- **What it is:** working-tree state as a run of counted symbols rather than one dirty dot — claudia's
  `+N` added / `~N` modified / `-N` deleted / `?N` untracked; spences10's superscript set
  (`⁺N` staged add, `⁻N` staged delete, `˜N` unstaged, `ᵘN` untracked, `⇡N`/`⇣N` ahead/behind, `⚠️`
  conflicts); Token Tracker's `(branch +A -D ?U)`; gitui's per-file `M`/`+`/`-`/`R`/`!`.
- **Seen in:** claudia (`src/display.rs`), spences10 (`src/segments/git.ts`), Token Tracker
  (`src/token_tracker/templates/claude_statusline.py:223-236`), gitui
  (`src/components/status_tree.rs:141-149`).
- **cc-candybar today:** has it. `gitaculous` in `src/config/default-dsl-config.ts` paints `S`/`U`/
  `?`/`!N` per fact with a shared colour table, plus `+N/-N` ahead/behind inside the upstream
  bracket, over a provider (`src/segments/git.ts`) that carries staged, unstaged, untracked,
  conflicts, stash, tag, upstream, sha and time-since-commit.
- **Worth taking:** pass.

### One glyph, three meanings carried by colour

- **What it is:** a single fixed glyph whose *colour* is the whole message. claudia's GSD widget uses
  one clipboard-check icon meaning green = active task, yellow = update available with no active
  task, red = stale beyond a configured hour threshold. coralline flips a pill's background colour
  rather than adding a marker.
- **Seen in:** claudia (`src/gsd/mod.rs`), coralline (`seg_git` in `statusline.sh`).
- **cc-candybar today:** has it — the git status glyph is coloured per fact from one shared table,
  and `decorFor` (`src/themes/decor.ts`) makes colour a first-class carrier throughout.
- **Worth taking:** pass.

### Model-name shortening and alias maps

- **What it is:** turning a long or opaque model id into something that fits — ccusage substitutes
  exact matches from a user-configured `modelLabelAliases` map (its motivating case is a Bedrock
  ARN), Claude HUD prettifies `claude-opus-4-7` → `Opus 4.7` and falls back to the raw string when
  unrecognised, CCometixLine ships a simplified name per model.
- **Seen in:** ccusage (`docs/guide/statusline.md`), Claude HUD (`src/render/lines/advisor.ts`),
  CCometixLine (`src/ui/themes/theme_default.rs`).
- **cc-candybar today:** has it — `formatModelName` and `shortenModelName` in
  `src/template-engine/funcs.ts`.
- **Worth taking:** pass. A user-supplied alias map is one `dict` in a config variable if anyone ever
  needs it.

### Directory shortening, forge icons, breadcrumb cells

- **What it is:** three treatments of one path. m5d215 recognises the *shape* of a clone path —
  `~/src/github.com/org/repo` — and swaps the forge hostname for a GitHub or GitLab icon rather than
  abbreviating generically. Powerline renders the cwd as one powerline cell *per path component*,
  chevron-separated, with per-component shortening and an ellipsis cell past a depth limit.
  coralline folds deep paths to `first/second/…/last`; which-claude-code keeps the last two segments.
- **Seen in:** m5d215 (`shorten_dir` def in `statusline.sh`), Powerline
  (`powerline/segments/common/env.py:43-107`), coralline (`seg_dir` in `statusline.sh`),
  which-claude-code (`bin/statusline.sh:22-30`).
- **cc-candybar today:** has the shortening — fish-style abbreviation (`~/c/cc-candybar`) is the
  default via `abbreviatePath` in `src/template-engine/funcs.ts`.
- **Worth taking:** pass. Fish-style abbreviation already solves the width problem the other two
  treatments solve, and a breadcrumb of separate cells would spend the powerline joiner's visual
  budget on a path that is rarely the interesting thing on the row.

### The Anthropic peak-hours window

- **What it is:** claude-dashboard shows whether the session is inside Anthropic's weekday 5–11am
  Pacific peak window, as a coloured `Peak`/`Off-Peak` label with a countdown to the transition,
  computed against Pacific local time via `Intl.DateTimeFormat`.
- **Seen in:** claude-dashboard (`scripts/widgets/peak-hours.ts`).
- **cc-candybar today:** adjacent — `sprigDatetime` is registered with an injected clock
  (`src/template-engine/engine.ts`), including `dateInZone`, so the whole widget is a template
  expression over `now` plus a `when`.
- **Worth taking:** pass. Authorable today by anyone who wants it, and the schedule is Anthropic's to
  change — a hard-coded window in the bundled default would be a claim with a shelf life.

### Effort, thinking, vim mode, output style, agent name

- **What it is:** the session-mode readouts, in roughly a dozen forms — ccstatusline's five selectable
  vim-mode formats (`v-N`, `v N`, bare icon, bare letter, full word) with a Nerd Font toggle;
  claude-powerline's `On · high`; usage-bar's whole `⚙ effort:high · think:on · fast:off ·
  style:default` line; claude-dashboard's `MAX/X/H/M/L` effort badge with a `↯` Opus fast-mode
  suffix; Claude HUD's effort as symbol, text, or both.
- **Seen in:** ccstatusline (`src/widgets/VimMode.ts`, `src/widgets/ThinkingEffort.ts`),
  claude-powerline (`renderThinking` in `src/segments/renderer.ts`), usage-bar
  (`src/claude_statusbar/styles.py`), claude-dashboard (`scripts/widgets/model.ts`,
  `scripts/widgets/vim-mode.ts`), Claude HUD (`src/render/model-display.ts`).
- **cc-candybar today:** adjacent. `effort.level`, `thinking.enabled`, `vim.mode`, `output_style.name`
  and `agent.name` are all already in `ClaudeHookData` (`src/utils/claude.ts`) and `RenderPayload`
  extends it, so each is one `{ kind: "input", path: … }` declaration away in any config; the bundled
  default simply declares none of them.
- **Worth taking:** pass as designs — but worth noting as a gap in the *bundled* default rather than
  in the engine. Adding two or three of these as opt-in declared segments costs nothing and is a
  documentation decision, not a build.

### Cache hit rate as a percentage

- **What it is:** the share of input tokens served from cache, coloured with the good end high —
  claude-dashboard's `📦 XX%`, coralline's percentage beside the expiry countdown, rz1989s's
  `Cache: 78% hit` computed block-wide with a current-turn fallback, spences10's
  `🧠 <total-cached> cached (NN% reused)` with a `Cold` state below a warmth threshold.
- **Seen in:** claude-dashboard (`scripts/widgets/cache-hit.ts`), coralline (`seg_cache` in
  `statusline.sh`), rz1989s (`lib/components/cache_efficiency.sh`), spences10
  (`src/segments/context.ts`).
- **cc-candybar today:** adjacent. `cacheTimer` (`src/segments/cache.ts`) shows warmth as time, and
  the hook payload's `current_usage` carries `cache_read_input_tokens` and
  `cache_creation_input_tokens` (`src/utils/claude.ts`), so the ratio is arithmetic in a template.
- **Worth taking:** pass. Nothing to build; a two-line addition to a config for anyone who wants the
  number. The expiry countdown answers the question that changes behaviour ("is my cache about to
  cost me") better than the ratio does.

### Pace as a signed percentage

- **What it is:** how far ahead or behind linear quota consumption you are running, as a signed
  number rather than a raw usage figure. claude-pace computes `used% − (elapsed/window)×100` and
  renders `⇡N%` red when overspending, `⇣N%` green when there is headroom. cship's `{pace}` token
  does the same, printing `?` when unmeasurable.
- **Seen in:** claude-pace (`claude-pace.sh:255-278`), cship (`src/modules/usage_limits.rs`).
- **cc-candybar today:** has the same question answered as a time. `burnrate` in
  `src/config/default-dsl-config.ts` renders `⚡ $X/hr · Nm to 5h · Nd to wk` off
  `projectEtaMinutes` (`src/daemon/render-payload.ts`), and its `bg:` ramps over minutes-to-cap.
- **Worth taking:** pass. "You hit the cap in 40 minutes" is strictly more actionable than "you are
  12% ahead of pace", and it is the same projection presented in the unit you would act on. The
  signed form is also authorable — both inputs are in the payload.

### Two independently-computed costs side by side

- **What it is:** ccusage's `--cost-source both`, rendering `💰 ($0.25 cc / $0.23 ccusage) session` —
  Claude Code's own cost figure next to the tool's independent calculation, deliberately not picking
  one, as a trust-verification affordance.
- **Seen in:** ccusage (`docs/guide/statusline.md`).
- **cc-candybar today:** adjacent. Both numbers exist — `cost.total_cost_usd` from the hook
  (`src/utils/claude.ts`) and the store's own fold (`src/daemon/cache/session-usage-store.ts` behind
  `.session.cost`) — so showing both is a template edit.
- **Worth taking:** pass. A genuinely good idea for someone debugging their own pricing table; a
  permanent second number on the bar for everyone else. Keep it in mind as a `cc-candybar check`
  line rather than a segment.

### Host-machine and world readouts

- **What it is:** everything on the bar that is not about this session — free memory in
  magnitude-abbreviated bytes (ccstatusline) or as a bar with used/total (Claude HUD); Powerline's
  load average, CPU percent, uptime, network throughput, battery (with a "hearts" gauge under a
  `gamify` flag), unread IMAP count, weather with a condition glyph, media player state and fuzzy
  time ("quarter past six"); rz1989s's Islamic prayer times with an eight-phase Hijri moon glyph and
  a Pomodoro-style wellness timer.
- **Seen in:** ccstatusline (`src/widgets/FreeMemory.ts`), Claude HUD (`src/render/lines/memory.ts`),
  Powerline (`powerline/segments/common/sys.py`, `.../bat.py`, `.../wthr.py`, `.../time.py`,
  `.../players.py`), rz1989s (`lib/prayer/display.sh`, `lib/components/wellness.sh`).
- **cc-candybar today:** adjacent for all of it — a `shell` source with a `parse:` arm
  (`src/var-system/sources.ts`) turns any command's output into a variable, which is exactly how
  `docs/segment-authoring.md` teaches a custom segment.
- **Worth taking:** pass. The seam is the feature; each individual readout is a user's config, not a
  bundled segment.

### Starship passthrough

- **What it is:** cship delegates any of Starship's ~100 prompt modules by name to a `starship module
  <name>` subprocess (five-second file cache, `CSHIP_*` env injected), rendering whatever ANSI
  Starship emits — so a language-version or cloud-provider module appears in the bar without being
  reimplemented.
- **Seen in:** cship (`src/passthrough.rs`).
- **cc-candybar today:** adjacent — a `shell` source (`src/var-system/sources.ts`) does this, and
  `preserveColors`-style raw ANSI is the one part that would need care, since cc-candybar composes
  `RichText` rather than concatenating escape sequences.
- **Worth taking:** pass. The generic seam covers the case; a Starship-specific verb would be a
  dependency on someone else's binary in exchange for a shorter spelling.

### Bordered grid panels with breakpoints

- **What it is:** the statusline abandoning the strip. claude-powerline's `tui` style is a
  CSS-Grid-inspired layout engine: `display.tui.breakpoints` holds complete `grid-template-areas`
  strings (`"git.head git.head context.bar context.bar block.time"`) activating at different panel
  widths, with a title bar, footer, custom box-drawing characters, and a
  `fitContent`/`widthReserve`/`minWidth`/`maxWidth` sizing model. YAS draws a bordered box with three
  genuinely different layouts by width band (wide / ≤80 / ≤55 cols) and splices its own render time
  into the bottom-right border (`…47.2ms──╯`). arcade draws fixed multi-line blocks with sky and
  grass rows.
- **Seen in:** claude-powerline (`README.md`, `src/segments/renderer.ts`), YAS (`README.md`,
  `claude/yas/render/pill.py`, `claude/yas/layout.py`), arcade (`src/themes/pacman.rs`,
  `src/themes/pikmin.rs`).
- **cc-candybar today:** lacks it. The nearest thing is `root`'s nested containers
  (`src/dsl/render.ts`), which can already stack rows and gate any of them on `term.cols` — so a
  responsive *layout* is expressible. What is not is the rectangle: no border, no title, no footer,
  and no cell addressed by a named grid area rather than by its position in a row.
- **Worth taking:** pass. A bordered box is a different product: it owns a rectangle of the terminal
  that Claude Code neither reserves nor repaints reliably, and every row it spends is a row of
  transcript. YAS's border-embedded render time is the one charming detail, and it is charming
  precisely because the border is already there.

### The bar as a game

- **What it is:** the usage numbers *being* the game state. arcade's Pac-Man maze maps the character's
  horizontal position to context usage, chases him with a red ghost proportional to 5h usage and a
  purple one to 7d (caged behind a wall until 7d passes 50%), marks the 95% auto-compact threshold
  with a cherry, alternates mouth and leg glyphs each render from a temp file, and prints
  `GAME OVER` when a limit hits 100%. Its Pikmin theme draws a trail of flower or dot glyphs, one per
  15-minute activity slot over ~9 hours, with a marching three-emoji squad and upcoming reset times
  as fruit in the future slots. tamagotchi renders a multi-frame kaomoji pet with hunger, energy,
  cleanliness and happiness stats that decay in real time between sessions, fed and played with via
  ten slash commands.
- **Seen in:** arcade (`src/themes/pacman.rs`, `src/themes/pikmin.rs`), tamagotchi
  (`src/animations/index.ts:11-230`, `src/engine/PetEngine.ts`).
- **cc-candybar today:** lacks it. The nearest thing is the sparkline's advancing tail
  (`src/template-engine/sparkline.ts`), which does change shape render to render — but that is data
  moving, not a frame counter, and the render model resists the difference: animation needs a clock,
  and the daemon renders on Claude Code's tick.
- **Worth taking:** pass — with one detail worth stealing later: the Pikmin trail is a genuine
  display idea wearing a costume. A timeline of fixed-width slots showing *activity presence* over
  the last several hours, with known future events (window resets) marked in the slots ahead of now,
  is something no serious project here does and the sparkline half-does. If the gauge function lands,
  that timeline is its second caller.

### Long-horizon heatmaps and calendars

- **What it is:** usage over months, as a grid. Token Tracker renders a GitHub-contribution-style
  calendar — 7 weekday rows × 53 week columns of `■` cells at five intensity levels in forced 24-bit
  colour, with a month header and a summary panel carrying peak day and current/longest streak.
  ersinkoc renders a 7×24 day-of-week × hour-of-day grid shaded `·`/`░`/`▒`/`▓`/`█` normalised
  against its own maximum, plus a monthly calendar report.
- **Seen in:** Token Tracker (`src/token_tracker/ui/heatmap.py:1-90`), ersinkoc
  (`generate_weekly_heatmap` in `claude_statusline/activity_heatmap.py`).
- **cc-candybar today:** lacks it. The nearest thing is the `today` projection — a fold over
  per-day buckets in `src/daemon/cache/session-usage-store.ts` — which holds exactly the series
  these grids draw but surfaces only today's total. Both projects put the grid in a separate CLI
  command rather than on the bar, which is the right call.
- **Worth taking:** pass as a widget. Worth remembering that `cc-candybar` already owns a CLI and a
  usage store that holds per-day buckets across sessions, so if a report subcommand is ever wanted,
  the data is there and the grid is the known form.

### Config errors, update nudges, install drift

- **What it is:** the bar telling you about itself. YAS appends a compact
  `⚠ yas.toml: N values ignored (...)` row naming the rejected keys, never crashing the render.
  claude-carbon shows `⬆ vX.Y.Z /carbon-update` only while a background version flag is fresh — a
  seven-day self-expiry, so an abandoned checker goes silent on its own — and an `≠ install drift`
  marker when its data files disagree with the marketplace copy after stripping documentation keys.
  usage-bar amber-appends `↑<newver>` beside a dim version. CCometixLine renders nothing at all until
  an update is actually ready.
- **Seen in:** YAS (`README.md`), claude-carbon (`scripts/statusline.sh:216-231`,
  `scripts/statusline.sh:233-266`), usage-bar (`src/claude_statusbar/styles.py`), CCometixLine
  (`src/updater.rs`).
- **cc-candybar today:** has all of it, more thoroughly. The diagnostic strip
  (`src/render/diagnostic-strip.ts`) word-wraps warnings and errors at the client's real width with a
  `↳` trailer only when there is something to open, and the update notice
  (`src/daemon/update-notice.ts`) compares the running bundle's source digest to the `src/` beside it
  — an identity comparison rather than an mtime, which is a stronger version of claude-carbon's
  drift check.
- **Worth taking:** pass. The one idea not already present is the self-expiring flag: a nudge that
  goes quiet by itself if the thing producing it stops running.

### Wizards, TUIs and preview commands

- **What it is:** configuration as a surface. ccstatusline is TUI-first — a searchable ranked widget
  picker, per-widget single-key toggles, a colour picker spanning named/256/truecolor and gradients,
  live preview. CCometixLine ships a ratatui TUI with arrow navigation, space to toggle a segment,
  `c` for colours, `i` for icons, live preview pane. coralline's wizard pages through bundled themes
  and can import colours from an existing `~/.p10k.zsh`. cc-statusline's `preview` round-trips an
  already-installed script through a synthetic Claude Code payload so a user can see it render
  before wiring it into `settings.json`. claude-powerline hosts a web configurator where you click
  segments in a rendered preview.
- **Seen in:** ccstatusline (`README.md`, `src/widgets/index.ts`), CCometixLine (`src/ui/events.rs`),
  coralline (`configure.sh`), cc-statusline (`src/cli/preview.ts`), claude-powerline (`README.md`).
- **cc-candybar today:** has the strongest version of this in the survey: configuration happens *in
  the bar itself*, through the synthesized settings menu (`src/config/settings-menu.ts`) writing
  either session state or the config file, with no second application to open.
- **Worth taking:** pass — except for the one piece already promoted above: previewing an option in
  the thing it applies, which every one of these tools does and the in-bar picker does not.

## What nobody displays

Speculative by construction — these are gaps, not observations. Nothing in the three inventories
shows any of them, so each is a guess about what would be useful, not evidence that it is. Best-first.

1. **What this session has touched.** Every project shows the *repository's* dirty state; none shows
   the set of files this Claude session edited, which is a different and more interesting list — it
   is the review surface, and the transcript names every Edit and Write target.
2. **The last turn's cost.** Session, daily, block and weekly totals are everywhere; the number that
   would actually change behaviour mid-session — what the turn that just finished cost — appears
   nowhere.
3. **Permission pressure.** Nothing shows how much of this session ran behind approvals: how many
   tool calls prompted, whether a prompt is waiting right now, or whether the session is running
   with checks bypassed (usage-bar's `⚠️BYPASS` is the only nod, and it is a static flag, not a
   count).
4. **What is occupying the context window.** Several projects split tokens by *type* (input, output,
   cache-read, cache-write); none splits by *origin* — system prompt versus CLAUDE.md versus tool
   results versus conversation — which is the split that tells you what to cut.
5. **Whether the model that answered is the model you asked for.** Every bar shows the configured
   model name; none shows a fallback or degradation actually having happened.
6. **Divergence from where the session started.** Commits made during this session, or edits made and
   never committed, as a distance from the branch state the session opened on.

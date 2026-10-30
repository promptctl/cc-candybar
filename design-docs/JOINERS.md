# Joiners, dividers, and who owns colour

On cc-candybar's bar, two neighbouring cells sometimes meet at a thin line instead of a filled powerline or prism arrow. rich-js's joiner draws that line on purpose, whenever the two cells' backgrounds are too close for the filled seam to show. Four plans tried to prevent it from cc-candybar's side, and all four failed review. Each review found a route the plan had missed.

The working hypothesis is that the failures share one cause: how colour responsibility is split between rich-js and cc-candybar. One library chooses each cell's colour without seeing its neighbours. The other sees the neighbours, but only after every colour is fixed. Nothing here is decided. This document gathers the facts, the routes, the failed attempts and every constraint a redesign has to hold, for a reviewer coming to it fresh.

## The two libraries

**cc-candybar** renders Claude Code's statusline. A long-lived daemon draws the bar from a JSON5 config: segments (templates that read a payload of session facts), arranged in a layout tree of rows and containers. Menus open as *bands* hung under the *trigger* cell that opened them, and can nest. Placements can fade in and dissolve out (*transitions*), and *effects* animate cells (a wheel, a closing flash). There is one render path: the daemon, the check command, the demo and the tests all draw through the same functions.

**rich-js** (`~/code/rich-js`, published as `@promptctl/rich-js`) is a TypeScript port of Python's Rich, built for cc-candybar, which is its only consumer. It holds the themes, all colour arithmetic, the strip that lays cells out on a line, the joiners that draw between cells, and the effects engine. cc-candybar ships against rich-js 0.24.1.

Terms used below:

- **cell**: one drawn unit on a line, usually a segment.
- **ground**: a cell's background colour. **text** (or **ink**): what is drawn on it.
- **joiner**: what is drawn between two neighbouring cells. Each joiner has a **seam**, its filled form (the powerline arrow, prism's three stepped arrows), and a **divider**, a thin form of the same width.
- **depth**: the colour depth the terminal is drawn at: truecolor, 256, ansi (16 slots) or none.
- **address**: a cell's position in the layout tree, step by step.
- **variation** and **shade dial**: display settings. The variation picks which theme role (primary, secondary, accent) each row wears. The shade dial picks the window of a role's shades (darken-3 … lighten-3, muted) that the cells of a row walk through.
- **open trigger** and **state colour**: a trigger whose menu is open wears a state colour, shared with the ✕ that leads its menu and the blank leads under it.
- **held cell**: a cell of a placement that is dissolving out, replayed as fixed bytes from the frame in which it was last drawn.

## What Brandon has asked for

In his words:

- The state: "the joiners are broken and rendering as a black line rather than the powerline or prism they should be." Seen on the live bar (latest main, 2026-10-30) at 🍫 › polled, and at context › memento ceiling › autocompact. His config groups those three as `{ h: ["context", "plugins.memento.ceiling", "autocompact"] }` inside the status row.
- The order: "Write a ticket to make this error state structurally impossible. Take any tests that assert this state and reverse them, so any occurance of this state makes the tests fail."
- Where the fix goes: "i want this fixed in rich-js. rich-js exists for this project."
- On the split: "this seems like an odd way to divide the theming system. This is likely the cause of some complexity and problems."
- From the menus epic (brandon-menus-sjhy), item 4: "Some adjacent menu segments aren't drawn as different shades of the colour. They share one background, with only a thin line chevron between them instead of a filled separator." Its checkpoint: "Every pair of adjacent segments in the menu is two shades joined by a filled arrow."

The ticket is lit brandon-menus-sjhy.57p (`lit show brandon-menus-sjhy.57p`). It holds the four plans and their reviews. The tests that accepted the divider are already reversed on branch `fix/joiners-57p`, and they fail on today's code.

## How rich-js chooses the divider

The joiner draws its seam unless *every* seam cell's ink would vanish into that cell's own ground. When they all would, it draws the divider instead, in the left cell's text colour on the left cell's ground: with dark text, a dark chevron line. The rule is in rich-js `src/core/strip.ts` (`CellJoiner`, and the vanish rule beside `SEAM_MIN_DELTA_E`).

"Vanish" depends on the depth:

- **Truecolor and 256.** Ink and ground are measured as drawn, downgraded to the depth and flattened onto black. A seam cell vanishes when they are less than ΔE_OK 0.04 apart. At 256, two colours that round to one table entry are one colour.
- **ansi.** The 16 slots take their RGB from the user's terminal theme, so rich-js cannot measure them. A seam cell vanishes when its ink and ground are the same slot.

In every joiner that has a divider, the seam's ink is built only from the two grounds. An arrow's ink is the left ground over the right ground. Prism steps through the thirds between the two grounds. Torn draws over their midpoint. As two grounds converge, every seam converges with them, and seams with several cells lose their ink sooner than a single arrow does. Measured through rich-js's own joiner, comparing each join against the same joiner with its divider replaced by its seam, this is the smallest gap between grounds at which the seam is drawn:

| depth | powerline / slant / bubble | torn | prism |
|---|---|---|---|
| truecolor (grey `#303030`, blue `#336699`) | ΔE 0.041–0.043 | 0.078–0.081 | 0.115–0.118 |
| 256 (grey) | 0.062 | 0.118 | 0.137 |

At 256 the threshold is whatever the rounding makes it: a blue pair only 0.007 apart already lands on two table entries and gets its seam.

The joiner reads a cell's *edge character*, not the cell as a whole: the style of its first and last characters, inline spans included (rich-js `src/core/text.ts`). A cell whose last character wears its own background joins on that background.

Five joiners never draw a divider, because their divider is their seam: plain, capsule, metro, stitch and wrapper. Nine have a separate divider form: powerline, slant, backslant, flame, pixel, ice, bubble, prism and torn. The joiner is a user setting, and any of the fourteen can be selected.

## How often it happens today

The bundled bar was rendered through the in-process rig (`test/helpers/session-bar.ts`) under all 23 bundled themes. Each theme was drawn six ways: the closed bar, and the settings menu open on each of its five tabs. That makes 138 frames for each depth and joiner, and each frame's divider glyphs were counted against its seam glyphs. Torn is left out, because its divider uses its seam's glyphs and glyph counts can't separate the two.

| depth | joiner | dividers | seams | frames with a divider |
|---|---|---|---|---|
| truecolor | every arrow joiner | 147 | 4545 | 53 / 138 |
| truecolor | prism | 1676 | 1498 | 138 / 138 |
| 256 | every arrow joiner and prism | 83 | ≈4600 (prism 3091) | 63 / 138 |
| ansi | every arrow joiner and prism | 455 | ≈4200 (prism 2719) | 138 / 138 |

Under prism at truecolor, the bar draws more dividers than seams, on every frame. The themes' neighbouring shades sit a powerline gap apart, not a prism gap. At ansi every frame has a divider, because neighbouring shades round onto one of 16 slots. The closed bar's 🍫 › polled join divides under atom-one-dark, atom-one-light, catppuccin-frappe and catppuccin-latte, among others.

## Who owns colour today

The split, as `src/themes/decor.ts` states it: rich-js "owns every colour operation used", and cc-candybar "keeps the POLICY (which roles, which shades, which address formula)".

| | rich-js | cc-candybar |
|---|---|---|
| Themes and their shade ladders | ✓ (`src/themes`) | |
| Colour arithmetic: OKLCH, contrast, rounding to a depth | ✓ | |
| Which colour each cell wears | | ✓ `src/themes/decor.ts`, by address |
| Menu band colours, open-trigger state colour | | ✓ `src/themes/decor.ts` |
| A cell's text colour | | ✓ `src/template-engine/colors.ts`, chosen for the cell's ground |
| Authored colours (alerts, thresholds) | | ✓ templates in the config |
| Seam colours, and seam or divider | ✓ the joiner, from the finished cells | |
| Effects painting cells and seams | ✓ | |

cc-candybar's colour function is pure by design: "any node's colour is computable from its address alone, without visiting any other node" (`decor.ts` header). Its inputs are values: the theme's palette, the decor (variation × shade), the cell's address, and for a band the lineage of the menus that opened it.

The rule the divider breaks is about neighbours: two cells next to each other must look different. That rule has no owner with both the view and the authority to act on it:

- cc-candybar chooses every colour and cannot see a cell's neighbours.
- rich-js sees the finished line but cannot choose colours. When two neighbours are too close, all it can do is draw the divider.

So cc-candybar predicts rich-js. `decor.ts` (1,927 lines) imports rich-js's drawing helpers to work out ahead of time how a colour will be rounded and drawn: `ensureDrawn`, `drawnColour` and `deltaE` alone appear on about 25 of its lines. It then moves colours to stay clear of the result. It also imports `SEAM_MIN_DELTA_E` and applies it to pairs of *grounds*. That is a copy of the joiner's rule, and it is right only for the single-arrow joiners: prism and torn measure each seam cell, and need two to three times the gap. The menu-band rules are all prediction built on that copy: the open trigger kept apart from its items, the band-item repair, and the seam-shortfall reports.

Text colour is split the same way. A cell's text has to read on its ground at the depth it is drawn at, and cc-candybar chooses that text during the walk, before the line exists.

## Routes to the divider

From the ticket, routes that come from colour policy:

- **A container is one address.** Every cell inside a container in a row wears that address's one shade. The user's `{ h: [...] }` group is one; so is the settings door with its frame-rate cell, built as one unit (`src/config/settings-menu.ts`).
- **Two addresses land on one tone.** Under every three-tone shade window, cells 8k−1 and 8k share a tone (brandon-menus-sjhy.hdw).
- **The theme or the depth merges shades.** textual-ansi names several shades of a role alike, and 256 and ansi rounding puts two tones on one table entry or slot.
- **An authored `bg` equals its neighbour's.**
- **A hidden cell.** Colour follows address, so the cells on either side of a hidden one keep their tones and can meet on one.

From the plan reviews, routes that come from *when* colour is chosen:

- **Held cells.** A placement dissolving out replays its cells as fixed bytes. Whether a placement is held is known only after the walk has passed it. By then its left neighbour has its ground, and walking that neighbour again throws: a placement reached twice in one frame is an error (`src/render/effect.ts`).
- **Two fixed cells meeting.** When a placement between two held cells leaves without holding anything, the two become neighbours and neither can move.
- **Cells painted after the walk.** In an open menu, each row's ✕ or blank lead is added after the walk, in the state colour (`src/dsl/node-registry.ts`). Picker lists are vertical containers, so a left-to-right check meets each row's first item against the previous row's last cell instead of its lead.
- **Edge characters.** With padding 0, which two bundled presets set, a template's first or last character can wear its own background and decide the join. A cell's lead and trail parts are joined after sizing and form its outer edges.

## Why the four plans failed

All four plans had one shape: give each cell a list of candidate grounds, and let it wear the first one the joiner separates from its left neighbour. Each failed on the split described above:

- They had to copy or re-ask the joiner's rule from outside rich-js. The first plan used the constant and missed prism and torn.
- They had to see a finished line that does not exist during the walk. That produced the held-cell, fixed-pair, after-the-walk and edge-character routes.
- They had to fit a neighbour rule into a colour model built to ignore neighbours. Making the open trigger's state depend on its left neighbour breaks how bands find each other: a band's identity deliberately reads nothing about where its trigger sits, and the parent band is found by adjusting the identity's depth (`src/themes/decor.ts`).
- Every colour moved to clear a seam had to clear the text floor, STATE_FLOOR and the theme-colour rule again, and each plan reopened one of them.

## Constraints a redesign has to hold

These hold whichever library ends up owning which part.

**Templates read their own ground.** A cell's background is computed first, then published so its `fg:` template can read it (`src/template-engine/colors.ts`). The template functions `tint` and `bgOf` hand a cell its own ground (`src/render/segment-color.ts`). The bundled alert cascades rest their calm arm on the cell's tint: `bg: '{{ ramp … 0 (tint) .settings.warnAt "warning" … }}'` (`src/config/default-dsl-config.ts`). Configs pick text with `fg: '{{ contrastOn (bgOf) }}'` (`src/demo/statusline.json5`). If a ground were chosen later, at compose time, every one of these would need it before it exists. rich-js already resolves some colours late, which may bear on this: theme style names resolve when drawn, and seam paints are references to a neighbour's edge.

**Text must read.** Text with no authored colour clears WCAG AA (4.5:1) on its ground in every region, measured as drawn at the depth.

**Closed cells wear the theme's named colours.** Epic candybar-theme-colours-6fq5 holds every closed cell to a colour its palette names, and a test checks every background the bundled closed bar draws. Prism's gap, textual-ansi's flat ladder and ansi's 16 slots leave the named colours too close on many joins.

**Authored `bg` is meaning.** An alert's or threshold's colour says something. Moving it to clear a seam changes what it says. Two neighbouring alerts in one colour are a real case.

**Open menus.** The open trigger's state colour must clear STATE_FLOOR against what its row wears. It is one value shared by the trigger, the ✕ and the blank leads. Band colours come from the lineage of open menus by depth, and the band's identity is independent of position.

**Held cells and effects.** Held cells are fixed bytes from an earlier frame. Effects paint cells and seams *after* the join is chosen, through each colour's owner: a colour taken from a cell's edge belongs to that cell, and a mix of two belongs to neither. The closing flash paints a whole menu row in one fill by design.

**Depth.** At 256 a colour has to survive rounding onto a distinct entry. At ansi, rich-js knows only slot numbers, not colours, so there is no colour arithmetic to do.

**A visible join for identical grounds.** If the joiner must always show a join, then for two identical grounds it needs ink that is neither ground. That ink is a new kind of seam paint: derived from the grounds, or stated by the caller. It needs an owner for effects, and a version at ansi.

**Multi-cell seams and width.** Prism's thirds and torn's midpoint are mixes of the two grounds and collapse as the grounds converge. A seam's width cannot change: rich-js refuses a divider of a different width, and cc-candybar measures each joiner's chrome in columns (`src/render/strip.ts`).

**ASCII.** Most arrow joiners draw their ascii seam and divider with one glyph (`>` for powerline) and tell them apart by colour alone. Pixel and ice are the exceptions: their ascii seams are `#` and `]`, and their ascii divider is `>`.

**cc-candybar's project rules** (`CLAUDE.md`):
- **One render path.** No parallel renderer and no fallback computation.
- **One store.** The variable store is the single source of truth for derived values, and no cache is added beside it.
- **Variability lives in data.** Variability lives in the payload, not in branches.
- **Errors are loud.** A bad config draws a red or amber strip, and nothing a config author writes can make a render throw.
- **The daemon is detached.** Every fact about a session arrives as a hint.
- **Memory.** The daemon works under a memory limit with budgeted caches (`.claude/memory/daemon-memory.md`). Today, colour choices are memoised per region. A choice that depends on neighbours changes what those memos can key on.
- **Versioning.** cc-candybar publishes 1.x only. A rich-js change ships as a rich-js release and a dependency bump.

**Tests that assert the divider.** In rich-js, `test/core/strip.test.ts` asserts it in several places: an equal-ground join drawn as the divider in the left cell's text colour, the divider on the left cell's own ground, the powerline divider glyph, and torn's divider. Brandon's order to reverse such tests applies to these too. In cc-candybar, the reversals are on `fix/joiners-57p`. The snapshots in `test/__snapshots__/default-menu-bytes.test.ts.snap` and `test/__snapshots__/dsl-spine.test.ts.snap` contain the divider glyph U+E0B1. So do the doctor's glyph check and `test/helpers/bundled-glyphs.ts`.

## Open questions

1. Where is a cell's colour decided: from its address during the walk (today), or with the whole line in view while rich-js composes it?
2. If colours are decided at compose time, how do templates that read their own ground get it: as a late-bound reference, by evaluating again, or not at all?
3. Should a joiner ever draw a divider? If not, what does it draw between two identical grounds, at each depth?
4. Is it acceptable for two neighbours to share a ground once the join between them is visible, or must they always differ in shade? Ticket 57p's title treats a shared ground as the error. Its description treats the divider as the error. The epic's checkpoint asks for two shades *and* a filled arrow.
5. What happens to the cc-candybar code that exists to keep the divider away: the menu-band seam rules and reports in `src/themes/decor.ts`, its copy of `SEAM_MIN_DELTA_E`, and brandon-menus-sjhy.hdw? Each piece becomes shade policy, or is removed.

# Joiners: why two neighbours draw a divider, and what a fix has to hold

The thin line Brandon sees between two cells (for example 🍫 › polled, or context › ceiling › autocompact) is drawn on purpose, by a rule inside rich-js's joiner. When the two grounds on either side of a join are too close for the filled seam to show, the joiner draws its divider instead: the thin form of its glyph, in the left cell's text colour, on the left cell's ground. On a dark text colour that is a dark chevron line. The decision is made inside rich-js's `CellJoiner`, from the finished cells, at the moment the strip is drawn. Nothing before that point can see the line as it will be drawn.

Four plans tried to stop this from cc-candybar's side, by dealing every cell a ground the joiner would separate from its neighbour. All four failed review, and each review found routes that plan had missed. The fix belongs in rich-js, and rich-js exists for this project: cc-candybar is its only consumer. This document gathers what a fix has to hold, so the design can start from the mechanism instead of from another list of routes.

## How rich-js chooses the divider

Every joiner has two forms for the space between two cells: a **seam** (the filled arrow, slant, prism steps and so on) and a **divider** of the same width. The joiner draws the seam unless *every* seam cell's ink would vanish into that same cell's ground, and then it draws the divider (`src/core/strip.ts` in rich-js, `CellJoiner` and the rule beside `SEAM_MIN_DELTA_E`).

"Vanish" depends on the colour depth:

- **Truecolor and 256.** Ink and ground are measured as drawn, downgraded to the depth and flattened onto black. A seam cell vanishes when they are less than ΔE_OK 0.04 apart. At 256, two colours that round to one table entry are one colour.
- **ansi.** The 16 slots take their RGB from the user's terminal theme, so rich-js cannot measure them. A seam cell vanishes when ink and ground are the same slot.

In every joiner that has a divider, the seam's ink is built only from the two grounds. An arrow's ink is the left ground over the right ground. Prism draws three arrows that step through the thirds between the two grounds. Torn draws over their midpoint. So as two grounds converge, every seam converges with them, and seams made of several cells lose their ink much sooner than single arrows do. Measured through rich-js's own joiner, comparing each join against the same joiner with its divider replaced by its seam, this is the smallest gap between grounds at which the seam is drawn:

| depth | powerline / slant / bubble | torn | prism |
|---|---|---|---|
| truecolor (grey `#303030`, blue `#336699`) | ΔE 0.041–0.043 | 0.078–0.081 | 0.115–0.118 |
| 256 (grey) | 0.062 | 0.118 | 0.137 |

At 256 the threshold is whatever the rounding makes it. A blue pair only 0.007 apart already lands on two different table entries and gets its seam.

The joiner also reads a cell's *edge character*, not the cell as a whole: the style of its first and last characters, inline spans included (`src/core/text.ts`, edge style). A cell whose last character wears its own background joins on that background.

Joiners whose divider is their seam can never draw a divider: plain, capsule, metro, stitch and wrapper. The other nine have a divider form: powerline, slant, backslant, flame, pixel, ice, bubble, prism and torn. The joiner is a user setting, and every one of them can be selected.

## How often it happens today

The bundled bar was rendered through the in-process rig (`test/helpers/session-bar.ts`) under all 23 bundled themes. Each theme was drawn six ways: the closed bar, and the settings menu open on each of its five tabs. That is 138 frames per depth and joiner, and I counted divider glyphs against seam glyphs. Torn is left out because its divider uses the same glyphs as its seam, so the glyphs alone can't tell the two forms apart.

| depth | joiner | dividers | seams | frames with a divider |
|---|---|---|---|---|
| truecolor | every arrow joiner | 147 | 4545 | 53 / 138 |
| truecolor | prism | 1676 | 1498 | 138 / 138 |
| 256 | every arrow joiner and prism | 83 | ≈4600 (prism 3091) | 63 / 138 |
| ansi | every arrow joiner and prism | 455 | ≈4200 (prism 2719) | 138 / 138 |

Two of these rows matter most. Under prism at truecolor the bar draws more dividers than seams, on every frame. The themes' own neighbouring shades sit a powerline gap apart, not a prism gap. At ansi every frame has a divider, because a theme's neighbouring shades round to one of only 16 slots. The closed bar's 🍫 › polled join divides under atom-one-dark, atom-one-light, catppuccin-frappe and catppuccin-latte, among others.

## Why cc-candybar cannot prevent it from its side

The four plans are on lit ticket brandon-menus-sjhy.57p, with their reviews (`lit show brandon-menus-sjhy.57p`). They share one shape: deal each cell a ground the joiner shows its seam against, given its left neighbour. This shape fails because cc-candybar picks a cell's ground during the render walk, which visits each placement once, left to right, and fixes the cell's text colour for that ground. The joiner decides later, from the finished line. Each place where the finished line differs from what the walk saw is a route to the divider. The reviews found these places:

- **Held cells.** A placement that is dissolving out replays the cells it drew in an earlier frame, as fixed bytes. Whether a placement is held is known only after the walk has passed it, and by then its left neighbour has its ground. Walking the neighbour again is not possible: a placement reached twice in one frame throws (`src/render/effect.ts`). Re-dealing the held cells means restyling cells that are already laid out, and their text colour was chosen for the old ground.
- **Two fixed cells meeting.** When a placement between two held cells leaves without holding anything, the two held cells become neighbours, and neither one can move.
- **Cells painted after the walk.** In an open menu, each row's ✕ or blank lead is added after the walk, in the open trigger's colour (`src/dsl/node-registry.ts`). Picker lists are vertical containers, where each child starts a new line. A left-to-right fold therefore checks each row's first item against the previous row's last cell instead of against its lead.
- **The open trigger's state.** The trigger, the ✕ that leads its menu and the blank leads under it wear one state colour. That colour belongs to the menu's band, and the band's identity deliberately reads nothing about where its trigger sits. Neighbouring bands are found by adjusting the identity's depth (`src/themes/decor.ts`). Making the state depend on the trigger's left neighbour breaks that arithmetic, and it gives one band several nested states while its plane is held off only one.
- **Edge characters.** With padding 0, which two bundled presets set, a template's first or last character can wear its own background and decide the join, out of reach of any choice of the cell's ground. A cell's lead and trail parts are joined after sizing, so they form its outer edges.
- **Theme names and depth.** textual-ansi names several shades of a role alike, and 256 and ansi rounding merges neighbouring tones. Prism needs about three times powerline's gap. Keeping every join a seam therefore moves cells off the theme's named colours on a large share of joins, against the rule of epic candybar-theme-colours-6fq5 that closed cells wear the theme's named colours.
- **Floors that interact.** A trigger's state must clear STATE_FLOOR against what its row wears, and text must clear its contrast floor against its ground. Each colour a plan moves to clear a seam has to clear these again, and every plan reopened one of them.

Each plan closed the routes it knew and missed others. The routes come from one cause: cc-candybar has to predict a decision that only the joiner can see.

## What a fix in rich-js has to hold

At the joiner, every route above is the same case: two finished cells and the grounds at their facing edges. So a joiner that never draws a divider closes all of them at once. These are the concerns such a joiner has to answer.

**A visible join for any pair of grounds, including identical ones.** The divider exists because a seam inked only in the two grounds disappears when they meet. Deleting the divider brings back a seam you can't see, and the two cells read as one. A join that always shows needs ink that is neither ground: a colour derived from the grounds (in rich-js's own OKLCH, for example), or one the caller states. That is a new kind of seam paint.

**Every depth.** At truecolor any derived colour can be drawn. At 256 the derived colour has to survive rounding onto a different table entry from both grounds. At ansi there are only 16 slots, rich-js does not know their RGB, and the vanish rule compares slot numbers. So a derived ink at ansi has to be a different slot, picked without any colour arithmetic.

**Seams with several cells.** Prism's thirds and torn's midpoint are mixes of the two grounds. As the grounds converge, these collapse onto one colour. Either their mixes gain an end that is not a ground, or they change shape when grounds are close. Whichever it is, the seam stays the same width: rich-js refuses a divider of another width, and cc-candybar's layout measures each joiner's chrome in columns (`src/render/strip.ts`).

**Effects and owners.** Effects paint seam cells after the join is chosen, through each colour's owner: a colour taken from a cell's edge belongs to that cell, and a mix belongs to neither. A derived ink needs an owner rule, so that a fade or a wheel moves it with the right cell. The closing flash paints a whole menu row in one fill by design, and its joins sit inside that fill.

**ASCII output.** Most arrow joiners draw their ascii seam and divider with one glyph (`>` for powerline) and tell them apart by colour alone, so the colour rule has to hold there too. Pixel and ice are the exceptions: their ascii seams are `#` and `]`, and their ascii divider is `>`.

**Tests in rich-js that assert the divider.** `test/core/strip.test.ts` asserts it in several places: the equal-ground join drawn as the divider in the left cell's text colour, the divider on the left cell's own ground, the powerline divider glyph, and torn's divider. Brandon's order for cc-candybar ("take any tests that assert this state and reverse them") applies to these too. cc-candybar's own reversals are on branch `fix/joiners-57p`.

## What the joiner fix does not settle

A joiner that always draws a visible seam answers Brandon's report that the joiners are "rendering as a black line rather than the powerline or prism they should be." It does not make two neighbours different shades. The menus epic asks for both: "every pair of adjacent segments in the menu is two shades joined by a filled arrow," and its item 4 names neighbours that "share one background." So two decisions remain on cc-candybar's side once the joiner holds:

- Whether two neighbours on one ground, now joined by a visible seam, is acceptable. Ticket 57p's title treats a shared ground as the error itself. Its description treats the divider as the error.
- What happens to the code that exists only to keep the divider from appearing. That is the menu-band item-seam rules in `src/themes/decor.ts` (the open trigger kept apart from its items, the band-item repair, and the seam-shortfall reports and the audits that require them). It is also the divider glyph in the doctor's glyph check and in `test/helpers/bundled-glyphs.ts`, and the snapshots that contain U+E0B1 (`test/__snapshots__/default-menu-bytes.test.ts.snap`, `test/__snapshots__/dsl-spine.test.ts.snap`). Each piece either becomes shade policy or is removed. brandon-menus-sjhy.hdw (cells 8k−1 and 8k sharing a tone) depends on the same answer.

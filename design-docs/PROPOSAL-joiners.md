# Joiners: one enforcer for a visible seam

A plan for the divider problem, written fresh against the laws. It answers the five open questions of the joiners design doc on `fix/joiners-57p` and supersedes the plans on ticket brandon-menus-sjhy.57p, which it did not read.

## The decision

The joiner holds every seam cell's ink apart from that cell's own ground, unconditionally, and the divider form is deleted from rich-js. Between two grounds that already differ, the seam is byte for byte what it is today. Between two grounds that do not, the arrow is the left ground moved the least visible step along its own lightness, so a filled powerline or prism arrow is drawn between every pair of cells on every line, at every depth, under every effect.

cc-candybar stops predicting the joiner. Every floor it states in rich-js's seam constant, every band item it moves to keep a divider away, and every shortfall it reports about a seam, goes. Its colour function stays pure by address, selects named colours only, and never looks at a neighbour.

Separately, and as shade policy rather than seam prevention, cc-candybar fixes the three places where its own policy hands neighbouring cells one shade for no reason: the authored `{ h }` group inside a row, the two addresses that land on one tone, and a dial window whose rungs the depth draws alike.

## Why: no colour policy can hold this invariant

The invariant Brandon asked for is a property of a pair: two adjacent strip items, a filled seam between them. Some pairs are fixed on both sides. A placement dissolving out is replayed as bytes from an earlier frame. Two alerts that both author the same red are meaning, and moving either changes what it says. At ansi a theme's hue has one normal slot and one bright slot, and a row of three cells of that hue repeats one. No function that chooses colours can separate a fixed pair, so no colour policy can guarantee the invariant, however much of the line it is allowed to see. That is why four plans with the line in view still failed review: the line was never the missing input.

The one place every pair passes, fixed or not, is the joiner. `[LAW:single-enforcer]` It is the only possible enforcer of "the seam is visible", so it must be the enforcer, and anything else that enforces the same rule is a second checkpoint that will drift. cc-candybar's `decor.ts` is that second checkpoint today: it imports `SEAM_MIN_DELTA_E` and applies it to pairs of grounds, which is the joiner's rule copied, and copied wrong for prism and torn, whose seams need two to three times the gap. `[LAW:one-source-of-truth]` Two clocks, already disagreeing.

The divider itself is the shape the laws name first. `[LAW:dataflow-not-control-flow]` "The seam, or the divider when every seam cell vanishes" is a conditional in the mechanics: whether the seam is drawn depends on the input. The redirect the law gives is to make the operation unconditional and let the values carry the difference. The seam is always drawn; what varies is how far its ink has to move, which is usually zero. `[LAW:no-silent-failure]` The divider was also a fallback that changed meaning: the seam says "this cell ends here in its own colour", the thin line says "two fields of one group", which is powerline's soft divider. The domain has that convention, and this bar deliberately does not use it, because Brandon reads it as a broken join. The decision to have no soft divider is the design, and it is written here so nobody re-derives the convention and puts it back.

## What rich-js does

### The rule

A join cell's ink, after its paint is resolved from the neighbours' edges, is held at least `SEAM_MIN_DELTA_E` off the cell's own ground, both measured as drawn at the depth (`Style.drawnColors`: flattened onto what lies beneath, downgraded). Where it already stands off, it is returned unchanged. Where it does not, the answer is the nearest colour along the ink's own OKLCH lightness ray, toward white or toward black, whichever is nearer, whose drawn form clears the floor against the drawn ground. The ray is walked in small steps and each step is rounded to the depth, so at 256 and ansi the candidates are the entries the depth actually draws, in ray order; a floor measured on drawn colours is not monotone along a ray, so the walk enumerates and never bisects. A side the renderer cannot measure, the terminal's own ground or reverse video over it, is left alone, as `vanishes` leaves it today.

This is one function in rich-js's colour math, beside `ensureDrawn` and `ensureContrastToward`, and it is the only place the seam floor is applied. cc-candybar's open-trigger search already walks a hue's lightness rays with the same shape and the same caveat about drawn colours, so this block is one it can adopt later; that adoption is not part of this work.

Measured through rich-js 0.24.1's own arithmetic, the lift between two identical grounds:

| ground | truecolor ink | at 256, drawn | at ansi, drawn |
|---|---|---|---|
| `#303030` | `#262626` | `#262626` | bright black |
| `#336699` | `#3f72a6` | `#5f5faf` | bright cyan |
| `#fafafa` | `#ececec` | `#eeeeee` | silver |
| `#c0392b` | `#ce4737` | `#d75f00` | dark red |
| `#1e1e2e` | `#282838` | `#1c1c1c` | bright black |

At ansi the ray lands on the slot's normal or bright twin, which is the VGA palette's own structure, so the lifted arrow is the same hue one step brighter or darker in every terminal theme that keeps the two apart. A terminal theme that draws a slot and its twin alike will merge that one seam, and the detached daemon cannot see that theme. At 256, `#c0392b` already draws as `#af5f00`; the orange is the depth's rounding, not the lift.

### Where it runs

Twice today, once after this work. The join-time path resolves each seam cell's paints from the two edge styles and builds a `Style`. The effect path, for a confined effect, moves a join cell's two sides with whichever item owns each (`ColorOwners`), and leaves a side owned by neither, a mix, where it was. That second path is a copy of the first with the paint model flattened to ownership, and it is already wrong for prism: under a confined effect, prism's inner thirds are mixes, belong to neither neighbour, and do not move while the arrows beside them do.

`[LAW:one-source-of-truth]` A seam's colours have one definition, a function of its two neighbours' edges. So a join cell carries its paints and its two neighbours, not two owners, and the effect stage re-derives every join cell from the effected looks of the edge cells beside it, through the same resolution the join-time path uses, apart rule included. The edge cells are positional: the last item cell before the join and the first after it, which is how the seam was laid in the first place. `confined` keeps narrowing an effect to its owners' item cells; the join cells follow from those by derivation, not by membership. With that, prism's thirds move, torn's tear moves, and the seam stays visible under any effect, including one that paints two neighbours the same colour.

One visible consequence to expect: the closing flash paints a whole menu row in one fill, and today that erases the seams for the flash. Under this plan the flash shows each seam as a lifted notch at the visibility threshold. The row is still N cells during the flash, which is what the invariant says; this is the trade and it is accepted.

### What goes

- `SeamForm.divider`, `JoinShape.divider`, the width-equality check in `parseSeam`, the `lost` branch in `CellJoiner.join`, and `vanishes` as a predicate. Its measurement becomes the apart rule's measurement.
- The thin forms of every family: `thin` and `asciiThin` on `Family`, the divider cells of `arrow`, `prism`, `torn`, and the `divider: seam` echoes on the five seams that never had one, `gradientSeam` included.
- The tests in `test/core/strip.test.ts` that assert a divider, reversed: an equal-ground join draws the seam, and its ink stands off its ground as drawn.
- The "Seams" and "Built-in joiners" passages of `docs/strip.md` that describe the divider and name the vim-airline convention. The convention is named here instead, with the reason it is not used.

`[LAW:polishing-by-subtraction]` The joiner ends smaller than it starts: one form per seam, one branch fewer, one predicate fewer, and the paint model unchanged.

Released as rich-js 0.25.0: `SeamForm` loses a field, which is a breaking change for its one consumer, and the consumer's bump lands in the same day's work.

## What cc-candybar deletes

Everything that exists to keep the divider away. Each item is identified by the constant it is stated in: a floor stated in `SEAM_MIN_DELTA_E` exists for the joiner and goes; a floor with a constant of its own (`STATE_FLOOR`, `TEXT_MIN_CONTRAST`, `BAND_FLOORS`) exists so menus and text read, and stays.

- The `SEAM_MIN_DELTA_E` import in `src/themes/decor.ts` and every use: the "told from" floor and the `apart` parameter of the state search; `drawnSeams` and `seamShortfalls`; the item repair in `drawnItems`; the per-item `keptApart(SEAM_MIN_DELTA_E, …)` floor in the plane search, the item-against-plane floor included.
- `Band.shortfalls` keeps the state shortfall only. The `band-floor` warning kind stays, since the state shortfall still reports through it; its seam messages go, and `check.ts` and the daemon's switch over the kind are untouched.
- `plainWith` and `stripPrivateGlyphs` in `src/render/strip.ts` follow the new `SeamForm`; the glyph probe draws two cells, not three. The doctor's Nerd Font check and `test/helpers/bundled-glyphs.ts` measure through the joiner and shrink by one glyph on their own.
- `test/helpers/powerline.ts` loses `divider`. The two snapshot files regenerate with U+E0B0 where U+E0B1 was.
- The reversed tests already on `fix/joiners-57p` land as they are: no divider glyph on any row of any frame, every join a filled arrow. One assertion in `test/colour-256.test.ts` changes meaning: "an arrow continues the cell before it" becomes "an arrow's ink is the left ground wherever that ground already stands off the right as drawn, and the lifted colour rich-js's apart function returns elsewhere", with rich-js as the oracle, as the style tests already use it.
- `.claude/memory/colour.md`: the lines on the "told from" floor, the band item repair at 256 and ansi, and "Between bands, floors are measured as ΔE in OKLab" where it refers to seams. One line replaces them: a seam's ink is held apart from its ground by the joiner, so nothing here predicts whether a join will show, and two neighbours on one ground are a fact of the config or the theme, drawn with a visible arrow and never reported.
- `docs/interaction-authoring.md`'s sentence about cells parted by the joiner's divider.
- The memoisation of colour choices per region is untouched: no choice depends on a neighbour, so nothing changes what the memos key on. The seam's one extra ΔE per join cell is the measurement `vanishes` already makes every frame.

## What cc-candybar's policy fixes

These are not seam prevention. With the joiner correct, a pair of neighbours on one ground is drawn well. These three are places where the policy chooses one shade for cells that sit side by side when it has a different shade to give, and that choice is what Brandon's menu checkpoint, "two shades joined by a filled arrow", is about. Each is its own ticket, ranked below the two PRs above, and each is cut by Brandon if he does not want it.

1. **An authored `{ h }` inside a row is a group of cells, not a cell.** `decorEntryFor` reads the first cell-axis step and ignores what is nested under it, so Brandon's `{ h: ["context", "plugins.memento.ceiling", "autocompact"] }` wears one shade three times. The rule's own reason, "a row's cells are what sit side by side, so they are what must differ", is the argument against applying it here: those three sit side by side. The leaves of a row, through any nested `{ h }`, take positions among the row's leaves, computed from the authored tree alone, so hiding still recolours nothing and adding a group shifts the cells after it as adding a cell does. What a cell splices into itself as one unit, edit mode's chrome and the settings door's frame rate, keeps wearing the cell's shade; the loader already refuses a `distribution` inside a cell, and refuses it inside a nested `{ h }` for the same reason.
2. **Adjacent authored cells never select one tone** (brandon-menus-sjhy.hdw, folded in). Under van der Corput read by nearest point over three tones, cells 7 and 8 both land on tone 0, and so does every pair 8k−1, 8k. The fix is a property, stated once and tested once: for every row length the bundled bar reaches and every dial position, adjacent authored positions select different tones. The memory file already says what the design wants, a walk up and down the window one rung at a time; the test pins it, and the distribution or the quantize rule changes to meet it. This cannot cover hiding: any address-only colouring has two cells of one tone at distance two, and hiding what lies between them makes them meet. That residue is what the joiner is for.
3. **A dial window is the rungs the depth draws as distinct colours.** textual-ansi names several rungs of a role alike, and 256 and ansi round neighbouring rungs onto one entry or slot. A window built per palette and depth from the rungs whose drawn colours are distinct, by identity after rounding and with no threshold, gives neighbours the shades the depth can actually show, keeps every closed cell on a named colour, and synthesises nothing. Where a theme is flat at a depth, the window is one tone and the bar wears it with lifted arrows: that is the theme's own look at that depth, not an error, and it is not reported.

## The open questions, answered

1. **Where is a cell's colour decided?** From its address during the walk, as today. Deciding it at compose time was the fourth plan's shape in another costume: it still cannot move a fixed cell, and it would need every template that reads its own ground (`bgOf`, `tint`, the alert cascades' calm arm) to be late-bound or evaluated twice.
2. **How do templates get their ground if it is chosen late?** They do not need to; it is not chosen late.
3. **Should a joiner ever draw a divider?** No. Between two identical grounds it draws its seam with the ink lifted the least visible step along the left ground's lightness, at every depth. That is a rule applied to a paint, not a new paint kind, so the authored seam vocabulary is unchanged and the ink still belongs to the neighbour whose edge the paint names.
4. **May two neighbours share a ground once the join is visible?** It must be representable, because fixed pairs exist, and it is drawn well. It must never be the policy's own doing where the policy has a choice, which the three policy items above remove. What remains is a fact about the config or the theme, and it is not an error and not reported.
5. **What happens to the code that keeps the divider away?** It is deleted. None of it becomes shade policy, because it is all stated in the joiner's constant; the shade policy that remains is the three items above, each with a reason that does not mention the joiner.

## Alternatives rejected

- **The strip moves a cell's ground when a seam would vanish.** Gives the renderer authority over colours that carry meaning, and reopens text contrast and the named-colour rule inside rich-js: a second enforcer for both.
- **A dedicated seam ink role for same-ground joins.** A second kind of seam, which is the mode this plan removes, and a theme role that is a second clock for how a join looks.
- **Colour by drawn position so neighbours always differ.** Covers none of the fixed pairs, and gives up "hiding recolours nothing", which the stability of the bar under `when` gates depends on.
- **Lift the right ground instead of the left ink.** The arrow is the left cell's tip; the first column of the right cell should be the right cell's ground.
- **Lift further than the floor so the arrow is unmistakable.** One constant is the source of truth for "visible"; if the floor is too low to the eye it is raised in rich-js, once, and the seam and every floor that reads it move together.

## Acceptance

`[LAW:verifiable-goals]` Done has this shape, and every check is run by the session that makes the change.

rich-js:
- For every named joiner, every depth, and ground pairs at ΔE 0, 0.01, 0.03 and 0.2 apart, every seam cell's drawn ink stands at least `SEAM_MIN_DELTA_E` off its drawn ground; at ansi, a different slot.
- For every pair at or above the floor, the bytes equal rich-js 0.24.1's bytes for the same join.
- No named seam's output contains a divider glyph; the `Family` type has no thin form to contain.
- Under a confined effect that paints both neighbours one colour, every join cell's ink stands off its ground, and prism's inner thirds take the effected colours.

cc-candybar:
- The reversed tests on `fix/joiners-57p`, green: no divider glyph on any row of the closed bar or any settings tab under all 23 themes at truecolor, 256 and ansi; every join an arrow.
- The arrow-ink assertion at 256 and ansi holds with rich-js's apart function as oracle.
- Every closed cell's background is a named palette colour, as today.
- Policy 1: Brandon's status row draws its three grouped cells in three distinct tones.
- Policy 2: the adjacency property holds for every row length to 16 under every dial position.
- Policy 3: under textual-ansi at ansi, the bundled bar's window has the tones the depth draws distinct and no more.

## Order of work

1. rich-js, one PR: the apart function, the join-time rule, the divider deleted, tests, docs. Release 0.25.0.
2. rich-js, one PR: join cells re-derived from effected edges; tests for prism under a confined effect and for a same-colour fill. Release 0.25.1, or folded into 1 if it lands first.
3. cc-candybar, one PR: the dependency bump, the deletions above, the reversed tests, the memory and doc lines. This PR closes brandon-menus-sjhy.57p.
4. cc-candybar, three tickets under the menus epic, in the order listed, each its own PR.

cc-candybar stays 1.x throughout; each PR is a `fix`. The wire contract is untouched.

## Not verified

- The lift table was measured by walking the ray in steps of 0.001 in OKLCH lightness through rich-js's public arithmetic, not through the function this plan proposes; the function will reproduce it or the test will say so.
- The ansi column names slots by the VGA palette rich-js assumes; a user's terminal theme decides what those slots look like.
- The count of lines `decor.ts` loses was not measured. It is every line that reads the seam constant and the structures that exist only to feed them.

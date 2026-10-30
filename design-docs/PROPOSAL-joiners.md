# Joiners: every join is a filled arrow between two shades

The plan for the divider problem described in the joiners design doc on `fix/joiners-57p`. It supersedes the plans on ticket brandon-menus-sjhy.57p, which it did not read. Brandon's requirements, in his words: "don't put the same color on two adjacent segments"; the divider is an error state to make "structurally impossible"; "i want this fixed in rich-js"; and the contrast floors around open menus were never his, so they go.

## The decision

Three rules, each with one owner.

1. **rich-js's joiner always draws its filled seam.** Where the two cells' `bg`s are too close for the arrow to show, the arrow's `fg` is lifted off its own `bg` by the least visible step along its lightness. The thin divider form is deleted. This is the backstop that makes the error state impossible to draw, whatever the two colours are, including two alerts authored in one red.
2. **Every colour on the bar is one the theme names.** Closed cells already select a role at a shade. The segment whose menu is open (its activated state), the ✕ and blank leads of its menu, and the plane its menu rows sit on also select named shades. Nothing searches for a colour, nothing measures a contrast floor between cells, and nothing reports a shortfall. Text keeps the one floor that is about reading: `fg` is chosen to clear AA on its `bg`, as today.
3. **cc-candybar's shade policy never gives two neighbours one shade where it has a choice.** Three places do today, and each becomes a rule with a test.

The interface between the libraries after this work is cells with `bg` and `fg`, and the strip that joins them. cc-candybar imports no colour rounding or search from rich-js.

## rich-js

### The rule

A join cell's `fg`, after its paint is resolved from the two edge cells, is held at least `SEAM_MIN_DELTA_E` off the cell's own `bg`, both measured as drawn at the depth (`Style.drawnColors`: flattened onto what lies beneath, downgraded). Where it already stands off, it is unchanged, so every join that shows today is byte for byte the same. Where it does not, the `fg` becomes the nearest colour along its own OKLCH lightness ray, toward white or toward black, whichever is nearer, whose drawn form clears the floor against the drawn `bg`. The ray is walked in small steps and each step is rounded to the depth, so at 256 and ansi the candidates are the entries the depth draws, in ray order; a floor measured on drawn colours is not monotone along a ray, so the walk enumerates and never bisects. A side the renderer cannot measure, the terminal's own background or reverse video over it, is left alone.

Measured through rich-js 0.24.1's own arithmetic, the lift between two identical `bg`s:

| bg | truecolor fg | at 256, drawn | at ansi, drawn |
|---|---|---|---|
| `#303030` | `#262626` | `#262626` | bright black |
| `#336699` | `#3f72a6` | `#5f5faf` | bright cyan |
| `#fafafa` | `#ececec` | `#eeeeee` | silver |
| `#c0392b` | `#ce4737` | `#d75f00` | dark red |
| `#1e1e2e` | `#282838` | `#1c1c1c` | bright black |

At ansi the ray lands on the slot's normal or bright twin. A terminal theme that draws a slot and its twin alike merges that one seam, and the detached daemon cannot see that theme.

`[LAW:dataflow-not-control-flow]` "The seam, or the divider when every seam cell vanishes" is a mode. The seam is always drawn; what varies is how far its `fg` moves, usually zero. `[LAW:single-enforcer]` The joiner is the only place every pair of neighbours passes, so it is the only place "the seam is visible" can be guaranteed, and nothing outside it predicts whether a join will show.

### Effects

Today a join cell's colours are resolved once at join time, and an effect confined to some items moves each side of a join cell with whichever item owns it, leaving a mix (prism's inner thirds, torn's midpoint) where it was. `[LAW:one-source-of-truth]` A seam's colours are a function of its two neighbours' edges. After an effect has painted the item cells, every join cell is re-derived from the effected edges beside it through the same resolution the join-time path uses, lift included. Prism's thirds then move under a confined effect, and a fill that paints two neighbours one colour still shows each seam as a lifted notch. The closing flash, which fills a whole menu row, shows those notches; that is accepted.

### What goes

- `SeamForm.divider`, `JoinShape.divider`, the width-equality check in `parseSeam`, the `lost` branch in `CellJoiner.join`, and `vanishes` as a predicate.
- The thin forms of every family, the divider cells of `arrow`, `prism` and `torn`, and the `divider: seam` echoes on the seams that never had one.
- Every test in `test/core/strip.test.ts` that asserts a divider, reversed: an equal-`bg` join draws the seam and its `fg` stands off its `bg` as drawn.
- The passages of `docs/strip.md` that describe the divider.

Released as 0.25.0 after the lift, 0.25.1 after the effects change if it lands separately.

## cc-candybar

### What goes

Everything that searched for a colour or measured a floor between cells. By the constant each is stated in:

- `SEAM_MIN_DELTA_E`: the "told from" floor, `drawnSeams`, `seamShortfalls`, the band item repair in `drawnItems`, the per-item floors in the plane search.
- `STATE_FLOOR`: `searchState` and its rays, `RAY_HALVINGS`, `STATE_STEPS`, the `StateSearch` anchor kept unrounded, `short`.
- `BAND_FLOORS` and `PLANE_STEPS`: the plane blend toward `background` or `foreground`, `computeUnroundedBand`, the nested-plane floor.
- `Band.shortfalls`, the `band-floor` warning kind and its producer in the render, and the cases over it in `check.ts` and the daemon.
- The imports those used: `ensureDrawn`, `drawnColour`, `contrastRatio`, `contrastFor`, `blendRgb`, `Oklch`, `SEAM_MIN_DELTA_E`.
- `plainWith` and `stripPrivateGlyphs` in `src/render/strip.ts` follow the new `SeamForm`; the glyph probe draws two cells. `test/helpers/powerline.ts` loses `divider`. The two snapshot files regenerate with U+E0B0 where U+E0B1 was.
- The lines in `.claude/memory/colour.md` on the state search, the floors, the band item repair, and "its cells parted by the joiner's divider" in the shade table's comment. The sentence in `docs/interaction-authoring.md` about cells parted by the divider.

Text contrast stays: `textOn`, `readableOn`, `ensureContrast` for `fg` on `bg`, `keptOn` for the door's ✖. Those are about reading, not about neighbours.

### What replaces it: named shades for the activated state and the plane

A segment whose menu is open is a pressed button. Toolkits give that state a named style from the theme, and so does this: the activated segment, the ✕ and the blank leads of its menu wear the menu hue's **muted** form, the role blended most of the way into the theme's background, which is what Textual's flat buttons wear. On the `muted` dial position, where the row's cells are already muted, the activated state wears the role itself. This is one more column of the shade table, `activated`, with a rung per dial position, so a new position states its own.

The plane a menu's rows sit on wears the theme's `surface`, at every depth of nesting. Items keep wearing the menu hue at the window's tones, as today.

The menu hue at each depth still comes from the lineage, and `Band` keeps `state`, `plane` and `items`; only how they are chosen changes, from a search to a lookup. Band colours are therefore pure functions of (palette, lineage, depth, dial), computed unrounded and rounded once when drawn.

### Policy: neighbours never share a shade where policy chooses

1. **Cells inside an authored `{ h }` group in a row, and the settings door with its frame-rate cell, take consecutive row positions.** Today a container inside a row is one address, so `{ h: ["context", "plugins.memento.ceiling", "autocompact"] }` wears one shade three times, and so do 🍫 and `polled`. The leaves of a row, through any nested `{ h }`, take positions among the row's leaves, computed from the authored tree alone, so hiding still recolours nothing. Edit mode's chrome stays spliced into its cell as one unit, because entering edit mode must not recolour the bar.
2. **Adjacent positions never select one tone** (brandon-menus-sjhy.hdw, folded in). Under van der Corput read by nearest point over three tones, positions 7 and 8 both land on tone 0. The fix is a property, stated once and tested once: for every row length the bundled bar reaches and every dial position, adjacent positions select different tones. The `muted` dial position has one tone and fails the property by construction; it becomes two tones, the role's muted form alternating with the role itself.
3. **A dial window is the rungs the depth draws as distinct colours.** At 256 and ansi, neighbouring rungs round onto one entry or slot, and textual-ansi names several rungs alike. The window at a depth is built from the rungs whose drawn colours differ, by identity after rounding, with no threshold. Where a theme is flat at a depth, the row wears what it has with lifted arrows; that is the theme's look at that depth.

Policy cannot cover hiding: any address-only colouring has two cells of one tone at distance two, and hiding what lies between them makes them meet. Nor can it cover two alerts authored in one colour. Those pairs are what rule 1 is for, and they are not reported.

## Acceptance

`[LAW:verifiable-goals]` Every check is run by the session that makes the change.

rich-js:
- For every named joiner, every depth, and `bg` pairs at ΔE 0, 0.01, 0.03 and 0.2 apart, every seam cell's drawn `fg` stands at least `SEAM_MIN_DELTA_E` off its drawn `bg`; at ansi, a different slot.
- For every pair already at or above the floor, the bytes equal 0.24.1's bytes for the same join.
- No named seam's output contains a divider glyph, and the `Family` type has no thin form to hold one.
- Under a confined effect that paints both neighbours one colour, every join cell's `fg` stands off its `bg`, and prism's inner thirds take the effected colours.

cc-candybar:
- The reversed tests on `fix/joiners-57p`, green: no divider glyph on any row of the closed bar or any settings tab under all bundled themes at truecolor, 256 and ansi; every join an arrow.
- Every background the bar draws, closed cells, activated segments, leads, ✕ and planes, is a colour its palette names, at truecolor, under every bundled theme and every dial position.
- `src/themes/decor.ts` imports nothing from rich-js that rounds a colour or searches drawable colours, and no `band-floor` warning exists.
- Policy 1: Brandon's status row draws its three grouped cells in three tones, and 🍫 and `polled` in two.
- Policy 2: the adjacency property holds for every row length to 16 under every dial position.
- Policy 3: under textual-ansi at ansi, the bundled bar's window holds the tones the depth draws distinct and no more.

## Order of work

Two lanes, worked in parallel.

rich-js lane:
1. The lift, the divider deleted, tests and docs. Release 0.25.0.
2. Join cells re-derived from effected edges. Release 0.25.1.
3. cc-candybar: bump the dependency, land the reversed tests and snapshots, update the glyph helpers and the two doc lines. Waits on 1.

policy lane, cc-candybar:
4. Delete the floor apparatus; the activated state and the plane select named shades; the named-colour test covers every background the bar draws.
5. Group leaves and the door's frame-rate cell take row positions.
6. Adjacent positions never select one tone; the `muted` position gains a second tone.
7. A window is the rungs the depth draws distinct.

cc-candybar stays 1.x throughout; each PR is a `fix`. The wire contract is untouched.

## Not verified

- The lift table was measured by walking the ray in steps of 0.001 in OKLCH lightness through rich-js's public arithmetic, not through the function this plan proposes.
- The ansi column names slots by the VGA palette rich-js assumes; a user's terminal theme decides what those slots look like.
- How the activated state and the `surface` plane look under each bundled theme was not rendered. Step 4 renders them before it lands.

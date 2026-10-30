# Joiners: every join is a filled arrow between two shades

The plan for the divider problem. The problem statement, with the measurements, routes and constraints, is `design-docs/JOINERS.md` beside this file. This plan supersedes the four plans on ticket brandon-menus-sjhy.57p, which it did not read. Brandon's requirements, in his words, from ticket brandon-menus-sjhy.57p and the session of 2026-10-30 that produced this plan: "don't put the same color on two adjascent segments"; the divider is an error state to make "structurally impossible"; "i want this fixed in rich-js. rich-js exists for this project"; and, of the contrast floors around open menus, "I didn't add or ask for those contrast rules", so they go.

## The decision

Three rules, each with one owner.

1. **rich-js's joiner always draws its filled seam.** Where the two cells' `bg`s are too close for the arrow to show, the arrow's `fg` is lifted off its own `bg` by the least visible step along its lightness. The thin divider form is deleted. This is the backstop that makes the error state impossible to draw, whatever the two colours are, including two alerts authored in one red. At ansi it holds as far as the terminal keeps its sixteen slots distinct, which the detached daemon cannot see.
2. **Every background the policy chooses is one the theme names.** An authored `bg` (an alert, a threshold, the diagnostics indicator) is meaning and stays as authored. Closed cells already select a role at a shade. The segment whose menu is open (its activated state), the ✕ and blank leads of its menu, and the plane its menu rows sit on also select named shades. Nothing searches for a colour, nothing measures a contrast floor between cells, and nothing reports a shortfall. Two foregrounds are not named colours and stay that way: text, which keeps the one floor that is about reading (`fg` is chosen to clear AA on its `bg`, as today), and the lifted seam `fg` of rule 1.
3. **cc-candybar's shade policy never gives two neighbours one shade where it has a choice.** Four places do today, and each becomes a rule with a test.

The interface between the libraries after this work is cells with `bg` and `fg`, and the strip that joins them. cc-candybar states no floor between cells and runs no search for a colour; what it still imports from rich-js for colour is contrast for text and rounding for identity.

## rich-js

### The rule

A join cell's `fg`, after its paint is resolved from the two edge cells, is held at least `SEAM_MIN_DELTA_E` off the cell's own `bg`, both measured as drawn at the depth (`Style.drawnColors`: flattened onto what lies beneath, downgraded). Where it already stands off, it is unchanged. Where it does not, both rays from the `fg`'s OKLCH lightness are walked, toward white and toward black, at constant chroma and hue, in small steps with each step rounded to the depth; the answer is the clearing candidate with the smaller lightness move. "Clears" is judged on the drawn step, so at 256 and ansi the candidates are the entries the depth draws, in ray order, and the side can differ between depths for one pair. A floor measured on drawn colours is not monotone along a ray, so the walk enumerates and never bisects.

At ansi the drawn colours are slots with no RGB unless a terminal theme is supplied, so ΔE is undefined; the floor there is "a different slot", which is what `vanishes` compares today. The ray starts from the `fg`'s colour before downgrading, each step is downgraded, and the first step landing on a slot different from the `bg`'s is taken; a `fg` authored as a slot starts from the RGB the default terminal theme gives it. A side the renderer cannot measure, the terminal's own background or reverse video over it, is left alone.

Today the divider is drawn only when every seam cell vanishes, while the lift is per cell. So the guarantee is: with no effect in play, every join in which every seam cell already clears the floor is byte for byte what it is today. A prism or torn join whose middle cell alone is under the floor changes, because that cell lifts; that is intended. Under a confined effect the next section changes which colours a join cell is derived from, so the guarantee is about the join-time path.

Measured through rich-js 0.24.1's own arithmetic, the lift between two identical `bg`s:

| bg | truecolor fg | at 256, drawn | at ansi, drawn |
|---|---|---|---|
| `#303030` | `#262626` | `#262626` | bright black |
| `#336699` | `#3f72a6` | `#5f5faf` | bright black |
| `#fafafa` | `#ececec` | `#eeeeee` | silver |
| `#c0392b` | `#ce4737` | `#d75f00` | dark red |
| `#1e1e2e` | `#282838` | `#1c1c1c` | blue |

`#1e1e2e` lifts lighter at truecolor and darker at 256: the nearer clearing step is on a different side at each depth. At ansi the ray lands on the nearest slot along the hue's own lightness that differs from the `bg`'s: often the slot's normal or bright twin, sometimes a neighbouring hue's slot. A terminal theme that draws those two slots alike merges that one seam, and the detached daemon cannot see that theme.

`[LAW:dataflow-not-control-flow]` "The seam, or the divider when every seam cell vanishes" is a mode. The seam is always drawn; what varies is how far its `fg` moves, usually zero. `[LAW:single-enforcer]` The joiner is the only place every pair of neighbours passes, so it is the only place "the seam is visible" can be guaranteed, and nothing outside it predicts whether a join will show.

### Effects

Today a join cell's colours are resolved once at join time, and an effect confined to some items moves each side of a join cell with whichever item owns it, leaving a mix (prism's inner thirds, torn's midpoint) where it was. `[LAW:one-source-of-truth]` A seam's colours are a function of its two neighbours' edges. After an effect has painted the item cells, every join cell is re-derived from the effected edges beside it through the same resolution the join-time path uses, lift included. Prism's thirds then move under a confined effect, and a fill that paints two neighbours one colour still shows each seam as a lifted notch. The closing flash, which fills a whole menu row, shows those notches; that is accepted. Between 0.25.0 and 0.25.1 an effect that paints two neighbours alike hides the seam exactly as today's code does, because a join cell's sides still follow their owners; the lift makes nothing worse under effects, and the re-derivation makes it right.

### What goes

- `SeamForm.divider`, `JoinShape.divider`, the width-equality check in `parseSeam`, the `lost` branch in `CellJoiner.join`, and `vanishes` as a predicate.
- The thin forms of every family, the divider cells of `arrow`, `prism` and `torn`, and the `divider: seam` echoes on the seams that never had one.
- Every test in `test/core/strip.test.ts` that asserts a divider, reversed: an equal-`bg` join draws the seam and its `fg` stands off its `bg` as drawn.
- The passages of `docs/strip.md` that describe the divider.

`gradientSeam` is a seam like any other and lifts per cell; between two near grounds its ramp of half-block samples zig-zags, and rich-joiners-er38.a1h decides its form. The byte guarantee above is stated for the named joiners.

Released as 0.25.0 after the lift, 0.25.1 after the effects change if it lands separately.

## cc-candybar

### What goes

Everything that searched for a colour or measured a floor between cells. By the constant each is stated in:

- `SEAM_MIN_DELTA_E`: the "told from" floor, `drawnSeams`, `seamShortfalls`, the band item repair in `drawnItems`, the per-item floors in the plane search.
- `STATE_FLOOR`: `searchState` and its rays, `RAY_HALVINGS`, `STATE_STEPS`, the `StateSearch` anchor kept unrounded, `short`.
- `BAND_FLOORS` and `PLANE_STEPS`: the plane blend toward `background` or `foreground`, `computeUnroundedBand`, the nested-plane floor.
- `Band.shortfalls`, the `band-floor` warning kind and its producer in the render, and the cases over it in `check.ts` and the daemon.
- The imports that exist for the floors: `ensureDrawn`, `blendRgb`, `Oklch`, `SEAM_MIN_DELTA_E`. `contrastFor`, `contrastRatio` and `ensureContrast` stay: text is chosen with them, and `ensureContrast` is the one search left, for a readable `fg` at the depth. `drawnColour` stays for one use, policy 3's identity test of rungs at a depth; rounding a named colour to ask whether the depth draws two of them alike predicts no decision.
- `plainWith` and `stripPrivateGlyphs` in `src/render/strip.ts` follow the new `SeamForm`; the glyph probe draws two cells. `test/helpers/powerline.ts` loses `divider`. `test/doctor-nerd-font.test.ts` asserts the probe's output inline and changes with it. The two snapshot files regenerate with U+E0B0 where U+E0B1 was.
- The lines in `.claude/memory/colour.md` on the state search, the floors, the band item repair, and "its cells parted by the joiner's divider" in the shade table's comment. The sentence in `docs/interaction-authoring.md` about cells parted by the divider.

Text contrast stays: `textOn`, `readableOn`, `ensureContrast` for `fg` on `bg`, `keptOn` for the door's ✖. Those are about reading, not about neighbours.

### What replaces it: named shades for the activated state and the plane

A segment whose menu is open is a pressed button. Toolkits give that state a named style from the theme, and so does this: the activated segment, the ✕ and the blank leads of its menu wear the menu hue's **muted** form, the role blended most of the way into the theme's background, which is what Textual's flat buttons wear. On the `muted` dial position, whose window becomes the muted form and the role itself (policy 2 below), the activated state wears `lighten-2`. This is one more column of the shade table, `activated`, with a rung per dial position, so a new position states its own.

The plane a menu's rows sit on wears the theme's `surface`, at every depth of nesting. A plane is the backing behind a band's rows; a nested band is told by its leads and its hue, not by its backing. Items keep wearing the menu hue at the window's tones, as today.

The menu hue at each depth still comes from the lineage, and `Band` keeps `state`, `plane` and `items`; only how they are chosen changes, from a search to a lookup. Band colours are therefore pure functions of (palette, lineage, depth, dial), computed unrounded and rounded once when drawn.

### Policy: neighbours never share a shade where policy chooses

1. **Cells inside an authored `{ h }` group in a row, and the settings door with its frame-rate cell, take consecutive row positions.** Today a container inside a row is one address, so `{ h: ["context", "plugins.memento.ceiling", "autocompact"] }` wears one shade three times, and so do 🍫 and `polled`. The leaves of a row, through any nested `{ h }`, take positions among the row's leaves, computed from the authored tree alone, so hiding still recolours nothing. The position becomes part of the address when the authored tree is compiled, so a node's colour is still computable from its address alone and the per-region memo keys on it as before. A position is a place on a drawn line: what sits side by side on one line takes consecutive positions, and a `{ v }` inside a row lays its children on lines of their own, each counting from where the `{ v }` sits. Every reader of a cell's position reads the leaf position: the shade, the hue run under `alt`, the line-end keystone (the last leaf of the line wears it), and the set of colours a row's cells wear. Authoring a new cell inside a group shifts the shades of the cells after it, exactly as authoring a new cell in the row does today. Edit mode's chrome stays spliced into its cell as one unit, because entering edit mode must not recolour the bar.
2. **Adjacent positions never select one tone** (brandon-menus-sjhy.hdw, folded in). Under van der Corput read by nearest point over three tones, positions 7 and 8 both land on tone 0, and so does every pair 8k−1, 8k. The fix is a property, stated once and tested once: for every dial position and every row length the bundled bar reaches, adjacent positions select different tones. The mechanism stays a function of the position alone, as van der Corput is, never of the row's length or of which siblings are shown, and holds for every position by construction, not only as far as the test reaches. The `muted` dial position has one tone and fails the property by construction; it becomes two tones, the role's muted form alternating with the role itself, read by bin, because nearest point ties on a two-tone window.
3. **A dial window is the rungs the depth draws as distinct colours.** At 256 and ansi, neighbouring rungs round onto one entry or slot, and textual-ansi names several rungs alike. The window at a depth is the dial's rungs where the depth draws them distinct, by identity after rounding, with no threshold; where it draws two of them alike, the window widens along the ladder to the nearest rung that draws distinct, toward as many tones as the position names, where the ladder has them. That count is what the distributions keep neighbours apart over: van der Corput by halves over two or more, golden angle by bins only over three. But a window never holds the last colour the depth draws of a ladder that draws more than two, because the button pressed in that hue stands beside every tone of its band's window and needs a colour none of them wears: a press drawn like its neighbour puts two neighbours in one colour, which Brandon's rule forbids, while a third closed tone is only the look. Two tones is the floor. So a window holds the position's count where the ladder draws at least one colour more, and two at ansi wherever a ladder draws three slots, where golden angle's neighbours can meet. A window of three is listed as the dial lists a position, lowest, highest, then the one between, because van der Corput deals the third entry at every other cell: in that order a row walks the window a rung at a time as the depth draws it, where an appended rung would wear half the row wherever it stands on the ladder. Each distribution reads a placement into the window by its own rule, whatever the window's size. Only a role whose whole ladder draws as one colour at a depth leaves a row in one tone with lifted arrows; that is the theme's look at that depth, and it is accepted here.
4. **Where a row turns hue, the two cells either side of the turn draw as two colours wherever either has a rung that does** (candybar-joiners-e5r4.5x1). Under `alt` a row turns every three cells, and under a keystone tuning either side of the keystone. A window holds one hue's tones apart and the distribution keeps neighbours of one hue on different tones, but the cell before a turn and the cell after it each take a tone from their own hue's window, and at 256 colours and ansi two hues' rungs often round onto one entry or slot. A window is one hue's, so it cannot see the hue it meets, and no window holds this. Where the depth draws the two alike, by identity after rounding, the cell after the turn takes the first tone of its own window drawn as neither of its neighbours, else the nearest rung of its own ladder that is, through the one widening policy 3 uses. Both neighbours, because its other neighbour is of its own hue and kept apart from it by the distribution: a tone drawn like that one would move the collision one seam over. The moved cell also stands apart from the pressed shade a trigger beside it would wear. Every trigger on the bar opens its lineage at depth 0, so that shade is one colour for the whole bar, known without a position, and it joins the moved cell's taken set. The press cannot keep off the moved cell from its side: it keeps apart only from the tones the windows deal, because a band's colours are a function of palette, lineage, depth and dial and never of where its trigger stands, while the rung a turn moves a cell to is a fact of that cell's place. Where its ladder has no rung drawn as neither of its neighbours nor that shade, the cell before the turn takes one by the same rule, so a keystone starting a line, the cell before its turn, moves only where the cell after it has no such rung. Where neither has one, the two try again apart from their neighbours alone, in the same order, and a trigger beside the one that moves shares its colour; where neither has even that, both keep what they were dealt and rule 1 draws the seam. A cell keeps its hue. Every place of a line is computed from the cell's address and the line is read from its first place to its last, so a cell with a turn on each side (one cell between two keystones) is decided against the cell before it as that one finally stands; the line is memoised as the window is, so a colour is still a lookup of its address and hiding a cell recolours none. The theme preview lays its roles side by side, so its swatches meet by the same rule.

Policy cannot cover hiding: any address-only colouring has two cells of one tone at distance two, and hiding what lies between them makes them meet. Nor can it cover two alerts authored in one colour. Those pairs are what rule 1 is for, and they are not reported.

## Acceptance

`[LAW:verifiable-goals]` Every check is run by the session that makes the change.

rich-js:
- For every named joiner, every depth, and `bg` pairs at ΔE 0, 0.01, 0.03 and 0.2 apart, every seam cell's drawn `fg` stands at least `SEAM_MIN_DELTA_E` off its drawn `bg`; at ansi, a different slot.
- For every join in which every seam cell already clears the floor, the bytes equal 0.24.1's bytes for the same join.
- No named seam's output contains a divider glyph, and the `Family` type has no thin form to hold one.
- Under a confined effect that paints both neighbours one colour, every join cell's `fg` stands off its `bg`, and prism's inner thirds take the effected colours.

cc-candybar:
- The reversed tests on `fix/joiners-57p`, green: no divider glyph on any row of the closed bar or any settings tab under all bundled themes at truecolor, 256 and ansi; every join an arrow.
- Every background the policy chooses, closed cells, activated segments, leads, ✕, planes and items, is a colour its palette names, at truecolor, under every bundled theme and every dial position; authored `bg`s are exempt and listed once in the test.
- `src/themes/decor.ts` no longer imports `ensureDrawn`, `blendRgb`, `Oklch` or `SEAM_MIN_DELTA_E`, defines no `STATE_FLOOR` or `BAND_FLOORS`, and no `band-floor` warning exists.
- The epic's closing sweep: in every bundled frame (every theme, at truecolor, 256 and ansi, the closed bar and each settings tab), no seam joins two grounds drawn as one colour, by identity after rounding; a seam beside a cell whose `bg` the bundled config authors is not held, and those cells are listed once in the test. This is the state Brandon named, "the same color on two adjascent segments", and the policy can hold it without a measure; where a theme names two neighbouring shades within the joiner's floor, the lift draws that seam and that is the theme's look, so "no arrow lifts" is not the test. It lands with policy 3.
- At ansi, in the themes and depths where the role's ladder has no rung drawn apart from what stands beside the press, the press shares a slot with a neighbour and the lift draws that seam: 15 of the 23 bundled themes at ansi, none at 256 or truecolor.
- Policy 1: under every dial position, no two adjacent cells of Brandon's grouped status row share a tone, and 🍫 and `polled` wear two.
- Policy 2: the adjacency property holds for every row length to 16 under every dial position, and the mechanism's argument for every position is written in the PR.
- Policy 3: at every depth, under every bundled theme and dial position, a window holds the position's count of tones, short of the last colour the depth draws of a ladder that draws more than two and never fewer than two, wherever the role has that many drawn distinct, and every colour the role draws where it has fewer (under textual-ansi at ansi, the tones the depth draws distinct and no more); the adjacency test holds van der Corput and golden angle over the windows each depth produces.
- Policy 4: under every variation, dial position, bundled theme and depth, for every row length to 16, two cells side by side draw as two colours wherever either has a rung of its own ladder drawn as neither of its neighbours, a cell the rule moves draws apart from the depth-0 pressed shade wherever its ladder has a rung drawn as neither of its neighbours nor that shade, and the closing sweep holds under every shipped variation. An authored row with a menu trigger standing at a turn, open, under `alt` and under a keystone tuning, draws the trigger apart from both its neighbours at 256 colours and ansi, except where the sweep's press exemption holds.

## Order of work

Two lanes, built in parallel. cc-candybar publishes a 1.x on every merge, and a release with the floors gone before the lift is bumped in would draw more dividers than today, so the policy lane's first merge waits for step 3.

rich-js lane:
1. The lift, the divider deleted, tests and docs. Release 0.25.0.
2. Join cells re-derived from effected edges. Release 0.25.1.
3. cc-candybar: bump the dependency, land the reversed tests and snapshots, and in the same PR `plainWith` and the glyph probe in `src/render/strip.ts`, `test/helpers/powerline.ts` and `test/doctor-nerd-font.test.ts`, which read the field 0.25.0 removes, plus the two doc lines. Waits on 1.

policy lane, cc-candybar:
4. Delete the floor apparatus; the activated state and the plane select named shades; the named-colour test covers every background the bar draws. Merges after 3.
5. Group leaves and the door's frame-rate cell take row positions.
6. Adjacent positions never select one tone; the `muted` position gains a second tone.
7. A window is the rungs the depth draws distinct, and the epic's closing sweep lands.

cc-candybar stays 1.x throughout; each PR is a `fix`. The wire contract is untouched.

## Not verified

- The truecolor and 256 columns of the lift table were measured by walking the ray in steps of 0.001 in OKLCH lightness through rich-js's public arithmetic before the function existed; the ansi column is what the implementation produces.
- The ansi column names slots by the VGA palette rich-js assumes; a user's terminal theme decides what those slots look like.
- How the activated state and the `surface` plane look under each bundled theme, nested menus included, was not rendered. Step 4 renders them before it lands.

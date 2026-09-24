# Colour from Theme Vocabulary

**Status: ACTIVE.** Epic: `candybar-render-ai7`. Evidence: `design-docs/colour-demo.html`.

Tracking tickets: the epic `candybar-render-ai7` and its children. The tickets are deliberately short and link here; this document is the only home for the reasoning.

**Supersedes the hueStep thread.** `STATUSLINE-THEMING.md` is itself marked SUPERSEDED — its three-layer model was absorbed into `PROPOSAL-segment-dsl.md` — but it is where per-segment hue rotation was first proposed, as `brandon-segment-dsl-segment-render-wd5.4` ("`hueStep` threading through palette resolution"). That thread shipped as `hue.step` and is what this document ends. The rest of `STATUSLINE-THEMING.md` stays superseded by the DSL proposal, unchanged.

## The rule

> A row of the bar wears one of the theme's branding hues — `primary`, then `secondary` — and each cell of the row one of three tones of that hue: a lightness between the theme's `surface` receded toward `background` and its `surface` pulled toward the hue, carrying the hue's own angle and `DECOR_CHROMA_SHARE` (0.8) of its chroma. The row is the innermost of the rows the cell's address stacks through; the tone is its place in that row, and anything nested inside a cell wears the cell's colour. `accent` is kept for what is open.

The roles are Textual's, and the themes are Textual themes: *primary* is the branding colour, *secondary* an alternative "to differentiate from primary", *accent* is "used sparingly to draw attention", *surface* the default widget background. (Until brandon-theme-picker-bgw.8fp this was one sRGB `mix(base, hue, amount)` over all three hues, chosen per cell; see Decisions.)

It **selects** from the theme; it never **synthesizes** a new colour. Everything below is why that sentence is the whole design, and what had to be measured before it could be written.

## What `hue.step` did

`hue.step` was a global pre-order counter over segment leaves. Leaf *i* gets `hueShift = i * 14` degrees, applied to the whole theme palette through `transposePalette`. A segment's colour is therefore a function of **how many leaves precede it anywhere in the tree** — not of what it is, not of where it sits, not of what it belongs to.

Solving the live bar's emitted RGB back to hue indices shows what that buys. Visible segments sit at indices 2, 5, 8, 11 (row 1) and 22, 25, 28, 31, 34, 37 (row 2). Nothing visible is at index 0. Adjacent visible segments are exactly 3 apart, because gated-off edit-mode chrome (the `+`/`-` affordances) is interleaved between every pair and the cursor advances over hidden leaves by design. Verification deltas were 1–7 out of 255, which is screenshot sampling noise.

Roughly two-thirds of the bar's hue budget is spent on segments that never render. `model` is teal because 22 invisible things precede it.

It also laps. At step 14 the hue circle closes every ~25.7 leaves; the bar has ~38. Segment 5 and segment 31 receive the same hue, so "distance along the walk" stops meaning "difference in colour" a third of the way in.

## Why hue rotation was abandoned entirely

Two measured facts killed it, and neither is fixable by tuning the step.

**Rotation cannot manufacture saturation a role lacks.** atom-one-dark `surface` is rgb(59,65,77). Every rotation of a near-grey is another near-grey: hue-only across 7 segments moved #3B414D to #4A3E34 and stayed grey throughout. Adding chroma scaling gets colour (×2.5 gives #325E5E..#5A3A21; ×5 more saturated still) but that is no longer rotation, it is inventing a palette the theme does not have.

**Spanning the full hue circle destroys theme identity, because theme identity lives in hue.** With enough rotation to be visible, every theme collapsed to the same bar at a different lightness. dracula stopped looking like dracula. This was the decisive failure: the mechanism's own success condition is indistinguishable from erasing the thing it is decorating.

Narrowing the span does not rescue it, and costs on both axes. Measuring minimum adjacent separation against minimum separation between *any* pair, over 10 cells:

| placement | min adjacent | min any pair |
|---|---|---|
| today (14°/leaf, 42° between visible neighbours, unbounded) | 42 | 18 (it laps) |
| bounded 85° span | 21 | 5.3 |
| van der Corput, full circle | 68 | 22.5 |
| true subdivision, full circle, rows on disjoint arcs | 45 | 22.5 |

Bounding the span is worse on *both* measures than the thing it was meant to improve. And subdivision degrades more gracefully than stepping as the bar grows. Minimum separation between *any* pair, subdivision vs today: 7 cells 45.0 vs 42.0, 10 cells 22.5 vs 18.0, 20 cells 11.3 vs 6.0, 26 cells 11.3 vs 6.0. Bit reversal's closest pair is 360°/2^⌈log₂ n⌉ apart, so it halves only when the count crosses a power of two; stepping's closest pair is whichever 42°·d, for d < n, lands nearest a full turn, which is 6° as soon as d = 17 is in range.

The general lesson, which the rest of the design is built on: cohesion has to come from the axes that do **not** vary — lightness and chroma held constant — not from narrowing the axis that carries the variety.

## The theme already has a vocabulary

A Textual theme carries 151 entries: about 11 root hues, each with `darken-1..3` / `lighten-1..3` ramps, plus `-background` variants. Three roots are non-semantic and therefore free for decoration: `primary`, `secondary`, `accent`.

Tinting the theme's own neutral surface toward its own hues produces per-theme sets that are unmistakably that theme's:

| theme | three decorative tints |
|---|---|
| dracula | `#45405d` purple, `#353a4e` blue, `#513c54` pink |
| gruvbox | `#494c48` sage, `#4f4a44` tan, `#5e5035` gold |
| nord | `#495969` ice, `#485366` steel, `#515062` mauve |
| catppuccin-latte | `#d5c9ef` lavender, `#e4d8da` warm, `#ead1c6` peach |

This needs no light/dark branch. The base carries the lightness, so a light theme tints correctly under the identical expression — catppuccin-latte's row above comes out of the same `mix` as dracula's.

Picking raw palette entries instead of tinting does not work. `primary-background` is `#5a566c` on dracula — a purple surface, exactly right — and `#8839ef` on catppuccin-latte, a saturated purple at luminance 87 on a theme whose surface sits at luminance 233. The entry names a role, not a lightness, so only the mix can hold the lightness constant across themes.

## The region model

Confusion got solved three separate times by the same move: give each concern its **own region** rather than nudging things apart inside one shared region.

| region | occupant | boundary |
|---|---|---|
| tint (lightness pull `<= TONE_TINT`, 0.35) | ordinary bar segments | decoration never moves `surface`'s lightness more than 0.35 toward its hue |
| state | an open disclosure's trigger | `accent` on the bar; enforced ≥ 2.2 contrast above every tint |
| state, plane 1 | that trigger's band | trigger's hue, recessed toward `background` |
| state, plane 2..N | nested submenus | next hue in the vocabulary, recessed further |
| absent | error / success / warning | not in the decorative vocabulary at all |

The last row is the strongest guarantee in the design. Decoration cannot collide with meaning because meaning is **not in the set**. That is strictly stronger than the hue-anchoring it replaces, which only stopped semantic colours from moving while leaving decorative colours free to arrive at them.

The state boundary had to be enforced rather than assumed, because "the pure hue is vivid" is false for some themes. textual-dark's `secondary` is `#004578`, a navy already darker than most surfaces; its pure form sat on top of the decorative tints at contrast 1.42, indistinguishable. textual-ansi's `primary` was worse, at 1.14. The state colour starts as the rule's own form near the top of its range, `mix(surface, hue, 0.92)`, and the fix is to push it toward `foreground` — as far as `foreground` itself — until contrast against the most-tinted cell of that same hue, on every base, reaches 2.2. Measured global minimum across 23 themes × 3 hues × 3 bases afterwards: 2.21, up from 1.14; solarized-dark's `secondary` is the one that needs the full push. Themes that were already vivid stop at step zero and are byte-unchanged. A theme whose hue cannot clear the floor even at `foreground` is a failure the demo throws on, never a quieter colour.

### Three disclosure rules

**A band is a plane.** Its items are distributed around their trigger's state colour, pulled toward `background`.

**Depth advances the hue.** Every bar trigger opens in `accent`. A nested disclosure takes the *next* vocabulary hue (`accent` → `primary` → `secondary`) and recedes one step further (`0.42 + 0.14 * depth`, capped at 0.75). Two cues move together across every depth the bar reaches: the bundled ☰ → ⚙ → picker is depth 2, and adjacent planes at depths 0→1 and 1→2 stay at least .035 ΔE apart on every theme × hue. Depth 3 is the limit. The cap leaves only .05 of recession between depths 2 and 3 while the hue has wrapped onto one already used, and 20 of the 69 theme × hue lineages fall to .016–.034 — 4 of them (.021–.031: atom-one-dark, catppuccin-latte, nord, solarized-dark) among the 23 accent-rooted lineages the bar can actually reach, since every bar trigger opens `accent`. A trigger still stands off its plane there; adjacent planes do not, and nothing shipped reaches depth 3. `test/decor.test.ts` pins the covered depths and records the limit.

**A trigger is drawn from what it opens, not from where it sits.** It takes the peak of its children's region. Without this, a submenu's parent is coloured as one of its siblings and nothing connects it to the thing it opened. In code a node's position is a `Region` (`src/themes/decor.ts`): on the bar, an address into the vocabulary; on a band, the `Disclosure` its trigger was dealt plus the steps since the body's root — so a body needs nothing of its trigger's position, only what the trigger opened, which is why the body hangs on the trigger node rather than beside it.

### One distribution field, at every level

Placement inside a region is a single per-instance field: the instance's **distribution**. A bar row is an instance and a menu band is an instance, and both use that one field — a menu is itself an instance, so its band's placement is just that instance's distribution. The demo exposes it as two dropdowns — `distribution` for the bar, `menu distribution` for the bands — over one table: both levels read the same `f(i, n)`, the band only scaling it into its plane-to-state window. There is one mechanism here, not two.

Five distributions ship — van der Corput (the default), golden angle, monotonic, ends-interleaved, and `uniform`, the constant where every item is identical. This is one type with five instances, not five code paths: the distribution is a value the instance carries, so adding a fifth is data, not structure.

Measured across 6 items, a monotonic ramp spreads lightness by 40 (dracula) / 50 (latte), and reads as a directional wedge — an ordering the items may or may not have. That was measured over the old 18-entry vocabulary; on the bar a row's cells now choose among three tones, read round a circle, so a monotonic row steps through them in order and wraps: four cells land deep, mid, tinted, deep, and past three cells some neighbours share a tone.

**Isolation is a property of the chosen distribution, not of the system.** `vdc(i)` is bit reversal (0, .5, .25, .75, .125, …) and never reads `n`, the sibling count; golden angle doesn't either. Under those two, adding, removing or hiding a sibling moves nobody — verified by adding 25 menu entries and watching zero bar cells change. `monotonic` = `(i+0.5)/n` and `ends-interleaved` both read `n`, so choosing either forfeits isolation for that instance: one new sibling re-spaces every existing one in it.

Neither half is wrong, and the author picks knowingly. A menu's option domain is a *closed* set — the count is the set itself, not an accident of authoring — so an ordered distribution is legitimate there, and its directional ramp may be exactly what the ordering deserves. An open, hand-authored bar row is where isolation matters, and it is why van der Corput is the default: it is `n`-free, and unlike golden angle its recursive bisection mirrors the tree it orders. Isolation is also precisely what `hue.step` never had — under it a hidden leaf anywhere upstream re-colours everything after it, whatever the author intended.

Directional cues need no light/dark branch either. Mixing toward `foreground` (active) and toward `background` (recessed plane) inverts automatically: measured open-vs-closed is +43 on dracula, +37 on nord, −41 on catppuccin-latte, −47 on textual-light; band-vs-open is −56, −56, +60, +66.

## Rejected alternatives

Each of these was considered and measured. They are recorded with their reasons so they are not re-proposed.

**Per-segment authored `bg:` colour math** (`{{ shiftHue (color "surface") 14 }}`). This is what CLAUDE.md currently recommends as the replacement direction, and it is wrong: it is hand-curation of every segment, which is explicitly ruled out.

**Bounded hue span (85°) for cohesion.** Measured 21 / 5.3 against the full circle's 45 / 22.5. Bounding costs both local contrast and global uniqueness.

**Full-circle hue rotation.** Destroys theme identity, because theme identity lives in hue.

**Emphasis by degree for the open state** (make it *more* tinted). Fails for the same reason hue rotation did: the decorative vocabulary already spans a wide band of tints, so "more tinted" lands inside the space other cells occupy. Hence disjoint regions rather than a stronger nudge.

**Making rich-js `ThemeKey` a vector space / Lie group so hue offsets compose.** Moot — there are no hue offsets any more. Do not build it. The design needs `getThemePalette`, `p.get(role)`, a colour mix, and a contrast ratio, all of which rich-js already has.

**A `theme.dark` branch for directional cues.** Unnecessary: mixing toward `foreground` / `background` inverts on its own.

## Decisions

**Scope is backgrounds only.** `fg:` specs and `GIT_QUIET_FG` are authorial de-emphasis, not decoration, and stay as they are. One exception: text on a state cell is contrast-chosen, because a fixed foreground measurably fails on pure hues — AA on dark themes, AA-large on light, with solarized-light the floor at 3.13:1.

**Text nobody authored is chosen on every cell, not only state cells** (brandon-theme-picker-bgw.b2g; this supersedes the text half of the decision above — state cells included, so solarized-light's 3.13:1 is gone). Bar cells used to keep the terminal's own text, on the premise that it reads on whatever the theme paints behind it. A contrast audit of every bundled theme under a dark and a light terminal measured that premise false in every theme for one polarity or the other: 1.05:1 for the dark themes under a light terminal, and the same for the light themes under a dark one. The bar paints its own background, so its text must come from the same place. An unauthored `fg:` is now `textOn` of the background the cell resolves to, in every region. `textOn` floors its pick at `TEXT_MIN_CONTRAST`, WCAG AA's 4.5:1 for normal text, because on a mid-luminance tint neither pole clears (atom-one-dark's foreground measured 2.49:1). The pole taken is the one on the side rich-js `contrastFor` names, and a slide deepens it that way: the pole that merely measures better can sit on the far side of the background (39 of the registry's 828 tints and band colours), and sliding it would carry its hue through the background into the other polarity. 3:1 was tried first; it passed the audit but looked washed out on the saturated threshold colours, and a statusline is small text. Authored semantic text in the bundled segments (git accents, the cache timer) goes through `readableOn` at the same floor, which moves lightness only and so keeps the hue that carries the meaning. Quiet git structure keeps its own 3:1: it is meant to recede. `pnpm gallery` renders every theme with one payload for looking at this again.

**A tint carries its theme's chroma, not its surface's** (brandon-theme-picker-bgw.8fp). One `mix(base, hue, amount)` with `amount ≤ 0.30` made every tint 70–84% surface. Measured with `pnpm gallery` and ΔE_OK: the bar wore 19–57% of each theme's accent chroma, and two distinct themes' bars sat as close as ΔE .018 cell by cell (dracula and rose-pine-moon), under what the eye resolves. Raising the amount moved lightness toward the hue too, onto the state region, and broke 13 of the floors below. Three changes fixed it, and every floor in `test/decor.test.ts` held unchanged on the bundled themes. Under a look they did not all hold: `dim` pulls atom-one-dark's foreground itself to 2.19 against its primary tints, so the state search, which stopped at `foreground`, threw (three solarized-dark look combinations already did before this change). The search now continues past `foreground` along its own lightness (rich-js `ensureContrast`, folded over the hue's tints), and the floor is pinned over every theme × bundled look:

- **Chroma is decoupled from lightness.** A tint is `base.mixAxes(hue, { l: amount, c: 0.8, h: 1, alpha: 0 })` (rich-js `Oklch.mixAxes`). Every floor here is a contrast ratio, and lightness decides contrast, so the floors see what they saw before while the tint carries 0.8 of the hue's chroma, or all the sRGB gamut holds at that lightness on pale light-theme surfaces. The minimum cell-wise distance between two themes rose from .018 to .029, between rose-pine and rose-pine-moon, two variants of one family.
- **Hue was made the vocabulary's fastest axis** so neighbours would differ in hue. It measured well and looked wrong; the next decision replaces it.
- **A threshold's calm arm is the tint.** `{{ tint }}` returns the decoration the segment's region dealt it, available in `bg:` itself, and the bundled cascades end their calm arm on `(tint)`. A calm cell states nothing, so it wears decoration. The fixed `panel` it replaces painted the calm block and weekly as one slab.

**A row is one hue; its cells differ by tone** (brandon-theme-picker-bgw.8fp, second pass). Hue at every cell alternated two saturated hues seam by seam, and Brandon rejected it on sight: "you end up with this 'sports team' sort of look … like im either a college or an NFL team." Decoration now follows the Textual roles the themes were written with:

- **The bar hues are `primary` and `secondary`, one per row.** A row is the innermost of the rows an address stacks through before it reaches a cell, so a row stacked above the whole bar (edit mode's reset banner) recolours no row beneath it, a `{ v }` nested inside a cell stacks no bar rows, and a bar with no vertical container is one row in `primary`. The row's hue is the half its placement falls in: van der Corput's first bit, so rows alternate however many the bar stacks. They alternate among siblings, not rendered lines: a row that is itself a stack of rows restarts the alternation, so its last line can share a hue with the next row. Counting lines would make a colour depend on the shape of the rows around it, the pre-order cursor's flaw; the bundled bar nests no stack inside a row. Rounding to the nearer of the two hues (the tone's rule) ties at every odd quarter, and gave a three-row bar `primary, secondary, secondary`. The compiler proves `accent` is not a bar hue.
- **A cell's tone is its place in its row.** Three tones, because a row's neighbours are placed by van der Corput: its first eight cells land on tones 0, 1, ½, 1, 0, 1, ½, 0, so no two side by side share one and neighbours sit at least half the axis apart. A continuous axis gives neighbours a quarter of it (cells 1 and 2 sit at ½ and ¼), and measured under the seam floor in 42 of 46 theme × hue rows. Anything nested inside a cell wears the cell's hue and tone, and the loader refuses a `distribution` authored there, where it could place nothing. The tone rounds to the nearest of three points; taking the third a placement falls in (the hue's rule) would put cells 5 and 6 of a row — inside the bundled status row — on one tone.
- **Edit chrome is part of its cell.** The `+`/`-` affordances were spliced as siblings, so they took two of every three positions in a row and visible neighbours were never consecutive: the calm context and cache timer landed on one tone. Each content cell and its chrome is now one horizontal unit, and the row places content only; a content segment that is a whole row becomes the one cell of that row, so its chrome shares its colour there too.
- **The tone axis** runs from `surface` receded 0.5 toward `background` to `surface` pulled 0.35 toward the hue. Receding the deep end all the way to `background` sank the deepest cells into a terminal painted in the theme's own background. The tinted end is the largest pull tried (0.45, 0.4, 0.35) that the state floor allows: at 0.4 solarized-dark's dim foreground no longer clears 2.2 against its most-tinted cell, and its three open states collapsed onto one colour past the pole.
- **The open state is `accent`**, floored at 2.2 against every tint the bar can wear rather than against its own hue's, because an open trigger stands in either row at any tone. 41 of the 69 theme × hue states clear at step zero and are the pure mix.

Measured with the calm and hot bundled bar under every theme: neighbouring tones of one hue sit ΔE .040 apart or more on every theme but textual-ansi (median .068); the closest two themes' bars are rose-pine and rose-pine-moon at .029, unchanged. textual-ansi's hues sit at its surface's lightness, so its tones fold (.018), and there the joiner draws the powerline divider (U+E0B1, in the left cell's text colour) wherever two backgrounds sit within ΔE .04 (rich-js `SEAM_MIN_DELTA_E`). `test/theme-identity.test.ts` pins the chroma share, the theme-to-theme floor (.025), every arrow seam at or above .04, and dividers only in themes whose own tones fold.

**Truecolor is the target.** `colorCompatibility` is an explicit setting and the daemon cannot detect client depth — which is why `"auto"` is deliberately unrepresentable. At 256 and ansi the vocabulary degrades toward flat, which is the floor the design already guarantees.

**`hue.step` and its stepper knob were removed with no successor** (ai7.4). Nothing real was bound to it: the maintainer's live config declared only `applyTheme`, and the `hueUp`/`hueDown` pair existed solely as an illustration in CLAUDE.md, which went with it.

**The distribution is authorable per instance, defaulting to van der Corput.** All five values ship: van der Corput, golden angle, monotonic, ends-interleaved, uniform. This is one type with five instances, not five code paths — the distribution is a value the instance carries, so adding one is data, not structure. The cost of choosing an `n`-reading value is isolation, and it is the author's to spend; see "One distribution field, at every level". Shipped (candybar-render-ai7.8) as one config key, `distribution`, on the two kinds of placer a config can spell: any container node (`{ h: [...], distribution: "monotonic" }`, `{ v: … }`, `kind: "container"`, and `kind: "group"`, where it places the body) and a `{{ menu }}`'s options dict (`(dict "distribution" "monotonic")`); the names are `van-der-corput`, `golden-angle`, `ends-interleaved`, `monotonic`, `uniform`. Each address step carries the distribution its parent places by, so a tree mixing several is several values folded by one rule.

## What was deleted

- `HUE_STEP_VAR` and the `hue.step` variable (ai7.4).
- `nextHueShift` and the hue cursor in the render walk (ai7.4).
- The advance-before-the-visibility-gate contract and its three separate explanations in `render.ts`, `settings-menu.ts` and `edit-chrome.ts` (ai7.4).
- `focusTint` (ai7.3).
- Decorative role-picking in the bundled default — segments naming `panel` or `surface-active` purely so they look different from a neighbour (ai7.5).

The change was expected to be net-subtractive, with the design counted wrong if it wasn't. It was not net-subtractive: the five PRs added 817 lines to `src/` and removed 324. What went was a counter; what arrived carries the state floor and the band model, neither of which the counter had, and both of which the measurements above demanded. The design stands on those measurements, not on the line count.

**CLAUDE.md's claim that "`hue.step` is not load-bearing" was wrong twice over.** It *was* load-bearing: `edit-chrome.ts` and `settings-menu.ts` both carried pre-order arithmetic in their comments for no purpose other than reasoning about the hue cursor. And the replacement direction it stated — authoring `bg: '{{ shiftHue (color "surface") 14 }}'` per segment — was exactly the hand-curation this design rules out. Both sentences went with the mechanism.

## The demo

`design-docs/colour-demo.html` predates brandon-theme-picker-bgw.8fp and renders the superseded per-cell vocabulary (every hue × three bases); it is kept as the evidence the ai7 rule was chosen with, rendering all 23 themes through the real rich-js palettes under that superseded rule, and the ai7-era separations, contrasts and spreads quoted here were measured with it. The 8fp measurements in "A row is one hue; its cells differ by tone" come from the bundled bar rendered through `renderDsl`, which `test/theme-identity.test.ts` re-measures on every run.

Its rich-js browser bundle is gitignored. Regenerate it from the repo root with:

```
echo "export { listThemePalettes, getThemePalette } from '@promptctl/rich-js';" | pnpm dlx esbuild --bundle --format=iife --global-name=RJ --outfile=design-docs/colour-demo-richjs.js
```

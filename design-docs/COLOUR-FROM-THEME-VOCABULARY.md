# Colour from Theme Vocabulary

**Status: ACTIVE.** Epic: `candybar-render-ai7`. Evidence: `design-docs/colour-demo.html`.

Tracking tickets: the epic `candybar-render-ai7` and its children. The tickets are deliberately short and link here; this document is the only home for the reasoning.

**Supersedes the hueStep thread.** `STATUSLINE-THEMING.md` is itself marked SUPERSEDED — its three-layer model was absorbed into `PROPOSAL-segment-dsl.md` — but it is where per-segment hue rotation was first proposed, as `brandon-segment-dsl-segment-render-wd5.4` ("`hueStep` threading through palette resolution"). That thread shipped as `hue.step` and is what this document ends. The rest of `STATUSLINE-THEMING.md` stays superseded by the DSL proposal, unchanged.

## The rule

> A segment's decorative background is `mix(base, themeHue, amount)` — both operands colours the theme already contains — with the entry chosen by the node's address in the layout tree.

It **selects** from the theme; it never **synthesizes** a new colour. Everything below is why that sentence is the whole design, and what had to be measured before it could be written.

## What `hue.step` actually does

`hue.step` is a global pre-order counter over segment leaves. Leaf *i* gets `hueShift = i * 14` degrees, applied to the whole theme palette through `transposePalette`. A segment's colour is therefore a function of **how many leaves precede it anywhere in the tree** — not of what it is, not of where it sits, not of what it belongs to.

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
| tint (`mix <= 0.30`) | ordinary bar segments | decoration never exceeds 0.30 |
| state | an open disclosure's trigger | enforced ≥ 2.2 contrast above tint |
| state, plane 1 | that trigger's band | trigger's hue, recessed toward `background` |
| state, plane 2..N | nested submenus | next hue in the vocabulary, recessed further |
| absent | error / success / warning | not in the decorative vocabulary at all |

The last row is the strongest guarantee in the design. Decoration cannot collide with meaning because meaning is **not in the set**. That is strictly stronger than the hue-anchoring it replaces, which only stopped semantic colours from moving while leaving decorative colours free to arrive at them.

The state boundary had to be enforced rather than assumed, because "the pure hue is vivid" is false for some themes. textual-dark's `secondary` is `#004578`, a navy already darker than most surfaces; its pure form sat on top of the decorative tints at contrast 1.42, indistinguishable. textual-ansi's `primary` was worse, at 1.14. The state colour starts as the rule's own form near the top of its range, `mix(surface, hue, 0.92)`, and the fix is to push it toward `foreground` — as far as `foreground` itself — until contrast against the most-tinted cell of that same hue, on every base, reaches 2.2. Measured global minimum across 23 themes × 3 hues × 3 bases afterwards: 2.21, up from 1.14; solarized-dark's `secondary` is the one that needs the full push. Themes that were already vivid stop at step zero and are byte-unchanged. A theme whose hue cannot clear the floor even at `foreground` is a failure the demo throws on, never a quieter colour.

### Three disclosure rules

**A band is a plane.** Its items are distributed around their trigger's state colour, pulled toward `background`.

**Depth advances the hue.** A nested disclosure takes the *next* vocabulary hue and recedes one step further (`0.42 + 0.14 * depth`, capped at 0.75). Two cues move together, which is what makes the hue wrap at depth 3 safe — the recession still separates what the hue no longer does.

**A trigger is drawn from what it opens, not from where it sits.** It takes the peak of its children's region. Without this, a submenu's parent is coloured as one of its siblings and nothing connects it to the thing it opened.

### One distribution field, at every level

Placement inside a region is a single per-instance field: the instance's **distribution**. A bar row is an instance and a menu band is an instance, and both use that one field — a menu is itself an instance, so its band's placement is just that instance's distribution. The demo exposes it as two dropdowns — `distribution` for the bar, `menu distribution` for the bands — over one table: both levels read the same `f(i, n)`, the band only scaling it into its plane-to-state window. There is one mechanism here, not two.

Five distributions ship — van der Corput (the default), golden angle, monotonic, ends-interleaved, and `uniform`, the constant where every item is identical. This is one type with five instances, not five code paths: the distribution is a value the instance carries, so adding a fifth is data, not structure.

Measured across 6 items, a monotonic ramp spreads lightness by 40 (dracula) / 50 (latte), and reads as a directional wedge — an ordering the items may or may not have.

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

**Truecolor is the target.** `colorCompatibility` is an explicit setting and the daemon cannot detect client depth — which is why `"auto"` is deliberately unrepresentable. At 256 and ansi the vocabulary degrades toward flat, which is the floor the design already guarantees.

**`hue.step` and its stepper knob are removed with no successor.** Nothing real was bound to it: the maintainer's live config declares only `applyTheme`, and the `hueUp`/`hueDown` pair exists solely as an illustration in CLAUDE.md.

**The distribution is authorable per instance, defaulting to van der Corput.** All five values ship: van der Corput, golden angle, monotonic, ends-interleaved, uniform. This is one type with five instances, not five code paths — the distribution is a value the instance carries, so adding one is data, not structure. The cost of choosing an `n`-reading value is isolation, and it is the author's to spend; see "One distribution field, at every level".

## What gets deleted

- `HUE_STEP_VAR` (`src/config/dsl-types.ts`).
- `nextHueShift` and the hue cursor (`src/dsl/render.ts:697-707`).
- The advance-before-the-visibility-gate contract (`src/dsl/node-registry.ts:262`) and its three separate explanations in `render.ts`, `settings-menu.ts` and `edit-chrome.ts`.
- `focusTint` (`src/dsl/render.ts:545-559`).
- Decorative role-picking in the bundled default — segments naming `panel` or `surface-active` purely so they look different from a neighbour.

The change is expected to be net-subtractive. If it isn't, the design is wrong.

**CLAUDE.md's claim that "`hue.step` is not load-bearing" is wrong twice over.** It *is* load-bearing: `edit-chrome.ts` and `settings-menu.ts` both carry pre-order arithmetic in their comments for no purpose other than reasoning about the hue cursor. And the replacement direction it states — authoring `bg: '{{ shiftHue (color "surface") 14 }}'` per segment — is exactly the hand-curation this design rules out. Both sentences go with the mechanism.

## The demo

`design-docs/colour-demo.html` renders all 23 themes through the real rich-js palettes under the rule above; the separations, contrasts and spreads quoted here were measured with it while the rule was being chosen.

Its rich-js browser bundle is gitignored. Regenerate it from the repo root with:

```
echo "export { listThemePalettes, getThemePalette } from '@promptctl/rich-js';" | pnpm dlx esbuild --bundle --format=iife --global-name=RJ --outfile=design-docs/colour-demo-richjs.js
```

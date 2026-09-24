// The colour function: a node's ADDRESS in the layout tree selects one entry
// of the theme's own decorative vocabulary. Rationale, measurements and the
// rejected alternatives: design-docs/COLOUR-FROM-THEME-VOCABULARY.md.
//
// The rule, in Textual's colour roles: a row of the bar wears the theme's
// `primary` or `secondary`, and each cell of the row one TONE of that hue —
// a depth between the theme's `surface` receded toward its `background` and
// its `surface` pulled toward the hue — with the row and the tone chosen by
// the node's position in the tree. `accent` is kept for what is open. Every coordinate is one the theme
// already contains or lies between two it contains: it SELECTS from the theme;
// it never synthesises saturation the theme lacks.
//
// [LAW:effects-at-boundaries] Pure. No renderer wiring, no I/O, no traversal
// state: any node's colour is computable from its address alone, without
// visiting any other node. [LAW:one-way-deps] A leaf of the themes module — it
// imports only rich-js, which owns every colour operation used (`mixAxes`,
// `blendRgb`, `ensureContrast`, `ensureDrawn`, `contrastFor`, `contrastRatio`,
// `Oklch.deltaE`); cc-candybar keeps the POLICY (which roles, which tones, which address
// formula) and no colour arithmetic of its own.

import {
  blendRgb,
  ColorDepth,
  Oklch,
  contrastFor,
  contrastRatio,
  ensureContrast,
  ensureDrawn,
  drawnColour,
  type ColorRgba,
  type Palette,
} from "@promptctl/rich-js";

// --- The vocabulary -----------------------------------------------------------

/**
 * The three non-semantic root hues, in the order a disclosure lineage advances
 * through them (`hueAtDepth`). `error`/`success`/`warning` are deliberately NOT
 * here: decoration cannot collide with meaning because meaning is not in the
 * set — strictly stronger than hue-anchoring, which only stopped the semantic
 * colours from moving while leaving decoration free to arrive at them.
 */
export const DECOR_HUES = ["primary", "secondary", "accent"] as const;
export type DecorHue = (typeof DECOR_HUES)[number];

/**
 * The hues the closed bar wears, one per ROW, in the roles Textual gives them:
 * `primary` is the theme's branding colour and `secondary` its alternative,
 * "to differentiate from primary" — so a second row reads as a different part
 * of the bar, while the cells inside one row share a hue and differ by tone.
 * Hue changing at every cell reads as team colours, not as the theme
 * (brandon-theme-picker-bgw.8fp); a row is the coarsest level a bar has.
 */
export const BAR_HUES = [
  "primary",
  "secondary",
] as const satisfies readonly DecorHue[];
export type BarHue = (typeof BAR_HUES)[number];

/**
 * The hue an open disclosure wears: Textual's `accent`, "used sparingly to
 * draw attention". It appears exactly while something is open, which is when
 * there is something to attend to.
 */
export const OPEN_HUE = "accent" satisfies DecorHue;

/** The roles whose meaning decoration must never borrow. */
export type SemanticRole = "error" | "success" | "warning";

// [LAW:types-are-the-program] Two exclusions, checked by the compiler rather
// than a review: no semantic role is a decorative hue, and the closed bar never
// wears the open hue — so an open trigger cannot be mistaken for a closed cell
// by hue alone. (test/decor.test.ts asserts both at runtime too.)
const _decorHuesAreNonSemantic: Extract<DecorHue, SemanticRole> extends never
  ? true
  : never = true;
const _barNeverWearsTheOpenHue: Extract<BarHue, typeof OPEN_HUE> extends never
  ? true
  : never = true;
void _decorHuesAreNonSemantic;
void _barNeverWearsTheOpenHue;

/**
 * Where a cell sits on its row's tone axis, from the theme's `surface` receded
 * `TONE_RECESS` toward `background` (0) to its `surface` pulled `TONE_TINT`
 * of the way toward the row's hue (1).
 * Three tones, not a continuum: a row's neighbours are placed by its
 * distribution, and van der Corput's first six cells land on 0, 1, ½, 1, 0, 1
 * of three tones — never one tone twice in a row, and never less than half
 * the axis apart. A continuous axis gives neighbours a quarter of it (cells
 * 1 and 2 sit at ½ and ¼), which measured under the seam floor in 42 of 46
 * theme × hue rows.
 */
export const DECOR_TONES = [0, 0.5, 1] as const;
export type DecorTone = (typeof DECOR_TONES)[number];

/**
 * How far the tinted end of the tone axis moves `surface`'s LIGHTNESS toward
 * the row's hue. With `TONE_RECESS` it sets the width of the bar's tonal range
 * — and every floor the regions are held to (state over tint, text over cell)
 * is a contrast ratio, which lightness decides. It is the largest pull tried
 * (0.45, 0.4, 0.35) that the state floor allows: at 0.4, solarized-dark's dim
 * foreground no longer clears 2.2 against its most-tinted cell, and its three
 * open states collapse onto one colour past the pole.
 */
export const TONE_TINT = 0.35;

/**
 * How far the deep end of the tone axis moves `surface`'s lightness toward
 * `background`: halfway, so the deepest cell stays apart from a terminal
 * painted in the theme's own background.
 */
export const TONE_RECESS = 0.5;

/**
 * How far every tone's CHROMA moves toward the row's hue: most of the way.
 * Chroma is the axis a theme's identity is carried on and the contrast floors
 * barely read, so it is decoupled from lightness rather than dragged along
 * with it. Tied to lightness, the bar wore 19–57% of each theme's accent
 * chroma and distinct themes converged (dracula ~ rose-pine-moon ΔE .006;
 * brandon-theme-picker-bgw.8fp). Below 1, so a tint stays quieter than the
 * hue it is drawn from; the sRGB gamut lowers it further at the lightness
 * ends, which is the most those lightnesses can hold.
 */
export const DECOR_CHROMA_SHARE = 0.8;

/**
 * The theme's two poles. Directional cues are mixes toward them — active
 * toward `foreground`, recessed toward `background` — which is what makes the
 * cues invert on their own between light and dark themes, with no branch.
 */
export type ThemePole = "foreground" | "background";

/** One closed bar cell's decoration: its row's hue, at its own tone. */
export interface DecorEntry {
  readonly hue: BarHue;
  readonly tone: DecorTone;
}

/** Every decoration the closed bar can wear: 2 hues × 3 tones, all the theme's own. */
export const DECOR_VOCABULARY: readonly DecorEntry[] = BAR_HUES.flatMap((hue) =>
  DECOR_TONES.map((tone) => ({ hue, tone })),
);

// --- Distributions ------------------------------------------------------------

/**
 * Where sibling `index` of `count` lands in [0, 1). One field, read at every
 * level of the tree.
 *
 * [LAW:dataflow-not-control-flow] The distribution is a VALUE an instance
 * carries, not a branch: `decorFor` calls whatever it is handed and the five
 * shipped ones are five entries in one table.
 */
export type Distribution = (index: number, count: number) => number;

const PHI = 0.6180339887498949;

/** Bit reversal of `index` as a binary fraction: 0, ½, ¼, ¾, ⅛, … Never reads the count. */
const vanDerCorput: Distribution = (index) => {
  let value = 0;
  let place = 0.5;
  for (let i = index; i > 0; i >>= 1, place /= 2) value += place * (i & 1);
  return value;
};

/**
 * The config spelling of the five shipped distributions, default first — the
 * vocabulary a container's or a `{{ menu }}`'s `distribution` field validates
 * against, and the order a load error lists them in. [LAW:one-source-of-truth]
 * The table below is typed over THIS tuple, so a name without a function, or a
 * function without a name, is a compile error.
 */
export const DISTRIBUTION_NAMES = [
  "van-der-corput",
  "golden-angle",
  "ends-interleaved",
  "monotonic",
  "uniform",
] as const;
export type DistributionName = (typeof DISTRIBUTION_NAMES)[number];

/** [LAW:parse-dont-validate] The narrowing from an authored value to a name. */
export const isDistributionName = (value: unknown): value is DistributionName =>
  typeof value === "string" &&
  (DISTRIBUTION_NAMES as readonly string[]).includes(value);

/**
 * The five shipped distributions. Isolation is a property of the CHOSEN
 * distribution, not of the system: `van-der-corput`, `golden-angle` and
 * `uniform` never read the sibling count, so under them adding, removing or
 * hiding a sibling moves nobody. `monotonic` and `ends-interleaved` read it —
 * legitimate for a CLOSED set (a menu's option domain, where the count is the
 * set) and a trade the author spends knowingly.
 */
export const DISTRIBUTIONS = {
  "van-der-corput": vanDerCorput,
  "golden-angle": (index) => (index * PHI) % 1,
  "ends-interleaved": (index, count) => {
    const slot = index % 2 === 0 ? index / 2 : count - 1 - (index - 1) / 2;
    return (slot + 0.5) / count;
  },
  monotonic: (index, count) => (index + 0.5) / count,
  uniform: () => 0.5,
} as const satisfies Record<DistributionName, Distribution>;

export const DEFAULT_DISTRIBUTION: DistributionName = "van-der-corput";

/**
 * [LAW:single-enforcer] THE resolution of an authored distribution NAME to the
 * function an instance places by — an absent name is the default. Every placer
 * (a compiled container, a `{{ menu }}`'s options, a bare `{{ picker }}`) reads
 * "omitted yields van der Corput" through this one call, so no two of them can
 * default differently.
 */
export const placedBy = (name: DistributionName | undefined): Distribution =>
  DISTRIBUTIONS[name ?? DEFAULT_DISTRIBUTION];

// --- Address -> entry ---------------------------------------------------------

/** Which child, of how many. `0 <= index < count`. */
export interface Position {
  readonly index: number;
  readonly count: number;
}

/**
 * A position placed by its parent's distribution — the one field every placer
 * carries, read here at every level of the tree. A band's items are addressed
 * by these alone. [LAW:dataflow-not-control-flow] A step carries the function
 * it is placed by, so a fold calls whatever each level was handed; a tree
 * mixing five distributions is five values, not five code paths.
 */
export interface PlacedStep extends Position {
  readonly distribution: Distribution;
}

/**
 * What a container's children are to the bar: its ROWS (a vertical container)
 * or the CELLS of one row (a horizontal one). Rows choose the hue and cells
 * the tone, so a hue can only change where the bar itself changes row.
 */
export type Axis = "row" | "cell";

/** One step down the bar's tree: a placed position, and which axis it steps along. */
export interface AddressStep extends PlacedStep {
  readonly axis: Axis;
}

/** The steps from the root to a node. The root's address is empty. */
export type Address = readonly AddressStep[];

/**
 * Each level's contribution to a band item's place decays by this factor, so
 * an item's outermost step decides the coarse position and every step nested
 * under it refines it. The value the evidence demo was validated with; the
 * doc's band separations were measured under it.
 */
export const LEVEL_DECAY = 0.37;

/**
 * Where `address` lands on a band's plane→state axis, in [0, 1): a weighted
 * fold of the per-level positions — each level placed by its own step's
 * distribution, decaying by `LEVEL_DECAY` — taken modulo 1. One step yields
 * exactly that step's placement (`d % 1 === d` for `d` in [0, 1)), so a
 * picker's options, one step each under their trigger, land at their own
 * placement; the empty address (the band's root) lands at 0.
 */
function bandAxis(address: readonly PlacedStep[]): number {
  let value = 0;
  let weight = 1;
  for (const { index, count, distribution } of address) {
    value += distribution(index, count) * weight;
    weight *= LEVEL_DECAY;
  }
  return value % 1;
}

/**
 * How a placement in [0, 1) picks one of `size` entries. Each bar vocabulary
 * is read with the rule under which van der Corput's neighbours never land on
 * the same entry — the two sizes the bar has need different rules, so the rule
 * is a value the vocabulary is read with, not a branch on its size.
 */
export type Quantize = (placement: number, size: number) => number;

/**
 * The equal bin the placement falls in. Over two entries a van der Corput
 * placement's first bit IS its bin, so any number of rows alternates. The
 * nearest-point rule ties there: ¼ and ¾ sit midway between the two points,
 * both round to the second, and rows 1 and 2 of a three-row bar shared a hue.
 */
export const inBin: Quantize = (placement, size) =>
  Math.floor(placement * size);

/**
 * The nearest of `size` points spaced evenly round the circle from 0. Over
 * three tones a row's first eight cells land on 0, 1, ½, 1, 0, 1, ½, 0: no two
 * neighbours alike, never less than half the axis apart. The bin rule puts
 * cells 5 and 6 on one tone, inside the bundled status row.
 */
export const nearestPoint: Quantize = (placement, size) =>
  Math.round(placement * size) % size;

/**
 * The entry of `vocabulary` that `step` selects under `quantize`. An absent
 * step is a node alone on that axis — a bar with no vertical container, a
 * one-cell row — and is placed where a first child is, at 0. Generic over the
 * entry type so the selection is testable over any vocabulary — a one-entry
 * one must yield that entry everywhere.
 *
 * [LAW:no-silent-failure] Both quantizers land in `[0, size)` for a placement
 * in `[0, 1)` and `T` is non-nullable, so an undefined read here is exactly an
 * empty vocabulary — nothing to select — and throws rather than returning it.
 */
export function vocabularySelect<T extends {}>(
  vocabulary: readonly T[],
  step: PlacedStep | undefined,
  quantize: Quantize,
): T {
  const placement =
    step === undefined ? 0 : step.distribution(step.index, step.count);
  const entry = vocabulary[quantize(placement, vocabulary.length)];
  if (entry === undefined)
    throw new Error("vocabularySelect: empty vocabulary");
  return entry;
}

/**
 * The decorative entry a bar node's address selects. An address reads as the
 * rows it stacks through, then the cell of the innermost of them, then
 * whatever is nested inside that cell: the last of those rows chooses the hue,
 * so a row stacked above the whole bar (edit mode's reset banner) recolours no
 * row beneath it, and the cell chooses the tone. Anything nested inside a cell
 * — edit mode's `+`/`-` around it, an authored `{ h }` or `{ v }` — wears the
 * cell's hue and tone: a row's cells are what sit side by side, so they are
 * what must differ, and the loader refuses a `distribution` authored inside a
 * cell, where it could place nothing. A bar with no vertical container is one
 * row and wears one hue.
 *
 * Rows alternate among SIBLINGS. A row that is itself a stack of rows restarts
 * the alternation inside it, so its last line can wear the hue of the row
 * after it: which line is next to which is a fact about the rendered bar, and
 * reading it would make a node's colour depend on its neighbours' shapes — the
 * pre-order cursor's flaw, where hiding one segment recoloured others. The
 * bundled bar stacks no rows inside a row.
 */
export function decorEntryFor(address: Address): DecorEntry {
  const cell = address.findIndex((step) => step.axis === "cell");
  const rows = cell === -1 ? address : address.slice(0, cell);
  return {
    hue: vocabularySelect(BAR_HUES, rows.at(-1), inBin),
    tone: vocabularySelect(DECOR_TONES, address[rows.length], nearestPoint),
  };
}

/**
 * [LAW:parse-dont-validate] The one unit that turns a palette role NAME into a
 * proven `ColorRgba`. Every shipped theme carries every role this module names
 * (test/decor.test.ts checks the whole registry), so an absence is registry
 * drift or a hand-built palette missing a role — a loud failure naming both,
 * never a fallback colour. [LAW:no-silent-failure]
 */
export function paletteRole(
  palette: Palette,
  role: "surface" | DecorHue | ThemePole | SemanticRole,
): ColorRgba {
  const colour = palette.get(role);
  if (colour === undefined) {
    throw new Error(
      `palette "${palette.name}" has no "${role}" role; decoration needs it`,
    );
  }
  return colour;
}

/**
 * The colour of one vocabulary entry in `palette`: a point on the row hue's
 * tone axis. The axis runs in OKLCH from the theme's `surface` receded
 * `TONE_RECESS` toward its `background` to its `surface` pulled `TONE_TINT`
 * of the way toward the hue, and both ends carry
 * the hue's own angle and `DECOR_CHROMA_SHARE` of its chroma, so every tone is
 * the same hue at a different depth. [LAW:one-source-of-truth] The one place
 * the rule is spelled — `decorFor` renders through it and `stateFor` measures
 * against it, so the floor is enforced against the very bytes a tint cell will
 * show, not a second transcription of the formula.
 */
export function decorEntryColour(
  palette: Palette,
  entry: DecorEntry,
): ColorRgba {
  let colours = DECOR_MEMO.get(palette);
  if (colours === undefined) {
    colours = new Map();
    DECOR_MEMO.set(palette, colours);
  }
  const key = `${entry.hue}|${entry.tone}`;
  const hit = colours.get(key);
  if (hit !== undefined) return hit;
  const hue = Oklch.fromRgba(paletteRole(palette, entry.hue));
  const surface = Oklch.fromRgba(paletteRole(palette, "surface"));
  const carry = (from: Oklch, l: number): Oklch =>
    from.mixAxes(hue, { l, c: DECOR_CHROMA_SHARE, h: 1, alpha: 0 });
  const deep = surface.mixAxes(
    Oklch.fromRgba(paletteRole(palette, "background")),
    { l: TONE_RECESS, c: 0, h: 0, alpha: 0 },
  );
  const colour = carry(deep, 0)
    .mixAxes(carry(surface, TONE_TINT), {
      l: entry.tone,
      c: entry.tone,
      h: entry.tone,
      alpha: 0,
    })
    .toRgba();
  colours.set(key, colour);
  return colour;
}

// Every segment of every render asks for its tint, and the answer is a pure
// function of (palette, entry) — OKLCH conversions, four mixes, and a possible
// gamut bisection, ~5% of a render before this memo. Keyed by the entry's
// VALUE, whose domain is BAR_HUES × DECOR_TONES, so each map holds at most six
// colours whoever built the entry.
const DECOR_MEMO = new WeakMap<Palette, Map<string, ColorRgba>>();

/** A node's decorative background: the colour of the entry its address selects. */
export const decorFor = (palette: Palette, address: Address): ColorRgba =>
  decorEntryColour(palette, decorEntryFor(address));

// --- The state region ---------------------------------------------------------

/**
 * The contrast a state cell must hold above every tint cell of its own hue.
 * Enforced rather than assumed because "the pure hue is vivid" is false for
 * some palettes (textual-dark's `secondary` sat on its tints at 1.42, and
 * textual-ansi's `primary` at 1.14 — see the design doc's region model).
 */
export const STATE_FLOOR = 2.2;

/** The pure form of a hue: the rule's own mix near the top of its range, where the search starts. */
export const STATE_PURE_AMOUNT = 0.92;

/**
 * The search toward `foreground` runs in twelfths and is allowed to reach
 * `foreground` itself (solarized-dark's `secondary` clears only at the pole).
 */
const STATE_STEPS = 12;

/**
 * The state colour of `hue`: an open disclosure's trigger is drawn here. The
 * pure form of the hue, pushed toward `foreground` in twelfths — and past it,
 * along its own lightness, when the pole itself falls short — until it clears
 * `STATE_FLOOR` against EVERY colour the closed bar can wear, since an open
 * trigger stands among closed cells of any row and tone. A hue that already
 * clears at step zero is byte-unchanged — the enforcement is a floor, not a
 * transform.
 *
 * The floor holds on what the terminal draws at `drawnAt`: at 256 colours the
 * trigger and every tint are rounded independently, and a trigger whose
 * rounding lands too near a rounded tint is replaced by the nearest drawn
 * colour that clears the floor against all of them (rich-js `ensureDrawn`).
 *
 * [LAW:dataflow-not-control-flow] Fourteen candidates, one predicate, the
 * first that passes; the values decide, not a branch per theme.
 * [LAW:no-silent-failure] A hue that cannot clear even beyond `foreground`, or
 * whose drawn colour nothing at `drawnAt` repairs, throws naming palette and
 * hue — never a quieter colour.
 */
export function stateFor(
  palette: Palette,
  hue: DecorHue,
  drawnAt: ColorDepth,
): ColorRgba {
  let states = STATE_MEMO.get(palette);
  if (states === undefined) {
    states = new Map();
    STATE_MEMO.set(palette, states);
  }
  const key = `${hue}|${drawnAt}`;
  const hit = states.get(key);
  if (hit !== undefined) return hit;
  const state = searchState(palette, hue, drawnAt);
  states.set(key, state);
  return state;
}

// Memoised per palette like the band: a band's floors ask for the states of
// its neighbours at two depths, and the render walk asks for every band.
const STATE_MEMO = new WeakMap<Palette, Map<string, ColorRgba>>();

function searchState(
  palette: Palette,
  hue: DecorHue,
  drawnAt: ColorDepth,
): ColorRgba {
  // Measured as drawn: a translucent theme's tints and candidates are shown
  // composited over the terminal's black, and a raw-RGBA ratio reads colours
  // drawn nowhere (cyberpunk's secondary measured 2.2 raw and drew at 1.71).
  const tints = DECOR_VOCABULARY.map((entry) =>
    drawnColour(decorEntryColour(palette, entry), ColorDepth.TRUECOLOR),
  );
  const pure = blendRgb(
    paletteRole(palette, "surface"),
    paletteRole(palette, hue),
    STATE_PURE_AMOUNT,
  );
  const foreground = paletteRole(palette, "foreground");
  // Past the pole: `foreground` slid on in OKLCH lightness until it clears
  // every tint. A look can pull the pole itself under the floor (atom-one-
  // dark's foreground under `dim` measured 2.19 against its primary tints),
  // and the palette holds no stronger role to reach for. The bar's tints run
  // from `background` toward `surface` and share its polarity, so each slide
  // moves the same way and never undoes the one before it; when they straddle
  // the cutoff it can, and the check below still refuses.
  const beyond = tints.reduce(
    (candidate, tint) => ensureContrast(candidate, tint, STATE_FLOOR),
    foreground,
  );
  const state = [
    ...Array.from({ length: STATE_STEPS + 1 }, (_, k) =>
      blendRgb(pure, foreground, k / STATE_STEPS),
    ),
    beyond,
  ].find((candidate) =>
    tints.every(
      (tint) =>
        contrastRatio(drawnColour(candidate, ColorDepth.TRUECOLOR), tint) >=
        STATE_FLOOR,
    ),
  );
  if (state === undefined) {
    throw new Error(
      `palette "${palette.name}": "${hue}" cannot clear the ${STATE_FLOOR} state floor even beyond foreground`,
    );
  }
  const drawnState = ensureDrawn(state, drawnAt, (candidate, drawn) =>
    tints.every((tint) => contrastRatio(candidate, drawn(tint)) >= STATE_FLOOR),
  );
  if (drawnState === undefined) {
    throw new Error(
      `palette "${palette.name}": "${hue}" cannot clear the ${STATE_FLOOR} state floor on the colours drawn at depth ${ColorDepth[drawnAt]}`,
    );
  }
  return drawnState;
}

/**
 * The least contrast information-bearing text may have against its cell:
 * WCAG AA for normal text, 4.5:1 — a statusline is small monospace, and the
 * large-text 3:1 measured legible but looked washed out on the saturated
 * threshold colours (catppuccin-latte's warning). The one floor for chosen
 * text (`textOn`) and for the semantic accents the bundled segments author,
 * so an accent reads as well as the text beside it. Deliberately quiet text
 * (the git segments' structure) is held to its own, lower floor.
 * [LAW:one-source-of-truth]
 */
export const TEXT_MIN_CONTRAST = 4.5;

/**
 * The text colour for a cell nobody authored a foreground for: the theme pole
 * on the side of `background` that can carry text, floored at
 * TEXT_MIN_CONTRAST. Text is chosen, never assumed — a fixed foreground fails
 * on pure hues (design doc, Decisions), and the terminal's own text fails on
 * any cell whose polarity differs from the terminal's.
 *
 * The side is rich-js's to name, not ours: `contrastFor` picks black or white
 * by the one luminance cutoff where they contrast equally, and `ensureContrast`
 * slides toward that same pole. So the pole taken is the one nearest
 * `contrastFor`'s pick, and when it misses the floor on a MID-luminance cell
 * (atom-one-dark's foreground on its lighter tints measured 2.49:1) it is slid
 * further the way it already leans — never through the background into the
 * other polarity, so neighbouring cells do not flip text polarity on a
 * hairline tint difference. A pole that already clears is returned unchanged.
 * The floor is measured at `drawnAt`, the depth the terminal draws the pair at
 * (at 256 colours both halves are rounded, and the rounded pair is what must
 * clear it).
 * [LAW:one-source-of-truth]
 */
export function textOn(
  palette: Palette,
  background: ColorRgba,
  drawnAt: ColorDepth,
): ColorRgba {
  let texts = TEXT_MEMO.get(palette);
  if (texts === undefined) {
    texts = new Map();
    TEXT_MEMO.set(palette, texts);
  }
  const key = `${background.hex}|${drawnAt}`;
  const hit = texts.get(key);
  if (hit !== undefined) return hit;
  const side = contrastFor(background);
  const pole = (["background", "foreground"] as const)
    .map((role) => paletteRole(palette, role))
    .reduce((best, pole) =>
      contrastRatio(side, pole) < contrastRatio(side, best) ? pole : best,
    );
  const text = ensureContrast(pole, background, TEXT_MIN_CONTRAST, drawnAt);
  texts.set(key, text);
  return text;
}

// Every cell of every render asks for its text, and the answer is a pure
// function of (palette, background, drawnAt) — a bisection when the pole misses the
// floor, measured at 20% of a render before this memo. A palette's distinct
// backgrounds are its tints, band colours, and the stops its authored ramps
// reach, so each map stays as small as the colours a bar can wear.
const TEXT_MEMO = new WeakMap<Palette, Map<string, ColorRgba>>();

// --- Disclosure: bands ---------------------------------------------------------

/**
 * Where a disclosure sits in the colour model: the hue its lineage is at, and
 * how many bands deep it is. `depth` 0 is a bar cell's own band, opened in
 * `OPEN_HUE`; a disclosure opened from inside that band is depth 1, and so on.
 * The address never enters here — a band is NOT a tree position, it is a
 * plane hung under a trigger.
 */
export interface Disclosure {
  readonly hue: DecorHue;
  readonly depth: number;
}

/**
 * How far a band's plane recedes from its state colour toward `background`:
 * `base + perDepth × depth`, capped. Two cues move with depth — the hue
 * advances and the plane recedes. The cap is the limit: between depths 2 and
 * 3 only 0.05 of recession remains while `hueAtDepth` has wrapped onto a hue
 * already used, so adjacent planes are guaranteed apart only through depth 2
 * (the bundled door → ⚙ → picker). A trigger still stands off its plane at
 * depth 3; `test/decor.test.ts` pins the covered depths.
 */
export const BAND_RECESSION = {
  base: 0.42,
  perDepth: 0.14,
  cap: 0.75,
} as const;

/**
 * The window along the plane→state axis a band's items are placed in, as a
 * fraction of that axis: they start `floor` above the plane and never reach
 * the state, so no item is the plane and none is its own trigger.
 */
export const BAND_WINDOW = { floor: 0.12, span: 0.8 } as const;

/** The vocabulary hue `depth` steps after `hue`, wrapping — depth advances the hue. */
export function hueAtDepth(hue: DecorHue, depth: number): DecorHue {
  const index = (DECOR_HUES.indexOf(hue) + depth) % DECOR_HUES.length;
  // [LAW:no-defensive-null-guards] The index is in range by construction; the
  // `!` states that, it does not guard it.
  return DECOR_HUES[index]!;
}

/**
 * How far apart (ΔE in OKLab) the colours of nested bands stand, the eye's
 * ~.02 threshold of a visible difference being the unit: a trigger off the
 * plane it opens, a plane off the plane it is nested in, and a nested
 * trigger off the plane it sits on. They hold over the depths a bar reaches
 * (0–2; depth 3 is the model's limit, see BAND_RECESSION) in truecolor by the
 * construction below — `test/decor.test.ts` pins the measured minima — and
 * `bandFor` holds each one again on the colours drawn at 256.
 */
export const BAND_FLOORS = {
  triggerPlane: 0.1,
  nestedPlane: 0.035,
  nestedTriggerPlane: 0.08,
} as const;

/**
 * A disclosure's band: two colours of one hue. `state` is its peak — the
 * colour the trigger that opened it wears, so a trigger is drawn from what it
 * OPENS, not from where it sits — and `plane` is its floor, the state receded
 * toward `background`.
 */
export interface Band {
  readonly state: ColorRgba;
  readonly plane: ColorRgba;
}

/**
 * The band `disclosure` opens. One expression for every depth: the state of
 * the depth-advanced hue, and that state pulled toward `background` by the
 * depth's recession. The trigger of the band and the band itself are the SAME
 * value read twice, so they cannot disagree about which hue they share.
 *
 * Both colours are the ones the terminal draws at `drawnAt`: the state is
 * `stateFor`'s at that depth, and a plane whose rounding breaks a
 * `BAND_FLOORS` distance its truecolor colours kept is replaced by the
 * nearest drawn colour that keeps it (`ensureDrawn`). A distance truecolor
 * itself misses (depth 3) is not one rounding broke, so it is not asked of
 * the drawn colours either.
 *
 * Memoised per (palette, hue, depth, drawnAt): the render walk asks for every
 * segment's band on every render, and palettes are memoised objects
 * (transposedPalette), so the key is stable and the search in `stateFor` runs
 * once per palette and depth.
 */
export function bandFor(
  palette: Palette,
  disclosure: Disclosure,
  drawnAt: ColorDepth,
): Band {
  const key = `${disclosure.hue}|${disclosure.depth}|${drawnAt}`;
  let bands = BAND_MEMO.get(palette);
  if (bands === undefined) {
    bands = new Map();
    BAND_MEMO.set(palette, bands);
  }
  const hit = bands.get(key);
  if (hit !== undefined) return hit;
  const state = stateFor(
    palette,
    hueAtDepth(disclosure.hue, disclosure.depth),
    drawnAt,
  );
  // The plane is the truecolor plane as drawn — rounded once, from the
  // theme's own colours, never blended from a state already rounded.
  const neighbours = planeNeighbours(palette, disclosure, state, drawnAt);
  const plane = ensureDrawn(
    trueBand(palette, disclosure).plane,
    drawnAt,
    (candidate, drawn) =>
      neighbours.every(
        ([other, floor]) => deltaE(candidate, drawn(other)) >= floor,
      ),
  );
  if (plane === undefined) {
    throw new Error(
      `palette "${palette.name}": the ${disclosure.hue} band at depth ${disclosure.depth} cannot keep its floors on the colours drawn at depth ${ColorDepth[drawnAt]}`,
    );
  }
  const band = { state, plane };
  bands.set(key, band);
  return band;
}

const deltaE = (a: ColorRgba, b: ColorRgba): number =>
  Oklch.fromRgba(a).deltaE(Oklch.fromRgba(b));

// The band as truecolor draws it — the colours every depth rounds from, and
// the pair whose floors decide which floors a drawn band is held to.
function trueBand(palette: Palette, disclosure: Disclosure): Band {
  const state = stateFor(
    palette,
    hueAtDepth(disclosure.hue, disclosure.depth),
    ColorDepth.TRUECOLOR,
  );
  const recession = Math.min(
    BAND_RECESSION.cap,
    BAND_RECESSION.base + BAND_RECESSION.perDepth * disclosure.depth,
  );
  return {
    state,
    plane: blendRgb(state, paletteRole(palette, "background"), recession),
  };
}

// What a band's plane must stand off, each with the floor it keeps there: its
// own trigger, the trigger of the band nested in it, and — below depth 0,
// whose enclosing surface is the bar and is the state floor's to keep — the
// plane it is nested in. Each floor is the one its truecolor pair already
// kept, and none where truecolor missed it.
function planeNeighbours(
  palette: Palette,
  disclosure: Disclosure,
  state: ColorRgba,
  drawnAt: ColorDepth,
): ReadonlyArray<readonly [ColorRgba, number]> {
  const { hue, depth } = disclosure;
  // The truecolor band is the unrepaired one (`trueBand`),
  // so no floor asks `bandFor` for the band it is computing.
  const trueState = (d: number): ColorRgba =>
    trueBand(palette, { hue, depth: d }).state;
  const truePlane = (d: number): ColorRgba =>
    trueBand(palette, { hue, depth: d }).plane;
  const shown = (c: ColorRgba): ColorRgba =>
    drawnColour(c, ColorDepth.TRUECOLOR);
  const plane = truePlane(depth);
  const kept = (floor: number, other: ColorRgba): number =>
    deltaE(shown(plane), shown(other)) >= floor ? floor : 0;
  // Asking for the nested trigger widens no failure: whether `stateFor` finds
  // a colour does not depend on the hue (its last candidate, and every drawn
  // replacement, are judged against the bar's tints alone), so a nested hue
  // throws only where this band's own trigger already has.
  const nested = hueAtDepth(hue, depth + 1);
  return [
    [state, kept(BAND_FLOORS.triggerPlane, trueState(depth))],
    [
      stateFor(palette, nested, drawnAt),
      kept(
        BAND_FLOORS.nestedTriggerPlane,
        stateFor(palette, nested, ColorDepth.TRUECOLOR),
      ),
    ],
    ...(depth > 0
      ? [
          [
            bandFor(palette, { hue, depth: depth - 1 }, drawnAt).plane,
            kept(BAND_FLOORS.nestedPlane, truePlane(depth - 1)),
          ] as const,
        ]
      : []),
  ];
}
const BAND_MEMO = new WeakMap<Palette, Map<string, Band>>();

/**
 * The colour of the item at `address` — its steps from the band's root, each
 * placed by its parent's own distribution — in the band `disclosure` opens:
 * placed along the plane→state axis inside `BAND_WINDOW`. A band's items are
 * addressed by the SAME step shape the bar's rows and cells address the
 * vocabulary through — one placement mechanism at every level; a band only
 * folds the steps onto its plane-to-state axis (`bandAxis`) instead of into
 * the vocabulary. A picker's options are one step each; a group's body is a
 * container whose cells may nest, and nests fold the same way.
 */
export function bandItemFor(
  palette: Palette,
  disclosure: Disclosure,
  address: readonly PlacedStep[],
  drawnAt: ColorDepth,
): ColorRgba {
  const band = bandFor(palette, disclosure, drawnAt);
  const truecolor = trueBand(palette, disclosure);
  const item = ensureDrawn(
    blendRgb(
      truecolor.plane,
      truecolor.state,
      BAND_WINDOW.floor + BAND_WINDOW.span * bandAxis(address),
    ),
    drawnAt,
    // An item is never the plane it sits on and never its own trigger — as
    // drawn, where a rounding can land it on either.
    (candidate, drawn) =>
      candidate.hex !== drawn(band.plane).hex &&
      candidate.hex !== drawn(band.state).hex,
  );
  if (item === undefined) {
    throw new Error(
      `palette "${palette.name}": a ${disclosure.hue} band item at depth ${disclosure.depth} is drawn as its plane or its trigger at depth ${ColorDepth[drawnAt]}, and nothing that depth draws is neither`,
    );
  }
  return item;
}

// --- Regions -------------------------------------------------------------------

/**
 * Where a node stands in the colour model (design doc, "The region model"):
 * on the BAR, where its address selects a vocabulary entry, or on a BAND — the
 * plane a disclosure hung under its trigger — where its address is the steps
 * since that band's root and places it along the band's axis. The band's
 * `Disclosure` is the hue and depth its TRIGGER computed; nothing about the
 * trigger's own position enters, which is what lets a body hang on its
 * trigger and still be coloured without walk order [LAW:types-are-the-program].
 */
export type Region =
  | { readonly kind: "bar"; readonly address: Address }
  | {
      readonly kind: "band";
      readonly band: Disclosure;
      readonly address: Address;
    };

/** The bar's root: the top of the layout tree, before any step. */
export const BAR_ROOT: Region = { kind: "bar", address: [] };

/** One step down within the same region — a container placing a child. */
export const descend = (region: Region, step: AddressStep): Region => ({
  ...region,
  address: [...region.address, step],
});

/** The root of the band `band` opens — where a disclosure body starts. */
export const bandRoot = (band: Disclosure): Region => ({
  kind: "band",
  band,
  address: [],
});

/**
 * What a segment in a region is dealt. `tint` is the colour its CLOSED cell
 * wears; `disclosure` is the band the segment opens if it is a trigger. Its
 * text is not dealt: an unauthored `fg:` is `textOn` of whatever background
 * the cell resolves to, in every region (resolveSegmentColors).
 */
export interface Decoration {
  readonly tint: ColorRgba;
  readonly disclosure: Disclosure;
}

/**
 * [LAW:one-source-of-truth] ONE read per segment, projected two ways. On the
 * bar, the vocabulary entry its address selects is the closed cell's tint, and
 * what it opens is the depth-0 band in `OPEN_HUE` — every bar trigger opens
 * the same accent, because an open disclosure is what the accent is for. On a
 * band, the item is placed by its address and OPENS the next band of the same
 * lineage: the band's own hue one depth further — a natural counted up from
 * the band it stands on, never arithmetic back from a position.
 */
export function decorationFor(
  palette: Palette,
  region: Region,
  drawnAt: ColorDepth,
): Decoration {
  switch (region.kind) {
    case "bar": {
      return {
        tint: decorFor(palette, region.address),
        disclosure: { hue: OPEN_HUE, depth: 0 },
      };
    }
    case "band": {
      return {
        tint: bandItemFor(palette, region.band, region.address, drawnAt),
        disclosure: { hue: region.band.hue, depth: region.band.depth + 1 },
      };
    }
  }
}

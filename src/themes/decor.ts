// The colour function: a node's ADDRESS in the layout tree selects one entry
// of the theme's own decorative vocabulary. Rationale, measurements and the
// rejected alternatives: design-docs/COLOUR-FROM-THEME-VOCABULARY.md.
//
// The rule, in Textual's colour roles: each row of the bar wears one step of
// the VARIATION — an ordered list of the theme's decorative roles, chosen
// like any other display setting — and each cell of the row one of that
// role's SHADES — the darkenings, the lightenings and the muted form Textual
// generates for the role in every theme — from the window of them the SHADE
// dial is turned to, with the row and the shade chosen by the node's position
// in the tree. Every colour a closed cell wears is one its palette names: it
// SELECTS from the theme; it never synthesises a colour.
//
// [LAW:effects-at-boundaries] Pure. No renderer wiring, no I/O, no traversal
// state: any node's colour is computable from its address alone, without
// visiting any other node. [LAW:one-way-deps] A leaf of the themes module — it
// imports only rich-js, which owns every colour operation used (`mixAxes`,
// `blendRgb`, `ensureContrast`, `ensureDrawn`, `drawnColour`, `contrastFor`,
// `contrastRatio`, `Oklch.deltaE`); cc-candybar keeps the POLICY (which roles,
// which shades, which address formula) and no colour arithmetic of its own.

import {
  blendRgb,
  ColorDepth,
  Oklch,
  contrastFor,
  contrastRatio,
  ensureContrast,
  ensureDrawn,
  drawnColour,
  ColorRgba,
  type Palette,
} from "@promptctl/rich-js";

// --- The vocabulary -----------------------------------------------------------

/**
 * The three non-semantic root hues, in the order a disclosure lineage advances
 * through them (`hueAtDepth`). `error`/`success`/`warning` are deliberately NOT
 * here: decoration never borrows a role that carries meaning, because meaning
 * is not in the set — strictly stronger than hue-anchoring, which only stopped
 * the semantic colours from moving while leaving decoration free to arrive at
 * them. A theme can still spell a decorative role in an alert's colour
 * (textual-dark's `accent` is its `warning`); that is the theme's own choice.
 */
export const DECOR_HUES = ["primary", "secondary", "accent"] as const;
export type DecorHue = (typeof DECOR_HUES)[number];

/**
 * The shades of a role a dial position can reach, darkest first: three
 * darkenings, the role itself, three lightenings — the ladder Textual
 * generates for every role of every theme. The dial turns a window along it.
 */
const LADDER = [
  "darken-3",
  "darken-2",
  "darken-1",
  "base",
  "lighten-1",
  "lighten-2",
  "lighten-3",
] as const;

/**
 * Every shade of a role a closed cell can wear: a rung of the ladder, or the
 * role's MUTED form — the role blended most of the way into the theme's
 * background, which Textual's labels and flat buttons wear under the role's
 * own text colour.
 */
export type RoleShade = (typeof LADDER)[number] | "muted";

// [LAW:one-source-of-truth] Textual's own name for a role at a shade: the
// role's name, suffixed. The record is keyed by every shade, so a shade with
// no palette name is a compile error.
const SHADE_SUFFIX = {
  "darken-3": "-darken-3",
  "darken-2": "-darken-2",
  "darken-1": "-darken-1",
  base: "",
  "lighten-1": "-lighten-1",
  "lighten-2": "-lighten-2",
  "lighten-3": "-lighten-3",
  muted: "-muted",
} as const satisfies Record<RoleShade, string>;

/** The palette entry naming a role at a shade: `secondary-lighten-1`, `accent`, `primary-muted`. */
export type ShadeRole = `${DecorHue}${(typeof SHADE_SUFFIX)[RoleShade]}`;

export const shadeRole = (hue: DecorHue, shade: RoleShade): ShadeRole =>
  `${hue}${SHADE_SUFFIX[shade]}`;

/**
 * The text a decorated cell wears, chosen for its background the way its
 * shade asks. [LAW:dataflow-not-control-flow] A VALUE in the shade's row of
 * the table: a cell's text is one call, whichever position the dial is on.
 */
export type DecorText = (
  palette: Palette,
  hue: DecorHue,
  background: ColorRgba,
  drawnAt: ColorDepth,
) => ColorRgba;

/** On a rung of the ladder: the theme pole that reads on it (`textOn`). */
const poleText: DecorText = (palette, _hue, background, drawnAt) =>
  textOn(palette, background, drawnAt);

/**
 * On a muted role: Textual's own text colour for that role, `$text-primary`
 * on `$primary-muted`, with its hue kept and its lightness slid until it
 * clears TEXT_MIN_CONTRAST — so a muted row's text is coloured the way
 * Textual's labels are, and reads.
 */
const roleText: DecorText = (palette, hue, background, drawnAt) =>
  legibleOn(palette, paletteRole(palette, `text-${hue}`), background, drawnAt);

/**
 * One position of the shade dial: the shades a row's cells wear, in the order
 * a cell's place in its row selects them (`vocabularySelect` over this list),
 * and how text is chosen on them. A position of one shade is a uniform row.
 */
export interface Shade {
  readonly tones: readonly [RoleShade, ...RoleShade[]];
  readonly text: DecorText;
}

/**
 * Three neighbouring rungs of the ladder from `from`: one position of the dial.
 * Listed low, high, middle because a row's first eight cells take entries 0, 2,
 * 1, 2, 0, 2, 1, 0 of three (van der Corput, read by `nearestPoint`): the row
 * walks up and down its window a rung at a time — low, middle, high, middle,
 * low — and turning the dial one position moves every cell exactly one rung.
 * The order is the one Brandon compared the positions in
 * (candybar-theme-colours-6fq5.e5n).
 */
const ladderWindow = (from: number): Shade => ({
  // [LAW:no-defensive-null-guards] Every position below starts at most four
  // rungs up a ladder of seven; the `!`s state that, they do not guard it.
  tones: [LADDER[from]!, LADDER[from + 2]!, LADDER[from + 1]!],
  text: poleText,
});

/**
 * [LAW:one-type-per-behavior] The shade dial: every position a user can turn
 * it to, lowest first (candybar-theme-colours-6fq5.e5n). The window of three
 * rungs slides up the ladder from the role's deepest shades to its brightest,
 * and `middle` — centred on the role itself — is where it rests. Below the
 * deepest window the dial reaches `muted`: every cell of a row in the role's
 * muted form under the role's own text, one colour per row, its cells parted
 * by the joiner's divider. A new position is one row here: the option domain,
 * the loader's enum, the settings control and every floor derive from this
 * table.
 */
export const SHADES = {
  muted: { tones: ["muted"], text: roleText },
  deepest: ladderWindow(0),
  deeper: ladderWindow(1),
  middle: ladderWindow(2),
  brighter: ladderWindow(3),
  brightest: ladderWindow(4),
} as const satisfies Record<string, Shade>;
export type ShadeName = keyof typeof SHADES;

/**
 * The hues the closed bar wears: row n starts on step n (the selection reads
 * the row's placement, so under van der Corput a two-step variation
 * alternates and a one-step one is uniform), and a row advances one step
 * every `run` cells along it. Cells sitting side by side differ by shade; a
 * hue changes only after a run of them — hue changing at every cell reads as
 * team colours, not as the theme (brandon-theme-picker-bgw.8fp). A variation
 * is a sequence of roles the way a chord progression is a sequence of
 * degrees, and it is a VALUE the render carries, so every one ships through
 * the same selection.
 * [LAW:types-are-the-program] One or two hues, no more: a row's starting step
 * is read with `inBin` off its van der Corput placement (0, ½, ¼, ¾, …), which
 * steps in order through one or two bins and not through three (rows 0–3 of a
 * three-step variation would land on steps 0, 1, 0, 2). A longer one needs
 * a different selection, so the type does not admit it.
 */
export interface Variation {
  readonly hues: readonly [DecorHue] | readonly [DecorHue, DecorHue];
  /**
   * How many cells along a row wear one hue before the row steps to the
   * next. `WHOLE_ROW` keeps one hue across the row, so the hue changes only
   * where the bar changes row. [LAW:dataflow-not-control-flow] One value,
   * not a mode: ⌊index / ∞⌋ is 0 for every cell.
   */
  readonly run: RunLength;
}

declare const wholeRow: unique symbol;
type WholeRow = number & { readonly [wholeRow]: true };

/** A run no row outlasts: the hue changes only where the bar changes row. */
export const WHOLE_ROW = Infinity as WholeRow;

/**
 * [LAW:types-are-the-program] A whole number of cells of at least two, or the
 * whole row: a run of one is a hue per cell (the team colours 8fp rejected),
 * and 0, a fraction, a negative or NaN would quietly turn the hue some other
 * way, so none of them is a run.
 */
export type RunLength = 2 | 3 | 4 | 5 | 6 | 7 | 8 | WholeRow;

/**
 * [LAW:one-type-per-behavior] Every variation a user can choose, named by
 * the roles it steps through. A new one is one row here: the option domain,
 * the loader's enum, the settings carousel and every floor derive from this
 * table. `alt` is variant C of 8fp ("base changes per cell, hue changes every
 * few cells"): the default's hues, turning every three cells along the row —
 * short enough that both rows of the bundled bar turn, long enough that a hue
 * holds across two seams before it does.
 */
export const VARIATIONS = {
  accent: { hues: ["secondary", "accent"], run: WHOLE_ROW },
  duo: { hues: ["primary", "secondary"], run: WHOLE_ROW },
  mono: { hues: ["primary"], run: WHOLE_ROW },
  alt: { hues: ["secondary", "accent"], run: 3 },
} as const satisfies Record<string, Variation>;
export type VariationName = keyof typeof VARIATIONS;

/**
 * How the closed bar wears its theme: the variation chooses each row's role,
 * the shade which of that role's shades each cell wears. Both are display
 * settings resolved per render, and the bar's Region carries them together.
 */
export interface Decor {
  readonly variation: Variation;
  readonly shade: Shade;
}

/**
 * The hue an open disclosure wears: Textual's `accent`, "used sparingly to
 * draw attention". Every bar trigger opens a band in it. A variation may put
 * it on a closed row too, which is why an open trigger is held apart from the
 * closed bar by contrast (`stateFor`), never by hue alone.
 */
export const OPEN_HUE = "accent" satisfies DecorHue;

/** The roles whose meaning decoration must never borrow. */
export type SemanticRole = "error" | "success" | "warning";

// [LAW:types-are-the-program] Checked by the compiler rather than a review: no
// semantic role is a decorative hue. (test/decor.test.ts asserts it at runtime
// too.)
const _decorHuesAreNonSemantic: Extract<DecorHue, SemanticRole> extends never
  ? true
  : never = true;
void _decorHuesAreNonSemantic;

/**
 * The theme's two poles: text is chosen from them (`textOn`), and a band's
 * plane recedes toward `background` — or `foreground`, where the background
 * leaves it no room — so the cues invert on their own between light and dark
 * themes, with no branch.
 */
export type ThemePole = "foreground" | "background";

/** One closed bar cell's decoration: its row's hue, at its own shade. */
export interface DecorEntry {
  readonly hue: DecorHue;
  readonly shade: RoleShade;
}

/** Every decoration a closed cell can wear under `decor`: each of its roles at each of its shades. */
export const vocabularyOf = (decor: Decor): readonly DecorEntry[] =>
  decor.variation.hues.flatMap((hue) =>
    decor.shade.tones.map((shade) => ({ hue, shade })),
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
 * the shade, so a hue can only change where the bar itself changes row.
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
 * The nearest of `size` points spaced evenly round the circle from 0. Over a
 * window of three shades a row's first eight cells take entries 0, 2, 1, 2, 0,
 * 2, 1, 0: no two neighbours alike. The bin rule puts cells 5 and 6 on one
 * entry, inside the bundled status row.
 */
export const nearestPoint: Quantize = (placement, size) =>
  Math.round(placement * size) % size;

/** Where a step falls on the circle; an absent step (the root) at 0. */
function placementOf(step: PlacedStep | undefined): number {
  return step === undefined ? 0 : step.distribution(step.index, step.count);
}

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
  const entry = vocabulary[quantize(placementOf(step), vocabulary.length)];
  if (entry === undefined)
    throw new Error("vocabularySelect: empty vocabulary");
  return entry;
}

/**
 * A bar address read as the rows it stacks through, then the cell of the
 * innermost of them, then whatever is nested inside that cell: the row it
 * stands in is the LAST of those rows, and its cell the step after it. An
 * absent step is a node alone on that axis — a bar with no vertical container,
 * a one-cell row — placed where a first child is.
 */
function rowAndCell(address: Address): {
  readonly row: AddressStep | undefined;
  readonly cell: AddressStep | undefined;
} {
  const at = address.findIndex((step) => step.axis === "cell");
  const rows = at === -1 ? address : address.slice(0, at);
  return { row: rows.at(-1), cell: address[rows.length] };
}

/** The step of the variation a row starts on: the bin its placement falls in. */
const rowStart = (variation: Variation, row: AddressStep | undefined): number =>
  inBin(placementOf(row), variation.hues.length);

/**
 * The decorative entry a bar node's address selects under `decor`: the last
 * of the rows it stacks through chooses the hue the row starts on, so a row
 * stacked above the whole bar (edit mode's reset banner) recolours no row
 * beneath it; the cell chooses the shade, and its index how many of the
 * variation's runs it has passed along the row. Anything nested inside a cell
 * — edit mode's `+`/`-` around it, an authored `{ h }` or `{ v }` — wears the
 * cell's hue and shade: a row's cells are what sit side by side, so they are
 * what must differ, and the loader refuses a `distribution` authored inside a
 * cell, where it could place nothing. A cell's run counts its position among
 * its row's siblings in the tree the walk renders — authored, never what is
 * visible, so hiding one recolours none — and a synthesized cell counts like
 * an authored one: the settings door leading the first row takes that row's
 * first slot.
 *
 * Rows alternate among SIBLINGS. A row that is itself a stack of rows restarts
 * the alternation inside it, so its last line can wear the hue of the row
 * after it: which line is next to which is a fact about the rendered bar, and
 * reading it would make a node's colour depend on its neighbours' shapes — the
 * pre-order cursor's flaw, where hiding one segment recoloured others. The
 * bundled bar stacks no rows inside a row.
 */
export function decorEntryFor(decor: Decor, address: Address): DecorEntry {
  const { row, cell } = rowAndCell(address);
  // The row starts on its own step and advances one step per run along it.
  const { hues, run } = decor.variation;
  const turn = cell === undefined ? 0 : Math.floor(cell.index / run);
  const hue = hues[(rowStart(decor.variation, row) + turn) % hues.length];
  if (hue === undefined) throw new Error("decorEntryFor: empty variation");
  return {
    hue,
    shade: vocabularySelect(decor.shade.tones, cell, nearestPoint),
  };
}

/**
 * The roles a bar node's row wears from its first cell to its last: the step
 * it starts on, and each step its runs turn to along the row's cells — one
 * role under a whole-row variation, every role of `alt` along a row longer
 * than one run. The closed cells an open trigger in that row stands among are
 * these roles at the dial's shades (`Ground`). [LAW:one-source-of-truth] A
 * set, listed in DECOR_HUES order: two rows reaching the same roles from
 * different starts stand among the same cells, so they deal one ground.
 */
export function rowHues(
  variation: Variation,
  address: Address,
): readonly DecorHue[] {
  const { row, cell } = rowAndCell(address);
  const { hues, run } = variation;
  const start = rowStart(variation, row);
  const turns = Math.floor(((cell?.count ?? 1) - 1) / run);
  const reached = new Set(
    Array.from(
      { length: Math.min(turns + 1, hues.length) },
      (_, k) => hues[(start + k) % hues.length],
    ),
  );
  return DECOR_HUES.filter((hue) => reached.has(hue));
}

/** A palette entry decoration reads: a pole, an alert, a role at a shade, or a role's text. */
export type DecorRole =
  | ThemePole
  | SemanticRole
  | ShadeRole
  | `text-${DecorHue}`;

/**
 * [LAW:parse-dont-validate] The one unit that turns a palette role NAME into a
 * proven `ColorRgba`. Every shipped theme carries every role this module names
 * (test/decor.test.ts checks the whole registry), so an absence is registry
 * drift or a hand-built palette missing a role — a loud failure naming both,
 * never a fallback colour. [LAW:no-silent-failure]
 */
export function paletteRole(palette: Palette, role: DecorRole): ColorRgba {
  const colour = palette.get(role);
  if (colour === undefined) {
    throw new Error(
      `palette "${palette.name}" has no "${role}" role; decoration needs it`,
    );
  }
  return colour;
}

/**
 * The colour of one vocabulary entry in `palette`: the palette's own entry for
 * the role at that shade, byte for byte. [LAW:one-source-of-truth] The one
 * place an entry becomes a colour — `decorFor` renders through it and
 * `stateFor` measures against it, so a floor is enforced against the very
 * bytes a closed cell will show.
 */
export const decorEntryColour = (
  palette: Palette,
  entry: DecorEntry,
): ColorRgba => paletteRole(palette, shadeRole(entry.hue, entry.shade));

/** A node's decorative background: the colour of the entry its address selects. */
export const decorFor = (
  palette: Palette,
  decor: Decor,
  address: Address,
): ColorRgba => decorEntryColour(palette, decorEntryFor(decor, address));

// --- The state region ---------------------------------------------------------

/**
 * The contrast an open trigger must hold above every cell it stands among.
 * Enforced rather than assumed because "the pure hue is vivid" is false for
 * some palettes (textual-dark's `secondary` is a navy darker than most
 * surfaces), and because a closed cell wears its role's own shades, so a
 * trigger drawn in a role can stand among cells drawn in that same role.
 */
export const STATE_FLOOR = 2.2;

/**
 * The search slides the hue's lightness in twelfths each way, reaching black
 * and white themselves, so any cells some colour stands off are cells a
 * candidate stands off.
 */
const STATE_STEPS = 12;

/**
 * The closed cells a bar trigger stands among: the roles its row wears
 * (`rowHues`), at the shades the dial puts on them. The state floor holds a
 * bar trigger off these and only these. Measured against the whole bar it
 * cannot hold: the dial puts the roles' own shades on the bar, and a bar whose
 * rows wear a deep role and a bright one — textual-dark's navy `secondary` and
 * orange `accent`, at the default shade — leaves no colour 2.2:1 off every
 * cell of both.
 */
export interface Ground {
  readonly hues: readonly DecorHue[];
  readonly tones: readonly RoleShade[];
}

/** The colours of a ground's cells, as the palette names them. */
export const groundCells = (palette: Palette, ground: Ground): ColorRgba[] =>
  ground.hues.flatMap((hue) =>
    ground.tones.map((shade) => decorEntryColour(palette, { hue, shade })),
  );

/**
 * What the state search found: the colour an open trigger wears and, when no
 * colour stands `STATE_FLOOR` off every cell it stands among, how far the
 * colour it settled on does — its contrast against its nearest cell, as drawn
 * at the depth it was searched for — or null when it clears.
 */
export interface StateSearch {
  readonly state: ColorRgba;
  readonly short: number | null;
}

/**
 * The state colour of `hue` among `cells`: an open disclosure's trigger is
 * drawn here. The hue itself, as the palette names it, when it already stands
 * `STATE_FLOOR` off every cell — the enforcement is a floor, not a transform.
 * Otherwise the hue slid along its own OKLCH lightness, its angle and chroma
 * kept, the least distance that stands off every cell: toward white and toward
 * black in twelfths, a step each way in turn. Cells that are dim take a bright
 * state and cells that are vivid a deep one, with no branch on which.
 *
 * The floor holds on what the terminal draws at `drawnAt`: at 256 colours the
 * trigger and every cell are rounded independently, and a trigger whose
 * rounding lands too near a rounded cell is replaced by the nearest drawn
 * colour that clears the floor against all of them (rich-js `ensureDrawn`).
 *
 * [LAW:dataflow-not-control-flow] Twenty-five candidates, one predicate, the
 * first that passes; the values decide, not a branch per theme.
 * [LAW:no-silent-failure] Cells no colour clears — a row turning between
 * textual-dark's navy and orange under `alt` — get the candidate standing
 * furthest off its nearest cell, and `short` says how far that is, for the
 * render to report. It does not throw: the settings door is a trigger too,
 * and a throw there would leave no way to turn the setting back.
 */
export function stateFor(
  palette: Palette,
  hue: DecorHue,
  cells: readonly ColorRgba[],
  drawnAt: ColorDepth,
): StateSearch {
  let states = STATE_MEMO.get(palette);
  if (states === undefined) {
    states = new Map();
    STATE_MEMO.set(palette, states);
  }
  const key = `${hue}|${cells.map((c) => c.hex).join("+")}|${drawnAt}`;
  const hit = states.get(key);
  if (hit !== undefined) return hit;
  const search = searchState(palette, hue, cells, drawnAt);
  states.set(key, search);
  return search;
}

// Memoised per palette like the band: a band's floors ask for the states of
// its neighbours at two depths, and the render walk asks for every band.
const STATE_MEMO = new WeakMap<Palette, Map<string, StateSearch>>();

function searchState(
  palette: Palette,
  hue: DecorHue,
  among: readonly ColorRgba[],
  drawnAt: ColorDepth,
): StateSearch {
  // Measured as drawn: a translucent theme's colours are shown composited over
  // the terminal's black, and a raw-RGBA ratio reads colours drawn nowhere
  // (cyberpunk's secondary measured 2.2 raw and drew at 1.71).
  const shown = (c: ColorRgba): ColorRgba =>
    drawnColour(c, ColorDepth.TRUECOLOR);
  const cells = among.map(shown);
  const pure = paletteRole(palette, hue);
  // A ray from the pure hue to an end of the lightness axis, in twelfths: its
  // lightness moved, its angle and chroma kept (as far as the gamut holds them
  // near black and white), so every candidate is still the theme's hue.
  // Sliding toward the theme's poles instead greyed the hue, and a slide past a
  // pole cell by cell undid itself on cells straddling the middle grey.
  const ray = (end: ColorRgba): ColorRgba[] =>
    Array.from({ length: STATE_STEPS }, (_, k) =>
      Oklch.fromRgba(pure)
        .mixAxes(Oklch.fromRgba(end), {
          l: (k + 1) / STATE_STEPS,
          c: 0,
          h: 0,
          alpha: 0,
        })
        .toRgba(),
    );
  const darker = ray(new ColorRgba(0, 0, 0));
  const candidates = [
    pure,
    // [LAW:no-defensive-null-guards] Both rays are one length by construction.
    ...ray(new ColorRgba(255, 255, 255)).flatMap((c, k) => [c, darker[k]!]),
  ];
  // The contrast against the nearest cell: what the floor holds, and what
  // cells no colour clears are drawn to the most of. No cell at all is
  // nothing to stand off.
  const nearest = (candidate: ColorRgba): number =>
    Math.min(
      Infinity,
      ...cells.map((cell) => contrastRatio(shown(candidate), cell)),
    );
  const clear = candidates.find((c) => nearest(c) >= STATE_FLOOR);
  if (clear === undefined) {
    const best = candidates.reduce((a, b) => (nearest(b) > nearest(a) ? b : a));
    return { state: best, short: nearest(best) };
  }
  const drawn = ensureDrawn(clear, drawnAt, (candidate, draw) =>
    cells.every((cell) => contrastRatio(candidate, draw(cell)) >= STATE_FLOOR),
  );
  const asDrawn = shownAt(drawnAt);
  return drawn === undefined
    ? {
        state: clear,
        short: Math.min(
          ...cells.map((cell) => contrastRatio(asDrawn(clear), asDrawn(cell))),
        ),
      }
    : { state: drawn, short: null };
}

const shownAt =
  (drawnAt: ColorDepth) =>
  (c: ColorRgba): ColorRgba =>
    drawnColour(c, drawnAt);

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
  const side = contrastFor(background);
  const pole = (["background", "foreground"] as const)
    .map((role) => paletteRole(palette, role))
    .reduce((best, pole) =>
      contrastRatio(side, pole) < contrastRatio(side, best) ? pole : best,
    );
  return legibleOn(palette, pole, background, drawnAt);
}

/**
 * `text` with its hue kept and its lightness slid until it clears
 * TEXT_MIN_CONTRAST on `background` as drawn at `drawnAt` (rich-js
 * `ensureContrast`); text that already clears is returned unchanged.
 * [LAW:single-enforcer] The one floor every chosen text meets — a theme pole
 * (`textOn`), a muted role's own text colour (the `muted` shade).
 */
export function legibleOn(
  palette: Palette,
  text: ColorRgba,
  background: ColorRgba,
  drawnAt: ColorDepth,
): ColorRgba {
  let texts = TEXT_MEMO.get(palette);
  if (texts === undefined) {
    texts = new Map();
    TEXT_MEMO.set(palette, texts);
  }
  const key = `${text.hex}|${background.hex}|${drawnAt}`;
  const hit = texts.get(key);
  if (hit !== undefined) return hit;
  const legible = ensureContrast(text, background, TEXT_MIN_CONTRAST, drawnAt);
  texts.set(key, legible);
  return legible;
}

// Every cell of every render asks for its text, and the answer is a pure
// function of (text, background, drawnAt) — a bisection when the text misses
// the floor, measured at 20% of a render before this memo. A palette's distinct
// backgrounds are its shades, band colours, and the stops its authored ramps
// reach, so each map stays as small as the colours a bar can wear.
const TEXT_MEMO = new WeakMap<Palette, Map<string, ColorRgba>>();

// --- Disclosure: bands ---------------------------------------------------------

/**
 * Where a disclosure sits in the colour model: the hue its lineage is at, how
 * many bands deep it is, and the closed cells its lineage's bar trigger
 * stands among. `depth` 0 is a bar cell's own band, opened in `OPEN_HUE`; a
 * disclosure opened from inside that band is depth 1, and so on, keeping the
 * ground it started from. The address never enters here — a band is NOT a
 * tree position, it is a plane hung under a trigger; the ground is what its
 * bar trigger was dealt for the row it stands in.
 */
export interface Disclosure {
  readonly hue: DecorHue;
  readonly depth: number;
  readonly ground: Ground;
}

/**
 * The cells the trigger of the band `disclosure` opens stands among: a bar
 * trigger (depth 0) among its row's closed cells, and a trigger that is itself
 * an item of a band — a tab, a picker's control — on that band's plane. Held
 * off the bar's row as well, a nested state was driven to the same end of the
 * lightness axis as its parent's on a row of vivid shades, and the two
 * collapsed into one; held off nothing, it could sit on the plane it stands on.
 */
function standsAmong(
  palette: Palette,
  disclosure: Disclosure,
): readonly ColorRgba[] {
  return disclosure.depth === 0
    ? groundCells(palette, disclosure.ground)
    : enclosingPlane(palette, disclosure);
}

// The plane of the band `disclosure` hangs in, as truecolor draws it: none for
// a bar trigger's band (the bar is no band), the plane one depth up otherwise.
const enclosingPlane = (
  palette: Palette,
  disclosure: Disclosure,
): readonly ColorRgba[] =>
  disclosure.depth === 0
    ? []
    : [trueBand(palette, { ...disclosure, depth: disclosure.depth - 1 }).plane];

/** The one line the render reports for a state that stands short of its floor. */
const shortfallOf = (
  palette: Palette,
  { short }: StateSearch,
  drawnAt: ColorDepth,
): string | null =>
  short === null
    ? null
    : `theme "${palette.name}": no open-trigger colour stands ${STATE_FLOOR}:1 off every cell beside it — the nearest stands ${short.toFixed(2)}:1 as drawn at depth ${ColorDepth[drawnAt]}; another shade or variation clears it`;

/**
 * How far a band's plane recedes from its state colour toward `background`:
 * `base + perDepth × depth`, capped — and where that plane breaks a band floor,
 * toward `foreground`, then either as far as the cap (`computeTrueBand`). Two
 * cues move with depth — the hue
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
 * plane it opens, and a plane off the plane it is nested in. They hold over
 * the depths a bar reaches (0–2; depth 3 is the model's limit, see
 * BAND_RECESSION) in truecolor by the construction below —
 * `test/decor.test.ts` pins the measured minima — and `bandFor` holds each one
 * again on the colours drawn at 256 and ansi. A nested trigger is held off the
 * plane it sits on by STATE_FLOOR, as every open trigger is held off what it
 * stands among (`standsAmong`).
 */
export const BAND_FLOORS = {
  triggerPlane: 0.1,
  nestedPlane: 0.035,
} as const;

/**
 * A disclosure's band: two colours of one hue. `state` is its peak — the
 * colour the trigger that opened it wears, so a trigger is drawn from what it
 * OPENS, not from where it sits — and `plane` is its floor, the state receded
 * toward `background` (`computeTrueBand`).
 */
export interface Band {
  readonly state: ColorRgba;
  readonly plane: ColorRgba;
  /**
   * Why `state` stands short of STATE_FLOOR off the ground its lineage's
   * trigger stands on (`StateSearch`), or null when it clears. The render
   * reports it where the trigger opens.
   */
  readonly shortfall: string | null;
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
 * Memoised per (palette, disclosure, drawnAt): the render walk asks for every
 * segment's band on every render, and palettes are memoised objects
 * (transposedPalette), so the key is stable and each band is computed once
 * per palette, lineage and drawn depth.
 */
export function bandFor(
  palette: Palette,
  disclosure: Disclosure,
  drawnAt: ColorDepth,
): Band {
  const key = `${disclosureKey(disclosure)}|${drawnAt}`;
  let bands = BAND_MEMO.get(palette);
  if (bands === undefined) {
    bands = new Map();
    BAND_MEMO.set(palette, bands);
  }
  const hit = bands.get(key);
  if (hit !== undefined) return hit;
  const search = stateFor(
    palette,
    hueAtDepth(disclosure.hue, disclosure.depth),
    standsAmong(palette, disclosure),
    drawnAt,
  );
  const { state } = search;
  // The plane is the truecolor plane as drawn — rounded once, from the
  // theme's own colours, never blended from a state already rounded.
  const floors = planeFloors(palette, disclosure, state, drawnAt);
  const plane = ensureDrawn(
    trueBand(palette, disclosure).plane,
    drawnAt,
    (candidate, drawn) => floors.every((holds) => holds(candidate, drawn)),
  );
  if (plane === undefined) {
    throw new Error(
      `palette "${palette.name}": the ${disclosure.hue} band at depth ${disclosure.depth} cannot keep its floors on the colours drawn at depth ${ColorDepth[drawnAt]}`,
    );
  }
  const band = {
    state,
    plane,
    shortfall: shortfallOf(palette, search, drawnAt),
  };
  bands.set(key, band);
  return band;
}

// [LAW:one-source-of-truth] The one spelling of a lineage as a memo key.
const disclosureKey = ({ hue, depth, ground }: Disclosure): string =>
  `${hue}|${depth}|${ground.hues.join("+")}@${ground.tones.join("+")}`;

const deltaE = (a: ColorRgba, b: ColorRgba): number =>
  Oklch.fromRgba(a).deltaE(Oklch.fromRgba(b));

// The band as truecolor draws it — the colours every depth rounds from, and
// the pair whose floors decide which floors a drawn band is held to.
function trueBand(palette: Palette, disclosure: Disclosure): Band {
  // Memoised beside the drawn bands: every band's floors and every band item
  // round from it, so the render walk asks for it once per item.
  const key = disclosureKey(disclosure);
  let bands = TRUE_BAND_MEMO.get(palette);
  if (bands === undefined) {
    bands = new Map();
    TRUE_BAND_MEMO.set(palette, bands);
  }
  const hit = bands.get(key);
  if (hit !== undefined) return hit;
  const band = computeTrueBand(palette, disclosure);
  bands.set(key, band);
  return band;
}
const TRUE_BAND_MEMO = new WeakMap<Palette, Map<string, Band>>();

function computeTrueBand(palette: Palette, disclosure: Disclosure): Band {
  const search = stateFor(
    palette,
    hueAtDepth(disclosure.hue, disclosure.depth),
    standsAmong(palette, disclosure),
    ColorDepth.TRUECOLOR,
  );
  const { state } = search;
  const recession = Math.min(
    BAND_RECESSION.cap,
    BAND_RECESSION.base + BAND_RECESSION.perDepth * disclosure.depth,
  );
  // The plane recedes into the background, as a band always has — or, where
  // that plane would stand too near its trigger or the plane it hangs in (a
  // state the search carried to the background to stand off a row of vivid
  // shades), into the foreground, then into either as far as the cap: the
  // first that holds the band's floors, and the background where none does.
  const shown = (c: ColorRgba): ColorRgba =>
    drawnColour(c, ColorDepth.TRUECOLOR);
  const into = (pole: ThemePole, amount: number): ColorRgba =>
    blendRgb(state, paletteRole(palette, pole), amount);
  const enclosing = enclosingPlane(palette, disclosure);
  const holds = (plane: ColorRgba): boolean =>
    deltaE(shown(state), shown(plane)) >= BAND_FLOORS.triggerPlane &&
    enclosing.every(
      (outer) => deltaE(shown(outer), shown(plane)) >= BAND_FLOORS.nestedPlane,
    );
  const intoBackground = into("background", recession);
  return {
    state,
    plane:
      [
        intoBackground,
        into("foreground", recession),
        into("background", BAND_RECESSION.cap),
        into("foreground", BAND_RECESSION.cap),
      ].find(holds) ?? intoBackground,
    shortfall: shortfallOf(palette, search, ColorDepth.TRUECOLOR),
  };
}

// A floor a band's drawn plane must hold: true when `candidate`, already drawn,
// holds it against the neighbour `drawn` shows it beside.
type PlaneFloor = (
  candidate: ColorRgba,
  drawn: (c: ColorRgba) => ColorRgba,
) => boolean;

// What a band's plane must hold as drawn, each a floor its truecolor colours
// already hold, and none where truecolor missed it: off its own trigger (ΔE),
// under the trigger of the band nested in it — which stands STATE_FLOOR off
// the plane it sits on — and, below depth 0, whose enclosing surface is the
// bar and the state floor's to keep, off the plane it is nested in (ΔE).
function planeFloors(
  palette: Palette,
  disclosure: Disclosure,
  state: ColorRgba,
  drawnAt: ColorDepth,
): readonly PlaneFloor[] {
  const { hue, depth, ground } = disclosure;
  // The truecolor band is the unrepaired one (`trueBand`),
  // so no floor asks `bandFor` for the band it is computing.
  const trueState = (d: number): ColorRgba =>
    trueBand(palette, { hue, depth: d, ground }).state;
  const truePlane = (d: number): ColorRgba =>
    trueBand(palette, { hue, depth: d, ground }).plane;
  const shown = (c: ColorRgba): ColorRgba =>
    drawnColour(c, ColorDepth.TRUECOLOR);
  const plane = truePlane(depth);
  const keptApart = (floor: number, other: ColorRgba): number =>
    deltaE(shown(plane), shown(other)) >= floor ? floor : 0;
  const nested = hueAtDepth(hue, depth + 1);
  const nestedAmong = standsAmong(palette, { hue, depth: depth + 1, ground });
  const nestedTrue = stateFor(
    palette,
    nested,
    nestedAmong,
    ColorDepth.TRUECOLOR,
  );
  const nestedDrawn = stateFor(palette, nested, nestedAmong, drawnAt).state;
  const keptUnder =
    contrastRatio(shown(plane), shown(nestedTrue.state)) >= STATE_FLOOR
      ? STATE_FLOOR
      : 0;
  const apart =
    (other: ColorRgba, floor: number): PlaneFloor =>
    (candidate, drawn) =>
      deltaE(candidate, drawn(other)) >= floor;
  return [
    apart(state, keptApart(BAND_FLOORS.triggerPlane, trueState(depth))),
    (candidate, drawn) =>
      contrastRatio(candidate, drawn(nestedDrawn)) >= keptUnder,
    ...(depth > 0
      ? [
          apart(
            bandFor(palette, { hue, depth: depth - 1, ground }, drawnAt).plane,
            keptApart(BAND_FLOORS.nestedPlane, truePlane(depth - 1)),
          ),
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
 * on the BAR, where its address selects a vocabulary entry under the bar's
 * decor, or on a BAND — the plane a disclosure hung under its trigger — where
 * its address is the steps since that band's root and places it along the
 * band's axis. The band's `Disclosure` is the hue, depth and ground its
 * TRIGGER computed; nothing about the trigger's own position enters, which is
 * what lets a body hang on its trigger and still be coloured without walk
 * order [LAW:types-are-the-program]. The decor rides the bar arm alone: a
 * band's colours are its trigger's lineage, which reaches the bar only
 * through the ground its trigger was dealt.
 */
export type Region =
  | {
      readonly kind: "bar";
      readonly decor: Decor;
      readonly address: Address;
    }
  | {
      readonly kind: "band";
      readonly band: Disclosure;
      readonly address: Address;
    };

/** The bar's root under `decor`: the top of the layout tree, before any step. */
export const barRoot = (decor: Decor): Region => ({
  kind: "bar",
  decor,
  address: [],
});

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
 * wears and `text` the text that colour is paired with — what an unauthored
 * `fg:` is wherever the cell wears its tint; on any other background it is
 * `textOn` of that background (resolveSegmentColors). `disclosure` is the
 * band the segment opens if it is a trigger.
 */
export interface Decoration {
  readonly tint: ColorRgba;
  readonly text: ColorRgba;
  readonly disclosure: Disclosure;
}

/**
 * [LAW:one-source-of-truth] ONE read per segment, projected three ways. On
 * the bar, the entry its address selects under the bar's decor is the closed
 * cell's tint, its shade says what text the tint is paired with, and what it
 * opens is the depth-0 band in `OPEN_HUE` — every bar trigger opens the same
 * accent, because an open disclosure is what the accent is for — over the
 * ground of the row it stands in. On a band, the item is placed by its
 * address, its text is chosen for it, and it OPENS the next band of the same
 * lineage: the band's own hue one depth further — a natural counted up from
 * the band it stands on, never arithmetic back from a position — over the
 * same ground.
 */
export function decorationFor(
  palette: Palette,
  region: Region,
  drawnAt: ColorDepth,
): Decoration {
  switch (region.kind) {
    case "bar": {
      const { decor, address } = region;
      const entry = decorEntryFor(decor, address);
      const tint = decorEntryColour(palette, entry);
      return {
        tint,
        text: decor.shade.text(palette, entry.hue, tint, drawnAt),
        disclosure: {
          hue: OPEN_HUE,
          depth: 0,
          ground: {
            hues: rowHues(decor.variation, address),
            tones: decor.shade.tones,
          },
        },
      };
    }
    case "band": {
      const { band, address } = region;
      const tint = bandItemFor(palette, band, address, drawnAt);
      return {
        tint,
        text: textOn(palette, tint, drawnAt),
        disclosure: { ...band, depth: band.depth + 1 },
      };
    }
  }
}

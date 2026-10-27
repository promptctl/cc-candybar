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
// imports only its memo and rich-js, which owns every colour operation used (`mixAxes`,
// `blendRgb`, `ensureContrast`, `ensureDrawn`, `drawnColour`, `contrastFor`,
// `contrastRatio`, `relativeLuminance`, `Oklch.deltaE`); cc-candybar keeps the
// POLICY (which roles, which shades, which address formula) and no colour
// arithmetic of its own.

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
  relativeLuminance,
  SEAM_MIN_DELTA_E,
  type Palette,
} from "@promptctl/rich-js";
import { memoPerPalette } from "./palette-memo.js";
import { is, sameBy, sameEach } from "../utils/same.js";

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
  return entryAt(decor, row, cell);
}

// [LAW:one-source-of-truth] The one reading of a cell of a row: the row starts
// on its own step and advances one step per run along it, and the cell's place
// picks its shade. A closed cell's colour (`decorEntryFor`) and the cells an
// open trigger stands among (`rowGround`) both read it.
function entryAt(
  decor: Decor,
  row: AddressStep | undefined,
  cell: AddressStep | undefined,
): DecorEntry {
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
 * The closed cells a bar node's row wears, from its first cell to its last:
 * each cell's entry, read as `decorEntryFor` reads it — the roles the row
 * reaches, at the shades its cells take, which a row of one or two cells, or
 * a role an `alt` row turns to for only part of a run, does not take all of. A
 * node alone on the cell axis is a row of one. Read off the row's authored
 * cells, as their colours are, so hiding one changes no trigger's ground.
 * Each entry once, in the vocabulary's order: two rows whose cells wear the
 * same entries stand among the same cells, so they deal one ground.
 */
export function rowGround(decor: Decor, address: Address): Ground {
  const { row, cell } = rowAndCell(address);
  const cells: ReadonlyArray<AddressStep | undefined> =
    cell === undefined
      ? [undefined]
      : Array.from({ length: cell.count }, (_, index) => ({ ...cell, index }));
  const worn = new Map(
    cells
      .map((c) => entryAt(decor, row, c))
      .map((entry) => [shadeRole(entry.hue, entry.shade), entry] as const),
  );
  return [...worn.values()].sort(
    (a, b) =>
      DECOR_HUES.indexOf(a.hue) - DECOR_HUES.indexOf(b.hue) ||
      ROLE_SHADES.indexOf(a.shade) - ROLE_SHADES.indexOf(b.shade),
  );
}

// Every shade of a role, darkest rung first and the muted form last: the order
// a ground lists a role's entries in.
const ROLE_SHADES: readonly RoleShade[] = [...LADDER, "muted"];

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
 * and white themselves.
 */
const STATE_STEPS = 12;

/** Halvings of the ray that find a balance: far finer than any colour drawn. */
const BALANCE_HALVINGS = 40;

/**
 * The closed cells a bar trigger stands among: the entries its row's cells
 * wear (`rowGround`). The state floor holds a bar trigger off these and only
 * these. Measured against the whole bar it cannot hold: the dial puts the
 * roles' own shades on the bar, and a bar whose rows wear a deep role and a
 * bright one — textual-dark's navy `secondary` and orange `accent`, at the
 * default shade — leaves no colour 2.2:1 off every cell of both. Held off
 * every shade of the row's roles, rather than the ones its cells wear, it
 * reported rows short that a colour clears (design doc, Decisions).
 */
export type Ground = readonly DecorEntry[];

/** The colours of a ground's cells, as the palette names them. */
export const groundCells = (palette: Palette, ground: Ground): ColorRgba[] =>
  ground.map((entry) => decorEntryColour(palette, entry));

/**
 * What the state search found: the colour an open trigger wears and, when no
 * colour stands `STATE_FLOOR` off every cell it stands among, how far the
 * colour it settled on does — its contrast against its nearest cell, as drawn
 * at the depth it was searched for — or null when it clears.
 */
export interface StateSearch {
  /**
   * The candidate the search settled on, before the depth draws it: `state`
   * is drawn from it, and the band's plane and items are blended from it
   * (`unroundedBand`), so a trigger and its band have one colour to agree on
   * at every depth. Where no twelfth clears — in truecolor, or as the depth
   * draws it — the depth chooses it.
   */
  readonly anchor: ColorRgba;
  readonly state: ColorRgba;
  readonly short: number | null;
}

/** A colour as the terminal shows it at `drawnAt` (rich-js `drawnColour`). */
const shownAt =
  (drawnAt: ColorDepth) =>
  (c: ColorRgba): ColorRgba =>
    drawnColour(c, drawnAt);

/** A colour as truecolor shows it: composited over the terminal's black. */
const shownTrue = shownAt(ColorDepth.TRUECOLOR);

/**
 * The state colour of `hue` among `cells`: an open disclosure's trigger is
 * drawn here. The hue itself, as the palette names it, when it already stands
 * `STATE_FLOOR` off every cell — the enforcement is a floor, not a transform.
 * Otherwise the hue slid along its own OKLCH lightness, its angle and chroma
 * kept, the least distance that stands off every cell: toward white and toward
 * black in twelfths, a step each way in turn. Where no twelfth clears, the
 * colour standing furthest off its nearest cell as drawn: an end of the axis,
 * or the balance between two cells adjacent in luminance, which clears where
 * the twelfths stepped over a window between them. Cells that are dim take a
 * bright state and cells that are vivid a deep one, with no branch on which.
 *
 * The floor holds on what the terminal draws at `drawnAt`: at 256 colours the
 * trigger and every cell are rounded independently, and a trigger whose
 * rounding lands too near a rounded cell is replaced by the nearest drawn
 * colour that clears the floor against all of them (rich-js `ensureDrawn`).
 * A depth that draws no such colour clears no twelfth.
 *
 * [LAW:dataflow-not-control-flow] The candidates nearest first, one predicate,
 * the first that passes; the values decide, not a branch per theme.
 * [LAW:no-silent-failure] Cells no colour clears — a row turning between
 * textual-dark's navy and orange under `alt` — or no colour the depth draws
 * does — that row placed by `golden-angle`, at ansi — get that furthest
 * colour, and `short` says how far it stands as drawn, for the render to
 * report. It does not throw: the settings door is a trigger too, and a throw
 * there would leave no way to turn the setting back.
 */
export function stateFor(
  palette: Palette,
  hue: DecorHue,
  cells: readonly ColorRgba[],
  drawnAt: ColorDepth,
): StateSearch {
  return STATES(
    palette,
    `${hue}|${cells.map((c) => c.hex).join("+")}|${drawnAt}`,
    () => searchState(palette, hue, cells, drawnAt),
  );
}

// Memoised per palette like the band: a band's floors ask for the states of
// its neighbours at two depths, and the render walk asks for every band.
const STATES = memoPerPalette<StateSearch>();

function searchState(
  palette: Palette,
  hue: DecorHue,
  among: readonly ColorRgba[],
  drawnAt: ColorDepth,
): StateSearch {
  // Measured as drawn: a translucent colour is shown composited over the
  // terminal's black, and a raw-RGBA ratio reads a colour drawn nowhere.
  const cells = among.map(shownTrue);
  const pure = paletteRole(palette, hue);
  const black = new ColorRgba(0, 0, 0);
  const white = new ColorRgba(255, 255, 255);
  // The hue `t` of the way along its lightness toward an end of the axis: its
  // angle and chroma kept (as far as the gamut holds them near black and
  // white), so every candidate is still the theme's hue. Sliding toward the
  // theme's poles instead greyed the hue, and a slide past a pole cell by cell
  // undid itself on cells straddling the middle grey.
  const along = (end: ColorRgba, t: number): ColorRgba =>
    Oklch.fromRgba(pure)
      .mixAxes(Oklch.fromRgba(end), { l: t, c: 0, h: 0, alpha: 0 })
      .toRgba();
  const ray = (end: ColorRgba): ColorRgba[] =>
    Array.from({ length: STATE_STEPS }, (_, k) =>
      along(end, (k + 1) / STATE_STEPS),
    );
  const toBlack = ray(black);
  const candidates = [
    pure,
    // [LAW:no-defensive-null-guards] Both rays are one length by construction.
    ...ray(white).flatMap((c, k) => [c, toBlack[k]!]),
  ];
  // How far a colour stands off its nearest cell as the terminal draws both at
  // `depth`. No cell at all is nothing to stand off.
  const standsAt = (depth: ColorDepth): ((c: ColorRgba) => number) => {
    const shown = shownAt(depth);
    const drawn = cells.map(shown);
    return (c) =>
      Math.min(Infinity, ...drawn.map((cell) => contrastRatio(shown(c), cell)));
  };
  const standsTrue = standsAt(ColorDepth.TRUECOLOR);
  const standsAsDrawn = standsAt(drawnAt);
  // What the depth draws for `c` that stands STATE_FLOOR off every cell as
  // drawn: `c`, or the nearest colour the depth draws that does — none where
  // it draws no such colour, whichever `c` it starts from (rich-js
  // `ensureDrawn`).
  const drawnClear = (c: ColorRgba): ColorRgba | undefined =>
    ensureDrawn(c, drawnAt, (candidate, draw) =>
      cells.every(
        (cell) => contrastRatio(candidate, draw(cell)) >= STATE_FLOOR,
      ),
    );
  // A step clears in truecolor and as the depth draws it: where the depth
  // draws no colour that clears, it shows a step as the step's own rounding,
  // which can land on a cell.
  const clears = (c: ColorRgba): boolean =>
    standsTrue(c) >= STATE_FLOOR && drawnClear(c) !== undefined;
  // Between two cells adjacent in luminance, the colour standing furthest off
  // both is their balance: a contrast ratio multiplies, so the colour there
  // stands the root of their ratio off each, and no other cell comes nearer
  // to it — STATE_FLOOR off both exactly when the two stand STATE_FLOOR²
  // apart. A balance can fall between twelfths — rows an authored
  // distribution deals on textual-dark leave windows as narrow as .002 of
  // luminance between its navy and its orange — so it is found on the ray
  // toward it by halving: past it, the colour stands nearer the cell beyond
  // it than the one it left.
  // The ray is drawn in 8-bit steps that can be wider than half a window, so
  // both colours either side of the balance are offered.
  const aroundBalance = (
    lighter: ColorRgba,
    darker: ColorRgba,
  ): ColorRgba[] => {
    const leans = (c: ColorRgba): number =>
      contrastRatio(shownTrue(c), lighter) -
      contrastRatio(shownTrue(c), darker);
    const end = leans(pure) < 0 ? black : white;
    // Darkening, the colour leans further toward standing off the lighter
    // cell; lightening, the reverse.
    const way = end === black ? 1 : -1;
    let [near, far] = [0, 1];
    for (let i = 0; i < BALANCE_HALVINGS; i++) {
      const t = (near + far) / 2;
      if (way * leans(along(end, t)) > 0) far = t;
      else near = t;
    }
    return [along(end, near), along(end, far)];
  };
  const balances = (): ColorRgba[] => {
    const rising = [...cells].sort(
      (a, b) => relativeLuminance(a) - relativeLuminance(b),
    );
    // [LAW:no-defensive-null-guards] Each cell after the first has one below it.
    return rising
      .slice(1)
      .flatMap((lighter, i) => aroundBalance(lighter, rising[i]!));
  };
  // The least step that clears; where none does, the candidate standing
  // furthest off its nearest cell, the balances between cells among them: in
  // truecolor the furthest any colour stands is an end of the axis, which is a
  // step, or a balance, which clears exactly where two cells leave room
  // between them. It is measured as the terminal draws it, since where nothing
  // clears it is what the terminal shows: a balance sits between two cells,
  // and at 256 colours or ansi it rounds onto one of them where an end of the
  // axis does not.
  const chosen =
    candidates.find(clears) ??
    [...candidates, ...balances()].reduce((a, b) =>
      standsAsDrawn(b) > standsAsDrawn(a) ? b : a,
    );
  // [LAW:dataflow-not-control-flow] One path whichever was chosen: the depth
  // replaces it by the nearest colour it draws that clears every cell as
  // drawn, where one does, and the shortfall is measured on the pair the
  // terminal shows — never on truecolor's while the label names the depth.
  const state = drawnClear(chosen) ?? chosen;
  const stands = standsAsDrawn(state);
  return {
    anchor: chosen,
    state,
    short: stands >= STATE_FLOOR ? null : stands,
  };
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
  return POLE_TEXT(palette, `${background.hex}|${drawnAt}`, () => {
    const side = contrastFor(background);
    const pole = (["background", "foreground"] as const)
      .map((role) => paletteRole(palette, role))
      .reduce((best, pole) =>
        contrastRatio(side, pole) < contrastRatio(side, best) ? pole : best,
      );
    return legibleOn(palette, pole, background, drawnAt);
  });
}

// Every decorated cell of every render asks for its text, so the pole's choice
// is memoised ahead of the floor's: 2–3% of a render on the bundled bar.
const POLE_TEXT = memoPerPalette<ColorRgba>();

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
  return LEGIBLE(palette, `${text.hex}|${background.hex}|${drawnAt}`, () =>
    ensureContrast(text, background, TEXT_MIN_CONTRAST, drawnAt),
  );
}

// Every cell of every render asks for its text, and the answer is a pure
// function of (text, background, drawnAt) — a bisection when the text misses
// the floor, measured at 20% of a render before this memo. A palette's distinct
// backgrounds are its shades, band colours, and the stops its authored ramps
// reach, so each map stays as small as the colours a bar can wear.
const LEGIBLE = memoPerPalette<ColorRgba>();

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
 * an item of a band — a tab, a picker's control — among what it is drawn
 * beside there: that band's plane, and its state, which the ✕ leading the
 * trigger's row wears (b9w: held off the plane alone, the open first tab and
 * the ✕ beside it were drawn ΔE under .04 apart — joined by the joiner's
 * divider — on 1,798 of 80,040 bundled bands in truecolor, the default
 * theme's among them). Held off the bar's row as well, a nested state was
 * driven to the same end of the lightness axis as its parent's on a row of
 * vivid shades, and the two collapsed into one; held off nothing, it could
 * sit on the plane it stands on. The state is the one the ✕ is DRAWN in: at
 * 256 colours and ansi the parent's search repairs its state, which then
 * rounds elsewhere than its anchor does, and held off the anchor's rounding
 * the open trigger drew in the ✕'s own colour (95 open settings menus at
 * ansi). The plane is the unrounded one, since the drawn plane's repair reads
 * the state of the trigger nested in it (`planeFloors`).
 */
function standsAmong(
  palette: Palette,
  disclosure: Disclosure,
  drawnAt: ColorDepth,
): readonly ColorRgba[] {
  return disclosure.depth === 0
    ? groundCells(palette, disclosure.ground)
    : [
        ...enclosingPlane(palette, disclosure, drawnAt),
        searchOf(
          palette,
          { ...disclosure, depth: disclosure.depth - 1 },
          drawnAt,
        ).state,
      ];
}

// The plane of the band `disclosure` hangs in, before `drawnAt` rounds it: none
// for a bar trigger's band (the bar is no band), the plane one depth up
// otherwise.
const enclosingPlane = (
  palette: Palette,
  disclosure: Disclosure,
  drawnAt: ColorDepth,
): readonly ColorRgba[] =>
  disclosure.depth === 0
    ? []
    : [
        unroundedBand(
          palette,
          { ...disclosure, depth: disclosure.depth - 1 },
          drawnAt,
        ).plane,
      ];

// [LAW:one-source-of-truth] The state search of the trigger that opens the band
// `disclosure`: the band's own state, the anchor its plane and items are
// blended from, and — one depth down — the state a trigger open inside it wears.
const searchOf = (
  palette: Palette,
  disclosure: Disclosure,
  drawnAt: ColorDepth,
): StateSearch =>
  stateFor(
    palette,
    hueAtDepth(disclosure.hue, disclosure.depth),
    standsAmong(palette, disclosure, drawnAt),
    drawnAt,
  );

/** The band a trigger standing in `disclosure`'s band opens: one depth further. */
const nestedIn = (disclosure: Disclosure): Disclosure => ({
  ...disclosure,
  depth: disclosure.depth + 1,
});

/** The line the render reports for a state that stands short of its floor, if it does. */
const stateShortfall = (
  palette: Palette,
  disclosure: Disclosure,
  { short }: StateSearch,
  drawnAt: ColorDepth,
): readonly string[] =>
  short === null
    ? []
    : [
        `theme "${palette.name}": no open-trigger colour stands ${STATE_FLOOR}:1 off every cell beside it — the nearest stands ${short.toFixed(2)}:1 as drawn at depth ${ColorDepth[drawnAt]}; ${STATE_REMEDY[disclosure.depth === 0 ? "bar" : "band"]} clears it`,
      ];
// What clears a state's shortfall, by where its trigger stands. A bar
// trigger stands among its row, which the shade and variation deal. A trigger
// in a band stands among that band's plane and ✕, which the variation moves
// less: of the 128 nested shortfalls over every bundled theme, style,
// variation and shade (truecolor and 256 colours), another shade or another
// style cleared every one, another variation 48.
const STATE_REMEDY = {
  bar: "another shade or variation",
  band: "another shade or style",
} as const;

/**
 * The line the render reports for a plane standing too near the trigger that
 * opened it to be told from it, if it does — the floor whose miss leaves the
 * band's items no colour between the two (`bandItemFor`). Every bundled theme
 * holds it under the `none` style at every depth a bundled menu reaches
 * (audits/decor-registry.audit.ts), so a style clears it.
 */
const planeShortfall = (
  palette: Palette,
  apart: number,
  drawnAt: ColorDepth,
): readonly string[] =>
  apart >= BAND_FLOORS.triggerPlane
    ? []
    : [
        `theme "${palette.name}": an open band's plane stands ΔE ${apart.toFixed(3)} off the trigger that opened it as drawn at depth ${ColorDepth[drawnAt]}, under the ${BAND_FLOORS.triggerPlane} that tells them apart; another style clears it`,
      ];

/**
 * How far a band's plane recedes from its state colour toward `background`:
 * `base + perDepth × depth`, capped — and where that plane breaks a band floor,
 * toward `foreground`, then either as far as the cap (`computeUnroundedBand`).
 * Two cues move with depth — the hue advances and the plane recedes. Past the
 * cap the recession stops moving (only 0.05 lies between depths 2 and 3, and
 * `hueAtDepth` has wrapped onto a hue already used), so from there the plane
 * search's twelfths keep adjacent planes apart; `audits/decor-registry.audit.ts` pins the
 * depths the bundled menu reaches (door → tab → ⚙ → list, 0–3).
 */
export const BAND_RECESSION = {
  base: 0.42,
  perDepth: 0.14,
  cap: 0.75,
} as const;

/**
 * How far above its plane, as a fraction of the plane→state axis, a band's
 * low item stands: off the plane, which a dropped menu line sits on, by a
 * margin, and as far from the state as the axis allows, so the high item has
 * room between them (`bandFor`).
 */
export const BAND_ITEM_FLOOR = 0.12;

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
 * the depths a bar reaches (0–3) in truecolor by the construction below —
 * `audits/decor-registry.audit.ts` measures every lineage against them — and `bandFor`
 * holds each one again on the colours drawn at 256 and ansi. A nested trigger is held off the
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
 * toward `background` (`computeUnroundedBand`).
 */
export interface BandColours {
  readonly state: ColorRgba;
  readonly plane: ColorRgba;
}

/** A band as the terminal draws it, and the floors it stands short of. */
export interface Band extends BandColours {
  /**
   * The two colours a band's items wear, low then high: each stands
   * `SEAM_MIN_DELTA_E` off the other, off `state` (the ✕ that leads each of the
   * band's rows) and off the state of a trigger open in the band, as drawn —
   * the four colours a band row draws beside one another — so the joiner
   * draws a filled arrow between any two of them, never its divider. Where
   * the axis or the depth leaves no such colour, the band names the pair in
   * `shortfalls`. `bandItemFor` deals them alternately along a row.
   */
  readonly items: readonly [ColorRgba, ColorRgba];
  /**
   * One line per floor the band stands short of as drawn, for the render to
   * report where its trigger opens: `state` off the ground its lineage's
   * trigger stands on (STATE_FLOOR, `StateSearch`), `plane` off `state`
   * (BAND_FLOORS.triggerPlane), and each seam opening it draws (`drawnSeams`:
   * its ✕ and items, and its state beside the enclosing band's) closer than
   * `SEAM_MIN_DELTA_E`. Empty when it clears them all, and at a depth that
   * draws no colour.
   */
  readonly shortfalls: readonly string[];
}

/**
 * The band `disclosure` opens. One expression for every depth: the state of
 * the depth-advanced hue, and that state pulled toward `background` by the
 * depth's recession. The trigger of the band and the band itself are the SAME
 * value read twice, so they cannot disagree about which hue they share.
 *
 * Both colours are the ones the terminal draws at `drawnAt`: the state is
 * `stateFor`'s at that depth, and a plane whose rounding breaks a
 * `BAND_FLOORS` distance its unrounded colours kept is replaced by the
 * nearest drawn colour that keeps it (`ensureDrawn`). A distance the
 * unrounded band itself misses is not one rounding broke, so it is not asked
 * of the drawn colours either.
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
  return BANDS(palette, `${disclosureKey(disclosure)}|${drawnAt}`, () => {
    const search = searchOf(palette, disclosure, drawnAt);
    const { state } = search;
    // The plane is the unrounded plane as drawn — rounded once, from the anchor
    // the state is drawn from, never blended from a state already rounded.
    // The search of a trigger open in this band — once, read by the plane's
    // floors, the items and the seams alike.
    const nested = searchOf(palette, nestedIn(disclosure), drawnAt);
    const floors = planeFloors(palette, disclosure, state, nested, drawnAt);
    const plane = ensureDrawn(
      unroundedBand(palette, disclosure, drawnAt).plane,
      drawnAt,
      (candidate, drawn) => floors.every((holds) => holds(candidate, drawn)),
    );
    // Never thrown, whatever the palette: every depth's table holds an entry
    // that keeps all three floors (test/decor.test.ts, "a band's drawn plane
    // always has a colour that keeps its floors"), and truecolor draws the
    // unrounded plane, which keeps them, since a floor is asked only where the
    // unrounded band kept it.
    if (plane === undefined) {
      throw new Error(
        `palette "${palette.name}": the ${disclosure.hue} band at depth ${disclosure.depth} cannot keep its floors on the colours drawn at depth ${ColorDepth[drawnAt]}`,
      );
    }
    const items = bandItems(
      palette,
      disclosure,
      { state, plane },
      nested,
      drawnAt,
    );
    const asDrawn = shownAt(drawnAt);
    return {
      state,
      plane,
      items,
      // No floor is measurable where nothing is drawn in colour (`none` draws
      // at DEFAULT, `drawnDepth`), so nothing there stands short of one.
      shortfalls:
        drawnAt === ColorDepth.DEFAULT
          ? []
          : [
              ...stateShortfall(palette, disclosure, search, drawnAt),
              ...planeShortfall(
                palette,
                deltaE(asDrawn(state), asDrawn(plane)),
                drawnAt,
              ),
              ...seamShortfalls(
                palette,
                drawnSeams(palette, disclosure, { state, items }, drawnAt),
                drawnAt,
              ),
            ],
    };
  });
}
const BANDS = memoPerPalette<Band>();

// [LAW:one-source-of-truth] The one spelling of a lineage as a memo key.
const disclosureKey = ({ hue, depth, ground }: Disclosure): string =>
  `${hue}|${depth}|${ground.map((e) => shadeRole(e.hue, e.shade)).join("+")}`;

/** ΔE in OKLab, the measure every floor in this module is stated in. [LAW:one-source-of-truth] The tests and audits import it rather than spell it. */
export const deltaE = (a: ColorRgba, b: ColorRgba): number =>
  Oklch.fromRgba(a).deltaE(Oklch.fromRgba(b));

// One seam a band row can draw: its two colours, and the words its shortfall
// line names them by.
interface Seam {
  readonly between: string;
  readonly a: ColorRgba;
  readonly b: ColorRgba;
}

/**
 * The seams opening the band `disclosure` puts on screen: its own ✕ (the
 * band's state, named its trigger) and two items, each beside the others,
 * and — for a band opened by a trigger inside another band — that trigger, in
 * this band's state, beside the enclosing band's ✕ and items. A band reports
 * an open trigger's seams only once one is open: it is the nested band that
 * opens then, so a band whose body holds no trigger reports none.
 */
const drawnSeams = (
  palette: Palette,
  disclosure: Disclosure,
  { state, items }: Pick<Band, "state" | "items">,
  drawnAt: ColorDepth,
): readonly Seam[] => {
  const row = (b: Pick<Band, "state" | "items">) =>
    [
      ["trigger", b.state],
      ["low item", b.items[0]],
      ["high item", b.items[1]],
    ] as const;
  const own = row({ state, items });
  const enclosing =
    disclosure.depth === 0
      ? []
      : row(
          bandFor(
            palette,
            { ...disclosure, depth: disclosure.depth - 1 },
            drawnAt,
          ),
        );
  return [
    ...own.flatMap(([na, a], i) =>
      own.slice(i + 1).map(([nb, b]) => ({
        between: `an open band's ${na} and ${nb}`,
        a,
        b,
      })),
    ),
    ...enclosing.map(([n, b]) => ({
      between: `a trigger open in a band and that band's ${n}`,
      a: state,
      b,
    })),
  ];
};

/**
 * One line per seam whose two colours stand too near, as drawn, for the
 * joiner to draw an arrow between them: below `SEAM_MIN_DELTA_E` it draws its
 * divider, and the two cells read as one.
 */
const seamShortfalls = (
  palette: Palette,
  seams: readonly Seam[],
  drawnAt: ColorDepth,
): readonly string[] => {
  const asDrawn = shownAt(drawnAt);
  return seams.flatMap(({ between, a, b }) => {
    const apart = deltaE(asDrawn(a), asDrawn(b));
    return apart >= SEAM_MIN_DELTA_E
      ? []
      : [
          `theme "${palette.name}": ${between} stand ΔE ${apart.toFixed(3)} apart as drawn at depth ${ColorDepth[drawnAt]}, under the ${SEAM_MIN_DELTA_E} below which two cells in those colours are joined by a divider and read as one`,
        ];
  });
};

/**
 * A band's two item colours (`Band.items`). Unrounded, low stands
 * `BAND_ITEM_FLOOR` above the plane, and high is the colour on the ray from
 * low to the state standing furthest off the nearest of low, the state and
 * the open trigger — the colours an item is drawn beside — so its seams are
 * as wide as the axis allows. At 256 colours and ansi, an item whose rounding
 * stands under `SEAM_MIN_DELTA_E` off another colour of the row, or is the
 * plane, is replaced by the nearest entry that holds (`ensureDrawn`); truecolor
 * draws each where it lies. Where neither holds, `seamShortfalls` names the
 * pair.
 */
function bandItems(
  palette: Palette,
  disclosure: Disclosure,
  drawnBand: Pick<Band, "state" | "plane">,
  nested: StateSearch,
  drawnAt: ColorDepth,
): readonly [ColorRgba, ColorRgba] {
  const unrounded = unroundedBand(palette, disclosure, drawnAt);
  const low = blendRgb(unrounded.plane, unrounded.state, BAND_ITEM_FLOOR);
  const high = furthestAlong(low, unrounded.state, [nested.anchor]);
  const seen =
    (others: readonly ColorRgba[]) =>
    (candidate: ColorRgba, drawn: (c: ColorRgba) => ColorRgba): boolean =>
      candidate.hex !== drawn(drawnBand.plane).hex &&
      others.every(
        (other) => deltaE(candidate, drawn(other)) >= SEAM_MIN_DELTA_E,
      );
  // [LAW:no-silent-failure] Where the depth draws no colour that stands off
  // the rest, the item is drawn at its place — as drawn, like every colour
  // `ensureDrawn` returns — and `seamShortfalls` reports the pair it stands
  // too near.
  const asDrawn = shownAt(drawnAt);
  const beside = [drawnBand.state, nested.state];
  const drawnLow = ensureDrawn(low, drawnAt, seen(beside)) ?? asDrawn(low);
  const drawnHigh =
    ensureDrawn(high, drawnAt, seen([...beside, drawnLow])) ?? asDrawn(high);
  return [drawnLow, drawnHigh];
}

// The colour on the ray from `from` to `to` standing furthest (ΔE, in
// truecolor) off the nearest of `from`, `to` and `besides`. The ray is drawn in
// 8-bit steps, so one sample per step of its widest channel visits every
// colour it draws — on textual-dark, whose state the search carries to black,
// there are eight.
function furthestAlong(
  from: ColorRgba,
  to: ColorRgba,
  besides: readonly ColorRgba[],
): ColorRgba {
  const ends = [from, to, ...besides].map((c) => Oklch.fromRgba(shownTrue(c)));
  const stands = (c: ColorRgba): number => {
    const at = Oklch.fromRgba(shownTrue(c));
    return Math.min(...ends.map((end) => at.deltaE(end)));
  };
  const steps = Math.max(
    1,
    Math.abs(to.red - from.red),
    Math.abs(to.green - from.green),
    Math.abs(to.blue - from.blue),
  );
  let best = from;
  let bestStands = 0;
  for (let i = 0; i <= steps; i++) {
    const candidate = blendRgb(from, to, i / steps);
    const s = stands(candidate);
    if (s > bestStands) [best, bestStands] = [candidate, s];
  }
  return best;
}

// The band before `drawnAt` rounds it — its state the anchor the search settled
// on at that depth (`StateSearch`), the colours that depth rounds from, and the
// pair whose floors decide which floors a drawn band is held to. Where a
// twelfth clears in truecolor and as each depth draws it, every depth settles
// on it, and so on one band.
function unroundedBand(
  palette: Palette,
  disclosure: Disclosure,
  drawnAt: ColorDepth,
): BandColours {
  return UNROUNDED_BANDS(
    palette,
    `${disclosureKey(disclosure)}|${drawnAt}`,
    () => computeUnroundedBand(palette, disclosure, drawnAt),
  );
}
// Memoised beside the drawn bands: every band's floors and every band item
// round from it, so the render walk asks for it once per item.
const UNROUNDED_BANDS = memoPerPalette<BandColours>();

function computeUnroundedBand(
  palette: Palette,
  disclosure: Disclosure,
  drawnAt: ColorDepth,
): BandColours {
  const { anchor: state } = searchOf(palette, disclosure, drawnAt);
  const recession = Math.min(
    BAND_RECESSION.cap,
    BAND_RECESSION.base + BAND_RECESSION.perDepth * disclosure.depth,
  );
  // The plane recedes into the background, as a band always has — or, where
  // that plane would stand too near its trigger or the plane it hangs in (a
  // state the search carried to the background to stand off a row of vivid
  // shades), into the foreground, then into either as far as the cap, then
  // the twelfth of the way to either pole nearest the depth's recession: the
  // first that holds the band's floors, and the background where none does.
  // The twelfths are what keep a deep band off the plane it hangs in once the
  // cap leaves two depths' recessions a hair apart (the settings menu's ⚙ →
  // style list is depth 3), by receding it less.
  const into = (pole: ThemePole, amount: number): ColorRgba =>
    blendRgb(state, paletteRole(palette, pole), amount);
  const enclosing = enclosingPlane(palette, disclosure, drawnAt);
  const holds = (plane: ColorRgba): boolean =>
    deltaE(shownTrue(state), shownTrue(plane)) >= BAND_FLOORS.triggerPlane &&
    enclosing.every(
      (outer) =>
        deltaE(shownTrue(outer), shownTrue(plane)) >= BAND_FLOORS.nestedPlane,
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
        ...PLANE_STEPS.toSorted(
          (a, b) => Math.abs(a - recession) - Math.abs(b - recession),
        ).flatMap((amount) => [
          into("background", amount),
          into("foreground", amount),
        ]),
      ].find(holds) ?? intoBackground,
  };
}

// Every twelfth of the way from a state to a pole, the fine end of the plane
// search above.
const PLANE_STEPS = Array.from({ length: 12 }, (_, i) => (i + 1) / 12);

// A floor a band's drawn plane must hold: true when `candidate`, already drawn,
// holds it against the neighbour `drawn` shows it beside.
type PlaneFloor = (
  candidate: ColorRgba,
  drawn: (c: ColorRgba) => ColorRgba,
) => boolean;

// What a band's plane must hold as drawn, each a floor its unrounded colours
// already hold, and none where they missed it: off its own trigger (ΔE),
// under the trigger of the band nested in it — which stands STATE_FLOOR off
// the plane it sits on — and, below depth 0, whose enclosing surface is the
// bar and the state floor's to keep, off the plane it is nested in (ΔE).
function planeFloors(
  palette: Palette,
  disclosure: Disclosure,
  state: ColorRgba,
  nested: StateSearch,
  drawnAt: ColorDepth,
): readonly PlaneFloor[] {
  const { hue, depth, ground } = disclosure;
  // Read from the band before any repair (`unroundedBand`), so no floor asks
  // `bandFor` for the band it is computing.
  const unroundedState = (d: number): ColorRgba =>
    unroundedBand(palette, { hue, depth: d, ground }, drawnAt).state;
  const unroundedPlane = (d: number): ColorRgba =>
    unroundedBand(palette, { hue, depth: d, ground }, drawnAt).plane;
  const plane = unroundedPlane(depth);
  const keptApart = (floor: number, other: ColorRgba): number =>
    deltaE(shownTrue(plane), shownTrue(other)) >= floor ? floor : 0;
  const keptUnder =
    contrastRatio(shownTrue(plane), shownTrue(nested.anchor)) >= STATE_FLOOR
      ? STATE_FLOOR
      : 0;
  const apart =
    (other: ColorRgba, floor: number): PlaneFloor =>
    (candidate, drawn) =>
      deltaE(candidate, drawn(other)) >= floor;
  return [
    apart(state, keptApart(BAND_FLOORS.triggerPlane, unroundedState(depth))),
    (candidate, drawn) =>
      contrastRatio(candidate, drawn(nested.state)) >= keptUnder,
    ...(depth > 0
      ? [
          apart(
            bandFor(palette, { hue, depth: depth - 1, ground }, drawnAt).plane,
            keptApart(BAND_FLOORS.nestedPlane, unroundedPlane(depth - 1)),
          ),
        ]
      : []),
  ];
}

/**
 * The colour of the item `place` places in the band `disclosure` opens: one of
 * the band's two `items`, picked by that step as the bar's cell picks its
 * shade (`decorEntryFor`) — one placement mechanism at every level. Over two
 * items `inBin` is a van der Corput placement's parity, so consecutive cells
 * of a row alternate whatever its length; a picker's option is one step, its
 * index over the WHOLE option domain, so paging never recolours it; an absent
 * step (a body that is one segment) is placed where a first child is. Like a
 * bar cell's, an item's colour is a function of its place: a sibling hiding
 * recolours nobody, so the two cells either side of a hidden one, or
 * neighbours an authored distribution places in one bin, wear one item and are
 * joined by the joiner's divider.
 */
export function bandItemFor(
  palette: Palette,
  disclosure: Disclosure,
  place: PlacedStep | undefined,
  drawnAt: ColorDepth,
): ColorRgba {
  return vocabularySelect(
    bandFor(palette, disclosure, drawnAt).items,
    place,
    inBin,
  );
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

// [LAW:one-source-of-truth] Whether two regions are one place: the same arm,
// the same decor or band, and the same address step for step — so whatever is
// dealt one of them (`decorationFor`) is dealt the other.
export function sameRegion(a: Region, b: Region): boolean {
  switch (a.kind) {
    case "bar":
      return b.kind === "bar" && sameBarRegion(a, b);
    case "band":
      return b.kind === "band" && sameBandRegion(a, b);
  }
}

const sameAddress = sameEach(
  sameBy<AddressStep>({ index: is, count: is, distribution: is, axis: is }),
);

export const sameDecor = sameBy<Decor>({ variation: is, shade: is });

// Whether two disclosures are one band: one hue, at one depth, on one ground.
export const sameDisclosure = sameBy<Disclosure>({
  hue: is,
  depth: is,
  ground: sameEach(sameBy<DecorEntry>({ hue: is, shade: is })),
});

const sameBarRegion = sameBy<Extract<Region, { kind: "bar" }>>({
  kind: is,
  decor: sameDecor,
  address: sameAddress,
});

const sameBandRegion = sameBy<Extract<Region, { kind: "band" }>>({
  kind: is,
  band: sameDisclosure,
  address: sameAddress,
});

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
      // Read where the segment opens a band (`bandFor`), once: a closed cell
      // never reads it, and reading every cell's row for every cell cost 2–3%
      // of a closed bar's render.
      let ground: Ground | undefined;
      return {
        tint,
        text: decor.shade.text(palette, entry.hue, tint, drawnAt),
        disclosure: {
          hue: OPEN_HUE,
          depth: 0,
          get ground() {
            return (ground ??= rowGround(decor, address));
          },
        },
      };
    }
    case "band": {
      const { band, address } = region;
      // [LAW:one-source-of-truth] A band item is placed by its cell, read as
      // the bar reads one (`rowAndCell`): whatever is nested in a cell — edit
      // chrome's unit around each content cell of a user's body — wears that
      // cell's item, and a row picks nothing, so a one-cell row and edit
      // chrome's wrapping of it are both a first cell.
      const tint = bandItemFor(
        palette,
        band,
        rowAndCell(address).cell,
        drawnAt,
      );
      return {
        tint,
        text: textOn(palette, tint, drawnAt),
        disclosure: { ...band, depth: band.depth + 1 },
      };
    }
  }
}

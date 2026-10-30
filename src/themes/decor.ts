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
// in the tree. An open menu selects the same way: the segment that opened it
// wears its hue at the shade the dial names for the activated state, and its
// rows sit on the theme's `surface`. Every background the bar draws is one its
// palette names: it SELECTS from the theme; it never synthesises a colour.
//
// [LAW:effects-at-boundaries] Pure. No renderer wiring, no I/O, no traversal
// state: any node's colour is computable from its address alone, without
// visiting any other node. [LAW:one-way-deps] A leaf of the themes module — it
// imports only its memo and rich-js, which owns every colour operation used
// (`ensureContrast`, `contrastFor`, `contrastRatio`, all for text);
// cc-candybar keeps the POLICY (which roles, which shades, which address
// formula) and no colour arithmetic of its own.

import {
  contrastFor,
  contrastRatio,
  ensureContrast,
  type ColorDepth,
  type ColorRgba,
  type Palette,
} from "@promptctl/rich-js";
import { memoPerPalette } from "./palette-memo.js";
import { is, sameBy, sameEach } from "../utils/same.js";

// --- The vocabulary -----------------------------------------------------------

/**
 * The three non-semantic root hues. `error`/`success`/`warning` are deliberately NOT
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
 * a cell's place in its row selects them (`vocabularySelect` over this list,
 * read with the position's own `quantize` rule), and how text is chosen on
 * them. A position of one shade is a uniform row. A band's items wear the
 * same position of the dial, in the band's hue (`bandFor`).
 */
export interface Shade {
  readonly tones: readonly [RoleShade, ...RoleShade[]];
  readonly text: DecorText;
  /**
   * How a cell's placement picks among `tones`: the rule under which van der
   * Corput's neighbours never land on one tone — `point` over three tones,
   * `bin` over two (`inBin`, `nearestPoint`). [LAW:dataflow-not-control-flow]
   * A value in the row, not a branch on the tone count.
   */
  readonly quantize: QuantizeName;
  /**
   * The shade a pressed button wears at this position: the segment whose menu
   * is open, and the ✕ and blank leads of that menu's rows, in the menu's hue
   * (`bandFor`). Textual's flat buttons wear their role's muted form, so a
   * window of the ladder's rungs presses into it; a row already muted
   * presses into the role's second lightening, a rung that row never deals,
   * so the pressed button stands out of it. [LAW:dataflow-not-control-flow]
   * A value in the row, so a new position states its own.
   */
  readonly activated: RoleShade;
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
  quantize: "point",
  activated: "muted",
});

/**
 * A window of rungs `apart` rungs each side of the role itself, the role in
 * the middle (listed low, high, middle, as `ladderWindow` is): a wider jump
 * between neighbouring cells than the ladder's one rung.
 */
const centredWindow = (apart: number): Shade => ({
  // [LAW:no-defensive-null-guards] The role is rung 3 of seven; a window up to
  // three rungs each side stays on the ladder.
  tones: [LADDER[3 - apart]!, LADDER[3 + apart]!, LADDER[3]!],
  text: poleText,
  quantize: "point",
  activated: "muted",
});

/**
 * Two rungs `apart` rungs each side of the role, and never the role itself:
 * every neighbouring pair of cells jumps the whole width (`inBin` alternates
 * two tones strictly, whatever the row's length).
 */
const pairWindow = (apart: number): Shade => ({
  tones: [LADDER[3 - apart]!, LADDER[3 + apart]!],
  text: poleText,
  quantize: "bin",
  activated: "muted",
});

// Trial jumps (brandon-menus-sjhy.4fi, "a bigger jump in color between
// sequential segments"): the role's window widened to two and three rungs each
// side, and the strict two-tone pairs at those widths. Positions of the dial
// like any other, offered in the settings menu's 🧪 trials beside the dial
// rather than on it.
const TRIAL_SHADES = {
  wide: centredWindow(2),
  widest: centredWindow(3),
  pair: pairWindow(2),
  "pair-wide": pairWindow(3),
} as const satisfies Record<string, Shade>;
export const TRIAL_SHADE_NAMES = Object.keys(TRIAL_SHADES) as ReadonlyArray<
  keyof typeof TRIAL_SHADES
>;

/**
 * [LAW:one-type-per-behavior] The shade dial: every position a user can turn
 * it to, lowest first (candybar-theme-colours-6fq5.e5n). The window of three
 * rungs slides up the ladder from the role's deepest shades to its brightest,
 * and `middle` — centred on the role itself — is where it rests. Below the
 * deepest window the dial reaches `muted`: every cell of a row in the role's
 * muted form under the role's own text, one colour per row, its cells parted
 * by the joiner's divider. A new position is one row here: the option domain,
 * the loader's enum and the settings control derive from this table, and the
 * row names what a pressed button wears there.
 */
export const SHADES = {
  muted: {
    tones: ["muted"],
    text: roleText,
    quantize: "point",
    activated: "lighten-2",
  },
  deepest: ladderWindow(0),
  deeper: ladderWindow(1),
  middle: ladderWindow(2),
  brighter: ladderWindow(3),
  brightest: ladderWindow(4),
  ...TRIAL_SHADES,
} as const satisfies Record<string, Shade>;
export type ShadeName = keyof typeof SHADES;

/**
 * The hue an open menu wears at each depth of a lineage, cycling: the bar
 * trigger's band wears the first, a menu opened inside it the second, and so
 * on round the list. A one-hue lineage keeps one hue however deep it nests;
 * the items of every band are shades of their own band's hue, so the hue a
 * menu's header wears is the hue its items vary (brandon-menus-sjhy.4fi).
 */
export type Lineage = readonly [DecorHue, ...DecorHue[]];

/** The hue the band `depth` deep in `lineage` wears. */
export const lineageHue = (lineage: Lineage, depth: number): DecorHue =>
  // [LAW:no-defensive-null-guards] A lineage is non-empty by type and the
  // index is in range by construction; the `!` states that, it does not guard it.
  lineage[depth % lineage.length]!;

/**
 * A place along a drawn line that a variation may single out for the keystone
 * hue: the bar's first cell (the settings door under the default placement),
 * the first cell of every line, the last cell of every line. Read off a cell's
 * authored place on its row's line, as its shade is, so hiding a cell moves no
 * keystone — a hidden last cell leaves its line's end bare.
 */
export type Keystone = "bar-start" | "line-start" | "line-end";

/**
 * The hue a keystone wears: Textual's `accent`, "used sparingly to draw
 * attention" (brandon-menus-sjhy: "keystone segments in the accent color").
 */
export const KEYSTONE_HUE = "accent" satisfies DecorHue;

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
  /**
   * The places along each line whose cell wears `KEYSTONE_HUE` instead of the
   * row's stepped hue, at the shade its place deals it like any cell. Empty is
   * a variation with no keystones.
   */
  readonly keystones: readonly Keystone[];
  /** The hue each depth of a menu opened from this bar wears. */
  readonly open: Lineage;
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

// The menus the shipped variations open: `accent` on the bar, then each depth
// the next of DECOR_HUES, wrapping — and no keystones.
const OPENS_TODAY = {
  keystones: [],
  open: ["accent", "primary", "secondary"],
} as const satisfies Pick<Variation, "keystones" | "open">;

/** The keystone placements a candidate tuning puts the accent on, by name. */
const KEYSTONE_PLACEMENTS = {
  door: ["bar-start"],
  start: ["line-start"],
  end: ["line-end"],
  ends: ["line-start", "line-end"],
} as const satisfies Record<string, readonly Keystone[]>;

/** The lineages a candidate tuning opens its menus in, by name — none reaches the accent. */
const OPEN_LINEAGES = {
  primary: ["primary"],
  secondary: ["secondary"],
  alternate: ["primary", "secondary"],
} as const satisfies Record<string, Lineage>;

type TuningName =
  `${keyof typeof KEYSTONE_PLACEMENTS}-${keyof typeof OPEN_LINEAGES}`;

// Every keystone placement under every lineage: `door-primary`, `ends-alternate`, …
// Trial tunings of the accent variation (brandon-menus-sjhy.4fi): offered in
// the settings menu's 🧪 trials beside the variation's own control.
function tunings(): Record<TuningName, Variation> {
  const rows = Object.entries(KEYSTONE_PLACEMENTS).flatMap(([at, keystones]) =>
    Object.entries(OPEN_LINEAGES).map(
      ([into, open]) =>
        [
          `${at}-${into}`,
          { hues: ["secondary"], run: WHOLE_ROW, keystones, open },
        ] as const,
    ),
  );
  return Object.fromEntries(rows) as unknown as Record<TuningName, Variation>;
}

const TUNINGS = tunings();

/**
 * [LAW:one-type-per-behavior] Every variation a user can choose, named by
 * the roles it steps through. A new one is one row here: the option domain,
 * the loader's enum and the settings carousel derive from this table. `alt` is variant C of 8fp ("base changes per cell, hue changes every
 * few cells"): the default's hues, turning every three cells along the row —
 * short enough that both rows of the bundled bar turn, long enough that a hue
 * holds across two seams before it does.
 */
export const VARIATIONS = {
  accent: { hues: ["secondary", "accent"], run: WHOLE_ROW, ...OPENS_TODAY },
  duo: { hues: ["primary", "secondary"], run: WHOLE_ROW, ...OPENS_TODAY },
  mono: { hues: ["primary"], run: WHOLE_ROW, ...OPENS_TODAY },
  alt: { hues: ["secondary", "accent"], run: 3, ...OPENS_TODAY },
  // Trial tunings of the accent variation (brandon-menus-sjhy.4fi): one row
  // per keystone placement and open-menu lineage. Every closed cell wears
  // `secondary` but the keystones, which wear the accent, and no depth of an
  // open menu wears it.
  ...TUNINGS,
} as const satisfies Record<string, Variation>;
export type VariationName = keyof typeof VARIATIONS;
export const TRIAL_VARIATION_NAMES = Object.keys(
  TUNINGS,
) as readonly TuningName[];

/**
 * How the closed bar wears its theme: the variation chooses each row's role,
 * the shade which of that role's shades each cell wears. Both are display
 * settings resolved per render, and the bar's Region carries them together.
 */
export interface Decor {
  readonly variation: Variation;
  readonly shade: Shade;
}

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
 * The theme's two poles: text is chosen from them (`textOn`), so it inverts
 * on its own between light and dark themes, with no branch.
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

/**
 * [LAW:one-source-of-truth] The two rules by name — the spelling a `Shade`
 * row carries, and a memo key can hold, where a function cannot.
 */
export const QUANTIZE = {
  bin: inBin,
  point: nearestPoint,
} as const satisfies Record<string, Quantize>;
export type QuantizeName = keyof typeof QUANTIZE;

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
 * A bar address read as the rows it stacks through, then its place on the
 * line of the innermost of them: the row it stands in is the LAST of those
 * rows, and its cell the LAST cell step — the compile places every node under
 * a row at its leaf's place on the row's line (`placeChildren` in
 * src/dsl/node-registry.ts), so the innermost is the node's own. An absent
 * step is a node alone on that axis — a bar with no vertical container, a
 * one-cell row — placed where a first child is.
 */
function rowAndCell(address: Address): {
  readonly row: AddressStep | undefined;
  readonly cell: AddressStep | undefined;
} {
  const isCell = (step: AddressStep): boolean => step.axis === "cell";
  const at = address.findIndex(isCell);
  const rows = at === -1 ? address : address.slice(0, at);
  return { row: rows.at(-1), cell: address.findLast(isCell) };
}

/** The step of the variation a row starts on: the bin its placement falls in. */
const rowStart = (variation: Variation, row: AddressStep | undefined): number =>
  inBin(placementOf(row), variation.hues.length);

/**
 * The decorative entry a bar node's address selects under `decor`: the last
 * of the rows it stacks through chooses the hue the row starts on, so a row
 * stacked above the whole bar (edit mode's reset banner) recolours no row
 * beneath it; the cell chooses the shade, and its index how many of the
 * variation's runs it has passed along the row. A cell is a leaf of its row,
 * however the row nests it: the leaves of an authored `{ h }` inside a row
 * sit side by side with the row's other cells, so each takes its own place
 * on the line and they differ as any neighbours do. A `{ v }` inside a row
 * draws its first child on the row's line and each other on a line of its
 * own, each starting at the place the `{ v }` sits. Edit mode's chrome is
 * spliced in as one unit with the cell it edits, so all of it wears that
 * cell's place and entering edit mode recolours nothing. A cell's place is
 * counted in the tree the walk renders — authored, never what is visible, so
 * hiding one recolours none — and a synthesized cell counts like an authored
 * one: the settings door leading the first row takes that row's first place,
 * and its frame-rate cell the next.
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
  // The row starts on its own step and advances one step per run along it, a
  // keystone place wears the keystone hue instead, and the cell's place picks
  // its shade.
  const { hues, run, keystones } = decor.variation;
  const turn = cell === undefined ? 0 : Math.floor(cell.index / run);
  const stepped = hues[(rowStart(decor.variation, row) + turn) % hues.length];
  if (stepped === undefined) throw new Error("decorEntryFor: empty variation");
  return {
    hue: keystones.some((at) => KEYSTONE_AT[at](row, cell))
      ? KEYSTONE_HUE
      : stepped,
    shade: vocabularySelect(
      decor.shade.tones,
      cell,
      QUANTIZE[decor.shade.quantize],
    ),
  };
}

// Whether a cell stands at a keystone place, read off its authored place on
// its row's line: the line's last place is the last leaf the row lays, through
// any group nested in it. A node alone on an axis (an absent step) is that
// axis's first child and its last. [LAW:dataflow-not-control-flow] One
// predicate per place, in a table the variation's list indexes.
const KEYSTONE_AT: Record<
  Keystone,
  (row: AddressStep | undefined, cell: AddressStep | undefined) => boolean
> = {
  "bar-start": (row, cell) =>
    (row?.index ?? 0) === 0 && (cell?.index ?? 0) === 0,
  "line-start": (_row, cell) => (cell?.index ?? 0) === 0,
  "line-end": (_row, cell) =>
    cell === undefined || cell.index === cell.count - 1,
};

/**
 * The ground an open menu's rows sit on, at every depth of nesting: Textual's
 * `surface`, the theme's own colour for the panels its widgets are laid on.
 */
export const PLANE_ROLE = "surface";

/** A palette entry decoration reads: a pole, an alert, a role at a shade, a role's text, or the plane. */
export type DecorRole =
  | ThemePole
  | SemanticRole
  | ShadeRole
  | `text-${DecorHue}`
  | typeof PLANE_ROLE;

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
 * place an entry becomes a colour — `decorFor` renders a closed cell through
 * it and `bandFor` a menu's items.
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

// --- Text ----------------------------------------------------------------------

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
 * Where a disclosure sits in the colour model: the bar's decor — whose
 * variation's lineage names the hue each depth wears, and whose shade is the
 * window its items are dealt from and the shade its trigger presses into —
 * and how many bands deep it is. `depth` 0 is a bar cell's own band, opened in
 * the lineage's first hue; a disclosure opened from inside that band is depth
 * 1, and so on. The address never enters here — a band is NOT a tree
 * position, it is a plane hung under a trigger.
 */
export interface Disclosure {
  readonly decor: Decor;
  readonly depth: number;
}

/** The hue the band `disclosure` wears: its depth along its variation's lineage. */
export const hueOf = ({ decor, depth }: Disclosure): DecorHue =>
  lineageHue(decor.variation.open, depth);

/**
 * The colours a band's items wear: its hue at every tone of the dial's
 * window, as the palette names each — the same entries a bar row wears in
 * its row's hue, so a menu's items are a variation on the colour of the
 * header that opened it (Brandon, brandon-menus-sjhy.4fi), and no item is
 * a colour the theme does not name. In tone order, read by `bandItemFor`.
 */
export const bandEntries = (disclosure: Disclosure): readonly DecorEntry[] =>
  disclosure.decor.shade.tones.map((shade) => ({
    hue: hueOf(disclosure),
    shade,
  }));

/** The band a trigger standing in `disclosure`'s band opens: one depth further. */
const nestedIn = (disclosure: Disclosure): Disclosure => ({
  ...disclosure,
  depth: disclosure.depth + 1,
});

/**
 * A disclosure's band, every colour one its palette names. `state` is the
 * activated state — what the trigger that opened it wears, so a trigger is
 * drawn from what it OPENS, not from where it sits, and what the ✕ and the
 * blank leads of its rows wear; `plane` is the ground its rows sit on; `items`
 * are what the cells on that plane wear, one per tone of the dial's window
 * (`bandEntries`), which `bandItemFor` deals along a row by the window's own
 * rule, so neighbours differ by shade as the bar's do.
 */
export interface Band {
  readonly state: ColorRgba;
  readonly plane: ColorRgba;
  readonly items: readonly ColorRgba[];
}

/**
 * The band `disclosure` opens: the lineage's hue at its depth, at the shade
 * the dial names for the activated state, on the theme's `PLANE_ROLE`. The
 * trigger of the band and the band itself are the SAME value read twice, so
 * they cannot disagree about which hue they share.
 *
 * [LAW:one-source-of-truth] Selected, never searched: the colours are the
 * palette's own, unrounded, and the SGR writer rounds each once at the depth
 * it draws, as it does a closed cell's. Nothing here measures one colour
 * against another — text is chosen for its cell where it is drawn (`textOn`),
 * and the joiner owns every seam.
 */
export function bandFor(palette: Palette, disclosure: Disclosure): Band {
  return {
    state: paletteRole(
      palette,
      shadeRole(hueOf(disclosure), disclosure.decor.shade.activated),
    ),
    plane: paletteRole(palette, PLANE_ROLE),
    items: bandEntries(disclosure).map((entry) =>
      decorEntryColour(palette, entry),
    ),
  };
}

/**
 * The colour of the item `place` places in the band `disclosure` opens: one of
 * the band's `items`, picked by that step as the bar's cell picks its shade
 * (`decorEntryFor`), under the dial position's own rule — one placement
 * mechanism at every level, so a menu row walks its hue's window as a bar row
 * does. A picker's option is one step, its index over the WHOLE option
 * domain, so paging never recolours it; an absent step (a body that is one
 * segment) is placed where a first child is. Like a bar cell's, an item's
 * colour is a function of its place: a sibling hiding recolours nobody, so
 * the two cells either side of a hidden one, or neighbours an authored
 * distribution places on one tone, wear one item and are joined by the
 * joiner's divider.
 */
export function bandItemFor(
  palette: Palette,
  disclosure: Disclosure,
  place: PlacedStep | undefined,
): ColorRgba {
  return vocabularySelect(
    bandFor(palette, disclosure).items,
    place,
    QUANTIZE[disclosure.decor.shade.quantize],
  );
}

/**
 * A band item as it is drawn: its colour (`bandItemFor`) and the text the
 * dial pairs with that shade. [LAW:one-source-of-truth] What a segment placed
 * in the band and an option a picker lays in it both wear, so neighbouring
 * items of one menu read alike.
 */
export function bandItem(
  palette: Palette,
  disclosure: Disclosure,
  place: PlacedStep | undefined,
  drawnAt: ColorDepth,
): Pick<Decoration, "tint" | "text"> {
  const tint = bandItemFor(palette, disclosure, place);
  return {
    tint,
    text: disclosure.decor.shade.text(
      palette,
      hueOf(disclosure),
      tint,
      drawnAt,
    ),
  };
}

// --- Regions -------------------------------------------------------------------

/**
 * Where a node stands in the colour model (design doc, "The region model"):
 * on the BAR, where its address selects a vocabulary entry under the bar's
 * decor, or on a BAND — the plane a disclosure hung under its trigger — where
 * its address is the steps since that band's root and places it along the
 * band's axis. The band's `Disclosure` is the decor and depth its TRIGGER
 * computed; nothing about the trigger's own position enters, which is what
 * lets a body hang on its trigger and still be coloured without walk order
 * [LAW:types-are-the-program]. The decor rides the bar arm whole; a band
 * carries it inside its disclosure, whose lineage its colours are.
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

// Whether two disclosures are one band: one decor (so one lineage), at one depth.
export const sameDisclosure = sameBy<Disclosure>({
  decor: sameDecor,
  depth: is,
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
 * opens is the depth-0 band of the decor's lineage — every bar trigger opens
 * the same first hue, whatever row it stands in. On a band, the item is
 * placed by its address, its text is what the dial pairs with that shade, and
 * it OPENS the next band of the same lineage: one depth further — a natural
 * counted up from the band it stands on, never arithmetic back from a
 * position.
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
        disclosure: { decor, depth: 0 },
      };
    }
    case "band": {
      const { band, address } = region;
      // [LAW:one-source-of-truth] A band item is placed by its cell, read as
      // the bar reads one (`rowAndCell`): a leaf's place on its row's line,
      // through any group nested in the row — edit chrome's unit around each
      // content cell of a user's body shares that cell's place, so wears its
      // item — and a row picks nothing, so a one-cell row and edit chrome's
      // wrapping of it are both a first cell.
      return {
        ...bandItem(palette, band, rowAndCell(address).cell, drawnAt),
        disclosure: nestedIn(band),
      };
    }
  }
}

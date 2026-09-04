// The colour function: a node's ADDRESS in the layout tree selects one entry
// of the theme's own decorative vocabulary. Rationale, measurements and the
// rejected alternatives: design-docs/COLOUR-FROM-THEME-VOCABULARY.md.
//
// The rule: a segment's decorative background is `mix(base, themeHue, amount)`
// — both operands colours the theme already contains — with the entry chosen
// by the node's position in the tree. It SELECTS from the theme; it never
// synthesises a colour.
//
// [LAW:effects-at-boundaries] Pure. No renderer wiring, no I/O, no traversal
// state: any node's colour is computable from its address alone, without
// visiting any other node. [LAW:one-way-deps] A leaf of the themes module — it
// imports only rich-js, which owns the one colour operation used (`blendRgb`);
// cc-candybar keeps the POLICY (which roles, which amounts, which address
// formula) and no colour arithmetic of its own.

import { blendRgb, type ColorRgba, type Palette } from "@promptctl/rich-js";

// --- The vocabulary -----------------------------------------------------------

/**
 * The three non-semantic root hues. `error`/`success`/`warning` are
 * deliberately NOT here: decoration cannot collide with meaning because
 * meaning is not in the set — strictly stronger than hue-anchoring, which
 * only stopped the semantic colours from moving while leaving decoration free
 * to arrive at them.
 */
export const DECOR_HUES = ["primary", "secondary", "accent"] as const;
export type DecorHue = (typeof DECOR_HUES)[number];

/** The theme's neutral surfaces, each carrying its own lightness. */
export const DECOR_BASES = ["surface", "panel", "surface-lighten-1"] as const;
export type DecorBase = (typeof DECOR_BASES)[number];

/** Tint amounts. Decoration never exceeds the largest — that bound is the tint region's edge. */
export const DECOR_AMTS = [0.16, 0.3] as const;
export type DecorAmount = (typeof DECOR_AMTS)[number];

/** The roles whose meaning decoration must never borrow. */
export type SemanticRole = "error" | "success" | "warning";

// [LAW:types-are-the-program] The exclusion is a theorem about the constant,
// checked by the compiler: adding a semantic role to DECOR_HUES fails
// `pnpm typecheck`, not a review. (test/decor.test.ts asserts it at runtime too.)
const _decorHuesAreNonSemantic: Extract<DecorHue, SemanticRole> extends never
  ? true
  : never = true;
void _decorHuesAreNonSemantic;

export interface DecorEntry {
  readonly base: DecorBase;
  readonly hue: DecorHue;
  readonly amount: DecorAmount;
}

/**
 * The decorative vocabulary, ORDERED: amount-major, then hue, then base, so
 * consecutive indices walk the bases of one hue before changing hue, and the
 * whole lighter set precedes the whole deeper set. 2 × 3 × 3 = 18 entries, all
 * of them the theme's own. An address selects an entry; it never synthesises.
 */
export const DECOR_VOCABULARY: readonly DecorEntry[] = DECOR_AMTS.flatMap(
  (amount) =>
    DECOR_HUES.flatMap((hue) =>
      DECOR_BASES.map((base) => ({ base, hue, amount })),
    ),
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
} as const satisfies Record<string, Distribution>;
export type DistributionName = keyof typeof DISTRIBUTIONS;

export const DEFAULT_DISTRIBUTION: DistributionName = "van-der-corput";

// --- Address -> entry ---------------------------------------------------------

/** One step down the tree: which child, of how many. `0 <= index < count`. */
export interface AddressStep {
  readonly index: number;
  readonly count: number;
}

/** The steps from the root to a node. The root's address is empty. */
export type Address = readonly AddressStep[];

/**
 * Each level's contribution to the selection decays by this factor, so the
 * row decides the coarse position and the cell refines it. The value the
 * evidence demo was validated with; the doc's separations were measured under it.
 */
const LEVEL_DECAY = 0.37;

/**
 * The index into a vocabulary of `size` entries that `address` selects under
 * `distribution`: a weighted fold of the per-level positions, rounded, taken
 * modulo the size. Any size ≥ 1; a size of 1 selects entry 0 for every
 * address, which is what makes a one-entry vocabulary a uniform bar.
 */
export function vocabularyIndex(
  address: Address,
  distribution: Distribution,
  size: number,
): number {
  let value = 0;
  let weight = 1;
  for (const { index, count } of address) {
    value += distribution(index, count) * weight * size;
    weight *= LEVEL_DECAY;
  }
  const raw = Math.round(value) % size;
  return raw < 0 ? raw + size : raw;
}

/**
 * The entry of `vocabulary` that `address` selects. Generic over the entry
 * type so the selection is testable over any vocabulary — a one-entry one
 * must yield that entry everywhere.
 *
 * [LAW:no-silent-failure] `vocabularyIndex` lands in `[0, size)` by
 * construction; an out-of-range read here is an empty vocabulary, which has
 * nothing to select, so it throws rather than returning an undefined entry.
 */
export function vocabularySelect<T>(
  vocabulary: readonly T[],
  address: Address,
  distribution: Distribution,
): T {
  const entry =
    vocabulary[vocabularyIndex(address, distribution, vocabulary.length)];
  if (entry === undefined)
    throw new Error("vocabularySelect: empty vocabulary");
  return entry;
}

/** The decorative entry a node's address selects. */
export const decorEntryFor = (
  address: Address,
  distribution: Distribution,
): DecorEntry => vocabularySelect(DECOR_VOCABULARY, address, distribution);

/**
 * [LAW:parse-dont-validate] The one unit that turns a palette role NAME into a
 * proven `ColorRgba`. Every shipped theme carries every role this module names
 * (test/decor.test.ts checks the whole registry), so an absence is registry
 * drift or a hand-built palette missing a role — a loud failure naming both,
 * never a fallback colour. [LAW:no-silent-failure]
 */
export function paletteRole(
  palette: Palette,
  role: DecorBase | DecorHue,
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
 * A node's decorative background: the theme's `base` tinted toward the theme's
 * `hue` by `amount`, for the entry its address selects.
 */
export function decorFor(
  palette: Palette,
  address: Address,
  distribution: Distribution,
): ColorRgba {
  const { base, hue, amount } = decorEntryFor(address, distribution);
  return blendRgb(
    paletteRole(palette, base),
    paletteRole(palette, hue),
    amount,
  );
}

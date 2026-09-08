// [LAW:effects-at-boundaries] Pure: any node's colour is computable from its
// address alone. [LAW:one-way-deps] cc-candybar keeps the policy of which roles,
// amounts and address formula; rich-js owns the one colour operation.

import {
  blendRgb,
  contrastRatio,
  type ColorRgba,
  type Palette,
} from "@promptctl/rich-js";

/** The three non-semantic root hues: meaning is not in the set at all. */
export const DECOR_HUES = ["primary", "secondary", "accent"] as const;
export type DecorHue = (typeof DECOR_HUES)[number];

export const DECOR_BASES = ["surface", "panel", "surface-lighten-1"] as const;
export type DecorBase = (typeof DECOR_BASES)[number];

/** Tint amounts; decoration never exceeds the largest. */
export const DECOR_AMTS = [0.16, 0.3] as const;
export type DecorAmount = (typeof DECOR_AMTS)[number];

export const DECOR_MAX_AMOUNT: DecorAmount = DECOR_AMTS.reduce((a, b) =>
  b > a ? b : a,
);

/** Cues are mixes toward these, so they invert between light and dark. */
export type ThemePole = "foreground" | "background";

export type SemanticRole = "error" | "success" | "warning";

// [LAW:types-are-the-program] A semantic role in DECOR_HUES fails typecheck.
const _decorHuesAreNonSemantic: Extract<DecorHue, SemanticRole> extends never
  ? true
  : never = true;
void _decorHuesAreNonSemantic;

export interface DecorEntry {
  readonly base: DecorBase;
  readonly hue: DecorHue;
  readonly amount: DecorAmount;
}

/** Ordered amount-major, then hue, then base. An address selects an entry. */
export const DECOR_VOCABULARY: readonly DecorEntry[] = DECOR_AMTS.flatMap(
  (amount) =>
    DECOR_HUES.flatMap((hue) =>
      DECOR_BASES.map((base) => ({ base, hue, amount })),
    ),
);

/** [LAW:dataflow-not-control-flow] A VALUE an instance carries, not a branch. */
export type Distribution = (index: number, count: number) => number;

const PHI = 0.6180339887498949;

/** Bit reversal of `index` as a binary fraction. Never reads the count. */
const vanDerCorput: Distribution = (index) => {
  let value = 0;
  let place = 0.5;
  for (let i = index; i > 0; i >>= 1, place /= 2) value += place * (i & 1);
  return value;
};

/** [LAW:one-source-of-truth] The table below is typed over THIS tuple. */
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

/** The count-blind three move nobody when a sibling is hidden; the other two
 * are a trade the author spends knowingly on a CLOSED set. */
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

/** [LAW:single-enforcer] One name-to-function resolution, so no two placers
 * can default differently. */
export const placedBy = (name: DistributionName | undefined): Distribution =>
  DISTRIBUTIONS[name ?? DEFAULT_DISTRIBUTION];

export interface Position {
  readonly index: number;
  readonly count: number;
}

/** [LAW:dataflow-not-control-flow] A step carries the function it is placed by,
 * so a tree mixing five distributions is five values, not five code paths. */
export interface AddressStep extends Position {
  readonly distribution: Distribution;
}

export type Address = readonly AddressStep[];

/** Each level's contribution decays by this: rows coarsen, cells refine. */
export const LEVEL_DECAY = 0.37;

/** A weighted fold of the per-level positions, rounded, modulo `size`. */
function vocabularyIndex(address: Address, size: number): number {
  let value = 0;
  let weight = 1;
  for (const { index, count, distribution } of address) {
    value += distribution(index, count) * weight * size;
    weight *= LEVEL_DECAY;
  }
  const raw = Math.round(value) % size;
  return raw < 0 ? raw + size : raw;
}

/** The same fold, modulo 1 instead of rounded into a vocabulary. */
function bandAxis(address: Address): number {
  let value = 0;
  let weight = 1;
  for (const { index, count, distribution } of address) {
    value += distribution(index, count) * weight;
    weight *= LEVEL_DECAY;
  }
  return value % 1;
}

/** [LAW:no-silent-failure] An undefined read means an empty vocabulary. */
export function vocabularySelect<T extends {}>(
  vocabulary: readonly T[],
  address: Address,
): T {
  const entry = vocabulary[vocabularyIndex(address, vocabulary.length)];
  if (entry === undefined)
    throw new Error("vocabularySelect: empty vocabulary");
  return entry;
}

export const decorEntryFor = (address: Address): DecorEntry =>
  vocabularySelect(DECOR_VOCABULARY, address);

/** [LAW:no-silent-failure] A missing role fails loudly, not a fallback colour. */
export function paletteRole(
  palette: Palette,
  role: DecorBase | DecorHue | ThemePole,
): ColorRgba {
  const colour = palette.get(role);
  if (colour === undefined) {
    throw new Error(
      `palette "${palette.name}" has no "${role}" role; decoration needs it`,
    );
  }
  return colour;
}

/** [LAW:one-source-of-truth] The one place the tint rule is spelled. */
export function decorEntryColour(
  palette: Palette,
  { base, hue, amount }: DecorEntry,
): ColorRgba {
  return blendRgb(
    paletteRole(palette, base),
    paletteRole(palette, hue),
    amount,
  );
}

export const decorFor = (palette: Palette, address: Address): ColorRgba =>
  decorEntryColour(palette, decorEntryFor(address));

/** Enforced, not assumed: "the pure hue is vivid" is false for some palettes. */
export const STATE_FLOOR = 2.2;

export const STATE_PURE_AMOUNT = 0.92;

/** The search may reach `foreground` itself; some hues clear only there. */
const STATE_STEPS = 12;

/** [LAW:dataflow-not-control-flow] Candidates and one predicate, so the values
 * decide. [LAW:no-silent-failure] A hue that cannot clear at the pole throws. */
export function stateFor(palette: Palette, hue: DecorHue): ColorRgba {
  const tintEdge = DECOR_VOCABULARY.filter(
    (entry) => entry.hue === hue && entry.amount === DECOR_MAX_AMOUNT,
  ).map((entry) => decorEntryColour(palette, entry));
  const pure = blendRgb(
    paletteRole(palette, "surface"),
    paletteRole(palette, hue),
    STATE_PURE_AMOUNT,
  );
  const foreground = paletteRole(palette, "foreground");
  const state = Array.from({ length: STATE_STEPS + 1 }, (_, k) =>
    blendRgb(pure, foreground, k / STATE_STEPS),
  ).find((candidate) =>
    tintEdge.every((tint) => contrastRatio(candidate, tint) >= STATE_FLOOR),
  );
  if (state === undefined) {
    throw new Error(
      `palette "${palette.name}": "${hue}" cannot clear the ${STATE_FLOOR} state floor even at foreground`,
    );
  }
  return state;
}

/** Whichever pole reads better; a fixed foreground measurably fails. */
export function textOn(palette: Palette, background: ColorRgba): ColorRgba {
  const poles: readonly ThemePole[] = ["background", "foreground"];
  return poles
    .map((pole) => paletteRole(palette, pole))
    .reduce((best, pole) =>
      contrastRatio(background, pole) > contrastRatio(background, best)
        ? pole
        : best,
    );
}

/** No address enters: a band is a plane hung under a trigger, not a position. */
export interface Disclosure {
  readonly hue: DecorHue;
  readonly depth: number;
}

/** The cap is the limit: adjacent planes are apart only through depth 2. */
export const BAND_RECESSION = {
  base: 0.42,
  perDepth: 0.14,
  cap: 0.75,
} as const;

/** So no item is the plane, and none is its own trigger. */
export const BAND_WINDOW = { floor: 0.12, span: 0.8 } as const;

export function hueAtDepth(hue: DecorHue, depth: number): DecorHue {
  const index = (DECOR_HUES.indexOf(hue) + depth) % DECOR_HUES.length;
  // [LAW:no-defensive-null-guards] In range by construction; `!` states that.
  return DECOR_HUES[index]!;
}

/** `state` is worn by the trigger: drawn from what it OPENS, not its place. */
export interface Band {
  readonly state: ColorRgba;
  readonly plane: ColorRgba;
}

/** One expression for every depth, so the trigger and the band cannot disagree
 * about their hue. Memoised: the walk asks for every segment's band per render. */
export function bandFor(palette: Palette, disclosure: Disclosure): Band {
  const key = `${disclosure.hue}|${disclosure.depth}`;
  let bands = BAND_MEMO.get(palette);
  if (bands === undefined) {
    bands = new Map();
    BAND_MEMO.set(palette, bands);
  }
  const hit = bands.get(key);
  if (hit !== undefined) return hit;
  const state = stateFor(palette, hueAtDepth(disclosure.hue, disclosure.depth));
  const recession = Math.min(
    BAND_RECESSION.cap,
    BAND_RECESSION.base + BAND_RECESSION.perDepth * disclosure.depth,
  );
  const band = {
    state,
    plane: blendRgb(state, paletteRole(palette, "background"), recession),
  };
  bands.set(key, band);
  return band;
}
const BAND_MEMO = new WeakMap<Palette, Map<string, Band>>();

/** The SAME step shape the bar's cells use, folded onto the band's axis. */
export function bandItemFor(
  palette: Palette,
  disclosure: Disclosure,
  address: Address,
): ColorRgba {
  const { state, plane } = bandFor(palette, disclosure);
  return blendRgb(
    plane,
    state,
    BAND_WINDOW.floor + BAND_WINDOW.span * bandAxis(address),
  );
}

/** [LAW:types-are-the-program] Nothing of the trigger's own position enters,
 * which is what lets a body hang on its trigger and be coloured without order. */
export type Region =
  | { readonly kind: "bar"; readonly address: Address }
  | {
      readonly kind: "band";
      readonly band: Disclosure;
      readonly address: Address;
    };

export const BAR_ROOT: Region = { kind: "bar", address: [] };

export const descend = (region: Region, step: AddressStep): Region => ({
  ...region,
  address: [...region.address, step],
});

export const bandRoot = (band: Disclosure): Region => ({
  kind: "band",
  band,
  address: [],
});

/** [LAW:one-source-of-truth] Measured on the background the cell resolves to. */
export type TextFloor = (background: ColorRgba) => ColorRgba | undefined;

export const TERMINAL_TEXT: TextFloor = () => undefined;

/** `text` is the floor an UNAUTHORED `fg:` takes; band text is chosen. */
export interface Decoration {
  readonly tint: ColorRgba;
  readonly text: TextFloor;
  readonly disclosure: Disclosure;
}

/** [LAW:one-source-of-truth] ONE read projected three ways, so a cell and the
 * band it drops cannot disagree about their hue; a band's depth counts up. */
export function decorationFor(palette: Palette, region: Region): Decoration {
  switch (region.kind) {
    case "bar": {
      const entry = decorEntryFor(region.address);
      return {
        tint: decorEntryColour(palette, entry),
        text: TERMINAL_TEXT,
        disclosure: { hue: entry.hue, depth: 0 },
      };
    }
    case "band": {
      const tint = bandItemFor(palette, region.band, region.address);
      return {
        tint,
        text: (background) => textOn(palette, background),
        disclosure: { hue: region.band.hue, depth: region.band.depth + 1 },
      };
    }
  }
}

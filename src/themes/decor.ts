// The colour function: a node's ADDRESS in the layout tree selects one entry
// of the theme's own decorative vocabulary. Rationale, measurements and the
// rejected alternatives: design-docs/COLOUR-FROM-THEME-VOCABULARY.md.
//
// The rule: a segment's decorative background is the theme's `base` mixed
// toward the theme's `hue` — lightness `amount` of the way, chroma
// `DECOR_CHROMA_SHARE` of the way, the hue's own angle — with the entry chosen
// by the node's position in the tree. Every coordinate is one the theme
// already contains or lies between two it contains: it SELECTS from the theme;
// it never synthesises saturation the theme lacks.
//
// [LAW:effects-at-boundaries] Pure. No renderer wiring, no I/O, no traversal
// state: any node's colour is computable from its address alone, without
// visiting any other node. [LAW:one-way-deps] A leaf of the themes module — it
// imports only rich-js, which owns every colour operation used (`mixAxes`,
// `blendRgb`);
// cc-candybar keeps the POLICY (which roles, which amounts, which address
// formula) and no colour arithmetic of its own.

import {
  blendRgb,
  Oklch,
  contrastFor,
  contrastRatio,
  ensureContrast,
  type ColorRgba,
  type Palette,
} from "@promptctl/rich-js";

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

/**
 * How far a tint's LIGHTNESS moves from its base toward its hue. Decoration
 * never moves further than the largest — that bound is the tint region's edge,
 * and it is a lightness bound because every floor the regions are held to
 * (state over tint, trigger over plane, text over cell) is a contrast ratio,
 * which lightness decides.
 */
export const DECOR_AMTS = [0.16, 0.3] as const;
export type DecorAmount = (typeof DECOR_AMTS)[number];

/**
 * How far a tint's CHROMA moves from its base toward its hue: most of the way.
 * Chroma is the axis a theme's identity is carried on and the contrast floors
 * barely read, so it is decoupled from `amount` rather than dragged along with
 * it. Tied to the lightness amount, the bar wore 19–57% of each theme's accent
 * chroma and distinct themes converged (dracula ~ rose-pine-moon ΔE .006);
 * raising the amount instead pulled tints onto the state region and broke its
 * floors (brandon-theme-picker-bgw.8fp). Below 1, so a tint stays quieter than
 * the accent it is drawn from; the sRGB gamut lowers it further on pale bases,
 * which is the most a light theme's surface can hold.
 */
export const DECOR_CHROMA_SHARE = 0.8;

/** The tint region's edge: the most-tinted cell any hue can produce. Derived, never restated. */
export const DECOR_MAX_AMOUNT: DecorAmount = DECOR_AMTS.reduce((a, b) =>
  b > a ? b : a,
);

/**
 * The theme's two poles. Directional cues are mixes toward them — active
 * toward `foreground`, recessed toward `background` — which is what makes the
 * cues invert on their own between light and dark themes, with no branch.
 */
export type ThemePole = "foreground" | "background";

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
 * The decorative vocabulary, ORDERED: amount-major, then base, then hue, so
 * consecutive indices walk the HUES before changing base, and the whole
 * lighter set precedes the whole deeper set. 2 × 3 × 3 = 18 entries, all of
 * them the theme's own. An address selects an entry; it never synthesises.
 *
 * Hue is the fastest axis because it is the one a theme is recognised by. A
 * cell's address step moves the index by only a few entries against its
 * row's, so the fastest axis is the one neighbours most often differ in:
 * base-fastest spent the theme's hues on ROWS and left the bundled bar's
 * neighbouring cells a surface lightness apart (ΔE ~.04, a whole row one hue
 * — brandon-theme-picker-bgw.8fp). It is not a guarantee: a step of a whole
 * hue period (3 entries — van-der-corput's half step at cell weight is 3.3)
 * keeps the hue and changes only the base, so cells 0/1, 2/3 and 4/5 of a flat
 * row share a hue. The bundled bar's seams are measured, not assumed
 * (test/theme-identity.test.ts).
 */
export const DECOR_VOCABULARY: readonly DecorEntry[] = DECOR_AMTS.flatMap(
  (amount) =>
    DECOR_BASES.flatMap((base) =>
      DECOR_HUES.map((hue) => ({ base, hue, amount })),
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
 * One step down the tree: a position, placed by the PARENT's distribution —
 * the one field every placer carries, read here at every level of the tree.
 * [LAW:dataflow-not-control-flow] A step carries the function it is placed by,
 * so the fold below calls whatever each level was handed; a tree mixing five
 * distributions is five values, not five code paths.
 */
export interface AddressStep extends Position {
  readonly distribution: Distribution;
}

/** The steps from the root to a node. The root's address is empty. */
export type Address = readonly AddressStep[];

/**
 * Each level's contribution to the selection decays by this factor, so the
 * row decides the coarse position and the cell refines it. The value the
 * evidence demo was validated with; the doc's separations were measured under it.
 */
export const LEVEL_DECAY = 0.37;

/**
 * The index into a vocabulary of `size` entries that `address` selects: a
 * weighted fold of the per-level positions — each level placed by its own
 * step's distribution — rounded, taken modulo the size. A size of 1 selects
 * entry 0 for every address, which is what makes a one-entry vocabulary a
 * uniform bar. `vocabularySelect` is the sole caller and owns the size ≥ 1
 * precondition.
 */
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

/**
 * Where `address` lands on a band's plane→state axis, in [0, 1): the same
 * weighted fold `vocabularyIndex` runs — each level placed by its own step's
 * distribution, decaying by `LEVEL_DECAY` — taken modulo 1 instead of
 * rounded into a vocabulary. One step yields exactly that step's placement
 * (`d % 1 === d` for `d` in [0, 1)), so a picker's options, one step each
 * under their trigger, land where they always did; the empty address (the
 * band's root) lands at 0. The two folds are kept as two spellings rather
 * than one shared helper because `vocabularyIndex` scales by `size` INSIDE
 * the sum, and reassociating that product would move bytes in every
 * committed snapshot for no gain.
 */
function bandAxis(address: Address): number {
  let value = 0;
  let weight = 1;
  for (const { index, count, distribution } of address) {
    value += distribution(index, count) * weight;
    weight *= LEVEL_DECAY;
  }
  return value % 1;
}

/**
 * The entry of `vocabulary` that `address` selects. Generic over the entry
 * type so the selection is testable over any vocabulary — a one-entry one
 * must yield that entry everywhere.
 *
 * [LAW:no-silent-failure] `vocabularyIndex` lands in `[0, size)` by
 * construction and `T` is non-nullable, so an undefined read here is exactly
 * an empty vocabulary — nothing to select — and throws rather than returning it.
 */
export function vocabularySelect<T extends {}>(
  vocabulary: readonly T[],
  address: Address,
): T {
  const entry = vocabulary[vocabularyIndex(address, vocabulary.length)];
  if (entry === undefined)
    throw new Error("vocabularySelect: empty vocabulary");
  return entry;
}

/** The decorative entry a node's address selects. */
export const decorEntryFor = (address: Address): DecorEntry =>
  vocabularySelect(DECOR_VOCABULARY, address);

/**
 * [LAW:parse-dont-validate] The one unit that turns a palette role NAME into a
 * proven `ColorRgba`. Every shipped theme carries every role this module names
 * (test/decor.test.ts checks the whole registry), so an absence is registry
 * drift or a hand-built palette missing a role — a loud failure naming both,
 * never a fallback colour. [LAW:no-silent-failure]
 */
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

/**
 * The colour of one vocabulary entry in `palette`: the theme's `base` moved
 * toward the theme's `hue` in OKLCH — lightness `amount` of the way, chroma
 * `DECOR_CHROMA_SHARE` of the way, onto the hue's own angle, keeping the
 * base's opacity. [LAW:one-source-of-truth] The one place the rule is spelled
 * — `decorFor` renders through it and `stateFor` measures against it, so the
 * floor is enforced against the very bytes a tint cell will show, not a second
 * transcription of the formula.
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
  const hit = colours.get(entry);
  if (hit !== undefined) return hit;
  const colour = Oklch.fromRgba(paletteRole(palette, entry.base))
    .mixAxes(Oklch.fromRgba(paletteRole(palette, entry.hue)), {
      l: entry.amount,
      c: DECOR_CHROMA_SHARE,
      h: 1,
      alpha: 0,
    })
    .toRgba();
  colours.set(entry, colour);
  return colour;
}

// Every segment of every render asks for its tint, and the answer is a pure
// function of (palette, entry) — two OKLCH conversions, a mix, and a possible
// gamut bisection, ~5% of a render before this memo. Keyed by the entry's
// identity: an address selects an element OF DECOR_VOCABULARY, so each map
// holds at most its 18 colours.
const DECOR_MEMO = new WeakMap<Palette, Map<DecorEntry, ColorRgba>>();

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
 * `STATE_FLOOR` against the most-tinted cell that hue produces on EVERY base.
 * A hue that already clears at step zero is byte-unchanged — the enforcement
 * is a floor, not a transform.
 *
 * [LAW:dataflow-not-control-flow] Fourteen candidates, one predicate, the
 * first that passes; the values decide, not a branch per theme.
 * [LAW:no-silent-failure] A hue that cannot clear even beyond `foreground` throws
 * naming palette and hue — never a quieter colour.
 */
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
  // Past the pole: `foreground` slid on in OKLCH lightness until it clears
  // every tint of the hue. A look can pull the pole itself under the floor
  // (atom-one-dark's foreground under `dim` measured 2.19 against its primary
  // tints), and the palette holds no stronger role to reach for. The tints of
  // one hue share a polarity, so each slide moves the same way and never
  // undoes the one before it; when they straddle the cutoff it can, and the
  // check below still refuses.
  const beyond = tintEdge.reduce(
    (candidate, tint) => ensureContrast(candidate, tint, STATE_FLOOR),
    foreground,
  );
  const state = [
    ...Array.from({ length: STATE_STEPS + 1 }, (_, k) =>
      blendRgb(pure, foreground, k / STATE_STEPS),
    ),
    beyond,
  ].find((candidate) =>
    tintEdge.every((tint) => contrastRatio(candidate, tint) >= STATE_FLOOR),
  );
  if (state === undefined) {
    throw new Error(
      `palette "${palette.name}": "${hue}" cannot clear the ${STATE_FLOOR} state floor even beyond foreground`,
    );
  }
  return state;
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
 * [LAW:one-source-of-truth]
 */
export function textOn(palette: Palette, background: ColorRgba): ColorRgba {
  let texts = TEXT_MEMO.get(palette);
  if (texts === undefined) {
    texts = new Map();
    TEXT_MEMO.set(palette, texts);
  }
  const hit = texts.get(background.hex);
  if (hit !== undefined) return hit;
  const side = contrastFor(background);
  const pole = (["background", "foreground"] as const)
    .map((role) => paletteRole(palette, role))
    .reduce((best, pole) =>
      contrastRatio(side, pole) < contrastRatio(side, best) ? pole : best,
    );
  const text = ensureContrast(pole, background, TEXT_MIN_CONTRAST);
  texts.set(background.hex, text);
  return text;
}

// Every cell of every render asks for its text, and the answer is a pure
// function of (palette, background) — a bisection when the pole misses the
// floor, measured at 20% of a render before this memo. A palette's distinct
// backgrounds are its tints, band colours, and the stops its authored ramps
// reach, so each map stays as small as the colours a bar can wear.
const TEXT_MEMO = new WeakMap<Palette, Map<string, ColorRgba>>();

// --- Disclosure: bands ---------------------------------------------------------

/**
 * Where a disclosure sits in the colour model: the vocabulary hue of the bar
 * cell that roots it, and how many bands deep it is. `depth` 0 is a bar cell's
 * own band; a disclosure opened from inside that band is depth 1, and so on.
 * The address never enters here — a band is NOT a tree position, it is a
 * plane hung under a trigger, so the only positional fact it needs is the hue
 * its root cell was dealt.
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
 * Memoised per (palette, hue, depth): the render walk asks for every segment's
 * band on every render, and palettes are memoised objects (transposedPalette),
 * so the key is stable and the search in `stateFor` runs once per palette.
 */
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
  address: Address,
): ColorRgba {
  const { state, plane } = bandFor(palette, disclosure);
  return blendRgb(
    plane,
    state,
    BAND_WINDOW.floor + BAND_WINDOW.span * bandAxis(address),
  );
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
 * bar, one vocabulary entry gives both the tint and the hue of the band the
 * cell opens (at depth 0), so a cell and the band it drops cannot disagree
 * about their hue. On a band, the item is placed by its address and OPENS the
 * next band of the same lineage: the band's own hue one depth further — the
 * demo's `menuPlane(host, depth + 1)` — a natural counted up from the band it
 * stands on, never arithmetic back from a position.
 */
export function decorationFor(palette: Palette, region: Region): Decoration {
  switch (region.kind) {
    case "bar": {
      const entry = decorEntryFor(region.address);
      return {
        tint: decorEntryColour(palette, entry),
        disclosure: { hue: entry.hue, depth: 0 },
      };
    }
    case "band": {
      return {
        tint: bandItemFor(palette, region.band, region.address),
        disclosure: { hue: region.band.hue, depth: region.band.depth + 1 },
      };
    }
  }
}

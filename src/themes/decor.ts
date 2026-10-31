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
// in the tree; where a row turns from one hue to the next, the cells either
// side of the turn wear shades the depth draws as two colours, and as neither
// colour an open trigger beside them would wear, wherever their ladders have
// them. An open menu selects the same way: the segment that opened it
// wears its hue at its pressed shade — the dial's activated shade, moved along
// the ladder where the depth draws it like what stands beside it — and its
// rows sit on the theme's `surface`. Every background the bar draws is one its
// palette names: it SELECTS from the theme; it never synthesises a colour.
//
// [LAW:effects-at-boundaries] Pure. No renderer wiring, no I/O, no traversal
// state: any node's colour is computable from its address alone, without
// visiting any other node. [LAW:one-way-deps] A leaf of the themes module — it
// imports only its memo and rich-js, which owns every colour operation used
// (`ensureContrast`, `contrastFor`, `contrastRatio`, all for text, and
// `drawnColour`, to ask whether a depth draws two shades as one colour);
// cc-candybar keeps the POLICY (which roles, which shades, which address
// formula) and no colour arithmetic of its own.

import {
  contrastFor,
  contrastRatio,
  drawnColour,
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
 * On the `muted` position's cells, the role's muted form and the role itself:
 * Textual's own text colour for that role, `$text-primary` on
 * `$primary-muted`, with its hue kept and its lightness slid until it clears
 * TEXT_MIN_CONTRAST — so a muted row's text is coloured the way Textual's
 * labels are, and reads on both.
 */
const roleText: DecorText = (palette, hue, background, drawnAt) =>
  legibleOn(palette, palette.get(`text-${hue}`), background, drawnAt);

/**
 * One position of the shade dial: the shades a row's cells wear, in the order
 * a cell's place in its row selects them (`vocabularySelect` over the window
 * these make at the depth drawn, `windowAt`, read by the rule of the
 * distribution that placed the cell), and how text is chosen on them. A
 * band's items wear the same position of the dial, in the band's hue
 * (`bandFor`).
 */
export interface Shade {
  /**
   * [LAW:types-are-the-program] Two tones at least: a position of one puts
   * every pair of neighbours on one shade, under any distribution.
   */
  readonly tones: readonly [RoleShade, RoleShade, ...RoleShade[]];
  readonly text: DecorText;
  /**
   * The shade a pressed button wears at this position: the segment whose menu
   * is open, and the ✕ and blank leads of that menu's rows, in the menu's hue
   * (`bandFor`). Textual's flat buttons wear their role's muted form, so a
   * window of the ladder's rungs presses into it; a row already muted
   * presses into the role's second lightening, a rung that row never deals,
   * so the pressed button stands out of it. A depth that draws it like what
   * stands beside a pressed button moves it along the ladder (`pressedAt`).
   * [LAW:dataflow-not-control-flow] A value in the row, so a new position
   * states its own.
   */
  readonly activated: RoleShade;
}

/**
 * Three neighbouring rungs of the ladder from `from`: one position of the dial.
 * Listed low, high, middle because a row's cells take entries 0, 2, 1, 2 of
 * three, over and over (van der Corput, read by its own rule, `DISTRIBUTIONS`):
 * the row walks up and down its window a rung at a time — low, middle, high,
 * middle, low — and turning the dial one position moves every cell exactly
 * one rung.
 * The order is the one Brandon compared the positions in
 * (candybar-theme-colours-6fq5.e5n).
 */
const ladderWindow = (from: number): Shade => ({
  // [LAW:no-defensive-null-guards] Every position below starts at most four
  // rungs up a ladder of seven; the `!`s state that, they do not guard it.
  tones: [LADDER[from]!, LADDER[from + 2]!, LADDER[from + 1]!],
  text: poleText,
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
  activated: "muted",
});

/**
 * Two rungs `apart` rungs each side of the role, and never the role itself:
 * every neighbouring pair of cells jumps the whole width (van der Corput
 * alternates two tones strictly, whatever the row's length).
 */
const pairWindow = (apart: number): Shade => ({
  tones: [LADDER[3 - apart]!, LADDER[3 + apart]!],
  text: poleText,
  activated: "muted",
});

// Trial jumps (brandon-menus-sjhy.4fi, "a bigger jump in color between
// sequential segments"): the role's window widened to two and three rungs each
// side, and the strict two-tone pairs at those widths. Positions of the dial
// like any other, marked 🧪 in every list of the dial.
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
 * deepest window the dial reaches `muted`: a row's cells deal the role's muted
 * form and the role itself, under the role's own text. A new position is
 * one row here: the option domain, the loader's enum and the settings control
 * derive from this table, and the row names what a pressed button wears there.
 */
export const SHADES = {
  muted: {
    tones: ["muted", "base"],
    text: roleText,
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
 * is read off its placement as a cell's shade is, which under van der Corput
 * (0, ½, ¼, ¾, …) steps in order through one or two hues and not through
 * three (rows 0–3 of a three-step variation would land on steps 0, 2, 1, 2).
 * A longer one needs a different selection, so the type does not admit it.
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
// Trial tunings of the accent variation (brandon-menus-sjhy.4fi): marked 🧪
// in every list of the variations.
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

/** One closed bar cell's decoration: its row's hue, at its own shade. */
export interface DecorEntry {
  readonly hue: DecorHue;
  readonly shade: RoleShade;
}

/**
 * The decorations a theme's preview samples of a closed cell under `decor`
 * in `palette` at `drawnAt`: each of its roles at the tones of that role's
 * window there (`windowAt`), in the window's order, dealt across as many
 * places as the dial position names tones: every tone of the window, dealt
 * again from its first where the window holds fewer. The count is the
 * dial's at every depth, so a frame keeps its shape at every depth, while
 * the colours are the ones the depth deals; and a window of two or more
 * tones never puts one colour on two places side by side. The roles sit side
 * by side, so where one's places end and the next's begin they meet as a
 * row that turns hue does (`turnsHeld`): a place there can wear another tone
 * or a rung past its window in place of the tone it was dealt, and where the
 * role has no other place in that tone, the sample does not show it.
 */
export const vocabularyOf = (
  palette: Palette,
  decor: Decor,
  drawnAt: ColorDepth,
): readonly DecorEntry[] =>
  turnsHeld(
    palette,
    decor,
    decor.variation.hues.flatMap((hue) => {
      const window = windowAt(palette, hue, decor.shade, drawnAt);
      // [LAW:no-defensive-null-guards] A window is never empty (`Tones`), so
      // a place taken modulo its length is in range; the `!` states that.
      return decor.shade.tones.map((_, at) => ({
        hue,
        shade: window[at % window.length]!,
      }));
    }),
    drawnAt,
  );

// --- The window at a depth ----------------------------------------------------

/**
 * The tones a row of one hue deals at one depth, in the order a cell's place
 * selects them, no two of them drawn as one colour there, and as many as the
 * window's size at that depth (`windowSize`) wherever the role has them.
 * [LAW:types-are-the-program] Never empty, and one tone only where the role's
 * whole ladder draws as one colour at the depth: there is no second rung to
 * deal, so the row wears that one and the joiner shows each seam, which is
 * the theme's look at that depth. A window never widens into the muted form,
 * even where it draws apart (textual-ansi's does): on the ladder's positions
 * it is the shade a pressed button wears, and a closed row in it would read
 * as pressed.
 */
export type Tones = readonly [RoleShade, ...RoleShade[]];

/**
 * The window a row of `hue` deals under the dial position `shade`, drawn at
 * `drawnAt`: as many tones as its size at the depth (`windowSize`), wherever
 * the role has that many the depth draws as distinct colours. First the
 * position's tones the depth draws apart, in the position's order, up to that
 * size; then, for each tone short of it, the nearest rung of the ladder drawn
 * as none of the tones the window holds (`widen`); listed, where it holds
 * three or more, as the dial lists a position (`inWalkOrder`). At 256 colours
 * neighbouring rungs round onto one table entry, at ansi onto one of the
 * hue's slots, and a theme can name two rungs alike at any depth, so a window
 * that kept them would deal two neighbours one colour where the role had
 * another to give.
 *
 * Alike means drawn as one colour: rich-js's `drawnColour`, the ground the
 * writer emits at that depth, compared for identity. No distance between two
 * colours decides anything; only whether the terminal is sent one or two.
 *
 * [LAW:dataflow-not-control-flow] Built once per (palette, hue, position,
 * depth) and memoised, so a cell's shade is the same lookup at every depth
 * (`entryOf` over the window).
 * [LAW:one-source-of-truth] The one window: a bar cell's shade
 * (`decorEntryFor`) and a band's items (`bandEntries`) both read it here.
 */
export function windowAt(
  palette: Palette,
  hue: DecorHue,
  shade: Shade,
  drawnAt: ColorDepth,
): Tones {
  return WINDOWS(palette, `${hue}|${shade.tones.join(",")}|${drawnAt}`, () => {
    const drawn = drawnIn(palette, hue, drawnAt);
    const size = windowSize(
      shade.tones.length,
      new Set(LADDER.map(drawn)).size,
    );
    const [first, ...rest] = shade.tones;
    const kept: [RoleShade, ...RoleShade[]] = [first];
    for (const tone of rest) {
      if (
        kept.length < size &&
        kept.every((held) => drawn(held) !== drawn(tone))
      )
        kept.push(tone);
    }
    // [LAW:single-enforcer] One widening per tone short of the size, each
    // taking every colour the window already holds: where the ladder has
    // nothing left, `widen` answers nothing for this tone and every one after.
    return inWalkOrder(
      Array.from({ length: size - kept.length }).reduce<Tones>((window) => {
        const wider = widen(
          palette,
          hue,
          shade.tones,
          window.map(drawn),
          drawnAt,
        );
        return wider === undefined ? window : [...window, wider];
      }, kept),
    );
  });
}

/**
 * A window of three or more listed the way the dial lists every position of
 * three (`ladderWindow`): its lowest rung, its highest, then those between,
 * lowest first. The default distribution deals the third entry of three at
 * every other cell, so in that order a row walks up and down the window a
 * rung at a time as the depth draws it. Appended instead, a widened rung would take the third entry
 * wherever it stands on the ladder, and a row would wear a rung past the
 * position's own tones on half its cells. A window the depth left whole is in
 * that order already, so it does not move. Over two tones the order decides
 * no walk, so a window of two keeps the order it was built in.
 */
const inWalkOrder = (window: Tones): Tones => {
  if (window.length < 3) return window;
  // [LAW:no-defensive-null-guards] A window of three or more holds rungs of
  // the ladder only: the muted form is a tone of the muted position alone,
  // which names two, and a window never widens into it. The `!`s state that
  // the window holds at least three, as the guard above leaves it.
  const ladder: readonly RoleShade[] = LADDER;
  const [low, ...above] = [...window].sort(
    (a, b) => ladder.indexOf(a) - ladder.indexOf(b),
  );
  return [low!, above.at(-1)!, ...above.slice(0, -1)];
};

/**
 * How many tones a window holds where its dial position names `count` and
 * the depth draws the role's ladder as `colours` distinct colours (the muted
 * form not among them): the position's count, short of the ladder's last
 * colour where it has more than two, and never fewer than two.
 *
 * Toward the count, because the count is what a distribution keeps
 * neighbours apart over: van der Corput by halves over two or more, golden
 * angle by bins only over three (`DISTRIBUTIONS`), so a three-tone position
 * held at two leaves golden angle's neighbours on one colour. Short of the
 * last colour, because the button pressed in that hue stands beside every
 * tone of its band's window (`pressedAt`) and needs a colour none of them
 * wears: a press drawn as its neighbour is two neighbours on one colour,
 * while a third closed tone is only the look. So at ansi, where a ladder
 * often draws three slots, a window holds two. Never fewer than two, because
 * one tone puts every pair of neighbours on one shade under any
 * distribution; a window holds one only where the whole ladder draws as one
 * colour, with no second rung to give.
 */
const windowSize = (count: number, colours: number): number =>
  Math.max(2, Math.min(count, colours - 1));

// Every window a render deals is read once per cell per frame, and the answer
// is a pure function of (palette, hue, position, depth): a handful per palette.
const WINDOWS = memoPerPalette<Tones>();

/** How `drawnAt` draws `hue` at a shade: the ground the writer emits, by hex. */
const drawnIn =
  (palette: Palette, hue: DecorHue, drawnAt: ColorDepth) =>
  (tone: RoleShade): string =>
    drawnColour(palette.get(shadeRole(hue, tone)), drawnAt).hex;

/**
 * [LAW:single-enforcer] The one widening, for a window and for a pressed
 * button alike: the nearest rung of `hue`'s ladder to the shades `from` that
 * `drawnAt` draws as none of the colours in `taken`, or `undefined` where
 * every rung is one of them. It moves along the ladder only — the role's own
 * darkenings and lightenings, its hue kept — and decides by identity alone.
 */
function widen(
  palette: Palette,
  hue: DecorHue,
  from: readonly RoleShade[],
  taken: readonly string[],
  drawnAt: ColorDepth,
): RoleShade | undefined {
  const drawn = drawnIn(palette, hue, drawnAt);
  return ladderFrom(from, palette.dark).find(
    (rung) => !taken.includes(drawn(rung)),
  );
}

/**
 * The rungs of the ladder that are not among `from`, nearest first: by how
 * many rungs each stands from the nearest of `from`, where the muted form,
 * the role blended into the theme's background, stands one rung past the
 * ladder's end on the background's side. At an equal distance the rung away
 * from the background comes first, because the background's side is where a
 * pressed button's muted form sits: a window widened away from the
 * background keeps off the shade a pressed button wears.
 */
function ladderFrom(from: readonly RoleShade[], dark: boolean): RoleShade[] {
  const ladder: readonly RoleShade[] = LADDER;
  // On a dark theme the background is below the ladder's darkest rung, on a
  // light one above its brightest.
  const place = (shade: RoleShade): number =>
    shade === "muted" ? (dark ? -1 : ladder.length) : ladder.indexOf(shade);
  const away = dark ? 1 : -1;
  return LADDER.map((rung, at) => ({
    rung,
    at,
    distance: Math.min(...from.map((shade) => Math.abs(at - place(shade)))),
  }))
    .filter(({ distance }) => distance > 0)
    .sort((a, b) => a.distance - b.distance || (b.at - a.at) * away)
    .map(({ rung }) => rung);
}

// --- Distributions ------------------------------------------------------------

/** How a placement in [0, 1) picks one of `size` entries. */
export type Quantize = (placement: number, size: number) => number;

/**
 * The equal bin the placement falls in: each entry an equal share of the
 * circle, in order. Over two entries a van der Corput placement's first bit
 * IS its bin, so any number of rows alternates. The nearest-point rule ties
 * there: ¼ and ¾ sit midway between the two points, both round to the
 * second, and rows 1 and 2 of a three-row bar shared a hue.
 */
export const inBin: Quantize = (placement, size) =>
  Math.floor(placement * size);

/**
 * The upper half of the circle is the last entry, and the lower half is shared
 * among the rest the same way: over three entries, [0, ¼) is the first, [¼, ½)
 * the second and [½, 1) the third; over two it is the bin. A van der Corput
 * placement's first bit is its index's lowest bit and its second bit the next
 * one up, so every odd place takes the last entry and the even places
 * alternate the other two. Of two neighbouring places exactly one is odd, so
 * they never share an entry, at any index. A rule that centres an entry on 0,
 * as the nearest point does, fails: places 2ᵏ − 1 and 2ᵏ land either side of
 * 0, ever closer (7 and 8 at ⅞ and ¹⁄₁₆), and both round to it. Equal bins put
 * cells 5 and 6 on one entry.
 */
export const inHalves: Quantize = (placement, size) => {
  let entry = size - 1;
  for (let half = placement; half < 0.5 && entry > 0; half *= 2) entry--;
  return entry;
};

/**
 * How a placer spreads its children over a vocabulary: where sibling `index`
 * of `count` lands on the circle [0, 1), and the rule a landing is read by.
 * One value, read at every level of the tree.
 *
 * [LAW:locality-or-seam] The rule travels with the placement because whether
 * two neighbours ever select one entry is a property of the pair, not of
 * either half: `DISTRIBUTIONS` says which pairs keep them apart, and why no
 * one rule serves every placement.
 * [LAW:dataflow-not-control-flow] The distribution is a VALUE an instance
 * carries, not a branch: `decorFor` calls whatever it is handed and the five
 * shipped ones are five entries in one table.
 */
export interface Distribution {
  /** Where sibling `index` of `count` lands in [0, 1). */
  readonly place: (index: number, count: number) => number;
  /** Which of `size` entries a landing selects. */
  readonly quantize: Quantize;
}

const PHI = 0.6180339887498949;

/** Bit reversal of `index` as a binary fraction: 0, ½, ¼, ¾, ⅛, … Never reads the count. */
const vanDerCorput: Distribution["place"] = (index) => {
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
 *
 * So is keeping neighbours apart, and each distribution's rule is the one
 * that does it where any can. Van der Corput read by halves never gives two
 * neighbours one entry, over two entries or more, at any index (`inHalves`).
 * Golden angle read by equal bins never does over three: a step of φ moves a
 * landing more than a third of the circle and less than two thirds, so it
 * always changes bin. Over two no rule can, because no two-colouring of the
 * circle separates every pair a rotation by an irrational apart. No one rule
 * serves both: a window walked a rung at a time needs one half of the circle
 * on one entry (van der Corput's odd places are its upper half, its even
 * places its lower), and golden angle puts neighbours inside each half
 * (places 4 and 5, 8 and 9). The even spreads read by equal bins, so a closed
 * set gives every entry an equal run, in order; read by halves, five options
 * would wear the last entry three times. They keep no neighbours apart, nor
 * does `uniform`, which reads by halves so that its one entry is the one van
 * der Corput's odd places wear: a window's middle rung.
 */
export const DISTRIBUTIONS = {
  "van-der-corput": { place: vanDerCorput, quantize: inHalves },
  "golden-angle": { place: (index) => (index * PHI) % 1, quantize: inBin },
  "ends-interleaved": {
    place: (index, count) => {
      const slot = index % 2 === 0 ? index / 2 : count - 1 - (index - 1) / 2;
      return (slot + 0.5) / count;
    },
    quantize: inBin,
  },
  monotonic: {
    place: (index, count) => (index + 0.5) / count,
    quantize: inBin,
  },
  uniform: { place: () => 0.5, quantize: inHalves },
} as const satisfies Record<DistributionName, Distribution>;

export const DEFAULT_DISTRIBUTION: DistributionName = "van-der-corput";

/**
 * [LAW:single-enforcer] THE resolution of an authored distribution NAME to the
 * distribution an instance places by — an absent name is the default. Every placer
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
 * by these alone. [LAW:dataflow-not-control-flow] A step carries the
 * distribution it is placed by, so a fold calls whatever each level was
 * handed; a tree mixing five distributions is five values, not five code
 * paths.
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
  /**
   * The first and last places of the line the step's node is drawn on, so
   * the keystones find the ends of every drawn line: a row's own line, or a
   * line a `{ v }` inside it draws below, which starts where the `{ v }`
   * sits. A row step's are the ends of its stack.
   */
  readonly lineStart: number;
  readonly lineEnd: number;
}

/** The steps from the root to a node. The root's address is empty. */
export type Address = readonly AddressStep[];

/**
 * [LAW:one-source-of-truth] Which of `size` entries `step` selects: where its
 * distribution lands it, read by that distribution's own rule — the one
 * selection a row's hue, a cell's shade and a band's item all make. An absent
 * step is a node alone on that axis — a bar with no vertical container, a
 * one-cell row — and is placed where a first child is, at 0: the first entry.
 */
function entryOf(step: PlacedStep | undefined, size: number): number {
  if (step === undefined) return 0;
  const { place, quantize } = step.distribution;
  return quantize(place(step.index, step.count), size);
}

/**
 * The entry of `vocabulary` that `step` selects (`entryOf`). Generic over the
 * entry type so the selection is testable over any vocabulary — a one-entry
 * one must yield that entry everywhere.
 *
 * [LAW:no-silent-failure] Both rules land in `[0, size)` for a placement in
 * `[0, 1)` and `T` is non-nullable, so an undefined read here is exactly an
 * empty vocabulary — nothing to select — and throws rather than returning it.
 */
export function vocabularySelect<T extends {}>(
  vocabulary: readonly T[],
  step: PlacedStep | undefined,
): T {
  const entry = vocabulary[entryOf(step, vocabulary.length)];
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

/** The step of the variation a row starts on: the hue its placement selects. */
const rowStart = (variation: Variation, row: AddressStep | undefined): number =>
  entryOf(row, variation.hues.length);

/**
 * The decorative entry a bar node's address selects under `decor`: the last
 * of the rows it stacks through chooses the hue the row starts on, so a row
 * stacked above the whole bar (edit mode's reset banner) recolours no row
 * beneath it; the cell chooses the shade from its hue's window in `palette`
 * at `drawnAt` (`windowAt`), and its index how many of the variation's runs
 * it has passed along the row. Where the row turns hue beside a cell, the
 * cells either side of the turn are held apart by the turn rule
 * (`turnsHeld`), over the line the cell is drawn on. A cell is a leaf of its
 * row, however the row nests it: the leaves of an authored `{ h }` inside a row
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
export function decorEntryFor(
  palette: Palette,
  decor: Decor,
  address: Address,
  drawnAt: ColorDepth,
): DecorEntry {
  const { row, cell } = rowAndCell(address);
  // A node alone on its row's axis has no neighbour on its line: it wears
  // what its place deals.
  if (cell === undefined) return dealtAt(palette, decor, row, cell, drawnAt);
  // [LAW:no-defensive-null-guards] The compile places every leaf within the
  // ends of the line it is drawn on, so its place on that line is in range.
  return lineAt(palette, decor, row, cell, drawnAt)[
    cell.index - cell.lineStart
  ]!;
}

/**
 * What a cell's place deals it, before the turn rule: the row starts on its
 * own step and advances one step per run along it, a keystone place wears the
 * keystone hue instead, and the cell's place picks its shade from that hue's
 * window at the depth drawn.
 */
function dealtAt(
  palette: Palette,
  decor: Decor,
  row: AddressStep | undefined,
  cell: AddressStep | undefined,
  drawnAt: ColorDepth,
): DecorEntry {
  const { hues, run, keystones } = decor.variation;
  const turn = cell === undefined ? 0 : Math.floor(cell.index / run);
  const stepped = hues[(rowStart(decor.variation, row) + turn) % hues.length];
  if (stepped === undefined) throw new Error("decorEntryFor: empty variation");
  const hue = keystones.some((at) => KEYSTONE_AT[at](row, cell))
    ? KEYSTONE_HUE
    : stepped;
  return {
    hue,
    shade: vocabularySelect(windowAt(palette, hue, decor.shade, drawnAt), cell),
  };
}

/**
 * The entries every place on the line `cell` is drawn on wears, first place
 * first: what each place deals (`dealtAt`), with the hue turns held apart
 * (`turnsHeld`). Every neighbour is computed from `cell`'s own address — the
 * same row, count and distribution at the next place along the same line —
 * never read from a rendered neighbour, so a cell's colour is still a fact of
 * its address alone, and hiding a cell recolours none.
 *
 * [LAW:dataflow-not-control-flow] Built once per (palette, variation, dial
 * position, row, line, depth) and memoised, so a cell's entry is a lookup.
 * The variation's lineage and the dial's pressed shade are in the key because
 * the turn rule keeps a moved cell off the pressed shade they name.
 */
function lineAt(
  palette: Palette,
  decor: Decor,
  row: AddressStep | undefined,
  cell: AddressStep,
  drawnAt: ColorDepth,
): readonly DecorEntry[] {
  const { hues, run, keystones, open } = decor.variation;
  const key = [
    hues.join(","),
    run,
    keystones.join(","),
    open.join(","),
    decor.shade.tones.join(","),
    decor.shade.activated,
    row === undefined ? "" : stepKey(row),
    // One answer for every place along the line, so the cell is keyed at
    // the line's first.
    stepKey(cell, cell.lineStart),
    drawnAt,
  ].join("|");
  return LINES(palette, key, () =>
    turnsHeld(
      palette,
      decor,
      Array.from({ length: cell.lineEnd - cell.lineStart + 1 }, (_, at) =>
        dealtAt(
          palette,
          decor,
          row,
          { ...cell, index: cell.lineStart + at },
          drawnAt,
        ),
      ),
      drawnAt,
    ),
  );
}

// Every cell of every frame reads its line, and the line is a pure function
// of what the key names: one per drawn line of the bar per palette and depth.
const LINES = memoPerPalette<readonly DecorEntry[]>();

/**
 * A placed step as a memo key holds it, at place `at`: every field of it,
 * rather than what a place's deal reads of it today, so a keystone or a deal
 * that comes to read another field can never fold two lines into one answer.
 * [LAW:one-source-of-truth] The step is the key; no list of what is read
 * from it is kept beside the code that reads it.
 */
function stepKey(
  {
    axis,
    index,
    count,
    distribution,
    lineStart,
    lineEnd,
    ...unkeyed
  }: AddressStep,
  at: number = index,
): string {
  // [LAW:types-are-the-program] A field a step gains and this key does not
  // name is a compile error here, not two lines sharing one answer.
  const none: Record<string, never> = unkeyed;
  void none;
  return `${axis},${at},${count},${distributionName(distribution)},${lineStart},${lineEnd}`;
}

/**
 * A distribution's name in the table, which is what a memo key can hold.
 * [LAW:no-silent-failure] Every placer places by an entry of `DISTRIBUTIONS`
 * (`placedBy`), so a distribution outside it is a construction error, and
 * keying it by anything else could fold two lines into one answer.
 */
function distributionName(distribution: Distribution): DistributionName {
  const name = DISTRIBUTION_NAME.get(distribution);
  if (name === undefined)
    throw new Error("decorEntryFor: a cell placed outside DISTRIBUTIONS");
  return name;
}

const DISTRIBUTION_NAME = new Map<Distribution, DistributionName>(
  DISTRIBUTION_NAMES.map((name) => [DISTRIBUTIONS[name], name]),
);

/**
 * A line of cells as it is drawn: `dealt`, each place's entry, side by side,
 * with every hue turn held apart. A dial window keeps one hue's tones apart
 * at a depth, and the distribution keeps neighbours of one hue on different
 * tones; nothing in either keeps two hues apart where a line turns from one
 * to the other, and at 256 colours and ansi two hues' rungs often round onto
 * one entry or slot. So where the two cells either side of a turn are drawn
 * as one colour, the cell after the turn takes the first tone of its own
 * window drawn as neither of its neighbours, else the nearest rung of its
 * ladder that is (`widen`). Both neighbours, because its other neighbour is
 * of its own hue, kept apart from it by the distribution: a tone drawn like
 * that one would move the collision one seam over. And drawn as neither of
 * them nor the shade an open trigger on the bar wears (`drawnPress` at
 * depth 0): a trigger can stand beside the cell that moves, and the press
 * keeps apart only from the tones the windows deal, because a band's colours
 * never depend on where its trigger stands, so a rung past a window is one the
 * press cannot see. A cell's neighbours are a fact of its address, so the
 * cell is the one that keeps off the press. Where its ladder has no such
 * rung, the cell before the turn takes one by the same rule. Where neither
 * has one, the two take a rung apart from their neighbours alone, in the
 * same order, and a trigger beside the one that moves shares its colour;
 * where neither has even that, both keep what they were dealt and the
 * joiner's lift draws the seam. The line is read from its first place to its
 * last, so a cell with a turn on each side (one cell between two keystones)
 * is decided against the cell before it as that one finally stands, and
 * every seam behind the place being read stays held. That reading is why the
 * cell after the turn moves first: it is the one not yet read, so no cell
 * already read changes unless the cell after has nothing to give. A keystone
 * ending a line is therefore the cell that moves wherever it has a rung to
 * give, and one starting a line keeps its shade wherever the cell after it
 * has one.
 *
 * Alike means drawn as one colour, by identity after rounding, as the window
 * decides it; nothing measures a distance between two colours. A cell keeps
 * its own hue whatever it is dealt, so a row still reads in the hues its
 * variation names.
 *
 * [LAW:single-enforcer] The one rule for a hue turn: a bar line
 * (`decorEntryFor`) and the theme preview's swatches (`vocabularyOf`) both
 * meet across hues through it. A band's items are one hue, so they have no
 * turn to hold.
 */
function turnsHeld(
  palette: Palette,
  decor: Decor,
  dealt: readonly DecorEntry[],
  drawnAt: ColorDepth,
): readonly DecorEntry[] {
  const line = [...dealt];
  const drawn = (at: number): string | undefined => {
    const entry = line[at];
    return entry && drawnIn(palette, entry.hue, drawnAt)(entry.shade);
  };
  // Every trigger on the bar opens its lineage at depth 0, whatever its row
  // or place (`decorationFor`), so what an open trigger on the bar wears is
  // one colour for the whole bar, known without a position: the rule keeps a
  // cell off it by the cell's address alone.
  const pressed = drawnPress(palette, { decor, depth: 0 }, drawnAt);
  // The entry `at` takes to stand apart from the cells either side of it and
  // from every colour `off` names: its own hue, at the first tone of its
  // window, else the nearest rung of its ladder, drawn as none of them.
  const apart = (
    at: number,
    off: readonly string[],
  ): DecorEntry | undefined => {
    // [LAW:no-defensive-null-guards] `at` is a place on the line.
    const { hue } = line[at]!;
    const taken = [drawn(at - 1), drawn(at + 1), ...off].filter(
      (colour): colour is string => colour !== undefined,
    );
    const window = windowAt(palette, hue, decor.shade, drawnAt);
    const tone =
      window.find((t) => !taken.includes(drawnIn(palette, hue, drawnAt)(t))) ??
      widen(palette, hue, window, taken, drawnAt);
    return tone === undefined ? undefined : { hue, shade: tone };
  };
  // [LAW:dataflow-not-control-flow] Who moves, in the order the rule names,
  // as data: the cell after the turn, then the one before it, each kept off
  // the press as well, then each kept off its neighbours alone.
  const moves = (at: number) =>
    [[pressed], []].flatMap((off) =>
      [at, at - 1].map((place) => ({ place, off })),
    );
  for (let at = 1; at < line.length; at++) {
    if (line[at - 1]!.hue === line[at]!.hue || drawn(at - 1) !== drawn(at))
      continue;
    for (const { place, off } of moves(at)) {
      const entry = apart(place, off);
      if (entry === undefined) continue;
      line[place] = entry;
      break;
    }
  }
  return line;
}

// Whether a cell stands at a keystone place, read off its authored place and
// the ends of the line it is drawn on: a line's last place is the last leaf
// laid along it, through any group nested in the row. A node alone on an axis
// (an absent step) is that axis's first child and its last.
// [LAW:dataflow-not-control-flow] One predicate per place, in a table the
// variation's list indexes.
const KEYSTONE_AT: Record<
  Keystone,
  (row: AddressStep | undefined, cell: AddressStep | undefined) => boolean
> = {
  "bar-start": (row, cell) =>
    (row?.index ?? 0) === 0 && (cell?.index ?? 0) === 0,
  "line-start": (_row, cell) =>
    cell === undefined || cell.index === cell.lineStart,
  "line-end": (_row, cell) => cell === undefined || cell.index === cell.lineEnd,
};

/**
 * The ground an open menu's rows sit on, at every depth of nesting: Textual's
 * `surface`, the theme's own colour for the panels its widgets are laid on.
 */
export const PLANE_ROLE = "surface";

/**
 * The colour of one vocabulary entry in `palette`: the palette's own entry for
 * the role at that shade, byte for byte. [LAW:one-source-of-truth] The one
 * place an entry becomes a colour — `decorFor` renders a closed cell through
 * it and `bandFor` a menu's items. [LAW:types-are-the-program] Every role this
 * module names is a `PaletteRole`, which `Palette.get` answers with a colour on
 * every palette, so a name outside them stops compiling.
 */
export const decorEntryColour = (
  palette: Palette,
  entry: DecorEntry,
): ColorRgba => palette.get(shadeRole(entry.hue, entry.shade));

/** A node's decorative background: the colour of the entry its address selects. */
export const decorFor = (
  palette: Palette,
  decor: Decor,
  address: Address,
  drawnAt: ColorDepth,
): ColorRgba =>
  decorEntryColour(palette, decorEntryFor(palette, decor, address, drawnAt));

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
      .map((role) => palette.get(role))
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
 * window at the depth drawn (`windowAt`), as the palette names each — the
 * same entries a bar row wears in its row's hue, so a menu's items are a
 * variation on the colour of the header that opened it (Brandon,
 * brandon-menus-sjhy.4fi), and no item is a colour the theme does not name.
 * In tone order, read by `bandItemFor`.
 */
export const bandEntries = (
  palette: Palette,
  disclosure: Disclosure,
  drawnAt: ColorDepth,
): readonly DecorEntry[] =>
  windowAt(palette, hueOf(disclosure), disclosure.decor.shade, drawnAt).map(
    (shade) => ({ hue: hueOf(disclosure), shade }),
  );

/**
 * The shade a pressed button wears in the band `disclosure` opens, drawn at
 * `drawnAt`: the dial's activated shade in the band's hue (`Shade.activated`),
 * widened along the ladder (`widen`) where the depth draws it as a colour the
 * band's layout puts beside it. A pressed shade stands in two places by
 * construction: the band's ✕ and blank leads open each of its rows, beside
 * its items; and the trigger that opened it stands among its own neighbours —
 * the bar's cells for a band opened from the bar, else the items and the
 * leads of the band one depth up, whose pressed shade the leads wear. So it
 * keeps apart from every tone of the band's own window, from every tone the
 * trigger's neighbours are dealt, and from the pressed shade one depth up.
 * Where the role's whole ladder draws as those colours it keeps the dial's
 * shade: there is no other to give, and the joiner shows the seam. A bar
 * cell a hue turn moves past its window is not among them, because which
 * rung it takes depends on where it stands, and a band's colours never
 * depend on where its trigger stands; that cell keeps off this shade
 * instead, wherever its ladder has a rung to give (`turnsHeld`).
 *
 * [LAW:one-source-of-truth] Read by `bandFor`, so the trigger, its band's
 * leads and its ✕ wear one shade. [LAW:dataflow-not-control-flow] Built once
 * per (palette, decor, depth, drawn depth) and memoised.
 */
export function pressedAt(
  palette: Palette,
  disclosure: Disclosure,
  drawnAt: ColorDepth,
): RoleShade {
  const { decor, depth } = disclosure;
  const { variation, shade } = decor;
  const key = [
    depth,
    variation.open.join(","),
    variation.hues.join(","),
    variation.keystones.length,
    shade.tones.join(","),
    shade.activated,
    drawnAt,
  ].join("|");
  return PRESSED(palette, key, () => {
    const hue = hueOf(disclosure);
    const dealt = (at: DecorHue): string[] =>
      windowAt(palette, at, shade, drawnAt).map(drawnIn(palette, at, drawnAt));
    // Who stands beside the trigger: the bar's cells, in every hue a bar row
    // wears, or the band one depth up — its items, and its leads in its
    // pressed shade.
    const keystone: readonly DecorHue[] =
      variation.keystones.length > 0 ? [KEYSTONE_HUE] : [];
    const besideBand = (up: Disclosure): string[] => [
      ...dealt(hueOf(up)),
      drawnPress(palette, up, drawnAt),
    ];
    const besideTrigger =
      depth === 0
        ? [...variation.hues, ...keystone].flatMap(dealt)
        : besideBand({ decor, depth: depth - 1 });
    const taken = [...dealt(hue), ...besideTrigger];
    if (!taken.includes(drawnIn(palette, hue, drawnAt)(shade.activated)))
      return shade.activated;
    return (
      widen(palette, hue, [shade.activated], taken, drawnAt) ?? shade.activated
    );
  });
}

// Every pressed cell of every frame asks for its shade, and the answer is a
// pure function of what the key names.
const PRESSED = memoPerPalette<RoleShade>();

/**
 * The colour the pressed shade of the band `disclosure` opens is drawn in at
 * `drawnAt`: what its trigger, its ✕ and its blank leads are sent.
 * [LAW:one-source-of-truth] The shade `bandFor` reads, drawn as a window's
 * tones are, so what the press one depth down keeps apart from (`pressedAt`)
 * and what a cell at a hue turn keeps off (`turnsHeld`) are the colour this
 * press is drawn in. [LAW:dataflow-not-control-flow] A lookup of the
 * memoised shade.
 */
const drawnPress = (
  palette: Palette,
  disclosure: Disclosure,
  drawnAt: ColorDepth,
): string =>
  drawnIn(
    palette,
    hueOf(disclosure),
    drawnAt,
  )(pressedAt(palette, disclosure, drawnAt));

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
 * are what the cells on that plane wear, one per tone of the dial's window at
 * the depth drawn (`bandEntries`), which `bandItemFor` deals along a row as
 * the bar deals its shades, so neighbours differ by shade as the bar's do.
 */
export interface Band {
  readonly state: ColorRgba;
  readonly plane: ColorRgba;
  readonly items: readonly ColorRgba[];
}

/**
 * The band `disclosure` opens at `drawnAt`: the lineage's hue at its depth,
 * at its pressed shade (`pressedAt`), on the theme's `PLANE_ROLE`, its items
 * that hue's window at the depth. The trigger of the band and the band itself
 * are the SAME value read twice, so they cannot disagree about which hue they
 * share.
 *
 * [LAW:one-source-of-truth] Selected, never searched: the colours are the
 * palette's own, unrounded, and the SGR writer rounds each once at the depth
 * it draws, as it does a closed cell's. Nothing here measures one colour
 * against another: a shade moves along its ladder only where the depth draws
 * it as the very colour of a neighbour, text is chosen for its cell where it
 * is drawn (`textOn`), and the joiner owns every seam.
 */
export function bandFor(
  palette: Palette,
  disclosure: Disclosure,
  drawnAt: ColorDepth,
): Band {
  return {
    state: palette.get(
      shadeRole(hueOf(disclosure), pressedAt(palette, disclosure, drawnAt)),
    ),
    plane: palette.get(PLANE_ROLE),
    items: bandEntries(palette, disclosure, drawnAt).map((entry) =>
      decorEntryColour(palette, entry),
    ),
  };
}

/**
 * The colour of the item `place` places in the band `disclosure` opens: one of
 * the band's `items`, picked by that step as the bar's cell picks its shade
 * (`decorEntryFor`), under its distribution's own rule — one placement
 * mechanism at every level, so a menu row walks its hue's window as a bar row
 * does. A picker's option is one step, its index over the WHOLE option
 * domain, so paging never recolours it; an absent step (a body that is one
 * segment) is placed where a first child is. Like a bar cell's, an item's
 * colour is a function of its place: a sibling hiding recolours nobody, so
 * the two cells either side of a hidden one, or neighbours an authored
 * distribution places on one tone, wear one item, and the joiner owns the
 * seam between them.
 */
export function bandItemFor(
  palette: Palette,
  disclosure: Disclosure,
  place: PlacedStep | undefined,
  drawnAt: ColorDepth,
): ColorRgba {
  return vocabularySelect(bandFor(palette, disclosure, drawnAt).items, place);
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
  const tint = bandItemFor(palette, disclosure, place, drawnAt);
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
  sameBy<AddressStep>({
    index: is,
    count: is,
    distribution: is,
    axis: is,
    lineStart: is,
    lineEnd: is,
  }),
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
      const entry = decorEntryFor(palette, decor, address, drawnAt);
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

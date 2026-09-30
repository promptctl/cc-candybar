// Memoized Palette construction over rich-js. cc-candybar moves theme
// NAMES and ThemeKey axes (data); rich-js owns every color value operation. Two
// memos live here: a theme name -> base palette, and a (base, ThemeKey) ->
// transposed palette. They compose — the per-render base palette feeds the
// per-render style transposition.
//
// [LAW:no-shared-mutable-globals] Single owner: this module. Both Maps are pure
// memos of pure rich-js functions, keyed by immutable inputs (resolved theme
// name; palette name + the four ThemeKey axes). rich-js palettes are immutable
// registry singletons, so a cached palette never goes stale. Key spaces are
// bounded by #themes and #themes × #declared styles (style axes bounded by the
// loaded configs' styles blocks) — both small. Shared on purpose: a theme's
// base palette and its gruvbox-under-`vivid` transposition are each computed
// once per process, not once per RenderCache entry or per render.
// Read/written only through the two functions below.

import { transposePalette, getThemePalette } from "@promptctl/rich-js";
import type { ThemeKey, Palette } from "@promptctl/rich-js";
import {
  finishSelection,
  FOLLOW_BAR,
  resolveSelection,
  retiredThemeNote,
  THEME_FLOOR,
  type Decided,
  type Selection,
} from "./policy.js";

const baseCache = new Map<string, Palette>();
const transposeCache = new Map<string, Palette>();

/**
 * The Palette for a theme name. Memoized.
 *
 * [LAW:single-enforcer] The one place a theme name becomes a Palette —
 * the per-render base palette and every placement's pinned `theme` both flow
 * through here. A name that does not resolve is registry/resolver drift, never
 * user error: the loader validates `globals.palette` and the set-state verb
 * validates session theme values against the resolvable set, so by the time a
 * name reaches here it must resolve. [LAW:no-defensive-null-guards] the throw is
 * the loud failure for that broken invariant, not a fallback.
 */
export function paletteForThemeName(name: string): Palette {
  const palette = basePaletteFor(name);
  if (palette === null) {
    throw new Error(
      `Palette "${name}" did not resolve in the theme registry — allowed ` +
        `names and the registry are inconsistent`,
    );
  }
  return palette;
}

// [LAW:one-source-of-truth] THE palette a placement renders in, from its
// `theme` setting: the bar's own palette (the render's theme under its style)
// when it follows the bar, else the named theme — a pin, which ignores the
// bar's theme and style alike. The render's walk and the placement-theme
// picker's option cells both read it, so an option paints what picking it
// would draw.
export function placementPalette(theme: string, bar: Palette): Palette {
  return theme === FOLLOW_BAR ? bar : paletteForThemeName(theme);
}

// [LAW:single-enforcer] THE name → base Palette construction, and the one memo
// over it. Answering null rather than throwing is what lets its two callers
// differ in the only way they must: a PRE-VALIDATED name (a config default the
// loader checked, a session pick the set-state gate admitted, a placement's `theme`)
// treats absence as registry drift and throws above; a name a RULE produced
// (brandon-themes-dzl) treats it as an author mistake, collapses to the floor and
// reports. Two absence policies, one construction — a second `getThemePalette`
// call beside this one would be a second place a theme name becomes a palette.
function basePaletteFor(name: string): Palette | null {
  const hit = baseCache.get(name);
  if (hit !== undefined) return hit;

  const palette = getThemePalette(name);
  if (palette === null) return null;
  baseCache.set(name, palette);
  return palette;
}

/**
 * `base` transposed by a full ThemeKey — the adapted-palette constructor:
 * (base palette, key) → palette. The caller composes whatever axes it carries
 * (a style's four axes) into ONE key and this makes ONE transposePalette call — never chain
 * two transpositions: chaining double-pays OKLCH quantization AND collides this
 * memo (a transposed palette keeps the base palette's name, so a re-transposed
 * gruvbox-with-style and plain gruvbox would share cache keys).
 *
 * [LAW:dataflow-not-control-flow] The key is data; the identity key flows
 * through transposePalette's isIdentityKey fast-path (byte-exact, no
 * round-trip) — no branch here. rich-js hue-locks ANCHORED_ROOTS
 * (error/success/warning), so semantic meaning is preserved by construction —
 * no local exemption list to drift.
 *
 * [LAW:single-enforcer] The sole place a transposed palette is built — a
 * future style `roles` remap is additive at this one seam. The memo miss
 * (undefined) is genuine optionality — not-yet-computed — not a defended
 * invariant. [LAW:one-source-of-truth] The cache key carries every axis of the
 * ThemeKey: two keys differing on any axis are distinct palettes.
 */
export function transposedPalette(base: Palette, key: ThemeKey): Palette {
  const cacheKey =
    `${base.name} ${key.hueShift} ${key.chromaScale} ` +
    `${key.lightnessScale} ${key.lightnessShift}`;
  const hit = transposeCache.get(cacheKey);
  if (hit !== undefined) return hit;

  const transposed = transposePalette(base, key);
  transposeCache.set(cacheKey, transposed);
  return transposed;
}

// ─── The theme as a name-or-rule selection (brandon-themes-dzl) ──────────────

// The theme instances of `Selection`/`Decided`. A theme's `value` is the base
// Palette the name denotes — carried beside the name because ONE lookup produced
// both, so a label and the palette the bar wears cannot disagree
// [LAW:one-source-of-truth]. This is also what lets `renderDsl` take no
// `basePalette` argument: a palette handed in beside a name would be a second
// clock, free to say gruvbox while the label said nord.
export type ThemeSelection = Selection<Palette>;
export type DecidedTheme = Decided<Palette>;

// One rung's contribution: the theme this name selects, or null when it names
// nothing installed — which is not a pick at all, so the fold moves on.
//
// [LAW:polishing-by-subtraction] The construction IS the membership test. The
// theme domain was described as OPEN, with no membership to check; that was true
// only because every rung reaching `paletteForThemeName` had been pre-validated
// elsewhere. `basePaletteFor` answering null is the one membership fact, so
// asking `listResolvablePaletteNames().includes(...)` first would be the same
// question twice — and the second answer could only ever restate the first.
function namedTheme(name: string): DecidedTheme | null {
  const value = basePaletteFor(name);
  return value === null ? null : { kind: "decided", name, value };
}

// [LAW:single-enforcer] The membership policy for a theme NAME, wherever the
// name came from — a config default, a session pick, or an expression's RESULT.
// An installed theme decides; anything else is the floor, and SAYS SO.
//
// The report is what makes this the theme's version rather than a copy of
// `decideStyleName`: that floor is the identity adaptation, so collapsing to it in
// silence leaves a bar that simply wears no style. This floor is a specific
// palette, so a silent collapse would leave the bar in a theme nobody asked for
// with nothing to point at [LAW:no-silent-failure]. It is reported rather than
// thrown because the value is DATA-driven: an expression can be correct for a
// week and then name nothing when a threshold moves, and a throw would take the
// whole statusline away (the strip alone, no bar) at exactly that moment.
//
// [LAW:effects-at-boundaries] `onUnresolvable` is a capability the caller hands
// in — the message belongs to this domain, the channel does not. The one return
// type also means this and `decideStyleName` are interchangeable as
// `finishSelection`'s `decide`.
//
// `where` names the path(s) the rule was written at, since a rule may live in the
// config's own globals or in a preset's — the report must send the reader to the
// fragment that holds it (brandon-themes-owl).
export function decideThemeName(
  name: string,
  where: string,
  onUnresolvable: (message: string) => void,
): DecidedTheme {
  const named = namedTheme(name);
  if (named !== null) return named;
  onUnresolvable(
    `${where} rendered "${THEME_FLOOR}": "${name}" names no installed theme${retiredThemeNote(name)}`,
  );
  return themeFloor();
}

// The theme a render should use, as far as it can be known before the render
// runs [LAW:one-type-per-behavior] — `resolveSelection` with the theme's own two
// values. The floor cannot report, because no name failed to resolve: reaching it
// is the ordinary "nothing was declared" answer.
export function resolveThemeSelection(
  stagedPalette: string | undefined,
  sessionTheme: string | null,
  globalsPalette: string | undefined,
): ThemeSelection {
  return resolveSelection(
    stagedPalette,
    sessionTheme,
    globalsPalette,
    themeFloor(),
    namedTheme,
  );
}

// [LAW:one-source-of-truth] THE floor as a decided selection — what
// `decideThemeName` collapses to, what the rung below every other rung is, and
// what a compile-only path answers a rule with. Spelled once so the three do not
// drift, and because the non-null assertion wants stating once: the floor is a
// palette this package SHIPS, so it asserts a fact rather than defending one (and
// `paletteForThemeName` would throw loudly first if that ever stopped being true).
function themeFloor(): DecidedTheme {
  return namedTheme(THEME_FLOOR)!;
}

// The base palette before any render has happened: the theme the config declares,
// or the floor when that slot holds a RULE only a render can settle. A rule's
// answer is not WRONG here, it is unknowable — no store has been filled yet — so
// it collapses to the same floor a rule naming nothing does, and there is nothing
// to report because no name failed [LAW:no-silent-failure].
//
// [LAW:dataflow-not-control-flow] `finishSelection` with a settle that yields
// the floor: one value, no arm on the discriminator.
export function declaredBasePalette(
  globalsPalette: string | undefined,
): Palette {
  return finishSelection(
    resolveThemeSelection(undefined, null, globalsPalette),
    themeFloor,
  ).value;
}

// Memoized PaletteResolver construction over rich-js. cc-candybar moves theme
// NAMES and hue shifts (data); rich-js owns every color value operation. Two
// memos live here: a theme name -> base resolver, and a (base, hueShift) ->
// transposed resolver. They compose — the per-render base palette feeds the
// per-segment transposition.
//
// [LAW:no-shared-mutable-globals] Single owner: this module. Both Maps are pure
// memos of pure rich-js functions, keyed by immutable inputs (resolved theme
// name; palette name + hueShift). rich-js palettes are immutable registry
// singletons, so a cached resolver never goes stale. Key spaces are bounded by
// #themes and #themes × #distinct hueShifts (hueShift = segIndex*hueStep,
// segIndex bounded by layout) — both small. Shared on purpose: a theme's base
// resolver and its gruvbox+42° transposition are each computed once per process,
// not once per RenderCache entry or per render. Read/written only through the
// two functions below.

import {
  PaletteResolver,
  transposePalette,
  getThemePalette,
} from "@promptctl/rich-js";
import type { ThemeKey } from "@promptctl/rich-js";
import { resolvePaletteName } from "./policy.js";

const baseCache = new Map<string, PaletteResolver>();
const transposeCache = new Map<string, PaletteResolver>();

/**
 * The PaletteResolver for a theme name (aliases resolved). Memoized.
 *
 * [LAW:single-enforcer] The one place a theme name becomes a PaletteResolver —
 * the per-render base palette and per-segment `palette:` overrides both flow
 * through here. A name that does not resolve is registry/resolver drift, never
 * user error: the loader validates `globals.palette` and the set-state verb
 * validates session theme values against the resolvable set, so by the time a
 * name reaches here it must resolve. [LAW:no-defensive-null-guards] the throw is
 * the loud failure for that broken invariant, not a fallback.
 */
export function resolverForThemeName(name: string): PaletteResolver {
  const resolved = resolvePaletteName(name);
  const hit = baseCache.get(resolved);
  if (hit !== undefined) return hit;

  const palette = getThemePalette(resolved);
  if (palette === null) {
    throw new Error(
      `Palette "${name}" (resolved "${resolved}") did not resolve in the ` +
        `theme registry — allowed names and the registry are inconsistent`,
    );
  }
  const resolver = new PaletteResolver(palette);
  baseCache.set(resolved, resolver);
  return resolver;
}

/**
 * The PaletteResolver for `base`'s palette transposed by `hueShift` degrees.
 *
 * [LAW:dataflow-not-control-flow] hueShift is data; 0 flows through
 * transposePalette's identity fast-path (byte-exact, no round-trip) — no branch
 * here. Chroma and lightness are held identity: only hue rotates. rich-js
 * hue-locks ANCHORED_ROOTS (error/success/warning), so semantic meaning is
 * preserved by construction — no local exemption list to drift.
 *
 * [LAW:single-enforcer] The sole place a transposed resolver is built. The memo
 * miss (undefined) is genuine optionality — not-yet-computed — not a defended
 * invariant.
 */
export function transposedResolver(
  base: PaletteResolver,
  hueShift: number,
): PaletteResolver {
  const cacheKey = `${base.palette.name} ${hueShift}`;
  const hit = transposeCache.get(cacheKey);
  if (hit !== undefined) return hit;

  const key: ThemeKey = {
    hueShift,
    chromaScale: 1,
    lightnessScale: 1,
    lightnessShift: 0,
  };
  const resolver = new PaletteResolver(transposePalette(base.palette, key));
  transposeCache.set(cacheKey, resolver);
  return resolver;
}

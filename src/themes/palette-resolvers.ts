// Memoized Palette construction over rich-js. cc-candybar moves theme
// NAMES and ThemeKey axes (data); rich-js owns every color value operation. Two
// memos live here: a theme name -> base palette, and a (base, ThemeKey) ->
// transposed palette. They compose — the per-render base palette feeds the
// per-segment transposition (the session look's axes + the segment's hue shift,
// folded into one key by the caller).
//
// [LAW:no-shared-mutable-globals] Single owner: this module. Both Maps are pure
// memos of pure rich-js functions, keyed by immutable inputs (resolved theme
// name; palette name + the four ThemeKey axes). rich-js palettes are immutable
// registry singletons, so a cached palette never goes stale. Key spaces are
// bounded by #themes and #themes × #declared looks × #distinct hueShifts
// (hueShift = look shift + segIndex*hueStep, segIndex bounded by layout; look
// axes bounded by the loaded configs' looks blocks) — both small. Shared on
// purpose: a theme's base palette and its gruvbox+42° transposition are each
// computed once per process, not once per RenderCache entry or per render.
// Read/written only through the two functions below.

import { transposePalette, getThemePalette } from "@promptctl/rich-js";
import type { ThemeKey, Palette } from "@promptctl/rich-js";
import { resolvePaletteName } from "./policy.js";

const baseCache = new Map<string, Palette>();
const transposeCache = new Map<string, Palette>();

/**
 * The Palette for a theme name (aliases resolved). Memoized.
 *
 * [LAW:single-enforcer] The one place a theme name becomes a Palette —
 * the per-render base palette and per-segment `palette:` overrides both flow
 * through here. A name that does not resolve is registry/resolver drift, never
 * user error: the loader validates `globals.palette` and the set-state verb
 * validates session theme values against the resolvable set, so by the time a
 * name reaches here it must resolve. [LAW:no-defensive-null-guards] the throw is
 * the loud failure for that broken invariant, not a fallback.
 */
export function paletteForThemeName(name: string): Palette {
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
  baseCache.set(resolved, palette);
  return palette;
}

/**
 * `base` transposed by a full ThemeKey — the adapted-palette constructor:
 * (base palette, key) → palette. The caller
 * composes whatever axes it carries (a look's four axes, the per-segment hue
 * shift) into ONE key and this makes ONE transposePalette call — never chain
 * two transpositions: chaining double-pays OKLCH quantization AND collides this
 * memo (a transposed palette keeps the base palette's name, so a re-transposed
 * gruvbox-with-look and plain gruvbox would share cache keys).
 *
 * [LAW:dataflow-not-control-flow] The key is data; the identity key flows
 * through transposePalette's isIdentityKey fast-path (byte-exact, no
 * round-trip) — no branch here. rich-js hue-locks ANCHORED_ROOTS
 * (error/success/warning), so semantic meaning is preserved by construction —
 * no local exemption list to drift.
 *
 * [LAW:single-enforcer] The sole place a transposed palette is built — a
 * future look `roles` remap is additive at this one seam. The memo miss
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

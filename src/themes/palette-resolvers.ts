// [LAW:no-shared-mutable-globals] Two pure memos over rich-js, keyed immutably.

import { transposePalette, getThemePalette } from "@promptctl/rich-js";
import type { ThemeKey, Palette } from "@promptctl/rich-js";
import { resolvePaletteName } from "./policy.js";

const baseCache = new Map<string, Palette>();
const transposeCache = new Map<string, Palette>();

/**
 * [LAW:single-enforcer][LAW:no-defensive-null-guards] The one place a theme name
 * becomes a Palette; a name that fails here is registry drift, so it throws.
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
 * [LAW:single-enforcer][LAW:one-source-of-truth][LAW:dataflow-not-control-flow]
 * The sole place a transposed palette is built, keyed on every axis; chaining
 * two would double-pay OKLCH quantization and collide this memo.
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

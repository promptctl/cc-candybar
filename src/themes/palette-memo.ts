// [LAW:one-type-per-behavior] The one memo the themes module caches a
// per-palette answer through — the text chosen in decor.ts, a transposition in
// palette-resolvers.ts: `compute` runs once per (palette, key).
//
// [LAW:one-source-of-truth] Keyed on the palette OBJECT, so an answer belongs to
// exactly the palette it was computed for: a transposed palette keeps its base's
// name, so keyed by name, two palettes would share one answer. A palette's
// answers go when it does.

import type { Palette } from "@promptctl/rich-js";

export function memoPerPalette<V extends {}>(): (
  palette: Palette,
  key: string,
  compute: () => V,
) => V {
  const memo = new WeakMap<Palette, Map<string, V>>();
  return (palette, key, compute) => {
    let entries = memo.get(palette);
    if (entries === undefined) {
      entries = new Map();
      memo.set(palette, entries);
    }
    const hit = entries.get(key);
    if (hit !== undefined) return hit;
    const value = compute();
    entries.set(key, value);
    return value;
  };
}

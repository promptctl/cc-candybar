// [LAW:one-source-of-truth] THE parser for what a `persist`/`reset` key may name.
// Every target is also a path into the config file, projected once by persistPath.

import type { Globals } from "../dsl-types.js";
import { isGlobalsField } from "./globals.js";

export type PersistTarget =
  | { readonly scope: "globals"; readonly field: keyof Globals }
  | { readonly scope: "segment-palette"; readonly segment: string }
  // A structural edit lands in the ROW of the cascade that holds the segment.
  | { readonly scope: "preset-root"; readonly preset: string };

// [LAW:locality-or-seam] Reuses SegmentDecl.vars' `<segment>.<name>` idiom.
const SEGMENT_PALETTE_KEY = /^segments\.([^.]+)\.palette$/;
// [LAW:one-source-of-truth] GREEDY capture: a dot is a legal preset name, and the
// anchored ".root" suffix makes `(.+)` backtrack to recover the full name.
const PRESET_ROOT_KEY = /^presets\.(.+)\.root$/;

// [LAW:one-source-of-truth] The inverse of PRESET_ROOT_KEY, so the two cannot drift.
export function presetRootKey(name: string): string {
  return `presets.${name}.root`;
}

export function parsePersistTarget(key: string): PersistTarget | null {
  if (isGlobalsField(key)) return { scope: "globals", field: key };
  const segmentMatch = SEGMENT_PALETTE_KEY.exec(key);
  if (segmentMatch)
    return { scope: "segment-palette", segment: segmentMatch[1]! };
  const presetMatch = PRESET_ROOT_KEY.exec(key);
  return presetMatch ? { scope: "preset-root", preset: presetMatch[1]! } : null;
}

// [LAW:types-are-the-program] A path as steps, so a dotted preset name is one step.
export type ConfigPath = readonly string[];

export function persistPath(
  target: Exclude<PersistTarget, { scope: "preset-root" }>,
): ConfigPath {
  return target.scope === "globals"
    ? ["globals", target.field]
    : ["segments", target.segment, "palette"];
}

// [LAW:one-source-of-truth] THE parser for what a `persist`/`reset` action's
// key STRING may legally name — the single place a key is classified as a
// Globals field, a per-segment palette pin, or a preset's layout root, so
// cross-ref validation (load time), the config-file store (write/delete),
// and the daemon's write-gate all classify a key through ONE authority
// instead of three independently-drifting checks.
//
// [LAW:types-are-the-program] A discriminated union, not a bag of optional
// fields: every legal key shape is representable, every illegal one
// collapses to `null` at exactly this one boundary — no downstream consumer
// re-parses the string itself.
//
// [LAW:one-source-of-truth] Every target is ALSO a path into the config file
// (candybar-config-dqe): the file is the one durable store, so a persist key
// is nothing more than the spelling of where in that file the value lives.
// `persistPath` is that projection, stated once; the writer splices at it,
// `reset` deletes it, and "is this preset customized" asks whether the file
// authors it.

import type { Globals } from "../dsl-types.js";
import { isGlobalsField } from "./globals.js";

export type PersistTarget =
  | { readonly scope: "globals"; readonly field: keyof Globals }
  | { readonly scope: "segment-palette"; readonly segment: string }
  // The layout one preset renders. A structural edit (remove/insert a
  // segment) lands in the ROW of the cascade that holds the segment —
  // `presets.<name>.root` or the config's own `root`, the file's or the
  // bundled default's — resolved by the config-file store per click.
  | { readonly scope: "preset-root"; readonly preset: string };

// [LAW:locality-or-seam] `segments.<name>.palette` reuses the SAME dotted
// namespacing SegmentDecl.vars already uses for segment-local variables
// (`<segment>.<var>`, declared in src/dsl/render.ts) — one idiom for "a name
// scoped under a segment", not a bespoke second syntax invented for persist
// targets alone. `presets.<name>.root` mirrors it one level up and IS the
// config-file path of the tree it edits — presetRoot()'s reported path
// (src/config/presets.ts) spells the same string, so a diagnostic and a
// write name one location.
const SEGMENT_PALETTE_KEY = /^segments\.([^.]+)\.palette$/;
// [LAW:one-source-of-truth] GREEDY capture, not `[^.]+` — a preset name is
// validated only non-empty/slash/newline-free (loader/presets.ts), so a dot
// is a legal preset name (e.g. "v1.compact"). presetRootKey always appends
// the literal ".root" suffix, so a greedy `(.+)` backtracks to the RIGHTMOST
// occurrence of that anchored suffix and correctly recovers the full name
// for ANY preset name, dotted or not — round-tripping presetRootKey exactly.
const PRESET_ROOT_KEY = /^presets\.(.+)\.root$/;

// [LAW:one-source-of-truth] THE builder for a preset's root key — the
// inverse of PRESET_ROOT_KEY's parse. edit-chrome.ts's synthesis and
// config-validators.ts's always-registered contribution both import it, so
// the two write-side spellings cannot drift from the read-side regex.
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

// [LAW:types-are-the-program] A config-file path as its steps — the shape
// json5-edit's setValue/deleteValue/nodeAt navigate by — so a dotted preset
// name is one step, never re-split on "." downstream.
export type ConfigPath = readonly string[];

export function persistPath(
  target: Exclude<PersistTarget, { scope: "preset-root" }>,
): ConfigPath {
  return target.scope === "globals"
    ? ["globals", target.field]
    : ["segments", target.segment, "palette"];
}

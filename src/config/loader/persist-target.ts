// [LAW:one-source-of-truth] THE parser for what a `persist`/`reset` action's
// key STRING may legally name — the single place a key is classified as a
// Globals field (candybar-config-engine-71o.3's scope) or a per-segment
// palette override (candybar-config-engine-71o.6's scope), so cross-ref
// validation (load time), the config-overrides store (write/read), and the
// daemon's write-gate all classify a key through ONE authority instead of
// three independently-drifting `isGlobalsField` checks.
//
// [LAW:types-are-the-program] A discriminated union, not a bag of optional
// fields: every legal key shape is representable, every illegal one
// collapses to `null` at exactly this one boundary — no downstream consumer
// re-parses the string itself.

import type { Globals } from "../dsl-types.js";
import { isGlobalsField } from "./globals.js";

export type PersistTarget =
  | { readonly scope: "globals"; readonly field: keyof Globals }
  | { readonly scope: "segment-palette"; readonly segment: string };

// [LAW:locality-or-seam] `segments.<name>.palette` reuses the SAME dotted
// namespacing SegmentDecl.vars already uses for segment-local variables
// (`<segment>.<var>`, declared in src/dsl/render.ts) — one idiom for "a name
// scoped under a segment", not a bespoke second syntax invented for persist
// targets alone.
const SEGMENT_PALETTE_KEY = /^segments\.([^.]+)\.palette$/;

export function parsePersistTarget(key: string): PersistTarget | null {
  if (isGlobalsField(key)) return { scope: "globals", field: key };
  const match = SEGMENT_PALETTE_KEY.exec(key);
  return match ? { scope: "segment-palette", segment: match[1]! } : null;
}

// [LAW:types-are-the-program] Wire-level snapshot shapes for the `debug` message: the
// `what` discriminator carries the response shape, so there is no `data: unknown`.

import type { VarType, VarValue } from "../var-system/types";
import type { DslConfig, SourceKind } from "../config/dsl-types";

// [LAW:one-source-of-truth] DebugWhat is DERIVED from this tuple, so a new entry makes
// buildDebugSnapshot's switch non-exhaustive until an arm is added.
export const DEBUG_WHATS = ["vars", "segments", "config"] as const;
export type DebugWhat = (typeof DEBUG_WHATS)[number];

// [LAW:one-source-of-truth] A wire-side guard written in terms of DEBUG_WHATS, so it cannot drift.
export function isDebugWhat(v: unknown): v is DebugWhat {
  return (
    typeof v === "string" && (DEBUG_WHATS as readonly string[]).includes(v)
  );
}

export interface VarSnapshot {
  readonly name: string;
  readonly source: SourceKind | null;
  // "document" for a `parse: { json }` source; its `value` is then the document's JSON text.
  readonly type: VarType | "document";
  // Reading a Computed here triggers re-evaluation if MobX invalidated the cache.
  readonly value: VarValue;
  readonly lastError: {
    readonly timestampMs: number;
    readonly message: string;
  } | null;
  // Null (distinct from 0) means no age tracking applies, not "just updated".
  readonly ageMs: number | null;
}

export interface SegmentSnapshot {
  readonly name: string;
  readonly template: string;
  // Static analysis: runtime deps may be a subset, but every name returned IS in the store.
  readonly referencedVars: readonly string[];
  readonly lastRender: string | null;
}

// [LAW:types-are-the-program] The union forbids a response whose data contradicts its `what`.
export type DebugSnapshot =
  | { readonly what: "vars"; readonly vars: readonly VarSnapshot[] }
  | {
      readonly what: "segments";
      readonly segments: readonly SegmentSnapshot[];
    }
  | { readonly what: "config"; readonly config: DslConfig | null };

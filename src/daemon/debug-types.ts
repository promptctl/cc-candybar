// [LAW:types-are-the-program] Wire-level snapshot shapes for the `debug`
// protocol message. The `what` discriminator carries the response shape
// forward — a client requesting "vars" gets vars data, "segments" gets
// segments data, "config" gets config data. There is no `data: unknown`
// field that callers must shape-check.
//
// [LAW:one-source-of-truth] These types are the single contract between the
// daemon's introspection layer (src/daemon/debug.ts) and any external
// consumer (the future `cc-candybar vars` / `lint` CLIs, debug tooling).
// The protocol wraps them; the introspector produces them.
//
// Lives in its own module to break a potential cycle: protocol.ts re-exports
// these for the wire type, debug.ts produces them, and both could otherwise
// pull each other in.

import type { VarType, VarValue } from "../var-system/types";
import type { DslConfig, SourceKind } from "../config/dsl-types";

export type DebugWhat = "vars" | "segments" | "config";

// [LAW:one-source-of-truth] Canonical enumeration. The wire validator and
// any tooling that lists supported `what` values reads from here.
export const DEBUG_WHATS: readonly DebugWhat[] = Object.freeze([
  "vars",
  "segments",
  "config",
]);

// Wire-side type guard for an untrusted JSON value. Used by the daemon at
// the request boundary; symmetrically usable by future CLI shims that
// validate user input before sending the frame.
export function isDebugWhat(v: unknown): v is DebugWhat {
  return v === "vars" || v === "segments" || v === "config";
}

// One row of the `vars` snapshot. Captures everything an operator needs to
// answer "is this variable computing? did it fail? when did it last update?"
// without re-reading config or grepping logs.
export interface VarSnapshot {
  readonly name: string;
  // The DSL source kind that declared this variable (literal/env/input/...).
  // null when a variable exists in the store but was not declared via DSL —
  // present for completeness so a programmatic-only var still shows up in
  // introspection rather than being silently invisible.
  readonly source: SourceKind | null;
  readonly type: VarType;
  // Current store value. For Computed nodes this triggers re-evaluation if
  // MobX has invalidated the cache; for Box nodes it is the last value set.
  readonly value: VarValue;
  readonly lastError: {
    readonly timestampMs: number;
    readonly message: string;
  } | null;
  // Wall-clock ms since the box was last set (Box) or null for Computed
  // nodes whose freshness is governed by MobX invalidation, not a single
  // timestamp. Null is structurally distinct from 0 so consumers can
  // distinguish "no age tracking applies" from "just updated."
  readonly ageMs: number | null;
}

// One row of the `segments` snapshot.
export interface SegmentSnapshot {
  readonly name: string;
  // The template source string (verbatim, as authored in the config).
  readonly template: string;
  // Names of variables potentially referenced by the template, found via
  // static analysis: dotted paths inside `{{ ... }}` actions, matched
  // against the store's declared names. Exact runtime deps may be a subset
  // (branches not taken), but every name returned IS in the store.
  readonly referencedVars: readonly string[];
  // The last rendered output for this segment, when the daemon has captured
  // one. null today — the daemon does not yet render through the DSL spine
  // (see bzh.2). Populated when the daemon flips to renderDslLine.
  readonly lastRender: string | null;
}

// [LAW:types-are-the-program] The discriminated union ensures every response
// carries exactly the data shape its `what` promises. There is no path that
// produces e.g. `{ what: "vars", segments: [...] }` — the type forbids it.
export type DebugSnapshot =
  | { readonly what: "vars"; readonly vars: readonly VarSnapshot[] }
  | {
      readonly what: "segments";
      readonly segments: readonly SegmentSnapshot[];
    }
  | { readonly what: "config"; readonly config: DslConfig | null };

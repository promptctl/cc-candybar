// [LAW:single-enforcer] One module owns the projection from daemon DSL
// state (VariableStore + SourceRegistry + DslConfig + CompiledConfig) to
// the wire-level DebugSnapshot. buildDebugSnapshot dispatches via an
// exhaustive switch on `what` — TypeScript enforces every DebugWhat arm
// at compile time (the function's return-type narrowing fails if a case
// is missing), so adding a new `what` requires one new arm here, one new
// DEBUG_WHATS entry, and one new DebugSnapshot variant — the type system
// keeps the three sites in lockstep.
//
// [LAW:one-source-of-truth] The introspector reads through the live
// VariableStore (current values), SourceRegistry (lastErrors), VarNode
// (lastUpdatedMs), and DslConfig (declared source kinds, segment templates).
// There is no parallel cache, no shadow snapshot kept in sync — the daemon
// has one DSL state and this module projects it.
//
// [LAW:dataflow-not-control-flow] The state slot (DaemonDslState | null) is
// the only branch: null state → empty snapshots; populated state → real
// snapshots. No special-case introspection paths for the "DSL not active
// yet" case — the same code produces both outcomes from the same data.
//
// Today the daemon does not yet hold a DSL state (bzh.2 has not fired); all
// snapshots are empty in production. When bzh.2 wires the store, the
// snapshots populate without any change to this module or the protocol.

import type { VariableStore } from "../var-system/store";
import type { SourceRegistry } from "../var-system/sources";
import type { DslConfig, SourceKind, VariableDecl } from "../config/dsl-types";
import { walkNodes } from "../config/dsl-types";
import { extractTemplateRefs } from "../config/dsl-loader";
import type { CompiledConfig } from "../dsl/render";
import type {
  DebugSnapshot,
  DebugWhat,
  SegmentSnapshot,
  VarSnapshot,
} from "./debug-types";

// The daemon's DSL state. Bundled because the four fields are co-installed
// by registerDslConfig — exposing them as independently-optional would let
// callers represent illegal combinations (e.g. store with no config).
export interface DaemonDslState {
  readonly store: VariableStore;
  readonly registry: SourceRegistry;
  readonly config: DslConfig;
  readonly compiled: CompiledConfig;
  // [LAW:dataflow-not-control-flow] Per-segment last-render strings live in
  // the same state bundle the renderer mutates. Today (legacy renderer) it
  // is empty; bzh.2 populates it from inside renderDsl.
  readonly lastRenderBySegment: ReadonlyMap<string, string>;
}

// ─── Dispatcher ──────────────────────────────────────────────────────────────

// [LAW:dataflow-not-control-flow] One arm per `what` — the discriminator is
// data; the branch chooses the projection function, not whether projection
// runs. Adding a new `what` is one new arm + one new projection + one new
// DebugSnapshot variant — the type system enforces all three.
export function buildDebugSnapshot(
  what: DebugWhat,
  state: DaemonDslState | null,
): DebugSnapshot {
  switch (what) {
    case "vars":
      return { what, vars: introspectVars(state) };
    case "segments":
      return { what, segments: introspectSegments(state) };
    case "config":
      return { what, config: introspectConfig(state) };
  }
}

// ─── vars ────────────────────────────────────────────────────────────────────

// Project every variable currently registered in the store into one
// VarSnapshot. Names sorted for deterministic snapshot tests. Source kind
// is looked up from the DslConfig (top-level variables + per-segment
// `vars` blocks); a variable not found in either is reported with
// source=null so it still appears in introspection.
export function introspectVars(
  state: DaemonDslState | null,
): readonly VarSnapshot[] {
  if (state === null) return [];

  const { store, registry, config } = state;
  const sourceByName = buildSourceKindIndex(config);
  const names = store.names().sort();

  const out: VarSnapshot[] = [];
  for (const name of names) {
    // [LAW:single-enforcer] One requireNode lookup per row. Reading the
    // value through node.read() instead of store.read(name) avoids a
    // second Map.get + requireNode round-trip in the inner loop and
    // makes the per-row data dependency obvious: every field below
    // comes from this one node.
    const node = store.getNode(name);
    const err = registry.getLastError(name);
    // [LAW:no-defensive-null-guards] No try/catch around node.read():
    // every SourceRegistry-declared variable either holds a typed
    // fallback (declareShell/declareFile/declareGit/declareInput catch
    // internally and write a fallback) or is a computed whose deriver
    // also catches (declareTemplate). Cycles are detected eagerly at
    // register time (declareTemplate's force-read). So a read-throw
    // here would be a *programming* error, not a runtime condition
    // the snapshot should mask. Letting it propagate keeps the failure
    // loud at the source instead of laundering it as a synthesized
    // lastError with an unstable Date.now() timestamp.
    //
    // [LAW:single-enforcer] lastError is sourced from SourceRegistry
    // only. There is no second timestamp-producer that could drift
    // from the registry's record.
    out.push({
      name,
      source: sourceByName.get(name) ?? null,
      type: node.type,
      value: node.read(),
      lastError:
        err !== undefined
          ? { timestampMs: err.timestamp, message: err.message }
          : null,
      ageMs: ageFromNode(node.lastUpdatedMs()),
    });
  }
  return out;
}

function ageFromNode(lastUpdatedMs: number | null): number | null {
  if (lastUpdatedMs === null) return null;
  return Math.max(0, Date.now() - lastUpdatedMs);
}

// Build a name → SourceKind index from the DslConfig. Walks top-level
// variables and each segment's per-segment vars block; segment-local vars
// live under the namespaced key `<segName>.<varName>` in the store (same
// shape registerDslConfig uses to declare them).
function buildSourceKindIndex(
  config: DslConfig,
): ReadonlyMap<string, SourceKind> {
  const index = new Map<string, SourceKind>();
  for (const [name, decl] of Object.entries(config.variables)) {
    index.set(name, sourceKindOf(decl));
  }
  for (const [segName, seg] of Object.entries(config.segments)) {
    if (!seg.vars) continue;
    for (const [varName, decl] of Object.entries(seg.vars)) {
      index.set(`${segName}.${varName}`, sourceKindOf(decl));
    }
  }
  return index;
}

function sourceKindOf(decl: VariableDecl): SourceKind {
  return decl.kind;
}

// ─── segments ────────────────────────────────────────────────────────────────

export function introspectSegments(
  state: DaemonDslState | null,
): readonly SegmentSnapshot[] {
  if (state === null) return [];

  const { store, config, lastRenderBySegment } = state;
  const declaredNames = new Set(store.names());
  // [LAW:dataflow-not-control-flow] Walk in layout order so the introspection
  // snapshot mirrors render order — operators reading the snapshot see the
  // same sequence the bar produces, not an alphabetical reshuffling.
  const segNames = orderedSegmentNames(config);

  const out: SegmentSnapshot[] = [];
  for (const name of segNames) {
    const seg = config.segments[name];
    if (!seg) continue;
    out.push({
      name,
      template: seg.template,
      referencedVars: extractReferencedVars(seg.template, declaredNames),
      lastRender: lastRenderBySegment.get(name) ?? null,
    });
  }
  return out;
}

// Layout order, with any declared-but-not-laid-out segments appended in
// declaration order so they still appear in the snapshot (an operator
// debugging "why isn't this rendering" wants to see the segment, not have
// it filtered out for being absent from layout).
function orderedSegmentNames(config: DslConfig): readonly string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const node of walkNodes(config.root)) {
    if (node.kind !== "cells") continue;
    for (const name of node.segments) {
      if (config.segments[name] && !seen.has(name)) {
        out.push(name);
        seen.add(name);
      }
    }
  }
  for (const name of Object.keys(config.segments)) {
    if (!seen.has(name)) {
      out.push(name);
      seen.add(name);
    }
  }
  return out;
}

// [LAW:single-enforcer] Static analysis of which variables a segment
// template references. Raw candidate extraction (find dotted paths inside
// `{{ ... }}` actions, strip string literals so `{{ printf ".foo" }}`
// does not falsely match a declared `foo`) is delegated to
// extractTemplateRefs in src/config/dsl-loader.ts — that helper already
// owns the template-ref parsing rules and is exercised by the loader's
// cycle detector. Reusing it means a future improvement to the parser
// (e.g. supporting `$x.field` variable references) lands here for free.
//
// Static analysis (not runtime evaluation) is the right tool here:
// evaluation would couple introspection to a working store and would
// vary by current values (if/with branches taken). Static finds every
// potentially-referenced name regardless of current state — which is
// what an operator debugging "what does this segment depend on" needs.
//
// This function adds the introspection-specific layers on top of the raw
// extraction:
//   1. Intersect with the declared-name set (only report names that exist).
//   2. Ancestor credit: a candidate `.session.id.extra` resolves to the
//      declared `session.id` if `extra` is not declared.
//   3. Sort the result for deterministic snapshots.
export function extractReferencedVars(
  template: string,
  declared: ReadonlySet<string>,
): readonly string[] {
  const found = new Set<string>();
  for (const candidate of extractTemplateRefs(template)) {
    if (declared.has(candidate)) {
      found.add(candidate);
      continue;
    }
    // Drop trailing segments until we hit a declared name. Handles
    // `.session.id.something_extra` where only `session.id` is declared —
    // still credit it as a reference to `session.id`.
    const parts = candidate.split(".");
    while (parts.length > 1) {
      parts.pop();
      const prefix = parts.join(".");
      if (declared.has(prefix)) {
        found.add(prefix);
        break;
      }
    }
  }
  return Array.from(found).sort();
}

// ─── config ──────────────────────────────────────────────────────────────────

// [LAW:no-defensive-null-guards] No defensive copy. DslConfig is `readonly`
// throughout and the wire-encoder JSON-serializes it; downstream callers
// see a fresh value. Returning the live reference is the cheapest correct
// answer.
export function introspectConfig(
  state: DaemonDslState | null,
): DslConfig | null {
  if (state === null) return null;
  return state.config;
}

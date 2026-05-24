// [LAW:single-enforcer] One module owns the projection from daemon DSL
// state (VariableStore + SourceRegistry + DslConfig + CompiledSegments) to
// the wire-level DebugSnapshot. The daemon dispatches without any switch
// on `what` — buildDebugSnapshot is a table lookup.
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
import type { CompiledSegments } from "../dsl/render";
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
  readonly compiled: CompiledSegments;
  // [LAW:dataflow-not-control-flow] Per-segment last-render strings live in
  // the same state bundle the renderer mutates. Today (legacy renderer) it
  // is empty; bzh.2 populates it from inside renderDslLine.
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
    const node = store.getNode(name);
    const err = registry.getLastError(name);
    out.push({
      name,
      source: sourceByName.get(name) ?? null,
      type: node.type,
      // [LAW:no-defensive-null-guards] store.read may throw for malformed
      // computed bodies (template parse errors, cycle detection). The
      // failure is data the snapshot exists to report — capture it as
      // lastError + a typed-zero placeholder rather than letting the
      // whole introspection fail.
      ...projectValueAndError(store, name, err),
      ageMs: ageFromNode(node.lastUpdatedMs()),
    });
  }
  return out;
}

function projectValueAndError(
  store: VariableStore,
  name: string,
  err: { timestamp: number; message: string } | undefined,
): { value: VarSnapshot["value"]; lastError: VarSnapshot["lastError"] } {
  try {
    const value = store.read(name);
    return {
      value,
      lastError:
        err !== undefined
          ? { timestampMs: err.timestamp, message: err.message }
          : null,
    };
  } catch (e) {
    // The read itself threw — surface it as lastError. Use a typed zero
    // for the value so the wire stays valid; the consumer reads lastError
    // to discover the real state.
    const message = e instanceof Error ? e.message : String(e);
    const type = store.getNode(name).type;
    return {
      value: zeroForType(type),
      lastError: { timestampMs: Date.now(), message },
    };
  }
}

function ageFromNode(lastUpdatedMs: number | null): number | null {
  if (lastUpdatedMs === null) return null;
  return Math.max(0, Date.now() - lastUpdatedMs);
}

function zeroForType(type: VarSnapshot["type"]): VarSnapshot["value"] {
  if (type === "number") return 0;
  if (type === "boolean") return false;
  return "";
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
  for (const name of config.layout) {
    if (config.segments[name] && !seen.has(name)) {
      out.push(name);
      seen.add(name);
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

// [LAW:single-enforcer] One static-analysis pass extracts every dotted
// path referenced inside `{{ ... }}` actions of a template source. The
// regex finds candidate identifiers; we then intersect with the actual
// declared-name set so the snapshot only reports names that exist.
//
// Static analysis (not runtime evaluation) is the right tool here:
// evaluation would couple introspection to a working store and would
// vary by current values (if/with branches taken). Static finds every
// potentially-referenced name regardless of current state — which is
// what an operator debugging "what does this segment depend on" needs.
//
// Candidates: contiguous `.identifier(.identifier)*` runs.  This catches
// `.foo`, `.foo.bar`, `.git.branch`. Pipeline forms (`{{ .x | upper }}`)
// are handled because the `.` precedes the identifier. False positives:
// literal `.` inside string args (rare in real templates).  We tolerate
// them — they won't survive the declared-names intersection.
export function extractReferencedVars(
  template: string,
  declared: ReadonlySet<string>,
): readonly string[] {
  const found = new Set<string>();
  // Match each `{{ ... }}` action and scan its body for dotted paths.
  const actionRe = /\{\{(.*?)\}\}/gs;
  // A dotted path starts at `.`, then identifier, then optional more
  // .identifier segments. The (?<![A-Za-z_.\d]) negative lookbehind
  // prevents matching `.5` (numeric literal) and rules out spurious
  // mid-token dots (e.g. inside `1.5`).
  const pathRe = /(?<![A-Za-z_.\d])\.([A-Za-z_][\w.]*)/g;
  let m: RegExpExecArray | null;
  while ((m = actionRe.exec(template)) !== null) {
    const body = m[1]!;
    let p: RegExpExecArray | null;
    pathRe.lastIndex = 0;
    while ((p = pathRe.exec(body)) !== null) {
      const candidate = p[1]!;
      // Match against every declared name as either an exact match or a
      // namespace ancestor — `.git.branch` should resolve to the declared
      // name `git.branch` even if the user only declared the leaf.
      if (declared.has(candidate)) {
        found.add(candidate);
        continue;
      }
      // Drop trailing segments until we hit a declared name. Handles the
      // user writing `.session.id.something_extra` where only `session.id`
      // exists — we still credit it as a reference to `session.id`.
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

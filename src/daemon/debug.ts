// [LAW:one-source-of-truth] The one projection of the daemon's live DSL state onto the wire DebugSnapshot; no shadow copy.
// [LAW:dataflow-not-control-flow] A null state yields empty snapshots through the same code.

import type { StoreNode, VariableStore } from "../var-system/store";
import type { SourceRegistry } from "../var-system/sources";
import type { DslConfig, SourceKind, VariableDecl } from "../config/dsl-types";
import { walkNodes } from "../config/dsl-types";
import { rootNode } from "../config/root";
import { extractTemplateRefs } from "../config/dsl-loader";
import type { CompiledConfig } from "../dsl/render";
import type {
  DebugSnapshot,
  DebugWhat,
  SegmentSnapshot,
  VarSnapshot,
} from "./debug-types";

// Bundled: separately optional, the fields could spell illegal combinations.
export interface DaemonDslState {
  readonly store: VariableStore;
  readonly registry: SourceRegistry;
  readonly config: DslConfig;
  readonly compiled: CompiledConfig;
  // [LAW:dataflow-not-control-flow] Mutated by the renderer, in the bundle it already holds.
  readonly lastRenderBySegment: ReadonlyMap<string, string>;
}

// ─── Dispatcher ──────────────────────────────────────────────────────────────

// [LAW:dataflow-not-control-flow] The discriminator picks the projection, not whether projection runs.
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

// A variable the config does not declare still appears, with source=null.
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
    // [LAW:no-defensive-null-guards] Every declared variable writes a typed
    // fallback or catches in its deriver, so a read-throw is a bug, not a state to mask.
    out.push({
      name,
      source: sourceByName.get(name) ?? null,
      ...valueOf(node),
      lastError:
        err !== undefined
          ? { timestampMs: err.timestamp, message: err.message }
          : null,
      ageMs: ageFromNode(node.lastUpdatedMs()),
    });
  }
  return out;
}

// [LAW:one-type-per-behavior] An unscanned or failed document reads as what a template read of it would surface.
function valueOf(node: StoreNode): Pick<VarSnapshot, "type" | "value"> {
  if (node.kind !== "document") {
    return { type: node.type, value: node.read() };
  }
  const doc = node.read();
  switch (doc.kind) {
    case "ok":
      return { type: "document", value: JSON.stringify(doc.value) };
    case "absent":
      return { type: "document", value: "(not yet scanned)" };
    case "failed":
      return { type: "document", value: doc.reason };
  }
}

function ageFromNode(lastUpdatedMs: number | null): number | null {
  if (lastUpdatedMs === null) return null;
  return Math.max(0, Date.now() - lastUpdatedMs);
}

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

// Declared-but-not-laid-out segments are appended, not filtered: "why isn't this rendering" needs to see them.
function orderedSegmentNames(config: DslConfig): readonly string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const node of walkNodes(rootNode(config.root))) {
    if (node.kind !== "segment") continue;
    if (config.segments[node.name] && !seen.has(node.name)) {
      out.push(node.name);
      seen.add(node.name);
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

// [LAW:single-enforcer] Template-ref parsing stays in extractTemplateRefs.
// Static, not evaluated: every potentially-referenced name, whatever branches current values would take.
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
    // Ancestor credit: `.session.id.extra` counts as a read of `session.id`.
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

// [LAW:no-defensive-null-guards] No copy: DslConfig is readonly and the wire encoder serializes it.
export function introspectConfig(
  state: DaemonDslState | null,
): DslConfig | null {
  if (state === null) return null;
  return state.config;
}

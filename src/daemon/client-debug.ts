// [LAW:single-enforcer] The `vars` / `segments` / `config` CLIs are ONE behavior
// — fetch a debug snapshot from the running daemon and render it — parameterized
// by `what`, not three commands. The daemon's `debug` protocol message is the
// single introspection authority (src/daemon/debug.ts produces DebugSnapshot);
// this is its client binding, the mirror of client-stats.ts. Like daemon-stats,
// it does NOT spawn a daemon: introspecting a dead daemon is meaningless.

import process from "node:process";
import { describeFailure, requestOutcome } from "./client-transport";
import type { RoundTripBudgets, RoundTripOutcome } from "./client-transport";
import type {
  DebugSnapshot,
  DebugWhat,
  SegmentSnapshot,
  VarSnapshot,
} from "./debug-types";
import type { DslConfig } from "../config/dsl-types";

// Operator-driven introspection path: legitimately slower budgets than the
// render hot path, carried as this caller's values through the shared
// round-trip in ./client-transport. [LAW:dataflow-not-control-flow]
const BUDGETS: RoundTripBudgets = { connectMs: 200, budgetMs: 500 };

// `cc-candybar <vars|segments|config> [--json]` — `what` selects the projection.
export async function runDebug(
  what: DebugWhat,
  args: readonly string[],
): Promise<void> {
  const wantJson = args.includes("--json");

  const outcome = await fetchDebug(what);
  if (outcome.kind !== "ok") {
    process.stderr.write(`${what}: ${describeFailure(outcome)}\n`);
    process.exit(1);
  }

  if (wantJson) {
    process.stdout.write(JSON.stringify(outcome.value, null, 2) + "\n");
    return;
  }

  process.stdout.write(formatDebug(outcome.value));
}

function fetchDebug(what: DebugWhat): Promise<RoundTripOutcome<DebugSnapshot>> {
  // [LAW:no-defensive-null-guards] exception: trust boundary. The response is
  // an unchecked cast from socket JSON; the presence check is the explicit
  // narrowing at the wire edge (an ok response without `debug` classifies as
  // permanent/malformed_response in the transport).
  return requestOutcome({ kind: "debug", what }, BUDGETS, (resp) =>
    "debug" in resp ? resp.debug : undefined,
  );
}

// [LAW:types-are-the-program] One total fold over the DebugSnapshot union; each
// arm renders its own shape. The switch is exhaustive (the `never` default makes
// a new `what` a compile error here), so the renderer can never fall out of
// lockstep with the protocol's `what` set — the projection is residue of the
// union, not a hand-maintained dispatch.
export function formatDebug(s: DebugSnapshot): string {
  switch (s.what) {
    case "vars":
      return formatVars(s.vars);
    case "segments":
      return formatSegments(s.segments);
    case "config":
      return formatConfig(s.config);
    default: {
      const _exhaustive: never = s;
      return _exhaustive;
    }
  }
}

function formatVars(vars: readonly VarSnapshot[]): string {
  if (vars.length === 0) return "no variables (DSL not active)\n";
  const lines: string[] = [`variables (${vars.length})`, ``];
  const nameW = vars.reduce((w, v) => Math.max(w, v.name.length), 4);
  const srcW = vars.reduce((w, v) => Math.max(w, (v.source ?? "—").length), 6);
  const typeW = vars.reduce((w, v) => Math.max(w, v.type.length), 4);
  for (const v of vars) {
    const age = v.ageMs === null ? "" : `  ${fmtAge(v.ageMs)}`;
    const err = v.lastError ? `  ✗ ${v.lastError.message}` : "";
    lines.push(
      `  ${v.name.padEnd(nameW)}  ${(v.source ?? "—").padEnd(srcW)}  ${v.type.padEnd(typeW)}  ${fmtValue(v.value)}${age}${err}`,
    );
  }
  return lines.join("\n") + "\n";
}

function formatSegments(segments: readonly SegmentSnapshot[]): string {
  if (segments.length === 0) return "no segments (DSL not active)\n";
  const lines: string[] = [`segments (${segments.length})`, ``];
  for (const seg of segments) {
    lines.push(`  ${seg.name}`);
    lines.push(`    template  ${seg.template}`);
    if (seg.referencedVars.length > 0) {
      lines.push(`    vars      ${seg.referencedVars.join(", ")}`);
    }
    if (seg.lastRender !== null) {
      lines.push(`    last      ${seg.lastRender}`);
    }
  }
  return lines.join("\n") + "\n";
}

function formatConfig(config: DslConfig | null): string {
  if (config === null) return "config: DSL not active\n";
  return JSON.stringify(config, null, 2) + "\n";
}

function fmtValue(v: unknown): string {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > 60 ? s.slice(0, 57) + "…" : s;
}

function fmtAge(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m`;
}

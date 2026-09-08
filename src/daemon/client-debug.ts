// [LAW:single-enforcer] One behavior parameterized by `what`; it never spawns a daemon.

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

const BUDGETS: RoundTripBudgets = { connectMs: 200, budgetMs: 500 };

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
  // [LAW:no-defensive-null-guards] exception: trust boundary — unchecked socket JSON.
  return requestOutcome({ kind: "debug", what }, BUDGETS, (resp) =>
    "debug" in resp ? resp.debug : undefined,
  );
}

// [LAW:types-are-the-program] Total fold: a new `what` is a compile error here.
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

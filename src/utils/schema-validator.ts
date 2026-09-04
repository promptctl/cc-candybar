// [LAW:single-enforcer] All hookData schema validation flows through
// validateHookData. One trust boundary, one check.
//
// [LAW:dataflow-not-control-flow] Every check runs unconditionally. Results
// accumulate into a ValidationReport — callers decide what to do with them.
// No early exits, no control-flow branches that skip checks.

import type { ClaudeHookData } from "./claude";

export interface ValidationReport {
  // Required fields that were absent or had wrong types.
  missingRequired: string[];
  typeMismatches: Array<{ path: string; expected: string; got: string }>;
  // Top-level keys not in the known schema — Anthropic may have added new fields.
  unknownTopLevelFields: string[];
}

// Top-level keys Anthropic sends (plus hook_event_name, which cc-candybar adds).
// Adding a new Anthropic field here suppresses the "unknown field" log for it.
const KNOWN_TOP_LEVEL = new Set([
  "hook_event_name", // cc-candybar internal
  "session_id",
  "session_name",
  "transcript_path",
  "cwd",
  "model",
  "workspace",
  "version",
  "output_style",
  "cost",
  "context_window",
  "exceeds_200k_tokens",
  "effort",
  "thinking",
  "rate_limits",
  "vim",
  "agent",
  "worktree",
]);

// Required fields: [dot-separated path, expected typeof result]
// "object" means non-null, non-array object. Checked in declaration order.
const REQUIRED_FIELDS: Array<
  [string, "string" | "number" | "boolean" | "object"]
> = [
  ["session_id", "string"],
  ["transcript_path", "string"],
  ["cwd", "string"],
  ["model", "object"],
  ["model.id", "string"],
  ["model.display_name", "string"],
  ["workspace", "object"],
  ["workspace.current_dir", "string"],
  ["workspace.project_dir", "string"],
];

/**
 * Validate raw hookData received over the wire against the known Anthropic schema.
 *
 * Returns the data typed as ClaudeHookData alongside a ValidationReport.
 * Never throws — divergences are reported, not thrown. The daemon decides
 * how to surface them (dlog warn/info).
 *
 * [LAW:no-defensive-null-guards] Validation at the trust boundary is correct.
 * Everywhere else in the codebase, hookData fields are used without guards
 * because this boundary guarantees their presence.
 */
export function validateHookData(raw: unknown): {
  data: ClaudeHookData;
  report: ValidationReport;
} {
  const report: ValidationReport = {
    missingRequired: [],
    typeMismatches: [],
    unknownTopLevelFields: [],
  };

  const obj: Record<string, unknown> =
    raw !== null && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};

  for (const [path, expectedType] of REQUIRED_FIELDS) {
    const value = resolvePath(obj, path);
    if (value === undefined || value === null) {
      report.missingRequired.push(path);
    } else {
      const got = kindOf(value);
      if (got !== expectedType) {
        report.typeMismatches.push({ path, expected: expectedType, got });
      }
    }
  }

  for (const key of Object.keys(obj)) {
    if (!KNOWN_TOP_LEVEL.has(key)) {
      report.unknownTopLevelFields.push(key);
    }
  }

  return { data: raw as ClaudeHookData, report };
}

// [LAW:parse-dont-validate] A value's kind in REQUIRED_FIELDS' vocabulary.
// A string counts only when well-formed: past this border, hook strings are
// safe to encode into paths and URLs (a lone surrogate would make
// encodeURIComponent throw inland), and their encodings are injective.
function kindOf(value: unknown): string {
  if (Array.isArray(value)) return "array";
  if (typeof value === "string" && !value.isWellFormed())
    return "ill-formed string";
  return typeof value;
}

function resolvePath(obj: Record<string, unknown>, dotPath: string): unknown {
  let cur: unknown = obj;
  for (const key of dotPath.split(".")) {
    if (
      cur === null ||
      cur === undefined ||
      typeof cur !== "object" ||
      Array.isArray(cur)
    ) {
      return undefined;
    }
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

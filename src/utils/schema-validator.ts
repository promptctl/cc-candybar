// [LAW:single-enforcer] One trust boundary: all hookData validation flows here.
// [LAW:dataflow-not-control-flow] Every check runs; results accumulate in a report.

import type { ClaudeHookData } from "./claude";

export interface ValidationReport {
  missingRequired: string[];
  typeMismatches: Array<{ path: string; expected: string; got: string }>;
  unknownTopLevelFields: string[];
}

const KNOWN_TOP_LEVEL = new Set([
  "hook_event_name",
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
 * [LAW:no-defensive-null-guards] Never throws; nothing inland guards a hookData field.
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

// [LAW:parse-dont-validate] Well-formed only: a lone surrogate must not pass here.
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

import { isPlainObject } from "../../config/loader/validate-core.js";
import type { CommandReply } from "../../renderer-interface/interface.js";
import { missingFields, RENDERER_STATS_REFERENCE } from "./stats-snapshot.js";

function variableRow(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  const { name, source, type, ageMs, lastError } = value;
  return (
    typeof name === "string" &&
    (source === null || typeof source === "string") &&
    typeof type === "string" &&
    value.value !== undefined &&
    (ageMs === null || (typeof ageMs === "number" && Number.isFinite(ageMs))) &&
    (lastError === null ||
      (isPlainObject(lastError) && typeof lastError.message === "string"))
  );
}

function segmentRow(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  const { name, description, template, referencedVars, placements } = value;
  return (
    typeof name === "string" &&
    (description === null || typeof description === "string") &&
    typeof template === "string" &&
    Array.isArray(referencedVars) &&
    referencedVars.every((name: unknown) => typeof name === "string") &&
    Array.isArray(placements) &&
    placements.every(
      (each: unknown) =>
        isPlainObject(each) &&
        typeof each.id === "string" &&
        (each.lastRender === null || typeof each.lastRender === "string"),
    )
  );
}

// [LAW:parse-dont-validate] The caller correlates the reply to its command.
// These checks stop truncation at that seam instead of letting the stats
// combiner or the debug formatter discover it in a successful response.
export function inspectionPayloadProblem(reply: {
  readonly kind: CommandReply["kind"];
  readonly snapshot?: unknown;
  readonly stats?: unknown;
}): string | null {
  if (reply.kind === "stats") {
    const missing = missingFields(RENDERER_STATS_REFERENCE, reply.stats);
    return missing.length === 0
      ? null
      : `invalid stats snapshot: ${missing.join(", ")}`;
  }
  if (reply.kind !== "debug") return null;
  const { snapshot } = reply;
  if (!isPlainObject(snapshot)) return "invalid debug snapshot";
  switch (snapshot.what) {
    case "vars":
      return Array.isArray(snapshot.vars) && snapshot.vars.every(variableRow)
        ? null
        : "invalid vars snapshot";
    case "segments":
      return Array.isArray(snapshot.segments) &&
        snapshot.segments.every(segmentRow)
        ? null
        : "invalid segments snapshot";
    case "config":
      // The CLI prints the already-resolved config, so it needs the nullable
      // object shape and does not apply authored-layer validation again.
      return snapshot.config === null || isPlainObject(snapshot.config)
        ? null
        : "invalid config snapshot";
    default:
      return "invalid debug snapshot";
  }
}

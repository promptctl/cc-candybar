import type { RenderWarning } from "../dsl/render.js";
import {
  faultsNote,
  spelledFaults,
  type Fault,
} from "../renderer-interface/noted-faults.js";

interface DescribedWarning {
  readonly warning: RenderWarning;
  readonly tag: string;
  readonly subject: string;
  readonly key: string;
}

export interface FrameWarnings {
  readonly warnings: readonly DescribedWarning[];
  readonly faults: string;
}

// [LAW:single-enforcer] One projection of a walk warning, reused in the
// turn's brief tag and fault subject and in the diagnostics identity.
export function describeWarning(warning: RenderWarning): DescribedWarning {
  const { kind, message } = warning;
  let subject: string;
  switch (kind) {
    case "rule":
      subject = warning.slot;
      break;
    case "refresh":
      subject = warning.variable;
      break;
    case "segment":
      subject = warning.placement;
      break;
    case "when":
      subject = warning.where;
      break;
  }
  // [LAW:one-source-of-truth] A tuple gives equal warnings the same identity
  // regardless of the producer's object field order.
  return {
    warning,
    subject,
    tag: kind === "when" ? kind : `${kind}:${subject}`,
    key: JSON.stringify([
      kind,
      subject,
      message,
      "error" in warning ? warning.error : null,
    ]),
  };
}

export function frameWarnings(
  warnings: readonly DescribedWarning[],
  faults: readonly Fault[],
): FrameWarnings {
  return { warnings, faults: spelledFaults(faults) };
}

// Both draw notes and a confirmed feed use the last accepted baseline. A
// missing baseline has no fault list, even when this frame has no faults.
export function warningChanges(
  next: FrameWarnings,
  prior: FrameWarnings | undefined,
) {
  const warnings = prior?.warnings ?? [];
  return {
    moved:
      warnings.length !== next.warnings.length ||
      warnings.some(({ key }, i) => key !== next.warnings[i]?.key),
    faults: faultsNote(next.faults, prior?.faults),
  };
}

// [LAW:single-enforcer] Merge surfaces in display order. A warning repeated
// on one surface keeps its occurrences. An equal warning from another
// surface consumes one such occurrence.
export function combinedWarnings(
  records: readonly FrameWarnings[],
): readonly DescribedWarning[] {
  const listed: DescribedWarning[] = [];
  const seen = new Map<string, number>();
  for (const record of records) {
    const earlier = new Map(seen);
    for (const warning of record.warnings) {
      const { key } = warning;
      const count = earlier.get(key) ?? 0;
      if (count > 0) earlier.set(key, count - 1);
      else {
        seen.set(key, (seen.get(key) ?? 0) + 1);
        listed.push(warning);
      }
    }
  }
  return listed;
}

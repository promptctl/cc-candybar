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
    case "stale":
      subject = warning.key;
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

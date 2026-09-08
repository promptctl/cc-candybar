// [LAW:one-source-of-truth] Menu rows and doctor writes spell these keys through `doctorReportKeys`.

import { BOOLEAN_FALSE, BOOLEAN_TRUE } from "../themes/policy.js";
import type { CheckReport } from "./checks.js";

export const DOCTOR_NS = "settings.doctor.";

export const VERDICT_OK = "ok";
export const VERDICT_FAILED = "failed";
// An unwritten key reads as the empty default: "this check has not run".
export const VERDICT_UNRUN = "";

export interface ReportKeys {
  readonly verdict: string;
  readonly reason: string;
  readonly fixable: string;
}

export function doctorReportKeys(checkName: string): ReportKeys {
  const base = `${DOCTOR_NS}${checkName}.`;
  return {
    verdict: `${base}verdict`,
    reason: `${base}reason`,
    fixable: `${base}fixable`,
  };
}

// [LAW:dataflow-not-control-flow] Every key is written on every run, so a recovered check self-clears.
export function doctorReportPairs(
  reports: readonly CheckReport[],
): ReadonlyArray<{ key: string; value: string }> {
  return reports.flatMap(({ check, verdict }) => {
    const keys = doctorReportKeys(check.name);
    return verdict.ok
      ? [
          { key: keys.verdict, value: VERDICT_OK },
          { key: keys.reason, value: "" },
          { key: keys.fixable, value: BOOLEAN_FALSE },
        ]
      : [
          { key: keys.verdict, value: VERDICT_FAILED },
          { key: keys.reason, value: verdict.reason },
          {
            key: keys.fixable,
            value: verdict.fix === undefined ? BOOLEAN_FALSE : BOOLEAN_TRUE,
          },
        ];
  });
}

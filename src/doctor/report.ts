// The doctor's report as SessionState: one (verdict, reason, fixable) triple
// per check, keyed by check name.
//
// [LAW:one-source-of-truth] The settings menu (src/config/settings-menu.ts)
// declares a `state` variable for every key this module names, and the
// doctor verbs (src/daemon/verbs/index.ts) write those same keys — both spell
// them through `doctorReportKeys`, so the row a check renders and the write
// its click lands cannot address different variables.
//
// Session state, not a RenderPayload projection: the report is click-driven
// per-session state, which is exactly what SessionState is THE store for, and
// `CHECKS` is static, so a fixed set of scalar keys needs no series encoding.

import { BOOLEAN_FALSE, BOOLEAN_TRUE } from "../themes/policy.js";
import type { CheckReport } from "./checks.js";

export const DOCTOR_NS = "settings.doctor.";

export const VERDICT_OK = "ok";
export const VERDICT_FAILED = "failed";
// An unwritten key reads as the state variable's default — the empty string —
// which is the report's "this check has not run" state, gating the row off.
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

// [LAW:dataflow-not-control-flow] One fold from reports to the pairs a single
// setBatch commits — every key written on every run, so a check that was
// failed and is now ok has its reason and fixable cleared by the same write
// that flips its verdict, never by a second conditional clear.
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

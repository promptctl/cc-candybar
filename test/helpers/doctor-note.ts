// The reports a doctor note carries, for a test whose run must have reported:
// a failed run throws its reason.

import {
  readDoctorNote,
  type NotedReport,
} from "../../src/renderer-interface/noted-doctor";

export function notedReportsOf(value: string): readonly NotedReport[] {
  const run = readDoctorNote(value);
  if (run.kind === "failed")
    throw new Error(`the doctor's run failed: ${run.reason}`);
  return run.reports;
}

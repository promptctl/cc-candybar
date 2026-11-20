import type { ReportThrow } from "../../src/time";

// [LAW:no-silent-failure] Where a case that expects no task to throw sends a
// throw: back out, so the case fails on it rather than reporting it nowhere.
export const rethrow: ReportThrow = (_task, thrown) => {
  throw thrown;
};

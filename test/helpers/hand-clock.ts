import {
  clockOver,
  rethrowing,
  type ReportThrow,
  type Timekeeper,
  type TimerSource,
} from "../../src/time";

const noTimer = (): (() => void) => {
  throw new Error("this rig sets no timer");
};

// A clock a case makes from its own readings and the timers it fires itself,
// built as the process's is, so its tasks run and report as the daemon's do:
// what one throws goes to `report`, which ends the case unless the case
// collects it. A timer it does not give throws when armed.
export function handClock(
  parts: Pick<TimerSource, "now" | "monotonic"> & Partial<TimerSource>,
  report: ReportThrow = rethrowing,
): Timekeeper {
  return clockOver(
    { timer: noTimer, interval: noTimer, turn: noTimer, ...parts },
    report,
  );
}

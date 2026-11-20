import type {
  BackgroundFault,
  ReportFault,
} from "../../src/daemon/background-fault.js";
import { WatcherRegistry } from "../../src/daemon/cache/watchers.js";
import type { Timekeeper } from "../../src/time.js";

// The faults an owner reported, in order, for a test that makes its work throw.
export function heldFaults(): {
  readonly faults: BackgroundFault[];
  readonly report: ReportFault;
} {
  const faults: BackgroundFault[] = [];
  return { faults, report: (fault) => void faults.push(fault) };
}

// [LAW:no-silent-failure] For a test whose work is not meant to throw: a throw
// is the test's failure, not a line nobody reads.
export const unexpectedFault: ReportFault = ({ work, subject, thrown }) => {
  throw new Error(`unexpected ${work} throw (${subject})`, { cause: thrown });
};

// A registry for an owner whose test is not about watch delivery.
export function watchersFor(
  clock: Pick<Timekeeper, "after" | "every">,
): WatcherRegistry {
  return new WatcherRegistry({ clock, report: unexpectedFault });
}

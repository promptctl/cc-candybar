import { systemTimers } from "../../src/time";
import {
  reportingClock,
  type ReportingClock,
} from "../../src/daemon/task-throws";

// A daemon's clock on real time, as the daemon process builds it: what its
// tasks throw lands in the inbox it carries, which every bar shows.
export const systemDaemonClock = (): ReportingClock =>
  reportingClock(systemTimers);

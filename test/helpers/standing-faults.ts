import { StandingFaults } from "../../src/daemon/foundations/standing-faults";

// A store for a test that expects no fault: one raised throws its record, so
// the test fails where the fault stood.
export const unexpectedFaults = (): StandingFaults =>
  new StandingFaults((level, line) => {
    if (level === "warn") throw new Error(`unexpected fault: ${line}`);
  });

import type { WorkThrew } from "../../src/daemon/foundations/work-threw";

// A test's sink for work that threw: a throw no test expects fails the run
// where it happened.
export const rethrown: WorkThrew = (_event, _fields, thrown) => {
  throw thrown;
};

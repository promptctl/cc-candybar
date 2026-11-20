import {
  threwLine,
  type WorkThrew,
} from "../../src/daemon/foundations/work-threw";

// A test's sink for work that threw: a throw no test expects fails the run
// where it happened.
export const rethrown: WorkThrew = (_event, _fields, thrown) => {
  throw thrown;
};

// A test's sink for work it expects to throw: each throw's one record, as the
// daemon writes it, pushed onto `lines`.
export const recordedInto =
  (lines: string[]): WorkThrew =>
  (event, fields, thrown) =>
    void lines.push(threwLine(event, fields, thrown));

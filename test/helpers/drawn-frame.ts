// A drawn Frame of the given lines of runs, as a test hands one to a lane.
import type { Frame, Run } from "../../src/render/frame";

export const barOf = (...lines: ReadonlyArray<readonly Run[]>): Frame => ({
  depth: "truecolor",
  rows: lines.map((runs) => ({ kind: "bar", runs })),
  nextChange: Infinity,
  motion: "still",
  pending: [],
});

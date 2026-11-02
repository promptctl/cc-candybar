// The render helper reads one event per render its client kept. Which attempt
// it kept is a decision of the retry loop (test/helpers/daemon-e2e.ts), held
// here on the predicate both it and `renderLines` ask.

import { drewAwaitedPending, retriedRender } from "../helpers/daemon-log";

const event = (fields: string): string =>
  `2026-11-02T00:00:00.000Z [info] render sid=s took=1ms ${fields}`;

describe("retriedRender", () => {
  test("an answer drawn at its deadline with a source pending is asked again", () => {
    const line = event("timedOut=N ended=deadline pending=git");
    expect(retriedRender(line)).toBe(true);
  });

  test.each([
    ["nothing pending", "timedOut=N ended=settled pending=-"],
    [
      "only a source a run superseded pending",
      "timedOut=N ended=deadline pending=plug sourcesPending=plug:superseded",
    ],
  ])("an answer with %s is the one kept", (_, fields) => {
    expect(retriedRender(event(fields))).toBe(false);
  });

  test("an answer that drew pending though its wait answered is not retried but is pending", () => {
    // renderRequest fails on it rather than asking again.
    const line = event("timedOut=N ended=settled pending=git");
    expect(drewAwaitedPending(line)).toBe(true);
    expect(retriedRender(line)).toBe(false);
  });
});

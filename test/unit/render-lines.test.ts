// The render helper reads one event per render its client kept. Which attempt
// it kept is a decision of the retry loop (test/helpers/daemon-e2e.ts), held
// here on the predicate both it and the helper's pick ask, and on the pick.

import {
  drewAwaitedPending,
  keptRenders,
  owedLandings,
  retriedRender,
} from "../helpers/daemon-log";

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

  // The PR and today's day sums are the two values no request waits for, so
  // a first bar draws them pending whatever its wait did, and the answer is
  // asked again once the lookup that lands them is logged.
  test("an answer that drew only the PR and today pending is asked again after their refreshes", () => {
    const line = event(
      "timedOut=N ended=answered pending=git.prState,git.prUrl,today.cost",
    );
    expect(retriedRender(line)).toBe(true);
    expect(owedLandings(line)).toEqual(["] pr refresh ", "] today refresh "]);
  });

  test("an answer that drew another value pending beside the PR is not retried", () => {
    const line = event("timedOut=N ended=answered pending=git.prState,git.sha");
    expect(owedLandings(line)).toEqual([]);
    expect(retriedRender(line)).toBe(false);
  });

  test("an answer that drew pending though its wait answered is not retried but is pending", () => {
    // renderRequest fails on it rather than asking again.
    const line = event("timedOut=N ended=settled pending=git");
    expect(drewAwaitedPending(line)).toBe(true);
    expect(retriedRender(line)).toBe(false);
  });
});

describe("keptRenders", () => {
  const rendered = (sid: string, fields: string): string =>
    `2026-11-02T00:00:00.000Z [info] render sid=${sid} took=1ms ${fields}`;

  test("a render the client asked again keeps the attempt it read, and no other session's", () => {
    const timedOut = rendered("s", "timedOut=Y ended=deadline pending=git");
    const retried = rendered("s", "timedOut=N ended=deadline pending=git");
    const kept = rendered("s", "timedOut=N ended=settled pending=-");
    const other = rendered("t", "timedOut=N ended=settled pending=-");
    expect(keptRenders([timedOut, retried, kept, other], "s")).toEqual([kept]);
  });

  test("a render that drew only a superseded source pending is kept", () => {
    const superseded = rendered(
      "s",
      "timedOut=N ended=deadline pending=plug sourcesPending=plug:superseded",
    );
    expect(keptRenders([superseded], "s")).toEqual([superseded]);
  });
});

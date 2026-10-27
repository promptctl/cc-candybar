// [LAW:nothing-unseen] The request event's own shape (src/daemon/request-event.ts).
// Nothing a config authors makes a render throw (brandon-unfiled-3248.ryf), so
// the threw arm is reached only by a renderer bug and no real daemon request
// can drive it: it is held here, on the function that writes the line.

import {
  noteFacts,
  requestEvent,
  type RequestFacts,
} from "../src/daemon/request-event";

describe("requestEvent", () => {
  test("a throw is an error event carrying the facts it reached, then the thrown value with its stack", () => {
    const facts: RequestFacts = [];
    noteFacts(facts, { sid: "s1", termCols: "120" });
    const error = new Error("the renderer broke");
    const { level, line } = requestEvent(
      "render",
      facts,
      { kind: "threw", error },
      7,
    );
    expect(level).toBe("error");
    expect(line).toMatch(
      /^render sid=s1 termCols=120 took=7ms outcome=threw error="Error: the renderer broke\\n {4}at /,
    );
  });

  test("a value a client could make read as several fields is one JSON string", () => {
    const facts: RequestFacts = [];
    noteFacts(facts, { sid: 'a b outcome=ok\n[error] render sid="x"' });
    const { level, line } = requestEvent("render", facts, { kind: "ok" }, 1);
    expect(level).toBe("info");
    expect(line).toBe(
      `render sid=${JSON.stringify('a b outcome=ok\n[error] render sid="x"')} took=1ms outcome=ok`,
    );
  });
});

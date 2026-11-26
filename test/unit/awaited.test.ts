// What a request waits for is what its draw drew pending, by one rule
// (src/facts/awaited.ts): a first answer nothing defers. The draw says so with
// every frame (`Awaiting`), and the host waits for exactly that.

import { awaitingOf, awaits, spelled } from "../../src/facts/awaited";
import { ok, pendingOf } from "../../src/utils/outcome";

const DOCUMENT = { seq: 4, stampFailure: null } as const;

describe("what a request waits for", () => {
  test("is a first answer, never one the daemon superseded or one deferred by design", () => {
    expect(awaits("unread")).toBe(true);
    expect(awaits("superseded")).toBe(false);
    expect(awaits("deferred")).toBe(false);
  });

  test("a first answer spelled as deferred draws deferred, and only a first answer does", () => {
    expect(spelled(pendingOf("unread"))).toEqual(pendingOf("deferred"));
    // What the daemon superseded and what answered are spelled as they are.
    expect(spelled(pendingOf("superseded"))).toEqual(pendingOf("superseded"));
    expect(spelled(ok(1))).toEqual(ok(1));
  });
});

describe("what a draw owes", () => {
  test("nothing when it drew no value pending, or only ones no request waits for", () => {
    expect(awaitingOf([], DOCUMENT)).toEqual({ kind: "settled", seq: 4 });
    expect(
      awaitingOf(
        [
          { variable: "git.prNumber", why: "deferred" },
          { variable: "plug", why: "superseded" },
        ],
        DOCUMENT,
      ),
    ).toEqual({ kind: "settled", seq: 4 });
  });

  test("the variables it drew pending for a first answer, over the world state it drew", () => {
    expect(
      awaitingOf(
        [
          { variable: "doc", why: "unread" },
          { variable: "plug", why: "superseded" },
          { variable: "git.sha", why: "unread" },
        ],
        DOCUMENT,
      ),
    ).toEqual({ kind: "owed", seq: 4, names: ["doc", "git.sha"] });
  });

  test("an owing that cannot be paid when the world state it drew is one whose stamp failed", () => {
    expect(
      awaitingOf([{ variable: "doc", why: "unread" }], {
        seq: 5,
        stampFailure: "reading the owners: boom",
      }),
    ).toEqual({
      kind: "stalled",
      seq: 5,
      names: ["doc"],
      reason: "reading the owners: boom",
    });
  });

  test("a failed stamp owes nothing when nothing is pending", () => {
    expect(
      awaitingOf([], {
        seq: 5,
        stampFailure: "boom",
      }),
    ).toEqual({ kind: "settled", seq: 5 });
  });
});

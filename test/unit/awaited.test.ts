// What a request waits for is what its draw drew pending, by one rule
// (src/facts/awaited.ts): a first answer nothing defers. The draw says so with
// every frame (`Awaiting`), and the host waits for exactly that.

import { awaitingOf, awaits, spelled } from "../../src/facts/awaited";
import { ok, pendingOf } from "../../src/utils/outcome";
import {
  untakenBy,
  WORLD_STATE_UNTAKEN,
  type TurnOutcome,
} from "../../src/renderer-interface/interface";
import { failureOf } from "../../src/daemon/foundations/verb-error";

const DOCUMENT = { seq: 4, diagnostics: [] } as const;

describe("what a request waits for", () => {
  test("is a first answer, never one the daemon superseded or one deferred by design", () => {
    expect(awaits("unread")).toBe(true);
    expect(awaits("superseded")).toBe(false);
    expect(awaits("deferred")).toBe(false);
  });

  test("a built-in's first answer is waited for, except today's day sums and the branch's PR, which draw deferred", () => {
    expect(spelled("git", pendingOf("unread"))).toEqual(pendingOf("unread"));
    expect(spelled("today", pendingOf("unread"))).toEqual(
      pendingOf("deferred"),
    );
    expect(spelled("pr", pendingOf("unread"))).toEqual(pendingOf("deferred"));
    // Only a first answer is deferred: what the daemon superseded and what
    // answered are spelled as they are.
    expect(spelled("pr", pendingOf("superseded"))).toEqual(
      pendingOf("superseded"),
    );
    expect(spelled("pr", ok(1))).toEqual(ok(1));
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
        diagnostics: [{ kind: "stamp", reason: "reading the owners: boom" }],
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
        diagnostics: [{ kind: "stamp", reason: "boom" }],
      }),
    ).toEqual({ kind: "settled", seq: 5 });
  });
});

describe("whether a turn took the world state it was handed", () => {
  const turn = (over: Partial<TurnOutcome>): TurnOutcome =>
    ({
      kind: "answered",
      record: [],
      effects: [],
      ...over,
    }) as TurnOutcome;

  test("it did when the turn answered and recorded no refusal", () => {
    expect(untakenBy(turn({}))).toBeNull();
    expect(untakenBy(turn({ record: [["why", "something else"]] }))).toBeNull();
  });

  test("it did not when the renderer recorded that it holds no view of the session", () => {
    expect(untakenBy(turn({ record: [WORLD_STATE_UNTAKEN] }))).toMatch(
      /holds no view/,
    );
  });

  test("it did not when the turn threw, and says what it threw", () => {
    expect(
      untakenBy(turn({ kind: "threw", failure: failureOf(new Error("boom")) })),
    ).toBe("boom");
  });
});

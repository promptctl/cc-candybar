// How long a failed click's errors stay on the bar (src/daemon/foundations/click-error.ts):
// every render whose instant falls before the hold ends shows them, a request
// shows them past it until an answer has carried them, and no render changes
// what the next one sees.

import {
  CLICK_ERROR_HOLD_S,
  answeredClickError,
  clickErrorAt,
  holdClickError,
  lastClickError,
} from "../../src/daemon/foundations/click-error";
import { SessionState } from "../../src/renderer/session-state";
import type { Instant } from "../../src/utils/instant";
import { sessionIdOf } from "../../src/daemon/foundations/session-id";

const SID = sessionIdOf("s");
const at = (seconds: number): Instant => seconds as Instant;
const END = 100 + CLICK_ERROR_HOLD_S;
const error = {
  text: "set-state: refused",
  at: at(100),
  answered: false,
  revision: 1,
};

test("a click's errors show at every instant before the hold ends, and to no frame after", () => {
  const state = new SessionState();
  holdClickError(state, SID, "set-state: refused", at(100));
  const held = { kind: "held", error };
  for (const render of ["feed", "request"] as const) {
    expect(clickErrorAt(state, SID, at(99.9), render)).toEqual(held);
    expect(clickErrorAt(state, SID, at(100), render)).toEqual(held);
    expect(clickErrorAt(state, SID, at(END - 0.001), render)).toEqual(held);
  }
  expect(clickErrorAt(state, SID, at(END), "feed")).toEqual({ kind: "over" });
});

test("past the hold, a request is owed them until an answer has carried them", () => {
  const state = new SessionState();
  holdClickError(state, SID, "set-state: refused", at(100));
  expect(clickErrorAt(state, SID, at(END + 600), "request")).toEqual({
    kind: "owed",
    error,
  });
  answeredClickError(state, SID, error);
  expect(clickErrorAt(state, SID, at(END + 600), "request")).toEqual({
    kind: "over",
  });
});

// A click's own failure, then its run's: both show until an answer carries
// them.
test("a failure while the last is still owed joins it, and an answer carrying only the older leaves both owed", () => {
  const state = new SessionState();
  holdClickError(state, SID, "set-state: refused", at(100));
  holdClickError(state, SID, "run a: exited with code 1", at(102));
  answeredClickError(state, SID, error);
  expect(lastClickError(state, SID)).toEqual({
    text: "set-state: refused\nrun a: exited with code 1",
    at: at(102),
    revision: 2,
    answered: false,
  });
});

test("a failure once an answer carried the last starts afresh", () => {
  const state = new SessionState();
  holdClickError(state, SID, "set-state: refused", at(100));
  answeredClickError(state, SID, error);
  holdClickError(state, SID, "run a: exited with code 1", at(102));
  expect(lastClickError(state, SID)?.text).toBe("run a: exited with code 1");
});

test("reading a click's errors writes nothing, so a later render inside the hold still shows them", () => {
  const state = new SessionState();
  holdClickError(state, SID, "dispatch: boom", at(100));
  const revision = state.revision(SID);
  clickErrorAt(state, SID, at(END + 1), "request");
  expect(state.revision(SID)).toBe(revision);
  expect(clickErrorAt(state, SID, at(101), "feed").kind).toBe("held");
});

test("a session with no click error holds none", () => {
  const state = new SessionState();
  expect(clickErrorAt(state, SID, at(100), "request")).toEqual({
    kind: "none",
  });
});

test("an answer carrying another failure at the same instant leaves this one owed", () => {
  const state = new SessionState();
  holdClickError(state, SID, "dispatch: boom", at(100));
  answeredClickError(state, SID, error);
  expect(clickErrorAt(state, SID, at(END + 1), "request").kind).toBe("owed");
});

test("a record this build did not write is said, not read as none", () => {
  const state = new SessionState();
  state.set(SID, "candybar.clickError", JSON.stringify({ text: "x", at: 1 }));
  expect(() => clickErrorAt(state, SID, at(100), "request")).toThrow(
    /not one this build writes/,
  );
});

test("an oversized failure is bounded when held, and the answer that carried it marks it", () => {
  const state = new SessionState();
  holdClickError(
    state,
    SID,
    `first action: ${"details\n".repeat(600)}last action: refused`,
    at(100),
  );
  const shown = clickErrorAt(state, SID, at(END + 1), "request");
  if (shown.kind !== "owed") throw new Error("expected the held diagnostic");
  expect(shown.error.text.length).toBeLessThanOrEqual(2048);
  expect(shown.error.text).toMatch(/^first action:/u);
  expect(shown.error.text).toMatch(/last action: refused$/u);
  answeredClickError(state, SID, shown.error);
  expect(clickErrorAt(state, SID, at(END + 1), "request")).toEqual({
    kind: "over",
  });
});

test("an answer that carried an older clipped error cannot mark a newer one at the same instant", () => {
  const message = `spawn tool ${"x".repeat(3000)}: failed`;
  const state = new SessionState();
  holdClickError(state, SID, message, at(100));
  const previous = lastClickError(state, SID);
  if (previous === null) throw new Error("expected the held diagnostic");
  holdClickError(state, SID, message, at(100));
  const newer = lastClickError(state, SID);
  if (newer === null) throw new Error("expected the replacement diagnostic");
  expect(newer.text).toBe(previous.text);
  const stored = state.get(SID, "candybar.clickError");
  answeredClickError(state, SID, previous);
  expect(state.get(SID, "candybar.clickError")).toBe(stored);
  expect(clickErrorAt(state, SID, at(END + 1), "request").kind).toBe("owed");
  answeredClickError(state, SID, newer);
  expect(clickErrorAt(state, SID, at(END + 1), "request").kind).toBe("over");
});

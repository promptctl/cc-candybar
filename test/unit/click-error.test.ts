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
const legacyError = { text: "set-state: refused", at: at(100), answered: false };
const error = { ...legacyError, revision: 1 };

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

test("a session with no click error, or a value an older daemon wrote, holds none", () => {
  const state = new SessionState();
  expect(clickErrorAt(state, SID, at(100), "request")).toEqual({
    kind: "none",
  });
  state.set(SID, "click.error", 'set-state: placement "block" refused');
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

test("a record an older daemon wrote with no answered mark is owed to the next request", () => {
  const state = new SessionState();
  state.set(
    SID,
    "click.error",
    JSON.stringify({ text: "set-state: refused", at: 100 }),
  );
  expect(clickErrorAt(state, SID, at(END + 600), "request")).toEqual({
    kind: "owed",
    error: legacyError,
  });
});

test.each([undefined, 6])("an old oversized stored record with revision %s is bounded when read and marked", (revision) => {
  const original = JSON.stringify({
    text: `first action: ${"old details\n".repeat(300)}last action: refused`,
    at: 100,
    revision,
  });
  const state = new SessionState({ [SID]: { "click.error": original } });
  const shown = clickErrorAt(state, SID, at(END + 1), "request");
  expect(shown.kind).toBe("owed");
  if (shown.kind !== "owed") throw new Error("expected the stored diagnostic");
  expect(shown.error.text.length).toBeLessThanOrEqual(2048);
  expect(shown.error.text).toMatch(/^first action:/u);
  expect(shown.error.text).toMatch(/last action: refused$/u);
  expect(state.get(SID, "click.error")).toBe(original);
  answeredClickError(state, SID, shown.error);
  expect(clickErrorAt(state, SID, at(END + 1), "request")).toEqual({ kind: "over" });
  expect(lastClickError(state, SID)).toEqual({ ...shown.error, answered: true });
  expect(state.get(SID, "click.error")?.length).toBeLessThan(original.length);
});

test.each([undefined, 6])("an older serialized error with revision %s cannot acknowledge a newer clipped error at the same instant", (revision) => {
  const message = `spawn tool ${"x".repeat(3000)}: failed`;
  const raw = JSON.stringify({ text: message, at: 100, revision });
  const state = new SessionState({ [SID]: { "click.error": raw } });
  const previous = lastClickError(state, SID);
  if (previous === null) throw new Error("expected the stored diagnostic");
  holdClickError(state, SID, message, at(100));
  const newer = lastClickError(state, SID);
  if (newer === null) throw new Error("expected the replacement diagnostic");
  expect(newer.text).toBe(previous.text);
  const stored = state.get(SID, "click.error");
  answeredClickError(state, SID, previous);
  expect(state.get(SID, "click.error")).toBe(stored);
  expect(clickErrorAt(state, SID, at(END + 1), "request").kind).toBe("owed");
  answeredClickError(state, SID, newer);
  expect(clickErrorAt(state, SID, at(END + 1), "request").kind).toBe("over");
});

// How long a failed click's errors stay on the bar (src/daemon/click-error.ts):
// every render whose instant falls before the hold ends shows them, a request
// shows them past it until an answer has carried them, and no render changes
// what the next one sees.

import {
  CLICK_ERROR_HOLD_S,
  answeredClickError,
  clickErrorAt,
  holdClickError,
  lastClickError,
} from "../src/daemon/click-error";
import { SessionState } from "../src/daemon/session-state";
import type { Instant } from "../src/utils/instant";

const SID = "s";
const at = (seconds: number): Instant => seconds as Instant;
const END = 100 + CLICK_ERROR_HOLD_S;
const error = { text: "set-state: refused", at: at(100), answered: false };

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

test("an answer carrying an older failure leaves a newer one owed", () => {
  const state = new SessionState();
  holdClickError(state, SID, "set-state: refused", at(100));
  holdClickError(state, SID, "dispatch: boom", at(102));
  answeredClickError(state, SID, error);
  expect(lastClickError(state, SID)).toEqual({
    text: "dispatch: boom",
    at: at(102),
    answered: false,
  });
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
  expect(clickErrorAt(state, SID, at(100), "request")).toEqual({ kind: "none" });
  state.set(SID, "click.error", 'set-state: placement "block" refused');
  expect(clickErrorAt(state, SID, at(100), "request")).toEqual({ kind: "none" });
});

test("an answer carrying another failure at the same instant leaves this one owed", () => {
  const state = new SessionState();
  holdClickError(state, SID, "dispatch: boom", at(100));
  answeredClickError(state, SID, error);
  expect(clickErrorAt(state, SID, at(END + 1), "request").kind).toBe("owed");
});

test("a record an older daemon wrote with no answered mark is owed to the next request", () => {
  const state = new SessionState();
  state.set(SID, "click.error", JSON.stringify({ text: "set-state: refused", at: 100 }));
  expect(clickErrorAt(state, SID, at(END + 600), "request")).toEqual({
    kind: "owed",
    error,
  });
});

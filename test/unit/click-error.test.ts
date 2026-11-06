// How long a failed click's errors stay on the bar (src/daemon/click-error.ts):
// each failure is its own record, every render whose instant falls before its
// hold ends shows it, a request shows it past the hold until an answer has
// carried it, and no render changes what the next one sees.

import {
  CLICK_ERROR_HOLD_S,
  answeredClickError,
  clickErrors,
  clickErrorsAt,
  holdClickError,
  shownClickErrors,
  toAnswer,
} from "../../src/daemon/click-error";
import { SessionState } from "../../src/daemon/session-state";
import type { Instant } from "../../src/utils/instant";

const SID = "s";
const at = (seconds: number): Instant => seconds as Instant;
const END = 100 + CLICK_ERROR_HOLD_S;
const error = { text: "set-state: refused", at: at(100), answered: false };
const boom = (when: number) => ({ text: "dispatch: boom", at: at(when), answered: false });

test("a click's error shows at every instant before its hold ends, and to no frame after", () => {
  const state = new SessionState();
  holdClickError(state, SID, "set-state: refused", at(100));
  const held = [{ error, hold: "held" }];
  for (const render of ["feed", "request"] as const) {
    expect(clickErrorsAt(state, SID, at(99.9), render)).toEqual(held);
    expect(clickErrorsAt(state, SID, at(100), render)).toEqual(held);
    expect(clickErrorsAt(state, SID, at(END - 0.001), render)).toEqual(held);
  }
  expect(clickErrorsAt(state, SID, at(END), "feed")).toEqual([{ error, hold: "over" }]);
});

test("past the hold, a request is owed it until an answer has carried it", () => {
  const state = new SessionState();
  holdClickError(state, SID, "set-state: refused", at(100));
  expect(clickErrorsAt(state, SID, at(END + 600), "request")).toEqual([{ error, hold: "owed" }]);
  answeredClickError(state, SID, [error]);
  expect(shownClickErrors(clickErrorsAt(state, SID, at(END + 600), "request"))).toEqual([]);
});

test("a second failure is a message of its own, each held from its own instant", () => {
  const state = new SessionState();
  holdClickError(state, SID, "set-state: refused", at(100));
  holdClickError(state, SID, "dispatch: boom", at(102));
  expect(clickErrors(state, SID)).toEqual([error, boom(102)]);
  // The first's hold ends where it began to: the second does not restart it.
  expect(shownClickErrors(clickErrorsAt(state, SID, at(END + 1), "feed"))).toEqual([boom(102)]);
  // An answer that carried the first leaves the second owed.
  answeredClickError(state, SID, [error]);
  expect(shownClickErrors(clickErrorsAt(state, SID, at(END + 600), "request"))).toEqual([
    boom(102),
  ]);
});

test("a failure long after an older one still owed keeps it owed to a request and shows no feed the older", () => {
  const state = new SessionState();
  holdClickError(state, SID, "set-state: refused", at(100));
  holdClickError(state, SID, "dispatch: boom", at(END + 600));
  expect(shownClickErrors(clickErrorsAt(state, SID, at(END + 601), "feed"))).toEqual([
    boom(END + 600),
  ]);
  expect(shownClickErrors(clickErrorsAt(state, SID, at(END + 601), "request"))).toEqual([
    error,
    boom(END + 600),
  ]);
});

test("a failure drops the records no render can still show", () => {
  const state = new SessionState();
  holdClickError(state, SID, "set-state: refused", at(100));
  answeredClickError(state, SID, [error]);
  holdClickError(state, SID, "dispatch: boom", at(END + 600));
  expect(clickErrors(state, SID)).toEqual([boom(END + 600)]);
});

test("reading a click's errors writes nothing, so a later render inside the hold still shows them", () => {
  const state = new SessionState();
  holdClickError(state, SID, "dispatch: boom", at(100));
  const revision = state.revision(SID);
  clickErrorsAt(state, SID, at(END + 1), "request");
  expect(state.revision(SID)).toBe(revision);
  expect(clickErrorsAt(state, SID, at(101), "feed")).toEqual([{ error: boom(100), hold: "held" }]);
});

test("an answer that marks nothing writes nothing", () => {
  const state = new SessionState();
  holdClickError(state, SID, "dispatch: boom", at(100));
  const revision = state.revision(SID);
  // Another failure at the same instant: this one stays owed.
  answeredClickError(state, SID, [error]);
  expect(state.revision(SID)).toBe(revision);
  expect(clickErrorsAt(state, SID, at(END + 1), "request")).toEqual([
    { error: boom(100), hold: "owed" },
  ]);
});

test("a session with no click error, or bare text an older daemon wrote, holds none", () => {
  const state = new SessionState();
  expect(clickErrorsAt(state, SID, at(100), "request")).toEqual([]);
  state.set(SID, "click.error", 'set-state: placement "block" refused');
  expect(clickErrorsAt(state, SID, at(100), "request")).toEqual([]);
});

test("the record keeps the fields a build that knows one failure reads, holding the newest there", () => {
  const state = new SessionState();
  holdClickError(state, SID, "set-state: refused", at(100));
  holdClickError(state, SID, "dispatch: boom", at(102));
  const stored = JSON.parse(state.get(SID, "click.error")!) as Record<string, unknown>;
  expect(stored).toEqual({ ...boom(102), earlier: [error] });
});

test("a record an older daemon wrote, with no earlier failures and no answered mark, is owed to the next request", () => {
  const state = new SessionState();
  state.set(SID, "click.error", JSON.stringify({ text: "set-state: refused", at: 100 }));
  expect(clickErrorsAt(state, SID, at(END + 600), "request")).toEqual([{ error, hold: "owed" }]);
});

test("an answer carries the shown errors to be marked until one has, inside the hold and past it", () => {
  const state = new SessionState();
  holdClickError(state, SID, "set-state: refused", at(100));
  expect(toAnswer(clickErrorsAt(state, SID, at(101), "request"))).toEqual([error]);
  expect(toAnswer(clickErrorsAt(state, SID, at(END + 600), "request"))).toEqual([error]);
  answeredClickError(state, SID, [error]);
  expect(toAnswer(clickErrorsAt(state, SID, at(101), "request"))).toEqual([]);
  expect(toAnswer(clickErrorsAt(state, SID, at(END), "feed"))).toEqual([]);
});

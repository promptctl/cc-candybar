// How long a failed click's errors stay on the bar (src/daemon/click-error.ts):
// for the hold, however often the session renders, and at least once however
// late its next render comes.

import {
  CLICK_ERROR_HOLD_S,
  heldClickError,
  holdClickError,
  showClickError,
} from "../src/daemon/click-error";
import { SessionState } from "../src/daemon/session-state";
import type { Instant } from "../src/utils/instant";

const SID = "s";
const at = (seconds: number): Instant => seconds as Instant;

test("a click's errors are shown by every render inside the hold, and cleared by the first after it", () => {
  const state = new SessionState();
  holdClickError(state, SID, "set-state: refused", at(100));
  // Thirty frames a second: every one of them inside the hold shows it.
  for (let i = 0; i < 29; i++)
    expect(showClickError(state, SID, at(100 + i / 30))).toBe("set-state: refused");
  expect(showClickError(state, SID, at(100 + CLICK_ERROR_HOLD_S))).toBe(
    "set-state: refused",
  );
  expect(showClickError(state, SID, at(100 + CLICK_ERROR_HOLD_S + 0.03))).toBeNull();
});

test("a render long after the click shows its errors once", () => {
  const state = new SessionState();
  holdClickError(state, SID, "dispatch: boom", at(100));
  expect(showClickError(state, SID, at(500))).toBe("dispatch: boom");
  expect(heldClickError(state, SID)).toBeNull();
});

test("a bare value an older daemon left in session state is shown once", () => {
  const state = new SessionState();
  state.set(SID, "click.error", 'set-state: placement "block" refused');
  expect(heldClickError(state, SID)).toEqual({
    text: 'set-state: placement "block" refused',
    at: 0,
  });
  expect(showClickError(state, SID, at(100))).toBe(
    'set-state: placement "block" refused',
  );
  expect(showClickError(state, SID, at(100))).toBeNull();
});

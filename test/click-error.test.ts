// How long a failed click's errors stay on the bar (src/daemon/click-error.ts):
// held until a render request after the hold releases them, so every frame
// drawn meanwhile shows them and Claude Code's own bar shows them at least once.

import {
  CLICK_ERROR_HOLD_S,
  heldClickError,
  holdClickError,
  releaseClickError,
} from "../src/daemon/click-error";
import { SessionState } from "../src/daemon/session-state";
import type { Instant } from "../src/utils/instant";

const SID = "s";
const at = (seconds: number): Instant => seconds as Instant;

test("a render request inside the hold keeps a click's errors; the first after it releases them", () => {
  const state = new SessionState();
  holdClickError(state, SID, "set-state: refused", at(100));
  releaseClickError(state, SID, at(100.5));
  expect(heldClickError(state, SID)?.text).toBe("set-state: refused");
  releaseClickError(state, SID, at(100 + CLICK_ERROR_HOLD_S));
  expect(heldClickError(state, SID)).toBeNull();
});

test("a render request that began before the click does not release its errors", () => {
  const state = new SessionState();
  holdClickError(state, SID, "dispatch: boom", at(100));
  releaseClickError(state, SID, at(99.9));
  expect(heldClickError(state, SID)?.text).toBe("dispatch: boom");
});

test("a bare value an older daemon left in session state is released by the next render request", () => {
  const state = new SessionState();
  state.set(SID, "click.error", 'set-state: placement "block" refused');
  expect(heldClickError(state, SID)).toEqual({
    text: 'set-state: placement "block" refused',
    at: 0,
  });
  releaseClickError(state, SID, at(100));
  expect(heldClickError(state, SID)).toBeNull();
});

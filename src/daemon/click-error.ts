// A failed click's errors, as the bar shows them: the dispatch verb holds them
// in the clicking session's state, and every render of that session reads them.
//
// How long they show is time, not a count of renders, and only the session's
// own render requests release them. A session that someone subscribes to
// renders thirty times a second (src/daemon/frame-feed.ts), so an error cleared
// by the first render that showed it was on screen for one thirtieth of a
// second; and its frames may be drawn beside the bar Claude Code draws from
// each request's answer, which must show the error too.

import type { SessionStateReader, SessionStateRW } from "./session-state.js";
import type { Instant } from "../utils/instant.js";

const KEY = "click.error";

// Seconds a click's errors stay on the bar: at least as long as one of Claude
// Code's own statusline ticks, its fastest rerun.
export const CLICK_ERROR_HOLD_S = 1;

export interface HeldClickError {
  readonly text: string;
  // When the click failed.
  readonly at: Instant;
}

export function holdClickError(
  state: SessionStateRW,
  sessionId: string,
  text: string,
  at: Instant,
): void {
  state.set(sessionId, KEY, JSON.stringify({ text, at }));
}

// [LAW:parse-dont-validate] The session's held click error. Session state
// outlives a daemon, so the value may be one a daemon from before this record
// wrote: the bare text, which was written to be shown once — it reads as
// having failed at the epoch, so the first render shows it and clears it.
export function heldClickError(
  state: SessionStateReader,
  sessionId: string,
): HeldClickError | null {
  const raw = state.get(sessionId, KEY);
  if (raw === null) return null;
  const record = recordOf(raw);
  return record ?? { text: raw, at: 0 as Instant };
}

// [LAW:single-enforcer] The one rule for when a click's errors leave the bar:
// a render request at `at`, which has just shown them, releases them once
// CLICK_ERROR_HOLD_S has passed since the click failed. Every render shows them
// while they are held, so they reach Claude Code's own bar at least once and
// every frame display for at least the hold.
export function releaseClickError(
  state: SessionStateRW,
  sessionId: string,
  at: Instant,
): void {
  const held = heldClickError(state, sessionId);
  if (held !== null && at >= held.at + CLICK_ERROR_HOLD_S)
    state.clear(sessionId, KEY);
}

function recordOf(raw: string): HeldClickError | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    // Not JSON: the bare text an older daemon wrote.
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const { text, at } = value as Record<string, unknown>;
  return typeof text === "string" && typeof at === "number"
    ? { text, at: at as Instant }
    : null;
}

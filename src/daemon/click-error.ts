// A failed click's errors, as the bar shows them: the dispatch verb holds them
// in the clicking session's state, and every render of that session asks
// whether they are still its to show.
//
// [LAW:no-ambient-temporal-coupling] How long they show is time, asked by every
// render alike: Claude Code's statusline requests and the frames a feed draws
// thirty times a second (src/daemon/frame-feed.ts) read the same records against
// their own instants, and no render writes them, so nothing has to agree on which
// render clears it. Past the hold a request still shows them until an answer
// has carried them: with no `statusLine.refreshInterval` Claude Code asks only
// on events, often long after the hold, and a failure that expired unseen
// would be silent where a click that worked still shows its effect. That fact
// is each record's own, written once by the request boundary after the answer
// went out (answeredClickError) — never by a render.

import type { SessionStateReader, SessionStateRW } from "./session-state.js";
import type { Instant } from "../utils/instant.js";
import type { Drawing } from "../config/lanes.js";
import {
  answeredBy,
  eventHoldAt,
  type EventHold,
  type HeldEvent,
} from "../utils/event-hold.js";

const KEY = "click.error";

// Seconds every render shows a click's errors: several of Claude Code's
// fastest reruns (`statusLine.refreshInterval: 1`), and long enough to read.
export const CLICK_ERROR_HOLD_S = 5;

// One failure: `at` is when it happened.
export type ClickErrorRecord = HeldEvent;

// A failure as one render makes of it: `held` inside its hold, `owed` past it
// to a request while no answer has carried it, `over` once neither holds.
export interface ClickErrorAt {
  readonly error: ClickErrorRecord;
  readonly hold: EventHold;
}

// [LAW:single-enforcer][LAW:types-are-the-program] The one write of a
// failure: each is a record of its own, with its own instant, hold and answer,
// so a click's refused step and its effect's failure, held apart in time,
// both show as two messages, and one landing while a viewer shows the other
// moves nothing under it. The records still live for some render (inside
// their hold, or owed to a request) are kept; the rest are dropped, so what
// is stored holds only what a render can still show.
export function holdClickError(
  state: SessionStateRW,
  sessionId: string,
  text: string,
  at: Instant,
): void {
  const live = clickErrors(state, sessionId).filter(
    (e) => eventHoldAt(e, CLICK_ERROR_HOLD_S, at, "request") !== "over",
  );
  store(state, sessionId, {
    newest: { text, at, answered: false },
    earlier: live,
  });
}

// [LAW:single-enforcer] The one write after a click fails: a request's answer
// that carried `errors` went out, so each is marked answered. One marked
// already, or gone since, is left as it is, and an answer that marks nothing
// writes nothing — a write would only wake every reader of the session's
// state for nothing.
export function answeredClickError(
  state: SessionStateRW,
  sessionId: string,
  errors: readonly ClickErrorRecord[],
): void {
  const stored = storedOf(state, sessionId);
  if (stored === null) return;
  const mark = (e: ClickErrorRecord): ClickErrorRecord =>
    errors.some((shown) => answeredBy(e, shown)) ? { ...e, answered: true } : e;
  const marked = {
    newest: mark(stored.newest),
    earlier: stored.earlier.map(mark),
  };
  const unmoved =
    marked.newest === stored.newest &&
    marked.earlier.every((e, i) => e === stored.earlier[i]);
  if (!unmoved) store(state, sessionId, marked);
}

// The session's click errors, oldest first, whether or not a render still
// shows them.
export function clickErrors(
  state: SessionStateReader,
  sessionId: string,
): readonly ClickErrorRecord[] {
  const stored = storedOf(state, sessionId);
  return stored === null ? [] : [...stored.earlier, stored.newest];
}

// The session's newest click error, or null.
export function lastClickError(
  state: SessionStateReader,
  sessionId: string,
): ClickErrorRecord | null {
  return storedOf(state, sessionId)?.newest ?? null;
}

// Each of the session's click errors as a render at `at` makes of it, by the
// daemon's one rule for an event-shaped error (src/utils/event-hold.ts).
export function clickErrorsAt(
  state: SessionStateReader,
  sessionId: string,
  at: Instant,
  render: Drawing["by"],
): readonly ClickErrorAt[] {
  return clickErrors(state, sessionId).map((error) => ({
    error,
    hold: eventHoldAt(error, CLICK_ERROR_HOLD_S, at, render),
  }));
}

// The errors a render shows.
export const shownClickErrors = (
  errors: readonly ClickErrorAt[],
): readonly ClickErrorRecord[] =>
  errors.flatMap(({ error, hold }) => (hold === "over" ? [] : [error]));

// [LAW:single-enforcer] The errors an answer drawn over `errors` marks
// answered once it reaches its client: those shown that no answer has carried
// yet. None once marked, so an answer inside the hold asks for no mark
// already made.
export const toAnswer = (
  errors: readonly ClickErrorAt[],
): readonly ClickErrorRecord[] =>
  shownClickErrors(errors).filter((error) => !error.answered);

// What is stored: the newest failure, and the older ones still live, oldest
// first. Session state is read by builds of either age, so the record only
// gains a field: the newest failure keeps the fields a record always had,
// which a build that knows one failure reads as that one, and the older ones
// ride in `earlier`, which it leaves alone.
interface Stored {
  readonly newest: ClickErrorRecord;
  readonly earlier: readonly ClickErrorRecord[];
}

function store(
  state: SessionStateRW,
  sessionId: string,
  { newest, earlier }: Stored,
): void {
  state.set(sessionId, KEY, JSON.stringify({ ...newest, earlier }));
}

// [LAW:parse-dont-validate] Session state outlives a daemon: a record with no
// `earlier` is from a build that held one failure; one with no `answered` is
// from before the mark, which cleared each once a request past its hold had
// shown it, so it reads as unanswered; bare text was written before the hold
// was a time, so its hold is long over, and it reads as none.
function storedOf(state: SessionStateReader, sessionId: string): Stored | null {
  const raw = state.get(sessionId, KEY);
  if (raw === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  const newest = recordOf(value);
  if (newest === null) return null;
  const { earlier } = value as Record<string, unknown>;
  return {
    newest,
    earlier: Array.isArray(earlier)
      ? earlier.flatMap((e) => {
          const record = recordOf(e);
          return record === null ? [] : [record];
        })
      : [],
  };
}

function recordOf(value: unknown): ClickErrorRecord | null {
  if (typeof value !== "object" || value === null) return null;
  const { text, at, answered } = value as Record<string, unknown>;
  return typeof text === "string" &&
    typeof at === "number" &&
    (answered === undefined || typeof answered === "boolean")
    ? { text, at: at as Instant, answered: answered === true }
    : null;
}

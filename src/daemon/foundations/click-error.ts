// A failed click's errors, as the bar shows them: the click and each act it
// asked for hold them in the clicking session's state, and every render of that session asks
// whether they are still its to show.
//
// [LAW:no-ambient-temporal-coupling] How long they show is time, asked by every
// render alike: Claude Code's statusline requests and the frames a feed draws
// thirty times a second (src/daemon/frame-feed.ts) read the same record against
// their own instants, and no render writes it, so nothing has to agree on which
// render clears it. Past the hold a request still shows them until an answer
// has carried them: with no `statusLine.refreshInterval` Claude Code asks only
// on events, often long after the hold, and a failure that expired unseen
// would be silent where a click that worked still shows its effect. That fact
// is the record's own, written once by the request boundary after the answer
// went out (answeredClickError) — never by a render.

import type { SessionId } from "./session-id.js";
import type {
  SessionStateReader,
  SessionStateRW,
} from "../../renderer-interface/session-state.js";
import type { Instant } from "../../utils/instant.js";
import type { Drawing } from "../../config/lanes.js";
import { SETTINGS_NS } from "../../config/reserved-names.js";
import {
  answeredBy,
  eventHoldAt,
  joinedEvent,
  type HeldEvent,
} from "../../utils/event-hold.js";

// [LAW:one-source-of-truth] In the bar's own namespace, as every key it
// mints is, so no authored key reaches it.
const KEY = `${SETTINGS_NS}clickError`;

// Seconds every render shows a click's errors: several of Claude Code's
// fastest reruns (`statusLine.refreshInterval: 1`), and long enough to read.
export const CLICK_ERROR_HOLD_S = 5;

// `at` is when the click failed.
export type ClickErrorRecord = HeldEvent;

// What one render makes of the session's click error: `held` inside the hold,
// `owed` past it to a request while no answer has carried it.
export type ClickErrorHold =
  | { readonly kind: "none" }
  | { readonly kind: "held"; readonly error: ClickErrorRecord }
  | { readonly kind: "owed"; readonly error: ClickErrorRecord }
  | { readonly kind: "over" };

// A failure of the session's click, or of an act one asked for, joined to the
// last by the one rule for events that follow each other.
export function holdClickError(
  state: SessionStateRW,
  sessionId: SessionId,
  text: string,
  at: Instant,
): void {
  const record: ClickErrorRecord = joinedEvent(
    lastClickError(state, sessionId),
    text,
    at,
  );
  state.set(sessionId, KEY, JSON.stringify(record));
}

// [LAW:single-enforcer] The one write after a click fails: a request's answer
// that carried `error` went out. A newer failure since, or a mark already made,
// is left as it is — the second would only wake every reader of the session's
// state for nothing.
export function answeredClickError(
  state: SessionStateRW,
  sessionId: SessionId,
  error: ClickErrorRecord,
): void {
  const last = lastClickError(state, sessionId);
  if (last === null || !answeredBy(last, error)) return;
  state.set(sessionId, KEY, JSON.stringify({ ...last, answered: true }));
}

// [LAW:parse-dont-validate] The session's last click error, whether or not a
// render still shows it.
export function lastClickError(
  state: SessionStateReader,
  sessionId: SessionId,
): ClickErrorRecord | null {
  const raw = state.get(sessionId, KEY);
  return raw === null ? null : recordOf(raw);
}

// Whether a render shows the session's click errors, by the daemon's one rule
// for an event-shaped error (src/utils/event-hold.ts).
export function clickErrorAt(
  state: SessionStateReader,
  sessionId: SessionId,
  at: Instant,
  render: Drawing["by"],
): ClickErrorHold {
  const last = lastClickError(state, sessionId);
  if (last === null) return { kind: "none" };
  const kind = eventHoldAt(last, CLICK_ERROR_HOLD_S, at, render);
  return kind === "over" ? { kind } : { kind, error: last };
}

// [LAW:no-silent-failure] Only this module writes the key, and no authored
// key reaches the namespace it sits in, so a record that does not parse is
// this module's bug, said. Text is as the writer bounded it and revision is
// always there, since the answer's identity is the revision.
function recordOf(raw: string): ClickErrorRecord {
  const value: unknown = JSON.parse(raw);
  const { text, at, answered, revision } = (value ?? {}) as Record<
    string,
    unknown
  >;
  if (
    typeof text !== "string" ||
    typeof at !== "number" ||
    typeof answered !== "boolean" ||
    typeof revision !== "number" ||
    !Number.isSafeInteger(revision) ||
    revision < 1
  )
    throw new Error(`click error record ${raw} is not one this build writes`);
  return { text, at: at as Instant, answered, revision };
}

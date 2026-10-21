// A failed click's errors, as the bar shows them: the dispatch verb holds them
// in the clicking session's state, and every render of that session asks
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

import type { SessionStateReader, SessionStateRW } from "./session-state.js";
import type { Instant } from "../utils/instant.js";
import type { Drawing } from "../config/lanes.js";

const KEY = "click.error";

// Seconds every render shows a click's errors: several of Claude Code's
// fastest reruns (`statusLine.refreshInterval: 1`), and long enough to read.
export const CLICK_ERROR_HOLD_S = 5;

export interface ClickErrorRecord {
  readonly text: string;
  // When the click failed.
  readonly at: Instant;
  // Whether a request's answer has carried it to its client.
  readonly answered: boolean;
}

// What one render makes of the session's click error: `held` inside the hold,
// `owed` past it to a request while no answer has carried it.
export type ClickErrorHold =
  | { readonly kind: "none" }
  | { readonly kind: "held"; readonly error: ClickErrorRecord }
  | { readonly kind: "owed"; readonly error: ClickErrorRecord }
  | { readonly kind: "over" };

export function holdClickError(
  state: SessionStateRW,
  sessionId: string,
  text: string,
  at: Instant,
): void {
  const record: ClickErrorRecord = { text, at, answered: false };
  state.set(sessionId, KEY, JSON.stringify(record));
}

// [LAW:single-enforcer] The one write after a click fails: a request's answer
// that carried `error` went out. A newer failure since, or a mark already made,
// is left as it is — the second would only wake every reader of the session's
// state for nothing.
export function answeredClickError(
  state: SessionStateRW,
  sessionId: string,
  error: ClickErrorRecord,
): void {
  const last = lastClickError(state, sessionId);
  const same = last?.at === error.at && last.text === error.text;
  if (!same || last.answered) return;
  state.set(sessionId, KEY, JSON.stringify({ ...last, answered: true }));
}

// [LAW:parse-dont-validate] The session's last click error, whether or not a
// render still shows it. Session state outlives a daemon: a record with no
// `answered` is one a daemon from before it wrote, which cleared each once a
// request past its hold had shown it, so it reads as unanswered; bare text was
// written before the hold was a time, so its hold is long over, and it reads
// as none.
export function lastClickError(
  state: SessionStateReader,
  sessionId: string,
): ClickErrorRecord | null {
  const raw = state.get(sessionId, KEY);
  return raw === null ? null : recordOf(raw);
}

// [LAW:single-enforcer] The one rule for whether a render shows a click's
// errors: its instant is before the hold ends, or it is a request and no
// answer has carried them yet.
export function clickErrorAt(
  state: SessionStateReader,
  sessionId: string,
  at: Instant,
  // A request answers a client, a frame a feed draws does not, so only a
  // request is owed the errors past the hold.
  render: Drawing["by"],
): ClickErrorHold {
  const last = lastClickError(state, sessionId);
  if (last === null) return { kind: "none" };
  if (at < last.at + CLICK_ERROR_HOLD_S) return { kind: "held", error: last };
  return render === "request" && !last.answered
    ? { kind: "owed", error: last }
    : { kind: "over" };
}

function recordOf(raw: string): ClickErrorRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const { text, at, answered } = value as Record<string, unknown>;
  return typeof text === "string" &&
    typeof at === "number" &&
    (answered === undefined || typeof answered === "boolean")
    ? { text, at: at as Instant, answered: answered === true }
    : null;
}

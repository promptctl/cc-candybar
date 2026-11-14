// What each session's last render REQUEST said about itself, and when — what
// the doctor reads: the click for its own session, `cc-candybar doctor`
// through daemon-stats, since the command itself is no statusline client. A
// request says which client drew the bar (the install check) and whether
// Claude Code's hook payload carried the rate-limit windows (the segment-data
// check, brandon-doctor-v62x.onf), and where the session's transcript is (the
// session-data check, brandon-doctor-v62x.p4l), and whether the bar it drew
// moves (the effect-refresh check, brandon-doctor-v62x.tgp).
//
// [LAW:no-ambient-temporal-coupling] Held in memory by this daemon process,
// keyed by session and the client's role, REPLACED by every render: a
// session's next render after a rebuild shows its new client at once, and a
// session that stopped rendering only ages. The role is in the key because one
// session's bar can be drawn by two clients at once — Claude Code's statusline
// and a `cc-candybar frames` display — and the one rendering last must not
// hide the other from the check. Native, the Node fallback and a client too
// old to report are one role, the statusline, so a rebuild replaces it. SessionState is not this record — it is persisted, reloaded on
// start and never pruned, so a session an older daemon recorded would answer
// for a client nothing runs any more.

import type { SessionId } from "./foundations/session-id.js";
import type { ClaudeHookData } from "../utils/claude.js";
import type { Instant } from "../utils/instant.js";
import { answeredOf, roleOf } from "./foundations/sighting-roles.js";
import {
  type RateLimitsSeen,
  type TranscriptSaid,
  type RenderSaid,
  type RoledSaid,
  type RenderSighting,
  SIGHTINGS_KEPT,
} from "./foundations/sightings";

export function rateLimitsSeen(
  hookData: Pick<ClaudeHookData, "rate_limits" | "context_window">,
): RateLimitsSeen {
  const windows = hookData.rate_limits;
  if (windows?.five_hour != null || windows?.seven_day != null) {
    return "carried";
  }
  return answeredOf(hookData) === "no" ? "unanswered" : "missing";
}

export function transcriptSaid(
  hookData: Pick<ClaudeHookData, "transcript_path" | "context_window">,
): TranscriptSaid {
  return {
    path: hookData.transcript_path,
    answered: answeredOf(hookData) === "yes",
  };
}

// [LAW:single-enforcer] The render path is the one writer (`see`, when a
// request arrives and again when its render settles, both stamped with the
// instant and order it ARRIVED in); the doctor the one reader — daemon-stats for
// the CLI (`list`), the click for its own session (`ofSession`).
export class RenderSightings {
  private readonly seen = new Map<
    string,
    {
      readonly sessionId: SessionId;
      readonly said: RoledSaid;
      readonly at: Instant;
      readonly order: number;
    }
  >();

  // `order`: the request's arrival order. Renders settle out of order — the
  // day's first seed, a PR lookup — so a request that settles after a newer
  // one of the same session and role is not its latest, and is dropped; its
  // own settling replaces its arrival.
  see(
    sessionId: SessionId,
    said: RenderSaid,
    at: Instant,
    order: number,
  ): void {
    const role = roleOf(said.client);
    // JSON, so no session id can spell another sighting's key.
    const key = JSON.stringify([sessionId, role]);
    const known = this.seen.get(key);
    if (known !== undefined && known.order > order) return;
    // Re-inserted, so the map's order is the order of last renders and the
    // first key is the sighting longest without one.
    this.seen.delete(key);
    this.seen.set(key, { sessionId, said: { ...said, role }, at, order });
    if (this.seen.size > SIGHTINGS_KEPT) {
      this.seen.delete(this.seen.keys().next().value!);
    }
  }

  list(now: Instant): readonly RenderSighting[] {
    return [...this.seen.values()].map(({ sessionId, said, at }) => ({
      ...said,
      sessionId,
      ago: now - at,
    }));
  }

  // The latest render in each role that drew one session's bar — none when
  // this process has served it no render (a daemon restarted under a bar
  // already on screen).
  ofSession(sessionId: SessionId, now: Instant): readonly RenderSighting[] {
    return this.list(now).filter((s) => s.sessionId === sessionId);
  }
}

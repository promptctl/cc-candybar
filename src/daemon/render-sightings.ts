// The latest render request by session and client role, as daemon-stats reads it.
//
// [LAW:no-ambient-temporal-coupling] Held in memory. A new request replaces
// its role's record, and a session that stops rendering only ages. Two
// clients such as the statusline and frames retain separate sightings.
// The native statusline, its Node fallback and an older client that did
// not report its identity share the statusline's role.

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

// [LAW:single-enforcer] The render path records arrivals and settlements in
// request order. Daemon-stats reads those records.
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
}

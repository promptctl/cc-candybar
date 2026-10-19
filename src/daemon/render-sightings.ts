// What each session's last render REQUEST said about itself, and when — what
// the doctor reads: the click for its own session, `cc-candybar doctor`
// through daemon-stats, since the command itself is no statusline client. A
// request says which client drew the bar (the install check) and whether
// Claude Code's hook payload carried the rate-limit windows (the segment-data
// check, brandon-doctor-v62x.onf).
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

import type { ClientHint } from "../client-hint.js";
import type { ClaudeHookData } from "../utils/claude.js";
import type { Instant } from "../utils/instant.js";

// The newest sightings kept; a daemon serves a handful of sessions at once.
export const SIGHTINGS_KEPT = 64;

// [LAW:types-are-the-program] What one hook payload says of the rate-limit
// windows. `unanswered` is a session with no API response to report on —
// Claude Code nulls `context_window.current_usage` before the first API call
// and again right after a /compact — so its missing windows are no finding.
// A payload with no `context_window` at all comes from a Claude Code older
// than both fields, which sends no windows either: `missing`. Carried means a
// window the payload reads (`five_hour`, `seven_day` — buildRenderPayload),
// so an empty or null `rate_limits` is `missing`.
export const RATE_LIMITS_SEEN = ["carried", "missing", "unanswered"] as const;
export type RateLimitsSeen = (typeof RATE_LIMITS_SEEN)[number];

export function rateLimitsSeen(
  hookData: Pick<ClaudeHookData, "rate_limits" | "context_window">,
): RateLimitsSeen {
  const windows = hookData.rate_limits;
  if (windows?.five_hour != null || windows?.seven_day != null) {
    return "carried";
  }
  return hookData.context_window?.current_usage === null
    ? "unanswered"
    : "missing";
}

// What one render request said. `client` null: the render's client did not
// report what it is. `claudeConfigDir`: the Claude Code directory the
// session runs with, resolved (`claudeConfigDir`, src/claude-settings.ts) —
// the rate-limit windows are that directory's account's, not the machine's.
export interface RenderSaid {
  readonly client: ClientHint | null;
  readonly rateLimits: RateLimitsSeen;
  readonly claudeConfigDir: string;
}

export interface RenderSighting extends RenderSaid {
  // Seconds since the session's last render.
  readonly ago: number;
}

// [LAW:single-enforcer] The render path is the one writer (`see`, at the
// instant it serves a render); the doctor the one reader — daemon-stats for
// the CLI (`list`), the click for its own session (`ofSession`).
export class RenderSightings {
  private readonly seen = new Map<
    string,
    {
      readonly sessionId: string;
      readonly said: RenderSaid;
      readonly at: Instant;
    }
  >();

  see(sessionId: string, said: RenderSaid, at: Instant): void {
    // JSON, so no session id can spell another sighting's key.
    const role = said.client?.kind === "frames" ? "frames" : "statusline";
    const key = JSON.stringify([sessionId, role]);
    // Re-inserted, so the map's order is the order of last renders and the
    // first key is the sighting longest without one.
    this.seen.delete(key);
    this.seen.set(key, { sessionId, said, at });
    if (this.seen.size > SIGHTINGS_KEPT) {
      this.seen.delete(this.seen.keys().next().value!);
    }
  }

  list(now: Instant): readonly RenderSighting[] {
    return [...this.seen.values()].map(({ said, at }) => ({
      ...said,
      ago: now - at,
    }));
  }

  // The latest render in each role that drew one session's bar — none when
  // this process has served it no render (a daemon restarted under a bar
  // already on screen).
  ofSession(sessionId: string): readonly RenderSaid[] {
    return [...this.seen.values()]
      .filter((s) => s.sessionId === sessionId)
      .map((s) => s.said);
  }
}

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

import type { ClientHint } from "../client-hint.js";
import { DRAWN_MOTIONS } from "../render/drawn-motion.js";
import type { ClaudeHookData } from "../utils/claude.js";
import type { Instant } from "../utils/instant.js";

// The newest sightings kept; a daemon serves a handful of sessions at once.
export const SIGHTINGS_KEPT = 64;

// [LAW:one-source-of-truth] What the one mark Claude Code leaves says of
// whether it has answered: `current_usage` is null before the first response
// and right after a /compact. A payload without the field — a Claude Code
// before 2.0.70, or before `context_window` — says nothing either way.
export type Answered = "yes" | "no" | "unknown";

export function answeredOf(
  hookData: Pick<ClaudeHookData, "context_window">,
): Answered {
  const usage = hookData.context_window?.current_usage;
  return usage === null ? "no" : usage === undefined ? "unknown" : "yes";
}

// [LAW:types-are-the-program] What one hook payload says of the rate-limit
// windows. `unanswered` is a session with no API response to report on, so
// its missing windows are no finding. A Claude Code too old to leave the mark
// sends no windows either: `missing`. Carried means a window the payload
// reads (`five_hour`, `seven_day` — payloadOf), so an empty or null
// `rate_limits` is `missing`.
export const RATE_LIMITS_SEEN = ["carried", "missing", "unanswered"] as const;
export type RateLimitsSeen = (typeof RATE_LIMITS_SEEN)[number];

export function rateLimitsSeen(
  hookData: Pick<ClaudeHookData, "rate_limits" | "context_window">,
): RateLimitsSeen {
  const windows = hookData.rate_limits;
  if (windows?.five_hour != null || windows?.seven_day != null) {
    return "carried";
  }
  return answeredOf(hookData) === "no" ? "unanswered" : "missing";
}

// Where the session's transcript is, and whether Claude Code has shown it
// answered in it — until it has, a transcript that does not exist yet is no
// finding, since a session before its first prompt has none.
export interface TranscriptSaid {
  readonly path: string;
  readonly answered: boolean;
}

export function transcriptSaid(
  hookData: Pick<ClaudeHookData, "transcript_path" | "context_window">,
): TranscriptSaid {
  return {
    path: hookData.transcript_path,
    answered: answeredOf(hookData) === "yes",
  };
}

// [LAW:types-are-the-program] What the session's bar drew, read off the frame
// itself (`Frame`, src/render/frame.ts): whether anything on it changes
// without new data — an effect, a transition, a template's `frames` — so the
// doctor asks Claude Code for a redraw a second exactly when the bar needs one
// (brandon-doctor-v62x.tgp). A render that threw drew nothing.
// `can-move`: still now, but the config can start motion at any render
// without a click — a `globals.effect` rule, placements fading as they come
// and go, a placement wearing its own effect — so it needs the redraw a moving
// bar does. `drawing`: the request arrived and its render has not settled.
export const FRAMES_SEEN = [...DRAWN_MOTIONS, "failed", "drawing"] as const;
export type FrameSeen = (typeof FRAMES_SEEN)[number];

// [LAW:one-source-of-truth] Which client drew a sighting: Claude Code's
// statusline (native, the Node fallback, or a client too old to report), or
// a `cc-candybar frames` display, whose motion the daemon's feed pushes.
export const SIGHTING_ROLES = ["statusline", "frames"] as const;
export type SightingRole = (typeof SIGHTING_ROLES)[number];
export const roleOf = (client: ClientHint | null): SightingRole =>
  client?.kind === "frames" ? "frames" : "statusline";

// What one client drew of a session's bar.
export interface FrameSighting {
  readonly role: SightingRole;
  readonly frame: FrameSeen;
}

// What one render request said. `client` null: the render's client did not
// report what it is. `claudeConfigDir`: the Claude Code directory the
// session runs with, resolved (`claudeConfigDir`, src/claude-settings.ts) —
// the rate-limit windows are that directory's account's, not the machine's.
// `termCols`: the width the client measured, as the checkpoint admitted it —
// null when it could not measure, or the daemon refused what it sent.
// `projectDir`: the session's project (`workspace.project_dir`), where Claude
// Code reads the project's settings files — with `claudeConfigDir`, which of
// them redraw the bar (brandon-doctor-v62x.y5d).
export interface RenderSaid {
  readonly client: ClientHint | null;
  readonly termCols: number | null;
  readonly rateLimits: RateLimitsSeen;
  readonly claudeConfigDir: string;
  readonly projectDir: string;
  readonly transcript: TranscriptSaid;
  readonly frame: FrameSeen;
}

// A request's sighting, with the role its client drew in.
export interface RoledSaid extends RenderSaid {
  readonly role: SightingRole;
}

export interface RenderSighting extends RoledSaid {
  // Whose render it was: `cc-candybar doctor` run in a Claude Code session's
  // shell finds that session's own sighting by it.
  readonly sessionId: string;
  // Seconds since the session's last render.
  readonly ago: number;
}

// [LAW:single-enforcer] The render path is the one writer (`see`, when a
// request arrives and again when its render settles, both stamped with the
// instant and order it ARRIVED in); the doctor the one reader — daemon-stats for
// the CLI (`list`), the click for its own session (`ofSession`).
export class RenderSightings {
  private readonly seen = new Map<
    string,
    {
      readonly sessionId: string;
      readonly said: RoledSaid;
      readonly at: Instant;
      readonly order: number;
    }
  >();

  // `order`: the request's arrival order. Renders settle out of order — the
  // day's first seed, a PR lookup — so a request that settles after a newer
  // one of the same session and role is not its latest, and is dropped; its
  // own settling replaces its arrival.
  see(sessionId: string, said: RenderSaid, at: Instant, order: number): void {
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
  ofSession(sessionId: string, now: Instant): readonly RenderSighting[] {
    return this.list(now).filter((s) => s.sessionId === sessionId);
  }
}

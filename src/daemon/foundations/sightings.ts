// What one render said of the session that sent it: its rate-limit windows,
// its transcript, the frame it drew. The host records them and the doctor
// reads them, so both name them here.

import type { SessionId } from "./session-id.js";
import { DRAWN_MOTIONS } from "../../render/drawn-motion.js";
import type { ClientHint } from "../../client-hint.js";
import type { SightingRole } from "./sighting-roles.js";

// The newest sightings kept; a daemon serves a handful of sessions at once.
export const SIGHTINGS_KEPT = 64;

// [LAW:types-are-the-program] What one hook payload says of the rate-limit
// windows. `unanswered` is a session with no API response to report on, so
// its missing windows are no finding. A Claude Code too old to leave the mark
// sends no windows either: `missing`. Carried means a window the payload
// reads (`five_hour`, `seven_day` — projectPayload), so an empty or null
// `rate_limits` is `missing`.
export const RATE_LIMITS_SEEN = ["carried", "missing", "unanswered"] as const;

export type RateLimitsSeen = (typeof RATE_LIMITS_SEEN)[number];

// Where the session's transcript is, and whether Claude Code has shown it
// answered in it — until it has, a transcript that does not exist yet is no
// finding, since a session before its first prompt has none.
export interface TranscriptSaid {
  readonly path: string;
  readonly answered: boolean;
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
  // Whose render it was: a doctor run reads its own session's sightings.
  readonly sessionId: SessionId;
  // Seconds since the session's last render.
  readonly ago: number;
}

// Which of the daemon's render sightings a doctor run judges
// (brandon-doctor-v62x.y5d). A click judges its own session's bar, and so does
// `cc-candybar doctor` run in a Claude Code session's shell
// (`CLAUDE_CODE_SESSION_ID`); run anywhere else the command has no bar of its
// own, so it judges every session that drew one recently.
//
// [LAW:single-enforcer] Every sighting set a run reads — clients, rate
// limits, transcripts, frames, width — is picked here, by one scope, so no
// check judges a different set of bars than its neighbours.

import type {
  FrameSighting,
  RenderSighting,
} from "../daemon/render-sightings.js";
import { RECENT_CLIENT_S } from "./checks.js";
import { redrawsOf } from "./redraws.js";

// [LAW:types-are-the-program] `session`: one session's bar, known to be on
// screen — however long it has been idle, since a click, or a shell inside
// that session, is the proof. `recent`: every session that drew a bar within
// RECENT_CLIENT_S, since a session that stopped looks like one idle.
export type SightingScope =
  | { readonly kind: "session"; readonly sessionId: string }
  | { readonly kind: "recent" };

// The command's scope: the session it runs in, if it runs in one. Claude
// Code sets the variable in its shells; an empty value names no session.
export const scopeOf = (sessionId: string | undefined): SightingScope =>
  sessionId === undefined || sessionId === ""
    ? { kind: "recent" }
    : { kind: "session", sessionId };

type Sighted = Pick<RenderSighting, "sessionId" | "ago">;

export const inScope = <S extends Sighted>(
  scope: SightingScope,
  sightings: readonly S[],
): readonly S[] =>
  sightings.filter((s) =>
    scope.kind === "session"
      ? s.sessionId === scope.sessionId
      : s.ago <= RECENT_CLIENT_S,
  );

// One bar a sighting drew, how often Claude Code redrew it, and where the
// settings that redraw it are read: the session's project, and the Claude
// Code directory it runs with.
export interface SightedBar extends FrameSighting {
  readonly projectDir: string;
  readonly claudeConfigDir: string;
}

// The bars of a scope's sightings. Each window ends now for a bar known to be
// on screen, so the silence since its last render counts against its redraw
// rate; any other ends at its last render, since a session that closed and
// one idle on events alone look the same from the daemon (src/doctor/redraws.ts).
export const barsOf = (
  scope: SightingScope,
  sightings: ReadonlyArray<
    Pick<
      RenderSighting,
      | "sessionId"
      | "ago"
      | "role"
      | "frame"
      | "since"
      | "redrawn"
      | "projectDir"
      | "claudeConfigDir"
    >
  >,
): readonly SightedBar[] =>
  inScope(scope, sightings).map(
    ({ role, frame, since, redrawn, projectDir, claudeConfigDir }) => ({
      role,
      frame,
      projectDir,
      claudeConfigDir,
      // A record holds its latest render's second, so `min` is defined.
      redraws: redrawsOf(
        redrawn,
        since,
        scope.kind === "session" ? 0 : Math.min(...redrawn),
      ),
    }),
  );

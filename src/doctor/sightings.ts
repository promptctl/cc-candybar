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

// How a doctor click reached the daemon: a link the terminal drew, delivered
// by the URL handler (its version, or null from one too old to report it), or
// a range of the tmux status line, which tmux's own binding runs — proof that
// the bar is on screen, and of nothing about links or the handler.
export type ClickArrival =
  | { readonly via: "link"; readonly handler: string | null }
  | { readonly via: "tmux-status" };

// [LAW:types-are-the-program] One session's bar, however long it has been
// idle — `clicked`: a click on its 🩺, so the bar is cc-candybar's and on
// screen, arrived `via` a link or the tmux status line; `shell`: a shell
// inside the session, which is alive, but proves nothing of its bar (a
// `claude -p` session draws none, and a statusLine may run something else).
// `recent`: every session that drew a bar within RECENT_CLIENT_S, since a
// session that stopped looks like one idle.
export type SightingScope =
  | {
      readonly kind: "clicked";
      readonly sessionId: string;
      readonly via: ClickArrival["via"];
    }
  | { readonly kind: "shell"; readonly sessionId: string }
  | { readonly kind: "recent" };

// The command's scope: the session it runs in, if it runs in one. Claude
// Code sets the variable in its shells; an empty value names no session.
export const scopeOf = (sessionId: string | undefined): SightingScope =>
  sessionId === undefined || sessionId === ""
    ? { kind: "recent" }
    : { kind: "shell", sessionId };

type Sighted = Pick<RenderSighting, "sessionId" | "ago">;

export const inScope = <S extends Sighted>(
  scope: SightingScope,
  sightings: readonly S[],
): readonly S[] =>
  sightings.filter((s) =>
    scope.kind === "recent"
      ? s.ago <= RECENT_CLIENT_S
      : s.sessionId === scope.sessionId,
  );

// [LAW:one-source-of-truth] The project the run's own Claude Code reads its
// settings from and the daemon renders it with: a session's as its render
// recorded it — a shell's cwd may be any directory under it — else the
// command's directory, standing in for a session started there.
export const ownProject = (
  scope: SightingScope,
  sightings: ReadonlyArray<
    Pick<RenderSighting, "sessionId" | "ago" | "projectDir">
  >,
  cwd: string,
): string => {
  if (scope.kind === "recent") return cwd;
  const [own] = inScope(scope, sightings);
  return own === undefined ? cwd : own.projectDir;
};

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
        scope.kind === "recent" ? Math.min(...redrawn) : 0,
      ),
    }),
  );

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

// [LAW:types-are-the-program] Who delivered a link to the daemon: the URL
// handler app, forwarding it raw in a frame of the version it spells, or
// `cc-candybar url-handle`, which splits the verb itself — run by the tmux
// status line's click binding, or by the retired AppleScript applet an old
// install left registered for the scheme.
export type Delivery =
  | { readonly kind: "forwarder"; readonly urlV: number }
  | { readonly kind: "cli" };

// How a click reached the daemon: a link the terminal drew, with who delivered
// it, or a range of the tmux status line, which tmux's own binding runs — proof
// that the bar is on screen, and of nothing about links or the handler.
export type ClickArrival =
  | { readonly via: "link"; readonly delivery: Delivery }
  | { readonly via: "tmux-status" };

// [LAW:dataflow-not-control-flow] Whether the client that brought the click
// stays for the answer, as a fact of its arrival: the forwarder writes its
// frame and hangs up by design, so its leaving says nothing about the click,
// which still waits for its turn. Every other client holds the socket until
// answered, so its leaving abandons a click still queued.
export function clientWaits(arrival: ClickArrival): boolean {
  return arrival.via === "tmux-status" || arrival.delivery.kind === "cli";
}

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

// One bar a sighting drew, and where the settings that redraw it are read:
// the session's project, and the Claude Code directory it runs with.
export interface SightedBar extends FrameSighting {
  readonly projectDir: string;
  readonly claudeConfigDir: string;
}

// The bars of a scope's sightings.
export const barsOf = (
  scope: SightingScope,
  sightings: ReadonlyArray<
    Pick<
      RenderSighting,
      "sessionId" | "ago" | "role" | "frame" | "projectDir" | "claudeConfigDir"
    >
  >,
): readonly SightedBar[] =>
  inScope(scope, sightings).map(
    ({ role, frame, projectDir, claudeConfigDir }) => ({
      role,
      frame,
      projectDir,
      claudeConfigDir,
    }),
  );

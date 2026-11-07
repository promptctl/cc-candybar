// Whose session a tmux pane runs: the one the pane's Claude Code holds, as the
// record Claude Code keeps of each of its processes says it.

import { LANES, LANE_NAMES, type LaneSwitches } from "../config/lanes.js";
import { inTmux, samePane, type TmuxHint } from "../tmux-hint.js";
import type { ClientHints } from "./protocol.js";

// [LAW:no-silent-failure] A process's session as its own record says it, or
// why the record says none: never read as the session a reader expects.
export type HeldSession =
  | { readonly kind: "holds"; readonly sessionId: string }
  | { readonly kind: "unread"; readonly why: string };

// The session Claude Code's process `pid` holds now, by the record it keeps
// of itself under its configuration directory (`configDir`, as the process's
// environment names it; the default when it names none): a `/clear` or
// `/resume` rewrites it, though the process stays one.
export type HeldSessionOf = (
  pid: number,
  configDir: string | undefined,
) => HeldSession;

// [LAW:types-are-the-program] The pane a request's session runs in, as the
// render checkpoint stamps it: outside tmux, running in the pane its client
// names, or named there by a client whose session that pane is not known to
// run, with why.
export type SessionPane =
  | { readonly kind: "outside" }
  | { readonly kind: "runs"; readonly tmux: TmuxHint }
  | {
      readonly kind: "unconfirmed";
      readonly tmux: TmuxHint;
      readonly why: string;
    };

// [LAW:one-source-of-truth] A session runs in the pane its client names only
// when the process that ran the client is a Claude Code whose own record holds
// that session. Every process in the pane inherits its tmux variables, so a
// client run from Claude Code's shell names the pane too, and so does one run
// under the old session's id after a `/clear`.
export function sessionPaneOf(
  hints: ClientHints,
  sessionId: string,
  heldSession: HeldSessionOf,
): SessionPane {
  const { tmux, parentPid } = hints;
  if (!inTmux(tmux)) return { kind: "outside" };
  if (parentPid === undefined)
    return {
      kind: "unconfirmed",
      tmux,
      why: "its client is too old to say which process ran it (reinstall it with `cc-candybar install`)",
    };
  const held = heldSession(parentPid, hints.claudeConfigDir);
  if (held.kind === "unread")
    return {
      kind: "unconfirmed",
      tmux,
      why: `the process that ran its statusline (pid ${parentPid}) is no Claude Code whose session can be read: ${held.why}`,
    };
  return held.sessionId === sessionId
    ? { kind: "runs", tmux }
    : {
        kind: "unconfirmed",
        tmux,
        why: `the Claude Code that ran its statusline (pid ${parentPid}) holds session ${held.sessionId}`,
      };
}

// The pane `pane` says its session runs in, or null when it runs in none.
export const runningPane = (pane: SessionPane): TmuxHint | null =>
  pane.kind === "runs" ? pane.tmux : null;

// [LAW:one-source-of-truth] Whether `req`'s session runs in the pane `where`
// now, by its Claude Code's record as it reads at this call: the stamp `req`
// arrived with is the record as it read then, which a `/clear` rewrites under
// the same process, so a lookup of a pane's session never answers from it.
export const runsNowIn =
  (where: Pick<TmuxHint, "socket" | "pane">, heldSession: HeldSessionOf) =>
  (req: { readonly hints: ClientHints; readonly sessionId: string }): boolean =>
    inTmux(req.hints.tmux) &&
    samePane(req.hints.tmux, where) &&
    sessionPaneOf(req.hints, req.sessionId, heldSession).kind === "runs";

// [LAW:nothing-unseen] The stamp as the render event's `pane` field.
export const paneFact = (pane: SessionPane): string =>
  pane.kind === "unconfirmed" ? `unconfirmed: ${pane.why}` : pane.kind;

// [LAW:no-silent-failure] Why a lane that shows the session its pane runs
// shows another bar than this one, while such a lane is on: null otherwise.
export function sessionPaneError(
  pane: SessionPane,
  lanes: LaneSwitches,
): string | null {
  const on = LANE_NAMES.filter(
    (lane) => lanes[lane] && LANES[lane].showsPaneSession,
  );
  return pane.kind !== "unconfirmed" || on.length === 0
    ? null
    : `The ${on.map((lane) => LANES[lane].label).join(" and ")} of pane ${pane.tmux.pane} shows the session the pane's Claude Code holds, and this one is not known to be it: ${pane.why}`;
}

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

// [LAW:types-are-the-program] Where a request's session runs, as the render
// checkpoint stamps it: confirmed by the record of the Claude Code that ran its
// client, in the tmux pane the client names or outside tmux (`tmux` null); left,
// when that Claude Code's record holds another session, so the request is a
// tick of a session it has moved on from (a `/clear` can be followed by one);
// or not known, with why, wherever the client ran. Only a confirmed stamp says
// anything of where the session is.
export type SessionPane =
  | { readonly kind: "runs"; readonly tmux: TmuxHint | null }
  | {
      readonly kind: "left" | "unconfirmed";
      readonly tmux: TmuxHint | null;
      readonly why: string;
    };

// [LAW:one-source-of-truth] A session runs where its client ran only when the
// process that ran the client is a Claude Code whose own record holds that
// session. Every process in a pane inherits its tmux variables, so a client
// run from Claude Code's shell names the pane too, and so does one run under
// the old session's id after a `/clear`; one run outside tmux under a
// session's id is no sign the session left its pane.
export function sessionPaneOf(
  hints: ClientHints,
  sessionId: string,
  heldSession: HeldSessionOf,
): SessionPane {
  const tmux = inTmux(hints.tmux) ? hints.tmux : null;
  const { parentPid } = hints;
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
      why: `the process that ran its statusline (pid ${parentPid}) is no Claude Code whose session can be read: ${held.why}. A statusline command that runs the client through a shell or a wrapper (a script, \`pnpm dlx\`) hands it that process instead: \`cc-candybar install\` writes one that runs it directly`,
    };
  return held.sessionId === sessionId
    ? { kind: "runs", tmux }
    : {
        kind: "left",
        tmux,
        why: `the Claude Code that ran its statusline (pid ${parentPid}) holds session ${held.sessionId}`,
      };
}

// [LAW:one-source-of-truth] Whether `req`'s session runs in the pane `where`
// now, by its Claude Code's record as it reads at this call: the stamp `req`
// arrived with is the record as it read then, which a `/clear` rewrites under
// the same process, so a lookup of a pane's session never answers from it.
// One lookup reads each record once, so every request it weighs is judged
// against the same read: a pane keeps a request of each session its Claude
// Code held, all of them naming one record.
export function runsNowIn(
  where: Pick<TmuxHint, "socket" | "pane">,
  heldSession: HeldSessionOf,
): (req: {
  readonly hints: ClientHints;
  readonly sessionId: string;
}) => boolean {
  const reads = new Map<string, HeldSession>();
  const once: HeldSessionOf = (pid, configDir) => {
    const key = `${pid}\0${configDir ?? ""}`;
    const read = reads.get(key) ?? heldSession(pid, configDir);
    reads.set(key, read);
    return read;
  };
  return (req) =>
    inTmux(req.hints.tmux) &&
    samePane(req.hints.tmux, where) &&
    sessionPaneOf(req.hints, req.sessionId, once).kind === "runs";
}

// [LAW:nothing-unseen] The stamp as the render event's `pane` field.
export const paneFact = (pane: SessionPane): string =>
  pane.kind !== "runs"
    ? `unconfirmed: ${pane.why}`
    : pane.tmux === null
      ? "outside"
      : "runs";

// [LAW:no-silent-failure] Why a lane that shows the session its pane runs
// shows another bar than this one, while such a lane is on: null otherwise.
// A session its Claude Code has left names nothing to fix, since that Claude
// Code's next tick is the pane's session; its render line still says why.
export function sessionPaneError(
  pane: SessionPane,
  lanes: LaneSwitches,
): string | null {
  const on = LANE_NAMES.filter(
    (lane) => lanes[lane] && LANES[lane].showsPaneSession,
  );
  return pane.kind !== "unconfirmed" || pane.tmux === null || on.length === 0
    ? null
    : `The ${on.map((lane) => LANES[lane].label).join(" and ")} of pane ${pane.tmux.pane} shows the session the pane's Claude Code holds, and this one is not known to be it: ${pane.why}`;
}

// How a doctor run was asked, and what a host saw of the bar it judges: a run
// judges its own session's bar, and the sightings it reads are that session's.

import type {
  FrameSighting,
  RoledSaid,
} from "../daemon/foundations/sightings.js";
import type { Asked, Width } from "./checks.js";

// [LAW:types-are-the-program] Who delivered a link to the daemon: the URL
// handler app, forwarding it raw in a frame of the version it spells, or
// `cc-candybar url-handle`, which splits the verb itself — run by the tmux
// status line's click binding, or by the retired AppleScript applet an old
// install left registered for the scheme.
export type Delivery =
  | { readonly kind: "forwarder"; readonly urlV: number }
  | { readonly kind: "cli" };

// How a click reached the renderer: a link the terminal drew, with who
// delivered it; a range of the tmux status line, which tmux's own binding
// runs — proof that the bar is on screen, and of nothing about links or the
// handler; or `cc-candybar doctor`, the host of a bar of its own, which sends
// its click as the event it is.
export type ClickArrival =
  | { readonly via: "link"; readonly delivery: Delivery }
  | { readonly via: "tmux-status" }
  | { readonly via: "command" };

// One bar a sighting drew, and where the settings that redraw it are read:
// the session's project, and the Claude Code directory it runs with.
export interface SightedBar extends FrameSighting {
  readonly projectDir: string;
  readonly claudeConfigDir: string;
}

// [LAW:single-enforcer] The width one session's statusline client measured,
// read off that session's latest renders. The daemon holds no such render
// when it has drawn the session's statusline none since it started (the bar
// on screen is an earlier daemon's), when it has dropped it for newer
// sessions' renders, or when only a `frames` client draws it.
export function sessionWidth(
  sessionId: string,
  said: ReadonlyArray<Pick<RoledSaid, "role" | "termCols">>,
): Asked<Width> {
  const statusline = said.find((s) => s.role === "statusline");
  return statusline === undefined
    ? {
        kind: "failed",
        reason: `the daemon holds no statusline render of session ${sessionId} — none since it started, or dropped for newer sessions' renders, or only a frames display draws it, which reports no width — so no width a statusline client measured is known; run this again once the statusline has redrawn`,
      }
    : {
        kind: "ok",
        value: {
          columns: statusline.termCols,
          of: { kind: "session", sessionId },
        },
      };
}

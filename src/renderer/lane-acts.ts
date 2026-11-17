// [LAW:single-enforcer] What turning an animation lane on or off asks of the
// host. What a lane runs follows the session's own clicks on its switch,
// whatever control moved it — the menu's toggle, its ↺, ↶ undo, a preset
// picked, a save — so no control carries the setup itself. The click path
// measures the session's switches before the click and after its commit
// (`journaled`, src/renderer/verbs/index.ts), and each lane that differs is
// brought in line once, by the act its table names. A switch moved by
// anything but the session's own click — another session's save, a hand
// edit, a restart, a `cd` — sets nothing up: it changes what every session
// reading that file renders by, and setting a lane up in each would restart
// every idle Claude Code on the machine for one session's save. A setup needs
// the session's pane, from the context the host hands in with the click,
// which it keeps across its own restarts: a click it holds none for never
// reaches here, and says so. The tmux status line asks for no act: the
// renderer declares the sessions whose switch is on in its subscriptions, and
// the host holds their rows (src/daemon/tmux-status.ts).

import type { SessionId } from "../daemon/foundations/session-id.js";
import { LANE_NAMES, type Lane, type LaneSwitches } from "../config/lanes.js";
import type {
  ActRequest,
  Effect,
  LaneSession,
} from "../renderer-interface/interface.js";
import type { SessionContext } from "../renderer-interface/request-context.js";
import { tmuxPaneOf } from "../claude-input/typing.js";
import type { TmuxHint } from "../tmux-hint.js";
// [LAW:types-are-the-program] What bringing a lane to a switch asks: an act,
// nothing (said why), or a refusal the user can act on, shown on the bar.
type Setup =
  | { readonly kind: "act"; readonly act: ActRequest }
  | { readonly kind: "nothing"; readonly said: string }
  | { readonly kind: "refused"; readonly reason: string };

// The session as its newest request reported it.
interface At {
  readonly sessionId: SessionId;
  readonly tmux: SessionContext["hints"]["tmux"];
  readonly session: LaneSession;
}

const atOf = (context: SessionContext): At => ({
  sessionId: context.session,
  tmux: context.hints.tmux,
  session: {
    projectDir: context.requested.projectDir,
    claudeConfigDir: context.hints.claudeConfigDir ?? null,
    transcript: context.transcript,
    answered: context.answered,
  },
});

// A setup that needs the session's pane: refused, saying why, for one with
// none.
function inPane(at: At, act: (pane: TmuxHint) => Setup): Setup {
  const pane = tmuxPaneOf(at.tmux);
  return pane.kind === "refused" ? pane : act(pane.hint);
}

const act = (request: ActRequest): Setup => ({ kind: "act", act: request });
const nothing = (said: string): Setup => ({ kind: "nothing", said });

// [LAW:one-source-of-truth] THE table: every lane's setup, keyed by LANES, so
// a lane added there is a compile error here until it says what turning it on
// and off asks.
const LANE_SETUP: Readonly<
  Record<
    Lane,
    { readonly on: (at: At) => Setup; readonly off: (at: At) => Setup }
  >
> = {
  // The install needs no pane: only its `/reload-plugins` does, which the
  // host refuses with the session's own reason outside tmux.
  band: {
    on: (at) =>
      act({
        kind: "surface",
        surface: "band",
        on: true,
        session: at.sessionId,
        pane: tmuxPaneOf(at.tmux),
        at: at.session,
      }),
    // The installed mod draws nothing while the lane is off: the host
    // refuses its subscriber, and it hands the band on.
    off: () =>
      nothing(
        "nothing to stop: the band mod draws nothing while the lane is off",
      ),
  },
  statusline: {
    on: (at) =>
      inPane(at, (pane) =>
        act({
          kind: "restart-claude",
          session: at.sessionId,
          pane,
          at: at.session,
        }),
      ),
    // Lane off, the attached statusline is refused frames and shows its
    // command's output, as a stock one does.
    off: () =>
      nothing(
        "nothing to stop: the attached statusline draws its command's output while the lane is off",
      ),
  },
  pane: {
    on: (at) =>
      inPane(at, (pane) =>
        act({
          kind: "surface",
          surface: "pane",
          on: true,
          session: at.sessionId,
          pane,
        }),
      ),
    // Off is "no bar pane draws this session's bar", which a session with no
    // tmux pane already is.
    off: (at) => {
      const pane = tmuxPaneOf(at.tmux);
      return pane.kind === "refused"
        ? nothing(`no bar pane to close: ${pane.reason}`)
        : act({
            kind: "surface",
            surface: "pane",
            on: false,
            session: at.sessionId,
            pane: pane.hint,
          });
    },
  },
  tmuxStatus: {
    on: (at) =>
      inPane(at, (pane) =>
        nothing(`the daemon draws ${pane.pane}'s bar in its status line`),
      ),
    off: () =>
      nothing(
        "nothing to stop: the daemon puts the status line back once the lane is off",
      ),
  },
};

export class LaneActs {
  constructor(
    private readonly deps: {
      readonly ask: (effects: Effect[], act: ActRequest) => void;
      // Holds a refused setup's reason on the session's bar.
      readonly refused: (session: SessionId, reason: string) => void;
      readonly log: (level: "info" | "warn", msg: string) => void;
    },
  ) {}

  // [LAW:dataflow-not-control-flow] A click of the session `context` names
  // moved its switches from `before` to `after`: each lane that moved is
  // brought to its switch, and said. What it asks joins `effects`.
  clicked(
    context: SessionContext,
    before: LaneSwitches,
    after: LaneSwitches,
    effects: Effect[],
  ): void {
    const at = atOf(context);
    for (const lane of LANE_NAMES) {
      if (before[lane] === after[lane]) continue;
      const on = after[lane];
      const what = `lane: ${lane} ${on ? "on" : "off"}`;
      const where = `(session=${at.sessionId})`;
      const setup = LANE_SETUP[lane][on ? "on" : "off"](at);
      switch (setup.kind) {
        case "act":
          this.deps.log("info", `${what} — asked ${where}`);
          this.deps.ask(effects, setup.act);
          break;
        case "nothing":
          this.deps.log("info", `${what} — ${setup.said} ${where}`);
          break;
        case "refused":
          this.deps.log("warn", `${what}: ${setup.reason} ${where}`);
          this.deps.refused(at.sessionId, `${what}: ${setup.reason}`);
      }
    }
  }
}

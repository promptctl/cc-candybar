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
// the session's pane, from the latest request the host holds; a click before
// there is one (a toggle on a bar the daemon before a restart drew) owes its
// setups to the session's next click or request, whichever comes first. What
// is owed is settled against the switches as that event finds them, so a lane
// whose switch is back where it stood — toggled back, or moved back by another
// session's save — owes nothing. The tmux status line asks for no act: the
// renderer declares the sessions whose switch is on in its subscriptions, and
// the host holds their rows (src/daemon/tmux-status.ts).

import type { SessionId } from "../daemon/foundations/session-id.js";
import { LANE_NAMES, type Lane, type LaneSwitches } from "../config/lanes.js";
import type {
  ActRequest,
  Effect,
  LaneSession,
} from "../renderer-interface/interface.js";
import type { CheckedRenderRequest } from "../renderer-interface/request-context.js";
import { tmuxPaneOf } from "../claude-input/typing.js";
import { answeredOf } from "../daemon/foundations/sighting-roles.js";
import type { TmuxHint } from "../tmux-hint.js";

// How many sessions' owed setups are kept.
const MAX_SESSIONS_OWED = 1024;

// What started a setup: the session's own click, or its first request after
// a click there was no pane for.
type SetupCause = "click" | "owed";

// The lanes a session's clicks moved and no setup has brought in line yet,
// each by where its switch stood before the first of those clicks: what the
// lane runs, as far as this renderer knows.
type Owed = Map<Lane, boolean>;

// [LAW:types-are-the-program] What bringing a lane to a switch asks: an act,
// nothing (said why), or a refusal the user can act on, shown on the bar.
type Setup =
  | { readonly kind: "act"; readonly act: ActRequest }
  | { readonly kind: "nothing"; readonly said: string }
  | { readonly kind: "refused"; readonly reason: string };

// The session as its latest request reported it.
interface At {
  readonly sessionId: SessionId;
  readonly tmux: CheckedRenderRequest["hints"]["tmux"];
  readonly session: LaneSession;
}

const atOf = (req: CheckedRenderRequest): At => ({
  sessionId: req.hookData.session_id,
  tmux: req.hints.tmux,
  session: {
    projectDir: req.requested.projectDir,
    claudeConfigDir: req.hints.claudeConfigDir ?? null,
    transcript: req.hookData.transcript_path,
    answered: answeredOf(req.hookData),
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
  band: {
    on: (at) =>
      inPane(at, (pane) =>
        act({
          kind: "surface",
          surface: "band",
          on: true,
          session: at.sessionId,
          pane,
          at: at.session,
        }),
      ),
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
  // Each session's owed lanes, least recently owed first.
  private readonly owed = new Map<SessionId, Owed>();

  constructor(
    private readonly deps: {
      readonly ask: (effects: Effect[], act: ActRequest) => void;
      // Holds a refused setup's reason on the session's bar.
      readonly refused: (session: SessionId, reason: string) => void;
      readonly log: (level: "info" | "warn", msg: string) => void;
    },
  ) {}

  // A click of `sessionId` moved its switches from `before` to `after`.
  // `latest` is its newest request the host holds, or null when it holds
  // none yet. What it asks joins `effects`.
  clicked(
    sessionId: SessionId,
    latest: CheckedRenderRequest | null,
    before: LaneSwitches,
    after: LaneSwitches,
    effects: Effect[],
  ): void {
    // [LAW:one-source-of-truth] The click's moves join what the session
    // already owes: a lane owed before keeps where it stood then.
    const moved = LANE_NAMES.filter((lane) => before[lane] !== after[lane]);
    const owed = this.take(sessionId);
    for (const lane of moved) if (!owed.has(lane)) owed.set(lane, before[lane]);
    const byOf = (lane: Lane): SetupCause =>
      moved.includes(lane) ? "click" : "owed";
    if (latest !== null) {
      this.settle(atOf(latest), owed, after, byOf, effects);
      return;
    }
    for (const [lane, from] of owed)
      if (from === after[lane]) owed.delete(lane);
    // [LAW:nothing-unseen] What a click before the session's first request
    // leaves owed is said at the click, so a setup that never runs still has
    // its line.
    if (moved.length > 0) {
      const lanes = [...owed.keys()].map(
        (lane) => `${lane} ${after[lane] ? "on" : "off"}`,
      );
      this.deps.log(
        "info",
        `lane: owed ${lanes.join(",") || "nothing"} (session=${sessionId})`,
      );
    }
    // [LAW:carrying-cost] Bounded like the renderer's other per-session
    // memories: least recently owed dropped first, and said.
    if (owed.size > 0) this.owed.set(sessionId, owed);
    for (const [oldest, lanes] of this.owed) {
      if (this.owed.size <= MAX_SESSIONS_OWED) break;
      this.owed.delete(oldest);
      this.deps.log(
        "warn",
        `lane: owed dropped sid=${JSON.stringify(oldest)} lanes=${[...lanes.keys()].join(",")}`,
      );
    }
  }

  // A request `req` arrived, finding its session's switches at `switches`:
  // the setups its clicks owe are asked now, in its turn's `effects`.
  noted(
    req: CheckedRenderRequest,
    switches: LaneSwitches,
    effects: Effect[],
  ): void {
    const at = atOf(req);
    this.settle(at, this.take(at.sessionId), switches, () => "owed", effects);
  }

  private take(sessionId: SessionId): Owed {
    const owed = this.owed.get(sessionId) ?? new Map<Lane, boolean>();
    this.owed.delete(sessionId);
    return owed;
  }

  // [LAW:dataflow-not-control-flow] Each owed lane is brought to its switch
  // `now`, unless the switch stands where the lane already is, and either
  // way is said, under what started it: this click's move, or one owed from
  // before.
  private settle(
    at: At,
    owed: Owed,
    now: LaneSwitches,
    byOf: (lane: Lane) => SetupCause,
    effects: Effect[],
  ): void {
    for (const [lane, from] of owed) {
      const on = now[lane];
      const what = `lane: ${lane} ${on ? "on" : "off"}`;
      const where = `by=${byOf(lane)} (session=${at.sessionId})`;
      if (on === from) {
        this.deps.log(
          "info",
          `${what} — nothing owed: its switch is back where the lane is ${where}`,
        );
        continue;
      }
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

// [LAW:single-enforcer] What turning an animation lane on or off asks of the
// world, decided here and performed by the host's adapter for each surface
// (src/daemon/lane-setup.ts, src/daemon/tmux-status.ts): the band, the bar pane
// and the tmux row are `surface` effects, and the statusline lane on is
// `restart-claude`, which restarts the session's Claude Code under the attach
// launcher. Off, the statusline lane stops nothing: the attached statusline is
// refused frames and shows its command's output.
//
// A lane follows the session's own clicks on its switch, whatever control
// moved it — the menu's toggle, its ↺, ↶ undo, a preset picked, a save — so no
// control carries the setup itself. The click path measures the session's
// switches before the click and after its commit, and each lane that differs
// is brought in line once. A switch moved by anything but the session's own
// click — another session's save, a hand edit, a restart, a `cd` — sets nothing
// up: it changes what every session reading that file renders by, and setting a
// lane up in each would restart every idle Claude Code on the machine for one
// session's save. A setup needs the session as its newest request reported it,
// which the host holds; a click before the host holds one (a toggle on a bar
// the daemon before a restart drew) owes its setups to the session's next click
// or request, whichever comes first. What is owed is settled against the
// switches as that event finds them, so a lane whose switch is back where it
// stood — toggled back, or moved back by another session's save — owes nothing.
//
// The tmux row is held at every request whose switch is on in tmux, and on or
// off at a click that moved it, never at a draw: the host's hold is idempotent
// and the row's feed ends once its lane is off, so a row another session's
// save turned off is never re-taken from a remembered switch.

import type { SessionId } from "../daemon/foundations/session-id.js";
import { LANE_NAMES, type Lane, type LaneSwitches } from "../config/lanes.js";
import type { Effect } from "../renderer-interface/interface.js";
import type { Acts } from "./acts.js";

// How many sessions' owed lanes are kept.
const MAX_SESSIONS_OWED = 1024;

// What started a setup: the session's own click, or its first request after
// a click the host held no request for.
type SetupCause = "click" | "owed";

// The lanes a session's clicks moved and no setup has brought in line yet,
// each by where its switch stood before the first of those clicks: what the
// lane runs, as far as this renderer knows.
type Owed = Map<Lane, boolean>;

export class LaneSurfaces {
  // Each session's owed lanes, least recently owed first.
  private readonly owed = new Map<SessionId, Owed>();

  constructor(
    private readonly deps: {
      readonly acts: Pick<Acts, "add">;
      readonly log: (level: "info" | "warn", msg: string) => void;
    },
  ) {}

  // A click of `sessionId` moved its switches from `before` to `after`.
  // `held` is whether the host holds a request of the session to set it up by.
  clicked(
    sessionId: SessionId,
    held: boolean,
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
    if (held) {
      this.settle(sessionId, owed, after, byOf, effects);
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

  // A request of `sessionId` arrived, finding its switches at `switches`: the
  // setups its clicks owe go now, and its tmux row is held while its switch is
  // on.
  noted(sessionId: SessionId, switches: LaneSwitches, effects: Effect[]): void {
    const set = this.settle(
      sessionId,
      this.take(sessionId),
      switches,
      () => "owed",
      effects,
    );
    if (switches.tmuxStatus && !set.has("tmuxStatus"))
      this.deps.acts.add(effects, {
        kind: "surface",
        session: sessionId,
        surface: "tmux-status",
        on: true,
      });
  }

  private take(sessionId: SessionId): Owed {
    const owed = this.owed.get(sessionId) ?? new Map<Lane, boolean>();
    this.owed.delete(sessionId);
    return owed;
  }

  // [LAW:dataflow-not-control-flow] Each owed lane is brought to its switch
  // `now`, unless the switch stands where the lane already is, and either
  // way is said, under what started it: this click's move, or one owed from
  // before. Answers the lanes it set up.
  private settle(
    sessionId: SessionId,
    owed: Owed,
    now: LaneSwitches,
    byOf: (lane: Lane) => SetupCause,
    effects: Effect[],
  ): ReadonlySet<Lane> {
    const set = new Set<Lane>();
    for (const [lane, from] of owed) {
      const on = now[lane];
      const where = `by=${byOf(lane)} (session=${sessionId})`;
      if (on === from) {
        this.deps.log(
          "info",
          `lane: ${lane} ${from ? "on" : "off"} — nothing owed: its switch is back where the lane is ${where}`,
        );
        continue;
      }
      this.deps.log("info", `lane: ${lane} ${on ? "on" : "off"} ${where}`);
      SETUP[lane](sessionId, on, (act) => this.deps.acts.add(effects, act));
      set.add(lane);
    }
    return set;
  }
}

// [LAW:one-source-of-truth] THE table: what each lane's switch asks of the
// world, keyed by LANES, so a lane added there is a compile error here until
// it says what turning it on and off takes.
const SETUP: Readonly<
  Record<
    Lane,
    (
      session: SessionId,
      on: boolean,
      act: (act: Parameters<Acts["add"]>[1]) => void,
    ) => void
  >
> = {
  band: (session, on, act) =>
    act({ kind: "surface", session, surface: "band", on }),
  pane: (session, on, act) =>
    act({ kind: "surface", session, surface: "pane", on }),
  tmuxStatus: (session, on, act) =>
    act({ kind: "surface", session, surface: "tmux-status", on }),
  // Off stops nothing: the attached statusline draws its command's output
  // while the lane is off.
  statusline: (session, on, act) => {
    if (on) act({ kind: "restart-claude", session });
  },
};

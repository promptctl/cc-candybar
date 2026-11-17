// [LAW:single-enforcer] The host's one performer of the acts a renderer's
// turns return: what a click or a lane switch asks done in the world. Each
// act is performed by its kind's performer, and how it ended is its outcome:
// what it did, or why it did not, said once on its act line and handed back as
// the act's `effect-done`.

import type { Act, EffectOutcome } from "../renderer-interface/interface.js";
import type { LaunchResult } from "../proc/launcher.js";
import type { TmuxHint } from "../tmux-hint.js";
import type { SlashTyper, TypeResult } from "../claude-input/typing.js";
import type { SlashLine } from "../claude-input/slash-line.js";
import type { SessionId } from "./foundations/session-id.js";
import type { DaemonLogger } from "../utils/logger.js";
import { valueOf } from "../utils/logfmt.js";
import { KeyedSerialQueue } from "../utils/keyed-serial-queue.js";
import { clickLaunch, type ClickLaunch } from "./foundations/click-launch.js";
import { failureOf } from "./foundations/verb-error.js";
import {
  bandOn,
  paneOff,
  paneOn,
  restartClaude,
  type LaneEdge,
  type LaneHost,
} from "./lane-setup.js";
import type { RunAct, RunEnd } from "./runs.js";

// An act the landing performs with the config files, not here.
type Landed = "approve-repo";
export type HostAct = Exclude<Act, { kind: Landed }>;
type Of<K extends HostAct["kind"]> = Extract<HostAct, { kind: K }>;

export interface ActDeps {
  readonly launch: (launch: ClickLaunch) => Promise<LaunchResult>;
  // A slash line typed into a pane, once the prompt there reads ready.
  readonly type: SlashTyper;
  readonly run: (run: RunAct) => Promise<RunEnd>;
  // The update notice's act: what it applies is the update watch's.
  readonly applyUpdate: () => Promise<void>;
  readonly lanes: { readonly edge: LaneEdge; readonly host: LaneHost };
  // Whether the daemon's close has begun: no act starts after it.
  readonly closing: () => boolean;
  // The pane the newest request of `session` since this daemon started
  // reported, or null when none has.
  readonly paneHeard: (session: SessionId) => TmuxHint | null;
  readonly log: DaemonLogger;
}

// [LAW:types-are-the-program] Which acts outlive the turn that asked for
// them: a run, and a lane's setup, whose outcome lands once it has finished.
// The rest are over before their turn returns, so a click answers with how
// they went.
const OUTLIVES: Readonly<Record<HostAct["kind"], boolean>> = {
  copy: false,
  open: false,
  "type-slash": false,
  "apply-update": false,
  run: true,
  "restart-claude": true,
  surface: true,
};

export const outlives = (act: HostAct): boolean => OUTLIVES[act.kind];

// How an act's line and its reason name it.
function nameOf(act: HostAct): string {
  switch (act.kind) {
    case "copy":
    case "open":
    case "apply-update":
      return act.kind;
    case "type-slash":
      return act.line;
    case "run":
      return `run ${act.action}`;
    case "restart-claude":
      return "lane: statusline on";
    case "surface":
      return `lane: ${act.surface} ${act.on ? "on" : "off"}`;
  }
}

const paneKey = (pane: TmuxHint): string => `${pane.socket}\0${pane.pane}`;

// The pane an act types into or splits under, with the session it acts for,
// or null for one that acts in none.
function paneOf(
  act: HostAct,
): { readonly session: SessionId; readonly pane: TmuxHint } | null {
  switch (act.kind) {
    case "type-slash":
    case "restart-claude":
      return act;
    case "surface":
      if (act.surface === "pane") return act;
      return act.pane.kind === "pane"
        ? { session: act.session, pane: act.pane.hint }
        : null;
    case "copy":
    case "open":
    case "apply-update":
    case "run":
      return null;
  }
}

// [LAW:types-are-the-program] How an act ended: its outcome, and what its
// line says of it — what it did, or why it did not.
type Done = RunEnd;
const did = (said: string): Done => ({ outcome: { kind: "ok" }, said });
const not = (outcome: Exclude<EffectOutcome, { kind: "ok" }>): Done => ({
  outcome,
  said: outcome.reason,
});

export class Acts {
  // [LAW:no-ambient-temporal-coupling] Whatever acts in a pane, one at a
  // time, in the order asked: a slash line, the band's /reload-plugins, a
  // restart, a bar pane split under it. Each reads the pane before it types,
  // so two at once would both find the bare input box and type into each
  // other.
  private readonly inPane = new KeyedSerialQueue<string>();
  // [LAW:no-ambient-temporal-coupling] A session's lane setups, one at a
  // time, in the order asked: a band install ends, its /reload-plugins
  // typed, before a restart the same click asked exits Claude Code, and two
  // installs never run `claude plugin` over one config at once.
  private readonly setups = new KeyedSerialQueue<SessionId>();
  // The sessions a restart holds now, by how many are queued or running on
  // each: their Claude Code is about to exit.
  private readonly restarting = new Map<SessionId, number>();
  private readonly performers: {
    readonly [K in HostAct["kind"]]: (act: Of<K>) => Promise<Done>;
  };

  constructor(private readonly deps: ActDeps) {
    const { lanes } = deps;
    this.performers = {
      copy: (act) =>
        clickLaunch(
          deps.launch,
          {
            bin: "/usr/bin/pbcopy",
            stdinInput: act.text,
            category: "click.pbcopy",
          },
          "pbcopy",
          "copied",
        ),
      open: (act) =>
        clickLaunch(
          deps.launch,
          {
            bin: "/usr/bin/open",
            args: ["-a", "Visual Studio Code", act.target],
            category: "click.open",
          },
          'open -a "Visual Studio Code"',
          `opened ${act.target}`,
        ),
      // [LAW:no-ambient-temporal-coupling] A session a restart holds is
      // about to exit its Claude Code: a line typed now would land in the
      // shell the restart leaves, so it is refused at once, saying why.
      "type-slash": async (act) => {
        if (this.restarting.has(act.session))
          return not({
            kind: "refused",
            reason: `a restart holds pane ${act.pane.pane} — click again once it has finished`,
          });
        const typed = await this.typed(act.pane, act.line);
        return typed.kind === "typed"
          ? did(`typed into ${typed.pane}`)
          : not({ kind: "refused", reason: typed.reason });
      },
      run: (act) => deps.run(act),
      "apply-update": async () => {
        await deps.applyUpdate();
        return did("applied");
      },
      "restart-claude": (act) =>
        this.restart(act.session, act.pane, () =>
          restartClaude(
            { ...act.at, sessionId: act.session },
            act.pane,
            lanes.host,
            lanes.edge,
          ),
        ),
      surface: async (act) => {
        switch (act.surface) {
          // The install acts in no pane: only its /reload-plugins is typed,
          // in turn with whatever else acts in the pane.
          case "band":
            return did(
              await this.setups.run(act.session, () =>
                bandOn(
                  { ...act.at, sessionId: act.session },
                  act.pane,
                  (pane, line) => this.typed(pane, line),
                  lanes.host,
                  lanes.edge,
                ),
              ),
            );
          case "pane":
            return did(
              await this.setups.run(act.session, () =>
                this.inPane.run(paneKey(act.pane), () =>
                  act.on
                    ? paneOn(act.pane, lanes.host, lanes.edge)
                    : paneOff(act.pane, lanes.edge),
                ),
              ),
            );
        }
      },
    };
  }

  // A slash line typed into `pane` in its turn.
  private typed(pane: TmuxHint, line: SlashLine): Promise<TypeResult> {
    return this.inPane.run(paneKey(pane), () => this.deps.type(pane, line));
  }

  // [LAW:dataflow-not-control-flow] One act, by its kind's performer. A
  // throw is classified once, here: a refusal the user can act on, the
  // daemon's close, or a failure.
  async perform(act: HostAct): Promise<EffectOutcome> {
    const { outcome, said } = this.deps.closing()
      ? not({ kind: "closing", reason: "the daemon is closing" })
      : await this.performed(act);
    this.deps.log(
      outcome.kind === "ok" || outcome.kind === "closing" ? "info" : "warn",
      `act kind=${act.kind} sid=${valueOf(act.session ?? "-")} id=${act.id} outcome=${outcome.kind} — ${nameOf(act)}: ${said}`,
    );
    return outcome.kind === "ok"
      ? outcome
      : { ...outcome, reason: `${nameOf(act)}: ${outcome.reason}` };
  }

  private async performed(act: HostAct): Promise<Done> {
    // [LAW:single-enforcer] A pane is acted in only as a request since this
    // daemon started reported it for the act's session. A context read back
    // from before names a pane id tmux may since have given another program
    // (a bar clicked in scrollback a terminal restored after a reboot).
    const inPane = paneOf(act);
    if (inPane !== null) {
      const heard = this.deps.paneHeard(inPane.session);
      if (heard === null || paneKey(heard) !== paneKey(inPane.pane))
        return not({
          kind: "refused",
          reason: `pane ${inPane.pane.pane} is not one this session's requests since the daemon started have reported — click again once its bar has redrawn`,
        });
    }
    try {
      // [LAW:types-are-the-program] exception: the table is keyed by kind,
      // which the compiler cannot carry from the act to its performer.
      return await (
        this.performers[act.kind] as (act: HostAct) => Promise<Done>
      )(act);
    } catch (thrown) {
      const failure = failureOf(thrown);
      switch (failure.kind) {
        case "bad-request":
          return not({ kind: "refused", reason: failure.message });
        case "closing":
          return not({ kind: "closing", reason: failure.message });
        default:
          return not({ kind: "failed", reason: failure.message });
      }
    }
  }

  // A restart in `pane`'s turn, holding `session` from now until it has
  // finished.
  private async restart(
    session: SessionId,
    pane: TmuxHint,
    restart: () => Promise<string>,
  ): Promise<Done> {
    this.restarting.set(session, (this.restarting.get(session) ?? 0) + 1);
    try {
      return did(
        await this.setups.run(session, () =>
          this.inPane.run(paneKey(pane), restart),
        ),
      );
    } finally {
      const left = this.restarting.get(session)! - 1;
      if (left === 0) this.restarting.delete(session);
      else this.restarting.set(session, left);
    }
  }
}

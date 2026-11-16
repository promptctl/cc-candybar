// [LAW:single-enforcer] The host's one performer of the acts a renderer's
// turns return: what a click or a lane switch asks done in the world. Each
// act is performed by its kind's performer, and how it ended is its outcome:
// what it did, or why it did not, said once on its act line and handed back as
// the act's `effect-done`.

import type { Act, EffectOutcome } from "../renderer-interface/interface.js";
import type { LaunchResult } from "../proc/launcher.js";
import type { TmuxHint } from "../tmux-hint.js";
import type { TypeResult } from "../claude-input/typing.js";
import type { SlashLine } from "../claude-input/slash-line.js";
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
import type { RunAct } from "./runs.js";

// An act the landing performs with the config files, not here.
type Landed = "approve-repo";
export type HostAct = Exclude<Act, { kind: Landed }>;
type Of<K extends HostAct["kind"]> = Extract<HostAct, { kind: K }>;

export interface ActDeps {
  readonly launch: (launch: ClickLaunch) => Promise<LaunchResult>;
  // A slash line typed into a pane, once the prompt there reads ready.
  readonly type: (pane: TmuxHint, line: SlashLine) => Promise<TypeResult>;
  readonly run: (run: RunAct) => Promise<EffectOutcome>;
  // The update notice's act: what it applies is the update watch's.
  readonly applyUpdate: () => Promise<void>;
  readonly lanes: { readonly edge: LaneEdge; readonly host: LaneHost };
  // Whether the daemon's close has begun: no act starts after it.
  readonly closing: () => boolean;
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

// What an act did, said, or how it ended.
type Done = string | EffectOutcome;

export class Acts {
  // [LAW:no-ambient-temporal-coupling] Each pane's setups, one at a time:
  // two restarts of one pane would type over each other.
  private readonly setups = new KeyedSerialQueue<string>();
  // The panes a setup holds now, by how many are queued or running on each.
  private readonly held = new Map<string, number>();
  private readonly performers: {
    readonly [K in HostAct["kind"]]: (act: Of<K>) => Promise<Done>;
  };

  constructor(private readonly deps: ActDeps) {
    const { lanes } = deps;
    this.performers = {
      copy: async (act) => {
        await clickLaunch(
          deps.launch,
          {
            bin: "/usr/bin/pbcopy",
            stdinInput: act.text,
            category: "click.pbcopy",
          },
          "pbcopy",
          deps.log,
        );
        return "copied";
      },
      open: async (act) => {
        await clickLaunch(
          deps.launch,
          {
            bin: "/usr/bin/open",
            args: ["-a", "Visual Studio Code", act.target],
            category: "click.open",
          },
          'open -a "Visual Studio Code"',
          deps.log,
        );
        return `opened ${act.target}`;
      },
      // [LAW:no-ambient-temporal-coupling] A pane a setup holds is about to
      // be restarted or typed into: a line typed now would land in whatever
      // the setup leaves there, so it is refused at once, saying why.
      "type-slash": async (act) => {
        if (this.held.has(paneKey(act.pane)))
          return {
            kind: "refused",
            reason: `a lane setup holds pane ${act.pane.pane} — click again once it has finished`,
          };
        const typed = await deps.type(act.pane, act.line);
        return typed.kind === "typed"
          ? `typed into ${typed.pane}`
          : { kind: "refused", reason: typed.reason };
      },
      run: (act) => deps.run(act),
      "apply-update": async () => {
        await deps.applyUpdate();
        return "applied";
      },
      "restart-claude": (act) =>
        this.holding(act.pane, () =>
          restartClaude(
            { ...act.at, sessionId: act.session },
            act.pane,
            lanes.host,
            lanes.edge,
          ),
        ),
      surface: (act) =>
        this.holding(act.pane, () => {
          switch (act.surface) {
            case "band":
              return bandOn(
                { ...act.at, sessionId: act.session },
                act.pane,
                lanes.host,
                lanes.edge,
              );
            case "pane":
              return act.on
                ? paneOn(act.pane, lanes.host, lanes.edge)
                : paneOff(act.pane, lanes.edge);
          }
        }),
    };
  }

  // [LAW:dataflow-not-control-flow] One act, by its kind's performer. A
  // throw is classified once, here: a refusal the user can act on, the
  // daemon's close, or a failure.
  async perform(act: HostAct): Promise<EffectOutcome> {
    const done: Done = this.deps.closing()
      ? { kind: "closing", reason: "the daemon is closing" }
      : await this.performed(act);
    const outcome: EffectOutcome =
      typeof done === "string"
        ? { kind: "ok" }
        : done.kind === "ok"
          ? done
          : { ...done, reason: `${nameOf(act)}: ${done.reason}` };
    this.deps.log(
      outcome.kind === "ok" || outcome.kind === "closing" ? "info" : "warn",
      `act kind=${act.kind} sid=${valueOf(act.session ?? "-")} id=${act.id} outcome=${outcome.kind} — ${
        typeof done === "string"
          ? `${nameOf(act)}: ${done}`
          : outcome.kind === "ok"
            ? nameOf(act)
            : outcome.reason
      }`,
    );
    return outcome;
  }

  private async performed(act: HostAct): Promise<Done> {
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
          return { kind: "refused", reason: failure.message };
        case "closing":
          return { kind: "closing", reason: failure.message };
        default:
          return { kind: "failed", reason: failure.message };
      }
    }
  }

  // A setup in `pane`'s queue, holding the pane from now until it has
  // finished.
  private holding(
    pane: TmuxHint,
    setup: () => Promise<string>,
  ): Promise<string> {
    const key = paneKey(pane);
    this.held.set(key, (this.held.get(key) ?? 0) + 1);
    return this.setups.run(key, setup).finally(() => {
      const left = this.held.get(key)! - 1;
      if (left === 0) this.held.delete(key);
      else this.held.set(key, left);
    });
  }
}

// [LAW:single-enforcer] The host's one performer of the acts a renderer's
// turns return: what a click or a lane switch asks done in the world. Each
// act is performed by its kind's performer, and how it ended is its outcome:
// what it did, or why it did not, said once on its act line and handed back as
// the act's `effect-done`.

import type { Act, EffectOutcome } from "../renderer-interface/interface.js";
import type { LaunchResult } from "../proc/launcher.js";
import type { TmuxHint } from "../tmux-hint.js";
import {
  typeInPane,
  type ClaudeInputEdge,
  type TypeResult,
} from "../claude-input/typing.js";
import type { SlashLine } from "../claude-input/slash-line.js";
import type { DaemonLogger } from "../utils/logger.js";
import { valueOf } from "../utils/logfmt.js";
import { KeyedSerialQueue } from "../utils/keyed-serial-queue.js";
import { clickLaunch, type ClickLaunch } from "./foundations/click-launch.js";
import { failureOf } from "./foundations/verb-error.js";
import {
  paneOff,
  paneOn,
  type BarPaneEdge,
  type BarPaneHost,
} from "./lane-setup.js";
import type { RunAct, RunEnd } from "./runs.js";

// An act the landing performs with the config files, not here.
type Landed = "approve-repo";
export type HostAct = Exclude<Act, { kind: Landed }>;
type Of<K extends HostAct["kind"]> = Extract<HostAct, { kind: K }>;

export interface ActDeps {
  readonly launch: (launch: ClickLaunch) => Promise<LaunchResult>;
  // [LAW:one-source-of-truth] The daemon's one edge onto Claude Code's
  // prompt: every read of it and every slash line typed into it go through
  // this edge.
  readonly claudeInput: ClaudeInputEdge;
  readonly run: (run: RunAct) => Promise<RunEnd>;
  readonly barPane: { readonly edge: BarPaneEdge; readonly host: BarPaneHost };
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
  run: true,
};

export const outlives = (act: HostAct): boolean => OUTLIVES[act.kind];

// How an act's line and its reason name it.
function nameOf(act: HostAct): string {
  switch (act.kind) {
    case "copy":
    case "open":
      return act.kind;
    case "type-slash":
      return act.line;
    case "run":
      return `run ${act.action}`;
  }
}

export const paneKey = (pane: TmuxHint): string =>
  `${pane.socket}\0${pane.pane}`;

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
  // time, in the order asked: a slash line or a bar pane change.
  private readonly inPane = new KeyedSerialQueue<string>();
  private readonly performers: {
    readonly [K in HostAct["kind"]]: (act: Of<K>) => Promise<Done>;
  };

  constructor(private readonly deps: ActDeps) {
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
      "type-slash": async (act) => {
        const typed = await this.typed(act.pane, act.line);
        return typed.kind === "typed"
          ? did(`typed into ${typed.pane}`)
          : not({ kind: "refused", reason: typed.reason });
      },
      run: (act) => deps.run(act),
    };
  }

  // [LAW:single-enforcer] A bar-pane split and input typing share the pane's
  // queue regardless of what changed the display setting.
  setBarPane(pane: TmuxHint, on: boolean): Promise<string> {
    const { edge, host } = this.deps.barPane;
    return this.inPane.run(paneKey(pane), async () => {
      if (this.deps.closing()) return "daemon closing";
      return on ? paneOn(pane, host, edge) : paneOff(pane, edge);
    });
  }

  // A slash line typed into `pane` in its turn.
  private typed(pane: TmuxHint, line: SlashLine): Promise<TypeResult> {
    // [LAW:single-enforcer] The one way a line is typed: in the pane's turn,
    // once the prompt there reads ready.
    return this.inPane.run(paneKey(pane), () =>
      typeInPane(this.deps.claudeInput)(pane, line),
    );
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
}

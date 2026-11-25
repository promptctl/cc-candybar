// [LAW:single-enforcer] The host's one performer of the acts a renderer's
// turns return: what a click or a lane switch asks done in the world. Each
// act is performed by its kind's performer, and how it ended is its outcome:
// what it did, or why it did not, said once on its act line and handed back as
// the act's `effect-done`.

import type { Act, EffectOutcome } from "../renderer-interface/interface.js";
import type { LaunchResult } from "../proc/launcher.js";
import { paneKey, type TmuxHint } from "../tmux-hint.js";
import {
  typeInPane,
  type ClaudeInputEdge,
  type TypeResult,
} from "../claude-input/typing.js";
import type { SessionId } from "./foundations/session-id.js";
import type { DesktopAct } from "./foundations/protocol.js";
import type { DaemonLogger } from "../utils/logger.js";
import { valueOf } from "../utils/logfmt.js";
import { KeyedSerialQueue } from "../utils/keyed-serial-queue.js";
import { clickLaunch, type ClickLaunch } from "./foundations/click-launch.js";
import { DaemonClosing, failureOf } from "./foundations/verb-error.js";
import {
  paneOff,
  paneOn,
  type BarPaneEdge,
  type BarPaneHost,
} from "./lane-setup.js";
import type { RunAct, RunEnd } from "./runs.js";
import type { Timekeeper } from "../time.js";

// An act the landing performs with the config files, not here.
export type HostAct = Exclude<Act, { kind: "approve-repo" | "run" }> | RunAct;
type Of<K extends HostAct["kind"]> = Extract<HostAct, { kind: K }>;

export interface ActPrograms {
  readonly launch: (launch: ClickLaunch) => Promise<LaunchResult>;
  // Reading the prompt and typing into it must use the same tmux session.
  readonly claudeInput: ClaudeInputEdge;
}

export interface ActDeps {
  // Runs each pane's queue of acts as a clock task of its own.
  readonly detach: Timekeeper["detach"];
  // [LAW:effects-at-boundaries] The host selects the launch environment for
  // the session that drew this click. Both tmux operations share the selection.
  readonly programsFor: (session: SessionId | null) => ActPrograms;
  readonly run: (run: RunAct) => Promise<RunEnd>;
  readonly barPane: { readonly edge: BarPaneEdge; readonly host: BarPaneHost };
  // Whether the daemon's close has begun: no act starts after it.
  readonly closing: () => boolean;
  readonly log: DaemonLogger;
}

// [LAW:types-are-the-program] How an act ended as the host holds it: what its
// renderer is told, or that the act was left to the machine its click's writer
// runs on, which is the act itself, to be handed to that writer. Its renderer
// is told `ok`: the daemon's part is done.
export interface Left {
  readonly kind: "left";
  readonly act: DesktopAct;
}
export type HostOutcome = EffectOutcome | Left;

// The acts a click may leave to the machine its writer runs on, as the wire
// spells them; every other act is only ever performed here.
export function desktopActOf(act: HostAct): DesktopAct | null {
  switch (act.kind) {
    case "copy":
      return { kind: "copy", text: act.text };
    case "open":
      return { kind: "open", target: act.target };
    case "type-slash":
    case "run":
      return null;
  }
}

// Runs can continue after the click reply. Other acts report their outcome
// as part of that reply.
export const outlives = (act: HostAct): act is Of<"run"> => act.kind === "run";

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

// [LAW:single-enforcer] An act's line, in the one format, whoever says it:
// what it did or why it did not, or that it was left to the writer's machine.
export const actLine = (
  act: HostAct,
  outcome: HostOutcome["kind"],
  said: string,
): string =>
  `act kind=${act.kind} sid=${valueOf(act.session ?? "-")} id=${act.id} outcome=${outcome} — ${nameOf(act)}: ${said}`;

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
  private readonly inPane: KeyedSerialQueue<string>;
  private readonly performers: {
    readonly [K in HostAct["kind"]]: (act: Of<K>) => Promise<Done>;
  };

  constructor(private readonly deps: ActDeps) {
    this.inPane = new KeyedSerialQueue(
      deps.detach,
      (pane) => `acts in ${pane}`,
    );
    this.performers = {
      copy: (act) =>
        clickLaunch(
          deps.programsFor(act.session).launch,
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
          deps.programsFor(act.session).launch,
          {
            bin: "/usr/bin/open",
            args: ["-a", "Visual Studio Code", act.target],
            category: "click.open",
          },
          'open -a "Visual Studio Code"',
          `opened ${act.target}`,
        ),
      "type-slash": async (act) => {
        const typed = await this.typed(act);
        return typed.kind === "typed"
          ? did(`typed into ${typed.pane}`)
          : not({ kind: "refused", reason: typed.reason });
      },
      run: (act) => deps.run(act),
    };
  }

  // [LAW:single-enforcer] A bar-pane split and input typing share the
  // pane's queue. Admission happens when the act reaches the head.
  private inPaneTurn<Result>(
    pane: TmuxHint,
    act: () => Promise<Result>,
  ): Promise<Result> {
    return this.inPane.run(paneKey(pane), () => {
      if (this.deps.closing()) throw new DaemonClosing("pane act");
      return act();
    });
  }

  setBarPane(pane: TmuxHint, on: boolean): Promise<string> {
    const { edge, host } = this.deps.barPane;
    return this.inPaneTurn(pane, () =>
      on ? paneOn(pane, host, edge) : paneOff(pane, edge),
    );
  }

  private typed(act: Of<"type-slash">): Promise<TypeResult> {
    return this.inPaneTurn(act.pane, () =>
      typeInPane(this.deps.programsFor(act.session).claudeInput)(
        act.pane,
        act.line,
      ),
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
      actLine(act, outcome.kind, said),
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

import {
  clockOver,
  type ReportThrow,
  type Timekeeper,
  type TimerSource,
} from "../time.js";
import { failureOf } from "./foundations/verb-error.js";
import { recurrence } from "../utils/event-hold.js";

// A throw as the clock reported it: the task's name, what it threw, and the
// wall reading when it was caught.
export interface ReportedThrow {
  readonly task: string;
  readonly thrown: unknown;
  readonly at: number;
}

export type TakeThrow = (reported: ReportedThrow) => void;

// [LAW:single-enforcer] What a task's throw says, `more` times since its
// error was last shown: its words for a bar, and its detail for the log.
export function thrownText(
  reported: ReportedThrow,
  more = 0,
): { readonly shown: string; readonly logged: string } {
  const failure = failureOf(reported.thrown);
  const threw = `${reported.task} threw${recurrence(more)}`;
  return {
    shown: `${threw}: ${failure.message}`,
    logged: `${threw}: ${failure.detail}`,
  };
}

// [LAW:types-are-the-program] Who takes the process's throws, as a state:
// none yet, so they wait; the daemon, once it is built; and a log alone once
// no daemon can show them, its close or a refused boot.
type Taking =
  | { readonly kind: "waiting"; readonly waiting: ReportedThrow[] }
  | { readonly kind: "taken" | "closed"; readonly take: TakeThrow };

// [LAW:no-ambient-temporal-coupling] What the daemon process's tasks threw,
// kept until its taker attaches, so a throw before the daemon exists (boot,
// the launcher) still reaches every bar, then handed to that taker as each
// comes. The inbox is as total as its taker: the daemon's takes every throw
// without throwing.
export class TaskThrowInbox {
  private taking: Taking = { kind: "waiting", waiting: [] };

  readonly report: ReportThrow = (task, thrown, at) => {
    const reported = { task, thrown, at };
    if (this.taking.kind === "waiting") this.taking.waiting.push(reported);
    else this.taking.take(reported);
  };

  // [LAW:single-enforcer] The daemon takes every throw, those waiting first,
  // oldest first; one reported while they are taken waits behind them.
  attach(take: TakeThrow): void {
    if (this.taking.kind !== "waiting")
      throw new Error(`a throw inbox is already ${this.taking.kind}`);
    this.handOver({ kind: "taken", take });
  }

  // From here on a log takes them: whatever is waiting, then each as it comes.
  close(take: TakeThrow): void {
    this.handOver({ kind: "closed", take });
  }

  private handOver(to: Extract<Taking, { take: TakeThrow }>): void {
    const { taking } = this;
    if (taking.kind === "waiting")
      for (
        let reported = taking.waiting.shift();
        reported !== undefined;
        reported = taking.waiting.shift()
      )
        to.take(reported);
    this.taking = to;
  }
}

// [LAW:one-source-of-truth] A clock with the inbox its tasks' throws land in,
// built as one value, so whoever drains the inbox holds the clock that fills
// it and the two cannot be handed over apart.
export interface ReportingClock extends Timekeeper {
  readonly throws: TaskThrowInbox;
}

export function reportingClock(source: TimerSource): ReportingClock {
  const throws = new TaskThrowInbox();
  return { ...clockOver(source, throws.report), throws };
}

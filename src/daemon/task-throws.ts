import {
  clockOver,
  type ReportThrow,
  type Timekeeper,
  type TimerSource,
} from "../time.js";

// A throw as the clock reported it: the task's name, what it threw, and the
// wall reading when it was caught.
export interface ReportedThrow {
  readonly task: string;
  readonly thrown: unknown;
  readonly at: number;
}

// [LAW:no-ambient-temporal-coupling] What the daemon process's tasks threw,
// kept until its one taker attaches, so a throw before the daemon exists
// (boot, the launcher) still reaches every bar, then handed to that taker as
// each comes. It needs no clock, so it cannot throw into the task it reports
// on its own account.
export class TaskThrowInbox {
  private readonly waiting: ReportedThrow[] = [];
  private take: (reported: ReportedThrow) => void = (reported) =>
    this.waiting.push(reported);

  readonly report: ReportThrow = (task, thrown, at) =>
    this.take({ task, thrown, at });

  // [LAW:single-enforcer] The one taker: every throw waiting, oldest first,
  // then each as it is reported, the daemon's close notwithstanding.
  // One reported while the waiting are taken waits behind them.
  attach(take: (reported: ReportedThrow) => void): void {
    for (
      let reported = this.waiting.shift();
      reported !== undefined;
      reported = this.waiting.shift()
    )
      take(reported);
    this.take = take;
  }

  // What no taker took: a boot refused before the daemon attached.
  untaken(): readonly ReportedThrow[] {
    return this.waiting.splice(0);
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

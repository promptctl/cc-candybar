import { observable, runInAction } from "mobx";
import type { ReportThrow } from "../time.js";

// A throw as the clock reported it: the task's name, what it threw, and the
// wall reading when it was caught.
export interface TaskThrow {
  readonly task: string;
  readonly thrown: unknown;
  readonly at: number;
}

// [LAW:no-ambient-temporal-coupling] The daemon process's reporter, built
// before its world: what the clock's tasks threw, kept until the daemon takes
// it, so a throw before the daemon exists (boot, the launcher) still reaches
// every bar. It needs no clock, and `report` only records, so it cannot throw
// into the task it reports.
export class TaskThrowInbox {
  private readonly waiting = observable.array<TaskThrow>([], { deep: false });

  readonly report: ReportThrow = (task, thrown, at) => {
    runInAction(() => this.waiting.push({ task, thrown, at }));
  };

  // How many wait: what the daemon observes to take them as they come.
  waitingCount(): number {
    return this.waiting.length;
  }

  // Every waiting throw, oldest first, and none left waiting.
  take(): readonly TaskThrow[] {
    return runInAction(() => this.waiting.splice(0));
  }
}

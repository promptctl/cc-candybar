// The daemon's work that keeps failing: a fault each source raises when it
// throws and clears when it next succeeds or is let go.

import { observable, runInAction } from "mobx";
import type { DaemonLogger } from "../../utils/logger.js";
import { eventLine, type Field } from "../../utils/logfmt.js";
import { failureOf } from "./verb-error.js";

// [LAW:types-are-the-program] Work retried on every batch, delivery or period,
// and the subject that names which of its sources failed. A throw from it
// fails again on the next retry, so it is a fault that lasts, not an event.
export interface FaultSource {
  readonly work: "watch delivery" | "config discovery" | "git refresh";
  readonly subject: readonly Field[];
}

// What every bar shows while a source's fault stands. `about` is the source,
// so a viewer stays on its fault while others come and go.
export interface DaemonFault {
  readonly kind: "daemon-fault";
  readonly about: string;
  readonly message: string;
}

const aboutOf = (source: FaultSource): string =>
  eventLine(source.work, source.subject);

// [LAW:one-source-of-truth] The daemon's one store of lasting faults. Every
// bar draws from it, and it alone writes their log records.
export class StandingFaults {
  private readonly standing = observable.map<string, DaemonFault>(undefined, {
    deep: false,
  });

  constructor(private readonly log: DaemonLogger) {}

  // [LAW:no-silent-failure] A fault is logged as it starts and as its reason
  // changes, with the detail the bar leaves out. The same reason again is
  // the fault already standing.
  raise(source: FaultSource, thrown: unknown): void {
    const about = aboutOf(source);
    const failure = failureOf(thrown);
    const message = eventLine(`${source.work} threw`, [
      ...source.subject,
      ["failed", failure.message],
    ]);
    if (this.standing.get(about)?.message === message) return;
    this.log("warn", eventLine(message, [["detail", failure.detail]]));
    runInAction(() =>
      this.standing.set(about, { kind: "daemon-fault", about, message }),
    );
  }

  // Each success clears its source, so a source with no fault costs a lookup.
  clear(source: FaultSource, why: "recovered" | "let go"): void {
    const about = aboutOf(source);
    if (!this.standing.has(about)) return;
    this.log("info", eventLine(`${source.work} ${why}`, source.subject));
    runInAction(() => this.standing.delete(about));
  }

  list(): readonly DaemonFault[] {
    return [...this.standing.values()];
  }
}

import type { Instant } from "../utils/instant.js";
import {
  DAEMON_EVENT_HOLD_S,
  eventHoldAt,
  joinedEvent,
  sameNotice,
  type Notice,
} from "../utils/event-hold.js";
import type { DiagnosticLevel } from "../render/diagnostics.js";
import type { LogLevel } from "../utils/logger.js";
import {
  environmentOutput,
  isEnvironmentOutput,
} from "./environment-output.js";

// What a part of the daemon tells every bar: its level, what it is about, and
// what happened. Text derived from a session's environment says so, for
// recording privacy.
export interface Notification {
  readonly level: DiagnosticLevel;
  readonly about: string;
  readonly text: string;
  readonly fromEnvironment: boolean;
}

// [LAW:dataflow-not-control-flow] The level at which every bar hears a line
// the daemon logs, as a value: an error, which nothing else shows. A warning
// or an info line is the operator's; what a bar needs of a warning it is told
// by the part that met it, as a notice or a standing fact.
export const BAR_LEVELS: Readonly<
  Record<LogLevel, readonly DiagnosticLevel[]>
> = { error: ["error"], warn: [], info: [] };

// [LAW:single-enforcer] The daemon's one channel to every bar: each notice
// it holds, by what it is about. A notification about something an unanswered
// notice is about joins it (`joinedEvent`); one after an answer starts afresh.
// A notice an answer carried is retired once its hold is over, so the list
// holds only what some render could still show. A line the unanswered notice
// already says moves nothing, so a failure that repeats until someone looks
// redraws no bar per repeat.
export class Notices {
  private held: readonly Notice[] = [];

  constructor(private readonly now: () => Instant) {}

  // Whether the notices moved.
  notify({ level, about, text, fromEnvironment }: Notification): boolean {
    const at = this.now();
    const last = this.held.find((notice) => notice.about === about) ?? null;
    const unanswered = last?.answered === false ? last : null;
    if (unanswered !== null && `\n${unanswered.text}\n`.includes(`\n${text}\n`))
      return false;
    const joined = environmentOutput(
      { ...joinedEvent(last, text, at), level, about },
      fromEnvironment ||
        (unanswered !== null && isEnvironmentOutput(unanswered)),
    );
    this.held = [
      ...this.held.filter(
        (notice) =>
          notice.about !== about &&
          eventHoldAt(notice, DAEMON_EVENT_HOLD_S, at, "request") !== "over",
      ),
      joined,
    ];
    return true;
  }

  // [LAW:single-enforcer] The one write after a frame carried notices to its
  // client: each it showed, unless a newer one about the same thing has
  // replaced it since. Whether anything moved.
  answered(shown: readonly Notice[]): boolean {
    let moved = false;
    this.held = this.held.map((notice) => {
      if (notice.answered || !shown.some((each) => sameNotice(notice, each)))
        return notice;
      moved = true;
      return { ...notice, answered: true };
    });
    return moved;
  }

  list(): readonly Notice[] {
    return this.held;
  }
}

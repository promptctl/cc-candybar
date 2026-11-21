import type { Timekeeper } from "../time.js";
import {
  answeredBy,
  DAEMON_EVENT_HOLD_S,
  eventHoldAt,
  type EventHold,
  type HeldEvent,
} from "../utils/event-hold.js";
import { instantAt } from "../utils/instant.js";

// What recurred while an event was held: how many times, and the latest.
export interface Recurred<R> {
  readonly count: number;
  readonly latest: R;
}

// The event a slot holds, the end armed for it, and what recurred since.
interface Held<R> {
  event: HeldEvent;
  cancelEnd: () => void;
  recurred: Recurred<R> | null;
}

// [LAW:types-are-the-program] A slot is empty, holding, or disposed: a
// disposed slot's owner has closed, so it holds nothing and arms no end.
type SlotState<R> = Held<R> | "empty" | "disposed";

// [LAW:single-enforcer] The owner of a daemon event it holds, between its
// happening and its leaving: what it holds now, what recurred while it was
// held, the answer that marks it, and the rule that lets it go once
// `eventHoldAt` is `over` for a request. That is checked when its hold ends
// (one task per occurrence, so an earlier occurrence's end never retires a
// later one) and when an answer lands past the hold. A slot that never takes
// a recurrence is a `HeldSlot<never>`.
export class HeldSlot<R = never> {
  private state: SlotState<R> = "empty";

  constructor(
    private readonly clock: Pick<Timekeeper, "now" | "after">,
    // The hold-end task's name: what a person reads if it throws.
    private readonly task: string,
    // Hears the slot let go of its event, at its hold's end, at an answer or
    // at its disposal, with what recurred while it was held: the owner holds
    // that afresh or lets it be.
    private readonly left: (recurred: Recurred<R> | null) => void,
  ) {}

  event(): HeldEvent | null {
    return typeof this.state === "string" ? null : this.state.event;
  }

  // [LAW:no-ambient-temporal-coupling] Past the owner's close no bar can show
  // an event, so a disposed slot takes none and arms no end on a closed daemon.
  hold(event: HeldEvent): void {
    if (this.state === "disposed") return;
    if (this.state !== "empty") this.state.cancelEnd();
    const held: Held<R> = { event, cancelEnd: () => {}, recurred: null };
    this.state = held;
    this.armEnd(held);
  }

  // Whether `shown` marked the held event, which leaves too if it is past
  // its hold.
  answer(shown: HeldEvent): boolean {
    const held = this.state;
    if (typeof held === "string" || !answeredBy(held.event, shown))
      return false;
    held.event = { ...held.event, answered: true };
    if (this.holdNow(held.event) === "over") this.leave(held);
    return true;
  }

  // Counts `latest` against the held event, for the owner to hear when the
  // slot lets it go; false when nothing is held to count it against.
  recur(latest: R): boolean {
    const held = this.state;
    if (typeof held === "string") return false;
    held.recurred = { count: (held.recurred?.count ?? 0) + 1, latest };
    return true;
  }

  // A disposed slot lets go of what it holds as any slot does, so what
  // recurred reaches the owner, and it holds nothing after.
  dispose(): void {
    const held = this.state;
    this.state = "disposed";
    if (typeof held === "string") return;
    held.cancelEnd();
    this.left(held.recurred);
  }

  // [LAW:no-ambient-temporal-coupling] The hold is judged on the wall reading
  // and timed on the timers, which need not agree: an end that finds the
  // event still inside its hold arms again for what is left of it. Leaving
  // and a new occurrence cancel the end, so one that fires judges the event
  // the slot still holds.
  private armEnd(held: Held<R>): void {
    const ms =
      (held.event.at + DAEMON_EVENT_HOLD_S - instantAt(this.clock)) * 1000;
    held.cancelEnd = this.clock.after(this.task, Math.max(0, ms), () => {
      switch (this.holdNow(held.event)) {
        case "held":
          this.armEnd(held);
          break;
        // An answer past the hold lets it go.
        case "owed":
          break;
        case "over":
          this.leave(held);
          break;
      }
    });
  }

  private holdNow(event: HeldEvent): EventHold {
    return eventHoldAt(
      event,
      DAEMON_EVENT_HOLD_S,
      instantAt(this.clock),
      "request",
    );
  }

  private leave(held: Held<R>): void {
    held.cancelEnd();
    this.state = "empty";
    this.left(held.recurred);
  }
}

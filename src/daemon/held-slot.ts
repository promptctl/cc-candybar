import type { Timekeeper } from "../time.js";
import {
  answeredBy,
  DAEMON_EVENT_HOLD_S,
  eventHoldAt,
  type EventHold,
  type HeldEvent,
} from "../utils/event-hold.js";
import { instantAt } from "../utils/instant.js";

// The event a slot holds, and the end armed for it.
interface Held {
  event: HeldEvent;
  cancelEnd: () => void;
}

// [LAW:types-are-the-program] A slot is empty, holding, or disposed: a
// disposed slot's owner has closed, so it holds nothing and arms no end.
type SlotState = Held | "empty" | "disposed";

// [LAW:single-enforcer] The one owner of a daemon event between its happening
// and its leaving: what it holds now, the answer that marks it, and the rule
// that lets it go once `eventHoldAt` is `over` for a request. That is checked
// when its hold ends (one task per occurrence, so an earlier occurrence's end
// never retires a later one) and when an answer lands past the hold.
export class HeldSlot {
  private state: SlotState = "empty";

  constructor(
    private readonly clock: Pick<Timekeeper, "now" | "after">,
    // The hold-end task's name: what a person reads if it throws.
    private readonly task: string,
    // Hears the slot empty, whether at its hold's end or at an answer.
    private readonly left: () => void,
  ) {}

  event(): HeldEvent | null {
    return typeof this.state === "string" ? null : this.state.event;
  }

  // [LAW:no-ambient-temporal-coupling] Past the owner's close no bar can show
  // an event, so a disposed slot takes none and arms no end on a closed daemon.
  hold(event: HeldEvent): void {
    if (this.state === "disposed") return;
    if (this.state !== "empty") this.state.cancelEnd();
    const held: Held = { event, cancelEnd: () => {} };
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

  dispose(): void {
    if (typeof this.state !== "string") this.state.cancelEnd();
    this.state = "disposed";
  }

  // [LAW:no-ambient-temporal-coupling] The hold is judged on the wall reading
  // and timed on the timers, which need not agree: an end that finds the
  // event still inside its hold arms again for what is left of it. Leaving
  // and a new occurrence cancel the end, so one that fires judges the event
  // the slot still holds.
  private armEnd(held: Held): void {
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

  private leave(held: Held): void {
    held.cancelEnd();
    this.state = "empty";
    this.left();
  }
}

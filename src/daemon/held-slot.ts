import type { Timekeeper } from "../time.js";
import {
  answeredBy,
  DAEMON_EVENT_HOLD_S,
  eventHoldAt,
  type HeldEvent,
} from "../utils/event-hold.js";
import { instantAt } from "../utils/instant.js";

// [LAW:single-enforcer] The one owner of a daemon event between its happening
// and its leaving: what it holds now, the answer that marks it, and the rule
// that lets it go once `eventHoldAt` is `over` for a request. That is checked
// when its hold ends (one task per occurrence, so an earlier occurrence's end
// never retires a later one) and when an answer lands past the hold.
export class HeldSlot {
  private held: HeldEvent | null = null;
  private cancelEnd: () => void = () => {};

  constructor(
    private readonly clock: Pick<Timekeeper, "now" | "after">,
    // The hold-end task's name: what a person reads if it throws.
    private readonly task: string,
    // Hears the slot empty, whether at its hold's end or at an answer.
    private readonly left: () => void,
  ) {}

  event(): HeldEvent | null {
    return this.held;
  }

  hold(event: HeldEvent): void {
    this.cancelEnd();
    this.held = event;
    const ms = (event.at + DAEMON_EVENT_HOLD_S - instantAt(this.clock)) * 1000;
    this.cancelEnd = this.clock.after(this.task, Math.max(0, ms), () => {
      if (this.leftWhenOver()) this.left();
    });
  }

  // Whether `shown` marked the held event, which leaves too if it is past
  // its hold.
  answer(shown: HeldEvent): boolean {
    if (this.held === null || !answeredBy(this.held, shown)) return false;
    this.held = { ...this.held, answered: true };
    if (this.leftWhenOver()) this.left();
    return true;
  }

  dispose(): void {
    this.cancelEnd();
  }

  private leftWhenOver(): boolean {
    if (
      this.held === null ||
      eventHoldAt(
        this.held,
        DAEMON_EVENT_HOLD_S,
        instantAt(this.clock),
        "request",
      ) !== "over"
    )
      return false;
    this.held = null;
    return true;
  }
}

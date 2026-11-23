import type { Timekeeper } from "../time.js";
import {
  answeredBy,
  DAEMON_EVENT_HOLD_S,
  eventHoldAt,
  type DaemonEvent,
  type EventHold,
  type HeldEvent,
} from "../utils/event-hold.js";
import { instantAt, type Instant } from "../utils/instant.js";

// The event a slot holds, and the end armed for it.
interface Held {
  event: HeldEvent;
  cancelEnd: () => void;
}

// [LAW:types-are-the-program] A slot is empty, holding, or disposed: a
// disposed slot's owner has closed, so it holds nothing and arms no end.
type SlotState = Held | "empty" | "disposed";

// [LAW:single-enforcer] The owner of a daemon event it holds, between its
// happening and its leaving: what it holds now, the answer that marks it, and
// the rule that lets it go once `eventHoldAt` is `over` for a request. That is
// checked when its hold ends (one task per occurrence, so an earlier
// occurrence's end never retires a later one) and when an answer lands past
// the hold.
export class HeldSlot {
  private state: SlotState = "empty";

  constructor(
    private readonly clock: Pick<Timekeeper, "now" | "after">,
    // The hold-end task's name: what a person reads if it throws.
    private readonly task: string,
    // Hears the slot let go of its event, at its hold's end, at an answer or
    // at its disposal.
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

  // A disposed slot lets go of what it holds as any slot does, and it holds
  // nothing after.
  dispose(): void {
    const held = this.state;
    this.state = "disposed";
    if (typeof held === "string") return;
    held.cancelEnd();
    this.left();
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

// The kinds of daemon event that recur, each held per subject.
type RecurringKind = "launch-pipes" | "task-threw";

interface Subject<R> {
  readonly slot: HeldSlot;
  // What recurred while the subject's event was held: how many times, and
  // the latest.
  recurred: { readonly count: number; readonly latest: R } | null;
}

// [LAW:single-enforcer] The daemon's events of one kind that recur, one held
// event per subject (a task that threw, a pipe event's words), each kept
// apart so one never stands for another. An occurrence while its subject's
// event is held is counted, so a flood moves no bar; when the slot lets go,
// the latest of those counted is held afresh with their count, and with none
// counted the subject leaves every bar.
export class RecurringEvents<R> {
  private readonly subjects = new Map<string, Subject<R>>();
  private closed = false;

  constructor(
    private readonly clock: Pick<Timekeeper, "now" | "after">,
    private readonly kind: RecurringKind,
    // What an occurrence is about: the subject it is counted against.
    private readonly about: (occurrence: R) => string,
    // [LAW:single-enforcer] The event an occurrence is held as, `more` times
    // since its subject's event was last shown, stamped `at` the instant it
    // is shown: its hold runs from there, a first occurrence's and a
    // recurrence's alike.
    private readonly shown: (
      occurrence: R,
      more: number,
      at: Instant,
    ) => HeldEvent,
    // Hears each change in what is held.
    private readonly changed: () => void,
  ) {}

  // [LAW:no-ambient-temporal-coupling] Past the owner's close no bar can show
  // an event, so a closed family takes none and arms no end on a closed
  // daemon, as a disposed slot takes none.
  occur(occurrence: R): void {
    if (this.closed) return;
    const about = this.about(occurrence);
    const subject = this.subjects.get(about) ?? this.subjectOf(about);
    // [LAW:one-source-of-truth] A subject is held when its slot holds: an
    // entry whose event could not be built holds nothing, so its next
    // occurrence is shown as a first one.
    if (subject.slot.event() === null) this.show(subject, occurrence, 0);
    else
      subject.recurred = {
        count: (subject.recurred?.count ?? 0) + 1,
        latest: occurrence,
      };
  }

  held(): DaemonEvent[] {
    return [...this.subjects].flatMap(([about, { slot }]) => {
      const event = slot.event();
      return event === null ? [] : [{ kind: this.kind, about, event }];
    });
  }

  // Whether `shown` marked its subject's held event. A frame can carry an
  // event whose subject has since left: nothing holds it to mark.
  answer(about: string, shown: HeldEvent): boolean {
    return this.subjects.get(about)?.slot.answer(shown) ?? false;
  }

  // Each subject lets go as at any slot's disposal, so what recurred is still
  // shown to whatever hears it, and nothing is held after.
  dispose(): void {
    this.closed = true;
    for (const { slot } of this.subjects.values()) slot.dispose();
  }

  private show(subject: Subject<R>, occurrence: R, more: number): void {
    const event = this.shown(occurrence, more, instantAt(this.clock));
    subject.recurred = null;
    subject.slot.hold(event);
    this.changed();
  }

  private subjectOf(about: string): Subject<R> {
    const subject: Subject<R> = {
      slot: new HeldSlot(this.clock, `${this.kind} hold ${about}`, () => {
        const { recurred } = subject;
        if (recurred !== null)
          return this.show(subject, recurred.latest, recurred.count);
        this.subjects.delete(about);
        this.changed();
      }),
      recurred: null,
    };
    this.subjects.set(about, subject);
    return subject;
  }
}

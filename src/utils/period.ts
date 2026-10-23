import type { Outcome } from "./outcome";

// [LAW:types-are-the-program] A period chosen by the last read's outcome: a
// failed read is retried on its own (usually shorter) period, so a transient
// outage is not pinned to the bar for the full ok-period. A source whose
// failures wait as long as its answers names one number twice.
export interface Every {
  readonly okMs: number;
  readonly failedMs: number;
}

export function periodOf(every: Every, outcome: Outcome<unknown>): number {
  return outcome.kind === "failed" ? every.failedMs : every.okMs;
}

// [LAW:single-enforcer] The one clock an owner refreshes a shared entry on
// (brandon-unfiled-3248.8ro6, step 1). A read never decides whether its value
// is fresh; the owner's period re-reads the entry in the background, and a
// read takes whatever value is stored.
//
// [LAW:no-ambient-temporal-coupling] A period runs only while something holds
// its entry, so an entry nobody draws costs no spawn. It measures from the
// last read that LANDED, whatever started that read — a watch, a first read,
// a tick — so a held entry is never read more often than its period, and one
// whose hold returns after a gap resumes where it left off: at once when its
// last read is older than its period, else when the rest of the period is up.
// An entry never read schedules nothing: its first read is the reader's.
//
// [LAW:types-are-the-program] Disposed is a state of its own, the last one:
// the owner dropped the entry, and a hold or a landing that reaches it after
// (a home releasing its hold during teardown) schedules nothing.
export class Period {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private state: "released" | "held" | "disposed" = "released";
  private last: { readonly at: number; readonly periodMs: number } | null =
    null;

  constructor(
    // Starts a read. The owner calls `landed` when that read (or any other)
    // lands, which is what schedules the next tick.
    private readonly tick: () => void,
    private readonly now: () => number = Date.now,
  ) {}

  // A read landed at `at` (now, unless the owner is resuming an answer it
  // kept from earlier). `periodMs` is chosen by the caller from the read's
  // outcome (a failed PR lookup is retried sooner than a found one).
  landed(periodMs: number, at: number = this.now()): void {
    this.last = { at, periodMs };
    this.schedule();
  }

  hold(held: boolean): void {
    if (this.state === "disposed") return;
    const next = held ? "held" : "released";
    if (next === this.state) return;
    this.state = next;
    this.schedule();
  }

  dispose(): void {
    this.state = "disposed";
    this.cancel();
  }

  private schedule(): void {
    this.cancel();
    if (this.state !== "held" || this.last === null) return;
    const wait = Math.max(0, this.last.at + this.last.periodMs - this.now());
    this.timer = setTimeout(() => {
      this.timer = null;
      this.tick();
    }, wait);
    this.timer.unref?.();
  }

  private cancel(): void {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
  }
}

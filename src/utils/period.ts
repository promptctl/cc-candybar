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
export class Period {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private held = false;
  private last: { readonly at: number; readonly periodMs: number } | null =
    null;

  constructor(
    // Starts a read. The owner calls `landed` when that read (or any other)
    // lands, which is what schedules the next tick.
    private readonly tick: () => void,
    private readonly now: () => number = Date.now,
  ) {}

  // A read landed. `periodMs` is chosen by the caller from the read's outcome
  // (a failed PR lookup is retried sooner than a found one).
  landed(periodMs: number): void {
    this.last = { at: this.now(), periodMs };
    this.schedule();
  }

  hold(held: boolean): void {
    if (held === this.held) return;
    this.held = held;
    this.schedule();
  }

  dispose(): void {
    this.held = false;
    this.cancel();
  }

  private schedule(): void {
    this.cancel();
    if (!this.held || this.last === null) return;
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

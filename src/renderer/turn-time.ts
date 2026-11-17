// [LAW:no-ambient-temporal-coupling] The renderer's time: the instant of the
// input in its turn, handed in by the host, and what its owners asked to run
// later, held as data until the turn whose instant reaches it. The renderer
// reads no clock and sets no timer, so a deferral is no callback the loop
// runs between turns: the renderer declares the earliest as part of its wake,
// and the `due` turn at that instant runs what fell due, in a turn like any
// other.
//
// [LAW:one-source-of-truth] It answers the variable store's `now` and
// `after`, so a box's change is stamped with its turn's instant, and a held
// write (a torn document's settle) is shown in the turn that reaches it.

import type { Timekeeper } from "../time.js";
import type { Instant } from "../utils/instant.js";

// What the variable store, and the sources over it, read of time.
export type StoreTime = Pick<Timekeeper, "now" | "after">;

interface Later {
  readonly until: Instant;
  readonly fire: () => void;
}

export class TurnTime implements StoreTime {
  private at: Instant | null = null;
  private readonly later = new Set<Later>();

  // The turn now running is at `at`: every read until the next is of it.
  turn(at: Instant): void {
    this.at = at;
  }

  // The turn's instant, in epoch milliseconds.
  now(): number {
    // [LAW:no-silent-failure] A read outside any turn has no instant to read.
    if (this.at === null)
      throw new Error("the renderer read the time before its first turn");
    return this.at * 1000;
  }

  after(ms: number, fire: () => void): () => void {
    const later: Later = {
      until: (this.now() / 1000 + ms / 1000) as Instant,
      fire,
    };
    this.later.add(later);
    return () => this.later.delete(later);
  }

  // The earliest instant something waits for, or null for none.
  next(): Instant | null {
    return this.earliest(Infinity as Instant)?.until ?? null;
  }

  // Runs what fell due by `at`, earliest first, each taken from what is held
  // as it runs: one an earlier one cancelled is not run, one that throws
  // fails the turn and is not run again, and those behind it stay due, run
  // by the next `due`.
  due(at: Instant): void {
    for (
      let later = this.earliest(at);
      later !== null;
      later = this.earliest(at)
    ) {
      this.later.delete(later);
      later.fire();
    }
  }

  private earliest(at: Instant): Later | null {
    let soonest: Later | null = null;
    for (const later of this.later)
      if (
        later.until <= at &&
        (soonest === null || later.until < soonest.until)
      )
        soonest = later;
    return soonest;
  }
}

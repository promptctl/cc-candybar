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
    let soonest: Instant | null = null;
    for (const { until } of this.later)
      if (soonest === null || until < soonest) soonest = until;
    return soonest;
  }

  // Runs what fell due by `at`, earliest first, each taken before it runs,
  // so a throw leaves none of those behind it run twice.
  due(at: Instant): void {
    const due = [...this.later]
      .filter(({ until }) => until <= at)
      .sort((a, b) => a.until - b.until);
    for (const later of due) this.later.delete(later);
    for (const { fire } of due) fire();
  }
}

// [LAW:effects-at-boundaries] The renderer's time: the readings of the input
// in its turn, which the host made as the input's slot came, and the work it
// holds for a later tick. The renderer reads no clock and sets no timer, so a
// turn's time is the input's, and work held for later runs in the `due` turn
// whose tick has reached it.
//
// [LAW:no-ambient-temporal-coupling] Everything held is measured on ticks,
// which never run back, so no holder handles a wall clock stepped.

import {
  earliestOf,
  type Instant,
  type Readings,
  type Tick,
} from "../utils/instant.js";
import type { Timekeeper } from "../time.js";
import { runEach } from "../utils/run-each.js";

interface Deferral {
  readonly until: Tick;
  readonly run: () => void;
}

// The face of the turn's time a variable store reads: the wall in epoch
// milliseconds, for ages and stamps, and work held for later.
export type TurnClock = Pick<Timekeeper, "now" | "after">;

export class TurnTime {
  private readings: Readings | null = null;
  // In the order they were held, so two due at one tick run in that order.
  private readonly held = new Set<Deferral>();

  // [LAW:single-enforcer] The one way a turn's readings are set: for the
  // turn's length, whatever it ends in.
  during<T>(readings: Readings, turn: () => T): T {
    this.readings = readings;
    try {
      return turn();
    } finally {
      this.readings = null;
    }
  }

  // [LAW:no-silent-failure] Read outside a turn, there is no time to read:
  // the reader runs off the renderer's turns, which is its bug.
  private current(): Readings {
    if (this.readings === null)
      throw new Error("the renderer's time was read outside a turn");
    return this.readings;
  }

  get at(): Instant {
    return this.current().at;
  }

  get tick(): Tick {
    return this.current().tick;
  }

  // Holds `run` for the due turn `ms` after this one's tick; what it returns
  // lets go of it.
  after(ms: number, run: () => void): () => void {
    const deferral = { until: (this.tick + ms / 1000) as Tick, run };
    this.held.add(deferral);
    return () => void this.held.delete(deferral);
  }

  deferrals(): number {
    return this.held.size;
  }

  // The earliest tick held work is due at, or null when none is held.
  next(): Tick | null {
    return earliestOf([...this.held].map(({ until }) => until));
  }

  // The work due by this turn's tick, earliest first. Each is taken from what
  // is still held as it runs, so one let go by work before it never runs, and
  // one that throws is not held again, nor keeps the work after it from
  // running. Work held while these run waits for the next due turn, so a
  // chain of work spreads over turns, and inputs between them are taken.
  runDue(): void {
    const { tick } = this;
    const due = [...this.held]
      .filter(({ until }) => until <= tick)
      .sort((a, b) => a.until - b.until);
    runEach(
      due.map((deferral) => () => {
        if (this.held.delete(deferral)) deferral.run();
      }),
    );
  }

  // [LAW:one-source-of-truth] The store's face: the turn's wall instant, in
  // epoch milliseconds, and its held work.
  readonly clock: TurnClock = {
    now: () => this.at * 1000,
    // The renderer's held work throws into its turn (`runDue`), not to a
    // reporting clock, so the task's name is not kept.
    after: (_task, ms, run) => this.after(ms, () => void run()),
  };
}

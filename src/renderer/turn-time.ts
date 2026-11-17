// [LAW:effects-at-boundaries] The renderer's time, which it reads no clock
// for: the instant of the input in its turn, as the host read it, and the work
// held for a later instant, which the renderer's wake declares and a `due`
// runs. The variable store stamps its writes with `now`, verbs stamp what a
// click records with `at`, and a torn write's settle is held by `after`.

import type { Instant } from "../utils/instant.js";

interface Deferral {
  readonly until: Instant;
  readonly run: () => void;
}

export class TurnTime {
  private current: Instant | null = null;
  private readonly held = new Set<Deferral>();

  // [LAW:no-ambient-temporal-coupling] Set for exactly one input's turn, so a
  // read outside any turn fails loudly rather than reading a stale instant.
  begin(at: Instant): void {
    this.current = at;
  }

  end(): void {
    this.current = null;
  }

  at(): Instant {
    if (this.current === null)
      throw new Error("the renderer read the time outside any turn");
    return this.current;
  }

  // The turn's instant in epoch milliseconds, as a wall reading is.
  now(): number {
    return this.at() * 1000;
  }

  // Holds `run` until `ms` after the turn's instant; what it returns lets go
  // of it unrun.
  after(ms: number, run: () => void): () => void {
    const deferral: Deferral = {
      until: (this.at() + ms / 1000) as Instant,
      run,
    };
    this.held.add(deferral);
    return () => void this.held.delete(deferral);
  }

  // The earliest instant a held deferral falls due, or null while none is
  // held.
  next(): Instant | null {
    let next: Instant | null = null;
    for (const { until } of this.held)
      if (next === null || until < next) next = until;
    return next;
  }

  // [LAW:no-ambient-temporal-coupling] Every deferral due by `at`, earliest
  // first, each taken from what is still held as it runs: one an earlier one
  // let go of never runs, and one that throws fails the turn and leaves those
  // behind it held, due again.
  runDue(at: Instant): void {
    for (;;) {
      let first: Deferral | null = null;
      for (const deferral of this.held)
        if (
          deferral.until <= at &&
          (first === null || deferral.until < first.until)
        )
          first = deferral;
      if (first === null) return;
      this.held.delete(first);
      first.run();
    }
  }
}

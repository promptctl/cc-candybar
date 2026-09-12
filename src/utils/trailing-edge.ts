// [LAW:one-source-of-truth] A keyed trailing-edge serializer: while work for a
// key is running, a new trigger for that same key does not start a second run
// and is not dropped — it is REMEMBERED, and the running loop performs exactly
// one more pass before it exits. N triggers arriving during one pass therefore
// collapse into one re-run, so the final published value always reflects the
// last trigger, and the work never fans out into parallel passes.
//
// [LAW:no-ambient-temporal-coupling] The point is that "something changed while
// we were looking" is STATE this owner holds, not a race the caller hopes to
// win. A trigger that arrives mid-pass is data the loop consults at the top of
// its next iteration; there is no window in which a change is silently lost
// because it landed at the wrong moment.
//
// Not SingleFlight, and the difference is the whole reason both exist:
// SingleFlight (src/utils/single-flight.ts) makes K concurrent CALLERS share one
// result — correct when they all want the same answer to the same question, as K
// renders scanning one transcript do. This makes one caller's later trigger
// re-run the work — correct when the trigger means the answer has CHANGED, as a
// `.git/index` write or a dependency variable's new value do. Sharing a result
// there would publish the pre-change value and call it current. Neither
// subsumes the other; do not merge them.
//
// Dropping instead of queueing is the third shape, and it is only safe where
// something asks again on a clock — gitui's AsyncStatus drops a duplicate and
// leans on a re-polling tick, while its AsyncSingleJob queues a one-slot next
// (design-docs/peer-exploration/3-mechanisms/asyncgit-coalescing.md). This is
// the queueing shape: its callers include triggers that fire once and never
// again, so a dropped one is a value that stays stale forever.

// The outcome of a trigger, which is a state transition and not a preference:
// idle + trigger starts a loop and hands back its completion; running + trigger
// records itself and hands back nothing, because the loop already in flight is
// the one that will honour it. A caller that must await the work folds over
// these two arms rather than asking a second question about which happened.
export type Trigger =
  | { readonly kind: "started"; readonly done: Promise<void> }
  | { readonly kind: "queued" };

export class TrailingEdge {
  // The keys whose loop is currently executing.
  private readonly running = new Set<string>();
  // The keys a trigger arrived for while their loop was mid-pass. A Set, not a
  // count: ten triggers during one pass mean the same thing as one — the work
  // must be done once more with current inputs.
  private readonly again = new Set<string>();

  run(key: string, work: () => Promise<void>): Trigger {
    // Recording the trigger is unconditional; only who acts on it varies. The
    // first iteration of a loop started here consumes this same flag, so the
    // idle and running paths write the same state and differ in nothing else.
    this.again.add(key);
    if (this.running.has(key)) return { kind: "queued" };
    this.running.add(key);
    return { kind: "started", done: this.loop(key, work) };
  }

  private async loop(key: string, work: () => Promise<void>): Promise<void> {
    try {
      do {
        // Cleared BEFORE the pass, never after: a trigger that lands while
        // `work` is awaiting must survive into the `while`, and one cleared
        // afterwards would be the change this whole mechanism exists to keep.
        this.again.delete(key);
        await work();
      } while (this.again.has(key));
    } finally {
      this.running.delete(key);
      this.again.delete(key);
    }
  }

  // Drop every record of running and pending work — the teardown path of an
  // owner being disposed. In-flight passes cannot be cancelled from here (the
  // await belongs to `work`), so they run to completion; what this guarantees is
  // that no QUEUED trigger is honoured after teardown, and that an owner
  // rebuilt with the same keys starts clean.
  clear(): void {
    this.running.clear();
    this.again.clear();
  }

  // Number of keys whose loop is executing — a read-only observability surface
  // for tests asserting the serialization contract. Never read as control flow.
  get size(): number {
    return this.running.size;
  }
}

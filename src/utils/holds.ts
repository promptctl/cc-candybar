// [LAW:single-enforcer] What one home holds of the daemon's shared entries (a
// repo, a pane, a memento reading): one hold per entry however often the home
// reads it (brandon-unfiled-3248.8ro6, step 1). An owner's period visits only
// held entries (src/utils/period.ts), so an entry the home stopped reading
// stops costing its refreshes: a hold its home has not read across a whole
// sweep is released, and the home's next read takes it back; a disposed home
// closes.
export type Release = () => void;

interface Held {
  readonly release: Release;
  // Read since the last sweep.
  read: boolean;
}

export class Holds {
  private readonly held = new Map<string, Held>();
  private closed = false;

  // `acquire` runs only for an entry this home does not hold now.
  take(key: string, acquire: () => Release): void {
    // [LAW:no-silent-failure] A disposed home taking a hold would leak it: no
    // dispose is left to release it.
    if (this.closed) throw new Error(`hold taken after close: ${key}`);
    const held = this.held.get(key);
    if (held !== undefined) {
      held.read = true;
      return;
    }
    this.held.set(key, { release: acquire(), read: true });
  }

  // [LAW:no-ambient-temporal-coupling] The caller's sweep is the clock: each
  // call releases every hold not read since the call before it, so a hold
  // lasts from one to two sweeps past its last read. Returns how many.
  releaseUnread(): number {
    let count = 0;
    for (const [key, held] of this.held) {
      if (held.read) {
        held.read = false;
        continue;
      }
      held.release();
      this.held.delete(key);
      count++;
    }
    return count;
  }

  // Releases every hold and refuses new ones: the home is gone.
  close(): number {
    this.closed = true;
    const count = this.held.size;
    for (const held of this.held.values()) held.release();
    this.held.clear();
    return count;
  }

  get size(): number {
    return this.held.size;
  }
}

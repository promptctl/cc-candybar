// [LAW:single-enforcer] What one home holds of the daemon's shared entries (a
// repo today; panes and memento readings as their owners join): one hold per
// entry however often the home reads it (brandon-unfiled-3248.8ro6, step 1).
// An owner's period visits only held entries (src/utils/period.ts), so a home
// nobody draws from stops costing its entries' refreshes: an idle home releases
// its holds and takes them back with its next read, and a disposed home closes.
export type Release = () => void;

export class Holds {
  private readonly held = new Map<string, Release>();
  private closed = false;

  // `acquire` runs only for an entry this home does not hold now.
  take(key: string, acquire: () => Release): void {
    // [LAW:no-silent-failure] A disposed home taking a hold would leak it: no
    // dispose is left to release it.
    if (this.closed) throw new Error(`hold taken after close: ${key}`);
    if (this.held.has(key)) return;
    this.held.set(key, acquire());
  }

  // Releases every hold; the next read takes its own back. Returns how many.
  release(): number {
    const count = this.held.size;
    for (const release of this.held.values()) release();
    this.held.clear();
    return count;
  }

  // Releases every hold and refuses new ones: the home is gone.
  close(): number {
    this.closed = true;
    return this.release();
  }

  get size(): number {
    return this.held.size;
  }
}

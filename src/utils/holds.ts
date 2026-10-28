// [LAW:single-enforcer] What one home holds of the daemon's shared entries (a
// repo, a pane, a plugin's session file, a directory set's scans): one hold per
// entry however often the home reads it (brandon-unfiled-3248.8ro6, step 1).
// An owner's period visits only held entries (src/utils/period.ts), so an
// entry the home stopped reading stops costing its refreshes. What the home
// holds is what its latest declaration took (`declare`): an entry its closure
// or its request stopped naming is released by the declaration that no
// longer takes it, and a disposed home closes.
export type Release = () => void;

// What one declaration changed: the holds it acquired and those it released,
// beside what its body answered.
export interface Declared<R> {
  readonly result: R;
  readonly acquired: number;
  readonly released: number;
}

export class Holds {
  private readonly held = new Map<string, Release>();
  // The keys the declaration in progress has taken, and how many of them it
  // acquired.
  private declaring: { taken: Set<string>; acquired: number } | null = null;
  private closed = false;

  // `acquire` runs only for an entry this home does not hold now.
  take(key: string, acquire: () => Release): void {
    // [LAW:no-silent-failure] A disposed home taking a hold would leak it: no
    // dispose is left to release it.
    if (this.closed) throw new Error(`hold taken after close: ${key}`);
    this.declaring?.taken.add(key);
    if (this.held.has(key)) return;
    this.held.set(key, acquire());
    if (this.declaring !== null) this.declaring.acquired++;
  }

  // [LAW:no-ambient-temporal-coupling] One declaration: `body` takes every
  // hold the home's draws read, and each hold it did not take is released
  // once it returns, so the home holds exactly what it declared. Returns what
  // the body answered, and how many holds it acquired and released.
  declare<R>(body: () => R): Declared<R> {
    if (this.declaring !== null) throw new Error("declaration within one");
    const declaring = { taken: new Set<string>(), acquired: 0 };
    this.declaring = declaring;
    let result: R;
    try {
      result = body();
    } finally {
      this.declaring = null;
    }
    let released = 0;
    for (const [key, release] of this.held) {
      if (declaring.taken.has(key)) continue;
      this.held.delete(key);
      release();
      released++;
    }
    return { result, acquired: declaring.acquired, released };
  }

  // Releases every hold and refuses new ones: the home is gone.
  close(): number {
    this.closed = true;
    const count = this.held.size;
    for (const release of this.held.values()) release();
    this.held.clear();
    return count;
  }

  get size(): number {
    return this.held.size;
  }
}

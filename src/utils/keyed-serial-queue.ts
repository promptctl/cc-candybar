// [LAW:no-ambient-temporal-coupling] FIFO per key: each key's tasks run one at
// a time, each after the last has settled, and a rejection is its own caller's
// and never stops the tasks behind it. A task runs at once, in the caller's
// turn, while its key is idle.
export class KeyedSerialQueue<K> {
  // Each key's tasks still to run, while one runs.
  private readonly waiting = new Map<K, Array<() => Promise<void>>>();

  run<T>(key: K, task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      // [LAW:types-are-the-program] An entry never rejects, so the drain below
      // has no failure to carry.
      const entry = async (): Promise<void> => {
        try {
          resolve(await task());
        } catch (e) {
          reject(e);
        }
      };
      const behind = this.waiting.get(key);
      if (behind !== undefined) {
        behind.push(entry);
        return;
      }
      const tasks: Array<() => Promise<void>> = [];
      this.waiting.set(key, tasks);
      const drain = (next: () => Promise<void>): void =>
        void next().then(() => {
          const after = tasks.shift();
          if (after === undefined) this.waiting.delete(key);
          else drain(after);
        });
      drain(entry);
    });
  }
}

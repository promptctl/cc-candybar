// [LAW:no-ambient-temporal-coupling] FIFO per key: each key's tasks run one at
// a time, each after the last has settled, and a rejection is its own caller's
// and never stops the tasks behind it. A task runs at once, in the caller's
// turn, while its key is idle. A task placed `first` runs next, ahead of every
// task waiting on its key, behind only the one running. A task placed `idle`
// runs once no other task waits on its key: every task placed `first` or
// `last` before it starts runs ahead of it, whenever it was placed.
export type Place = "first" | "last" | "idle";

type Entry = () => Promise<void>;

export class KeyedSerialQueue<K> {
  // Each key's tasks still to run, while one runs: those placed `idle` apart,
  // since every other waits ahead of them.
  private readonly waiting = new Map<
    K,
    { readonly tasks: Entry[]; readonly idle: Entry[] }
  >();

  run<T>(key: K, task: () => Promise<T>, at: Place = "last"): Promise<T> {
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
        if (at === "first") behind.tasks.unshift(entry);
        else if (at === "last") behind.tasks.push(entry);
        else behind.idle.push(entry);
        return;
      }
      const waiting = { tasks: [] as Entry[], idle: [] as Entry[] };
      this.waiting.set(key, waiting);
      const drain = (next: Entry): void =>
        void next().then(() => {
          const after = waiting.tasks.shift() ?? waiting.idle.shift();
          if (after === undefined) this.waiting.delete(key);
          else drain(after);
        });
      drain(entry);
    });
  }
}

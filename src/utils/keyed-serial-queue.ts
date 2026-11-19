// [LAW:no-ambient-temporal-coupling] FIFO per key: each key's tasks run one at
// a time, each after the last has settled. A task runs at once while its key
// is free. A `first` task takes the next slot, as renderer startup requires.
// Scheduled tasks take one slot after a burst of ordinary tasks, or at once
// if none wait. A rejection reaches its caller without stopping the queue.
export type Place = "first" | "last" | "scheduled";

export const FOREGROUND_BURST = 8;

type Entry = () => Promise<void>;

interface Waiting {
  readonly first: Entry[];
  readonly last: Entry[];
  readonly scheduled: Entry[];
  ordinary: number;
}

// [LAW:single-enforcer] The burst counts ordinary slots selected while
// scheduled work waits. A running slot and priority starts are outside the
// bound. Reset after each scheduled slot so ordinary work gets its turn too.
function next(waiting: Waiting): Entry | undefined {
  const first = waiting.first.pop();
  if (first !== undefined) return first;
  if (
    waiting.scheduled.length > 0 &&
    (waiting.last.length === 0 || waiting.ordinary === FOREGROUND_BURST)
  ) {
    waiting.ordinary = 0;
    return waiting.scheduled.shift();
  }
  const last = waiting.last.shift();
  if (last !== undefined && waiting.scheduled.length > 0) waiting.ordinary++;
  return last;
}

export class KeyedSerialQueue<K> {
  private readonly waiting = new Map<K, Waiting>();

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
        behind[at].push(entry);
        return;
      }
      const waiting: Waiting = {
        first: [],
        last: [],
        scheduled: [],
        ordinary: 0,
      };
      this.waiting.set(key, waiting);
      const drain = (entry: Entry): void =>
        void entry().then(() => {
          const after = next(waiting);
          if (after === undefined) this.waiting.delete(key);
          else drain(after);
        });
      drain(entry);
    });
  }
}

import { observable, runInAction } from "mobx";

// [LAW:single-enforcer] A bounded LRU map whose readers wake only when a key's
// value changes. Recency (which key goes first past the bound) is kept apart
// from the values and is not observable, so a refresh that finds its key's
// value standing marks it used without waking any view that reads it.
export class ObservableLru<K, V> {
  private readonly values = observable.map<K, V>(undefined, { deep: false });
  // Least recently used first.
  private readonly order = new Set<K>();

  constructor(private readonly max: number) {}

  get(key: K): V | undefined {
    return this.values.get(key);
  }

  get size(): number {
    return this.order.size;
  }

  // The key was used and its value stands.
  touch(key: K): void {
    if (this.order.delete(key)) this.order.add(key);
  }

  // The key's value now, used now. A value identical to the one held wakes
  // nobody.
  set(key: K, value: V): void {
    this.order.delete(key);
    this.order.add(key);
    runInAction(() => {
      this.values.set(key, value);
      for (const oldest of this.order) {
        if (this.order.size <= this.max) break;
        this.order.delete(oldest);
        this.values.delete(oldest);
      }
    });
  }
}

// [LAW:carrying-cost] The first and last session are both reachable directly.
// A hearing, a write and an arbitrary removal only relink their neighbours,
// including when several newest entries disappear before the next hearing.
interface Entry<K, V> {
  readonly key: K;
  value: V;
  older?: Entry<K, V>;
  newer?: Entry<K, V>;
}

export class RecencyMap<K, V> implements ReadonlyMap<K, V> {
  private readonly byKey = new Map<K, Entry<K, V>>();
  private first?: Entry<K, V>;
  private last?: Entry<K, V>;

  get size(): number {
    return this.byKey.size;
  }
  get oldest(): K | undefined {
    return this.first?.key;
  }
  has(key: K): boolean {
    return this.byKey.has(key);
  }
  get(key: K): V | undefined {
    return this.byKey.get(key)?.value;
  }

  *entries(): MapIterator<[K, V]> {
    for (let entry = this.first; entry !== undefined; entry = entry.newer)
      yield [entry.key, entry.value];
  }

  [Symbol.iterator](): MapIterator<[K, V]> {
    return this.entries();
  }
  *keys(): MapIterator<K> {
    for (const [key] of this) yield key;
  }
  *values(): MapIterator<V> {
    for (const [, value] of this) yield value;
  }
  forEach(
    callback: (value: V, key: K, map: ReadonlyMap<K, V>) => void,
    thisArg?: unknown,
  ): void {
    for (const [key, value] of this) callback.call(thisArg, value, key, this);
  }

  clear(): void {
    this.byKey.clear();
    this.first = this.last = undefined;
  }

  set(key: K, value: V): void {
    const existing = this.byKey.get(key);
    if (existing) {
      existing.value = value;
      this.touch(key);
    } else {
      const entry = { key, value };
      this.byKey.set(key, entry);
      this.append(entry);
    }
  }

  touch(key: K): boolean {
    const entry = this.byKey.get(key);
    if (entry === undefined || entry === this.last) return false;
    this.unlink(entry);
    this.append(entry);
    return true;
  }

  delete(key: K): boolean {
    const entry = this.byKey.get(key);
    if (entry === undefined) return false;
    this.unlink(entry);
    return this.byKey.delete(key);
  }

  private unlink(entry: Entry<K, V>): void {
    if (entry.older) entry.older.newer = entry.newer;
    else this.first = entry.newer;
    if (entry.newer) entry.newer.older = entry.older;
    else this.last = entry.older;
  }

  private append(entry: Entry<K, V>): void {
    entry.older = this.last;
    entry.newer = undefined;
    if (this.last) this.last.newer = entry;
    else this.first = entry;
    this.last = entry;
  }
}

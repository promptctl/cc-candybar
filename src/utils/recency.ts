// A map whose insertion order is recency, oldest first: each store that is
// bounded by idleness keeps its sessions so, and its file keeps their order.
// [LAW:one-source-of-truth] These are the two moves to the newest end, for
// every such map, so a renderer's store and the host's copy of it agree on
// what moved.

// The newest entry.
export function newestOf<K>(map: ReadonlyMap<K, unknown>): K | undefined {
  let newest: K | undefined;
  for (const key of map.keys()) newest = key;
  return newest;
}

// A write: the key's value goes to the newest end, or a null value drops it.
// False when nothing changed: a drop of a key it does not hold.
export function putNewest<K, V>(
  map: Map<K, V>,
  key: K,
  value: V | null,
): boolean {
  const dropped = map.delete(key);
  if (value === null) return dropped;
  map.set(key, value);
  return true;
}

// A hearing: the key's entry goes to the newest end, holding what it held.
// False when nothing moved: no entry, or already the newest.
export function toNewest<K, V>(map: Map<K, V>, key: K): boolean {
  const value = map.get(key);
  if (value === undefined || newestOf(map) === key) return false;
  return putNewest(map, key, value);
}

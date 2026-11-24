// A map whose insertion order is recency, oldest first: each store that is
// bounded by idleness keeps its sessions so, and its file keeps their order.

// The newest entry.
export function newestOf<K>(map: ReadonlyMap<K, unknown>): K | undefined {
  let newest: K | undefined;
  for (const key of map.keys()) newest = key;
  return newest;
}

// [LAW:one-source-of-truth] The one move of an entry to the newest end, for
// every such map, so a renderer's store and the host's copy of it agree on
// what moved. False when nothing did: no entry, or already the newest.
export function toNewest<K, V>(map: Map<K, V>, key: K): boolean {
  const value = map.get(key);
  if (value === undefined || newestOf(map) === key) return false;
  map.delete(key);
  map.set(key, value);
  return true;
}

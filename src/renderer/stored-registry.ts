// [LAW:single-enforcer] The one way the renderer's stored state crosses to
// the host (docs/design/host-and-renderer.md §7): each owner of a store takes
// what its start handed in, and every turn ends with a `store` write for
// each entry that moved since the host last heard of it. No owner writes,
// saves or flushes anything itself.

import type { JsonValue } from "../var-system/types";
import type { Effect } from "../renderer-interface/interface";
import type {
  StoreName,
  StoredState,
  StoredStore,
} from "../renderer-interface/stored";

// An owner of one store. [LAW:one-source-of-truth] Its entries are its own
// state, read off it: `versions` names each entry it holds by a token that
// is a new one whenever what the entry holds moves, so a turn that moved
// nothing writes nothing.
export interface StoredOwner {
  readonly store: StoreName;
  restore(stored: StoredStore): void;
  versions(): ReadonlyMap<string, unknown>;
  value(key: string): JsonValue;
}

export class StoredRegistry {
  // What the host holds of each store: each entry's version as it was last
  // written, by store.
  private readonly told = new Map<StoreName, Map<string, unknown>>();

  constructor(private readonly owners: readonly StoredOwner[]) {}

  // A start's stored state: each owner restores its store, and what the host
  // holds is what was handed in. An entry the owner did not keep as it was
  // handed in (dropped past a bound, refused, or rewritten as it was read)
  // is owed to the host, so its copy is never one the renderer has not got.
  restore(stored: StoredState): void {
    for (const owner of this.owners) {
      const handed = stored[owner.store];
      owner.restore(handed);
      const entries = handed.kind === "read" ? handed.entries : {};
      const versions = owner.versions();
      const told = new Map<string, unknown>();
      for (const [key, value] of Object.entries(entries)) {
        const kept =
          versions.has(key) &&
          JSON.stringify(owner.value(key)) === JSON.stringify(value);
        // [LAW:dataflow-not-control-flow] A token nothing holds, so the
        // next drain writes this entry, or its absence.
        told.set(key, kept ? versions.get(key) : RESTORED_APART);
      }
      this.told.set(owner.store, told);
    }
  }

  // [LAW:no-ambient-temporal-coupling] The turn's end: a write for each entry
  // that moved, or that went, joins its effects, so the host holds what the
  // turn left before any later turn can start the renderer again.
  drain(effects: Effect[]): void {
    for (const owner of this.owners) {
      const told = this.told.get(owner.store) ?? new Map<string, unknown>();
      const versions = owner.versions();
      for (const [key, version] of versions) {
        if (told.has(key) && told.get(key) === version) continue;
        effects.push({
          kind: "store",
          store: owner.store,
          key,
          value: owner.value(key),
        });
        told.set(key, version);
      }
      for (const key of [...told.keys()]) {
        if (versions.has(key)) continue;
        effects.push({ kind: "store", store: owner.store, key, value: null });
        told.delete(key);
      }
      this.told.set(owner.store, told);
    }
  }
}

const RESTORED_APART = Symbol("restored apart");

// [LAW:one-type-per-behavior] One generic store for all per-session state.
// Adding a new per-session value is just picking a string key — no new class,
// no DI wiring, no cache invalidation.
//
// [LAW:single-enforcer] Reads are MobX-tracked through a single internal atom.
// Every get() reports observed; every set/clear/prune reports changed. A DSL
// computed that reads SessionState via this object will re-evaluate whenever
// any (sessionId, key) pair mutates — coarse-grained on purpose, since
// session-state mutations are rare (clicks) and computeds are cheap. The
// alternative — per-key atoms — would be lower-cardinality reactivity at the
// cost of a much wider API surface; we don't need it.
//
// Outside a reactive context (the common case: ad-hoc gets from the segments
// renderer), atom.reportObserved is a no-op. Tests that construct SessionState
// without any observer see no change in behavior.

import { createAtom, type IAtom, runInAction } from "mobx";

export interface SessionStateReader {
  get(sessionId: string, key: string): string | null;
}

// [LAW:locality-or-seam] Renderer needs to *cache* per-session random picks
// so subsequent renders are stable. Writing them back into the same store
// click verbs use keeps state in one place — no parallel cache to drift.
//
// setBatch commits multiple (key, value) pairs as a single reactive
// transaction: observers fire ONCE after every pair has landed, never
// between pairs. The set-state verb's batched-pair URL (a Menu click that
// writes the chosen value AND collapses the menu) depends on this — if
// observers saw the first write before the second, an autorun could
// render half-applied state. The atomicity contract lives in the seam,
// not in each consumer. [LAW:single-enforcer]
export interface SessionStateRW extends SessionStateReader {
  set(sessionId: string, key: string, value: string): void;
  setBatch(
    sessionId: string,
    pairs: ReadonlyArray<{ key: string; value: string }>,
  ): void;
  clear(sessionId: string, key: string): void;
}

// Flat, JSON-shaped mirror of the store: sessionId → key → value. This is the
// on-disk representation and the load/save currency between store and storage.
export type SessionSnapshot = Record<string, Record<string, string>>;

// [LAW:locality-or-seam] The store depends on this seam, not on the filesystem.
// The daemon injects a disk-backed impl; tests and non-daemon callers get the
// ephemeral default. Persistence is a property of the *storage*, not the store.
export interface SessionStorage {
  load(): SessionSnapshot;
  save(snapshot: SessionSnapshot): void;
  flush(): void;
}

// [LAW:dataflow-not-control-flow] Null-object so the store always calls
// save()/flush() — no "am I persisting?" branch. The ephemeral case is data
// (a storage that discards), not a special control path.
const EPHEMERAL_STORAGE: SessionStorage = {
  load: () => ({}),
  save: () => {},
  flush: () => {},
};

function hydrate(snapshot: SessionSnapshot): Map<string, Map<string, string>> {
  const sessions = new Map<string, Map<string, string>>();
  for (const [sessionId, kv] of Object.entries(snapshot)) {
    sessions.set(sessionId, new Map(Object.entries(kv)));
  }
  return sessions;
}

// Generous headroom over realistic concurrent-session counts; matches the
// render cache's LRU bound. Active sessions stay hot via get-promotion, so only
// genuinely-idle sessions are ever evicted — eviction *is* "drop dead sessions".
const DEFAULT_MAX_SESSIONS = 256;

export class SessionState implements SessionStateReader, SessionStateRW {
  // [LAW:types-are-the-program] Insertion order is recency order: the store
  // cannot hold more than maxSessions, so "bounded on disk" is structural, not
  // dependent on an external prune caller.
  private sessions: Map<string, Map<string, string>>;
  private storage: SessionStorage;
  // [LAW:single-enforcer] One atom; every read reports observed against it,
  // every mutation reports changed. Coarse-grained reactivity is correct for
  // session-state's load — mutations are rare and computeds are cheap.
  private readonly atom: IAtom = createAtom("SessionState");

  constructor(
    storage: SessionStorage = EPHEMERAL_STORAGE,
    private readonly maxSessions: number = DEFAULT_MAX_SESSIONS,
  ) {
    this.storage = storage;
    this.sessions = new Map();
    this.hydrateFromStorage();
  }

  // [LAW:single-enforcer] Bind a persistence backend after construction. Only
  // the daemon process calls this (with the disk-backed storage), so importers
  // that merely load this module — the CLI relay, subcommands — keep the
  // ephemeral default and never read or write the state file. Must run before
  // the daemon serves requests, since it replaces in-memory state with disk.
  useStorage(storage: SessionStorage): void {
    this.storage = storage;
    this.hydrateFromStorage();
  }

  private hydrateFromStorage(): void {
    this.sessions = hydrate(this.storage.load());
    this.evictOldest();
    // [LAW:dataflow-not-control-flow] The disk mirror always reflects the built
    // in-memory state. An over-cap file trimmed by evictOldest is written back
    // here, so the on-disk bound holds even if no mutation ever follows.
    this.persist();
  }

  get(sessionId: string, key: string): string | null {
    // [LAW:single-enforcer] reportObserved is the reactive-dep registration —
    // outside a tracking context (the common direct-read case) it is a no-op.
    this.atom.reportObserved();
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    // [LAW:dataflow-not-control-flow] A read promotes recency but never
    // triggers a disk write itself; the reordered insertion order only reaches
    // disk if a later mutation persists.
    this.touch(sessionId, session);
    return session.get(key) ?? null;
  }

  // [LAW:one-source-of-truth] set is the degenerate single-pair form of
  // setBatch — one write path through the store. The previous shape (a
  // standalone set body) split the write semantics across two routes
  // once setBatch was introduced; collapsing keeps mutation, persistence,
  // and notification in exactly one place.
  set(sessionId: string, key: string, value: string): void {
    this.setBatch(sessionId, [{ key, value }]);
  }

  // [LAW:no-silent-fallbacks] Atomic commit of N pairs: every write
  // lands BEFORE the single reportChanged() that scheduler-visibly
  // marks the transaction complete. Observers cannot see an
  // intermediate "half-applied" snapshot — `runInAction` defers
  // reaction scheduling until the outermost call exits, and we hold
  // ALL writes inside this one block. Previously, the verb's "loop and
  // call set N times" pattern fired reportChanged() N times, which
  // scheduled autoruns between pairs (visible to consumers as the menu
  // value changing while toolbar-expanded was still old). The batch
  // method is the structural fix: there is no way to get half-applied
  // state because there is no intermediate scheduler tick.
  //
  // [LAW:dataflow-not-control-flow] An empty pairs array is no-work-
  // to-do, returned without firing reportChanged or persisting. The
  // verb body validates that pairs is non-empty before calling, so
  // this is the public-API safety net rather than the hot path.
  setBatch(
    sessionId: string,
    pairs: ReadonlyArray<{ key: string; value: string }>,
  ): void {
    if (pairs.length === 0) return;
    runInAction(() => {
      const session = this.sessions.get(sessionId) ?? new Map<string, string>();
      for (const { key, value } of pairs) session.set(key, value);
      this.touch(sessionId, session);
      this.evictOldest();
      this.persist();
      this.atom.reportChanged();
    });
  }

  clear(sessionId: string, key: string): void {
    runInAction(() => {
      const session = this.sessions.get(sessionId);
      if (session) {
        session.delete(key);
        // An emptied session is a non-state — drop it so it neither occupies a
        // cap slot nor persists as a `{ "sid": {} }` husk. [LAW:one-source-of-truth]
        // A surviving session is promoted: every interaction is a recency signal,
        // uniform with get()/set(). [LAW:one-type-per-behavior]
        if (session.size === 0) this.sessions.delete(sessionId);
        else this.touch(sessionId, session);
      }
      this.persist();
      this.atom.reportChanged();
    });
  }

  // [LAW:one-source-of-truth] Drop state for sessions that no longer exist.
  prune(activeSessionIds: Set<string>): void {
    runInAction(() => {
      for (const id of this.sessions.keys()) {
        if (!activeSessionIds.has(id)) this.sessions.delete(id);
      }
      this.persist();
      this.atom.reportChanged();
    });
  }

  // Move-to-end: re-inserting at the tail makes this the most-recently-used.
  private touch(sessionId: string, session: Map<string, string>): void {
    this.sessions.delete(sessionId);
    this.sessions.set(sessionId, session);
  }

  private evictOldest(): void {
    let overflow = this.sessions.size - this.maxSessions;
    if (overflow <= 0) return;
    // Delete the oldest keys in insertion order. Cost is proportional to the
    // number of evictions, not the total loaded set — deleting an already-
    // yielded key mid-iteration is well-defined for a Map.
    for (const id of this.sessions.keys()) {
      this.sessions.delete(id);
      if (--overflow === 0) break;
    }
  }

  // Synchronous write of any debounced-pending snapshot. Called on daemon
  // shutdown so a pending pick isn't lost when the process exits.
  flush(): void {
    this.storage.flush();
  }

  private persist(): void {
    this.storage.save(this.serialize());
  }

  private serialize(): SessionSnapshot {
    // [LAW:types-are-the-program] sessionIds are external (hook JSON / click
    // URLs). A null-prototype root makes "__proto__"/"constructor" ordinary
    // own keys instead of prototype-mutation vectors — pollution is
    // unrepresentable rather than guarded against.
    const snapshot = Object.create(null) as SessionSnapshot;
    for (const [sessionId, kv] of this.sessions) {
      snapshot[sessionId] = Object.fromEntries(kv);
    }
    return snapshot;
  }
}

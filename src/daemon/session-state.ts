// [LAW:one-type-per-behavior] One generic store for all per-session state.
// Adding a new per-session value is just picking a string key — no new class,
// no DI wiring, no cache invalidation.

export interface SessionStateReader {
  get(sessionId: string, key: string): string | null;
}

// [LAW:locality-or-seam] Renderer needs to *cache* per-session random picks
// so subsequent renders are stable. Writing them back into the same store
// theme-cycle uses keeps state in one place — no parallel cache to drift.
export interface SessionStateRW extends SessionStateReader {
  set(sessionId: string, key: string, value: string): void;
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
  private readonly sessions: Map<string, Map<string, string>>;

  constructor(
    private readonly storage: SessionStorage = EPHEMERAL_STORAGE,
    private readonly maxSessions: number = DEFAULT_MAX_SESSIONS,
  ) {
    this.sessions = hydrate(storage.load());
    this.evictOldest();
    // [LAW:dataflow-not-control-flow] The disk mirror always reflects the built
    // in-memory state. An over-cap file trimmed by evictOldest is written back
    // here, so the on-disk bound holds even if no mutation ever follows.
    this.persist();
  }

  get(sessionId: string, key: string): string | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    // [LAW:dataflow-not-control-flow] A read promotes recency but never
    // triggers a disk write itself; the reordered insertion order only reaches
    // disk if a later mutation persists.
    this.touch(sessionId, session);
    return session.get(key) ?? null;
  }

  set(sessionId: string, key: string, value: string): void {
    const session = this.sessions.get(sessionId) ?? new Map<string, string>();
    session.set(key, value);
    this.touch(sessionId, session);
    this.evictOldest();
    this.persist();
  }

  clear(sessionId: string, key: string): void {
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
  }

  // [LAW:one-source-of-truth] Drop state for sessions that no longer exist.
  prune(activeSessionIds: Set<string>): void {
    for (const id of this.sessions.keys()) {
      if (!activeSessionIds.has(id)) this.sessions.delete(id);
    }
    this.persist();
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

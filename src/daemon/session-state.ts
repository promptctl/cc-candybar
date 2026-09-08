// [LAW:one-type-per-behavior] One generic store for all per-session state: a new value is just a key.
// [LAW:single-enforcer] Reads are MobX-tracked through one internal atom — coarse-grained on purpose.

import { createAtom, type IAtom, runInAction } from "mobx";

export interface SessionStateReader {
  get(sessionId: string, key: string): string | null;
}

// [LAW:locality-or-seam] Per-session render picks live in the same store click verbs use — no parallel cache to drift.
// [LAW:single-enforcer] setBatch commits N pairs as one reactive transaction, so observers never see half-applied state.
export interface SessionStateRW extends SessionStateReader {
  set(sessionId: string, key: string, value: string): void;
  setBatch(
    sessionId: string,
    pairs: ReadonlyArray<{ key: string; value: string }>,
  ): void;
  clear(sessionId: string, key: string): void;
}

export type SessionSnapshot = Record<string, Record<string, string>>;

// [LAW:locality-or-seam] Persistence is a property of the *storage*, not the store.
export interface SessionStorage {
  load(): SessionSnapshot;
  save(snapshot: SessionSnapshot): void;
  flush(): void;
}

// [LAW:dataflow-not-control-flow] Null-object so the store always calls save()/flush() — no "am I persisting?" branch.
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

const DEFAULT_MAX_SESSIONS = 256;

export class SessionState implements SessionStateReader, SessionStateRW {
  // [LAW:types-are-the-program] Insertion order is recency order, so "bounded on disk" is structural.
  private sessions: Map<string, Map<string, string>>;
  private storage: SessionStorage;
  private readonly atom: IAtom = createAtom("SessionState");

  constructor(
    storage: SessionStorage = EPHEMERAL_STORAGE,
    private readonly maxSessions: number = DEFAULT_MAX_SESSIONS,
  ) {
    this.storage = storage;
    this.sessions = new Map();
    this.hydrateFromStorage();
  }

  // [LAW:single-enforcer] Must run before the daemon serves requests: it replaces in-memory state with disk.
  useStorage(storage: SessionStorage): void {
    this.storage = storage;
    this.hydrateFromStorage();
  }

  private hydrateFromStorage(): void {
    this.sessions = hydrate(this.storage.load());
    this.evictOldest();
    // [LAW:dataflow-not-control-flow] An over-cap file trimmed here is written back, so the bound holds with no later mutation.
    this.persist();
  }

  get(sessionId: string, key: string): string | null {
    this.atom.reportObserved();
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    // [LAW:dataflow-not-control-flow] A read promotes recency but never writes to disk itself.
    this.touch(sessionId, session);
    return session.get(key) ?? null;
  }

  // [LAW:one-source-of-truth] set is the degenerate single-pair form of setBatch — one write path.
  set(sessionId: string, key: string, value: string): void {
    this.setBatch(sessionId, [{ key, value }]);
  }

  // [LAW:no-silent-fallbacks] Every write lands before the single reportChanged(), so no observer
  // can see a half-applied snapshot. [LAW:dataflow-not-control-flow] Empty pairs is no work to do.
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
        // An emptied session is a non-state — drop the husk. [LAW:one-source-of-truth]
        // A surviving session is promoted: every interaction is a recency signal. [LAW:one-type-per-behavior]
        if (session.size === 0) this.sessions.delete(sessionId);
        else this.touch(sessionId, session);
      }
      this.persist();
      this.atom.reportChanged();
    });
  }

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
    // Deleting an already-yielded key mid-iteration is well-defined for a Map.
    for (const id of this.sessions.keys()) {
      this.sessions.delete(id);
      if (--overflow === 0) break;
    }
  }

  flush(): void {
    this.storage.flush();
  }

  private persist(): void {
    this.storage.save(this.serialize());
  }

  private serialize(): SessionSnapshot {
    // [LAW:types-are-the-program] A null-prototype root makes "__proto__" an ordinary own key, so pollution is unrepresentable.
    const snapshot = Object.create(null) as SessionSnapshot;
    for (const [sessionId, kv] of this.sessions) {
      snapshot[sessionId] = Object.fromEntries(kv);
    }
    return snapshot;
  }
}

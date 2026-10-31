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
  // The store's revision when this session's state last changed — a write
  // of a value it did not hold, a clear of a key it did — or 0 while it holds
  // none. Two reads that return one revision read one state, whoever wrote it.
  revision(sessionId: string): number;
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

// [LAW:one-source-of-truth] A view of `store` that reports, once a write has
// landed, each key it touched that `records` admits — its value before the
// write and what the store then reads — so a write that throws reports
// nothing. Both click histories (settings and navigation) journal through it,
// differing only in the keys they keep and what they fold a change into.
export function recordingView(
  store: SessionStateRW,
  records: (key: string) => boolean,
  onChange: (
    sessionId: string,
    key: string,
    before: string | null,
    after: string | null,
  ) => void,
): SessionStateRW {
  const recorded = (
    sessionId: string,
    keys: readonly string[],
    write: () => void,
  ): void => {
    const before = keys
      .filter(records)
      .map((key) => ({ key, before: store.get(sessionId, key) }));
    write();
    for (const { key, before: b } of before) {
      onChange(sessionId, key, b, store.get(sessionId, key));
    }
  };
  return {
    get: (sessionId, key) => store.get(sessionId, key),
    revision: (sessionId) => store.revision(sessionId),
    set: (sessionId, key, value) =>
      recorded(sessionId, [key], () => store.set(sessionId, key, value)),
    setBatch: (sessionId, pairs) =>
      recorded(
        sessionId,
        pairs.map((p) => p.key),
        () => store.setBatch(sessionId, pairs),
      ),
    clear: (sessionId, key) =>
      recorded(sessionId, [key], () => store.clear(sessionId, key)),
  };
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
export const EPHEMERAL_SESSION_STORAGE: SessionStorage = {
  load: () => ({}),
  save: () => {},
  flush: () => {},
};

// One session's state, and the store's revision when it last changed.
// [LAW:one-source-of-truth] The revision lives on the entry it describes, so a
// session the store drops takes its revision with it.
interface Session {
  readonly values: Map<string, string>;
  revision: number;
}

// Generous headroom over realistic concurrent-session counts; matches the
// render cache's LRU bound. Active sessions stay hot via get-promotion, so only
// genuinely-idle sessions are ever evicted — eviction *is* "drop dead sessions".
const DEFAULT_MAX_SESSIONS = 256;

export class SessionState implements SessionStateReader, SessionStateRW {
  // [LAW:types-are-the-program] Insertion order is recency order: the store
  // cannot hold more than maxSessions, so "bounded on disk" is structural, not
  // dependent on an external prune caller.
  private sessions: Map<string, Session>;
  private storage: SessionStorage;
  // [LAW:single-enforcer] The store's revision: counts every change any
  // writer makes, so it never repeats while the store lives.
  private head = 0;
  // [LAW:single-enforcer] One atom; every read reports observed against it,
  // every mutation reports changed. Coarse-grained reactivity is correct for
  // session-state's load — mutations are rare and computeds are cheap.
  private readonly atom: IAtom = createAtom("SessionState");

  constructor(
    storage: SessionStorage = EPHEMERAL_SESSION_STORAGE,
    private readonly maxSessions: number = DEFAULT_MAX_SESSIONS,
  ) {
    this.storage = storage;
    this.sessions = new Map();
    this.hydrateFromStorage();
  }

  private hydrateFromStorage(): void {
    this.sessions = new Map(
      Object.entries(this.storage.load()).map(([sessionId, kv]) => [
        sessionId,
        { values: new Map(Object.entries(kv)), revision: ++this.head },
      ]),
    );
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
    return session.values.get(key) ?? null;
  }

  revision(sessionId: string): number {
    this.atom.reportObserved();
    return this.sessions.get(sessionId)?.revision ?? 0;
  }

  // How many derivations are subscribed to this store right now — every
  // computed that read session state and has not been released. Live configs
  // keep a bounded number; a count that climbs while the render cache does not
  // is a disposed store still held (brandon-unfiled-3248.t14 was found in a
  // heap snapshot because nothing reported this). [LAW:nothing-unseen]
  // The atom's own observer set (`IDepTreeNode.observers_`, the field MobX's
  // dependency-tree API reads), `null` once nothing observes it. The other
  // public view, `getObserverTree`, materialises the whole recursive tree —
  // one node per observer per path — to answer this direct count, on the
  // daemon's request thread.
  observers(): number {
    return this.atom.observers_?.size ?? 0;
  }

  // The store's revision: how many changes any writer has made to it.
  latestRevision(): number {
    return this.head;
  }

  // How many sessions the store holds.
  size(): number {
    return this.sessions.size;
  }

  // [LAW:one-source-of-truth] set is the degenerate single-pair form of
  // setBatch — one write path through the store. The previous shape (a
  // standalone set body) split the write semantics across two routes
  // once setBatch was introduced; collapsing keeps mutation, persistence,
  // and notification in exactly one place.
  set(sessionId: string, key: string, value: string): void {
    this.setBatch(sessionId, [{ key, value }]);
  }

  // [LAW:no-silent-failure] Atomic commit of N pairs: every write
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
      const session = this.sessions.get(sessionId) ?? {
        values: new Map<string, string>(),
        revision: 0,
      };
      if (pairs.some(({ key, value }) => session.values.get(key) !== value))
        session.revision = ++this.head;
      for (const { key, value } of pairs) session.values.set(key, value);
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
        if (session.values.delete(key)) session.revision = ++this.head;
        // An emptied session is a non-state — drop it so it neither occupies a
        // cap slot nor persists as a `{ "sid": {} }` husk. [LAW:one-source-of-truth]
        // A surviving session is promoted: every interaction is a recency signal,
        // uniform with get()/set(). [LAW:one-type-per-behavior]
        if (session.values.size === 0) this.sessions.delete(sessionId);
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
  private touch(sessionId: string, session: Session): void {
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

  // [LAW:no-ambient-temporal-coupling] The daemon's close: what is pending
  // lands, and anything that lands later (a render that was awaiting, a run
  // settling) stays in memory, so it can never write over the file a next
  // daemon has taken up.
  close(): void {
    this.flush();
    this.storage = EPHEMERAL_SESSION_STORAGE;
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
    for (const [sessionId, { values }] of this.sessions) {
      snapshot[sessionId] = Object.fromEntries(values);
    }
    return snapshot;
  }
}

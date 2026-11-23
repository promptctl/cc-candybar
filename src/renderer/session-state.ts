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
import type { SessionId } from "../daemon/foundations/session-id";
import type { RendererStats } from "../renderer-interface/renderer-stats";
import type {
  SessionStateReader,
  SessionStateRW,
} from "../renderer-interface/session-state";
import type {
  StoredState,
  StoreWrite,
} from "../renderer-interface/stored-state";

// [LAW:one-source-of-truth] A view of `store` that reports, once a write has
// landed, each key it touched that `records` admits — its value before the
// write and what the store then reads — so a write that throws reports
// nothing. Both click histories (settings and navigation) journal through it,
// differing only in the keys they keep and what they fold a change into.
export function recordingView(
  store: SessionStateRW,
  records: (key: string) => boolean,
  onChange: (
    sessionId: SessionId,
    key: string,
    before: string | null,
    after: string | null,
  ) => void,
): SessionStateRW {
  const recorded = (
    sessionId: SessionId,
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

// One session's state, and the store's revision when it last changed.
// [LAW:one-source-of-truth] The revision lives on the entry it describes, so a
// session the store drops takes its revision with it.
interface Session {
  readonly values: Map<string, string>;
  revision: number;
}

// Generous headroom over realistic concurrent-session counts; matches the
// render cache's LRU bound. Only a session no click has written to for longest
// is ever evicted — eviction *is* "drop dead sessions".
const DEFAULT_MAX_SESSIONS = 256;

export class SessionState implements SessionStateReader, SessionStateRW {
  // [LAW:types-are-the-program] Insertion order is recency order, the order
  // of writes: the store cannot hold more than maxSessions, so the bound is
  // structural, not dependent on an external prune caller. A read moves
  // nothing, so the host's copy, which hears only writes, keeps the same order.
  private readonly sessions: Map<SessionId, Session>;
  // [LAW:one-source-of-truth] The sessions whose state moved since the host
  // was last told, in the order they last moved: what the turn's stored
  // writes carry (`drain`).
  private readonly moved = new Set<SessionId>();
  // [LAW:single-enforcer] The store's revision: counts every change any
  // writer makes, so it never repeats while the store lives.
  private head = 0;
  // [LAW:single-enforcer] One atom; every read reports observed against it,
  // every mutation reports changed. Coarse-grained reactivity is correct for
  // session-state's load — mutations are rare and computeds are cheap.
  private readonly atom: IAtom = createAtom("SessionState");

  // `loaded` is what the profile holds, oldest first, as the host handed it in.
  constructor(
    loaded: StoredState["sessions"] = {},
    private readonly maxSessions: number = DEFAULT_MAX_SESSIONS,
  ) {
    this.sessions = new Map(
      (
        Object.entries(loaded) as Array<
          [SessionId, Readonly<Record<string, string>>]
        >
      ).map(([id, kv]): [SessionId, Session] => [
        id,
        { values: new Map(Object.entries(kv)), revision: ++this.head },
      ]),
    );
    // A profile over the bound loses its oldest at once, and the host hears
    // it with the first turn's writes.
    this.evictOldest();
  }

  get(sessionId: SessionId, key: string): string | null {
    // [LAW:single-enforcer] reportObserved is the reactive-dep registration —
    // outside a tracking context (the common direct-read case) it is a no-op.
    this.atom.reportObserved();
    return this.sessions.get(sessionId)?.values.get(key) ?? null;
  }

  revision(sessionId: SessionId): number {
    this.atom.reportObserved();
    return this.sessions.get(sessionId)?.revision ?? 0;
  }

  // How many derivations are subscribed to this store right now — every
  // computed that read session state and has not been released. Live configs
  // keep a bounded number; a count that climbs while the render cache does not
  // is a disposed store still held, which nothing else would show short of a
  // heap snapshot. [LAW:nothing-unseen]
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

  stats(): RendererStats["sessionState"] {
    return {
      sessions: this.size(),
      observers: this.observers(),
      revision: this.latestRevision(),
    };
  }

  // [LAW:one-source-of-truth] set is the degenerate single-pair form of
  // setBatch — one write path through the store.
  set(sessionId: SessionId, key: string, value: string): void {
    this.setBatch(sessionId, [{ key, value }]);
  }

  // [LAW:no-silent-failure] Atomic commit of N pairs: every write lands
  // BEFORE the single reportChanged() that marks the transaction complete, so
  // no observer sees half of it. A batch that writes only values already held
  // changes nothing, and moves no session in the recency order.
  setBatch(
    sessionId: SessionId,
    pairs: ReadonlyArray<{ key: string; value: string }>,
  ): void {
    const held = this.sessions.get(sessionId);
    if (!pairs.some(({ key, value }) => held?.values.get(key) !== value))
      return;
    runInAction(() => {
      const session = held ?? {
        values: new Map<string, string>(),
        revision: 0,
      };
      for (const { key, value } of pairs) session.values.set(key, value);
      this.changed(sessionId, session);
      this.evictOldest();
      this.atom.reportChanged();
    });
  }

  clear(sessionId: SessionId, key: string): void {
    const session = this.sessions.get(sessionId);
    if (session === undefined || !session.values.has(key)) return;
    runInAction(() => {
      session.values.delete(key);
      // An emptied session is a non-state — drop it so it neither occupies a
      // cap slot nor persists as a `{ "sid": {} }` husk. [LAW:one-source-of-truth]
      if (session.values.size === 0) this.dropped(sessionId);
      else this.changed(sessionId, session);
      this.atom.reportChanged();
    });
  }

  // What the host has not yet been told: each session that moved, as it now
  // stands, null for one dropped, in the order they last moved, so the host's
  // copy keeps this store's recency order.
  drain(): StoreWrite[] {
    const writes = [...this.moved].map(
      (key): StoreWrite => ({
        store: "session-state",
        key,
        value: this.valuesOf(key),
      }),
    );
    this.moved.clear();
    return writes;
  }

  private valuesOf(sessionId: SessionId): Record<string, string> | null {
    const session = this.sessions.get(sessionId);
    return session === undefined ? null : Object.fromEntries(session.values);
  }

  // Move-to-end: re-inserting at the tail makes this the most recently
  // written, here and in what the host is told.
  private changed(sessionId: SessionId, session: Session): void {
    session.revision = ++this.head;
    this.sessions.delete(sessionId);
    this.sessions.set(sessionId, session);
    this.told(sessionId);
  }

  private dropped(sessionId: SessionId): void {
    this.head++;
    this.sessions.delete(sessionId);
    this.told(sessionId);
  }

  private told(sessionId: SessionId): void {
    this.moved.delete(sessionId);
    this.moved.add(sessionId);
  }

  private evictOldest(): void {
    let overflow = this.sessions.size - this.maxSessions;
    if (overflow <= 0) return;
    // Delete the oldest keys in insertion order. Cost is proportional to the
    // number of evictions, not the total loaded set — deleting an already-
    // yielded key mid-iteration is well-defined for a Map.
    for (const id of this.sessions.keys()) {
      this.dropped(id);
      if (--overflow === 0) break;
    }
  }
}

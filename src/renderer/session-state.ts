import { createAtom, observable, runInAction } from "mobx";
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
import { putNewest, toNewest } from "../utils/recency";
import { StoredMoves } from "./stored-moves";
import { withoutRetiredKeys } from "../renderer-interface/stored-state";

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

// [LAW:types-are-the-program] A checked session ID cannot contain a slash.
// The first slash separates it from an arbitrary, possibly empty, pick key.
const pickAddress = (sessionId: SessionId, key: string): string =>
  `${sessionId}/${key}`;

// Generous headroom over realistic concurrent-session counts; matches the
// render cache's LRU bound. Only a session no click has written to for longest
// is ever evicted — eviction *is* "drop dead sessions".
const DEFAULT_MAX_SESSIONS = 256;

export class SessionState implements SessionStateReader, SessionStateRW {
  // [LAW:types-are-the-program] Insertion order is recency order, the order
  // each session was last written or heard by a request: the store cannot
  // hold more than maxSessions, so the bound is structural, not dependent on
  // an external prune caller, and drops the session idle longest. A read
  // moves nothing, so the host's copy, told of every move, keeps the order.
  private readonly sessions = new Map<SessionId, Set<string>>();
  // [LAW:one-source-of-truth] Each pick has one observable address, even
  // before it exists. The recency index holds only its session's key names
  // for eviction and persistence. An unrelated insertion cannot wake it.
  private readonly picks = observable.map<string, string>(undefined, {
    deep: false,
  });
  private readonly revisions = observable.map<SessionId, number>(undefined, {
    deep: false,
  });
  private readonly moved = new StoredMoves();
  // [LAW:single-enforcer] The store's revision: counts every change any
  // writer makes, so it never repeats while the store lives.
  private head = 0;
  // [LAW:nothing-unseen] One subscription per distinct reader for the
  // disposal diagnostic, even when that reader observes several pick keys.
  // Only the pick and revision observables invalidate reads.
  private readonly readers = createAtom("SessionState readers");

  // `loaded` is what the profile holds, oldest first, as the host handed it in.
  constructor(
    loaded: StoredState["sessions"] = {},
    private readonly maxSessions: number = DEFAULT_MAX_SESSIONS,
  ) {
    runInAction(() => {
      for (const [id, values] of Object.entries(loaded) as Array<
        [SessionId, Readonly<Record<string, string>>]
      >) {
        this.sessions.set(id, new Set(Object.keys(values)));
        for (const [key, value] of Object.entries(values))
          this.picks.set(pickAddress(id, key), value);
        this.revisions.set(id, ++this.head);
      }
      this.evictOldest();
    });
  }

  get(sessionId: SessionId, key: string): string | null {
    this.readers.reportObserved();
    return this.picks.get(pickAddress(sessionId, key)) ?? null;
  }

  revision(sessionId: SessionId): number {
    this.readers.reportObserved();
    return this.revisions.get(sessionId) ?? 0;
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
    return this.readers.observers_?.size ?? 0;
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
  // in one MobX action, so
  // no observer sees half of it. A batch that writes only values already held
  // changes nothing, and moves no session in the recency order.
  setBatch(
    sessionId: SessionId,
    pairs: ReadonlyArray<{ key: string; value: string }>,
  ): void {
    runInAction(() => {
      const keys = this.sessions.get(sessionId) ?? new Set<string>();
      let moved = false;
      for (const { key, value } of pairs) {
        const address = pickAddress(sessionId, key);
        if (this.picks.get(address) === value) continue;
        this.picks.set(address, value);
        keys.add(key);
        moved = true;
      }
      if (moved) {
        this.changed(sessionId, keys);
        this.evictOldest();
      }
    });
  }

  clear(sessionId: SessionId, key: string): void {
    const keys = this.sessions.get(sessionId);
    if (keys === undefined || !keys.has(key)) return;
    runInAction(() => {
      this.picks.delete(pickAddress(sessionId, key));
      keys.delete(key);
      if (keys.size === 0) this.dropped(sessionId, keys);
      else this.changed(sessionId, keys);
    });
  }

  // A request from the session: it moves to the newest end, so the bound
  // drops the session idle longest. What it holds is unchanged, so no reader
  // is told, and the host hears only its place.
  heard(sessionId: SessionId): void {
    if (toNewest(this.sessions, sessionId)) this.moved.heard(sessionId);
  }

  // What the host has not yet been told: each session that moved, as it now
  // stands (null for one dropped) or only its place, in the order they last
  // moved.
  drain(): StoreWrite[] {
    return this.moved.drain(
      (key, moved): StoreWrite =>
        moved === "heard"
          ? { kind: "heard", store: "session-state", key }
          : {
              kind: "put",
              store: "session-state",
              key,
              value: this.valuesOf(key),
            },
    );
  }

  // [LAW:single-enforcer] What the host keeps of a session is what a load of
  // its file keeps, so the file never holds a pick only this renderer reads
  // (edit mode's own), and a load that drops one is reading an older build's.
  private valuesOf(sessionId: SessionId): Record<string, string> | null {
    const keys = this.sessions.get(sessionId);
    if (keys === undefined) return null;
    const values = Object.fromEntries(
      Array.from(keys, (key) => [
        key,
        this.picks.get(pickAddress(sessionId, key))!,
      ]),
    );
    const outlives = withoutRetiredKeys(values);
    return outlives.kind === "ok" ? outlives.value.value : null;
  }

  // Move-to-end: re-inserting at the tail makes this the most recently
  // written, here and in what the host is told.
  private changed(sessionId: SessionId, keys: Set<string>): void {
    this.revisions.set(sessionId, ++this.head);
    putNewest(this.sessions, sessionId, keys);
    this.told(sessionId);
  }

  private dropped(sessionId: SessionId, keys: ReadonlySet<string>): void {
    this.head++;
    for (const key of keys) this.picks.delete(pickAddress(sessionId, key));
    this.revisions.delete(sessionId);
    this.sessions.delete(sessionId);
    this.told(sessionId);
  }

  private told(sessionId: SessionId): void {
    this.moved.put(sessionId);
  }

  private evictOldest(): void {
    let overflow = this.sessions.size - this.maxSessions;
    if (overflow <= 0) return;
    // Delete the oldest keys in insertion order. Cost is proportional to the
    // number of evictions, not the total loaded set — deleting an already-
    // yielded key mid-iteration is well-defined for a Map.
    for (const [id, keys] of this.sessions) {
      this.dropped(id, keys);
      if (--overflow === 0) break;
    }
  }
}

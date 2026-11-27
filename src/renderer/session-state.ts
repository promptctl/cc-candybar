import { createAtom, observable, runInAction } from "mobx";
import type { SessionId } from "../daemon/foundations/session-id";
import type { RendererStats } from "../renderer-interface/renderer-stats";
import type {
  SessionStateReader,
  SessionStateRW,
} from "../renderer-interface/session-state";
import type {
  StoredState,
  ProfileWrite,
} from "../renderer-interface/stored-state";
import { RecencyMap } from "../utils/recency";
import { MAX_PICK_SESSIONS } from "../renderer-interface/session-capacity.js";
import { StoredMoves } from "./stored-moves";

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

export class SessionState implements SessionStateReader, SessionStateRW {
  // Recency is a local eviction policy only for standalone stores and
  // historical recordings. A live peer takes removals from its host.
  private readonly sessions = new RecencyMap<SessionId, Set<string>>();
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
  private readonly edits = new Map<SessionId, Map<string, string | null>>();
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
    private readonly maxSessions: number | "host" = MAX_PICK_SESSIONS,
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
    this.patch(sessionId, pairs, true);
  }

  clear(sessionId: SessionId, key: string): void {
    this.patch(sessionId, [{ key, value: null }], true);
  }

  // [LAW:effects-at-boundaries] A peer observes decisions that the host
  // has already admitted. Updating its read projection authors no writes.
  observe(
    write:
      | Extract<ProfileWrite, { store: "session-state" }>
      | { kind: "heard"; key: SessionId },
  ): void {
    if (write.kind === "heard") {
      this.sessions.touch(write.key);
    } else if (write.kind === "drop") {
      const keys = this.sessions.get(write.key);
      if (keys) this.dropped(write.key, keys, false);
    } else {
      this.patch(
        write.key,
        Object.entries(write.changes).map(([key, value]) => ({ key, value })),
        false,
      );
    }
  }

  private patch(
    sessionId: SessionId,
    pairs: ReadonlyArray<{ key: string; value: string | null }>,
    authored: boolean,
  ): void {
    runInAction(() => {
      const keys = this.sessions.get(sessionId) ?? new Set<string>();
      let moved = false;
      for (const { key, value } of pairs) {
        const address = pickAddress(sessionId, key);
        if ((this.picks.get(address) ?? null) === value) continue;
        if (value === null) {
          this.picks.delete(address);
          keys.delete(key);
        } else {
          this.picks.set(address, value);
          keys.add(key);
        }
        if (authored) this.edited(sessionId, key, value);
        moved = true;
      }
      if (moved) {
        if (!keys.size) this.dropped(sessionId, keys, authored);
        else {
          this.revisions.set(sessionId, ++this.head);
          this.sessions.set(sessionId, keys);
          if (authored) this.moved.put(sessionId);
        }
        if (authored) this.evictOldest();
      } else if (!authored) {
        this.sessions.touch(sessionId);
      }
    });
  }

  // A historical or standalone request promotes its session without
  // invalidating pick readers. The live host admits its own requests.
  heard(sessionId: SessionId): void {
    if (this.maxSessions !== "host" && this.sessions.touch(sessionId))
      this.moved.heard(sessionId);
  }

  // [LAW:dataflow-not-control-flow] Coalesce writes to a key before crossing
  // the wire. Recency is the order of each session's last move, even when
  // several sessions were edited and one was heard again.
  drain(): ProfileWrite[] {
    const writes = this.moved.drain((key, move): ProfileWrite => {
      if (move === "heard")
        return { kind: "heard", store: "session-state", key };
      if (this.maxSessions !== "host" && !this.sessions.has(key))
        return { kind: "drop", store: "session-state", key };
      return {
        kind: "patch",
        store: "session-state",
        key,
        changes: Object.fromEntries(this.edits.get(key)!),
      };
    });
    this.edits.clear();
    return writes;
  }

  private edited(session: SessionId, key: string, value: string | null): void {
    let edits = this.edits.get(session);
    if (edits === undefined) {
      edits = new Map();
      this.edits.set(session, edits);
    }
    edits.set(key, value);
  }

  private dropped(
    sessionId: SessionId,
    keys: ReadonlySet<string>,
    authored: boolean,
  ): void {
    this.head++;
    for (const key of keys) {
      this.picks.delete(pickAddress(sessionId, key));
      // A session evicted then recreated in this turn still erases its old keys.
      if (authored) this.edited(sessionId, key, null);
    }
    this.revisions.delete(sessionId);
    this.sessions.delete(sessionId);
    if (authored) this.moved.put(sessionId);
  }

  private evictOldest(): void {
    while (
      this.maxSessions !== "host" &&
      this.sessions.size > this.maxSessions &&
      this.sessions.oldest !== undefined
    ) {
      const oldest = this.sessions.oldest;
      this.dropped(oldest, this.sessions.get(oldest)!, true);
    }
  }
}

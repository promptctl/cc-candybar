// [LAW:single-enforcer] The one seam where a placement's session keys gain
// their owner (src/config/placement-keys.ts), and the one release of the keys
// a load or a layout click ended.

import { runInAction } from "mobx";
import type { SessionId } from "../daemon/foundations/session-id";
import type {
  SessionStateReader,
  SessionStateRW,
} from "../renderer-interface/session-state";
import {
  classify,
  freeValue,
  ownedKey,
  ownedValue,
  type Holds,
  type Owner,
} from "../config/placement-keys";

// [LAW:locality-or-seam] `inner` as the chain `ownerOf` names reads and
// writes it: an owner-free family key, and a configure member written to the
// configure key, are mapped to their owned form; a configure member another
// owner holds reads as unset. Every other key, a key already owned among
// them, passes straight through, as do the revision and the key list.
export function ownedStore(
  inner: SessionStateRW,
  ownerOf: (sessionId: SessionId) => Owner,
): SessionStateRW {
  const key = (sessionId: SessionId, k: string): string =>
    ownedKey(k, () => ownerOf(sessionId));
  const pair = (
    sessionId: SessionId,
    { key: k, value }: { readonly key: string; readonly value: string },
  ) => ({
    key: key(sessionId, k),
    value: ownedValue(k, value, () => ownerOf(sessionId)),
  });
  return {
    get: (sessionId, k) =>
      freeValue(k, inner.get(sessionId, key(sessionId, k)), () =>
        ownerOf(sessionId),
      ),
    revision: (sessionId) => inner.revision(sessionId),
    keys: (sessionId) => inner.keys(sessionId),
    set: (sessionId, k, value) => {
      const p = pair(sessionId, { key: k, value });
      inner.set(sessionId, p.key, p.value);
    },
    setBatch: (sessionId, pairs) =>
      inner.setBatch(
        sessionId,
        pairs.map((p) => pair(sessionId, p)),
      ),
    clear: (sessionId, k) => inner.clear(sessionId, key(sessionId, k)),
  };
}

// [LAW:one-source-of-truth] Releases, in each of `sessions`, every key whose
// owner `holds` names and whose placement that owner no longer places, and
// every family key in a form naming no owner. Keys of any other owner, and
// keys no family spells, stay. `store` is read and cleared as it spells
// keys, owned: the raw store for a load, the click's journal for a click,
// so the click's undo restores what it released. One transaction. Returns
// what it released, one line for each session and owner, or one line saying
// it released nothing.
export function releaseEnded(
  store: Pick<SessionStateReader, "get" | "keys"> &
    Pick<SessionStateRW, "clear">,
  sessions: readonly SessionId[],
  holds: Holds,
  by: "load" | "click",
): readonly string[] {
  const lines: string[] = [];
  runInAction(() => {
    for (const sessionId of sessions) {
      // Each owner's released keys; `none` for keys naming no owner.
      const released = new Map<Owner | "none", string[]>();
      for (const key of store.keys(sessionId)) {
        const c = classify(key, () => store.get(sessionId, key));
        const ends =
          c.kind === "old" ||
          (c.kind === "owned" &&
            holds.get(c.owner)?.placed.has(c.member) === false);
        if (!ends) continue;
        const owner = c.kind === "owned" ? c.owner : "none";
        released.set(owner, [...(released.get(owner) ?? []), key]);
      }
      for (const [owner, keys] of released) {
        for (const key of keys) store.clear(sessionId, key);
        const chain =
          owner === "none"
            ? "-"
            : holds.get(owner)!.paths.join(",") || "<default>";
        lines.push(
          `placement-state released by=${by} session=${sessionId} owner=${owner} chain=${chain} keys=${keys.join(",")}`,
        );
      }
    }
  });
  // [LAW:nothing-unseen] A release that ended nothing says so.
  return lines.length > 0
    ? lines
    : [`placement-state released by=${by} sessions=${sessions.length} keys=0`];
}

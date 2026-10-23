// [LAW:single-enforcer] The one place a session write closes what is open
// inside the disclosure it closes (brandon-menus-sjhy.9p6): a view of a
// session store whose every write also returns each disclosure inside a
// closed one to its default, in the same transaction. Every verb writes
// through it (`journaled`, src/daemon/verbs/index.ts) — a click, ◁ back, a
// layout edit's release — and anything else that closes a menu (a timer that
// closes the door) gets the rule by writing through it too.

import { runInAction } from "mobx";
import {
  closeNested,
  type DisclosureNest,
  type StateWrite,
} from "../config/disclosure-nest";
import type { SessionStateRW } from "./session-state";

export function closingView(
  store: SessionStateRW,
  nestOf: (sessionId: string) => DisclosureNest,
  log: (line: string) => void,
): SessionStateRW {
  // The writes a batch adds, read before any of the batch lands.
  const foldsOf = (
    sessionId: string,
    writes: readonly StateWrite[],
  ): readonly StateWrite[] => {
    const folds = closeNested(
      nestOf(sessionId),
      (key) => store.get(sessionId, key),
      writes,
    );
    if (folds.length > 0) {
      const folded = folds.map((f) => f.key).join(",");
      log(`close-nested: folded=${folded} (session=${sessionId})`);
    }
    return folds;
  };
  const setBatch = (sessionId: string, pairs: readonly StateWrite[]): void => {
    store.setBatch(sessionId, [...pairs, ...foldsOf(sessionId, pairs)]);
  };
  return {
    get: (sessionId, key) => store.get(sessionId, key),
    revision: (sessionId) => store.revision(sessionId),
    set: (sessionId, key, value) => setBatch(sessionId, [{ key, value }]),
    setBatch,
    // A cleared key reads its default, so it closes what its old value held.
    clear: (sessionId, key) => {
      const value = nestOf(sessionId).defaultOf(key);
      const folds = foldsOf(sessionId, [{ key, value }]);
      runInAction(() => {
        store.clear(sessionId, key);
        if (folds.length > 0) store.setBatch(sessionId, folds);
      });
    },
  };
}

// [LAW:single-enforcer] The one place a session write closes what is open
// inside the disclosure it closes (brandon-menus-sjhy.9p6): a view of a
// session store whose every write also clears each disclosure inside a
// closed one, in the same transaction. Every verb writes
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
  // [LAW:dataflow-not-control-flow] Every write lands with the clears it
  // implies, read before any of it lands; a write that closes nothing clears
  // an empty list.
  const write = (
    sessionId: string,
    writes: readonly StateWrite[],
    land: () => void,
  ): void => {
    const folds = closeNested(
      nestOf(sessionId),
      (key) => store.get(sessionId, key),
      writes,
    );
    runInAction(() => {
      land();
      for (const key of folds) store.clear(sessionId, key);
    });
    // Once landed: a write the store refuses folded nothing.
    if (folds.length > 0) {
      log(`close-nested: folded=${folds.join(",")} (session=${sessionId})`);
    }
  };
  const setBatch = (sessionId: string, pairs: readonly StateWrite[]): void =>
    write(sessionId, pairs, () => store.setBatch(sessionId, pairs));
  return {
    get: (sessionId, key) => store.get(sessionId, key),
    revision: (sessionId) => store.revision(sessionId),
    set: (sessionId, key, value) => setBatch(sessionId, [{ key, value }]),
    setBatch,
    // A cleared key reads its default, so it closes what its old value held.
    clear: (sessionId, key) =>
      write(sessionId, [{ key, value: nestOf(sessionId).defaultOf(key) }], () =>
        store.clear(sessionId, key),
      ),
  };
}

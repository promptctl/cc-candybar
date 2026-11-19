// A session lets go of the state it holds for placements its config no
// longer places.
//
// [LAW:single-enforcer] The one release, run at the two moments a session's
// stale placement state could do harm: before the session draws, and as part
// of the session's own click, through its journal, so undoing the click
// brings the state back. Stale state harms only the session holding it, and
// only when it draws or saves, and every save is a click its own render came
// before: so the judgment is the session's, against the config it renders,
// and no load releases anything for anyone.

import { runInAction } from "mobx";
import {
  placementHolding,
  type Placements,
} from "../config/placement-state.js";
import type { SessionStateRW } from "../renderer-interface/session-state.js";
import type { SessionId } from "../daemon/foundations/session-id.js";
import type { DaemonLogger } from "../utils/logger.js";

// The keys of `sessionId` held for placements `placements` does not hold,
// cleared through `store`. [LAW:single-enforcer] Both moments hand in a
// closing view (src/renderer/closing-view.ts), so a clear that closes a
// disclosure folds what is open inside it, as every session write does.
export function releaseUnplaced(
  store: SessionStateRW,
  sessionId: SessionId,
  placements: Placements,
): readonly string[] {
  const released = store.entries(sessionId).flatMap(([key, value]) => {
    const owner = placementHolding(key, value);
    return owner === null || placements.has(owner) ? [] : [key];
  });
  if (released.length === 0) return released;
  runInAction(() => {
    for (const key of released) store.clear(sessionId, key);
  });
  return released;
}

// [LAW:nothing-unseen] What a session let go, said once it has landed: the
// state a later placement of the same id no longer inherits. A release of
// nothing says nothing, so a tick with nothing to let go logs nothing.
export function logReleased(
  log: DaemonLogger,
  sessionId: SessionId,
  released: readonly string[],
): void {
  if (released.length === 0) return;
  log(
    "info",
    `placement-release: released=${JSON.stringify(released)} (session=${sessionId})`,
  );
}

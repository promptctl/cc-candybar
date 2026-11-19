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

export function releaseUnplaced(
  store: SessionStateRW,
  sessionId: SessionId,
  placements: Placements,
  log: DaemonLogger,
): void {
  const released = store.entries(sessionId).flatMap(([key, value]) => {
    const owner = placementHolding(key, value);
    return owner === null || placements.has(owner) ? [] : [key];
  });
  if (released.length === 0) return;
  runInAction(() => {
    for (const key of released) store.clear(sessionId, key);
  });
  // [LAW:nothing-unseen] What a session let go, and of what: the state a
  // later placement of the same id no longer inherits.
  log(
    "info",
    `placement-release: released=${JSON.stringify(released)} (session=${sessionId})`,
  );
}

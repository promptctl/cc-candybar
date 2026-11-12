// [LAW:single-enforcer] The one owner of a session refresh that THREW
// (brandon-unfiled-3248.8ro6, step 4e). A refresh's contract is to answer —
// its owner stores what it read, a failure included — so a throw is a bug the
// owner never saw and stored nothing for. Kept here, per session and lane, so
// the view's payload, derived from what its owners hold, reads that lane as
// the failure until a refresh of it runs clean; without it a lane whose first
// refresh threw would read as not answered yet for good.

import type { SessionId } from "./session-id.js";
import { observable, runInAction } from "mobx";
import { failed, type Failed } from "../utils/outcome.js";

// The lanes a request's own arrival refreshes (refreshPayload). [LAW:one-source-of-truth]
// The list is the one declaration: the type derives from it, and a facts
// document's diagnostics walk it in this order.
export const REFRESH_LANES = [
  "session",
  "today",
  "context",
  "metrics",
  "activity",
  "cache",
  "speed",
  "autocompact",
] as const;
export type RefreshLane = (typeof REFRESH_LANES)[number];

export class RefreshFaults {
  private readonly bySession = observable.map<
    SessionId,
    ReadonlyMap<RefreshLane, string>
  >(undefined, { deep: false });

  // The lane's failure while its last refresh threw; none once one ran clean.
  of(sessionId: SessionId, lane: RefreshLane): Failed | undefined {
    const reason = this.bySession.get(sessionId)?.get(lane);
    return reason === undefined ? undefined : failed(reason, "read");
  }

  // What the lane's refresh just did: threw `reason`, or ran clean (null).
  refreshed(
    sessionId: SessionId,
    lane: RefreshLane,
    reason: string | null,
  ): void {
    const held = this.bySession.get(sessionId);
    if (reason === null && held?.has(lane) !== true) return;
    const next = new Map(held);
    if (reason === null) next.delete(lane);
    else next.set(lane, reason);
    runInAction(() => {
      if (next.size === 0) this.bySession.delete(sessionId);
      else this.bySession.set(sessionId, next);
    });
  }
}

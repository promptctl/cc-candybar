// [LAW:single-enforcer] The one owner of a session refresh that THREW
// (brandon-unfiled-3248.8ro6, step 4e). A refresh's contract is to answer —
// its owner stores what it read, a failure included — so a throw is a bug the
// owner never saw and stored nothing for. Kept here, per session and lane, so
// the view's payload, derived from what its owners hold, reads that lane as
// the failure until a refresh of it runs clean; without it a lane whose first
// refresh threw would read as not answered yet for good.

import { observable, runInAction } from "mobx";
import { failed, type Outcome } from "../utils/outcome.js";

// The lanes a request's own arrival refreshes (refreshPayload).
export type RefreshLane =
  | "session"
  | "today"
  | "context"
  | "metrics"
  | "activity"
  | "cache"
  | "speed"
  | "autocompact";

export class RefreshFaults {
  private readonly bySession = observable.map<
    string,
    ReadonlyMap<RefreshLane, string>
  >(undefined, { deep: false });

  // The lane's failure while its last refresh threw; none once one ran clean.
  of(sessionId: string, lane: RefreshLane): Outcome<never> | undefined {
    const reason = this.bySession.get(sessionId)?.get(lane);
    return reason === undefined ? undefined : failed(reason);
  }

  // What the lane's refresh just did: threw `reason`, or ran clean (null).
  refreshed(sessionId: string, lane: RefreshLane, reason: string | null): void {
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

// [LAW:single-enforcer] THE rule for a placement's session state once the
// placement has ended: a session that meets a config (its view opens over it,
// src/renderer/render-cache.ts) releases every key it holds that belongs to a
// placement the config doesn't hold. Session state outlives views, entries,
// eviction and restarts, so the rule can't hang on the event that ended a
// placement: an idle, evicted or restarted session is not there to hear a
// click, and a hand edit is no click at all. Meeting the config is the one
// moment every session passes through, and a click's own removal is one
// instance of it. Left held, the state lands on the next placement that takes
// the id, and the next save writes its stale values into the file.

import { placementOfKey, type Placements } from "../config/edit-chrome.js";
import type { SessionId } from "../daemon/foundations/session-id.js";
import type { SessionStateRW } from "../renderer-interface/session-state.js";
import type { NavigationHistory } from "./navigation-history.js";
import type { SessionState } from "./session-state.js";
import type { SettingsHistory } from "./settings-history.js";

export interface PlacementReleaseDeps {
  readonly sessionState: Pick<SessionState, "entries">;
  readonly history: Pick<SettingsHistory, "release">;
  readonly navigation: Pick<NavigationHistory, "forget">;
  // The view of the session's own click whose changes are landing, if one's
  // are: a click's successor view opens before its writes land, so what it
  // ends is released in its step, and its undo brings it back.
  readonly landingOf: (sessionId: SessionId) => SessionStateRW | null;
}

// The rule, as the render cache's `meets`: it returns the keys it released.
export function placementRelease(
  deps: PlacementReleaseDeps,
): (sessionId: SessionId, placements: Placements) => readonly string[] {
  return (sessionId, placements) => {
    const ended = deps.sessionState
      .entries(sessionId)
      .flatMap(([key, value]) => {
        const member = placementOfKey(key, value);
        return member === null || placements.holds(member) ? [] : [key];
      });
    deps.history.release(sessionId, ended, deps.landingOf(sessionId));
    deps.navigation.forget(sessionId, ended);
    return ended;
  };
}

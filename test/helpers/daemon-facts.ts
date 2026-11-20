import type { DaemonFacts } from "../../src/facts/world-state";
import {
  UNFOLLOWED_FEEDS,
  type Lane,
  type LaneFeeds,
} from "../../src/config/lanes";

export const FILE_EVENTS_STALLED = [
  { kind: "file-events", state: "stalled", message: "file events stopped" },
] as const satisfies DaemonFacts["fileEvents"];

export const daemonFactsOf = (
  fileEvents: DaemonFacts["fileEvents"] = [],
): DaemonFacts => ({
  fileEvents,
  watchDelivery: [],
  launcher: [],
  rendererEnded: null,
  actFailed: null,
});

// The host's feeds of a daemon where nothing follows any session.
export const UNFOLLOWED = {
  following: (): ReadonlySet<Lane> => new Set(),
  feedsOf: (): LaneFeeds => UNFOLLOWED_FEEDS,
};

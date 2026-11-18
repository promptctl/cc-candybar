import type { Fact } from "../../src/facts/fact";
import {
  IDLE,
  type DaemonFacts,
  type Update,
} from "../../src/facts/world-state";
import { pendingOf } from "../../src/utils/outcome";
import {
  UNFOLLOWED_FEEDS,
  type Lane,
  type LaneFeeds,
} from "../../src/config/lanes";

// What a world state carries of a daemon whose update is `newer`, with no act
// on it and no fault of its own.
export const daemonFactsOf = (
  newer: Fact<Update> = pendingOf("unread"),
): DaemonFacts => ({
  update: { newer, act: IDLE, actsError: null },
  fileEvents: [],
  launcher: [],
  rendererEnded: null,
  actFailed: null,
  gitEnv: { kind: "asked", names: [] },
});

// The host's feeds of a daemon where nothing follows any session.
export const UNFOLLOWED = {
  following: (): ReadonlySet<Lane> => new Set(),
  feedsOf: (): LaneFeeds => UNFOLLOWED_FEEDS,
};

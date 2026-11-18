// A placement's session state ends with the placement. A placement id is
// reused whenever a removed segment is added back, so state left under the
// old placement would land on the new one: its `✚` libraries open, its
// configure key set, its unsaved values shown and then saved into the file.
//
// [LAW:single-enforcer] One rule ends it, `releaseSession`: every key the
// session holds whose placement (as the key's minter answers,
// `placementOwning`) the config does not hold. The render cache runs it at
// every load of a config, over every session whose state belongs to that
// config, idle, evicted or restored after a restart; a click that writes a
// config runs it over its own session through its journal, so undoing the
// click brings the state back with the placement.

import { placementOwning } from "../config/edit-chrome.js";
import {
  mergedLayers,
  type ConfigSnapshot,
} from "../config/config-snapshot.js";
import type { SessionId } from "../daemon/foundations/session-id.js";
import type { SessionStateRW } from "../renderer-interface/session-state.js";
import type { DaemonLogger } from "../utils/logger.js";

// [LAW:one-source-of-truth] The session key naming the config the session's
// state belongs to: the config its last click acted in, since only a click
// writes a placement's state. It is written by every click, and lives in the
// session's state, so it outlives a restart beside the keys it scopes.
export const SESSION_CONFIG_KEY = "click.config";

// [LAW:one-source-of-truth] A config's identity: the files it is merged
// from, in order. Placements come from config files alone, so two origins
// over the same files hold the same placements, and a release at either
// reaches a session that clicked at the other.
export function configOf(snapshot: Pick<ConfigSnapshot, "chain">): string {
  return JSON.stringify(mergedLayers(snapshot).map((l) => l.path));
}

// [LAW:single-enforcer] Ends `sessionId`'s state for every placement
// `placements` does not hold, in `config`, and says which keys it ended.
export function releaseSession(
  store: SessionStateRW,
  sessionId: SessionId,
  placements: ReadonlySet<string>,
  config: string,
  log: DaemonLogger,
): void {
  const ended = store.keys(sessionId).filter((key) => {
    const owner = placementOwning(key, store.get(sessionId, key)!);
    return owner !== null && !placements.has(owner);
  });
  if (ended.length === 0) return;
  for (const key of ended) store.clear(sessionId, key);
  // [LAW:nothing-unseen]
  log(
    "info",
    `placement state released session=${JSON.stringify(sessionId)} config=${config} keys=${JSON.stringify(ended)}`,
  );
}

// [LAW:single-enforcer] A load of `config` holding `placements`: the release
// over every session the store holds whose state belongs to it.
export function releaseAtLoad(
  store: SessionStateRW,
  placements: ReadonlySet<string>,
  config: string,
  log: DaemonLogger,
): void {
  for (const sessionId of store.sessions())
    if (store.get(sessionId, SESSION_CONFIG_KEY) === config)
      releaseSession(store, sessionId, placements, config, log);
}

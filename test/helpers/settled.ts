import { when } from "mobx";
import { sourcesOf } from "../../src/daemon/collector";
import { awaitsReading } from "../../src/facts/awaited";
import type { WorldState } from "../../src/facts/world-state";
import type { Subscribed } from "../../src/renderer-interface/request-context";
import {
  subscriptionsOf,
  type SessionView,
} from "../../src/renderer/render-cache";

// What a session subscribes to when its view names no source.
export const NOTHING_SUBSCRIBED: Subscribed = {
  plugins: new Map(),
  runs: new Map(),
  env: [],
};

// [LAW:single-enforcer] What a view subscribes to, as its renderer hands it to
// the host and the host takes it: the production mapping, not a copy of it.
export const subscribedBy = (
  view: Pick<SessionView, "state" | "registry">,
): Subscribed => sourcesOf(subscriptionsOf(view), NOTHING_SUBSCRIBED);

// A request's wait over a world state, as the host's collector settles one:
// until nothing the draw waits on is unread, by the one rule (`awaitsReading`).
export async function settledWorld(
  worldState: () => WorldState,
  subscribed: () => Subscribed,
): Promise<void> {
  await when(() => !awaitsReading(worldState(), subscribed()));
}

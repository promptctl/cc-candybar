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

// The unread half of a request's wait (`awaitsReading`, the rule the
// collector's `holds` reads), for the rigs that draw straight from the owners'
// world state and take no renderer turn: the collector's other half, the
// renderer's turn on the latest stamp, has nothing to wait on there, and its
// tests are the collector's own.
export async function settledWorld(
  worldState: () => WorldState,
  subscribed: () => Subscribed,
): Promise<void> {
  await when(() => !awaitsReading(worldState(), subscribed()));
}

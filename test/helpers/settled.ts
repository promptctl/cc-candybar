import { when } from "mobx";
import { awaitsReading, type Subscribed } from "../../src/facts/awaited";
import type { WorldState } from "../../src/facts/world-state";
import type { SessionView } from "../../src/renderer/render-cache";

// What a session subscribes to when its view names no source.
export const NOTHING_SUBSCRIBED: Subscribed = {
  plugins: [],
  runs: [],
  env: [],
};

// What a view subscribes to, as its renderer hands it to the host.
export const subscribedBy = ({
  state,
  registry,
}: Pick<SessionView, "state" | "registry">): Subscribed => ({
  plugins: state.sources.keys(),
  runs: [...registry.namedRuns().values()].map((r) => r.digest),
  env: registry.envSubscriptions(),
});

// A request's wait over a world state, as the host's collector settles one:
// until nothing the draw waits on is unread, by the one rule (`awaitsReading`).
export async function settledWorld(
  worldState: () => WorldState,
  subscribed: () => Subscribed,
): Promise<void> {
  await when(() => !awaitsReading(worldState(), subscribed()));
}

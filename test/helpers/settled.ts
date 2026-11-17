import { when } from "mobx";
import { awaitsReading } from "../../src/facts/awaited";
import type { WorldState } from "../../src/facts/world-state";

// A request's wait over a world state, as the host's collector settles one:
// until nothing the draw waits on is unread, by the one rule (`awaitsReading`).
export async function settledWorld(
  worldState: () => WorldState,
  subscribed: () => Iterable<string>,
): Promise<void> {
  await when(() => !awaitsReading(worldState(), subscribed()));
}

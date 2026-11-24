import { when } from "mobx";
import { awaits, spelled } from "../../../src/facts/awaited";
import { UNREAD_RUN, type WorldState } from "../../../src/facts/world-state";

// Whether a world state still holds a fact a draw waits for: some built-in,
// some source, or some run the view subscribes to, never answered. The two
// built-ins the payload composes through `spelled` (the day's sums and the
// branch's PR) are the ones no request waits for.
function unanswered(
  { builtins, sources, runs }: WorldState,
  subscribed: Iterable<string>,
): boolean {
  const { today, pr, ...awaited } = builtins;
  return [
    ...Object.values(awaited),
    spelled(today),
    spelled(pr),
    ...Object.values(sources),
    ...[...subscribed].map((digest) => (runs[digest] ?? UNREAD_RUN).reading),
  ].some((reading) => reading.kind === "pending" && awaits(reading.why));
}

// A test's wait over a world state: until what a draw waits for has answered.
export async function settledWorld(
  worldState: () => WorldState,
  subscribed: () => Iterable<string>,
): Promise<void> {
  await when(() => !unanswered(worldState(), subscribed()));
}

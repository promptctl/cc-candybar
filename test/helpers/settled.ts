import { when } from "mobx";
import { awaits, spelled } from "../../src/facts/awaited";
import {
  UNREAD_RUN,
  type BuiltinFacts,
  type WorldState,
} from "../../src/facts/world-state";

// Whether a world state still holds a fact a draw waits for: some built-in a
// request waits for, some source, or some run the view subscribes to, never
// answered. The one table of what a request waits for (`spelled`) says which
// built-ins count.
function unanswered(
  { builtins, sources, runs }: WorldState,
  subscribed: Iterable<string>,
): boolean {
  const builtin = (name: keyof BuiltinFacts) => {
    const fact = builtins[name];
    return fact.kind === "pending" ? spelled(name, fact) : fact;
  };
  return [
    ...(Object.keys(builtins) as Array<keyof BuiltinFacts>).map(builtin),
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

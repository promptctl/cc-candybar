// [LAW:single-enforcer] The one rule for which facts a request's draw waits
// on before it draws: the host's wait asks it over a session's world state.

import type { Reading } from "../utils/outcome.js";
import {
  envFactOf,
  runFactOf,
  sourceFactOf,
  type BuiltinFacts,
  type WorldState,
} from "./world-state.js";

// Whether a request still waits on its world state before it draws: some
// fact that has never answered, among every built-in and every plugin source,
// except the two whose first answer is slow and external: today's day sums (a
// scan of every transcript under the Claude Code directory) and the branch's
// PR (a forge's network call). A first bar that waited on them would be as
// slow as the slowest, and a bar with every built-in placed always reads both,
// so they draw pending and land in a later world state. A fact the daemon
// itself superseded (a click's move) is not waited on either: it draws its
// loading cell, and its landing reaches the next frame.
// What it waits on past the built-ins is what the session's renderer
// subscribes to: each plugin source by name, each run by digest and each `env`
// variable by name. A key the renderer names is subscribed before its request
// is delivered, and until the host reads it the world state has no entry for
// it, so a key the document does not carry is waited on as one that never
// answered: the draw reads it the same way (`runFactOf`). A doctor run is not
// waited on: its read probes the terminal, fonts and the forge, so its report
// lands in a later world state, as the PR does.
export interface Subscribed {
  readonly plugins: Iterable<string>;
  readonly runs: Iterable<string>;
  readonly env: Iterable<string>;
}

export function awaitsReading(
  facts: WorldState,
  { plugins, runs, env }: Subscribed,
): boolean {
  return [
    ...AWAITED_BUILTINS.map((name) => facts.builtins[name]),
    ...[...plugins].map((name) => sourceFactOf(facts, name)),
    ...[...runs].map((digest) => runFactOf(facts, digest).reading),
    ...[...env].map((name) => envFactOf(facts, name)),
  ].some(awaitedReading);
}

// [LAW:types-are-the-program] Whether a request waits on each built-in, every
// one named, so a new built-in fails the build here until it says.
const AWAITED: Readonly<Record<keyof BuiltinFacts, boolean>> = {
  session: true,
  today: false,
  speed: true,
  context: true,
  metrics: true,
  activity: true,
  cache: true,
  autocompact: true,
  git: true,
  pr: false,
  tmux: true,
  hostName: true,
  hostUser: true,
};
const AWAITED_BUILTINS = (
  Object.keys(AWAITED) as ReadonlyArray<keyof BuiltinFacts>
).filter((name) => AWAITED[name]);

// [LAW:single-enforcer] Whether a draw waits on one fact: it has never
// answered. Why it is pending decides, never which fact it is
// [LAW:dataflow-not-control-flow].
export const awaitedReading = (fact: Reading<unknown>): boolean =>
  fact.kind === "pending" && fact.why === "unread";

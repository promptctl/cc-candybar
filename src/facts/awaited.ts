// [LAW:single-enforcer] The one rule for what a request waits for before it
// answers, and the one statement of what a draw still owes. The draw is the
// definition: a request waits for exactly what its frame draws as pending, and
// the renderer says so with every frame it draws (`Awaiting`).

import { pendingOf, type PendingWhy, type Reading } from "../utils/outcome.js";
import {
  stampFailureOf,
  type BuiltinFacts,
  type WorldState,
} from "./world-state.js";

// Whether a request waits for a pending: a first answer nothing defers. A
// `superseded` value the daemon itself made stale (a click's move) draws its
// loading cell and lands in the next frame, and a `deferred` one is slow and
// external by design (below), so neither holds a request. Why it is pending
// decides, never which value it is [LAW:dataflow-not-control-flow].
export const awaits = (why: PendingWhy): boolean => why === "unread";

// [LAW:types-are-the-program] Whether a request waits for each built-in's
// first answer, every one named, so a new built-in fails the build here until
// it says. The two that are not are slow and external: today's day sums (a
// scan of every transcript under the Claude Code directory) and the branch's
// PR (a forge's network call). A first bar that waited on them would be as
// slow as the slowest, and a bar with every built-in placed always reads both,
// so they draw pending and land in a later frame.
const AWAITED_BUILTIN: Readonly<Record<keyof BuiltinFacts, boolean>> = {
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

// [LAW:single-enforcer] The one place a built-in's first answer, not read
// yet, is spelled for a draw: `unread` for the answers a request waits for,
// `deferred` for the ones it does not. A fact never carries `deferred`; the
// payload that composes the draw's reading does.
export const spelled = <T>(
  name: keyof BuiltinFacts,
  reading: Reading<T>,
): Reading<T, PendingWhy> =>
  reading.kind === "pending" &&
  reading.why === "unread" &&
  !AWAITED_BUILTIN[name]
    ? pendingOf("deferred")
    : reading;

// [LAW:types-are-the-program] What a frame says it still owes, about the
// world state it was drawn from (`seq`): nothing; the variables whose first
// answer it drew as pending and a request waits for; or that it owes
// something that cannot come, because the world state it drew from is one
// whose stamp failed (its own diagnostic says why, and the bar says so).
export type Awaiting =
  | { readonly kind: "settled"; readonly seq: number }
  | {
      readonly kind: "owed";
      readonly seq: number;
      readonly names: readonly string[];
    }
  | {
      readonly kind: "stalled";
      readonly seq: number;
      readonly names: readonly string[];
      readonly reason: string;
    };

// [LAW:single-enforcer] The one statement a draw makes of what it owes: the
// variables it hit as pending, judged by `awaits`, over the document it read.
export function awaitingOf(
  pending: ReadonlyArray<{
    readonly variable: string;
    readonly why: PendingWhy;
  }>,
  document: Pick<WorldState, "seq" | "diagnostics">,
): Awaiting {
  const { seq } = document;
  const names = pending
    .filter(({ why }) => awaits(why))
    .map(({ variable }) => variable);
  if (names.length === 0) return { kind: "settled", seq };
  const reason = stampFailureOf(document);
  return reason === null
    ? { kind: "owed", seq, names }
    : { kind: "stalled", seq, names, reason };
}

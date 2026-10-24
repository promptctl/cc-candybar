import type { Outcome } from "./outcome";

// [LAW:types-are-the-program] What a source holds for one key: nothing yet,
// or the latest outcome (brandon-unfiled-3248.8ro6, step 1). `pending` carries
// the promise its read resolves, so a reader that must wait for a value waits
// on the read itself, never on a poll. Every owner of a shared source (git's
// repos, tmux's panes, memento's readings) holds its values in this one shape.
export type Reading<T> =
  | {
      readonly kind: "pending";
      readonly landed: Promise<void>;
      readonly land: () => void;
    }
  | { readonly kind: "read"; readonly outcome: Outcome<T> };

export interface Readable<T> {
  reading: Reading<T>;
}

export function pending<T>(): Reading<T> {
  let land!: () => void;
  const landed = new Promise<void>((resolve) => {
    land = resolve;
  });
  return { kind: "pending", landed, land };
}

export function settle<T>(source: Readable<T>, outcome: Outcome<T>): void {
  const prior = source.reading;
  source.reading = { kind: "read", outcome };
  if (prior.kind === "pending") prior.land();
}

// A source its owner is dropping: a reader waiting on its pending value is
// answered, never left waiting on a read that will store nothing.
export function answerPending<T>(
  source: Readable<T>,
  outcome: Outcome<never>,
): void {
  if (source.reading.kind === "pending") settle(source, outcome);
}

// [LAW:types-are-the-program] A read as it stands now: its outcome, or not
// answered yet with the landing to wait for. A draw takes it as it stands (a
// `Reading` of src/utils/outcome.ts: the landing is the waiter's, never the
// draw's); a reader that must have an answer waits it out (`answered`).
export type Current<T> = Outcome<T> | Waiting;

// Not answered yet, with the landing to wait for.
export interface Waiting {
  readonly kind: "pending";
  readonly landed: Promise<void>;
}

function isWaiting<A>(current: A | Waiting): current is Waiting {
  return (
    typeof current === "object" &&
    current !== null &&
    (current as { readonly kind?: unknown }).kind === "pending"
  );
}

export function currentOf<T>(source: Readable<T>): Current<T> {
  const reading = source.reading;
  return reading.kind === "read" ? reading.outcome : reading;
}

// [LAW:one-source-of-truth] The one wait for an answer: the read itself, asked
// again once what it waited on lands, so a value made pending again while a
// reader waits (a new key, a superseding move) is waited out too.
export async function answered<A>(read: () => A | Waiting): Promise<A> {
  for (;;) {
    const current = read();
    if (!isWaiting(current)) return current;
    await current.landed;
  }
}

// A source's outcome once it has one.
export function outcomeOf<T>(source: Readable<T>): Promise<Outcome<T>> {
  return answered(() => currentOf(source));
}

// [LAW:types-are-the-program] What a declaration hands its reader: the entry
// it took, read as it stands. The key was computed once, by the declaration,
// and reading takes nothing, so a read can neither re-derive the key nor take
// back a hold a later declaration released (brandon-unfiled-3248.8ro6, step 4).
export interface Lane<T> {
  current(): Current<T>;
}

// A lane answering one outcome for good: a lane the closure does not read
// (`ABSENT`), or one whose declaration threw.
export function settledLane<T>(outcome: Outcome<T>): Lane<T> {
  return { current: () => outcome };
}

// A lane's answer, waited for while it is not answered yet.
export function laneOutcome<T>(lane: Lane<T>): Promise<Outcome<T>> {
  return answered(() => lane.current());
}

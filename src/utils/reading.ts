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

// A source's outcome once it has one. A value made pending again while a
// reader waits (a new key, a superseding move) is waited out too.
export async function outcomeOf<T>(source: Readable<T>): Promise<Outcome<T>> {
  const reading = source.reading;
  if (reading.kind === "read") return reading.outcome;
  await reading.landed;
  return outcomeOf(source);
}

import {
  compareStructural,
  observable,
  runInAction,
  type IObservableValue,
} from "mobx";
import type { Timekeeper } from "../time";
import type { FactPendingWhy, Outcome, Pending } from "./outcome";

// What a waiter awaits: the read that will answer a pending value.
export interface Landing {
  readonly landed: Promise<void>;
  readonly land: () => void;
}

// [LAW:types-are-the-program] What a source holds for one key: nothing yet,
// or the latest outcome (brandon-unfiled-3248.8ro6, step 1). It is a `Reading`
// of src/utils/outcome.ts whose pending arm also carries the promise its read
// resolves, so a reader that must wait for a value waits on the read itself,
// never on a poll. Every owner of a shared source (the repos, panes and
// session files) holds its values in this one shape; dropping the landing
// leaves the plain `Pending` a facts document carries.
export type Held<T> = (Pending<FactPendingWhy> & Landing) | Outcome<T>;

// [LAW:no-ambient-temporal-coupling] A source's stored value, observable, so a
// derivation over it — a view's payload (brandon-unfiled-3248.8ro6, step 4) —
// is recomputed in the turn the value lands, never read stale. Only `settle`
// and `renew` write it.
export interface Readable<T> {
  readonly reading: IObservableValue<Held<T>>;
}

// A source's stored value before its first read.
export function unread<T>(): IObservableValue<Held<T>> {
  return observable.box<Held<T>>(pending("unread"), { deep: false });
}

export function pending(
  why: FactPendingWhy,
): Pending<FactPendingWhy> & Landing {
  let land!: () => void;
  const landed = new Promise<void>((resolve) => {
    land = resolve;
  });
  return { kind: "pending", why, landed, land };
}

// [LAW:single-enforcer] A read that found what is stored stores nothing, by
// structure: nothing derived from the value recomputes, and no feed showing it
// wakes (brandon-unfiled-3248.8ro6, step 4e). A pending value always lands.
export function settle<T>(source: Readable<T>, outcome: Outcome<T>): void {
  const prior = source.reading.get();
  if (prior.kind !== "pending" && compareStructural(prior, outcome)) return;
  runInAction(() => source.reading.set(outcome));
  if (prior.kind === "pending") prior.land();
}

// The stored value no longer answers what its source reads (a new key, a
// superseding move): it is pending until a fresh read lands, for `why`. A
// value already pending keeps the landing its readers wait on, and a key never
// answered stays `unread` whatever made it pending again.
export function renew<T>(source: Readable<T>, why: FactPendingWhy): void {
  const prior = source.reading.get();
  if (prior.kind !== "pending") {
    runInAction(() => source.reading.set(pending(why)));
  } else if (prior.why !== why && why === "unread") {
    runInAction(() => source.reading.set({ ...prior, why }));
  }
}

// A source its owner is dropping: a reader waiting on its pending value is
// answered, never left waiting on a read that will store nothing.
export function answerPending<T>(
  source: Readable<T>,
  outcome: Outcome<never>,
): void {
  if (source.reading.get().kind === "pending") settle(source, outcome);
}

// [LAW:types-are-the-program] A read as it stands now: its outcome, or not
// answered yet with the landing to wait for. A draw takes it as it stands (a
// `Reading` of src/utils/outcome.ts: the landing is the waiter's, never the
// draw's); a reader that must have an answer waits it out (`answered`).
export type Current<T> = Outcome<T> | Waiting;

// Not answered yet, why, and the landing to wait for.
export interface Waiting extends Pending<FactPendingWhy> {
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
  return source.reading.get();
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

// [LAW:types-are-the-program] How a bounded wait ended: what it waited on
// answered (with its answer), its time ran out, or its owner closed.
export type Waited<T> =
  | { readonly end: "answered"; readonly value: T }
  | { readonly end: "deadline" }
  | { readonly end: "closed" };

// [LAW:no-ambient-temporal-coupling][LAW:single-enforcer] The one bounded
// wait over work that does not end at a signal of its own (a wait that does,
// as `SourceRegistry.inFlight` does, is bounded by the signal it is given):
// `work`, or `ms`, or `closing`, whichever ends first; a wait begun after
// `closing` aborted ends at once. `work` is handed the wait's signal, aborted
// when the wait ends on any arm, with its timer cleared:
// what it listens on through the signal stops with the wait, so a wait leaves
// nothing behind, and work that stops there rejects with the signal's reason,
// as `throwIfAborted` does, which is the wait's own end and no failure. What
// it does not, a run it started, goes on, and a failure of it after the wait
// ended is no one's answer: it is the clock's, as the wait's task after its
// wait, saying what the work threw.
export function waitWithin<T>(
  // The wait's task name: its deadline's, and its work's past the wait.
  task: string,
  work: (signal: AbortSignal) => Promise<T>,
  ms: number,
  clock: Pick<Timekeeper, "after" | "failed">,
  closing: AbortSignal,
): Promise<Waited<T>> {
  const wait = new AbortController();
  const end = (why: "deadline" | "closed") => () => wait.abort(why);
  const clear = clock.after(task, Math.max(0, ms), end("deadline"));
  const ended = new Promise<Waited<T>>((resolve, reject) => {
    wait.signal.addEventListener("abort", () =>
      resolve({ end: wait.signal.reason as "deadline" | "closed" }),
    );
    closing.addEventListener("abort", end("closed"), { signal: wait.signal });
    if (closing.aborted) end("closed")();
    // [LAW:no-silent-failure] Every failure is reported, a throw before `work`
    // returns as its rejection is: the wait's own while it listens, and the
    // clock's after, as a task of its own, a wait begun closed included. Work
    // that answered never rejects, so a wait aborted before it ended at its
    // deadline or close.
    let working: Promise<T>;
    try {
      working = work(wait.signal);
    } catch (thrown) {
      working = Promise.reject(thrown);
    }
    working.then(
      (value) => resolve({ end: "answered", value }),
      (e: unknown) => {
        if (!wait.signal.aborted) reject(e);
        else if (e !== wait.signal.reason)
          clock.failed(`${task} after its wait`, e);
      },
    );
  });
  return ended.finally(() => {
    clear();
    wait.abort();
  });
}

// [LAW:types-are-the-program] What a declaration hands its reader: the entry
// it took, read as it stands. The key was computed once, by the declaration,
// and reading takes nothing, so a read can neither re-derive the key nor take
// back a hold a later declaration released (brandon-unfiled-3248.8ro6, step 4).
export interface Lane<T> {
  current(): Current<T>;
}

// A lane answering one outcome for good: a lane with no key to read (`ABSENT`,
// a session outside tmux), or one whose declaration threw.
export function settledLane<T>(outcome: Outcome<T>): Lane<T> {
  return { current: () => outcome };
}

// A lane's answer, waited for while it is not answered yet.
export function laneOutcome<T>(lane: Lane<T>): Promise<Outcome<T>> {
  return answered(() => lane.current());
}

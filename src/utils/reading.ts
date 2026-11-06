import {
  compareStructural,
  observable,
  runInAction,
  type IObservableValue,
} from "mobx";
import type { Timekeeper } from "../time";
import type { Outcome, Pending, PendingWhy } from "./outcome";

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
export type Held<T> = (Pending & Landing) | Outcome<T>;

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

export function pending(why: PendingWhy): Pending & Landing {
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
export function renew<T>(source: Readable<T>, why: PendingWhy): void {
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
export interface Waiting extends Pending {
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

// How a bounded wait ended: what it waited on answered, or its time ran out.
export type WaitEnd = "answered" | "deadline";

// [LAW:no-ambient-temporal-coupling][LAW:single-enforcer] The one bounded
// wait over work that does not end at a signal of its own (a wait that does,
// as `SourceRegistry.inFlight` does, is bounded by the signal it is given):
// `work`, or `ms`, whichever ends first. `work` is handed the wait's
// signal, aborted when the wait ends on either arm, with its timer cleared:
// what it listens on through the signal stops with the wait, so a wait leaves
// nothing behind. What it does not, a run it started, goes on, and a failure
// of it after the deadline is no one's answer: it goes to `late`, its owner's
// report.
//
// A wait whose time is already gone (`ms` at or below zero) ends in this
// turn, with no timer: a timer due at once still waits for the loop's next
// timers phase, which under a backlog comes after every pending request has
// been read and set up, tens of milliseconds a client with no budget left
// does not have. The work still starts, so what it sets in motion lands for
// the next answer, and it is aborted at once.
export function waitWithin(
  work: (signal: AbortSignal) => Promise<unknown>,
  ms: number,
  late: (e: unknown) => void,
  after: Timekeeper["after"],
): Promise<WaitEnd> {
  const wait = new AbortController();
  const clear = ms > 0 ? after(ms, () => wait.abort()) : () => {};
  const ended = new Promise<WaitEnd>((resolve, reject) => {
    wait.signal.addEventListener("abort", () => resolve("deadline"));
    void work(wait.signal).then(
      () => resolve("answered"),
      // [LAW:no-silent-failure] Every rejection is reported: the wait's own
      // while it listens, its owner's after.
      (e: unknown) => (wait.signal.aborted ? late(e) : reject(e)),
    );
    if (ms <= 0) wait.abort();
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

// A lane answering one outcome for good: a lane the closure does not read
// (`ABSENT`), or one whose declaration threw.
export function settledLane<T>(outcome: Outcome<T>): Lane<T> {
  return { current: () => outcome };
}

// A lane's answer, waited for while it is not answered yet.
export function laneOutcome<T>(lane: Lane<T>): Promise<Outcome<T>> {
  return answered(() => lane.current());
}

// [LAW:types-are-the-program] The phase a failed read stopped in: `read` got no
// bytes (spawn, timeout, unreadable file, unreachable forge); `parse` got bytes
// that were not the shape the producer parses them to. A fact carries it to the
// renderer, where "the file is gone" and "the file is malformed" are different
// repairs. There is no default: each producer states the phase it knows.
export type FailedAt = "read" | "parse";

// [LAW:types-are-the-program] The provider-outcome vocabulary: a data fetch
// either produced a value, found that the domain genuinely has none (no
// upstream configured, no transcript yet), or failed to get an answer at all
// (timeout, spawn error, unreadable file). Before this type, the third state
// was unrepresentable — failure had to wear a real value's clothes (0, "",
// a basename) and the lie flowed all the way to the rendered bar.
//
// [LAW:dataflow-not-control-flow] Failure is a value that flows to a
// boundary, not a swallowed branch. Producers classify once, where the
// command semantics are known; consumers fold once, at the edge where the
// log effect and the payload mapping live.
export type Outcome<T> =
  | { readonly kind: "ok"; readonly value: T }
  | { readonly kind: "absent" }
  | {
      readonly kind: "failed";
      readonly reason: string;
      readonly failedAt: FailedAt;
    };

export type Ok<T> = Extract<Outcome<T>, { kind: "ok" }>;

// A question put to a system that answers or fails, never "no opinion", and
// whose failure has no read or parse phase to carry: the doctor's probes and
// the state files it shares with the daemon.
export type Asked<T> =
  | { readonly kind: "ok"; readonly value: T }
  | { readonly kind: "failed"; readonly reason: string };

export function ok<T>(value: T): Ok<T> {
  return { kind: "ok", value };
}

export const ABSENT: Outcome<never> = { kind: "absent" };

// [LAW:types-are-the-program] What a one-shot sample can be: not taken yet, or
// taken. A holder of a sample that can neither find nothing nor fail (the
// update watch's build and release, whose failures are values of the sample
// itself) has no `absent` or `failed` to guard.
export type Sampled<T> = Pending<FactPendingWhy> | Ok<T>;

export type Failed = Extract<Outcome<never>, { kind: "failed" }>;

export function failed(reason: string, failedAt: FailedAt): Failed {
  return { kind: "failed", reason, failedAt };
}

// [LAW:dataflow-not-control-flow] Total fold for consumers that only need a
// value-or-fallback view (e.g. var-system's typed projection). Both non-ok
// arms collapse to the fallback; consumers that must distinguish absent from
// failed (the logging boundaries) match on `kind` instead.
export function orElse<T>(outcome: Outcome<T> | undefined, fallback: T): T {
  return outcome?.kind === "ok" ? outcome.value : fallback;
}

// [LAW:types-are-the-program] Why a fact is not answered yet: `unread`, a key
// never answered (a first read, a new key); `superseded`, a key whose value the
// daemon itself made stale (a click that moved it). A request waits only for
// first answers: a superseded value may take as long as the program the click
// ran, so it draws its loading cell, and its landing reaches the next frame.
export type FactPendingWhy = "unread" | "superseded";

// Why a draw reads something as not answered yet: what a fact can be pending
// for, and `deferred`, a first answer no request waits for (the day's sums and
// the branch's PR, which land after the bar is up). Only a draw reads
// `deferred`: a fact never carries it, so the owners and the document cannot
// spell it, and a request waits only for `unread`.
export type PendingWhy = FactPendingWhy | "deferred";

// A source's value as it stands: not answered yet, or what its read answered.
// `pending` is not `absent`: absent says the domain genuinely has nothing,
// pending says nobody has asked it yet — a document before its first scan —
// and is never drawn as an answer. It is a plain value, so it crosses a
// process as JSON and is recognised by its discriminator, never by identity.
// The type is what a draw reads; a fact, a reading and a sample are the
// `FactPendingWhy` kind of it.
export interface Pending<W extends PendingWhy = PendingWhy> {
  readonly kind: "pending";
  readonly why: W;
}
//
// A reading is a fact's by default; the wider `W` is a reading as a draw takes
// it, where a pending may be `deferred` too.
export type Reading<T, W extends PendingWhy = FactPendingWhy> =
  | Pending<W>
  | Outcome<T>;
// A reading of something that is never absent: what it is, why not yet, or
// what failed.
export type Present<T, W extends PendingWhy = FactPendingWhy> = Exclude<
  Reading<T, W>,
  { kind: "absent" }
>;

const PENDINGS: Readonly<Record<PendingWhy, Pending>> = {
  unread: Object.freeze({ kind: "pending", why: "unread" }),
  superseded: Object.freeze({ kind: "pending", why: "superseded" }),
  deferred: Object.freeze({ kind: "pending", why: "deferred" }),
};

// Shared per `why` only so a payload recomputed from the same pending is the
// same value to a MobX identity comparer; every test of pending is `isPending`.
export function pendingOf<W extends PendingWhy>(why: W): Pending<W> {
  return PENDINGS[why] as Pending<W>;
}

// What a payload node the daemon built can be. `unknown` is not among them: a
// user's JSON (a source's `ok` value) is tested by no one, because a document
// that reads `{"kind":"pending"}` is a value.
export type PayloadNode =
  | object
  | string
  | number
  | boolean
  | bigint
  | symbol
  | null
  | undefined;

// [LAW:single-enforcer] The one test for pending where a typed position may
// hold it (a lane, a payload field the daemon built).
export function isPending<T extends PayloadNode>(
  value: T | Pending,
): value is Pending {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { readonly kind?: unknown }).kind === "pending"
  );
}

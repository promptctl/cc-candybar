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
  | { readonly kind: "failed"; readonly reason: string };

export type Ok<T> = Extract<Outcome<T>, { kind: "ok" }>;

export function ok<T>(value: T): Ok<T> {
  return { kind: "ok", value };
}

export const ABSENT: Outcome<never> = { kind: "absent" };

export function failed(reason: string): Outcome<never> {
  return { kind: "failed", reason };
}

// [LAW:dataflow-not-control-flow] Total fold for consumers that only need a
// value-or-fallback view (e.g. var-system's typed projection). Both non-ok
// arms collapse to the fallback; consumers that must distinguish absent from
// failed (the logging boundaries) match on `kind` instead.
export function orElse<T>(outcome: Outcome<T> | undefined, fallback: T): T {
  return outcome?.kind === "ok" ? outcome.value : fallback;
}

// [LAW:types-are-the-program] A source's value as it stands: not answered yet,
// or what its read answered. `pending` is not `absent`: absent says the domain
// genuinely has nothing, pending says nobody has asked it yet — a document
// before its first scan — and is never drawn as an answer.
export interface Pending {
  readonly kind: "pending";
}
export type Reading<T> = Pending | Outcome<T>;

export const PENDING: Pending = { kind: "pending" };

// [LAW:single-enforcer] The one test for the pending spelling a value carries
// where any value may stand (a payload field): PENDING itself.
export function isPending(value: unknown): value is Pending {
  return value === PENDING;
}

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

export function ok<T>(value: T): Outcome<T> {
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

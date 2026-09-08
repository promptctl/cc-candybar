// [LAW:types-are-the-program] A fetch produced a value, found the domain
// genuinely has none, or failed to get an answer at all.
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

// [LAW:dataflow-not-control-flow] Callers needing absent-vs-failed match on `kind`.
export function orElse<T>(outcome: Outcome<T> | undefined, fallback: T): T {
  return outcome?.kind === "ok" ? outcome.value : fallback;
}

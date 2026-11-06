// [LAW:one-way-deps] How an effect went, below every edge that performs one
// (src/daemon/runs.ts, src/daemon/lane-setup.ts) and the effects that name
// what those edges are handed (src/daemon/effect.ts).

// How an effect went. `said` is the sentence a person reads: for a failure,
// the whole of it (what failed, and why, in the edge's own words), and for a
// success the fact worth keeping, if any (the pane typed into).
export type EffectOutcome =
  | { readonly kind: "ok"; readonly said: string }
  | { readonly kind: "failed"; readonly said: string };

export const PERFORMED: EffectOutcome = { kind: "ok", said: "" };

export const failed = (
  said: string,
): Extract<EffectOutcome, { readonly kind: "failed" }> => ({
  kind: "failed",
  said,
});

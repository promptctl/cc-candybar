// What a series of timings says about itself. A statusline tick is judged by
// its tail, not its centre: Claude Code hangs up on a render that answers late,
// so a mean that hides one slow tick in fifty hides the tick that was lost.
//
// [LAW:types-are-the-program] A distribution exists only for a non-empty
// series, so `percentile` has no empty case to guard: `distributionOf` is the
// one checkpoint, and it fails loudly on a series that measured nothing.

import { percentile } from "../lib/percentile.js";

export interface Distribution {
  readonly n: number;
  readonly min: number;
  readonly p50: number;
  readonly p90: number;
  readonly p99: number;
  readonly max: number;
  readonly mean: number;
}

export function distributionOf(samples: readonly number[]): Distribution {
  if (samples.length === 0) {
    throw new Error("a series with no samples has no distribution");
  }
  const bad = samples.find((s) => !Number.isFinite(s) || s < 0);
  if (bad !== undefined) {
    throw new Error(`a timing must be a finite, non-negative ms, got ${bad}`);
  }
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    n: sorted.length,
    min: sorted[0]!,
    p50: percentile(sorted, 0.5),
    p90: percentile(sorted, 0.9),
    p99: percentile(sorted, 0.99),
    max: sorted[sorted.length - 1]!,
    mean: sorted.reduce((sum, s) => sum + s, 0) / sorted.length,
  };
}

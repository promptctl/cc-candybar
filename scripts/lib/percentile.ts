// The sample at rank ⌊n·p⌋ of an ascending series, clamped to its last: p50 of
// an even count is the upper of the two middle samples, and p99 of fifty ticks
// is the slowest tick. It returns a sample that was observed, never an
// interpolation between two.
//
// [LAW:one-source-of-truth] The load gate and the benchmark both report
// percentiles of latencies, so the definition lives here and the two cannot
// disagree about what a p90 is. It is the definition the gate has always
// judged by: a saved gate baseline stays comparable. `sorted` is non-empty:
// each caller owns what an empty series means.
export function percentile(sorted: readonly number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!;
}

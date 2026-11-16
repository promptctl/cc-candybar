// [LAW:one-source-of-truth] The one way candybar holds and reads a timing: an
// HdrHistogram of every value recorded, in microseconds, in bounded memory
// however long the daemon runs, read as one distribution. A render's time, a
// launch's and a feed frame's lateness are spelled the same wherever they show.

import { build as buildHistogram, type Histogram } from "hdr-histogram-js";
import type { Durations } from "./foundations/stats-snapshot.js";

export type { Histogram };

export const durationHistogram = (): Histogram =>
  buildHistogram({ bitBucketSize: "packed" });

export const recordMs = (h: Histogram, ms: number): void => {
  h.recordValue(Math.round(ms * 1000));
};

const msOf = (us: number): number => Math.round(us / 10) / 100;

// A percentile is read as the highest value its bucket stands for, which can
// lie above the largest value recorded; no recorded value lies above the
// largest, so that is the tightest true bound.
export const durationsOf = (h: Histogram): Durations => {
  const s = h.summary;
  const at = (us: number): number => msOf(Math.min(us, s.max));
  return {
    count: s.totalCount,
    p50Ms: at(s.p50),
    p90Ms: at(s.p90),
    p99Ms: at(s.p99),
    p999Ms: at(s.p99_9),
    maxMs: msOf(s.max),
    meanMs: msOf(h.mean),
    stddevMs: msOf(h.stdDeviation),
  };
};

// [LAW:one-source-of-truth] The one way candybar holds and reads a timing: an
// HdrHistogram of every value recorded, in microseconds, in bounded memory
// however long the daemon runs, read as one distribution. A render's time, a
// launch's and a feed frame's lateness are spelled the same wherever they show.

import {
  build as buildHistogram,
  encodeIntoCompressedBase64,
  type Histogram,
} from "hdr-histogram-js";
import type { Durations } from "./stats-snapshot.js";

export type { Histogram };

export const durationHistogram = (): Histogram =>
  buildHistogram({ bitBucketSize: "packed" });

export const recordMs = (h: Histogram, ms: number): void => {
  h.recordValue(Math.round(ms * 1000));
};

// To the hundredth of a ms. A percentile or the max rounds up, so it never
// reads below the values it stands for; a mean or deviation is a sum's
// quotient, rounded to nearest.
const msUpOf = (us: number): number => Math.ceil(us / 10) / 100;
const msOf = (us: number): number => Math.round(us / 10) / 100;

// The whole histogram, compressed, as HdrHistogram's tools read and merge it.
export const encodedOf = (h: Histogram): string =>
  encodeIntoCompressedBase64(h);

// A percentile is the highest value its bucket stands for, which can lie above
// the largest value recorded; no recorded value lies above the largest, so that
// is the tightest true bound. (The histogram's own summary rounds each
// percentile down to three digits, below the values it stands for.)
export const durationsOf = (h: Histogram): Durations => {
  const max = h.maxValue;
  const at = (p: number): number =>
    msUpOf(Math.min(h.getValueAtPercentile(p), max));
  return {
    count: h.totalCount,
    p50Ms: at(50),
    p90Ms: at(90),
    p99Ms: at(99),
    p999Ms: at(99.9),
    maxMs: msUpOf(max),
    meanMs: msOf(h.mean),
    stddevMs: msOf(h.stdDeviation),
  };
};

// A timing as a log line spells it. The spread between p50 and the tail is
// the jitter.
export const distributionOf = (h: Histogram): string => {
  const d = durationsOf(h);
  const ms = (v: number): string => v.toFixed(2);
  return d.count === 0
    ? "-"
    : `n:${d.count},p50:${ms(d.p50Ms)},p90:${ms(d.p90Ms)},p99:${ms(d.p99Ms)},p99.9:${ms(d.p999Ms)},max:${ms(d.maxMs)},mean:${ms(d.meanMs)},stddev:${ms(d.stddevMs)}`;
};

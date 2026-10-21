// What a cold transcript fold costs in memory (brandon-unfiled-3248.bfnj):
// `concurrency` cold folds of one transcript at once, as a daemon's first
// renders after a start do, through the fold every provider runs.
//
//   tsx --expose-gc scripts/fold-cost.mts <transcript.jsonl> [concurrency]
//
// Prints the RSS, heap and external growth peak and after, sampled every
// millisecond. The fold's step only counts entries, so what is measured is the
// read itself.
import { foldAppended } from "../src/utils/claude.ts";
import { transcriptReads } from "../src/utils/transcript-fs.ts";

const [file, n = "1"] = process.argv.slice(2);
if (file === undefined) {
  console.error("usage: tsx --expose-gc scripts/fold-cost.mts <transcript.jsonl> [concurrency]");
  process.exit(2);
}
const concurrency = Number(n);
const MB = (bytes: number) => (bytes / 2 ** 20).toFixed(1);

globalThis.gc?.();
const readsBefore = transcriptReads();
const before = process.memoryUsage();
const peak = { rss: before.rss, heap: before.heapUsed, ext: before.external };
const sampler = setInterval(() => {
  const m = process.memoryUsage();
  peak.rss = Math.max(peak.rss, m.rss);
  peak.heap = Math.max(peak.heap, m.heapUsed);
  peak.ext = Math.max(peak.ext, m.external);
}, 1);

const folds = await Promise.all(
  Array.from({ length: concurrency }, () =>
    foldAppended(file, undefined, 0, (count, entries) => count + entries.length),
  ),
);
clearInterval(sampler);
const after = process.memoryUsage();

const first = folds[0]!;
if (first.kind !== "ok") {
  console.error(`fold ${first.kind}${first.kind === "failed" ? `: ${first.reason}` : ""}`);
  process.exit(1);
}
const { folded } = first.value;
const reads = transcriptReads();
console.log(
  [
    `folds=${concurrency} entries=${folded.value} reads=${reads.reads - readsBefore.reads} bytes=${MB(reads.bytes - readsBefore.bytes)}MB longLines=${reads.longLines - readsBefore.longLines} largestLine=${MB(reads.largestLine)}MB`,
    `rss +${MB(peak.rss - before.rss)}MB peak, +${MB(after.rss - before.rss)}MB after`,
    `heap +${MB(peak.heap - before.heapUsed)}MB peak, external +${MB(peak.ext - before.external)}MB peak`,
  ].join("\n"),
);

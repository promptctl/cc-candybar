#!/usr/bin/env node
// Soak analyzer. Reads soak.csv (ts_unix,pid,rss_kb), segments samples by PID
// (so a daemon self-restart at age=24h doesn't pollute slope), runs ordinary
// least-squares regression on each segment, and asserts:
//
//   - final RSS  < 100 MB    (well under the 200MB self-shutdown trigger)
//   - peak slope < 1 MB/hr   (per-segment, ignoring segments with <10 samples)
//
// Exit code 0 on pass, 1 on fail. Output is plaintext suitable for tee to
// summary.txt.

import { readFileSync } from "node:fs";
import { join } from "node:path";

const FINAL_RSS_LIMIT_MB = 100;
const SLOPE_LIMIT_MB_PER_HR = 1;
const MIN_SAMPLES_FOR_SLOPE = 10;

const outDir = process.argv[2];
if (!outDir) {
  console.error("usage: soak-analyze.mjs OUT_DIR");
  process.exit(2);
}

const csvPath = join(outDir, "soak.csv");

const lines = readFileSync(csvPath, "utf8").trim().split("\n");
const header = lines.shift();
if (header !== "ts_unix,pid,rss_kb") {
  console.error(`unexpected header: ${header}`);
  process.exit(2);
}

const rows = lines.map((l) => {
  const [ts, pid, rss] = l.split(",");
  return { ts: Number(ts), pid: pid, rssKb: Number(rss) };
});

if (rows.length === 0) {
  console.error("no RSS samples collected");
  process.exit(1);
}

// Segment by PID. Daemon may self-restart mid-soak; each segment is its own
// regression target.
const segments = [];
let cur = null;
for (const r of rows) {
  if (!cur || cur.pid !== r.pid) {
    cur = { pid: r.pid, samples: [] };
    segments.push(cur);
  }
  cur.samples.push(r);
}

// y = a + b*x  with x = (ts - first_ts)/3600  (hours), y = rss_mb
function regress(samples) {
  const x0 = samples[0].ts;
  const n = samples.length;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const s of samples) {
    const x = (s.ts - x0) / 3600;
    const y = s.rssKb / 1024;
    sx += x; sy += y; sxx += x * x; sxy += x * y;
  }
  const denom = n * sxx - sx * sx;
  if (denom === 0) return { slope: 0, intercept: sy / n };
  return {
    slope: (n * sxy - sx * sy) / denom,
    intercept: (sy * sxx - sx * sxy) / denom,
  };
}

const finalRow = rows[rows.length - 1];
const finalRssMb = finalRow.rssKb / 1024;

let peakSlope = 0;
const segReports = [];
for (const seg of segments) {
  const durHr = (seg.samples[seg.samples.length - 1].ts - seg.samples[0].ts) / 3600;
  if (seg.samples.length < MIN_SAMPLES_FOR_SLOPE) {
    segReports.push({
      pid: seg.pid,
      n: seg.samples.length,
      durHr,
      slope: null,
      note: "too few samples",
    });
    continue;
  }
  const { slope } = regress(seg.samples);
  segReports.push({ pid: seg.pid, n: seg.samples.length, durHr, slope });
  if (Math.abs(slope) > Math.abs(peakSlope)) peakSlope = slope;
}

const out = [];
out.push("cc-candybar daemon soak summary");
out.push("");
out.push(`samples:           ${rows.length}`);
out.push(`segments (pids):   ${segments.length}`);
out.push(`first sample:      ${new Date(rows[0].ts * 1000).toISOString()}`);
out.push(`last sample:       ${new Date(finalRow.ts * 1000).toISOString()}`);
out.push(`total elapsed:     ${((finalRow.ts - rows[0].ts) / 3600).toFixed(2)} hr`);
out.push(`final RSS:         ${finalRssMb.toFixed(1)} MB`);
out.push(`peak slope:        ${peakSlope.toFixed(3)} MB/hr`);
out.push("");
out.push("per-segment:");
for (const s of segReports) {
  if (s.slope === null) {
    out.push(`  pid=${s.pid} n=${s.n} dur=${s.durHr.toFixed(2)}hr slope=n/a (${s.note})`);
  } else {
    out.push(`  pid=${s.pid} n=${s.n} dur=${s.durHr.toFixed(2)}hr slope=${s.slope.toFixed(3)} MB/hr`);
  }
}

const fails = [];
if (finalRssMb >= FINAL_RSS_LIMIT_MB) {
  fails.push(`FAIL: final RSS ${finalRssMb.toFixed(1)} MB >= limit ${FINAL_RSS_LIMIT_MB} MB`);
}
if (Math.abs(peakSlope) >= SLOPE_LIMIT_MB_PER_HR) {
  fails.push(`FAIL: peak slope ${peakSlope.toFixed(3)} MB/hr >= limit ${SLOPE_LIMIT_MB_PER_HR} MB/hr`);
}

out.push("");
if (fails.length === 0) {
  out.push("RESULT: PASS");
} else {
  out.push("RESULT: FAIL");
  for (const f of fails) out.push(`  ${f}`);
}

console.log(out.join("\n"));
process.exit(fails.length === 0 ? 0 : 1);

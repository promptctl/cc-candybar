// The benchmark: what a statusline tick costs, and what grows it.
//
//   pnpm build && pnpm bench                       everything
//   pnpm bench --only stages.draw                  the benchmarks whose id starts so
//   pnpm bench --list                              the ids, with what each measures
//   pnpm bench --out base.json                     keep the run
//   pnpm bench --baseline base.json                …and later, the run against it
//   pnpm bench --scale 0.2                         a quick pass: every sample count × 0.2
//
// Latencies are reported as distributions (p50/p90/p99, with n), beside the
// machine they ran on. There is no pass or fail on a number: a laptop's
// latencies are the laptop's. A benchmark that cannot vouch for its own
// samples is a failure, and the run exits non-zero.

import fs from "node:fs";
import { parseArgs } from "node:util";

import { captureEnvironment, loadNow } from "./environment.js";
import { formatReport, parseReport, rowsOf, type Report } from "./report.js";
import { BENCHMARKS } from "./suites/index.js";

const MIN_SAMPLES = 3;

const { values } = parseArgs({
  options: {
    only: { type: "string", multiple: true },
    scale: { type: "string", default: "1" },
    out: { type: "string" },
    baseline: { type: "string" },
    list: { type: "boolean", default: false },
  },
});

if (values.list) {
  for (const b of BENCHMARKS) console.log(`${b.id}  (${b.samples})  ${b.about}`);
  process.exit(0);
}

const scale = Number(values.scale);
if (!Number.isFinite(scale) || scale <= 0) {
  throw new Error(`--scale must be a positive number, got "${values.scale}"`);
}
const only = values.only ?? [];
const selected = BENCHMARKS.filter(
  (b) => only.length === 0 || only.some((prefix) => b.id.startsWith(prefix)),
);
if (selected.length === 0) {
  throw new Error(
    `--only ${only.join(", ")} selects no benchmark; --list names them`,
  );
}
// Read before anything runs: a baseline that cannot be read is found now, not
// after minutes of measuring.
const baseline =
  values.baseline === undefined
    ? null
    : parseReport(fs.readFileSync(values.baseline, "utf8"), values.baseline);

const environment = captureEnvironment();
const rows: Report["rows"][number][] = [];
const skipped: Report["skipped"][number][] = [];
const failed: Report["failed"][number][] = [];

for (const [i, b] of selected.entries()) {
  const samples = Math.max(MIN_SAMPLES, Math.round(b.samples * scale));
  console.error(`[${i + 1}/${selected.length}] ${b.id} (${samples})`);
  try {
    const outcome = await b.run({
      samples,
      note: (line) => console.error(`    ${line}`),
    });
    if (outcome.kind === "skipped") {
      skipped.push({ id: b.id, reason: outcome.reason });
    } else {
      rows.push(...rowsOf(b, outcome));
    }
  } catch (e) {
    // [LAW:no-silent-failure] Said, kept in the report, and the run goes on:
    // one broken benchmark does not discard minutes of the others.
    const error = e instanceof Error ? e.message : String(e);
    console.error(`    FAILED: ${error}`);
    failed.push({ id: b.id, error });
  }
}

const report: Report = {
  schema: 1,
  environment,
  loadAtEnd: loadNow(),
  scale,
  rows,
  skipped,
  failed,
};
if (values.out !== undefined) {
  fs.writeFileSync(values.out, JSON.stringify(report, null, 2) + "\n");
  console.error(`wrote ${values.out}`);
}
console.log(formatReport(report, baseline));
process.exit(failed.length > 0 ? 1 : 0);

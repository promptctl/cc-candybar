// Prints the layer report over a run's records (test-records/<run>.jsonl): count
// and time per layer, the pre-merge wall time, and every file that did not pass.
// In CI it also lands in the job summary. The records are the only input, so a
// number here is one a record holds. It is given the runs it is a report of,
// because a run that left no records has to fail the report and not read as quiet.
//
//   node scripts/test-report.mjs --runs worker,process

import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { missingRuns, renderSummary, summarise } = require("../test/helpers/test-records.cjs");
const { readQuarantine } = require("../test/helpers/quarantine.cjs");

const runsAt = process.argv.indexOf("--runs");
const runs = runsAt === -1 ? [] : (process.argv[runsAt + 1] ?? "").split(",").filter(Boolean);
if (runs.length === 0) throw new Error("--runs needs the runs to report, such as --runs worker,process");

const dir = path.resolve(import.meta.dirname, "..", "test-records");
// [LAW:no-silent-failure] A missing file throws here, naming the run.
const records = runs.flatMap((run) =>
  readFileSync(path.join(dir, `${run}.jsonl`), "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line)),
);
const missing = missingRuns(records, runs);
if (missing.length > 0) throw new Error(`no records for ${missing.join(", ")}`);

const report = renderSummary(
  summarise(records, readQuarantine(path.resolve(import.meta.dirname, "..")), Date.now()),
);
console.log(report);
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Tests by layer\n\n${report}\n`);
}

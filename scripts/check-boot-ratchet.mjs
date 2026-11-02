// Fails unless the cases under test/daemon-boots/ equal the ratchet
// (test/transitional-daemon-boots/ratchet.json), counted from the runs' records
// (test-records/<run>.jsonl). It is given the runs it counts, because a run that
// left no records has to fail and not read as a quiet one.
//
//   node scripts/check-boot-ratchet.mjs --runs worker,process

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { judgeBootCases, missingRuns } = require("../test/helpers/test-records.cjs");
const ratchet = require("../test/transitional-daemon-boots/ratchet.json");

const runsAt = process.argv.indexOf("--runs");
const runs = runsAt === -1 ? [] : (process.argv[runsAt + 1] ?? "").split(",").filter(Boolean);
if (runs.length === 0) throw new Error("--runs needs the runs to count, such as --runs worker,process");

const dir = path.resolve(import.meta.dirname, "..", "test-records");
// [LAW:no-silent-failure] A run that never reached its tests left no file, and
// reads as no records, so the throw below names the run and not a path.
const records = runs.flatMap((run) => {
  const file = path.join(dir, `${run}.jsonl`);
  return existsSync(file)
    ? readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line))
    : [];
});
const missing = missingRuns(records, runs);
if (missing.length > 0) throw new Error(`no records for ${missing.join(", ")}`);

const { cases, problems } = judgeBootCases(records, ratchet.cases);
console.log(`cases that boot the daemon: ${cases} of ${ratchet.cases} ratcheted`);
if (problems.length > 0) {
  console.error(`check-boot-ratchet:\n${problems.join("\n")}`);
  process.exit(1);
}

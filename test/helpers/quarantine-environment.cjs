// [LAW:single-enforcer] The one place a quarantined case leaves the gate. A case
// on the quarantine list still runs, and a failure still reaches the record, but
// jest counts it pending instead of failed, so it fails no run. An unlisted case
// is untouched.
//
// It leans on how jest-circus builds a result: from `test.status` (`skip` reads
// pending) and `test.errors` (kept, so the failure messages stay in the result
// the records reporter reads). test/integration/quarantine-gate.test.ts runs jest
// for real over fixtures, so a jest upgrade that changes it turns that red.
//
// What it lets through is whatever jest-circus charges to the listed case while
// it runs, and nothing else. The list's header (test/quarantine.txt) says where
// that stops.
//
// jest-environment-node is a dependency of its own, held at the version of the
// jest that loads this file: jest does not expose its copy, and the environment
// has to extend the one the run is built on.
//
// CommonJS because jest loads an environment untransformed.

const path = require("node:path");
const { TestEnvironment } = require("jest-environment-node");
const { caseName } = require("./test-records.cjs");
const { QUARANTINE_FILE, markError, quarantined, readQuarantine } = require("./quarantine.cjs");

/** The describe titles of a test from the outside in: the root block is the one with no parent. */
function caseNameOf(test) {
  const titles = [];
  for (let block = test.parent; block.parent !== undefined; block = block.parent) {
    titles.unshift(block.name);
  }
  return caseName(titles, test.name);
}

/** Every case of a file by name, with how many cases carry it. */
function countNames(block, titles, counts) {
  for (const child of block.children) {
    if (child.type === "describeBlock") {
      countNames(child, [...titles, child.name], counts);
    } else {
      const name = caseName(titles, child.name);
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
  return counts;
}

class QuarantineEnvironment extends TestEnvironment {
  constructor(config, context) {
    super(config, context);
    const { rootDir, testEnvironmentOptions } = config.projectConfig;
    this.file = path.relative(rootDir, context.testPath);
    this.list = testEnvironmentOptions.quarantine ?? QUARANTINE_FILE;
    this.entries = readQuarantine(rootDir, this.list);
  }

  handleTestEvent(event, state) {
    if (event.name === "run_start") return this.refuseAmbiguousLines(state);
    if (event.name !== "test_done" || event.test.errors.length === 0) return;
    const entry = quarantined(this.entries, this.file, caseNameOf(event.test));
    if (entry === undefined) return;
    event.test.errors.push(markError(entry.ticket));
    event.test.status = "skip";
  }

  // [LAW:no-silent-failure] jest allows two cases of one title in a file. A line
  // names one case, so a name that matches two lets through a failure the line
  // never meant to. The file errors, and nothing of that name is let through.
  refuseAmbiguousLines(state) {
    const counts = countNames(state.rootDescribeBlock, [], new Map());
    for (const entry of this.entries) {
      const matches = entry.file === this.file ? (counts.get(entry.name) ?? 0) : 0;
      if (matches > 1) {
        throw new Error(
          `${this.list}: ${entry.file} › ${entry.name} matches ${matches} cases, and a line names one; rename them`,
        );
      }
    }
  }
}

module.exports = QuarantineEnvironment;

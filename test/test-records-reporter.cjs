// [LAW:nothing-unseen] Writes one record per test file of a run to
// test-records/<run>.jsonl, which CI keeps as an artifact. The record's shape
// and every view over it live in helpers/test-records.cjs.
//
// A result exists only for a file that ran. Jest counts the files it scheduled
// after every narrowing (-o, --shard, path filters), so the count of files that
// gave no result is read off the run itself. Only when that count is above zero
// is jest's search asked which files they were, and a file with no result then
// reads never-ran, not absent.

const { mkdirSync, writeFileSync } = require("node:fs");
const path = require("node:path");
const { neverRan, recordOf } = require("./helpers/test-records.cjs");

// The files the config selects, by jest's own search. Imported here and not at
// the top so a test of the reporter does not load jest.
async function selectedBySearch(globalConfig, contexts) {
  const { SearchSource } = await import("jest");
  const selected = [];
  for (const context of contexts) {
    const { tests } = await new SearchSource(context).getTestPaths(globalConfig, context.config);
    selected.push(...tests.map((test) => test.path));
  }
  return selected;
}

class TestRecordsReporter {
  // `options.select` is how a test stands in for jest's search.
  constructor(globalConfig, options) {
    this.globalConfig = globalConfig;
    this.run = options.run;
    this.select = options.select ?? selectedBySearch;
    this.records = [];
    this.error = undefined;
  }

  onTestResult(_test, result) {
    this.records.push(recordOf(result, this.globalConfig.rootDir, this.run));
  }

  async onRunComplete(contexts, results) {
    try {
      const rootDir = this.globalConfig.rootDir;
      const lost = results.numTotalTestSuites - this.records.length;
      const lostFiles =
        lost === 0
          ? []
          : neverRan(
              (await this.select(this.globalConfig, contexts)).map((file) => path.relative(rootDir, file)),
              this.records,
              this.run,
            );
      // The search knows the config's files and not a narrowing of them, so a
      // run that lost files it cannot name has no honest record of which.
      if (lostFiles.length !== lost) {
        throw new Error(
          `jest scheduled ${results.numTotalTestSuites} files and ${this.records.length} gave a result, ` +
            `but the search names ${lostFiles.length} files with none`,
        );
      }
      const records = [...this.records, ...lostFiles];
      const dir = path.join(rootDir, "test-records");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        path.join(dir, `${this.run}.jsonl`),
        records.map((record) => JSON.stringify(record)).join("\n") + "\n",
      );
    } catch (error) {
      // [LAW:no-silent-failure] A run whose records are lost fails, because a
      // green run with no record is the gap this reporter exists to close.
      this.error = error;
    }
  }

  getLastError() {
    return this.error;
  }
}

module.exports = TestRecordsReporter;

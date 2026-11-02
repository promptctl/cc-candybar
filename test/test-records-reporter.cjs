// [LAW:nothing-unseen] Writes one record per test file of a run to
// test-records/<run>.jsonl, which CI keeps as an artifact. The record's shape
// and every view over it live in helpers/test-records.cjs.
//
// A result exists only for a file that ran, so the files the run selected are
// asked of jest's own search, which applies the same config and path filters the
// run did. A file with no result then reads never-ran, not absent.

const { mkdirSync, writeFileSync } = require("node:fs");
const path = require("node:path");
const { neverRan, recordOf } = require("./helpers/test-records.cjs");

// The files the run selected, by jest's own search. Imported here and not at the
// top so a test of the reporter does not load jest.
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

  async onRunComplete(contexts) {
    try {
      const rootDir = this.globalConfig.rootDir;
      const selected = (await this.select(this.globalConfig, contexts)).map((file) =>
        path.relative(rootDir, file),
      );
      const records = [...this.records, ...neverRan(selected, this.records, this.run)];
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

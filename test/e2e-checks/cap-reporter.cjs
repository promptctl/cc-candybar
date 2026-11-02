// The end-to-end cap: a run of the end-to-end config fails when it holds more
// tests than the sign-off allows. A jest reporter, because only the finished
// run knows how many tests it declared; getLastError() is how a reporter fails
// the run (test-records-reporter.cjs does the same).
//
// numTotalTests counts every declared test, skipped and todo included, so
// `test.skip` buys no room under the cap.

const { readSignoff } = require("./signoff.cjs");

/** @param {number} count @param {number} cap @returns {string | null} */
function capVerdict(count, cap) {
  return count > cap
    ? `end-to-end cap: ${count} tests declared, the sign-off allows ${cap}. Only Brandon raises the cap.`
    : null;
}

class CapReporter {
  constructor() {
    // Read at construction so a broken sign-off stops the run before any test.
    this.cap = readSignoff().cap;
    this.error = undefined;
  }

  onRunComplete(_contexts, results) {
    const verdict = capVerdict(results.numTotalTests, this.cap);
    this.error = verdict === null ? undefined : new Error(verdict);
    // [LAW:no-silent-failure] jest fails the run on a reporter's error and prints
    // nothing of it, so the reason is written here.
    if (verdict !== null) process.stderr.write(`\n${verdict}\n`);
  }

  getLastError() {
    return this.error;
  }
}

module.exports = CapReporter;
module.exports.capVerdict = capVerdict;

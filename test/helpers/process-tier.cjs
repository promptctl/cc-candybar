// [LAW:single-enforcer] The process tier: a test whose subject is the daemon
// process lives in a `*.process.test.ts` file, and only there may a real daemon
// start. This file holds what that rule is made of, and judges one run's starts.
// The rule is about a process entering the `daemon` subcommand, so it is read
// from what such a process recorded (daemon-ledger.cjs), whichever route brought
// it there. CommonJS because the preload and jest.worker.config.js load it
// untransformed.

// A string, because jest's testPathIgnorePatterns takes strings and fails on a
// RegExp.
const PROCESS_TIER_PATTERN = "\\.process\\.test\\.ts$";

// [LAW:verifiable-goals] The pin on a run's daemons, over the cases that spawn
// one through the helper. It is a maximum: a filtered run starts fewer, and a
// platform can skip a case. Raising it is a one-line diff, which is the point.
const HELPER_START_CEILING = 30;

const LEDGER_ENV = "CC_CANDYBAR_TEST_DAEMON_LEDGER";
const TEST_FILE_ENV = "CC_CANDYBAR_TEST_FILE";
const ROUTE_ENV = "CC_CANDYBAR_TEST_DAEMON_ROUTE";

/**
 * @typedef {"helper" | "client" | "raw"} DaemonRoute
 * @typedef {{ file: string | null, route: DaemonRoute }} DaemonStart
 * @typedef {{ helper: number, client: number, problems: string[] }} DaemonVerdict
 */

/** @param {string} ledger @returns {DaemonStart[]} */
function parseLedger(ledger) {
  return ledger
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line));
}

/** @param {DaemonStart} start @returns {string | null} */
function faultOf({ file, route }) {
  if (file === null) {
    return "a daemon started by a process that carries no test file, so it was spawned with no env";
  }
  if (!new RegExp(PROCESS_TIER_PATTERN).test(file)) {
    return `${file} started a real daemon (${route}): only a *.process.test.ts file may, and any other test takes the in-worker harness`;
  }
  // [LAW:single-enforcer] A spawn of its own takes no pool slot and no count, so
  // the tier is no excuse for one.
  if (route === "raw") {
    return `${file} started a daemon by a spawn of its own: it goes through spawnTestDaemon`;
  }
  return null;
}

/**
 * `client` starts are judged by file and left out of the ceiling. A real client
 * under load draws a blank line and kicks a respawn, so that count is the
 * machine's, and a ceiling over it would flake or need a margin that hides creep.
 * @param {DaemonStart[]} starts
 * @param {number} ceiling
 * @returns {DaemonVerdict}
 */
function judgeDaemonStarts(starts, ceiling) {
  const count = (/** @type {DaemonRoute} */ route) =>
    starts.filter((s) => s.route === route).length;
  const helper = count("helper");
  const over =
    helper > ceiling
      ? [
          `${helper} helper daemon starts, over the ceiling of ${ceiling}: move a case to the in-worker harness, or raise the ceiling in test/helpers/process-tier.cjs and say why`,
        ]
      : [];
  const faults = starts.map(faultOf).filter((fault) => fault !== null);
  return { helper, client: count("client"), problems: [...new Set(faults), ...over] };
}

module.exports = {
  HELPER_START_CEILING,
  LEDGER_ENV,
  PROCESS_TIER_PATTERN,
  ROUTE_ENV,
  TEST_FILE_ENV,
  judgeDaemonStarts,
  parseLedger,
};

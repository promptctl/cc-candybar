// [LAW:single-enforcer] Where a daemon may boot. A test that boots one lives under
// test/daemon-boots/, and only a file under test/daemon-boots/process/ may start
// a real one. This file holds what that rule is made of, and judges one run's
// starts. The rule is read from what each boot recorded (daemon-ledger.cjs for a
// process entering the `daemon` subcommand, the harness for a daemon built in a
// jest worker), whichever route brought it there. CommonJS because the preload
// and the jest configs load it untransformed.

const fs = require("node:fs");

const { BOOTS_DIR, PROCESS_TIER_DIR } = require("./tiers.cjs");
const ratchet = require("../transitional-daemon-boots/ratchet.json");

// [LAW:verifiable-goals] The pin on a run's daemons, over the cases that spawn
// one through the helper. It is a maximum: a filtered run starts fewer, and a
// platform can skip a case. It only falls: CI fails a change that raises it
// above what `main` holds (scripts/check-shrinks.cjs), and ticket
// candybar-testing-ihvy.4vv deletes it with the ratchet file it lives in.
const HELPER_START_CEILING = ratchet.helperStarts;

const LEDGER_ENV = "CC_CANDYBAR_TEST_DAEMON_LEDGER";
const TEST_FILE_ENV = "CC_CANDYBAR_TEST_FILE";
const ROUTE_ENV = "CC_CANDYBAR_TEST_DAEMON_ROUTE";

/**
 * `harness` is a daemon built in a jest worker, the only boot that is no process.
 * @typedef {"helper" | "client" | "raw" | "harness"} DaemonRoute
 * @typedef {{ file: string | null, route: DaemonRoute }} DaemonStart
 * @typedef {{ helper: number, client: number, harness: number, problems: string[] }} DaemonVerdict
 */

/**
 * [LAW:single-enforcer] The one writer of a ledger line, so a boot of any route
 * is recorded in the same shape. [LAW:no-silent-failure] The ledger is opened
 * without create, so a boot that cannot be recorded throws: an append would bring
 * a deleted ledger back holding only the lines after the delete, and teardown
 * would judge those as the whole run.
 * @param {{ ledger: string, file: string | null, route: DaemonRoute }} start
 */
function recordDaemonStart({ ledger, file, route }) {
  const fd = fs.openSync(ledger, fs.constants.O_WRONLY | fs.constants.O_APPEND);
  try {
    fs.writeSync(fd, `${JSON.stringify({ file, route })}\n`);
  } finally {
    fs.closeSync(fd);
  }
}

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
  // A harness boot is allowed in either child of the directory: the process tier
  // is the stricter rule, and it asks only about real daemons.
  if (route === "harness") {
    return file.startsWith(`${BOOTS_DIR}/`)
      ? null
      : `${file} booted a daemon in the jest worker: only a file under ${BOOTS_DIR}/ may, and a case that boots none of it belongs in test/unit or the test/ root`;
  }
  if (!file.startsWith(`${PROCESS_TIER_DIR}/`)) {
    return `${file} started a real daemon (${route}): only a file under ${PROCESS_TIER_DIR}/ may, and any other test takes the in-worker harness`;
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
 * `harness` boots are judged by file and counted by the case ratchet, which reads
 * cases and not starts (scripts/check-boot-ratchet.mjs).
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
          `${helper} helper daemon starts, over the ceiling of ${ceiling}: a case that starts a real daemon has to leave the process tier or share a start, because the ceiling only falls`,
        ]
      : [];
  const faults = starts.map(faultOf).filter((fault) => fault !== null);
  return {
    helper,
    client: count("client"),
    harness: count("harness"),
    problems: [...new Set(faults), ...over],
  };
}

module.exports = {
  HELPER_START_CEILING,
  LEDGER_ENV,
  ROUTE_ENV,
  TEST_FILE_ENV,
  judgeDaemonStarts,
  parseLedger,
  recordDaemonStart,
};

// [LAW:one-source-of-truth] The record of a test file, and every view over it.
// A CI run keeps one record per file; the layer report, and later the flake rate
// and the budget checks, read the records and keep no number of their own.
// CommonJS because the reporter and the report script load it untransformed.

const path = require("node:path");
const { EXPIRY_DAYS, ageDays, expired, markedTicket } = require("./quarantine.cjs");

// A file's layer is the first directory under test/ that holds it, and `root`
// for a file directly in test/, the transitional layer the layered plan empties.
// The names are not listed here: which directories are layers is the plan's to
// say, and a directory nobody named shows in the report as a layer of its own
// rather than reading as root.
const ROOT_LAYER = "root";

// [LAW:one-source-of-truth] exception: jest builds this failure for a file with
// no test (@jest/core's TestScheduler) and exports nothing to compare against.
// A file that fails to load arrives in the same shape, and the message is the
// only difference. On a jest upgrade, compare it with the scheduler's.
const NO_TEST_MESSAGE = "Your test suite must contain at least one test.";

/**
 * @typedef {"passed" | "failed" | "errored" | "empty" | "skipped"} RanOutcome
 * @typedef {{ name: string, outcome: string, durationMs: number, quarantined?: string }} CaseRecord
 * `quarantined` is the ticket of a line the quarantine let the case's failure through on.
 * A file that ran. `startedAt` and `endedAt` are epoch milliseconds, so a run's
 * wall time is read off its records. They are null for a file whose result jest
 * built itself (no test, failed to load), which carries zeros there.
 * @typedef {{
 *   file: string, layer: string, run: string, count: number, durationMs: number,
 *   startedAt: number | null, endedAt: number | null, outcome: RanOutcome, cases: CaseRecord[],
 * }} RanRecord
 * A file the run selected and produced no result for. It has no count and no
 * time, because a zero there would be summed into its layer as a measurement.
 * @typedef {{ file: string, layer: string, run: string, outcome: "never-ran" }} NeverRanRecord
 * @typedef {RanRecord | NeverRanRecord} FileRecord
 */

/** @param {string} file path relative to the repository root @returns {string} */
function layerOf(file) {
  const parts = file.split(path.sep);
  return parts[0] === "test" && parts.length > 2 ? parts[1] : ROOT_LAYER;
}

/**
 * `empty` is a file that loaded and held no case; `errored` is one that did not
 * run (it failed to load, or a hook threw); `failed` ran and some case did not
 * pass.
 * @param {{ testExecError?: { message?: string }, numFailingTests: number, numPassingTests: number }} result
 * @returns {RanOutcome}
 */
function outcomeOf(result) {
  if (result.testExecError) {
    return result.testExecError.message === NO_TEST_MESSAGE ? "empty" : "errored";
  }
  if (result.numFailingTests > 0) return "failed";
  if (result.numPassingTests > 0) return "passed";
  return "skipped";
}

// [LAW:one-source-of-truth] A case's name is how a record and a quarantine line
// both name it; the quarantine environment builds it from the same parts.
/** @param {string[]} ancestorTitles @param {string} title @returns {string} */
function caseName(ancestorTitles, title) {
  return [...ancestorTitles, title].join(" › ");
}

/**
 * [LAW:nothing-unseen] A case that carries failure messages failed, whatever
 * status jest gave it: a case the quarantine let through arrives pending with
 * its messages kept, and so does a skipped case under a failing beforeAll. What
 * tells them apart is the mark the environment left when it made the decision
 * (quarantine.cjs), so the record carries the decision as it was made and
 * matches nothing. The report joins the list to these records by name.
 * @param {{ ancestorTitles: string[], title: string, status: string, failureMessages: string[], duration?: number | null }} test
 * @returns {CaseRecord}
 */
function caseRecord(test) {
  const ticket = markedTicket(test.failureMessages);
  return {
    name: caseName(test.ancestorTitles, test.title),
    outcome: test.failureMessages.length > 0 ? "failed" : test.status,
    durationMs: test.duration ?? 0,
    ...(ticket === undefined ? {} : { quarantined: ticket }),
  };
}

/**
 * A file's outcome is derived from its cases, so the two fields cannot disagree
 * and a file with a failed case reads failed, however the gate treated it. The
 * gate's verdict is jest's exit code and no field of a record.
 * @param {{ testFilePath: string, testResults: Array<{ ancestorTitles: string[], title: string, status: string, failureMessages: string[], duration?: number | null }>, perfStats: { runtime: number, start: number, end: number }, testExecError?: { message?: string }, numFailingTests: number, numPassingTests: number }} result
 * @param {string} rootDir
 * @param {string} run
 * @returns {RanRecord}
 */
function recordOf(result, rootDir, run) {
  const file = path.relative(rootDir, result.testFilePath);
  const cases = result.testResults.map(caseRecord);
  // Jest counts a failing test by its status, so a failed case it gave another
  // status (pending, from the quarantine) is added to what it counted.
  const uncounted = result.testResults.filter((t) => t.status !== "failed" && t.failureMessages.length > 0).length;
  return {
    file,
    layer: layerOf(file),
    run,
    count: cases.length,
    durationMs: result.perfStats.runtime,
    startedAt: result.perfStats.start || null,
    endedAt: result.perfStats.end || null,
    outcome: outcomeOf({ ...result, numFailingTests: result.numFailingTests + uncounted }),
    cases,
  };
}

/**
 * Without a record of its own, a file the run lost would vanish from every
 * count, which is how a lost file passes for a green run.
 * @param {string[]} selected paths relative to the repository root
 * @param {FileRecord[]} records
 * @param {string} run
 * @returns {NeverRanRecord[]}
 */
function neverRan(selected, records, run) {
  const seen = new Set(records.map((record) => record.file));
  return selected
    .filter((file) => !seen.has(file))
    .map((file) => ({ file, layer: layerOf(file), run, outcome: "never-ran" }));
}

/**
 * A run whose records are absent has to read as absent. A report over whichever
 * files happen to exist would show a tier that never ran as a quiet one.
 * @param {FileRecord[]} records
 * @param {string[]} expected the runs this report is a report of
 * @returns {string[]}
 */
function missingRuns(records, expected) {
  const present = new Set(records.map((record) => record.run));
  return expected.filter((run) => !present.has(run));
}

/**
 * What a run that ran the file did with a listed case. A file that errored holds
 * no cases, so a line the environment refused (two cases of its name) and a file
 * that failed to load both read as the file's error, not as a missing case.
 * @param {RanRecord} record
 * @param {string} name
 */
function thisRunOf(record, name) {
  const found = record.cases.find((c) => c.name === name);
  if (found !== undefined) return found.outcome;
  return record.outcome === "errored" ? "file errored" : "not in the file";
}

/**
 * Each listed case with how long it has been listed and what the run did with
 * it, which is all this says: a flake passes most runs, so a pass is no sign it
 * is fixed, and lit holds that. A file the records do not hold reads "no
 * record": a run this report is not over. This joins the list to the records to display it; the
 * gate decision is made once, in quarantine-environment.cjs.
 * @param {FileRecord[]} records
 * @param {import("./quarantine.cjs").QuarantineEntry[]} entries
 * @param {number} now epoch ms
 */
function quarantineView(records, entries, now) {
  return entries.map((entry) => {
    const record = records.find((r) => r.file === entry.file && r.outcome !== "never-ran");
    return {
      ...entry,
      ageDays: ageDays(entry, now),
      expired: expired(entry, now),
      thisRun: record === undefined ? "no record" : thisRunOf(record, entry.name),
    };
  });
}

/**
 * @param {FileRecord[]} records
 * @param {import("./quarantine.cjs").QuarantineEntry[]} entries the quarantine list
 * @param {number} now epoch ms, the day the list is read against
 */
function summarise(records, entries, now) {
  /** @type {Map<string, { layer: string, files: number, cases: number, durationMs: number, neverRan: number }>} */
  const byLayer = new Map();
  /** @type {Map<string, { run: string, startedAt: number, endedAt: number }>} */
  const byRun = new Map();
  for (const record of records) {
    const row = byLayer.get(record.layer) ?? {
      layer: record.layer,
      files: 0,
      cases: 0,
      durationMs: 0,
      neverRan: 0,
    };
    row.files += 1;
    if (record.outcome === "never-ran") {
      row.neverRan += 1;
    } else {
      row.cases += record.count;
      row.durationMs += record.durationMs;
    }
    if (record.outcome !== "never-ran" && record.startedAt !== null && record.endedAt !== null) {
      const run = byRun.get(record.run) ?? {
        run: record.run,
        startedAt: record.startedAt,
        endedAt: record.endedAt,
      };
      run.startedAt = Math.min(run.startedAt, record.startedAt);
      run.endedAt = Math.max(run.endedAt, record.endedAt);
      byRun.set(record.run, run);
    }
    byLayer.set(record.layer, row);
  }
  const runs = [...byRun.values()]
    .map((run) => ({ run: run.run, wallMs: run.endedAt - run.startedAt }))
    .sort((a, b) => a.run.localeCompare(b.run));
  return {
    layers: [...byLayer.values()].sort((a, b) => a.layer.localeCompare(b.layer)),
    runs,
    // The span of each run's test files, summed over the runs: the installs and
    // the build between the runs are not tests, and neither are jest's global
    // setup and teardown, which no record sees.
    wallMs: runs.reduce((sum, run) => sum + run.wallMs, 0),
    notPassed: records.filter((r) => r.outcome !== "passed"),
    quarantine: quarantineView(records, entries, now),
  };
}

/** @param {number} ms */
function seconds(ms) {
  return `${(ms / 1000).toFixed(1)} s`;
}

/** @param {ReturnType<typeof summarise>} summary @returns {string} markdown */
function renderSummary({ layers, runs, wallMs, notPassed, quarantine }) {
  const rows = layers.map(
    (row) =>
      `| ${row.layer} | ${row.files} | ${row.cases} | ${seconds(row.durationMs)} | ${row.neverRan} |`,
  );
  const lines = [
    "| Layer | Files | Cases | File time | Never ran |",
    "|---|---:|---:|---:|---:|",
    ...rows,
    "",
    `Jest wall time, pre-merge (first file start to last file end): ${seconds(wallMs)} (${runs
      .map((run) => `${run.run} ${seconds(run.wallMs)}`)
      .join(", ")})`,
  ];
  if (notPassed.length > 0) {
    lines.push("", "Files that did not pass:");
    lines.push(
      ...notPassed.map((r) => {
        const failed = (r.cases ?? []).filter((c) => c.outcome === "failed").length;
        const letThrough = (r.cases ?? []).filter((c) => c.quarantined !== undefined).length;
        // A failed case the quarantine let through did not fail its run.
        return letThrough === 0
          ? `- ${r.file}: ${r.outcome}`
          : `- ${r.file}: ${r.outcome} (${failed} failed, ${letThrough} of them let through by the quarantine)`;
      }),
    );
  }
  if (quarantine.length > 0) {
    const late = quarantine.filter((entry) => entry.expired).length;
    lines.push(
      "",
      `Quarantine: ${quarantine.length} listed, ${late} red. A line dated more than ${EXPIRY_DAYS} days ago, or in the future, is red and fails nothing; fix the test or delete it.`,
    );
    lines.push(
      ...quarantine.map((entry) => {
        const dated = entry.ageDays < 0 ? `dated ${-entry.ageDays} days ahead` : `listed ${entry.ageDays} days ago`;
        return `- ${entry.expired ? "🔴" : "⚪"} ${entry.file} › ${entry.name} (${entry.ticket}): ${entry.thisRun} this run, ${dated}`;
      }),
    );
  }
  return lines.join("\n");
}

module.exports = {
  caseName,
  layerOf,
  missingRuns,
  neverRan,
  outcomeOf,
  recordOf,
  renderSummary,
  summarise,
};

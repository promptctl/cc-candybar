// [LAW:one-source-of-truth] The record of a test file, and every view over it.
// A CI run keeps one record per file; the layer report, and later the flake rate
// and the budget checks, read the records and keep no number of their own.
// CommonJS because the reporter and the report script load it untransformed.

const path = require("node:path");

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
 * @typedef {{ name: string, outcome: string, durationMs: number }} CaseRecord
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

/**
 * @param {{ testFilePath: string, testResults: Array<{ ancestorTitles: string[], title: string, status: string, duration?: number | null }>, perfStats: { runtime: number, start: number, end: number }, testExecError?: { message?: string }, numFailingTests: number, numPassingTests: number }} result
 * @param {string} rootDir
 * @param {string} run
 * @returns {RanRecord}
 */
function recordOf(result, rootDir, run) {
  const file = path.relative(rootDir, result.testFilePath);
  const cases = result.testResults.map((test) => ({
    name: [...test.ancestorTitles, test.title].join(" › "),
    outcome: test.status,
    durationMs: test.duration ?? 0,
  }));
  return {
    file,
    layer: layerOf(file),
    run,
    count: cases.length,
    durationMs: result.perfStats.runtime,
    startedAt: result.perfStats.start || null,
    endedAt: result.perfStats.end || null,
    outcome: outcomeOf(result),
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

/** @param {FileRecord[]} records */
function summarise(records) {
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
  };
}

/** @param {number} ms */
function seconds(ms) {
  return `${(ms / 1000).toFixed(1)} s`;
}

/** @param {ReturnType<typeof summarise>} summary @returns {string} markdown */
function renderSummary({ layers, runs, wallMs, notPassed }) {
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
    lines.push(...notPassed.map((r) => `- ${r.file}: ${r.outcome}`));
  }
  return lines.join("\n");
}

module.exports = {
  layerOf,
  missingRuns,
  neverRan,
  outcomeOf,
  recordOf,
  renderSummary,
  summarise,
};

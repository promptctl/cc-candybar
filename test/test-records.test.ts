import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";

const records = createRequire(__filename)("./helpers/test-records.cjs");

const ROOT = "/repo";
// The shape jest gives a reporter. A file with no test arrives as a failed
// suite whose exec error says so, and a file that fails to load arrives the
// same way with its own message.
const NO_TEST = { message: "Your test suite must contain at least one test." };
const result = (file: string, over: object = {}, root = ROOT) => ({
  testFilePath: path.join(root, file),
  testResults: [{ ancestorTitles: ["a"], title: "b", status: "passed", failureMessages: [], duration: 5 }],
  perfStats: { runtime: 100, start: 1_000, end: 1_100 },
  numFailingTests: 0,
  numPassingTests: 1,
  ...over,
});
type Row = { file: string; outcome: string };
const NOW = Date.UTC(2026, 10, 12);
const outcome = (over: object) =>
  records.recordOf(result("test/a.test.ts", over), ROOT, "all").outcome;

describe("test records", () => {
  it("places a file in the first directory under test/ that holds it", () => {
    expect(records.layerOf("test/unit/a.test.ts")).toBe("unit");
    expect(records.layerOf("test/daemon-boots/worker/a.test.ts")).toBe("daemon-boots");
    expect(records.layerOf("test/proc/a.test.ts")).toBe("proc");
    expect(records.layerOf("test/a.test.ts")).toBe("root");
  });

  it("reads a file with no test as empty, and one that failed to load as errored", () => {
    expect(outcome({ testResults: [], numPassingTests: 0, testExecError: NO_TEST })).toBe("empty");
    expect(
      outcome({ testResults: [], numPassingTests: 0, testExecError: { message: "SyntaxError" } }),
    ).toBe("errored");
  });

  it("reads a file whose cases ran by what they did", () => {
    expect(outcome({})).toBe("passed");
    expect(outcome({ numFailingTests: 1 })).toBe("failed");
    expect(outcome({ numPassingTests: 0 })).toBe("skipped");
  });

  it("gives a file the run lost a record with no count and no time", () => {
    const ran = records.recordOf(result("test/a.test.ts"), ROOT, "all");
    expect(records.neverRan(["test/a.test.ts", "test/b.test.ts"], [ran], "all")).toEqual([
      { file: "test/b.test.ts", layer: "root", run: "all", outcome: "never-ran" },
    ]);
  });

  it("sums every record into its layer and states each run's wall time", () => {
    const at = (start: number, end: number) => ({ perfStats: { runtime: 100, start, end } });
    const all = [
      records.recordOf(result("test/unit/a.test.ts", at(1_000, 3_000)), ROOT, "worker"),
      records.recordOf(result("test/b.test.ts", at(2_000, 6_000)), ROOT, "worker"),
      records.recordOf(result("test/c.test.ts", { numFailingTests: 1, ...at(10_000, 11_000) }), ROOT, "process"),
      ...records.neverRan(["test/d.test.ts"], [], "process"),
    ];
    const summary = records.summarise(all, [], NOW);
    expect(summary.layers).toEqual([
      { layer: "root", files: 3, cases: 2, durationMs: 200, neverRan: 1 },
      { layer: "unit", files: 1, cases: 1, durationMs: 100, neverRan: 0 },
    ]);
    expect(summary.runs).toEqual([
      { run: "process", wallMs: 0 + 1_000 },
      { run: "worker", wallMs: 5_000 },
    ]);
    expect(summary.wallMs).toBe(6_000);
    expect(summary.notPassed.map((r: Row) => r.file)).toEqual(["test/c.test.ts", "test/d.test.ts"]);
    expect(records.renderSummary(summary)).toContain("Jest wall time, pre-merge (first file start to last file end): 6.0 s");
  });

  it("leaves a file jest built the result of out of the wall time", () => {
    const built = result("test/a.test.ts", {
      testResults: [],
      numPassingTests: 0,
      testExecError: NO_TEST,
      perfStats: { runtime: 0, start: 0, end: 0 },
    });
    const ran = records.recordOf(result("test/b.test.ts"), ROOT, "all");
    expect(records.summarise([records.recordOf(built, ROOT, "all"), ran], [], NOW).wallMs).toBe(100);
  });

  it("names a run that left no records", () => {
    const ran = records.recordOf(result("test/a.test.ts"), ROOT, "worker");
    expect(records.missingRuns([ran], ["worker", "process"])).toEqual(["process"]);
  });
});

describe("the quarantine in the records", () => {
  const entries = createRequire(__filename)("./helpers/quarantine.cjs").parseQuarantine(
    [
      "2026-11-02 abc-1.x test/a.test.ts › a › b",
      "2026-11-01 abc-2.y test/gone.test.ts › a case no run holds",
      "2026-10-20 abc-3.z test/a.test.ts › a › c",
    ].join("\n"),
  );
  // What jest hands a reporter for a case the quarantine let through: pending, with
  // the failure kept and the environment's mark after it.
  const kept = {
    ancestorTitles: ["a"],
    title: "b",
    status: "pending",
    failureMessages: ["Error: boom\n    at x", "QuarantineMark: quarantined: abc-1.x\n    at y"],
    duration: 5,
  };
  const passed = { ancestorTitles: ["a"], title: "c", status: "passed", failureMessages: [], duration: 5 };
  const skipped = { ancestorTitles: ["a"], title: "d", status: "pending", failureMessages: [], duration: 0 };
  // The same status and a failure with no mark: a skipped case under a failing beforeAll.
  const skippedUnderFailure = { ...skipped, title: "e", failureMessages: ["Error: beforeAll threw"] };

  it("reads a case that carries failure messages as failed, and names the ticket only when the environment marked it", () => {
    const record = records.recordOf(
      result("test/a.test.ts", {
        testResults: [kept, passed, skipped, skippedUnderFailure],
        numFailingTests: 0,
        numPassingTests: 1,
      }),
      ROOT,
      "all",
    );
    expect(record.cases).toEqual([
      { name: "a › b", outcome: "failed", durationMs: 5, quarantined: "abc-1.x" },
      { name: "a › c", outcome: "passed", durationMs: 5 },
      { name: "a › d", outcome: "pending", durationMs: 0 },
      { name: "a › e", outcome: "failed", durationMs: 0 },
    ]);
  });

  it("says how many of a file's failed cases the quarantine let through", () => {
    const alone = records.recordOf(result("test/a.test.ts", { testResults: [kept, passed] }), ROOT, "all");
    const beside = records.recordOf(
      result("test/b.test.ts", { testResults: [kept, skippedUnderFailure], numFailingTests: 0 }),
      ROOT,
      "all",
    );
    const text = records.renderSummary(records.summarise([alone, beside], [], NOW));
    expect(text).toContain("- test/a.test.ts: failed (1 failed, 1 of them let through by the quarantine)");
    expect(text).toContain("- test/b.test.ts: failed (2 failed, 1 of them let through by the quarantine)");
  });

  it("derives a file's outcome from its cases, so a file with a failed case never reads passed or skipped", () => {
    const only = records.recordOf(
      result("test/a.test.ts", { testResults: [kept], numFailingTests: 0, numPassingTests: 0 }),
      ROOT,
      "all",
    );
    const beside = records.recordOf(
      result("test/a.test.ts", { testResults: [kept, passed], numFailingTests: 0, numPassingTests: 1 }),
      ROOT,
      "all",
    );
    expect([only.outcome, beside.outcome]).toEqual(["failed", "failed"]);
    expect(records.summarise([only, beside], [], NOW).notPassed).toHaveLength(2);
  });

  it("shows a line older than 7 days red, says what this run did with each case, and fails nothing", () => {
    const ran = records.recordOf(result("test/a.test.ts", { testResults: [kept, passed] }), ROOT, "all");
    const summary = records.summarise([ran], entries, NOW);
    expect(
      summary.quarantine.map((e: { ticket: string; ageDays: number; expired: boolean; thisRun: string }) => [
        e.ticket,
        e.ageDays,
        e.expired,
        e.thisRun,
      ]),
    ).toEqual([
      ["abc-1.x", 10, true, "failed"],
      ["abc-2.y", 11, true, "no record"],
      ["abc-3.z", 23, true, "passed"],
    ]);
    const text = records.renderSummary(summary);
    expect(text).toContain("Quarantine: 3 listed, 3 red.");
    expect(text).toContain("🔴 test/a.test.ts › a › b (abc-1.x): failed this run, listed 10 days ago");
    expect(text).toContain("(abc-3.z): passed this run, listed 23 days ago");
    expect(text).not.toContain("can go");
  });

  it("names why a line has no case in a run that ran its file: the file errored, or the case is not in it", () => {
    const errored = records.recordOf(
      result("test/a.test.ts", {
        testResults: [],
        numPassingTests: 0,
        testExecError: { message: "a listed name matches 2 cases" },
      }),
      ROOT,
      "all",
    );
    const lacking = records.recordOf(result("test/a.test.ts", { testResults: [passed] }), ROOT, "all");
    const one = entries.slice(0, 1);
    expect(records.summarise([errored], one, NOW).quarantine[0].thisRun).toBe("file errored");
    expect(records.summarise([lacking], one, NOW).quarantine[0].thisRun).toBe("not in the file");
    expect(records.summarise([], one, NOW).quarantine[0].thisRun).toBe("no record");
  });

  it("shows a line dated in the future as red and says so", () => {
    const future = createRequire(__filename)("./helpers/quarantine.cjs").parseQuarantine(
      "2062-11-02 abc-4.w test/a.test.ts › a › b",
    );
    const text = records.renderSummary(records.summarise([], future, NOW));
    expect(text).toContain("Quarantine: 1 listed, 1 red.");
    expect(text).toContain("🔴 test/a.test.ts › a › b (abc-4.w): no record this run, dated ");
    expect(text).toContain(" days ahead");
  });

  it("shows a line inside its week as not red, and prints nothing when the list is empty", () => {
    const fresh = records.summarise([], entries.slice(0, 1), Date.UTC(2026, 10, 3));
    expect(records.renderSummary(fresh)).toContain("⚪ test/a.test.ts › a › b (abc-1.x): no record this run, listed 1 days ago");
    expect(records.renderSummary(records.summarise([], [], NOW))).not.toContain("Quarantine");
  });
});

describe("the records reporter", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "records-reporter-"));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  const reporterOver = (rootDir: string, selected: string[]) => {
    const Reporter = createRequire(__filename)("./test-records-reporter.cjs");
    return new Reporter({ rootDir }, { run: "worker", select: async () => selected });
  };
  const scheduled = (numTotalTestSuites: number) => ({ numTotalTestSuites });
  const written = (rootDir: string): Row[] =>
    fs
      .readFileSync(path.join(rootDir, "test-records", "worker.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

  it("writes a ran file, an empty file and a selected file that never produced a result", async () => {
    const root = path.join(dir, "ok");
    const reporter = reporterOver(root, [
      path.join(root, "test/ran.test.ts"),
      path.join(root, "test/empty.test.ts"),
      path.join(root, "test/lost.test.ts"),
    ]);
    reporter.onTestResult({}, result("test/ran.test.ts", {}, root));
    reporter.onTestResult(
      {},
      result("test/empty.test.ts", { testResults: [], numPassingTests: 0, testExecError: NO_TEST }, root),
    );
    await reporter.onRunComplete(new Set(), scheduled(3));
    expect(reporter.getLastError()).toBeUndefined();
    expect(written(root).map((r) => [path.basename(r.file), r.outcome])).toEqual([
      ["ran.test.ts", "passed"],
      ["empty.test.ts", "empty"],
      ["lost.test.ts", "never-ran"],
    ]);
  });

  it("fails the run when the records cannot be written", async () => {
    const blocked = path.join(dir, "blocked");
    fs.writeFileSync(blocked, "a file where the directory would go");
    const reporter = reporterOver(blocked, []);
    await reporter.onRunComplete(new Set(), scheduled(0));
    expect(String(reporter.getLastError())).toMatch(/ENOTDIR|EEXIST/);
  });

  it("does not ask the search for a run that lost nothing, so -o and --shard runs record", async () => {
    const root = path.join(dir, "narrowed");
    const Reporter = createRequire(__filename)("./test-records-reporter.cjs");
    const reporter = new Reporter(
      { rootDir: root },
      { run: "worker", select: async () => { throw new Error("Changed files must be set when running with -o."); } },
    );
    reporter.onTestResult({}, result("test/ran.test.ts", {}, root));
    await reporter.onRunComplete(new Set(), scheduled(1));
    expect(reporter.getLastError()).toBeUndefined();
    expect(written(root).map((r) => r.outcome)).toEqual(["passed"]);
  });

  it("fails the run that lost a file the search cannot name", async () => {
    const root = path.join(dir, "unnamed");
    const reporter = reporterOver(root, [path.join(root, "test/ran.test.ts")]);
    reporter.onTestResult({}, result("test/ran.test.ts", {}, root));
    await reporter.onRunComplete(new Set(), scheduled(2));
    expect(String(reporter.getLastError())).toMatch(/scheduled 2 files and 1 gave a result/);
  });
});

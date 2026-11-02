import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Real jest over the fixtures in test/helpers/quarantine-fixtures, through
// jest.quarantine-fixtures.config.js. A listed case that fails has to leave its
// run green and keep its failure; the same case with the list emptied, and a
// failing case that was never listed, have to fail theirs. The pair is what
// shows the list, and nothing else, moved the gate.

const ROOT = resolve(__dirname, "../..");
const JEST = join(ROOT, "node_modules", "jest", "bin", "jest.js");
const FIXTURES = "test/helpers/quarantine-fixtures";
const records = createRequire(__filename)("../helpers/test-records.cjs");
const quarantine = createRequire(__filename)("../helpers/quarantine.cjs");

interface Case {
  title: string;
  ancestorTitles: string[];
  status: string;
  failureMessages: string[];
}
interface Run {
  exitCode: number | null;
  file: { name: string; message: string; assertionResults: Case[] };
  numFailedTests: number;
  /** What the run's reporters printed. */
  output: string;
}

// `list` is a path under the repository root, or undefined for the config's own.
const runJest = async (fixture: string, list?: string): Promise<Run> => {
  const dir = mkdtempSync(join(tmpdir(), "quarantine-gate-"));
  const json = join(dir, "result.json");
  try {
    const args = [
      JEST,
      "--config",
      "jest.quarantine-fixtures.config.js",
      "--json",
      `--outputFile=${json}`,
      ...(list ? ["--testEnvironmentOptions", JSON.stringify({ quarantine: list })] : []),
      `${FIXTURES}/${fixture}`,
    ];
    const { exitCode, output } = await new Promise<{ exitCode: number | null; output: string }>(
      (resolveRun, reject) => {
        const child = spawn(process.execPath, args, { cwd: ROOT });
        let text = "";
        child.stdout.on("data", (chunk) => (text += chunk));
        child.stderr.on("data", (chunk) => (text += chunk));
        child.on("error", reject);
        child.on("close", (code) => resolveRun({ exitCode: code, output: text }));
      },
    );
    try {
      const result = JSON.parse(readFileSync(json, "utf8"));
      return { exitCode, file: result.testResults[0], numFailedTests: result.numFailedTests, output };
    } catch (error) {
      throw new Error(`jest wrote no result over ${fixture}:\n${output}\n${error}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

type Row = { name: string; outcome: string };

// A file that names its own environment runs outside the quarantine's, so a line
// naming its cases would be accepted and never honoured.
const namesItsEnvironment = (source: string) =>
  /@jest-environment\b/.test(/^\s*\/\*[\s\S]*?\*\//.exec(source)?.[0] ?? "");

// The record the reporter would write for this file, built from jest's own result.
const recordOfRun = (run: Run) => {
  const count = (status: string) => run.file.assertionResults.filter((c) => c.status === status).length;
  return records.recordOf(
    {
      testFilePath: run.file.name,
      testResults: run.file.assertionResults,
      perfStats: { runtime: 1, start: 1, end: 2 },
      numFailingTests: count("failed"),
      numPassingTests: count("passed"),
    },
    ROOT,
    "fixtures",
  );
};

describe("the quarantine moves the gate", () => {
  it("lets a listed case fail without failing the run, and keeps its failure", async () => {
    const run = await runJest("listed.fixture.ts");
    expect(run.exitCode).toBe(0);
    expect(run.numFailedTests).toBe(0);
    const failed = run.file.assertionResults.find((c) => c.title === "a case that fails");
    expect(failed?.status).toBe("pending");
    expect(failed?.failureMessages.join("\n")).toContain("the listed case failed");
    expect(run.file.assertionResults.find((c) => c.title === "a case that passes")?.status).toBe("passed");
  });

  // The mark is an error the reporters read too. Through the real list of them, it
  // is printed beside the failure it lets through, and read as what it is: a
  // failure with no stack is a stale timer to the stackless reporter.
  it("shows the failure and the ticket it was let through on, and no reporter misreads the mark", async () => {
    const { output } = await runJest("listed.fixture.ts");
    expect(output).toContain("the listed case failed");
    expect(output).toContain("QuarantineMark: quarantined: candybar-testing-ihvy.hcl");
    expect(output).not.toContain("empty stack");
  });

  it("records that case as failed and quarantined, from what jest really hands the reporter, under the name the environment matched", async () => {
    const run = await runJest("listed.fixture.ts");
    const record = recordOfRun(run);
    expect(record.outcome).toBe("failed");
    expect(record.cases).toEqual([
      expect.objectContaining({
        name: "listed › a case that fails",
        outcome: "failed",
        quarantined: "candybar-testing-ihvy.hcl",
      }),
      expect.not.objectContaining({ quarantined: expect.anything() }),
    ]);
    expect(record.cases.map((c: Row) => c.outcome)).toEqual(["failed", "passed"]);
    // The line the environment matched on is the line the record's names join to.
    const entries = quarantine.readQuarantine(ROOT, `${FIXTURES}/quarantine.txt`);
    expect(quarantine.quarantined(entries, record.file, record.cases[0].name)).toBeDefined();
  });

  it("fails the run of the same case once it is off the list", async () => {
    const run = await runJest("listed.fixture.ts", `${FIXTURES}/empty.txt`);
    expect(run.exitCode).toBe(1);
    expect(run.numFailedTests).toBe(1);
  });

  it("fails the run of a failing case that was never listed", async () => {
    const run = await runJest("unlisted.fixture.ts");
    expect(run.exitCode).toBe(1);
    expect(run.file.assertionResults[0]?.status).toBe("failed");
  });

  // A line lets through the case's own failure. A failure that belongs to no
  // case is not the case's to forgive.
  it("still fails the run of a throwing afterAll beside a listed case", async () => {
    const run = await runJest("after-all.fixture.ts");
    expect(run.file.assertionResults[0]?.status).toBe("pending");
    expect(run.exitCode).toBe(1);
  });

  // The same status as a case the quarantine let through (pending, with the
  // failure kept) arrives for a skipped case beside a failing beforeAll that
  // nothing listed. Only the mark tells them apart, and this one has none.
  it("fails the run of a skipped case beside a throwing beforeAll, and records it failed without a mark", async () => {
    const run = await runJest("skipped-before-all.fixture.ts");
    expect(run.exitCode).toBe(1);
    expect(run.file.assertionResults.map((c) => [c.status, c.failureMessages.length])).toEqual([
      ["failed", 1],
      ["pending", 1],
    ]);
    const record = recordOfRun(run);
    expect(record.cases.map((c: Row) => c.outcome)).toEqual(["failed", "failed"]);
    expect(record.cases.some((c: { quarantined?: string }) => c.quarantined !== undefined)).toBe(false);
  });

  // jest allows two cases of one title, and a line names one case.
  it("errors the file of a listed name that two cases carry, and lets neither failure through", async () => {
    const run = await runJest("duplicate-title.fixture.ts");
    expect(run.exitCode).toBe(1);
    expect(run.file.message).toContain("a title used twice matches 2 cases, and a line names one");
    expect(run.file.assertionResults).toEqual([]);
  });

  // A line lets through what is charged to its case while it runs. An error
  // thrown after the case ended is charged to the case running then.
  it("passes a listed case that leaves a throwing timer, and fails the run on the next case", async () => {
    const run = await runJest("late-throw.fixture.ts");
    expect(run.exitCode).toBe(1);
    expect(run.file.assertionResults.map((c) => [c.title, c.status])).toEqual([
      ["a case that leaves a timer", "passed"],
      ["the case running when it throws", "failed"],
    ]);
  });
});

describe("the environment the gate runs through", () => {
  // jest does not expose its own jest-environment-node, so the repo declares one
  // (package.json) and an upgrade of jest alone would leave them apart.
  it("is the version of the jest that loads it", () => {
    const version = (name: string) => createRequire(join(ROOT, "package.json"))(`${name}/package.json`).version;
    expect(version("jest-environment-node")).toBe(version("jest"));
  });

  it("is the environment of every test file, because none names another", () => {
    const own = readdirSync(join(ROOT, "test"), { recursive: true, encoding: "utf8" })
      .filter((file) => /\.(ts|cjs|js)$/.test(file))
      .filter((file) => namesItsEnvironment(readFileSync(join(ROOT, "test", file), "utf8")));
    expect(own).toEqual([]);
  });

  // jest reads the pragma from the file's first comment, whether it opens /** or /*
  // (jest-docblock's extract), and from nowhere else.
  it("reads the pragma where jest reads it", () => {
    expect(namesItsEnvironment("/* @jest-environment node */\nx")).toBe(true);
    expect(namesItsEnvironment("\n/**\n * @jest-environment node\n */\nx")).toBe(true);
    expect(namesItsEnvironment("// @jest-environment node\nx")).toBe(false);
    expect(namesItsEnvironment("x\n/** @jest-environment node */")).toBe(false);
  });
});

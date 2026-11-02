import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import { ASSERTION_LIMIT_SETUP, CAP_REPORTER } from "../../e2e-checks/wiring.cjs";
import { readSignoff } from "../../e2e-checks/signoff.cjs";

// The end-to-end config run over fixtures that break each check in turn. A check
// unplugged from jest.e2e.config.js (through e2eConfig, which the fixtures use)
// turns the fixture that only that check fails green, and its test red. Real
// jest child processes: nothing else shows the config enforces what it names.

const ROOT = resolve(__dirname, "../../..");
const JEST = join(ROOT, "node_modules", "jest", "bin", "jest.js");
const { cap, assertionsPerTest } = readSignoff();

interface FixtureRun {
  code: number | null;
  output: string;
  statusByFile: Record<string, string>;
}

function runFixtures(runName: string, pattern: string): Promise<FixtureRun> {
  const dir = mkdtempSync(join(tmpdir(), "e2e-checks-"));
  const json = join(dir, "result.json");
  return new Promise((resolveRun, reject) => {
    const child = spawn(
      process.execPath,
      [JEST, "--config", "jest.e2e-fixtures.config.js", "--json", `--outputFile=${json}`, pattern],
      { cwd: ROOT, env: { ...process.env, E2E_CHECKS_RUN: runName } },
    );
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      try {
        const result = JSON.parse(readFileSync(json, "utf8")) as {
          testResults: { name: string; status: string }[];
        };
        const statusByFile = Object.fromEntries(result.testResults.map((r) => [basename(r.name), r.status]));
        resolveRun({ code, output, statusByFile });
      } catch (error) {
        reject(new Error(`jest wrote no result for ${pattern}:\n${output}\n${error}`));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
}

function defaultExportOfRealConfig(): Promise<{ setupFilesAfterEnv: string[]; reporters: unknown[] }> {
  return new Promise((resolveConfig, reject) => {
    const child = spawn(
      process.execPath,
      ["--input-type=module", "-e", `import c from "./jest.e2e.config.js"; process.stdout.write(JSON.stringify(c))`],
      { cwd: ROOT },
    );
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (err += chunk));
    child.on("close", (code) =>
      code === 0 ? resolveConfig(JSON.parse(out)) : reject(new Error(`loading jest.e2e.config.js failed:\n${err}`)),
    );
  });
}

let overCap: FixtureRun;
let atCap: FixtureRun;
let assertions: FixtureRun;

beforeAll(async () => {
  [overCap, atCap, assertions] = await Promise.all([
    runFixtures("e2e-checks-over-cap", "over-cap"),
    runFixtures("e2e-checks-at-cap", "at-cap"),
    runFixtures("e2e-checks-assertions", "(exact|too-many)-assertions|no-assertions"),
  ]);
}, 240_000);

describe("the cap", () => {
  test("fails a run one test over, naming the cap, though every test passes", () => {
    expect({
      failed: overCap.code !== 0,
      reason: overCap.output.includes(`end-to-end cap: ${cap + 1} tests declared, the sign-off allows ${cap}`),
      testsPassed: overCap.statusByFile["over-cap.fixture.ts"],
    }).toEqual({ failed: true, reason: true, testsPassed: "passed" });
  });

  test("lets a run at the cap through", () => {
    expect({ code: atCap.code, status: atCap.statusByFile["at-cap.fixture.ts"] }).toEqual({
      code: 0,
      status: "passed",
    });
  });
});

describe("the assertion limit", () => {
  test("fails a test over it and a test under it, and passes one at it", () => {
    expect(assertions.statusByFile).toEqual({
      "exact-assertions.fixture.ts": "passed",
      "too-many-assertions.fixture.ts": "failed",
      "no-assertions.fixture.ts": "failed",
    });
  });

  test("names the limit in the failure", () => {
    expect(assertions.output).toContain(`the sign-off requires exactly ${assertionsPerTest}`);
  });
});

describe("the real end-to-end config", () => {
  test("carries both checks in its default export", async () => {
    const config = await defaultExportOfRealConfig();
    expect({
      assertionLimit: config.setupFilesAfterEnv.includes(ASSERTION_LIMIT_SETUP),
      cap: config.reporters.includes(CAP_REPORTER),
    }).toEqual({ assertionLimit: true, cap: true });
  });
});

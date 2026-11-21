import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { LIFELINE_DIR_ENV } from "../helpers/launcher-fixtures/lifeline-across-files";

// Real jest over the two files in test/helpers/launcher-fixtures, in one
// process, through jest.launcher-fixtures.config.js. A worker runs many files,
// so a lifeline a file's launcher holds has to end when that file's
// environment tears down, after the file's own last hook and before the next
// file runs.

const ROOT = resolve(__dirname, "../..");
const JEST = join(ROOT, "node_modules", "jest", "bin", "jest.js");

test("a file's fixture launchers end after its last hook and before the next file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fixture-launchers-"));
  const lifelines = join(dir, "lifelines");
  const json = join(dir, "result.json");
  mkdirSync(lifelines);
  try {
    const { exitCode, output } = await new Promise<{
      exitCode: number | null;
      output: string;
    }>((resolveRun, reject) => {
      const child = spawn(
        process.execPath,
        [
          JEST,
          "--config",
          "jest.launcher-fixtures.config.js",
          "--runInBand",
          "--json",
          `--outputFile=${json}`,
        ],
        { cwd: ROOT, env: { ...process.env, [LIFELINE_DIR_ENV]: lifelines } },
      );
      let text = "";
      child.stdout.on("data", (chunk) => (text += chunk));
      child.stderr.on("data", (chunk) => (text += chunk));
      child.on("error", reject);
      child.on("close", (code) => resolveRun({ exitCode: code, output: text }));
    });
    const result = JSON.parse(readFileSync(json, "utf8"));
    expect({ exitCode, passed: result.numPassedTests, output }).toMatchObject({
      exitCode: 0,
      passed: 4,
    });
    expect(readdirSync(lifelines).sort()).toEqual(["first", "second"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

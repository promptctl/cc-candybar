// [LAW:no-silent-failure] A promise nobody awaits in src is a task, which the
// clock's `detach` runs and reports: lint refuses every other way to start one,
// `void` included. The typed rules read the project, so each case is text
// linted at a file the project holds.

import { execFileSync } from "node:child_process";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..");
const AT = "src/utils/period.ts";

const SCRIPT = `
import { ESLint } from "eslint";
const [root, file, casesJson] = process.argv.slice(1);
const eslint = new ESLint({ cwd: root });
const out = {};
for (const [name, code] of Object.entries(JSON.parse(casesJson))) {
  const [result] = await eslint.lintText(code, { filePath: root + "/" + file });
  out[name] = result.messages
    .filter((m) => m.ruleId?.startsWith("@typescript-eslint/no-") && m.ruleId.endsWith("promises"))
    .map((m) => m.ruleId);
}
console.log(JSON.stringify(out));
`;

const CASES = {
  bare: "export const f = (p: Promise<void>): void => {\n  p;\n};\n",
  voided: "export const f = (p: Promise<void>): void => {\n  void p;\n};\n",
  "a promise where a callback's return is dropped":
    "export const f = (on: (run: () => void) => void): void =>\n  on(async () => {});\n",
  awaited:
    "export const f = async (p: Promise<void>): Promise<void> => {\n  await p;\n};\n",
  detached:
    'import type { Timekeeper } from "../time.js";\nexport const f = (clock: Timekeeper, p: () => Promise<void>): void =>\n  clock.detach("probe", p);\n',
};

describe("the promise rules", () => {
  let found: Record<string, string[]>;

  beforeAll(() => {
    found = JSON.parse(
      execFileSync(
        process.execPath,
        ["--input-type=module", "-e", SCRIPT, ROOT, AT, JSON.stringify(CASES)],
        { cwd: ROOT, encoding: "utf8" },
      ),
    );
  }, 120_000);

  test.each(["bare", "voided"])("a %s promise fails lint", (name) => {
    expect(found[name]).toEqual(["@typescript-eslint/no-floating-promises"]);
  });

  test("a promise where a callback's return is dropped fails lint", () => {
    expect(found["a promise where a callback's return is dropped"]).toEqual([
      "@typescript-eslint/no-misused-promises",
    ]);
  });

  test.each(["awaited", "detached"])("a %s promise passes", (name) => {
    expect(found[name]).toEqual([]);
  });
});

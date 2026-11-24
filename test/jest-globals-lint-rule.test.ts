// [LAW:one-way-deps] Jest's globals are the test zone's: src's lint, whose
// environment is closed, refuses each as undefined, `typeof` included, in
// TypeScript and JavaScript alike, and a test linted by the same config knows
// those Jest installs.

import { JEST_GLOBALS, JEST_RUNTIME_GLOBALS } from "./helpers/jest-names";
import { lintCases, UNTYPED, type LintCase } from "./helpers/lint-cases";

const read = (name: string) => `export const x = ${name};\n`;
const cases: Record<string, LintCase> = {
  ...Object.fromEntries(
    JEST_GLOBALS.flatMap((name) => [
      [`app ${name}`, { file: "src/daemon/probe.ts", code: read(name) }],
      [
        `app javascript ${name}`,
        { file: "src/daemon/probe.mjs", code: read(name) },
      ],
    ]),
  ),
  ...Object.fromEntries(
    JEST_RUNTIME_GLOBALS.map((name) => [
      `test ${name}`,
      { file: "test/probe.test.ts", code: read(name) },
    ]),
  ),
  "app typeof jest": {
    file: "src/daemon/probe.ts",
    code: "export const x = typeof jest;\n",
  },
};

describe("Jest's globals under src's lint", () => {
  let found: Record<string, string[]>;

  beforeAll(() => {
    found = Object.fromEntries(
      Object.entries(lintCases(cases, UNTYPED)).map(([name, messages]) => [
        name,
        messages.filter((m) => m.ruleId === "no-undef").map((m) => m.message),
      ]),
    );
  }, 60_000);

  test.each(JEST_GLOBALS)("%s is undefined in the app", (name) => {
    expect(found[`app ${name}`]).toEqual([`'${name}' is not defined.`]);
    expect(found[`app javascript ${name}`]).toEqual([
      `'${name}' is not defined.`,
    ]);
  });

  test("a typeof of jest is undefined in the app", () => {
    expect(found["app typeof jest"]).toEqual([`'jest' is not defined.`]);
  });

  test.each(JEST_RUNTIME_GLOBALS)("%s is known in a test", (name) => {
    expect(found[`test ${name}`]).toEqual([]);
  });
});

// [LAW:one-way-deps] Jest's globals are the test zone's: src's lint refuses
// each as undefined, and a test linted by the same config knows it. The names
// are the zone table's (scripts/import-zones.mjs).

import { ZONES } from "./helpers/import-zones";
import { lintCases, UNTYPED, type LintCase } from "./helpers/lint-cases";

const read = (name: string) => `export const x = ${name};\n`;
const cases: Record<string, LintCase> = Object.fromEntries(
  ZONES.JEST_GLOBALS.flatMap((name) => [
    [`app ${name}`, { file: "src/daemon/probe.ts", code: read(name) }],
    [`test ${name}`, { file: "test/probe.test.ts", code: read(name) }],
  ]),
);

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

  test.each(ZONES.JEST_GLOBALS)("%s is undefined in the app", (name) => {
    expect(found[`app ${name}`]).toEqual([`'${name}' is not defined.`]);
  });

  test.each(ZONES.JEST_GLOBALS)("%s is known in a test", (name) => {
    expect(found[`test ${name}`]).toEqual([]);
  });
});

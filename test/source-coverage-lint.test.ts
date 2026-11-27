// [LAW:behavior-not-structure] Prove what each environment refuses with the
// same configs the repository lint entry uses.
import { lintCases, type LintCase } from "./helpers/lint-cases";

function messages(cases: Record<string, LintCase>, config: string) {
  return Object.fromEntries(
    Object.entries(lintCases(cases, { overrideConfigFile: config })).map(
      ([name, found]) => [
        name,
        found
          .filter(
            ({ ruleId }) =>
              ruleId === null ||
              ruleId === "zones/import-direction" ||
              ruleId === "no-undef" ||
              ruleId === "no-unreachable" ||
              ruleId === "no-restricted-syntax",
          )
          .map(({ message }) => message),
      ],
    ),
  );
}

test("the pricing tool, standalone statusline and native page receive their own environments", () => {
  const host = "export const value = typeof expect;\n";
  const browser =
    "export const screen = document.body; export const runtime = typeof process;\n";
  const found = messages(
    {
      ci: { file: ".github/scripts/transform-pricing.mjs", code: host },
      nested: { file: ".github/scripts/.fixture/check.mjs", code: host },
      lite: { file: "candybar-lite.mjs", code: host },
      panel: { file: "resources/bar-window/panel.js", code: browser },
      page: { file: "scripts/bar-web/.nested/view.jsx", code: browser },
      build: { file: "tsdown.config.ts", code: 'import "jest-mock";\n' },
      shared: {
        file: "scripts/lib/audit.cjs",
        code: 'require("jest-mock");\n',
      },
    },
    "eslint.tools.config.mjs",
  );
  for (const name of ["ci", "nested", "lite"])
    expect(found[name]).toEqual(["'expect' is not defined."]);
  for (const name of ["panel", "page"])
    expect(found[name]).toEqual(["'process' is not defined."]);
  for (const name of ["build", "shared"])
    expect(found[name]).toEqual([
      expect.stringContaining("[LAW:one-way-deps]"),
    ]);
});

test("audit and test JavaScript and shared libraries retain suite effect restrictions", () => {
  const write = 'process.env.MUTATED = "1";\n';
  const found = messages(
    {
      audit: { file: "audits/review.mjs", code: write },
      helper: { file: "test/helpers/tiers.cjs", code: write },
      shared: { file: "scripts/lib/audit.cjs", code: write },
      worker: {
        file: "test/.nested/probe.jsx",
        code: "describe('fixture', () => expect(1).toBe(1));\n",
      },
      native: {
        file: "test/integration/native-probe.cts",
        code: "function f() { return 1; return 2; }\n",
      },
    },
    "eslint.tests.config.mjs",
  );
  for (const name of ["audit", "helper", "shared"])
    expect(found[name]).toEqual([expect.stringContaining("Hand src a Host")]);
  expect(found.worker).toEqual([]);
  expect(found.native).toEqual(["Unreachable code."]);
});

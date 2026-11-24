// [LAW:one-way-deps] The tools (scripts/, proto-looks/), what they share with
// the tests (scripts/lib/) and the site's page code (site/) run outside Jest,
// so they import nothing from the test suite or Jest, and read none of Jest's
// globals. The rule is eslint.tools.config.mjs, so the cases run that config
// over source text placed under each root the zone table names.

import { execFileSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { REPO } from "../scripts/lib/repo.cjs";
import { lintCases, type LintCase } from "./helpers/lint-cases";

// The roots, read from the zone table itself (scripts/import-zones.mjs), so a
// root added there is a case here.
const ROOTS: string[] = JSON.parse(
  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const { OUTSIDE_JEST_ROOTS } = await import(${JSON.stringify(
        pathToFileURL(path.join(REPO, "scripts", "import-zones.mjs")).href,
      )}); console.log(JSON.stringify(OUTSIDE_JEST_ROOTS));`,
    ],
    { cwd: REPO, encoding: "utf8" },
  ),
);

const imp = (from: string) => `import { x } from "${from}";\nexport { x };\n`;
const at = (root: string, ext = "ts") => `${root}probe.${ext}`;
// The relative path from a file under `root` to the repo's `target`.
const up = (root: string, target: string) =>
  path.posix.relative(root, target) || ".";

const perRoot = (make: (root: string) => LintCase): Record<string, LintCase> =>
  Object.fromEntries(ROOTS.map((root) => [root, make(root)]));

const REFUSED: Record<string, LintCase> = {
  ...prefixed(
    "import of test/",
    perRoot((root) => ({
      file: at(root),
      code: imp(`${up(root, "test/helpers")}/x`),
    })),
  ),
  ...prefixed(
    "type import of test/",
    perRoot((root) => ({
      file: at(root),
      code: `import type { X } from "${up(root, "test/helpers")}/x";\nexport type Y = X;\n`,
    })),
  ),
  ...prefixed(
    "require of test/",
    perRoot((root) => ({
      file: at(root, "cjs"),
      code: `module.exports = require("${up(root, "test/helpers")}/x.cjs");\n`,
    })),
  ),
  // The audits run under Jest over the suite's helpers, so reaching one
  // reaches the suite.
  ...prefixed(
    "import of audits/",
    perRoot((root) => ({
      file: at(root),
      code: imp(`${up(root, "audits")}/seam-sweep.audit`),
    })),
  ),
  // A root no row places has said nothing about Jest.
  "import of a path no row names": {
    file: at("scripts/"),
    code: imp("../docs/design/probes/p6"),
  },
  "Jest's expect": { file: at("scripts/lib/"), code: "expect(1).toBe(1);\n" },
  "a focused Jest case": {
    file: at("scripts/"),
    code: "fit('x', () => {});\n",
  },
  "the suite's fixture hook": {
    file: at("scripts/lib/"),
    code: "releaseTestFixture(async () => {});\n",
  },
  "an import of Jest's globals": {
    file: at("scripts/"),
    code: imp("@jest/globals"),
  },
  // scripts/lib imports only the app and itself, so it never loads a tool.
  "scripts/lib's import of a tool": {
    file: at("scripts/lib/"),
    code: imp("../drive-bar"),
  },
};

const ALLOWED: Record<string, LintCase> = {
  "a tool's import of src": { file: at("scripts/"), code: imp("../src/host") },
  "scripts/lib's import of the renderer": {
    file: at("scripts/lib/"),
    code: imp("../../src/renderer/render-cache"),
  },
  "a tool's import of scripts/lib": {
    file: at("scripts/"),
    code: imp("./lib/drive-bar"),
  },
  "the site's import of src": { file: at("site/"), code: imp("../src/host") },
};

function prefixed(
  what: string,
  cases: Record<string, LintCase>,
): Record<string, LintCase> {
  return Object.fromEntries(
    Object.entries(cases).map(([root, c]) => [`${what} from ${root}`, c]),
  );
}

describe("the tools lint", () => {
  let found: Record<string, string[]>;

  beforeAll(() => {
    const messages = lintCases(
      { ...REFUSED, ...ALLOWED },
      {
        overrideConfigFile: "eslint.tools.config.mjs",
      },
    );
    found = Object.fromEntries(
      Object.entries(messages).map(([name, ms]) => [
        name,
        ms.map((m) => `${m.ruleId}: ${m.message}`),
      ]),
    );
  }, 60_000);

  test("the zone table names every root the tools lint covers", () => {
    expect(ROOTS).toEqual(
      expect.arrayContaining([
        "scripts/",
        "scripts/lib/",
        "site/",
        "proto-looks/",
      ]),
    );
  });

  test.each(Object.keys(REFUSED))("%s fails lint", (name) => {
    expect(found[name]).toEqual([
      expect.stringContaining("[LAW:one-way-deps]"),
    ]);
  });

  test.each(Object.keys(ALLOWED))("%s passes lint", (name) => {
    expect(found[name]).toEqual([]);
  });
});

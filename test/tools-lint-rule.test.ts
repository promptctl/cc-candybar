// [LAW:one-way-deps] The tools (scripts/, proto-looks/), what they share with
// the tests (scripts/lib/) and the site's page code (site/) run outside Jest,
// so they import nothing from the test suite or Jest, and read none of Jest's
// globals. The rule is eslint.tools.config.mjs, so the cases run that config
// over source text placed under each root the zone table names. Their
// TypeScript's globals are the type-check's (app-type-environment.test.ts).

import path from "node:path";

import {
  JEST_GLOBALS,
  JEST_PACKAGES,
  NOT_JEST_PACKAGES,
} from "./helpers/jest-names";
import {
  lintCases,
  outsideJestRoots,
  type LintCase,
} from "./helpers/lint-cases";

const ROOTS = outsideJestRoots();

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
  ...Object.fromEntries(
    JEST_PACKAGES.flatMap((pkg) => [
      [`an import of ${pkg}`, { file: at("scripts/"), code: imp(pkg) }],
      [
        `a require of ${pkg}`,
        {
          file: at("scripts/lib/", "cjs"),
          code: `module.exports = require("${pkg}");\n`,
        },
      ],
    ]),
  ),
  "a tool's loader of Jest": {
    file: at("scripts/", "mjs"),
    code: `import { createRequire } from "node:module";\nexport const x = createRequire(import.meta.url)("jest-mock");\n`,
  },
  // scripts/lib imports only the app and itself, so it never loads a tool.
  "scripts/lib's import of a tool": {
    file: at("scripts/lib/"),
    code: imp("../drive-bar"),
  },
};

// Each of Jest's globals, read by each root's JavaScript.
const GLOBALS: Record<string, LintCase> = Object.fromEntries(
  JEST_GLOBALS.flatMap((name) =>
    ROOTS.map((root) => [
      `${name} from ${root}`,
      { file: at(root, "mjs"), code: `export const x = ${name};\n` },
    ]),
  ),
);

// The page `pnpm bar:web` serves runs in the browser, which has no Node.
const PAGE: Record<string, LintCase> = {
  "the page's read of Node's process": {
    file: "scripts/bar-web/probe.js",
    code: "export const env = process.env;\n",
  },
};

const ALLOWED: Record<string, LintCase> = {
  ...Object.fromEntries(
    NOT_JEST_PACKAGES.map((pkg) => [
      `an import of ${pkg}`,
      { file: at("scripts/"), code: imp(pkg) },
    ]),
  ),
  "a tool's loader of scripts/lib": {
    file: at("scripts/", "mjs"),
    code: `import { createRequire } from "node:module";\nconst require = createRequire(import.meta.url);\nexport const x = require("./lib/x.cjs");\n`,
  },
  "Node's own globals in a tool's JavaScript": {
    file: at("scripts/lib/", "cjs"),
    code: "module.exports = { dir: __dirname, env: process.env, at: performance.now() };\n",
  },
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
      { ...REFUSED, ...GLOBALS, ...PAGE, ...ALLOWED },
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

  test.each(Object.keys(GLOBALS))("Jest's %s fails lint", (name) => {
    const global = name.split(" ")[0];
    expect(found[name]).toEqual([`no-undef: '${global}' is not defined.`]);
  });

  test.each(Object.keys(PAGE))("%s fails lint", (name) => {
    expect(found[name]).toEqual(["no-undef: 'process' is not defined."]);
  });

  test.each(Object.keys(ALLOWED))("%s passes lint", (name) => {
    expect(found[name]).toEqual([]);
  });
});

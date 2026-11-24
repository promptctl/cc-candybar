// [LAW:one-way-deps] The tools (scripts/, proto-looks/) and the site's page code (site/) run
// outside Jest, so they import nothing from the test suite and read none of
// Jest's globals. The rule is eslint.tools.config.mjs, so the cases run that
// config over source text placed at tool paths.

import { execFileSync } from "node:child_process";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..");

// ESM config, so ESLint runs in a node of its own.
const SCRIPT = `
import { ESLint } from "eslint";
const [root, casesJson] = process.argv.slice(1);
const eslint = new ESLint({ cwd: root, overrideConfigFile: root + "/eslint.tools.config.mjs" });
const out = {};
for (const [name, c] of Object.entries(JSON.parse(casesJson))) {
  const [result] = await eslint.lintText(c.code, { filePath: root + "/" + c.file });
  out[name] = result.messages.map((m) => m.ruleId + ": " + m.message);
}
console.log(JSON.stringify(out));
`;

const imp = (from: string) => `import { x } from "${from}";\nexport { x };\n`;

const REFUSED = {
  scriptToTest: { file: "scripts/probe.ts", code: imp("../test/helpers/x") },
  libToTest: { file: "scripts/lib/probe.ts", code: imp("../../test/helpers/x") },
  libToTestType: {
    file: "scripts/lib/probe.ts",
    code: `import type { X } from "../../test/helpers/x";\nexport type Y = X;\n`,
  },
  scriptRequiresTest: {
    file: "scripts/probe.cjs",
    code: `module.exports = require("../test/helpers/x.cjs");\n`,
  },
  siteToTest: { file: "site/probe.ts", code: imp("../test/helpers/x") },
  protoLookToTest: { file: "proto-looks/probe.ts", code: imp("../test/helpers/x") },
  jestExpect: { file: "scripts/lib/probe.ts", code: "expect(1).toBe(1);\n" },
  jestFixture: {
    file: "scripts/lib/probe.ts",
    code: "releaseTestFixture(async () => {});\n",
  },
};

const ALLOWED = {
  scriptToSrc: { file: "scripts/probe.ts", code: imp("../src/host") },
  libToRenderer: {
    file: "scripts/lib/probe.ts",
    code: imp("../../src/renderer/render-cache"),
  },
  scriptToLib: { file: "scripts/probe.ts", code: imp("./lib/drive-bar") },
  siteToSrc: { file: "site/probe.ts", code: imp("../src/host") },
};

describe("the tools lint", () => {
  let found: Record<string, string[]>;

  beforeAll(() => {
    found = JSON.parse(
      execFileSync(
        process.execPath,
        ["--input-type=module", "-e", SCRIPT, ROOT, JSON.stringify({ ...REFUSED, ...ALLOWED })],
        { cwd: ROOT, encoding: "utf8" },
      ),
    );
  }, 60_000);

  test.each(Object.keys(REFUSED))("%s fails lint", (name) => {
    expect(found[name]).toEqual([expect.stringContaining("[LAW:one-way-deps]")]);
  });

  test.each(Object.keys(ALLOWED))("%s passes lint", (name) => {
    expect(found[name]).toEqual([]);
  });
});

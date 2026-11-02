// [LAW:one-way-deps] Foundations (src/daemon/foundations/) reaches no other
// piece of the daemon. The rule is eslint.config.mjs's, so the cases run the
// repo's own config over source text placed at a Foundations path.

import { execFileSync } from "node:child_process";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..");

// ESM config, so ESLint runs in a node of its own, once for all cases.
const SCRIPT = `
import { ESLint } from "eslint";
const [root, casesJson] = process.argv.slice(1);
const eslint = new ESLint({ cwd: root });
const out = {};
for (const [name, c] of Object.entries(JSON.parse(casesJson))) {
  const [result] = await eslint.lintText(c.code, { filePath: root + "/" + c.file });
  out[name] = result.messages
    .filter((m) => m.ruleId === "no-restricted-imports")
    .map((m) => m.message);
}
console.log(JSON.stringify(out));
`;

const IN_FOUNDATIONS = "src/daemon/foundations/probe.ts";
const imp = (from: string) => `import { x } from "${from}";\nexport { x };\n`;

const CASES = {
  sibling: { file: IN_FOUNDATIONS, code: imp("../draw-bar") },
  siblingDir: { file: IN_FOUNDATIONS, code: imp("../verbs") },
  throughSrc: { file: IN_FOUNDATIONS, code: imp("../../daemon/draw-bar") },
  throughSrcDir: { file: IN_FOUNDATIONS, code: imp("../../daemon/verbs") },
  fromRoot: { file: IN_FOUNDATIONS, code: imp("../../../src/daemon/draw-bar") },
  dotted: { file: IN_FOUNDATIONS, code: imp("./../draw-bar") },
  typeOnly: {
    file: IN_FOUNDATIONS,
    code: `import type { X } from "../draw-bar";\nexport type Y = X;\n`,
  },
  reexport: {
    file: IN_FOUNDATIONS,
    code: `export { x } from "../draw-bar";\n`,
  },
  inside: { file: IN_FOUNDATIONS, code: imp("./gates") },
  outsideDaemon: { file: IN_FOUNDATIONS, code: imp("../../config/dsl-types") },
  // The same import is the rest of the daemon's own to make.
  elsewhere: { file: "src/daemon/draw-bar.ts", code: imp("./verbs") },
};

describe("the Foundations import rule", () => {
  let found: Record<keyof typeof CASES, string[]>;

  beforeAll(() => {
    found = JSON.parse(
      execFileSync(
        process.execPath,
        ["--input-type=module", "-e", SCRIPT, ROOT, JSON.stringify(CASES)],
        { cwd: ROOT, encoding: "utf8" },
      ),
    );
  }, 60_000);

  test.each([
    "sibling",
    "siblingDir",
    "throughSrc",
    "throughSrcDir",
    "fromRoot",
    "dotted",
    "typeOnly",
    "reexport",
  ] as const)("a Foundations file importing a daemon piece (%s) fails lint", (name) => {
    expect(found[name]).toEqual([expect.stringContaining("[LAW:one-way-deps]")]);
  });

  test.each(["inside", "outsideDaemon", "elsewhere"] as const)(
    "an import that does not reach up (%s) passes",
    (name) => {
      expect(found[name]).toEqual([]);
    },
  );
});

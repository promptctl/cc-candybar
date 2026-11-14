// [LAW:one-way-deps] The renderer side and the host meet only at the
// renderer's start and the shared contract, and shared code imports neither.
// The rule is eslint.config.mjs's zone table, so the cases run the repo's own
// config over source text placed at zone paths.

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
    .filter((m) => m.ruleId === "zones/import-direction")
    .map((m) => m.message);
}
console.log(JSON.stringify(out));
`;

const IN_RENDERER = "src/renderer/probe.ts";
const IN_REST = "src/daemon/probe.ts";
const IN_SHARED = "src/utils/probe.ts";
const IN_FOUNDATIONS = "src/daemon/foundations/probe.ts";
const imp = (from: string) => `import { x } from "${from}";\nexport { x };\n`;
const typeImp = (from: string) =>
  `import type { X } from "${from}";\nexport type Y = X;\n`;

const REFUSED = {
  rendererToRest: { file: IN_RENDERER, code: imp("../daemon/x") },
  rendererToRestFromRoot: { file: IN_RENDERER, code: imp("../../src/daemon/x") },
  rendererToRestDotted: { file: IN_RENDERER, code: imp("./../daemon/x") },
  rendererToRestTypeOnly: { file: IN_RENDERER, code: typeImp("../daemon/x") },
  rendererToRestReexport: {
    file: IN_RENDERER,
    code: `export { x } from "../daemon/x";\n`,
  },
  rendererToRestDynamic: {
    file: IN_RENDERER,
    code: `export const m = import("../daemon/x");\n`,
  },
  rendererToRestTypeQuery: {
    file: IN_RENDERER,
    code: `export type T = import("../daemon/x").T;\n`,
  },
  rendererToNewDirectory: { file: IN_RENDERER, code: imp("../newly-added/x") },
  restToRenderer: { file: IN_REST, code: imp("../renderer/draw-bar") },
  restToRendererDir: { file: IN_REST, code: imp("../renderer/verbs") },
  sharedToRenderer: { file: IN_SHARED, code: imp("../renderer/draw-bar") },
  sharedToRest: { file: IN_SHARED, code: imp("../daemon/x") },
  // Foundations is shared: it reaches no other piece of the daemon.
  foundationsSibling: { file: IN_FOUNDATIONS, code: imp("../draw-bar") },
  foundationsSiblingDir: { file: IN_FOUNDATIONS, code: imp("../verbs") },
  foundationsThroughSrc: { file: IN_FOUNDATIONS, code: imp("../../daemon/draw-bar") },
  foundationsFromRoot: {
    file: IN_FOUNDATIONS,
    code: imp("../../../src/daemon/draw-bar"),
  },
  foundationsDotted: { file: IN_FOUNDATIONS, code: imp("./../draw-bar") },
  foundationsTypeOnly: { file: IN_FOUNDATIONS, code: typeImp("../draw-bar") },
  foundationsReexport: {
    file: IN_FOUNDATIONS,
    code: `export { x } from "../draw-bar";\n`,
  },
};

const ALLOWED = {
  rendererToRenderer: { file: IN_RENDERER, code: imp("./draw-bar") },
  rendererToShared: { file: IN_RENDERER, code: imp("../renderer-interface/adapter") },
  restToStart: { file: IN_REST, code: imp("../renderer/main") },
  restToContract: { file: IN_REST, code: imp("../renderer-interface/adapter") },
  restToShared: { file: IN_REST, code: imp("../utils/outcome") },
  rootToRenderer: { file: "src/check.ts", code: imp("./renderer/draw-bar") },
  restToRoot: { file: IN_REST, code: imp("../check") },
  foundationsInside: { file: IN_FOUNDATIONS, code: imp("./gates") },
  foundationsToShared: { file: IN_FOUNDATIONS, code: imp("../../config/dsl-types") },
};

describe("the zones import rule", () => {
  let found: Record<string, string[]>;

  beforeAll(() => {
    found = JSON.parse(
      execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          SCRIPT,
          ROOT,
          JSON.stringify({ ...REFUSED, ...ALLOWED }),
        ],
        { cwd: ROOT, encoding: "utf8" },
      ),
    );
  }, 60_000);

  test.each(Object.keys(REFUSED))("an import across the seam (%s) fails lint", (name) => {
    expect(found[name]).toEqual([expect.stringContaining("[LAW:one-way-deps]")]);
  });

  test.each(Object.keys(ALLOWED))("an import the zones allow (%s) passes", (name) => {
    expect(found[name]).toEqual([]);
  });
});

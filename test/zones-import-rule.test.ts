// [LAW:one-way-deps] The renderer side and the host meet only at the
// renderer's start and the shared contract, and shared code imports neither.
// The rule is eslint.config.mjs's zone table, so the cases run the repo's own
// config over source text placed at zone paths, from the repo root and from a
// subdirectory, as an editor whose working directory is `src/` runs it.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..");

// ESM config, so ESLint runs in a node of its own, once per working
// directory, as an editor or runner started there runs it.
const SCRIPT = `
import { ESLint } from "eslint";
const [root, cwd, casesJson] = process.argv.slice(1);
const eslint = new ESLint({ cwd });
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
const IN_START = "src/renderer/main.ts";
const IN_REST = "src/daemon/probe.ts";
const IN_SHARED = "src/utils/probe.ts";
const IN_FOUNDATIONS = "src/daemon/foundations/probe.ts";
const imp = (from: string) => `import { x } from "${from}";\nexport { x };\n`;
const typeImp = (from: string) =>
  `import type { X } from "${from}";\nexport type Y = X;\n`;

const REFUSED = {
  rendererToRest: { file: IN_RENDERER, code: imp("../daemon/x") },
  rendererToRestFromRoot: {
    file: IN_RENDERER,
    code: imp("../../src/daemon/x"),
  },
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
  rendererToRestRequireEquals: {
    file: IN_RENDERER,
    code: `import x = require("../daemon/x");\nexport { x };\n`,
  },
  rendererToRestRequire: {
    file: IN_RENDERER,
    code: `export const x = require("../daemon/x");\n`,
  },
  rendererToRestTemplate: {
    file: IN_RENDERER,
    code: "export const m = import(`../daemon/x`);\n",
  },
  // A computed source names no module, so the rule cannot place it.
  rendererComputed: {
    file: IN_RENDERER,
    code: "const at = 'x';\nexport const m = import(`../daemon/${at}`);\n",
  },
  rendererToNewDirectory: { file: IN_RENDERER, code: imp("../newly-added/x") },
  // An unsaved buffer in a directory not made yet.
  rendererUnsavedDirectory: {
    file: "src/renderer/not-made-yet/probe.ts",
    code: imp("../../daemon/x"),
  },
  restToRenderer: { file: IN_REST, code: imp("../renderer/draw-bar") },
  restToRendererDir: { file: IN_REST, code: imp("../renderer/verbs") },
  startToRest: { file: IN_START, code: imp("../daemon/x") },
  sharedToRenderer: { file: IN_SHARED, code: imp("../renderer/draw-bar") },
  sharedToStart: { file: IN_SHARED, code: imp("../renderer/main") },
  // A root builds the renderer in process, so only the entry reaches one: an
  // edge into a root from anywhere else would carry the renderer with it.
  restToRoot: { file: IN_REST, code: imp("../check") },
  rendererToRoot: { file: IN_RENDERER, code: imp("../check") },
  startToRoot: { file: IN_START, code: imp("../check") },
  sharedToRoot: { file: IN_SHARED, code: imp("../check") },
  sharedToRest: { file: IN_SHARED, code: imp("../daemon/x") },
  // Foundations is shared: it reaches no other piece of the daemon.
  foundationsSibling: { file: IN_FOUNDATIONS, code: imp("../draw-bar") },
  foundationsSiblingDir: { file: IN_FOUNDATIONS, code: imp("../verbs") },
  foundationsThroughSrc: {
    file: IN_FOUNDATIONS,
    code: imp("../../daemon/draw-bar"),
  },
  foundationsThroughSrcDir: {
    file: IN_FOUNDATIONS,
    code: imp("../../daemon/cache"),
  },
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
  rendererToShared: {
    file: IN_RENDERER,
    code: imp("../renderer-interface/adapter"),
  },
  restToStart: { file: IN_REST, code: imp("../renderer/main") },
  startToRenderer: { file: IN_START, code: imp("./draw-bar") },
  startToContract: {
    file: IN_START,
    code: imp("../renderer-interface/adapter"),
  },
  restToContract: { file: IN_REST, code: imp("../renderer-interface/adapter") },
  restToShared: { file: IN_REST, code: imp("../utils/outcome") },
  rootToRenderer: { file: "src/check.ts", code: imp("./renderer/draw-bar") },
  entryToRoot: { file: "src/index.ts", code: imp("./check") },
  foundationsInside: { file: IN_FOUNDATIONS, code: imp("./gates") },
  foundationsToShared: {
    file: IN_FOUNDATIONS,
    code: imp("../../config/dsl-types"),
  },
};

describe("the zones import rule", () => {
  let found: Record<"root" | "src" | "link", Record<string, string[]>>;

  beforeAll(() => {
    const lintFrom = (cwd: string, root = ROOT) =>
      JSON.parse(
        execFileSync(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            SCRIPT,
            root,
            cwd,
            JSON.stringify({ ...REFUSED, ...ALLOWED }),
          ],
          { cwd, encoding: "utf8" },
        ),
      );
    // A checkout reached through a symlink, as an editor opened on a linked
    // path lints it.
    const link = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "zones-")),
      "repo",
    );
    fs.symlinkSync(ROOT, link);
    try {
      found = {
        root: lintFrom(ROOT),
        src: lintFrom(path.join(ROOT, "src")),
        link: lintFrom(link, link),
      };
    } finally {
      fs.rmSync(path.dirname(link), { recursive: true });
    }
  }, 60_000);

  const AT = ["root", "src", "link"] as const;
  const each = (cases: object) =>
    AT.flatMap((at) => Object.keys(cases).map((name) => [name, at] as const));

  test.each(each(REFUSED))(
    "an import across the seam (%s) fails lint from %s",
    (name, at) => {
      expect(found[at][name]).toEqual([
        expect.stringContaining("[LAW:one-way-deps]"),
      ]);
    },
  );

  test.each(each(ALLOWED))(
    "an import the zones allow (%s) passes from %s",
    (name, at) => {
      expect(found[at][name]).toEqual([]);
    },
  );
});

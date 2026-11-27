// [LAW:one-way-deps] The renderer side and the host meet only at the
// renderer's start and the shared contract, and shared code imports neither.
// The rule is eslint.config.mjs's zone table, so the cases run the repo's own
// config over source text placed at zone paths, from the repo root and from a
// subdirectory, as an editor whose working directory is `src/` runs it.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { REPO } from "../scripts/lib/repo.cjs";
import { JEST_PACKAGES, NOT_JEST_PACKAGES } from "./helpers/jest-names";
import { lintCases, UNTYPED } from "./helpers/lint-cases";

const IN_RENDERER = "src/renderer/probe.ts";
const IN_START = "src/renderer/main.ts";
const IN_PROCESS = "src/renderer-process.ts";
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
  rendererToAbsoluteHostType: {
    file: IN_RENDERER,
    code: typeImp(path.join(REPO, "src/host")),
  },
  rendererToHostIdentity: {
    file: IN_RENDERER,
    code: imp("../daemon/cache/host-identity"),
  },
  rendererToOperatingSystem: { file: IN_RENDERER, code: imp("node:os") },
  rendererToProcess: { file: IN_RENDERER, code: imp("node:process") },
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
  processToHost: { file: IN_PROCESS, code: imp("./daemon/pane-visibility") },
  processToHostType: { file: IN_PROCESS, code: typeImp("./host") },
  processToEntry: { file: IN_PROCESS, code: imp("./index") },
  processToOperatingSystem: { file: IN_PROCESS, code: imp("node:os") },
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
  rendererToUrlParser: { file: IN_RENDERER, code: imp("node:url") },
  sharedToStart: { file: IN_SHARED, code: imp("../renderer/main") },
  // A root builds the renderer in process, so only the entry reaches one: an
  // edge into a root from anywhere else would carry the renderer with it.
  restToRoot: { file: IN_REST, code: imp("../renderer-process") },
  rendererToRoot: { file: IN_RENDERER, code: imp("../renderer-process") },
  startToRoot: { file: IN_START, code: imp("../renderer-process") },
  sharedToRoot: { file: IN_SHARED, code: imp("../renderer-process") },
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
  // The test suite runs under Jest, and src runs outside it; what src shares
  // with a tool, a tool takes from src.
  restToTest: { file: IN_REST, code: imp("../../test/helpers/x") },
  sharedToTest: { file: IN_SHARED, code: imp("../../test/helpers/x") },
  rendererToTestRequire: {
    file: IN_RENDERER,
    code: `export const x = require("../../test/helpers/x");\n`,
  },
  // Jest's packages are the test zone's, from any file of the app, its
  // JavaScript included.
  ...Object.fromEntries(
    JEST_PACKAGES.flatMap((pkg) => [
      [`restTo ${pkg}`, { file: IN_REST, code: imp(pkg) }],
      [
        `sharedRequireOf ${pkg}`,
        { file: IN_SHARED, code: `export const x = require("${pkg}");\n` },
      ],
    ]),
  ),
  javascriptToJest: { file: "src/daemon/probe.js", code: `import "jest";\n` },
  moduleJavascriptToJest: {
    file: "src/daemon/probe.mjs",
    code: `import "@jest/globals";\n`,
  },
  moduleRequireOfJest: {
    file: "src/daemon/probe.cjs",
    code: `module.exports = module.require("jest-mock");\n`,
  },
  referenceToJestTypes: {
    file: IN_REST,
    code: `/// <reference types="jest" />\nexport const x = 1;\n`,
  },
  referenceToTestPath: {
    file: IN_REST,
    code: `/// <reference path="../../test/helpers/x.ts" />\nexport const x = 1;\n`,
  },
  // What a loader loads is an edge like an import's, whatever name binds it.
  ...Object.fromEntries(
    Object.entries({
      createRequireOfJest: `import { createRequire } from "node:module";\nexport const x = createRequire(import.meta.url)("jest");\n`,
      boundLoaderOfJest: `import { createRequire } from "node:module";\nconst load = createRequire(import.meta.url);\nexport const x = load("jest");\n`,
      renamedCreateRequireOfJest: `import { createRequire as make } from "node:module";\nexport const x = make(import.meta.url)("@jest/globals");\n`,
      memberCreateRequireOfJest: `import * as m from "node:module";\nexport const x = m.createRequire(import.meta.url)("jest");\n`,
      builtinLoaderOfJest: `export const x = process.getBuiltinModule("node:module").createRequire(import.meta.url)("jest");\n`,
      loaderOfTestPath: `import { createRequire } from "node:module";\nexport const x = createRequire(import.meta.url)("../../test/helpers/x.cjs");\n`,
      // A base no lint can read places no relative source.
      loaderOfComputedBase: `import { createRequire } from "node:module";\nexport const x = createRequire(process.cwd())("./x");\n`,
      // A loader used other than by a call with its source.
      requireAliased: `const load = require;\nexport const x = load("jest");\n`,
      requireCalledThroughCall: `export const x = require.call(null, "jest");\n`,
      loaderExported: `import { createRequire } from "node:module";\nexport const load = createRequire(import.meta.url);\n`,
      createRequireHandedOn: `import { createRequire } from "node:module";\nexport const make = [createRequire];\n`,
      createRequireReexported: `export { createRequire } from "node:module";\n`,
    }).map(([name, code]) => [name, { file: IN_REST, code }]),
  ),
  destructuredCreateRequireOfJest: {
    file: "src/daemon/probe.cjs",
    code: `const { createRequire } = require("node:module");\nmodule.exports = createRequire(__filename)("jest");\n`,
  },
  rendererBuiltinOfDisk: {
    file: IN_RENDERER,
    code: `export const fs = process.getBuiltinModule("node:fs");\n`,
  },
  rendererComputedKeyBuiltinOfDisk: {
    file: IN_RENDERER,
    code: `export const fs = process["getBuiltinModule"]("node:fs");\n`,
  },
  createRequireDestructuredInAParameter: {
    file: IN_REST,
    code: `export const load = ({ createRequire }: typeof import("node:module")) => createRequire(".")("jest");\n`,
  },
  rendererDestructuredBuiltinOfDisk: {
    file: IN_RENDERER,
    code: `const { getBuiltinModule } = process;\nexport const fs = getBuiltinModule("node:fs");\n`,
  },
  restToLib: { file: IN_REST, code: imp("../../scripts/lib/x") },
  restToTools: { file: IN_REST, code: imp("../../scripts/drive-bar") },
  // A path no row of the table names is in no zone.
  restToUnlisted: { file: IN_REST, code: imp("../../docs/design/probes/p6") },
};

const ALLOWED = {
  ...Object.fromEntries(
    NOT_JEST_PACKAGES.map((pkg) => [
      `restTo ${pkg}`,
      { file: IN_REST, code: imp(pkg) },
    ]),
  ),
  // `.resolve` locates a file and loads nothing, whatever its source.
  loaderResolvingComputedSource: {
    file: IN_REST,
    code: `import { createRequire } from "node:module";\nexport const at = (name: string) => createRequire(process.cwd()).resolve(\`\${name}/package.json\`);\n`,
  },
  localLoaderOfShared: {
    file: IN_REST,
    code: `import { createRequire } from "node:module";\nconst require = createRequire(import.meta.url);\nexport const x = require("../utils/outcome");\n`,
  },
  // A method that is no loader shares the name.
  methodNamedRequire: {
    file: IN_REST,
    code: `export const x = { require: (s: string) => s }.require("../renderer/x");\n`,
  },
  rendererToRenderer: { file: IN_RENDERER, code: imp("./draw-bar") },
  rendererToShared: {
    file: IN_RENDERER,
    code: imp("../renderer-interface/interface"),
  },
  restToStart: { file: IN_REST, code: imp("../renderer/main") },
  startToRenderer: { file: IN_START, code: imp("./draw-bar") },
  startToContract: {
    file: IN_START,
    code: imp("../renderer-interface/interface"),
  },
  restToContract: {
    file: IN_REST,
    code: imp("../renderer-interface/interface"),
  },
  restToShared: { file: IN_REST, code: imp("../utils/outcome") },
  processToRenderer: {
    file: IN_PROCESS,
    code: imp("./renderer/draw-bar"),
  },
  processToTransport: { file: IN_PROCESS, code: imp("node:process") },
  entryToRoot: { file: "src/index.ts", code: imp("./renderer-process") },
  foundationsInside: { file: IN_FOUNDATIONS, code: imp("./gates") },
  foundationsToShared: {
    file: IN_FOUNDATIONS,
    code: imp("../../config/dsl-types"),
  },
};

describe("the zones import rule", () => {
  let found: Record<"root" | "src" | "link", Record<string, string[]>>;

  beforeAll(() => {
    // As an editor or runner started in `cwd` lints the checkout at `root`.
    const lintFrom = (cwd: string, root = REPO) =>
      Object.fromEntries(
        Object.entries(
          lintCases({ ...REFUSED, ...ALLOWED }, UNTYPED, {
            cwd,
            root,
          }),
        ).map(([name, messages]) => [
          name,
          messages
            .filter((m) => m.ruleId === "zones/import-direction" && m.message.includes("[LAW:one-way-deps]"))
            .map((m) => m.message),
        ]),
      );
    // A checkout reached through a symlink, as an editor opened on a linked
    // path lints it.
    const link = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "zones-")),
      "repo",
    );
    fs.symlinkSync(REPO, link);
    try {
      found = {
        root: lintFrom(REPO),
        src: lintFrom(path.join(REPO, "src")),
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

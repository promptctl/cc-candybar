// [LAW:one-way-deps] Code that runs outside Jest type-checks in an
// environment of Node's types alone, so a Jest global there is a type error,
// `globalThis.jest` included; the test project extends it with Jest's. Each
// probe is a file of the project its path puts it in, by that project's own
// include, and is checked in a program over the project's every file, so an
// ambient declaration anywhere in it reaches the probe as it would a file.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import ts from "typescript";

import { REPO } from "../scripts/lib/repo.cjs";
import { outsideJestRoots } from "./helpers/lint-cases";

const PROBE = `expect(1);
describe("x", () => {});
export const mock = globalThis.jest;
`;
const EXTENSIONS = ["ts", "mts", "cts"];
const probesUnder = (roots: readonly string[]): string[] =>
  roots.flatMap((root) =>
    EXTENSIONS.map((ext) =>
      path.join(REPO, root, `type-environment-probe.${ext}`),
    ),
  );

// The project `config` names, parsed as `pnpm typecheck` parses it, with the
// probes on disk beside its files: they stand in an empty directory of their
// own, and the project's include and exclude decide whether each is one of
// its files.
function projectWith(config: string, probes: readonly string[]) {
  const shadow = fs.mkdtempSync(path.join(os.tmpdir(), "type-environment-"));
  try {
    for (const probe of probes) {
      const at = path.join(shadow, path.relative(REPO, probe));
      fs.mkdirSync(path.dirname(at), { recursive: true });
      fs.writeFileSync(at, "");
    }
    const readDirectory: ts.ParseConfigHost["readDirectory"] = (
      root,
      ...rest
    ) => [
      ...ts.sys.readDirectory(root, ...rest),
      ...ts.sys
        .readDirectory(path.join(shadow, path.relative(REPO, root)), ...rest)
        .map((at) => path.join(REPO, path.relative(shadow, at))),
    ];
    const { config: raw } = ts.readConfigFile(config, ts.sys.readFile);
    return ts.parseJsonConfigFileContent(
      raw,
      { ...ts.sys, readDirectory },
      path.dirname(config),
    );
  } finally {
    fs.rmSync(shadow, { recursive: true });
  }
}

// Each probe's own diagnostics, as `pnpm typecheck` would report them.
function diagnosticsOf(
  project: ts.ParsedCommandLine,
  probes: readonly string[],
): Record<string, string[]> {
  const host = ts.createCompilerHost(project.options);
  const read = host.getSourceFile.bind(host);
  host.getSourceFile = (name, language, ...rest) =>
    probes.includes(name)
      ? ts.createSourceFile(name, PROBE, language)
      : read(name, language, ...rest);
  const program = ts.createProgram(project.fileNames, project.options, host);
  return Object.fromEntries(
    probes.map((probe) => [
      path.relative(REPO, probe),
      ts
        .getPreEmitDiagnostics(program, program.getSourceFile(probe))
        .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")),
    ]),
  );
}

describe("the type environments", () => {
  test("code outside Jest that reads Jest's globals does not type-check, in every root and every extension", () => {
    const probes = probesUnder(["src/", ...outsideJestRoots()]);
    const project = projectWith(path.join(REPO, "tsconfig.json"), probes);
    expect(probes.filter((p) => !project.fileNames.includes(p))).toEqual([]);
    const found = diagnosticsOf(project, probes);
    // TypeScript adds a hint to some of these, after the sentence.
    const refused = [
      expect.stringMatching(/^Cannot find name 'expect'\./),
      expect.stringMatching(/^Cannot find name 'describe'\./),
      expect.stringContaining("Element implicitly has an 'any' type"),
    ];
    expect(found).toEqual(
      Object.fromEntries(Object.keys(found).map((probe) => [probe, refused])),
    );
  }, 60_000);

  test("a test that reads them type-checks", () => {
    const probes = probesUnder(["test/"]);
    const project = projectWith(
      path.join(REPO, "test", "tsconfig.json"),
      probes,
    );
    expect(probes.filter((p) => !project.fileNames.includes(p))).toEqual([]);
    const found = diagnosticsOf(project, probes);
    expect(found).toEqual(
      Object.fromEntries(Object.keys(found).map((probe) => [probe, []])),
    );
  }, 60_000);
});

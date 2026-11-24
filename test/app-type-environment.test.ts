// [LAW:one-way-deps] The app's type environment holds Node's types alone, so
// a Jest global in app code is a type error, `globalThis.jest` included; the
// test project extends it with Jest's. Each probe is type-checked under the
// real tsconfig of the project it would belong to.

import path from "node:path";

import ts from "typescript";

import { REPO } from "../scripts/lib/repo.cjs";

const PROBE = `expect(1);
describe("x", () => {});
export const mock = globalThis.jest;
`;

// The probe's own diagnostics, as `pnpm typecheck` would report them, under
// the project `config` names, placed at `file`.
function diagnosticsAt(config: string, file: string): string[] {
  const { config: raw } = ts.readConfigFile(config, ts.sys.readFile);
  const { options } = ts.parseJsonConfigFileContent(
    raw,
    ts.sys,
    path.dirname(config),
  );
  const host = ts.createCompilerHost(options);
  const read = host.getSourceFile.bind(host);
  host.getSourceFile = (name, language, ...rest) =>
    name === file
      ? ts.createSourceFile(name, PROBE, language)
      : read(name, language, ...rest);
  const program = ts.createProgram([file], options, host);
  return ts
    .getPreEmitDiagnostics(program, program.getSourceFile(file))
    .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
}

describe("the type environments", () => {
  test("app code that reads Jest's globals does not type-check", () => {
    const found = diagnosticsAt(
      path.join(REPO, "tsconfig.json"),
      path.join(REPO, "src", "type-environment-probe.ts"),
    );
    // TypeScript adds a hint to some of these, after the sentence.
    expect(found).toEqual([
      expect.stringMatching(/^Cannot find name 'expect'\./),
      expect.stringMatching(/^Cannot find name 'describe'\./),
      expect.stringContaining("Element implicitly has an 'any' type"),
    ]);
  }, 60_000);

  test("a test that reads them type-checks", () => {
    expect(
      diagnosticsAt(
        path.join(REPO, "test", "tsconfig.json"),
        path.join(REPO, "test", "type-environment-probe.ts"),
      ),
    ).toEqual([]);
  }, 60_000);
});

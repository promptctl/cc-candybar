import path from "node:path";
import ts from "typescript";
import type { OwnedSource } from "./code-inventory.js";

const configs = {
  node: "tsconfig.json",
  jest: "test/tsconfig.json",
  browser: "tsconfig.browser.json",
} as const satisfies Record<OwnedSource["environment"], string>;

export interface TypeProject {
  config: string;
  parsed: ts.ParsedCommandLine;
  sources: readonly OwnedSource[];
}

// TypeScript resolves leading directives itself, including shebangs and the
// precedence of a later @ts-check. Its SourceFile carries the effective
// CheckJsDirective; the public SourceFile interface omits that parser field.
function fileCheckFailure(
  root: string,
  source: OwnedSource,
): string | undefined {
  const text = ts.sys.readFile(path.resolve(root, source.path));
  if (text === undefined) return `Cannot read owned source ${source.path}`;
  const file = ts.createSourceFile(source.path, text, ts.ScriptTarget.Latest);
  if (!("checkJsDirective" in file))
    return `Cannot determine ${source.path}'s file-wide checking directive with TypeScript ${ts.version}`;
  const directive = file.checkJsDirective as ts.CheckJsDirective | undefined;
  return directive?.enabled === false
    ? `${source.path} (owned by ${source.row}) disables file-wide type checking with @ts-nocheck. Declare any source exemption in scripts/import-zones.mjs.`
    : undefined;
}

// [LAW:single-enforcer] Lint and typecheck judge the same parsed root files.
// An imported file can enter a TypeScript program transitively even if the
// owning project's include is wrong. Only the declared roots prove membership.
export function readTypeProjects(
  root: string,
  sources: readonly OwnedSource[],
) {
  const projects: TypeProject[] = [];
  const failures: string[] = [];
  for (const [environment, config] of Object.entries(configs)) {
    const owned = sources.filter(
      (source) => source.environment === environment,
    );
    const report = (d: ts.Diagnostic) =>
      failures.push(
        `${config}: ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`,
      );
    const parsed = ts.getParsedCommandLineOfConfigFile(
      path.resolve(root, config),
      {},
      {
        ...ts.sys,
        onUnRecoverableConfigFileDiagnostic: report,
      },
    );
    if (!parsed) continue;
    for (const diagnostic of parsed.errors) report(diagnostic);
    const roots = new Set(
      parsed.fileNames.map((file) =>
        path.relative(root, file).split(path.sep).join("/"),
      ),
    );
    for (const source of owned) {
      if (!roots.has(source.path)) {
        failures.push(
          `${source.path} (owned by ${source.row}) is missing from ${config}'s root files`,
        );
        continue;
      }
      const failure = fileCheckFailure(root, source);
      if (failure) failures.push(failure);
    }
    projects.push({ config, parsed, sources: owned });
  }
  return { projects, failures };
}

export function typeCoverageFailures(
  root: string,
  sources: readonly OwnedSource[],
): readonly string[] {
  return readTypeProjects(root, sources).failures;
}

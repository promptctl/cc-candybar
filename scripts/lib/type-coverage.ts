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
      if (!roots.has(source.path))
        failures.push(
          `${source.path} (owned by ${source.row}) is missing from ${config}'s root files`,
        );
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

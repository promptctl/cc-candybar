import path from "node:path";
import ts from "typescript";
import { isJavaScript } from "./import-zones.mjs";
import { inventory } from "./lib/code-inventory.js";
import { REPO } from "./lib/repo.cjs";
import { readTypeProjects } from "./lib/type-coverage.js";

const { projects, failures } = readTypeProjects(REPO, inventory(REPO));
for (const failure of failures) console.error(failure);
if (failures.length > 0) process.exitCode = 1;
else {
  const format: ts.FormatDiagnosticsHost = {
    getCanonicalFileName: (file) => file,
    getCurrentDirectory: () => REPO,
    getNewLine: () => "\n",
  };
  for (const { parsed, sources } of projects) {
    const js = sources
      .map(({ path: file }) => path.resolve(REPO, file))
      .filter(isJavaScript);
    const declarations = parsed.fileNames.filter((file) =>
      /\.d\.[cm]?ts$/.test(file),
    );
    // [LAW:one-way-deps] JS shares its environment and declarations with TS.
    // Only JS may infer unannotated parameters as any. Every TS file still
    // receives all of the strict program's diagnostics.
    for (const [roots, options, checkingJs] of [
      [parsed.fileNames, parsed.options, false],
      [
        [...js, ...declarations],
        { ...parsed.options, checkJs: true, noImplicitAny: false },
        true,
      ],
    ] as const) {
      const program = ts.createProgram(roots, options);
      const diagnostics = [
        ...program.getOptionsDiagnostics(),
        ...program.getGlobalDiagnostics(),
      ];
      for (const file of program.getSourceFiles()) {
        // Owned declarations are source. A dependency's internal declarations
        // may refer to its uninstalled optional plugins (for example tsdown).
        if (
          program.isSourceFileFromExternalLibrary(file) ||
          program.isSourceFileDefaultLibrary(file)
        )
          continue;
        if (checkingJs !== isJavaScript(file.fileName)) continue;
        diagnostics.push(
          ...program.getSyntacticDiagnostics(file),
          ...program.getSemanticDiagnostics(file),
        );
      }
      if (diagnostics.length) {
        process.stderr.write(ts.formatDiagnostics(diagnostics, format));
        process.exitCode = 1;
      }
    }
  }
}

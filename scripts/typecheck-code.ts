import ts from "typescript";
import { isJavaScript } from "./import-zones.mjs";
import { inventory } from "./lib/code-inventory.js";
import { readTypeProjects } from "./lib/type-coverage.js";

const root = process.cwd();
const { projects, failures } = readTypeProjects(root, inventory(root));
for (const failure of failures) console.error(failure);
if (failures.length > 0) process.exitCode = 1;
else {
  const format: ts.FormatDiagnosticsHost = {
    getCanonicalFileName: (file) => file,
    getCurrentDirectory: () => root,
    getNewLine: () => "\n",
  };
  for (const { parsed } of projects) {
    // A runtime's ambient declarations can live in any of its source modules.
    // Check both languages over the same program roots, keeping unannotated
    // parameters permissible only when reporting JavaScript diagnostics.
    for (const checkingJs of [false, true]) {
      const options = checkingJs
        ? { ...parsed.options, checkJs: true, noImplicitAny: false }
        : parsed.options;
      const program = ts.createProgram(parsed.fileNames, options);
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

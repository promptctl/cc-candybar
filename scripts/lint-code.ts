// [LAW:single-enforcer] The inventory chooses a file's real checks. A shared
// library receives both the tool import rules and the suite's effect rules.
import { ESLint } from "eslint";

import { inventory, type OwnedSource } from "./lib/code-inventory.js";
import { filewideDisableLine } from "./lib/filewide-disable.js";
import { typeCoverageFailures } from "./lib/type-coverage.js";

async function lint(
  root: string,
  sources: readonly OwnedSource[],
): Promise<boolean> {
  const groups = [
    {
      config: "eslint.config.mjs",
      rule: "zones/import-direction",
      files: sources.filter(
        ({ zone }) => !["tools", "lib", "test"].includes(zone),
      ),
    },
    {
      config: "eslint.tools.config.mjs",
      rule: "zones/import-direction",
      files: sources.filter(({ zone }) => zone === "tools" || zone === "lib"),
    },
    {
      config: "eslint.tests.config.mjs",
      rule: "no-unreachable",
      files: sources.filter(({ zone }) => zone === "test" || zone === "lib"),
    },
  ];
  let passed = true;
  for (const { config, rule, files } of groups) {
    if (!files.length) continue;
    const eslint = new ESLint({
      cwd: root,
      overrideConfigFile: config,
      globInputPaths: false,
      overrideConfig: {
        linterOptions: { reportUnusedDisableDirectives: "warn" },
      },
    });
    for (const file of files) {
      const effective = await eslint.calculateConfigForFile(file.path);
      if (effective?.rules?.[rule]?.[0] !== 2)
        throw new Error(
          `${file.path} (row ${file.row}) lacks ${rule} in ${config}`,
        );
    }
    const results = await eslint.lintFiles(files.map((file) => file.path));
    const formatter = await eslint.loadFormatter("stylish");
    const formatted = await formatter.format(results);
    if (formatted) process.stdout.write(formatted);
    for (const result of results) {
      if (result.errorCount) passed = false;
      const line = filewideDisableLine(result);
      if (line !== undefined) {
        console.error(
          `${result.filePath}:${line}: File-wide eslint-disable bypasses source coverage. Narrow the directive or declare its exemption and reason in scripts/import-zones.mjs.`,
        );
        passed = false;
      }
    }
  }
  return passed;
}

try {
  const root = process.cwd();
  const sources = inventory(root);
  const missing = typeCoverageFailures(root, sources);
  if (missing.length) throw new Error(missing.join("\n"));
  if (!(await lint(root, sources))) process.exitCode = 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

// The zone table's own exports (scripts/import-zones.mjs), so a row added
// there is a case in the tests of the rules that read it. The table is ESM
// and the suite is not, so a node of its own reads it, once per file.

import { execFileSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { REPO } from "../../scripts/lib/repo.cjs";

export interface ZoneTable {
  readonly OUTSIDE_JEST_ROOTS: readonly string[];
  readonly PACKAGE_ROWS: Readonly<Record<string, string>>;
  readonly JEST_GLOBALS: readonly string[];
}

export const ZONES: ZoneTable = JSON.parse(
  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const { OUTSIDE_JEST_ROOTS, PACKAGE_ROWS, JEST_GLOBALS } = await import(${JSON.stringify(
        pathToFileURL(path.join(REPO, "scripts", "import-zones.mjs")).href,
      )}); console.log(JSON.stringify({ OUTSIDE_JEST_ROOTS, PACKAGE_ROWS, JEST_GLOBALS }));`,
    ],
    { cwd: REPO, encoding: "utf8" },
  ),
);

// A package each of Jest's rows names: the row itself, or one it begins.
export const JEST_PACKAGES: readonly string[] = Object.entries(
  ZONES.PACKAGE_ROWS,
)
  .filter(([, zone]) => zone === "test")
  .map(([row]) => (/[/-]$/.test(row) ? `${row}x` : row));

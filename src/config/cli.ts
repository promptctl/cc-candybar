// [LAW:single-enforcer] The `schema` entry point carries no schema LOGIC: it serves
// the build-generated artifact [LAW:one-source-of-truth], a binding not a rewrite.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const EXIT_VALID = 0;
const EXIT_USAGE = 2;

export function loadSchemaText(): string | null {
  const schemaPath = locateSchema();
  return schemaPath === null ? null : fs.readFileSync(schemaPath, "utf-8");
}

export function runSchema(): void {
  // [LAW:no-silent-failure] Unreadable is a distinct failure from not-found.
  let text: string | null;
  try {
    text = loadSchemaText();
  } catch (e) {
    process.stderr.write(
      `schema: cannot read bundled schema: ${e instanceof Error ? e.message : String(e)}\n`,
    );
    process.exit(EXIT_USAGE);
  }
  if (text === null) {
    process.stderr.write(
      "schema: bundled schema not found (expected schema/cc-candybar.schema.json). " +
        "Run `pnpm gen:schema` from a source checkout.\n",
    );
    process.exit(EXIT_USAGE);
  }
  process.stdout.write(text);
  process.exit(EXIT_VALID);
}

// [LAW:locality-or-seam] Anchor on argv[1], not import.meta, and walk up.
function locateSchema(): string | null {
  const rel = path.join("schema", "cc-candybar.schema.json");
  const anchor = process.argv[1];
  if (anchor === undefined) return null;
  let dir = path.dirname(path.resolve(anchor));
  for (;;) {
    const candidate = path.join(dir, rel);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

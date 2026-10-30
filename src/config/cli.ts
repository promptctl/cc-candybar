// [LAW:single-enforcer] Config-tooling CLI entry point for `schema`. It carries
// no schema LOGIC — it serves the committed artifact (derived from the
// loader's declarations), so it is a binding, not a reimplementation
// [LAW:one-source-of-truth]. Config *validation* lives in `cc-candybar check`
// (src/check.ts) — the full-pipeline verdict command; the old `lint` is its
// alias.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import type { CliPlan } from "../cli-plan.js";

const EXIT_VALID = 0;
const EXIT_USAGE = 2;

// Read the committed JSON Schema for the config file shape (RawDslConfig),
// or null when the artifact is absent. Pure read, folded by `schemaPlan` into a
// plan that src/cli-plan.ts delivers, so the locate-and-read path is testable.
export function loadSchemaText(): string | null {
  const schemaPath = locateSchema();
  return schemaPath === null ? null : fs.readFileSync(schemaPath, "utf-8");
}

// `cc-candybar schema` — print the schema so an editor can annotate a config with
// `"$schema": "<this output, saved somewhere>"` (or the stable published URL) for
// autocomplete + structural validation. Emitted from the loader schemas by
// `pnpm gen:schema` into the committed artifact; served verbatim here (the
// emitter runs in a source checkout, never at ship time).
export function schemaPlan(): CliPlan {
  // [LAW:no-silent-failure] A schema that exists but cannot be read (EACCES, a
  // deletion racing the existsSync in locateSchema) is a distinct failure from
  // schema-not-found — report it as what it is, not a misleading top-level
  // render error.
  let text: string | null;
  try {
    text = loadSchemaText();
  } catch (e) {
    return {
      stdout: "",
      stderr: `schema: cannot read bundled schema: ${e instanceof Error ? e.message : String(e)}\n`,
      code: EXIT_USAGE,
    };
  }
  if (text === null) {
    return {
      stdout: "",
      stderr:
        "schema: bundled schema not found (expected schema/cc-candybar.schema.json). " +
        "Run `pnpm gen:schema` from a source checkout.\n",
      code: EXIT_USAGE,
    };
  }
  return { stdout: text, stderr: "", code: EXIT_VALID };
}

// [LAW:locality-or-seam] The schema sits at `<package-root>/schema/...`. Anchor
// on the running CLI entry (argv[1] — `dist/index.mjs` in prod, since every
// subcommand execs the Node fallback) and walk up to the nearest ancestor that
// holds the artifact, so the prod and dev layouts aren't special-cased. argv[1]
// (not import.meta) keeps this resolvable identically under the ESM bundle and
// any module setting.
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

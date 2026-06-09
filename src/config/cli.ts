// [LAW:single-enforcer] Config-tooling CLI entry points. `lint` and `schema`
// share one module because they share one change-reason: the config grammar.
// Neither carries validation or schema LOGIC — `lint` is a second entry point
// into the loader (the single config-validation enforcer the daemon also uses),
// and `schema` serves the build-generated artifact (derived from the config
// types). Both are bindings, not reimplementations [LAW:one-source-of-truth].

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { loadConfig, validateConfig } from "./dsl-loader.js";
import { ConfigError } from "./loader/diagnostics.js";

// Exit codes are a contract (the CLI guideline: not just 0/1), so scripts and
// editors can distinguish "your config is wrong" from "I couldn't run":
//   0 — config is valid
//   1 — config is invalid (ConfigError: structural, cross-ref, or cycle)
//   2 — usage error or the file could not be read
const EXIT_VALID = 0;
const EXIT_INVALID = 1;
const EXIT_USAGE = 2;

// [LAW:dataflow-not-control-flow] The lint result is DATA — a pure function of
// the target file's contents — discriminated into the three outcomes the exit-
// code contract projects. `lintConfig` carries the decision; `runLint` only maps
// it to (stream, exit). The decision is unit-testable without spawning a process
// or stubbing process.exit, which is what makes the exit-code goal verifiable.
export type LintOutcome =
  | { readonly kind: "valid"; readonly path: string }
  | { readonly kind: "invalid"; readonly message: string }
  | {
      readonly kind: "unreadable";
      readonly path: string;
      readonly message: string;
    };

// Run the real loader (parse → merge-with-default → cross-ref + cycle validation)
// against an arbitrary file. No daemon: the loader imports only fs, JSON5, and
// pure validators, so the same errors the daemon would surface at render time are
// surfaced here ahead of time.
//
// [LAW:single-enforcer] loadConfig + validateConfig is the identical pipeline
// RenderCache.reloadInto runs in the daemon — the validation authority is one
// function, so lint cannot drift from production. The source we read is passed to
// validateConfig only to sharpen line numbers (semantic issues map to lines).
export function lintConfig(target: string): LintOutcome {
  const resolved = path.resolve(target);

  let source: string;
  try {
    source = fs.readFileSync(resolved, "utf-8");
  } catch (e) {
    return {
      kind: "unreadable",
      path: target,
      message: e instanceof Error ? e.message : String(e),
    };
  }

  try {
    const { config } = loadConfig(resolved);
    validateConfig(config, resolved, source);
  } catch (e) {
    if (e instanceof ConfigError)
      return { kind: "invalid", message: e.message };
    throw e;
  }

  return { kind: "valid", path: target };
}

// `cc-candybar lint <path>` — the argv binding. Missing-arg is a usage concern
// (not a lint outcome), handled here; everything else is the projection of
// lintConfig's outcome onto the stream + exit-code contract.
export function runLint(args: readonly string[]): void {
  const target = args[0];
  if (target === undefined || target === "") {
    process.stderr.write(
      "lint: missing <path>\nUsage: cc-candybar lint <config-file>\n",
    );
    process.exit(EXIT_USAGE);
  }
  applyLintOutcome(lintConfig(target));
}

// [LAW:dataflow-not-control-flow] The outcome → (stream, text, exit-code) mapping
// is DATA. `lintPlan` is a total fold returning that descriptor (a non-returning
// arm fails the typecheck, so the projection stays exhaustive over LintOutcome);
// `applyLintOutcome` runs the single write + exit against it. The side effects
// are unconditional; the data decides their content.
interface LintPlan {
  readonly stream: NodeJS.WriteStream;
  readonly text: string;
  readonly code: number;
}

function lintPlan(o: LintOutcome): LintPlan {
  switch (o.kind) {
    case "valid":
      return {
        stream: process.stdout,
        text: `✓ ${o.path}: config valid\n`,
        code: EXIT_VALID,
      };
    case "invalid":
      return {
        stream: process.stderr,
        text: o.message + "\n",
        code: EXIT_INVALID,
      };
    case "unreadable":
      return {
        stream: process.stderr,
        text: `lint: cannot read ${o.path}: ${o.message}\n`,
        code: EXIT_USAGE,
      };
  }
}

function applyLintOutcome(o: LintOutcome): never {
  const plan = lintPlan(o);
  plan.stream.write(plan.text);
  process.exit(plan.code);
}

// Read the build-generated JSON Schema for the config file shape (RawDslConfig),
// or null when the artifact is absent. Pure read — `runSchema` owns the side
// effects, so the locate-and-read path is testable.
export function loadSchemaText(): string | null {
  const schemaPath = locateSchema();
  return schemaPath === null ? null : fs.readFileSync(schemaPath, "utf-8");
}

// `cc-candybar schema` — print the schema so an editor can annotate a config with
// `"$schema": "<this output, saved somewhere>"` (or the stable published URL) for
// autocomplete + structural validation. Emitted from the loader schemas at build
// time (scripts/gen-schema.ts → emitConfigSchema); served verbatim here (the
// emitter runs at build, not ship time).
export function runSchema(): void {
  const text = loadSchemaText();
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

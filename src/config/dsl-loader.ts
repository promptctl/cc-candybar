// [LAW:one-type-per-behavior] Three primitives, three concerns:
//
//   parseDslConfig (text → RawDslConfig)
//     JSON5 syntax + per-record structural validation. Preserves absence of
//     top-level keys — `raw.layout === undefined` is distinct from `raw.layout
//     === []`. Throws ConfigError on syntax / structural problems.
//
//   mergeWithDefault (RawDslConfig + DslConfig → DslConfig)
//     Cascade: shallow merge globals fields, by-name merge variables and
//     segments, wholesale layout replacement when present. Pure function.
//
//   validateConfig (DslConfig → ValidatedConfig)
//     Cross-references + cycle detection on the merged shape. Sole producer
//     of ValidatedConfig. Throws ConfigError on cross-ref / cycle problems.
//
// loadConfig (path|null → DslConfig) wires parse+merge for the daemon's
// production path. validateConfig finishes the chain.
//
// [LAW:dataflow-not-control-flow] Validation passes accumulate issues into
// a list; consumers see every problem at once (compiler-style).
//
// This file is the pipeline orchestrator + the public barrel. Each validation
// concern lives in its own `loader/` module (split by change-reason); the
// re-exports below keep the import surface stable for every consumer.

import fs from "node:fs";
import JSON5 from "json5";
import {
  type DslConfig,
  type RawDslConfig,
  type ValidatedConfig,
} from "./dsl-types.js";
import { DEFAULT_DSL_CONFIG } from "./default-dsl-config.js";
import { listResolvablePaletteNames } from "../themes/policy.js";
import {
  ConfigError,
  findKeyLine,
  type ConfigIssue,
} from "./loader/diagnostics.js";
import {
  describeType,
  isPlainObject,
  type Mutable,
  type ValidateCtx,
} from "./loader/validate-core.js";
import { mergeWithDefault } from "./loader/merge.js";
import { validateGlobals } from "./loader/globals.js";
import { validateVariables } from "./loader/variables.js";
import { validateSegments } from "./loader/segments.js";
import { validateLayout, validateRoot } from "./loader/layout.js";
import { validateActions } from "./loader/actions.js";
import { validateHelpers } from "./loader/helpers.js";
import { validateCrossReferences } from "./loader/cross-ref.js";
import { validateNoCycles } from "./loader/cycles.js";

// ─── Public barrel ───────────────────────────────────────────────────────────
// [LAW:locality-or-seam] Consumers import from `dsl-loader`; the internal split
// is invisible to them. Moving a symbol between loader/ modules never touches a
// callsite as long as it stays re-exported here.

export { ConfigError, findKeyLine } from "./loader/diagnostics.js";
export type { ConfigIssue } from "./loader/diagnostics.js";
export {
  expandHome,
  dslConfigCandidatePaths,
  resolveDslConfigPath,
  detectConfigCollisions,
} from "./loader/discovery.js";
export { mergeWithDefault } from "./loader/merge.js";
export { layoutRowsToNode } from "./loader/layout.js";
export {
  extractTemplateRefs,
  extractActionRefs,
  extractPickerRefs,
} from "./loader/refs.js";

// ─── Three-stage pipeline ────────────────────────────────────────────────────

/**
 * Load a JSON5 DSL config file from disk and merge it with the bundled
 * default. Returns the effective DslConfig AND the raw source text.
 *
 * `path = null` means "no user file exists" — returns the default unchanged
 * (uniform merge against an empty raw, which is deep-equal to the default) and
 * an empty source. No consumer branches on file presence; that branch lives
 * inside loadConfig exactly once.
 *
 * [LAW:one-source-of-truth] The source is returned alongside the config so the
 * caller can hand it to validateConfig — cross-ref diagnostics (line numbers,
 * the authored-surface discriminator) are derived from it, and the file is read
 * exactly once here rather than re-read downstream.
 *
 * Throws ConfigError on JSON5 syntax / structural / per-record validation
 * failures. Cross-references and cycles are validateConfig()'s job.
 *
 * [LAW:dataflow-not-control-flow] One function, one branch, same operations
 * each call.
 */
export function loadConfig(
  path: string | null,
  dflt: DslConfig = DEFAULT_DSL_CONFIG,
  allowedPalettes?: ReadonlySet<string>,
): { config: DslConfig; source: string } {
  const source = path === null ? "" : fs.readFileSync(path, "utf-8");
  const raw: RawDslConfig =
    path === null ? {} : parseDslConfig(path, source, allowedPalettes);
  return { config: mergeWithDefault(raw, dflt), source };
}

/**
 * Promote a merged DslConfig to a ValidatedConfig by running cross-references
 * and cycle detection. Sole producer of ValidatedConfig in the codebase — the
 * phantom brand makes "the renderer never receives an unvalidated config" a
 * compile-time invariant, not a runtime convention.
 *
 * Throws ConfigError aggregating every issue.
 *
 * [LAW:single-enforcer] One cast site, here, exclusive.
 */
export function validateConfig(
  config: DslConfig,
  filePath = "<config>",
  source = "",
  allowedPalettes: ReadonlySet<string> = new Set(listResolvablePaletteNames()),
): ValidatedConfig {
  const issues: ConfigIssue[] = [];
  const ctx: ValidateCtx = { source, issues, allowedPalettes };
  validateCrossReferences(ctx, config);
  validateNoCycles(ctx, config);
  if (issues.length > 0) {
    throw new ConfigError(filePath, issues);
  }
  return config as ValidatedConfig;
}

/**
 * Parse a JSON5 DSL config source into a RawDslConfig. JSON5 syntax + per-
 * record structural validation. Cross-references and cycles are NOT checked
 * here — they belong to validateConfig, which runs on the merged shape.
 *
 * Returned shape preserves absence: a user file with no `layout` key yields
 * `raw.layout === undefined`, distinct from an explicit `layout: []`.
 *
 * `allowedPalettes` is the set of palette names a `palette:` field may name.
 * It defaults to every name that resolves to a concrete Palette, so production
 * always validates loudly against the real registry. Tests inject a custom set
 * to exercise validation without depending on registry contents.
 */
export function parseDslConfig(
  filePath: string,
  source: string,
  allowedPalettes: ReadonlySet<string> = new Set(listResolvablePaletteNames()),
): RawDslConfig {
  // ── Stage 1: JSON5 syntax. A parse error here is single, immediate, and
  // carries line/col from the json5 package — no point continuing to other
  // passes that need a parsed structure to inspect.
  const raw = parseJson5OrThrow(filePath, source);

  const issues: ConfigIssue[] = [];
  const ctx: ValidateCtx = { source, issues, allowedPalettes };

  // ── Stage 2: top-level shape + per-record shape. Absence survives as
  // `undefined` in the returned RawDslConfig.
  if (!isPlainObject(raw)) {
    throw new ConfigError(filePath, [
      {
        path: "",
        message: `Config root must be an object, got ${describeType(raw)}`,
      },
    ]);
  }

  const topLevel = validateTopLevel(ctx, raw);

  if (issues.length > 0) {
    throw new ConfigError(filePath, issues);
  }

  return topLevel;
}

// ─── Internals ───────────────────────────────────────────────────────────────

interface Json5Error extends Error {
  lineNumber?: number;
  columnNumber?: number;
}

function parseJson5OrThrow(filePath: string, source: string): unknown {
  try {
    return JSON5.parse(source);
  } catch (err) {
    const e = err as Json5Error;
    throw new ConfigError(filePath, [
      {
        path: "",
        message: `JSON5 syntax error: ${e.message}`,
        line: e.lineNumber,
        col: e.columnNumber,
      },
    ]);
  }
}

// [LAW:types-are-the-program] Returns RawDslConfig — absence of a top-level
// key survives the parse as `undefined`, distinct from explicit empty. The
// merge step downstream decides what "absent" means policy-wise (currently:
// inherit from default).
function validateTopLevel(
  ctx: ValidateCtx,
  raw: Record<string, unknown>,
): RawDslConfig {
  for (const key of Object.keys(raw)) {
    if (!TOP_LEVEL_KEYS.has(key)) {
      ctx.issues.push({
        path: key,
        message: `Unknown top-level key "${key}". Expected one of: ${[...TOP_LEVEL_KEYS].join(", ")}`,
        line: findKeyLine(ctx.source, [key]),
      });
    }
  }

  const out: Mutable<RawDslConfig> = {};
  if (raw.globals !== undefined)
    out.globals = validateGlobals(ctx, raw.globals);
  if (raw.variables !== undefined)
    out.variables = validateVariables(ctx, "variables", raw.variables);
  if (raw.segments !== undefined)
    out.segments = validateSegments(ctx, raw.segments);
  if (raw.layout !== undefined) out.layout = validateLayout(ctx, raw.layout);
  if (raw.root !== undefined) out.root = validateRoot(ctx, "root", raw.root);
  // [LAW:one-source-of-truth] One canonical layout — a config authors EITHER the
  // flat `layout` sugar OR the raw `root` node grammar, never both: two surfaces
  // for the same tree could drift. Reject the ambiguity loudly rather than
  // silently letting one win.
  if (raw.layout !== undefined && raw.root !== undefined) {
    ctx.issues.push({
      path: "root",
      message: `a config declares either "layout" (the flat-row sugar) or "root" (the node grammar), not both`,
      line: findKeyLine(ctx.source, ["root"]),
    });
  }
  if (raw.actions !== undefined)
    out.actions = validateActions(ctx, raw.actions);
  if (raw.helpers !== undefined)
    out.helpers = validateHelpers(ctx, raw.helpers);
  return out;
}

const TOP_LEVEL_KEYS = new Set([
  "globals",
  "variables",
  "segments",
  "layout",
  "root",
  "actions",
  "helpers",
]);

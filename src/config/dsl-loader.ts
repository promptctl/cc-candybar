// [LAW:one-type-per-behavior] Three primitives: parseDslConfig (syntax + per-record
// shape), mergeWithDefault (pure cascade), validateConfig (cross-refs + cycles, sole
// producer of ValidatedConfig). Passes accumulate issues, so a consumer sees them all at once.

import fs from "node:fs";
import JSON5 from "json5";
import {
  type DslConfig,
  type RawDslConfig,
  type ValidatedConfig,
} from "./dsl-types.js";
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
import { validateEditGlobals, validateGlobals } from "./loader/globals.js";
import { validateVariables } from "./loader/variables.js";
import { validateSegments } from "./loader/segments.js";
import { synthesizeGroupDecls, validateRootFragment } from "./loader/layout.js";
import { synthesizeMenuDecls } from "./loader/menu-synth.js";
import { synthesizeEditModeToggle } from "./loader/edit-mode.js";
import { synthesizeEditChrome } from "./edit-chrome.js";
import { SETTINGS_NS, synthesizeSettingsMenu } from "./settings-menu.js";
import { reservedNamespaceCollisions } from "./loader/reserved-namespace.js";
import { validateActions } from "./loader/actions.js";
import { validateLooks } from "./loader/looks.js";
import { validatePresets } from "./loader/presets.js";
import { validateHelpers } from "./loader/helpers.js";
import { validateCrossReferences } from "./loader/cross-ref.js";
import { validateNoCycles } from "./loader/cycles.js";

// [LAW:locality-or-seam] Consumers import from `dsl-loader`; the internal split is invisible.

export { ConfigError, findKeyLine } from "./loader/diagnostics.js";
export type { ConfigIssue } from "./loader/diagnostics.js";
export {
  expandHome,
  dslConfigCandidatePaths,
  resolveDslConfig,
  configResolutionNotice,
  durableConfigPath,
  detectConfigCollisions,
} from "./loader/discovery.js";
export type { ConfigResolution, Unchecked } from "./loader/discovery.js";
export { mergeWithDefault } from "./loader/merge.js";
export {
  extractTemplateRefs,
  extractActionRefs,
  extractPickerMenuRefs,
} from "./loader/refs.js";

/**
 * `path = null` means "no user file exists" — that branch lives here exactly once.
 * [LAW:one-way-deps] `dflt` is required, not defaulted to DEFAULT_DSL_CONFIG, which is
 * built ON TOP of this generic machinery. Source and raw shape ride back from one read.
 */
export function loadConfig(
  path: string | null,
  dflt: DslConfig,
  allowedPalettes?: ReadonlySet<string>,
): { config: DslConfig; raw: RawDslConfig; source: string } {
  const source = path === null ? "" : fs.readFileSync(path, "utf-8");
  const raw: RawDslConfig =
    path === null ? {} : parseDslConfig(path, source, allowedPalettes);
  return { config: mergeWithDefault(raw, dflt), raw, source };
}

/**
 * [LAW:single-enforcer] Sole producer of ValidatedConfig — one cast site, exclusive.
 */
export function validateConfig(
  config: DslConfig,
  filePath = "<config>",
  source = "",
  allowedPalettes: ReadonlySet<string> = new Set(listResolvablePaletteNames()),
): ValidatedConfig {
  const issues: ConfigIssue[] = [];
  const ctx: ValidateCtx = { source, issues, allowedPalettes, groups: [] };
  validateCrossReferences(ctx, config);
  validateNoCycles(ctx, config);
  if (issues.length > 0) {
    throw new ConfigError(filePath, issues);
  }
  // [LAW:one-source-of-truth] Synthesized HERE because both passes need the merged,
  // preset-resolved tree; the settings menu splices first so edit chrome sees the final tree.
  const withChrome = synthesizeEditChrome(synthesizeSettingsMenu(config));
  return withChrome as ValidatedConfig;
}

/**
 * Syntax + per-record shape only; cross-refs and cycles belong to validateConfig, which
 * runs on the merged shape. Absence survives as `undefined` in the returned raw shape.
 */
export function parseDslConfig(
  filePath: string,
  source: string,
  allowedPalettes: ReadonlySet<string> = new Set(listResolvablePaletteNames()),
): RawDslConfig {
  const raw = parseJson5OrThrow(filePath, source);

  const issues: ConfigIssue[] = [];
  const ctx: ValidateCtx = { source, issues, allowedPalettes, groups: [] };

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

// [LAW:types-are-the-program] Absence survives as `undefined`, distinct from explicit empty.
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
    out.globals = validateGlobals(ctx, "globals", raw.globals);
  if (raw.variables !== undefined)
    out.variables = validateVariables(ctx, "variables", raw.variables);
  if (raw.segments !== undefined)
    out.segments = validateSegments(ctx, raw.segments);
  // [LAW:no-silent-failure] Reject the removed `layout:` loudly, with a migration hint.
  if (raw.layout !== undefined) {
    ctx.issues.push({
      path: "layout",
      message:
        `"layout" is no longer supported — use "root" with the A-grammar instead.\n` +
        `  Replace:  layout: [["seg1", "seg2"], ["seg3"]]\n` +
        `  With:     root: { v: [{ h: ["seg1", "seg2"] }, "seg3"] }\n` +
        `  Single-row example:  root: { h: ["seg1", "seg2"] }`,
      line: findKeyLine(ctx.source, ["layout"]),
    });
  }
  if (raw.root !== undefined)
    out.root = validateRootFragment(ctx, "root", raw.root);
  if (raw.actions !== undefined)
    out.actions = validateActions(ctx, raw.actions);
  if (raw.looks !== undefined) out.looks = validateLooks(ctx, raw.looks);
  // [LAW:one-source-of-truth] Parsed BEFORE synthesis: a preset's `root` collects its group sugar into the same `ctx.groups`.
  if (raw.presets !== undefined)
    out.presets = validatePresets(ctx, raw.presets);
  // [LAW:one-type-per-behavior] The same fragment shape a preset carries, so it runs through the same field table.
  if (raw.editGlobals !== undefined)
    out.editGlobals = validateEditGlobals(ctx, "editGlobals", raw.editGlobals);
  if (raw.helpers !== undefined)
    out.helpers = validateHelpers(ctx, raw.helpers);
  // [LAW:one-source-of-truth] AFTER every section is parsed: each group emits its state var + cycle action + toggle segment into the raw sections.
  synthesizeGroupDecls(ctx, out);
  // [LAW:one-source-of-truth] AFTER group synthesis, since a group body may host menus.
  synthesizeMenuDecls(ctx, out);
  // [LAW:one-source-of-truth] Unconditional, so `edit.mode`/`edit.toggle` exist in EVERY parsed file; the CHROME half runs in validateConfig.
  synthesizeEditModeToggle(ctx, out);
  // [LAW:one-source-of-truth] Reserves the namespace but synthesizes nothing: the tree it splices into only exists after merge.
  reservedNamespaceCollisions(
    ctx,
    out,
    SETTINGS_NS,
    "the global settings menu",
  );
  return out;
}

// [LAW:no-silent-failure] `layout` is listed on purpose: it earns a migration error, not "unknown key".
const TOP_LEVEL_KEYS = new Set([
  "globals",
  "variables",
  "segments",
  "layout",
  "root",
  "actions",
  "looks",
  "presets",
  "editGlobals",
  "helpers",
]);

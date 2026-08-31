// [LAW:one-type-per-behavior] Three primitives, three concerns:
//
//   parseDslConfig (text → RawDslConfig)
//     JSON5 syntax + per-record structural validation. Rejects the removed
//     `layout:` key and `kind:"cells"` node with migration-pointing errors.
//     Throws ConfigError on syntax / structural problems.
//
//   mergeWithDefault (RawDslConfig + DslConfig → DslConfig)
//     Cascade: shallow merge globals fields, by-name merge variables and
//     segments, wholesale root replacement when present. Pure function.
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
import { synthesizeGroupDecls, validateRoot } from "./loader/layout.js";
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
export {
  mergeWithDefault,
  applySegmentPaletteOverrides,
} from "./loader/merge.js";
export {
  extractTemplateRefs,
  extractActionRefs,
  extractPickerMenuRefs,
} from "./loader/refs.js";

// ─── Three-stage pipeline ────────────────────────────────────────────────────

/**
 * Load a JSON5 DSL config file from disk and merge it with the given
 * default. Returns the effective DslConfig AND the raw source text.
 *
 * `path = null` means "no user file exists" — returns `dflt` unchanged
 * (uniform merge against an empty raw, which is deep-equal to `dflt`) and
 * an empty source. No consumer branches on file presence; that branch lives
 * inside loadConfig exactly once.
 *
 * [LAW:one-way-deps] `dflt` is a required parameter, not a default pointing at
 * DEFAULT_DSL_CONFIG: this module is generic merge/parse machinery, and
 * DEFAULT_DSL_CONFIG is a specific, higher-level instance built ON TOP of it
 * (default-dsl-config.ts imports parseDslConfig/mergeWithDefault to
 * synthesize itself — see that file). A default param here pointing back at
 * DEFAULT_DSL_CONFIG would make this generic module depend on its own
 * specific consumer — a cycle every caller who wants "the bundled default"
 * resolves explicitly by importing DEFAULT_DSL_CONFIG themselves.
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
  dflt: DslConfig,
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
  const ctx: ValidateCtx = { source, issues, allowedPalettes, groups: [] };
  validateCrossReferences(ctx, config);
  validateNoCycles(ctx, config);
  if (issues.length > 0) {
    throw new ConfigError(filePath, issues);
  }
  // [LAW:one-source-of-truth] Edit-mode's CHROME half (brandon-layout-edit-
  // 2gc.3), synthesized HERE — not in parseDslConfig alongside the toggle —
  // because it needs the fully merged, preset-resolved, rootOps-replayed
  // tree cross-ref/cycles just proved sound. Its own output (segment refs
  // into freshly-synthesized segments, actions into freshly-synthesized
  // actions) is correct by construction and does not re-enter cross-ref/
  // cycle checking, exactly as group/menu synthesis's output doesn't either.
  // [LAW:dataflow-not-control-flow] candybar-settings-ui-aok.1's global settings
  // menu, spliced BEFORE edit chrome so edit chrome walks the final content tree
  // and treats the menu's reserved `settings.` names as chrome-exempt — the
  // full ordering argument lives in settings-menu.ts's header, beside the pass
  // it governs.
  const withChrome = synthesizeEditChrome(synthesizeSettingsMenu(config));
  return withChrome as ValidatedConfig;
}

/**
 * Parse a JSON5 DSL config source into a RawDslConfig. JSON5 syntax + per-
 * record structural validation. Cross-references and cycles are NOT checked
 * here — they belong to validateConfig, which runs on the merged shape.
 *
 * Returned shape preserves absence: top-level keys are optional in RawDslConfig.
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
  const ctx: ValidateCtx = { source, issues, allowedPalettes, groups: [] };

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
    out.globals = validateGlobals(ctx, "globals", raw.globals);
  if (raw.variables !== undefined)
    out.variables = validateVariables(ctx, "variables", raw.variables);
  if (raw.segments !== undefined)
    out.segments = validateSegments(ctx, raw.segments);
  // [LAW:no-silent-failure] `layout:` was removed in 2de.19. Reject loudly with
  // a migration hint so the author knows exactly how to rewrite their config.
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
  if (raw.root !== undefined) out.root = validateRoot(ctx, "root", raw.root);
  if (raw.actions !== undefined)
    out.actions = validateActions(ctx, raw.actions);
  if (raw.looks !== undefined) out.looks = validateLooks(ctx, raw.looks);
  // [LAW:one-source-of-truth] Parsed BEFORE the synthesis passes below, because
  // a preset's `root` runs through the same validateRoot and therefore collects
  // its group sugar into the same `ctx.groups` the top-level root does — the
  // synthesized artifacts must see every group the config declares, wherever it
  // was staged from.
  if (raw.presets !== undefined)
    out.presets = validatePresets(ctx, raw.presets);
  // [LAW:one-type-per-behavior] Edit mode's staged display globals — the same
  // fragment shape a preset carries, one rung later in the precedence chain, so
  // it runs through the same field table (validateEditGlobals) rather than a
  // parallel schema listing which globals edit mode may set.
  if (raw.editGlobals !== undefined)
    out.editGlobals = validateEditGlobals(ctx, "editGlobals", raw.editGlobals);
  if (raw.helpers !== undefined)
    out.helpers = validateHelpers(ctx, raw.helpers);
  // [LAW:one-source-of-truth] Group sugar synthesis runs AFTER every section
  // parsed: each group collected during the root walk emits its state var +
  // cycle action + toggle segment into the raw sections (so they merge over the
  // default and cross-ref like any user declaration), and user names under the
  // reserved namespace are rejected against the fully-parsed sections.
  synthesizeGroupDecls(ctx, out);
  // [LAW:one-source-of-truth] Menu synthesis runs AFTER group synthesis (a group
  // body may host menu-bearing segments) and after every section parsed: each
  // menu placement detected in the root walk emits its state var + cycle action
  // into the raw sections, so they merge over the default, derive the click gate
  // through deriveActionValidators, and collide loudly with any user name under
  // the reserved namespace.
  synthesizeMenuDecls(ctx, out);
  // [LAW:one-source-of-truth] Edit-mode's TOGGLE half (brandon-layout-edit-
  // 2gc.3) — unconditional, like the reservation above, so `edit.mode`/
  // `edit.toggle` exist in EVERY parsed file and a hand-authored trigger
  // segment cross-ref-checks normally. The CHROME half (the per-position +/-
  // affordances) runs later, in validateConfig, once the merged/preset-
  // resolved/rootOps-replayed tree exists to derive it from.
  synthesizeEditModeToggle(ctx, out);
  // [LAW:one-source-of-truth] The global settings menu reserves its namespace
  // here and synthesizes NOTHING here: the tree it must be present in only
  // exists after merge (a user `root` replaces the default's), so the artifacts
  // are minted in validateConfig. The reservation is unconditional all the same,
  // mirroring every other namespace above — "you never author settings.*" is a
  // stable contract, not a rule that switches on when the pass happens to fire.
  reservedNamespaceCollisions(
    ctx,
    out,
    SETTINGS_NS,
    "the global settings menu",
  );
  return out;
}

// [LAW:no-silent-failure] `layout` is intentionally absent — a config that
// writes it gets an explicit migration error, not an "unknown key" message.
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

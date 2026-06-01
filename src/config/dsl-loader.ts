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

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSON5 from "json5";
import {
  CACHE_KEYS,
  GIT_FIELDS,
  DIRECTIONS,
  JUSTIFY_MODES,
  SOURCES_REQUIRING_CACHE,
  SOURCE_KINDS,
  TRUNCATE_MODES,
  hasCacheField,
  type CacheDecl,
  type CacheKey,
  type DslConfig,
  type GitField,
  type Globals,
  type JustifyMode,
  type LayoutRow,
  type LayoutNode,
  type InlineNode,
  type InlineCell,
  type ClickWrite,
  type Direction,
  type RawDslConfig,
  type SegmentDecl,
  type SourceKind,
  type TruncateMode,
  type ValidatedConfig,
  type VariableDecl,
  walkNodes,
  TERM_COLS_VAR,
} from "./dsl-types.js";
import {
  ACTION_KEYS,
  OPTION_SOURCES,
  WIDGET_KINDS,
  widgetStateUse,
  type Action,
  type ActionKey,
  type ButtonItem,
  type MenuTreeItem,
  type OptionSource,
  type StepperWidget,
  type TreeWidget,
  type WidgetDecl,
} from "./widget.js";
import { DEFAULT_DSL_CONFIG } from "./default-dsl-config.js";
import { listResolvablePaletteNames } from "../themes/policy.js";

// ─── Public types ────────────────────────────────────────────────────────────

export interface ConfigIssue {
  /** Dotted logical path inside the config (e.g., "variables.foo.cache"). */
  readonly path: string;
  /** Short, actionable description of the problem. */
  readonly message: string;
  /** Source line (1-based). For semantic errors, best-effort from the path. */
  readonly line?: number;
  /** Source column (1-based). Present only for parse errors. */
  readonly col?: number;
}

export class ConfigError extends Error {
  readonly file: string;
  readonly issues: readonly ConfigIssue[];

  constructor(file: string, issues: readonly ConfigIssue[]) {
    super(formatIssues(file, issues));
    this.name = "ConfigError";
    this.file = file;
    this.issues = issues;
  }
}

// ─── Config-file discovery ───────────────────────────────────────────────────

// [LAW:one-source-of-truth] The set of accepted extensions lives here once.
// Both .json5 and .json are accepted: JSON ⊂ JSON5, so the same parser
// (JSON5.parse) handles both — only the filename lookup varies. Ordering is
// load-bearing: .json5 wins over .json at the same location (documented
// format > compatibility tail).
const CONFIG_EXTENSIONS = ["json5", "json"] as const;

// [LAW:single-enforcer] One implementation of `~`-prefix expansion, called at
// each trust boundary that takes a user-supplied path. The CLI `--config`
// value is expanded in `parseRenderArgs` (server.ts) before it ever reaches
// here; `CC_CANDYBAR_CONFIG` is expanded below where the env var is read.
// One function, one rule, two callers.
//
// [LAW:enumeration-gap] Only the shell-standard home-expansion forms trigger
// replacement: bare `~`, `~/...`, or `~\...` on Windows. A string like
// `~alice/cfg` (POSIX named-home lookup) is NOT expanded — we have no way
// to resolve another user's home and a literal substitution would corrupt
// the path (`<homedir>alice/cfg`).
export function expandHome(p: string): string {
  return p === "~" || p.startsWith("~/") || p.startsWith("~\\")
    ? os.homedir() + p.slice(1)
    : p;
}

/**
 * The full ordered list of candidate paths the DSL config could live at,
 * for a given (projectDir, cwd). Returned regardless of which exist — the
 * cache uses this to watch every candidate location so the creation of any
 * file in the resolution chain triggers hot-reload.
 *
 * `configFile` is the highest-precedence entry — the path resolved from the
 * client's `--config` flag (already `~`-expanded at the trust boundary in
 * server.ts). When present, it is the sole candidate and the rest of the
 * precedence chain is bypassed.
 *
 * [LAW:single-enforcer] One enumerator; `resolveDslConfigPath` finds the
 * first that exists, watchers listen on all of them, no second list.
 *
 * [LAW:dataflow-not-control-flow] Location is the dominant precedence axis;
 * extension breaks ties within a location. Encoded as a nested flat-map: each
 * location yields one path per extension in order. No branches on extension.
 */
export function dslConfigCandidatePaths(
  projectDir?: string,
  cwd?: string,
  configFile?: string,
): readonly string[] {
  // CLI --config wins over everything — highest precedence. Pre-expanded at
  // the trust boundary; trust the type here.
  if (configFile) {
    return [configFile];
  }

  const envPath = process.env.CC_CANDYBAR_CONFIG;
  if (envPath) {
    // [LAW:single-enforcer] env-var is a separate trust boundary; expand here
    // where the env is read, with the shared `expandHome` helper. [LAW:
    // dataflow-not-control-flow] When the env var sets the path, it's the
    // *only* candidate — the precedence chain collapses to one entry.
    return [expandHome(envPath)];
  }

  const effectiveCwd = cwd ?? process.cwd();
  const xdgConfigHome =
    process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");

  return [
    ...(projectDir
      ? CONFIG_EXTENSIONS.map((ext) =>
          path.join(projectDir, `.cc-candybar.${ext}`),
        )
      : []),
    ...CONFIG_EXTENSIONS.map((ext) =>
      path.join(effectiveCwd, `.cc-candybar.${ext}`),
    ),
    ...CONFIG_EXTENSIONS.map((ext) =>
      path.join(xdgConfigHome, "cc-candybar", `config.${ext}`),
    ),
  ];
}

/**
 * Resolution order for the user's DSL config file:
 *   1. `configFile` (the CLI `--config <path>` value, already `~`-expanded)
 *   2. $CC_CANDYBAR_CONFIG env var (literal path, `~`-expanded here)
 *   3. `<projectDir>/.cc-candybar.json5`
 *   4. `<projectDir>/.cc-candybar.json`
 *   5. `<cwd>/.cc-candybar.json5`
 *   6. `<cwd>/.cc-candybar.json`
 *   7. `$XDG_CONFIG_HOME/cc-candybar/config.json5`
 *      (defaulting to `~/.config/cc-candybar/config.json5`)
 *   8. `$XDG_CONFIG_HOME/cc-candybar/config.json`
 *
 * Returns the first path that exists, or null if none do.
 *
 * [LAW:dataflow-not-control-flow] The locations array is data; the search is
 * `locations.find(fs.existsSync)`. Adding a layer is a new array entry, not a
 * new branch. Extension support is a property of the candidate list, not the
 * search.
 *
 * [LAW:single-enforcer] Built on top of `dslConfigCandidatePaths` — the
 * precedence list lives in one place.
 */
export function resolveDslConfigPath(
  projectDir?: string,
  cwd?: string,
  configFile?: string,
): string | null {
  return (
    dslConfigCandidatePaths(projectDir, cwd, configFile).find(fs.existsSync) ??
    null
  );
}

/**
 * Detect same-location extension collisions: any location where BOTH
 * `<base>.json5` and `<base>.json` exist simultaneously. The resolver picks
 * .json5 (documented format wins), but the user almost certainly didn't
 * intend to keep two; the duplicate is dead weight that will drift.
 *
 * Returns a human-readable warning naming the conflicting files, or null if
 * no collisions exist. The render path surfaces this through the daemon's
 * diagnostics channel so the user sees it on every render until they remove
 * the duplicate.
 *
 * [LAW:single-enforcer] Consumes `dslConfigCandidatePaths` — same enumerator
 * as the resolver and watcher; collision detection cannot disagree with
 * resolution about which files are candidates.
 *
 * [LAW:dataflow-not-control-flow] Walk candidates, group by parent directory
 * + base name (without extension), find groups with size > 1 whose members
 * all exist. No special-case branches per extension.
 */
export function detectConfigCollisions(
  projectDir?: string,
  cwd?: string,
): string | null {
  const candidates = dslConfigCandidatePaths(projectDir, cwd);
  // [LAW:dataflow-not-control-flow] Dedupe candidates by full path first.
  // When projectDir === cwd (a very common case — the daemon often resolves
  // both from the same hook payload), the enumerator yields the same path
  // at both precedence levels. That is a structural duplicate of *position
  // in the precedence list*, not a same-location duplicate of *files on
  // disk*. The latter is what collision detection is for; the former is
  // noise that would fire a false positive.
  const seen = new Set<string>();
  const uniqueExisting: string[] = [];
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    if (!fs.existsSync(candidate)) continue;
    uniqueExisting.push(candidate);
  }
  // Group by (dir + base-without-extension). A group with > 1 existing
  // member is a collision at that logical location.
  const groups = new Map<string, string[]>();
  for (const candidate of uniqueExisting) {
    const dir = path.dirname(candidate);
    const base = path.basename(candidate).replace(/\.(json5|json)$/, "");
    const key = path.join(dir, base);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(candidate);
  }
  const collisions = [...groups.values()].filter((g) => g.length > 1);
  if (collisions.length === 0) return null;
  // Stable, parseable message. The first file in each group is the .json5
  // (the one that wins); the rest are the shadowed siblings.
  const lines = collisions.map((g) => {
    const [winner, ...shadowed] = g;
    return `${winner} shadows ${shadowed.join(", ")}`;
  });
  return `config-extension collision: ${lines.join("; ")} — remove the duplicate`;
}

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
 * Merge a RawDslConfig on top of a default DslConfig. Pure function.
 *
 *   globals    : shallow merge per field (user wins per-field)
 *   variables  : merge by name (user wins per-name)
 *   segments   : merge by name (user wins per-name)
 *   root       : the canonical layout tree. Authored directly (`root`) wins;
 *                else the flat `layout` sugar is compiled to a tree
 *                (layoutRowsToNode); else the default's tree. `layout` replaces
 *                wholesale when present (including explicit `[]`, which compiles
 *                to an empty container = "render no segments"). Only when the
 *                user wrote NEITHER `root` nor `layout` does the default apply.
 *                [LAW:one-source-of-truth] The two authoring surfaces collapse
 *                to one `root` here; parseDslConfig rejects writing both.
 *
 * [LAW:one-source-of-truth] The single point that consults DEFAULT_DSL_CONFIG
 * for missing keys. Adding a new merged top-level key is a new line here, not
 * a new branch at consumers.
 */
export function mergeWithDefault(
  raw: RawDslConfig,
  dflt: DslConfig = DEFAULT_DSL_CONFIG,
): DslConfig {
  return {
    globals: { ...dflt.globals, ...(raw.globals ?? {}) },
    variables: { ...dflt.variables, ...(raw.variables ?? {}) },
    segments: { ...dflt.segments, ...(raw.segments ?? {}) },
    root:
      raw.root !== undefined
        ? raw.root
        : raw.layout !== undefined
          ? layoutRowsToNode(raw.layout)
          : dflt.root,
    // [LAW:one-source-of-truth] widgets merge by name (user wins per-name),
    // identical cascade to variables/segments — a user declares only the
    // widgets that differ from the bundled default.
    widgets: { ...dflt.widgets, ...(raw.widgets ?? {}) },
  };
}

// [LAW:one-source-of-truth] THE compiler from the flat-vertical `layout` sugar
// to the canonical node tree: a list of rows becomes one vertical container of
// `cells` leaves, in order, each carrying the row's segments and (if present)
// its `when`. This is the only place the sugar shape is interpreted; everything
// downstream sees the tree.
export function layoutRowsToNode(rows: readonly LayoutRow[]): LayoutNode {
  return {
    kind: "container",
    direction: "vertical",
    children: rows.map((row) =>
      row.when !== undefined
        ? { kind: "cells", segments: row.segments, when: row.when }
        : { kind: "cells", segments: row.segments },
    ),
  };
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

interface ValidateCtx {
  readonly source: string;
  readonly issues: ConfigIssue[];
  readonly allowedPalettes: ReadonlySet<string>;
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
  if (raw.widgets !== undefined)
    out.widgets = validateWidgets(ctx, raw.widgets);
  return out;
}

const TOP_LEVEL_KEYS = new Set([
  "globals",
  "variables",
  "segments",
  "layout",
  "root",
  "widgets",
]);

// ─── Globals ─────────────────────────────────────────────────────────────────

function validateGlobals(ctx: ValidateCtx, raw: unknown): Globals {
  if (raw === undefined) return {};
  if (!isPlainObject(raw)) {
    ctx.issues.push({
      path: "globals",
      message: `globals must be an object, got ${describeType(raw)}`,
      line: findKeyLine(ctx.source, ["globals"]),
    });
    return {};
  }

  const out: Mutable<Globals> = {};
  const allowed = new Set([
    "default_bg",
    "default_fg",
    "default_empty_value",
    "default_separator",
    "default_truncate_marker",
    "palette",
  ]);

  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      ctx.issues.push({
        path: `globals.${key}`,
        message: `Unknown globals key "${key}". Expected one of: ${[...allowed].join(", ")}`,
        line: findKeyLine(ctx.source, ["globals", key]),
      });
    }
  }

  for (const stringKey of [
    "default_bg",
    "default_fg",
    "default_empty_value",
    "default_separator",
    "default_truncate_marker",
  ] as const) {
    const v = raw[stringKey];
    if (v === undefined) continue;
    if (typeof v !== "string") {
      ctx.issues.push({
        path: `globals.${stringKey}`,
        message: `globals.${stringKey} must be a string, got ${describeType(v)}`,
        line: findKeyLine(ctx.source, ["globals", stringKey]),
      });
      continue;
    }
    out[stringKey] = v;
  }

  const palette = validatePaletteName(ctx, "globals", raw);
  if (palette !== undefined) out.palette = palette;

  return out;
}

// ─── Variables ───────────────────────────────────────────────────────────────

function validateVariables(
  ctx: ValidateCtx,
  pathPrefix: string,
  raw: unknown,
): Record<string, VariableDecl> {
  if (raw === undefined) return {};
  if (!isPlainObject(raw)) {
    ctx.issues.push({
      path: pathPrefix,
      message: `${pathPrefix} must be an object, got ${describeType(raw)}`,
      line: findKeyLine(ctx.source, pathPrefix.split(".")),
    });
    return {};
  }

  const out: Record<string, VariableDecl> = {};
  for (const [name, decl] of Object.entries(raw)) {
    const path = `${pathPrefix}.${name}`;
    const parsed = validateVariable(ctx, path, decl);
    if (parsed !== null) out[name] = parsed;
  }
  return out;
}

function validateVariable(
  ctx: ValidateCtx,
  path: string,
  raw: unknown,
): VariableDecl | null {
  if (!isPlainObject(raw)) {
    ctx.issues.push({
      path,
      message: `${path} must be an object, got ${describeType(raw)}`,
      line: findKeyLine(ctx.source, path.split(".")),
    });
    return null;
  }

  const rawKind = raw.kind;
  if (typeof rawKind !== "string") {
    ctx.issues.push({
      path: `${path}.kind`,
      message: `${path}.kind must be a string, got ${describeType(rawKind)}`,
      line: findKeyLine(ctx.source, path.split(".")),
    });
    return null;
  }
  if (!isSourceKind(rawKind)) {
    ctx.issues.push({
      path: `${path}.kind`,
      message: `Unknown source kind "${rawKind}". Expected one of: ${SOURCE_KINDS.join(", ")}`,
      line: findKeyLine(ctx.source, [...path.split("."), "kind"]),
    });
    return null;
  }

  // Cache: required for shell/file/git; optional for template/time; n/a for
  // literal/input/env. Per-kind dispatch handles the requirement.
  return validateVariableByKind(ctx, path, rawKind, raw);
}

function validateVariableByKind(
  ctx: ValidateCtx,
  path: string,
  kind: SourceKind,
  raw: Record<string, unknown>,
): VariableDecl | null {
  switch (kind) {
    case "literal": {
      const value = raw.value;
      if (
        typeof value !== "string" &&
        typeof value !== "number" &&
        typeof value !== "boolean"
      ) {
        ctx.issues.push({
          path: `${path}.value`,
          message: `literal value must be string|number|boolean, got ${describeType(value)}`,
          line: findKeyLine(ctx.source, path.split(".")),
        });
        return null;
      }
      return {
        kind: "literal",
        value,
        ...optionalString(ctx, path, raw, "default"),
      };
    }

    case "input": {
      const p = requireString(ctx, path, raw, "path");
      if (p === null) return null;
      // [LAW:types-are-the-program] Absent `type` keeps existing string-typed
      // declarations behaving exactly as before — the daemon's augmented
      // payload carries strings (`cwd`, `model`, `session_id`) at those paths,
      // and the default at the loader is "string" not "any".
      const t = optionalEnum(ctx, path, raw, "type", [
        "string",
        "number",
        "boolean",
      ] as const);
      const def = optionalTypedDefault(ctx, path, raw, t ?? "string");
      return {
        kind: "input",
        path: p,
        ...(t !== undefined && { type: t }),
        ...(def !== undefined && { default: def }),
      };
    }

    case "env": {
      const name = requireString(ctx, path, raw, "name");
      if (name === null) return null;
      return {
        kind: "env",
        name,
        ...optionalString(ctx, path, raw, "default"),
      };
    }

    case "file": {
      const filePath = requireString(ctx, path, raw, "path");
      const cache = requireCache(ctx, path, raw, kind);
      const readMode = optionalEnum(ctx, path, raw, "readMode", [
        "whole",
        "first-line",
      ] as const);
      const regex = optionalStringField(ctx, path, raw, "regex");
      const def = optionalStringField(ctx, path, raw, "default");
      if (filePath === null || cache === null) return null;
      return {
        kind: "file",
        path: filePath,
        ...(readMode !== undefined && { readMode }),
        ...(regex !== undefined && { regex }),
        cache,
        ...(def !== undefined && { default: def }),
      };
    }

    case "shell": {
      const command = requireString(ctx, path, raw, "command");
      const cache = requireCache(ctx, path, raw, kind);
      const regex = optionalStringField(ctx, path, raw, "regex");
      const def = optionalStringField(ctx, path, raw, "default");
      if (command === null || cache === null) return null;
      return {
        kind: "shell",
        command,
        ...(regex !== undefined && { regex }),
        cache,
        ...(def !== undefined && { default: def }),
      };
    }

    case "template": {
      const template = requireString(ctx, path, raw, "template");
      if (template === null) return null;
      const cache = optionalCache(ctx, path, raw);
      const def = optionalStringField(ctx, path, raw, "default");
      return {
        kind: "template",
        template,
        ...(cache !== undefined && { cache }),
        ...(def !== undefined && { default: def }),
      };
    }

    case "time": {
      const layout = requireString(ctx, path, raw, "layout");
      if (layout === null) return null;
      const cache = optionalCache(ctx, path, raw);
      const def = optionalStringField(ctx, path, raw, "default");
      return {
        kind: "time",
        layout,
        ...(cache !== undefined && { cache }),
        ...(def !== undefined && { default: def }),
      };
    }

    case "git": {
      const field = raw.field;
      if (
        typeof field !== "string" ||
        !GIT_FIELDS.includes(field as GitField)
      ) {
        ctx.issues.push({
          path: `${path}.field`,
          message: `git field must be one of: ${GIT_FIELDS.join(", ")}, got ${JSON.stringify(field)}`,
          line: findKeyLine(ctx.source, [...path.split("."), "field"]),
        });
        return null;
      }
      const cache = requireCache(ctx, path, raw, kind);
      const def = optionalStringField(ctx, path, raw, "default");
      if (cache === null) return null;
      return {
        kind: "git",
        field: field as GitField,
        cache,
        ...(def !== undefined && { default: def }),
      };
    }

    case "state": {
      const key = requireString(ctx, path, raw, "key");
      if (key === null) return null;
      const def = optionalStringField(ctx, path, raw, "default");
      return {
        kind: "state",
        key,
        ...(def !== undefined && { default: def }),
      };
    }
  }
}

// ─── Cache ───────────────────────────────────────────────────────────────────

function requireCache(
  ctx: ValidateCtx,
  path: string,
  raw: Record<string, unknown>,
  kind: SourceKind,
): CacheDecl | null {
  if (raw.cache === undefined) {
    if (SOURCES_REQUIRING_CACHE.includes(kind)) {
      ctx.issues.push({
        path: `${path}.cache`,
        message: `${kind} variables must declare a cache policy (one of: ${CACHE_KEYS.join(", ")})`,
        line: findKeyLine(ctx.source, path.split(".")),
      });
      return null;
    }
    // For kinds where cache is optional and absent, this path is unreachable
    // because callers use optionalCache; keep narrow.
    return null;
  }
  return validateCache(ctx, `${path}.cache`, raw.cache);
}

function optionalCache(
  ctx: ValidateCtx,
  path: string,
  raw: Record<string, unknown>,
): CacheDecl | undefined {
  if (raw.cache === undefined) return undefined;
  const c = validateCache(ctx, `${path}.cache`, raw.cache);
  return c ?? undefined;
}

function validateCache(
  ctx: ValidateCtx,
  path: string,
  raw: unknown,
): CacheDecl | null {
  if (!isPlainObject(raw)) {
    ctx.issues.push({
      path,
      message: `cache must be an object, got ${describeType(raw)}`,
      line: findKeyLine(ctx.source, path.split(".")),
    });
    return null;
  }

  const present = Object.keys(raw).filter((k): k is CacheKey =>
    (CACHE_KEYS as readonly string[]).includes(k),
  );
  const unknown = Object.keys(raw).filter(
    (k) => !(CACHE_KEYS as readonly string[]).includes(k),
  );

  for (const k of unknown) {
    ctx.issues.push({
      path: `${path}.${k}`,
      message: `Unknown cache key "${k}". Expected exactly one of: ${CACHE_KEYS.join(", ")}`,
      line: findKeyLine(ctx.source, [...path.split("."), k]),
    });
  }

  if (present.length === 0) {
    ctx.issues.push({
      path,
      message: `cache must declare exactly one of: ${CACHE_KEYS.join(", ")}`,
      line: findKeyLine(ctx.source, path.split(".")),
    });
    return null;
  }
  if (present.length > 1) {
    ctx.issues.push({
      path,
      message: `cache must declare exactly one of: ${CACHE_KEYS.join(", ")} (found: ${present.join(", ")})`,
      line: findKeyLine(ctx.source, path.split(".")),
    });
    return null;
  }

  const key = present[0]!;
  const value = raw[key];
  return validateCacheVariant(ctx, `${path}.${key}`, key, value);
}

function validateCacheVariant(
  ctx: ValidateCtx,
  path: string,
  key: CacheKey,
  value: unknown,
): CacheDecl | null {
  switch (key) {
    case "ttl":
      if (typeof value !== "string" || !isValidDuration(value)) {
        ctx.issues.push({
          path,
          message: `cache.ttl must be a duration string like "5s", "100ms", "2m", "1h"; got ${describeValue(value)}`,
          line: findKeyLine(ctx.source, path.split(".")),
        });
        return null;
      }
      return { ttl: value };

    case "watch_file":
      if (typeof value !== "string" || value === "") {
        ctx.issues.push({
          path,
          message: `cache.watch_file must be a non-empty path string, got ${describeValue(value)}`,
          line: findKeyLine(ctx.source, path.split(".")),
        });
        return null;
      }
      return { watch_file: value };

    case "depends_on":
      if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
        ctx.issues.push({
          path,
          message: `cache.depends_on must be an array of variable-name strings, got ${describeValue(value)}`,
          line: findKeyLine(ctx.source, path.split(".")),
        });
        return null;
      }
      return { depends_on: value as string[] };

    case "key":
      if (typeof value !== "string" || value === "") {
        ctx.issues.push({
          path,
          message: `cache.key must be a non-empty template string, got ${describeValue(value)}`,
          line: findKeyLine(ctx.source, path.split(".")),
        });
        return null;
      }
      return { key: value };

    case "never":
      if (value !== true) {
        ctx.issues.push({
          path,
          message: `cache.never must be the literal boolean true, got ${describeValue(value)}`,
          line: findKeyLine(ctx.source, path.split(".")),
        });
        return null;
      }
      return { never: true };
  }
}

const DURATION_RE = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/;
function isValidDuration(s: string): boolean {
  return DURATION_RE.test(s);
}

// ─── Segments ────────────────────────────────────────────────────────────────

function validateSegments(
  ctx: ValidateCtx,
  raw: unknown,
): Record<string, SegmentDecl> {
  if (raw === undefined) return {};
  if (!isPlainObject(raw)) {
    ctx.issues.push({
      path: "segments",
      message: `segments must be an object, got ${describeType(raw)}`,
      line: findKeyLine(ctx.source, ["segments"]),
    });
    return {};
  }

  const out: Record<string, SegmentDecl> = {};
  for (const [name, decl] of Object.entries(raw)) {
    const parsed = validateSegment(ctx, `segments.${name}`, decl);
    if (parsed !== null) out[name] = parsed;
  }
  return out;
}

function validateSegment(
  ctx: ValidateCtx,
  path: string,
  raw: unknown,
): SegmentDecl | null {
  if (!isPlainObject(raw)) {
    ctx.issues.push({
      path,
      message: `${path} must be an object, got ${describeType(raw)}`,
      line: findKeyLine(ctx.source, path.split(".")),
    });
    return null;
  }

  const template = requireString(ctx, path, raw, "template");
  if (template === null) return null;

  const allowed = new Set([
    "template",
    "width",
    "justify",
    "truncate",
    "bg",
    "fg",
    "when",
    "vars",
    "palette",
  ]);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      ctx.issues.push({
        path: `${path}.${key}`,
        message: `Unknown segment key "${key}". Expected one of: ${[...allowed].join(", ")}`,
        line: findKeyLine(ctx.source, [...path.split("."), key]),
      });
    }
  }

  const seg: Mutable<SegmentDecl> = { template };

  if (raw.width !== undefined) {
    if (raw.width === "auto") {
      seg.width = "auto";
    } else if (
      typeof raw.width === "number" &&
      Number.isInteger(raw.width) &&
      raw.width > 0
    ) {
      seg.width = raw.width;
    } else {
      ctx.issues.push({
        path: `${path}.width`,
        message: `width must be "auto" or a positive integer, got ${describeValue(raw.width)}`,
        line: findKeyLine(ctx.source, [...path.split("."), "width"]),
      });
    }
  }

  const justify = optionalEnum(ctx, path, raw, "justify", JUSTIFY_MODES);
  if (justify !== undefined) seg.justify = justify as JustifyMode;

  const truncate = optionalEnum(ctx, path, raw, "truncate", TRUNCATE_MODES);
  if (truncate !== undefined) seg.truncate = truncate as TruncateMode;

  const bg = optionalStringField(ctx, path, raw, "bg");
  if (bg !== undefined) seg.bg = bg;

  const fg = optionalStringField(ctx, path, raw, "fg");
  if (fg !== undefined) seg.fg = fg;

  const when = optionalStringField(ctx, path, raw, "when");
  if (when !== undefined) seg.when = when;

  const palette = validatePaletteName(ctx, path, raw);
  if (palette !== undefined) seg.palette = palette;

  if (raw.vars !== undefined) {
    seg.vars = validateVariables(ctx, `${path}.vars`, raw.vars);
  }

  return seg;
}

// ─── Layout ──────────────────────────────────────────────────────────────────

// [LAW:locality-or-seam] The single boundary that turns the user's layout into
// the canonical `LayoutRow[]`. Two user-file forms collapse to one shape here
// so no downstream consumer ever sees the union:
//   • a bare `string[]` row   → `{ segments: [...] }`  (predicate-less sugar)
//   • a `{ when?, segments }`  → itself                (explicit predicate form)
// Whether each name resolves to a declared segment is a cross-ref concern
// (validateCrossReferences), which runs on the MERGED config so a user's layout
// can reference default-provided segments.
//
// [LAW:types-are-the-program] Single-line is the degenerate `[[a, b, c]]` case.
// A flat `string[]` (the pre-multiline shape) is rejected with a migration-
// pointing message — no auto-wrap shim, because the shim would silently convert
// "I forgot to wrap" into a working config and hide the breaking change.
function validateLayout(ctx: ValidateCtx, raw: unknown): readonly LayoutRow[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    ctx.issues.push({
      path: "layout",
      message: `layout must be an array of rows (each row an array of segment names, or a { when?, segments } object), got ${describeType(raw)}`,
      line: findKeyLine(ctx.source, ["layout"]),
    });
    return [];
  }

  const out: LayoutRow[] = [];
  for (let r = 0; r < raw.length; r++) {
    const row = validateLayoutRow(ctx, r, raw[r]);
    if (row !== null) out.push(row);
  }
  return out;
}

// [LAW:dataflow-not-control-flow] One row → one normalized LayoutRow. The outer
// shape (array vs object) selects how `segments`/`when` are read; both land in
// the same struct. A bare string at the outer level is the legacy flat layout —
// rejected with a wrap hint, not silently shimmed [LAW:no-silent-fallbacks].
function validateLayoutRow(
  ctx: ValidateCtx,
  r: number,
  row: unknown,
): LayoutRow | null {
  if (typeof row === "string") {
    ctx.issues.push({
      path: `layout[${r}]`,
      message: `layout is now an array of rows; wrap your segment list in an outer [] (e.g. [["${row}", ...]]). Single-line layouts use one row.`,
      line: findKeyLine(ctx.source, ["layout"]),
    });
    return null;
  }
  if (Array.isArray(row)) {
    return { segments: validateLayoutSegments(ctx, `layout[${r}]`, row) };
  }
  if (isPlainObject(row)) {
    const allowed = new Set(["when", "segments"]);
    for (const key of Object.keys(row)) {
      if (!allowed.has(key)) {
        ctx.issues.push({
          path: `layout[${r}].${key}`,
          message: `Unknown layout-row key "${key}". Expected one of: ${[...allowed].join(", ")}`,
          line: findKeyLine(ctx.source, ["layout"]),
        });
      }
    }
    if (!Array.isArray(row.segments)) {
      ctx.issues.push({
        path: `layout[${r}].segments`,
        message: `a layout row object must have a "segments" array of segment names, got ${describeType(row.segments)}`,
        line: findKeyLine(ctx.source, ["layout"]),
      });
      return null;
    }
    const segments = validateLayoutSegments(
      ctx,
      `layout[${r}].segments`,
      row.segments,
    );
    // Preserve the predicate faithfully — an explicit `when: ""` is a present
    // (if degenerate) predicate, distinct from an absent one; only `undefined`
    // (absent or non-string) means "no predicate". A truthiness check would
    // silently drop "".
    const when = optionalStringField(ctx, `layout[${r}]`, row, "when");
    return when !== undefined ? { when, segments } : { segments };
  }
  ctx.issues.push({
    path: `layout[${r}]`,
    message: `a layout row must be an array of segment names or a { when?, segments } object, got ${describeType(row)}`,
    line: findKeyLine(ctx.source, ["layout"]),
  });
  return null;
}

// [LAW:locality-or-seam] `pathPrefix` is the caller's actual row path, so the
// error path reflects the form the user wrote: `layout[r][c]` for a bare-array
// row, `layout[r].segments[c]` for an object row. The discriminator lives in
// validateLayoutRow (which knows which form it received); threading the prefix
// keeps the error honest about the input rather than asserting a `.segments`
// key a sugar-form config never wrote.
function validateLayoutSegments(
  ctx: ValidateCtx,
  pathPrefix: string,
  row: readonly unknown[],
): readonly string[] {
  const rowOut: string[] = [];
  for (let c = 0; c < row.length; c++) {
    const entry = row[c];
    if (typeof entry !== "string") {
      ctx.issues.push({
        path: `${pathPrefix}[${c}]`,
        message: `layout entries must be strings (segment names), got ${describeType(entry)}`,
        line: findKeyLine(ctx.source, ["layout"]),
      });
      continue;
    }
    rowOut.push(entry);
  }
  return rowOut;
}

// ─── Root node grammar ───────────────────────────────────────────────────────

// [LAW:locality-or-seam] The boundary that turns the raw `root` grammar into a
// validated LayoutNode tree. STRUCTURAL only — whether a segment name resolves
// and whether a `when` ref exists are cross-ref concerns (validateCrossReferences
// runs on the MERGED config, so a node can name default-provided segments).
// Mirrors validateLayout's discipline: loud, no silent shimming.
//
// [LAW:dataflow-not-control-flow] The `kind` discriminator selects the arm; an
// unknown kind is rejected, never coerced. On a fundamental shape error the
// validator returns a degenerate node so traversal continues collecting issues
// — parseDslConfig throws once any issue exists, so the fallback never renders.
const EMPTY_VERTICAL_NODE: LayoutNode = {
  kind: "container",
  direction: "vertical",
  children: [],
};

function validateRoot(
  ctx: ValidateCtx,
  path: string,
  raw: unknown,
): LayoutNode {
  if (!isPlainObject(raw)) {
    ctx.issues.push({
      path,
      message: `a layout node must be an object with "kind" of "cells", "inline", or "container", got ${describeType(raw)}`,
      line: findKeyLine(ctx.source, ["root"]),
    });
    return EMPTY_VERTICAL_NODE;
  }
  if (raw.kind === "cells") return validateCellsNode(ctx, path, raw);
  if (raw.kind === "inline") return validateInlineNode(ctx, path, raw);
  if (raw.kind === "container") return validateContainerNode(ctx, path, raw);
  ctx.issues.push({
    path: `${path}.kind`,
    message: `a layout node "kind" must be "cells", "inline", or "container", got ${JSON.stringify(raw.kind)}`,
    line: findKeyLine(ctx.source, ["root"]),
  });
  return EMPTY_VERTICAL_NODE;
}

function rejectUnknownNodeKeys(
  ctx: ValidateCtx,
  path: string,
  raw: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): void {
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      ctx.issues.push({
        path: `${path}.${key}`,
        message: `Unknown layout-node key "${key}". Expected one of: ${[...allowed].join(", ")}`,
        line: findKeyLine(ctx.source, ["root"]),
      });
    }
  }
}

function validateCellsNode(
  ctx: ValidateCtx,
  path: string,
  raw: Record<string, unknown>,
): LayoutNode {
  rejectUnknownNodeKeys(ctx, path, raw, new Set(["kind", "segments", "when"]));
  const when = optionalStringField(ctx, path, raw, "when");
  if (!Array.isArray(raw.segments)) {
    ctx.issues.push({
      path: `${path}.segments`,
      message: `a cells node must have a "segments" array of segment names, got ${describeType(raw.segments)}`,
      line: findKeyLine(ctx.source, ["root"]),
    });
    return when !== undefined
      ? { kind: "cells", segments: [], when }
      : { kind: "cells", segments: [] };
  }
  const segments = validateLayoutSegments(
    ctx,
    `${path}.segments`,
    raw.segments,
  );
  return when !== undefined
    ? { kind: "cells", segments, when }
    : { kind: "cells", segments };
}

// [LAW:locality-or-seam] STRUCTURAL validation of an inline leaf: it carries a
// `cells` array (each cell `{ text, onClick? }`) and optional color (bg/fg/
// palette). Whether the onClick key is a writable SessionState key is a derived-
// validator concern (deriveNodeValidators), not a cross-ref one — the gate IS
// the rendered click, derived from this same structure.
function validateInlineNode(
  ctx: ValidateCtx,
  path: string,
  raw: Record<string, unknown>,
): LayoutNode {
  rejectUnknownNodeKeys(
    ctx,
    path,
    raw,
    new Set(["kind", "cells", "bg", "fg", "palette", "when"]),
  );
  const when = optionalStringField(ctx, path, raw, "when");
  const bg = optionalStringField(ctx, path, raw, "bg");
  const fg = optionalStringField(ctx, path, raw, "fg");
  const palette = validatePaletteName(ctx, path, raw);

  // [LAW:dataflow-not-control-flow] Strip the undefined optionals so the emitted
  // node carries only the keys the author wrote — the same exact-presence shape
  // every other node validator returns (no `bg: undefined` noise downstream).
  const withOptionals = (cells: readonly InlineCell[]): InlineNode => ({
    kind: "inline",
    cells,
    ...(bg !== undefined && { bg }),
    ...(fg !== undefined && { fg }),
    ...(palette !== undefined && { palette }),
    ...(when !== undefined && { when }),
  });

  if (!Array.isArray(raw.cells)) {
    ctx.issues.push({
      path: `${path}.cells`,
      message: `an inline node must have a "cells" array of { text, onClick? } cells, got ${describeType(raw.cells)}`,
      line: findKeyLine(ctx.source, ["root"]),
    });
    return withOptionals([]);
  }
  const cells = raw.cells.map((cell, i) =>
    validateInlineCell(ctx, `${path}.cells[${i}]`, cell),
  );
  return withOptionals(cells);
}

function validateInlineCell(
  ctx: ValidateCtx,
  path: string,
  raw: unknown,
): InlineCell {
  if (!isPlainObject(raw)) {
    ctx.issues.push({
      path,
      message: `an inline cell must be an object with a "text" string and optional "onClick", got ${describeType(raw)}`,
      line: findKeyLine(ctx.source, ["root"]),
    });
    return { text: "" };
  }
  rejectUnknownNodeKeys(ctx, path, raw, new Set(["text", "onClick"]));
  const text = typeof raw.text === "string" ? raw.text : "";
  if (typeof raw.text !== "string") {
    ctx.issues.push({
      path: `${path}.text`,
      message: `an inline cell "text" must be a string, got ${describeType(raw.text)}`,
      line: findKeyLine(ctx.source, ["root"]),
    });
  }
  if (raw.onClick === undefined) return { text };
  const onClick = validateClickWrite(ctx, `${path}.onClick`, raw.onClick);
  return onClick !== undefined ? { text, onClick } : { text };
}

// [LAW:types-are-the-program] A `ClickWrite` is exactly `{ set, to }` — both
// LITERAL strings (the literalness is load-bearing: it is what makes the gate
// derivable). Reject anything else loudly rather than coercing.
function validateClickWrite(
  ctx: ValidateCtx,
  path: string,
  raw: unknown,
): ClickWrite | undefined {
  if (!isPlainObject(raw)) {
    ctx.issues.push({
      path,
      message: `an onClick must be an object { set, to }, got ${describeType(raw)}`,
      line: findKeyLine(ctx.source, ["root"]),
    });
    return undefined;
  }
  rejectUnknownNodeKeys(ctx, path, raw, new Set(["set", "to"]));
  const set = raw.set;
  const to = raw.to;
  if (typeof set !== "string" || set.length === 0) {
    ctx.issues.push({
      path: `${path}.set`,
      message: `an onClick "set" must be a non-empty SessionState key string, got ${describeValue(set)}`,
      line: findKeyLine(ctx.source, ["root"]),
    });
    return undefined;
  }
  if (typeof to !== "string") {
    ctx.issues.push({
      path: `${path}.to`,
      message: `an onClick "to" must be a string value, got ${describeValue(to)}`,
      line: findKeyLine(ctx.source, ["root"]),
    });
    return undefined;
  }
  return { set, to };
}

function validateContainerNode(
  ctx: ValidateCtx,
  path: string,
  raw: Record<string, unknown>,
): LayoutNode {
  rejectUnknownNodeKeys(
    ctx,
    path,
    raw,
    new Set(["kind", "direction", "children", "when"]),
  );
  const when = optionalStringField(ctx, path, raw, "when");

  // [LAW:one-source-of-truth] Valid directions come from the DIRECTIONS list —
  // the same set the renderer projects. Today only `vertical` is implemented;
  // an unimplemented direction is a hard error, not a silent downgrade.
  const direction = raw.direction;
  const directionOk =
    typeof direction === "string" &&
    (DIRECTIONS as readonly string[]).includes(direction);
  if (!directionOk) {
    ctx.issues.push({
      path: `${path}.direction`,
      message: `a container "direction" must be one of: ${DIRECTIONS.join(", ")} (got ${JSON.stringify(direction)})`,
      line: findKeyLine(ctx.source, ["root"]),
    });
  }
  const dir: Direction = directionOk ? (direction as Direction) : "vertical";

  let children: LayoutNode[] = [];
  if (!Array.isArray(raw.children)) {
    ctx.issues.push({
      path: `${path}.children`,
      message: `a container must have a "children" array of layout nodes, got ${describeType(raw.children)}`,
      line: findKeyLine(ctx.source, ["root"]),
    });
  } else {
    children = raw.children.map((child, i) =>
      validateRoot(ctx, `${path}.children[${i}]`, child),
    );
  }

  return when !== undefined
    ? { kind: "container", direction: dir, children, when }
    : { kind: "container", direction: dir, children };
}

// ─── Widgets ─────────────────────────────────────────────────────────────────

// [LAW:locality-or-seam] Structural validation of the `widgets` block: each
// widget is discriminated by `kind`, each button item by presence of
// `optionsFrom`, each action by which of set/copy/open is present. Whether a
// `{{ widget "name" }}` reference resolves is a cross-ref concern
// (validateCrossReferences), which runs on the MERGED config so a segment can
// reference a default-provided widget.
function validateWidgets(
  ctx: ValidateCtx,
  raw: unknown,
): Record<string, WidgetDecl> {
  if (raw === undefined) return {};
  if (!isPlainObject(raw)) {
    ctx.issues.push({
      path: "widgets",
      message: `widgets must be an object, got ${describeType(raw)}`,
      line: findKeyLine(ctx.source, ["widgets"]),
    });
    return {};
  }
  // [LAW:types-are-the-program] Null-prototype record for user-keyed data, so a
  // widget named "__proto__"/"constructor" becomes an ordinary own property
  // instead of mutating the prototype chain. Matches the Object.create(null)
  // compiled map in dsl/render.ts and the Map dispatch in the click-verb
  // registries — untrusted keys are plain data by construction.
  const out: Record<string, WidgetDecl> = Object.create(null) as Record<
    string,
    WidgetDecl
  >;
  for (const [name, decl] of Object.entries(raw)) {
    const parsed = validateWidget(ctx, `widgets.${name}`, decl);
    if (parsed !== null) out[name] = parsed;
  }
  return out;
}

function validateWidget(
  ctx: ValidateCtx,
  path: string,
  raw: unknown,
): WidgetDecl | null {
  if (!isPlainObject(raw)) {
    ctx.issues.push({
      path,
      message: `${path} must be an object, got ${describeType(raw)}`,
      line: findKeyLine(ctx.source, path.split(".")),
    });
    return null;
  }
  const kind = raw.kind;
  if (
    typeof kind !== "string" ||
    !(WIDGET_KINDS as readonly string[]).includes(kind)
  ) {
    ctx.issues.push({
      path: `${path}.kind`,
      message: `widget kind must be one of: ${WIDGET_KINDS.join(", ")}, got ${describeValue(kind)}`,
      line: findKeyLine(ctx.source, [...path.split("."), "kind"]),
    });
    return null;
  }
  // [LAW:types-are-the-program] A `stepper` has no author items — its cells are
  // render-derived from (value, bounds, step). It is the one widget arm whose
  // shape diverges from the shared items walk, so it validates on its own path
  // before the items requirement that buttons/menu share.
  if (kind === "stepper") {
    return validateStepperWidget(ctx, path, raw);
  }
  // [LAW:types-are-the-program] A `tree` is the recursive (leaf | submenu) item
  // structure — it does NOT share the flat ButtonItem items walk buttons/menu
  // use, so (like stepper) it validates on its own path.
  if (kind === "tree") {
    return validateTreeWidget(ctx, path, raw);
  }
  // [LAW:one-type-per-behavior] A `menu` is a `buttons` plus the `state` key it
  // paginates against — same `items` shape, one extra field. The allowed key
  // set is the only per-kind difference; the items walk is shared.
  const isMenu = kind === "menu";
  const allowed = isMenu
    ? new Set(["kind", "items", "state"])
    : new Set(["kind", "items"]);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      ctx.issues.push({
        path: `${path}.${key}`,
        message: `Unknown widget key "${key}". Expected one of: ${[...allowed].join(", ")}`,
        line: findKeyLine(ctx.source, [...path.split("."), key]),
      });
    }
  }
  if (!Array.isArray(raw.items)) {
    ctx.issues.push({
      path: `${path}.items`,
      message: `widget items must be an array, got ${describeType(raw.items)}`,
      line: findKeyLine(ctx.source, [...path.split("."), "items"]),
    });
    return null;
  }
  const items: ButtonItem[] = [];
  for (let i = 0; i < raw.items.length; i++) {
    const item = validateButtonItem(ctx, `${path}.items[${i}]`, raw.items[i]);
    if (item !== null) items.push(item);
  }
  if (isMenu) {
    // [LAW:types-are-the-program] A menu without its page key is not a menu —
    // `state` is the one value carrying open/closed/which-page. The int
    // validator for it is DERIVED at load (see deriveWidgetValidators) so the
    // wire accepts the menu's ←/→/close writes.
    const state = validateWidgetStateKey(ctx, path, raw, "menu");
    if (state === null) return null;
    return { kind: "menu", state, items };
  }
  return { kind: "buttons", items };
}

// [LAW:single-enforcer] A widget's `state` key (a menu's page, a stepper's
// value) is a set-state URL path segment, so it must be a non-empty, slash-free
// key — the SAME shape validateAction requires of a button's `set` key, since
// the menu's ←/→/close and the stepper's ◀/▶ are render-derived set-state writes.
// One check for both arms means a slash-bearing key is rejected at load with a
// clear message, not deferred to a throw when validators register. Returns the
// validated key, or null (with a recorded issue) when absent/empty/slash-bearing.
function validateWidgetStateKey(
  ctx: ValidateCtx,
  path: string,
  raw: Record<string, unknown>,
  kind: "menu" | "stepper" | "tree",
): string | null {
  const state = optionalStringField(ctx, path, raw, "state");
  if (!state) {
    ctx.issues.push({
      path: `${path}.state`,
      message: `a ${kind} widget must declare a non-empty "state" (the SessionState key it reads and writes)`,
      line: findKeyLine(ctx.source, [...path.split("."), "state"]),
    });
    return null;
  }
  if (state.includes("/")) {
    ctx.issues.push({
      path: `${path}.state`,
      message: `state key "${state}" contains "/" — the set-state wire splits on "/", so it cannot be addressed`,
      line: findKeyLine(ctx.source, [...path.split("."), "state"]),
    });
    return null;
  }
  return state;
}

// [LAW:types-are-the-program] A stepper is fully described by its integer key
// and an integer domain (min < max) plus a positive integer step. Validate that
// domain at the boundary so the renderer and the range validator both receive a
// well-formed [min,max]/step and never re-check. `step` defaults to 1 — the
// obvious increment — so the common stepper is `{ state, min, max }`.
function validateStepperWidget(
  ctx: ValidateCtx,
  path: string,
  raw: Record<string, unknown>,
): StepperWidget | null {
  const allowed = new Set(["kind", "state", "min", "max", "step"]);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      ctx.issues.push({
        path: `${path}.${key}`,
        message: `Unknown widget key "${key}". Expected one of: ${[...allowed].join(", ")}`,
        line: findKeyLine(ctx.source, [...path.split("."), key]),
      });
    }
  }

  const state = validateWidgetStateKey(ctx, path, raw, "stepper");

  const intField = (field: string): number | null => {
    const v = raw[field];
    if (typeof v !== "number" || !Number.isInteger(v)) {
      ctx.issues.push({
        path: `${path}.${field}`,
        message: `stepper ${field} must be an integer, got ${describeValue(v)}`,
        line: findKeyLine(ctx.source, [...path.split("."), field]),
      });
      return null;
    }
    return v;
  };
  const min = intField("min");
  const max = intField("max");
  // [LAW:no-mode-explosion] step is optional with one canonical default (1), not
  // a required knob — the common stepper declares only its bounds.
  const step = raw.step === undefined ? 1 : intField("step");

  if (state === null || min === null || max === null || step === null) {
    return null;
  }
  if (min >= max) {
    ctx.issues.push({
      path: `${path}.min`,
      message: `stepper min (${min}) must be less than max (${max})`,
      line: findKeyLine(ctx.source, [...path.split("."), "min"]),
    });
    return null;
  }
  if (step < 1) {
    ctx.issues.push({
      path: `${path}.step`,
      message: `stepper step (${step}) must be a positive integer`,
      line: findKeyLine(ctx.source, [...path.split("."), "step"]),
    });
    return null;
  }
  return { kind: "stepper", state, min, max, step };
}

// [LAW:types-are-the-program] A `tree` carries its open-path `state` key and the
// recursive item structure. Unlike buttons/menu, its items are MenuTreeItems
// (leaf | submenu), so it owns its own recursive item walk; the open-path
// allow-list validator is derived later from this structure (deriveWidgetValidators).
function validateTreeWidget(
  ctx: ValidateCtx,
  path: string,
  raw: Record<string, unknown>,
): TreeWidget | null {
  const allowed = new Set(["kind", "state", "items"]);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      ctx.issues.push({
        path: `${path}.${key}`,
        message: `Unknown widget key "${key}". Expected one of: ${[...allowed].join(", ")}`,
        line: findKeyLine(ctx.source, [...path.split("."), key]),
      });
    }
  }
  const state = validateWidgetStateKey(ctx, path, raw, "tree");
  if (!Array.isArray(raw.items)) {
    ctx.issues.push({
      path: `${path}.items`,
      message: `widget items must be an array, got ${describeType(raw.items)}`,
      line: findKeyLine(ctx.source, [...path.split("."), "items"]),
    });
    return null;
  }
  const items: MenuTreeItem[] = [];
  for (let i = 0; i < raw.items.length; i++) {
    const item = validateTreeItem(ctx, `${path}.items[${i}]`, raw.items[i]);
    if (item !== null) items.push(item);
  }
  if (state === null) return null;
  return { kind: "tree", state, items };
}

// [LAW:types-are-the-program] A tree item is discriminated by presence of
// `items`: a SUBMENU (children + a chevron, its open/close toggle render-derived
// so NO onClick) or a LEAF (the existing ButtonItem, reused verbatim). The
// discriminator is the same "which key is present" the runtime's isSubmenuItem
// reads — the loader proves it so the runtime never re-checks.
function validateTreeItem(
  ctx: ValidateCtx,
  path: string,
  raw: unknown,
): MenuTreeItem | null {
  if (!isPlainObject(raw)) {
    ctx.issues.push({
      path,
      message: `${path} must be an object, got ${describeType(raw)}`,
      line: findKeyLine(ctx.source, path.split(".")),
    });
    return null;
  }
  // A LEAF reuses the full ButtonItem validation (incl. optionsFrom pickers).
  if (!("items" in raw)) {
    return validateButtonItem(ctx, path, raw);
  }
  // A SUBMENU: glyph/label (its identity beside the chevron) + recursive items.
  const allowed = new Set(["glyph", "label", "items"]);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      ctx.issues.push({
        path: `${path}.${key}`,
        message: `Unknown submenu key "${key}". Expected one of: ${[...allowed].join(", ")}`,
        line: findKeyLine(ctx.source, [...path.split("."), key]),
      });
    }
  }
  const glyph = optionalStringField(ctx, path, raw, "glyph");
  const label = optionalStringField(ctx, path, raw, "label");
  // [LAW:no-silent-fallbacks] As with a fixed button, an empty glyph/label
  // renders as no identifying text (only the chevron) — so a submenu needs
  // NON-EMPTY clickable identity; "" is treated as absent. Computed ONCE: the
  // diagnostic and the build-vs-reject gate read the same boolean.
  const hasIdentity = Boolean(glyph || label);
  if (!hasIdentity) {
    ctx.issues.push({
      path,
      message: `a submenu must declare a non-empty "glyph" or "label" (its identity beside the chevron)`,
      line: findKeyLine(ctx.source, path.split(".")),
    });
  }
  if (!Array.isArray(raw.items)) {
    ctx.issues.push({
      path: `${path}.items`,
      message: `a submenu's items must be an array, got ${describeType(raw.items)}`,
      line: findKeyLine(ctx.source, [...path.split("."), "items"]),
    });
    return null;
  }
  const items = raw.items
    .map((it, i) => validateTreeItem(ctx, `${path}.items[${i}]`, it))
    .filter((it): it is MenuTreeItem => it !== null);
  return hasIdentity
    ? { ...(glyph ? { glyph } : {}), ...(label ? { label } : {}), items }
    : null;
}

function validateButtonItem(
  ctx: ValidateCtx,
  path: string,
  raw: unknown,
): ButtonItem | null {
  if (!isPlainObject(raw)) {
    ctx.issues.push({
      path,
      message: `${path} must be an object, got ${describeType(raw)}`,
      line: findKeyLine(ctx.source, path.split(".")),
    });
    return null;
  }
  // [LAW:types-are-the-program] presence of `optionsFrom` is the discriminator.
  const isOptions = "optionsFrom" in raw;
  const allowed = isOptions
    ? new Set(["optionsFrom", "glyph", "onClick"])
    : new Set(["glyph", "label", "onClick"]);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      ctx.issues.push({
        path: `${path}.${key}`,
        message: `Unknown button-item key "${key}". Expected one of: ${[...allowed].join(", ")}`,
        line: findKeyLine(ctx.source, [...path.split("."), key]),
      });
    }
  }

  const onClick = validateOnClick(ctx, path, raw, isOptions);
  if (onClick === null) return null;
  const glyph = optionalStringField(ctx, path, raw, "glyph");

  if (isOptions) {
    const src = raw.optionsFrom;
    if (
      typeof src !== "string" ||
      !(OPTION_SOURCES as readonly string[]).includes(src)
    ) {
      ctx.issues.push({
        path: `${path}.optionsFrom`,
        message: `optionsFrom must be one of: ${OPTION_SOURCES.join(", ")}, got ${describeValue(src)}`,
        line: findKeyLine(ctx.source, [...path.split("."), "optionsFrom"]),
      });
      return null;
    }
    return {
      optionsFrom: src as OptionSource,
      ...(glyph ? { glyph } : {}),
      onClick,
    };
  }
  const label = optionalStringField(ctx, path, raw, "label");
  // [LAW:no-silent-fallbacks] An empty-string glyph/label is "present" to the
  // type but renders as no clickable text (joinDisplay filters falsy parts), so
  // treat "" exactly as absent — a fixed button needs NON-EMPTY clickable text.
  if (!glyph && !label) {
    ctx.issues.push({
      path,
      message: `a fixed button must declare a non-empty "glyph" or "label" (its clickable text)`,
      line: findKeyLine(ctx.source, path.split(".")),
    });
    return null;
  }
  return {
    ...(glyph ? { glyph } : {}),
    ...(label ? { label } : {}),
    onClick,
  };
}

// [LAW:dataflow-not-control-flow] `onClick` accepts a single action object or
// an array; both normalize to the one canonical runtime shape (Action[]).
// `isOptions` carries the set-action `to` pairing rule: an option-bound button
// gets each option's value, so its set actions must NOT carry `to`; a literal
// button's set actions MUST carry `to`.
function validateOnClick(
  ctx: ValidateCtx,
  path: string,
  raw: Record<string, unknown>,
  isOptions: boolean,
): readonly Action[] | null {
  const rawClick = raw.onClick;
  if (rawClick === undefined) {
    ctx.issues.push({
      path: `${path}.onClick`,
      message: `${path}.onClick is required (an action or array of actions)`,
      line: findKeyLine(ctx.source, [...path.split("."), "onClick"]),
    });
    return null;
  }
  const rawActions = Array.isArray(rawClick) ? rawClick : [rawClick];
  if (rawActions.length === 0) {
    ctx.issues.push({
      path: `${path}.onClick`,
      message: `${path}.onClick must declare at least one action`,
      line: findKeyLine(ctx.source, [...path.split("."), "onClick"]),
    });
    return null;
  }
  const actions: Action[] = [];
  for (let i = 0; i < rawActions.length; i++) {
    const a = validateAction(
      ctx,
      `${path}.onClick[${i}]`,
      rawActions[i],
      isOptions,
    );
    if (a !== null) actions.push(a);
  }
  if (actions.length !== rawActions.length) return null;
  // [LAW:dataflow-not-control-flow] A click is an ordered list of effects on one
  // dispatch URL (the `dispatch` wire). Heterogeneous and repeated actions are
  // first-class: every `set` batches into one atomic set-state effect, each
  // `copy`/`open` is its own effect, all run on one click. There is no
  // homogeneity rule — the only constraint left is the optionsFrom binding below.
  const sets = actions.filter((a) => "set" in a).length;
  // [LAW:types-are-the-program] An optionsFrom button binds each option's value
  // into a `set` action — that binding IS the picker. A button with NO set
  // action has nowhere to bind the option, so the option list would render N
  // identical clickable cells: meaningless. Require at least one `set`; copy/open
  // alongside it are fine (they just ignore the option).
  if (isOptions && sets === 0) {
    ctx.issues.push({
      path: `${path}.onClick`,
      message: `an optionsFrom button's onClick must include a "set" action — each option binds its value into the set; without one the option list has nowhere to bind`,
      line: findKeyLine(ctx.source, [...path.split("."), "onClick"]),
    });
    return null;
  }
  return actions;
}

function validateAction(
  ctx: ValidateCtx,
  path: string,
  raw: unknown,
  isOptions: boolean,
): Action | null {
  if (!isPlainObject(raw)) {
    ctx.issues.push({
      path,
      message: `${path} must be an action object, got ${describeType(raw)}`,
      line: findKeyLine(ctx.source, path.split(".")),
    });
    return null;
  }
  const present = (ACTION_KEYS as readonly string[]).filter((k) => k in raw);
  if (present.length !== 1) {
    ctx.issues.push({
      path,
      message: `action must declare exactly one of: ${ACTION_KEYS.join(", ")}${
        present.length > 1 ? ` (found: ${present.join(", ")})` : ""
      }`,
      line: findKeyLine(ctx.source, path.split(".")),
    });
    return null;
  }
  const key = present[0] as ActionKey;
  // [LAW:no-silent-fallbacks] Reject unknown keys on the action object, matching
  // the widget/button validators — so a typo like `{ set: "theme", too: "nord" }`
  // surfaces at load, not as a silently-ignored field. The allowed companions
  // depend on the discriminator: only `set` admits `to`.
  const allowedActionKeys = key === "set" ? ["set", "to"] : [key];
  for (const k of Object.keys(raw)) {
    if (!allowedActionKeys.includes(k)) {
      ctx.issues.push({
        path: `${path}.${k}`,
        message: `Unknown key "${k}" on a ${key} action. Expected one of: ${allowedActionKeys.join(", ")}`,
        line: findKeyLine(ctx.source, [...path.split("."), k]),
      });
    }
  }
  switch (key) {
    case "set": {
      const stateKey = requireString(ctx, path, raw, "set");
      if (stateKey === null) return null;
      if (stateKey === "") {
        // [LAW:no-silent-fallbacks] An empty key composes a broken set-state URL
        // (the daemon rejects "empty key at pair N" at click); reject at load,
        // matching the non-empty check on `to`.
        ctx.issues.push({
          path: `${path}.set`,
          message: `set key must be non-empty (the SessionState key to write)`,
          line: findKeyLine(ctx.source, [...path.split("."), "set"]),
        });
        return null;
      }
      if (stateKey.includes("/")) {
        // [LAW:types-are-the-program] The set-state wire splits on "/"; a
        // slash-bearing key is structurally undeliverable. Reject at load.
        ctx.issues.push({
          path: `${path}.set`,
          message: `set key "${stateKey}" contains "/" — the set-state wire splits on "/", so it cannot be addressed`,
          line: findKeyLine(ctx.source, [...path.split("."), "set"]),
        });
        return null;
      }
      const hasTo = "to" in raw;
      // [LAW:types-are-the-program] The to/optionsFrom pairing: an option-bound
      // button supplies the value from the option (no `to`); a literal button
      // must carry an explicit `to`. Catch the mismatch at load.
      if (isOptions && hasTo) {
        ctx.issues.push({
          path: `${path}.to`,
          message: `an optionsFrom button supplies the set value from each option — remove "to"`,
          line: findKeyLine(ctx.source, [...path.split("."), "to"]),
        });
        return null;
      }
      if (!isOptions && !hasTo) {
        ctx.issues.push({
          path: `${path}.to`,
          message: `set action on a fixed button requires "to" (the value to write)`,
          line: findKeyLine(ctx.source, [...path.split("."), "to"]),
        });
        return null;
      }
      if (!hasTo) return { set: stateKey };
      const to = requireString(ctx, path, raw, "to");
      if (to === null) return null;
      if (to === "") {
        // [LAW:no-silent-fallbacks] The set-state validators reject empty input
        // (an empty value on the wire is structurally ambiguous), so an empty
        // `to` is undeliverable. Reject at load, not at first click.
        ctx.issues.push({
          path: `${path}.to`,
          message: `set value must be non-empty — an empty value cannot be delivered on the set-state wire`,
          line: findKeyLine(ctx.source, [...path.split("."), "to"]),
        });
        return null;
      }
      if (to.includes("/")) {
        ctx.issues.push({
          path: `${path}.to`,
          message: `set value "${to}" contains "/" — the set-state wire splits values on "/", so it cannot be delivered`,
          line: findKeyLine(ctx.source, [...path.split("."), "to"]),
        });
        return null;
      }
      return { set: stateKey, to };
    }
    case "copy": {
      const text = requireString(ctx, path, raw, "copy");
      return text === null ? null : { copy: text };
    }
    case "open": {
      const target = requireString(ctx, path, raw, "open");
      return target === null ? null : { open: target };
    }
  }
}

// [LAW:dataflow-not-control-flow] Extract every `widget "name"` call from a
// template, for the load-time existence check. Walk each `{{ }}` block as
// alternating code / string-literal spans (the engine's job is the real parse;
// this is the same best-effort heuristic shape as extractTemplateRefs). A
// `widget` keyword lives in a CODE span and its name is the very next string
// literal; a `widget "x"` sitting INSIDE a larger string literal is part of one
// string span, never a code span, so it cannot be misread as a call.
const WIDGET_ARG_RE = /\bwidget\s+$/;
export function extractWidgetRefs(template: string): Set<string> {
  const refs = new Set<string>();
  TEMPLATE_BLOCK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TEMPLATE_BLOCK_RE.exec(template)) !== null) {
    const block = m[1]!;
    let cursor = 0;
    let s: RegExpExecArray | null;
    STRING_LITERAL_RE.lastIndex = 0;
    while ((s = STRING_LITERAL_RE.exec(block)) !== null) {
      // The code span immediately before this string literal; if it ends with
      // `widget` + whitespace, this literal is that call's name argument.
      if (WIDGET_ARG_RE.test(block.slice(cursor, s.index))) {
        refs.add(s[0].slice(1, -1));
      }
      cursor = s.index + s[0].length;
    }
  }
  return refs;
}

// ─── Cross-references ────────────────────────────────────────────────────────

function validateCrossReferences(ctx: ValidateCtx, cfg: DslConfig): void {
  // Full set for depends_on validation (all names, bare + namespaced). depends_on
  // takes explicit fully-qualified names, so cross-segment visibility is intentional.
  const allVarNames = new Set<string>(Object.keys(cfg.variables));
  for (const [segName, seg] of Object.entries(cfg.segments)) {
    if (seg.vars) {
      for (const v of Object.keys(seg.vars)) allVarNames.add(v);
      for (const v of Object.keys(seg.vars)) allVarNames.add(`${segName}.${v}`);
    }
  }

  // [LAW:single-enforcer] ONE pre-order walk over the canonical node tree owns
  // every layout cross-ref: each cells node's segment names must resolve to a
  // declared segment, and any node's `when` predicate (a template like any
  // other) must reference only existing variables. Cross-ref runs on the MERGED
  // config so a node can name default-provided segments without re-declaring
  // them. It traverses the canonical tree — the raw `layout`-vs-`root` authoring
  // form is already collapsed and unrecoverable post-merge — so the path
  // describes the tree and `line` points at whichever layout key the user wrote.
  // [LAW:one-source-of-truth] Which top-level layout surface the user authored
  // is read from the PARSED structure, not a text probe: a nested key named
  // `root` (a variable, a segment) — or `layout` (a `time` var's `layout`
  // field) — would fool a raw `findKeyLine` search and misclassify the config.
  // Validation is cold-path, so reading the source's top-level keys is exact.
  // The reported path/message then point at the surface the user wrote.
  const layoutKey = authoredLayoutKey(ctx.source);
  const layoutLine = findKeyLine(ctx.source, [layoutKey]);
  for (const node of walkNodes(cfg.root)) {
    // [LAW:locality-or-seam] A node's `when` reads the global scope (bare
    // globals + namespaced segment vars) — the same existence-check shape as a
    // segment template, surfaced at load time.
    if (node.when !== undefined) {
      checkTemplateRefs(
        ctx,
        `${layoutKey}.when`,
        node.when,
        allVarNames,
        layoutLine,
      );
    }
    // [LAW:single-enforcer] An inline leaf's bg/fg flow through the SAME
    // resolveSegmentColors path a segment's bg/fg do, so they are template
    // surfaces and get the SAME ref existence-check — a typo'd `{{ .var }}` in an
    // inline color surfaces at load, never as a silent render-time miss.
    if (node.kind === "inline") {
      for (const [field, src] of [
        ["bg", node.bg],
        ["fg", node.fg],
      ] as const) {
        if (src !== undefined) {
          checkTemplateRefs(
            ctx,
            `${layoutKey}.${field}`,
            src,
            allVarNames,
            layoutLine,
          );
        }
      }
    }
    if (node.kind !== "cells") continue;
    for (const entry of node.segments) {
      if (!Object.prototype.hasOwnProperty.call(cfg.segments, entry)) {
        ctx.issues.push({
          path: layoutKey,
          message: `${layoutKey} entry "${entry}" does not match any declared segment`,
          line: layoutLine,
        });
      }
    }
  }

  // For each variable's template/cache.key, every dotted ref must exist
  // (full path OR a prefix that matches an existing variable's namespace).
  for (const [name, v] of Object.entries(cfg.variables)) {
    checkVarRefs(ctx, `variables.${name}`, v, allVarNames);
  }

  for (const [segName, seg] of Object.entries(cfg.segments)) {
    // [LAW:single-enforcer] Per-segment scope: global vars + this segment's
    // locals (bare + namespaced) + other segments' vars (namespaced ONLY).
    // Matches runtime scope-proxy rules: own locals visible by bare name;
    // cross-segment refs require the qualified segName.varName form.
    const segScope = new Set<string>(Object.keys(cfg.variables));
    for (const [otherSeg, otherSegDecl] of Object.entries(cfg.segments)) {
      if (!otherSegDecl.vars) continue;
      for (const vName of Object.keys(otherSegDecl.vars)) {
        if (otherSeg === segName) segScope.add(vName); // own: bare form
        segScope.add(`${otherSeg}.${vName}`); // all: namespaced form
      }
    }

    if (seg.vars) {
      for (const [vName, vDecl] of Object.entries(seg.vars)) {
        checkVarRefs(ctx, `segments.${segName}.vars.${vName}`, vDecl, segScope);
      }
    }
    // [LAW:locality-or-seam] Variable refs AND `{{ widget "name" }}` refs are
    // checked across EVERY template-bearing field, not just `template` — bg/fg/
    // when are templates too, so an unknown ref in them is a load error, not a
    // render-time surprise. Same existence-check shape as layout→segments; runs
    // on the merged config so a segment can reference a default widget.
    for (const field of ["template", "bg", "fg", "when"] as const) {
      const tpl = seg[field];
      if (typeof tpl !== "string") continue;
      checkTemplateRefs(ctx, `segments.${segName}.${field}`, tpl, segScope);
      for (const wref of extractWidgetRefs(tpl)) {
        if (!Object.prototype.hasOwnProperty.call(cfg.widgets, wref)) {
          ctx.issues.push({
            path: `segments.${segName}.${field}`,
            message: `${field} references unknown widget "${wref}"`,
            line: findKeyLine(ctx.source, ["segments", segName, field]),
          });
        }
      }
    }
  }

  // depends_on lists must point at declared variables.
  for (const [name, v] of Object.entries(cfg.variables)) {
    checkDependsOn(ctx, `variables.${name}`, v, allVarNames);
  }
  for (const [segName, seg] of Object.entries(cfg.segments)) {
    if (!seg.vars) continue;
    for (const [vName, vDecl] of Object.entries(seg.vars)) {
      checkDependsOn(
        ctx,
        `segments.${segName}.vars.${vName}`,
        vDecl,
        allVarNames,
      );
    }
  }

  // [LAW:verifiable-goals] state-kind variables have an implicit dependency
  // on the canonical session-id input variable. Same shape as the
  // depends_on / template-ref existence checks above — surface a missing
  // anchor at load time so the user fixes the config from a config-file
  // error message, not from a render-time ReferenceError.
  //
  // [LAW:types-are-the-program] Check against `cfg.variables` directly, not
  // `allVarNames`: a segment-local declaration named "session.id" registers
  // at runtime as `<seg>.session.id` and does NOT satisfy declareState's
  // read of the global `session.id` box. The accept/reject table for this
  // predicate is "GLOBAL session.id declared" — `allVarNames` (which
  // includes bare segment-local names by construction, for depends_on
  // scope) is the wrong set.
  // [LAW:verifiable-goals] A widget `set` action composes a set-state click URL
  // whose first segment is `session.id` (read from the store at render). Without
  // a global session.id the URL is malformed and the daemon rejects the click
  // (requireSessionId is the single enforcer — it rejects empty/slash session
  // ids loudly, so there is no silent corruption; this surfaces the SAME
  // requirement at load instead of at first click). Same anchor + same shape as
  // the state-kind requirement above; OR them so either trigger fires it once.
  // [LAW:dataflow-not-control-flow] A menu ALWAYS emits set-state navigation URLs
  // (✕/←/→ on its page key) regardless of whether its items carry set actions —
  // so a menu needs session.id exactly like a set-action does. OR it in so a
  // menu with only copy/open items (no state vars, no set actions) can't load
  // while rendering broken navigation links with an empty session id.
  if (
    (hasStateKind(cfg) ||
      hasWidgetSetAction(cfg) ||
      hasMenuWidget(cfg) ||
      hasInlineOnClick(cfg)) &&
    !Object.prototype.hasOwnProperty.call(cfg.variables, "session.id")
  ) {
    ctx.issues.push({
      path: "variables.session.id",
      message: `state reads, widget set-actions, menu navigation, and inline-cell onClick all require a global "session.id" variable (segment-local declarations do not satisfy this — declareState/set-state both read the global box; conventionally { kind: "input", path: "session_id" })`,
      line: findKeyLine(ctx.source, ["variables"]),
    });
  }

  // [LAW:verifiable-goals] A `menu` widget paginates against the live terminal
  // width. renderDsl injects that width into the payload at the `term.cols` path
  // every render, so the ONLY declaration that receives it is an input variable
  // named TERM_COLS_VAR whose `path` is TERM_COLS_VAR. Validate the SHAPE, not
  // just presence: a term.cols declared as a different kind, or an input reading
  // a different path, never sees the injected width and the menu would silently
  // paginate against the stale default. The bundled default declares the correct
  // shape, so a production config that merges it always satisfies this; surface
  // a misdeclaration at load instead of as silent stale-width pagination.
  if (hasMenuWidget(cfg)) {
    const decl = Object.prototype.hasOwnProperty.call(
      cfg.variables,
      TERM_COLS_VAR,
    )
      ? cfg.variables[TERM_COLS_VAR]
      : undefined;
    if (
      decl === undefined ||
      decl.kind !== "input" ||
      decl.path !== TERM_COLS_VAR ||
      decl.type !== "number"
    ) {
      ctx.issues.push({
        path: `variables.${TERM_COLS_VAR}`,
        message: `a menu widget paginates against the terminal width, which renderDsl injects (as a number) at the "${TERM_COLS_VAR}" path — so it requires a global "${TERM_COLS_VAR}" variable declared as { kind: "input", path: "${TERM_COLS_VAR}", type: "number" } (the bundled default declares exactly this; a standalone config must too). A different kind, path, or non-number type never receives the injected width correctly.`,
        line: findKeyLine(ctx.source, ["variables"]),
      });
    }
  }

  // [LAW:verifiable-goals] A menu/stepper reads AND writes a SessionState `state`
  // key — a menu to choose its page (and a row `when` to gate the menu's row), a
  // stepper to display and step its value. Reading a SessionState key requires a
  // kind:"state" variable bound to it; without one the widget's writes land in
  // SessionState with nothing reading them back, so the click has no visible
  // effect. Require the backing state variable (global or segment-local, the same
  // key set registerDslConfig resolves for active-marking), surfaced at load
  // rather than as a silently-inert widget.
  const declaredStateKeys = new Set<string>();
  for (const v of Object.values(cfg.variables)) {
    if (v.kind === "state") declaredStateKeys.add(v.key);
  }
  for (const seg of Object.values(cfg.segments)) {
    if (!seg.vars) continue;
    for (const v of Object.values(seg.vars)) {
      if (v.kind === "state") declaredStateKeys.add(v.key);
    }
  }
  // [LAW:dataflow-not-control-flow] Project each widget to the key it reads back
  // (null for buttons), then keep the unbacked ones — the invalid set is a
  // filtered VALUE, not a per-kind branch in the loop.
  const unbacked = Object.entries(cfg.widgets)
    .map(([name, widget]) => ({
      name,
      kind: widget.kind,
      readsKey: widgetStateUse(widget).readsKey,
    }))
    .filter(
      (e): e is { name: string; kind: WidgetDecl["kind"]; readsKey: string } =>
        e.readsKey !== null && !declaredStateKeys.has(e.readsKey),
    );
  for (const { name, kind, readsKey } of unbacked) {
    ctx.issues.push({
      path: `widgets.${name}.state`,
      message: `${kind} "${name}" reads/writes the state key "${readsKey}", but no kind:"state" variable is bound to it — its writes would land in SessionState with nothing reading them back. Declare a variable like { kind: "state", key: "${readsKey}" }.`,
      line: findKeyLine(ctx.source, ["widgets", name, "state"]),
    });
  }
}

// [LAW:dataflow-not-control-flow] Any menu widget ⇒ the config reads TERM_COLS_VAR
// at render ⇒ it must be declared.
function hasMenuWidget(cfg: DslConfig): boolean {
  for (const widget of Object.values(cfg.widgets)) {
    if (widget.kind === "menu") return true;
  }
  return false;
}

// [LAW:dataflow-not-control-flow] An inline cell's `onClick` composes a set-state
// click URL whose first segment is the session id — exactly like a widget set
// action. So "any inline cell has onClick" is one more value OR'd into the
// session.id requirement, not a parallel check. A clickless inline leaf (pure
// generated text) writes nothing and needs no session id.
function hasInlineOnClick(cfg: DslConfig): boolean {
  for (const node of walkNodes(cfg.root)) {
    if (node.kind !== "inline") continue;
    if (node.cells.some((c) => c.onClick !== undefined)) return true;
  }
  return false;
}

function hasStateKind(cfg: DslConfig): boolean {
  for (const v of Object.values(cfg.variables)) {
    if (v.kind === "state") return true;
  }
  for (const seg of Object.values(cfg.segments)) {
    if (!seg.vars) continue;
    for (const v of Object.values(seg.vars)) {
      if (v.kind === "state") return true;
    }
  }
  return false;
}

// [LAW:dataflow-not-control-flow] A config emits a set-state click — and so
// needs session.id — when any widget writes a SessionState key. That is two
// values of the widget's state-use OR'd: it reads back a key (menu/stepper nav
// is a render-derived set-state write) or an author item binds a `set` action.
// copy/open-only buttons embed no session.id, so they write neither.
function hasWidgetSetAction(cfg: DslConfig): boolean {
  return Object.values(cfg.widgets).some((w) => {
    const use = widgetStateUse(w);
    return use.readsKey !== null || use.hasSetItem;
  });
}

function checkVarRefs(
  ctx: ValidateCtx,
  declPath: string,
  v: VariableDecl,
  allVars: Set<string>,
): void {
  if (v.kind === "template") {
    checkTemplateRefs(ctx, `${declPath}.template`, v.template, allVars);
  }
  if (hasCacheField(v)) {
    if (v.cache && "key" in v.cache) {
      checkTemplateRefs(ctx, `${declPath}.cache.key`, v.cache.key, allVars);
    }
  }
}

function checkDependsOn(
  ctx: ValidateCtx,
  declPath: string,
  v: VariableDecl,
  allVars: Set<string>,
): void {
  if (!hasCacheField(v)) return;
  if (!v.cache) return;
  if (!("depends_on" in v.cache)) return;
  for (let i = 0; i < v.cache.depends_on.length; i++) {
    const target = v.cache.depends_on[i]!;
    if (!allVars.has(target)) {
      ctx.issues.push({
        path: `${declPath}.cache.depends_on[${i}]`,
        message: `cache.depends_on references unknown variable "${target}"`,
        line: findKeyLine(ctx.source, [
          ...declPath.split("."),
          "cache",
          "depends_on",
        ]),
      });
    }
  }
}

function checkTemplateRefs(
  ctx: ValidateCtx,
  declPath: string,
  template: string,
  allVars: Set<string>,
  // [LAW:one-source-of-truth] Callers whose `declPath` is not a literal key path
  // into the source (a node `when`, whose canonical tree position no longer maps
  // to a source key after the layout/root merge) pass the already-resolved line
  // explicitly. Absent, the line is derived from the dotted declPath as before.
  line?: number,
): void {
  for (const ref of extractTemplateRefs(template)) {
    if (refResolves(ref, allVars)) continue;
    ctx.issues.push({
      path: declPath,
      message: `Template references unknown variable ".${ref}"`,
      line: line ?? findKeyLine(ctx.source, declPath.split(".")),
    });
  }
}

// A ref resolves if (a) the full dotted name is a declared variable, OR
// (b) it's a strict prefix of some declared variable (namespace navigation
// like .session in `.session.id` when only `session.id` is declared).
function refResolves(ref: string, allVars: Set<string>): boolean {
  if (allVars.has(ref)) return true;
  const prefix = `${ref}.`;
  for (const name of allVars) {
    if (name.startsWith(prefix)) return true;
  }
  return false;
}

// [LAW:dataflow-not-control-flow] Extract every `.<id>(.<id>)*` token inside
// `{{ ... }}` blocks after stripping string literals. The result is a set of
// dotted reference candidates; the caller decides which are valid. We deliberately
// don't full-parse templates here — that's chunk-2's engine job at compile time.
const TEMPLATE_BLOCK_RE = /{{([\s\S]*?)}}/g;
const STRING_LITERAL_RE = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`]*`/g;
const DOTTED_REF_RE =
  /(?<![A-Za-z0-9_)])\.([A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*)/g;

export function extractTemplateRefs(template: string): Set<string> {
  const refs = new Set<string>();
  let m: RegExpExecArray | null;
  TEMPLATE_BLOCK_RE.lastIndex = 0;
  while ((m = TEMPLATE_BLOCK_RE.exec(template)) !== null) {
    const block = m[1]!.replace(STRING_LITERAL_RE, "");
    let r: RegExpExecArray | null;
    DOTTED_REF_RE.lastIndex = 0;
    while ((r = DOTTED_REF_RE.exec(block)) !== null) {
      refs.add(r[1]!);
    }
  }
  return refs;
}

// ─── Cycle detection ─────────────────────────────────────────────────────────

// Carries declaration metadata for each graph node so cycle errors report the
// correct config path (variables.X vs segments.S.vars.X) and correct line.
interface NodeInfo {
  readonly declarationPath: string;
  readonly linePathParts: readonly string[];
}

function validateNoCycles(ctx: ValidateCtx, cfg: DslConfig): void {
  const { graph, nodeInfo } = buildTemplateGraph(cfg);

  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  const stack: string[] = [];

  for (const node of graph.keys()) color.set(node, WHITE);

  for (const start of graph.keys()) {
    if (color.get(start) !== WHITE) continue;
    if (dfs(start)) return; // first cycle is enough — report and stop walking
  }

  function dfs(node: string): boolean {
    color.set(node, GRAY);
    stack.push(node);
    for (const next of graph.get(node) ?? []) {
      const c = color.get(next);
      if (c === GRAY) {
        const cycleStart = stack.indexOf(next);
        const cycle = [...stack.slice(cycleStart), next];
        const firstNode = cycle[0]!;
        const info = nodeInfo.get(firstNode);
        ctx.issues.push({
          path: info?.declarationPath ?? `variables.${firstNode}`,
          message: `Dependency cycle: ${cycle.join(" → ")}`,
          line: findKeyLine(
            ctx.source,
            info?.linePathParts ?? ["variables", firstNode],
          ),
        });
        return true;
      }
      if (c === WHITE && dfs(next)) return true;
    }
    color.set(node, BLACK);
    stack.pop();
    return false;
  }
}

// [LAW:types-are-the-program] Build the full variable dependency graph: edges
// are X → Y for any of three edge kinds:
//   1. template-kind vars: template string references Y (eval dependency)
//   2. any var with cache.key: key template references Y (cache-key dependency)
//   3. any var with cache.depends_on: each listed name is Y (invalidation dep)
// All three kinds can form infinite loops at runtime; a single DFS catches
// mixed cycles that span multiple edge types.
//
// Segment vars use the namespaced form (segName.varName) as their sole graph
// node — eliminates bare-name collisions when two segments both declare a var
// named e.g. "local". Global vars keep their bare names.
function buildTemplateGraph(cfg: DslConfig): {
  graph: Map<string, Set<string>>;
  nodeInfo: Map<string, NodeInfo>;
} {
  const allVarNames = new Set<string>(Object.keys(cfg.variables));
  const nodeInfo = new Map<string, NodeInfo>();

  for (const name of Object.keys(cfg.variables)) {
    nodeInfo.set(name, {
      declarationPath: `variables.${name}`,
      linePathParts: ["variables", name],
    });
  }
  for (const [segName, seg] of Object.entries(cfg.segments)) {
    if (!seg.vars) continue;
    for (const vName of Object.keys(seg.vars)) {
      const canonical = `${segName}.${vName}`;
      allVarNames.add(canonical);
      nodeInfo.set(canonical, {
        declarationPath: `segments.${segName}.vars.${vName}`,
        linePathParts: ["segments", segName, "vars", vName],
      });
    }
  }

  const graph = new Map<string, Set<string>>();
  for (const name of allVarNames) graph.set(name, new Set());

  // segCtx resolves bare refs like `.local` to `${segCtx}.local` when that
  // namespaced form is a declared var — matches how segment-local refs resolve
  // at runtime (scope proxy walks own segment's vars first).
  const addTemplateEdges = (
    from: string,
    template: string,
    segCtx?: string,
  ): void => {
    for (const ref of extractTemplateRefs(template)) {
      if (allVarNames.has(ref)) {
        graph.get(from)!.add(ref);
        continue;
      }
      if (segCtx) {
        const namespaced = `${segCtx}.${ref}`;
        if (allVarNames.has(namespaced)) {
          graph.get(from)!.add(namespaced);
          continue;
        }
      }
      // Resolve "first identifier" — `.session.id` may indicate dependence on
      // `session` if that's the declared var (matches scope.ts proxy walk).
      const head = ref.split(".")[0]!;
      if (head !== ref && allVarNames.has(head)) {
        graph.get(from)!.add(head);
      }
    }
  };

  const addVarEdges = (
    name: string,
    v: VariableDecl,
    segCtx?: string,
  ): void => {
    if (v.kind === "template") addTemplateEdges(name, v.template, segCtx);
    if (hasCacheField(v)) {
      if (v.cache && "key" in v.cache)
        addTemplateEdges(name, v.cache.key, segCtx);
      if (v.cache && "depends_on" in v.cache) {
        for (const dep of v.cache.depends_on) {
          if (allVarNames.has(dep)) graph.get(name)!.add(dep);
        }
      }
    }
  };

  for (const [name, v] of Object.entries(cfg.variables)) {
    addVarEdges(name, v);
  }
  for (const [segName, seg] of Object.entries(cfg.segments)) {
    if (!seg.vars) continue;
    for (const [vName, vDecl] of Object.entries(seg.vars)) {
      addVarEdges(`${segName}.${vName}`, vDecl, segName);
    }
  }

  return { graph, nodeInfo };
}

// ─── Validation helpers ──────────────────────────────────────────────────────

function requireString(
  ctx: ValidateCtx,
  path: string,
  raw: Record<string, unknown>,
  field: string,
): string | null {
  const v = raw[field];
  if (typeof v !== "string") {
    ctx.issues.push({
      path: `${path}.${field}`,
      message: `${path}.${field} must be a string, got ${describeType(v)}`,
      line: findKeyLine(ctx.source, [...path.split("."), field]),
    });
    return null;
  }
  return v;
}

function optionalString(
  ctx: ValidateCtx,
  path: string,
  raw: Record<string, unknown>,
  field: string,
): { default?: string } {
  const v = optionalStringField(ctx, path, raw, field);
  return v === undefined ? {} : { [field]: v };
}

// [LAW:types-are-the-program] Input-var defaults must match the declared
// `type` exactly — a string default on a number-typed input would silently
// coerce or throw on first render. Reject the mismatch at load time so the
// renderer can read `.default` as the declared type without re-checking.
function optionalTypedDefault(
  ctx: ValidateCtx,
  path: string,
  raw: Record<string, unknown>,
  type: "string" | "number" | "boolean",
): string | number | boolean | undefined {
  const v = raw.default;
  if (v === undefined) return undefined;
  const ok =
    (type === "string" && typeof v === "string") ||
    (type === "number" && typeof v === "number") ||
    (type === "boolean" && typeof v === "boolean");
  if (!ok) {
    ctx.issues.push({
      path: `${path}.default`,
      message: `default must be a ${type}, got ${describeType(v)}`,
      line: findKeyLine(ctx.source, [...path.split("."), "default"]),
    });
    return undefined;
  }
  return v as string | number | boolean;
}

function optionalStringField(
  ctx: ValidateCtx,
  path: string,
  raw: Record<string, unknown>,
  field: string,
): string | undefined {
  const v = raw[field];
  if (v === undefined) return undefined;
  if (typeof v !== "string") {
    ctx.issues.push({
      path: `${path}.${field}`,
      message: `${path}.${field} must be a string, got ${describeType(v)}`,
      line: findKeyLine(ctx.source, [...path.split("."), field]),
    });
    return undefined;
  }
  return v;
}

// [LAW:single-enforcer] One place validates a palette NAME, shared by globals
// and per-segment. An unknown name is a hard error, never a silent fallback —
// the renderer must never receive a name that won't resolve to a Palette.
function validatePaletteName(
  ctx: ValidateCtx,
  path: string,
  raw: Record<string, unknown>,
): string | undefined {
  const v = optionalStringField(ctx, path, raw, "palette");
  if (v === undefined) return undefined;
  if (!ctx.allowedPalettes.has(v)) {
    ctx.issues.push({
      path: `${path}.palette`,
      message: `Unknown palette "${v}". Expected one of: ${[...ctx.allowedPalettes].sort().join(", ")}`,
      line: findKeyLine(ctx.source, [...path.split("."), "palette"]),
    });
    return undefined;
  }
  return v;
}

function optionalEnum<T extends string>(
  ctx: ValidateCtx,
  path: string,
  raw: Record<string, unknown>,
  field: string,
  allowed: readonly T[],
): T | undefined {
  const v = raw[field];
  if (v === undefined) return undefined;
  if (typeof v !== "string" || !(allowed as readonly string[]).includes(v)) {
    ctx.issues.push({
      path: `${path}.${field}`,
      message: `${path}.${field} must be one of: ${allowed.join(", ")}; got ${describeValue(v)}`,
      line: findKeyLine(ctx.source, [...path.split("."), field]),
    });
    return undefined;
  }
  return v as T;
}

function isSourceKind(s: string): s is SourceKind {
  return (SOURCE_KINDS as readonly string[]).includes(s);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function describeType(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

function describeValue(v: unknown): string {
  if (typeof v === "string") return JSON.stringify(v);
  if (v === undefined) return "undefined";
  return String(v);
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

// ─── Best-effort source-line lookup ──────────────────────────────────────────

// Walk source forward, finding each path component as a JSON5 key in turn.
// JSON5 keys are unquoted identifiers (`foo:`), double-quoted strings, or
// single-quoted strings. Numeric path parts (e.g., layout indices) are
// skipped — they point inside arrays where line lookup is less useful.
//
// This is "good enough" navigation, not a guarantee. Returns undefined if a
// path part can't be located — the caller falls back to the logical path.
// [LAW:one-source-of-truth] The authored top-level layout surface, read from the
// PARSED top-level keys (`root` wins; the loader already rejects authoring both).
// A structural read — not a text search — so a nested key named `root`/`layout`
// can never misclassify the config. Empty/unparseable source (the bundled
// default, no file) has no surface; defaults to the historical `layout` label.
function authoredLayoutKey(source: string): "root" | "layout" {
  try {
    const parsed = JSON5.parse(source);
    if (isPlainObject(parsed) && "root" in parsed) return "root";
  } catch {
    // No source to read (default config) or unparseable — fall through. A real
    // syntax error is already reported by parseDslConfig before cross-ref runs.
  }
  return "layout";
}

export function findKeyLine(
  source: string,
  pathParts: readonly string[],
): number | undefined {
  let cursor = 0;
  let foundCursor: number | undefined;
  for (const part of pathParts) {
    if (part === "" || /^\d+$/.test(part)) continue;
    const found = findKeyOccurrence(source, cursor, part);
    if (found === -1) {
      return foundCursor !== undefined
        ? lineFromOffset(source, foundCursor)
        : undefined;
    }
    cursor = found;
    foundCursor = found;
  }
  return foundCursor !== undefined
    ? lineFromOffset(source, foundCursor)
    : undefined;
}

function findKeyOccurrence(source: string, from: number, key: string): number {
  // Match `<key>:` or `"<key>":` or `'<key>':` — any whitespace before the colon
  // is allowed by JSON5. Escape regex specials in key.
  const escaped = key.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
  const re = new RegExp(`(?:["']${escaped}["']|\\b${escaped}\\b)\\s*:`, "g");
  re.lastIndex = from;
  const m = re.exec(source);
  return m ? m.index : -1;
}

function lineFromOffset(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source.charCodeAt(i) === 0x0a) line++;
  }
  return line;
}

// ─── Error formatting ────────────────────────────────────────────────────────

function formatIssues(file: string, issues: readonly ConfigIssue[]): string {
  if (issues.length === 0) return `${file}: invalid config (no details)`;
  const lines: string[] = [
    `Invalid config in ${file} (${issues.length} issue${issues.length === 1 ? "" : "s"}):`,
  ];
  for (const issue of issues) {
    const locParts: string[] = [];
    if (issue.line !== undefined) {
      locParts.push(
        `line ${issue.line}${issue.col !== undefined ? `:${issue.col}` : ""}`,
      );
    }
    if (issue.path) locParts.push(issue.path);
    const loc = locParts.length > 0 ? `[${locParts.join(" • ")}] ` : "";
    lines.push(`  ${loc}${issue.message}`);
  }
  return lines.join("\n");
}

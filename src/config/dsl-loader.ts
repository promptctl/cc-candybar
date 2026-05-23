// [LAW:single-enforcer] loadDslConfig is the single entry point for the new
// DSL config. No parallel parser, no per-caller validation pass. Anything
// downstream that wants a DslConfig calls this and trusts the returned shape.
//
// [LAW:dataflow-not-control-flow] Validation is a series of passes, each
// accumulating issues into a list. We never short-circuit on the first error
// — the user sees every problem at once (compiler-style). The only branch
// is "any structural errors? then skip cross-ref/cycle passes (they assume
// valid structures)" — and even that is a single gate, not a scattered set
// of guards.

import fs from "node:fs";
import JSON5 from "json5";
import {
  CACHE_KEYS,
  GIT_FIELDS,
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
  type SegmentDecl,
  type SourceKind,
  type TruncateMode,
  type VariableDecl,
} from "./dsl-types.js";
import { listResolvablePaletteNames } from "../themes/cascade.js";

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

// ─── Entry point ─────────────────────────────────────────────────────────────

/**
 * Load and validate a JSON5 DSL config file.
 *
 * Returns a fully-validated DslConfig (every legal state representable, every
 * illegal state unrepresentable: closed source-kind set, exactly-one cache
 * key, no dangling cross-refs, no template cycles).
 *
 * Throws ConfigError aggregating every problem found.
 */
export function loadDslConfig(
  filePath: string,
  allowedPalettes?: ReadonlySet<string>,
): DslConfig {
  const source = fs.readFileSync(filePath, "utf-8");
  return parseDslConfig(filePath, source, allowedPalettes);
}

/**
 * Same as loadDslConfig but takes the source text directly. Useful in tests
 * (no fs mocking required).
 *
 * `allowedPalettes` is the set of palette names a `palette:` field may name.
 * It defaults to every name that resolves to a concrete Palette, so production
 * always validates loudly against the real registry. Tests inject a custom set
 * to exercise validation without depending on registry contents.
 * [LAW:no-defensive-null-guards] A defaulted real-registry set is not a silent
 * fallback — the default IS the production behavior (validate against reality),
 * not a "skip validation if absent" escape hatch.
 */
export function parseDslConfig(
  filePath: string,
  source: string,
  allowedPalettes: ReadonlySet<string> = new Set(listResolvablePaletteNames()),
): DslConfig {
  // ── Stage 1: JSON5 syntax. A parse error here is single, immediate, and
  // carries line/col from the json5 package — no point continuing to other
  // passes that need a parsed structure to inspect.
  const raw = parseJson5OrThrow(filePath, source);

  const issues: ConfigIssue[] = [];
  const ctx: ValidateCtx = { source, issues, allowedPalettes };

  // ── Stage 2: top-level shape + per-record shape.
  if (!isPlainObject(raw)) {
    throw new ConfigError(filePath, [
      {
        path: "",
        message: `Config root must be an object, got ${describeType(raw)}`,
      },
    ]);
  }

  const topLevel = validateTopLevel(ctx, raw);

  // ── Stage 3: cross-reference + cycle detection. Only meaningful if the
  // structural validation produced something we can traverse. If structural
  // errors exist, cross-ref errors would be noise on top of them.
  if (issues.length === 0) {
    validateCrossReferences(ctx, topLevel);
    validateNoCycles(ctx, topLevel);
  }

  if (issues.length > 0) {
    throw new ConfigError(filePath, issues);
  }

  return topLevel;
}

// ─── Palette cascade ─────────────────────────────────────────────────────────

/**
 * Resolve a segment's effective palette name from the cascade:
 *   default → globals.palette → segment.palette   (last write wins).
 *
 * Returns the name the renderer should pull this segment's colors from, or
 * undefined to inherit the active/default palette (which lives outside the DSL
 * config, set by the top-level theme). Both inputs were validated at load, so
 * any non-undefined result is guaranteed to resolve to a real Palette.
 *
 * [LAW:single-enforcer] The cascade precedence is defined here once. Consumers
 * call this rather than re-deriving `segment.palette ?? globals.palette`, so
 * the precedence cannot drift between callsites.
 * [LAW:one-source-of-truth] The effective palette is a derivation, not stored
 * state — globals.palette and segment.palette remain the only authoritative
 * inputs, so there is nothing to keep in sync.
 */
export function effectiveSegmentPalette(
  globals: Globals,
  segment: SegmentDecl,
): string | undefined {
  return segment.palette ?? globals.palette;
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

function validateTopLevel(
  ctx: ValidateCtx,
  raw: Record<string, unknown>,
): DslConfig {
  for (const key of Object.keys(raw)) {
    if (!TOP_LEVEL_KEYS.has(key)) {
      ctx.issues.push({
        path: key,
        message: `Unknown top-level key "${key}". Expected one of: ${[...TOP_LEVEL_KEYS].join(", ")}`,
        line: findKeyLine(ctx.source, [key]),
      });
    }
  }

  const globals = validateGlobals(ctx, raw.globals);
  const variables = validateVariables(ctx, "variables", raw.variables);
  const segments = validateSegments(ctx, raw.segments);
  const layout = validateLayout(ctx, raw.layout, segments);

  return { globals, variables, segments, layout };
}

const TOP_LEVEL_KEYS = new Set(["globals", "variables", "segments", "layout"]);

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
    "hueStep",
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

  if (raw.hueStep !== undefined) {
    if (typeof raw.hueStep !== "number" || !Number.isFinite(raw.hueStep)) {
      ctx.issues.push({
        path: "globals.hueStep",
        message: `globals.hueStep must be a finite number, got ${describeType(raw.hueStep)}`,
        line: findKeyLine(ctx.source, ["globals", "hueStep"]),
      });
    } else {
      out.hueStep = raw.hueStep;
    }
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
      return {
        kind: "input",
        path: p,
        ...optionalString(ctx, path, raw, "default"),
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
      const sessionIdVar = optionalStringField(
        ctx,
        path,
        raw,
        "sessionIdVar",
      );
      const def = optionalStringField(ctx, path, raw, "default");
      return {
        kind: "state",
        key,
        ...(sessionIdVar !== undefined && { sessionIdVar }),
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

function validateLayout(
  ctx: ValidateCtx,
  raw: unknown,
  segments: Record<string, SegmentDecl>,
): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    ctx.issues.push({
      path: "layout",
      message: `layout must be an array of segment names, got ${describeType(raw)}`,
      line: findKeyLine(ctx.source, ["layout"]),
    });
    return [];
  }

  const out: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i];
    if (typeof entry !== "string") {
      ctx.issues.push({
        path: `layout[${i}]`,
        message: `layout entries must be strings (segment names), got ${describeType(entry)}`,
        line: findKeyLine(ctx.source, ["layout"]),
      });
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(segments, entry)) {
      ctx.issues.push({
        path: `layout[${i}]`,
        message: `layout entry "${entry}" does not match any declared segment`,
        line: findKeyLine(ctx.source, ["layout"]),
      });
      continue;
    }
    out.push(entry);
  }
  return out;
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
    for (const field of ["template", "bg", "fg", "when"] as const) {
      const tpl = seg[field];
      if (typeof tpl !== "string") continue;
      checkTemplateRefs(ctx, `segments.${segName}.${field}`, tpl, segScope);
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
): void {
  for (const ref of extractTemplateRefs(template)) {
    if (refResolves(ref, allVars)) continue;
    ctx.issues.push({
      path: declPath,
      message: `Template references unknown variable ".${ref}"`,
      line: findKeyLine(ctx.source, declPath.split(".")),
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

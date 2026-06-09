// [LAW:single-enforcer] The validation engine's primitives: the shared
// ValidateCtx every per-type validator threads, the field-combinators
// (requireString / optionalEnum / …) they compose from, and the type-describe
// helpers used in messages. Each per-type schema module (variables, segments,
// …) is a DECLARATION built from these; changing a primitive changes every
// validator uniformly. This file changes when the combinator vocabulary changes.

import { SOURCE_KINDS, type SourceKind } from "../dsl-types.js";
import { findKeyLine, type ConfigIssue } from "./diagnostics.js";

export interface ValidateCtx {
  readonly source: string;
  readonly issues: ConfigIssue[];
  readonly allowedPalettes: ReadonlySet<string>;
}

export type Mutable<T> = { -readonly [K in keyof T]: T[K] };

export function requireString(
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

export function optionalString(
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
export function optionalTypedDefault(
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

export function optionalStringField(
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
export function validatePaletteName(
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

export function optionalEnum<T extends string>(
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

export function isSourceKind(s: string): s is SourceKind {
  return (SOURCE_KINDS as readonly string[]).includes(s);
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function describeType(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

export function describeValue(v: unknown): string {
  if (typeof v === "string") return JSON.stringify(v);
  if (v === undefined) return "undefined";
  return String(v);
}

// ─── Schema engine kernel ────────────────────────────────────────────────────

// [LAW:types-are-the-program] A FieldSpec is the parser for ONE field of a record:
// it reads raw[field] at `${path}.${field}`, reports any issue into ctx, and
// yields the parsed value or undefined (absent or invalid → omitted from output).
// `required` lets `record` fail the whole record when a load-bearing field is
// absent or invalid, so a per-type schema declares its shape as DATA instead of
// hand-threading combinator results through `if (x === null) return null`.
export interface FieldSpec<T> {
  readonly required: boolean;
  parse(
    ctx: ValidateCtx,
    path: string,
    field: string,
    raw: Record<string, unknown>,
  ): T | undefined;
}

// [LAW:types-are-the-program] The field map must cover EXACTLY the keys of the
// target type — `-?` forces a spec for every field (forgetting one is a compile
// error) and NonNullable lets an optional field declare a spec for its present
// value type. The schema is checked against T, so the record body needs no cast
// beyond the final dynamic assembly.
export type FieldSpecMap<T> = {
  [K in keyof T]-?: FieldSpec<NonNullable<T[K]>>;
};

export interface RecordSchema<T> {
  // The noun in this record's unknown-key message ("globals key", "layout-node
  // key", …) — the one phrasing that varies per record; everything else is shared.
  readonly noun: string;
  readonly fields: FieldSpecMap<T>;
}

// [LAW:dataflow-not-control-flow] The record interpreter: the same unconditional
// sequence for every record — guard object, reject unknown keys, run each field
// spec, collect the present values. The variability (which fields, required-ness,
// each field's message) lives in the schema DATA, never in branches here. Returns
// the assembled record, or null when raw is not an object or a required field
// failed — the two recovery shapes a caller wraps (`?? {}` for an optional block,
// a drop for a union arm). This absorbs the per-type isPlainObject guard, the
// reject-unknown-key loop, the result-threading, and the optional-omission spreads.
export function record<T>(
  ctx: ValidateCtx,
  schema: RecordSchema<T>,
  path: string,
  raw: unknown,
): T | null {
  if (!isPlainObject(raw)) {
    ctx.issues.push({
      path,
      message: `${path} must be an object, got ${describeType(raw)}`,
      line: findKeyLine(ctx.source, path.split(".")),
    });
    return null;
  }

  const fields = schema.fields as Readonly<Record<string, FieldSpec<unknown>>>;
  rejectUnknownKeys(ctx, path, raw, schema.noun, new Set(Object.keys(fields)));

  const out: Record<string, unknown> = {};
  let ok = true;
  for (const [field, spec] of Object.entries(fields)) {
    const value = spec.parse(ctx, path, field, raw);
    if (value !== undefined) out[field] = value;
    else if (spec.required) ok = false;
  }
  return ok ? (out as T) : null;
}

// [LAW:single-enforcer] One reject-unknown-key loop for every record, replacing
// the per-module hand-rolled copies. The `noun` carries the only per-record
// variation in the message; the allowed set is the schema's declared field names.
function rejectUnknownKeys(
  ctx: ValidateCtx,
  path: string,
  raw: Record<string, unknown>,
  noun: string,
  allowed: ReadonlySet<string>,
): void {
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      ctx.issues.push({
        path: `${path}.${key}`,
        message: `Unknown ${noun} "${key}". Expected one of: ${[...allowed].join(", ")}`,
        line: findKeyLine(ctx.source, [...path.split("."), key]),
      });
    }
  }
}

// [LAW:dataflow-not-control-flow] Field specs lift the existing field combinators
// into the record vocabulary. An optional string is included when present-and-
// valid, omitted (with an issue) when present-and-wrong, omitted silently when
// absent — the same three-way the hand-rolled loops expressed as `continue`.
export function optionalStringSpec(): FieldSpec<string> {
  return {
    required: false,
    parse: (ctx, path, field, raw) =>
      optionalStringField(ctx, path, raw, field),
  };
}

// [LAW:single-enforcer] The palette field defers to the one palette-name
// authority; the field key is conventionally "palette", which validatePaletteName
// reads directly.
export function paletteSpec(): FieldSpec<string> {
  return {
    required: false,
    parse: (ctx, path, _field, raw) => validatePaletteName(ctx, path, raw),
  };
}

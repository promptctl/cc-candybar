// [LAW:single-enforcer] The validation engine's primitives. Each per-type schema
// module is a DECLARATION built from these; a primitive changes every validator.

import {
  SOURCE_KINDS,
  type GroupSugarDecl,
  type SourceKind,
} from "../dsl-types.js";
import { findKeyLine, type ConfigIssue } from "./diagnostics.js";

export interface ValidateCtx {
  readonly source: string;
  readonly issues: ConfigIssue[];
  readonly allowedPalettes: ReadonlySet<string>;
  // [LAW:one-source-of-truth] Collected during the walk, which owns positions; the later synthesis pass owns cross-section emission.
  readonly groups: GroupSugarDecl[];
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

// [LAW:types-are-the-program] Rejected at load time so the renderer can read `.default` as the declared type without re-checking.
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

// [LAW:single-enforcer] The renderer must never receive a name that won't resolve to a Palette.
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

// [LAW:types-are-the-program] The parser for ONE field: undefined means absent or
// invalid, and `required` is what lets a per-type schema declare its shape as DATA
// instead of hand-threading `if (x === null) return null`.
export interface FieldSpec<T> {
  readonly required: boolean;
  // [LAW:one-source-of-truth] The emit facet, authored beside `parse` and reading the
  // same constants, so the editor-facing schema cannot describe a different grammar.
  readonly json: JsonNode;
  parse(
    ctx: ValidateCtx,
    path: string,
    field: string,
    raw: Record<string, unknown>,
  ): T | undefined;
}

// [LAW:types-are-the-program] JSON Schema is itself JSON, so the emit AST is the target format, with no descriptor type to keep in sync.
export type JsonNode = Readonly<Record<string, unknown>>;

// [LAW:types-are-the-program] `-?` forces a spec for every field of the target type,
// so forgetting one is a compile error, and NonNullable types an optional field.
export type FieldSpecMap<T> = {
  [K in keyof T]-?: FieldSpec<NonNullable<T[K]>>;
};

export interface RecordSchema<T> {
  readonly noun: string;
  readonly fields: FieldSpecMap<T>;
}

// [LAW:dataflow-not-control-flow] The record interpreter: one unconditional sequence
// for every record, with all variability living in the schema DATA.
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

  rejectUnknownKeys(
    ctx,
    path,
    raw,
    schema.noun,
    new Set(Object.keys(schema.fields)),
  );
  return fields(ctx, schema.fields, path, raw);
}

// [LAW:decomposition] The join `record` and a union arm share. An arm reuses THIS
// rather than `record` because it must NOT reject unknown keys: the discriminator
// is a sibling key the arm doesn't list.
export function fields<T>(
  ctx: ValidateCtx,
  fieldMap: FieldSpecMap<T>,
  path: string,
  raw: Record<string, unknown>,
): T | null {
  const specs = fieldMap as Readonly<Record<string, FieldSpec<unknown>>>;
  const out: Record<string, unknown> = {};
  let ok = true;
  for (const [field, spec] of Object.entries(specs)) {
    const value = spec.parse(ctx, path, field, raw);
    if (value !== undefined) out[field] = value;
    else if (spec.required) ok = false;
  }
  return ok ? (out as T) : null;
}

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

export function reject<M>(
  ctx: ValidateCtx,
  path: string,
  message: string,
): M | null {
  ctx.issues.push({
    path,
    message,
    line: findKeyLine(ctx.source, path.split(".")),
  });
  return null;
}

// [LAW:types-are-the-program] A tag-by-which-key-present union: an arm parses the
// VALUE held at that key, and `-?` + Extract force an arm per member.
export interface PresentArm<M> {
  readonly json: JsonNode;
  parse(ctx: ValidateCtx, path: string, value: unknown): M | null;
}

type PresentKeyOf<T> = T extends infer M ? keyof M : never;

export type PresentArmMap<T> = {
  [K in PresentKeyOf<T> & string]-?: PresentArm<
    Extract<T, { readonly [P in K]: unknown }>
  >;
};

export interface OneOfPresentSchema<T> {
  readonly noun: string;
  readonly arms: PresentArmMap<T>;
}

// [LAW:dataflow-not-control-flow] Distinct from `record` because the contract is exactly-one-present, not a field set.
export function oneOfPresent<T>(
  ctx: ValidateCtx,
  schema: OneOfPresentSchema<T>,
  path: string,
  raw: unknown,
): T | null {
  if (!isPlainObject(raw)) {
    ctx.issues.push({
      path,
      message: `${schema.noun} must be an object, got ${describeType(raw)}`,
      line: findKeyLine(ctx.source, path.split(".")),
    });
    return null;
  }

  const arms = schema.arms as Readonly<Record<string, PresentArm<T>>>;
  const keys = Object.keys(arms);
  const present = Object.keys(raw).filter((k) => k in arms);
  const unknown = Object.keys(raw).filter((k) => !(k in arms));
  for (const k of unknown) {
    ctx.issues.push({
      path: `${path}.${k}`,
      message: `Unknown ${schema.noun} key "${k}". Expected exactly one of: ${keys.join(", ")}`,
      line: findKeyLine(ctx.source, [...path.split("."), k]),
    });
  }

  if (present.length === 0) {
    ctx.issues.push({
      path,
      message: `${schema.noun} must declare exactly one of: ${keys.join(", ")}`,
      line: findKeyLine(ctx.source, path.split(".")),
    });
    return null;
  }
  if (present.length > 1) {
    ctx.issues.push({
      path,
      message: `${schema.noun} must declare exactly one of: ${keys.join(", ")} (found: ${present.join(", ")})`,
      line: findKeyLine(ctx.source, path.split(".")),
    });
    return null;
  }

  const key = present[0]!;
  return arms[key]!.parse(ctx, `${path}.${key}`, raw[key]);
}

// [LAW:types-are-the-program] A tag-by-field-value union: an arm receives the WHOLE
// raw object at the union's own path, since the discriminator is a sibling field.
export interface TaggedArm<M> {
  readonly json: JsonNode;
  parse(ctx: ValidateCtx, path: string, raw: Record<string, unknown>): M | null;
}

type TagValueOf<T, K extends string> =
  T extends Record<K, infer V> ? V & string : never;

export type TaggedArmMap<T, K extends string> = {
  [V in TagValueOf<T, K>]-?: TaggedArm<Extract<T, Record<K, V>>>;
};

export interface TaggedUnionSchema<T, K extends string> {
  readonly tag: K;
  readonly noun: string;
  readonly arms: TaggedArmMap<T, K>;
}

// [LAW:dataflow-not-control-flow] A non-string tag points at the variable, since the key may be absent; an unknown value points at the key itself.
export function taggedUnion<T, K extends string>(
  ctx: ValidateCtx,
  schema: TaggedUnionSchema<T, K>,
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

  const tagValue = raw[schema.tag];
  if (typeof tagValue !== "string") {
    ctx.issues.push({
      path: `${path}.${schema.tag}`,
      message: `${path}.${schema.tag} must be a string, got ${describeType(tagValue)}`,
      line: findKeyLine(ctx.source, path.split(".")),
    });
    return null;
  }

  const arms = schema.arms as Readonly<Record<string, TaggedArm<T>>>;
  if (!(tagValue in arms)) {
    ctx.issues.push({
      path: `${path}.${schema.tag}`,
      message: `Unknown ${schema.noun} "${tagValue}". Expected one of: ${Object.keys(arms).join(", ")}`,
      line: findKeyLine(ctx.source, [...path.split("."), schema.tag]),
    });
    return null;
  }

  return arms[tagValue]!.parse(ctx, path, raw);
}

// [LAW:types-are-the-program] The one signature `fields`, `refine` and a union arm all speak, so a schema can compose them.
export type ArmParse<T> = (
  ctx: ValidateCtx,
  path: string,
  raw: Record<string, unknown>,
) => T | null;

// [LAW:types-are-the-program] The recursion seam: a self-referential schema names the
// parser it is part of, and reading that at construction time is a temporal-dead-zone
// crash, so `lazy` defers the read to call time. It owns no validation, only deferral.
export function lazy<A extends readonly unknown[], R>(
  thunk: () => (...args: A) => R,
): (...args: A) => R {
  return (...args) => thunk()(...args);
}

// [LAW:types-are-the-program] An invariant relating two fields, which a field spec
// cannot express alone. `issue.field` is the sub-path to point at, "" being the record.
export interface Refinement<T> {
  ok(value: T): boolean;
  issue(value: T): { readonly field: string; readonly message: string };
}

// [LAW:dataflow-not-control-flow] The order of `checks` is the order of reporting, and a failed inner parse never reaches a refinement.
export function refine<T>(
  inner: ArmParse<T>,
  ...checks: ReadonlyArray<Refinement<T>>
): ArmParse<T> {
  return (ctx, path, raw) => {
    const value = inner(ctx, path, raw);
    if (value === null) return null;
    for (const check of checks) {
      if (check.ok(value)) continue;
      const { field, message } = check.issue(value);
      const at = field === "" ? path : `${path}.${field}`;
      ctx.issues.push({
        path: at,
        message,
        line: findKeyLine(ctx.source, at.split(".")),
      });
      return null;
    }
    return value;
  };
}

export function optionalStringSpec(): FieldSpec<string> {
  return {
    required: false,
    json: { type: "string" },
    parse: (ctx, path, field, raw) =>
      optionalStringField(ctx, path, raw, field),
  };
}

export function optionalBooleanSpec(): FieldSpec<boolean> {
  return {
    required: false,
    json: { type: "boolean" },
    parse: (ctx, path, field, raw) => {
      const v = raw[field];
      if (v === undefined) return undefined;
      if (typeof v !== "boolean") {
        ctx.issues.push({
          path: `${path}.${field}`,
          message: `${field} must be a boolean, got ${describeType(v)}`,
          line: findKeyLine(ctx.source, [field]),
        });
        return undefined;
      }
      return v;
    },
  };
}

// [LAW:dataflow-not-control-flow] The bounds feed both interpreters, so the validator and the emitted schema cannot describe different ranges.
export function optionalIntSpec(bounds: {
  readonly min: number;
  readonly max: number;
}): FieldSpec<number> {
  const { min, max } = bounds;
  return {
    required: false,
    json: { type: "integer", minimum: min, maximum: max },
    parse: (ctx, path, field, raw) => {
      const v = raw[field];
      if (v === undefined) return undefined;
      if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
        ctx.issues.push({
          path: `${path}.${field}`,
          message: `${field} must be an integer between ${min} and ${max}, got ${describeValue(v)}`,
          line: findKeyLine(ctx.source, [field]),
        });
        return undefined;
      }
      return v;
    },
  };
}

// Finite matters: JSON5 admits `NaN`/`Infinity` literals, and a non-finite axis would corrupt every OKLCH channel downstream.
export function optionalNumberSpec(
  bounds: { readonly min?: number } = {},
): FieldSpec<number> {
  const { min } = bounds;
  return {
    required: false,
    json: { type: "number", ...(min !== undefined && { minimum: min }) },
    parse: (ctx, path, field, raw) => {
      const v = raw[field];
      if (v === undefined) return undefined;
      const bad =
        typeof v !== "number" ||
        !Number.isFinite(v) ||
        (min !== undefined && v < min);
      if (bad) {
        const shape =
          min !== undefined ? `a finite number >= ${min}` : "a finite number";
        ctx.issues.push({
          path: `${path}.${field}`,
          message: `${field} must be ${shape}, got ${describeValue(v)}`,
          line: findKeyLine(ctx.source, [field]),
        });
        return undefined;
      }
      return v;
    },
  };
}

export function paletteSpec(): FieldSpec<string> {
  return {
    required: false,
    // Membership is resolved at load from installed palettes, not a compile-time enum.
    json: { type: "string" },
    parse: (ctx, path, _field, raw) => validatePaletteName(ctx, path, raw),
  };
}

// The record engine reads undefined as "absent or invalid", so null collapses to it.
export function requireStringSpec(): FieldSpec<string> {
  return {
    required: true,
    json: { type: "string" },
    parse: (ctx, path, field, raw) =>
      requireString(ctx, path, raw, field) ?? undefined,
  };
}

export function optionalEnumSpec<T extends string>(
  allowed: readonly T[],
): FieldSpec<T> {
  return {
    required: false,
    json: { enum: [...allowed] },
    parse: (ctx, path, field, raw) =>
      optionalEnum(ctx, path, raw, field, allowed),
  };
}

// [LAW:dataflow-not-control-flow] The emit-twin of `fields`, walking the SAME field
// map. A `record` forbids unknown keys; a union arm allows the sibling discriminator.
export function objectJson<T>(
  fieldMap: FieldSpecMap<T>,
  opts: { readonly closed: boolean } = { closed: true },
): JsonNode {
  const specs = fieldMap as Readonly<Record<string, FieldSpec<unknown>>>;
  const properties: Record<string, JsonNode> = {};
  const required: string[] = [];
  for (const [field, spec] of Object.entries(specs)) {
    properties[field] = spec.json;
    if (spec.required) required.push(field);
  }
  return {
    type: "object",
    properties,
    ...(required.length > 0 && { required }),
    ...(opts.closed && { additionalProperties: false }),
  };
}

export function recordJson<T>(schema: RecordSchema<T>): JsonNode {
  return objectJson(schema.fields);
}

export function withConst(
  base: JsonNode,
  key: string,
  value: string,
): JsonNode {
  const b = base as Record<string, unknown>;
  const properties = {
    [key]: { const: value },
    ...(b.properties as Record<string, JsonNode> | undefined),
  };
  const required = [key, ...((b.required as string[] | undefined) ?? [])];
  return { ...b, properties, required };
}

export function taggedUnionJson<T, K extends string>(
  schema: TaggedUnionSchema<T, K>,
): JsonNode {
  const arms = schema.arms as Readonly<Record<string, TaggedArm<T>>>;
  return { anyOf: Object.values(arms).map((arm) => arm.json) };
}

export function oneOfPresentJson<T>(schema: OneOfPresentSchema<T>): JsonNode {
  const arms = schema.arms as Readonly<Record<string, PresentArm<T>>>;
  return {
    anyOf: Object.entries(arms).map(([key, arm]) => ({
      type: "object",
      properties: { [key]: arm.json },
      required: [key],
      additionalProperties: false,
    })),
  };
}

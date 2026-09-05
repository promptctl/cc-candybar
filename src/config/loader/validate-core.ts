// [LAW:single-enforcer] The validation engine's primitives: the shared
// ValidateCtx every per-type validator threads, the field-combinators
// (requireString / optionalEnum / …) they compose from, and the type-describe
// helpers used in messages. Each per-type schema module (variables, segments,
// …) is a DECLARATION built from these; changing a primitive changes every
// validator uniformly. This file changes when the combinator vocabulary changes.

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
  // [LAW:one-source-of-truth] The `group` sugar nodes collected during the root
  // walk — the single record the loader's synthesis pass (group state var +
  // cycle action + toggle segment) derives from. Parse-time collection, post-
  // walk synthesis: the walk owns positions, the synthesis owns cross-section
  // emission.
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
  // [LAW:one-source-of-truth] The emit facet, authored beside `parse`: the
  // JSON-Schema fragment for THIS field's value. `parse` is the validate
  // interpreter, `json` the schema interpreter — two projections of one
  // declaration, so the editor-facing schema can never describe a different
  // grammar than the runtime validator. Both read the same source constants
  // (e.g. an enum spec's `allowed` feeds both `parse`'s membership check and
  // `json`'s `enum`), so they cannot drift. A JSON Schema fragment IS data
  // (JSON Schema is its own serialization), so the facet is a plain object.
  readonly json: JsonNode;
  parse(
    ctx: ValidateCtx,
    path: string,
    field: string,
    raw: Record<string, unknown>,
  ): T | undefined;
}

// [LAW:types-are-the-program] A JSON-Schema fragment: the schema-shape facet of
// a declaration. JSON Schema is itself JSON, so the emit AST is just the target
// format — no parallel descriptor type to keep in sync with the serializer.
export type JsonNode = Readonly<Record<string, unknown>>;

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

  rejectUnknownKeys(
    ctx,
    path,
    raw,
    schema.noun,
    new Set(Object.keys(schema.fields)),
  );
  return fields(ctx, schema.fields, path, raw);
}

// [LAW:decomposition] The field-assembly core: run each field spec against an
// already-guarded object, collect the present values, fail the whole when a
// required field is absent or invalid. `record` adds the object guard and
// unknown-key rejection on top; a tagged-union arm reuses THIS directly, because
// an arm must NOT reject unknown keys — the discriminator (`kind`) is a sibling
// key the arm doesn't list. Returns the assembled record, or null when a required
// field failed. This is the join `record` and `taggedUnion`'s arms share.
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

// [LAW:single-enforcer] One arm helper to push a variant's bespoke message and
// drop — the message is the only thing that varies per arm, carried as DATA.
// Shared by every present-key schema (cache, parse).
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

// [LAW:types-are-the-program] A tag-by-which-key-present union: every member
// carries exactly one own key (CacheDecl's ttl/watch_file/…, an action's
// set/copy/open). PresentArm parses the VALUE held at that key into its member
// shape; the arm map must cover every present-key (the `-?` + Extract force an
// arm per member, typed to return exactly that member — forgetting one is a
// compile error). The bespoke per-arm message lives in its parse closure as DATA.
export interface PresentArm<M> {
  // [LAW:one-source-of-truth] The emit facet: the JSON-Schema for the VALUE held
  // at this arm's present key (oneOfPresentJson wraps it in the single-required
  // object the present-key contract describes). Authored beside `parse`.
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
  // The noun in this union's structural messages ("cache must be an object",
  // "Unknown cache key", "cache must declare exactly one of") — the one phrasing
  // that varies per union; the candidate key list is the arm-map's key order.
  readonly noun: string;
  readonly arms: PresentArmMap<T>;
}

// [LAW:dataflow-not-control-flow] The tag-by-present-key interpreter: the same
// unconditional sequence for every such union — guard object, reject unknown
// keys, enforce exactly-one present, dispatch to that arm. Distinct from `record`
// because the contract differs ("Expected exactly one of", zero/multiple-present
// counting); the variability (noun, arms, each arm's message) is DATA. Returns
// the parsed member, or null when raw is not an object, no/multiple keys are
// present, or the single arm fails — the drop shape a union caller recovers.
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

// [LAW:types-are-the-program] A tag-by-field-value union: every member carries a
// shared discriminator field (VariableDecl's `kind`) whose value selects the arm.
// TaggedArm parses the WHOLE raw object into its member shape (an arm reads many
// sibling fields, so it receives `raw`, not one extracted value), at the union's
// own path (the discriminator is a sibling, so the path doesn't descend). The arm
// map must cover every tag value (`-?` + Extract force an arm per member, typed
// to return exactly that member). The bespoke per-arm field schema lives in its
// parse closure as DATA.
export interface TaggedArm<M> {
  // [LAW:one-source-of-truth] The emit facet: the FULL object schema for this
  // member, discriminator included (the arm knows its own tag value, so it bakes
  // `{ [tag]: { const } }` into `json`). taggedUnionJson simply collects each
  // arm's `json` into the `anyOf`. Authored beside `parse`.
  readonly json: JsonNode;
  parse(ctx: ValidateCtx, path: string, raw: Record<string, unknown>): M | null;
}

type TagValueOf<T, K extends string> =
  T extends Record<K, infer V> ? V & string : never;

export type TaggedArmMap<T, K extends string> = {
  [V in TagValueOf<T, K>]-?: TaggedArm<Extract<T, Record<K, V>>>;
};

export interface TaggedUnionSchema<T, K extends string> {
  // The discriminator field name ("kind") and the noun in its unknown-value
  // message ("source kind") — the two phrasings that vary per union; the valid
  // tag-value list is the arm-map's key order.
  readonly tag: K;
  readonly noun: string;
  readonly arms: TaggedArmMap<T, K>;
}

// [LAW:dataflow-not-control-flow] The tag-by-field-value interpreter: the same
// unconditional sequence for every such union — guard object, read the
// discriminator, reject a non-string or unknown tag, dispatch to that arm.
// Distinct from `oneOfPresent` because the tag is a named field's VALUE, not
// which key is present; the variability (tag name, noun, arms) is DATA. Returns
// the parsed member, or null when raw is not an object, the tag is missing/
// non-string/unknown, or the arm fails — the drop shape the per-name caller
// recovers. A non-string tag points at the variable (the key may be absent); an
// unknown tag value points at the discriminator key itself.
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

// [LAW:types-are-the-program] An arm parser narrows an already-guarded record to
// a member shape or null — the signature `fields`, `refine`, and a union arm all
// speak. Exposing it as a name lets a per-type schema compose arms (refine a
// fields-record, hand it to a present-key dispatch) without restating the shape.
export type ArmParse<T> = (
  ctx: ValidateCtx,
  path: string,
  raw: Record<string, unknown>,
) => T | null;

// [LAW:types-are-the-program] The recursion seam: a parser referenced before it
// exists. A recursive config shape (the layout node tree — a container's children
// are themselves nodes) declares its child-list field as DATA that points back at
// the very parser it is part of; reading that parser at schema-construction time
// is a temporal-dead-zone crash, so `lazy` defers the read to call time. Generic
// over any parser signature (a node parser takes raw:unknown and recovers, an arm
// takes a guarded record and may drop) — it owns no validation, only the deferral,
// so the same primitive serves every self-referential schema [LAW:decomposition].
export function lazy<A extends readonly unknown[], R>(
  thunk: () => (...args: A) => R,
): (...args: A) => R {
  return (...args) => thunk()(...args);
}

// [LAW:types-are-the-program] A cross-field refinement: a predicate over the
// ASSEMBLED member that the field specs cannot express alone (min < max, by != 0
// — invariants relating two fields), paired with the bespoke issue it yields when
// violated. `ok` and `issue` both read the value, so an interpolated message
// ("min (0) must be less than max (-1)") is DATA derived from the value, not a
// branch. `issue.field` names the sub-path the message points at ("" = the record
// itself); the engine prepends the path and resolves the source line.
export interface Refinement<T> {
  ok(value: T): boolean;
  issue(value: T): { readonly field: string; readonly message: string };
}

// [LAW:dataflow-not-control-flow] The refinement interpreter: run the inner arm,
// then fold the assembled value through each refinement in order, surfacing the
// first violated invariant and dropping the member. The lawful generalization of
// the hand-rolled `if (min >= max) { push; return null }` tail every record grew
// for its cross-field checks — the invariant is a DECLARATION, the report is
// mechanical. Null threads through untouched (a failed inner parse never reaches
// a refinement), and the order of `checks` is the order of reporting — the same
// short-circuit the inline tail expressed with sequential `if`s.
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

// [LAW:dataflow-not-control-flow] Field specs lift the existing field combinators
// into the record vocabulary. An optional string is included when present-and-
// valid, omitted (with an issue) when present-and-wrong, omitted silently when
// absent — the same three-way the hand-rolled loops expressed as `continue`.
export function optionalStringSpec(): FieldSpec<string> {
  return {
    required: false,
    json: { type: "string" },
    parse: (ctx, path, field, raw) =>
      optionalStringField(ctx, path, raw, field),
  };
}

// [LAW:dataflow-not-control-flow] An optional boolean field: present-and-valid
// is included, present-and-wrong reports an issue and omits, absent omits
// silently — the boolean twin of `optionalStringSpec`.
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

// [LAW:dataflow-not-control-flow] An optional bounded-integer field: the bounds
// are DATA feeding both interpreters — `parse` checks them and interpolates them
// into the one message, `json` emits them as minimum/maximum — so the validator
// and the editor-facing schema cannot describe different ranges.
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

// [LAW:dataflow-not-control-flow] An optional finite-number field: the optional
// lower bound is DATA feeding both interpreters — `parse` checks it and
// interpolates it into the one message, `json` emits it as `minimum` — so the
// validator and the editor-facing schema cannot describe different ranges.
// Finite matters: JSON5 admits `NaN`/`Infinity` literals, and a non-finite axis
// would corrupt every OKLCH channel it touches downstream.
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

// [LAW:single-enforcer] The palette field defers to the one palette-name
// authority; the field key is conventionally "palette", which validatePaletteName
// reads directly.
export function paletteSpec(): FieldSpec<string> {
  return {
    required: false,
    // Palette NAME membership is semantic (the allowed set is resolved at load
    // from installed palettes, not a closed compile-time enum), so the schema
    // checks only `type: string` — the same shape/meaning split the loader keeps.
    json: { type: "string" },
    parse: (ctx, path, _field, raw) => validatePaletteName(ctx, path, raw),
  };
}

// [LAW:dataflow-not-control-flow] A required string field: present-and-valid is
// included, present-and-wrong reports an issue and fails the record, absent fails
// the record — the map key names the field, so one spec serves path/command/
// layout/name/key. `requireString` returns null on failure; the record engine
// reads undefined as "absent or invalid", so null collapses to undefined.
export function requireStringSpec(): FieldSpec<string> {
  return {
    required: true,
    json: { type: "string" },
    parse: (ctx, path, field, raw) =>
      requireString(ctx, path, raw, field) ?? undefined,
  };
}

// [LAW:dataflow-not-control-flow] An optional enum field over a closed set; the
// allowed values are DATA, the field key comes from the map. Present-and-invalid
// reports the one-of message and omits; absent omits silently.
export function optionalEnumSpec<T extends string>(
  allowed: readonly T[],
): FieldSpec<T> {
  return {
    required: false,
    // [LAW:one-source-of-truth] `allowed` is the single source: `parse` checks
    // membership against it, `json` lists it as the schema `enum`.
    json: { enum: [...allowed] },
    parse: (ctx, path, field, raw) =>
      optionalEnum(ctx, path, raw, field, allowed),
  };
}

// ─── Schema emit: the second interpreter over the same declarations ──────────

// [LAW:dataflow-not-control-flow] The record/field emit-twin of `fields`: walk
// the SAME field-map the validator walks, projecting each spec's `json` into a
// JSON-Schema `properties` map and collecting the required field names. The
// caller chooses whether unknown keys are forbidden — a `record` forbids them
// (additionalProperties:false), a tagged-union arm allows the sibling
// discriminator. The structure is the declaration; emit is mechanical.
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

// [LAW:one-source-of-truth] The emit-twin of `record`: a closed object schema
// over the schema's fields — the same shape `record` enforces at runtime.
export function recordJson<T>(schema: RecordSchema<T>): JsonNode {
  return objectJson(schema.fields);
}

// [LAW:dataflow-not-control-flow] Merge a discriminator constant into an object
// schema: add `{ [tag]: { const } }` to its properties and `tag` to required.
// An arm bakes this in so taggedUnionJson can collect arms verbatim.
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

// [LAW:one-source-of-truth] The emit-twin of `taggedUnion`: each arm already
// carries its full member schema (discriminator baked in), so the union is just
// the `anyOf` of arm schemas — the same disjoint set the dispatcher selects from.
export function taggedUnionJson<T, K extends string>(
  schema: TaggedUnionSchema<T, K>,
): JsonNode {
  const arms = schema.arms as Readonly<Record<string, TaggedArm<T>>>;
  return { anyOf: Object.values(arms).map((arm) => arm.json) };
}

// [LAW:one-source-of-truth] The emit-twin of `oneOfPresent`: each member is the
// closed single-key object the present-key contract describes (exactly that key
// required, no others) — the `anyOf` of those is the tag-by-present-key shape.
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

// [LAW:types-are-the-program] The variable schema: a VariableDecl is discriminated
// by `kind` (literal / input / env / file / shell / template / time / git / state),
// declared as DATA (VARIABLE_SCHEMA) and interpreted by the tag-by-field-value
// engine (taggedUnion). Each arm is a `fields` schema over its member's non-`kind`
// fields, except `input`, whose `default` must match its `type` — a genuine
// cross-field invariant carried as a closure. This file changes when a source
// kind's shape changes; adding a kind is one new arm here plus its runtime impl.

import {
  GIT_FIELDS,
  type GitField,
  type ParseDecl,
  type SourceDefault,
  type EnvVarDecl,
  type FileVarDecl,
  type InputVarDecl,
  type GitVarDecl,
  type LiteralVarDecl,
  type ShellVarDecl,
  type StateVarDecl,
  type TemplateVarDecl,
  type TimeVarDecl,
  type VariableDecl,
} from "../dsl-types.js";
import type { JsonValue } from "../../var-system/types.js";
import { findKeyLine } from "./diagnostics.js";
import {
  describeType,
  describeValue,
  fields,
  isPlainObject,
  objectJson,
  oneOfPresent,
  oneOfPresentJson,
  optionalStringField,
  optionalStringSpec,
  optionalTypedDefault,
  reject,
  requireStringSpec,
  optionalEnumSpec,
  taggedUnion,
  taggedUnionJson,
  withConst,
  type FieldSpec,
  type FieldSpecMap,
  type JsonNode,
  type OneOfPresentSchema,
  type TaggedArm,
  type TaggedUnionSchema,
  type ValidateCtx,
} from "./validate-core.js";
import {
  optionalCacheSpec,
  requireCacheSpec,
  ttlOnlyCacheSpec,
} from "./cache.js";

export function validateVariables(
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
    const parsed = taggedUnion(
      ctx,
      VARIABLE_SCHEMA,
      `${pathPrefix}.${name}`,
      decl,
    );
    if (parsed !== null) out[name] = parsed;
  }
  return out;
}

// [LAW:types-are-the-program] `value` is a required union literal with a bespoke
// message whose line points at the variable (not `.value`) — a custom spec, since
// the generic string/enum specs encode different line behavior.
function literalValueSpec(): FieldSpec<string | number | boolean> {
  return {
    required: true,
    json: { type: ["string", "number", "boolean"] },
    parse: (ctx, path, _field, raw) => {
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
        return undefined;
      }
      return value;
    },
  };
}

// [LAW:types-are-the-program] `field` is a required member of the closed GitField
// set with a bespoke one-of message — a custom spec for the same reason.
function gitFieldSpec(): FieldSpec<GitField> {
  return {
    required: true,
    json: { enum: [...GIT_FIELDS] },
    parse: (ctx, path, _field, raw) => {
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
        return undefined;
      }
      return field as GitField;
    },
  };
}

// [LAW:types-are-the-program] `input`'s `default` carries the cross-field
// invariant — it must match the declared `type` (an absent or invalid `type`
// defaults the check to "string"). A field spec receives the WHOLE record, so it
// reads its sibling `raw.type` to pick the expected type WITHOUT re-reporting a
// bad type (the `type` field spec owns that error — reading raw here avoids the
// duplicate issue). This is what lets `input` derive BOTH `parse` and `json` from
// one field map via `arm()`, like every other arm — closing the last spot where
// the two interpreters were authored independently [LAW:one-source-of-truth].
function inputDefaultSpec(): FieldSpec<string | number | boolean> {
  return {
    required: false,
    json: { type: ["string", "number", "boolean"] },
    parse: (ctx, path, _field, raw) => {
      const t = raw.type;
      const expected =
        t === "number" || t === "boolean" || t === "string" ? t : "string";
      return optionalTypedDefault(ctx, path, raw, expected);
    },
  };
}

// [LAW:types-are-the-program] The parse-step schema as DATA, through the same
// tag-by-present-key engine `cache:` runs through: text/json are flags whose
// value is the literal true (like cache.never); regex is a pattern string. The
// pattern is proven here — it compiles, and it has the capture group the
// runtime reads (group 1 IS the value, so a groupless pattern could only ever
// "not match") — while the decl keeps the SOURCE string: DslConfig is
// serializable data, and declareOne (src/dsl/render.ts) compiles the RegExp the
// runtime runs. Past this point a pattern is one `new RegExp` cannot throw on.
const PARSE_SCHEMA: OneOfPresentSchema<ParseDecl> = {
  noun: "parse",
  arms: {
    text: {
      json: { const: true },
      parse: (ctx, path, value) =>
        value === true
          ? { text: true }
          : reject(
              ctx,
              path,
              `parse.text must be the literal boolean true, got ${describeValue(value)}`,
            ),
    },
    regex: {
      json: { type: "string" },
      parse: (ctx, path, value) =>
        typeof value === "string"
          ? capturingPattern(ctx, path, value)
          : reject(
              ctx,
              path,
              `parse.regex must be a pattern string, got ${describeValue(value)}`,
            ),
    },
    json: {
      json: { const: true },
      parse: (ctx, path, value) =>
        value === true
          ? { json: true }
          : reject(
              ctx,
              path,
              `parse.json must be the literal boolean true, got ${describeValue(value)}`,
            ),
    },
  },
};

function capturingPattern(
  ctx: ValidateCtx,
  path: string,
  pattern: string,
): { regex: string } | null {
  let groups: number;
  try {
    // The compile proof is the pattern ALONE (`(a)\\` does not compile, but
    // `(a)\\|` does — the backslash would escape the alternation). Then the
    // standard group count: a compiling pattern alternated with the empty
    // pattern always matches, and every group is a (non-participating) slot.
    new RegExp(pattern);
    groups = new RegExp(`${pattern}|`).exec("")!.length - 1;
  } catch (e) {
    return reject(
      ctx,
      path,
      `parse.regex is not a valid regular expression: ${(e as Error).message}`,
    );
  }
  return groups >= 1
    ? { regex: pattern }
    : reject(
        ctx,
        path,
        `parse.regex must contain a capture group — its group 1 is the value; got ${JSON.stringify(pattern)}`,
      );
}

// [LAW:one-source-of-truth] The `parse` field: absent means the text arm, and
// that default is spelled ONCE, in declareOne's lowering — the decl records
// what the author wrote. The retired top-level `regex:` is reported HERE
// because a variable arm's field map ignores keys it does not declare: an old
// config would otherwise load with its regex silently dropped
// [LAW:no-silent-failure].
function parseSpec(): FieldSpec<ParseDecl> {
  return {
    required: false,
    json: oneOfPresentJson(PARSE_SCHEMA),
    parse: (ctx, path, _field, raw) => {
      if (raw.regex !== undefined) {
        ctx.issues.push({
          path: `${path}.regex`,
          message: `${path}.regex was retired; the regex is the parse step's regex arm now: parse: { regex: ${JSON.stringify(raw.regex)} }`,
          line: findKeyLine(ctx.source, [...path.split("."), "regex"]),
        });
      }
      return raw.parse === undefined
        ? undefined
        : (oneOfPresent(ctx, PARSE_SCHEMA, `${path}.parse`, raw.parse) ??
            undefined);
    },
  };
}

// [LAW:types-are-the-program] A source's `default` lives in its parser's
// OUTPUT domain — a string for the text/regex arms, any JSON value for the
// json arm — so this spec reads its sibling `raw.parse` to pick the domain,
// the way inputDefaultSpec reads `raw.type`. This is THE enforcer of the
// arm↔default pairing: FileVarDecl/ShellVarDecl type `default` as the union
// of both domains and declareOne's lowering trusts the stamp. The sibling's
// own errors are parseSpec's to report: the json domain is the json key
// PRESENT on the raw `parse:` — the tag of that present-key union — never a
// fallthrough over keys it does not recognise.
function sourceDefaultSpec(): FieldSpec<SourceDefault> {
  return {
    required: false,
    json: {
      type: ["string", "number", "boolean", "array", "object"],
      description:
        "The value published when the source fails: a string under the text/regex parse arms, any non-null JSON value under the json arm",
    },
    parse: (ctx, path, _field, raw) =>
      isPlainObject(raw.parse) && "json" in raw.parse
        ? jsonDefault(ctx, path, raw.default)
        : optionalStringField(ctx, path, raw, "default"),
  };
}

function jsonDefault(
  ctx: ValidateCtx,
  path: string,
  value: unknown,
): SourceDefault | undefined {
  if (value === undefined) return undefined;
  return isSourceDefault(value)
    ? value
    : (reject<SourceDefault>(
        ctx,
        `${path}.default`,
        `${path}.default must be a JSON value (a json-parsed source's document), got ${describeValue(value)}`,
      ) ?? undefined);
}

// [LAW:parse-dont-validate] The stamp for the json arm's default: a config
// file's values are JSON-shaped by construction (JSON5 admits Infinity/NaN,
// which JSON does not), a programmatic config's are whatever TS let through.
function isSourceDefault(value: unknown): value is SourceDefault {
  return value !== null && isJsonValue(value);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) return true;
  switch (typeof value) {
    case "string":
    case "boolean":
      return true;
    case "number":
      return Number.isFinite(value);
    case "object": {
      if (Array.isArray(value)) return value.every(isJsonValue);
      const proto: unknown = Object.getPrototypeOf(value);
      return (
        (proto === Object.prototype || proto === null) &&
        Object.values(value as Record<string, unknown>).every(isJsonValue)
      );
    }
    default:
      return false;
  }
}

// [LAW:dataflow-not-control-flow] Each arm's field set is DATA over the member's
// non-`kind` fields; the engine supplies the discriminator. `fields` runs every
// spec (reporting all issues) and fails the arm when a required field is absent
// or invalid — the conditional-spread + result-threading the old switch hand-rolled.
const LITERAL_FIELDS: FieldSpecMap<Omit<LiteralVarDecl, "kind">> = {
  value: literalValueSpec(),
  default: optionalStringSpec(),
};
const INPUT_FIELDS: FieldSpecMap<Omit<InputVarDecl, "kind">> = {
  path: requireStringSpec(),
  type: optionalEnumSpec(["string", "number", "boolean"] as const),
  default: inputDefaultSpec(),
};
const ENV_FIELDS: FieldSpecMap<Omit<EnvVarDecl, "kind">> = {
  name: requireStringSpec(),
  default: optionalStringSpec(),
};
const FILE_FIELDS: FieldSpecMap<Omit<FileVarDecl, "kind">> = {
  path: requireStringSpec(),
  readMode: optionalEnumSpec(["whole", "first-line"] as const),
  parse: parseSpec(),
  cache: requireCacheSpec("file"),
  default: sourceDefaultSpec(),
};
const SHELL_FIELDS: FieldSpecMap<Omit<ShellVarDecl, "kind">> = {
  command: requireStringSpec(),
  parse: parseSpec(),
  cache: requireCacheSpec("shell"),
  default: sourceDefaultSpec(),
};
const TEMPLATE_FIELDS: FieldSpecMap<Omit<TemplateVarDecl, "kind">> = {
  template: requireStringSpec(),
  cache: optionalCacheSpec(),
  default: optionalStringSpec(),
};
const TIME_FIELDS: FieldSpecMap<Omit<TimeVarDecl, "kind">> = {
  layout: requireStringSpec(),
  // [LAW:no-silent-failure] ttl-only: the runtime honors no other invalidation
  // on a clock-driven var, so the loader rejects what it would otherwise have
  // had to silently coerce.
  cache: ttlOnlyCacheSpec(),
  default: optionalStringSpec(),
};
const GIT_VAR_FIELDS: FieldSpecMap<Omit<GitVarDecl, "kind">> = {
  field: gitFieldSpec(),
  cache: requireCacheSpec("git"),
  default: optionalStringSpec(),
};
const STATE_FIELDS: FieldSpecMap<Omit<StateVarDecl, "kind">> = {
  key: requireStringSpec(),
  default: optionalStringSpec(),
};

// [LAW:decomposition] A regular arm parses its non-`kind` fields via `fields` and
// re-attaches the tag the engine already validated; null threading is preserved.
function arm<
  K extends VariableDecl["kind"],
  M extends Omit<Extract<VariableDecl, { kind: K }>, "kind">,
>(
  kind: K,
  fieldMap: FieldSpecMap<M>,
): TaggedArm<Extract<VariableDecl, { kind: K }>> {
  return {
    // [LAW:one-source-of-truth] The arm's emit facet: the member object schema
    // with its `kind` discriminator baked in — `objectJson` over the SAME field
    // map `fields` validates, plus `{ kind: { const } }`. taggedUnionJson collects
    // these verbatim into the union's anyOf.
    json: withConst(objectJson(fieldMap), "kind", kind),
    parse: (ctx: ValidateCtx, path: string, raw: Record<string, unknown>) => {
      const body = fields(ctx, fieldMap, path, raw);
      // [LAW:types-are-the-program] `fieldMap: FieldSpecMap<M>` is checked against
      // the member's non-`kind` fields at each call site, so {kind, ...body} IS the
      // member; TS can't relate the reconstruction to the distributed Extract for a
      // generic K, hence the cast — the call-site check carries the real guarantee.
      return body === null
        ? null
        : ({ kind, ...body } as unknown as Extract<VariableDecl, { kind: K }>);
    },
  };
}

const VARIABLE_SCHEMA: TaggedUnionSchema<VariableDecl, "kind"> = {
  tag: "kind",
  noun: "source kind",
  arms: {
    literal: arm("literal", LITERAL_FIELDS),
    // [LAW:one-source-of-truth] `input`'s `default`/`type` cross-field invariant
    // lives in `inputDefaultSpec` (a field spec reading its sibling), so `input`
    // is one field map like every other arm — `arm()` derives both `parse` and
    // `json` from INPUT_FIELDS, no hand-authored schema to keep in sync.
    input: arm("input", INPUT_FIELDS),
    env: arm("env", ENV_FIELDS),
    file: arm("file", FILE_FIELDS),
    shell: arm("shell", SHELL_FIELDS),
    template: arm("template", TEMPLATE_FIELDS),
    time: arm("time", TIME_FIELDS),
    git: arm("git", GIT_VAR_FIELDS),
    state: arm("state", STATE_FIELDS),
  },
};

// [LAW:one-source-of-truth] One VariableDecl's schema, derived from the SAME
// VARIABLE_SCHEMA the validator interprets — the tag-by-kind anyOf.
export function variableDeclJson(): JsonNode {
  return taggedUnionJson(VARIABLE_SCHEMA);
}

// [LAW:one-source-of-truth] The `variables` block (and a segment's nested `vars`)
// is a name → VariableDecl map; both surfaces emit this one shape, symmetric to
// both calling `validateVariables`.
export function variablesMapJson(): JsonNode {
  return { type: "object", additionalProperties: variableDeclJson() };
}

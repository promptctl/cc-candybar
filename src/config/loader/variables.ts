// [LAW:types-are-the-program] Adding a source kind is one new arm here plus its runtime impl.

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

// [LAW:types-are-the-program] A bespoke message whose line points at the variable, not `.value`.
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

// [LAW:types-are-the-program] A bespoke one-of message, for the same reason.
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

// [LAW:types-are-the-program] A spec receives the WHOLE record, so this reads sibling `raw.type`.
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

// [LAW:types-are-the-program] A pattern is proven here, but the decl keeps the SOURCE string.
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
    // Compile the pattern ALONE, then count groups: alternated with empty it always
    // matches, and every group is a non-participating slot.
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

// [LAW:no-silent-failure] The retired top-level `regex:` is reported here because an arm's field map ignores undeclared keys.
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

// [LAW:types-are-the-program] THE enforcer of the arm↔default pairing: a `default` lives in its parser's OUTPUT domain.
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

// [LAW:parse-dont-validate] JSON5 admits Infinity/NaN, which JSON does not.
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

// [LAW:dataflow-not-control-flow] Each arm's field set is DATA; the engine supplies the tag.
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
  // [LAW:no-silent-failure] ttl-only: a clock-driven var honors no other invalidation.
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

function arm<
  K extends VariableDecl["kind"],
  M extends Omit<Extract<VariableDecl, { kind: K }>, "kind">,
>(
  kind: K,
  fieldMap: FieldSpecMap<M>,
): TaggedArm<Extract<VariableDecl, { kind: K }>> {
  return {
    json: withConst(objectJson(fieldMap), "kind", kind),
    parse: (ctx: ValidateCtx, path: string, raw: Record<string, unknown>) => {
      const body = fields(ctx, fieldMap, path, raw);
      // [LAW:types-are-the-program] The call-site FieldSpecMap<M> check carries the guarantee TS cannot relate through a generic K, hence the cast.
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

// [LAW:one-source-of-truth] Derived from the SAME VARIABLE_SCHEMA the validator interprets.
export function variableDeclJson(): JsonNode {
  return taggedUnionJson(VARIABLE_SCHEMA);
}

export function variablesMapJson(): JsonNode {
  return { type: "object", additionalProperties: variableDeclJson() };
}

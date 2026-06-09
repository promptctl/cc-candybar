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
  type EnvVarDecl,
  type FileVarDecl,
  type GitVarDecl,
  type LiteralVarDecl,
  type ShellVarDecl,
  type StateVarDecl,
  type TemplateVarDecl,
  type TimeVarDecl,
  type VariableDecl,
} from "../dsl-types.js";
import { findKeyLine } from "./diagnostics.js";
import {
  describeType,
  fields,
  isPlainObject,
  optionalEnum,
  optionalStringSpec,
  optionalTypedDefault,
  requireString,
  requireStringSpec,
  optionalEnumSpec,
  taggedUnion,
  type FieldSpec,
  type FieldSpecMap,
  type TaggedUnionSchema,
  type ValidateCtx,
} from "./validate-core.js";
import { optionalCacheSpec, requireCacheSpec } from "./cache.js";

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

// [LAW:dataflow-not-control-flow] Each arm's field set is DATA over the member's
// non-`kind` fields; the engine supplies the discriminator. `fields` runs every
// spec (reporting all issues) and fails the arm when a required field is absent
// or invalid — the conditional-spread + result-threading the old switch hand-rolled.
const LITERAL_FIELDS: FieldSpecMap<Omit<LiteralVarDecl, "kind">> = {
  value: literalValueSpec(),
  default: optionalStringSpec(),
};
const ENV_FIELDS: FieldSpecMap<Omit<EnvVarDecl, "kind">> = {
  name: requireStringSpec(),
  default: optionalStringSpec(),
};
const FILE_FIELDS: FieldSpecMap<Omit<FileVarDecl, "kind">> = {
  path: requireStringSpec(),
  readMode: optionalEnumSpec(["whole", "first-line"] as const),
  regex: optionalStringSpec(),
  cache: requireCacheSpec("file"),
  default: optionalStringSpec(),
};
const SHELL_FIELDS: FieldSpecMap<Omit<ShellVarDecl, "kind">> = {
  command: requireStringSpec(),
  regex: optionalStringSpec(),
  cache: requireCacheSpec("shell"),
  default: optionalStringSpec(),
};
const TEMPLATE_FIELDS: FieldSpecMap<Omit<TemplateVarDecl, "kind">> = {
  template: requireStringSpec(),
  cache: optionalCacheSpec(),
  default: optionalStringSpec(),
};
const TIME_FIELDS: FieldSpecMap<Omit<TimeVarDecl, "kind">> = {
  layout: requireStringSpec(),
  cache: optionalCacheSpec(),
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
>(kind: K, fieldMap: FieldSpecMap<M>) {
  return {
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
    // [LAW:types-are-the-program] `input`'s `default` must match its declared
    // `type` (absent `type` defaults to "string"), so `default` cannot be an
    // independent field spec — the cross-field invariant lives in this closure.
    input: {
      parse: (ctx, path, raw) => {
        const p = requireString(ctx, path, raw, "path");
        if (p === null) return null;
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
      },
    },
    env: arm("env", ENV_FIELDS),
    file: arm("file", FILE_FIELDS),
    shell: arm("shell", SHELL_FIELDS),
    template: arm("template", TEMPLATE_FIELDS),
    time: arm("time", TIME_FIELDS),
    git: arm("git", GIT_VAR_FIELDS),
    state: arm("state", STATE_FIELDS),
  },
};

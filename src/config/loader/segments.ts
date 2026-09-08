// [LAW:types-are-the-program] The segment schema as DATA, interpreted by the generic `record` engine.

import {
  JUSTIFY_MODES,
  TRUNCATE_MODES,
  type SegmentDecl,
  type VariableDecl,
} from "../dsl-types.js";
import { findKeyLine } from "./diagnostics.js";
import {
  describeType,
  describeValue,
  isPlainObject,
  optionalEnumSpec,
  optionalStringSpec,
  paletteSpec,
  record,
  recordJson,
  requireStringSpec,
  type FieldSpec,
  type FieldSpecMap,
  type JsonNode,
  type RecordSchema,
  type ValidateCtx,
} from "./validate-core.js";
import { validateVariables, variablesMapJson } from "./variables.js";

export function validateSegments(
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
    const parsed = record(ctx, SEGMENT_SCHEMA, `segments.${name}`, decl);
    if (parsed !== null) out[name] = parsed;
  }
  return out;
}

// [LAW:types-are-the-program] `width` is a union the generic specs cannot express, so it carries its own parse as DATA.
function widthSpec(): FieldSpec<"auto" | number> {
  return {
    required: false,
    json: { anyOf: [{ const: "auto" }, { type: "integer", minimum: 1 }] },
    parse: (ctx, path, field, raw) => {
      const v = raw[field];
      if (v === undefined) return undefined;
      if (v === "auto") return "auto";
      if (typeof v === "number" && Number.isInteger(v) && v > 0) return v;
      ctx.issues.push({
        path: `${path}.${field}`,
        message: `width must be "auto" or a positive integer, got ${describeValue(v)}`,
        line: findKeyLine(ctx.source, [...path.split("."), field]),
      });
      return undefined;
    },
  };
}

// [LAW:decomposition] The nested `vars` block defers to the variable schema — reuse, not a new combinator.
function varsSpec(): FieldSpec<Readonly<Record<string, VariableDecl>>> {
  return {
    required: false,
    json: variablesMapJson(),
    parse: (ctx, path, field, raw) => {
      const v = raw[field];
      if (v === undefined) return undefined;
      return validateVariables(ctx, `${path}.${field}`, v);
    },
  };
}

// [LAW:dataflow-not-control-flow] The segment's shape as DATA over its fields, in declaration order.
const SEGMENT_FIELDS: FieldSpecMap<SegmentDecl> = {
  template: requireStringSpec(),
  width: widthSpec(),
  justify: optionalEnumSpec(JUSTIFY_MODES),
  truncate: optionalEnumSpec(TRUNCATE_MODES),
  bg: optionalStringSpec(),
  fg: optionalStringSpec(),
  when: optionalStringSpec(),
  palette: paletteSpec(),
  vars: varsSpec(),
};

const SEGMENT_SCHEMA: RecordSchema<SegmentDecl> = {
  noun: "segment key",
  fields: SEGMENT_FIELDS,
};

export function segmentsJson(): JsonNode {
  return { type: "object", additionalProperties: recordJson(SEGMENT_SCHEMA) };
}

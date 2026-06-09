// [LAW:types-are-the-program] The segment schema: a required `template` plus
// optional layout/paint/visibility fields and a nested `vars` block (validated by
// the variable schema). Declared as DATA (SEGMENT_SCHEMA) and interpreted by the
// generic `record` engine — a plain record with no cross-field invariant, so two
// value-shaped fields (`width`, `vars`) carry their bespoke parse as field specs.
// This file changes when a segment field is added or removed.

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
  requireStringSpec,
  type FieldSpec,
  type FieldSpecMap,
  type RecordSchema,
  type ValidateCtx,
} from "./validate-core.js";
import { validateVariables } from "./variables.js";

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

// [LAW:types-are-the-program] `width` is `"auto"` or a positive integer — a union
// the generic string/enum specs cannot express, so it carries its own parse and
// bespoke message as DATA. Absent → omitted; present-and-wrong → issue + omitted.
function widthSpec(): FieldSpec<"auto" | number> {
  return {
    required: false,
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

// [LAW:decomposition] The nested `vars` block defers to the variable schema —
// recursion by reuse of the already-migrated per-name taggedUnion, not a new
// combinator. Absent → omitted; present → the parsed map (possibly empty, with
// its own issues already reported), mirroring the old `if (raw.vars !== undefined)`.
function varsSpec(): FieldSpec<Readonly<Record<string, VariableDecl>>> {
  return {
    required: false,
    parse: (ctx, path, field, raw) => {
      const v = raw[field];
      if (v === undefined) return undefined;
      return validateVariables(ctx, `${path}.${field}`, v);
    },
  };
}

// [LAW:dataflow-not-control-flow] The segment's shape as DATA over its fields, in
// declaration order. The engine runs every spec, rejects unknown keys, and fails
// the segment when `template` is absent or invalid — the isPlainObject guard,
// unknown-key loop, result-threading, and optional-omission the old body hand-rolled.
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

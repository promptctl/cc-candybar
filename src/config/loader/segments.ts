// [LAW:types-are-the-program] The segment schema: a `template` plus optional
// layout/paint/visibility fields and a nested `vars` block (validated by the
// variable schema). Declared as DATA and interpreted by the generic `record`
// engine — a plain record with no cross-field invariant, so two value-shaped
// fields (`width`, `vars`) carry their bespoke parse as field specs. Two
// records over one field table: a DECLARATION, whose template is required,
// and a DELTA over a bundled declaration of the same name, whose template is
// the one field it may omit (RawSegmentDecl). Which record a name parses
// against is the name's membership in `inherited` — the base's own segment
// names, handed in by the caller that knows the base (loadConfig derives it
// from the default it merges against; the schema emitter from the bundled
// default) [LAW:single-enforcer]. This file changes when a segment field is
// added or removed.

import {
  JUSTIFY_MODES,
  TRUNCATE_MODES,
  type DslConfig,
  type RawSegmentDecl,
  type SegmentDecl,
  type VariableDecl,
} from "../dsl-types.js";
import { findKeyLine } from "./diagnostics.js";
import { isReservedName } from "./reserved-namespace.js";
import {
  describeType,
  describeValue,
  isPlainObject,
  optionalEnumSpec,
  optionalStringSpec,
  paletteSpec,
  record,
  recordJson,
  reject,
  requireString,
  type FieldSpec,
  type FieldSpecMap,
  type JsonNode,
  type RecordSchema,
  type ValidateCtx,
} from "./validate-core.js";
import { validateVariables, variablesMapJson } from "./variables.js";

// [LAW:one-source-of-truth] The names a file may declare as a delta: the
// base's segments a user could AUTHOR — its synthesized ones (a bundled
// group's toggle) live under a reserved namespace the loader rejects outright,
// so naming them here would publish a delta target no file can write. Spelled
// once for loadConfig, the schema emitter, and the test helper that mirrors
// loadConfig, so the loader's acceptance and the published schema's cannot
// name different sets.
export function inheritableSegmentNames(
  base: Pick<DslConfig, "segments">,
): ReadonlySet<string> {
  return new Set(
    Object.keys(base.segments).filter((name) => !isReservedName(name)),
  );
}

export function validateSegments(
  ctx: ValidateCtx,
  raw: unknown,
  inherited: ReadonlySet<string>,
): Record<string, RawSegmentDecl> {
  if (raw === undefined) return {};
  if (!isPlainObject(raw)) {
    ctx.issues.push({
      path: "segments",
      message: `segments must be an object, got ${describeType(raw)}`,
      line: findKeyLine(ctx.source, ["segments"]),
    });
    return {};
  }

  const out: Record<string, RawSegmentDecl> = {};
  for (const [name, decl] of Object.entries(raw)) {
    // [LAW:dataflow-not-control-flow] The one branch is the domain's own
    // discriminator — is this name a delta over a base declaration? — and
    // it selects DATA (which record), not which operations run.
    const parsed = record(
      ctx,
      inherited.has(name) ? SEGMENT_DELTA_SCHEMA : SEGMENT_SCHEMA,
      `segments.${name}`,
      decl,
    );
    if (parsed !== null) out[name] = parsed;
  }
  return out;
}

// [LAW:no-silent-failure] A declaration under a name no base carries must
// bring its own template. The message states the one way an absent template
// is legal, so an author who meant a delta learns which name they misspelled
// rather than reading "must be a string" over a field they never meant to
// write.
function ownTemplateSpec(): FieldSpec<string> {
  return {
    required: true,
    json: { type: "string" },
    parse: (ctx, path, field, raw) =>
      raw[field] === undefined
        ? (reject<string>(
            ctx,
            `${path}.${field}`,
            `${path} declares no template — only a segment the bundled default declares may omit it (inheriting the bundled template); a segment of your own needs its own`,
          ) ?? undefined)
        : (requireString(ctx, path, raw, field) ?? undefined),
  };
}

// [LAW:types-are-the-program] `width` is `"auto"`, `"fill"`, or a positive
// integer — a union the generic string/enum specs cannot express, so it carries
// its own parse and bespoke message as DATA. Absent → omitted;
// present-and-wrong → issue + omitted.
function widthSpec(): FieldSpec<"auto" | number | "fill"> {
  return {
    required: false,
    json: {
      anyOf: [
        { const: "auto" },
        { const: "fill" },
        { type: "integer", minimum: 1 },
      ],
    },
    parse: (ctx, path, field, raw) => {
      const v = raw[field];
      if (v === undefined) return undefined;
      if (v === "auto") return "auto";
      if (v === "fill") return "fill";
      if (typeof v === "number" && Number.isInteger(v) && v > 0) return v;
      ctx.issues.push({
        path: `${path}.${field}`,
        message: `width must be "auto", "fill", or a positive integer, got ${describeValue(v)}`,
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
    // [LAW:one-source-of-truth] The nested `vars` schema is the SAME name →
    // VariableDecl map the top-level `variables` block emits — one source.
    json: variablesMapJson(),
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
  template: ownTemplateSpec(),
  // [LAW:one-source-of-truth] One row is the whole change: this table is what
  // the validator interprets AND what `segmentDefinitions()` emits into the
  // published JSON schema, and SEGMENT_DELTA_SCHEMA reuses it, so a file may
  // set `description` on its own segment or on a delta over a bundled name
  // with no further edit anywhere (brandon-config-schema-qqg).
  description: optionalStringSpec(),
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

// [LAW:one-source-of-truth] The delta is the declaration with ONE field's
// required-ness relaxed — the same table, so a field added to SegmentDecl is
// delta-settable the same day with no edit here.
const SEGMENT_DELTA_SCHEMA: RecordSchema<RawSegmentDecl> = {
  noun: "segment key",
  fields: { ...SEGMENT_FIELDS, template: optionalStringSpec() },
};

export const SEGMENT_DEF_NAME = "Segment";
export const SEGMENT_DELTA_DEF_NAME = "SegmentDelta";
const SEGMENT_REF = `#/definitions/${SEGMENT_DEF_NAME}`;
const SEGMENT_DELTA_REF = `#/definitions/${SEGMENT_DELTA_DEF_NAME}`;

// [LAW:one-source-of-truth] The two record shapes as schema definitions,
// derived from the SAME tables the validator interprets.
export function segmentDefinitions(): Readonly<Record<string, JsonNode>> {
  return {
    [SEGMENT_DEF_NAME]: recordJson(SEGMENT_SCHEMA),
    [SEGMENT_DELTA_DEF_NAME]: recordJson(SEGMENT_DELTA_SCHEMA),
  };
}

// [LAW:one-source-of-truth] The `segments` block, as the validator reads it:
// a name the base carries accepts a delta, any other name a full declaration.
// The emitter spells the same membership the parse consults, so an editor
// completes `directory: { palette }` and flags `mine: { palette }` exactly
// where the loader would.
export function segmentsJson(inherited: ReadonlySet<string>): JsonNode {
  return {
    type: "object",
    properties: Object.fromEntries(
      [...inherited].map((name) => [name, { $ref: SEGMENT_DELTA_REF }]),
    ),
    additionalProperties: { $ref: SEGMENT_REF },
  };
}

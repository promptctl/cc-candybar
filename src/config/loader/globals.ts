// [LAW:types-are-the-program] The globals schema declared as DATA and interpreted by the record engine: add a key to GLOBALS_SCHEMA and Globals, the engine does the rest.

import { type Globals } from "../dsl-types.js";
import {
  CHARSETS,
  COLOR_COMPATIBILITIES,
  DEFAULT_PADDING,
  PADDING_RANGE,
  STRIP_STYLES,
  type ColorCompatibility,
} from "../../themes/policy.js";
import {
  optionalBooleanSpec,
  optionalEnum,
  optionalEnumSpec,
  optionalIntSpec,
  optionalStringSpec,
  paletteSpec,
  record,
  recordJson,
  type FieldSpec,
  type FieldSpecMap,
  type JsonNode,
  type RecordSchema,
  type ValidateCtx,
} from "./validate-core.js";
import { findKeyLine } from "./diagnostics.js";

// [LAW:no-silent-failure] Closed enum plus one migration-pointing rejection:
// "auto" is outside the domain because the detached daemon would detect its own terminal, not the client's.
const colorCompatibilitySpec: FieldSpec<ColorCompatibility> = {
  required: false,
  json: { enum: [...COLOR_COMPATIBILITIES] },
  parse: (ctx, path, field, raw) => {
    if (raw[field] === "auto") {
      ctx.issues.push({
        path: `${path}.${field}`,
        message:
          `${path}.${field}: "auto" is not supported — the render daemon runs detached, ` +
          `so terminal detection would read the daemon's environment, not your terminal's. ` +
          `Pick an explicit depth: ${COLOR_COMPATIBILITIES.join(", ")}`,
        line: findKeyLine(ctx.source, [...path.split("."), field]),
      });
      return undefined;
    }
    return optionalEnum(ctx, path, raw, field, COLOR_COMPATIBILITIES);
  },
};

// [LAW:one-source-of-truth] THE globals field table: both the top-level and preset-scoped schemas build from it, so there is no second list to grow.
const GLOBALS_FIELDS: FieldSpecMap<Globals> = {
  default_bg: optionalStringSpec(),
  default_fg: optionalStringSpec(),
  default_empty_value: optionalStringSpec(),
  default_separator: optionalStringSpec(),
  default_truncate_marker: optionalStringSpec(),
  palette: paletteSpec(),
  // [LAW:types-are-the-program] Shape only — the look domain is per-config, so membership is a post-merge cross-ref.
  look: optionalStringSpec(),
  preset: optionalStringSpec(),
  style: optionalEnumSpec(STRIP_STYLES),
  autoWrap: optionalBooleanSpec(),
  // [LAW:one-source-of-truth] Bounded by PADDING_RANGE, the same literal the stepper actions and the session parse use, so file/click/session cannot diverge.
  padding: optionalIntSpec(PADDING_RANGE),
  charset: optionalEnumSpec(CHARSETS),
  updateNotice: optionalBooleanSpec(),
  colorCompatibility: colorCompatibilitySpec,
};

const GLOBALS_SCHEMA: RecordSchema<Globals> = {
  noun: "globals key",
  fields: GLOBALS_FIELDS,
};

// [LAW:one-source-of-truth] A globals FRAGMENT may not carry `preset`: which preset
// is active has exactly one authority, and a fragment re-selecting one would be a second.
function nestedPresetSpec(subject: string): FieldSpec<string> {
  return {
    required: false,
    // Always-fail: JSON Schema's `not: {}` matches nothing, so an editor flags it too.
    json: {
      not: {},
      description: `not allowed here — ${subject} cannot select a preset`,
    },
    parse: (ctx, path, field, raw) => {
      if (raw[field] !== undefined) {
        ctx.issues.push({
          path: `${path}.${field}`,
          message:
            `${path}.${field}: ${subject} cannot select a preset. Which preset is active is ` +
            `resolved once, as session pick over globals.preset over "default"; a fragment ` +
            `naming another would be a second authority over that. ` +
            `Set the default arrangement in the top-level globals.preset instead.`,
          line: findKeyLine(ctx.source, [...path.split("."), field]),
        });
      }
      return undefined;
    },
  };
}

// [LAW:one-source-of-truth] The SAME field table with one field swapped, not a hand-listed subset a future globals field could be forgotten from.
const PRESET_GLOBALS_SCHEMA: RecordSchema<Globals> = {
  noun: "preset globals key",
  fields: { ...GLOBALS_FIELDS, preset: nestedPresetSpec("a preset") },
};

// [LAW:one-type-per-behavior] Edit mode's staged globals are the same shape one rung later, so a field added to Globals is edit-settable with no edit here.
const EDIT_GLOBALS_SCHEMA: RecordSchema<Globals> = {
  noun: "editGlobals key",
  fields: {
    ...GLOBALS_FIELDS,
    preset: nestedPresetSpec("the editGlobals fragment"),
  },
};

// [LAW:no-silent-failure] A non-object is a reported error recovering to {}; parseDslConfig throws once any issue exists, so the recovery never renders.
export function validateGlobals(
  ctx: ValidateCtx,
  path: string,
  raw: unknown,
): Globals {
  if (raw === undefined) return {};
  return record(ctx, GLOBALS_SCHEMA, path, raw) ?? {};
}

export function validatePresetGlobals(
  ctx: ValidateCtx,
  path: string,
  raw: unknown,
): Globals {
  return record(ctx, PRESET_GLOBALS_SCHEMA, path, raw) ?? {};
}

// [LAW:one-source-of-truth] The emitter derives from the SAME declaration the validator interprets.
export function globalsJson(): JsonNode {
  return recordJson(GLOBALS_SCHEMA);
}

export function presetGlobalsJson(): JsonNode {
  return recordJson(PRESET_GLOBALS_SCHEMA);
}

export function validateEditGlobals(
  ctx: ValidateCtx,
  path: string,
  raw: unknown,
): Globals {
  return record(ctx, EDIT_GLOBALS_SCHEMA, path, raw) ?? {};
}

export function editGlobalsJson(): JsonNode {
  return recordJson(EDIT_GLOBALS_SCHEMA);
}

// [LAW:one-source-of-truth] THE membership check, derived from the same declaration validateGlobals interprets, so a persist target is checked against exactly the hand-authorable field set.
const GLOBALS_FIELD_NAMES: ReadonlySet<string> = new Set(
  Object.keys(GLOBALS_SCHEMA.fields),
);
export function isGlobalsField(key: string): key is keyof Globals {
  return GLOBALS_FIELD_NAMES.has(key);
}

export function listGlobalsFieldNames(): readonly string[] {
  return [...GLOBALS_FIELD_NAMES];
}

// [LAW:types-are-the-program] Total over the numeric globals fields, so adding one
// without a floor is a COMPILE error, not a silent seed from `min`. The direction
// matters: the mirror form silently drops a field typed as a literal union.
// [LAW:one-way-deps] It lives here, not in themes/policy.ts, because it must name `Globals`.
type NumericGlobalsField = {
  [K in keyof Globals]-?: NonNullable<Globals[K]> extends number ? K : never;
}[keyof Globals];

const NUMERIC_GLOBALS_FLOORS: Readonly<Record<NumericGlobalsField, number>> = {
  padding: DEFAULT_PADDING,
};

// [LAW:single-enforcer] THE seed for a bounded stepper: the config's own value, or the field's floor. Both write gates read it, so a session stepper and its durable twin cannot start from different numbers.
export function numericGlobalsSeeds(
  globals: Globals,
): ReadonlyMap<string, number> {
  const seeds = new Map<string, number>();
  for (const [field, floor] of Object.entries(NUMERIC_GLOBALS_FLOORS)) {
    const declared = globals[field as keyof Globals];
    seeds.set(field, typeof declared === "number" ? declared : floor);
  }
  return seeds;
}

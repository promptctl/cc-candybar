// [LAW:types-are-the-program] The globals schema: a fixed set of string fields
// plus a validated palette name, declared as DATA and interpreted by the record
// engine. This file changes when a global default field is added or removed —
// add a key to GLOBALS_SCHEMA and Globals; the engine does the rest.

import { type Globals } from "../dsl-types.js";
import {
  CHARSETS,
  COLOR_COMPATIBILITIES,
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

// [LAW:types-are-the-program] Closed enum like `charset`, plus one
// migration-pointing rejection: "auto" was the LEGACY default, so migrating
// configs will carry it — but the daemon runs detached, so rich-js env
// detection would downsample against the daemon's terminal, not the client's.
// Rather than ship that silent lie [LAW:no-silent-failure], "auto" is outside
// the ColorCompatibility domain and gets an error that says why (same species
// as the removed-layout migration errors in layout.ts). The json emit and the
// membership check derive from the same COLOR_COMPATIBILITIES literal.
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

// [LAW:one-source-of-truth] THE globals field table, declared once. Both the
// top-level `globals:` schema and the preset-scoped one below are built from
// this map, so a field added here is automatically settable from a preset —
// there is no second list to remember to grow.
const GLOBALS_FIELDS: FieldSpecMap<Globals> = {
    default_bg: optionalStringSpec(),
    default_fg: optionalStringSpec(),
    default_empty_value: optionalStringSpec(),
    default_separator: optionalStringSpec(),
    default_truncate_marker: optionalStringSpec(),
    palette: paletteSpec(),
    // [LAW:types-are-the-program] The config-default LOOK name. Unlike the
    // registry-static palette set, the look domain is per-config (the merged
    // `looks` block), so membership is a cross-ref check on the MERGED config —
    // a user's globals.look may name a default-provided look. Shape-only here,
    // exactly the shape/meaning split paletteSpec's schema facet keeps.
    look: optionalStringSpec(),
    // [LAW:types-are-the-program] The config-default PRESET name — same
    // per-config-domain shape as `look` (membership is a post-merge cross-ref
    // check, since a user's globals.preset may name a default-provided preset).
    preset: optionalStringSpec(),
    // [LAW:types-are-the-program] The strip style is a CLOSED enum (the powerline
    // shapes the joiner can render), unlike the open-ended palette NAME — so it
    // validates by membership and emits a JSON-Schema `enum`.
    style: optionalEnumSpec(STRIP_STYLES),
    autoWrap: optionalBooleanSpec(),
    // Intra-cell spaces per side. Bounded above so a config value can never
    // drive an unbounded `" ".repeat` allocation in the daemon
    // [LAW:no-silent-failure] — an absurd value is a loud load error, not a
    // silently-huge render.
    padding: optionalIntSpec({ min: 0, max: 16 }),
    // [LAW:types-are-the-program] Closed enum like `style`: the joiner glyph
    // vocabularies pickJoiner can render — validates by membership, emits a
    // JSON-Schema `enum` from the same CHARSETS literal.
    charset: optionalEnumSpec(CHARSETS),
    // Closed enum with a bespoke "auto" rejection — see colorCompatibilitySpec.
    colorCompatibility: colorCompatibilitySpec,
};

const GLOBALS_SCHEMA: RecordSchema<Globals> = {
  noun: "globals key",
  fields: GLOBALS_FIELDS,
};

// [LAW:one-source-of-truth] A preset's `globals` may not carry `preset`: which
// preset is active has exactly one authority (session pick over globals.preset
// over the floor), and a preset re-selecting a preset would be a second one —
// a cyclic second one. Same species of bespoke, migration-pointing rejection as
// colorCompatibility's "auto" above, and for the same reason: an author who
// writes it deserves to be told WHY, not handed a bare unknown-key message.
const nestedPresetSpec: FieldSpec<string> = {
  required: false,
  // Always-fail: JSON Schema's `not: {}` matches nothing, so an editor flags
  // the key at the same moment the validator does.
  json: {
    not: {},
    description: "not allowed inside a preset — a preset cannot select a preset",
  },
  parse: (ctx, path, field, raw) => {
    if (raw[field] !== undefined) {
      ctx.issues.push({
        path: `${path}.${field}`,
        message:
          `${path}.${field}: a preset cannot select a preset. Which preset is active is ` +
          `resolved once, as session pick over globals.preset over "default"; a preset ` +
          `naming another would be a second authority over that, and a cyclic one. ` +
          `Set the default arrangement in the top-level globals.preset instead.`,
        line: findKeyLine(ctx.source, [...path.split("."), field]),
      });
    }
    return undefined;
  },
};

// [LAW:one-source-of-truth] The preset-scoped globals schema is the SAME field
// table with exactly one field swapped for its rejection — not a hand-listed
// subset that a future globals field could be forgotten from.
const PRESET_GLOBALS_SCHEMA: RecordSchema<Globals> = {
  noun: "preset globals key",
  fields: { ...GLOBALS_FIELDS, preset: nestedPresetSpec },
};

// An absent globals block is the empty default (no issue); a non-object is a
// reported error that recovers to the empty default, since parseDslConfig throws
// once any issue exists so the recovery value never renders [LAW:no-silent-failure].
// `path` is explicit because the same schema validates the top-level `globals:`
// block and a preset's nested one, and a diagnostic must name where it actually is.
export function validateGlobals(
  ctx: ValidateCtx,
  path: string,
  raw: unknown,
): Globals {
  if (raw === undefined) return {};
  return record(ctx, GLOBALS_SCHEMA, path, raw) ?? {};
}

// The preset-scoped twin: same interpreter, the schema that rejects `preset`.
export function validatePresetGlobals(
  ctx: ValidateCtx,
  path: string,
  raw: unknown,
): Globals {
  return record(ctx, PRESET_GLOBALS_SCHEMA, path, raw) ?? {};
}

// [LAW:one-source-of-truth] The schema emitter derives from the SAME declaration
// the validator interprets — `globals` emit is `recordJson(GLOBALS_SCHEMA)`,
// symmetric to `validateGlobals` calling `record(GLOBALS_SCHEMA)`.
export function globalsJson(): JsonNode {
  return recordJson(GLOBALS_SCHEMA);
}

export function presetGlobalsJson(): JsonNode {
  return recordJson(PRESET_GLOBALS_SCHEMA);
}

// [LAW:one-source-of-truth] THE membership check for "is this a real Globals
// field" — derived from GLOBALS_SCHEMA.fields, the same declaration
// validateGlobals/globalsJson interpret, so a `persist`/`reset` action's
// target key is checked against exactly the field set a hand-authored
// `globals: {...}` block would be. Used by cross-ref.ts (candybar-config-
// engine-71o.2) to catch a typo'd persist target at config-load time instead
// of a confusing click-time "invariant broken" error.
const GLOBALS_FIELD_NAMES: ReadonlySet<string> = new Set(
  Object.keys(GLOBALS_SCHEMA.fields),
);
export function isGlobalsField(key: string): key is keyof Globals {
  return GLOBALS_FIELD_NAMES.has(key);
}

export function listGlobalsFieldNames(): readonly string[] {
  return [...GLOBALS_FIELD_NAMES];
}

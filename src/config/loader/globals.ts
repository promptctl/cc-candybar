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

const GLOBALS_SCHEMA: RecordSchema<Globals> = {
  noun: "globals key",
  fields: {
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
  },
};

// An absent globals block is the empty default (no issue); a non-object is a
// reported error that recovers to the empty default, since parseDslConfig throws
// once any issue exists so the recovery value never renders [LAW:no-silent-failure].
export function validateGlobals(ctx: ValidateCtx, raw: unknown): Globals {
  if (raw === undefined) return {};
  return record(ctx, GLOBALS_SCHEMA, "globals", raw) ?? {};
}

// [LAW:one-source-of-truth] The schema emitter derives from the SAME declaration
// the validator interprets — `globals` emit is `recordJson(GLOBALS_SCHEMA)`,
// symmetric to `validateGlobals` calling `record(GLOBALS_SCHEMA)`.
export function globalsJson(): JsonNode {
  return recordJson(GLOBALS_SCHEMA);
}

// [LAW:types-are-the-program] The globals schema: a fixed set of string fields
// plus a validated palette name, declared as DATA and interpreted by the record
// engine. This file changes when a global default field is added or removed —
// add a key to GLOBALS_SCHEMA and Globals; the engine does the rest.

import { type Globals } from "../dsl-types.js";
import {
  optionalStringSpec,
  paletteSpec,
  record,
  recordJson,
  type JsonNode,
  type RecordSchema,
  type ValidateCtx,
} from "./validate-core.js";

const GLOBALS_SCHEMA: RecordSchema<Globals> = {
  noun: "globals key",
  fields: {
    default_bg: optionalStringSpec(),
    default_fg: optionalStringSpec(),
    default_empty_value: optionalStringSpec(),
    default_separator: optionalStringSpec(),
    default_truncate_marker: optionalStringSpec(),
    palette: paletteSpec(),
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

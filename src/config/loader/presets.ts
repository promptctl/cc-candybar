// [LAW:types-are-the-program] A preset is a config FRAGMENT capped at the two
// sections a render resolves (`root`, `globals`); the record engine enforces the cap.

import {
  describeType,
  isPlainObject,
  record,
  recordJson,
  type FieldSpec,
  type JsonNode,
  type RecordSchema,
  type ValidateCtx,
} from "./validate-core.js";
import { findKeyLine } from "./diagnostics.js";
import { presetGlobalsJson, validatePresetGlobals } from "./globals.js";
import { ROOT_FRAGMENT_REF, validateRootFragment } from "./layout.js";
import type { PresetDecl } from "../dsl-types.js";

// [LAW:one-source-of-truth] A preset's `root` runs through THE layout validator, not a reduced copy.
const presetRootSpec: FieldSpec<NonNullable<PresetDecl["root"]>> = {
  required: false,
  json: { $ref: ROOT_FRAGMENT_REF },
  parse: (ctx, path, field, raw) =>
    raw[field] === undefined
      ? undefined
      : validateRootFragment(ctx, `${path}.${field}`, raw[field]),
};

// [LAW:one-source-of-truth] A preset's `globals` runs through the globals field table, minus `preset` itself.
const presetGlobalsSpec: FieldSpec<NonNullable<PresetDecl["globals"]>> = {
  required: false,
  json: presetGlobalsJson(),
  parse: (ctx, path, field, raw) =>
    raw[field] === undefined
      ? undefined
      : validatePresetGlobals(ctx, `${path}.${field}`, raw[field]),
};

const PRESET_SCHEMA: RecordSchema<PresetDecl> = {
  noun: "preset key",
  fields: { root: presetRootSpec, globals: presetGlobalsSpec },
};

// A non-object recovers to empty; parseDslConfig throws on any issue, so the recovery never renders.
export function validatePresets(
  ctx: ValidateCtx,
  raw: unknown,
): Readonly<Record<string, PresetDecl>> {
  if (!isPlainObject(raw)) {
    ctx.issues.push({
      path: "presets",
      message: `presets must be an object mapping preset names to config fragments, got ${describeType(raw)}`,
      line: findKeyLine(ctx.source, ["presets"]),
    });
    return {};
  }
  const out: Record<string, PresetDecl> = {};
  for (const [name, value] of Object.entries(raw)) {
    // [LAW:no-silent-failure] A preset name is a deliverable set-state value, so its
    // shape is rejected here, on every config load.
    // [LAW:one-source-of-truth] Newlines too: a name is spliced as display text into a
    // synthesized Go-template string literal whose escaper only handles backslash/quote.
    if (name === "" || name.includes("/") || /[\n\r]/.test(name)) {
      ctx.issues.push({
        path: `presets.${name}`,
        message: `preset name ${JSON.stringify(name)} must be non-empty, slash-free, and newline-free — a preset picker writes the name on the set-state wire (which rejects empty values and splits on "/"), and edit mode splices it into a synthesized template string`,
        line: findKeyLine(ctx.source, ["presets", name]),
      });
      continue;
    }
    const parsed = record(ctx, PRESET_SCHEMA, `presets.${name}`, value);
    if (parsed !== null) out[name] = parsed;
  }
  return out;
}

export function presetsJson(): JsonNode {
  return { type: "object", additionalProperties: recordJson(PRESET_SCHEMA) };
}

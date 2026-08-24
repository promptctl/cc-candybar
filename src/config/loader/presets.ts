// [LAW:types-are-the-program] The `presets` schema: each preset is a named
// config FRAGMENT — an alternative arrangement of the bar the user switches to
// — capped at exactly the two sections a render RESOLVES (`root`, `globals`)
// and closed to the sections the daemon REGISTERS once per process
// (`variables`, `segments`, `actions`, `helpers`). The reasoning for that cap
// lives on PresetDecl in dsl-types.ts; enforcing it is this file's job, and the
// record engine enforces it for free — `rejectUnknownKeys` reports any other
// section as a "preset key" error naming the two that are legal.
//
// This file is the structural pass only. Whether a preset's root names a
// segment that exists, and whether globals.preset names a declared preset, are
// CROSS-REFERENCE concerns (loader/cross-ref.ts), because both run on the
// MERGED config — a preset may stage segments the bundled default provides.

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
import { LAYOUT_NODE_REF, validateRoot } from "./layout.js";
import type { PresetDecl } from "../dsl-types.js";

// [LAW:one-source-of-truth] A preset's `root` runs through THE layout validator
// — the same `validateRoot` the top-level `root:` uses, not a reduced copy — so
// the A-grammar, the group sugar, and every migration error read identically
// wherever a layout is authored. Group sugar declared inside a preset therefore
// also lands in `ctx.groups` and synthesizes its state var / cycle action /
// toggle segment into the shared sections, exactly as a top-level group does:
// the synthesized artifacts are process-lifetime (see PresetDecl's cap), the
// preset only chooses whether to stage them.
const presetRootSpec: FieldSpec<NonNullable<PresetDecl["root"]>> = {
  required: false,
  json: { $ref: LAYOUT_NODE_REF },
  parse: (ctx, path, field, raw) =>
    raw[field] === undefined
      ? undefined
      : validateRoot(ctx, `${path}.${field}`, raw[field]),
};

// [LAW:one-source-of-truth] A preset's `globals` runs through the globals field
// table, minus `preset` itself (a preset cannot select a preset — see
// validatePresetGlobals). A field added to Globals is preset-settable the same
// day, with no edit here.
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

// An absent presets block is handled by the caller (absence survives the parse);
// a non-object is a reported error recovering to empty — parseDslConfig throws
// once any issue exists, so the recovery value never renders.
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
    // [LAW:no-silent-failure] A preset name is a deliverable set-state value —
    // a preset picker writes it on the wire, which rejects empty values and
    // splits on "/". Rejecting the shape HERE surfaces the error on every
    // config load, not only once an action ranges the "presets" domain (the
    // identical guard looks.ts applies to look names, for the identical
    // reason).
    if (name === "" || name.includes("/")) {
      ctx.issues.push({
        path: `presets.${name}`,
        message: `preset name ${JSON.stringify(name)} must be non-empty and slash-free — a preset picker writes the name on the set-state wire, which rejects empty values and splits on "/"`,
        line: findKeyLine(ctx.source, ["presets", name]),
      });
      continue;
    }
    const parsed = record(ctx, PRESET_SCHEMA, `presets.${name}`, value);
    if (parsed !== null) out[name] = parsed;
  }
  return out;
}

// [LAW:one-source-of-truth] The schema emitter derives from the SAME declaration
// the validator interprets — a map of preset names to the closed two-section
// fragment object.
export function presetsJson(): JsonNode {
  return { type: "object", additionalProperties: recordJson(PRESET_SCHEMA) };
}

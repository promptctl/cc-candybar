// [LAW:types-are-the-program] A look is a named rich-js ThemeKey — an adaptation composing
// with every theme, and the parsed output IS that ThemeKey [LAW:one-source-of-truth].

import type { ThemeKey } from "@promptctl/rich-js";
import { IDENTITY } from "@promptctl/rich-js";
import {
  describeType,
  isPlainObject,
  optionalNumberSpec,
  record,
  recordJson,
  type JsonNode,
  type RecordSchema,
  type ValidateCtx,
} from "./validate-core.js";
import { findKeyLine } from "./diagnostics.js";

// [LAW:types-are-the-program] The AUTHORING shape: every axis optional, absent = identity.
interface LookSpec {
  readonly hueShift?: number;
  readonly chromaScale?: number;
  readonly lightnessScale?: number;
  readonly lightnessShift?: number;
}

// [LAW:one-source-of-truth] The four axes declared once as DATA, for validation and schema emit.
const LOOK_SCHEMA: RecordSchema<LookSpec> = {
  noun: "look key",
  fields: {
    hueShift: optionalNumberSpec(),
    chromaScale: optionalNumberSpec({ min: 0 }),
    lightnessScale: optionalNumberSpec(),
    lightnessShift: optionalNumberSpec(),
  },
};

export function validateLooks(
  ctx: ValidateCtx,
  raw: unknown,
): Readonly<Record<string, ThemeKey>> {
  if (!isPlainObject(raw)) {
    ctx.issues.push({
      path: "looks",
      message: `looks must be an object mapping look names to adaptation objects, got ${describeType(raw)}`,
      line: findKeyLine(ctx.source, ["looks"]),
    });
    return {};
  }
  const out: Record<string, ThemeKey> = {};
  for (const [name, value] of Object.entries(raw)) {
    // [LAW:no-silent-fallbacks] A look name is a deliverable set-state value, checked at load.
    if (name === "" || name.includes("/")) {
      ctx.issues.push({
        path: `looks.${name}`,
        message: `look name ${JSON.stringify(name)} must be non-empty and slash-free — a look picker writes the name on the set-state wire, which rejects empty values and splits on "/"`,
        line: findKeyLine(ctx.source, ["looks", name]),
      });
      continue;
    }
    const parsed = record(ctx, LOOK_SCHEMA, `looks.${name}`, value);
    // [LAW:one-source-of-truth] The single "absent axis = identity" site.
    if (parsed !== null) out[name] = { ...IDENTITY, ...parsed };
  }
  return out;
}

export function looksJson(): JsonNode {
  return { type: "object", additionalProperties: recordJson(LOOK_SCHEMA) };
}

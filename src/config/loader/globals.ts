// [LAW:types-are-the-program] The globals schema: a fixed set of string fields
// plus a validated palette name. This file changes when a global default field is
// added or removed.

import { type Globals } from "../dsl-types.js";
import { findKeyLine } from "./diagnostics.js";
import {
  describeType,
  isPlainObject,
  validatePaletteName,
  type Mutable,
  type ValidateCtx,
} from "./validate-core.js";

export function validateGlobals(ctx: ValidateCtx, raw: unknown): Globals {
  if (raw === undefined) return {};
  if (!isPlainObject(raw)) {
    ctx.issues.push({
      path: "globals",
      message: `globals must be an object, got ${describeType(raw)}`,
      line: findKeyLine(ctx.source, ["globals"]),
    });
    return {};
  }

  const out: Mutable<Globals> = {};
  const allowed = new Set([
    "default_bg",
    "default_fg",
    "default_empty_value",
    "default_separator",
    "default_truncate_marker",
    "palette",
  ]);

  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      ctx.issues.push({
        path: `globals.${key}`,
        message: `Unknown globals key "${key}". Expected one of: ${[...allowed].join(", ")}`,
        line: findKeyLine(ctx.source, ["globals", key]),
      });
    }
  }

  for (const stringKey of [
    "default_bg",
    "default_fg",
    "default_empty_value",
    "default_separator",
    "default_truncate_marker",
  ] as const) {
    const v = raw[stringKey];
    if (v === undefined) continue;
    if (typeof v !== "string") {
      ctx.issues.push({
        path: `globals.${stringKey}`,
        message: `globals.${stringKey} must be a string, got ${describeType(v)}`,
        line: findKeyLine(ctx.source, ["globals", stringKey]),
      });
      continue;
    }
    out[stringKey] = v;
  }

  const palette = validatePaletteName(ctx, "globals", raw);
  if (palette !== undefined) out.palette = palette;

  return out;
}

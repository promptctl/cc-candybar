// [LAW:types-are-the-program] The segment schema: a required `template` plus
// optional layout/paint/visibility fields and a nested `vars` block (validated by
// the variable schema). This file changes when a segment field is added or removed.

import {
  JUSTIFY_MODES,
  TRUNCATE_MODES,
  type JustifyMode,
  type SegmentDecl,
  type TruncateMode,
} from "../dsl-types.js";
import { findKeyLine } from "./diagnostics.js";
import {
  describeType,
  describeValue,
  isPlainObject,
  optionalEnum,
  optionalStringField,
  requireString,
  validatePaletteName,
  type Mutable,
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
    const parsed = validateSegment(ctx, `segments.${name}`, decl);
    if (parsed !== null) out[name] = parsed;
  }
  return out;
}

function validateSegment(
  ctx: ValidateCtx,
  path: string,
  raw: unknown,
): SegmentDecl | null {
  if (!isPlainObject(raw)) {
    ctx.issues.push({
      path,
      message: `${path} must be an object, got ${describeType(raw)}`,
      line: findKeyLine(ctx.source, path.split(".")),
    });
    return null;
  }

  const template = requireString(ctx, path, raw, "template");
  if (template === null) return null;

  const allowed = new Set([
    "template",
    "width",
    "justify",
    "truncate",
    "bg",
    "fg",
    "when",
    "vars",
    "palette",
  ]);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      ctx.issues.push({
        path: `${path}.${key}`,
        message: `Unknown segment key "${key}". Expected one of: ${[...allowed].join(", ")}`,
        line: findKeyLine(ctx.source, [...path.split("."), key]),
      });
    }
  }

  const seg: Mutable<SegmentDecl> = { template };

  if (raw.width !== undefined) {
    if (raw.width === "auto") {
      seg.width = "auto";
    } else if (
      typeof raw.width === "number" &&
      Number.isInteger(raw.width) &&
      raw.width > 0
    ) {
      seg.width = raw.width;
    } else {
      ctx.issues.push({
        path: `${path}.width`,
        message: `width must be "auto" or a positive integer, got ${describeValue(raw.width)}`,
        line: findKeyLine(ctx.source, [...path.split("."), "width"]),
      });
    }
  }

  const justify = optionalEnum(ctx, path, raw, "justify", JUSTIFY_MODES);
  if (justify !== undefined) seg.justify = justify as JustifyMode;

  const truncate = optionalEnum(ctx, path, raw, "truncate", TRUNCATE_MODES);
  if (truncate !== undefined) seg.truncate = truncate as TruncateMode;

  const bg = optionalStringField(ctx, path, raw, "bg");
  if (bg !== undefined) seg.bg = bg;

  const fg = optionalStringField(ctx, path, raw, "fg");
  if (fg !== undefined) seg.fg = fg;

  const when = optionalStringField(ctx, path, raw, "when");
  if (when !== undefined) seg.when = when;

  const palette = validatePaletteName(ctx, path, raw);
  if (palette !== undefined) seg.palette = palette;

  if (raw.vars !== undefined) {
    seg.vars = validateVariables(ctx, `${path}.vars`, raw.vars);
  }

  return seg;
}

// [LAW:single-enforcer] All per-segment bg/fg resolution flows through
// resolveSegmentColors. No second path; a second path would silently drift
// from the two-stage pipeline (bg first, fg with auto-contrast context second).
//
// [LAW:dataflow-not-control-flow] Steps execute unconditionally; the option
// values (undefined template = no spec) are what decides the output, not
// whether steps run. Absent bg or fg → Style fields are undefined → Style.isNull
// → fragmentsToStripCells's baseStyle merge is a no-op, cells flow through
// unchanged.

import { Style, ColorSpec } from "@promptctl/rich-js";
import type { ColorRgba, PaletteResolver } from "@promptctl/rich-js";
import type { RichText } from "@promptctl/rich-js";
import type { Template } from "@promptctl/go-template-js";
import { rotateHue } from "../themes/oklch.js";

// Semantic palette specs exempt from hue rotation — same rule as the legacy
// hue system in src/themes/default-mapping.ts (non-semantic only).
// [LAW:one-source-of-truth] Defined once here; enforced unconditionally
// by passing 0 degrees to rotateHue for semantic specs.
const SEMANTIC_SPECS = new Set(["error", "warning", "success", "info"]);

export class ColorSpecError extends Error {
  constructor(spec: string, role: "bg" | "fg") {
    super(`Invalid ${role} color spec: ${JSON.stringify(spec)}`);
    this.name = "ColorSpecError";
  }
}

/**
 * Resolve per-segment bg and fg template strings into a Style for baseStyle
 * injection in fragmentsToStripCells().
 *
 * Pipeline:
 *   1. Evaluate bgTemplate → plain text color-spec string.
 *   2. resolver.resolve(bgSpec) → ColorRgba.
 *   2b. rotateHue(bgColor, hueRotationDegrees) for non-semantic specs (wd5.4).
 *   3. Evaluate fgTemplate → plain text color-spec string.
 *   4. resolver.resolve(fgSpec, { against: bgColor }) → ColorRgba (auto-contrast).
 *   5. Wrap as Style({ bgcolor, color }).
 *
 * Undefined template → that color is not set in the returned Style, so cells
 * fall through to their own style (or no color if they have none).
 *
 * Throws ColorSpecError if a non-empty spec string resolves to null.
 *
 * options.hueRotationDegrees — degrees of OKLCH hue shift to apply to the
 * resolved bg color. 0 (default) is identity. Semantic specs (error, warning,
 * success, info) are always exempt — their meaning must not drift with
 * layout position. Fg auto-contrast resolves against the already-rotated bg.
 *
 * [LAW:dataflow-not-control-flow] Steps are ordered data transformations, not
 * guarded branches. The "no spec" case is represented as undefined, which flows
 * through to produce an absent Style field — not a skipped step.
 */
export function resolveSegmentColors(
  resolver: PaletteResolver,
  bgTemplate: Template<RichText> | undefined,
  fgTemplate: Template<RichText> | undefined,
  scope: object,
  options?: { hueRotationDegrees?: number },
): Style {
  const bgSpec = evalToPlainText(bgTemplate, scope);
  const rawBgColor =
    bgSpec !== undefined
      ? resolveSpec(resolver, bgSpec, undefined, "bg")
      : undefined;
  // [LAW:dataflow-not-control-flow] rotateHue always runs; degrees=0 is identity.
  // Semantic specs receive 0 degrees so their fixed meaning is preserved.
  const hueRotation = options?.hueRotationDegrees ?? 0;
  const bgColor =
    rawBgColor !== undefined
      ? rotateHue(
          rawBgColor,
          SEMANTIC_SPECS.has(bgSpec!.trim()) ? 0 : hueRotation,
        )
      : undefined;

  const fgSpec = evalToPlainText(fgTemplate, scope);
  // fgColor resolves against the rotated bgColor — auto-contrast stays in sync.
  const fgColor =
    fgSpec !== undefined
      ? resolveSpec(resolver, fgSpec, bgColor, "fg")
      : undefined;

  return new Style({
    bgcolor: bgColor !== undefined ? ColorSpec.fromRgba(bgColor) : undefined,
    color: fgColor !== undefined ? ColorSpec.fromRgba(fgColor) : undefined,
  });
}

// Evaluate a template against scope and flatten all fragments to plain text.
// Returns undefined when no template is configured (no bg/fg override).
function evalToPlainText(
  template: Template<RichText> | undefined,
  scope: object,
): string | undefined {
  if (template === undefined) return undefined;
  return template
    .evaluate(scope)
    .map((f) => f.plain)
    .join("");
}

// Resolve a color spec string through the palette resolver.
// Throws ColorSpecError (loud failure) if the spec is unknown or the required
// `against` context is missing — never silently falls back to a default.
// [LAW:no-defensive-null-guards] null from resolver.resolve signals broken
// config; the fix is the config, not a silent fallback.
function resolveSpec(
  resolver: PaletteResolver,
  spec: string,
  against: ColorRgba | undefined,
  role: "bg" | "fg",
): ColorRgba {
  const color = resolver.resolve(
    spec.trim(),
    against !== undefined ? { against } : undefined,
  );
  if (color === null) throw new ColorSpecError(spec, role);
  return color;
}

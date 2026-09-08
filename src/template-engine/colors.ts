// [LAW:single-enforcer] All per-segment bg/fg resolution flows through resolveSegmentColors.
// [LAW:no-ambient-temporal-coupling] Each phase's output is published before the next runs,
// so a later template can read an earlier phase's result and an earlier one cannot.
// [LAW:dataflow-not-control-flow] Steps run unconditionally; the values decide the output.

import {
  Style,
  ColorSpec,
  resolveColorRef,
  ColorRefError,
} from "@promptctl/rich-js";
import type { ColorRgba, Palette } from "@promptctl/rich-js";
import type { RichText } from "@promptctl/rich-js";
import type { Template } from "@promptctl/go-template-js";
import type { ActiveSegmentRef } from "../render/active-segment.js";
import type { Disclosure, TextFloor } from "../themes/decor.js";

export class ColorSpecError extends Error {
  constructor(spec: string, role: "bg" | "fg", detail: string) {
    super(`Invalid ${role} color ${JSON.stringify(spec)}: ${detail}`);
    this.name = "ColorSpecError";
  }
}

/**
 * Resolve a segment's `bg:`/`fg:` templates into its baseStyle, publishing each phase's
 * result into `ref` as it goes. A name and a computed `#RRGGBB` take one total path.
 * [LAW:dataflow-not-control-flow] `bg?:` optionality is the discriminator: an absent spec
 * IS the decorated case, wearing the region's tint; `text` is the same floor for `fg:`.
 */
export function resolveSegmentColors(
  ref: ActiveSegmentRef,
  segName: string,
  palette: Palette,
  disclosure: Disclosure,
  tint: ColorRgba,
  text: TextFloor,
  bgTemplate: Template<RichText> | undefined,
  fgTemplate: Template<RichText> | undefined,
  scope: object,
): Style {
  const active = {
    segName,
    palette,
    disclosure,
    bg: undefined as ColorRgba | undefined,
  };
  ref.current = active;

  const bgSpec = evalToPlainText(bgTemplate, scope);
  const bgColor =
    bgSpec !== undefined ? resolveRef(palette, bgSpec, "bg") : tint;

  active.bg = bgColor;
  const fgSpec = evalToPlainText(fgTemplate, scope);
  const fgColor =
    fgSpec !== undefined ? resolveRef(palette, fgSpec, "fg") : text(bgColor);

  return new Style({
    bgcolor: ColorSpec.fromRgba(bgColor),
    color: fgColor !== undefined ? ColorSpec.fromRgba(fgColor) : undefined,
  });
}

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

// [LAW:one-source-of-truth] The same rich-js checkpoint `{{ color }}` crosses, re-thrown with
// the field's role attached. [LAW:no-silent-failure] Never a substituted default.
function resolveRef(
  palette: Palette,
  ref: string,
  role: "bg" | "fg",
): ColorRgba {
  try {
    return resolveColorRef(palette, ref);
  } catch (e) {
    if (e instanceof ColorRefError)
      throw new ColorSpecError(ref, role, e.message);
    throw e;
  }
}

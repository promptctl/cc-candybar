// [LAW:single-enforcer] All per-segment bg/fg resolution flows through
// resolveSegmentColors. No second path; a second path would silently drift
// from the ordered pipeline this function owns.
//
// [LAW:no-ambient-temporal-coupling] That ordering — publish the segment's
// palette, resolve bg, publish bg, resolve fg, then hand the body its turn —
// is not incidental execution order that happens to work. It is the phase
// structure of a segment's color resolution, and this function is its one
// owner. Each phase's output is *published* into the active-segment record
// before the next phase runs, so a later template can read an earlier
// phase's result (`fg: '{{ contrastOn (bgOf) }}'`) and an earlier one
// cannot read a later one — it gets a message naming the phase instead.
//
// [LAW:dataflow-not-control-flow] Steps execute unconditionally; the option
// values (undefined template = no spec) are what decides the output, not
// whether steps run. An absent bg spec resolves to the region's tint; an
// absent fg resolves to the region's text floor (unset on the bar, so cells
// keep their own).

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
import type { Disclosure } from "../themes/decor.js";

export class ColorSpecError extends Error {
  constructor(spec: string, role: "bg" | "fg", detail: string) {
    super(`Invalid ${role} color ${JSON.stringify(spec)}: ${detail}`);
    this.name = "ColorSpecError";
  }
}

/**
 * Resolve a segment's `bg:` and `fg:` templates into the Style that becomes
 * its baseStyle, publishing each phase's result into `ref` as it goes.
 *
 * A `bg:`/`fg:` field is a template evaluated to a **color reference** — a
 * palette variable name (`"surface-active"`) or a `#RRGGBB` literal. Since
 * rich-js's `resolveColorRef` accepts both and is idempotent, the plain
 * authoring form and a computed one take the identical path:
 *
 * ```json5
 * bg: "surface-active"                             // a name, evaluated as itself
 * bg: '{{ darken (color "surface-active") 1 }}'    // a computed literal
 * ```
 *
 * There is no "is this a name or a color" branch anywhere — one total
 * function over both. [LAW:dataflow-not-control-flow]
 *
 * A segment always has a background. `tint` is the decorative one its region
 * dealt it — a vocabulary entry on the bar, a band item under a trigger — the
 * floor every segment wears; an authored `bg:` states MEANING (a threshold's
 * `error`, a context's `surface-active`) and paints over it.
 * [LAW:dataflow-not-control-flow] The `bg?:` optionality already in the
 * segment type is the discriminator: no segment is asked whether it "looks
 * decorative", the absence of an authored spec IS the decorated case. `text`
 * is the same floor for the foreground: what an unauthored `fg:` defaults to
 * — nothing on the bar (cells keep their own), the contrast-chosen pole on a
 * band, where a fixed foreground measurably fails (design doc, Decisions).
 *
 * Looks are not this function's concern: they live upstream as WHICH palette
 * it is handed, so bg, fg, and the body all resolve from one palette and their
 * theme-designed relationships are preserved.
 */
export function resolveSegmentColors(
  ref: ActiveSegmentRef,
  segName: string,
  palette: Palette,
  disclosure: Disclosure,
  tint: ColorRgba,
  text: ColorRgba | undefined,
  bgTemplate: Template<RichText> | undefined,
  fgTemplate: Template<RichText> | undefined,
  scope: object,
): Style {
  // Phase 0 — the palette (and the disclosure a `{{ menu }}` body colours its
  // items by) are live from here until the walk clears them, so
  // `{{ color … }}` in the bg template, the fg template, and the body all read
  // this one palette. `bg` starts undefined: it is what phase 1 computes.
  const active = {
    segName,
    palette,
    disclosure,
    bg: undefined as ColorRgba | undefined,
  };
  ref.current = active;

  // Phase 1 — background: the authored spec, else the region's tint.
  const bgSpec = evalToPlainText(bgTemplate, scope);
  const bgColor =
    bgSpec !== undefined ? resolveRef(palette, bgSpec, "bg") : tint;

  // Phase 2 — publish it, then foreground, which may now ask about it.
  active.bg = bgColor;
  const fgSpec = evalToPlainText(fgTemplate, scope);
  const fgColor =
    fgSpec !== undefined ? resolveRef(palette, fgSpec, "fg") : text;

  return new Style({
    bgcolor: ColorSpec.fromRgba(bgColor),
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

// [LAW:one-source-of-truth] The same rich-js checkpoint the `{{ color }}`
// template function crosses, so a reference that works in a body works in a
// `bg:` field and vice versa. Re-thrown with the field's role attached —
// rich-js knows the reference failed, only cc-candybar knows it came from a
// `fg:`. [LAW:no-silent-failure] never a substituted default: a broken color
// reference is a config bug, and the fix is the config.
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

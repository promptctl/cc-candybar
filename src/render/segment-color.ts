// Segment-scoped color functions: the seam between rich-js's palette-free
// color vocabulary and cc-candybar's notion of a segment.
//
// rich-js owns every color operation and knows nothing about segments;
// cc-candybar owns segments and performs no color arithmetic of its own
// [LAW:rich-js-owns-color-math]. This module is exactly the join: it supplies
// rich-js's `color` and `ramp` with *which* palette, and adds the one function
// whose meaning is candybar-specific — `bgOf`, the background of the segment
// currently rendering. [LAW:one-way-deps]

import type { FuncMap, TemplateFunc } from "@promptctl/go-template-js";
import { paletteFuncs } from "@promptctl/rich-js/template-bindings";
import { renderGauge } from "../template-engine/gauge.js";
import {
  requireActiveSegment,
  type ActiveSegmentRef,
} from "./active-segment.js";

/**
 * Bind `color`, `ramp` and `bgOf` to the segment the walk has published.
 *
 * **Why `color` reads a live palette.** A segment's rendered palette is not a
 * property of the loaded config — it is the base theme (session choice over
 * config default) adapted by the render's look, resolved per render. Binding
 * `color` to a palette captured
 * when the config loaded put the *body* of a template on a different palette
 * than the `bg:`/`fg:` of the very same segment, so `{{ color "primary" }}`
 * and `bg: "primary"` could name one thing and paint two.
 * [LAW:one-source-of-truth]
 *
 * That divergence was not exotic. Any session theme click moved the segment's
 * background while leaving every in-body semantic color where it was; a look
 * did the same. Reading the live palette makes the two agree by construction
 * rather than by coincidence.
 *
 * **Why `bgOf` exists.** De-emphasis — drawing labels, punctuation and ids
 * quieter than the facts they frame — is "move this color toward the
 * background." A palette's own `foreground-muted` blends toward the *theme's*
 * background, which is the wrong target for any segment not painted in it: a
 * segment on `surface-active` needs its muted text blended toward
 * `surface-active`. Only the segment knows its own background, so only the
 * segment can supply it:
 *
 * ```
 * {{ $muted := mix (color "foreground") (bgOf) 65 }}
 * {{ fg $muted .git.repoName }} {{ fg (color "primary") .git.branch }}
 * ```
 *
 * This is also what makes contrast reachable: `{{ fg (contrastOn (bgOf)) … }}`
 * asks a question about a real background, where the old spec-grammar `"auto"`
 * could only ever be handed a hardcoded literal.
 */
export function segmentColorFuncs(ref: ActiveSegmentRef): FuncMap {
  const bgOf: TemplateFunc = {
    fn: (() => {
      const active = requireActiveSegment(ref, "{{ bgOf }}");
      if (active.bg === undefined) {
        throw new Error(
          `{{ bgOf }} is not available while segments.${active.segName}'s own ` +
            `"bg:" is being evaluated — the background is what that template ` +
            `computes. Reach for a palette color there instead, e.g. ` +
            `bg: '{{ darken (color "surface") 1 }}'.`,
        );
      }
      return active.bg.hex;
    }) as TemplateFunc["fn"],
    argTypes: [],
    returnType: "string",
  };

  // One getter serves every palette reader, so the message names them.
  const palette = paletteFuncs(
    () =>
      requireActiveSegment(ref, "{{ color }} / {{ ramp }} / {{ gauge }}")
        .palette,
  );

  // [LAW:one-source-of-truth] The gauge paints each cell with the author's OWN
  // ramp, evaluated at that cell's position — by calling the very `ramp` entry
  // above rather than interpolating anything itself (brandon-template-funcs-zv5).
  // So stop parsing, palette-name resolution, the refusal to sort descending
  // stops, and the OKLCH interpolation are all the ones `{{ ramp }}` already has,
  // and a gauge cannot drift from a cascade written beside it.
  //
  // Stops arrive as "<position>:<colour>" strings because the template engine
  // repeats only its trailing argType slot — it cannot express "five fixed args
  // then (number, colour) pairs" — and a colour may be a palette name or a hex,
  // exactly as a `ramp` stop may.
  const gauge: TemplateFunc = {
    fn: ((
      value: number,
      max: number,
      width: number,
      filled: string,
      empty: string,
      easing?: string,
      ...stops: string[]
    ) =>
      renderGauge({
        value,
        max,
        width,
        filled,
        empty,
        colourAt:
          easing === undefined || stops.length === 0
            ? undefined
            : (position) =>
                String(
                  (
                    (palette.ramp as TemplateFunc).fn as (
                      ...args: Array<number | string>
                    ) => unknown
                  )(position, easing, ...flattenStops(stops)),
                ),
      })) as TemplateFunc["fn"],
    // "float" for the two measurements (a percentage need not be whole), "int"
    // for the cell count, then the glyph pair, the easing, and a repeating
    // trailing slot for the stops.
    argTypes: ["float", "float", "int", "string", "string", "string", "string"],
    returnType: "T",
  };

  return { ...palette, bgOf, gauge };
}

// [LAW:parse-dont-validate] "<position>:<colour>" → the flat (position, colour)
// list `ramp` takes. A stop without a position, or with one that is not a number,
// is an authoring mistake and says so — the alternative is a gauge that silently
// paints every cell the same colour because a stop quietly became 0.
function flattenStops(stops: readonly string[]): Array<number | string> {
  return stops.flatMap((stop) => {
    const cut = stop.indexOf(":");
    const at = cut < 0 ? NaN : Number(stop.slice(0, cut));
    if (!Number.isFinite(at)) {
      throw new Error(
        `{{ gauge }} stop "${stop}" must be "<position>:<colour>", e.g. "80:error" ` +
          `or "80:#ff0000"`,
      );
    }
    return [at, stop.slice(cut + 1)];
  });
}

// [LAW:rich-js-owns-color-math] The seam: rich-js owns every colour operation, this module supplies which palette, plus `bgOf`.

import type { FuncMap, TemplateFunc } from "@promptctl/go-template-js";
import { paletteFuncs } from "@promptctl/rich-js/template-bindings";
import {
  requireActiveSegment,
  type ActiveSegmentRef,
} from "./active-segment.js";

/**
 * Bind `color`, `ramp` and `bgOf` to the segment the walk has published.
 * [LAW:one-source-of-truth] `color` reads the LIVE palette, so a template body and its
 * segment's own `bg:`/`fg:` cannot name one colour and paint two. `bgOf` is that
 * segment's background — the blend target de-emphasis needs, which only it knows.
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

  return {
    ...paletteFuncs(
      () => requireActiveSegment(ref, "{{ color }} / {{ ramp }}").palette,
    ),
    bgOf,
  };
}

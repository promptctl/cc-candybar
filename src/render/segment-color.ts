// Segment-scoped color functions: the seam between rich-js's palette-free
// color vocabulary and cc-candybar's notion of a segment.
//
// rich-js owns every color operation and knows nothing about segments;
// cc-candybar owns segments and performs no color arithmetic of its own
// [LAW:one-source-of-truth]. This module is exactly the join: it supplies
// rich-js's `color` and `ramp` with *which* palette, and adds the functions
// whose meaning is candybar-specific — `bgOf`, the background of the segment
// currently rendering, `tint`, the decoration its region dealt it,
// and `errorRedOn`, the red the door's ✖ wears on a ground at the depth this
// render draws at.
// [LAW:one-way-deps]

import type { FuncMap, TemplateFunc } from "@promptctl/go-template-js";
import type { ColorDepth } from "@promptctl/rich-js";
import {
  ANSI_COLOR_NAMES,
  contrastFor,
  contrastRatio,
  drawnColour,
  ensureDrawn,
  Oklch,
  resolveColorRef,
  STANDARD_TABLE,
  type ColorRgba,
  type Palette,
} from "@promptctl/rich-js";
import { paletteFuncs } from "@promptctl/rich-js/template-bindings";
import { renderGauge } from "../template-engine/gauge.js";
import { QUIET_MIN_CONTRAST } from "../config/quiet-text.js";
import { TEXT_MIN_CONTRAST, type RoleShade } from "../themes/decor.js";
import {
  requireActiveSegment,
  type ActiveSegmentRef,
} from "./active-segment.js";

/**
 * Bind rich-js's palette functions (`color`, `ramp`, …), and `bgOf`, `tint`,
 * `errorRedOn` and `gauge`, to the segment the walk has published.
 *
 * **Why `color` reads a live palette.** A segment's rendered palette is not a
 * property of the loaded config — it is the base theme (session choice over
 * config default) adapted by the render's style, resolved per render. Binding
 * `color` to a palette captured
 * when the config loaded put the *body* of a template on a different palette
 * than the `bg:`/`fg:` of the very same segment, so `{{ color "primary" }}`
 * and `bg: "primary"` could name one thing and paint two.
 * [LAW:one-source-of-truth]
 *
 * That divergence was not exotic. Any session theme click moved the segment's
 * background while leaving every in-body semantic color where it was; a style
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
    arity: { kind: "exact" },
    returnType: "string",
  };

  // [LAW:one-source-of-truth] The decoration the walk dealt this segment — the
  // same colour an absent `bg:` resolves to. A threshold names it as its calm
  // arm (`ramp … 0 (tint) heat "warning" …`): a calm cell states nothing, so it
  // wears decoration like any cell that states nothing, rather than a fixed
  // role two neighbours would share.
  const tint: TemplateFunc = {
    fn: (() =>
      requireActiveSegment(ref, "{{ tint }}").tint.hex) as TemplateFunc["fn"],
    argTypes: [],
    arity: { kind: "exact" },
    returnType: "string",
  };

  // `errorRedOn bg`: the red the door's ✖ wears on `bg` at the depth this
  // render draws at (`errorRed`).
  const errorRedOn: TemplateFunc = {
    fn: ((bgRef: string) => {
      const { palette } = requireActiveSegment(ref, "{{ errorRedOn }}");
      return errorRed(palette, resolveColorRef(palette, bgRef), ref.drawnAt())
        .hex;
    }) as TemplateFunc["fn"],
    argTypes: ["string"],
    arity: { kind: "exact" },
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
    ) => {
      // [LAW:single-enforcer] `ramp` owns the tail's shape: an easing with no
      // stop reaches its ColorRamp, which refuses it at the first cell.
      const ramped =
        easing === undefined ? undefined : [easing, ...flattenStops(stops)];
      return renderGauge({
        value,
        max,
        width,
        filled,
        empty,
        colourAt:
          ramped === undefined
            ? undefined
            : (position) =>
                String(
                  (
                    (palette.ramp as TemplateFunc).fn as (
                      ...args: Array<number | string>
                    ) => unknown
                  )(position, ...ramped),
                ),
      });
    }) as TemplateFunc["fn"],
    // "float" for the two measurements (a percentage need not be whole), "int"
    // for the cell count, the glyph pair, then a repeating string slot for the
    // optional easing and its stops — Go's spelling of an optional tail is a
    // variadic one, so the gate requires the five and `ramp` refuses an easing
    // with no stop.
    argTypes: ["float", "float", "int", "string", "string", "string"],
    arity: { kind: "variadic" },
    returnType: "T",
  };

  return { ...palette, bgOf, tint, errorRedOn, gauge };
}

/** A rung of the error ladder other than the role itself: `error-<rung>` in a palette. */
type Rung = Exclude<RoleShade, "base" | "muted">;

// [LAW:dataflow-not-control-flow] The rungs out from the role toward each pole,
// nearest first, keyed by the pole rich-js's `contrastFor` names for a ground:
// the one the ground stands farther from. The rungs toward the ground follow.
const RUNGS_OUT: Readonly<Record<string, readonly Rung[]>> = {
  "#000000": ["darken-1", "darken-2", "darken-3"],
  "#ffffff": ["lighten-1", "lighten-2", "lighten-3"],
};

// The terminal's own reds, darker first: what a sixteen-colour terminal is
// most reliably red in, and always red as every depth draws it.
const TERMINAL_REDS = ["red", "bright_red"].map(
  (name) => STANDARD_TABLE.get(ANSI_COLOR_NAMES[name]!) as ColorRgba,
);

/**
 * Where a colour reads as red: its OKLCH hue, in degrees either side of 0,
 * and the chroma below which it reads as grey whatever its hue. Every bundled
 * theme's error colours fall inside at truecolor; what a reduced depth rounds
 * them to (an orange at 256 colours, a grey or silver at sixteen) falls out.
 */
export const RED_HUE = { from: -20, to: 40, chroma: 0.06 } as const;

/** Whether `colour` reads as red (`RED_HUE`). */
export function readsRed(colour: ColorRgba): boolean {
  const { h, c } = Oklch.fromRgba(colour);
  const hue = h > 180 ? h - 360 : h;
  return c >= RED_HUE.chroma && hue >= RED_HUE.from && hue <= RED_HUE.to;
}

/**
 * The red the door's ✖ wears on `ground` at `depth`. Candidates in order of
 * preference: the theme's error text colour (held by the palette to WCAG AA
 * on `error-muted`), the role itself, its ladder out toward the pole `ground`
 * stands farther from and then back toward the ground, and last the
 * terminal's own reds. A reduced depth rounds a colour to whatever its table
 * holds nearest, and the nearest entry to a red is often an orange or a grey,
 * so every candidate is judged as `depth` draws it, against the ground as
 * `depth` draws it. Taken is the first candidate, or else the nearest colour
 * the depth draws to it (rich-js `ensureDrawn`; truecolor draws every colour
 * as itself, so it has none), that reads as red and clears the body text
 * floor there; where no red does, the first that clears the quiet floor; and
 * where none clears even that, the candidate whose drawn red stands farthest
 * off.
 *
 * [LAW:single-enforcer] The one place this choice is made, at every depth.
 * [LAW:dataflow-not-control-flow] One fixed list, each entry measured, the
 * depth a value it is measured at: no depth has a path of its own.
 * [LAW:no-silent-failure] The palette's names resolve loudly, so a palette
 * missing one fails on every ground.
 */
function errorRed(
  palette: Palette,
  ground: ColorRgba,
  depth: ColorDepth,
): ColorRgba {
  const shown = drawnColour(ground, depth);
  const pole = contrastFor(shown).hex;
  const out = RUNGS_OUT[pole];
  if (out === undefined) {
    throw new Error(
      `contrastFor named ${pole} for ${ground.hex}, which is neither pole`,
    );
  }
  const back = Object.values(RUNGS_OUT).find((rungs) => rungs !== out)!;
  const candidates = [
    ...[
      "text-error",
      "error",
      ...[...out, ...back].map((r) => `error-${r}`),
    ].map((name) => resolveColorRef(palette, name)),
    ...TERMINAL_REDS,
  ];
  // [LAW:dataflow-not-control-flow] The bar's two text floors, highest
  // first, each tried over every candidate: the first red found is the
  // answer, so the common case stops at the first candidate.
  for (const floor of [TEXT_MIN_CONTRAST, QUIET_MIN_CONTRAST]) {
    for (const colour of candidates) {
      const cleared = ensureDrawn(
        colour,
        depth,
        (drawn) => readsRed(drawn) && contrastRatio(drawn, shown) >= floor,
      );
      if (cleared !== undefined) return cleared;
    }
  }
  const red = candidates
    .map((colour) => {
      const drawn = drawnColour(colour, depth);
      return {
        colour,
        red: readsRed(drawn),
        ratio: contrastRatio(drawn, shown),
      };
    })
    .filter(({ red }) => red);
  // [LAW:no-defensive-null-guards] The terminal's reds read as red at every
  // depth, so `red` is never empty.
  return red.reduce((farthest, c) => (c.ratio > farthest.ratio ? c : farthest))
    .colour;
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

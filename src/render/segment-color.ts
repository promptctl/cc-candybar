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
  contrastRatio,
  drawnColour,
  Oklch,
  resolveColorRef,
  STANDARD_TABLE,
  ANSI_COLOR_NAMES,
  parseRgbHex,
  type ColorRgba,
  type Palette,
} from "@promptctl/rich-js";
import { paletteFuncs } from "@promptctl/rich-js/template-bindings";
import { renderGauge } from "../template-engine/gauge.js";
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

/** A rung of the error ladder other than the role itself. */
type Rung = Exclude<RoleShade, "base" | "muted">;

// [LAW:dataflow-not-control-flow] The two poles, each with the error role's
// rungs out toward it, nearest first: a ground's farther pole leads, and the
// rungs toward the nearer one follow.
const POLES = [
  { pole: parseRgbHex("000000"), rungs: ["darken-1", "darken-2", "darken-3"] },
  {
    pole: parseRgbHex("ffffff"),
    rungs: ["lighten-1", "lighten-2", "lighten-3"],
  },
] as const satisfies ReadonlyArray<{ pole: ColorRgba; rungs: readonly Rung[] }>;

/**
 * The standard table's red and bright red, as rich-js assumes a terminal
 * draws them: the reds a terminal holds of its own, drawn red at every depth
 * (test/unit/segment-colors.test.ts holds it).
 */
export const TERMINAL_REDS: readonly ColorRgba[] = [
  ANSI_COLOR_NAMES.red!,
  ANSI_COLOR_NAMES.bright_red!,
].map((index) => STANDARD_TABLE.get(index));

// [LAW:one-source-of-truth] Where a colour reads as red: its OKLCH hue, in
// degrees either side of 0, and the chroma under which it reads as grey
// whatever its hue. Set from every bundled theme's error colours as truecolor
// draws them (-18° to 36°); the salmons and oranges 256 colours round some of
// them to sit past it.
const RED_HUE = { from: -20, to: 38, chroma: 0.06 } as const;

/** Whether `colour` reads as red (`RED_HUE`). */
export function readsRed(colour: ColorRgba): boolean {
  const { h, c } = Oklch.fromRgba(colour);
  const hue = h > 180 ? h - 360 : h;
  return c >= RED_HUE.chroma && hue >= RED_HUE.from && hue <= RED_HUE.to;
}

/**
 * An error red to wear on `ground` at `depth`, its hue kept over its
 * contrast: of the reds below, the first to clear TEXT_MIN_CONTRAST, or
 * failing that the one standing farthest off. The reds, in order of
 * preference, are the theme's error text colour (held by the palette to WCAG
 * AA on `error-muted`), the role itself, its ladder out toward the ground's
 * farther pole and then the nearer, and last the terminal's own reds. A
 * reduced depth draws a colour as the nearest entry its table holds, and the
 * nearest entry to a theme red is often an orange or a grey, so each is
 * measured as `depth` draws it, on the ground as `depth` draws it, and only
 * those drawn red are kept. Where no red clears the floor, it stays red under
 * it.
 *
 * [LAW:single-enforcer] The one place this choice is made, at every depth.
 * [LAW:dataflow-not-control-flow] One closed list, each entry measured, one
 * rank over it: a contrast counts up to the floor, so the first to reach the
 * floor and, short of it, the farthest are the same comparison, and an
 * earlier entry wins a tie. The depth is a value the measuring takes, not a
 * path. Never a colour searched out of a depth's table, which lands on
 * colours neither the theme nor the terminal names as red.
 */
function errorRed(
  palette: Palette,
  ground: ColorRgba,
  depth: ColorDepth,
): ColorRgba {
  const shown = drawnColour(ground, depth);
  const [farther, nearer] = [...POLES].sort(
    (x, y) => contrastRatio(y.pole, shown) - contrastRatio(x.pole, shown),
  );
  const themed = [
    "text-error",
    "error",
    ...[...farther!.rungs, ...nearer!.rungs].map((rung) => `error-${rung}`),
  ].map((name) => resolveColorRef(palette, name));
  const counted = (ratio: number) => Math.min(ratio, TEXT_MIN_CONTRAST);
  // [LAW:no-defensive-null-guards] The terminal's reds are drawn red at every
  // depth, so the list the reduce ranks is never empty.
  return [...themed, ...TERMINAL_REDS]
    .map((colour) => {
      const drawn = drawnColour(colour, depth);
      return { colour, drawn, ratio: counted(contrastRatio(drawn, shown)) };
    })
    .filter(({ drawn }) => readsRed(drawn))
    .reduce((best, c) => (c.ratio > best.ratio ? c : best)).colour;
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

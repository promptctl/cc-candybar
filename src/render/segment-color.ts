// Segment-scoped color functions: the seam between rich-js's palette-free
// color vocabulary and cc-candybar's notion of a segment.
//
// rich-js owns every color operation and knows nothing about segments;
// cc-candybar owns segments and performs no color arithmetic of its own
// [LAW:one-source-of-truth]. This module is exactly the join: it supplies
// rich-js's `color` and `ramp` with *which* palette, and adds the functions
// whose meaning is candybar-specific — `bgOf`, the background of the segment
// currently rendering, `tint`, the decoration its region dealt it,
// and `roleTextOn`, the colour a role's text wears on a ground at the depth
// this render draws at.
// [LAW:one-way-deps]

import type { FuncMap, TemplateFunc } from "@promptctl/go-template-js";
import {
  ANSI_COLOR_NAMES,
  ColorDepth,
  STANDARD_TABLE,
  contrastFor,
  contrastRatio,
  drawnColour,
  resolveColorRef,
  type ColorRgba,
  type Palette,
} from "@promptctl/rich-js";
import { paletteFuncs } from "@promptctl/rich-js/template-bindings";
import { renderGauge } from "../template-engine/gauge.js";
import {
  ROLE_ANSI,
  TEXT_MIN_CONTRAST,
  semanticRoleOf,
  type RoleShade,
  type SemanticRole,
} from "../themes/decor.js";
import {
  requireActiveSegment,
  type ActiveSegmentRef,
} from "./active-segment.js";

/**
 * Bind rich-js's palette functions (`color`, `ramp`, …), and `bgOf`, `tint`,
 * `roleTextOn` and `gauge`, to the segment the walk has published.
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

  // `roleTextOn role bg`: the colour `role`'s text wears on `bg` at the depth
  // this render draws at (`roleText`).
  const roleTextOn: TemplateFunc = {
    fn: ((role: string, bgRef: string) => {
      const { palette } = requireActiveSegment(ref, "{{ roleTextOn }}");
      return roleText(
        palette,
        semanticRoleOf(role),
        resolveColorRef(palette, bgRef),
        ref.drawnAt(),
      ).hex;
    }) as TemplateFunc["fn"],
    argTypes: ["string", "string"],
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

  return { ...palette, bgOf, tint, roleTextOn, gauge };
}

/** A rung of a role's ladder other than the role itself: `<role>-<rung>` in a palette. */
type Rung = Exclude<RoleShade, "base" | "muted">;

// [LAW:dataflow-not-control-flow] The rungs out from a role toward each pole,
// nearest first, keyed by the pole rich-js's `contrastFor` names for a ground:
// the one the ground stands farther from.
const RUNGS_OUT: Readonly<Record<string, readonly Rung[]>> = {
  "#000000": ["darken-1", "darken-2", "darken-3"],
  "#ffffff": ["lighten-1", "lighten-2", "lighten-3"],
};
const RUNGS = Object.values(RUNGS_OUT).flat();

/**
 * The colour `role`'s text wears on `ground` at `depth`, selected among
 * colours that depth draws as the role's and never synthesised, so the text
 * keeps the role's hue on every ground. Every candidate, and the ground, is
 * measured as `depth` draws it, over black, so the terminal's rounding never
 * costs what was measured unrounded.
 *
 * The candidates, in order: at ansi, the terminal's two colours of the role
 * (`ROLE_ANSI`); at every other depth, the theme's names for it, its text
 * colour (`text-<role>`, held by the palette to WCAG AA on `<role>-muted`),
 * the role itself, then its ladder out toward the pole `ground` stands
 * farther from. The first that clears TEXT_MIN_CONTRAST is taken; otherwise
 * whichever of the role's colours stands farthest off `ground`, which clears
 * it wherever any of them does.
 *
 * [LAW:single-enforcer] The one place this choice is made.
 * [LAW:dataflow-not-control-flow] A fixed list of colours, each measured, and
 * the first that clears taken: a selection, not a search through lightness.
 * [LAW:no-silent-failure] A role the palette names no text colour or full
 * ladder for fails loudly, naming the missing entry.
 */
export function roleText(
  palette: Palette,
  role: SemanticRole,
  ground: ColorRgba,
  depth: ColorDepth,
): ColorRgba {
  const shown = drawnColour(ground, depth);
  const measured = (colour: ColorRgba) => ({
    colour,
    ratio: contrastRatio(drawnColour(colour, depth), shown),
  });
  const { preferred, all } =
    depth === ColorDepth.STANDARD
      ? ansiCandidates(role)
      : namedCandidates(palette, role, shown);
  const ranked = preferred.map(measured);
  return (
    ranked.find(({ ratio }) => ratio >= TEXT_MIN_CONTRAST) ??
    all
      .map(measured)
      .reduce((farthest, colour) =>
        colour.ratio > farthest.ratio ? colour : farthest,
      )
  ).colour;
}

interface Candidates {
  // In the order they are tried.
  readonly preferred: readonly ColorRgba[];
  // Every colour of the role, the farthest of which stands in when none clears.
  readonly all: readonly ColorRgba[];
}

// The terminal's own colours of the role, bright first.
function ansiCandidates(role: SemanticRole): Candidates {
  const colours = ROLE_ANSI[role].map(
    (name) => STANDARD_TABLE.get(ANSI_COLOR_NAMES[name]!) as ColorRgba,
  );
  return { preferred: colours, all: colours };
}

// The theme's names for the role, with its ladder out toward the pole `shown`
// stands farther from. Every name is resolved up front, so a palette missing
// one fails on every ground rather than only on the grounds that reach it.
function namedCandidates(
  palette: Palette,
  role: SemanticRole,
  shown: ColorRgba,
): Candidates {
  const pole = contrastFor(shown).hex;
  const out = RUNGS_OUT[pole];
  if (out === undefined) {
    throw new Error(
      `contrastFor named ${pole} for ${shown.hex}, which is neither pole`,
    );
  }
  const text = `text-${role}`;
  const rung = (step: Rung) => `${role}-${step}`;
  const colours = new Map(
    [text, role, ...RUNGS.map(rung)].map((name) => [
      name,
      resolveColorRef(palette, name),
    ]),
  );
  // [LAW:no-defensive-null-guards] `colours` holds every name asked for here.
  return {
    preferred: [text, role, ...out.map(rung)].map((name) => colours.get(name)!),
    all: [...colours.values()],
  };
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

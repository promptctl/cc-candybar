// Segment-scoped color functions: the seam between rich-js's palette-free
// color vocabulary and cc-candybar's notion of a segment.
//
// rich-js owns every color operation and knows nothing about segments;
// cc-candybar owns segments and performs no color arithmetic of its own
// [LAW:one-source-of-truth]. This module is exactly the join: it supplies
// rich-js's `color` and `ramp` with *which* palette, and adds the functions
// whose meaning is candybar-specific — `bgOf`, the background of the segment
// currently rendering, `tint`, the decoration its region dealt it,
// `roleTextOn`, the colour the theme names for a role's text on a ground, and
// `keptOn`, a colour shown as given at the depth this render draws at.
// [LAW:one-way-deps]

import type { FuncMap, TemplateFunc } from "@promptctl/go-template-js";
import {
  ColorDepth,
  contrastFor,
  contrastRatio,
  drawnColour,
  ensureDrawn,
  resolveColorRef,
  type ColorRgba,
  type Palette,
} from "@promptctl/rich-js";
import { paletteFuncs } from "@promptctl/rich-js/template-bindings";
import { QUIET_MIN_CONTRAST } from "../config/quiet-text.js";
import { renderGauge } from "../template-engine/gauge.js";
import { TEXT_MIN_CONTRAST, type RoleShade } from "../themes/decor.js";
import {
  requireActiveSegment,
  type ActiveSegmentRef,
} from "./active-segment.js";

/**
 * Bind rich-js's palette functions (`color`, `ramp`, …), and `bgOf`, `tint`,
 * `roleTextOn`, `keptOn` and `gauge`, to the segment the walk has published.
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

  // `roleTextOn role bg`: the colour the theme names for `role`'s text on
  // `bg` (`namedRoleText`). Every answer is an entry of the palette, as given.
  const roleTextOn: TemplateFunc = {
    fn: ((role: string, bgRef: string) => {
      const { palette } = requireActiveSegment(ref, "{{ roleTextOn }}");
      return namedRoleText(palette, role, resolveColorRef(palette, bgRef)).hex;
    }) as TemplateFunc["fn"],
    argTypes: ["string", "string"],
    arity: { kind: "exact" },
    returnType: "string",
  };

  // A colour shown exactly as given — the door's ✖ is a red its theme names,
  // never slid, so it reads as red on every theme (#294) — that the
  // terminal's rounding must still not cost legibility: `keptOn fg bg` is `fg`
  // itself in truecolor, and at a depth that draws other colours (rich-js
  // `ensureDrawn`, which has nothing to replace a truecolor colour with) the
  // nearest drawn colour that stands on `bg` as drawn at least as far as `fg`
  // does on `bg` — and at least the quiet floor, since a ground repaired at
  // that depth no longer measures what truecolor drew — capped at the text
  // floor. Where the depth draws nothing that clears, `fg` itself.
  // [LAW:one-source-of-truth] rich-js measures and repairs; this only names
  // the floor.
  const keptOn: TemplateFunc = {
    fn: ((fgRef: string, bgRef: string) => {
      const { palette } = requireActiveSegment(ref, "{{ keptOn }}");
      const fg = resolveColorRef(palette, fgRef);
      const bg = resolveColorRef(palette, bgRef);
      // As every floor is measured: on the colours as drawn, each composited
      // over the terminal's black — never `fg` laid over `bg`, which no
      // terminal draws.
      const held = contrastRatio(
        drawnColour(fg, ColorDepth.TRUECOLOR),
        drawnColour(bg, ColorDepth.TRUECOLOR),
      );
      const floor = Math.min(
        TEXT_MIN_CONTRAST,
        Math.max(held, QUIET_MIN_CONTRAST),
      );
      return (
        ensureDrawn(
          fg,
          ref.drawnAt(),
          (candidate, drawn) => contrastRatio(candidate, drawn(bg)) >= floor,
        ) ?? fg
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

  return { ...palette, bgOf, tint, roleTextOn, keptOn, gauge };
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
 * The colour `role`'s text wears on `ground`, selected among the colours the
 * theme names for the role and never synthesised, so the text stays the
 * theme's own colour for the role on every ground: the role's text colour
 * (`text-<role>`, held by the palette to WCAG AA on `<role>-muted`) where it
 * clears TEXT_MIN_CONTRAST on `ground`; otherwise, walking the role's ladder
 * out from the role itself toward the pole `ground` stands farther from, the
 * first that clears it, the role first; and otherwise whichever of the role's
 * colours stands farthest off `ground`, its text colour and the role itself
 * included, which clears it wherever any of them does. Each pair is measured
 * as truecolor draws it, over black; the depth's rounding is `keptOn`'s.
 *
 * [LAW:single-enforcer] The one place this choice is made.
 * [LAW:dataflow-not-control-flow] A fixed list of named entries, each
 * measured, and the first that clears taken: a selection, not a search
 * through lightness. [LAW:no-silent-failure] A role the palette names no
 * text colour or full ladder for fails loudly, naming the missing entry.
 */
function namedRoleText(
  palette: Palette,
  role: string,
  ground: ColorRgba,
): ColorRgba {
  const shown = drawnColour(ground, ColorDepth.TRUECOLOR);
  const named = (name: string) => {
    const colour = resolveColorRef(palette, name);
    return {
      colour,
      ratio: contrastRatio(drawnColour(colour, ColorDepth.TRUECOLOR), shown),
    };
  };
  const pole = contrastFor(shown).hex;
  const out = RUNGS_OUT[pole];
  if (out === undefined) {
    throw new Error(
      `contrastFor named ${pole} for ${ground.hex}, which is neither pole`,
    );
  }
  const text = `text-${role}`;
  const rung = (step: Rung) => `${role}-${step}`;
  // Every colour the role names, measured up front, so a palette missing one
  // fails on every ground rather than only on the grounds that reach it.
  const colours = new Map(
    [text, role, ...RUNGS.map(rung)].map((name) => [name, named(name)]),
  );
  // [LAW:no-defensive-null-guards] `colours` holds every name asked for here.
  const preferred = [text, role, ...out.map(rung)].map(
    (name) => colours.get(name)!,
  );
  return (
    preferred.find(({ ratio }) => ratio >= TEXT_MIN_CONTRAST) ??
    [...colours.values()].reduce((farthest, colour) =>
      colour.ratio > farthest.ratio ? colour : farthest,
    )
  ).colour;
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

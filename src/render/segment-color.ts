// Segment-scoped color functions: the seam between rich-js's palette-free
// color vocabulary and cc-candybar's notion of a segment.
//
// rich-js owns every color operation and knows nothing about segments;
// cc-candybar owns segments and performs no color arithmetic of its own
// [LAW:one-source-of-truth]. This module is exactly the join: it supplies
// rich-js's `color` and `ramp` with *which* palette, and adds the functions
// whose meaning is candybar-specific — `bgOf`, the background of the segment
// currently rendering, `tint`, the decoration its region dealt it,
// and `roleTextOn`, the colour a semantic role's text wears on a ground at
// the depth this render draws at.
// [LAW:one-way-deps]

import type { FuncMap, TemplateFunc } from "@promptctl/go-template-js";
import {
  ANSI_COLOR_NAMES,
  ColorDepth,
  contrastFor,
  contrastRatio,
  drawnColour,
  resolveColorRef,
  STANDARD_TABLE,
  type ColorRgba,
  type Palette,
} from "@promptctl/rich-js";
import { paletteFuncs } from "@promptctl/rich-js/template-bindings";
import { renderGauge } from "../template-engine/gauge.js";
import {
  ANSI_ROLE_COLOURS,
  TEXT_MIN_CONTRAST,
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
  // this render draws at (`roleText`). Every answer is a colour that depth
  // draws as the role's own, as given.
  const roleTextOn: TemplateFunc = {
    fn: ((role: string, bgRef: string) => {
      const { palette } = requireActiveSegment(ref, "{{ roleTextOn }}");
      return roleText(
        palette,
        semanticRole(role),
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

// [LAW:parse-dont-validate] A role's text is chosen among colours every
// depth can name for it, which only the semantic roles have
// (`ANSI_ROLE_COLOURS`), so a template's role is parsed once, here, and
// everything below holds a `SemanticRole`.
function semanticRole(role: string): SemanticRole {
  if (!Object.hasOwn(ANSI_ROLE_COLOURS, role)) {
    const roles = Object.keys(ANSI_ROLE_COLOURS)
      .map((known) => `"${known}"`)
      .join(", ");
    throw new Error(
      `{{ roleTextOn }}: "${role}" is not a semantic role; it takes one of ${roles}`,
    );
  }
  return role as SemanticRole;
}

// The colour the writer emits an ANSI name as, from rich-js's own table, so
// the colour chosen at ansi is written as exactly that terminal colour.
function ansiColour(name: string): ColorRgba {
  const index = ANSI_COLOR_NAMES[name];
  if (index === undefined) {
    throw new Error(`"${name}" is not an ANSI colour name rich-js knows`);
  }
  return STANDARD_TABLE.get(index);
}

/**
 * The colours a role's text may wear at a depth: those it prefers, in order,
 * and every one of them that may stand farthest where none of those clears.
 */
interface RoleTextCandidates {
  readonly preferred: readonly ColorRgba[];
  readonly all: readonly ColorRgba[];
}
type CandidatesFor = (
  palette: Palette,
  role: SemanticRole,
  pole: string,
) => RoleTextCandidates;

// The colours the theme names for the role: its text colour (`text-<role>`,
// held by the palette to WCAG AA on `<role>-muted`), then the role itself,
// then its ladder out toward the pole the ground stands farther from; and
// every one of them, both sides of the role, to stand farthest.
// [LAW:no-silent-failure] A palette missing one fails loudly, naming it, on
// every ground rather than only on the grounds that reach it.
const namedCandidates: CandidatesFor = (palette, role, pole) => {
  const out = RUNGS_OUT[pole];
  if (out === undefined) {
    throw new Error(`contrastFor named ${pole}, which is neither pole`);
  }
  const named = (rungs: readonly Rung[]) =>
    [`text-${role}`, role, ...rungs.map((step) => `${role}-${step}`)].map(
      (name) => resolveColorRef(palette, name),
    );
  return { preferred: named(out), all: named(RUNGS) };
};

// The terminal's own two colours for the role. Sixteen colours leave no room
// for a theme's ladder: its shades round to whichever entry is nearest, often
// a grey or a purple, so at that depth only these two are drawn as the role.
const terminalCandidates: CandidatesFor = (_palette, role) => {
  const both = ANSI_ROLE_COLOURS[role].map(ansiColour);
  return { preferred: both, all: both };
};

// [LAW:dataflow-not-control-flow] The candidates per depth, as data: the
// depth is the domain's own discriminator, and each depth that draws only
// sixteen colours offers the terminal's.
const CANDIDATES_AT: Readonly<Record<ColorDepth, CandidatesFor>> = {
  [ColorDepth.DEFAULT]: namedCandidates,
  [ColorDepth.STANDARD]: terminalCandidates,
  [ColorDepth.EIGHT_BIT]: namedCandidates,
  [ColorDepth.TRUECOLOR]: namedCandidates,
  [ColorDepth.WINDOWS]: terminalCandidates,
};

/**
 * The colour `role`'s text wears on `ground` at `depth`, selected among the
 * colours that depth draws as the role and never synthesised or slid, so the
 * text stays the role's colour on every ground: the first preferred candidate
 * that clears TEXT_MIN_CONTRAST on `ground`, and otherwise whichever candidate
 * stands farthest off it, which reads below the floor rather than leave the
 * role's hue. Each pair is measured as `depth` draws it, over black, so the
 * depth's rounding cannot cost what was never measured unrounded.
 *
 * [LAW:single-enforcer] The one place this choice is made.
 * [LAW:dataflow-not-control-flow] A fixed list of colours, each measured, and
 * the first that clears taken: a selection, not a search through lightness.
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
  const { preferred, all } = CANDIDATES_AT[depth](
    palette,
    role,
    contrastFor(shown).hex,
  );
  // Every candidate measured up front, so a palette missing one fails on
  // every ground (`namedCandidates` resolves them all).
  const farthest = all
    .map(measured)
    .reduce((best, colour) => (colour.ratio > best.ratio ? colour : best));
  return (
    preferred.map(measured).find(({ ratio }) => ratio >= TEXT_MIN_CONTRAST) ??
    farthest
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

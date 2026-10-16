// [LAW:one-type-per-behavior] The theme picker's row and the swatch it is made
// of (brandon-theme-swatch-8v9r), as two template functions over the SAME
// thing every picker shape ranges: one option-domain action, its resolved
// members, its gated click.
//
//   {{ swatch "applyAction" [option] }}
//       the swatch of `option` — by default the option the action's key holds
//       now — in the palette picking it would put in force. What stands beside
//       a theme name wherever the bar shows one.
//
//   {{ swatches "applyAction" "pageAction" }}
//       ◀ ? ▶ ← ▀▀▀ [▀▀▀] ▀▀▀ →
//       the previous option, a random one, the next one, then a page of
//       swatches with the one in force marked — Brandon's "< ? > << [=] *[=]*
//       [=] >>". Every cell applies the option it shows; ← → page, and a
//       step (◀ ? ▶) turns the row to the page holding where it lands. It is
//       a row of a disclosure body (`led`): the body's ✕ closes it.
//
// [LAW:one-source-of-truth] Both read the domain's own `paletteOf`, so the
// swatch beside a name, the swatch in the row and the option's colours in any
// other picker are drawn from one palette per option. A domain with none has
// nothing to draw a swatch of and is refused, loudly, by what it declares.
//
// [LAW:one-way-deps] Lives in render/ beside the picker, injected into the
// engine by registerDslConfig as data; the generic engine never imports it.

import type { Palette, RichText } from "@promptctl/rich-js";
import type { FuncMap } from "@promptctl/go-template-js";
import { readVar, renderLook, type ActionRuntime } from "./action.js";
import {
  requireActiveSegment,
  type ActiveSegmentRef,
} from "./active-segment.js";
import { closeOn } from "./band-style.js";
import { CAROUSEL_NEXT, CAROUSEL_PREV, ringAround } from "./carousel.js";
import { swatchPaint } from "./option-paint.js";
import {
  renderPicker,
  requireKind,
  requireOptionKind,
  type OptionAction,
  type PickerStep,
} from "./picker.js";
import { swatch } from "./swatch.js";
import { refuseSurplus } from "../template-engine/optional-tail.js";

export const SWATCHES_RANDOM = "?";

// [LAW:no-silent-failure] Every reader of an option's palette — these two and
// `{{ themePreview "applyAction" }}` — draws the palette an option would put
// in force, and needs the option in force now: a domain that names no palette,
// or an action whose key holds no value (a structural insert), has neither,
// and the call names the shape that works.
export function requireSwatchable(
  runtime: ActionRuntime,
  applyName: string,
  helper: "swatch" | "swatches" | "themePreview",
): OptionAction & {
  readonly stateVar: string;
  readonly paletteOf: NonNullable<OptionAction["paletteOf"]>;
} {
  const apply = requireOptionKind(runtime, applyName, helper);
  if (!("stateVar" in apply)) {
    throw new Error(
      `${helper} references action "${applyName}", which inserts a segment and holds no current value — a ${helper} needs a { set, from } or { persist, from } action`,
    );
  }
  if (apply.paletteOf === undefined) {
    throw new Error(
      `${helper} references action "${applyName}", whose options are not colour-valued — a swatch draws the palette an option puts in force, as the "themes", "placementThemes" and "styles" domains do`,
    );
  }
  return apply as typeof apply & {
    readonly paletteOf: NonNullable<OptionAction["paletteOf"]>;
  };
}

// [LAW:dataflow-not-control-flow] A random option other than the one at
// `centre`, as a pure function of a seed: the integer hash of the seed (two
// rounds of a multiply–xorshift mix) picks one of the `count - 1` others. The
// render passes its own instant, so every render offers a fresh pick and a
// render at a given instant offers the same one. With one option there is no
// other, and the pick is that option. Exported for unit testing.
export function randomOther(
  seed: number,
  count: number,
  centre: number,
): number {
  let h = Math.imul(seed ^ (seed >>> 16), 0x45d9f3b);
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  h ^= h >>> 16;
  return (centre + 1 + ((h >>> 0) % Math.max(count - 1, 1))) % count;
}

/** The palette `option` — by default the one in force — would put in force. */
export function optionPalette(
  runtime: ActionRuntime,
  applyName: string,
  helper: "swatch" | "themePreview",
  chosen?: string,
): Palette {
  const apply = requireSwatchable(runtime, applyName, helper);
  const option = chosen ?? readVar(runtime.store, apply.stateVar);
  // [LAW:parse-dont-validate] A domain's `paletteOf` answers for its members;
  // an option named in a template, or a value the key held before a reload
  // took its member away, is checked here, where it crosses into it.
  if (!apply.options.includes(option)) {
    throw new Error(
      `${helper} "${applyName}": "${option}" is not one of its options, so it has no palette to draw`,
    );
  }
  return apply.paletteOf(option, renderLook(runtime, `{{ ${helper} }}`));
}

export function swatchFuncs(
  runtime: ActionRuntime,
  activeSegment: ActiveSegmentRef,
  clock: () => Date,
): FuncMap {
  return {
    swatch: {
      fn: (applyName: string, ...tail: unknown[]) => {
        const [option, ...extra] = tail;
        refuseSurplus(`swatch "${applyName}"`, ["option"], extra);
        if (option !== undefined && typeof option !== "string") {
          throw new Error(
            `swatch "${applyName}": option must be text, got ${JSON.stringify(option)}`,
          );
        }
        return swatch(optionPalette(runtime, applyName, "swatch", option));
      },
      argTypes: ["string", "value"],
      arity: { kind: "variadic" },
      returnType: "T",
    },
    swatches: {
      fn: (applyName: string, pageName: string): RichText => {
        const apply = requireSwatchable(runtime, applyName, "swatches");
        const page = requireKind(
          runtime,
          pageName,
          "set-int",
          "an int action ({ set, int: true })",
          "swatches",
        );
        const active = requireActiveSegment(activeSegment, "{{ swatches }}");
        if (active.bg === undefined) {
          throw new Error(
            `{{ swatches }} is not available while segments.${active.segName}'s own "bg:" is being evaluated — a swatch row is drawn on that background`,
          );
        }
        const drawnAt = activeSegment.drawnAt();
        const { options } = apply;
        const count = options.length;
        // [LAW:dataflow-not-control-flow] An empty domain has nothing to step
        // to, so it leads with nothing, as its grid has no cells. Otherwise ◀ ▶
        // step through the ring a carousel over the same key turns, and ? to
        // another option at random.
        const steps = (): readonly PickerStep[] => {
          const at = ringAround(
            options,
            readVar(runtime.store, apply.stateVar),
          );
          return [
            { glyph: CAROUSEL_PREV, option: options[at(-1)]! },
            {
              glyph: SWATCHES_RANDOM,
              option: options[randomOther(clock().getTime(), count, at(0))]!,
            },
            { glyph: CAROUSEL_NEXT, option: options[at(1)]! },
          ];
        };
        const [line] = renderPicker(
          applyName,
          apply,
          { key: page.key, stateVar: page.stateVar },
          { kind: "led" },
          true,
          runtime,
          swatchPaint(
            active,
            renderLook(runtime, "{{ swatches }}"),
            apply.paletteOf,
            drawnAt,
            active.bg,
          ),
          closeOn(active.palette, active.bg, drawnAt),
          count === 0 ? [] : steps(),
        );
        return line!;
      },
      argTypes: ["string", "string"],
      arity: { kind: "exact" },
      returnType: "T",
    },
  };
}

// [LAW:one-type-per-behavior] A `{{ carousel "applyAction" }}` is the picker's
// other shape over the SAME thing: one option-domain action, its resolved
// members, its gated click (brandon-theme-picker-bgw.ef6). The picker lays the
// domain out as a grid of pages; the carousel lays it out as a ring centred on
// the value the action's key holds now —
//
//     prev₂ prev₁ ◀ CURRENT ▶ next₁ next₂
//
// — and every cell it draws, arrow or name, APPLIES the option it points at.
// Rotating is therefore picking: one click recolours the bar, and there is no
// highlight that moves ahead of the applied value waiting for a second click.
//
// [LAW:one-source-of-truth] The carousel owns no position. Its centre IS the
// action's current value, read through the action's own `stateVar` (for the
// settings menu's dual controls, the `.effective` projection the bar rendered
// with), so the centre and the bar cannot disagree, and there is no cursor key
// to gate, reset, or leave stale. Each click writes through `realize` — the
// same fold `{{ action }}` and the picker's option cells use — so a carousel
// over a dual carries the dual's destination and release like any other click.
//
// [LAW:one-way-deps] Lives in render/ beside the picker, injected into the
// engine by registerDslConfig as data; the generic engine never imports it.

import type { RichText } from "@promptctl/rich-js";
import type { FuncMap } from "@promptctl/go-template-js";
import { effectsUrl } from "../click/wire.js";
import { placedBy } from "../themes/decor.js";
import {
  linkFragment,
  readVar,
  realize,
  type ActionRuntime,
} from "./action.js";
import {
  requireActiveSegment,
  type ActiveSegmentRef,
} from "./active-segment.js";
import { optionItemStyle } from "./band-style.js";
import {
  assemble,
  cellWidth,
  ledRowBudget,
  requireOptionKind,
  type ItemStyle,
} from "./picker.js";

export const CAROUSEL_PREV = "◀";
export const CAROUSEL_NEXT = "▶";

type OptionAction = ReturnType<typeof requireOptionKind>;

// [LAW:dataflow-not-control-flow] How many neighbours each side gets is a pure
// function of widths: whole symmetric levels are added while the row still
// fits, never more than the ring holds without showing one option twice, and
// never more than the author's `cap` (Infinity when none was asked for).
// `ring(d)` is the option d steps from the centre (negative = before it).
// Exported for unit testing.
export function neighbourLevels(
  ring: (offset: number) => string,
  count: number,
  base: number,
  available: number,
  cap: number,
): number {
  const most = Math.min(Math.floor((count - 1) / 2), cap);
  let width = base;
  let levels = 0;
  while (levels < most) {
    const next =
      width +
      cellWidth(ring(-(levels + 1))) +
      1 +
      cellWidth(ring(levels + 1)) +
      1;
    if (next > available) break;
    width = next;
    levels += 1;
  }
  return levels;
}

export function renderCarousel(
  applyName: string,
  apply: OptionAction,
  runtime: ActionRuntime,
  itemStyle: ItemStyle,
  neighbours: number,
): RichText {
  // [LAW:no-silent-failure] A carousel is centred on the value its key holds;
  // a structural insert (layout-op-option) holds none, and a key no variable
  // reads back holds none the render can see — a ring over either would sit
  // on its first option forever, every ▶ writing the same neighbour. Loud,
  // naming the shape that works, never a ring centred on nothing.
  if (!("stateVar" in apply)) {
    throw new Error(
      `carousel references action "${applyName}", which inserts a segment and holds no current value to centre on — a carousel needs a { set, from } or { persist, from } action`,
    );
  }
  const store = runtime.store;
  if (!store.has(apply.stateVar)) {
    throw new Error(
      `carousel references action "${applyName}", whose key "${apply.stateVar}" no variable reads back, so there is no current value to centre on — declare { kind: "state", key: "${apply.stateVar}" } among the variables`,
    );
  }
  const declared = runtime.compiled.get(applyName)!;
  const sessionId = readVar(store, "session.id");
  const { options } = apply;
  const count = options.length;
  const current = readVar(store, apply.stateVar);
  // [LAW:one-source-of-truth] THE "unknown current counts as the first member"
  // rule every enumerated control folds over (render/action.ts cycleIndex), so
  // a value outside the domain rotates exactly as a cycle over it would. The
  // centre is then an option, not the value — which is why "current" below is
  // the picker's own comparison, never "is the centre".
  const centre = Math.max(options.indexOf(current), 0);
  const indexAt = (offset: number): number =>
    (((centre + offset) % count) + count) % count;
  const ring = (offset: number): string => options[indexAt(offset)]!;
  // Each offset's click is realized once: the arrow and the neighbour name
  // beside it write the same option.
  const urls = new Map<number, string>();
  const url = (offset: number): string => {
    const known = urls.get(offset);
    if (known !== undefined) return known;
    const made = effectsUrl(
      realize(declared, ring(offset), ring(offset), store, sessionId).effects,
    );
    urls.set(offset, made);
    return made;
  };
  const option = (offset: number): RichText =>
    linkFragment(
      ring(offset),
      url(offset),
      ring(offset) === current,
      itemStyle({ index: indexAt(offset), count }, ring(offset)),
    );

  const base =
    cellWidth(CAROUSEL_PREV) +
    1 +
    cellWidth(ring(0)) +
    1 +
    cellWidth(CAROUSEL_NEXT);
  const levels = neighbourLevels(
    ring,
    count,
    base,
    ledRowBudget(runtime),
    neighbours,
  );
  const side = (sign: number): RichText[] =>
    Array.from({ length: levels }, (_, i) => option(sign * (i + 1)));

  return assemble(
    [
      ...side(-1).reverse(),
      linkFragment(CAROUSEL_PREV, url(-1), false),
      option(0),
      linkFragment(CAROUSEL_NEXT, url(1), false),
      ...side(1),
    ],
    true,
  );
}

// [LAW:one-type-per-behavior] Options are coloured by the ONE rule both picker
// shapes share (`optionItemStyle`): a colour-valued domain paints each name in
// the palette it would apply, any other domain places it in the band.
export function carouselFuncs(
  runtime: ActionRuntime,
  activeSegment: ActiveSegmentRef,
): FuncMap {
  return {
    carousel: {
      // `neighbours` caps how many options each side of the centre may show;
      // width still decides within the cap. `0` is the bare stepper
      // `◀ CURRENT ▶` — the shape a bar cell wants, since the ring's
      // neighbours are what makes it wide. Omitted = as many as fit.
      //
      // [LAW:no-silent-failure] The slot is `float`, not `int`: the engine's
      // `int` gate truncates 1.5 to 1 before this body runs, so a cap that is
      // not a count of levels would become some other ring silently. And the
      // engine repeats the trailing slot, so a third argument would be
      // accepted and dropped — both are refused here, by name.
      fn: (applyName: string, neighbours?: number, ...extra: number[]) => {
        if (extra.length > 0) {
          throw new Error(
            `carousel "${applyName}": takes at most one neighbours count after the action name, got ${1 + extra.length}`,
          );
        }
        if (
          neighbours !== undefined &&
          !(Number.isInteger(neighbours) && neighbours >= 0)
        ) {
          throw new Error(
            `carousel "${applyName}": neighbours must be a whole number ≥ 0 (0 shows only ◀ CURRENT ▶), got ${String(neighbours)}`,
          );
        }
        const cap = neighbours ?? Infinity;
        const apply = requireOptionKind(runtime, applyName, "carousel");
        return renderCarousel(
          applyName,
          apply,
          runtime,
          optionItemStyle(
            requireActiveSegment(activeSegment, "{{ carousel }}"),
            placedBy(undefined),
            runtime.basePalette,
            apply.paletteOf,
            activeSegment.drawnAt(),
          ),
          cap,
        );
      },
      argTypes: ["string", "float"],
      returnType: "T",
    },
  };
}

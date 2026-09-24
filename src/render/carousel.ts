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
import { Style } from "@promptctl/rich-js";
import type { FuncMap } from "@promptctl/go-template-js";
import { effectsUrl } from "../click/wire.js";
import { DISCLOSURE_GLYPH_CLOSE } from "../config/disclosure.js";
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
  requireOptionKind,
  rowBudget,
  type ItemStyle,
} from "./picker.js";

export const CAROUSEL_PREV = "◀";
export const CAROUSEL_NEXT = "▶";

// A neighbour is an option you can SEE but have not applied: the same cell the
// option would wear at the centre, dimmed, so the eye finds the centre first.
const NEIGHBOUR = new Style({ dim: true });

// [LAW:dataflow-not-control-flow] How many neighbours each side gets is a pure
// function of widths: whole symmetric levels are added while the row still
// fits, never more than the ring holds without showing one option twice.
// `ring(d)` is the option d steps from the centre (negative = before it).
// Exported for unit testing.
export function neighbourLevels(
  ring: (offset: number) => string,
  count: number,
  base: number,
  available: number,
): number {
  const most = Math.floor((count - 1) / 2);
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
  runtime: ActionRuntime,
  itemStyle: ItemStyle,
): RichText {
  const apply = requireOptionKind(runtime, applyName);
  // [LAW:no-silent-failure] A carousel is centred on the value its key holds;
  // a structural insert (layout-op-option) holds none, so there is no centre to
  // draw. Loud, naming the shape that works — never a ring centred on nothing.
  if (!("stateVar" in apply)) {
    throw new Error(
      `carousel references action "${applyName}", which inserts a segment and holds no current value to centre on — a carousel needs a { set, from } or { persist, from } action`,
    );
  }
  const declared = runtime.compiled.get(applyName)!;
  const store = runtime.store;
  const sessionId = readVar(store, "session.id");
  const { options } = apply;
  const count = options.length;
  // [LAW:one-source-of-truth] THE "unknown current counts as the first member"
  // rule every enumerated control folds over (render/action.ts cycleIndex), so
  // a value outside the domain rotates exactly as a cycle over it would.
  const centre = Math.max(options.indexOf(readVar(store, apply.stateVar)), 0);
  const indexAt = (offset: number): number =>
    (((centre + offset) % count) + count) % count;
  const ring = (offset: number): string => options[indexAt(offset)]!;
  const url = (offset: number): string =>
    effectsUrl(
      realize(declared, ring(offset), ring(offset), store, sessionId).effects,
    );
  const option = (offset: number, emphasis: Style | undefined): RichText =>
    linkFragment(
      ring(offset),
      url(offset),
      offset === 0,
      Style.combine([
        itemStyle({ index: indexAt(offset), count }, ring(offset)),
        emphasis,
      ]),
    );

  // The row a disclosure body leads with ✕ spends that width before the
  // carousel's own; reserved whether or not this carousel sits in a body, so a
  // bare one fits the same row a body's would.
  const available =
    rowBudget(runtime) - (cellWidth(DISCLOSURE_GLYPH_CLOSE) + 1);
  const base =
    cellWidth(CAROUSEL_PREV) +
    1 +
    cellWidth(ring(0)) +
    1 +
    cellWidth(CAROUSEL_NEXT);
  const levels = neighbourLevels(ring, count, base, available);
  const side = (sign: number): RichText[] =>
    Array.from({ length: levels }, (_, i) => option(sign * (i + 1), NEIGHBOUR));

  return assemble(
    [
      ...side(-1).reverse(),
      linkFragment(CAROUSEL_PREV, url(-1), false),
      option(0, undefined),
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
      fn: (applyName: string) =>
        renderCarousel(
          applyName,
          runtime,
          optionItemStyle(
            requireActiveSegment(activeSegment, "{{ carousel }}"),
            placedBy(undefined),
            runtime.basePalette,
            requireOptionKind(runtime, applyName).paletteOf,
            activeSegment.drawnAt(),
          ),
        ),
      argTypes: ["string"],
      returnType: "T",
    },
  };
}

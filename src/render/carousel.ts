// [LAW:one-type-per-behavior] A `{{ carousel "apply" "open" "label" }}` is the
// picker's other shape over the SAME thing: one option-domain action, its
// resolved members, its gated click (brandon-theme-picker-bgw.ef6). It is the
// closed face of a choice —
//
//     ◀ label ▶
//
// — where the label says what is being set, the arrows apply the option either
// side of the value in force, and a click on the label fires `open`, which
// expands the list of every option.
//
// [LAW:one-source-of-truth] The carousel owns no position. Its ring is centred
// on the action's current value, read through the action's own `stateVar` (for
// the settings menu's controls, the `.effective` projection the bar rendered
// with), so the arrows and the bar cannot disagree, and there is no cursor key
// to gate, reset, or leave stale. Each click writes through `realize` — the
// same fold `{{ action }}` and the picker's option cells use.
//
// [LAW:one-way-deps] Lives in render/ beside the picker, injected into the
// engine by registerDslConfig as data; the generic engine never imports it.

import type { RichText } from "@promptctl/rich-js";
import type { FuncMap } from "@promptctl/go-template-js";
import { effectsUrl } from "../click/wire.js";
import {
  bindsTemplateValue,
  linkFragment,
  linkOver,
  readVar,
  realize,
  renderBinding,
  renderLook,
  type ActionRuntime,
} from "./action.js";
import { labelPaint } from "./option-paint.js";
import { assemble, requireOptionKind, type OptionAction } from "./picker.js";

export const CAROUSEL_PREV = "◀";
export const CAROUSEL_NEXT = "▶";

// [LAW:types-are-the-program] A ring over a domain's options, around the
// value its key holds. A ring's options are peers with no resting state, so a
// held value that is none of them — another writer's value, in the key's
// domain but not on this list — is shown as itself, sitting between the last
// option and the first: ▶ steps to the first, ◀ to the last. (A cycle's list
// is the states of one thing, resting state first, so it reads such a value
// as that resting state instead: render/action.ts cycleIndex.) A value
// outside the key's domain never reaches a ring: the session's read refused
// it (src/daemon/foundations/judged-state.ts). The carousel and a
// `{{ swatches }}` row's ◀ ▶ step through this one ring. Over a domain that
// is not empty.
export interface Ring {
  // The held value's index, or undefined when it is no option.
  readonly at: number | undefined;
  readonly next: number;
  readonly prev: number;
}

export function ringAround(options: readonly string[], current: string): Ring {
  const count = options.length;
  const found = options.indexOf(current);
  const at = found === -1 ? undefined : found;
  return {
    at,
    // Between the last and the first: -1 steps forward to the first, and
    // `count` steps back to the last.
    next: ((at ?? -1) + 1) % count,
    prev: ((at ?? count) - 1 + count) % count,
  };
}

export function renderCarousel(
  applyName: string,
  apply: OptionAction,
  openName: string,
  label: string,
  runtime: ActionRuntime,
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
  const store = renderBinding(runtime, "carousel").store;
  if (!store.has(apply.stateVar)) {
    throw new Error(
      `carousel references action "${applyName}", whose key "${apply.stateVar}" no variable reads back, so there is no current value to centre on — declare { kind: "state", key: "${apply.stateVar}" } among the variables`,
    );
  }
  const declared = runtime.compiled.get(applyName)!;
  const sessionId = readVar(store, "session.id");
  const { options } = apply;
  // [LAW:dataflow-not-control-flow] An empty domain holds nothing to step to
  // or show, so the ring is empty, as a grid over it has no cells.
  if (options.length === 0) return assemble([]);
  const held = readVar(store, apply.stateVar);
  const ring = ringAround(options, held);
  const step = (to: number): string =>
    effectsUrl(
      runtime.links.to,
      realize(
        declared,
        options[to]!,
        options[to]!,
        store,
        sessionId,
        runtime.links.signer,
      ).effects,
    );

  return assemble([
    linkFragment(CAROUSEL_PREV, step(ring.prev), false),
    linkOver(
      // Drawn as the arrows are, in the segment's own colours (Brandon: "The
      // name loses its styling"), beside the swatch of the value in force
      // when the domain is colour-valued. A domain's palette answers only for
      // its own options, so a held value that is none of them draws the
      // label alone.
      labelPaint(
        renderLook(runtime, "{{ carousel }}"),
        ring.at === undefined ? undefined : apply.paletteOf,
        held,
        label,
      ),
      effectsUrl(
        runtime.links.to,
        realize(
          runtime.compiled.get(openName)!,
          held,
          undefined,
          store,
          sessionId,
          runtime.links.signer,
        ).effects,
      ),
    ),
    linkFragment(CAROUSEL_NEXT, step(ring.next), false),
  ]);
}

export function carouselFuncs(runtime: ActionRuntime): FuncMap {
  return {
    carousel: {
      fn: (applyName: string, openName: string, label: string) => {
        // [LAW:no-silent-failure] A computed label can come up empty, and a
        // control with no name says nothing and leaves no text to click.
        if (label.trim() === "") {
          throw new Error(`carousel "${applyName}": label is empty`);
        }
        if (!runtime.compiled.has(openName)) {
          throw new Error(
            `carousel "${applyName}": open must name a declared action, got ${JSON.stringify(openName)}`,
          );
        }
        // The label fires with nothing bound, so an action that writes a bound
        // value would write the option the ring sits on instead.
        if (bindsTemplateValue(runtime.compiled.get(openName)!)) {
          throw new Error(
            `carousel "${applyName}": open "${openName}" writes a value the template binds, and the label binds none — name an action that writes a fixed value, a cycle, or a do of them`,
          );
        }
        return renderCarousel(
          applyName,
          requireOptionKind(runtime, applyName, "carousel"),
          openName,
          label,
          runtime,
        );
      },
      argTypes: ["string", "string", "string"],
      arity: { kind: "exact" },
      returnType: "T",
    },
  };
}

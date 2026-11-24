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
// with), so the label and the bar cannot disagree, and there is no cursor key
// to gate, reset, or leave stale. An arrow carries its step, a link that means
// the same on every draw; the click resolves it from the value the key holds
// when it lands (realizeRing, render/action.ts), so N clicks that arrive before
// the bar has redrawn land N steps.
//
// [LAW:one-way-deps] Lives in render/ beside the picker, injected into the
// engine by registerDslConfig as data; the generic engine never imports it.

import type { RichText } from "@promptctl/rich-js";
import type { FuncMap } from "@promptctl/go-template-js";
import { actionTarget, type DrawnAction } from "./drawn-link.js";
import {
  linkFragment,
  linkOver,
  clickSession,
  readVar,
  realize,
  realizeRing,
  renderBinding,
  renderLook,
  type ActionRuntime,
} from "./action.js";
import { labelPaint } from "./option-paint.js";
import { centreOf, stepOffset } from "./option-ring.js";
import { assemble, requireOptionKind, type OptionAction } from "./picker.js";

export const CAROUSEL_PREV = "◀";
export const CAROUSEL_NEXT = "▶";

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
  const binding = renderBinding(runtime, "carousel");
  const { store } = binding;
  if (!store.has(apply.stateVar)) {
    throw new Error(
      `carousel references action "${applyName}", whose key "${apply.stateVar}" no variable reads back, so there is no current value to centre on — declare { kind: "state", key: "${apply.stateVar}" } among the variables`,
    );
  }
  const declared = runtime.compiled.get(applyName)!;
  const sessionId = clickSession(runtime, "carousel");
  const { options } = apply;
  // [LAW:dataflow-not-control-flow] An empty domain holds nothing to step to
  // or show, so the ring is empty, as a grid over it has no cells.
  if (options.length === 0) return assemble([]);
  const shown = options[centreOf(options, readVar(store, apply.stateVar))]!;
  const step = (by: number): DrawnAction =>
    actionTarget(
      realizeRing(
        declared,
        apply,
        applyName,
        stepOffset(by),
        [],
        binding,
        sessionId,
      ),
    );

  return assemble([
    linkFragment(CAROUSEL_PREV, step(-1), false),
    linkOver(
      // Drawn as the arrows are, in the segment's own colours (Brandon: "The
      // name loses its styling"), beside the swatch of the value in force
      // when the domain is colour-valued.
      labelPaint(
        renderLook(runtime, "{{ carousel }}"),
        apply.paletteOf,
        shown,
        label,
      ),
      actionTarget(
        realize(
          runtime.compiled.get(openName)!,
          shown,
          undefined,
          binding,
          sessionId,
        ).effects,
      ),
    ),
    linkFragment(CAROUSEL_NEXT, step(1), false),
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
        const open = runtime.compiled.get(openName);
        if (open === undefined) {
          throw new Error(
            `carousel "${applyName}": open must name a declared action, got ${JSON.stringify(openName)}`,
          );
        }
        // The label fires with nothing bound, so an action that writes a bound
        // value would write the option the ring sits on instead.
        if (open.bindsTemplateValue) {
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

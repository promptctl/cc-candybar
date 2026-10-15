// [LAW:one-source-of-truth] The floor style, as a fixture's `EffectiveGlobals`
// and `RenderSelection` want it (brandon-looks-pe6). `globals.style` may hold an
// expression now, so the resolution crossing both seams is a `StyleSelection`
// rather than a name — and a fixture that means "no style" says so once, here,
// instead of each file re-spelling the decided arm's shape and drifting from it
// when that shape changes.
import {
  decideEffectName,
  decideStyleName,
  EFFECT_FLOOR,
  type DecidedEffect,
  type DecidedStyle,
} from "../../src/themes";

export const FLOOR_STYLE: DecidedStyle = decideStyleName("none", {});

// The effect's twin: a fixture that means "no effect" says so here, once.
export const FLOOR_EFFECT: DecidedEffect = decideEffectName(EFFECT_FLOOR);

// What a pointer does to a region: a button, alone or with modifiers held.
// `left` is the plain click every link carries; any other gesture is a binding
// the tmux bar pane delivers (src/bar-pane).
//
// [LAW:one-source-of-truth] A gesture has one spelling, so the config's `on:`
// keys, a published link's gesture and a pane's decoded press all meet as the
// same string.

import type { Asked } from "../utils/outcome.js";

export const BUTTONS = ["left", "middle", "right"] as const;
export type Button = (typeof BUTTONS)[number];

// The one order modifiers are spelled in.
export const MODIFIERS = ["ctrl", "alt", "shift"] as const;
export type Modifier = (typeof MODIFIERS)[number];

export interface Gesture {
  readonly button: Button;
  readonly modifiers: ReadonlySet<Modifier>;
}

// A gesture as one canonical string: `[ctrl+][alt+][shift+]<button>`.
export type GestureName = string;

export const PLAIN_CLICK: GestureName = "left";

export function gestureName({ button, modifiers }: Gesture): GestureName {
  return [...MODIFIERS.filter((m) => modifiers.has(m)), button].join("+");
}

// [LAW:parse-dont-validate] The only way a config's spelling becomes a
// gesture. Any order of modifiers is read, and the canonical name is what the
// gesture carries on, so two spellings of one gesture can't be two bindings.
export function parseGesture(text: string): Asked<Gesture> {
  const words = text.split("+");
  const last = words.pop();
  const button = BUTTONS.find((b) => b === last);
  if (button === undefined)
    return {
      kind: "failed",
      reason: `"${text}" is not a gesture: it ends in a button (${BUTTONS.join(", ")}), after any of ${MODIFIERS.join(", ")} joined by +`,
    };
  const modifiers = new Set<Modifier>();
  for (const word of words) {
    const modifier = MODIFIERS.find((m) => m === word);
    if (modifier === undefined)
      return {
        kind: "failed",
        reason: `"${text}" is not a gesture: "${word}" is not a modifier (${MODIFIERS.join(", ")})`,
      };
    if (modifiers.has(modifier))
      return {
        kind: "failed",
        reason: `"${text}" is not a gesture: it names ${modifier} twice`,
      };
    modifiers.add(modifier);
  }
  return { kind: "ok", value: { button, modifiers } };
}

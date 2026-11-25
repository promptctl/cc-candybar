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

// What a surface delivers to the draw: gestures, and hover, which no link
// carries and only a follower that sees the pointer move can report.
export const HOVER = "hover";
export type Delivered = GestureName | typeof HOVER;

// [LAW:one-source-of-truth] What the follower that owns a session's pointer
// says of it: the gestures its surface delivers, and the action the pointer
// last stood on (null: none). It lives as long as the owner's subscription and
// is never session state.
export interface Pointer {
  readonly gestures: readonly Delivered[];
  readonly hover: string | null;
}

// [LAW:one-source-of-truth] Every gesture a pane can decode: each button with
// each subset of the modifiers, in canonical spelling. What a pane with a
// working mouse says it delivers, beside hover.
export const ALL_GESTURES: readonly GestureName[] = BUTTONS.flatMap((button) =>
  Array.from({ length: 1 << MODIFIERS.length }, (_, bits) =>
    gestureName({
      button,
      modifiers: new Set(MODIFIERS.filter((_m, i) => (bits & (1 << i)) !== 0)),
    }),
  ),
);

// [LAW:parse-dont-validate] The one spelling of a gesture or hover, read:
// what an action's `on:` key and a pane's delivered list are both made of.
export function parseOneDelivered(entry: unknown): Asked<Delivered> {
  if (typeof entry !== "string")
    return {
      kind: "failed",
      reason: `a delivered gesture is a string: got ${JSON.stringify(entry)}`,
    };
  if (entry === HOVER) return { kind: "ok", value: HOVER };
  const gesture = parseGesture(entry);
  return gesture.kind === "ok"
    ? { kind: "ok", value: gestureName(gesture.value) }
    : gesture;
}

// [LAW:parse-dont-validate] A pane's list of what it delivers, read once: each
// entry canonical, a repeat read once, and a spelling that is neither a gesture
// nor hover refused by name.
export function parseDelivered(
  entries: readonly unknown[],
): Asked<readonly Delivered[]> {
  const delivered: Delivered[] = [];
  for (const entry of entries) {
    const name = parseOneDelivered(entry);
    if (name.kind !== "ok") return name;
    if (!delivered.includes(name.value)) delivered.push(name.value);
  }
  return { kind: "ok", value: delivered };
}

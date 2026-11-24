// What a click means on a surface whose links carry only the plain click: the
// statusline, and a pane tmux delivers no mouse to. A three-way mode the user
// cycles, kept in the session, that picks which of a region's gestures the
// click runs. A surface that delivers a mode's gesture itself ignores the mode:
// a pane with a working mouse draws every region by its own gestures.

import { HOVER, PLAIN_CLICK, type Delivered } from "../click/gesture.js";
import { SETTINGS_NS } from "./reserved-names.js";

export const CLICK_MODES = ["click", "hover", "alt"] as const;
export type ClickMode = (typeof CLICK_MODES)[number];
// [LAW:one-source-of-truth] What a session holds before anyone picks, which a
// never-written key reads as: the first member of the cycle.
export const DEFAULT_CLICK_MODE: ClickMode = CLICK_MODES[0];

// The session keys: the mode, and the action a click last made hovered. Hover
// reads the second only where no pane reports the pointer itself.
export const CLICK_MODE_KEY = `${SETTINGS_NS}clickMode`;
export const HOVER_KEY = `${SETTINGS_NS}hover`;
// What the hover key holds for no action: a name no author can declare, since
// the namespace is reserved.
export const NO_HOVER = `${SETTINGS_NS}none`;

// The draw input that says what the surface delivers (src/render/pointer-facts.ts).
export const SURFACE_VAR = "surface";

// [LAW:one-source-of-truth] The actions the draw reaches for by name: the one
// a click in hover mode runs for a region that binds none of its own (it makes
// the region hovered), and the one that puts hover away, which the mode toggle
// runs beside stepping the mode.
export const HOVER_REGION = `${SETTINGS_NS}hoverRegion`;
export const HOVER_CLEAR = `${SETTINGS_NS}hoverClear`;

// [LAW:one-source-of-truth] The gesture a click runs in each mode. A region's
// link is its binding for that gesture (`on:`), so a region declares what it
// does in a mode as data, and nothing in the draw names a region.
export const MODE_GESTURE: Readonly<Record<ClickMode, Delivered>> = {
  click: PLAIN_CLICK,
  hover: HOVER,
  alt: "alt+left",
};

// The mode in force: the session's, unless the surface delivers that mode's
// gesture natively. A value no mode spells (a key never written) is the
// default.
export function modeInForce(
  stored: string | undefined,
  surface: string,
): ClickMode {
  const mode = CLICK_MODES.find((m) => m === stored) ?? DEFAULT_CLICK_MODE;
  return surface.split(" ").includes(MODE_GESTURE[mode])
    ? DEFAULT_CLICK_MODE
    : mode;
}

// Whether the session holds a mode other than the default: state that stands
// open until the idle period that closes menus ends it.
export const modeIsOpen = (stored: string | undefined): boolean =>
  CLICK_MODES.some((m) => m === stored && m !== DEFAULT_CLICK_MODE);

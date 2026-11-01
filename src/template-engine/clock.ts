// [LAW:types-are-the-program] What a clock function reads: the draw in
// progress — the instant it is drawn at, and the frame rich-js's animation
// functions are evaluated for at that instant, which carries the session's
// animation timeline and hears every hold they draw (brandon-menus-sjhy.nt2).
// The engine holds the one Clock (template-engine/engine.ts); a template
// function reaches it only by being built by a ClockFactory the engine invokes,
// so no clock is a value a caller can capture.
import type { FuncMap } from "@promptctl/go-template-js";
import type { Timeline } from "@promptctl/rich-js";
import type { TemplateFrame } from "@promptctl/rich-js/template-bindings";

export interface Clock {
  now(): Date;
  // The frame an animation function draws for: the draw's instant, on the host
  // clock, and where it tells the hold it drew.
  frame(): TemplateFrame;
  // The session's animation timeline: what decoration's `frames` and `stepped`
  // run through, at the session's speed.
  timeline(): Timeline;
}

// The functions that read the clock. The engine invokes each factory itself and
// records the names it returns: those names are the clock functions, and a
// template calling one is a projection (src/config/loader/projections.ts).
export type ClockFactory = (clock: Clock) => FuncMap;

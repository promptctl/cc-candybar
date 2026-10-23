// [LAW:types-are-the-program] What a clock function reads: the draw in
// progress — the instant it is drawn at, and its session's animation clock read
// at that instant (brandon-menus-sjhy.nt2). The engine holds the one Clock
// (template-engine/engine.ts); a template function reaches it only by being
// built by a ClockFactory the engine invokes, so no clock is a value a caller
// can capture.
import type { FuncMap } from "@promptctl/go-template-js";
import type { AnimationTime } from "../utils/instant.js";

export interface Clock {
  now(): Date;
  animatedAt(): AnimationTime;
}

// The functions that read the clock. The engine invokes each factory itself and
// records the names it returns: those names are the clock functions, and a
// template calling one is a projection (src/config/loader/projections.ts).
export type ClockFactory = (clock: Clock) => FuncMap;

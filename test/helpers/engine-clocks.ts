// The clocks a test engine that renders no bar reads: the wall clock, and an
// animation clock running at 1x on it — what a session that never moved its
// animation speed reads (brandon-menus-sjhy.nt2).
import type { AnimationTime } from "../../src/utils/instant";

export const WALL_CLOCKS = {
  clock: (): Date => new Date(),
  animatedAt: (): AnimationTime => (Date.now() / 1000) as AnimationTime,
};

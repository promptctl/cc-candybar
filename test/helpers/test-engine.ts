// What a test engine that renders no bar is built with: a truecolor depth,
// since no render publishes one. Its clock is the engine's own, read only
// inside a draw — a test that reads the time binds one (`drawingNow`).
import { ColorDepth } from "@promptctl/rich-js";
import { bindClock } from "../../src/template-engine/engine";
import { instantOf, type AnimationTime } from "../../src/utils/instant";

export const TEST_ENGINE = {
  drawnAt: (): ColorDepth => ColorDepth.TRUECOLOR,
};

// A draw at `date` (now, by default), its animation clock at 1x on it — what a
// session that never moved its animation speed reads (brandon-menus-sjhy.nt2).
export function drawingAt(date: Date = new Date()): Disposable {
  return bindClock(instantOf(date), (date.getTime() / 1000) as AnimationTime);
}

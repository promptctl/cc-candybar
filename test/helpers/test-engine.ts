// What a test engine that renders no bar is built with: a truecolor depth,
// since no render publishes one. Its clock is the engine's own, read only
// inside a draw — a test that reads the time binds one (`drawingNow`).
import { ColorDepth, Timeline } from "@promptctl/rich-js";
import { bindClock } from "../../src/template-engine/engine";
import { instantOf } from "../../src/utils/instant";

export const TEST_ENGINE = {
  drawnAt: (): ColorDepth => ColorDepth.TRUECOLOR,
};

// A draw at `date` (now, by default), its animation timeline the host clock at
// 1x — what a session that never moved its animation speed reads
// (brandon-menus-sjhy.nt2).
export function drawingAt(date: Date = new Date()): Disposable {
  return bindClock(instantOf(date), Timeline.play(0));
}

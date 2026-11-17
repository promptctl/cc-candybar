// One frame of a session's motion, composed as `drawDsl` composes it
// (src/dsl/render.ts): the walk reports each placement to the motion, the
// record keeps what comes back, and `drawn` keeps the memory the frame left,
// as the turn that drew a frame does.
import type {
  FrameClock,
  FrameTransitions,
  MenuFlash,
  SessionEffects,
} from "../../src/render/effect.js";
import { beginRecord } from "../../src/render/frame-memory.js";
import type { EffectName } from "../../src/themes/policy.js";

export function framed<Line>(
  fx: SessionEffects<Line>,
  name: EffectName,
  clock: FrameClock,
  given: FrameTransitions<Line>,
  flash: MenuFlash = null,
) {
  const record = beginRecord(given.source, given.returned);
  const motion = fx.motion(name, clock, given, flash);
  return {
    placed: (id: string, lines: readonly Line[]) =>
      record.placed(id, motion.placed(id, lines)),
    row: motion.row,
    drawn: () => fx.keep(motion.memory(record.record())),
  };
}

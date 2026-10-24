// One frame of a session's motion drawn over a view's frame memory, composed as
// `drawDsl` composes them (src/dsl/render.ts): the walk reports each placement
// to the motion, the view records what comes back, and the record is kept once
// the frame is drawn.
import type {
  FrameClock,
  FrameTransitions,
  MenuFlash,
  SessionEffects,
} from "../../src/render/effect.js";
import type { FrameMemory } from "../../src/render/frame-memory.js";
import type { EffectName } from "../../src/themes/policy.js";

export function framed<Line>(
  fx: SessionEffects<Line>,
  memory: FrameMemory<Line>,
  name: EffectName,
  clock: FrameClock,
  given: Omit<FrameTransitions<Line>, "last">,
  flash: MenuFlash = null,
) {
  const record = memory.begin(given.source, given.returned);
  const motion = fx.motion(
    name,
    clock,
    { ...given, last: memory.recorded },
    flash,
  );
  return {
    placed: (id: string, lines: readonly Line[]) =>
      record.placed(id, motion.placed(id, lines)),
    row: motion.row,
    drawn: () => {
      motion.drawn();
      record.commit();
    },
  };
}

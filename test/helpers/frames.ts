// One frame of a session's motion drawn over a surface's record of its last
// frame, composed as `drawDsl` composes them (src/dsl/render.ts): the walk
// reports each placement to the motion, the record keeps what comes back, and
// `drawn` keeps what the frame left — the record in the surface's holder, the
// motion in the session's effects — as the turn that drew a frame does.
import type {
  FrameClock,
  FrameTransitions,
  MenuFlash,
  SessionEffects,
} from "../../src/render/effect.js";
import {
  beginRecord,
  recordFrom,
  type FrameRecord,
} from "../../src/render/frame-memory.js";
import type { EffectName } from "../../src/themes/policy.js";

// What a surface keeps of its last frame, as a view keeps it.
export interface SurfaceRecord<Line> {
  last: FrameRecord<Line> | undefined;
}
export const surfaceRecord = <Line>(): SurfaceRecord<Line> => ({
  last: undefined,
});

export function framed<Line>(
  fx: SessionEffects<Line>,
  surface: SurfaceRecord<Line>,
  name: EffectName,
  clock: FrameClock,
  given: Omit<FrameTransitions<Line>, "last">,
  flash: MenuFlash = null,
) {
  const record = beginRecord(given.source, given.returned);
  const motion = fx.motion(
    name,
    clock,
    { ...given, last: recordFrom(surface.last ?? null, given.source) },
    flash,
  );
  return {
    placed: (id: string, lines: readonly Line[]) =>
      record.placed(id, motion.placed(id, lines)),
    row: motion.row,
    drawn: () => {
      const left = motion.memory();
      fx.keep(left.motion);
      surface.last = record.record(left.passages);
    },
  };
}

// The main renderer, in process: today's request answer behind the renderer
// interface (src/renderer/interface.ts). A request's turn draws the bar and
// returns it as a `present`; that present's `effect-done` records what the
// frame showed, once the host says whether its client took it.

import { answerRequest, type RendererParts } from "../daemon/draw-bar.js";
import type { RequestFacts } from "../daemon/request-event.js";
import type { Instant } from "../utils/instant.js";
import {
  TurnThrew,
  type EffectId,
  type Event,
  type Renderer,
  type RendererOutput,
} from "./interface.js";

export function mainRenderer(parts: RendererParts): Renderer {
  // [LAW:single-enforcer] What each present's frame records once it reached
  // its client, held from the turn that returned it until its one
  // `effect-done`: the host settles every present it is handed, so this
  // holds only presents still on their way.
  const deliveries = new Map<EffectId, () => void>();
  let minted = 0;

  const turn = async (
    event: Event,
    at: Instant,
    record: RequestFacts,
  ): Promise<RendererOutput> => {
    switch (event.kind) {
      case "request": {
        const { frame, delivered } = await answerRequest(
          parts,
          event.context,
          at,
          event.waitEndsAt,
          record,
        );
        const id = ++minted as EffectId;
        deliveries.set(id, delivered);
        return {
          effects: [
            {
              kind: "present",
              id,
              session: event.context.sessionId,
              surface: "statusline",
              request: event.id,
              frame,
            },
          ],
          record,
        };
      }
      case "effect-done": {
        const delivered = deliveries.get(event.of);
        // [LAW:no-silent-failure] An effect this renderer never returned, or
        // one already settled, is the host's bug: said, never ignored.
        if (delivered === undefined)
          throw new Error(
            `effect-done for effect ${event.of}, which is not a present on its way`,
          );
        deliveries.delete(event.of);
        if (event.outcome.kind === "ok") delivered();
        return { effects: [], record };
      }
    }
  };

  return {
    answer: async ({ event, at }) => {
      const record: RequestFacts = [];
      try {
        return await turn(event, at, record);
      } catch (thrown) {
        throw new TurnThrew(record, thrown);
      }
    },
  };
}

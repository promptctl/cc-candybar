// The main renderer, in process: today's request answer behind the renderer
// interface (src/renderer/interface.ts). A `config` turn records the
// session's context and opens its view there, so its output names what the
// view reads before the request after it waits. A request's turn holds that
// view at its own context, draws the bar and returns it as a `present`; that
// present's `effect-done` records what the frame showed, once the host says
// whether its client took it. A world state the host hands in, with a
// `config` or alone, is what the session's views draw from, and a retire ends
// what the renderer holds of the session. Every output says what the open
// views need read.

import {
  answerRequest,
  configureSession,
  retireSession,
  type RendererParts,
} from "../daemon/draw-bar.js";
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

  // [LAW:one-source-of-truth] What a turn's output says the renderer needs
  // read: the open views' subscriptions as they stand when it answers.
  const answered = (
    effects: RendererOutput["effects"],
    record: RequestFacts,
  ): RendererOutput => ({
    effects,
    subscriptions: parts.renderCache.subscriptions(),
    record,
  });

  const turn = async (
    event: Event,
    at: Instant,
    record: RequestFacts,
  ): Promise<RendererOutput> => {
    switch (event.kind) {
      case "config":
        configureSession(parts, event.context, event.worldState, at, record);
        return answered([], record);
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
        return answered(
          [
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
        );
      }
      case "world-state":
        parts.worldStates.take(event.worldState);
        return answered([], record);
      case "retire":
        retireSession(parts, event.session);
        return answered([], record);
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
        return answered([], record);
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

// The main renderer, in process: today's request answer behind the renderer
// interface (src/renderer/interface.ts). A `config` turn records the
// session's context and opens its view there, so its output names what the
// view reads before the request after it waits. A request's turn holds that
// view at its own context, draws the bar and returns it as a `present`; that
// present's `effect-done` records what the frame showed, once the host says
// whether its client took it. A world state the host hands in, with a
// `config` or alone, is what the session's views draw from, and a retire ends
// what the renderer holds of the session. A click, and the idle clock's close
// of a session's menus, act in their turn. Every output says what the open
// views need read, as they stand once the turn's act has landed.

import {
  answerRequest,
  configureSession,
  retireSession,
} from "../daemon/draw-bar.js";
import type { RequestFacts } from "../daemon/request-event.js";
import { clickTurn } from "./click.js";
import type { MainRendererParts } from "./verbs.js";
import type { Instant } from "../utils/instant.js";
import { failureOf } from "../daemon/verb-error.js";
import type { Effect, EffectId, Event, Renderer } from "./interface.js";

export function mainRenderer(parts: MainRendererParts): Renderer {
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
  ): Promise<readonly Effect[]> => {
    switch (event.kind) {
      case "config":
        configureSession(parts, event.context, event.worldState, at, record);
        return [];
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
        return [
          {
            kind: "present",
            id,
            session: event.context.hookData.session_id,
            surface: "statusline",
            request: event.id,
            frame,
          },
        ];
      }
      case "world-state":
        parts.worldStates.take(event.worldState);
        return [];
      case "retire":
        retireSession(parts, event.session);
        return [];
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
        return [];
      }
      case "click":
        await clickTurn(parts, event, record);
        return [];
      case "menu-idle":
        await parts.verbs.closeIdle(event.session, event.idle);
        return [];
    }
  };

  return {
    answer: async ({ event, at }) => {
      const record: RequestFacts = [];
      const ended = await turn(event, at, record).then(
        (effects) => ({ kind: "answered", effects }) as const,
        // [LAW:single-enforcer] Classified here, where it was thrown: a class
        // crosses no process.
        (thrown: unknown) =>
          ({ kind: "threw", failure: failureOf(thrown) }) as const,
      );
      // [LAW:one-source-of-truth] What the renderer needs read: the open
      // views' subscriptions as they stand when the turn ends, however it
      // ended.
      return {
        ...ended,
        record,
        subscriptions: parts.renderCache.subscriptions(),
      };
    },
  };
}

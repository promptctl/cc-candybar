// The main renderer, in process: today's request answer behind the renderer
// interface (src/renderer/interface.ts). A `config` turn records the
// session's context and opens its view there, so its output names what the
// view reads before the request after it waits. A request's turn holds that
// view at its own context, draws the bar and returns it as a `present`; that
// present's `effect-done` records what the frame showed, once the host says
// whether its client took it. A click's copy is returned as a `copy`, and its
// `effect-done` holds a failure for the bar. A world state the host hands in, with a
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
import {
  TurnThrew,
  type Effect,
  type EffectId,
  type EffectOutcome,
  type Event,
  type Renderer,
} from "./interface.js";

export function mainRenderer(parts: MainRendererParts): Renderer {
  // [LAW:single-enforcer] What each effect does with its one `effect-done`,
  // held from the turn that returned it until then: a present records what
  // its frame showed once it reached its client, and a copy holds its failure
  // for the bar. The host settles every effect it is handed, so this holds
  // only effects still on their way.
  const owed = new Map<
    EffectId,
    (outcome: EffectOutcome, at: Instant) => void
  >();
  let minted = 0;

  const turn = async (
    event: Event,
    at: Instant,
    record: RequestFacts,
    // [LAW:one-source-of-truth] The turn's effects as it returns them, each
    // owed its `effect-done` from the moment it is added.
    owe: (
      effect: (id: EffectId) => Effect,
      settle: (outcome: EffectOutcome, at: Instant) => void,
    ) => void,
  ): Promise<void> => {
    switch (event.kind) {
      case "config":
        configureSession(parts, event.context, event.worldState, at, record);
        return;
      case "request": {
        const { frame, delivered } = await answerRequest(
          parts,
          event.context,
          at,
          event.waitEndsAt,
          record,
        );
        owe(
          (id) => ({
            kind: "present",
            id,
            session: event.context.hookData.session_id,
            surface: "statusline",
            request: event.id,
            frame,
          }),
          (outcome) => {
            if (outcome.kind === "ok") delivered();
          },
        );
        return;
      }
      case "world-state":
        parts.worldStates.take(event.worldState);
        return;
      case "retire":
        retireSession(parts, event.session);
        return;
      case "effect-done": {
        const settle = owed.get(event.of);
        // [LAW:no-silent-failure] An effect this renderer never returned, or
        // one already settled, is the host's bug: said, never ignored.
        if (settle === undefined)
          throw new Error(
            `effect-done for effect ${event.of}, which is not an effect on its way`,
          );
        owed.delete(event.of);
        settle(event.outcome, at);
        return;
      }
      case "click":
        await clickTurn(parts, event, record, (text) =>
          owe(
            (id) => ({ kind: "copy", id, text }),
            (outcome, settledAt) => {
              if (outcome.kind === "failed")
                parts.copyFailures.failed(outcome.reason, settledAt);
            },
          ),
        );
        return;
      case "menu-idle":
        await parts.verbs.closeIdle(event.session, event.idle);
        return;
    }
  };

  return {
    answer: async ({ event, at }) => {
      const record: RequestFacts = [];
      const effects: Effect[] = [];
      const owe = (
        effect: (id: EffectId) => Effect,
        settle: (outcome: EffectOutcome, at: Instant) => void,
      ): void => {
        const made = effect(++minted as EffectId);
        owed.set(made.id, settle);
        effects.push(made);
      };
      try {
        await turn(event, at, record, owe);
      } catch (thrown) {
        throw new TurnThrew(
          record,
          thrown,
          parts.renderCache.subscriptions(),
          effects,
        );
      }
      // [LAW:one-source-of-truth] What a turn's output says the renderer
      // needs read: the open views' subscriptions as they stand when it
      // answers.
      return {
        effects,
        subscriptions: parts.renderCache.subscriptions(),
        record,
      };
    },
  };
}

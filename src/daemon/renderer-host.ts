// The host's one path to a renderer: every input it hands one is one turn,
// which answers with the turn's output or with how the turn failed: a turn's
// throw comes back as a value, never as a rejection. Every turn's
// subscriptions are taken here, in the order the turns answered, and so is
// every effect a turn that answers no request returned, refused. A caller
// whose own event records the turn takes it by `answer`; every other input is
// taken by `deliver`, which writes the turn's own line.

import {
  type Effect,
  type Event,
  type Renderer,
  type RendererInput,
  type RendererOutput,
  type Subscriptions,
  type TurnRecord,
} from "../renderer/interface.js";
import { eventLine } from "../utils/logfmt.js";
import { instantAt } from "../utils/instant.js";
import type { Timekeeper } from "../time.js";
import type { DaemonLogger } from "../utils/logger";
import type { SessionId } from "./session-id.js";
import { LEVEL } from "./request-event.js";

// The only renderer there is yet: the main one, in process.
export type RendererName = "main";

export interface RendererHost {
  readonly name: RendererName;
  // One turn, recorded by the caller: a request's answer writes both its
  // turns on the request's render event.
  answer(input: RendererInput): Promise<RendererOutput>;
  // One turn, recorded on its own line. `about` is what the host knows of the
  // input beyond its session, for that line.
  deliver(input: RendererInput, about: TurnRecord): Promise<RendererOutput>;
}

export function rendererHost(
  name: RendererName,
  // The clock a refusal's `effect-done` is stamped by, when it is made.
  clock: Pick<Timekeeper, "now">,
  renderer: Renderer,
  log: DaemonLogger,
  collector: {
    // [LAW:single-enforcer] Where every output's subscriptions go: the
    // collector, which diffs each whole set against the last.
    readonly subscribed: (subscriptions: Subscriptions) => void;
    // [LAW:single-enforcer] [LAW:no-ambient-temporal-coupling] Every turn
    // holds the session its event names until it settles, so no sweep retires
    // a session under a turn on it, however long the turn waits.
    readonly holding: (session: SessionId) => () => void;
  },
): RendererHost {
  const turn = async (input: RendererInput): Promise<RendererOutput> => {
    const session = sessionOf(input.event);
    const release = session === null ? () => {} : collector.holding(session);
    try {
      const output = await renderer.answer(input);
      collector.subscribed(output.subscriptions);
      // [LAW:single-enforcer] A present answers the request whose turn
      // returned it, so every effect another turn returns is refused here,
      // and none is left owed its `effect-done`.
      if (output.kind === "answered" && input.event.kind !== "request")
        for (const effect of output.effects)
          refuse(effect, `a ${input.event.kind} turn answers no request`);
      return output;
    } finally {
      release();
    }
  };
  const refuse = (effect: Effect, reason: string): void =>
    void deliver(
      {
        kind: "event",
        at: instantAt(clock),
        event: {
          kind: "effect-done",
          session: effect.session,
          of: effect.id,
          outcome: { kind: "failed", reason },
        },
      },
      [["effect", String(effect.id)]],
    );
  // A turn's line, when it learned something or failed.
  const record = (
    input: RendererInput,
    about: TurnRecord,
    delivered: RendererOutput,
  ): void => {
    const session = sessionOf(input.event);
    const head: TurnRecord = [
      ["renderer", name],
      ["input", input.event.kind],
      ...(session === null ? [] : ([["sid", session]] as const)),
      ...about,
    ];
    switch (delivered.kind) {
      case "answered":
        if (delivered.record.length > 0)
          log("info", eventLine("turn", [...head, ...delivered.record]));
        return;
      case "threw":
        // [LAW:no-silent-failure] No turn's failure is left unhandled.
        log(
          LEVEL[delivered.failure.kind],
          eventLine("turn", [
            ...head,
            ...delivered.record,
            ["error", delivered.failure.detail],
          ]),
        );
    }
  };
  // [LAW:nothing-unseen] An input no event of its own records is recorded
  // here.
  const deliver = async (
    input: RendererInput,
    about: TurnRecord,
  ): Promise<RendererOutput> => {
    const delivered = await turn(input);
    record(input, about, delivered);
    return delivered;
  };
  return { name, answer: turn, deliver };
}

// [LAW:one-source-of-truth] The session an event names: what a turn holds,
// and what its line's `sid` says. A click naming none, or one whose id failed
// its checkpoint, names none.
function sessionOf(event: Event): SessionId | null {
  switch (event.kind) {
    case "config":
    case "request":
      return event.context.hookData.session_id;
    case "world-state":
      return event.worldState.session;
    case "click":
      return event.session?.ok ? event.session.id : null;
    case "retire":
    case "effect-done":
    case "menu-idle":
      return event.session;
  }
}

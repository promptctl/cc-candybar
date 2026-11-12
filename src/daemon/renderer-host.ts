// The host's one path to a renderer: every input it hands one is one turn,
// which answers with the turn's output or with how the turn failed: a turn's
// throw comes back as a value, never as a rejection. Every turn's
// subscriptions are taken here, in the order the turns answered, and so is
// every effect: a click's copies are performed here, each answered by its
// `effect-done`, and an effect of a kind its turn does not return is refused.
// A request's present is performed by the request's reply, which holds the
// connection it goes out on. A caller
// whose own event records the turn takes it by `answer`; every other input is
// taken by `deliver`, which writes the turn's own line.

import { inspect } from "node:util";
import {
  TurnThrew,
  type Effect,
  type EffectOutcome,
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

// The only renderer there is yet: the main one, in process.
export type RendererName = "main";

export type Delivered =
  | { readonly kind: "answered"; readonly output: RendererOutput }
  | {
      readonly kind: "threw";
      readonly error: unknown;
      // What the turn learned before it threw.
      readonly record: TurnRecord;
    };

export interface RendererHost {
  readonly name: RendererName;
  // One turn, recorded by the caller: a request's answer writes both its
  // turns on the request's render event.
  answer(input: RendererInput): Promise<Delivered>;
  // One turn, recorded on its own line. `about` is what the host knows of the
  // input beyond its session, for that line.
  deliver(input: RendererInput, about: TurnRecord): Promise<Delivered>;
}

export function rendererHost(
  name: RendererName,
  // The clock a refusal's `effect-done` is stamped by, when it is made.
  clock: Pick<Timekeeper, "now">,
  renderer: Renderer,
  log: DaemonLogger,
  // [LAW:effects-at-boundaries] Where a copy's text is written, and how it
  // went.
  clipboard: (text: string) => Promise<EffectOutcome>,
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
  const turn = async (input: RendererInput): Promise<Delivered> => {
    const session = sessionOf(input.event);
    const release = session === null ? () => {} : collector.holding(session);
    try {
      const output = await renderer.answer(input);
      collector.subscribed(output.subscriptions);
      await perform(input.event.kind, output.effects);
      return { kind: "answered", output };
    } catch (e) {
      if (!(e instanceof TurnThrew))
        return { kind: "threw", error: e, record: [] };
      collector.subscribed(e.subscriptions);
      await perform(input.event.kind, e.effects);
      return { kind: "threw", error: e.thrown, record: e.record };
    } finally {
      release();
    }
  };
  // [LAW:single-enforcer] Every effect is settled here or by the reply that
  // performs a present, so none is left owed its `effect-done`.
  const perform = async (
    by: Event["kind"],
    effects: readonly Effect[],
  ): Promise<void> => {
    for (const effect of effects) {
      if (RETURNED_BY[effect.kind] !== by) {
        await settle(effect, {
          kind: "failed",
          reason: `a ${by} turn returns no ${effect.kind}`,
        });
        continue;
      }
      switch (effect.kind) {
        case "present":
          continue;
        case "copy":
          await settle(effect, await clipboard(effect.text));
      }
    }
  };
  const settle = (effect: Effect, outcome: EffectOutcome): Promise<Delivered> =>
    deliver(
      {
        kind: "event",
        at: instantAt(clock),
        event: {
          kind: "effect-done",
          session: effect.kind === "present" ? effect.session : null,
          of: effect.id,
          outcome,
        },
      },
      [
        ["effect", String(effect.id)],
        ["kind", effect.kind],
        ...(outcome.kind === "failed"
          ? ([["failed", outcome.reason]] as const)
          : []),
      ],
    );
  // A turn's line, when it learned something or failed.
  const record = (
    input: RendererInput,
    about: TurnRecord,
    delivered: Delivered,
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
        if (delivered.output.record.length > 0)
          log("info", eventLine("turn", [...head, ...delivered.output.record]));
        return;
      case "threw":
        // [LAW:no-silent-failure] No turn's failure is left unhandled.
        log(
          "error",
          eventLine("turn", [
            ...head,
            ...delivered.record,
            ["error", inspect(delivered.error)],
          ]),
        );
    }
  };
  // [LAW:nothing-unseen] An input no event of its own records is recorded
  // here.
  const deliver = async (
    input: RendererInput,
    about: TurnRecord,
  ): Promise<Delivered> => {
    const delivered = await turn(input);
    record(input, about, delivered);
    return delivered;
  };
  return { name, answer: turn, deliver };
}

// [LAW:types-are-the-program] The one turn that returns each kind of effect:
// a present answers its request, and a copy is a click's act. Keyed by the
// kind, so a new effect names its turn here or fails to compile.
const RETURNED_BY: Readonly<Record<Effect["kind"], Event["kind"]>> = {
  present: "request",
  copy: "click",
};

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

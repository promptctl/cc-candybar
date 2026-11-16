// The host's one path to a renderer: every input it hands one is one turn,
// which answers with the turn's output or with how the turn failed: a turn's
// throw comes back as a value, never as a rejection. Every turn's
// subscriptions are taken here, in the order the turns answered, and so is
// every effect a turn that answers no request returned, refused. A caller
// whose own event records the turn takes it by `answer`; every other input is
// taken by `deliver`, which writes the turn's own line.

import {
  type Effect,
  type EffectOutcome,
  type Event,
  type Renderer,
  type EventInput,
  type TurnOutcome,
  type Subscriptions,
  type TurnRecord,
} from "../renderer-interface/interface.js";
import { eventLine } from "../utils/logfmt.js";
import { instantAt, type Instant } from "../utils/instant.js";
import type { AdapterPush, ReplyTo } from "../renderer-interface/adapter.js";
import { elapsedMs, type Timekeeper } from "../time.js";
import type { DaemonLogger } from "../utils/logger";
import type { SessionId } from "./foundations/session-id.js";
import { LEVEL } from "./foundations/request-event.js";
import { CrossedFailure, failureOf } from "./foundations/verb-error.js";
import { performChange } from "./effect-interpreter.js";

// The only renderer there is yet: the main one, in process.
export type RendererName = "main";

// A turn as the host took it: how it ended, and what the hop to its renderer
// cost, null for a turn no renderer answered.
export type HostTurn = TurnOutcome & { readonly hopMs: number | null };

export interface RendererHost {
  readonly name: RendererName;
  // One turn, recorded by the caller: a request's answer writes both its
  // turns on the request's render event.
  answer(input: EventInput): Promise<HostTurn>;
  // One turn, recorded on its own line. `about` is what the host knows of the
  // input beyond its session, for that line.
  deliver(input: EventInput, about: TurnRecord): Promise<TurnOutcome>;
  // One push, at `at`, answered by its reply. A push that threw or rejected,
  // or one answered by another push's reply, rejects with an Error naming the
  // renderer and the push: the caller that awaits it owns the failure.
  ask<P extends AdapterPush>(push: P, at: Instant): Promise<ReplyTo<P["kind"]>>;
  // One push nobody awaits: its failure is logged here.
  tell(push: AdapterPush, at: Instant): void;
}

export function rendererHost(
  name: RendererName,
  // The clock a refusal's `effect-done` is stamped by, when it is made, and a
  // hop is timed on.
  clock: Pick<Timekeeper, "now" | "monotonic">,
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
  const held = async (input: EventInput): Promise<HostTurn> => {
    const session = sessionOf(input.event);
    const release = session === null ? () => {} : collector.holding(session);
    try {
      const sentAt = clock.monotonic();
      const { subscriptions, turnMs, ...answered } =
        await renderer.answer(input);
      // [LAW:nothing-unseen] The hop: the round trip less the renderer's own
      // turn, so what the process boundary costs is read from the event.
      const output = { ...answered, hopMs: elapsedMs(clock, sentAt) - turnMs };
      // [LAW:single-enforcer] Every turn's changes are performed here, in the
      // order the turns answered, before the turn's caller hears it, whether
      // the turn answered or threw, and before anything else here can throw:
      // a renderer holds its next click until each change's `effect-done`.
      // A present answers the request whose turn returned it, so one another
      // turn returns is refused here, and no effect is left owed its
      // `effect-done`.
      for (const effect of output.effects) {
        if (effect.kind === "change") settle(effect, performChange(effect));
        else if (input.event.kind !== "request")
          refuse(effect, `a ${input.event.kind} turn answers no request`);
      }
      collector.subscribed(subscriptions);
      return output;
    } finally {
      release();
    }
  };
  // [LAW:single-enforcer] Every turn's caller, a fire-and-forget one included,
  // hears how the whole turn ended as a value: a hold that failed, a renderer
  // that rejected, or an output the host could not take, is the turn's
  // failure. Its changes were performed before anything that could throw,
  // and its subscriptions were not taken, so the ones last taken stand.
  const turn = (input: EventInput): Promise<HostTurn> =>
    held(input).catch(
      (thrown: unknown): HostTurn => ({
        kind: "threw",
        failure: failureOf(thrown),
        record: [],
        effects: [],
        hopMs: null,
      }),
    );
  const settle = (effect: Effect, outcome: EffectOutcome): void =>
    void deliver(
      {
        kind: "event",
        at: instantAt(clock),
        event: {
          kind: "effect-done",
          session: effect.session,
          of: effect.id,
          outcome,
        },
      },
      [["effect", String(effect.id)]],
    );
  const refuse = (effect: Effect, reason: string): void =>
    settle(effect, { kind: "failed", reason });
  // A turn's line, when it learned something or failed.
  const record = (
    input: EventInput,
    about: TurnRecord,
    delivered: TurnOutcome,
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
        // [LAW:single-enforcer] No renderer was live to take it: the
        // supervisor says that once, with the count it refused.
        if (delivered.failure.kind === "down") return;
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
    input: EventInput,
    about: TurnRecord,
  ): Promise<TurnOutcome> => {
    const delivered = await turn(input);
    record(input, about, delivered);
    return delivered;
  };
  // [LAW:single-enforcer] The one place a push's output is judged: a push is
  // answered by the reply of its own kind, or it failed.
  const ask = async <P extends AdapterPush>(
    push: P,
    at: Instant,
  ): Promise<ReplyTo<P["kind"]>> => {
    // A renderer that rejected fails the push as one whose turn threw, so
    // every failure is said with the renderer and the push it failed.
    const output = await renderer
      .answer({ kind: "adapter", push, at })
      .catch(
        (thrown: unknown) =>
          ({ kind: "threw", failure: failureOf(thrown) }) as const,
      );
    // The failure keeps its kind, so a push no renderer took reads as one.
    if (output.kind === "threw")
      throw new CrossedFailure({
        ...output.failure,
        message: `renderer ${name} push ${push.kind} threw: ${output.failure.message}`,
        detail: `renderer ${name} push ${push.kind} threw: ${output.failure.detail}`,
      });
    if (output.reply.kind !== push.kind)
      throw new Error(
        `renderer ${name} answered push ${push.kind} with a ${output.reply.kind} reply`,
      );
    // [LAW:types-are-the-program] exception: the kinds were just compared,
    // which the compiler cannot carry from the reply's kind to its type.
    return output.reply as ReplyTo<P["kind"]>;
  };
  const tell = (push: AdapterPush, at: Instant): void =>
    void ask(push, at).catch((thrown: unknown) => {
      const failure = failureOf(thrown);
      // [LAW:single-enforcer] A push no renderer was live to take is the
      // supervisor's to say.
      if (failure.kind !== "down") log("error", failure.detail);
    });
  return { name, answer: turn, deliver, ask, tell };
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

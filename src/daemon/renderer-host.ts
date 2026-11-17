// The host's one path to a renderer: every input it hands one passes the
// renderer's mailbox, and is one turn, which answers with the turn's output or
// with how the turn failed: a turn's throw comes back as a value, never as a
// rejection. Every turn's subscriptions are taken here, in the order the turns
// answered, its config changes landed, and its acts performed once they have;
// a present a turn that answers no request returned is refused. A caller whose
// own event records the turn takes it by `answer`; every other input is taken
// by `deliver`, which writes the turn's own line.
//
// [LAW:no-ambient-temporal-coupling] The mailbox is the one owner of a
// renderer's turns: it sends the renderer its next input only once the last
// has answered, in the order the inputs arrived, so no two turns of one
// renderer are ever in flight and a turn never waits for another. An input
// is made as its slot comes up, so what it reads of the host (whether a
// click's client left, the newest request of a session) is read after every
// turn ahead of it. A turn's changes land in its own slot, and so do their
// `effect-done` turns, so the next input finds them landed: the renderer
// never waits for a landing. Its acts go on after the slot, and each one's
// `effect-done` joins the mailbox when it ends.

import {
  type ConfigChange,
  type Effect,
  type EffectOutcome,
  type Event,
  type EventInput,
  type PushedFrame,
  type TimedRenderer,
  type TurnOutcome,
  type Subscriptions,
  type TurnRecord,
} from "../renderer-interface/interface.js";
import { eventLine } from "../utils/logfmt.js";
import { instantAt, type Instant } from "../utils/instant.js";
import type { AdapterPush, ReplyTo } from "../renderer-interface/adapter.js";
import { elapsedMs, type Monotonic, type Timekeeper } from "../time.js";
import type { DaemonLogger } from "../utils/logger";
import { KeyedSerialQueue, type Place } from "../utils/keyed-serial-queue.js";
import type { SessionId } from "./foundations/session-id.js";
import { LEVEL } from "./foundations/request-event.js";
import type { MailboxStats } from "./foundations/stats-snapshot.js";
import {
  CrossedFailure,
  failureOf,
  type Failure,
} from "./foundations/verb-error.js";
import {
  performChanges,
  type ApproveRepo,
  type WritableSettings,
} from "./effect-interpreter.js";
import { outlives, type HostAct } from "./acts.js";

// The only renderer there is yet: the main one, in process.
export type RendererName = "main";

// A turn as the host took it: how it ended, how long it waited in the
// mailbox, how long the renderer's own turn took and what the hop to it cost,
// each null for a turn no renderer answered, and how each of its effects
// settled before it returned: its changes, and the acts over in the turn, in
// the order they were returned.
export type HostTurn = TakenTurn & {
  readonly settled: readonly EffectOutcome[];
};
type TakenTurn = TurnOutcome & {
  readonly queuedMs: number;
  readonly turnMs: number | null;
  readonly hopMs: number | null;
};

// What the host's turns act in: the performer of acts, the trust book's
// directory, whether the daemon's close has begun, and where an act's failure
// goes that no session's bar can hold.
export interface HostWorld {
  readonly perform: (act: HostAct) => Promise<EffectOutcome>;
  readonly stateDir: string;
  readonly closing: () => boolean;
  readonly unheard: (text: string) => void;
}

export interface RendererHost {
  readonly name: RendererName;
  // One turn, recorded by the caller: a request's answer writes both its
  // turns on the request's render event. `make` is called as the input's
  // slot comes up, handed that instant, and answers the input, or why there
  // is none to send, which is the turn's failure.
  answer(make: (at: Instant) => EventInput | Failure): Promise<HostTurn>;
  // One turn, recorded on its own line. `about` is what the host knows of the
  // input beyond its session, for that line.
  deliver(
    make: (at: Instant) => EventInput,
    about: TurnRecord,
  ): Promise<TurnOutcome>;
  // A fresh renderer's start, recorded on its own line: it heads the
  // mailbox, behind only the slot in progress, since every input after it is
  // about the sessions it hands in.
  start(
    make: (at: Instant) => EventInput,
    about: TurnRecord,
  ): Promise<TurnOutcome>;
  // One push, at the instant its slot comes up, answered by its reply. A push that threw or rejected,
  // or one answered by another push's reply, rejects with an Error naming the
  // renderer and the push: the caller that awaits it owns the failure.
  ask<P extends AdapterPush>(push: P): Promise<ReplyTo<P["kind"]>>;
  // One push nobody awaits: its failure is logged here.
  tell(push: AdapterPush): void;
  // [LAW:nothing-unseen] The input in the renderer's turn now, and how many
  // wait behind it.
  stats(): MailboxStats;
}

// A turn as its slot leaves it: what the renderer answered, and its effects'
// outcomes, which settle once its acts have, after the slot.
interface Slotted {
  readonly turn: TakenTurn;
  readonly settled: Promise<readonly EffectOutcome[]>;
}

export function rendererHost(
  name: RendererName,
  // The clock a refusal's `effect-done` is stamped by, when it is made, and a
  // hop is timed on.
  clock: Pick<Timekeeper, "now" | "monotonic">,
  renderer: TimedRenderer,
  log: DaemonLogger,
  collector: {
    // [LAW:single-enforcer] Where every output's subscriptions go, a push's
    // reply's included, in the order the turns answered: each is whole, and
    // replaces the last.
    readonly subscribed: (subscriptions: Subscriptions) => void;
    // Where every turn's pushed frames go, in the order the turns answered:
    // the host's feeds, which hand each to its lanes.
    readonly framed: (frames: readonly PushedFrame[]) => void;
    // [LAW:single-enforcer] [LAW:no-ambient-temporal-coupling] Every turn
    // holds the session its event names until it settles, so no sweep retires
    // a session under a turn on it.
    readonly holding: (session: SessionId) => () => void;
    // The settings files each session's doctor reading handed in, which a
    // `claude-settings` change may write.
    readonly writableSettings: WritableSettings;
  },
  world: HostWorld,
): RendererHost {
  const mailbox = new KeyedSerialQueue<RendererName>();
  // [LAW:nothing-unseen] The input whose slot holds the mailbox, and since
  // when: its answer, its changes landing and their `effect-done` turns.
  let holder: { input: string; readonly since: Monotonic } | null = null;
  let queued = 0;

  // [LAW:single-enforcer] The one way into the renderer's turn: `slot` once
  // every slot asked for before it has ended, handed how long it waited and
  // a way to name the input holding it.
  const inMailbox = <T>(
    slot: (queuedMs: number, holds: (input: string) => void) => Promise<T>,
    at: Place = "last",
  ): Promise<T> => {
    const asked = clock.monotonic();
    queued++;
    return mailbox.run(
      name,
      async () => {
        queued--;
        const queuedMs = elapsedMs(clock, asked);
        const held = { input: "-", since: clock.monotonic() };
        holder = held;
        try {
          return await slot(queuedMs, (input) => void (held.input = input));
        } finally {
          holder = null;
        }
      },
      at,
    );
  };

  // [LAW:single-enforcer] [LAW:no-ambient-temporal-coupling] Where an
  // output's subscriptions are taken. From the daemon's close on, none is:
  // what they name (the collector, the wake, the status lines) closes in its
  // teardown, as no change lands once it has begun.
  const subscribed = (subscriptions: Subscriptions): void => {
    if (!world.closing()) collector.subscribed(subscriptions);
  };

  // A turn no renderer answered: nothing of it was taken, so the
  // subscriptions last taken stand.
  const unanswered = (failure: Failure, queuedMs: number): Slotted => ({
    turn: {
      kind: "threw",
      failure,
      record: [],
      effects: [],
      queuedMs,
      turnMs: null,
      hopMs: null,
    },
    settled: Promise.resolve([]),
  });

  // [LAW:single-enforcer] One turn in its slot: the renderer's answer, its
  // changes landed, and each change's `effect-done` turn, in this slot. Every
  // caller hears how the whole turn ended as a value: a hold that failed, a
  // renderer that rejected, or an output the host could not take, is the
  // turn's failure.
  const inSlot = async (
    input: EventInput,
    queuedMs: number,
  ): Promise<Slotted> => {
    const session = sessionOf(input.event);
    let release = (): void => {};
    try {
      release = session === null ? release : collector.holding(session);
      const sentAt = clock.monotonic();
      const { subscriptions, frames, turnMs, ...output } =
        await renderer.answer(input);
      // [LAW:nothing-unseen] The hop: the round trip less the renderer's own
      // turn, so what the process boundary costs is read from the event.
      const turn: TakenTurn = {
        ...output,
        queuedMs,
        turnMs,
        hopMs: elapsedMs(clock, sentAt) - turnMs,
      };
      // [LAW:single-enforcer] A turn's changes land here, together with its
      // answers to the trust book, in the order the turns answered, before
      // anything else here can throw and before the turn's caller hears it.
      // Its acts are performed only once they have, in the order it returned
      // them, each once the one before it has ended, and none is once the
      // daemon's close has begun. A present answers the request whose turn
      // returned it, so one another turn returns is refused here. No effect
      // is left owed its `effect-done`, and the turn's caller hears it only
      // after each `effect-done` turn of what is over in the turn, so a click
      // is answered after what its landing and its acts did.
      const changes = output.effects.filter(
        (effect): effect is ConfigChange => effect.kind === "change",
      );
      const answers = output.effects.filter(
        (effect): effect is ApproveRepo => effect.kind === "approve-repo",
      );
      const landed: EffectOutcome = world.closing()
        ? { kind: "closing", reason: "the daemon is closing" }
        : changes.length + answers.length === 0
          ? { kind: "ok" }
          : performChanges(
              changes,
              {
                stateDir: world.stateDir,
                answers,
                said: (line) => log("info", line),
              },
              collector.writableSettings,
            );
      subscribed(subscriptions);
      collector.framed(frames);
      // An act no landing let go: the close is its own cause, and any other
      // is its changes', whose own outcome says why.
      const unperformed: EffectOutcome =
        landed.kind === "ok" || landed.kind === "closing"
          ? landed
          : { kind: "skipped", reason: `not performed: ${landed.reason}` };
      const owed: Array<Promise<EffectOutcome>> = [];
      const acts: HostAct[] = [];
      for (const effect of output.effects) {
        if (effect.kind === "present") {
          if (input.event.kind !== "request")
            owed.push(
              (
                await settleInSlot(effect, {
                  kind: "failed",
                  reason: `a ${input.event.kind} turn answers no request`,
                })
              ).settled,
            );
        } else if (effect.kind === "change" || effect.kind === "approve-repo")
          owed.push((await settleInSlot(effect, landed)).settled);
        else acts.push(effect);
      }
      // [LAW:no-ambient-temporal-coupling] The acts go once every change of
      // the turn has had its `effect-done` turn, wherever the turn returned
      // them, and each once every act over in the turn before it has ended,
      // so two copies land in the order the turn asked them.
      let before: Promise<unknown> = Promise.resolve();
      for (const act of acts) {
        const acted =
          landed.kind === "ok"
            ? before.then(() => world.perform(act))
            : Promise.resolve(unperformed);
        const settled = acted.then((outcome) => settle(act, outcome));
        if (outlives(act)) void settled;
        else {
          owed.push(settled);
          before = acted;
        }
      }
      const settled = Promise.all(owed).finally(release);
      return { turn, settled };
    } catch (thrown) {
      release();
      return unanswered(failureOf(thrown), queuedMs);
    }
  };

  // [LAW:no-silent-failure] Each effect's outcome goes back to the renderer
  // that returned it, as its `effect-done` turn. An act's failure that no
  // session's bar can hold — one with no session, or one whose renderer has
  // ended — is the daemon's, on every bar. The trust book's answer lands with
  // the turn's changes, and its failure is theirs.
  const doneOf = (
    effect: Effect,
    outcome: EffectOutcome,
    at: Instant,
  ): EventInput => ({
    kind: "event",
    at,
    event: {
      kind: "effect-done",
      session: effect.session,
      of: effect.id,
      outcome,
    },
  });
  // An act's, once it ended: its `effect-done` joins the mailbox.
  const settle = async (
    effect: HostAct,
    outcome: EffectOutcome,
  ): Promise<EffectOutcome> => {
    const failed =
      outcome.kind === "failed" || outcome.kind === "refused"
        ? outcome.reason
        : null;
    if (failed !== null && effect.session === null) world.unheard(failed);
    const delivered = await deliver(
      (at) => doneOf(effect, outcome, at),
      [["effect", String(effect.id)]],
    );
    if (
      failed !== null &&
      effect.session !== null &&
      delivered.kind === "threw" &&
      delivered.failure.kind === "down"
    )
      world.unheard(failed);
    return outcome;
  };
  // A change's or a refused present's, in the slot of the turn that
  // returned it: settled once that `effect-done` turn's own acts have.
  const settleInSlot = async (
    effect: Effect,
    outcome: EffectOutcome,
  ): Promise<{ readonly settled: Promise<EffectOutcome> }> => {
    const input = doneOf(effect, outcome, instantAt(clock));
    const { turn, settled } = await inSlot(input, 0);
    record(input.event, [["effect", String(effect.id)]], turn);
    return { settled: settled.then(() => outcome) };
  };

  // A turn's line, when it learned something or failed: `event` is null when
  // its make threw, so no input was made.
  const record = (
    event: Event | null,
    about: TurnRecord,
    delivered: TakenTurn,
  ): void => {
    const session = event === null ? null : sessionOf(event);
    // [LAW:nothing-unseen] The turn's own time, read by the transport around
    // it: the renderer reads no clock, so what a config load in the turn cost
    // is said here.
    const head: TurnRecord = [
      ["renderer", name],
      ["input", event?.kind ?? "-"],
      ...(session === null ? [] : ([["sid", session]] as const)),
      ...about,
      ["took", tookOf(delivered.turnMs)],
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

  // One input from its arrival to its settling: made in its slot, and its
  // acts settled after it. `event` is null when its make failed, so no input
  // was made.
  const taken = async (
    make: (at: Instant) => EventInput | Failure,
    at: Place = "last",
  ): Promise<{ readonly event: Event | null; readonly turn: HostTurn }> => {
    const { event, slotted } = await inMailbox(async (queuedMs, holds) => {
      // [LAW:no-silent-failure] A make that threw is the turn's failure.
      let made: EventInput | Failure;
      try {
        // [LAW:single-enforcer] Every turn's instant is read here, as its
        // slot comes up, so the renderer's time never runs backwards between
        // turns whatever an input waited on before its slot.
        made = make(instantAt(clock));
      } catch (thrown) {
        made = failureOf(thrown);
      }
      if (made.kind !== "event")
        return { event: null, slotted: unanswered(made, queuedMs) };
      holds(made.event.kind);
      return { event: made.event, slotted: await inSlot(made, queuedMs) };
    }, at);
    return {
      event,
      turn: { ...slotted.turn, settled: await slotted.settled },
    };
  };
  const answer = async (
    make: (at: Instant) => EventInput | Failure,
  ): Promise<HostTurn> => (await taken(make)).turn;
  // [LAW:nothing-unseen] An input no event of its own records is recorded
  // here, as it was made in its slot.
  const recorded =
    (at: Place) =>
    async (
      make: (at: Instant) => EventInput,
      about: TurnRecord,
    ): Promise<TurnOutcome> => {
      const { event, turn } = await taken(make, at);
      record(event, about, turn);
      return turn;
    };
  const deliver = recorded("last");
  // [LAW:single-enforcer] The one place a push's output is judged: a push is
  // answered by the reply of its own kind, or it failed.
  const ask = async <P extends AdapterPush>(
    push: P,
  ): Promise<ReplyTo<P["kind"]>> => {
    // A renderer that rejected fails the push as one whose turn threw, so
    // every failure is said with the renderer and the push it failed.
    const output = await inMailbox(async (_queuedMs, holds) => {
      holds(`push:${push.kind}`);
      const answered = await renderer
        .answer({ kind: "adapter", push, at: instantAt(clock) })
        .catch(
          (thrown: unknown) =>
            ({ kind: "threw", failure: failureOf(thrown) }) as const,
        );
      // [LAW:one-source-of-truth] What the renderer's state needs, as the
      // push left it, taken in the push's own slot, before the next turn's.
      if (answered.kind !== "threw") subscribed(answered.subscriptions);
      return answered;
    });
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
  const tell = (push: AdapterPush): void =>
    void ask(push).catch((thrown: unknown) => {
      const failure = failureOf(thrown);
      // [LAW:single-enforcer] A push no renderer was live to take is the
      // supervisor's to say.
      if (failure.kind !== "down") log("error", failure.detail);
    });
  const stats = (): MailboxStats => ({
    holder: holder?.input ?? null,
    heldMs: holder === null ? 0 : elapsedMs(clock, holder.since),
    queued,
  });
  return { name, answer, deliver, start: recorded("first"), ask, tell, stats };
}

// A turn's time as its line says it: `-` for one no renderer answered.
export const tookOf = (turnMs: number | null): string =>
  turnMs === null ? "-" : `${turnMs}ms`;

// [LAW:one-source-of-truth] The session an event names: what a turn holds,
// and what its line's `sid` says. A click naming none, or one whose id failed
// its checkpoint, names none.
function sessionOf(event: Event): SessionId | null {
  switch (event.kind) {
    // A start, its viewers and a due are every session's: each holds none of
    // them alone.
    case "start":
    case "viewers":
    case "due":
      return null;
    case "config":
    case "request":
      return event.context.hookData.session_id;
    case "world-state":
      return event.worldState.session;
    case "click":
      return event.session?.ok ? event.session.id : null;
    case "retire":
    case "effect-done":
      return event.session;
  }
}

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
// click's client left, the clock's two readings it carries) is read after
// every turn ahead of it. A turn's changes land in its own slot, and so do their
// `effect-done` turns, so the next input finds them landed: the renderer
// never waits for a landing. Its acts go on after the slot, and each one's
// `effect-done` joins the mailbox when it ends.
//
// [LAW:one-source-of-truth] The origins a turn's output names are the ones
// config discovery follows. Each one the renderer was not yet served gets
// its `config` turn in the same slot, as does each one a turn's landing
// moved, ahead of the landing's `effect-done` turns, so the turn after finds
// the config it needs held, and a click's consequence reads the config its
// landing left.

import {
  type ConfigChange,
  type AnsweredEffect,
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
import { readingsAt } from "../utils/instant.js";
import type { AdapterPush, ReplyTo } from "../renderer-interface/adapter.js";
import { elapsedMs, type Monotonic, type Timekeeper } from "../time.js";
import type { DaemonLogger } from "../utils/logger";
import { KeyedSerialQueue, type Place } from "../utils/keyed-serial-queue.js";
import type { SessionId } from "./foundations/session-id.js";
import type { RendererName } from "../renderer-interface/renderer-name.js";
import type { StoreWrite } from "../renderer-interface/stored.js";
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
import { RendererWake } from "./renderer-wake.js";
import { originKey, type RenderOrigin } from "../config-hint.js";
import type { ConfigDiscovery } from "./config-discovery/config-discovery.js";

// A turn as the host took it: how it ended, how long it waited in the
// mailbox, how long the renderer's turn took and what the hop to it cost, null
// for a turn no renderer answered, and how each of its effects settled before
// it returned: its changes, and the acts over in the turn, in the order they
// were returned.
export type HostTurn = TakenTurn & {
  readonly settled: readonly EffectOutcome[];
};
type TakenTurn = TurnOutcome<AnsweredEffect> & {
  readonly queuedMs: number;
  readonly turnMs: number | null;
  readonly hopMs: number | null;
};

// What a caller makes as its input's slot comes up: the event, or why there
// is none to send, which is the turn's failure. The host stamps it with the
// slot's readings.
interface MadeEvent {
  readonly kind: "event";
  readonly event: Event;
}
export type Made = MadeEvent | Failure;

// What the host's turns act in: the performer of acts, the trust book's
// directory, what config discovery found at each origin it follows, whether
// the daemon's close has begun, and where an act's failure goes that no
// session's bar can hold.
export interface HostWorld {
  readonly perform: (act: HostAct) => Promise<EffectOutcome>;
  readonly stateDir: string;
  readonly configs: Pick<
    ConfigDiscovery,
    "follow" | "snapshotOf" | "landed" | "path" | "repoDir"
  >;
  readonly closing: () => boolean;
  readonly unheard: (text: string) => void;
  // [LAW:single-enforcer] Where every `store` write a turn returns goes: the
  // renderer's profile store, which a next start hands in.
  readonly store: (write: StoreWrite) => void;
}

export interface RendererHost {
  readonly name: RendererName;
  // One turn, recorded by the caller: a request's answer writes both its
  // turns on the request's render event. `make` is called as the input's
  // slot comes up, and answers the input, or why there is none to send,
  // which is the turn's failure.
  answer(make: () => Made): Promise<HostTurn>;
  // One turn, recorded on its own line. `about` is what the host knows of the
  // input beyond its session, for that line.
  deliver(make: () => Made, about: TurnRecord): Promise<TurnOutcome>;
  // A fresh renderer's start, recorded on its own line: it heads the
  // mailbox, behind only the slot in progress, since every input after it is
  // about the sessions it hands in.
  start(make: () => Made, about: TurnRecord): Promise<TurnOutcome>;
  // One push, answered by its reply. A push that threw or rejected, or one
  // answered by another push's reply, rejects with an Error naming the
  // renderer and the push: the caller that awaits it owns the failure.
  ask<P extends AdapterPush>(push: P): Promise<ReplyTo<P["kind"]>>;
  // One push nobody awaits: its failure is logged here.
  tell(push: AdapterPush): void;
  // What discovery found at each of `origins` moved: each gets its `config`
  // turn, made from what discovery holds as its slot comes up.
  moved(origins: readonly RenderOrigin[]): void;
  // [LAW:no-ambient-temporal-coupling] The wake's end, first in the
  // daemon's teardown: no `due` is made after it.
  closeWake(): void;
  // [LAW:nothing-unseen] The input in the renderer's turn now, and how many
  // wait behind it.
  stats(): MailboxStats;
}

// [LAW:types-are-the-program] A turn's failure as the outcome of what waited
// on it: a bad request is refused, a close is a close, anything else failed.
const THREW_AS = {
  "bad-request": "refused",
  threw: "failed",
  closing: "closing",
  abandoned: "failed",
  down: "failed",
} as const satisfies Record<
  Failure["kind"],
  Exclude<EffectOutcome["kind"], "ok" | "skipped">
>;

// A turn as its slot leaves it: what the renderer answered, and its effects'
// outcomes, which settle once its acts have, after the slot.
interface Slotted {
  readonly turn: TakenTurn;
  readonly settled: Promise<readonly EffectOutcome[]>;
}

export function rendererHost(
  name: RendererName,
  // The clock every input's readings are made on, a hop is timed on, and the
  // renderer's wake is armed on.
  clock: Pick<Timekeeper, "now" | "monotonic" | "after">,
  renderer: TimedRenderer,
  log: DaemonLogger,
  collector: {
    // [LAW:single-enforcer] Where every output's subscriptions go: the
    // collector, which diffs each whole set against the last.
    readonly subscribed: (subscriptions: Subscriptions) => void;
    // Where the frames an output's feeds drew go: the host's feeds, which
    // send each subscriber what changed for it.
    readonly frames: (frames: readonly PushedFrame[]) => void;
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
  const stamped = stampedOf(clock);
  // [LAW:nothing-unseen] The input whose slot holds the mailbox, and since
  // when: its answer, its changes landing and their `effect-done` turns.
  let holder: { input: string; readonly since: Monotonic } | null = null;
  let queued = 0;
  // [LAW:one-source-of-truth] The origins, by `originKey`, whose config the
  // live renderer was served: what its last output named. A `start` is a
  // renderer that holds none.
  let served = new Set<string>();

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
    // [LAW:one-source-of-truth] A renderer sent its `start` holds no config,
    // whether or not the start answers: every origin it names after is new.
    if (input.event.kind === "start") served = new Set();
    try {
      release = session === null ? release : collector.holding(session);
      const sentAt = clock.monotonic();
      const { subscriptions, frames, turnMs, ...output } =
        await renderer.answer(input);
      // [LAW:nothing-unseen] The hop: the round trip less the renderer's own
      // turn, so what the process boundary costs is read from the event.
      // [LAW:no-ambient-temporal-coupling] What the turn stored is held
      // first, before anything here can throw: a renderer that ends after
      // this turn starts again with it, whatever its changes and acts do.
      const answered: AnsweredEffect[] = [];
      for (const effect of output.effects)
        if (effect.kind === "store") world.store(effect);
        else answered.push(effect);
      const turn: TakenTurn = {
        ...output,
        effects: answered,
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
      const changes = answered.filter(
        (effect): effect is ConfigChange => effect.kind === "change",
      );
      const answers = answered.filter(
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
              world.configs,
            );
      const named = took(subscriptions, frames);
      // [LAW:no-ambient-temporal-coupling] Every origin the output newly
      // names, and every one the landing moved, gets its `config` turn here,
      // ahead of the landing's `effect-done` turns.
      const waited: Array<Promise<readonly EffectOutcome[]>> = [];
      for (const origin of named)
        waited.push((await configInSlot(origin, "config-subscribed")).settled);
      const reloaded: Array<Promise<unknown>> = [];
      const moved =
        landed.kind === "ok" && changes.length + answers.length > 0
          ? world.configs.landed(
              // A landed layer's origin was followed and its chain held the
              // role, or the landing was refused.
              changes.flatMap(({ target }) => {
                const file =
                  target.kind === "layer"
                    ? world.configs.path(target.origin, target.role)
                    : target.file;
                return file === null || file === undefined ? [] : [file];
              }),
              answers.length > 0,
            )
          : [];
      for (const origin of moved)
        reloaded.push((await configInSlot(origin, "config-landed")).settled);
      // An act no landing let go: the close is its own cause, and any other
      // is its changes', whose own outcome says why.
      const unperformed: EffectOutcome =
        landed.kind === "ok" || landed.kind === "closing"
          ? landed
          : { kind: "skipped", reason: `not performed: ${landed.reason}` };
      const owed: Array<Promise<EffectOutcome>> = [];
      const acts: HostAct[] = [];
      for (const effect of answered) {
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
        if (outlives(act)) unawaited("act", settled);
        else {
          owed.push(settled);
          before = acted;
        }
      }
      // [LAW:no-silent-failure] A turn settles as what it caused: its own
      // effects, and those of the `config` turns it named, which run what
      // waited on it, so a click that waited answers for what it did. A
      // `config` turn its landing moved runs nothing of its own: it is
      // waited for, and its failure is its own turn's line.
      const settled = Promise.all([
        Promise.all(waited),
        Promise.all(reloaded),
        Promise.all(owed),
      ])
        .then(([caused, , own]) => [...caused.flat(), ...own])
        .finally(release);
      return { turn, settled };
    } catch (thrown) {
      release();
      return unanswered(failureOf(thrown), queuedMs);
    }
  };

  // [LAW:single-enforcer] Every output is taken here, the wake first, so a
  // taker that throws leaves the renderer's next turn armed. Taking never
  // fails a turn that answered: its effects are still owed their
  // `effect-done`. Answers the origins the output names that the renderer
  // was not served, which discovery now follows.
  // [LAW:no-silent-failure] A taker's throw is the daemon's, on every bar.
  const took = (
    subscriptions: Subscriptions,
    frames: readonly PushedFrame[],
  ): readonly RenderOrigin[] => {
    wake.declare(subscriptions.wake);
    let named: readonly RenderOrigin[] = [];
    for (const [what, take] of [
      ["subscriptions", () => collector.subscribed(subscriptions)],
      ["frames", () => collector.frames(frames)],
      [
        "configs",
        () => {
          world.configs.follow(subscriptions.configs);
          named = subscriptions.configs.filter(
            (o) => !served.has(originKey(o)),
          );
          served = new Set(subscriptions.configs.map((o) => originKey(o)));
        },
      ],
    ] as const) {
      try {
        take();
      } catch (thrown) {
        const text = `renderer ${name}'s ${what} could not be taken: ${failureOf(thrown).detail}`;
        log("error", text);
        world.unheard(text);
      }
    }
    return named;
  };

  // [LAW:one-source-of-truth] An origin's `config`, made from what discovery
  // holds as its slot comes up. One discovery no longer follows (the
  // renderer let it go before the slot) has nothing to hand in: its reason
  // left first.
  const configMade = (origin: RenderOrigin) => (): Made => {
    const config = world.configs.snapshotOf(origin);
    return config === null
      ? {
          kind: "abandoned",
          message: "the renderer let the origin go",
          detail: `origin ${JSON.stringify(originKey(origin))} is no longer followed`,
        }
      : { kind: "event", event: { kind: "config", origin, config } };
  };
  // An origin's `config` turn in the slot of the turn that named it or moved
  // it: settled once that turn's own acts have.
  const configInSlot = async (
    origin: RenderOrigin,
    why: string,
  ): Promise<{ readonly settled: Promise<readonly EffectOutcome[]> }> => {
    const made = configMade(origin)();
    // [LAW:no-silent-failure] An origin let go before its slot ran nothing
    // that waited on it, so the turn that named it did not do what it asked.
    if (made.kind !== "event")
      return {
        settled: Promise.resolve([{ kind: "failed", reason: made.message }]),
      };
    const input = stamped(made);
    const { turn, settled } = await inSlot(input, 0);
    record(input.event, [["why", why]], turn);
    // A `config` turn that threw failed whatever waited on it, as its own
    // turn would have: a waiting click's bad request is still the user's.
    const threw: readonly EffectOutcome[] =
      turn.kind === "threw"
        ? [
            {
              kind: THREW_AS[turn.failure.kind],
              reason: turn.failure.message,
            },
          ]
        : [];
    return { settled: settled.then((outcomes) => [...threw, ...outcomes]) };
  };

  // [LAW:no-silent-failure] Each effect's outcome goes back to the renderer
  // that returned it, as its `effect-done` turn. An act's failure that no
  // session's bar can hold — one with no session, or one whose renderer has
  // ended — is the daemon's, on every bar. The trust book's answer lands with
  // the turn's changes, and its failure is theirs.
  const doneOf = (
    effect: AnsweredEffect,
    outcome: EffectOutcome,
  ): MadeEvent => ({
    kind: "event",
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
      () => doneOf(effect, outcome),
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
    effect: AnsweredEffect,
    outcome: EffectOutcome,
  ): Promise<{ readonly settled: Promise<EffectOutcome> }> => {
    const input = stamped(doneOf(effect, outcome));
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
    const head: TurnRecord = [
      ["renderer", name],
      ["input", event?.kind ?? "-"],
      ...(session === null ? [] : ([["sid", session]] as const)),
      ...about,
      ...(delivered.turnMs === null
        ? []
        : ([["took", `${delivered.turnMs}ms`]] as const)),
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

  // One input through its slot: made there, and answered, its acts still
  // settling. `event` is null when its make failed, so no input was made.
  const throughSlot = (
    make: () => Made,
    at: Place,
  ): Promise<{ readonly event: Event | null; readonly slotted: Slotted }> =>
    inMailbox(async (queuedMs, holds) => {
      // [LAW:no-silent-failure] A make that threw is the turn's failure.
      let made: Made;
      try {
        made = make();
      } catch (thrown) {
        made = failureOf(thrown);
      }
      if (made.kind !== "event")
        return { event: null, slotted: unanswered(made, queuedMs) };
      holds(made.event.kind);
      return {
        event: made.event,
        slotted: await inSlot(stamped(made), queuedMs),
      };
    }, at);
  // One input from its arrival to its settling: its acts settled after its
  // slot.
  const taken = async (
    make: () => Made,
    at: Place = "last",
  ): Promise<{ readonly event: Event | null; readonly turn: HostTurn }> => {
    const { event, slotted } = await throughSlot(make, at);
    return {
      event,
      turn: { ...slotted.turn, settled: await slotted.settled },
    };
  };
  const answer = async (make: () => Made): Promise<HostTurn> =>
    (await taken(make)).turn;
  // [LAW:nothing-unseen] An input no event of its own records is recorded
  // here, as it was made in its slot.
  const recorded =
    (at: Place) =>
    async (make: () => Made, about: TurnRecord): Promise<TurnOutcome> => {
      const { event, turn } = await taken(make, at);
      record(event, about, turn);
      return turn;
    };
  const deliver = recorded("last");
  // [LAW:no-silent-failure] A turn's settling nothing awaits, which rejected,
  // is the daemon's, on every bar.
  const unawaited = (what: string, settling: Promise<unknown>): void =>
    void settling.catch((thrown: unknown) => {
      const text = `renderer ${name}'s ${what} did not settle: ${failureOf(thrown).detail}`;
      log("error", text);
      world.unheard(text);
    });
  // [LAW:single-enforcer] The one place a push's output is judged: a push is
  // answered by the reply of its own kind, or it failed.
  const ask = async <P extends AdapterPush>(
    push: P,
  ): Promise<ReplyTo<P["kind"]>> => {
    // A renderer that rejected fails the push as one whose turn threw, so
    // every failure is said with the renderer and the push it failed.
    const output = await inMailbox(async (_queuedMs, holds) => {
      holds(`push:${push.kind}`);
      try {
        const { subscriptions, ...answered } = await renderer.answer({
          kind: "adapter",
          push,
          ...readingsAt(clock),
        });
        // A push answers in no slot of a turn: each origin it newly names
        // gets its `config` turn behind it.
        for (const origin of took(subscriptions, []))
          unawaited(
            "config",
            deliver(configMade(origin), [["why", "config-subscribed"]]),
          );
        return answered;
      } catch (thrown) {
        return {
          kind: "threw",
          failure: failureOf(thrown),
          turnMs: null,
        } as const;
      }
    });
    // The failure keeps its kind, so a push no renderer took reads as one.
    if (output.kind === "threw") {
      const took = output.turnMs === null ? "" : ` took=${output.turnMs}ms`;
      throw new CrossedFailure({
        ...output.failure,
        message: `renderer ${name} push ${push.kind} threw: ${output.failure.message}`,
        detail: `renderer ${name} push ${push.kind} threw${took}: ${output.failure.detail}`,
      });
    }
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
  const moved = (origins: readonly RenderOrigin[]): void => {
    for (const origin of origins)
      unawaited(
        "config",
        deliver(configMade(origin), [["why", "config-moved"]]),
      );
  };
  const stats = (): MailboxStats => ({
    holder: holder?.input ?? null,
    heldMs: holder === null ? 0 : elapsedMs(clock, holder.since),
    queued,
  });
  // [LAW:single-enforcer] The one timer the renderer's turns are scheduled
  // by: its `due` is an input like any other, made in its slot, and refused
  // once the wake has closed.
  // [LAW:no-ambient-temporal-coupling] A `due` is the renderer's idle work:
  // every input that arrives while it waits goes ahead of it, so a click that
  // has arrived lands before an idle close reads its session idle. The wake
  // hears the turn once the renderer has answered it: the acts it returned
  // settle on their own, and hold back no later `due`.
  const wake: RendererWake = new RendererWake({
    clock,
    due: async () => {
      const {
        event,
        slotted: { turn, settled },
      } = await throughSlot(
        () =>
          wake.closed()
            ? {
                kind: "closing",
                message: "the daemon is closing",
                detail: "a due made after the renderer's wake closed",
              }
            : { kind: "event", event: { kind: "due" } },
        "idle",
      );
      unawaited("due acts", settled);
      record(event, [], turn);
      return turn;
    },
    // Each failed `due` is its own turn's line: the run is said once, on
    // every bar.
    said: (text) => world.unheard(text),
    log: (text) => log("info", text),
  });
  return {
    name,
    answer,
    deliver,
    start: recorded("first"),
    ask,
    tell,
    moved,
    stats,
    closeWake: () => wake.close(),
  };
}

// [LAW:single-enforcer] An input as its slot comes up: the event made then,
// and the clock's two readings, read then, never at its arrival.
// [LAW:no-ambient-temporal-coupling] `stamped` is called only in a slot.
const stampedOf =
  (clock: Pick<Timekeeper, "now" | "monotonic">) =>
  (made: MadeEvent): EventInput => ({
    kind: "event",
    event: made.event,
    ...readingsAt(clock),
  });

// [LAW:one-source-of-truth] The session an event names: what a turn holds,
// and what its line's `sid` says. A click naming none, or one whose id failed
// its checkpoint, names none.
function sessionOf(event: Event): SessionId | null {
  switch (event.kind) {
    // A start is every session's: it holds none of them alone.
    case "start":
      return null;
    case "context":
    case "request":
      return event.context.hookData.session_id;
    // An origin's config is every session's there.
    case "config":
      return null;
    case "world-state":
      return event.worldState.session;
    case "click":
      return event.session?.ok ? event.session.id : null;
    case "retire":
    case "effect-done":
      return event.session;
    // Every watched session's, or the renderer's own.
    case "viewers":
    case "due":
      return null;
  }
}

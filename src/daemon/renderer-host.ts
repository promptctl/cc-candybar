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
  type Effect,
  type EffectOutcome,
  type Event,
  type EventInput,
  type PushedFrame,
  type RendererOutput,
  type TimedRenderer,
  type TurnOutcome,
  type Subscriptions,
  type TurnRecord,
} from "../renderer-interface/interface.js";
import { eventLine } from "../utils/logfmt.js";
import { readingsAt } from "../utils/instant.js";
import type { StoreWrite } from "../renderer-interface/stored-state.js";
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
  type ConfigLanding,
} from "./effect-interpreter.js";
import { outlives, type HostAct } from "./acts.js";
import type { RequestedRun, RunAct } from "./foundations/run-authorization.js";
import type { RunEvidence } from "../click/wire.js";
import type { Asked } from "../utils/outcome.js";
import { RendererWake } from "./renderer-wake.js";
import { originKey, type RenderOrigin } from "../config-hint.js";
import type { RendererConfigs } from "./config-discovery/config-discovery.js";

import type { RendererName } from "./foundations/renderer-name.js";

// A turn as the host took it: how it ended, how long it waited in the
// mailbox, how long the renderer's turn took and what the hop to it cost, null
// for a turn no renderer answered, and how each of its effects settled before
// it returned: its changes, and the acts over in the turn, in the order they
// were returned.
export type HostTurn = TakenTurn & {
  readonly settled: readonly EffectOutcome[];
};
type SettlePresentation = (
  effect: Pick<Effect, "id" | "session">,
  reason: string | null,
) => void;
type TakenTurn = TurnOutcome & {
  readonly settlePresentation: SettlePresentation;
  readonly queuedMs: number;
  readonly turnMs: number | null;
  readonly hopMs: number | null;
  // Failure preparing the origin this context will draw from.
  readonly configFailure?: Failure;
};

// What a caller makes as its input's slot comes up: the event, or why there
// is none to send, which is the turn's failure. The host stamps it with the
// slot's readings.
interface MadeEvent {
  readonly kind: "event";
  readonly event: Event;
  // [LAW:locality-or-seam] Host-only data. Stamping sends the event alone.
  readonly runEvidence?: readonly RunEvidence[];
}
export type Made = MadeEvent | Failure;

// What the host's turns act in: the performer of acts, the trust book's
// directory, what config discovery found at each origin it follows, whether
// the daemon's close has begun, and where an act's failure goes that no
// session's bar can hold.
export interface HostWorld {
  readonly authorizeRun: (
    request: RequestedRun,
    captures: readonly RunEvidence[],
  ) => Asked<RunAct>;
  readonly perform: (act: HostAct) => Promise<EffectOutcome>;
  readonly stateDir: string;
  readonly configs: RendererConfigs;
  readonly closing: () => boolean;
  readonly unheard: (text: string) => void;
}

export interface RendererHost {
  readonly name: RendererName;
  // One turn, recorded by the caller: a request's answer writes both its
  // turns on the request's render event. `make` is called as the input's
  // slot comes up, and answers the input, or why there is none to send,
  // which is the turn's failure.
  answer(make: () => Made): Promise<HostTurn>;
  // A click keeps its session busy until its mailbox slot lands.
  answerClick(session: SessionId | null, make: () => Made): Promise<HostTurn>;
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

type ConfigDelivery = "scheduled" | "received" | "unreceived";

type ConfigFollowing =
  | { readonly kind: "following"; readonly named: readonly RenderOrigin[] }
  | { readonly kind: "failed"; readonly failure: Failure };

type ConfigTurn = {
  readonly settled: Promise<readonly EffectOutcome[]>;
} & (
  | { readonly kind: "received"; readonly failure: Failure | null }
  | { readonly kind: "unreceived"; readonly failure: Failure }
);

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
    readonly frames: (
      frames: readonly PushedFrame[],
      settled: (frame: PushedFrame, delivered: boolean) => void,
    ) => void;
    // [LAW:single-enforcer] Where every output's stored writes go: the host's
    // copy of the renderer's stores, before any later input.
    readonly stored: (writes: readonly StoreWrite[]) => void;
    // [LAW:single-enforcer] [LAW:no-ambient-temporal-coupling] Every turn
    // holds the session its event names until it settles, so no sweep retires
    // a session under a turn on it.
    readonly holding: (session: SessionId) => () => void;
    // [LAW:single-enforcer] Where every turn's record goes as the renderer
    // answered it, whatever input the turn took.
    readonly recorded: (record: TurnRecord) => void;
  },
  world: HostWorld,
): RendererHost {
  const mailbox = new KeyedSerialQueue<RendererName>();
  let generation = 0;
  const stamped = stampedOf(clock);
  // [LAW:nothing-unseen] The input whose slot holds the mailbox, and since
  // when: its answer, its changes landing and their `effect-done` turns.
  let holder: { input: string; readonly since: Monotonic } | null = null;
  let queued = 0;
  // [LAW:one-source-of-truth] A due observes the sessions of admitted clicks
  // whose slots have yet to land. Outliving effects do not keep a menu busy.
  const pendingClicks = new Map<
    SessionId,
    { readonly session: SessionId; count: number }
  >();
  // [LAW:one-source-of-truth] Delivery for the origins in the renderer's
  // latest subscriptions. Reserve a batch before entering its config turns,
  // which can publish subscriptions of their own. A start clears delivery.
  let configs = new Map<string, ConfigDelivery>();

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
      settlePresentation: receiptFor(generation),
      queuedMs,
      turnMs: null,
      hopMs: null,
    },
    settled: Promise.resolve([]),
  });

  // [LAW:single-enforcer] The transport owns whether the renderer
  // answered. Host failures during landing cannot replace that answer.
  const inSlot = async (
    input: EventInput,
    queuedMs: number,
    captures: readonly RunEvidence[] = [],
  ): Promise<Slotted> => {
    if (input.event.kind === "start") generation++;
    const receipt = receiptFor(generation);
    const session = sessionOf(input.event);
    let release = (): void => {};
    let output: RendererOutput & { readonly turnMs: number };
    let sentAt: Monotonic;
    try {
      if (session !== null) release = collector.holding(session);
      sentAt = clock.monotonic();
      output = await renderer.answer(input);
    } catch (thrown) {
      recordTaken("session release", release);
      return unanswered(failureOf(thrown), queuedMs);
    }
    if (input.event.kind === "config") {
      const key = originKey(input.event.origin);
      if (configs.has(key)) configs.set(key, "received");
    }
    const { subscriptions, frames, stored, turnMs, ...answer } = output;
    const turn: TakenTurn = {
      ...answer,
      settlePresentation: receipt,
      queuedMs,
      turnMs,
      hopMs: elapsedMs(clock, sentAt) - turnMs,
    };
    const { settled, configFailure } = await landInSlot(
      input.event,
      output,
      captures,
      receipt,
    );
    return {
      turn: configFailure === null ? turn : { ...turn, configFailure },
      settled: settled.finally(
        () => void recordTaken("session release", release),
      ),
    };
  };

  // [LAW:single-enforcer] After an answer, the host lands the configuration
  // batch, publishes the output, and settles every effect. Only acts that
  // depend on a refused configuration landing are skipped.
  const landInSlot = async (
    event: Event,
    output: RendererOutput,
    captures: readonly RunEvidence[],
    receipt: SettlePresentation,
  ): Promise<{
    readonly settled: Promise<readonly EffectOutcome[]>;
    readonly configFailure: Failure | null;
  }> => {
    recordTaken("turn record", () => collector.recorded(output.record));
    const changes = output.effects.filter(
      (effect): effect is ConfigChange => effect.kind === "change",
    );
    const answers = output.effects.filter(
      (effect): effect is ApproveRepo => effect.kind === "approve-repo",
    );
    const landed = landConfig(changes, answers);
    const requested =
      event.kind === "context" ? originKey(event.context.requested) : null;
    const followed = took(
      output.subscriptions,
      output.frames,
      output.stored,
      requested,
      receipt,
    );
    let configFailure: Failure | null = null;
    const waited: Array<Promise<readonly EffectOutcome[]>> = [];
    const unreceived: RenderOrigin[] = [];
    if (followed.kind === "failed") {
      if (requested !== null && configs.get(requested) !== "received")
        configFailure = followed.failure;
    } else {
      for (const origin of followed.named) {
        const config = await configInSlot(origin, "config-subscribed");
        if (originKey(origin) === requested) configFailure = config.failure;
        if (config.kind === "unreceived") unreceived.push(origin);
        waited.push(config.settled);
      }
    }
    const moved =
      landed.kind === "ok" && landed.files.length > 0
        ? (recordTaken("landed config discovery", () =>
            world.configs.landed(landed.files),
          ) ?? [])
        : [];
    const reloaded: Array<Promise<readonly EffectOutcome[]>> = [];
    for (const origin of moved)
      reloaded.push((await configInSlot(origin, "config-landed")).settled);

    const owed: Array<Promise<EffectOutcome>> = [];
    const acts: HostAct[] = [];
    for (const effect of output.effects) {
      if (effect.kind === "present") {
        if (event.kind !== "request")
          owed.push(
            (
              await settleInSlot(effect, {
                kind: "failed",
                reason: `a ${event.kind} turn answers no request`,
              })
            ).settled,
          );
      } else if (effect.kind === "change" || effect.kind === "approve-repo") {
        const outcome: EffectOutcome =
          landed.kind === "ok" ? { kind: "ok" } : landed;
        owed.push((await settleInSlot(effect, outcome)).settled);
      } else if (effect.kind === "run") {
        const checked = world.authorizeRun(effect, captures);
        if (checked.kind === "ok") acts.push(checked.value);
        else
          owed.push(
            (
              await settleInSlot(effect, {
                kind: "refused",
                reason: `run: ${checked.reason}`,
              })
            ).settled,
          );
      } else acts.push(effect);
    }

    let before: Promise<unknown> = Promise.resolve();
    for (const act of acts) {
      const acted =
        landed.kind === "ok"
          ? before
              .then(() => world.perform(act))
              .catch(
                (error: unknown): EffectOutcome => ({
                  kind: "failed",
                  reason: failureOf(error).detail,
                }),
              )
          : Promise.resolve<EffectOutcome>(
              landed.kind === "closing"
                ? landed
                : {
                    kind: "skipped",
                    reason: `not performed: ${landed.reason}`,
                  },
            );
      const settled = acted.then((outcome) => settle(act, outcome));
      if (outlives(act)) unawaited("act", settled);
      else {
        owed.push(settled);
        before = acted;
      }
    }
    // Acts settle outside this slot; their effect-done turns use the mailbox.
    const settled = Promise.all([
      Promise.all(waited),
      Promise.all(reloaded),
      Promise.all(owed),
    ]).then(([caused, , own]) => [...caused.flat(), ...own]);
    for (const origin of unreceived) markUnreceived(origin);
    return { settled, configFailure };
  };

  const landConfig = (
    changes: readonly ConfigChange[],
    answers: readonly ApproveRepo[],
  ): ConfigLanding => {
    try {
      if (world.closing())
        return { kind: "closing", reason: "the daemon is closing" };
      if (changes.length + answers.length === 0)
        return { kind: "ok", files: [] };
      return performChanges(
        changes,
        {
          stateDir: world.stateDir,
          answers,
          said: (line) =>
            void recordTaken("trust book record", () => log("info", line)),
        },
        world.configs,
      );
    } catch (thrown) {
      return { kind: "failed", reason: failureOf(thrown).detail };
    }
  };

  const notTaken = (what: string, failure: Failure): void => {
    const text = `renderer ${name}'s ${what} could not be taken: ${failure.detail}`;
    log("error", text);
    world.unheard(text);
  };

  const recordTaken = <Value>(
    what: string,
    operation: () => Value,
  ): Value | null => {
    try {
      return operation();
    } catch (thrown) {
      notTaken(what, failureOf(thrown));
      return null;
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
    stored: readonly StoreWrite[],
    requested: string | null,
    receipt: SettlePresentation,
  ): ConfigFollowing => {
    recordTaken("wake declaration", () => wake.declare(subscriptions.wake));
    recordTaken("stored writes", () => collector.stored(stored));
    recordTaken("subscriptions", () => collector.subscribed(subscriptions));
    if (frames.length > 0) {
      const owed = new Set(
        frames.flatMap(({ frame }) =>
          frame.kind === "drawn" ? [frame.receipt] : [],
        ),
      );
      const settled = (
        { session, frame }: PushedFrame,
        delivered: boolean,
      ): void => {
        if (frame.kind === "drawn" && owed.delete(frame.receipt))
          receipt(
            { session, id: frame.receipt },
            delivered ? null : "no subscriber took the frame",
          );
      };
      if (
        recordTaken("frames", () => collector.frames(frames, settled)) === null
      )
        for (const frame of frames) settled(frame, false);
    }
    const named: RenderOrigin[] = [];
    try {
      const next = new Map<string, ConfigDelivery>();
      for (const origin of subscriptions.configs) {
        const key = originKey(origin);
        const before = configs.get(key);
        // [LAW:no-ambient-temporal-coupling] A new context retries only the
        // undelivered config it needs. A feed tick cannot poll it.
        if (
          before === undefined ||
          (key === requested && before === "unreceived")
        ) {
          named.push(origin);
          next.set(key, "scheduled");
        } else next.set(key, before);
      }
      // A renderer has already dropped any unlisted config, even when the
      // host cannot update its discovery subscriptions.
      configs = next;
      world.configs.follow(subscriptions.configs);
      return { kind: "following", named };
    } catch (thrown) {
      for (const origin of named) markUnreceived(origin);
      const failure = failureOf(thrown);
      notTaken("configs", failure);
      return { kind: "failed", failure };
    }
  };

  const markUnreceived = (origin: RenderOrigin): void => {
    const key = originKey(origin);
    if (configs.get(key) === "scheduled") configs.set(key, "unreceived");
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
  ): Promise<ConfigTurn> => {
    let made: Made;
    try {
      made = configMade(origin)();
    } catch (thrown) {
      made = failureOf(thrown);
      record(null, [["why", why]], unanswered(made, 0).turn);
    }
    // [LAW:no-silent-failure] An origin let go before its slot ran nothing
    // that waited on it, so the turn that named it did not do what it asked.
    if (made.kind !== "event")
      return {
        kind: "unreceived",
        failure: made,
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
    const outcomes = settled.then((outcomes) => [...threw, ...outcomes]);
    return turn.kind === "threw" && turn.turnMs === null
      ? { kind: "unreceived", failure: turn.failure, settled: outcomes }
      : {
          kind: "received",
          failure: turn.kind === "threw" ? turn.failure : null,
          settled: outcomes,
        };
  };

  // [LAW:no-silent-failure] Each effect's outcome goes back to the renderer
  // that returned it, as its `effect-done` turn. An act's failure that no
  // session's bar can hold — one with no session, or one whose renderer has
  // ended — is the daemon's, on every bar. The trust book's answer lands with
  // the turn's changes, and its failure is theirs.
  const doneOf = (
    effect: Pick<Effect, "id" | "session">,
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
  // Worker-local effect IDs start again at boot. A socket can finish after
  // its worker exits, or while the replacement's start is heading the mailbox.
  const receiptFor =
    (issuer: number): SettlePresentation =>
    (effect, reason) => {
      if (issuer !== generation) return;
      const retired = "the renderer that drew the frame has ended";
      unawaited(
        "frame receipt",
        deliver(
          () =>
            issuer === generation
              ? doneOf(
                  effect,
                  reason === null ? { kind: "ok" } : { kind: "failed", reason },
                )
              : { kind: "down", message: retired, detail: retired },
          [["effect", String(effect.id)]],
        ),
      );
    };
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
    effect: Effect,
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
    click: SessionId | null = null,
  ): Promise<{ readonly event: Event | null; readonly slotted: Slotted }> => {
    const held =
      click === null
        ? null
        : (pendingClicks.get(click) ?? { session: click, count: 0 });
    if (held !== null) {
      held.count++;
      pendingClicks.set(held.session, held);
    }
    return inMailbox(async (queuedMs, holds) => {
      try {
        // [LAW:no-silent-failure] A make that threw is the turn's failure.
        let made: Made;
        try {
          made = make();
        } catch (thrown) {
          made = failureOf(thrown);
        }
        // A new renderer holds no config, even if its start was not made or
        // could not be answered. The first mailbox place belongs to start.
        if (
          at === "first" ||
          (made.kind === "event" && made.event.kind === "start")
        )
          configs.clear();
        if (made.kind !== "event")
          return { event: null, slotted: unanswered(made, queuedMs) };
        holds(made.event.kind);
        return {
          event: made.event,
          slotted: await inSlot(
            stamped(made),
            queuedMs,
            made.event.kind === "click" ? made.runEvidence : undefined,
          ),
        };
      } finally {
        // [LAW:no-ambient-temporal-coupling] Release before the mailbox can
        // select another slot, including when this click was refused.
        if (held !== null && --held.count === 0)
          pendingClicks.delete(held.session);
      }
    }, at);
  };
  // One input from its arrival to its settling: its acts settled after its
  // slot.
  const taken = async (
    make: () => Made,
    at: Place = "last",
    click: SessionId | null = null,
  ): Promise<{ readonly event: Event | null; readonly turn: HostTurn }> => {
    const { event, slotted } = await throughSlot(make, at, click);
    return {
      event,
      turn: { ...slotted.turn, settled: await slotted.settled },
    };
  };
  const answer = async (make: () => Made): Promise<HostTurn> =>
    (await taken(make)).turn;
  const answerClick = async (
    session: SessionId | null,
    make: () => Made,
  ): Promise<HostTurn> => (await taken(make, "last", session)).turn;
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
        const { subscriptions, stored, ...answered } = await renderer.answer({
          kind: "adapter",
          push,
          ...readingsAt(clock),
        });
        // [LAW:no-ambient-temporal-coupling] A push's newly named configs
        // enter before the next queued slot, as they do for an event.
        const followed = took(
          subscriptions,
          [],
          stored,
          null,
          receiptFor(generation),
        );
        if (followed.kind === "following")
          for (const origin of followed.named) {
            const config = await configInSlot(origin, "config-subscribed");
            if (config.kind === "unreceived") markUnreceived(origin);
            unawaited("config", config.settled);
          }
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
  // [LAW:no-ambient-temporal-coupling] The mailbox bounds the ordinary turns
  // ahead of a `due`. Its input carries any pending clicks so the renderer
  // can leave those sessions' menus alone. Its acts settle outside the slot.
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
            : {
                kind: "event",
                event: {
                  kind: "due",
                  pendingClicks: [...pendingClicks.keys()],
                },
              },
        "scheduled",
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
    answerClick,
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
      return event.click.scope === "session" ? event.click.session : null;
    case "retire":
    case "effect-done":
      return event.session;
    // Every watched session's, or the renderer's own.
    case "viewers":
    case "due":
      return null;
  }
}

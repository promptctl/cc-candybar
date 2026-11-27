// The host's one path to a renderer: every input it hands one passes the
// renderer's mailbox, and is one turn, which answers with the turn's output or
// with how the turn failed: a turn's throw comes back as a value, never as a
// rejection. Subscription changes are taken here, in the order the turns
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
  isCommand,
  sessionOfEvent,
  type ConfigChange,
  type Command,
  type CommandReply,
  type ReplyTo,
  type Effect,
  type EffectOutcome,
  type Event,
  type EventInput,
  type Notification,
  type Present,
  type PushedFrame,
  type RendererOutput,
  type TimedRenderer,
  type Timed,
  type TurnFailure,
  type TurnOutcome,
  type Subscriptions,
  type TurnRecord,
} from "../renderer-interface/interface.js";
import { eventLine } from "../utils/logfmt.js";
import { readingsAt } from "../utils/instant.js";
import type { DaemonEvent } from "../utils/event-hold.js";
import type { StoreReport } from "./foundations/stored-file.js";
import type { StoreWrite } from "../renderer-interface/stored-state.js";
import { elapsedMs, type Monotonic, type Timekeeper } from "../time.js";
import type { DaemonLogger } from "../utils/logger";
import { KeyedSerialQueue, type Place } from "../utils/keyed-serial-queue.js";
import type { SessionId } from "./foundations/session-id.js";
import { LEVEL } from "./foundations/request-event.js";
import type { MailboxStats } from "./foundations/stats-snapshot.js";
import { inspectionPayloadProblem } from "./foundations/inspection-reply.js";
import { CrossedFailure, type Failure } from "./foundations/verb-error.js";
import { failureOf } from "./foundations/host-failure.js";
import {
  performChanges,
  configEffectOutcome,
  type ApproveRepo,
  type ConfigLanding,
} from "./effect-interpreter.js";
import type { WriteConfigFile } from "./file-rewrites.js";
import {
  actLine,
  desktopActOf,
  outlives,
  type HostAct,
  type HostOutcome,
} from "./acts.js";
import type { RequestedRun, RunAct } from "./foundations/run-authorization.js";
import type { RunEvidence } from "../click/wire.js";
import type { Asked } from "../utils/outcome.js";
import { RendererWake } from "./renderer-wake.js";
import { isEnvironmentOutput } from "./environment-output.js";
import { originKey, type RenderOrigin } from "../config-hint.js";
import type { ConfigSnapshot } from "../config/config-snapshot.js";
import type { RendererConfigs } from "./config-discovery/config-discovery.js";

import type { ActsOn } from "./foundations/protocol.js";
import type { RendererName } from "./foundations/renderer-name.js";

// A turn as the host took it: how it ended, how long it waited in the
// mailbox, how long the renderer's turn took and what the hop to it cost, null
// for a turn no renderer answered, and how each of its effects settled before
// it returned: its changes, and the acts over in the turn, in the order they
// were returned.
export type HostTurn = TakenTurn & {
  readonly settled: readonly HostOutcome[];
};
type SettlePresentation = (
  effect: Pick<Present, "id" | "session" | "displayedEvents">,
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

// [LAW:nothing-unseen] Give every secondary renderer failure its own field
// in the diagnostic for the input that encountered it.
const finalizationFields = (
  outcome: { readonly kind: "answered" } | TurnFailure,
): Array<TurnRecord[number]> | undefined =>
  outcome.kind === "threw"
    ? outcome.secondary?.map(({ stage, failure }) => [
        `finalize.${stage}`,
        `${failure.kind}: ${failure.detail}`,
      ])
    : undefined;

// What a caller makes as its input's slot comes up: the event, or why there
// is none to send, which is the turn's failure. The host stamps it with the
// slot's readings.
type StartEvent = Extract<Event, { kind: "start" }>;
type StartRequest = Omit<StartEvent, "configs">;
type BeforeDiscovery = Exclude<Notification, StartEvent> | StartRequest;

interface MadeEvent<E = Event> {
  readonly kind: "event";
  readonly event: E;
  // [LAW:locality-or-seam] Host-only data. Stamping sends the event alone.
  readonly runEvidence?: readonly RunEvidence[];
  readonly actsOn?: ActsOn;
}
export type Made<E = BeforeDiscovery> = MadeEvent<E> | Failure;
type MadeClick =
  | (MadeEvent<Extract<Notification, { kind: "click" }>> & {
      readonly actsOn: ActsOn;
    })
  | Failure;

// What the host's turns act in: the performer of acts, the trust book's
// directory, what config discovery found at each origin it follows, whether
// the daemon's close has begun, and where an act's failure goes that no
// session's bar can hold.
export interface HostWorld {
  // All renderer mailboxes draw their session writer from the same daemon.
  sessionWriter<T>(session: SessionId, land: () => Promise<T>): Promise<T>;
  readonly authorizeRun: (
    request: RequestedRun,
    captures: readonly RunEvidence[],
  ) => Asked<RunAct>;
  readonly perform: (act: HostAct) => Promise<EffectOutcome>;
  readonly stateDir: string;
  readonly configs: RendererConfigs;
  readonly writeConfigFile?: WriteConfigFile;
  readonly closing: () => boolean;
  readonly acknowledgeDisplayed: (events: readonly DaemonEvent[]) => void;
  // What a store found of its file, said as every store's is.
  readonly reported: (reports: readonly StoreReport[]) => void;
  readonly unheard: (text: string, fromEnvironment?: true) => void;
}

export interface RendererHost {
  readonly name: RendererName;
  // [LAW:no-ambient-temporal-coupling] Begin or end a recording between
  // complete turns. Replacing the worker here cannot interrupt a draw.
  recordingBoundary<T>(operation: () => Promise<T>): Promise<T>;
  // One turn, recorded by the caller: a request's answer writes both its
  // turns on the request's render event. `make` is called as the input's
  // slot comes up, and answers the input, or why there is none to send,
  // which is the turn's failure.
  answer(make: () => Made): Promise<HostTurn>;
  // A click keeps its session busy until its mailbox slot lands.
  answerClick(
    session: SessionId | null,
    make: () => MadeClick,
  ): Promise<HostTurn>;
  // One turn, recorded on its own line. `about` is what the host knows of the
  // input beyond its session, for that line.
  deliver(make: () => Made, about: TurnRecord): Promise<TurnOutcome>;
  // A fresh renderer's start, recorded on its own line: it heads the
  // mailbox, behind only the slot in progress, since every input after it is
  // about the sessions it hands in.
  start(
    make: () => Made<StartRequest>,
    about: TurnRecord,
  ): Promise<TurnOutcome>;
  // An inspection or teardown event, answered by its own reply. One whose
  // asker stopped waiting (`until` aborted) before its slot is not made, and
  // rejects with the signal's reason.
  command<C extends Command>(
    event: C,
    until?: AbortSignal,
  ): Promise<ReplyTo<C["kind"]>>;
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
  readonly received: boolean;
  readonly turn: TakenTurn;
  readonly settled: Promise<readonly HostOutcome[]>;
}

type ConfigDelivery =
  | { readonly kind: "scheduled" | "unreceived" }
  // The immutable observation actually offered to this worker. Discovery
  // may publish a newer observation before the worker selects this one.
  | { readonly kind: "received"; readonly config: ConfigSnapshot };

type ConfigFollowing =
  | { readonly kind: "following"; readonly named: readonly RenderOrigin[] }
  | { readonly kind: "failed"; readonly failure: Failure };

type ConfigTurn = {
  readonly settled: Promise<readonly HostOutcome[]>;
} & (
  | { readonly kind: "received"; readonly failure: Failure | null }
  | { readonly kind: "unreceived"; readonly failure: Failure }
);

export function rendererHost(
  name: RendererName,
  // The clock every input's readings are made on, a hop is timed on, and the
  // renderer's wake is armed on.
  clock: Pick<Timekeeper, "now" | "monotonic" | "after" | "detach">,
  renderer: TimedRenderer,
  log: DaemonLogger,
  collector: {
    // [LAW:single-enforcer] Where changed subscriptions go: the
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
  const mailbox = new KeyedSerialQueue<RendererName>(
    clock.detach,
    (name) => `renderer ${name} mailbox`,
  );
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
  let declared: Subscriptions | undefined;
  let origins: Subscriptions["configs"] | undefined;
  // A declaration can name origins that discovery failed to acquire. Keep
  // the last applied holds so an unsuccessful START can restore them.
  let followedOrigins: Subscriptions["configs"] = [];
  let selected: Subscriptions["configSelections"] | undefined;
  let followFailure: Failure | null = null;
  // [LAW:no-ambient-temporal-coupling] Only a complete replacement can
  // publish over the predecessor's declaration. Later inputs stay out of a
  // generation whose initial turn never reached that point.
  let startFailure: Failure | null = null;

  type StartResult =
    | { readonly kind: "threw"; readonly failure: Failure }
    | { readonly kind: "answered"; readonly event: StartEvent };

  const endedStart = (result: StartResult): void => {
    startFailure = result.kind === "threw" ? result.failure : null;
    if (result.kind === "threw") return;
    configs.clear();
    for (const { origin, config } of result.event.configs)
      configs.set(originKey(origin), { kind: "received", config });
    declared = undefined;
    origins = undefined;
    selected = undefined;
    followFailure = null;
  };

  const follow = (wanted: Subscriptions["configs"]): void => {
    world.configs.follow(wanted);
    followedOrigins = wanted;
  };

  // [LAW:one-source-of-truth] Restoring a generation uses the same discovery
  // holds as an ordinary config turn. It still follows preceding origins
  // until the replacement answers with its own complete declaration.
  const prepareStart = (
    event: Omit<StartEvent, "configs">,
    borrow: (wanted: Subscriptions["configs"]) => void,
  ): StartEvent => {
    const wanted = new Map(followedOrigins.map((o) => [originKey(o), o]));
    for (const origin of origins ?? []) wanted.set(originKey(origin), origin);
    for (const { context } of event.sessions)
      wanted.set(originKey(context.requested), context.requested);
    if (wanted.size > followedOrigins.length || followFailure !== null)
      borrow([...wanted.values()]);
    const configs = [...wanted].map(([key, origin]) => {
      const config = world.configs.snapshotOf(origin);
      if (config === null)
        throw new Error(`no config snapshot for renderer start origin ${key}`);
      const retained = world.configs.retainedOf(origin);
      return {
        origin,
        config,
        ...(retained === undefined ? {} : { retained }),
      };
    });
    return { ...event, configs };
  };

  // [LAW:single-enforcer] The one way into the renderer's turn: `slot` once
  // every slot asked for before it has ended, handed how long it waited and
  // a way to name the input holding it.
  const inMailbox = <T>(
    slot: (queuedMs: number, holds: (input: string) => void) => Promise<T>,
    at: Place = "last",
    writer: SessionId | null = null,
  ): Promise<T> => {
    const asked = clock.monotonic();
    queued++;
    const land = async () => {
      queued--;
      const queuedMs = elapsedMs(clock, asked);
      const held = { input: "-", since: clock.monotonic() };
      holder = held;
      try {
        return await slot(queuedMs, (input) => void (held.input = input));
      } finally {
        holder = null;
      }
    };
    const enter = () => mailbox.run(name, land, at);
    // [LAW:no-ambient-temporal-coupling] Wait for this session outside the
    // renderer mailbox. Another session can use the idle peer while the
    // first gesture commits. Outliving desktop acts settle after this slot.
    return writer === null ? enter() : world.sessionWriter(writer, enter);
  };

  // A turn no renderer answered: nothing of it was taken, so the
  // subscriptions last taken stand.
  const unanswered = (failure: Failure, queuedMs: number): Slotted => ({
    received: false,
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

  const commandLabel = (event: Command): string =>
    `renderer ${name} command ${event.kind}`;

  // [LAW:parse-dont-validate] Check correlation before the host can accept
  // a successful command's stores or declarations.
  const requireReply = (
    event: Command,
    reply: CommandReply | undefined,
  ): void => {
    const label = commandLabel(event);
    if (reply == null) throw new Error(`${label} returned no reply`);
    if (reply.kind !== event.kind)
      throw new Error(`${label} returned a ${reply.kind} reply`);
    if (
      event.kind === "debug" &&
      reply.kind === "debug" &&
      reply.snapshot?.what !== event.what
    )
      throw new Error(`${label} returned no ${event.what} snapshot`);
    if (reply.kind === "stats" && reply.stats == null)
      throw new Error(`${label} returned no stats snapshot`);
    const problem = inspectionPayloadProblem(reply);
    if (problem !== null) throw new Error(`${label} returned ${problem}`);
  };

  // [LAW:single-enforcer] The transport owns whether the renderer
  // answered. Host failures during landing cannot replace that answer.
  const inSlot = async (
    input: EventInput,
    queuedMs: number,
    captures: readonly RunEvidence[] = [],
    actsOn: ActsOn = "daemon",
  ): Promise<Slotted> => {
    if (input.event.kind === "start") generation++;
    const receipt = receiptFor(generation);
    const session = sessionOfEvent(input.event);
    let release = (): void => {};
    let output: Timed<RendererOutput>;
    let sentAt: Monotonic;
    try {
      if (session !== null) release = collector.holding(session);
      sentAt = clock.monotonic();
      output = await renderer.answer(input);
    } catch (thrown) {
      recordTaken("session release", release);
      const failure = failureOf(thrown);
      if (input.event.kind === "start") endedStart({ kind: "threw", failure });
      return unanswered(failure, queuedMs);
    }
    recordDiagnostics(output.diagnostics);
    if (isCommand(input.event)) {
      if (output.kind === "answered") requireReply(input.event, output.reply);
      if (output.frames.length > 0 || output.effects.length > 0) {
        // [LAW:effects-at-boundaries] Commands can finalize stores and
        // declarations. Their replies cannot publish a frame or act.
        const problem = `${commandLabel(input.event)} returned a frame or effect`;
        if (output.kind === "answered") throw new Error(problem);
        recordDiagnostics([{ level: "error", line: problem }]);
        output = { ...output, frames: [], effects: [] };
      }
    } else if (output.kind === "answered" && output.reply !== undefined) {
      recordDiagnostics([
        {
          level: "error",
          line: `renderer ${name} returned an unasked command reply to ${input.event.kind}`,
        },
      ]);
    }
    if (input.event.kind === "config" && startFailure === null) {
      const key = originKey(input.event.origin);
      if (configs.has(key))
        configs.set(key, { kind: "received", config: input.event.config });
    }
    const {
      subscriptions,
      wake,
      frames,
      stored,
      diagnostics: _diagnostics,
      turnMs,
      ...answer
    } = output;
    const finalization = finalizationFields(answer);
    const turn: TakenTurn = {
      ...answer,
      record:
        finalization === undefined
          ? answer.record
          : [...answer.record, ...finalization],
      settlePresentation: receipt,
      queuedMs,
      turnMs,
      hopMs:
        turnMs === null
          ? null
          : recordTaken(
              "renderer round-trip timing",
              () => elapsedMs(clock, sentAt) - turnMs,
            ),
    };
    if (input.event.kind === "start")
      endedStart(
        turn.kind === "threw" ? turn : { kind: "answered", event: input.event },
      );
    recordTaken("turn record", () => collector.recorded(turn.record));
    const { settled, configFailure } = await landInSlot(
      input.event,
      output,
      captures,
      receipt,
      actsOn,
    );
    return {
      received: true,
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
    actsOn: ActsOn,
  ): Promise<{
    readonly settled: Promise<readonly HostOutcome[]>;
    readonly configFailure: Failure | null;
  }> => {
    const changes = output.effects.filter(
      (effect): effect is ConfigChange => effect.kind === "change",
    );
    const answers = output.effects.filter(
      (effect): effect is ApproveRepo => effect.kind === "approve-repo",
    );
    const landed = landConfig(changes, answers);
    if (landed.kind === "ok")
      recordTaken("landed config report", () => world.reported(landed.reports));
    const configOutcome = configEffectOutcome(landed);
    const requested = event.kind === "context" ? event.context.requested : null;
    const requestedKey = requested === null ? null : originKey(requested);
    // A cold snapshot belongs to one click. If the renderer also wants this
    // origin after the click, its normal config turn opens waiting sessions
    // and updates their edits. Only that delivery earns a receipt.
    const retryOrigin =
      event.kind === "click" && event.coldConfig !== undefined
        ? (event.context?.durable.origin ?? null)
        : requested;
    // [LAW:no-silent-failure] The renderer's answer is a proposal. A click
    // that changed history can only report success after its host write.
    // Wake the next turn even if storage or a later collector fails.
    if (startFailure === null)
      recordTaken("wake declaration", () => wake.declare(output.wake));
    const owed: Array<Promise<HostOutcome | readonly HostOutcome[]>> = [];
    try {
      collector.stored(output.stored);
    } catch (thrown) {
      const failure = failureOf(thrown);
      notTaken("stored writes", failure);
      owed.push(Promise.resolve({ kind: "failed", reason: failure.message }));
    }
    const followed = took(
      output.subscriptions,
      output.frames,
      retryOrigin,
      receipt,
    );
    let configFailure: Failure | null = null;
    const waited: Array<Promise<readonly HostOutcome[]>> = [];
    const unreceived: RenderOrigin[] = [];
    if (followed.kind === "failed") {
      if (
        requestedKey !== null &&
        configs.get(requestedKey)?.kind !== "received"
      )
        configFailure = followed.failure;
    } else {
      for (const origin of followed.named) {
        const config = await configInSlot(origin, "config-subscribed");
        if (originKey(origin) === requestedKey) configFailure = config.failure;
        if (config.kind === "unreceived") unreceived.push(origin);
        waited.push(config.settled);
      }
    }
    // [LAW:dataflow-not-control-flow] Observe a successful write or an
    // unrestored file through the same discovery path before effect-done.
    const moved =
      "files" in landed && landed.files.length > 0
        ? (recordTaken("landed config discovery", () =>
            world.configs.landed(landed.files),
          ) ?? [])
        : [];
    const reloaded: Array<Promise<readonly HostOutcome[]>> = [];
    for (const origin of moved)
      reloaded.push((await configInSlot(origin, "config-landed")).settled);

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
        owed.push((await settleInSlot(effect, configOutcome)).settled);
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

    // [LAW:single-enforcer] The connection owns the destination. Only the
    // acts of this writer's click can leave in its reply.
    // [LAW:nothing-unseen] An act handed to the desktop is said on its act line
    // as any act is.
    const performed = async (act: HostAct): Promise<HostOutcome> => {
      const desktop = actsOn === "desktop" ? await desktopActOf(act) : null;
      if (desktop === null) return world.perform(act);
      log("info", actLine(act, "desktop", "handed to the desktop"));
      return Promise.resolve({ kind: "desktop", act: desktop });
    };
    let before: Promise<unknown> = Promise.resolve();
    for (const act of acts) {
      const acted =
        configOutcome.kind === "ok"
          ? before
              .then(() => performed(act))
              .catch(
                (error: unknown): EffectOutcome => ({
                  kind: "failed",
                  reason: failureOf(error).detail,
                }),
              )
          : Promise.resolve<HostOutcome>(
              configOutcome.kind === "closing"
                ? configOutcome
                : {
                    kind: "skipped",
                    reason: `not performed: ${configOutcome.reason}`,
                  },
            );
      const settled = acted.then((outcome) => settle(act, outcome));
      if (outlives(act)) unawaited("act", () => settled);
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
    ]).then(([caused, , own]) => [...caused.flat(), ...own.flat()]);
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
        return { kind: "ok", files: [], reports: [] };
      return performChanges(
        changes,
        {
          stateDir: world.stateDir,
          answers,
          said: (line) =>
            void recordTaken("trust book record", () => log("info", line)),
        },
        world.configs,
        world.writeConfigFile,
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

  // [LAW:single-enforcer] The accepting slot writes each line once, at its
  // original level, before the turn's effects can produce further input.
  const recordDiagnostics = (
    diagnostics: RendererOutput["diagnostics"],
  ): void => {
    for (const { level, line } of diagnostics ?? []) {
      try {
        log(level, line);
      } catch (thrown) {
        // A failed log sink cannot report its own failure. The daemon can
        // still show the diagnostic and the reason it could not be written.
        world.unheard(
          `renderer ${name} could not log ${line}: ${failureOf(thrown).detail}`,
        );
      }
    }
  };

  // [LAW:single-enforcer] Publish the frames and follow the declarations.
  // A failed replacement still owes its frames their receipts while the
  // predecessor's demand stays in place.
  // [LAW:no-silent-failure] A taker's throw is the daemon's, on every bar.
  const took = (
    subscriptions: Subscriptions,
    frames: readonly PushedFrame[],
    requested: RenderOrigin | null,
    receipt: SettlePresentation,
  ): ConfigFollowing => {
    // [LAW:effects-at-boundaries] A failed replacement still owes its own
    // collected writes and effects. Its view and wake declarations cannot
    // replace the predecessor's, including during effect settlement.
    const adoptDemand = startFailure === null;
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
    if (!adoptDemand) return { kind: "following", named: [] };
    const named: RenderOrigin[] = [];
    const moved = origins !== subscriptions.configs;
    if (moved) {
      const next = new Map<string, ConfigDelivery>();
      for (const origin of subscriptions.configs) {
        const key = originKey(origin);
        const before = configs.get(key);
        if (before === undefined) {
          named.push(origin);
          next.set(key, { kind: "scheduled" });
        } else next.set(key, before);
      }
      // A renderer has already dropped any unlisted config, even when the
      // host cannot update its discovery subscriptions.
      configs = next;
      origins = subscriptions.configs;
    }
    // [LAW:no-ambient-temporal-coupling] A context or cold click retries its
    // undelivered config while the renderer still asks for that origin.
    // A feed tick cannot poll a failed follow or delivery.
    if (requested !== null) {
      const key = originKey(requested);
      if (configs.get(key)?.kind === "unreceived") {
        named.push(requested);
        configs.set(key, { kind: "scheduled" });
      }
    }
    try {
      if (moved || (requested !== null && followFailure !== null)) {
        if (
          subscriptions.configs.length > 0 ||
          followedOrigins.length > 0 ||
          followFailure !== null
        )
          follow(subscriptions.configs);
        followFailure = null;
      }
      if (followFailure !== null)
        return { kind: "failed", failure: followFailure };
      const entries = subscriptions.configSelections;
      if (selected !== entries) {
        world.configs.selected(entries, (origin) => {
          const delivered = configs.get(originKey(origin));
          return delivered?.kind === "received" ? delivered.config : undefined;
        });
        selected = entries;
      }
      // Plugin sources and folders can only refer to origins the host now
      // follows. Publish demand after resolving the selected observations.
      if (
        (declared?.sources !== subscriptions.sources ||
          declared?.managedFolders !== subscriptions.managedFolders ||
          declared?.lanes !== subscriptions.lanes) &&
        recordTaken("subscriptions", () =>
          collector.subscribed(subscriptions),
        ) !== null
      )
        declared = subscriptions;
      return { kind: "following", named };
    } catch (thrown) {
      for (const origin of named) markUnreceived(origin);
      const failure = failureOf(thrown);
      followFailure = failure;
      notTaken("configs", failure);
      return { kind: "failed", failure };
    }
  };

  const markUnreceived = (origin: RenderOrigin): void => {
    const key = originKey(origin);
    if (configs.get(key)?.kind === "scheduled")
      configs.set(key, { kind: "unreceived" });
  };

  // [LAW:one-source-of-truth] An origin's `config`, made from what discovery
  // holds as its slot comes up. One discovery no longer follows (the
  // renderer let it go before the slot) has nothing to hand in: its reason
  // left first.
  const configMade =
    (origin: RenderOrigin) =>
    (): Made<Extract<Notification, { kind: "config" }>> => {
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
    let made: Made<Event>;
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
    const { received, turn, settled } = await inSlot(input, 0);
    record(input.event, [["why", why]], turn);
    // A config failure belongs to the turn that requested its delivery.
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
    return turn.kind === "threw" && !received
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
  ): MadeEvent<Notification> => ({
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
      // [LAW:effects-at-boundaries] The write can acknowledge a daemon
      // event after its renderer has gone. Only the local receipt needs
      // the generation that issued it.
      if (reason === null && effect.displayedEvents !== undefined)
        world.acknowledgeDisplayed(effect.displayedEvents);
      if (issuer !== generation) return;
      const retired = "the renderer that drew the frame has ended";
      unawaited("frame receipt", () =>
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
    ended: HostOutcome,
  ): Promise<HostOutcome> => {
    // The renderer is told `ok` of an act handed to the desktop: the daemon's
    // part of it is done. What the desktop then does is its own to tell.
    const outcome: EffectOutcome =
      ended.kind === "desktop" ? { kind: "ok" } : ended;
    const failed =
      outcome.kind === "failed" || outcome.kind === "refused"
        ? outcome.reason
        : null;
    const unheard = (reason: string): void => {
      if (isEnvironmentOutput(outcome)) world.unheard(reason, true);
      else world.unheard(reason);
    };
    if (failed !== null && effect.session === null) unheard(failed);
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
      unheard(failed);
    return ended;
  };
  // A change's or a refused present's, in the slot of the turn that
  // returned it: settled once that `effect-done` turn's own acts have.
  const settleInSlot = async (
    effect: Effect,
    outcome: EffectOutcome,
  ): Promise<{ readonly settled: Promise<readonly HostOutcome[]> }> => {
    const input = stamped(doneOf(effect, outcome));
    const { turn, settled } = await inSlot(input, 0);
    record(input.event, [["effect", String(effect.id)]], turn);
    // A file can land while its undo step, emitted by this receipt, fails to
    // reach the journal. Both outcomes belong to the originating click.
    return { settled: settled.then((children) => [outcome, ...children]) };
  };

  // A turn's line, when it learned something or failed: `event` is null when
  // its make threw, so no input was made.
  const record = (
    event: Event | null,
    about: TurnRecord,
    delivered: TakenTurn,
  ): void => {
    const session = event === null ? null : sessionOfEvent(event);
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
        // [LAW:single-enforcer] The supervisor identifies interrupted
        // inputs and counts those refused while no worker was live.
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
    make: () => Made<BeforeDiscovery | Command>,
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
    const slot = async (queuedMs: number, holds: (input: string) => void) => {
      let restore: Subscriptions["configs"] | undefined;
      try {
        // [LAW:no-silent-failure] A make that threw is the turn's failure.
        let made: Made<Event>;
        let starting = at === "first";
        try {
          const captured = make();
          if (captured.kind === "event") {
            const { event } = captured;
            if (event.kind === "start") {
              starting = true;
              const ready = prepareStart(event, (wanted) => {
                // Discovery can acquire some watches before it fails.
                restore = followedOrigins;
                follow(wanted);
              });
              made = { ...captured, event: ready };
            } else if (
              event.kind === "click" &&
              event.context !== null &&
              configs.get(originKey(event.context.durable.origin))?.kind !==
                "received"
            ) {
              const origin = event.context.durable.origin;
              // [LAW:effects-at-boundaries] Borrow discovery until this click lands.
              // Its renderer then declares the config it retained, as on a draw.
              if (
                !followedOrigins.some(
                  (held) => originKey(held) === originKey(origin),
                )
              ) {
                restore = followedOrigins;
                follow([...followedOrigins, origin]);
              }
              const config = configMade(origin)();
              if (config.kind !== "event") made = config;
              else
                made = {
                  ...captured,
                  event: { ...event, coldConfig: config.event.config },
                };
            } else made = { ...captured, event };
          } else made = captured;
        } catch (thrown) {
          made = failureOf(thrown);
        }
        if (made.kind !== "event") {
          if (starting) endedStart({ kind: "threw", failure: made });
          return { event: null, slotted: unanswered(made, queuedMs) };
        }
        if (
          !starting &&
          startFailure !== null &&
          made.event.kind !== "effect-done"
        )
          return { event: null, slotted: unanswered(startFailure, queuedMs) };
        holds(made.event.kind);
        const slotted = await inSlot(
          stamped(made),
          queuedMs,
          made.event.kind === "click" ? made.runEvidence : undefined,
          made.event.kind === "click" ? made.actsOn : undefined,
        );
        if (starting && slotted.turn.kind === "answered") restore = undefined;
        if (made.event.kind === "click" && restore !== undefined)
          restore = origins ?? restore;
        return { event: made.event, slotted };
      } finally {
        // Config effects land inside the slot. Keep their discovery holds
        // until then, and restore previous demand before another input.
        if (restore !== undefined) {
          const previous = restore;
          recordTaken("restore config demand", () => follow(previous));
        }
        // [LAW:no-ambient-temporal-coupling] Release before the mailbox can
        // select another slot, including when this click was refused.
        if (held !== null && --held.count === 0)
          pendingClicks.delete(held.session);
      }
    };
    return inMailbox(slot, at, click);
  };
  // One input from its arrival to its settling: its acts settled after its
  // slot.
  const taken = async (
    make: () => Made<BeforeDiscovery | Command>,
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
    make: () => MadeClick,
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
  // [LAW:no-silent-failure] A turn's settling nothing awaits is the clock's,
  // whose report puts what it threw on every bar: one made by `settling`, or
  // one already running that it hands over.
  const unawaited = (what: string, settling: () => Promise<unknown>): void =>
    clock.detach(`renderer ${name} ${what}`, settling);
  // [LAW:single-enforcer] A command uses the same slot and lands every
  // part of its turn before its caller can use the result.
  const command = async <C extends Command>(
    event: C,
    until?: AbortSignal,
  ): Promise<ReplyTo<C["kind"]>> => {
    // [LAW:no-ambient-temporal-coupling] An ask ends with its wait: one no one
    // waits for any more takes no turn of the renderer's.
    let made = true;
    const { turn } = await taken(() => {
      if (until?.aborted !== true) return { kind: "event", event };
      made = false;
      return {
        kind: "abandoned",
        message: "its asker stopped waiting",
        detail: `${commandLabel(event)} was not made: its asker stopped waiting`,
      };
    });
    if (!made) throw until?.reason;
    if (turn.kind === "threw") {
      const label = commandLabel(event);
      const fields = finalizationFields(turn) ?? [];
      if (turn.turnMs !== null) fields.unshift(["took", `${turn.turnMs}ms`]);
      fields.push(["error", turn.failure.detail]);
      throw new CrossedFailure({
        ...turn.failure,
        message: `${label} threw: ${turn.failure.message}`,
        detail: eventLine(`${label} threw`, fields),
      });
    }
    // [LAW:types-are-the-program] exception: inSlot admits the corresponding
    // reply before landing. The shared turn type cannot carry that correlation.
    return turn.reply as ReplyTo<C["kind"]>;
  };
  const moved = (origins: readonly RenderOrigin[]): void => {
    for (const origin of origins)
      unawaited("config", () =>
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
    task: `renderer ${name} wake`,
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
      unawaited("due acts", () => settled);
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
    recordingBoundary: (operation) =>
      inMailbox(async (_queued, holds) => {
        holds("recording");
        return operation();
      }),
    answer,
    answerClick,
    deliver,
    start: recorded("first"),
    command,
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

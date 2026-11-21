// The main renderer, in process: today's request answer behind the renderer
// interface (src/renderer-interface/interface.ts). A `context` turn records
// the session's context and opens its view there, so its output names what
// the view reads before the request after it waits. A `config` turn hands in
// what discovery found at an origin the renderer names, and resumes waiting
// work that still needs it. A request draws the bar at the session's current
// context and returns it as a `present` in the request's own slot. That present's
// `effect-done` records what the frame showed, once the host says whether its
// client took it. A world state the host hands in, with a `context` or alone,
// is what the session's views draw from, and a retire ends what the renderer
// holds of the session. A click acts in its turn, and a `due` runs what the
// renderer held for its tick: work deferred, the close of a session's idle
// menus, and its feeds' frames. Every output says what the open views need
// read, which origins' config the renderer holds, and when it next wants a
// turn, as they stand once the turn's act has landed.

import {
  answerRequest,
  deliver,
  openSession,
  contextFacts,
  renderFrame,
  retireSession,
  viewLanes,
  type Delivery,
  type RendererParts,
} from "./draw-bar.js";
import { TurnTime } from "./turn-time.js";
import { TurnLog } from "./turn-log.js";
import { runEach } from "../utils/run-each.js";
import { FEED_PERIODS, Feeds } from "./feeds.js";
import type { LaneSwitches } from "../config/lanes.js";
import {
  noteFacts,
  type RequestFacts,
} from "../daemon/foundations/request-event.js";
import { clickTurn } from "./click.js";
import {
  verbsOver,
  type DaemonVerbContext,
  type MainRendererParts,
} from "./verbs/port.js";
import type { StoreWrite } from "../renderer-interface/stored-state.js";
import { createGates } from "../daemon/foundations/gates.js";
import { originKey, type RenderOrigin } from "../config-hint.js";
import {
  heardContextOf,
  type CheckedRenderRequest,
  type DurableContext,
  type SessionContext,
} from "../renderer-interface/request-context.js";
import type {
  DebugSnapshot,
  DebugWhat,
} from "../daemon/foundations/debug-types.js";
import { holdClickError } from "../daemon/foundations/click-error.js";
import { floorOf } from "../config/globals-fields.js";
import { EditTransactions } from "./edit-transaction.js";
import { EDIT_MODE_KEY } from "../config/loader/edit-mode.js";
import { sessionIdOf } from "../daemon/foundations/session-id.js";
import { SessionState } from "./session-state.js";
import { SettingsHistory } from "./settings-history.js";
import { disclosureNest } from "../config/disclosure-nest.js";
import { NavigationHistory } from "./navigation-history.js";
import { ActsOnTheirWay } from "./acts.js";
import { WorldStates } from "./world-states.js";
import { sessionSource, type SessionSource } from "./session-source.js";
import {
  configLoadedLine,
  RenderCache,
  renderCacheBudget,
} from "./render-cache.js";
import {
  buildDebugSnapshot,
  EMPTY_RENDER_MAP,
  serializeSegmentCells,
} from "./debug.js";
import { earliestOf, type Tick } from "../utils/instant.js";
import { rendererFailureOf } from "../daemon/foundations/verb-error.js";
import {
  isCommand,
  type Command,
  type Effect,
  type TurnFailure,
  type TurnFinalizer,
  type EffectId,
  type Event,
  type Notification,
  type PushedFrame,
  type ReplyTo,
  type Renderer,
  type RendererBoot,
  type RendererConstruction,
  type Subscriptions,
} from "../renderer-interface/interface.js";
import { ConfigWrites } from "./config-writes.js";
import { Kept } from "../var-system/store.js";
import {
  compareStructural,
  computed,
  observable,
  reaction,
  runInAction,
} from "mobx";
import type { SessionId } from "../daemon/foundations/session-id.js";

// A click waiting for config keeps its action and session identity.
type ParkedClick = {
  readonly session: SessionId;
  readonly event: Omit<Extract<Event, { kind: "click" }>, "context">;
} & (
  | { readonly kind: "live" }
  | { readonly kind: "cold"; readonly durable: DurableContext }
);

// How a turn ended, apart from what it returned.
type Ended<T> = { readonly kind: "answered"; readonly value: T } | TurnFailure;

type CommandKind = Command["kind"];
type CommandByKind = {
  [K in CommandKind]: Extract<Command, { readonly kind: K }>;
};
type ReplyByKind = { [K in CommandKind]: ReplyTo<K> };

type StoreDrains = Readonly<
  Record<StoreWrite["store"], () => readonly StoreWrite[]>
>;

export function mainRenderer(
  parts: MainRendererParts,
  // What each store moved since its last successful drain.
  drains: StoreDrains,
): Renderer {
  const { time, turnLog, feeds, menuIdle } = parts;
  // [LAW:single-enforcer] What each present's frame records once it reached
  // its client, held from the turn that returned it until its one
  // `effect-done`: the host settles every present it is handed, so this
  // holds only presents still on their way.
  const deliveries = new Map<EffectId, Delivery>();
  const prepare = (delivery: Delivery): EffectId => {
    const id = parts.mint();
    deliveries.set(id, delivery);
    return id;
  };
  // The subscriptions this renderer last returned: none before its first turn.
  let subscriptions: Subscriptions = {
    sources: {},
    managedFolders: [],
    configSelections: [],
    lanes: {},
    configs: [],
  };
  let wake: Tick | null = null;
  // [LAW:no-ambient-temporal-coupling] Waiting work carries its intent and
  // session. Its origin and live request are read when it resumes.
  const opening = new Set<SessionId>();
  const parked = observable.box<readonly ParkedClick[]>([], { deep: false });
  const keepParked = (keep: (click: ParkedClick) => boolean): void => {
    const prior = parked.get();
    const next = prior.filter(keep);
    if (next.length !== prior.length) runInAction(() => parked.set(next));
  };

  const parkedContext = (click: ParkedClick): SessionContext => {
    const { session } = click;
    if (click.kind === "live")
      return heardContextOf(parts.worldStates.requestOf(session));
    return (
      parts.worldStates.contextOf(session) ?? {
        session,
        durable: click.durable,
        live: null,
      }
    );
  };

  const takeClicks = (
    matches: (click: ParkedClick) => boolean,
  ): ParkedClick[] => {
    const ready: ParkedClick[] = [];
    keepParked((click) => {
      if (!matches(click)) return true;
      ready.push(click);
      return false;
    });
    return ready;
  };

  // [LAW:no-ambient-temporal-coupling] A session waits in `opening` until
  // its view opens: an opening that throws keeps it there, so its origin's
  // next `config` turn opens it again.
  const openWaiting = (session: SessionId) => () => {
    openSession(parts, session);
    opening.delete(session);
  };

  const resume = (
    ready: readonly ParkedClick[],
    effects: Effect[],
    record: RequestFacts,
  ): Array<() => void> =>
    ready.map((click) => () => {
      try {
        clickTurn(
          parts,
          { ...click.event, context: parkedContext(click) },
          effects,
          record,
        );
      } catch (thrown) {
        // [LAW:no-silent-failure] A deferred click can fail after its
        // admission turn. Its session's bar reports that failure too.
        holdClickError(
          parts.sessionState,
          click.session,
          rendererFailureOf(thrown).message,
          time.at,
        );
        throw thrown;
      }
    });

  const parkedClickSessions = (): Set<SessionId> =>
    new Set(parked.get().map((click) => click.session));

  // [LAW:types-are-the-program] Every command has a handler with its own
  // input and required reply. Notification handlers cannot answer a command.
  const commands: {
    readonly [K in CommandKind]: (event: CommandByKind[K]) => ReplyByKind[K];
  } = {
    stats: () => ({
      kind: "stats",
      stats: {
        renderCache: parts.renderCache.stats,
        effectCache: parts.renderCache.presentations.stats().effects,
        sessionState: parts.sessionStats(),
        menuIdle: menuIdle.stats(),
        rendererTurns: {
          parked: opening.size + parked.get().length,
          presents: deliveries.size,
          deferrals: time.deferrals(),
        },
        framesDrawn: feeds.drawn(),
      },
    }),
    debug: ({ what }) => ({
      kind: "debug",
      snapshot: debugOf(parts.renderCache, what),
    }),
    // [LAW:no-ambient-temporal-coupling] No journal opens after this: a turn
    // runs whole, so none is in flight.
    "close-journal": () => {
      parts.configWrites.close();
      return { kind: "close-journal" };
    },
    "close-views": () => {
      // The feeds release their pins before the corresponding views close.
      feeds.closeAll(time.tick);
      parts.renderCache.close();
      return { kind: "close-views" };
    },
  };
  const command = <K extends CommandKind>(
    event: CommandByKind[K] & { readonly kind: K },
  ): ReplyByKind[K] => commands[event.kind](event);

  // [LAW:single-enforcer] A turn's effects go to the sink its input holds,
  // so a turn that throws still hands on what it did before the throw: a
  // click's changes are owed their `effect-done` however its handler ended.
  // [LAW:no-ambient-temporal-coupling] A turn runs whole: it awaits nothing,
  // so the host's mailbox, which sends the next input only once this one has
  // answered, is the one order of the renderer's turns.
  const notify = (
    event: Notification,
    record: RequestFacts,
    effects: Effect[],
    frames: PushedFrame[],
  ): void => {
    switch (event.kind) {
      case "start": {
        const configs = new Map(
          event.configs.map((offer) => [originKey(offer.origin), offer]),
        );
        // [LAW:no-ambient-temporal-coupling] A replacement opens its views
        // against the offered facts in the first turn. An older selected
        // input establishes the state the ordinary latest attempt reloads.
        const offered = (at: RenderOrigin): void => {
          const key = originKey(at);
          const offer = configs.get(key);
          if (offer === undefined) return;
          configs.delete(key);
          const { origin, config, retained } = offer;
          if (typeof retained === "object") {
            parts.renderCache.configure(origin, retained);
            parts.renderCache.getOrCreate(origin);
          }
          parts.renderCache.configure(origin, config);
        };
        // The feeds first: a watched session's feed pins its view before
        // the view opens. Each session opens as its `context` would, so one
        // at an origin the renderer holds no config for waits for it, and
        // each whatever another's opening, or a feed, threw.
        runEach([
          () => feeds.view(event.viewers, time.tick),
          ...event.sessions.map(({ context, worldState }) => () => {
            offered(context.requested);
            notify(
              { kind: "context", context, worldState },
              record,
              effects,
              frames,
            );
          }),
          // A live session gets its cache entry before idle entries warm,
          // so they cannot take the budget a pinned view needs.
          () =>
            runEach(
              [...configs.values()].map(({ origin, retained }) => () => {
                offered(origin);
                if (retained !== undefined)
                  parts.renderCache.getOrCreate(origin);
              }),
            ),
        ]);
        return;
      }
      case "context": {
        const { context, worldState } = event;
        const session = context.hookData.session_id;
        const previous = parts.worldStates.contextOf(session);
        const origin = context.requested;
        contextFacts(context, record);
        noteFacts(record, { encoding: context.encoding });
        // [LAW:one-source-of-truth] A view cannot observe a new context
        // while it is still bound to the previous origin's config.
        runInAction(() => {
          parts.worldStates.open(context, worldState);
          const editMoved = parts.edits.moved(session, origin);
          if (
            editMoved ||
            (previous !== null &&
              originKey(previous.durable.origin) !== originKey(origin))
          )
            parts.renderCache.retireSession(session);
          opening.add(session);
          if (!parts.renderCache.holdsConfig(origin)) {
            record.push(["parked", "context"]);
            return;
          }
          const ready = takeClicks((click) => click.session === session);
          runEach([openWaiting(session), ...resume(ready, effects, record)]);
        });
        return;
      }
      case "config": {
        const key = originKey(event.origin);
        const sessions = [...opening].filter(
          (session) =>
            originKey(parts.worldStates.requestOf(session).requested) === key,
        );
        const ready = takeClicks(
          (click) => originKey(parkedContext(click).durable.origin) === key,
        );
        // [LAW:no-ambient-temporal-coupling] Waiting clicks are detached
        // before configuration, so none can requeue. Each step runs whatever
        // another throws: configuring records the offer before it loads, and
        // every later step offers it to the entry again, so a load that
        // throws reports on each step that needed it and none waits on a
        // resend.
        runEach([
          () =>
            runInAction(() =>
              parts.renderCache.configure(event.origin, event.config),
            ),
          () =>
            runEach(
              parts.edits
                .configured(event.origin, event.config)
                .map((sid) => () => parts.renderCache.refreshEditedView(sid)),
            ),
          ...sessions.map(openWaiting),
          ...resume(ready, effects, record),
        ]);
        return;
      }
      case "request": {
        // [LAW:one-source-of-truth] The request supplies its own presentation
        // and reply slot. The current session record supplies what is drawn.
        const current = parts.worldStates.requestOf(
          event.context.hookData.session_id,
        );
        // The host settles this request's answer in this turn. Config
        // failure is reported here before a present is minted.
        if (!parts.renderCache.holdsConfig(current.requested))
          throw new Error(
            `config is pending for session ${JSON.stringify(current.hookData.session_id)}`,
          );
        const { frame, delivery, displayedEvents } = answerRequest(
          parts,
          current,
          event.context.hints,
          record,
        );
        effects.push({
          kind: "present",
          id: prepare(delivery),
          session: event.context.hookData.session_id,
          surface: "statusline",
          request: event.id,
          frame,
          displayedEvents,
        });
        return;
      }
      case "world-state":
        if (!parts.worldStates.take(event.worldState))
          record.push(["world-state", "no-live-session"]);
        return;
      case "retire":
        opening.delete(event.session);
        keepParked((click) => click.session !== event.session);
        parts.edits.retire(event.session);
        retireSession(parts, event.session);
        return;
      case "effect-done": {
        if (parts.verbs.changeDone(event.of, event.outcome, effects)) return;
        if (parts.acts.done(event.of, event.session, event.outcome)) return;
        const delivery = deliveries.get(event.of);
        // [LAW:no-silent-failure] An effect this renderer never returned, or
        // one already settled, is the host's bug: said, never ignored.
        if (delivery === undefined)
          throw new Error(
            `effect-done for effect ${event.of}, which is no present, change or act on its way`,
          );
        deliveries.delete(event.of);
        if (event.outcome.kind === "ok") {
          const accepted = deliver(parts, event.of, delivery);
          if (
            delivery.candidate.by === "feed" &&
            accepted !== null &&
            accepted.faults !== null
          )
            record.push(["surface", "feed"], ["faults", accepted.faults]);
        }
        return;
      }
      case "click": {
        const { click } = event;
        const live =
          click.scope === "session"
            ? parts.worldStates.contextOf(click.session)
            : null;
        const context =
          click.scope === "session" ? (live ?? event.context) : null;
        if (context !== null) {
          const { origin } = context.durable;
          if (!parts.renderCache.holdsConfig(origin)) {
            const { context: _input, ...intent } = event;
            const waiting = { session: context.session, event: intent };
            runInAction(() =>
              parked.set([
                ...parked.get(),
                live === null
                  ? { ...waiting, kind: "cold", durable: context.durable }
                  : { ...waiting, kind: "live" },
              ]),
            );
            record.push(["parked", "click"]);
            return;
          }
        }
        clickTurn(parts, { ...event, context }, effects, record);
        return;
      }
      case "viewers":
        feeds.view(event.viewers, time.tick);
        return;
      case "due": {
        const busy = parkedClickSessions();
        for (const session of event.pendingClicks ?? []) busy.add(session);
        // [LAW:dataflow-not-control-flow] Every owner of a tick, in one
        // order: held work first (a walk's load, a settled write), so the
        // menus a close reads and the frames drawn after it see it landed;
        // then the closes, so the frames drawn show them. Each owner runs
        // whatever one before it threw, so one session's failure stalls no
        // other's close or frames.
        runEach([
          () => time.runDue(),
          () => closeIdleMenus(parts, effects, busy),
          () =>
            feeds.drawDue({ at: time.at, tick: time.tick }, frames, prepare),
        ]);
        return;
      }
    }
  };

  const sources = computed(() => parts.renderCache.subscriptions().sources, {
    equals: compareStructural,
  });
  const managedFolders = computed(() => parts.renderCache.managedFolders(), {
    equals: compareStructural,
  });
  const configSelections = computed(
    () => parts.renderCache.configSelections(),
    {
      equals: compareStructural,
    },
  );
  const laneDeclaration = computed(
    () => {
      // [LAW:one-source-of-truth] Read off the same open views: a session whose
      // view closes stops being named, so its switches go.
      const lanes: Record<SessionId, LaneSwitches> = {};
      const unprepared = new Map<string, RenderOrigin>();
      for (const session of Object.keys(sources.get()) as SessionId[]) {
        const editing = parts.edits.draft(session) !== null;
        let committed = null;
        if (editing) {
          const { requested } = parts.worldStates.requestOf(session);
          // [LAW:no-ambient-temporal-coupling] A draft's preview is alive
          // while its committed config is not held. Keep its last committed
          // lane switches until the host supplies that config again.
          const delivered = parts.renderCache.holdsConfig(requested);
          const state = parts.renderCache.committedState(requested);
          if (!delivered || state === null) {
            if (delivered) unprepared.set(originKey(requested), requested);
            const held = subscriptions.lanes[session];
            if (held !== undefined) lanes[session] = held;
            continue;
          }
          committed = { settings: parts.edits.committed, state };
        }
        const switches = viewLanes(parts, session, committed);
        if (switches !== null) lanes[session] = switches;
      }
      return { lanes, unprepared: [...unprepared.values()] };
    },
    { equals: compareStructural },
  );
  const configOrigins = computed(
    (): Subscriptions["configs"] => {
      // [LAW:one-source-of-truth] The origins whose config the renderer holds:
      // each live session's, from its context until its retire, each a cache
      // entry loads from until its eviction, the one whose click's consequence
      // waits on its landing, and each a parked event waits on, once each.
      const configs = new Map<string, RenderOrigin>();
      const landing = parts.verbs.landing();
      for (const origin of [
        ...parts.worldStates.sessions().flatMap((session) => {
          const context = parts.worldStates.contextOf(session);
          return context === null ? [] : [context.durable.origin];
        }),
        ...(landing === null ? [] : [landing]),
      ])
        configs.set(originKey(origin), origin);
      for (const origin of parts.renderCache.origins())
        configs.set(originKey(origin), origin);
      for (const click of parked.get()) {
        const origin = parkedContext(click).durable.origin;
        configs.set(originKey(origin), origin);
      }
      return [...configs]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([, origin]) => origin);
    },
    { equals: compareStructural },
  );

  // [LAW:carrying-cost] Keep this observed until the views close. A draw
  // that only moves its next wake does not rewalk views or origins.
  const declaration = new Kept("renderer subscriptions", () => {
    const { lanes, unprepared } = laneDeclaration.get();
    return {
      plan: {
        sources: sources.get(),
        managedFolders: managedFolders.get(),
        lanes,
        configs: configOrigins.get(),
        configSelections: configSelections.get(),
      },
      unprepared,
    };
  });
  let observed: ReturnType<typeof declaration.read> | undefined;
  // [LAW:no-ambient-temporal-coupling] An offered delivery still needs
  // pruning if collection throws and the next turn retains the same origins.
  let pruneOwed = false;
  const declare = (configOffered: boolean): void => {
    pruneOwed ||= configOffered;
    let next = declaration.read();
    if (next !== observed && next.unprepared.length > 0) {
      // [LAW:effects-at-boundaries] An edit can outlive eviction of its
      // committed entry. Reload that entry only when dependencies change,
      // outside the derivation: the load can itself retire other views.
      for (const origin of next.unprepared)
        parts.renderCache.getOrCreate(origin);
      next = declaration.read();
    }
    if (pruneOwed || subscriptions.configs !== next.plan.configs) {
      parts.renderCache.prune(new Set(next.plan.configs.map(originKey)));
      pruneOwed = false;
    }
    observed = next;
    subscriptions = next.plan;
  };

  // [LAW:one-source-of-truth] The exhaustive drain record supplies both
  // the store order and the name of each drain's diagnostic.
  const storeOrder = Object.keys(drains) as Array<keyof StoreDrains>;

  // [LAW:single-enforcer] Every turn ends here:
  // each successful store drain belongs to this answer even if another
  // finalizer throws. Standing declarations advance only after collection.
  const ending = <T>(event: Event, run: () => T) => {
    let outcome: Ended<T>;
    try {
      outcome = { kind: "answered", value: run() };
    } catch (thrown) {
      outcome = { kind: "threw", failure: rendererFailureOf(thrown) };
    }
    const stored: StoreWrite[] = [];
    // [LAW:no-silent-failure] The first classified failure owns the outcome.
    // Each remaining finalizer still runs and contributes its own failure.
    const collect = (stage: TurnFinalizer, read: () => void): void => {
      try {
        read();
      } catch (thrown) {
        const failure = rendererFailureOf(thrown);
        if (outcome.kind === "answered") outcome = { kind: "threw", failure };
        else {
          const after = { stage, failure };
          outcome = {
            ...outcome,
            secondary:
              outcome.secondary === undefined
                ? [after]
                : [...outcome.secondary, after],
          };
        }
      }
    };

    for (const store of storeOrder)
      collect(store, () => stored.push(...drains[store]()));
    collect("subscriptions", () => declare(event.kind === "config"));
    // [LAW:one-source-of-truth] The wake has its own collector. A failed
    // subscription declaration leaves the last one standing and the next
    // due turn still receives the current tick.
    collect("wake", () => {
      wake = earliestOf([
        time.next(),
        menuIdle.next(
          parked.get().length === 0 ? undefined : parkedClickSessions(),
        ),
        feeds.next(),
      ]);
    });
    // [LAW:no-ambient-temporal-coupling] The declaration's lifetime ends in
    // the close-views turn even if an earlier finalizer failed.
    if (event.kind === "close-views")
      collect("release-subscriptions", () =>
        runInAction(() => declaration.release()),
      );

    return { outcome, subscriptions, wake, stored };
  };

  return {
    answer: async (input) =>
      turnLog.during(() =>
        time.during(input, () => {
          const record: RequestFacts = [];
          const effects: Effect[] = [];
          const frames: PushedFrame[] = [];
          const { event } = input;
          const { outcome, ...declaration } = ending(event, () =>
            isCommand(event)
              ? command(event)
              : notify(event, record, effects, frames),
          );
          return {
            ...(outcome.kind === "answered"
              ? {
                  kind: "answered" as const,
                  ...(outcome.value === undefined
                    ? {}
                    : { reply: outcome.value }),
                }
              : outcome),
            effects,
            record,
            frames,
            ...declaration,
          };
        }),
      ),
  };
}

// The sessions whose idle period has run out by the turn's tick, their menus
// closed as the ✕ does, by the session's live context.
// [LAW:no-silent-failure] A close that throws is said with its session, and
// the others close all the same: the session's period begins again
// (`MenuIdle.due`), so its close is tried a timeout later, never at once.
function closeIdleMenus(
  parts: MainRendererParts,
  effects: Effect[],
  busy: ReadonlySet<SessionId>,
): void {
  for (const { session, idle } of parts.menuIdle.due(parts.time.tick, busy)) {
    try {
      parts.verbs.closeIdle(
        session,
        parts.worldStates.contextOf(session),
        idle,
        effects,
      );
    } catch (thrown) {
      const failure = rendererFailureOf(thrown);
      // A close the daemon's close cut off is a refusal, as a click's is.
      parts.turnLog.add(
        failure.kind === "closing" ? "info" : "error",
        `menu-idle: close failed (session=${session}): ${failure.detail}`,
      );
    }
  }
}

// [LAW:single-enforcer] The main renderer is built from its supplied state.
export function mainRendererOf(inputs: RendererBoot): RendererConstruction {
  const turnLog = new TurnLog();
  return turnLog.during<RendererConstruction>(() => {
    try {
      return { kind: "built", renderer: build(inputs, turnLog) };
    } catch (thrown) {
      return { kind: "refused", failure: rendererFailureOf(thrown) };
    }
  });
}

function build(inputs: RendererBoot, turnLog: TurnLog): Renderer {
  // Configs compiled by this renderer determine which action values it accepts.
  const gates = createGates();
  // [LAW:effects-at-boundaries] The renderer's one face of time: the readings
  // each input carries, and the work held for a later `due`.
  const time = new TurnTime();
  const now = () => time.at;
  const log = turnLog.add;
  const sessionState = new SessionState(inputs.stored.sessions);
  // A legacy edit-mode flag has no draft after a restart.
  for (const sid of Object.keys(inputs.stored.sessions))
    sessionState.clear(sessionIdOf(sid), EDIT_MODE_KEY);
  const edits = new EditTransactions(sessionState, log);
  const settingsHistory = new SettingsHistory(
    sessionState,
    log,
    inputs.stored.history,
  );
  let minted = 0;
  const mint = (): EffectId => ++minted as EffectId;
  const configWrites = new ConfigWrites(mint);
  // [LAW:single-enforcer] A failed act of a session's, on its bar the way its
  // click's own failure is.
  const actFailed = (session: SessionId, reason: string): void =>
    holdClickError(sessionState, session, reason, now());
  const acts = new ActsOnTheirWay(mint, actFailed);
  const navigationHistory = new NavigationHistory();
  const worldStates = new WorldStates();
  const renderCache = new RenderCache<SessionSource, CheckedRenderRequest>(
    {
      clock: time.clock,
      locations: inputs.locations,
      region: inputs.region,
      sessionState: edits.view,
      editRevision: (origin, sid) => edits.revision(origin, sid),
      currentRequest: (session) => worldStates.requestOf(session),
      log,
      gates,
      // [LAW:single-enforcer] What every session's view draws from: its payload
      // composed over its world state, its request, its picks and its
      // histories' depths.
      source: sessionSource({
        sessionState: edits.view,
        worldStates,
        home: inputs.locations.home,
        history: (sessionId) => edits.depth(sessionId, settingsHistory),
        // Measured against the gate of the config the view draws with.
        navigation: (sessionId, config) =>
          navigationHistory.depth(sessionId, sessionState, {
            gate: gates.state.gateFor(config),
            nest: () => disclosureNest(config),
            edit: edits.draft(sessionId)?.navigationScope ?? null,
          }),
      }),
    },
    {
      budgetBytes: () => renderCacheBudget(inputs.memoryLimitBytes),
      observers: {
        // [LAW:no-silent-failure] Every config (re)load's outcome lands in
        // daemon.log with its cause — the operator's only record of why a load
        // ran, and whether a save was picked up cleanly, kept rendering
        // last-known-good behind an error, or resolved to a different file.
        onReload: (entry, sessions, cause, settled) => {
          log("info", configLoadedLine(entry, cause, settled));
          // A reload changes the bar of every session drawn from the entry,
          // even one that failed and kept the old config: its indicator says so.
          for (const sessionId of sessions)
            feeds.wake(sessionId, "reload", time.tick);
        },
        // [LAW:single-enforcer] What a session's view draws from moved: its
        // feed's next frame is brought forward, whatever moved it: a request's
        // facts, a refresh landing after its deadline, a source publishing, a
        // pick. The dump link, which no view holds, wakes the same way.
        onViewChanged: (sessionId) => feeds.wake(sessionId, "data", time.tick),
      },
    },
  );
  const { menuIdle } = renderCache.presentations;
  // [LAW:no-ambient-temporal-coupling] Each open feed's pin, from its open
  // to its close: the view's hold and the reaction that wakes the feed when
  // the session's state moves, so the reaction lives exactly as long as the
  // feed that hears it.
  const pin = (sessionId: SessionId): (() => void) => {
    const unhold = renderCache.pin(sessionId);
    const unwatch = reaction(
      () => edits.view.revision(sessionId),
      () => feeds.wake(sessionId, "state", time.tick),
    );
    return () => {
      unwatch();
      // [LAW:single-enforcer] A feed's pin is its life: releasing it is the
      // one moment the feed stops drawing, so its drawn copies retire with it.
      renderCache.stopDrawing(sessionId, "feed");
      unhold();
    };
  };
  const feeds: Feeds = new Feeds({
    draw: (sessionId, fps, readings, following, laneFeeds, prepare) =>
      renderFrame(
        parts,
        sessionId,
        fps,
        readings,
        following,
        laneFeeds,
        prepare,
      ),
    pin,
    log,
    periods: FEED_PERIODS,
  });
  const parts: RendererParts = {
    time,
    sessionState: edits.view,
    renderCache,
    worldStates,
    feeds,
  };
  const verbCtx: DaemonVerbContext = {
    gates,
    sessionState,
    snapshotFor: (origin) => renderCache.snapshotFor(origin),
    locations: inputs.locations,
    configWrites,
    clickLanded: (sessionId) => menuIdle.clicked(sessionId, time.tick),
    log,
    acts,
    now,
    history: settingsHistory,
    edits,
    editViewChanged: (sid) => renderCache.refreshEditedView(sid),
    navigation: navigationHistory,
    // The config a session's last render resolved from — the same entry the
    // render drew the bar with, so a save compares against the bar the user saw.
    configFor: (origin, sid) =>
      renderCache.getOrCreate(origin, sid).state.config,
    // The storage folders of the same entry `configFor` reads the config of.
    sourcesFor: (origin) => renderCache.getOrCreate(origin).state.sources,
    diagnosticCopy: (sessionId, by, key) =>
      renderCache.drawnCopy(sessionId, by, key),
  };
  return mainRenderer(
    {
      ...parts,
      turnLog,
      menuIdle,
      feeds,
      verbs: verbsOver(verbCtx),
      edits,
      mint,
      acts,
      configWrites,
      sessionStats: () => sessionState.stats(),
    },
    {
      "session-state": () => sessionState.drain(),
      "settings-history": () => settingsHistory.drain(),
    },
  );
}

// [LAW:dataflow-not-control-flow] The debug projection samples whatever DSL
// state the cache currently holds. With cache keys scoped on (projectDir, cwd)
// and the debug request carrying neither, it samples the most recently
// rendered session's view — sufficient for `debug vars`, `debug segments`,
// `debug config` against the active workload. latestView reads existing views
// only; it does NOT open one, so debug introspection never stands up a new
// cache entry tied to the daemon's own process.cwd().
// [LAW:carrying-cost] Lazy per-segment serialization: the cache
// stores StripCell arrays (cheap, written by drawDsl), and only the `segments`
// projection needs strings, so a normal render pays no serializer cost.
function debugOf(
  cache: RenderCache<SessionSource, CheckedRenderRequest>,
  what: DebugWhat,
): DebugSnapshot {
  const view = cache.latestView();
  const frame =
    what === "segments" && view !== null
      ? cache.presentations.latestLayout(
          view.sessionId,
          view.presentationTargets,
        )
      : undefined;
  return buildDebugSnapshot(
    what,
    view === null
      ? null
      : {
          store: view.store,
          registry: view.registry,
          config: view.state.config,
          compiled: view.state.compiled,
          lastRenderBySegment:
            frame !== undefined
              ? serializeSegmentCells(
                  frame.segments,
                  view.state.config.globals.colorCompatibility ??
                    floorOf("colorCompatibility"),
                )
              : EMPTY_RENDER_MAP,
        },
  );
}

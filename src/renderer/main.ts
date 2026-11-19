// The main renderer, in process: today's request answer behind the renderer
// interface (src/renderer-interface/interface.ts). A `context` turn records
// the session's context and opens its view there, so its output names what
// the view reads before the request after it waits. A `config` turn hands in
// what discovery found at an origin the renderer names, and runs every event
// that waited for it. A request's turn holds the session's view at its own
// context, draws the bar and returns it as a `present`; that present's
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
  configureSession,
  deliver,
  openSession,
  takeContext,
  renderFrame,
  retireSession,
  viewLanes,
  type Delivery,
  type RendererParts,
} from "./draw-bar.js";
import { TurnTime } from "./turn-time.js";
import { runEach } from "../utils/run-each.js";
import { MenuIdle } from "./menu-idle.js";
import { FEED_PERIODS, Feeds } from "./feeds.js";
import type { LaneSwitches } from "../config/lanes.js";
import type { RequestFacts } from "../daemon/foundations/request-event.js";
import { clickTurn } from "./click.js";
import {
  verbsOver,
  type DaemonVerbContext,
  type MainRendererParts,
} from "./verbs/port.js";
import type {
  StoredState,
  StoreWrite,
} from "../renderer-interface/stored-state.js";
import type { LinkSigner } from "../click/link-signer.js";
import type { Locations } from "../config/loader/chain-places.js";
import type { Gates } from "../daemon/foundations/gates.js";
import { originKey, type RenderOrigin } from "../config-hint.js";
import type { CheckedRenderRequest } from "../renderer-interface/request-context.js";
import type {
  AdapterPush,
  AdapterReply,
  AdapterToHost,
} from "../renderer-interface/adapter.js";
import type {
  DebugSnapshot,
  DebugWhat,
} from "../daemon/foundations/debug-types.js";
import { holdClickError } from "../daemon/foundations/click-error.js";
import { floorOf } from "../config/globals-fields.js";
import { EffectSessions } from "../render/effect.js";
import type { RenderedLine } from "../dsl/node-registry.js";
import { SessionState } from "./session-state.js";
import { SettingsHistory } from "./settings-history.js";
import { NavigationHistory } from "./navigation-history.js";
import { RenderWarningRecords } from "./render-warnings.js";
import { ActsOnTheirWay } from "./acts.js";
import { WorldStates } from "./world-states.js";
import { sessionSource, type SessionSource } from "./session-source.js";
import {
  configLoadedLine,
  RenderCache,
  renderCacheBudget,
  type SessionView,
} from "./render-cache.js";
import {
  buildDebugSnapshot,
  EMPTY_RENDER_MAP,
  serializeSegmentCells,
} from "./debug.js";
import { earliestOf } from "../utils/instant.js";
import { failureOf, type Failure } from "../daemon/foundations/verb-error.js";
import {
  rendererOf,
  type Effect,
  type EffectId,
  type Event,
  type PushedFrame,
  type Renderer,
  type Subscriptions,
} from "../renderer-interface/interface.js";
import { ConfigWrites } from "./config-writes.js";
import { reaction } from "mobx";
import type { SessionId } from "../daemon/foundations/session-id.js";

// How a turn ended, apart from what it returned.
type Ended<T> =
  | { readonly kind: "answered"; readonly value: T }
  | { readonly kind: "threw"; readonly failure: Failure };

export function mainRenderer(
  parts: MainRendererParts,
  // [LAW:effects-at-boundaries] exception: the host's pushes, each answered
  // in its own turn, synchronously.
  pushed: (push: AdapterPush) => AdapterReply,
  // What the stores moved since the last turn ended.
  drained: () => readonly StoreWrite[],
): Renderer {
  const { time, feeds, menuIdle } = parts;
  // [LAW:single-enforcer] What each present's frame records once it reached
  // its client, held from the turn that returned it until its one
  // `effect-done`: the host settles every present it is handed, so this
  // holds only presents still on their way.
  const deliveries = new Map<EffectId, Delivery>();
  // The subscriptions this renderer last returned: none before its first turn.
  let subscriptions: Subscriptions = {
    sources: {},
    lanes: {},
    configs: [],
    wake: null,
  };
  // [LAW:no-ambient-temporal-coupling] Each event that needs its origin's
  // config and arrived before the renderer held it, in arrival order, under
  // that origin: the `config` turn that brings it runs what is left of it, as
  // part of itself. Plain data, the events themselves.
  let parked: ReadonlyArray<{
    readonly origin: RenderOrigin;
    readonly event: Extract<Event, { kind: "context" | "click" }>;
  }> = [];
  // [LAW:single-enforcer] Whether `event` waits for `origin`'s config: it
  // does while the renderer holds none, and its output then names the origin
  // (`subscribed`). An event with no origin to wait on runs.
  const waits = (
    origin: RenderOrigin | null,
    event: (typeof parked)[number]["event"],
    record: RequestFacts,
  ): boolean => {
    if (origin === null || parts.renderCache.holdsConfig(origin)) return false;
    parked = [...parked, { origin, event }];
    record.push(["parked", event.kind]);
    return true;
  };

  // [LAW:single-enforcer] A turn's effects go to the sink its input holds,
  // so a turn that throws still hands on what it did before the throw: a
  // click's changes are owed their `effect-done` however its handler ended.
  // [LAW:no-ambient-temporal-coupling] A turn runs whole: it awaits nothing,
  // so the host's mailbox, which sends the next input only once this one has
  // answered, is the one order of the renderer's turns.
  const turn = (
    event: Event,
    record: RequestFacts,
    effects: Effect[],
    frames: PushedFrame[],
  ): void => {
    switch (event.kind) {
      case "start":
        // The feeds first: a watched session's feed pins its view before
        // the view opens. Each session opens as its `context` would, so one
        // at an origin the renderer holds no config for waits for it, and
        // each whatever another's opening, or a feed, threw.
        runEach([
          () => feeds.view(event.viewers, time.tick),
          ...event.sessions.map(
            ({ context, worldState }) =>
              () =>
                turn(
                  { kind: "context", context, worldState },
                  record,
                  effects,
                  frames,
                ),
          ),
        ]);
        return;
      case "context":
        // [LAW:no-ambient-temporal-coupling] What needs no config lands now,
        // so the session's world states are taken in the order they came;
        // only the view's opening waits.
        if (parts.renderCache.holdsConfig(event.context.requested))
          configureSession(parts, event.context, event.worldState, record);
        else {
          takeContext(parts, event.context, event.worldState, record);
          waits(event.context.requested, event, record);
        }
        return;
      case "config": {
        // [LAW:no-ambient-temporal-coupling] Every event that waited for this
        // origin runs now, in arrival order, its effects and frames this
        // turn's, so they land in the slot it arrived in. Each runs whatever
        // the reload or another threw: no later turn brings them back, so
        // none is left waiting.
        const key = originKey(event.origin);
        const ready = parked.filter((p) => originKey(p.origin) === key);
        parked = parked.filter((p) => originKey(p.origin) !== key);
        runEach([
          () => parts.renderCache.configure(event.origin, event.config),
          ...ready.map(({ event: waited }) => () => {
            if (waited.kind === "context") openSession(parts, waited.context);
            else turn(waited, record, effects, frames);
          }),
        ]);
        return;
      }
      case "request": {
        const { frame, delivery, inspection } = answerRequest(
          parts,
          event.context,
          record,
          event.inspect,
        );
        const id = parts.mint();
        deliveries.set(id, delivery);
        effects.push({
          kind: "present",
          id,
          session: event.context.hookData.session_id,
          surface: "statusline",
          request: event.id,
          frame,
          ...(inspection === undefined ? {} : { inspection }),
        });
        return;
      }
      case "world-state":
        parts.worldStates.take(event.worldState);
        return;
      case "retire":
        // A context the session parked opens nothing once it is retired.
        parked = parked.filter(
          (p) =>
            p.event.kind !== "context" ||
            p.event.context.hookData.session_id !== event.session,
        );
        menuIdle.retire(event.session);
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
        if (event.outcome.kind === "ok") deliver(parts, delivery);
        return;
      }
      case "click": {
        // A click on a session no live context names (one idle past its
        // retire, or not heard since the daemon started) waits for the config
        // of the origin the host's book holds for it.
        if (waits(event.context?.durable.origin ?? null, event, record)) return;
        clickTurn(parts, event, effects, record);
        return;
      }
      case "viewers":
        feeds.view(event.viewers, time.tick);
        return;
      case "due":
        // [LAW:dataflow-not-control-flow] Every owner of a tick, in one
        // order: held work first (a walk's load, a settled write), so the
        // menus a close reads and the frames drawn after it see it landed;
        // then the closes, so the frames drawn show them. Each owner runs
        // whatever one before it threw, so one session's failure stalls no
        // other's close or frames.
        runEach([
          () => time.runDue(),
          () => closeIdleMenus(parts, effects),
          () => feeds.drawDue({ at: time.at, tick: time.tick }, frames),
        ]);
        return;
    }
  };

  const subscribed = (): Subscriptions => {
    const views = parts.renderCache.subscriptions().sources;
    // [LAW:one-source-of-truth] Read off the same open views: a session whose
    // view closes stops being named, so its switches go.
    const lanes: Record<SessionId, LaneSwitches> = {};
    for (const session of Object.keys(views) as SessionId[]) {
      const switches = viewLanes(parts, session);
      if (switches !== null) lanes[session] = switches;
    }
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
    for (const { origin } of parked) configs.set(originKey(origin), origin);
    return {
      sources: views,
      lanes,
      configs: [...configs.values()],
      // [LAW:one-source-of-truth] The tick the renderer next wants a turn
      // at: the earliest any owner of a tick holds.
      wake: earliestOf([time.next(), menuIdle.next(), feeds.next()]),
    };
  };

  // What the turn that ended last moved of the stores.
  let stored: readonly StoreWrite[] = [];
  // [LAW:single-enforcer] Every turn, an event's or a push's, ends here:
  // what the renderer needs read, when it next wants a turn, and what it
  // moved of its stores are read as they stand when it ends, however it
  // ended: a write before a throw is real. Read as part of the turn, so a
  // read that throws fails it, and the subscriptions last returned stand.
  const ending = <T>(run: () => T): Ended<T> => {
    try {
      let value: T;
      try {
        value = run();
      } finally {
        stored = drained();
        subscriptions = subscribed();
        // [LAW:one-source-of-truth] The snapshots held are exactly the
        // origins the output names, as the host follows exactly those.
        parts.renderCache.prune(
          new Set(subscriptions.configs.map((o) => originKey(o))),
        );
      }
      return { kind: "answered", value };
    } catch (thrown) {
      // [LAW:single-enforcer] Classified here, where it was thrown: a class
      // crosses no process.
      return { kind: "threw", failure: failureOf(thrown) };
    }
  };

  return rendererOf({
    // [LAW:no-ambient-temporal-coupling] A push awaits nothing, so the input
    // after it lands after its writes.
    adapter: async (input) =>
      time.during(input, () => {
        const ended = ending(() => pushed(input.push));
        return {
          ...(ended.kind === "answered"
            ? { kind: "replied" as const, reply: ended.value }
            : ended),
          subscriptions,
          stored,
        };
      }),
    event: async (input) =>
      time.during(input, () => {
        const record: RequestFacts = [];
        const effects: Effect[] = [];
        const frames: PushedFrame[] = [];
        const ended = ending(() => turn(input.event, record, effects, frames));
        return {
          ...(ended.kind === "answered"
            ? { kind: "answered" as const }
            : ended),
          effects,
          record,
          subscriptions,
          frames,
          stored,
        };
      }),
  });
}

// The sessions whose idle period has run out by the turn's tick, their menus
// closed as the ✕ does, by the session's live context.
// [LAW:no-silent-failure] A close that throws is said with its session, and
// the others close all the same: the session's period begins again
// (`MenuIdle.due`), so its close is tried a timeout later, never at once.
function closeIdleMenus(parts: MainRendererParts, effects: Effect[]): void {
  for (const { session, idle } of parts.menuIdle.due(parts.time.tick)) {
    try {
      parts.verbs.closeIdle(
        session,
        parts.worldStates.contextOf(session),
        idle,
        effects,
      );
    } catch (thrown) {
      const failure = failureOf(thrown);
      // A close the daemon's close cut off is a refusal, as a click's is.
      parts.log(
        failure.kind === "closing" ? "info" : "error",
        `menu-idle: close failed (session=${session}): ${failure.detail}`,
      );
    }
  }
}

// What the main renderer is built from besides the host's parts: its
// profile's stored state as the host holds it, the signer its links are drawn
// with, and the facts of the machine its loads resolve under. No clock: every
// input carries the host's readings.
export interface MainRendererInputs {
  // [LAW:one-source-of-truth] A renderer is built from its stored state, so
  // none exists without it: every write it makes leaves as a turn's stored
  // writes, and the next renderer is built from what the host then holds.
  readonly stored: StoredState;
  // [LAW:single-enforcer] The signer over the state directory's key.
  readonly linkSigner: LinkSigner;
  // Where the user's config and installed plugins live.
  readonly locations: Locations;
  readonly home: string;
  // What this daemon's clicks may write: the gates its root built.
  readonly gates: Gates;
  // The memory limit the render cache's budget is a share of.
  readonly memoryLimitBytes: number;
}

// [LAW:single-enforcer] The main renderer, built over the host's parts it
// reaches and the stored state it is handed.
export function mainRendererOf(
  inputs: MainRendererInputs,
  host: AdapterToHost,
): Renderer {
  const { gates, linkSigner } = inputs;
  // [LAW:effects-at-boundaries] The renderer's one face of time: the readings
  // each input carries, and the work held for a later `due`.
  const time = new TurnTime();
  const now = () => time.at;
  const menuIdle = new MenuIdle();
  // [LAW:single-enforcer] The renderer's lines go to the host's one log.
  const { log } = host;
  const sessionState = new SessionState(inputs.stored.sessions);
  const settingsHistory = new SettingsHistory(
    sessionState,
    log,
    inputs.stored.history,
  );
  // [LAW:one-source-of-truth] What the turn moved of every store, in the
  // order each store's entries last moved.
  const drained = (): StoreWrite[] => [
    ...sessionState.drain(),
    ...settingsHistory.drain(),
  ];
  let minted = 0;
  const mint = (): EffectId => ++minted as EffectId;
  const configWrites = new ConfigWrites(mint);
  // [LAW:single-enforcer] A failed act of a session's, on its bar the way its
  // click's own failure is.
  const actFailed = (session: SessionId, reason: string): void =>
    holdClickError(sessionState, session, reason, now());
  const acts = new ActsOnTheirWay(mint, actFailed);
  const navigationHistory = new NavigationHistory();
  // Each session's effect memory — when its effect came into force — held in
  // daemon memory only: a restarted daemon starts every session's effect again.
  const effectSessions = new EffectSessions<RenderedLine>();
  // [LAW:single-enforcer] What each session's renderers could not honour, as
  // their frames recorded it (src/renderer/render-warnings.ts).
  const renderWarnings = new RenderWarningRecords();
  const worldStates = new WorldStates();
  const renderCache = new RenderCache<SessionSource, CheckedRenderRequest>(
    {
      clock: time.clock,
      locations: inputs.locations,
      sessionState,
      log,
      storage: host.storage,
      signer: linkSigner,
      gates,
      // [LAW:single-enforcer] What every session's view draws from: its payload
      // composed over its world state, its request, its picks and its
      // histories' depths.
      source: sessionSource({
        sessionState,
        worldStates,
        home: inputs.home,
        history: (sessionId) => settingsHistory.depth(sessionId),
        // Measured against the gate of the config the view draws with.
        navigation: (sessionId, config) =>
          navigationHistory.depth(
            sessionId,
            sessionState,
            gates.state.gateFor(config),
          ),
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
  // [LAW:no-ambient-temporal-coupling] Each open feed's pin, from its open
  // to its close: the view's hold and the reaction that wakes the feed when
  // the session's state moves, so the reaction lives exactly as long as the
  // feed that hears it.
  const pin = (sessionId: SessionId): (() => void) => {
    const unhold = renderCache.pin(sessionId);
    const unwatch = reaction(
      () => sessionState.revision(sessionId),
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
    draw: (sessionId, fps, readings, following, laneFeeds) =>
      renderFrame(parts, sessionId, fps, readings, following, laneFeeds),
    pin,
    log,
    periods: FEED_PERIODS,
  });
  const parts: RendererParts = {
    ...host,
    time,
    linkSigner,
    sessionState,
    renderCache,
    worldStates,
    renderWarnings,
    effectSessions,
    menuIdle,
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
    navigation: navigationHistory,
    // The config a session's last render resolved from — the same entry the
    // render drew the bar with, so a save compares against the bar the user saw.
    configFor: (origin) => renderCache.getOrCreate(origin).state.config,
    // The storage folders of the same entry `configFor` reads the config of.
    sourcesFor: (origin) => renderCache.getOrCreate(origin).state.sources,
    links: linkSigner,
    diagnosticCopy: (sessionId, by, key) =>
      renderCache.drawnCopy(sessionId, by, key),
  };
  // [LAW:types-are-the-program] Exhaustive over the pushes: a new arm is a
  // compile error here until the renderer answers it.
  const pushed = (push: AdapterPush): AdapterReply => {
    switch (push.kind) {
      case "stats":
        return {
          kind: "stats",
          stats: {
            renderCache: renderCache.stats,
            effectCache: effectSessions.getStats(),
            sessionState: {
              sessions: sessionState.size(),
              observers: sessionState.observers(),
              revision: sessionState.latestRevision(),
            },
            menuIdle: menuIdle.stats(),
            framesDrawn: feeds.drawn(),
          },
        };
      case "debug":
        return {
          kind: "debug",
          snapshot: debugOf(renderCache.latestView(), push.what),
        };
      // [LAW:no-ambient-temporal-coupling] No journal opens after this: a turn
      // runs whole, so none is in flight.
      case "close-journal":
        configWrites.close();
        return { kind: "close-journal" };
      case "close-views":
        // The feeds first: each releases its pin on a view the close ends.
        feeds.closeAll(time.tick);
        renderCache.close();
        return { kind: "close-views" };
    }
  };
  return mainRenderer(
    {
      ...parts,
      menuIdle,
      feeds,
      verbs: verbsOver(verbCtx),
      mint,
      acts,
    },
    pushed,
    drained,
  );
}

// [LAW:dataflow-not-control-flow] The debug projection samples whatever DSL
// state the cache currently holds. With cache keys scoped on (projectDir, cwd)
// and the debug request carrying neither, it samples the most recently
// rendered session's view — sufficient for `debug vars`, `debug segments`,
// `debug config` against the active workload. latestView reads existing views
// only; it does NOT open one, so debug introspection never stands up a new
// cache entry tied to the daemon's own process.cwd().
// [LAW:dataflow-not-control-flow] Lazy per-segment serialization: the cache
// stores StripCell arrays (cheap, written by drawDsl), and only the `segments`
// projection needs strings, so a normal render pays no serializer cost.
function debugOf(
  view: SessionView<SessionSource, CheckedRenderRequest> | null,
  what: DebugWhat,
): DebugSnapshot {
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
            what === "segments"
              ? serializeSegmentCells(
                  view.lastRenderCellsBySegment,
                  view.state.config.globals.colorCompatibility ??
                    floorOf("colorCompatibility"),
                )
              : EMPTY_RENDER_MAP,
        },
  );
}

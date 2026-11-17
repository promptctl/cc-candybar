// The main renderer, in process: today's request answer behind the renderer
// interface (src/renderer-interface/interface.ts). A `config` turn records the
// session's context and opens its view there, so its output names what the
// view reads before the request after it waits. A request's turn holds that
// view at its own context, draws the bar and returns it as a `present`; that
// present's `effect-done` records what the frame showed, once the host says
// whether its client took it. A world state the host hands in, with a
// `config` or alone, is what the session's views draw from, and a retire ends
// what the renderer holds of the session. A click acts in its turn. Who
// follows each session's frames is handed in whole (`viewers`), and a `due`
// does whatever its instant reaches: a step of a reload walk, a held write
// shown, a menu's idle close, the frames that fell due. Every output says
// what the open views need read, the lanes they switch on and when the
// renderer next needs a turn, as they stand once the turn's act has landed.

import {
  answerRequest,
  configureSession,
  lanesAt,
  renderFrame,
  retireSession,
  viewLanes,
  type RendererParts,
} from "./draw-bar.js";
import type { RequestFacts } from "../daemon/foundations/request-event.js";
import { clickTurn } from "./click.js";
import {
  verbsOver,
  type DaemonVerbContext,
  type MainRendererParts,
} from "./verbs/port.js";
import type { SessionStorage } from "../renderer-interface/session-state.js";
import type {
  HistoryStorage,
  LoadedHistory,
} from "../renderer-interface/history-storage.js";
import type { DoctorStores } from "../doctor/ports.js";
import type { LinkSigner } from "../click/link-signer.js";
import type { Locations } from "../config/loader/discovery.js";
import type { Gates } from "../daemon/foundations/gates.js";
import type { RenderOrigin } from "../config-hint.js";
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
import { LaneActs } from "./lane-acts.js";
import { WorldStates } from "./world-states.js";
import { DoctorRuns } from "./doctor.js";
import { UpdateGate } from "./update-gate.js";
import { Watches } from "./watches.js";
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
import type { Instant } from "../utils/instant.js";
import { failureOf, type Failure } from "../daemon/foundations/verb-error.js";
import {
  rendererOf,
  type Effect,
  type EffectId,
  type Event,
  type PushedFrame,
  type Renderer,
  type Subscription,
  type Subscriptions,
} from "../renderer-interface/interface.js";
import type { LaneSwitches } from "../config/lanes.js";
import { Feeds } from "./feeds.js";
import { MenuIdle } from "./menu-idle.js";
import { TurnTime } from "./turn-time.js";
import { ConfigWrites } from "./config-writes.js";
import { readConfigText } from "./config-file-store.js";
import { reaction } from "mobx";
import type { SessionId } from "../daemon/foundations/session-id.js";

// How a turn ended, apart from what it returned.
type TurnEnd =
  | { readonly kind: "answered" }
  | { readonly kind: "threw"; readonly failure: Failure };

// The renderer's own clocks: the turn's instant, each feed's frames and each
// session's menu idle period.
export interface RendererClocks {
  readonly time: TurnTime;
  readonly feeds: Feeds;
  readonly menuIdle: MenuIdle;
}

export function mainRenderer(
  parts: MainRendererParts,
  clocks: RendererClocks,
  // [LAW:effects-at-boundaries] exception: the host's pushes, each answered
  // in its own turn, synchronously.
  pushed: (push: AdapterPush, at: Instant) => AdapterReply,
): Renderer {
  const { time, feeds, menuIdle } = clocks;
  // [LAW:single-enforcer] What each present's frame records once it reached
  // its client, held from the turn that returned it until its one
  // `effect-done`: the host settles every present it is handed, so this
  // holds only presents still on their way.
  const deliveries = new Map<EffectId, () => void>();
  // The newest request context each session's config handed in, from its
  // config turn to its retire, the span its idle record keeps: what its idle
  // close resolves its config by, whether or not its view is still open.
  const contexts = new Map<SessionId, CheckedRenderRequest>();
  // The subscriptions this renderer last returned: none before its first turn.
  let subscriptions: Subscriptions = {
    sources: {},
    tmuxStatus: [],
    lanes: {},
    wake: null,
  };

  // [LAW:single-enforcer] A turn's effects go to the sink its input holds,
  // so a turn that throws still hands on what it did before the throw: a
  // click's changes are owed their `effect-done` however its handler ended.
  // [LAW:no-ambient-temporal-coupling] A turn runs whole: it awaits nothing,
  // so the host's mailbox, which sends the next input only once this one has
  // answered, is the one order of the renderer's turns.
  const turn = (
    event: Event,
    at: Instant,
    record: RequestFacts,
    effects: Effect[],
    frames: PushedFrame[],
  ): void => {
    switch (event.kind) {
      case "start":
        // [LAW:one-source-of-truth] Who follows first: the host counts them
        // told once this turn is sent, so a session whose config throws
        // below leaves no feed unopened until a pane next moves.
        feeds.viewersAre(event.viewers, at);
        for (const { context, worldState } of event.sessions) {
          contexts.set(context.hookData.session_id, context);
          configureSession(parts, context, worldState, at, record);
        }
        return;
      case "config":
        contexts.set(event.context.hookData.session_id, event.context);
        configureSession(parts, event.context, event.worldState, at, record);
        return;
      case "request": {
        const session = event.context.hookData.session_id;
        const { frame, delivered, menus } = answerRequest(
          parts,
          event.context,
          at,
          {
            following: feeds.following(session),
            feeds: feeds.feedsOf(session, at),
            idleSince: menuIdle.idleSince(session),
          },
          record,
          effects,
        );
        menuIdle.drew(session, at, menus);
        const id = parts.mint();
        deliveries.set(id, delivered);
        effects.push({
          kind: "present",
          id,
          session,
          surface: "statusline",
          request: event.id,
          frame,
        });
        return;
      }
      case "world-state":
        parts.worldStates.take(event.worldState);
        return;
      case "retire":
        // The run first: a teardown that throws leaves no run asking for a
        // session the host has discarded.
        parts.doctorRuns.retire(event.session);
        menuIdle.retire(event.session);
        contexts.delete(event.session);
        retireSession(parts, event.session);
        return;
      case "effect-done": {
        if (parts.verbs.changeDone(event.of, event.outcome, effects)) return;
        if (parts.acts.done(event.of, event.session, event.outcome)) return;
        const delivered = deliveries.get(event.of);
        // [LAW:no-silent-failure] An effect this renderer never returned, or
        // one already settled, is the host's bug: said, never ignored.
        if (delivered === undefined)
          throw new Error(
            `effect-done for effect ${event.of}, which is no present, change or act on its way`,
          );
        deliveries.delete(event.of);
        if (event.outcome.kind === "ok") delivered();
        return;
      }
      case "click":
        clickTurn(parts, event, effects);
        return;
      case "viewers":
        feeds.viewersAre(event.viewers, at);
        return;
      case "due":
        due(at, effects, frames);
        return;
    }
  };

  // [LAW:no-ambient-temporal-coupling] What the turn at `at` reaches, in
  // order: what changes what a frame draws (a reload walk's step, a held
  // write shown, a menu's idle close) before the frames drawn from it.
  const due = (at: Instant, effects: Effect[], frames: PushedFrame[]): void => {
    if (parts.renderCache.walking) parts.renderCache.walkOne();
    time.due(at);
    for (const idle of menuIdle.due(at)) {
      // [LAW:no-silent-failure] A close that threw is said against its
      // session, and stops neither another session's close nor the frames.
      try {
        parts.verbs.closeIdle(
          contexts.get(idle.session) ?? null,
          idle,
          effects,
        );
      } catch (thrown) {
        parts.log(
          "error",
          `menu-idle: close failed (session=${idle.session}): ${failureOf(thrown).detail}`,
        );
      }
    }
    feeds.due(at, frames);
  };

  // The open views' subscriptions as they stand at `at`. A session's doctor
  // run is read whether or not a view of it is open: a view evicted or failed
  // to open is no reason a run asked for goes unread.
  const subscribed = (at: Instant): Subscriptions => {
    const views = parts.renderCache.subscriptions().sources;
    const merged = new Map(
      Object.entries(views) as Array<[SessionId, Subscription[]]>,
    );
    for (const [session, run] of parts.doctorRuns.subscriptions())
      merged.set(session, [...(merged.get(session) ?? []), run]);
    const sources = Object.fromEntries(merged) as Subscriptions["sources"];
    // [LAW:one-source-of-truth] Read off the same open views: a session whose
    // view closes stops being named, so its row goes and its lanes are its
    // first frame's to decide.
    const lanes: Record<SessionId, LaneSwitches> = {};
    for (const session of Object.keys(views) as SessionId[]) {
      const switched = viewLanes(parts, session);
      if (switched !== null) lanes[session] = switched;
    }
    return {
      sources,
      tmuxStatus: (Object.keys(sources) as SessionId[]).filter(
        (session) => lanes[session]?.tmuxStatus === true,
      ),
      lanes,
      wake: wakeAt(at),
    };
  };

  // [LAW:dataflow-not-control-flow] The earliest instant any owner of the
  // renderer's time next needs a turn, as of the turn at `at`: a step of a
  // reload walk at once, a held write, a menu's idle close, a feed's frame.
  const wakeAt = (at: Instant): Instant | null =>
    [
      parts.renderCache.walking ? at : null,
      time.next(),
      menuIdle.next(),
      feeds.next(at),
    ].reduce<Instant | null>(
      (soonest, each) =>
        each === null || (soonest !== null && soonest <= each) ? soonest : each,
      null,
    );

  return rendererOf({
    // [LAW:no-ambient-temporal-coupling] A push awaits nothing, so the input
    // after it lands after its writes.
    adapter: async (input) => {
      time.turn(input.at);
      try {
        const reply = pushed(input.push, input.at);
        subscriptions = subscribed(input.at);
        return { kind: "replied", reply, subscriptions };
      } catch (thrown) {
        return { kind: "threw", failure: failureOf(thrown) };
      }
    },
    event: async (input) => {
      time.turn(input.at);
      const record: RequestFacts = [];
      const effects: Effect[] = [];
      const frames: PushedFrame[] = [];
      // [LAW:one-source-of-truth] What the renderer needs read: the open
      // views' subscriptions as they stand when the turn ends, however it
      // ended. Read as part of the turn, so a read that throws fails the
      // turn and still hands on its effects, which are owed their
      // `effect-done`; the subscriptions last returned then stand.
      let ended: TurnEnd;
      try {
        try {
          turn(input.event, input.at, record, effects, frames);
        } finally {
          subscriptions = subscribed(input.at);
        }
        ended = { kind: "answered" };
      } catch (thrown) {
        // [LAW:single-enforcer] Classified here, where it was thrown: a
        // class crosses no process.
        ended = { kind: "threw", failure: failureOf(thrown) };
      }
      return {
        ...ended,
        effects,
        record,
        subscriptions,
        frames,
      };
    },
  });
}

// What the main renderer is built from besides the host's parts: the storage
// its session state, history and doctor load from, the signer its links are
// drawn with, and the facts of the machine its loads resolve under. It reads
// no clock: every instant is its turn's, which the host hands in.
export interface MainRendererInputs {
  readonly storage: {
    readonly session: SessionStorage;
    readonly history: HistoryStorage;
    // The doctor's stores: files under the state directory, which its clicks
    // file into.
    readonly doctor: DoctorStores;
  };
  // [LAW:single-enforcer] The signer over the state directory's key.
  readonly linkSigner: LinkSigner;
  // The state directory whose answers book a load reads and a click records in.
  readonly stateDir: string;
  // Where the user's config and installed plugins live.
  readonly locations: Locations;
  // The environment an `env` source reads: the daemon's host.
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly home: string;
  // What this daemon's clicks may write: the gates its root built.
  readonly gates: Gates;
  // The memory limit the render cache's budget is a share of.
  readonly memoryLimitBytes: number;
}

// The loaded main renderer, and its start, handed the host's parts it
// reaches: the start builds the rest of the renderer's own state over them and
// returns the renderer with what the host reaches in it.
export interface LoadedMainRenderer {
  start(host: AdapterToHost): Renderer;
}

// [LAW:single-enforcer] The main renderer, in two steps of the daemon's
// construction. [LAW:no-ambient-temporal-coupling] Loading reads the storage,
// so the daemon loads before any owner of its own arms a timer, and a storage
// that cannot be read refuses the build with nothing running; the start comes
// once the host's parts exist.
export function loadMainRenderer(
  inputs: MainRendererInputs,
): LoadedMainRenderer {
  const sessionState = new SessionState(inputs.storage.session);
  const history = inputs.storage.history.load();
  return {
    start: (host) => startOver(inputs, sessionState, history, host),
  };
}

function startOver(
  inputs: MainRendererInputs,
  sessionState: SessionState,
  history: LoadedHistory,
  host: AdapterToHost,
): Renderer {
  const { gates, linkSigner } = inputs;
  // [LAW:single-enforcer] The renderer's lines go to the host's one log.
  const { log } = host;
  // [LAW:no-ambient-temporal-coupling] The turn's instant, which every
  // reading of time in the renderer is.
  const time = new TurnTime();
  const now = (): Instant => (time.now() / 1000) as Instant;
  const menuIdle = new MenuIdle();
  const settingsHistory = new SettingsHistory(
    sessionState,
    log,
    inputs.storage.history,
    history,
  );
  let minted = 0;
  const mint = (): EffectId => ++minted as EffectId;
  const configWrites = new ConfigWrites(mint, readConfigText);
  // [LAW:single-enforcer] A failed act of a session's, on its bar the way its
  // click's own failure is.
  const actFailed = (session: SessionId, reason: string): void =>
    holdClickError(sessionState, session, reason, now());
  const acts = new ActsOnTheirWay(mint, actFailed);
  const laneActs = new LaneActs({
    ask: (effects, act) => acts.ask(effects, act),
    refused: actFailed,
    log,
  });
  const navigationHistory = new NavigationHistory();
  // Each session's effect memory — when its effect came into force — held in
  // daemon memory only: a restarted daemon starts every session's effect again.
  const effectSessions = new EffectSessions<RenderedLine>();
  // [LAW:single-enforcer] What each session's renderers could not honour, as
  // their frames recorded it (src/renderer/render-warnings.ts).
  const renderWarnings = new RenderWarningRecords();
  // [LAW:one-source-of-truth] The dismiss gate follows the update fact the
  // host's documents carry: the gates are this renderer's own.
  const updateGate = new UpdateGate(gates);
  // [LAW:single-enforcer] Each session's doctor run, whose report is
  // written once the host's reading of it arrives in a world state.
  const doctorRuns = new DoctorRuns({
    sessionState,
    stores: inputs.storage.doctor,
    log,
    failed: actFailed,
  });
  // The world states the host hands the renderer, which its views read.
  const worldStates = new WorldStates((document) => {
    updateGate.took(document.daemon.update.newer);
    doctorRuns.took(document);
  });
  // [LAW:single-enforcer] Every watch this renderer holds, each held by the
  // host's registry under an id minted here.
  const watches = new Watches(host.watches);
  const renderCache = new RenderCache<SessionSource, CheckedRenderRequest>(
    {
      clock: time,
      stateDir: inputs.stateDir,
      locations: inputs.locations,
      env: inputs.env,
      sessionState,
      watchers: watches,
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
          for (const sessionId of sessions) feeds.owe(sessionId, "reload");
        },
        // [LAW:single-enforcer] What a session's view draws from moved: its
        // feed is owed a frame, whatever moved it: a request's facts, a
        // refresh landing after its deadline, a source publishing, a pick.
        // The dump link, which no view holds, owes one the same way.
        onViewChanged: (sessionId) => feeds.owe(sessionId, "data"),
      },
    },
  );
  const parts: RendererParts = {
    ...host,
    linkSigner,
    sessionState,
    renderCache,
    worldStates,
    renderWarnings,
    effectSessions,
    laneActs,
  };
  const reloadConfig = (origin: RenderOrigin): void =>
    renderCache.reload(origin.projectDir, origin.cwd, origin.target.path, {
      kind: "write",
    });
  const verbCtx: DaemonVerbContext = {
    gates,
    sessionState,
    stateDir: inputs.stateDir,
    locations: inputs.locations,
    configWrites,
    clickLanded: (sessionId) => menuIdle.clicked(sessionId, now()),
    log,
    acts,
    now,
    doctorRuns,
    // The load the session's bar is drawn from: its cache entry's load
    // outcome, and what the config that entry renders left unused, reloaded
    // first (`startRun`).
    doctorLoad: (origin) => {
      const at = [origin.projectDir, origin.cwd, origin.target.path] as const;
      renderCache.reload(...at, { kind: "doctor" });
      const entry = renderCache.getOrCreate(...at);
      return {
        layers: entry.configLayers,
        error: entry.lastError,
        warning: entry.lastWarning,
        unused: entry.state.unused,
        config: entry.state.config,
      };
    },
    doctorStores: inputs.storage.doctor,
    history: settingsHistory,
    navigation: navigationHistory,
    // The config a session's last render resolved from — the same entry the
    // render drew the bar with, so a save compares against the bar the user saw.
    configFor: (origin) =>
      renderCache.getOrCreate(origin.projectDir, origin.cwd, origin.target.path)
        .state.config,
    reloadConfig,
    // The storage folders of the same entry `configFor` reads the config of.
    sourcesFor: (origin) =>
      renderCache.getOrCreate(origin.projectDir, origin.cwd, origin.target.path)
        .state.sources,
    links: linkSigner,
    lanes: {
      of: (origin, sessionId, latest) =>
        lanesAt(parts, origin, sessionId, latest),
      clicked: (sessionId, latest, before, after, effects) =>
        laneActs.clicked(sessionId, latest, before, after, effects),
    },
    diagnosticCopy: (sessionId, by, key) =>
      renderCache.drawnCopy(sessionId, by, key),
  };
  // [LAW:single-enforcer] Each followed session's feed (src/renderer/
  // feeds.ts), which draws its frames and declares when the next falls due.
  const feeds: Feeds = new Feeds({
    // The pin is the feed's life: the view's hold, and the reaction that owes
    // the feed a frame when the session's state moves, so the reaction lives
    // exactly as long as the feed that hears it.
    pin: (sessionId) => {
      const unhold = renderCache.pin(sessionId);
      const unwatch = reaction(
        () => sessionState.revision(sessionId),
        () => feeds.owe(sessionId, "state"),
      );
      return () => {
        unwatch();
        // [LAW:single-enforcer] Releasing the pin is the one moment the feed
        // stops drawing, so its drawn copies retire with it.
        renderCache.stopDrawing(sessionId, "feed");
        unhold();
      };
    },
    draw: (sessionId, fps, at, following, laneFeeds) => {
      const drawn = renderFrame(parts, sessionId, fps, at, {
        following,
        feeds: laneFeeds,
        idleSince: menuIdle.idleSince(sessionId),
      });
      if (drawn === null) return null;
      if (drawn.menus !== null) menuIdle.drew(sessionId, at, drawn.menus);
      return drawn.frame;
    },
    log,
  });
  // [LAW:types-are-the-program] Exhaustive over the pushes: a new arm is a
  // compile error here until the renderer answers it.
  const pushed = (push: AdapterPush, at: Instant): AdapterReply => {
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
            framesDrawn: feeds.drawn,
          },
        };
      case "debug":
        return {
          kind: "debug",
          snapshot: debugOf(renderCache.latestView(), push.what),
        };
      case "watch":
        watches.pushed(push.id, push.heard, push.deaf);
        return { kind: "watch" };
      case "reload-every":
        renderCache.reloadEvery({ kind: "events-resumed", since: push.since });
        return { kind: "reload-every" };
      case "reload-config":
        reloadConfig(push.origin);
        return { kind: "reload-config" };
      // [LAW:no-ambient-temporal-coupling] No journal opens after this: a turn
      // runs whole, so none is in flight.
      case "close-journal":
        configWrites.close();
        return { kind: "close-journal" };
      // Every feed ends with its pin before the views close.
      case "close-views":
        feeds.close(at);
        renderCache.close();
        return { kind: "close-views" };
      case "close-session-state":
        sessionState.close();
        return { kind: "close-session-state" };
    }
  };
  return mainRenderer(
    {
      ...parts,
      verbs: verbsOver(verbCtx),
      mint,
      acts,
      doctorRuns,
    },
    { time, feeds, menuIdle },
    pushed,
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

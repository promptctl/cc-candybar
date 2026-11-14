// The main renderer, in process: today's request answer behind the renderer
// interface (src/renderer-interface/interface.ts). A `config` turn records the
// session's context and opens its view there, so its output names what the
// view reads before the request after it waits. A request's turn holds that
// view at its own context, draws the bar and returns it as a `present`; that
// present's `effect-done` records what the frame showed, once the host says
// whether its client took it. A world state the host hands in, with a
// `config` or alone, is what the session's views draw from, and a retire ends
// what the renderer holds of the session. A click, and the idle clock's close
// of a session's menus, act in their turn. Every output says what the open
// views need read, as they stand once the turn's act has landed.

import {
  answerRequest,
  configureSession,
  laneClicked,
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
import type { Timekeeper } from "../time.js";
import type { DaemonLogger } from "../utils/logger.js";
import type { SessionStorage } from "../renderer-interface/session-state.js";
import type { HistoryStorage } from "../renderer-interface/history-storage.js";
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
import type { Instant } from "../utils/instant.js";
import { failureOf } from "../daemon/foundations/verb-error.js";
import type {
  AdapterInput,
  AdapterOutput,
  Effect,
  EffectId,
  Event,
  EventInput,
  Renderer,
  RendererInput,
  RendererOutput,
} from "../renderer-interface/interface.js";
import { JournalTurns } from "./journal-turns.js";
import { reaction } from "mobx";
import type { SessionId } from "../daemon/foundations/session-id.js";

export function mainRenderer(
  parts: MainRendererParts,
  // [LAW:effects-at-boundaries] exception: the host's pushes, each answered
  // in its own turn, synchronously.
  pushed: (push: AdapterPush, at: Instant) => AdapterReply,
): Renderer {
  // [LAW:single-enforcer] What each present's frame records once it reached
  // its client, held from the turn that returned it until its one
  // `effect-done`: the host settles every present it is handed, so this
  // holds only presents still on their way.
  const deliveries = new Map<EffectId, () => void>();
  let minted = 0;

  const turn = async (
    event: Event,
    at: Instant,
    record: RequestFacts,
  ): Promise<readonly Effect[]> => {
    switch (event.kind) {
      case "config":
        configureSession(parts, event.context, event.worldState, at, record);
        return [];
      case "request": {
        const { frame, delivered } = await answerRequest(
          parts,
          event.context,
          at,
          event.waitMs,
          record,
        );
        const id = ++minted as EffectId;
        deliveries.set(id, delivered);
        return [
          {
            kind: "present",
            id,
            session: event.context.hookData.session_id,
            surface: "statusline",
            request: event.id,
            frame,
          },
        ];
      }
      case "world-state":
        parts.worldStates.take(event.worldState);
        return [];
      case "retire":
        retireSession(parts, event.session);
        return [];
      case "effect-done": {
        const delivered = deliveries.get(event.of);
        // [LAW:no-silent-failure] An effect this renderer never returned, or
        // one already settled, is the host's bug: said, never ignored.
        if (delivered === undefined)
          throw new Error(
            `effect-done for effect ${event.of}, which is not a present on its way`,
          );
        deliveries.delete(event.of);
        if (event.outcome.kind === "ok") delivered();
        return [];
      }
      case "click":
        await clickTurn(parts, event, record);
        return [];
      case "menu-idle":
        // [LAW:no-ambient-temporal-coupling] Whether the session is still
        // idle is the clock's to say, in the close's own journal turn: a
        // click since the firing keeps what it opened.
        // [LAW:effects-at-boundaries] exception: the idle clock stays with
        // the host, so the turn asks it in place.
        await parts.verbs.closeIdle(event.session, {
          ...event.idle,
          confirm: () =>
            parts.menuIdle.confirmClose(event.session, event.idle.firedAt),
        });
        return [];
    }
  };

  function answer(input: EventInput): Promise<RendererOutput>;
  function answer(input: AdapterInput): Promise<AdapterOutput>;
  async function answer(
    input: RendererInput,
  ): Promise<RendererOutput | AdapterOutput> {
    switch (input.kind) {
      case "adapter":
        // [LAW:no-ambient-temporal-coupling] A push awaits nothing, so the
        // input after it lands after its writes.
        try {
          return { kind: "replied", reply: pushed(input.push, input.at) };
        } catch (thrown) {
          return { kind: "threw", failure: failureOf(thrown) };
        }
      case "event": {
        const record: RequestFacts = [];
        const ended = await turn(input.event, input.at, record).then(
          (effects) => ({ kind: "answered", effects }) as const,
          // [LAW:single-enforcer] Classified here, where it was thrown: a
          // class crosses no process.
          (thrown: unknown) =>
            ({ kind: "threw", failure: failureOf(thrown) }) as const,
        );
        // [LAW:one-source-of-truth] What the renderer needs read: the open
        // views' subscriptions as they stand when the turn ends, however it
        // ended.
        return {
          ...ended,
          record,
          subscriptions: parts.renderCache.subscriptions(),
        };
      }
    }
  }
  return { answer };
}

// What the main renderer is built from besides the host's parts: its clock and
// log, the storage its session state and history load from, and the facts of
// the machine its loads resolve under.
export interface MainRendererInputs {
  readonly clock: Timekeeper;
  readonly log: DaemonLogger;
  readonly now: () => Instant;
  readonly storage: {
    readonly session: SessionStorage;
    readonly history: HistoryStorage;
  };
  // The state directory whose answers book a load reads and a click records in.
  readonly stateDir: string;
  // Where the user's config and installed plugins live.
  readonly locations: Locations;
  // The environment an `env` source reads: the daemon's host.
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly home: string;
  // What this daemon's clicks may write: the gates its root built.
  readonly gates: Gates;
  // The bundle this daemon runs, which the doctor judges the clients against.
  readonly bundle: string;
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
  const { log } = inputs;
  const sessionState = new SessionState(inputs.storage.session);
  const settingsHistory = new SettingsHistory(
    sessionState,
    log,
    inputs.storage.history,
  );
  return {
    start: (host) => startOver(inputs, sessionState, settingsHistory, host),
  };
}

function startOver(
  inputs: MainRendererInputs,
  sessionState: SessionState,
  settingsHistory: SettingsHistory,
  host: AdapterToHost,
): Renderer {
  const { clock, log, now, gates } = inputs;
  // [LAW:single-enforcer] The one queue every journal waits its turn in, the
  // renderer's own: no host part takes a turn.
  const journalTurns = new JournalTurns({
    log,
    monotonic: () => clock.monotonic(),
  });
  const navigationHistory = new NavigationHistory();
  // Each session's effect memory — when its effect came into force — held in
  // daemon memory only: a restarted daemon starts every session's effect again.
  const effectSessions = new EffectSessions<RenderedLine>();
  // [LAW:single-enforcer] What each session's renderers could not honour, as
  // their frames recorded it (src/renderer/render-warnings.ts).
  const renderWarnings = new RenderWarningRecords();
  // The world states the host hands the renderer, which its views read.
  const worldStates = new WorldStates();
  const renderCache = new RenderCache<SessionSource, CheckedRenderRequest>(
    {
      clock,
      stateDir: inputs.stateDir,
      locations: inputs.locations,
      env: inputs.env,
      sessionState,
      watchers: host.watchers,
      log,
      storage: host.managedStorage,
      signer: host.linkSigner,
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
            host.frameFeeds.wake(sessionId, "reload");
        },
        // [LAW:single-enforcer] What a session's view draws from moved: its
        // feed's next frame is brought forward, whatever moved it: a request's
        // facts, a refresh landing after its deadline, a source publishing, a
        // pick. The dump link, which no view holds, wakes the same way.
        onViewChanged: (sessionId) => host.frameFeeds.wake(sessionId, "data"),
      },
    },
  );
  const parts: RendererParts = {
    ...host,
    clock,
    log,
    sessionState,
    renderCache,
    worldStates,
    renderWarnings,
    effectSessions,
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
    journalTurns,
    clickLanded: (sessionId) => host.menuIdle.clicked(sessionId, now()),
    log,
    launcher: host.launcher,
    now,
    applyUpdate: host.applyUpdate,
    // The load the session's bar is drawn from: its cache entry's load
    // outcome, and what the config that entry renders left unused.
    // [LAW:no-ambient-temporal-coupling] Reloaded first, as a save does: a
    // doctor click is a verdict on the files as they are now, not on
    // whether the fs watcher has caught up with an edit made a moment ago.
    doctor: host.doctor.edge((origin) => {
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
    }),
    doctorStores: host.doctor.stores,
    doctorProbes: host.doctor,
    probes: host.probes,
    clients: host.renderSightings,
    bundle: inputs.bundle,
    serving: host.serving,
    claudeInput: host.claudeInput,
    history: settingsHistory,
    navigation: navigationHistory,
    // The config a session's last render resolved from — the same entry the
    // render drew the bar with, so a save compares against the bar the user saw.
    configFor: (origin) =>
      renderCache.getOrCreate(origin.projectDir, origin.cwd, origin.target.path)
        .state.config,
    reloadConfig,
    // The storage keys of the same entry `configFor` reads the config of.
    sourcesFor: (origin) =>
      renderCache.getOrCreate(origin.projectDir, origin.cwd, origin.target.path)
        .state.sources,
    links: host.linkSigner,
    runs: host.runs,
    lanes: {
      of: (origin, sessionId) => lanesAt(parts, origin, sessionId),
      clicked: (sessionId, before, after) =>
        laneClicked(parts, sessionId, before, after),
    },
    views: {
      follow: (sessionId, origin) =>
        renderCache.follow(
          sessionId,
          origin.projectDir,
          origin.cwd,
          origin.target.path,
        ),
    },
    diagnosticCopy: (sessionId, by, key) =>
      renderCache.drawnCopy(sessionId, by, key),
  };
  // [LAW:single-enforcer] Each open feed's pin, from its `pin` to its
  // `unpin`: the view's hold and the reaction that wakes the feed when the
  // session's state moves, so the reaction lives exactly as long as the feed
  // that hears it.
  const pins = new Map<SessionId, () => void>();
  const pin = (sessionId: SessionId): void => {
    // [LAW:no-silent-failure] A feed opens once per session, so a second pin
    // is the host's bug.
    if (pins.has(sessionId))
      throw new Error(`pin of session ${sessionId}, whose feed is pinned`);
    const unhold = renderCache.pin(sessionId);
    const unwatch = reaction(
      () => sessionState.revision(sessionId),
      () => host.frameFeeds.wake(sessionId, "state"),
    );
    pins.set(sessionId, () => {
      unwatch();
      // [LAW:single-enforcer] A feed's pin is its life: releasing it is the
      // one moment the feed stops drawing, so its drawn copies retire with it.
      renderCache.stopDrawing(sessionId, "feed");
      unhold();
    });
  };
  const unpin = (sessionId: SessionId): void => {
    const release = pins.get(sessionId);
    if (release === undefined)
      throw new Error(
        `unpin of session ${sessionId}, whose feed is not pinned`,
      );
    pins.delete(sessionId);
    release();
  };
  // [LAW:types-are-the-program] Exhaustive over the pushes: a new arm is a
  // compile error here until the renderer answers it.
  const pushed = (push: AdapterPush, at: Instant): AdapterReply => {
    switch (push.kind) {
      case "frame":
        return {
          kind: "frame",
          frame: renderFrame(parts, push.session, push.fps, at, {
            following: new Set(push.following),
            feeds: push.feeds,
          }),
        };
      case "lanes":
        return { kind: "lanes", lanes: viewLanes(parts, push.session) };
      case "pin":
        pin(push.session);
        return { kind: "pin" };
      case "unpin":
        unpin(push.session);
        return { kind: "unpin" };
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
            journalTurns: journalTurns.getStats(),
          },
        };
      case "debug":
        return {
          kind: "debug",
          snapshot: debugOf(renderCache.latestView(), push.what),
        };
      case "hold-click-error":
        holdClickError(sessionState, push.session, push.text, at);
        return { kind: "hold-click-error" };
      case "reload-every":
        renderCache.reloadEvery({ kind: "events-resumed", since: push.since });
        return { kind: "reload-every" };
      case "reload-config":
        reloadConfig(push.origin);
        return { kind: "reload-config" };
      // [LAW:no-ambient-temporal-coupling] The journal in flight commits what
      // landed before the host's abort cuts it off.
      case "close-journal":
        journalTurns.close();
        return { kind: "close-journal" };
      case "close-views":
        renderCache.close();
        return { kind: "close-views" };
      case "close-session-state":
        sessionState.close();
        return { kind: "close-session-state" };
    }
  };
  return mainRenderer(
    { ...parts, verbs: verbsOver(verbCtx, host.clicks) },
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

// The daemon as a value: what it holds, built from its inputs, and its one close.

import { SessionBook } from "./session-book.js";
import type { SessionFileStorage } from "./session-state-file.js";
import type { DurableContext } from "../renderer-interface/request-context.js";
import { Runs } from "./runs.js";
import { locations, type DaemonPaths } from "./paths";
import type { Host } from "../host";
import type { DaemonLog } from "./log";
import type { Inbound } from "./foundations/protocol";
import type { DaemonParts } from "./daemon-parts.js";
import {
  handleRequest,
  replyTo,
  type HandledRequest,
  type Reply,
  type ReplyRequest,
} from "./reply.js";
import type { CheckedRenderRequest } from "../renderer-interface/request-context.js";
import type { LaunchOwner, Settled, TestableLauncher } from "../proc/launch";
import type { Launcher } from "../proc/launcher";
import type { DaemonLogger } from "../utils/logger";
import type { Gates } from "./foundations/gates";
import { makeBinaryWatch, type BundleStat } from "./binary-watch";
import { createPayloadProviders } from "./payload-providers";
import { runTeardown, type TeardownStep } from "../utils/teardown";
import { FileEventDelivery } from "./cache/file-events";
import type { Timekeeper } from "../time";
import { type Acceptance } from "./foundations/request-event.js";
import { RefreshLedger } from "../utils/refresh-ledger";
import { SourceRuns } from "./source-runs";
import { WatcherRegistry } from "./cache/watchers";
import { RuntimeStats } from "./stats";
import { makeLimits, type LimitsDeps } from "./limits";
import type { DoctorMachineEdge } from "../doctor/ports";
import { RenderSightings } from "./render-sightings";
import { Collector } from "./collector.js";
import { FrameFeeds } from "./frame-feed.js";
import {
  LIST_CLIENTS_FORMAT,
  LIST_PANES_FORMAT,
  PaneVisibility,
} from "./pane-visibility.js";
import { runTmuxAsync } from "../proc/tmux.js";
import { RetiredTmuxStatus } from "./retired-tmux-status.js";
import type { BarPaneEdge } from "./lane-setup.js";
import type { ClaudeInputEdge } from "../claude-input/typing.js";
import { clickLaunchVia } from "./foundations/click-launch.js";
import { Acts } from "./acts.js";
import { DeclaredBarPanes } from "./declared-bar-panes.js";
import { linkSignerOver } from "../click/link-signer.js";
import type { Asked } from "../utils/outcome.js";
import { instantAt, type Instant } from "../utils/instant.js";
import { rendererHost } from "./renderer-host.js";
import { mainRendererOf } from "../renderer/main.js";
import { HeldStores, type ProfileStorage } from "./held-stores.js";
import type { RendererName } from "./foundations/renderer-name.js";
import type { RendererPort } from "./renderer-process.js";
import type { AdapterToHost } from "../renderer-interface/adapter.js";
import { plainEnvironment } from "./foundations/session-env.js";
import {
  answeredBy,
  joinedEvent,
  type HeldEvent,
} from "../utils/event-hold.js";
import { located } from "./statusline-answer.js";
import { checkoutLocation } from "../utils/git-root.js";
import { DoctorSource, daemonSighted } from "./cache/doctor.js";
import { compareStructural, observable, runInAction } from "mobx";
import type { DaemonFacts } from "../facts/world-state.js";
import { fileEventsWarnings } from "./foundations/file-events-warnings.js";
import { ConfigDiscovery } from "./config-discovery/config-discovery.js";

// How this daemon's node runs the bundle it was loaded from.
export interface RunningBundle {
  // The digest of the source it was built from, `null` for one that carries
  // none. Daemon stats use it to distinguish builds of the same version.
  readonly digest: string | null;
  // The file the daemon loaded, used to identify its installation.
  readonly path: string;
  // What a bar pane runs.
  readonly node: readonly string[];
  // The files the binary watch stats: a change to any of them restarts the
  // daemon.
  readonly targets: readonly string[];
}

// [LAW:effects-at-boundaries] Everything a daemon does to the machine, as an
// input: it names no real one itself, so a daemon is as isolated as the
// adapters it is handed. src/daemon/production-adapters.ts builds the real
// ones. An adapter that needs what `createDaemon` builds, as the launcher needs
// its stats and its closing signal, is a factory over those.
export interface DaemonAdapters {
  // The file the daemon's work logs to.
  readonly daemonLog: DaemonLog;
  // What every launch of the daemon's work goes through.
  readonly launcher: (own: LaunchOwner) => TestableLauncher;
  // [LAW:one-source-of-truth] Where the stores of the profile `name` derives
  // are kept, which the daemon reads once it serves and is then their sole
  // writer. Built over the daemon's log: a write in flight at the close
  // finishes after it, and what it logs says so like any other line of the
  // daemon's work.
  readonly profile: (name: RendererName, log: DaemonLogger) => ProfileStorage;
  // Where the host keeps its book of each session's durable context: the
  // host's own, whichever renderer it runs.
  readonly sessionBook: (
    log: DaemonLogger,
  ) => SessionFileStorage<DurableContext>;
  // The doctor's reads of the machine, under the daemon's state directory.
  readonly doctorEdge: (
    launcher: Launcher,
    host: Host,
    stateDir: string,
  ) => DoctorMachineEdge;
  readonly claudeInput: (launcher: Launcher) => ClaudeInputEdge;
  readonly barPaneEdge: (launcher: Launcher) => BarPaneEdge;
  // [LAW:one-source-of-truth] The link key, asked for at each use: every
  // click is opened with it and every renderer draws with it.
  readonly linkKey: () => Asked<Buffer>;
  // What the memory backstop reads and writes on the machine.
  readonly limits: (own: {
    readonly startedAtMs: number;
    readonly exit: (code: number) => void;
    readonly launcher: Launcher;
    readonly log: DaemonLogger;
  }) => LimitsDeps;
  // [LAW:one-type-per-behavior] Where the renderer runs: in this process, or
  // in a process of its own (src/daemon/renderer-process.ts).
  readonly renderer: RendererPort;
  // How the binary watch reads the bundle's mtime.
  readonly stat: BundleStat;
}

// What a daemon takes from the process that runs it: where its files are, what
// it does to the machine, and the numbers it runs by.
export interface DaemonInputs extends DaemonAdapters {
  readonly bundle: RunningBundle;
  // The renderer it serves, whose profile its stores are.
  readonly rendererName: RendererName;
  // [LAW:one-source-of-truth] What the process knows of its machine: its
  // environment, home and temporary directory. The daemon reads them from here
  // alone, and its launcher's children inherit the same environment.
  readonly host: Host;
  // The paths the daemon itself reads or writes. The files an adapter owns are
  // aimed by the same value at the adapter (production-adapters.ts), so a daemon
  // aimed at a temporary directory writes nowhere else.
  readonly paths: Pick<DaemonPaths, "socket" | "state" | "watchProbe">;
  readonly memoryLimitBytes: number;
  // [LAW:effects-at-boundaries] The daemon's clock: what it draws and times
  // requests by, and every timer its pieces set. A test holds it by hand.
  // [LAW:one-source-of-truth] `after` runs a request's wait and its backstop on
  // the same clock its budget is figured from, so a held clock holds all three.
  readonly clock: Timekeeper;
  // [LAW:no-shared-mutable-globals] What this daemon's loads accept: its own
  // gate registry, so two daemons in one process share none.
  readonly gates: Gates;
  // [LAW:single-enforcer] The process's one death funnel: the binary watch and
  // the memory backstop end the daemon here, never on their own.
  readonly exit: (code: number) => void;
}

// The daemon as a value: built by `createDaemon`, driven by calling `handle`,
// ended by `close`. Everything about a process — a socket, signals, an exit —
// is server.ts's, over this; `exit` is only the funnel it handed in.
export interface Daemon {
  readonly stats: RuntimeStats;
  // What this daemon's work launches through: its close refuses them all.
  readonly launcher: Launcher;
  // What this daemon's work logs through.
  readonly log: DaemonLogger;
  readonly memoryLimitBytes: number;
  readonly clock: Timekeeper;
  // [LAW:one-source-of-truth] The funnel this daemon was built with, which a
  // connection reaches once a reply carrying an exit has flushed.
  readonly exit: DaemonInputs["exit"];
  // The request handling a connection calls, with the request as its
  // connection accepted it.
  readonly handle: (
    inbound: Inbound,
    timedOut: () => boolean,
    accepted: Acceptance,
    clientLeft: () => boolean,
  ) => Promise<HandledRequest>;
  // The reply to a request of any kind but a subscribe, past the connection's
  // checkpoint: what the page in site/ calls with requests it built.
  readonly reply: (
    req: ReplyRequest,
    timedOut: () => boolean,
    accepted: Acceptance,
    clientLeft: () => boolean,
  ) => Promise<Reply>;
  readonly subscribe: FrameFeeds<CheckedRenderRequest>["subscribe"];
  // Discover every followed origin's config again, now: the page in site/
  // calls it after it resets its simulated machine's config file, which no
  // watch hears.
  readonly rediscover: () => void;
  // [LAW:no-ambient-temporal-coupling] Reads the profile's stores and builds
  // the renderer from them: before it, an input fails as no renderer's. What
  // the page calls, and a test's daemon; an armed daemon serves as it arms.
  serve(): void;
  // What a daemon that won the socket starts: only it counts its memory or
  // watches its bundle.
  arm(): void;
  // [LAW:no-ambient-temporal-coupling] After this nothing launches, no timer
  // stays armed once what was in flight has settled, and only the log is
  // written. A read already under way may finish. It resolves once every
  // teardown step has run, the renderer's included, and its `settled` once the
  // launches and lifeline it ended have ended.
  close(): Promise<{ readonly settled: Promise<Settled> }>;
}

export function createDaemon(inputs: DaemonInputs): Daemon {
  const { bundle, memoryLimitBytes, clock, exit, paths, gates, host } = inputs;
  // Parsed once, here, and handed to everything that loads a config.
  const locs = locations(host);
  const instant = (): Instant => instantAt(clock);
  // [LAW:single-enforcer] What ends the daemon's work: every launch through its
  // launcher, and the lane edge's waits.
  const closing = new AbortController();
  // Whether the close has finished: what is logged after it is work that
  // outlived its daemon. A process exits with its close, so this is a daemon
  // closed in a process that goes on, and the next daemon's log can be the file
  // the line lands in: it says whose it is rather than reading as an event of
  // that daemon's.
  let closed = false;
  // [LAW:one-source-of-truth] What this daemon's work logs through.
  const log: DaemonLogger = (level, msg) =>
    inputs.daemonLog.log(level, closed ? `after close: ${msg}` : msg);
  // [LAW:one-source-of-truth] one cache instance per daemon process — multiple
  // instances would defeat the share-across-sessions invariant.
  const stats = new RuntimeStats(clock);
  // [LAW:single-enforcer] The daemon injects its log into both registries so
  // cache + watcher lifecycle events land in daemon.log at the right level.
  // Non-daemon consumers (var-system tests, future library use) take the
  // default debug-routed loggers and never write to daemon log files.
  const watcherRegistry = new WatcherRegistry({
    clock,
    counters: stats,
    logger: log,
  });
  // [LAW:one-source-of-truth] Whether the OS is delivering this daemon's file
  // events: one owner, started once the bind is won (`arm`).
  const fileEvents = new FileEventDelivery({
    watchers: watcherRegistry,
    logger: log,
    clock,
  });
  // [LAW:one-source-of-truth] The daemon's own faults, as every session's
  // world state carries them: whether file events are heard, and what the
  // launcher stands behind. Restated whenever either may have moved, and
  // compared whole, so a restatement that moved nothing moves no document.
  // [LAW:no-ambient-temporal-coupling] Declared before the launcher, whose
  // observer restates them.
  const daemonFaults = observable.box<DaemonFacts>(
    { fileEvents: [], launcher: [], rendererEnded: null, actFailed: null },
    { deep: false, equals: compareStructural },
  );
  // [LAW:one-source-of-truth] How the last renderer process ended, and the
  // acts that failed with no session's bar to hold them, each held for the
  // bar until an answer has carried it.
  let rendererEnded: HeldEvent | null = null;
  let actFailed: HeldEvent | null = null;
  function restateFaults(): void {
    runInAction(() =>
      daemonFaults.set({
        fileEvents: fileEventsWarnings(fileEvents.delivery()),
        launcher: launcher.standing(),
        rendererEnded,
        actFailed,
      }),
    );
  }
  // [LAW:single-enforcer] Route all child_process spawns through src/proc/launch:
  // this daemon's launcher meters them into daemon-stats and ends them with it.
  // Its work holds this one, so a closed daemon's launches are refused here,
  // whichever daemon is live by then.
  const launcher = inputs.launcher({
    inherited: host.env,
    stats: stats.launchStats,
    signal: closing.signal,
    // [LAW:one-source-of-truth] Pipe events are stamped on the clock renders
    // hold them against.
    now: instant,
    // [LAW:no-silent-failure] Each change in whether what the daemon launches
    // dies with it, and each pipe event, is said in daemon.log, and every
    // session's world state carries it, so its warning comes on frames too.
    observeWarnings: (change) => {
      if (change.kind === "launch-pipes") log("warn", change.text);
      else
        log(
          change.fault === null ? "info" : "warn",
          change.fault === null
            ? "launch lifeline running again"
            : `launch lifeline ${change.fault}; the next launch starts another`,
        );
      restateFaults();
    },
  });
  const linkSigner = linkSignerOver(inputs.linkKey);
  // [LAW:single-enforcer] The renderer's stored state, held here: every
  // renderer is built from what it holds then, and every turn's stored writes
  // move it.
  const stores = new HeldStores(inputs.profile(inputs.rendererName, log));
  const sessionBook = new SessionBook(inputs.sessionBook(log));
  const preparedRenderer = inputs.renderer({
    name: inputs.rendererName,
    build: (reaches) =>
      mainRendererOf(
        {
          stored: stores.current(),
          linkSigner,
          locations: locs,
          home: host.home,
          gates,
          memoryLimitBytes,
        },
        reaches,
      ),
    // The key crosses in base64, so the boot crosses as a line.
    boot: () => {
      const key = inputs.linkKey();
      return {
        stored: stores.current(),
        digest: bundle.digest,
        host: { ...host, env: plainEnvironment(host.env) },
        memoryLimitBytes,
        linkKey:
          key.kind === "ok"
            ? { kind: "ok", value: key.value.toString("base64") }
            : key,
      };
    },
    node: bundle.node,
  });
  // Building starts nothing: only the daemon that won the socket arms them, so
  // the page answers the doctor's `serving` with no timer counting its memory.
  const limits = makeLimits({
    ...inputs.limits({
      startedAtMs: stats.startedAt.getTime(),
      exit,
      launcher,
      log,
    }),
    limitBytes: memoryLimitBytes,
    // [LAW:one-source-of-truth] The limit is over the daemon's whole: the
    // renderer's process counts in it while one runs. Read only once armed,
    // by when the link below exists.
    renderer: () => link.process(),
  });
  const renderSightings = new RenderSightings();
  // [LAW:one-source-of-truth] One provider per data shape, shared across every
  // render in this daemon, built by the one constructor every renderer uses
  // (payload-providers.ts). The render cache owns DSL-state-per-config; these
  // serve the augmented payload that flows through every render.
  // [LAW:single-enforcer] The daemon's one record of every source's refreshes:
  // the providers', and each config's user sources (the render cache's).
  const refreshLedger = new RefreshLedger(log);
  restateFaults();
  // [LAW:single-enforcer] The daemon's one owner of every declared source's
  // runs: the collector holds each run a session's renderer subscribes to, so
  // one identity is one program however many sessions name it.
  const sourceRuns = new SourceRuns({
    launcher,
    clock,
    logger: log,
    ledger: refreshLedger,
    watchers: watcherRegistry,
    fileEvents,
  });
  // [LAW:single-enforcer] The daemon's one reader of the doctor's facts: the
  // collector holds the run a session's renderer subscribes to.
  const doctorSource = new DoctorSource({
    // The doctor's edge sets no signal of its own, so each read's launches
    // carry the read's.
    edge: (signal) =>
      inputs.doctorEdge(
        { ...launcher, launch: (opts) => launcher.launch({ ...opts, signal }) },
        host,
        paths.state,
      ),
    sighted: (sessionId, now) =>
      daemonSighted(
        sessionId,
        renderSightings.ofSession(sessionId, now),
        limits.serving(),
        bundle.path,
      ),
    clock,
    logger: log,
    ledger: refreshLedger,
  });
  const payloadProviders = createPayloadProviders({
    launcher,
    host,
    watchers: watcherRegistry,
    fileEvents,
    clock,
    logger: log,
    ledger: refreshLedger,
    sourceRuns,
    doctor: doctorSource,
  });
  const { managedStorage } = payloadProviders;
  // [LAW:no-ambient-temporal-coupling] The one owner of every `run` program in
  // flight (src/daemon/runs.ts), closed with the daemon.
  const runs = new Runs({
    supersede: (folder, sessionId) =>
      managedStorage.supersede(folder, sessionId),
    launch: launcher.launch,
    environmentOf: (session) => sessionBook.environmentOf(session),
    clock,
  });
  // [LAW:single-enforcer] The host's one performer of the acts the renderer's
  // turns return (src/daemon/acts.ts).
  const acts = new Acts({
    launch: clickLaunchVia(launcher),
    claudeInput: inputs.claudeInput(launcher),
    run: (run) => runs.start(run),
    barPane: {
      edge: inputs.barPaneEdge(launcher),
      // A bar pane runs this bundle under the node running it now, with the
      // flags it runs with (tsx's loader, under the test harness).
      host: {
        bundle: bundle.path,
        node: bundle.node,
        socket: paths.socket,
      },
    },
    closing: () => closing.signal.aborted,
    log,
  });
  const retiredTmuxStatus = new RetiredTmuxStatus(
    paths.socket,
    (socket, args, stdin) =>
      runTmuxAsync(launcher, { socket }, "tmux-status-migration", args, stdin),
    clock,
    log,
  );
  const declaredBarPanes = new DeclaredBarPanes(
    (sessionId) => {
      const latest = frameFeeds.latestWithOrder(sessionId);
      const pane = latest?.req.hints.tmux;
      return latest !== undefined && pane != null
        ? { pane, order: latest.order }
        : undefined;
    },
    (pane, on) => acts.setBarPane(pane, on),
    clock,
    log,
  );
  // Who watches each session's frames (candybar-animation-wbxz.jmm.usl),
  // handed to the renderer, whose feeds draw them, and what each subscriber
  // was sent.
  const frameFeeds: FrameFeeds<CheckedRenderRequest> = new FrameFeeds({
    shown: (req) => paneVisibility.shown(req.hints.tmux),
    watching: () => paneVisibility.follow(),
    deliver: (make) =>
      parts.renderer.deliver(
        () => ({ kind: "event", event: { kind: "viewers", viewers: make() } }),
        [],
      ),
    log,
  });
  // Which watched sessions' panes are on a screen, asked of their tmux servers
  // once a second while some feed exists: a session nobody can see is drawn at
  // the still rate however its bar moves, and one that comes into view is drawn
  // at once.
  const paneVisibility: PaneVisibility = new PaneVisibility({
    clock,
    listPanes: (socket) =>
      runTmuxAsync(launcher, { socket }, "frames.visibility", [
        "list-panes",
        "-a",
        "-F",
        LIST_PANES_FORMAT,
      ]),
    listClients: (socket) =>
      runTmuxAsync(launcher, { socket }, "frames.visibility", [
        "list-clients",
        "-F",
        LIST_CLIENTS_FORMAT,
      ]),
    // The servers of the sessions someone is watching.
    sockets: () => new Set(frameFeeds.watchedRequests().flatMap(tmuxServersOf)),
    onChange: () => frameFeeds.announce(),
    intervalMs: 1000,
    log,
  });
  // [LAW:one-source-of-truth] The tmux server a session's bar is on, as the
  // servers it is on: none outside tmux or from a client too old to say.
  function tmuxServersOf({
    hints: { tmux },
  }: CheckedRenderRequest): readonly string[] {
    return tmux === null || tmux === undefined ? [] : [tmux.socket];
  }
  // [LAW:no-silent-failure] An edit made while file events went unheard is
  // found when they resume: every followed origin is discovered again, and
  // each one that moved gets its `config` turn. Every feed redraws when
  // delivery moves, so its row comes and goes on frames too.
  // [LAW:no-ambient-temporal-coupling] Every directory watch is judged against
  // the disk on the one period the daemon keeps time by: a folder replaced
  // beneath a renamed ancestor reports nothing to the handle bound to the old
  // one, and a directory the OS refused is heard again only by a retry.
  fileEvents.subscribe((notice) => {
    switch (notice.kind) {
      case "period":
        watcherRegistry.judge();
        return;
      case "caught-up":
        restateFaults();
        configDiscovery.again("events-resumed");
        return;
      case "moved":
        restateFaults();
        return;
    }
  });
  const binaryWatch = makeBinaryWatch({
    clock,
    targets: bundle.targets,
    intervalMs: 60 * 1000,
    stat: inputs.stat,
    exit: () => exit(0),
    log,
  });

  // [LAW:single-enforcer] The host's one reader of every session's world. What
  // it hands in alone goes through the host's one path to the renderer, which
  // the parts below hold; a delivery is first asked for by an owner landing
  // after a request, so the parts exist by then.
  const collector = new Collector({
    owners: payloadProviders,
    daemon: () => daemonFaults.get(),
    clock,
    watched: (sessionId) => frameFeeds.isWatched(sessionId),
    deliver: (event) =>
      parts.renderer.deliver(() => ({ kind: "event", event }), []),
    log,
  });

  // [LAW:one-way-deps] The host's parts the main renderer reaches: the
  // compiler checks each against its entry in `AdapterToHost` here, so no
  // renderer file names a host type.
  const reaches: AdapterToHost = {
    // [LAW:effects-at-boundaries] exception: each reach below that crosses is
    // the host's part in its crossing shape: a notice.
    log,
    eventAnswered: (event) => {
      launcher.answeredPipeEvent(event);
      if (rendererEnded !== null && answeredBy(rendererEnded, event))
        rendererEnded = { ...rendererEnded, answered: true };
      if (actFailed !== null && answeredBy(actFailed, event))
        actFailed = { ...actFailed, answered: true };
      restateFaults();
    },
    storage: {
      hold: (id, folders) => managedStorage.hold(id, folders),
      release: (id) => managedStorage.release(id),
    },
  };
  const link = preparedRenderer.start({
    reaches,
    log,
    clock,
    // [LAW:single-enforcer] A renderer that starts again is configured as a
    // request would: every live session whose newest request the host holds
    // gets its context with its latest stamp, all in the one `start` turn, so
    // its output names every session it serves; and who watches each, so its
    // feeds open. All through the host's one path to the renderer, each turn
    // recorded there.
    // [LAW:no-ambient-temporal-coupling] The start heads the mailbox, so
    // every input after it finds its sessions handed in.
    start: async () => {
      const { kind } = await parts.renderer.start(() => {
        const viewers = frameFeeds.viewers();
        frameFeeds.handedIn(viewers);
        return {
          kind: "event",
          event: {
            kind: "start",
            viewers,
            sessions: [...collector.liveDocuments()].flatMap(
              ([sessionId, worldState]) => {
                const req = frameFeeds.latest(sessionId);
                return req === null
                  ? []
                  : [{ context: located(req, checkoutLocation), worldState }];
              },
            ),
          },
        };
      }, [["why", "renderer-start"]]);
      // A start that failed may have opened none of its feeds: the next
      // announcement hands the viewers in again.
      if (kind !== "answered") frameFeeds.handedIn(null);
    },
    ended: (event) => {
      rendererEnded = event;
      restateFaults();
    },
  });
  // [LAW:single-enforcer] What discovery found at each origin the renderer
  // names, and the watches that say when it moved: each origin it moved gets
  // its `config` turn. Made once the renderer is, whose making can throw, so
  // a build that throws leaves no watch open.
  const configDiscovery = new ConfigDiscovery({
    locations: locs,
    stateDir: paths.state,
    watchers: watcherRegistry,
    log,
    moved: (origins) => parts.renderer.moved(origins),
  });
  // [LAW:single-enforcer] Served once, whichever asks first.
  let served = false;
  const serve = (): void => {
    closing.signal.throwIfAborted();
    if (served) return;
    stores.load();
    sessionBook.load();
    link.serve();
    // [LAW:no-silent-failure] Served once every step has: a step that threw
    // is thrown to its caller, and the next ask serves again.
    served = true;
  };
  const parts: DaemonParts = {
    closing: closing.signal,
    home: host.home,
    launcher,
    log,
    clock,
    bundle: bundle.path,
    sourceDigest: bundle.digest,
    sessionBook,
    stats,
    linkSigner,
    renderSightings,
    watcherRegistry,
    refreshLedger,
    fileEvents,
    payloadProviders,
    runs,
    sourceRuns,
    retiredTmuxStatus,
    frameFeeds,
    limits,
    collector,
    renderer: rendererHost(
      inputs.rendererName,
      clock,
      link.renderer,
      log,
      {
        subscribed: (subscriptions) => {
          collector.subscribed(subscriptions);
          frameFeeds.switched(subscriptions.lanes);
          declaredBarPanes.declare(subscriptions.lanes);
        },
        frames: (frames) => frameFeeds.took(frames),
        stored: (writes) => stores.take(writes),
        holding: (session) => collector.holding(session),
        writableSettings: (session) => collector.writableSettings(session),
        // The daemon waits on no turn's note.
        recorded: () => {},
      },
      {
        perform: (act) => acts.perform(act),
        stateDir: paths.state,
        configs: configDiscovery,
        closing: () => closing.signal.aborted,
        // [LAW:no-silent-failure] Joined to the last while it is owed, by the
        // one rule for events that follow each other.
        unheard: (text) => {
          actFailed = joinedEvent(actFailed, text, instant());
          restateFaults();
        },
      },
    ),
  };

  return {
    stats,
    launcher,
    log,
    memoryLimitBytes,
    clock,
    exit,
    // [LAW:single-enforcer] A closed daemon serves nothing, and this surface is
    // the way in. A click that got in waits its turn in the renderer's
    // mailbox: one ahead of the close runs whole, and one behind it is
    // refused; a subscribe its request reached as the daemon closed is
    // refused here and opens no feed.
    handle: async (req, timedOut, accepted, clientLeft) => {
      closing.signal.throwIfAborted();
      return handleRequest(parts, req, timedOut, accepted, clientLeft);
    },
    reply: async (req, timedOut, accepted, clientLeft) => {
      closing.signal.throwIfAborted();
      return replyTo(parts, req, timedOut, accepted, clientLeft);
    },
    subscribe: (sessionId, subscriber) => {
      closing.signal.throwIfAborted();
      return frameFeeds.subscribe(sessionId, subscriber);
    },
    rediscover: () => {
      closing.signal.throwIfAborted();
      configDiscovery.again("asked");
    },
    serve,
    arm() {
      closing.signal.throwIfAborted();
      serve();
      fileEvents.start(paths.watchProbe);
      binaryWatch.arm();
      limits.arm();
      link.arm();
    },
    async close() {
      // The renderer's steps of the teardown, each awaited where it
      // stands: the renderer takes them in the order they are sent.
      const rendererStep =
        (kind: "close-journal" | "close-views") => (): Promise<unknown> =>
          parts.renderer.ask({ kind });
      // The stores still flush after a close failed (runTeardown).
      const teardown: readonly TeardownStep[] = [
        // [LAW:no-ambient-temporal-coupling] First: from here a renderer that
        // ends is not started again, so no step below waits on a fresh boot.
        // [LAW:no-ambient-temporal-coupling] First of all: no `due` is made
        // from here, so no turn the renderer holds for later runs into the
        // close's.
        ["renderer wake close", () => parts.renderer.closeWake()],
        ["renderer close begins", () => link.beginClose()],
        // [LAW:no-ambient-temporal-coupling] In the mailbox's arrival order:
        // every click ahead of it lands whole, and none behind it begins.
        ["renderer journal close", rendererStep("close-journal")],
        // [LAW:no-ambient-temporal-coupling] Nothing launches from here on, what
        // is in flight is terminated, whichever owner's work it was, and the
        // launcher's lifeline goes.
        ["launches abort", () => closing.abort(new Error("the daemon closed"))],
        ["frameFeeds close", () => frameFeeds.close()],
        ["binaryWatch close", () => binaryWatch.close()],
        ["limits disarm", () => limits.disarm()],
        // Before the sources and the storage its states hold.
        ["collector close", () => collector.close()],
        // Before the views close: a `config` made after it finds its origin
        // let go, and hands the closed cache nothing.
        ["configDiscovery close", () => configDiscovery.close()],
        ["renderer views close", rendererStep("close-views")],
        ...payloadProviders.closes,
        ["runs close", () => runs.close()],
        // After the collector, which holds every session's runs: its close
        // releases them first, so this close drops nothing still held.
        ["sourceRuns close", () => sourceRuns.close()],
        ["doctorSource close", () => doctorSource.close()],
        ["fileEvents close", () => fileEvents.close()],
        ["watcherRegistry close", () => watcherRegistry.closeAll()],
        // Last of the stores' writers: a run that ends in the teardown holds
        // its click error first.
        ["stores close", () => stores.close()],
        ["sessionBook close", () => sessionBook.close()],
        ["renderer process close", () => link.close()],
      ];
      await runTeardown(teardown, log);
      closed = true;
      return { settled: launcher.settled() };
    },
  };
}

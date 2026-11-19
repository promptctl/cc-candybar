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
  BadVerbArgs,
  CrossedFailure,
  DaemonClosing,
  failureOf,
} from "./foundations/verb-error.js";
import {
  thrownText,
  type ReportedThrow,
  type ReportingClock,
} from "./task-throws.js";
import { failedWith } from "./foundations/render-answers.js";
import {
  handleRequest,
  refuseClosingInbound,
  refuseClosingReply,
  replyTo,
  type HandledRequest,
  type Reply,
  type ReplyRequest,
} from "./reply.js";
import type { CheckedRenderRequest } from "../renderer-interface/request-context.js";
import type { LaunchOwner, Settled, TestableLauncher } from "../proc/launch";
import type { Launcher } from "../proc/launcher";
import type { DaemonLogger } from "../utils/logger";
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
import { authorizeRun } from "./foundations/run-authorization.js";
import { publishingFrames } from "./foundations/frame-publication.js";
import type { Asked } from "../utils/outcome.js";
import { instantAt, type Instant } from "../utils/instant.js";
import { rendererHost, type RendererHost } from "./renderer-host.js";
import { HeldStores, type ProfileStorage } from "./held-stores.js";
import {
  environmentOutput,
  isEnvironmentOutput,
} from "./environment-output.js";
import { RendererRecordings } from "./renderer-recording.js";
import type { RecordingFile } from "./recording-file.js";
import {
  rendererNameOf,
  type RendererName,
} from "./foundations/renderer-name.js";
import type { SessionId } from "./foundations/session-id.js";
import type {
  RendererBoot,
  RequestId,
  Subscriptions,
  Viewers,
} from "../renderer-interface/interface.js";
import type { RendererLink, RendererPort } from "./renderer-process.js";
import {
  variableOf,
  type SessionEnvironment,
} from "./foundations/session-env.js";
import {
  joinedEvent,
  recurrence,
  type DaemonEvent,
} from "../utils/event-hold.js";
import { HeldSlot, RecurringEvents } from "./held-slot.js";
import { compareStructural, observable, runInAction } from "mobx";
import type { DaemonFacts } from "../facts/world-state.js";
import { fileEventsWarnings } from "./foundations/file-events-warnings.js";
import { ConfigDiscovery } from "./config-discovery/config-discovery.js";
import { checkoutObservations } from "./checkout-observations.js";
import type { CheckoutFiles } from "../utils/git-root.js";
import type { WriteConfigFile } from "./file-rewrites.js";

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
  // Available in the installed host. Each test or embedded host chooses its file edge.
  readonly openRecording?: (file: string) => Promise<RecordingFile>;
  readonly accountHome: () => string;
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
  readonly claudeInput: (launcher: Pick<Launcher, "launch">) => ClaudeInputEdge;
  readonly barPaneEdge: (launcher: Launcher) => BarPaneEdge;
  // [LAW:one-source-of-truth] The host uses one key to publish and admit
  // terminal clicks.
  readonly linkKey: () => Asked<Buffer>;
  // What the memory backstop reads and writes on the machine.
  readonly limits: (own: {
    readonly startedAtMs: number;
    readonly exit: (code: number) => void;
    readonly launcher: Launcher;
    readonly log: DaemonLogger;
  }) => LimitsDeps;
  // A worktree bundle's executable entry at the host's filesystem boundary.
  readonly rendererEntryOf?: (reported: string) => string;
  // How the binary watch reads the bundle's mtime.
  readonly stat: BundleStat;
  readonly checkoutFiles: CheckoutFiles;
  readonly writeConfigFile: WriteConfigFile;
}

// What a daemon takes from the process that runs it: where its files are, what
// it does to the machine, and the numbers it runs by.
export interface DaemonInputs extends DaemonAdapters {
  readonly region: RendererBoot["region"];
  // The composition root selects the renderer transport.
  readonly renderer: RendererPort;
  readonly bundle: RunningBundle;
  // The renderer it serves, whose profile its stores are.
  readonly rendererName: RendererName;
  // The running entry can differ from the bundle's module path under a loader.
  readonly rendererEntry?: string;
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
  // What its tasks throw lands in the inbox it carries, which every bar shows.
  readonly clock: ReportingClock;
  // [LAW:single-enforcer] The process's one death funnel: the binary watch and
  // the memory backstop end the daemon here, never on their own.
  readonly exit: (code: number) => void;
}

interface DaemonClose {
  readonly settled: Promise<Settled>;
}

interface DaemonResources {
  readonly stats: RuntimeStats;
  readonly launcher: Launcher;
  readonly log: DaemonLogger;
  readonly memoryLimitBytes: number;
  readonly clock: Timekeeper;
  readonly exit: DaemonInputs["exit"];
  // [LAW:no-ambient-temporal-coupling] Teardown settles before launch reaping,
  // which carries its own outcome. Repeat callers share both waits.
  close(): Promise<DaemonClose>;
}

// [LAW:types-are-the-program] Losing the socket bind only needs these resources.
// A request-capable daemon is produced after loading the stores and renderer.
export interface PreparedDaemon extends Pick<
  DaemonResources,
  "launcher" | "close"
> {
  serve(): ServedDaemon;
}

export interface ServedDaemon extends DaemonResources {
  readonly handle: (
    inbound: Inbound,
    timedOut: () => boolean,
    accepted: Acceptance,
    clientLeft: () => boolean,
  ) => Promise<HandledRequest>;
  // The site's in-process request path past the connection's checkpoint.
  readonly reply: (
    req: ReplyRequest,
    timedOut: () => boolean,
    accepted: Acceptance,
    clientLeft: () => boolean,
  ) => Promise<Reply>;
  readonly subscribe: FrameFeeds<CheckedRenderRequest>["subscribe"];
  // The site resets a simulated file that its watches cannot hear.
  readonly rediscover: () => void;
  // Only the socket owner arms production watchers and the renderer process.
  arm(): void;
}

// [LAW:one-source-of-truth] Draining seals admission immediately. The journal
// barrier lets earlier clicks finish before closing cancels their launches.
type DaemonPhase =
  | { readonly kind: "building" | "built" | "starting" | "serving" | "armed" }
  | {
      readonly kind: "draining" | "closing" | "closed";
      readonly done: Promise<DaemonClose>;
    };

export function createDaemon(inputs: DaemonInputs): PreparedDaemon {
  const { bundle, memoryLimitBytes, clock, exit, paths, host } = inputs;
  // Parsed once, here, and handed to everything that loads a config.
  const locs = locations(host);
  const instant = (): Instant => instantAt(clock);
  let phase: DaemonPhase = { kind: "building" };
  const currentPhase = (): DaemonPhase => phase;
  const serving = (): boolean =>
    phase.kind === "serving" || phase.kind === "armed";
  const cancelling = (): boolean =>
    phase.kind === "closing" || phase.kind === "closed";
  // [LAW:effects-at-boundaries] Render waits end with admission. Launches
  // already in flight can finish through the journal barrier.
  const cancelRenders = new AbortController();
  const cancelWork = new AbortController();
  const log: DaemonLogger = (level, msg) =>
    inputs.daemonLog.log(
      level,
      phase.kind === "closed" ? `after close: ${msg}` : msg,
    );
  // [LAW:one-source-of-truth] one cache instance per daemon process — multiple
  // instances would defeat the share-across-sessions invariant.
  const stats = new RuntimeStats(clock);
  const recordings =
    inputs.openRecording &&
    new RendererRecordings(inputs.openRecording, log, clock.detach);
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
  // world state carries them: whether file events are heard, what the
  // launcher stands behind, and the events held. Restated whenever any may
  // have moved, and compared whole, so a restatement that moved nothing moves
  // no document.
  // [LAW:no-ambient-temporal-coupling] Declared before the launcher, whose
  // observer restates them.
  const daemonFaults = observable.box<DaemonFacts>(
    { fileEvents: [], launcher: null, held: [] },
    { deep: false, equals: compareStructural },
  );
  // [LAW:one-source-of-truth] The daemon's own events, each held until no bar
  // can show it: each pipe event of a launched program, how the last renderer
  // process ended, the acts that failed with no session's bar to hold them,
  // and what each of the daemon's tasks threw.
  // [LAW:no-ambient-temporal-coupling] The launcher's factory may report a
  // warning before its launcher can be read. The initial restatement reads
  // it once the launcher exists.
  const restateOnceBuilt = (): void => {
    if (phase.kind !== "building") restateFaults();
  };
  // [LAW:one-source-of-truth] A pipe event is stamped on the clock every
  // render holds events against: the family stamps each event it shows.
  const launchPipes = new RecurringEvents<string>(
    clock,
    "launch-pipes",
    (text) => text,
    (text, more, at) => joinedEvent(null, `${text}${recurrence(more)}`, at),
    restateOnceBuilt,
  );
  const rendererEnded = new HeldSlot(clock, "renderer end hold", restateFaults);
  const actFailed = new HeldSlot(clock, "act failure hold", restateFaults);
  // [LAW:one-source-of-truth] Each task's error is the one event its subject
  // holds. It is logged in full whenever it is shown on every bar.
  const taskThrows = new RecurringEvents<ReportedThrow>(
    clock,
    "task-threw",
    (reported) => reported.task,
    (reported, more, at) => {
      const { shown, logged } = thrownText(reported, more);
      log("error", logged);
      // A thrown message can carry a launched command's output, and nothing
      // here can tell which do, so each refuses a recording while it shows.
      return environmentOutput(joinedEvent(null, shown, at), true);
    },
    restateFaults,
  );
  // A kind that holds one event at a time is about itself.
  const heldBy = (
    kind: "renderer-ended" | "act-failed",
    slot: HeldSlot,
  ): DaemonEvent[] => {
    const event = slot.event();
    return event === null ? [] : [{ kind, about: kind, event }];
  };
  function restateFaults(): void {
    runInAction(() =>
      daemonFaults.set({
        fileEvents: fileEventsWarnings(fileEvents.delivery()),
        launcher: launcher.standing(),
        held: [
          ...launchPipes.held(),
          ...heldBy("renderer-ended", rendererEnded),
          ...heldBy("act-failed", actFailed),
          ...taskThrows.held(),
        ],
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
    signal: cancelWork.signal,
    // [LAW:no-silent-failure] Each change in whether what the daemon launches
    // dies with it, and each pipe event, is said in daemon.log, and every
    // session's world state carries it, so its warning comes on frames too.
    observeWarnings: (change) => {
      if (change.kind === "launch-pipes") {
        log("warn", change.text);
        launchPipes.occur(change.text);
        return;
      }
      log(
        change.fault === null ? "info" : "warn",
        change.fault === null
          ? "launch lifeline running again"
          : `launch lifeline ${change.fault}; the next launch starts another`,
      );
      restateOnceBuilt();
    },
  });
  // [LAW:single-enforcer] Both client writers acknowledge events at the
  // owner of the daemon's latest occurrences, independent of their renderer.
  const acknowledgeDisplayed = (shown: readonly DaemonEvent[]): void => {
    let changed = false;
    for (const shownEvent of shown) {
      switch (shownEvent.kind) {
        case "launch-pipes":
          if (launchPipes.answer(shownEvent.about, shownEvent.event))
            changed = true;
          break;
        case "renderer-ended":
          if (rendererEnded.answer(shownEvent.event)) changed = true;
          break;
        case "act-failed":
          if (actFailed.answer(shownEvent.event)) changed = true;
          break;
        case "task-threw":
          if (taskThrows.answer(shownEvent.about, shownEvent.event))
            changed = true;
          break;
        default:
          shownEvent satisfies never;
      }
    }
    // [LAW:dataflow-not-control-flow] Writers can confirm independently;
    // publish new facts only when the first confirmation changes an owner.
    if (changed) restateFaults();
  };
  // [LAW:no-silent-failure] What the clock's tasks threw, taken as it comes,
  // those thrown before this daemon was built included. A task's first throw
  // is logged in full and held on every bar. One while its error is held is
  // counted, whatever it says, so a task failing on every tick moves no bar
  // and writes no line. When the hold ends with throws counted, the latest
  // is held and logged with their count, so a still-failing task shows and
  // logs once a hold.
  const taken = (reported: ReportedThrow): void => {
    stats.tasksThrew++;
    taskThrows.occur(reported);
  };
  // [LAW:no-silent-failure] Taking a throw cannot throw back into the task
  // that threw it: a failure here is logged beside the throw it was taking.
  clock.throws.attach((reported) => {
    try {
      taken(reported);
    } catch (failure) {
      log(
        "error",
        `taking what ${reported.task} threw failed: ${failureOf(failure).detail}; it threw: ${failureOf(reported.thrown).detail}`,
      );
    }
  });
  const linkSigner = linkSignerOver(inputs.linkKey);
  const publishFrame = publishingFrames(linkSigner);
  const sessionBook = new SessionBook(inputs.sessionBook(log));
  // [LAW:no-ambient-temporal-coupling] Prepare the primary before any host
  // provider installs a timer. A failing profile or renderer factory leaves
  // the daemon unbuilt and nothing to close.
  const primaryPrepared = prepareRenderer(
    inputs.rendererName,
    bundle.path,
    inputs.rendererEntry ?? bundle.path,
  );
  const renderers = new Map<RendererName, RendererRuntime>();
  // [LAW:one-source-of-truth] A session's accepted render request selects
  // the renderer that receives its subsequent world state and viewer inputs.
  const routes = new Map<
    SessionId,
    { readonly name: RendererName; readonly order: RequestId }
  >();
  const nameOf = (session: SessionId): RendererName =>
    routes.get(session)?.name ?? inputs.rendererName;
  const viewersOf = (name: RendererName, viewers: Viewers): Viewers =>
    Object.fromEntries(
      Object.entries(viewers).filter(
        ([session]) => nameOf(session as SessionId) === name,
      ),
    );
  // [LAW:effects-at-boundaries] Only the daemon that won the socket arms its limits.
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
    renderer: () => (serving() ? primary.link.process() : null),
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
  const payloadProviders = createPayloadProviders({
    launcher,
    host,
    watchers: watcherRegistry,
    fileEvents,
    clock,
    logger: log,
    ledger: refreshLedger,
    sourceRuns,
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
  const programs = (edge: Pick<Launcher, "launch">) => ({
    launch: clickLaunchVia(edge),
    claudeInput: inputs.claudeInput(edge),
  });
  const desktopPrograms = programs(launcher);
  const acts = new Acts({
    detach: clock.detach,
    programsFor: (session) => {
      // Fixed desktop tools also serve sessionless links, old clients and
      // links opened before a restarted host hears from the session again.
      // Runs and SourceRuns require a report for user-configured programs.
      const context =
        session === null ? null : sessionBook.programContextOf(session);
      if (context === null) return desktopPrograms;
      return programs({
        launch: (options) => launcher.launch({ ...options, ...context }),
      });
    },
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
    // [LAW:single-enforcer] The pane queue reads the same phase as ingress
    // before any new operation reaches tmux.
    closing: () => !serving(),
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
    publishFrame,
    acknowledgeDisplayed,
    requestChanged: (session, previous) =>
      declaredBarPanes.reported(session, previous?.hints.tmux ?? null),
    shown: (req) => paneVisibility.shown(req.hints.tmux),
    watching: () => paneVisibility.follow(),
    deliver: async (make) => {
      const sent = await Promise.all(
        [...renderers.values()].map(({ renderer }) =>
          renderer.deliver(
            () => ({
              kind: "event",
              event: {
                kind: "viewers",
                viewers: viewersOf(renderer.name, make()),
              },
            }),
            [],
          ),
        ),
      );
      return sent.find((turn) => turn.kind === "threw") ?? { kind: "answered" };
    },
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
  const collector = new Collector<CheckedRenderRequest>({
    owners: payloadProviders,
    daemon: () => daemonFaults.get(),
    clock,
    watched: (sessionId) => frameFeeds.isWatched(sessionId),
    deliver: (event) => {
      const session =
        event.kind === "retire" ? event.session : event.worldState.session;
      const route = routes.get(session);
      const renderer = (renderers.get(nameOf(session)) ?? primary).renderer;
      return renderer
        .deliver(() => ({ kind: "event", event }), [])
        .finally(() => {
          if (event.kind === "retire" && routes.get(session) === route)
            routes.delete(session);
        });
    },
    log,
  });

  const checkouts = checkoutObservations(inputs.checkoutFiles, clock);
  const configDiscovery = new ConfigDiscovery({
    locations: locs,
    stateDir: paths.state,
    watchers: watcherRegistry,
    files: checkouts.discovery,
    clock,
    log,
    moved: (name, origins) => renderers.get(name)?.renderer.moved(origins),
    reloaded: (folders) => managedStorage.recheck(folders),
  });

  interface RendererRuntime {
    readonly reported: string;
    readonly entry: string;
    readonly stores: HeldStores;
    readonly link: RendererLink;
    readonly renderer: RendererHost;
  }
  const declared = new Map<
    RendererName,
    Pick<Subscriptions, "sources" | "lanes"> & {
      readonly managedFolders: ReadonlySet<string>;
    }
  >();
  const aggregate = (): void => {
    const sources: Record<SessionId, Subscriptions["sources"][SessionId]> = {};
    const lanes: Record<SessionId, Subscriptions["lanes"][SessionId]> = {};
    const folders = new Set<string>();
    // [LAW:one-source-of-truth] A whole declaration only replaces its own
    // renderer's part. Shared providers see the current owner's demands.
    for (const [name, subscription] of declared) {
      for (const folder of subscription.managedFolders) folders.add(folder);
      for (const [id, values] of Object.entries(subscription.sources)) {
        if (nameOf(id as SessionId) !== name) continue;
        // [LAW:single-enforcer] A source read uses this renderer's admitted
        // folders. Another renderer holding the same path confers no access.
        sources[id as SessionId] = values.filter(
          (source) =>
            source.kind !== "plugin" ||
            subscription.managedFolders.has(source.folder),
        );
      }
      for (const [id, values] of Object.entries(subscription.lanes))
        if (nameOf(id as SessionId) === name) lanes[id as SessionId] = values;
    }
    managedStorage.follow(folders);
    collector.subscribed({ sources });
    frameFeeds.switched(lanes);
    declaredBarPanes.declare(lanes);
  };

  function prepareRenderer(
    name: RendererName,
    reported: string,
    entry: string,
  ) {
    const stores = new HeldStores(inputs.profile(name, log), log);
    // [LAW:one-source-of-truth] Each start reads the latest held profile.
    const boot = (): RendererBoot => ({
      stored: stores.current(),
      locations: locs,
      region: inputs.region,
      memoryLimitBytes,
    });
    const prepared = inputs.renderer({
      name,
      entry,
      boot,
      recording: () => recordings?.generation(name),
      node: bundle.node,
    });
    return { name, reported, entry, stores, prepared };
  }

  const connectRenderer = ({
    name,
    reported,
    entry,
    stores,
    prepared,
  }: ReturnType<typeof prepareRenderer>): RendererRuntime => {
    const link = prepared.start({
      log,
      clock,
      // [LAW:no-ambient-temporal-coupling] Start heads this renderer's
      // mailbox and only rebuilds the sessions currently routed to it.
      start: async () => {
        if (!serving()) return;
        const started = await renderer.start(() => {
          const viewers = frameFeeds.viewers();
          if (renderers.size === 1) frameFeeds.handedIn(viewers);
          return {
            kind: "event",
            event: {
              kind: "start",
              viewers: viewersOf(name, viewers),
              sessions: collector
                .liveSessions()
                .filter(
                  ({ worldState }) => nameOf(worldState.session) === name,
                ),
            },
          };
        }, [["why", "renderer-start"]]);
        if (started.kind === "threw") {
          frameFeeds.handedIn(null);
          throw new CrossedFailure(started.failure);
        }
        // A start reaches only one renderer. A missed delivery to another
        // renderer stays owed until it has received the aggregate announcement.
        if (renderers.size > 1) frameFeeds.announce();
      },
      ended: (event) => {
        // [LAW:types-are-the-program] A later exit can have the same text and
        // instant as an earlier one, even as an old reply is still writing.
        rendererEnded.hold({
          ...event,
          revision: (rendererEnded.event()?.revision ?? 0) + 1,
        });
        restateFaults();
      },
    });
    const renderer = rendererHost(
      name,
      clock,
      link.renderer,
      log,
      {
        subscribed: (subscriptions) => {
          const managedFolders = configDiscovery.admitManagedFolders(
            name,
            subscriptions.managedFolders,
            declared.get(name)?.managedFolders,
          );
          declared.set(name, {
            sources: subscriptions.sources,
            managedFolders,
            lanes: subscriptions.lanes,
          });
          aggregate();
        },
        frames: (frames, settled) => {
          const routed = frames.filter((frame) => {
            if (nameOf(frame.session) === name) return true;
            settled(frame, false);
            return false;
          });
          frameFeeds.took(name, routed, settled);
        },
        stored: (writes) => stores.take(writes),
        holding: (session) => collector.holding(session),
        recorded: () => {},
      },
      {
        authorizeRun: (request, captures) =>
          authorizeRun(linkSigner, request, captures),
        perform: (act) => acts.perform(act),
        stateDir: paths.state,
        configs: configDiscovery.forRenderer(name),
        writeConfigFile: inputs.writeConfigFile,
        closing: cancelling,
        acknowledgeDisplayed,
        unheard: (text, fromEnvironment) => {
          // The unacknowledged text is included in the next warning.
          const prior = actFailed.event();
          actFailed.hold(
            environmentOutput(
              joinedEvent(prior, text, instant()),
              fromEnvironment === true ||
                (prior !== null &&
                  !prior.answered &&
                  isEnvironmentOutput(prior)),
            ),
          );
          restateFaults();
        },
      },
    );
    return { reported, entry, stores, link, renderer };
  };

  const primary = connectRenderer(primaryPrepared);
  renderers.set(inputs.rendererName, primary);

  // [LAW:effects-at-boundaries] Resolve and validate a worktree bundle here,
  // once on its admission. Ordinary statusline ticks only find the binding.
  const canonicalEntry = (name: RendererName, bundlePath: string): string => {
    try {
      if (inputs.rendererEntryOf === undefined)
        throw new Error("this host has no process entry resolver");
      return inputs.rendererEntryOf(bundlePath);
    } catch (error) {
      throw new BadVerbArgs(
        `renderer ${name} bundle ${JSON.stringify(bundlePath)}: ${String(error)}`,
      );
    }
  };

  const rendererFor = (
    request: CheckedRenderRequest,
    environment: SessionEnvironment,
    order: RequestId,
  ): RendererHost => {
    const session = request.hookData.session_id;
    const route = routes.get(session);
    const asked =
      environment.kind === "ok"
        ? variableOf(environment.value, "CC_CANDYBAR_NAME")
        : null;
    const client = request.hints.client;
    // A frames client can forward Claude Code's input itself. An explicit
    // name selects a renderer as on any statusline request; an unnamed
    // frames client continues drawing the session it is following.
    let name =
      client?.kind === "frames" && route !== undefined
        ? route.name
        : inputs.rendererName;
    if (asked?.kind === "ok") {
      try {
        name = rendererNameOf(asked.value);
      } catch (error) {
        throw new BadVerbArgs(`CC_CANDYBAR_NAME: ${String(error)}`);
      }
    }
    if (route !== undefined && route.name !== name && route.order > order)
      throw new BadVerbArgs(
        `session ${session} has already moved to renderer ${route.name}`,
      );

    let target = renderers.get(name);
    const binding = asked?.kind === "ok" ? client?.bundle : undefined;
    if (target === undefined) {
      if (binding === undefined)
        throw new BadVerbArgs(
          `renderer ${name} needs a statusline client's bundle`,
        );
      target = connectRenderer(
        prepareRenderer(name, binding, canonicalEntry(name, binding)),
      );
      target.stores.load();
      target.link.serve();
      renderers.set(name, target);
      if (phase.kind === "armed") target.link.arm();
    } else if (
      binding !== undefined &&
      binding !== target.reported &&
      binding !== target.entry &&
      canonicalEntry(name, binding) !== canonicalEntry(name, target.entry)
    ) {
      throw new BadVerbArgs(
        `renderer ${name} is bound to ${JSON.stringify(target.entry)}`,
      );
    }

    if (route === undefined || order >= route.order) {
      routes.set(session, { name, order });
      if (route !== undefined && route.name !== name) {
        // Routing changes the aggregate even when neither renderer's
        // declarations moved. Apply the existing plans under the new owner.
        aggregate();
        const former = renderers.get(route.name);
        if (former !== undefined)
          clock.detach(
            `renderer ${former.renderer.name} retire ${session}`,
            () =>
              former.renderer.deliver(
                () => ({
                  kind: "event",
                  event: { kind: "retire", session },
                }),
                [["why", "renderer-moved"]],
              ),
          );
        frameFeeds.handedIn(null);
        frameFeeds.announce();
      }
    }
    return target.renderer;
  };

  const parts: DaemonParts = {
    recordRenderer: (command) => {
      if (recordings === undefined)
        throw new BadVerbArgs("recording is unavailable on this host");
      return recordings.request(command, (name, operation) => {
        const runtime = renderers.get(name);
        return runtime === undefined
          ? operation()
          : runtime.renderer.recordingBoundary(() =>
              operation(() => runtime.link.restart()),
            );
      });
    },
    accountHome: inputs.accountHome,
    closing: cancelRenders.signal,
    home: host.home,
    launcher,
    log,
    clock,
    checkoutLocation: checkouts.location,
    bundle: bundle.path,
    sourceDigest: bundle.digest,
    sessionBook,
    stats,
    linkSigner,
    publishFrame,
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
    renderer: primary.renderer,
    // [LAW:single-enforcer] Only a render request binds or starts a bundle.
    rendererForClick: (name) => renderers.get(name)?.renderer,
    rendererFor,
  };

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
  // [LAW:single-enforcer] All request-capable entry points share the same
  // admission phase. A subscription can race close after its wire admission.
  const admit = <T>(run: () => T, refuse: () => T): T =>
    serving() ? run() : refuse();
  const served: ServedDaemon = {
    stats,
    launcher,
    log,
    memoryLimitBytes,
    clock,
    exit,
    close,
    handle: (req, timedOut, accepted, clientLeft) =>
      admit(
        () => handleRequest(parts, req, timedOut, accepted, clientLeft),
        () => Promise.resolve(refuseClosingInbound(parts, req, accepted)),
      ),
    reply: (req, timedOut, accepted, clientLeft) =>
      admit(
        () => replyTo(parts, req, timedOut, accepted, clientLeft),
        () => Promise.resolve(refuseClosingReply(parts, req.kind, accepted)),
      ),
    subscribe: (sessionId, subscriber) =>
      admit(
        () => frameFeeds.subscribe(sessionId, subscriber),
        () => {
          log(
            "info",
            `feed sid=${JSON.stringify(sessionId)} refused lane=${subscriber.lane} daemon-closed`,
          );
          subscriber.refused(
            failedWith(new DaemonClosing("subscribe").message),
          );
          return () => {};
        },
      ),
    rediscover: () =>
      admit(
        () => configDiscovery.again("asked"),
        () => {},
      ),
    arm() {
      if (!serving()) throw new DaemonClosing("arm");
      if (phase.kind === "armed") return;
      phase = { kind: "armed" };
      fileEvents.start(paths.watchProbe);
      binaryWatch.arm();
      limits.arm();
      for (const { link } of renderers.values()) link.arm();
    },
  };
  phase = { kind: "built" };

  function serve(): ServedDaemon {
    if (serving()) return served;
    if (phase.kind !== "built") throw new DaemonClosing("serve");
    const starting: DaemonPhase = { kind: "starting" };
    phase = starting;
    try {
      primary.stores.load();
      sessionBook.load();
      if (currentPhase() !== starting) throw new DaemonClosing("serve");
      primary.link.serve();
      if (currentPhase() !== starting) throw new DaemonClosing("serve");
      phase = { kind: "serving" };
      return served;
    } catch (error) {
      if (currentPhase() === starting) phase = { kind: "built" };
      throw error;
    }
  }

  function close(): Promise<DaemonClose> {
    if ("done" in phase) return phase.done;
    // [LAW:no-ambient-temporal-coupling] Publish the shared close before any
    // teardown step can call back into the daemon.
    const done: Promise<DaemonClose> = Promise.resolve().then(() =>
      tearDown(done),
    );
    phase = { kind: "draining", done };
    cancelRenders.abort(new DaemonClosing("render"));
    return done;
  }

  async function tearDown(done: Promise<DaemonClose>): Promise<DaemonClose> {
    const attached = [...renderers.values()];
    const draining: RendererHost[] = [];
    // [LAW:no-ambient-temporal-coupling] Stop new wakes and starts before
    // draining. The link's transition decides which renderers can still take
    // the journal and view pushes. Booting or down links have neither to close.
    await runTeardown(
      [
        ...attached.map(
          ({ renderer }): TeardownStep => [
            `${renderer.name} wakes close`,
            () => renderer.closeWake(),
          ],
        ),
        ...attached.map(
          ({ renderer, link }): TeardownStep => [
            `${renderer.name} close begins`,
            () => {
              if (link.beginClose() === "closing") draining.push(renderer);
            },
          ],
        ),
      ],
      log,
    );
    const rendererSteps = (
      kind: "close-journal" | "close-views",
    ): TeardownStep[] =>
      draining.map((renderer) => [
        `${renderer.name} ${kind}`,
        () => renderer.command({ kind }),
      ]);
    // The stores still flush after a close failed (runTeardown).
    const teardown: readonly TeardownStep[] = [
      // [LAW:no-ambient-temporal-coupling] In the mailbox's arrival order:
      // every click ahead of it lands whole, and none behind it begins.
      ...rendererSteps("close-journal"),
      // [LAW:no-ambient-temporal-coupling] Nothing launches from here on, what
      // is in flight is terminated, whichever owner's work it was, and the
      // launcher's lifeline goes.
      [
        "launches abort",
        () => {
          phase = { kind: "closing", done };
          cancelWork.abort(new DaemonClosing("work"));
        },
      ],
      ["frameFeeds close", () => frameFeeds.close()],
      ["binaryWatch close", () => binaryWatch.close()],
      ["limits disarm", () => limits.disarm()],
      // Before the sources and the storage its states hold.
      ["collector close", () => collector.close()],
      // Before the views close: a `config` made after it finds its origin
      // let go, and hands the closed cache nothing.
      ["configDiscovery close", () => configDiscovery.close()],
      ...rendererSteps("close-views"),
      ...payloadProviders.closes,
      ["runs close", () => runs.close()],
      // After the collector, which holds every session's runs: its close
      // releases them first, so this close drops nothing still held.
      ["sourceRuns close", () => sourceRuns.close()],
      ["fileEvents close", () => fileEvents.close()],
      ["watcherRegistry close", () => watcherRegistry.closeAll()],
      // Last of the stores' writers: a run that ends in the teardown holds
      // its click error first.
      ...attached.map(
        ({ renderer, stores }): TeardownStep => [
          `${renderer.name} stores close`,
          () => stores.close(),
        ],
      ),
      ["sessionBook close", () => sessionBook.close()],
      ["renderer recordings close", () => recordings?.close()],
      // [LAW:no-ambient-temporal-coupling] A closed daemon holds no events: a
      // throw from here on is logged as it comes, and each slot lets go as it
      // would at its hold's end, so a throw counted and not yet shown is
      // logged now.
      [
        "held events close",
        () => {
          clock.throws.close((reported) =>
            log("error", thrownText(reported).logged),
          );
          for (const slot of [
            launchPipes,
            rendererEnded,
            actFailed,
            taskThrows,
          ])
            slot.dispose();
        },
      ],
      ...attached.map(
        ({ renderer, link }): TeardownStep => [
          `${renderer.name} renderer close`,
          () => link.close(),
        ],
      ),
    ];
    await runTeardown(teardown, log);
    phase = { kind: "closed", done };
    return { settled: launcher.settled() };
  }

  return { launcher, close, serve };
}

// [LAW:one-source-of-truth] The daemon's draw and reply parts, built in a jest
// worker on a held clock without booting a daemon: every part the request
// handling reads is the daemon's own kind, composed as src/daemon/daemon.ts
// composes it, over a launcher a case scripts and a home of the case's. How
// one part is wired to another is the daemon's own (the composers
// src/daemon/daemon.ts exports), so the parts cannot wire them apart from it;
// what is written here is which edge each part runs over. A case reads a draw
// through the daemon's reply (`replyTo`) and its feed (`renderFrame`).
//
// Every launch goes to a fake spawner under the real launcher, the session
// store and histories are held in memory, nothing is armed (the memory
// backstop, the bundle and update watches, file-event delivery), the update
// notice's registry refuses, and the doctor's and Claude Code's edges are the
// click context's stand-ins (test/helpers/click.ts), which throw if a click
// reaches them. The disk is real: the parts read, write and watch the case's
// home, as the daemon does its own.

import path from "node:path";

import { FileEventDelivery } from "../../src/daemon/cache/file-events";
import { renderCacheBudget } from "../../src/daemon/cache/render";
import { WatcherRegistry } from "../../src/daemon/cache/watchers";
import {
  bundleWatches,
  closeDaemon,
  followFileEvents,
  launcherWarningsSaid,
  partsDraw,
  sessionFrameFeeds,
  sessionLaneSetups,
  sessionMenuIdle,
  sessionPaneVisibility,
  sessionRenderCache,
  sessionRuns,
  sessionTmuxStatusLines,
  verbsOverParts,
} from "../../src/daemon/daemon";
import type { DaemonParts } from "../../src/daemon/daemon-parts";
import { renderFrame } from "../../src/daemon/draw-bar";
import { FEED_PERIODS, type FeedFrame } from "../../src/daemon/frame-feed";
import { homeOf } from "../../src/daemon/home";
import { JournalTurns } from "../../src/daemon/journal-turns";
import { heldSessionUnder, productionLaneEdge } from "../../src/daemon/lane-edge";
import { linkIdAllocator } from "../../src/daemon/link-id-allocator";
import { makeLimits, memoryLimitBytes, realLimitsDeps } from "../../src/daemon/limits";
import { MismatchRuns } from "../../src/daemon/mismatch-runs";
import { NavigationHistory } from "../../src/daemon/navigation-history";
import { daemonPaths, locations } from "../../src/daemon/paths";
import { createPayloadProviders } from "../../src/daemon/payload-providers";
import type { ProcessProbe } from "../../src/daemon/process-fingerprint";
import type { CheckedRenderRequest } from "../../src/daemon/render-checkpoint";
import { RenderSightings } from "../../src/daemon/render-sightings";
import { RenderWarningRecords } from "../../src/daemon/render-warnings";
import {
  sessionSource,
  type SessionSource,
  type SessionSourceDeps,
} from "../../src/daemon/session-source";
import { SessionState } from "../../src/daemon/session-state";
import { SettingsHistory } from "../../src/daemon/settings-history";
import { RuntimeStats } from "../../src/daemon/stats";
import { newUpdateFact } from "../../src/daemon/update-fact";
import type { SourceOf } from "../../src/daemon/cache/render";
import { systemFilesystem } from "../../src/disk/system-filesystem";
import { ProbeArrivals } from "../../src/doctor/handler-probe";
import { stableAttachPreload } from "../../src/install/index";
import { EffectSessions } from "../../src/render/effect";
import type { RenderedLine } from "../../src/dsl/node-registry";
import type { GitEnvAsk } from "../../src/git-env";
import type { Host } from "../../src/host";
import { offlinePricing } from "../../src/segments/pricing";
import { instantAt } from "../../src/utils/instant";
import type { DaemonLogger } from "../../src/utils/logger";
import { RefreshLedger } from "../../src/utils/refresh-ledger";
import { SourceRuns } from "../../src/var-system/source-runs";
import { testVerbContext } from "./click";
import { fakeLauncher, type FakeLauncher } from "./fake-launcher";
import { bareGates } from "./gates";
import type { HeldClock } from "./held-clock";
import { bundleAt, NO_TMUX_AT_EXIT } from "./worker-edges";
import { TEST_SIGNER } from "./link-signer";

export interface DaemonPartsOptions {
  // The machine the parts run on: the renderer's home and Claude Code's
  // records under its home, and its temporary directory.
  readonly host: Host;
  readonly clock: HeldClock;
  // Every line the daemon's work logs.
  readonly log: DaemonLogger;
  // What every session's view draws from, over the daemon's own inputs to it:
  // the daemon's session source unless the case puts its own over them.
  readonly source?: (
    inputs: SessionSourceDeps,
  ) => SourceOf<SessionSource, CheckedRenderRequest>;
  // Each frame a feed drew, as it drew it.
  readonly drew?: (frame: FeedFrame | null) => void;
  // What git named at the daemon's start: an ask that answered with nothing
  // to drop unless the case is about the ask.
  readonly gitEnv?: GitEnvAsk;
}

export interface BuiltParts {
  readonly parts: DaemonParts;
  // Where the case says what each program does, and reads what was started.
  readonly launcher: FakeLauncher;
  // The daemon's own teardown, over everything the parts hold.
  readonly close: () => void;
}

// No process the parts ask after is running, and none has a start time to
// read: a pid a case means to be Claude Code's is one its record names.
const NO_PROCESSES: ProcessProbe = {
  alive: () => false,
  startTime: async () => ({ kind: "unavailable", detail: "no process table in this test" }),
};

export function daemonParts({
  host,
  clock,
  log,
  source,
  drew,
  gitEnv = { kind: "asked", names: [] },
}: DaemonPartsOptions): BuiltParts {
  const home = homeOf(host);
  const paths = daemonPaths(home);
  const locs = locations(host, home);
  const instant = () => instantAt(clock);
  const closing = new AbortController();
  const memoryLimit = memoryLimitBytes(host.env);
  const exit = (code: number): never => {
    throw new Error(`the daemon's parts asked to exit ${code}`);
  };
  const stats = new RuntimeStats(clock);
  const launched = fakeLauncher(clock, {
    inherited: host.env,
    stats: stats.launchStats,
    signal: closing.signal,
    now: instant,
    observeWarnings: launcherWarningsSaid(log, () => frameFeeds),
  });
  const { launcher } = launched;
  // The bundle the parts run, as the daemon's process entry hands it in.
  const running = bundleAt(path.join(paths.state, "checkout"));
  const bundle = running.path;
  // [LAW:single-enforcer] The store is held by the journal's turns, as the
  // daemon's is, so a write outside a turn throws here too.
  const journalTurns = new JournalTurns();
  const sessionState = new SessionState(journalTurns);
  const settingsHistory = new SettingsHistory(systemFilesystem, sessionState, log);
  const gates = bareGates();
  const limits = makeLimits({
    ...realLimitsDeps(stats.startedAt.getTime(), exit, {
      launcher,
      log,
      clock,
      snapshotDir: paths.state,
      writeLogNow: () => {},
    }),
    limitBytes: memoryLimit,
  });
  const handlerProbes = new ProbeArrivals();
  const renderSightings = new RenderSightings();
  const watcherRegistry = new WatcherRegistry({
    filesystem: systemFilesystem,
    clock,
    counters: stats,
    logger: log,
  });
  const refreshLedger = new RefreshLedger(log);
  const fileEvents = new FileEventDelivery({ watchers: watcherRegistry, logger: log, clock });
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
    pricing: offlinePricing(),
    watchers: watcherRegistry,
    fileEvents,
    clock,
    logger: log,
    ledger: refreshLedger,
  });
  const { managedStorage } = payloadProviders;
  const navigationHistory = new NavigationHistory();
  const effectSessions = new EffectSessions<RenderedLine>();
  const menuIdle = sessionMenuIdle(() => parts, { clock, now: instant, log });
  const links = { to: home.name, signer: TEST_SIGNER };
  const runs = sessionRuns({ managedStorage, launcher, log, clock });
  const heldSession = heldSessionUnder(host.home);
  // The edges a click or a lane would reach the machine through, each the
  // click context's stand-in, which throws if one reaches it. Taken by name,
  // so every other verb field is the builder's to wire and the typecheck says
  // so. [LAW:one-source-of-truth] The one claude-input edge goes to both the
  // verbs and the lane edge, as src/daemon/daemon.ts hands its own.
  const { doctor, doctorStores, claudeInput } = testVerbContext(
    sessionState,
    settingsHistory,
    undefined,
    host,
    journalTurns,
  );
  const laneSetups = sessionLaneSetups(() => parts, journalTurns, {
    edge: productionLaneEdge(
      launcher,
      (sessionId) => frameFeeds.following(sessionId),
      closing.signal,
      clock,
      NO_PROCESSES,
      heldSession,
      systemFilesystem,
      claudeInput,
    ),
    host: { bundle, node: running.node, home, preload: stableAttachPreload(bundle, host) },
    log,
  });
  const tmuxStatusLines = sessionTmuxStatusLines(() => parts, {
    launcher,
    heldSession,
    home,
    owner: paths.socket,
    bundle: running,
    signer: TEST_SIGNER,
    log,
  });
  const linkIds = linkIdAllocator({
    file: paths.linkIds,
    clock,
    retryMs: FEED_PERIODS.still,
    log,
  });
  const paneVisibility = sessionPaneVisibility(() => parts, { launcher, clock, log });
  const frameFeeds = sessionFrameFeeds(() => parts, {
    render: (sessionId, fps, at) => {
      const frame = renderFrame(parts, sessionId, fps, at);
      drew?.(frame);
      return frame;
    },
    visibility: paneVisibility,
    linkIds,
    clock,
    instant,
    log,
  });
  const renderWarnings = new RenderWarningRecords();
  const updateFact = newUpdateFact();
  const { cache: renderCache, recorder } = sessionRenderCache({
    clock,
    stateDir: paths.state,
    locations: locs,
    sessionState,
    watchers: watcherRegistry,
    log,
    links,
    gates,
    providers: payloadProviders,
    updateFact,
    sourceRuns,
    history: settingsHistory,
    navigation: navigationHistory,
    source: source ?? sessionSource,
    budgetBytes: () => renderCacheBudget(memoryLimit),
    wake: (sessionId, cause) => frameFeeds.wake(sessionId, cause),
  });
  followFileEvents({ fileEvents, watcherRegistry, renderCache, frameFeeds });
  const { binaryWatch, updateWatch } = bundleWatches({
    clock,
    launcher,
    probe: NO_PROCESSES,
    filesystem: systemFilesystem,
    bundle: running,
    stateDir: paths.state,
    // Nothing arms the watches, and the registry's fetch refuses.
    registryUrl: "http://registry.invalid/",
    fetch: async () => {
      throw new Error("update notice: no registry in this test");
    },
    gates,
    updateFact,
    exit,
    log,
  });
  const mismatchRuns = new MismatchRuns(journalTurns);
  // [LAW:one-source-of-truth] One of each part the daemon hands both its
  // verbs and its draw (src/daemon/daemon.ts).
  const verbCtx: DaemonParts["verbCtx"] = {
    doctor,
    doctorStores,
    claudeInput,
    gates,
    sessionState,
    stateDir: paths.state,
    filesystem: systemFilesystem,
    installedLayers: renderCache.installedLayers,
    storedRoot: paths.storedRoot,
    locations: locs,
    journalTurns,
    log,
    launcher,
    now: instant,
    probes: handlerProbes,
    clients: renderSightings,
    mismatchRuns,
    bundle,
    history: settingsHistory,
    navigation: navigationHistory,
    links,
    runs,
    ...verbsOverParts(() => parts),
  };
  const parts: DaemonParts = {
    home: host.home,
    storedRoot: paths.storedRoot,
    tmp: host.tmp,
    heldSession,
    launcher,
    log,
    clock,
    bundle,
    sourceDigest: null,
    doctorStores: verbCtx.doctorStores,
    stats,
    handlerProbes,
    renderSightings,
    mismatchRuns,
    watcherRegistry,
    refreshLedger,
    fileEvents,
    gitEnv,
    payloadProviders,
    sessionState,
    rendererName: home.name,
    draw: partsDraw(() => parts),
    effectSessions,
    menuIdle,
    journalTurns,
    links,
    runs,
    sourceRuns,
    laneSetups,
    tmuxStatusLines,
    frameFeeds,
    linkIds,
    renderWarnings,
    renderCache,
    recorder,
    updateWatch,
    limits,
    verbCtx,
  };
  return {
    parts,
    launcher: launched,
    close: () =>
      closeDaemon(
        { ...parts, journalTurns, sessionState, closing, binaryWatch },
        NO_TMUX_AT_EXIT,
      ),
  };
}

// [LAW:single-enforcer] One mutator owns runtime counters. Server, caches, and
// watchers each receive a tiny handle they're allowed to bump, but the
// canonical object lives here. Stats are read-only after serialization.

import {
  durationHistogram,
  durationsOf,
  recordMs,
  type Histogram,
} from "./durations.js";
import type {
  Durations,
  RunStats,
  TmuxStatusStats,
  FeedStats,
  FileEventsStats,
  SourceRunsStats,
  ProbeArrival,
  StoresRead,
  SourceSnapshots,
  StatsSnapshot,
} from "./foundations/stats-snapshot.js";
import type { TranscriptReads } from "../utils/transcript-fs";
import type { RenderSighting } from "./foundations/sightings";
import type { ServingDaemon } from "./foundations/memory-limit";
import type { LaunchCategory } from "../proc/launcher";
import type { LaunchStatsHandle } from "../proc/stats-handle";
import { PROTOCOL_VERSION } from "./foundations/protocol";
import { PACKAGE_VERSION } from "../version";
import type { Monotonic, Timekeeper } from "../time";
import type { RequestId } from "../renderer-interface/interface.js";
import type { Acceptance } from "./foundations/request-event.js";

// A read kind no run of which has happened yet.
const NO_RUNS: SourceRunsStats["shell"] = {
  entries: 0,
  held: 0,
  refreshes: {},
  failures: 0,
  abandoned: 0,
  lastMs: null,
};

// Rolling window for "last minute" counts. Keep timestamps for each launch in
// a ring buffer; eviction happens lazily on read.
//
// [LAW:dataflow-not-control-flow] The cap is a hard bound on how many
// launches can be counted in any 60-second window. Bursts above
// ROLLING_BUFFER_CAP / (ROLLING_WINDOW_MS/1000) launches/sec overwrite
// timestamps that are still inside the window, causing `lastMinute` to
// undercount. At 16384 entries / 60s = ~273 sustained launches/sec the
// undercount only kicks in under pathological load (well past anything kz8
// is trying to detect). Bump this cap rather than the comment if a future
// workload ever sustains higher rates.
const ROLLING_WINDOW_MS = 60_000;
const ROLLING_BUFFER_CAP = 16384;

export class RuntimeStats {
  readonly startedAt: Date;
  requestsTotal = 0;
  requestsErrored = 0;
  requestsTimedOut = 0;
  inFlight = 0;
  private readonly unknownHookFields = new Set<string>();

  // [LAW:one-source-of-truth] The daemon's clock, which these counters read
  // like everything else the daemon times.
  constructor(private readonly clock: Pick<Timekeeper, "now" | "monotonic">) {
    this.startedAt = new Date(clock.now());
  }

  // [LAW:single-enforcer] Where a request is accepted: its id is the count
  // of requests of every kind accepted so far, so ids follow the order they
  // arrived. Apart from `requestsTotal`, which counts renders alone.
  private accepted = 0;
  accept(): Acceptance {
    return {
      id: ++this.accepted as RequestId,
      at: this.clock.monotonic(),
    };
  }

  // Whether `field` is the first sight of that unknown hook field in this
  // daemon's life: every request carries it, so it is said once.
  firstSightOfUnknownHookField(field: string): boolean {
    const first = !this.unknownHookFields.has(field);
    this.unknownHookFields.add(field);
    return first;
  }

  watchersOpened = 0;
  watchersClosed = 0;
  watchRefusals = 0;
  watchErrors = 0;
  dirWatchesOpened = 0;
  dirWatchesClosed = 0;

  // [LAW:dataflow-not-control-flow] Subprocess metering. Every launch carries
  // its category through one boundary; the per-category state below is a
  // function of that data, not of which call site fired.
  subprocessTotal = 0;
  subprocessInFlight = 0;
  subprocessDraining = 0;
  subprocessDrainedBytes = 0;
  subprocessDrainsCut = 0;
  subprocessPipeErrors = 0;
  // Launches asked for that started nothing: the launcher had closed, the
  // category's interval had not passed, or the caller had aborted first.
  private readonly subprocessRefusals = new Map<LaunchCategory, number>();
  private readonly subprocessCount = new Map<LaunchCategory, number>();
  private readonly subprocessDurations = new Map<LaunchCategory, Histogram>();
  private readonly took = durationHistogram();
  private readonly rollingTimestamps: Monotonic[] = [];
  private rollingHead = 0;

  // Readable off the value because a closed daemon's work is still refused, and
  // no request reads a closed daemon.
  get subprocessRefused(): ReadonlyMap<LaunchCategory, number> {
    return this.subprocessRefusals;
  }

  // [LAW:one-source-of-truth] The same object that owns the counters also
  // exposes the metering handle. The launch primitive calls these methods;
  // nothing else mutates subprocess state.
  readonly launchStats: LaunchStatsHandle = {
    onStart: (category) => {
      this.subprocessTotal++;
      this.subprocessInFlight++;
      this.subprocessCount.set(
        category,
        (this.subprocessCount.get(category) ?? 0) + 1,
      );
      this.recordRollingNow();
    },
    onEnd: (category, durationMs) => {
      this.subprocessInFlight = Math.max(0, this.subprocessInFlight - 1);
      this.recordDuration(category, durationMs);
    },
    onRefused: (category) => {
      this.subprocessRefusals.set(
        category,
        (this.subprocessRefusals.get(category) ?? 0) + 1,
      );
    },
    onDrainOpen: () => {
      this.subprocessDraining++;
    },
    onDrainRead: (_category, bytes) => {
      this.subprocessDrainedBytes += bytes;
    },
    onDrainClose: (_category, end) => {
      this.subprocessDraining--;
      if (end === "cut") this.subprocessDrainsCut++;
    },
    onPipeError: () => {
      this.subprocessPipeErrors++;
    },
  };

  private recordRollingNow(): void {
    const now = this.clock.monotonic();
    if (this.rollingTimestamps.length < ROLLING_BUFFER_CAP) {
      this.rollingTimestamps.push(now);
      return;
    }
    // Ring buffer once cap hit. The overwritten slot may still be inside the
    // 60s window — see the cap-rationale comment at ROLLING_BUFFER_CAP.
    this.rollingTimestamps[this.rollingHead] = now;
    this.rollingHead = (this.rollingHead + 1) % ROLLING_BUFFER_CAP;
  }

  private recordDuration(category: LaunchCategory, durationMs: number): void {
    const held = this.subprocessDurations.get(category);
    const hist = held ?? durationHistogram();
    if (held === undefined) this.subprocessDurations.set(category, hist);
    recordMs(hist, durationMs);
  }

  // A render's duration, from its start to its answer.
  recordTook(tookMs: number): void {
    recordMs(this.took, tookMs);
  }

  private snapshotSubprocesses(): StatsSnapshot["subprocesses"] {
    const cutoff = this.clock.monotonic() - ROLLING_WINDOW_MS;
    let lastMinute = 0;
    for (const ts of this.rollingTimestamps) {
      if (ts >= cutoff) lastMinute++;
    }

    // [LAW:one-source-of-truth] Snapshot includes only categories that have
    // actually executed, as `durations` below holds only those that have
    // ended. Consumers wanting the
    // full closed list can read LAUNCH_CATEGORIES (exported from src/proc/launch)
    // and treat missing keys as zero.
    const byCategory: Record<string, number> = {};
    for (const [cat, n] of this.subprocessCount) {
      if (n > 0) byCategory[cat] = n;
    }

    const durations: Record<string, Durations> = {};
    for (const [cat, hist] of this.subprocessDurations)
      durations[cat] = durationsOf(hist);

    return {
      total: this.subprocessTotal,
      inFlight: this.subprocessInFlight,
      lastMinute,
      byCategory,
      refused: Object.fromEntries(this.subprocessRefused),
      draining: this.subprocessDraining,
      drainedBytes: this.subprocessDrainedBytes,
      drainsCut: this.subprocessDrainsCut,
      pipeErrors: this.subprocessPipeErrors,
      durations,
    };
  }

  // [LAW:one-source-of-truth] This build's snapshot shape, as data: every
  // field `snapshot` writes, with zeroed counts. A client reads a snapshot
  // from whichever daemon is running, and an older build's lacks fields this
  // one reads; comparing against the producer's own output, not a second
  // spelling of the type, means a field added here is checked for there.
  static referenceSnapshot(): StatsSnapshot {
    return new RuntimeStats({
      now: () => 0,
      monotonic: () => 0 as Monotonic,
    }).snapshot({
      gitCache: {
        size: 0,
        held: 0,
        hits: 0,
        misses: 0,
        changes: 0,
        watchers: 0,
      },
      usageCache: { size: 0, hits: 0, misses: 0, sweeps: 0 },
      sources: {
        records: [],
        homes: {
          daemon: 0,
          configDir: 0,
          repo: 0,
          directory: 0,
          session: 0,
          view: 0,
          pane: 0,
        },
        held: {
          git: 0,
          tmux: 0,
          host: 0,
          today: 0,
          pluginStorage: 0,
          transcript: 0,
        },
        pluginStorage: {
          folders: 0,
          faults: { unusable: 0, refused: 0, error: 0 },
          lost: 0,
        },
      },
      fileEvents: {
        delivery: { kind: "delivering", unreported: [], missedSince: null },
        stalls: 0,
        catchUps: 0,
        probes: 0,
        probeFailures: 0,
      },
      sourceRuns: {
        shell: NO_RUNS,
        file: NO_RUNS,
        watches: 0,
      },
      transcriptReads: { reads: 0, bytes: 0, longLines: 0, largestLine: 0 },
      renderCache: {
        size: 0,
        held: 0,
        retired: 0,
        compiles: 0,
        views: 0,
        pinned: 0,
        due: 0,
        retiredViews: 0,
        accountedBytes: 0,
        budgetBytes: 0,
      },
      collector: { sessions: 0, retiring: 0 },
      effectCache: { sessions: 0, effects: 0 },
      menuIdle: { sessions: 0, armed: 0, pending: 0 },
      journalTurns: { holder: null, heldMs: 0, queued: 0, gathers: 0 },
      runs: { started: 0, failed: 0, timedOut: 0, refused: 0, running: 0 },
      sessionState: { sessions: 0, observers: 0, revision: 0 },
      frameFeeds: {
        feeds: 0,
        subscribers: 0,
        drawn: 0,
        pushed: 0,
        refused: 0,
        lookups: 0,
        found: 0,
      },
      tmuxStatus: { sessions: 0, layouts: 0, writes: 0, failedWrites: 0 },
      watchersActive: 0,
      dirWatchesActive: 0,
      handlerProbes: [],
      clients: [],
      bundle: "/",
      sourceDigest: null,
      daemon: {
        pid: 0,
        memory: { kind: "unmeasured" },
        limit: 0,
        postMortems: { kind: "ok", value: [] },
      },
      doctorStores: {
        marks: { kind: "ok", value: {} },
        clicked: { kind: "ok", value: [] },
        postMortemsRead: { kind: "ok", value: { through: null } },
      },
    });
  }

  snapshot(extras: {
    gitCache: StatsSnapshot["gitCache"];
    usageCache: StatsSnapshot["usageCache"];
    sources: SourceSnapshots;
    fileEvents: FileEventsStats;
    sourceRuns: SourceRunsStats;
    transcriptReads: TranscriptReads;
    renderCache: StatsSnapshot["renderCache"];
    collector: StatsSnapshot["collector"];
    effectCache: StatsSnapshot["effectCache"];
    menuIdle: StatsSnapshot["menuIdle"];
    journalTurns: StatsSnapshot["journalTurns"];
    runs: RunStats;
    sessionState: StatsSnapshot["sessionState"];
    frameFeeds: FeedStats;
    tmuxStatus: TmuxStatusStats;
    watchersActive: number;
    dirWatchesActive: number;
    nextRestartReason?: string | null;
    handlerProbes: readonly ProbeArrival[];
    clients: readonly RenderSighting[];
    bundle: string;
    sourceDigest: string | null;
    daemon: ServingDaemon;
    doctorStores: StoresRead;
  }): StatsSnapshot {
    const mem = process.memoryUsage();
    return {
      pid: process.pid,
      version: PACKAGE_VERSION,
      sourceDigest: extras.sourceDigest,
      protocolVersion: PROTOCOL_VERSION,
      startedAt: this.startedAt.toISOString(),
      uptimeSec: Math.floor(
        (this.clock.now() - this.startedAt.getTime()) / 1000,
      ),
      rssBytes: mem.rss,
      heapUsedBytes: mem.heapUsed,
      heapTotalBytes: mem.heapTotal,
      externalBytes: mem.external,
      arrayBuffersBytes: mem.arrayBuffers,
      requests: {
        total: this.requestsTotal,
        errored: this.requestsErrored,
        timedOut: this.requestsTimedOut,
        inFlight: this.inFlight,
        took: durationsOf(this.took),
      },
      unknownHookFields: [...this.unknownHookFields],
      gitCache: extras.gitCache,
      usageCache: extras.usageCache,
      sources: extras.sources,
      fileEvents: extras.fileEvents,
      sourceRuns: extras.sourceRuns,
      transcriptReads: extras.transcriptReads,
      renderCache: extras.renderCache,
      collector: extras.collector,
      effectCache: extras.effectCache,
      menuIdle: extras.menuIdle,
      journalTurns: extras.journalTurns,
      runs: extras.runs,
      sessionState: extras.sessionState,
      frameFeeds: extras.frameFeeds,
      tmuxStatus: extras.tmuxStatus,
      watchers: {
        active: extras.watchersActive,
        opened: this.watchersOpened,
        closed: this.watchersClosed,
        refused: this.watchRefusals,
        errors: this.watchErrors,
        dirs: {
          active: extras.dirWatchesActive,
          opened: this.dirWatchesOpened,
          closed: this.dirWatchesClosed,
        },
      },
      subprocesses: this.snapshotSubprocesses(),
      nextRestartReason: extras.nextRestartReason ?? null,
      handlerProbes: extras.handlerProbes,
      clients: extras.clients,
      bundle: extras.bundle,
      daemon: extras.daemon,
      doctorStores: extras.doctorStores,
    };
  }
}

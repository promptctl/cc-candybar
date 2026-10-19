// [LAW:single-enforcer] One mutator owns runtime counters. Server, caches, and
// watchers each receive a tiny handle they're allowed to bump, but the
// canonical object lives here. Stats are read-only after serialization.

import type { FeedStats } from "./frame-feed";
import type { ProbeArrival } from "../doctor/handler-probe";
import type { ClientSighting } from "./client-sightings";
import type { LaunchCategory } from "../proc/launch";
import type { LaunchStatsHandle } from "../proc/stats-handle";
import { PROTOCOL_VERSION } from "./protocol";
import { PACKAGE_VERSION } from "../version";
import { bakedDigest } from "./build-currency";

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

// Reservoir-sample histogram (16 entries) per category — sufficient for
// rough p50/p99 without unbounded memory. Replacement uses a simple
// counter-mod-N strategy: deterministic and adequate for human-eyeball
// dashboards (no statistical claim of unbiased sampling).
const HISTOGRAM_CAP = 16;

export interface StatsSnapshot {
  pid: number;
  // [LAW:one-source-of-truth] The daemon's own baked package stamp — set
  // against `cc-candybar --version` to diagnose client-vs-daemon skew in one
  // step. The wire contract number is a different fact under its own name.
  version: string;
  // The digest of the source the daemon's bundle was built from (`null` for a
  // bundle carrying none) — with `version`, the build's identity: a source
  // checkout rebuilds without bumping the version, and a client of another
  // build cannot read this snapshot's shape as its own.
  sourceDigest: string | null;
  protocolVersion: number;
  startedAt: string;
  uptimeSec: number;
  rssBytes: number;
  heapUsedBytes: number;
  heapTotalBytes: number;
  externalBytes: number;
  arrayBuffersBytes: number;
  requests: {
    total: number;
    errored: number;
    timedOut: number;
    inFlight: number;
  };
  gitCache: {
    size: number;
    hits: number;
    misses: number;
    invalidations: number;
    watchers: number;
  };
  usageCache: {
    size: number;
    hits: number;
    misses: number;
    sweeps: number;
  };
  // Config states: entries the map serves, those a render is drawing with
  // now, and those retired (evicted or reloaded over) whose teardown waits
  // on one. `retired` climbing while `size` holds is a render that never
  // returned.
  renderCache: {
    size: number;
    held: number;
    retired: number;
  };
  effectCache: {
    sessions: number;
    effects: number;
  };
  // The per-session click store: how many sessions it holds, and how many
  // derivations are subscribed to it. Observers climbing while renderCache
  // holds steady is a disposed config's store still held.
  sessionState: {
    sessions: number;
    observers: number;
  };
  // Subscribed sessions, their subscribers, and the frames drawn for them and
  // pushed (a drawn frame identical to the last is not pushed).
  frameFeeds: FeedStats;
  watchers: {
    active: number;
    opened: number;
    closed: number;
    evicted: number;
  };
  subprocesses: {
    total: number;
    inFlight: number;
    lastMinute: number;
    byCategory: Record<string, number>;
    p50DurationMs: Record<string, number>;
    p99DurationMs: Record<string, number>;
  };
  nextRestartReason: string | null;
  // The `doctor-probe` links that reached this daemon, newest last — what
  // `cc-candybar doctor` reads to learn whether the link it opened arrived.
  handlerProbes: readonly ProbeArrival[];
  // Each session's latest client, as this daemon process saw its last render
  // request (src/daemon/client-sightings.ts), and the bundle this daemon
  // runs — what `cc-candybar doctor` judges the install by.
  clients: readonly ClientSighting[];
  bundle: string;
}

export class RuntimeStats {
  readonly startedAt = new Date();
  requestsTotal = 0;
  requestsErrored = 0;
  requestsTimedOut = 0;
  inFlight = 0;

  watchersOpened = 0;
  watchersClosed = 0;
  watchersEvicted = 0;

  // [LAW:dataflow-not-control-flow] Subprocess metering. Every launch carries
  // its category through one boundary; the per-category state below is a
  // function of that data, not of which call site fired.
  subprocessTotal = 0;
  subprocessInFlight = 0;
  private readonly subprocessCount = new Map<LaunchCategory, number>();
  private readonly subprocessHistogram = new Map<LaunchCategory, number[]>();
  private readonly subprocessHistogramRotator = new Map<
    LaunchCategory,
    number
  >();
  private readonly rollingTimestamps: number[] = [];
  private rollingHead = 0;

  // [LAW:one-source-of-truth] The same object that owns the counters also
  // exposes the metering handle. The launch primitive calls these two
  // methods; nothing else mutates subprocess state.
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
  };

  private recordRollingNow(): void {
    const now = Date.now();
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
    let hist = this.subprocessHistogram.get(category);
    if (!hist) {
      hist = [];
      this.subprocessHistogram.set(category, hist);
    }
    if (hist.length < HISTOGRAM_CAP) {
      hist.push(durationMs);
      return;
    }
    const idx =
      (this.subprocessHistogramRotator.get(category) ?? 0) % HISTOGRAM_CAP;
    hist[idx] = durationMs;
    this.subprocessHistogramRotator.set(category, idx + 1);
  }

  private snapshotSubprocesses(): StatsSnapshot["subprocesses"] {
    const cutoff = Date.now() - ROLLING_WINDOW_MS;
    let lastMinute = 0;
    for (const ts of this.rollingTimestamps) {
      if (ts >= cutoff) lastMinute++;
    }

    // [LAW:one-source-of-truth] Snapshot includes only categories that have
    // actually executed — same shape as p50/p99 below. Consumers wanting the
    // full closed list can read LAUNCH_CATEGORIES (exported from src/proc/launch)
    // and treat missing keys as zero.
    const byCategory: Record<string, number> = {};
    for (const [cat, n] of this.subprocessCount) {
      if (n > 0) byCategory[cat] = n;
    }

    const p50: Record<string, number> = {};
    const p99: Record<string, number> = {};
    for (const [cat, hist] of this.subprocessHistogram) {
      if (hist.length === 0) continue;
      const sorted = [...hist].sort((a, b) => a - b);
      const p50idx = Math.floor(sorted.length * 0.5);
      const p99idx = Math.min(
        sorted.length - 1,
        Math.floor(sorted.length * 0.99),
      );
      const p50val = sorted[p50idx];
      const p99val = sorted[p99idx];
      if (p50val !== undefined) p50[cat] = p50val;
      if (p99val !== undefined) p99[cat] = p99val;
    }

    return {
      total: this.subprocessTotal,
      inFlight: this.subprocessInFlight,
      lastMinute,
      byCategory,
      p50DurationMs: p50,
      p99DurationMs: p99,
    };
  }

  // [LAW:one-source-of-truth] This build's snapshot shape, as data: every
  // field `snapshot` writes, with zeroed counts. A client reads a snapshot
  // from whichever daemon is running, and an older build's lacks fields this
  // one reads; comparing against the producer's own output, not a second
  // spelling of the type, means a field added here is checked for there.
  static referenceSnapshot(): StatsSnapshot {
    return new RuntimeStats().snapshot({
      gitCache: { size: 0, hits: 0, misses: 0, invalidations: 0, watchers: 0 },
      usageCache: { size: 0, hits: 0, misses: 0, sweeps: 0 },
      renderCache: { size: 0, held: 0, retired: 0 },
      effectCache: { sessions: 0, effects: 0 },
      sessionState: { sessions: 0, observers: 0 },
      frameFeeds: { feeds: 0, subscribers: 0, drawn: 0, pushed: 0 },
      watchersActive: 0,
      handlerProbes: [],
      clients: [],
      bundle: "/",
    });
  }

  snapshot(extras: {
    gitCache: StatsSnapshot["gitCache"];
    usageCache: StatsSnapshot["usageCache"];
    renderCache: StatsSnapshot["renderCache"];
    effectCache: StatsSnapshot["effectCache"];
    sessionState: StatsSnapshot["sessionState"];
    frameFeeds: FeedStats;
    watchersActive: number;
    nextRestartReason?: string | null;
    handlerProbes: readonly ProbeArrival[];
    clients: readonly ClientSighting[];
    bundle: string;
  }): StatsSnapshot {
    const mem = process.memoryUsage();
    return {
      pid: process.pid,
      version: PACKAGE_VERSION,
      sourceDigest: bakedDigest(),
      protocolVersion: PROTOCOL_VERSION,
      startedAt: this.startedAt.toISOString(),
      uptimeSec: Math.floor((Date.now() - this.startedAt.getTime()) / 1000),
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
      },
      gitCache: extras.gitCache,
      usageCache: extras.usageCache,
      renderCache: extras.renderCache,
      effectCache: extras.effectCache,
      sessionState: extras.sessionState,
      frameFeeds: extras.frameFeeds,
      watchers: {
        active: extras.watchersActive,
        opened: this.watchersOpened,
        closed: this.watchersClosed,
        evicted: this.watchersEvicted,
      },
      subprocesses: this.snapshotSubprocesses(),
      nextRestartReason: extras.nextRestartReason ?? null,
      handlerProbes: extras.handlerProbes,
      clients: extras.clients,
      bundle: extras.bundle,
    };
  }
}

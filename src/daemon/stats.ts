// [LAW:single-enforcer] One mutator owns runtime counters. Server, caches, and
// watchers each receive a tiny handle they're allowed to bump, but the
// canonical object lives here. Stats are read-only after serialization.

import { PROTOCOL_VERSION } from "./protocol";

export interface StatsSnapshot {
  pid: number;
  version: number;
  startedAt: string;
  uptimeSec: number;
  rssBytes: number;
  heapUsedBytes: number;
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
  watchers: {
    active: number;
    opened: number;
    closed: number;
    evicted: number;
  };
  nextRestartReason: string | null;
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

  snapshot(extras: {
    gitCache: StatsSnapshot["gitCache"];
    usageCache: StatsSnapshot["usageCache"];
    watchersActive: number;
    nextRestartReason?: string | null;
  }): StatsSnapshot {
    const mem = process.memoryUsage();
    return {
      pid: process.pid,
      version: PROTOCOL_VERSION,
      startedAt: this.startedAt.toISOString(),
      uptimeSec: Math.floor((Date.now() - this.startedAt.getTime()) / 1000),
      rssBytes: mem.rss,
      heapUsedBytes: mem.heapUsed,
      requests: {
        total: this.requestsTotal,
        errored: this.requestsErrored,
        timedOut: this.requestsTimedOut,
        inFlight: this.inFlight,
      },
      gitCache: extras.gitCache,
      usageCache: extras.usageCache,
      watchers: {
        active: extras.watchersActive,
        opened: this.watchersOpened,
        closed: this.watchersClosed,
        evicted: this.watchersEvicted,
      },
      nextRestartReason: extras.nextRestartReason ?? null,
    };
  }
}

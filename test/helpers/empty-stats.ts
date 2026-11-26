// A stats reply of nothing yet: every count zero, one renderer's panel, as the
// producer writes it. The base the stats printer's tests vary.

import { RuntimeStats } from "../../src/daemon/stats";
import type { StatsSnapshot } from "../../src/daemon/foundations/stats-snapshot";
import type { RendererStats } from "../../src/renderer-interface/renderer-stats";
import type { KeyedSourceStats } from "../../src/utils/keyed-source";
import { MAIN_RENDERER } from "../../src/daemon/foundations/renderer-name";
import type { Monotonic } from "../../src/time";

export const EMPTY_RENDERER_STATS: RendererStats = {
  renderCache: {
    size: 0,
    held: 0,
    retired: 0,
    compiles: 0,
    views: 0,
    pinned: 0,
    retiredViews: 0,
    passages: 0,
    accountedBytes: 0,
    budgetBytes: 0,
  },
  effectCache: { sessions: 0, effects: 0 },
  menuIdle: { sessions: 0, armed: 0 },
  rendererTurns: { parked: 0, presents: 0, deferrals: 0 },
  sessionState: { sessions: 0, observers: 0, revision: 0 },
  framesDrawn: 0,
};

const NO_RUNS: KeyedSourceStats = {
  entries: 0,
  held: 0,
  refreshes: {},
  failures: 0,
  abandoned: 0,
  lastMs: null,
};

export function emptyStats(): StatsSnapshot {
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
      homes: { daemon: 0, configDir: 0, repo: 0, session: 0, pane: 0 },
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
        faults: { unusable: 0, unreadable: 0, refused: 0, error: 0 },
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
    sourceRuns: { shell: NO_RUNS, file: NO_RUNS, watches: 0 },
    transcriptReads: { reads: 0, bytes: 0, longLines: 0, largestLine: 0 },
    collector: { sessions: 0, retiring: 0 },
    runs: { started: 0, failed: 0, timedOut: 0, refused: 0, running: 0 },
    frameFeeds: {
      feeds: 0,
      subscribers: 0,
      pushed: 0,
      refused: 0,
      lookups: 0,
      found: 0,
    },
    watchersActive: 0,
    dirWatchesActive: 0,
    polledPaths: 0,
    clients: [],
    bundle: "/",
    sourceDigest: null,
    linkKeyId: { kind: "ok", value: "AbCd-_12" },
    host: { pid: 0, memory: { kind: "unmeasured" }, limit: 0, nearAt: 0 },
    renderers: [
      {
        name: MAIN_RENDERER,
        process: {
          kind: "process",
          memory: {
            pid: 0,
            memory: { kind: "unmeasured" },
            limit: 0,
            nearAt: 0,
          },
        },
        mailbox: { holder: null, heldMs: 0, queued: 0 },
        stats: { kind: "ok", value: EMPTY_RENDERER_STATS },
      },
    ],
  });
}

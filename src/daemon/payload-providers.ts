// The data providers a view's payload reads, constructed once per process
// that renders.
//
// [LAW:one-source-of-truth] A provider added to `RenderPayloadDeps` is
// constructed in this one place, so the daemon and the tests that build its
// providers get the same list and none restates it.
//
// [LAW:effects-at-boundaries] Construction arms one unref'd timer (the usage
// sweep) and touches no disk — every owner's period starts only once a home
// holds one of its entries; the log sink and the watcher pool are the
// caller's, so only the daemon writes daemon.log.

import { GitDataProvider } from "./cache/git";
import { SessionUsageStore } from "./cache/session-usage-store";
import type { WatcherRegistry } from "./cache/watchers";
import { GitService } from "./cache/git-service";
import type { Host } from "../host";
import type { Timekeeper } from "../time";
import type { Launcher } from "../proc/launcher";
import type { FileEvents } from "./cache/file-events";
import type { DaemonLogger } from "../utils/logger";
import type { RefreshLedger } from "../utils/refresh-ledger";
import type { RenderPayloadDeps } from "./readings";
import { ContextProvider } from "./cache/context-provider.js";
import { MetricsProvider } from "./cache/metrics-provider.js";
import { ActivityProvider } from "../segments/activity.js";
import { TmuxService } from "./cache/tmux.js";
import { HostService } from "./cache/host-identity.js";
import { AutoCompactProvider } from "./cache/autocompact.js";
import { CacheExpiryProvider } from "../segments/cache.js";
import { RefreshFaults } from "./refresh-faults.js";
import { ManagedStorage } from "./cache/managed-storage.js";
import type { SourceRuns } from "./source-runs.js";
import type { TeardownStep } from "../utils/teardown.js";
import { TranscriptLanes, type LaneOwners } from "./cache/transcript-lanes.js";

// [LAW:single-enforcer] Every provider records its refreshes in the caller's
// one ledger, so its stats read every source in one place.
export function createPayloadProviders(opts: {
  // Who the git and tmux reads belong to.
  readonly launcher: Launcher;
  // The machine the providers read: where transcripts and settings live.
  readonly host: Host;
  readonly watchers: WatcherRegistry;
  // Whether the OS is delivering file events: the caller's one owner, which
  // only the daemon starts.
  readonly fileEvents: FileEvents;
  // [LAW:effects-at-boundaries] The clock the providers read time and set
  // their timers through: the daemon's.
  readonly clock: Timekeeper;
  readonly logger: DaemonLogger;
  readonly ledger: RefreshLedger;
  // The caller's one owner of every `shell` and `file` run, whose stats and
  // close are the caller's.
  readonly sourceRuns: SourceRuns;
}) {
  const { launcher, clock, logger, ledger } = opts;
  // [LAW:one-source-of-truth] The owners the transcript lanes refresh are the
  // ones the payload reads.
  const lanes = {
    usageStore: new SessionUsageStore({
      host: opts.host,
      clock,
      logger,
      ledger,
    }),
    contextProvider: new ContextProvider({ clock, logger, ledger }),
    metricsProvider: new MetricsProvider({ clock, logger, ledger }),
    activityProvider: new ActivityProvider({ clock, logger, ledger }),
    autoCompact: new AutoCompactProvider(clock, logger, ledger),
    cacheExpiry: new CacheExpiryProvider(clock, logger, ledger),
    faults: new RefreshFaults(),
  } satisfies LaneOwners;
  const owners = {
    hostService: new HostService({ clock, logger, ledger }),
    gitProvider: new GitDataProvider({
      inner: new GitService(launcher),
      watchers: opts.watchers,
      clock,
      logger,
      ledger,
    }),
    tmuxService: new TmuxService({ launcher, clock, logger, ledger }),
    transcriptLanes: new TranscriptLanes({
      owners: lanes,
      watchers: opts.watchers,
      clock,
      logger,
      ledger,
    }),
    managedStorage: new ManagedStorage({
      files: opts.sourceRuns.files,
      watchers: opts.watchers,
      fileEvents: opts.fileEvents,
      clock,
      logger,
      ledger,
    }),
  };
  // [LAW:types-are-the-program] The owners whole, for the daemon's stats and
  // close, and a session's reads of them by the narrower type a fixture world
  // shares.
  return {
    ...lanes,
    ...owners,
    home: opts.host.home,
    sourceRuns: opts.sourceRuns,
    log: opts.logger,
    // [LAW:single-enforcer] The one close of every owner built here, a named
    // step each, which its caller's teardown runs (runTeardown): a held
    // entry's period re-arms after every read, so an owner a caller forgets
    // keeps its timers for good. The transcript lanes go before the usage
    // store their reads fill.
    closes: [
      ["gitProvider close", () => owners.gitProvider.close()],
      ["transcriptLanes close", () => owners.transcriptLanes.close()],
      ["usageStore close", () => lanes.usageStore.close()],
      ["tmuxService close", () => owners.tmuxService.close()],
      ["hostService close", () => owners.hostService.close()],
      ["managedStorage close", () => owners.managedStorage.close()],
    ],
  } satisfies RenderPayloadDeps & { readonly closes: readonly TeardownStep[] };
}

// The owners the daemon builds, each its whole class.
export type PayloadProviders = ReturnType<typeof createPayloadProviders>;

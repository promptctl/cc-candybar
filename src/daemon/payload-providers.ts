// The data providers a view's payload reads, constructed once per process
// that renders.
//
// [LAW:one-source-of-truth] The daemon and the demo render from the same set,
// built here: a provider added to `RenderPayloadDeps` is constructed in this
// one place, so every renderer has it and none restates the list.
//
// [LAW:effects-at-boundaries] Construction arms one unref'd timer (the usage
// sweep) and touches no disk — every owner's period starts only once a home
// holds one of its entries; the log sink and the watcher pool are the
// caller's, so only the daemon writes daemon.log.

import { GitDataProvider } from "./cache/git";
import { SessionUsageStore } from "./cache/session-usage-store";
import type { WatcherRegistry } from "./cache/watchers";
import { GitService } from "../segments/git";
import type { Launcher } from "../proc/launch";
import type { FileEvents } from "./cache/file-events";
import type { DaemonLogger } from "../utils/logger";
import type { RefreshLedger } from "../utils/refresh-ledger";
import type { RenderPayloadDeps } from "./render-payload";
import { ContextProvider } from "../segments/context.js";
import { MetricsProvider } from "../segments/metrics.js";
import { ActivityProvider } from "../segments/activity.js";
import { TmuxService } from "../segments/tmux.js";
import { HostService } from "../segments/host.js";
import { AutoCompactProvider } from "../segments/autocompact-provider.js";
import { CacheExpiryProvider } from "../segments/cache.js";
import { RefreshFaults } from "./refresh-faults.js";
import { ManagedStorage } from "./cache/managed-storage.js";

// The lanes the view's declaration handed it (`lanes`) are the view's to
// supply; everything else is a provider.
export type PayloadProviders = Omit<RenderPayloadDeps, "lanes">;

// [LAW:single-enforcer] Every provider records its refreshes in the caller's
// one ledger, so its stats read every source in one place.
export function createPayloadProviders(opts: {
  // Who the git and tmux reads belong to.
  readonly launcher: Launcher;
  readonly watchers: WatcherRegistry;
  // Whether the OS is delivering file events: the caller's one owner, which
  // only the daemon starts.
  readonly fileEvents: FileEvents;
  readonly logger: DaemonLogger;
  readonly ledger: RefreshLedger;
}): PayloadProviders {
  const { launcher, logger, ledger } = opts;
  return {
    hostService: new HostService({ logger, ledger }),
    gitProvider: new GitDataProvider({
      inner: new GitService(launcher),
      watchers: opts.watchers,
      logger,
      ledger,
    }),
    usageStore: new SessionUsageStore({ logger, ledger }),
    contextProvider: new ContextProvider({ logger, ledger }),
    metricsProvider: new MetricsProvider({ logger, ledger }),
    activityProvider: new ActivityProvider({ logger, ledger }),
    tmuxService: new TmuxService({ launcher, logger, ledger }),
    autoCompact: new AutoCompactProvider(logger, ledger),
    cacheExpiry: new CacheExpiryProvider(logger, ledger),
    managedStorage: new ManagedStorage({
      watchers: opts.watchers,
      fileEvents: opts.fileEvents,
      logger,
      ledger,
    }),
    faults: new RefreshFaults(),
    log: opts.logger,
  };
}

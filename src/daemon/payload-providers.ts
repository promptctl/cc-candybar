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
import type { DaemonLogger } from "../utils/logger";
import type { RenderPayloadDeps } from "./render-payload";
import { ContextProvider } from "../segments/context.js";
import { MetricsProvider } from "../segments/metrics.js";
import { ActivityProvider } from "../segments/activity.js";
import { TmuxService } from "../segments/tmux.js";
import { AutoCompactProvider } from "../segments/autocompact-provider.js";
import { CacheExpiryProvider } from "../segments/cache.js";
import { RefreshFaults } from "./refresh-faults.js";
import { ManagedStorage } from "./cache/managed-storage.js";

// The lanes the view's declaration handed it (`lanes`) are the view's to
// supply; everything else is a provider.
export type PayloadProviders = Omit<RenderPayloadDeps, "lanes">;

export function createPayloadProviders(opts: {
  readonly watchers: WatcherRegistry;
  readonly logger: DaemonLogger;
}): PayloadProviders {
  return {
    gitProvider: new GitDataProvider({
      watchers: opts.watchers,
      logger: opts.logger,
    }),
    usageStore: new SessionUsageStore({ logger: opts.logger }),
    contextProvider: new ContextProvider({ logger: opts.logger }),
    metricsProvider: new MetricsProvider({ logger: opts.logger }),
    activityProvider: new ActivityProvider({ logger: opts.logger }),
    tmuxService: new TmuxService({ logger: opts.logger }),
    autoCompact: new AutoCompactProvider(opts.logger),
    cacheExpiry: new CacheExpiryProvider(opts.logger),
    managedStorage: new ManagedStorage({
      watchers: opts.watchers,
      logger: opts.logger,
    }),
    faults: new RefreshFaults(),
    log: opts.logger,
  };
}

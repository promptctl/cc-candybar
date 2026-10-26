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
import type { RefreshLedger } from "../utils/refresh-ledger";
import {
  readHostIdentity,
  type HostIdentity,
  type RenderPayloadDeps,
} from "./render-payload";
import { failed, ok } from "../utils/outcome";
import { valueOf } from "../utils/logfmt";
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

// [LAW:single-enforcer] Every provider records its refreshes in the caller's
// one ledger, so its stats read every source in one place.
export function createPayloadProviders(opts: {
  readonly watchers: WatcherRegistry;
  readonly logger: DaemonLogger;
  readonly ledger: RefreshLedger;
}): PayloadProviders {
  const { logger, ledger } = opts;
  return {
    host: hostOf(ledger),
    gitProvider: new GitDataProvider({
      watchers: opts.watchers,
      logger,
      ledger,
    }),
    usageStore: new SessionUsageStore({ logger, ledger }),
    contextProvider: new ContextProvider({ logger, ledger }),
    metricsProvider: new MetricsProvider({ logger, ledger }),
    activityProvider: new ActivityProvider({ logger, ledger }),
    tmuxService: new TmuxService({ logger, ledger }),
    autoCompact: new AutoCompactProvider(logger, ledger),
    cacheExpiry: new CacheExpiryProvider(logger, ledger),
    managedStorage: new ManagedStorage({
      watchers: opts.watchers,
      logger,
      ledger,
    }),
    faults: new RefreshFaults(),
    log: opts.logger,
  };
}

// The host identity, a daemon-scoped source read once: neither the host name
// nor the daemon's user changes while it runs. [LAW:no-silent-failure] A
// syscall that threw is its one refresh's failure, logged once.
function hostOf(ledger: RefreshLedger): HostIdentity {
  const startedAt = Date.now();
  const { identity, failures } = readHostIdentity();
  ledger
    .declare({ name: "host", scope: "daemon", refresh: ["first"] })
    .recorded(
      `name=${valueOf(identity.name ?? "-")} user=${valueOf(identity.user ?? "-")}`,
      "first",
      failures.length === 0 ? ok(identity) : failed(failures.join("; ")),
      Date.now() - startedAt,
    );
  return identity;
}

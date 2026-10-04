// The data providers `buildRenderPayload` reads, constructed once per process
// that renders.
//
// [LAW:one-source-of-truth] The daemon and the demo render from the same set,
// built here: a provider added to `RenderPayloadDeps` is constructed in this
// one place, so every renderer has it and none restates the list.
//
// [LAW:effects-at-boundaries] Construction arms two unref'd timers (the git
// sanity check, the usage sweep) and touches no disk; the log sink and the
// watcher pool are the caller's, so only the daemon writes daemon.log.

import { GitDataProvider } from "./cache/git";
import { SessionUsageStore } from "./cache/session-usage-store";
import type { WatcherRegistry } from "./cache/watchers";
import type { DaemonLogger } from "./log";
import type { RenderPayloadDeps } from "./render-payload";
import { ContextProvider } from "../segments/context.js";
import { MetricsProvider } from "../segments/metrics.js";
import { ActivityProvider } from "../segments/activity.js";
import { TmuxService } from "../segments/tmux.js";
import { MementoProvider } from "../segments/memento.js";
import { productionMementoEdge } from "../memento/edge.js";
import { readAutoCompactWindow } from "../segments/autocompact.js";

// What a session's own history contributes (`history`, `navigation`) and the
// clock are the renderer's to supply; everything else is a provider.
export type PayloadProviders = Omit<
  RenderPayloadDeps,
  "history" | "navigation" | "clock"
>;

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
    contextProvider: new ContextProvider(),
    metricsProvider: new MetricsProvider(),
    activityProvider: new ActivityProvider(),
    tmuxService: new TmuxService(),
    mementoProvider: new MementoProvider(productionMementoEdge()),
    autoCompact: readAutoCompactWindow,
    log: opts.logger,
  };
}

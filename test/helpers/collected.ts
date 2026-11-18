// The host's collector and the main renderer's world-state store over a test's
// own render cache, composed as the daemon composes them (src/daemon/daemon.ts,
// src/renderer/main.ts) with no renderer built: a world state the collector
// hands in is taken into the store, a retire closes the session's view and
// drops its document, and every turn's subscriptions go back to the
// collector, and the storage folders they name to `held`, as the host hands
// back every output's (src/daemon/renderer-host.ts, src/daemon/daemon.ts).

import { Collector, type CollectorDeps } from "../../src/daemon/collector";
import type { RendererHost } from "../../src/daemon/renderer-host";
import { instantAt } from "../../src/utils/instant";
import { retireSession } from "../../src/renderer/draw-bar";
import type { RenderCache } from "../../src/renderer/render-cache";
import type { ViewFacts } from "../../src/renderer-interface/request-context";
import type { StorageNamed } from "../../src/daemon/cache/managed-storage";
import { WorldStates } from "../../src/renderer/world-states";
import { systemTimekeeper } from "../../src/time";
import { daemonFactsOf } from "./daemon-facts";
import { TEST_ENVIRONMENT } from "./session-environment";

// What the renderer's turns read of the cache: what a retire closes, and what
// every output says the open views need read.
type Served = Pick<
  RenderCache<never, never>,
  "retireSession" | "subscriptions" | "storage"
>;

// The storage of a rig whose configs declare no plugin source: a folder its
// subscriptions name is the rig's mistake, said loudly. A rig that loads a
// source hands its ManagedStorage's.
const NO_PLUGIN_STORAGE = ({ folders }: StorageNamed): void => {
  if (folders.length > 0)
    throw new Error(
      `this rig declares no plugin source, yet ${folders.join(", ")} was named`,
    );
};

export interface Collected {
  readonly collector: Collector;
  readonly worldStates: WorldStates;
  // The cache the renderer's turns draw from, named once it is built: its
  // views read `worldStates`, so it is built after them.
  serve(cache: Served): void;
  // A session's `config` turn: its world state taken, the session's view
  // opened as `hold` opens it, and the turn's subscriptions handed back.
  config<H>(facts: ViewFacts, hold: () => H): H;
  // A turn's end with nothing else in it, such as the config turn a reload
  // runs in: its subscriptions handed back.
  ended(): void;
  // Every input the collector hands in goes through `host` from now on, as
  // the daemon's does, so it takes its place in the host's mailbox behind
  // the turns sent before it: a case whose requests go through `host` must
  // route the collector's inputs there too, or a world state can overtake a
  // config turn still waiting in the mailbox.
  route(host: Pick<RendererHost, "deliver">): void;
}

export function collected(
  {
    held = NO_PLUGIN_STORAGE,
    ...deps
  }: Pick<CollectorDeps, "owners" | "log"> &
    Partial<Pick<CollectorDeps, "clock" | "watched" | "daemon">> & {
      // Where the storage folders each turn's subscriptions name go
      // (ManagedStorage's `held`).
      readonly held?: (named: StorageNamed) => void;
    },
  cleanups: Array<() => void>,
): Collected {
  const worldStates = new WorldStates(() => {});
  let served: Served | null = null;
  let routed: Pick<RendererHost, "deliver"> | null = null;
  const cache = (): Served => {
    if (served === null)
      throw new Error("the collector handed in before its cache was served");
    return served;
  };
  // The config turns the rig ran, as the host counts them: each is a load,
  // when the storage owner keeps its folders again.
  let loads = 0;
  const handedBack = (): void => {
    collector.subscribed(cache().subscriptions());
    held({ folders: cache().storage(), loads });
  };
  const ended = (): void => {
    loads++;
    handedBack();
  };
  const collector: Collector = new Collector({
    clock: systemTimekeeper,
    watched: () => false,
    daemon: () => daemonFactsOf(),
    ...deps,
    // The host hands an output's subscriptions back once the renderer's
    // answer settles, a turn of the event loop after the store took the
    // world state, so a wait resolved inside the take sees no run it names
    // subscribed yet.
    deliver: async (event) => {
      if (routed !== null)
        return routed.deliver(
          () => ({ kind: "event", event, at: instantAt(systemTimekeeper) }),
          [],
        );
      if (event.kind === "world-state") worldStates.take(event.worldState, []);
      else retireSession({ renderCache: cache(), worldStates }, event.session);
      await Promise.resolve();
      handedBack();
      return { kind: "answered" };
    },
  });
  cleanups.push(() => collector.close());
  return {
    collector,
    worldStates,
    serve: (c) => {
      served = c;
    },
    route: (host) => {
      routed = host;
    },
    config: (facts, hold) => {
      worldStates.take(collector.requested(facts, TEST_ENVIRONMENT), []);
      const opened = hold();
      ended();
      return opened;
    },
    ended,
  };
}

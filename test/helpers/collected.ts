// The host's collector and the main renderer's world-state store over a test's
// own render cache, composed as the daemon composes them (src/daemon/daemon.ts,
// src/renderer/main.ts) with no renderer built: a world state the collector
// hands in is taken into the store, a retire closes the session's view and
// drops its document, and every turn's subscriptions go back to the
// collector, as the host hands back every output's (src/daemon/renderer-host.ts).

import { Collector, type CollectorDeps } from "../../src/daemon/collector";
import type { RendererHost } from "../../src/daemon/renderer-host";
import { instantAt } from "../../src/utils/instant";
import { retireSession } from "../../src/renderer/draw-bar";
import type { RenderCache } from "../../src/renderer/render-cache";
import type { CheckedRenderRequest } from "../../src/renderer-interface/request-context";
import { WorldStates } from "../../src/renderer/world-states";
import { systemTimekeeper } from "../../src/time";
import { daemonFactsOf } from "./daemon-facts";
import { TEST_ENVIRONMENT } from "./session-environment";

// What the renderer's turns read of the cache: what a retire closes, and what
// every output says the open views need read.
type Served = Pick<
  RenderCache<never, never>,
  "retireSession" | "subscriptions"
>;

export interface Collected {
  readonly collector: Collector;
  readonly worldStates: WorldStates;
  // The cache the renderer's turns draw from, named once it is built: its
  // views read `worldStates`, so it is built after them.
  serve(cache: Served): void;
  // A session's `config` turn: its world state taken, the session's view
  // opened as `hold` opens it, and the turn's subscriptions handed back.
  config<H>(facts: CheckedRenderRequest, hold: () => H): H;
  // Every input the collector hands in goes through `host` from now on, as
  // the daemon's does, so it takes its place in the host's mailbox behind
  // the turns sent before it: a case whose requests go through `host` must
  // route the collector's inputs there too, or a world state can overtake a
  // config turn still waiting in the mailbox.
  route(host: Pick<RendererHost, "deliver">): void;
}

export function collected(
  deps: Pick<CollectorDeps, "owners" | "log"> &
    Partial<Pick<CollectorDeps, "clock" | "watched" | "daemon">>,
  cleanups: Array<() => void>,
): Collected {
  const worldStates = new WorldStates();
  let served: Served | null = null;
  let routed: Pick<RendererHost, "deliver"> | null = null;
  const cache = (): Served => {
    if (served === null)
      throw new Error("the collector handed in before its cache was served");
    return served;
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
      if (event.kind === "world-state") worldStates.take(event.worldState);
      else retireSession({ renderCache: cache(), worldStates }, event.session);
      await Promise.resolve();
      collector.subscribed(cache().subscriptions());
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
      worldStates.open(facts, collector.requested(facts, TEST_ENVIRONMENT));
      const held = hold();
      collector.subscribed(cache().subscriptions());
      return held;
    },
  };
}

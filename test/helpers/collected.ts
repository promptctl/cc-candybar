// The host's collector and the main renderer's world-state store over a test's
// own render cache, composed as the daemon composes them (src/daemon/daemon.ts,
// src/renderer/main.ts) with no renderer built: a world state the collector
// hands in is taken into the store, a retire closes the session's view and
// drops its document, and every turn's subscriptions go back to the
// collector.

import { Collector, type CollectorDeps } from "../../src/daemon/collector";
import { retireSession } from "../../src/daemon/draw-bar";
import type { RenderCache } from "../../src/daemon/cache/render";
import type { ViewFacts } from "../../src/daemon/render-payload";
import { WorldStates } from "../../src/renderer/world-states";
import { systemTimekeeper } from "../../src/time";

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
  config<H>(facts: ViewFacts, hold: () => H): H;
}

export function collected(
  deps: Pick<CollectorDeps, "owners" | "update" | "log"> &
    Partial<Pick<CollectorDeps, "clock" | "watched">>,
  cleanups: Array<() => void>,
): Collected {
  const worldStates = new WorldStates();
  let served: Served | null = null;
  const cache = (): Served => {
    if (served === null)
      throw new Error("the collector handed in before its cache was served");
    return served;
  };
  const collector: Collector = new Collector({
    clock: systemTimekeeper,
    watched: () => false,
    ...deps,
    deliver: async (event) => {
      if (event.kind === "world-state") {
        worldStates.take(event.worldState);
        return { kind: "answered" };
      }
      retireSession({ renderCache: cache(), worldStates }, event.session);
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
    config: (facts, hold) => {
      worldStates.take(collector.requested(facts));
      const held = hold();
      collector.subscribed(cache().subscriptions());
      return held;
    },
  };
}

// The host parts a click reaches past `replyTo` (src/daemon/reply.ts): the
// main renderer, in process, whose click turn runs the verb table over a
// test's verb context, over a collector that holds and keeps no session unless
// the test hands in its own. A test that builds its daemon parts by hand spreads
// these in.

import type { Collector } from "../../src/daemon/collector";
import { ClicksInFlight } from "../../src/daemon/clicks-in-flight";
import type { DaemonParts } from "../../src/daemon/daemon-parts";
import type { MenuIdle } from "../../src/daemon/menu-idle";
import { rendererHost } from "../../src/daemon/renderer-host";
import { mainRenderer } from "../../src/renderer/main";
import { systemTimekeeper } from "../../src/time";
import {
  verbsOver,
  type DaemonVerbContext,
  type MainRendererParts,
} from "../../src/renderer/verbs";

export function clickParts(
  verbCtx: DaemonVerbContext,
  menuIdle: Pick<MenuIdle, "clickArrived" | "clickSettled">,
  collector: Pick<Collector, "holding" | "clicked"> = {
    holding: () => () => {},
    clicked: () => {},
  },
): Pick<DaemonParts, "renderer" | "clicks"> & {
  collector: Pick<Collector, "holding" | "clicked">;
} {
  // A click's turn reads the verbs, the idle clock and, for its output, the
  // open views' subscriptions: this rig opens none.
  const clicks = new ClicksInFlight();
  const parts = {
    verbs: verbsOver(verbCtx, clicks),
    menuIdle,
    renderCache: { subscriptions: () => ({ sources: {} }) },
  } as unknown as MainRendererParts;
  return {
    renderer: rendererHost(
      "main",
      systemTimekeeper,
      mainRenderer(parts),
      () => {},
      { subscribed: () => {}, holding: collector.holding },
    ),
    clicks,
    collector,
  };
}

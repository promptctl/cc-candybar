// The host parts a click reaches past `replyTo` (src/daemon/reply.ts): the
// main renderer, in process, whose click turn runs the verb table over a
// test's verb context, over a collector that holds and keeps no session unless
// the test hands in its own. A test that builds its daemon parts by hand spreads
// these in.

import { NO_PUSHES } from "./renderers";
import { TEST_SIGNER } from "./link-signer";
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
} from "../../src/renderer/verbs/port";

export function clickParts(
  verbCtx: DaemonVerbContext,
  menuIdle: Pick<MenuIdle, "clickArrived" | "clickSettled">,
  collector: Pick<Collector, "holding" | "clicked"> = {
    holding: () => () => {},
    clicked: () => {},
  },
): Pick<DaemonParts, "renderer" | "clicks" | "linkSigner"> & {
  collector: Pick<Collector, "holding" | "clicked">;
} {
  // A click's turn reads the verbs, the idle clock and, for its output, the
  // open views' subscriptions: this rig opens none.
  const clicks = new ClicksInFlight();
  const parts = {
    verbs: verbsOver(verbCtx, { gone: async (click) => clicks.gone(click) }),
    menuIdle,
    renderCache: { subscriptions: () => ({ sources: {} }) },
    // What the renderer times each turn by.
    clock: systemTimekeeper,
  } as unknown as MainRendererParts;
  return {
    renderer: rendererHost(
      "main",
      systemTimekeeper,
      mainRenderer(parts, NO_PUSHES),
      () => {},
      { subscribed: () => {}, holding: collector.holding },
    ),
    clicks,
    collector,
    linkSigner: TEST_SIGNER,
  };
}

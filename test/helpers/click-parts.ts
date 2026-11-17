// The host parts a click reaches past `replyTo` (src/daemon/reply.ts): the
// main renderer, in process, whose click turn runs the verb table over a
// test's verb context, over a collector that holds and keeps no session unless
// the test hands in its own. A test that builds its daemon parts by hand spreads
// these in.

import { NO_PUSHES } from "./renderers";
import { minter } from "./renderer-parts";
import { TEST_SIGNER } from "./link-signer";
import type { Collector } from "../../src/daemon/collector";
import { ClicksInFlight } from "../../src/daemon/clicks-in-flight";
import type { DaemonParts } from "../../src/daemon/daemon-parts";
import type { MenuIdle } from "../../src/daemon/menu-idle";
import { rendererHost, type HostWorld } from "../../src/daemon/renderer-host";
import type { ActsOnTheirWay } from "../../src/renderer/acts";
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
  // What the host's turns act in: by default, an act it is handed fails by
  // name, so a test whose click asks one hands in its own performer.
  world: HostWorld = {
    perform: async (act) => ({
      kind: "failed",
      reason: `${act.kind}: no host part in this rig`,
    }),
    stateDir: verbCtx.stateDir,
    closing: () => false,
    unheard: () => {},
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
    // No view is open, so no lane is read.
    laneActs: { noted: () => {}, clicked: () => {} },
    // What the renderer times each turn by.
    clock: systemTimekeeper,
    mint: minter(),
    // The acts the test's verb context asks, settled by this rig's host.
    acts: verbCtx.acts as ActsOnTheirWay,
    // The doctor runs the test's clicks start, whose asks the turn names.
    doctorRuns: verbCtx.doctorRuns,
  } as unknown as MainRendererParts;
  return {
    renderer: rendererHost(
      "main",
      systemTimekeeper,
      mainRenderer(parts, NO_PUSHES),
      () => {},
      {
        subscribed: () => {},
        holding: collector.holding,
        writableSettings: () => [],
      },
      world,
    ),
    clicks,
    collector,
    linkSigner: TEST_SIGNER,
  };
}

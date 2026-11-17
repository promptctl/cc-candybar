// The host parts a click reaches past `replyTo` (src/daemon/reply.ts): the
// main renderer, in process, whose click turn runs the verb table over a
// test's verb context, over a collector that holds and keeps no session unless
// the test hands in its own. A test that builds its daemon parts by hand spreads
// these in.

import { holdable, NO_PUSHES } from "./renderers";
import { minter } from "./renderer-parts";
import { TEST_SIGNER } from "./link-signer";
import type { Collector } from "../../src/daemon/collector";
import type { DaemonParts } from "../../src/daemon/daemon-parts";
import { rendererHost, type HostWorld } from "../../src/daemon/renderer-host";
import type { ActsOnTheirWay } from "../../src/renderer/acts";
import { mainRenderer } from "../../src/renderer/main";
import { systemTimekeeper } from "../../src/time";
import { instantOf } from "../../src/utils/instant";
import {
  verbsOver,
  type DaemonVerbContext,
  type MainRendererParts,
} from "../../src/renderer/verbs/port";

export function clickParts(
  verbCtx: DaemonVerbContext,
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
): Pick<DaemonParts, "renderer" | "linkSigner"> & {
  collector: Pick<Collector, "holding" | "clicked">;
  // Another turn, held in the renderer's mailbox until `open`: every input
  // sent after it waits there, in flight.
  park: () => { readonly open: () => void; readonly holding: Promise<unknown> };
} {
  // A click's turn reads the verbs and, for its output, the open views'
  // subscriptions: this rig opens none.
  const parts = {
    verbs: verbsOver(verbCtx),
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
  // The teardown's journal step, answered as the main renderer answers it, in
  // its place in the mailbox: no other push is a click's.
  const held = holdable(
    mainRenderer(parts, (push) => {
      if (push.kind !== "close-journal") return NO_PUSHES();
      verbCtx.configWrites.close();
      return { kind: "close-journal" };
    }),
  );
  const renderer = rendererHost(
    "main",
    systemTimekeeper,
    held.renderer,
    () => {},
    {
      subscribed: () => {},
      holding: collector.holding,
      writableSettings: () => [],
    },
    world,
  );
  return {
    renderer,
    collector,
    linkSigner: TEST_SIGNER,
    park: () => {
      const open = held.hold();
      const holding = renderer.deliver(
        () => ({
          kind: "event",
          at: instantOf(new Date()),
          event: { kind: "start", sessions: [] },
        }),
        [],
      );
      return { open, holding };
    },
  };
}

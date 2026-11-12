// The host parts a click reaches past `replyTo` (src/daemon/reply.ts): the
// main renderer, in process, whose click turn runs the verb table over a
// test's verb context, over a collector that holds and keeps no session unless
// the test hands in its own. A test that builds its daemon parts by hand spreads
// these in.

import type { Collector } from "../../src/daemon/collector";
import type { DaemonParts } from "../../src/daemon/daemon-parts";
import type { MenuIdle } from "../../src/daemon/menu-idle";
import { rendererHost } from "../../src/daemon/renderer-host";
import { mainRenderer } from "../../src/renderer/main";
import { CopyFailures } from "../../src/renderer/copy-failures";
import type { EffectOutcome } from "../../src/renderer/interface";
import { systemTimekeeper } from "../../src/time";
import {
  verbsOver,
  type DaemonVerbContext,
  type MainRendererParts,
} from "../../src/renderer/verbs";

// A clipboard no write reaches: each is a failed copy, which the renderer
// holds for the bar.
export const NO_CLIPBOARD = async (): Promise<EffectOutcome> => ({
  kind: "failed",
  reason: "no clipboard in this test",
});

export function clickParts(
  verbCtx: DaemonVerbContext,
  menuIdle: Pick<MenuIdle, "clickArrived" | "clickSettled">,
  collector: Pick<Collector, "holding" | "clicked"> = {
    holding: () => () => {},
    clicked: () => {},
  },
  // Where a copy click's text goes: by default nowhere.
  clipboard: (text: string) => Promise<EffectOutcome> = NO_CLIPBOARD,
): Pick<DaemonParts, "renderer"> & {
  collector: Pick<Collector, "holding" | "clicked">;
} {
  // A click's turn reads the verbs, the idle clock and, for its output, the
  // open views' subscriptions: this rig opens none.
  const parts = {
    verbs: verbsOver(verbCtx),
    menuIdle,
    renderCache: { subscriptions: () => ({ sources: {} }) },
    copyFailures: new CopyFailures(),
  } as unknown as MainRendererParts;
  return {
    renderer: rendererHost(
      "main",
      systemTimekeeper,
      mainRenderer(parts),
      () => {},
      clipboard,
      { subscribed: () => {}, holding: collector.holding },
    ),
    collector,
  };
}

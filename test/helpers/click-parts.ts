// The host parts a click reaches past `replyTo` (src/daemon/reply.ts): the
// main renderer, in process, whose click turn runs the verb table over a
// test's verb context, over a collector that holds no session unless the test
// hands in its own holds. A test that builds its daemon parts by hand spreads
// these in.

import type { DaemonParts } from "../../src/daemon/daemon-parts";
import type { MenuIdle } from "../../src/daemon/menu-idle";
import { rendererHost } from "../../src/daemon/renderer-host";
import type { SessionId } from "../../src/daemon/session-id";
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
  holding: (session: SessionId) => () => void = () => () => {},
): Pick<DaemonParts, "renderer"> {
  // A click's turn reads the verbs, the idle clock and, for its output, the
  // open views' subscriptions: this rig opens none.
  const parts = {
    verbs: verbsOver(verbCtx),
    menuIdle,
    renderCache: { subscriptions: () => ({ sources: {} }) },
  } as unknown as MainRendererParts;
  return {
    renderer: rendererHost(
      "main",
      systemTimekeeper,
      mainRenderer(parts),
      () => {},
      { subscribed: () => {}, holding },
    ),
  };
}

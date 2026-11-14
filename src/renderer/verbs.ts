// What the renderer's click and menu-idle turns act through: the verb table's
// handlers over the daemon's verb context (src/daemon/verbs/index.ts). Every
// verb still acts in place, on the session state, the render cache, the
// launcher and tmux, until the spec's plan step 2 returns its act as an
// effect (docs/design/host-and-renderer.md §12).

import type { RendererParts } from "../daemon/draw-bar.js";
import type { MenuIdle } from "../daemon/menu-idle.js";
import type { SessionId } from "../daemon/session-id.js";
import type { ClicksInFlight } from "../daemon/clicks-in-flight.js";
import type { RequestId } from "./interface.js";
import {
  closeIdleMenus,
  VERBS,
  type IdleClose,
  type VerbContext,
} from "../daemon/verbs/index.js";

// What the verb context holds of one click: how it arrived, where its waits
// are noted, and whether its client is gone.
type VerbClickFacts = Pick<
  VerbContext,
  "arrival" | "placeWaited" | "gatherTook" | "turnWaited" | "clientGone"
>;

// The facts the renderer brings of one click: the same, the click named by its
// request for whether its client is gone, which the host answers.
export type ClickFacts = Omit<VerbClickFacts, "clientGone"> & {
  readonly click: RequestId;
};

// The daemon's verb context, less what each click brings.
export type DaemonVerbContext = Omit<VerbContext, keyof VerbClickFacts>;

// [LAW:locality-or-seam] The renderer's port onto the verbs, so a renderer
// test hands in the act it means to observe.
export interface RendererVerbs {
  // The handler for `verb`, or undefined for a verb the table does not have.
  handler(
    verb: string,
  ): ((value: string, click: ClickFacts) => Promise<void>) | undefined;
  // The idle clock's close of the session's menus: the journaled write a ✕
  // makes.
  closeIdle(sessionId: SessionId, idle: IdleClose): Promise<void>;
}

// The main renderer's parts: the draw's, which the host's own frames share,
// the verbs its click and menu-idle turns act through, and the idle clock's
// count of the clicks in flight and its say over whether a close goes ahead.
export type MainRendererParts = RendererParts & {
  readonly verbs: RendererVerbs;
  readonly menuIdle: Pick<
    MenuIdle,
    "clickArrived" | "clickSettled" | "confirmClose"
  >;
};

// [LAW:single-enforcer] The verb table over the one verb context the daemon
// builds. [LAW:dataflow-not-control-flow] The dispatch is a table lookup: the
// verb table (src/daemon/verbs/index.ts) is the one list of supported verbs,
// and their handlers live there.
// [LAW:effects-at-boundaries] exception: the verbs still act in place, so the
// port is where a click's id meets the host's answer of whether its client
// left.
export function verbsOver(
  ctx: DaemonVerbContext,
  clicks: Pick<ClicksInFlight, "gone">,
): RendererVerbs {
  return {
    handler: (verb) => {
      const handler = VERBS.get(verb);
      return (
        handler &&
        ((value, { click, ...facts }) =>
          handler(value, {
            ...ctx,
            ...facts,
            clientGone: () => clicks.gone(click),
          }))
      );
    },
    closeIdle: (sessionId, idle) => closeIdleMenus(sessionId, idle, ctx),
  };
}

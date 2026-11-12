// What the renderer's click and menu-idle turns act through: the verb table's
// handlers over the daemon's verb context (src/daemon/verbs/index.ts). A copy
// is returned as an effect the host performs; every other verb still acts in
// place, on the session state, the render cache, the
// launcher and tmux, until the spec's plan step 2 returns its act as an
// effect (docs/design/host-and-renderer.md §12).

import type { RendererParts } from "../daemon/draw-bar.js";
import type { MenuIdle } from "../daemon/menu-idle.js";
import type { SessionId } from "../daemon/session-id.js";
import type { CopyFailures } from "./copy-failures.js";
import {
  closeIdleMenus,
  VERBS,
  type IdleClose,
  type VerbContext,
} from "../daemon/verbs/index.js";

// The facts one click brings to its verb: how it arrived, whether its client
// is gone, where its waits are noted, and where its copies are returned.
export type ClickFacts = Pick<
  VerbContext,
  | "arrival"
  | "placeWaited"
  | "gatherTook"
  | "turnWaited"
  | "clientGone"
  | "copy"
>;

// The daemon's verb context, less what each click brings.
export type DaemonVerbContext = Omit<VerbContext, keyof ClickFacts>;

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
// its record of the copies that failed, the verbs its click and menu-idle turns act through, and the idle clock's
// count of the clicks in flight.
export type MainRendererParts = RendererParts & {
  // Written by the renderer's effect-done turn, as well as read by its draws.
  readonly copyFailures: CopyFailures;
  readonly verbs: RendererVerbs;
  readonly menuIdle: Pick<MenuIdle, "clickArrived" | "clickSettled">;
};

// [LAW:single-enforcer] The verb table over the one verb context the daemon
// builds. [LAW:dataflow-not-control-flow] The dispatch is a table lookup: the
// verb table (src/daemon/verbs/index.ts) is the one list of supported verbs,
// and their handlers live there.
export function verbsOver(ctx: DaemonVerbContext): RendererVerbs {
  return {
    handler: (verb) => {
      const handler = VERBS.get(verb);
      return (
        handler && ((value, click) => handler(value, { ...ctx, ...click }))
      );
    },
    closeIdle: (sessionId, idle) => closeIdleMenus(sessionId, idle, ctx),
  };
}

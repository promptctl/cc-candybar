// What the renderer's click and menu-idle turns act through: the verb table's
// handlers over the daemon's verb context (src/renderer/verbs/index.ts). A
// click's config writes are effects its turn returns; every other verb still
// acts in place, on the session state, the render cache, the launcher and
// tmux, until the spec's plan step 2 returns its act as an effect
// (docs/design/host-and-renderer.md §12).

import type { RendererParts } from "../draw-bar.js";
import type { SessionId } from "../../daemon/foundations/session-id.js";
import type { AdapterToHost } from "../../renderer-interface/adapter.js";
import type {
  Effect,
  EffectId,
  EffectOutcome,
  RequestId,
} from "../../renderer-interface/interface.js";
import type { CheckedRenderRequest } from "../../renderer-interface/request-context.js";
import type { ChangeOnItsWay, ConfigWrites } from "../config-writes.js";
import {
  changeLanded,
  closeIdleMenus,
  VERBS,
  type IdleClose,
  type VerbContext,
} from "./index.js";

// What the verb context holds of one click: how it arrived, where its waits
// are noted, whether its client is gone, and where its config writes go.
type VerbClickFacts = Pick<
  VerbContext,
  | "arrival"
  | "placeWaited"
  | "gatherTook"
  | "turnWaited"
  | "clientGone"
  | "latest"
  | "land"
>;

// The facts the renderer brings of one click: the same, the click named by its
// request for whether its client is gone, which the host answers, and its
// turn's effects, which its config writes join.
export type ClickFacts = Omit<VerbClickFacts, "clientGone" | "land"> & {
  readonly click: RequestId;
  readonly effects: Effect[];
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
  closeIdle(
    sessionId: SessionId,
    latest: CheckedRenderRequest | null,
    idle: IdleClose,
  ): Promise<void>;
  // How a click's config change landed, in its `effect-done`'s turn.
  landed(change: ChangeOnItsWay, outcome: EffectOutcome): void;
}

// The main renderer's parts: the draw's, which the host's own frames share,
// the verbs its click and menu-idle turns act through, its effects' ids, and
// the config changes on their way.
export type MainRendererParts = RendererParts & {
  readonly verbs: RendererVerbs;
  readonly mint: () => EffectId;
  readonly writes: ConfigWrites;
};

// [LAW:single-enforcer] The verb table over the one verb context the daemon
// builds. [LAW:dataflow-not-control-flow] The dispatch is a table lookup: the
// verb table (src/renderer/verbs/index.ts) is the one list of supported verbs,
// and their handlers live there.
// [LAW:effects-at-boundaries] exception: the verbs still act in place, so the
// port is where a click's id meets the host's answer of whether its client
// left. A click's config writes go into its turn's effects, through `writes`.
export function verbsOver(
  ctx: DaemonVerbContext,
  clicks: AdapterToHost["clicks"],
  writes: ConfigWrites,
): RendererVerbs {
  return {
    handler: (verb) => {
      const handler = VERBS.get(verb);
      return (
        handler &&
        ((value, { click, effects, ...facts }) =>
          handler(value, {
            ...ctx,
            ...facts,
            clientGone: () => clicks.gone(click),
            land: (session, path, before, after) =>
              writes.land(
                effects,
                { session, path, latest: facts.latest },
                before,
                after,
              ),
          }))
      );
    },
    closeIdle: (sessionId, latest, idle) =>
      closeIdleMenus(sessionId, latest, idle, ctx),
    landed: (change, outcome) => changeLanded(ctx, change, outcome),
  };
}

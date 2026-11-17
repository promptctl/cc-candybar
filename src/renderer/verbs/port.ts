// What the renderer's click and menu-idle turns act through: the verb table's
// handlers over the daemon's verb context (src/renderer/verbs/index.ts). A
// verb writes the session state and the config in its turn, and asks
// everything else of the host as an act its turn returns.

import type { RendererParts } from "../draw-bar.js";
import type { SessionId } from "../../daemon/foundations/session-id.js";
import type {
  Effect,
  EffectId,
  EffectOutcome,
} from "../../renderer-interface/interface.js";
import type { CheckedRenderRequest } from "../../renderer-interface/request-context.js";
import type { ActsOnTheirWay } from "../acts.js";
import type { DoctorRuns } from "../doctor.js";
import {
  changeDone,
  closeIdleMenus,
  VERBS,
  type VerbContext,
} from "./index.js";

// What the verb context holds of one click: how it arrived, the newest
// request of its session, and its turn's effects.
export type ClickFacts = Pick<VerbContext, "arrival" | "latest" | "effects">;

// The daemon's verb context, less what each click brings.
export type DaemonVerbContext = Omit<VerbContext, keyof ClickFacts>;

// [LAW:locality-or-seam] The renderer's port onto the verbs, so a renderer
// test hands in the act it means to observe.
export interface RendererVerbs {
  // The handler for `verb`, or undefined for a verb the table does not have.
  handler(
    verb: string,
  ): ((value: string, click: ClickFacts) => void) | undefined;
  // The idle close of the session's menus: the journaled write a ✕ makes.
  closeIdle(
    sessionId: SessionId,
    latest: CheckedRenderRequest | null,
    idle: { readonly idleS: number; readonly timeoutS: number },
    effects: Effect[],
  ): void;
  // A change's `effect-done`, in its turn, whose effects what its click's
  // consequence asks joins: false for an id no click's change holds.
  changeDone(id: EffectId, outcome: EffectOutcome, effects: Effect[]): boolean;
}

// The main renderer's parts: the draw's, which the host's own frames share,
// and the verbs its click and menu-idle turns act through.
export type MainRendererParts = RendererParts & {
  readonly verbs: RendererVerbs;
  // [LAW:one-source-of-truth] The one minter of this renderer's effect ids,
  // a present's, a change's and an act's alike.
  readonly mint: () => EffectId;
  // The acts this renderer's turns asked of the host, until each is settled.
  readonly acts: Pick<ActsOnTheirWay, "done">;
  // Each session's doctor run: what its output asks read, and what a retire
  // ends.
  readonly doctorRuns: Pick<DoctorRuns, "subscriptions" | "retire">;
};

// [LAW:single-enforcer] The verb table over the one verb context the daemon
// builds. [LAW:dataflow-not-control-flow] The dispatch is a table lookup: the
// verb table (src/renderer/verbs/index.ts) is the one list of supported verbs,
// and their handlers live there.
export function verbsOver(ctx: DaemonVerbContext): RendererVerbs {
  return {
    handler: (verb) => {
      const handler = VERBS.get(verb);
      return (
        handler && ((value, facts) => handler(value, { ...ctx, ...facts }))
      );
    },
    closeIdle: (sessionId, latest, idle, effects) =>
      closeIdleMenus(sessionId, latest, idle, ctx, effects),
    changeDone: (id, outcome, effects) => changeDone(ctx, id, outcome, effects),
  };
}

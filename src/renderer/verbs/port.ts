// What the renderer's click and menu-idle turns act through: the verb table's
// handlers over the daemon's verb context (src/renderer/verbs/index.ts). A
// verb writes the session state and the config in its turn, and asks
// everything else of the host as an act its turn returns.

import type { AdmittedClick } from "../../click/wire.js";
import type { RendererParts } from "../draw-bar.js";
import type { SessionId } from "../../daemon/foundations/session-id.js";
import type {
  Effect,
  EffectId,
  EffectOutcome,
  RendererStats,
} from "../../renderer-interface/interface.js";
import type { IdleSpan, MenuIdle } from "../menu-idle.js";
import type { Feeds } from "../feeds.js";
import type { SessionContext } from "../../renderer-interface/request-context.js";
import type { EditTransactions } from "../edit-transaction.js";
import type { RenderOrigin } from "../../config-hint.js";
import type { ActsOnTheirWay } from "../acts.js";
import type { TurnLog } from "../turn-log.js";
import type { ConfigWrites } from "../config-writes.js";
import {
  changeDone,
  closeIdleMenus,
  runClick,
  type VerbContext,
} from "./index.js";

// What the verb context holds of one click: how it arrived, its session's
// context, and its turn's effects.
export type ClickFacts = Pick<
  VerbContext,
  "arrival" | "context" | "effects" | "record"
>;

// The daemon's verb context, less what each click brings.
export type DaemonVerbContext = Omit<VerbContext, keyof ClickFacts>;

// [LAW:locality-or-seam] The renderer's port onto the verbs, so a renderer
// test hands in the act it means to observe.
export interface RendererVerbs {
  click(click: AdmittedClick, facts: ClickFacts): void;
  // The close of the session's menus when its idle period runs out: the
  // journaled write a ✕ makes, with the session's live context.
  closeIdle(
    sessionId: SessionId,
    context: SessionContext | null,
    idle: IdleSpan,
    effects: Effect[],
  ): void;
  // A change's `effect-done`, in its turn, whose effects what its click's
  // consequence asks joins: false for an id no click's change holds.
  changeDone(id: EffectId, outcome: EffectOutcome, effects: Effect[]): boolean;
  // The origin of the click whose changes are on their way: its consequence
  // waits on its landing, over that origin's config as the landing left it.
  landing(): RenderOrigin | null;
}

// The main renderer's parts: the draw's, which the host's own frames share,
// and the verbs its click and menu-idle turns act through.
export type MainRendererParts = RendererParts & {
  readonly turnLog: TurnLog;
  readonly configWrites: Pick<ConfigWrites, "close">;
  readonly sessionStats: () => RendererStats["sessionState"];
  // The owners of a tick a `due` runs: the draw reads only part of each.
  readonly menuIdle: MenuIdle;
  readonly feeds: Feeds;
  readonly verbs: RendererVerbs;
  readonly edits: EditTransactions;
  // [LAW:one-source-of-truth] The one minter of this renderer's effect ids,
  // a present's, a change's and an act's alike.
  readonly mint: () => EffectId;
  // The acts this renderer's turns asked of the host, until each is settled.
  readonly acts: Pick<ActsOnTheirWay, "done">;
};

// The production port binds the verb table to the renderer's state owners.
export function verbsOver(ctx: DaemonVerbContext): RendererVerbs {
  return {
    click: (click, facts) => runClick(click, { ...ctx, ...facts }),
    closeIdle: (sessionId, context, idle, effects) =>
      closeIdleMenus(sessionId, context, idle, ctx, effects),
    changeDone: (id, outcome, effects) => changeDone(ctx, id, outcome, effects),
    landing: () => ctx.configWrites.landing(),
  };
}

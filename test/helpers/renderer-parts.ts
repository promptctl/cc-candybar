import { EditTransactions } from "../../src/renderer/edit-transaction.js";
// The main renderer's parts over a test's own render cache, session state,
// world states and owners (src/renderer/draw-bar.ts RendererParts).

import type { SessionState } from "../../src/renderer/session-state";
import type {
  MainRendererParts,
  RendererVerbs,
} from "../../src/renderer/verbs/port";
import type { WorldStates } from "../../src/renderer/world-states";
import type { EffectId } from "../../src/renderer-interface/interface";
import { TurnTime } from "../../src/renderer/turn-time";
import { TurnLog } from "../../src/renderer/turn-log";
import { FEED_PERIODS, Feeds } from "../../src/renderer/feeds";

// A renderer that acts no verb: every click names a verb it does not have,
// and an idle close is refused, so a test that clicks hands in the act it
// means to observe.
export const NO_VERBS: RendererVerbs = {
  click: () => {},
  closeIdle: () => {
    throw new Error("this rig closes no menus");
  },
  // A rig's verbs write no config, so no `effect-done` is a change's, and no
  // click's landing is on its way.
  changeDone: () => false,
  landing: () => null,
};

// Feeds no session is watched in: none draws.
export const noFeeds = (): Feeds =>
  new Feeds({
    draw: () => null,
    pin: () => () => {},
    log: () => {},
    periods: FEED_PERIODS,
  });

// A renderer's effect ids, from 1.
export const minter = (): (() => EffectId) => {
  let minted = 0;
  return () => ++minted as EffectId;
};

export function rendererParts({
  cache,
  sessionState,
  worldStates,
  verbs = NO_VERBS,
}: {
  readonly cache: unknown;
  readonly sessionState: SessionState;
  readonly worldStates: WorldStates;
  readonly verbs?: RendererVerbs;
}): MainRendererParts {
  const renderCache = cache as MainRendererParts["renderCache"];
  return {
    // The rig's own time: a test drawing outside a turn runs it in one
    // (`time.during`).
    time: new TurnTime(),
    turnLog: new TurnLog(),
    // No feed follows a session, and nothing is idle.
    menuIdle: renderCache.presentations.menuIdle,
    feeds: noFeeds(),
    sessionState,
    renderCache,
    worldStates,
    // A rig's sessions have no lane switched, so no setup is owed.
    verbs,
    edits: new EditTransactions(sessionState, () => {}),
    mint: minter(),
    // A rig's verbs ask no act, so no `effect-done` is an act's.
    acts: { done: () => false },
  };
}

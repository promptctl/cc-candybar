import { EditTransactions } from "../../src/renderer/edit-transaction.js";
// The main renderer's parts over a test's own render cache, session state,
// world states and owners (src/renderer/draw-bar.ts RendererParts), with an
// inert host (`AdapterToHost`, src/renderer-interface/adapter.ts) for what its
// side reaches. No daemon is built.

import { RenderWarningRecords } from "../../src/renderer/render-warnings";
import type { SessionState } from "../../src/renderer/session-state";
import { EffectSessions } from "../../src/render/effect";
import type {
  MainRendererParts,
  RendererVerbs,
} from "../../src/renderer/verbs/port";
import type { WorldStates } from "../../src/renderer/world-states";
import type { AdapterToHost } from "../../src/renderer-interface/adapter";
import { TEST_SIGNER } from "./link-signer";
import type { EffectId } from "../../src/renderer-interface/interface";
import { TurnTime } from "../../src/renderer/turn-time";
import { MenuIdle } from "../../src/renderer/menu-idle";
import { FEED_PERIODS, Feeds } from "../../src/renderer/feeds";

// A renderer that acts no verb: every click names a verb it does not have,
// and an idle close is refused, so a test that clicks hands in the act it
// means to observe.
export const NO_VERBS: RendererVerbs = {
  handler: () => undefined,
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

// [LAW:no-silent-failure] A reach this rig has no host part for throws by
// name, so a test that starts to depend on one says so.
const unhosted = (what: string) => (): never => {
  throw new Error(`${what}: no host part in this rig`);
};

// The host a renderer test draws against: no update is offered, and file
// events are heard.
export function inertHost(): AdapterToHost {
  return {
    log: () => {},
    eventAnswered: () => {},
    storage: { hold: unhosted("storage"), release: unhosted("storage") },
  };
}

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
  return {
    ...inertHost(),
    // The rig's own time: a test drawing outside a turn runs it in one
    // (`time.during`).
    time: new TurnTime(),
    // No feed follows a session, and nothing is idle.
    menuIdle: new MenuIdle(),
    feeds: noFeeds(),
    linkSigner: TEST_SIGNER,
    sessionState,
    renderCache: cache as never,
    worldStates,
    renderWarnings: new RenderWarningRecords(),
    effectSessions: new EffectSessions(),
    // A rig's sessions have no lane switched, so no setup is owed.
    verbs,
    edits: new EditTransactions(sessionState, () => {}),
    mint: minter(),
    // A rig's verbs ask no act, so no `effect-done` is an act's.
    acts: { done: () => false },
  };
}

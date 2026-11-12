// The main renderer's parts over a test's own render cache, session state,
// world states and owners (src/daemon/draw-bar.ts RendererParts), with narrow
// fakes for the host parts its side still reaches. No daemon is built.

import { UNFOLLOWED_FEEDS } from "../../src/config/lanes";
import { RenderWarningRecords } from "../../src/daemon/render-warnings";
import type { SessionState } from "../../src/daemon/session-state";
import { EffectSessions } from "../../src/render/effect";
import type { MainRendererParts, RendererVerbs } from "../../src/renderer/verbs";
import type { WorldStates } from "../../src/renderer/world-states";
import { systemTimekeeper } from "../../src/time";
import { TEST_SIGNER } from "./link-signer";

// A renderer that acts no verb: every click names a verb it does not have,
// and an idle close is refused, so a test that clicks hands in the act it
// means to observe.
const NO_VERBS: RendererVerbs = {
  handler: () => undefined,
  closeIdle: () => Promise.reject(new Error("this rig closes no menus")),
};

export function rendererParts({
  cache,
  sessionState,
  worldStates,
  providers,
  verbs = NO_VERBS,
}: {
  readonly cache: unknown;
  readonly sessionState: SessionState;
  readonly worldStates: WorldStates;
  readonly providers: unknown;
  readonly verbs?: RendererVerbs;
}): MainRendererParts {
  return {
    clock: systemTimekeeper,
    log: () => {},
    sessionState,
    renderCache: cache as never,
    worldStates,
    payloadProviders: providers as never,
    linkSigner: TEST_SIGNER,
    renderWarnings: new RenderWarningRecords(),
    effectSessions: new EffectSessions(),
    frameFeeds: { feedsOf: () => UNFOLLOWED_FEEDS, following: () => new Set() },
    updateWatch: { notice: () => ({ offer: [], failure: [] }), error: () => null },
    fileEvents: {
      delivery: () => ({ kind: "delivering", unreported: [], missedSince: null }),
    },
    menuIdle: {
      observe: () => {},
      since: () => undefined,
      clickArrived: () => {},
      clickSettled: () => {},
    },
    launcher: { launcherWarnings: () => [], answeredPipeEvent: () => {} },
    laneSetups: { noted: () => {} },
    tmuxStatusLines: { observe: () => {} },
    verbs,
  };
}

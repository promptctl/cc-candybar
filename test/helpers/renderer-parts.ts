// The main renderer's parts over a test's own render cache, session state,
// world states and owners (src/daemon/draw-bar.ts RendererParts), with narrow
// fakes for the host parts its side still reaches. No daemon is built.

import { UNFOLLOWED_FEEDS } from "../../src/config/lanes";
import type { RendererParts } from "../../src/daemon/draw-bar";
import { RenderWarningRecords } from "../../src/daemon/render-warnings";
import type { SessionState } from "../../src/daemon/session-state";
import { EffectSessions } from "../../src/render/effect";
import type { WorldStates } from "../../src/renderer/world-states";
import { systemTimekeeper } from "../../src/time";
import { TEST_SIGNER } from "./link-signer";

export function rendererParts({
  cache,
  sessionState,
  worldStates,
  providers,
}: {
  readonly cache: unknown;
  readonly sessionState: SessionState;
  readonly worldStates: WorldStates;
  readonly providers: unknown;
}): RendererParts {
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
    menuIdle: { observe: () => {}, since: () => undefined },
    launcher: { launcherWarnings: () => [], answeredPipeEvent: () => {} },
    laneSetups: { noted: () => {} },
    tmuxStatusLines: { observe: () => {} },
  };
}

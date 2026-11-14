// The main renderer's parts over a test's own render cache, session state,
// world states and owners (src/renderer/draw-bar.ts RendererParts), with an
// inert host (`AdapterToHost`, src/renderer-interface/adapter.ts) for what its
// side reaches. No daemon is built.

import { UNFOLLOWED_FEEDS } from "../../src/config/lanes";
import { RenderWarningRecords } from "../../src/renderer/render-warnings";
import type { SessionState } from "../../src/renderer/session-state";
import { EffectSessions } from "../../src/render/effect";
import type {
  MainRendererParts,
  RendererVerbs,
} from "../../src/renderer/verbs/port";
import type { WorldStates } from "../../src/renderer/world-states";
import type { AdapterToHost } from "../../src/renderer-interface/adapter";
import { UNOWNED_STORAGE } from "../../src/renderer/render-cache";
import {
  readingsHost,
  type RenderPayloadDeps,
} from "../../src/daemon/readings";
import { JournalTurns } from "../../src/daemon/journal-turns";
import {
  applyFix,
  gatherFacts,
  installFacts,
  oneAskPerClick,
  readStores,
} from "../../src/doctor/edge";
import { systemTimekeeper } from "../../src/time";
import { TEST_SIGNER } from "./link-signer";
import { unscriptedLauncher } from "./fake-launcher";

// A renderer that acts no verb: every click names a verb it does not have,
// and an idle close is refused, so a test that clicks hands in the act it
// means to observe.
const NO_VERBS: RendererVerbs = {
  handler: () => undefined,
  closeIdle: () => Promise.reject(new Error("this rig closes no menus")),
};

// [LAW:no-silent-failure] A reach this rig has no host part for throws by
// name, so a test that starts to depend on one says so.
const unhosted = (what: string) => (): never => {
  throw new Error(`${what}: no host part in this rig`);
};

// The host a renderer test draws against: no feed follows a session, no
// update is offered, file events are heard, nothing is idle and nothing is
// set up; a request's refresh and the cache tallies are the test's owners'.
export function inertHost(providers: RenderPayloadDeps): AdapterToHost {
  return {
    frameFeeds: {
      feedsOf: () => UNFOLLOWED_FEEDS,
      following: () => new Set(),
      latest: () => null,
      wake: () => {},
    },
    updateWatch: {
      notice: () => ({ offer: [], failure: [] }),
      error: () => null,
    },
    fileEvents: {
      delivery: () => ({
        kind: "delivering",
        unreported: [],
        missedSince: null,
      }),
    },
    menuIdle: {
      clicked: () => {},
      observe: () => {},
      since: () => undefined,
      clickArrived: () => {},
      clickSettled: () => {},
      confirmClose: () => true,
    },
    launcher: unscriptedLauncher,
    laneSetups: { noted: () => {}, clicked: () => {} },
    tmuxStatusLines: { observe: () => {} },
    clicks: { gone: () => false },
    ...readingsHost(providers),
    managedStorage: UNOWNED_STORAGE,
    watchers: { acquire: unhosted("watchers"), follow: unhosted("watchers") },
    linkSigner: TEST_SIGNER,
    journalTurns: new JournalTurns({
      log: () => {},
      monotonic: () => systemTimekeeper.monotonic(),
    }),
    runs: { start: unhosted("runs"), refused: unhosted("runs") },
    serving: unhosted("serving"),
    renderSightings: { ofSession: () => [] },
    probes: { arrive: unhosted("probes") },
    doctor: {
      gatherFacts,
      applyFix,
      installFacts,
      readStores,
      oneAskPerClick,
      edge: unhosted("doctor edge"),
      stores: {
        marks: {
          read: unhosted("doctor stores"),
          update: unhosted("doctor stores"),
        },
        clicked: {
          read: unhosted("doctor stores"),
          update: unhosted("doctor stores"),
        },
        postMortemsRead: {
          read: unhosted("doctor stores"),
          update: unhosted("doctor stores"),
        },
      },
    },
    claudeInput: {
      read: unhosted("claude input"),
      type: unhosted("claude input"),
    },
    applyUpdate: () =>
      Promise.reject(new Error("apply-update: no update watch in this rig")),
  };
}

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
  // The rig's owners, as loosely typed as the rig's fakes are.
  readonly providers: unknown;
  readonly verbs?: RendererVerbs;
}): MainRendererParts {
  return {
    ...inertHost(providers as RenderPayloadDeps),
    clock: systemTimekeeper,
    log: () => {},
    sessionState,
    renderCache: cache as never,
    worldStates,
    renderWarnings: new RenderWarningRecords(),
    effectSessions: new EffectSessions(),
    verbs,
  };
}

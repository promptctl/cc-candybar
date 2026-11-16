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
import { systemTimekeeper } from "../../src/time";
import { TEST_SIGNER } from "./link-signer";
import type { EffectId } from "../../src/renderer-interface/interface";

// A renderer that acts no verb: every click names a verb it does not have,
// and an idle close is refused, so a test that clicks hands in the act it
// means to observe.
export const NO_VERBS: RendererVerbs = {
  handler: () => undefined,
  closeIdle: () => Promise.reject(new Error("this rig closes no menus")),
  // A rig's verbs write no config, so no `effect-done` is a change's.
  changeDone: () => false,
};

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

// The host a renderer test draws against: no feed follows a session, no
// update is offered, file events are heard, and nothing is idle.
export function inertHost(): AdapterToHost {
  return {
    wake: () => {},
    log: () => {},
    doctor: {
      probeTmux: unhosted("doctor"),
      remoteLogin: unhosted("doctor"),
      fontInUse: unhosted("doctor"),
      daemons: unhosted("doctor"),
      forge: unhosted("doctor"),
      transcript: unhosted("doctor"),
      install: unhosted("doctor"),
    },
    menuIdle: {
      clicked: () => {},
      observe: () => {},
      clickArrived: () => {},
      clickSettled: () => {},
      confirmClose: async () => true,
    },
    clicks: { gone: async () => false },
    serving: unhosted("serving"),
    renderSightings: { ofSession: async () => [] },
    eventAnswered: () => {},
    watches: { watch: unhosted("watches"), unwatch: unhosted("watches") },
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
    clock: systemTimekeeper,
    linkSigner: TEST_SIGNER,
    sessionState,
    renderCache: cache as never,
    worldStates,
    renderWarnings: new RenderWarningRecords(),
    effectSessions: new EffectSessions(),
    // A rig's sessions have no lane switched, so no setup is owed.
    laneActs: { noted: () => {}, clicked: () => {} },
    verbs,
    mint: minter(),
    // A rig's verbs ask no act, so no `effect-done` is an act's.
    acts: { done: () => false },
  };
}

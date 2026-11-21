// The host parts a click reaches past `replyTo` (src/daemon/reply.ts): the
// main renderer, in process, whose click turn runs the verb table over a
// test's verb context, over a collector that holds and keeps no session unless
// the test hands in its own. A test that builds its daemon parts by hand spreads
// these in.

import type { SessionId } from "../../src/daemon/foundations/session-id";
import { holdable, hostHeld, NOTHING_STORED } from "./renderers";
import { MAIN_RENDERER } from "../../src/daemon/foundations/renderer-name";
import { minter, noFeeds } from "./renderer-parts";
import { TEST_SIGNER } from "./link-signer";
import type { Collector } from "../../src/daemon/collector";
import type { DaemonParts } from "../../src/daemon/daemon-parts";
import { rendererHost, type HostWorld } from "../../src/daemon/renderer-host";
import type { ActsOnTheirWay } from "../../src/renderer/acts";
import { mainRenderer } from "../../src/renderer/main";
import { type Timekeeper } from "../../src/time";
import { systemTimekeeper } from "./system-clock";
import { TurnTime } from "../../src/renderer/turn-time";
import { TurnLog } from "../../src/renderer/turn-log";
import { MenuIdle } from "../../src/renderer/menu-idle";
import {
  verbsOver,
  type DaemonVerbContext,
  type MainRendererParts,
} from "../../src/renderer/verbs/port";
import { NO_CONFIGS } from "./renderers";
import { bookedContext, discoveryNow } from "./click";
import type { SessionBook } from "../../src/daemon/session-book";
import { heardContextOf } from "../../src/renderer-interface/request-context";
import { HOST } from "./host";
import { stateDir } from "../../src/daemon/paths";
import { authorizeRun } from "../../src/daemon/foundations/run-authorization";

export function clickParts(
  verbCtx: DaemonVerbContext,
  collector: Pick<Collector, "holding" | "clicked"> = {
    holding: () => () => {},
    clicked: () => {},
  },
  // What the host's turns act in: by default, an act it is handed fails by
  // name, so a test whose click asks one hands in its own performer.
  world: HostWorld = {
    authorizeRun: (request, captures) =>
      authorizeRun(TEST_SIGNER, request, captures),
    perform: async (act) => ({
      kind: "failed",
      reason: `${act.kind}: no host part in this rig`,
    }),
    stateDir: stateDir(HOST),
    configs: { ...NO_CONFIGS, ...discoveryNow(HOST) },
    closing: () => false,
    acknowledgeDisplayed: () => {},
    unheard: () => {},
  },
  clock: Timekeeper = systemTimekeeper,
): Pick<DaemonParts, "renderer" | "linkSigner"> & {
  collector: Pick<Collector, "holding" | "clicked">;
  sessionBook: Pick<SessionBook, "heard" | "contextOf">;
  // Another turn, held in the renderer's mailbox until `open`: every input
  // sent after it waits there, in flight.
  park: () => { readonly open: () => void; readonly holding: Promise<unknown> };
  // The renderer's idle periods, which a test opens a menu's in.
  menuIdle: MenuIdle;
} {
  const time = new TurnTime();
  const turnLog = new TurnLog();
  const menuIdle = new MenuIdle();
  // A click's turn reads the verbs and, for its output, the open views'
  // subscriptions: this rig opens none.
  const parts = {
    // A click's landing restarts its session's idle period, as the main
    // renderer wires it.
    verbs: verbsOver({
      ...verbCtx,
      log: turnLog.add,
      clickLanded: (sessionId) => {
        verbCtx.clickLanded(sessionId);
        menuIdle.clicked(sessionId, time.tick);
      },
    }),
    // [LAW:one-source-of-truth] The config is already held by the verb fixture.
    // Admission and the verbs read its same snapshot source.
    renderCache: {
      subscriptions: () => ({ sources: {} }),
      origins: () => [],
      configSelections: () => [],
      managedFolders: () => [],
      holdView: () => null,
      // An origin the verb fixture holds no config for throws.
      configDelivery: (origin) => {
        verbCtx.snapshotFor(origin);
        return { kind: "received" };
      },
      prune: () => {},
    } satisfies Pick<
      MainRendererParts["renderCache"],
      | "subscriptions"
      | "origins"
      | "configSelections"
      | "managedFolders"
      | "holdView"
      | "configDelivery"
      | "prune"
    >,
    // No session renders here: no world state is held, and a session's
    // context is the one the rig's book holds.
    worldStates: {
      sessions: () => [],
      contextOf: (session: SessionId) =>
        bookedContext(verbCtx.sessionState, session),
    },
    sessionState: verbCtx.sessionState,
    edits: verbCtx.edits,
    turnLog,
    configWrites: verbCtx.configWrites,
    // No view is open, so no lane is read.
    // The readings each input carries, and the idle periods a `due` closes.
    time,
    menuIdle,
    feeds: noFeeds(),
    mint: minter(),
    // The acts the test's verb context asks, settled by this rig's host.
    acts: verbCtx.acts as ActsOnTheirWay,
  } as unknown as MainRendererParts;
  const held = holdable(mainRenderer(parts, NOTHING_STORED));
  const renderer = rendererHost(
    MAIN_RENDERER,
    clock,
    hostHeld(held.renderer, clock.monotonic),
    verbCtx.log,
    {
      subscribed: () => {},
      frames: () => {},
      holding: collector.holding,
      stored: () => {},
      recorded: () => {},
    },
    world,
  );
  return {
    renderer,
    collector,
    // The host's book of the rig's sessions: what the test's book holds of
    // each, live once the host has heard the session's request.
    sessionBook: {
      heard: () => {},
      contextOf: (session, live) =>
        live === null
          ? bookedContext(verbCtx.sessionState, session)
          : heardContextOf(live),
    },
    linkSigner: TEST_SIGNER,
    menuIdle,
    park: () => {
      const open = held.hold();
      const holding = renderer.deliver(
        () => ({
          kind: "event",
          event: { kind: "start", viewers: {}, sessions: [] },
        }),
        [],
      );
      return { open, holding };
    },
  };
}

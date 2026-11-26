// The host parts a click reaches past `replyTo` (src/daemon/reply.ts): the
// main renderer, in process, whose click turn runs the verb table over a
// test's verb context, over a collector that holds and keeps no session unless
// the test hands in its own. A test that builds its daemon parts by hand spreads
// these in.

import type { SessionId } from "../../src/daemon/foundations/session-id";
import { holdable, hostHeld, NOTHING_STORED, NO_ACTS, NO_CONFIGS } from "./renderers";
import { MAIN_RENDERER } from "../../src/daemon/foundations/renderer-name";
import { minter, noFeeds } from "./renderer-parts";
import { TEST_SIGNER } from "./link-signer";
import type { Collector } from "../../src/daemon/collector";
import type { DaemonParts } from "../../src/daemon/daemon-parts";
import { rendererHost, type HostWorld } from "../../src/daemon/renderer-host";
import type { ActsOnTheirWay } from "../../src/renderer/acts";
import { mainRenderer } from "../../src/renderer/main";
import { type Timekeeper } from "../../src/time";
import { systemTimekeeper } from "../../scripts/lib/system-clock";
import { TurnTime } from "../../src/renderer/turn-time";
import { TurnLog } from "../../src/renderer/turn-log";
import { MenuIdle } from "../../src/renderer/menu-idle";
import {
  verbsOver,
  type DaemonVerbContext,
  type MainRendererParts,
} from "../../src/renderer/verbs/port";
import { bookedContext } from "./click";
import { snapshotOf } from "./main-renderer";
import { loadSnapshot } from "../../src/config/dsl-loader";
import type { DslConfig } from "../../src/config/dsl-types";
import { originKey } from "../../src/config-hint";
import type { SessionBook } from "../../src/daemon/session-book";
import { heardContextOf } from "../../src/renderer-interface/request-context";
import { HOST } from "../../scripts/lib/host";

// A host with the fixture's empty user layer. It can lend its config to a
// cold click only while that click's mailbox slot follows the origin.
function clickWorld(): HostWorld {
  const fixture = snapshotOf("{}");
  let followed = new Set<string>();
  return {
    ...NO_ACTS,
    configs: {
      ...NO_CONFIGS,
      follow: (origins) => { followed = new Set(origins.map(originKey)); },
      snapshotOf: (origin) => followed.has(originKey(origin)) ? fixture : null,
    },
  };
}

// A click can re-arm the renderer's menu-idle wake for another thirty
// seconds. The fixture owns that wake just as a running daemon does.
const renderers: ReturnType<typeof rendererHost>[] = [];
afterEach(() => {
  for (const renderer of renderers.splice(0)) renderer.closeWake();
});

export function clickParts(
  verbCtx: DaemonVerbContext,
  collector: Pick<Collector, "holding" | "clicked"> = {
    holding: () => () => {},
    clicked: () => {},
  },
  // What the host's turns act in: by default, an act it is handed fails by
  // name, so a test whose click asks one hands in its own performer.
  world: HostWorld = clickWorld(),
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
  const delivered = new Map<string, DslConfig>();
  // A click's turn reads the verbs and, for its output, the open views'
  // subscriptions: this rig opens none.
  const parts = {
    // A click's landing restarts its session's idle period, as the main
    // renderer wires it.
    verbs: verbsOver({
      ...verbCtx,
      configFor: (origin, editing) =>
        delivered.get(originKey(origin)) ?? verbCtx.configFor(origin, editing),
      log: turnLog.add,
      clickLanded: (sessionId) => {
        verbCtx.clickLanded(sessionId);
        menuIdle.clicked(sessionId, time.tick);
      },
    }),
    // Click admission and the verbs use the config the host delivered in the slot.
    renderCache: {
      subscriptions: () => ({ sources: {} }),
      origins: () => [],
      configSelections: () => [],
      managedFolders: () => [],
      holdView: () => null,
      configure: (origin, snapshot) => {
        const loaded = loadSnapshot(snapshot, HOST.home, verbCtx.configFor(origin), { warned: () => {} });
        delivered.set(originKey(origin), loaded.config);
      },
      holdsConfig: (origin) => delivered.has(originKey(origin)),
      prune: (keep) => {
        for (const key of delivered.keys()) if (!keep.has(key)) delivered.delete(key);
      },
    } satisfies Pick<
      MainRendererParts["renderCache"],
      | "subscriptions"
      | "origins"
      | "configSelections"
      | "managedFolders"
      | "holdView"
      | "configure"
      | "holdsConfig"
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
  renderers.push(renderer);
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

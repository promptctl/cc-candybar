// Test helpers for the click wire. A rendered click URL is `dispatch/does=…&e=…`
// (an ordered effect list after the verb's `/`); these decode it to its behavioral
// content and drive it through the REAL daemon path, so assertions track "what
// effects does this click apply" rather than the exact wire encoding.

import { installFacts } from "../../src/doctor/edge";
import { clickLaunchVia } from "../../src/daemon/foundations/click-launch";
import { bareGates } from "./gates";
import { HOST } from "./host";
import { unscriptedLauncher } from "./fake-launcher";
import type { Host } from "../../src/host";
import { HEALTHY_BUNDLE } from "./doctor-facts";
import { TEST_SIGNER } from "./link-signer";
import { JournalTurns } from "../../src/renderer/journal-turns";
import { NavigationHistory } from "../../src/renderer/navigation-history";
import {
  HEALTHY_INSTALL_EDGE,
  HEALTHY_SERVING,
  noManagedSettings,
} from "./doctor-facts";
import { clickOf } from "../../src/click/read";
import { changeLanded, VERBS } from "../../src/renderer/verbs";
import { diffChanges } from "../../src/config/config-changes";
import { performChange } from "../../src/daemon/effect-interpreter";
import type { Effect, EffectId } from "../../src/renderer-interface/interface";
import { ConfigWrites } from "../../src/renderer/config-writes";
import { readConfigText } from "../../src/renderer/config-file-store";
import { SESSION_RENDER_ORIGIN_KEY } from "../../src/daemon/foundations/session-keys";
import { encodeRenderOrigin } from "../../src/daemon/foundations/render-origin";
import type { VerbContext } from "../../src/renderer/verbs";
import type { SessionStateRW } from "../../src/renderer-interface/session-state";
import type { SessionId } from "../../src/daemon/foundations/session-id";
import { SettingsHistory } from "../../src/renderer/settings-history";
import type { DslConfig } from "../../src/config/dsl-types";
import { RenderSightings } from "../../src/daemon/render-sightings";
import { instantOf } from "../../src/utils/instant";
import {
  laneSwitches,
  resolveEffectiveGlobals,
} from "../../src/config/effective-globals";
import { LANE_NAMES, type LaneSwitches } from "../../src/config/lanes";
import { locations, stateDir } from "../../src/daemon/paths";
import { systemTimekeeper } from "../../src/time";

const NO_LANES = Object.fromEntries(
  LANE_NAMES.map((lane) => [lane, false]),
) as LaneSwitches;

// The record a session's render leaves behind, which a click resolves its
// config from: a session only clicks links its own render drew.
export function recordRender(
  sessionState: SessionStateRW,
  sessionId: SessionId,
  dir = "/tmp/proj",
): void {
  sessionState.set(
    sessionId,
    SESSION_RENDER_ORIGIN_KEY,
    encodeRenderOrigin({
      projectDir: dir,
      cwd: dir,
      target: { source: "search" },
    }),
  );
}

// A host's sightings as the renderer reaches them: each read answered.
export const asyncSightings = (
  sightings: Pick<RenderSightings, "ofSession">,
): VerbContext["clients"] => ({
  ofSession: async (sessionId, now) => sightings.ofSession(sessionId, now),
});

// [LAW:one-source-of-truth] THE VerbContext a test hands the click path: a
// silent log and an update act that refuses loudly — no test here has an
// update watch, so an apply-update click reaching it is a test bug, never a
// silent no-op. [LAW:no-silent-failure]
// The history is ephemeral unless the caller hands one in: a test that is not
// isolated from the real state dir must never write the daemon's history file
// (test/helpers/durable-config.ts hands in one under its own temp root).
export function testVerbContext(
  sessionState: SessionStateRW,
  history: SettingsHistory = new SettingsHistory(sessionState, () => {}),
  config?: DslConfig,
  host: Host = HOST,
): VerbContext {
  const ctx: VerbContext = {
    gates: bareGates(),
    stateDir: stateDir(host),
    locations: locations(host),
    sessionState,
    history,
    navigation: new NavigationHistory(),
    clientGone: async () => false,
    latest: null,
    journalTurns: new JournalTurns({
      log: () => {},
      monotonic: () => systemTimekeeper.monotonic(),
      // Each write here lands as the click makes it, so none is on its way.
      changesLanded: async () => {},
    }),
    clickLanded: () => {},
    placeWaited: () => {},
    gatherTook: () => {},
    turnWaited: () => {},
    log: () => {},
    launch: clickLaunchVia(unscriptedLauncher),
    now: () => instantOf(new Date()),
    applyUpdate: async () => {
      throw new Error("apply-update: no update watch in this test");
    },
    // Same posture for the doctor's edge: a test that drives a doctor click
    // hands in its own fake edge; reaching this one is a test bug.
    doctor: {
      ...noManagedSettings(),
      probeTmux: async () => {
        throw new Error("doctor: no tmux edge in this test");
      },
      remoteLogin: async () => {
        throw new Error("doctor: no process edge in this test");
      },
      fontInUse: async () => {
        throw new Error("doctor: no font edge in this test");
      },
      loadConfig: () => {
        throw new Error("doctor: no config edge in this test");
      },
      daemons: async () => {
        throw new Error("doctor: no process table in this test");
      },
      forge: async () => {
        throw new Error("doctor: no forge edge in this test");
      },
      transcript: async () => {
        throw new Error("doctor: no transcript edge in this test");
      },
    },
    installFacts: async (bundle, clients) =>
      installFacts(HEALTHY_INSTALL_EDGE, bundle, clients),
    doctorStores: {
      marks: {
        read: () => {
          throw new Error("doctor: no mark book in this test");
        },
        update: () => {
          throw new Error("doctor: no mark book in this test");
        },
      },
      clicked: {
        read: () => {
          throw new Error("doctor: no clicked terminals in this test");
        },
        update: () => {
          throw new Error("doctor: no clicked terminals in this test");
        },
      },
      postMortemsRead: {
        read: () => {
          throw new Error("doctor: no post-mortem record in this test");
        },
        update: () => {
          throw new Error("doctor: no post-mortem record in this test");
        },
      },
    },
    // A click from the handler this build would stage.
    arrival: { via: "link", delivery: { kind: "forwarder", urlV: 2 } },
    clients: asyncSightings(new RenderSightings()),
    bundle: HEALTHY_BUNDLE,
    serving: async () => HEALTHY_SERVING,
    // And for the Claude Code pane: a test that drives a slash click hands in
    // its own typing.
    typeSlash: async () => {
      throw new Error("slash: no claude-input edge in this test");
    },
    // The config the session renders with: a test whose click reads it (a
    // save, a step from an unset key, any session write once the session has
    // rendered — the write closes what it closes in that config) hands it in;
    // reaching the lookup without one is a test bug.
    configFor: () => {
      if (config === undefined) {
        throw new Error("configFor: this test handed in no config");
      }
      return config;
    },
    // A reload rebuilds the render cache's entry from the file. This context
    // holds no render cache, so there is nothing to rebuild: the file a click
    // wrote is the whole outcome, and it is what these tests read. A rig with a
    // cache hands in its own — test/settings-config-menu.test.ts records each
    // reload to pin that it follows the write's landing.
    reloadConfig: () => {},
    // A test that drives a run click hands in its own run owner and the
    // storage keys of its config's sources.
    sourcesFor: () => {
      throw new Error("sourcesFor: this test handed in no sources");
    },
    links: TEST_SIGNER,
    runs: {
      start: () => {
        throw new Error("run: no run owner in this test");
      },
      refused: () => {
        throw new Error("run: no run owner in this test");
      },
    },
    // A click of a session that has rendered measures its lane switches over
    // that same config, as the daemon's does; a test that handed in none
    // switches no lane on. No lane owner runs here: a test that reads what a
    // click set up hands in its own `clicked`. A session here rendered in a
    // tmux pane, so the tmux status line is its to switch.
    lanes: {
      of: (_origin, sid) =>
        config === undefined
          ? NO_LANES
          : laneSwitches(
              resolveEffectiveGlobals(
                config,
                (key) => sessionState.get(sid, key),
                () => false,
              ),
              true,
            ),
      clicked: () => {},
    },
    // No draw here lists a diagnostic, so a copy-diagnostic click is refused.
    diagnosticCopy: () => undefined,
    configText: readConfigText,
    land: landingIn(() => ctx),
  };
  return ctx;
}

// The host's interpreter performs each write as the click makes it, and the
// click hears how it landed there and then, through `of()`'s reload and
// session state, so the file a test reads is the file the click left. A
// daemon performs a click's writes once its turn answers
// (test/helpers/click-parts.ts drives that path).
const landingIn =
  (of: () => VerbContext): VerbContext["land"] =>
  (session, file, before, after) => {
    const changes = diffChanges(before, after);
    if (changes.length === 0) return;
    const outcome = performChange({
      kind: "change",
      id: 0 as EffectId,
      session,
      target: { kind: "layer", path: file },
      changes,
    });
    changeLanded(of(), { session, path: file, latest: of().latest }, outcome);
  };

export { effectsOf, type DecodedEffect } from "../../src/click/read";

// A rendered link as the daemon reads it; a test's links are always links.
export const linkClick = clickOf;

// Drive a rendered click URL through the real parse → dispatch path, in the
// daemon's order: the click's writes are changes on their way while it runs,
// which it reads back (ConfigWrites), and once it has committed, each is
// performed by the host's interpreter and its landing heard, whether or not
// the click threw.
export async function clickUrl(url: string, ctx: VerbContext): Promise<void> {
  const { verb, value } = linkClick(url);
  await clickVerb(verb, value, ctx);
}

// The same, for a verb and its value.
export async function clickVerb(
  verb: string,
  value: string,
  ctx: VerbContext,
): Promise<void> {
  const handler = VERBS.get(verb);
  if (!handler) throw new Error(`no handler for verb "${verb}"`);
  let minted = 0;
  const writes = new ConfigWrites(() => ++minted as EffectId, readConfigText);
  const effects: Effect[] = [];
  try {
    await handler(value, {
      ...ctx,
      configText: (file) => writes.read(file),
      land: (session, path, before, after) =>
        writes.land(effects, { session, path, latest: ctx.latest }, before, after),
    });
  } finally {
    for (const effect of effects) {
      if (effect.kind !== "change") continue;
      const outcome = performChange(effect);
      changeLanded(ctx, writes.settled(effect.id)!, outcome);
    }
  }
}

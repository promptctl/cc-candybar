// Test helpers for the click wire. A rendered click URL is `dispatch/e=…` (an
// ordered effect list after the verb's `/`); these decode it to its behavioral
// content and drive it through the REAL daemon path, so assertions track "what
// effects does this click apply" rather than the exact wire encoding.

import { processLauncher } from "../../src/proc/launch";
import { HEALTHY_BUNDLE } from "./doctor-facts";
import { TEST_SIGNER } from "./link-signer";
import { NavigationHistory } from "../../src/daemon/navigation-history";
import {
  HEALTHY_INSTALL_EDGE,
  HEALTHY_SERVING,
  noManagedSettings,
} from "./doctor-facts";
import { parseHandlerUrl } from "../../src/install/index";
import {
  VERBS,
  SESSION_RENDER_ORIGIN_KEY,
  encodeRenderOrigin,
} from "../../src/daemon/verbs";
import type { VerbContext } from "../../src/daemon/verbs";
import type { SessionStateRW } from "../../src/daemon/session-state";
import { SettingsHistory } from "../../src/daemon/settings-history";
import type { DslConfig } from "../../src/config/dsl-types";
import { ProbeArrivals } from "../../src/doctor/handler-probe";
import { RenderSightings } from "../../src/daemon/render-sightings";
import { PACKAGE_VERSION } from "../../src/version";
import { instantOf } from "../../src/utils/instant";
import {
  laneSwitches,
  resolveEffectiveGlobals,
} from "../../src/config/effective-globals";
import { LANE_NAMES, type LaneSwitches } from "../../src/config/lanes";

const NO_LANES = Object.fromEntries(
  LANE_NAMES.map((lane) => [lane, false]),
) as LaneSwitches;

// The record a session's render leaves behind, which a click resolves its
// config from: a session only clicks links its own render drew.
export function recordRender(
  sessionState: SessionStateRW,
  sessionId: string,
): void {
  sessionState.set(
    sessionId,
    SESSION_RENDER_ORIGIN_KEY,
    encodeRenderOrigin({
      projectDir: "/tmp/proj",
      cwd: "/tmp/proj",
      target: { source: "search" },
    }),
  );
}

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
): VerbContext {
  return {
    sessionState,
    history,
    navigation: new NavigationHistory(),
    log: () => {},
    launcher: processLauncher,
    now: () => instantOf(new Date()),
    applyUpdate: () => {
      throw new Error("apply-update: no update watch in this test");
    },
    // Same posture for the doctor's edge: a test that drives a doctor click
    // hands in its own fake edge; reaching this one is a test bug.
    doctor: {
      install: HEALTHY_INSTALL_EDGE,
      ...noManagedSettings(),
      probeTmux: () => {
        throw new Error("doctor: no tmux edge in this test");
      },
      remoteLogin: () => {
        throw new Error("doctor: no process edge in this test");
      },
      fontInUse: () => {
        throw new Error("doctor: no font edge in this test");
      },
      loadConfig: () => {
        throw new Error("doctor: no config edge in this test");
      },
      daemons: () => {
        throw new Error("doctor: no process table in this test");
      },
      forge: () => {
        throw new Error("doctor: no forge edge in this test");
      },
      transcript: () => {
        throw new Error("doctor: no transcript edge in this test");
      },
    },
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
    // A click from the handler this build would stage, and nowhere of the
    // daemon's for a probe to land: a test that reads arrivals hands in its own.
    arrival: { via: "link", handler: PACKAGE_VERSION },
    probes: new ProbeArrivals(),
    clients: new RenderSightings(),
    bundle: HEALTHY_BUNDLE,
    serving: () => HEALTHY_SERVING,
    // And for the Claude Code pane: a test that drives a slash click hands in
    // its own edge.
    claudeInput: {
      read: () => {
        throw new Error("slash: no claude-input edge in this test");
      },
      type: () => {
        throw new Error("slash: no claude-input edge in this test");
      },
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
    // reload to pin write → reload → release.
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
    // No render cache here, so no session has a view to move.
    views: { follow: () => {} },
    // No draw here lists a diagnostic, so a copy-diagnostic click is refused.
    diagnosticCopy: () => undefined,
  };
}

export { effectsOf, type DecodedEffect } from "../../src/click/read";

export { boldUrls } from "./ansi";

// Drive a rendered click URL through the real parse → dispatch path.
export function clickUrl(url: string, ctx: VerbContext): void {
  const { verb, value } = parseHandlerUrl(url);
  const handler = VERBS.get(verb);
  if (!handler) throw new Error(`no handler for verb "${verb}"`);
  handler(value, ctx);
}

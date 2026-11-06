// Test helpers for the click wire. A rendered click URL is `dispatch/does=…&e=…`
// (an ordered effect list after the verb's `/`); these decode it to its behavioral
// content and drive it through the REAL daemon path, so assertions track "what
// effects does this click apply" rather than the exact wire encoding.

import { bareGates } from "./gates";
import { HOST } from "./host";
import { unscriptedLauncher } from "./fake-launcher";
import type { Host } from "../../src/host";
import { HEALTHY_BUNDLE } from "./doctor-facts";
import { TEST_SIGNER } from "./link-signer";
import { JournalTurns } from "../../src/daemon/journal-turns";
import { NavigationHistory } from "../../src/daemon/navigation-history";
import {
  HEALTHY_INSTALL_EDGE,
  HEALTHY_SERVING,
  noManagedSettings,
} from "./doctor-facts";
import { clickOf } from "../../src/click/read";
import { apply } from "../../src/daemon/apply";
import { clickSessionOf, clickVerb } from "../../src/daemon/verbs";
import { writesInTurn } from "./writes-in-turn";
import { SESSION_RENDER_ORIGIN_KEY } from "../../src/daemon/foundations/session-keys";
import { encodeRenderOrigin } from "../../src/daemon/foundations/render-origin";
import type { VerbContext } from "../../src/daemon/verbs";
import type { SessionStateRW } from "../../src/daemon/session-state";
import { SettingsHistory } from "../../src/daemon/settings-history";
import type { DslConfig } from "../../src/config/dsl-types";
import { ProbeArrivals } from "../../src/doctor/handler-probe";
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
  sessionId: string,
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

// [LAW:one-source-of-truth] THE VerbContext a test hands the click path: a
// silent log and an update act that refuses loudly — no test here has an
// update watch, so an apply-update click reaching it is a test bug, never a
// silent no-op. [LAW:no-silent-failure]
// The history is ephemeral unless the caller hands one in: a test that is not
// isolated from the real state dir must never write the daemon's history file
// (test/helpers/durable-config.ts hands in one under its own temp root).
// The turns are the context's own unless the caller holds them: the writes
// the instrument below judges are held by whichever turns the click takes.
export function testVerbContext(
  sessionState: SessionStateRW,
  history?: SettingsHistory,
  config?: DslConfig,
  host: Host = HOST,
  journalTurns: JournalTurns = new JournalTurns({
    log: () => {},
    monotonic: () => systemTimekeeper.monotonic(),
  }),
): VerbContext {
  // [LAW:nothing-unseen] Every write a click makes crosses the ordering
  // instrument (test/helpers/writes-in-turn.ts): the context's store, and the
  // history whose journal writes through it.
  const inTurn = writesInTurn(sessionState, journalTurns);
  return {
    gates: bareGates(),
    stateDir: stateDir(host), locations: locations(host),
    sessionState: inTurn,
    history: history ?? new SettingsHistory(inTurn, () => {}),
    navigation: new NavigationHistory(),
    asker: { placed: () => {}, gathered: () => {}, waited: () => {}, gone: () => false },
    journalTurns,
    clickLanded: () => {},
    log: () => {},
    launcher: unscriptedLauncher,
    now: () => instantOf(new Date()),
    applyUpdate: async () => {
      throw new Error("apply-update: no update watch in this test");
    },
    // Same posture for the doctor's edge: a test that drives a doctor click
    // hands in its own fake edge; reaching this one is a test bug.
    doctor: {
      install: HEALTHY_INSTALL_EDGE,
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
    arrival: { via: "link", delivery: { kind: "forwarder", urlV: 1 } },
    probes: new ProbeArrivals(),
    clients: new RenderSightings(),
    bundle: HEALTHY_BUNDLE,
    serving: () => HEALTHY_SERVING,
    // And for the Claude Code pane: a test that drives a slash click hands in
    // its own edge.
    claudeInput: {
      read: async () => {
        throw new Error("slash: no claude-input edge in this test");
      },
      type: async () => {
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
    // No draw here lists a diagnostic, so a copy-diagnostic click is refused.
    diagnosticCopy: () => undefined,
  };
}

export { effectsOf, type DecodedEffect } from "../../src/click/read";

// A rendered link as the daemon reads it; a test's links are always links.
export const linkClick = clickOf;

// What a click's arm reads (src/daemon/apply.ts): the context handed in, its
// log, and an idle clock nothing here arms.
function clickParts(ctx: VerbContext) {
  const { arrival: _arrival, asker: _asker, ...verbCtx } = ctx;
  return {
    verbCtx,
    log: ctx.log,
    menuIdle: { clickArrived: () => {}, clickSettled: () => {} },
  };
}

// A rendered click URL through Apply, as the daemon runs it: answers once its
// turn has committed, with the handle that settles when its effects have all
// reported. A verb that refuses the click rejects here, as the daemon's reply
// would say.
export async function applyClick(
  url: string,
  ctx: VerbContext,
): Promise<{ readonly performed: Promise<void> }> {
  const { verb: name, value } = linkClick(url);
  const verb = clickVerb(name);
  if (verb === null) throw new Error(`no handler for verb "${name}"`);
  // The session the click names, read as the daemon's edge reads it
  // (src/daemon/reply.ts handleClick).
  const session = clickSessionOf(name, value);
  const { performed } = await apply(
    {
      kind: "click",
      verb,
      value,
      arrival: ctx.arrival,
      pending: session?.ok ? session.id : null,
      asker: ctx.asker,
    },
    clickParts(ctx),
  );
  return { performed };
}

// Drive a rendered click URL through the real path, effects and all: resolves
// once the click has answered and every effect it described has reported.
export async function clickUrl(url: string, ctx: VerbContext): Promise<void> {
  const { performed } = await applyClick(url, ctx);
  await performed;
}

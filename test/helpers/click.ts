// Test helpers for the click wire. A rendered click URL is `dispatch/does=…&e=…`
// (an ordered effect list after the verb's `/`); these decode it to its behavioral
// content and drive it through the REAL daemon path, so assertions track "what
// effects does this click apply" rather than the exact wire encoding.

import { installFacts } from "../../src/doctor/edge";
import { bareGates } from "./gates";
import { HOST } from "./host";
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
import { changeDone, VERBS } from "../../src/renderer/verbs";
import {
  ConfigWrites,
  type Consequence,
} from "../../src/renderer/config-writes";
import { readConfigText } from "../../src/renderer/config-file-store";
import {
  performChanges,
  type ApproveRepo,
} from "../../src/daemon/effect-interpreter";
import type {
  Act,
  ConfigChange,
  Effect,
  EffectId,
  EffectOutcome,
} from "../../src/renderer-interface/interface";
import { ActsOnTheirWay } from "../../src/renderer/acts";
import { Acts, outlives, type ActDeps } from "../../src/daemon/acts";
import type { HostWorld } from "../../src/daemon/renderer-host";
import type { LaneEdge, LaneHost } from "../../src/daemon/lane-setup";
import { holdClickError } from "../../src/daemon/foundations/click-error";
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

// [LAW:single-enforcer] The host, for a test that drives the verb table with
// none: each click's changes land as its turn hands them on, through the
// host's own interpreter, and their outcome comes back through the verbs' own
// `changeDone`, so the click's consequence applies, or is dropped, as a real
// landing's would. A rig with a renderer host (test/helpers/click-parts.ts)
// hands its clicks' changes to that host instead.
class LandingAtOnce extends ConfigWrites {
  private context: VerbContext | null = null;

  constructor(
    mint: () => EffectId,
    private readonly stateDir: string,
  ) {
    super(mint, readConfigText);
  }

  of(ctx: VerbContext): VerbContext {
    this.context = ctx;
    return ctx;
  }

  // The landing leaves the click's effects; what its consequence asks joins
  // them, so a test reads every act its click asked for there.
  override seal(
    effects: Effect[],
    session: SessionId | null,
    consequence: Consequence,
  ): void {
    const from = effects.length;
    super.seal(effects, session, consequence);
    const landing = effects.splice(from);
    if (landing.length === 0) return;
    const outcome = performChanges(
      landing.filter((e): e is ConfigChange => e.kind === "change"),
      {
        stateDir: this.stateDir,
        answers: landing.filter(
          (e): e is ApproveRepo => e.kind === "approve-repo",
        ),
        said: () => {},
      },
    );
    for (const { id } of landing)
      changeDone(this.context!, id, outcome, effects);
  }
}

// The acts a click asked of the host, in the order it asked them.
export const actsOf = (ctx: Pick<VerbContext, "effects">): readonly Act[] =>
  ctx.effects.filter(
    (e): e is Act => e.kind !== "present" && e.kind !== "change",
  );

// A test's verb context with its own parts: its clicks land through the
// context they ran with, so a landing reloads with the test's own reload.
export function verbContextWith(
  base: VerbContext,
  over: Partial<VerbContext>,
): VerbContext {
  return (base.configWrites as LandingAtOnce).of({ ...base, ...over });
}

// [LAW:one-source-of-truth] THE VerbContext a test hands the click path: a
// silent log, and acts that land in the click's effects, where a test reads
// what its click asked of the host (`actsOf`); a failed act's `effect-done`
// holds the click error as the renderer's does.
// The history is ephemeral unless the caller hands one in: a test that is not
// isolated from the real state dir must never write the daemon's history file
// (test/helpers/durable-config.ts hands in one under its own temp root).
export function testVerbContext(
  sessionState: SessionStateRW,
  history: SettingsHistory = new SettingsHistory(sessionState, () => {}),
  config?: DslConfig,
  host: Host = HOST,
): VerbContext {
  let minted = 0;
  const mint = (): EffectId => ++minted as EffectId;
  const configWrites = new LandingAtOnce(mint, stateDir(host));
  return configWrites.of({
    configWrites,
    acts: new ActsOnTheirWay(mint, (session, reason) =>
      holdClickError(sessionState, session, reason, instantOf(new Date())),
    ),
    effects: [],
    gates: bareGates(),
    stateDir: stateDir(host),
    locations: locations(host),
    sessionState,
    history,
    navigation: new NavigationHistory(),
    clientGone: async () => false,
    latest: null,
    journalTurns: new JournalTurns({
      monotonic: () => systemTimekeeper.monotonic(),
      changesLanded: () => configWrites.landed(),
    }),
    clickLanded: () => {},
    placeWaited: () => {},
    gatherTook: () => {},
    turnWaited: () => {},
    log: () => {},
    now: () => instantOf(new Date()),
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
        plan: () => {
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
        plan: () => {
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
        plan: () => {
          throw new Error("doctor: no post-mortem record in this test");
        },
      },
    },
    // A click from the handler this build would stage.
    arrival: { via: "link", delivery: { kind: "forwarder", urlV: 2 } },
    clients: asyncSightings(new RenderSightings()),
    bundle: HEALTHY_BUNDLE,
    serving: async () => HEALTHY_SERVING,
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
    // reload to pin that a landing reloads before it releases.
    reloadConfig: () => {},
    // A test that drives a run click hands in its own run owner and the
    // storage keys of its config's sources.
    sourcesFor: () => {
      throw new Error("sourcesFor: this test handed in no sources");
    },
    links: TEST_SIGNER,
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
  });
}

export { effectsOf, type DecodedEffect } from "../../src/click/read";

// A rendered link as the daemon reads it; a test's links are always links.
export const linkClick = clickOf;

// Drive a rendered click URL through the real parse → dispatch path.
export async function clickUrl(url: string, ctx: VerbContext): Promise<void> {
  const { verb, value } = linkClick(url);
  const handler = VERBS.get(verb);
  if (!handler) throw new Error(`no handler for verb "${verb}"`);
  await handler(value, ctx);
}

// The host's act performer over `deps`; a part the test does not hand in
// fails by name.
export function testActs(log: VerbContext["log"], deps: Partial<ActDeps> = {}): Acts {
  const missing = (part: string) => async (): Promise<never> => {
    throw new Error(`${part}: no host part in this test`);
  };
  return new Acts({
    launch: missing("launch"),
    type: missing("type"),
    run: missing("run"),
    applyUpdate: missing("apply-update"),
    lanes: {
      edge: new Proxy({} as LaneEdge, { get: (_, k) => missing(`lane ${String(k)}`) }),
      host: new Proxy({} as LaneHost, { get: (_, k) => missing(`lane ${String(k)}`) }),
    },
    closing: () => false,
    log,
    ...deps,
  });
}

// The world a rig's host turns act in: its acts performed over `deps`, and
// an act's failure no bar holds handed to `unheard`.
export function actingWorld(
  ctx: Pick<VerbContext, "log" | "stateDir">,
  deps: Partial<ActDeps> = {},
  unheard: (text: string) => void = (text) => {
    throw new Error(`an act's failure no bar holds: ${text}`);
  },
): HostWorld {
  const acts = testActs(ctx.log, deps);
  return {
    perform: (act) => acts.perform(act),
    stateDir: ctx.stateDir,
    closing: () => false,
    unheard,
  };
}

// The host's side of a test's clicks: each act they asked, performed by the
// host's own performer over `deps`, and settled back as the renderer hears an
// `effect-done`, so a failed act holds its click error as it would live. A
// part the test does not hand in fails by name. As the host does, an act that
// outlives its turn is started and settled when it ends, and the rest are
// awaited: returns their outcomes in the order they were asked, and leaves the
// context with no act to perform.
export async function performActs(
  ctx: VerbContext,
  deps: Partial<ActDeps> = {},
): Promise<EffectOutcome[]> {
  const acts = testActs(ctx.log, deps);
  const asked = actsOf(ctx);
  const rest = ctx.effects.filter((e) => !asked.includes(e as Act));
  ctx.effects.splice(0, ctx.effects.length, ...rest);
  const outcomes: EffectOutcome[] = [];
  for (const act of asked) {
    if (act.kind === "approve-repo") continue;
    const settled = acts.perform(act).then((outcome) => {
      (ctx.acts as ActsOnTheirWay).done(act.id, act.session, outcome);
      return outcome;
    });
    if (!outlives(act)) outcomes.push(await settled);
  }
  return outcomes;
}

// A click and the acts it asked, as the host carries them out: the turn's
// own failure throws, as `clickUrl`'s does; each act's outcome is returned.
export async function clickActing(
  url: string,
  ctx: VerbContext,
  deps: Partial<ActDeps> = {},
): Promise<EffectOutcome[]> {
  await clickUrl(url, ctx);
  return performActs(ctx, deps);
}

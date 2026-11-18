// Test helpers for the click wire. A rendered click URL is `dispatch/does=…&e=…`
// (an ordered effect list after the verb's `/`); these decode it to its behavioral
// content and drive it through the REAL daemon path, so assertions track "what
// effects does this click apply" rather than the exact wire encoding.

import { TEST_ENV } from "./session-environment";
import { bareGates } from "./gates";
import { HOST } from "./host";
import type { Host } from "../../src/host";
import { TEST_SIGNER } from "./link-signer";
import { NavigationHistory } from "../../src/renderer/navigation-history";
import { DoctorRuns } from "../../src/renderer/doctor";
import type { ConfigLoad, DoctorStores } from "../../src/doctor/ports";
import { clickOf } from "../../src/click/read";
import { changeDone, VERBS } from "../../src/renderer/verbs";
import {
  ConfigWrites,
  type Consequence,
} from "../../src/renderer/config-writes";
import {
  performChanges,
  type ApproveRepo,
  type LayerPlaces,
  type WritableSettings,
} from "../../src/daemon/effect-interpreter";
import {
  discover,
  readShared,
} from "../../src/daemon/config-discovery/discover";
import type { ConfigSnapshot } from "../../src/config/config-snapshot";
import type { RenderOrigin } from "../../src/config-hint";
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
import {
  heardContextOf,
  type CheckedRenderRequest,
  type SessionContext,
} from "../../src/renderer-interface/request-context";
import { checkRenderRequest } from "../../src/daemon/render-checkpoint";
import {
  PROTOCOL_VERSION,
  type RenderRequest,
} from "../../src/daemon/foundations/protocol";
import type { ConfigTarget } from "../../src/config-hint";
import { clickSessionOf } from "../../src/click/wire";
import type { VerbContext } from "../../src/renderer/verbs";
import type { SessionStateRW } from "../../src/renderer-interface/session-state";
import type { SessionId } from "../../src/daemon/foundations/session-id";
import { SettingsHistory } from "../../src/renderer/settings-history";
import type { DslConfig } from "../../src/config/dsl-types";
import { instantOf } from "../../src/utils/instant";
import {
  laneSwitches,
  resolveEffectiveGlobals,
} from "../../src/config/effective-globals";
import { LANE_NAMES, type LaneSwitches } from "../../src/config/lanes";
import { locations, stateDir } from "../../src/daemon/paths";
import { systemTimekeeper } from "../../src/time";
import { NO_CONFIGS } from "./renderers";

const NO_LANES = Object.fromEntries(
  LANE_NAMES.map((lane) => [lane, false]),
) as LaneSwitches;

// [LAW:one-source-of-truth] A rig's host book: each session's context, kept
// beside the rig's session state, which a click reads its own session's from
// as the host's does (src/daemon/session-book.ts).
const BOOKS = new WeakMap<SessionStateRW, Map<SessionId, SessionContext>>();

const bookOf = (
  sessionState: SessionStateRW,
): Map<SessionId, SessionContext> => {
  const book = BOOKS.get(sessionState) ?? new Map();
  BOOKS.set(sessionState, book);
  return book;
};

// What the host's book holds of a session that rendered from `dir` before
// the daemon started, which a click resolves its config from: a session only
// clicks links its own render drew. Its client's facts are not known until
// its next request.
export function recordRender(
  sessionState: SessionStateRW,
  sessionId: SessionId,
  dir = "/tmp/proj",
  {
    target = { source: "search" },
    claudeConfigDir,
  }: {
    readonly target?: ConfigTarget;
    readonly claudeConfigDir?: string;
  } = {},
): void {
  bookOf(sessionState).set(sessionId, {
    session: sessionId,
    durable: {
      origin: { projectDir: dir, cwd: dir, target },
      ...(claudeConfigDir !== undefined && { claudeConfigDir }),
    },
    live: null,
  });
}

// What the host's book holds of a session once it has heard `req`.
export function hearRender(
  sessionState: SessionStateRW,
  req: CheckedRenderRequest,
): void {
  bookOf(sessionState).set(req.hookData.session_id, heardContextOf(req));
}

// A statusline request of `sessionId` from `dir`, its client reporting
// `hints`, across the host's checkpoint.
export function heardRequest(
  sessionId: string,
  dir = "/tmp/proj",
  hints: Partial<Omit<RenderRequest, "env">> = {},
): CheckedRenderRequest {
  const checked = checkRenderRequest(
    {
      v: PROTOCOL_VERSION,
      kind: "render",
      hookData: {
        hook_event_name: "Status",
        session_id: sessionId,
        transcript_path: `${dir}/transcript.jsonl`,
        cwd: dir,
        model: { id: "claude-opus-4-7", display_name: "Opus 4.7" },
        workspace: { current_dir: dir, project_dir: dir, added_dirs: [] },
      },
      args: ["cc-candybar"],
      cwd: dir,
      env: TEST_ENV,
      ...hints,
    },
    { firstSightOfUnknownHookField: () => false },
    () => {},
    "/nowhere/home",
  );
  if (!checked.ok) throw new Error(checked.problems.join("; "));
  return checked.req;
}

// What the rig's book holds of `sessionId`, as a click of it finds it.
export const bookedContext = (
  sessionState: SessionStateRW,
  sessionId: SessionId,
): SessionContext | null => BOOKS.get(sessionState)?.get(sessionId) ?? null;

// The context the host hands a click of `verb value`: its session's, as the
// rig's book holds it.
function clickContextOf(
  sessionState: SessionStateRW,
  verb: string,
  value: string,
): SessionContext | null {
  const session = clickSessionOf(verb, value);
  return session?.ok ? bookedContext(sessionState, session.id) : null;
}

// [LAW:locality-or-seam] The host's config discovery for a rig with no render
// cache and no watch: each origin discovered as the disk stands when it is
// asked, which is what a host holds once its watches have all been heard. A
// test of a click over a snapshot the disk has moved past drives a render
// cache instead (test/helpers/config-host.ts).
export function discoveryNow(host: Host): LayerPlaces & {
  readonly snapshotOf: (origin: RenderOrigin) => ConfigSnapshot;
} {
  const snapshotOf = (origin: RenderOrigin): ConfigSnapshot =>
    discover(
      {
        projectDir: origin.projectDir,
        configFile: origin.target.path,
        cwd: origin.cwd,
      },
      readShared({ locations: locations(host), stateDir: stateDir(host) }),
    ).snapshot;
  return {
    snapshotOf,
    path: (origin, role) =>
      snapshotOf(origin).chain.find((l) => l.role === role)?.path ?? null,
    repoDir: (origin) => snapshotOf(origin).repo?.dir ?? null,
  };
}

// [LAW:single-enforcer] The host, for a test that drives the verb table with
// none: each click's changes land as its turn hands them on, through the
// host's own interpreter, and their outcome comes back through the verbs' own
// `changeDone`, so the click's consequence applies, or is dropped, as a real
// landing's would. A rig with a renderer host (test/helpers/click-parts.ts)
// hands its clicks' changes to that host instead.
class LandingAtOnce extends ConfigWrites {
  private context: VerbContext | null = null;
  // The settings files a doctor's reading named; none until a test's doctor
  // host hands its readings in (`landsSettingsOf`).
  writable: WritableSettings = () => [];
  // What the host does once a landing's changes are on disk and before their
  // `effect-done`s: hand the renderer each moved origin's `config`. A test
  // with a config to re-read hands in its own (`onLanded`).
  landed: () => void = () => {};

  constructor(
    mint: () => EffectId,
    private readonly stateDir: string,
    private readonly places: LayerPlaces,
  ) {
    super(mint);
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
      this.writable,
      this.places,
    );
    if (outcome.kind === "ok") this.landed();
    for (const { id } of landing)
      changeDone(this.context!, id, outcome, effects);
  }
}

// A test's landings write the settings files `writable` names, as the host's
// write the ones its doctor readings name.
export function landsSettingsOf(
  ctx: Pick<VerbContext, "configWrites">,
  writable: WritableSettings,
): void {
  (ctx.configWrites as LandingAtOnce).writable = writable;
}

// A test's landings re-read its config with `landed`, as the host hands the
// renderer the `config` of each origin a landing moved before its
// `effect-done`s.
export function onLanded(
  ctx: Pick<VerbContext, "configWrites">,
  landed: () => void,
): void {
  (ctx.configWrites as LandingAtOnce).landed = landed;
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

// A store a test with no doctor never reaches.
const unstored = (what: string) => ({
  read: () => {
    throw new Error(`doctor: no ${what} in this test`);
  },
  update: () => {
    throw new Error(`doctor: no ${what} in this test`);
  },
  plan: () => {
    throw new Error(`doctor: no ${what} in this test`);
  },
});
const NO_DOCTOR_STORES: DoctorStores = {
  marks: unstored("mark book"),
  clicked: unstored("clicked terminals"),
  postMortemsRead: unstored("post-mortem record"),
};

// The renderer's doctor runs over `stores`; a failed reading holds the click
// error on the session's bar, as the renderer's does.
const doctorRunsOf = (
  sessionState: SessionStateRW,
  stores: DoctorStores,
  log: VerbContext["log"],
): DoctorRuns =>
  new DoctorRuns({
    sessionState,
    stores,
    log,
    failed: (session, reason) =>
      holdClickError(sessionState, session, reason, instantOf(new Date())),
  });

// `ctx` with a doctor: its runs judge `load` against `stores`.
export function withDoctor(
  ctx: VerbContext,
  {
    stores,
    load,
  }: { readonly stores: DoctorStores; readonly load: ConfigLoad },
): VerbContext {
  return verbContextWith(ctx, {
    doctorStores: stores,
    doctorRuns: doctorRunsOf(ctx.sessionState, stores, ctx.log),
    doctorLoad: () => load,
  });
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
  const discovered = discoveryNow(host);
  const configWrites = new LandingAtOnce(mint, stateDir(host), discovered);
  return configWrites.of({
    configWrites,
    snapshotFor: discovered.snapshotOf,
    acts: new ActsOnTheirWay(mint, (session, reason) =>
      holdClickError(sessionState, session, reason, instantOf(new Date())),
    ),
    effects: [],
    record: [],
    gates: bareGates(),
    locations: locations(host),
    sessionState,
    history,
    navigation: new NavigationHistory(),
    context: null,
    clickLanded: () => {},
    log: () => {},
    now: () => instantOf(new Date()),
    // A test that drives a doctor click hands in its own (`withDoctor`);
    // reaching these is a test bug.
    doctorStores: NO_DOCTOR_STORES,
    doctorRuns: doctorRunsOf(sessionState, NO_DOCTOR_STORES, () => {}),
    doctorLoad: () => {
      throw new Error("doctor: no config load in this test");
    },
    // A click from the handler this build would stage.
    arrival: { via: "link", delivery: { kind: "forwarder", urlV: 2 } },
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
  clickVerb(verb, value, ctx);
}

// [LAW:one-source-of-truth] Each verb as a click of it runs: handed its
// session's context from the rig's book, as the host hands it.
export const CLICK_VERBS: typeof VERBS = new Map(
  [...VERBS].map(([verb, handler]) => [
    verb,
    (value: string, ctx: VerbContext) =>
      handler(value, {
        ...ctx,
        context: clickContextOf(ctx.sessionState, verb, value),
      }),
  ]),
);

// A click of `verb value` as the host hands it to the renderer.
export function clickVerb(verb: string, value: string, ctx: VerbContext): void {
  const handler = CLICK_VERBS.get(verb);
  if (!handler) throw new Error(`no handler for verb "${verb}"`);
  handler(value, ctx);
}

// The host's act performer over `deps`; a part the test does not hand in
// fails by name.
export function testActs(
  log: VerbContext["log"],
  deps: Partial<ActDeps> = {},
): Acts {
  const missing = (part: string) => async (): Promise<never> => {
    throw new Error(`${part}: no host part in this test`);
  };
  return new Acts({
    launch: missing("launch"),
    claudeInput: {
      read: missing("claude input"),
      type: missing("claude input"),
    },
    run: missing("run"),
    applyUpdate: missing("apply-update"),
    lanes: {
      edge: new Proxy({} as LaneEdge, {
        get: (_, k) => missing(`lane ${String(k)}`),
      }),
      host: new Proxy({} as LaneHost, {
        get: (_, k) => missing(`lane ${String(k)}`),
      }),
    },
    closing: () => false,
    log,
    ...deps,
  });
}

// The world a rig's host turns act in: its acts performed over `deps`, and
// an act's failure no bar holds handed to `unheard`.
export function actingWorld(
  ctx: Pick<VerbContext, "log">,
  deps: Partial<ActDeps> = {},
  unheard: (text: string) => void = (text) => {
    throw new Error(`an act's failure no bar holds: ${text}`);
  },
): HostWorld {
  const acts = testActs(ctx.log, deps);
  return {
    perform: (act) => acts.perform(act),
    stateDir: stateDir(HOST),
    configs: { ...NO_CONFIGS, ...discoveryNow(HOST) },
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

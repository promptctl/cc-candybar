// The pin under the payload's composition (candybar-gather-renderer-76bb.6pj.83l):
// the bundled default and every preset, drawn from the daemon's own session
// source over fixed owners at a fixed instant, pin two things apart — the bar's
// bytes and the payload a template reads. The bar must not move when the
// payload is composed from the facts document; the payload's snapshot is where
// the accepted differences of that change show as a diff, and nothing else may.
// `check`'s payload is pinned the same way, per preset.
//
// [LAW:behavior-not-structure] Asserts what a viewer sees and what a template
// reads, over owners that answer fixed values; no composition function is named.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkPayload, checkToday } from "../src/check";
import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import { resolveEffectiveGlobals } from "../src/config/effective-globals";
import { presetNames } from "../src/config/presets";
import { UNFOLLOWED_FEEDS } from "../src/config/lanes";
import { NO_FILE_EVENTS } from "../src/daemon/cache/file-events";
import {
  RenderCache,
  type SessionView,
} from "../src/daemon/cache/render";
import { WatcherRegistry } from "../src/daemon/cache/watchers";
import { stateDir } from "../src/daemon/paths";
import {
  declareLanes,
  renderOptionsOf,
  settlePayload,
  todayOf,
} from "../src/daemon/render-payload";
import {
  sessionSource,
  type SessionSource,
} from "../src/daemon/session-source";
import { SessionState } from "../src/daemon/session-state";
import { EMPTY_HISTORY_DEPTH } from "../src/daemon/settings-history";
import { drawDsl } from "../src/dsl/render";
import { ansiOf } from "../src/render/frame";
import { systemTimekeeper } from "../src/time";
import { instantOf } from "../src/utils/instant";
import { ABSENT, failed, ok, pendingOf } from "../src/utils/outcome";
import { settledLane } from "../src/utils/reading";
import { listResolvablePaletteNames } from "../src/themes/policy";
import { bareGates } from "./helpers/gates";
import { locs } from "./helpers/host";
import { unscriptedLauncher } from "./helpers/fake-launcher";
import { TEST_SIGNER } from "./helpers/link-signer";
import { parseAndValidate } from "./helpers/parse-and-validate";
import { NO_PLUGIN_STORAGE } from "./helpers/plugin-storage";
import {
  absentOwners,
  fakeActivity,
  fakeAutoCompact,
  fakeCacheExpiry,
  fakeContext,
  fakeGit,
  fakeMetrics,
  fakeTmux,
  fakeUsage,
} from "./helpers/payload-owners";
import { sumsOf } from "./helpers/today";
import { viewFacts } from "./helpers/view-facts";

const SID = "golden0a-1b2c-4d3e-8f4a-5b6c7d8e9f0a";
const AT = instantOf(new Date(1_700_000_000_000));
const NOW_SEC = Math.floor(AT);
const COLS = 120;
const PROJECT = "/home/tester/code/project";
const PANE = { socket: "/tmp/tmux.sock", pane: "%7", truecolor: null };

let dir: string;
let cleanups: Array<() => void>;
beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ccb-golden-")));
  cleanups = [() => fs.rmSync(dir, { recursive: true, force: true })];
});
afterEach(() => {
  for (const fn of cleanups.reverse()) fn();
});

// A keyed fake whose lane starts its read where it is declared, as every real
// owner's does, so the first read is never made inside a derivation (a view's
// computed over the lane), where the fake could not store it.
function started<L extends { declare: (...args: never[]) => { current: () => unknown } }>(
  owner: L,
): L {
  return {
    ...owner,
    declare: (...args: never[]) => {
      const lane = owner.declare(...args);
      lane.current();
      return lane;
    },
  };
}

// Owners that answer one fixed world, whichever machine runs the test: every
// built-in answers a value, so every preset's every segment has data to draw.
function owners() {
  return {
    ...absentOwners(),
    home: "/home/tester",
    gitProvider: started(fakeGit(() =>
      ok({
        branch: "main",
        status: "dirty",
        aheadBehind: ok({ ahead: 2, behind: 1 }),
        head: ok("c0ffee"),
        sha: ok("abc1234"),
        stashCount: ok(1),
        upstream: ABSENT,
        pullRequest: ok({
          number: 7,
          state: "open",
          url: "https://example.test/pr/7",
        }),
      }),
    )),
    tmuxService: started(fakeTmux(() => ok("work"))),
    hostService: {
      declareName: () => settledLane(ok("tester-box")),
      declareUser: () => settledLane(ok("tester")),
    },
    usageStore: fakeUsage({
      usage: () => ok({ session: { cost: 0.39, tokens: 241_400 } }),
      today: () => ok(sumsOf(AT, 12.5, 3_400_000)),
      speed: () => ABSENT,
    }),
    contextProvider: fakeContext(() =>
      ok({ maxTokens: 1_000_000, totalTokens: 48_487, contextLeftPercentage: 24 }),
    ),
    metricsProvider: fakeMetrics(() =>
      ok({
        lastResponseTime: 8.2,
        responseTime: 4.2,
        sessionDuration: 930,
        messageCount: 8,
        linesAdded: 512,
        linesRemoved: 88,
      }),
    ),
    activityProvider: fakeActivity(() => failed("no transcript", "read")),
    cacheExpiry: fakeCacheExpiry(() => ok(NOW_SEC + 900)),
    autoCompact: fakeAutoCompact(() => ok(400_000)),
  };
}

// The daemon's own composition over those owners: the render cache with the
// session source it serves its views from.
function rig() {
  const providers = owners();
  const sessionState = new SessionState();
  const watchers = new WatcherRegistry({
    clock: systemTimekeeper,
    logger: () => {},
  });
  const cache = new RenderCache<SessionSource>(
    {
      clock: systemTimekeeper,
      stateDir: stateDir({ env: {}, home: dir, tmp: dir }),
      locations: locs(),
      env: {},
      launcher: unscriptedLauncher,
      sessionState,
      watchers,
      storage: NO_PLUGIN_STORAGE,
      signer: TEST_SIGNER,
      gates: bareGates(),
      fileEvents: NO_FILE_EVENTS,
      log: () => {},
      declare: (holds, facts, closure, sources) =>
        declareLanes(providers as never, holds, facts, closure, sources),
      source: sessionSource({
        providers: providers as never,
        sessionState,
        update: () => pendingOf("unread"),
        history: () => EMPTY_HISTORY_DEPTH,
        navigation: () => 0,
      }),
    },
    { budgetBytes: () => 1024 * 1024 * 1024 },
  );
  cleanups.push(() => {
    cache.close();
    watchers.closeAll();
  });
  return { cache, sessionState, providers };
}

// A session's view under `preset`, its request settled as the daemon settles
// one, then the bar it draws at AT and the payload it draws from.
async function drawnUnder(preset: string | null) {
  const { cache, sessionState, providers } = rig();
  if (preset !== null) sessionState.set(SID, "preset", preset);
  const configFile = path.join(dir, "config.json5");
  fs.writeFileSync(configFile, "{}");
  const facts = viewFacts(dir, SID, { tmux: PANE });
  // The session works in a directory that is the same on every machine; the
  // temporary one is only where the config is read from.
  const request = {
    ...facts,
    cwd: PROJECT,
    hookData: {
      ...facts.hookData,
      cwd: PROJECT,
      transcript_path: `${PROJECT}/${SID}.jsonl`,
      workspace: { current_dir: PROJECT, project_dir: PROJECT, added_dirs: [] },
      version: "1.15.0",
      effort: { level: "xhigh" },
      rate_limits: {
        five_hour: { used_percentage: 63, resets_at: NOW_SEC + 2 * 3600 },
        seven_day: { used_percentage: 21, resets_at: NOW_SEC + 5 * 86400 },
      },
    },
  };
  const held = cache.holdSession(dir, dir, configFile, request);
  cleanups.push(() => held[Symbol.dispose]());
  const view: SessionView<SessionSource> = held.view;
  const effective = view.source.effective();
  await settlePayload(
    {
      hookData: request.hookData,
      deps: { ...providers, lanes: view.lanes } as never,
      cwd: PROJECT,
      neededInputPaths: view.state.neededInputPaths(effective.preset),
      hints: request.hints,
    },
    AT,
    new Map(),
  );
  const { frame } = drawDsl(
    view.state.config,
    view.state.compiled,
    view.store,
    view.registry,
    {
      drawing: { by: "request" },
      feeds: UNFOLLOWED_FEEDS,
      today: todayOf(view.source.facts().builtins.today, AT),
    },
    AT,
    renderOptionsOf(effective, COLS),
    {},
    effective,
  );
  return {
    bar: ansiOf(frame).split(dir).join("<dir>"),
    // The temporary directory is the one thing a run names that differs.
    payload: JSON.parse(
      JSON.stringify(view.source.payload()).split(dir).join("<dir>"),
    ) as unknown,
  };
}

const PRESETS = presetNames(DEFAULT_DSL_CONFIG.presets);

describe("a session's view, drawn from fixed owners at a fixed instant", () => {
  test.each([null, ...PRESETS])("preset %s: the bar", async (preset) => {
    expect((await drawnUnder(preset)).bar).toMatchSnapshot();
  });

  test.each([null, ...PRESETS])(
    "preset %s: the payload a template reads",
    async (preset) => {
      expect((await drawnUnder(preset)).payload).toMatchSnapshot();
    },
  );
});

describe("`check`'s representative payload", () => {
  const config = parseAndValidate(
    "<user>",
    "{}",
    new Set(listResolvablePaletteNames()),
    DEFAULT_DSL_CONFIG,
  );

  test.each(PRESETS)("preset %s: the payload and its day", (preset) => {
    const effective = resolveEffectiveGlobals(
      config,
      (key) => (key === "preset" ? preset : null),
      () => false,
    );
    expect({
      payload: checkPayload(config, effective, null, AT),
      today: checkToday(AT),
    }).toMatchSnapshot();
  });
});

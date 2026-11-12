// A session's view, opened through the daemon's own composition (the render
// cache serving views from the session source) over owners that answer one
// fixed world at one fixed instant, whichever machine runs the test.
// [LAW:one-source-of-truth] The golden over the payload's composition and the
// tests of the turn a view draws from open their views through this one rig.

import fs from "node:fs";
import path from "node:path";
import {
  RenderCache,
  type RenderCacheObservers,
  type SessionView,
} from "../../src/daemon/cache/render";
import { WatcherRegistry } from "../../src/daemon/cache/watchers";
import { stateDir } from "../../src/daemon/paths";
import type { CollectorDeps } from "../../src/daemon/collector";
import { collected } from "./collected";
import { settleWorld, type Refreshed } from "../../src/daemon/render-payload";
import {
  sessionSource,
  type SessionSource,
  type SessionSourceDeps,
} from "../../src/daemon/session-source";
import { SessionState } from "../../src/daemon/session-state";
import { EMPTY_HISTORY_DEPTH } from "../../src/daemon/settings-history";
import { systemTimekeeper } from "../../src/time";
import { instantOf } from "../../src/utils/instant";
import { ABSENT, failed, ok, pendingOf } from "../../src/utils/outcome";
import { settledLane } from "../../src/utils/reading";
import { bareGates } from "./gates";
import { locs } from "./host";
import { SourceRuns } from "../../src/var-system/source-runs";
import { unscriptedLauncher } from "./fake-launcher";
import { TEST_SIGNER } from "./link-signer";
import { NO_PLUGIN_STORAGE } from "./plugin-storage";
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
} from "./payload-owners";
import { sumsOf } from "./today";
import { viewFacts } from "./view-facts";
import { sessionIdOf } from "../../src/daemon/session-id";

export const SESSION = sessionIdOf("golden0a-1b2c-4d3e-8f4a-5b6c7d8e9f0a");
export const AT = instantOf(new Date(1_700_000_000_000));
const NOW_SEC = Math.floor(AT);
export const PROJECT = "/home/tester/code/project";
const PANE = { socket: "/tmp/tmux.sock", pane: "%7", truecolor: null };

// A keyed fake whose lane starts its read where it is declared, as every real
// owner's does, so the first read is never made inside a derivation (a view's
// computed over the lane), where the fake could not store it.
function started<
  L extends { declare: (...args: never[]) => { current: () => unknown } },
>(owner: L): L {
  return {
    ...owner,
    declare: (...args: never[]) => {
      const lane = owner.declare(...args);
      lane.current();
      return lane;
    },
  };
}

// Every built-in answers a value, so every preset's every segment has data to
// draw.
export function fixedOwners(
  log: (level: string, message: string) => void = () => {},
) {
  return {
    ...absentOwners(),
    home: "/home/tester",
    log,
    gitProvider: started(
      fakeGit(() =>
        ok({
          branch: "main",
          status: "dirty",
          aheadBehind: ok({ ahead: 2, behind: 1 }),
          head: ok("c0ffee"),
          workingTree: { staged: 0, unstaged: 2, untracked: 1, conflicts: 0 },
          sha: ok("abc1234"),
          operation: ABSENT,
          committedAt: ok(NOW_SEC - 3600),
          stashCount: ok(1),
          upstream: ABSENT,
          repoName: ok("project"),
          repoUrl: ABSENT,
          pullRequest: ok({
            number: 7,
            state: "open",
            url: "https://example.test/pr/7",
            head: "c0ffee",
          }),
        }),
      ),
    ),
    tmuxService: started(fakeTmux(() => ok("work"))),
    hostService: {
      declareName: () => settledLane(ok("tester-box")),
      declareUser: () => settledLane(ok("tester")),
    },
    usageStore: fakeUsage({
      usage: () =>
        ok({ calculatedCost: 0.39, tokens: 241_400, tokenBreakdown: null }),
      today: () => ok(sumsOf(AT, 12.5, 3_400_000)),
      speed: () => ABSENT,
    }),
    // The transcript's folds; the request's hook carries the native window,
    // the cost, the durations and the lines laid over them (`requestOf`).
    contextProvider: fakeContext(() => ok(48_487)),
    metricsProvider: fakeMetrics(() =>
      ok({ lastResponseTime: 8.2, messageCount: 8 }),
    ),
    activityProvider: fakeActivity(() => failed("no transcript", "read")),
    cacheExpiry: fakeCacheExpiry(() => ok(NOW_SEC + 900)),
    autoCompact: fakeAutoCompact(() => ok(400_000)),
  };
}

export type SessionRig = ReturnType<typeof sessionRig>;

// The daemon's composition over those owners: the host's collector reading
// them into world states handed straight to the store the views read, as the
// daemon's renderer takes them. `update` is the update fact every world state
// carries, `source` overrides what the session source reads beyond the world
// state (the depths), `log` is the daemon's log, and `observers` hear what the
// cache tells the daemon.
export function sessionRig(
  dir: string,
  cleanups: Array<() => void>,
  {
    update = () => pendingOf("unread"),
    source = {},
    log = () => {},
    observers = {},
  }: {
    readonly update?: CollectorDeps["update"];
    readonly source?: Partial<SessionSourceDeps>;
    readonly log?: (level: string, message: string) => void;
    readonly observers?: RenderCacheObservers;
  } = {},
) {
  const providers = fixedOwners(log);
  const sessionState = new SessionState();
  const served = collected(
    { owners: providers as never, update, log },
    cleanups,
  );
  const watchers = new WatcherRegistry({
    clock: systemTimekeeper,
    logger: () => {},
  });
  const runs = new SourceRuns({
    launcher: unscriptedLauncher,
    clock: systemTimekeeper,
  });
  cleanups.push(() => runs.close());
  const cache = new RenderCache<SessionSource>(
    {
      clock: systemTimekeeper,
      stateDir: stateDir({ env: {}, home: dir, tmp: dir }),
      locations: locs(),
      env: {},
      runs,
      sessionState,
      watchers,
      storage: NO_PLUGIN_STORAGE,
      signer: TEST_SIGNER,
      gates: bareGates(),
      log,
      source: sessionSource({
        sessionState,
        worldStates: served.worldStates,
        home: providers.home,
        history: () => EMPTY_HISTORY_DEPTH,
        navigation: () => 0,
        ...source,
      }),
    },
    { budgetBytes: () => 1024 * 1024 * 1024, observers },
  );
  served.serve(cache);
  cleanups.push(() => {
    cache.close();
    watchers.closeAll();
  });
  return { cache, sessionState, providers, served };
}

// The session works in a directory that is the same on every machine; the
// temporary one is only where the config is read from.
export function requestOf(dir: string) {
  const facts = viewFacts(dir, SESSION, { tmux: PANE });
  return {
    ...facts,
    cwd: PROJECT,
    hookData: {
      ...facts.hookData,
      cwd: PROJECT,
      transcript_path: `${PROJECT}/${SESSION}.jsonl`,
      workspace: { current_dir: PROJECT, project_dir: PROJECT, added_dirs: [] },
      version: "1.15.0",
      effort: { level: "xhigh" },
      cost: {
        total_cost_usd: 0.39,
        total_duration_ms: 930_000,
        total_api_duration_ms: 4_200,
        total_lines_added: 512,
        total_lines_removed: 88,
      },
      context_window: {
        total_input_tokens: 241_400,
        total_output_tokens: 0,
        context_window_size: 1_000_000,
        used_percentage: 76,
        remaining_percentage: 24,
        current_usage: {
          input_tokens: 48_487,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
      rate_limits: {
        five_hour: { used_percentage: 63, resets_at: NOW_SEC + 2 * 3600 },
        seven_day: { used_percentage: 21, resets_at: NOW_SEC + 5 * 86400 },
      },
    },
  };
}

// A request of the session over `configFile`, as the daemon makes one: the
// request and the world state read at its keys taken as the daemon's renderer
// takes them, the view held, and its wait settled as the daemon settles one.
// `refreshed` records what its arrival refreshed.
export async function settledRequest(
  rig: SessionRig,
  dir: string,
  configFile: string,
  cleanups: Array<() => void>,
  refreshed: Refreshed = new Map(),
): Promise<SessionView<SessionSource>> {
  const request = requestOf(dir);
  const held = rig.served.config(request, () =>
    rig.cache.holdSession(dir, dir, configFile, request),
  );
  cleanups.push(() => held[Symbol.dispose]());
  await settleWorld(
    {
      sessionId: request.sessionId,
      hookData: request.hookData,
      deps: rig.providers as never,
      cwd: PROJECT,
      hints: request.hints,
    },
    AT,
    refreshed,
    () => rig.served.worldStates.of(request.sessionId),
    new AbortController().signal,
  );
  return held.view;
}

// A session's view under `preset` (the config's own when null), its request
// settled as the daemon settles one.
export async function openSettled(
  rig: SessionRig,
  dir: string,
  cleanups: Array<() => void>,
  preset: string | null,
): Promise<SessionView<SessionSource>> {
  if (preset !== null) rig.sessionState.set(SESSION, "preset", preset);
  const configFile = path.join(dir, "config.json5");
  fs.writeFileSync(configFile, "{}");
  return settledRequest(rig, dir, configFile, cleanups);
}

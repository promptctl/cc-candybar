// A session's view, opened through the daemon's own composition (the render
// cache serving views from the session source) over owners that answer one
// fixed world at one fixed instant, whichever machine runs the test.
// [LAW:one-source-of-truth] The golden over the payload's composition and the
// tests of the turn a view draws from open their views through this one rig.

import { systemFilesystem } from "../../src/disk/system-filesystem";
import type { SessionRequest } from "../../src/facts/recording";
import fs from "node:fs";
import path from "node:path";
import {
  RenderCache,
  type RenderCacheObservers,
  type SessionView,
} from "../../src/daemon/cache/render";
import { WatcherRegistry } from "../../src/daemon/cache/watchers";
import { homeOf } from "../../src/daemon/home";
import { stateDir } from "../../src/daemon/paths";
import { inProcessFacts } from "../../src/daemon/facts-source";
import {
  sessionSource,
  type SessionSource,
  type SessionSourceDeps,
} from "../../src/daemon/session-source";
import type { Fact } from "../../src/facts/fact";
import type { UpdateNotice } from "../../src/facts/session-facts";
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
import { TEST_LINKS } from "./link-signer";
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

export const SESSION = "golden0a-1b2c-4d3e-8f4a-5b6c7d8e9f0a";
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
          sha: ok("abc1234"),
          stashCount: ok(1),
          upstream: ABSENT,
          pullRequest: ok({
            number: 7,
            state: "open",
            url: "https://example.test/pr/7",
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
      usage: () => ok({ session: { cost: 0.39, tokens: 241_400 } }),
      today: () => ok(sumsOf(AT, 12.5, 3_400_000)),
      speed: () => ABSENT,
    }),
    contextProvider: fakeContext(() =>
      ok({
        maxTokens: 1_000_000,
        totalTokens: 48_487,
        contextLeftPercentage: 24,
      }),
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

export type SessionRig = ReturnType<typeof sessionRig>;

// The daemon's composition over those owners. `source` overrides what the
// session source reads beyond the document (the depths), `update` is the
// daemon's update fact as the facts source reads it, `log` is the daemon's
// log, and `observers` hear what the cache tells the daemon.
export function sessionRig(
  dir: string,
  cleanups: Array<() => void>,
  {
    source = {},
    update = () => pendingOf("unread"),
    log = () => {},
    observers = {},
  }: {
    readonly source?: Partial<SessionSourceDeps>;
    readonly update?: () => Fact<UpdateNotice>;
    readonly log?: (level: string, message: string) => void;
    readonly observers?: RenderCacheObservers;
  } = {},
) {
  const providers = fixedOwners(log);
  const sessionState = new SessionState();
  const watchers = new WatcherRegistry({ filesystem: systemFilesystem, clock: systemTimekeeper,
    logger: () => {},
  });
  const runs = new SourceRuns({
    launcher: unscriptedLauncher,
    clock: systemTimekeeper,
  });
  cleanups.push(() => runs.close());
  const cache = new RenderCache<SessionSource, SessionRequest>(
    {
      clock: systemTimekeeper,
      stateDir: stateDir(homeOf({ env: {}, home: dir, tmp: dir })),
      locations: locs(),
      sessionState,
      watchers,
      storage: NO_PLUGIN_STORAGE,
      links: TEST_LINKS,
      gates: bareGates(),
      log,
      facts: inProcessFacts({ providers: providers as never, update, runs }),
      source: sessionSource({
        providers: providers as never,
        sessionState,
        history: () => EMPTY_HISTORY_DEPTH,
        navigation: () => 0,
        ...source,
      }),
    },
    { budgetBytes: () => 1024 * 1024 * 1024, observers },
  );
  cleanups.push(() => {
    cache.close();
    watchers.closeAll();
  });
  return { cache, sessionState, providers };
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
      rate_limits: {
        five_hour: { used_percentage: 63, resets_at: NOW_SEC + 2 * 3600 },
        seven_day: { used_percentage: 21, resets_at: NOW_SEC + 5 * 86400 },
      },
    },
  };
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
  const request = requestOf(dir);
  const held = rig.cache.holdSession(dir, dir, configFile, request);
  cleanups.push(() => held[Symbol.dispose]());
  const { view } = held;
  await view.settle(AT).landed;
  return view;
}

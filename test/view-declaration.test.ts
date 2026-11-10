// brandon-unfiled-3248.8ro6, step 3: a view declares every keyed entry of its
// session at the keys its request names, taking the view's holds on the
// daemon's shared entries in the turn it opens — so every read starts before
// any draw asks for it. What the session's picks choose to show declares
// nothing: every built-in is gathered for every session.

import { TEST_SIGNER } from "./helpers/link-signer";
import { HOST, locs } from "./helpers/host";
import { unscriptedLauncher } from "./helpers/fake-launcher";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GitDataProvider } from "../src/daemon/cache/git";
import { SOURCES_NOTHING, RenderCache } from "../src/daemon/cache/render";
import { WatcherRegistry } from "../src/daemon/cache/watchers";
import { SessionState } from "../src/daemon/session-state";
import { parseClientHints } from "../src/daemon/protocol";
import { sessionIdOf } from "../src/daemon/session-id";
import {
  declareLanes,
  type KeyedOwners,
  type ViewFacts,
} from "../src/daemon/render-payload";
import {
  GitService,
  type GitRead,
  type PullRequest,
} from "../src/segments/git";
import { Holds } from "../src/utils/holds";
import { ABSENT, failed, ok, type Outcome } from "../src/utils/outcome";
import { settledLane, type Lane } from "../src/utils/reading";
import { viewFacts } from "./helpers/view-facts";
import { NO_PLUGIN_STORAGE } from "./helpers/plugin-storage";
import { answerRepo } from "./helpers/repo-approval";
import { stateDir } from "../src/daemon/paths";
import { bareGates } from "./helpers/gates";
import { systemTimekeeper } from "../src/time";
import { SourceRuns } from "../src/var-system/source-runs";

const REPO = "/repo";

// A machine whose name and user hold nothing, for the tests not about them.
const NO_HOST = {
  declareName: () => settledLane(ABSENT),
  declareUser: () => settledLane(ABSENT),
};

// The one repo every directory resolves to, its PR looked up by count.
class OneRepo extends GitService {
  prLookups = 0;
  resolutions = 0;

  override resolveEffectiveGitDir(): Outcome<string> {
    this.resolutions++;
    return ok(REPO);
  }

  override resolveGitDir(root: string): string {
    return `${root}/.git`;
  }

  override async getGitInfo(): Promise<Outcome<GitRead>> {
    return ok({
      branch: "main",
      status: "clean",
      aheadBehind: ok({ ahead: 0, behind: 0 }),
      head: ok("c0ffee"),
      workingTree: { staged: 0, unstaged: 0, untracked: 0, conflicts: 0 },
      sha: ok("c0ffee"),
      operation: ABSENT,
      committedAt: ok(1_700_000_000),
      stashCount: ABSENT,
      upstream: ok("origin/main"),
      repoName: ok("widget"),
      repoUrl: ok("https://github.com/acme/widget"),
      isWorktree: false,
    });
  }

  override async getRepoRemoteUrl(): Promise<Outcome<string>> {
    return ok("git@github.com:acme/widget.git");
  }

  override async resolvePullRequest(): Promise<Outcome<PullRequest>> {
    this.prLookups++;
    return ok({
      number: 7,
      state: "open",
      url: "https://example.test/pull/7",
      head: "c0ffee",
    });
  }
}

let dir: string;
let cleanups: Array<() => void>;
beforeEach(() => {
  jest.useFakeTimers();
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ccb-declare-")));
  // The configs these sessions draw are the directory's own.
  answerRepo(dir);
  cleanups = [() => fs.rmSync(dir, { recursive: true, force: true })];
});
afterEach(() => {
  for (const fn of cleanups.reverse()) fn();
  jest.useRealTimers();
});

test("a held repo's PR is looked up with no PR field placed, and a preset pick declares nothing new", async () => {
  // Two presets over one directory: `plain` shows the branch, `pr` shows its
  // PR beside it. The session draws `plain`.
  fs.writeFileSync(
    path.join(dir, ".cc-candybar.json5"),
    JSON.stringify({
      globals: { preset: "plain" },
      presets: {
        plain: { root: { h: ["gitaculous"] } },
        pr: { root: { h: ["gitaculous", "gitPr"] } },
      },
    }),
  );
  const inner = new OneRepo(unscriptedLauncher);
  const git = new GitDataProvider({
    clock: systemTimekeeper,
    inner,
    logger: () => {},
  });
  cleanups.push(() => git.close());
  const sessionState = new SessionState();
  const watchers = new WatcherRegistry({
    clock: systemTimekeeper,
    logger: () => {},
  });
  cleanups.push(() => watchers.closeAll());
  // Only git is under test; the session's other keyed lanes are declared
  // into owners that hold nothing.
  const owners = {
    gitProvider: git,
    tmuxService: { declare: () => settledLane(ABSENT) },
    hostService: NO_HOST,
    usageStore: { declareToday: () => settledLane(ABSENT) },
  } as unknown as KeyedOwners;
  const cache = new RenderCache(
    {
      clock: systemTimekeeper,
      stateDir: stateDir(HOST),
      locations: locs(),
      env: HOST.env,
      runs: new SourceRuns({ launcher: unscriptedLauncher, clock: systemTimekeeper }),
      storage: NO_PLUGIN_STORAGE,
      signer: TEST_SIGNER,
      gates: bareGates(),
      sessionState,
      watchers,
      source: SOURCES_NOTHING,
      declare: (holds, facts, sources) =>
        declareLanes(owners, holds, facts, sources),
    },
    { budgetBytes: () => 1024 * 1024 * 1024 },
  );
  cleanups.push(() => cache.close());

  const facts: ViewFacts = {
    sessionId: sessionIdOf("s1"),
    hookData: {
      hook_event_name: "Status",
      session_id: "s1",
      transcript_path: path.join(dir, "t.jsonl"),
      cwd: dir,
      model: { id: "m", display_name: "M" },
      workspace: { current_dir: dir, project_dir: dir },
    },
    cwd: dir,
    hints: parseClientHints({}),
  };
  // The view opens declared at the session's request: its repo is held in
  // the opening turn (brandon-unfiled-3248.8ro6, 4a/4b).
  const view = (() => {
    using hold = cache.holdSession(dir, dir, undefined, facts);
    return hold.view;
  })();
  expect(git.getStats().held).toBe(1);
  await jest.advanceTimersByTimeAsync(0);
  // The repo's first pass keyed its PR, and the lookup ran with no PR field
  // placed and no draw.
  expect(inner.prLookups).toBe(1);
  // The next request declares again, and finds the repo's value stored.
  view.requested({ ...facts });
  expect(git.getStats()).toMatchObject({ held: 1, hits: 1, misses: 1 });

  // A pick placing the PR, and the pick back: neither declares, so git is
  // asked nothing and the forge is not asked again.
  sessionState.set("s1", "preset", "pr");
  await jest.advanceTimersByTimeAsync(0);
  sessionState.set("s1", "preset", "plain");
  await jest.advanceTimersByTimeAsync(0);
  expect(git.getStats()).toMatchObject({ held: 1, hits: 1, misses: 1 });
  expect(inner.prLookups).toBe(1);
  expect(view.lanes().git.current()).toMatchObject({
    kind: "ok",
    value: { pullRequest: { kind: "ok", value: { number: 7 } } },
  });
});

test("a lane whose declaration throws is reported, takes no hold, and stops no other lane", () => {
  const holds = new Holds();
  const taken: string[] = [];
  const released: string[] = [];
  const take = (key: string): Lane<never> => {
    holds.take(key, () => {
      taken.push(key);
      return () => released.push(key);
    });
    return settledLane(ABSENT);
  };
  const owners = {
    gitProvider: {
      declare: () => {
        throw new Error("resolver bug");
      },
    },
    tmuxService: { declare: () => take("tmux") },
    hostService: {
      declareName: () => take("host.name"),
      declareUser: () => take("host.user"),
    },
    usageStore: { declareToday: () => take("today") },
  } as unknown as KeyedOwners;
  const facts: ViewFacts = {
    sessionId: sessionIdOf("s1"),
    hookData: {
      hook_event_name: "Status",
      session_id: "s1",
      transcript_path: "/t.jsonl",
      cwd: "/w",
      model: { id: "m", display_name: "M" },
      workspace: { current_dir: "/w", project_dir: "/w" },
    },
    cwd: "/w",
    hints: parseClientHints({
      tmux: { socket: "/s", pane: "%1", truecolor: null },
    }),
  };
  // The git hold an earlier declaration took goes with the one that threw.
  holds.declare(() => take("git"));
  const declared = holds.declare(() =>
    declareLanes(owners, holds, facts, new Map()),
  );
  expect(declared.result.faults).toEqual([
    expect.stringMatching(/^git: .*resolver bug/),
  ]);
  // The lane that threw answers its failure; the others answer their own.
  expect(declared.result.lanes.git.current()).toEqual(
    failed("git: Error: resolver bug", "read"),
  );
  expect(declared.result.lanes.tmux.current()).toEqual(ABSENT);
  expect(taken).toEqual(["git", "tmux", "host.name", "host.user", "today"]);
  expect(released).toEqual(["git"]);
  expect(declared).toMatchObject({ acquired: 4, released: 1 });
});

// One directory showing its branch, read through a cache whose git owner is
// real and whose other keyed owners hold nothing.
function gitCache() {
  fs.writeFileSync(
    path.join(dir, ".cc-candybar.json5"),
    JSON.stringify({ root: { h: ["gitaculous"] } }),
  );
  const inner = new OneRepo(unscriptedLauncher);
  const git = new GitDataProvider({
    clock: systemTimekeeper,
    inner,
    logger: () => {},
  });
  cleanups.push(() => git.close());
  const watchers = new WatcherRegistry({
    clock: systemTimekeeper,
    logger: () => {},
  });
  cleanups.push(() => watchers.closeAll());
  const owners = {
    gitProvider: git,
    tmuxService: { declare: () => settledLane(ABSENT) },
    hostService: NO_HOST,
    usageStore: { declareToday: () => settledLane(ABSENT) },
  } as unknown as KeyedOwners;
  const cache = new RenderCache(
    {
      clock: systemTimekeeper,
      stateDir: stateDir(HOST),
      locations: locs(),
      env: HOST.env,
      runs: new SourceRuns({ launcher: unscriptedLauncher, clock: systemTimekeeper }),
      storage: NO_PLUGIN_STORAGE,
      signer: TEST_SIGNER,
      gates: bareGates(),
      sessionState: new SessionState(),
      watchers,
      source: SOURCES_NOTHING,
      declare: (holds, facts, sources) =>
        declareLanes(owners, holds, facts, sources),
    },
    { budgetBytes: () => 1024 * 1024 * 1024 },
  );
  cleanups.push(() => cache.close());
  const view = (() => {
    using hold = cache.holdSession(dir, dir, undefined, viewFacts(dir));
    return hold.view;
  })();
  return { inner, git, cache, view };
}

test("a reload under a view no request reaches opens its successor declared: git draws as git, held once", async () => {
  const { git, cache, view } = gitCache();
  await jest.advanceTimersByTimeAsync(0);
  expect(git.getStats().held).toBe(1);

  // A config edit while a feed draws the session and Claude Code sends
  // nothing: no request will declare the new view.
  fs.writeFileSync(
    path.join(dir, ".cc-candybar.json5"),
    JSON.stringify({
      variables: { edition: { kind: "literal", value: "1" } },
      root: { h: ["gitaculous"] },
    }),
  );
  cache.reload(dir, dir, undefined, { kind: "write" });
  const successor = cache.latestView()!;
  expect(successor).not.toBe(view);
  expect(successor.lanes().git.current()).toMatchObject({
    kind: "ok",
    value: { branch: "main" },
  });
  // The successor took the repo before the old view let it go.
  expect(git.getStats().held).toBe(1);
});

test("frames on an open view neither resolve a directory nor take a hold", async () => {
  const { inner, view } = gitCache();
  await jest.advanceTimersByTimeAsync(0);
  const resolutions = inner.resolutions;
  const take = jest.spyOn(Holds.prototype, "take");
  try {
    // Each frame reads the lanes its view declared, as `readLanes` does,
    // across more than the resolution window.
    for (let frame = 0; frame < 120; frame++) {
      expect(view.lanes().git.current()).toMatchObject({ kind: "ok" });
      await jest.advanceTimersByTimeAsync(1000 / 30);
    }
    jest.advanceTimersByTime(60_000);
    expect(view.lanes().git.current()).toMatchObject({ kind: "ok" });
    expect(inner.resolutions).toBe(resolutions);
    expect(take).not.toHaveBeenCalled();
  } finally {
    take.mockRestore();
  }
});

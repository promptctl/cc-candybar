// brandon-unfiled-3248.8ro6, step 3: a view declares what its preset's closure
// reads. One reaction, over the request the view's renders draw by and the
// preset the session's picks resolve to, takes the view's holds on the
// daemon's shared entries — so a preset click that newly places a source
// starts its read before any draw asks for it, and switching back releases
// the hold, stopping the source's period. Before, a source was declared by the
// first draw that read it, and released only by a sweep 2.5 to 5 minutes
// after the last draw that did.

import { processLauncher } from "../src/proc/launch";
import { TEST_SIGNER } from "./helpers/link-signer";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GitDataProvider, PR_PERIOD } from "../src/daemon/cache/git";
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
import { GitService, type GitInfo, type PullRequest } from "../src/segments/git";
import { Holds } from "../src/utils/holds";
import { ABSENT, failed, ok, type Outcome } from "../src/utils/outcome";
import { settledLane, type Lane } from "../src/utils/reading";
import { viewFacts } from "./helpers/view-facts";
import { NO_PLUGIN_STORAGE } from "./helpers/plugin-storage";
import { answerRepo } from "./helpers/repo-approval";

const REPO = "/repo";

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

  override async getGitInfo(): Promise<Outcome<GitInfo>> {
    return ok({
      branch: "main",
      status: "clean",
      aheadBehind: ok({ ahead: 0, behind: 0 }),
      head: ok("c0ffee"),
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

test("a preset click that newly places the PR starts its lookup with no draw; switching back releases it, and its period stops", async () => {
  // Two presets over one directory: `plain` shows the branch, `pr` shows its
  // PR beside it.
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
  const inner = new OneRepo(processLauncher);
  const git = new GitDataProvider({ inner, logger: () => {} });
  cleanups.push(() => git.close());
  const sessionState = new SessionState();
  const watchers = new WatcherRegistry({ logger: () => {} });
  cleanups.push(() => watchers.closeAll());
  // Only git is under test; the menu's other keyed lanes are declared into
  // owners that hold nothing.
  const owners = {
    gitProvider: git,
    tmuxService: { declare: () => settledLane(ABSENT) },
    usageStore: { declareToday: () => settledLane(ABSENT) },
  } as unknown as KeyedOwners;
  const cache = new RenderCache(
    { launcher: processLauncher, storage: NO_PLUGIN_STORAGE, signer: TEST_SIGNER,
      sessionState,
      watchers,
      source: SOURCES_NOTHING,
      declare: (holds, facts, closure, sources) =>
        declareLanes(owners, holds, facts, closure, sources),
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
  // The next request declares again, and finds the repo's value stored.
  view.requested({ ...facts });
  expect(git.getStats()).toMatchObject({ held: 1, hits: 1, misses: 1 });
  expect(inner.prLookups).toBe(0);

  // The click alone: no request, no frame.
  sessionState.set("s1", "preset", "pr");
  await jest.advanceTimersByTimeAsync(0);
  expect(inner.prLookups).toBe(1);

  // Back: the PR's hold goes with the click, so its period asks the forge no
  // more — across three of its periods, the bar drawn every minute — while
  // the repo stays held.
  sessionState.set("s1", "preset", "plain");
  expect(git.getStats().held).toBe(1);
  for (let minute = 0; minute < (PR_PERIOD.okMs * 3) / 60_000; minute++) {
    await jest.advanceTimersByTimeAsync(60_000);
    using drawn = cache.holdSession(dir, dir, undefined, facts);
    expect(drawn.view).toBe(view);
  }
  expect(inner.prLookups).toBe(1);
  expect(git.getStats().held).toBe(1);
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
    hints: parseClientHints({ tmux: { socket: "/s", pane: "%1", truecolor: null } }),
  };
  // The git hold an earlier declaration took goes with the one that threw.
  holds.declare(() => take("git"));
  const declared = holds.declare(() =>
    declareLanes(
      owners,
      holds,
      facts,
      new Set(["git.branch", "tmux.session", "today.cost"]),
      new Map(),
    ),
  );
  expect(declared.result.faults).toEqual([
    expect.stringMatching(/^git: .*resolver bug/),
  ]);
  // The lane that threw answers its failure; the others answer their own.
  expect(declared.result.lanes.git.current()).toEqual(
    failed("git: Error: resolver bug"),
  );
  expect(declared.result.lanes.tmux.current()).toEqual(ABSENT);
  expect(taken).toEqual(["git", "tmux", "today"]);
  expect(released).toEqual(["git"]);
  expect(declared).toMatchObject({ acquired: 2, released: 1 });
});

// One directory showing its branch, read through a cache whose git owner is
// real and whose other keyed owners hold nothing.
function gitCache() {
  fs.writeFileSync(
    path.join(dir, ".cc-candybar.json5"),
    JSON.stringify({ root: { h: ["gitaculous"] } }),
  );
  const inner = new OneRepo(processLauncher);
  const git = new GitDataProvider({ inner, logger: () => {} });
  cleanups.push(() => git.close());
  const watchers = new WatcherRegistry({ logger: () => {} });
  cleanups.push(() => watchers.closeAll());
  const owners = {
    gitProvider: git,
    tmuxService: { declare: () => settledLane(ABSENT) },
    usageStore: { declareToday: () => settledLane(ABSENT) },
  } as unknown as KeyedOwners;
  const cache = new RenderCache(
    { launcher: processLauncher, storage: NO_PLUGIN_STORAGE, signer: TEST_SIGNER,
      sessionState: new SessionState(),
      watchers,
      source: SOURCES_NOTHING,
      declare: (holds, facts, closure, sources) =>
        declareLanes(owners, holds, facts, closure, sources),
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

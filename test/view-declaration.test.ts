// brandon-unfiled-3248.8ro6, step 3: a view declares what its preset's closure
// reads. One reaction, over the request the view's renders draw by and the
// preset the session's picks resolve to, takes the view's holds on the
// daemon's shared entries — so a preset click that newly places a source
// starts its read before any draw asks for it, and switching back releases
// the hold, stopping the source's period. Before, a source was declared by the
// first draw that read it, and released only by a sweep 2.5 to 5 minutes
// after the last draw that did.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GitDataProvider, PR_PERIOD } from "../src/daemon/cache/git";
import { RenderCache } from "../src/daemon/cache/render";
import { WatcherRegistry } from "../src/daemon/cache/watchers";
import { SessionState } from "../src/daemon/session-state";
import { parseClientHints } from "../src/daemon/protocol";
import {
  declareLanes,
  type KeyedOwners,
  type ViewFacts,
} from "../src/daemon/render-payload";
import { GitService, type GitInfo, type PullRequest } from "../src/segments/git";
import { Holds } from "../src/utils/holds";
import { ok, type Outcome } from "../src/utils/outcome";

const REPO = "/repo";

// The one repo every directory resolves to, its PR looked up by count.
class OneRepo extends GitService {
  prLookups = 0;

  override async resolveEffectiveGitDir(): Promise<Outcome<string>> {
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
  const inner = new OneRepo();
  const git = new GitDataProvider({ inner, logger: () => {} });
  cleanups.push(() => git.close());
  const sessionState = new SessionState();
  const watchers = new WatcherRegistry({ logger: () => {} });
  cleanups.push(() => watchers.closeAll());
  // Only git is under test; the menu's other keyed lanes are declared into
  // owners that hold nothing.
  const owners = {
    gitProvider: git,
    tmuxService: { sessionName: () => undefined },
    mementoProvider: { ceiling: () => undefined },
    usageStore: { holdToday: () => undefined },
  } as unknown as KeyedOwners;
  const cache = new RenderCache(
    {
      sessionState,
      watchers,
      declare: (holds, facts, closure) =>
        declareLanes(owners, holds, facts, closure),
    },
    { budgetBytes: () => 1024 * 1024 * 1024 },
  );
  cleanups.push(() => cache.close());

  const facts: ViewFacts = {
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
  const view = (() => {
    using hold = cache.holdSession(dir, dir, undefined, "s1");
    return hold.view;
  })();
  // The session's request names the repo; its declaration resolves it, and
  // the next declares it at the repo it resolved to.
  view.requested(facts);
  await jest.advanceTimersByTimeAsync(0);
  view.requested({ ...facts });
  await jest.advanceTimersByTimeAsync(0);
  expect(git.getStats().held).toBe(1);
  expect(inner.prLookups).toBe(0);
  // A declaration is no read: the cache's hit rate counts the draws alone.
  expect(git.getStats()).toMatchObject({ hits: 0, misses: 0 });

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
    using drawn = cache.holdSession(dir, dir, undefined, "s1");
    expect(drawn.view).toBe(view);
  }
  expect(inner.prLookups).toBe(1);
  expect(git.getStats().held).toBe(1);
});

test("a lane whose declaration throws is reported, takes no hold, and stops no other lane", () => {
  const holds = new Holds();
  const taken: string[] = [];
  const released: string[] = [];
  const take = (key: string) =>
    holds.take(key, () => {
      taken.push(key);
      return () => released.push(key);
    });
  const owners = {
    gitProvider: {
      declare: () => {
        throw new Error("resolver bug");
      },
    },
    tmuxService: { sessionName: () => take("tmux") },
    mementoProvider: { ceiling: () => take("memento") },
    usageStore: { holdToday: () => take("today") },
  } as unknown as KeyedOwners;
  const facts: ViewFacts = {
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
  let faults: readonly string[] = [];
  const declared = holds.declare(() => {
    faults = declareLanes(
      owners,
      holds,
      facts,
      new Set(["git.branch", "tmux.session", "memento.ceiling", "today.cost"]),
    );
  });
  expect(faults).toEqual([expect.stringMatching(/^git: .*resolver bug/)]);
  expect(taken).toEqual(["git", "tmux", "memento", "today"]);
  expect(released).toEqual(["git"]);
  expect(declared).toEqual({ acquired: 3, released: 1 });
});

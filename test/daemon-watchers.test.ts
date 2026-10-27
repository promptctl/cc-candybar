import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  WatcherRegistry,
  type Invalidation,
} from "../src/daemon/cache/watchers";
import { GitDataProvider } from "../src/daemon/cache/git";
import { GitService, type GitInfo } from "../src/segments/git";
import { ok, type Outcome } from "../src/utils/outcome";
import { Holds } from "../src/utils/holds";
import { until } from "./helpers/until";
import {
  WATCH_LIVENESS_BUDGET_MS,
  WATCH_RETRY_MS,
} from "./helpers/reload-signal";
import { laneOutcome } from "../src/utils/reading";

function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "powerline-watch-"));
  execSync("git init -q", { cwd: dir });
  execSync("git config user.email t@t.t && git config user.name t", {
    cwd: dir,
  });
  fs.writeFileSync(path.join(dir, "f"), "x");
  execSync("git add . && git commit -q -m init", { cwd: dir });
  return dir;
}

function rmrf(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

describe("WatcherRegistry", () => {
  // fs.watch has no ready signal (on macOS the FSEvents stream goes live
  // after the call returns), so the write is re-applied until an event
  // proves the watch was live — the only proof there is — never written once
  // after a sleep that bets on it.
  test("a write to a watched name fires invalidation", async () => {
    const repo = makeRepo();
    const reg = new WatcherRegistry();
    let fired = 0;
    const headPath = path.join(repo, ".git/HEAD");
    reg.acquire(
      repo,
      { dirs: [{ path: path.dirname(headPath), filenames: ["HEAD"] }] },
      () => fired++,
    );
    try {
      const rewrite = setInterval(
        () => fs.writeFileSync(headPath, "ref: refs/heads/x\n"),
        WATCH_RETRY_MS,
      );
      try {
        await until(
          () => fired >= 1,
          "HEAD write fired the watch",
          WATCH_LIVENESS_BUDGET_MS,
        );
      } finally {
        clearInterval(rewrite);
      }
    } finally {
      reg.closeAll();
      rmrf(repo);
    }
  });

  test("refcount: release closes watchers when refcount hits zero", async () => {
    const repo = makeRepo();
    const reg = new WatcherRegistry();
    const h1 = reg.acquire(repo, { dirs: [] }, () => {});
    const h2 = reg.acquire(repo, { dirs: [] }, () => {});
    expect(reg.size()).toBe(1);
    h1.release();
    expect(reg.size()).toBe(1); // refcount still > 0
    h2.release();
    expect(reg.size()).toBe(0);
    rmrf(repo);
  });

  // brandon-unfiled-3248.576q: the registry bounds nothing — its consumers do.
  // An LRU cap here closed watches under holders that still held them.
  test("a slot closes only when its last holder releases it, however many are open", () => {
    const counters = {
      watchersOpened: 0,
      watchersClosed: 0,
      watchRefusals: 0,
      watchErrors: 0,
    };
    const reg = new WatcherRegistry({ counters });
    const fired: string[] = [];
    const handles = Array.from({ length: 300 }, (_, i) =>
      reg.acquire(`k${i}`, { dirs: [] }, () => fired.push(`k${i}`)),
    );

    expect(reg.size()).toBe(300);
    expect(counters).toEqual({
      watchersOpened: 300,
      watchersClosed: 0,
      watchRefusals: 0,
      watchErrors: 0,
    });
    expect(fired).toEqual([]);

    handles[0]!.release();
    expect(reg.size()).toBe(299);
    expect(counters.watchersClosed).toBe(1);
    reg.closeAll();
  });

  test("hands its consumer the basenames that fired in the window", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "watch-names-"));
    const reg = new WatcherRegistry();
    const seen: Invalidation[] = [];
    reg.acquire(dir, { dirs: [{ path: dir }] }, (inv) => seen.push(inv));
    await new Promise((r) => setTimeout(r, 50));
    fs.writeFileSync(path.join(dir, "a.json"), "1");
    fs.writeFileSync(path.join(dir, "b.json"), "2");
    // FSEvents may also report the folder's own creation late, under its
    // name: the names are what fired, whatever else did.
    const names = () =>
      seen.flatMap((inv) => (inv.kind === "changed" ? [...inv.names] : []));
    await until(
      () => names().includes("a.json") && names().includes("b.json"),
      "both files' names",
    );
    expect(seen.every((inv) => inv.kind === "changed")).toBe(true);
    reg.closeAll();
    rmrf(dir);
  });

  test("a tree target hears a write below its first level, named by its relative path", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "watch-tree-"));
    const reg = new WatcherRegistry();
    const seen: Invalidation[] = [];
    reg.acquire(dir, { dirs: [{ path: dir, recursive: true }] }, (inv) =>
      seen.push(inv),
    );
    const names = () =>
      seen.flatMap((inv) => (inv.kind === "changed" ? [...inv.names] : []));
    const leaf = path.join("a", "b", "c");
    // The directories appear under the live watch, as a branch's `fix/`
    // directory appears under a repo's watch, and the leaf's write is
    // re-applied until the watch proves itself live on it.
    fs.mkdirSync(path.join(dir, "a", "b"), { recursive: true });
    const rewrite = setInterval(
      () => fs.writeFileSync(path.join(dir, leaf), "1"),
      WATCH_RETRY_MS,
    );
    try {
      await until(
        () => names().includes(leaf),
        () => `the leaf's relative path among ${JSON.stringify(names())}`,
        WATCH_LIVENESS_BUDGET_MS,
      );
    } finally {
      clearInterval(rewrite);
      reg.closeAll();
      rmrf(dir);
    }
  });

  test("a refused target comes back on the handle and in the stats, never as opened", () => {
    const counters = {
      watchersOpened: 0,
      watchersClosed: 0,
      watchRefusals: 0,
      watchErrors: 0,
    };
    const reg = new WatcherRegistry({ counters, logger: () => {} });
    const missing = path.join(os.tmpdir(), "watch-refused-no-such-folder");
    const handle = reg.acquire("k", { dirs: [{ path: missing }] }, () => {});
    expect(handle.refused).toEqual([
      { path: missing, reason: expect.stringContaining("ENOENT") },
    ]);
    // A second holder of the slot is told the same.
    expect(reg.acquire("k", { dirs: [] }, () => {}).refused).toEqual(
      handle.refused,
    );
    expect(counters).toEqual({
      watchersOpened: 0,
      watchersClosed: 0,
      watchRefusals: 1,
      watchErrors: 0,
    });
    // Its release is counted like any slot's: opened plus refusals less
    // closed is what is held now.
    reg.closeAll();
    expect(counters.watchersClosed).toBe(1);
  });

  test("an error after open reaches the consumer and the stats", async () => {
    const fake = new EventEmitter() as EventEmitter & { close(): void };
    fake.close = () => {};
    const watch = jest
      .spyOn(fs, "watch")
      .mockImplementation((() => fake) as unknown as typeof fs.watch);
    try {
      const counters = {
        watchersOpened: 0,
        watchersClosed: 0,
        watchRefusals: 0,
        watchErrors: 0,
      };
      const reg = new WatcherRegistry({ counters, logger: () => {} });
      const seen: Invalidation[] = [];
      reg.acquire("k", { dirs: [{ path: "/w" }] }, (inv) => seen.push(inv));
      fake.emit("error", new Error("EMFILE: too many open files"));
      await until(() => seen.length > 0, "the error's invalidation");
      expect(seen).toEqual([
        { kind: "failed", reason: "/w: EMFILE: too many open files" },
      ]);
      expect(counters).toMatchObject({ watchersOpened: 1, watchErrors: 1 });
      reg.closeAll();
    } finally {
      watch.mockRestore();
    }
  });

  test("closeAll closes every watcher", () => {
    const repo = makeRepo();
    const reg = new WatcherRegistry();
    reg.acquire(repo, { dirs: [] }, () => {});
    expect(reg.size()).toBe(1);
    reg.closeAll();
    expect(reg.size()).toBe(0);
    rmrf(repo);
  });
});

class StubInner extends GitService {
  public calls = 0;
  constructor(private repo: string) {
    super();
  }
  override findGitRoot(): Outcome<string> {
    return ok(this.repo);
  }
  override async getGitInfo(): Promise<Outcome<GitInfo>> {
    this.calls++;
    return ok({
      branch: "main",
      status: "clean",
      aheadBehind: ok({ ahead: 0, behind: 0 }),
      head: ok("c0ffee"),
    });
  }
}

const sha = (ref: string, cwd: string): string =>
  execSync(`git rev-parse ${ref}`, { cwd, encoding: "utf8" }).trim();

// A ref-only move — nothing but the branch's ref rewritten, no HEAD, no index
// — on a slash-named branch checked out in `workingDir`, heard by the repo's
// watch with no read asking, until the stored head is the ref's.
//
// The branch is cut only once the watch has proven itself live, because that
// is the order a session meets: its repo is declared long before a branch is
// cut, so `refs/heads/fix/` appears under a watch already open. On Linux the
// tree watch has to pick a new directory up itself; a watch opened over an
// existing one proves nothing about that.
async function hearsRefOnlyMove(
  workingDir: string,
  branch: string,
): Promise<void> {
  // The real reader: what it stores is what git reads off the repo, so the
  // test can ask whether the value is the ref's after a move.
  const inner = new GitService();
  const svc = new GitDataProvider({ inner, periodMs: 600_000 });
  const lane = svc.declare(new Holds(), workingDir, {});
  await laneOutcome(lane);
  const storedHead = (): string | undefined => {
    const info = lane.current();
    return info.kind === "ok" && info.value.head.kind === "ok"
      ? info.value.head.value
      : undefined;
  };
  try {
    // fs.watch has no ready signal: HEAD is rewritten, unchanged, until the
    // watch fires a change, which only the watch can raise. Written as git
    // writes it, a `.lock` renamed over it, so a read mid-rewrite never sees
    // an empty HEAD.
    const headPath = path.join(inner.resolveGitDir(workingDir), "HEAD");
    const head = fs.readFileSync(headPath, "utf8");
    const rewrite = setInterval(() => {
      fs.writeFileSync(`${headPath}.lock`, head);
      fs.renameSync(`${headPath}.lock`, headPath);
    }, WATCH_RETRY_MS);
    try {
      await until(
        () => svc.getStats().changes >= 1,
        "the HEAD rewrite's change",
        WATCH_LIVENESS_BUDGET_MS,
      );
    } finally {
      clearInterval(rewrite);
    }

    execSync(`git checkout -q -b ${branch}`, { cwd: workingDir });
    const tip = sha("HEAD", workingDir);
    const parent = sha("HEAD~1", workingDir);
    // The move alternates the ref between the two commits so that every
    // re-application is a write; a same-value update-ref touches nothing.
    const seen = new Set<string>();
    let atParent = false;
    const move = setInterval(() => {
      atParent = !atParent;
      execSync(
        `git update-ref refs/heads/${branch} ${atParent ? parent : tip}`,
        {
          cwd: workingDir,
        },
      );
    }, WATCH_RETRY_MS);
    try {
      await until(
        () => {
          const now = storedHead();
          if (now !== undefined) seen.add(now);
          return seen.has(parent);
        },
        "a re-read storing the moved ref's head",
        WATCH_LIVENESS_BUDGET_MS,
      );
    } finally {
      clearInterval(move);
    }
    // A change mid-read queues one re-read after it, so the last move lands.
    await until(
      () => storedHead() === sha(branch, workingDir),
      () => `the last move's head; stored ${storedHead()}`,
    );
  } finally {
    svc.close();
  }
}

describe("GitDataProvider + watchers integration", () => {
  test("a ref-only move on a slash-named branch is heard in a main checkout (brandon-unfiled-3248.1x2q)", async () => {
    const repo = makeRepo();
    execSync("git commit -q --allow-empty -m second", { cwd: repo });
    try {
      await hearsRefOnlyMove(repo, "fix/thing");
    } finally {
      rmrf(repo);
    }
  });

  test("a ref-only move on a slash-named branch is heard in a linked worktree, whose own git dir holds no refs (brandon-unfiled-3248.1x2q)", async () => {
    const repo = makeRepo();
    execSync("git commit -q --allow-empty -m second", { cwd: repo });
    const worktree = path.join(repo, "..", path.basename(repo) + "-wt");
    execSync(`git worktree add -q "${worktree}"`, { cwd: repo });
    try {
      await hearsRefOnlyMove(worktree, "feat/thing");
    } finally {
      rmrf(worktree);
      rmrf(repo);
    }
  });

  test("a HEAD change re-reads the repo with no read asking", async () => {
    const repo = makeRepo();
    const inner = new StubInner(repo);
    const svc = new GitDataProvider({ inner });
    const holds = new Holds();

    await laneOutcome(svc.declare(holds, repo, {}));
    await laneOutcome(svc.declare(holds, repo, {}));
    expect(inner.calls).toBe(1);
    await new Promise((r) => setTimeout(r, 50));

    fs.writeFileSync(path.join(repo, ".git/HEAD"), "ref: refs/heads/y\n");
    // FSEvents may deliver the one write as more than one event, and a fire
    // mid-read queues one re-read after it, so the count is at least one more.
    await until(() => inner.calls >= 2, "the HEAD change's re-read");
    expect(svc.getStats().changes).toBeGreaterThanOrEqual(1);
    // The read takes the value the change's re-read stored.
    const reads = inner.calls;
    await laneOutcome(svc.declare(holds, repo, {}));
    expect(inner.calls).toBe(reads);

    svc.close();
    rmrf(repo);
  });

  test("a held repo is re-read on its period, which a dropped watch event cannot stop", async () => {
    const repo = makeRepo();
    const inner = new StubInner(repo);
    const svc = new GitDataProvider({ inner, periodMs: 150 });
    const holds = new Holds();

    await laneOutcome(svc.declare(holds, repo, {}));
    expect(inner.calls).toBe(1);
    await new Promise((r) => setTimeout(r, 400));
    expect(inner.calls).toBeGreaterThanOrEqual(3);

    // Released, the repo costs no read on the period.
    holds.declare(() => {});
    const after = inner.calls;
    await new Promise((r) => setTimeout(r, 400));
    expect(inner.calls).toBe(after);
    svc.close();
    rmrf(repo);
  });

  test("close releases all watchers", async () => {
    const repo = makeRepo();
    const inner = new StubInner(repo);
    const svc = new GitDataProvider({ inner });
    await laneOutcome(svc.declare(new Holds(), repo, {}));
    expect(svc.getStats().watchers).toBe(1);
    svc.close();
    expect(svc.getStats().watchers).toBe(0);
    rmrf(repo);
  });
});

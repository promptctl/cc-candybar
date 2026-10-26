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
  test("HEAD modification fires invalidation within debounce window", async () => {
    const repo = makeRepo();
    const reg = new WatcherRegistry();
    let fired = 0;
    const headPath = path.join(repo, ".git/HEAD");
    reg.acquire(repo, { files: [headPath], dirs: [] }, () => fired++);
    await new Promise((r) => setTimeout(r, 50));

    fs.writeFileSync(headPath, "ref: refs/heads/x\n");
    await new Promise((r) => setTimeout(r, 400));

    expect(fired).toBeGreaterThanOrEqual(1);
    reg.closeAll();
    rmrf(repo);
  });

  test("refcount: release closes watchers when refcount hits zero", async () => {
    const repo = makeRepo();
    const reg = new WatcherRegistry();
    const h1 = reg.acquire(repo, { files: [], dirs: [] }, () => {});
    const h2 = reg.acquire(repo, { files: [], dirs: [] }, () => {});
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
    const counters = { watchersOpened: 0, watchersClosed: 0, watchRefusals: 0, watchErrors: 0 };
    const reg = new WatcherRegistry({ counters });
    const fired: string[] = [];
    const handles = Array.from({ length: 300 }, (_, i) =>
      reg.acquire(`k${i}`, { files: [], dirs: [] }, () => fired.push(`k${i}`)),
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
    reg.acquire(dir, { files: [], dirs: [{ path: dir }] }, (inv) =>
      seen.push(inv),
    );
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

  test("a refused target comes back on the handle and in the stats, never as opened", () => {
    const counters = {
      watchersOpened: 0,
      watchersClosed: 0,
      watchRefusals: 0,
      watchErrors: 0,
    };
    const reg = new WatcherRegistry({ counters, logger: () => {} });
    const missing = path.join(os.tmpdir(), "watch-refused-no-such-folder");
    const handle = reg.acquire(
      "k",
      { files: [], dirs: [{ path: missing }] },
      () => {},
    );
    expect(handle.refused).toEqual([
      { path: missing, reason: expect.stringContaining("ENOENT") },
    ]);
    // A second holder of the slot is told the same.
    expect(reg.acquire("k", { files: [], dirs: [] }, () => {}).refused).toEqual(
      handle.refused,
    );
    expect(counters).toEqual({
      watchersOpened: 0,
      watchersClosed: 0,
      watchRefusals: 1,
      watchErrors: 0,
    });
    reg.closeAll();
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
      reg.acquire("k", { files: [], dirs: [{ path: "/w" }] }, (inv) =>
        seen.push(inv),
      );
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
    reg.acquire(repo, { files: [], dirs: [] }, () => {});
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

describe("GitDataProvider + watchers integration", () => {
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

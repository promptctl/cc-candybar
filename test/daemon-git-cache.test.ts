import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  GIT_PERIOD_MS,
  GitDataProvider,
  PR_PERIOD,
} from "../src/daemon/cache/git";
import { WatcherRegistry } from "../src/daemon/cache/watchers";
import {
  GitService,
  type GitInfo,
  type PullRequest,
} from "../src/segments/git";
import { ABSENT, failed, ok, type Outcome } from "../src/utils/outcome";
import { Holds } from "../src/utils/holds";

class StubGitService extends GitService {
  public computeCalls: Array<{
    workingDir: string;
    projectDir?: string;
    options: Parameters<GitService["getGitInfo"]>[1];
  }> = [];
  public resolveCalls: Array<{ workingDir: string; projectDir?: string }> = [];
  public gitDirCalls: string[] = [];
  // Per-workingDir override for resolveGitDir. Worktree tests use this to
  // simulate the `.git`-is-a-file → resolved-gitDir indirection without
  // setting up real worktree filesystems.
  public gitDirByDir: Record<string, string> = {};
  public repoRootByDir: Record<string, string | null> = {};
  // Per-(workingDir, projectDir) override for resolveEffectiveGitDir. The
  // default behavior (when a key is absent) falls back to repoRootByDir.
  // Tests that exercise projectDir-driven cache-key behavior populate this
  // map directly.
  public effectiveDirByKey: Record<string, string | null> = {};
  public stubInfo: GitInfo = {
    branch: "main",
    status: "clean",
    aheadBehind: ok({ ahead: 0, behind: 0 }),
    head: ok("c0ffee"),
  };
  public prCalls: Array<{ workingDir: string; remoteUrl: string }> = [];
  public stubPr: Outcome<PullRequest> = ok({
    number: 7,
    state: "open",
    url: "https://example.test/pull/7",
    head: "c0ffee",
  });
  public stubRemote: Outcome<string> = ok("git@github.com:acme/widget.git");
  public remoteGate: { promise: Promise<void>; resolve: () => void } | null =
    null;

  public remoteCalls = 0;

  override async getRepoRemoteUrl(
    _workingDir: string,
  ): Promise<Outcome<string>> {
    this.remoteCalls++;
    const remote = this.stubRemote;
    if (this.remoteGate) await this.remoteGate.promise;
    return remote;
  }

  // Holds every forge lookup open until resolved; a lookup answers with the PR
  // the forge held as it BEGAN.
  public prGate: { promise: Promise<void>; resolve: () => void } | null = null;

  override async resolvePullRequest(
    workingDir: string,
    remoteUrl: string,
  ): Promise<Outcome<PullRequest>> {
    this.prCalls.push({ workingDir, remoteUrl });
    const pr = this.stubPr;
    if (this.prGate) await this.prGate.promise;
    return pr;
  }

  override async findGitRoot(workingDir: string): Promise<Outcome<string>> {
    const root = this.repoRootByDir[workingDir] ?? null;
    return root === null ? ABSENT : ok(root);
  }

  override resolveGitDir(workingDir: string): string {
    this.gitDirCalls.push(workingDir);
    if (workingDir in this.gitDirByDir) return this.gitDirByDir[workingDir]!;
    return `${workingDir}/.git`;
  }

  // Resolution knobs the resolution-cache tests drive: a `failed` outcome, a
  // rejection (a resolver bug), and a gate that holds every resolution open so
  // concurrent callers are genuinely concurrent rather than merely interleaved.
  public resolveFailure: string | null = null;
  public resolveThrows = false;
  public resolveGate: { promise: Promise<void>; resolve: () => void } | null =
    null;

  override async resolveEffectiveGitDir(
    workingDir: string,
    projectDir?: string,
  ): Promise<Outcome<string>> {
    this.resolveCalls.push({ workingDir, projectDir });
    if (this.resolveGate) await this.resolveGate.promise;
    if (this.resolveThrows) throw new Error("resolver bug");
    if (this.resolveFailure !== null) {
      return { kind: "failed", reason: this.resolveFailure };
    }
    const key = projectDir ? `${workingDir}|${projectDir}` : workingDir;
    if (key in this.effectiveDirByKey) {
      const dir = this.effectiveDirByKey[key] ?? null;
      return dir === null ? ABSENT : ok(dir);
    }
    const root = this.repoRootByDir[workingDir] ?? null;
    return root === null ? ABSENT : ok(root);
  }

  // A repo `git status` could not read: the fetch outcome is `failed`.
  public infoFailure: string | null = null;
  // Holds every read open until resolved, so a test can land a change while a
  // read is out. The read answers with what the repo held as it BEGAN.
  public infoGate: { promise: Promise<void>; resolve: () => void } | null =
    null;

  override async getGitInfo(
    workingDir: string,
    options: Parameters<GitService["getGitInfo"]>[1] = {},
    projectDir?: string,
  ): Promise<Outcome<GitInfo>> {
    if (!(workingDir in this.repoRootByDir)) return ABSENT;
    if (this.repoRootByDir[workingDir] === null) return ABSENT;
    this.computeCalls.push({ workingDir, projectDir, options });
    const failure = this.infoFailure;
    const info = this.stubInfo;
    if (this.infoGate) await this.infoGate.promise;
    return failure !== null ? failed(failure) : ok(info);
  }
}

function makeCache(
  opts: {
    periodMs?: number;
    maxRepos?: number;
    // Throws once on the first message it matches, standing in for a bug
    // inside a refresh.
    throwOn?: string;
  } = {},
) {
  const inner = new StubGitService();
  const logs: string[] = [];
  let throwOn = opts.throwOn;
  const svc = new GitDataProvider({
    periodMs: opts.periodMs,
    maxRepos: opts.maxRepos,
    inner,
    logger: (_level, message) => {
      if (throwOn !== undefined && message.includes(throwOn)) {
        throwOn = undefined;
        throw new Error("logger bug");
      }
      logs.push(message);
    },
  });
  return { svc, inner, logs, holds: new Holds() };
}

// A promise whose settling the test controls — the only way to make a read
// genuinely in flight, rather than hoping an await boundary lands where needed.
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// Drains a refresh a watch fire started: it has no handle of its own to await,
// and its chain (fetch, settle, the PR's remote read) is a few rounds deep.
async function tick(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) {
    await new Promise<void>((r) => setImmediate(r));
  }
}

afterEach(() => {
  jest.useRealTimers();
});

describe("GitDataProvider", () => {
  test("two cwds in same repo share one state", async () => {
    const { svc, inner, holds } = makeCache();
    inner.repoRootByDir = {
      "/repo/a": "/repo",
      "/repo/b": "/repo",
      "/repo": "/repo",
    };

    await svc.getGitInfo(holds, "/repo/a", { showSha: false });
    await svc.getGitInfo(holds, "/repo/b", { showSha: false });

    expect(inner.computeCalls).toHaveLength(1);
    expect(svc.getStats()).toMatchObject({ size: 1, hits: 1, misses: 1 });
  });

  test("different repos get different states", async () => {
    const { svc, inner, holds } = makeCache();
    inner.repoRootByDir = { "/r1": "/r1", "/r2": "/r2" };

    await svc.getGitInfo(holds, "/r1", {});
    await svc.getGitInfo(holds, "/r2", {});

    expect(svc.getStats().size).toBe(2);
    expect(inner.computeCalls).toHaveLength(2);
  });

  test("different option sets in one repo are separate values of it", async () => {
    const { svc, inner, holds } = makeCache();
    inner.repoRootByDir = { "/repo": "/repo" };

    await svc.getGitInfo(holds, "/repo", { showSha: true });
    await svc.getGitInfo(holds, "/repo", { showSha: false });

    expect(svc.getStats().size).toBe(1);
    // A new option set is read by a pass over the whole repo — one serialized
    // loop per repo is what keeps an older read from landing over a newer one —
    // so the set already held is read again beside it.
    expect(inner.computeCalls).toHaveLength(3);
    await svc.getGitInfo(holds, "/repo", { showSha: true });
    await svc.getGitInfo(holds, "/repo", { showSha: false });
    expect(inner.computeCalls).toHaveLength(3);
  });

  test("a read of a warm repo never fetches", async () => {
    const { svc, inner, holds } = makeCache();
    inner.repoRootByDir["/repo"] = "/repo";

    for (let i = 0; i < 5; i++) await svc.getGitInfo(holds, "/repo", {});

    expect(inner.computeCalls).toHaveLength(1);
    expect(svc.getStats()).toMatchObject({ hits: 4, misses: 1 });
  });

  test("the LRU evicts the oldest repo nobody holds", async () => {
    const { svc, inner } = makeCache({ maxRepos: 3 });
    for (let i = 0; i < 5; i++) {
      inner.repoRootByDir[`/r${i}`] = `/r${i}`;
      const holds = new Holds();
      await svc.getGitInfo(holds, `/r${i}`, {});
      holds.releaseUnread();
      holds.releaseUnread();
    }
    expect(svc.getStats().size).toBe(3);
  });

  test("a held repo is never evicted: it keeps its value past the cap", async () => {
    const { svc, inner } = makeCache({ maxRepos: 1 });
    inner.repoRootByDir = { "/a": "/a", "/b": "/b", "/c": "/c" };
    const holdsA = new Holds();
    const holdsB = new Holds();

    await svc.getGitInfo(holdsA, "/a", {});
    await svc.getGitInfo(holdsB, "/b", {});
    expect(svc.getStats()).toMatchObject({ size: 2, held: 2 });
    holdsB.releaseUnread();
    holdsB.releaseUnread();
    await svc.getGitInfo(new Holds(), "/c", {}); // evicts /b, never /a

    inner.computeCalls = [];
    await svc.getGitInfo(holdsA, "/a", {});
    await svc.getGitInfo(new Holds(), "/b", {});
    expect(inner.computeCalls.map((c) => c.workingDir)).toEqual(["/b"]);
  });

  test("non-repo path returns absent and creates no state", async () => {
    const { svc, inner, holds } = makeCache();
    inner.repoRootByDir = { "/nowhere": null };

    const r1 = await svc.getGitInfo(holds, "/nowhere", {});
    expect(r1).toEqual({ kind: "absent" });
    expect(svc.getStats().size).toBe(0);
    expect(holds.size).toBe(0);
  });

  test("projectDir override keys the state on effective gitDir, not workingDir", async () => {
    // workingDir=/cwd is in repoA, but a projectDir=/repoB override makes the
    // effective gitDir /repoB. The state must follow the effective gitDir so
    // repo B's data doesn't get stored under repo A's key.
    const { svc, inner, holds } = makeCache();
    inner.repoRootByDir = {
      "/cwd": "/repoA",
      "/repoA": "/repoA",
      "/repoB": "/repoB",
    };
    inner.effectiveDirByKey = {
      "/cwd|/repoB": "/repoB", // with projectDir, gitDir becomes /repoB
      "/cwd": "/repoA", // without, gitDir is /repoA
    };

    await svc.getGitInfo(holds, "/cwd", {}, "/repoB");
    await svc.getGitInfo(holds, "/cwd", {});

    expect(svc.getStats().size).toBe(2);
    const dirs = inner.computeCalls.map((c) => c.workingDir).sort();
    expect(dirs).toEqual(["/repoA", "/repoB"]);
  });

  test("worktree path resolves HEAD/index from .git file's gitdir target", async () => {
    // In a worktree, repoRoot/.git is a *file* pointing at the real metadata
    // dir under main-repo/.git/worktrees/. The watch must follow that pointer
    // or it silently no-ops.
    const { svc, inner, holds } = makeCache();
    inner.repoRootByDir = { "/wt": "/wt" };
    inner.gitDirByDir = { "/wt": "/main/.git/worktrees/wt" };

    const r = await svc.getGitInfo(holds, "/wt", {});
    expect(r).toMatchObject({ kind: "ok", value: { branch: "main" } });
    expect(inner.gitDirCalls).toContain("/wt");
  });

  test("concurrent first reads of one value share one fetch", async () => {
    const { svc, inner, holds } = makeCache();
    inner.repoRootByDir = { "/repo": "/repo" };

    const [r1, r2] = await Promise.all([
      svc.getGitInfo(holds, "/repo", {}),
      svc.getGitInfo(holds, "/repo", {}),
    ]);

    expect(r1).toMatchObject({ kind: "ok", value: { branch: "main" } });
    expect(r2).toBe(r1); // same object → same fetch
    expect(inner.computeCalls).toHaveLength(1);
    // Both waited for the first value.
    expect(svc.getStats()).toMatchObject({ size: 1, hits: 0, misses: 2 });
  });

  test("two cwds with same projectDir share one state", async () => {
    const { svc, inner, holds } = makeCache();
    inner.repoRootByDir = {
      "/cwd-x": "/repoA",
      "/cwd-y": "/repoA",
      "/repoA": "/repoA",
    };
    inner.effectiveDirByKey = {
      "/cwd-x|/repoA": "/repoA",
      "/cwd-y|/repoA": "/repoA",
    };

    await svc.getGitInfo(holds, "/cwd-x", {}, "/repoA");
    await svc.getGitInfo(holds, "/cwd-y", {}, "/repoA");

    expect(svc.getStats()).toMatchObject({ size: 1, hits: 1, misses: 1 });
  });

  test("a home holds a repo once per option set it reads, however often it reads it", async () => {
    const { svc, inner, holds } = makeCache();
    inner.repoRootByDir = { "/repo/a": "/repo", "/repo/b": "/repo" };

    await svc.getGitInfo(holds, "/repo/a", {});
    await svc.getGitInfo(holds, "/repo/b", {});
    expect(holds.size).toBe(1);
    await svc.getGitInfo(holds, "/repo/b", { showSha: true });
    expect(holds.size).toBe(2);
    expect(svc.getStats().held).toBe(1);
    holds.releaseUnread();
    holds.releaseUnread();
    expect(svc.getStats().held).toBe(0);
  });
});

// cmt-2bc3832b: a pass reads the option sets something reads, and the forge is
// asked only about a PR something shows — so a closure a preset switch left
// stops costing its reads once the home's sweep releases it.
describe("GitDataProvider reads what is held", () => {
  const sets = (inner: StubGitService) =>
    inner.computeCalls.map((c) => JSON.stringify(c.options));

  test("an option set nobody reads is left out of the pass; read again, it is stored and read at once", async () => {
    jest.useFakeTimers();
    const { svc, inner, holds } = makeCache();
    inner.repoRootByDir = { "/repo": "/repo" };
    await svc.getGitInfo(holds, "/repo", { showSha: true });

    // The home moves to another closure, and its sweep releases the first.
    const moved = new Holds();
    await svc.getGitInfo(moved, "/repo", { showStashCount: true });
    holds.releaseUnread();
    holds.releaseUnread();
    inner.computeCalls = [];
    await jest.advanceTimersByTimeAsync(GIT_PERIOD_MS);
    expect(sets(inner)).toEqual([JSON.stringify({ showStashCount: true })]);

    // The first closure drawn again: the value it left answers at once, and
    // one pass reads it beside the other.
    inner.stubInfo = { ...inner.stubInfo, branch: "later" };
    const back = await svc.getGitInfo(new Holds(), "/repo", { showSha: true });
    expect(back).toMatchObject({ kind: "ok", value: { branch: "main" } });
    await jest.advanceTimersByTimeAsync(0);
    expect(sets(inner)).toEqual([
      JSON.stringify({ showStashCount: true }),
      JSON.stringify({ showSha: true }),
      JSON.stringify({ showStashCount: true }),
    ]);
    svc.close();
  });

  test("a PR nobody shows runs no period, and its new key is looked up only once shown", async () => {
    jest.useFakeTimers();
    const { svc, inner, holds, logs } = makeCache();
    inner.repoRootByDir = { "/repo": "/repo" };
    await svc.getGitInfo(holds, "/repo", { showPullRequest: true });
    expect(inner.prCalls).toHaveLength(1);

    // Only the values are read now; the PR's hold goes with the sweep.
    const values = new Holds();
    await svc.getGitInfo(values, "/repo", {});
    holds.releaseUnread();
    holds.releaseUnread();
    await jest.advanceTimersByTimeAsync(PR_PERIOD.okMs * 3);
    expect(inner.prCalls).toHaveLength(1);

    // A branch switch moves the key, and nobody shows it: nothing is asked.
    inner.stubInfo = { ...inner.stubInfo, branch: "feature" };
    svc.changed("/repo");
    await jest.advanceTimersByTimeAsync(0);
    expect(inner.prCalls).toHaveLength(1);
    expect(logs.at(-1)).toMatch(/^git refresh \/repo by=watch .* pr=owed /);

    // Shown again: the new key is looked up, never answered by the old one.
    const shown = svc.getGitInfo(new Holds(), "/repo", {
      showPullRequest: true,
    });
    await jest.advanceTimersByTimeAsync(0);
    expect(inner.prCalls).toHaveLength(2);
    await expect(shown).resolves.toMatchObject({
      kind: "ok",
      value: { branch: "feature" },
    });
    svc.close();
  });

  test("the PR is keyed by the branch the pass read, never by a value it skipped", async () => {
    jest.useFakeTimers();
    const { svc, inner, holds, logs } = makeCache();
    inner.repoRootByDir = { "/repo": "/repo" };
    // The first option set, then a preset showing the PR over another.
    await svc.getGitInfo(holds, "/repo", { showSha: true });
    const shown = new Holds();
    await svc.getGitInfo(shown, "/repo", { showPullRequest: true });
    expect(inner.prCalls).toHaveLength(1);
    holds.releaseUnread();
    holds.releaseUnread();

    // The skipped set still stores `main`; the pass reads `feature`.
    inner.stubInfo = { ...inner.stubInfo, branch: "feature" };
    svc.changed("/repo");
    await jest.advanceTimersByTimeAsync(0);
    expect(logs.at(-1)).toMatch(/^git refresh \/repo by=watch values=1 .* pr=looked-up /);
    expect(inner.prCalls).toHaveLength(2);
    svc.close();
  });

  test("an owed PR shown on a repo that changed unused is looked up once, on the key the pass reads", async () => {
    jest.useFakeTimers();
    const { svc, inner, holds, logs } = makeCache();
    inner.repoRootByDir = { "/repo": "/repo" };
    await svc.getGitInfo(holds, "/repo", { showPullRequest: true });
    const values = new Holds();
    await svc.getGitInfo(values, "/repo", {});
    holds.releaseUnread();
    holds.releaseUnread();
    inner.stubInfo = { ...inner.stubInfo, branch: "feature" };
    svc.changed("/repo");
    await jest.advanceTimersByTimeAsync(0);
    expect(logs.at(-1)).toMatch(/ pr=owed /);

    // Nothing uses the repo, and the branch moves again unseen.
    values.releaseUnread();
    values.releaseUnread();
    expect(svc.getStats().held).toBe(0);
    inner.stubInfo = { ...inner.stubInfo, branch: "third" };
    svc.changed("/repo");

    // Shown again: one lookup, for `third` — none for the owed `feature`.
    void svc.getGitInfo(new Holds(), "/repo", { showPullRequest: true });
    await jest.advanceTimersByTimeAsync(0);
    expect(logs.at(-1)).toMatch(/ pr=looked-up /);
    expect(inner.prCalls).toHaveLength(2);
    svc.close();
  });

  test("a PR nobody shows reads no remote; shown again on the same branch, it is answered from its last lookup", async () => {
    jest.useFakeTimers();
    const { svc, inner, holds, logs } = makeCache();
    inner.repoRootByDir = { "/repo": "/repo" };
    await svc.getGitInfo(holds, "/repo", { showPullRequest: true });
    const values = new Holds();
    await svc.getGitInfo(values, "/repo", {});
    holds.releaseUnread();
    holds.releaseUnread();
    const remotes = inner.remoteCalls;
    await jest.advanceTimersByTimeAsync(GIT_PERIOD_MS * 2);
    expect(inner.remoteCalls).toBe(remotes);

    const shown = svc.getGitInfo(new Holds(), "/repo", {
      showPullRequest: true,
    });
    await jest.advanceTimersByTimeAsync(0);
    await expect(shown).resolves.toMatchObject({
      kind: "ok",
      value: { pullRequest: { kind: "ok" } },
    });
    expect(logs.at(-1)).toMatch(/ pr=recalled /);
    expect(inner.prCalls).toHaveLength(1);
    svc.close();
  });

  test("a PR shown again after a change while unused waits for the pass, never ticking the key the repo left", async () => {
    jest.useFakeTimers();
    const { svc, inner, holds, logs } = makeCache();
    inner.repoRootByDir = { "/repo": "/repo" };
    await svc.getGitInfo(holds, "/repo", { showPullRequest: true });
    holds.releaseUnread();
    holds.releaseUnread();
    expect(svc.getStats().held).toBe(0);
    inner.stubInfo = { ...inner.stubInfo, branch: "feature" };
    svc.changed("/repo");
    // Past the PR's period: a resumed period would tick at once — before the
    // pass, held here as a real git read is, can move the key.
    await jest.advanceTimersByTimeAsync(PR_PERIOD.okMs * 2);
    inner.infoGate = deferred();

    void svc.getGitInfo(new Holds(), "/repo", { showPullRequest: true });
    await jest.advanceTimersByTimeAsync(0);
    expect(inner.prCalls).toHaveLength(1);
    inner.infoGate.resolve();
    inner.infoGate = null;
    await jest.advanceTimersByTimeAsync(0);
    expect(logs.at(-1)).toMatch(/ pr=looked-up /);
    expect(inner.prCalls).toHaveLength(2);
    svc.close();
  });

  test("a reader waiting on an owed PR is answered when the pass reads no branch", async () => {
    jest.useFakeTimers();
    const { svc, inner, holds, logs } = makeCache();
    inner.repoRootByDir = { "/repo": "/repo" };
    await svc.getGitInfo(holds, "/repo", { showPullRequest: true });
    const values = new Holds();
    await svc.getGitInfo(values, "/repo", {});
    holds.releaseUnread();
    holds.releaseUnread();
    inner.stubInfo = { ...inner.stubInfo, branch: "feature" };
    svc.changed("/repo");
    await jest.advanceTimersByTimeAsync(0);

    inner.infoFailure = "git status timed out";
    const shown = svc.getGitInfo(new Holds(), "/repo", {
      showPullRequest: true,
    });
    let answer: Outcome<GitInfo> | "waiting" = "waiting";
    void shown.then((a) => (answer = a));
    await jest.advanceTimersByTimeAsync(0);
    expect(logs.at(-1)).toMatch(/ pr=unkeyed /);
    expect(answer).toMatchObject({ kind: "failed" });
    svc.close();
  });
});

// brandon-unfiled-3248.8ro6, step 1: a read never refreshes. A repo's value is
// re-read by its watch (a change queues one re-read) and by one period over the
// repos something holds (a tick shares the read in flight).
describe("GitDataProvider refreshes on its own triggers", () => {
  test("a watch fire re-reads with no read asking; the next read takes that value", async () => {
    const { svc, inner, holds } = makeCache();
    inner.repoRootByDir = { "/repo": "/repo" };
    await svc.getGitInfo(holds, "/repo", {});

    inner.stubInfo = { ...inner.stubInfo, branch: "feature" };
    svc.changed("/repo");
    await tick();
    expect(inner.computeCalls).toHaveLength(2);

    const out = await svc.getGitInfo(holds, "/repo", {});
    expect(out).toMatchObject({ kind: "ok", value: { branch: "feature" } });
    expect(inner.computeCalls).toHaveLength(2);
    expect(svc.getStats()).toMatchObject({ changes: 1, refreshes: 2 });
  });

  test("a change mid-read queues one re-read after it, so the last change lands (brandon-unfiled-3248.xjma)", async () => {
    const { svc, inner, holds } = makeCache();
    inner.repoRootByDir = { "/repo": "/repo" };
    const delivered: Array<string | undefined> = [];
    inner.infoGate = deferred();

    const sub = svc.subscribe(new Holds(), "/repo", (info) => delivered.push(info?.branch));
    const read = svc.getGitInfo(holds, "/repo", {});
    await tick();
    expect(inner.computeCalls).toHaveLength(1); // the first read is out

    // The repo changes after that read began: its answer is already stale.
    inner.stubInfo = { ...inner.stubInfo, branch: "feature" };
    svc.changed("/repo");
    const gate = inner.infoGate;
    inner.infoGate = null;
    gate.resolve();

    await sub.firstDelivery;
    await read;
    await tick();

    // Both the stored value and the subscriber end on a value read after the
    // change, never on the one read before it.
    expect(delivered).toEqual(["main", "feature"]);
    const now = await svc.getGitInfo(holds, "/repo", {});
    expect(now).toMatchObject({ kind: "ok", value: { branch: "feature" } });
    sub.unsubscribe();
  });

  test("a read during a refresh takes the stored value at once; the value stands until the re-read lands", async () => {
    const { svc, inner, holds } = makeCache();
    inner.repoRootByDir = { "/repo": "/repo" };
    await svc.getGitInfo(holds, "/repo", {});

    inner.infoGate = deferred();
    inner.stubInfo = { ...inner.stubInfo, branch: "feature" };
    svc.changed("/repo");
    await tick();
    expect(inner.computeCalls).toHaveLength(2); // the re-read is out

    const during = await svc.getGitInfo(holds, "/repo", {});
    expect(during).toMatchObject({ kind: "ok", value: { branch: "main" } });

    inner.infoGate.resolve();
    await tick();
    const after = await svc.getGitInfo(holds, "/repo", {});
    expect(after).toMatchObject({ kind: "ok", value: { branch: "feature" } });
  });

  test("a repo evicted while its re-read is out, then read again, gets a first read of its own", async () => {
    const { svc, inner } = makeCache({ maxRepos: 1 });
    inner.repoRootByDir = { "/a": "/a", "/b": "/b" };
    const first = new Holds();
    await svc.getGitInfo(first, "/a", {});

    inner.infoGate = deferred();
    svc.changed("/a");
    await tick();
    first.releaseUnread();
    first.releaseUnread(); // unused while its re-read is out
    const gate = inner.infoGate;
    inner.infoGate = null;
    await svc.getGitInfo(new Holds(), "/b", {}); // evicts /a mid-read

    const again = svc.getGitInfo(new Holds(), "/a", {});
    gate.resolve();
    await expect(again).resolves.toMatchObject({ kind: "ok" });
  });

  test("rapid changes coalesce into at most two refreshes", async () => {
    const { svc, inner } = makeCache();
    inner.repoRootByDir = { "/repo": "/repo" };

    const calls: Array<GitInfo | null> = [];
    const sub = svc.subscribe(new Holds(), "/repo", (info) => calls.push(info));
    await sub.firstDelivery;
    expect(calls).toHaveLength(1); // initial
    const initialComputeCalls = inner.computeCalls.length;

    // The first starts a refresh; the rest collapse into one trailing re-read.
    for (let i = 0; i < 10; i++) svc.changed("/repo");
    await tick(10);

    expect(calls.length - 1).toBeLessThanOrEqual(2);
    expect(inner.computeCalls.length - initialComputeCalls).toBeLessThanOrEqual(
      2,
    );
    sub.unsubscribe();
  });

  test("a held repo is re-read every period; released, it costs no read", async () => {
    jest.useFakeTimers();
    const { svc, inner, holds } = makeCache();
    inner.repoRootByDir = { "/repo": "/repo" };
    await svc.getGitInfo(holds, "/repo", {});
    expect(inner.computeCalls).toHaveLength(1);

    await jest.advanceTimersByTimeAsync(GIT_PERIOD_MS - 1);
    expect(inner.computeCalls).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(inner.computeCalls).toHaveLength(2);
    await jest.advanceTimersByTimeAsync(GIT_PERIOD_MS);
    expect(inner.computeCalls).toHaveLength(3);

    holds.releaseUnread();
    holds.releaseUnread();
    await jest.advanceTimersByTimeAsync(GIT_PERIOD_MS * 5);
    expect(inner.computeCalls).toHaveLength(3);
    svc.close();
  });

  test("a period that resumes reads at the time it has left, or at once when its last read is older", async () => {
    jest.useFakeTimers();
    const { svc, inner } = makeCache();
    inner.repoRootByDir = { "/repo": "/repo" };
    const first = new Holds();
    await svc.getGitInfo(first, "/repo", {});
    await jest.advanceTimersByTimeAsync(10_000);
    first.releaseUnread();
    first.releaseUnread();
    await jest.advanceTimersByTimeAsync(10_000);

    // Held again 20 s after its last read: the next read is 10 s away.
    const second = new Holds();
    await svc.getGitInfo(second, "/repo", {});
    await jest.advanceTimersByTimeAsync(9_999);
    expect(inner.computeCalls).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(inner.computeCalls).toHaveLength(2);

    // Released past a whole period: held again, it reads at once.
    second.releaseUnread();
    second.releaseUnread();
    await jest.advanceTimersByTimeAsync(GIT_PERIOD_MS * 2);
    await svc.getGitInfo(new Holds(), "/repo", {});
    await jest.advanceTimersByTimeAsync(0);
    expect(inner.computeCalls).toHaveLength(3);
    svc.close();
  });

  test("a change on a repo nobody holds reads nothing until it is held again, then at once", async () => {
    const { svc, inner } = makeCache();
    inner.repoRootByDir = { "/repo": "/repo" };
    const first = new Holds();
    await svc.getGitInfo(first, "/repo", {});
    first.releaseUnread();
    first.releaseUnread();

    inner.stubInfo = { ...inner.stubInfo, branch: "feature" };
    svc.changed("/repo");
    await tick();
    expect(inner.computeCalls).toHaveLength(1);

    const second = new Holds();
    await svc.getGitInfo(second, "/repo", {});
    await tick();
    expect(inner.computeCalls).toHaveLength(2);
    const now = await svc.getGitInfo(second, "/repo", {});
    expect(now).toMatchObject({ kind: "ok", value: { branch: "feature" } });
  });

  test("a failed refresh is logged once, by the refresh; reads of it log nothing", async () => {
    const { svc, inner, logs, holds } = makeCache();
    inner.repoRootByDir = { "/repo": "/repo" };
    inner.infoFailure = "git status timed out";

    for (let i = 0; i < 3; i++) {
      expect((await svc.getGitInfo(holds, "/repo", {})).kind).toBe("failed");
    }
    expect(logs.filter((l) => l.startsWith("git refresh failed"))).toEqual([
      "git refresh failed (/repo): git status timed out",
    ]);

    inner.infoFailure = null;
    svc.changed("/repo");
    await tick();
    expect((await svc.getGitInfo(holds, "/repo", {})).kind).toBe("ok");
  });

  test("a field git could not read is logged once per refresh, never per read", async () => {
    const { svc, inner, logs, holds } = makeCache();
    inner.repoRootByDir = { "/repo": "/repo" };
    inner.stubInfo = {
      ...inner.stubInfo,
      stashCount: failed("git stash list: timeout"),
    };

    for (let i = 0; i < 3; i++) await svc.getGitInfo(holds, "/repo", {});
    expect(logs.filter((l) => l.startsWith("git refresh failed"))).toEqual([
      "git refresh failed (/repo): git.stash: git stash list: timeout",
    ]);
  });

  test("a HEAD git could not read is logged, though the payload only reads it for the PR", async () => {
    const { svc, inner, logs, holds } = makeCache();
    inner.repoRootByDir = { "/repo": "/repo" };
    inner.stubInfo = { ...inner.stubInfo, head: failed("git rev-parse: timeout") };

    await svc.getGitInfo(holds, "/repo", {});
    expect(logs.filter((l) => l.startsWith("git refresh failed"))).toEqual([
      "git refresh failed (/repo): git.head: git rev-parse: timeout",
    ]);
  });
});

// [LAW:no-ambient-temporal-coupling] The first delivery is awaited through the
// subscription's own `firstDelivery`, never through a count of setImmediates;
// `tick()` survives only where the wait is for a delivery the provider does
// NOT promise — a refresh a watch fire started.
describe("GitDataProvider.subscribe", () => {
  test("delivers initial snapshot once", async () => {
    const { svc, inner } = makeCache();
    inner.repoRootByDir = { "/repo": "/repo" };

    const calls: Array<GitInfo | null> = [];
    const sub = svc.subscribe(new Holds(), "/repo", (info) => calls.push(info));
    await sub.firstDelivery;
    await tick();

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ branch: "main", status: "clean" });
    sub.unsubscribe();
  });

  test("delivers null once for non-repo cwd; no watcher held", async () => {
    const { svc, inner } = makeCache();
    inner.repoRootByDir = { "/nowhere": null };

    const calls: Array<GitInfo | null> = [];
    const sub = svc.subscribe(new Holds(), "/nowhere", (info) => calls.push(info));
    await sub.firstDelivery;

    expect(calls).toEqual([null]);
    expect(svc.getStats().watchers).toBe(0);
    sub.unsubscribe();
  });

  test("a change refreshes subscribers", async () => {
    const { svc, inner } = makeCache();
    inner.repoRootByDir = { "/repo": "/repo" };

    const calls: Array<GitInfo | null> = [];
    const sub = svc.subscribe(new Holds(), "/repo", (info) => calls.push(info));
    await sub.firstDelivery;
    expect(calls).toHaveLength(1);

    inner.stubInfo = { ...inner.stubInfo, branch: "feature" };
    svc.changed("/repo");
    await tick();

    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({ branch: "feature" });
    sub.unsubscribe();
  });

  test("a drawn subscription keeps its repo newest in the LRU", async () => {
    const { svc, inner } = makeCache({ maxRepos: 2 });
    inner.repoRootByDir = {
      "/repo": "/repo",
      "/a": "/a",
      "/b": "/b",
      "/c": "/c",
    };
    const home = new Holds();
    const sub = svc.subscribe(home, "/repo", () => {});
    await sub.firstDelivery;
    for (const dir of ["/a", "/b"]) {
      const h = new Holds();
      await svc.getGitInfo(h, dir, {});
      h.releaseUnread();
      h.releaseUnread();
    }
    sub.read();
    // Its home disposed, as a registry's dispose does: unused now.
    sub.unsubscribe();
    home.close();
    await svc.getGitInfo(new Holds(), "/c", {});

    // The drawn repo outlived the two read before its last draw: its
    // subscribed option set answers from what is stored.
    const { misses } = svc.getStats();
    await svc.getGitInfo(new Holds(), "/repo", {
      showSha: true,
      showStashCount: true,
    });
    expect(svc.getStats().misses).toBe(misses);
    svc.close();
  });

  test("a subscriber hears every change; it holds the period while its home is drawn", async () => {
    jest.useFakeTimers();
    const { svc, inner } = makeCache({ maxRepos: 1 });
    inner.repoRootByDir = { "/repo": "/repo", "/other": "/other" };

    const home = new Holds();
    const sub = svc.subscribe(home, "/repo", () => {});
    await sub.firstDelivery;
    expect(svc.getStats().held).toBe(1);
    await jest.advanceTimersByTimeAsync(GIT_PERIOD_MS);
    expect(inner.computeCalls).toHaveLength(2);

    // Not drawn across a whole sweep: released, so the period stops.
    home.releaseUnread();
    home.releaseUnread();
    expect(svc.getStats().held).toBe(0);
    await jest.advanceTimersByTimeAsync(GIT_PERIOD_MS * 3);
    expect(inner.computeCalls).toHaveLength(2);

    // Still in use, so never evicted, and a change reaches it.
    await svc.getGitInfo(new Holds(), "/other", {});
    expect(svc.getStats().size).toBe(2);
    svc.changed("/repo");
    await jest.advanceTimersByTimeAsync(0);
    expect(inner.computeCalls.map((c) => c.workingDir)).toEqual([
      "/repo",
      "/repo",
      "/other",
      "/repo",
    ]);

    // Drawn again: held, and on the period.
    sub.read();
    expect(svc.getStats().held).toBe(2);
    await jest.advanceTimersByTimeAsync(GIT_PERIOD_MS);
    expect(
      inner.computeCalls.filter((c) => c.workingDir === "/repo"),
    ).toHaveLength(4);
    sub.unsubscribe();
    svc.close();
  });

  test("multiple subscribers in same repo share one watcher slot", async () => {
    const { svc, inner } = makeCache();
    inner.repoRootByDir = { "/repo/a": "/repo", "/repo/b": "/repo" };

    const subA = svc.subscribe(new Holds(), "/repo/a", () => {});
    const subB = svc.subscribe(new Holds(), "/repo/b", () => {});
    await Promise.all([subA.firstDelivery, subB.firstDelivery]);

    expect(svc.getStats().watchers).toBe(1);
    subA.unsubscribe();
    subB.unsubscribe();
  });

  test("unsubscribe before delivery suppresses the callback", async () => {
    const { svc, inner } = makeCache();
    inner.repoRootByDir = { "/repo": "/repo" };

    const calls: Array<GitInfo | null> = [];
    const sub = svc.subscribe(new Holds(), "/repo", (info) => calls.push(info));
    sub.unsubscribe();
    // A suppressed delivery still SETTLES — nothing is left outstanding once the
    // subscriber is gone, which is what lets `settled()` clear its name.
    await sub.firstDelivery;

    expect(calls).toHaveLength(0);
  });

  test("subscriber throwing in initial delivery does not crash", async () => {
    const { svc, inner } = makeCache();
    inner.repoRootByDir = { "/repo": "/repo" };

    const goodCalls: Array<GitInfo | null> = [];
    const bad = svc.subscribe(new Holds(), "/repo", () => {
      throw new Error("bad subscriber");
    });
    const good = svc.subscribe(new Holds(), "/repo", (info) => goodCalls.push(info));
    await Promise.all([bad.firstDelivery, good.firstDelivery]);

    expect(goodCalls).toHaveLength(1);
    expect(goodCalls[0]).toMatchObject({ branch: "main" });
    bad.unsubscribe();
    good.unsubscribe();
  });

  test("subscriber throwing on null delivery does not crash", async () => {
    const { svc, inner } = makeCache();
    inner.repoRootByDir = { "/nowhere": null };

    const bad = svc.subscribe(new Holds(), "/nowhere", () => {
      throw new Error("bad subscriber");
    });
    const seen: Array<GitInfo | null> = [];
    const good = svc.subscribe(new Holds(), "/nowhere", (info) => seen.push(info));
    await Promise.all([bad.firstDelivery, good.firstDelivery]);

    expect(seen).toEqual([null]);
    bad.unsubscribe();
    good.unsubscribe();
  });

  test("unsubscribe during a refresh prevents stale delivery", async () => {
    const { svc, inner } = makeCache();
    inner.repoRootByDir = { "/repo": "/repo" };

    const calls: Array<GitInfo | null> = [];
    const sub = svc.subscribe(new Holds(), "/repo", (info) => calls.push(info));
    await sub.firstDelivery;
    expect(calls).toHaveLength(1); // initial

    inner.stubInfo = { ...inner.stubInfo, branch: "feature" };
    svc.changed("/repo");
    sub.unsubscribe();
    await tick();

    expect(calls).toHaveLength(1); // no post-unsubscribe delivery
  });

  test("a refresh does not re-resolve the repo", async () => {
    const { svc, inner } = makeCache();
    inner.repoRootByDir = { "/repo": "/repo" };

    const sub = svc.subscribe(new Holds(), "/repo", () => {});
    await sub.firstDelivery;
    expect(inner.resolveCalls.length).toBe(1);

    svc.changed("/repo");
    svc.changed("/repo");
    await tick(10);

    expect(inner.resolveCalls.length).toBe(1);
    sub.unsubscribe();
  });
});

// ─── Resolution cache ────────────────────────────────────────────────────────

// [LAW:behavior-not-structure] brandon-git-cache-y2t: outside a repo, every
// render re-asked "which repo is this?". These pin the BEHAVIOUR — how many
// times the inner resolver is asked — not the cache's shape.
describe("GitDataProvider gitDir resolution cache", () => {
  test("N renders in a non-repo cwd ask the resolver once, not N times", async () => {
    const { svc, inner, holds } = makeCache();
    inner.repoRootByDir = { "/nowhere": null };

    for (let i = 0; i < 10; i++) {
      expect((await svc.getGitInfo(holds, "/nowhere", {})).kind).toBe("absent");
    }

    expect(inner.resolveCalls).toHaveLength(1);
  });

  test("an absent answer expires, so a directory that becomes a repo is seen", async () => {
    // The invalidation story for a negative answer is the TTL: `git init` in a
    // directory the bar has already rendered becomes visible within one window.
    jest.useFakeTimers();
    const { svc, inner, holds } = makeCache();
    inner.repoRootByDir = { "/nowhere": null };
    expect((await svc.getGitInfo(holds, "/nowhere", {})).kind).toBe("absent");

    inner.repoRootByDir = { "/nowhere": "/nowhere" };
    jest.advanceTimersByTime(30_000);
    const after = await svc.getGitInfo(holds, "/nowhere", {});
    expect(after.kind).toBe("ok");
    expect(inner.resolveCalls.length).toBe(2);
    svc.close();
  });

  test("a failed resolution is cached too — the timeout case is the costly one", async () => {
    const { svc, inner, holds } = makeCache();
    inner.resolveFailure = "git rev-parse --show-toplevel timed out";

    for (let i = 0; i < 5; i++) {
      const out = await svc.getGitInfo(holds, "/wherever", {});
      expect(out.kind).toBe("failed");
    }

    expect(inner.resolveCalls).toHaveLength(1);
  });

  test("concurrent callers share one resolution", async () => {
    // registerDslConfig calls subscribe() once per declared `kind: "git"`
    // variable inside ONE synchronous loop, so the concurrent case is the real
    // one: six variables in a non-repo cwd must not be six rev-parse spawns.
    const { svc, inner, holds } = makeCache();
    inner.repoRootByDir = { "/nowhere": null };
    inner.resolveGate = deferred();

    const pending = Array.from({ length: 6 }, () =>
      svc.getGitInfo(holds, "/nowhere", {}),
    );
    inner.resolveGate.resolve();
    for (const out of await Promise.all(pending)) {
      expect(out.kind).toBe("absent");
    }

    expect(inner.resolveCalls).toHaveLength(1);
  });

  test("the read and subscribe surfaces share one resolution", async () => {
    const { svc, inner, holds } = makeCache();
    inner.repoRootByDir = { "/repo": "/repo" };

    await svc.getGitInfo(holds, "/repo", {});
    const sub = svc.subscribe(new Holds(), "/repo", () => {});
    await sub.firstDelivery;

    expect(inner.resolveCalls).toHaveLength(1);
    sub.unsubscribe();
  });

  test("projectDir is part of the key, so it cannot be answered by the wrong entry", async () => {
    const { svc, inner, holds } = makeCache();
    inner.repoRootByDir = { "/cwd": "/cwd", "/project": "/project" };
    inner.effectiveDirByKey = { "/cwd|/project": "/project" };

    expect(await svc.getGitInfo(holds, "/cwd", {})).toMatchObject({
      kind: "ok",
    });
    await svc.getGitInfo(holds, "/cwd", {}, "/project");

    expect(inner.resolveCalls).toEqual([
      { workingDir: "/cwd", projectDir: undefined },
      { workingDir: "/cwd", projectDir: "/project" },
    ]);
    expect(inner.computeCalls.map((c) => c.workingDir)).toEqual([
      "/cwd",
      "/project",
    ]);
  });

  test("a rejecting resolver is not pinned for a window; each read answers failed", async () => {
    const { svc, inner, logs, holds } = makeCache();
    inner.resolveThrows = true;

    for (let i = 0; i < 2; i++) {
      expect(await svc.getGitInfo(holds, "/boom", {})).toEqual(
        failed("git: Error: resolver bug"),
      );
    }

    expect(inner.resolveCalls).toHaveLength(2);
    expect(logs).toEqual([
      "git read threw: Error: resolver bug",
      "git read threw: Error: resolver bug",
    ]);
  });

  test("close() drops the answers instead of carrying them past shutdown", async () => {
    const { svc, inner, holds } = makeCache();
    inner.repoRootByDir = { "/nowhere": null };
    await svc.getGitInfo(holds, "/nowhere", {});
    expect(inner.resolveCalls).toHaveLength(1);

    svc.close();
    await svc.getGitInfo(holds, "/nowhere", {});
    expect(inner.resolveCalls).toHaveLength(2);
  });
});

// The PR is its own source: a key of the branch and the remote, a period chosen
// by the last lookup's outcome, composed onto a read rather than fetched in one.
describe("GitDataProvider PR source", () => {
  const OPEN_PR = ok({
    number: 7,
    state: "open" as const,
    url: "https://example.test/pull/7",
    head: "c0ffee",
  });

  test("showPullRequest off → resolvePullRequest never called, no PR attached", async () => {
    const { svc, inner, holds } = makeCache();
    inner.repoRootByDir = { "/repo": "/repo" };

    const out = await svc.getGitInfo(holds, "/repo", {});
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") return;
    expect(out.value.pullRequest).toBeUndefined();
    expect(inner.prCalls).toHaveLength(0);
  });

  test("showPullRequest on → PR attached to GitInfo", async () => {
    const { svc, inner, holds } = makeCache();
    inner.repoRootByDir = { "/repo": "/repo" };

    const out = await svc.getGitInfo(holds, "/repo", { showPullRequest: true });
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") return;
    expect(out.value.pullRequest).toEqual(OPEN_PR);
    expect(inner.prCalls).toHaveLength(1);
  });

  test("git refreshes on one key look the PR up no further", async () => {
    const { svc, inner, holds } = makeCache();
    inner.repoRootByDir = { "/repo": "/repo" };

    await svc.getGitInfo(holds, "/repo", { showPullRequest: true });
    for (let i = 0; i < 3; i++) {
      svc.changed("/repo");
      await tick();
    }
    await svc.getGitInfo(holds, "/repo", { showPullRequest: true });

    expect(inner.computeCalls.length).toBeGreaterThanOrEqual(4);
    expect(inner.prCalls).toHaveLength(1);
  });

  test("a branch switch is a new key, looked up afresh", async () => {
    const { svc, inner, holds } = makeCache();
    inner.repoRootByDir = { "/repo": "/repo" };

    inner.stubInfo = { ...inner.stubInfo, branch: "feature-a" };
    await svc.getGitInfo(holds, "/repo", { showPullRequest: true });
    inner.stubInfo = { ...inner.stubInfo, branch: "feature-b" };
    svc.changed("/repo");
    await tick();
    await svc.getGitInfo(holds, "/repo", { showPullRequest: true });

    expect(inner.prCalls).toHaveLength(2);
  });

  test("a failed forge lookup is attached as failed (surfaced, not dropped) and logged once", async () => {
    const { svc, inner, logs, holds } = makeCache();
    inner.repoRootByDir = { "/repo": "/repo" };
    inner.stubPr = { kind: "failed", reason: "gh pr view: non-zero, HTTP 401" };

    for (let i = 0; i < 3; i++) {
      const out = await svc.getGitInfo(holds, "/repo", {
        showPullRequest: true,
      });
      expect(out.kind).toBe("ok");
      if (out.kind !== "ok") return;
      expect(out.value.pullRequest).toEqual({
        kind: "failed",
        reason: "gh pr view: non-zero, HTTP 401",
      });
    }
    expect(logs.filter((l) => l.includes("git.pr"))).toEqual([
      "git refresh failed (/repo): git.pr: gh pr view: non-zero, HTTP 401",
    ]);
  });

  test("a re-pointed origin is a new key, looked up afresh", async () => {
    const { svc, inner, holds } = makeCache();
    inner.repoRootByDir = { "/repo": "/repo" };

    inner.stubRemote = ok("git@github.com:acme/widget.git");
    await svc.getGitInfo(holds, "/repo", { showPullRequest: true });
    inner.stubRemote = ok("git@gitlab.com:acme/widget.git");
    svc.changed("/repo");
    await tick();
    await svc.getGitInfo(holds, "/repo", { showPullRequest: true });

    expect(inner.prCalls.map((c) => c.remoteUrl)).toEqual([
      "git@github.com:acme/widget.git",
      "git@gitlab.com:acme/widget.git",
    ]);
  });

  test("failed remote read → PR failed (surfaced); no forge call", async () => {
    const { svc, inner, holds } = makeCache();
    inner.repoRootByDir = { "/repo": "/repo" };
    inner.stubRemote = { kind: "failed", reason: "git config: timeout" };

    const out = await svc.getGitInfo(holds, "/repo", { showPullRequest: true });
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") return;
    expect(out.value.pullRequest).toEqual({
      kind: "failed",
      reason: "git config: timeout",
    });
    expect(inner.prCalls).toHaveLength(0);
  });

  test("no remote (absent) → PR absent; no forge call", async () => {
    const { svc, inner, holds } = makeCache();
    inner.repoRootByDir = { "/repo": "/repo" };
    inner.stubRemote = ABSENT;

    const out = await svc.getGitInfo(holds, "/repo", { showPullRequest: true });
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") return;
    expect(out.value.pullRequest).toEqual(ABSENT);
    expect(inner.prCalls).toHaveLength(0);
  });

  test("a failed lookup is retried after 45 s, a found one after 5 min", async () => {
    jest.useFakeTimers();
    const { svc, inner, holds } = makeCache();
    inner.repoRootByDir = { "/repo": "/repo" };
    inner.stubPr = { kind: "failed", reason: "gh: network" };

    await svc.getGitInfo(holds, "/repo", { showPullRequest: true });
    expect(inner.prCalls).toHaveLength(1);
    inner.stubPr = OPEN_PR;
    await jest.advanceTimersByTimeAsync(PR_PERIOD.failedMs - 1);
    expect(inner.prCalls).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(inner.prCalls).toHaveLength(2);

    await jest.advanceTimersByTimeAsync(PR_PERIOD.okMs - 1);
    expect(inner.prCalls).toHaveLength(2);
    await jest.advanceTimersByTimeAsync(1);
    expect(inner.prCalls).toHaveLength(3);
    svc.close();
  });

  test("a PR whose repo nobody holds is not looked up on its period", async () => {
    jest.useFakeTimers();
    const { svc, inner, holds } = makeCache();
    inner.repoRootByDir = { "/repo": "/repo" };

    await svc.getGitInfo(holds, "/repo", { showPullRequest: true });
    holds.releaseUnread();
    holds.releaseUnread();
    await jest.advanceTimersByTimeAsync(PR_PERIOD.okMs * 3);
    expect(inner.prCalls).toHaveLength(1);
    expect(inner.computeCalls).toHaveLength(1);
    svc.close();
  });
});

describe("GitDataProvider owns its failures and its PR's timing", () => {
  const PR_B = ok({
    number: 8,
    state: "open" as const,
    url: "https://example.test/pull/8",
    head: "beef",
  });

  test("a failed resolution is logged once, by the resolution; reads of it log nothing", async () => {
    const { svc, inner, logs, holds } = makeCache();
    inner.resolveFailure = "git rev-parse: timeout";

    for (let i = 0; i < 3; i++) {
      expect(await svc.getGitInfo(holds, "/slow", {})).toEqual(
        failed("git rev-parse: timeout"),
      );
    }
    svc.subscribe(new Holds(), "/slow", () => {});
    await tick();
    expect(logs).toEqual(["git resolve failed (/slow): git rev-parse: timeout"]);
  });

  test("a read that throws is logged by the provider and answers failed", async () => {
    const { svc, inner, logs, holds } = makeCache();
    inner.repoRootByDir = { "/repo": "/repo" };
    holds.close();

    const out = await svc.getGitInfo(holds, "/repo", {});
    expect(out.kind).toBe("failed");
    expect(logs.filter((l) => l.startsWith("git "))).toEqual([
      "git read threw: Error: hold taken after close: git:/repo|{}|-",
    ]);
  });

  test("a branch switch never pairs the new branch with the old branch's PR", async () => {
    const { svc, inner, holds } = makeCache();
    inner.repoRootByDir = { "/repo": "/repo" };
    const onA = { ...inner.stubInfo, branch: "a" };
    inner.stubInfo = onA;
    const first = await svc.getGitInfo(holds, "/repo", {
      showPullRequest: true,
    });
    if (first.kind !== "ok") throw new Error("first read failed");
    const prA = first.value.pullRequest;

    // The switch's re-read is out, its remote read held open: a read now is
    // all branch a, never b's values beside a's PR.
    inner.stubInfo = { ...inner.stubInfo, branch: "b" };
    inner.stubPr = PR_B;
    inner.remoteGate = deferred();
    inner.prGate = deferred();
    svc.changed("/repo");
    await tick();
    expect(
      await svc.getGitInfo(holds, "/repo", { showPullRequest: true }),
    ).toEqual(ok({ ...onA, pullRequest: prA }));

    // Stored, b's values wait for b's PR rather than wear a's.
    inner.remoteGate.resolve();
    await tick();
    let read: Outcome<GitInfo> | null = null;
    void svc
      .getGitInfo(holds, "/repo", { showPullRequest: true })
      .then((out) => (read = out));
    await tick();
    expect(read).toBeNull();
    inner.prGate.resolve();
    await tick();
    expect(read).toEqual(ok({ ...inner.stubInfo, pullRequest: PR_B }));
  });

  test("a hanging PR lookup holds back neither a change's re-read nor the period", async () => {
    jest.useFakeTimers();
    const { svc, inner, holds } = makeCache({ periodMs: 1_000 });
    inner.repoRootByDir = { "/repo": "/repo" };
    await svc.getGitInfo(holds, "/repo", { showPullRequest: true });

    inner.stubInfo = { ...inner.stubInfo, branch: "b" };
    inner.prGate = deferred();
    svc.changed("/repo");
    await jest.advanceTimersByTimeAsync(0);
    expect(inner.prCalls).toHaveLength(2);
    expect(inner.computeCalls).toHaveLength(2);

    svc.changed("/repo");
    await jest.advanceTimersByTimeAsync(0);
    expect(inner.computeCalls).toHaveLength(3);
    await jest.advanceTimersByTimeAsync(1_000);
    expect(inner.computeCalls).toHaveLength(4);
    await jest.advanceTimersByTimeAsync(1_000);
    expect(inner.computeCalls).toHaveLength(5);
    inner.prGate.resolve();
    svc.close();
  });

  test("a refresh that throws is logged, and the repo keeps its period", async () => {
    jest.useFakeTimers();
    const { svc, inner, logs, holds } = makeCache({
      periodMs: 1_000,
      throwOn: "git refresh failed",
    });
    inner.repoRootByDir = { "/repo": "/repo" };
    inner.infoFailure = "git status: boom";

    void svc.getGitInfo(holds, "/repo", {});
    await jest.advanceTimersByTimeAsync(0);
    expect(logs.filter((l) => l.startsWith("git "))).toEqual([
      "git refresh threw (/repo): Error: logger bug",
    ]);
    await jest.advanceTimersByTimeAsync(1_000);
    expect(inner.computeCalls).toHaveLength(2);
    expect(logs).toContain("git refresh failed (/repo): git status: boom");
    svc.close();
  });
});

describe("GitDataProvider PR keys, drops and refresh events", () => {
  const PR_B = ok({
    number: 8,
    state: "open" as const,
    url: "https://example.test/pull/8",
    head: "beef",
  });

  test("a branch switched back to is answered from its own key's last lookup, with no new one", async () => {
    const { svc, inner, logs, holds } = makeCache();
    inner.repoRootByDir = { "/repo": "/repo" };
    const onA = { ...inner.stubInfo, branch: "a" };
    inner.stubInfo = onA;
    const first = await svc.getGitInfo(holds, "/repo", {
      showPullRequest: true,
    });
    if (first.kind !== "ok") throw new Error("first read failed");

    inner.stubInfo = { ...onA, branch: "b" };
    inner.stubPr = PR_B;
    svc.changed("/repo");
    await tick();
    inner.stubInfo = onA;
    svc.changed("/repo");
    await tick();

    expect(
      await svc.getGitInfo(holds, "/repo", { showPullRequest: true }),
    ).toEqual(ok({ ...onA, pullRequest: first.value.pullRequest }));
    expect(inner.prCalls).toHaveLength(2);
    expect(logs.filter((l) => l.startsWith("git refresh /repo"))).toEqual([
      expect.stringMatching(/ by=first,pr values=1 failed=0 pr=looked-up /),
      expect.stringMatching(/ by=watch values=1 failed=0 pr=looked-up /),
      expect.stringMatching(/ by=watch values=1 failed=0 pr=recalled /),
    ]);
  });

  test("the PR's first ask, while a stored value is stale, pairs the values it answers with", async () => {
    const { svc, inner, holds } = makeCache();
    inner.repoRootByDir = { "/repo": "/repo" };
    inner.stubInfo = { ...inner.stubInfo, branch: "a" };
    await svc.getGitInfo(holds, "/repo", {});

    // The repo is on b, and the pass that will say so is out.
    inner.stubInfo = { ...inner.stubInfo, branch: "b" };
    inner.stubPr = PR_B;
    inner.infoGate = deferred();
    svc.changed("/repo");
    const read = svc.getGitInfo(holds, "/repo", { showPullRequest: true });
    await tick();
    inner.infoGate.resolve();
    inner.infoGate = null;

    expect(await read).toEqual(ok({ ...inner.stubInfo, pullRequest: PR_B }));
  });

  test("a first read out when the cache closes is answered, never left waiting", async () => {
    const { svc, inner, holds } = makeCache();
    inner.repoRootByDir = { "/repo": "/repo" };
    inner.infoGate = deferred();

    const read = svc.getGitInfo(holds, "/repo", {});
    await tick();
    svc.close();
    expect(await read).toEqual(failed("git state dropped: /repo"));
    inner.infoGate.resolve();
  });

  test("a pass the period started says so on its refresh event", async () => {
    jest.useFakeTimers();
    const { svc, inner, logs, holds } = makeCache({ periodMs: 1_000 });
    inner.repoRootByDir = { "/repo": "/repo" };
    await svc.getGitInfo(holds, "/repo", {});
    await jest.advanceTimersByTimeAsync(1_000);

    expect(logs.filter((l) => l.startsWith("git refresh /repo"))).toEqual([
      expect.stringMatching(/ by=first values=1 failed=0 pr=- took=\d+ms$/),
      expect.stringMatching(/ by=period values=1 failed=0 pr=- took=\d+ms$/),
    ]);
    svc.close();
  });
});

// brandon-unfiled-3248.576q: on macOS every directory watch opened or closed
// leaks native memory (libuv's FSEvents reschedule), so a repo's watch must
// outlive the values read from it — a refresh or a change replaces the value,
// never the watch.
describe("GitDataProvider holds a repo's watch across its values", () => {
  function counted(opts: { maxRepos?: number } = {}) {
    const inner = new StubGitService();
    const counters = { watchersOpened: 0, watchersClosed: 0 };
    const logs: string[] = [];
    const logger = (_level: string, message: string) => logs.push(message);
    const watchers = new WatcherRegistry({ counters, logger });
    const svc = new GitDataProvider({ ...opts, inner, watchers, logger });
    return { svc, inner, counters, logs, watchers };
  }

  test("refreshes and changes never close or reopen the watch", async () => {
    const { svc, inner, counters, watchers } = counted();
    inner.repoRootByDir["/repo"] = "/repo";
    const holds = new Holds();

    await svc.getGitInfo(holds, "/repo", {});
    for (let i = 0; i < 5; i++) {
      svc.changed("/repo");
      await tick();
    }

    expect(inner.computeCalls).toHaveLength(6);
    expect(counters).toEqual({ watchersOpened: 1, watchersClosed: 0 });
    expect(watchers.size()).toBe(1);
    svc.close();
  });

  // Git writes HEAD and index by renaming a `.lock` file over them. A watch
  // held across refreshes must hear every such replacement, not just the first.
  test("the held watch hears every lock-file rename over index and HEAD", async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "git-cache-576q-"));
    const gitDir = path.join(repo, ".git");
    fs.mkdirSync(gitDir);
    const replace = (name: string, text: string) => {
      const lock = path.join(gitDir, `${name}.lock`);
      fs.writeFileSync(lock, text);
      fs.renameSync(lock, path.join(gitDir, name));
    };
    replace("HEAD", "ref: refs/heads/main\n");
    replace("index", "0");
    const { svc, inner, counters } = counted();
    inner.repoRootByDir[repo] = repo;
    const changedTo = async (n: number) => {
      const deadline = Date.now() + 5_000;
      while (svc.getStats().changes < n && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(svc.getStats().changes).toBe(n);
    };
    try {
      await svc.getGitInfo(new Holds(), repo, {});
      const renames = ["index", "index", "HEAD", "index", "HEAD"];
      for (const [i, name] of renames.entries()) {
        replace(name, String(i + 1));
        await changedTo(i + 1);
      }
      expect(counters).toEqual({ watchersOpened: 1, watchersClosed: 0 });
    } finally {
      svc.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test("the git cache's own LRU eviction is what releases a watch", async () => {
    const { svc, inner, counters } = counted({ maxRepos: 1 });
    inner.repoRootByDir = { "/a": "/a", "/b": "/b" };

    const holdsA = new Holds();
    await svc.getGitInfo(holdsA, "/a", {});
    holdsA.releaseUnread();
    holdsA.releaseUnread();
    await svc.getGitInfo(new Holds(), "/b", {}); // evicts /a, its watch's only holder

    expect(counters).toEqual({ watchersOpened: 2, watchersClosed: 1 });
    svc.close();
    expect(counters.watchersClosed).toBe(2);
  });

  test("a repo that disappears reads absent and keeps its watch while held", async () => {
    const { svc, inner, counters } = counted();
    inner.repoRootByDir["/repo"] = "/repo";
    const holds = new Holds();

    await svc.getGitInfo(holds, "/repo", {});
    inner.repoRootByDir["/repo"] = null; // the worktree was removed
    svc.changed("/repo");
    await tick();
    const gone = await svc.getGitInfo(holds, "/repo", {});

    expect(gone.kind).toBe("absent");
    expect(svc.getStats().size).toBe(1);
    expect(counters).toEqual({ watchersOpened: 1, watchersClosed: 0 });
    svc.close();
  });
});

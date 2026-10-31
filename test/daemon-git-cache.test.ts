import { processLauncher } from "../src/proc/launch";
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
  type GitInfoOptions,
  type PullRequest,
} from "../src/segments/git";
import { ABSENT, failed, ok, type Outcome } from "../src/utils/outcome";
import { Holds } from "../src/utils/holds";
import { answered } from "../src/utils/reading";
import { until } from "./helpers/until";
import { untilHeard } from "./helpers/reload-signal";

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

  override findGitRoot(workingDir: string): Outcome<string> {
    const root = this.repoRootByDir[workingDir] ?? null;
    return root === null ? ABSENT : ok(root);
  }

  override resolveGitDir(workingDir: string): string {
    this.gitDirCalls.push(workingDir);
    if (workingDir in this.gitDirByDir) return this.gitDirByDir[workingDir]!;
    return `${workingDir}/.git`;
  }

  // Resolution knobs the resolution-cache tests drive: a `failed` outcome and
  // a throw (a resolver bug).
  public resolveFailure: string | null = null;
  public resolveThrows = false;

  override resolveEffectiveGitDir(
    workingDir: string,
    projectDir?: string,
  ): Outcome<string> {
    this.resolveCalls.push({ workingDir, projectDir });
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
  const inner = new StubGitService(processLauncher);
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

// The git passes' refresh events, without the PR lookups' between them.
const passes = (logs: readonly string[]): string[] =>
  logs.filter((l) => l.startsWith("git refresh "));

// [LAW:no-silent-failure] The reasons each failed refresh of `source` logged,
// in order: one event per refresh that failed, carrying every reason it met.
const failuresIn = (logs: readonly string[], source = "git"): string[] =>
  logs
    .filter((l) => l.startsWith(`${source} refresh `))
    .flatMap((l) => {
      const reason = / outcome=failed reason=("(?:[^"\\]|\\.)*")/.exec(l);
      return reason === null ? [] : [JSON.parse(reason[1]!) as string];
    });

// A promise whose settling the test controls — the only way to make a read
// genuinely in flight, rather than hoping an await boundary lands where needed.
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// A declaration's answer, waited for while it — or the PR inside it — is not
// answered yet: what a request's wait reads of the lane its view's
// declaration took (`waitsOf`, src/daemon/render-payload.ts).
function gitOf(
  svc: GitDataProvider,
  holds: Holds,
  workingDir: string,
  options: GitInfoOptions = {},
  projectDir?: string,
): Promise<Outcome<GitInfo>> {
  const lane = svc.declare(holds, workingDir, options, projectDir);
  return answered(() => {
    const info = lane.current();
    const pr = info.kind === "ok" ? info.value.pullRequest : undefined;
    return pr?.kind === "pending" ? pr : info;
  });
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

    await gitOf(svc, holds, "/repo/a", { showSha: false });
    await gitOf(svc, holds, "/repo/b", { showSha: false });

    expect(inner.computeCalls).toHaveLength(1);
    expect(svc.getStats()).toMatchObject({ size: 1, hits: 1, misses: 1 });
  });

  test("different repos get different states", async () => {
    const { svc, inner, holds } = makeCache();
    inner.repoRootByDir = { "/r1": "/r1", "/r2": "/r2" };

    await gitOf(svc, holds, "/r1", {});
    await gitOf(svc, holds, "/r2", {});

    expect(svc.getStats().size).toBe(2);
    expect(inner.computeCalls).toHaveLength(2);
  });

  test("different option sets in one repo are separate values of it", async () => {
    const { svc, inner, holds } = makeCache();
    inner.repoRootByDir = { "/repo": "/repo" };

    await gitOf(svc, holds, "/repo", { showSha: true });
    await gitOf(svc, holds, "/repo", { showSha: false });

    expect(svc.getStats().size).toBe(1);
    // A new option set is read by a pass over the whole repo — one serialized
    // loop per repo is what keeps an older read from landing over a newer one —
    // so the set already held is read again beside it.
    expect(inner.computeCalls).toHaveLength(3);
    await gitOf(svc, holds, "/repo", { showSha: true });
    await gitOf(svc, holds, "/repo", { showSha: false });
    expect(inner.computeCalls).toHaveLength(3);
  });

  test("a read of a warm repo never fetches", async () => {
    const { svc, inner, holds } = makeCache();
    inner.repoRootByDir["/repo"] = "/repo";

    for (let i = 0; i < 5; i++) await gitOf(svc, holds, "/repo", {});

    expect(inner.computeCalls).toHaveLength(1);
    expect(svc.getStats()).toMatchObject({ hits: 4, misses: 1 });
  });

  test("the LRU evicts the oldest repo nobody holds", async () => {
    const { svc, inner } = makeCache({ maxRepos: 3 });
    for (let i = 0; i < 5; i++) {
      inner.repoRootByDir[`/r${i}`] = `/r${i}`;
      const holds = new Holds();
      await gitOf(svc, holds, `/r${i}`, {});
      holds.declare(() => {});
    }
    expect(svc.getStats().size).toBe(3);
  });

  test("a held repo is never evicted: it keeps its value past the cap", async () => {
    const { svc, inner } = makeCache({ maxRepos: 1 });
    inner.repoRootByDir = { "/a": "/a", "/b": "/b", "/c": "/c" };
    const holdsA = new Holds();
    const holdsB = new Holds();

    await gitOf(svc, holdsA, "/a", {});
    await gitOf(svc, holdsB, "/b", {});
    expect(svc.getStats()).toMatchObject({ size: 2, held: 2 });
    holdsB.declare(() => {});
    await gitOf(svc, new Holds(), "/c", {}); // evicts /b, never /a

    inner.computeCalls = [];
    await gitOf(svc, holdsA, "/a", {});
    await gitOf(svc, new Holds(), "/b", {});
    expect(inner.computeCalls.map((c) => c.workingDir)).toEqual(["/b"]);
  });

  test("non-repo path returns absent and creates no state", async () => {
    const { svc, inner, holds } = makeCache();
    inner.repoRootByDir = { "/nowhere": null };

    const r1 = await gitOf(svc, holds, "/nowhere", {});
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

    await gitOf(svc, holds, "/cwd", {}, "/repoB");
    await gitOf(svc, holds, "/cwd", {});

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

    const r = await gitOf(svc, holds, "/wt", {});
    expect(r).toMatchObject({ kind: "ok", value: { branch: "main" } });
    expect(inner.gitDirCalls).toContain("/wt");
  });

  test("concurrent first reads of one value share one fetch", async () => {
    const { svc, inner, holds } = makeCache();
    inner.repoRootByDir = { "/repo": "/repo" };

    const [r1, r2] = await Promise.all([
      gitOf(svc, holds, "/repo", {}),
      gitOf(svc, holds, "/repo", {}),
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

    await gitOf(svc, holds, "/cwd-x", {}, "/repoA");
    await gitOf(svc, holds, "/cwd-y", {}, "/repoA");

    expect(svc.getStats()).toMatchObject({ size: 1, hits: 1, misses: 1 });
  });

  test("a home holds a repo once per option set it reads, however often it reads it", async () => {
    const { svc, inner, holds } = makeCache();
    inner.repoRootByDir = { "/repo/a": "/repo", "/repo/b": "/repo" };

    await gitOf(svc, holds, "/repo/a", {});
    await gitOf(svc, holds, "/repo/b", {});
    expect(holds.size).toBe(1);
    await gitOf(svc, holds, "/repo/b", { showSha: true });
    expect(holds.size).toBe(2);
    expect(svc.getStats().held).toBe(1);
    holds.declare(() => {});
    expect(svc.getStats().held).toBe(0);
  });
});

// cmt-2bc3832b: a pass reads the option sets something reads, and the forge is
// asked only about a PR something shows — so a closure a preset switch left
// stops costing its reads once the home's next declaration releases it.
describe("GitDataProvider reads what is held", () => {
  const sets = (inner: StubGitService) =>
    inner.computeCalls.map((c) => JSON.stringify(c.options));

  test("an option set nobody reads is left out of the pass; read again, it is stored and read at once", async () => {
    jest.useFakeTimers();
    const { svc, inner, holds } = makeCache();
    inner.repoRootByDir = { "/repo": "/repo" };
    await gitOf(svc, holds, "/repo", { showSha: true });

    // The home moves to another closure, and a declaration releases the first.
    const moved = new Holds();
    await gitOf(svc, moved, "/repo", { showStashCount: true });
    holds.declare(() => {});
    inner.computeCalls = [];
    await jest.advanceTimersByTimeAsync(GIT_PERIOD_MS);
    expect(sets(inner)).toEqual([JSON.stringify({ showStashCount: true })]);

    // The first closure drawn again: the value it left answers at once, and
    // one pass reads it beside the other.
    inner.stubInfo = { ...inner.stubInfo, branch: "later" };
    const back = await gitOf(svc, new Holds(), "/repo", { showSha: true });
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
    await gitOf(svc, holds, "/repo", { showPullRequest: true });
    expect(inner.prCalls).toHaveLength(1);

    // Only the values are read now; the PR's hold goes with a declaration.
    const values = new Holds();
    await gitOf(svc, values, "/repo", {});
    holds.declare(() => {});
    await jest.advanceTimersByTimeAsync(PR_PERIOD.okMs * 3);
    expect(inner.prCalls).toHaveLength(1);

    // A branch switch moves the key, and nobody shows it: nothing is asked.
    inner.stubInfo = { ...inner.stubInfo, branch: "feature" };
    svc.changed("/repo");
    await jest.advanceTimersByTimeAsync(0);
    expect(inner.prCalls).toHaveLength(1);
    expect(logs.at(-1)).toMatch(
      /^git refresh \/repo asked=watch .* pr=owed watch=kept by=change /,
    );

    // Shown again: the new key is looked up, never answered by the old one.
    const shown = gitOf(svc, new Holds(), "/repo", {
      showPullRequest: true,
    });
    await jest.advanceTimersByTimeAsync(0);
    expect(inner.prCalls).toHaveLength(2);
    // Its values were read before: the owed key's lookup is a change.
    expect(passes(logs).at(-1)).toMatch(/ asked=\S*owed\S* .* by=change /);
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
    await gitOf(svc, holds, "/repo", { showSha: true });
    const shown = new Holds();
    await gitOf(svc, shown, "/repo", { showPullRequest: true });
    expect(inner.prCalls).toHaveLength(1);
    holds.declare(() => {});

    // The skipped set still stores `main`; the pass reads `feature`.
    inner.stubInfo = { ...inner.stubInfo, branch: "feature" };
    svc.changed("/repo");
    await jest.advanceTimersByTimeAsync(0);
    expect(passes(logs).at(-1)).toMatch(
      / asked=watch values=1 pr=looked-up watch=kept by=change /,
    );
    expect(inner.prCalls).toHaveLength(2);
    svc.close();
  });

  test("an owed PR shown on a repo that changed unused is looked up once, on the key the pass reads", async () => {
    jest.useFakeTimers();
    const { svc, inner, holds, logs } = makeCache();
    inner.repoRootByDir = { "/repo": "/repo" };
    await gitOf(svc, holds, "/repo", { showPullRequest: true });
    const values = new Holds();
    await gitOf(svc, values, "/repo", {});
    holds.declare(() => {});
    inner.stubInfo = { ...inner.stubInfo, branch: "feature" };
    svc.changed("/repo");
    await jest.advanceTimersByTimeAsync(0);
    expect(logs.at(-1)).toMatch(/ pr=owed /);

    // Nothing uses the repo, and the branch moves again unseen.
    values.declare(() => {});
    expect(svc.getStats().held).toBe(0);
    inner.stubInfo = { ...inner.stubInfo, branch: "third" };
    svc.changed("/repo");

    // Shown again: one lookup, for `third` — none for the owed `feature`.
    void gitOf(svc, new Holds(), "/repo", { showPullRequest: true });
    await jest.advanceTimersByTimeAsync(0);
    expect(passes(logs).at(-1)).toMatch(/ pr=looked-up /);
    expect(inner.prCalls).toHaveLength(2);
    svc.close();
  });

  test("a PR nobody shows reads no remote; shown again on the same branch, its stored answer is taken at once", async () => {
    jest.useFakeTimers();
    const { svc, inner, holds, logs } = makeCache();
    inner.repoRootByDir = { "/repo": "/repo" };
    await gitOf(svc, holds, "/repo", { showPullRequest: true });
    const values = new Holds();
    await gitOf(svc, values, "/repo", {});
    holds.declare(() => {});
    const remotes = inner.remoteCalls;
    await jest.advanceTimersByTimeAsync(GIT_PERIOD_MS * 2);
    expect(inner.remoteCalls).toBe(remotes);

    // Every pass kept its key by the branch it read, so the stored answer is
    // taken at once: no pass, no lookup.
    expect(logs.at(-1)).toMatch(/ pr=kept /);
    const passes = inner.computeCalls.length;
    const shown = gitOf(svc, new Holds(), "/repo", {
      showPullRequest: true,
    });
    await expect(shown).resolves.toMatchObject({
      kind: "ok",
      value: { pullRequest: { kind: "ok" } },
    });
    await jest.advanceTimersByTimeAsync(0);
    expect(inner.computeCalls).toHaveLength(passes);
    expect(inner.prCalls).toHaveLength(1);
    svc.close();
  });

  test("a PR shown again after a change while unused waits for the pass, never ticking the key the repo left", async () => {
    jest.useFakeTimers();
    const { svc, inner, holds, logs } = makeCache();
    inner.repoRootByDir = { "/repo": "/repo" };
    await gitOf(svc, holds, "/repo", { showPullRequest: true });
    holds.declare(() => {});
    expect(svc.getStats().held).toBe(0);
    inner.stubInfo = { ...inner.stubInfo, branch: "feature" };
    svc.changed("/repo");
    // Past the PR's period: a resumed period would tick at once — before the
    // pass, held here as a real git read is, can move the key.
    await jest.advanceTimersByTimeAsync(PR_PERIOD.okMs * 2);
    inner.infoGate = deferred();

    void gitOf(svc, new Holds(), "/repo", { showPullRequest: true });
    await jest.advanceTimersByTimeAsync(0);
    expect(inner.prCalls).toHaveLength(1);
    inner.infoGate.resolve();
    inner.infoGate = null;
    await jest.advanceTimersByTimeAsync(0);
    expect(passes(logs).at(-1)).toMatch(/ pr=looked-up /);
    expect(inner.prCalls).toHaveLength(2);
    svc.close();
  });

  test("a PR read beside a value a pass went by without waits for the pass that reads both", async () => {
    jest.useFakeTimers();
    const { svc, inner } = makeCache();
    inner.repoRootByDir = { "/repo": "/repo" };
    const o2 = { showSha: true, showPullRequest: true };
    const before = new Holds();
    await gitOf(svc, before, "/repo", o2);
    // A preset switch reads another option set with the PR; a declaration
    // releases the first.
    await gitOf(svc, new Holds(), "/repo", { showPullRequest: true });
    before.declare(() => {});
    inner.stubInfo = { ...inner.stubInfo, branch: "feat-b" };
    svc.changed("/repo");
    await jest.advanceTimersByTimeAsync(0);
    expect(inner.prCalls).toHaveLength(2);

    // Switched back: the swept set still stores `main`, the PR is feat-b's.
    const back = gitOf(svc, new Holds(), "/repo", o2);
    await jest.advanceTimersByTimeAsync(0);
    await expect(back).resolves.toMatchObject({
      kind: "ok",
      value: { branch: "feat-b", pullRequest: { kind: "ok" } },
    });
    expect(inner.prCalls).toHaveLength(2);
    svc.close();
  });

  test("a value something waits on is read though its hold was released", async () => {
    jest.useFakeTimers();
    const { svc, inner } = makeCache();
    inner.repoRootByDir = { "/repo": "/repo" };
    inner.infoGate = deferred();
    void gitOf(svc, new Holds(), "/repo", {});
    await jest.advanceTimersByTimeAsync(0);
    const gone = new Holds();
    const waiting = gitOf(svc, gone, "/repo", { showSha: true });
    await jest.advanceTimersByTimeAsync(0);
    gone.close();
    inner.infoGate.resolve();
    inner.infoGate = null;
    await jest.advanceTimersByTimeAsync(0);
    let answer: Outcome<GitInfo> | "waiting" = "waiting";
    void waiting.then((a) => (answer = a));
    await jest.advanceTimersByTimeAsync(0);
    expect(answer).toMatchObject({ kind: "ok" });
    svc.close();
  });

  test("a reader waiting on an owed PR is answered when the pass reads no branch", async () => {
    jest.useFakeTimers();
    const { svc, inner, holds, logs } = makeCache();
    inner.repoRootByDir = { "/repo": "/repo" };
    await gitOf(svc, holds, "/repo", { showPullRequest: true });
    const values = new Holds();
    await gitOf(svc, values, "/repo", {});
    holds.declare(() => {});
    inner.stubInfo = { ...inner.stubInfo, branch: "feature" };
    svc.changed("/repo");
    await jest.advanceTimersByTimeAsync(0);

    inner.infoFailure = "git status timed out";
    const shown = gitOf(svc, new Holds(), "/repo", {
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
    await gitOf(svc, holds, "/repo", {});

    inner.stubInfo = { ...inner.stubInfo, branch: "feature" };
    svc.changed("/repo");
    await tick();
    expect(inner.computeCalls).toHaveLength(2);

    const out = await gitOf(svc, holds, "/repo", {});
    expect(out).toMatchObject({ kind: "ok", value: { branch: "feature" } });
    expect(inner.computeCalls).toHaveLength(2);
    expect(svc.getStats()).toMatchObject({ changes: 1 });
  });

  test("a change mid-read queues one re-read after it, so the last change lands (brandon-unfiled-3248.xjma)", async () => {
    const { svc, inner, holds } = makeCache();
    inner.repoRootByDir = { "/repo": "/repo" };
    inner.infoGate = deferred();

    const read = gitOf(svc, holds, "/repo", {});
    await tick();
    expect(inner.computeCalls).toHaveLength(1); // the first read is out

    // The repo changes after that read began: its answer is already stale.
    inner.stubInfo = { ...inner.stubInfo, branch: "feature" };
    svc.changed("/repo");
    const gate = inner.infoGate;
    inner.infoGate = null;
    gate.resolve();

    expect(await read).toMatchObject({ kind: "ok", value: { branch: "main" } });
    await tick();

    // The stored value ends on a value read after the change, never on the one
    // read before it.
    expect(inner.computeCalls).toHaveLength(2);
    const now = await gitOf(svc, holds, "/repo", {});
    expect(now).toMatchObject({ kind: "ok", value: { branch: "feature" } });
  });

  test("a read during a refresh takes the stored value at once; the value stands until the re-read lands", async () => {
    const { svc, inner, holds } = makeCache();
    inner.repoRootByDir = { "/repo": "/repo" };
    await gitOf(svc, holds, "/repo", {});

    inner.infoGate = deferred();
    inner.stubInfo = { ...inner.stubInfo, branch: "feature" };
    svc.changed("/repo");
    await tick();
    expect(inner.computeCalls).toHaveLength(2); // the re-read is out

    const during = await gitOf(svc, holds, "/repo", {});
    expect(during).toMatchObject({ kind: "ok", value: { branch: "main" } });

    inner.infoGate.resolve();
    await tick();
    const after = await gitOf(svc, holds, "/repo", {});
    expect(after).toMatchObject({ kind: "ok", value: { branch: "feature" } });
  });

  test("a repo evicted while its re-read is out, then read again, gets a first read of its own", async () => {
    const { svc, inner } = makeCache({ maxRepos: 1 });
    inner.repoRootByDir = { "/a": "/a", "/b": "/b" };
    const first = new Holds();
    await gitOf(svc, first, "/a", {});

    inner.infoGate = deferred();
    svc.changed("/a");
    await tick();
    first.declare(() => {}); // unused while its re-read is out
    const gate = inner.infoGate;
    inner.infoGate = null;
    await gitOf(svc, new Holds(), "/b", {}); // evicts /a mid-read

    const again = gitOf(svc, new Holds(), "/a", {});
    gate.resolve();
    await expect(again).resolves.toMatchObject({ kind: "ok" });
  });

  test("rapid changes coalesce into at most two refreshes", async () => {
    const { svc, inner, holds } = makeCache();
    inner.repoRootByDir = { "/repo": "/repo" };
    await gitOf(svc, holds, "/repo", {});
    const initialComputeCalls = inner.computeCalls.length;

    // The first starts a refresh; the rest collapse into one trailing re-read.
    for (let i = 0; i < 10; i++) svc.changed("/repo");
    await tick(10);

    expect(inner.computeCalls.length - initialComputeCalls).toBeLessThanOrEqual(
      2,
    );
  });

  test("a held repo is re-read every period; released, it costs no read", async () => {
    jest.useFakeTimers();
    const { svc, inner, holds } = makeCache();
    inner.repoRootByDir = { "/repo": "/repo" };
    await gitOf(svc, holds, "/repo", {});
    expect(inner.computeCalls).toHaveLength(1);

    await jest.advanceTimersByTimeAsync(GIT_PERIOD_MS - 1);
    expect(inner.computeCalls).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(inner.computeCalls).toHaveLength(2);
    await jest.advanceTimersByTimeAsync(GIT_PERIOD_MS);
    expect(inner.computeCalls).toHaveLength(3);

    holds.declare(() => {});
    await jest.advanceTimersByTimeAsync(GIT_PERIOD_MS * 5);
    expect(inner.computeCalls).toHaveLength(3);
    svc.close();
  });

  test("a period that resumes reads at the time it has left, or at once when its last read is older", async () => {
    jest.useFakeTimers();
    const { svc, inner } = makeCache();
    inner.repoRootByDir = { "/repo": "/repo" };
    const first = new Holds();
    await gitOf(svc, first, "/repo", {});
    await jest.advanceTimersByTimeAsync(10_000);
    first.declare(() => {});
    await jest.advanceTimersByTimeAsync(10_000);

    // Held again 20 s after its last read: the next read is 10 s away.
    const second = new Holds();
    await gitOf(svc, second, "/repo", {});
    await jest.advanceTimersByTimeAsync(9_999);
    expect(inner.computeCalls).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(inner.computeCalls).toHaveLength(2);

    // Released past a whole period: held again, it reads at once.
    second.declare(() => {});
    await jest.advanceTimersByTimeAsync(GIT_PERIOD_MS * 2);
    await gitOf(svc, new Holds(), "/repo", {});
    await jest.advanceTimersByTimeAsync(0);
    expect(inner.computeCalls).toHaveLength(3);
    svc.close();
  });

  test("a change on a repo nobody holds reads nothing until it is held again, then at once", async () => {
    const { svc, inner } = makeCache();
    inner.repoRootByDir = { "/repo": "/repo" };
    const first = new Holds();
    await gitOf(svc, first, "/repo", {});
    first.declare(() => {});

    inner.stubInfo = { ...inner.stubInfo, branch: "feature" };
    svc.changed("/repo");
    await tick();
    expect(inner.computeCalls).toHaveLength(1);

    const second = new Holds();
    await gitOf(svc, second, "/repo", {});
    await tick();
    expect(inner.computeCalls).toHaveLength(2);
    const now = await gitOf(svc, second, "/repo", {});
    expect(now).toMatchObject({ kind: "ok", value: { branch: "feature" } });
  });

  test("a failed refresh is logged once, by the refresh; reads of it log nothing", async () => {
    const { svc, inner, logs, holds } = makeCache();
    inner.repoRootByDir = { "/repo": "/repo" };
    inner.infoFailure = "git status timed out";

    for (let i = 0; i < 3; i++) {
      expect((await gitOf(svc, holds, "/repo", {})).kind).toBe("failed");
    }
    expect(failuresIn(logs)).toEqual(["git status timed out"]);

    inner.infoFailure = null;
    svc.changed("/repo");
    await tick();
    expect((await gitOf(svc, holds, "/repo", {})).kind).toBe("ok");
  });

  test("a field git could not read is logged once per refresh, never per read", async () => {
    const { svc, inner, logs, holds } = makeCache();
    inner.repoRootByDir = { "/repo": "/repo" };
    inner.stubInfo = {
      ...inner.stubInfo,
      stashCount: failed("git stash list: timeout"),
    };

    for (let i = 0; i < 3; i++) await gitOf(svc, holds, "/repo", {});
    expect(failuresIn(logs)).toEqual(["git.stash: git stash list: timeout"]);
  });

  test("a HEAD git could not read is logged, though the payload only reads it for the PR", async () => {
    const { svc, inner, logs, holds } = makeCache();
    inner.repoRootByDir = { "/repo": "/repo" };
    inner.stubInfo = {
      ...inner.stubInfo,
      head: failed("git rev-parse: timeout"),
    };

    await gitOf(svc, holds, "/repo", {});
    expect(failuresIn(logs)).toEqual(["git.head: git rev-parse: timeout"]);
  });
});

describe("GitDataProvider watches", () => {
  test("a directory in no repo reads absent and holds no watcher", async () => {
    const { svc, inner, holds } = makeCache();
    inner.repoRootByDir = { "/nowhere": null };

    expect((await gitOf(svc, holds, "/nowhere", {})).kind).toBe("absent");
    expect(svc.getStats().watchers).toBe(0);
  });

  test("two directories of one repo share one watcher slot", async () => {
    const { svc, inner, holds } = makeCache();
    inner.repoRootByDir = { "/repo/a": "/repo", "/repo/b": "/repo" };

    await gitOf(svc, holds, "/repo/a", {});
    await gitOf(svc, holds, "/repo/b", {});
    expect(svc.getStats().watchers).toBe(1);
  });

  test("a refresh does not re-resolve the repo", async () => {
    const { svc, inner, holds } = makeCache();
    inner.repoRootByDir = { "/repo": "/repo" };
    await gitOf(svc, holds, "/repo", {});
    expect(inner.resolveCalls.length).toBe(1);

    svc.changed("/repo");
    svc.changed("/repo");
    await tick(10);

    expect(inner.resolveCalls.length).toBe(1);
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
      expect((await gitOf(svc, holds, "/nowhere", {})).kind).toBe("absent");
    }

    expect(inner.resolveCalls).toHaveLength(1);
  });

  test("an absent answer expires, so a directory that becomes a repo is seen", async () => {
    // The invalidation story for a negative answer is the TTL: `git init` in a
    // directory the bar has already rendered becomes visible within one window.
    jest.useFakeTimers();
    const { svc, inner, holds } = makeCache();
    inner.repoRootByDir = { "/nowhere": null };
    expect((await gitOf(svc, holds, "/nowhere", {})).kind).toBe("absent");

    inner.repoRootByDir = { "/nowhere": "/nowhere" };
    jest.advanceTimersByTime(30_000);
    const after = await gitOf(svc, holds, "/nowhere", {});
    expect(after.kind).toBe("ok");
    expect(inner.resolveCalls.length).toBe(2);
    svc.close();
  });

  test("a failed resolution is cached too — the timeout case is the costly one", async () => {
    const { svc, inner, holds } = makeCache();
    inner.resolveFailure = "git rev-parse --show-toplevel timed out";

    for (let i = 0; i < 5; i++) {
      const out = await gitOf(svc, holds, "/wherever", {});
      expect(out.kind).toBe("failed");
    }

    expect(inner.resolveCalls).toHaveLength(1);
  });

  test("a lane read past the window never resolves; only a declaration does", async () => {
    // A frame reads the lane its view's last declaration took: however often
    // and however late it reads, it neither walks the directory nor takes a
    // hold (brandon-unfiled-3248.8ro6, 4b).
    jest.useFakeTimers();
    const { svc, inner, holds } = makeCache();
    inner.repoRootByDir = { "/repo": "/repo" };
    const lane = svc.declare(holds, "/repo");
    await jest.advanceTimersByTimeAsync(0);
    expect(inner.resolveCalls).toHaveLength(1);

    jest.advanceTimersByTime(60_000);
    for (let i = 0; i < 10; i++) {
      expect(lane.current()).toMatchObject({ kind: "ok" });
    }
    expect(inner.resolveCalls).toHaveLength(1);
    expect(holds.size).toBe(1);
    svc.close();
  });

  test("a first declaration knows its repo and holds it in its own turn", () => {
    const { svc, inner, holds } = makeCache();
    inner.repoRootByDir = { "/repo/sub": "/repo" };

    svc.declare(holds, "/repo/sub");

    expect(svc.getStats().held).toBe(1);
    svc.close();
  });

  test("projectDir is part of the key, so it cannot be answered by the wrong entry", async () => {
    const { svc, inner, holds } = makeCache();
    inner.repoRootByDir = { "/cwd": "/cwd", "/project": "/project" };
    inner.effectiveDirByKey = { "/cwd|/project": "/project" };

    expect(await gitOf(svc, holds, "/cwd", {})).toMatchObject({
      kind: "ok",
    });
    await gitOf(svc, holds, "/cwd", {}, "/project");

    expect(inner.resolveCalls).toEqual([
      { workingDir: "/cwd", projectDir: undefined },
      { workingDir: "/cwd", projectDir: "/project" },
    ]);
    expect(inner.computeCalls.map((c) => c.workingDir)).toEqual([
      "/cwd",
      "/project",
    ]);
  });

  test("a throwing resolver is answered failed, logged once, and believed for the window", async () => {
    // A throw is the resolver's bug: answered as a failure like any other, so
    // a request waiting on it is answered rather than sent to ask again.
    const { svc, inner, logs, holds } = makeCache();
    inner.resolveThrows = true;

    for (let i = 0; i < 2; i++) {
      expect(await gitOf(svc, holds, "/boom", {})).toEqual(
        failed("resolver threw: Error: resolver bug"),
      );
    }
    expect(svc.declare(holds, "/boom").current()).toEqual(
      failed("resolver threw: Error: resolver bug"),
    );

    expect(inner.resolveCalls).toHaveLength(1);
    expect(logs).toEqual([
      "git resolve failed (/boom): resolver threw: Error: resolver bug",
    ]);
  });

  test("close() drops the answers instead of carrying them past shutdown", async () => {
    const { svc, inner, holds } = makeCache();
    inner.repoRootByDir = { "/nowhere": null };
    await gitOf(svc, holds, "/nowhere", {});
    expect(inner.resolveCalls).toHaveLength(1);

    svc.close();
    await gitOf(svc, holds, "/nowhere", {});
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

    const out = await gitOf(svc, holds, "/repo", {});
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") return;
    expect(out.value.pullRequest).toBeUndefined();
    expect(inner.prCalls).toHaveLength(0);
  });

  test("showPullRequest on → PR attached to GitInfo", async () => {
    const { svc, inner, holds } = makeCache();
    inner.repoRootByDir = { "/repo": "/repo" };

    const out = await gitOf(svc, holds, "/repo", { showPullRequest: true });
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") return;
    expect(out.value.pullRequest).toEqual(OPEN_PR);
    expect(inner.prCalls).toHaveLength(1);
  });

  test("git refreshes on one key look the PR up no further", async () => {
    const { svc, inner, holds } = makeCache();
    inner.repoRootByDir = { "/repo": "/repo" };

    await gitOf(svc, holds, "/repo", { showPullRequest: true });
    for (let i = 0; i < 3; i++) {
      svc.changed("/repo");
      await tick();
    }
    await gitOf(svc, holds, "/repo", { showPullRequest: true });

    expect(inner.computeCalls.length).toBeGreaterThanOrEqual(4);
    expect(inner.prCalls).toHaveLength(1);
  });

  test("a branch switch is a new key, looked up afresh", async () => {
    const { svc, inner, holds } = makeCache();
    inner.repoRootByDir = { "/repo": "/repo" };

    inner.stubInfo = { ...inner.stubInfo, branch: "feature-a" };
    await gitOf(svc, holds, "/repo", { showPullRequest: true });
    inner.stubInfo = { ...inner.stubInfo, branch: "feature-b" };
    svc.changed("/repo");
    await tick();
    await gitOf(svc, holds, "/repo", { showPullRequest: true });

    expect(inner.prCalls).toHaveLength(2);
  });

  test("a failed forge lookup is attached as failed (surfaced, not dropped) and logged once", async () => {
    const { svc, inner, logs, holds } = makeCache();
    inner.repoRootByDir = { "/repo": "/repo" };
    inner.stubPr = { kind: "failed", reason: "gh pr view: non-zero, HTTP 401" };

    for (let i = 0; i < 3; i++) {
      const out = await gitOf(svc, holds, "/repo", {
        showPullRequest: true,
      });
      expect(out.kind).toBe("ok");
      if (out.kind !== "ok") return;
      expect(out.value.pullRequest).toEqual({
        kind: "failed",
        reason: "gh pr view: non-zero, HTTP 401",
      });
    }
    expect(failuresIn(logs, "pr")).toEqual(["gh pr view: non-zero, HTTP 401"]);
  });

  test("a re-pointed origin is a new key, looked up afresh", async () => {
    const { svc, inner, holds } = makeCache();
    inner.repoRootByDir = { "/repo": "/repo" };

    inner.stubRemote = ok("git@github.com:acme/widget.git");
    await gitOf(svc, holds, "/repo", { showPullRequest: true });
    inner.stubRemote = ok("git@gitlab.com:acme/widget.git");
    svc.changed("/repo");
    await tick();
    await gitOf(svc, holds, "/repo", { showPullRequest: true });

    expect(inner.prCalls.map((c) => c.remoteUrl)).toEqual([
      "git@github.com:acme/widget.git",
      "git@gitlab.com:acme/widget.git",
    ]);
  });

  test("failed remote read → PR failed (surfaced); no forge call", async () => {
    const { svc, inner, holds } = makeCache();
    inner.repoRootByDir = { "/repo": "/repo" };
    inner.stubRemote = { kind: "failed", reason: "git config: timeout" };

    const out = await gitOf(svc, holds, "/repo", { showPullRequest: true });
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

    const out = await gitOf(svc, holds, "/repo", { showPullRequest: true });
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

    await gitOf(svc, holds, "/repo", { showPullRequest: true });
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

    await gitOf(svc, holds, "/repo", { showPullRequest: true });
    holds.declare(() => {});
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
      expect(await gitOf(svc, holds, "/slow", {})).toEqual(
        failed("git rev-parse: timeout"),
      );
    }
    svc.declare(new Holds(), "/slow").current();
    await tick();
    expect(logs).toEqual([
      "git resolve failed (/slow): git rev-parse: timeout",
    ]);
  });

  test("a declaration into a closed home throws, for the view's declaration to report", () => {
    const { svc, inner, holds } = makeCache();
    inner.repoRootByDir = { "/repo": "/repo" };
    holds.close();
    expect(() => svc.declare(holds, "/repo", {})).toThrow(
      "hold taken after close: git:/repo|{}|-",
    );
  });

  test("a branch switch never pairs the new branch with the old branch's PR", async () => {
    const { svc, inner, holds } = makeCache();
    inner.repoRootByDir = { "/repo": "/repo" };
    const onA = { ...inner.stubInfo, branch: "a" };
    inner.stubInfo = onA;
    const first = await gitOf(svc, holds, "/repo", {
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
    expect(await gitOf(svc, holds, "/repo", { showPullRequest: true })).toEqual(
      ok({ ...onA, pullRequest: prA }),
    );

    // Stored, b's values wait for b's PR rather than wear a's.
    inner.remoteGate.resolve();
    await tick();
    // b's PR is a key never answered, which a request waits for.
    const now = svc
      .declare(holds, "/repo", { showPullRequest: true })
      .current();
    expect(now.kind === "ok" && now.value.pullRequest).toMatchObject({
      kind: "pending",
      why: "unread",
    });
    let read: Outcome<GitInfo> | null = null;
    void gitOf(svc, holds, "/repo", { showPullRequest: true }).then(
      (out) => (read = out),
    );
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
    await gitOf(svc, holds, "/repo", { showPullRequest: true });

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
      throwOn: "outcome=failed",
    });
    inner.repoRootByDir = { "/repo": "/repo" };
    inner.infoFailure = "git status: boom";

    void gitOf(svc, holds, "/repo", {});
    await jest.advanceTimersByTimeAsync(0);
    expect(logs.filter((l) => l.startsWith("git "))).toEqual([
      "git watch bound root=/repo dirs=/repo/.git,/repo/.git/refs/heads deaf=2",
      "git refresh threw (/repo): Error: logger bug",
    ]);
    await jest.advanceTimersByTimeAsync(1_000);
    expect(inner.computeCalls).toHaveLength(2);
    expect(failuresIn(logs)).toEqual(["git status: boom"]);
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
    const first = await gitOf(svc, holds, "/repo", {
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

    expect(await gitOf(svc, holds, "/repo", { showPullRequest: true })).toEqual(
      ok({ ...onA, pullRequest: first.value.pullRequest }),
    );
    expect(inner.prCalls).toHaveLength(2);
    expect(logs.filter((l) => l.startsWith("git refresh /repo"))).toEqual([
      expect.stringMatching(
        / asked=first,pr,owed values=1 pr=looked-up watch=kept by=first /,
      ),
      expect.stringMatching(
        / asked=watch values=1 pr=looked-up watch=kept by=change /,
      ),
      expect.stringMatching(
        / asked=watch values=1 pr=recalled watch=kept by=change /,
      ),
    ]);
  });

  test("the PR's first ask, while a stored value is stale, pairs the values it answers with", async () => {
    const { svc, inner, holds } = makeCache();
    inner.repoRootByDir = { "/repo": "/repo" };
    inner.stubInfo = { ...inner.stubInfo, branch: "a" };
    await gitOf(svc, holds, "/repo", {});

    // The repo is on b, and the pass that will say so is out.
    inner.stubInfo = { ...inner.stubInfo, branch: "b" };
    inner.stubPr = PR_B;
    inner.infoGate = deferred();
    svc.changed("/repo");
    const read = gitOf(svc, holds, "/repo", { showPullRequest: true });
    await tick();
    inner.infoGate.resolve();
    inner.infoGate = null;

    expect(await read).toEqual(ok({ ...inner.stubInfo, pullRequest: PR_B }));
  });

  test("a first read out when the cache closes is answered, never left waiting", async () => {
    const { svc, inner, holds } = makeCache();
    inner.repoRootByDir = { "/repo": "/repo" };
    inner.infoGate = deferred();

    const read = gitOf(svc, holds, "/repo", {});
    await tick();
    svc.close();
    expect(await read).toEqual(failed("git state dropped: /repo"));
    inner.infoGate.resolve();
  });

  test("a pass the period started says so on its refresh event", async () => {
    jest.useFakeTimers();
    const { svc, inner, logs, holds } = makeCache({ periodMs: 1_000 });
    inner.repoRootByDir = { "/repo": "/repo" };
    await gitOf(svc, holds, "/repo", {});
    await jest.advanceTimersByTimeAsync(1_000);

    expect(logs.filter((l) => l.startsWith("git refresh /repo"))).toEqual([
      expect.stringMatching(
        / asked=first values=1 pr=- watch=kept by=first outcome=ok took=\d+ms$/,
      ),
      expect.stringMatching(
        / asked=- values=1 pr=- watch=kept by=period outcome=ok took=\d+ms$/,
      ),
    ]);
    svc.close();
  });
});

// brandon-unfiled-3248.576q: on macOS every directory watch opened or closed
// leaks native memory (libuv's FSEvents reschedule), so a repo's watch must
// outlive the values read from it — a refresh or a change replaces the value,
// never the watch.
describe("GitDataProvider holds a repo's watch across its values", () => {
  function counted(opts: { maxRepos?: number; periodMs?: number } = {}) {
    const inner = new StubGitService(processLauncher);
    const counters = {
      watchersOpened: 0,
      watchersClosed: 0,
      watchRefusals: 0,
      watchErrors: 0,
      dirWatchesOpened: 0,
      dirWatchesClosed: 0,
    };
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

    await gitOf(svc, holds, "/repo", {});
    for (let i = 0; i < 5; i++) {
      svc.changed("/repo");
      await tick();
    }

    expect(inner.computeCalls).toHaveLength(6);
    // The stub repo has no folder on disk, so its one slot is a refused one.
    expect(counters).toEqual({
      watchersOpened: 0,
      watchersClosed: 0,
      watchRefusals: 1,
      watchErrors: 0,
      dirWatchesOpened: 0,
      dirWatchesClosed: 0,
    });
    expect(watchers.size()).toBe(1);
    svc.close();
  });

  // Git writes HEAD and index by renaming a `.lock` file over them. A watch
  // held across refreshes must hear every such replacement, not just the first.
  test("the held watch hears every lock-file rename over index and HEAD", async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "git-cache-576q-"));
    const gitDir = path.join(repo, ".git");
    // A git directory always holds `refs/heads`, and the repo's watch covers
    // that tree; a fixture without it is refused, not opened.
    fs.mkdirSync(path.join(gitDir, "refs", "heads"), { recursive: true });
    const replace = (name: string, text: string) => {
      const lock = path.join(gitDir, `${name}.lock`);
      fs.writeFileSync(lock, text);
      fs.renameSync(lock, path.join(gitDir, name));
    };
    replace("HEAD", "ref: refs/heads/main\n");
    replace("index", "0");
    const { svc, inner, counters } = counted();
    inner.repoRootByDir[repo] = repo;
    try {
      await gitOf(svc, new Holds(), repo, {});
      // FSEvents drops what lands before its stream is armed, and a
      // declaration opens the watch in the same turn it resolves, so each
      // rename is re-applied until the watch hears it. The change count is
      // the only observation, and it only grows: a rename a round left in
      // flight may land later, so each is at-least, and what the five prove
      // is that the held watch keeps delivering through every one of them.
      const renames = ["index", "index", "HEAD", "index", "HEAD"];
      for (const [i, name] of renames.entries()) {
        const before = svc.getStats().changes;
        await untilHeard(
          () => replace(name, String(i + 1)),
          () => svc.getStats().changes > before,
          `rename ${i + 1} over ${name} heard`,
        );
      }
      expect(counters).toEqual({
        watchersOpened: 1,
        watchersClosed: 0,
        watchRefusals: 0,
        watchErrors: 0,
        // The git directory and the refs tree, never reopened.
        dirWatchesOpened: 2,
        dirWatchesClosed: 0,
      });
    } finally {
      svc.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  // A directory watch binds an inode, not a path: on Linux a git directory
  // deleted and recreated at its path is a new one the held watch never hears.
  // The period's pass derives the watch again and rebinds it, so a rename in
  // the recreated directory is heard. (On a healthy macOS FSEvents follows the
  // path, so the rebind is a harmless reopen; CI's Linux runner is what
  // proves the case.)
  test("a git directory recreated at its path is heard again after the period rebinds the watch (brandon-unfiled-3248.gf07)", async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "git-cache-gf07-"));
    const gitDir = path.join(repo, ".git");
    const replace = (name: string, text: string) => {
      const lock = path.join(gitDir, `${name}.lock`);
      fs.writeFileSync(lock, text);
      fs.renameSync(lock, path.join(gitDir, name));
    };
    const create = () => {
      fs.mkdirSync(path.join(gitDir, "refs", "heads"), { recursive: true });
      replace("HEAD", "ref: refs/heads/main\n");
      replace("index", "0");
    };
    create();
    const { svc, inner, counters, logs } = counted({ periodMs: 100 });
    inner.repoRootByDir[repo] = repo;
    const watchMoves = () =>
      passes(logs).map((l) => / watch=(\w+) /.exec(l)![1]);
    try {
      await gitOf(svc, new Holds(), repo, {});
      expect(counters.watchersOpened).toBe(1);

      // The worktree is removed and one of the same name added.
      fs.rmSync(gitDir, { recursive: true, force: true });
      create();
      await until(
        () => counters.watchersOpened === 2,
        "the period's pass rebound the watch",
      );
      expect(counters).toEqual({
        watchersOpened: 2,
        watchersClosed: 1,
        watchRefusals: 0,
        watchErrors: 0,
        // Both directories were made again: each handle reopens in place.
        dirWatchesOpened: 4,
        dirWatchesClosed: 2,
      });
      const before = svc.getStats().changes;
      await untilHeard(
        () => replace("HEAD", "ref: refs/heads/other\n"),
        () => svc.getStats().changes > before,
        "a rename in the recreated git directory",
      );
      // One pass rebound it; every other pass kept it.
      expect(watchMoves().filter((m) => m === "rebound")).toHaveLength(1);
      expect(watchMoves()[0]).toBe("kept");
    } finally {
      svc.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test("a pass over a repo whose directories stand derives the same key and acquires nothing", async () => {
    jest.useFakeTimers();
    const { svc, inner, counters, watchers, logs } = counted();
    inner.repoRootByDir["/repo"] = "/repo";
    await gitOf(svc, new Holds(), "/repo", {});
    await jest.advanceTimersByTimeAsync(GIT_PERIOD_MS * 3);

    expect(passes(logs)).toHaveLength(4);
    expect(passes(logs).every((l) => l.includes(" watch=kept "))).toBe(true);
    // The stub repo is not on disk: one refused slot, never closed or reopened.
    expect(counters).toEqual({
      watchersOpened: 0,
      watchersClosed: 0,
      watchRefusals: 1,
      watchErrors: 0,
      dirWatchesOpened: 0,
      dirWatchesClosed: 0,
    });
    expect(watchers.size()).toBe(1);
    svc.close();
  });

  // The pass between a worktree's removal and its re-add finds the git
  // directory gone. It keeps the watch it holds rather than trade it for a
  // refused slot: on macOS FSEvents keeps a held watch on its path, and on
  // every platform the period rebinds once a directory is there again.
  test("a pass over a repo whose git directory is gone keeps the held watch until one is there to bind", async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "git-cache-gone-"));
    const gitDir = path.join(repo, ".git");
    const create = () => {
      fs.mkdirSync(path.join(gitDir, "refs", "heads"), { recursive: true });
      fs.writeFileSync(path.join(gitDir, "HEAD"), "ref: refs/heads/main\n");
    };
    create();
    const { svc, inner, counters, logs } = counted({ periodMs: 60_000 });
    inner.repoRootByDir[repo] = repo;
    const watchMoves = () =>
      passes(logs).map((l) => / watch=(\w+) /.exec(l)![1]);
    try {
      await gitOf(svc, new Holds(), repo, {});
      expect(counters.watchersOpened).toBe(1);

      // The removal fires the held watch where the OS delivers it, so the
      // passes over the gap number one or more; every one keeps the watch.
      fs.rmSync(gitDir, { recursive: true, force: true });
      svc.changed(repo);
      await until(() => passes(logs).length >= 2, "the pass over the gap");
      expect(new Set(watchMoves())).toEqual(new Set(["kept"]));
      expect(counters).toEqual({
        watchersOpened: 1,
        watchersClosed: 0,
        watchRefusals: 0,
        watchErrors: 0,
        // The git directory and the refs tree, held while the path is empty.
        dirWatchesOpened: 2,
        dirWatchesClosed: 0,
      });

      create();
      svc.changed(repo);
      await until(
        () => watchMoves().includes("rebound"),
        "the pass after the re-add",
      );
      expect(watchMoves().filter((m) => m === "rebound")).toHaveLength(1);
      expect(watchMoves().at(-1)).toBe("rebound");
      expect(counters).toEqual({
        watchersOpened: 2,
        watchersClosed: 1,
        watchRefusals: 0,
        watchErrors: 0,
        // Both directories were made again: each handle reopens in place.
        dirWatchesOpened: 4,
        dirWatchesClosed: 2,
      });
    } finally {
      svc.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  // A pass's first act derives the watch's key by stat'ing each directory. A
  // directory that cannot be stat'd (a symlink loop here; an unreadable one in
  // the field) must not throw the pass, which would leave every value pending
  // and drop what the pass was asked: its failure is its key, the OS refuses
  // the watch, and the pass reads as any other.
  test("a git directory that cannot be stat'd is read by the pass and refused by the watch, never thrown", async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "git-cache-eloop-"));
    const loop = path.join(repo, ".git");
    fs.symlinkSync(loop, loop);
    const { svc, inner, counters, logs } = counted({ periodMs: 100 });
    inner.repoRootByDir[repo] = repo;
    inner.gitDirByDir[repo] = loop;
    try {
      const outcome = await gitOf(svc, new Holds(), repo, {});
      expect(outcome.kind).toBe("ok");
      await until(() => passes(logs).length >= 2, "a period pass landed");
      expect(logs.some((l) => l.startsWith("git refresh threw"))).toBe(false);
      expect(passes(logs)[0]).toMatch(/ watch=kept /);
      // The git directory and the refs tree under it are both refused, on
      // every platform.
      expect(
        logs.some((l) =>
          /^git watch bound root=.* dirs=.*\.git,.*refs\/heads deaf=2$/.test(l),
        ),
      ).toBe(true);
      expect(counters).toEqual({
        watchersOpened: 0,
        watchersClosed: 0,
        watchRefusals: 1,
        watchErrors: 0,
        dirWatchesOpened: 0,
        dirWatchesClosed: 0,
      });
    } finally {
      svc.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test("the git cache's own LRU eviction is what releases a watch", async () => {
    const { svc, inner, counters } = counted({ maxRepos: 1 });
    inner.repoRootByDir = { "/a": "/a", "/b": "/b" };

    const holdsA = new Holds();
    await gitOf(svc, holdsA, "/a", {});
    holdsA.declare(() => {});
    await gitOf(svc, new Holds(), "/b", {}); // evicts /a, its watch's only holder

    // Neither stub repo is on disk: two refused slots, one closed.
    expect(counters).toEqual({
      watchersOpened: 0,
      watchersClosed: 1,
      watchRefusals: 2,
      watchErrors: 0,
      dirWatchesOpened: 0,
      dirWatchesClosed: 0,
    });
    svc.close();
    expect(counters.watchersClosed).toBe(2);
  });

  test("a repo that disappears reads absent and keeps its watch while held", async () => {
    const { svc, inner, counters } = counted();
    inner.repoRootByDir["/repo"] = "/repo";
    const holds = new Holds();

    await gitOf(svc, holds, "/repo", {});
    inner.repoRootByDir["/repo"] = null; // the worktree was removed
    svc.changed("/repo");
    await tick();
    const gone = await gitOf(svc, holds, "/repo", {});

    expect(gone.kind).toBe("absent");
    expect(svc.getStats().size).toBe(1);
    expect(counters).toEqual({
      watchersOpened: 0,
      watchersClosed: 0,
      watchRefusals: 1,
      watchErrors: 0,
      dirWatchesOpened: 0,
      dirWatchesClosed: 0,
    });
    svc.close();
  });
});

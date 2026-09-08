import fs from "node:fs";
import path from "node:path";
import { GitService, type GitInfo, type PullRequest } from "../../segments/git";
import { ABSENT, ok, type Outcome } from "../../utils/outcome";
import { debug } from "../../utils/logger";
import { WatcherRegistry, type WatcherHandle } from "./watchers";

// [LAW:no-defensive-null-guards] The default is non-null; injection replaces it.
export type GitProviderLogger = (
  level: "info" | "warn" | "error",
  message: string,
) => void;

const defaultProviderLogger: GitProviderLogger = (_level, message) =>
  debug(message);

// [LAW:one-source-of-truth] One cache keyed by the EFFECTIVE git dir; findGitRoot(
// workingDir) alone would file repo B under repo A when projectDir overrides.
// [LAW:single-enforcer] subscribe() is the only reactive entrypoint — no poller.

const DEFAULT_TTL_MS = 30_000;
const DEFAULT_MAX_ENTRIES = 64;
const SANITY_INTERVAL_MS = 5 * 60_000;

// [LAW:decomposition] The forge PR gets its own cache and TTL; .git watchers can't see it.
const PR_TTL_OK_MS = 5 * 60_000;
const PR_TTL_FAIL_MS = 45_000;

// Anything not requested here is undefined on the snapshot subscribers receive.
const SUBSCRIBE_OPTIONS = {
  showSha: true,
  showStashCount: true,
} as const;

interface MtimeSnapshot {
  head: number;
  index: number;
}

interface PrCacheEntry {
  pr: Outcome<PullRequest>;
  computedAt: number;
}

interface GitCacheEntry {
  info: GitInfo;
  computedAt: number;
  mtime: MtimeSnapshot;
  watcher: WatcherHandle;
  // All entries for one repoRoot share invalidation: one watcher fires, all drop.
  repoRoot: string;
}

type GitOptions = NonNullable<Parameters<GitService["getGitInfo"]>[1]>;

type SubscribeCallback = (info: GitInfo | null) => void;

interface RepoSubscribers {
  // Resolved to gitDir once at subscribe time so refresh never re-resolves.
  workingDir: string;
  repoRoot: string;
  callbacks: Set<SubscribeCallback>;
  watcher: WatcherHandle;
}

function optionsKey(options: GitOptions): string {
  const keys = Object.keys(options).sort() as Array<keyof GitOptions>;
  const normalized: Record<string, unknown> = {};
  for (const k of keys) normalized[k as string] = options[k];
  return JSON.stringify(normalized);
}

function snapshotMtimes(gitDir: string): MtimeSnapshot {
  // Missing files → 0; comparison still detects changes (0 → number).
  const stat = (rel: string): number => {
    try {
      return fs.statSync(path.join(gitDir, rel)).mtimeMs;
    } catch {
      return 0;
    }
  };
  return { head: stat("HEAD"), index: stat("index") };
}

function mtimeChanged(a: MtimeSnapshot, b: MtimeSnapshot): boolean {
  return a.head !== b.head || a.index !== b.index;
}

// `gitDir` must be RESOLVED — for a worktree, the metadata dir under .git/worktrees/,
// which has no `refs/heads/`, so that target is included only when it really exists.
function watcherTargets(gitDir: string) {
  const dirs: Array<{ path: string }> = [];
  const refsHeads = path.join(gitDir, "refs/heads");
  try {
    if (fs.statSync(refsHeads).isDirectory()) {
      dirs.push({ path: refsHeads });
    }
  } catch {
    // ENOENT (worktree case) — skip the dir target.
  }
  return {
    files: [path.join(gitDir, "HEAD"), path.join(gitDir, "index")],
    dirs,
  };
}

export class GitDataProvider extends GitService {
  private readonly entries = new Map<string, GitCacheEntry>();
  private readonly subscribersByRepo = new Map<string, RepoSubscribers>();
  // [LAW:single-enforcer] Coalesce misses: parallel line renders duplicate `git` work.
  private readonly fetchInFlight = new Map<string, Promise<Outcome<GitInfo>>>();
  // [LAW:one-source-of-truth] PR cache keyed `repoRoot|branch`, with its own TTL.
  private readonly prCache = new Map<string, PrCacheEntry>();
  // [LAW:single-enforcer] Coalesce concurrent PR misses on the same key.
  private readonly prFetchInFlight = new Map<
    string,
    Promise<Outcome<PullRequest>>
  >();
  // [LAW:single-enforcer] Serialize refreshes per repo; `refreshAgain` is the trailing edge.
  private readonly refreshing = new Set<string>();
  private readonly refreshAgain = new Set<string>();
  private hits = 0;
  private misses = 0;
  private invalidations = 0;
  private readonly inner: GitService;
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly watchers: WatcherRegistry;
  private readonly ownsWatchers: boolean;
  private readonly logger: GitProviderLogger;
  private sanityTimer: NodeJS.Timeout | null = null;

  constructor(
    opts: {
      ttlMs?: number;
      maxEntries?: number;
      inner?: GitService;
      watchers?: WatcherRegistry;
      sanityIntervalMs?: number;
      // [LAW:single-enforcer] One injection point; the default is debug-routed.
      logger?: GitProviderLogger;
    } = {},
  ) {
    super();
    this.inner = opts.inner ?? new GitService();
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.logger = opts.logger ?? defaultProviderLogger;
    if (opts.watchers) {
      this.watchers = opts.watchers;
      this.ownsWatchers = false;
    } else {
      this.watchers = new WatcherRegistry({ logger: this.logger });
      this.ownsWatchers = true;
    }
    const sanityMs = opts.sanityIntervalMs ?? SANITY_INTERVAL_MS;
    if (sanityMs > 0) {
      this.sanityTimer = setInterval(() => this.runSanityCheck(), sanityMs);
      this.sanityTimer.unref();
    }
  }

  getWatcherRegistry(): WatcherRegistry {
    return this.watchers;
  }

  getStats(): {
    size: number;
    hits: number;
    misses: number;
    invalidations: number;
    watchers: number;
  } {
    return {
      size: this.entries.size,
      hits: this.hits,
      misses: this.misses,
      invalidations: this.invalidations,
      watchers: this.watchers.size(),
    };
  }

  override async getGitInfo(
    workingDir: string,
    options: GitOptions = {},
    projectDir?: string,
  ): Promise<Outcome<GitInfo>> {
    // [LAW:one-source-of-truth] Resolved once here so inner skips its own resolution.
    const effectiveDir = await this.inner.resolveEffectiveGitDir(
      workingDir,
      projectDir,
    );
    if (effectiveDir.kind !== "ok") return effectiveDir;
    return this.getGitInfoForRoot(effectiveDir.value, options);
  }

  private getGitInfoForRoot(
    repoRoot: string,
    options: GitOptions,
  ): Promise<Outcome<GitInfo>> {
    const key = `${repoRoot}|${optionsKey(options)}`;
    const now = Date.now();

    const existing = this.entries.get(key);
    if (existing && now - existing.computedAt < this.ttlMs) {
      this.entries.delete(key);
      this.entries.set(key, existing);
      this.hits++;
      return Promise.resolve(ok(existing.info));
    }

    const pending = this.fetchInFlight.get(key);
    if (pending) return pending;

    const promise = this.doFetch(repoRoot, key, options, now).finally(() => {
      this.fetchInFlight.delete(key);
    });
    this.fetchInFlight.set(key, promise);
    return promise;
  }

  private async doFetch(
    repoRoot: string,
    key: string,
    options: GitOptions,
    now: number,
  ): Promise<Outcome<GitInfo>> {
    this.misses++;
    // [LAW:one-source-of-truth] gitDir, not repoRoot: in a worktree .git is a file.
    const gitDir = this.inner.resolveGitDir(repoRoot);
    const mtimeBefore = snapshotMtimes(gitDir);
    // Only `ok` is cached; absent/failed pass through carrying their reason.
    const outcome = await this.inner.getGitInfo(repoRoot, options);
    if (outcome.kind !== "ok") return outcome;
    const info = outcome.value;

    // [LAW:decomposition] The cache layer owns the PR lookup to give it its own TTL.
    if (options.showPullRequest) {
      info.pullRequest = await this.getPullRequestCached(repoRoot, info.branch);
    }

    // Drop the prior entry first so its watcher refcount is released.
    this.dropEntry(key);

    // Working-tree changes are caught by `git status` on the next miss, not here.
    const watcher = this.watchers.acquire(
      `git:${repoRoot}`,
      watcherTargets(gitDir),
      () => this.invalidateRepo(repoRoot),
    );
    this.entries.set(key, {
      info,
      computedAt: now,
      mtime: mtimeBefore,
      watcher,
      repoRoot,
    });
    this.evictIfNeeded();
    return outcome;
  }

  // [LAW:single-enforcer] The remote is in the key, so a re-pointed origin misses.
  private async getPullRequestCached(
    repoRoot: string,
    branch: string,
  ): Promise<Outcome<PullRequest>> {
    // [LAW:no-silent-failure] Only `absent` (no remote) means "no forge PR".
    const remote = await this.inner.getRepoRemoteUrl(repoRoot);
    if (remote.kind === "failed") return remote;
    if (remote.kind === "absent") return ABSENT;
    const remoteUrl = remote.value;

    const key = `${repoRoot}|${branch}|${remoteUrl}`;
    const now = Date.now();

    const existing = this.prCache.get(key);
    if (existing) {
      const ttl = existing.pr.kind === "failed" ? PR_TTL_FAIL_MS : PR_TTL_OK_MS;
      if (now - existing.computedAt < ttl) {
        // LRU touch so the active branch's PR survives eviction.
        this.prCache.delete(key);
        this.prCache.set(key, existing);
        return existing.pr;
      }
    }

    const pending = this.prFetchInFlight.get(key);
    if (pending) return pending;

    const promise = this.inner
      .resolvePullRequest(repoRoot, remoteUrl)
      .then((pr) => {
        this.prCache.set(key, { pr, computedAt: Date.now() });
        this.evictPrIfNeeded();
        return pr;
      })
      .finally(() => {
        this.prFetchInFlight.delete(key);
      });
    this.prFetchInFlight.set(key, promise);
    return promise;
  }

  private evictPrIfNeeded(): void {
    while (this.prCache.size > this.maxEntries) {
      const oldest = this.prCache.keys().next().value;
      if (oldest === undefined) break;
      this.prCache.delete(oldest);
    }
  }

  // [LAW:effects-at-boundaries] The one edge where a `failed` outcome is logged.
  private deliverable(
    outcome: Outcome<GitInfo>,
    repoRoot: string,
  ): GitInfo | null {
    if (outcome.kind === "failed") {
      this.logger("warn", `git fetch failed (${repoRoot}): ${outcome.reason}`);
      return null;
    }
    return outcome.kind === "ok" ? outcome.value : null;
  }

  // [LAW:dataflow-not-control-flow] Initial delivery is asynchronous, not same-tick.
  subscribe(workingDir: string, callback: SubscribeCallback): () => void {
    let unsubscribed = false;
    let attached: { repoRoot: string; entry: RepoSubscribers } | null = null;

    void (async () => {
      // Resolve through the same path the pull surface uses so keys cannot diverge.
      const resolved = await this.inner.resolveEffectiveGitDir(workingDir);
      if (unsubscribed) return;

      if (resolved.kind !== "ok") {
        // Not a repo, or resolution failed: deliver null once, with no follow-up.
        if (resolved.kind === "failed") {
          this.logger(
            "warn",
            `git resolve failed (subscribe ${workingDir}): ${resolved.reason}`,
          );
        }
        this.safeInvoke(callback, null);
        return;
      }
      const repoRoot = resolved.value;

      let entry = this.subscribersByRepo.get(repoRoot);
      if (!entry) {
        const gitDir = this.inner.resolveGitDir(repoRoot);
        const watcher = this.watchers.acquire(
          `git:${repoRoot}`,
          watcherTargets(gitDir),
          () => this.invalidateRepo(repoRoot),
        );
        entry = {
          workingDir,
          repoRoot,
          callbacks: new Set<SubscribeCallback>(),
          watcher,
        };
        this.subscribersByRepo.set(repoRoot, entry);
      }
      entry.callbacks.add(callback);
      attached = { repoRoot, entry };

      const initial = await this.getGitInfoForRoot(repoRoot, {
        ...SUBSCRIBE_OPTIONS,
      });
      if (unsubscribed) return;
      this.safeInvoke(callback, this.deliverable(initial, repoRoot));
    })();

    return () => {
      unsubscribed = true;
      if (!attached) return;
      const { repoRoot, entry } = attached;
      entry.callbacks.delete(callback);
      if (entry.callbacks.size === 0) {
        entry.watcher.release();
        this.subscribersByRepo.delete(repoRoot);
      }
    };
  }

  invalidateRepo(repoRoot: string): void {
    let dropped = 0;
    for (const [key, entry] of this.entries) {
      if (entry.repoRoot === repoRoot) {
        entry.watcher.release();
        this.entries.delete(key);
        dropped++;
      }
    }
    if (dropped > 0) {
      this.invalidations += dropped;
      this.logger("info", `gitCache invalidate ${repoRoot} dropped=${dropped}`);
    }
    this.refreshSubscribers(repoRoot);
  }

  // [LAW:single-enforcer] Serialized per repo; the trailing-edge flag caps a burst.
  private refreshSubscribers(repoRoot: string): void {
    if (this.refreshing.has(repoRoot)) {
      this.refreshAgain.add(repoRoot);
      return;
    }
    const entry = this.subscribersByRepo.get(repoRoot);
    if (!entry || entry.callbacks.size === 0) return;
    this.refreshing.add(repoRoot);
    void this.doRefreshLoop(repoRoot);
  }

  private async doRefreshLoop(repoRoot: string): Promise<void> {
    try {
      do {
        this.refreshAgain.delete(repoRoot);
        const entry = this.subscribersByRepo.get(repoRoot);
        if (!entry || entry.callbacks.size === 0) return;
        // Use the stored repoRoot — never re-resolve under racing fs changes.
        const refreshed = await this.getGitInfoForRoot(repoRoot, {
          ...SUBSCRIBE_OPTIONS,
        });
        const info = this.deliverable(refreshed, repoRoot);
        const current = this.subscribersByRepo.get(repoRoot);
        if (!current || current.callbacks.size === 0) return;
        // [LAW:dataflow-not-control-flow] Membership is read at call time, not at snapshot time.
        for (const cb of [...current.callbacks]) {
          if (!current.callbacks.has(cb)) continue;
          this.safeInvoke(cb, info);
        }
      } while (this.refreshAgain.has(repoRoot));
    } finally {
      this.refreshing.delete(repoRoot);
      this.refreshAgain.delete(repoRoot);
    }
  }

  private safeInvoke(cb: SubscribeCallback, info: GitInfo | null): void {
    try {
      cb(info);
    } catch (e) {
      this.logger(
        "warn",
        `git subscriber threw: ${(e as Error).message ?? String(e)}`,
      );
    }
  }

  private dropEntry(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.watcher.release();
    this.entries.delete(key);
  }

  private evictIfNeeded(): void {
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.dropEntry(oldest);
      this.logger("info", `gitCache evict ${oldest}`);
    }
  }

  // [LAW:single-enforcer] The correctness backstop where fs.watch silently no-ops.
  private runSanityCheck(): void {
    const seen = new Map<string, MtimeSnapshot>();
    for (const entry of this.entries.values()) {
      let current = seen.get(entry.repoRoot);
      if (!current) {
        const gitDir = this.inner.resolveGitDir(entry.repoRoot);
        current = snapshotMtimes(gitDir);
        seen.set(entry.repoRoot, current);
      }
      if (mtimeChanged(entry.mtime, current)) {
        this.invalidateRepo(entry.repoRoot);
      }
    }
  }

  runSanityCheckNow(): void {
    this.runSanityCheck();
  }

  close(): void {
    if (this.sanityTimer) {
      clearInterval(this.sanityTimer);
      this.sanityTimer = null;
    }
    for (const entry of this.entries.values()) {
      entry.watcher.release();
    }
    this.entries.clear();
    for (const entry of this.subscribersByRepo.values()) {
      entry.callbacks.clear();
      entry.watcher.release();
    }
    this.subscribersByRepo.clear();
    // In-flight work resolves naturally; clearing the maps makes the next caller fresh.
    this.refreshing.clear();
    this.refreshAgain.clear();
    this.fetchInFlight.clear();
    this.prCache.clear();
    this.prFetchInFlight.clear();
    if (this.ownsWatchers) this.watchers.closeAll();
  }
}

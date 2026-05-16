import fs from "node:fs";
import path from "node:path";
import { GitService, type GitInfo } from "../../segments/git";
import { debug } from "../../utils/logger";
import { WatcherRegistry, type WatcherHandle } from "./watchers";

// [LAW:one-source-of-truth] One provider for git data in the daemon. The
// daemon is the sole owner; segments pull via getInfo() (per-render snapshot),
// var-system pushes via subscribe() (MobX-driven reactivity). Both surfaces
// share one cache (keyed by *effective git directory*), one watcher set per
// effective dir, and one launch category ("git"). Pre-kz8.3 there were three
// parallel fleets — see the ticket epic for the inventory that this file
// replaces.
//
// [LAW:one-source-of-truth] Cache key derives from `resolveEffectiveGitDir`,
// which returns the exact directory the shell-runner will run git in (taking
// `projectDir` and worktree-ness into account). Keying off only
// `findGitRoot(workingDir)` would cache repo B's data under repo A's key
// whenever `projectDir` overrides workingDir's repo — the bug Copilot caught
// on first review of kz8.3.
//
// [LAW:single-enforcer] subscribe() is the only reactive entrypoint. When a
// watcher fires (or the sanity-check mtime walk detects a missed event), the
// provider re-fetches the core snapshot once per gitDir and notifies every
// subscriber for that gitDir. No parallel poller, no parallel WatchManager.

const DEFAULT_TTL_MS = 30_000;
const DEFAULT_MAX_ENTRIES = 64;
const SANITY_INTERVAL_MS = 5 * 60_000;

// Options applied to subscribe()'s internal getInfo() call. var-system's six
// GitField values (branch, sha, dirty, ahead, behind, stash) all project from
// these flags — keep them in lockstep with the projection in
// src/var-system/sources.ts. Anything not asked for here is undefined on the
// snapshot delivered to subscribers, which makes the projection's missing-
// field paths reachable and tested.
const SUBSCRIBE_OPTIONS = {
  showSha: true,
  showStashCount: true,
} as const;

interface MtimeSnapshot {
  head: number;
  index: number;
}

interface GitCacheEntry {
  info: GitInfo;
  computedAt: number;
  mtime: MtimeSnapshot;
  watcher: WatcherHandle;
  // All entries for the same repoRoot share invalidation: one watcher fires →
  // every option-set entry for that repo is dropped.
  repoRoot: string;
}

type GitOptions = NonNullable<Parameters<GitService["getGitInfo"]>[1]>;

type SubscribeCallback = (info: GitInfo | null) => void;

interface RepoSubscribers {
  // The effective gitDir is the cache + watcher identity; subscribers
  // register with a working directory but we resolve to gitDir once at
  // subscribe-time and store both so the refresh path doesn't have to
  // re-resolve on every invalidation.
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

function snapshotMtimes(repoRoot: string): MtimeSnapshot {
  // Missing files → 0; comparison still detects changes (0 → number).
  const stat = (rel: string): number => {
    try {
      return fs.statSync(path.join(repoRoot, rel)).mtimeMs;
    } catch {
      return 0;
    }
  };
  return { head: stat(".git/HEAD"), index: stat(".git/index") };
}

function mtimeChanged(a: MtimeSnapshot, b: MtimeSnapshot): boolean {
  return a.head !== b.head || a.index !== b.index;
}

function watcherTargets(repoRoot: string) {
  return {
    files: [
      path.join(repoRoot, ".git/HEAD"),
      path.join(repoRoot, ".git/index"),
    ],
    dirs: [{ path: path.join(repoRoot, ".git/refs/heads") }],
  };
}

export class GitDataProvider extends GitService {
  private readonly entries = new Map<string, GitCacheEntry>();
  private readonly subscribersByRepo = new Map<string, RepoSubscribers>();
  // [LAW:single-enforcer] Coalesce concurrent cache misses on the same key.
  // Renders build lines in parallel (Promise.all in src/powerline.ts), so two
  // line-renders requesting the same git data can both observe the cache as
  // cold and would otherwise spawn duplicate `git` work — exactly the failure
  // mode the daemon is meant to eliminate. The first miss installs a promise
  // here; subsequent concurrent callers await the same promise and resolve in
  // lockstep.
  private readonly fetchInFlight = new Map<string, Promise<GitInfo | null>>();
  // [LAW:single-enforcer] Coalesce overlapping refreshes for the same repo.
  // `refreshing` holds the repoRoots whose refresh loop is currently
  // executing; `refreshAgain` is the trailing-edge flag: if a new
  // invalidation arrives while a refresh is in flight, we set this flag and
  // the loop will re-fetch once more before exiting. Without this,
  // back-to-back invalidations (rapid commits, rebase) would fan back out
  // into parallel `git status` calls — exactly the failure kz8.3 collapses.
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
  private sanityTimer: NodeJS.Timeout | null = null;

  constructor(
    opts: {
      ttlMs?: number;
      maxEntries?: number;
      inner?: GitService;
      watchers?: WatcherRegistry;
      sanityIntervalMs?: number;
    } = {},
  ) {
    super();
    this.inner = opts.inner ?? new GitService();
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
    if (opts.watchers) {
      this.watchers = opts.watchers;
      this.ownsWatchers = false;
    } else {
      this.watchers = new WatcherRegistry();
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
  ): Promise<GitInfo | null> {
    // [LAW:one-source-of-truth] Effective gitDir is the cache + watcher
    // identity. Resolving once here means inner.getGitInfo sees workingDir =
    // effectiveDir, projectDir = undefined: it lands on the same dir without
    // re-running its own resolution branches.
    const effectiveDir = await this.inner.resolveEffectiveGitDir(
      workingDir,
      projectDir,
    );
    if (!effectiveDir) return null;
    return this.getGitInfoForRoot(effectiveDir, options);
  }

  // Cache+fetch helper that *already knows* the effective gitDir. Subscribe
  // and refresh use this directly so they don't pay an extra resolution per
  // call (which on the refresh-loop hot path was an extra `git rev-parse`
  // per invalidation — finding from PR #8 review pass 2).
  private getGitInfoForRoot(
    repoRoot: string,
    options: GitOptions,
  ): Promise<GitInfo | null> {
    const key = `${repoRoot}|${optionsKey(options)}`;
    const now = Date.now();

    const existing = this.entries.get(key);
    if (existing && now - existing.computedAt < this.ttlMs) {
      this.entries.delete(key);
      this.entries.set(key, existing);
      this.hits++;
      return Promise.resolve(existing.info);
    }

    // Coalesce concurrent misses on the same key — see fetchInFlight comment.
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
  ): Promise<GitInfo | null> {
    this.misses++;
    const mtimeBefore = snapshotMtimes(repoRoot);
    // Pass repoRoot as workingDir, no projectDir: inner's gitDir resolution
    // lands on repoRoot via the sync isWorktree/isGitRepo checks — no extra
    // findGitRoot shell-out.
    const info = await this.inner.getGitInfo(repoRoot, options);
    if (!info) return null;

    // Drop any prior entry for this exact key before re-inserting (so we
    // release its watcher refcount cleanly).
    this.dropEntry(key);

    // Files/dirs inside .git that meaningfully change what we'd render.
    // Working-tree changes are picked up by `git status` itself the next time
    // the cache misses.
    const watcher = this.watchers.acquire(
      `git:${repoRoot}`,
      watcherTargets(repoRoot),
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
    return info;
  }

  // [LAW:dataflow-not-control-flow] Push surface for var-system. The callback
  // receives the current snapshot once (after the initial fetch completes)
  // and again after each invalidation — sharing the one cache + one watcher
  // already managed by getInfo(). Multiple subscribers for the same repoRoot
  // share one fetch; the resolved repoRoot is the unit of sharing, not the
  // workingDir.
  //
  // Initial delivery is asynchronous: subscribe() returns immediately, but
  // the callback fires *after* both gitDir resolution and the first fetch
  // settle (the fetch can include a `git status` shell-out on a cold cache).
  // It is **not** a same-tick or microtask delivery — consumers should not
  // rely on the box value changing before the next render scheduling tick.
  subscribe(workingDir: string, callback: SubscribeCallback): () => void {
    let unsubscribed = false;
    let attached: { repoRoot: string; entry: RepoSubscribers } | null = null;

    void (async () => {
      // Resolve once at subscribe time using the same logic the pull surface
      // uses. var-system's declareGit doesn't pass projectDir, but going
      // through resolveEffectiveGitDir keeps the cache-key derivation
      // identical for both surfaces — single source of truth.
      const repoRoot = await this.inner.resolveEffectiveGitDir(workingDir);
      if (unsubscribed) return;

      if (!repoRoot) {
        // Not in a git repo: deliver null once. No watcher, no follow-up —
        // when the path later becomes a repo, the existing daemon-lifecycle
        // invariants don't try to detect that, and neither did the prior
        // GitPoller. Subscribers handle null by applying their fallback chain.
        this.safeInvoke(callback, null);
        return;
      }

      let entry = this.subscribersByRepo.get(repoRoot);
      if (!entry) {
        const watcher = this.watchers.acquire(
          `git:${repoRoot}`,
          watcherTargets(repoRoot),
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

      // Initial fetch: routes through getGitInfoForRoot using the already-
      // resolved repoRoot — no second findGitRoot. Cache is shared with the
      // pull surface so concurrent segment renders see the same value.
      const initial = await this.getGitInfoForRoot(repoRoot, {
        ...SUBSCRIBE_OPTIONS,
      });
      if (unsubscribed) return;
      this.safeInvoke(callback, initial);
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

  // Public for tests + future stats endpoint. Drops every entry for repoRoot
  // and re-fetches for any active subscribers (the watcher fire path).
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
      debug(`gitCache invalidate ${repoRoot} dropped=${dropped}`);
    }
    this.refreshSubscribers(repoRoot);
  }

  // [LAW:single-enforcer] Refreshes for one repo are serialized. If invalidation
  // re-fires while the current refresh is awaiting `getGitInfo`, we set the
  // trailing-edge flag and the loop re-runs once more; back-to-back
  // invalidations collapse into at most two fetches, never N parallel ones.
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
        // Use the stored repoRoot — no findGitRoot per refresh, no chance of
        // re-resolving to a different value under racing fs changes.
        const info = await this.getGitInfoForRoot(repoRoot, {
          ...SUBSCRIBE_OPTIONS,
        });
        const current = this.subscribersByRepo.get(repoRoot);
        if (!current || current.callbacks.size === 0) return;
        // [LAW:dataflow-not-control-flow] Membership check at call time, not at
        // snapshot time. A subscriber that unsubscribed during the await above
        // (or during a prior cb invocation in this same iteration) must not
        // receive this notification — has() reads the current truth.
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
      debug(`git subscriber threw: ${(e as Error).message ?? String(e)}`);
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
      debug(`gitCache evict ${oldest}`);
    }
  }

  // [LAW:single-enforcer] Watchers are an optimization; this mtime walk is
  // the correctness backstop for filesystems where fs.watch silently no-ops
  // (network mounts, some FUSE volumes).
  private runSanityCheck(): void {
    const seen = new Map<string, MtimeSnapshot>();
    for (const entry of this.entries.values()) {
      let current = seen.get(entry.repoRoot);
      if (!current) {
        current = snapshotMtimes(entry.repoRoot);
        seen.set(entry.repoRoot, current);
      }
      if (mtimeChanged(entry.mtime, current)) {
        this.invalidateRepo(entry.repoRoot);
      }
    }
  }

  // Test hook: drive the sanity check synchronously.
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
    // In-flight refreshes will observe the empty subscribers map on their
    // next iteration and exit naturally; the flags are cleared so a fresh
    // provider with the same repoRoot starts clean. In-flight fetches still
    // resolve (we can't cancel a pending await on inner.getGitInfo) but the
    // map is cleared so the next caller starts a fresh fetch.
    this.refreshing.clear();
    this.refreshAgain.clear();
    this.fetchInFlight.clear();
    if (this.ownsWatchers) this.watchers.closeAll();
  }
}

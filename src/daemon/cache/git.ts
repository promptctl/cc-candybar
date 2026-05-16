import fs from "node:fs";
import path from "node:path";
import { GitService, type GitInfo } from "../../segments/git";
import { dlog } from "../log";
import { WatcherRegistry, type WatcherHandle } from "./watchers";

// [LAW:one-source-of-truth] One provider for git data in the daemon. The
// daemon is the sole owner; segments pull via getInfo() (per-render snapshot),
// var-system pushes via subscribe() (MobX-driven reactivity). Both surfaces
// share one cache (keyed by repoRoot), one watcher set per repo, and one
// launch category ("git"). Pre-kz8.3 there were three parallel fleets — see
// the ticket epic for the inventory that this file replaces.
//
// [LAW:single-enforcer] subscribe() is the only reactive entrypoint. When a
// watcher fires (or the sanity-check mtime walk detects a missed event), the
// provider re-fetches the core snapshot once per repo and notifies every
// subscriber for that repo. No parallel poller, no parallel WatchManager.

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
  // repoRoot is the cache key, but subscribers register with a working
  // directory; we resolve to repoRoot once at subscribe-time and store the
  // resolved working dir so the refresh fetch reuses it.
  workingDir: string;
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
    const repoRoot = await this.inner.findGitRoot(workingDir);
    if (!repoRoot) {
      return this.inner.getGitInfo(workingDir, options, projectDir);
    }

    const key = `${repoRoot}|${optionsKey(options)}`;
    const now = Date.now();

    const existing = this.entries.get(key);
    if (existing && now - existing.computedAt < this.ttlMs) {
      this.entries.delete(key);
      this.entries.set(key, existing);
      this.hits++;
      return existing.info;
    }

    this.misses++;
    const mtimeBefore = snapshotMtimes(repoRoot);
    const info = await this.inner.getGitInfo(workingDir, options, projectDir);
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
  // receives the current snapshot once (immediately after registration) and
  // again after each invalidation — sharing the one cache + one watcher
  // already managed by getInfo(). Multiple subscribers for the same repoRoot
  // share one fetch; the resolved repoRoot is the unit of sharing, not the
  // workingDir.
  //
  // The initial delivery is asynchronous (it has to be — repoRoot resolution
  // and the first git fetch are async). Subscribers see the first value on a
  // microtask after subscribe() returns.
  subscribe(workingDir: string, callback: SubscribeCallback): () => void {
    let unsubscribed = false;
    let attached: { repoRoot: string; entry: RepoSubscribers } | null = null;

    void (async () => {
      const repoRoot = await this.inner.findGitRoot(workingDir);
      if (unsubscribed) return;

      if (!repoRoot) {
        // Not in a git repo: deliver null once. No watcher, no follow-up —
        // when the path later becomes a repo, the existing daemon-lifecycle
        // invariants don't try to detect that, and neither did the prior
        // GitPoller. Subscribers handle null by applying their fallback chain.
        callback(null);
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
          callbacks: new Set<SubscribeCallback>(),
          watcher,
        };
        this.subscribersByRepo.set(repoRoot, entry);
      }
      entry.callbacks.add(callback);
      attached = { repoRoot, entry };

      // Initial fetch: routes through getGitInfo so the cache is populated
      // and any concurrent pull surface sees the same value.
      const initial = await this.getGitInfo(workingDir, {
        ...SUBSCRIBE_OPTIONS,
      });
      if (unsubscribed) return;
      callback(initial);
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
      try {
        dlog("info", `gitCache invalidate ${repoRoot} dropped=${dropped}`);
      } catch {}
    }
    this.refreshSubscribers(repoRoot);
  }

  private refreshSubscribers(repoRoot: string): void {
    const entry = this.subscribersByRepo.get(repoRoot);
    if (!entry || entry.callbacks.size === 0) return;
    // Snapshot callbacks at fire-time so a subscriber unsubscribing during
    // notification doesn't mutate the set we're iterating.
    const callbacks = [...entry.callbacks];
    const workingDir = entry.workingDir;
    void (async () => {
      const info = await this.getGitInfo(workingDir, { ...SUBSCRIBE_OPTIONS });
      for (const cb of callbacks) {
        try {
          cb(info);
        } catch (e) {
          try {
            dlog(
              "warn",
              `git subscriber threw: ${(e as Error).message ?? String(e)}`,
            );
          } catch {}
        }
      }
    })();
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
      try {
        dlog("info", `gitCache evict ${oldest}`);
      } catch {}
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
    if (this.ownsWatchers) this.watchers.closeAll();
  }
}

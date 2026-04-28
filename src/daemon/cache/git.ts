import fs from "node:fs";
import path from "node:path";
import { GitService, type GitInfo } from "../../segments/git";
import { dlog } from "../log";
import { WatcherRegistry, type WatcherHandle } from "./watchers";

// [LAW:one-source-of-truth] cache key is repoRoot, not cwd or sessionId. The
// whole point of the daemon is to collapse N sessions in the same repo into
// one git invocation; a cwd- or session-keyed cache would multiply work
// instead of sharing it.

const DEFAULT_TTL_MS = 30_000;
const DEFAULT_MAX_ENTRIES = 64;
const SANITY_INTERVAL_MS = 5 * 60_000;

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

function optionsKey(options: GitOptions): string {
  const keys = Object.keys(options).sort() as (keyof GitOptions)[];
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

export class CachedGitService extends GitService {
  private readonly entries = new Map<string, GitCacheEntry>();
  private hits = 0;
  private misses = 0;
  private invalidations = 0;
  private readonly inner: GitService;
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly watchers: WatcherRegistry;
  private readonly ownsWatchers: boolean;
  private sanityTimer: NodeJS.Timeout | null = null;

  constructor(opts: {
    ttlMs?: number;
    maxEntries?: number;
    inner?: GitService;
    watchers?: WatcherRegistry;
    sanityIntervalMs?: number;
  } = {}) {
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

    const watcher = this.watchers.acquire(repoRoot, () =>
      this.invalidateRepo(repoRoot),
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

  // Public for tests + future stats endpoint. Drops every entry for repoRoot.
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
    if (this.ownsWatchers) this.watchers.closeAll();
  }
}

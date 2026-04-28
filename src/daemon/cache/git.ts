import { GitService, type GitInfo } from "../../segments/git";
import { dlog } from "../log";

// [LAW:one-source-of-truth] cache key is repoRoot, not cwd or sessionId. The
// whole point of the daemon is to collapse N sessions in the same repo into
// one git invocation; a cwd- or session-keyed cache would multiply work
// instead of sharing it.

const DEFAULT_TTL_MS = 2_000;
const DEFAULT_MAX_ENTRIES = 64;

interface GitCacheEntry {
  info: GitInfo;
  computedAt: number;
}

type GitOptions = NonNullable<Parameters<GitService["getGitInfo"]>[1]>;

function optionsKey(options: GitOptions): string {
  const keys = Object.keys(options).sort() as (keyof GitOptions)[];
  const normalized: Record<string, unknown> = {};
  for (const k of keys) normalized[k as string] = options[k];
  return JSON.stringify(normalized);
}

// CachedGitService wraps an inner GitService. Composition (rather than
// subclassing) keeps the cache testable without instantiating a real git-
// invoking service, and lets future variants (mock, remote, etc.) plug in.
export class CachedGitService extends GitService {
  private readonly entries = new Map<string, GitCacheEntry>();
  private hits = 0;
  private misses = 0;
  private readonly inner: GitService;
  private readonly ttlMs: number;
  private readonly maxEntries: number;

  constructor(opts: {
    ttlMs?: number;
    maxEntries?: number;
    inner?: GitService;
  } = {}) {
    super();
    this.inner = opts.inner ?? new GitService();
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  getStats(): { size: number; hits: number; misses: number } {
    return { size: this.entries.size, hits: this.hits, misses: this.misses };
  }

  override async getGitInfo(
    workingDir: string,
    options: GitOptions = {},
    projectDir?: string,
  ): Promise<GitInfo | null> {
    const repoRoot = await this.inner.findGitRoot(workingDir);
    if (!repoRoot) {
      // Not in a repo — nothing to cache. Underlying call will return null
      // for the same reason.
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
    const info = await this.inner.getGitInfo(workingDir, options, projectDir);
    if (!info) return null;

    this.entries.set(key, { info, computedAt: now });
    this.evictIfNeeded();
    return info;
  }

  private evictIfNeeded(): void {
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
      try {
        dlog("info", `gitCache evict ${oldest}`);
      } catch {
        // Tests instantiate this outside a daemon process; dlog may fail.
      }
    }
  }
}

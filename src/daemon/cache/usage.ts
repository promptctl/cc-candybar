import fs from "node:fs";
import { UsageProvider, type UsageInfo } from "../../segments";
import type { ClaudeHookData } from "../../utils/claude";
import { dlog } from "../log";

// [LAW:one-source-of-truth] cache key is sessionId. Each session has its own
// transcript file; cross-session aggregation belongs in the disk cache layer
// (src/utils/cache.ts), not here.

const DEFAULT_MAX_ENTRIES = 256;
const DEFAULT_STALE_AGE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

interface UsageCacheEntry {
  info: UsageInfo;
  transcriptMtime: number;
  transcriptPath: string | undefined;
  lastSeenAt: number;
}

function statMtimeMs(filePath: string | undefined): number {
  if (!filePath) return 0;
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

export class CachedUsageProvider extends UsageProvider {
  private readonly entries = new Map<string, UsageCacheEntry>();
  private readonly maxEntries: number;
  private readonly staleAgeMs: number;
  private hits = 0;
  private misses = 0;
  private sweeps = 0;
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(opts: {
    maxEntries?: number;
    staleAgeMs?: number;
    sweepIntervalMs?: number;
  } = {}) {
    super();
    this.maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.staleAgeMs = opts.staleAgeMs ?? DEFAULT_STALE_AGE_MS;
    const interval = opts.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    if (interval > 0) {
      this.sweepTimer = setInterval(() => this.sweepStale(), interval);
      this.sweepTimer.unref();
    }
  }

  getStats(): {
    size: number;
    hits: number;
    misses: number;
    sweeps: number;
  } {
    return {
      size: this.entries.size,
      hits: this.hits,
      misses: this.misses,
      sweeps: this.sweeps,
    };
  }

  override async getUsageInfo(
    sessionId: string,
    hookData?: ClaudeHookData,
  ): Promise<UsageInfo> {
    if (!sessionId) {
      // No identity → can't cache. Delegate.
      return super.getUsageInfo(sessionId, hookData);
    }

    const transcriptPath = hookData?.transcript_path;
    const currentMtime = statMtimeMs(transcriptPath);
    const now = Date.now();

    const existing = this.entries.get(sessionId);
    if (
      existing &&
      currentMtime !== 0 &&
      existing.transcriptMtime === currentMtime
    ) {
      existing.lastSeenAt = now;
      // LRU bump.
      this.entries.delete(sessionId);
      this.entries.set(sessionId, existing);
      this.hits++;
      return existing.info;
    }

    this.misses++;
    const info = await super.getUsageInfo(sessionId, hookData);

    // Re-stat after compute to capture any in-flight transcript writes; using
    // the post-compute mtime guarantees the next request that finds the same
    // mtime can safely return this cached info.
    const postMtime = statMtimeMs(transcriptPath);
    this.entries.set(sessionId, {
      info,
      transcriptMtime: postMtime,
      transcriptPath,
      lastSeenAt: now,
    });
    this.evictIfNeeded();
    return info;
  }

  // Public for tests; called periodically from the timer.
  sweepStale(): number {
    const now = Date.now();
    let dropped = 0;
    for (const [sid, entry] of this.entries) {
      if (now - entry.lastSeenAt > this.staleAgeMs) {
        this.entries.delete(sid);
        dropped++;
      }
    }
    if (dropped > 0) {
      this.sweeps++;
      try {
        dlog("info", `usageCache sweep dropped=${dropped}`);
      } catch {}
    }
    return dropped;
  }

  private evictIfNeeded(): void {
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
      try {
        dlog("info", `usageCache evict ${oldest}`);
      } catch {}
    }
  }

  close(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    this.entries.clear();
  }
}

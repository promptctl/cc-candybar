import fs from "node:fs";
import path from "node:path";
import { dlog } from "../log";

// [LAW:single-enforcer] One registry owns *all* fs watchers for git
// invalidation. Scattered watchers across modules would leak FDs and miss
// cleanup at shutdown.

const DEBOUNCE_MS = 50;
const DEFAULT_MAX_WATCHERS = 128;

// Files inside .git that meaningfully change what we'd render. Working-tree
// changes are picked up by `git status` itself the next time the cache misses.
const WATCH_TARGETS_FILE: readonly string[] = [".git/HEAD", ".git/index"];
const WATCH_TARGETS_DIR: readonly string[] = [".git/refs/heads"];

interface WatcherSlot {
  repoRoot: string;
  watchers: fs.FSWatcher[];
  refcount: number;
  debounceTimer: NodeJS.Timeout | null;
  onInvalidate: () => void;
  // Last-seen accessed-at, so LRU eviction picks the staler one.
  lastTouched: number;
}

export interface WatcherHandle {
  release(): void;
}

export interface WatcherCounters {
  watchersOpened: number;
  watchersClosed: number;
  watchersEvicted: number;
}

export class WatcherRegistry {
  private readonly slots = new Map<string, WatcherSlot>();
  private readonly maxWatchers: number;
  private readonly counters?: WatcherCounters;
  private closed = false;

  constructor(opts: {
    maxWatchers?: number;
    counters?: WatcherCounters;
  } = {}) {
    this.maxWatchers = opts.maxWatchers ?? DEFAULT_MAX_WATCHERS;
    this.counters = opts.counters;
  }

  // Acquire (or share) a watcher for `repoRoot`. Multiple acquires share a
  // single underlying FSWatcher set; refcount tracks active consumers.
  // Subsequent acquires *replace* onInvalidate so the latest consumer's
  // callback is the one that fires — by design, callers funnel into a single
  // cache module whose callback is a stable closure over the cache map.
  acquire(repoRoot: string, onInvalidate: () => void): WatcherHandle {
    if (this.closed) {
      // Registry already shut down; return a no-op handle so callers don't
      // crash mid-shutdown.
      return { release: () => {} };
    }

    const existing = this.slots.get(repoRoot);
    if (existing) {
      existing.refcount++;
      existing.onInvalidate = onInvalidate;
      existing.lastTouched = Date.now();
      // LRU bump.
      this.slots.delete(repoRoot);
      this.slots.set(repoRoot, existing);
      return this.makeHandle(repoRoot);
    }

    const slot: WatcherSlot = {
      repoRoot,
      watchers: [],
      refcount: 1,
      debounceTimer: null,
      onInvalidate,
      lastTouched: Date.now(),
    };
    this.openWatchers(slot);
    this.slots.set(repoRoot, slot);
    if (this.counters) this.counters.watchersOpened++;
    this.evictIfNeeded();
    return this.makeHandle(repoRoot);
  }

  private makeHandle(repoRoot: string): WatcherHandle {
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        const slot = this.slots.get(repoRoot);
        if (!slot) return;
        slot.refcount = Math.max(0, slot.refcount - 1);
        if (slot.refcount === 0) {
          this.closeSlot(slot);
          this.slots.delete(repoRoot);
        }
      },
    };
  }

  private openWatchers(slot: WatcherSlot): void {
    const fire = () => {
      if (slot.debounceTimer) return; // already pending
      slot.debounceTimer = setTimeout(() => {
        slot.debounceTimer = null;
        try {
          slot.onInvalidate();
        } catch (e) {
          dlog("warn", `watcher invalidate threw: ${(e as Error).message}`);
        }
      }, DEBOUNCE_MS);
      slot.debounceTimer.unref();
    };

    for (const rel of WATCH_TARGETS_FILE) {
      const target = path.join(slot.repoRoot, rel);
      try {
        const w = fs.watch(target, { persistent: false }, fire);
        w.on("error", (e) => {
          dlog("warn", `watcher error ${target}: ${e.message}`);
        });
        slot.watchers.push(w);
      } catch (e) {
        dlog("warn", `watch failed ${target}: ${(e as Error).message}`);
      }
    }

    for (const rel of WATCH_TARGETS_DIR) {
      const target = path.join(slot.repoRoot, rel);
      try {
        const w = fs.watch(target, { persistent: false }, fire);
        w.on("error", (e) => {
          dlog("warn", `watcher error ${target}: ${e.message}`);
        });
        slot.watchers.push(w);
      } catch (e) {
        dlog("warn", `watch failed ${target}: ${(e as Error).message}`);
      }
    }
  }

  private closeSlot(slot: WatcherSlot): void {
    if (slot.debounceTimer) {
      clearTimeout(slot.debounceTimer);
      slot.debounceTimer = null;
    }
    for (const w of slot.watchers) {
      try {
        w.close();
      } catch {}
    }
    slot.watchers = [];
    if (this.counters) this.counters.watchersClosed++;
  }

  private evictIfNeeded(): void {
    while (this.slots.size > this.maxWatchers) {
      // Map iteration order = insertion order = LRU order (we re-insert on
      // access).
      const oldest = this.slots.keys().next().value;
      if (oldest === undefined) break;
      const slot = this.slots.get(oldest)!;
      this.closeSlot(slot);
      this.slots.delete(oldest);
      if (this.counters) this.counters.watchersEvicted++;
      // Force the consumer to drop their entry too — without this the cache
      // would keep stale data with no watcher behind it.
      try {
        slot.onInvalidate();
      } catch {}
      dlog("info", `watcher LRU evict ${oldest}`);
    }
  }

  size(): number {
    return this.slots.size;
  }

  closeAll(): void {
    this.closed = true;
    for (const slot of this.slots.values()) {
      this.closeSlot(slot);
    }
    this.slots.clear();
  }
}

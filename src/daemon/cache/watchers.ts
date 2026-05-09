import fs from "node:fs";
import { dlog } from "../log";

// [LAW:single-enforcer] One registry owns *all* fs watchers for any consumer
// (git cache, config cache, ...). Scattered watchers across modules would leak
// FDs and miss cleanup at shutdown.

const DEBOUNCE_MS = 50;
const DEFAULT_MAX_WATCHERS = 128;

// Absolute filesystem paths the consumer wants invalidation for.
// `files`: regular files (existence required to watch).
// `dirs`: directories. Each may optionally restrict which child filenames
//   should fire — without a filter every change in the dir fires (legacy
//   git-refs behavior); with a filter only matching basenames fire (config
//   case: avoids noise from sibling files in ~/.claude/).
export interface DirTarget {
  path: string;
  // If set, only fire when fs.watch reports a filename in this list.
  // Filenames are basenames (not paths) — that's what fs.watch supplies.
  filenames?: readonly string[];
}

export interface WatchTargets {
  files: readonly string[];
  dirs: readonly DirTarget[];
}

interface WatcherSlot {
  key: string;
  watchers: fs.FSWatcher[];
  refcount: number;
  debounceTimer: NodeJS.Timeout | null;
  onInvalidate: () => void;
  targets: WatchTargets;
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

  constructor(
    opts: {
      maxWatchers?: number;
      counters?: WatcherCounters;
    } = {},
  ) {
    this.maxWatchers = opts.maxWatchers ?? DEFAULT_MAX_WATCHERS;
    this.counters = opts.counters;
  }

  // Acquire (or share) a watcher set keyed by `key`. Multiple acquires on the
  // same key share a single underlying FSWatcher set; refcount tracks active
  // consumers. Subsequent acquires *replace* onInvalidate so the latest
  // consumer's callback is the one that fires — by design, callers funnel into
  // a single cache module whose callback is a stable closure over the cache map.
  // `targets` from the first acquire wins; subsequent acquires keep the
  // original target set (consumers must use a fresh key if they need different
  // targets).
  acquire(
    key: string,
    targets: WatchTargets,
    onInvalidate: () => void,
  ): WatcherHandle {
    if (this.closed) {
      // Registry already shut down; return a no-op handle so callers don't
      // crash mid-shutdown.
      return { release: () => {} };
    }

    const existing = this.slots.get(key);
    if (existing) {
      existing.refcount++;
      existing.onInvalidate = onInvalidate;
      existing.lastTouched = Date.now();
      // LRU bump.
      this.slots.delete(key);
      this.slots.set(key, existing);
      return this.makeHandle(key);
    }

    const slot: WatcherSlot = {
      key,
      watchers: [],
      refcount: 1,
      debounceTimer: null,
      onInvalidate,
      targets,
      lastTouched: Date.now(),
    };
    this.openWatchers(slot);
    this.slots.set(key, slot);
    if (this.counters) this.counters.watchersOpened++;
    this.evictIfNeeded();
    return this.makeHandle(key);
  }

  private makeHandle(key: string): WatcherHandle {
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        const slot = this.slots.get(key);
        if (!slot) return;
        slot.refcount = Math.max(0, slot.refcount - 1);
        if (slot.refcount === 0) {
          this.closeSlot(slot);
          this.slots.delete(key);
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

    for (const target of slot.targets.files) {
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

    for (const target of slot.targets.dirs) {
      try {
        const filterSet = target.filenames ? new Set(target.filenames) : null;
        const onDirEvent = (_evt: string, filename: string | null) => {
          // [LAW:dataflow-not-control-flow] Filter is a value (Set) — same
          // code path every event; the Set's .has() decides whether to fire.
          if (filterSet && (!filename || !filterSet.has(filename))) return;
          fire();
        };
        const w = fs.watch(target.path, { persistent: false }, onDirEvent);
        w.on("error", (e) => {
          dlog("warn", `watcher error ${target.path}: ${e.message}`);
        });
        slot.watchers.push(w);
      } catch (e) {
        dlog("warn", `watch failed ${target.path}: ${(e as Error).message}`);
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

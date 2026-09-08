import fs from "node:fs";
import { debug } from "../../utils/logger";

// [LAW:no-defensive-null-guards] Always non-null; injection replaces the implementation, never adds a "no logger" mode.
export type WatcherLogger = (
  level: "info" | "warn" | "error",
  message: string,
) => void;

const defaultLogger: WatcherLogger = (_level, message) => debug(message);

// [LAW:one-source-of-truth] The debounce floor consumers derive from; restating 50 would drift.
export const DEBOUNCE_MS = 50;
const DEFAULT_MAX_WATCHERS = 128;

// A dir target with no filter fires on every change in it; with one, only matching basenames.
export interface DirTarget {
  path: string;
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
  private readonly logger: WatcherLogger;
  private closed = false;

  constructor(
    opts: {
      maxWatchers?: number;
      counters?: WatcherCounters;
      logger?: WatcherLogger;
    } = {},
  ) {
    this.maxWatchers = opts.maxWatchers ?? DEFAULT_MAX_WATCHERS;
    this.counters = opts.counters;
    this.logger = opts.logger ?? defaultLogger;
  }

  // Acquires share one FSWatcher set by key: the latest onInvalidate wins, and the FIRST
  // acquire's targets win (a different target set needs a fresh key).
  acquire(
    key: string,
    targets: WatchTargets,
    onInvalidate: () => void,
  ): WatcherHandle {
    if (this.closed) {
      return { release: () => {} };
    }

    const existing = this.slots.get(key);
    if (existing) {
      existing.refcount++;
      existing.onInvalidate = onInvalidate;
      existing.lastTouched = Date.now();
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
          this.logger(
            "warn",
            `watcher invalidate threw: ${(e as Error).message}`,
          );
        }
      }, DEBOUNCE_MS);
      slot.debounceTimer.unref();
    };

    for (const target of slot.targets.files) {
      try {
        const w = fs.watch(target, { persistent: false }, fire);
        w.on("error", (e) => {
          this.logger("warn", `watcher error ${target}: ${e.message}`);
        });
        slot.watchers.push(w);
      } catch (e) {
        this.logger("warn", `watch failed ${target}: ${(e as Error).message}`);
      }
    }

    for (const target of slot.targets.dirs) {
      try {
        const filterSet = target.filenames ? new Set(target.filenames) : null;
        const onDirEvent = (_evt: string, filename: string | null) => {
          // [LAW:dataflow-not-control-flow] The filter is a value; one code path per event.
          if (filterSet && (!filename || !filterSet.has(filename))) return;
          fire();
        };
        const w = fs.watch(target.path, { persistent: false }, onDirEvent);
        w.on("error", (e) => {
          this.logger("warn", `watcher error ${target.path}: ${e.message}`);
        });
        slot.watchers.push(w);
      } catch (e) {
        this.logger(
          "warn",
          `watch failed ${target.path}: ${(e as Error).message}`,
        );
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
      const oldest = this.slots.keys().next().value;
      if (oldest === undefined) break;
      const slot = this.slots.get(oldest)!;
      this.closeSlot(slot);
      this.slots.delete(oldest);
      if (this.counters) this.counters.watchersEvicted++;
      // Force the consumer to drop its entry: no watcher is behind it any more.
      try {
        slot.onInvalidate();
      } catch {}
      this.logger("info", `watcher LRU evict ${oldest}`);
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

import fs from "node:fs";
import { debug } from "../../utils/logger";

// Logger callable used for watcher lifecycle / failure events. Daemon
// injects `dlog` (writes to daemon.log at the requested level); other
// consumers (var-system tests, demo) take the default which routes
// through `debug` — present-but-quiet unless CC_CANDYBAR_DEBUG is set.
// [LAW:no-defensive-null-guards] Default is always non-null; injection
// replaces the implementation, never adds a "no logger" mode.
export type WatcherLogger = (
  level: "info" | "warn" | "error",
  message: string,
) => void;

const defaultLogger: WatcherLogger = (_level, message) => debug(message);

// [LAW:single-enforcer] One registry owns *all* fs watchers for any consumer
// (git cache, config cache, ...). Scattered watchers across modules would leak
// FDs and miss cleanup at shutdown.
//
// [LAW:single-enforcer] It shares and refcounts; it bounds nothing. Each
// consumer bounds what it holds (the git cache's entries, the render cache's
// MAX_ENTRIES), so a slot
// closes only when its last holder releases it — never under a holder that
// still holds it (brandon-unfiled-3248.576q: an LRU cap here closed watches
// whose holders kept handles to nothing).
//
// Opening or closing a DIRECTORY watch is not free on macOS: libuv ≤ 1.53.0
// rebuilds its one FSEvents stream and leaks a CFString per watched directory
// each time (fixed upstream in libuv 9ac5b3cee0). Hold a watch for as long as
// its target matters, not for as long as one value derived from it.

// [LAW:one-source-of-truth] Exported: the invalidation-debounce floor is the
// single source consumers derive from (e.g. the load harness's git-churn
// interval must sit above it). Restating "50" anywhere else would let the two
// drift silently.
export const DEBOUNCE_MS = 50;

// Absolute directories the consumer wants invalidation for. A directory is
// watched one level deep, optionally restricted to the child basenames that
// should fire (config case: avoids noise from sibling files in ~/.claude/), or
// as a whole tree (git's refs: a branch name's slashes are directories).
//
// [LAW:types-are-the-program] A file is watched through its directory, by
// name, never by its own inode: a watch on the file binds the inode it finds,
// and a write-then-rename (the safe way to rewrite a file, and `writeAtomic`'s
// way) replaces that inode, leaving the watch deaf with no event to say so. A
// directory watch reports a child's in-place write and its rename alike, so
// the contract offers nothing a consumer could go deaf on.
//
// [LAW:types-are-the-program] A tree watch reports paths relative to its
// root, so a basename filter has nothing to match against; the two shapes are
// discriminated on `recursive` so a filtered tree cannot be asked for.
export type DirTarget =
  | {
      path: string;
      // If set, only fire when fs.watch reports a filename in this list.
      // Filenames are basenames (not paths) — that's what fs.watch supplies.
      filenames?: readonly string[];
      recursive?: false;
    }
  | { path: string; recursive: true; filenames?: never };

export interface WatchTargets {
  dirs: readonly DirTarget[];
}

// [LAW:types-are-the-program] What one debounce window of a slot's watches
// says: the basenames that fired (`changed`), or that the OS named none of
// them (`unknown`), or that a watch reported an error after it opened
// (`failed`). One window folds into one value, the strongest of what it saw.
export type Invalidation =
  | { readonly kind: "changed"; readonly names: ReadonlySet<string> }
  | { readonly kind: "unknown" }
  | { readonly kind: "failed"; readonly reason: string };

// A target the OS refused to watch, and why.
export interface Refusal {
  readonly path: string;
  readonly reason: string;
}

interface WatcherSlot {
  key: string;
  watchers: fs.FSWatcher[];
  refcount: number;
  // The debounce window open now, and what it has seen so far.
  debounce: { readonly timer: NodeJS.Timeout; window: Invalidation } | null;
  onInvalidate: (invalidation: Invalidation) => void;
  targets: WatchTargets;
  refused: readonly Refusal[];
}

// [LAW:no-silent-failure] A handle says which of its targets the OS refused,
// so a consumer whose only refresh is the watch can show the fault.
export interface WatcherHandle {
  release(): void;
  readonly refused: readonly Refusal[];
}

// What a consumer asks to watch, under the key naming it. [LAW:one-source-of-truth]
// The registry keeps the FIRST acquire's targets under a key, so the key must
// name the target set: a different set is a different key, and "the targets
// moved" and "the key changed" are one fact.
export interface WatchSpec {
  readonly key: string;
  readonly targets: WatchTargets;
}

// A watch a consumer holds: the handle and the key it was acquired under.
export interface HeldWatch {
  readonly key: string;
  readonly handle: WatcherHandle;
}

// What following a spec did to a held watch: kept it, or released it and
// acquired the spec's.
export type WatchMove = "kept" | "rebound";

// `watchersOpened` counts slots whose every target opened, `watchRefusals`
// slots with a target refused, and `watchErrors` errors watches reported after
// they opened — so a refused or failed watch is never counted as a working
// one. `watchersClosed` counts every slot released, refused or not, so the
// slots held now are opened plus refusals less closed.
export interface WatcherCounters {
  watchersOpened: number;
  watchersClosed: number;
  watchRefusals: number;
  watchErrors: number;
}

// The window's fold: a failure outranks everything, an unnamed event outranks
// names, and names gather.
function folded(window: Invalidation, next: Invalidation): Invalidation {
  if (next.kind === "failed") return next;
  if (window.kind !== "changed") return window;
  if (next.kind === "unknown") return next;
  return { kind: "changed", names: new Set([...window.names, ...next.names]) };
}

const namedOf = (filename: string | null): Invalidation =>
  filename === null
    ? { kind: "unknown" }
    : { kind: "changed", names: new Set([filename]) };

export class WatcherRegistry {
  private readonly slots = new Map<string, WatcherSlot>();
  private readonly counters?: WatcherCounters;
  private readonly logger: WatcherLogger;
  private closed = false;

  constructor(
    opts: {
      counters?: WatcherCounters;
      // [LAW:single-enforcer] One injection point per consumer. The daemon
      // passes `dlog` so watcher-failure events land in daemon.log; non-
      // daemon consumers keep the default debug-routed logger and never
      // touch daemon log files.
      logger?: WatcherLogger;
    } = {},
  ) {
    this.counters = opts.counters;
    this.logger = opts.logger ?? defaultLogger;
  }

  // Acquire (or share) a watcher set keyed by `key`. Multiple acquires on the
  // same key share a single underlying FSWatcher set; refcount tracks active
  // consumers. Subsequent acquires *replace* onInvalidate so the latest
  // consumer's callback is the one that fires — by design, callers funnel into
  // a single cache module whose callback is a stable closure over the cache map.
  // `targets` from the first acquire wins; subsequent acquires keep the
  // original target set (consumers must use a fresh key if they need different
  // targets). A consumer that needs no more than "something changed" ignores
  // the invalidation's value.
  acquire(
    key: string,
    targets: WatchTargets,
    onInvalidate: (invalidation: Invalidation) => void,
  ): WatcherHandle {
    if (this.closed) {
      // Registry already shut down: nothing is watched, and the handle says
      // so; releasing it is a no-op, so callers don't crash mid-shutdown.
      return {
        release: () => {},
        refused: targets.dirs.map((d) => ({
          path: d.path,
          reason: "the watcher registry is closed",
        })),
      };
    }

    const existing = this.slots.get(key);
    if (existing) {
      existing.refcount++;
      existing.onInvalidate = onInvalidate;
      return this.makeHandle(existing);
    }

    const slot: WatcherSlot = {
      key,
      watchers: [],
      refcount: 1,
      debounce: null,
      onInvalidate,
      targets,
      refused: [],
    };
    this.openWatchers(slot);
    this.slots.set(key, slot);
    if (this.counters) {
      if (slot.refused.length === 0) this.counters.watchersOpened++;
      else this.counters.watchRefusals++;
    }
    return this.makeHandle(slot);
  }

  // [LAW:single-enforcer] The one rule for a watch whose targets can move: a
  // consumer derives its spec from disk again and the held watch follows it
  // exactly when the key differs. The same key is the same directories, kept;
  // a new key releases the watch bound to directories the spec no longer
  // names and acquires one on those it names now. Nothing held yet is a first
  // acquire, which is a rebind from nothing.
  follow(
    held: HeldWatch | null,
    spec: WatchSpec,
    onInvalidate: (invalidation: Invalidation) => void,
  ): { readonly watch: HeldWatch; readonly move: WatchMove } {
    if (held !== null && held.key === spec.key) {
      return { watch: held, move: "kept" };
    }
    held?.handle.release();
    return {
      watch: {
        key: spec.key,
        handle: this.acquire(spec.key, spec.targets, onInvalidate),
      },
      move: "rebound",
    };
  }

  private makeHandle(slot: WatcherSlot): WatcherHandle {
    let released = false;
    return {
      refused: slot.refused,
      release: () => {
        if (released) return;
        released = true;
        if (this.slots.get(slot.key) !== slot) return;
        slot.refcount = Math.max(0, slot.refcount - 1);
        if (slot.refcount === 0) {
          this.closeSlot(slot);
          this.slots.delete(slot.key);
        }
      },
    };
  }

  private openWatchers(slot: WatcherSlot): void {
    const fire = (invalidation: Invalidation) => {
      if (slot.debounce !== null) {
        slot.debounce.window = folded(slot.debounce.window, invalidation);
        return;
      }
      const debounce = {
        window: invalidation,
        timer: setTimeout(() => {
          slot.debounce = null;
          try {
            slot.onInvalidate(debounce.window);
          } catch (e) {
            this.logger(
              "warn",
              `watcher invalidate threw: ${(e as Error).message}`,
            );
          }
        }, DEBOUNCE_MS),
      };
      debounce.timer.unref();
      slot.debounce = debounce;
    };
    // [LAW:no-silent-failure] An error after open reaches the consumer and the
    // stats, not only the log: the watch behind it may deliver nothing more.
    const failedAt = (target: string) => (e: Error) => {
      this.logger("warn", `watcher error ${target}: ${e.message}`);
      if (this.counters) this.counters.watchErrors++;
      fire({ kind: "failed", reason: `${target}: ${e.message}` });
    };
    const refused: Refusal[] = [];
    const refuse = (target: string, e: unknown) => {
      const reason = (e as Error).message;
      this.logger("warn", `watch failed ${target}: ${reason}`);
      refused.push({ path: target, reason });
    };

    for (const target of slot.targets.dirs) {
      try {
        const filterSet = target.filenames ? new Set(target.filenames) : null;
        const onDirEvent = (_evt: string, filename: string | null) => {
          // [LAW:dataflow-not-control-flow] Filter is a value (Set) — same
          // code path every event; the Set's .has() decides whether to fire.
          if (filterSet && (!filename || !filterSet.has(filename))) return;
          fire(namedOf(filename));
        };
        const w = fs.watch(
          target.path,
          { persistent: false, recursive: target.recursive === true },
          onDirEvent,
        );
        w.on("error", failedAt(target.path));
        slot.watchers.push(w);
      } catch (e) {
        refuse(target.path, e);
      }
    }
    slot.refused = refused;
  }

  private closeSlot(slot: WatcherSlot): void {
    if (slot.debounce !== null) {
      clearTimeout(slot.debounce.timer);
      slot.debounce = null;
    }
    for (const w of slot.watchers) {
      try {
        w.close();
      } catch {}
    }
    slot.watchers = [];
    if (this.counters) this.counters.watchersClosed++;
  }

  size(): number {
    return this.slots.size;
  }

  // Every directory a held watch targets.
  watchedDirs(): string[] {
    return [...this.slots.values()].flatMap((slot) =>
      slot.targets.dirs.map((d) => d.path),
    );
  }

  closeAll(): void {
    this.closed = true;
    for (const slot of this.slots.values()) {
      this.closeSlot(slot);
    }
    this.slots.clear();
  }
}

import fs from "node:fs";
import path from "node:path";
import { debug } from "../../utils/logger";
import { valueOf } from "../../utils/logfmt";
import { walkLinks } from "../../utils/atomic-write";
import { bindsFolder, boundKey, boundOf } from "../../utils/folder-identity";
import {
  canonicalDirectory,
  nearestWatchTarget,
} from "../../utils/watch-target";

// Logger callable used for watcher lifecycle / failure events. Daemon
// injects its log (writes to daemon.log at the requested level); other
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
// (git cache, config cache, `watch_file` sources, ...). Scattered watchers
// across modules would leak FDs and miss cleanup at shutdown.
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
// says: the paths that fired, each the watched directory joined with the name
// the OS reported (`changed`), or that the OS named none of them (`unknown`),
// or that a watch reported an error after it opened (`failed`). Paths, not
// names: a slot watches many directories, and two of them can hold a child of
// the same name. One window folds into one value, the strongest of what it saw.
export type Invalidation =
  | { readonly kind: "changed"; readonly paths: ReadonlySet<string> }
  | { readonly kind: "unknown" }
  | { readonly kind: "failed"; readonly reason: string };

// A target the OS refused to watch, and why.
export interface Refusal {
  readonly path: string;
  readonly reason: string;
}

// What watching a set of paths takes: a spec whose key spells the targets and
// the folder each binds now (`bound`, by path: `null` while there is nothing
// there to bind), whether every hop reached its own directory (`reached`: none
// waits on a missing directory to appear, so an event can be about the path
// itself), and the paths whose link chain the kernel stopped walking, with
// why.
export interface PathsWatch extends WatchSpec {
  readonly bound: ReadonlyMap<string, string | null>;
  readonly reached: boolean;
  readonly unresolved: readonly Refusal[];
}

// [LAW:single-enforcer] The one rule for where a set of paths can change, for
// every consumer that watches files (the config watcher, `watch_file`
// sources). A `named` path is watched wherever its content changes: each hop
// of its link chain (`walkLinks`), by name in its nearest existing directory,
// so re-pointing any link in the chain is heard where that link sits. A
// `whole` path that is a directory is watched for every child, which
// overrides any name filter on it; one that is not adds nothing. Directories
// are deduped with their names unioned, and the set is sorted so equal sets
// spell equal keys. Nothing here throws: it runs inside watcher callbacks.
export function watchTargetsOf(paths: {
  readonly named: readonly string[];
  readonly whole: readonly string[];
}): PathsWatch {
  const unresolved: Refusal[] = [];
  let reached = true;
  // [LAW:types-are-the-program] A directory watched for named children, or
  // for every child (`null`).
  const byDir = new Map<string, Set<string> | null>();
  for (const at of paths.named) {
    const { hops, stopped } = walkLinks(at);
    if (stopped !== null)
      unresolved.push({ path: at, reason: stopped.message });
    for (const hop of hops) {
      const { dir, name, leaf } = nearestWatchTarget(hop);
      reached &&= leaf;
      const names = byDir.has(dir) ? byDir.get(dir)! : new Set<string>();
      names?.add(name);
      byDir.set(dir, names);
    }
  }
  for (const dir of paths.whole.map(canonicalDirectory))
    if (dir !== null) byDir.set(dir, null);
  const targets: WatchTargets = {
    dirs: [...byDir.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([dirPath, names]) =>
        names === null
          ? { path: dirPath }
          : { path: dirPath, filenames: [...names].sort() },
      ),
  };
  // [LAW:one-source-of-truth] The folder identity every watch owner judges
  // by, read once here for every consumer of the rule.
  const bound = new Map(
    targets.dirs.map((d) => {
      const at = boundOf(d.path);
      return [d.path, bindsFolder(at) ? boundKey(at) : null] as const;
    }),
  );
  return {
    key: JSON.stringify([targets, [...bound]]),
    targets,
    unbound: [...bound.values()].includes(null),
    bound,
    reached,
    unresolved,
  };
}

// A watch as a consumer holds it: where its paths can change, as last derived
// from disk, and the watch the registry holds for it (the one bound before,
// while a directory the derive names is briefly gone).
export interface BoundWatch {
  readonly derived: PathsWatch;
  readonly held: HeldWatch;
}

// [LAW:single-enforcer] Why a watch may be missing changes, for every
// consumer that shows it: each path whose link chain it could not walk, and
// each directory the OS is not listening to (read live from the handle), and
// `beyond`, a reason the watch cannot know of itself. `null` while it hears
// every place its paths can change.
export function watchFault(
  label: string,
  watch: BoundWatch,
  beyond: string | null,
): string | null {
  const reasons = [
    ...watch.derived.unresolved.map(
      // Every reason names the path it stopped at, the kernel's and the loop's.
      (u) => `cannot follow a link chain — ${u.reason}`,
    ),
    ...watch.held.handle.deaf.map((d) =>
      d.kind === "refused"
        ? `cannot watch ${d.path} — ${d.reason}`
        : `watching ${d.path} failed — ${d.reason}`,
    ),
    ...(beyond === null ? [] : [beyond]),
  ];
  return reasons.length === 0 ? null : `${label}: ${reasons.join("; ")}`;
}

// A debounce window's invalidation while it gathers: its paths are the
// registry's own until the window closes and hands them to the holders.
type Gathering =
  | Exclude<Invalidation, { kind: "changed" }>
  | { readonly kind: "changed"; readonly paths: Set<string> };

// A target the OS is not listening to, and why: it refused the open, or the
// handle reported an error after it opened.
export interface Deafness {
  readonly kind: "refused" | "failed";
  readonly path: string;
  readonly reason: string;
}

// [LAW:types-are-the-program] A directory watch listens or is deaf, never
// both. A listening one holds its handle and the folder it bound, read before
// the open, so a folder replaced while it opens reads as moved at the next
// judgment, never as the one the handle bound.
type DirState =
  | {
      readonly kind: "listening";
      readonly handle: fs.FSWatcher;
      readonly bound: string;
    }
  | { readonly kind: "deaf"; readonly deafness: Deafness };

// [LAW:single-enforcer] One OS watch per directory, shared by every slot
// that targets it: a slot's key spells its name filters, so a link re-pointed
// to a new name is a new slot on the same directory, and the handle stays.
interface DirWatch {
  readonly id: string;
  readonly path: string;
  readonly recursive: boolean;
  state: DirState;
  readonly listeners: Set<Listener>;
}

// A slot's target on a directory watch: which names there it hears (`null`:
// every child).
interface Listener {
  readonly slot: WatcherSlot;
  readonly dir: DirWatch;
  readonly filter: ReadonlySet<string> | null;
}

interface Holder {
  readonly onInvalidate: (invalidation: Invalidation) => void;
}

interface WatcherSlot {
  readonly key: string;
  readonly listeners: Listener[];
  // [LAW:single-enforcer] Each acquire is a holder with its own callback, and
  // every window reaches every holder: `watch_file` sources in a directory
  // home and in each session's view share one key.
  readonly holders: Set<Holder>;
  // The debounce window open now, and what it has seen so far.
  debounce: { readonly timer: NodeJS.Timeout; window: Gathering } | null;
}

// [LAW:no-silent-failure] A handle says, live, which of its targets the OS is
// not listening to, so a consumer whose only refresh is the watch can show
// the fault.
export interface WatcherHandle {
  release(): void;
  readonly deaf: readonly Deafness[];
}

// What a consumer asks to watch, under the key naming it. [LAW:one-source-of-truth]
// The registry keeps the FIRST acquire's targets under a key, so the key must
// name the target set and the folders it binds: a different set, or a
// directory made again at its path (Linux's inotify follows the inode, so the
// held watch hears the one before), is a different key, and "the watch moved"
// and "the key changed" are one fact. `unbound`: a directory the spec names is
// gone or cannot be stat'd right now, so there is nothing to bind yet.
export interface WatchSpec {
  readonly key: string;
  readonly targets: WatchTargets;
  readonly unbound: boolean;
}

// A watch a consumer holds: the handle and the key it was acquired under.
export interface HeldWatch {
  readonly key: string;
  readonly handle: WatcherHandle;
}

// What following a spec did to a held watch: kept it, or acquired the spec's
// and released it.
export type WatchMove = "kept" | "rebound";

// [LAW:nothing-unseen] Two kinds of fact. A slot is a consumer's watch:
// `watchersOpened` counts slots whose every directory listened at acquire,
// `watchRefusals` slots with one deaf then, and `watchersClosed` every slot
// released, so the slots held now are opened plus refusals less closed. A
// directory watch is an OS handle, which is what the cost scales with on
// macOS: `dirWatchesOpened` counts each open, `dirWatchesClosed` each close (a
// reopen's included), and `watchErrors` each error a handle reported.
export interface WatcherCounters {
  watchersOpened: number;
  watchersClosed: number;
  watchRefusals: number;
  watchErrors: number;
  dirWatchesOpened: number;
  dirWatchesClosed: number;
}

// The window's fold: a failure outranks everything, an unnamed event outranks
// paths, and paths gather into the window's own set, so a burst of events
// costs one insert each.
function folded(window: Gathering, next: Gathering): Gathering {
  if (next.kind === "failed") return next;
  if (window.kind !== "changed") return window;
  if (next.kind === "unknown") return next;
  for (const p of next.paths) window.paths.add(p);
  return window;
}

const namedOf = (dir: string, filename: string | null): Gathering =>
  filename === null
    ? { kind: "unknown" }
    : { kind: "changed", paths: new Set([path.join(dir, filename)]) };

const failedOf = (d: Deafness): Gathering => ({
  kind: "failed",
  reason: `${d.path}: ${d.reason}`,
});

// [LAW:one-source-of-truth] A directory's state is its current handle's to
// speak for. A reopen closes and replaces the handle, and an event or error
// already on its way from the closed one reports a directory that is gone.
const heldBy = (
  state: DirState,
  handle: fs.FSWatcher,
): state is Extract<DirState, { kind: "listening" }> =>
  state.kind === "listening" && state.handle === handle;

const dirId = (target: DirTarget): string =>
  `${target.recursive === true ? "tree" : "dir"}:${target.path}`;

export class WatcherRegistry {
  private readonly slots = new Map<string, WatcherSlot>();
  private readonly dirs = new Map<string, DirWatch>();
  private readonly counters?: WatcherCounters;
  private readonly logger: WatcherLogger;
  private closed = false;

  constructor(
    opts: {
      counters?: WatcherCounters;
      // [LAW:single-enforcer] One injection point per consumer. The daemon
      // passes its log so watcher-failure events land in daemon.log; non-
      // daemon consumers keep the default debug-routed logger and never
      // touch daemon log files.
      logger?: WatcherLogger;
    } = {},
  ) {
    this.counters = opts.counters;
    this.logger = opts.logger ?? defaultLogger;
  }

  // Acquire (or share) the watch keyed by `key`. Every acquire of a key is a
  // holder of one slot, and each holder's callback hears every window.
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
        deaf: targets.dirs.map((d) => ({
          kind: "refused",
          path: d.path,
          reason: "the watcher registry is closed",
        })),
      };
    }
    const shared = this.slots.get(key);
    // [LAW:single-enforcer] Every acquire names its directories as they are
    // now: joining a slot judges its directories as opening one does.
    for (const { dir } of shared?.listeners ?? []) this.judged(dir, "acquire");
    const slot = shared ?? this.opened(key, targets);
    const holder: Holder = { onInvalidate };
    slot.holders.add(holder);
    return this.makeHandle(slot, holder);
  }

  // [LAW:single-enforcer] The one rule for a watch whose targets can move: a
  // consumer derives its spec from disk again and the held watch follows it
  // exactly when the key differs. The same key is the same directories, kept
  // as they are; a new key acquires the spec's watch and then releases the
  // held one, so a directory both name keeps its OS handle through the move.
  // Nothing held yet is a first acquire, which is a rebind from nothing.
  //
  // A spec with a directory that binds nothing yet (gone, or a mount's
  // transient fault) keeps the watch held: a derive that lands between a
  // directory's removal and its making again would otherwise trade a watch
  // FSEvents keeps on its path for a slot the OS refuses. The next derive
  // that finds the directory there rebinds, since its key differs.
  //
  // [LAW:no-ambient-temporal-coupling] A kept watch retries nothing: its deaf
  // directories are the period's to open again (`judge`). A follow that
  // retried would answer the failed window its own handle's error told, and
  // a handle that errors after every open would retry itself at the debounce
  // cadence.
  follow(
    held: HeldWatch | null,
    spec: WatchSpec,
    onInvalidate: (invalidation: Invalidation) => void,
  ): { readonly watch: HeldWatch; readonly move: WatchMove } {
    if (held !== null && (held.key === spec.key || spec.unbound))
      return { watch: held, move: "kept" };
    const watch = {
      key: spec.key,
      handle: this.acquire(spec.key, spec.targets, onInvalidate),
    };
    held?.handle.release();
    return { watch, move: "rebound" };
  }

  private opened(key: string, targets: WatchTargets): WatcherSlot {
    const slot: WatcherSlot = {
      key,
      listeners: [],
      holders: new Set(),
      debounce: null,
    };
    for (const target of targets.dirs) {
      const dir = this.dirFor(target);
      const listener: Listener = {
        slot,
        dir,
        filter: target.filenames ? new Set(target.filenames) : null,
      };
      dir.listeners.add(listener);
      slot.listeners.push(listener);
    }
    this.slots.set(key, slot);
    if (this.counters) {
      if (slot.listeners.every((l) => l.dir.state.kind === "listening"))
        this.counters.watchersOpened++;
      else this.counters.watchRefusals++;
    }
    return slot;
  }

  // The directory watch a new slot's target joins: the one already open
  // there, judged, or a new one.
  private dirFor(target: DirTarget): DirWatch {
    const id = dirId(target);
    const existing = this.dirs.get(id);
    if (existing !== undefined) {
      this.judged(existing, "acquire");
      return existing;
    }
    const where = { path: target.path, recursive: target.recursive === true };
    const dir: DirWatch = {
      id,
      ...where,
      listeners: new Set(),
      state: this.open(where, () => dir, "acquire", null),
    };
    this.dirs.set(id, dir);
    return dir;
  }

  // [LAW:single-enforcer] The one rule that a directory watch names the
  // folder at its path, applied whenever a holder acquires the directory,
  // whenever an event says the folder there moved, and on every period
  // (`judge`). A deaf one is opened again; a listening one whose path holds
  // another folder than the one it bound (removed and made again, or a strict
  // ancestor renamed away and another tree put at its path: inotify hears the
  // old inode, and the bound folder is what an event naming the directory is
  // judged against) is reopened in place. A path that binds nothing right now
  // keeps the listening handle, as `follow` keeps a held watch: a macOS watch
  // on the path hears the folder come back.
  private judged(dir: DirWatch, cause: string): void {
    if (dir.state.kind === "deaf") {
      this.reopen(dir, cause);
      return;
    }
    const now = boundOf(dir.path);
    if (bindsFolder(now) && boundKey(now) !== dir.state.bound)
      this.reopen(dir, "another folder is at its path");
  }

  // [LAW:no-ambient-temporal-coupling] Every directory watch judged against
  // the disk, on the period the file-event delivery owner keeps (the daemon
  // wires it). It is the one trigger for a replacement no event reaches a
  // handle for (a strict ancestor renamed away and another tree put at its
  // path: inotify reports a directory's own removal or self-move, never its
  // parent's), and the retry of a directory the OS refused or whose handle
  // errored while no holder newly acquires it. A directory staying as it is
  // costs one stat, or one refused open, and tells nothing.
  judge(): void {
    for (const dir of this.dirs.values()) this.judged(dir, "period");
  }

  // [LAW:no-silent-failure] Every slot on the directory hears it change
  // state. Going deaf, it hears the fault. Listening again, it hears an
  // `unknown` window: whatever changed while the directory was deaf or bound
  // to another folder went unheard, and a holder that re-derives on it reports
  // its fault cleared. Deaf staying deaf is no change and tells nothing.
  private reopen(dir: DirWatch, cause: string): void {
    const was = dir.state;
    if (was.kind === "listening") this.closeHandle(dir.path, was.handle, cause);
    dir.state = this.open(dir, () => dir, cause, was);
    if (dir.state.kind === "listening") this.tell(dir, { kind: "unknown" });
    else if (was.kind === "listening")
      this.tell(dir, failedOf(dir.state.deafness));
  }

  // `dirOf` names the watch the handle belongs to; its callbacks run only
  // after the open returns, once the watch holds the state returned here.
  private open(
    where: { readonly path: string; readonly recursive: boolean },
    dirOf: () => DirWatch,
    cause: string,
    was: DirState | null,
  ): DirState {
    const at = where.path;
    const bound = boundKey(boundOf(at));
    try {
      // [LAW:no-silent-failure] A directory the daemon cannot open is
      // refused. fs.watch refuses it itself, except Linux's recursive watch
      // on Node 20 and 22 (Node's own walk), which swallows the error and
      // returns a watch that never fires.
      // [LAW:dataflow-not-control-flow] So every open opens the directory
      // first, recursive or not, and its error is the refusal's reason.
      fs.opendirSync(at).closeSync();
      const handle = fs.watch(
        at,
        { persistent: false, recursive: where.recursive },
        (_event, changed) => this.heard(dirOf(), handle, changed),
      );
      // [LAW:no-silent-failure] An error after open reaches every slot on
      // the directory and the stats, not only the log: the handle behind it
      // delivers nothing more.
      handle.on("error", (e) => {
        this.logger("warn", `watcher error ${at}: ${e.message}`);
        if (this.counters) this.counters.watchErrors++;
        const dir = dirOf();
        if (!heldBy(dir.state, handle)) return;
        this.closeHandle(at, handle, "error");
        const deafness: Deafness = {
          kind: "failed",
          path: at,
          reason: e.message,
        };
        dir.state = { kind: "deaf", deafness };
        this.tell(dir, failedOf(deafness));
      });
      if (this.counters) this.counters.dirWatchesOpened++;
      this.logger(
        "info",
        `dir watch opened path=${valueOf(at)} cause=${valueOf(cause)}`,
      );
      return { kind: "listening", handle, bound };
    } catch (e) {
      const reason = (e as Error).message;
      // [LAW:nothing-unseen] A refusal is logged when it starts or its reason
      // changes; every period retries a deaf directory, and the same refusal
      // repeated would bury the events around it.
      const same =
        was?.kind === "deaf" &&
        was.deafness.kind === "refused" &&
        was.deafness.reason === reason;
      if (!same) this.logger("warn", `watch failed ${at}: ${reason}`);
      return {
        kind: "deaf",
        deafness: { kind: "refused", path: at, reason },
      };
    }
  }

  // [LAW:dataflow-not-control-flow] Each listener's filter is a value: a name
  // it lists, an unnamed event (the OS may be reporting the filtered child),
  // or the directory's own name while the folder at the path is no longer the
  // one this handle bound (its removal or replacement, which macOS reports as
  // a change and Linux as a rename) reaches the slot. The same name with the
  // folder unchanged is macOS reporting a child that came or went, or a chmod,
  // and is not. Judged once per event, for every listener. A move is then
  // judged, so a handle never stays bound to a folder no longer at its path
  // and every later event naming the directory is judged against the folder
  // there.
  private heard(
    dir: DirWatch,
    handle: fs.FSWatcher,
    changed: string | null,
  ): void {
    const { state } = dir;
    if (!heldBy(state, handle)) return;
    const moved =
      changed === path.basename(dir.path) &&
      boundKey(boundOf(dir.path)) !== state.bound;
    for (const { slot, filter } of dir.listeners) {
      if (filter === null || changed === null || filter.has(changed) || moved)
        this.fire(slot, namedOf(dir.path, changed));
    }
    if (moved) this.judged(dir, "moved");
  }

  private tell(dir: DirWatch, invalidation: Gathering): void {
    for (const { slot } of dir.listeners) this.fire(slot, invalidation);
  }

  private fire(slot: WatcherSlot, invalidation: Gathering): void {
    if (slot.debounce !== null) {
      slot.debounce.window = folded(slot.debounce.window, invalidation);
      return;
    }
    const debounce = {
      window: invalidation,
      timer: setTimeout(() => {
        slot.debounce = null;
        for (const holder of slot.holders) {
          try {
            holder.onInvalidate(debounce.window);
          } catch (e) {
            this.logger(
              "warn",
              `watcher invalidate threw key=${valueOf(slot.key)}: ${(e as Error).message}`,
            );
          }
        }
      }, DEBOUNCE_MS),
    };
    debounce.timer.unref();
    slot.debounce = debounce;
  }

  private makeHandle(slot: WatcherSlot, holder: Holder): WatcherHandle {
    return {
      get deaf() {
        return slot.listeners.flatMap(({ dir }) =>
          dir.state.kind === "deaf" ? [dir.state.deafness] : [],
        );
      },
      release: () => {
        if (!slot.holders.delete(holder) || slot.holders.size > 0) return;
        if (this.slots.get(slot.key) !== slot) return;
        this.closeSlot(slot, "last release");
        this.slots.delete(slot.key);
      },
    };
  }

  private closeHandle(at: string, handle: fs.FSWatcher, cause: string): void {
    try {
      handle.close();
    } catch {}
    if (this.counters) this.counters.dirWatchesClosed++;
    this.logger(
      "info",
      `dir watch closed path=${valueOf(at)} cause=${valueOf(cause)}`,
    );
  }

  // A directory watch closes with the last slot on it.
  private closeSlot(slot: WatcherSlot, cause: string): void {
    if (slot.debounce !== null) {
      clearTimeout(slot.debounce.timer);
      slot.debounce = null;
    }
    for (const listener of slot.listeners) {
      const { dir } = listener;
      dir.listeners.delete(listener);
      if (dir.listeners.size > 0) continue;
      if (dir.state.kind === "listening")
        this.closeHandle(dir.path, dir.state.handle, cause);
      this.dirs.delete(dir.id);
    }
    if (this.counters) this.counters.watchersClosed++;
  }

  // The slots held now.
  size(): number {
    return this.slots.size;
  }

  // The OS directory watches open now.
  dirWatches(): number {
    return [...this.dirs.values()].filter((d) => d.state.kind === "listening")
      .length;
  }

  // Every directory a held watch targets.
  watchedDirs(): string[] {
    return [...this.dirs.values()].map((d) => d.path);
  }

  closeAll(): void {
    this.closed = true;
    for (const slot of this.slots.values()) this.closeSlot(slot, "close");
    this.slots.clear();
  }
}

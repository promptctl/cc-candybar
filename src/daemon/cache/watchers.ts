import { compareStructural } from "mobx";
import fs from "node:fs";
import path from "node:path";
import { debug } from "../../utils/logger";
import { valueOf } from "../../utils/logfmt";
import {
  bindsFolder,
  boundKey,
  boundOf,
  identityKey,
} from "../../utils/folder-identity";
import type { Timekeeper } from "../../time";
import {
  ridesStream,
  type Invalidation,
  type WatchTargets,
  type HeldWatch,
  type WatchSpec,
  type WatchMove,
  type WatcherHandle,
  type DirTarget,
  type Deafness,
} from "../foundations/watch-targets";
import { followWatch } from "../foundations/watch-targets";

// Logger callable used for watcher lifecycle / failure events. Daemon
// injects its log (writes to daemon.log at the requested level); other
// consumers (var-system tests) take the default which routes
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
//
// Nor is holding one free, so a polled path opens none: one sweep lstats every
// polled path each period, and an acquire or follow lstats its own once each,
// whatever happens in the tree around them.

// [LAW:one-source-of-truth] Exported: the invalidation-debounce floor is the
// single source consumers derive from (e.g. the load harness's git-churn
// interval must sit above it). Restating "50" anywhere else would let the two
// drift silently.
export const DEBOUNCE_MS = 50;

// How often every polled path is read: the longest a change to one waits
// before its debounce window opens.
export const POLL_MS = 1000;

// A debounce window's invalidation while it gathers: its paths are the
// registry's own until the window closes and hands them to the holders.
type Gathering =
  | Exclude<Invalidation, { kind: "changed" }>
  | { readonly kind: "changed"; readonly paths: Set<string> };

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

// [LAW:single-enforcer] One OS watch per directory and shape (every child, or
// the tree), shared by every slot that targets it.
interface DirWatch {
  readonly id: string;
  readonly path: string;
  readonly recursive: boolean;
  state: DirState;
  readonly listeners: Set<Listener>;
}

// A slot's target on a directory watch. It hears everything the watch reports.
interface Listener {
  readonly slot: WatcherSlot;
  readonly dir: DirWatch;
}

// [LAW:single-enforcer] One record per polled path, shared by every slot that
// names it: what the last sweep of the path found, and who hears it change.
// [LAW:one-source-of-truth] A new record takes the disk at its first acquire;
// after that only the sweep reads an entry into it, and an acquire or follow
// only marks it unseen, because a holder may read before it follows and an
// entry taken at the follow would hide a change between the two. What this
// cannot see is a change a holder read that was undone before its acquire or
// follow, or one between a read and the first acquire of its path: that needs
// the entry the holder read, which only the holder has.
interface PolledPath {
  readonly path: string;
  entry: string | typeof UNSEEN;
  readonly slots: Set<WatcherSlot>;
}

interface Holder {
  readonly onInvalidate: (invalidation: Invalidation) => void;
}

interface WatcherSlot {
  readonly key: string;
  // The directories it was acquired for, and the watch it holds on each
  // directory they name now, by the watch's id.
  readonly targets: readonly DirTarget[];
  readonly listeners: Map<string, Listener>;
  readonly polled: PolledPath[];
  // [LAW:single-enforcer] Each acquire is a holder with its own callback, and
  // every window reaches every holder: `watch_file` sources in a directory
  // home and in each session's view share one key.
  readonly holders: Set<Holder>;
  // The debounce window open now, and what it has seen so far.
  debounce: { readonly cancel: () => void; window: Gathering } | null;
}

// [LAW:nothing-unseen] Two kinds of fact. A slot is a consumer's watch:
// `watchersOpened` counts slots whose every OS directory watch listened at
// acquire, `watchRefusals` slots with one deaf then, and `watchersClosed`
// every slot released, so the slots held now are opened plus refusals less
// closed. A directory watch is an OS handle, which is what the cost scales
// with on macOS: `dirWatchesOpened` counts each open, `dirWatchesClosed` each
// close (a reopen's included), and `watchErrors` each error a handle reported.
// A polled path holds no handle and counts in none of them.
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

// A window as its holders hear it: its paths a list in one order, so two
// windows that heard the same paths are equal values.
const heardOf = (window: Gathering): Invalidation =>
  window.kind === "changed"
    ? { kind: "changed", paths: [...window.paths].sort() }
    : window;

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

// An entry no read gives: a path holding it differs at the next sweep.
const UNSEEN: unique symbol = Symbol("unseen");

const dirId = (target: DirTarget): string =>
  `${target.recursive === true ? "tree" : "dir"}:${target.path}`;

const isBelow = (at: string, root: string): boolean =>
  at.startsWith(root + path.sep);

// The directories below `at` as they are now, by listing directories, never
// through a link. `trusted` keeps the watches held under a directory already
// held at `at`'s own level as they are, since only `at`'s own listing moved;
// below a directory new here, everything is listed. [LAW:no-silent-failure] A
// directory that cannot be listed is named in `unlisted`, and what is below it
// is unknown, not gone, so the watches held there stay.
function dirsBelow(
  at: string,
  held: ReadonlySet<string>,
  trusted: boolean,
  unlisted: string[],
): string[] {
  const heldIn = (dir: string) =>
    [...held].filter((p) => p === dir || isBelow(p, dir));
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(at, { withFileTypes: true });
  } catch {
    unlisted.push(at);
    return [...held].filter((p) => isBelow(p, at));
  }
  return entries
    .filter((e) => e.isDirectory())
    .flatMap((e) => {
      const below = path.join(at, e.name);
      return trusted && held.has(below)
        ? heldIn(below)
        : [below, ...dirsBelow(below, held, false, unlisted)];
    });
}

// [LAW:one-source-of-truth] What a read of a polled path compares: what is at
// the path now, or the error reading it gave. Any difference is a change, as
// a directory watch reports a child made, removed, replaced, written or
// chmod'ed (the ctime moves on each). A directory's size and times are its
// children's, which a polled path never stood for, so a directory is its
// identity and mode alone. [LAW:one-source-of-truth] The identity is the
// folder identity's own key, birth time with it, since ext4 hands a replaced
// path its old inode number.
// [LAW:no-silent-failure] A read the disk refuses is not deafness: the path
// fires as it starts failing and as it stops, and the holder's own read of it
// fails loudly in between. A missing parent and a folder replaced on the way
// arrive the same way, so a polled path is never deaf and never judged.
function entryAt(at: string): string {
  try {
    const s = fs.lstatSync(at, { bigint: true });
    const identity = `${s.mode}:${identityKey({ dev: s.dev, ino: s.ino, birthtimeNs: s.birthtimeNs })}`;
    return s.isDirectory()
      ? identity
      : `${identity}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
  } catch (e) {
    return `error:${(e as NodeJS.ErrnoException).code}`;
  }
}

export class WatcherRegistry {
  private readonly slots = new Map<string, WatcherSlot>();
  private readonly dirs = new Map<string, DirWatch>();
  private readonly polled = new Map<string, PolledPath>();
  // The next sweep's cancel, armed exactly while a path is polled.
  private sweep: (() => void) | null = null;
  private readonly counters?: WatcherCounters;
  private readonly logger: WatcherLogger;
  private readonly clock: Pick<Timekeeper, "after" | "every">;
  private closed = false;
  private readonly nodeWalksTrees: boolean;

  constructor(opts: {
    // [LAW:effects-at-boundaries] The clock the debounce window and the
    // sweep run on.
    clock: Pick<Timekeeper, "after" | "every">;
    counters?: WatcherCounters;
    // [LAW:single-enforcer] One injection point per consumer. The daemon
    // passes its log so watcher-failure events land in daemon.log; non-
    // daemon consumers keep the default debug-routed logger and never
    // touch daemon log files.
    logger?: WatcherLogger;
    // Whether the runtime's recursive watch is Node's own walk, which stops
    // at the first entry it cannot watch and says nothing: Linux's.
    nodeWalksTrees?: boolean;
  }) {
    this.clock = opts.clock;
    this.counters = opts.counters;
    this.logger = opts.logger ?? defaultLogger;
    this.nodeWalksTrees = opts.nodeWalksTrees ?? process.platform === "linux";
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
      // Registry already shut down: nothing is watched or read, and the
      // handle says so of every target; releasing it is a no-op, so callers
      // don't crash mid-shutdown.
      return {
        release: () => {},
        deaf: [...targets.dirs.map((d) => d.path), ...targets.polled].map(
          (path) => ({
            kind: "refused",
            path,
            reason: "the watcher registry is closed",
          }),
        ),
        ridesStream: ridesStream(targets),
      };
    }
    const shared = this.slots.get(key);
    // [LAW:single-enforcer] Every acquire names its directories as they are
    // now: joining a slot judges and reconciles its directories as opening
    // one does.
    if (shared !== undefined) {
      for (const { dir } of shared.listeners.values())
        this.judged(dir, "acquire");
      this.reconciled(shared, "acquire", null);
    }
    // The records the acquire joins. A path no slot polls yet has none: its
    // new record reads the disk itself.
    this.sighted(
      shared?.polled ??
        targets.polled.flatMap((at) => this.polled.get(at) ?? []),
    );
    const slot = shared ?? this.opened(key, targets);
    const holder: Holder = { onInvalidate };
    slot.holders.add(holder);
    return this.makeHandle(slot, holder);
  }

  // The held watch following `spec` (`followWatch`).
  follow(
    held: HeldWatch | null,
    spec: WatchSpec,
    onInvalidate: (invalidation: Invalidation) => void,
  ): { readonly watch: HeldWatch; readonly move: WatchMove } {
    const followed = followWatch(held, spec, (key, targets) =>
      this.acquire(key, targets, onInvalidate),
    );
    // A rebound acquired, which sighted. A kept watch whose slot is gone (the
    // registry closed, or the holder released it) polls nothing to sight.
    if (followed.move === "kept")
      this.sighted(this.slots.get(followed.watch.key)?.polled ?? []);
    return followed;
  }

  // [LAW:no-ambient-temporal-coupling] A holder acquiring or following may
  // have read a polled path since the last sweep, and read a state no sweep
  // saw. Where the disk differs from the swept entry now, the next sweep
  // fires it whatever it reads, so a change undone before the sweep is still
  // heard. Only the sweep fires, so the work a path drives stays once a
  // period; a change undone before the holder acquired or followed is one no
  // poll sees.
  // [LAW:escape-local-minima] exception: seeing a change undone before the
  // holder looks needs the entry the holder read, which polled consumers do
  // not yet hand over.
  private sighted(records: readonly PolledPath[]): void {
    for (const record of records)
      if (record.entry !== UNSEEN && entryAt(record.path) !== record.entry)
        record.entry = UNSEEN;
  }

  private opened(key: string, targets: WatchTargets): WatcherSlot {
    const slot: WatcherSlot = {
      key,
      targets: targets.dirs,
      listeners: new Map(),
      polled: [],
      holders: new Set(),
      debounce: null,
    };
    this.reconciled(slot, "acquire", null);
    for (const at of targets.polled) {
      const record = this.polledAt(at);
      record.slots.add(slot);
      slot.polled.push(record);
    }
    this.armSweep();
    this.slots.set(key, slot);
    if (this.counters) {
      if (
        [...slot.listeners.values()].every(
          (l) => l.dir.state.kind === "listening",
        )
      )
        this.counters.watchersOpened++;
      else this.counters.watchRefusals++;
    }
    return slot;
  }

  // [LAW:single-enforcer] How a tree is heard is decided here, by what the
  // runtime's recursive watch is. Native (macOS's FSEvents), it is one watch.
  // Node's own walk (Linux) stops at the first entry it cannot watch and says
  // nothing, and where it fails cannot be predicted, so a tree there is a
  // plain watch on the root and on each directory below it, each refused or
  // heard by the OS on its own. `heardIn` is the directory an event was heard
  // in, or null for the whole of every target: an event moves only what its
  // own directory lists, so only that listing is read again.
  private dirsOf(
    targets: readonly DirTarget[],
    heardIn: string | null,
    held: ReadonlySet<string>,
    unlisted: string[],
  ): DirTarget[] {
    return targets.flatMap((target) => {
      if (target.recursive !== true || !this.nodeWalksTrees) return [target];
      const at = heardIn ?? target.path;
      if (at !== target.path && !isBelow(at, target.path)) return [];
      const below = dirsBelow(at, held, heardIn !== null, unlisted);
      return [...(heardIn === null ? [at] : []), ...below].map((dir) => ({
        path: dir,
      }));
    });
  }

  // [LAW:dataflow-not-control-flow] A slot holds a watch on exactly the
  // directories its targets name now, below the directory listed again: one
  // it lacks joins, one no longer named leaves. Run whole at its acquire and
  // on every period, and for the directory each event its watches hear is
  // heard in, so a tree's new directory is heard from the event that made it.
  private reconciled(
    slot: WatcherSlot,
    cause: string,
    heardIn: string | null,
  ): void {
    const held = new Set([...slot.listeners.values()].map((l) => l.dir.path));
    const unlisted: string[] = [];
    const named = new Map(
      this.dirsOf(slot.targets, heardIn, held, unlisted).map((t) => [
        dirId(t),
        t,
      ]),
    );
    for (const [id, listener] of slot.listeners)
      if (
        !named.has(id) &&
        (heardIn === null || isBelow(listener.dir.path, heardIn))
      ) {
        slot.listeners.delete(id);
        this.left(listener, cause);
      }
    for (const [id, target] of named)
      if (!slot.listeners.has(id)) {
        const dir = this.dirFor(target, cause);
        const listener: Listener = { slot, dir };
        dir.listeners.add(listener);
        slot.listeners.set(id, listener);
        // [LAW:no-silent-failure] A directory joining a slot its holders
        // already hear, refused, reaches them as a failure does.
        if (slot.holders.size > 0 && dir.state.kind === "deaf")
          this.fire(slot, failedOf(dir.state.deafness));
      }
    // [LAW:no-silent-failure] A held directory that cannot be listed hides
    // whatever is made below it, so it is opened again: its open refuses it as
    // the OS answers, logged, on the handle, told to its holders and retried
    // on the period, while the watches below it stay.
    for (const at of unlisted) {
      const dir = this.dirs.get(dirId({ path: at }));
      if (dir?.state.kind === "listening")
        this.reopen(dir, "it cannot be listed");
    }
  }

  // A directory watch closes with the last slot on it.
  private left(listener: Listener, cause: string): void {
    const { dir } = listener;
    dir.listeners.delete(listener);
    if (dir.listeners.size > 0) return;
    if (dir.state.kind === "listening")
      this.closeHandle(dir.path, dir.state.handle, cause);
    this.dirs.delete(dir.id);
  }

  // The directory watch a slot's target joins: the one already open there,
  // judged, or a new one.
  private dirFor(target: DirTarget, cause: string): DirWatch {
    const id = dirId(target);
    const existing = this.dirs.get(id);
    if (existing !== undefined) {
      this.judged(existing, cause);
      return existing;
    }
    const where = { path: target.path, recursive: target.recursive === true };
    const dir: DirWatch = {
      id,
      ...where,
      listeners: new Set(),
      state: this.open(where, () => dir, cause, null),
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
  // costs one stat, or one refused open, and tells nothing; a tree heard
  // directory by directory costs a listing of each directory too.
  judge(): void {
    for (const slot of this.slots.values())
      this.reconciled(slot, "period", null);
    for (const dir of this.dirs.values()) this.judged(dir, "period");
  }

  // [LAW:no-silent-failure] Every slot on the directory hears it change
  // state. Going deaf, or deaf for another reason, it hears the fault.
  // Listening again, it hears an `unknown` window: whatever changed while the
  // directory was deaf or bound to another folder went unheard, and a holder
  // that re-derives on it reports its fault cleared. Deaf for the same reason
  // is no change and tells nothing.
  private reopen(dir: DirWatch, cause: string): void {
    const was = dir.state;
    if (was.kind === "listening") this.closeHandle(dir.path, was.handle, cause);
    const now = this.open(dir, () => dir, cause, was);
    dir.state = now;
    if (now.kind === "listening") this.tell(dir, { kind: "unknown" });
    else if (
      was.kind === "listening" ||
      !compareStructural(was.deafness, now.deafness)
    )
      this.tell(dir, failedOf(now.deafness));
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
      // refused, whatever the runtime's watch would accept of it.
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
      const deafness: Deafness = { kind: "refused", path: at, reason };
      if (was?.kind !== "deaf" || !compareStructural(was.deafness, deafness))
        this.logger("warn", `watch failed ${at}: ${reason}`);
      return { kind: "deaf", deafness };
    }
  }

  // [LAW:dataflow-not-control-flow] Every event reaches every slot on the
  // watch. One naming the directory itself, while the folder at the path is
  // no longer the one this handle bound (its removal or replacement, which
  // macOS reports as a change and Linux as a rename), is then judged, so a
  // handle never stays bound to a folder no longer at its path and every later
  // event naming the directory is judged against the folder there.
  private heard(
    dir: DirWatch,
    handle: fs.FSWatcher,
    changed: string | null,
  ): void {
    const { state } = dir;
    if (!heldBy(state, handle)) return;
    this.tell(dir, namedOf(dir.path, changed));
    if (
      changed === path.basename(dir.path) &&
      boundKey(boundOf(dir.path)) !== state.bound
    )
      this.judged(dir, "moved");
    for (const slot of [...dir.listeners].map((l) => l.slot))
      this.reconciled(slot, "heard", dir.path);
  }

  private tell(dir: DirWatch, invalidation: Gathering): void {
    for (const { slot } of dir.listeners) this.fire(slot, invalidation);
  }

  private fire(slot: WatcherSlot, invalidation: Gathering): void {
    if (slot.debounce !== null) {
      slot.debounce.window = folded(slot.debounce.window, invalidation);
      return;
    }
    // A window is its slot's own: one event reaches every slot on the
    // directory, and a fold into a shared set would hand a slot the paths
    // another named.
    const debounce = {
      window:
        invalidation.kind === "changed"
          ? { kind: "changed" as const, paths: new Set(invalidation.paths) }
          : invalidation,
      cancel: this.clock.after(
        DEBOUNCE_MS,
        () => {
          slot.debounce = null;
          const heard = heardOf(debounce.window);
          for (const holder of slot.holders) {
            try {
              holder.onInvalidate(heard);
            } catch (e) {
              this.logger(
                "warn",
                `watcher invalidate threw key=${valueOf(slot.key)}: ${(e as Error).message}`,
              );
            }
          }
        },
        { unref: true },
      ),
    };
    slot.debounce = debounce;
  }

  private makeHandle(slot: WatcherSlot, holder: Holder): WatcherHandle {
    return {
      get deaf() {
        return [...slot.listeners.values()].flatMap(({ dir }) =>
          dir.state.kind === "deaf" ? [dir.state.deafness] : [],
        );
      },
      // [LAW:one-source-of-truth] The slot's OS watches are what ride it.
      ridesStream: slot.listeners.size > 0,
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

  // A directory watch closes, and a polled path is forgotten, with the last
  // slot on it: a slot that names the path again starts from what is there at
  // its own acquire.
  private closeSlot(slot: WatcherSlot, cause: string): void {
    if (slot.debounce !== null) {
      slot.debounce.cancel();
      slot.debounce = null;
    }
    for (const listener of slot.listeners.values()) this.left(listener, cause);
    for (const record of slot.polled) {
      record.slots.delete(slot);
      if (record.slots.size === 0) this.polled.delete(record.path);
    }
    if (this.polled.size === 0) this.disarmSweep();
    if (this.counters) this.counters.watchersClosed++;
  }

  // The record for a polled path: a new one read now, so only a change after
  // the acquire is a change; or the one already held, which the acquire sights.
  private polledAt(at: string): PolledPath {
    const held = this.polled.get(at);
    if (held !== undefined) return held;
    const record: PolledPath = {
      path: at,
      entry: entryAt(at),
      slots: new Set(),
    };
    this.polled.set(at, record);
    return record;
  }

  // [LAW:no-ambient-temporal-coupling] The sweep runs every period while a
  // path is polled and the registry is open. The reads are synchronous, so no
  // two sweeps overlap and no older read lands over a newer one.
  // [LAW:effects-at-boundaries] exception: an lstat runs on the thread that
  // renders, once a period per path and once per acquire or follow naming it,
  // so a mount under a polled path that stops answering stops every bar until
  // it answers. The paths are a session's own files (its transcript, its
  // settings, its config, its git directory), which the daemon reads on this
  // thread to render anyway.
  private armSweep(): void {
    if (this.sweep !== null || this.closed || this.polled.size === 0) return;
    this.sweep = this.clock.every(POLL_MS, () => this.readPolled(), {
      unref: true,
    });
  }

  private disarmSweep(): void {
    this.sweep?.();
    this.sweep = null;
  }

  // [LAW:dataflow-not-control-flow] The same read for every polled path each
  // sweep. A path whose entry differs fires every slot that names it, by its
  // path, through the slot's debounce, as a directory watch reports a child.
  private readPolled(): void {
    for (const record of this.polled.values()) {
      const now = entryAt(record.path);
      if (now === record.entry) continue;
      record.entry = now;
      for (const slot of record.slots)
        this.fire(slot, { kind: "changed", paths: new Set([record.path]) });
    }
  }

  // The slots held now.
  size(): number {
    return this.slots.size;
  }

  // The paths polled now: no OS watch each.
  polledPaths(): number {
    return this.polled.size;
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
    this.disarmSweep();
    for (const slot of this.slots.values()) this.closeSlot(slot, "close");
    this.slots.clear();
  }
}

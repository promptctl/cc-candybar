// What a watch is asked to cover, and what it reached: the targets a consumer
// names, OS-watched or polled, and the faults a bound watch reports. The
// registry that holds the watches and reads the polled paths is the host's
// (src/daemon/cache/watchers.ts).

import { walkLinks } from "../../utils/atomic-write";
import { bindsFolder, boundKey, boundOf } from "../../utils/folder-identity";
import { canonicalDirectory } from "../../utils/watch-target";

// An absolute directory the OS watches: every child, or the whole tree (git's
// refs: a branch name's slashes are directories).
// [LAW:types-are-the-program] Recursive or not, one spelling each, so one OS
// watch is one spec key.
export interface DirTarget {
  readonly path: string;
  readonly recursive?: true;
}

// [LAW:types-are-the-program] The two ways a target is heard, one field each.
// `dirs` are OS watches. `polled` are absolute paths the registry lstats on
// its sweep, which opens no OS watch: on macOS a directory watch is an
// FSEvents stream over the directory's whole tree (libuv drops all but direct
// children only after fseventsd has routed each event here), so one name
// watched in a repository's root or in `$HOME` would pull every build beneath
// it through fseventsd. A path is read where it is, never through an inode it
// once had: a write-then-rename (the safe way to rewrite a file, and
// `writeAtomic`'s way) is a new inode at the same path, which the read sees
// as it sees an in-place write, and a path that does not exist yet is a read
// that fails until it does.
export interface WatchTargets {
  readonly dirs: readonly DirTarget[];
  readonly polled: readonly string[];
}

// [LAW:single-enforcer] Only an OS watch rides the event stream a stall
// stops.
export const ridesStream = (targets: WatchTargets): boolean =>
  targets.dirs.length > 0;

// [LAW:types-are-the-program] What one debounce window of a slot's watches
// says: the paths that fired, each the watched directory joined with the name
// the OS reported or a polled path whose read changed (`changed`), or that the
// OS named none of them (`unknown`), or that a watch reported an error after
// it opened (`failed`). Paths, not names: a slot watches many directories, and
// two of them can hold a child of the same name. One window folds into one
// value, the strongest of what it saw.
export type Invalidation =
  | { readonly kind: "changed"; readonly paths: readonly string[] }
  | { readonly kind: "unknown" }
  | { readonly kind: "failed"; readonly reason: string };

// A target the OS refused to watch, and why.
export interface Refusal {
  readonly path: string;
  readonly reason: string;
}

// What watching a set of paths takes: its spec, and the paths whose link
// chain the kernel stopped walking, with why.
export interface PathsWatch extends WatchSpec {
  readonly unresolved: readonly Refusal[];
}

// [LAW:single-enforcer] The one rule for where a set of paths can change, for
// every consumer that watches files (the config watcher, `watch_file`
// sources). A `named` path is polled at every hop of its link chain
// (`walkLinks`), so re-pointing any link in the chain, or a linked folder on
// the way to one, is a read that changes. A `whole` path that is a directory
// is also an OS watch for every child; one that is not adds nothing. Both
// lists are deduped and sorted, so equal sets spell equal keys. Nothing here
// throws: it runs inside watcher callbacks.
export function watchTargetsOf(paths: {
  readonly named: readonly string[];
  readonly whole: readonly string[];
}): PathsWatch {
  const unresolved: Refusal[] = [];
  const polled = new Set<string>();
  for (const at of paths.named) {
    const { hops, stopped } = walkLinks(at);
    if (stopped !== null)
      unresolved.push({ path: at, reason: stopped.message });
    for (const hop of hops) polled.add(hop);
  }
  const dirs = new Set(paths.whole.flatMap((p) => canonicalDirectory(p) ?? []));
  return {
    ...specOf({
      dirs: [...dirs].sort().map((d) => ({ path: d })),
      polled: [...polled].sort(),
    }),
    unresolved,
  };
}

// [LAW:one-source-of-truth] The one derivation of a spec from its targets, for
// every consumer that watches. The key spells the targets and the identity of
// the folder at each OS-watched one, read now: inotify follows a folder's
// inode, so a folder made again at its path is a new key the held watch
// rebinds to. A polled path is read where it is, so a folder replaced under
// it is a read that changes, and no folder of its is in the key.
export function specOf(targets: WatchTargets): WatchSpec {
  const bound = targets.dirs.map((d) => {
    const at = boundOf(d.path);
    return bindsFolder(at) ? boundKey(at) : null;
  });
  return {
    key: JSON.stringify([targets, bound]),
    targets,
    unbound: bound.includes(null),
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
    ...watch.held.handle.deaf.map(deafnessLine),
    ...(beyond === null ? [] : [beyond]),
  ];
  return reasons.length === 0 ? null : `${label}: ${reasons.join("; ")}`;
}

// [LAW:single-enforcer] The one phrasing of a target the OS is not listening
// to, for every consumer that shows one.
export const deafnessLine = (d: Deafness): string =>
  d.kind === "refused"
    ? `cannot watch ${d.path} — ${d.reason}`
    : `watching ${d.path} failed — ${d.reason}`;

// A target the OS is not listening to, and why: it refused the open, or the
// handle reported an error after it opened.
export interface Deafness {
  readonly kind: "refused" | "failed";
  readonly path: string;
  readonly reason: string;
}

// [LAW:no-silent-failure] A handle says, live, which of its targets the OS is
// not listening to, so a consumer whose only refresh is the watch can show
// the fault, and whether a stall of the OS's event delivery deafens it
// (`ridesStream`, of the targets it was acquired with).
export interface WatcherHandle {
  release(): void;
  readonly deaf: readonly Deafness[];
  readonly ridesStream: boolean;
}

// What a consumer asks to watch, under the key naming it. [LAW:one-source-of-truth]
// The registry keeps the FIRST acquire's targets under a key, so the key must
// name the target set and the folders its OS watches bind: a different set,
// or an OS-watched directory made again at its path (Linux's inotify follows
// the inode, so the held watch hears the one before), is a different key, and
// "the watch moved" and "the key changed" are one fact. `unbound`: an
// OS-watched directory the spec names is gone or cannot be stat'd right now,
// so there is nothing to bind yet.
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

// [LAW:single-enforcer] The one rule for a watch whose targets can move,
// whoever holds it: a consumer derives its spec from disk again and the held
// watch follows it exactly when the key differs. The same key is the same
// directories, kept as they are; a new key acquires the spec's watch and then
// releases the held one, so a directory both name keeps its OS handle through
// the move. Nothing held yet is a first acquire, which is a rebind from
// nothing.
//
// A spec with a directory that binds nothing yet (gone, or a mount's
// transient fault) keeps the watch held: a derive that lands between a
// directory's removal and its making again would otherwise trade a watch
// FSEvents keeps on its path for a slot the OS refuses. The next derive that
// finds the directory there rebinds, since its key differs.
//
// [LAW:no-ambient-temporal-coupling] A kept watch retries nothing: its deaf
// directories are the registry's period to open again. A follow that retried
// would answer the failed window its own handle's error told, and a handle
// that errors after every open would retry itself at the debounce cadence.
export function followWatch(
  held: HeldWatch | null,
  spec: WatchSpec,
  acquire: (key: string, targets: WatchTargets) => WatcherHandle,
): { readonly watch: HeldWatch; readonly move: WatchMove } {
  if (held !== null && (held.key === spec.key || spec.unbound))
    return { watch: held, move: "kept" };
  const watch = { key: spec.key, handle: acquire(spec.key, spec.targets) };
  held?.handle.release();
  return { watch, move: "rebound" };
}

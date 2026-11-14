// What a watch is asked to cover, and what it reached: the targets a consumer
// names and the faults a bound watch reports. The registry that holds the
// watches is the host's (src/daemon/cache/watchers.ts).

import { walkLinks } from "../../utils/atomic-write";
import { bindsFolder, boundKey, boundOf } from "../../utils/folder-identity";
import {
  canonicalDirectory,
  nearestWatchTarget,
} from "../../utils/watch-target";

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

// A target the OS is not listening to, and why: it refused the open, or the
// handle reported an error after it opened.
export interface Deafness {
  readonly kind: "refused" | "failed";
  readonly path: string;
  readonly reason: string;
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

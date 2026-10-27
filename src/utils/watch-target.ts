import fs from "node:fs";
import path from "node:path";
import { resolvedTarget } from "./atomic-write.js";

// [LAW:single-enforcer] The one rule for watching a path that may be a
// symbolic link: it is watched as spelled AND where a write to it lands
// (`resolvedTarget`, the one definition of that file, a dangling link
// included). A linked path changes in two places — the link entry, re-pointed
// or replaced in its own directory, and the target, edited or rewritten in
// its — and a directory watch reports only its own children, so a watch on
// either place alone misses the other. A plain path is one place. Each path
// returned then takes `nearestWatchTarget`'s one (dir, name) tuple.
export function watchedPathsOf(candidate: string): readonly string[] {
  try {
    const target = resolvedTarget(candidate);
    return target === candidate ? [candidate] : [candidate, target];
  } catch {
    // [LAW:no-silent-failure] exception: a link the kernel refuses to follow
    // (a loop, an unreadable component) is watched as spelled. The config
    // loader reports that location as unchecked, so the fault is loud there,
    // and this runs inside watcher callbacks, which must not throw.
    return [candidate];
  }
}

// [LAW:single-enforcer] The one rule for watching a path that may not exist
// yet, shared by the config watcher (src/daemon/cache/render.ts) and the
// file/shell sources' WatchManager (src/var-system/sources.ts).
//
// [LAW:dataflow-not-control-flow] Every path yields ONE (dir, name) watch
// tuple: the nearest EXISTING ancestor directory, and the path component
// directly beneath it. A path whose parent exists watches that parent for
// the file's basename; one whose parent does not exist yet (a fresh install,
// an app that creates its state directory on first run) watches the deepest
// ancestor that does, for the missing directory's name — so the mkdir is
// itself an event, and the watcher re-derives the tuple and descends.
//
// The walk stops at a DIRECTORY, not at anything that exists: a regular file
// in an ancestor position cannot hold the missing component, and a watch on
// it would report only its own name. The directory is canonical (realpath),
// so a path through a symlink names one target whether or not its leaf
// exists yet. `leaf` says the target is the candidate's own parent — the
// watch has stopped descending.
export function nearestWatchTarget(candidate: string): {
  readonly dir: string;
  readonly name: string;
  readonly leaf: boolean;
} {
  let name = path.basename(candidate);
  let dir = path.dirname(candidate);
  for (;;) {
    const real = canonicalDirectory(dir);
    if (real !== null)
      return { dir: real, name, leaf: dir === path.dirname(candidate) };
    name = path.basename(dir);
    dir = path.dirname(dir);
  }
}

// The directory's canonical path, or null when it is not one the walk can
// stop at — absent, unreadable, a file, or removed mid-walk (the walk runs
// inside watcher callbacks, during exactly the churn that races it, so one
// call answers both questions and nothing here can throw).
function canonicalDirectory(p: string): string | null {
  try {
    return fs.statSync(p).isDirectory() ? fs.realpathSync(p) : null;
  } catch {
    return null;
  }
}

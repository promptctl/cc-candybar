import fs from "node:fs";
import path from "node:path";

// [LAW:single-enforcer] The one rule for watching a path that may not exist
// yet: the step the rule for where a set of paths can change
// (`watchTargetsOf`, beside the watcher registry) takes for each hop of a
// link chain.
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
export function canonicalDirectory(p: string): string | null {
  try {
    return fs.statSync(p).isDirectory() ? fs.realpathSync(p) : null;
  } catch {
    return null;
  }
}

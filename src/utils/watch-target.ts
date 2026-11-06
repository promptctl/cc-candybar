import path from "node:path";
import type { Filesystem } from "../disk/filesystem.js";
import { existingAncestor } from "./on-disk-path";

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
export function nearestWatchTarget(
  filesystem: Filesystem,
  candidate: string,
): {
  readonly dir: string;
  readonly name: string;
  readonly leaf: boolean;
} {
  const { dir, rest } = existingAncestor(filesystem, path.dirname(candidate));
  return {
    dir,
    name: rest[0] ?? path.basename(candidate),
    leaf: rest.length === 0,
  };
}

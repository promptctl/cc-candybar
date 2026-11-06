import path from "node:path";
import type { Filesystem } from "../disk/filesystem.js";

// Where a write to a path lands and every link it passes on the way, read
// through the filesystem the caller holds: the writer's, or the watcher
// registry's, so a watch over the fake follows the fake's links.

// [LAW:single-enforcer] The file a write to `at` lands in: the last hop of
// its link chain, a dangling link's target included (it is the file a first
// write creates), so whoever removes what a write created removes the same
// file. The tmp sits beside the file, in whichever directory that is.
export function resolvedTarget(filesystem: Filesystem, at: string): string {
  return linkChain(filesystem, at).at(-1)!;
}

// The writer's view of `walkLinks`: the whole chain, or the reason it could
// not be walked.
export function linkChain(
  filesystem: Filesystem,
  at: string,
): readonly string[] {
  const { hops, stopped } = walkLinks(filesystem, at);
  if (stopped !== null) throw stopped;
  return hops;
}

// [LAW:types-are-the-program] How far a walk down a link chain got: every
// hop it reached, and why it stopped short of the chain's end, or `null` when
// it reached it.
export interface LinkWalk {
  readonly hops: readonly string[];
  readonly stopped: Error | null;
}

// [LAW:single-enforcer] Every path `at` passes through on the way to the
// file a write lands in: `at` itself, then each link's target in turn, the
// last entry a non-link or a path that does not exist. The writer wants the
// last; a watcher wants them all, because a chain's content changes wherever
// any one of its links is re-pointed, and a directory watch reports only its
// own children. A walk the kernel stops (a loop, an unreadable component)
// keeps the hops it reached, so a watcher still hears the directories it got
// to. A linked directory on the way
// needs resolving only where a relative link is read against it.
export function walkLinks(filesystem: Filesystem, at: string): LinkWalk {
  const hops = [at];
  try {
    for (let n = 0; n < MAX_LINK_HOPS; n++) {
      const next = linkTarget(filesystem, hops[hops.length - 1]!);
      if (next === null) return { hops, stopped: null };
      hops.push(next);
    }
    return {
      hops,
      stopped: new Error(`${at}: more than ${MAX_LINK_HOPS} symbolic links`),
    };
  } catch (e) {
    return { hops, stopped: e as Error };
  }
}

// Where the link at `file` points, or null when there is no link there to
// follow.
function linkTarget(filesystem: Filesystem, file: string): string | null {
  try {
    if (filesystem.lstatSync(file).kind !== "symlink") return null;
    // The kernel reads a relative link against the directory the link really
    // sits in, which a linked parent moves.
    return path.resolve(
      filesystem.realpathSync(path.dirname(file)),
      filesystem.readlinkSync(file),
    );
  } catch (e) {
    // [LAW:one-source-of-truth] Absent, or under an ancestor that is a
    // regular file, is one fact whichever call finds it: a link removed
    // after its lstat ends the chain exactly as one already gone does.
    const { code } = e as NodeJS.ErrnoException;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw e;
  }
}

// Linux's MAXSYMLINKS: past it the kernel calls a path a loop (ELOOP).
const MAX_LINK_HOPS = 40;

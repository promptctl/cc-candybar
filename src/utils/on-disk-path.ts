import path from "node:path";
import type { Filesystem } from "../disk/filesystem.js";

// [LAW:one-source-of-truth] A directory's on-disk spelling: one per directory,
// whatever links or letter case named it. The filesystem's realpath is the
// point: on a case-insensitive volume it returns the case the disk holds,
// where the JS walk keeps the case it was given.
//
// The directory's canonical path, or null when it is not one a walk can stop
// at: absent, unreadable, a file, or removed mid-walk (the watcher walks
// inside its own callbacks, during exactly the churn that races it, so one
// call answers both questions and nothing here can throw).
export function canonicalDirectory(
  filesystem: Filesystem,
  p: string,
): string | null {
  try {
    return filesystem.statSync(p).kind === "directory"
      ? filesystem.realpathSync(p)
      : null;
  } catch {
    return null;
  }
}

// [LAW:one-source-of-truth] The one walk to the deepest directory a path
// passes through that exists: that directory, canonical, and the names below
// it as named, top first. A spelling and a watch both stand on it.
export function existingAncestor(
  filesystem: Filesystem,
  p: string,
): {
  readonly dir: string;
  readonly rest: readonly string[];
} {
  const real = canonicalDirectory(filesystem, p);
  const parent = path.dirname(p);
  if (real !== null || parent === p) return { dir: real ?? p, rest: [] };
  const above = existingAncestor(filesystem, parent);
  return { dir: above.dir, rest: [...above.rest, path.basename(p)] };
}

// The spelling of a directory that may not exist yet, so one a first write
// makes is spelled as it will be once it exists. This decides a spelling,
// never presence: whatever reads the path reports what is wrong with it in
// its own form.
export function onDiskDirectory(filesystem: Filesystem, dir: string): string {
  const { dir: real, rest } = existingAncestor(filesystem, dir);
  return path.join(real, ...rest);
}

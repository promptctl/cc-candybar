import path from "node:path";
import type { Filesystem } from "../disk/filesystem.js";
import { systemFilesystem } from "../disk/system-filesystem.js";
import { resolvedTarget } from "./link-chain.js";
import { stagedPath } from "./staged-path.js";

// [LAW:single-enforcer] The one tmp+rename for every file a user may be
// reading while we write it — the config file, the settings history, and Claude
// Code's settings.json (the doctor fix and `install`), and the home's link-id
// counter: a reader never sees a
// torn file, and a rename that fails removes its tmp; when that removal fails
// too, the write's error names the tmp left behind in its message. Without a
// `mode` the existing file's mode survives (a hand-authored file keeps
// whatever the user gave it) and a first-ever file takes the process umask.
// A symlinked file is written where it points — a dotfiles-managed
// settings.json stays a link — since the rename replaces whatever sits at the
// path it targets; the directory it is written in is created when missing, as
// a link's target directory may be (a dotfiles tree not yet populated).
export function writeAtomicOn(
  disk: Filesystem,
  at: string,
  text: string,
  mode?: number,
): void {
  const file = resolvedTarget(disk, at);
  disk.mkdirSync(path.dirname(file));
  const tmp = stagedPath(file);
  // Taken before the tmp exists, so a stat that fails is the error the caller
  // sees, never a cleanup's of a tmp this write did not make.
  const fileMode = mode ?? existingMode(disk, file);
  try {
    // Flushed before the rename, so a system crash leaves the old file or the
    // new one: a rename can reach the disk before contents still in the page
    // cache, and the file then reads empty. A plain fsync reaches the drive's
    // own cache, which a power loss can still lose on macOS.
    disk.writeFileSync(tmp, text, { mode: fileMode, flush: true });
    disk.renameSync(tmp, file);
  } catch (e) {
    try {
      disk.rmSync(tmp);
    } catch (cleanup) {
      // [LAW:no-silent-failure] the leftover travels in the message every caller renders
      // The write's own failure stays the error, its `code` intact, since
      // callers branch on it; a cleanup that fails too (a directory no longer
      // searchable) is named beside it, never in its place.
      // [LAW:types-are-the-program] The port fails only with a FilesystemError,
      // so `instanceof Error` narrows the caught `unknown` and skips nothing.
      if (e instanceof Error) {
        e.message += `; staged file ${tmp} was left behind: ${cleanup instanceof Error ? cleanup.message : String(cleanup)}`;
      }
    }
    throw e;
  }
}

// [LAW:effects-at-boundaries] exception: the system disk, for the writers
// that do not hold a Filesystem yet (eslint.config.mjs's owners of
// `systemFilesystem` list this file while they do).
export function writeAtomic(at: string, text: string, mode?: number): void {
  writeAtomicOn(systemFilesystem, at, text, mode);
}

// The mode of the file a write replaces, or none for a first write.
function existingMode(disk: Filesystem, file: string): number | undefined {
  try {
    return disk.statSync(file).mode;
  } catch (e) {
    if ((e as { code?: string }).code === "ENOENT") return undefined;
    throw e;
  }
}

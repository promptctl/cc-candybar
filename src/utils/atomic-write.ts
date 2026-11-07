import path from "node:path";
import type { Filesystem } from "../disk/filesystem.js";
import { systemFilesystem } from "../disk/system-filesystem.js";
import { resolvedTarget } from "./link-chain.js";

// [LAW:single-enforcer] The one tmp+rename for every file a user may be
// reading while we write it — the config file, the settings history, and Claude
// Code's settings.json (the doctor fix and `install`), and the home's link-id
// counter: a reader never sees a
// torn file, and a rename that fails leaves no orphaned tmp behind. Without a
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
  const tmp = `${file}.tmp`;
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
    disk.rmSync(tmp);
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

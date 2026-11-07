import fs from "node:fs";
import path from "node:path";
import { systemFilesystem } from "../disk/system-filesystem.js";
import { resolvedTarget } from "./link-chain.js";

// [LAW:one-type-per-behavior] The one spelling of where a write stages its
// bytes before the rename that publishes them. The name carries this process's
// pid, because two processes write one file when they share a state directory
// (a daemon and a CLI): under one shared name, one's rename publishes the
// other's half-written bytes and the other's rename then finds nothing. Within
// a process a writer stages one write of a file at a time, and a writer that
// keeps two in flight tells them apart by suffix.
export function stagedPath(file: string, suffix = "tmp"): string {
  return `${file}.${process.pid}.${suffix}`;
}

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
export function writeAtomic(at: string, text: string, mode?: number): void {
  const file = resolvedTarget(systemFilesystem, at);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = stagedPath(file);
  const fileMode = mode ?? fs.statSync(file, { throwIfNoEntry: false })?.mode;
  try {
    // Flushed before the rename, so a system crash leaves the old file or the
    // new one: a rename can reach the disk before contents still in the page
    // cache, and the file then reads empty. A plain fsync reaches the drive's
    // own cache, which a power loss can still lose on macOS.
    const fd = fs.openSync(tmp, "w", fileMode);
    try {
      fs.writeFileSync(fd, text);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

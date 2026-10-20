import fs from "node:fs";
import path from "node:path";

// [LAW:single-enforcer] The one tmp+rename for every file a user may be
// reading while we write it — the config file, the settings history, and Claude
// Code's settings.json (the doctor fix and `install`): a reader never sees a
// torn file, and a rename that fails leaves no orphaned tmp behind. Without a
// `mode` the existing file's mode survives (a hand-authored file keeps
// whatever the user gave it) and a first-ever file takes the process umask.
// A symlinked file is written where it points — a dotfiles-managed
// settings.json stays a link — since the rename replaces whatever sits at the
// path it targets; the directory it is written in is created when missing, as
// a link's target directory may be (a dotfiles tree not yet populated).
export function writeAtomic(at: string, text: string, mode?: number): void {
  const file = resolvedTarget(at);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  const fileMode = mode ?? fs.statSync(file, { throwIfNoEntry: false })?.mode;
  try {
    fs.writeFileSync(
      tmp,
      text,
      fileMode === undefined ? {} : { mode: fileMode },
    );
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

// [LAW:single-enforcer] The file a write to `at` lands in: `at` followed
// through every symbolic link, a dangling one included (its target is the file
// a first write creates), so whoever removes what a write created removes the
// same file. A linked directory on the way needs resolving only where a
// relative link is read against it; the tmp sits beside the file, in
// whichever directory that is.
export function resolvedTarget(at: string): string {
  let file = at;
  for (let hops = 0; hops < MAX_LINK_HOPS; hops++) {
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return file;
      throw e;
    }
    if (!stat.isSymbolicLink()) return file;
    // The kernel reads a relative link against the directory the link really
    // sits in, which a linked parent moves.
    file = path.resolve(
      fs.realpathSync(path.dirname(file)),
      fs.readlinkSync(file),
    );
  }
  throw new Error(`${at}: more than ${MAX_LINK_HOPS} symbolic links`);
}

// Linux's MAXSYMLINKS: past it the kernel calls a path a loop (ELOOP).
const MAX_LINK_HOPS = 40;

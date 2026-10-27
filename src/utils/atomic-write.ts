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

// [LAW:single-enforcer] The file a write to `at` lands in: the last hop of
// its link chain, a dangling link's target included (it is the file a first
// write creates), so whoever removes what a write created removes the same
// file. The tmp sits beside the file, in whichever directory that is.
export function resolvedTarget(at: string): string {
  return linkChain(at).at(-1)!;
}

// [LAW:single-enforcer] Every path `at` passes through on the way to the
// file a write lands in: `at` itself, then each link's target in turn, the
// last entry a non-link or a path that does not exist. The writer wants the
// last; a watcher wants them all, because a chain's content changes wherever
// any one of its links is re-pointed, and a directory watch reports only its
// own children. A linked directory on the way needs resolving only where a
// relative link is read against it.
export function linkChain(at: string): readonly string[] {
  const chain = [at];
  for (let hops = 0; hops < MAX_LINK_HOPS; hops++) {
    const file = chain[chain.length - 1]!;
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return chain;
      throw e;
    }
    if (!stat.isSymbolicLink()) return chain;
    // The kernel reads a relative link against the directory the link really
    // sits in, which a linked parent moves.
    chain.push(
      path.resolve(fs.realpathSync(path.dirname(file)), fs.readlinkSync(file)),
    );
  }
  throw new Error(`${at}: more than ${MAX_LINK_HOPS} symbolic links`);
}

// Linux's MAXSYMLINKS: past it the kernel calls a path a loop (ELOOP).
const MAX_LINK_HOPS = 40;

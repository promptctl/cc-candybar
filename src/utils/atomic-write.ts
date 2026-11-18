import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

// [LAW:single-enforcer] The one staging for every file another process may
// read or write while this one writes it: the bytes are written whole under a
// name of their own, synced, then published, and the staged file is gone
// whatever happens short of a kill. A fault in any of it is fixed here for
// every writer.
//
// [LAW:no-ambient-temporal-coupling] The staged name is unique to the call,
// so writers of one file, in one process or many, never publish or remove
// each other's bytes. The bytes are synced before the publish, since a
// publish can reach the disk ahead of the bytes it names and a crash then
// leaves an empty file under the published name; `flush` syncs before the
// close, and on macOS libuv's sync is F_FULLFSYNC, which flushes the drive's
// cache where a plain fsync stops short of it.

// Publishes by rename: the last complete write wins.
export function publishByRename(
  file: string,
  bytes: string | Uint8Array,
  mode?: number,
): void {
  const staged = stagedName(file);
  try {
    fs.writeFileSync(staged, bytes, { flag: "wx", mode, flush: true });
    fs.renameSync(staged, file);
  } catch (e) {
    throw leftBehind(e, staged);
  }
}

// [LAW:effects-at-boundaries] `publishByRename` on the thread pool, for a
// writer on the daemon's one thread: a slow disk's write, sync or rename then
// holds no bar and no click. One contract, held by one test suite over both.
export async function publishByRenameAsync(
  file: string,
  bytes: string | Uint8Array,
  mode?: number,
): Promise<void> {
  const staged = stagedName(file);
  try {
    await fs.promises.writeFile(staged, bytes, {
      flag: "wx",
      mode,
      flush: true,
    });
    await fs.promises.rename(staged, file);
  } catch (e) {
    throw leftBehind(e, staged);
  }
}

// [LAW:types-are-the-program] What a link publish comes to: a link lands
// only where nothing is, so the first write wins and a later one finds the
// name taken. That is an outcome, not a failure.
export type Linked = "published" | "taken";

export function publishByLink(
  file: string,
  bytes: string | Uint8Array,
  mode?: number,
): Linked {
  const staged = stagedName(file);
  let linked: Linked;
  try {
    fs.writeFileSync(staged, bytes, { flag: "wx", mode, flush: true });
    linked = taken(() => fs.linkSync(staged, file));
  } catch (e) {
    throw leftBehind(e, staged);
  }
  // [LAW:no-silent-failure] The publish stands either way; a staged name
  // that will not go is said, with the outcome it came after.
  try {
    fs.rmSync(staged);
  } catch (e) {
    throw new Error(
      `${file}: ${linked}, but the staged file ${staged} was left behind: ${(e as Error).message}`,
    );
  }
  return linked;
}

function taken(link: () => void): Linked {
  try {
    link();
    return "published";
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return "taken";
    throw e;
  }
}

// Beside the file, so the publish stays on one filesystem. A pid alone is
// shared by two writes in one process and repeats across pid namespaces.
function stagedName(file: string): string {
  return `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
}

// [LAW:no-silent-failure] The write's own error is the error, since callers
// branch on its `code`: the staged file is removed, and a removal that fails
// too is added to that error's message, never put in its place.
function leftBehind(e: unknown, staged: string): unknown {
  try {
    fs.rmSync(staged, { force: true });
  } catch (c) {
    (e as Error).message +=
      `; the staged file ${staged} was left behind: ${(c as Error).message}`;
  }
  return e;
}

// The tmp+rename for every file a user may be reading while we write it —
// the config file, the settings history, and Claude Code's settings.json (the
// doctor fix and `install`): a reader never sees a torn file. Without a
// `mode` the existing file's mode survives (a hand-authored file keeps
// whatever the user gave it) and a first-ever file takes the process umask.
// A symlinked file is written where it points — a dotfiles-managed
// settings.json stays a link — since the rename replaces whatever sits at the
// path it targets; the directory it is written in is created when missing, as
// a link's target directory may be (a dotfiles tree not yet populated).
export function writeAtomic(at: string, text: string, mode?: number): void {
  const file = resolvedTarget(at);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  publishByRename(
    file,
    text,
    mode ?? fs.statSync(file, { throwIfNoEntry: false })?.mode,
  );
}

// [LAW:one-source-of-truth] A config file's text, or null when it does not
// exist: how the renderer and the host both read one.
export function readConfigText(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
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

// The writer's view of `walkLinks`: the whole chain, or the reason it could
// not be walked.
export function linkChain(at: string): readonly string[] {
  const { hops, stopped } = walkLinks(at);
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
export function walkLinks(at: string): LinkWalk {
  const hops = [at];
  try {
    for (let n = 0; n < MAX_LINK_HOPS; n++) {
      const next = linkTarget(hops[hops.length - 1]!);
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
function linkTarget(file: string): string | null {
  try {
    if (!fs.lstatSync(file).isSymbolicLink()) return null;
    // The kernel reads a relative link against the directory the link really
    // sits in, which a linked parent moves.
    return path.resolve(
      fs.realpathSync(path.dirname(file)),
      fs.readlinkSync(file),
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

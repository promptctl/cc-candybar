import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

// How staged bytes take the published name. A rename replaces whatever is
// there, so the last complete write wins; a link lands only where nothing is,
// so the first one does, and a link that finds the name taken publishes
// nothing.
export type PublishBy = "rename" | "link";

export interface Publishing {
  readonly by: PublishBy;
  // The staged file's mode, through the umask. Without it the process's
  // default applies.
  readonly mode?: number;
  // Asked once the bytes are on disk, with the name they are staged under:
  // false discards them and publishes nothing. The session state file's
  // debounced write is superseded here by a flush that landed meanwhile.
  readonly admit?: (staged: string) => boolean;
}

// [LAW:single-enforcer] The one stage-and-publish for every file another
// process may read or write while this one writes it. Staging, syncing,
// publishing and cleanup live here and nowhere else, so a defect in any of
// them is fixed once for every writer.
//
// [LAW:no-ambient-temporal-coupling] Each call stages under a name of its
// own, so writers of one file, in one process or many, never publish or
// remove each other's staged bytes. The bytes are synced before the publish:
// a publish can reach the disk ahead of the bytes it names, which a crash
// turns into an empty file under the published name. On macOS libuv's fsync
// is F_FULLFSYNC, which also flushes the drive's cache, where a plain fsync
// stops short of it.
//
// True when the bytes were published; false when `admit` declined them or a
// link found the name taken. The staged file never outlives the call.
export function publish(
  file: string,
  bytes: string | Uint8Array,
  { by, mode, admit = admitted }: Publishing,
): boolean {
  const staged = stagedName(file);
  let published: boolean;
  try {
    const fd = fs.openSync(staged, "wx", mode);
    try {
      fs.writeFileSync(fd, bytes);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    published = admit(staged) && lands(by, () => PUBLISH[by](staged, file));
  } catch (e) {
    throw withCleanup(e, staged);
  }
  fs.rmSync(staged, { force: true });
  return published;
}

// [LAW:one-type-per-behavior] `publish` off the daemon's one thread: every
// step runs on the thread pool, so a disk that is slow to write, sync or
// rename holds no bar and no click.
export async function publishAsync(
  file: string,
  bytes: string | Uint8Array,
  { by, mode, admit = admitted }: Publishing,
): Promise<boolean> {
  const staged = stagedName(file);
  let published: boolean;
  try {
    const handle = await fs.promises.open(staged, "wx", mode);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    published =
      admit(staged) &&
      (await PUBLISH_ASYNC[by](staged, file).then(
        () => true,
        (e: unknown) => lostTheLink(by, e),
      ));
  } catch (e) {
    throw withCleanup(e, staged);
  }
  await fs.promises.rm(staged, { force: true });
  return published;
}

const admitted = (): boolean => true;

const PUBLISH: Record<PublishBy, (staged: string, file: string) => void> = {
  rename: (staged, file) => fs.renameSync(staged, file),
  link: (staged, file) => fs.linkSync(staged, file),
};

const PUBLISH_ASYNC: Record<
  PublishBy,
  (staged: string, file: string) => Promise<void>
> = {
  rename: (staged, file) => fs.promises.rename(staged, file),
  link: (staged, file) => fs.promises.link(staged, file),
};

function lands(by: PublishBy, run: () => void): boolean {
  try {
    run();
    return true;
  } catch (e) {
    return lostTheLink(by, e);
  }
}

// [LAW:one-source-of-truth] A link that finds the name taken lost to a write
// that already landed: that is the outcome a link publishes by, not a
// failure. Anything else is.
function lostTheLink(by: PublishBy, e: unknown): false {
  if (by === "link" && (e as NodeJS.ErrnoException).code === "EEXIST")
    return false;
  throw e;
}

// Beside the file, so the publish stays on one filesystem; unique to the
// call, since a pid alone is shared by two writes in one process and can
// repeat across pid namespaces.
function stagedName(file: string): string {
  return `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
}

// [LAW:no-silent-failure] The write's own error is the error: callers branch
// on its `code`. A cleanup that also fails leaves the staged file behind, so
// its path and reason are added to the write's message, never put in its
// place.
function withCleanup(e: unknown, staged: string): unknown {
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
  publish(file, text, {
    by: "rename",
    mode: mode ?? fs.statSync(file, { throwIfNoEntry: false })?.mode,
  });
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

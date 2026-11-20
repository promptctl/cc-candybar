import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { types } from "node:util";

// [LAW:single-enforcer] Writing a file whole beside its readers: the bytes
// are written under a name of their own, then published by one rename or
// link, so a reader never sees a torn file. A failed write removes what it
// staged, or its error says it could not.
//
// [LAW:no-ambient-temporal-coupling] The staged name is unique to the call,
// so writers of one file, in one process or many, never publish or remove
// each other's bytes. Nothing is synced: these writes run on a click or at a
// start, often on the daemon's one thread, and a sync there holds every bar
// for a drive-cache flush.
//
// A `mode` is the file's mode exactly, past the umask; without one a new
// file takes the umask's.

// Publishes by rename: the last complete write wins.
export function publishByRename(
  file: string,
  bytes: string | Uint8Array,
  mode?: number,
): void {
  const staged = stagedName(file);
  try {
    fs.writeFileSync(staged, bytes, { flag: "wx", mode });
    if (mode !== undefined) fs.chmodSync(staged, mode);
    fs.renameSync(staged, file);
  } catch (e) {
    throw noted(
      e,
      staged,
      failure(() => fs.rmSync(staged, { force: true })),
    );
  }
}

// [LAW:effects-at-boundaries] `publishByRename` on the thread pool, for a
// writer on the daemon's one thread whose disk may be slow: its write,
// rename and cleanup hold no bar and no click. One contract, held by one
// test suite over both.
export async function publishByRenameAsync(
  file: string,
  bytes: string | Uint8Array,
  mode?: number,
): Promise<void> {
  const staged = stagedName(file);
  try {
    await fs.promises.writeFile(staged, bytes, { flag: "wx", mode });
    if (mode !== undefined) await fs.promises.chmod(staged, mode);
    await fs.promises.rename(staged, file);
  } catch (e) {
    const removal = await fs.promises
      .rm(staged, { force: true })
      .then(() => null, asError);
    throw noted(e, staged, removal);
  }
}

// [LAW:types-are-the-program] What a link publish comes to: a link lands
// only where nothing is, so the first write wins and a later one finds the
// name taken. That is an outcome, not a failure. A staged name that would not
// go after the link is said beside the outcome, which stands either way.
export interface Linked {
  readonly outcome: "published" | "taken";
  readonly leftover: string | null;
}

export function publishByLink(
  file: string,
  bytes: string | Uint8Array,
  mode?: number,
): Linked {
  const staged = stagedName(file);
  let outcome: Linked["outcome"];
  try {
    fs.writeFileSync(staged, bytes, { flag: "wx", mode });
    if (mode !== undefined) fs.chmodSync(staged, mode);
    outcome = taken(() => fs.linkSync(staged, file));
  } catch (e) {
    throw noted(
      e,
      staged,
      failure(() => fs.rmSync(staged, { force: true })),
    );
  }
  const removal = failure(() => fs.rmSync(staged, { force: true }));
  return {
    outcome,
    leftover:
      removal === null ? null : `${staged} was left behind: ${removal.message}`,
  };
}

function taken(link: () => void): Linked["outcome"] {
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
export function stagedName(file: string): string {
  return `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
}

// What a step threw, or null when it ran.
function failure(step: () => void): Error | null {
  try {
    step();
    return null;
  } catch (e) {
    return asError(e);
  }
}

// [LAW:parse-dont-validate] Whatever was thrown, as an Error. isNativeError,
// not instanceof: Node's own errors can come from another realm.
export function asError(thrown: unknown): Error {
  return types.isNativeError(thrown) ? thrown : new Error(String(thrown));
}

// [LAW:no-silent-failure] The write's own error is the error, since callers
// branch on its `code`; a staged file its removal could not take is added to
// that error's message, never put in its place.
function noted(e: unknown, staged: string, removal: Error | null): Error {
  const error = asError(e);
  if (removal !== null)
    error.message += `; the staged file ${staged} was left behind: ${removal.message}`;
  return error;
}

// The write for every file a user may be reading while we write it — the
// config file, the settings history, and Claude Code's settings.json (the
// doctor fix and `install`): published by rename. Without a `mode` the
// existing file's mode survives (a hand-authored file keeps whatever the user
// gave it) and a first-ever file takes the process umask.
// A symlinked file is written where it points — a dotfiles-managed
// settings.json stays a link — since the rename replaces whatever sits at the
// path it targets; the directory it is written in is created when missing, as
// a link's target directory may be (a dotfiles tree not yet populated).
export function writeAtomic(at: string, text: string, mode?: number): void {
  const file = resolvedTarget(at);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  publishByRename(file, text, mode ?? filePermissions(file));
}

export function filePermissions(file: string): number | undefined {
  const mode = fs.statSync(file, { throwIfNoEntry: false })?.mode;
  // A file's permission bits, never its type's.
  return mode === undefined ? undefined : mode & 0o777;
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
// last; a watcher polls them all, because a chain's content changes wherever
// any one of its links is re-pointed. A walk the kernel stops (a loop, an
// unreadable component) keeps the hops it reached, so a watcher still hears
// the paths it got to. A linked directory on the way
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

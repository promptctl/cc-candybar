// [LAW:single-enforcer] The daemon's side of the disk: a directory tree's
// contents and the events a watch on it hears, as one port, because the two
// are one territory. A write is what a watch reports, so a fake that holds
// files apart from a fake that emits events could disagree in ways neither
// contract catches. src/disk/system-filesystem.ts is the adapter over `fs`;
// src/disk/filesystem-fake.ts is the in-memory tree tests build; the contract
// both pass is test/contract/filesystem.contract.ts.
//
// Operations are the ones the port's consumers call, in Node's names and
// shapes, so an adapter translates nothing it does not have to.

// [LAW:types-are-the-program] What is at a path. `dev`, `ino` and
// `birthtimeNs` are bigint, because a folder's identity (src/utils/
// folder-identity.ts) needs 64-bit inodes and nanosecond birth times.
export interface Stat {
  readonly kind: "file" | "directory" | "symlink" | "other";
  readonly size: number;
  readonly mtimeMs: number;
  readonly mode: number;
  readonly dev: bigint;
  readonly ino: bigint;
  readonly birthtimeNs: bigint;
}

// [LAW:no-silent-failure] Every failure carries the errno `code` callers
// branch on, the `path` it names, and Node's message text, which the doctor
// and the watch faults print as they are.
export interface FilesystemError extends Error {
  readonly code: string;
  readonly path: string;
}

export interface DirectoryEntry {
  readonly name: string;
  readonly kind: Stat["kind"];
}

// What a watch hears: Node's event type, and the child it names, or `null`
// when the OS named none. Never delivered on the turn of the write that
// caused it.
export type WatchListener = (
  event: "rename" | "change",
  name: string | null,
) => void;

// An open directory watch. `onError`: the watch failed after it opened and
// delivers nothing more.
export interface Watch {
  close(): void;
  onError(listener: (error: Error) => void): void;
}

export interface Filesystem {
  statSync(path: string): Stat;
  lstatSync(path: string): Stat;
  readlinkSync(path: string): string;
  realpathSync(path: string): string;
  // mkdir -p: every missing ancestor too, and no error when it exists.
  mkdirSync(path: string): void;
  // Opens the directory and closes it: the check that it can be listed,
  // without reading its entries.
  opendirSync(path: string): void;
  stat(path: string): Promise<Stat>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, text: string): Promise<void>;
  readdir(path: string): Promise<readonly DirectoryEntry[]>;
  unlink(path: string): Promise<void>;
  // [LAW:no-silent-failure] Throws when the OS refuses the watch.
  watch(
    dir: string,
    options: { readonly recursive: boolean },
    listener: WatchListener,
  ): Watch;
}

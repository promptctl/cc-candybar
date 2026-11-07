import type { Filesystem } from "../disk/filesystem.js";

// What tells one folder from another across a delete and a create: device and
// inode name a folder that exists now, and birth time is there because ext4
// reuses a freed inode number. `gone`: nothing is at the path.
//
// Birth time is null where the host supplies none (src/disk/birthtime-probe.ts),
// because a ctime copy would move on every child write. There, a folder deleted
// and made again on an inode number ext4 reuses reads as the same folder, and
// a Linux watch on it stays deaf until its key moves for another reason: birth
// time is the only stat-visible field that tells the two apart, and Node
// reports a watched directory's own deletion under the same name as a child of
// that name, so nothing else covers the case without a Linux-only rule in the
// registry. A filesystem without birth time already lives with this.
//
// [LAW:one-source-of-truth] The one notion of a directory's identity, shared
// by every owner that must know whether a path still names the directory it
// bound: a watch binds an inode (Linux's inotify follows the inode, not the
// path), so a directory recreated at its path is a new one to the watch.
export interface FolderIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly birthtimeNs: bigint | null;
}
// [LAW:effects-at-boundaries] The disk's answer. A stat that fails for any
// reason but a missing path throws: the folder cannot be judged.
export const statIdentity = (
  filesystem: Filesystem,
  folder: string,
): FolderIdentity | "gone" => {
  try {
    const st = filesystem.statSync(folder);
    return { dev: st.dev, ino: st.ino, birthtimeNs: st.birthtimeNs };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return "gone";
    throw e;
  }
};

export const sameIdentity = (a: FolderIdentity, b: FolderIdentity): boolean =>
  a.dev === b.dev && a.ino === b.ino && a.birthtimeNs === b.birthtimeNs;

// [LAW:one-source-of-truth] One spelling of an identity for a key: a watch
// keyed on it is the watch on exactly these inodes, and "the directory at this
// path moved" and "the key changed" are one fact.
export const identityKey = (identity: FolderIdentity | "gone"): string =>
  identity === "gone"
    ? "gone"
    : `${identity.dev}:${identity.ino}:${identity.birthtimeNs ?? "none"}`;

// What a watch on the path binds: the directory there, or nothing yet, because
// nothing is at the path (`gone`) or the directory cannot be stat'd
// (`unreadable`, a permission, a symlink loop, a mount's fault). A watch names
// a directory, it does not judge it, so [LAW:no-silent-failure] the failure is
// spelled, never thrown; a storage owner that must judge its folder takes
// `statIdentity`'s throw instead, and reports its message as the folder's
// fault.
export type Bound = FolderIdentity | "gone" | { readonly unreadable: string };

export const boundOf = (filesystem: Filesystem, folder: string): Bound => {
  try {
    return statIdentity(filesystem, folder);
  } catch (e) {
    return { unreadable: (e as NodeJS.ErrnoException).code ?? String(e) };
  }
};

// One spelling of what a watch binds, for a key: it moves exactly when the
// directory at the path does, or when it comes and goes.
export const boundKey = (bound: Bound): string =>
  typeof bound === "string" || "ino" in bound
    ? identityKey(bound)
    : `unreadable:${bound.unreadable}`;

// Whether a watch on the path binds a folder now, not nothing yet.
export const bindsFolder = (bound: Bound): bound is FolderIdentity =>
  typeof bound !== "string" && "ino" in bound;

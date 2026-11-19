import fs from "node:fs";
import path from "node:path";
import type { Layer } from "../../config/config-snapshot.js";
import { checkoutOf, worktreeLink } from "../../utils/git-root.js";
import { presence, type Unchecked } from "../../utils/presence.js";
import { listFolders } from "./plugin-folders.js";

export type TextRead = Exclude<Layer["content"], { kind: "absent" }>;

export interface DiscoveryFiles {
  readonly presence: typeof presence;
  readonly directory: (path: string) => string | Unchecked;
  readonly folders: typeof listFolders;
  readonly text: (path: string) => TextRead;
  readonly worktree: typeof worktreeLink;
  readonly checkout: typeof checkoutOf;
}

export const diskFiles: DiscoveryFiles = {
  presence,
  directory(dir) {
    try {
      return fs.realpathSync.native(dir);
    } catch (e) {
      return { path: dir, error: (e as Error).message };
    }
  },
  folders: listFolders,
  text(file) {
    try {
      return { kind: "text", text: fs.readFileSync(file, "utf-8") };
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      return {
        kind: "unreadable",
        error: err.code === "EISDIR" ? "not a file" : err.message,
      };
    }
  },
  worktree: worktreeLink,
  checkout: checkoutOf,
};

// The physical path keys the shared bytes. Each caller names its own path
// in diagnostics, including installs staging under a temporary directory.
export function readNamedText(
  files: DiscoveryFiles,
  directory: string,
  name: string,
): TextRead {
  const physical = path.join(directory, path.basename(name));
  const read = files.text(physical);
  return read.kind === "unreadable"
    ? { ...read, error: read.error.replace(`'${physical}'`, () => `'${name}'`) }
    : read;
}

function oncePerPath<T>(read: (file: string) => T): (file: string) => T {
  const readings = new Map<string, T>();
  return (file) => {
    const held = readings.get(file);
    if (held !== undefined) return held;
    const observed = read(file);
    readings.set(file, observed);
    return observed;
  };
}

// [LAW:one-source-of-truth] Origins rediscovered together share the first
// observation of each path, including absence and failures. Nothing in this
// object survives into a later batch.
export function discoveryFiles(
  files: DiscoveryFiles = diskFiles,
): DiscoveryFiles {
  return {
    presence: oncePerPath(files.presence),
    directory: oncePerPath(files.directory),
    folders: oncePerPath(files.folders),
    text: oncePerPath(files.text),
    worktree: oncePerPath(files.worktree),
    checkout: oncePerPath(files.checkout),
  };
}

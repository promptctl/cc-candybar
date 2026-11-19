import fs from "node:fs";
import path from "node:path";
import { types } from "node:util";
import type { Layer } from "../../config/config-snapshot.js";
import {
  checkoutOf,
  worktreeLink,
  type Checkout,
  type WorktreeLink,
} from "../../utils/git-root.js";
import { oncePerPath } from "../../utils/once-per-path.js";
import { presence, type Unchecked } from "../../utils/presence.js";
import { readRegularTextSync } from "../../utils/regular-text.js";
import { listFolders } from "./plugin-folders.js";

export type TextRead = Exclude<Layer["content"], { kind: "absent" }>;

export interface DiscoveryFiles {
  readonly presence: typeof presence;
  readonly realpath: (path: string) => string | Unchecked;
  readonly folders: typeof listFolders;
  readonly text: (path: string) => TextRead;
  readonly worktree: (dir: string) => WorktreeLink;
  readonly checkout: (cwd: string) => Checkout;
}

// [LAW:no-silent-failure] The raw read reports its cause. Named layers and
// definitions attach their own authored path after reading shared bytes.
export function textFrom(
  read: (file: string) => string,
): DiscoveryFiles["text"] {
  return (file) => {
    try {
      return { kind: "text", text: read(file) };
    } catch (e) {
      return {
        kind: "unreadable",
        error: types.isNativeError(e) ? e.message : String(e),
      };
    }
  };
}

export const diskFiles: DiscoveryFiles = {
  presence,
  realpath(file) {
    try {
      return fs.realpathSync.native(file);
    } catch (e) {
      return { path: file, error: (e as Error).message };
    }
  },
  folders: listFolders,
  text: textFrom(readRegularTextSync),
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
  const entry = path.join(directory, path.basename(name));
  const resolved = files.realpath(entry);
  // If the name cannot be resolved, the read retains its actual error. In
  // particular a missing installed definition is reported as an open failure.
  const physical = typeof resolved === "string" ? resolved : entry;
  const read = files.text(physical);
  return read.kind === "unreadable"
    ? { ...read, error: read.error.replace(`'${physical}'`, () => `'${name}'`) }
    : read;
}

// [LAW:one-source-of-truth] Origins rediscovered together share the first
// observation of each path, including absence and failures. Nothing in this
// object survives into a later batch.
export function discoveryFiles(
  files: DiscoveryFiles = diskFiles,
): DiscoveryFiles {
  return {
    presence: oncePerPath(files.presence),
    realpath: oncePerPath(files.realpath),
    folders: oncePerPath(files.folders),
    text: oncePerPath(files.text),
    worktree: oncePerPath(files.worktree),
    checkout: oncePerPath(files.checkout),
  };
}

import path from "node:path";
import { oncePerPath } from "./once-per-path.js";
import type { Unchecked } from "./presence.js";
import { canonicalDirectory } from "./watch-target.js";

// [LAW:one-source-of-truth] An atomic rename changes a directory entry.
// Resolve parent aliases, including the existing ancestor of a future file.
// Keep the final name so replacing one hardlink leaves another independent.
// The caller resolves the terminal symlink when the operation follows it.
export function directoryEntries(
  realpath: (dir: string) => string | Unchecked | null = canonicalDirectory,
): (file: string) => string {
  const directory: (at: string) => string = oncePerPath((at) => {
    const actual = realpath(at);
    if (typeof actual === "string") return actual;
    const parent = path.dirname(at);
    return at === parent ? at : path.join(directory(parent), path.basename(at));
  });
  return (file) =>
    path.join(directory(path.dirname(file)), path.basename(file));
}

import fs from "node:fs";

// The directory's canonical path, or null when it is not a directory —
// absent, unreadable, a file, or removed mid-call (it runs inside watcher
// callbacks, during exactly the churn that races it, so one call answers
// both questions and nothing here can throw). Canonical (realpath), so a
// directory reached through a symlink names one OS watch.
export function canonicalDirectory(p: string): string | null {
  try {
    return fs.statSync(p).isDirectory() ? fs.realpathSync(p) : null;
  } catch {
    return null;
  }
}

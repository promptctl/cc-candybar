// Whether a file is there, as one stat finds it.

import fs from "node:fs";

// [LAW:types-are-the-program] One stat, carried as the fact it found rather
// than collapsed to a boolean: `fs.existsSync` answers false to EVERY stat
// failure, so a file behind an unsearchable directory resolved as "not found"
// — a permissions problem reported as a wrong path. Only ENOENT is `absent`;
// any other failure is an `Unchecked` location stat could not see past, which
// the caller carries as data — no consumer guesses whether a file is there.
export interface Unchecked {
  readonly path: string;
  readonly error: string;
}
export type Presence = "present" | "absent" | Unchecked;
export function presence(path: string): Presence {
  try {
    return fs.statSync(path, { throwIfNoEntry: false }) === undefined
      ? "absent"
      : "present";
  } catch (e) {
    return { path, error: (e as Error).message };
  }
}

import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";

export const JEST_TMP_PREFIX = "cc-candybar-jest-";

// [LAW:one-source-of-truth] A jest worker's own directory, unique per test file
// and named for the worker that made it: the name is how another run's global
// teardown tells a directory still in use from one left behind.
export function jestTmpDir(kind: string): string {
  return path.join(
    os.tmpdir(),
    `${JEST_TMP_PREFIX}${kind}-${process.pid}-${crypto.randomUUID()}`,
  );
}

// The worker a directory's name says made it, or null for a name that says none.
export function jestTmpOwner(name: string): number | null {
  const pid = new RegExp(`^${JEST_TMP_PREFIX}[a-z]+-(\\d+)-`).exec(name)?.[1];
  return pid === undefined ? null : Number(pid);
}

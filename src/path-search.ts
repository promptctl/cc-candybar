// A PATH search, as a shell typing a command's name performs it: what the
// attach preload runs `node` by, and what lane B's restart line names
// `claude` by (src/daemon/lane-setup.ts).

import fs from "node:fs";
import path from "node:path";

// The first executable named `name` on `pathVariable`, as a shell typing
// `name` would find it. Only absolute entries: a relative one would resolve
// against whatever directory the session was started in.
export function executableOn(
  name: string,
  pathVariable: string | undefined,
  isExecutable: (file: string) => boolean,
): string | null {
  for (const dir of (pathVariable ?? "").split(path.delimiter)) {
    if (!path.isAbsolute(dir)) continue;
    const file = path.join(dir, name);
    if (isExecutable(file)) return file;
  }
  return null;
}

// [LAW:one-source-of-truth] Whether `file` is a regular file this user may
// open in `mode` (`fs.constants.X_OK`: run it, as a PATH search takes one —
// a directory carries the execute bit and is no command).
export function regularFileWith(file: string, mode: number): boolean {
  try {
    fs.accessSync(file, mode);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

// A path with its links resolved, or — naming nothing on disk — its own
// spelling, absolute: the one identity a typed path and a loaded one share.
export function canonical(file: string): string {
  try {
    return fs.realpathSync(file);
  } catch {
    return path.resolve(file);
  }
}

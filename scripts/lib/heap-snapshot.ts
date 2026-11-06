// A heap snapshot of a daemon a script spawned, written by the daemon itself.
//
// [LAW:one-source-of-truth] The one way a script asks a daemon for its heap:
// Node's own signal-triggered snapshot (`--heapsnapshot-signal`, written under
// `--diagnostic-dir`), so no script carries a snapshot writer of its own. The
// load gate and capture-heap both spawn with `heapSnapshotArgs` and ask with
// `heapSnapshot`; a second copy of the wait would drift on what "whole" means.

import fs from "node:fs";
import path from "node:path";

export const HEAP_SNAPSHOT_SIGNAL = "SIGUSR2";

// The daemon's argv (or NODE_OPTIONS, joined by spaces) that makes the signal
// write a snapshot under `dir`.
export function heapSnapshotArgs(dir: string): string[] {
  return [
    `--heapsnapshot-signal=${HEAP_SNAPSHOT_SIGNAL}`,
    `--diagnostic-dir=${dir}`,
  ];
}

// V8 streams the file under its final name, so a file is whole when its size
// has stopped moving and it ends with the JSON's closing brace.
function endsWithBrace(file: string, size: number): boolean {
  const fd = fs.openSync(file, "r");
  try {
    const tail = Buffer.alloc(Math.min(size, 16));
    fs.readSync(fd, tail, 0, tail.length, size - tail.length);
    return tail.toString("utf8").trimEnd().endsWith("}");
  } finally {
    fs.closeSync(fd);
  }
}

// The snapshots `pid` has written under `dir`: V8 names each for the pid that
// wrote it, so another process's snapshot there is never this daemon's.
function snapshotsOf(dir: string, pid: number): string[] {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".heapsnapshot") && f.includes(`.${pid}.`))
    .map((f) => path.join(dir, f));
}

// [LAW:no-silent-failure] Asks `pid` for a snapshot and answers the path of
// the new whole file, or throws once `waitMs` has passed without one. The
// daemon collects before it snapshots, so a heap read after this is what is
// live. A snapshot of a heap of hundreds of MB takes the daemon tens of
// seconds, during which it answers nothing.
export async function heapSnapshot(
  pid: number,
  dir: string,
  waitMs: number,
): Promise<string> {
  const before = new Set(snapshotsOf(dir, pid));
  process.kill(pid, HEAP_SNAPSHOT_SIGNAL);
  const deadline = Date.now() + waitMs;
  let lastSize = -1;
  for (;;) {
    const found = snapshotsOf(dir, pid).find((f) => !before.has(f));
    const size = found === undefined ? -1 : fs.statSync(found).size;
    if (
      found !== undefined &&
      size > 0 &&
      size === lastSize &&
      endsWithBrace(found, size)
    ) {
      return found;
    }
    lastSize = size;
    if (Date.now() > deadline) {
      throw new Error(`no whole snapshot in ${dir} after ${waitMs} ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

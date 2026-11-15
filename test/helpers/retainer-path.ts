import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import v8 from "node:v8";

const RETAINERS = join(__dirname, "..", "..", "scripts", "heap-retainers.mjs");

// [LAW:verifiable-goals] Who holds an instance of `className` on the heap: one
// path from the heap's roots per instance that a strong path reaches, each a
// list of lines ending in the instance. The snapshot collects before it is
// written, so what it shows is what a collection would keep, and an empty list
// says nothing holds an instance, with no collection count or wait behind it.
// A path names the holder, which a WeakRef cannot: it says only that something
// does.
// [LAW:single-enforcer] The snapshot is taken a macrotask after the caller's
// work, not inside it: a handle a native call made during that macrotask shows
// as a `(Handle scope)` root reaching the closures' captured state, and is gone
// once the macrotask ends. Every caller gets the yield from here.
// [LAW:one-source-of-truth] The snapshot is read by scripts/heap-retainers.mjs,
// the repo's one reader, which takes a file of any size where a test could not
// hold the snapshot as a string.
export const retainerPathsTo = async (
  className: string,
  limit = 3,
): Promise<string[][]> => {
  await new Promise((resolve) => setImmediate(resolve));
  const dir = mkdtempSync(join(tmpdir(), "retainer-path-"));
  try {
    const snapshot = v8.writeHeapSnapshot(join(dir, "heap.heapsnapshot"));
    const run = spawnSync(
      process.execPath,
      [
        RETAINERS,
        snapshot,
        `^object / ${className}$`,
        "--strong",
        "--limit",
        String(limit),
        "--json",
      ],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    // [LAW:no-silent-failure] A reader that did not run says so; reading its
    // empty output as "nothing holds it" would pass a leak.
    if (run.status !== 0)
      throw new Error(`heap-retainers exited ${run.status}: ${run.stderr}`);
    return (JSON.parse(run.stdout) as { paths: string[][] }).paths;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

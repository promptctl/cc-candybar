import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import v8 from "node:v8";

const RETAINERS = join(__dirname, "..", "..", "scripts", "heap-retainers.mjs");

// [LAW:verifiable-goals] Trace from the named owner, even when a native
// handle or the test's own stack also has a shorter path to the target.
// A control held directly by the same owner checks the reader and both names.
export const retainerPathsFrom = (
  owner: string,
  className: string,
): string[][] => {
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
        "--from",
        `^object / ${owner}$`,
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

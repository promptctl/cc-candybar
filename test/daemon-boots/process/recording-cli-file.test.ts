import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

test("offline replay refuses a named pipe without waiting for a writer", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ccb-replay-file-"));
  try {
    const file = path.join(dir, "recording.jsonl");
    execFileSync("mkfifo", [file], { timeout: 5_000 });
    const result = spawnSync(
      process.execPath,
      [path.resolve("dist/index.mjs"), "replay", file, "--frames"],
      { encoding: "utf8", env: {}, timeout: 5_000 },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("cc-candybar replay: not a file");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

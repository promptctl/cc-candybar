import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openRecordingFile } from "../src/daemon/recording-file";

test("only a complete recording is published, privately and without replacing another owner's destination", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "candybar-recording-"));
  try {
    const file = path.join(dir, "session.jsonl");
    const winner = await openRecordingFile(file);
    const runnerUp = await openRecordingFile(file);
    await winner.append('{"kind":"boot"}\n');
    await expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" });
    await winner.append('{"kind":"end","turns":0}\n');
    await expect(winner.publish()).resolves.toBeNull();
    await runnerUp.append("different bytes");
    await expect(runnerUp.publish()).rejects.toMatchObject({ code: "EEXIST" });
    await runnerUp.discard();
    expect(await fs.readdir(dir)).toEqual(["session.jsonl"]);
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    expect(await fs.readFile(file, "utf8")).toBe('{"kind":"boot"}\n{"kind":"end","turns":0}\n');
    await expect(openRecordingFile(file)).rejects.toThrow("already exists");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

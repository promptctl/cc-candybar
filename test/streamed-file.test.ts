// A file the host writes from text another process streams: opened before
// the process is asked, so a file that cannot be made asks nothing of it.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { streamedToFile } from "../src/daemon/streamed-file";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-streamed-file-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

test("the streamed text lands whole, owner-only", async () => {
  const file = path.join(dir, "heap.heapsnapshot");
  await streamedToFile(file, async (write) => {
    write('{"a":');
    await Promise.resolve();
    write("1}");
  });
  expect(fs.readFileSync(file, "utf8")).toBe('{"a":1}');
  expect(fs.statSync(file).mode & 0o777).toBe(0o600);
});

test("a file that cannot be made asks nothing of the stream", async () => {
  const file = path.join(dir, "taken");
  fs.writeFileSync(file, "kept");
  let asked = false;
  await expect(
    streamedToFile(file, async () => {
      asked = true;
    }),
  ).rejects.toThrow(/EEXIST/);
  expect(asked).toBe(false);
  expect(fs.readFileSync(file, "utf8")).toBe("kept");
});

test("a stream that fails is the write's failure, with what it sent kept", async () => {
  const file = path.join(dir, "heap.heapsnapshot");
  await expect(
    streamedToFile(file, async (write) => {
      write("{");
      throw new Error("out of memory");
    }),
  ).rejects.toThrow("out of memory");
  expect(fs.readFileSync(file, "utf8")).toBe("{");
});

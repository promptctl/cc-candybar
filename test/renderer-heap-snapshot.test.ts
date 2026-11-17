// The host's half of a renderer's heap snapshot: the chunks the renderer
// says, landed in one file, and no file at all for a snapshot that failed
// part way, in the renderer or on the disk.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writtenFrom } from "../src/daemon/renderer-process";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "heap-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const said =
  (texts: readonly string[], failure: Error | null = null) =>
  async (chunk: (text: string) => void): Promise<void> => {
    for (const text of texts) chunk(text);
    if (failure !== null) throw failure;
  };

test("a snapshot's chunks land whole, in order, readable by this user alone", async () => {
  const file = path.join(dir, "whole.heapsnapshot");
  await writtenFrom(file, said(['{"a":', "1}"]));
  expect(fs.readFileSync(file, "utf8")).toBe('{"a":1}');
  expect(fs.statSync(file).mode & 0o777).toBe(0o600);
});

test("a snapshot the renderer failed part way leaves no file, and fails with the renderer's reason", async () => {
  const file = path.join(dir, "half.heapsnapshot");
  await expect(
    writtenFrom(file, said(['{"a":'], new Error("out of memory"))),
  ).rejects.toThrow("out of memory");
  expect(fs.existsSync(file)).toBe(false);
});

test("a snapshot whose file will not open fails with the disk's reason, and the renderer is never asked for it", async () => {
  const file = path.join(dir, "missing", "refused.heapsnapshot");
  let asked = false;
  await expect(
    writtenFrom(file, async () => {
      asked = true;
    }),
  ).rejects.toThrow(/ENOENT/);
  expect(asked).toBe(false);
  expect(fs.existsSync(file)).toBe(false);
});

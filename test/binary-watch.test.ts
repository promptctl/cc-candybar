// [LAW:behavior-not-structure] The binary watch over the disk: a bundle's real
// mtime moving, or the bundle going, ends the daemon. Every other decision
// the watch makes is tested over the filesystem fake, in
// test/unit/binary-watch.test.ts.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeBinaryWatch } from "../src/daemon/binary-watch";
import { systemFilesystem } from "../src/disk/system-filesystem";
import { systemTimekeeper } from "../src/time";

let dir: string;
let bundle: string;
let exits: number;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "binary-watch-"));
  bundle = path.join(dir, "index.mjs");
  fs.writeFileSync(bundle, "// bundle");
  exits = 0;
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const watch = () =>
  makeBinaryWatch({
    clock: systemTimekeeper,
    targets: [bundle],
    intervalMs: 60_000,
    filesystem: systemFilesystem,
    held: async () => false,
    exit: () => exits++,
    log: () => {},
  });

test("an untouched bundle on disk keeps the daemon running", async () => {
  await watch().checkNow();
  expect(exits).toBe(0);
});

test("a bundle whose mtime moved on disk ends the daemon", async () => {
  const w = watch();
  const later = new Date(fs.statSync(bundle).mtimeMs + 5_000);
  fs.utimesSync(bundle, later, later);
  await w.checkNow();
  expect(exits).toBe(1);
});

test("a bundle removed from disk ends the daemon", async () => {
  const w = watch();
  fs.rmSync(bundle);
  await w.checkNow();
  expect(exits).toBe(1);
});

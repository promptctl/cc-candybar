// [LAW:behavior-not-structure] The binary watch (brandon-unfiled-3248.bsz):
// a daemon whose bundle is rebuilt or deleted exits; one whose bundle is
// untouched, or merely unreadable, runs on — measured over real files by
// whether `exit` was called and what the log says.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeBinaryWatch } from "../src/daemon/binary-watch";
import type { LogLevel } from "../src/daemon/log";

let dir: string;
let bundle: string;
let exits: number;
let lines: Array<[LogLevel, string]>;

const watch = (
  targets = [bundle],
  stat: (p: string) => { mtimeMs: number } = fs.statSync,
) =>
  makeBinaryWatch({
    targets,
    intervalMs: 60_000,
    stat,
    exit: () => exits++,
    log: (level, msg) => lines.push([level, msg]),
  });

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "binary-watch-"));
  fs.mkdirSync(path.join(dir, "dist"));
  bundle = path.join(dir, "dist", "index.mjs");
  fs.writeFileSync(bundle, "// bundle");
  exits = 0;
  lines = [];
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

test("an untouched bundle keeps the daemon running", () => {
  watch().checkNow();
  expect(exits).toBe(0);
  expect(lines).toEqual([]);
});

test("a rebuilt bundle ends the daemon", () => {
  const w = watch();
  const later = new Date(fs.statSync(bundle).mtimeMs + 5_000);
  fs.utimesSync(bundle, later, later);
  w.checkNow();
  expect(exits).toBe(1);
  expect(lines).toEqual([
    ["info", `binary changed (${bundle}); shutting down`],
  ]);
});

test("a deleted bundle ends the daemon", () => {
  const w = watch();
  fs.rmSync(dir, { recursive: true, force: true });
  w.checkNow();
  expect(exits).toBe(1);
  expect(lines).toEqual([["info", `binary gone (${bundle}); shutting down`]]);
});

test("a bundle under a file where its directory was is gone", () => {
  const w = watch();
  fs.rmSync(path.join(dir, "dist"), { recursive: true });
  fs.writeFileSync(path.join(dir, "dist"), "not a directory");
  w.checkNow();
  expect(exits).toBe(1);
});

// A stat that fails other than ENOENT/ENOTDIR, driven through the watch's
// stat edge: a chmod cannot refuse a stat to root.
const refusing = (refused: () => boolean) => (p: string) => {
  if (refused()) {
    throw Object.assign(new Error(`EACCES: permission denied, stat '${p}'`), {
      code: "EACCES",
    });
  }
  return fs.statSync(p);
};

test("a bundle the daemon cannot read says nothing about the bundle: it warns and runs on", () => {
  let refused = false;
  const w = watch([bundle], refusing(() => refused));
  refused = true;
  w.checkNow();
  expect(exits).toBe(0);
  expect(lines).toEqual([
    [
      "warn",
      `binary stat failed (${bundle}): EACCES: permission denied, stat '${bundle}'`,
    ],
  ]);
});

test("a bundle unreadable at boot neither matches nor moves once it reads", () => {
  let refused = true;
  const w = watch([bundle], refusing(() => refused));
  refused = false;
  w.checkNow();
  expect(exits).toBe(0);
  expect(lines).toEqual([
    [
      "warn",
      `binary stat failed (${bundle}): at boot: EACCES: permission denied, stat '${bundle}'`,
    ],
  ]);
});

test("one moved target among several ends the daemon once", () => {
  const other = path.join(dir, "shim");
  fs.writeFileSync(other, "#!/bin/sh");
  const w = watch([other, bundle]);
  fs.rmSync(bundle);
  w.checkNow();
  expect(exits).toBe(1);
});

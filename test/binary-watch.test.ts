// [LAW:behavior-not-structure] The binary watch (brandon-unfiled-3248.bsz):
// a daemon whose bundle is rebuilt or deleted exits; one whose bundle is
// untouched, or merely unreadable, runs on — measured over real files by
// whether `exit` was called and what the log says.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeBinaryWatch } from "../src/daemon/binary-watch";
import type { LogLevel } from "../src/utils/logger";

let dir: string;
let bundle: string;
let exits: number;
let lines: Array<[LogLevel, string]>;
// Whether an update's act is rewriting the bundle.
let updating: boolean;

const watch = (
  targets = [bundle],
  stat: (p: string) => { mtimeMs: number } = fs.statSync,
) =>
  makeBinaryWatch({
    targets,
    intervalMs: 60_000,
    stat,
    held: async () => updating,
    exit: () => exits++,
    log: (level, msg) => lines.push([level, msg]),
  });

test("a closed watch samples no more", async () => {
  jest.useFakeTimers();
  try {
    const closing = watch();
    closing.arm();
    closing.close();
    fs.rmSync(bundle);
    jest.advanceTimersByTime(120_000);
    expect(exits).toBe(0);
  } finally {
    jest.useRealTimers();
  }
});

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "binary-watch-"));
  fs.mkdirSync(path.join(dir, "dist"));
  bundle = path.join(dir, "dist", "index.mjs");
  fs.writeFileSync(bundle, "// bundle");
  exits = 0;
  lines = [];
  updating = false;
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

test("an untouched bundle keeps the daemon running", async () => {
  await watch().checkNow();
  expect(exits).toBe(0);
  expect(lines).toEqual([]);
});

test("a rebuilt bundle ends the daemon", async () => {
  const w = watch();
  const later = new Date(fs.statSync(bundle).mtimeMs + 5_000);
  fs.utimesSync(bundle, later, later);
  await w.checkNow();
  expect(exits).toBe(1);
  expect(lines).toEqual([
    ["info", `binary changed (${bundle}); shutting down`],
  ]);
});

test("a deleted bundle ends the daemon", async () => {
  const w = watch();
  fs.rmSync(dir, { recursive: true, force: true });
  await w.checkNow();
  expect(exits).toBe(1);
  expect(lines).toEqual([["info", `binary gone (${bundle}); shutting down`]]);
});

test("a bundle under a file where its directory was is gone", async () => {
  const w = watch();
  fs.rmSync(path.join(dir, "dist"), { recursive: true });
  fs.writeFileSync(path.join(dir, "dist"), "not a directory");
  await w.checkNow();
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

test("a bundle the daemon cannot read says nothing about the bundle: it warns and runs on", async () => {
  let refused = false;
  const w = watch(
    [bundle],
    refusing(() => refused),
  );
  refused = true;
  await w.checkNow();
  expect(exits).toBe(0);
  expect(lines).toEqual([
    [
      "warn",
      `binary stat failed (${bundle}): EACCES: permission denied, stat '${bundle}'`,
    ],
  ]);
});

test("a bundle unreadable at boot is reported once, when the watch arms, and not watched", async () => {
  jest.useFakeTimers();
  try {
    let refused = true;
    const w = watch(
      [bundle],
      refusing(() => refused),
    );
    refused = false;
    w.arm();
    const later = new Date(fs.statSync(bundle).mtimeMs + 5_000);
    fs.utimesSync(bundle, later, later);
    jest.advanceTimersByTime(3 * 60_000);
    await w.checkNow();
    expect(exits).toBe(0);
    expect(lines).toEqual([
      [
        "warn",
        `binary stat failed at boot (${bundle}): EACCES: permission denied, stat '${bundle}'; not watched`,
      ],
    ]);
  } finally {
    jest.useRealTimers();
  }
});

test("one moved target among several ends the daemon once", async () => {
  const other = path.join(dir, "shim");
  fs.writeFileSync(other, "#!/bin/sh");
  const w = watch([other, bundle]);
  fs.rmSync(bundle);
  await w.checkNow();
  expect(exits).toBe(1);
});

// The update's act is a launch child that dies with the daemon, so a restart
// mid-act would leave the bundle half-written. The wait is said once, however
// many samples it spans.
test("a bundle rebuilt while an update runs restarts the daemon once the update ends", async () => {
  const w = watch();
  updating = true;
  const later = new Date(fs.statSync(bundle).mtimeMs + 5_000);
  fs.utimesSync(bundle, later, later);
  await w.checkNow();
  await w.checkNow();
  expect(exits).toBe(0);
  updating = false;
  await w.checkNow();
  expect(exits).toBe(1);
  expect(lines).toEqual([
    [
      "info",
      `binary changed (${bundle}); the restart waits for the running update`,
    ],
    ["info", `binary changed (${bundle}); shutting down`],
  ]);
});

test("two checks at once exit once", async () => {
  const answers: Array<(held: boolean) => void> = [];
  const w = makeBinaryWatch({
    targets: [bundle],
    intervalMs: 60_000,
    stat: fs.statSync,
    held: () => new Promise((resolve) => answers.push(resolve)),
    exit: () => exits++,
    log: (level, msg) => lines.push([level, msg]),
  });
  fs.rmSync(bundle);
  const both = [w.checkNow(), w.checkNow()];
  await new Promise((resolve) => setImmediate(resolve));
  answers.forEach((answer) => answer(false));
  await Promise.all(both);
  expect(exits).toBe(1);
});

test("a close during the hold's answer exits nothing", async () => {
  let answer!: (held: boolean) => void;
  let exits = 0;
  const w = makeBinaryWatch({
    targets: [bundle],
    intervalMs: 60_000,
    stat: fs.statSync,
    held: () => new Promise((resolve) => (answer = resolve)),
    exit: () => exits++,
    log: () => {},
  });
  fs.rmSync(bundle);
  const checking = w.checkNow();
  await new Promise((resolve) => setImmediate(resolve));
  w.close();
  answer(false);
  await checking;
  expect(exits).toBe(0);
});

test("a check that fails is logged, and the next one still decides", async () => {
  let failing = true;
  const w = makeBinaryWatch({
    targets: [bundle],
    intervalMs: 60_000,
    stat: fs.statSync,
    held: async () => {
      if (failing) throw new Error("no answer");
      return false;
    },
    exit: () => exits++,
    log: (level, msg) => lines.push([level, msg]),
  });
  fs.rmSync(bundle);
  await w.checkNow();
  expect(lines).toEqual([["error", "binary check failed: no answer"]]);
  expect(exits).toBe(0);
  failing = false;
  await w.checkNow();
  expect(exits).toBe(1);
});

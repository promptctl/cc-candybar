// [LAW:behavior-not-structure] The binary watch: a daemon whose bundle is
// rebuilt or deleted exits; one whose bundle is untouched, or merely
// unreadable, runs on — measured over the filesystem fake by whether `exit`
// was called and what the log says. The disk's own mtimes are the adapter's,
// tested in test/binary-watch.test.ts.

import { makeBinaryWatch } from "../../src/daemon/binary-watch";
import {
  filesystemFake,
  type FilesystemFake,
} from "../../src/disk/filesystem-fake";
import type { LogLevel } from "../../src/utils/logger";
import { heldClock, type HeldClock } from "../helpers/held-clock";

const bundle = "/app/dist/index.mjs";
let clock: HeldClock;
let disk: FilesystemFake;
let exits: number;
let lines: Array<[LogLevel, string]>;
// Whether an update's act is rewriting the bundle.
let updating: boolean;

beforeEach(() => {
  clock = heldClock(new Date(1_000_000));
  disk = filesystemFake({ clock, platform: "linux" });
  disk.mkdir("/app/dist");
  disk.write(bundle, "// bundle");
  exits = 0;
  lines = [];
  updating = false;
});

const watch = (
  targets = [bundle],
  held: () => Promise<boolean> = async () => updating,
) =>
  makeBinaryWatch({
    clock,
    targets,
    intervalMs: 60_000,
    filesystem: disk,
    held,
    exit: () => exits++,
    log: (level, msg) => lines.push([level, msg]),
  });

// A rebuild: the bundle written again, later.
const rebuild = () => {
  clock.advance(5_000);
  disk.write(bundle, "// rebuilt");
};

// Lets the awaits a check is made of run, with no clock: each is a resolved
// promise's turn.
const turn = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

test("a closed watch samples no more", async () => {
  const closing = watch();
  closing.arm();
  closing.close();
  disk.remove(bundle);
  clock.advance(120_000);
  await turn();
  expect(exits).toBe(0);
});

test("an armed watch samples on its interval", async () => {
  const armed = watch();
  armed.arm();
  disk.remove(bundle);
  clock.advance(60_000);
  await turn();
  expect(exits).toBe(1);
});

test("an untouched bundle keeps the daemon running", async () => {
  await watch().checkNow();
  expect(exits).toBe(0);
  expect(lines).toEqual([]);
});

test("a rebuilt bundle ends the daemon", async () => {
  const w = watch();
  rebuild();
  await w.checkNow();
  expect(exits).toBe(1);
  expect(lines).toEqual([
    ["info", `binary changed (${bundle}); shutting down`],
  ]);
});

test("a deleted bundle ends the daemon", async () => {
  const w = watch();
  disk.remove("/app");
  await w.checkNow();
  expect(exits).toBe(1);
  expect(lines).toEqual([["info", `binary gone (${bundle}); shutting down`]]);
});

test("a bundle under a file where its directory was is gone", async () => {
  const w = watch();
  disk.remove("/app/dist");
  disk.write("/app/dist", "not a directory");
  await w.checkNow();
  expect(exits).toBe(1);
});

test("a bundle the daemon cannot read says nothing about the bundle: it warns and runs on", async () => {
  const w = watch();
  disk.fault(bundle, "EACCES");
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
  disk.fault(bundle, "EACCES");
  const w = watch();
  disk.fault(bundle, null);
  w.arm();
  rebuild();
  clock.advance(3 * 60_000);
  await turn();
  await w.checkNow();
  expect(exits).toBe(0);
  expect(lines).toEqual([
    [
      "warn",
      `binary stat failed at boot (${bundle}): EACCES: permission denied, stat '${bundle}'; not watched`,
    ],
  ]);
});

test("one moved target among several ends the daemon once", async () => {
  disk.write("/app/shim", "#!/bin/sh");
  const w = watch(["/app/shim", bundle]);
  disk.remove(bundle);
  await w.checkNow();
  expect(exits).toBe(1);
});

// The update's act is a launch child that dies with the daemon, so a restart
// mid-act would leave the bundle half-written. The wait is said once, however
// many samples it spans.
test("a bundle rebuilt while an update runs restarts the daemon once the update ends", async () => {
  const w = watch();
  updating = true;
  rebuild();
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
  const w = watch(
    [bundle],
    () => new Promise((resolve) => answers.push(resolve)),
  );
  disk.remove(bundle);
  const both = [w.checkNow(), w.checkNow()];
  await turn();
  answers.forEach((answer) => answer(false));
  await Promise.all(both);
  expect(exits).toBe(1);
});

test("a close during the hold's answer exits nothing", async () => {
  let answer!: (held: boolean) => void;
  const w = watch([bundle], () => new Promise((resolve) => (answer = resolve)));
  disk.remove(bundle);
  const checking = w.checkNow();
  await turn();
  w.close();
  answer(false);
  await checking;
  expect(exits).toBe(0);
});

test("a check that fails is logged, and the next one still decides", async () => {
  let failing = true;
  const w = watch([bundle], async () => {
    if (failing) throw new Error("no answer");
    return false;
  });
  disk.remove(bundle);
  await w.checkNow();
  expect(lines).toEqual([["error", "binary check failed: no answer"]]);
  expect(exits).toBe(0);
  failing = false;
  await w.checkNow();
  expect(exits).toBe(1);
});

// A launcher's `settled`: what a close's value is made of. Each case aborts its
// owner, as a close does, and reads what that left running.

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { pidAlive } from "../../src/daemon/parent-watchdog";
import { createLauncher } from "../../src/proc/launch";
import { until } from "../helpers/until";

const scope = () => {
  const closing = new AbortController();
  return {
    closing,
    launcher: createLauncher({
      signal: closing.signal,
      observeLifeline: () => {},
    }),
  };
};

describe("a launcher settles", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "launcher-settled-"));
  });
  afterEach(() => {
    jest.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  test("once a child that ignores SIGTERM is killed, and its lifeline is gone", async () => {
    const { closing, launcher } = scope();
    const up = path.join(dir, "up");
    const run = launcher.launch({
      bin: "/bin/sh",
      args: ["-c", `trap '' TERM; touch '${up}'; exec sleep 30`],
      category: "user-shell",
    });
    const lifeline = launcher.__lifelineForTest().pid as number;
    await until(() => existsSync(up), "the child ignoring SIGTERM");
    closing.abort(new Error("closed"));
    await expect(launcher.settled()).resolves.toEqual({ unreaped: [] });
    await expect(run).resolves.toMatchObject({
      reason: "aborted",
      signal: "SIGKILL",
    });
    expect(pidAlive(lifeline)).toBe(false);
  });

  test("with what a killed child wrote while the loop was busy", async () => {
    const { closing, launcher } = scope();
    const up = path.join(dir, "up");
    const run = launcher.launch({
      bin: "/bin/sh",
      args: [
        "-c",
        `trap 'echo LAST >&2' TERM; touch '${up}'; while :; do sleep 0.05; done`,
      ],
      category: "user-shell",
    });
    await until(() => existsSync(up), "the child trapping SIGTERM");
    closing.abort(new Error("closed"));
    // Past the grace with no poll turn, so the kill runs before any read.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
    await expect(run).resolves.toMatchObject({
      reason: "aborted",
      stderr: expect.stringContaining("LAST"),
    });
  });

  test("past a descendant that left the group holding the launch's stdout", async () => {
    const { closing, launcher } = scope();
    const pidFile = path.join(dir, "escaped");
    const run = launcher.launch({
      bin: process.execPath,
      args: [
        "-e",
        `const c = require("node:child_process").spawn("sleep", ["5"], { detached: true, stdio: "inherit" });
         process.on("SIGTERM", () => {});
         require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(c.pid));
         setInterval(() => {}, 1000);`,
      ],
      category: "user-shell",
    });
    await until(
      () => existsSync(pidFile) && readFileSync(pidFile, "utf8") !== "",
      "the descendant started",
    );
    const escaped = Number(readFileSync(pidFile, "utf8"));
    closing.abort(new Error("closed"));
    await launcher.settled();
    await expect(run).resolves.toMatchObject({ reason: "aborted" });
    expect(pidAlive(escaped)).toBe(true);
    process.kill(escaped, "SIGKILL");
  });

  test("naming a launch the OS would not let it end, until that child exits", async () => {
    const { closing, launcher } = scope();
    const pidFile = path.join(dir, "refused");
    const run = launcher.launch({
      bin: "/bin/sh",
      args: [
        "-c",
        `echo $$ > '${pidFile}.tmp'; mv '${pidFile}.tmp' '${pidFile}'; exec sleep 30`,
      ],
      category: "user-shell",
    });
    await until(() => existsSync(pidFile), "the child started");
    const refuse = jest.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
    });
    closing.abort(new Error("closed"));
    await expect(run).resolves.toMatchObject({ reason: "signal-refused" });
    await expect(launcher.settled()).resolves.toEqual({
      unreaped: ["user-shell"],
    });
    refuse.mockRestore();
    process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL");
    await until(
      async () => (await launcher.settled()).unreaped.length === 0,
      "the refused child exited",
      5_000,
    );
  });
});

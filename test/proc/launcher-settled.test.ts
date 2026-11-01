// A launcher's `settled`: what a close's value is made of. Each case aborts its
// owner, as a close does, and reads what that left running.

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
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("a launcher settles", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("once a child that ignores SIGTERM is killed, and its lifeline is gone", async () => {
    const { closing, launcher } = scope();
    const run = launcher.launch({
      bin: "/bin/sh",
      args: ["-c", "trap '' TERM; echo up; exec sleep 30"],
      category: "user-shell",
    });
    const lifeline = launcher.__lifelineForTest().pid as number;
    closing.abort(new Error("closed"));
    await expect(launcher.settled()).resolves.toEqual({ unreaped: [] });
    await expect(run).resolves.toMatchObject({ reason: "aborted" });
    expect(alive(lifeline)).toBe(false);
  });

  test("past a descendant that left the group holding the launch's stdout", async () => {
    const { closing, launcher } = scope();
    const run = launcher.launch({
      bin: process.execPath,
      args: [
        "-e",
        `const c = require("node:child_process").spawn("sleep", ["5"], { detached: true, stdio: "inherit" });
         console.log(c.pid);
         process.on("SIGTERM", () => {});
         setInterval(() => {}, 1000);`,
      ],
      category: "user-shell",
    });
    await new Promise((started) => setTimeout(started, 300));
    closing.abort(new Error("closed"));
    await launcher.settled();
    const result = await run;
    expect(result).toMatchObject({ reason: "aborted" });
    const escaped = Number(result.stdout.trim());
    expect(alive(escaped)).toBe(true);
    process.kill(escaped, "SIGKILL");
  });

  test("naming a launch the OS would not let it end, until that child closes", async () => {
    const { closing, launcher } = scope();
    const run = launcher.launch({
      bin: "/bin/sh",
      args: ["-c", "exec sleep 2"],
      category: "user-shell",
    });
    const refuse = jest.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
    });
    closing.abort(new Error("closed"));
    await expect(run).resolves.toMatchObject({ reason: "signal-refused" });
    await expect(launcher.settled()).resolves.toEqual({
      unreaped: ["user-shell"],
    });
    refuse.mockRestore();
    await until(
      async () => (await launcher.settled()).unreaped.length === 0,
      "the refused child closed",
      5_000,
    );
  });
});

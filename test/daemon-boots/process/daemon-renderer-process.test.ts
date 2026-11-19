// [LAW:verifiable-goals] On a REAL daemon: the renderer runs in a process of
// its own, a renderer that dies is started again, and the bar the next one
// draws says the restart happened and what it cost.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { textOf } from "../../../src/render/frame";
import { render, renderUntil } from "../../helpers/daemon-e2e";
import {
  spawnIsolatedDaemon,
  type IsolatedDaemonHandle,
} from "../../helpers/spawn-isolated-daemon";
import { until } from "../../helpers/until";

jest.setTimeout(30_000);

// Every renderer start the daemon logged, by pid, in order.
function rendererStarts(handle: IsolatedDaemonHandle): number[] {
  const log = fs.readFileSync(path.join(handle.stateDir, "daemon.log"), "utf8");
  return [...log.matchAll(/renderer main\[\d+\] started pid=(\d+)/g)].map((m) =>
    Number(m[1]),
  );
}

describe("the daemon's renderer process", () => {
  let handle: IsolatedDaemonHandle;
  let projectDir: string;

  beforeEach(async () => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-candybar-rproc-"));
    handle = await spawnIsolatedDaemon("cc-candybar-rproc");
  });

  afterEach(async () => {
    await handle.cleanup();
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  test("draws the bar from its own process, and one killed is restarted with the bar saying so", async () => {
    const first = await render(handle.sockPath, "rproc", projectDir);
    expect(textOf(first).length).toBeGreaterThan(0);
    // Nothing is wrong before the end, so the warning that follows is its.
    expect(textOf(first)).not.toMatch(/⚠/);
    const [pid] = rendererStarts(handle);
    expect(pid).toBeDefined();
    expect(pid).not.toBe(handle.child.pid);

    process.kill(pid!, "SIGKILL");
    await until(
      () => rendererStarts(handle).length === 2,
      () => "the renderer to be started again",
      10_000,
    );
    expect(rendererStarts(handle)[1]).not.toBe(pid);

    // The restarted renderer configures the session again from the request
    // the daemon holds, and the bar warns of the end.
    const warned = await renderUntil(
      handle.sockPath,
      "rproc",
      projectDir,
      (frame) => /⚠/.test(textOf(frame)),
      "a bar warning that its renderer restarted",
      10_000,
    );
    expect(textOf(warned)).toMatch(/⚠ \d/);
    const log = fs.readFileSync(
      path.join(handle.stateDir, "daemon.log"),
      "utf8",
    );
    expect(log).toMatch(
      /renderer main\[1\] killed by SIGKILL after \d+ s; next start in 1 s/,
    );
  });

  test("a renderer outlives no daemon, even one killed with no cleanup", async () => {
    await render(handle.sockPath, "rproc", projectDir);
    const [pid] = rendererStarts(handle);
    const alive = (): boolean => {
      try {
        process.kill(pid!, 0);
        return true;
      } catch {
        return false;
      }
    };
    expect(alive()).toBe(true);
    // The renderer is launched detached and leads a group of its own, so no
    // signal to the daemon's group reaches it; its end here can only be the
    // daemon's lifeline. The renderer's parent is the process the test holds,
    // so that pid is the daemon's own.
    const parent = Number(
      spawnSync("ps", ["-o", "ppid=", "-p", String(pid)], {
        encoding: "utf8",
      }).stdout.trim(),
    );
    expect(parent).toBe(handle.child.pid);
    process.kill(parent, "SIGKILL");
    await until(
      () => !alive(),
      () => `renderer ${pid} to end with its daemon`,
      10_000,
    );
  });
});

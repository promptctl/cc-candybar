// [LAW:verifiable-goals] On a REAL daemon: the renderer runs in a process of
// its own, a renderer that dies is started again, and the bar the next one
// draws says the restart happened and what it cost.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { decodeAnsi, Style } from "@promptctl/rich-js";

import { textOf } from "../../../src/render/frame";
import { linksOf } from "../../../src/click/read";
import {
  openFrameStream,
  type StreamEnd,
} from "../../../src/daemon/client-frames";
import type { Response } from "../../../src/daemon/foundations/protocol";
import {
  click,
  drawnLink,
  render,
  renderUntil,
  urlWriting,
} from "../../helpers/daemon-e2e";
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

  afterEach(() => {
    handle.cleanup();
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

  test("publishes identical clickable addresses for a request and the tmux pane feed", async () => {
    const external = "https://example.test/page#section";
    const config = path.join(projectDir, "links.json5");
    fs.writeFileSync(
      config,
      `{
      globals: { experimentalPane: true },
      variables: { face: { kind: "state", key: "face", default: "shut" } },
      actions: { flip: { set: "face", cycle: ["shut", "open"] } },
      segments: {
        door: { template: '{{ action "flip" "door shut" "door open" }}' },
        external: { template: '{{ link "${external}" "external" }}' },
      },
      root: { h: ['door', 'external'] },
    }`,
    );
    const session = "rproc-links";
    const args = ["cc-candybar", "--config", config];
    const request = await render(
      handle.sockPath,
      session,
      projectDir,
      {},
      args,
    );
    expect(linksOf(request)).toContainEqual({
      url: external,
      text: "external",
    });
    const requestLink = urlWriting(request, "face", "open");
    expect(requestLink).toBe(drawnLink(handle.sockPath, requestLink));

    const frames: Response[] = [];
    let ended: StreamEnd | null = null;
    const stream = openFrameStream(
      handle.sockPath,
      session,
      "pane",
      (frame) => frames.push(frame),
      (end) => {
        ended = end;
      },
    );
    try {
      await until(
        () => frames.length > 0 || ended !== null,
        "the pane's first frame",
      );
      const frame = frames[0];
      if (frame === undefined || !frame.ok || !("output" in frame))
        throw new Error(
          `the pane drew no bar: ${JSON.stringify(frame ?? ended)}`,
        );
      const urls = decodeAnsi(frame.output).spans.flatMap(({ style }) =>
        style instanceof Style && style.link !== undefined ? [style.link] : [],
      );
      const paneLink = urls.find((url) => url === requestLink);
      expect(paneLink).toBe(requestLink);
      expect(urls).toContain(external);
      await click(handle.sockPath, paneLink!);
      await until(
        () =>
          frames.some(
            (reply) =>
              reply.ok &&
              "output" in reply &&
              decodeAnsi(reply.output).plain.includes("door open"),
          ),
        "the pane after its click",
      );
    } finally {
      stream.close();
    }
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
    // The daemon alone, not its group: `handle.child` is tsx's wrapper, and a
    // group's signal would reach the renderer itself and prove nothing.
    const daemonPid = Number(
      spawnSync("ps", ["-o", "ppid=", "-p", String(pid)], {
        encoding: "utf8",
      }).stdout.trim(),
    );
    expect(daemonPid).toBeGreaterThan(1);
    process.kill(daemonPid, "SIGKILL");
    await until(
      () => !alive(),
      () => `renderer ${pid} to end with its daemon`,
      10_000,
    );
  });
});

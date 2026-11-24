// [LAW:verifiable-goals] A host in this worker whose renderers run in real
// processes of the built bundle: a renderer past the memory limit is recorded
// and ended alone, and started again, while the other keeps drawing; the stats
// show one panel per renderer, alike whatever its name. What the platform
// charges each process is the test's, so no process has to grow to breach.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { textOf, type Frame } from "../../../src/render/frame";
import {
  PROTOCOL_VERSION,
  type ReaderRenderRequest,
} from "../../../src/daemon/foundations/protocol";
import type { ServedDaemon } from "../../../src/daemon/daemon";
import { daemonPaths } from "../../../src/daemon/paths";
import { processPort } from "../../../src/daemon/renderer-process";
import {
  MAIN_RENDERER,
  rendererNameOf,
} from "../../../src/daemon/foundations/renderer-name";
import {
  rendererPanelOf,
  type RendererPanel,
} from "../../../src/daemon/foundations/stats-snapshot";
import {
  listPostMortems,
  memoryLimitBytes,
  realLimitsDeps,
} from "../../../src/daemon/limits";
import { plainEnvironment } from "../../../src/daemon/foundations/session-env";
import { BYTES_PER_MB as MB } from "../../../src/daemon/foundations/memory-limit";
import { systemLauncher } from "../../../src/proc/system-launcher";
import { hostOf } from "../../../scripts/lib/host";
import { systemTimekeeper } from "../../../scripts/lib/system-clock";
import { until } from "../../../scripts/lib/until";
import { hookData } from "../../helpers/daemon-e2e";
import { heldClock } from "../../helpers/held-clock";
import { buildDaemon, frameOf, statsOf } from "../../helpers/in-worker-daemon";

jest.setTimeout(60_000);

const BUNDLE = path.resolve("dist/index.mjs");
const WORKTREE = rendererNameOf("worktree");

// A value's shape: its keys all the way down, and each leaf's type.
const shapeOf = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(shapeOf)
    : value !== null && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => (a < b ? -1 : 1))
            .map(([key, each]) => [key, shapeOf(each)]),
        )
      : typeof value;

test("a renderer past its memory limit is ended alone and started again, and every renderer shows the same panel", async () => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "ccb-renderer-backstop-")),
  );
  const config = path.join(root, "config.json5");
  fs.writeFileSync(
    config,
    JSON.stringify({
      segments: { mark: { template: "drawn" } },
      root: { h: ["mark"] },
    }),
  );
  const host = hostOf({
    ...process.env,
    XDG_STATE_HOME: path.join(root, "state"),
  });
  const paths = daemonPaths(host);
  const limit = memoryLimitBytes(process.env);
  // The backstop's own clock, so a reading comes when the case asks.
  const backstop = heldClock(new Date("2026-11-24T00:00:00Z"));
  // The process the platform charges past the limit, when any.
  let over: number | null = null;
  // The renderers' launcher is the case's, as a daemon process's is its own:
  // its lifeline ends with this signal.
  const ending = new AbortController();
  const launcher = systemLauncher(
    { inherited: process.env, signal: ending.signal },
    systemTimekeeper,
  );
  const { daemon, daemonLog } = buildDaemon({
    host,
    paths,
    memoryLimitBytes: limit,
    bundle: {
      digest: null,
      path: BUNDLE,
      node: [process.execPath],
      targets: [BUNDLE],
    },
    renderer: processPort({ launcher, cwd: root, heapCapMb: 256 }),
    limits: ({ startedAtMs, exit, launcher: owned, log }) =>
      realLimitsDeps(
        startedAtMs,
        exit,
        {
          launcher: owned,
          log,
          clock: backstop,
          snapshotDir: paths.state,
          writeLogNow: () => daemonLog.writeNow(),
        },
        {
          memoryCharge: async () => (process) => ({
            kind: "charged",
            measure: "phys_footprint",
            bytes: process.pid === over ? limit + MB : 64 * MB,
          }),
        },
      ),
  });
  const request = (session: string, named: boolean): ReaderRenderRequest => ({
    v: PROTOCOL_VERSION,
    kind: "render",
    encoding: "frame",
    hookData: hookData(session, root),
    args: ["cc-candybar", "--config", config],
    cwd: root,
    termCols: 200,
    termRows: 40,
    env: plainEnvironment(
      named ? { ...process.env, CC_CANDYBAR_NAME: WORKTREE } : process.env,
    ),
    ...(named && { client: { kind: "node", bundle: BUNDLE, source: null } }),
  });
  const draw = (session: string, named: boolean): Promise<Frame> =>
    frameOf(daemon, request(session, named));
  // The pid each renderer's panel reads, once a ping has read it.
  const readPid = (panel: RendererPanel): number | null =>
    panel.process.kind === "process" &&
    panel.process.memory.memory.kind === "measured"
      ? panel.process.memory.pid
      : null;
  const pidsOf = async (served: ServedDaemon) => {
    const stats = await statsOf(served);
    return {
      main: readPid(rendererPanelOf(stats, MAIN_RENDERER)),
      worktree: readPid(rendererPanelOf(stats, WORKTREE)),
    };
  };
  // Every renderer process the case saw, so the close can be seen to end them.
  const seen = new Set<number>();
  try {
    daemon.arm();
    expect(textOf(await draw("main-session", false))).toContain("drawn");
    expect(textOf(await draw("worktree-session", true))).toContain("drawn");
    // A reading once both renderers' pings have read them.
    let pids = { main: null as number | null, worktree: null as number | null };
    await until(
      async () => {
        backstop.advance(60_000);
        pids = await pidsOf(daemon);
        return pids.main !== null && pids.worktree !== null;
      },
      () => `both renderers read, last ${JSON.stringify(pids)}`,
      20_000,
    );
    const stats = await statsOf(daemon);
    expect(stats.renderers.map(({ name }) => name).sort()).toEqual([
      MAIN_RENDERER,
      WORKTREE,
    ]);
    // [LAW:one-type-per-behavior] Each panel is the same shape, its memory
    // its own process's against the limit alone.
    for (const panel of stats.renderers) {
      expect(panel).toMatchObject({
        process: {
          kind: "process",
          memory: {
            memory: {
              kind: "measured",
              charge: { bytes: 64 * MB },
              // What its own ping said of it.
              usage: { kind: "read" },
            },
            limit,
          },
        },
        mailbox: { queued: 0 },
        stats: { kind: "ok", value: { framesDrawn: expect.any(Number) } },
      });
    }
    // The same fields whatever the renderer's name: only the values differ.
    const [first, second] = stats.renderers.map(({ process, stats }) =>
      shapeOf({ process, stats }),
    );
    expect(first).toEqual(second);
    expect(stats.host).toMatchObject({
      pid: process.pid,
      memory: { kind: "measured", charge: { bytes: 64 * MB } },
    });

    seen.add(pids.main!);
    const breached = pids.worktree!;
    over = breached;
    let now = pids;
    // The other renderer's bar, drawn on every poll from the breach to the
    // restart.
    const mainBars: string[] = [];
    await until(
      async () => {
        // A reading each poll until the restarted renderer is read: the
        // breach's, then the new process's.
        backstop.advance(60_000);
        mainBars.push(textOf(await draw("main-session", false)));
        now = await pidsOf(daemon);
        return now.worktree !== null && now.worktree !== breached;
      },
      () => `the worktree renderer started again, last ${JSON.stringify(now)}`,
      20_000,
    );
    seen.add(now.worktree!);
    // The other renderer was never ended, and drew throughout.
    expect(now.main).toBe(pids.main);
    expect(mainBars.length).toBeGreaterThan(1);
    expect(mainBars.filter((bar) => !bar.includes("drawn"))).toEqual([]);
    expect(textOf(await draw("main-session", false))).toContain("drawn");
    // The restarted renderer draws its session again, warning of its end.
    let warned = "";
    await until(
      async () => {
        warned = textOf(await draw("worktree-session", true));
        return /⚠/.test(warned);
      },
      () =>
        `a worktree bar warning that its renderer was ended, last ${warned}`,
      10_000,
    );
    expect(warned).toContain("drawn");

    const postMortems = listPostMortems(paths.state);
    if (postMortems.kind !== "ok") throw new Error(postMortems.reason);
    expect(postMortems.value).toHaveLength(1);
    expect(postMortems.value[0]).toMatchObject({
      process: { kind: "renderer", name: WORKTREE },
      artifacts: {
        memoryReport: expect.stringContaining(
          `-renderer-worktree-${breached}.txt`,
        ),
        heapSnapshot: expect.stringContaining(
          `-renderer-worktree-${breached}.heapsnapshot`,
        ),
      },
    });
    const heap = postMortems.value[0]!.artifacts.heapSnapshot!;
    expect(fs.statSync(heap).size).toBeGreaterThan(0);
    daemonLog.writeNow();
    expect(fs.readFileSync(paths.log, "utf8")).toMatch(
      new RegExp(
        `renderer worktree\\[1\\] passed its memory limit: phys_footprint ${limit / MB + 1} MB > limit ${limit / MB} MB`,
      ),
    );
  } finally {
    await (
      await daemon.close()
    ).settled;
    daemonLog.dispose();
    ending.abort();
    await launcher.settled();
    fs.rmSync(root, { recursive: true, force: true });
  }
  // A renderer outlives no daemon.
  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  expect(seen.size).toBe(2);
  await until(
    () => [...seen].every((pid) => !alive(pid)),
    () =>
      `the renderers ended with the daemon: ${[...seen].filter(alive).join(", ")}`,
  );
});

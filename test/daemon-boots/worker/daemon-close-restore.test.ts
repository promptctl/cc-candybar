// [LAW:verifiable-goals] A daemon's close puts the tmux status lines it laid
// out back before it waits on its renderer: a renderer still busy when the
// close begins cannot hold the restore past shutdown's backstop, which kills
// the process half a second in.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { daemonPaths } from "../../../src/daemon/paths";
import { classifyInbound } from "../../../src/daemon/foundations/protocol";
import {
  inProcessPort,
  type RendererPort,
} from "../../../src/daemon/renderer-process";
import type { TmuxAtExit } from "../../../src/daemon/tmux-status";
import { systemOneShotLauncher } from "../../../src/proc/system-launcher";
import { runTmuxAtExit } from "../../../src/proc/tmux";
import type {
  Renderer,
  RendererInput,
} from "../../../src/renderer-interface/interface";
import { systemTimekeeper } from "../../../src/time";
import { configFlag, render } from "../../helpers/daemon-e2e";
import type { DaemonEndpoint } from "../../helpers/daemon-wire";
import { hostOf } from "../../helpers/host";
import { buildDaemon, bundleAt } from "../../helpers/in-worker-daemon";
import { until } from "../../helpers/until";

const HAS_TMUX = spawnSync("tmux", ["-V"]).status === 0;

// The in-process renderer, holding its answer to the close's first step until
// `released` settles.
const heldOnClose =
  (released: Promise<void>): RendererPort =>
  (prepared) => {
    const port = inProcessPort(prepared);
    return {
      start: (own) => {
        const link = port.start(own);
        const answer = (async (input: RendererInput) => {
          if (input.kind === "adapter" && input.push.kind === "close-journal")
            await released;
          return link.renderer.answer(input as never);
        }) as Renderer["answer"];
        return { ...link, renderer: { answer } };
      },
    };
  };

(HAS_TMUX ? test : test.skip)(
  "the tmux status lines are back while the renderer has not answered the close",
  async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "ccb-close-restore-"));
    const socket = path.join(dir, "tmux.sock");
    const tmux = (...args: string[]): string => {
      const run = spawnSync("tmux", ["-S", socket, ...args], {
        encoding: "utf8",
      });
      if (run.status !== 0) throw new Error(`tmux ${args[0]}: ${run.stderr}`);
      return run.stdout;
    };
    const config = path.join(dir, "tmux.json5");
    writeFileSync(
      config,
      `{ globals: { renderer: "tmux" }, segments: { mark: { template: 'a mark' } }, root: { h: ['mark'] } }`,
    );
    tmux("-f", "/dev/null", "new-session", "-d", "-s", "bar", "-x", "120", "-y", "40");
    let release = (): void => {};
    const released = new Promise<void>((resolve) => (release = resolve));
    const host = hostOf({
      ...process.env,
      XDG_STATE_HOME: path.join(dir, "state"),
    });
    const paths = daemonPaths(host);
    const { daemon, daemonLog } = buildDaemon({
      host,
      paths,
      bundle: bundleAt(path.join(dir, "checkout")),
      renderer: heldOnClose(released),
    });
    const endpoint: DaemonEndpoint = {
      send: async (req) => {
        const handled = await daemon.handle(
          classifyInbound(req),
          () => false,
          daemon.stats.accept(),
          () => false,
        );
        if (handled.kind !== "reply") throw new Error("expected a reply");
        handled.settled(true);
        return handled.resp;
      },
      log: paths.log,
      now: () => daemon.clock.now(),
    };
    const oneShot = systemOneShotLauncher(
      { inherited: process.env },
      systemTimekeeper,
    );
    const atExit: TmuxAtExit = (at, args, stdin) =>
      runTmuxAtExit(oneShot, { socket: at }, "tmux-status", args, stdin);
    try {
      const pane = tmux("list-panes", "-t", "bar", "-F", "#{pane_id}").trim();
      const own = (): string => tmux("show-options", "-t", "bar");
      const before = own();
      await until(async () => {
        await render(
          endpoint,
          "close-restore",
          dir,
          {
            termCols: 120,
            termRows: 40,
            tmux: { socket, pane, truecolor: null },
          },
          configFlag(config),
        );
        return own() !== before;
      }, "the daemon's layout on the session");

      let closed = false;
      const closing = daemon.close(atExit).then((c) => {
        closed = true;
        return c;
      });
      await until(() => own() === before, "the session's own status options");
      expect(closed).toBe(false);
      release();
      await (await closing).settled;
    } finally {
      release();
      await daemonLog.drained();
      daemonLog.dispose();
      spawnSync("tmux", ["-S", socket, "kill-session", "-t", "bar"]);
      rmSync(dir, { recursive: true, force: true });
    }
  },
  30_000,
);

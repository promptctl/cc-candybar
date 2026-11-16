// [LAW:verifiable-goals] A daemon's close puts the tmux status lines it laid
// out back before it waits on its renderer: a renderer still busy when the
// close begins cannot hold the restore past shutdown's backstop, which kills
// the process half a second in.

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Daemon } from "../../../src/daemon/daemon";
import { daemonPaths } from "../../../src/daemon/paths";
import { classifyInbound } from "../../../src/daemon/foundations/protocol";
import {
  inProcessPort,
  type RendererPort,
} from "../../../src/daemon/renderer-process";
import { rendererOf } from "../../../src/renderer-interface/interface";
import { configFlag, render } from "../../helpers/daemon-e2e";
import type { DaemonEndpoint } from "../../helpers/daemon-wire";
import { hostOf } from "../../helpers/host";
import { buildDaemon, bundleAt } from "../../helpers/in-worker-daemon";
import { HAS_TMUX, privateTmux } from "../../helpers/private-tmux";
import { until } from "../../helpers/until";

// The in-process renderer, holding its answer to the close's first step until
// `released` settles.
const heldOnClose =
  (released: Promise<void>): RendererPort =>
  (prepared) => {
    const port = inProcessPort(prepared);
    return {
      start: (own) => {
        const link = port.start(own);
        const inner = link.renderer;
        const renderer = rendererOf({
          event: (input) => inner.answer(input),
          adapter: async (input) => {
            if (input.push.kind === "close-journal") await released;
            return inner.answer(input);
          },
        });
        return { ...link, renderer };
      },
    };
  };

(HAS_TMUX ? test : test.skip)(
  "the tmux status lines are back while the renderer has not answered the close",
  async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "ccb-close-restore-"));
    const tmux = privateTmux(dir);
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
    // The one close of the daemon, whichever way the case ends.
    let closing: ReturnType<Daemon["close"]> | null = null;
    try {
      const before = tmux.own();
      await until(async () => {
        await render(
          endpoint,
          "close-restore",
          dir,
          tmux.hints,
          configFlag(tmux.config),
        );
        return tmux.own() !== before;
      }, "the daemon's layout on the session");

      let closed = false;
      closing = daemon.close();
      void closing.then(() => (closed = true));
      await until(
        () => tmux.own() === before,
        "the session's own status options",
      );
      expect(closed).toBe(false);
    } finally {
      release();
      await (await (closing ?? daemon.close())).settled;
      await daemonLog.drained();
      daemonLog.dispose();
      tmux.kill();
      rmSync(dir, { recursive: true, force: true });
    }
  },
  30_000,
);

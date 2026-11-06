// [LAW:verifiable-goals] The home lane's acceptance test, in its first form:
// two renderers under two named homes, sharing one runtime directory, each
// serving its own socket, given the same config text. Each draws one bar and
// takes one durable write, and neither leaves a trace of the other: nothing
// under A's root names B's root, nor the reverse, and the file each wrote is
// its own home's config.

import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { HOME_ENV, NAME_ENV, RUNTIME_DIR_ENV, homeOf, type RendererHome } from "../../../src/daemon/home";
import { configDir, socketPath } from "../../../src/daemon/paths";
import { handleConnection } from "../../../src/daemon/connection";
import type { DaemonLog } from "../../../src/daemon/log";
import type { Daemon } from "../../../src/daemon/daemon";
import { textOf } from "../../../src/render/frame";
import { linkUrls } from "../../helpers/frame";
import { effectsOf } from "../../helpers/click";
import { click, render } from "../../helpers/daemon-e2e";
import { hostOf } from "../../helpers/host";
import { NO_TMUX_AT_EXIT, buildDaemon } from "../../helpers/in-worker-daemon";

jest.setTimeout(30_000);

// A `persist` click writes the field into the home's config file, which is the
// durable write a renderer makes on its own behalf.
const CONFIG = `{
  actions: { pad: { persist: "padding", to: "4" } },
  segments: {
    pad: { template: '{{ action "pad" "[pad]" }}', bg: "surface", fg: "foreground" },
  },
  root: { h: ["pad"] },
}
`;

interface Renderer {
  readonly home: RendererHome;
  readonly daemon: Daemon;
  readonly daemonLog: DaemonLog;
  readonly server: net.Server;
}

// Every file under `root`, read whole.
function filesUnder(root: string): Array<{ file: string; text: string }> {
  return fs
    .readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => {
      const file = path.join(e.parentPath, e.name);
      return { file, text: fs.readFileSync(file, "utf8") };
    });
}

test("two renderers under two homes serve their own sockets and leave no trace of each other", async () => {
  // One short temporary root for both homes and the runtime directory they
  // share, so the socket paths stay under the platform's limit.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-2h-"));
  const runtime = path.join(root, "run");
  fs.mkdirSync(runtime, { mode: 0o700 });
  const projectDir = path.join(root, "project");
  fs.mkdirSync(projectDir);

  const start = async (name: string): Promise<Renderer> => {
    const home = homeOf(
      hostOf({
        ...process.env,
        [HOME_ENV]: path.join(root, name),
        [NAME_ENV]: name,
        [RUNTIME_DIR_ENV]: runtime,
      }),
    );
    fs.mkdirSync(configDir(home), { recursive: true });
    fs.writeFileSync(path.join(configDir(home), "config.json5"), CONFIG);
    const { daemon, daemonLog } = buildDaemon({ home });
    const server = net.createServer((sock) => handleConnection(daemon, sock));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath(home), () => {
        server.off("error", reject);
        resolve();
      });
    });
    return { home, daemon, daemonLog, server };
  };

  const a = await start("alpha");
  const b = await start("beta");
  try {
    expect(socketPath(a.home)).toBe(path.join(runtime, "alpha.sock"));
    expect(socketPath(b.home)).toBe(path.join(runtime, "beta.sock"));

    for (const r of [a, b]) {
      const sid = `two-homes-${r.home.name}`;
      const bar = await render(r.home, sid, projectDir);
      expect(textOf(bar)).toContain("[pad]");
      const url = linkUrls(bar).find((u) =>
        effectsOf(u).some((e) => e.verb === "persist" || e.verb === "set-config"),
      );
      if (url === undefined) throw new Error(`no persist link in:\n${textOf(bar)}`);
      await click(r.home, url);
      const written = fs.readFileSync(path.join(configDir(r.home), "config.json5"), "utf8");
      expect(written).toMatch(/padding:\s*4/);
    }

    // Neither tree names the other's root, and each wrote only its own file.
    const rootOf = (r: Renderer): string => (r.home.kind === "named" ? r.home.root : "");
    for (const [mine, other] of [
      [a, b],
      [b, a],
    ] as const) {
      const files = filesUnder(rootOf(mine));
      expect(files.length).toBeGreaterThan(0);
      const naming = files.filter((f) => f.text.includes(rootOf(other)));
      expect(naming.map((f) => f.file)).toEqual([]);
    }
    expect(fs.readFileSync(path.join(configDir(a.home), "config.json5"), "utf8")).toBe(
      fs.readFileSync(path.join(configDir(b.home), "config.json5"), "utf8"),
    );
  } finally {
    for (const r of [a, b]) {
      await r.daemon.close(NO_TMUX_AT_EXIT);
      await new Promise<void>((resolve) => r.server.close(() => resolve()));
      await r.daemonLog.drained();
      r.daemonLog.dispose();
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

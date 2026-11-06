// [LAW:verifiable-goals] The home lane's acceptance test: two renderers under
// two named homes, sharing one runtime directory, each serving its own socket,
// given the same config text. Each draws one bar and takes one durable write,
// one naming its config file and one finding it, and no file under either
// root names either root, so neither leaves a trace of the other and a tree
// copied under a third root is a renderer of its own: its undo writes its own
// config.

import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { HOME_ENV, NAME_ENV, RUNTIME_DIR_ENV, homeOf, type RendererHome } from "../../../src/daemon/home";
import { configDir, socketPath } from "../../../src/daemon/paths";
import { VERB_UNDO, effectsUrl } from "../../../src/click/wire";
import { handleConnection } from "../../../src/daemon/connection";
import type { DaemonLog } from "../../../src/daemon/log";
import type { Daemon } from "../../../src/daemon/daemon";
import { textOf } from "../../../src/render/frame";
import { linkUrls } from "../../helpers/frame";
import { effectsOf } from "../../helpers/click";
import { click, configFlag, render } from "../../helpers/daemon-e2e";
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

// Every file under `root` but the log, read whole. The log is the renderer's
// diagnostic output: it names the paths it acted on by design, and nothing
// reads it back, so it cannot carry a home's root into a renderer's work.
function storedUnder(root: string): Array<{ file: string; text: string }> {
  return fs
    .readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => path.join(e.parentPath, e.name))
    .filter((file) => path.relative(root, file) !== path.join("state", "daemon.log"))
    .map((file) => ({ file, text: fs.readFileSync(file, "utf8") }));
}

const configOf = (home: RendererHome): string =>
  path.join(configDir(home), "config.json5");

test("two renderers under two homes leave no trace of each other or of their own roots, and a copied home undoes into its own config", async () => {
  // One short temporary root for every home and the runtime directory they
  // share, so the socket paths stay under the platform's limit.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-2h-"));
  const runtime = path.join(root, "run");
  fs.mkdirSync(runtime, { mode: 0o700 });
  const projectDir = path.join(root, "project");
  fs.mkdirSync(projectDir);

  const homeNamed = (name: string): RendererHome =>
    homeOf(
      hostOf({
        ...process.env,
        [HOME_ENV]: path.join(root, name),
        [NAME_ENV]: name,
        [RUNTIME_DIR_ENV]: runtime,
      }),
    );
  const rootOf = (home: RendererHome): string => (home.kind === "named" ? home.root : "");

  const running: Renderer[] = [];
  const start = async (home: RendererHome): Promise<Renderer> => {
    const { daemon, daemonLog } = buildDaemon({ home });
    const server = net.createServer((sock) => handleConnection(daemon, sock));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath(home), () => {
        server.off("error", reject);
        resolve();
      });
    });
    const r = { home, daemon, daemonLog, server };
    running.push(r);
    return r;
  };
  // Closing lands every debounced write, so the tree holds all it will.
  const stop = async (r: Renderer): Promise<void> => {
    running.splice(running.indexOf(r), 1);
    await r.daemon.close(NO_TMUX_AT_EXIT);
    await new Promise<void>((resolve) => r.server.close(() => resolve()));
    await r.daemonLog.drained();
    r.daemonLog.dispose();
  };

  try {
    const homes = [homeNamed("alpha"), homeNamed("beta")] as const;
    for (const home of homes) {
      fs.mkdirSync(configDir(home), { recursive: true });
      fs.writeFileSync(configOf(home), CONFIG);
    }
    const [a, b] = [await start(homes[0]), await start(homes[1])];
    expect(socketPath(a.home)).toBe(path.join(runtime, "alpha.sock"));
    expect(socketPath(b.home)).toBe(path.join(runtime, "beta.sock"));

    // Alpha names its config file, so its origin holds a file in its home;
    // beta's is found by the search.
    const sidOf = (r: Renderer): string => `two-homes-${r.home.name}`;
    for (const [r, args] of [
      [a, configFlag(configOf(a.home))],
      [b, []],
    ] as const) {
      const bar = await render(r.home, sidOf(r), projectDir, {}, [...args]);
      expect(textOf(bar)).toContain("[pad]");
      const url = linkUrls(bar).find((u) =>
        effectsOf(u).some((e) => e.verb === "persist" || e.verb === "set-config"),
      );
      if (url === undefined) throw new Error(`no persist link in:\n${textOf(bar)}`);
      await click(r.home, url);
      expect(fs.readFileSync(configOf(r.home), "utf8")).toMatch(/padding:\s*4/);
    }
    await stop(a);
    await stop(b);

    // No stored file names a root, the other's or its own.
    for (const home of homes) {
      const files = storedUnder(rootOf(home));
      expect(files.map((f) => path.relative(rootOf(home), f.file))).toEqual(
        expect.arrayContaining([
          path.join("state", "session-state.json"),
          path.join("state", "settings-history.json"),
        ]),
      );
      const naming = files.filter((f) => homes.some((h) => f.text.includes(rootOf(h))));
      expect(naming.map((f) => f.file)).toEqual([]);
    }
    expect(fs.readFileSync(configOf(a.home), "utf8")).toBe(
      fs.readFileSync(configOf(b.home), "utf8"),
    );

    // Alpha's tree, copied under a third root, is a renderer of its own: an
    // undo of alpha's session there rewrites the copy's config, and alpha's
    // stays as it was.
    const alphaText = fs.readFileSync(configOf(a.home), "utf8");
    const gammaHome = homeNamed("gamma");
    fs.cpSync(rootOf(a.home), rootOf(gammaHome), { recursive: true });
    const c = await start(gammaHome);
    await click(c.home, effectsUrl([{ verb: VERB_UNDO, args: [sidOf(a)] }]));
    expect(fs.readFileSync(configOf(c.home), "utf8")).toBe(CONFIG);
    expect(fs.readFileSync(configOf(a.home), "utf8")).toBe(alphaText);
  } finally {
    for (const r of [...running]) await stop(r);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

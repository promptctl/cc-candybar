// [LAW:nothing-unseen] A plugin's session source, measured on a REAL daemon:
// the bar a request draws before and after the plugin's program writes the
// session's file, the config-load event's `sources=`, and the render event's
// `sources=`/`sourcesPending=` — the daemon's own wiring of the storage owner
// into the render states and the views' declarations.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { hookData, killAndWait, renderRequest, stripAnsi } from "./helpers/daemon-e2e";
import {
  prepareIsolatedDaemonEnv,
  spawnDaemonWithEnv,
  type RunningDaemon,
} from "./helpers/spawn-isolated-daemon";
import { loggedWhen, renderLines } from "./helpers/daemon-log";

jest.setTimeout(30_000);

const SESSION = "sources-e2e-0001";

describe("a daemon reads a plugin's session source", () => {
  let env: NodeJS.ProcessEnv;
  let sockPath: string;
  let removeTmpDirs: () => void;
  let projectDir: string;
  let config: string;
  let storage: string;
  let daemon: RunningDaemon | undefined;

  beforeAll(async () => {
    const prepared = prepareIsolatedDaemonEnv("cc-candybar-sources-e2e");
    ({ sockPath, env, removeTmpDirs } = prepared);
    projectDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cc-candybar-sources-e2e-")));
    fs.mkdirSync(path.join(projectDir, "p"));
    fs.writeFileSync(
      path.join(projectDir, "p", "plugin.json5"),
      `{
        sources: { status: { scope: "session", refresh: { watch: true }, read: { file: { json: true } } } },
        segments: { gated: { when: '{{ hasKey .plugins.p "status" }}', template: 'home={{ .plugins.p.status.home }}' } },
      }`,
    );
    config = path.join(projectDir, "config.json5");
    fs.writeFileSync(
      config,
      `{ plugins: ["./p/plugin.json5"], segments: { mine: { template: "mine" } }, root: { h: ["mine", "plugins.p.gated"] } }`,
    );
    storage = path.join(projectDir, "p", "session");
    daemon = await spawnDaemonWithEnv(prepared.env);
  });

  afterAll(async () => {
    if (daemon) await killAndWait(daemon);
    fs.rmSync(projectDir, { recursive: true, force: true });
    removeTmpDirs();
  });

  const render = async (): Promise<string> =>
    stripAnsi(
      await renderRequest(sockPath, {
        hookData: hookData(SESSION, projectDir),
        args: ["cc-candybar", "--config", config],
        cwd: projectDir,
      }),
    );

  test("hidden until the program writes, then the write draws; the events count the source", async () => {
    const first = await render();
    expect(first).toContain("mine");
    expect(first).not.toContain("home=");
    // The load created the folder the program writes into.
    expect(fs.statSync(storage).isDirectory()).toBe(true);
    await loggedWhen(
      env,
      (lines) => lines.some((l) => l.includes("config load ") && l.includes(" sources=1 pluginVariables=0 ")),
      "the config-load event counting the plugin's source",
    );
    // The request waited for the source's first read, so nothing was pending
    // when it drew.
    const [event] = await renderLines(env, SESSION);
    expect(event).toContain(" sources=1 sourcesPending=- ");

    // The program's write: the whole file, renamed into place, again until a
    // render shows it (the folder's watch goes live after it opens).
    let shown = "";
    for (let round = 0; round < 50 && !shown.includes("home=/h"); round++) {
      const tmp = path.join(storage, `.${SESSION}.tmp`);
      fs.writeFileSync(tmp, JSON.stringify({ home: "/h" }));
      fs.renameSync(tmp, path.join(storage, `${SESSION}.json`));
      await new Promise((r) => setTimeout(r, 100));
      shown = await render();
    }
    expect(shown).toContain("home=/h");
  });
});

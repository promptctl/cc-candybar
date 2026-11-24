import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { PROTOCOL_VERSION } from "../../../src/daemon/foundations/protocol";
import { sendDaemonRequest } from "../../../scripts/lib/daemon/wire";
import { answerRepo } from "../../helpers/repo-approval";
import { configFlag, hookData, render, renderBody, runRealClient } from "../../helpers/daemon-e2e";
import { prepareIsolatedDaemonEnv, type RunningDaemon } from "../../../scripts/lib/daemon/isolated";
import { spawnDaemonWithEnv } from "../../helpers/spawn-isolated-daemon";

jest.setTimeout(30_000);

// The wire of a real client: its own process, env and cwd, over a socket. A
// client run with `spawnSync` would block a daemon in this worker, so these
// keep a real daemon.
describe("brandon-config-5g8: a real client's config reaches a running daemon", () => {
  let sockPath: string;
  let env: NodeJS.ProcessEnv;
  let removeTmpDirs: () => void;
  let projectDir: string;
  let daemon: RunningDaemon | undefined;
  let override: string;

  beforeAll(async () => {
    const prepared = prepareIsolatedDaemonEnv("cc-candybar-config-env-e2e");
    ({ sockPath, env, removeTmpDirs } = prepared);
    delete prepared.env.CC_CANDYBAR_CONFIG;
    projectDir = mkdtempSync(
      path.join(os.tmpdir(), "cc-candybar-config-env-e2e-project-"),
    );
    override = path.join(projectDir, "override.json5");
    writeFileSync(
      override,
      `{ segments: { a: { template: 'OVERRIDE-WINS' } }, root: { h: ['a'] } }`,
    );
    daemon = await spawnDaemonWithEnv(prepared.env);
  });

  afterAll(async () => {
    if (daemon) await daemon.stop();
    rmSync(projectDir, { recursive: true, force: true });
    removeTmpDirs();
  });

  // The production wiring end to end: the REAL client (`dist/index.mjs`,
  // the bundle `cc-candybar install` stages) reads the hook payload from
  // stdin, lifts CC_CANDYBAR_CONFIG from ITS OWN environment into the
  // `configEnv` hint (src/index.ts), and relays it over the socket — the
  // daemon, spawned without the variable, renders the hinted file's bar.
  //
  // brandon-config-nuq6: a RELATIVE value names a file relative to the
  // client's cwd. The daemon runs in another directory, so the client must
  // resolve it before it crosses the wire.
  test.each([
    ["an absolute", () => override],
    ["a relative", () => path.basename(override)],
  ])("the real client carries %s CC_CANDYBAR_CONFIG to the daemon", async (_, value) => {
    const sid = `cfg-env-real-client-${path.isAbsolute(value()) ? "abs" : "rel"}`;
    // Warm the entry so the client's one bounded request cannot hit a cold
    // first-load timeout; runRealClient reruns a blank answer as the next
    // tick would, but a warm entry keeps that the exception. The cache key is
    // (projectDir, cwd, configFile) and the client reports ITS OWN cwd as
    // `req.cwd`, so it is spawned in projectDir: the entry it hits is the
    // one this warmed. Each literal below is one run of the bar it printed.
    await render(sockPath, sid, projectDir, { configEnv: override });
    const client = runRealClient([], {
      cwd: projectDir,
      env: { ...env, CC_CANDYBAR_CONFIG: value() },
      input: JSON.stringify(hookData(sid, projectDir)),
    });
    expect(client.status).toBe(0);
    const bar = client.stdout;
    expect(bar).toContain("OVERRIDE-WINS");
    expect(bar).not.toContain("Invalid config");
    expect(bar).not.toContain("Config file not found");
    expect(bar).not.toContain("Unexpected arguments");
  });

  // brandon-unfiled-3248.8bz: the real client's argv is `[node, script,
  // ...flags]`; it sends the daemon the script and its flags, the shape the
  // native client sends (its binary and its flags), so the script is not
  // refused as a stray word and `--config` reaches the daemon.
  test("the real client relays --config with nothing refused", async () => {
    const sid = "cfg-flag-real-client";
    await render(sockPath, sid, projectDir, {}, configFlag(override));
    const client = runRealClient(["--config", override], {
      cwd: projectDir,
      env,
      input: JSON.stringify(hookData(sid, projectDir)),
    });
    expect(client.status).toBe(0);
    const bar = client.stdout;
    expect(bar).toContain("OVERRIDE-WINS");
    expect(bar).not.toContain("Unexpected arguments");
  });

  test("layered and isolated clients can use the same base against one daemon", async () => {
    const repo = mkdtempSync(path.join(projectDir, "modes-"));
    const pluginDir = path.join(repo, ".cc-candybar", "plugins", "marker");
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(
      path.join(pluginDir, "plugin.json5"),
      "{ segments: { row: { template: 'REPO-PLUGIN' } } }",
    );
    writeFileSync(
      path.join(repo, ".cc-candybar.json5"),
      "{ root: { h: ['a', 'repo.marker.row'] } }",
    );
    writeFileSync(
      path.join(repo, ".cc-candybar.local.json5"),
      "{ segments: { a: { template: 'LOCAL-OVERRIDE' } } }",
    );
    answerRepo(repo, "approved", env);
    for (const [flag, expected, excluded] of [
      ["--config", ["LOCAL-OVERRIDE", "REPO-PLUGIN"], ["OVERRIDE-WINS"]],
      ["--config-only", ["OVERRIDE-WINS"], ["LOCAL-OVERRIDE", "REPO-PLUGIN"]],
    ] as const) {
      const sid = "cfg-mode-" + flag;
      const args = [flag, override];
      await render(sockPath, sid, repo, {}, ["cc-candybar", ...args]);
      const client = runRealClient(args, {
        cwd: repo,
        env,
        input: JSON.stringify(hookData(sid, repo)),
      });
      expect(client.status).toBe(0);
      for (const text of expected) expect(client.stdout).toContain(text);
      for (const text of excluded) expect(client.stdout).not.toContain(text);
      expect(client.stdout).not.toContain("Unknown flags");
    }
  });

  test.each([
    { args: ["--config-only"], problem: "--config-only needs a path" },
    { args: ["--config-only", ""], problem: "--config-only needs a path" },
    {
      args: ["--config", "--config-only", "override.json5"],
      problem: "--config names no file before --config-only",
    },
  ])("invalid isolation request $args is refused instead of using the base hint", async ({ args, problem }) => {
    const body = renderBody("cfg-invalid-only", projectDir, { configEnv: override }, [
      "cc-candybar",
      ...args,
    ]);
    const response = await sendDaemonRequest(sockPath, {
      v: PROTOCOL_VERSION,
      kind: "render",
      ...body,
    });
    expect(response).toMatchObject({ ok: false, error: expect.stringContaining(problem) });
  });
});

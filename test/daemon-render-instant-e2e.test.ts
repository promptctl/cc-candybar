// [LAW:nothing-unseen] brandon-effects-2gka.m0t, measured on a REAL daemon: a
// render request samples its clock once, the bar is drawn at that instant, and
// the daemon's one event per render — its `render sid=…` log line — names it.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { logPath } from "../src/daemon/paths";
import { killAndWait, render, stripAnsi } from "./helpers/daemon-e2e";
import {
  prepareIsolatedDaemonEnv,
  spawnDaemonWithEnv,
  type RunningDaemon,
} from "./helpers/spawn-isolated-daemon";

jest.setTimeout(30_000);

describe("a daemon render is drawn at the instant its request sampled, and logs it", () => {
  let sockPath: string;
  let env: NodeJS.ProcessEnv;
  let removeTmpDirs: () => void;
  let projectDir: string;
  let config: string;
  let daemon: RunningDaemon | undefined;

  beforeAll(async () => {
    const prepared = prepareIsolatedDaemonEnv("cc-candybar-instant-e2e");
    ({ sockPath, env, removeTmpDirs } = prepared);
    projectDir = mkdtempSync(path.join(os.tmpdir(), "cc-candybar-instant-e2e-"));
    config = path.join(projectDir, "epoch.json5");
    writeFileSync(
      config,
      `{ segments: { epoch: { template: 'EPOCH={{ unixEpoch now }}{{ date ".000" now }}' } }, root: { h: ['epoch'] } }`,
    );
    daemon = await spawnDaemonWithEnv(prepared.env);
  });

  afterAll(async () => {
    if (daemon) await killAndWait(daemon);
    rmSync(projectDir, { recursive: true, force: true });
    removeTmpDirs();
  });

  test("the bar's `now` and the render event's `at=` are one instant, inside the request", async () => {
    const sessionId = "instant-e2e-session";
    const before = Date.now() / 1000;
    const bar = stripAnsi(
      await render(sockPath, sessionId, projectDir, {}, [
        "cc-candybar",
        "--config",
        config,
      ]),
    );
    const after = Date.now() / 1000;

    const shown = bar.match(/EPOCH=(\d+\.\d{3})/)?.[1];
    // A request the helper retried after a reply timeout is logged once per
    // attempt, so the reply's render is the event whose instant the bar shows,
    // to the millisecond — which is the claim itself.
    const instants = readFileSync(logPath(env), "utf8")
      .split("\n")
      .filter((l) => l.includes(`render sid=${sessionId} `))
      .map((l) => l.match(/ at=(\d+\.\d{3}) /)?.[1]);

    expect(shown).toMatch(/^\d+\.\d{3}$/);
    expect(instants).toContain(shown);
    const at = Number(shown);
    expect(at).toBeGreaterThanOrEqual(Math.floor(before));
    expect(at).toBeLessThanOrEqual(after);
  });
});

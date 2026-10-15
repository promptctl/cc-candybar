// [LAW:nothing-unseen] brandon-effects-2gka.d2i, measured on a REAL daemon: the
// render event — its `render sid=…` log line — names the effect the bar wore,
// the effect's own clock, and whether each row's effect was made or reused.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { logPath } from "../src/daemon/paths";
import { killAndWait, render } from "./helpers/daemon-e2e";
import {
  prepareIsolatedDaemonEnv,
  spawnDaemonWithEnv,
  type RunningDaemon,
} from "./helpers/spawn-isolated-daemon";

jest.setTimeout(30_000);

describe("a daemon render's event names the effect it wore", () => {
  let sockPath: string;
  let env: NodeJS.ProcessEnv;
  let removeTmpDirs: () => void;
  let projectDir: string;
  let config: string;
  let daemon: RunningDaemon | undefined;

  beforeAll(async () => {
    const prepared = prepareIsolatedDaemonEnv("cc-candybar-effect-e2e");
    ({ sockPath, env, removeTmpDirs } = prepared);
    projectDir = mkdtempSync(path.join(os.tmpdir(), "cc-candybar-effect-e2e-"));
    config = path.join(projectDir, "shimmer.json5");
    writeFileSync(
      config,
      `{ globals: { effect: "shimmer" }, segments: { a: { template: 'steady' } }, root: { h: ['a'] } }`,
    );
    daemon = await spawnDaemonWithEnv(prepared.env);
  });

  afterAll(async () => {
    if (daemon) await killAndWait(daemon);
    rmSync(projectDir, { recursive: true, force: true });
    removeTmpDirs();
  });

  test("the first render brings the effect into force; the next reuses each row's effect on its clock", async () => {
    const sessionId = "effect-e2e-session";
    const argv = ["cc-candybar", "--config", config];
    await render(sockPath, sessionId, projectDir, {}, argv);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await render(sockPath, sessionId, projectDir, {}, argv);

    const events = readFileSync(logPath(env), "utf8")
      .split("\n")
      .filter((l) => l.includes(`render sid=${sessionId} `))
      .map((l) => ({
        effect: l.match(/ effect=(\S+) /)?.[1],
        t: Number(l.match(/ effectT=(\d+\.\d{3}) /)?.[1]),
        made: Number(l.match(/ effectRows=(\d+)made\//)?.[1]),
        reused: Number(l.match(/\/(\d+)reused /)?.[1]),
      }));

    expect(events).toHaveLength(2);
    const [first, second] = events;
    expect(first).toMatchObject({ effect: "shimmer", t: 0, reused: 0 });
    expect(first!.made).toBeGreaterThan(0);
    expect(second!.effect).toBe("shimmer");
    expect(second!.t).toBeGreaterThan(0);
    expect(second).toMatchObject({ made: 0, reused: first!.made });
  });
});

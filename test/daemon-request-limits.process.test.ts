// A request's time limit a real process holds: what the connection's backstop
// answers is decided by the loop's own turns, and in a jest worker the reply
// won or lost by which case ran before it. How a request's wait ends is
// test/daemon-render-event-e2e.test.ts's, in the worker.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { PROTOCOL_VERSION, TOTAL_BUDGET_MS } from "../src/daemon/protocol";
import { REQUEST_TIMEOUT_MS } from "../src/daemon/request-deadline";
import { killAndWait, renderBody } from "./helpers/daemon-e2e";
import { sendDaemonRequest } from "./helpers/daemon-wire";
import { field, landedEvents, only } from "./helpers/request-event";
import {
  prepareIsolatedDaemonEnv,
  spawnDaemonWithEnv,
  type RunningDaemon,
} from "./helpers/spawn-isolated-daemon";

const TEST_TIMEOUT_MS = 30_000;

jest.setTimeout(TEST_TIMEOUT_MS);

describe("a request's time limits", () => {
  let env: NodeJS.ProcessEnv;
  let sockPath: string;
  let removeTmpDirs: () => void;
  let projectDir: string;
  let daemon: RunningDaemon | undefined;

  beforeAll(async () => {
    const prepared = prepareIsolatedDaemonEnv("cc-candybar-event-deadline");
    ({ sockPath, env, removeTmpDirs } = prepared);
    projectDir = mkdtempSync(
      path.join(os.tmpdir(), "cc-candybar-render-event-e2e-"),
    );
    daemon = await spawnDaemonWithEnv(env);
  });

  afterAll(async () => {
    if (daemon) await killAndWait(daemon);
    rmSync(projectDir, { recursive: true, force: true });
    removeTmpDirs();
  });

  // The connection's backstop answers TIMEOUT whatever the render is still
  // doing. A wait ends before it, so what outlives it is a synchronous turn:
  // here the first request's compile of a config big enough to take several
  // times the backstop. The render's event says the client read another
  // reply, and the hold it drew under is released when it ends.
  test("a render that outlives its request timeout writes timedOut=Y", async () => {
    const segments = Object.fromEntries(
      Array.from({ length: 600 }, (_, i) => [
        `s${i}`,
        { template: `{{ .session.id }} ${i}` },
      ]),
    );
    const config = path.join(projectDir, "heavy.json5");
    writeFileSync(
      config,
      JSON.stringify({ segments, root: { h: Object.keys(segments) } }),
    );
    // [LAW:no-ambient-temporal-coupling] The backstop's TIMEOUT reply is a
    // task on the daemon's loop, so it cannot be written until the
    // synchronous compile yields: this client's wait is bounded by the
    // compile, seconds on CI's two cores, not by the backstop. The helper's
    // default budget is for an answered request, so the budget here is the
    // test's own timeout, and nothing ends the wait before Jest would. The
    // event's `took` below is what says the render outlived the backstop.
    await expect(
      sendDaemonRequest(
        sockPath,
        {
          v: PROTOCOL_VERSION,
          kind: "render",
          ...renderBody("ev-backstop", projectDir, {}, [
            "cc-candybar",
            "--config",
            config,
          ]),
          deadline: Date.now() + TOTAL_BUDGET_MS,
        },
        TEST_TIMEOUT_MS,
      ),
    ).resolves.toMatchObject({ ok: false, code: "TIMEOUT" });
    const late = only(await landedEvents(env, "ev-backstop", 1));
    expect(field(late, "outcome")).toBe("ok");
    expect(field(late, "timedOut")).toBe("Y");
    expect(Number(field(late, "took")?.replace(/ms$/u, ""))).toBeGreaterThan(
      REQUEST_TIMEOUT_MS,
    );
    await expect(
      sendDaemonRequest(sockPath, { v: PROTOCOL_VERSION, kind: "stats" }),
    ).resolves.toMatchObject({ ok: true, stats: { renderCache: { held: 0 } } });
  });
});

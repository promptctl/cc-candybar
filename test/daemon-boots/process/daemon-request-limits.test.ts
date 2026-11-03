// A request's time limit a real process holds: what the connection's backstop
// answers is decided by the loop's own turns, and in a jest worker the reply
// won or lost by which case ran before it. How a request's wait ends is
// test/daemon-render-event-e2e.test.ts's, in the worker.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { open } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { PROTOCOL_VERSION, TOTAL_BUDGET_MS } from "../../../src/daemon/protocol";
import { REQUEST_TIMEOUT_MS } from "../../../src/daemon/request-deadline";
import { killAndWait, renderBody } from "../../helpers/daemon-e2e";
import { sendDaemonRequest } from "../../helpers/daemon-wire";
import { field, landedEvents, only } from "../../helpers/request-event";
import {
  prepareIsolatedDaemonEnv,
  spawnDaemonWithEnv,
} from "../../helpers/spawn-isolated-daemon";

const TEST_TIMEOUT_MS = 30_000;

jest.setTimeout(TEST_TIMEOUT_MS);

// The connection's backstop answers TIMEOUT whatever the render is still
// doing. A wait ends before it, so what outlives it is a synchronous turn: here
// the render's read of its config file, which blocks the daemon's loop until
// the test writes into the pipe the file is. The test holds that read open
// past the backstop, so the render outlives it by construction, not by how
// slow a compile is on this machine. The render's event says the client read
// another reply, and the hold it drew under is released when it ends.
test("a render that outlives its request timeout writes timedOut=Y", async () => {
  const { sockPath, env, removeTmpDirs } = prepareIsolatedDaemonEnv(
    "cc-candybar-request-limits",
  );
  const projectDir = mkdtempSync(
    path.join(os.tmpdir(), "cc-candybar-request-limits-"),
  );
  const config = path.join(projectDir, "held.json5");
  execFileSync("mkfifo", [config]);
  const daemon = await spawnDaemonWithEnv(env);
  try {
    // [LAW:no-ambient-temporal-coupling] The backstop's TIMEOUT reply is a
    // task on the daemon's loop, so it cannot be written until the
    // synchronous read yields: this client's wait is bounded by the hold
    // below, not by the backstop. The helper's default budget is for an
    // answered request, so the budget here is the test's own timeout. The
    // event's `took` below is what says the render outlived the backstop.
    const answered = sendDaemonRequest(
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
    );
    // A pipe opens for writing only once a reader has opened it, so this
    // open resolving is the daemon's loop stopping in its read. A render that
    // never reads its config leaves the open waiting for good, so the
    // request's own end is raced against it: the case fails on that reply, not
    // on the test timeout.
    const pipe = await Promise.race([
      open(config, "w"),
      answered.then((reply) => {
        throw new Error(
          `the render answered before reading its config: ${JSON.stringify(reply)}`,
        );
      }),
    ]);
    await sleep(REQUEST_TIMEOUT_MS * 2);
    await pipe.writeFile(JSON.stringify({ segments: {}, root: { h: [] } }));
    await pipe.close();
    await expect(answered).resolves.toMatchObject({
      ok: false,
      code: "TIMEOUT",
    });
    const late = only(await landedEvents(env, "ev-backstop", 1));
    expect(field(late, "outcome")).toBe("ok");
    expect(field(late, "timedOut")).toBe("Y");
    expect(Number(field(late, "took")?.replace(/ms$/u, ""))).toBeGreaterThan(
      REQUEST_TIMEOUT_MS,
    );
    await expect(
      sendDaemonRequest(sockPath, { v: PROTOCOL_VERSION, kind: "stats" }),
    ).resolves.toMatchObject({ ok: true, stats: { renderCache: { held: 0 } } });
  } finally {
    await killAndWait(daemon);
    rmSync(projectDir, { recursive: true, force: true });
    removeTmpDirs();
  }
});

// A request's time limit a real process holds: what the connection's backstop
// answers is decided by the loop's own turns, and in a jest worker the reply
// won or lost by which case ran before it. How a request's wait ends is
// test/daemon-render-event-e2e.test.ts's, in the worker.

import { execFileSync } from "node:child_process";
import { constants, mkdtempSync, rmSync } from "node:fs";
import { open } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import {
  PROTOCOL_VERSION,
  TOTAL_BUDGET_MS,
} from "../../../src/daemon/protocol";
import { REQUEST_TIMEOUT_MS } from "../../../src/daemon/request-deadline";
import { restOfCase } from "../../helpers/case-time";
import { killAndWait, renderBody } from "../../helpers/daemon-e2e";
import { sendDaemonRequest, sendWithin } from "../../helpers/daemon-wire";
import { field, landedEvents, only } from "../../helpers/request-event";
import {
  prepareIsolatedDaemonEnv,
  spawnDaemonWithEnv,
} from "../../helpers/spawn-isolated-daemon";

// The connection's backstop answers TIMEOUT only if the loop gets a turn
// before the reply, and a render takes none after its wait: a wait whose time
// is gone ends in the same turn. So a render whose synchronous setup outlives
// the backstop (here its read of its config file, which blocks the daemon's
// loop until the test writes into the pipe the file is) still answers its
// client with the bar in the turn the read ends in, and the backstop, cleared
// by that answer, writes nothing over it. The read is held open past the
// backstop by construction, not by how slow a compile is on this machine, and
// the hold the render drew under is released when it ends.
test("a render whose config read outlives the request timeout answers its client in the turn the read ends", async () => {
  const { sockPath, home, env, removeTmpDirs } = prepareIsolatedDaemonEnv(
    "cc-candybar-request-limits",
  );
  const projectDir = mkdtempSync(
    path.join(os.tmpdir(), "cc-candybar-request-limits-"),
  );
  const config = path.join(projectDir, "held.json5");
  execFileSync("mkfifo", [config]);
  const daemon = await spawnDaemonWithEnv(env);
  try {
    // [LAW:no-ambient-temporal-coupling] Nothing is written until the
    // synchronous read yields, and the answer is written in the turn it
    // yields in: this client's wait is bounded by the hold below, not by the
    // backstop. The helper's default budget is for an answered request, so
    // the budget here is the rest of the case. The event's `took` below is
    // what says the render outlived the backstop.
    const answered = sendWithin(
      home,
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
      restOfCase(),
    );
    // A pipe opens for writing only once a reader has opened it, so this
    // open resolving is the daemon's loop stopping in its read. A render that
    // never reads its config leaves the open waiting for good, so the
    // request's own end is raced against it: the case fails on that reply, not
    // on the test timeout. The open still waiting is then released by a
    // reader of its own, so no threadpool thread stays blocked on the pipe.
    const writer = open(config, "w");
    const pipe = await Promise.race([
      writer,
      answered.then((reply) => {
        throw new Error(
          `the render answered before reading its config: ${JSON.stringify(reply)}`,
        );
      }),
    ]).catch(async (e: unknown) => {
      const reader = await open(
        config,
        constants.O_RDONLY | constants.O_NONBLOCK,
      );
      await (await writer).close();
      await reader.close();
      throw e;
    });
    await sleep(REQUEST_TIMEOUT_MS * 2);
    await pipe.writeFile(JSON.stringify({ segments: {}, root: { h: [] } }));
    await pipe.close();
    await expect(answered).resolves.toMatchObject({ ok: true });
    const late = only(await landedEvents(env, "ev-backstop", 1));
    expect(field(late, "outcome")).toBe("ok");
    expect(field(late, "timedOut")).toBe("N");
    expect(Number(field(late, "took")?.replace(/ms$/u, ""))).toBeGreaterThan(
      REQUEST_TIMEOUT_MS,
    );
    await expect(
      sendDaemonRequest(home, { v: PROTOCOL_VERSION, kind: "stats" }),
    ).resolves.toMatchObject({ ok: true, stats: { renderCache: { held: 0 } } });
  } finally {
    await killAndWait(daemon);
    rmSync(projectDir, { recursive: true, force: true });
    removeTmpDirs();
  }
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { isConnectable } from "./helpers/daemon-wire";
import { spawnTestDaemon } from "./helpers/spawn-test-daemon";
import { until } from "./helpers/until";

// [LAW:behavior-not-structure] The unit tests in test/daemon-acquire.test.ts call resetSpawnBackoff()
// directly — they pin its arithmetic but not its WIRING. This spawns a real
// daemon and drives it through an actual bind, so a regression that drops or
// reorders the resetSpawnBackoff() call inside server.ts's onListening (or
// drops the import) fails THIS test even though every one of those would still
// pass unmodified.
describe("resetSpawnBackoff wiring into onListening (integration: real daemon)", () => {
  jest.setTimeout(30_000);

  test("a real daemon bind deletes a pre-existing spawn.backoff streak file", async () => {
    const stateRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "cc-candybar-backoff-wire-"),
    );
    const stateDir = path.join(stateRoot, "cc-candybar");
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const sockPath = path.join(stateDir, "socket");
    const cacheHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "cc-candybar-backoff-wire-c-"),
    );
    const configHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "cc-candybar-backoff-wire-g-"),
    );
    const backoffPath = path.join(stateDir, "spawn.backoff");
    // Plant a streak as if several prior kicks failed to converge — the exact
    // state resetSpawnBackoff() must clear the moment this daemon binds.
    fs.writeFileSync(backoffPath, "3", { mode: 0o600 });

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CC_CANDYBAR_SOCKET: sockPath,
      XDG_STATE_HOME: stateRoot,
      XDG_CACHE_HOME: cacheHome,
      XDG_CONFIG_HOME: configHome,
    };

    const { child: daemon, killTree, release } = await spawnTestDaemon(env);
    try {
      await until(() => isConnectable(sockPath), "the daemon's socket", 8000);
      // [LAW:no-ambient-temporal-coupling] Kernel connectability begins when
      // listen(2) completes — BEFORE the daemon's 'listening' JS callback
      // (where resetSpawnBackoff runs) has executed. An instant existsSync
      // here races that callback and loses on slow CI runners. The contract
      // is "a serving daemon promptly clears the streak", so await exactly
      // that: the file's disappearance, within a bounded budget.
      await until(
        () => !fs.existsSync(backoffPath),
        "the backoff wire's removal",
        8000,
      );
    } finally {
      killTree();
      await new Promise<void>((resolve) => {
        if (daemon.exitCode !== null || daemon.signalCode !== null) {
          resolve();
          return;
        }
        daemon.once("exit", () => resolve());
      });
      release();
      for (const d of [stateRoot, cacheHome, configHome]) {
        try {
          fs.rmSync(d, { recursive: true, force: true });
        } catch {
          // best-effort cleanup
        }
      }
    }
  });
});

// [LAW:verifiable-goals] The tmux stub the daemon tests stand on ends with its
// gate, so a run that ends before the gate opens leaves no stub behind.

import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { tmuxStub } from "./helpers/tmux-stub";
import { until } from "./helpers/until";

describe("the tmux stub's wait is its gate's", () => {
  // [LAW:no-ambient-temporal-coupling] Started here, leading its own process
  // group, the stub is out of reach of anything that kills this test, and no
  // lifeline holds it. Only its gate ends it, so a run that ends before the
  // gate opens leaves nothing behind.
  test("a stub whose gate closes before it opens exits", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-candybar-tmux-stub-gate-"));
    const stub = await tmuxStub(dir);
    const child = spawn(path.join(dir, "tmux"), [], {
      detached: true,
      stdio: "ignore",
    });
    try {
      // A spawn that fails rejects here, by name, and the gate closes
      // whichever way this ends.
      await Promise.all([once(child, "spawn"), stub.asked(1)]).finally(async () =>
        await stub.close(),
      );
      // Bounded, so a stub that ignores its gate fails this test by name and
      // the cleanup below still runs.
      await until(
        () => child.exitCode !== null || child.signalCode !== null,
        "the stub exiting once its gate closed",
      );
      expect([child.exitCode, child.signalCode]).toEqual([1, null]);
    } finally {
      // A failed run leaves no stub either. The stub is node itself, so the
      // child is the whole of it.
      child.kill("SIGKILL");
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

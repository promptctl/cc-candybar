import { processLauncher } from "../src/proc/launch";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createDaemonPool } from "./helpers/daemon-pool";
import { spawnTestDaemon, type TestDaemonProcess } from "./helpers/spawn-test-daemon";
import { throughout, until } from "./helpers/until";
import { readStartTime } from "../src/daemon/process-fingerprint";

// [LAW:verifiable-goals] Pins the shared-pool primitive's core contract in
// isolation — no real cc-candybar daemon spawns, so this stays fast — mirroring
// the arbitrateSocket pure-fold test style: full input-space coverage of the
// mechanism the fork-bomb epic (brandon-daemon-lifecycle-gad.1) needs to hold.

// [LAW:single-enforcer] Every `tmpPoolDir()` call in this file is tracked
// here and swept once in the file-level `afterAll` — the one cleanup site,
// so no individual test needs its own dir-removal boilerplate.
const createdPoolDirs: string[] = [];
function tmpPoolDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-candybar-pool-test-"));
  createdPoolDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of createdPoolDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
  createdPoolDirs.length = 0;
});

describe("daemon pool", () => {
  test("acquires up to `size` slots concurrently, then blocks", async () => {
    const pool = createDaemonPool(tmpPoolDir(), 2);
    const a = await pool.acquire();
    const b = await pool.acquire();
    // Both live (this process's own pid), so the pool is genuinely full — a
    // third acquire must not proceed until one is released.
    await expect(
      pool.acquire({ timeoutMs: 300, retryIntervalMs: 50 }),
    ).rejects.toThrow(/no free slot/);
    a.release();
    b.release();
  });

  test("releasing a slot unblocks a pending acquire", async () => {
    const pool = createDaemonPool(tmpPoolDir(), 1);
    const a = await pool.acquire();
    const pending = pool.acquire({ timeoutMs: 5000, retryIntervalMs: 50 });
    // Give the pending acquire a moment to actually be polling before we free
    // the slot, so this exercises the retry path rather than a lucky win.
    await new Promise((r) => setTimeout(r, 100));
    a.release();
    const b = await pending;
    b.release();
  });

  // [LAW:behavior-not-structure] The reclaim path is what stops a single
  // crashed test daemon from permanently consuming a slot. Uses a REAL dead
  // pid (spawned, killed, awaited) rather than a fabricated number — a
  // fabricated pid risks colliding with a live unrelated process on the host,
  // which would make this test non-deterministic.
  test("reclaims a slot whose recorded owner is dead", async () => {
    // Kept alive briefly so its start-time can actually be read before it
    // exits — a null startTime (as if unfingerprinted) would make isSlotLive
    // fall back to bare kill(pid,0), which a recycled pid could satisfy
    // within the 2000ms acquire budget on a host with aggressive pid reuse
    // (low pid_max containers) and flake this test. Recording the real
    // fingerprint exercises the same start-time-mismatch path production
    // code relies on to distinguish a recycled pid from the true owner.
    const dead = spawn(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], {
      stdio: "ignore",
    });
    const deadPid = dead.pid!;
    const startTimeRead = readStartTime(deadPid, processLauncher.launchSync);
    const deadStartTime = startTimeRead.kind === "start" ? startTimeRead.token : null;
    dead.kill("SIGKILL");
    await new Promise<void>((resolve) => dead.once("exit", () => resolve()));

    const pool = createDaemonPool(tmpPoolDir(), 1);
    // Plant a stale slot file directly, as if a prior (now-dead) process held it.
    fs.mkdirSync(pool.dir, { recursive: true });
    fs.writeFileSync(
      path.join(pool.dir, "slot-0.json"),
      JSON.stringify({ pid: deadPid, startTime: deadStartTime }),
    );

    const slot = await pool.acquire({ timeoutMs: 2000, retryIntervalMs: 50 });
    slot.release();
  });

  test("release is a no-op if the slot was already reclaimed by someone else", async () => {
    const pool = createDaemonPool(tmpPoolDir(), 1);
    const a = await pool.acquire();
    // Simulate another process reclaiming this slot after we lost ownership
    // some other way (e.g. a sweep) — release() must not blow away the new
    // owner's record.
    fs.writeFileSync(
      path.join(pool.dir, "slot-0.json"),
      JSON.stringify({ pid: 999999, startTime: null }),
    );
    a.release();
    expect(
      JSON.parse(fs.readFileSync(path.join(pool.dir, "slot-0.json"), "utf8")),
    ).toEqual({ pid: 999999, startTime: null });
  });

  test("sweepStale removes only dead-owner slots, never live ones", async () => {
    const dead = spawn(process.execPath, ["-e", "0"], { stdio: "ignore" });
    await new Promise<void>((resolve) => dead.once("exit", () => resolve()));
    const deadPid = dead.pid!;

    const pool = createDaemonPool(tmpPoolDir(), 2);
    fs.mkdirSync(pool.dir, { recursive: true });
    fs.writeFileSync(
      path.join(pool.dir, "slot-0.json"),
      JSON.stringify({ pid: deadPid, startTime: null }),
    );
    fs.writeFileSync(
      path.join(pool.dir, "slot-1.json"),
      JSON.stringify({ pid: process.pid, startTime: null }),
    );

    pool.sweepStale();

    expect(fs.existsSync(path.join(pool.dir, "slot-0.json"))).toBe(false);
    expect(fs.existsSync(path.join(pool.dir, "slot-1.json"))).toBe(true);
  });
});

// [LAW:verifiable-goals] The ceiling holds at the spawn: a process the pool has
// no slot for never starts. What that needs is a process and a slot, not a
// daemon, so each spawn runs a stand-in that leaves a marker and sleeps. It is
// `/bin/sh -c` because the helper appends `daemon`, which node would read as its
// subcommand and the ledger would count as a real start. To `sh -c` it is `$0`.
// Pinned to an isolated size-2 pool, so it never contends with the suite's spawns.
describe("the pool holds a spawn to its ceiling", () => {
  test("a 3rd spawn starts nothing until a slot frees, on a pool sized 2", async () => {
    const pool = createDaemonPool(tmpPoolDir(), 2);
    const markers = tmpPoolDir();
    const marker = (n: number): string => path.join(markers, `started-${n}`);
    const spawned: TestDaemonProcess[] = [];
    const standIn = async (n: number): Promise<TestDaemonProcess> => {
      const proc = await spawnTestDaemon(process.env, pool, {
        bin: "/bin/sh",
        args: ["-c", `: > ${JSON.stringify(marker(n))}; exec sleep 60`],
      });
      spawned.push(proc);
      return proc;
    };
    const started = (n: number) => (): boolean => fs.existsSync(marker(n));

    let third: Promise<TestDaemonProcess> | undefined;
    try {
      const first = await standIn(1);
      await standIn(2);
      await until(started(1), "the 1st stand-in starting");
      await until(started(2), "the 2nd stand-in starting");

      third = standIn(3);
      // Freed whether or not the wait passed: `third` settles only once a slot
      // does, and the `finally` below waits on it.
      await throughout(
        () => !started(3)(),
        "the 3rd stand-in staying unstarted",
        800,
      ).finally(() => {
        first.killTree();
        first.release();
      });
      await until(started(3), "the 3rd stand-in starting once a slot freed");
    } finally {
      await third;
      for (const proc of spawned) {
        proc.killTree();
        proc.release();
      }
    }
  });
});

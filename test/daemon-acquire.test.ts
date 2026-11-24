import fs from "node:fs";
import { hostOf, worldOf } from "./helpers/host";
import type { Host, World } from "../src/host";
import { recordHostBundle } from "../src/daemon/host-bundle";
import net from "node:net";
import os from "node:os";
import path from "node:path";

// Each test creates its own isolated state root and hands the code under test
// a Host that names it. CC_CANDYBAR_SOCKET isolates the socket so concurrent
// tests don't race on the same bind path; XDG_STATE_HOME isolates spawn.lock.
// Both are needed; setting only XDG would leave the socket pointed at the
// user's live daemon since socketPath(host) ignores XDG_STATE_HOME.

interface TempState {
  readonly stateDir: string;
  readonly host: Host;
  readonly world: World;
  // The bundle the state's record names.
  readonly bundle: string;
}

async function withTempState<T>(
  fn: (state: TempState) => Promise<T> | T,
): Promise<T> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-candybar-acquire-"));
  const sockPath = path.join(root, "cc-candybar", "socket");
  const host = hostOf({
    ...process.env,
    XDG_STATE_HOME: root,
    CC_CANDYBAR_SOCKET: sockPath,
  });
  // A spawn starts only from the bundle the install recorded, so every state
  // here has one; the cases about a missing record remove it.
  const bundle = path.join(root, "index.mjs");
  fs.writeFileSync(bundle, "");
  recordHostBundle(host, bundle);
  // async/try-finally — not Promise.resolve(fn()).finally(...) — because a
  // synchronous throw from fn happens *before* Promise.resolve wraps it,
  // bypassing the finally and leaking temp dirs.
  try {
    return await fn({
      stateDir: path.join(root, "cc-candybar"),
      host,
      world: worldOf(host),
      bundle,
    });
  } finally {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {}
  }
}

async function startFakeDaemon(sockPath: string): Promise<net.Server> {
  fs.mkdirSync(path.dirname(sockPath), { recursive: true });
  return new Promise((resolve, reject) => {
    const server = net.createServer((sock) => {
      sock.end();
    });
    server.once("error", reject);
    server.listen(sockPath, () => resolve(server));
  });
}

function closeServer(server: net.Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

// [LAW:behavior-not-structure] Pin the cooldown window arithmetic at its exact
// boundaries — the same conditions the Rust unit tests pin — so a TS↔Rust
// decision divergence at a threshold is caught even though check-protocol only
// diffs the constants' values. Pure over the age; no filesystem.
describe("cooldownDecision (pure window arithmetic)", () => {
  test("absent record allows (first spawn)", async () => {
    const { cooldownDecision, SPAWN_COOLDOWN_MS } =
      await import("../src/daemon/acquire");
    expect(cooldownDecision(null, SPAWN_COOLDOWN_MS)).toEqual({
      kind: "allow",
    });
  });

  test("within [0, cooldownMs) denies", async () => {
    const { cooldownDecision, SPAWN_COOLDOWN_MS } =
      await import("../src/daemon/acquire");
    expect(cooldownDecision(0, SPAWN_COOLDOWN_MS)).toEqual({ kind: "deny" });
    expect(cooldownDecision(SPAWN_COOLDOWN_MS - 1, SPAWN_COOLDOWN_MS)).toEqual({
      kind: "deny",
    });
  });

  test("at and past cooldownMs allows (half-open window)", async () => {
    const { cooldownDecision, SPAWN_COOLDOWN_MS } =
      await import("../src/daemon/acquire");
    expect(cooldownDecision(SPAWN_COOLDOWN_MS, SPAWN_COOLDOWN_MS)).toEqual({
      kind: "allow",
    });
    expect(
      cooldownDecision(SPAWN_COOLDOWN_MS + 5_000, SPAWN_COOLDOWN_MS),
    ).toEqual({
      kind: "allow",
    });
  });

  test("small negative age is precision skew, not garbage — denies", async () => {
    const { cooldownDecision, SPAWN_COOLDOWN_MS, STALE_LOCK_MS } =
      await import("../src/daemon/acquire");
    expect(cooldownDecision(-1, SPAWN_COOLDOWN_MS)).toEqual({ kind: "deny" });
    expect(cooldownDecision(-STALE_LOCK_MS, SPAWN_COOLDOWN_MS)).toEqual({
      kind: "deny",
    });
  });

  test("beyond the stale-lock window in the future is garbage — allows loudly", async () => {
    const { cooldownDecision, SPAWN_COOLDOWN_MS, STALE_LOCK_MS } =
      await import("../src/daemon/acquire");
    expect(cooldownDecision(-STALE_LOCK_MS - 1, SPAWN_COOLDOWN_MS)).toEqual({
      kind: "allow-future-garbage",
      futureMs: STALE_LOCK_MS + 1,
    });
    expect(cooldownDecision(-3_600_000, SPAWN_COOLDOWN_MS)).toEqual({
      kind: "allow-future-garbage",
      futureMs: 3_600_000,
    });
  });

  // The future-garbage boundary is anchored to STALE_LOCK_MS, NOT the
  // cooldown window — it must stay fixed even when the caller passes a
  // backed-off window far wider than STALE_LOCK_MS, so a genuinely stale
  // clock-skewed mtime is never mistaken for "still cooling down."
  test("future-garbage boundary is independent of the cooldown window", async () => {
    const { cooldownDecision, STALE_LOCK_MS, SPAWN_BACKOFF_CAP_MS } =
      await import("../src/daemon/acquire");
    expect(cooldownDecision(-STALE_LOCK_MS - 1, SPAWN_BACKOFF_CAP_MS)).toEqual({
      kind: "allow-future-garbage",
      futureMs: STALE_LOCK_MS + 1,
    });
  });
});

// [LAW:behavior-not-structure] Pin the backoff arithmetic — the streak-to-
// window mapping and its cap — matching the Rust mirror's dedicated tests.
// Pure over the streak; no filesystem.
describe("effectiveCooldownMs (pure backoff arithmetic)", () => {
  test("streak zero is the base rate", async () => {
    const { effectiveCooldownMs, SPAWN_COOLDOWN_MS } =
      await import("../src/daemon/acquire");
    expect(effectiveCooldownMs(0)).toBe(SPAWN_COOLDOWN_MS);
  });

  test("doubles per streak", async () => {
    const { effectiveCooldownMs, SPAWN_COOLDOWN_MS } =
      await import("../src/daemon/acquire");
    expect(effectiveCooldownMs(1)).toBe(SPAWN_COOLDOWN_MS * 2);
    expect(effectiveCooldownMs(2)).toBe(SPAWN_COOLDOWN_MS * 4);
    expect(effectiveCooldownMs(3)).toBe(SPAWN_COOLDOWN_MS * 8);
  });

  test("caps at SPAWN_BACKOFF_CAP_MS and never exceeds it past the max streak", async () => {
    const {
      effectiveCooldownMs,
      SPAWN_BACKOFF_CAP_MS,
      SPAWN_BACKOFF_MAX_STREAK,
    } = await import("../src/daemon/acquire");
    expect(effectiveCooldownMs(SPAWN_BACKOFF_MAX_STREAK)).toBe(
      SPAWN_BACKOFF_CAP_MS,
    );
    expect(effectiveCooldownMs(SPAWN_BACKOFF_MAX_STREAK + 1)).toBe(
      SPAWN_BACKOFF_CAP_MS,
    );
    expect(effectiveCooldownMs(1_000_000)).toBe(SPAWN_BACKOFF_CAP_MS);
  });

  test("negative streak is treated as zero", async () => {
    const { effectiveCooldownMs, SPAWN_COOLDOWN_MS } =
      await import("../src/daemon/acquire");
    expect(effectiveCooldownMs(-5)).toBe(SPAWN_COOLDOWN_MS);
  });
});

// [LAW:behavior-not-structure] Tests the parsing-strictness contract directly
// against planted file content, independent of any caller — the acceptance
// test's own writes are always a clean integer, so a regression back to
// parseInt (which truncates "5abc" to 5 instead of rejecting it) would not
// fail that test. Matches the fork-bomb-breaker.ts precedent this function's
// doc comment cites.
describe("readBackoffStreak (parsing-strictness contract)", () => {
  function withPlantedFile<T>(
    content: string | null,
    fn: (path: string) => T,
  ): T {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-candybar-backoff-"));
    const filePath = path.join(dir, "spawn.backoff");
    if (content !== null) fs.writeFileSync(filePath, content);
    try {
      return fn(filePath);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  test("missing file reads as 0", async () => {
    const { readBackoffStreak } = await import("../src/daemon/acquire");
    withPlantedFile(null, (filePath) => {
      expect(readBackoffStreak(filePath)).toBe(0);
    });
  });

  test("non-numeric content fails closed to 0 (the parseInt-truncation regression)", async () => {
    const { readBackoffStreak } = await import("../src/daemon/acquire");
    // parseInt("5abc", 10) === 5 — the exact silent-truncation bug this
    // function's Number(raw) is written to avoid.
    withPlantedFile("5abc", (filePath) => {
      expect(readBackoffStreak(filePath)).toBe(0);
    });
  });

  test("whitespace-only content reads as 0", async () => {
    const { readBackoffStreak } = await import("../src/daemon/acquire");
    withPlantedFile("   \n", (filePath) => {
      expect(readBackoffStreak(filePath)).toBe(0);
    });
  });

  test("negative content reads as 0", async () => {
    const { readBackoffStreak } = await import("../src/daemon/acquire");
    withPlantedFile("-3", (filePath) => {
      expect(readBackoffStreak(filePath)).toBe(0);
    });
  });

  test("floating-point content reads as 0 (not truncated to an integer)", async () => {
    const { readBackoffStreak } = await import("../src/daemon/acquire");
    withPlantedFile("5.1", (filePath) => {
      expect(readBackoffStreak(filePath)).toBe(0);
    });
  });

  test("oversize content clamps to SPAWN_BACKOFF_MAX_STREAK", async () => {
    const { readBackoffStreak, SPAWN_BACKOFF_MAX_STREAK } =
      await import("../src/daemon/acquire");
    withPlantedFile("999", (filePath) => {
      expect(readBackoffStreak(filePath)).toBe(SPAWN_BACKOFF_MAX_STREAK);
    });
  });

  test("a valid in-range value round-trips correctly", async () => {
    const { readBackoffStreak } = await import("../src/daemon/acquire");
    withPlantedFile("3", (filePath) => {
      expect(readBackoffStreak(filePath)).toBe(3);
    });
  });
});

describe("obtainDaemonKick starts the host only from the install's record", () => {
  test("spawns the recorded bundle", async () => {
    await withTempState(async ({ world, bundle }) => {
      jest.resetModules();
      const { obtainDaemonKick } = await import("../src/daemon/acquire");
      const spawned: string[] = [];
      const outcome = obtainDaemonKick(world, {
        spawn: (at) => {
          spawned.push(at);
          return true;
        },
      });
      expect(outcome).toEqual({ kind: "kicked" });
      expect(spawned).toEqual([bundle]);
    });
  });

  test.each([
    ["no record", (record: string) => fs.rmSync(record), "absent"],
    [
      "a record naming a bundle that is gone",
      (_record: string, bundle: string) => fs.rmSync(bundle),
      "failed",
    ],
    [
      "a record that is not an absolute path",
      (record: string) => fs.writeFileSync(record, "dist/index.mjs\n"),
      "failed",
    ],
  ])("%s is refused with nothing spawned", async (_name, break_, kind) => {
    await withTempState(async ({ host, world, bundle }) => {
      jest.resetModules();
      const { obtainDaemonKick } = await import("../src/daemon/acquire");
      const { hostBundlePath, spawnLockPath, spawnCooldownPath } =
        await import("../src/daemon/paths");
      break_(hostBundlePath(host), bundle);
      let spawned = 0;
      const outcome = obtainDaemonKick(world, {
        spawn: () => {
          spawned++;
          return true;
        },
      });
      expect(outcome.kind).toBe("refused");
      expect(outcome.kind === "refused" && outcome.record.kind).toBe(kind);
      expect(spawned).toBe(0);
      // Refused before the lock and the rate bound: a refusal forks nothing,
      // so it must not use up the window a real spawn needs, and the next
      // tick says the same thing again.
      expect(fs.existsSync(spawnLockPath(host))).toBe(false);
      expect(fs.existsSync(spawnCooldownPath(host))).toBe(false);
    });
  });
});

describe("obtainDaemonKick (synchronous fire-and-forget)", () => {
  test("reclaims a stale spawn.lock older than the staleness window", async () => {
    await withTempState(async ({ host, world }) => {
      jest.resetModules();
      const { obtainDaemonKick } = await import("../src/daemon/acquire");
      const { spawnLockPath } = await import("../src/daemon/paths");

      // A lock backdated past the staleness window is reclaimed, so the kick
      // holds the lock and spawns, rather than reading it as contended and
      // spawning unlocked once the crashed-holder override passes.
      fs.writeFileSync(
        spawnLockPath(host),
        JSON.stringify({ pid: 999999, ts: Date.now() - 30_000 }),
      );
      const oldTime = new Date(Date.now() - 30_000);
      fs.utimesSync(spawnLockPath(host), oldTime, oldTime);

      let spawned = 0;
      const stderr = jest.spyOn(process.stderr, "write").mockReturnValue(true);
      try {
        obtainDaemonKick(world, {
          spawn: () => {
            spawned++;
            return true;
          },
        });
        expect(spawned).toBe(1);
        expect(stderr.mock.calls.join("")).not.toMatch(/spawning unlocked/);
      } finally {
        stderr.mockRestore();
      }
      expect(fs.existsSync(spawnLockPath(host))).toBe(false);
    });
  });

  test("invokes spawn synchronously when lock is acquired", async () => {
    await withTempState(async ({ host, world }) => {
      jest.resetModules();
      const { obtainDaemonKick } = await import("../src/daemon/acquire");
      const { spawnLockPath } = await import("../src/daemon/paths");

      let spawned = 0;
      obtainDaemonKick(world, {
        spawn: () => {
          spawned++;
          return true;
        },
      });
      // Spawn ran in the same synchronous turn.
      expect(spawned).toBe(1);
      // Lock was released by the time kick returned.
      expect(fs.existsSync(spawnLockPath(host))).toBe(false);
    });
  });

  test("does not spawn when lock is already held by another process", async () => {
    await withTempState(async ({ host, world }) => {
      jest.resetModules();
      const { obtainDaemonKick } = await import("../src/daemon/acquire");
      const { spawnLockPath, daemonDir } = await import("../src/daemon/paths");

      fs.mkdirSync(daemonDir(host), { recursive: true });
      // Plant a fresh lock (not stale) to simulate another caller in the
      // spawn window.
      fs.writeFileSync(
        spawnLockPath(host),
        JSON.stringify({ pid: 999999, ts: Date.now() }),
      );

      let spawned = 0;
      obtainDaemonKick(world, {
        spawn: () => {
          spawned++;
          return true;
        },
      });
      expect(spawned).toBe(0);
    });
  });

  test("spawns unlocked when lock acquisition errors (availability)", async () => {
    await withTempState(async ({ host, world }) => {
      jest.resetModules();
      const { obtainDaemonKick } = await import("../src/daemon/acquire");
      const { daemonDir } = await import("../src/daemon/paths");

      // Make daemonDir(host) read-only so openSync("wx") on spawn.lock fails
      // with EACCES (not EEXIST). The kick must NOT treat this as a hard
      // stop — bind() arbitrates, so we spawn anyway.
      fs.mkdirSync(daemonDir(host), { recursive: true });
      // Mask off file-type bits; stat.mode includes them and chmodSync
      // accepts permission bits only on some platforms.
      const originalMode = fs.statSync(daemonDir(host)).mode & 0o7777;
      fs.chmodSync(daemonDir(host), 0o555);

      // Suppress the expected stderr "spawn-lock unavailable" warning
      // during this test to keep test output clean. mockRestore() (in
      // the finally) restores the original; no manual capture/reassignment
      // needed (and reassigning a bound copy would replace the restored
      // original with a wrapper, affecting later tests).
      const stderrSpy = jest
        .spyOn(process.stderr, "write")
        .mockImplementation((_b: unknown) => true);

      try {
        let spawned = 0;
        obtainDaemonKick(world, {
          spawn: () => {
            spawned++;
            return true;
          },
        });
        // Spawn fired despite lock-error — bind() will arbitrate.
        expect(spawned).toBe(1);
        // The stderr warning was emitted with the reason.
        expect(stderrSpy).toHaveBeenCalled();
        const warned = String(stderrSpy.mock.calls[0]?.[0]);
        expect(warned).toMatch(/spawn-lock unavailable/);
      } finally {
        stderrSpy.mockRestore();
        fs.chmodSync(daemonDir(host), originalMode);
      }
    });
  });

  test("overrides contended lock when older than KICK_CONTENDED_OVERRIDE_MS", async () => {
    await withTempState(async ({ host, world }) => {
      jest.resetModules();
      const { obtainDaemonKick } = await import("../src/daemon/acquire");
      const { spawnLockPath, daemonDir } = await import("../src/daemon/paths");

      fs.mkdirSync(daemonDir(host), { recursive: true });
      // Plant a lock file that looks like a crashed holder: file exists,
      // mtime backdated 3s (past the 2s override threshold).
      fs.writeFileSync(
        spawnLockPath(host),
        JSON.stringify({ pid: 999999, ts: Date.now() - 3000 }),
      );
      const oldTime = new Date(Date.now() - 3000);
      fs.utimesSync(spawnLockPath(host), oldTime, oldTime);

      const stderrSpy = jest
        .spyOn(process.stderr, "write")
        .mockImplementation(() => true);
      try {
        let spawned = 0;
        obtainDaemonKick(world, {
          spawn: () => {
            spawned++;
            return true;
          },
        });
        // The kick saw "contended" (file exists, mkdir-flag wx fails) but
        // the file's age exceeded the override threshold → spawn anyway.
        expect(spawned).toBe(1);
        const warned = String(stderrSpy.mock.calls[0]?.[0] ?? "");
        expect(warned).toMatch(/likely crashed holder/);
      } finally {
        stderrSpy.mockRestore();
      }
    });
  });

  test("respects contended lock when fresh (no override)", async () => {
    await withTempState(async ({ host, world }) => {
      jest.resetModules();
      const { obtainDaemonKick } = await import("../src/daemon/acquire");
      const { spawnLockPath, daemonDir } = await import("../src/daemon/paths");

      fs.mkdirSync(daemonDir(host), { recursive: true });
      // Fresh lock — current mtime.
      fs.writeFileSync(
        spawnLockPath(host),
        JSON.stringify({ pid: 999999, ts: Date.now() }),
      );

      let spawned = 0;
      obtainDaemonKick(world, {
        spawn: () => {
          spawned++;
          return true;
        },
      });
      // Fresh lock = legitimate contention with another caller. Do not spawn.
      expect(spawned).toBe(0);
    });
  });

  test("completes synchronously — no microtask suspension", async () => {
    await withTempState(async ({ host, world }) => {
      jest.resetModules();
      const { obtainDaemonKick } = await import("../src/daemon/acquire");

      let asyncRan = false;
      void Promise.resolve().then(() => {
        asyncRan = true;
      });
      // Kick must complete fully before any microtask gets a turn — this is
      // the load-bearing property: it's called immediately before
      // process.exit(0), so an async chain inside would never run.
      obtainDaemonKick(world, { spawn: () => true });
      expect(asyncRan).toBe(false);
    });
  });

  // ─── spawn cooldown (shared spawn-RATE bound, ticket 2b3.3) ────────────────

  test("second kick within the cooldown does not spawn again", async () => {
    await withTempState(async ({ host, world }) => {
      jest.resetModules();
      const { obtainDaemonKick } = await import("../src/daemon/acquire");

      let spawned = 0;
      const spawn = (): boolean => {
        spawned++;
        return true;
      };
      // First kick: no prior attempt → spawns and records the cooldown.
      obtainDaemonKick(world, { spawn });
      expect(spawned).toBe(1);
      // Second kick, immediately after: an attempt was recorded well within
      // SPAWN_COOLDOWN_MS → the herd is damped, no second spawn.
      obtainDaemonKick(world, { spawn });
      expect(spawned).toBe(1);
    });
  });

  test("kick spawns again once the cooldown has elapsed", async () => {
    await withTempState(async ({ host, world }) => {
      jest.resetModules();
      const { obtainDaemonKick } = await import("../src/daemon/acquire");
      const { spawnBackoffPath, spawnCooldownPath } =
        await import("../src/daemon/paths");

      let spawned = 0;
      const spawn = (): boolean => {
        spawned++;
        return true;
      };
      obtainDaemonKick(world, { spawn });
      expect(spawned).toBe(1);

      // Simulate the cooldown window elapsing by backdating the record's mtime.
      // The first granted spawn advanced the backoff streak to 1
      // (brandon-daemon-lifecycle-gad.3), so the REQUIRED window for the next
      // spawn is effectiveCooldownMs(1), not the base SPAWN_COOLDOWN_MS —
      // computed here (not hardcoded) so this test doesn't silently go stale
      // if the backoff multiplier or base rate ever changes. +1s of margin,
      // the same technique the stale-lock tests use.
      const { effectiveCooldownMs } = await import("../src/daemon/acquire");
      const old = new Date(Date.now() - effectiveCooldownMs(1) - 1_000);
      fs.utimesSync(spawnCooldownPath(host), old, old);

      obtainDaemonKick(world, { spawn });
      expect(spawned).toBe(2);
    });
  });

  test("cooldown is recorded even when the spawn throws (record-on-grant)", async () => {
    await withTempState(async ({ host, world }) => {
      jest.resetModules();
      const { obtainDaemonKick } = await import("../src/daemon/acquire");
      const { spawnBackoffPath, spawnCooldownPath } =
        await import("../src/daemon/paths");

      // Suppress the expected "daemon spawn failed" stderr from the throwing
      // spawn so the test output stays clean.
      const stderrSpy = jest
        .spyOn(process.stderr, "write")
        .mockImplementation(() => true);
      try {
        // A broken binary: the spawn throws every time. The cooldown must be
        // recorded BEFORE the spawn runs, so a broken binary is not retried in
        // a tight loop.
        obtainDaemonKick(world, {
          spawn: () => {
            throw new Error("simulated ENOENT for node binary");
          },
        });
        expect(fs.existsSync(spawnCooldownPath(host))).toBe(true);

        // A second kick with a would-succeed spawn is still rate-limited by the
        // record the throwing attempt left behind.
        let spawned = 0;
        obtainDaemonKick(world, {
          spawn: () => {
            spawned++;
            return true;
          },
        });
        expect(spawned).toBe(0);
      } finally {
        stderrSpy.mockRestore();
      }
    });
  });

  test("garbage cooldown file (future mtime) fails toward allowing a spawn, loudly", async () => {
    await withTempState(async ({ host, world }) => {
      jest.resetModules();
      const { obtainDaemonKick } = await import("../src/daemon/acquire");
      const { spawnCooldownPath, daemonDir } =
        await import("../src/daemon/paths");

      fs.mkdirSync(daemonDir(host), { recursive: true });
      // Plant a cooldown record with an mtime far in the future (clock skew or a
      // touched file). A naive `now - mtime < COOLDOWN` test would read this as
      // "cooldown active" forever and wedge the spawn path — availability lost.
      fs.writeFileSync(spawnCooldownPath(host), "garbage\n");
      const future = new Date(Date.now() + 3_600_000);
      fs.utimesSync(spawnCooldownPath(host), future, future);

      const stderrSpy = jest
        .spyOn(process.stderr, "write")
        .mockImplementation(() => true);
      try {
        let spawned = 0;
        obtainDaemonKick(world, {
          spawn: () => {
            spawned++;
            return true;
          },
        });
        // Availability over strictness: a garbage timestamp must not block.
        expect(spawned).toBe(1);
        // ...and it must be loud, not silent.
        const warned = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
        expect(warned).toMatch(/in the future/);
      } finally {
        stderrSpy.mockRestore();
      }
    });
  });
});

describe("daemon startup (bind-based singleton)", () => {
  // We don't boot the full daemon here (too much surface) — we verify the
  // load-bearing bind() invariant directly: a second listener on the same
  // socket path gets EADDRINUSE.

  test("second bind on the same socket path receives EADDRINUSE", async () => {
    await withTempState(async ({ host, world }) => {
      jest.resetModules();
      const { socketPath } = await import("../src/daemon/paths");
      fs.mkdirSync(path.dirname(socketPath(host)), { recursive: true });

      const first = await startFakeDaemon(socketPath(host));
      try {
        const err: NodeJS.ErrnoException = await new Promise((resolve) => {
          const second = net.createServer();
          second.once("error", (e) => resolve(e as NodeJS.ErrnoException));
          second.listen(socketPath(host));
        });
        expect(err.code).toBe("EADDRINUSE");
      } finally {
        await closeServer(first);
      }
    });
  });

  test("stale socket file: connect surfaces ENOTSOCK/ECONNREFUSED, unlink+rebind succeeds", async () => {
    await withTempState(async ({ host, world }) => {
      jest.resetModules();
      const { socketPath } = await import("../src/daemon/paths");
      fs.mkdirSync(path.dirname(socketPath(host)), { recursive: true });

      // Plant a stale socket file (just a plain file, no listener). This test
      // pins the kernel MECHANICS the daemon's recovery relies on: a plain file
      // at the socket path makes bind() fail EADDRINUSE and connect() fail
      // ENOTSOCK/ECONNREFUSED. The daemon's actual arbitration no longer
      // consults connect() at all (it reads the socket-derived pid lease — see
      // daemon-socket-lease.test.ts); this only verifies the unlink+rebind
      // recovery still binds a working socket.
      fs.writeFileSync(socketPath(host), "");

      const connectErr: NodeJS.ErrnoException = await new Promise((resolve) => {
        const sock = net.connect(socketPath(host));
        sock.once("connect", () => {
          sock.destroy();
          resolve(
            new Error("unexpected connect success") as NodeJS.ErrnoException,
          );
        });
        sock.once("error", (e) => resolve(e as NodeJS.ErrnoException));
      });
      expect(["ENOTSOCK", "ECONNREFUSED", "ENOENT"]).toContain(connectErr.code);

      // First bind attempt fails (EADDRINUSE).
      await expect(
        new Promise((_, reject) => {
          const s = net.createServer();
          s.once("error", reject);
          s.listen(socketPath(host));
        }),
      ).rejects.toMatchObject({ code: "EADDRINUSE" });

      // Unlink and rebind — this is what handleAddressInUse does.
      fs.unlinkSync(socketPath(host));
      const server = await startFakeDaemon(socketPath(host));
      try {
        expect(fs.existsSync(socketPath(host))).toBe(true);
      } finally {
        await closeServer(server);
      }
    });
  });
});

// [LAW:verifiable-goals] Acceptance criterion for brandon-daemon-lifecycle-gad.3:
// "A multi-window production-daemon outage under rapid statusline invocation
// stays under the documented global spawn-rate bound (no fork drip beyond
// ~20/min), ideally with backoff." The fixed-rate cooldown alone already
// bounds the rate at ~20/min forever; these tests demonstrate the backoff
// makes a SUSTAINED outage strictly better than that floor — the rate decays
// toward ~1/min — and that a single successful bind (resetSpawnBackoff, wired
// into server.ts onListening) restores the base rate immediately.
//
// The sibling acceptance criterion ("A demonstrated stale-bin / version-skew
// scenario does not produce repeated daemon spawns") is already covered by
// the kz8.5 work this ticket builds on: `test/daemon-version-mismatch.test.ts`
// pins that every Permanent outcome — including version_mismatch — never
// calls kick, at both the pure-decision level (planOutcome) and the live-daemon
// level (shutdownObserved). No new production code was needed for that half;
// this file adds nothing that duplicates it.
describe("spawn backoff under sustained non-convergence (brandon-daemon-lifecycle-gad.3)", () => {
  // [LAW:one-source-of-truth] The cooldown's age is Date.now() minus the
  // record's mtime. Under jest's fake timers Date.now() is the test's clock,
  // but the filesystem stamps a freshly written record with the real clock,
  // so every granted record is pinned to the fake clock and the age is
  // exactly the simulated elapsed time. Backdating the mtime against real
  // time instead leaves wall-clock as a second clock, and on a loaded
  // machine it pushes the age across a window boundary a tick early.
  const pinCooldownRecordToNow = (recordPath: string): void => {
    const now = new Date();
    fs.utimesSync(recordPath, now, now);
  };

  test("consecutive kicks that never converge widen the cooldown and cap it — never worse than the fixed 3s floor, decaying toward 1/min", async () => {
    await withTempState(async ({ host, world }) => {
      jest.resetModules();
      const { obtainDaemonKick } = await import("../src/daemon/acquire");
      const { spawnBackoffPath, spawnCooldownPath } =
        await import("../src/daemon/paths");

      // A spawn that "succeeds" (a process forked) but the daemon never binds
      // — the fork-exhaustion scenario from the epic's incident report, where
      // recovery itself is expensive and nothing ever converges.
      let spawned = 0;
      const spawn = (): boolean => {
        spawned++;
        return true;
      };

      const grantedAtSimulatedMs: number[] = [];
      jest.useFakeTimers();
      try {
        const t0 = Date.now();
        // Simulate 10 minutes of continuous statusline-tick pressure, probing
        // once per simulated second (the natural render cadence).
        for (let tick = 0; tick < 600; tick++) {
          obtainDaemonKick(world, { spawn });
          if (spawned > grantedAtSimulatedMs.length) {
            grantedAtSimulatedMs.push(Date.now() - t0);
            pinCooldownRecordToNow(spawnCooldownPath(host));
          }
          jest.advanceTimersByTime(1_000);
        }
      } finally {
        jest.useRealTimers();
      }

      // Fixed-rate floor: one spawn every 3s for 600s ≈ 200 spawns. The
      // backoff must never exceed that — it can only make a sustained,
      // non-converging outage LESS aggressive, never more.
      const FIXED_RATE_SPAWNS_OVER_10_MIN = 600_000 / 3_000;
      expect(spawned).toBeLessThan(FIXED_RATE_SPAWNS_OVER_10_MIN);

      // The gaps between grants must grow monotonically until they saturate
      // at the 60s cap (SPAWN_BACKOFF_CAP_MS) — this is the actual backoff
      // behavior, not just "fewer spawns" by coincidence.
      const gaps: number[] = [];
      for (let i = 1; i < grantedAtSimulatedMs.length; i++) {
        gaps.push(grantedAtSimulatedMs[i]! - grantedAtSimulatedMs[i - 1]!);
      }
      for (let i = 1; i < gaps.length; i++) {
        expect(gaps[i]!).toBeGreaterThanOrEqual(gaps[i - 1]!);
      }
      const { SPAWN_BACKOFF_CAP_MS } = await import("../src/daemon/acquire");
      const lastGap = gaps[gaps.length - 1]!;
      expect(lastGap).toBeLessThanOrEqual(SPAWN_BACKOFF_CAP_MS);
      expect(lastGap).toBeGreaterThanOrEqual(SPAWN_BACKOFF_CAP_MS * 0.9);
    });
  });

  test("a successful bind (resetSpawnBackoff) restores the base rate immediately", async () => {
    await withTempState(async ({ host, world }) => {
      jest.resetModules();
      const { obtainDaemonKick, resetSpawnBackoff, SPAWN_COOLDOWN_MS } =
        await import("../src/daemon/acquire");
      const { spawnBackoffPath, spawnCooldownPath } =
        await import("../src/daemon/paths");

      let spawned = 0;
      const spawn = (): boolean => {
        spawned++;
        return true;
      };

      jest.useFakeTimers();
      try {
        // Three consecutive non-converging spawns — streak climbs to 3, so the
        // required window is SPAWN_COOLDOWN_MS * 8. Each wait between kicks
        // is longer than any window the loop reaches (streak ≤ 2, so at most
        // SPAWN_COOLDOWN_MS * 4), so every kick lands.
        for (let i = 0; i < 3; i++) {
          if (i > 0) jest.advanceTimersByTime(SPAWN_COOLDOWN_MS * 8 + 1_000);
          obtainDaemonKick(world, { spawn });
          pinCooldownRecordToNow(spawnCooldownPath(host));
        }
        expect(spawned).toBe(3);

        // Just past the BASE window and well inside the backed-off one: the
        // kick is refused, which is what makes the grant after the reset
        // evidence of the reset rather than of the clock.
        jest.advanceTimersByTime(SPAWN_COOLDOWN_MS + 500);
        obtainDaemonKick(world, { spawn });
        expect(spawned).toBe(3);

        // The daemon FINALLY binds — server.ts's onListening calls this.
        resetSpawnBackoff(spawnBackoffPath(host));

        obtainDaemonKick(world, { spawn });
        expect(spawned).toBe(4);
      } finally {
        jest.useRealTimers();
      }
    });
  });
});

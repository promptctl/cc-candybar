import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { spawnTestDaemon } from "./helpers/spawn-test-daemon";

// CC_CANDYBAR_SOCKET isolates the socket and XDG_STATE_HOME isolates spawn.lock.
// Both are needed: socketPath() ignores XDG_STATE_HOME.

async function withTempState<T>(
  fn: (stateDir: string) => Promise<T> | T,
): Promise<T> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-candybar-acquire-"));
  const sockPath = path.join(root, "cc-candybar", "socket");
  const prevXdg = process.env.XDG_STATE_HOME;
  const prevSock = process.env.CC_CANDYBAR_SOCKET;
  process.env.XDG_STATE_HOME = root;
  process.env.CC_CANDYBAR_SOCKET = sockPath;
  // async/try-finally, not Promise.resolve(fn()).finally: a synchronous throw from fn would bypass the finally and leak temp dirs + env.
  try {
    return await fn(path.join(root, "cc-candybar"));
  } finally {
    if (prevXdg === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = prevXdg;
    if (prevSock === undefined) delete process.env.CC_CANDYBAR_SOCKET;
    else process.env.CC_CANDYBAR_SOCKET = prevSock;
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

// [LAW:behavior-not-structure] Pin the cooldown arithmetic at its exact boundaries — check-protocol diffs constant values, not decisions.
describe("cooldownDecision (pure window arithmetic)", () => {
  test("absent record allows (first spawn)", async () => {
    const { cooldownDecision, SPAWN_COOLDOWN_MS } = await import(
      "../src/daemon/acquire"
    );
    expect(cooldownDecision(null, SPAWN_COOLDOWN_MS)).toEqual({
      kind: "allow",
    });
  });

  test("within [0, cooldownMs) denies", async () => {
    const { cooldownDecision, SPAWN_COOLDOWN_MS } = await import(
      "../src/daemon/acquire"
    );
    expect(cooldownDecision(0, SPAWN_COOLDOWN_MS)).toEqual({ kind: "deny" });
    expect(cooldownDecision(SPAWN_COOLDOWN_MS - 1, SPAWN_COOLDOWN_MS)).toEqual(
      { kind: "deny" },
    );
  });

  test("at and past cooldownMs allows (half-open window)", async () => {
    const { cooldownDecision, SPAWN_COOLDOWN_MS } = await import(
      "../src/daemon/acquire"
    );
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

  // The future-garbage boundary is anchored to STALE_LOCK_MS, not the cooldown window, so a wide backed-off window never hides a skewed mtime.
  test("future-garbage boundary is independent of the cooldown window", async () => {
    const { cooldownDecision, STALE_LOCK_MS, SPAWN_BACKOFF_CAP_MS } =
      await import("../src/daemon/acquire");
    expect(
      cooldownDecision(-STALE_LOCK_MS - 1, SPAWN_BACKOFF_CAP_MS),
    ).toEqual({
      kind: "allow-future-garbage",
      futureMs: STALE_LOCK_MS + 1,
    });
  });
});

// [LAW:behavior-not-structure] Pin the streak-to-window mapping and its cap; pure over the streak.
describe("effectiveCooldownMs (pure backoff arithmetic)", () => {
  test("streak zero is the base rate", async () => {
    const { effectiveCooldownMs, SPAWN_COOLDOWN_MS } = await import(
      "../src/daemon/acquire"
    );
    expect(effectiveCooldownMs(0)).toBe(SPAWN_COOLDOWN_MS);
  });

  test("doubles per streak", async () => {
    const { effectiveCooldownMs, SPAWN_COOLDOWN_MS } = await import(
      "../src/daemon/acquire"
    );
    expect(effectiveCooldownMs(1)).toBe(SPAWN_COOLDOWN_MS * 2);
    expect(effectiveCooldownMs(2)).toBe(SPAWN_COOLDOWN_MS * 4);
    expect(effectiveCooldownMs(3)).toBe(SPAWN_COOLDOWN_MS * 8);
  });

  test("caps at SPAWN_BACKOFF_CAP_MS and never exceeds it past the max streak", async () => {
    const { effectiveCooldownMs, SPAWN_BACKOFF_CAP_MS, SPAWN_BACKOFF_MAX_STREAK } =
      await import("../src/daemon/acquire");
    expect(effectiveCooldownMs(SPAWN_BACKOFF_MAX_STREAK)).toBe(
      SPAWN_BACKOFF_CAP_MS,
    );
    expect(effectiveCooldownMs(SPAWN_BACKOFF_MAX_STREAK + 1)).toBe(
      SPAWN_BACKOFF_CAP_MS,
    );
    expect(effectiveCooldownMs(1_000_000)).toBe(SPAWN_BACKOFF_CAP_MS);
  });

  test("negative streak is treated as zero", async () => {
    const { effectiveCooldownMs, SPAWN_COOLDOWN_MS } = await import(
      "../src/daemon/acquire"
    );
    expect(effectiveCooldownMs(-5)).toBe(SPAWN_COOLDOWN_MS);
  });
});

// [LAW:behavior-not-structure] Pinned against planted content: a regression back to parseInt (which truncates "5abc" to 5) would not fail the acceptance test.
describe("readBackoffStreak (parsing-strictness contract)", () => {
  function withPlantedFile<T>(content: string | null, fn: (path: string) => T): T {
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
    // parseInt("5abc", 10) === 5 — the silent truncation Number(raw) avoids.
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
    const { readBackoffStreak, SPAWN_BACKOFF_MAX_STREAK } = await import(
      "../src/daemon/acquire"
    );
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

describe("obtainDaemon (bind-based singleton)", () => {
  test("attaches when a daemon is already listening — no spawn", async () => {
    await withTempState(async (stateDir) => {
      jest.resetModules();
      const { obtainDaemon } = await import("../src/daemon/acquire");
      const { socketPath } = await import("../src/daemon/paths");

      const server = await startFakeDaemon(socketPath());
      try {
        let spawned = 0;
        const result = await obtainDaemon({
          spawn: () => {
            spawned++;
            return true;
          },
        });
        expect(result).toEqual({ kind: "attached" });
        expect(spawned).toBe(0);
        expect(stateDir).toContain("cc-candybar");
      } finally {
        await closeServer(server);
      }
    });
  });

  test("spawns exactly once across N concurrent callers", async () => {
    await withTempState(async () => {
      jest.resetModules();
      const { obtainDaemon } = await import("../src/daemon/acquire");
      const { socketPath } = await import("../src/daemon/paths");

      let spawnCount = 0;
      let fakeServer: net.Server | null = null;

      const fakeSpawn = (): boolean => {
        spawnCount++;
        setTimeout(() => {
          if (fakeServer) return;
          startFakeDaemon(socketPath())
            .then((s) => {
              fakeServer = s;
            })
            .catch(() => {});
        }, 30);
        return true;
      };

      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          obtainDaemon({
            spawn: fakeSpawn,
            spawnReadyTimeoutMs: 500,
            totalTimeoutMs: 1000,
          }),
        ),
      );

      try {
        expect(spawnCount).toBe(1);
        const kinds = results.map((r) => r.kind).sort();
        expect(kinds.filter((k) => k === "started").length).toBe(1);
        expect(kinds.filter((k) => k === "attached").length).toBe(4);
        expect(kinds.filter((k) => k === "failed").length).toBe(0);
      } finally {
        if (fakeServer) await closeServer(fakeServer);
      }
    });
  });

  test("reclaims a stale spawn.lock older than the staleness window", async () => {
    await withTempState(async () => {
      jest.resetModules();
      const { obtainDaemon } = await import("../src/daemon/acquire");
      const { spawnLockPath, daemonDir } = await import("../src/daemon/paths");

      fs.mkdirSync(daemonDir(), { recursive: true });

      fs.writeFileSync(
        spawnLockPath(),
        JSON.stringify({ pid: 999999, ts: Date.now() - 30_000 }),
      );
      const oldTime = new Date(Date.now() - 30_000);
      fs.utimesSync(spawnLockPath(), oldTime, oldTime);

      let spawned = 0;
      let server: net.Server | null = null;
      const { socketPath } = await import("../src/daemon/paths");
      const fakeSpawn = (): boolean => {
        spawned++;
        startFakeDaemon(socketPath()).then((s) => {
          server = s;
        });
        return true;
      };

      const result = await obtainDaemon({
        spawn: fakeSpawn,
        spawnReadyTimeoutMs: 500,
        totalTimeoutMs: 1500,
      });
      try {
        expect(spawned).toBe(1);
        expect(result.kind).toBe("started");
      } finally {
        if (server) await closeServer(server);
      }
    });
  });

  test("falls back to spawning past lockFallbackMs when lock is stuck (availability)", async () => {
    await withTempState(async () => {
      jest.resetModules();
      const { obtainDaemon } = await import("../src/daemon/acquire");
      const { spawnLockPath, socketPath, daemonDir } = await import(
        "../src/daemon/paths"
      );

      // A fresh lock simulates a stuck holder: staleness reclaim never fires, so without the fallback path obtainDaemon spins to the deadline.
      fs.mkdirSync(daemonDir(), { recursive: true });
      fs.writeFileSync(
        spawnLockPath(),
        JSON.stringify({ pid: 999999, ts: Date.now() }),
      );

      let spawned = 0;
      let server: net.Server | null = null;
      const result = await obtainDaemon({
        spawn: () => {
          spawned++;
          startFakeDaemon(socketPath())
            .then((s) => {
              server = s;
            })
            .catch(() => {});
          return true;
        },
        totalTimeoutMs: 1500,
        lockFallbackMs: 200,
        spawnReadyTimeoutMs: 1000,
      });

      try {
        expect(spawned).toBe(1);
        expect(result.kind).toBe("started");
      } finally {
        if (server) await closeServer(server);
      }
    });
  });

  test("returns failed (not throws) when spawn fn throws synchronously", async () => {
    await withTempState(async () => {
      jest.resetModules();
      const { obtainDaemon } = await import("../src/daemon/acquire");

      const result = await obtainDaemon({
        spawn: () => {
          throw new Error("simulated ENOENT for node binary");
        },
        totalTimeoutMs: 500,
        spawnReadyTimeoutMs: 100,
      });
      expect(result.kind).toBe("failed");
      if (result.kind === "failed") {
        expect(result.reason).toMatch(/spawn threw/);
        expect(result.reason).toMatch(/ENOENT/);
      }
    });
  });

  test("returns failed when spawn fn returns false", async () => {
    await withTempState(async () => {
      jest.resetModules();
      const { obtainDaemon } = await import("../src/daemon/acquire");

      const result = await obtainDaemon({
        spawn: () => false,
        totalTimeoutMs: 500,
        spawnReadyTimeoutMs: 100,
      });
      expect(result.kind).toBe("failed");
    });
  });

  test("does not throw when state-dir setup fails — returns failed result", async () => {
    await withTempState(async (stateDir) => {
      jest.resetModules();
      const { obtainDaemon } = await import("../src/daemon/acquire");

      // A *file* at the state-dir path forces the typed-failure path instead of a throw.
      const parent = path.dirname(stateDir);
      fs.mkdirSync(parent, { recursive: true });
      fs.writeFileSync(stateDir, "");

      const result = await obtainDaemon({
        spawn: () => true,
        totalTimeoutMs: 200,
      });
      expect(result.kind).toBe("failed");
      if (result.kind === "failed") {
        expect(result.reason).toMatch(/mkdir/);
      }
    });
  });


  test("surfaces unrecoverable spawn-lock errors as failed (not spinning timeout)", async () => {
    await withTempState(async () => {
      jest.resetModules();
      const { obtainDaemon } = await import("../src/daemon/acquire");
      const { daemonDir } = await import("../src/daemon/paths");

      // A read-only dir makes openSync("wx") return EACCES: the unrecoverable path, which must NOT spin until the deadline.
      fs.mkdirSync(daemonDir(), { recursive: true });
      // Mask off file-type bits; chmodSync takes permission bits only on some platforms.
      const originalMode = fs.statSync(daemonDir()).mode & 0o7777;
      fs.chmodSync(daemonDir(), 0o555);
      try {
        const start = Date.now();
        const result = await obtainDaemon({
          spawn: () => true,
          totalTimeoutMs: 2000,
        });
        const elapsed = Date.now() - start;

        expect(result.kind).toBe("failed");
        if (result.kind === "failed") {
          expect(result.reason).toMatch(/spawn-lock/);
        }
        expect(elapsed).toBeLessThan(500);
      } finally {
        fs.chmodSync(daemonDir(), originalMode);
      }
    });
  });

  // obtainDaemon respects the same rate bound as the kick: a recent spawn record means wait for the in-flight boot, never add a process.

  test("on cooldown, does not spawn — fails when no daemon binds in the window", async () => {
    await withTempState(async () => {
      jest.resetModules();
      const { obtainDaemon } = await import("../src/daemon/acquire");
      const { spawnCooldownPath, daemonDir } = await import(
        "../src/daemon/paths"
      );

      fs.mkdirSync(daemonDir(), { recursive: true });
      fs.writeFileSync(spawnCooldownPath(), `${process.pid} ${Date.now()}\n`);

      let spawned = 0;
      const result = await obtainDaemon({
        spawn: () => {
          spawned++;
          return true;
        },
        spawnReadyTimeoutMs: 200,
        totalTimeoutMs: 400,
      });
      expect(spawned).toBe(0);
      expect(result.kind).toBe("failed");
      if (result.kind === "failed") {
        expect(result.reason).toMatch(/cooldown/);
      }
    });
  });

  test("on cooldown, attaches to the in-flight daemon without spawning", async () => {
    await withTempState(async () => {
      jest.resetModules();
      const { obtainDaemon } = await import("../src/daemon/acquire");
      const { spawnCooldownPath, socketPath, daemonDir } = await import(
        "../src/daemon/paths"
      );

      fs.mkdirSync(daemonDir(), { recursive: true });
      fs.writeFileSync(spawnCooldownPath(), `${process.pid} ${Date.now()}\n`);

      // The daemon must appear AFTER obtainDaemon's fast-path probe and its post-lock
      // re-check — ~2 microtask ticks apart — so 150ms lands in the cooldown-poll phase.
      let server: net.Server | null = null;
      setTimeout(() => {
        startFakeDaemon(socketPath())
          .then((s) => {
            server = s;
          })
          .catch(() => {});
      }, 150);

      let spawned = 0;
      const result = await obtainDaemon({
        spawn: () => {
          spawned++;
          return true;
        },
        spawnReadyTimeoutMs: 500,
        totalTimeoutMs: 800,
      });
      try {
        expect(spawned).toBe(0);
        expect(result.kind).toBe("attached");
      } finally {
        if (server) await closeServer(server);
      }
    });
  });

  test("on cooldown via the lock-fallback path: no spawn, cooldown cause with no lock suffix", async () => {
    await withTempState(async () => {
      jest.resetModules();
      const { obtainDaemon } = await import("../src/daemon/acquire");
      const { spawnCooldownPath, spawnLockPath, daemonDir } = await import(
        "../src/daemon/paths"
      );

      fs.mkdirSync(daemonDir(), { recursive: true });
      fs.writeFileSync(
        spawnLockPath(),
        JSON.stringify({ pid: 999999, ts: Date.now() }),
      );
      fs.writeFileSync(spawnCooldownPath(), `${process.pid} ${Date.now()}\n`);

      let spawned = 0;
      const result = await obtainDaemon({
        spawn: () => {
          spawned++;
          return true;
        },
        lockFallbackMs: 50,
        spawnReadyTimeoutMs: 150,
        totalTimeoutMs: 600,
      });
      expect(spawned).toBe(0);
      expect(result.kind).toBe("failed");
      if (result.kind === "failed") {
        expect(result.reason).toMatch(/cooldown/);
        expect(result.reason).not.toMatch(/lock-fallback/);
      }
    });
  });

  test("future-mtime cooldown file on the async path allows the spawn (started)", async () => {
    await withTempState(async () => {
      jest.resetModules();
      const { obtainDaemon } = await import("../src/daemon/acquire");
      const { spawnCooldownPath, socketPath, daemonDir } = await import(
        "../src/daemon/paths"
      );

      fs.mkdirSync(daemonDir(), { recursive: true });
      fs.writeFileSync(spawnCooldownPath(), "garbage\n");
      const future = new Date(Date.now() + 3_600_000);
      fs.utimesSync(spawnCooldownPath(), future, future);

      const stderrSpy = jest
        .spyOn(process.stderr, "write")
        .mockImplementation(() => true);
      try {
        let spawned = 0;
        let server: net.Server | null = null;
        const result = await obtainDaemon({
          spawn: () => {
            spawned++;
            startFakeDaemon(socketPath())
              .then((s) => {
                server = s;
              })
              .catch(() => {});
            return true;
          },
          spawnReadyTimeoutMs: 500,
          totalTimeoutMs: 800,
        });
        try {
          expect(spawned).toBe(1);
          expect(result.kind).toBe("started");
          const warned = stderrSpy.mock.calls
            .map((c) => String(c[0]))
            .join("");
          expect(warned).toMatch(/in the future/);
        } finally {
          if (server) await closeServer(server);
        }
      } finally {
        stderrSpy.mockRestore();
      }
    });
  });
});

describe("obtainDaemonKick (synchronous fire-and-forget)", () => {
  test("invokes spawn synchronously when lock is acquired", async () => {
    await withTempState(async () => {
      jest.resetModules();
      const { obtainDaemonKick } = await import("../src/daemon/acquire");
      const { spawnLockPath } = await import("../src/daemon/paths");

      let spawned = 0;
      obtainDaemonKick({
        spawn: () => {
          spawned++;
          return true;
        },
      });
      expect(spawned).toBe(1);
      expect(fs.existsSync(spawnLockPath())).toBe(false);
    });
  });

  test("does not spawn when lock is already held by another process", async () => {
    await withTempState(async () => {
      jest.resetModules();
      const { obtainDaemonKick } = await import("../src/daemon/acquire");
      const { spawnLockPath, daemonDir } = await import("../src/daemon/paths");

      fs.mkdirSync(daemonDir(), { recursive: true });
      fs.writeFileSync(
        spawnLockPath(),
        JSON.stringify({ pid: 999999, ts: Date.now() }),
      );

      let spawned = 0;
      obtainDaemonKick({
        spawn: () => {
          spawned++;
          return true;
        },
      });
      expect(spawned).toBe(0);
    });
  });

  test("spawns unlocked when lock acquisition errors (availability)", async () => {
    await withTempState(async () => {
      jest.resetModules();
      const { obtainDaemonKick } = await import("../src/daemon/acquire");
      const { daemonDir } = await import("../src/daemon/paths");

      // EACCES (not EEXIST) on spawn.lock must not be a hard stop — bind() arbitrates, so spawn anyway.
      fs.mkdirSync(daemonDir(), { recursive: true });
      const originalMode = fs.statSync(daemonDir()).mode & 0o7777;
      fs.chmodSync(daemonDir(), 0o555);

      const stderrSpy = jest
        .spyOn(process.stderr, "write")
        .mockImplementation((_b: unknown) => true);

      try {
        let spawned = 0;
        obtainDaemonKick({
          spawn: () => {
            spawned++;
            return true;
          },
        });
        expect(spawned).toBe(1);
        expect(stderrSpy).toHaveBeenCalled();
        const warned = String(stderrSpy.mock.calls[0]?.[0]);
        expect(warned).toMatch(/spawn-lock unavailable/);
      } finally {
        stderrSpy.mockRestore();
        fs.chmodSync(daemonDir(), originalMode);
      }
    });
  });

  test("overrides contended lock when older than KICK_CONTENDED_OVERRIDE_MS", async () => {
    await withTempState(async () => {
      jest.resetModules();
      const { obtainDaemonKick } = await import("../src/daemon/acquire");
      const { spawnLockPath, daemonDir } = await import("../src/daemon/paths");

      fs.mkdirSync(daemonDir(), { recursive: true });
      // A crashed holder: the file exists, with its mtime backdated 3s past the override threshold.
      fs.writeFileSync(
        spawnLockPath(),
        JSON.stringify({ pid: 999999, ts: Date.now() - 3000 }),
      );
      const oldTime = new Date(Date.now() - 3000);
      fs.utimesSync(spawnLockPath(), oldTime, oldTime);

      const stderrSpy = jest
        .spyOn(process.stderr, "write")
        .mockImplementation(() => true);
      try {
        let spawned = 0;
        obtainDaemonKick({
          spawn: () => {
            spawned++;
            return true;
          },
        });
        expect(spawned).toBe(1);
        const warned = String(stderrSpy.mock.calls[0]?.[0] ?? "");
        expect(warned).toMatch(/likely crashed holder/);
      } finally {
        stderrSpy.mockRestore();
      }
    });
  });

  test("respects contended lock when fresh (no override)", async () => {
    await withTempState(async () => {
      jest.resetModules();
      const { obtainDaemonKick } = await import("../src/daemon/acquire");
      const { spawnLockPath, daemonDir } = await import("../src/daemon/paths");

      fs.mkdirSync(daemonDir(), { recursive: true });
      fs.writeFileSync(
        spawnLockPath(),
        JSON.stringify({ pid: 999999, ts: Date.now() }),
      );

      let spawned = 0;
      obtainDaemonKick({
        spawn: () => {
          spawned++;
          return true;
        },
      });
      expect(spawned).toBe(0);
    });
  });

  test("completes synchronously — no microtask suspension", async () => {
    await withTempState(async () => {
      jest.resetModules();
      const { obtainDaemonKick } = await import("../src/daemon/acquire");

      let asyncRan = false;
      void Promise.resolve().then(() => {
        asyncRan = true;
      });
      // Kick must complete before any microtask runs: it is called immediately before process.exit(0).
      obtainDaemonKick({ spawn: () => true });
      expect(asyncRan).toBe(false);
    });
  });


  test("second kick within the cooldown does not spawn again", async () => {
    await withTempState(async () => {
      jest.resetModules();
      const { obtainDaemonKick } = await import("../src/daemon/acquire");

      let spawned = 0;
      const spawn = (): boolean => {
        spawned++;
        return true;
      };
      obtainDaemonKick({ spawn });
      expect(spawned).toBe(1);
      obtainDaemonKick({ spawn });
      expect(spawned).toBe(1);
    });
  });

  test("kick spawns again once the cooldown has elapsed", async () => {
    await withTempState(async () => {
      jest.resetModules();
      const { obtainDaemonKick } = await import("../src/daemon/acquire");
      const { spawnCooldownPath } = await import("../src/daemon/paths");

      let spawned = 0;
      const spawn = (): boolean => {
        spawned++;
        return true;
      };
      obtainDaemonKick({ spawn });
      expect(spawned).toBe(1);

      // The first granted spawn advanced the streak to 1, so the required window is
      // effectiveCooldownMs(1) — computed, not hardcoded, so this test cannot go stale.
      const { effectiveCooldownMs } = await import("../src/daemon/acquire");
      const old = new Date(Date.now() - effectiveCooldownMs(1) - 1_000);
      fs.utimesSync(spawnCooldownPath(), old, old);

      obtainDaemonKick({ spawn });
      expect(spawned).toBe(2);
    });
  });

  test("cooldown is recorded even when the spawn throws (record-on-grant)", async () => {
    await withTempState(async () => {
      jest.resetModules();
      const { obtainDaemonKick } = await import("../src/daemon/acquire");
      const { spawnCooldownPath } = await import("../src/daemon/paths");

      const stderrSpy = jest
        .spyOn(process.stderr, "write")
        .mockImplementation(() => true);
      try {
        // The cooldown must be recorded BEFORE the spawn runs, so a broken binary is not retried in a tight loop.
        obtainDaemonKick({
          spawn: () => {
            throw new Error("simulated ENOENT for node binary");
          },
        });
        expect(fs.existsSync(spawnCooldownPath())).toBe(true);

        let spawned = 0;
        obtainDaemonKick({
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
    await withTempState(async () => {
      jest.resetModules();
      const { obtainDaemonKick } = await import("../src/daemon/acquire");
      const { spawnCooldownPath, daemonDir } = await import(
        "../src/daemon/paths"
      );

      fs.mkdirSync(daemonDir(), { recursive: true });
      // A naive `now - mtime < COOLDOWN` test would read a future-dated record as "cooldown active" forever and wedge the spawn path.
      fs.writeFileSync(spawnCooldownPath(), "garbage\n");
      const future = new Date(Date.now() + 3_600_000);
      fs.utimesSync(spawnCooldownPath(), future, future);

      const stderrSpy = jest
        .spyOn(process.stderr, "write")
        .mockImplementation(() => true);
      try {
        let spawned = 0;
        obtainDaemonKick({
          spawn: () => {
            spawned++;
            return true;
          },
        });
        expect(spawned).toBe(1);
        const warned = stderrSpy.mock.calls
          .map((c) => String(c[0]))
          .join("");
        expect(warned).toMatch(/in the future/);
      } finally {
        stderrSpy.mockRestore();
      }
    });
  });
});

describe("daemon startup (bind-based singleton)", () => {

  test("second bind on the same socket path receives EADDRINUSE", async () => {
    await withTempState(async () => {
      jest.resetModules();
      const { socketPath } = await import("../src/daemon/paths");
      fs.mkdirSync(path.dirname(socketPath()), { recursive: true });

      const first = await startFakeDaemon(socketPath());
      try {
        const err: NodeJS.ErrnoException = await new Promise((resolve) => {
          const second = net.createServer();
          second.once("error", (e) => resolve(e as NodeJS.ErrnoException));
          second.listen(socketPath());
        });
        expect(err.code).toBe("EADDRINUSE");
      } finally {
        await closeServer(first);
      }
    });
  });

  test("stale socket file: connect surfaces ENOTSOCK/ECONNREFUSED, unlink+rebind succeeds", async () => {
    await withTempState(async () => {
      jest.resetModules();
      const { socketPath } = await import("../src/daemon/paths");
      fs.mkdirSync(path.dirname(socketPath()), { recursive: true });

      // A plain file at the socket path makes bind() fail EADDRINUSE and connect() fail
      // ENOTSOCK/ECONNREFUSED; this pins that the unlink+rebind recovery still binds.
      fs.writeFileSync(socketPath(), "");

      const connectErr: NodeJS.ErrnoException = await new Promise(
        (resolve) => {
          const sock = net.connect(socketPath());
          sock.once("connect", () => {
            sock.destroy();
            resolve(new Error("unexpected connect success") as NodeJS.ErrnoException);
          });
          sock.once("error", (e) => resolve(e as NodeJS.ErrnoException));
        },
      );
      expect(["ENOTSOCK", "ECONNREFUSED", "ENOENT"]).toContain(connectErr.code);

      await expect(
        new Promise((_, reject) => {
          const s = net.createServer();
          s.once("error", reject);
          s.listen(socketPath());
        }),
      ).rejects.toMatchObject({ code: "EADDRINUSE" });

      fs.unlinkSync(socketPath());
      const server = await startFakeDaemon(socketPath());
      try {
        expect(fs.existsSync(socketPath())).toBe(true);
      } finally {
        await closeServer(server);
      }
    });
  });
});

// [LAW:verifiable-goals] The fixed-rate cooldown alone bounds the spawn rate at ~20/min;
// these tests show backoff makes a SUSTAINED outage strictly better, and that one bind restores the base rate.
describe("spawn backoff under sustained non-convergence (brandon-daemon-lifecycle-gad.3)", () => {
  test("consecutive kicks that never converge widen the cooldown and cap it — never worse than the fixed 3s floor, decaying toward 1/min", async () => {
    await withTempState(async () => {
      jest.resetModules();
      const { obtainDaemonKick } = await import("../src/daemon/acquire");
      const { spawnCooldownPath } = await import("../src/daemon/paths");

      // A spawn that forks but never binds — the fork-exhaustion scenario.
      let spawned = 0;
      const spawn = (): boolean => {
        spawned++;
        return true;
      };

      const grantedAtSimulatedMs: number[] = [];
      let simulatedElapsedMs = 0;
      for (let tick = 0; tick < 600; tick++) {
        obtainDaemonKick({ spawn });
        if (spawned > grantedAtSimulatedMs.length) {
          grantedAtSimulatedMs.push(simulatedElapsedMs);
        }
        simulatedElapsedMs += 1_000;
        // The file's age is the only clock claimSpawnCooldown reads.
        try {
          const st = fs.statSync(spawnCooldownPath());
          const backdated = new Date(st.mtimeMs - 1_000);
          fs.utimesSync(spawnCooldownPath(), backdated, backdated);
        } catch {
        }
      }

      // Fixed-rate floor: one spawn per 3s over 600s ≈ 200. Backoff may only reduce it.
      const FIXED_RATE_SPAWNS_OVER_10_MIN = 600_000 / 3_000;
      expect(spawned).toBeLessThan(FIXED_RATE_SPAWNS_OVER_10_MIN);

      // Gaps must grow monotonically until they saturate at SPAWN_BACKOFF_CAP_MS.
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
    await withTempState(async () => {
      jest.resetModules();
      const { obtainDaemonKick, resetSpawnBackoff, SPAWN_COOLDOWN_MS } =
        await import("../src/daemon/acquire");
      const { spawnCooldownPath } = await import("../src/daemon/paths");

      let spawned = 0;
      const spawn = (): boolean => {
        spawned++;
        return true;
      };

      // Streak climbs to 3, so the required window is SPAWN_COOLDOWN_MS * 8.
      for (let i = 0; i < 3; i++) {
        obtainDaemonKick({ spawn });
        const st = fs.statSync(spawnCooldownPath());
        const backdated = new Date(st.mtimeMs - SPAWN_COOLDOWN_MS * 8 - 1_000);
        fs.utimesSync(spawnCooldownPath(), backdated, backdated);
      }
      expect(spawned).toBe(3);

      resetSpawnBackoff();

      // Backdate past the BASE window only — without the reset this kick would be denied.
      const st = fs.statSync(spawnCooldownPath());
      const backdated = new Date(st.mtimeMs - SPAWN_COOLDOWN_MS - 500);
      fs.utimesSync(spawnCooldownPath(), backdated, backdated);

      obtainDaemonKick({ spawn });
      expect(spawned).toBe(4);
    });
  });
});

// [LAW:behavior-not-structure] The tests above pin resetSpawnBackoff's arithmetic but not its WIRING; this drives a real daemon through an actual bind.
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
      const connectable = await waitForBackoffWireConnectable(sockPath, 8000);
      expect(connectable).toBe(true);
      // [LAW:no-ambient-temporal-coupling] Kernel connectability begins at listen(2), before
      // the 'listening' callback runs — so await the streak file's disappearance, not an instant check.
      const cleared = await waitForBackoffWireGone(backoffPath, 8000);
      expect(cleared).toBe(true);
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
        }
      }
    }
  });
});

async function waitForBackoffWireConnectable(
  sockPath: string,
  budgetMs: number,
): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>((resolve) => {
      const s = net.connect(sockPath);
      s.once("connect", () => {
        s.destroy();
        resolve(true);
      });
      s.once("error", () => resolve(false));
    });
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 25).unref());
  }
  return false;
}

async function waitForBackoffWireGone(
  filePath: string,
  budgetMs: number,
): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (!fs.existsSync(filePath)) return true;
    await new Promise((r) => setTimeout(r, 25).unref());
  }
  return false;
}

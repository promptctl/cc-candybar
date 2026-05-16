import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

// Each test creates its own XDG_STATE_HOME so concurrent test files cannot
// race on `<state>/socket` or `<state>/spawn.lock`. We set the env var
// *before* importing acquire/paths so the module reads the right dir.

function withTempState<T>(fn: (stateDir: string) => Promise<T> | T): Promise<T> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-candybar-acquire-"));
  const prev = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = root;
  return Promise.resolve(fn(path.join(root, "cc-candybar"))).finally(() => {
    if (prev === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = prev;
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {}
  });
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
        // sanity: stateDir actually got created under our temp root
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
        // Simulate the daemon coming up after a short delay — mirror the
        // bind() that the real daemon does on startup.
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

      // Fire 5 concurrent obtain calls — the spawn-lock should let exactly
      // one of them trigger the spawn fn; the rest attach.
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
        // One started, the rest attached. None failed.
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

      // Plant a lock file that looks stale (mtime backdated 30s).
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

      // Plant a fresh (non-stale) spawn.lock to simulate a crashed/stuck
      // holder. The staleness reclaim won't fire because the file's mtime
      // is current. Without the lock-fallback path, obtainDaemon would spin
      // until totalTimeoutMs and return "timeout obtaining daemon".
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
          // Simulate a daemon coming up.
          startFakeDaemon(socketPath())
            .then((s) => {
              server = s;
            })
            .catch(() => {});
          return true;
        },
        totalTimeoutMs: 1500,
        lockFallbackMs: 200, // give up on lock after 200ms
        spawnReadyTimeoutMs: 1000,
      });

      try {
        // The fallback path bypassed the stuck lock and spawned anyway.
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

      // Plant a *file* at the state-dir path. mkdirSync recursively will
      // succeed for the parent but fail to make `cc-candybar` a directory.
      // Forces the typed-failure path instead of propagating a throw.
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

      // Create the state dir, then make it read-only so openSync("wx") on
      // any file inside returns EACCES. This is the unrecoverable-error
      // path: we must NOT treat it as contention and spin until the deadline.
      fs.mkdirSync(daemonDir(), { recursive: true });
      const originalMode = fs.statSync(daemonDir()).mode;
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
        // Should return promptly, not spin until totalTimeoutMs.
        expect(elapsed).toBeLessThan(500);
      } finally {
        fs.chmodSync(daemonDir(), originalMode);
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
      // Spawn ran in the same synchronous turn.
      expect(spawned).toBe(1);
      // Lock was released by the time kick returned.
      expect(fs.existsSync(spawnLockPath())).toBe(false);
    });
  });

  test("does not spawn when lock is already held by another process", async () => {
    await withTempState(async () => {
      jest.resetModules();
      const { obtainDaemonKick } = await import("../src/daemon/acquire");
      const { spawnLockPath, daemonDir } = await import("../src/daemon/paths");

      fs.mkdirSync(daemonDir(), { recursive: true });
      // Plant a fresh lock (not stale) to simulate another caller in the
      // spawn window.
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

      // Make daemonDir() read-only so openSync("wx") on spawn.lock fails
      // with EACCES (not EEXIST). The kick must NOT treat this as a hard
      // stop — bind() arbitrates, so we spawn anyway.
      fs.mkdirSync(daemonDir(), { recursive: true });
      const originalMode = fs.statSync(daemonDir()).mode;
      fs.chmodSync(daemonDir(), 0o555);

      // Suppress the expected stderr "spawn-lock unavailable" warning
      // during this test to keep test output clean.
      const realStderrWrite = process.stderr.write.bind(process.stderr);
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
        // Spawn fired despite lock-error — bind() will arbitrate.
        expect(spawned).toBe(1);
        // The stderr warning was emitted with the reason.
        expect(stderrSpy).toHaveBeenCalled();
        const warned = String(stderrSpy.mock.calls[0]?.[0]);
        expect(warned).toMatch(/spawn-lock unavailable/);
      } finally {
        stderrSpy.mockRestore();
        process.stderr.write = realStderrWrite;
        fs.chmodSync(daemonDir(), originalMode);
      }
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
      // Kick must complete fully before any microtask gets a turn — this is
      // the load-bearing property: it's called immediately before
      // process.exit(0), so an async chain inside would never run.
      obtainDaemonKick({ spawn: () => true });
      expect(asyncRan).toBe(false);
    });
  });
});

describe("daemon startup (bind-based singleton)", () => {
  // We don't boot the full daemon here (too much surface) — we verify the
  // load-bearing bind() invariant directly: a second listener on the same
  // socket path gets EADDRINUSE.

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

  test("stale socket file: connect fails (ECONNREFUSED), unlink+rebind succeeds", async () => {
    await withTempState(async () => {
      jest.resetModules();
      const { socketPath } = await import("../src/daemon/paths");
      fs.mkdirSync(path.dirname(socketPath()), { recursive: true });

      // Plant a stale socket file (just a file, no listener — connect should
      // either ECONNREFUSED or ENOTSOCK; rebind needs unlink first).
      fs.writeFileSync(socketPath(), "");

      // First bind attempt fails (EADDRINUSE).
      await expect(
        new Promise((_, reject) => {
          const s = net.createServer();
          s.once("error", reject);
          s.listen(socketPath());
        }),
      ).rejects.toMatchObject({ code: "EADDRINUSE" });

      // Unlink and rebind — this is what handleAddressInUse does.
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

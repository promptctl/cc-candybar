import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  anchorFromEnv,
  armParentWatchdog,
  pidAlive,
  PARENT_PID_ENV,
} from "../src/daemon/parent-watchdog";

// [LAW:verifiable-goals] The contract under test is the leak's negation: a
// daemon spawned by a transient process MUST die when that process dies, even
// though nothing ran its teardown — which is exactly what a SIGKILLed Jest
// leaves behind. The unit tests pin the mechanism deterministically; the
// integration test proves it end-to-end on a real daemon process.

describe("anchorFromEnv", () => {
  test("absent variable → outlives nobody (the production daemon)", () => {
    expect(anchorFromEnv({})).toEqual({ kind: "outlives-nobody" });
  });

  test("positive integer pid → anchored to it", () => {
    expect(anchorFromEnv({ [PARENT_PID_ENV]: "12345" })).toEqual({
      kind: "anchored",
      pid: 12345,
    });
  });

  test.each(["", "abc", "0", "-3"])(
    "malformed value %p throws loudly rather than silently re-opening the leak",
    (raw) => {
      expect(() => anchorFromEnv({ [PARENT_PID_ENV]: raw })).toThrow(
        PARENT_PID_ENV,
      );
    },
  );
});

describe("armParentWatchdog", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test("outlives-nobody never trips and arms no timer", () => {
    const onOrphaned = jest.fn();
    const handle = armParentWatchdog({
      anchor: { kind: "outlives-nobody" },
      isAlive: () => false,
      onOrphaned,
    });
    jest.advanceTimersByTime(10_000);
    expect(onOrphaned).not.toHaveBeenCalled();
    expect(() => handle.disarm()).not.toThrow();
  });

  test("anchored + spawner alive never trips", () => {
    const onOrphaned = jest.fn();
    armParentWatchdog({
      anchor: { kind: "anchored", pid: 999 },
      isAlive: () => true,
      onOrphaned,
      intervalMs: 100,
    });
    jest.advanceTimersByTime(1_000);
    expect(onOrphaned).not.toHaveBeenCalled();
  });

  test("anchored + spawner gone trips with the spawner pid in the reason", () => {
    const onOrphaned = jest.fn();
    armParentWatchdog({
      anchor: { kind: "anchored", pid: 4242 },
      isAlive: () => false,
      onOrphaned,
      intervalMs: 100,
    });
    jest.advanceTimersByTime(100);
    expect(onOrphaned).toHaveBeenCalledWith(expect.stringContaining("4242"));
  });

  test("disarm stops further polling", () => {
    const onOrphaned = jest.fn();
    const handle = armParentWatchdog({
      anchor: { kind: "anchored", pid: 4242 },
      isAlive: () => false,
      onOrphaned,
      intervalMs: 100,
    });
    handle.disarm();
    jest.advanceTimersByTime(10_000);
    expect(onOrphaned).not.toHaveBeenCalled();
  });
});

describe("pidAlive", () => {
  test("this process is alive", () => {
    expect(pidAlive(process.pid)).toBe(true);
  });

  test("an exited process is not alive", async () => {
    const child = spawn(process.execPath, ["-e", "0"], { stdio: "ignore" });
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    expect(pidAlive(child.pid!)).toBe(false);
  });
});

// [LAW:verifiable-goals] End-to-end proof of the acceptance criterion in
// miniature: a REAL daemon process anchored to a throwaway "spawner" exits on
// its own when that spawner is SIGKILLed — no teardown hook involved, the same
// gap a killed Jest leaves. One controlled daemon, asserted dead, and force-
// reaped in afterEach so this test can never itself contribute to the leak.
describe("daemon dies with its spawner (integration)", () => {
  const REPO_ROOT = process.cwd();
  const ENTRY = path.join(REPO_ROOT, "src", "index.ts");
  const TSX_BIN = path.join(REPO_ROOT, "node_modules", ".bin", "tsx");

  const spawned: ChildProcess[] = [];
  const tmpDirs: string[] = [];

  const track = (c: ChildProcess): ChildProcess => {
    spawned.push(c);
    return c;
  };
  const tmp = (prefix: string): string => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tmpDirs.push(d);
    return d;
  };

  afterEach(() => {
    for (const c of spawned) {
      if (c.exitCode === null && c.signalCode === null) {
        try {
          c.kill("SIGKILL");
        } catch {
          // already gone
        }
      }
    }
    spawned.length = 0;
    for (const d of tmpDirs) {
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
    tmpDirs.length = 0;
  });

  test("SIGKILLing the anchor process shuts the daemon down", async () => {
    // A throwaway "spawner": stays alive until we kill it.
    const anchorProc = track(
      spawn(process.execPath, ["-e", "setInterval(() => {}, 1 << 30)"], {
        stdio: "ignore",
      }),
    );

    const stateRoot = tmp("cc-candybar-watchdog-");
    const stateDir = path.join(stateRoot, "cc-candybar");
    // Bind-time trust precondition: socket parent must be uid==me + mode 0700.
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const sockPath = path.join(stateDir, "socket");

    const daemon = track(
      spawn(TSX_BIN, [ENTRY, "daemon"], {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          CC_CANDYBAR_SOCKET: sockPath,
          XDG_STATE_HOME: stateRoot,
          XDG_CACHE_HOME: tmp("cc-candybar-watchdog-cache-"),
          XDG_CONFIG_HOME: tmp("cc-candybar-watchdog-config-"),
          // Anchor the daemon to the throwaway process, NOT this Jest worker, so
          // killing the anchor (and only the anchor) exercises the watchdog.
          [PARENT_PID_ENV]: String(anchorProc.pid),
        },
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
    daemon.stdout?.on("data", () => {});
    daemon.stderr?.on("data", () => {});

    // The socket file appears inside bind(), which runs strictly AFTER the
    // watchdog is armed — so its existence guarantees the watchdog is live.
    const readyDeadline = Date.now() + 5000;
    while (!fs.existsSync(sockPath) && Date.now() < readyDeadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(fs.existsSync(sockPath)).toBe(true);
    expect(daemon.exitCode).toBeNull();

    const daemonExited = new Promise<void>((resolve) =>
      daemon.once("exit", () => resolve()),
    );

    anchorProc.kill("SIGKILL");

    // Poll interval is 1s + a 500ms shutdown backstop; 8s is a generous ceiling.
    // Clear the deadline timer once the daemon exits so it can't outlive the
    // test and hold Jest's event loop open.
    let deadline: NodeJS.Timeout | undefined;
    const exitedInTime = await Promise.race([
      daemonExited.then(() => true),
      new Promise<boolean>((r) => {
        deadline = setTimeout(() => r(false), 8000);
      }),
    ]);
    clearTimeout(deadline);

    expect(exitedInTime).toBe(true);
    expect(pidAlive(daemon.pid!)).toBe(false);
  }, 20000);
});

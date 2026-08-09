// [LAW:single-enforcer] The ONE place that spins up a real, request-serving
// `cc-candybar daemon` subprocess against an isolated XDG_STATE_HOME/
// XDG_CACHE_HOME/XDG_CONFIG_HOME + short socket path — extracted from
// daemon-shutdown.test.ts (candybar-config-engine-71o.5) so every test that
// needs a real daemon over a real socket (not spawnTestDaemon's bare
// process-lifecycle probe) shares one spawn+readiness+cleanup
// implementation instead of re-deriving the short-socket-path /
// connect-round-trip-readiness gotchas per file.
//
// Split into prepare/spawn primitives (not just one all-in-one call) because
// a daemon-restart test needs to kill ONE daemon and spawn a SECOND against
// the exact same env/socket/state-dir — the persisted-overrides file it's
// proving survives a restart lives under that same XDG_STATE_HOME, so the
// tmpdirs must outlive the first daemon's death. `spawnIsolatedDaemon` is
// the convenience wrapper for the (more common) single-daemon-per-test case.

import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { spawnTestDaemon } from "./spawn-test-daemon";

export interface IsolatedDaemonEnv {
  env: NodeJS.ProcessEnv;
  sockPath: string;
  stateDir: string;
  removeTmpDirs(): void;
}

export function prepareIsolatedDaemonEnv(tmpPrefix: string): IsolatedDaemonEnv {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), `${tmpPrefix}-`));
  const stateDir = path.join(stateRoot, "cc-candybar");
  // Socket parent must satisfy ensureSocketParentSafe (uid==me + mode 0700).
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const sockPath = path.join(stateDir, "socket");

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CC_CANDYBAR_SOCKET: sockPath,
    XDG_STATE_HOME: stateRoot,
    XDG_CACHE_HOME: fs.mkdtempSync(
      path.join(os.tmpdir(), `${tmpPrefix}-cache-`),
    ),
    XDG_CONFIG_HOME: fs.mkdtempSync(
      path.join(os.tmpdir(), `${tmpPrefix}-config-`),
    ),
  };

  const removeTmpDirs = (): void => {
    try {
      fs.rmSync(stateRoot, { recursive: true, force: true });
    } catch {}
    if (env.XDG_CACHE_HOME) {
      try {
        fs.rmSync(env.XDG_CACHE_HOME, { recursive: true, force: true });
      } catch {}
    }
    if (env.XDG_CONFIG_HOME) {
      try {
        fs.rmSync(env.XDG_CONFIG_HOME, { recursive: true, force: true });
      } catch {}
    }
  };

  return { env, sockPath, stateDir, removeTmpDirs };
}

export interface RunningDaemon {
  child: ChildProcess;
  killTree(signal?: NodeJS.Signals): void;
}

// [LAW:verifiable-goals] Readiness is "the daemon actually accepts a
// connection", not "the socket file exists" — bind() creates the file
// synchronously but doesn't prove the accept() loop is running (the
// 452-corpse-adjacent incident this guards against: a daemon that bound but
// hung before accept() would let a "file exists" check pass and the test
// hang downstream on its first request).
export async function spawnDaemonWithEnv(
  env: NodeJS.ProcessEnv,
  sockPath: string,
): Promise<RunningDaemon> {
  const daemon = await spawnTestDaemon(env);
  const { child, killTree, release } = daemon;

  const deadline = Date.now() + 5000;
  let alive = false;
  while (!alive && Date.now() < deadline) {
    if (fs.existsSync(sockPath)) {
      alive = await new Promise<boolean>((resolve) => {
        const s = net.connect(sockPath);
        s.once("connect", () => {
          s.destroy();
          resolve(true);
        });
        s.once("error", () => resolve(false));
      });
    }
    if (!alive) {
      await new Promise((r) => setTimeout(r, 25));
    }
  }
  if (!alive) {
    killTree();
    release();
    throw new Error(
      "daemon did not accept connections within 5000ms (socket file" +
        ` ${fs.existsSync(sockPath) ? "exists" : "absent"})`,
    );
  }

  return { child, killTree: (signal) => { killTree(signal); release(); } };
}

export interface IsolatedDaemonHandle {
  child: ChildProcess;
  sockPath: string;
  stateDir: string;
  cleanup(): void;
}

export async function spawnIsolatedDaemon(
  tmpPrefix: string,
): Promise<IsolatedDaemonHandle> {
  const { env, sockPath, stateDir, removeTmpDirs } =
    prepareIsolatedDaemonEnv(tmpPrefix);
  let daemon: RunningDaemon;
  try {
    daemon = await spawnDaemonWithEnv(env, sockPath);
  } catch (e) {
    removeTmpDirs();
    throw e;
  }
  return {
    child: daemon.child,
    sockPath,
    stateDir,
    cleanup: (): void => {
      // killTree signals the whole process group, not just the `tsx`
      // wrapper — the wrapper forks its own worker (the process that
      // actually binds the socket), which survives as an orphan if only
      // the wrapper is signalled. Safe to call even after a graceful exit.
      daemon.killTree();
      removeTmpDirs();
    },
  };
}

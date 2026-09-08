// [LAW:single-enforcer] The one place that spins up a real, request-serving daemon
// against isolated XDG dirs; prepare/spawn are split so tmpdirs outlive a restart.

import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  spawnTestDaemon,
  TSX_SOURCE_ENTRY,
  type DaemonEntry,
} from "./spawn-test-daemon";
import { daemonPool } from "./daemon-pool";
import { sendDaemonRequest } from "./daemon-wire";
import { PROTOCOL_VERSION } from "../../src/daemon/protocol";

export interface IsolatedDaemonEnv {
  env: NodeJS.ProcessEnv;
  sockPath: string;
  stateDir: string;
  removeTmpDirs(): void;
}

// The smaller of the two platform limits, so a passing path passes on both.
const SUN_PATH_MAX = 104;

// `mkdtempSync` appends exactly six characters, so the path's LENGTH is known first.
const MKDTEMP_SUFFIX = "XXXXXX";

// [LAW:no-silent-failure] Past `sun_path`'s limit, bind() fails inside the spawned
// daemon and the only symptom is a five-second "socket file absent" timeout.
// [LAW:dataflow-not-control-flow] Runs before anything exists, so a throw leaks nothing.
function requireSocketPathFits(tmpPrefix: string): void {
  const longest = path.join(
    os.tmpdir(),
    `${tmpPrefix}-${MKDTEMP_SUFFIX}`,
    "cc-candybar",
    "socket",
  );
  if (Buffer.byteLength(longest) > SUN_PATH_MAX) {
    throw new Error(
      `isolated daemon socket path would be ${Buffer.byteLength(longest)} ` +
        `bytes, over the ${SUN_PATH_MAX}-byte sockaddr_un limit: ${longest}\n` +
        `Shorten the tmpPrefix passed to prepareIsolatedDaemonEnv ` +
        `("${tmpPrefix}").`,
    );
  }
}

export function prepareIsolatedDaemonEnv(tmpPrefix: string): IsolatedDaemonEnv {
  requireSocketPathFits(tmpPrefix);
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

// [LAW:verifiable-goals] Readiness is a real protocol round trip: a SIGKILLed
// daemon's listener still accepts for a few ms, so a bare connect reports ready
// against one about to disappear. [LAW:one-source-of-truth] `sockPath` comes from
// the same env the daemon is spawned with, never a parameter that could drift.
export async function spawnDaemonWithEnv(
  env: NodeJS.ProcessEnv,
  entry: DaemonEntry = TSX_SOURCE_ENTRY,
): Promise<RunningDaemon> {
  const sockPath = env.CC_CANDYBAR_SOCKET;
  if (!sockPath) {
    throw new Error(
      "spawnDaemonWithEnv: env.CC_CANDYBAR_SOCKET must be set (use " +
        "prepareIsolatedDaemonEnv to build env)",
    );
  }
  const daemon = await spawnTestDaemon(env, daemonPool, entry);
  const { child, killTree, release } = daemon;

  const deadline = Date.now() + 5000;
  let alive = false;
  while (!alive && Date.now() < deadline) {
    if (fs.existsSync(sockPath)) {
      try {
        const resp = await sendDaemonRequest(
          sockPath,
          { v: PROTOCOL_VERSION, kind: "stats" },
          1000,
        );
        alive = resp.ok;
      } catch {
        alive = false;
      }
    }
    if (!alive) {
      await new Promise((r) => setTimeout(r, 25));
    }
  }
  if (!alive) {
    killTree();
    release();
    throw new Error(
      "daemon did not answer a stats round trip within 5000ms (socket file" +
        ` ${fs.existsSync(sockPath) ? "exists" : "absent"})`,
    );
  }

  return {
    child,
    killTree: (signal) => {
      killTree(signal);
      release();
    },
  };
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
    daemon = await spawnDaemonWithEnv(env);
  } catch (e) {
    removeTmpDirs();
    throw e;
  }
  return {
    child: daemon.child,
    sockPath,
    stateDir,
    cleanup: (): void => {
      // killTree signals the whole group — `tsx` forks the worker that binds.
      daemon.killTree();
      removeTmpDirs();
    },
  };
}

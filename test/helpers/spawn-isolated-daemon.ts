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

// The smaller of the two platform limits, so a path that passes here passes on
// both. Linux allows 108; there is no gain in letting a test that works on
// Linux fail on a maintainer's Mac.
const SUN_PATH_MAX = 104;

// `mkdtempSync` replaces a trailing run of six X's — it always appends exactly
// six characters, so the socket path's LENGTH is fully determined before any of
// it exists.
const MKDTEMP_SUFFIX = "XXXXXX";

// [LAW:no-silent-failure] `sockaddr_un.sun_path` is 104 bytes on macOS (108 on
// Linux). Past that, bind() fails inside the spawned daemon and the only
// symptom a test sees is spawnDaemonWithEnv timing out five seconds later with
// "socket file absent" — which reads like a slow daemon and costs an afternoon.
// The prefix is the only part a caller controls, so fail here, naming the real
// cause and the fix.
//
// Runs BEFORE anything is created, which is why it needs no cleanup path: there
// is nothing on disk to leak when it throws. Checking after `mkdtempSync` would
// mean a try/finally guarding a case that only exists because the check ran too
// late [LAW:dataflow-not-control-flow].
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

// [LAW:verifiable-goals] Readiness is "the daemon completes a real
// protocol round trip", not "the socket accepts a raw connection" — a bare
// connect()-then-destroy proved the accept() loop was running (the
// 452-corpse-adjacent incident that guarded against), but it does NOT prove
// THIS process is the one that will still be listening a few milliseconds
// later. A cold-restart caller (`killAndWait` then `spawnDaemonWithEnv`
// again against the same socket path) races the OLD daemon's own death: a
// `SIGKILL`'d process can still be mid-teardown — its listener not yet torn
// down, so a bare connect legitimately succeeds against it — for a few ms
// after the signal lands. If the NEW daemon starts binding in that window,
// `handleAddressInUse`'s EADDRINUSE arbitration correctly sees the old pid
// as still alive and defers to it (`attach-and-exit`) rather than reclaiming
// — a right call in isolation, but the old process then finishes dying
// moments later, and the connect-only probe above had already reported
// "ready" against a daemon that both never fully started AND is about to
// disappear. The very next real request opens a connection, the dying old
// listener accepts it, then closes it mid-flight — "socket closed before
// response" (brandon-layout-edit-2gc.4 review: this raced consistently once
// slightly heavier config synthesis widened the window, but the race
// predates that change and can hit any cold-restart caller). A one-shot
// `stats` request (cheap, synchronous, no render/session state needed) is
// the actual readiness fact this helper promises: only a fully wired
// `handleConnection` dispatch answers it, so a stale dying listener that
// merely still accepts() cannot pass this probe the way it passed a bare
// connect.
//
// [LAW:one-source-of-truth] `sockPath` is read from `env.CC_CANDYBAR_SOCKET`
// — the SAME env this spawns the daemon with — rather than taken as a
// second parameter a caller could (even accidentally) pass out of sync with
// the env. The readiness probe below polls the socket the daemon actually
// binds, never a caller-supplied guess.
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
      // killTree signals the whole process group, not just the `tsx`
      // wrapper — the wrapper forks its own worker (the process that
      // actually binds the socket), which survives as an orphan if only
      // the wrapper is signalled. Safe to call even after a graceful exit.
      daemon.killTree();
      removeTmpDirs();
    },
  };
}

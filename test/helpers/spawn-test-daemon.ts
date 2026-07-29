// [LAW:single-enforcer] The ONE place in the test suite that spawns a real
// `cc-candybar daemon` subprocess. Every call gates on `daemonPool` first, so
// no test file can push the live-daemon count past the shared machine-global
// ceiling — see daemon-pool.ts for why that ceiling has to be machine-global,
// not per-worker or per-worktree.

import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";

import { daemonPool, type DaemonPool } from "./daemon-pool";

const REPO_ROOT = process.cwd();
const ENTRY = path.join(REPO_ROOT, "src", "index.ts");
const TSX_BIN = path.join(REPO_ROOT, "node_modules", ".bin", "tsx");

export interface TestDaemonProcess {
  child: ChildProcess;
  // [LAW:no-silent-failure] `tsx` is a CLI wrapper that forks its own worker
  // (the process that actually does the daemon's work, holds the socket, and
  // runs the parent-watchdog) as a SEPARATE OS process — `child` names only
  // the wrapper. `child.kill()` signals the wrapper alone; the worker is
  // reparented to init and keeps running, an orphan invisible to
  // `child.exitCode`. Callers that need the daemon actually gone (not just
  // the wrapper) MUST use `killTree`, which signals the whole process group
  // (spawned with `detached: true` for exactly this reason).
  // Best-effort — never throws (matches the try/catch every kill in this
  // suite's cleanup paths already wraps its process.kill in).
  killTree(signal?: NodeJS.Signals): void;
  // Idempotent, safe to call multiple times or not at all — the slot also
  // self-releases on the wrapper's `exit` event, so a test whose cleanup
  // forgets this (or crashes before reaching it) can't wedge the pool.
  release(): void;
}

export async function spawnTestDaemon(
  env: NodeJS.ProcessEnv,
  // Overridable only so tests can pin the ceiling under test to a small,
  // isolated pool (see daemon-pool.test.ts) — every real spawn site in the
  // suite itself uses the default, shared, machine-global pool.
  pool: DaemonPool = daemonPool,
): Promise<TestDaemonProcess> {
  const slot = await pool.acquire();
  let child: ChildProcess;
  try {
    child = spawn(TSX_BIN, [ENTRY, "daemon"], {
      cwd: REPO_ROOT,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      // New session + process group (pgid = child.pid), inherited by the
      // worker `tsx` forks — the ONLY thing that makes a group-wide signal
      // (killTree) reach both processes. Not the same as launchDetachedSync's
      // fire-and-forget: we still track this child's lifecycle (no unref()).
      detached: true,
    });
  } catch (e) {
    slot.release();
    throw e;
  }
  // Drain stdio so the child's pipes don't fill and stall.
  child.stdout?.on("data", () => {});
  child.stderr?.on("data", () => {});

  let released = false;
  const releaseOnce = (): void => {
    if (released) return;
    released = true;
    slot.release();
  };
  // [LAW:no-ambient-temporal-coupling] Releasing is driven by the wrapper's
  // actual exit event, not by hoping every caller's cleanup path runs it —
  // so a slot can never wedge because a test's own teardown was skipped
  // (an assertion throw, a forgotten `finally`, a Jest timeout).
  child.once("exit", releaseOnce);

  // [LAW:no-silent-failure] Best-effort by design, not by accident: this is a
  // cleanup primitive, always called from a test's teardown path (a
  // `finally`, an `afterEach`) where an unswallowed throw would mask the
  // test's real failure and, worse, skip every cleanup step after it (the
  // slot release, temp-dir removal) — the exact failure mode the old
  // `try { child.kill(...) } catch {}` this replaces was already guarding
  // against. ESRCH (group already gone) is the expected case; anything else
  // (e.g. EPERM) is equally not actionable by a test, so it's swallowed too.
  const killTree = (signal: NodeJS.Signals = "SIGKILL"): void => {
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, signal);
    } catch {
      // best-effort
    }
  };

  return { child, killTree, release: releaseOnce };
}

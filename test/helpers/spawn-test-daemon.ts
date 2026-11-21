// [LAW:single-enforcer] The test suite's spawner of a real `cc-candybar daemon`
// subprocess. Every call gates on `daemonPool` first, so a daemon started here
// counts against the shared machine-global ceiling — see daemon-pool.ts for why
// that ceiling has to be machine-global, not per-worker or per-worktree.

import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { daemonArgs, daemonCommand } from "../../src/daemon/acquire";
import {
  createDaemonPool,
  DEFAULT_POOL_DIR,
  DEFAULT_POOL_SIZE,
  type DaemonPool,
} from "./daemon-pool";
import { processProbe } from "./host";
import type { ExitResult } from "./daemon-wire";

const REPO_ROOT = process.cwd();

// The shared, machine-global pool every real-daemon-spawning test file uses,
// read through this worker's own probe.
export const daemonPool: DaemonPool = createDaemonPool(
  DEFAULT_POOL_DIR,
  DEFAULT_POOL_SIZE,
  processProbe,
);

// Enough of the end of a child's stderr to hold why it died.
const STDERR_TAIL_BYTES = 4096;
// Far past a daemon's graceful shutdown, which has its own backstop well under
// a second, and short enough that a wedged one fails before a test's timeout.
const STOP_BOUND_MS = 5_000;

// What process runs the daemon, given the env it runs with: the binary and its
// whole argument vector.
export type DaemonEntry = (env: NodeJS.ProcessEnv) => {
  readonly bin: string;
  readonly args: readonly string[];
};

// node's arguments for the daemon at `script`, after the loader: production's
// own, from src/daemon/acquire.ts.
type DaemonArgs = (script: string, env: NodeJS.ProcessEnv) => string[];

// The file `--import tsx` names, resolved as the package exports it. It is
// handed over as an absolute URL because the daemon starts its renderer with
// its own exec arguments from the state directory, where a bare `tsx` names
// nothing.
const TSX_LOADER = pathToFileURL(
  createRequire(path.join(REPO_ROOT, "package.json")).resolve("tsx"),
).href;

// [LAW:single-enforcer] The one way a test runs the daemon's source: node
// itself with tsx's loader imported, so the spawned pid IS the daemon and a
// test's signal reaches the process whose shutdown it tests. The `tsx` CLI is a
// wrapper that relays a signal to a worker of its own and SIGKILLs that worker
// if it has not answered within ~60 ms, so a daemon the scheduler is slow to
// run dies before its shutdown runs.
const sourceDaemon =
  (argv: DaemonArgs): DaemonEntry =>
  (env) => ({
    bin: process.execPath,
    args: [
      "--import",
      TSX_LOADER,
      ...argv(path.join(REPO_ROOT, "src", "index.ts"), env),
    ],
  });

// [LAW:one-source-of-truth] After the loader come the arguments the client's
// own spawn ships, heap cap included.
export const SOURCE_ENTRY: DaemonEntry = sourceDaemon(daemonArgs);

// The daemon's source run by hand, with no spawner in front of it. The client
// refuses to spawn a daemon on a memory budget it cannot read, so only this
// reaches the daemon's own refusal of one.
export const HAND_RUN_SOURCE: DaemonEntry = sourceDaemon(daemonCommand);

export interface TestDaemonProcess {
  child: ChildProcess;
  // Signals the process group the daemon leads (it is spawned `detached`).
  // What the daemon launches through its launcher leads a group of its own and
  // is out of reach; the children it runs blocking, with spawnSync, share its
  // group, so the signal reaches any of them that are running.
  // A group that is already gone is the expected case and is ignored; any
  // other refusal throws. Once the daemon's exit has been observed this
  // signals nothing, so a teardown's signal can never reach a reused pid.
  // [LAW:single-enforcer] A signal never frees the daemon's pool slot: its
  // exit does, so a test that needs the slot back awaits that exit.
  // The signal has no default: a teardown that wants the daemon gone stops it,
  // and this is for a signal meant to leave the daemon running for now.
  signalDaemon(signal: NodeJS.Signals): void;
  // [LAW:one-source-of-truth] The one "signal it, then wait for it to be gone":
  // signals now, and settles with how the daemon ended once its exit lands.
  // A daemon still running a bounded while after the signal is killed, and the
  // stop rejects naming the signal that did not take, so a wedged shutdown
  // says so instead of ending in a test's timeout.
  // The default is SIGKILL, which is right for teardown: a test that is done
  // does not care how the daemon dies, and SIGKILL cannot hang. It is the wrong
  // signal for a test that restarts the daemon and expects durable state back:
  // SIGKILL bypasses the daemon's shutdown funnel, and with it the session
  // state close that lands writes still inside the session file's debounce.
  // SIGTERM takes the graceful path a real restart takes.
  stop(signal?: NodeJS.Signals): Promise<ExitResult>;
  // [LAW:no-silent-failure] What a process that died before its first log line
  // said: a daemon logs nothing until it binds, so the log has no word of it.
  // Settles once the pipe has closed, so what a dying process said is all in it.
  // Nothing the daemon launches inherits that pipe (src/proc/launch.ts gives
  // every child piped or ignored stdio), so it closes when the daemon dies.
  stderrTail: Promise<string>;
}

// [LAW:parse-dont-validate] A process the kernel started has a pid; this is
// where a spawn becomes one, or fails loudly with why it did not. An error the
// child reports after it started has no promise left to reject, so it is
// thrown, where jest reports it.
function started(child: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("spawn", () => {
      child.off("error", reject);
      child.on("error", (e) => {
        throw e;
      });
      if (child.pid === undefined) {
        reject(new Error("a spawned process reported no pid"));
        return;
      }
      resolve(child.pid);
    });
  });
}

export async function spawnTestDaemon(
  env: NodeJS.ProcessEnv,
  // Overridable only so tests can pin the ceiling under test to a small,
  // isolated pool (see daemon-pool.test.ts) — every real spawn site in the
  // suite itself uses the default, shared, machine-global pool.
  pool: DaemonPool = daemonPool,
  entry: DaemonEntry = SOURCE_ENTRY,
): Promise<TestDaemonProcess> {
  const slot = await pool.acquire();
  let child: ChildProcess;
  let pid: number;
  try {
    const { bin, args } = entry(env);
    child = spawn(bin, args, {
      cwd: REPO_ROOT,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      // New session + process group (pgid = child.pid), so a signal to the
      // jest worker's group never reaches the daemon. Not the same as
      // launchDetachedSync's fire-and-forget: we still track this child's
      // lifecycle (no unref()).
      detached: true,
    });
    // [LAW:no-silent-failure] A spawn that fails (ENOENT for a missing binary)
    // says so on 'error', after spawn() has returned; it is thrown here, with
    // the slot released, since a process that never started never exits.
    pid = await started(child);
  } catch (e) {
    slot.release();
    throw e;
  }
  // Drain stdio so the child's pipes don't fill and stall.
  child.stdout?.on("data", () => {});
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-STDERR_TAIL_BYTES);
  });
  // [LAW:no-ambient-temporal-coupling] 'exit' can land before the pipe's last
  // bytes are read, and a process that dies before its log opens says why only
  // there. 'close' is the state that means they have arrived.
  const stderrTail = new Promise<string>((resolve) => {
    child.once("close", () => resolve(stderr));
  });

  // [LAW:no-silent-failure] Called from teardown paths too, so a group that is
  // already gone is the expected case. macOS answers ESRCH once the daemon is
  // reaped, and EPERM while it has exited and is not reaped yet: a group whose
  // only member is a zombie refuses every signal with EPERM. A live daemon is
  // this user's, so it never answers EPERM. Anything else (a bad signal name)
  // means the signal did not land, which a test must hear.
  const signalGroup = (signal: NodeJS.Signals): void => {
    try {
      process.kill(-pid, signal);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "ESRCH" && code !== "EPERM") throw e;
    }
  };
  // [LAW:no-ambient-temporal-coupling] Where a signal goes is state the exit
  // moves: the daemon's group while it runs, nowhere once its exit is seen,
  // when its pid is free for the kernel to hand to anything.
  let deliver: (signal: NodeJS.Signals) => void = signalGroup;

  // [LAW:single-enforcer] The daemon's exit is the one release of its slot.
  // The slot is held in the jest worker's name, so while the worker lives a
  // daemon that is alive, stopped or not, counts against the machine's
  // ceiling; a worker that dies leaves its slots to the stale sweep, which
  // frees them whatever became of the daemons.
  const exited = new Promise<ExitResult>((resolve) => {
    child.once("exit", (code, signal) => {
      deliver = () => {};
      slot.release();
      resolve({ code, signal });
    });
  });

  const signalDaemon = (signal: NodeJS.Signals): void => deliver(signal);
  const stop = async (
    signal: NodeJS.Signals = "SIGKILL",
  ): Promise<ExitResult> => {
    deliver(signal);
    let bound: NodeJS.Timeout | undefined;
    const outcome = await Promise.race([
      exited,
      new Promise<"outlived">((resolve) => {
        bound = setTimeout(() => resolve("outlived"), STOP_BOUND_MS);
      }),
    ]);
    clearTimeout(bound);
    if (outcome !== "outlived") return outcome;
    // [LAW:no-silent-failure] A daemon the asked signal did not end is a
    // wedged shutdown, and the failure names that signal. The kill comes
    // first, so the wedge leaks no process past the failure.
    deliver("SIGKILL");
    await exited;
    throw new Error(
      `the daemon (pid ${pid}) was still running ${STOP_BOUND_MS} ms after ${signal}, so it was killed with SIGKILL`,
    );
  };

  return { child, signalDaemon, stop, stderrTail };
}

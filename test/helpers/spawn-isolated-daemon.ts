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
// the exact same env/socket/state-dir — the config file and edit history
// it's proving survive a restart live under that same XDG root, so the
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
import { sendDaemonRequest, type ExitResult } from "./daemon-wire";
import { logPath } from "../../src/daemon/paths";
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
// Linux). Past that, bind() fails inside the spawned daemon, and what a test
// sees is spawnDaemonWithEnv reporting a daemon that exited before binding —
// true, but it names the exit, not the reason the bind was impossible. The
// prefix is the only part a caller controls, so fail here, naming the real
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

  const readiness = await awaitReadiness(child, sockPath);
  if (readiness.phase !== "serving") {
    killTree();
    release();
    throw new Error(readinessFailure(readiness, sockPath, env));
  }

  return {
    child,
    killTree: (signal) => {
      killTree(signal);
      release();
    },
  };
}

// [LAW:one-source-of-truth] ONE readiness budget for every call site of this
// helper — the PR #226 review's point stands: no per-caller knob, so a number
// that moves moves in one place.
//
// MEASURED, not inherited (brandon-ci-flakes-630.c7o). `tsx` compiling and
// loading src/index.ts is the entire cost; the daemon's own bind-to-serving step
// is noise beside it. Spawn to answered `stats`, on a 12-core Mac with a warm
// tsx cache:
//
//   machine state                             boot to serving
//   load ~17 / 12 cores (1.4x oversubscribed)   0.49 - 0.59 s
//   4 spawns at once (the maxWorkers: 4 shape)  0.63 - 0.95 s
//   load ~40 (3.3x)                             2.31 - 2.85 s
//   load ~116 (9.7x)                            over 5 s — the reported failure
//
// Boot cost tracks CPU oversubscription almost linearly, so this number is a
// statement about how starved a machine may be before the suite calls a healthy
// daemon broken. 12 s buys ~24x oversubscription — 2.4x the load that broke the
// inherited 5 s — and two of them still fit inside jest.config.js's 30 s
// testTimeout, which is what a cold-restart test spends it on.
const READINESS_BUDGET_MS = 12_000;

// A bound socket answered in 2-65 ms across every row above, so this bounds a
// round trip that has already been accepted, not a boot. It stays far below the
// budget on purpose: one unanswered attempt must not consume the boot's wait.
const STATS_REPLY_BUDGET_MS = 1000;

const READINESS_POLL_MS = 25;

// [LAW:types-are-the-program] Readiness is not a boolean: a failure carries TWO
// facts, and which pair it is decides the diagnosis. How far the socket got says
// which half of the boot died — the criterion this ticket exists for — and the
// child's exit says whether the daemon refused or is merely slow. `serving` is
// the only success and it carries neither, so the failure arm's phase is exactly
// the two remaining values and the projection below is total over them; there is
// no unreachable third case to write a sentence for.
//
// The pair deliberately stops short of "is the answering daemon OURS". Nothing
// on the wire says which process answered, and an exit read cannot stand in for
// it: against a LIVE incumbent the socket answers on the first poll, before our
// own child has reached its EADDRINUSE decision at all (measured), so an
// exit-based check would catch that case only when the scheduler happened to
// cooperate. A coin-flip detector for a race is worse than a documented one —
// see the accepted-incumbent case in test/spawn-isolated-daemon.test.ts.
type BootPhase = "booting" | "bound" | "serving";
type FailedPhase = Exclude<BootPhase, "serving">;

export interface ReadinessFailure {
  readonly phase: FailedPhase;
  readonly exit: ExitResult | null;
}

type Readiness = { readonly phase: "serving" } | ReadinessFailure;

// [LAW:no-ambient-temporal-coupling] Every failure this helper can diagnose is
// awaited as a named fact; the budget bounds the one state that publishes none.
// The daemon writes nothing before it binds — its first log line is `daemon up`,
// AFTER the bind — so there is no earlier milestone to wait on inside `tsx`
// boot, which is exactly the phase that times out. But a daemon that refuses to
// boot EXITS, and the `tsx` wrapper propagates that exit, so every refusal the
// daemon diagnoses about itself (`refusing to boot`, the fork-bomb breaker,
// `EADDRINUSE ... exiting`) is readable the instant it happens instead of at the
// end of a budget. That is what lets the budget above be generous: it is no
// longer the detector for anything the daemon can tell us itself, only the last
// bound on a live process that has not answered yet.
async function awaitReadiness(
  child: ChildProcess,
  sockPath: string,
): Promise<Readiness> {
  const deadline = Date.now() + READINESS_BUDGET_MS;
  let phase: FailedPhase = "booting";
  for (;;) {
    if (fs.existsSync(sockPath)) {
      phase = "bound";
      if (await answersStats(sockPath)) return { phase: "serving" };
    }
    const exit = exitedAlready(child);
    if (exit !== null) return { phase, exit };
    if (Date.now() >= deadline) return { phase, exit: null };
    await new Promise((r) => setTimeout(r, READINESS_POLL_MS));
  }
}

// [LAW:one-source-of-truth] Node retains the terminal code/signal on the
// ChildProcess after `exit` fires, which is what makes reading it directly
// race-free — the same property `waitForExit`'s pre-check reads in
// daemon-wire.ts. This is that read's polling half: one synchronous look per
// poll, so no `once("exit")` listener accumulates across iterations. It is asked
// only while nothing has answered yet, which is the whole window in which a
// refusal is the explanation.
function exitedAlready(child: ChildProcess): ExitResult | null {
  if (child.exitCode === null && child.signalCode === null) return null;
  return { code: child.exitCode, signal: child.signalCode };
}

async function answersStats(sockPath: string): Promise<boolean> {
  try {
    const resp = await sendDaemonRequest(
      sockPath,
      { v: PROTOCOL_VERSION, kind: "stats" },
      STATS_REPLY_BUDGET_MS,
    );
    return resp.ok;
  } catch {
    return false;
  }
}

// [LAW:dataflow-not-control-flow] One total projection of the (phase, exit) pair
// onto the sentence a reader needs: what the socket did, what our process did,
// then the daemon's own words. Exported so every combination is checked as a
// value, rather than by provoking each process state in a test that would then
// have to wait for it.
export function readinessFailure(
  readiness: ReadinessFailure,
  sockPath: string,
  env: NodeJS.ProcessEnv,
): string {
  return (
    `daemon never became ready: ${socketDid(readiness.phase, sockPath)}; ` +
    `${processDid(readiness.exit)}\n${daemonLogTail(env)}`
  );
}

function socketDid(phase: FailedPhase, sockPath: string): string {
  switch (phase) {
    case "booting":
      return `no socket at ${sockPath}, so it never got as far as binding`;
    case "bound":
      return `it bound ${sockPath} but never answered a stats round trip`;
  }
}

function processDid(exit: ExitResult | null): string {
  if (exit === null) {
    return (
      `the process was still running when the ${READINESS_BUDGET_MS}ms budget ` +
      `expired, so this is a slow boot, not a refusal`
    );
  }
  const how =
    exit.signal !== null ? `signal ${exit.signal}` : `code ${exit.code}`;
  return `the process exited (${how}), and said why in the log below`;
}

// [LAW:no-silent-failure] A daemon that never answered wrote its own reason
// down — `refusing to boot`, `EADDRINUSE … exiting`, `parent watchdog` — in
// the log this env points it at (its stdio is drained into nothing). A
// readiness failure that quotes that log names its cause, where the phase above
// only names which half of the boot it died in.
function daemonLogTail(env: NodeJS.ProcessEnv, lines = 20): string {
  const file = logPath(env);
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    return `daemon log ${file}: ${(e as Error).message}`;
  }
  const tail = text.trimEnd().split("\n").slice(-lines).join("\n");
  return `daemon log ${file} (last ${lines} lines):\n${tail}`;
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

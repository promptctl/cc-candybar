// [LAW:single-enforcer] The place that spins up a real, request-serving
// `cc-candybar daemon` subprocess against an isolated XDG_STATE_HOME/
// XDG_CACHE_HOME/XDG_CONFIG_HOME/XDG_DATA_HOME + short socket path, for every
// caller that needs a real daemon over a real socket: the tests (through the
// suite's pool, test/helpers/spawn-isolated-daemon.ts) and the bar tools.
// One spawn+readiness+cleanup implementation, so the short-socket-path and
// connect-round-trip-readiness gotchas are solved once.
//
// Split into prepare/start primitives (not just one all-in-one call) because
// a daemon-restart caller needs to kill ONE daemon and start a SECOND against
// the exact same env/socket/state-dir — the config file and edit history
// it's proving survive a restart live under that same XDG root, so the
// tmpdirs must outlive the first daemon's death. `startIsolatedDaemon` is
// the convenience wrapper for the (more common) single-daemon case.

import type { ChildProcess } from "node:child_process";
import { hostOf } from "../host";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { socketIn } from "./layout";
import {
  spawnDaemonProcess,
  type AcquireSlot,
  type DaemonEntry,
} from "./process";
import { sendDaemonRequest, type ExitResult } from "./wire";
import { logPath } from "../../../src/daemon/paths";
import { PROTOCOL_VERSION } from "../../../src/daemon/foundations/protocol";
import { failAfter } from "../fail-after";

export interface IsolatedDaemonEnv {
  // The temporary directory everything below is under, removed with them.
  root: string;
  env: NodeJS.ProcessEnv;
  sockPath: string;
  stateDir: string;
  removeTmpDirs(): void;
}

// The smaller of the two platform limits, so a path that passes here passes on
// both. Linux allows 108; there is no gain in letting a test that works on
// Linux fail on a maintainer's Mac. The field holds the path's terminating NUL
// too, so the longest path that binds is one byte shorter.
const SUN_PATH_MAX = 104;

// `mkdtempSync` replaces a trailing run of six X's — it always appends exactly
// six characters, so the socket path's LENGTH is fully determined before any of
// it exists.
const MKDTEMP_SUFFIX = "XXXXXX";

// [LAW:no-silent-failure] `sockaddr_un.sun_path` is 104 bytes on macOS (108 on
// Linux). Past that, bind() fails inside the spawned daemon, and what a test
// sees is startDaemonWithEnv reporting a daemon that exited before binding —
// true, but it names the exit, not the reason the bind was impossible. The
// prefix is the only part a caller controls, so fail here, naming the real
// cause and the fix.
//
// Runs BEFORE anything is created, which is why it needs no cleanup path: there
// is nothing on disk to leak when it throws. Checking after `mkdtempSync` would
// mean a try/finally guarding a case that only exists because the check ran too
// late [LAW:dataflow-not-control-flow].
function requireSocketPathFits(tmpPrefix: string): void {
  const longest = socketIn(
    path.join(os.tmpdir(), `${tmpPrefix}-${MKDTEMP_SUFFIX}`),
  );
  if (Buffer.byteLength(longest) >= SUN_PATH_MAX) {
    throw new Error(
      `isolated daemon socket path would be ${Buffer.byteLength(longest)} ` +
        `bytes, over the ${SUN_PATH_MAX}-byte sockaddr_un limit: ${longest}\n` +
        `Shorten the tmpPrefix passed to prepareIsolatedDaemonEnv ` +
        `("${tmpPrefix}").`,
    );
  }
}

// The isolated env over `base`, the environment the caller's root runs the
// daemon in: the test suite's worker env, or a dev tool's shell
// (scripts/lib/shell.ts). Every directory the daemon writes is under one
// temporary root, so one removal takes them all.
export function prepareIsolatedDaemonEnv(
  tmpPrefix: string,
  base: NodeJS.ProcessEnv,
): IsolatedDaemonEnv {
  requireSocketPathFits(tmpPrefix);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `${tmpPrefix}-`));
  const removeTmpDirs = (): void => {
    fs.rmSync(root, { recursive: true, force: true });
  };
  const sockPath = socketIn(root);
  const stateDir = path.dirname(sockPath);
  const cache = path.join(root, "cache");
  const config = path.join(root, "config");
  try {
    // Socket parent must satisfy ensureSocketParentSafe (uid==me + mode 0700).
    fs.mkdirSync(stateDir, { mode: 0o700 });
    fs.mkdirSync(cache);
    fs.mkdirSync(config);
  } catch (e) {
    failAfter(e, removeTmpDirs);
  }

  const env: NodeJS.ProcessEnv = {
    ...base,
    CC_CANDYBAR_SOCKET: sockPath,
    XDG_STATE_HOME: root,
    XDG_CACHE_HOME: cache,
    XDG_CONFIG_HOME: config,
    // Both data locations name a directory with nothing in it, so the daemon
    // finds none of the host's installed plugins.
    XDG_DATA_HOME: path.join(root, "data"),
    XDG_DATA_DIRS: path.join(root, "data"),
  };

  return { root, env, sockPath, stateDir, removeTmpDirs };
}

export interface RunningDaemon {
  child: ChildProcess;
  signalDaemon(signal: NodeJS.Signals): void;
  stop(signal?: NodeJS.Signals): Promise<ExitResult>;
}

// [LAW:verifiable-goals] Readiness is "the daemon completes a real
// protocol round trip", not "the socket accepts a raw connection" — a bare
// connect()-then-destroy proved the accept() loop was running (the
// 452-corpse-adjacent incident that guarded against), but it does NOT prove
// THIS process is the one that will still be listening a few milliseconds
// later. A cold-restart caller (`stop` then `startDaemonWithEnv`
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
export async function startDaemonWithEnv(
  env: NodeJS.ProcessEnv,
  acquire: AcquireSlot,
  entry?: DaemonEntry,
): Promise<RunningDaemon> {
  const sockPath = env.CC_CANDYBAR_SOCKET;
  if (!sockPath) {
    throw new Error(
      "startDaemonWithEnv: env.CC_CANDYBAR_SOCKET must be set (use " +
        "prepareIsolatedDaemonEnv to build env)",
    );
  }
  const { child, signalDaemon, stop, stderrTail } = await spawnDaemonProcess(
    env,
    acquire,
    entry,
  );

  const readiness = await awaitReadiness(child, sockPath);
  if (readiness.phase !== "serving") {
    // Gone before the throw, since the caller's next step is removing the
    // directories it writes into.
    await stop();
    throw new Error(
      readinessFailure(readiness, sockPath, env, await stderrTail),
    );
  }

  return { child, signalDaemon, stop };
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
export const READINESS_BUDGET_MS = 12_000;

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
// see the accepted-incumbent case in test/daemon-boots/process/spawn-isolated-daemon.test.ts.
//
// A bound socket that never answered carries why its last stats probe did not:
// while the daemon boots, a refused connect, a dying incumbent's closed
// socket and a slow reply all mean "not yet", and the one that was still true
// at the end is the failure's cause.
export type ReadinessFailure =
  | { readonly phase: "booting"; readonly exit: ExitResult | null }
  | {
      readonly phase: "bound";
      readonly exit: ExitResult | null;
      readonly lastProbe: string;
    };

type Readiness = { readonly phase: "serving" } | ReadinessFailure;

// [LAW:no-ambient-temporal-coupling] Every failure this helper can diagnose is
// awaited as a named fact; the budget bounds the one state that publishes none.
// The daemon writes nothing before it binds — its first log line is `daemon up`,
// AFTER the bind — so there is no earlier milestone to wait on inside the
// source's compile, which is exactly the phase that times out. But a daemon that
// refuses to boot EXITS, and it is the child this helper holds, so every refusal the
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
  // Why the last probe of the bound socket was not served, or `null` while
  // there is no socket to probe.
  let lastProbe: string | null = null;
  const failed = (exit: ExitResult | null): ReadinessFailure =>
    lastProbe === null
      ? { phase: "booting", exit }
      : { phase: "bound", exit, lastProbe };
  for (;;) {
    if (fs.existsSync(sockPath)) {
      const probe = await probeStats(sockPath);
      if (probe.served) return { phase: "serving" };
      lastProbe = probe.why;
    }
    const exit = exitedAlready(child);
    if (exit !== null) return failed(exit);
    if (Date.now() >= deadline) return failed(null);
    await new Promise((r) => setTimeout(r, READINESS_POLL_MS));
  }
}

// [LAW:one-source-of-truth] Node retains the terminal code/signal on the
// ChildProcess after `exit` fires, which is what makes reading it directly
// race-free — the same property `waitForExit`'s pre-check reads in
// scripts/lib/daemon/wire.ts. This is that read's polling half: one synchronous look per
// poll, so no `once("exit")` listener accumulates across iterations. It is asked
// only while nothing has answered yet, which is the whole window in which a
// refusal is the explanation.
function exitedAlready(child: ChildProcess): ExitResult | null {
  if (child.exitCode === null && child.signalCode === null) return null;
  return { code: child.exitCode, signal: child.signalCode };
}

// A stats round trip: served, or why it was not.
type Probe =
  | { readonly served: true }
  | { readonly served: false; readonly why: string };

async function probeStats(sockPath: string): Promise<Probe> {
  try {
    const resp = await sendDaemonRequest(
      sockPath,
      { v: PROTOCOL_VERSION, kind: "stats" },
      STATS_REPLY_BUDGET_MS,
    );
    return resp.ok
      ? { served: true }
      : { served: false, why: `answered ${resp.error} (${resp.code})` };
  } catch (e) {
    return {
      served: false,
      why: e instanceof Error ? e.message : String(e),
    };
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
  stderr: string,
): string {
  return (
    `daemon never became ready: ${socketDid(readiness, sockPath)}; ` +
    `${processDid(readiness.exit)}\n${daemonLogTail(env)}\nstderr:\n${stderr}`
  );
}

function socketDid(readiness: ReadinessFailure, sockPath: string): string {
  switch (readiness.phase) {
    case "booting":
      return `no socket at ${sockPath}, so it never got as far as binding`;
    case "bound":
      return `it bound ${sockPath} but never answered a stats round trip (the last: ${readiness.lastProbe})`;
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
  return `the process exited (${how}), and said why below`;
}

// [LAW:no-silent-failure] A daemon that never answered wrote its own reason
// down — `refusing to boot`, `EADDRINUSE … exiting`, `parent watchdog` — in
// the log this env points it at, or on stderr if it died before it had a log. A
// readiness failure that quotes both names its cause, where the phase above only
// names which half of the boot it died in.
function daemonLogTail(env: NodeJS.ProcessEnv, lines = 20): string {
  const file = logPath(hostOf(env));
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
  cleanup(): Promise<void>;
}

export async function startIsolatedDaemon(
  tmpPrefix: string,
  base: NodeJS.ProcessEnv,
  acquire: AcquireSlot,
  entry?: DaemonEntry,
): Promise<IsolatedDaemonHandle> {
  const { env, sockPath, stateDir, removeTmpDirs } = prepareIsolatedDaemonEnv(
    tmpPrefix,
    base,
  );
  let daemon: RunningDaemon;
  try {
    daemon = await startDaemonWithEnv(env, acquire, entry);
  } catch (e) {
    failAfter(e, removeTmpDirs);
  }
  return {
    child: daemon.child,
    sockPath,
    stateDir,
    cleanup: async (): Promise<void> => {
      // The daemon is gone before its state directory is, since it would
      // otherwise keep writing its log and lease into it. A stop that fails has
      // still killed it and seen it exit, so the directories go either way.
      // Safe to call again, or after the daemon's own exit, because once that
      // exit is seen a stop sends nothing and only waits.
      try {
        await daemon.stop();
      } catch (e) {
        failAfter(e, removeTmpDirs);
      }
      removeTmpDirs();
    },
  };
}

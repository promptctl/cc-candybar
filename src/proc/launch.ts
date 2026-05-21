// [LAW:single-enforcer] Every subprocess in the Node runtime goes through one
// boundary. The primitive owns the import of `node:child_process`; every other
// module imports `launch`/`launchSync` from here. The ESLint config (and the
// kz8.2 DoD grep) enforces this.
//
// [LAW:one-type-per-behavior] `exec`/`execFile`/`spawn` and their sync twins
// are seven names for one act. `LaunchOpts` is the single shape; sync vs async
// is a separate function pair, not a config flag.
//
// [LAW:dataflow-not-control-flow] Categories flow through one boundary as
// data; the body is the same code path for every category. The metering layer
// reads the category off the request, not off the call site.
//
// [LAW:types-are-the-program] (kz8.6) Process lifetime is encoded in the
// operation, not in a flag. `launch`/`launchSync` are *waited*: the child is
// reaped before the caller resumes, so it cannot outlive its frame.
// `launchDetachedSync` is the *orphan*: it detaches and unrefs, deliberately
// outliving its caller — the daemon-handoff escape hatch, used only by the
// daemon-acquisition path. There is no `detached: boolean` flag on `LaunchOpts`
// ([LAW:no-mode-explosion]); the two lifetimes are two functions with two
// return contracts, so an unwaited helper that survives a render frame is
// unrepresentable here rather than forbidden by convention.

import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess, StdioOptions } from "node:child_process";

import type { LaunchStatsHandle } from "./stats-handle";

// Closed list of subprocess categories. Adding a new spawn site requires
// adding its category here, which forces a code review of the new launch
// pattern. [LAW:no-mode-explosion]: no per-site escape hatch.
export const LAUNCH_CATEGORIES = [
  "git",
  "user-shell",
  "tmux",
  "click.pbcopy",
  "click.open",
  "install.plutil",
  "install.osacompile",
  "install.lsregister",
  "install.pbcopy",
  "install.open",
  "daemon-spawn",
] as const;

export type LaunchCategory = (typeof LAUNCH_CATEGORIES)[number];

// [LAW:single-enforcer] Per-category minimum interval between spawn attempts
// (start timestamps). The limiter records on attempt, not on success — a
// failed spawn still arms the timer so a broken binary can't be retried in a
// tight loop. Sparse map: categories without entries have no rate limit.
// [LAW:no-mode-explosion] Bounds are constants here, not config knobs — the
// caps protect the host from misbehaving renderers/templates and don't need
// user tuning. Bump these if a legitimate workload starts hitting them.
const RATE_LIMITS: Partial<Record<LaunchCategory, number>> = {
  // Click verbs: a misbehaving template emitting many clickable links + a
  // user rapid-clicking = unbounded helpers. One spawn per second is enough
  // for any human click cadence.
  "click.pbcopy": 1000,
  "click.open": 1000,
};

// [LAW:one-source-of-truth] Last-attempt timestamp per category — the data
// the rate-limit decision reads. Recorded for every attempted spawn (success
// or spawn-error); rate-limit rejections do NOT update this, because no
// spawn was attempted. Module-scope state is acceptable here because
// `launch.ts` is itself the single enforcer; nothing else mutates this.
const lastStartAt = new Map<LaunchCategory, number>();

// [LAW:dataflow-not-control-flow] The rate-limit decision is a pure function
// of (category, now, last-start, policy). Same code path every call; the
// result type carries which branch fired.
function checkRateLimit(
  category: LaunchCategory,
):
  | { allowed: true }
  | { allowed: false; minIntervalMs: number; sinceLastMs: number } {
  const minIntervalMs = RATE_LIMITS[category];
  if (minIntervalMs === undefined) return { allowed: true };
  const last = lastStartAt.get(category);
  if (last === undefined) return { allowed: true };
  const sinceLastMs = Date.now() - last;
  if (sinceLastMs >= minIntervalMs) return { allowed: true };
  return { allowed: false, minIntervalMs, sinceLastMs };
}

function recordStart(category: LaunchCategory): void {
  lastStartAt.set(category, Date.now());
}

// Exposed for tests only — resets the rate-limit tracker so each test starts
// from a clean state.
export function __resetRateLimitsForTest(): void {
  lastStartAt.clear();
}

export interface LaunchOpts {
  bin: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  stdinInput?: string | Buffer;
  category: LaunchCategory;
}

export type LaunchResult =
  | { ok: true; stdout: string; stderr: string; exitCode: number | null }
  | {
      ok: false;
      // [LAW:one-type-per-behavior] Distinct termination causes get distinct
      // tags so callers + stats can attribute correctly. "timeout" means the
      // local timer fired; "signal" means the OS or external killer ended the
      // child for some other reason (SIGKILL/SIGINT/SIGPIPE/SIGHUP/...);
      // "non-zero" is a clean exit with a non-zero code; "spawn-error" is a
      // failure before the child started; "rate-limited" means the primitive
      // refused to spawn because the per-category minimum interval was not
      // yet elapsed — no child process was launched.
      reason:
        | "timeout"
        | "signal"
        | "spawn-error"
        | "non-zero"
        | "rate-limited";
      stdout: string;
      stderr: string;
      exitCode: number | null;
      signal: NodeJS.Signals | null;
      error?: string;
    };

function rateLimitedResult(
  category: LaunchCategory,
  minIntervalMs: number,
  sinceLastMs: number,
): LaunchResult {
  return {
    ok: false,
    reason: "rate-limited",
    stdout: "",
    stderr: "",
    exitCode: null,
    signal: null,
    error: `rate-limited: ${category} min interval ${minIntervalMs}ms, last start ${sinceLastMs}ms ago`,
  };
}

let statsHandle: LaunchStatsHandle | null = null;

// Install the stats handle once, at daemon startup. Other runtimes (Node
// fallback, install path) leave it null and pay no metering cost.
export function setLaunchStats(handle: LaunchStatsHandle | null): void {
  statsHandle = handle;
}

// [LAW:types-are-the-program] Grace between SIGTERM and SIGKILL on the timeout
// path. The lifetime invariant ("waited — child reaped before the caller
// resumes") requires that a child which ignores SIGTERM is still gone before we
// resolve. SIGTERM lets well-behaved children flush/clean up; SIGKILL is the
// backstop so the promise cannot resolve while the child is still alive.
const TIMEOUT_KILL_GRACE_MS = 250;

export async function launch(opts: LaunchOpts): Promise<LaunchResult> {
  const gate = checkRateLimit(opts.category);
  if (!gate.allowed) {
    return rateLimitedResult(
      opts.category,
      gate.minIntervalMs,
      gate.sinceLastMs,
    );
  }
  recordStart(opts.category);
  const t0 = Date.now();
  statsHandle?.onStart(opts.category);

  return new Promise<LaunchResult>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(opts.bin, opts.args ?? [], {
        cwd: opts.cwd,
        env: opts.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      statsHandle?.onEnd(opts.category, Date.now() - t0);
      resolve({
        ok: false,
        reason: "spawn-error",
        stdout: "",
        stderr: "",
        exitCode: null,
        signal: null,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    let killTimer: NodeJS.Timeout | null = null;
    // [LAW:dataflow-not-control-flow] Whether the close was caused by *our*
    // timer is data we have to carry. The OS doesn't tell us why a child was
    // signalled — without this flag, SIGKILL from the OOM killer, SIGINT
    // propagated through the tty, SIGPIPE on a closed pipe, etc. all get
    // misreported as "timeout".
    let timedOut = false;

    const settle = (r: LaunchResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      statsHandle?.onEnd(opts.category, Date.now() - t0);
      resolve(r);
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (err) => {
      settle({
        ok: false,
        reason: "spawn-error",
        stdout,
        stderr,
        exitCode: null,
        signal: null,
        error: err.message,
      });
    });

    child.on("close", (code, signal) => {
      // [LAW:types-are-the-program] We resolve here, on the *actual* exit —
      // including the timeout path. Once `timedOut` is set the deadline has
      // elapsed, so the outcome is "timeout" regardless of which signal
      // (SIGTERM or the escalated SIGKILL) finally ended the child.
      if (timedOut) {
        settle({
          ok: false,
          reason: "timeout",
          stdout,
          stderr,
          exitCode: code,
          signal,
        });
        return;
      }
      if (code === 0) {
        settle({ ok: true, stdout, stderr, exitCode: code });
        return;
      }
      const reason: "signal" | "non-zero" = signal ? "signal" : "non-zero";
      settle({
        ok: false,
        reason,
        stdout,
        stderr,
        exitCode: code,
        signal,
      });
    });

    if (opts.timeoutMs && opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        // [LAW:types-are-the-program] Do NOT settle here. We signal and let
        // the `close` handler resolve once the child is actually gone, so the
        // promise never resolves while the child is still alive. SIGTERM
        // first; SIGKILL after a grace period if the child ignores it.
        child.kill("SIGTERM");
        killTimer = setTimeout(() => {
          child.kill("SIGKILL");
        }, TIMEOUT_KILL_GRACE_MS);
      }, opts.timeoutMs);
    }

    if (opts.stdinInput !== undefined && child.stdin) {
      child.stdin.end(opts.stdinInput);
    } else if (child.stdin) {
      child.stdin.end();
    }
  });
}

// Sync variant. For callers that genuinely cannot be async — the spawn
// outcome must be settled before the function returns.
export function launchSync(opts: LaunchOpts): LaunchResult {
  const gate = checkRateLimit(opts.category);
  if (!gate.allowed) {
    return rateLimitedResult(
      opts.category,
      gate.minIntervalMs,
      gate.sinceLastMs,
    );
  }
  recordStart(opts.category);
  const t0 = Date.now();
  statsHandle?.onStart(opts.category);

  const stdio: StdioOptions = ["pipe", "pipe", "pipe"];
  try {
    const result = spawnSync(opts.bin, opts.args ?? [], {
      cwd: opts.cwd,
      env: opts.env,
      input: opts.stdinInput,
      timeout:
        opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : undefined,
      stdio,
      encoding: "utf8",
    });

    statsHandle?.onEnd(opts.category, Date.now() - t0);

    const stdout = typeof result.stdout === "string" ? result.stdout : "";
    const stderr = typeof result.stderr === "string" ? result.stderr : "";

    if (result.error) {
      // Node sets `error` for ETIMEDOUT and ENOENT; distinguish by code.
      const code = (result.error as NodeJS.ErrnoException).code;
      const reason: "timeout" | "spawn-error" =
        code === "ETIMEDOUT" ? "timeout" : "spawn-error";
      return {
        ok: false,
        reason,
        stdout,
        stderr,
        exitCode: null,
        signal: result.signal ?? null,
        error: result.error.message,
      };
    }

    if (result.status === 0) {
      return { ok: true, stdout, stderr, exitCode: result.status };
    }

    // [LAW:dataflow-not-control-flow] The reason data lives in the
    // spawnSync result, not in the surrounding control flow. Node sets
    // `result.signal` whenever the child died from a signal — including but
    // not limited to the timeout's SIGTERM. We can only attribute "timeout"
    // when a timeout was actually requested; otherwise the signal came from
    // somewhere else (OOM killer, ctrl-C through the tty group, etc.).
    const hasTimeout = opts.timeoutMs !== undefined && opts.timeoutMs > 0;
    const reason: "timeout" | "signal" | "non-zero" = result.signal
      ? hasTimeout && result.signal === "SIGTERM"
        ? "timeout"
        : "signal"
      : "non-zero";
    return {
      ok: false,
      reason,
      stdout,
      stderr,
      exitCode: result.status,
      signal: result.signal ?? null,
    };
  } catch (err) {
    statsHandle?.onEnd(opts.category, Date.now() - t0);
    return {
      ok: false,
      reason: "spawn-error",
      stdout: "",
      stderr: "",
      exitCode: null,
      signal: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// [LAW:single-enforcer] The one orphan operation: a detached, unref'd,
// fire-and-forget launch that deliberately outlives its caller. This is the
// only Node-side launch with that lifetime; everything else waits. It returns
// the typed spawn outcome synchronously (so a failed spawn surfaces as
// `ok: false` rather than a discarded Promise reporting success), and meters
// through the stats handle so orphan spawns still show up in daemon-stats.
export function launchDetachedSync(opts: LaunchOpts): LaunchResult {
  const gate = checkRateLimit(opts.category);
  if (!gate.allowed) {
    return rateLimitedResult(
      opts.category,
      gate.minIntervalMs,
      gate.sinceLastMs,
    );
  }
  recordStart(opts.category);
  const t0 = Date.now();
  statsHandle?.onStart(opts.category);
  const result = launchDetachedSyncInner(opts);
  statsHandle?.onEnd(opts.category, Date.now() - t0);
  return result;
}

function launchDetachedSyncInner(opts: LaunchOpts): LaunchResult {
  let child;
  try {
    child = spawn(opts.bin, opts.args ?? [], {
      cwd: opts.cwd,
      env: opts.env,
      detached: true,
      stdio: "ignore",
    });
  } catch (err) {
    // spawn throws synchronously on some failure modes (invalid options,
    // EACCES on some platforms).
    return {
      ok: false,
      reason: "spawn-error",
      stdout: "",
      stderr: "",
      exitCode: null,
      signal: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  // [LAW:no-silent-fallbacks] spawn() with ENOENT (e.g. missing binary) does
  // *not* throw — it returns a ChildProcess with pid=undefined that emits
  // 'error' asynchronously. Two things matter here:
  //   1. The 'error' must have a listener or Node crashes the process.
  //   2. The synchronous return must reflect that the spawn failed.
  // We attach a no-op listener and use the synchronously-observable absence
  // of a pid as the spawn-failure signal.
  child.once("error", () => {});
  if (child.pid === undefined) {
    return {
      ok: false,
      reason: "spawn-error",
      stdout: "",
      stderr: "",
      exitCode: null,
      signal: null,
      error: `spawn(${opts.bin}): no pid (binary not found or unexecutable)`,
    };
  }
  child.unref();
  return { ok: true, stdout: "", stderr: "", exitCode: null };
}

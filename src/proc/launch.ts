// [LAW:single-enforcer] Every subprocess in the Node runtime goes through this one
// boundary. [LAW:types-are-the-program] Lifetime is the OPERATION, never a flag: the
// waited pair reaps before the caller resumes, `launchDetachedSync` is the one orphan.

import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess, StdioOptions } from "node:child_process";

import type { LaunchStatsHandle } from "./stats-handle";

// [LAW:no-mode-explosion] Closed list: a new spawn site must add its category here.
export const LAUNCH_CATEGORIES = [
  "git",
  "forge",
  "user-shell",
  "tmux",
  "click.pbcopy",
  "click.open",
  "doctor.tmux",
  "install.plutil",
  "install.osacompile",
  "install.lsregister",
  "install.pbcopy",
  "install.open",
  "daemon-spawn",
  "process-fingerprint",
  "update.apply",
] as const;

export type LaunchCategory = (typeof LAUNCH_CATEGORIES)[number];

// [LAW:single-enforcer] Armed on ATTEMPT, so a broken binary cannot be retry-looped.
const RATE_LIMITS: Partial<Record<LaunchCategory, number>> = {
  "click.pbcopy": 1000,
  "click.open": 1000,
  "doctor.tmux": 1000,
};

// [LAW:one-source-of-truth] A rate-limit rejection does NOT record: no spawn happened.
const lastStartAt = new Map<LaunchCategory, number>();

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

export function __resetRateLimitsForTest(): void {
  lastStartAt.clear();
}

// [LAW:one-source-of-truth] Resolve the child's env HERE. Passing `undefined` lets
// node read the host env — a second clock that diverges under Jest's per-file copy.
function childEnv(opts: LaunchOpts): NodeJS.ProcessEnv {
  return opts.env ?? process.env;
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

// [LAW:types-are-the-program] Cancellation exists only where a frame is alive to see it.
export interface AsyncLaunchOpts extends LaunchOpts {
  signal?: AbortSignal;
}

export type LaunchResult =
  | { ok: true; stdout: string; stderr: string; exitCode: number | null }
  | {
      ok: false;
      // [LAW:one-type-per-behavior] "signal" is any killer OTHER than our timeout or
      // abort; "rate-limited" launched no child; "signal-refused" leaves it unreaped.
      reason:
        | "timeout"
        | "aborted"
        | "signal"
        | "spawn-error"
        | "non-zero"
        | "rate-limited"
        | "signal-refused";
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

export function setLaunchStats(handle: LaunchStatsHandle | null): void {
  statsHandle = handle;
}

// [LAW:types-are-the-program] SIGKILL after this grace keeps "reaped before the
// caller resumes" true for a child that ignores SIGTERM.
const TIMEOUT_KILL_GRACE_MS = 250;

type Terminated = "timeout" | "aborted";

// [LAW:no-silent-failure] exception: ESRCH is the group already gone, the state this
// call exists to reach; any other failure propagates.
function signalGroup(pid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(-pid, sig);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
  }
}

export async function launch(opts: AsyncLaunchOpts): Promise<LaunchResult> {
  if (opts.signal?.aborted) {
    return {
      ok: false,
      reason: "aborted",
      stdout: "",
      stderr: "",
      exitCode: null,
      signal: null,
    };
  }
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
        env: childEnv(opts),
        stdio: ["pipe", "pipe", "pipe"],
        detached: true,
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
    // [LAW:dataflow-not-control-flow] The OS never says WHY a child was signalled, so
    // without carrying this an OOM kill or a tty SIGINT would read as "timeout".
    let terminated: Terminated | null = null;

    const onAbort = () => terminate("aborted");

    const finish = (deliver: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      opts.signal?.removeEventListener("abort", onAbort);
      statsHandle?.onEnd(opts.category, Date.now() - t0);
      deliver();
    };
    const settle = (r: LaunchResult) => finish(() => resolve(r));
    // [LAW:one-type-per-behavior] A group that cannot be signalled (EPERM) is this
    // run's RESULT, never a throw out of a timer, so the primitive stays total.
    const signal = (pid: number, sig: NodeJS.Signals) => {
      try {
        signalGroup(pid, sig);
      } catch (err) {
        settle({
          ok: false,
          reason: "signal-refused",
          stdout,
          stderr,
          exitCode: null,
          signal: null,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    };

    // [LAW:types-are-the-program] Do NOT settle here: let `close` resolve once the
    // child is gone. `child.pid` is undefined after an async spawn failure, and kill()
    // would then signal the wrong target. [LAW:dataflow-not-control-flow]
    const terminate = (cause: Terminated) => {
      terminated = cause;
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      const pid = child.pid;
      if (pid !== undefined) {
        // Escalation armed first, so a refused SIGTERM's cleanup clears it.
        killTimer = setTimeout(
          () => signal(pid, "SIGKILL"),
          TIMEOUT_KILL_GRACE_MS,
        );
        signal(pid, "SIGTERM");
      }
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
      if (terminated !== null) {
        settle({
          ok: false,
          reason: terminated,
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
      timer = setTimeout(() => terminate("timeout"), opts.timeoutMs);
    }
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    if (opts.stdinInput !== undefined && child.stdin) {
      child.stdin.end(opts.stdinInput);
    } else if (child.stdin) {
      child.stdin.end();
    }
  });
}

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
      env: childEnv(opts),
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

    // [LAW:dataflow-not-control-flow] "timeout" is only attributable when a timeout
    // was requested; any other signal came from elsewhere (OOM killer, tty ctrl-C).
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

// [LAW:single-enforcer] The one orphan operation, deliberately outliving its caller.
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
      env: childEnv(opts),
      detached: true,
      stdio: "ignore",
    });
  } catch (err) {
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
  // [LAW:no-silent-fallbacks] spawn() with ENOENT does NOT throw: an unlistened
  // 'error' crashes the process, and the absent pid is the observable failure.
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

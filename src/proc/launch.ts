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
  "terminal-width",
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

export interface LaunchOpts {
  bin: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  stdinInput?: string | Buffer;
  // Detached + unref'd. The launcher does not wait or read stdio; caller
  // gets `{ ok: true, exitCode: null, stdout: "", stderr: "" }` if the
  // spawn succeeded (the OS now owns the process).
  detached?: boolean;
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
      // failure before the child started.
      reason: "timeout" | "signal" | "spawn-error" | "non-zero";
      stdout: string;
      stderr: string;
      exitCode: number | null;
      signal: NodeJS.Signals | null;
      error?: string;
    };

let statsHandle: LaunchStatsHandle | null = null;

// Install the stats handle once, at daemon startup. Other runtimes (Node
// fallback, install path) leave it null and pay no metering cost.
export function setLaunchStats(handle: LaunchStatsHandle | null): void {
  statsHandle = handle;
}

export async function launch(opts: LaunchOpts): Promise<LaunchResult> {
  const t0 = Date.now();
  statsHandle?.onStart(opts.category);

  if (opts.detached) {
    // [LAW:one-type-per-behavior] Detached launches are synchronous in nature
    // (fire-and-forget, no stdio to drain). Callers that need the typed
    // outcome should call launchDetachedSync directly. We keep this branch as
    // a thin async wrapper for parity but it is no richer than the sync form.
    const result = launchDetachedSyncInner(opts);
    statsHandle?.onEnd(opts.category, Date.now() - t0);
    return result;
  }

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
      if (code === 0) {
        settle({ ok: true, stdout, stderr, exitCode: code });
        return;
      }
      const reason: "timeout" | "signal" | "non-zero" = signal
        ? timedOut
          ? "timeout"
          : "signal"
        : "non-zero";
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
        // Guard against killing a child that has already settled (e.g. a
        // very fast `/bin/true` that exited before the timer was scheduled).
        // settle()'s `settled` flag is the single source of truth.
        if (!settled) child.kill("SIGTERM");
        settle({
          ok: false,
          reason: "timeout",
          stdout,
          stderr,
          exitCode: null,
          signal: "SIGTERM",
        });
      }, opts.timeoutMs);
    }

    if (opts.stdinInput !== undefined && child.stdin) {
      child.stdin.end(opts.stdinInput);
    } else if (child.stdin) {
      child.stdin.end();
    }
  });
}

// Sync variant. Only for callers that genuinely cannot be async — currently
// just `src/utils/terminal-width.ts`, called from the synchronous render-path.
// kz8.4 deletes those sites; once gone, this function can go too.
export function launchSync(opts: LaunchOpts): LaunchResult {
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

// [LAW:single-enforcer] The synchronous typed entrypoint for detached
// (fire-and-forget) launches. Use this instead of `void launch({detached:true})`
// — that pattern discards the spawn outcome and reports success on failure.
// This function returns the typed result synchronously, and also meters
// through the stats handle so detached spawns show up in daemon-stats.
export function launchDetachedSync(opts: LaunchOpts): LaunchResult {
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

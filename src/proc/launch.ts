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
// reaped before the caller resumes, so it cannot outlive its frame (the one
// exception is a group the launcher was refused to signal: `signal-refused`).
// `launchDetachedSync` is the *orphan*: it detaches and unrefs, deliberately
// outliving its caller — the daemon-handoff escape hatch, used only by the
// daemon-acquisition path. There is no `detached: boolean` flag on `LaunchOpts`
// ([LAW:no-mode-explosion]); the two lifetimes are two functions with two
// return contracts, so an unwaited helper that survives a render frame is
// unrepresentable here rather than forbidden by convention. Whether a waited
// child also dies with its launcher's death is not a return contract, so it is
// a value on the request (`outlivesLauncher`), not a third function.
//
// A `launch` child leads its own process group, so terminating it (the timeout,
// or the caller's `signal`) reaches everything it spawned: `sh -c "sleep 5;
// echo x"` keeps `sh` as the parent and `sleep` as a grandchild, and signalling
// `sh` alone would orphan the `sleep`. The price is that a terminal's SIGINT
// no longer reaches a foreground CLI's children through the tty, and nothing
// aimed at the launcher's own group reaches them either: a child ends by its
// timeout, its caller's `signal`, its own exit, or the lifeline (below) when
// the process that launched it ends, unless it outlives its launcher.

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import type { Socket } from "node:net";
import { types } from "node:util";
import type { ChildProcess, StdioOptions } from "node:child_process";

import type { DaemonLogger } from "../utils/logger";
import type { LaunchStatsHandle } from "./stats-handle";

// [LAW:no-silent-failure] A spawn whose `cwd` is gone fails with the SAME
// errno as a missing binary — Node words it `spawn /bin/sh ENOENT`, blaming
// the shell. The one place a spawn failure becomes text names the directory
// instead when that is what is missing (a removed worktree the session is
// still rendering from). Measured only on the failure path.
function spawnErrorText(err: unknown, cwd: string | undefined): string {
  // isNativeError, not instanceof: the realm-proof test (Node's own errors
  // fail `instanceof Error` under a vm context such as Jest's).
  if (!types.isNativeError(err)) return String(err);
  const code = (err as NodeJS.ErrnoException).code;
  return code === "ENOENT" && cwd !== undefined && !existsSync(cwd)
    ? `working directory does not exist: ${cwd}`
    : err.message;
}

// Closed list of subprocess categories. Adding a new spawn site requires
// adding its category here, which forces a code review of the new launch
// pattern. [LAW:no-mode-explosion]: no per-site escape hatch.
export const LAUNCH_CATEGORIES = [
  "git",
  // Forge CLIs (gh / glab) for the PR/MR lookup. A network-bound spawn,
  // separate from "git" so daemon-stats attributes it independently and a
  // future rate limit can target it without throttling local git.
  "forge",
  "user-shell",
  // A pane's session name (src/segments/tmux.ts): a pane's first read, then
  // once per NAME_PERIOD_MS (30 s) while a render-cache entry holds it — so
  // bounded by held panes × one per period, and not rate-limited.
  "tmux",
  "click.pbcopy",
  "click.open",
  // A `run` action's program (src/daemon/runs.ts), on a click: one child per
  // click, async, each with its own timeout. Not rate-limited, so a second
  // click on a stepper runs a second move rather than being refused.
  "click.run",
  // The doctor's tmux query — click-driven like the verbs above, and its own
  // category so the cap never reaches the tmux SEGMENT's cache-driven spawns.
  "doctor.tmux",
  // The doctor's font question (src/doctor/font-edge.ts): CoreText through
  // osascript, or fc-list — one spawn per run, on the click like the tmux one.
  "doctor.font",
  // Whether the tmux client the bar is drawn through came over a remote login
  // (src/doctor/edge.ts): one `ps` per run.
  "doctor.process",
  // Every cc-candybar daemon this user runs (src/doctor/edge.ts): one `ps`
  // per run, metered apart from the remote-login one.
  "doctor.daemons",
  // A forge CLI's own local word on whether it is installed and logged in
  // (`gh auth token`), asked on every doctor click — so, like
  // `doctor.daemons`, no rate limit.
  "doctor.forge",
  // `cc-candybar doctor`'s URL-handler probe (src/doctor/handler-probe.ts), in
  // the CLI's own process: the link it opens, and — only for a link that did
  // not come back — the Launch Services lookup and the applet's script.
  "doctor.open",
  "doctor.launch-services",
  "doctor.osadecompile",
  // Typing a slash command into a session's Claude Code pane
  // (src/claude-input/edge.ts): `read` captures the pane to decide whether it
  // is safe, `type` sends the keys.
  "claude-input.read",
  "claude-input.type",
  "install.plutil",
  "install.osacompile",
  "install.lsregister",
  "install.pbcopy",
  "install.open",
  "daemon-spawn",
  // Process start-time fingerprint (`ps -o lstart=`) for socket-lease liveness
  // (process-fingerprint.ts). Spawned only at daemon start + EADDRINUSE
  // arbitration — never per render — so it needs no rate limit.
  "process-fingerprint",
  // The memory backstop's post-mortem memory attribution (memory-report.ts):
  // `footprint`/`vmmap` on the death path, once per breach, never per render.
  "limits.memory-report",
  // The memory backstop's reading of what macOS charges the daemon
  // (`footprint --noCategories`, memory-report.ts chargeProbe): one a minute,
  // each scheduled only once the last has answered, so no rate limit.
  "limits.charge",
  // The update notice's act (`pnpm build` in a checkout, `pnpm dlx … install`
  // over a published install). One click, one long-running child; the
  // notice's own running/failed state serialises clicks, so no rate limit.
  "update.apply",
  // `cc-candybar plugin install`'s clone of a plugin's repo
  // (src/plugin-install.ts): three git calls per install, in the CLI's own
  // process, apart from the daemon's per-render "git".
  "plugin.git",
  // Which panes each watched session's tmux server shows (pane-visibility.ts):
  // one query per server a second, paced by its own clock, so no rate limit.
  "frames.visibility",
  // `cc-candybar bar-pane` (src/bar-pane), in its own process: where the
  // session's pane sits, twice a second, and the pane's height when the frame's
  // changes. Never in the daemon.
  "bar-pane.tmux",
  // What a lane's toggle starts (src/daemon/lane-edge.ts), on the click: the
  // bar pane's tmux calls and the typing of the restart into a shell; the
  // `claude plugin` commands that install the band mod; and the process table
  // a restart under cc-attach reads the session's Claude Code from. Clicks a
  // person makes, each one a handful of spawns, so no rate limit.
  "lane.tmux",
  "lane.claude",
  "lane.process",
  // The launcher's lifeline (below): one per process that launches, and one
  // more each time a lost one is replaced. Metered for its spawn alone, so
  // every replacement counts in daemon-stats.
  "lifeline",
  // The tmux status line lane (src/daemon/tmux-status.ts): the daemon's own
  // writes of a shown bar into its tmux status line, one per frame pushed
  // while the pane is the one a status line shows, and the reads and writes
  // that lay the status line out and put it back. Paced by the frames, so no
  // rate limit.
  "tmux-status",
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
  // A synchronous spawn that holds the daemon's loop for up to its 2 s timeout.
  "doctor.tmux": 1000,
  "doctor.font": 1000,
  "doctor.process": 1000,
  // `doctor.daemons` has none: it runs on EVERY doctor click (run, [fix],
  // mark), so a cap would refuse 🩺 clicked right after [fix]; it is one
  // `ps` over this user's processes.
  // A double-click is refused rather than typing and submitting its command
  // twice. Daemon-wide, so two sessions typing in one second collide. Only
  // the typing is limited: a click the pane refused typed
  // nothing, so clicking again once the dialog is closed goes through.
  "claude-input.type": 1000,
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

// [LAW:one-source-of-truth] The environment a child inherits is THIS module's
// `process.env`, resolved here for every spawn site. Passing `undefined` lets
// node read the host process's environment directly, which is a second clock:
// under a realm boundary (Jest's sandbox copies `process.env` per test file)
// the two diverge, and a PATH the test set for a `shell` source never reached
// the shell it spawned (brandon-custom-segments-g5z.3's doc stubs ran as 127).
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

// [LAW:types-are-the-program] Cancellation exists only where a frame is
// alive to observe it: `launch`. A sync launcher cannot read a signal while
// it blocks, so the option is unrepresentable there rather than ignored.
export interface AsyncLaunchOpts extends LaunchOpts {
  // The caller's cancellation: aborting it terminates the child (and its
  // group); the result is `reason: "aborted"` once the child is reaped.
  signal?: AbortSignal;
  // [LAW:no-mode-explosion] A child whose work is a write that killing it
  // would tear (the update act rewriting the bundle the daemon runs from) is
  // never given to the lifeline, so its launcher's death leaves it to finish.
  // Cap: that kind of child alone. Every child whose answer a launcher waits
  // on dies with it.
  outlivesLauncher?: true;
}

export type LaunchResult =
  | { ok: true; stdout: string; stderr: string; exitCode: number | null }
  | {
      ok: false;
      // [LAW:one-type-per-behavior] Distinct termination causes get distinct
      // tags so callers + stats can attribute correctly. "timeout" means the
      // local timer fired; "aborted" means the caller's `signal` fired;
      // "signal" means the OS or external killer ended the child for some
      // other reason (SIGKILL/SIGINT/SIGPIPE/SIGHUP/...); "non-zero" is a
      // clean exit with a non-zero code; "spawn-error" is a failure before
      // the child started; "rate-limited" means the primitive refused to
      // spawn because the per-category minimum interval was not yet elapsed
      // — no child process was launched. "signal-refused" means the OS
      // refused the termination signal (EPERM: the child changed its real
      // uid), so the child is NOT reaped; `error` carries the errno.
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

// Where the lifeline's changes are said. The daemon installs its log; any
// other process (the CLI, bar-pane, a test) says them on stderr.
let launchLog: DaemonLogger = (_level, msg) => process.emitWarning(msg);

export function setLaunchLog(log: DaemonLogger): void {
  launchLog = log;
}

// --- the lifeline ---
//
// [LAW:types-are-the-program] "A waited child cannot outlive its frame" holds
// when the frame is the whole process. Everything else that ends a child runs
// inside the launcher, and a SIGKILL'd launcher runs nothing, so the end lives
// in a second process that learns of the death from the kernel: when a process
// ends, however it ends, the kernel closes its fds, and the lifeline reads EOF
// on the pipe the launcher held. It then signals every group still registered
// with the timeout's own escalation, SIGTERM and after the grace SIGKILL.
//
// `kill -TERM -<pgid>` is the one spelling every /bin/sh takes: dash rejects
// `kill -TERM -- -<pgid>`, and `kill -s TERM -<pgid>` fails in every one.
// [LAW:no-silent-failure] exception: kill's stderr goes nowhere, because a
// group that ended on its own (ESRCH) is the state this exists to reach, and
// the launcher it would report to is gone.
const LIFELINE_PROGRAM =
  `$1 == "+" { live[$2] = 1; next } ` +
  `$1 == "-" { delete live[$2]; next } ` +
  `END { for (g in live) groups = groups " -" g; ` +
  `if (groups != "") system("kill -TERM" groups " 2>/dev/null; ` +
  `sleep ${TIMEOUT_KILL_GRACE_MS / 1000}; kill -KILL" groups " 2>/dev/null") }`;

// [LAW:one-source-of-truth] The groups this process has in flight. The
// lifeline mirrors the set, and a new lifeline is given the whole set, so a
// lost one costs only the moments until the next launch replaces it.
const liveGroups = new Set<number>();

// The lifeline's process and the write end of its pipe, which only this
// process holds.
interface Lifeline {
  readonly process: ChildProcess;
  readonly pipe: Socket;
}
let lifeline: Lifeline | null = null;

// [LAW:one-source-of-truth] Why the groups this process has in flight are not
// guarded now: what ended its last lifeline, or kept one from starting. Null
// while a lifeline runs, or before one is needed. The log says each change,
// and the daemon shows it as a standing warning.
let fault: string | null = null;

function setFault(next: string | null): void {
  if (next === fault) return;
  fault = next;
  launchLog(
    next === null ? "info" : "warn",
    next === null
      ? "launch lifeline running again"
      : `launch lifeline ${next}; the next launch starts another`,
  );
}

function lose(line: ChildProcess, reason: string): void {
  if (lifeline?.process !== line) return;
  lifeline = null;
  setFault(reason);
}

export interface LifelineWarning {
  readonly kind: "lifeline";
  readonly message: string;
}

export function lifelineWarnings(): LifelineWarning[] {
  return fault === null
    ? []
    : [
        {
          kind: "lifeline",
          message: `programs the daemon runs would outlive it if it died: its launch lifeline ${fault}, and the next launch starts another`,
        },
      ];
}

// Leads its own group, so nothing aimed at the launcher's group reaches it, and
// is unref'd with its pipe, so it never holds a process open. `awk` is found
// on the launcher's PATH, as every launched program is: where a machine keeps
// it is the machine's fact (NixOS has no /usr/bin/awk).
function spawnLifeline(): Lifeline | null {
  statsHandle?.onStart("lifeline");
  const t0 = Date.now();
  let line: ChildProcess;
  try {
    line = spawn("awk", [LIFELINE_PROGRAM], {
      stdio: ["pipe", "ignore", "ignore"],
      detached: true,
    });
  } catch (err) {
    statsHandle?.onEnd("lifeline", Date.now() - t0);
    setFault(`did not start: ${spawnErrorText(err, undefined)}`);
    return null;
  }
  statsHandle?.onEnd("lifeline", Date.now() - t0);
  // stdio[0] is "pipe", so Node hands back a socket.
  const pipe = line.stdin as Socket;
  line.once("spawn", () => setFault(null));
  line.once("error", (err) => lose(line, `failed: ${err.message}`));
  line.once("exit", (code, sig) => lose(line, `exited ${sig ?? code}`));
  pipe.on("error", (err) => lose(line, `pipe failed: ${err.message}`));
  line.unref();
  pipe.unref();
  for (const group of liveGroups) pipe.write(`+ ${group}\n`);
  return { process: line, pipe };
}

// A new lifeline is handed the whole set, this group included; the line after
// it is then a repeat the lifeline's set absorbs.
function guard(group: number): void {
  liveGroups.add(group);
  lifeline ??= spawnLifeline();
  lifeline?.pipe.write(`+ ${group}\n`);
}

function unguard(group: number): void {
  liveGroups.delete(group);
  lifeline?.pipe.write(`- ${group}\n`);
}

// Exposed for tests only: ends the lifeline's pipe — the EOF the launcher's
// death gives it — and names its pid. A cut lifeline is lost at once, so the
// test's next launch starts another rather than writing to a closed pipe.
export function __lifelineForTest(): { pid: number | undefined; cut(): void } {
  const line = lifeline;
  return {
    pid: line?.process.pid,
    cut: () => {
      line?.pipe.end();
      if (line) lose(line.process, "cut by a test");
    },
  };
}

// A termination the launcher itself initiated — carried as data because the
// OS reports only the signal, never why it was sent.
type Terminated = "timeout" | "aborted";

// Signal a waited child's whole process group (it leads its own; see the
// header). [LAW:no-silent-failure] exception: ESRCH is the group already gone
// — the state this call exists to reach; any other failure propagates.
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
        error: spawnErrorText(err, opts.cwd),
      });
      return;
    }
    // A child whose spawn failed asynchronously (ENOENT) has no pid, and no
    // group to guard: its `error` event settles it. Nor does a child that
    // outlives its launcher.
    const group = opts.outlivesLauncher ? undefined : child.pid;
    if (group !== undefined) guard(group);

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    let killTimer: NodeJS.Timeout | null = null;
    // [LAW:dataflow-not-control-flow] Whether the close was caused by *our*
    // termination — and which — is data we have to carry. The OS doesn't tell
    // us why a child was signalled — without it, SIGKILL from the OOM killer,
    // SIGINT propagated through the tty, SIGPIPE on a closed pipe, etc. would
    // all be misreported as "timeout" or "aborted".
    let terminated: Terminated | null = null;

    const onAbort = () => terminate("aborted");

    const finish = (deliver: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      opts.signal?.removeEventListener("abort", onAbort);
      if (group !== undefined) unguard(group);
      statsHandle?.onEnd(opts.category, Date.now() - t0);
      deliver();
    };
    const settle = (r: LaunchResult) => finish(() => resolve(r));
    // [LAW:one-type-per-behavior] A group that cannot be signalled (EPERM:
    // the child changed its real uid) is this run's result like any other
    // failure — a `LaunchResult` arm, never a rejection or a throw out of a
    // timer callback, so the single-enforcer primitive stays total.
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

    // [LAW:types-are-the-program] Do NOT settle here. We signal and let the
    // `close` handler resolve once the child is actually gone, so the promise
    // never resolves while the child is still alive. SIGTERM first; SIGKILL
    // after a grace period if the child ignores it. One termination per
    // child: the other trigger is disarmed so the cause cannot be rewritten.
    //
    // [LAW:dataflow-not-control-flow] `child.pid` is undefined when the spawn
    // failed asynchronously (ENOENT) — there is no process to signal and the
    // `error` event settles that case. kill() on a pid-less child signals the
    // wrong target (verified: it can terminate the caller), so escalation is
    // gated on the pid actually existing.
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
        error: spawnErrorText(err, opts.cwd),
      });
    });

    child.on("close", (code, signal) => {
      // [LAW:types-are-the-program] We resolve here, on the *actual* exit —
      // including the termination paths. Once `terminated` is set the cause
      // is known, whichever signal (SIGTERM or the escalated SIGKILL) finally
      // ended the child.
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
        error: spawnErrorText(result.error, opts.cwd),
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
      error: spawnErrorText(err, opts.cwd),
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
      env: childEnv(opts),
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
      error: spawnErrorText(err, opts.cwd),
    };
  }
  // [LAW:no-silent-failure] spawn() with ENOENT (e.g. missing binary) does
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

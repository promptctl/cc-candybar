// [LAW:single-enforcer] Every subprocess in the Node runtime goes through one
// boundary. The primitive owns the import of `node:child_process`; every other
// module launches through a `Launcher` from here. The ESLint config (and the
// kz8.2 DoD grep) enforces this.
//
// [LAW:no-shared-mutable-globals] A launch carries its owner: everything a
// launch reads or leaves behind is held by the `Launcher` it went through, so a
// closed owner's work is refused by that owner however many others are running.
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
// daemon-acquisition path. `launchJobSync` is the *job*: it outlives its
// launcher too, but its output and its verdict are files it owns, so any
// process can read how it ended. There is no `detached: boolean` flag on
// `LaunchOpts` ([LAW:no-mode-explosion]); the three lifetimes are three
// functions with three return contracts, so an unwaited helper that survives a
// render frame is unrepresentable here rather than forbidden by convention.
//
// A `launch` child leads its own process group, so terminating it (the timeout,
// or the caller's `signal`) reaches everything it spawned: `sh -c "sleep 5;
// echo x"` keeps `sh` as the parent and `sleep` as a grandchild, and signalling
// `sh` alone would orphan the `sleep`. The price is that a terminal's SIGINT
// no longer reaches a foreground CLI's children through the tty, and nothing
// aimed at the launcher's own group reaches them either: a child ends by its
// timeout, its caller's `signal`, its own exit, or the lifeline (below) when
// the process that launched it ends.

import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  linkSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import type { Socket } from "node:net";
import { types } from "node:util";
import type { ChildProcess, StdioOptions } from "node:child_process";
import { setImmediate } from "node:timers";

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
  // (process-fingerprint.ts). Spawned only at daemon start, EADDRINUSE
  // arbitration, and once per update act a daemon reads (src/daemon/update-act.ts)
  // — never per render — so it needs no rate limit.
  "process-fingerprint",
  // The memory backstop's post-mortem memory attribution (memory-report.ts):
  // `footprint`/`vmmap` on the death path, once per breach, never per render.
  "limits.memory-report",
  // The memory backstop's reading of what macOS charges the daemon
  // (`footprint --noCategories`, memory-report.ts chargeProbe): one a minute,
  // each scheduled only once the last has answered, so no rate limit.
  "limits.charge",
  // The update notice's act (`pnpm build` in a checkout, `pnpm dlx … install`
  // over a published install), launched as a job. One click, one long-running
  // child; the act's record admits one at a time, so no rate limit.
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
  // The launcher's lifeline (below): one per launcher that launches, and one
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

// [LAW:dataflow-not-control-flow] The rate-limit decision is a pure function
// of (category, now, last-start, policy). Same code path every call; the
// result type carries which branch fired.
function checkRateLimit(
  lastStartAt: ReadonlyMap<LaunchCategory, number>,
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
}

export type LaunchResult =
  | { ok: true; stdout: string; stderr: string; exitCode: number | null }
  | {
      ok: false;
      // [LAW:one-type-per-behavior] Distinct termination causes get distinct
      // tags so callers + stats can attribute correctly. "timeout" means the
      // local timer fired; "aborted" means the caller's `signal` or the launch
      // scope's fired;
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

// A launch that started nothing. It always says why, so a form with no
// `LaunchResult` to return still carries the reason rather than guessing one.
type Refusal = Extract<LaunchResult, { ok: false }> & { error: string };

// [LAW:one-source-of-truth] Whoever aborted a signal said why when they did.
const refusedAsAborted = ({ reason }: AbortSignal): Refusal => ({
  ok: false,
  reason: "aborted",
  stdout: "",
  stderr: "",
  exitCode: null,
  signal: null,
  error: reason instanceof Error ? reason.message : String(reason),
});

function rateLimitedResult(
  category: LaunchCategory,
  minIntervalMs: number,
  sinceLastMs: number,
): Refusal {
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

// Who a launcher's launches belong to.
export interface LaunchScope {
  // Meters every launch into the owner's stats. Null pays no metering cost.
  readonly stats: LaunchStatsHandle | null;
  // Hears each change in why the lifeline is down (`fault`, below). The daemon
  // logs it and redraws its feeds, so its warning comes and goes on pushed
  // frames too.
  readonly observeLifeline: (fault: string | null) => void;
  // [LAW:single-enforcer] The one checkpoint for "nothing launches after the
  // owner closed": every spawn crosses this module, so a launch in flight is
  // terminated and a later one refused, whichever part of the owner's work it
  // was. An aborted scope stays closed: nothing replaces it.
  readonly signal: AbortSignal;
}

// [LAW:one-source-of-truth] Everything one owner's launches read and leave
// behind. A launcher is this and the functions over it, so no two owners can
// see each other's limits, children or lifeline.
interface LaunchState {
  readonly scope: LaunchScope;
  // Last-attempt timestamp per category: the data the rate-limit decision
  // reads. Recorded for every attempted spawn (success or spawn-error);
  // rate-limit rejections do NOT update this, because no spawn was attempted.
  readonly lastStartAt: Map<LaunchCategory, number>;
  // What ends each launch in flight, on the scope's abort.
  // [LAW:no-silent-failure] One listener, on a signal as long-lived as its
  // owner: `AbortSignal.any` over it grows the heap launch by launch on Node 20
  // and 24, and a listener per launch warns of a leak past ten in flight on 20
  // and 22.
  readonly inFlight: Set<() => void>;
  // [LAW:one-source-of-truth] The groups this launcher has in flight. The
  // lifeline mirrors the set, and a new lifeline is given the whole set, so a
  // lost one costs only the moments until the next launch replaces it.
  readonly liveGroups: Set<number>;
  // The lifeline's process and the write end of its pipe, which only this
  // process holds.
  lifeline: Lifeline | null;
  // [LAW:one-source-of-truth] Why the groups in flight are not guarded now:
  // what ended the last lifeline, or kept one from starting. Null while a
  // lifeline runs, or before one is needed. Its observer hears each change, and
  // the daemon shows it as a standing warning.
  fault: string | null;
  // What has not ended: each launch in flight and each lifeline.
  readonly ending: Set<Promise<unknown>>;
  // [LAW:no-silent-failure] Launches the OS would not let this launcher end,
  // while their children live: a result was delivered, and they still run.
  readonly unreaped: Map<ChildProcess, LaunchCategory>;
}

// [LAW:no-ambient-temporal-coupling] `ending` is the one record of whether what
// a launcher started has ended.
function track<T>(state: LaunchState, work: Promise<T>): Promise<T> {
  const entry = work.finally(() => state.ending.delete(entry));
  state.ending.add(entry);
  return entry;
}

// The one gate each launch form crosses: closed, aborted by its caller, or
// inside its category's interval, it answers the refusal and no child starts.
// Admitted, the attempt is on record. [LAW:nothing-unseen] A refusal is metered,
// so a launch that did nothing reads apart from one nobody tried.
function admit(
  state: LaunchState,
  category: LaunchCategory,
  signal?: AbortSignal,
): Refusal | null {
  const refusal = refusalOf(state, category, signal);
  if (refusal !== null) {
    state.scope.stats?.onRefused(category);
    return refusal;
  }
  state.lastStartAt.set(category, Date.now());
  return null;
}

function refusalOf(
  state: LaunchState,
  category: LaunchCategory,
  signal: AbortSignal | undefined,
): Refusal | null {
  if (state.scope.signal.aborted) return refusedAsAborted(state.scope.signal);
  if (signal?.aborted) return refusedAsAborted(signal);
  const gate = checkRateLimit(state.lastStartAt, category);
  return gate.allowed
    ? null
    : rateLimitedResult(category, gate.minIntervalMs, gate.sinceLastMs);
}

// [LAW:types-are-the-program] Grace between SIGTERM and SIGKILL on the timeout
// path. The lifetime invariant ("waited — child reaped before the caller
// resumes") requires that a child which ignores SIGTERM is still gone before we
// resolve. SIGTERM lets well-behaved children flush/clean up; SIGKILL is the
// backstop so the promise cannot resolve while the child is still alive.
const TIMEOUT_KILL_GRACE_MS = 250;

// The OS has no event for a process group's end, so a launch whose child has
// ended samples for it.
const GROUP_END_POLL_MIN_MS = 25;
const GROUP_END_POLL_MAX_MS = 1000;

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

// The lifeline's process and the write end of its pipe, which only this
// process holds.
interface Lifeline {
  readonly process: ChildProcess;
  readonly pipe: Socket;
}

function setFault(state: LaunchState, next: string | null): void {
  if (next === state.fault) return;
  state.fault = next;
  state.scope.observeLifeline(next);
}

function lose(state: LaunchState, line: ChildProcess, reason: string): void {
  if (state.lifeline?.process !== line) return;
  state.lifeline = null;
  // `settled` waits on this end too.
  line.ref();
  setFault(state, reason);
}

export interface LifelineWarning {
  readonly kind: "lifeline";
  readonly message: string;
}

function lifelineWarnings(state: LaunchState): LifelineWarning[] {
  return state.fault === null
    ? []
    : [
        {
          kind: "lifeline",
          message: `programs launched now would outlive their launcher if it died: its launch lifeline ${state.fault}, and the next launch starts another`,
        },
      ];
}

// Leads its own group, so nothing aimed at the launcher's group reaches it, and
// is unref'd with its pipe, so it holds a process open only once it is ending.
// `awk` is found
// on the launcher's PATH, as every launched program is: where a machine keeps
// it is the machine's fact (NixOS has no /usr/bin/awk).
function spawnLifeline(state: LaunchState): Lifeline | null {
  const { stats } = state.scope;
  stats?.onStart("lifeline");
  const t0 = Date.now();
  let line: ChildProcess;
  try {
    line = spawn("awk", [LIFELINE_PROGRAM], {
      stdio: ["pipe", "ignore", "ignore"],
      detached: true,
    });
  } catch (err) {
    stats?.onEnd("lifeline", Date.now() - t0);
    setFault(state, `did not start: ${spawnErrorText(err, undefined)}`);
    return null;
  }
  stats?.onEnd("lifeline", Date.now() - t0);
  // stdio[0] is "pipe", so Node hands back a socket.
  const pipe = line.stdin as Socket;
  line.once("spawn", () => {
    if (state.lifeline?.process === line) setFault(state, null);
  });
  line.once("error", (err) => lose(state, line, `failed: ${err.message}`));
  line.once("exit", (code, sig) => lose(state, line, `exited ${sig ?? code}`));
  pipe.on("error", (err) => lose(state, line, `pipe failed: ${err.message}`));
  void track(state, new Promise((closed) => line.once("close", closed)));
  line.unref();
  pipe.unref();
  for (const group of state.liveGroups) pipe.write(`+ ${group}\n`);
  return { process: line, pipe };
}

// A new lifeline is handed the whole set, this group included; the line after
// it is then a repeat the lifeline's set absorbs.
function guard(state: LaunchState, group: number): void {
  state.liveGroups.add(group);
  state.lifeline ??= spawnLifeline(state);
  state.lifeline?.pipe.write(`+ ${group}\n`);
}

function unguard(state: LaunchState, group: number): void {
  state.liveGroups.delete(group);
  state.lifeline?.pipe.write(`- ${group}\n`);
}

// A closed owner's lifeline goes with it: the EOF a dying launcher gives it, on
// purpose, so no fault is recorded. Nothing launches after the abort that runs
// this, so nothing starts another. It holds the loop from here: `settled` waits
// on its end, and an unref'd end never comes in a process with nothing else open.
function endLifeline(state: LaunchState): void {
  const line = state.lifeline;
  state.lifeline = null;
  line?.process.ref();
  line?.pipe.end();
}

// A termination the launcher itself initiated — carried as data because the
// OS reports only the signal, never why it was sent.
type Terminated = "timeout" | "aborted";

// Signal a waited child's whole process group (it leads its own; see the
// header). [LAW:no-silent-failure] exception: ESRCH is the group already gone
// — the state this call exists to reach; any other failure propagates, but for
// a group's EPERM that its leader does not back.
function signalGroup(pid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(-pid, sig);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ESRCH" && !(code === "EPERM" && !leaderRefuses(pid))) {
      throw err;
    }
  }
}

// Darwin answers EPERM for a group with nothing left to signal: its members
// are zombies, or still in their exit teardown. That is the same answer as a
// refusal, so the leader tells them apart: only one that changed its real uid
// refuses signal 0. An ended leader answers it as a zombie, or is gone.
function leaderRefuses(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function launchWaited(
  state: LaunchState,
  opts: AsyncLaunchOpts,
): Promise<LaunchResult> {
  const { stats } = state.scope;
  const refused = admit(state, opts.category, opts.signal);
  if (refused !== null) return refused;
  const t0 = Date.now();
  stats?.onStart(opts.category);

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
      stats?.onEnd(opts.category, Date.now() - t0);
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
    // group to guard: its `error` event settles it.
    const group = child.pid;
    if (group !== undefined) guard(state, group);
    const exited = new Promise((end) => child.once("exit", end));

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    let killTimer: NodeJS.Timeout | null = null;
    let groupEndTimer: NodeJS.Timeout | null = null;
    // [LAW:dataflow-not-control-flow] Whether the close was caused by *our*
    // termination — and which — is data we have to carry. The OS doesn't tell
    // us why a child was signalled — without it, SIGKILL from the OOM killer,
    // SIGINT propagated through the tty, SIGPIPE on a closed pipe, etc. would
    // all be misreported as "timeout" or "aborted".
    let terminated: Terminated | null = null;

    const onAbort = () => terminate("aborted");
    const unlisten = () => {
      opts.signal?.removeEventListener("abort", onAbort);
      state.inFlight.delete(onAbort);
    };

    const finish = (deliver: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (groupEndTimer) clearTimeout(groupEndTimer);
      unlisten();
      if (group !== undefined) unguard(state, group);
      stats?.onEnd(opts.category, Date.now() - t0);
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
        state.unreaped.set(child, opts.category);
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

    // [LAW:no-ambient-temporal-coupling] Run a turn after an end is seen, once
    // what was written before it is read. Nothing of the launch is left, so it
    // concludes on the child's exit. A descendant that left the group keeps its
    // pipes, drained: a destroyed one would kill it with SIGPIPE at its next
    // write, for as long as the launcher lives to read them.
    const concludeWithGroup = () => {
      for (const pipe of [child.stdout, child.stderr]) {
        pipe?.removeAllListeners("data").resume();
        (pipe as Socket | null)?.unref();
      }
      conclude(child.exitCode, child.signalCode);
    };
    // While a member of the group lives the launch waits for it, guarded, so
    // SIGKILL still reaches it. The OS has no event for a group's end, so it is
    // polled, with exponential backoff.
    if (group !== undefined) {
      const awaitGroupEnd = (delayMs: number) => {
        if (settled) return;
        if (groupGone(group)) {
          setImmediate(concludeWithGroup);
          return;
        }
        groupEndTimer = setTimeout(
          () => awaitGroupEnd(Math.min(delayMs * 2, GROUP_END_POLL_MAX_MS)),
          delayMs,
        );
      };
      void exited.then(() =>
        setImmediate(() => awaitGroupEnd(GROUP_END_POLL_MIN_MS)),
      );
    }

    // [LAW:types-are-the-program] Do NOT settle here. We signal and let
    // `conclude` resolve once the child is actually gone, so the promise
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
      // A group that ended between polls has nothing left to signal, and its id
      // may no longer be the launch's. It did not time out; an abort still stands.
      const ended = child.exitCode !== null || child.signalCode !== null;
      if (ended && group !== undefined && groupGone(group)) {
        terminated = cause === "aborted" ? cause : null;
        setImmediate(concludeWithGroup);
        return;
      }
      terminated = cause;
      if (timer) clearTimeout(timer);
      unlisten();
      const pid = child.pid;
      if (pid !== undefined) {
        // Escalation armed first, so a refused SIGTERM's cleanup clears it.
        // Concluding here is not behind the group's end: a group holding an
        // unreaped zombie never reads as gone, and this is that launch's bound.
        killTimer = setTimeout(() => {
          signal(pid, "SIGKILL");
          void exited.then(() => setImmediate(concludeWithGroup));
        }, TIMEOUT_KILL_GRACE_MS);
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

    const conclude = (code: number | null, signal: NodeJS.Signals | null) => {
      state.unreaped.delete(child);
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
    };

    child.on("close", conclude);

    if (opts.timeoutMs && opts.timeoutMs > 0) {
      timer = setTimeout(() => terminate("timeout"), opts.timeoutMs);
    }
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    state.inFlight.add(onAbort);

    // [LAW:no-silent-failure] exception: a child may stop reading and still
    // succeed (`head -1`), so its exit is the verdict, and the failed write
    // says nothing that exit does not.
    child.stdin?.on("error", () => {});
    child.stdin?.end(opts.stdinInput);
  });
}

// Sync variant. For callers that genuinely cannot be async — the spawn
// outcome must be settled before the function returns.
function launchBlocking(state: LaunchState, opts: LaunchOpts): LaunchResult {
  const { stats } = state.scope;
  const refused = admit(state, opts.category);
  if (refused !== null) return refused;
  const t0 = Date.now();
  stats?.onStart(opts.category);

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

    stats?.onEnd(opts.category, Date.now() - t0);

    const stdout = typeof result.stdout === "string" ? result.stdout : "";
    const stderr = typeof result.stderr === "string" ? result.stderr : "";

    // Node sets `error` for ETIMEDOUT and ENOENT; distinguish by code.
    // [LAW:no-silent-failure] exception: EPIPE and ECONNRESET (macOS, a peer
    // mid-close) are input the child left unread; its exit stays the verdict,
    // as in `launch`.
    const code = (result.error as NodeJS.ErrnoException | undefined)?.code;
    if (result.error && code !== "EPIPE" && code !== "ECONNRESET") {
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

    // A real timeout returned above on ETIMEDOUT, so a signal here came from
    // somewhere else (OOM killer, ctrl-C through the tty group, etc.).
    const reason: "signal" | "non-zero" = result.signal ? "signal" : "non-zero";
    return {
      ok: false,
      reason,
      stdout,
      stderr,
      exitCode: result.status,
      signal: result.signal ?? null,
    };
  } catch (err) {
    stats?.onEnd(opts.category, Date.now() - t0);
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
function launchOrphan(state: LaunchState, opts: LaunchOpts): LaunchResult {
  const { stats } = state.scope;
  const refused = admit(state, opts.category);
  if (refused !== null) return refused;
  const t0 = Date.now();
  stats?.onStart(opts.category);
  const result = launchDetachedSyncInner(opts);
  stats?.onEnd(opts.category, Date.now() - t0);
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

// --- the job ---
//
// [LAW:types-are-the-program] A job outlives the process that launched it and
// still has an answer to "how did it end": its stdout, its stderr and its
// verdict are files, so a launcher that dies costs it nothing (no pipe leads
// back to the launcher for a write to fail on with SIGPIPE), and whoever reads
// the files afterwards learns the end. A `/bin/sh` wraps the program to write
// the verdict, because the program's parent is the one process that hears its
// exit, and that parent must outlive the launcher.
//
// The sh waits on a start gate: a line on stdin, from a pipe only the
// launcher holds. The launcher records the job first and then opens the gate,
// so a launcher that dies before recording it gives the sh EOF instead of a
// line, and the program never runs. Whatever a record says about a job, the
// program ran only if that record existed first.
//
// The verdict is claimed, never overwritten: each writer stages its own file
// and links it to the status path, and the link fails if the path exists. The
// first verdict wins, so a deadline that ends the job cannot overwrite an exit
// that landed first, nor an exit a deadline that landed first.

// [LAW:one-source-of-truth] How a job ended, and the one spelling of it on
// disk: the sh writes `exit <code>`, and an end the launcher imposes writes
// `timeout`.
export type JobEnd =
  | { readonly kind: "exit"; readonly code: number }
  | { readonly kind: "timeout" };

const formatJobEnd = (end: JobEnd): string =>
  end.kind === "exit" ? `exit ${end.code}` : "timeout";

// The positional args are `<stdout> <stderr> <status> <program> <args…>`, so
// nothing about the program is composed into the script.
const JOB_SCRIPT =
  `out=$1 err=$2 status=$3; shift 3; ` +
  `read go || exit 0; ` +
  `"$@" >"$out" 2>"$err" </dev/null; ` +
  `echo "exit $?" >"$status.$$" && ln "$status.$$" "$status"; ` +
  `rm -f "$status.$$"`;

export interface JobFiles {
  readonly stdout: string;
  readonly stderr: string;
  readonly status: string;
}

export type JobLaunch =
  | {
      readonly ok: true;
      // Leads the job's process group, as every launched child does.
      readonly pid: number;
      // Opens the start gate: the program runs.
      release(): void;
      // Closes the gate unopened: the sh exits, and the program never runs.
      withdraw(): void;
    }
  | { readonly ok: false; readonly error: string };

// [LAW:single-enforcer] The one launch with the job's lifetime. Detached, so
// it leads its own group, which nothing aimed at the launcher reaches; never
// guarded by the lifeline; unref'd, so it never holds the launcher open.
function launchJob(
  state: LaunchState,
  opts: LaunchOpts,
  files: JobFiles,
): JobLaunch {
  const { stats } = state.scope;
  const refused = admit(state, opts.category);
  if (refused !== null) return { ok: false, error: refused.error };
  const t0 = Date.now();
  stats?.onStart(opts.category);
  let child: ChildProcess;
  try {
    child = spawn(
      "/bin/sh",
      [
        "-c",
        JOB_SCRIPT,
        "sh",
        files.stdout,
        files.stderr,
        files.status,
        opts.bin,
        ...(opts.args ?? []),
      ],
      {
        cwd: opts.cwd,
        env: childEnv(opts),
        detached: true,
        stdio: ["pipe", "ignore", "ignore"],
      },
    );
  } catch (err) {
    stats?.onEnd(opts.category, Date.now() - t0);
    return { ok: false, error: spawnErrorText(err, opts.cwd) };
  }
  stats?.onEnd(opts.category, Date.now() - t0);
  // An async spawn failure has no pid; its `error` needs a listener or Node
  // crashes the launcher, and the missing pid already says it failed.
  child.once("error", () => {});
  const pid = child.pid;
  const gate = child.stdin as Socket;
  // [LAW:no-silent-failure] exception: a write to a sh that already died
  // fails EPIPE, and that death is said where every reader looks, in the job's
  // missing verdict, which reads as lost.
  gate.on("error", () => {});
  if (pid === undefined) {
    gate.destroy();
    return {
      ok: false,
      error: `spawn(/bin/sh): no pid (shell not found or unexecutable)`,
    };
  }
  child.unref();
  gate.unref();
  return {
    ok: true,
    pid,
    release: () => gate.end("go\n"),
    withdraw: () => gate.end(),
  };
}

// The job's verdict, or null while it has none. [LAW:no-silent-failure] A
// status this module did not write is an error, never an end.
export function readJobEnd(status: string): JobEnd | null {
  let text: string;
  try {
    text = readFileSync(status, "utf8").trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  const exit = /^exit (\d+)$/.exec(text);
  if (exit) return { kind: "exit", code: Number(exit[1]) };
  if (text === "timeout") return { kind: "timeout" };
  throw new Error(`${status}: not a job verdict: ${JSON.stringify(text)}`);
}

// Whether anything of the job's process group is still running. The group
// outlives its leader while the program runs, so a sh killed on its own does
// not read as an ended job. A job runs as its launcher's user, so a group the
// launcher may not signal (EPERM) is someone else's under a recycled id, or
// on darwin holds nothing left running; neither is the job running.
export function jobGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH" || code === "EPERM") return false;
    throw err;
  }
}

// Whether a group has no member left, zombies included. Unlike `jobGroupAlive`,
// EPERM is not an end here: it is also the answer for a live member that changed
// its uid, whose pipes a launch must keep reading. Signal 0 to a valid group has
// no other errors, so anything but ESRCH is that "not gone".
function groupGone(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ESRCH";
  }
}

// Ends a job's group with the timeout's own escalation, and gives it a verdict
// of the launcher's unless its own landed first: the first verdict stands, and
// a group that outlives its verdict (a child the program left) is ended all the
// same. True when the launcher's verdict is the one that stands. A status
// whose directory is gone belongs to a job whose files were removed once it
// had ended, so there is nothing left to end.
export function endJob(pid: number, status: string, end: JobEnd): boolean {
  const staged = `${status}.${process.pid}`;
  try {
    writeFileSync(staged, `${formatJobEnd(end)}\n`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
  let stands = true;
  try {
    linkSync(staged, status);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    stands = false;
  } finally {
    rmSync(staged, { force: true });
  }
  signalGroup(pid, "SIGTERM");
  setTimeout(() => signalGroup(pid, "SIGKILL"), TIMEOUT_KILL_GRACE_MS).unref();
  return stands;
}

// [LAW:one-type-per-behavior] One owner's launches. Each form is one lifetime
// (the header), and all of them cross the owner's gate and report to its stats.
export interface Launcher {
  launch(opts: AsyncLaunchOpts): Promise<LaunchResult>;
  // For callers that genuinely cannot be async: the spawn outcome must be
  // settled before the function returns.
  launchSync(opts: LaunchOpts): LaunchResult;
  launchDetachedSync(opts: LaunchOpts): LaunchResult;
  launchJobSync(opts: LaunchOpts, files: JobFiles): JobLaunch;
  lifelineWarnings(): LifelineWarning[];
}

export interface Settled {
  // Launches the OS refused to end, whose children still run.
  readonly unreaped: readonly LaunchCategory[];
}

// What `createLauncher` returns, and not what a launcher is handed around as, so
// nothing holding a `Launcher` can reach this.
export interface TestableLauncher extends Launcher {
  // Settles once every waited launch and lifeline has ended: for the owner
  // that holds the abort, since a lifeline ends only with it.
  settled(): Promise<Settled>;
  // Exposed for tests only: ends the lifeline's pipe — the EOF the launcher's
  // death gives it — and names its pid. A cut lifeline is lost at once, so the
  // test's next launch starts another rather than writing to a closed pipe.
  __lifelineForTest(): { pid: number | undefined; cut(): void };
}

// [LAW:no-ambient-temporal-coupling] An aborted scope ends what is in flight
// and refuses what comes after, for good, whichever other launchers run.
export function createLauncher(owner: Partial<LaunchScope>): TestableLauncher {
  const launcher: TestableLauncher = {
    launch: (opts) => track(state, launchWaited(state, opts)),
    launchSync: (opts) => launchBlocking(state, opts),
    launchDetachedSync: (opts) => launchOrphan(state, opts),
    launchJobSync: (opts, files) => launchJob(state, opts, files),
    lifelineWarnings: () => lifelineWarnings(state),
    settled: async () => {
      await Promise.all(state.ending);
      // The child's own end, not `close`: a descendant can hold the pipes past it.
      const running = [...state.unreaped].filter(
        ([child]) => child.exitCode === null && child.signalCode === null,
      );
      return { unreaped: running.map(([, category]) => category) };
    },
    __lifelineForTest: () => {
      const line = state.lifeline;
      return {
        pid: line?.process.pid,
        cut: () => {
          line?.pipe.end();
          if (line) lose(state, line.process, "cut by a test");
        },
      };
    },
  };
  const state: LaunchState = {
    scope: {
      stats: null,
      // A launcher with nobody to tell says the warning on stderr.
      observeLifeline: () =>
        launcher
          .lifelineWarnings()
          .forEach((w) => process.emitWarning(w.message)),
      signal: new AbortController().signal,
      ...owner,
    },
    lastStartAt: new Map(),
    inFlight: new Set(),
    liveGroups: new Set(),
    lifeline: null,
    fault: null,
    ending: new Set(),
    unreaped: new Map(),
  };
  state.scope.signal.addEventListener(
    "abort",
    () => {
      state.inFlight.forEach((end) => end());
      endLifeline(state);
    },
    { once: true },
  );
  return launcher;
}

// What a process with no daemon launches through: the CLI, bar-pane, and a
// daemon's shell before it has a daemon. Nothing closes it. Daemon work never
// reaches for this: it holds its daemon's, which is what the close refuses
// (eslint.config.mjs).
export const processLauncher: Launcher = createLauncher({});

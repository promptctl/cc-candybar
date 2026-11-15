// The launcher's vocabulary: its categories, what a launch is asked and
// answers, and the warnings it holds. The launcher itself is the host's
// (src/proc/launch.ts); the renderer's verbs launch through this port.

import type { Timekeeper } from "../time";
import type { Drawing } from "../config/lanes";
import type { HeldEvent } from "../utils/event-hold";
import type { Instant } from "../utils/instant";

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
  // A pane's session name (src/daemon/cache/tmux.ts): a pane's first read, then
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
  // not come back — the Launch Services lookup.
  "doctor.open",
  "doctor.launch-services",
  // Typing a slash command into a session's Claude Code pane
  // (src/claude-input/edge.ts): `read` captures the pane to decide whether it
  // is safe, `type` sends the keys.
  "claude-input.read",
  "claude-input.type",
  // Assembling the URL handler app (src/install/index.ts): sign it, quit the
  // instance a previous install left resident, register the scheme.
  "install.codesign",
  "install.killall",
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

export interface LaunchOpts {
  bin: string;
  args?: string[];
  cwd?: string;
  // Set over the launcher's inherited environment; null unsets.
  envOverlay?: Readonly<Record<string, string | null>>;
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
      // "output-limit" means a stream passed MAX_CAPTURED_BYTES: the child was
      // terminated and `stdout`/`stderr` hold the first MAX_CAPTURED_BYTES of
      // it, so a truncated capture is never an `ok` one. "pipe-error" means
      // a stream failed to read while the launch ran: the child was
      // terminated, for the same reason, and `error` carries the stream's.
      reason:
        | "timeout"
        | "aborted"
        | "signal"
        | "spawn-error"
        | "non-zero"
        | "rate-limited"
        | "signal-refused"
        | "output-limit"
        | "pipe-error";
      stdout: string;
      stderr: string;
      exitCode: number | null;
      signal: NodeJS.Signals | null;
      error?: string;
    };

export type Failed = Extract<LaunchResult, { ok: false }>;

// [LAW:single-enforcer] Why a launch failed, said one way for every caller.
export function whyFailed(r: Failed): string {
  switch (r.reason) {
    case "non-zero":
      return `exited with code ${r.exitCode}`;
    case "signal":
      return `killed by ${r.signal ?? "a signal"}`;
    // These are whole sentences: the launcher wrote them.
    case "timeout":
    case "output-limit":
    case "rate-limited":
    case "pipe-error":
    case "spawn-error":
      return r.error ?? r.reason;
    default:
      return r.error === undefined ? r.reason : `${r.reason}: ${r.error}`;
  }
}

// What a child said, on one bounded line. A tool's error may come first (git's
// `fatal:` before its hints, `ps`'s complaint before its usage) or last (a
// traceback, a prompt), so the first and last lines stand for the rest; each is
// clipped by code point. Bounded here because the failure is held and drawn
// whole: the bar's ⚠ cell is the only place it shows.
const SAID_LINE_CHARS = 200;

const clipped = (line: string): string => {
  const kept: string[] = [];
  for (const ch of line) {
    if (kept.length === SAID_LINE_CHARS) return `${kept.join("")}…`;
    kept.push(ch);
  }
  return line;
};

export function saidBy(r: Failed, text: string): string {
  // A flood's output is the flood, and a failed pipe's was cut short: those
  // say why alone.
  if (r.reason === "output-limit" || r.reason === "pipe-error") return "";
  const t = text.trim();
  const firstEnd = t.search(/[\r\n]/);
  if (firstEnd === -1) return clipped(t);
  const lastStart = Math.max(t.lastIndexOf("\n"), t.lastIndexOf("\r")) + 1;
  return `${clipped(t.slice(0, firstEnd).trim())} … ${clipped(t.slice(lastStart).trim())}`;
}

// [LAW:no-silent-failure] Why, and what the child said about it.
export function failureText(r: Failed, where = ""): string {
  const said = saidBy(r, r.stderr);
  return `${whyFailed(r)}${where}${said === "" ? "" : `: ${said}`}`;
}

// A launch that started nothing. It always says why, so a form with no
// `LaunchResult` to return still carries the reason rather than guessing one.
export type Refusal = Extract<LaunchResult, { ok: false }> & { error: string };

export interface LifelineWarning {
  readonly kind: "lifeline";
  readonly message: string;
}

export interface PipeEvent extends HeldEvent {
  // What its text counts: each kind and category since an answer last carried
  // one, so a second event before anyone saw the first adds to it.
  readonly counts: ReadonlyMap<string, number>;
}

export interface LaunchPipesWarning {
  readonly kind: "launch-pipes";
  readonly message: string;
  // The record the warning shows, which an answer carrying it marks answered.
  readonly event: PipeEvent;
  // Why this render shows it: inside the hold, or owed past it.
  readonly hold: "held" | "owed";
}

export type LauncherWarning = LifelineWarning | LaunchPipesWarning;

export type WarningChange =
  | { readonly kind: "lifeline"; readonly fault: string | null }
  | { readonly kind: "launch-pipes"; readonly text: string };

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
  // [LAW:one-source-of-truth] The refusal's own reason, as `launch` reports it.
  | {
      readonly ok: false;
      readonly reason: Refusal["reason"];
      readonly error: string;
    };

// What `endJob` did: whether the launcher's verdict is the one that stands, and
// whether the group took the SIGTERM. Only a group that took it gets the SIGKILL,
// since an id that answered nothing may no longer be the job's by the grace's end.
export interface JobEnding {
  readonly stands: boolean;
  readonly signalled: boolean;
}

// [LAW:one-type-per-behavior] One owner's launches. Each form is one lifetime
// (the header), and all of them cross the owner's gate and report to its stats.
export interface Launcher {
  // The machine's clock, which its children live on: a caller that waits on a
  // launched child's own progress waits by this one, never by a held daemon's.
  readonly clock: Timekeeper;
  launch(opts: AsyncLaunchOpts): Promise<LaunchResult>;
  launchDetachedSync(opts: LaunchOpts): LaunchResult;
  launchJobSync(opts: LaunchOpts, files: JobFiles): JobLaunch;
  // Whether anything of the job's process group the launcher can still signal is
  // running. The group outlives its leader while the program runs, so a sh killed
  // on its own does not read as an ended job.
  jobGroupAlive(pid: number): boolean;
  // Ends a job's group with the timeout's own escalation, and gives it a verdict
  // of the launcher's unless its own landed first (see `endJob`).
  endJob(pid: number, status: string, end: JobEnd): JobEnding;
  // What the launcher warns a render drawn at `at` for `render`.
  launcherWarnings(at: Instant, render: Drawing["by"]): LauncherWarning[];
  // An answer carrying `event` reached its client.
  answeredPipeEvent(event: PipeEvent): void;
}

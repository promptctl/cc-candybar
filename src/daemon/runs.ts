// [LAW:no-ambient-temporal-coupling] The one owner of every program a `run`
// act starts, for the whole daemon: constructed with it, closed with it, and
// closing aborts what is still running. A run outlives the click that started
// it — the click is answered at once — so the sources it made stale are this
// owner's to resume, and how it ended is its act's outcome.

import path from "node:path";
import {
  failureText,
  type LaunchResult,
  type Launcher,
} from "../proc/launcher.js";
import type { SessionId } from "./foundations/session-id.js";
import type { SessionEnvironment } from "./foundations/session-env.js";
import type { Resume } from "../utils/keyed-source.js";
import { elapsedMs, type Timekeeper } from "../time.js";
import { valueOf } from "../utils/logfmt.js";
import type { RunStats } from "./foundations/stats-snapshot";
import type { Act, EffectOutcome } from "../renderer-interface/interface.js";

export type RunAct = Extract<Act, { kind: "run" }>;

// How a run ended: its outcome, and its facts for its act's line.
export interface RunEnd {
  readonly outcome: EffectOutcome;
  readonly said: string;
}

// One timeout for every run: long enough for a program that reads a file and
// writes another, short enough that a hung one does not hold its sources
// pending for good.
export const RUN_TIMEOUT_MS = 10_000;

// How a run ended. `aborted`: the owner closed under it.
export type RunOutcome =
  | "ok"
  | "exit"
  | "timeout"
  | "launch"
  | "output-limit"
  | "pipe"
  | "aborted";

export interface RunsDeps {
  // [LAW:one-source-of-truth] The storage owner's one supersede.
  readonly supersede: (folder: string, sessionId: SessionId) => Resume;
  readonly launch: Launcher["launch"];
  // [LAW:one-source-of-truth] The environment a session's program starts
  // from: the session book's.
  readonly environmentOf: (session: SessionId) => SessionEnvironment;
  // [LAW:effects-at-boundaries] The daemon's clock, which times each run.
  readonly clock: Pick<Timekeeper, "monotonic">;
  readonly timeoutMs?: number;
}

// [LAW:dataflow-not-control-flow] A launch's result read as a run's outcome:
// the one table of which reason is which.
function outcomeOf(result: LaunchResult): RunOutcome {
  if (result.ok) return "ok";
  switch (result.reason) {
    case "non-zero":
    case "signal":
      return "exit";
    case "timeout":
      return "timeout";
    case "aborted":
      return "aborted";
    case "spawn-error":
    case "rate-limited":
    case "signal-refused":
      return "launch";
    case "output-limit":
      return "output-limit";
    // It ran: the launcher ended it because a pipe failed to read.
    case "pipe-error":
      return "pipe";
  }
}

// What the event's `exit=` says: the code, the signal that ended it, or `-`.
function exitOf(result: LaunchResult): string {
  if (!result.ok && result.signal !== null) return result.signal;
  return result.exitCode === null ? "-" : String(result.exitCode);
}

export class Runs {
  private readonly deps: RunsDeps;
  private readonly timeoutMs: number;
  private readonly inFlight = new Set<AbortController>();
  private started = 0;
  private failed = 0;
  private refused = 0;
  private timedOut = 0;
  private closed = false;

  constructor(deps: RunsDeps) {
    this.deps = deps;
    this.timeoutMs = deps.timeoutMs ?? RUN_TIMEOUT_MS;
  }

  // Start one run; resolves with how it ended. Every source it refreshes
  // reads pending from now until the program has exited, and then is read
  // fresh.
  start(run: RunAct): Promise<RunEnd> {
    if (this.closed) throw new Error("run owner used after close");
    // [LAW:no-silent-failure] A session whose environment the host does not
    // hold runs nothing: the host's own environment is never a session's.
    const environment = this.deps.environmentOf(run.session);
    if (environment.kind === "failed") {
      this.refused++;
      const reason = `not run: ${environment.reason}`;
      return Promise.resolve({
        outcome: { kind: "failed", reason },
        said: `program=${valueOf(run.program)} ended=refused — ${reason}`,
      });
    }
    // [LAW:no-ambient-temporal-coupling] Superseded before the program
    // starts, so no draw after the click shows the value from before it.
    const resumes = run.refreshes.map((r) =>
      this.deps.supersede(r.folder, run.session),
    );
    const abort = new AbortController();
    this.inFlight.add(abort);
    this.started++;
    const { program, args } = run;
    const startedAt = this.deps.clock.monotonic();
    return this.deps
      .launch({
        // [LAW:types-are-the-program] A relative program path is the
        // declaring file's, as the directory it runs in is; a bare name is
        // looked up on PATH.
        bin: program.includes("/") ? path.resolve(run.cwd, program) : program,
        args: [...args],
        // [LAW:single-enforcer] The program's own variables over its
        // session's environment, laid here for every click's run.
        environment: environment.value,
        envOverlay: run.env,
        cwd: run.cwd,
        timeoutMs: this.timeoutMs,
        signal: abort.signal,
        category: "click.run",
      })
      .then((result) =>
        this.ended(run, result, elapsedMs(this.deps.clock, startedAt)),
      )
      .finally(() => {
        this.inFlight.delete(abort);
        // [LAW:no-ambient-temporal-coupling] However the run ended, every
        // source it superseded resumes, so each starts one fresh read.
        for (const resume of resumes) resume();
      });
  }

  stats(): RunStats {
    return {
      started: this.started,
      failed: this.failed,
      timedOut: this.timedOut,
      refused: this.refused,
      running: this.inFlight.size,
    };
  }

  // Aborts every run in flight; each resumes its sources once its program is
  // gone.
  close(): void {
    this.closed = true;
    for (const abort of this.inFlight) abort.abort();
  }

  // [LAW:single-enforcer] How the run ended, said on its act's line
  // (src/daemon/acts.ts), the one line an act's outcome has.
  private ended(run: RunAct, result: LaunchResult, took: number): RunEnd {
    const ended = outcomeOf(result);
    const said = `program=${valueOf(run.program)} ended=${ended} exit=${exitOf(result)} took=${took} refreshed=${run.refreshes.map((r) => r.name).join(",") || "-"}`;
    if (ended === "timeout") this.timedOut++;
    if (result.ok) return { outcome: { kind: "ok" }, said };
    // An aborted run is the daemon going down, not the program failing.
    if (ended === "aborted")
      return {
        outcome: { kind: "closing", reason: "the daemon closed under it" },
        said,
      };
    if (ended !== "timeout") this.failed++;
    const reason = failureText(result);
    return { outcome: { kind: "failed", reason }, said: `${said} — ${reason}` };
  }
}

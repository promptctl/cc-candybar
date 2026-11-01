// [LAW:no-ambient-temporal-coupling] The one owner of every program a `run`
// click starts, for the whole daemon: constructed with it, closed with it, and
// closing aborts what is still running. A run outlives the click that started
// it — the click is answered at once — so what it leaves behind (the sources
// it made stale, a failure the bar must show) is this owner's to settle, never
// the click's.

import path from "node:path";
import type { LaunchResult, Launcher } from "../proc/launch.js";
import type { SessionId } from "./session-id.js";
import type { StorageKey } from "./cache/managed-storage.js";
import type { Resume } from "../utils/keyed-source.js";
import type { DaemonLogger } from "../utils/logger.js";
import type { SessionStateRW } from "./session-state.js";
import type { Instant } from "../utils/instant.js";
import { holdClickError } from "./click-error.js";
import { valueOf } from "../utils/logfmt.js";

// One timeout for every run: long enough for a program that reads a file and
// writes another, short enough that a hung one does not hold its sources
// pending for good.
export const RUN_TIMEOUT_MS = 10_000;

// A source a run makes stale: its full name, for the event, and its file's key
// in the storage owner.
export interface RunRefresh {
  readonly name: string;
  readonly storage: StorageKey;
}

// [LAW:types-are-the-program] One run, as the verb hands it over: everything
// was settled at the click — the program and its arguments as the draw
// evaluated them, the environment, the directory, the sources it refreshes —
// so the owner decides nothing about what runs.
export interface RunRequest {
  readonly sessionId: SessionId;
  readonly action: string;
  readonly argv: readonly [string, ...string[]];
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly refreshes: readonly RunRefresh[];
}

// How a run ended. `aborted`: the owner closed under it.
export type RunOutcome = "ok" | "exit" | "timeout" | "launch" | "aborted";

export interface RunStats {
  readonly started: number;
  // Ended with a non-zero exit, or could not be started.
  readonly failed: number;
  readonly timedOut: number;
  // Links refused before anything ran.
  readonly refused: number;
  // In flight now.
  readonly running: number;
}

export interface RunsDeps {
  // [LAW:one-source-of-truth] The storage owner's one supersede.
  readonly supersede: (storage: StorageKey, sessionId: SessionId) => Resume;
  readonly launch: Launcher["launch"];
  // The daemon's session state, where a failed run's error is held for the
  // session's bar — not a click's journal, which committed long before.
  readonly state: SessionStateRW;
  readonly log: DaemonLogger;
  readonly now: () => Instant;
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
  }
}

// What the event's `exit=` says: the code, the signal that ended it, or `-`.
function exitOf(result: LaunchResult): string {
  if (!result.ok && result.signal !== null) return result.signal;
  return result.exitCode === null ? "-" : String(result.exitCode);
}

// What the bar shows of a failed run: the program's own words, else why.
function failureText(
  action: string,
  outcome: RunOutcome,
  result: LaunchResult,
  timeoutMs: number,
): string {
  const stderr = result.stderr.trim();
  const reason =
    outcome === "timeout"
      ? `timed out after ${timeoutMs / 1000} s`
      : outcome === "exit"
        ? `exited ${exitOf(result)}`
        : (result.ok ? "" : result.error) || "could not be started";
  return `run ${action}: ${stderr === "" ? reason : stderr}`;
}

export class Runs {
  private readonly deps: RunsDeps;
  private readonly timeoutMs: number;
  private readonly inFlight = new Set<AbortController>();
  private started = 0;
  private failed = 0;
  private timedOut = 0;
  private refusals = 0;
  private closed = false;

  constructor(deps: RunsDeps) {
    this.deps = deps;
    this.timeoutMs = deps.timeoutMs ?? RUN_TIMEOUT_MS;
  }

  // Start one run and return at once. Every source it refreshes reads pending
  // from now until the program has exited, and then is read fresh.
  start(run: RunRequest): void {
    if (this.closed) throw new Error("run owner used after close");
    // [LAW:no-ambient-temporal-coupling] Superseded before the program
    // starts, so no draw after the click shows the value from before it.
    const resumes = run.refreshes.map((r) =>
      this.deps.supersede(r.storage, run.sessionId),
    );
    const abort = new AbortController();
    this.inFlight.add(abort);
    this.started++;
    const [program, ...args] = run.argv;
    const startedAt = Date.now();
    void this.deps
      .launch({
        // [LAW:types-are-the-program] A relative program path is the
        // declaring file's, as the directory it runs in is; a bare name is
        // looked up on PATH.
        bin: program.includes("/") ? path.resolve(run.cwd, program) : program,
        args,
        env: run.env,
        cwd: run.cwd,
        timeoutMs: this.timeoutMs,
        signal: abort.signal,
        category: "click.run",
      })
      .then((result) => this.ended(run, result, Date.now() - startedAt))
      .finally(() => {
        this.inFlight.delete(abort);
        // [LAW:no-ambient-temporal-coupling] However the run ended, every
        // source it superseded resumes, so each starts one fresh read.
        for (const resume of resumes) resume();
      });
  }

  // A link refused before anything ran: counted, and its one event.
  refused(sessionId: string, action: string, reason: string): void {
    this.refusals++;
    this.deps.log(
      "warn",
      `run refused sid=${valueOf(sessionId)} action=${valueOf(action)} reason=${valueOf(reason)}`,
    );
  }

  stats(): RunStats {
    return {
      started: this.started,
      failed: this.failed,
      timedOut: this.timedOut,
      refused: this.refusals,
      running: this.inFlight.size,
    };
  }

  // Aborts every run in flight; each resumes its sources once its program is
  // gone.
  close(): void {
    this.closed = true;
    for (const abort of this.inFlight) abort.abort();
  }

  private ended(run: RunRequest, result: LaunchResult, took: number): void {
    const outcome = outcomeOf(result);
    this.deps.log(
      outcome === "ok" || outcome === "aborted" ? "info" : "warn",
      `run sid=${valueOf(run.sessionId)} action=${valueOf(run.action)} program=${valueOf(run.argv[0])} outcome=${outcome} exit=${exitOf(result)} took=${took} refreshed=${run.refreshes.map((r) => r.name).join(",") || "-"}`,
    );
    if (outcome === "timeout") this.timedOut++;
    if (outcome === "exit" || outcome === "launch") this.failed++;
    // An aborted run is the daemon going down, not the program failing.
    if (outcome === "ok" || outcome === "aborted") return;
    holdClickError(
      this.deps.state,
      run.sessionId,
      failureText(run.action, outcome, result, this.timeoutMs),
      this.deps.now(),
    );
  }
}

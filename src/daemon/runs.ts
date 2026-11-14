// [LAW:no-ambient-temporal-coupling] The one owner of every program a `run`
// click starts, for the whole daemon: constructed with it, closed with it, and
// closing aborts what is still running. A run outlives the click that started
// it — the click is answered at once — so what it leaves behind (the sources
// it made stale, a failure the bar must show) is this owner's to settle, never
// the click's.

import path from "node:path";
import {
  failureText,
  type LaunchResult,
  type Launcher,
} from "../proc/launcher.js";
import type { SessionId } from "./foundations/session-id.js";
import type { StorageKey } from "../renderer-interface/interface.js";
import type { Resume } from "../utils/keyed-source.js";
import type { DaemonLogger } from "../utils/logger.js";
import type { Instant } from "../utils/instant.js";
import { elapsedMs, type Timekeeper } from "../time.js";
import { valueOf } from "../utils/logfmt.js";
import type { RunStats } from "./foundations/stats-snapshot";
import type { RunRequest } from "../renderer-interface/adapter";

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
  readonly supersede: (storage: StorageKey, sessionId: SessionId) => Resume;
  readonly launch: Launcher["launch"];
  // Holds a failed run's error in the session's state for its bar — not a
  // click's journal, which committed long before.
  readonly holdClickError: (
    sessionId: SessionId,
    text: string,
    at: Instant,
  ) => void;
  readonly log: DaemonLogger;
  readonly now: () => Instant;
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
    const startedAt = this.deps.clock.monotonic();
    void this.deps
      .launch({
        // [LAW:types-are-the-program] A relative program path is the
        // declaring file's, as the directory it runs in is; a bare name is
        // looked up on PATH.
        bin: program.includes("/") ? path.resolve(run.cwd, program) : program,
        args,
        envOverlay: run.envOverlay,
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

  // A link refused before anything ran: counted, and its one event.
  // The link's id as it arrived: a link refused at the checkpoint never
  // parsed, so it is not a SessionId.
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
    // An aborted run is the daemon going down, not the program failing.
    if (result.ok || outcome === "aborted") return;
    if (outcome !== "timeout") this.failed++;
    this.deps.holdClickError(
      run.sessionId,
      `run ${run.action}: ${failureText(result)}`,
      this.deps.now(),
    );
  }
}

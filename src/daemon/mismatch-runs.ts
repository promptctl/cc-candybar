// Each session's run of mismatched pane stamps: a request whose Claude Code's
// record holds another session, which on either side of a `/clear` or
// `/resume` rewriting the record is the rewrite race, and past it a session
// whose pane's status line and bar pane never follow it.
//
// [LAW:no-ambient-temporal-coupling] Held in memory by this daemon, as its
// render sightings are: a restart forgets every run, so a lasting mismatch
// measures one race again before it shows, and no run outlives the daemon
// that saw the ticks that would have ended it.

import type { Instant } from "../utils/instant.js";
import { dateOf } from "../utils/instant.js";
import type { ClaudeProcess, SessionPane } from "./session-pane.js";
import type { TurnHolder } from "./session-state.js";

// Seconds a mismatched stamp can be the rewrite race: a cleared session's
// straggling tick has been seen to follow its record's rewrite by about one.
export const MISMATCH_RACE_S = 10;

// The newest runs kept: a run whose Claude Code exits without a confirmed
// tick is never ended, so the oldest runs are evicted past this many.
export const MISMATCH_RUNS_KEPT = 64;

// [LAW:types-are-the-program] A session's run: the Claude Code whose ticks
// opened it, when, and whether one has arrived past the race since.
export interface MismatchRun {
  readonly claude: ClaudeProcess;
  readonly since: Instant;
  readonly lasted: boolean;
}

const sameProcess = (a: ClaudeProcess, b: ClaudeProcess): boolean =>
  a.pid === b.pid && a.configDir === b.configDir;

export class MismatchRuns {
  private readonly runs = new Map<string, MismatchRun>();

  // [LAW:single-enforcer] Written by the request arm in its turn, so the
  // holder refuses a write no event explains, as session state does.
  constructor(private readonly turns: TurnHolder) {}

  // [LAW:dataflow-not-control-flow] The run `sessionId` holds once a request
  // stamped `pane` arrives at `at`. A confirmed tick from a Claude Code is the
  // evidence its record is being rewritten, so it ends every run that
  // process's ticks opened: a cleared session's straggler says nothing more
  // of itself, and the new session's confirmed ticks end its run. A tick no
  // readable Claude Code ran is no evidence about any record.
  record(
    sessionId: string,
    pane: SessionPane,
    at: Instant,
  ): MismatchRun | null {
    if (this.turns.inTurn() === null)
      throw new Error(
        `mismatch runs: a write of ${JSON.stringify(sessionId)} outside any turn`,
      );
    switch (pane.kind) {
      case "runs":
        for (const [held, run] of this.runs)
          if (sameProcess(run.claude, pane.claude)) this.runs.delete(held);
        return null;
      case "unconfirmed":
        return this.of(sessionId);
      case "mismatched": {
        const was = this.runs.get(sessionId);
        const since =
          was !== undefined && sameProcess(was.claude, pane.claude)
            ? was.since
            : at;
        const run = {
          claude: pane.claude,
          since,
          lasted: at - since > MISMATCH_RACE_S,
        };
        // Move-to-end: the newest run is the last dropped.
        this.runs.delete(sessionId);
        this.runs.set(sessionId, run);
        for (const held of this.runs.keys()) {
          if (this.runs.size <= MISMATCH_RUNS_KEPT) break;
          this.runs.delete(held);
        }
        return run;
      }
    }
  }

  of(sessionId: string): MismatchRun | null {
    return this.runs.get(sessionId) ?? null;
  }

  // Whether the session's mismatch has outlasted the race, as its last
  // request left it: what a draw shows, never measured on the draw's clock.
  lasted(sessionId: string): boolean {
    return this.runs.get(sessionId)?.lasted ?? false;
  }
}

// [LAW:nothing-unseen] The run as the render event's `mismatch` field.
export const mismatchFact = (run: MismatchRun | null): string =>
  run === null
    ? "-"
    : `${run.lasted ? "lasted " : ""}since ${dateOf(run.since).toISOString()}`;

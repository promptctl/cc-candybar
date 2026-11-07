// Each session's run of mismatched pane stamps: a request whose Claude Code's
// record holds another session, which on either side of a `/clear` or
// `/resume` rewriting the record is the rewrite race, and past it a session
// whose pane's status line and bar pane never follow it.
//
// [LAW:no-ambient-temporal-coupling] Held in memory by this daemon, as its
// render sightings are, and measured on its monotonic clock: a restart
// forgets every run, so a lasting mismatch measures one race again before it
// shows, and no run outlives the daemon that saw the ticks that would have
// ended it.

import { spanMs, type Monotonic } from "../time.js";
import type { ClaudeProcess, SessionPane } from "./session-pane.js";
import type { TurnHolder } from "./session-state.js";

// Seconds a mismatched stamp can be the rewrite race: a cleared session's
// straggling tick has been seen to follow its record's rewrite by about one.
export const MISMATCH_RACE_S = 10;

// The newest Claude Codes kept, and the newest runs each keeps: a Claude Code
// that exits is never heard from again, so the longest silent is evicted
// past this many.
export const MISMATCH_RUNS_KEPT = 64;

// [LAW:types-are-the-program] A session's run, in the Claude Code whose ticks
// opened it: when, and whether one has arrived past the race since.
export interface MismatchRun {
  readonly since: Monotonic;
  readonly lasted: boolean;
}

// What one Claude Code's ticks have shown: the session they last confirmed,
// from its first such tick, when its record was seen to hold it; and the run
// of each session its mismatched ticks are in.
interface ProcessTicks {
  readonly confirmed: {
    readonly sessionId: string;
    readonly since: Monotonic;
  } | null;
  readonly runs: Map<string, MismatchRun>;
}

const processKey = (claude: ClaudeProcess): string =>
  `${claude.pid}@${claude.configDir ?? ""}`;

const raceOver = (since: Monotonic, at: Monotonic): boolean =>
  spanMs(since, at) > MISMATCH_RACE_S * 1000;

// Move-to-end, so the newest entry is the last dropped.
function keepNewest<V>(map: Map<string, V>, key: string, value: V): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > MISMATCH_RUNS_KEPT) map.delete(map.keys().next().value!);
}

export class MismatchRuns {
  // [LAW:one-source-of-truth] Keyed by the Claude Code, since its ticks open
  // and end its runs: one process's ticks never touch another's.
  private readonly processes = new Map<string, ProcessTicks>();

  // [LAW:single-enforcer] Written by the request arm in its turn, so the
  // holder refuses a write no event explains, as session state does.
  constructor(private readonly turns: TurnHolder) {}

  // [LAW:dataflow-not-control-flow] The run `sessionId` is in once a request
  // stamped `pane` arrives at `at`. A confirmed tick from a Claude Code is the
  // evidence its record is being rewritten: it ends every run that process's
  // ticks opened, and its first tick of a session dates the rewrite. So a
  // mismatched tick holding that session within the race of it is the race,
  // whichever side of the new session's first tick the straggler lands, and
  // opens no run. A tick no readable Claude Code ran is no evidence about any
  // record.
  record(
    sessionId: string,
    pane: SessionPane,
    at: Monotonic,
  ): MismatchRun | null {
    if (this.turns.inTurn() === null)
      throw new Error(
        `mismatch runs: a write of ${JSON.stringify(sessionId)} outside any turn`,
      );
    switch (pane.kind) {
      case "runs": {
        const was = this.processes.get(processKey(pane.claude))?.confirmed;
        keepNewest(this.processes, processKey(pane.claude), {
          confirmed:
            was?.sessionId === sessionId ? was : { sessionId, since: at },
          runs: new Map(),
        });
        return null;
      }
      case "unconfirmed":
        return null;
      case "mismatched": {
        const key = processKey(pane.claude);
        const ticks = this.processes.get(key) ?? {
          confirmed: null,
          runs: new Map<string, MismatchRun>(),
        };
        keepNewest(this.processes, key, ticks);
        const rewrite = ticks.confirmed;
        if (rewrite?.sessionId === pane.held && !raceOver(rewrite.since, at))
          return ticks.runs.get(sessionId) ?? null;
        const since = ticks.runs.get(sessionId)?.since ?? at;
        const run = { since, lasted: raceOver(since, at) };
        keepNewest(ticks.runs, sessionId, run);
        return run;
      }
    }
  }

  // The run of `sessionId` that `claude`'s ticks are in.
  of(sessionId: string, claude: ClaudeProcess): MismatchRun | null {
    return this.processes.get(processKey(claude))?.runs.get(sessionId) ?? null;
  }

  // Whether the session's mismatch has outlasted the race, as the requests
  // `claude` ran left it: what a draw shows, never measured on the draw's
  // clock.
  lasted(sessionId: string, claude: ClaudeProcess): boolean {
    return this.of(sessionId, claude)?.lasted ?? false;
  }
}

// [LAW:nothing-unseen] The run as the render event's `mismatch` field: how
// long it has run at the request's arrival, and whether that is past the race.
export const mismatchFact = (run: MismatchRun | null, at: Monotonic): string =>
  run === null
    ? "-"
    : `${run.lasted ? "lasted " : ""}${spanMs(run.since, at)}ms`;

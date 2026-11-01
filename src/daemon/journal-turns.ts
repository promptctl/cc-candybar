// [LAW:no-ambient-temporal-coupling][LAW:single-enforcer] The one owner of when
// a journal is open. A handler that awaits gives up the loop between its
// journal's begin and commit, so run-to-completion no longer keeps two journals
// apart: each takes a turn here, daemon-wide and not per session, because a
// session's history is its own but the config files it writes are shared. The
// turn is taken only around a journal (`journaled`, src/daemon/verbs/index.ts),
// which never nests, so a turn never waits on itself.
//
// `close` ends the turns for good: what is queued is refused as its turn
// arrives, and what is in flight is committed there and then, so writes already
// landed stay undoable as one step when the daemon's launches abort under them.

import { KeyedSerialQueue } from "../utils/keyed-serial-queue.js";

interface InFlight {
  readonly verb: string;
  readonly commit: () => void;
  committed: boolean;
}

export interface JournalTurn {
  // Names the commit `close` runs if the turn is cut off, and answers the one
  // way to run it: true when this call committed, false when `close` already
  // had and the turn is over.
  readonly holds: (commit: () => void) => () => boolean;
}

const DAEMON_WIDE = "journals";

export class JournalTurns {
  private readonly queue = new KeyedSerialQueue<typeof DAEMON_WIDE>();
  private open = true;
  private inFlight: InFlight | null = null;

  constructor(
    private readonly deps: {
      readonly log: (level: "warn", msg: string) => void;
      // On a clock whose differences are milliseconds.
      readonly monotonic: () => number;
    },
  ) {}

  // Runs `body` in its turn; `waited` hears how many ms the turn took to come.
  take<T>(
    verb: string,
    waited: (ms: number) => void,
    body: (turn: JournalTurn) => Promise<T>,
  ): Promise<T> {
    const asked = this.deps.monotonic();
    return this.queue.run(DAEMON_WIDE, async () => {
      if (!this.open) throw new Error(`the daemon closed: ${verb} refused`);
      waited(Math.round(this.deps.monotonic() - asked));
      try {
        return await body({
          holds: (commit) => {
            const held = { verb, commit, committed: false };
            this.inFlight = held;
            return () => this.commit(held);
          },
        });
      } finally {
        this.inFlight = null;
      }
    });
  }

  close(): void {
    this.open = false;
    if (this.inFlight === null) return;
    // [LAW:nothing-unseen] Said first, so a commit that throws still names it.
    this.deps.log(
      "warn",
      `journal: ${this.inFlight.verb} cut off by close, committing what landed`,
    );
    this.commit(this.inFlight);
  }

  private commit(held: InFlight): boolean {
    if (held.committed) return false;
    held.committed = true;
    held.commit();
    return true;
  }
}

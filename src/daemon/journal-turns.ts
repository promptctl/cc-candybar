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
// landed stay undoable as one step when the daemon's launches abort under them,
// and goes no further than its next `landed`. A click's launches are bounded
// (`clickLaunch`), so a turn always comes back.

import { KeyedSerialQueue } from "../utils/keyed-serial-queue.js";
import { ClickAbandoned, DaemonClosing } from "./verb-error.js";

interface InFlight {
  readonly verb: string;
  readonly commit: () => void;
}

export interface JournalTurn {
  // Names the commit `close` runs if the turn is cut off, and answers the one
  // way to run it: true when this call committed, false when `close` already
  // had and the turn is over.
  readonly holds: (commit: () => void) => () => boolean;
  // [LAW:single-enforcer] Where a handler resumes: what follows an await runs
  // only if the turn outlived it, so a click `close` cut off writes nothing
  // more, whichever store it would have reached. `p` settling either way
  // counts: a launch the close aborted rejects.
  readonly landed: <T>(p: Promise<T>) => Promise<T>;
}

export interface JournalTurnStats {
  // The verb holding the turn and for how long; `queued` wait behind it.
  readonly holder: string | null;
  readonly heldMs: number;
  readonly queued: number;
}

// How a click asks for its turn: `waited` hears how many ms it took to come,
// and `gone` says whether whoever asked has left.
export interface TurnAsker {
  readonly waited: (ms: number) => void;
  readonly gone: () => boolean;
}

const DAEMON_WIDE = "journals";

export class JournalTurns {
  private readonly queue = new KeyedSerialQueue<typeof DAEMON_WIDE>();
  private open = true;
  private inFlight: InFlight | null = null;
  private holder: { readonly verb: string; readonly since: number } | null =
    null;
  private queued = 0;

  constructor(
    private readonly deps: {
      readonly log: (level: "warn", msg: string) => void;
      // On a clock whose differences are milliseconds.
      readonly monotonic: () => number;
    },
  ) {}

  // Runs `body` in its turn, unless the daemon closed or the asker left while
  // it waited: a click whose client took a TIMEOUT never lands, so clicking
  // again cannot revert a toggle.
  take<T>(
    verb: string,
    { waited, gone }: TurnAsker,
    body: (turn: JournalTurn) => Promise<T>,
  ): Promise<T> {
    const asked = this.deps.monotonic();
    this.queued++;
    return this.queue.run(DAEMON_WIDE, async () => {
      this.queued--;
      this.refuseClosed(verb);
      if (gone()) throw new ClickAbandoned(verb);
      const since = this.deps.monotonic();
      waited(Math.round(since - asked));
      this.holder = { verb, since };
      try {
        return await body({
          holds: (commit) => {
            const held = { verb, commit };
            this.inFlight = held;
            return () => this.commit(held);
          },
          landed: (p) => p.finally(() => this.refuseClosed(verb)),
        });
      } finally {
        this.holder = null;
      }
    });
  }

  getStats(): JournalTurnStats {
    const { holder, queued } = this;
    return {
      holder: holder?.verb ?? null,
      heldMs:
        holder === null ? 0 : Math.round(this.deps.monotonic() - holder.since),
      queued,
    };
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

  private refuseClosed(verb: string): void {
    if (!this.open) throw new DaemonClosing(verb);
  }

  private commit(held: InFlight): boolean {
    if (this.inFlight !== held) return false;
    this.inFlight = null;
    held.commit();
    return true;
  }
}

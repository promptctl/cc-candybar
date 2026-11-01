// [LAW:no-ambient-temporal-coupling][LAW:single-enforcer] The one owner of when
// a journal is open. A handler that awaits gives up the loop between its
// journal's begin and commit, so run-to-completion no longer keeps two journals
// apart: each takes a turn here, daemon-wide and not per session, because a
// session's history is its own but the config files it writes are shared. The
// turn is taken only around a journal (`journaled`, src/daemon/verbs/index.ts),
// which never nests, so a turn never waits on itself.
//
// A click's read-only launches come before its turn (`click`), so a slow doctor
// gather holds up no other session. What keeps one session's clicks in arrival
// order is then the queue a click joins on arrival and keeps its place in
// through gather and turn. A click holds that place while it asks for the
// turn, and no turn ever asks for a place, so the two cannot deadlock.
//
// `close` ends the turns for good: what is queued is refused as its turn
// arrives, and what is in flight is committed there and then, so writes already
// landed stay undoable as one step when the daemon's launches abort under them,
// and goes no further than its next `landed`. A click's launches are bounded
// (`clickLaunch`), so a turn comes back unless a child outlives SIGKILL, in
// uninterruptible sleep: its launch never settles, and `getStats` shows the
// holder's `heldMs` growing.

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

// The same, for a click that may gather first: `gathered` hears how long it took.
export interface ClickAsker extends TurnAsker {
  readonly gathered: (ms: number) => void;
}

const DAEMON_WIDE = "journals";

export class JournalTurns {
  private readonly queue = new KeyedSerialQueue<typeof DAEMON_WIDE>();
  private readonly sessions = new KeyedSerialQueue<string>();
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

  // A click from arrival to landing: in `session`'s order (a click naming none
  // goes straight on), `gather` outside any turn, `body` in one.
  // [LAW:single-enforcer] `gone` is read for a click's waits and never for its
  // own gather: a client that left at the head of its queue, or after the
  // gather while the turn was awaited, refuses the click; one that left during
  // the gather does not, since a gather outlasts a client's budget through no
  // fault of a re-click. With no gather `left` is false, as it was just read.
  click<G, T>(
    verb: string,
    session: string | null,
    { waited, gone, gathered }: ClickAsker,
    gather: () => Promise<G>,
    body: (gathering: G, turn: JournalTurn) => Promise<T>,
  ): Promise<T> {
    const inPlace = async (): Promise<T> => {
      this.refuseClosed(verb);
      if (gone()) throw new ClickAbandoned(verb);
      const started = this.deps.monotonic();
      const gathering = await gather();
      gathered(Math.round(this.deps.monotonic() - started));
      const left = gone();
      return this.take(verb, { waited, gone: () => !left && gone() }, (turn) =>
        body(gathering, turn),
      );
    };
    return session === null ? inPlace() : this.sessions.run(session, inPlace);
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

// [LAW:no-ambient-temporal-coupling][LAW:single-enforcer] The one owner of when
// a journal is open. A handler that awaits gives up the loop between its
// journal's begin and commit, so run-to-completion no longer keeps two journals
// apart: each takes a turn here, daemon-wide and not per session, because a
// session's history is its own but the config files it writes are shared. The
// turn is taken only around a journal (`click` and `closeIdleMenus`,
// src/renderer/verbs/index.ts), which never nests, so a turn never waits on itself.
//
// A click's read-only launches come before its turn (`click`), so a slow doctor
// gather holds up no other session. What keeps one session's clicks in arrival
// order is then the queue a click joins on arrival and keeps its place in
// through gather and turn. A click holds that place while it asks for the
// turn, and no turn ever asks for a place, so the two cannot deadlock.
//
// `close` ends the turns for good: what is queued is refused as its turn
// arrives, and what is in flight goes no further than its next `landed` and
// lands nothing (src/renderer/config-writes.ts). A click's launches are bounded
// (`clickLaunch`), so a turn comes back unless a child outlives SIGKILL, in
// uninterruptible sleep: its launch never settles, and `getStats` shows the
// holder's `heldMs` growing.

import { elapsedMs, spanMs, type Monotonic } from "../time.js";
import { KeyedSerialQueue } from "../utils/keyed-serial-queue.js";
import {
  ClickAbandoned,
  DaemonClosing,
} from "../daemon/foundations/verb-error.js";
import type { JournalTurnStats } from "../daemon/foundations/stats-snapshot";

export interface JournalTurn {
  // [LAW:single-enforcer] Where a handler resumes: what follows an await runs
  // only if the turn outlived it, so a click `close` cut off writes nothing
  // more, whichever store it would have reached. `p` settling either way
  // counts: a launch the close aborted rejects.
  readonly landed: <T>(p: Promise<T>) => Promise<T>;
}

// How a click asks for its turn: `waited` hears how many ms it took to come,
// and `gone` answers whether whoever asked has left.
export interface TurnAsker {
  readonly waited: (ms: number) => void;
  readonly gone: () => Promise<boolean>;
}

// The same, for a click that may gather first: `placed` hears how long it
// waited behind its session's earlier clicks, `gathered` how long it took.
export interface ClickAsker extends TurnAsker {
  readonly placed: (ms: number) => void;
  readonly gathered: (ms: number) => void;
}

const DAEMON_WIDE = "journals";
const GATHERS = "gathers";

export class JournalTurns {
  private readonly queue = new KeyedSerialQueue<typeof DAEMON_WIDE>();
  private readonly sessions = new KeyedSerialQueue<string>();
  private readonly gathers = new KeyedSerialQueue<typeof GATHERS>();
  private open = true;
  private holder: { readonly verb: string; readonly since: Monotonic } | null =
    null;
  private queued = 0;
  private gathersInFlight = 0;

  constructor(
    private readonly deps: {
      // On a clock whose differences are milliseconds.
      readonly monotonic: () => Monotonic;
      // Resolves once no click's config changes are on their way
      // (src/renderer/config-writes.ts).
      readonly changesLanded: () => Promise<void>;
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
      // [LAW:no-ambient-temporal-coupling] A turn reads the files the turns
      // ahead of it wrote, and the session state their consequences left, so
      // it opens once their changes have landed.
      await this.deps.changesLanded();
      this.queued--;
      const since = this.deps.monotonic();
      waited(spanMs(asked, since));
      // [LAW:nothing-unseen] Held from the head of the queue: asking whether
      // the client left is the turn's too, and its answer may be slow.
      this.holder = { verb, since };
      try {
        this.refuseClosed(verb);
        if (await gone()) throw new ClickAbandoned(verb);
        // [LAW:no-ambient-temporal-coupling] The close may land while the
        // answer is out.
        this.refuseClosed(verb);
        return await body({
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
    { placed, waited, gone, gathered }: ClickAsker,
    gather: () => Promise<G>,
    body: (gathering: G, turn: JournalTurn) => Promise<T>,
  ): Promise<T> {
    const arrived = this.deps.monotonic();
    const inPlace = async (): Promise<T> => {
      placed(elapsedMs(this.deps, arrived));
      this.refuseClosed(verb);
      if (await gone()) throw new ClickAbandoned(verb);
      this.refuseClosed(verb);
      const started = this.deps.monotonic();
      const gathering = await gather();
      gathered(elapsedMs(this.deps, started));
      const left = await gone();
      return this.take(
        verb,
        { waited, gone: async () => !left && (await gone()) },
        (turn) => body(gathering, turn),
      );
    };
    return session === null ? inPlace() : this.sessions.run(session, inPlace);
  }

  // A click's gather, one at a time daemon-wide and in no turn, as the turn once
  // kept them: its probes share rate windows across sessions, so a slow gather
  // refuses none behind it. Two within a window still meet the limiter's
  // refusal, the doctor's 'click again'.
  async gathering<G>(gather: () => Promise<G>): Promise<G> {
    this.gathersInFlight++;
    try {
      return await this.gathers.run(GATHERS, gather);
    } finally {
      this.gathersInFlight--;
    }
  }

  getStats(): JournalTurnStats {
    const { holder, queued } = this;
    return {
      holder: holder?.verb ?? null,
      heldMs: holder === null ? 0 : elapsedMs(this.deps, holder.since),
      queued,
      gathers: this.gathersInFlight,
    };
  }

  close(): void {
    this.open = false;
  }

  private refuseClosed(verb: string): void {
    if (!this.open) throw new DaemonClosing(verb);
  }
}

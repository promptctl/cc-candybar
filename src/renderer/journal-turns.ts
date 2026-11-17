// [LAW:no-ambient-temporal-coupling][LAW:single-enforcer] The one owner of when
// a journal is open. A handler that awaits gives up the loop between its
// journal's begin and commit, so run-to-completion no longer keeps two journals
// apart: each takes a turn here, daemon-wide and not per session, because a
// session's history is its own but the config files it writes are shared. The
// turn is taken only around a journal (`click` and `closeIdleMenus`,
// src/renderer/verbs/index.ts), which never nests, so a turn never waits on itself.
//
// What keeps one session's clicks in arrival order is the queue a click joins
// on arrival and keeps its place in until its turn ends (`click`). A click
// holds that place while it asks for the turn, and no turn ever asks for a
// place, so the two cannot deadlock.
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

// The same, for a click: `placed` hears how long it waited behind its
// session's earlier clicks.
export interface ClickAsker extends TurnAsker {
  readonly placed: (ms: number) => void;
}

const DAEMON_WIDE = "journals";

export class JournalTurns {
  private readonly queue = new KeyedSerialQueue<typeof DAEMON_WIDE>();
  private readonly sessions = new KeyedSerialQueue<string>();
  private open = true;
  private holder: { readonly verb: string; readonly since: Monotonic } | null =
    null;
  private queued = 0;

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
  // goes straight on), `body` in its turn.
  click<T>(
    verb: string,
    session: string | null,
    { placed, waited, gone }: ClickAsker,
    body: (turn: JournalTurn) => Promise<T>,
  ): Promise<T> {
    const arrived = this.deps.monotonic();
    const inPlace = (): Promise<T> => {
      placed(elapsedMs(this.deps, arrived));
      return this.take(verb, { waited, gone }, body);
    };
    return session === null ? inPlace() : this.sessions.run(session, inPlace);
  }

  getStats(): JournalTurnStats {
    const { holder, queued } = this;
    return {
      holder: holder?.verb ?? null,
      heldMs: holder === null ? 0 : elapsedMs(this.deps, holder.since),
      queued,
    };
  }

  close(): void {
    this.open = false;
  }

  private refuseClosed(verb: string): void {
    if (!this.open) throw new DaemonClosing(verb);
  }
}
